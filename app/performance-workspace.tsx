import { tr, Tx } from "./i18n";
import { useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import { evaluateFieldInput } from "../src/expression";
import { checkFieldValue, encodeField, formatFieldValue, PerformanceLayout, perfGroups, perfSections, sameStored, type PerfField, type PerfMode, type PerfSection } from "../src/performance";
import { roleLabels, roles, sizeLabel, type VehicleRole, type VehicleSlots } from "./vehicle-types";

/**
 * Performance — the car's VehSim, VehGyro and VehZone values, edited once for the whole vehicle set.
 *
 * A car's three PCKs carry the same performance at different addresses (see `src/performance.ts`),
 * so every edit is resolved and written into each loaded PCK through that PCK's own pointers. The
 * values shown come from one role; the others are compared against it and any disagreement is
 * surfaced rather than hidden. Edits live in memory like the rest of the vehicle set and reach disk
 * through its Save.
 */

export type PerfWrite = { role: VehicleRole; offset: number; bytes: Uint8Array };

const modeLabels: Record<PerfMode, string> = { base: "Base", mods: "Mods" };
const modes: PerfMode[] = ["base", "mods"];
const hexOffset = (value: number) => `+0x${value.toString(16).toUpperCase().padStart(2, "0")}`;
const modesFor = (section: PerfSection): PerfMode[] => section.scope === "global" ? ["base"] : modes;

type RoleLayout = { role: VehicleRole; layout: PerformanceLayout | null; error: string | null; saved: Uint8Array };

function FieldInput({ field, value, invalidHint, onCommit }: { field: PerfField; value: number | null; invalidHint?: string; onCommit(value: number): string | null }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState("");
  // Esc flags the blur that follows as a cancel; clearing the draft alone wouldn't stop that blur,
  // which still sees the old draft.
  const cancelled = useRef(false);
  const shown = formatFieldValue(field.type, value);
  if (field.options) {
    const known = field.options.some((option) => option.value === value);
    return <select className="perf-select" value={value ?? ""} disabled={value === null} onChange={(event) => onCommit(Number(event.target.value))}>
      {!known && value !== null && <option value={value}><Tx t="{0} · unknown" v={[value]} /></option>}
      {field.options.map((option) => <option key={option.value} value={option.value}>{option.value} · {tr(option.label)}</option>)}
    </select>;
  }
  const commit = () => {
    if (cancelled.current) { cancelled.current = false; setDraft(null); setError(""); return; }
    if (draft === null) return;
    const trimmed = draft.trim();
    if (trimmed === "" || trimmed === shown) { setDraft(null); setError(""); return; }
    const parsed = evaluateFieldInput(trimmed);
    if (parsed === null) { setError("Not a number or expression."); return; }
    const problem = onCommit(parsed);
    if (problem) { setError(problem); return; }
    setDraft(null); setError("");
  };
  return <input
    className={`perf-input${error ? " invalid" : ""}`}
    value={draft ?? shown}
    disabled={value === null}
    title={error || invalidHint || tr("A value or an expression — click at the end and type *1.1 or +50. Enter applies, Esc cancels.")}
    spellCheck={false}
    onFocus={() => setDraft(shown)}
    onChange={(event) => { setDraft(event.target.value); setError(""); }}
    onBlur={commit}
    onKeyDown={(event) => {
      if (event.key === "Enter") { event.preventDefault(); (event.target as HTMLInputElement).blur(); }
      if (event.key === "Escape") { cancelled.current = true; (event.target as HTMLInputElement).blur(); }
    }}
  />;
}

export function PerformanceWorkspace({ slots, workingRole, vehicleBase, loadedCount, revision, onApply, onStatus, onOpenFolder, recentVehicleFolders, onOpenRecentFolder, onClearRecentFolders }: {
  slots: VehicleSlots;
  workingRole: VehicleRole | null;
  vehicleBase: string;
  loadedCount: number;
  /** Bumped by the page on every edit, so layouts and values are re-read from the documents. */
  revision: number;
  onApply(writes: PerfWrite[], label: string): number;
  onStatus(message: string): void;
  onOpenFolder(): void;
  recentVehicleFolders: string[];
  onOpenRecentFolder(path: string): void;
  onClearRecentFolders(): void;
}) {
  const [mode, setMode] = useState<PerfMode>("base");
  const [sectionId, setSectionId] = useState(perfSections[0].id);
  const [viewRoleChoice, setViewRoleChoice] = useState<VehicleRole | null>(null);
  /** The import dialog: a donor that parsed, or the reason it didn't. */
  const [donor, setDonor] = useState<{ name: string; layout: PerformanceLayout | null; error: string } | null>(null);
  const [donorPicks, setDonorPicks] = useState({ base: true, mods: true, zone: true });
  const editorRef = useRef<HTMLDivElement>(null);

  const loadedRoles = roles.filter((role) => slots[role]);
  const viewRole = viewRoleChoice && slots[viewRoleChoice] ? viewRoleChoice : workingRole && slots[workingRole] ? workingRole : loadedRoles[0] ?? null;

  const layouts = useMemo<RoleLayout[]>(() => loadedRoles.map((role) => {
    const document = slots[role]!.document;
    if (document.format !== "pck") return { role, layout: null, error: "PSP PCKs are read as import donors only.", saved: document.savedBytes };
    try { return { role, layout: new PerformanceLayout(document.name, document.bytes), error: null, saved: document.savedBytes }; }
    catch (caught) { return { role, layout: null, error: caught instanceof Error ? caught.message : "Unreadable.", saved: document.savedBytes }; }
  }), [slots, revision]);
  const view = layouts.find((item) => item.role === viewRole) ?? null;
  const editable = layouts.filter((item) => item.layout);

  const section = perfSections.find((item) => item.id === sectionId) ?? perfSections[0];
  const sectionMode: PerfMode = section.scope === "global" ? "base" : mode;
  useEffect(() => { editorRef.current?.scrollTo({ top: 0 }); }, [sectionId]);

  /** Fields whose stored value differs between the loaded PCKs, across every section and mode. */
  const divergence = useMemo(() => {
    const found: { section: PerfSection; field: PerfField; mode: PerfMode }[] = [];
    if (editable.length < 2) return found;
    for (const item of perfSections) for (const itemMode of modesFor(item)) for (const field of item.fields) {
      const values = editable.map(({ layout }) => layout!.read(item, field, itemMode));
      if (values.some((value) => value !== null && !sameStored(field.type, value, values.find((other) => other !== null) ?? null))) found.push({ section: item, field, mode: itemMode });
    }
    return found;
  }, [editable]);
  const divergentKeys = useMemo(() => new Set(divergence.map((item) => `${item.mode}|${item.field.key}`)), [divergence]);

  /** Writes `value` into every loaded PCK that has this field, each at its own offset. */
  const writesFor = (target: PerfSection, field: PerfField, fieldMode: PerfMode, value: number) => editable.flatMap(({ role, layout }) => {
    const location = layout!.locate(target, field, fieldMode);
    if (!location || sameStored(field.type, layout!.read(target, field, fieldMode), value)) return [];
    return [{ role, offset: location.offset, bytes: encodeField(field.type, value) }];
  });

  const commitField = (field: PerfField, value: number) => {
    const problem = checkFieldValue(field, value);
    if (problem) return problem;
    const writes = writesFor(section, field, sectionMode, value);
    if (writes.length) onApply(writes, `${section.label} · ${field.label}`);
    return null;
  };

  const matchAllTo = () => {
    if (!view?.layout) return;
    const writes = divergence.flatMap(({ section: item, field, mode: itemMode }) => {
      const value = view.layout!.read(item, field, itemMode);
      return value === null ? [] : writesFor(item, field, itemMode, value);
    });
    const count = onApply(writes, `Match every PCK to ${roleLabels[view.role]}`);
    onStatus(`${count} field write${count === 1 ? "" : "s"} · every loaded PCK now matches ${roleLabels[view.role]}. Save to write them.`);
  };

  const pickDonor = async () => {
    try {
      const selection = await open({ multiple: false, filters: [{ name: "MC3 vehicle PCK / PSPPCK", extensions: ["pck", "psppck"] }] });
      if (!selection || Array.isArray(selection)) return;
      const name = selection.replace(/^.*[\\/]/, "");
      try {
        if (/\.mesh\.pck$/i.test(name)) throw new Error("That is a loose mesh piece, not a car PCK.");
        const layout = new PerformanceLayout(name, await readFile(selection));
        setDonor({ name, layout, error: "" });
        setDonorPicks({ base: true, mods: true, zone: true });
      } catch (caught) { setDonor({ name, layout: null, error: caught instanceof Error ? caught.message : "Could not read that PCK." }); }
    } catch (caught) { onStatus(caught instanceof Error ? caught.message : "Could not open the file dialog."); }
  };

  /** Per section and mode, how many of the donor's fields differ from what the vehicle holds now. */
  const donorPlan = useMemo(() => {
    const source = donor?.layout; const target = view?.layout;
    if (!source || !target) return [];
    // Mode-major, so the dialog reads as a Base block, a Mods block, then VehZone.
    const order = [...modes.flatMap((itemMode) => perfSections.filter((item) => item.scope === "mode").map((item) => ({ item, itemMode }))), ...perfSections.filter((item) => item.scope === "global").map((item) => ({ item, itemMode: "base" as PerfMode }))];
    return order.map(({ item, itemMode }) => {
      const changes = item.fields.flatMap((field) => {
        const current = target.read(item, field, itemMode);
        const incoming = source.read(item, field, itemMode);
        return current === null || incoming === null || sameStored(field.type, current, incoming) ? [] : [{ field, from: current, to: incoming }];
      });
      const missing = !source.sectionAvailable(item, itemMode) ? "donor" : !target.sectionAvailable(item, itemMode) ? "vehicle" : null;
      return { section: item, mode: itemMode, changes, missing };
    });
  }, [donor, view]);
  const zoneBlocked = !donor?.layout ? null : donor.layout.zoneOffset === null ? "The donor has no VehZone." : !view?.layout?.zoneOffset ? "This car has no VehZone to receive it." : null;
  const donorIncluded = (row: { section: PerfSection; mode: PerfMode }) => row.section.scope === "global" ? donorPicks.zone && !zoneBlocked : donorPicks[row.mode];
  const donorChangeCount = donorPlan.filter(donorIncluded).reduce((sum, row) => sum + row.changes.length, 0);

  const applyDonor = () => {
    if (!donor?.layout) return;
    const layout = donor.layout;
    const writes = donorPlan.filter(donorIncluded).flatMap((row) => row.section.fields.flatMap((field) => {
      const value = layout.read(row.section, field, row.mode);
      return value === null ? [] : writesFor(row.section, field, row.mode, value);
    }));
    onApply(writes, `Import performance from ${donor.name}`);
    const parts = [donorPicks.base && "Base", donorPicks.mods && "Mods", donorPicks.zone && !zoneBlocked && "VehZone"].filter(Boolean).join(" + ");
    const pcks = new Set(writes.map((write) => write.role)).size;
    onStatus(`Imported ${parts} from ${donor.name} · ${donorChangeCount} value${donorChangeCount === 1 ? "" : "s"} changed in ${pcks} PCK${pcks === 1 ? "" : "s"}. Save to write them.`);
    setDonor(null);
  };

  if (!loadedRoles.length) {
    return <main className="welcome perf-welcome">
      <div className="drop-card">
        <div className="file-glyph"><span>{tr("PERF")}</span></div>
        <p className="eyebrow">{tr("PERFORMANCE")}</p>
        <h1><Tx t="Open the vehicle folder.{0}Tune all three PCKs at once." v={[<br />]} /></h1>
        <p className="welcome-copy">{tr("Uses the same vehicle folder as the Meshes and Anchors tabs. Every value is written into the Player, Garage and Opponent PCKs together, each through its own pointers.")}</p>
        <div className="welcome-actions"><button className="primary" onClick={onOpenFolder}>{tr("Open vehicle folder")}</button></div>
        {recentVehicleFolders.length > 0 && <div className="recent-folders"><div className="recent-folders-heading"><span>{tr("Recent folders")}</span><button className="link-button" onClick={onClearRecentFolders}>{tr("Clear list")}</button></div><div className="recent-folders-list">{recentVehicleFolders.map((path) => <button key={path} className="recent-folder-item" title={path} onClick={() => onOpenRecentFolder(path)}>{path.replace(/^.*[\\/]/, "")}</button>)}</div></div>}
        <div className="capability-row"><span><Tx t="Edits {0}" v={[<b>{tr("Base · Mods · VehZone")}</b>]} /></span><span><Tx t="Writes {0}" v={[<b>{tr("Every loaded PCK")}</b>]} /></span><span><Tx t="Import {0}" v={[<b>{tr("From another car PCK")}</b>]} /></span></div>
      </div>
    </main>;
  }

  const sectionChanged = (item: PerfSection) => view?.layout ? modesFor(item).some((itemMode) => item.fields.some((field) => !sameStored(field.type, view.layout!.read(item, field, itemMode), view.layout!.read(item, field, itemMode, view.saved)))) : false;
  const sectionDivergent = (item: PerfSection) => divergence.some((entry) => entry.section === item);
  const available = view?.layout ? view.layout.sectionAvailable(section, sectionMode) : false;
  const drivetrainMismatch = view?.layout ? (() => {
    const vehsim = perfSections[0]; const field = vehsim.fields.find((item) => item.key === "vehsim.DriveTrainType")!;
    return !sameStored("s8", view.layout!.read(vehsim, field, "base"), view.layout!.read(vehsim, field, "mods"));
  })() : false;
  const unreadable = layouts.filter((item) => item.error);

  return <main className="perf-shell">
    <section className="vehicle-set-bar perf-bar">
      <div className="set-summary">
        <p className="eyebrow">{tr("VEHICLE SET")}</p>
        <strong>{vehicleBase}</strong>
        <span><Tx t="{0}/{1} PCK{2} edited together" v={[editable.length, loadedCount, loadedCount === 1 ? "" : "s"]} /></span>
        {unreadable.length > 0 && <span className="warn" title={unreadable.map((item) => `${roleLabels[item.role]}: ${item.error}`).join("\n")}><Tx t="{0} can't be edited" v={[unreadable.map((item) => roleLabels[item.role]).join(", ")]} /></span>}
      </div>
      <div className="perf-bar-group">
        <span className="perf-bar-label">{tr("Mode")}</span>
        <div className="mesh-role-tabs perf-mode-tabs">{modes.map((item) => <button key={item} className={item === mode ? "active" : ""} disabled={section.scope === "global"} onClick={() => setMode(item)} title={item === "base" ? tr("The car with no performance upgrades") : tr("The car with every performance upgrade")}>{tr(modeLabels[item])}<small>{item === "base" ? tr("stock") : tr("max upgrades")}</small></button>)}</div>
      </div>
      <div className="perf-bar-group">
        <span className="perf-bar-label">{tr("Values from")}</span>
        <div className="mesh-role-tabs">{loadedRoles.map((role) => {
          const document = slots[role]!.document;
          return <button key={role} className={role === viewRole ? "active" : ""} onClick={() => setViewRoleChoice(role)} title={`${roleLabels[role]} · ${sizeLabel(document.projectedSize)}${document.dirty ? " once saved" : ""}`}>
            {tr(roleLabels[role])}<small className={document.dirty ? "size-pending" : ""}>{sizeLabel(document.projectedSize)}{document.dirty ? " *" : ""}</small>
          </button>;
        })}</div>
      </div>
      <div className="perf-bar-actions">
        <button className="folder-button" disabled={!view?.layout} onClick={() => void pickDonor()} title={tr("Copy another car's performance into this one — Base, Mods and VehZone, previewed before anything changes.")}>{tr("Import from PCK…")}</button>
        <button className="folder-button" onClick={onOpenFolder}>{tr("Open folder…")}</button>
      </div>
    </section>

    <div className="perf-body">
      <nav className="perf-nav">
        {perfGroups.map((group) => <div className="perf-nav-group" key={group}>
          <p className="perf-nav-heading">{group}</p>
          {perfSections.filter((item) => item.group === group).map((item) => {
            const missing = view?.layout ? !modesFor(item).some((itemMode) => view.layout!.sectionAvailable(item, itemMode)) : true;
            return <button key={item.id} className={`perf-nav-item${item.id === section.id ? " active" : ""}${missing ? " missing" : ""}`} onClick={() => setSectionId(item.id)}>
              <span>{tr(item.label)}</span>
              <small>{missing ? "n/a" : `${item.fields.length}`}</small>
              {sectionDivergent(item) && <i className="perf-dot diverge" title={tr("The loaded PCKs disagree on some of these values")} />}
              {sectionChanged(item) && <i className="perf-dot changed" title={tr("Modified — not saved yet")} />}
            </button>;
          })}
        </div>)}
      </nav>

      <div className="editor-scroll perf-editor" ref={editorRef}>
        <header className="perf-section-head">
          <div>
            <p className="eyebrow">{section.group} · {section.scope === "global" ? tr("Shared by Base and Mods") : tr(`${modeLabels[mode]} mode`)}</p>
            <h2>{tr(section.label)}</h2>
            {section.note && <p>{tr(section.note)}</p>}
          </div>
          <span className="perf-section-meta"><Tx t="{0} fields · {1} values" v={[section.fields.length, roleLabels[viewRole!]]} /></span>
        </header>

        {divergence.length > 0 && <div className="sync-notice perf-notice">
          <strong>{tr("PCKs disagree")}</strong>
          <span><Tx t="{0} between the loaded PCKs — a car's three PCKs normally hold identical performance. Showing {1}." v={[divergence.length === 1 ? tr("1 value differs") : tr(`${divergence.length} values differ`), roleLabels[viewRole!]]} /></span>
          <button className="folder-button" onClick={matchAllTo}><Tx t="Match all to {0}" v={[roleLabels[viewRole!]]} /></button>
        </div>}
        {section.id === "vehsim" && drivetrainMismatch && <div className="sync-notice perf-notice warn">
          <strong>{tr("Drive Train Type")}</strong>
          <span>{tr("Base and Mods use different drive trains. They must match — set both modes to the same value.")}</span>
        </div>}

        {!view?.layout ? <div className="perf-empty">{view?.error ?? tr("No editable PCK is loaded.")}</div>
          : !available ? <div className="perf-empty">{section.id === "vehzone"
            ? tr("This car has no VehZone. Its +0x44 root points at a different, not yet identified structure, so there is nothing here to edit or import.")
            : tr(`${section.label} can't be reached in ${roleLabels[view.role]} — its pointer is missing or points outside the file.`)}</div>
            : <div className="perf-fields">
              {section.fields.map((field) => {
                const location = view.layout!.locate(section, field, sectionMode)!;
                const value = view.layout!.read(section, field, sectionMode);
                const saved = view.layout!.read(section, field, sectionMode, view.saved);
                const changed = !sameStored(field.type, value, saved);
                const diverges = divergentKeys.has(`${sectionMode}|${field.key}`);
                const perRole = diverges ? editable.map(({ role, layout }) => `${roleLabels[role]}: ${formatFieldValue(field.type, layout!.read(section, field, sectionMode))}`).join("\n") : "";
                return <div key={field.key} className={`perf-field${changed ? " changed" : ""}${diverges ? " diverge" : ""}`}>
                  <div className="perf-field-label">
                    <strong>{tr(field.label)}</strong>
                    <small>{hexOffset(field.offset)} · {field.type}{diverges && <em title={perRole}> {tr("· differs")}</em>}</small>
                  </div>
                  <FieldInput field={field} value={value} onCommit={(next) => commitField(field, next)} />
                  <div className="perf-field-state">
                    {changed && <>
                      <small title={tr("Value on disk")}><Tx t="was {0}" v={[formatFieldValue(field.type, saved)]} /></small>
                      <button type="button" title={tr("Put back the value on disk")} onClick={() => saved !== null && commitField(field, saved)}>↺</button>
                    </>}
                  </div>
                </div>;
              })}
            </div>}
      </div>
    </div>

    {donor && <div className="modal-backdrop" onMouseDown={() => setDonor(null)}>
      <div className="modal perf-import" onMouseDown={(event) => event.stopPropagation()}>
        <button className="modal-close" onClick={() => setDonor(null)}>×</button>
        <p className="eyebrow">{tr("IMPORT PERFORMANCE")}</p>
        <h2>{donor.name}</h2>
        {!donor.layout ? <p className="perf-import-error">{donor.error}</p> : <>
          <p><Tx t="Copies the donor's values into every loaded PCK of {0}, each at its own address. Headers, pointers and names stay the receiver's. Nothing is written to disk until you save." v={[<strong>{vehicleBase}</strong>]} /></p>
          <div className="perf-import-picks">
            {(["base", "mods", "zone"] as const).map((key) => {
              const blocked = key === "zone" ? zoneBlocked : null;
              const count = donorPlan.filter((row) => key === "zone" ? row.section.scope === "global" : row.section.scope === "mode" && row.mode === key).reduce((sum, row) => sum + row.changes.length, 0);
              return <label key={key} className={blocked ? "disabled" : ""} title={blocked ?? undefined}>
                <input type="checkbox" disabled={Boolean(blocked)} checked={donorPicks[key] && !blocked} onChange={(event) => setDonorPicks((current) => ({ ...current, [key]: event.target.checked }))} />
                <span><strong>{key === "base" ? tr("Base") : key === "mods" ? tr("Mods") : tr("VehZone")}</strong><small>{blocked ?? tr(`${count} value${count === 1 ? "" : "s"} differ`)}</small></span>
              </label>;
            })}
          </div>
          <div className="perf-import-table">
            {donorPlan.filter((row) => donorIncluded(row) && (row.changes.length || row.missing)).map((row) => <details key={`${row.mode}|${row.section.id}`}>
              <summary>
                <span>{row.section.label}</span>
                <small>{row.section.scope === "global" ? tr("Global") : modeLabels[row.mode]}</small>
                <em className={row.missing ? "warn" : ""}>{row.missing ? tr(`missing in the ${row.missing}`) : tr(`${row.changes.length} change${row.changes.length === 1 ? "" : "s"}`)}</em>
              </summary>
              {row.changes.map(({ field, from, to }) => <div className="perf-import-change" key={field.key}>
                <span>{tr(field.label)}</span>
                <code>{formatFieldValue(field.type, from)}</code>
                <i>→</i>
                <code className="to">{formatFieldValue(field.type, to)}</code>
              </div>)}
            </details>)}
            {donorChangeCount === 0 && <p className="perf-import-none">{tr("The selected parts already match the donor.")}</p>}
          </div>
          <div className="perf-import-actions">
            <button className="secondary" onClick={() => setDonor(null)}>{tr("Cancel")}</button>
            <button className="primary" disabled={!donorChangeCount} onClick={applyDonor}><Tx t="Import {0} value{1}" v={[donorChangeCount, donorChangeCount === 1 ? "" : "s"]} /></button>
          </div>
        </>}
      </div>
    </div>}
  </main>;
}
