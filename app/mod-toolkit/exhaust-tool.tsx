import { tr, Tx } from "../i18n";
import { useCallback, useEffect, useMemo, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { join } from "@tauri-apps/api/path";
import { readDir } from "@tauri-apps/plugin-fs";
import { PckDocument } from "../../src/pck";
import { applyExhaustChoices, readExhaustSetup, type ExhaustChoices, type ExhaustEditResult, type ExhaustGroup, type ExhaustSetup } from "../../src/exhausts";
import { basename, isMeshPckName, parentPath, readToolkitFile, writeVerified, type ToolkitFile } from "./toolkit-io";
import { RecentList } from "./toolkit-ui";
import { loadRecent, pushRecent, saveRecent } from "../recent-paths";

/**
 * Exhaust Tips — turns the exhaust tips of each rear bumper on or off, left and right.
 *
 * Works on the car's three PCKs together (Player, Garage, Opponent): the tip tables live in each of
 * them and the game reads whichever one is loaded, so they must keep agreeing. The bytes come from
 * `src/exhausts.ts`; this file only shows the bumpers and saves. The checkboxes change nothing on
 * disk: every Save recomputes each PCK from the bytes it was opened with plus the current boxes,
 * and Reset simply returns the boxes to how the files were.
 */

const RECENTS_KEY = "mc3pae.recentExhaustFolders";
const ROLES = [["player", "", "Player"], ["garage", "_g", "Garage"], ["opponent", "_o", "Opponent"]] as const;
type Role = typeof ROLES[number][0];
type Loaded = ToolkitFile & { role: Role; label: string; setup: ExhaustSetup };
type Car = { folder: string; base: string; files: Loaded[] };
type Row = { group: ExhaustGroup; locked: string | null; warnings: string[] };

/** Finds `<car>.pck`, `<car>_g.pck` and `<car>_o.pck` directly inside a folder. */
async function findCarFiles(folder: string) {
  const names = (await readDir(folder)).filter((entry) => !entry.isDirectory && /\.pck$/i.test(entry.name) && !isMeshPckName(entry.name)).map((entry) => entry.name);
  const bases = new Set(names.map((name) => name.replace(/(_g|_o)?\.pck$/i, "")));
  const folderName = basename(folder).toLowerCase();
  const base = [...bases].find((item) => item.toLowerCase() === folderName) ?? (bases.size === 1 ? [...bases][0] : null);
  if (!base) throw new Error(`Couldn't tell which car this is: ${basename(folder)} holds ${bases.size ? [...bases].join(", ") : "no car PCK"}. Open the car's own folder.`);
  const found: { role: Role; label: string; path: string }[] = [];
  for (const [role, suffix, label] of ROLES) {
    const name = names.find((item) => item.toLowerCase() === `${base}${suffix}.pck`.toLowerCase());
    if (name) found.push({ role, label, path: await join(folder, name) });
  }
  return { base, found };
}

const sideLabel = (group: { left: boolean; right: boolean }) => group.left && group.right ? "L+R" : group.left ? "L" : group.right ? "R" : "none";

export function ExhaustTool({ dropped, onConsumeDrop, onStatus, isPathBlocked, onPendingChange }: {
  dropped: string[] | null;
  onConsumeDrop: () => void;
  onStatus: (message: string) => void;
  isPathBlocked: (path: string) => string | null;
  onPendingChange: (pending: boolean) => void;
}) {
  const [car, setCar] = useState<Car | null>(null);
  const [choices, setChoices] = useState<ExhaustChoices>({});
  const [error, setError] = useState("");
  const [result, setResult] = useState("");
  const [busy, setBusy] = useState(false);
  const [recents, setRecents] = useState<string[]>(() => loadRecent(RECENTS_KEY));

  const load = useCallback(async (path: string) => {
    try {
      setBusy(true); setError(""); setResult("");
      // A dropped or recent path can be the folder or one of its PCKs.
      let folder = path;
      try { await readDir(path); } catch { folder = parentPath(path); }
      const { base, found } = await findCarFiles(folder);
      if (!found.length) throw new Error(`No ${base}.pck, ${base}_g.pck or ${base}_o.pck in ${basename(folder)}.`);
      const files: Loaded[] = [];
      for (const item of found) {
        const file = await readToolkitFile(item.path);
        try { files.push({ ...file, role: item.role, label: item.label, setup: readExhaustSetup(file.bytes) }); }
        catch (caught) { throw new Error(`${file.name}: ${caught instanceof Error ? caught.message : "unsupported layout"}`); }
      }
      // The three PCKs must describe the same anchors, or a tip added to one would mean something
      // else in another.
      const reference = files[0];
      const doc = (file: Loaded) => new PckDocument(file.name, file.bytes.slice().buffer as ArrayBuffer);
      const referenceDoc = doc(reference);
      for (const file of files.slice(1)) doc(file).assertAnchorCompatibility(referenceDoc);
      setCar({ folder, base, files });
      setChoices({});
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

  // One row per rear bumper, from the first loaded PCK. A row is locked when any PCK can't edit it
  // or when the PCKs disagree on which sides have a tip.
  const rows = useMemo<Row[]>(() => {
    if (!car) return [];
    return car.files[0].setup.groups.filter((group) => group.bumper >= 0).map((group) => {
      const others = car.files.map((file) => ({ file, item: file.setup.groups.find((g) => g.group === group.group) }));
      let locked = others.map(({ item }) => item?.locked).find(Boolean) ?? null;
      if (!locked && others.some(({ item }) => !item || item.left !== group.left || item.right !== group.right || item.bumperName !== group.bumperName)) {
        locked = `The PCKs disagree on this bumper's tips (${others.map(({ file, item }) => `${file.label} ${item ? sideLabel(item) : "—"}`).join(", ")}).`;
      }
      return { group, locked, warnings: group.warnings };
    });
  }, [car]);

  // Everything Save would write, recomputed from the opened bytes on every change.
  const plan = useMemo<{ results: { file: Loaded; edit: ExhaustEditResult }[]; error: string }>(() => {
    if (!car || !Object.keys(choices).length) return { results: [], error: "" };
    try {
      const results = car.files.map((file) => ({ file, edit: applyExhaustChoices(file.bytes, choices) }));
      const key = (edit: ExhaustEditResult) => edit.added.map((item) => `${item.group}:${item.index}:${item.name}`).join("|");
      if (results.some(({ edit }) => key(edit) !== key(results[0].edit))) throw new Error("The new anchors would not come out the same in the three PCKs, so nothing can be saved.");
      for (const { file, edit } of results) {
        const after = readExhaustSetup(edit.bytes);
        for (const [group, wanted] of Object.entries(choices)) {
          const item = after.groups.find((g) => g.group === Number(group));
          if (!item || item.left !== wanted.left || item.right !== wanted.right) throw new Error(`${file.name}: group ${group} did not come out as chosen.`);
        }
      }
      return { results, error: "" };
    } catch (caught) {
      return { results: [], error: caught instanceof Error ? caught.message : "The change could not be prepared." };
    }
  }, [car, choices]);

  const changedFiles = plan.results.filter(({ edit }) => edit.changed);
  const addedAnchors = plan.results[0]?.edit.added ?? [];
  const pending = Object.keys(choices).length > 0;
  useEffect(() => { onPendingChange(pending); }, [pending, onPendingChange]);

  const toggle = (row: Row, side: "left" | "right") => {
    const group = row.group;
    setChoices((current) => {
      const now = current[group.group] ?? { left: group.left, right: group.right };
      const next = { ...now, [side]: !now[side] };
      const output = { ...current };
      if (next.left === group.left && next.right === group.right) delete output[group.group];
      else output[group.group] = next;
      return output;
    });
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
      // The vehicle set's own parser must accept every file before any of them is written.
      for (const { file, edit } of changedFiles) new PckDocument(file.name, edit.bytes.slice().buffer as ArrayBuffer);
      for (const { file, edit } of changedFiles) { await writeVerified(file.path, edit.bytes); written += 1; }
      const message = `${car.base} saved · ${changedFiles.length} PCK${changedFiles.length === 1 ? "" : "s"} · ${Object.keys(choices).length} bumper${Object.keys(choices).length === 1 ? "" : "s"} changed${addedAnchors.length ? ` · ${addedAnchors.length} anchor${addedAnchors.length === 1 ? "" : "s"} added` : ""}`;
      await load(car.folder);
      setResult(message);
      onStatus(message);
    } catch (caught) {
      setError(`${written ? `Stopped after writing ${written} of ${changedFiles.length} PCKs. ` : ""}${caught instanceof Error ? caught.message : "The PCKs could not be saved."}`);
    } finally { setBusy(false); }
  }, [addedAnchors.length, car, changedFiles, choices, isPathBlocked, load, onStatus, pending, plan.error]);

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "s") return;
      event.preventDefault(); void save();
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [save]);

  const note = (row: Row) => {
    if (row.locked) return { text: row.locked, tone: "warn" };
    const wanted = choices[row.group.group];
    if (wanted) {
      const added = addedAnchors.find((item) => item.group === row.group.group);
      if (added) return { text: `New anchor #${added.index} ${added.name} on the ${added.side}`, tone: "change" };
      const sides = ["left", "right"] as const;
      const turnedOn = sides.filter((side) => wanted[side] && !row.group[side]).length;
      const turnedOff = sides.filter((side) => !wanted[side] && row.group[side]).length;
      if (turnedOn && turnedOff) return { text: "Tip moves to the other side", tone: "change" };
      // Switched on without a new anchor: an exhaust anchor left under the bumper is reused.
      if (turnedOn) return { text: "Uses the exhaust anchor already under this bumper", tone: "change" };
      return { text: turnedOff > 1 ? "Tips turned off" : "Tip turned off", tone: "change" };
    }
    if (row.warnings.length) return { text: row.warnings.join(" · "), tone: "warn" };
    return { text: row.group.tips.map((tip) => `${tip.anchorName} #${tip.anchor}`).join(" · "), tone: "" };
  };

  const editable = rows.filter((row) => !row.locked).length;
  const noSlots = car?.files[0].setup.noSlots;

  return <>
    <section className="toolkit-hero">
      <div>
        <p className="eyebrow">{tr("REAR BUMPER EXHAUST TIPS")}</p>
        <h2>{tr("Turn exhaust tips on or off")}</h2>
        <p className="toolkit-hero-copy"><Tx t="Each rear bumper can show a tip on the left, the right, or both. Turning one off only empties its slot. Turning on the missing side of a single-tip bumper adds a mirrored copy of the other tip's anchor at the end of the anchor list, so no existing index changes and no {0} needs touching. Player, Garage and Opponent are changed together." v={[<code>mesh.pck</code>]} /></p>
      </div>
      <div className="toolkit-facts">
        <div><span>{tr("INPUT")}</span><strong>{tr("Car folder (3 PCKs)")}</strong></div>
        <div><span>{tr("EDITS")}</span><strong>{tr("Exhaust slots, +1 anchor per added tip")}</strong></div>
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
        <div><span className="step-number">02</span><div><h3>{tr("Rear bumpers")}</h3><p>{tr("In the order the PCK lists them, not the shop order. Left is the car's left (negative X).")}</p></div></div>
        {car && !noSlots && <div className="toolkit-chips">
          <span><Tx t="{0} bumpers" v={[<strong>{rows.length}</strong>]} /></span>
          {rows.length > editable && <span className="prior"><Tx t="{0} locked" v={[<strong>{rows.length - editable}</strong>]} /></span>}
          {pending && <span><Tx t="{0} changed" v={[<strong>{Object.keys(choices).length}</strong>]} /></span>}
        </div>}
      </div>
      {!car ? (
        <div className="toolkit-empty"><span>{tr("EXH")}</span><strong>{tr("Nothing loaded yet")}</strong><p>{tr("The rear bumpers are listed once a car is opened.")}</p></div>
      ) : noSlots ? (
        <div className="toolkit-empty"><span>{tr("EXH")}</span><strong>{tr("This car has no exhaust slots")}</strong><p>{tr("Exotics and cars without body customization keep their exhausts fixed; there is nothing to switch here.")}</p></div>
      ) : <div className="exhaust-table">
        <div className="exhaust-row head"><span>{tr("BUMPER")}</span><span>{tr("LEFT")}</span><span>{tr("RIGHT")}</span><span>{tr("NOTE")}</span></div>
        {rows.map((row) => {
          const wanted = choices[row.group.group] ?? { left: row.group.left, right: row.group.right };
          const info = note(row);
          return <div key={row.group.group} className={`exhaust-row ${row.locked ? "locked" : ""} ${choices[row.group.group] ? "changed" : ""}`}>
            <span title={row.group.bumperName}><strong>{row.group.bumperName}</strong><small>{tr(`group ${row.group.group} · anchor #${row.group.bumper}`)}</small></span>
            {(["left", "right"] as const).map((side) => <span key={side}><input type="checkbox" checked={wanted[side]} disabled={busy || Boolean(row.locked)} onChange={() => toggle(row, side)} aria-label={tr(`${side === "left" ? "Left" : "Right"} tip of ${row.group.bumperName}`)} /></span>)}
            <span className={info.tone} title={tr(info.text)}>{tr(info.text)}</span>
          </div>;
        })}
      </div>}
    </section>

    {car && !noSlots && <section className="toolkit-actions">
      <div>
        <strong>{pending ? tr(`${Object.keys(choices).length} bumper${Object.keys(choices).length === 1 ? "" : "s"} changed${addedAnchors.length ? ` · ${addedAnchors.length} new anchor${addedAnchors.length === 1 ? "" : "s"}` : ""}`) : tr("No changes")}</strong>
        <small>{pending
          ? tr(`Nothing is written until you save. ${changedFiles.map(({ file }) => file.name).join(", ")} will be overwritten in place, then read back and compared byte for byte.`)
          : tr("Tick or untick the boxes, then save. Nothing is written before that.")}</small>
      </div>
      <div className="carcfg-actions">
        <button className="toolkit-secondary" type="button" disabled={busy || !pending} onClick={() => { setChoices({}); setResult(""); }}>{tr("RESET")}</button>
        <button className="toolkit-primary" type="button" disabled={busy || !pending || Boolean(plan.error) || !changedFiles.length} onClick={() => void save()}>{busy ? tr("SAVING…") : tr("SAVE PCKS")}<span>→</span></button>
      </div>
    </section>}

    {result && <section className="iso-result"><span>✓</span><p>{tr(result)}</p></section>}
    {(error || plan.error) && <section className="toolkit-error"><span>!</span><div><strong>{tr("Action required")}</strong><p>{tr(error || plan.error)}</p></div></section>}
  </>;
}
