import { tr, Tx } from "../i18n";
import { useCallback, useEffect, useMemo, useState } from "react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { join } from "@tauri-apps/api/path";
import { analyzeForCompaction, DEFAULT_RESERVE, layoutCompactImage, writeCompactImage, type CompactAnalysis, type CompactLayout } from "../../src/iso-compact";
import type { RandomFile } from "../../src/iso-install";
import { tauriIsoFs } from "../iso-io";
import { basename, parentFolder, parentPath } from "./toolkit-io";
import { loadRecent, pushRecent, saveRecent } from "../recent-paths";
import { RecentList } from "./toolkit-ui";

/**
 * Compact ISO — turns an original (dual-layer, padded) MC3 image into one packed single-layer ISO
 * with ASSETS.DAT first and free space reserved behind it (src/iso-compact.ts). The source is only
 * read; the result is a new file. This is the step that lets the ISO Install tab grow ASSETS.DAT for
 * as many cars as needed.
 */

const RECENTS_KEY = "mc3pae.recentCompactIsos";
const gigabytes = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(2)} GB`;
const megabytes = (bytes: number) => `${(bytes / 1024 ** 2).toFixed(0)} MB`;

type Loaded = { path: string; analysis: CompactAnalysis };
const RESERVE_CHOICES = [0, 256 * 1024 * 1024, DEFAULT_RESERVE];

export function CompactIsoTool({ dropped, onConsumeDrop, onStatus, onBusyChange }: {
  dropped: string[] | null;
  onConsumeDrop: () => void;
  onStatus: (message: string) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [recents, setRecents] = useState<string[]>(() => loadRecent(RECENTS_KEY));
  const [error, setError] = useState("");
  const [result, setResult] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ phase: string; done: number; total: number } | null>(null);
  const [reserve, setReserve] = useState(DEFAULT_RESERVE);
  const planned = useMemo((): { layout: CompactLayout | null; failure: string } => {
    if (!loaded) return { layout: null, failure: "" };
    try { return { layout: layoutCompactImage(loaded.analysis, reserve), failure: "" }; }
    catch (caught) { return { layout: null, failure: caught instanceof Error ? caught.message : "The layout failed." }; }
  }, [loaded, reserve]);

  useEffect(() => { onBusyChange(progress !== null); }, [progress, onBusyChange]);

  const load = useCallback(async (path: string) => {
    let file: RandomFile | null = null;
    try {
      setBusy(true); setError(""); setResult(""); setLoaded(null);
      file = await tauriIsoFs.openRead(path);
      const analysis = await analyzeForCompaction(file);
      setLoaded({ path, analysis });
      setRecents(pushRecent(RECENTS_KEY, path));
      onStatus(`${basename(path)} · ${analysis.files.length} files · ${gigabytes(analysis.dataBytes)} of data`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not read that ISO.");
    } finally {
      await file?.close().catch(() => undefined);
      setBusy(false);
    }
  }, [onStatus]);

  useEffect(() => {
    if (!dropped) return;
    const iso = dropped.find((path) => /\.iso$/i.test(path));
    onConsumeDrop();
    if (iso && !progress) void load(iso);
    else if (!iso) setError("Drop a .iso file.");
  }, [dropped, onConsumeDrop, load, progress]);

  const pickIso = async () => {
    const selection = await openDialog({ multiple: false, filters: [{ name: "PS2 disc image", extensions: ["iso"] }], defaultPath: loaded?.path });
    if (typeof selection === "string") void load(selection);
  };

  const compact = useCallback(async () => {
    const layout = planned.layout;
    if (!loaded || !layout) return;
    const suggested = basename(loaded.path).replace(/\.iso$/i, "") + " (Compact).iso";
    const target = await saveDialog({ defaultPath: await join(parentPath(loaded.path), suggested), filters: [{ name: "PS2 disc image", extensions: ["iso"] }] });
    if (!target) return;
    setError(""); setResult("");
    setBusy(true);
    setProgress({ phase: "Starting", done: 0, total: 1 });
    const started = performance.now();
    try {
      await writeCompactImage(tauriIsoFs, loaded.path, target, loaded.analysis, layout, (phase, done, total) => setProgress({ phase, done, total }));
      const seconds = ((performance.now() - started) / 1000).toFixed(0);
      const message = `${basename(target)} written in ${seconds}s · ${gigabytes(layout.outputSize)} · ${megabytes(layout.reserveBytes)} reserved for mods · every file verified`;
      setResult(message);
      onStatus(message);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The ISO could not be compacted.");
    } finally {
      setProgress(null);
      setBusy(false);
    }
  }, [loaded, planned, onStatus]);

  const analysis = loaded?.analysis;
  const layout = planned.layout;
  return <>
    <section className="toolkit-hero">
      <div>
        <p className="eyebrow">{tr("ORIGINAL ISO → COMPACT ISO")}</p>
        <h2>{tr("Pack the original disc image into a single-layer ISO")}</h2>
        <p className="toolkit-hero-copy"><Tx t="The original MC3 image is a dual-layer DVD with ~2.9 GB of zeros used to place files on the physical disc. The game finds files by name, so that padding only takes space — and it leaves no room for ASSETS.DAT to grow. This writes a new ISO with every file byte for byte, both layers merged into one tree and no padding, with {0} first and free space reserved right after it: the ISO Install tab grows it into that space without moving anything. The original is only read." v={[<code>ASSETS.DAT</code>]} /></p>
      </div>
      <div className="toolkit-facts">
        <div><span>{tr("INPUT")}</span><strong>{tr("Original .iso (dual-layer)")}</strong></div>
        <div><span>{tr("OUTPUT")}</span><strong>{tr("New … (Compact).iso")}</strong></div>
        <div><span>{tr("EDITS")}</span><strong>{tr("None — the original is only read")}</strong></div>
      </div>
    </section>

    <section className="toolkit-panel">
      <div className="toolkit-panel-head">
        <div><span className="step-number">01</span><div><h3>{tr("Open the original ISO")}</h3><p>{tr("Midnight Club 3 as dumped from the disc.")}</p></div></div>
        <span className="toolkit-required">{tr("REQUIRED")}</span>
      </div>
      <div className="toolkit-file-row">
        <button className="toolkit-drop" type="button" disabled={busy} onClick={() => void pickIso()}>
          <span className="toolkit-file-type">{tr("ISO")}</span>
          <span className="toolkit-drop-copy">
            <strong>{loaded ? basename(loaded.path) : busy ? tr("Reading…") : tr("Choose an ISO")}</strong>
            <small>{loaded ? `${gigabytes(loaded.analysis.sourceSize)} · ${parentFolder(loaded.path)}` : tr("Click to browse, or drop it on the window")}</small>
          </span>
          <span className="toolkit-drop-action">{loaded ? tr("CHANGE") : tr("+ OPEN")}</span>
        </button>
        <RecentList title={tr("Recent ISOs")} paths={recents} activePath={loaded?.path} busy={busy} onPick={(path) => void load(path)} onClear={() => { saveRecent(RECENTS_KEY, []); setRecents([]); }} />
      </div>
    </section>

    <section className="toolkit-panel">
      <div className="toolkit-panel-head">
        <div><span className="step-number">02</span><div><h3>{tr("What changes")}</h3><p>{tr("Same files, less space.")}</p></div></div>
        {layout && analysis && <div className="toolkit-chips">
          <span><Tx t="{0} now" v={[<strong>{gigabytes(analysis.sourceSize)}</strong>]} /></span>
          <span><Tx t="{0} compact" v={[<strong>{gigabytes(layout.outputSize)}</strong>]} /></span>
          <span className="prior"><Tx t="{0} for mods" v={[<strong>{megabytes(layout.reserveBytes)}</strong>]} /></span>
        </div>}
      </div>
      {analysis && !layout ? (
        <p className="carcfg-warning iso-plan-error">{planned.failure}</p>
      ) : !analysis || !layout ? (
        <div className="toolkit-empty"><span>{tr("ISO")}</span><strong>{tr("No ISO yet")}</strong><p>{tr("The analysis appears once an ISO is open.")}</p></div>
      ) : <div className="compact-facts">
        <div><span>{tr("Layers")}</span><strong>{analysis.volumes.length === 2 ? tr("2 (dual-layer DVD)") : "1"}</strong></div>
        {analysis.volumes.map((volume, index) => <div key={volume.lbaBase}><span><Tx t="Layer {0} volume" v={[index + 1]} /></span><strong><Tx t="{0} · {1} files" v={[volume.volumeId, volume.files]} /></strong></div>)}
        <div><span>{tr("Real data")}</span><strong><Tx t="{0} in {1} files, {2} folders" v={[gigabytes(analysis.dataBytes), analysis.files.length, analysis.directories.length - 1]} /></strong></div>
        <div><span>{tr("Removed padding")}</span><strong>{megabytes(analysis.sourceSize - layout.outputSize + layout.reserveBytes)}</strong></div>
        <div><span>{tr("Order on disc")}</span><strong><Tx t="ASSETS.DAT → {0} free → other files → videos" v={[megabytes(layout.reserveBytes)]} /></strong></div>
        <div className="compact-reserve"><span>{tr("Space for mods")}</span><div>
          {RESERVE_CHOICES.map((bytes) => <button key={bytes} type="button" disabled={busy} className={bytes === reserve ? "active" : ""} onClick={() => setReserve(bytes)}>{bytes ? megabytes(bytes) : tr("None")}</button>)}
          <small>{reserve ? tr(`About ${Math.floor(reserve / (4 * 1024 * 1024))} cars at ~4 MB each before an install has to move other files.`) : tr("Every install that grows ASSETS.DAT will rewrite the whole ISO.")}</small>
        </div></div>
        {analysis.notes.map((note) => <p className="carcfg-note" key={tr(note)}>{tr(note)}</p>)}
        {analysis.volumes.length === 1 && analysis.sourceSize - layout.outputSize < 1024 * 1024 && <p className="carcfg-warning">{tr("This image is already compact — there is almost nothing to remove.")}</p>}
      </div>}
    </section>

    {loaded && layout && <section className="toolkit-actions">
      <div>
        <strong>{progress ? tr(progress.phase) : tr("Write the compact ISO")}</strong>
        {progress
          ? <div className="iso-progress"><div style={{ width: `${Math.min(100, (progress.done / Math.max(1, progress.total)) * 100)}%` }} /></div>
          : <small><Tx t="Saved as a new file you choose, then read back and checked file by file. Needs about {0} of free disk space." v={[gigabytes(layout.outputSize)]} /></small>}
      </div>
      <button className="toolkit-primary" type="button" disabled={busy} onClick={() => void compact()}>{progress ? tr("WRITING…") : tr("COMPACT")}<span>→</span></button>
    </section>}

    {result && <section className="iso-result"><span>✓</span><p>{tr(result)}</p></section>}
    {error && <section className="toolkit-error"><span>!</span><div><strong>{tr("Action required")}</strong><p>{tr(error)}</p></div></section>}
  </>;
}
