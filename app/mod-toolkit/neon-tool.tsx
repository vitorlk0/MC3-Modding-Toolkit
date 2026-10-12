import { tr, Tx } from "../i18n";
import { useCallback, useEffect, useMemo, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { readDir, readFile } from "@tauri-apps/plugin-fs";
import { PckDocument } from "../../src/pck";
import { anchorWorldPosition, isShadowPlane, isShellFamily, parseEmbeddedMesh, parseMeshPck, type MeshGeometry } from "../../src/mesh";
import {
  applyNeonShadow, cagePivot, IDENTITY_TRANSFORM, isIdentity, readNeonShadow, shadowPivot, transformXZ,
  type NeonShadowResult, type NeonShadowSetup, type NeonShadowTransform,
} from "../../src/neon-shadow";
import { basename, findCarFiles, listMeshPcks, parentPath, readToolkitFile, writeVerified, type CarRole, type ToolkitFile } from "./toolkit-io";
import { RecentList } from "./toolkit-ui";
import { loadRecent, pushRecent, saveRecent } from "../recent-paths";

/**
 * Neon & Shadow — resizes a car's colored neon (the BodyBounds cage it is projected from) and its
 * dark ground shadow (the embedded neonglow/shadow piece), in the three PCKs together.
 *
 * The bytes come from `src/neon-shadow.ts`; this file only shows the car from above and saves.
 * Nothing is written before Save, and every Save recomputes each PCK from the bytes it was opened
 * with plus the current values, so putting the values back to 100% / 0 reproduces the files.
 */

const RECENTS_KEY = "mc3pae.recentNeonFolders";
const ORIGIN = [0, 0, 0] as const;
type Loaded = ToolkitFile & { role: CarRole; label: string; setup: NeonShadowSetup };
type XZ = [number, number];
type Car = { folder: string; base: string; files: Loaded[]; body: XZ[]; bodyNote: string };
type Target = "neon" | "shadow";

/** Andrew's monotone chain: the outline of a point cloud seen from above. */
function hull(points: XZ[]): XZ[] {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (sorted.length < 3) return sorted;
  const cross = (o: XZ, a: XZ, b: XZ) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: XZ[] = [], upper: XZ[] = [];
  for (const p of sorted) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
  for (const p of [...sorted].reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

const box = (points: XZ[]) => {
  const xs = points.map((p) => p[0]), zs = points.map((p) => p[1]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) };
};
const size = (points: XZ[]) => { const b = box(points); return { width: b.maxX - b.minX, length: b.maxZ - b.minZ, centerZ: (b.minZ + b.maxZ) / 2 }; };

function geometryXZ(geometry: MeshGeometry, offset: readonly number[]): XZ[] {
  const out: XZ[] = [];
  for (let i = 0; i < geometry.positions.length; i += 3) out.push([geometry.positions[i] + offset[0], geometry.positions[i + 2] + offset[2]]);
  return out;
}

/** The car body seen from above: the HLOD shell pieces, embedded or loose, placed at their anchors. */
async function readBody(folder: string, file: Loaded): Promise<{ body: XZ[]; bodyNote: string }> {
  const document = new PckDocument(file.name, file.bytes.slice().buffer as ArrayBuffer);
  const points: XZ[] = [];
  const used: string[] = [];
  const isBody = (name: string) => isShellFamily(name) && !isShadowPlane(name);
  const place = (geometry: MeshGeometry) => {
    const offset = geometry.anchorIndex === null ? [0, 0, 0] : anchorWorldPosition(document, geometry.anchorIndex, "a2");
    points.push(...geometryXZ(geometry, offset));
    used.push(geometry.name);
  };
  const rows = document.lodMeshes.filter((entry) => entry.lod === "hlod" && isBody(entry.name));
  for (const entry of rows.filter((row) => row.meshBlockOffset !== null)) {
    try { place(parseEmbeddedMesh(entry, document)); } catch { /* an unreadable piece just isn't drawn */ }
  }
  const loose = new Map(rows.filter((row) => row.meshBlockOffset === null).map((row) => [`${row.name}.pck`.toLowerCase(), row.name]));
  if (loose.size) {
    for (const path of await listMeshPcks(folder)) {
      if (!loose.has(basename(path).toLowerCase())) continue;
      try { const bytes = await readFile(path); place(parseMeshPck(basename(path), bytes.slice().buffer as ArrayBuffer, document)); } catch { /* not drawn */ }
    }
  }
  return { body: points.length ? hull(points) : [], bodyNote: used.length ? `Body outline from ${used.length} shell piece${used.length === 1 ? "" : "s"} of the ${file.label} PCK.` : "No shell piece could be read, so the body outline isn't drawn." };
}

const percent = (value: number) => `${Math.round(value * 1000) / 10}`;
const meters = (value: number) => value.toFixed(2);

function TransformFields({ label, value, disabled, onChange }: { label: string; value: NeonShadowTransform; disabled: boolean; onChange: (next: NeonShadowTransform) => void }) {
  const field = (key: keyof NeonShadowTransform, text: string, unit: string, slider: [number, number, number]) => {
    const shown = key === "offsetZ" ? meters(value[key]) : percent(value[key]);
    const commit = (raw: string) => {
      const number = Number(raw.replace(",", "."));
      if (!Number.isFinite(number)) return;
      onChange({ ...value, [key]: key === "offsetZ" ? number : number / 100 });
    };
    return <label className="neon-field">
      <span>{tr(text)}</span>
      <div>
        <input type="range" min={slider[0]} max={slider[1]} step={slider[2]} value={key === "offsetZ" ? value[key] : value[key] * 100} disabled={disabled} onChange={(event) => commit(event.target.value)} aria-label={`${label} · ${tr(text)}`} />
        <input type="number" key={shown} defaultValue={shown} step={key === "offsetZ" ? 0.01 : 1} disabled={disabled} onBlur={(event) => commit(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") commit((event.target as HTMLInputElement).value); }} />
        <em>{unit}</em>
      </div>
    </label>;
  };
  return <div className="neon-fields">
    {field("scaleX", "Width", "%", [50, 200, 1])}
    {field("scaleZ", "Length", "%", [50, 200, 1])}
    {field("offsetZ", "Shift back (+) / forward (−)", "m", [-1, 1, 0.01])}
  </div>;
}

/** Top view: front of the car at the top (−Z), driver's left on the left (−X). `cage`/`shadow` are
 *  the outlines before the change, drawn dashed only while something changed. */
function TopView({ body, cage, cageNew, shadow, shadowNew }: { body: XZ[]; cage: XZ[]; cageNew: XZ[]; shadow: XZ[]; shadowNew: XZ[] }) {
  const all = [...body, ...cage, ...cageNew, ...shadow, ...shadowNew];
  if (!all.length) return null;
  const b = box(all);
  const margin = 0.35;
  const view = { x: b.minX - margin, y: b.minZ - margin, w: b.maxX - b.minX + margin * 2, h: b.maxZ - b.minZ + margin * 2 };
  const path = (points: XZ[]) => points.length ? `M${points.map((p) => `${p[0].toFixed(4)},${p[1].toFixed(4)}`).join("L")}Z` : "";
  const grid: number[] = [];
  for (let v = Math.ceil(view.y); v <= view.y + view.h; v += 1) grid.push(v);
  const gridX: number[] = [];
  for (let v = Math.ceil(view.x); v <= view.x + view.w; v += 1) gridX.push(v);
  return <svg className="neon-view" viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label={tr("Car seen from above")}>
    {grid.map((z) => <line key={`z${z}`} x1={view.x} x2={view.x + view.w} y1={z} y2={z} className="neon-grid" />)}
    {gridX.map((x) => <line key={`x${x}`} y1={view.y} y2={view.y + view.h} x1={x} x2={x} className="neon-grid" />)}
    <line x1={0} x2={0} y1={view.y} y2={view.y + view.h} className="neon-axis" />
    {shadowNew.length > 0 && <path d={path(shadowNew)} className="neon-shadow-new" />}
    {shadow.length > 0 && <path d={path(shadow)} className="neon-shadow-old" />}
    {body.length > 0 && <path d={path(body)} className="neon-body" />}
    {cageNew.length > 0 && <path d={path(cageNew)} className="neon-cage-new" />}
    {cage.length > 0 && <path d={path(cage)} className="neon-cage-old" />}
    <text x={view.x + view.w / 2} y={view.y + 0.22} className="neon-label">{tr("FRONT")}</text>
  </svg>;
}

export function NeonTool({ dropped, onConsumeDrop, onStatus, isPathBlocked, onPendingChange }: {
  dropped: string[] | null;
  onConsumeDrop: () => void;
  onStatus: (message: string) => void;
  isPathBlocked: (path: string) => string | null;
  onPendingChange: (pending: boolean) => void;
}) {
  const [car, setCar] = useState<Car | null>(null);
  const [neon, setNeon] = useState<NeonShadowTransform>(IDENTITY_TRANSFORM);
  const [shadow, setShadow] = useState<NeonShadowTransform>(IDENTITY_TRANSFORM);
  const [includeAux, setIncludeAux] = useState(true);
  const [error, setError] = useState("");
  const [result, setResult] = useState("");
  const [busy, setBusy] = useState(false);
  const [recents, setRecents] = useState<string[]>(() => loadRecent(RECENTS_KEY));

  const load = useCallback(async (path: string) => {
    try {
      setBusy(true); setError(""); setResult("");
      let folder = path;
      try { await readDir(path); } catch { folder = parentPath(path); }
      const { base, found } = await findCarFiles(folder);
      if (!found.length) throw new Error(`No ${base}.pck, ${base}_g.pck or ${base}_o.pck in ${basename(folder)}.`);
      const files: Loaded[] = [];
      for (const item of found) {
        const file = await readToolkitFile(item.path);
        try { files.push({ ...file, role: item.role, label: item.label, setup: readNeonShadow(file.name, file.bytes) }); }
        catch (caught) { throw new Error(`${file.name}: ${caught instanceof Error ? caught.message : "unsupported layout"}`); }
      }
      setCar({ folder, base, files, ...await readBody(folder, files[0]) });
      setNeon(IDENTITY_TRANSFORM); setShadow(IDENTITY_TRANSFORM); setIncludeAux(true);
      setRecents(pushRecent(RECENTS_KEY, folder));
      onStatus(`${base} loaded · ${files.map((file) => file.label).join(", ")}`);
    } catch (caught) {
      setCar(null);
      setError(caught instanceof Error ? caught.message : "Could not read that car folder.");
    } finally { setBusy(false); }
  }, [onStatus]);

  useEffect(() => {
    if (!dropped) return;
    const paths = [...dropped];
    onConsumeDrop();
    if (paths.length) void load(paths[0]);
  }, [dropped, load, onConsumeDrop]);

  const pickFolder = async () => {
    const selection = await openDialog({ directory: true, multiple: false, defaultPath: car?.folder });
    if (typeof selection === "string") void load(selection);
  };

  const reference = car?.files[0].setup ?? null;
  const shadowOffset = reference?.shadow?.offset ?? ORIGIN;

  // Notes about the three PCKs not agreeing, or a copy that was edited by hand before.
  const notes = useMemo(() => {
    if (!car || !reference) return [];
    const output: string[] = [];
    const same = (a: number[][], b: number[][]) => a.length === b.length && a.every((p, i) => p.every((v, j) => Math.abs(v - b[i][j]) < 1e-6));
    const cageDiffers = car.files.filter((file) => !same(file.setup.active.points, reference.active.points)).map((file) => file.label);
    if (cageDiffers.length) output.push(`The neon cage of ${cageDiffers.join(", ")} differs from the ${car.files[0].label} one; each PCK is scaled around its own center.`);
    const auxOff = car.files.filter((file) => file.setup.aux && !file.setup.auxMatches).map((file) => file.label);
    if (auxOff.length) output.push(`The Aux copy of the cage differs from the Active one in ${auxOff.join(", ")} (edited before?). The same scale is applied to both.`);
    const noAux = car.files.filter((file) => !file.setup.aux).map((file) => file.label);
    if (noAux.length) output.push(`No separate Aux copy in ${noAux.join(", ")}; only Active is written there.`);
    const headerOff = car.files.filter((file) => !file.setup.active.headerMatches).map((file) => file.label);
    if (headerOff.length) output.push(`The cage header's min/max no longer matches its points in ${headerOff.join(", ")} (edited before?). The header is never written by this tool.`);
    const noShadow = car.files.filter((file) => !file.setup.shadow).map((file) => `${file.label}: ${file.setup.shadowError}`);
    output.push(...noShadow);
    return output;
  }, [car, reference]);

  // Preview, from the first PCK.
  const preview = useMemo(() => {
    if (!reference) return null;
    const cagePoints: XZ[] = reference.active.points.map((p) => [p[0], p[2]]);
    const pivot = cagePivot(reference.active.points);
    const cageNewPoints: XZ[] = reference.active.points.map((p) => transformXZ(p[0], p[2], pivot, neon));
    let shadowPoints: XZ[] = [], shadowNewPoints: XZ[] = [];
    if (reference.shadow) {
      const geometry = reference.shadow.geometry;
      const sp = shadowPivot(geometry);
      shadowPoints = geometryXZ(geometry, shadowOffset);
      shadowNewPoints = geometryXZ(geometry, [0, 0, 0]).map(([x, z]) => { const [nx, nz] = transformXZ(x, z, sp, shadow); return [nx + shadowOffset[0], nz + shadowOffset[2]]; });
    }
    return { cage: hull(cagePoints), cageNew: hull(cageNewPoints), shadow: hull(shadowPoints), shadowNew: hull(shadowNewPoints), cageSize: size(cagePoints), cageNewSize: size(cageNewPoints), shadowSize: shadowPoints.length ? size(shadowPoints) : null, shadowNewSize: shadowNewPoints.length ? size(shadowNewPoints) : null };
  }, [reference, neon, shadow, shadowOffset]);

  const bodySize = car?.body.length ? size(car.body) : null;

  // Everything Save would write, recomputed from the opened bytes on every change.
  const pending = !isIdentity(neon) || !isIdentity(shadow);
  const plan = useMemo<{ results: { file: Loaded; edit: NeonShadowResult }[]; error: string }>(() => {
    if (!car || !pending) return { results: [], error: "" };
    try {
      const results = car.files.map((file) => ({ file, edit: applyNeonShadow(file.name, file.bytes, { neon, shadow, includeAux }) }));
      // Read every result back and check the cage came out where it was asked to.
      for (const { file, edit } of results) {
        const after = readNeonShadow(file.name, edit.bytes);
        const pivot = cagePivot(file.setup.active.points);
        file.setup.active.points.forEach((point, i) => {
          const [x, z] = transformXZ(point[0], point[2], pivot, neon);
          const got = after.active.points[i];
          if (Math.abs(got[0] - x) > 1e-4 || Math.abs(got[2] - z) > 1e-4 || got[1] !== point[1]) throw new Error(`${file.name}: cage point ${i} did not come out as computed.`);
        });
        if (!isIdentity(shadow) && after.shadow?.geometry.triangles !== file.setup.shadow?.geometry.triangles) throw new Error(`${file.name}: the shadow lost triangles.`);
      }
      return { results, error: "" };
    } catch (caught) {
      return { results: [], error: caught instanceof Error ? caught.message : "The change could not be prepared." };
    }
  }, [car, pending, neon, shadow, includeAux]);

  const changedFiles = plan.results.filter(({ edit }) => edit.changed);
  useEffect(() => { onPendingChange(pending); }, [pending, onPendingChange]);

  const reset = () => { setNeon(IDENTITY_TRANSFORM); setShadow(IDENTITY_TRANSFORM); setIncludeAux(true); setResult(""); };

  const matchBody = (target: Target) => {
    if (!bodySize || !preview) return;
    const current = target === "neon" ? preview.cageSize : preview.shadowSize;
    if (!current) return;
    const next = { scaleX: Math.round(bodySize.width / current.width * 1000) / 1000, scaleZ: Math.round(bodySize.length / current.length * 1000) / 1000, offsetZ: Math.round((bodySize.centerZ - current.centerZ) * 1000) / 1000 };
    (target === "neon" ? setNeon : setShadow)(next);
    setResult("");
  };

  const save = useCallback(async () => {
    if (!car || !pending || plan.error || !changedFiles.length) return;
    for (const { file } of changedFiles) {
      const blocked = isPathBlocked(file.path);
      if (blocked) { setError(blocked); return; }
    }
    let written = 0;
    try {
      setBusy(true); setError("");
      for (const { file, edit } of changedFiles) { await writeVerified(file.path, edit.bytes); written += 1; }
      const parts = [!isIdentity(neon) ? `neon ${percent(neon.scaleX)}% × ${percent(neon.scaleZ)}%${neon.offsetZ ? ` shift ${meters(neon.offsetZ)} m` : ""}` : "", !isIdentity(shadow) ? `shadow ${percent(shadow.scaleX)}% × ${percent(shadow.scaleZ)}%${shadow.offsetZ ? ` shift ${meters(shadow.offsetZ)} m` : ""}` : ""].filter(Boolean);
      const message = `${car.base} saved · ${changedFiles.length} PCK${changedFiles.length === 1 ? "" : "s"} · ${parts.join(" · ")}`;
      // The saved files are the new starting point: the values go back to 100% / 0.
      await load(car.folder);
      setResult(message);
      onStatus(message);
    } catch (caught) {
      setError(`${written ? `Stopped after writing ${written} of ${changedFiles.length} PCKs. ` : ""}${caught instanceof Error ? caught.message : "The PCKs could not be saved."}`);
    } finally { setBusy(false); }
  }, [car, changedFiles, isPathBlocked, load, neon, onStatus, pending, plan.error, shadow]);

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "s") return;
      event.preventDefault(); void save();
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [save]);

  const dims = (a: { width: number; length: number } | null, b: { width: number; length: number } | null) => a
    ? `${meters(a.width)} × ${meters(a.length)} m${b && (Math.abs(a.width - b.width) > 1e-4 || Math.abs(a.length - b.length) > 1e-4) ? ` → ${meters(b.width)} × ${meters(b.length)} m` : ""}`
    : "—";
  const anyAux = car?.files.some((file) => file.setup.aux) ?? false;
  const shadowEditable = car?.files.every((file) => file.setup.shadow) ?? false;

  return <>
    <section className="toolkit-hero">
      <div>
        <p className="eyebrow">{tr("NEON AND GROUND SHADOW")}</p>
        <h2>{tr("Resize the neon and the shadow")}</h2>
        <p className="toolkit-hero-copy"><Tx t="Two separate things. The colored neon is projected from the BodyBounds cage, a handful of points around the car; it is scaled as a whole around its center. The dark shadow is the {0} piece embedded in the car; its vertices are rewritten in place. Nothing grows, no anchor or {1} is touched, and Player, Garage and Opponent are changed together." v={[<code>neonglow.mesh</code>, <code>mesh.pck</code>]} /></p>
      </div>
      <div className="toolkit-facts">
        <div><span>{tr("INPUT")}</span><strong>{tr("Car folder (3 PCKs)")}</strong></div>
        <div><span>{tr("EDITS")}</span><strong>{tr("Cage points, shadow vertices")}</strong></div>
        <div><span>{tr("ON SAVE")}</span><strong>{tr("Overwritten, then verified")}</strong></div>
      </div>
    </section>

    <section className="toolkit-panel">
      <div className="toolkit-panel-head">
        <div><span className="step-number">01</span><div><h3>{tr("Open the car")}</h3><p><Tx t="The folder holding {0}, {1} and {2} — or drop one of those PCKs." v={[<code>vp_x.pck</code>, <code>vp_x_g.pck</code>, <code>vp_x_o.pck</code>]} /></p></div></div>
        <span className="toolkit-required">{tr("REQUIRED")}</span>
      </div>
      <div className="toolkit-file-row">
        <button className="toolkit-drop" type="button" disabled={busy} title={car?.folder ?? tr("Choose a car folder")} onClick={() => void pickFolder()}>
          <span className="toolkit-file-type">{tr("DIR")}</span>
          <span className="toolkit-drop-copy">
            <strong>{car ? car.base : busy ? tr("Reading…") : tr("Choose a car folder")}</strong>
            <small>{car ? car.files.map((file) => `${file.label} ✓`).join(" · ") + (car.files.length < 3 ? ` · ${tr(`${3 - car.files.length} missing`)}` : "") : tr("Click to browse, or drop it on the window")}</small>
          </span>
          <span className="toolkit-drop-action">{car ? tr("CHANGE") : tr("+ OPEN")}</span>
        </button>
        <RecentList title={tr("Recent folders")} paths={recents} activePath={car?.folder} busy={busy} onPick={(path) => void load(path)} onClear={() => { saveRecent(RECENTS_KEY, []); setRecents([]); }} />
      </div>
    </section>

    <section className="toolkit-panel">
      <div className="toolkit-panel-head">
        <div><span className="step-number">02</span><div><h3>{tr("Neon and shadow size")}</h3><p>{tr("Width is X (left/right), length is Z (front/back). Height is never changed: the neon is projected onto the ground and the shadow lies flat on it.")}</p></div></div>
      </div>
      {!car || !reference || !preview ? (
        <div className="toolkit-empty"><span>{tr("NEON")}</span><strong>{tr("Nothing loaded yet")}</strong><p>{tr("The neon cage and the shadow are shown once a car is opened.")}</p></div>
      ) : <div className="neon-layout">
        <div className="neon-preview">
          <TopView body={car.body} cage={isIdentity(neon) ? [] : preview.cage} cageNew={preview.cageNew} shadow={isIdentity(shadow) ? [] : preview.shadow} shadowNew={preview.shadowNew} />
          <div className="neon-legend">
            <span><i className="body" />{tr("Body")}</span>
            <span><i className="cage" />{tr("Neon cage")}</span>
            <span><i className="shadow" />{tr("Shadow")}</span>
            <span><i className="dashed" />{tr("Before")}</span>
          </div>
          <small className="neon-note">{tr(car.bodyNote)}</small>
        </div>
        <div className="neon-controls">
          <div className={`neon-card ${isIdentity(neon) ? "" : "changed"}`}>
            <div className="neon-card-head">
              <div><strong>{tr("Colored neon")}</strong><small><Tx t="BodyBounds cage · {0} points · {1}" v={[reference.active.points.length, dims(preview.cageSize, preview.cageNewSize)]} /></small></div>
              <button className="toolkit-secondary" type="button" disabled={busy || !bodySize} onClick={() => matchBody("neon")} title={tr("Scale and shift the cage so its outline matches the body's")}>{tr("MATCH BODY")}</button>
            </div>
            <TransformFields label={tr("Neon")} value={neon} disabled={busy} onChange={(next) => { setNeon(next); setResult(""); }} />
            <label className="inject-option neon-aux">
              <input type="checkbox" checked={includeAux && anyAux} disabled={busy || !anyAux} onChange={(event) => setIncludeAux(event.target.checked)} />
              <span><strong>{tr("Also write the Aux copy")}</strong><small>{tr("Every PCK keeps a second copy of the cage (BodyBounds_AuxMirror). Which one the game reads in each situation isn't known, so both are written by default.")}</small></span>
            </label>
          </div>
          <div className={`neon-card ${isIdentity(shadow) ? "" : "changed"}`}>
            <div className="neon-card-head">
              <div><strong>{tr("Ground shadow")}</strong><small>{reference.shadow ? <Tx t="{0} · {1}" v={[reference.shadow.name, dims(preview.shadowSize, preview.shadowNewSize)]} /> : tr(reference.shadowError ?? "No shadow piece")}</small></div>
              <button className="toolkit-secondary" type="button" disabled={busy || !bodySize || !shadowEditable} onClick={() => matchBody("shadow")} title={tr("Scale and shift the shadow so its outline matches the body's")}>{tr("MATCH BODY")}</button>
            </div>
            <TransformFields label={tr("Shadow")} value={shadow} disabled={busy || !shadowEditable} onChange={(next) => { setShadow(next); setResult(""); }} />
          </div>
          {bodySize && <p className="neon-body-size"><Tx t="Body outline: {0}" v={[<strong>{`${meters(bodySize.width)} × ${meters(bodySize.length)} m`}</strong>]} /></p>}
          {notes.map((text) => <p key={text} className="carcfg-warning">{tr(text)}</p>)}
        </div>
      </div>}
    </section>

    {car && <section className="toolkit-actions">
      <div>
        <strong>{pending ? tr(`${[!isIdentity(neon) && "Neon", !isIdentity(shadow) && "Shadow"].filter(Boolean).join(" and ")} changed`) : tr("No changes")}</strong>
        <small>{pending
          ? tr(`Nothing is written until you save. ${changedFiles.map(({ file }) => file.name).join(", ")} will be overwritten in place, then read back and compared byte for byte.`)
          : tr("Set the sizes, then save. Nothing is written before that.")}</small>
      </div>
      <div className="carcfg-actions">
        <button className="toolkit-secondary" type="button" disabled={busy || !pending} onClick={reset}>{tr("RESET")}</button>
        <button className="toolkit-primary" type="button" disabled={busy || !pending || Boolean(plan.error) || !changedFiles.length} onClick={() => void save()}>{busy ? tr("SAVING…") : tr("SAVE PCKS")}<span>→</span></button>
      </div>
    </section>}

    {result && <section className="iso-result"><span>✓</span><p>{tr(result)}</p></section>}
    {(error || plan.error) && <section className="toolkit-error"><span>!</span><div><strong>{tr("Action required")}</strong><p>{tr(error || plan.error)}</p></div></section>}
  </>;
}
