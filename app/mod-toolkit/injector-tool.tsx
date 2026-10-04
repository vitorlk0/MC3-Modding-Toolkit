import { tr, Tx } from "../i18n";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { hex, type PckDocument } from "../../src/pck";
import { openCarPck, planInjection, type InjectPlan, type InjectRow } from "../../src/mesh-inject";
import { basename, isMeshPckName, listMeshPcks, parentFolder, parentPath, pickFiles, readToolkitFile, sizeLabel, writeVerified, type ToolkitFile } from "./toolkit-io";
import { RecentList } from "./toolkit-ui";
import { loadRecent, pushRecent, saveRecent } from "../recent-paths";

/**
 * Car PCK Mesh Injector — embeds loose mesh.pck files into one car PCK in bulk.
 *
 * The quick path for "just put these pieces inside the garage PCK": one target at a time, pieces
 * matched to their LOD rows by name, and no step-1 CSV or PatternData JSON — the target's own
 * tables supply every slot. Piece-by-piece work stays in the Mesh Editor.
 *
 * The embedding itself is `src/mesh-inject.ts`, which only composes `PckDocument` calls. The
 * review is built by the same function as the saved bytes; nothing is written until Save, which
 * overwrites the target, reads it back and re-opens it.
 */

const pckFilters = [{ name: "MC3 car PCK", extensions: ["pck"] }];
const meshFilters = [{ name: "MC3 loose mesh", extensions: ["pck"] }];
const RECENTS_KEY = "mc3pae.recentInjectorTargets";

const lodLabel = (entry: { lod: string; index: number }) => `${entry.lod.toUpperCase()} #${entry.index}`;

function rowStatus(row: InjectRow) {
  if (row.problem) return { label: row.noSlot ? "NO SLOT" : "INVALID", tone: "problem" };
  const actions = new Set(row.entries.map((entry) => entry.action));
  if (actions.size === 1 && actions.has("current")) return { label: "UP TO DATE", tone: "current" };
  if (actions.has("insert") && !actions.has("replace")) return { label: "INSERT", tone: "insert" };
  return { label: "REPLACE", tone: "replace" };
}
const isPending = (row: InjectRow) => !row.problem && row.entries.some((entry) => entry.action !== "current");

