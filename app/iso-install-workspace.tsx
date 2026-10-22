import { tr, Tx, confirmDialog } from "./i18n";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  applyPlan, buildPlan, CATEGORY_ORDER, checkPackage, detectPackage, openIsoSession,
  type CarReport, type InstallPlan, type IsoSession, type ModCategory, type ModPackage, type PackageFile, type RandomFile,
} from "../src/iso-install";
import { BIKE_CLASSES, elfMentions, knownClass, type SlotCatalog } from "../src/slot-reference";
import { readIsoCatalog } from "../src/slot-reference-iso";
import { retargetPackage, type RetargetResult } from "../src/slot-retarget";
import { RetargetNotes, SlotPicker } from "./mod-toolkit/slot-picker";
import {
  DETAIL_KEYS, NAME_MAX, SHORT_NAME_MAX, SHOWROOM_LETTERS, SHOWROOM_TYPES, detailProblem, openSlotDetails,
  type LogoOption, type SlotDetails, type SlotDetailsEdit, type SlotDetailsSource,
} from "../src/slot-details";
import { SECTOR } from "../src/iso9660";
import { DAT_BYTE_LIMIT, isOpponentCarcfg } from "../src/iso-install";
import { checkWritable, explainIsoError, readPackageFiles, tauriIsoFs } from "./iso-io";
import { loadRecent, pushRecent, saveRecent } from "./recent-paths";
import { RecentList } from "./mod-toolkit/toolkit-ui";
import { basename, parentFolder, sizeLabel } from "./mod-toolkit/toolkit-io";

/**
 * ISO Install — the last step of a mod: writing finished car files into a compiled MC3 ISO.
 *
 * The user opens one ISO and adds any number of mod ZIPs (or extracted folders), one car each. Every
 * car shows which of its four file kinds the package brings, and each kind can be left out.
 *
 * Each car installs into a slot of the opened ISO: the slot the mod was made for when the ISO has
 * it, or any other slot the user picks — then the package is converted in memory by Slot Retarget
 * (src/slot-retarget.ts) against the ISO's own catalogues (src/slot-reference-iso.ts), exactly as
 * Tools 11 would, and the converted files are what gets installed. A mod for a car the ISO doesn't
 * have (a VIP or DLC car) has to be given a slot. Two cars can't take the same slot. The
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
  tune: { title: "Tune", blurb: "cameras, damage, garage" },
};

type CarCard = {
  /** Unique per added package; `key` (the car) is what a re-added package replaces. */
  id: number;
  key: string;
  source: string;
  pkg: ModPackage | null;
  /** The package's files, for converting it to another slot. */
  files: PackageFile[];
  /** The slot chosen by the user; null = the mod's own slot when the ISO has it. */
  target: string | null;
  /** Slot details the user typed, as typed; a field left alone keeps the ISO's value. Cleared
   *  when the slot changes. */
  edits: DetailInputs;
  error: string | null;
  enabled: Record<ModCategory, boolean>;
};

type DetailInputs = Partial<Record<keyof SlotDetails, string>>;
/** A slot's current details, or why they couldn't be read. */
type DetailsState = { details: (SlotDetails & { artProblem: string | null }) | null; error: string | null };

/** The typed fields as values to write, or the problems that stop them. */
function parseEdits(inputs: DetailInputs): { edit: SlotDetailsEdit; problems: string[] } {
  const edit: SlotDetailsEdit = {};
  const problems: string[] = [];
  for (const key of DETAIL_KEYS) {
    const raw = inputs[key];
    if (raw === undefined) continue;
    const value = key === "name" || key === "shortName" || key === "letter" ? raw : key === "remix" ? raw === "true" : Number(raw.trim().replace(/^\$/, "").replace(/,/g, ""));
    const problem = raw.trim() === "" && key !== "name" && key !== "shortName" ? "Can't be empty." : detailProblem(key, value);
    if (problem) problems.push(`${DETAIL_LABELS[key]}: ${problem}`);
    else (edit as Record<string, string | number | boolean>)[key] = value;
  }
  return { edit, problems };
}

