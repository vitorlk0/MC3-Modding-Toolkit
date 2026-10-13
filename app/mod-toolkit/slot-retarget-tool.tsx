import { tr, Tx } from "../i18n";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { join } from "@tauri-apps/api/path";
import { readPackageFiles } from "../iso-io";
import { readZip } from "../../src/zip-read";
import { writeZip } from "../../src/zip-write";
import { readRetargetSource, retargetPackage, retargetSlots, type RetargetLevel, type RetargetResult, type RetargetSource } from "../../src/slot-retarget";
import { classLabel, elfMentions, SLOT_REFERENCE } from "../../src/slot-reference";
import { basename, parentPath, pickFiles, sizeLabel, writeVerified } from "./toolkit-io";
import { loadRecent, pushRecent, saveRecent } from "../recent-paths";
import { RecentList } from "./toolkit-ui";

/**
 * Slot Retarget — takes a downloaded car mod (ZIP) made for one slot and writes a new ZIP that
 * installs it over another slot of the original MC3, ready for the ISO Install tab. Nothing in the
 * game is touched here, and the source ZIP is only read: the work is src/slot-retarget.ts, the
 * output is written only where the user saves it, then read back and compared.
 */

const RECENTS_KEY = "mc3pae.recentRetargetPackages";
const zipFilters = [{ name: "Car mod package", extensions: ["zip"] }];
const LEVELS: { level: RetargetLevel; title: string }[] = [
  { level: "block", title: "Blocked" },
  { level: "warn", title: "Warnings" },
  { level: "fix", title: "Converted for the original MC3" },
  { level: "ok", title: "Checks passed" },
  { level: "info", title: "Notes" },
];
const levelTag: Record<RetargetLevel, string> = { block: "BLOCK", warn: "WARN", fix: "FIX", ok: "OK", info: "INFO" };

type Loaded = { path: string; source: RetargetSource };

