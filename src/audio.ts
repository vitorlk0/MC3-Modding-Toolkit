/**
 * Vehicle audio in a car PCK — the `audio_root` at file+0xA8 and everything it points to. A port
 * of the parser and both donor imports of `mc3_audio_curve_gui.py` (MC3 Vehicle Audio Curve GUI
 * v0.21), kept byte-identical to it: same structures, same fallbacks, same pairing of donor and
 * target blocks, same write order. Layouts follow the audio KB (§3, §5–§8).
 *
 * Findings this module is used with, checked across the 91 cars in the HostFS tree:
 * - The Player PCK holds the full audio (13 AudioBlockFull: 5 Engine, 5 Exhaust, 3 TurboBlower).
 * - A stock Garage PCK holds a subset (Engine/Exhaust and fewer auxiliaries), and every block it
 *   has is identical to the Player's (934 of 934 compared).
 * - A stock Opponent PCK has its own generic audio (E_Op_Muscle, E_Op_Luxury, …), not the Player's.
 * - Mods commonly copy the Player PCK over all three, making them identical.
 */

export const AUDIO_ROOT_MAGICS: Record<number, string> = { 0x007a1a28: "350Z / SRT4 style AudioRoot", 0x007a2d30: "DeVille style AudioRoot" };
export const AUDIO_BLOCK_MAGICS: Record<number, string> = { 0x007a1df0: "350Z / SRT4 style AudioBlockFull", 0x007a30f8: "DeVille style AudioBlockFull" };
export const COMMON_MAGICS: Record<number, string> = { 0x007a1a80: "350Z / SRT4 style Common", 0x007a2d88: "DeVille style Common" };
const CURVE_MAGIC = 0x0079e730;
const RANGE_ENTRY_SIZE = 0x2c;
const RANGE_ALLOCATED_COUNT = 8;
const CURVE_POINT_FLOATS = 9;
const CURVE_POINT_SIZE = CURVE_POINT_FLOATS * 4;
const CURVE_HEADER_SIZE = 0x20;
const CURVE_STORAGE_SIZE = 0x140;
const RANGE_TABLE_REL_FALLBACK = 0x0a0;
const ENGINE_REV_SOUND_OFF = 0x68;
const ENGINE_REV_SOUND_SIZE = 0x20;
const FIXED_PACKAGE_CURVE_RELS: Record<string, number> = { volume_curve: 0x200, pitch_curve: 0x340, high_pitch_curve: 0x480, upshift_curve: 0x5c0, downshift_curve: 0x700 };
export const CURVE_FIELDS: { key: string; label: string; ptrRel: number }[] = [
  { key: "volume_curve", label: "Volume", ptrRel: 0x88 },
  { key: "pitch_curve", label: "Pitch", ptrRel: 0x8c },
  { key: "high_pitch_curve", label: "High Pitch", ptrRel: 0x90 },
  { key: "upshift_curve", label: "Upshift", ptrRel: 0x94 },
  { key: "downshift_curve", label: "Downshift", ptrRel: 0x98 },
];

type PointerKind = "raw" | "raw_bundle" | "block" | "common";
export const ROOT_POINTERS: { label: string; rel: number; kind: PointerKind; category: string }[] = [
  ["Impact Level0", 0x18, "raw", "Impact"], ["BigAir Level0", 0x1c, "raw", "BigAir"], ["Wind Level0", 0x20, "raw", "Wind"], ["Horn Level0", 0x24, "raw", "Horn"],
  ["Powerup Level0", 0x28, "raw", "Powerup"], ["Fire Level0", 0x2c, "raw", "Fire"],
  ["Wheel Level0", 0x30, "raw", "Wheel"], ["Wheel Level1", 0x34, "raw", "Wheel"], ["Wheel Level2", 0x38, "raw", "Wheel"],
  ["Suspension Level0", 0x3c, "raw", "Suspension"], ["Suspension Level1", 0x40, "raw", "Suspension"], ["Suspension Level2", 0x44, "raw", "Suspension"],
  ["Gearshift Level0", 0x48, "raw_bundle", "Gearshift"], ["Gearshift Level1", 0x4c, "raw_bundle", "Gearshift"], ["Gearshift Level2", 0x50, "raw_bundle", "Gearshift"],
  ["Backfire Level0", 0x54, "raw_bundle", "Backfire"], ["Backfire Level1", 0x58, "raw_bundle", "Backfire"], ["Backfire Level2", 0x5c, "raw_bundle", "Backfire"],
  ["TurboBlower Level0", 0x60, "block", "TurboBlower"], ["TurboBlower Level1", 0x64, "block", "TurboBlower"], ["TurboBlower Level2", 0x68, "block", "TurboBlower"],
  ["Engine Level0", 0x6c, "block", "Engine"], ["Engine Level1", 0x70, "block", "Engine"], ["Engine Level2", 0x74, "block", "Engine"], ["Engine Level3", 0x78, "block", "Engine"], ["Engine Level4", 0x7c, "block", "Engine"],
  ["Exhaust Level0", 0x80, "block", "Exhaust"], ["Exhaust Level1", 0x84, "block", "Exhaust"], ["Exhaust Level2", 0x88, "block", "Exhaust"], ["Exhaust Level3", 0x8c, "block", "Exhaust"], ["Exhaust Level4", 0x90, "block", "Exhaust"],
  ["Common Level0", 0x94, "common", "Common"], ["Common Level1", 0x98, "common", "Common"], ["Common Level2", 0x9c, "common", "Common"], ["Common Level3", 0xa0, "common", "Common"], ["Common Level4", 0xa4, "common", "Common"],
].map(([label, rel, kind, category]) => ({ label: label as string, rel: rel as number, kind: kind as PointerKind, category: category as string }));
const MAIN_SLOT_RELS = new Set([0x6c, 0x70, 0x74, 0x78, 0x7c, 0x80, 0x84, 0x88, 0x8c, 0x90]);
const AUX_MAGIC_SCAN_SIZES: Record<number, number> = { 0x007aded0: 0x0a0, 0x007b08b8: 0x0a0, 0x007a2440: 0x080, 0x007b0868: 0x0c0, 0x0079e730: 0x140, 0x007b0940: 0x1f0, 0x007a2408: 0x0b0, 0x007a1e98: 0x420, 0x007a2498: 0xa40 };

export type AudioRange = { index: number; fileOff: number; sampleName: string; minRpm: number; maxRpm: number; midRpm: number; active: boolean };
export type CurveData = {
  key: string; label: string; ptrVa: number; fileOff: number | null; magic: number;
  minX: number; minY: number; maxX: number; maxY: number;
  /** ActiveSeriesCount (the script's point_count). */
  pointCount: number; ptrPoints: number; pointsFileOff: number | null; pad1C: number; rows: number[][]; warning: string;
};
export type AudioBlock = {
  type: "block"; label: string; category: string; rootRel: number; ptrVa: number; fileOff: number; magic: number;
  bankName: string; minRpmRec: number; maxRpmRec: number; nearDist: number; farDist: number;
  activeRangeCount: number; ptrRangeTable: number; rangeTableFileOff: number | null;
  warble: number[]; boostMixPercent: number; boostMixRate: number; highPitchCurveEngageGear: number; engineRevSound: string;
  ranges: AudioRange[]; curves: Record<string, CurveData>; warnings: string[];
};
export type StringEntry = { fileOff: number; relOff: number; text: string };
export type FloatEntry = { fileOff: number; relOff: number; value: number; u32: number };
export type RawAuxBlock = {
  type: "raw"; label: string; category: string; rootRel: number; ptrVa: number; fileOff: number; kind: PointerKind; magic: number;
  possibleName0: string; possibleName1: string; foundStrings: string[]; foundStringEntries: StringEntry[]; floatPreview: FloatEntry[]; warnings: string[];
};
export type CommonBlock = { type: "common"; label: string; category: string; rootRel: number; ptrVa: number; fileOff: number; magic: number; params: number[]; unk5C: number; warnings: string[] };
export type AudioItem = AudioBlock | RawAuxBlock | CommonBlock;
export type AudioDocument = {
  baseVa: number; rootVa: number; rootOff: number; rootMagic: number; rootName: string;
  blocks: AudioBlock[]; rawAux: RawAuxBlock[]; commons: CommonBlock[]; warnings: string[];
};