const DETAIL_LABELS: Record<keyof SlotDetails, string> = {
  name: "Name", shortName: "Short name", price: "Price shown", letter: "Class letter", showroomType: "Type",
  logo: "Brand logo", remix: "REMIX badge",
};
/** How a current value fills its field. */
const detailText = (key: keyof SlotDetails, details: SlotDetails) => String(details[key]);

/** A package converted to another slot, for one card and one target. */
type Conversion = { target: string; running: boolean; result: RetargetResult | null; pkg: ModPackage | null; error: string | null };

/** What a card installs, once its slot is resolved against the opened ISO. */
type CardState = {
  /** Slot it installs into: null while no ISO (or its slot list) is ready, "" when none is chosen. */
  target: string | null;
  /** The package that gets installed — the mod itself, or its conversion for `target`. */
  pkg: ModPackage | null;
  conversion: Conversion | null;
  blockers: string[];
  report: CarReport | null;
};

let nextCardId = 1;
/** The plan's "car" for the global files the slot details rewrite. */
const SHARED_FILES = "shared files";

type Progress = { phase: string; done: number; total: number };

const allOn = (): Record<ModCategory, boolean> => ({ garage: true, dat: true, flash: true, carcfg: true, tune: true });
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
  const [catalog, setCatalog] = useState<SlotCatalog | null>(null);
  const [catalogError, setCatalogError] = useState("");
  const [conversions, setConversions] = useState<Map<number, Conversion>>(() => new Map());
  const [detailsSource, setDetailsSource] = useState<SlotDetailsSource | null>(null);
  const [slotDetails, setSlotDetails] = useState<Map<string, DetailsState>>(() => new Map());
  const [logos, setLogos] = useState<LogoOption[]>([]);
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
        const files = await readPackageFiles(path);
        const pkg = await detectPackage(source, files);
        added.push({ id: nextCardId++, key: pkg.car, source, pkg, files, target: null, edits: {}, error: null, enabled: allOn() });
      } catch (caught) {
        added.push({ id: nextCardId++, key: `error:${path}`, source, pkg: null, files: [], target: null, edits: {}, error: caught instanceof Error ? caught.message : "Could not read this package.", enabled: allOn() });
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

  // The opened ISO's slots and catalogues, for choosing where each car goes.
  useEffect(() => {
    setCatalog(null); setCatalogError(""); setConversions(new Map());
    const source = session ? openSlotDetails(session) : null;
    setDetailsSource(source); setSlotDetails(new Map()); setLogos([]);
    source?.logos().then(setLogos).catch(() => setLogos([]));
    if (!session) return;
    let cancelled = false;
    readIsoCatalog(session)
      .then((read) => { if (!cancelled) setCatalog(read); })
      .catch((caught) => { if (!cancelled) setCatalogError(caught instanceof Error ? caught.message : String(caught)); });
    return () => { cancelled = true; };
  }, [session]);

  const targetOf = useCallback((card: CarCard) => {
    if (!card.pkg || !catalog) return null;
    return card.target ?? (catalog.listing.some((slot) => slot.name === card.pkg!.car) ? card.pkg.car : "");
  }, [catalog]);

  // Convert every card that goes to another slot than its own, once per card and target.
  useEffect(() => {
    if (!catalog || writing) return;
    for (const card of cars) {
      const target = targetOf(card);
      const pkg = card.pkg;
      if (!pkg || !target || target === pkg.car || conversions.get(card.id)?.target === target) continue;
      const pending: Conversion = { target, running: true, result: null, pkg: null, error: null };
      setConversions((current) => new Map(current).set(card.id, pending));
      void (async () => {
        let done: Conversion;
        try {
          const result = await retargetPackage(card.source, { car: pkg.car, className: knownClass(pkg.car), files: card.files, notes: pkg.notes }, target, catalog);
          const converted = result.blocked ? null : await detectPackage(card.source, result.files.map((file) => ({ path: file.path, size: file.bytes.length, read: async () => file.bytes })));
          done = { target, running: false, result, pkg: converted, error: null };
        } catch (caught) {
          done = { target, running: false, result: null, pkg: null, error: `Converting ${pkg.car} for ${target} failed: ${caught instanceof Error ? caught.message : caught}` };
        }
        // Only if nothing newer replaced this conversion meanwhile.
        setConversions((current) => current.get(card.id) === pending ? new Map(current).set(card.id, done) : current);
      })();
    }
  }, [cars, catalog, conversions, writing, targetOf]);

  // What the game shows for each chosen slot today, read from the ISO once per slot.
  useEffect(() => {
    if (!detailsSource || !catalog) return;
    for (const card of cars) {
      const target = targetOf(card);
      if (!target || slotDetails.has(target) || !catalog.listing.some((slot) => slot.name === target)) continue;
      setSlotDetails((current) => new Map(current).set(target, { details: null, error: null }));
      detailsSource.details(target)
        .then((details) => setSlotDetails((current) => new Map(current).set(target, { details, error: null })))
        .catch((caught) => setSlotDetails((current) => new Map(current).set(target, { details: null, error: caught instanceof Error ? caught.message : String(caught) })));
    }
  }, [cars, catalog, detailsSource, slotDetails, targetOf]);

  const states = useMemo(() => {
    const out = new Map<number, CardState>();
    const claimed = new Set<string>();
    for (const card of cars) {
      if (!card.pkg) continue;
      const car = card.pkg.car;
      const target = targetOf(card);
      const blockers: string[] = [];
      let pkg: ModPackage | null = card.pkg;
      let conversion: Conversion | null = null;
      // No slot yet: the card's slot row asks for one; nothing installs meanwhile.
      if (target === "") pkg = null;
      else if (target && !catalog!.listing.some((slot) => slot.name === target)) {
        blockers.push(`${target} isn't a car of this ISO. Choose another slot.`);
        pkg = null;
      } else if (target && target !== car) {
        const current = conversions.get(card.id);
        conversion = current?.target === target ? current : null;
        pkg = conversion && !conversion.running ? conversion.pkg : null;
        if (conversion?.error) blockers.push(conversion.error);
        else if (conversion?.result?.blocked) blockers.push(`${car} can't be moved onto ${target} — see the blocked items in the conversion report.`);
      }
      if (target) {
        if (claimed.has(target)) blockers.push(`Another mod in the list already installs into ${target}. Remove one of them or choose another slot.`);
        claimed.add(target);
      }
      for (const problem of parseEdits(card.edits).problems) blockers.push(`Slot details — ${problem}`);
      // Without the slot list there is nothing to check against yet (or, if it failed, only the own slot).
      const ready = !!session && (!!catalog || !!catalogError);
      const report = ready && pkg && !blockers.length ? checkPackage(session!, pkg) : null;
      out.set(card.id, { target, pkg, conversion, blockers, report });
    }
    return out;
  }, [cars, conversions, catalog, catalogError, session, targetOf]);

  const converting = [...states.values()].filter((state) => state.conversion?.running).length;

  const selections = useMemo(() => cars.flatMap((card) => {
    const state = states.get(card.id);
    if (!state?.pkg || !state.report || state.report.errors.length || state.blockers.length) return [];
    const report = state.report;
    const files = CATEGORY_ORDER.filter((category) => card.enabled[category]).flatMap((category) => report.categories[category].files);
    return files.length ? [{ car: state.pkg.car, files, edit: parseEdits(card.edits).edit }] : [];
  }), [cars, states]);

  // The global files the slot details of the installable cars change, rebuilt from the ISO's copies.
  const shared = useMemo(() => {
    if (!detailsSource) return [];
    const edits = selections.filter((item) => Object.keys(item.edit).length).map((item) => ({ slot: item.car, edit: item.edit }));
    return edits.length ? detailsSource.sharedFiles(edits) : [];
  }, [detailsSource, selections]);

  useEffect(() => {
    setPlan(null); setPlanError("");
    if (!session || !selections.length || writing) return;
    let cancelled = false;
    setPlanning(true);
    const timer = window.setTimeout(() => {
      buildPlan(session, [...selections, ...(shared.length ? [{ car: SHARED_FILES, files: shared }] : [])])
        .then((built) => { if (!cancelled) setPlan(built); })
        .catch((caught) => { if (!cancelled) setPlanError(caught instanceof Error ? caught.message : "The install could not be planned."); })
        .finally(() => { if (!cancelled) setPlanning(false); });
    }, 250);
    return () => { cancelled = true; window.clearTimeout(timer); setPlanning(false); };
  }, [session, selections, shared, writing]);

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

  const toggle = (id: number, category: ModCategory) => setCars((current) => current.map((card) => card.id === id ? { ...card, enabled: { ...card.enabled, [category]: !card.enabled[category] } } : card));
  const removeCar = (id: number) => setCars((current) => current.filter((card) => card.id !== id));
  const chooseTarget = (id: number, target: string) => setCars((current) => current.map((card) => card.id === id ? { ...card, target: target || null, edits: {} } : card));
  const editDetail = (id: number, key: keyof SlotDetails, value: string | undefined) => setCars((current) => current.map((card) => {
    if (card.id !== id) return card;
    const edits = { ...card.edits };
    if (value === undefined) delete edits[key]; else edits[key] = value;
    return { ...card, edits };
  }));

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
          <p className="toolkit-hero-copy"><Tx t="Add mod ZIPs — one car each — and they are written into {0} of the opened ISO, replacing the original car. The {1} and the {2} are required; {3}, {4} and {5} files are installed when the package has them. Textures, readmes and scripts in a package are ignored." v={[<code>ASSETS.DAT</code>, <strong>{tr("garage PCK")}</strong>, <strong>{tr("vehicle DAT")}</strong>, <strong>{tr("flash menus")}</strong>, <strong>{tr("carcfg")}</strong>, <strong>{tr("tune")}</strong>]} /></p>
          <p className="toolkit-hero-copy"><Tx t="A car goes into the slot it was made for. Pick another {0} to put it over a different car, or to give a slot to a car the ISO doesn't have (a VIP or DLC car): the mod is converted for that slot the way {1} does, and the car takes that slot's name, logo, price and class." v={[<strong>{tr("slot")}</strong>, <strong>{tr("Tools › 11 Slot Retarget")}</strong>]} /></p>
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
          {catalogError && <p className="carcfg-warning"><Tx t="This ISO's car list couldn't be read, so cars can only go into the slot they were made for: {0}" v={[tr(catalogError)]} /></p>}
          {cars.map((card) => {
            const state = states.get(card.id) ?? null;
            return <CarCardView key={card.id} card={card} state={state} catalog={catalog} hasIso={!!session} busy={busy}
              details={state?.target ? slotDetails.get(state.target) ?? null : null} logos={logos}
              onTarget={(target) => chooseTarget(card.id, target)} onEdit={(key, value) => editDetail(card.id, key, value)}
              onToggle={(category) => toggle(card.id, category)} onRemove={() => removeCar(card.id)} />;
          })}
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
          converting && session
            ? <div className="toolkit-empty"><span>…</span><strong>{tr("Converting")}</strong><p>{tr("Converting the mods for the slots they go into.")}</p></div>
            : <div className="toolkit-empty"><span>{tr("PLAN")}</span><strong>{!session ? tr("Open an ISO first") : tr("Add a car mod")}</strong><p>{tr("The plan appears once an ISO is open and at least one car has files selected.")}</p></div>
        ) : planning && !plan ? (
          <div className="toolkit-empty"><span>…</span><strong>{tr("Planning")}</strong><p>{tr("Comparing the mod files with the ISO.")}</p></div>
        ) : planError ? (
          <p className="carcfg-warning iso-plan-error">{tr(planError)}</p>
        ) : plan && <div className="iso-plan">
          <div className="iso-plan-row head"><span>{tr("FILE")}</span><span>{tr("CAR")}</span><span>{tr("ORIGINAL")}</span><span>{tr("NEW")}</span><span>{tr("WRITE")}</span></div>
          {plan.items.map((item) => <div className={`iso-plan-row ${item.action}`} key={item.file.target}>
            <span title={item.file.target}>{item.file.target}</span>
            <span>{tr(item.car)}</span>
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

function CarCardView({ card, state, catalog, details, logos, hasIso, busy, onTarget, onEdit, onToggle, onRemove }: {
  card: CarCard; state: CardState | null; catalog: SlotCatalog | null; details: DetailsState | null; logos: LogoOption[]; hasIso: boolean; busy: boolean;
  onTarget: (target: string) => void; onEdit: (key: keyof SlotDetails, value: string | undefined) => void;
  onToggle: (category: ModCategory) => void; onRemove: () => void;
}) {
  if (!card.pkg) {
    return <article className="iso-car refused">
      <header><div><strong>{card.source}</strong><small>{tr("Not a usable car mod")}</small></div><button className="link-button" type="button" disabled={busy} onClick={onRemove}>{tr("Remove")}</button></header>
      <p className="iso-car-error">{card.error}</p>
    </article>;
  }
  const source = card.pkg;
  const report = state?.report ?? null;
  const target = state?.target ?? null;
  const moved = !!target && target !== source.car;
  const conversion = state?.conversion ?? null;
  // The files shown: the converted package once it exists, else the mod's own.
  const pkg = state?.pkg ?? source;
  const refused = !!report?.errors.length || !!state?.blockers.length;
  const result = conversion?.result ?? null;
  const counts = result && {
    converted: result.files.filter((file) => file.change === "converted").length,
    renamed: result.files.filter((file) => file.change === "renamed").length,
  };
  const notes = result?.notes ?? [];
  const warnings = notes.filter((note) => note.level === "warn").length;
  return <article className={refused ? "iso-car refused" : "iso-car"}>
    <header>
      <div><strong>{source.car}{moved && <em className="iso-car-moved"> → {target}</em>}</strong><small>{card.source}{source.ignored.length > 0 && tr(` · ${source.ignored.length} other file${source.ignored.length === 1 ? "" : "s"} ignored`)}</small></div>
      <button className="link-button" type="button" disabled={busy} onClick={onRemove}>{tr("Remove")}</button>
    </header>
    {catalog && <div className="iso-slot">
      <span className="iso-slot-label">{tr("SLOT")}</span>
      <SlotPicker compact filter={false} value={target ?? ""} disabled={busy} placeholder={tr("Choose the car it replaces…")} onChange={onTarget}
        slots={catalog.listing.map((slot) => ({
          name: slot.name, className: slot.className,
          // Moving a mod needs the slot's own menus; its own slot always installs as it is.
          disabled: !slot.menus && slot.name !== source.car,
          label: slot.name === source.car ? tr(`${slot.name} (this mod's slot)`) : undefined,
          tags: [...(BIKE_CLASSES.has(slot.className) ? ["bike"] : []), ...(elfMentions(slot.name).length ? ["ELF"] : []), ...(!slot.menus ? ["no menus"] : [])],
        }))} />
      <p className={target ? "iso-slot-status" : "iso-slot-status needed"}>{
        !target ? <Tx t="{0} isn't in this ISO — choose the car it replaces." v={[<code>{source.car}</code>]} />
          : !moved ? <Tx t="Replaces {0}, the slot this mod was made for." v={[<code>{target}</code>]} />
          : !result && !conversion?.error ? <Tx t="Converting the mod for {0}…" v={[<code>{target}</code>]} />
          : counts && !result!.blocked ? <Tx t="Converted for {0}: {1} files changed, {2} renamed. The car takes {3}'s name, logo, price and class." v={[<code>{target}</code>, counts.converted, counts.renamed, <code>{target}</code>]} />
          : <Tx t="Can't go into {0}." v={[<code>{target}</code>]} />
      }</p>
    </div>}
    {target && details && <SlotDetailsPanel slot={target} details={details} logos={logos} edits={card.edits} busy={busy} onEdit={onEdit} />}
    <div className="iso-car-kinds">
      {CATEGORY_ORDER.map((category) => {
        const files = report ? report.categories[category].files : pkg.files.filter((file) => file.category === category);
        const expected = report?.categories[category].expected;
        const present = files.length > 0;
        // A "complete" set is the four menu files / the numbered variants; reward_ and the plain
        // vp_x.carcfg install too but are extras, shown next to the count instead of inflating it.
        const counted = files.filter((file) => category === "flash" ? !file.name.startsWith("reward_") : category === "carcfg" ? isOpponentCarcfg(file.name, pkg.car) : true);
        const extras = files.length - counted.length;
        const partial = present && expected !== undefined && category !== "dat" && category !== "garage" && counted.length < expected;
        const count = category === "dat" || category === "garage" ? null : `${counted.length}${expected !== undefined ? `/${expected}` : ""}${extras ? ` +${extras}` : ""}`;
        return <label key={category} className={`iso-kind ${present ? "" : "missing"} ${partial ? "partial" : ""}`} title={present ? files.map((file) => file.name).join("\n") : tr("Not in this package")}>
          <input type="checkbox" checked={present && card.enabled[category]} disabled={!present || refused || busy} onChange={() => onToggle(category)} />
          <span><strong>{tr(categoryLabels[category].title)}{count && <em>{count}</em>}</strong><small>{!present ? tr("Not in package") : files[0].compiledFrom ? tr(`compiled from ${files[0].compiledFrom} PCKs`) : tr(categoryLabels[category].blurb)}</small></span>
        </label>;
      })}
    </div>
    {!hasIso && <p className="iso-car-note">{tr("Open an ISO to check this car against it.")}</p>}
    {state?.blockers.map((message) => <p className="iso-car-error" key={tr(message)}>{tr(message)}</p>)}
    {report?.errors.map((message) => <p className="iso-car-error" key={tr(message)}>{tr(message)}</p>)}
    {report?.warnings.map((message) => <p className="iso-car-warning" key={tr(message)}>{tr(message)}</p>)}
    {notes.length > 0 && <details className="iso-retarget" open={result?.blocked}>
      <summary><strong>{tr("Conversion report")}</strong><small><Tx t="{0} notes · {1} warnings" v={[notes.length, warnings]} /></small></summary>
      <div className="retarget-report"><RetargetNotes notes={notes} fixTitle="Converted for this ISO" /></div>
    </details>}
  </article>;
}

/**
 * What the game shows for the slot — name, short name and the dealership card — filled with the
 * ISO's current values. A field the user leaves alone isn't written; a field set back to the current
 * value writes nothing either.
 */
function SlotDetailsPanel({ slot, details, logos, edits, busy, onEdit }: {
  slot: string; details: DetailsState; logos: LogoOption[]; edits: DetailInputs; busy: boolean;
  onEdit: (key: keyof SlotDetails, value: string | undefined) => void;
}) {
  if (details.error) return <p className="iso-car-warning">{tr(`Slot details can't be edited: ${details.error}`)}</p>;
  if (!details.details) return <p className="iso-car-note">{tr("Reading the slot's details…")}</p>;
  const current = details.details;
  const art = !current.artProblem;
  /** A value as the user knows it: type and logo by name, the badge as on/off. */
  const describe = (key: keyof SlotDetails, value: string) =>
    key === "showroomType" ? tr(SHOWROOM_TYPES.find((type) => String(type.value) === value)?.label ?? value)
      : key === "logo" ? logos.find((logo) => String(logo.character) === value)?.label ?? value
      : key === "remix" ? tr(value === "true" ? "on" : "off") : value;
  const changed = DETAIL_KEYS.filter((key) => edits[key] !== undefined && edits[key] !== detailText(key, current));
  const field = (key: keyof SlotDetails, input: ReactNode, hint?: string) => {
    const edited = edits[key] !== undefined && edits[key] !== detailText(key, current);
    const raw = edits[key];
    const problem = raw === undefined ? null : parseEdits({ [key]: raw }).problems[0] ?? null;
    return <label className={`iso-detail${edited ? " edited" : ""}${problem ? " invalid" : ""}`} key={key}>
      <span>{tr(DETAIL_LABELS[key])}{edited && <button type="button" className="iso-detail-reset" disabled={busy} title={tr(`Back to ${describe(key, detailText(key, current))}`)} onClick={(event) => { event.preventDefault(); onEdit(key, undefined); }}>↺</button>}</span>
      {input}
      <small>{problem ? tr(problem.replace(/^[^:]+: /, "")) : edited ? tr(`was ${describe(key, detailText(key, current))}`) : hint ? tr(hint) : "\u00a0"}</small>
    </label>;
  };
  const text = (key: keyof SlotDetails, max?: number) => <input className="perf-input" type="text" value={edits[key] ?? detailText(key, current)} maxLength={max} disabled={busy} spellCheck={false}
    onChange={(event) => onEdit(key, event.target.value)} />;
  return <details className="iso-details" open={changed.length > 0 || undefined}>
    <summary>
      <strong>{tr("Slot details")}</strong>
      <small>{changed.length ? <Tx t="{0} changed — written into the shared name tables and dealership" v={[changed.length]} /> : <Tx t="what the game shows for {0}: name, dealership card" v={[slot]} />}</small>
    </summary>
    <div className="iso-detail-grid">
      {field("name", text("name", NAME_MAX), `Dealership · up to ${NAME_MAX}`)}
      {field("shortName", text("shortName", SHORT_NAME_MAX), `Garage, profile · up to ${SHORT_NAME_MAX}`)}
      {field("price", text("price"), "Dollars · charge not confirmed")}
      {field("letter", <select className="perf-input" value={edits.letter ?? current.letter} disabled={busy} onChange={(event) => onEdit("letter", event.target.value)}>
        {SHOWROOM_LETTERS.map((letter) => <option key={letter} value={letter}>{letter}</option>)}
      </select>, art ? "Text and icon; real class unchanged" : "As shown; real class unchanged")}
      {field("showroomType", <select className="perf-input" value={edits.showroomType ?? String(current.showroomType)} disabled={busy} onChange={(event) => onEdit("showroomType", event.target.value)}>
        {SHOWROOM_TYPES.map((type) => <option key={type.value} value={String(type.value)}>{tr(type.label)}</option>)}
      </select>, art ? "Text and icon; real class unchanged" : "As shown; real class unchanged")}
      {art && logos.length > 0 && field("logo", <select className="perf-input" value={edits.logo ?? String(current.logo)} disabled={busy} onChange={(event) => onEdit("logo", event.target.value)}>
        {logos.map((logo) => <option key={logo.character} value={String(logo.character)}>{logo.label}</option>)}
      </select>, "Dealership, Manage Vehicles, garage")}
      {art && field("remix", <span className="iso-detail-check"><input type="checkbox" checked={(edits.remix ?? String(current.remix)) === "true"} disabled={busy}
        onChange={(event) => onEdit("remix", String(event.target.checked))} />{tr("Show the REMIX badge on the icon")}</span>)}
    </div>
    {!art && <p className="iso-detail-note">{tr(`The icon of this slot can't be changed: ${current.artProblem}`)}</p>}
    <p className="iso-detail-note">{tr("These change what the game shows. The car's real class, group and unlock stay the slot's. A car already bought in a save may keep the name it was bought with.")}</p>
  </details>;
}
