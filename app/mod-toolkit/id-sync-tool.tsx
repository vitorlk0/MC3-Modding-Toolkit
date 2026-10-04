import { tr, Tx } from "../i18n";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { hex, type PckDocument } from "../../src/pck";
import { MeshPckDocument, matchLodEntries } from "../../src/mesh";
import { openCarPck } from "../../src/mesh-inject";
import { basename, isMeshPckName, listMeshPcks, parentFolder, parentPath, pickFiles, readToolkitFile, sizeLabel, writeVerified, type ToolkitFile } from "./toolkit-io";
import { RecentList } from "./toolkit-ui";
import { loadRecent, pushRecent, saveRecent } from "../recent-paths";

/**
 * Mesh ID Sync — writes each loose mesh.pck's piece ID from the car PCK's LOD tables. The Mod
 * Toolkit's replacement for `mc3_fix_parts_ids_v4.py`, run after renaming pieces to the names the
 * car expects (including the renamed copies made to cover opponent setups).
 *
 * The car PCK is only read. Each piece is matched to the HLOD/MLOD/LLOD rows of the same name with
 * `matchLodEntries`; when those rows disagree on the ID the user picks one, as the script's
 * "resolve ambiguities" step asked. The byte itself is written by `MeshPckDocument.setMeshId`, the
 * Mesh Editor's own ID edit, and each file is overwritten in place and read back.
 */

const pckFilters = [{ name: "MC3 car PCK", extensions: ["pck"] }];
const meshFilters = [{ name: "MC3 loose mesh", extensions: ["pck"] }];
const RECENTS_KEY = "mc3pae.recentIdSyncReferences";

type Candidate = { id: number; lods: string[] };
type SyncRow = {
  file: ToolkitFile;
  currentId: number | null;
  candidates: Candidate[];
  problem: string | null;
  tone: "match" | "change" | "pick" | "problem";
  label: string;
  targetId: number | null;
};

const key = (path: string) => path.toLowerCase();
const bufferOf = (bytes: Uint8Array) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

