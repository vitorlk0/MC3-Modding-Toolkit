import { tr, Tx, confirmDialog } from "../i18n";
import { useCallback, useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { exists, mkdir, readFile } from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";
import { daveKey, readDave, readEntry, type DaveArchive, type DaveEntry } from "../../src/dave";
import { memoryReader } from "../../src/iso9660";
import { basename, parentPath, sizeLabel, writeVerified } from "./toolkit-io";
import { loadRecent, pushRecent, saveRecent } from "../recent-paths";
import { RecentList } from "./toolkit-ui";

/**
 * Extract half of tool 07: unpacks a `vp_*.dat` back into a car folder in the HostFS layout, the
 * reverse of the build half. Every original car DAT keeps its files under `resources/vehicle/vp_x/`,
 * so they land in `<chosen folder>/vp_x/` with that prefix taken off; anything outside it keeps its
 * full path. The DAT is only read (src/dave.ts); each file is written and read back.
 */

const RECENTS_KEY = "mc3pae.recentDatExtractFiles";

type Member = { entry: DaveEntry; path: string };
type Opened = { path: string; car: string; archive: DaveArchive; members: Member[] };

export function DatExtractPanel({ droppedDat, onConsumeDrop, onStatus }: {
  droppedDat: string | null;
  onConsumeDrop: () => void;
  onStatus: (message: string) => void;
}) {
  const [opened, setOpened] = useState<Opened | null>(null);
  const [recents, setRecents] = useState<string[]>(() => loadRecent(RECENTS_KEY));
  const [error, setError] = useState("");
  const [result, setResult] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (path: string) => {
    try {
      setBusy(true); setError(""); setResult(""); setOpened(null);
      const archive = await readDave(memoryReader(await readFile(path)), basename(path));
      const car = basename(path).replace(/\.dat$/i, "").toLowerCase();
      const prefix = `resources/vehicle/${car}/`;
      const members = archive.entries.filter((entry) => !entry.isDir).map((entry) => {
        const key = daveKey(entry.name);
        return { entry, path: key.startsWith(prefix) ? key.slice(prefix.length) : key };
      });
      if (!members.length) { setError(`${basename(path)} has no files in it.`); return; }
      setOpened({ path, car, archive, members });
      setRecents(pushRecent(RECENTS_KEY, path));
      onStatus(`${basename(path)} · ${members.length} files`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not read that DAT.");
    } finally { setBusy(false); }
  }, [onStatus]);

  useEffect(() => {
    if (!droppedDat) return;
    onConsumeDrop();
    void load(droppedDat);
  }, [droppedDat, onConsumeDrop, load]);

  const pickDat = async () => {
    const selection = await openDialog({ multiple: false, defaultPath: opened?.path, filters: [{ name: "Vehicle DAT", extensions: ["dat"] }] });
    if (typeof selection === "string") void load(selection);
  };

  const extract = useCallback(async () => {
    if (!opened) return;
    try {
      setBusy(true); setError(""); setResult("");
      const destination = await openDialog({ directory: true, multiple: false, defaultPath: parentPath(opened.path) || undefined });
      if (typeof destination !== "string") return;
      const folder = await join(destination, opened.car);
      const targets = await Promise.all(opened.members.map(async (member) => ({ member, target: await join(folder, ...member.path.split("/")) })));
      const taken = (await Promise.all(targets.map(async ({ target }) => (await exists(target)) ? target : null))).filter((target): target is string => target !== null);
      if (taken.length && !await confirmDialog(`${taken.length} of these files already exist in ${folder}. Overwrite them?`, { title: "Extract DAT", kind: "warning" })) return;
      let bytes = 0;
      for (const { member, target } of targets) {
        const content = await readEntry(opened.archive, member.entry);
        await mkdir(parentPath(target), { recursive: true });
        await writeVerified(target, content);
        bytes += content.length;
      }
      const message = `${basename(opened.path)} extracted · ${targets.length} files · ${sizeLabel(bytes)} · ${folder}`;
      setResult(message);
      onStatus(message);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The DAT could not be extracted.");
    } finally { setBusy(false); }
  }, [opened, onStatus]);

  return <>
    <section className="toolkit-hero">
      <div>
        <p className="eyebrow">{tr("VEHICLE DAT → HOSTFS FOLDER")}</p>
        <h2>{tr("Unpack a vp_*.dat into a car folder")}</h2>
        <p className="toolkit-hero-copy"><Tx t="Open a car's DAT. Its files come out in a {0} folder inside the folder you choose, the layout the game reads from HostFS, ready to edit and build again." v={[<code>vp_x/</code>]} /></p>
      </div>
      <div className="toolkit-facts">
        <div><span>{tr("INPUT")}</span><strong>{tr("vp_*.dat")}</strong></div>
        <div><span>{tr("OUTPUT")}</span><strong>{tr("Car folder (HostFS layout)")}</strong></div>
        <div><span>{tr("EDITS")}</span><strong>{tr("None — the DAT is only read")}</strong></div>
      </div>
    </section>

    <section className="toolkit-panel">
      <div className="toolkit-panel-head">
        <div><span className="step-number">01</span><div><h3>{tr("Choose the DAT")}</h3><p><Tx t="A car's {0}, from ASSETS or a mod ZIP." v={[<code>vp_x.dat</code>]} /></p></div></div>
        <span className="toolkit-required">{tr("REQUIRED")}</span>
      </div>
      <div className="toolkit-file-row">
        <button className="toolkit-drop" type="button" disabled={busy} onClick={() => void pickDat()}>
          <span className="toolkit-file-type">{tr("DAT")}</span>
          <span className="toolkit-drop-copy">
            <strong>{opened ? basename(opened.path) : busy ? tr("Reading…") : tr("Choose a DAT")}</strong>
            <small>{opened ? opened.path : tr("Click to browse, or drop it on the window")}</small>
          </span>
          <span className="toolkit-drop-action">{opened ? tr("CHANGE") : tr("+ OPEN")}</span>
        </button>
        <RecentList title={tr("Recent DATs")} paths={recents} activePath={opened?.path} busy={busy} onPick={(path) => void load(path)} onClear={() => { saveRecent(RECENTS_KEY, []); setRecents([]); }} />
      </div>
    </section>

    <section className="toolkit-panel">
      <div className="toolkit-panel-head">
        <div><span className="step-number">02</span><div><h3>{tr("Contents")}</h3><p>{tr("The files that come out, with their sizes.")}</p></div></div>
        {opened && <div className="toolkit-chips"><span><Tx t="{0} files" v={[<strong>{opened.members.length}</strong>]} /></span></div>}
      </div>
      {!opened ? (
        <div className="toolkit-empty"><span>{tr("DAT")}</span><strong>{tr("No DAT yet")}</strong><p>{tr("The list appears once a DAT is chosen.")}</p></div>
      ) : <div className="toolkit-category-list">
        <details className="toolkit-category" open>
          <summary>
            <span className="toolkit-category-index">{tr("OUT")}</span>
            <span><strong><Tx t="Extracted to {0}/" v={[opened.car]} /></strong><small>{tr("inside the folder you choose")}</small></span>
            <span className="toolkit-category-count"><Tx t="{0} FILES" v={[opened.members.length]} /></span>
            <i />
          </summary>
          <div className="dat-file-list">{[...opened.members].sort((a, b) => a.path.localeCompare(b.path)).map((member) => <code key={member.path}>{member.path} <em>— {sizeLabel(member.entry.sizeFull)}</em></code>)}</div>
        </details>
      </div>}
    </section>

    {opened && <section className="toolkit-actions">
      <div>
        <strong><Tx t="Extract {0}" v={[basename(opened.path)]} /></strong>
        <small>{tr("Asks before overwriting files that are already there. Each file is read back after it is written.")}</small>
      </div>
      <div className="carcfg-actions">
        <button className="toolkit-primary" type="button" disabled={busy} onClick={() => void extract()}>{busy ? tr("EXTRACTING…") : tr("EXTRACT DAT")}<span>→</span></button>
      </div>
    </section>}

    {result && <section className="iso-result"><span>✓</span><p>{tr(result)}</p></section>}
    {error && <section className="toolkit-error"><span>!</span><div><strong>{tr("Action required")}</strong><p>{tr(error)}</p></div></section>}
  </>;
}
