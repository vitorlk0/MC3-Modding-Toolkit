/**
 * Audible preview of an AudioBlockFull — the Audio Curve GUI's `EngineMixer` and its vehsim reader,
 * ported with the same arithmetic so a render is sample-identical to the script's WAV.
 *
 * The mixer is the script's approximation, not the game's engine: each active range's sample is
 * pitched by RPM / MidRPM, ranges crossfade over Min→Mid→Max, and the VolumeCurve scales the mix.
 * It is for hearing whether banks, ranges and curves fit together, not a runtime-exact render.
 */
import { fitQuadratic, type AudioBlock, type AudioRange, type CurveData } from "./audio";
import { BankSamples, buildWav } from "./bnk";
import { pySum } from "./pillow";

export const PREVIEW_RATE = 32000;

// --- vehsim: Engine + Trans of the Base or Mods performance -------------------------------------------
export type VehiclePerf = {
  variant: "base" | "mods";
  engine: { angInertia: number; maxHorsepower: number; idleRpm: number; optRpm: number; maxRpm: number; engageRpm: number; gcl: number; gearChangeThrottle: number; boostDuration: number; boostHp: number };
  trans: { numGears: number; reverse: number; low: number; high: number; upshiftBias: number; downshiftBiasMin: number; downshiftBiasMax: number; maxDownshifts: number; gearBias: number; gearChangeTime: number };
};
/** ManualNumGears also counts reverse and neutral: a 350Z reads 8 for its 6 forward gears. */
export const forwardGears = (perf: VehiclePerf) => Math.max(1, perf.trans.numGears - 2);
/** Top speed at MaxRPM per forward gear, Low→High, spaced by GearBias (the script's approximation). */
export function gearSpeeds(perf: VehiclePerf) {
  const n = forwardGears(perf); const t = perf.trans;
  if (n === 1) return [t.high || t.low || 1];
  const bias = t.gearBias >= 0.05 && t.gearBias <= 5 ? t.gearBias : 1;
  return Array.from({ length: n }, (_, i) => t.low + (t.high - t.low) * (i / (n - 1)) ** bias);
}
/** PS2 .pck only: header +0xB4 (Base) / +0xB8 (Mods) → vehsim, whose table at +0x54 points to Engine and Trans. */
export function parseVehiclePerf(buf: Uint8Array, variant: "base" | "mods"): VehiclePerf {
  if (buf.length < 0x100) throw new Error("Too small to be a vehicle PCK.");
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const u32 = (off: number) => view.getUint32(off, true); const f32 = (off: number) => view.getFloat32(off, true);
  const baseVa = u32(0) - 0x80;
  const toOff = (va: number, size: number) => { const off = va - baseVa; return off >= 0 && off + size <= buf.length ? off : null; };
  const vehsim = toOff(u32(variant === "base" ? 0xb4 : 0xb8), 0x94);
  if (vehsim === null) throw new Error(`No ${variant === "base" ? "Base" : "Mods"} vehsim pointer — does this PCK carry performance data?`);
  const engine = toOff(u32(vehsim + 0x54 + 0x08), 40); const trans = toOff(u32(vehsim + 0x54 + 0x0c), 40);
  if (engine === null || trans === null) throw new Error("Invalid Engine/Trans pointers in the vehsim.");
  const perf: VehiclePerf = {
    variant,
    engine: { angInertia: f32(engine), maxHorsepower: f32(engine + 4), idleRpm: f32(engine + 8), optRpm: f32(engine + 0xc), maxRpm: f32(engine + 0x10), engageRpm: f32(engine + 0x14), gcl: f32(engine + 0x18), gearChangeThrottle: f32(engine + 0x1c), boostDuration: f32(engine + 0x20), boostHp: f32(engine + 0x24) },
    trans: { numGears: u32(trans), reverse: f32(trans + 4), low: f32(trans + 8), high: f32(trans + 0xc), upshiftBias: f32(trans + 0x10), downshiftBiasMin: f32(trans + 0x14), downshiftBiasMax: f32(trans + 0x18), maxDownshifts: u32(trans + 0x1c), gearBias: f32(trans + 0x20), gearChangeTime: f32(trans + 0x24) },
  };
  const e = perf.engine;
  if (!(e.idleRpm >= 100 && e.idleRpm <= 20000 && e.maxRpm >= 1000 && e.maxRpm <= 30000)) throw new Error(`Implausible RPMs (idle ${e.idleRpm}, max ${e.maxRpm}).`);
  if (!(perf.trans.numGears >= 1 && perf.trans.numGears <= 12)) throw new Error(`Implausible gear count ${perf.trans.numGears}.`);
  return perf;
}

