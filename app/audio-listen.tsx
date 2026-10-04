import { tr, Tx } from "./i18n";
import { useEffect, useState } from "react";
import { EngineMixer, forwardGears, type Render, type VehiclePerf } from "../src/audio-preview";
import type { AudioBlock } from "../src/audio";
import type { LoadedBank } from "./audio-banks";

/**
 * The Listen card of an Engine, Exhaust or TurboBlower level: the Audio Curve GUI's preview — its
 * bank, a sample or range played raw, the engine mix at one RPM, an RPM sweep, and a run through
 * the gears from the PCK's own Base or Mods performance. Renders use the block as it is now, edits
 * included, so a change is heard before it's saved.
 */

export type BankState = { status: "loading" } | { status: "missing"; message: string } | { status: "ready"; loaded: LoadedBank };
export type PerfState = Record<"base" | "mods", VehiclePerf | string>;

export function ListenPanel({ block, bank, perf, banksFolder, searched, playing, onPlayRender, onPlaySample, onStop, onExport, onChooseFolder, onClearFolder, onStatus }: {
  block: AudioBlock;
  bank: BankState;
  perf: PerfState;
  banksFolder: string;
  searched: string[];
  playing: string | null;
  onPlayRender(render: Render): void;
  onPlaySample(name: string): void;
  onStop(): void;
  onExport(render: Render): void;
  onChooseFolder(): void;
  onClearFolder(): void;
  onStatus(message: string): void;
}) {
  const [variant, setVariant] = useState<"base" | "mods">("base");
  const [lastRender, setLastRender] = useState<Render | null>(null);
  const [busy, setBusy] = useState("");
  const [showSamples, setShowSamples] = useState(false);
  const chosen = perf[variant];
  // The script's slider: from the vehicle's idle to just past its redline, or around the block's RPMs.
  const bounds = typeof chosen === "object"
    ? { lo: Math.max(200, chosen.engine.idleRpm * 0.5), hi: chosen.engine.maxRpm * 1.05 }
    : { lo: Math.max(200, block.minRpmRec * 0.7), hi: Math.max(block.maxRpmRec * 1.15, Math.max(200, block.minRpmRec * 0.7) + 500) };
  const [rpm, setRpm] = useState(0);
  useEffect(() => { const mid = (block.minRpmRec + block.maxRpmRec) * 0.5; setRpm(mid > 0 ? mid : 2000); setLastRender(null); }, [block.rootRel]);
  const shownRpm = Math.min(Math.max(rpm, bounds.lo), bounds.hi);

  const ready = bank.status === "ready" ? bank.loaded : null;
  const run = (what: string, make: (mixer: EngineMixer) => Render) => {
    if (!ready) return;
    setBusy(what); onStatus(`Rendering ${what}…`);
    // Let the "rendering" state paint before the (synchronous) mix runs.
    window.setTimeout(() => {
      try { const render = make(new EngineMixer(block, ready.bank)); setLastRender(render); onPlayRender(render); }
      catch (caught) { onStatus(caught instanceof Error ? caught.message : "The preview could not be rendered."); }
      finally { setBusy(""); }
    }, 20);
  };
  const perfLabel = typeof chosen === "object"
    ? `Idle ${Math.round(chosen.engine.idleRpm)} · Max ${Math.round(chosen.engine.maxRpm)} RPM · ${forwardGears(chosen)} gears · shift ${chosen.trans.gearChangeTime.toFixed(2)} s`
    : chosen;

  return <section className="au-listen">
    <header>
      <div>
        <p className="eyebrow">{tr("LISTEN")}</p>
        {bank.status === "loading" && <span className="au-listen-bank"><Tx t="Looking for {0}…" v={[block.bankName || tr("the bank")]} /></span>}
        {bank.status === "missing" && <span className="au-listen-bank warn" title={searched.join("\n")}>{tr(bank.message)}</span>}
        {ready && <span className="au-listen-bank" title={`${ready.bnk}${ready.td ? `\n${ready.td}` : ""}`}>
          <b>{ready.bnk.replace(/^.*[\\/]/, "")}</b>{ready.td ? <> + <b>{ready.td.replace(/^.*[\\/]/, "")}</b></> : <em> {tr("· no .td found — samples keep their stream numbers, and ranges may not resolve")}</em>}
          <small><Tx t="{0} samples" v={[ready.bank.samples.size]} /></small>
        </span>}
      </div>
      <div className="au-listen-folder">
        <span title={searched.join("\n")}>{banksFolder ? banksFolder : tr("Banks: next to the PCK and in ASSETS/audio/banks")}</span>
        <button className="au-mini" onClick={onChooseFolder} title={tr("Also look for .bnk/.td files in this folder, before the automatic ones")}>{banksFolder ? tr("Change…") : tr("Banks folder…")}</button>
        {banksFolder && <button className="au-mini" onClick={onClearFolder}>{tr("Clear")}</button>}
      </div>
    </header>

    <div className="au-listen-row">
      <label className="au-rpm">
        <span>{tr("RPM")}</span>
        <input type="range" min={bounds.lo} max={bounds.hi} step={10} value={shownRpm} disabled={!ready} onChange={(event) => setRpm(Number(event.target.value))} />
        <strong>{Math.round(shownRpm)}</strong>
      </label>
      <button className="au-play" disabled={!ready || Boolean(busy)} onClick={() => run(`${Math.round(shownRpm)} RPM`, (m) => m.renderConstant(shownRpm, 2))}>{tr("▶ Play 2 s")}</button>
      <button className="au-play" disabled={!ready || Boolean(busy)} onClick={() => run("RPM sweep", (m) => m.renderSweep(6))} title={tr("Min RPM → Max RPM → Min RPM over 6 s")}>{tr("Sweep 6 s")}</button>
      <span className="au-listen-divider" />
      <div className="au-seg">
        <button className={variant === "base" ? "active" : ""} onClick={() => setVariant("base")} title={tr("Stock performance (vehsim Base)")}>{tr("Base")}</button>
        <button className={variant === "mods" ? "active" : ""} onClick={() => setVariant("mods")} title={tr("Fully upgraded performance (vehsim Mods)")}>{tr("Mods")}</button>
      </div>
      <button className="au-play" disabled={!ready || Boolean(busy) || typeof chosen !== "object"} title={typeof chosen === "object" ? tr("Accelerate through every gear with this car's gear speeds, shift time and Upshift curve") : chosen}
        onClick={() => typeof chosen === "object" && run(`${forwardGears(chosen)}-gear acceleration`, (m) => m.renderGearDrive(chosen, 12))}>{tr("Gear shifts")}</button>
      <span className="au-curve-spacer" />
      <button className="au-mini" disabled={!playing} onClick={onStop}>{tr("■ Stop")}</button>
      <button className="au-mini" disabled={!lastRender} onClick={() => lastRender && onExport(lastRender)} title={lastRender ? tr(`Save "${lastRender.label}" as a WAV file`) : tr("Play something first")}>{tr("Export WAV…")}</button>
    </div>
    <p className="au-listen-note"><Tx t="{0} · the Audio Curve GUI's approximation of the mix, for checking banks, ranges and curves — not the game's exact sound." v={[busy ? tr(`Rendering ${busy}…`) : playing ? tr(`Playing ${playing}`) : perfLabel]} /></p>

    {ready && <div className="au-listen-samples">
      <button className="link-button" onClick={() => setShowSamples((v) => !v)}><Tx t="{0} bank samples ({1})" v={[showSamples ? tr("Hide") : tr("Show"), ready.bank.samples.size]} /></button>
      {showSamples && <div className="au-chips">{ready.bank.names().map((name) => <button key={name} className="au-sample-chip" onClick={() => onPlaySample(name)} title={tr("Play this sample as stored in the bank")}>▶ {name}</button>)}</div>}
    </div>}
  </section>;
}
