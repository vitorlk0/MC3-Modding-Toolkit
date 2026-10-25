import * as THREE from "three";
import { getTauriVersion, getVersion } from "@tauri-apps/api/app";
import { homeDir } from "@tauri-apps/api/path";
import { hex, type LodMeshEntry, type PckDocument } from "../src/pck";
import { anchorWorldPosition, defaultHiddenReason, hasStockVariants, isShellFamily, matchLodEntries, type MeshGeometry, type MeshPckDocument } from "../src/mesh";
import { getLanguage } from "./i18n";
import { roleLabels, roles, type VehicleRole, type VehicleSlots } from "./vehicle-types";

/**
 * Help ▸ Save diagnostic report: a plain-text snapshot of what the app read, decided and drew, for a
 * user to send when the preview shows something it shouldn't (a car without its shell, say) and the
 * same files open fine elsewhere. Two reports, one from each computer, are then compared by
 * Help ▸ Compare diagnostic reports: whatever differs is where to look.
 *
 * The report is `## Section` headings over `Key: value` rows, one per line, so it reads as text and
 * compares row by row. It holds file names, sizes and hashes, never file contents, and the user's
 * home folder is masked as `~`.
 *
 * Collected here from three places: console warnings and errors since the app started (the
 * page logs its swallowed parse failures there), the WebGL renderers the 3D views register, and
 * the state the page and the Meshes tab hand over through registerDiagnosticSource.
 */

export const REPORT_HEADER = "MC3 Modding Toolkit · diagnostic report";
const REPORT_FORMAT = "1";
const LOG_LIMIT = 300;
const startedAt = Date.now();

export type DiagnosticSection = { title: string; rows: [string, string][] };

// --- Console capture -------------------------------------------------------------------------

type LogEntry = { at: number; level: "warn" | "error"; text: string };
const log: LogEntry[] = [];
let captureInstalled = false;

