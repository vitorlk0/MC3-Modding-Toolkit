import { tr, Tx, confirmDialog } from "./i18n";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  applyPlan, buildPlan, CATEGORY_ORDER, checkPackage, detectPackage, openIsoSession,
  type CarReport, type InstallPlan, type IsoSession, type ModCategory, type ModPackage, type RandomFile,
} from "../src/iso-install";
import { SECTOR } from "../src/iso9660";
import { DAT_BYTE_LIMIT } from "../src/iso-install";
import { checkWritable, explainIsoError, readPackageFiles, tauriIsoFs } from "./iso-io";
import { loadRecent, pushRecent, saveRecent } from "./recent-paths";
import { RecentList } from "./mod-toolkit/toolkit-ui";
import { basename, parentFolder, sizeLabel } from "./mod-toolkit/toolkit-io";

/**
 * ISO Install — the last step of a mod: writing finished car files into a compiled MC3 ISO.
 *
 * The user opens one ISO and adds any number of mod ZIPs (or extracted folders), one car each. Every
 * car shows which of its four file kinds the package brings, and each kind can be left out. The
 * install plan is recomputed whenever that changes, and Install writes every selected car in one
 * pass over the opened ISO — in place when everything fits, otherwise by rebuilding the image with
 * a larger ASSETS.DAT (see src/iso-install.ts). There is no undo: the tab says so up front.
 */

const ISO_RECENTS_KEY = "mc3pae.recentInstallIsos";
const isoFilters = [{ name: "PS2 disc image", extensions: ["iso"] }];
const packageFilters = [{ name: "Mod package", extensions: ["zip"] }];

const categoryLabels: Record<ModCategory, { title: string; blurb: string }> = {
  garage: { title: "Garage", blurb: "_g.pck" },
  dat: { title: "Vehicle DAT", blurb: "player, opponent & parts" },
  flash: { title: "Flash menus", blurb: "ds / ms / ps / vs" },
  carcfg: { title: "Carcfg", blurb: "opponent variations" },
};

type CarCard = {
  key: string;
  source: string;
  pkg: ModPackage | null;
  error: string | null;
  enabled: Record<ModCategory, boolean>;
};

type Progress = { phase: string; done: number; total: number };

const allOn = (): Record<ModCategory, boolean> => ({ garage: true, dat: true, flash: true, carcfg: true });
const megabytes = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

