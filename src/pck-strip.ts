/**
 * Car PCK Cleaner — physically removes embedded meshes from a car PCK and closes the gaps.
 *
 * A port of `mc3_pck_strip_internal_meshes.py` v6 (PCK Stripper), kept byte-for-byte identical to
 * it: every output was compared with the Python tool's on all 67 player and 68 garage PCKs of the
 * 0x007A9420 family, and the Python output was validated in game (SRT4, Murcielago).
 *
 * This is the one place outside `PckDocument` that moves data in the middle of a car PCK.
 * `PckDocument.compactToolBlocks` only ever moves blocks it appended itself, whose pointers it
 * knows. Removing a mesh the game shipped means shifting everything after it and fixing every
 * pointer into the shifted region, and the file has no relocation table, so:
 *
 * - A cut covers exactly the removed mesh's own structure, found by walking it: header, material
 *   table, group table, block-info tables, geometry packets, and the 0x80 standalone header when
 *   the piece was injected whole. Plus unreferenced CD/00 padding, with every cut 16-byte aligned
 *   and a multiple of 16 bytes. The first version cut "until the next known structure" and took
 *   anchor names, the anchor table header and material tables of kept pieces with it.
 * - Pointers are VA-looking DWORDs OUTSIDE every geometry packet. UV / damage / normal streams hold
 *   u16 pairs such as 0x0684xxxx that look exactly like VAs; rewriting those corrupted geometry in
 *   56 of 68 cars (same trap `scanMeshRelocs` documents).
 * - Anything a kept mesh (any LOD) or any other structure still points at is never cut, and
 *   neither are the LOD tables and mesh names. The warnings say what was kept and why.
 *
 * Standalone: no imports, and no syntax that needs transpiling, so the parity test can run this
 * exact file under `node --experimental-strip-types`.
 */

export type StripMode = "clean-base" | "shell-only";
export type StripLod = "HLOD" | "MLOD" | "LLOD";
export type StripRowStatus = "remove" | "protected" | "keep" | "external" | "llod";

export type StripRow = {
  lod: StripLod;
  index: number;
  name: string;
  /** Full u32 from the LOD ID table. */
  meshId: number;
  /** PTR_Mesh points at an embedded mesh. */
  embedded: boolean;
  status: StripRowStatus;
  /** Why a row is removed: name matches (shell, trunk, decal, tk) and/or "embedded" / "embedded-id0". */
  reasons: string[];
  /** Removed through orphan mapping: the name has PTR_Mesh 0 but its payload is still in the file. */
  orphan: boolean;
};

export type StripRange = { start: number; end: number; label: string };

export type StripResult = {
  bytes: Uint8Array;
  originalSize: number;
  newSize: number;
  rows: StripRow[];
  ranges: StripRange[];
  warnings: string[];
  meshPointersZeroed: number;
  pointerUpdates: number;
  /** Pointers outside the LOD tables that still targeted removed data. Should always be 0. */
  livePointersZeroed: number;
  /** Pointers inside leftover bytes of removed meshes (harmless). */
  deadPointersZeroed: number;
  changed: boolean;
};

export type StripOptions = {
  mode?: StripMode;
  /** Map zero-pointer names to orphan payloads left in the file, when the counts match. Default on. */
  mapZeroPointerOrphans?: boolean;
  /** Map by table order even when the orphan count doesn't match. Default off. */
  forceOrphanOrder?: boolean;
};

export class UnsupportedPckFamilyError extends Error {}

const MESH_MAGIC = 0x007a0f98;
const LOD_MAGIC = 0x007a9420;
const LOD_HDR_MAGIC = 0x007a0ef0;
const HEADER_SIZE = 0x80;
const PACKET_ALIGN = 0x10;
const STANDALONE_HDR_SIZE = 0x80;
const STANDALONE_HDR_VERSION = 0x16;
const LOD_PTR_OFFSETS: [StripLod, number][] = [["HLOD", 0x10], ["MLOD", 0x14], ["LLOD", 0x18]];
const SEARCHED_LODS: StripLod[] = ["HLOD", "MLOD"]; // LLOD is never touched.
const KNOWN_FAMILIES = new Map<number, string>([
  [0x007aa728, "DUB/Remix vehicle family (LOD header 0x007A21F8, mesh 0x007A22A0)"],
  [0x007a9620, "SL500/SL55 vehicle family"],
]);

