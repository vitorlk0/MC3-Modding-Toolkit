export type Vec3 = [number, number, number];

export type Piece = {
  index: number;
  fileOffset: number;
  virtualAddress: number;
  name: string;
  namePointer: number;
  /** The u16 at +0x38 (PSP +0x50). Despite the name it is not the piece ID: it equals the anchor's
   *  own row index in all 36,251 anchors of the 306 stock PCKs (modding KB §7.2). The real piece ID
   *  lives in the LOD tables — see `LodMeshEntry.meshId`. */
  pieceId: number;
  divider: number;
  a1: Vec3;
  a2: Vec3;
  /** Euler angles in radians at +0x2C/+0x30/+0x34 (PS2 layout; zero for PSPPCK, not mapped there).
   *  Read-only, for previews: ±π/2 on the suspension arms, π on rear axles, the cop-light spinners'
   *  headings (modding KB §7.2). */
  rotation: Vec3;
  nextPointer: number;
  childPointer: number;
  parentPointer: number;
  nextIndex: number | null;
  childIndex: number | null;
  parentIndex: number | null;
};

type Layout = {
  format: "pck" | "psppck";
  pointerSlot: number;
  targetOffset: number;
  count: number;
  listPointer: number;
  listOffset: number;
  itemSize: number;
  nameOffset: number;
  dividerOffset: number;
  nextOffset: number;
  childOffset: number;
  parentOffset: number;
  a2Offset: number;
  idOffset: number;
  score: number;
};

type AnchorHistoryEntry = { kind: "anchor"; index: number; before: [Vec3, Vec3]; after: [Vec3, Vec3] };
type AnchorMove = { index: number; before: [Vec3, Vec3]; after: [Vec3, Vec3] };
// One action that moves many anchors at once (mirror, paste into a multi-selection, the global
// light anchors) is a single undo step. Recorded per anchor it would cost one MAX_HISTORY slot
// each, so a 60-anchor action would flush the entire history and only be partly undoable.
type AnchorGroupHistoryEntry = { kind: "anchorGroup"; moves: AnchorMove[] };
type PieceIdTarget = { lod: LodLevel; index: number; idSlotOffset: number; meshBlockOffset: number | null };
type PieceIdHistoryEntry = { kind: "pieceId"; targets: PieceIdTarget[]; before: number[]; after: number };
type ShaderIdTarget = { meshBlockOffset: number; slotOffset: number };
type ShaderIdHistoryEntry = { kind: "shaderId"; targets: ShaderIdTarget[]; before: number[]; after: number };
// Replacing an embedded mesh rewrites pointers, grows the file, and re-maps LOD entries — far too
// much to describe as a field-level diff, so this one snapshots the whole document instead.
type MeshBlobHistoryEntry = { kind: "meshBlob"; before: MeshBlobSnapshot; after: MeshBlobSnapshot };
type HistoryEntry = AnchorHistoryEntry | AnchorGroupHistoryEntry | PieceIdHistoryEntry | ShaderIdHistoryEntry | MeshBlobHistoryEntry;
const lodKey = (lod: LodLevel, index: number) => `${lod}:${index}`;
type RuntimeSlot = { fileOffset: number; virtualAddress: number; anchorIndex: number | null; note: string; followerIndex?: number | null };

export type LodLevel = "hlod" | "mlod" | "llod";
export type LodMeshEntry = {
  lod: LodLevel;
  index: number;
  name: string;
  /** Low 16 bits of the table's ID slot — same value as the piece's mirrored ID everywhere else. */
  meshId: number;
  /** File offset of the u32 ID slot itself, for writing (upper 16 bits must be preserved). */
  idSlotOffset: number;
  /** Raw PTR_Mesh value; 0 when this piece isn't embedded and is loaded from a standalone mesh.pck. */
  meshPointer: number;
  /** File offset of the u32 PTR_Mesh slot itself, for repointing when an embedded piece is replaced. */
  meshPointerSlotOffset: number;
  /** File offset of the embedded mesh blob header, when meshPointer resolves to a valid mesh magic. */
  meshBlockOffset: number | null;
};

/** One relocatable pointer slot inside a standalone mesh piece: where the u32 lives within the
 *  piece, and the piece-relative offset it has to point at once the piece moves. */
export type MeshReloc = { slotOffset: number; targetOffset: number };

/** A whole-document snapshot, used to undo an embedded-mesh replacement (which changes file size
 *  and pointer layout, so a field-level diff can't describe it). */
export type MeshBlobSnapshot = {
  bytes: Uint8Array;
  lodMeshes: LodMeshEntry[];
  appendedBlocks: Map<string, { offset: number; reservedSize: number }>;
};

const FALLBACK_BASE = 0x067fff80;
const POINTER_SLOTS = [0x1ac, 0x1b0, 0x1b4];
const MAX_HISTORY = 20;
const LODS_POINTER_OFFSET = 0x1a8;
const MESH_PAYLOAD_OFFSET = 0x80;
const MESH_ID_BYTE = 0x06;
const APPEND_ALIGNMENT = 0x10;
/** The mesh magic is a per-build type ID: 0x007A0F98 in the standard PCK family (and every
 *  converted PSP piece), 0x007A22A0 in the DUB/Remix family, 0x007A1198 in SL500/SL55. The blob
 *  layout behind it — ID byte, material table, group/block graph, packets — is identical in all
 *  of them (checked on every embedded blob of the 306 stock PCKs; modding KB §4.5). The precedent
 *  tool hard-coded the first one and wrongly rejected valid PS2 pieces because of it. */
const isMeshPayloadMagic = (magic: number) => (magic & 0xffff0000) === 0x007a0000 && (magic & 0xffff) !== 0;
const LOD_LEVELS: { level: LodLevel; headerOffset: number }[] = [
  { level: "hlod", headerOffset: 0x10 },
  { level: "mlod", headerOffset: 0x14 },
  { level: "llod", headerOffset: 0x18 },
];

const layouts = [
  { format: "pck" as const, itemSize: 0x44, nameOffset: 0x0c, dividerOffset: 0x10, nextOffset: 0x14, childOffset: 0x18, parentOffset: 0x1c, a2Offset: 0x20, idOffset: 0x38 },
  { format: "psppck" as const, itemSize: 0x60, nameOffset: 0x10, dividerOffset: 0x14, nextOffset: 0x18, childOffset: 0x1c, parentOffset: 0x20, a2Offset: 0x30, idOffset: 0x50 },
];

const u16 = (v: DataView, o: number) => v.getUint16(o, true);
const u32 = (v: DataView, o: number) => v.getUint32(o, true);
const f32 = (v: DataView, o: number) => v.getFloat32(o, true);
const sentinel = (n: number) => n === 0 || n === 0xcdcdcdcd || (n & 0xffff0000) === 0xcdcd0000;
const virtualToFile = (address: number, base: number) => (address - base) >>> 0;
const fileToVirtual = (offset: number, base: number) => (offset + base) >>> 0;
const inside = (offset: number, size: number, total: number) => offset >= 0 && size >= 0 && offset + size <= total;
const sameRange = (a: Uint8Array, b: Uint8Array, offset: number, size: number) => { for (let i = offset; i < offset + size; i += 1) if (a[i] !== b[i]) return false; return true; };
const align = (value: number, alignment: number) => value + ((alignment - value % alignment) % alignment);
const cloneVec = (v: Vec3): Vec3 => [v[0], v[1], v[2]];
const sameVec = (a: Vec3, b: Vec3) => a.every((n, i) => Object.is(n, b[i]));

/**
 * Walks the exact internal pointer graph of a standalone mesh.pck so the piece can be relocated
 * into a car PCK at a different address. Every pointer is reached structurally — from the
 * mini-header, to the material/group tables, to each group's block list, to each geometry block —
 * and the geometry payload itself is never inspected.
 *
 * Deliberately NOT a whole-buffer DWORD scan: two adjacent s16 vertex coordinates can form a value
 * that looks exactly like a valid in-piece VA, and rebasing one of those silently corrupts
 * geometry. The precedent Python tool shipped that bug before being rewritten to walk the graph
 * (see the Mesh Editor piece/shader ID project memory) — this mirrors the fixed version.
 *
 * Also validates the piece as a side effect: every bound and pointer is range-checked, so a
 * malformed or non-mesh file throws here rather than producing a corrupt car PCK later.
 */