function describeValue(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}${value.stack ? ` | ${value.stack.split("\n").slice(1, 4).map((line) => line.trim()).join(" | ")}` : ""}`;
  if (typeof value === "string") return value;
  try { return JSON.stringify(value) ?? String(value); } catch { return String(value); }
}
function pushLog(level: LogEntry["level"], values: unknown[]) {
  log.push({ at: Date.now(), level, text: values.map(describeValue).join(" ").slice(0, 2000) });
  if (log.length > LOG_LIMIT) log.splice(0, log.length - LOG_LIMIT);
}

/** Keeps the console's warnings and errors (and uncaught ones) from startup on, for the report. */
export function installDiagnosticCapture() {
  if (captureInstalled) return;
  captureInstalled = true;
  for (const level of ["warn", "error"] as const) {
    const original = console[level].bind(console);
    console[level] = (...values: unknown[]) => { pushLog(level, values); original(...values); };
  }
  window.addEventListener("error", (event) => pushLog("error", [`Uncaught: ${event.message}${event.filename ? ` (${event.filename}:${event.lineno})` : ""}`]));
  window.addEventListener("unhandledrejection", (event) => pushLog("error", ["Unhandled rejection:", event.reason]));
}

// --- What the 3D views and the page hand over -------------------------------------------------

type ViewerEntry = { label: string; renderer: THREE.WebGLRenderer; camera(): THREE.Camera; models: THREE.Object3D; contextLost: number; contextRestored: number };
const viewers = new Set<ViewerEntry>();

/** Called by each 3D view when it creates its renderer; returns the unregister for its cleanup.
 *  The objects under `models` are listed with `userData.source` as their piece name. */
export function registerDiagnosticViewer(label: string, renderer: THREE.WebGLRenderer, camera: () => THREE.Camera, models: THREE.Object3D) {
  const entry: ViewerEntry = { label, renderer, camera, models, contextLost: 0, contextRestored: 0 };
  const lost = () => { entry.contextLost += 1; pushLog("warn", [`${label}: WebGL context lost`]); };
  const restored = () => { entry.contextRestored += 1; pushLog("warn", [`${label}: WebGL context restored`]); };
  renderer.domElement.addEventListener("webglcontextlost", lost);
  renderer.domElement.addEventListener("webglcontextrestored", restored);
  viewers.add(entry);
  return () => {
    renderer.domElement.removeEventListener("webglcontextlost", lost);
    renderer.domElement.removeEventListener("webglcontextrestored", restored);
    viewers.delete(entry);
  };
}

export type VehicleSetSnapshot = {
  slots: VehicleSlots;
  workingRole: VehicleRole | null;
  meshRole: VehicleRole | null;
  vehicleBase: string;
  workspace: string;
  meshDocs: Map<string, MeshPckDocument>;
  /** Pieces read out of each loaded PCK because no loose file of theirs is open. */
  embeddedByRole: Partial<Record<VehicleRole, { pieces: MeshGeometry[]; unreadable: string[]; empty: string[] }>>;
  /** Anchors whose pieces the Anchors tab shows. */
  anchorVisible: Set<number>;
};
type Sources = {
  vehicleSet: VehicleSetSnapshot;
  meshEditor: { role: VehicleRole | null; visibleNames: Set<string> };
};
const sources = new Map<keyof Sources, () => unknown>();

export function registerDiagnosticSource<K extends keyof Sources>(key: K, getter: () => Sources[K]) {
  sources.set(key, getter);
  return () => { if (sources.get(key) === getter) sources.delete(key); };
}
function readSource<K extends keyof Sources>(key: K): Sources[K] | null {
  try { return (sources.get(key)?.() as Sources[K] | undefined) ?? null; } catch (error) { pushLog("error", [`Diagnostic source ${key} failed:`, error]); return null; }
}

export type VehicleLoadTrace = {
  at: number;
  how: "files" | "folder" | "drop";
  given: string[];
  preferred: string | null;
  base: string;
  files: Partial<Record<VehicleRole, string>>;
  workingRole: VehicleRole | null;
  meshFailures: { name: string; error: string }[];
  error: string | null;
};
let lastLoad: VehicleLoadTrace | null = null;
/** The page records each attempt to open a vehicle set, including the ones that fail. */
export function recordVehicleLoad(trace: VehicleLoadTrace) { lastLoad = trace; }

// --- Report ----------------------------------------------------------------------------------

const round = (value: number, digits = 4) => Number.isFinite(value) ? String(Math.round(value * 10 ** digits) / 10 ** digits) : String(value);
const vec = (values: ArrayLike<number>) => `(${Array.from(values, (value) => round(value)).join(", ")})`;
const seconds = (at: number) => `+${((at - startedAt) / 1000).toFixed(1)}s`;
const LOD_LABELS: Record<LodMeshEntry["lod"], string> = { hlod: "HLOD", mlod: "MLOD", llod: "LLOD" };
const LOD_FAMILIES: Record<number, string> = { 0x007a9420: "standard", 0x007aa728: "DUB/Remix", 0x007a9620: "SL500/SL55" };
const MESH_MAGICS: Record<number, string> = { 0x007a0f98: "standard", 0x007a22a0: "DUB/Remix", 0x007a1198: "SL500/SL55" };

async function sha256(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].slice(0, 12).map((value) => value.toString(16).padStart(2, "0")).join("");
}

function environmentSection(version: string, tauri: string): DiagnosticSection {
  const nav = navigator as Navigator & { deviceMemory?: number };
  return { title: "Environment", rows: [
    ["App version", version],
    ["Tauri", tauri],
    ["User agent", navigator.userAgent],
    ["Platform", navigator.platform],
    ["System languages", (navigator.languages ?? [navigator.language]).join(", ")],
    ["Interface language", getLanguage()],
    ["Screen", `${screen.width}x${screen.height}`],
    ["Window", `${window.innerWidth}x${window.innerHeight}`],
    ["Device pixel ratio", String(window.devicePixelRatio)],
    ["CPU threads", String(navigator.hardwareConcurrency ?? "?")],
    ["Device memory", nav.deviceMemory ? `${nav.deviceMemory} GB` : "?"],
  ] };
}

/** A throwaway context: what the GPU and driver offer, independent of the views. */
function webglSection(): DiagnosticSection {
  const rows: [string, string][] = [];
  const canvas = window.document.createElement("canvas");
  const gl = canvas.getContext("webgl2");
  if (!gl) {
    rows.push(["WebGL 2", "unavailable"]);
    rows.push(["WebGL 1", window.document.createElement("canvas").getContext("webgl") ? "available" : "unavailable"]);
    return { title: "WebGL", rows };
  }
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  const read = (name: number) => { const value = gl.getParameter(name); return ArrayBuffer.isView(value) ? Array.from(value as Int32Array).join("x") : String(value); };
  rows.push(["WebGL 2", "available"]);
  rows.push(["Vendor", info ? read(info.UNMASKED_VENDOR_WEBGL) : read(gl.VENDOR)]);
  rows.push(["Renderer", info ? read(info.UNMASKED_RENDERER_WEBGL) : read(gl.RENDERER)]);
  rows.push(["Version", read(gl.VERSION)]);
  rows.push(["Shading language", read(gl.SHADING_LANGUAGE_VERSION)]);
  rows.push(["Max texture size", read(gl.MAX_TEXTURE_SIZE)]);
  rows.push(["Max renderbuffer size", read(gl.MAX_RENDERBUFFER_SIZE)]);
  rows.push(["Max viewport", read(gl.MAX_VIEWPORT_DIMS)]);
  rows.push(["Max vertex attributes", read(gl.MAX_VERTEX_ATTRIBS)]);
  rows.push(["Max elements vertices", read(gl.MAX_ELEMENTS_VERTICES)]);
  rows.push(["Max elements indices", read(gl.MAX_ELEMENTS_INDICES)]);
  rows.push(["Max samples", read(gl.MAX_SAMPLES)]);
  rows.push(["Extensions", String(gl.getSupportedExtensions()?.length ?? 0)]);
  // A context refused with failIfMajorPerformanceCaveat means the browser fell back to software rendering.
  const strict = window.document.createElement("canvas").getContext("webgl2", { failIfMajorPerformanceCaveat: true });
  rows.push(["Hardware accelerated", strict ? "yes" : "no (software rendering or a major performance caveat)"]);
  strict?.getExtension("WEBGL_lose_context")?.loseContext();
  gl.getExtension("WEBGL_lose_context")?.loseContext();
  return { title: "WebGL", rows };
}

/** Every piece object each live 3D view holds, where it ended up and whether the camera sees it. */
function viewerSections(): { sections: DiagnosticSection[]; drawn: Map<string, string[]> } {
  const sections: DiagnosticSection[] = [];
  const drawn = new Map<string, string[]>();
  for (const viewer of viewers) {
    const { renderer } = viewer;
    const camera = viewer.camera();
    const canvas = renderer.domElement;
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const rows: [string, string][] = [
      ["Canvas", `${canvas.clientWidth}x${canvas.clientHeight}${canvas.clientWidth === 0 ? " (tab hidden)" : ""}`],
      ["Drawing buffer", `${size.x}x${size.y}`],
      ["Context lost now", renderer.getContext().isContextLost() ? "yes" : "no"],
      ["Context lost / restored events", `${viewer.contextLost} / ${viewer.contextRestored}`],
      ["Last frame", `${renderer.info.render.calls} draw calls · ${renderer.info.render.triangles} triangles`],
      ["GPU geometries", String(renderer.info.memory.geometries)],
    ];
    camera.updateMatrixWorld();
    const cameraPosition = camera.getWorldPosition(new THREE.Vector3());
    rows.push(["Camera", `${camera.type} at ${vec(cameraPosition.toArray())}${"near" in camera ? ` · near ${round((camera as THREE.PerspectiveCamera).near)} far ${round((camera as THREE.PerspectiveCamera).far)}` : ""}`]);
    const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    rows.push(["Objects", String(viewer.models.children.length)]);
    // Keyed by name so two reports line up even when the objects were added in another order.
    const seenNames = new Map<string, number>();
    for (const child of viewer.models.children) {
      const name = typeof child.userData.source === "string" ? child.userData.source : `(unnamed ${child.type})`;
      const repeat = (seenNames.get(name) ?? 0) + 1;
      seenNames.set(name, repeat);
      const mesh = child as THREE.Mesh;
      const triangles = mesh.geometry?.index ? mesh.geometry.index.count / 3 : 0;
      const box = new THREE.Box3().setFromObject(child);
      const center = box.getCenter(new THREE.Vector3());
      const extent = box.getSize(new THREE.Vector3());
      const seen = !box.isEmpty() && frustum.intersectsBox(box);
      const state = `${child.visible ? "shown" : "hidden"} · ${triangles} tris · center ${vec(center.toArray())} · size ${vec(extent.toArray())} · ${seen ? "in view" : "out of view"} · ${round(center.distanceTo(cameraPosition), 2)} m from camera`;
      rows.push([`Object · ${name}${repeat > 1 ? ` #${repeat}` : ""}`, state]);
      drawn.set(name, [...(drawn.get(name) ?? []), `${viewer.label}: ${state}`]);
    }
    sections.push({ title: `Viewer · ${viewer.label}`, rows });
  }
  return { sections, drawn };
}

function settingsSection(): DiagnosticSection {
  const rows: [string, string][] = [];
  try {
    const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index) ?? "").filter((key) => key.startsWith("mc3pae.")).sort();
    for (const key of keys) {
      const value = localStorage.getItem(key) ?? "";
      // Recent lists and folders are paths: only how many.
      if (/recent|folder/i.test(key)) { let count = "?"; try { const parsed = JSON.parse(value); count = Array.isArray(parsed) ? `${parsed.length} entries` : "1 path"; } catch { count = "1 path"; } rows.push([key, count]); }
      else rows.push([key, value.slice(0, 300)]);
    }
  } catch { rows.push(["Storage", "unavailable"]); }
  return { title: "Settings", rows };
}

function lodsFamily(document: PckDocument) {
  if (document.format !== "pck" || document.fileSize < 0x1ac) return "n/a";
  const pointer = document.view.getUint32(0x1a8, true);
  const offset = pointer - document.pointerBase;
  if (offset < 0 || offset + 4 > document.fileSize) return `LODs pointer ${hex(pointer)} outside the file`;
  const magic = document.view.getUint32(offset, true);
  return `${hex(magic)} (${LOD_FAMILIES[magic] ?? "unknown family"})`;
}

function lodSummary(document: PckDocument) {
  return (["hlod", "mlod", "llod"] as const).map((lod) => {
    const entries = document.lodMeshes.filter((entry) => entry.lod === lod);
    return `${LOD_LABELS[lod]} ${entries.length} (${entries.filter((entry) => entry.meshBlockOffset !== null).length} embedded)`;
  }).join(" · ");
}

async function pckSection(role: VehicleRole, path: string, document: PckDocument, looseNames: Set<string>): Promise<DiagnosticSection[]> {
  const rows: [string, string][] = [
    ["File", path.replace(/^.*[\\/]/, "")],
    ["Size on open", `${document.originalBytes.length} B · sha256 ${await sha256(document.originalBytes)}`],
    ["In memory", `${document.fileSize} B${document.dirty ? " · unsaved edits" : ""}`],
    ["Format", document.format],
    ["Pointer base", hex(document.pointerBase)],
    ["LODs magic", lodsFamily(document)],
    ["Anchors", `${document.pieces.length} · roots ${document.roots.map((index) => document.pieces[index].name || `#${index}`).join(", ")}`],
    ["LOD rows", lodSummary(document)],
    ["Wheel slots", String(document.wheelSlots.length)],
    ["Runtime notes", document.runtimeNotes.join(" | ") || "none"],
  ];
  // Rows the game would fill from a loose mesh.pck that isn't in the set: the piece just isn't there.
  const missing = document.lodMeshes.filter((entry) => entry.meshBlockOffset === null && entry.name && !looseNames.has(`${entry.name}.pck`.toLowerCase()));
  const missingRows: [string, string][] = missing.map((entry) => [`${LOD_LABELS[entry.lod]} ${entry.index}`, `${entry.name} · id ${hex(entry.meshId & 0xffff, 2)}${isShellFamily(entry.name) ? " · shell family" : ""}`]);
  return [
    { title: `PCK · ${roleLabels[role]}`, rows },
    { title: `LOD rows with no geometry · ${roleLabels[role]}`, rows: missingRows.length ? missingRows : [["None", "every row has an embedded block or a loose file"]] },
  ];
}

function bounds(positions: Float32Array) {
  if (!positions.length) return "empty";
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < positions.length; index += 3) for (let axis = 0; axis < 3; axis += 1) { const value = positions[index + axis]; if (value < min[axis]) min[axis] = value; if (value > max[axis]) max[axis] = value; }
  return `${vec(min)} .. ${vec(max)}`;
}

async function pieceSections(set: VehicleSetSnapshot, drawn: Map<string, string[]>): Promise<DiagnosticSection[]> {
  const working = set.workingRole ? set.slots[set.workingRole]?.document ?? null : null;
  const meshEditor = readSource("meshEditor");
  const loose = [...set.meshDocs.values()];
  const customizable = hasStockVariants(loose.map((doc) => doc.geometry));
  // Embedded-only pieces, each once: the working PCK's reading first, as the Anchors tab draws it.
  const embedded = new Map<string, { geometry: MeshGeometry; roles: VehicleRole[] }>();
  for (const role of [set.workingRole, ...roles].filter((item): item is VehicleRole => Boolean(item))) {
    for (const piece of set.embeddedByRole[role]?.pieces ?? []) {
      const known = embedded.get(piece.name);
      if (!known) embedded.set(piece.name, { geometry: piece, roles: [role] });
      else if (!known.roles.includes(role)) known.roles.push(role);
    }
  }
  const pieces: { geometry: MeshGeometry; doc: MeshPckDocument | null; embeddedRoles: VehicleRole[] }[] = [
    ...loose.map((doc) => ({ geometry: doc.geometry, doc, embeddedRoles: [] as VehicleRole[] })),
    ...[...embedded.values()].map(({ geometry, roles: embeddedRoles }) => ({ geometry, doc: null, embeddedRoles })),
  ].sort((a, b) => a.geometry.name.localeCompare(b.geometry.name));
  const sections: DiagnosticSection[] = [];
  for (const { geometry, doc, embeddedRoles } of pieces) {
    const rows: [string, string][] = [];
    if (doc) {
      const magic = doc.originalBytes.length >= 0x84 ? new DataView(doc.originalBytes.buffer, doc.originalBytes.byteOffset).getUint32(0x80, true) : 0;
      rows.push(["Origin", "loose mesh.pck"]);
      rows.push(["File", `${doc.originalBytes.length} B · sha256 ${await sha256(doc.originalBytes)}${doc.dirty ? " · unsaved edits" : ""}`]);
      rows.push(["Mesh magic", `${hex(magic)} (${MESH_MAGICS[magic] ?? "other"})`]);
      rows.push(["Piece ID in file", hex(geometry.meshId, 2)]);
    } else rows.push(["Origin", `embedded only · read from ${embeddedRoles.map((role) => roleLabels[role]).join(", ")} · ${geometry.lod ? LOD_LABELS[geometry.lod] : "?"}`]);
    for (const role of roles) {
      const document = set.slots[role]?.document;
      if (!document) continue;
      const entries = matchLodEntries(geometry.name, document);
      rows.push([`Table rows · ${roleLabels[role]}`, entries.length ? entries.map((entry) => `${LOD_LABELS[entry.lod]} ${entry.index} id ${hex(entry.meshId & 0xffff, 2)} ${entry.meshBlockOffset !== null ? "embedded" : "no block"}`).join(" · ") : "none"]);
    }
    rows.push(["Category", `${geometry.category}${geometry.stock ? " · stock" : ""}${isShellFamily(geometry.name) ? " · shell family" : ""}`]);
    if (geometry.anchorIndex !== null && working?.pieces[geometry.anchorIndex]) {
      const anchor = working.pieces[geometry.anchorIndex];
      rows.push(["Anchor", `${geometry.anchorIndex} ${anchor.name} · world ${vec(anchorWorldPosition(working, geometry.anchorIndex, "a2"))} · rotation ${vec(anchor.rotation)}`]);
    } else rows.push(["Anchor", geometry.anchorIndex === null ? "none found" : `${geometry.anchorIndex} (outside the working PCK's anchor list)`]);
    rows.push(["Geometry", `${geometry.triangles} tris · ${geometry.packetVertices} packet vertices · ${geometry.packets.length} packets · ${geometry.materialGroups} groups`]);
    rows.push(["Local bounds", bounds(geometry.positions)]);
    rows.push(["Shaders", geometry.groupShaderIds.map((id) => hex(id, 2)).join(" ") || "none"]);
    const hidden = defaultHiddenReason(geometry, working, customizable);
    rows.push(["Default view", hidden ? `hidden · ${hidden}` : geometry.anchorIndex === null ? "hidden in Anchors · no anchor" : "shown"]);
    rows.push(["Anchors tab now", geometry.anchorIndex === null ? "not drawn (no anchor)" : set.anchorVisible.has(geometry.anchorIndex) ? "shown" : "hidden"]);
    if (meshEditor) rows.push(["Meshes tab now", meshEditor.visibleNames.has(geometry.name) ? "shown" : "hidden"]);
    for (const [index, state] of (drawn.get(geometry.name) ?? []).entries()) rows.push([`Drawn ${index + 1}`, state]);
    if (!drawn.has(geometry.name)) rows.push(["Drawn", "not in any live 3D view"]);
    sections.push({ title: `Piece · ${geometry.name}`, rows });
  }
  return sections;
}