const SPOILER_RE = /(?:^|[^a-z0-9])(spoilers?|splr|msplr)(?:[^a-z0-9]|$)/;
const TK_TOKEN_RE = /(?:^|[^a-z0-9])tk(?:[^a-z0-9]|$)/;
/** Never removed, in either mode: suspension (bikes: fork/spindle/swingarm), the shadow planes
 *  (neonglow.mesh, shadow*.mesh) and police light glows. The game breaks without them. */
export const ALWAYS_KEEP_RE = /suspension|neonglow|shadow|fork|spindle|swingarm|copglow/;

type Interval = [number, number];

type LodInfo = {
  name: StripLod;
  headerOff: number;
  count: number;
  meshPtrTableOff: number;
  namePtrTableOff: number;
  idTableOff: number;
};

type Entry = {
  lod: StripLod;
  index: number;
  meshPtrEntryOff: number;
  meshVa: number;
  meshOff: number | null;
  nameOff: number | null;
  meshId: number;
  name: string;
  reasons: string[];
  protectedName: boolean;
};

type MeshLayout = { meshOff: number; header: Interval; spans: Interval[]; packets: Interval[] };

const hex = (value: number, width = 8) => `0x${value.toString(16).toUpperCase().padStart(width, "0")}`;
const hexOff = (value: number) => `0x${value.toString(16).toUpperCase()}`;

class Bytes {
  readonly data: Uint8Array;
  private readonly view: DataView;
  constructor(data: Uint8Array) {
    this.data = data;
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }
  get size() { return this.data.byteLength; }
  u16(off: number) { return this.view.getUint16(off, true); }
  u32(off: number) { return this.view.getUint32(off, true); }
  w32(off: number, value: number) { this.view.setUint32(off, value >>> 0, true); }
  validOff(off: number) { return off >= 0 && off <= this.size - 4; }
}

/** Sorted, merged intervals with bisect lookups — mirrors the Python IntervalSet exactly. */
class IntervalSet {
  readonly iv: Interval[];
  private readonly starts: number[];
  constructor(intervals: Iterable<Interval>) {
    this.iv = mergeIntervals(intervals);
    this.starts = this.iv.map(([a]) => a);
  }
  private bisectRight(value: number) {
    let lo = 0; let hi = this.starts.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (value < this.starts[mid]) hi = mid; else lo = mid + 1; }
    return lo;
  }
  has(off: number) {
    const i = this.bisectRight(off) - 1;
    return i >= 0 && this.iv[i][0] <= off && off < this.iv[i][1];
  }
  overlaps(a: number, b: number) {
    const i = this.bisectRight(b - 1) - 1;
    return i >= 0 && this.iv[i][1] > a;
  }
}

function mergeIntervals(intervals: Iterable<Interval>): Interval[] {
  const sorted = [...intervals].filter(([a, b]) => b > a).sort((x, y) => (x[0] - y[0]) || (x[1] - y[1]));
  const out: Interval[] = [];
  for (const [a, b] of sorted) {
    if (out.length && a <= out[out.length - 1][1]) out[out.length - 1] = [out[out.length - 1][0], Math.max(out[out.length - 1][1], b)];
    else out.push([a, b]);
  }
  return out;
}

function findAllU32(file: Bytes, value: number): number[] {
  const out: number[] = [];
  for (let off = 0; off + 4 <= file.size; off += 4) if (file.u32(off) === value) out.push(off);
  return out;
}

