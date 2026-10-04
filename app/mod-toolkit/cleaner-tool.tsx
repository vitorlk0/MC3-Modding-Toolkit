import { tr, Tx } from "../i18n";
import { useCallback, useEffect, useMemo, useState } from "react";
import { hex } from "../../src/pck";
import { openCarPck } from "../../src/mesh-inject";
import { stripCarPck, type StripMode, type StripResult, type StripRow, type StripRowStatus } from "../../src/pck-strip";
import { isMeshPckName, parentFolder, parentPath, pickFiles, readToolkitFile, sizeLabel, writeVerified, type ToolkitFile } from "./toolkit-io";
import { RecentList } from "./toolkit-ui";
import { loadRecent, pushRecent, saveRecent } from "../recent-paths";

/**
 * Car PCK Cleaner — removes the meshes embedded in a car PCK to leave a clean base.
 *
 * The Mod Toolkit's version of `mc3_pck_strip_internal_meshes.py` v6. The typical run: copy the
 * player PCK over `<car>_g.pck`, open that copy here and save, so the garage starts from nothing
 * but suspension and shadow before new pieces are injected. The bytes come from
 * `src/pck-strip.ts`, byte-for-byte identical to the Python tool; this file only shows the plan and
 * saves it. The result is re-opened with `PckDocument` before Save is offered, and the file is
 * overwritten in place and read back, like every other tool in this tab.
 */

const pckFilters = [{ name: "MC3 car PCK", extensions: ["pck"] }];
const RECENTS_KEY = "mc3pae.recentCleanerTargets";

const statusLabel: Record<StripRowStatus, string> = { remove: "REMOVE", protected: "PROTECTED", keep: "KEEP", external: "LOOSE FILE", llod: "LLOD" };
const statusTone: Record<StripRowStatus, string> = { remove: "insert", protected: "replace", keep: "current", external: "current", llod: "current" };

function rowNote(row: StripRow) {
  if (row.status === "remove") return row.orphan ? tr("orphan payload, matched by name order") : row.reasons.join(" · ");
  if (row.status === "protected") return tr("suspension, shadow or light glow — never removed");
  if (row.status === "external") return tr("not embedded — streamed from its loose mesh.pck");
  if (row.status === "llod") return tr("LLOD is never touched");
  return tr("kept by the shell-only rule");
}

