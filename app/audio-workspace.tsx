import { tr, Tx } from "./i18n";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { exists, readFile, writeFile } from "@tauri-apps/plugin-fs";
import {
  AUDIO_BLOCK_MAGICS, auxEditLimit, blockRole, compareToPlayer, CURVE_FIELDS, encodeFixedString, hex, importConservative, importExperimental, audioNameLength, isProbableFixedAudioString, locateOffset, parseAudio, readFixedString, resolveLocation,
  type AudioBlock, type AudioDocument, type AudioItem, type CommonBlock, type FloatEntry, type ImportReport, type RawAuxBlock, type SyncState,
} from "../src/audio";
import type { PerfWrite } from "./performance-workspace";
import { fmt, NumberField, TextField } from "./audio-fields";
import { CurveEditor, type Playhead } from "./audio-curve-editor";
import { ListenPanel, type BankState, type PerfState } from "./audio-listen";
import { bankDirs, forgetBanks, loadBank, loadBanksFolder, saveBanksFolder } from "./audio-banks";
import { playPcm, stopPlayback } from "./audio-player";
import { parseVehiclePerf, renderToWav, type Render } from "../src/audio-preview";
import { roleLabels, roles, sizeLabel, type VehicleRole, type VehicleSlots } from "./vehicle-types";

/**
 * Audio — the car's `audio_root`: Engine, Exhaust and TurboBlower levels, auxiliary effects and
 * Common levels, with the donor imports of the Audio Curve GUI script (`src/audio.ts`).
 *
 * A car's PCKs don't necessarily share their audio: a stock Opponent has its own generic sound
 * (E_Op_*), a stock Garage holds a subset identical to the Player's, and a mod often copies the
 * Player PCK over all three. Each role is compared with the Player when the set opens; roles that
 * match are kept in sync automatically, the others are edited on their own, and the user can
 * override either way.
 */

type RoleAudio = { role: VehicleRole; buf: Uint8Array; saved: Uint8Array; doc: AudioDocument | null; error: string };
type Selection = { type: AudioItem["type"]; rootRel: number };
type ImportMode = "conservative" | "experimental";
type PlannedImport = { role: VehicleRole; source: string; report: ImportReport; writes: PerfWrite[] };

const syncLabels: Record<SyncState, string> = { same: "identical to Player", subset: "subset of Player", own: "own audio" };
const modeCopy: Record<ImportMode, { title: string; body: string }> = {
  conservative: {
    title: "Conservative",
    body: "Bank name with the sample prefix before ':', auxiliary name strings, the Engine/Exhaust RPMs of the active ranges, and the Upshift/Downshift event curves. Engine/Exhaust blocks are paired by their ENGINE/TAIL samples, not blindly by slot. Volume/Pitch/High Pitch curves, distances, warble, boost, range counts and pointers are left alone.",
  },
  experimental: {
    title: "Experimental",
    body: "Everything addressable without moving data: exact bank and sample names, RPMs, distances, active range count, warble, boost, all range rows, curve headers and rows (High Pitch only when both cars use it), auxiliary strings and floats, and Common parameters. Pointers and whole blocks are never copied. Riskier at runtime.",
  },
};
const f32Bytes = (value: number) => { const out = new Uint8Array(4); new DataView(out.buffer).setFloat32(0, value, true); return out; };
const itemSpans = (doc: AudioDocument, bufLength: number, item: AudioItem): [number, number][] => {
  if (item.type === "common") return [[item.fileOff, item.fileOff + 0x60]];
  // Up to the next known structure: the preview window can reach into a neighbour's bytes.
  if (item.type === "raw") return [[item.fileOff, Math.min(item.fileOff + (item.kind === "raw_bundle" ? 0x200 : 0x100), auxEditLimit(doc, item, bufLength))]];
  const spans: [number, number][] = [[item.fileOff, item.fileOff + 0xa0]];
  for (const range of item.ranges) spans.push([range.fileOff, range.fileOff + 0x2c]);
  for (const field of CURVE_FIELDS) { const c = item.curves[field.key]; if (c?.fileOff != null) spans.push([c.fileOff, c.fileOff + 0x140]); }
  return spans;
};
/** Contiguous runs of changed bytes between two same-length buffers, as field writes. */
function diffWrites(role: VehicleRole, before: Uint8Array, after: Uint8Array): PerfWrite[] {
  const writes: PerfWrite[] = [];
  for (let i = 0; i < before.length; i += 1) {
    if (before[i] === after[i]) continue;
    let j = i; while (j < before.length && before[j] !== after[j]) j += 1;
    writes.push({ role, offset: i, bytes: after.slice(i, j) });
    i = j;
  }
  return writes;
}