/** ASCII up to a 00 or CD terminator, 512 bytes at most — one character per byte, like the Python
 *  tool's `decode("ascii", errors="replace")`, so the length maps back to bytes. */
function readCString(file: Bytes, off: number | null, maxLen = 512) {
  if (off === null || off < 0 || off >= file.size) return "";
  let end = off;
  const limit = Math.min(file.size, off + maxLen);
  while (end < limit && file.data[end] !== 0x00 && file.data[end] !== 0xcd) end += 1;
  let text = "";
  for (let i = off; i < end; i += 1) text += file.data[i] < 0x80 ? String.fromCharCode(file.data[i]) : "�";
  return text;
}

function checkFamily(file: Bytes, baseVa: number) {
  const lodsOff = file.size >= 0x1ac ? file.u32(0x1a8) - baseVa : -1;
  if (file.validOff(lodsOff)) {
    const magic = file.u32(lodsOff);
    const family = KNOWN_FAMILIES.get(magic);
    if (family) {
      throw new UnsupportedPckFamilyError(`Unsupported PCK family: LODs magic ${hex(magic)} (${family}). This tool only handles the 0x007A9420 layout.`);
    }
  }
}

function detectLodsMagic(file: Bytes, baseVa: number): number {
  const candidates: [number, number][] = [];
  for (const off of findAllU32(file, LOD_MAGIC)) {
    let score = 0;
    for (const [, rel] of LOD_PTR_OFFSETS) {
      const ptrOff = off + rel;
      if (!file.validOff(ptrOff)) continue;
      const o = file.u32(ptrOff) - baseVa;
      if (file.validOff(o + 4) && file.u32(o + 4) === LOD_HDR_MAGIC) score += 1;
    }
    if (score >= 2) candidates.push([score, off]);
  }
  if (!candidates.length) throw new Error("Could not find a plausible LODs magic/header block.");
  candidates.sort((a, b) => (b[0] - a[0]) || (a[1] - b[1]));
  return candidates[0][1];
}

function parseLods(file: Bytes, baseVa: number, lodsMagicOff: number): Map<StripLod, LodInfo> {
  const out = new Map<StripLod, LodInfo>();
  for (const [name, rel] of LOD_PTR_OFFSETS) {
    const headerVa = file.u32(lodsMagicOff + rel);
    const headerOff = headerVa - baseVa;
    if (!file.validOff(headerOff + 0x10)) throw new Error(`${name}: header VA ${hex(headerVa)} is outside file`);
    const count = (file.u32(headerOff) >>> 16) & 0xffff;
    const magic = file.u32(headerOff + 4);
    if (magic !== LOD_HDR_MAGIC) throw new Error(`${name}: invalid LOD header magic at file ${hex(headerOff + 4, 6)}: ${hex(magic)}`);
    const meshPtrTableOff = file.u32(headerOff + 0x08) - baseVa;
    const namePtrTableOff = file.u32(headerOff + 0x0c) - baseVa;
    const idTableOff = file.u32(headerOff + 0x10) - baseVa;
    for (const [label, tableOff] of [["mesh pointer table", meshPtrTableOff], ["name pointer table", namePtrTableOff], ["ID table", idTableOff]] as const) {
      if (tableOff < 0 || tableOff + count * 4 > file.size) throw new Error(`${name}: ${label} is outside file: off=${hexOff(tableOff)}, count=${count}`);
    }
    out.set(name, { name, headerOff, count, meshPtrTableOff, namePtrTableOff, idTableOff });
  }
  return out;
}

function nameReasons(name: string, includeSpoilers: boolean): { reasons: string[]; spoilerExcluded: boolean } {
  const lower = name.toLowerCase();
  if (SPOILER_RE.test(lower) && !includeSpoilers) return { reasons: [], spoilerExcluded: true };
  const reasons: string[] = [];
  if (lower.includes("shell")) reasons.push("shell");
  if (lower.includes("trunk")) reasons.push("trunk");
  if (lower.includes("decal")) reasons.push("decal");
  if (TK_TOKEN_RE.test(lower)) reasons.push("tk");
  return { reasons, spoilerExcluded: false };
}