async function vehicleSections(drawn: Map<string, string[]>): Promise<DiagnosticSection[]> {
  const set = readSource("vehicleSet");
  const sections: DiagnosticSection[] = [];
  const traceRows: [string, string][] = lastLoad ? [
    ["Opened", `${seconds(lastLoad.at)} · from ${lastLoad.how}${lastLoad.preferred ? ` · first pick ${lastLoad.preferred}` : ""}`],
    ["Files given", `${lastLoad.given.length} · ${lastLoad.given.filter((name) => !name.toLowerCase().endsWith(".mesh.pck")).join(", ") || "no car PCK"}`],
    ["Loose mesh.pck given", String(lastLoad.given.filter((name) => name.toLowerCase().endsWith(".mesh.pck")).length)],
    ["Set chosen", `${lastLoad.base || "?"} · ${roles.filter((role) => lastLoad!.files[role]).map((role) => `${roleLabels[role]} ${lastLoad!.files[role]}`).join(", ") || "none"}`],
    ["Working PCK", lastLoad.workingRole ? roleLabels[lastLoad.workingRole] : "none"],
    ["Mesh files rejected", lastLoad.meshFailures.length ? `${lastLoad.meshFailures.length}` : "0"],
    ...lastLoad.meshFailures.map(({ name, error }, index): [string, string] => [`Rejected ${index + 1}`, `${name} · ${error}`]),
    ["Error", lastLoad.error ?? "none"],
  ] : [["Opened", "no vehicle set opened this session"]];
  sections.push({ title: "Last vehicle open", rows: traceRows });
  if (!set) return sections;
  const working = set.workingRole ? set.slots[set.workingRole] : null;
  sections.push({ title: "Vehicle set", rows: [
    ["Base", set.vehicleBase || "none"],
    ["Folder", working ? working.path.replace(/[\\/][^\\/]*$/, "") : "none"],
    ["Working PCK", set.workingRole ? roleLabels[set.workingRole] : "none"],
    ["Meshes tab PCK", set.meshRole ? roleLabels[set.meshRole] : "none"],
    ["Current tab", set.workspace],
    ["Loose mesh.pck open", String(set.meshDocs.size)],
    ["Car has stk variants", hasStockVariants([...set.meshDocs.values()].map((doc) => doc.geometry)) ? "yes" : "no"],
    ["Anchors shown in Anchors tab", String(set.anchorVisible.size)],
  ] });
  const looseNames = new Set([...set.meshDocs.keys()].map((name) => name.toLowerCase()));
  for (const role of roles) {
    const slot = set.slots[role];
    if (!slot) continue;
    sections.push(...await pckSection(role, slot.path, slot.document, looseNames));
    const embedded = set.embeddedByRole[role];
    if (embedded && (embedded.unreadable.length || embedded.empty.length)) {
      sections.push({ title: `Embedded pieces not drawn · ${roleLabels[role]}`, rows: [
        ...embedded.unreadable.map((text, index): [string, string] => [`Unreadable ${index + 1}`, text]),
        ...embedded.empty.map((name, index): [string, string] => [`Empty placeholder ${index + 1}`, name]),
      ] });
    }
  }
  sections.push(...await pieceSections(set, drawn));
  return sections;
}

