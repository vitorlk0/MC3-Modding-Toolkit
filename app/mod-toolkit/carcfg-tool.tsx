import { tr, Tx } from "../i18n";
import { useCallback, useEffect, useMemo, useState } from "react";
import { processCarcfg, readCarcfgTypeName, scanCarcfg, type CarcfgChange, type CarcfgParameter } from "../../src/carcfg";
import { embeddedIndexes, guessGroup, readPartGroups, type PartGroup } from "../../src/carcfg-parts";
import { PckDocument } from "../../src/pck";
import { PythonRandom } from "../../src/python-random";
import { basename, parentFolder, parentPath, pickFiles, readToolkitFile, sizeLabel, writeVerified, type ToolkitFile } from "./toolkit-io";
import { loadRecent, pushRecent, saveRecent } from "../recent-paths";

/**
 * Carcfg Randomizer — sets the range of customization indexes the AI opponents may use.
 *
 * The batch tool of the pair: a car's opponent setups are a set of files that only make sense
 * randomized together, so every file is previewed and saved as one operation.
 *
 * Each field draws either from a typed MIN..MAX range or, once the car's garage `_g.pck` is loaded,
 * from the indexes whose part is actually embedded there. The garage PCK is only read, never saved.
 *
 * Preview runs the whole thing in memory and shows what each field would become; nothing reaches
 * disk until Save, which writes only the files that actually changed and reads each one back.
 */

const carcfgFilters = [{ name: "MC3 opponent CarCfg", extensions: ["carcfg"] }];
const garageFilters = [{ name: "MC3 garage car PCK", extensions: ["pck"] }];
const RECENTS_KEY = "mc3pae.recentCarcfgFolders";
const GARAGE_RECENTS_KEY = "mc3pae.recentGaragePcks";

type Source = "range" | "garage";
/** `enabled: false` keeps the field on the list with its settings but leaves it untouched in
 *  every file — for a field already set the way it should stay. */
type RangeParameter = { key: string; enabled: boolean; min: number; max: number };

const defaultParameters: RangeParameter[] = [
  { key: "FrontBumperIdx", enabled: true, min: 0, max: 5 }, { key: "RearBumperIdx", enabled: true, min: 0, max: 5 },
  { key: "SideSkirtIdx", enabled: true, min: 0, max: 5 }, { key: "SpoilerIdx", enabled: true, min: 0, max: 5 },
  { key: "HoodIdx", enabled: true, min: 0, max: 5 }, { key: "CarbonFiberHood", enabled: true, min: 0, max: 1 },
  { key: "FrontGrillIdx", enabled: true, min: 0, max: 3 }, { key: "TaillightGeomIdx", enabled: true, min: 0, max: 3 },
];

/** Wheel stance fields set to one typed value in every file — for opponents sitting so low the
 *  wheels cut through the body. Off by default, so nothing is touched unless asked. The `0`/`1`
 *  suffix is most likely front/rear, but that isn't confirmed, so the UI doesn't name them. The
 *  hints are the ranges found across the game's 1087 `.carcfg` files. */
type FixedField = { base: string; label: string; enabled: boolean; values: [number, number]; hint: [number, number] };
const defaultFixed: FixedField[] = [
  { base: "RideHeight", label: "Ride height", enabled: false, values: [0, 0], hint: [0, 14] },
  { base: "RimSize", label: "Rim size", enabled: false, values: [19, 19], hint: [12, 28] },
  { base: "TireProfile", label: "Tire profile", enabled: false, values: [7, 7], hint: [1, 7] },
];

type Garage = { file: ToolkitFile; groups: PartGroup[] };

type Preview = {
  file: ToolkitFile;
  bytes: Uint8Array;
  changed: boolean;
  changes: CarcfgChange[];
  missingKeys: string[];
};

const exclusionKey = (field: string, group: string) => `${field}|${group}`;