export function IdSyncTool({ dropped, onConsumeDrop, onStatus, isPathBlocked, onPendingChange }: {
  dropped: string[] | null;
  onConsumeDrop: () => void;
  onStatus: (message: string) => void;
  isPathBlocked: (path: string) => string | null;
  onPendingChange: (pending: boolean) => void;
}) {
  const [reference, setReference] = useState<{ file: ToolkitFile; document: PckDocument } | null>(null);
  const [files, setFiles] = useState<ToolkitFile[]>([]);
  /** Path → the ID picked for a piece whose LOD rows disagree. */
  const [picks, setPicks] = useState<Record<string, number>>({});
  /** Paths the user unticked; every changing row is written unless it is listed here. */
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [recents, setRecents] = useState<string[]>(() => loadRecent(RECENTS_KEY));
  const lastTouched = useRef<number | null>(null);

  const rows = useMemo<SyncRow[]>(() => {
    if (!reference) return [];
    return files.map((file): SyncRow => {
      const base = { file, currentId: null, candidates: [] as Candidate[], targetId: null };
      let currentId: number;
      try { currentId = new MeshPckDocument(file.path, file.name, bufferOf(file.bytes), reference.document).meshId; }
      catch (caught) { return { ...base, problem: caught instanceof Error ? caught.message : "Not a readable mesh.pck.", tone: "problem", label: "UNREADABLE" }; }
      const entries = matchLodEntries(file.name, reference.document);
      if (!entries.length) return { ...base, currentId, problem: `${reference.file.name} has no HLOD/MLOD/LLOD row with this name.`, tone: "problem", label: "NO ROW" };
      const byId = new Map<number, string[]>();
      for (const entry of entries) byId.set(entry.meshId, [...(byId.get(entry.meshId) ?? []), `${entry.lod.toUpperCase()} #${entry.index}`]);
      const candidates = [...byId].map(([id, lods]) => ({ id, lods }));
      const targetId = candidates.length === 1 ? candidates[0].id : picks[key(file.path)] ?? null;
      if (targetId === null) return { ...base, currentId, candidates, problem: null, tone: "pick", label: "PICK AN ID" };
      if (targetId > 0xff) return { ...base, currentId, candidates, problem: `The table ID ${hex(targetId, 4)} doesn't fit the loose file's single ID byte.`, tone: "problem", label: "TOO LARGE" };
      return targetId === currentId
        ? { ...base, currentId, candidates, problem: null, tone: "match", label: "MATCHES", targetId }
        : { ...base, currentId, candidates, problem: null, tone: "change", label: "WILL CHANGE", targetId };
    });
  }, [files, picks, reference]);

  const writable = rows.filter((row) => row.tone === "change" && !skipped.has(key(row.file.path)));
  useEffect(() => { onPendingChange(writable.length > 0); }, [writable.length, onPendingChange]);

  const loadReference = useCallback(async (path: string) => {
    if (isMeshPckName(path)) { setError("That is a loose mesh piece. The reference is the car PCK whose LOD tables hold the IDs."); return; }
    const blocked = isPathBlocked(path);
    if (blocked) { setError(blocked); return; }
    try {
      setBusy(true); setError("");
      const file = await readToolkitFile(path);
      setReference({ file, document: openCarPck(file.name, file.bytes) });
      setRecents(pushRecent(RECENTS_KEY, file.path));
      onStatus(`${file.name} loaded as the ID reference`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not read that car PCK.");
    } finally { setBusy(false); }
  }, [isPathBlocked, onStatus]);

  const addFiles = useCallback(async (paths: string[]) => {
    const accepted = paths.filter(isMeshPckName);
    if (!accepted.length) { setError("Only loose *.mesh.pck pieces can be added."); return; }
    const blocked = accepted.map(isPathBlocked).find(Boolean);
    if (blocked) { setError(blocked); return; }
    try {
      setBusy(true); setError("");
      const opened = await Promise.all(accepted.map(readToolkitFile));
      setFiles((current) => {
        const byPath = new Map(current.map((file) => [key(file.path), file]));
        for (const file of opened) byPath.set(key(file.path), file);
        return [...byPath.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      });
      const ignored = paths.length - accepted.length;
      onStatus(`${opened.length} mesh piece${opened.length === 1 ? "" : "s"} added${ignored ? ` · ${ignored} non-mesh file${ignored === 1 ? "" : "s"} skipped` : ""}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Those pieces could not be read.");
    } finally { setBusy(false); }
  }, [isPathBlocked, onStatus]);

  const addFolder = useCallback(async (folder: string) => {
    try {
      const paths = await listMeshPcks(folder);
      if (!paths.length) { setError(`No *.mesh.pck pieces in ${basename(folder) || folder}.`); return; }
      await addFiles(paths);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not list that folder."); }
  }, [addFiles]);

  useEffect(() => {
    if (!dropped) return;
    const paths = [...dropped];
    onConsumeDrop();
    const meshes = paths.filter(isMeshPckName);
    const car = paths.find((path) => /\.pck$/i.test(path) && !isMeshPckName(path));
    const folders = paths.filter((path) => !/\.[^\\/]+$/.test(basename(path)));
    if (car) void loadReference(car);
    if (meshes.length) void addFiles(meshes);
    for (const folder of folders) void addFolder(folder);
    if (!car && !meshes.length && !folders.length) setError("Drop a car PCK, loose *.mesh.pck pieces, or a folder of them.");
  }, [dropped, addFiles, addFolder, loadReference, onConsumeDrop]);

  const toggle = (index: number, shiftKey: boolean) => {
    const row = rows[index]; if (!row || row.tone !== "change") return;
    const on = skipped.has(key(row.file.path));
    const previous = lastTouched.current;
    lastTouched.current = index;
    const span = shiftKey && previous !== null ? rows.slice(Math.min(index, previous), Math.max(index, previous) + 1) : [row];
    setSkipped((current) => {
      const next = new Set(current);
      for (const item of span) if (item.tone === "change") on ? next.delete(key(item.file.path)) : next.add(key(item.file.path));
      return next;
    });
  };

  const save = useCallback(async () => {
    if (!reference || !writable.length) return;
    const blocked = writable.map((row) => isPathBlocked(row.file.path)).find(Boolean);
    if (blocked) { setError(blocked); return; }
    let written = 0;
    try {
      setBusy(true); setError("");
      const reopened = new Map<string, ToolkitFile>();
      for (const row of writable) {
        const document = new MeshPckDocument(row.file.path, row.file.name, bufferOf(row.file.bytes), reference.document);
        document.setMeshId(row.targetId!, false);
        await writeVerified(row.file.path, document.bytes);
        written += 1;
        reopened.set(key(row.file.path), await readToolkitFile(row.file.path));
      }
      setFiles((current) => current.map((file) => reopened.get(key(file.path)) ?? file));
      setSkipped(new Set());
      onStatus(`${written} mesh piece${written === 1 ? "" : "s"} saved with the ${reference.file.name} ID`);
    } catch (caught) {
      setError(`${written ? `${written} file${written === 1 ? " was" : "s were"} saved before this failed. ` : ""}${caught instanceof Error ? caught.message : "The pieces could not be saved."}`);
    } finally { setBusy(false); }
  }, [isPathBlocked, onStatus, reference, writable]);

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "s") return;
      event.preventDefault(); void save();
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [save]);

  const count = (tone: SyncRow["tone"]) => rows.filter((row) => row.tone === tone).length;
  const needsPick = count("pick");

  return <>
    <section className="toolkit-hero">
      <div>
        <p className="eyebrow">{tr("PIECE ID FIX")}</p>
        <h2>{tr("Give loose pieces the car's IDs")}</h2>
        <p className="toolkit-hero-copy"><Tx t="Reads the ID of each piece's HLOD/MLOD/LLOD row in a car PCK and writes it into the loose {0} of the same name — the step after renaming converted pieces or copies to the names the car expects. The car PCK is only read." v={[<code>*.mesh.pck</code>]} /></p>
      </div>
      <div className="toolkit-facts">
        <div><span>{tr("INPUT")}</span><strong>{tr("One car PCK + loose pieces")}</strong></div>
        <div><span>{tr("WRITES")}</span><strong>{tr("The piece ID byte (0x86)")}</strong></div>
        <div><span>{tr("ON SAVE")}</span><strong>{tr("Changed files only, verified")}</strong></div>
      </div>
    </section>

    <section className="toolkit-panel">
      <div className="toolkit-panel-head">
        <div><span className="step-number">01</span><div><h3>{tr("Select the car PCK")}</h3><p>{tr("Where the IDs come from. Any of the car's PCKs works; it is never saved.")}</p></div></div>
        <span className="toolkit-required">{tr("REQUIRED")}</span>
      </div>
      <div className="toolkit-file-row">
        <button className="toolkit-drop" type="button" disabled={busy} title={reference?.file.path ?? tr("Choose a car PCK")} onClick={() => void pickFiles(pckFilters, false, reference ? parentPath(reference.file.path) : undefined).then((paths) => paths[0] && loadReference(paths[0]))}>
          <span className="toolkit-file-type">{tr("PCK")}</span>
          <span className="toolkit-drop-copy">
            <strong>{reference ? reference.file.name : tr("Choose a car PCK")}</strong>
            <small>{reference ? tr(`${sizeLabel(reference.file.bytes.length)} · ${reference.document.lodMeshes.length} LOD rows · in ${parentFolder(reference.file.path)}`) : tr("Click to browse, or drag one onto the window")}</small>
          </span>
          <span className="toolkit-drop-action">{reference ? tr("CHANGE") : tr("+ OPEN")}</span>
        </button>
        <RecentList title={tr("Recent car PCKs")} paths={recents} activePath={reference?.file.path} busy={busy} onPick={(path) => void loadReference(path)} onClear={() => { saveRecent(RECENTS_KEY, []); setRecents([]); }} />
      </div>
    </section>

    <section className="toolkit-panel">
      <div className="toolkit-panel-head">
        <div><span className="step-number">02</span><div><h3>{tr("Add the loose pieces")}</h3><p>{tr("Named the way the car expects them.")}</p></div></div>
        <span className="toolkit-required">{tr("REQUIRED")}</span>
      </div>
      <div className="toolkit-file-row">
        <button className="toolkit-drop" type="button" disabled={busy} onClick={() => void pickFiles(meshFilters, true, files.length ? parentPath(files[0].path) : reference ? parentPath(reference.file.path) : undefined).then((paths) => { if (paths.length) void addFiles(paths); })}>
          <span className="toolkit-file-type">{tr("MESH")}</span>
          <span className="toolkit-drop-copy">
            <strong>{files.length ? tr(`${files.length} piece${files.length === 1 ? "" : "s"} loaded`) : tr("Choose *.mesh.pck files")}</strong>
            <small>{files.length ? tr("Click to add more, or drop files or a folder on the window") : tr("Click to browse, or drag files or a folder onto the window")}</small>
          </span>
          <span className="toolkit-drop-action">{files.length ? tr("+ ADD") : tr("+ OPEN")}</span>
        </button>
        <div className="toolkit-chip-list">
          {reference && <button className="link-button" type="button" disabled={busy} onClick={() => void addFolder(parentPath(reference.file.path))}><Tx t="Add every piece in {0}" v={[parentFolder(reference.file.path) || tr("the car's folder")]} /></button>}
          {files.length > 0 && <button className="link-button" type="button" onClick={() => { setFiles([]); setPicks({}); setSkipped(new Set()); }}>{tr("Clear all")}</button>}
        </div>
      </div>
    </section>

    <section className="toolkit-panel">
      <div className="toolkit-panel-head">
        <div><span className="step-number">03</span><div><h3>{tr("Review the IDs")}</h3><p>{tr("Pieces whose ID differs are written. Untick one to leave it; shift-click selects a range.")}</p></div></div>
        {rows.length > 0 && <div className="toolkit-chips">
          <span><Tx t="{0} to change" v={[<strong>{count("change")}</strong>]} /></span>
          <span><Tx t="{0} match" v={[<strong>{count("match")}</strong>]} /></span>
          {needsPick > 0 && <span className="prior"><Tx t="{0} need a pick" v={[<strong>{needsPick}</strong>]} /></span>}
          {count("problem") > 0 && <span className="prior"><Tx t="{0} can't sync" v={[<strong>{count("problem")}</strong>]} /></span>}
        </div>}
      </div>
      {!reference || !files.length ? (
        <div className="toolkit-empty"><span>{tr("ID")}</span><strong>{reference || files.length ? tr("Add the other half too") : tr("Nothing loaded yet")}</strong><p>{tr("The pieces are listed once a car PCK and at least one loose piece are loaded.")}</p></div>
      ) : <div className="inject-table">
        <div className="inject-row head"><span /><span>{tr("PIECE")}</span><span>{tr("LOD ROWS")}</span><span>{tr("ID")}</span><span>{tr("STATUS")}</span></div>
        {rows.map((row, index) => {
          const checked = row.tone === "change" && !skipped.has(key(row.file.path));
          return <div key={row.file.path} className={`inject-row ${row.tone === "problem" ? "problem" : row.tone === "change" && !checked ? "off" : ""}`} onClick={(event) => toggle(index, event.shiftKey)}>
            <span><input type="checkbox" checked={checked} disabled={row.tone !== "change"} readOnly /></span>
            <span title={row.file.path}><strong>{row.file.name}</strong><small>{row.problem ?? parentFolder(row.file.path)}</small></span>
            <span>{row.candidates.flatMap((candidate) => candidate.lods).join(" · ") || "—"}</span>
            <span>
              {row.tone === "pick" || (row.candidates.length > 1 && row.tone !== "problem")
                ? <select aria-label={tr(`ID for ${row.file.name}`)} value={row.targetId ?? ""} onClick={(event) => event.stopPropagation()} onChange={(event) => setPicks((current) => ({ ...current, [key(row.file.path)]: Number(event.target.value) }))}>
                  <option value="" disabled>{row.currentId === null ? tr("pick…") : tr(`${hex(row.currentId, 2)} → pick…`)}</option>
                  {row.candidates.map((candidate) => <option key={candidate.id} value={candidate.id}>{hex(candidate.id, 2)} · {candidate.lods.join(", ")}</option>)}
                </select>
                : row.currentId === null ? "—"
                  : row.targetId === null || row.targetId === row.currentId ? hex(row.currentId, 2)
                    : `${hex(row.currentId, 2)} → ${hex(row.targetId, 2)}`}
            </span>
            <span><em className={`inject-status ${row.tone === "change" ? "insert" : row.tone === "match" ? "current" : row.tone === "pick" ? "replace" : "problem"}`}>{tr(row.label)}</em></span>
          </div>;
        })}
      </div>}
    </section>

    {rows.length > 0 && <section className="toolkit-actions">
      <div>
        <strong>{writable.length ? tr(`${writable.length} piece${writable.length === 1 ? "" : "s"} will get a new ID`) : tr("Nothing to write")}</strong>
        <small>{needsPick
          ? tr(`${needsPick} piece${needsPick === 1 ? " has" : "s have"} LOD rows that disagree on the ID — pick one in its row, or it is left as it is.`)
          : writable.length ? tr("Each file is overwritten in place, then read back and compared byte for byte.") : tr("Every listed piece already carries its row's ID.")}</small>
      </div>
      <button className="toolkit-primary" type="button" disabled={busy || !writable.length} onClick={() => void save()}>
        {busy ? tr("SAVING…") : tr(`SAVE ${writable.length} FILE${writable.length === 1 ? "" : "S"}`)}<span>→</span>
      </button>
    </section>}

    {error && <section className="toolkit-error"><span>!</span><div><strong>{tr("Action required")}</strong><p>{tr(error)}</p></div></section>}
  </>;
}