export function IsoInstallWorkspace({ dropped, onConsumeDrop, onStatus, onBusyChange }: {
  dropped: string[] | null;
  onConsumeDrop: () => void;
  onStatus: (message: string) => void;
  /** True while the ISO is being written — the window must not close then. */
  onBusyChange: (busy: boolean) => void;
}) {
  const [isoPath, setIsoPath] = useState<string | null>(null);
  const [session, setSession] = useState<IsoSession | null>(null);
  const reader = useRef<RandomFile | null>(null);
  const [recents, setRecents] = useState<string[]>(() => loadRecent(ISO_RECENTS_KEY));
  const [cars, setCars] = useState<CarCard[]>([]);
  const [plan, setPlan] = useState<InstallPlan | null>(null);
  const [planError, setPlanError] = useState("");
  const [planning, setPlanning] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState("");
  const [result, setResult] = useState("");
  const [loading, setLoading] = useState(false);
  const writing = progress !== null;

  useEffect(() => { onBusyChange(writing); }, [writing, onBusyChange]);
  useEffect(() => () => { void reader.current?.close(); }, []);

  const closeReader = async () => {
    const current = reader.current;
    reader.current = null;
    await current?.close().catch(() => undefined);
  };

  /** `keepMessages`: the re-read after an install must not wipe that install's result or error. */
  const openIso = useCallback(async (path: string, keepMessages = false) => {
    try {
      setLoading(true);
      if (!keepMessages) { setError(""); setResult(""); }
      await closeReader();
      setSession(null);
      const file = await tauriIsoFs.openRead(path);
      reader.current = file;
      const opened = await openIsoSession(file);
      setIsoPath(path);
      setSession(opened);
      setRecents(pushRecent(ISO_RECENTS_KEY, path));
      onStatus(`${basename(path)} · ASSETS.DAT ${megabytes(opened.assets.size)} · ${opened.archive.entries.length} entries`);
    } catch (caught) {
      await closeReader();
      setIsoPath(null);
      setError(caught instanceof Error ? caught.message : "Could not open that ISO.");
    } finally { setLoading(false); }
  }, [onStatus]);

  const addPackages = useCallback(async (paths: string[]) => {
    setError(""); setResult("");
    const added: CarCard[] = [];
    for (const path of paths) {
      const source = basename(path);
      try {
        const pkg = await detectPackage(source, await readPackageFiles(path));
        added.push({ key: pkg.car, source, pkg, error: null, enabled: allOn() });
      } catch (caught) {
        added.push({ key: `error:${path}`, source, pkg: null, error: caught instanceof Error ? caught.message : "Could not read this package.", enabled: allOn() });
      }
    }
    setCars((current) => {
      const next = [...current];
      for (const card of added) {
        const existing = next.findIndex((item) => item.key === card.key);
        if (existing >= 0) next[existing] = card; else next.push(card);
      }
      return next;
    });
    const good = added.filter((card) => card.pkg);
    onStatus(good.length ? `Added ${good.map((card) => card.pkg!.car).join(", ")}` : "No usable car mod in that selection");
  }, [onStatus]);

  useEffect(() => {
    if (!dropped) return;
    const paths = dropped;
    onConsumeDrop();
    if (writing) return;
    const iso = paths.find((path) => /\.iso$/i.test(path));
    if (iso) void openIso(iso);
    const packages = paths.filter((path) => !/\.iso$/i.test(path));
    if (packages.length) void addPackages(packages);
  }, [dropped, onConsumeDrop, openIso, addPackages, writing]);

  const reports = useMemo(() => new Map(cars.filter((card) => card.pkg).map((card) => [card.key, session ? checkPackage(session, card.pkg!) : null] as const)), [cars, session]);

  const selections = useMemo(() => cars.flatMap((card) => {
    const report = reports.get(card.key);
    if (!card.pkg || !report || report.errors.length) return [];
    const files = CATEGORY_ORDER.filter((category) => card.enabled[category]).flatMap((category) => report.categories[category].files);
    return files.length ? [{ car: card.pkg.car, files }] : [];
  }), [cars, reports]);

  useEffect(() => {
    setPlan(null); setPlanError("");
    if (!session || !selections.length || writing) return;
    let cancelled = false;
    setPlanning(true);
    const timer = window.setTimeout(() => {
      buildPlan(session, selections)
        .then((built) => { if (!cancelled) setPlan(built); })
        .catch((caught) => { if (!cancelled) setPlanError(caught instanceof Error ? caught.message : "The install could not be planned."); })
        .finally(() => { if (!cancelled) setPlanning(false); });
    }, 250);
    return () => { cancelled = true; window.clearTimeout(timer); setPlanning(false); };
  }, [session, selections, writing]);

  const install = useCallback(async () => {
    if (!plan || !session || !isoPath || plan.mode === "nothing") return;
    setError(""); setResult("");
    try { await checkWritable(isoPath); } catch (caught) {
      setError(explainIsoError(caught instanceof Error ? caught.message : String(caught)));
      return;
    }
    const changed = plan.items.filter((item) => item.action !== "unchanged").length;
    const how = plan.mode === "rebuild"
      ? `ASSETS.DAT grows by ${megabytes(plan.newAssetsSize - plan.oldAssetsSize)}, so the whole ISO is rewritten (about ${megabytes(plan.finalSize)}). A temporary copy is written next to it first and only replaces it once verified.`
      : plan.mode === "grow"
        ? `ASSETS.DAT grows by ${megabytes(plan.newAssetsSize - plan.oldAssetsSize)} into the free space reserved after it — no other file moves and the ISO keeps its size.`
        : "Everything fits in place, so only those bytes are rewritten.";
    const go = await confirmDialog(`Install ${changed} file${changed === 1 ? "" : "s"} for ${selections.length} car${selections.length === 1 ? "" : "s"} into ${basename(isoPath)}?\n\n${how}\n\nThis overwrites the ISO and can't be undone.`, { title: "Install into ISO", kind: "warning" });
    if (!go) return;
    setError(""); setResult("");
    setProgress({ phase: "Starting", done: 0, total: 1 });
    const started = performance.now();
    try {
      await closeReader();
      await applyPlan(tauriIsoFs, isoPath, session, plan, (phase, done, total) => setProgress({ phase, done, total }));
      const seconds = ((performance.now() - started) / 1000).toFixed(1);
      const message = `Installed ${changed} file${changed === 1 ? "" : "s"} for ${selections.map((item) => item.car).join(", ")} in ${seconds}s · ${plan.mode === "rebuild" || plan.mode === "grow" ? `ASSETS.DAT ${megabytes(plan.oldAssetsSize)} → ${megabytes(plan.newAssetsSize)}` : "written in place"} · verified`;
      setResult(message);
      onStatus(message);
    } catch (caught) {
      setError(caught instanceof Error ? explainIsoError(caught.message) : typeof caught === "string" ? explainIsoError(caught) : "The install failed.");
    } finally {
      setProgress(null);
      // Re-read the image either way, so the plan reflects what is on disk now.
      await openIso(isoPath, true);
    }
  }, [plan, session, isoPath, selections, onStatus, openIso]);

  const pickIso = async () => {
    const selection = await openDialog({ multiple: false, filters: isoFilters, defaultPath: isoPath ?? undefined });
    if (typeof selection === "string") void openIso(selection);
  };
  const pickPackages = async (folder: boolean) => {
    const selection = await openDialog(folder ? { directory: true, multiple: true } : { multiple: true, filters: packageFilters });
    if (selection === null) return;
    void addPackages(Array.isArray(selection) ? selection : [selection]);
  };

  const toggle = (key: string, category: ModCategory) => setCars((current) => current.map((card) => card.key === key ? { ...card, enabled: { ...card.enabled, [category]: !card.enabled[category] } } : card));
  const removeCar = (key: string) => setCars((current) => current.filter((card) => card.key !== key));

  const changedCount = plan ? plan.items.filter((item) => item.action !== "unchanged").length : 0;
  const busy = loading || writing;

  return <div className="iso-install">
    <aside className="iso-install-side">
      <header className="toolkit-main-head">
        <p className="eyebrow">{tr("FINAL STEP")}</p>
        <h1>{tr("ISO Install")}</h1>
      </header>

      <section className="toolkit-hero iso-hero">
        <div>
          <h2>{tr("Put finished car mods into a compiled ISO")}</h2>
          <p className="toolkit-hero-copy"><Tx t="Add mod ZIPs — one car each — and they are written into {0} of the opened ISO, replacing the original car. The {1} and the {2} are required; {3} and {4} files are installed when the package has them. Textures, readmes and scripts in a package are ignored." v={[<code>ASSETS.DAT</code>, <strong>{tr("garage PCK")}</strong>, <strong>{tr("vehicle DAT")}</strong>, <strong>{tr("flash menus")}</strong>, <strong>{tr("carcfg")}</strong>]} /></p>
        </div>
        <div className="toolkit-facts">
          <div><span>{tr("INPUT")}</span><strong>{tr(".iso + mod .zip / folder")}</strong></div>
          <div><span>{tr("OUTPUT")}</span><strong>{tr("The same ISO, overwritten")}</strong></div>
          <div><span>{tr("BACKUP")}</span><strong>{tr("Yours to make first")}</strong></div>
        </div>
      </section>

      <section className="iso-warning"><span>!</span><p><Tx t="{0} Make a backup copy of the ISO before installing mods — there is no undo." v={[<strong>{tr("This tool overwrites the opened ISO in place.")}</strong>]} /></p></section>
    </aside>

    <main className="toolkit-main iso-install-main">

      <section className="toolkit-panel">
        <div className="toolkit-panel-head">
          <div><span className="step-number">01</span><div><h3>{tr("Open the ISO")}</h3><p>{tr("A Midnight Club 3 PS2 image. It is only read until you press Install.")}</p></div></div>
          {session && <div className="toolkit-chips">
            <span><Tx t="{0} ASSETS.DAT" v={[<strong>{megabytes(session.assets.size)}</strong>]} /></span>
            <span><Tx t="{0} entries" v={[<strong>{session.archive.entries.length}</strong>]} /></span>
          </div>}
        </div>
        <div className="toolkit-file-row">
          <button className="toolkit-drop" type="button" disabled={busy} onClick={() => void pickIso()}>
            <span className="toolkit-file-type">{tr("ISO")}</span>
            <span className="toolkit-drop-copy">
              <strong>{isoPath ? basename(isoPath) : loading ? tr("Opening…") : tr("Choose an ISO")}</strong>
              <small>{isoPath && session ? `${session.iso.volumeId} · ${megabytes(session.reader.size)} · ${parentFolder(isoPath)}` : tr("Click to browse, or drop it on the window")}</small>
            </span>
            <span className="toolkit-drop-action">{isoPath ? tr("CHANGE") : tr("+ OPEN")}</span>
          </button>
          <RecentList title={tr("Recent ISOs")} paths={recents} activePath={isoPath ?? undefined} busy={busy} onPick={(path) => void openIso(path)} onClear={() => { saveRecent(ISO_RECENTS_KEY, []); setRecents([]); }} />
          {session && (session.rebuildBlocker
            ? <p className="carcfg-warning"><Tx t="ASSETS.DAT can't grow in this ISO, so a mod installs only if every file fits where the original was. {0}" v={[session.rebuildBlocker]} /></p>
            : session.assets.lba * SECTOR + session.assets.size > DAT_BYTE_LIMIT
              ? <p className="carcfg-warning"><Tx t="ASSETS.DAT in this ISO reaches past 4 GB on the disc ({0} GB from the start). The game reads DAT files with 32-bit offsets and freezes on a black screen with this layout — compact the original ISO again with Tools › 07 Compact ISO." v={[(session.assets.lba * SECTOR / 1024 ** 3).toFixed(2)]} /></p>
              : session.assetsRoom >= 1024 * 1024
              ? <p className="carcfg-note"><Tx t="{0} of free space is reserved right after ASSETS.DAT. Mods that are bigger than the original car grow into it — installs are quick and nothing else moves." v={[megabytes(session.assetsRoom)]} /></p>
              : <p className="carcfg-note"><Tx t="ASSETS.DAT stays at sector {0} (0x{1}). When a mod is bigger than the original car, ASSETS.DAT grows and the files after it move forward — the ISO gets that much bigger." v={[session.assets.lba.toString(), (session.assets.lba * SECTOR).toString(16).toUpperCase()]} /></p>)}
        </div>
      </section>

      <section className="toolkit-panel">
        <div className="toolkit-panel-head">
          <div><span className="step-number">02</span><div><h3>{tr("Add car mods")}</h3><p>{tr("One car per ZIP. Drop several at once, or add them one by one.")}</p></div></div>
          <div className="iso-add-buttons">
            <button className="toolkit-secondary" type="button" disabled={busy} onClick={() => void pickPackages(false)}>{tr("+ ADD ZIP")}</button>
            <button className="toolkit-secondary" type="button" disabled={busy} onClick={() => void pickPackages(true)}>{tr("+ ADD FOLDER")}</button>
          </div>
        </div>
        {!cars.length ? (
          <div className="toolkit-empty"><span>{tr("ZIP")}</span><strong>{tr("No mods added yet")}</strong><p><Tx t="Drop mod ZIPs on the window. Each needs the car's {0} and {1}; files can sit anywhere inside the ZIP." v={[<code>vp_*.dat</code>, <code>vp_*_g.pck</code>]} /></p></div>
        ) : <div className="iso-car-list">
          {cars.map((card) => <CarCardView key={card.key} card={card} report={reports.get(card.key) ?? null} hasIso={!!session} busy={busy} onToggle={(category) => toggle(card.key, category)} onRemove={() => removeCar(card.key)} />)}
        </div>}
      </section>

      <section className="toolkit-panel">
        <div className="toolkit-panel-head">
          <div><span className="step-number">03</span><div><h3>{tr("Install plan")}</h3><p>{tr("What will be written, file by file.")}</p></div></div>
          {plan && <div className="toolkit-chips">
            <span><Tx t="{0} to write" v={[<strong>{changedCount}</strong>]} /></span>
            <span><Tx t="{0} unchanged" v={[<strong>{plan.items.length - changedCount}</strong>]} /></span>
            {(plan.mode === "rebuild" || plan.mode === "grow") && <span className="prior"><Tx t="{0} ASSETS" v={[<strong>+{megabytes(plan.newAssetsSize - plan.oldAssetsSize)}</strong>]} /></span>}
          </div>}
        </div>
        {!session || !selections.length ? (
          <div className="toolkit-empty"><span>{tr("PLAN")}</span><strong>{!session ? tr("Open an ISO first") : tr("Add a car mod")}</strong><p>{tr("The plan appears once an ISO is open and at least one car has files selected.")}</p></div>
        ) : planning && !plan ? (
          <div className="toolkit-empty"><span>…</span><strong>{tr("Planning")}</strong><p>{tr("Comparing the mod files with the ISO.")}</p></div>
        ) : planError ? (
          <p className="carcfg-warning iso-plan-error">{tr(planError)}</p>
        ) : plan && <div className="iso-plan">
          <div className="iso-plan-row head"><span>{tr("FILE")}</span><span>{tr("CAR")}</span><span>{tr("ORIGINAL")}</span><span>{tr("NEW")}</span><span>{tr("WRITE")}</span></div>
          {plan.items.map((item) => <div className={`iso-plan-row ${item.action}`} key={item.file.target}>
            <span title={item.file.target}>{item.file.target}</span>
            <span>{item.car}</span>
            <span>{sizeLabel(item.oldStored)}</span>
            <span>{sizeLabel(item.stored.length)}{item.compressed && <small> {tr("deflated")}</small>}</span>
            <span><em>{item.action === "unchanged" ? tr("Unchanged") : item.action === "in-place" ? tr("In place") : tr("Appended")}</em></span>
          </div>)}
        </div>}
      </section>

      {session && selections.length > 0 && <section className="toolkit-actions">
        <div>
          <strong>{writing ? tr(progress!.phase) : plan?.mode === "rebuild" ? tr("Rebuild the ISO with the mods") : plan?.mode === "grow" ? tr("Write the mods into the reserved space") : plan?.mode === "nothing" ? tr("Already installed") : tr("Write the mods into the ISO")}</strong>
          {writing
            ? <div className="iso-progress"><div style={{ width: `${Math.min(100, (progress!.done / Math.max(1, progress!.total)) * 100)}%` }} /></div>
            : <small>{!plan ? tr("Waiting for the plan.") : plan.mode === "rebuild" ? tr(`ASSETS.DAT ${megabytes(plan.oldAssetsSize)} → ${megabytes(plan.newAssetsSize)}; the ISO becomes ${megabytes(plan.finalSize)}. Needs that much free disk space for the temporary copy. (A Compact ISO — Tools › 07 — leaves free space after ASSETS.DAT, so installs there don't move anything.)`) : plan.mode === "grow" ? tr(`ASSETS.DAT ${megabytes(plan.oldAssetsSize)} → ${megabytes(plan.newAssetsSize)}, into the free space after it (${megabytes(session.assetsRoom - (plan.newAssetsSize - plan.oldAssetsSize))} left afterwards); nothing else moves.`) : plan.mode === "nothing" ? tr("Every selected file already matches the ISO.") : tr("Every changed file fits where the original was — the ISO keeps its size.")}</small>}
        </div>
        <button className="toolkit-primary" type="button" disabled={!plan || plan.mode === "nothing" || busy} onClick={() => void install()}>{writing ? tr("WRITING…") : tr("INSTALL")}<span>→</span></button>
      </section>}

      {result && <section className="iso-result"><span>✓</span><p>{tr(result)}</p></section>}
      {error && <section className="toolkit-error"><span>!</span><div><strong>{tr("Action required")}</strong><p>{tr(error)}</p></div></section>}
    </main>
  </div>;
}