export function AudioWorkspace({ slots, workingRole, vehicleBase, loadedCount, revision, onApply, onStatus, onOpenFolder, recentVehicleFolders, onOpenRecentFolder, onClearRecentFolders }: {
  slots: VehicleSlots;
  workingRole: VehicleRole | null;
  vehicleBase: string;
  loadedCount: number;
  revision: number;
  onApply(writes: PerfWrite[], label: string): number;
  onStatus(message: string): void;
  onOpenFolder(): void;
  recentVehicleFolders: string[];
  onOpenRecentFolder(path: string): void;
  onClearRecentFolders(): void;
}) {
  const loadedRoles = roles.filter((role) => slots[role]);
  const audio = useMemo<RoleAudio[]>(() => loadedRoles.map((role) => {
    const document = slots[role]!.document;
    try { return { role, buf: document.bytes, saved: document.savedBytes, doc: parseAudio(document.bytes), error: "" }; }
    catch (caught) { return { role, buf: document.bytes, saved: document.savedBytes, doc: null, error: caught instanceof Error ? caught.message : "No readable audio." }; }
  }), [slots, revision]);
  const byRole = (role: VehicleRole) => audio.find((item) => item.role === role) ?? null;
  const primary: VehicleRole | null = byRole("player")?.doc ? "player" : audio.find((item) => item.doc)?.role ?? null;

  // How each role compared with the Player when this set was opened — measured on the bytes on disk,
  // so pending edits don't change the verdict — and whether it is kept in sync, which starts from
  // that verdict and is then the user's call.
  const setKey = `${vehicleBase}|${loadedRoles.join(",")}`;
  const [detected, setDetected] = useState<{ key: string; states: Partial<Record<VehicleRole, SyncState | "none">> }>({ key: "", states: {} });
  const [syncChoice, setSyncChoice] = useState<Partial<Record<VehicleRole, boolean>>>({});
  useEffect(() => {
    if (detected.key === setKey || !primary) return;
    const master = byRole(primary)!;
    let masterSaved: AudioDocument | null = null;
    try { masterSaved = parseAudio(master.saved); } catch { masterSaved = null; }
    const states: Partial<Record<VehicleRole, SyncState | "none">> = {};
    const choice: Partial<Record<VehicleRole, boolean>> = {};
    for (const item of audio) {
      if (item.role === primary) continue;
      let state: SyncState | "none" = "none";
      try { state = masterSaved ? compareToPlayer({ buf: master.saved, doc: masterSaved }, { buf: item.saved, doc: parseAudio(item.saved) }) : "none"; } catch { state = "none"; }
      states[item.role] = state; choice[item.role] = state === "same" || state === "subset";
    }
    setDetected({ key: setKey, states }); setSyncChoice(choice);
  }, [setKey, primary]);

  const [viewChoice, setViewChoice] = useState<VehicleRole | null>(null);
  const viewRole = viewChoice && byRole(viewChoice)?.doc ? viewChoice : primary;
  const view = viewRole ? byRole(viewRole) : null;
  const synced = (role: VehicleRole) => role === primary || Boolean(syncChoice[role]);
  /** The roles an edit made while viewing `role` reaches. */
  const groupOf = (role: VehicleRole) => synced(role) ? audio.filter((item) => item.doc && synced(item.role)).map((item) => item.role) : [role];

  const [selection, setSelection] = useState<Selection | null>(null);
  const items: AudioItem[] = view?.doc ? [...view.doc.blocks, ...view.doc.rawAux, ...view.doc.commons] : [];
  const selected = items.find((item) => selection && item.type === selection.type && item.rootRel === selection.rootRel) ?? items[0] ?? null;
  const editorRef = useRef<HTMLDivElement>(null);
  useEffect(() => { editorRef.current?.scrollTo({ top: 0 }); }, [selected?.type, selected?.rootRel]);

  /** Carries writes made at `view`'s offsets to every role in its group, each at its own offset. */
  const propagate = (writes: { offset: number; bytes: Uint8Array }[]): PerfWrite[] => {
    if (!view?.doc || !viewRole) return [];
    const out: PerfWrite[] = [];
    for (const role of groupOf(viewRole)) {
      const target = byRole(role); if (!target?.doc) continue;
      for (const write of writes) {
        if (role === viewRole) { out.push({ role, offset: write.offset, bytes: write.bytes }); continue; }
        const location = locateOffset(view.doc, write.offset);
        const offset = location ? resolveLocation(target.doc, location) : null;
        if (offset !== null) out.push({ role, offset, bytes: write.bytes });
      }
    }
    return out;
  };
  const apply = (writes: { offset: number; bytes: Uint8Array }[], label: string) => {
    const all = propagate(writes);
    const count = onApply(all, label);
    const reached = new Set(all.map((write) => write.role)).size;
    if (count && reached > 1) onStatus(`${label} · written to ${reached} PCKs`);
  };
  // The auxiliary float candidates are listed from the bytes on disk, so a value typed as 0 — which
  // the scan skips as padding — doesn't make its row vanish while it's being edited.
  const savedDocs = useMemo(() => new Map(audio.map((item) => { try { return [item.role, parseAudio(item.saved)] as const; } catch { return [item.role, null] as const; } })), [audio]);

  // --- Listen: bank resolution, performance for the gear run, playback -----------------------------
  const [banksFolder, setBanksFolder] = useState(loadBanksFolder);
  const [bankVersion, setBankVersion] = useState(0);
  const pckPath = viewRole ? slots[viewRole]?.path ?? null : null;
  const searched = useMemo(() => bankDirs(banksFolder, pckPath), [banksFolder, pckPath]);
  const listenBlock = selected?.type === "block" ? selected : null;
  const bankKey = listenBlock ? `${listenBlock.bankName}|${searched.join("|")}|${bankVersion}` : "";
  const [bankState, setBankState] = useState<{ key: string; state: BankState }>({ key: "", state: { status: "loading" } });
  useEffect(() => {
    if (!listenBlock) return;
    if (!listenBlock.bankName) { setBankState({ key: bankKey, state: { status: "missing", message: "This level has no bank." } }); return; }
    let cancelled = false;
    void loadBank(listenBlock.bankName, searched).then((result) => { if (!cancelled) setBankState({ key: bankKey, state: "error" in result ? { status: "missing", message: result.error } : { status: "ready", loaded: result } }); });
    return () => { cancelled = true; };
  }, [bankKey]);
  const bankShown: BankState = bankState.key === bankKey ? bankState.state : { status: "loading" };
  const perfState = useMemo<PerfState | null>(() => {
    if (!view) return null;
    const read = (variant: "base" | "mods") => { try { return parseVehiclePerf(view.buf, variant); } catch (caught) { return caught instanceof Error ? caught.message : "No performance data in this PCK."; } };
    return { base: read("base"), mods: read("mods") };
  }, [view?.buf, revision]);

  const [playback, setPlayback] = useState<(Playhead & { label: string; rootRel: number | null; role: VehicleRole | null }) | null>(null);
  useEffect(() => () => stopPlayback(), []);
  const playRender = (render: Render) => {
    const startedAt = playPcm(render.pcm, render.rate, () => setPlayback(null));
    setPlayback({ label: render.label, rootRel: listenBlock?.rootRel ?? null, role: viewRole, startedAt, duration: render.duration, rpmAt: render.rpmAt, minRpm: listenBlock?.minRpmRec ?? 0, maxRpm: listenBlock?.maxRpmRec ?? 0 });
    onStatus(`Playing ${render.label}${listenBlock ? ` · ${listenBlock.label}` : ""}`);
  };
  const playSample = (name: string) => {
    if (bankShown.status !== "ready") return;
    const { bank, bnk } = bankShown.loaded;
    const entry = bank.get(name);
    if (!entry?.pcm) { onStatus(`Sample ${name} wasn't found in ${bnk.replace(/^.*[\\/]/, "")}.${bank.hasNameMapping ? "" : " Its .td name map wasn't found."}`); return; }
    const startedAt = playPcm(entry.pcm, entry.rate, () => setPlayback(null));
    setPlayback({ label: name, rootRel: null, role: viewRole, startedAt, duration: entry.pcm.length / entry.rate, rpmAt: null, minRpm: 0, maxRpm: 0 });
    onStatus(`Playing sample ${name} · ${entry.rate} Hz${entry.loop ? " · loops in game" : ""}`);
  };
  const stop = () => { stopPlayback(); setPlayback(null); onStatus("Playback stopped"); };
  const exportRender = async (render: Render) => {
    try {
      const safe = (text: string) => text.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
      const path = await save({ defaultPath: `${safe(vehicleBase)}_${safe(listenBlock?.label ?? "audio")}_${safe(render.label)}.wav`, filters: [{ name: "WAV audio", extensions: ["wav"] }] });
      if (!path) return;
      await writeFile(path, renderToWav(render));
      onStatus(`Saved ${render.label} to ${path}`);
    } catch (caught) { onStatus(caught instanceof Error ? caught.message : "The WAV could not be saved."); }
  };
  const chooseBanksFolder = async () => {
    try {
      const folder = await open({ directory: true, multiple: false, defaultPath: banksFolder || undefined, title: "Folder with MC3 .bnk and .td files" });
      if (!folder || Array.isArray(folder)) return;
      saveBanksFolder(folder); forgetBanks(); setBanksFolder(folder); setBankVersion((v) => v + 1);
    } catch (caught) { onStatus(caught instanceof Error ? caught.message : "Could not open the folder dialog."); }
  };
  const clearBanksFolder = () => { saveBanksFolder(""); forgetBanks(); setBanksFolder(""); setBankVersion((v) => v + 1); };

  const editBank = (block: AudioBlock, next: string) => {
    const bank = next.trim();
    if (!/^[\x20-\x7e]*$/.test(bank)) return "ASCII only.";
    if (bank.length > 31) return "31 characters at most.";
    const writes = [{ offset: block.fileOff + 4, bytes: encodeFixedString(bank) }];
    // The script's rule: a bank edit keeps every range's suffix and replaces the prefix before ':'.
    if (bank) for (const range of block.ranges) {
      const old = readFixedString(view!.buf, range.fileOff, 0x20);
      const colon = old.indexOf(":");
      if (colon < 0 || colon === old.length - 1) continue;
      const sample = `${bank}:${old.slice(colon + 1)}`;
      if (sample === old) continue;
      if (sample.length > 31) return `${sample} would not fit in a 31-character sample name.`;
      writes.push({ offset: range.fileOff, bytes: encodeFixedString(sample) });
    }
    apply(writes, `${block.label} · bank ${bank || "<empty>"}`);
    return null;
  };
  const editF32 = (offset: number, value: number, label: string) => { apply([{ offset, bytes: f32Bytes(value) }], label); return null; };
  const editRawString = (raw: RawAuxBlock, rel: number, next: string) => {
    const text = next.trim();
    if (!/^[\x20-\x7e]*$/.test(text)) return "ASCII only.";
    if (text.length > 31) return "31 characters at most.";
    apply([{ offset: raw.fileOff + rel, bytes: encodeFixedString(text) }], `${raw.label} · string at +0x${rel.toString(16).toUpperCase()}`);
    return null;
  };

  // --- Donor import -----------------------------------------------------------------------------
  const [donor, setDonor] = useState<{ path: string; name: string; buf: Uint8Array; doc: AudioDocument; opponentPath: string | null } | { error: string; name: string } | null>(null);
  const [mode, setMode] = useState<ImportMode>("conservative");
  const [withOpponent, setWithOpponent] = useState(false);
  const pickDonor = async () => {
    try {
      const selection = await open({ multiple: false, filters: [{ name: "MC3 vehicle PCK", extensions: ["pck"] }] });
      if (!selection || Array.isArray(selection)) return;
      const name = selection.replace(/^.*[\\/]/, "");
      try {
        const buf = await readFile(selection);
        const doc = parseAudio(buf);
        const opponentPath = /_o\.pck$/i.test(name) ? null : selection.replace(/(_g)?\.pck$/i, "_o.pck");
        setDonor({ path: selection, name, buf, doc, opponentPath: opponentPath && await exists(opponentPath) ? opponentPath : null });
        setWithOpponent(false);
      } catch (caught) { setDonor({ name, error: caught instanceof Error ? caught.message : "Could not read that PCK's audio." }); }
    } catch (caught) { onStatus(caught instanceof Error ? caught.message : "Could not open the file dialog."); }
  };
  const importTargets = viewRole ? groupOf(viewRole) : [];
  const opponentAvailable = Boolean(donor && "doc" in donor && donor.opponentPath && byRole("opponent")?.doc && !importTargets.includes("opponent"));
  const [opponentDonor, setOpponentDonor] = useState<{ buf: Uint8Array; doc: AudioDocument; name: string } | null>(null);
  useEffect(() => {
    setOpponentDonor(null);
    if (!withOpponent || !donor || !("doc" in donor) || !donor.opponentPath) return;
    let cancelled = false;
    void readFile(donor.opponentPath).then((buf) => { if (!cancelled) setOpponentDonor({ buf, doc: parseAudio(buf), name: donor.opponentPath!.replace(/^.*[\\/]/, "") }); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [donor, withOpponent]);
  const plan = useMemo<PlannedImport[]>(() => {
    if (!donor || !("doc" in donor)) return [];
    const run = mode === "conservative" ? importConservative : importExperimental;
    const jobs: { role: VehicleRole; buf: Uint8Array; doc: AudioDocument; source: string }[] = [];
    for (const role of importTargets) jobs.push({ role, buf: donor.buf, doc: donor.doc, source: donor.name });
    if (withOpponent && opponentAvailable && opponentDonor) jobs.push({ role: "opponent", buf: opponentDonor.buf, doc: opponentDonor.doc, source: opponentDonor.name });
    return jobs.flatMap(({ role, buf, doc, source }) => {
      const target = byRole(role); if (!target?.doc) return [];
      const copy = target.buf.slice();
      const report = run(copy, target.doc, buf, doc);
      return [{ role, source, report, writes: diffWrites(role, target.buf, copy) }];
    });
  }, [donor, mode, withOpponent, opponentDonor, audio, syncChoice, viewRole]);
  const applyImport = () => {
    if (!donor || !("doc" in donor)) return;
    const writes = plan.flatMap((item) => item.writes);
    onApply(writes, `Import audio (${modeCopy[mode].title}) from ${donor.name}`);
    onStatus(`Imported ${modeCopy[mode].title.toLowerCase()} audio from ${donor.name} into ${plan.filter((item) => item.writes.length).map((item) => roleLabels[item.role]).join(", ") || "nothing — already identical"}. Save to write it.`);
    setDonor(null);
  };

  if (!loadedRoles.length) {
    return <main className="welcome perf-welcome">
      <div className="drop-card">
        <div className="file-glyph"><span>{tr("AUD")}</span></div>
        <p className="eyebrow">{tr("AUDIO")}</p>
        <h1><Tx t="Open the vehicle folder.{0}Hear it with another car's engine." v={[<br />]} /></h1>
        <p className="welcome-copy">{tr("Uses the same vehicle folder as the other editors. Engine, Exhaust and TurboBlower levels, auxiliary effects and Common levels, with the donor imports of the Audio Curve GUI. Roles that share the Player's audio are kept in sync; a stock Opponent's own sound is left alone.")}</p>
        <div className="welcome-actions"><button className="primary" onClick={onOpenFolder}>{tr("Open vehicle folder")}</button></div>
        {recentVehicleFolders.length > 0 && <div className="recent-folders"><div className="recent-folders-heading"><span>{tr("Recent folders")}</span><button className="link-button" onClick={onClearRecentFolders}>{tr("Clear list")}</button></div><div className="recent-folders-list">{recentVehicleFolders.map((path) => <button key={path} className="recent-folder-item" title={path} onClick={() => onOpenRecentFolder(path)}>{path.replace(/^.*[\\/]/, "")}</button>)}</div></div>}
        <div className="capability-row"><span><Tx t="Edits {0}" v={[<b>{tr("Banks · RPMs · curves")}</b>]} /></span><span><Tx t="Listens {0}" v={[<b>{tr("Samples · RPM mix · gears")}</b>]} /></span><span><Tx t="Import {0}" v={[<b>{tr("Conservative · Experimental")}</b>]} /></span></div>
      </div>
    </main>;
  }

  const changed = (role: RoleAudio, item: AudioItem) => role.doc !== null && itemSpans(role.doc, role.buf.length, item).some(([start, end]) => { for (let i = start; i < end && i < role.buf.length; i += 1) if (role.buf[i] !== role.saved[i]) return true; return false; });
  const groups: { title: string; items: AudioItem[] }[] = view?.doc ? [
    { title: "Engine", items: view.doc.blocks.filter((b) => b.category === "Engine") },
    { title: "Exhaust", items: view.doc.blocks.filter((b) => b.category === "Exhaust") },
    { title: "TurboBlower", items: view.doc.blocks.filter((b) => b.category === "TurboBlower") },
    { title: "Auxiliary", items: view.doc.rawAux },
    { title: "Common", items: view.doc.commons },
  ].filter((group) => group.items.length) : [];
  const reachLabel = viewRole ? groupOf(viewRole).map((role) => roleLabels[role]).join(" + ") : "";

  return <main className="perf-shell">
    <section className="vehicle-set-bar perf-bar">
      <div className="set-summary">
        <p className="eyebrow">{tr("VEHICLE SET")}</p>
        <strong>{vehicleBase}</strong>
        <span><Tx t="{0} PCK{1} · edits reach {2}" v={[loadedCount, loadedCount === 1 ? "" : "s", reachLabel || "—"]} /></span>
      </div>
      <div className="perf-bar-group">
        <span className="perf-bar-label">{tr("Viewing")}</span>
        <div className="mesh-role-tabs">{audio.map((item) => {
          const state = item.role === primary ? null : detected.states[item.role];
          const document = slots[item.role]!.document;
          return <button key={item.role} className={item.role === viewRole ? "active" : ""} disabled={!item.doc} onClick={() => setViewChoice(item.role)} title={item.error || `${roleLabels[item.role]} · ${sizeLabel(document.projectedSize)}${document.dirty ? " once saved" : ""}`}>
            {tr(roleLabels[item.role])}<small className={document.dirty ? "size-pending" : ""}>{!item.doc ? tr("no audio") : item.role === primary ? tr("master") : synced(item.role) ? tr("synced") : tr("separate")}{document.dirty ? " *" : ""}</small>
            {state === "own" && <i className="au-own-dot" />}
          </button>;
        })}</div>
      </div>
      <div className="au-sync-list">
        {audio.filter((item) => item.role !== primary && item.doc).map((item) => {
          const state = detected.states[item.role];
          return <label key={item.role} className="au-sync" title={state === "own" ? tr("This PCK's audio differs from the Player's — a stock Opponent's generic sound, for instance. Ticking this makes edits and imports reach it too.") : tr("Detected as sharing the Player's audio, so edits and imports reach it too.")}>
            <input type="checkbox" checked={Boolean(syncChoice[item.role])} onChange={(event) => setSyncChoice((current) => ({ ...current, [item.role]: event.target.checked }))} />
            <span><strong>{tr(roleLabels[item.role])}</strong><small className={state === "own" ? "own" : ""}>{state && state !== "none" ? syncLabels[state] : tr("not compared")}</small></span>
          </label>;
        })}
      </div>
      <div className="perf-bar-actions">
        <button className="folder-button" disabled={!view?.doc} onClick={() => void pickDonor()} title={tr("Copy another car's audio into this one, previewed before anything changes.")}>{tr("Import from PCK…")}</button>
        <button className="folder-button" onClick={onOpenFolder}>{tr("Open folder…")}</button>
      </div>
    </section>

    <div className="perf-body">
      <nav className="perf-nav">
        {!view?.doc && <p className="perf-nav-heading">{view?.error || tr("No readable audio")}</p>}
        {groups.map((group) => <div className="perf-nav-group" key={tr(group.title)}>
          <p className="perf-nav-heading">{tr(group.title)}</p>
          {group.items.map((item) => <button key={`${item.type}-${item.rootRel}`} className={`perf-nav-item au-nav-item${item === selected ? " active" : ""}`} onClick={() => setSelection({ type: item.type, rootRel: item.rootRel })}>
            <span>{item.label.replace(/^(Engine|Exhaust|TurboBlower|Common) /, "")}<em>{item.type === "block" ? item.bankName || "—" : item.type === "raw" ? item.possibleName0 || item.foundStrings[0] || hex(item.magic) : ""}</em></span>
            {view && changed(view, item) && <i className="perf-dot changed" title={tr("Modified — not saved yet")} />}
          </button>)}
        </div>)}
      </nav>

      <div className="editor-scroll perf-editor" ref={editorRef}>
        {view?.doc && <div className="au-root-line"><Tx t="audio_root {0} · {1} · {2}" v={[hex(view.doc.rootOff), view.doc.rootName || tr("unnamed"), view.doc.warnings.length ? view.doc.warnings.join(" · ") : tr("no warnings")]} /></div>}
        {!selected || !view ? <div className="perf-empty">{view?.error || tr("Nothing to show.")}</div>
          : selected.type === "block" ? <BlockEditor block={selected} buf={view.buf} onBank={(value) => editBank(selected, value)} onF32={editF32}
            onPlaySample={bankShown.status === "ready" ? playSample : null}
            listen={perfState && <ListenPanel block={selected} bank={bankShown} perf={perfState} banksFolder={banksFolder} searched={searched} playing={playback?.label ?? null}
              onPlayRender={playRender} onPlaySample={playSample} onStop={stop} onExport={(render) => void exportRender(render)}
              onChooseFolder={() => void chooseBanksFolder()} onClearFolder={clearBanksFolder} onStatus={onStatus} />}
            curves={<CurveEditor block={selected} buf={view.buf} saved={view.saved} sourceName={slots[view.role]!.path.replace(/^.*[\\/]/, "")} onWrite={apply} onStatus={onStatus}
              playhead={playback?.rpmAt && playback.rootRel === selected.rootRel && playback.role === view.role ? playback : null} />} />
            : selected.type === "raw" ? <RawEditor raw={selected} buf={view.buf} saved={view.saved} limit={auxEditLimit(view.doc!, selected, view.buf.length)}
              candidates={savedDocs.get(view.role)?.rawAux.find((r) => r.rootRel === selected.rootRel)?.floatPreview ?? selected.floatPreview}
              onString={(rel, value) => editRawString(selected, rel, value)} onF32={editF32} />
              : <CommonView common={selected} />}
      </div>
    </div>

    {donor && <div className="modal-backdrop" onMouseDown={() => setDonor(null)}>
      <div className="modal perf-import" onMouseDown={(event) => event.stopPropagation()}>
        <button className="modal-close" onClick={() => setDonor(null)}>×</button>
        <p className="eyebrow">{tr("IMPORT AUDIO")}</p>
        <h2>{donor.name}</h2>
        {"error" in donor ? <p className="perf-import-error">{donor.error}</p> : <>
          <p><Tx t="Copies the donor's audio into {0} of {1}, each PCK through its own pointers. Nothing is written to disk until you save." v={[<strong>{importTargets.map((role) => roleLabels[role]).join(" + ")}</strong>, <strong>{vehicleBase}</strong>]} /></p>
          <div className="au-modes">
            {(["conservative", "experimental"] as ImportMode[]).map((key) => <label key={key} className={mode === key ? "active" : ""}>
              <input type="radio" name="au-mode" checked={mode === key} onChange={() => setMode(key)} />
              <span><strong>{modeCopy[key].title}{key === "conservative" ? tr(" · recommended") : ""}</strong><small>{modeCopy[key].body}</small></span>
            </label>)}
          </div>
          {opponentAvailable && <label className="au-opponent-option">
            <input type="checkbox" checked={withOpponent} onChange={(event) => setWithOpponent(event.target.checked)} />
            <span><strong>{tr("Also import the donor's opponent audio into Opponent")}</strong><small><Tx t="{0} — the Opponent here has its own sound and isn't synced, so it only changes if you tick this." v={[donor.opponentPath?.replace(/^.*[\\/]/, "")]} /></small></span>
          </label>}
          <div className="perf-import-table">
            {plan.map((item) => {
              const changedCount = Object.entries(item.report.counts).filter(([key]) => /changed$/.test(key)).reduce((sum, [, value]) => sum + value, 0);
              return <details key={item.role} open={plan.length === 1}>
                <summary><span>{tr(roleLabels[item.role])}</span><small><Tx t="from {0}" v={[item.source]} /></small><em className={item.report.warnings.length ? "warn" : ""}><Tx t="{0} field{1}{2}" v={[changedCount, changedCount === 1 ? "" : "s", item.report.warnings.length ? tr(` · ${item.report.warnings.length} warning${item.report.warnings.length === 1 ? "" : "s"}`) : ""]} /></em></summary>
                <div className="au-report">
                  {Object.entries(item.report.counts).filter(([, value]) => value).map(([key, value]) => <span key={key}><b>{value}</b> {key.replace(/_/g, " ")}</span>)}
                </div>
                {item.report.warnings.length > 0 && <ul className="au-warnings">{item.report.warnings.slice(0, 12).map((warning, i) => <li key={i}>{tr(warning)}</li>)}{item.report.warnings.length > 12 && <li><Tx t="… {0} more" v={[item.report.warnings.length - 12]} /></li>}</ul>}
              </details>;
            })}
          </div>
          <div className="perf-import-actions">
            <button className="secondary" onClick={() => setDonor(null)}>{tr("Cancel")}</button>
            <button className="primary" disabled={!plan.some((item) => item.writes.length)} onClick={applyImport}><Tx t="Import {0}" v={[modeCopy[mode].title.toLowerCase()]} /></button>
          </div>
        </>}
      </div>
    </div>}
  </main>;
}

function BlockEditor({ block, buf, onBank, onF32, curves, listen, onPlaySample }: {
  block: AudioBlock; buf: Uint8Array; onBank(value: string): string | null; onF32(offset: number, value: number, label: string): string | null;
  curves: ReactNode; listen: ReactNode; onPlaySample: ((name: string) => void) | null;
}) {
  void buf;
  const info: [string, string][] = [
    ["Sample role", blockRole(block)], ["Magic", `${hex(block.magic)} · ${AUDIO_BLOCK_MAGICS[block.magic] ?? "unknown"}`],
    ["Near / Far distance", `${fmt(block.nearDist)} / ${fmt(block.farDist)}`], ["Active ranges", `${block.activeRangeCount} of ${block.ranges.length}`],
    ["Warble RPM min / max", `${fmt(block.warble[0])} / ${fmt(block.warble[1])}`], ["Warble min RPM / vol delta", `${fmt(block.warble[2])} / ${fmt(block.warble[3])}`],
    ["Warble max RPM / vol delta", `${fmt(block.warble[4])} / ${fmt(block.warble[5])}`], ["Warble reverse delta / rate", `${fmt(block.warble[6])} / ${fmt(block.warble[7])}`],
    ["Boost mix percent / rate", `${fmt(block.boostMixPercent)} / ${fmt(block.boostMixRate)}`], ["High Pitch engage gear", String(block.highPitchCurveEngageGear)],
    ["EngineRevSound", block.engineRevSound || "—"],
  ];
  return <>
    <header className="perf-section-head">
      <div>
        <p className="eyebrow"><Tx t="{0} · AudioBlockFull · root+0x{1}" v={[block.category, block.rootRel.toString(16).toUpperCase()]} /></p>
        <h2>{tr(block.label)}</h2>
      </div>
      <div className="au-head-side">
        <p>{tr("Editing the bank also rewrites the prefix of every sample name, keeping its suffix — E_OLD:LOW_ENGINE becomes E_NEW:LOW_ENGINE — so the two never point at different banks.")}</p>
        <span className="perf-section-meta">{hex(block.fileOff)}</span>
      </div>
    </header>
    <div className="perf-fields">
      <div className="perf-field au-wide"><div className="perf-field-label"><strong>{tr("Bank name")}</strong><small>{tr("+0x04 · char[32]")}</small></div><TextField value={block.bankName} maxLength={31} onCommit={onBank} /><div className="perf-field-state" /></div>
      <div className="perf-field"><div className="perf-field-label"><strong>{tr("Min RPM")}</strong><small>+0x24 · f32</small></div><NumberField value={block.minRpmRec} onCommit={(value) => onF32(block.fileOff + 0x24, value, `${block.label} · Min RPM`)} /><div className="perf-field-state" /></div>
      <div className="perf-field"><div className="perf-field-label"><strong>{tr("Max RPM")}</strong><small>+0x28 · f32</small></div><NumberField value={block.maxRpmRec} onCommit={(value) => onF32(block.fileOff + 0x28, value, `${block.label} · Max RPM`)} /><div className="perf-field-state" /></div>
    </div>
    <h3 className="au-subhead"><Tx t="Curves {0}" v={[<small>{tr("Volume and Pitch follow RPM; Upshift and Downshift shape the gear-change event")}</small>]} /></h3>
    {curves}

    <h3 className="au-subhead"><Tx t="RPM ranges {0}" v={[<small><Tx t="{0} active · inactive rows are placeholders the engine skips" v={[block.activeRangeCount]} /></small>]} /></h3>
    <div className="au-table au-ranges">
      <div className="au-row head"><span>#</span><span>{tr("SAMPLE")}</span><span>{tr("MIN RPM")}</span><span>{tr("MID RPM")}</span><span>{tr("MAX RPM")}</span></div>
      {block.ranges.map((range) => <div key={range.index} className={`au-row${range.active ? "" : " inactive"}`}>
        <span>{range.index}</span>
        <span className="au-sample-cell" title={range.sampleName}>
          {onPlaySample && range.sampleName.includes(":") && <button className="au-row-play" onClick={() => onPlaySample(range.sampleName.slice(range.sampleName.indexOf(":") + 1))} title={tr("Play this range's sample as stored in the bank")}>▶</button>}
          {range.sampleName || "—"}
        </span>
        <NumberField value={range.minRpm} onCommit={(value) => onF32(range.fileOff + 0x20, value, `${block.label} · range ${range.index} Min RPM`)} />
        <NumberField value={range.midRpm} onCommit={(value) => onF32(range.fileOff + 0x28, value, `${block.label} · range ${range.index} Mid RPM`)} />
        <NumberField value={range.maxRpm} onCommit={(value) => onF32(range.fileOff + 0x24, value, `${block.label} · range ${range.index} Max RPM`)} />
      </div>)}
    </div>

    {listen}

    <h3 className="au-subhead"><Tx t="Block parameters {0}" v={[<small>{tr("read-only here — imports carry them in Experimental mode")}</small>]} /></h3>
    <div className="au-info">{info.map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}</div>
    {block.warnings.length > 0 && <div className="sync-notice perf-notice warn"><strong>{tr("Warnings")}</strong><span>{block.warnings.join(" · ")}</span></div>}
  </>;
}

/** The script's hint for an unnamed auxiliary float — a guess from its magnitude, for A/B testing. */
function floatHint(value: number) {
  const hints: string[] = [];
  if (value >= 0 && value <= 2.5) hints.push("gain / pitch / probability?");
  else if (value > 2.5 && value <= 250) hints.push("timing / distance / threshold?");
  else if (value > 250 && value <= 30000) hints.push("speed / RPM / threshold?");
  return hints.join(" ") || "unknown scalar";
}

function RawEditor({ raw, buf, saved, limit, candidates, onString, onF32 }: {
  raw: RawAuxBlock; buf: Uint8Array; saved: Uint8Array; limit: number; candidates: FloatEntry[];
  onString(rel: number, value: string): string | null;
  onF32(offset: number, value: number, label: string): string | null;
}) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const stringField = (rel: number, label: string) => {
    // Only where the bytes already are a name field: an empty-looking run could be a float's bytes.
    const editable = isProbableFixedAudioString(buf, raw.fileOff + rel);
    return <div className="perf-field au-wide"><div className="perf-field-label"><strong>{label}</strong><small><Tx t="+0x{0} · char[32]{1}" v={[rel.toString(16).toUpperCase().padStart(2, "0"), editable ? "" : tr(" · not a name field here")]} /></small></div>
      <TextField value={readFixedString(buf, raw.fileOff + rel, 0x20)} maxLength={31} disabled={!editable} title={editable ? undefined : tr("These bytes don't look like a fixed name field in this block, so they aren't editable as one.")} onCommit={(value) => onString(rel, value)} />
      <div className="perf-field-state" /></div>;
  };
  // Text the scan happens to read as a float, and anything past the start of the next known
  // structure, stay read-only: a write there would change a name or someone else's data.
  // Only names count as text — the loose "readable strings" also pick up float bytes that happen to
  // be printable. Names start 4-byte aligned; a name's text and terminator are locked, and the rest
  // of its slot can hold parameters (Gearshift packs two floats after each name).
  const textSpans: [number, number][] = [];
  for (let off = raw.fileOff; off < Math.min(limit, raw.fileOff + 0x200); off += 4) { const length = audioNameLength(saved, off, 0x20, true); if (length) textSpans.push([off, off + length + 1]); }
  const lockReason = (offset: number) => offset + 4 > limit ? `Past ${hex(limit)}, where the next known structure starts — likely not this block's data.` : textSpans.some(([a, b]) => offset < b && offset + 4 > a) ? "Part of a name string." : "";
  return <>
    <header className="perf-section-head">
      <div>
        <p className="eyebrow"><Tx t="Auxiliary · {0} · root+0x{1}" v={[raw.category, raw.rootRel.toString(16).toUpperCase()]} /></p>
        <h2>{tr(raw.label)}</h2>
      </div>
      <div className="au-head-side">
        <p>{tr("Auxiliary effects are only partly mapped. The name strings are safe to change. The floats are unnamed candidates found by scanning the block — editable for A/B testing in game, as in the Audio Curve GUI, but what each one does isn't known.")}</p>
        <span className="perf-section-meta"><Tx t="{0} · magic {1}" v={[hex(raw.fileOff), hex(raw.magic)]} /></span>
      </div>
    </header>
    <div className="perf-fields">{stringField(0x04, "String 0")}{stringField(0x24, "String 1")}</div>
    <h3 className="au-subhead"><Tx t="Readable strings {0}" v={[<small>{raw.foundStringEntries.length}</small>]} /></h3>
    <div className="au-chips">{raw.foundStringEntries.length ? raw.foundStringEntries.map((entry) => <span key={entry.fileOff} title={hex(entry.fileOff)}><small>+0x{(entry.fileOff - raw.fileOff).toString(16).toUpperCase()}</small>{entry.text}</span>) : <em>{tr("none")}</em>}</div>
    <h3 className="au-subhead"><Tx t="Float candidates {0}" v={[<small><Tx t="unnamed · {0} editable" v={[candidates.filter((entry) => !lockReason(raw.fileOff + entry.relOff)).length]} /></small>]} /></h3>
    <div className="au-table au-floats">
      <div className="au-row head"><span>{tr("OFFSET")}</span><span>{tr("VALUE")}</span><span>{tr("RAW U32")}</span><span>{tr("HINT")}</span></div>
      {candidates.map((entry) => {
        const offset = raw.fileOff + entry.relOff;
        const value = view.getFloat32(offset, true); const u32 = view.getUint32(offset, true);
        const changed = [0, 1, 2, 3].some((k) => buf[offset + k] !== saved[offset + k]);
        const locked = lockReason(offset);
        return <div key={entry.relOff} className={`au-row${changed ? " changed" : ""}${locked ? " locked" : ""}`}>
          <span title={hex(offset)}>+0x{entry.relOff.toString(16).toUpperCase().padStart(3, "0")}</span>
          <NumberField value={value} disabled={Boolean(locked)} title={locked || undefined} onCommit={(next) => onF32(offset, next, `${raw.label} · float +0x${entry.relOff.toString(16).toUpperCase()}`)} />
          <span>{hex(u32)}</span>
          <span title={locked}>{locked ? tr("read-only") : floatHint(value)}</span>
        </div>;
      })}
    </div>
  </>;
}

function CommonView({ common }: { common: CommonBlock }) {
  return <>
    <header className="perf-section-head">
      <div>
        <p className="eyebrow"><Tx t="Common · root+0x{0}" v={[common.rootRel.toString(16).toUpperCase()]} /></p>
        <h2>{tr(common.label)}</h2>
      </div>
      <div className="au-head-side">
        <p>{tr("The Common block's 22 parameters aren't identified yet (audio KB §3.4). Shown for comparison; imports copy them in Experimental mode.")}</p>
        <span className="perf-section-meta"><Tx t="{0} · magic {1}" v={[hex(common.fileOff), hex(common.magic)]} /></span>
      </div>
    </header>
    <div className="au-info">{common.params.map((value, i) => <div key={i}><span><Tx t="Param {0} · +0x{1}" v={[String(i).padStart(2, "0"), (4 + i * 4).toString(16).toUpperCase()]} /></span><strong>{fmt(value)}</strong></div>)}<div><span>{tr("unk_5C")}</span><strong>{hex(common.unk5C)}</strong></div></div>
  </>;
}