export function scanMeshRelocs(piece: Uint8Array): MeshReloc[] {
  const view = new DataView(piece.buffer, piece.byteOffset, piece.byteLength);
  const size = piece.byteLength;
  if (size < MESH_PAYLOAD_OFFSET + 0x14) throw new Error("The mesh file is too small to contain a standalone piece header.");
  const payloadPointer = u32(view, 0x00);
  if (!payloadPointer) throw new Error("The mesh file has a null payload pointer at +0x00.");
  const baseVa = (payloadPointer - MESH_PAYLOAD_OFFSET) >>> 0;
  const endVa = baseVa + size;
  const magic = u32(view, MESH_PAYLOAD_OFFSET);
  if (!isMeshPayloadMagic(magic)) throw new Error(`The mesh file has an unsupported payload magic (${hex(magic)}).`);

  const relocs = new Map<number, MeshReloc>();
  const requireRange = (offset: number, length: number, label: string) => {
    if (!inside(offset, length, size)) throw new Error(`The mesh file's ${label} is out of bounds.`);
  };
  const addPointer = (slotOffset: number, label: string) => {
    requireRange(slotOffset, 4, `${label} pointer`);
    const value = u32(view, slotOffset);
    if (!value) throw new Error(`The mesh file's ${label} pointer is null.`);
    if (value < baseVa || value >= endVa) throw new Error(`The mesh file's ${label} pointer (${hex(value)}) points outside the piece.`);
    const targetOffset = value - baseVa;
    relocs.set(slotOffset, { slotOffset, targetOffset });
    return targetOffset;
  };

  if (addPointer(0x00, "mini-header payload") !== MESH_PAYLOAD_OFFSET) throw new Error("The mesh file's payload pointer does not resolve to +0x80.");
  const groupCount = u32(view, MESH_PAYLOAD_OFFSET + 0x08);
  if (groupCount < 1 || groupCount > 0x1000) throw new Error(`The mesh file has an invalid material group count (${groupCount}).`);
  const materialTable = addPointer(MESH_PAYLOAD_OFFSET + 0x0c, "material table");
  requireRange(materialTable, groupCount * 2, "material table");
  const groupTable = addPointer(MESH_PAYLOAD_OFFSET + 0x10, "group table");
  requireRange(groupTable, groupCount * 8, "group table");

  for (let group = 0; group < groupCount; group += 1) {
    const groupEntry = groupTable + group * 8;
    requireRange(groupEntry, 8, `group ${group} entry`);
    const blockCount = u16(view, groupEntry + 4);
    if (blockCount < 1 || blockCount > 0x1000) throw new Error(`The mesh file's group ${group} has an invalid block count (${blockCount}).`);
    const blockList = addPointer(groupEntry, `group ${group} block list`);
    requireRange(blockList, blockCount * 8, `group ${group} block list`);
    for (let block = 0; block < blockCount; block += 1) {
      const blockEntry = blockList + block * 8;
      requireRange(blockEntry, 8, `group ${group} block ${block} entry`);
      const geometryOffset = addPointer(blockEntry, `group ${group} geometry block ${block}`);
      const blockSize = u16(view, blockEntry + 4) * 0x10;
      if (!blockSize) throw new Error(`The mesh file's group ${group} block ${block} has zero length.`);
      requireRange(geometryOffset, blockSize, `group ${group} geometry block ${block}`);
    }
  }
  return [...relocs.values()].sort((a, b) => a.slotOffset - b.slotOffset);
}

function readName(bytes: Uint8Array, offset: number, max = 512) {
  const end = Math.min(bytes.length, offset + max);
  let value = "";
  for (let i = offset; i < end; i += 1) {
    if (bytes[i] === 0 || bytes[i] === 0xcd) break;
    value += bytes[i] >= 32 && bytes[i] <= 126 ? String.fromCharCode(bytes[i]) : "�";
  }
  return value;
}

function reasonableName(value: string) {
  return value.length > 0 && value.length <= 64 && /[A-Za-z]/.test(value) && /^[\w.\-+()[\]{} ]+$/.test(value);
}