function entryReasons(name: string, meshId: number, meshVa: number, mode: StripMode): string[] {
  if (ALWAYS_KEEP_RE.test(name.toLowerCase())) return [];
  if (mode === "clean-base") {
    const combined = nameReasons(name, true).reasons;
    if (meshVa !== 0) combined.push(meshId === 0 ? "embedded-id0" : "embedded");
    return combined;
  }
  const { reasons, spoilerExcluded } = nameReasons(name, false);
  if (spoilerExcluded) return reasons;
  if (meshId === 0 && meshVa !== 0) reasons.push("embedded-id0");
  return reasons;
}

function parseEntries(file: Bytes, baseVa: number, lods: Map<StripLod, LodInfo>, mode: StripMode): Entry[] {
  const entries: Entry[] = [];
  for (const [lodName] of LOD_PTR_OFFSETS) {
    const lod = lods.get(lodName)!;
    for (let i = 0; i < lod.count; i += 1) {
      const meshPtrEntryOff = lod.meshPtrTableOff + i * 4;
      const meshVa = file.u32(meshPtrEntryOff);
      let meshOff: number | null = null;
      if (meshVa) { const o = meshVa - baseVa; if (o >= 0 && o < file.size) meshOff = o; }
      const namePtrVa = file.u32(lod.namePtrTableOff + i * 4);
      let nameOff: number | null = null;
      if (namePtrVa) { const o = namePtrVa - baseVa; if (o >= 0 && o < file.size) nameOff = o; }
      const meshId = file.u32(lod.idTableOff + i * 4);
      const name = readCString(file, nameOff);
      entries.push({
        lod: lodName, index: i, meshPtrEntryOff, meshVa, meshOff, nameOff, meshId, name,
        reasons: entryReasons(name, meshId, meshVa, mode),
        protectedName: ALWAYS_KEEP_RE.test(name.toLowerCase()),
      });
    }
  }
  return entries;
}

/** Follows a mesh header down to its geometry packets. Null when any pointer leaves the file. */
function walkMesh(file: Bytes, baseVa: number, meshOff: number): MeshLayout | null {
  const size = file.size;
  if (!file.validOff(meshOff + 0x14) || file.u32(meshOff) !== MESH_MAGIC) return null;
  const groupCount = file.u32(meshOff + 0x08);
  if (groupCount > 128) return null;
  const header: Interval = [meshOff, meshOff + 0x18];
  const spans: Interval[] = [header];

  // Pieces injected as a whole standalone mesh.pck keep their 0x80 header right before the
  // payload; its first DWORD is a self-pointer to the payload. It belongs to the mesh.
  const hdrOff = meshOff - STANDALONE_HDR_SIZE;
  if (hdrOff >= 0 && file.u32(hdrOff) === ((baseVa + meshOff) >>> 0) && file.u32(hdrOff + 4) === STANDALONE_HDR_VERSION) {
    spans.unshift([hdrOff, meshOff]);
  }

  const matOff = file.u32(meshOff + 0x0c) - baseVa;
  const grpOff = file.u32(meshOff + 0x10) - baseVa;
  if (groupCount) {
    if (!(matOff >= 0 && matOff + 2 * groupCount <= size)) return null;
    if (!(grpOff >= 0 && grpOff + 8 * groupCount <= size)) return null;
    spans.push([matOff, matOff + 2 * groupCount]);
    spans.push([grpOff, grpOff + 8 * groupCount]);
  }

  const packets: Interval[] = [];
  for (let g = 0; g < groupCount; g += 1) {
    const infoVa = file.u32(grpOff + 8 * g);
    const blockCount = file.u16(grpOff + 8 * g + 4);
    if (blockCount === 0) continue;
    const infoOff = infoVa - baseVa;
    if (!(infoOff >= 0 && infoOff + 8 * blockCount <= size)) return null;
    spans.push([infoOff, infoOff + 8 * blockCount]);
    for (let b = 0; b < blockCount; b += 1) {
      const pktOff = file.u32(infoOff + 8 * b) - baseVa;
      const qwords = file.u16(infoOff + 8 * b + 4);
      if (!(pktOff >= 0 && pktOff + 16 * qwords <= size)) return null;
      packets.push([pktOff, pktOff + 16 * qwords]);
    }
  }
  spans.push(...packets);
  return { meshOff, header, spans, packets };
}

