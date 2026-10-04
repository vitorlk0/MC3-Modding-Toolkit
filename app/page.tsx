import { tr, Tx, confirmDialog, messageDialog, setLanguage, useLanguage } from "./i18n";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { AboutDialog } from "./about-dialog";
import { readFile, writeFile, readDir, stat } from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { formatClipboard, hex, parseClipboard, PckDocument, type LodMeshEntry, type MeshBlobSnapshot, type Vec3 } from "../src/pck";
import { MeshPckDocument, hasStockVariants, isLowLodOnly, isShadowPlane, isShellFamily, matchLodEntries, parseEmbeddedMesh, resolveGroupShaderId, resolvePieceId, type MeshGeometry } from "../src/mesh";
import { isShellPiece } from "../src/mesh-inject";
import { exportMeshObj } from "../src/obj-export";
import { convertObjToMeshPck } from "../src/obj";
import { evaluateFieldInput } from "../src/expression";
import { collectLightAnchors, lightFamilies, lightFamilyLabels, planGlobalLightAnchors, summarizeLightAnchors, type LightFamily, type LightFamilySummary } from "../src/light-anchors";
import { parseFirstPpfModel, type PpfGeometry, type PpfKind } from "../src/ppf";
import { MeshViewer } from "./mesh-viewer";
import { MeshEditorWorkspace } from "./mesh-editor-workspace";
import { ModToolkitWorkspace } from "./mod-toolkit/toolkit-workspace";
import { onFileWritten } from "./mod-toolkit/toolkit-io";
import { PerformanceWorkspace, type PerfWrite } from "./performance-workspace";
import { TextureWorkspace, type TextureMenu } from "./texture-workspace";
import { IsoInstallWorkspace } from "./iso-install-workspace";
import { AudioWorkspace } from "./audio-workspace";
import { loadRecent, pushRecent, saveRecent } from "./recent-paths";
import { roleLabels, roles, sizeLabel, type VehicleRole, type VehicleSlots } from "./vehicle-types";
import { ResizeHandle } from "./resize-handle";

// Every "you have unsaved work" prompt goes through the native dialog, never window.confirm. The
// browser one renders as a page-level script dialog titled with the webview origin, and it blocks
// the webview's message loop — which is what deadlocked the window-close prompt until it moved
// here. Leftover from when this was going to be a web tool.
const confirmDiscard = (message: string) => confirmDialog(message, { title: "Unsaved changes", kind: "warning" });

type MenuName = "file" | "edit" | "help" | null;
// The Mod Toolkit is a third workspace rather than a mode of the other two: it works on loose
// files it opens itself, so it shares the window and the status bar but none of the vehicle set.
// Textures and the Mod Toolkit are loose-file workspaces: each opens its own files, independent of the vehicle set.
type Workspace = "anchor" | "mesh" | "performance" | "audio" | "textures" | "toolkit" | "iso";

// Tabs in the order the user works through a mod (their choice, 2026-09-27): the loose-file tools
// first, then anchors, pieces, behaviour, look, sound, and finally the install into the ISO. The
// first tab is the one the app opens on. The ids are internal and predate these labels.
const workspaceTabs: { id: Workspace; label: string }[] = [
  { id: "toolkit", label: "Tools" },
  { id: "anchor", label: "Anchors" },
  { id: "mesh", label: "Meshes" },
  { id: "performance", label: "Performance" },
  { id: "textures", label: "Textures" },
  { id: "audio", label: "Audio" },
  { id: "iso", label: "ISO Install" },
];
// A Performance or Audio edit writes into several loaded PCKs, each at its own offset, so its undo is
// kept here, spanning documents — one history per tab. Entries name the role rather than hold the
// document: saving swaps the non-working roles for fresh copies, and a held reference would then
// undo into a stale one.
type FieldAction = { label: string; writes: { role: VehicleRole; offset: number; before: Uint8Array; after: Uint8Array }[] };
// One piece-ID or shader-ID edit touches up to two independent documents at once (the car PCK's
// embedded copy, and the standalone mesh.pck) — this is its own combined undo history rather than
// PckDocument's, so a single Undo click reverts both halves of the same logical edit together, and
// the Mesh Editor's Edit menu has one linear timeline regardless of which kind of edit happened last.
//
// Entries name what they touched — the role, the LOD row's position, the piece — never the objects.
// Saving swaps the non-working roles for fresh copies, and compaction moves embedded blocks, so a
// held document or LodMeshEntry would undo into a detached copy or write an ID byte at an offset
// that has since moved. Everything is looked up again, live, when the entry is replayed.
type LodKey = { lod: LodMeshEntry["lod"]; index: number };
type PieceIdAction = {
  kind: "pieceId";
  meshName: string;
  role: VehicleRole;
  carEntries: LodKey[];
  carBefore: number;
  /** Null when there was no loose mesh.pck to edit. */
  standaloneBefore: number | null;
  after: number;
};
// Shader ID has no LOD-table mirror like piece ID does (see project memory) — the piece-ID action
// above only needs to touch the one role you're currently viewing plus the standalone mesh.pck,
// because the LOD table + Save-time sync handles the other roles. Shader ID has no such table, so
// every loaded role that embeds this piece is written immediately, right here, one target per role.
type ShaderIdTarget = { role: VehicleRole; before: number };
type ShaderIdAction = {
  kind: "shaderId";
  meshName: string;
  targets: ShaderIdTarget[];
  group: number;
  standaloneBefore: number | null;
  after: number;
};
// Replacing an embedded piece rewrites pointers and grows the file, so it can't be inverted field
// by field the way an ID edit can — each touched role document carries a before/after snapshot of
// its own, bundled here so one Undo reverts the whole multi-role update together.
type MeshBlobAction = {
  kind: "meshBlob";
  meshName: string;
  targets: { role: VehicleRole; before: MeshBlobSnapshot; after: MeshBlobSnapshot }[];
};
type MeshEditAction = PieceIdAction | ShaderIdAction | MeshBlobAction;
type FileEntry = { path: string; name: string };
type PpfSlot = { path: string; name: string; geometry: PpfGeometry };
type PpfSlots = Record<PpfKind, PpfSlot | null>;

const vehicleFilters = [{ name: "MC3 vehicle PCK / PSPPCK", extensions: ["pck", "psppck"] }];
const ppfFilters = [{ name: "MC3 PPF", extensions: ["ppf"] }];
const axes = ["X", "Y", "Z"] as const;
const ppfKinds: PpfKind[] = ["exhaust", "rim", "tire"];
const ppfLabels: Record<PpfKind, string> = { exhaust: "Exhaust PPF", rim: "Rim PPF", tire: "Tire PPF" };
const rimSizeOptions = Array.from({ length: 18 }, (_, index) => index + 13);
// A2 is the anchor that actually moves the piece in-game; the editor swaps which value sits under
// which label so the "A1" card is the one that moves, without touching the underlying file fields.
const anchorDisplayLabel: Record<"a1" | "a2", "A1" | "A2"> = { a1: "A2", a2: "A1" };
const emptySlots = (): VehicleSlots => ({ player: null, garage: null, opponent: null });
const emptyPpfSlots = (): PpfSlots => ({ exhaust: null, rim: null, tire: null });

/** Size of a loaded document, marked with `*` while it has edits that aren't on disk yet — the
 *  number shown is what saving would write, not what the file currently holds. */
function pendingSizeLabel(document: PckDocument) {
  return `${sizeLabel(document.projectedSize)}${document.dirty ? " *" : ""}`;
}