export function CleanerTool({ dropped, onConsumeDrop, onStatus, isPathBlocked, onPendingChange }: {
  dropped: string[] | null;
  onConsumeDrop: () => void;
  onStatus: (message: string) => void;
  isPathBlocked: (path: string) => string | null;
  onPendingChange: (pending: boolean) => void;
}) {
  const [target, setTarget] = useState<ToolkitFile | null>(null);
  const [mode, setMode] = useState<StripMode>("clean-base");
  const [showLoose, setShowLoose] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [recents, setRecents] = useState<string[]>(() => loadRecent(RECENTS_KEY));

  const plan = useMemo<{ value: StripResult | null; error: string }>(() => {
    if (!target) return { value: null, error: "" };
    try {
      const value = stripCarPck(target.bytes, { mode });
      // A second, independent reader must accept the result before it can be saved.
      if (value.changed) openCarPck(target.name, value.bytes);
      if (value.livePointersZeroed) return { value, error: `${value.livePointersZeroed} pointer(s) outside the LOD tables still targeted removed data. The result was not offered for saving.` };
      return { value, error: "" };
    } catch (caught) {
      return { value: null, error: caught instanceof Error ? caught.message : "The car PCK could not be cleaned." };
    }
  }, [target, mode]);

  const result = plan.value;
  const removedRows = result ? result.rows.filter((row) => row.status === "remove") : [];
  const willWrite = Boolean(result?.changed && !plan.error);
  useEffect(() => { onPendingChange(willWrite); }, [willWrite, onPendingChange]);

  const loadTarget = useCallback(async (path: string) => {
    if (isMeshPckName(path)) { setError("That is a loose mesh piece. Open the car PCK whose embedded meshes should go."); return; }
    const blocked = isPathBlocked(path);
    if (blocked) { setError(blocked); return; }
    try {
      setBusy(true); setError("");
      const file = await readToolkitFile(path);
      setTarget(file);
      setRecents(pushRecent(RECENTS_KEY, file.path));
      onStatus(`${file.name} loaded · ${sizeLabel(file.bytes.length)}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not read that car PCK.");
    } finally { setBusy(false); }
  }, [isPathBlocked, onStatus]);

  useEffect(() => {
    if (!dropped) return;
    const paths = [...dropped];
    onConsumeDrop();
    const car = paths.find((path) => /\.pck$/i.test(path) && !isMeshPckName(path));
    if (car) void loadTarget(car);
    else setError("Drop a car PCK.");
  }, [dropped, loadTarget, onConsumeDrop]);

  const save = useCallback(async () => {
    if (!target || !result || !willWrite) return;
    const blocked = isPathBlocked(target.path);
    if (blocked) { setError(blocked); return; }
    try {
      setBusy(true); setError("");
      await writeVerified(target.path, result.bytes);
      // Re-open from disk so the review now shows the cleaned file (nothing left to remove).
      setTarget(await readToolkitFile(target.path));
      onStatus(`${target.name} saved · ${removedRows.length} LOD row${removedRows.length === 1 ? "" : "s"} cleared · ${sizeLabel(result.originalSize)} → ${sizeLabel(result.newSize)}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The car PCK could not be saved.");
    } finally { setBusy(false); }
  }, [isPathBlocked, onStatus, removedRows.length, result, target, willWrite]);

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "s") return;
      event.preventDefault(); void save();
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [save]);

  const count = (status: StripRowStatus) => result ? result.rows.filter((row) => row.status === status).length : 0;
  const shownRows = result ? result.rows.filter((row) => showLoose || row.status !== "external") : [];
  const saved = result ? result.originalSize - result.newSize : 0;
  // A refused file already explains itself in the review panel; only a result that exists but
  // can't be saved needs the error box too.
  const shownError = error || (result ? plan.error : "");

  return <>
    <section className="toolkit-hero">
      <div>
        <p className="eyebrow">{tr("EMBEDDED MESH REMOVAL")}</p>
        <h2>{tr("Strip a car PCK down to a clean base")}</h2>
        <p className="toolkit-hero-copy"><Tx t="Removes every mesh embedded in the HLOD and MLOD tables — shell, windows, interior and the pieces with their own ID — and closes the gaps. Suspension, shadow, police light glows and the LLOD always stay, and loose {0} files are never touched. Typical use: copy the player PCK over {1}, then clean that copy." v={[<code>*.mesh.pck</code>, <code>_g.pck</code>]} /></p>
      </div>
      <div className="toolkit-facts">
        <div><span>{tr("INPUT")}</span><strong>{tr("One car PCK")}</strong></div>
        <div><span>{tr("ALWAYS KEPT")}</span><strong>{tr("Suspension, shadow, LLOD")}</strong></div>
        <div><span>{tr("ON SAVE")}</span><strong>{tr("Overwritten, then verified")}</strong></div>
      </div>
    </section>

    <section className="toolkit-panel">
      <div className="toolkit-panel-head">
        <div><span className="step-number">01</span><div><h3>{tr("Select the car PCK")}</h3><p><Tx t="Usually the {0} after copying the player PCK over it. The file you open is the one saved." v={[<code>_g.pck</code>]} /></p></div></div>
        <span className="toolkit-required">{tr("REQUIRED")}</span>
      </div>
      <div className="toolkit-file-row">
        <button className="toolkit-drop" type="button" disabled={busy} title={target?.path ?? tr("Choose a car PCK")} onClick={() => void pickFiles(pckFilters, false, target ? parentPath(target.path) : undefined).then((paths) => paths[0] && loadTarget(paths[0]))}>
          <span className="toolkit-file-type">{tr("PCK")}</span>
          <span className="toolkit-drop-copy">
            <strong>{target ? target.name : tr("Choose a car PCK")}</strong>
            <small>{target ? tr(`${sizeLabel(target.bytes.length)} · in ${parentFolder(target.path)}`) : tr("Click to browse, or drag one onto the window")}</small>
          </span>
          <span className="toolkit-drop-action">{target ? tr("CHANGE") : tr("+ OPEN")}</span>
        </button>
        <RecentList title={tr("Recent car PCKs")} paths={recents} activePath={target?.path} busy={busy} onPick={(path) => void loadTarget(path)} onClear={() => { saveRecent(RECENTS_KEY, []); setRecents([]); }} />
      </div>
    </section>

    <section className="toolkit-panel">
      <div className="toolkit-panel-head">
        <div><span className="step-number">02</span><div><h3>{tr("Review what goes")}</h3><p>{tr("Every row of the car's LOD tables and what happens to it.")}</p></div></div>
        {result && <div className="toolkit-chips">
          <span><Tx t="{0} to remove" v={[<strong>{count("remove")}</strong>]} /></span>
          <span><Tx t="{0} protected" v={[<strong>{count("protected")}</strong>]} /></span>
          {count("keep") > 0 && <span><Tx t="{0} kept" v={[<strong>{count("keep")}</strong>]} /></span>}
          <span><Tx t="{0} loose-file rows" v={[<strong>{count("external")}</strong>]} /></span>
        </div>}
      </div>
      <div className="carcfg-settings">
        <div className="carcfg-mode">
          <button type="button" className={mode === "clean-base" ? "active" : ""} onClick={() => setMode("clean-base")}>
            <strong>{tr("Clean base")}</strong><small>{tr("Every embedded HLOD/MLOD mesh except the protected ones")}</small>
          </button>
          <button type="button" className={mode === "shell-only" ? "active" : ""} onClick={() => setMode("shell-only")}>
            <strong>{tr("Shell only (legacy)")}</strong><small>{tr("Only shell, trunk and decal names plus ID-0 pieces; spoilers stay")}</small>
          </button>
        </div>
      </div>
      {!target ? (
        <div className="toolkit-empty"><span>{tr("LOD")}</span><strong>{tr("Nothing loaded yet")}</strong><p>{tr("The LOD rows are listed once a car PCK is loaded.")}</p></div>
      ) : !result ? (
        <div className="toolkit-empty"><span>{tr("LOD")}</span><strong>{tr("This car PCK can't be cleaned")}</strong><p>{tr(plan.error)}</p></div>
      ) : <>
        <div className="toolkit-category-tools">
          <span>{tr(`${shownRows.length} of ${result.rows.length} rows shown`)}</span>
          <div><button type="button" onClick={() => setShowLoose((value) => !value)}>{showLoose ? tr("HIDE LOOSE-FILE ROWS") : tr("SHOW LOOSE-FILE ROWS")}</button></div>
        </div>
        <div className="inject-table">
          <div className="inject-row head"><span /><span>{tr("MESH")}</span><span>{tr("LOD ROW")}</span><span>{tr("ID")}</span><span>{tr("STATUS")}</span></div>
          {shownRows.map((row) => <div key={`${row.lod}:${row.index}`} className={`inject-row ${row.status === "remove" ? "" : "off"}`} style={{ cursor: "default" }}>
            <span />
            <span title={row.name}><strong>{row.name || tr("(unnamed)")}</strong><small>{rowNote(row)}</small></span>
            <span>{`${row.lod} #${row.index}`}</span>
            <span>{hex(row.meshId & 0xffff, 2)}</span>
            <span><em className={`inject-status ${statusTone[row.status]}`}>{tr(statusLabel[row.status])}</em></span>
          </div>)}
        </div>
        {result.warnings.length > 0 && <div className="toolkit-category-list">
          <details className="toolkit-category">
            <summary>
              <span className="toolkit-category-index">{tr("INFO")}</span>
              <span><strong>{tr("Notes from the cleaner")}</strong><small>{tr("What was kept in place, and why")}</small></span>
              <span className="toolkit-category-count"><Tx t="{0} NOTES" v={[result.warnings.length]} /></span>
              <i />
            </summary>
            <div className="dat-file-list">{result.warnings.map((warning, index) => <code key={index} title={warning}>{warning}</code>)}</div>
          </details>
        </div>}
      </>}
    </section>

    {result && <section className="toolkit-actions">
      <div>
        <strong>{willWrite ? tr(`${removedRows.length} LOD row${removedRows.length === 1 ? "" : "s"} will be cleared`) : tr("Nothing to remove")}</strong>
        <small>{willWrite
          ? tr(`${target!.name}: ${sizeLabel(result.originalSize)} → ${sizeLabel(result.newSize)} (${sizeLabel(saved)} removed). Overwritten in place, then read back and compared byte for byte.`)
          : tr("No embedded mesh in this car PCK matches the selected rule.")}</small>
      </div>
      <button className="toolkit-primary" type="button" disabled={busy || !willWrite} onClick={() => void save()}>
        {busy ? tr("SAVING…") : tr("SAVE CAR PCK")}<span>→</span>
      </button>
    </section>}

    {shownError && <section className="toolkit-error"><span>!</span><div><strong>{tr("Action required")}</strong><p>{tr(shownError)}</p></div></section>}
  </>;
}