// --- curves, as the script's preview evaluates them: A/B/C refitted from the points -------------------
type Segment = { x0: number; y0: number; x1: number; y1: number; lo: number; hi: number; a: number; b: number; c: number };
function previewSegments(curve: CurveData | undefined): Segment[] {
  if (!curve) return [];
  const out: Segment[] = [];
  for (const row of curve.rows.slice(0, Math.max(0, curve.pointCount))) {
    if (row.length < 6 || !row.slice(0, 6).every(Number.isFinite)) continue;
    const [x0, y0, cx, cy, x1, y1] = row; const [a, b, c] = fitQuadratic(x0, y0, cx, cy, x1, y1);
    out.push({ x0, y0, x1, y1, lo: Math.min(x0, x1), hi: Math.max(x0, x1), a, b, c });
  }
  return out;
}
function evaluateSegments(segments: Segment[], x: number): number | null {
  if (!segments.length) return null;
  let nearD = Infinity; let nearY: number | null = null;
  for (const s of segments) {
    if (s.lo <= x && x <= s.hi) return s.a * x * x + s.b * x + s.c;
    const candidates: [number, number][] = [[Math.abs(x - s.lo), s.x0 <= s.x1 ? s.y0 : s.y1], [Math.abs(x - s.hi), s.x0 <= s.x1 ? s.y1 : s.y0]];
    for (const [d, y] of candidates) if (nearY === null || d < nearD) { nearD = d; nearY = y; }
  }
  return nearY;
}
function rangeEnvelope(rpm: number, range: AudioRange, first: boolean, last: boolean) {
  const lo = range.minRpm; const hi = range.maxRpm;
  if (hi <= lo) return 0;
  const mid = Math.min(Math.max(range.midRpm, lo + 1e-3), hi - 1e-3);
  if (rpm < lo) return first ? 1 : 0;
  if (rpm > hi) return last ? 1 : 0;
  if (rpm <= mid) return first ? 1 : (rpm - lo) / (mid - lo);
  return last ? 1 : 1 - (rpm - mid) / (hi - mid);
}

// --- the mixer ------------------------------------------------------------------------------------------
export type Render = { pcm: Int16Array; rate: number; duration: number; rpmAt(t: number): number; label: string };

export class EngineMixer {
  private volume: Segment[];
  constructor(private block: AudioBlock, private bank: BankSamples) { this.volume = previewSegments(block.curves.volume_curve); }

  private activeRanges() {
    const active: { range: AudioRange; name: string; pcm: Int16Array; rate: number; loop: boolean; loopStart: number; loopEnd: number }[] = [];
    const missing: string[] = [];
    for (const range of this.block.ranges.slice(0, this.block.activeRangeCount)) {
      const name = range.sampleName.includes(":") ? range.sampleName.slice(range.sampleName.indexOf(":") + 1) : range.sampleName;
      if (!name || name.toUpperCase() === "EMPTY") continue;
      const entry = this.bank.get(name);
      if (!entry || !entry.pcm || !entry.pcm.length) { missing.push(name); continue; }
      active.push({ range, name, pcm: entry.pcm, rate: entry.rate, loop: entry.loop, loopStart: entry.loopStart, loopEnd: entry.loopEnd });
    }
    if (!active.length && missing.length) throw new Error(`No active range sample could be found in the bank: ${missing.join(", ")}.${this.bank.hasNameMapping ? "" : " The bank's .td file is needed to map sample names to sounds."}`);
    return active;
  }
  volumeAt(rpm: number) {
    const span = this.block.maxRpmRec - this.block.minRpmRec;
    const normalized = Math.min(Math.max(span > 0 ? (rpm - this.block.minRpmRec) / span : 0, 0), 1);
    const value = evaluateSegments(this.volume, normalized);
    return value === null ? 1 : Math.min(Math.max(value, 0), 1.5);
  }

  render(rpmFn: (t: number) => number, duration: number, volFn?: (t: number) => number) {
    const active = this.activeRanges();
    if (!active.length) throw new Error("No active ranges with playable samples.");
    const count = Math.trunc(duration * PREVIEW_RATE);
    const out = new Int16Array(count);
    const cursors = new Float64Array(active.length);
    const weights = new Array<number>(active.length);
    for (let o = 0; o < count; o += 1) {
      const t = o / PREVIEW_RATE; const rpm = rpmFn(t);
      let master = this.volumeAt(rpm);
      if (volFn) master *= volFn(t);
      for (let i = 0; i < active.length; i += 1) weights[i] = rangeEnvelope(rpm, active[i].range, i === 0, i === active.length - 1);
      const weightSum = pySum(weights);
      if (weightSum <= 1e-6) continue;
      let mixed = 0;
      for (let i = 0; i < active.length; i += 1) {
        const weight = weights[i] / weightSum;
        if (weight <= 0.001) continue;
        const a = active[i]; const n = a.pcm.length;
        if (n < 2) continue;
        const middle = a.range.midRpm > 0 ? a.range.midRpm : Math.max(a.range.minRpm, 1);
        const step = Math.max(0.25, Math.min(4, rpm / middle)) * a.rate / PREVIEW_RATE;
        let position = cursors[i]; let index = Math.trunc(position); let fraction = position - index;
        const [loopStart, loopEnd] = a.loop && a.loopStart >= 0 && a.loopStart < a.loopEnd && a.loopEnd <= n ? [a.loopStart, a.loopEnd] : [0, n];
        if (index + 1 >= loopEnd) {
          position = loopStart + ((position - loopStart) % Math.max(1, loopEnd - loopStart));
          index = Math.trunc(position); fraction = position - index;
        }
        const s0 = a.pcm[index]; const s1 = index + 1 < n ? a.pcm[index + 1] : s0;
        mixed += (s0 + (s1 - s0) * fraction) * weight;
        cursors[i] = position + step;
      }
      const v = Math.trunc(mixed * master);
      out[o] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
    }
    return out;
  }