// ---------------------------------------------------------------------------------------------
// Byte helpers with the script's exact semantics

const dv = (buf: Uint8Array) => new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
const inRange = (buf: Uint8Array, off: number | null, size = 1): off is number => off !== null && off >= 0 && off + size <= buf.length;
const safeU32 = (buf: Uint8Array, off: number) => inRange(buf, off, 4) ? dv(buf).getUint32(off, true) : 0;
/** `safe_f32`: a non-finite value reads as 0.0. */
const safeF32 = (buf: Uint8Array, off: number) => { if (!inRange(buf, off, 4)) return 0; const v = dv(buf).getFloat32(off, true); return Number.isFinite(v) ? v : 0; };
const isNullish = (value: number) => value === 0 || value === 0xcdcdcdcd || ((value & 0xffff0000) >>> 0) === 0xcdcd0000;
const isPrintable = (b: number) => b >= 0x20 && b <= 0x7e;
const isAlpha = (c: string) => /^[A-Za-z]$/.test(c);
const isAlnum = (c: string) => /^[A-Za-z0-9]$/.test(c);

/** `read_fixed_string`: up to 00/CD, ASCII with U+FFFD for anything else. */
export function readFixedString(buf: Uint8Array, off: number, size = 0x20) {
  if (off < 0 || off >= buf.length) return "";
  let out = "";
  for (let i = off, end = Math.min(buf.length, off + size); i < end; i += 1) {
    const b = buf[i];
    if (b === 0x00 || b === 0xcd) break;
    out += b < 0x80 ? String.fromCharCode(b) : "�";
  }
  return out;
}
/** `encode_fixed_string`: ASCII (non-ASCII as '?'), one 00 terminator, CD padding. */
export function encodeFixedString(value: string, size = 0x20) {
  const text = [...(value ?? "")].map((c) => c.charCodeAt(0) < 0x80 && c.length === 1 ? c.charCodeAt(0) : 0x3f).slice(0, Math.max(0, size - 1));
  const out = new Uint8Array(size).fill(0xcd);
  out.set(text, 0); out[text.length] = 0x00;
  return out;
}
const writeF32 = (buf: Uint8Array, off: number, value: number) => dv(buf).setFloat32(off, value, true);
const writeU32 = (buf: Uint8Array, off: number, value: number) => dv(buf).setUint32(off, value >>> 0, true);
const sameSlice = (buf: Uint8Array, off: number, raw: Uint8Array) => raw.every((b, i) => buf[off + i] === b);

export function replaceSamplePrefix(oldSample: string, donorBank: string) {
  const bank = (donorBank ?? "").trim();
  if (!bank || !oldSample.includes(":")) return oldSample;
  const suffix = oldSample.slice(oldSample.indexOf(":") + 1);
  return suffix ? `${bank}:${suffix}` : oldSample;
}

/** `is_probable_fixed_audio_string`: a conservative detector for 0x20-byte name fields. */
export function isProbableFixedAudioString(buf: Uint8Array, off: number, fieldSize = 0x20) {
  if (off < 0 || off + 1 >= buf.length) return false;
  if (off > 0 && isPrintable(buf[off - 1])) return false;
  return audioNameLength(buf, off, fieldSize) > 0;
}
/**
 * The length of the audio name at `off` (0 if none), by the script's rules for a name's text and
 * terminator — without its "no printable byte before" check, which misses a name packed right after
 * a float whose last byte happens to be printable (Gearshift: 0.2f ends in '>'). `vehicleNames` also
 * accepts the vp_* names the script excludes from audio names, for telling text from floats.
 */