function logSection(): DiagnosticSection {
  return { title: "Console log", rows: log.length ? log.map((entry, index): [string, string] => [`#${String(index + 1).padStart(3, "0")}`, `${seconds(entry.at)} ${entry.level}: ${entry.text}`]) : [["None", "no warnings or errors"]] };
}

const singleLine = (value: string) => value.replace(/\r?\n/g, " ⏎ ");

export function formatReport(sections: DiagnosticSection[]) {
  const lines = [REPORT_HEADER, `Report format: ${REPORT_FORMAT}`];
  for (const section of sections) {
    lines.push("", `## ${singleLine(section.title)}`);
    for (const [key, value] of section.rows) lines.push(`${singleLine(key)}: ${singleLine(value)}`);
  }
  return `${lines.join("\n")}\n`;
}

/** The whole report as text, with the home folder masked. */
export async function buildDiagnosticReport() {
  const [version, tauri, home] = await Promise.all([getVersion().catch(() => "?"), getTauriVersion().catch(() => "?"), homeDir().catch(() => "")]);
  const viewerInfo = viewerSections();
  const sections: DiagnosticSection[] = [
    { title: "Report", rows: [["Generated", new Date().toISOString()], ["Uptime", seconds(Date.now())]] },
    environmentSection(version, tauri),
    webglSection(),
    settingsSection(),
    ...await vehicleSections(viewerInfo.drawn),
    ...viewerInfo.sections,
    logSection(),
  ];
  let text = formatReport(sections);
  const homePath = home.replace(/[\\/]+$/, "");
  if (homePath) text = text.split(homePath).join("~").split(homePath.replace(/\\/g, "/")).join("~");
  return text.replace(/([A-Za-z]:[\\/]Users[\\/])[^\\/\s:]+/gi, "$1<user>");
}