  renderConstant(rpm: number, duration = 2): Render {
    return { pcm: this.render(() => rpm, duration), rate: PREVIEW_RATE, duration, rpmAt: () => rpm, label: `${Math.round(rpm)} RPM` };
  }
  renderSweep(duration = 6): Render {
    const low = this.block.minRpmRec; const high = this.block.maxRpmRec; const half = duration * 0.5;
    const rpmAt = (t: number) => t <= half ? low + (high - low) * t / Math.max(half, 1e-6) : high - (high - low) * (t - half) / Math.max(half, 1e-6);
    return { pcm: this.render(rpmAt, duration), rate: PREVIEW_RATE, duration, rpmAt, label: "RPM sweep" };
  }
  renderGearDrive(perf: VehiclePerf, duration = 12, shiftDipGain = 3): Render {
    const e = perf.engine; const block = this.block;
    const idle = Math.max(e.idleRpm, e.engageRpm, 1);
    const max = e.maxRpm > idle ? e.maxRpm : block.maxRpmRec;
    const toAudio = (engineRpm: number) => {
      const aLow = block.minRpmRec; const aHigh = block.maxRpmRec;
      if (max <= idle || aHigh <= aLow) return engineRpm;
      return aLow + Math.min(Math.max((engineRpm - idle) / (max - idle), 0), 1) * (aHigh - aLow);
    };
    const speeds = gearSpeeds(perf); const gears = speeds.length;
    const rpmUp = e.idleRpm < e.optRpm && e.optRpm <= e.maxRpm ? e.optRpm : e.maxRpm * 0.9;
    const shiftTime = Math.max(0.15, Math.min(2, perf.trans.gearChangeTime));
    const pulls: [number, number, number][] = [];
    let rpmIn = idle;
    for (let g = 0; g < gears; g += 1) {
      const vs = speeds[g] * rpmIn / Math.max(1, e.maxRpm); const ve = speeds[g] * rpmUp / Math.max(1, e.maxRpm);
      pulls.push([rpmIn, rpmUp, Math.max(0.05, ve * ve - vs * vs)]);
      if (g + 1 < gears) rpmIn = rpmUp * speeds[g] / speeds[g + 1];
    }
    const pullBudget = Math.max(1, duration - shiftTime * (gears - 1));
    const weightTotal = pySum(pulls.map((p) => p[2]));
    const timeline: { start: number; end: number; kind: "pull" | "shift"; from: number; to: number }[] = [];
    let cursor = 0;
    pulls.forEach(([from, to, weight], g) => {
      const span = pullBudget * weight / Math.max(weightTotal, 1e-6);
      timeline.push({ start: cursor, end: cursor + span, kind: "pull", from, to }); cursor += span;
      if (g + 1 < gears) { timeline.push({ start: cursor, end: cursor + shiftTime, kind: "shift", from: to, to: to * speeds[g] / speeds[g + 1] }); cursor += shiftTime; }
    });
    const shift = previewSegments(block.curves.upshift_curve);
    let sx0 = 0; let sx1 = 1;
    if (shift.length) { const xs = [...shift.map((s) => s.x0), ...shift.map((s) => s.x1)]; sx0 = Math.min(...xs); sx1 = Math.max(...xs); if (sx1 - sx0 < 1e-6) sx1 = sx0 + 1; }
    const shiftEnvelope = (fraction: number) => {
      fraction = Math.min(Math.max(fraction, 0), 1);
      if (!shift.length) return 0.6 * Math.sin(Math.PI * fraction);
      return Math.max(0, evaluateSegments(shift, sx0 + (sx1 - sx0) * fraction) || 0) * shiftDipGain;
    };
    const rpmAt = (t: number) => {
      let result = rpmUp;
      for (const seg of timeline) if (seg.start <= t && t <= seg.end) {
        let fraction = (t - seg.start) / Math.max(1e-9, seg.end - seg.start);
        if (seg.kind === "shift") fraction = Math.min(1, fraction * 1.6);
        result = seg.from + (seg.to - seg.from) * fraction; break;
      }
      return toAudio(result);
    };
    const volAt = (t: number) => {
      for (const seg of timeline) if (seg.kind === "shift" && seg.start <= t && t <= seg.end) return Math.max(0.15, 1 - shiftEnvelope((t - seg.start) / Math.max(1e-9, seg.end - seg.start)));
      return 1;
    };
    return { pcm: this.render(rpmAt, cursor, volAt), rate: PREVIEW_RATE, duration: cursor, rpmAt, label: `${gears}-gear acceleration (${perf.variant === "base" ? "Base" : "Mods"})` };
  }
}

export const renderToWav = (render: Render) => buildWav(render.pcm, render.rate);