function detectLayout(bytes: Uint8Array, view: DataView, base: number): Layout {
  const candidates: Layout[] = [];
  for (const pointerSlot of POINTER_SLOTS) {
    if (!inside(pointerSlot, 4, bytes.length)) continue;
    const pointer = u32(view, pointerSlot);
    if (sentinel(pointer)) continue;
    const targetOffset = virtualToFile(pointer, base);
    if (!inside(targetOffset, 12, bytes.length)) continue;
    const count = u16(view, targetOffset);
    const listPointer = u32(view, targetOffset + 8);
    if (count < 1 || count > 5000 || sentinel(listPointer)) continue;
    for (const template of layouts) {
      const listOffset = virtualToFile(listPointer, base);
      if (!inside(listOffset, count * template.itemSize, bytes.length)) continue;
      let readableNames = 0;
      let validLinks = 0;
      for (let i = 0; i < Math.min(count, 24); i += 1) {
        const offset = listOffset + i * template.itemSize;
        const namePointer = u32(view, offset + template.nameOffset);
        if (!sentinel(namePointer)) {
          const nameOffset = virtualToFile(namePointer, base);
          if (nameOffset < bytes.length && reasonableName(readName(bytes, nameOffset, 64))) readableNames += 1;
        }
        for (const linkOffset of [template.nextOffset, template.childOffset, template.parentOffset]) {
          const link = u32(view, offset + linkOffset);
          if (sentinel(link)) continue;
          const linkFile = virtualToFile(link, base);
          if (linkFile >= listOffset && linkFile < listOffset + count * template.itemSize && (linkFile - listOffset) % template.itemSize === 0) validLinks += 1;
        }
      }
      const score = readableNames * 20 + validLinks * 3 - (readableNames === 0 ? 100 : 0);
      candidates.push({ ...template, pointerSlot, targetOffset, count, listPointer, listOffset, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  if (!candidates.length) throw new Error("Could not detect a valid anchor table in this PCK/PSPPCK file.");
  if (candidates[0].score < 0) throw new Error("Candidate pointers were found, but the anchor layout is inconsistent.");
  return candidates[0];
}

function resolveIndex(pointer: number, listOffset: number, count: number, itemSize: number, fileSize: number, base: number) {
  if (sentinel(pointer)) return null;
  const offset = virtualToFile(pointer, base);
  const delta = offset - listOffset;
  if (offset >= fileSize || delta < 0 || delta % itemSize !== 0) return null;
  const index = delta / itemSize;
  return index >= 0 && index < count ? index : null;
}

function exhaustSuffix(name: string) {
  const match = name.trim().toLowerCase().match(/(?:^|_)(?:exhaust|exst|ext)_?([01])$/);
  return match ? Number(match[1]) : null;
}

function wheelSuffix(name: string) {
  const normalized = name.trim().toLowerCase();
  const match = normalized.match(/(?:^|_)(?:whl|wheel)_?0*([0-3])$/) ?? normalized.match(/(?:whl|wheel)[_ -]*0*([0-3])$/);
  return match ? Number(match[1]) : null;
}

function axleSuffix(name: string) {
  const match = name.trim().toLowerCase().match(/(?:^|_)(?:axl|axle)_?0*([0-3])$/);
  return match ? Number(match[1]) : null;
}

// Two-wheelers mostly name their slots by end — axl_front/whl_rear, axle_front, axl_rr, the
// choppers' axF/wheelR — and sometimes by number (ax0/whl1). Their TBL_Wheels holds the front
// wheel in slot 0 and the rear in slot 1.
function bikeSlot(name: string, part: "axle" | "wheel") {
  const prefix = part === "axle" ? "(?:axl|axle|ax)" : "(?:whl|wheel)";
  const match = name.trim().toLowerCase().match(new RegExp(`^${prefix}_?(front|frnt|f|rear|rr|r|0|1)$`));
  return match ? (match[1].startsWith("f") || match[1] === "0" ? 0 : 1) : null;
}

export class PckDocument {
  readonly name: string;
  readonly originalBytes: Uint8Array;
  savedBytes: Uint8Array;
  bytes: Uint8Array;
  view: DataView;
  readonly pointerBase: number;
  readonly rootPointer: number;
  readonly layout: Layout;
  readonly pieces: Piece[];
  readonly children = new Map<number, number[]>();
  readonly roots: number[];
  readonly savedAnchors: [Vec3, Vec3][];
  readonly exhaustSlots: RuntimeSlot[] = [];
  readonly exhaustLinks = new Map<number, number>();
  readonly wheelSlots: RuntimeSlot[] = [];
  readonly wheelLinks = new Map<number, number>();
  /** whl_N anchors whose raw A1 (+0x00) mirrors the TBL_Wheels slot owned by their axl_N parent.
   *  Locked for direct edits — setAnchors on the axle keeps them in sync. */
  readonly wheelFollowers = new Map<number, number>();
  readonly runtimeNotes: string[] = [];
  readonly lodMeshes: LodMeshEntry[] = [];
  dirtyIndices = new Set<number>();
  /** `${lod}:${index}` keys for every LOD-table entry with a pending (unsaved) piece-ID edit. */
  dirtyLodKeys = new Set<string>();
  /** File offsets (as strings) of every embedded material-table slot with a pending shader-ID edit. */
  dirtyShaderKeys = new Set<string>();
  /** Mesh names whose embedded copy has been replaced (appended) but not yet saved. */
  dirtyMeshBlobs = new Set<string>();
  /** `${offset}:${length}` of every raw field write (the Performance tab) that differs from the saved bytes. */
  dirtyFieldKeys = new Set<string>();
  /** Every field span ever written this session, dirty or not — a restored snapshot can bring back
   *  a value that was undone, so each one is re-checked after a restore rather than only the dirty ones. */
  private fieldKeys = new Set<string>();
  /** Blocks this session appended at EOF, keyed by `${lod}:${index}` — space we know we own, so a
   *  repeat update of the same piece can reuse it instead of growing the file again. Never covers
   *  game-shipped embedded blobs, which are only ever abandoned in place, never overwritten. */
  appendedBlocks = new Map<string, { offset: number; reservedSize: number }>();
  undoStack: HistoryEntry[] = [];
  redoStack: HistoryEntry[] = [];

  constructor(name: string, source: ArrayBuffer) {
    this.name = name;
    this.originalBytes = new Uint8Array(source.slice(0));
    this.bytes = new Uint8Array(source.slice(0));
    this.savedBytes = this.bytes.slice();
    this.view = new DataView(this.bytes.buffer);
    if (this.bytes.length < 0x200) throw new Error("The file is too small to be a supported car PCK/PSPPCK.");
    this.rootPointer = u32(this.view, 0);
    this.pointerBase = this.rootPointer >= 0x80 ? (this.rootPointer - 0x80) >>> 0 : FALLBACK_BASE;
    this.layout = detectLayout(this.bytes, this.view, this.pointerBase);
    this.pieces = this.readPieces();
    for (const piece of this.pieces) {
      if (piece.parentIndex !== null) this.children.set(piece.parentIndex, [...(this.children.get(piece.parentIndex) ?? []), piece.index]);
    }
    for (const children of this.children.values()) children.sort((a, b) => a - b);
    this.roots = this.pieces.filter((piece) => piece.parentIndex === null).map((piece) => piece.index);
    if (!this.roots.length && this.pieces.length) this.roots.push(0);
    this.savedAnchors = this.pieces.map((piece) => [cloneVec(piece.a1), cloneVec(piece.a2)]);
    this.mapExhaustRuntime();
    this.mapWheelRuntime();
    this.mapLodTables();
  }

  get format() { return this.layout.format; }
  get dirty() { return this.dirtyIndices.size > 0 || this.dirtyLodKeys.size > 0 || this.dirtyShaderKeys.size > 0 || this.dirtyMeshBlobs.size > 0 || this.dirtyFieldKeys.size > 0; }
  get fileSize() { return this.bytes.byteLength; }

  private readPieces() {
    const output: Piece[] = [];
    const l = this.layout;
    for (let index = 0; index < l.count; index += 1) {
      const o = l.listOffset + index * l.itemSize;
      const namePointer = u32(this.view, o + l.nameOffset);
      const nameOffset = sentinel(namePointer) ? null : virtualToFile(namePointer, this.pointerBase);
      output.push({
        index, fileOffset: o, virtualAddress: fileToVirtual(o, this.pointerBase),
        name: nameOffset !== null && nameOffset < this.fileSize ? readName(this.bytes, nameOffset) || "<no name>" : "<no name>",
        namePointer, pieceId: u16(this.view, o + l.idOffset), divider: u32(this.view, o + l.dividerOffset),
        a1: [f32(this.view, o), f32(this.view, o + 4), f32(this.view, o + 8)],
        a2: [f32(this.view, o + l.a2Offset), f32(this.view, o + l.a2Offset + 4), f32(this.view, o + l.a2Offset + 8)],
        rotation: l.format === "pck" ? [0x2c, 0x30, 0x34].map((field) => { const value = f32(this.view, o + field); return Number.isFinite(value) ? value : 0; }) as Vec3 : [0, 0, 0],
        nextPointer: u32(this.view, o + l.nextOffset), childPointer: u32(this.view, o + l.childOffset), parentPointer: u32(this.view, o + l.parentOffset),
        nextIndex: null, childIndex: null, parentIndex: null,
      });
    }
    for (const piece of output) {
      piece.nextIndex = resolveIndex(piece.nextPointer, l.listOffset, l.count, l.itemSize, this.fileSize, this.pointerBase);
      piece.childIndex = resolveIndex(piece.childPointer, l.listOffset, l.count, l.itemSize, this.fileSize, this.pointerBase);
      piece.parentIndex = resolveIndex(piece.parentPointer, l.listOffset, l.count, l.itemSize, this.fileSize, this.pointerBase);
    }
    return output;
  }

  private readVec(offset: number): Vec3 { return [f32(this.view, offset), f32(this.view, offset + 4), f32(this.view, offset + 8)]; }
  private writeVec(offset: number, value: Vec3) { value.forEach((n, i) => this.view.setFloat32(offset + i * 4, n, true)); }
  private vecBytes(offset: number) { return this.bytes.slice(offset, offset + 12); }
  private sameBytes(a: Uint8Array, b: Uint8Array) { return a.length === b.length && a.every((n, i) => n === b[i]); }
  private descendants(root: number) {
    const result: number[] = [];
    const queue = [...(this.children.get(root) ?? [])];
    const seen = new Set<number>();
    while (queue.length) {
      const index = queue.shift()!;
      if (seen.has(index)) continue;
      seen.add(index); result.push(index); queue.push(...(this.children.get(index) ?? []));
    }
    return result;
  }

  private mapWheelRuntime() {
    if (this.format !== "pck") return;
    const header = 0x38e0;
    if (!inside(header, 0x3c, this.fileSize)) { this.runtimeNotes.push("Wheel runtime table not found."); return; }
    const startPointer = u32(this.view, header);
    const count = u32(this.view, header + 4);
    const start = virtualToFile(startPointer, this.pointerBase);
    if ((count !== 4 && count !== 2) || sentinel(startPointer) || !inside(start, count * 0x1c, this.fileSize)) { this.runtimeNotes.push("Wheel runtime table not found."); return; }
    // Where each entry's back-pointers sit, fixed relative to the header across all 306 PCKs checked;
    // a motorcycle's table (count 2) keeps the front and rear wheels in a shorter layout.
    const pointerSlots: Record<number, number[]> = count === 4
      ? { 0: [0x38e0, 0x38f4], 1: [0x3914], 2: [0x38f8], 3: [0x3918] }
      : { 0: [0x38e0, 0x38f4], 1: [0x38f8] };
    const axleSlot = (name: string) => count === 4 ? axleSuffix(name) : bikeSlot(name, "axle");
    const wheelSlot = (name: string) => count === 4 ? wheelSuffix(name) : bikeSlot(name, "wheel");
    for (let i = 0; i < count; i += 1) {
      const entry = start + i * 0x1c;
      if (u32(this.view, entry) !== i || pointerSlots[i].some((slot) => !inside(slot, 4, this.fileSize) || u32(this.view, slot) !== fileToVirtual(entry, this.pointerBase))) {
        this.wheelSlots.length = 0; this.runtimeNotes.push("Wheel runtime table failed validation."); return;
      }
      this.wheelSlots.push({ fileOffset: entry + 0x10, virtualAddress: fileToVirtual(entry + 0x10, this.pointerBase), anchorIndex: null, note: "" });
    }
    const root = this.pieces.find((piece) => ["wheels", "wheel", "wheel_bone", "wheels_bone"].includes(piece.name.toLowerCase()))?.index;
    const inRoot = root === undefined ? [] : this.descendants(root);
    // In the shipped PCKs the slot position is stored four times: TBL_Wheels, both anchors of axl_N,
    // and the raw A1 of its child whl_N (whose raw A2 is the zero offset from the axle). The axle is
    // the parent that carries the wheel, so it owns the slot; the wheel only mirrors it.
    const axles = new Map<number, number>();
    for (const index of [...new Set([...inRoot, ...this.pieces.map((piece) => piece.index)])]) {
      const slot = axleSlot(this.pieces[index].name);
      if (slot !== null && !axles.has(slot)) axles.set(slot, index);
    }
    const wheels = new Map<number, { index: number; note: string }>();
    const candidates = [...new Set([...inRoot, ...this.pieces.filter((piece) => wheelSlot(piece.name) !== null).map((piece) => piece.index)])];
    const claimed = new Set<number>();
    for (const index of candidates) {
      const slot = wheelSlot(this.pieces[index].name);
      if (slot === null || wheels.has(slot)) continue;
      wheels.set(slot, { index, note: "Matched by name" }); claimed.add(index);
    }
    for (const index of candidates) {
      if (claimed.has(index) || axleSlot(this.pieces[index].name) !== null) continue;
      const pieceBytes = new Uint8Array(12); const pieceView = new DataView(pieceBytes.buffer); this.pieces[index].a1.forEach((n, i) => pieceView.setFloat32(i * 4, n, true));
      const slot = this.wheelSlots.findIndex((item, i) => !wheels.has(i) && this.sameBytes(this.vecBytes(item.fileOffset), pieceBytes));
      if (slot < 0) continue;
      wheels.set(slot, { index, note: "Matched by A1 bytes" }); claimed.add(index);
    }
    this.wheelSlots.forEach((item, slot) => {
      const axle = axles.get(slot), wheel = wheels.get(slot);
      if (axle !== undefined) {
        this.wheelLinks.set(axle, slot); item.anchorIndex = axle; item.note = "Axle matched by name";
        if (wheel && this.pieces[wheel.index].parentIndex === axle) { this.wheelFollowers.set(wheel.index, slot); item.followerIndex = wheel.index; }
      } else if (wheel) {
        // No axle in this hierarchy: fall back to the wheel owning the slot, as before.
        this.wheelLinks.set(wheel.index, slot); item.anchorIndex = wheel.index; item.note = wheel.note;
      }
    });
    this.runtimeNotes.push(`Wheel runtime table: ${this.wheelSlots.length} slots, ${this.wheelLinks.size} linked anchors.`);
  }

  private mapExhaustRuntime() {
    if (this.format !== "pck") return;
    const start = virtualToFile((this.rootPointer + 0x138) >>> 0, this.pointerBase);
    const reservedEnd = start + 24 * 0x18;
    if (!inside(start, 24 * 0x18 + 2, this.fileSize) || u16(this.view, reservedEnd) !== this.layout.count) { this.runtimeNotes.push("Exhaust runtime table not found."); return; }
    let lastUsed = -1;
    for (let group = 0; group < 24; group += 1) if (this.bytes.slice(start + group * 0x18, start + (group + 1) * 0x18).some(Boolean)) lastUsed = group;
    const groups = lastUsed + 1;
    if (groups < 1 || 24 - groups < 3) { this.runtimeNotes.push("Exhaust runtime table not present or failed validation."); return; }
    const bumpersWithExhaust = this.pieces.filter((piece) => (this.children.get(piece.index) ?? []).some((child) => exhaustSuffix(this.pieces[child].name) !== null));
    const families = new Map<number, number[]>();
    for (const bumper of bumpersWithExhaust) if (bumper.parentIndex !== null) families.set(bumper.parentIndex, [...(families.get(bumper.parentIndex) ?? []), bumper.index]);
    const ranked = [...families.entries()].map(([root, anchored]) => ({ all: this.children.get(root) ?? [], anchored })).sort((a, b) => Number(b.all.length === groups) - Number(a.all.length === groups) || b.anchored.length - a.anchored.length);
    const bumpers = ranked[0] ? (ranked[0].all.length === groups ? ranked[0].all : ranked[0].anchored) : [];
    if (bumpers.length !== groups) { this.runtimeNotes.push(`Exhaust table has ${groups} groups, hierarchy resolved ${bumpers.length}.`); return; }
    for (let i = 0; i < groups * 2; i += 1) {
      const offset = start + i * 12;
      if (this.readVec(offset).some((n) => !Number.isFinite(n) || Math.abs(n) > 10000)) { this.runtimeNotes.push("Exhaust runtime table contains implausible positions."); this.exhaustSlots.length = 0; return; }
      this.exhaustSlots.push({ fileOffset: offset, virtualAddress: fileToVirtual(offset, this.pointerBase), anchorIndex: null, note: "" });
    }
    bumpers.forEach((bumper, group) => {
      const children = (this.children.get(bumper) ?? []).filter((index) => exhaustSuffix(this.pieces[index].name) !== null);
      const free = new Set([group * 2, group * 2 + 1]);
      for (const index of children) {
        const a1 = new Uint8Array(12); const v = new DataView(a1.buffer); this.pieces[index].a1.forEach((n, i) => v.setFloat32(i * 4, n, true));
        const match = [...free].find((slot) => this.sameBytes(this.vecBytes(this.exhaustSlots[slot].fileOffset), a1));
        if (match !== undefined) { this.exhaustLinks.set(index, match); this.exhaustSlots[match].anchorIndex = index; this.exhaustSlots[match].note = "Matched by A1 bytes"; free.delete(match); }
      }
      for (const index of children) {
        if (this.exhaustLinks.has(index)) continue;
        const suffix = exhaustSuffix(this.pieces[index].name);
        const preferred = suffix === null ? undefined : group * 2 + suffix;
        const match = preferred !== undefined && free.has(preferred) ? preferred : [...free][0];
        if (match === undefined) continue;
        this.exhaustLinks.set(index, match); this.exhaustSlots[match].anchorIndex = index; this.exhaustSlots[match].note = preferred === match ? "Matched by suffix" : "Matched by group order"; free.delete(match);
      }
    });
    this.runtimeNotes.push(`Exhaust runtime table: ${groups} groups, ${this.exhaustLinks.size} linked anchors.`);
  }

  private mapLodTables() {
    if (this.format !== "pck") return;
    if (!inside(LODS_POINTER_OFFSET, 4, this.fileSize)) { this.runtimeNotes.push("LOD tables not found."); return; }
    const lodsPointer = u32(this.view, LODS_POINTER_OFFSET);
    if (sentinel(lodsPointer)) { this.runtimeNotes.push("LOD tables not found."); return; }
    const lodsOffset = virtualToFile(lodsPointer, this.pointerBase);
    if (!inside(lodsOffset, 0x1c, this.fileSize)) { this.runtimeNotes.push("LOD root block not found."); return; }
    for (const { level, headerOffset } of LOD_LEVELS) {
      const headerPointer = u32(this.view, lodsOffset + headerOffset);
      if (sentinel(headerPointer)) continue;
      const headerOffsetFile = virtualToFile(headerPointer, this.pointerBase);
      if (!inside(headerOffsetFile, 0x14, this.fileSize)) continue;
      const count = u16(this.view, headerOffsetFile + 0x02);
      if (count < 1 || count > 4096) continue;
      const meshPtrsOffset = virtualToFile(u32(this.view, headerOffsetFile + 0x08), this.pointerBase);
      const namePtrsOffset = virtualToFile(u32(this.view, headerOffsetFile + 0x0c), this.pointerBase);
      const idsOffset = virtualToFile(u32(this.view, headerOffsetFile + 0x10), this.pointerBase);
      if (!inside(meshPtrsOffset, count * 4, this.fileSize) || !inside(namePtrsOffset, count * 4, this.fileSize) || !inside(idsOffset, count * 4, this.fileSize)) continue;
      for (let index = 0; index < count; index += 1) {
        const namePointer = u32(this.view, namePtrsOffset + index * 4);
        const nameOffset = sentinel(namePointer) ? null : virtualToFile(namePointer, this.pointerBase);
        const name = nameOffset !== null && nameOffset < this.fileSize ? readName(this.bytes, nameOffset) : "";
        const meshPointer = u32(this.view, meshPtrsOffset + index * 4);
        let meshBlockOffset: number | null = null;
        if (!sentinel(meshPointer)) {
          const candidate = virtualToFile(meshPointer, this.pointerBase);
          if (inside(candidate, 4, this.fileSize) && isMeshPayloadMagic(u32(this.view, candidate))) meshBlockOffset = candidate;
        }
        const idSlotOffset = idsOffset + index * 4;
        this.lodMeshes.push({ lod: level, index, name, meshId: u16(this.view, idSlotOffset), idSlotOffset, meshPointer, meshPointerSlotOffset: meshPtrsOffset + index * 4, meshBlockOffset });
      }
    }
    if (this.lodMeshes.length) this.runtimeNotes.push(`LOD tables: ${this.lodMeshes.length} entries across HLOD/MLOD/LLOD.`);
  }

  setAnchors(index: number, a1: Vec3, a2: Vec3, record = true) {
    const piece = this.pieces[index];
    if (!piece) throw new Error("Invalid anchor index.");
    if (this.wheelFollowers.has(index)) return false;
    const before: [Vec3, Vec3] = [cloneVec(piece.a1), cloneVec(piece.a2)];
    let nextA1 = cloneVec(a1), nextA2 = cloneVec(a2);
    const exhaustSlot = this.exhaustLinks.get(index);
    const wheelSlot = this.wheelLinks.get(index);
    if (exhaustSlot !== undefined || wheelSlot !== undefined) {
      // Both anchors are runtime-linked to a separate position table (exhaust/wheel), so A1 and A2
      // don't carry independent meaning here — keep them forced equal, whichever one was edited.
      const canonical = sameVec(a1, before[0]) && !sameVec(a2, before[1]) ? nextA2 : nextA1;
      nextA1 = cloneVec(canonical); nextA2 = cloneVec(canonical);
    }
    if (sameVec(before[0], nextA1) && sameVec(before[1], nextA2)) return false;
    if (wheelSlot !== undefined) {
      const runtime = this.readVec(this.wheelSlots[wheelSlot].fileOffset);
      before[0].forEach((value, component) => { if (!Object.is(value, nextA1[component])) runtime[component] = nextA1[component]; });
      this.writeVec(this.wheelSlots[wheelSlot].fileOffset, runtime);
      const followerIndex = this.wheelSlots[wheelSlot].followerIndex;
      if (followerIndex !== undefined && followerIndex !== null) {
        // Same per-component rule as the table: only the axes that moved are carried over, and
        // only into the wheel's raw A1 — its raw A2 stays the (zero) offset from the axle.
        const follower = this.pieces[followerIndex];
        const mirrored = cloneVec(follower.a1);
        before[0].forEach((value, component) => { if (!Object.is(value, nextA1[component])) mirrored[component] = nextA1[component]; });
        follower.a1 = mirrored; this.writeVec(follower.fileOffset, mirrored);
        const savedFollower = this.savedAnchors[followerIndex];
        if (sameVec(savedFollower[0], follower.a1) && sameVec(savedFollower[1], follower.a2)) this.dirtyIndices.delete(followerIndex); else this.dirtyIndices.add(followerIndex);
      }
    }
    piece.a1 = nextA1; piece.a2 = nextA2;
    this.writeVec(piece.fileOffset, nextA1); this.writeVec(piece.fileOffset + this.layout.a2Offset, nextA2);
    if (exhaustSlot !== undefined) this.writeVec(this.exhaustSlots[exhaustSlot].fileOffset, nextA1);
    const saved = this.savedAnchors[index];
    if (sameVec(saved[0], nextA1) && sameVec(saved[1], nextA2)) this.dirtyIndices.delete(index); else this.dirtyIndices.add(index);
    if (record) {
      this.undoStack.push({ kind: "anchor", index, before, after: [cloneVec(nextA1), cloneVec(nextA2)] });
      if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
      this.redoStack = [];
    }
    return true;
  }

  /**
   * Applies many anchor moves as a single undo step. Returns how many anchors actually changed.
   *
   * `before`/`after` are read back off the piece instead of being taken from the arguments, so a
   * runtime-linked anchor — which setAnchors forces to keep A1 == A2 — records what actually
   * landed rather than what was asked for.
   */
  setAnchorsBatch(moves: { index: number; a1: Vec3; a2: Vec3 }[], record = true) {
    const applied: AnchorMove[] = [];
    for (const move of moves) {
      const piece = this.pieces[move.index];
      if (!piece) throw new Error("Invalid anchor index.");
      const before: [Vec3, Vec3] = [cloneVec(piece.a1), cloneVec(piece.a2)];
      if (!this.setAnchors(move.index, move.a1, move.a2, false)) continue;
      applied.push({ index: move.index, before, after: [cloneVec(piece.a1), cloneVec(piece.a2)] });
    }
    if (applied.length && record) {
      this.undoStack.push({ kind: "anchorGroup", moves: applied });
      if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
      this.redoStack = [];
    }
    return applied.length;
  }

  updateComponent(index: number, anchor: "a1" | "a2", component: number, value: number, record = true) {
    const piece = this.pieces[index];
    const a1 = cloneVec(piece.a1), a2 = cloneVec(piece.a2);
    (anchor === "a1" ? a1 : a2)[component] = value;
    return this.setAnchors(index, a1, a2, record);
  }

  /**
   * Writes a new piece ID into every given HLOD/MLOD/LLOD table entry's ID slot (low 16 bits,
   * upper 16 bits preserved) and, for entries that are embedded (meshBlockOffset != null), into
   * the embedded mesh blob's own ID byte too. Does NOT touch the anchor table — that field turned
   * out to be an unrelated self-index, not part of this ID system (see project memory).
   * Deliberately does not touch the standalone mesh.pck file; that lives in a separate document.
   */
  setLodMeshId(entries: LodMeshEntry[], newId: number, record = true) {
    if (!entries.length) return false;
    if (newId < 0 || newId > 0xff) throw new Error("Piece ID must be between 0 and 255 — the embedded mesh blob and standalone mesh.pck only have a single byte for it.");
    const targets: PieceIdTarget[] = entries.map((entry) => ({ lod: entry.lod, index: entry.index, idSlotOffset: entry.idSlotOffset, meshBlockOffset: entry.meshBlockOffset }));
    const before = targets.map((target) => u16(this.view, target.idSlotOffset));
    if (before.every((id) => id === newId)) return false;
    this.applyPieceIdTargets(targets, targets.map(() => newId));
    for (const target of targets) this.refreshLodDirty(target);
    if (record) {
      this.undoStack.push({ kind: "pieceId", targets, before, after: newId });
      if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
      this.redoStack = [];
    }
    return true;
  }

  /** Applies another loaded PCK's pending piece-ID edits to this document, matched by (lod, index)
   *  position — the same correspondence `assertAnchorCompatibility` already assumes for anchors. */
  syncLodMeshIdsFrom(source: PckDocument, keys: Iterable<string> = source.dirtyLodKeys) {
    let applied = 0;
    for (const key of keys) {
      const [lod, indexText] = key.split(":") as [LodLevel, string];
      const index = Number(indexText);
      const sourceEntry = source.lodMeshes.find((entry) => entry.lod === lod && entry.index === index);
      const targetEntry = this.lodMeshes.find((entry) => entry.lod === lod && entry.index === index);
      if (!sourceEntry || !targetEntry) throw new Error(`${this.name} has no ${lod.toUpperCase()} entry #${index} to match ${source.name}.`);
      if (this.setLodMeshId([targetEntry], sourceEntry.meshId, false)) applied += 1;
    }
    return applied;
  }

  /**
   * Locates an embedded mesh blob's material (shader) table: `+0x08` group count, `+0x0c` pointer
   * to a `u16[groupCount]` array of shader IDs (one per material group) — same struct confirmed
   * identical for embedded copies and standalone mesh.pck files (see the Mesh Editor piece/shader
   * ID project memory). Returns null on any bounds/magic failure instead of throwing, so callers
   * can treat an unreadable table as "not editable" rather than crashing.
   */
  private materialTableInfo(meshBlockOffset: number): { groupCount: number; materialTableOffset: number } | null {
    if (!inside(meshBlockOffset, 0x14, this.fileSize) || !isMeshPayloadMagic(u32(this.view, meshBlockOffset))) return null;
    const groupCount = u32(this.view, meshBlockOffset + 0x08);
    if (groupCount < 1 || groupCount > 4096) return null;
    const materialTableOffset = virtualToFile(u32(this.view, meshBlockOffset + 0x0c), this.pointerBase);
    if (!inside(materialTableOffset, groupCount * 2, this.fileSize)) return null;
    return { groupCount, materialTableOffset };
  }

  /**
   * Identifies a *tool-written* embedded block: one that carries the 0x80 mini-header a standalone
   * mesh.pck has, whose `+0x00` pointer resolves to its own payload. Pieces the game shipped
   * embedded are payload-only and never match, so they're never reused, overwritten or moved.
   *
   * This is what makes re-embedding idempotent across sessions: the "is this block mine, and how
   * big is its footprint" answer lives in the file itself (the mini-header's size field), not in
   * session memory, so saving and reopening doesn't lose track and append a duplicate.
   */
  private toolBlockIn(view: DataView, length: number, payloadOffset: number): { base: number; reservedSize: number } | null {
    const base = payloadOffset - MESH_PAYLOAD_OFFSET;
    if (base < 0 || !inside(base, MESH_PAYLOAD_OFFSET + 0x10, length)) return null;
    if (!isMeshPayloadMagic(u32(view, payloadOffset))) return null;
    if (u32(view, base) !== fileToVirtual(payloadOffset, this.pointerBase)) return null;
    const reservedSize = u32(view, base + 0x0c) + MESH_PAYLOAD_OFFSET;
    if (reservedSize < MESH_PAYLOAD_OFFSET + 0x10 || !inside(base, reservedSize, length)) return null;
    return { base, reservedSize };
  }
  private toolBlockAt(payloadOffset: number) { return this.toolBlockIn(this.view, this.fileSize, payloadOffset); }

  /**
   * How many bytes of this file one embedded piece occupies, now and as of the last save, so a
   * change in the car's size can be attributed to the pieces that caused it.
   *
   * Null means the size isn't knowable rather than zero: a piece the game shipped embedded carries
   * no mini-header declaring its extent, and a piece that isn't embedded here occupies nothing.
   */
  embeddedBlockSize(entry: LodMeshEntry): number | null {
    if (entry.meshBlockOffset === null) return null;
    return this.toolBlockAt(entry.meshBlockOffset)?.reservedSize ?? null;
  }
  savedEmbeddedBlockSize(entry: LodMeshEntry): number | null {
    const savedView = new DataView(this.savedBytes.buffer, this.savedBytes.byteOffset, this.savedBytes.byteLength);
    if (!inside(entry.meshPointerSlotOffset, 4, this.savedBytes.byteLength)) return null;
    const pointer = u32(savedView, entry.meshPointerSlotOffset);
    if (sentinel(pointer)) return null;
    return this.toolBlockIn(savedView, this.savedBytes.byteLength, virtualToFile(pointer, this.pointerBase))?.reservedSize ?? null;
  }

  /**
   * Every tool-written block in the file, live or orphaned, in address order. An orphaned block is
   * one no LOD entry points at any more — the dead copy left behind by an earlier re-embed.
   */
  toolBlocks(): { base: number; payloadOffset: number; reservedSize: number; live: boolean }[] {
    if (this.format !== "pck") return [];
    const livePayloads = new Set(this.lodMeshes.map((entry) => entry.meshBlockOffset).filter((offset): offset is number => offset !== null));
    const output: { base: number; payloadOffset: number; reservedSize: number; live: boolean }[] = [];
    for (let payload = MESH_PAYLOAD_OFFSET; payload + 4 <= this.fileSize; payload += APPEND_ALIGNMENT) {
      const block = this.toolBlockAt(payload);
      if (!block) continue;
      output.push({ base: block.base, payloadOffset: payload, reservedSize: block.reservedSize, live: livePayloads.has(payload) });
      // Skip past this block: its geometry can't contain another block header, and scanning inside
      // it only risks a false positive.
      payload = block.base + block.reservedSize - APPEND_ALIGNMENT + MESH_PAYLOAD_OFFSET;
    }
    return output;
  }

  /** Bytes currently held by orphaned tool blocks — dead weight `compactToolBlocks()` can reclaim. */
  get reclaimableBytes() { return this.toolBlocks().filter((block) => !block.live).reduce((sum, block) => sum + block.reservedSize, 0); }

  /** Reads one material group's shader ID from an embedded mesh blob, or null if the group/table
   *  isn't valid (out of range, corrupt pointer, etc.) — used to compare against the standalone
   *  mesh.pck's own value before allowing an edit. */
  readGroupShaderId(meshBlockOffset: number, group: number): number | null {
    const info = this.materialTableInfo(meshBlockOffset);
    if (!info || group < 0 || group >= info.groupCount) return null;
    return u16(this.view, info.materialTableOffset + group * 2);
  }

  /** True when this embedded copy's group slot has a pending (unsaved) shader-ID edit — used to
   *  drive the "pending save" UI indicator without exposing the internal dirtyShaderKeys format. */
  isGroupShaderDirty(meshBlockOffset: number, group: number): boolean {
    const info = this.materialTableInfo(meshBlockOffset);
    if (!info || group < 0 || group >= info.groupCount) return false;
    return this.dirtyShaderKeys.has(String(info.materialTableOffset + group * 2));
  }

  /**
   * Writes a new shader ID into one material group's slot for every embedded copy of a piece
   * (deduplicated by blob offset — a piece can be embedded once per LOD entry that references it).
   * Unlike piece ID, shader ID has no separate LOD-table mirror to keep in sync — it only lives
   * inside each embedded blob's own local material table (see project memory).
   */
  setGroupShaderId(entries: LodMeshEntry[], group: number, newId: number, record = true) {
    if (newId < 0 || newId > 0xffff) throw new Error("Shader ID must be between 0 and 0xFFFF.");
    const seen = new Set<number>();
    const targets: ShaderIdTarget[] = [];
    for (const entry of entries) {
      if (entry.meshBlockOffset === null || seen.has(entry.meshBlockOffset)) continue;
      seen.add(entry.meshBlockOffset);
      const info = this.materialTableInfo(entry.meshBlockOffset);
      if (!info || group >= info.groupCount) throw new Error(`${this.name}: material group ${group} was not found in the embedded copy of this piece.`);
      targets.push({ meshBlockOffset: entry.meshBlockOffset, slotOffset: info.materialTableOffset + group * 2 });
    }
    if (!targets.length) return false;
    const before = targets.map((target) => u16(this.view, target.slotOffset));
    if (before.every((id) => id === newId)) return false;
    for (const target of targets) this.view.setUint16(target.slotOffset, newId, true);
    for (const target of targets) this.refreshShaderDirty(target);
    if (record) {
      this.undoStack.push({ kind: "shaderId", targets, before, after: newId });
      if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
      this.redoStack = [];
    }
    return true;
  }
  /**
   * Overwrites `bytes.length` bytes at `offset` — the Performance tab's field writes. Those fields
   * are plain values with nothing else depending on them here, so this only has to keep "modified"
   * honest. Returns the bytes it replaced: the caller owns the undo, because one edit spans every
   * loaded PCK of the vehicle, each at its own offset.
   */
  writeFieldBytes(offset: number, bytes: Uint8Array): Uint8Array {
    if (!inside(offset, bytes.length, this.fileSize)) throw new Error(`${this.name}: field write at ${hex(offset)} is outside the file.`);
    const before = this.bytes.slice(offset, offset + bytes.length);
    this.bytes.set(bytes, offset);
    const key = `${offset}:${bytes.length}`;
    this.fieldKeys.add(key);
    this.refreshFieldDirty(key);
    return before;
  }
  private refreshFieldDirty(key: string) {
    const [offset, length] = key.split(":").map(Number);
    const unchanged = offset + length <= this.savedBytes.byteLength && this.bytes.subarray(offset, offset + length).every((value, i) => value === this.savedBytes[offset + i]);
    unchanged ? this.dirtyFieldKeys.delete(key) : this.dirtyFieldKeys.add(key);
  }
  private refreshShaderDirty(target: ShaderIdTarget) {
    const key = String(target.slotOffset);
    const current = u16(this.view, target.slotOffset);
    const original = u16(new DataView(this.savedBytes.buffer, this.savedBytes.byteOffset), target.slotOffset);
    current === original ? this.dirtyShaderKeys.delete(key) : this.dirtyShaderKeys.add(key);
  }

  /**
   * Snapshot/restore for embedded-mesh replacement, which changes file length and pointer layout
   * wholesale — cheaper to reason about (and safer) than trying to invert it field by field.
   *
   * Public because one user-visible "update this piece" action can span several role documents at
   * once, and the app's combined undo stack needs to bundle them into a single step. Also used to
   * roll one document back when a multi-entry update fails partway through.
   */
  captureState(): MeshBlobSnapshot {
    return {
      bytes: this.bytes.slice(),
      lodMeshes: this.lodMeshes.map((entry) => ({ ...entry })),
      appendedBlocks: new Map([...this.appendedBlocks].map(([key, value]) => [key, { ...value }])),
    };
  }
  restoreState(snapshot: MeshBlobSnapshot) {
    this.bytes = snapshot.bytes.slice();
    this.view = new DataView(this.bytes.buffer);
    this.lodMeshes.length = 0;
    for (const entry of snapshot.lodMeshes) this.lodMeshes.push({ ...entry });
    this.appendedBlocks = new Map([...snapshot.appendedBlocks].map(([key, value]) => [key, { ...value }]));
    this.refreshMeshBlobDirty();
    // A snapshot can span a piece-ID write too (Sync zeroing a shell's ID), so re-derive those flags
    // from the restored bytes rather than leaving them as they were before the undo.
    for (const entry of this.lodMeshes) this.refreshLodDirty(entry);
    for (const key of this.fieldKeys) this.refreshFieldDirty(key);
  }
  /** Recomputes which embedded meshes differ from the last-saved bytes. File length alone can't
   *  tell us which piece changed, so this compares each entry's current pointer/blob against the
   *  saved image and treats "can't be found in the saved bytes" as dirty. */
  private refreshMeshBlobDirty() {
    this.dirtyMeshBlobs.clear();
    if (this.bytes.byteLength !== this.savedBytes.byteLength) {
      for (const key of this.appendedBlocks.keys()) {
        const [lod, indexText] = key.split(":") as [LodLevel, string];
        const entry = this.lodMeshes.find((item) => item.lod === lod && item.index === Number(indexText));
        if (entry) this.dirtyMeshBlobs.add(entry.name || key);
      }
      return;
    }
    const savedView = new DataView(this.savedBytes.buffer, this.savedBytes.byteOffset);
    for (const [key, block] of this.appendedBlocks) {
      const [lod, indexText] = key.split(":") as [LodLevel, string];
      const entry = this.lodMeshes.find((item) => item.lod === lod && item.index === Number(indexText));
      if (!entry) continue;
      // A same-size re-embed (a UV-only change, say) rewrites its block in place and leaves the
      // pointer alone, so the block's own bytes have to be compared too.
      if (u32(this.view, entry.meshPointerSlotOffset) !== u32(savedView, entry.meshPointerSlotOffset) || !sameRange(this.bytes, this.savedBytes, block.offset, block.reservedSize)) this.dirtyMeshBlobs.add(entry.name || key);
    }
  }

  /**
   * Replaces one LOD entry's embedded mesh blob with a standalone mesh.pck's bytes, handling the
   * case where the new piece is a different size than the one it replaces.
   *
   * Always appends the new copy at the end of the file and repoints the entry's PTR_Mesh slot at
   * it — never resizes a blob in place. That's deliberate: the append path is the only strategy
   * with real production validation behind it (13 logged runs of the precedent Python tool, all
   * append), while that tool's in-place-resize paths were never exercised even by their own
   * author. The bytes of the blob being replaced are simply abandoned where they are; nothing
   * points at them afterwards, and leaving them avoids moving everything that follows.
   *
   * A block this same session already appended for this entry is reused when the new piece still
   * fits, so repeatedly updating one piece doesn't grow the file every time.
   */
  replaceEmbeddedMesh(entry: LodMeshEntry, pieceSource: Uint8Array, record = true) {
    if (this.format !== "pck") throw new Error("Embedded mesh replacement is only supported for PS2 .pck files.");
    const target = this.lodMeshes.find((item) => item.lod === entry.lod && item.index === entry.index);
    if (!target) throw new Error(`${this.name} has no ${entry.lod.toUpperCase()} entry #${entry.index}.`);
    // A row whose PTR_Mesh is still 0 is a piece the game streams from the loose mesh.pck instead.
    // Filling it in is a genuine insertion, and it's safe precisely because the row already exists:
    // the name and ID slots are already there, so only the mesh pointer has to be written. Creating
    // a row from scratch would mean growing the tables and the string blob, which nothing here (nor
    // the precedent tool) does — callers should keep such pieces out rather than expect it.
    const inserting = target.meshBlockOffset === null;

    const piece = pieceSource.slice();
    if (piece.byteLength < MESH_PAYLOAD_OFFSET + 0x14) throw new Error("The mesh file is too small to be a standalone piece.");
    // The LOD table's ID is authoritative (the loose file's own byte is often a stale placeholder
    // mid-workflow — see project memory), so stamp it into the copy being embedded rather than
    // letting the loose file's value silently become the in-game ID.
    new DataView(piece.buffer, piece.byteOffset, piece.byteLength).setUint16(MESH_PAYLOAD_OFFSET + MESH_ID_BYTE, target.meshId & 0xffff, true);
    const relocs = scanMeshRelocs(piece);

    const before = this.captureState();
    const key = lodKey(target.lod, target.index);
    // Re-embedding the identical piece writes over the block it already occupies, which is what
    // keeps repeated re-embeds from growing the file. Any change in size goes to the end of the
    // file instead, leaving the old block orphaned for the compaction pass at save to reclaim.
    //
    // Writing a smaller piece into the larger block it replaces would look tidier, but every block
    // declares its own length and they have to tile the region for compaction to be safe; a short
    // piece in a long block would leave a hole nothing accounts for. Going through append-and-
    // reclaim instead means a piece that shrinks actually gives its bytes back.
    const current = target.meshBlockOffset === null ? null : this.toolBlockAt(target.meshBlockOffset);
    const inPlace = current !== null && piece.byteLength === current.reservedSize;
    const blockOffset = inPlace ? current.base : align(this.bytes.byteLength, APPEND_ALIGNMENT);
    const reservedSize = piece.byteLength;
    const placement: "in-place" | "appended" = inPlace ? "in-place" : "appended";

    const requiredLength = blockOffset + reservedSize;
    if (requiredLength > this.bytes.byteLength) {
      const grown = new Uint8Array(requiredLength);
      grown.set(this.bytes);
      this.bytes = grown;
      this.view = new DataView(this.bytes.buffer);
    }
    this.bytes.set(piece, blockOffset);

    const newBaseVa = fileToVirtual(blockOffset, this.pointerBase);
    const newPayloadVa = (newBaseVa + MESH_PAYLOAD_OFFSET) >>> 0;
    // Keep the relocated piece's own mini-header coherent: payload pointer, then the block's exact
    // length. That length is what identifies this block as one a tool wrote and how far it runs,
    // so it has to describe the piece precisely for blocks to keep tiling the region.
    this.view.setUint32(blockOffset + 0x00, newPayloadVa, true);
    this.view.setUint32(blockOffset + 0x0c, (reservedSize - MESH_PAYLOAD_OFFSET) >>> 0, true);
    for (const reloc of relocs) this.view.setUint32(blockOffset + reloc.slotOffset, (newBaseVa + reloc.targetOffset) >>> 0, true);
    // Point the LOD table at the payload (not the block base) — that's what the engine reads.
    this.view.setUint32(target.meshPointerSlotOffset, newPayloadVa, true);
    // The PCK header's own size field must track the (possibly grown) file.
    this.view.setUint32(0x0c, (this.bytes.byteLength - MESH_PAYLOAD_OFFSET) >>> 0, true);

    target.meshPointer = newPayloadVa;
    // meshBlockOffset tracks the PAYLOAD (where the mesh magic sits), not the block base — every
    // other reader (readGroupShaderId, the piece-ID byte, mapLodTables itself) is payload-relative.
    target.meshBlockOffset = blockOffset + MESH_PAYLOAD_OFFSET;
    this.appendedBlocks.set(key, { offset: blockOffset, reservedSize });
    this.refreshMeshBlobDirty();

    if (record) {
      this.undoStack.push({ kind: "meshBlob", before, after: this.captureState() });
      if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
      this.redoStack = [];
    }
    return { blockOffset, payloadOffset: blockOffset + MESH_PAYLOAD_OFFSET, payloadVa: newPayloadVa, bytesWritten: piece.byteLength, reservedSize, placement, inserting, reused: placement !== "appended", relocations: relocs.length, fileSize: this.bytes.byteLength };
  }

  /**
   * Works out what compaction would produce, without doing it.
   *
   * Both the real compaction and the size shown in the UI read this, so the number a user sees
   * before saving is arrived at by the same arithmetic that will actually run — they can't drift
   * apart into a projection that promises a size the save doesn't deliver.
   *
   * Returns null when compaction would decline: nothing to reclaim, or a layout it can't account
   * for. Every block must sit at or just past the end of the previous one (16-byte alignment
   * padding aside) and the last must reach the end of the file; anything else means there is
   * content between the blocks this doesn't understand, and the file is left alone.
   */
  private planCompaction(): { regionStart: number; live: { base: number; payloadOffset: number; reservedSize: number }[]; placements: number[]; finalSize: number } | null {
    if (this.format !== "pck") return null;
    const blocks = this.toolBlocks();
    if (!blocks.length || !blocks.some((block) => !block.live)) return null;

    const regionStart = blocks[0].base;
    let cursor = regionStart;
    for (const block of blocks) {
      if (block.base < cursor || block.base - cursor >= APPEND_ALIGNMENT) return null;
      cursor = block.base + block.reservedSize;
    }
    if (this.fileSize - cursor >= APPEND_ALIGNMENT) return null;

    const live = blocks.filter((block) => block.live);
    const placements: number[] = [];
    let writeCursor = regionStart;
    for (const block of live) {
      const start = align(writeCursor, APPEND_ALIGNMENT);
      placements.push(start);
      writeCursor = start + block.reservedSize;
    }
    return { regionStart, live, placements, finalSize: writeCursor };
  }

  /**
   * The size this file will have once saved.
   *
   * Editing leaves dead copies behind — a piece that changed size is appended and its old block
   * orphaned — and those are only cleared when saving. Reporting the raw byte length in the
   * meantime would show a file briefly growing even when the change made it smaller, so anything
   * displaying a size uses this instead.
   */
  get projectedSize() { return this.planCompaction()?.finalSize ?? this.fileSize; }

  /**
   * Reclaims the space held by orphaned tool blocks — the dead copies left behind whenever a piece
   * was re-embedded before reuse worked across sessions.
   *
   * Only ever rewrites the run of tool-written blocks, and only when that run is provably
   * contiguous all the way to the end of the file: everything below the first tool block is
   * original game data that isn't touched, and refusing when the run isn't contiguous means a file
   * with unrecognized data interleaved is left completely alone rather than guessed at. Returns
   * null when there's nothing to do or when it isn't safe, so the caller can just skip it.
   */
  compactToolBlocks(): { reclaimedBytes: number; movedBlocks: number; sizeBefore: number; sizeAfter: number } | null {
    const plan = this.planCompaction();
    if (!plan) return null;

    const sizeBefore = this.fileSize;
    const { regionStart, live, placements } = plan;
    const output = new Uint8Array(this.fileSize);
    output.set(this.bytes.subarray(0, regionStart));
    const rebuilt = placements;
    live.forEach((block, index) => output.set(this.bytes.subarray(block.base, block.base + block.reservedSize), placements[index]));

    this.bytes = output.slice(0, plan.finalSize);
    this.view = new DataView(this.bytes.buffer);

    // Rebase each moved block's internal pointers and repoint the LOD entry that owns it.
    live.forEach((block, index) => {
      const newBase = rebuilt[index];
      const newPayloadVa = fileToVirtual(newBase + MESH_PAYLOAD_OFFSET, this.pointerBase);
      const relocs = scanMeshRelocs(this.bytes.subarray(newBase, newBase + block.reservedSize));
      this.view.setUint32(newBase + 0x00, newPayloadVa, true);
      for (const reloc of relocs) this.view.setUint32(newBase + reloc.slotOffset, (fileToVirtual(newBase, this.pointerBase) + reloc.targetOffset) >>> 0, true);
      for (const entry of this.lodMeshes) {
        if (entry.meshBlockOffset !== block.payloadOffset) continue;
        this.view.setUint32(entry.meshPointerSlotOffset, newPayloadVa, true);
        entry.meshPointer = newPayloadVa;
        entry.meshBlockOffset = newBase + MESH_PAYLOAD_OFFSET;
      }
    });
    this.view.setUint32(0x0c, (this.fileSize - MESH_PAYLOAD_OFFSET) >>> 0, true);
    this.appendedBlocks.clear();
    this.refreshMeshBlobDirty();
    // Compaction runs as part of saving, not as a user edit — it deliberately leaves undo history
    // alone, since there's nothing meaningful to step back to once the file is on disk.
    return { reclaimedBytes: sizeBefore - this.fileSize, movedBlocks: live.length, sizeBefore, sizeAfter: this.fileSize };
  }

  private applyPieceIdTargets(targets: PieceIdTarget[], ids: number[]) {
    targets.forEach((target, i) => {
      const id = ids[i];
      const upper = u32(this.view, target.idSlotOffset) & 0xffff0000;
      this.view.setUint32(target.idSlotOffset, upper | (id & 0xffff), true);
      if (target.meshBlockOffset !== null) this.view.setUint8(target.meshBlockOffset + 0x06, id & 0xff);
      const entry = this.lodMeshes.find((item) => item.lod === target.lod && item.index === target.index);
      if (entry) entry.meshId = id;
    });
  }
  private refreshLodDirty(target: PieceIdTarget) {
    const key = lodKey(target.lod, target.index);
    const current = u16(this.view, target.idSlotOffset);
    const original = new DataView(this.savedBytes.buffer, this.savedBytes.byteOffset).getUint16(target.idSlotOffset, true);
    current === original ? this.dirtyLodKeys.delete(key) : this.dirtyLodKeys.add(key);
  }

  undo() {
    const entry = this.undoStack.pop(); if (!entry) return null;
    if (entry.kind === "anchor") { this.setAnchors(entry.index, entry.before[0], entry.before[1], false); this.redoStack.push(entry); return entry.index; }
    if (entry.kind === "anchorGroup") {
      // Unwind in reverse: a batch may legitimately touch the same anchor twice, and only the
      // last-to-first order restores the value it held before the batch started.
      for (let i = entry.moves.length - 1; i >= 0; i -= 1) { const move = entry.moves[i]!; this.setAnchors(move.index, move.before[0], move.before[1], false); }
      this.redoStack.push(entry);
      return entry.moves[0]?.index ?? null;
    }
    if (entry.kind === "meshBlob") { this.restoreState(entry.before); this.redoStack.push(entry); return null; }
    if (entry.kind === "shaderId") {
      entry.targets.forEach((target, i) => this.view.setUint16(target.slotOffset, entry.before[i], true));
      for (const target of entry.targets) this.refreshShaderDirty(target);
      this.redoStack.push(entry);
      return null;
    }
    this.applyPieceIdTargets(entry.targets, entry.before);
    for (const target of entry.targets) this.refreshLodDirty(target);
    this.redoStack.push(entry);
    return null;
  }
  redo() {
    const entry = this.redoStack.pop(); if (!entry) return null;
    if (entry.kind === "anchor") { this.setAnchors(entry.index, entry.after[0], entry.after[1], false); this.undoStack.push(entry); return entry.index; }
    if (entry.kind === "anchorGroup") {
      for (const move of entry.moves) this.setAnchors(move.index, move.after[0], move.after[1], false);
      this.undoStack.push(entry);
      return entry.moves[0]?.index ?? null;
    }
    if (entry.kind === "meshBlob") { this.restoreState(entry.after); this.undoStack.push(entry); return null; }
    if (entry.kind === "shaderId") {
      for (const target of entry.targets) this.view.setUint16(target.slotOffset, entry.after, true);
      for (const target of entry.targets) this.refreshShaderDirty(target);
      this.undoStack.push(entry);
      return null;
    }
    this.applyPieceIdTargets(entry.targets, entry.targets.map(() => entry.after));
    for (const target of entry.targets) this.refreshLodDirty(target);
    this.undoStack.push(entry);
    return null;
  }
  markSaved() {
    this.pieces.forEach((piece, i) => { this.savedAnchors[i] = [cloneVec(piece.a1), cloneVec(piece.a2)]; });
    this.savedBytes = this.bytes.slice();
    this.dirtyIndices.clear();
    this.dirtyLodKeys.clear();
    this.dirtyShaderKeys.clear();
    // appendedBlocks deliberately survives: those blocks are still ours to reuse after saving,
    // so updating the same piece again overwrites them instead of growing the file each time.
    this.dirtyMeshBlobs.clear();
    this.dirtyFieldKeys.clear();
  }
  resetToSaved() { return new PckDocument(this.name, this.savedBytes.slice().buffer as ArrayBuffer); }
  clone() { return new PckDocument(this.name, this.bytes.slice().buffer as ArrayBuffer); }
  assertAnchorCompatibility(source: PckDocument, indices: Iterable<number> = source.pieces.map((piece) => piece.index)) {
    if (this.format !== source.format) throw new Error(`${this.name} uses ${this.format.toUpperCase()}, but ${source.name} uses ${source.format.toUpperCase()}.`);
    if (this.pieces.length !== source.pieces.length) throw new Error(`${this.name} has ${this.pieces.length} anchors; ${source.name} has ${source.pieces.length}.`);
    for (const index of indices) {
      const target = this.pieces[index];
      const origin = source.pieces[index];
      if (!target || !origin || target.name !== origin.name) {
        throw new Error(`Anchor #${index.toString(16).toUpperCase().padStart(4, "0")} does not match between ${source.name} and ${this.name}.`);
      }
    }
  }
  syncAnchorsFrom(source: PckDocument, indices: Iterable<number> = source.dirtyIndices) {
    const selected = [...indices];
    this.assertAnchorCompatibility(source, selected);
    for (const index of selected) {
      // A wheel follower is rewritten by its axle's own setAnchors, never on its own.
      if (this.wheelFollowers.has(index)) continue;
      const piece = source.pieces[index];
      this.setAnchors(index, piece.a1, piece.a2, false);
    }
    return selected.length;
  }
  blob() { return new Blob([this.bytes.slice().buffer as ArrayBuffer], { type: "application/octet-stream" }); }
  pieceHex(index: number) { const piece = this.pieces[index]; return hexDump(this.bytes.slice(piece.fileOffset, piece.fileOffset + this.layout.itemSize), piece.fileOffset); }
  runtimeFor(index: number) {
    const output: string[] = [];
    const exhaust = this.exhaustLinks.get(index);
    if (exhaust !== undefined) { const slot = this.exhaustSlots[exhaust]; output.push(`Exhaust runtime · slot ${exhaust} · VA ${hex(slot.virtualAddress)} · ${slot.note}`); }
    const wheel = this.wheelLinks.get(index);
    if (wheel !== undefined) { const slot = this.wheelSlots[wheel]; output.push(`Wheel runtime · slot ${wheel} · VA ${hex(slot.virtualAddress)} · ${slot.note}`); }
    const follows = this.wheelFollowers.get(index);
    if (follows !== undefined) { const owner = this.wheelSlots[follows].anchorIndex; output.push(`Wheel runtime · slot ${follows} · follows ${owner === null ? "its axle" : this.pieces[owner].name}`); }
    return output;
  }
}

export function hex(value: number, width = 8) { return `0x${value.toString(16).toUpperCase().padStart(width, "0")}`; }

export function hexDump(bytes: Uint8Array, base = 0) {
  const lines: string[] = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const chunk = bytes.slice(i, i + 16);
    const values = [...chunk].map((n) => n.toString(16).toUpperCase().padStart(2, "0")).join(" ").padEnd(47, " ");
    const ascii = [...chunk].map((n) => n >= 32 && n <= 126 ? String.fromCharCode(n) : ".").join("");
    lines.push(`${(base + i).toString(16).toUpperCase().padStart(8, "0")}  ${values}  ${ascii}`);
  }
  return lines.join("\n");
}

export function formatClipboard(a1: Vec3, a2: Vec3) {
  return `A1: ${a1.map((n) => n.toFixed(5)).join(" ")}\nA2: ${a2.map((n) => n.toFixed(5)).join(" ")}`;
}

export function parseClipboard(value: string): [Vec3, Vec3] {
  const withoutLabels = value.replace(/\bA[12]\b/gi, "");
  const numbers = withoutLabels.match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g)?.map(Number).filter(Number.isFinite) ?? [];
  if (numbers.length !== 6) throw new Error("Clipboard must contain exactly six numbers: A1 X Y Z and A2 X Y Z.");
  return [[numbers[0], numbers[1], numbers[2]], [numbers[3], numbers[4], numbers[5]]];
}