function CarCardView({ card, report, hasIso, busy, onToggle, onRemove }: {
  card: CarCard; report: CarReport | null; hasIso: boolean; busy: boolean;
  onToggle: (category: ModCategory) => void; onRemove: () => void;
}) {
  if (!card.pkg) {
    return <article className="iso-car refused">
      <header><div><strong>{card.source}</strong><small>{tr("Not a usable car mod")}</small></div><button className="link-button" type="button" disabled={busy} onClick={onRemove}>{tr("Remove")}</button></header>
      <p className="iso-car-error">{card.error}</p>
    </article>;
  }
  const pkg = card.pkg;
  const refused = !!report?.errors.length;
  return <article className={refused ? "iso-car refused" : "iso-car"}>
    <header>
      <div><strong>{pkg.car}</strong><small>{card.source}{pkg.ignored.length > 0 && tr(` · ${pkg.ignored.length} other file${pkg.ignored.length === 1 ? "" : "s"} ignored`)}</small></div>
      <button className="link-button" type="button" disabled={busy} onClick={onRemove}>{tr("Remove")}</button>
    </header>
    <div className="iso-car-kinds">
      {CATEGORY_ORDER.map((category) => {
        const files = report ? report.categories[category].files : pkg.files.filter((file) => file.category === category);
        const expected = report?.categories[category].expected;
        const present = files.length > 0;
        // A "complete" set is the four menu files / the numbered variants; reward_ and the plain
        // vp_x.carcfg install too but are extras, shown next to the count instead of inflating it.
        const counted = files.filter((file) => category === "flash" ? !file.name.startsWith("reward_") : category === "carcfg" ? /_\d+\.carcfg$/.test(file.name) : true);
        const extras = files.length - counted.length;
        const partial = present && expected !== undefined && category !== "dat" && category !== "garage" && counted.length < expected;
        const count = category === "dat" || category === "garage" ? null : `${counted.length}${expected !== undefined ? `/${expected}` : ""}${extras ? ` +${extras}` : ""}`;
        return <label key={category} className={`iso-kind ${present ? "" : "missing"} ${partial ? "partial" : ""}`} title={present ? files.map((file) => file.name).join("\n") : tr("Not in this package")}>
          <input type="checkbox" checked={present && card.enabled[category]} disabled={!present || refused || busy} onChange={() => onToggle(category)} />
          <span><strong>{tr(categoryLabels[category].title)}{count && <em>{count}</em>}</strong><small>{!present ? tr("Not in package") : files[0].compiledFrom ? tr(`compiled from ${files[0].compiledFrom} PCKs`) : categoryLabels[category].blurb}</small></span>
        </label>;
      })}
    </div>
    {!hasIso && <p className="iso-car-note">{tr("Open an ISO to check this car against it.")}</p>}
    {report?.errors.map((message) => <p className="iso-car-error" key={tr(message)}>{tr(message)}</p>)}
    {report?.warnings.map((message) => <p className="iso-car-warning" key={tr(message)}>{tr(message)}</p>)}
  </article>;
}