export function SlotRetargetTool({ dropped, onConsumeDrop, onStatus }: {
  dropped: string[] | null;
  onConsumeDrop: () => void;
  onStatus: (message: string) => void;
}) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [target, setTarget] = useState("");
  const [result, setResult] = useState<RetargetResult | null>(null);
  const [recents, setRecents] = useState<string[]>(() => loadRecent(RECENTS_KEY));
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [busy, setBusy] = useState(false);
  const run = useRef(0);

  const slots = useMemo(() => retargetSlots(), []);
  // Typing narrows the list: spaces, underscores and the vp_ prefix don't matter ("is 300" finds
  // vp_is300_04), and the class counts too ("tuner"). Enter picks the first slot left.
  const [filter, setFilter] = useState("");
  const squash = (text: string) => text.toLowerCase().replace(/^vp_/, "").replace(/[^a-z0-9]/g, "");
  const byClass = useMemo(() => {
    const query = squash(filter);
    const groups = new Map<string, typeof slots>();
    for (const slot of [...slots].sort((a, b) => a.name.localeCompare(b.name))) {
      const label = classLabel(slot.className);
      if (query && !squash(slot.name).includes(query) && !squash(label).includes(query)) continue;
      groups.set(label, [...(groups.get(label) ?? []), slot]);
    }
    return [...groups].sort(([a], [b]) => a.localeCompare(b));
  }, [slots, filter]);

  const load = useCallback(async (path: string) => {
    try {
      setBusy(true); setError(""); setSaved(""); setResult(null); setLoaded(null); setTarget("");
      const files = await readPackageFiles(path);
      const source = await readRetargetSource(basename(path), files);
      setLoaded({ path, source });
      setRecents(pushRecent(RECENTS_KEY, path));
      onStatus(`${source.car} · ${files.length} files in the package`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not read that package.");
    } finally { setBusy(false); }
  }, [onStatus]);

  useEffect(() => {
    if (!dropped) return;
    const paths = dropped;
    onConsumeDrop();
    if (paths.length) void load(paths[0]);
  }, [dropped, onConsumeDrop, load]);

  const pickPackage = async () => {
    const [path] = await pickFiles(zipFilters, false, loaded?.path);
    if (path) void load(path);
  };

  const chooseTarget = useCallback(async (name: string) => {
    setTarget(name); setResult(null); setSaved(""); setError("");
    if (!loaded || !name) return;
    const id = ++run.current;
    try {
      setBusy(true);
      const converted = await retargetPackage(basename(loaded.path), loaded.source, name);
      if (id !== run.current) return;
      setResult(converted);
      onStatus(converted.blocked ? `${loaded.source.car} → ${name}: blocked` : `${loaded.source.car} → ${name}: ready to save`);
    } catch (caught) {
      if (id === run.current) setError(caught instanceof Error ? caught.message : "The package could not be converted.");
    } finally { if (id === run.current) setBusy(false); }
  }, [loaded, onStatus]);

  const saveZip = useCallback(async () => {
    if (!loaded || !result || result.blocked) return;
    try {
      setBusy(true); setError(""); setSaved("");
      const stem = basename(loaded.path).replace(/\.zip$/i, "");
      // Next to the package (or, for a folder, next to the folder) — never inside a mod folder.
      const path = await saveDialog({ defaultPath: await join(parentPath(loaded.path) || loaded.path, `${stem} (${result.target}).zip`), filters: zipFilters });
      if (!path) return;
      if (path.replace(/\//g, "\\").toLowerCase() === loaded.path.replace(/\//g, "\\").toLowerCase()) { setError("Save the converted mod as a new ZIP — the original package is kept as it is."); return; }
      const zip = await writeZip(result.files.map((file) => ({ path: file.path, bytes: file.bytes })));
      // Prove the archive before it is written: every member reads back as the converted file.
      const members = readZip(zip, basename(path));
      if (members.length !== result.files.length) throw new Error("The ZIP didn't list every file; nothing was written.");
      for (const [index, member] of members.entries()) {
        const expected = result.files[index].bytes, actual = await member.read();
        if (member.path !== result.files[index].path || actual.length !== expected.length || actual.some((value, i) => value !== expected[i])) throw new Error(`${member.path} didn't pack correctly; nothing was written.`);
      }
      await writeVerified(path, zip);
      const message = `Saved ${basename(path)} · ${result.files.length} files · ${sizeLabel(zip.length)} — install it with the ISO Install tab.`;
      setSaved(message);
      onStatus(message);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The ZIP could not be saved.");
    } finally { setBusy(false); }
  }, [loaded, result, onStatus]);

  const source = loaded?.source;
  const targetSlot = slots.find((slot) => slot.name === target) ?? null;
  const counts = result ? {
    converted: result.files.filter((file) => file.change === "converted").length,
    renamed: result.files.filter((file) => file.change === "renamed").length,
    unchanged: result.files.filter((file) => file.change === "unchanged").length,
  } : null;

  return <>
    <section className="toolkit-hero">
      <div>
        <p className="eyebrow">{tr("CAR MOD ZIP → ANOTHER SLOT")}</p>
        <h2>{tr("Move a car mod onto another car's slot")}</h2>
        <p className="toolkit-hero-copy"><Tx t="Choose a downloaded car mod and the original car it should replace. The slot's files are renamed, and the menus and {0} files are converted for the original MC3: rims, exhaust tips, plates and paint categories that only exist in the VIP leave the menus. The result is a new ZIP for the ISO Install tab; global game files are never touched, so the car keeps the replaced car's name, logo and price." v={[<code>.carcfg</code>]} /></p>
      </div>
      <div className="toolkit-facts">
        <div><span>{tr("INPUT")}</span><strong>{tr("Car mod ZIP")}</strong></div>
        <div><span>{tr("OUTPUT")}</span><strong>{tr("New ZIP for ISO Install")}</strong></div>
        <div><span>{tr("GAME FILES")}</span><strong>{tr("None — only the mod is read")}</strong></div>
      </div>
    </section>

    <section className="toolkit-panel">
      <div className="toolkit-panel-head">
        <div><span className="step-number">01</span><div><h3>{tr("Choose the car mod")}</h3><p><Tx t="A ZIP with the car's {0} (or its loose folder) and {1}, like the ones ISO Install takes." v={[<code>vp_x.dat</code>, <code>vp_x_g.pck</code>]} /></p></div></div>
        <span className="toolkit-required">{tr("REQUIRED")}</span>
      </div>
      <div className="toolkit-file-row">
        <button className="toolkit-drop" type="button" disabled={busy} onClick={() => void pickPackage()}>
          <span className="toolkit-file-type">{tr("ZIP")}</span>
          <span className="toolkit-drop-copy">
            <strong>{loaded ? basename(loaded.path) : busy ? tr("Reading…") : tr("Choose a mod ZIP")}</strong>
            <small>{source ? <Tx t="Made for {0} · {1} · {2} files" v={[<code>{source.car}</code>, source.className ? classLabel(source.className) : tr("class unknown"), source.files.length]} /> : tr("Click to browse, or drop it on the window")}</small>
          </span>
          <span className="toolkit-drop-action">{loaded ? tr("CHANGE") : tr("+ OPEN")}</span>
        </button>
        <RecentList title={tr("Recent packages")} paths={recents} activePath={loaded?.path} busy={busy} onPick={(path) => void load(path)} onClear={() => { saveRecent(RECENTS_KEY, []); setRecents([]); }} />
      </div>
    </section>

    <section className="toolkit-panel">
      <div className="toolkit-panel-head">
        <div><span className="step-number">02</span><div><h3>{tr("Choose the slot to replace")}</h3><p>{tr("One of the original game's cars. It is replaced entirely by the mod; only its save identity is kept.")}</p></div></div>
        {targetSlot && <div className="toolkit-chips">
          <span><Tx t="index {0}" v={[<strong>{targetSlot.index}</strong>]} /></span>
          <span className={source?.className && source.className !== targetSlot.className ? "prior" : ""}><strong>{classLabel(targetSlot.className)}</strong></span>
          <span><Tx t="{0} wheels" v={[<strong>{targetSlot.wheels}</strong>]} /></span>
        </div>}
      </div>
      <div className="retarget-pick">
        <input className="retarget-filter" type="search" value={filter} disabled={!loaded || busy} placeholder={tr("Type to filter: is 300, charger, tuner…")} aria-label={tr("Filter slots")}
          onChange={(event) => setFilter(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            const first = byClass.flatMap(([, group]) => group).find((slot) => slot.name !== source?.car);
            if (first) { event.preventDefault(); void chooseTarget(first.name); }
          }} />
        <select className="retarget-select" value={target} disabled={!loaded || busy} onChange={(event) => void chooseTarget(event.target.value)} aria-label={tr("Target slot")}>
          <option value="">{loaded ? tr("Choose a slot…") : tr("Open a mod first")}</option>
          {byClass.map(([label, group]) => <optgroup key={label} label={label}>
            {group.map((slot) => <option key={slot.name} value={slot.name} disabled={slot.name === source?.car}>
              {slot.name}{slot.wheels === 2 ? ` · ${tr("bike")}` : ""}{elfMentions(slot.name).length ? " · ELF" : ""}
            </option>)}
          </optgroup>)}
        </select>
        <p className="retarget-hint">{tr(`Original game: ${SLOT_REFERENCE.slots.length} slots, ${SLOT_REFERENCE.rims.length} rims, ${SLOT_REFERENCE.exhausts.length} exhaust tips. Slots marked ELF are named in the game's code for a special case that wasn't identified.`)}</p>
      </div>
    </section>

    <section className="toolkit-panel">
      <div className="toolkit-panel-head">
        <div><span className="step-number">03</span><div><h3>{tr("Report")}</h3><p>{tr("What the conversion checked and changed.")}</p></div></div>
        {counts && <div className="toolkit-chips">
          <span><Tx t="{0} converted" v={[<strong>{counts.converted}</strong>]} /></span>
          <span><Tx t="{0} renamed" v={[<strong>{counts.renamed}</strong>]} /></span>
          <span><Tx t="{0} unchanged" v={[<strong>{counts.unchanged}</strong>]} /></span>
        </div>}
      </div>
      {!result ? (
        <div className="toolkit-empty"><span>{tr("SLOT")}</span><strong>{busy && target ? tr("Converting…") : tr("No conversion yet")}</strong><p>{tr("The report appears once a mod and a slot are chosen.")}</p></div>
      ) : <div className="retarget-report">
        {LEVELS.map(({ level, title }) => {
          const notes = result.notes.filter((note) => note.level === level);
          if (!notes.length) return null;
          return <div key={level} className={`retarget-group ${level}`}>
            <h4>{tr(title)}</h4>
            {notes.map((note, index) => <p key={index}><em>{levelTag[level]}</em><span>{tr(note.text)}</span></p>)}
          </div>;
        })}
        <details className="toolkit-category">
          <summary>
            <span className="toolkit-category-index">{tr("ZIP")}</span>
            <span><strong>{tr("Files in the new package")}</strong><small>{tr("original path → new path")}</small></span>
            <span className="toolkit-category-count"><Tx t="{0} FILES" v={[result.files.length]} /></span>
            <i />
          </summary>
          <div className="dat-file-list">{result.files.map((file) => <code key={file.path} className={`retarget-file ${file.change}`}>
            {file.path}{file.change !== "unchanged" && file.sourcePath !== file.path && <em> ← {basename(file.sourcePath)}</em>}<em> · {tr(file.change)}</em>
          </code>)}</div>
        </details>
      </div>}
    </section>

    {result && <section className="toolkit-actions">
      <div>
        <strong>{result.blocked ? tr("Can't convert — see the blocked items above") : <Tx t="Save the mod for {0}" v={[result.target]} />}</strong>
        <small>{tr("Written only where you choose, as a new ZIP, then read back and compared. Install it with the ISO Install tab.")}</small>
      </div>
      <div className="carcfg-actions">
        <button className="toolkit-primary" type="button" disabled={busy || result.blocked} onClick={() => void saveZip()}>{busy ? tr("SAVING…") : tr("SAVE ZIP")}<span>→</span></button>
      </div>
    </section>}

    {saved && <section className="iso-result"><span>✓</span><p>{tr(saved)}</p></section>}
    {error && <section className="toolkit-error"><span>!</span><div><strong>{tr("Action required")}</strong><p>{tr(error)}</p></div></section>}
  </>;
}