function sameBytes(a: Uint8Array, b: Uint8Array) { return a.length === b.length && a.every((value, index) => value === b[index]); }
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer; }
function basename(path: string) { return path.replace(/^.*[\\/]/, ""); }
/** Paths as Windows compares them: separators unified, case ignored. */
function normalizePath(path: string) { return path.replace(/\//g, "\\").toLowerCase(); }
function dirname(path: string) { return path.replace(/[\\/][^\\/]*$/, ""); }
function isMeshPck(name: string) { return name.toLowerCase().endsWith(".mesh.pck"); }
/** Pieces a car PCK carries baked in with no loose mesh.pck beside them — on cars like the 350Z
 *  that is the whole shell, the trunk and the suspension arms; on a motorcycle, everything. Read
 *  straight out of the PCK, so they follow it through shader edits and undo. */
function readEmbeddedOnly(document: PckDocument | null, meshDocs: Map<string, MeshPckDocument>) {
  const pieces: MeshGeometry[] = [];
  const unreadable: string[] = [];
  if (!document) return { pieces, unreadable };
  const loose = new Set([...meshDocs.keys()].map((name) => name.toLowerCase()));
  const seen = new Set<string>();
  for (const entry of document.lodMeshes) {
    const fileName = `${entry.name}.pck`;
    const key = fileName.toLowerCase();
    if (entry.meshBlockOffset === null || !entry.name || loose.has(key) || seen.has(key)) continue;
    seen.add(key);
    try { pieces.push(parseEmbeddedMesh(entry, document)); }
    catch (error) { unreadable.push(error instanceof Error ? error.message : fileName); }
  }
  return { pieces, unreadable };
}
function classifyVehicleFile(name: string) {
  const match = basename(name).match(/^(.*?)(?:_([go]))?(\.psppck|\.pck)$/i);
  if (!match || match[1].toLowerCase().endsWith(".mesh")) return null;
  const role: VehicleRole = match[2]?.toLowerCase() === "g" ? "garage" : match[2]?.toLowerCase() === "o" ? "opponent" : "player";
  return { role, base: match[1], extension: match[3].toLowerCase(), key: `${match[1].toLowerCase()}|${match[3].toLowerCase()}` };
}
function selectVehicleGroup(entries: FileEntry[], preferredName?: string) {
  const candidates = entries.map((entry) => ({ entry, info: classifyVehicleFile(entry.name) })).filter((item): item is { entry: FileEntry; info: NonNullable<ReturnType<typeof classifyVehicleFile>> } => Boolean(item.info));
  if (!candidates.length) throw new Error("No supported vehicle PCK/PSPPCK files were found.");
  const preferred = preferredName ? classifyVehicleFile(preferredName) : null;
  const grouped = new Map<string, typeof candidates>();
  for (const candidate of candidates) grouped.set(candidate.info.key, [...(grouped.get(candidate.info.key) ?? []), candidate]);
  const selected = preferred && grouped.has(preferred.key) ? grouped.get(preferred.key)! : [...grouped.values()].sort((a, b) => {
    const ar = new Set(a.map((item) => item.info.role)); const br = new Set(b.map((item) => item.info.role));
    return br.size - ar.size || Number(br.has("player")) - Number(ar.has("player")) || a[0].info.base.localeCompare(b[0].info.base);
  })[0];
  const output: Partial<Record<VehicleRole, FileEntry>> = {};
  for (const candidate of selected) output[candidate.info.role] ??= candidate.entry;
  return { base: selected[0].info.base, entries: output };
}
async function readDocument(path: string) {
  const bytes = await readFile(path);
  return new PckDocument(basename(path), toArrayBuffer(bytes));
}
/** Only the folder itself — subfolders are skipped on purpose: a `_bkp` or older copy of the car
 *  kept inside would otherwise be loaded into the set alongside the real files. */
async function collectDirectory(dirPath: string, output: FileEntry[]) {
  const entries = await readDir(dirPath);
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const entryPath = await join(dirPath, entry.name);
    if (classifyVehicleFile(entry.name) || isMeshPck(entry.name)) output.push({ path: entryPath, name: entry.name });
  }
}
async function collectDroppedPaths(paths: string[]) {
  const output: FileEntry[] = [];
  for (const path of paths) {
    const info = await stat(path).catch(() => null);
    if (info?.isDirectory) { await collectDirectory(path, output); continue; }
    const name = basename(path);
    if (classifyVehicleFile(name) || isMeshPck(name)) output.push({ path, name });
  }
  return output;
}
function axisMixed(doc: PckDocument, indices: number[], anchor: "a1" | "a2", component: number) {
  if (indices.length <= 1) return false;
  const first = doc.pieces[indices[0]][anchor][component];
  return indices.some((index) => !Object.is(doc.pieces[index][anchor][component], first));
}
function classifyPpfFile(name: string): PpfKind | null {
  const stem = basename(name).replace(/\.ppf$/i, "").toLowerCase();
  if (stem === "exhaust") return "exhaust";
  if (stem === "rim") return "rim";
  if (stem === "tire" || stem === "tyre") return "tire";
  return null;
}

const VEHICLE_RECENTS_KEY = "mc3pae.recentVehicleFolders";
const PPF_RECENTS_KEY = "mc3pae.recentPpfFolders";

const PANEL_WIDTHS_KEY = "mc3pae.panelWidths";
const ZERO_SHELL_ID_KEY = "mc3pae.syncZeroShellId";
const PANEL_LIMITS = { nav: [220, 480], editor: [320, 800], meshList: [220, 900] } as const;
function clampPanelWidth(value: number, [min, max]: readonly [number, number], fallback: number) {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}
function loadPanelWidths(): { nav: number; editor: number; meshList: number } {
  try {
    const parsed = JSON.parse(localStorage.getItem(PANEL_WIDTHS_KEY) ?? "null");
    if (parsed && typeof parsed.nav === "number" && typeof parsed.editor === "number") {
      return {
        nav: clampPanelWidth(parsed.nav, PANEL_LIMITS.nav, 300),
        editor: clampPanelWidth(parsed.editor, PANEL_LIMITS.editor, 440),
        meshList: clampPanelWidth(parsed.meshList, PANEL_LIMITS.meshList, 280),
      };
    }
  } catch { /* ignore */ }
  return { nav: 300, editor: 440, meshList: 280 };
}

function MenuItem({ children, shortcut, disabled, onClick }: { children: React.ReactNode; shortcut?: string; disabled?: boolean; onClick(): void }) {
  return <button className="menu-item" disabled={disabled} onClick={onClick}><span>{children}</span>{shortcut && <kbd>{shortcut}</kbd>}</button>;
}
function MeshVisibilityButton({ index, available, visible, onToggle }: { index: number; available: boolean; visible: boolean; onToggle(index: number): void }) {
  if (!available) return null;
  return <button className={`mesh-visibility ${visible ? "visible" : "hidden"}`} onClick={() => onToggle(index)} title={visible ? tr("Hide this part in the 3D preview") : tr("Show this part in the 3D preview")} aria-label={visible ? tr("Hide mesh") : tr("Show mesh")} aria-pressed={visible}><span /></button>;
}
function TreeRow({ document, index, selectedIndices, expanded, meshAnchors, visibleAnchors, onSelect, onToggle, onToggleVisibility, depth = 0 }: { document: PckDocument; index: number; selectedIndices: Set<number>; expanded: Set<number>; meshAnchors: Set<number>; visibleAnchors: Set<number>; onSelect(index: number, modifiers?: { additive?: boolean; range?: boolean }): void; onToggle(index: number): void; onToggleVisibility(index: number): void; depth?: number }) {
  const piece = document.pieces[index]; const children = document.children.get(index) ?? []; const isOpen = expanded.has(index);
  return <><div className={`tree-row ${selectedIndices.has(index) ? "selected" : ""}`} style={{ paddingLeft: 10 + depth * 16 }}><button className={`tree-toggle ${children.length ? "" : "empty"}`} onClick={() => children.length && onToggle(index)} aria-label={isOpen ? tr("Collapse") : tr("Expand")}>{isOpen ? "−" : "+"}</button><button className="tree-label" onClick={(event) => onSelect(index, { additive: event.ctrlKey || event.metaKey, range: event.shiftKey })} title={piece.name}><span>{piece.name}</span><small>{hex(piece.index, 4)}</small></button><MeshVisibilityButton index={index} available={meshAnchors.has(index)} visible={visibleAnchors.has(index)} onToggle={onToggleVisibility} /></div>{isOpen && children.map((child) => <TreeRow key={child} document={document} index={child} selectedIndices={selectedIndices} expanded={expanded} meshAnchors={meshAnchors} visibleAnchors={visibleAnchors} onSelect={onSelect} onToggle={onToggle} onToggleVisibility={onToggleVisibility} depth={depth + 1} />)}</>;
}
type CoordinateChangeMode = "commit" | "preview" | "scrub-commit" | "scrub-cancel";
function CoordinateInput({ axis, value, mixed, locked, onChange }: { axis: string; value: number; mixed?: boolean; locked?: boolean; onChange(value: number, mode: CoordinateChangeMode, startValue?: number): void }) {
  const formatted = mixed ? "" : (Number.isFinite(value) ? value.toFixed(5) : "0.00000"); const [draft, setDraft] = useState(formatted);
  const scrubRef = useRef<{ pointerId: number; startX: number; lastX: number; startValue: number; currentValue: number; moved: boolean } | null>(null);
  useEffect(() => setDraft(formatted), [formatted]);
  useEffect(() => () => document.body.classList.remove("anchor-scrubbing"), []);
  const commit = () => { if (locked) return; if (scrubRef.current?.moved) return; if (draft.trim() === "") { setDraft(formatted); return; } const parsed = evaluateFieldInput(draft); if (parsed === null) { setDraft(formatted); return; } const rounded = Math.round(parsed * 100000) / 100000; setDraft(rounded.toFixed(5)); if (mixed || !Object.is(rounded, value)) onChange(rounded, "commit"); };
  const finishScrub = (commitChange: boolean) => {
    const scrub = scrubRef.current; if (!scrub) return;
    document.body.classList.remove("anchor-scrubbing"); scrubRef.current = null;
    if (!scrub.moved) return;
    if (commitChange) onChange(scrub.currentValue, "scrub-commit", scrub.startValue);
    else { setDraft(scrub.startValue.toFixed(5)); onChange(scrub.startValue, "scrub-cancel", scrub.startValue); }
  };
  return <label className="scrubbable-coordinate" title={tr("Drag horizontally · Shift for fine adjustment · Ctrl for fast adjustment · Accepts math: 1.5+0.25, 10-5, 2*1.5, 10/4, parentheses")}><span>{axis}</span><input type="text" inputMode="decimal" readOnly={locked} value={draft} placeholder={mixed ? tr("Mult Values") : undefined} onChange={(event) => setDraft(event.target.value)} onBlur={commit} onPointerDown={(event) => {
    if (mixed || locked || event.button !== 0) return; const startValue = value;
    scrubRef.current = { pointerId: event.pointerId, startX: event.clientX, lastX: event.clientX, startValue, currentValue: startValue, moved: false }; event.currentTarget.setPointerCapture(event.pointerId);
  }} onPointerMove={(event) => {
    const scrub = scrubRef.current; if (!scrub || scrub.pointerId !== event.pointerId || !(event.buttons & 1)) return;
    const movement = event.clientX - scrub.lastX; scrub.lastX = event.clientX;
    if (!scrub.moved && Math.abs(event.clientX - scrub.startX) < 2) return;
    scrub.moved = true; document.body.classList.add("anchor-scrubbing"); event.preventDefault();
    const step = event.ctrlKey ? 0.01 : event.shiftKey ? 0.0001 : 0.001;
    scrub.currentValue = Math.round((scrub.currentValue + movement * step) * 100000) / 100000;
    setDraft(scrub.currentValue.toFixed(5)); onChange(scrub.currentValue, "preview", scrub.startValue);
  }} onPointerUp={(event) => { if (scrubRef.current?.pointerId === event.pointerId) finishScrub(true); }} onPointerCancel={() => finishScrub(false)} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") { if (scrubRef.current) finishScrub(false); else { setDraft(formatted); event.currentTarget.blur(); } } }} aria-label={tr(`${axis} coordinate`)} /></label>;
}
function VecEditor({ label, value, mixed, locked, canPaste, onCopy, onPaste, onChange }: { label: string; value: Vec3; mixed?: [boolean, boolean, boolean]; locked?: boolean; canPaste: boolean; onCopy(): void; onPaste(): void; onChange(component: number, value: number, mode: CoordinateChangeMode, startValue?: number): void }) {
  return <section className="vector-card"><div className="vector-title"><strong>{label}</strong><div className="vector-title-tools"><button onClick={onCopy}>{tr("Copy Values")}</button><button disabled={!canPaste || locked} onClick={onPaste}>{tr("Paste Values")}</button></div></div><div className="vector-grid">{axes.map((axis, component) => <CoordinateInput key={axis} axis={axis} value={value[component]} mixed={mixed?.[component]} locked={locked} onChange={(next, mode, startValue) => onChange(component, next, mode, startValue)} />)}</div></section>;
}
type Vec3Draft = [string, string, string];
const emptyLightDrafts = (): Record<LightFamily, Vec3Draft> => ({ tail: ["", "", ""], rev: ["", "", ""], brake: ["", "", ""] });
const showVec = (value: Vec3) => value.map((component) => component.toFixed(5)).join(", ");
// Unlike CoordinateInput this holds plain strings, because "empty" is a meaningful state here: a
// row left blank is skipped entirely rather than writing a value over the whole vehicle. Math is
// evaluated on apply, not on blur, so a half-typed expression isn't silently rewritten.
function LightAnchorRow({ summary, draft, onChange, onFill, onApply }: { summary: LightFamilySummary; draft: Vec3Draft; onChange(component: number, text: string): void; onFill(): void; onApply(): void }) {
  const filled = draft.filter((text) => text.trim() !== "").length;
  const badAxes = axes.filter((_, component) => draft[component].trim() !== "" && evaluateFieldInput(draft[component]) === null);
  // Set is gated on the row being complete and parseable, so "half-filled" is simply a disabled
  // button with the reason underneath rather than an error you only discover after clicking.
  const ready = filled === 3 && badAxes.length === 0 && summary.left + summary.right > 0;
  const hint = badAxes.length ? `Not a number: ${badAxes.join(", ")}`
    : filled && filled < 3 ? "Fill all three to enable Set"
    : !summary.sample ? "No anchors of this kind in this vehicle"
    : summary.varies ? `Varies · sample ${showVec(summary.sample)}`
    : `All left anchors at ${showVec(summary.sample)}`;
  return <div className="light-row">
    <div className="light-row-head">
      <strong>{tr(lightFamilyLabels[summary.family])}</strong>
      <div className="light-row-tools">
        <span><Tx t="{0} left · {1} right" v={[summary.left, summary.right]} /></span>
        <button disabled={!summary.sample} onClick={onFill} title={summary.sample ? tr(`Fill with ${showVec(summary.sample)}`) : tr("No anchors of this kind in this vehicle")}>{tr("Fill")}</button>
        <button className="light-set" disabled={!ready} onClick={onApply} title={ready ? tr(`Write this to all ${summary.left + summary.right} ${summary.family} anchors, mirroring X on the right side`) : tr("Fill all three fields with numbers first")}>{tr("Set")}</button>
      </div>
    </div>
    <div className="vector-grid">{axes.map((axis, component) => <label key={axis}><span>{axis}</span><input type="text" inputMode="decimal" value={draft[component]} placeholder="—" onChange={(event) => onChange(component, event.target.value)} aria-label={`${lightFamilyLabels[summary.family]} ${axis}`} /></label>)}</div>
    <small className={badAxes.length || (filled && filled < 3) ? "light-row-warn" : ""} title={hint}>{hint}</small>
  </div>;
}
function TogglePanel({ title, meta, open, onToggle, children }: { title: string; meta: string; open: boolean; onToggle(): void; children: React.ReactNode }) {
  return <section className={`toggle-panel ${open ? "open" : ""}`}><button className="toggle-panel-heading" onClick={onToggle}><span><i>{open ? "−" : "+"}</i><strong>{title}</strong></span><em>{meta}</em></button>{open && <div className="toggle-panel-body">{children}</div>}</section>;
}
function RecentMenu({ recents, onOpen, onClear }: { recents: string[]; onOpen(path: string): void; onClear(): void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { const close = (event: MouseEvent) => { if (!ref.current?.contains(event.target as Node)) setOpen(false); }; window.addEventListener("mousedown", close); return () => window.removeEventListener("mousedown", close); }, []);
  if (!recents.length) return null;
  return <div className="recent-menu" ref={ref}>
    <button className="folder-button" onClick={() => setOpen((value) => !value)} title={tr("Recent folders")} aria-label={tr("Recent folders")} aria-expanded={open}>{tr("Recent ▾")}</button>
    {open && <div className="dropdown recent-dropdown">
      {recents.map((path) => <button key={path} className="menu-item" title={path} onClick={() => { setOpen(false); onOpen(path); }}><span>{basename(path)}</span></button>)}
      <div className="separator" />
      <button className="menu-item" onClick={() => { setOpen(false); onClear(); }}><span>{tr("Clear list")}</span></button>
    </div>}
  </div>;
}

export default function App() {
  const [slots, setSlots] = useState<VehicleSlots>(emptySlots);
  const [ppfSlots, setPpfSlots] = useState<PpfSlots>(emptyPpfSlots);
  const [rimSizeInches, setRimSizeInches] = useState(26);
  const [vectorClipboard, setVectorClipboard] = useState<{ value: Vec3; source: string } | null>(null);
  const [meshDocs, setMeshDocs] = useState<Map<string, MeshPckDocument>>(new Map());
  const [objFolder, setObjFolder] = useState("");
  const [visibleMeshAnchors, setVisibleMeshAnchors] = useState<Set<number>>(new Set());
  const [meshErrors, setMeshErrors] = useState(0);
  const [workingRole, setWorkingRole] = useState<VehicleRole | null>(null);
  const [vehicleBase, setVehicleBase] = useState("");
  const [selectedIndices, setSelectedIndices] = useState<Set<number>>(new Set([0]));
  const selected = useMemo(() => { const list = [...selectedIndices]; return list.length ? list[list.length - 1] : 0; }, [selectedIndices]);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [search, setSearch] = useState(""); const [listSearch, setListSearch] = useState("");
  const [navigatorTab, setNavigatorTab] = useState<"tree" | "list">("tree");
  const [detailOpen, setDetailOpen] = useState({ position: true, offset: false, lights: false, hierarchy: true, binary: false, diagnostics: false });
  const [lightDrafts, setLightDrafts] = useState<Record<LightFamily, Vec3Draft>>(emptyLightDrafts);
  const [offsetDraft, setOffsetDraft] = useState<Vec3Draft>(["", "", ""]);
  const [menu, setMenu] = useState<MenuName>(null); const [status, setStatus] = useState("Ready"); const [revision, setRevision] = useState(0);
  const [workspace, setWorkspace] = useState<Workspace>(workspaceTabs[0].id);
  // Subscribes the whole page to the interface language: switching re-renders every text through tr().
  const language = useLanguage();
  const [meshViewRole, setMeshViewRole] = useState<VehicleRole | null>(null);
  const [dragging, setDragging] = useState(false); const [showAbout, setShowAbout] = useState(false);
  // Paths dropped while the Mod Toolkit is open, handed to its active tool and cleared once taken.
  const [toolkitDrop, setToolkitDrop] = useState<string[] | null>(null);
  const [texturesDrop, setTexturesDrop] = useState<string[] | null>(null);
  const textureMenu = useRef<TextureMenu | null>(null);
  /** Runs a Textures tab action from the menubar and closes the menu. */
  const textureAction = (action: keyof Pick<TextureMenu, "open" | "save" | "saveAs" | "close" | "undo" | "redo">) => { setMenu(null); textureMenu.current?.[action](); };
  const [isoDrop, setIsoDrop] = useState<string[] | null>(null);
  // True while the ISO Install tab or the Compact ISO tool is writing a disc image; closing then
  // could leave it half-written.
  const [isoWriting, setIsoWriting] = useState(false);
  // The Textures tab stays mounted while hidden; its unsaved edits count when closing the app.
  const [texturesPending, setTexturesPending] = useState(false);
  const [recentVehicleFolders, setRecentVehicleFolders] = useState<string[]>(() => loadRecent(VEHICLE_RECENTS_KEY));
  const [recentPpfFolders, setRecentPpfFolders] = useState<string[]>(() => loadRecent(PPF_RECENTS_KEY));
  const [panelWidths, setPanelWidths] = useState(() => loadPanelWidths());
  const [zeroShellId, setZeroShellId] = useState(() => { try { return localStorage.getItem(ZERO_SHELL_ID_KEY) !== "false"; } catch { return true; } });
  useEffect(() => { try { localStorage.setItem(ZERO_SHELL_ID_KEY, String(zeroShellId)); } catch { /* storage unavailable */ } }, [zeroShellId]);
  const menuRef = useRef<HTMLDivElement>(null);
  const document = workingRole ? slots[workingRole]?.document ?? null : null;
  const loadedCount = roles.filter((role) => slots[role]).length;
  // The Mesh Editor can inspect any loaded role independently of which one the Anchor Editor is
  // currently editing, since "embedded" status is per-role (Garage embeds far more than Player).
  const meshRole = meshViewRole && slots[meshViewRole] ? meshViewRole : workingRole;
  const meshDocument = meshRole ? slots[meshRole]?.document ?? null : null;
  // Piece-ID edits can land on any loaded role via the Mesh Editor's own role selector, independent
  // of which one the Anchor Editor is working on — so "is anything unsaved" must check all three.
  const anySlotDirty = roles.some((role) => slots[role]?.document.dirty) || [...meshDocs.values()].some((doc) => doc.dirty);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  const pieceIdUndoRef = useRef<MeshEditAction[]>([]);
  const pieceIdRedoRef = useRef<MeshEditAction[]>([]);
  const editPieceId = useCallback((meshName: string, entries: LodMeshEntry[], newId: number) => {
    if (!meshDocument || !entries.length) return;
    const standaloneDoc = meshDocs.get(meshName) ?? null;
    const carBefore = entries[0].meshId;
    const standaloneBefore = standaloneDoc?.meshId ?? null;
    const carChanged = meshDocument.setLodMeshId(entries, newId, false);
    const standaloneChanged = standaloneDoc ? standaloneDoc.setMeshId(newId, false) : false;
    if ((carChanged || standaloneChanged) && meshRole) {
      pieceIdUndoRef.current.push({ kind: "pieceId", meshName, role: meshRole, carEntries: entries.map(({ lod, index }) => ({ lod, index })), carBefore, standaloneBefore, after: newId });
      if (pieceIdUndoRef.current.length > 20) pieceIdUndoRef.current.shift();
      pieceIdRedoRef.current = [];
    }
    refresh();
  }, [meshDocument, meshDocs, meshRole, refresh]);
  const editGroupShader = useCallback((meshName: string, group: number, newId: number) => {
    // Writes every loaded role's embedded copy of this piece immediately (not just the one you're
    // currently viewing) — shader ID has no LOD-table mirror to lean on for a deferred Save-time
    // sync the way piece ID does, so waiting until Save left the other roles visibly out of sync
    // in the UI in between, which is what confused the user into thinking sync wasn't working.
    const targets: (ShaderIdTarget & { document: PckDocument; entries: LodMeshEntry[] })[] = [];
    for (const role of roles) {
      const roleDocument = slots[role]?.document; if (!roleDocument) continue;
      const entries = matchLodEntries(meshName, roleDocument).filter((entry) => entry.meshBlockOffset !== null);
      if (!entries.length) continue;
      const before = roleDocument.readGroupShaderId(entries[0].meshBlockOffset!, group);
      if (before === null) continue;
      targets.push({ role, document: roleDocument, entries, before });
    }
    const standaloneDoc = meshDocs.get(meshName) ?? null;
    const standaloneBefore = standaloneDoc?.geometry.groupShaderIds[group] ?? null;
    let anyChanged = false;
    for (const target of targets) {
      try { if (target.document.setGroupShaderId(target.entries, group, newId, false)) anyChanged = true; }
      catch (error) { console.warn(`Shader sync failed for ${meshName} group ${group}:`, error); }
    }
    if (standaloneDoc && standaloneDoc.setGroupShaderId(group, newId, false)) anyChanged = true;
    if (anyChanged) {
      pieceIdUndoRef.current.push({ kind: "shaderId", meshName, targets: targets.map(({ role, before }) => ({ role, before })), group, standaloneBefore, after: newId });
      if (pieceIdUndoRef.current.length > 20) pieceIdUndoRef.current.shift();
      pieceIdRedoRef.current = [];
    }
    refresh();
  }, [meshDocs, refresh, slots]);
  /**
   * Re-embeds a loose mesh.pck into every loaded role that carries an embedded copy of it —
   * the whole point of spec 9.4. This replaces the old manual "edit the loose file, then run an
   * external tool to bake it back into _g.pck" round trip the user described as destructive.
   *
   * The new copy is appended at the end of each target PCK and its LOD slot repointed, so a piece
   * that changed size is fine; the bytes it replaces are simply abandoned in place. Everything
   * stays in memory until Save, like every other edit in this app.
   */
  /**
   * Works out which PCKs a piece should be embedded into.
   *
   * A piece already embedded somewhere keeps to those PCKs — that's an update, and moving it
   * elsewhere isn't the user's intent. A piece embedded nowhere is an insertion, and where it
   * belongs depends on what it is: shell-family pieces (bodywork every version of the car carries)
   * go into every PCK that has a table row for them, while customization parts go into the garage
   * PCK alone, which is the only one that carries them in the shipped files.
   *
   * Only rows that already exist count as targets. A piece with no row anywhere can't be inserted
   * at all, and reports as such instead of being silently skipped.
   */
  const describeEmbedTarget = useCallback((meshName: string) => {
    const withRow = roles.filter((role) => slots[role] && matchLodEntries(meshName, slots[role]!.document).length > 0);
    const embedded = withRow.filter((role) => matchLodEntries(meshName, slots[role]!.document).some((entry) => entry.meshBlockOffset !== null));
    if (!withRow.length) return { targets: [] as VehicleRole[], inserting: false, hasRow: false };
    if (embedded.length) return { targets: isShellFamily(meshName) ? withRow : embedded, inserting: isShellFamily(meshName) && withRow.length > embedded.length, hasRow: true };
    const targets = isShellFamily(meshName) ? withRow : withRow.filter((role) => role === "garage");
    return { targets, inserting: true, hasRow: true };
  }, [slots]);

  /**
   * How much of the viewed car one piece takes up, against what it took up on disk.
   *
   * The embedded block is the number that actually explains the car's size, and it isn't always
   * the loose file's size: re-embedding into a block that used to hold something larger keeps the
   * bigger reserved footprint. The loose size is reported alongside so the difference is visible
   * rather than confusing.
   */
  const describePieceSize = useCallback((meshName: string) => {
    const meshDoc = meshDocs.get(meshName);
    const loose = meshDoc ? meshDoc.bytes.byteLength : null;
    const looseSaved = meshDoc ? meshDoc.savedBytes.byteLength : null;
    if (!meshDocument) return { embedded: null, embeddedSaved: null, loose, looseSaved, embeddedHere: false };
    const entry = matchLodEntries(meshName, meshDocument).find((item) => item.meshBlockOffset !== null)
      ?? matchLodEntries(meshName, meshDocument)[0];
    if (!entry) return { embedded: null, embeddedSaved: null, loose, looseSaved, embeddedHere: false };
    return {
      embedded: meshDocument.embeddedBlockSize(entry),
      embeddedSaved: meshDocument.savedEmbeddedBlockSize(entry),
      loose,
      looseSaved,
      embeddedHere: entry.meshBlockOffset !== null,
    };
  }, [meshDocs, meshDocument]);

  const updateEmbeddedMeshes = useCallback((meshNames: string[], actionLabel: string, docs: Map<string, MeshPckDocument> = meshDocs) => {
    // One before-snapshot per document up front and one after-snapshot at the end, so however many
    // pieces this covers, the user gets exactly one Undo step for the whole operation.
    const documents = roles.map((role) => ({ role, document: slots[role]?.document })).filter((item): item is { role: VehicleRole; document: PckDocument } => Boolean(item.document));
    const before = new Map(documents.map(({ document }) => [document, document.captureState()]));
    const sizeBefore = new Map(documents.map(({ document }) => [document, document.projectedSize]));
    const touched = new Set<PckDocument>();
    const warnings: string[] = [];
    let replacedEntries = 0;
    let updatedPieces = 0;
    let insertedPieces = 0;
    let zeroedShells = 0;

    for (const meshName of meshNames) {
      const meshDoc = docs.get(meshName);
      if (!meshDoc) { warnings.push(`${meshName}: no loose mesh.pck is loaded.`); continue; }
      const plan = describeEmbedTarget(meshName);
      if (!plan.hasRow) { warnings.push(`${meshName}: no HLOD/MLOD/LLOD row in any loaded PCK, so there is no slot to embed it into.`); continue; }
      if (!plan.targets.length) { warnings.push(`${meshName}: no PCK to embed it into.`); continue; }
      // Same rule as the Car PCK Mesh Injector's option: clear an ID a shell borrowed to preview.
      // Done before embedding, since the embed stamps the table's ID into the copy it writes, and
      // across every loaded role so the three PCKs keep agreeing on the piece's ID.
      if (zeroShellId && isShellPiece(meshName)) {
        let zeroed = false;
        for (const { document } of documents) {
          const entries = matchLodEntries(meshName, document);
          if (entries.some((entry) => entry.meshId !== 0) && document.setLodMeshId(entries, 0, false)) { touched.add(document); zeroed = true; }
        }
        if (zeroed) zeroedShells += 1;
      }
      let touchedPiece = false;
      for (const role of plan.targets) {
        const document = slots[role]?.document; if (!document) continue;
        const entries = matchLodEntries(meshName, document);
        if (!entries.length) continue;
        try {
          for (const entry of entries) document.replaceEmbeddedMesh(entry, meshDoc.bytes, false);
          touched.add(document);
          replacedEntries += entries.length;
          touchedPiece = true;
        } catch (error) {
          warnings.push(`${meshName} on ${roleLabels[role]}: ${error instanceof Error ? error.message : "unknown error"}`);
        }
      }
      if (touchedPiece) { if (plan.inserting) insertedPieces += 1; else updatedPieces += 1; }
    }

    const targets: MeshBlobAction["targets"] = documents.filter(({ document }) => touched.has(document)).map(({ role, document }) => ({ role, before: before.get(document)!, after: document.captureState() }));
    if (targets.length) {
      pieceIdUndoRef.current.push({ kind: "meshBlob", meshName: actionLabel, targets });
      if (pieceIdUndoRef.current.length > 20) pieceIdUndoRef.current.shift();
      pieceIdRedoRef.current = [];
    }
    refresh();
    if (warnings.length) console.warn("Embedded mesh update warnings:", warnings);

    if (!targets.length) {
      setStatus(warnings.length ? `${actionLabel} could not be embedded · ${warnings[0]}` : `${actionLabel} has no PCK to embed into — nothing to do.`);
      return;
    }
    const bytesAdded = [...touched].reduce((sum, document) => sum + (document.projectedSize - (sizeBefore.get(document) ?? document.projectedSize)), 0);
    const warnNote = warnings.length ? ` · ${warnings.length} failure${warnings.length === 1 ? "" : "s"} (see console)` : "";
    const parts = [
      insertedPieces ? `${insertedPieces} inserted` : null,
      updatedPieces ? `${updatedPieces} updated` : null,
    ].filter(Boolean).join(" · ");
    const zeroNote = zeroedShells ? ` · ${zeroedShells} shell ID${zeroedShells === 1 ? "" : "s"} zeroed` : "";
    // Lighter pieces make this negative, which is the interesting case when models are being
    // brought in specifically to be smaller.
    const sizeNote = bytesAdded === 0 ? "same size, rewritten in place" : `${bytesAdded > 0 ? "+" : "−"}${sizeLabel(Math.abs(bytesAdded))} once saved`;
    setStatus(`${actionLabel} · ${parts} into ${targets.length} PCK${targets.length === 1 ? "" : "s"} · ${replacedEntries} LOD slot${replacedEntries === 1 ? "" : "s"} repointed${zeroNote} · ${sizeNote}${warnNote}`);
  }, [describeEmbedTarget, meshDocs, refresh, slots, zeroShellId]);

  const updateEmbeddedMesh = useCallback((meshName: string) => {
    updateEmbeddedMeshes([meshName], meshName.replace(/\.mesh\.pck$/i, ""));
  }, [updateEmbeddedMeshes]);

  /**
   * Converts a folder of OBJs into loose mesh.pck pieces and embeds them, in one action.
   *
   * The OBJs are expected to come out of Blender production-ready — this only does the format work
   * needed to become a PCK (V flip, stripification into the winding the engine reads, s16
   * quantization), never anything that would change the model itself. The piece ID comes from each
   * filename's hex prefix and the shader IDs from its material names.
   *
   * Like every other edit here, nothing reaches disk: converted pieces replace their loose
   * documents in memory and the embedded copies are updated, all pending until Save. Reopening the
   * vehicle without saving discards the whole conversion.
   */
  const convertObjFolder = useCallback(async (folderPath: string) => {
    const anchorSlot = roles.map((role) => slots[role]).find(Boolean);
    if (!anchorSlot || !meshDocument) { setStatus("Open a vehicle set before converting OBJs."); return; }
    const vehicleFolder = dirname(anchorSlot.path);
    try {
      const entries = await readDir(folderPath);
      const objFiles = entries.filter((entry) => !entry.isDirectory && entry.name.toLowerCase().endsWith(".obj")).map((entry) => entry.name).sort();
      if (!objFiles.length) { setStatus(`No .obj files found in ${basename(folderPath)}.`); return; }

      setStatus(`Converting ${objFiles.length} OBJ${objFiles.length === 1 ? "" : "s"}…`);
      const nextMeshDocs = new Map(meshDocs);
      const convertedNames: string[] = [];
      const failures: string[] = [];
      let created = 0;
      let replaced = 0;

      for (const objName of objFiles) {
        try {
          const text = new TextDecoder().decode(await readFile(await join(folderPath, objName)));
          const result = convertObjToMeshPck(text, objName);
          const existing = nextMeshDocs.get(result.name);
          if (existing) {
            existing.replaceBytes(result.bytes);
            replaced += 1;
          } else {
            const document = new MeshPckDocument(await join(vehicleFolder, result.name), result.name, toArrayBuffer(result.bytes), meshDocument);
            document.markAsNew();
            nextMeshDocs.set(result.name, document);
            created += 1;
          }
          convertedNames.push(result.name);
        } catch (error) {
          failures.push(`${objName}: ${error instanceof Error ? error.message : "unknown error"}`);
        }
      }

      setMeshDocs(nextMeshDocs);
      // The Anchor Editor's visible set is seeded only when a vehicle set opens, so pieces that
      // arrive here would sit hidden in its 3D view. A piece that was just converted is one the
      // user wants to see — show every one that sits on an anchor.
      const convertedAnchors = convertedNames.map((name) => nextMeshDocs.get(name)?.geometry.anchorIndex).filter((index): index is number => typeof index === "number");
      if (convertedAnchors.length) setVisibleMeshAnchors((current) => new Set([...current, ...convertedAnchors]));
      if (failures.length) console.warn("OBJ conversion failures:", failures);
      if (!convertedNames.length) { setStatus(`No OBJ could be converted · ${failures[0] ?? "unknown error"}`); return; }

      setObjFolder(folderPath);
      const failNote = failures.length ? ` · ${failures.length} failed (see console)` : "";
      setStatus(`Converted ${convertedNames.length} OBJ${convertedNames.length === 1 ? "" : "s"} · ${replaced} updated, ${created} new · embedding…${failNote}`);
      // The freshly converted pieces still have to reach the PCKs that carry them; reuse the same
      // routine the re-embed button uses so the shell/garage placement rule stays in one place.
      // The new map is handed over directly, since React state won't have caught up yet.
      updateEmbeddedMeshes(convertedNames, `${convertedNames.length} converted piece${convertedNames.length === 1 ? "" : "s"}`, nextMeshDocs);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not read that OBJ folder.");
    }
  }, [meshDocs, meshDocument, slots, updateEmbeddedMeshes]);

  const chooseObjFolder = useCallback(async () => {
    try {
      const selection = await open({ directory: true });
      if (!selection || Array.isArray(selection)) return;
      await convertObjFolder(selection);
    } catch (error) { setStatus(error instanceof Error ? error.message : "Could not open that folder."); }
  }, [convertObjFolder]);

  /** Brings every loose mesh.pck in line in one pass: updates the ones already embedded and inserts
   *  the ones that only have an empty table row waiting for them. */
  const updateAllEmbeddedMeshes = useCallback(() => {
    const embeddable = [...meshDocs.keys()].filter((meshName) => describeEmbedTarget(meshName).targets.length > 0);
    if (!embeddable.length) { setStatus("No loaded mesh.pck file has a PCK to embed into — nothing to do."); return; }
    updateEmbeddedMeshes(embeddable, `${embeddable.length} piece${embeddable.length === 1 ? "" : "s"}`);
  }, [describeEmbedTarget, meshDocs, updateEmbeddedMeshes]);

  const perfUndoRef = useRef<FieldAction[]>([]);
  const perfRedoRef = useRef<FieldAction[]>([]);
  const audioUndoRef = useRef<FieldAction[]>([]);
  const audioRedoRef = useRef<FieldAction[]>([]);
  const applyFieldWrites = useCallback((undoStack: React.MutableRefObject<FieldAction[]>, redoStack: React.MutableRefObject<FieldAction[]>, writes: PerfWrite[], label: string) => {
    const applied: FieldAction["writes"] = [];
    for (const write of writes) {
      const roleDocument = slots[write.role]?.document; if (!roleDocument) continue;
      const before = roleDocument.writeFieldBytes(write.offset, write.bytes);
      if (!before.every((value, i) => value === write.bytes[i])) applied.push({ role: write.role, offset: write.offset, before, after: write.bytes });
    }
    if (applied.length) {
      undoStack.current.push({ label, writes: applied });
      if (undoStack.current.length > 50) undoStack.current.shift();
      redoStack.current = [];
    }
    refresh();
    return applied.length;
  }, [refresh, slots]);
  const applyPerformance = useCallback((writes: PerfWrite[], label: string) => applyFieldWrites(perfUndoRef, perfRedoRef, writes, label), [applyFieldWrites]);
  const applyAudio = useCallback((writes: PerfWrite[], label: string) => applyFieldWrites(audioUndoRef, audioRedoRef, writes, label), [applyFieldWrites]);
  const replayFieldWrites = useCallback((from: React.MutableRefObject<FieldAction[]>, to: React.MutableRefObject<FieldAction[]>, direction: "before" | "after") => {
    const entry = from.current.pop(); if (!entry) return;
    const writes = direction === "before" ? [...entry.writes].reverse() : entry.writes;
    for (const write of writes) slots[write.role]?.document.writeFieldBytes(write.offset, write[direction]);
    to.current.push(entry);
    setStatus(`${direction === "before" ? "Undo" : "Redo"} · ${entry.label}`);
    refresh();
  }, [refresh, slots]);
  const perfUndo = useCallback(() => replayFieldWrites(perfUndoRef, perfRedoRef, "before"), [replayFieldWrites]);
  const perfRedo = useCallback(() => replayFieldWrites(perfRedoRef, perfUndoRef, "after"), [replayFieldWrites]);
  const audioUndo = useCallback(() => replayFieldWrites(audioUndoRef, audioRedoRef, "before"), [replayFieldWrites]);
  const audioRedo = useCallback(() => replayFieldWrites(audioRedoRef, audioUndoRef, "after"), [replayFieldWrites]);
  /** Replays one Mesh Editor action against the documents as they are now. Throws when something
   *  it names is gone — the caller drops the entry and says so rather than half-applying it. */
  const replayMeshAction = useCallback((entry: MeshEditAction, direction: "before" | "after") => {
    const documentFor = (role: VehicleRole) => {
      const roleDocument = slots[role]?.document;
      if (!roleDocument) throw new Error(`the ${roleLabels[role]} PCK is no longer loaded`);
      return roleDocument;
    };
    if (entry.kind === "meshBlob") {
      const documents = entry.targets.map((target) => documentFor(target.role));
      entry.targets.forEach((target, i) => documents[i].restoreState(target[direction]));
      return;
    }
    // Resolve everything before writing anything, so a stale entry fails without a partial replay.
    const standaloneDoc = meshDocs.get(entry.meshName) ?? null;
    const standaloneValue = direction === "before" ? entry.standaloneBefore : entry.after;
    if (entry.kind === "pieceId") {
      const carDocument = documentFor(entry.role);
      const entries = entry.carEntries.map(({ lod, index }) => carDocument.lodMeshes.find((item) => item.lod === lod && item.index === index));
      if (entries.some((item) => !item)) throw new Error(`${entry.meshName}'s LOD rows are no longer in the ${roleLabels[entry.role]} PCK`);
      carDocument.setLodMeshId(entries as LodMeshEntry[], direction === "before" ? entry.carBefore : entry.after, false);
      if (standaloneDoc && standaloneValue !== null) standaloneDoc.setMeshId(standaloneValue, false);
      return;
    }
    const targets = entry.targets.map((target) => {
      const roleDocument = documentFor(target.role);
      return { target, roleDocument, entries: matchLodEntries(entry.meshName, roleDocument).filter((item) => item.meshBlockOffset !== null) };
    });
    if (standaloneDoc && standaloneValue !== null && entry.group >= standaloneDoc.geometry.groupShaderOffsets.length) throw new Error(`${entry.meshName} no longer has material group ${entry.group}`);
    for (const { target, roleDocument, entries } of targets) if (entries.length) roleDocument.setGroupShaderId(entries, entry.group, direction === "before" ? target.before : entry.after, false);
    if (standaloneDoc && standaloneValue !== null) standaloneDoc.setGroupShaderId(entry.group, standaloneValue, false);
  }, [meshDocs, slots]);
  const stepMeshHistory = useCallback((from: React.MutableRefObject<MeshEditAction[]>, to: React.MutableRefObject<MeshEditAction[]>, direction: "before" | "after") => {
    const entry = from.current.pop(); if (!entry) return;
    const verb = direction === "before" ? "Undo" : "Redo";
    try {
      replayMeshAction(entry, direction);
      to.current.push(entry);
      setStatus(`${verb} · ${entry.meshName.replace(/\.mesh\.pck$/i, "")}`);
    } catch (error) {
      setStatus(`${verb} skipped and dropped from the history: ${error instanceof Error ? error.message : "it no longer applies"}`);
    }
    refresh();
  }, [refresh, replayMeshAction]);
  const meshUndo = useCallback(() => stepMeshHistory(pieceIdUndoRef, pieceIdRedoRef, "before"), [stepMeshHistory]);
  const meshRedo = useCallback(() => stepMeshHistory(pieceIdRedoRef, pieceIdUndoRef, "after"), [stepMeshHistory]);
  // meshDocs retains each standalone mesh.pck's bytes (for editing + saving); meshes is the
  // read-only geometry view of it that the rest of the UI already consumes.
  const meshes = useMemo(() => [...meshDocs.values()].map((doc) => doc.geometry), [meshDocs, revision]);
  // The Mesh Editor's baked-in pieces come from the role it is viewing.
  const embeddedOnly = useMemo(() => readEmbeddedOnly(meshDocument, meshDocs), [meshDocument, meshDocs, revision]);
  const meshEditorMeshes = useMemo(() => [...meshes, ...embeddedOnly.pieces], [meshes, embeddedOnly]);
  // The Anchor Editor draws the working PCK's baked-in pieces too — a motorcycle has no loose
  // mesh.pck at all — but only what the car shows up close: no MLOD/LLOD copies (loose or baked in),
  // which share their anchor with the HLOD body and can't be hidden apart from it, and no shadow planes.
  const anchorEmbedded = useMemo(() => document === meshDocument ? embeddedOnly : readEmbeddedOnly(document, meshDocs), [document, meshDocument, embeddedOnly, meshDocs, revision]);
  const anchorMeshes = useMemo(() => [...meshes, ...anchorEmbedded.pieces.filter((mesh) => !isShadowPlane(mesh.name))].filter((mesh) => !isLowLodOnly(mesh, document)), [meshes, anchorEmbedded, document]);
  const exportPieceObj = useCallback(async (mesh: MeshGeometry) => {
    try {
      // Exports what the editor shows, pending edits included: the table ID and each group's
      // resolved shader, the same values the list and chips display.
      const pieceId = resolvePieceId(mesh.name, mesh.meshId, meshDocument).displayId;
      const shaderIds = mesh.groupShaderIds.map((_id, group) => resolveGroupShaderId(mesh.name, group, mesh, meshDocument).displayId);
      const result = exportMeshObj(mesh, pieceId, shaderIds);
      const anchorSlot = roles.map((role) => slots[role]).find(Boolean);
      const folder = objFolder || (anchorSlot ? dirname(anchorSlot.path) : "");
      const path = await saveDialog({ defaultPath: folder ? await join(folder, result.fileName) : result.fileName, filters: [{ name: "Wavefront OBJ", extensions: ["obj"] }] });
      if (!path) return;
      await writeFile(path, new TextEncoder().encode(result.text));
      const uvNote = result.uvZeroedPackets ? ` · ${result.uvZeroedPackets} packet${result.uvZeroedPackets === 1 ? "" : "s"} use an undecoded UV format and were written with zero UVs` : "";
      setStatus(`Exported ${basename(path)} · ${result.triangles.toLocaleString()} tris · ${result.groups} material group${result.groups === 1 ? "" : "s"}${uvNote}`);
    } catch (error) { setStatus(error instanceof Error ? `OBJ export failed · ${error.message}` : "OBJ export failed."); }
  }, [meshDocument, objFolder, slots]);
  const referenceGeometry = useMemo(() => Object.fromEntries(ppfKinds.flatMap((kind) => ppfSlots[kind] ? [[kind, ppfSlots[kind]!.geometry]] : [])) as Partial<Record<PpfKind, PpfGeometry>>, [ppfSlots]);

  const installVehicle = useCallback((nextSlots: VehicleSlots, nextRole: VehicleRole, base: string, message: string) => {
    const nextDocument = nextSlots[nextRole]!.document;
    // Histories name roles, not documents, so a new or reloaded set must not inherit them.
    perfUndoRef.current = []; perfRedoRef.current = []; audioUndoRef.current = []; audioRedoRef.current = []; pieceIdUndoRef.current = []; pieceIdRedoRef.current = [];
    setSlots(nextSlots); setWorkingRole(nextRole); setVehicleBase(base); setSelectedIndices(new Set([0])); setExpanded(new Set(nextDocument.roots)); setSearch(""); setListSearch(""); setStatus(message); setRevision((value) => value + 1);
  }, []);
  // A loose-file tool (the Mod Toolkit) writes straight to disk. When the file it wrote is one this
  // vehicle set holds, the in-memory copy is now stale, and the set's next Save would write it back
  // over the tool's work — so it is reloaded from disk. Tools refuse to open a file the set holds
  // with unsaved edits; if one gained edits in the meantime, it is left alone and the user is told.
  const latestSet = useRef({ slots, meshDocs, workingRole });
  latestSet.current = { slots, meshDocs, workingRole };
  const reloadWrittenFile = useCallback(async (writtenPath: string) => {
    const key = normalizePath(writtenPath);
    const { slots: current, meshDocs: currentMeshDocs, workingRole: currentRole } = latestSet.current;
    const role = roles.find((item) => current[item] && normalizePath(current[item]!.path) === key);
    const meshDoc = role ? null : [...currentMeshDocs.values()].find((doc) => normalizePath(doc.path) === key) ?? null;
    if (!role && !meshDoc) return;
    const name = basename(writtenPath);
    if ((role && current[role]!.document.dirty) || meshDoc?.dirty) {
      setStatus(`${name} was written by a tool while it has unsaved edits in the vehicle set. Saving the set now would overwrite the tool's changes — reload the vehicle set to pick them up.`);
      return;
    }
    try {
      const bytes = await readFile(writtenPath);
      // Undo entries replay onto whatever the set holds, so none may reach back past a file that changed underneath them.
      perfUndoRef.current = []; perfRedoRef.current = []; audioUndoRef.current = []; audioRedoRef.current = []; pieceIdUndoRef.current = []; pieceIdRedoRef.current = [];
      if (role) {
        const document = new PckDocument(current[role]!.document.name, toArrayBuffer(bytes));
        setSlots((previous) => previous[role] && normalizePath(previous[role]!.path) === key ? { ...previous, [role]: { ...previous[role]!, document } } : previous);
        setStatus(`${roleLabels[role]} PCK reloaded · ${name} was just written by one of the Tools`);
      } else if (meshDoc) {
        const carDocument = currentRole ? current[currentRole]?.document : null;
        if (!carDocument) return;
        const document = new MeshPckDocument(meshDoc.path, meshDoc.name, toArrayBuffer(bytes), carDocument);
        setMeshDocs((previous) => { if (previous.get(meshDoc.name) !== meshDoc) return previous; const next = new Map(previous); next.set(meshDoc.name, document); return next; });
        setStatus(`${name} reloaded in the vehicle set · it was just written by one of the Tools`);
      }
      refresh();
    } catch (error) {
      setStatus(`${name} was written by a tool but could not be reloaded here (${error instanceof Error ? error.message : "unknown error"}). Reload the vehicle set before saving it.`);
    }
  }, [refresh]);
  useEffect(() => onFileWritten((path) => { void reloadWrittenFile(path); }), [reloadWrittenFile]);
  const loadEntries = useCallback(async (entries: FileEntry[], preferredName?: string) => {
    if (anySlotDirty && !await confirmDiscard("Discard the unsaved changes and open another vehicle set?")) return;
    try {
      const group = selectVehicleGroup(entries, preferredName); const next = emptySlots();
      await Promise.all(roles.map(async (role) => { const entry = group.entries[role]; if (entry) next[role] = { role, path: entry.path, document: await readDocument(entry.path) }; }));
      const preferredRole = preferredName ? classifyVehicleFile(preferredName)?.role : undefined;
      const nextRole = preferredRole && next[preferredRole] ? preferredRole : roles.find((role) => next[role])!;
      const source = next[nextRole]!.document;
      for (const role of roles) if (next[role] && role !== nextRole) next[role]!.document.assertAnchorCompatibility(source);
      const meshEntries = entries.filter((entry) => isMeshPck(entry.name));
      const parsedMeshes = await Promise.allSettled(meshEntries.map(async (entry) => new MeshPckDocument(entry.path, entry.name, toArrayBuffer(await readFile(entry.path)), source)));
      const docs = parsedMeshes.filter((result): result is PromiseFulfilledResult<MeshPckDocument> => result.status === "fulfilled").map((result) => result.value);
      const failures = parsedMeshes.length - docs.length;
      const nextMeshDocs = new Map(docs.map((doc) => [doc.name, doc]));
      const customizable = hasStockVariants(docs.map((doc) => doc.geometry));
      const defaultVisible = new Set(docs.filter((doc) => doc.geometry.anchorIndex !== null && (doc.geometry.stock || doc.geometry.category === "lodgroup" || !customizable) && !isLowLodOnly(doc.geometry, source) && !isShadowPlane(doc.geometry.name)).map((doc) => doc.geometry.anchorIndex!));
      for (const piece of readEmbeddedOnly(source, nextMeshDocs).pieces) if (piece.anchorIndex !== null && piece.lod === "hlod" && !isShadowPlane(piece.name)) defaultVisible.add(piece.anchorIndex);
      setMeshDocs(nextMeshDocs); setVisibleMeshAnchors(defaultVisible); setMeshErrors(failures);
      const count = roles.filter((role) => next[role]).length;
      installVehicle(next, nextRole, group.base, `${group.base} loaded · ${count}/3 vehicle PCKs · ${docs.length} mesh files${failures ? ` · ${failures} unsupported` : ""}`);
    } catch (error) { setStatus(error instanceof Error ? error.message : "Could not open this vehicle set."); }
  }, [anySlotDirty, installVehicle]);
  const openFiles = useCallback(async () => {
    setMenu(null);
    try {
      const selection = await open({ multiple: true, filters: vehicleFilters });
      const paths = selection ? (Array.isArray(selection) ? selection : [selection]) : [];
      if (paths.length) await loadEntries(paths.map((path) => ({ path, name: basename(path) })), basename(paths[0]));
    } catch (error) { setStatus(error instanceof Error ? error.message : "Could not open those files."); }
  }, [loadEntries]);
  const openVehicleFolderAtPath = useCallback(async (folderPath: string) => {
    try {
      const entries: FileEntry[] = []; await collectDirectory(folderPath, entries);
      await loadEntries(entries);
      setRecentVehicleFolders(pushRecent(VEHICLE_RECENTS_KEY, folderPath));
    } catch (error) { setStatus(error instanceof Error ? error.message : "Could not open that folder."); }
  }, [loadEntries]);
  const openFolder = useCallback(async () => {
    setMenu(null);
    try {
      const selection = await open({ directory: true });
      if (!selection || Array.isArray(selection)) return;
      await openVehicleFolderAtPath(selection);
    } catch (error) { setStatus(error instanceof Error ? error.message : "Could not open that folder."); }
  }, [openVehicleFolderAtPath]);
  const clearVehicleRecents = useCallback(() => { saveRecent(VEHICLE_RECENTS_KEY, []); setRecentVehicleFolders([]); }, []);
  const loadPpf = useCallback(async (kind: PpfKind, path: string) => {
    const bytes = await readFile(path); const name = basename(path);
    const geometry = parseFirstPpfModel(name, toArrayBuffer(bytes), kind);
    setPpfSlots((current) => ({ ...current, [kind]: { path, name, geometry } }));
    return geometry;
  }, []);
  const assignPpf = useCallback(async (kind: PpfKind, path: string) => {
    try {
      const geometry = await loadPpf(kind, path);
      setStatus(`${ppfLabels[kind]} loaded · entry ${geometry.entryIndex} · ${geometry.packets} packets · ${geometry.triangles.toLocaleString()} triangles`);
    } catch (error) { setStatus(error instanceof Error ? error.message : `Could not decode ${ppfLabels[kind]}.`); }
  }, [loadPpf]);
  const choosePpf = useCallback(async (kind: PpfKind) => {
    try {
      const selection = await open({ multiple: false, filters: ppfFilters });
      if (typeof selection === "string") await assignPpf(kind, selection);
    } catch (error) { setStatus(error instanceof Error ? error.message : `Could not open the ${ppfLabels[kind]}.`); }
  }, [assignPpf]);
  const removePpf = useCallback((kind: PpfKind) => {
    setPpfSlots((current) => ({ ...current, [kind]: null }));
    setStatus(`${ppfLabels[kind]} removed from the reference preview`);
  }, []);
  const openPpfFolderAtPath = useCallback(async (folderPath: string) => {
    try {
      const entries = await readDir(folderPath);
      let loaded = 0; let failed = 0;
      for (const entry of entries) {
        if (entry.isDirectory) continue;
        const kind = classifyPpfFile(entry.name);
        if (!kind) continue;
        try { await loadPpf(kind, await join(folderPath, entry.name)); loaded += 1; } catch { failed += 1; }
      }
      setRecentPpfFolders(pushRecent(PPF_RECENTS_KEY, folderPath));
      setStatus(loaded ? `${loaded} PPF file${loaded === 1 ? "" : "s"} loaded from folder${failed ? ` · ${failed} failed to decode` : ""}` : "No exhaust.ppf / rim.ppf / tire.ppf found in that folder.");
    } catch (error) { setStatus(error instanceof Error ? error.message : "Could not open that folder."); }
  }, [loadPpf]);
  const openPpfFolder = useCallback(async () => {
    try {
      const selection = await open({ directory: true });
      if (!selection || Array.isArray(selection)) return;
      await openPpfFolderAtPath(selection);
    } catch (error) { setStatus(error instanceof Error ? error.message : "Could not open that folder."); }
  }, [openPpfFolderAtPath]);
  const clearPpfRecents = useCallback(() => { saveRecent(PPF_RECENTS_KEY, []); setRecentPpfFolders([]); }, []);
  const resizeNav = useCallback((deltaX: number) => { setPanelWidths((current) => ({ ...current, nav: Math.min(PANEL_LIMITS.nav[1], Math.max(PANEL_LIMITS.nav[0], current.nav + deltaX)) })); }, []);
  const resizeEditor = useCallback((deltaX: number) => { setPanelWidths((current) => ({ ...current, editor: Math.min(PANEL_LIMITS.editor[1], Math.max(PANEL_LIMITS.editor[0], current.editor + deltaX)) })); }, []);
  const resizeMeshList = useCallback((deltaX: number) => { setPanelWidths((current) => ({ ...current, meshList: Math.min(PANEL_LIMITS.meshList[1], Math.max(PANEL_LIMITS.meshList[0], current.meshList + deltaX)) })); }, []);
  const changeRimSize = useCallback((value: number) => {
    setRimSizeInches(value);
    setStatus(`Rim and tire reference diameter set to ${value}″ · preview only`);
  }, []);
  const assignSlot = useCallback(async (role: VehicleRole, path: string) => {
    try {
      const nextDocument = await readDocument(path); if (document) nextDocument.assertAnchorCompatibility(document);
      if (slots[role]?.document.dirty && !await confirmDiscard(`Replace the ${roleLabels[role]} PCK and discard its unsaved changes?`)) return;
      const next = { ...slots, [role]: { role, path, document: nextDocument } } as VehicleSlots; const nextRole = workingRole ?? role;
      setSlots(next); setWorkingRole(nextRole); setVehicleBase(vehicleBase || classifyVehicleFile(basename(path))?.base || basename(path)); if (!document) { setSelectedIndices(new Set([0])); setExpanded(new Set(nextDocument.roots)); }
      const inferred = classifyVehicleFile(basename(path))?.role; setStatus(`${basename(path)} assigned to ${roleLabels[role]}${inferred && inferred !== role ? ` · filename looks like ${roleLabels[inferred]}` : ""}`);
    } catch (error) { setStatus(error instanceof Error ? error.message : `Could not assign the ${roleLabels[role]} file.`); }
  }, [document, slots, vehicleBase, workingRole]);
  const chooseSlot = useCallback(async (role: VehicleRole) => {
    try {
      const selection = await open({ multiple: false, filters: [{ name: `MC3 ${roleLabels[role]} PCK / PSPPCK`, extensions: ["pck", "psppck"] }] });
      if (typeof selection === "string") await assignSlot(role, selection);
    } catch (error) { setStatus(`Could not open the ${roleLabels[role]} PCK.`); }
  }, [assignSlot]);
  const switchWorkingFile = useCallback(async (role: VehicleRole) => {
    if (!slots[role] || role === workingRole) return; let next = slots;
    if (document?.dirty) {
      const parts = [document.dirtyIndices.size ? `${document.dirtyIndices.size} unsaved anchor change${document.dirtyIndices.size === 1 ? "" : "s"}` : null, document.dirtyLodKeys.size ? `${document.dirtyLodKeys.size} unsaved piece ID change${document.dirtyLodKeys.size === 1 ? "" : "s"}` : null, document.dirtyShaderKeys.size ? `${document.dirtyShaderKeys.size} unsaved shader ID change${document.dirtyShaderKeys.size === 1 ? "" : "s"}` : null, document.dirtyMeshBlobs.size ? `${document.dirtyMeshBlobs.size} re-embedded piece${document.dirtyMeshBlobs.size === 1 ? "" : "s"}` : null].filter(Boolean);
      if (!await confirmDiscard(`Switching the working PCK will discard the ${parts.join(" and ")} on ${roleLabels[workingRole!]}. Continue?`)) return;
      next = { ...slots, [workingRole!]: { ...slots[workingRole!]!, document: document.resetToSaved() } }; setSlots(next);
    }
    const nextDocument = next[role]!.document; setWorkingRole(role); setSelectedIndices(new Set([0])); setExpanded(new Set(nextDocument.roots)); setSearch(""); setListSearch(""); setStatus(`${roleLabels[role]} is now the working PCK · synchronization still occurs only when saving`);
  }, [document, slots, workingRole]);
  const save = useCallback(async (saveAs = false) => {
    setMenu(null); if (!document || !workingRole) return; const changed = [...document.dirtyIndices]; const prepared = emptySlots(); let writtenCount = 0;
    try {
      for (const role of roles) { const slot = slots[role]; if (!slot) continue; const target = role === workingRole ? document : slot.document.clone(); if (role !== workingRole) target.syncAnchorsFrom(document, changed); prepared[role] = { ...slot, document: target }; }
      // Piece-ID edits can originate from any loaded role — the Mesh Editor's own role selector is
      // independent of the Anchor Editor's working role — so propagate every role's pending
      // piece-ID changes onto every other prepared document, mirroring the anchor sync above.
      let changedLodEntries = 0;
      for (const sourceRole of roles) {
        const sourceSlot = slots[sourceRole]; if (!sourceSlot?.document.dirtyLodKeys.size) continue;
        const keys = [...sourceSlot.document.dirtyLodKeys]; changedLodEntries += keys.length;
        for (const targetRole of roles) {
          if (targetRole === sourceRole || !prepared[targetRole]) continue;
          prepared[targetRole]!.document.syncLodMeshIdsFrom(sourceSlot.document, keys);
        }
      }
      // Shader ID has no LOD-table mirror like piece ID does — it only lives inside each embedded
      // blob's own local material table + the standalone mesh.pck. Editing while viewing a role
      // that doesn't embed the piece (the common case for Player/Opponent) would leave nothing to
      // sync FROM if this copied the piece-ID loop above (PCK-to-PCK by table position). Instead,
      // treat every dirty standalone mesh.pck as ground truth and push its changed groups into
      // every loaded role's embedded copy of that piece — this is what used to require manually
      // re-embedding the piece after editing it (see the Mesh Editor piece/shader ID project memory).
      const dirtyMeshDocs = [...meshDocs.values()].filter((doc) => doc.dirty);
      let syncedShaderEdits = 0;
      const shaderSyncWarnings: string[] = [];
      for (const meshDoc of dirtyMeshDocs) {
        const view = new DataView(meshDoc.bytes.buffer, meshDoc.bytes.byteOffset);
        const savedView = new DataView(meshDoc.savedBytes.buffer, meshDoc.savedBytes.byteOffset);
        const changedGroups = meshDoc.geometry.groupShaderOffsets
          .map((offset, group) => ({ group, changed: view.getUint16(offset, true) !== savedView.getUint16(offset, true) }))
          .filter((entry) => entry.changed)
          .map((entry) => entry.group);
        for (const group of changedGroups) {
          let propagated = false;
          for (const role of roles) {
            const targetSlot = prepared[role]; if (!targetSlot) continue;
            const entries = matchLodEntries(meshDoc.name, targetSlot.document).filter((entry) => entry.meshBlockOffset !== null);
            if (!entries.length) continue;
            try {
              if (targetSlot.document.setGroupShaderId(entries, group, meshDoc.geometry.groupShaderIds[group], false)) propagated = true;
            } catch (error) {
              shaderSyncWarnings.push(`${meshDoc.name} group ${group} on ${roleLabels[role]}: ${error instanceof Error ? error.message : "unknown error"}`);
            }
          }
          if (propagated) syncedShaderEdits += 1;
        }
      }
      // Reclaim space held by dead copies of re-embedded pieces before anything is written, so a
      // file can't keep growing across sessions. Refuses (returns null) on any layout it can't
      // account for, in which case the document is simply saved as-is.
      let reclaimedBytes = 0;
      for (const role of roles) {
        const target = prepared[role]; if (!target) continue;
        try { reclaimedBytes += target.document.compactToolBlocks()?.reclaimedBytes ?? 0; }
        catch (error) { console.warn(`Compaction skipped for ${roleLabels[role]}:`, error); }
      }
      const loaded = roles.filter((role) => prepared[role]); const outputPaths: Partial<Record<VehicleRole, string>> = {};
      if (saveAs) {
        if (loaded.length > 1) {
          const directory = await open({ directory: true });
          if (!directory || Array.isArray(directory)) throw new Error("Save vehicle set as… was cancelled. No files were written.");
          for (const role of loaded) outputPaths[role] = await join(directory, prepared[role]!.document.name);
        } else {
          const role = loaded[0];
          const destination = await saveDialog({ defaultPath: prepared[role]!.document.name, filters: vehicleFilters });
          if (!destination) throw new Error("Save vehicle set as… was cancelled. No files were written.");
          outputPaths[role] = destination;
        }
      } else {
        for (const role of loaded) outputPaths[role] = prepared[role]!.path;
      }
      for (const role of loaded) {
        const path = outputPaths[role]; if (!path) continue;
        const bytes = prepared[role]!.document.bytes;
        await writeFile(path, bytes); writtenCount += 1;
        const actual = await readFile(path);
        if (!sameBytes(bytes, actual)) throw new Error(`${basename(path)} was written, but read-back verification failed. The editor kept the document marked as modified.`);
        prepared[role] = { ...prepared[role]!, path };
      }
      for (const role of loaded) prepared[role]!.document.markSaved(); setSlots(prepared);
      // Standalone mesh.pck files always save back to their own known path — they're reference
      // files alongside the vehicle set, not part of the "Save vehicle set as…" destination choice.
      for (const doc of dirtyMeshDocs) {
        await writeFile(doc.path, doc.bytes); writtenCount += 1;
        const actual = await readFile(doc.path);
        if (!sameBytes(doc.bytes, actual)) throw new Error(`${basename(doc.path)} was written, but read-back verification failed. The editor kept it marked as modified.`);
      }
      for (const doc of dirtyMeshDocs) doc.markSaved();
      refresh();
      const destination = saveAs ? "saved as new files" : "saved over the opened files";
      const pieceIdNote = changedLodEntries ? ` · ${changedLodEntries} piece ID${changedLodEntries === 1 ? "" : "s"} synchronized` : "";
      const shaderNote = syncedShaderEdits ? ` · ${syncedShaderEdits} shader ID${syncedShaderEdits === 1 ? "" : "s"} synchronized to embedded copies` : "";
      const shaderWarnNote = shaderSyncWarnings.length ? ` · ${shaderSyncWarnings.length} shader sync warning${shaderSyncWarnings.length === 1 ? "" : "s"} (see console)` : "";
      const meshNote = dirtyMeshDocs.length ? ` · ${dirtyMeshDocs.length} mesh.pck file${dirtyMeshDocs.length === 1 ? "" : "s"} updated` : "";
      const reclaimNote = reclaimedBytes ? ` · ${sizeLabel(reclaimedBytes)} reclaimed` : "";
      if (shaderSyncWarnings.length) console.warn("Shader sync warnings:", shaderSyncWarnings);
      setStatus(`${loaded.length} vehicle PCK${loaded.length === 1 ? "" : "s"} ${destination} · ${changed.length} changed anchor${changed.length === 1 ? "" : "s"} synchronized on save${pieceIdNote}${shaderNote}${shaderWarnNote}${meshNote}${reclaimNote}`);
    } catch (error) { setStatus(`Save failed${writtenCount ? ` after writing ${writtenCount} file${writtenCount === 1 ? "" : "s"}` : ""}. In-memory edits are intact. ${error instanceof Error ? error.message : ""}`.trim()); }
  }, [document, meshDocs, refresh, slots, workingRole]);
  const closeVehicle = useCallback(async () => { setMenu(null); if (anySlotDirty && !await confirmDiscard("Discard the unsaved changes in this vehicle set?")) return; perfUndoRef.current = []; perfRedoRef.current = []; audioUndoRef.current = []; audioRedoRef.current = []; pieceIdUndoRef.current = []; pieceIdRedoRef.current = []; setSlots(emptySlots()); setMeshDocs(new Map()); setVisibleMeshAnchors(new Set()); setMeshErrors(0); setWorkingRole(null); setVehicleBase(""); setSelectedIndices(new Set([0])); setStatus("Vehicle set closed"); }, [anySlotDirty]);
  const reload = useCallback(async () => {
    setMenu(null); if (!document || !workingRole) return; if (document.dirty && !await confirmDiscard("Reload the vehicle set and discard the unsaved anchor changes?")) return;
    try {
      const next = emptySlots();
      await Promise.all(roles.map(async (role) => { const slot = slots[role]; if (!slot) return; next[role] = { ...slot, document: await readDocument(slot.path) }; }));
      const source = next[workingRole]!.document; for (const role of roles) if (next[role] && role !== workingRole) next[role]!.document.assertAnchorCompatibility(source);
      installVehicle(next, workingRole, vehicleBase, "Vehicle set reloaded from its last saved state");
    } catch (error) { setStatus(error instanceof Error ? error.message : "Could not reload the vehicle set."); }
  }, [document, installVehicle, slots, vehicleBase, workingRole]);

  const selectPiece = useCallback((index: number, modifiers?: { additive?: boolean; range?: boolean }) => {
    if (!document) return;
    setSelectedIndices((current) => {
      if (modifiers?.range) {
        const anchor = [...current].at(-1) ?? index;
        const start = Math.min(anchor, index); const end = Math.max(anchor, index);
        const range: number[] = []; for (let i = start; i <= end; i += 1) range.push(i);
        return new Set([...range.filter((value) => value !== index), index]);
      }
      if (modifiers?.additive) {
        const next = new Set(current);
        if (next.has(index)) { next.delete(index); if (!next.size) next.add(index); } else next.add(index);
        return next;
      }
      return new Set([index]);
    });
    const next = new Set(expanded); let cursor: number | null = index; while (cursor !== null) { next.add(cursor); cursor = document.pieces[cursor].parentIndex; } setExpanded(next);
  }, [document, expanded]);
  const undo = useCallback(() => { if (!document) return; const index = document.undo(); if (index !== null) { selectPiece(index); refresh(); setStatus(`Undo · anchor #${index.toString(16).toUpperCase().padStart(4, "0")}`); } }, [document, refresh, selectPiece]);
  const redo = useCallback(() => { if (!document) return; const index = document.redo(); if (index !== null) { selectPiece(index); refresh(); setStatus(`Redo · anchor #${index.toString(16).toUpperCase().padStart(4, "0")}`); } }, [document, refresh, selectPiece]);
  const copyValues = useCallback(async () => { if (!document) return; try { const piece = document.pieces[selected]; await navigator.clipboard.writeText(formatClipboard(piece.a1, piece.a2)); setStatus(`Copied anchor values from ${piece.name}`); } catch { setStatus("Clipboard access was blocked."); } setMenu(null); }, [document, selected]);
  // Applies to the whole selection, not just the primary anchor — the A1/A2 card buttons
  // (pasteVectorValues) always did, and this shortcut silently touching only one anchor of a
  // multi-selection was a bug.
  const pasteValues = useCallback(async () => {
    if (!document) return;
    try {
      const [a1, a2] = parseClipboard(await navigator.clipboard.readText());
      const indices = [...selectedIndices];
      const changed = document.setAnchorsBatch(indices.map((index) => ({ index, a1, a2 })));
      const label = indices.length > 1 ? `${indices.length} anchors` : document.pieces[indices[0]].name;
      if (!changed) setStatus(`${label} already matches the clipboard values`);
      else { refresh(); setStatus(`Pasted anchor values into ${label}${changed < indices.length ? ` · ${changed} changed` : ""} · preview refreshed`); }
    } catch (error) { setStatus(error instanceof Error ? error.message : "Could not read anchor values from the clipboard."); }
    setMenu(null);
  }, [document, refresh, selectedIndices]);
  const editCoordinate = useCallback((anchor: "a1" | "a2", component: number, value: number, mode: CoordinateChangeMode, startValue?: number) => {
    if (!document || !Number.isFinite(value)) return;
    const indices = [...selectedIndices];
    let changed = false;
    if (mode === "scrub-commit") {
      if (startValue === undefined || Object.is(startValue, value)) return;
      for (const index of indices) document.updateComponent(index, anchor, component, startValue, false);
      for (const index of indices) changed = document.updateComponent(index, anchor, component, value, true) || changed;
    } else {
      for (const index of indices) changed = document.updateComponent(index, anchor, component, value, mode === "commit") || changed;
    }
    if (!changed) return;
    refresh();
    if (mode === "commit" || mode === "scrub-commit") {
      const label = indices.length > 1 ? `${indices.length} anchors` : document.pieces[indices[0]].name;
      setStatus(`${label} ${anchorDisplayLabel[anchor]}.${axes[component]} updated · preview refreshed`);
    }
  }, [document, refresh, selectedIndices]);
  const copyVectorValues = useCallback((anchor: "a1" | "a2") => {
    if (!document) return;
    const piece = document.pieces[selected]; const value: Vec3 = [...piece[anchor]];
    setVectorClipboard({ value, source: `${piece.name} ${anchorDisplayLabel[anchor]}` });
    void navigator.clipboard?.writeText(value.map((item) => item.toFixed(5)).join(" ")).catch(() => undefined);
    setStatus(`Copied ${anchorDisplayLabel[anchor]} values from ${piece.name}`);
  }, [document, selected]);
  const pasteVectorValues = useCallback((anchor: "a1" | "a2") => {
    if (!document || !vectorClipboard) return;
    const indices = [...selectedIndices];
    const changed = document.setAnchorsBatch(indices.map((index) => {
      const piece = document.pieces[index]; const a1: Vec3 = [...piece.a1]; const a2: Vec3 = [...piece.a2];
      const target = anchor === "a1" ? a1 : a2; vectorClipboard.value.forEach((value, component) => { target[component] = value; });
      return { index, a1, a2 };
    }));
    const label = indices.length > 1 ? `${indices.length} anchors` : document.pieces[indices[0]].name;
    if (!changed) { setStatus(`${label} ${anchorDisplayLabel[anchor]} already matches ${vectorClipboard.source}`); return; }
    refresh(); setStatus(`Pasted ${vectorClipboard.source} into ${label} ${anchorDisplayLabel[anchor]} · preview refreshed`);
  }, [document, refresh, selectedIndices, vectorClipboard]);
  const moveSelection = useCallback((moves: { index: number; value: Vec3 }[], mode: "preview" | "scrub-commit", startMoves?: { index: number; value: Vec3 }[]) => {
    if (!document) return;
    let changed = false;
    if (mode === "scrub-commit" && startMoves) {
      // Rewind to where the drag began, then replay the whole move as one recorded batch, so a
      // multi-anchor drag costs one undo step instead of one per anchor.
      for (const move of startMoves) { const piece = document.pieces[move.index]; document.setAnchors(move.index, piece.a1, move.value, false); }
      changed = document.setAnchorsBatch(moves.map((move) => ({ index: move.index, a1: document.pieces[move.index].a1, a2: move.value }))) > 0;
    } else {
      for (const move of moves) { const piece = document.pieces[move.index]; changed = document.setAnchors(move.index, piece.a1, move.value, false) || changed; }
    }
    if (!changed) return;
    refresh();
    if (mode === "scrub-commit") setStatus(`${moves.length} anchor${moves.length === 1 ? "" : "s"} moved · preview refreshed`);
  }, [document, refresh]);
  const mirrorSelection = useCallback(() => {
    if (!document) return;
    const indices = [...selectedIndices];
    const changed = document.setAnchorsBatch(indices.map((index) => {
      const piece = document.pieces[index];
      return { index, a1: [-piece.a1[0], piece.a1[1], piece.a1[2]] as Vec3, a2: [-piece.a2[0], piece.a2[1], piece.a2[2]] as Vec3 };
    }));
    if (!changed) return;
    refresh();
    const label = indices.length > 1 ? `${indices.length} anchors` : document.pieces[indices[0]].name;
    setStatus(`${label} mirrored on X · preview refreshed`);
  }, [document, refresh, selectedIndices]);

  const lightAnchors = useMemo(() => document ? collectLightAnchors(document) : [], [document, revision]);
  const lightSummaries = useMemo(() => summarizeLightAnchors(lightAnchors), [lightAnchors]);
  const fillLightDraft = useCallback((family: LightFamily) => {
    const sample = lightSummaries[family].sample;
    if (!sample) return;
    setLightDrafts((current) => ({ ...current, [family]: sample.map((component) => component.toFixed(5)) as Vec3Draft }));
  }, [lightSummaries]);
  // Relative move: every selected anchor steps from its own current position, unlike the
  // coordinate fields above, which write one absolute value across the whole selection.
  const moveByOffset = useCallback(() => {
    if (!document) return;
    const parsed = offsetDraft.map((text) => text.trim() === "" ? 0 : evaluateFieldInput(text));
    if (parsed.some((component) => component === null)) { setStatus("Offset needs numbers in X, Y and Z — an empty field counts as 0. Nothing was moved."); return; }
    const delta = parsed as number[];
    if (delta.every((component) => component === 0)) { setStatus("Offset is zero — nothing to move."); return; }
    const indices = [...selectedIndices];
    const step = (value: number, component: number) => Math.round((value + delta[component]) * 100000) / 100000;
    const changed = document.setAnchorsBatch(indices.map((index) => {
      const piece = document.pieces[index];
      return { index, a1: piece.a1.map(step) as Vec3, a2: piece.a2.map(step) as Vec3 };
    }));
    const label = indices.length > 1 ? `${indices.length} anchors` : document.pieces[indices[0]].name;
    if (!changed) { setStatus(`${label} did not move`); return; }
    refresh();
    setStatus(`Moved ${label} by ${showVec(delta as Vec3)}${changed < indices.length ? ` · ${changed} changed` : ""} · preview refreshed`);
  }, [document, offsetDraft, refresh, selectedIndices]);

  // One family at a time: each row's Set is its own action and its own undo step, so a wrong rev
  // value can be reverted without losing the tail and brake rows you already applied.
  const applyLightFamily = useCallback((family: LightFamily) => {
    if (!document) return;
    const parsed = lightDrafts[family].map((text) => evaluateFieldInput(text));
    if (parsed.some((component) => component === null)) { setStatus(`${lightFamilyLabels[family]} needs all three of X, Y and Z as numbers. Nothing was changed.`); return; }
    const value = parsed.map((component) => Math.round(component! * 100000) / 100000) as Vec3;
    const moves = planGlobalLightAnchors(lightAnchors, { [family]: value });
    const changed = document.setAnchorsBatch(moves);
    if (!changed) { setStatus(`All ${moves.length} ${family} anchor${moves.length === 1 ? "" : "s"} already match ${showVec(value)}`); return; }
    refresh();
    setStatus(`Set ${family} glow anchors to ${showVec(value)} · ${changed} of ${moves.length} anchor${moves.length === 1 ? "" : "s"} moved, right side mirrored on X · preview refreshed`);
  }, [document, lightAnchors, lightDrafts, refresh]);

  useEffect(() => { const close = (event: MouseEvent) => { if (!menuRef.current?.contains(event.target as Node)) setMenu(null); }; window.addEventListener("mousedown", close); return () => window.removeEventListener("mousedown", close); }, []);
  useEffect(() => { try { localStorage.setItem(PANEL_WIDTHS_KEY, JSON.stringify(panelWidths)); } catch { /* storage unavailable */ } }, [panelWidths]);
  // The webview's own right-click menu (Back, Refresh, Print…) is browser leftovers in a desktop
  // app — Refresh in particular drops every unsaved edit. Text fields keep it for copy and paste.
  useEffect(() => {
    const suppress = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable='true']")) return;
      event.preventDefault();
    };
    window.addEventListener("contextmenu", suppress);
    return () => window.removeEventListener("contextmenu", suppress);
  }, []);
  useEffect(() => {
    // window.beforeunload is a browser API and isn't reliably honored by a native Tauri window's
    // close button — onCloseRequested is the real hook for intercepting the OS close request.
    // window.confirm (blocking browser dialog) deadlocks the webview inside this handler instead
    // of showing anything, so this uses the plugin's async native dialog and awaits it properly.
    // Always preventDefault and close via .destroy() ourselves — relying on "don't call
    // preventDefault to let the default close happen" silently never closed the window at all in
    // this Tauri/WebView2 combo, so this always takes explicit control instead.
    // .destroy() needs core:window:allow-destroy in the capabilities — core:default only grants
    // core:window's read-only getters. Without it the call rejects and, because Tauri only
    // prevent_close()es while a JS listener is registered, unlistening here first would leave the
    // next click closing the window with no prompt at all. So: never unlisten before destroying,
    // and surface a failure instead of losing it in an unhandled rejection.
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    getCurrentWindow().onCloseRequested(async (event) => {
      event.preventDefault();
      if (isoWriting) { await messageDialog("An ISO is being written. Wait for the install to finish before closing the app.", { title: "Install in progress", kind: "warning" }); return; }
      const shouldClose = (!anySlotDirty && !texturesPending) || await confirmDialog("Discard the unsaved changes and close the app?", { title: "Unsaved changes", kind: "warning" });
      if (!shouldClose) return;
      try { await getCurrentWindow().destroy(); }
      catch (error) { setStatus(error instanceof Error ? `Could not close the window: ${error.message}` : "Could not close the window."); }
    }).then((fn) => { cancelled ? fn() : (unlisten = fn); });
    // The registration is async and this effect re-runs whenever the dirty flag flips, so a
    // cleanup can land before the promise resolves — without the flag that listener leaks and
    // keeps preventing the close with a stale `anySlotDirty` captured in its closure.
    return () => { cancelled = true; unlisten?.(); };
  }, [anySlotDirty, texturesPending, isoWriting]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      // Each Mod Toolkit tool binds its own Open and Save against the file it holds; leaving these
      // active underneath would run the vehicle set's versions from a tab that has no vehicle.
      if (workspace === "toolkit" || workspace === "textures" || workspace === "iso") return;
      const pressed = event.key.toLowerCase();
      if (pressed === "o") { event.preventDefault(); void openFiles(); return; }
      if (pressed === "s") { event.preventDefault(); void save(event.shiftKey); return; }
      if (pressed === "z" && !event.shiftKey) { event.preventDefault(); workspace === "mesh" ? meshUndo() : workspace === "performance" ? perfUndo() : workspace === "audio" ? audioUndo() : undo(); return; }
      if (pressed === "y" || (pressed === "z" && event.shiftKey)) { event.preventDefault(); workspace === "mesh" ? meshRedo() : workspace === "performance" ? perfRedo() : workspace === "audio" ? audioRedo() : redo(); return; }
      if (workspace === "anchor" && event.shiftKey && pressed === "c") { event.preventDefault(); void copyValues(); return; }
      if (workspace === "anchor" && event.shiftKey && pressed === "v") { event.preventDefault(); void pasteValues(); return; }
      if (workspace === "anchor" && event.shiftKey && pressed === "m") { event.preventDefault(); mirrorSelection(); }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [audioRedo, audioUndo, copyValues, meshRedo, meshUndo, mirrorSelection, openFiles, pasteValues, perfRedo, perfUndo, redo, save, undo, workspace]);
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type === "enter" || event.payload.type === "over") { setDragging(true); return; }
      if (event.payload.type === "leave") { setDragging(false); return; }
      if (event.payload.type === "drop") {
        setDragging(false);
        // A drop onto the Mod Toolkit belongs to whichever tool is open there — the file types it
        // takes (vs_*.pck, *.carcfg) aren't vehicle set members and would be rejected as such.
        if (workspace === "toolkit") { setToolkitDrop(event.payload.paths); return; }
        if (workspace === "textures") { setTexturesDrop(event.payload.paths); return; }
        if (workspace === "iso") { setIsoDrop(event.payload.paths); return; }
        void collectDroppedPaths(event.payload.paths).then((entries) => entries.length ? loadEntries(entries) : setStatus("No supported vehicle PCKs were found in that drop.")).catch((error) => setStatus(error instanceof Error ? error.message : "Could not read the dropped files."));
      }
    }).then((fn) => { cancelled ? fn() : (unlisten = fn); });
    return () => { cancelled = true; unlisten?.(); };
  }, [loadEntries, workspace]);

  const piece = document?.pieces[selected] ?? null;
  // Shared by the titlebar badge and the status bar so the two can never disagree. Scoped to the
  // working document plus the loose mesh files, matching what the status bar has always counted —
  // a shader edit writes into all three roles, so summing every slot would triple-count it.
  const pendingCount = useMemo(() => document ? document.dirtyIndices.size + document.dirtyLodKeys.size + document.dirtyShaderKeys.size + document.dirtyMeshBlobs.size + document.dirtyFieldKeys.size + [...meshDocs.values()].filter((doc) => doc.dirty).length : 0, [document, meshDocs, revision]);
  const selectedIndicesList = useMemo(() => [...selectedIndices], [selectedIndices]);
  // Handed to the Mod Toolkit so it can refuse to open a file the vehicle set is still holding
  // edits for — the two tabs write through different Saves and must not overlap on one path.
  const dirtyVehiclePaths = useMemo(() => [
    ...roles.map((role) => slots[role]).filter((slot) => slot?.document.dirty).map((slot) => slot!.path),
    ...[...meshDocs.values()].filter((doc) => doc.dirty).map((doc) => doc.path),
  ], [slots, meshDocs, revision]);
  const isVehiclePathBlocked = useCallback((path: string) => {
    const key = normalizePath(path);
    return dirtyVehiclePaths.some((held) => normalizePath(held) === key) ? `${basename(path)} is open in the vehicle set with unsaved changes. Save or close it there first.` : null;
  }, [dirtyVehiclePaths]);
  // An empty offset field is 0, so only a field with unparseable text blocks the move.
  const offsetParsed = useMemo(() => offsetDraft.map((text) => text.trim() === "" ? 0 : evaluateFieldInput(text)), [offsetDraft]);
  const offsetBadAxes = axes.filter((_, component) => offsetParsed[component] === null);
  const offsetReady = offsetBadAxes.length === 0 && offsetParsed.some((component) => component !== 0);
  // Wheels owned by an axle can't be moved on their own; locked only when every selected anchor is one.
  const positionLocked = Boolean(document) && selectedIndicesList.length > 0 && selectedIndicesList.every((index) => document!.wheelFollowers.has(index));
  const mixedPrimary = useMemo(() => document ? (axes.map((_, c) => axisMixed(document, selectedIndicesList, "a2", c)) as [boolean, boolean, boolean]) : ([false, false, false] as [boolean, boolean, boolean]), [document, selectedIndicesList, revision]);
  const mixedSecondary = useMemo(() => document ? (axes.map((_, c) => axisMixed(document, selectedIndicesList, "a1", c)) as [boolean, boolean, boolean]) : ([false, false, false] as [boolean, boolean, boolean]), [document, selectedIndicesList, revision]);
  const treeMatches = useMemo(() => { if (!document || !search.trim()) return []; const query = search.trim().toLowerCase(); return document.pieces.filter((item) => item.name.toLowerCase().includes(query) || item.index.toString().includes(query) || item.index.toString(16).includes(query)); }, [document, search, revision]);
  const listMatches = useMemo(() => { if (!document) return []; const query = listSearch.trim().toLowerCase(); return query ? document.pieces.filter((item) => item.name.toLowerCase().includes(query) || item.index.toString().includes(query) || item.index.toString(16).includes(query)) : document.pieces; }, [document, listSearch, revision]);
  const meshAnchorIndices = useMemo(() => new Set(anchorMeshes.map((mesh) => mesh.anchorIndex).filter((index): index is number => index !== null)), [anchorMeshes]);
  const toggleMeshVisibility = useCallback((index: number) => { setVisibleMeshAnchors((current) => { const next = new Set(current); next.has(index) ? next.delete(index) : next.add(index); return next; }); }, []);

  return <div className="app-shell">
    <header className="titlebar"><div className="brand-mark">{tr("MC3")}</div><div className="brand-copy"><strong>{tr("MC3 Modding Toolkit")}</strong><span>{tr("Midnight Club 3 desktop workspace")}</span></div><nav className="workspace-tabs">{workspaceTabs.map((tab) => <button key={tab.id} className={workspace === tab.id ? "active" : ""} onClick={() => setWorkspace(tab.id)}>{tr(tab.label)}</button>)}</nav><div className="document-title">{workspace === "anchor" ? (document && workingRole ? <><Tx t="{0}{1} · Editing {2}{3}" v={[<span className={document.dirty ? "dirty-dot" : "clean-dot"} />, vehicleBase, roleLabels[workingRole], document.dirty && tr(" — Modified")]} /></> : tr("No vehicle set open")) : workspace === "mesh" ? tr("Meshes") : workspace === "performance" ? tr("Performance") : workspace === "audio" ? tr("Audio") : workspace === "textures" ? tr("Textures") : workspace === "iso" ? tr("ISO Install") : tr("Tools")}</div>{workspace !== "toolkit" && workspace !== "textures" && workspace !== "iso" && document && <div className={`local-badge ${anySlotDirty ? "unsaved" : ""}`} title={anySlotDirty ? tr("Edits are held in memory — nothing on disk has changed yet") : tr("Everything is written to disk")}><span /> {anySlotDirty ? (pendingCount > 0 ? tr(`${pendingCount} pending change${pendingCount === 1 ? "" : "s"}`) : tr("Unsaved changes")) : tr("Saved")}</div>}<div className="language-switch" title={tr("Interface language")}>{(["en", "pt"] as const).map((code) => <button key={code} className={language === code ? "active" : ""} onClick={() => setLanguage(code)}>{code.toUpperCase()}</button>)}</div></header>
    <div className="menubar" ref={menuRef}>
      <div className="menu-wrap"><button className={menu === "file" ? "active" : ""} onClick={() => setMenu(menu === "file" ? null : "file")}>{tr("File")}</button>{menu === "file" && (workspace === "textures" ? <div className="dropdown"><MenuItem shortcut="Ctrl+O" onClick={() => textureAction("open")}>{tr("Open PCK…")}</MenuItem><div className="separator" /><MenuItem shortcut="Ctrl+S" disabled={!textureMenu.current?.dirty} onClick={() => textureAction("save")}>{tr("Save")}</MenuItem><MenuItem shortcut="Ctrl+Shift+S" disabled={!textureMenu.current?.hasFile} onClick={() => textureAction("saveAs")}>{tr("Save as…")}</MenuItem><div className="separator" /><MenuItem disabled={!textureMenu.current?.hasFile} onClick={() => textureAction("close")}>{tr("Close PCK")}</MenuItem></div> : <div className="dropdown"><MenuItem onClick={() => void openFolder()}>{tr("Open vehicle folder…")}</MenuItem><MenuItem shortcut="Ctrl+O" onClick={() => void openFiles()}>{tr("Open PCK file(s)…")}</MenuItem><MenuItem disabled={!document} onClick={() => void reload()}>{tr("Reload vehicle set")}</MenuItem><div className="separator" /><MenuItem shortcut="Ctrl+S" disabled={!document} onClick={() => void save(false)}>{tr("Save vehicle set")}</MenuItem><MenuItem shortcut="Ctrl+Shift+S" disabled={!document} onClick={() => void save(true)}>{tr("Save vehicle set as…")}</MenuItem><div className="separator" /><MenuItem disabled={!document} onClick={() => void closeVehicle()}>{tr("Close vehicle set")}</MenuItem></div>)}</div>
      {workspace === "anchor"
        ? <div className="menu-wrap"><button className={menu === "edit" ? "active" : ""} onClick={() => setMenu(menu === "edit" ? null : "edit")}>{tr("Edit")}</button>{menu === "edit" && <div className="dropdown"><MenuItem shortcut="Ctrl+Z" disabled={!document?.undoStack.length} onClick={undo}>{tr("Undo")}</MenuItem><MenuItem shortcut="Ctrl+Y" disabled={!document?.redoStack.length} onClick={redo}>{tr("Redo")}</MenuItem><div className="separator" /><MenuItem shortcut="Ctrl+Shift+C" disabled={!piece} onClick={() => void copyValues()}>{tr("Copy anchor values")}</MenuItem><MenuItem shortcut="Ctrl+Shift+V" disabled={!piece} onClick={() => void pasteValues()}>{tr("Paste anchor values")}</MenuItem><div className="separator" /><MenuItem shortcut="Ctrl+Shift+M" disabled={!piece} onClick={mirrorSelection}>{tr("Mirror anchors on X")}</MenuItem></div>}</div>
        : workspace === "toolkit" || workspace === "iso" ? null
        : workspace === "textures" ? <div className="menu-wrap"><button className={menu === "edit" ? "active" : ""} onClick={() => setMenu(menu === "edit" ? null : "edit")}>{tr("Edit")}</button>{menu === "edit" && <div className="dropdown"><MenuItem shortcut="Ctrl+Z" disabled={!textureMenu.current?.canUndo} onClick={() => textureAction("undo")}>{tr("Undo")}</MenuItem><MenuItem shortcut="Ctrl+Y" disabled={!textureMenu.current?.canRedo} onClick={() => textureAction("redo")}>{tr("Redo")}</MenuItem></div>}</div>
        : workspace === "performance" ? <div className="menu-wrap"><button className={menu === "edit" ? "active" : ""} onClick={() => setMenu(menu === "edit" ? null : "edit")}>{tr("Edit")}</button>{menu === "edit" && <div className="dropdown"><MenuItem shortcut="Ctrl+Z" disabled={!perfUndoRef.current.length} onClick={perfUndo}>{tr("Undo")}</MenuItem><MenuItem shortcut="Ctrl+Y" disabled={!perfRedoRef.current.length} onClick={perfRedo}>{tr("Redo")}</MenuItem></div>}</div>
        : workspace === "audio" ? <div className="menu-wrap"><button className={menu === "edit" ? "active" : ""} onClick={() => setMenu(menu === "edit" ? null : "edit")}>{tr("Edit")}</button>{menu === "edit" && <div className="dropdown"><MenuItem shortcut="Ctrl+Z" disabled={!audioUndoRef.current.length} onClick={audioUndo}>{tr("Undo")}</MenuItem><MenuItem shortcut="Ctrl+Y" disabled={!audioRedoRef.current.length} onClick={audioRedo}>{tr("Redo")}</MenuItem></div>}</div>
        : <div className="menu-wrap"><button className={menu === "edit" ? "active" : ""} onClick={() => setMenu(menu === "edit" ? null : "edit")}>{tr("Edit")}</button>{menu === "edit" && <div className="dropdown"><MenuItem shortcut="Ctrl+Z" disabled={!pieceIdUndoRef.current.length} onClick={meshUndo}>{tr("Undo")}</MenuItem><MenuItem shortcut="Ctrl+Y" disabled={!pieceIdRedoRef.current.length} onClick={meshRedo}>{tr("Redo")}</MenuItem></div>}</div>}
      <div className="menu-wrap"><button className={menu === "help" ? "active" : ""} onClick={() => setMenu(menu === "help" ? null : "help")}>{tr("Help")}</button>{menu === "help" && <div className="dropdown compact"><MenuItem onClick={() => { setShowAbout(true); setMenu(null); }}>{tr("About")}</MenuItem></div>}</div>
    </div>

    {workspace === "anchor" && (!document ? <main className="welcome"><div className={`drop-card ${dragging ? "dragging" : ""}`}><div className="file-glyph"><span>{tr("PCK×3")}</span></div><p className="eyebrow">{tr("VEHICLE ANCHOR WORKSPACE")}</p><h1><Tx t="Open the vehicle folder.{0}Edit the whole PCK set." v={[<br />]} /></h1><p className="welcome-copy">{tr("Player, Garage and Opponent are detected as one set. Standalone mesh.pck geometry from the folder is decoded locally for a live solid-color preview.")}</p><div className="welcome-actions"><button className="primary" onClick={() => void openFolder()}>{tr("Open vehicle folder")}</button><button className="secondary" onClick={() => void openFiles()}>{tr("Open PCK file(s)")}</button></div><p className="drop-hint">{tr("or drag and drop the complete vehicle folder")}</p>{recentVehicleFolders.length > 0 && <div className="recent-folders"><div className="recent-folders-heading"><span>{tr("Recent folders")}</span><button className="link-button" onClick={clearVehicleRecents}>{tr("Clear list")}</button></div><div className="recent-folders-list">{recentVehicleFolders.map((path) => <button key={path} className="recent-folder-item" title={path} onClick={() => void openVehicleFolderAtPath(path)}>{basename(path)}</button>)}</div></div>}<div className="capability-row"><span><Tx t="Set {0}" v={[<b>{tr("Player · Garage · Opponent")}</b>]} /></span><span><Tx t="Preview {0}" v={[<b>{tr("External mesh.pck geometry")}</b>]} /></span><span><Tx t="Save {0}" v={[<b>{tr("Deferred synchronization")}</b>]} /></span></div></div></main> : <main className="workspace" style={{ "--nav-width": `${panelWidths.nav}px`, "--editor-width": `${panelWidths.editor}px` } as React.CSSProperties}>
      <section className="vehicle-set-bar"><div className="set-summary"><p className="eyebrow">{tr("VEHICLE SET")}</p><strong>{vehicleBase}</strong><span><Tx t="{0}/3 files ready · sync on save" v={[loadedCount]} /></span></div><div className="vehicle-slots">{roles.map((role) => { const slot = slots[role]; const active = role === workingRole; return <article key={role} className={`vehicle-slot ${active ? "working" : ""} ${slot ? "loaded" : "missing"}`}><div className="slot-heading"><span>{tr(roleLabels[role])}</span><em>{active ? tr("WORKING") : slot ? tr("READY") : tr("MISSING")}</em></div><strong title={slot?.path}>{slot?.document.name ?? tr(`Select ${roleLabels[role]} PCK`)}</strong><small className={slot?.document.dirty ? "size-pending" : ""} title={slot?.document.dirty ? tr("Size this file will have once saved — it still holds the old contents on disk") : undefined}>{slot ? `${slot.document.format.toUpperCase()} · ${pendingSizeLabel(slot.document)}` : tr("Manual file slot")}</small><div className="slot-actions">{slot && <button disabled={active} onClick={() => void switchWorkingFile(role)}>{active ? tr("Editing here") : tr("Edit this")}</button>}<button onClick={() => void chooseSlot(role)}>{slot ? tr("Replace…") : tr("Browse…")}</button></div></article>; })}</div><button className="folder-button" onClick={() => void openFolder()}>{tr("Open folder…")}</button></section>
      <section className="reference-geometry-bar"><div className="reference-summary"><p className="eyebrow">{tr("REFERENCE GEOMETRY")}</p><span>{tr("First drawable model · preview only")}</span><div className="reference-summary-actions"><button className="folder-button" onClick={() => void openPpfFolder()}>{tr("Open PPF folder…")}</button><RecentMenu recents={recentPpfFolders} onOpen={(path) => void openPpfFolderAtPath(path)} onClear={clearPpfRecents} /></div></div><div className="reference-slots">{ppfKinds.map((kind) => { const slot = ppfSlots[kind]; const wheelReference = kind === "rim" || kind === "tire"; return <article key={kind} className={`reference-slot ${slot ? "loaded" : "missing"} ${wheelReference ? "wheel-reference" : ""}`}><div><strong>{tr(ppfLabels[kind])}</strong><em>{slot ? tr("READY") : tr("OPTIONAL")}</em></div><span title={slot?.path}>{slot?.name ?? tr(`Select ${kind}.ppf`)}</span><small>{slot ? tr(`Entry ${slot.geometry.entryIndex} · ${slot.geometry.triangles.toLocaleString()} tris`) : kind === "exhaust" ? tr(`${document.exhaustLinks.size} exhaust anchors`) : tr(`${document.wheelLinks.size} wheel anchors`)}</small><div className="reference-slot-actions">{wheelReference && <select className="rim-size-select" value={rimSizeInches} onChange={(event) => changeRimSize(Number(event.target.value))} title={tr("Reference rim diameter")} aria-label={tr("Reference rim diameter")}>{rimSizeOptions.map((size) => <option key={size} value={size}>{size}″</option>)}</select>}<button onClick={() => choosePpf(kind)}>{tr("Browse")}</button>{slot && <button className="remove" onClick={() => removePpf(kind)}>{tr("Clear")}</button>}</div></article>; })}</div></section>
      <aside className="navigator combined-navigator">
        <div className="navigator-tabs"><button className={navigatorTab === "tree" ? "active" : ""} onClick={() => setNavigatorTab("tree")}><Tx t="{0}Navigator" v={[<span>01</span>]} /></button><button className={navigatorTab === "list" ? "active" : ""} onClick={() => setNavigatorTab("list")}><Tx t="{0}Anchor list" v={[<span>02</span>]} /></button><em>{document.pieces.length}</em></div>
        {navigatorTab === "tree" ? <>
          <div className="search"><span>⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={tr("Name, ID or index…")} /><kbd>/</kbd></div>
          <div className="tree-actions"><button onClick={() => setExpanded(new Set(document.pieces.map((item) => item.index)))}>{tr("Expand all")}</button><button onClick={() => setExpanded(new Set(document.roots))}>{tr("Collapse all")}</button></div>
          <div className="tree-scroll">{search.trim() ? treeMatches.map((item) => <div key={item.index} className={`search-result-row ${selectedIndices.has(item.index) ? "selected" : ""}`}><button className="search-result" onClick={(event) => selectPiece(item.index, { additive: event.ctrlKey || event.metaKey, range: event.shiftKey })}><span>{item.name}</span><small>#{hex(item.index, 4)}</small></button><MeshVisibilityButton index={item.index} available={meshAnchorIndices.has(item.index)} visible={visibleMeshAnchors.has(item.index)} onToggle={toggleMeshVisibility} /></div>) : document.roots.map((root) => <TreeRow key={root} document={document} index={root} selectedIndices={selectedIndices} expanded={expanded} meshAnchors={meshAnchorIndices} visibleAnchors={visibleMeshAnchors} onSelect={selectPiece} onToggle={(index) => { const next = new Set(expanded); next.has(index) ? next.delete(index) : next.add(index); setExpanded(next); }} onToggleVisibility={toggleMeshVisibility} />)}</div>
        </> : <>
          <div className="search"><span>⌕</span><input value={listSearch} onChange={(event) => setListSearch(event.target.value)} placeholder={tr("Filter flat list…")} /></div>
          <div className="flat-list-caption">{tr("File order · no hierarchy")}</div>
          <div className="tree-scroll flat-list-scroll">{listMatches.map((item) => <div key={item.index} className={`flat-anchor-row ${selectedIndices.has(item.index) ? "selected" : ""}`}><button className="flat-anchor-main" onClick={(event) => selectPiece(item.index, { additive: event.ctrlKey || event.metaKey, range: event.shiftKey })}><span className="flat-index">{item.index.toString(16).toUpperCase().padStart(4, "0")}</span><span className="flat-name">{item.name}</span></button><MeshVisibilityButton index={item.index} available={meshAnchorIndices.has(item.index)} visible={visibleMeshAnchors.has(item.index)} onToggle={toggleMeshVisibility} /></div>)}</div>
        </>}
        <div className="navigator-footer"><span>{navigatorTab === "tree" ? tr("Hierarchy") : tr("Sequential")}</span><span><Tx t="{0} shown" v={[navigatorTab === "tree" ? document.pieces.length : listMatches.length]} /></span><span><Tx t="{0} edited" v={[document.dirtyIndices.size]} /></span></div>
      </aside>
      <ResizeHandle variant="resize-nav" onDrag={resizeNav} />
      {piece && <section className="editor-pane">
        <div className="editor-header"><div><p className="eyebrow"><Tx t="ANCHOR #{0}{1}" v={[piece.index.toString(16).toUpperCase().padStart(4, "0"), selectedIndices.size > 1 && tr(` · ${selectedIndices.size} SELECTED`)]} /></p><h2>{piece.name}</h2><div className="chips"><span><Tx t="{0} source" v={[roleLabels[workingRole!]]} /></span><span><Tx t="File {0}" v={[hex(piece.fileOffset)]} /></span>{document.dirtyIndices.has(piece.index) && <span className="modified-chip">{tr("Pending for set")}</span>}</div></div><div className="editor-buttons"><button disabled={!document.undoStack.length} onClick={undo}>{tr("↶ Undo")}</button><button disabled={!document.redoStack.length} onClick={redo}>{tr("↷ Redo")}</button></div></div>
        <div className="editor-scroll">
          <div className="sync-notice"><strong>{tr("Deferred set sync")}</strong><span><Tx t="Editing {0}. Save applies {1} changed anchor{2} to {3} loaded PCK{4}." v={[roleLabels[workingRole!], document.dirtyIndices.size, document.dirtyIndices.size === 1 ? "" : "s", loadedCount, loadedCount === 1 ? "" : "s"]} /></span></div>
          <div className="toggle-stack">
            <TogglePanel title={tr("Position anchors")} meta={selectedIndices.size === 1 ? "1 anchor" : `${selectedIndices.size} anchors`} open={detailOpen.position} onToggle={() => setDetailOpen((value) => ({ ...value, position: !value.position }))}>
              <div className="panel-pad">
                <div className="panel-actions panel-actions-end"><button className="mirror-button" disabled={positionLocked} onClick={mirrorSelection} title={tr("Flip the X position of the selected anchor(s) · Ctrl+Shift+M")}>{tr("Mirror")}</button></div>
                <div className="vector-stack vertical"><VecEditor label="A1 · Primary position" value={piece.a2} mixed={mixedPrimary} locked={positionLocked} canPaste={Boolean(vectorClipboard)} onCopy={() => copyVectorValues("a2")} onPaste={() => pasteVectorValues("a2")} onChange={(component, value, mode, startValue) => editCoordinate("a2", component, value, mode, startValue)} /><VecEditor label="A2 · Secondary position" value={piece.a1} mixed={mixedSecondary} locked={positionLocked} canPaste={Boolean(vectorClipboard)} onCopy={() => copyVectorValues("a1")} onPaste={() => pasteVectorValues("a1")} onChange={(component, value, mode, startValue) => editCoordinate("a1", component, value, mode, startValue)} /></div>
                {document.runtimeFor(selected).length > 0 && <div className="runtime-callout"><strong>{tr("Runtime-linked anchor")}</strong>{document.runtimeFor(selected).map((line) => <span key={line}>{tr(line)}</span>)}<p>{document.wheelFollowers.has(selected) ? tr("This wheel's position is owned by its axle. Move the axle — it writes the wheel runtime table and this wheel's position together.") : tr("Each target PCK updates its own validated runtime position table during save synchronization.")}</p></div>}
              </div>
            </TogglePanel>
            <TogglePanel title={tr("Offset")} meta={selectedIndices.size === 1 ? "1 anchor" : `${selectedIndices.size} anchors`} open={detailOpen.offset} onToggle={() => setDetailOpen((value) => ({ ...value, offset: !value.offset }))}>
              <div className="panel-pad">
                <p className="light-intro"><Tx t="Adds this to the current position of every selected anchor — a relative step, not an absolute value, applied to A1 and A2 alike. The fields keep their values after {0}, so clicking again steps by the same amount." v={[<strong>{tr("Move")}</strong>]} /></p>
                <div className="vector-grid">{axes.map((axis, component) => <label key={axis}><span>{axis}</span><input type="text" inputMode="decimal" value={offsetDraft[component]} placeholder="0" onChange={(event) => setOffsetDraft((current) => { const next = [...current] as Vec3Draft; next[component] = event.target.value; return next; })} aria-label={tr(`Offset ${axis}`)} /></label>)}</div>
                <div className="panel-actions">
                  <small className={offsetBadAxes.length ? "light-row-warn" : ""}>{offsetBadAxes.length ? tr(`Not a number: ${offsetBadAxes.join(", ")}`) : tr("An empty field counts as 0")}</small>
                  <div className="panel-actions-group">
                    <button className="link-button" onClick={() => setOffsetDraft(["", "", ""])}>{tr("Clear")}</button>
                    <button className="mirror-button" disabled={!offsetReady} onClick={moveByOffset} title={offsetReady ? tr(`Move the selected anchor(s) by this amount`) : tr("Enter a non-zero offset first")}>{tr("Move")}</button>
                  </div>
                </div>
              </div>
            </TogglePanel>
            <TogglePanel title={tr("Global light anchors")} meta={`${lightAnchors.length} tail / rev / brake`} open={detailOpen.lights} onToggle={() => setDetailOpen((value) => ({ ...value, lights: !value.lights }))}>
              <div className="light-panel">
                <p className="light-intro"><Tx t="Type the {0} position and press {1} on that row. It is written to every taillight variant — the right side gets the same value with X flipped, and A1 and A2 both receive it. Each row is its own undo step." v={[<strong>{tr("left-hand")}</strong>, <strong>{tr("Set")}</strong>]} /></p>
                {lightFamilies.map((family) => <LightAnchorRow key={family} summary={lightSummaries[family]} draft={lightDrafts[family]} onChange={(component, text) => setLightDrafts((current) => { const next = [...current[family]] as Vec3Draft; next[component] = text; return { ...current, [family]: next }; })} onFill={() => fillLightDraft(family)} onApply={() => applyLightFamily(family)} />)}
                <div className="light-actions">
                  <button className="link-button" onClick={() => setLightDrafts(emptyLightDrafts())}>{tr("Clear all")}</button>
                </div>
              </div>
            </TogglePanel>
            <TogglePanel title={tr("Hierarchy links")} meta="parent / child / next" open={detailOpen.hierarchy} onToggle={() => setDetailOpen((value) => ({ ...value, hierarchy: !value.hierarchy }))}>{[["Parent", piece.parentIndex], ["Child", piece.childIndex], ["Next", piece.nextIndex]].map(([label, index]) => <div className="link-row" key={label as string}><span>{label}</span>{typeof index === "number" ? <button onClick={() => selectPiece(index)}>{document.pieces[index].name}<small>#{hex(index, 4)}</small></button> : <em>{tr("NULL")}</em>}</div>)}</TogglePanel>
            <TogglePanel title={tr("Binary inspector")} meta={`${hex(document.layout.itemSize, 2)} bytes`} open={detailOpen.binary} onToggle={() => setDetailOpen((value) => ({ ...value, binary: !value.binary }))}><pre className="binary-dump">{document.pieceHex(selected)}</pre></TogglePanel>
            <TogglePanel title={tr("Document diagnostics")} meta={hex(document.pointerBase)} open={detailOpen.diagnostics} onToggle={() => setDetailOpen((value) => ({ ...value, diagnostics: !value.diagnostics }))}><div className="diagnostic-grid"><span>{tr("Pointer base")}</span><code>{hex(document.pointerBase)}</code><span>{tr("Table pointer")}</span><code>{hex(document.layout.listPointer)}</code><span>{tr("Entry size")}</span><code>{hex(document.layout.itemSize, 2)}</code><span>{tr("Mesh files")}</span><code>{meshes.length} loaded{meshErrors ? tr(` / ${meshErrors} skipped`) : ""}</code></div>{document.runtimeNotes.map((note) => <p className="diagnostic-note" key={tr(note)}>{tr(note)}</p>)}</TogglePanel>
          </div>
        </div>
      </section>}
      <ResizeHandle variant="resize-editor" onDrag={resizeEditor} />
      <MeshViewer document={document} selected={selected} multiSelected={selectedIndices} meshes={anchorMeshes} visibleAnchors={visibleMeshAnchors} referenceGeometry={referenceGeometry} rimSizeInches={rimSizeInches} revision={revision} onMoveSelection={moveSelection} />
    </main>)}
    {workspace === "mesh" && <div className="mesh-editor-shell"><MeshEditorWorkspace document={meshDocument} activeRole={meshRole} slots={slots} onSelectRole={setMeshViewRole} meshes={meshEditorMeshes} onEditPieceId={editPieceId} onEditGroupShader={editGroupShader} onUpdateEmbedded={updateEmbeddedMesh} onUpdateAllEmbedded={updateAllEmbeddedMeshes} onConvertObjs={() => void chooseObjFolder()} zeroShellId={zeroShellId} onSetZeroShellId={setZeroShellId} onExportObj={(mesh) => void exportPieceObj(mesh)} embeddedUnreadable={embeddedOnly.unreadable} objFolder={objFolder} describeEmbedTarget={describeEmbedTarget} describePieceSize={describePieceSize} onUndo={meshUndo} onRedo={meshRedo} canUndo={pieceIdUndoRef.current.length > 0} canRedo={pieceIdRedoRef.current.length > 0} vehicleBase={vehicleBase} loadedCount={loadedCount} onOpenFolder={() => void openFolder()} recentVehicleFolders={recentVehicleFolders} onOpenRecentFolder={(path) => void openVehicleFolderAtPath(path)} onClearRecentFolders={clearVehicleRecents} listWidth={panelWidths.meshList} onResizeList={resizeMeshList} /></div>}
    {workspace === "performance" && <PerformanceWorkspace slots={slots} workingRole={workingRole} vehicleBase={vehicleBase} loadedCount={loadedCount} revision={revision} onApply={applyPerformance} onStatus={setStatus} onOpenFolder={() => void openFolder()} recentVehicleFolders={recentVehicleFolders} onOpenRecentFolder={(path) => void openVehicleFolderAtPath(path)} onClearRecentFolders={clearVehicleRecents} />}
    {workspace === "audio" && <AudioWorkspace slots={slots} workingRole={workingRole} vehicleBase={vehicleBase} loadedCount={loadedCount} revision={revision} onApply={applyAudio} onStatus={setStatus} onOpenFolder={() => void openFolder()} recentVehicleFolders={recentVehicleFolders} onOpenRecentFolder={(path) => void openVehicleFolderAtPath(path)} onClearRecentFolders={clearVehicleRecents} />}
    <div className="workspace-host" style={{ display: workspace === "textures" ? "contents" : "none" }}><TextureWorkspace active={workspace === "textures"} dropped={texturesDrop} onConsumeDrop={() => setTexturesDrop(null)} onStatus={setStatus} isPathBlocked={isVehiclePathBlocked} onPendingChange={setTexturesPending} menuRef={textureMenu} /></div>
    {workspace === "iso" && <IsoInstallWorkspace dropped={isoDrop} onConsumeDrop={() => setIsoDrop(null)} onStatus={setStatus} onBusyChange={setIsoWriting} />}
    {workspace === "toolkit" && <ModToolkitWorkspace onStatus={setStatus} dirtyVehiclePaths={dirtyVehiclePaths} dropped={toolkitDrop} onConsumeDrop={() => setToolkitDrop(null)} onBusyChange={setIsoWriting} />}
    <footer className="statusbar"><div><span className="status-light" />{tr(status)}</div><div>{workspace === "toolkit" ? tr("Loose files · each tool saves over the file it opened") : workspace === "iso" ? tr("Writes into the opened ISO · make a backup first") : workspace === "textures" ? tr("Loose file · saves over the PCK it opened") : document ? tr(`${loadedCount}/3 PCKs · ${roleLabels[workingRole!]} working · ${anySlotDirty ? `${pendingCount} pending change${pendingCount === 1 ? "" : "s"}` : "Saved state"}`) : tr("Open a vehicle folder to begin")}</div></footer>
    {dragging && <div className="drop-overlay"><div>{workspace === "textures" ? <><strong>{tr("Drop a PCK")}</strong><span>{tr("Car or Flash/UI PCK — it opens here and is scanned for textures")}</span></> : workspace === "iso" ? <><strong>{tr("Drop an ISO or mod ZIPs")}</strong><span>{tr("An .iso opens as the target; ZIPs and folders are added as car mods")}</span></> : workspace === "toolkit" ? <><strong>{tr("Drop a file for this tool")}</strong><span>{tr("The active tool takes the file types it supports")}</span></> : <><strong>{tr("Drop vehicle folder")}</strong><span>{tr("The PCK set and external mesh geometry will be loaded together")}</span></>}</div></div>}
    {showAbout && <AboutDialog onClose={() => setShowAbout(false)} />}
  </div>;
}