export function audioNameLength(buf: Uint8Array, off: number, fieldSize = 0x20, vehicleNames = false) {
  if (off < 0 || off + 1 >= buf.length) return 0;
  const text = readFixedString(buf, off, fieldSize);
  if (text.length < 4) return 0;
  const end = off + text.length;
  if (end >= buf.length || (buf[end] !== 0x00 && buf[end] !== 0xcd)) return 0;
  if (![...text].every((c) => /[A-Za-z0-9_:\-./]/.test(c))) return 0;
  if (!vehicleNames && text.toLowerCase().startsWith("vp_")) return 0;
  if (text.includes(":")) {
    const left = text.slice(0, text.indexOf(":")); const right = text.slice(text.indexOf(":") + 1);
    return left && right && [...left].every((c) => isAlnum(c) || c === "_") ? text.length : 0;
  }
  return isAlpha(text[0]) && [...text].every((c) => isAlnum(c) || c === "_") ? text.length : 0;
}
const auxScanSize = (magic: number, fallback = 0x300) => AUX_MAGIC_SCAN_SIZES[magic >>> 0] ?? fallback;
export function iterFixedAudioStrings(buf: Uint8Array, start: number, maxSize: number): [number, string][] {
  if (start < 0 || start >= buf.length) return [];
  const end = Math.min(buf.length, start + maxSize);
  const out: [number, string][] = []; const seen = new Set<number>();
  for (let off = start; off < Math.max(start, end - 3); off += 4) {
    if (!isProbableFixedAudioString(buf, off, 0x20)) continue;
    const rel = off - start;
    if (seen.has(rel)) continue;
    seen.add(rel); out.push([rel, readFixedString(buf, off, 0x20)]);
  }
  return out;
}
function readLooseStringEntries(buf: Uint8Array, off: number, size: number): StringEntry[] {
  if (off < 0 || off >= buf.length) return [];
  const end = Math.min(buf.length, off + size);
  const entries: StringEntry[] = []; const seen = new Set<string>();
  let cur = ""; let start: number | null = null;
  const flush = () => {
    if (start !== null && cur.length >= 3) {
      const key = `${start}|${cur}`;
      if ([...cur].some(isAlpha) && !seen.has(key)) { seen.add(key); entries.push({ fileOff: start, relOff: start - off, text: cur }); }
    }
    cur = ""; start = null;
  };
  for (let i = off; i < end; i += 1) {
    const b = buf[i];
    if (isPrintable(b)) { if (start === null) start = i; cur += String.fromCharCode(b); if (cur.length > 96) flush(); }
    else flush();
  }
  flush();
  return entries;
}
function rawFloatPreview(buf: Uint8Array, off: number, size: number): FloatEntry[] {
  if (off < 0 || off >= buf.length) return [];
  const end = Math.min(buf.length, off + size);
  const out: FloatEntry[] = [];
  for (let pos = off + 4; pos < end - 3; pos += 4) {
    const raw = safeU32(buf, pos); const value = safeF32(buf, pos);
    if (raw === 0 || raw === 0xcdcdcdcd) continue;
    if (raw >= 0x01000000 && raw <= 0x0fffffff) continue;
    if (value >= -100000 && value <= 100000) out.push({ fileOff: pos, relOff: pos - off, value, u32: raw });
    if (out.length >= 48) break;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Parser

export function sampleSuffix(name: string) { return name.includes(":") ? name.slice(name.indexOf(":") + 1) : name; }
export function blockRole(block: AudioBlock) {
  const active = block.ranges.slice(0, Math.max(0, Math.min(block.activeRangeCount, block.ranges.length)));
  const suffixes = active.map((range) => sampleSuffix(range.sampleName).toUpperCase());
  const engine = suffixes.filter((s) => s.includes("_ENGINE") || s.endsWith("ENGINE")).length;
  const tail = suffixes.filter((s) => s.includes("_TAIL") || s.endsWith("TAIL")).length;
  const turbo = suffixes.filter((s) => s.includes("TURBO") || s.includes("BLOW")).length;
  if (engine > tail) return "ENGINE samples";
  if (tail > engine) return "TAIL samples";
  if (engine && tail) return "MIXED ENGINE/TAIL";
  if (turbo) return "TURBO/AUX samples";
  return "unknown samples";
}

export function parseAudio(buf: Uint8Array): AudioDocument {
  if (buf.length < 0xc0) throw new Error("File is too small to be a vehicle PCK with an audio root pointer.");
  const ptrVa = safeU32(buf, 0);
  const baseVa = ptrVa - 0x80;
  const vaToOff = (va: number, size = 1): number | null => { if (isNullish(va)) return null; const off = va - baseVa; return inRange(buf, off, size) ? off : null; };
  const warnings: string[] = [];
  const fileDataSize = safeU32(buf, 0x0c);
  if (fileDataSize !== Math.max(0, buf.length - 0x80)) warnings.push(`Header file_data_size=${fileDataSize} differs from actual size-0x80=${Math.max(0, buf.length - 0x80)}.`);
  const rootVa = safeU32(buf, 0xa8);
  const rootOff = vaToOff(rootVa, 0xb8);
  if (rootOff === null) throw new Error(`Invalid audio root pointer ${hex(rootVa)} at +0xA8 — this PCK has no readable audio.`);
  const rootMagic = safeU32(buf, rootOff);
  if (!AUDIO_ROOT_MAGICS[rootMagic]) warnings.push(`Unknown audio root magic ${hex(rootMagic)}.`);
  const rootNameOff = vaToOff(safeU32(buf, rootOff + 4), 1);
  const doc: AudioDocument = { baseVa, rootVa, rootOff, rootMagic, rootName: rootNameOff !== null ? readFixedString(buf, rootNameOff, 0x80) : "", blocks: [], rawAux: [], commons: [], warnings };

  const parseCurve = (key: string, label: string, ptr: number): CurveData => {
    const curve: CurveData = { key, label, ptrVa: ptr, fileOff: null, magic: 0, minX: 0, minY: 0, maxX: 0, maxY: 0, pointCount: 0, ptrPoints: 0, pointsFileOff: null, pad1C: 0, rows: [], warning: "" };
    const off = vaToOff(ptr, 0x20);
    curve.fileOff = off;
    if (off === null) { curve.warning = `Invalid curve pointer ${hex(ptr)}.`; return curve; }
    const add = (text: string) => { curve.warning = curve.warning ? `${curve.warning} ${text}` : text; };
    curve.magic = safeU32(buf, off); curve.minX = safeF32(buf, off + 4); curve.minY = safeF32(buf, off + 8); curve.maxX = safeF32(buf, off + 0xc); curve.maxY = safeF32(buf, off + 0x10);
    curve.pointCount = safeU32(buf, off + 0x14); curve.ptrPoints = safeU32(buf, off + 0x18); curve.pad1C = safeU32(buf, off + 0x1c);
    if (curve.magic !== CURVE_MAGIC) curve.warning = `Unexpected curve magic ${hex(curve.magic)}.`;
    if (curve.pointCount > 64) { add(`Suspicious ActiveSeriesCount=${curve.pointCount}.`); return curve; }
    let points = vaToOff(curve.ptrPoints, Math.max(0, curve.pointCount) * CURVE_POINT_SIZE);
    if (points === null) {
      const fallback = off + 0x20;
      if (inRange(buf, fallback, Math.max(0, curve.pointCount) * CURVE_POINT_SIZE)) { points = fallback; add("ptr_points invalid; used curve+0x20 fallback."); }
      else { add(`Invalid ptr_points=${hex(curve.ptrPoints)}.`); return curve; }
    }
    curve.pointsFileOff = points;
    for (let i = 0; i < curve.pointCount; i += 1) {
      const rowOff = points + i * CURVE_POINT_SIZE;
      if (!inRange(buf, rowOff, CURVE_POINT_SIZE)) { add(`Point row ${i} out of range.`); break; }
      curve.rows.push(Array.from({ length: CURVE_POINT_FLOATS }, (_, j) => safeF32(buf, rowOff + j * 4)));
    }
    return curve;
  };

  for (const pointer of ROOT_POINTERS) {
    const ptr = safeU32(buf, rootOff + pointer.rel);
    const fileOff = vaToOff(ptr, 4);
    if (fileOff === null) continue;
    if (pointer.kind === "block") {
      const blockWarnings: string[] = [];
      if (!inRange(buf, fileOff, 0xa0)) blockWarnings.push("AudioBlockFull extends outside file range.");
      const magic = safeU32(buf, fileOff);
      if (!AUDIO_BLOCK_MAGICS[magic]) blockWarnings.push(`Unexpected AudioBlockFull magic ${hex(magic)}.`);
      const activeRangeCount = safeU32(buf, fileOff + 0x34);
      const ptrRangeTable = safeU32(buf, fileOff + 0x38);
      let tableOff = vaToOff(ptrRangeTable, RANGE_ENTRY_SIZE);
      const expected = fileOff + RANGE_TABLE_REL_FALLBACK;
      if (tableOff === null && inRange(buf, expected, RANGE_ENTRY_SIZE)) { tableOff = expected; blockWarnings.push("ptr_range_table invalid; used fixed AudioBlockFull+0xA0 range table fallback."); }
      const ranges: AudioRange[] = [];
      if (tableOff !== null) {
        for (let i = 0; i < RANGE_ALLOCATED_COUNT; i += 1) {
          const r = tableOff + i * RANGE_ENTRY_SIZE;
          if (!inRange(buf, r, RANGE_ENTRY_SIZE)) break;
          ranges.push({ index: i, fileOff: r, sampleName: readFixedString(buf, r, 0x20), minRpm: safeF32(buf, r + 0x20), maxRpm: safeF32(buf, r + 0x24), midRpm: safeF32(buf, r + 0x28), active: i < activeRangeCount });
        }
      }
      const block: AudioBlock = {
        type: "block", label: pointer.label, category: pointer.category, rootRel: pointer.rel, ptrVa: ptr, fileOff, magic,
        bankName: readFixedString(buf, fileOff + 4, 0x20), minRpmRec: safeF32(buf, fileOff + 0x24), maxRpmRec: safeF32(buf, fileOff + 0x28),
        nearDist: safeF32(buf, fileOff + 0x2c), farDist: safeF32(buf, fileOff + 0x30), activeRangeCount, ptrRangeTable, rangeTableFileOff: tableOff,
        warble: Array.from({ length: 8 }, (_, i) => safeF32(buf, fileOff + 0x3c + i * 4)), boostMixPercent: safeF32(buf, fileOff + 0x5c), boostMixRate: safeF32(buf, fileOff + 0x60),
        highPitchCurveEngageGear: safeU32(buf, fileOff + 0x64), engineRevSound: readFixedString(buf, fileOff + ENGINE_REV_SOUND_OFF, ENGINE_REV_SOUND_SIZE),
        ranges, curves: {}, warnings: blockWarnings,
      };
      for (const field of CURVE_FIELDS) {
        let curve = parseCurve(field.key, field.label, safeU32(buf, fileOff + field.ptrRel));
        const expectedCurve = fileOff + FIXED_PACKAGE_CURVE_RELS[field.key];
        if ((curve.fileOff === null || curve.magic !== CURVE_MAGIC) && inRange(buf, expectedCurve, CURVE_STORAGE_SIZE)) {
          curve = parseCurve(field.key, field.label, baseVa + expectedCurve);
          curve.warning = curve.warning ? `${curve.warning} used fixed AudioBlockFull curve-offset fallback.` : "used fixed AudioBlockFull curve-offset fallback.";
        }
        block.curves[field.key] = curve;
      }
      doc.blocks.push(block);
    } else if (pointer.kind === "common") {
      const magic = safeU32(buf, fileOff);
      doc.commons.push({ type: "common", label: pointer.label, category: pointer.category, rootRel: pointer.rel, ptrVa: ptr, fileOff, magic, params: Array.from({ length: 22 }, (_, i) => safeF32(buf, fileOff + 4 + i * 4)), unk5C: safeU32(buf, fileOff + 0x5c), warnings: COMMON_MAGICS[magic] ? [] : [`Unexpected common magic ${hex(magic)}.`] });
    } else {
      const preview = pointer.kind === "raw_bundle" ? 0x200 : 0x100;
      const entries = readLooseStringEntries(buf, fileOff + 4, preview);
      const found: string[] = []; for (const entry of entries) if (entry.text && !found.includes(entry.text)) found.push(entry.text);
      doc.rawAux.push({
        type: "raw", label: pointer.label, category: pointer.category, rootRel: pointer.rel, ptrVa: ptr, fileOff, kind: pointer.kind, magic: safeU32(buf, fileOff),
        possibleName0: readFixedString(buf, fileOff + 4, 0x20), possibleName1: readFixedString(buf, fileOff + 0x24, 0x20),
        foundStrings: found, foundStringEntries: entries, floatPreview: rawFloatPreview(buf, fileOff, Math.min(preview, 0x120)), warnings: [],
      });
    }
  }
  const order: Record<string, number> = { Engine: 0, Exhaust: 1, TurboBlower: 2 };
  doc.blocks.sort((a, b) => (order[a.category] ?? 99) - (order[b.category] ?? 99) || a.rootRel - b.rootRel);
  // The script sorts raw blocks by (category, root_rel) with its full "Auxiliary / X" names.
  doc.rawAux.sort((a, b) => (a.category < b.category ? -1 : a.category > b.category ? 1 : a.rootRel - b.rootRel));
  doc.commons.sort((a, b) => a.rootRel - b.rootRel);
  return doc;
}

export function hex(value: number | null, width = 8) { return value === null ? "-" : `0x${(value >>> 0).toString(16).toUpperCase().padStart(width, "0")}`; }

// ---------------------------------------------------------------------------------------------
// Curves

function curveCapacity(bufLength: number, curve: CurveData) {
  if (curve.fileOff === null || curve.pointsFileOff === null) return Math.max(0, curve.rows.length);
  const recordEnd = Math.min(bufLength, curve.fileOff + CURVE_STORAGE_SIZE);
  if (curve.pointsFileOff < curve.fileOff + CURVE_HEADER_SIZE || curve.pointsFileOff >= recordEnd) return Math.max(0, curve.rows.length);
  return Math.max(0, Math.floor((recordEnd - curve.pointsFileOff) / CURVE_POINT_SIZE));
}
const evalRow = (row: number[], x: number) => row.length >= CURVE_POINT_FLOATS ? row[6] * x * x + row[7] * x + row[8] : row.length >= 2 ? row[1] : 0;
function evalPiecewise(rows: number[][], x: number) {
  const usable = rows.filter((r) => r.length >= CURVE_POINT_FLOATS);
  if (!usable.length) return 0;
  for (const r of usable) { const lo = Math.min(r[0], r[4]); const hi = Math.max(r[0], r[4]); if (lo - 1e-6 <= x && x <= hi + 1e-6) return evalRow(r, x); }
  const first = usable[0]; const last = usable[usable.length - 1];
  return x < Math.min(first[0], first[4]) ? first[1] : last[5];
}
export function fitQuadratic(x0: number, y0: number, xm: number, ym: number, x1: number, y1: number): [number, number, number] {
  if (Math.abs(x0 - xm) < 1e-7 || Math.abs(xm - x1) < 1e-7 || Math.abs(x0 - x1) < 1e-7) {
    if (Math.abs(x1 - x0) < 1e-7) return [0, 0, y0];
    const b = (y1 - y0) / (x1 - x0); return [0, b, y0 - b * x0];
  }
  const d0 = (x0 - xm) * (x0 - x1); const dm = (xm - x0) * (xm - x1); const d1 = (x1 - x0) * (x1 - xm);
  const a = y0 / d0 + ym / dm + y1 / d1;
  const b = -y0 * (xm + x1) / d0 - ym * (x0 + x1) / dm - y1 * (x0 + xm) / d1;
  const c = y0 * xm * x1 / d0 + ym * x0 * x1 / dm + y1 * x0 * xm / d1;
  return [a, b, c];
}
function resampleCurveRows(source: number[][], targetCount: number) {
  const usable = source.filter((r) => r.length >= CURVE_POINT_FLOATS);
  if (targetCount <= 0 || !usable.length) return [];
  if (targetCount === usable.length) return usable.map((r) => r.slice(0, CURVE_POINT_FLOATS));
  const start = usable[0][0]; let end = usable[usable.length - 1][4];
  if (Math.abs(end - start) < 1e-7) end = start + 1;
  return Array.from({ length: targetCount }, (_, i) => {
    const x0 = start + (end - start) * (i / targetCount); const x1 = start + (end - start) * ((i + 1) / targetCount); const xm = (x0 + x1) * 0.5;
    const y0 = evalPiecewise(usable, x0); const ym = evalPiecewise(usable, xm); const y1 = evalPiecewise(usable, x1);
    return [x0, y0, xm, ym, x1, y1, ...fitQuadratic(x0, y0, xm, ym, x1, y1)];
  });
}
function packCurveRow(row: number[]) {
  const out = new Uint8Array(CURVE_POINT_SIZE); const view = dv(out);
  for (let i = 0; i < CURVE_POINT_FLOATS; i += 1) view.setFloat32(i * 4, row[i], true);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Curve editing — the script's graph and row-table rules. A row is one span:
// (x0,y0) start, (cx,cy) control, (x1,y1) end, then y = A·x² + B·x + C fitted through the three.
// Knot 0 is row 0's start and knot i is row i-1's end (= row i's start). Every function returns new
// rows and leaves its input alone; `curveEditWrites` turns them into bytes.

export const CURVE_COLORS: Record<string, string> = { volume_curve: "#7EC8FF", pitch_curve: "#9DFF8F", high_pitch_curve: "#E6C85C", upshift_curve: "#D596FF", downshift_curve: "#FF9C7E" };
export { evalRow as evalCurveRow, curveCapacity };
export const curveRowValid = (row: number[]) => row.length >= CURVE_POINT_FLOATS && row.slice(0, CURVE_POINT_FLOATS).every(Number.isFinite);
export const activeCurveRows = (curve: CurveData) => curve.rows.slice(0, Math.max(0, curve.pointCount));
const copyRows = (rows: number[][]) => rows.map((row) => row.slice());
const refit = (row: number[]) => { if (row.length < CURVE_POINT_FLOATS) return; const [a, b, c] = fitQuadratic(row[0], row[1], row[2], row[3], row[4], row[5]); row[6] = a; row[7] = b; row[8] = c; };
const rowFromPoints = (x0: number, y0: number, cx: number, cy: number, x1: number, y1: number) => [x0, y0, cx, cy, x1, y1, ...fitQuadratic(x0, y0, cx, cy, x1, y1)];

/** Points along one span: the polynomial, or the straight start→end line in "linear" mode. */
export function sampleCurveRow(row: number[], steps = 32, mode: "poly" | "linear" = "poly"): [number, number][] {
  if (!curveRowValid(row)) return [];
  const [x0, y0, , , x1, y1, a, b, c] = row;
  if (Math.abs(x0 - x1) <= 1e-9 * Math.max(Math.abs(x0), Math.abs(x1))) return [[x0, mode === "linear" ? y0 : a * x0 * x0 + b * x0 + c]];
  const n = Math.max(2, Math.floor(steps)); const out: [number, number][] = [];
  for (let i = 0; i <= n; i += 1) {
    const t = i / n; const x = x0 + (x1 - x0) * t; const y = mode === "linear" ? y0 + (y1 - y0) * t : a * x * x + b * x + c;
    if (Number.isFinite(x) && Number.isFinite(y)) out.push([x, y]);
  }
  return out;
}
export function curveKnots(rows: number[][]): [number, number, number][] {
  const out: [number, number, number][] = [];
  rows.forEach((row, i) => { if (!curveRowValid(row)) return; if (i === 0) out.push([0, row[0], row[1]]); out.push([i + 1, row[4], row[5]]); });
  return out;
}

/**
 * A row-table cell. Moving a start or end also moves the neighbouring row's matching end or start,
 * so the curve stays continuous; points refit A/B/C, while A/B/C themselves are written as typed.
 */
export function editCurveField(rows: number[][], rowIndex: number, field: number, value: number) {
  if (!Number.isFinite(value)) throw new Error("Value must be finite.");
  const out = copyRows(rows); const row = out[rowIndex];
  if (!row) throw new Error(`Row ${rowIndex} is not active.`);
  row[field] = value;
  if (field > 5) return out;
  refit(row);
  if ((field === 0 || field === 1) && rowIndex > 0) { out[rowIndex - 1][field + 4] = value; refit(out[rowIndex - 1]); }
  if ((field === 4 || field === 5) && rowIndex + 1 < out.length) { out[rowIndex + 1][field - 4] = value; refit(out[rowIndex + 1]); }
  return out;
}
/** Drags knot `point`, carrying the control handles on either side along with it. */
export function moveCurveKnot(rows: number[][], point: number, x: number, y: number) {
  const out = copyRows(rows); const count = out.length;
  if (!count) return out;
  const old = point <= 0 ? [out[0][0], out[0][1]] : point - 1 < count ? [out[point - 1][4], out[point - 1][5]] : null;
  const dx = old ? x - old[0] : 0; const dy = old ? y - old[1] : 0;
  const touched = new Set<number>();
  if (Math.abs(dx) > 1e-12 || Math.abs(dy) > 1e-12) for (const r of [point - 1, point]) if (r >= 0 && r < count && curveRowValid(out[r])) { out[r][2] += dx; out[r][3] += dy; touched.add(r); }
  if (point <= 0) { out[0][0] = x; out[0][1] = y; touched.add(0); }
  else {
    if (point - 1 < count) { out[point - 1][4] = x; out[point - 1][5] = y; touched.add(point - 1); }
    if (point < count) { out[point][0] = x; out[point][1] = y; touched.add(point); }
  }
  for (const r of touched) refit(out[r]);
  return out;
}
export function moveCurveControl(rows: number[][], rowIndex: number, x: number, y: number) {
  const out = copyRows(rows); const row = out[rowIndex];
  if (!row) return out;
  row[2] = x; row[3] = y; refit(row);
  return out;
}
/** Splits span `rowIndex` at x, keeping both halves on the old curve. Needs a free row of storage. */
export function insertCurvePoint(rows: number[][], capacity: number, rowIndex: number, x: number, y: number) {
  if (rows.length >= capacity) throw new Error(`This curve's storage is full (${capacity} rows).`);
  const row = rows[rowIndex];
  if (!row || !curveRowValid(row)) throw new Error("That span can't be split.");
  const [x0, y0, , , x1, y1] = row;
  const nx = Math.max(Math.min(x0, x1), Math.min(x, Math.max(x0, x1)));
  if (Math.abs(nx - x0) < 1e-6 || Math.abs(nx - x1) < 1e-6) throw new Error("Too close to an existing point — insert farther from it.");
  const lm = (x0 + nx) * 0.5; const rm = (nx + x1) * 0.5;
  const out = copyRows(rows);
  out.splice(rowIndex, 1, rowFromPoints(x0, y0, lm, evalRow(row, lm), nx, y), rowFromPoints(nx, y, rm, evalRow(row, rm), x1, y1));
  return out;
}
/** Removes knot `point`: an end knot drops its span, an inner knot merges its two spans into one. */
export function deleteCurvePoint(rows: number[][], point: number) {
  const count = rows.length;
  if (count <= 1) throw new Error("A curve keeps at least one span.");
  const out = copyRows(rows);
  if (point <= 0) out.splice(0, 1);
  else if (point >= count) out.splice(count - 1, 1);
  else {
    const left = out[point - 1]; const right = out[point];
    if (!curveRowValid(left) || !curveRowValid(right)) throw new Error("Those spans can't be merged.");
    const cx = (left[0] + right[4]) * 0.5;
    out.splice(point - 1, 2, rowFromPoints(left[0], left[1], cx, evalPiecewise([left, right], cx), right[4], right[5]));
  }
  return out;
}
/** Bytes that make `curve` hold `rows`: the ActiveSeriesCount at +0x14 and each row in place. */
export function curveEditWrites(bufLength: number, curve: CurveData, rows: number[][]) {
  if (curve.fileOff === null || curve.pointsFileOff === null) throw new Error(`${curve.label} has no writable storage.`);
  const capacity = curveCapacity(bufLength, curve);
  if (rows.length > capacity) throw new Error(`${curve.label} holds ${capacity} rows at most.`);
  const writes: { offset: number; bytes: Uint8Array }[] = [];
  if (rows.length !== curve.pointCount) { const count = new Uint8Array(4); dv(count).setUint32(0, rows.length, true); writes.push({ offset: curve.fileOff + 0x14, bytes: count }); }
  rows.forEach((row, i) => writes.push({ offset: curve.pointsFileOff! + i * CURVE_POINT_SIZE, bytes: packCurveRow(row) }));
  return writes;
}

/** The script's clipboard format, so curves copy between this app and the Audio Curve GUI. */
export const CURVE_CLIPBOARD_FORMAT = "MC3_AUDIO_CURVE_ROWS_V1";
export function curvesToClipboard(block: AudioBlock, keys: string[], sourceName: string) {
  const curves: Record<string, { label: string; point_count: number; rows: number[][] }> = {};
  for (const key of keys) { const c = block.curves[key]; if (c && c.rows.length) curves[key] = { label: c.label, point_count: c.pointCount, rows: activeCurveRows(c) }; }
  return JSON.stringify({ format: CURVE_CLIPBOARD_FORMAT, source_pck: sourceName, source_block: block.label, curves }, null, 2);
}
/** Rows to paste per visible curve, with the script's guards: High Pitch only where the target uses it, never past storage. */
export function curvesFromClipboard(text: string, block: AudioBlock, keys: string[], bufLength: number) {
  let payload: { curves?: Record<string, { rows?: unknown }> };
  try { payload = JSON.parse(text.trim()); } catch { throw new Error("The clipboard doesn't hold MC3 curve JSON."); }
  if (!payload || typeof payload.curves !== "object" || !payload.curves) throw new Error("The clipboard doesn't hold MC3 curve JSON.");
  const paste: { key: string; rows: number[][] }[] = []; const skipped: string[] = [];
  for (const key of keys) {
    const entry = payload.curves[key]; if (!entry) continue;
    const target = block.curves[key]; const label = CURVE_FIELDS.find((f) => f.key === key)?.label ?? key;
    if (key === "high_pitch_curve" && !(target && target.pointCount > 0)) { skipped.push(`${label}: not used by this block`); continue; }
    if (!target || target.pointsFileOff === null) { skipped.push(`${label}: no storage`); continue; }
    const rows = Array.isArray(entry.rows) ? entry.rows : [];
    const capacity = curveCapacity(bufLength, target);
    if (rows.length > capacity) { skipped.push(`${label}: ${rows.length} rows, room for ${capacity}`); continue; }
    if (!rows.every((row) => Array.isArray(row) && row.length >= CURVE_POINT_FLOATS && row.slice(0, CURVE_POINT_FLOATS).every((v) => typeof v === "number" && Number.isFinite(v)))) { skipped.push(`${label}: malformed rows`); continue; }
    paste.push({ key, rows: (rows as number[][]).map((row) => row.slice(0, CURVE_POINT_FLOATS)) });
  }
  return { paste, skipped };
}

/**
 * Where an auxiliary block's float candidates stop being safe to edit: the next structure the parser
 * knows starts there. The script's preview window (0x100 bytes) often reaches past a small block
 * into its neighbour, and a write there would land in someone else's data.
 */
export function auxEditLimit(doc: AudioDocument, raw: RawAuxBlock, bufLength: number) {
  const starts = [doc.rootOff];
  for (const b of doc.blocks) { starts.push(b.fileOff); if (b.rangeTableFileOff !== null) starts.push(b.rangeTableFileOff); for (const f of CURVE_FIELDS) { const c = b.curves[f.key]; if (c?.fileOff != null) starts.push(c.fileOff); } }
  for (const r of doc.rawAux) starts.push(r.fileOff);
  for (const c of doc.commons) starts.push(c.fileOff);
  return starts.filter((s) => s > raw.fileOff).reduce((min, s) => Math.min(min, s), bufLength);
}

// ---------------------------------------------------------------------------------------------
// Donor pairing and imports

const isMainSlot = (block: AudioBlock) => MAIN_SLOT_RELS.has(block.rootRel) && (block.category === "Engine" || block.category === "Exhaust");
function pairKey(block: AudioBlock) {
  if (isMainSlot(block)) { const role = blockRole(block); if (role === "ENGINE samples") return "role|ENGINE"; if (role === "TAIL samples") return "role|TAIL"; }
  return `rel|${block.rootRel}`;
}
export type BlockPair = { donor: AudioBlock; target: AudioBlock; mode: "role" | "root_rel" | "fallback_root_rel" };
/** `pair_audio_blocks_for_import`: Engine/Exhaust by detected ENGINE/TAIL role, ordinal within the role. */
export function pairBlocks(donorBlocks: AudioBlock[], targetBlocks: AudioBlock[]) {
  const bySlot = (a: AudioBlock, b: AudioBlock) => a.rootRel - b.rootRel || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0);
  const groups = new Map<string, AudioBlock[]>();
  for (const block of [...donorBlocks].sort(bySlot)) groups.set(pairKey(block), [...(groups.get(pairKey(block)) ?? []), block]);
  const ordinals = new Map<string, number>(); const byRel = new Map(donorBlocks.map((b) => [b.rootRel, b]));
  const used = new Set<AudioBlock>(); const pairs: BlockPair[] = []; const warnings: string[] = [];
  const stats = { role_matched: 0, root_rel_matched: 0, fallback_root_rel: 0, unmatched: 0 };
  for (const target of [...targetBlocks].sort(bySlot)) {
    const key = pairKey(target); const index = ordinals.get(key) ?? 0; ordinals.set(key, index + 1);
    let donor: AudioBlock | null = null; let mode: BlockPair["mode"] | null = null;
    const candidates = groups.get(key) ?? [];
    if (index < candidates.length) { donor = candidates[index]; mode = key.startsWith("role|") ? "role" : "root_rel"; }
    else { const relDonor = byRel.get(target.rootRel); if (relDonor && !used.has(relDonor)) { donor = relDonor; mode = "fallback_root_rel"; } }
    if (!donor || !mode) { stats.unmatched += 1; warnings.push(`No donor AudioBlockFull match for ${target.label}.`); continue; }
    used.add(donor);
    if (mode === "role") stats.role_matched += 1; else if (mode === "root_rel") stats.root_rel_matched += 1;
    else { stats.fallback_root_rel += 1; warnings.push(`${target.label}: role match missing; used root-relative fallback to ${donor.label}.`); }
    pairs.push({ donor, target, mode });
  }
  return { pairs, stats, warnings };
}

export type ImportReport = { counts: Record<string, number>; warnings: string[] };

/**
 * `import_audio_from_document` — the Conservative import: bank name plus sample prefix, auxiliary
 * name strings, engine/exhaust RPMs of the active ranges, and the upshift/downshift event curves.
 * Writes into `target` in place; `targetDoc` must be its parse from before the import.
 */
export function importConservative(target: Uint8Array, targetDoc: AudioDocument, donor: Uint8Array, donorDoc: AudioDocument): ImportReport {
  const counts: Record<string, number> = { block_changed: 0, sample_changed: 0, aux_changed: 0, rpm_changed: 0, shift_curve_changed: 0, pair_role_matched: 0, pair_root_rel_matched: 0, pair_fallback_root_rel: 0, skipped: 0 };
  const warnings: string[] = [];
  const copyShiftCurve = (dc: CurveData, tc: CurveData, name: string, label: string) => {
    if (tc.fileOff === null || dc.fileOff === null) { counts.skipped += 1; return; }
    if (tc.magic !== dc.magic) { counts.skipped += 1; warnings.push(`${label}/${name}: curve magic differs; shift curve skipped.`); return; }
    if (tc.pointsFileOff === null || dc.pointsFileOff === null) { if (dc.pointCount || tc.pointCount) warnings.push(`${label}/${name}: missing point table; shift curve rows skipped.`); counts.skipped += 1; return; }
    for (const [rel, size] of [[0x04, 0x10], [0x1c, 0x04]]) {
      const raw = donor.slice(dc.fileOff + rel, dc.fileOff + rel + size);
      if (!sameSlice(target, tc.fileOff + rel, raw)) { target.set(raw, tc.fileOff + rel); counts.shift_curve_changed += 1; }
    }
    const donorCount = Math.max(0, dc.pointCount);
    const capacity = curveCapacity(target.length, tc);
    const donorRows = dc.rows.slice(0, Math.min(donorCount, dc.rows.length));
    if (capacity <= 0) { if (donorCount) { counts.skipped += 1; warnings.push(`${label}/${name}: target has zero writable curve row capacity; shift rows skipped.`); } return; }
    let rows = donorRows.map((r) => r.slice(0, CURVE_POINT_FLOATS)); let count = donorCount;
    if (donorCount > capacity) { rows = resampleCurveRows(donorRows, capacity); count = capacity; counts.skipped += 1; warnings.push(`${label}/${name}: donor has ${donorCount} rows, target capacity ${capacity}; resampled.`); }
    if (safeU32(target, tc.fileOff + 0x14) !== count) { writeU32(target, tc.fileOff + 0x14, count); counts.shift_curve_changed += 1; }
    rows.forEach((row, i) => { const dst = tc.pointsFileOff! + i * CURVE_POINT_SIZE; const raw = packCurveRow(row); if (!sameSlice(target, dst, raw)) { target.set(raw, dst); counts.shift_curve_changed += 1; } });
  };

  const { pairs, stats, warnings: pairWarnings } = pairBlocks(donorDoc.blocks, targetDoc.blocks);
  counts.pair_role_matched = stats.role_matched; counts.pair_root_rel_matched = stats.root_rel_matched; counts.pair_fallback_root_rel = stats.fallback_root_rel; counts.skipped += stats.unmatched;
  warnings.push(...pairWarnings);
  for (const { donor: d, target: t } of pairs) {
    const donorBank = (d.bankName ?? "").trim();
    if (donorBank && readFixedString(target, t.fileOff + 4, 0x20) !== donorBank) { target.set(encodeFixedString(donorBank), t.fileOff + 4); counts.block_changed += 1; }
    const commonActive = Math.min(Math.max(0, t.activeRangeCount), Math.max(0, d.activeRangeCount), t.ranges.length, d.ranges.length);
    for (let i = 0; i < commonActive; i += 1) {
      const range = t.ranges[i]; const old = readFixedString(target, range.fileOff, 0x20); const next = replaceSamplePrefix(old, donorBank);
      if (next !== old) { target.set(encodeFixedString(next), range.fileOff); counts.sample_changed += 1; }
    }
    if (MAIN_SLOT_RELS.has(t.rootRel) && MAIN_SLOT_RELS.has(d.rootRel)) {
      for (const rel of [0x24, 0x28]) { const value = safeF32(donor, d.fileOff + rel); if (value > 0 && safeF32(target, t.fileOff + rel) !== value) { writeF32(target, t.fileOff + rel, value); counts.rpm_changed += 1; } }
      for (let i = 0; i < commonActive; i += 1) for (const rel of [0x20, 0x24, 0x28]) {
        const value = safeF32(donor, d.ranges[i].fileOff + rel);
        if (value > 0 && safeF32(target, t.ranges[i].fileOff + rel) !== value) { writeF32(target, t.ranges[i].fileOff + rel, value); counts.rpm_changed += 1; }
      }
    }
    for (const key of ["upshift_curve", "downshift_curve"]) { const tc = t.curves[key]; const dc = d.curves[key]; if (tc && dc) copyShiftCurve(dc, tc, key, t.label); }
  }
  const donorRaw = new Map(donorDoc.rawAux.map((r) => [r.rootRel, r]));
  for (const tr of targetDoc.rawAux) {
    const dr = donorRaw.get(tr.rootRel); if (!dr) continue;
    for (const [rel, text] of iterFixedAudioStrings(donor, dr.fileOff, auxScanSize(dr.magic))) {
      const dst = tr.fileOff + rel;
      if (dst + 0x20 > target.length) { counts.skipped += 1; continue; }
      if (!isProbableFixedAudioString(target, dst, 0x20)) continue;
      if (readFixedString(target, dst, 0x20) !== text) { target.set(encodeFixedString(text), dst); counts.aux_changed += 1; }
    }
  }
  return { counts, warnings };
}

/**
 * `import_audio_from_document_experimental` — copies the most the script can address without
 * moving anything: exact bank and range fields, block scalars, curve headers and rows (High Pitch
 * only when both sides use it), auxiliary strings and floats, and Common parameters. Pointers are
 * never copied.
 */
export function importExperimental(target: Uint8Array, targetDoc: AudioDocument, donor: Uint8Array, donorDoc: AudioDocument): ImportReport {
  const counts: Record<string, number> = { block_changed: 0, range_changed: 0, curve_header_changed: 0, curve_row_changed: 0, aux_string_changed: 0, aux_float_changed: 0, common_changed: 0, high_pitch_guarded: 0, high_pitch_skipped_target_empty: 0, curve_count_expanded: 0, curve_resampled: 0, pair_role_matched: 0, pair_root_rel_matched: 0, pair_fallback_root_rel: 0, skipped: 0 };
  const warnings: string[] = [];
  const writeBytes = (dst: number, raw: Uint8Array, counter: string) => {
    if (dst < 0 || dst + raw.length > target.length) { counts.skipped += 1; return; }
    if (!sameSlice(target, dst, raw)) { target.set(raw, dst); counts[counter] += 1; }
  };
  const { pairs, stats, warnings: pairWarnings } = pairBlocks(donorDoc.blocks, targetDoc.blocks);
  counts.pair_role_matched = stats.role_matched; counts.pair_root_rel_matched = stats.root_rel_matched; counts.pair_fallback_root_rel = stats.fallback_root_rel; counts.skipped += stats.unmatched;
  warnings.push(...pairWarnings);
  for (const { donor: d, target: t } of pairs) {
    if (t.magic !== d.magic) { warnings.push(`${t.label}: AudioBlockFull magic differs; skipped.`); counts.skipped += 1; continue; }
    writeBytes(t.fileOff + 4, donor.slice(d.fileOff + 4, d.fileOff + 0x24), "block_changed");
    const donorHigh = (d.curves.high_pitch_curve?.pointCount ?? 0) > 0;
    const targetHigh = (t.curves.high_pitch_curve?.pointCount ?? 0) > 0;
    const copyHigh = donorHigh && targetHigh;
    const scalars: [number, number][] = [[0x24, 0x10], [0x34, 0x04], [0x3c, copyHigh ? 0x2c : 0x28], [ENGINE_REV_SOUND_OFF, ENGINE_REV_SOUND_SIZE], [0x9c, 0x04]];
    if (!copyHigh && targetHigh && !donorHigh) { counts.high_pitch_guarded += 1; warnings.push(`${t.label}: donor High Pitch curve is empty; kept the target's.`); }
    else if (!copyHigh && donorHigh && !targetHigh) { counts.high_pitch_skipped_target_empty += 1; warnings.push(`${t.label}: target has no active High Pitch curve; skipped the donor's.`); }
    for (const [rel, size] of scalars) writeBytes(t.fileOff + rel, donor.slice(d.fileOff + rel, d.fileOff + rel + size), "block_changed");
    const commonRanges = Math.min(t.ranges.length, d.ranges.length);
    if (commonRanges < d.ranges.length) warnings.push(`${t.label}: target has only ${commonRanges}/${d.ranges.length} range rows; partial range copy.`);
    for (let i = 0; i < commonRanges; i += 1) writeBytes(t.ranges[i].fileOff, donor.slice(d.ranges[i].fileOff, d.ranges[i].fileOff + RANGE_ENTRY_SIZE), "range_changed");
    for (const field of CURVE_FIELDS) {
      const tc = t.curves[field.key]; const dc = d.curves[field.key];
      if (!tc || !dc || tc.fileOff === null || dc.fileOff === null) continue;
      if (field.key === "high_pitch_curve" && !copyHigh) continue;
      if (tc.magic !== dc.magic) { warnings.push(`${t.label}/${field.key}: curve magic differs; skipped.`); counts.skipped += 1; continue; }
      for (const [rel, size] of [[0x04, 0x10], [0x1c, 0x04]]) writeBytes(tc.fileOff + rel, donor.slice(dc.fileOff + rel, dc.fileOff + rel + size), "curve_header_changed");
      const capacity = curveCapacity(target.length, tc); const donorCount = Math.max(0, dc.pointCount);
      const donorRows = dc.rows.slice(0, Math.min(donorCount, dc.rows.length));
      if (tc.pointsFileOff === null || dc.pointsFileOff === null) { if (donorCount || capacity) warnings.push(`${t.label}/${field.key}: missing point table; rows skipped.`); continue; }
      if (capacity <= 0) { if (donorCount) { warnings.push(`${t.label}/${field.key}: target has no curve row capacity; rows skipped.`); counts.skipped += 1; } continue; }
      let rows: number[][]; let count: number;
      if (donorCount <= capacity) { rows = donorRows.map((r) => r.slice(0, CURVE_POINT_FLOATS)); count = donorCount; if (donorCount > tc.pointCount) { counts.curve_count_expanded += 1; warnings.push(`${t.label}/${field.key}: active rows ${tc.pointCount} expanded to ${donorCount} within capacity ${capacity}.`); } }
      else { count = capacity; rows = resampleCurveRows(donorRows, count); counts.curve_resampled += 1; warnings.push(`${t.label}/${field.key}: donor has ${donorCount} rows, capacity ${capacity}; resampled.`); }
      if (safeU32(target, tc.fileOff + 0x14) !== (count >>> 0)) { writeU32(target, tc.fileOff + 0x14, count); counts.curve_header_changed += 1; }
      rows.forEach((row, i) => writeBytes(tc.pointsFileOff! + i * CURVE_POINT_SIZE, packCurveRow(row), "curve_row_changed"));
    }
  }
  const donorRaw = new Map(donorDoc.rawAux.map((r) => [r.rootRel, r]));
  for (const tr of targetDoc.rawAux) {
    const dr = donorRaw.get(tr.rootRel); if (!dr) continue;
    if (tr.magic !== dr.magic) warnings.push(`${tr.label}: raw aux magic differs; skipped aux float copy.`);
    for (const [rel, text] of iterFixedAudioStrings(donor, dr.fileOff, auxScanSize(dr.magic))) {
      const dst = tr.fileOff + rel;
      if (dst + 0x20 > target.length) { counts.skipped += 1; continue; }
      if (!isProbableFixedAudioString(target, dst, 0x20)) continue;
      writeBytes(dst, encodeFixedString(text), "aux_string_changed");
    }
    if (tr.magic === dr.magic) {
      for (const entry of dr.floatPreview) {
        if (entry.relOff < 4) continue;
        const dst = tr.fileOff + entry.relOff;
        if (dst + 4 > target.length) { counts.skipped += 1; continue; }
        // The script checks this against string entries measured from +0x04, not from the block start.
        const inString = tr.foundStringEntries.some((s) => s.relOff <= entry.relOff && entry.relOff < s.relOff + Math.min(0x20, s.text.length + 1));
        if (inString) continue;
        if (!Number.isFinite(entry.value)) { counts.skipped += 1; continue; }
        if (safeF32(target, dst) !== entry.value) { writeF32(target, dst, entry.value); counts.aux_float_changed += 1; }
      }
    }
  }
  const donorCommons = new Map(donorDoc.commons.map((c) => [c.rootRel, c]));
  for (const tc of targetDoc.commons) {
    const dc = donorCommons.get(tc.rootRel); if (!dc) continue;
    if (tc.magic !== dc.magic) { warnings.push(`${tc.label}: common magic differs; skipped.`); counts.skipped += 1; continue; }
    writeBytes(tc.fileOff + 4, donor.slice(dc.fileOff + 4, dc.fileOff + 0x60), "common_changed");
  }
  return { counts, warnings };
}

// ---------------------------------------------------------------------------------------------
// Comparing PCKs, and carrying an edit from one to another

/** Everything audible about a block, pointers and file positions left out. */
function blockSignature(buf: Uint8Array, block: AudioBlock) {
  const parts: unknown[] = [block.magic, block.bankName, block.minRpmRec, block.maxRpmRec, block.nearDist, block.farDist, block.activeRangeCount, block.warble, block.boostMixPercent, block.boostMixRate, block.highPitchCurveEngageGear, block.engineRevSound];
  for (const range of block.ranges) parts.push([range.sampleName, range.minRpm, range.maxRpm, range.midRpm]);
  for (const field of CURVE_FIELDS) { const c = block.curves[field.key]; parts.push(c ? [c.magic, c.minX, c.minY, c.maxX, c.maxY, c.pointCount, c.pad1C, c.rows] : null); }
  void buf;
  return JSON.stringify(parts);
}
/**
 * An auxiliary block is compared by its name strings only. Its floats aren't mapped (the script
 * treats them as research data), and even the script's per-magic scan sizes can overrun the real
 * structure — Suspension's 0xB0 runs into the next object, whose bytes differ between PCKs.
 */
function rawSignature(buf: Uint8Array, raw: RawAuxBlock) {
  return JSON.stringify([raw.magic, iterFixedAudioStrings(buf, raw.fileOff, auxScanSize(raw.magic))]);
}
function commonSignature(common: CommonBlock) { return JSON.stringify([common.magic, common.params, common.unk5C]); }

export type SyncState = "same" | "subset" | "own";
/**
 * How a role's audio relates to the Player's: identical ("same" — a mod that copied the Player PCK),
 * a subset whose every shared structure is identical ("subset" — a stock Garage), or its own
 * ("own" — a stock Opponent, or any other difference).
 */
export function compareToPlayer(player: { buf: Uint8Array; doc: AudioDocument }, other: { buf: Uint8Array; doc: AudioDocument }): SyncState {
  const pb = new Map(player.doc.blocks.map((b) => [b.rootRel, blockSignature(player.buf, b)]));
  const pr = new Map(player.doc.rawAux.map((r) => [r.rootRel, rawSignature(player.buf, r)]));
  const pc = new Map(player.doc.commons.map((c) => [c.rootRel, commonSignature(c)]));
  let missing = false;
  for (const b of other.doc.blocks) { const s = pb.get(b.rootRel); if (s === undefined || s !== blockSignature(other.buf, b)) return "own"; }
  for (const r of other.doc.rawAux) { const s = pr.get(r.rootRel); if (s === undefined || s !== rawSignature(other.buf, r)) return "own"; }
  for (const c of other.doc.commons) { const s = pc.get(c.rootRel); if (s === undefined || s !== commonSignature(c)) return "own"; }
  if (other.doc.blocks.length < player.doc.blocks.length || other.doc.rawAux.length < player.doc.rawAux.length || other.doc.commons.length < player.doc.commons.length) missing = true;
  return missing ? "subset" : "same";
}

/** Where a file offset sits, in terms that exist in any PCK: which structure and how far into it. */
/**
 * A curve location also records where its rows sit within the record, so a write only carries over
 * to a PCK whose curve is laid out the same way.
 */
export type AudioLocation = { kind: "block" | "range" | "curve" | "raw" | "common"; rootRel: number; part?: string | number; rel: number; layout?: number };
export function locateOffset(doc: AudioDocument, offset: number): AudioLocation | null {
  for (const block of doc.blocks) {
    if (offset >= block.fileOff && offset < block.fileOff + 0xa0) return { kind: "block", rootRel: block.rootRel, rel: offset - block.fileOff };
    for (const range of block.ranges) if (offset >= range.fileOff && offset < range.fileOff + RANGE_ENTRY_SIZE) return { kind: "range", rootRel: block.rootRel, part: range.index, rel: offset - range.fileOff };
    for (const field of CURVE_FIELDS) { const c = block.curves[field.key]; if (c?.fileOff != null && offset >= c.fileOff && offset < c.fileOff + CURVE_STORAGE_SIZE) return { kind: "curve", rootRel: block.rootRel, part: field.key, rel: offset - c.fileOff, layout: c.pointsFileOff === null ? undefined : c.pointsFileOff - c.fileOff }; }
  }
  for (const common of doc.commons) if (offset >= common.fileOff && offset < common.fileOff + 0x60) return { kind: "common", rootRel: common.rootRel, rel: offset - common.fileOff };
  // The nearest auxiliary block at or before the offset, so overlapping preview windows can't claim it.
  let owner: RawAuxBlock | null = null;
  for (const raw of doc.rawAux) if (raw.fileOff <= offset && offset < raw.fileOff + Math.max(auxScanSize(raw.magic), 0x200) && (!owner || raw.fileOff > owner.fileOff)) owner = raw;
  if (owner) return { kind: "raw", rootRel: owner.rootRel, rel: offset - owner.fileOff };
  return null;
}
export function resolveLocation(doc: AudioDocument, location: AudioLocation): number | null {
  if (location.kind === "raw") { const raw = doc.rawAux.find((r) => r.rootRel === location.rootRel); return raw ? raw.fileOff + location.rel : null; }
  if (location.kind === "common") { const common = doc.commons.find((c) => c.rootRel === location.rootRel); return common ? common.fileOff + location.rel : null; }
  const block = doc.blocks.find((b) => b.rootRel === location.rootRel);
  if (!block) return null;
  if (location.kind === "block") return block.fileOff + location.rel;
  if (location.kind === "range") { const range = block.ranges[location.part as number]; return range ? range.fileOff + location.rel : null; }
  const curve = block.curves[location.part as string];
  if (curve?.fileOff == null) return null;
  if (location.layout !== undefined && (curve.pointsFileOff === null || curve.pointsFileOff - curve.fileOff !== location.layout)) return null;
  return curve.fileOff + location.rel;
}