/** Strings end in 00 or CD, so the first 00/CD after a non-filler byte is a terminator, never filler. */
function isPadding(file: Bytes, a: number, b: number) {
  for (let i = a; i < b; i += 1) {
    const value = file.data[i];
    if (value !== 0x00 && value !== 0xcd) return false;
    if (i > 0 && file.data[i - 1] !== 0x00 && file.data[i - 1] !== 0xcd) return false;
  }
  return true;
}

/** Merge removed spans across pure-padding gaps, then make every range 16-byte aligned and a
 *  multiple of 16 in size. A range only grows over padding nobody points at and nothing protects;
 *  otherwise it shrinks, and the few edge bytes stay behind as unreferenced leftovers. */
function finalizeCutRanges(file: Bytes, spans: Interval[], targets: number[], protectedSet: IntervalSet): Interval[] {
  const targetSet = new IntervalSet(targets.map((t) => [t, t + 1] as Interval));
  const freePadding = (a: number, b: number) =>
    a >= b || (isPadding(file, a, b) && !targetSet.overlaps(a, b) && !protectedSet.overlaps(a, b));

  const merged: Interval[] = [];
  for (const [a, b] of mergeIntervals(spans)) {
    if (merged.length && freePadding(merged[merged.length - 1][1], a)) merged[merged.length - 1] = [merged[merged.length - 1][0], b];
    else merged.push([a, b]);
  }

  const out: Interval[] = [];
  for (let [a, b] of merged) {
    const down = a - (a % PACKET_ALIGN);
    a = freePadding(down, a) ? down : down + (a % PACKET_ALIGN ? PACKET_ALIGN : 0);
    const up = b + ((PACKET_ALIGN - (b % PACKET_ALIGN)) % PACKET_ALIGN);
    b = freePadding(b, up) ? up : b - (b % PACKET_ALIGN);
    while (b + PACKET_ALIGN <= file.size && freePadding(b, b + PACKET_ALIGN)) b += PACKET_ALIGN;
    if (b > a) out.push([a, b]);
  }
  return mergeIntervals(out);
}