export function InjectorTool({ dropped, onConsumeDrop, onStatus, isPathBlocked, onPendingChange }: {
  dropped: string[] | null;
  onConsumeDrop: () => void;
  onStatus: (message: string) => void;
  isPathBlocked: (path: string) => string | null;
  onPendingChange: (pending: boolean) => void;
}) {
  const [target, setTarget] = useState<{ file: ToolkitFile; document: PckDocument } | null>(null);
  const [pieces, setPieces] = useState<ToolkitFile[]>([]);
  /** Lower-case names of the pieces to embed. */
  const [include, setInclude] = useState<Set<string>>(new Set());
  const [forceShellZero, setForceShellZero] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [recents, setRecents] = useState<string[]>(() => loadRecent(RECENTS_KEY));
  const lastTouched = useRef<number | null>(null);

  const pieceInputs = useMemo(() => pieces.map((file) => ({ name: file.name, bytes: file.bytes })), [pieces]);

  // Every piece embedded, only to learn each one's status — whether it would insert, replace, or is
  // already exactly what the car holds. The plan below is the one actually saved.
  const analysis = useMemo<InjectPlan | null>(() => {
    if (!target || !pieceInputs.length) return null;
    try { return planInjection(target.file.name, target.file.bytes, pieceInputs, new Set(pieceInputs.map((piece) => piece.name.toLowerCase())), forceShellZero); }
    catch { return null; }
  }, [target, pieceInputs, forceShellZero]);
  const plan = useMemo<{ value: InjectPlan | null; error: string }>(() => {
    if (!target || !include.size) return { value: null, error: "" };
    try { return { value: planInjection(target.file.name, target.file.bytes, pieceInputs, include, forceShellZero), error: "" }; }
    catch (caught) { return { value: null, error: caught instanceof Error ? caught.message : "The pieces could not be embedded." }; }
  }, [target, pieceInputs, include, forceShellZero]);

  // New target or new pieces: select exactly the pieces that would change something. The shell
  // toggle deliberately doesn't reset a selection the user has already adjusted.
  const selectionKey = useRef("");
  useEffect(() => {
    if (!analysis) return;
    const key = `${target?.file.path}|${pieces.map((file) => file.path).join("|")}`;
    if (key === selectionKey.current) return;
    selectionKey.current = key;
    setInclude(new Set(analysis.rows.filter(isPending).map((row) => row.name.toLowerCase())));
    lastTouched.current = null;
  }, [analysis, pieces, target]);

  const rows = analysis?.rows ?? [];
  const selectedRows = rows.filter((row) => include.has(row.name.toLowerCase()) && !row.problem);
  const pendingRows = selectedRows.filter(isPending);
  const willWrite = Boolean(plan.value?.changed && pendingRows.length);
  useEffect(() => { onPendingChange(willWrite); }, [willWrite, onPendingChange]);

  const loadTarget = useCallback(async (path: string) => {
    if (isMeshPckName(path)) { setError("That is a loose mesh piece. The target is the car PCK the pieces go into."); return; }
    const blocked = isPathBlocked(path);
    if (blocked) { setError(blocked); return; }
    try {
      setBusy(true); setError("");
      const file = await readToolkitFile(path);
      const document = openCarPck(file.name, file.bytes);
      setTarget({ file, document });
      setRecents(pushRecent(RECENTS_KEY, file.path));
      const embedded = document.lodMeshes.filter((entry) => entry.meshBlockOffset !== null).length;
      onStatus(`${file.name} · ${document.lodMeshes.length} LOD rows · ${embedded} embedded`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not read that car PCK.");
    } finally { setBusy(false); }
  }, [isPathBlocked, onStatus]);

  const addPieces = useCallback(async (paths: string[]) => {
    const accepted = paths.filter(isMeshPckName);
    if (!accepted.length) { setError("Only loose *.mesh.pck pieces can be added."); return; }
    const blocked = accepted.map(isPathBlocked).find(Boolean);
    if (blocked) { setError(blocked); return; }
    try {
      setBusy(true); setError("");
      const opened = await Promise.all(accepted.map(readToolkitFile));
      setPieces((current) => {
        // Keyed by name, not path: two files with the same name are the same slot, and embedding
        // both would only mean the second silently overwrites the first. The newer one wins.
        const byName = new Map(current.map((file) => [file.name.toLowerCase(), file]));
        for (const file of opened) byName.set(file.name.toLowerCase(), file);
        return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      });
      const skipped = paths.length - accepted.length;
      onStatus(`${opened.length} mesh piece${opened.length === 1 ? "" : "s"} added${skipped ? ` · ${skipped} non-mesh file${skipped === 1 ? "" : "s"} skipped` : ""}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Those pieces could not be read.");
    } finally { setBusy(false); }
  }, [isPathBlocked, onStatus]);

  const addFolder = useCallback(async (folder: string) => {
    try {
      const paths = await listMeshPcks(folder);
      if (!paths.length) { setError(`No *.mesh.pck pieces in ${basename(folder) || folder}.`); return; }
      await addPieces(paths);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not list that folder."); }
  }, [addPieces]);

  useEffect(() => {
    if (!dropped) return;
    const paths = [...dropped];
    onConsumeDrop();
    const meshes = paths.filter(isMeshPckName);
    const car = paths.find((path) => /\.pck$/i.test(path) && !isMeshPckName(path));
    // Anything without an extension is taken for a folder of pieces.
    const folders = paths.filter((path) => !/\.[^\\/]+$/.test(basename(path)));
    if (car) void loadTarget(car);
    if (meshes.length) void addPieces(meshes);
    for (const folder of folders) void addFolder(folder);
    if (!car && !meshes.length && !folders.length) setError("Drop a car PCK, loose *.mesh.pck pieces, or a folder of them.");
  }, [dropped, addFolder, addPieces, loadTarget, onConsumeDrop]);

  const toggle = (index: number, shiftKey: boolean) => {
    const row = rows[index]; if (!row || row.problem) return;
    const on = !include.has(row.name.toLowerCase());
    const previous = lastTouched.current;
    lastTouched.current = index;
    const span = shiftKey && previous !== null
      ? rows.slice(Math.min(index, previous), Math.max(index, previous) + 1)
      : [row];
    setInclude((current) => {
      const next = new Set(current);
      for (const item of span) if (!item.problem) on ? next.add(item.name.toLowerCase()) : next.delete(item.name.toLowerCase());
      return next;
    });
  };
  const selectWhere = (predicate: (row: InjectRow) => boolean) => {
    setInclude(new Set(rows.filter((row) => !row.problem && predicate(row)).map((row) => row.name.toLowerCase())));
    lastTouched.current = null;
  };

  const save = useCallback(async () => {
    if (!target || !plan.value || !willWrite) return;
    const blocked = isPathBlocked(target.file.path);
    if (blocked) { setError(blocked); return; }
    try {
      setBusy(true); setError("");
      const result = plan.value;
      await writeVerified(target.file.path, result.bytes);
      // Re-open from disk so the next review compares against what the file now holds.
      const file = await readToolkitFile(target.file.path);
      setTarget({ file, document: openCarPck(file.name, file.bytes) });
      const written = result.rows.filter((row) => row.included && isPending(row));
      const entries = written.reduce((sum, row) => sum + row.entries.filter((entry) => entry.action !== "current").length, 0);
      onStatus(`${file.name} saved · ${written.length} piece${written.length === 1 ? "" : "s"} embedded in ${entries} LOD row${entries === 1 ? "" : "s"} · ${sizeLabel(result.sizeBefore)} → ${sizeLabel(result.sizeAfter)}${result.reclaimed ? ` · ${sizeLabel(result.reclaimed)} reclaimed` : ""}`);
      // Force the selection to be rebuilt against the saved file.
      selectionKey.current = "";
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The car PCK could not be saved.");
    } finally { setBusy(false); }
  }, [isPathBlocked, onStatus, plan.value, target, willWrite]);

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "s") return;
      event.preventDefault(); void save();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [save]);

  const embeddedCount = target ? target.document.lodMeshes.filter((entry) => entry.meshBlockOffset !== null).length : 0;
  const counts = {
    insert: rows.filter((row) => rowStatus(row).tone === "insert").length,
    replace: rows.filter((row) => rowStatus(row).tone === "replace").length,
    current: rows.filter((row) => rowStatus(row).tone === "current").length,
    problem: rows.filter((row) => row.problem).length,
  };
  const shellSelected = selectedRows.some((row) => row.shell);
  const shownError = error || plan.error;

  return <>
    <section className="toolkit-hero">
      <div>
        <p className="eyebrow">{tr("LOD TABLE EMBEDDING")}</p>
        <h2>{tr("Put loose pieces inside a car PCK")}</h2>
        <p className="toolkit-hero-copy"><Tx t="Matches each {0} to the HLOD/MLOD/LLOD rows of the same name and embeds it there, filling rows that streamed the piece from the loose file and replacing copies already inside. Slots, IDs and pointers come straight from the car PCK — no CSV or PatternData JSON. Dead copies from earlier embeds are reclaimed on save." v={[<code>*.mesh.pck</code>]} /></p>
      </div>
      <div className="toolkit-facts">
        <div><span>{tr("INPUT")}</span><strong>{tr("One car PCK + loose pieces")}</strong></div>
        <div><span>{tr("MATCHED BY")}</span><strong>{tr("Mesh name in the LOD tables")}</strong></div>
        <div><span>{tr("ON SAVE")}</span><strong>{tr("Overwritten, then verified")}</strong></div>
      </div>
    </section>

    <section className="toolkit-panel">
      <div className="toolkit-panel-head">
        <div><span className="step-number">01</span><div><h3>{tr("Select the car PCK")}</h3><p><Tx t="Usually the garage {0}. One car PCK at a time." v={[<code>_g.pck</code>]} /></p></div></div>
        <span className="toolkit-required">{tr("REQUIRED")}</span>
      </div>
      <div className="toolkit-file-row">
        <button className="toolkit-drop" type="button" disabled={busy} title={target?.file.path ?? tr("Choose a car PCK")} onClick={() => void pickFiles(pckFilters, false, target ? parentPath(target.file.path) : undefined).then((paths) => paths[0] && loadTarget(paths[0]))}>
          <span className="toolkit-file-type">{tr("PCK")}</span>
          <span className="toolkit-drop-copy">
            <strong>{target ? target.file.name : tr("Choose a car PCK")}</strong>
            <small>{target ? tr(`${sizeLabel(target.file.bytes.length)} · ${target.document.lodMeshes.length} LOD rows · ${embeddedCount} embedded · in ${parentFolder(target.file.path)}`) : tr("Click to browse, or drag one onto the window")}</small>
          </span>
          <span className="toolkit-drop-action">{target ? tr("CHANGE") : tr("+ OPEN")}</span>
        </button>
        <RecentList title={tr("Recent car PCKs")} paths={recents} activePath={target?.file.path} busy={busy} onPick={(path) => void loadTarget(path)} onClear={() => { saveRecent(RECENTS_KEY, []); setRecents([]); }} />
        {target && !/_g\.pck$/i.test(target.file.name) && <p className="carcfg-warning"><Tx t="This isn't the garage {0}. The player and opponent PCKs normally embed only the shell and trunk and stream every other part from its loose file." v={[<code>_g.pck</code>]} /></p>}
      </div>
    </section>

    <section className="toolkit-panel">
      <div className="toolkit-panel-head">
        <div><span className="step-number">02</span><div><h3>{tr("Add the loose pieces")}</h3><p>{tr("Each file's name must match a row in the car's LOD tables.")}</p></div></div>
        <span className="toolkit-required">{tr("REQUIRED")}</span>
      </div>
      <div className="toolkit-file-row">
        <button className="toolkit-drop" type="button" disabled={busy} onClick={() => void pickFiles(meshFilters, true, pieces.length ? parentPath(pieces[0].path) : target ? parentPath(target.file.path) : undefined).then((paths) => { if (paths.length) void addPieces(paths); })}>
          <span className="toolkit-file-type">{tr("MESH")}</span>
          <span className="toolkit-drop-copy">
            <strong>{pieces.length ? tr(`${pieces.length} piece${pieces.length === 1 ? "" : "s"} loaded`) : tr("Choose *.mesh.pck files")}</strong>
            <small>{pieces.length ? tr(`${sizeLabel(pieces.reduce((sum, file) => sum + file.bytes.length, 0))} · click to add more, or drop files or a folder on the window`) : tr("Click to browse, or drag files or a folder onto the window")}</small>
          </span>
          <span className="toolkit-drop-action">{pieces.length ? tr("+ ADD") : tr("+ OPEN")}</span>
        </button>
        <div className="toolkit-chip-list">
          {target && <button className="link-button" type="button" disabled={busy} onClick={() => void addFolder(parentPath(target.file.path))}><Tx t="Add every piece in {0}" v={[parentFolder(target.file.path) || tr("the car's folder")]} /></button>}
          {pieces.length > 0 && <button className="link-button" type="button" onClick={() => setPieces([])}>{tr("Clear all")}</button>}
        </div>
      </div>
    </section>

    <section className="toolkit-panel">
      <div className="toolkit-panel-head">
        <div><span className="step-number">03</span><div><h3>{tr("Choose what to embed")}</h3><p>{tr("Pieces that would change something start checked. Shift-click selects a range.")}</p></div></div>
        {analysis && <div className="toolkit-chips">
          {counts.insert > 0 && <span><Tx t="{0} insert" v={[<strong>{counts.insert}</strong>]} /></span>}
          {counts.replace > 0 && <span><Tx t="{0} replace" v={[<strong>{counts.replace}</strong>]} /></span>}
          {counts.current > 0 && <span><Tx t="{0} up to date" v={[<strong>{counts.current}</strong>]} /></span>}
          {counts.problem > 0 && <span className="prior"><Tx t="{0} can't embed" v={[<strong>{counts.problem}</strong>]} /></span>}
        </div>}
      </div>
      {!target || !pieces.length ? (
        <div className="toolkit-empty"><span>{tr("LOD")}</span><strong>{target || pieces.length ? tr("Add the other half too") : tr("Nothing loaded yet")}</strong><p>{tr("The pieces are listed once a car PCK and at least one loose piece are loaded.")}</p></div>
      ) : !analysis ? (
        <div className="toolkit-empty"><span>{tr("LOD")}</span><strong>{tr("These pieces could not be matched")}</strong><p>{plan.error || tr("The car PCK could not be read.")}</p></div>
      ) : <>
        <div className="toolkit-category-tools inject-tools">
          <label className="inject-option" title={tr("The precedent tool's rule: pieces with 'shell' in their name get ID 0 in the table and in the embedded copy.")}>
            <input type="checkbox" checked={forceShellZero} onChange={(event) => setForceShellZero(event.target.checked)} />
            <span><strong>{tr("Force shell ID to zero")}</strong><small>{tr("Clears an ID a shell borrowed to preview before embedding.")}</small></span>
          </label>
          <div>
            <button type="button" onClick={() => selectWhere(isPending)}>{tr("SELECT CHANGED")}</button>
            <button type="button" onClick={() => selectWhere(() => true)}>{tr("SELECT ALL")}</button>
            <button type="button" onClick={() => selectWhere(() => false)}>{tr("DESELECT ALL")}</button>
          </div>
        </div>
        <div className="inject-table">
          <div className="inject-row head"><span /><span>{tr("PIECE")}</span><span>{tr("LOD ROWS")}</span><span>{tr("ID")}</span><span>{tr("STATUS")}</span></div>
          {rows.map((row, index) => {
            const status = rowStatus(row);
            const checked = include.has(row.name.toLowerCase()) && !row.problem;
            const ids = [...new Set(row.entries.map((entry) => `${hex(entry.originalId, 2)}${entry.meshId !== entry.originalId ? ` → ${hex(entry.meshId, 2)}` : ""}`))];
            return <div key={row.name} className={`inject-row ${row.problem ? "problem" : checked ? "" : "off"}`} onClick={(event) => toggle(index, event.shiftKey)}>
              <span><input type="checkbox" checked={checked} disabled={Boolean(row.problem)} readOnly /></span>
              <span title={row.name}><strong>{row.name}</strong><small>{row.problem ?? `${sizeLabel(row.size)}${row.shell ? " · shell" : ""}`}</small></span>
              <span>{row.entries.map(lodLabel).join(" · ") || "—"}</span>
              <span>{ids.join(", ") || "—"}</span>
              <span><em className={`inject-status ${status.tone}`}>{tr(status.label)}</em></span>
            </div>;
          })}
        </div>
      </>}
    </section>

    {analysis && <section className="toolkit-actions">
      <div>
        <strong>{pendingRows.length ? tr(`${pendingRows.length} piece${pendingRows.length === 1 ? "" : "s"} will be embedded`) : tr("Nothing to embed")}</strong>
        <small>{plan.value && willWrite
          ? tr(`${target!.file.name}: ${sizeLabel(plan.value.sizeBefore)} → ${sizeLabel(plan.value.sizeAfter)}${plan.value.reclaimed ? ` (${sizeLabel(plan.value.reclaimed)} of dead copies reclaimed)` : ""}. Overwritten in place, then read back and compared byte for byte.${shellSelected && forceShellZero ? " Shell IDs go to zero." : ""}`)
          : tr("Check the pieces that should go into the car PCK. Up-to-date pieces are already embedded exactly as they are.")}</small>
      </div>
      <button className="toolkit-primary" type="button" disabled={busy || !willWrite} onClick={() => void save()}>
        {busy ? tr("SAVING…") : tr("SAVE CAR PCK")}<span>→</span>
      </button>
    </section>}

    {shownError && <section className="toolkit-error"><span>!</span><div><strong>{tr("Action required")}</strong><p>{tr(shownError)}</p></div></section>}
  </>;
}