// --- Comparison ------------------------------------------------------------------------------

export type ParsedReport = { sections: Map<string, Map<string, string>> };

export function parseReport(text: string): ParsedReport {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  if (lines[0]?.trim() !== REPORT_HEADER) throw new Error("This is not a diagnostic report of the MC3 Modding Toolkit.");
  const sections = new Map<string, Map<string, string>>();
  let current: Map<string, string> | null = null;
  for (const line of lines.slice(1)) {
    const heading = /^## (.+)$/.exec(line);
    if (heading) { current = new Map(); sections.set(heading[1].trim(), current); continue; }
    const split = line.indexOf(": ");
    if (!current || split < 0) continue;
    current.set(line.slice(0, split), line.slice(split + 2));
  }
  return { sections };
}

export type ReportDifference = { section: string; key: string; a: string | null; b: string | null };

// Neither when the report was made nor how long the app had been open says anything about the bug.
const IGNORED_SECTIONS = new Set(["Report"]);
const stripLogTime = (value: string) => value.replace(/^\+[\d.]+s /, "");

/** Every row that differs, in report order (A's sections first, then the ones only B has). The
 *  console log is compared as a list of messages, without times or numbering. */
export function compareReports(a: ParsedReport, b: ParsedReport): ReportDifference[] {
  const output: ReportDifference[] = [];
  const titles = [...a.sections.keys(), ...[...b.sections.keys()].filter((title) => !a.sections.has(title))];
  for (const title of titles) {
    if (IGNORED_SECTIONS.has(title)) continue;
    const left = a.sections.get(title) ?? new Map<string, string>();
    const right = b.sections.get(title) ?? new Map<string, string>();
    if (title === "Console log") {
      const remaining = [...right.values()].map(stripLogTime);
      for (const value of [...left.values()].map(stripLogTime)) {
        const match = remaining.indexOf(value);
        if (match >= 0) remaining.splice(match, 1); else output.push({ section: title, key: "message", a: value, b: null });
      }
      for (const value of remaining) output.push({ section: title, key: "message", a: null, b: value });
      continue;
    }
    const keys = [...left.keys(), ...[...right.keys()].filter((key) => !left.has(key))];
    for (const key of keys) {
      const leftValue = left.get(key) ?? null, rightValue = right.get(key) ?? null;
      if (leftValue !== rightValue) output.push({ section: title, key, a: leftValue, b: rightValue });
    }
  }
  return output;
}

/** The comparison as text, to paste into a message. */
export function formatComparison(names: [string, string], differences: ReportDifference[]) {
  const lines = [`Comparison of diagnostic reports`, `A: ${names[0]}`, `B: ${names[1]}`, `${differences.length} difference${differences.length === 1 ? "" : "s"}`];
  let section = "";
  for (const difference of differences) {
    if (difference.section !== section) { section = difference.section; lines.push("", `## ${section}`); }
    lines.push(`${difference.key}`, `  A: ${difference.a ?? "(missing)"}`, `  B: ${difference.b ?? "(missing)"}`);
  }
  return `${lines.join("\n")}\n`;
}