export function stripCarPck(source: Uint8Array, options: StripOptions = {}): StripResult {
  const mode = options.mode ?? "clean-base";
  const mapOrphans = options.mapZeroPointerOrphans ?? true;
  const forceOrphanOrder = options.forceOrphanOrder ?? false;

  const original = new Bytes(source);
  const size = original.size;
  if (size < HEADER_SIZE + 4) throw new Error("File is too small to be a car PCK.");
  const baseVa = original.u32(0) - HEADER_SIZE;

  checkFamily(original, baseVa);
  const lods = parseLods(original, baseVa, detectLodsMagic(original, baseVa));
  const allEntries = parseEntries(original, baseVa, lods, mode);
  const entries = allEntries.filter((e) => SEARCHED_LODS.includes(e.lod));
  const selected = entries.filter((e) => e.reasons.length > 0);
  const selectedKeys = new Set(selected.map((e) => `${e.lod}:${e.index}`));
  const warnings: string[] = [];
  const label = (e: Entry, orphan = false) => `${e.lod}[${e.index}] ${orphan ? "orphan-by-name-order " : ""}${e.reasons.join(",")} | ${e.name}`;

  // --- every walkable mesh in the file ----------------------------------------------------
  const layouts = new Map<number, MeshLayout>();
  for (const off of findAllU32(original, MESH_MAGIC)) {
    const layout = walkMesh(original, baseVa, off);
    if (layout) layouts.set(off, layout);
  }
  for (const e of allEntries) {
    if (e.meshOff !== null && !layouts.has(e.meshOff)) {
      const layout = walkMesh(original, baseVa, e.meshOff);
      if (layout) layouts.set(e.meshOff, layout);
    }
  }

  const packetSet = new IntervalSet([...layouts.values()].flatMap((layout) => layout.packets));
  const pointerOffs: number[] = [];
  for (let off = 0; off < size - 3; off += 4) {
    if (packetSet.has(off)) continue;
    const target = original.u32(off) - baseVa;
    if (target >= 0 && target < size) pointerOffs.push(off);
  }

  // --- which meshes go --------------------------------------------------------------------
  const remove = new Map<number, string>();
  for (const e of selected) {
    if (e.meshVa === 0) continue;
    if (e.meshOff === null || !layouts.has(e.meshOff)) {
      warnings.push(`${e.lod}[${e.index}] ${e.name}: PTR_Mesh ${hex(e.meshVa)} is not a walkable mesh; entry will be zeroed only.`);
      continue;
    }
    remove.set(e.meshOff, label(e));
  }

  const orphanKeys = new Set<string>();
  const referencedByAny = new Set(allEntries.filter((e) => e.meshOff !== null).map((e) => e.meshOff!));
  if (mapOrphans) {
    for (const lodName of ["HLOD", "MLOD", "LLOD"] as StripLod[]) {
      if (!SEARCHED_LODS.includes(lodName)) continue;
      const lod = lods.get(lodName)!;
      const later = [...lods.values()].filter((x) => x.headerOff > lod.headerOff).map((x) => x.headerOff);
      const regionEnd = later.length ? Math.min(...later) : size;
      const refs = allEntries.filter((e) => e.lod === lodName && e.meshOff !== null && layouts.has(e.meshOff)).map((e) => e.meshOff!);
      const regionStart = refs.length ? Math.min(...refs) : lod.headerOff;
      const orphans = [...layouts.keys()].sort((a, b) => a - b)
        .filter((o) => regionStart <= o && o < regionEnd && !referencedByAny.has(o) && !remove.has(o));
      const zeroSelected = selected.filter((e) => e.lod === lodName && e.meshVa === 0);
      if (!zeroSelected.length) continue;
      if (!orphans.length) {
        warnings.push(`${lodName}: ${zeroSelected.length} selected zero-pointer names, but no orphan mesh payloads found in region.`);
        continue;
      }
      if (orphans.length !== zeroSelected.length && !forceOrphanOrder) {
        warnings.push(`${lodName}: orphan count mismatch; selected zero-pointer names=${zeroSelected.length}, orphan mesh payloads=${orphans.length}. Skipped orphan order mapping.`);
        continue;
      }
      const pairs = Math.min(zeroSelected.length, orphans.length);
      for (let i = 0; i < pairs; i += 1) {
        remove.set(orphans[i], label(zeroSelected[i], true));
        orphanKeys.add(`${zeroSelected[i].lod}:${zeroSelected[i].index}`);
      }
    }
  }

  // --- protect everything a kept mesh still uses, plus the LOD tables and mesh names ----------
  const keptMeshes = new Set(allEntries.filter((e) => e.meshOff !== null && !selectedKeys.has(`${e.lod}:${e.index}`)).map((e) => e.meshOff!));
  const tableSpans: Interval[] = [];
  for (const lod of lods.values()) {
    tableSpans.push([lod.headerOff, lod.headerOff + 0x14]);
    for (const table of [lod.meshPtrTableOff, lod.namePtrTableOff, lod.idTableOff]) tableSpans.push([table, table + 4 * lod.count]);
  }
  for (const e of allEntries) if (e.nameOff !== null) tableSpans.push([e.nameOff, e.nameOff + e.name.length + 1]);
  const protectedSpans: Interval[] = [];
  for (const off of keptMeshes) { const layout = layouts.get(off); if (layout) protectedSpans.push(...layout.spans); }
  const protectedSet = new IntervalSet([...protectedSpans, ...tableSpans]);

  // LOD table slots of selected entries are the only references allowed to point into a cut.
  const zeroable = new Set(selected.filter((e) => e.meshVa !== 0).map((e) => e.meshPtrEntryOff));

  const removedSpans = new Map<number, Interval[]>();
  for (const [off, what] of remove) {
    if (keptMeshes.has(off)) {
      warnings.push(`${what}: payload is also used by a kept LOD entry; pointer zeroed, payload kept.`);
      continue;
    }
    const spans: Interval[] = [];
    for (const span of layouts.get(off)!.spans) {
      if (protectedSet.overlaps(span[0], span[1])) warnings.push(`${what}: ${hexOff(span[0])}..${hexOff(span[1])} is shared with a kept mesh; left in place.`);
      else spans.push(span);
    }
    removedSpans.set(off, spans);
  }

  // --- iterate until no surviving pointer targets a cut --------------------------------------
  for (;;) {
    const cut = new IntervalSet([...removedSpans.values()].flat());
    // Keyed like the Python dict: a span shared by two meshes keeps its first position and the
    // last owner, which decides who gets kept when a reference lands in it.
    const spanOwner = new Map<string, { span: Interval; owner: number }>();
    for (const [owner, spans] of removedSpans) for (const span of spans) spanOwner.set(`${span[0]},${span[1]}`, { span, owner });
    let changed = false;
    for (const p of pointerOffs) {
      if (cut.has(p) || zeroable.has(p)) continue;
      const t = original.u32(p) - baseVa;
      if (!cut.has(t)) continue;
      let owner: number | null = null;
      for (const item of spanOwner.values()) if (item.span[0] <= t && t < item.span[1]) { owner = item.owner; break; }
      if (owner === null) continue;
      const layout = layouts.get(owner)!;
      const what = remove.get(owner)!;
      // The header span, plus the standalone 0x80 header that ends where it starts.
      const headerSpans = layout.spans.filter((s) => s[0] === layout.header[0] || s[1] === layout.header[0]);
      if (headerSpans.some(([a, b]) => a <= t && t < b)) {
        warnings.push(`${what}: header referenced from ${hexOff(p)} outside the LOD tables; mesh kept.`);
        removedSpans.delete(owner);
      } else {
        warnings.push(`${what}: ${hexOff(t)} referenced from ${hexOff(p)}; that span is kept.`);
        removedSpans.set(owner, removedSpans.get(owner)!.filter((s) => !(s[0] <= t && t < s[1])));
      }
      changed = true;
      break;
    }
    if (!changed) break;
  }

  const targets = pointerOffs.map((p) => original.u32(p) - baseVa);
  const cutSpans = [...removedSpans.values()].flat();
  const finalRanges = finalizeCutRanges(original, cutSpans, targets, protectedSet);
  const ranges: StripRange[] = finalRanges.map(([a, b]) => {
    const names: string[] = [];
    for (const [owner, spans] of removedSpans) if (spans.some((s) => a <= s[0] && s[0] < b)) names.push(remove.get(owner)!);
    return { start: a, end: b, label: names.join(" + ") || "padding" };
  });
  const dead = new IntervalSet(cutSpans);

  // --- zero the selected LOD slots, compact, relocate ------------------------------------------
  const patched = new Bytes(source.slice());
  let meshPointersZeroed = 0;
  for (const e of selected) if (e.meshVa !== 0) { patched.w32(e.meshPtrEntryOff, 0); meshPointersZeroed += 1; }

  const removedTotal = ranges.reduce((sum, r) => sum + (r.end - r.start), 0);
  const out = new Uint8Array(size - removedTotal);
  let cursor = 0; let write = 0;
  for (const r of ranges) {
    out.set(patched.data.subarray(cursor, r.start), write); write += r.start - cursor; cursor = r.end;
  }
  out.set(patched.data.subarray(cursor), write);
  const compacted = new Bytes(out);

  const starts = ranges.map((r) => r.start);
  const cumulative: number[] = [];
  let total = 0;
  for (const r of ranges) { total += r.end - r.start; cumulative.push(total); }
  const shift = (off: number): number | null => {
    let lo = 0; let hi = starts.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (off < starts[mid]) hi = mid; else lo = mid + 1; }
    const i = lo - 1;
    if (i >= 0 && off < ranges[i].end) return null;
    return off - (i >= 0 ? cumulative[i] : 0);
  };

  let pointerUpdates = 0; let livePointersZeroed = 0; let deadPointersZeroed = 0;
  for (const p of pointerOffs) {
    const newP = shift(p);
    if (newP === null) continue;
    const value = patched.u32(p);
    if (value === 0) continue;
    const newT = shift(value - baseVa);
    if (newT === null) {
      compacted.w32(newP, 0);
      pointerUpdates += 1;
      if (dead.has(p)) deadPointersZeroed += 1; else livePointersZeroed += 1;
    } else if (((baseVa + newT) >>> 0) !== value) {
      compacted.w32(newP, baseVa + newT);
      pointerUpdates += 1;
    }
  }

  // Known car PCK convention: File_Data_Size at 0x0C = total size - 0x80.
  if (compacted.size >= 0x10) compacted.w32(0x0c, Math.max(0, compacted.size - HEADER_SIZE));

  if (livePointersZeroed) warnings.push(`${livePointersZeroed} live pointer(s) outside the LOD tables still targeted removed data and were zeroed. This should not happen; check the output before using it.`);
  warnings.push(...validateAfter(compacted, baseVa, mode));

  const rows: StripRow[] = allEntries.map((e) => {
    const key = `${e.lod}:${e.index}`;
    const orphan = orphanKeys.has(key);
    const embedded = e.meshOff !== null && layouts.has(e.meshOff);
    let status: StripRowStatus;
    if (e.lod === "LLOD") status = "llod";
    else if (e.meshVa !== 0 && selectedKeys.has(key)) status = "remove";
    else if (orphan) status = "remove";
    else if (e.meshVa === 0) status = "external";
    else if (e.protectedName) status = "protected";
    else status = "keep";
    return { lod: e.lod, index: e.index, name: e.name, meshId: e.meshId, embedded, status, reasons: status === "remove" ? e.reasons : [], orphan };
  });

  const changed = out.length !== size || out.some((value, index) => value !== source[index]);
  return {
    bytes: out, originalSize: size, newSize: out.length, rows, ranges, warnings,
    meshPointersZeroed, pointerUpdates, livePointersZeroed, deadPointersZeroed, changed,
  };
}

/** Re-reads the output: every selected slot must be 0 and every kept embedded mesh walkable. */
function validateAfter(file: Bytes, baseVa: number, mode: StripMode): string[] {
  const warnings: string[] = [];
  try {
    const lods = parseLods(file, baseVa, detectLodsMagic(file, baseVa));
    for (const e of parseEntries(file, baseVa, lods, mode)) {
      const searched = SEARCHED_LODS.includes(e.lod) && e.reasons.length > 0;
      if (searched && e.meshVa !== 0) {
        warnings.push(`Post-validate: ${e.lod}[${e.index}] ${e.name} still has nonzero PTR_Mesh ${hex(e.meshVa)}.`);
      } else if (e.meshVa !== 0 && !searched && (e.meshOff === null || walkMesh(file, baseVa, e.meshOff) === null)) {
        warnings.push(`Post-validate: kept mesh ${e.lod}[${e.index}] ${e.name} is no longer walkable.`);
      }
    }
  } catch (caught) {
    warnings.push(`Post-validate failed: ${caught instanceof Error ? caught.message : String(caught)}`);
  }
  return warnings;
}