export function CarcfgTool({ dropped, onConsumeDrop, onStatus, isPathBlocked, onPendingChange }: {
  dropped: string[] | null;
  onConsumeDrop: () => void;
  onStatus: (message: string) => void;
  isPathBlocked: (path: string) => string | null;
  onPendingChange: (pending: boolean) => void;
}) {
  const [files, setFiles] = useState<ToolkitFile[]>([]);
  const [parameters, setParameters] = useState<RangeParameter[]>(defaultParameters);
  const [source, setSource] = useState<Source>("range");
  const [garage, setGarage] = useState<Garage | null>(null);
  /** Field → group path the user picked by hand; "" means "no group, use the range". Fields not
   *  listed here follow the name-based guess. */
  const [groupOverrides, setGroupOverrides] = useState<Record<string, string>>({});
  /** Embedded indexes switched off per field and group, so picking another group starts clean. */
  const [excluded, setExcluded] = useState<Record<string, number[]>>({});
  const [fixedFields, setFixedFields] = useState<FixedField[]>(defaultFixed);
  const [seedText, setSeedText] = useState("");
  const [preview, setPreview] = useState<Preview[] | null>(null);
  const [usedSeed, setUsedSeed] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [recentFolders, setRecentFolders] = useState<string[]>(() => loadRecent(RECENTS_KEY));
  const [recentGarages, setRecentGarages] = useState<string[]>(() => loadRecent(GARAGE_RECENTS_KEY));

  const useGarage = source === "garage" && garage !== null;

  const groupFor = useCallback((field: string): PartGroup | null => {
    if (!garage) return null;
    const key = field.trim();
    if (key in groupOverrides) return garage.groups.find((group) => group.path === groupOverrides[key]) ?? null;
    return guessGroup(key, garage.groups);
  }, [garage, groupOverrides]);

  const allowedFor = useCallback((field: string, group: PartGroup) => {
    const off = excluded[exclusionKey(field.trim(), group.path)] ?? [];
    return embeddedIndexes(group).filter((index) => !off.includes(index));
  }, [excluded]);

  /** What the engine is actually given: a list for every field bound to a group in garage mode,
   *  the typed range for everything else. */
  const drawn = useMemo<CarcfgParameter[]>(() => parameters.filter((parameter) => parameter.enabled).map((parameter) => {
    const group = useGarage ? groupFor(parameter.key) : null;
    return group
      ? { key: parameter.key, min: 0, max: 0, allowed: allowedFor(parameter.key, group) }
      : { key: parameter.key, min: parameter.min, max: parameter.max };
  }), [parameters, useGarage, groupFor, allowedFor]);
  const fixed = useMemo<CarcfgParameter[]>(() => fixedFields.filter((field) => field.enabled)
    .flatMap((field) => field.values.map((value, side) => ({ key: `${field.base}${side}`, min: 0, max: 0, fixed: value }))), [fixedFields]);
  const resolved = useMemo(() => [...drawn, ...fixed], [drawn, fixed]);

  const parametersProblem = useMemo(() => {
    const keys = parameters.map((parameter) => parameter.key.trim());
    if (!drawn.length && !fixed.length) return "Tick at least one field.";
    if (!keys.every((key) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) || new Set(keys).size !== keys.length) return "Field names must be unique identifiers.";
    const clash = fixed.find((field) => drawn.some((parameter) => parameter.key.trim() === field.key));
    if (clash) return `${clash.key} is both randomized and set to a fixed value — remove it from the list or untick its fixed value.`;
    for (const field of fixed) if (!Number.isInteger(field.fixed) || field.fixed! < 0) return `${field.key}: the fixed value must be a whole number of zero or more.`;
    for (const parameter of resolved) {
      if (parameter.allowed) { if (!parameter.allowed.length) return `${parameter.key} has no index left to draw from — switch at least one back on.`; continue; }
      const ok = [parameter.min, parameter.max].every((value) => Number.isInteger(value) && value >= 0);
      if (!ok) return "Every MIN and MAX must be a whole number of zero or more.";
      if (parameter.min > parameter.max) return `${parameter.key}: MIN cannot be greater than MAX.`;
    }
    return "";
  }, [parameters, resolved, drawn, fixed]);
  const parametersValid = !parametersProblem;

  // Any change to the inputs invalidates a preview: showing values that no longer follow from the
  // settings on screen is the one way this tool could write something the user did not agree to.
  useEffect(() => { setPreview(null); setUsedSeed(null); }, [files, resolved, seedText]);
  useEffect(() => { onPendingChange((preview ?? []).some((entry) => entry.changed)); }, [preview, onPendingChange]);

  const loadGarage = useCallback(async (path: string) => {
    const blocked = isPathBlocked(path);
    if (blocked) { setError(blocked); return; }
    try {
      setBusy(true);
      setError("");
      const file = await readToolkitFile(path);
      // Parsed into a throwaway document: this tab only reads the garage PCK, and the vehicle set
      // the other two tabs edit never sees it.
      const document = new PckDocument(file.name, file.bytes.buffer.slice(file.bytes.byteOffset, file.bytes.byteOffset + file.bytes.byteLength) as ArrayBuffer);
      const groups = readPartGroups(document);
      if (!groups.length) { setError(`${file.name} has no part categories in its anchor tree and LOD tables, so it cannot list the parts in use.`); return; }
      setGarage({ file, groups });
      setRecentGarages(pushRecent(GARAGE_RECENTS_KEY, file.path));
      setGroupOverrides({});
      setExcluded({});
      setSource("garage");
      onStatus(`${file.name}: ${groups.length} part categories read`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That PCK could not be read.");
    } finally {
      setBusy(false);
    }
  }, [isPathBlocked, onStatus]);

  const addFiles = useCallback(async (paths: string[]) => {
    const accepted = paths.filter((path) => path.toLowerCase().endsWith(".carcfg"));
    if (!accepted.length) { setError("Only .carcfg files can be added."); return; }
    const blocked = accepted.map(isPathBlocked).find(Boolean);
    if (blocked) { setError(blocked); return; }
    try {
      setBusy(true);
      setError("");
      const opened = await Promise.all(accepted.map(readToolkitFile));
      setFiles((current) => {
        const byPath = new Map(current.map((file) => [file.path.toLowerCase(), file]));
        for (const file of opened) byPath.set(file.path.toLowerCase(), file);
        return [...byPath.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      });
      setRecentFolders(pushRecent(RECENTS_KEY, parentPath(opened[0].path)));
      if (accepted.length !== paths.length) setError(`${paths.length - accepted.length} file(s) were not .carcfg and were skipped.`);
      onStatus(`${opened.length} CarCfg file${opened.length === 1 ? "" : "s"} added`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Those files could not be read.");
    } finally {
      setBusy(false);
    }
  }, [isPathBlocked, onStatus]);

  useEffect(() => {
    if (!dropped) return;
    const paths = [...dropped];
    onConsumeDrop();
    // A dropped PCK is the garage reference; everything else goes to the CarCfg list.
    const pck = paths.find((path) => path.toLowerCase().endsWith(".pck"));
    const rest = paths.filter((path) => !path.toLowerCase().endsWith(".pck"));
    if (pck) void loadGarage(pck);
    if (rest.length) void addFiles(rest);
  }, [dropped, addFiles, loadGarage, onConsumeDrop]);

  const browse = (defaultPath?: string) => {
    void pickFiles(carcfgFilters, true, defaultPath).then((paths) => { if (paths.length) void addFiles(paths); });
  };
  const browseGarage = () => {
    void pickFiles(garageFilters, false, garage ? parentPath(garage.file.path) : undefined).then((paths) => { if (paths.length) void loadGarage(paths[0]); });
  };

  const scans = useMemo(() => {
    // Only the drawn fields: a fixed field is overwritten regardless, so its current value is
    // never "outside the draw".
    if (!files.length || !parametersValid || !drawn.length) return null;
    try { return files.map((file) => ({ file, scan: scanCarcfg(file.bytes, drawn) })); }
    catch { return null; }
  }, [files, drawn, parametersValid]);

  const totals = useMemo(() => {
    if (!scans) return null;
    return {
      present: scans.reduce((sum, entry) => sum + entry.scan.present, 0),
      missing: scans.reduce((sum, entry) => sum + entry.scan.missing, 0),
      outside: scans.reduce((sum, entry) => sum + entry.scan.outsideRange, 0),
      fractional: scans.reduce((sum, entry) => sum + entry.scan.fields.filter((field) => field.occurrences.some((hit) => hit.fractional)).length, 0),
      withBom: scans.filter((entry) => entry.scan.hasBom).length,
    };
  }, [scans]);

  /** Setups whose TypeName names another car than the garage PCK — the index lists would be wrong. */
  const foreignFiles = useMemo(() => {
    if (!garage) return [];
    const car = garage.file.name.replace(/(_g)?\.pck$/i, "").toLowerCase();
    return files.filter((file) => { const type = readCarcfgTypeName(file.bytes); return type !== null && type.toLowerCase() !== car; });
  }, [files, garage]);

  const runPreview = useCallback(() => {
    if (!files.length || !parametersValid) return;
    try {
      setError("");
      const trimmed = seedText.trim();
      if (trimmed && !/^\d+$/.test(trimmed)) { setError("The seed must be a whole number, or left empty."); return; }
      // A blank seed still gets a concrete one, so a result the user liked can be reproduced.
      const seed = trimmed ? Number(trimmed) : Math.floor(Math.random() * 2 ** 31);
      // One generator for the whole run, in file order, matching how the precedent tools draw.
      const rng = new PythonRandom(seed);
      setPreview(files.map((file) => {
        const result = processCarcfg(file.bytes, resolved, rng);
        return { file, bytes: result.bytes, changed: result.changed, changes: result.changes, missingKeys: result.missingKeys };
      }));
      setUsedSeed(seed);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The preview could not be built.");
    }
  }, [files, parametersValid, resolved, seedText]);

  const save = useCallback(async () => {
    const pending = (preview ?? []).filter((entry) => entry.changed);
    if (!pending.length) return;
    try {
      setBusy(true);
      setError("");
      for (const entry of pending) await writeVerified(entry.file.path, entry.bytes);
      // Re-read every saved file so the next preview starts from what is now on disk.
      const reopened = new Map(await Promise.all(pending.map(async (entry) => [entry.file.path, await readToolkitFile(entry.file.path)] as const)));
      setFiles((current) => current.map((file) => reopened.get(file.path) ?? file));
      setPreview(null);
      setUsedSeed(null);
      const fields = pending.reduce((sum, entry) => sum + entry.changes.length, 0);
      onStatus(`${pending.length} CarCfg file${pending.length === 1 ? "" : "s"} saved · ${fields} field${fields === 1 ? "" : "s"} changed`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The files could not be saved.");
    } finally {
      setBusy(false);
    }
  }, [onStatus, preview]);

  const changedCount = (preview ?? []).filter((entry) => entry.changed).length;
  const updateParameter = (index: number, patch: Partial<RangeParameter>) =>
    setParameters((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item));
  const setGroup = (field: string, path: string) => setGroupOverrides((current) => ({ ...current, [field.trim()]: path }));
  const toggleIndex = (field: string, group: PartGroup, index: number) => {
    const key = exclusionKey(field.trim(), group.path);
    setExcluded((current) => {
      const off = current[key] ?? [];
      return { ...current, [key]: off.includes(index) ? off.filter((value) => value !== index) : [...off, index] };
    });
  };
  const resetDefaults = () => { setParameters(defaultParameters); setGroupOverrides({}); setExcluded({}); setFixedFields(defaultFixed); };
  const updateFixed = (index: number, patch: Partial<FixedField>) =>
    setFixedFields((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item));
  const setFixedValue = (index: number, side: number, value: number) =>
    setFixedFields((current) => current.map((item, itemIndex) => itemIndex !== index ? item
      : { ...item, values: item.values.map((old, oldSide) => oldSide === side ? value : old) as [number, number] }));

  const rangeInputs = (parameter: RangeParameter, index: number) => <>
    <input type="number" min="0" step="1" aria-label={tr(`Minimum for ${parameter.key || `field ${index + 1}`}`)} value={parameter.min} onChange={(event) => updateParameter(index, { min: Number(event.target.value) })} />
    <span>—</span>
    <input type="number" min="0" step="1" aria-label={tr(`Maximum for ${parameter.key || `field ${index + 1}`}`)} value={parameter.max} onChange={(event) => updateParameter(index, { max: Number(event.target.value) })} />
  </>;
  const enabledBox = (parameter: RangeParameter, index: number) =>
    <input type="checkbox" checked={parameter.enabled} title={parameter.enabled ? tr("Randomized — untick to leave this field as it is") : tr("Left as it is — tick to randomize")}
      aria-label={tr(`Randomize ${parameter.key || `field ${index + 1}`}`)} onChange={(event) => updateParameter(index, { enabled: event.target.checked })} />;
  const removeButton = (parameter: RangeParameter, index: number) =>
    <button type="button" aria-label={tr(`Remove ${parameter.key || `field ${index + 1}`}`)} onClick={() => setParameters((current) => current.filter((_, itemIndex) => itemIndex !== index))}>×</button>;

  const embeddedTotal = garage ? garage.groups.reduce((sum, group) => sum + embeddedIndexes(group).length, 0) : 0;
  const variantTotal = garage ? garage.groups.reduce((sum, group) => sum + group.variants.length, 0) : 0;

  return <>
    <section className="toolkit-hero">
      <div>
        <p className="eyebrow">{tr("OPPONENT CUSTOMIZATION")}</p>
        <h2>{tr("Randomize the parts the AI cars wear")}</h2>
        <p className="toolkit-hero-copy"><Tx t="Gives every listed field in a car's opponent {0} setups a fresh index. Draw from a {1}, or load the car's {2} and draw only from the parts it actually carries — an index whose part isn't in the car makes that part vanish on the opponent. Only the digits are rewritten — indentation, spacing and line endings are preserved exactly." v={[<code>.carcfg</code>, <strong>{tr("typed range")}</strong>, <strong>{tr("garage PCK")}</strong>]} /></p>
      </div>
      <div className="toolkit-facts">
        <div><span>{tr("INPUT")}</span><strong>{tr(".carcfg + optional _g.pck")}</strong></div>
        <div><span>{tr("DRAWS FROM")}</span><strong>{tr("Range or parts in use")}</strong></div>
        <div><span>{tr("ON SAVE")}</span><strong>{tr("Changed files only")}</strong></div>
      </div>
    </section>

    <section className="toolkit-panel">
      <div className="toolkit-panel-head">
        <div><span className="step-number">01</span><div><h3>{tr("Select the opponent CarCfg files")}</h3><p>{tr("A car's whole opponent set is usually randomized together.")}</p></div></div>
        <span className="toolkit-required">{tr("REQUIRED")}</span>
      </div>
      <div className="toolkit-file-row">
        <button className="toolkit-drop" type="button" disabled={busy} onClick={() => browse(files.length ? parentPath(files[0].path) : undefined)}>
          <span className="toolkit-file-type">{tr("CFG")}</span>
          <span className="toolkit-drop-copy">
            <strong>{files.length ? tr(`${files.length} CarCfg file${files.length === 1 ? "" : "s"} loaded`) : tr("Choose .carcfg files")}</strong>
            <small>{files.length ? tr(`${sizeLabel(files.reduce((sum, file) => sum + file.bytes.length, 0))} · click to add more, or drop them on the window`) : tr("Click to browse, or drag them onto the window")}</small>
          </span>
          <span className="toolkit-drop-action">{files.length ? tr("+ ADD") : tr("+ OPEN")}</span>
        </button>
        {files.length > 0 && <div className="toolkit-chip-list">
          {files.map((file) => <span className="toolkit-file-chip" key={file.path} title={file.path}>
            <strong>{file.name}</strong>
            <small>{parentFolder(file.path)}</small>
            <button type="button" aria-label={tr(`Remove ${file.name}`)} onClick={() => setFiles((current) => current.filter((item) => item.path !== file.path))}>×</button>
          </span>)}
          <button className="link-button" type="button" onClick={() => setFiles([])}>{tr("Clear all")}</button>
        </div>}
        {recentFolders.length > 0 && <div className="toolkit-recents">
          <div className="toolkit-recents-head">
            <span>{tr("Recent folders")}</span>
            <button className="link-button" type="button" onClick={() => { saveRecent(RECENTS_KEY, []); setRecentFolders([]); }}>{tr("Clear list")}</button>
          </div>
          <div className="toolkit-recents-list">
            {recentFolders.map((folder) => <button key={folder} className="toolkit-recent-item" type="button" title={folder} disabled={busy} onClick={() => browse(folder)}>
              <strong>{basename(folder)}</strong>
              <small>{folder}</small>
            </button>)}
          </div>
        </div>}
      </div>
    </section>

    <section className="toolkit-panel">
      <div className="toolkit-panel-head">
        <div><span className="step-number">02</span><div><h3>{tr("Load the car's garage PCK")}</h3><p><Tx t="The parts embedded in {0} are the ones the car actually uses. It is only read, never saved." v={[<code>_g.pck</code>]} /></p></div></div>
        <span className="toolkit-required">{tr("OPTIONAL")}</span>
      </div>
      <div className="toolkit-file-row">
        <button className="toolkit-drop" type="button" disabled={busy} onClick={browseGarage}>
          <span className="toolkit-file-type">{tr("PCK")}</span>
          <span className="toolkit-drop-copy">
            <strong>{garage ? garage.file.name : tr("Choose the car's _g.pck")}</strong>
            <small title={garage?.file.path}>{garage
              ? tr(`${garage.groups.length} part categories · ${embeddedTotal} of ${variantTotal} variants embedded · ${parentFolder(garage.file.path)}`)
              : tr("Needed only to draw from the parts in use. Click to browse, or drop it on the window")}</small>
          </span>
          <span className="toolkit-drop-action">{garage ? tr("CHANGE") : tr("+ OPEN")}</span>
        </button>
        {garage && <div className="toolkit-chip-list">
          <button className="link-button" type="button" onClick={() => { setGarage(null); setSource("range"); }}>{tr("Unload")}</button>
        </div>}
        {recentGarages.length > 0 && <div className="toolkit-recents">
          <div className="toolkit-recents-head">
            <span>{tr("Recent garage PCKs")}</span>
            <button className="link-button" type="button" onClick={() => { saveRecent(GARAGE_RECENTS_KEY, []); setRecentGarages([]); }}>{tr("Clear list")}</button>
          </div>
          <div className="toolkit-recents-list">
            {recentGarages.map((path) => <button key={path} type="button" title={path} disabled={busy}
              className={garage?.file.path.toLowerCase() === path.toLowerCase() ? "toolkit-recent-item active" : "toolkit-recent-item"}
              onClick={() => void loadGarage(path)}>
              <strong>{basename(path)}</strong>
              <small>{parentPath(path)}</small>
            </button>)}
          </div>
        </div>}
        {garage && !/_g\.pck$/i.test(garage.file.name) && <p className="carcfg-warning"><Tx t="This file isn't named {0}. The player and opponent PCKs list every slot but embed no parts, so they can't tell which parts are in use — load the garage PCK." v={[<code>_g.pck</code>]} /></p>}
        {foreignFiles.length > 0 && <p className="carcfg-warning">
          <Tx t="{0} setup{1} to another car ({2} isn't {3}): {4}. The index lists come from this PCK, so they would be wrong for those files." v={[foreignFiles.length, foreignFiles.length === 1 ? tr(" belongs") : tr("s belong"), <code>TypeName</code>, garage!.file.name.replace(/(_g)?\.pck$/i, ""), foreignFiles.map((file) => file.name).join(", ")]} /></p>}
      </div>
    </section>

    <section className="toolkit-panel">
      <div className="toolkit-panel-head">
        <div><span className="step-number">03</span><div><h3>{tr("Choose where each value comes from")}</h3><p>{useGarage ? tr("Click an index to leave it out of the draw.") : tr("Each field draws a whole number between its MIN and MAX.")}</p></div></div>
        <button className="link-button" type="button" onClick={resetDefaults}>{tr("Reset to defaults")}</button>
      </div>
      <div className="carcfg-settings">
        <div className="carcfg-mode">
          <button type="button" className={source === "range" ? "active" : ""} onClick={() => setSource("range")}>
            <strong>{tr("Typed range")}</strong><small>{tr("New value in MIN..MAX, taken literally")}</small>
          </button>
          <button type="button" className={source === "garage" ? "active" : ""} disabled={!garage} title={garage ? undefined : tr("Load a _g.pck in step 02 first")} onClick={() => setSource("garage")}>
            <strong>{tr("Parts in the garage PCK")}</strong><small>{garage ? tr("Only indexes whose part is embedded in the _g.pck") : tr("Load a _g.pck in step 02 to use this")}</small>
          </button>
        </div>
        <label className="carcfg-seed">
          <span>{tr("Seed")}</span>
          <input type="text" inputMode="numeric" placeholder={tr("leave empty for a new one")} value={seedText} onChange={(event) => setSeedText(event.target.value)} />
          <small>{tr("The same seed and settings always produce the same values. With MIN at 0, a typed range matches the original limiter script.")}</small>
        </label>
      </div>
      {!useGarage ? (
        <div className="carcfg-parameters">
          {parameters.map((parameter, index) => <div className={parameter.enabled ? "carcfg-parameter" : "carcfg-parameter off"} key={index}>
            {enabledBox(parameter, index)}
            <input type="text" aria-label={tr(`Field ${index + 1}`)} value={parameter.key} onChange={(event) => updateParameter(index, { key: event.target.value })} />
            {rangeInputs(parameter, index)}
            {removeButton(parameter, index)}
          </div>)}
        </div>
      ) : (
        <div className="carcfg-parameters garage">
          {parameters.map((parameter, index) => {
            const group = groupFor(parameter.key);
            const allowed = group ? allowedFor(parameter.key, group) : [];
            return <div className={parameter.enabled ? "carcfg-parameter garage" : "carcfg-parameter garage off"} key={index}>
              {enabledBox(parameter, index)}
              <input type="text" aria-label={tr(`Field ${index + 1}`)} value={parameter.key} onChange={(event) => updateParameter(index, { key: event.target.value })} />
              <select aria-label={tr(`Part category for ${parameter.key}`)} value={group?.path ?? ""} onChange={(event) => setGroup(parameter.key, event.target.value)}>
                <option value="">{tr("No category — typed range")}</option>
                {garage!.groups.map((item) => <option key={item.path} value={item.path}>{item.path} · {embeddedIndexes(item).length}/{item.variants.length}</option>)}
              </select>
              {group ? <div className="carcfg-index-chips">
                {group.variants.filter((variant) => variant.embedded).map((variant) => {
                  const on = allowed.includes(variant.index);
                  return <button key={variant.index} type="button" className={on ? "on" : ""} aria-pressed={on} title={`${variant.anchor}${on ? "" : " — left out of the draw"}`} onClick={() => toggleIndex(parameter.key, group, variant.index)}>{variant.index}</button>;
                })}
                <small><Tx t="{0} of {1} in the draw" v={[allowed.length, group.variants.length]} /></small>
              </div> : <div className="carcfg-range-fallback">{rangeInputs(parameter, index)}<small>{tr("not a part category in this PCK")}</small></div>}
              {removeButton(parameter, index)}
            </div>;
          })}
        </div>
      )}
      <div className="carcfg-parameter-actions">
        <button className="link-button" type="button" onClick={() => setParameters((current) => [...current, { key: "NewFieldIdx", enabled: true, min: 0, max: 0 }])}>{tr("+ Add field")}</button>
      </div>
      <div className="carcfg-fixed">
        <div className="carcfg-fixed-head">
          <strong>{tr("Fixed values")}</strong>
          <small>{tr("Tick a row to write the same value into every file. Unticked rows are left exactly as they are.")}</small>
        </div>
        {fixedFields.map((field, index) => {
          const outside = field.enabled && field.values.some((value) => value < field.hint[0] || value > field.hint[1]);
          return <div className={field.enabled ? "carcfg-fixed-row on" : "carcfg-fixed-row"} key={field.base}>
            <label>
              <input type="checkbox" checked={field.enabled} onChange={(event) => updateFixed(index, { enabled: event.target.checked })} />
              <strong>{tr(field.label)}</strong>
            </label>
            <div className="carcfg-fixed-values">
              {field.values.map((value, side) => <span className="carcfg-fixed-value" key={side}>
                <code>{field.base}{side}</code>
                <input type="number" min="0" step="1" disabled={!field.enabled} aria-label={`${field.base}${side}`} value={value} onChange={(event) => setFixedValue(index, side, Number(event.target.value))} />
              </span>)}
            </div>
            <small className={outside ? "outside" : ""}>{outside ? tr(`outside the ${field.hint[0]}–${field.hint[1]} the game's own files use`) : tr(`game files use ${field.hint[0]}–${field.hint[1]}`)}</small>
          </div>;
        })}
      </div>
      {!parametersValid && <div className="carcfg-parameter-actions"><span className="carcfg-invalid">{parametersProblem}</span></div>}
    </section>

    <section className="toolkit-panel">
      <div className="toolkit-panel-head">
        <div><span className="step-number">04</span><div><h3>{tr("Review what will change")}</h3><p>{tr("Nothing is written until you save.")}</p></div></div>
        {totals && <div className="toolkit-chips">
          <span><Tx t="{0} found" v={[<strong>{totals.present}</strong>]} /></span>
          {totals.missing > 0 && <span><Tx t="{0} missing" v={[<strong>{totals.missing}</strong>]} /></span>}
          <span className={totals.outside ? "prior" : ""}><strong>{totals.outside}</strong> {useGarage ? tr("not in the draw") : tr("out of range")}</span>
        </div>}
      </div>
      {!files.length ? (
        <div className="toolkit-empty"><span>{tr("CFG")}</span><strong>{tr("No CarCfg files loaded")}</strong><p>{tr("Add a car's opponent setups to see which fields they carry.")}</p></div>
      ) : <>
        {totals && totals.fractional > 0 && <p className="carcfg-warning">
          <Tx t="{0} of the fields you listed hold a decimal value in these files. The pattern matches only its whole part, so writing an index would leave the fraction behind ({1} becomes {2}). Both original scripts behave the same way — remove that field unless you mean it." v={[totals.fractional, <code>-2.500000</code>, <code>3.500000</code>]} /></p>}
        {totals && totals.withBom > 0 && <p className="carcfg-note">
          <Tx t="{0} of these files start with a byte-order mark, left by an earlier run of the original script. It is preserved as found; files without one stay without one." v={[totals.withBom]} /></p>}
        {useGarage && totals && totals.outside > 0 && !preview && <p className="carcfg-warning">
          <Tx t="{0} current value{1} point{2} outside the draw — most often a part that isn't embedded in the car, which the opponent then shows without." v={[totals.outside, totals.outside === 1 ? "" : "s", totals.outside === 1 ? "s" : ""]} /></p>}
        {!preview ? (
          <div className="carcfg-preview-cta">
            <div><strong><Tx t="{0} file{1} ready" v={[files.length, files.length === 1 ? "" : "s"]} /></strong><small>{tr("The draw runs in memory first so you can check every value before saving.")}</small></div>
            <button className="toolkit-primary" type="button" disabled={busy || !parametersValid} onClick={runPreview}><Tx t="PREVIEW CHANGES{0}" v={[<span>→</span>]} /></button>
          </div>
        ) : (
          <div className="carcfg-results">
            {usedSeed !== null && <p className="carcfg-note"><Tx t="Seed {0} produced these values. Enter it above to get exactly this result again." v={[<strong>{usedSeed}</strong>]} /></p>}
            {preview.map((entry, index) => <details className="toolkit-category" key={entry.file.path} open={index === 0 && entry.changed}>
              <summary>
                <span className="toolkit-category-index">{String(index + 1).padStart(2, "0")}</span>
                <span><strong>{entry.file.name}</strong><small title={entry.file.path}>{parentFolder(entry.file.path)}</small></span>
                {entry.missingKeys.length > 0 && <span className="toolkit-category-removed-flag" title={tr(`Not present in this file: ${entry.missingKeys.join(", ")}`)}><Tx t="{0} MISSING" v={[entry.missingKeys.length]} /></span>}
                <span className={entry.changed ? "toolkit-category-count changed" : "toolkit-category-count"}><Tx t="{0} CHANGE{1}" v={[entry.changes.length, entry.changes.length === 1 ? "" : "S"]} /></span>
                <i />
              </summary>
              {entry.changes.length === 0
                ? <p className="carcfg-nochange">{tr("Every drawn value matches what the file already holds — this file will not be written.")}</p>
                : <div className="carcfg-change-grid">
                  {entry.changes.map((change) => <div className="carcfg-change" key={`${change.key}-${change.line}`}>
                    <strong>{change.key}</strong>
                    <span className={change.oldAllowed ? "carcfg-old" : "carcfg-old invalid"} title={change.oldAllowed ? undefined : tr("Was outside the draw")}>{change.oldValue}</span>
                    <span className="carcfg-arrow">→</span>
                    <span className="carcfg-new">{change.newValue}</span>
                    <small><Tx t="line {0}" v={[change.line]} /></small>
                  </div>)}
                </div>}
            </details>)}
          </div>
        )}
      </>}
    </section>

    {preview && <section className="toolkit-actions">
      <div>
        <strong><Tx t="{0} of {1} file{2} will be written" v={[changedCount, preview.length, preview.length === 1 ? "" : "s"]} /></strong>
        <small>{changedCount ? tr("Each one is overwritten in place, then read back and compared byte for byte. Files with no change are left alone.") : tr("Nothing to write — no value would change.")}</small>
      </div>
      <div className="carcfg-actions">
        <button className="toolkit-secondary" type="button" disabled={busy} onClick={runPreview}>{tr("REROLL")}</button>
        <button className="toolkit-primary" type="button" disabled={busy || !changedCount} onClick={() => void save()}>{busy ? tr("SAVING…") : tr(`SAVE ${changedCount} FILE${changedCount === 1 ? "" : "S"}`)}<span>→</span></button>
      </div>
    </section>}

    {error && <section className="toolkit-error"><span>!</span><div><strong>{tr("Action required")}</strong><p>{tr(error)}</p></div></section>}
  </>;
}
