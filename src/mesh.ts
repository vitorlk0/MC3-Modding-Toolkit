import type { LodLevel, LodMeshEntry, PckDocument, Piece, Vec3 } from "./pck";

export type MeshGeometry = {
  name: string;
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  /** One shader/material ID per vertex (parallel to positions/normals) — every vertex in a given
   *  packet belongs to a single material group, so this is enough to color and pick by shader. */
  vertexShaderIds: Uint16Array;
  /** Material group index (into groupShaderIds/groupShaderOffsets) each vertex belongs to — lets
   *  triangle picking find which group's shader slot to edit, not just its current shader value. */
  vertexGroupIndices: Uint16Array;
  /** Shader ID assigned to each material group, in group order. */
  groupShaderIds: number[];
  /** File offset of each group's u16 shader-ID slot within this mesh.pck's own bytes, parallel to
   *  groupShaderIds — where MeshPckDocument writes when a group's shader is edited. */
  groupShaderOffsets: number[];
  /** True per group when this mesh.pck's own bytes differ from its last-saved bytes at that
   *  group's offset — always false fresh out of parseMeshPck (which has no notion of "saved");
   *  MeshPckDocument overwrites this after every edit/save so the UI can show "pending save". */
  groupShaderDirty: boolean[];
  /** The piece's own ID field, read from the mesh blob header — the same value as the
   *  HLOD/MLOD/LLOD table entry and this field mirrored in any embedded copy (modding KB §5.6).
   *  Unrelated to `Piece.pieceId` on anchors, which is only the row's own index. */
  meshId: number;
  /** File offset of the meshId byte within this mesh.pck's own bytes — where MeshPckDocument
   *  writes when the piece ID is edited. */
  idByteOffset: number;
  /** Two floats per vertex (parallel to positions), as stored: raw / 4096, no V flip applied. */
  uvs: Float32Array;
  /** Packets whose UVs couldn't be decoded and were zero-filled — the 0x66 UV variant, which is
   *  still an open problem in the knowledge base, or a packet with no UV stream at all. */
  uvZeroedPackets: number;
  /** "loose" for a standalone mesh.pck. "embedded" for a piece read straight out of a car PCK
   *  because no loose file exists for it — the only copy is the one baked into the car. */
  origin: "loose" | "embedded";
  /** LOD level an embedded piece was read from; null for loose files. */
  lod: LodLevel | null;
  materialGroups: number;
  packetVertices: number;
  triangles: number;
  category: string;
  stock: boolean;
  anchorIndex: number | null;
};

type PacketVertex = { xyz: Vec3; normal: Vec3; uv: [number, number]; faceEnabled: boolean };

const PAYLOAD_OFFSET = 0x80;
const MAGIC = [0x98, 0x0f, 0x7a, 0x00];
const BLOCK_HEADERS = new Set(["9800026c", "c501026c"]);
const FOOTERS = new Set(["9800000406000014", "c501000406000014"]);
const VERTEX_MARKERS = new Set(["238:105", "539:105"]);
// The damage stream is a V4-8 unpack (0x6E, 4 bytes a vertex) or the same unpack with the mask bit
// set (0x7E): after STMASK 0x55555555 + STROW every vertex takes the row constant and the stream
// carries no payload at all. Motorcycles use the masked form almost everywhere.
const DAMAGE_MARKERS = new Set(["16664:110", "16965:110", "16664:126", "16965:126"]);
const DAMAGE_MASKED = 0x7e;
const NORMAL_MARKERS = new Set(["154:106", "455:106"]);
// C4/1F1 with kind 0x65 is the plain u16-pair stream the OBJ->PCK writer emits; kind 0x66 (also
// under 1FC) shows up in original game meshes and isn't decoded yet (KB §23.5).
const UV_MARKERS = new Set(["196:101", "497:101", "196:102", "497:102", "508:102"]);
const UV_KIND_PLAIN = 0x65;
const UV_FIXED_SCALE = 4096;

const align = (value: number, alignment: number) => value + ((alignment - value % alignment) % alignment);
const inside = (offset: number, size: number, total: number) => offset >= 0 && size >= 0 && offset + size <= total;
const u16 = (view: DataView, offset: number) => view.getUint16(offset, true);
const s16 = (view: DataView, offset: number) => view.getInt16(offset, true);
const u32 = (view: DataView, offset: number) => view.getUint32(offset, true);
const f32 = (view: DataView, offset: number) => view.getFloat32(offset, true);
const signed8 = (value: number) => value >= 128 ? value - 256 : value;
const markerKey = (view: DataView, offset: number) => `${u16(view, offset)}:${view.getUint8(offset + 3)}`;
const bytesKey = (bytes: Uint8Array, offset: number, length: number) => [...bytes.slice(offset, offset + length)].map((value) => value.toString(16).padStart(2, "0")).join("");
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const lengthSquared = (value: Vec3) => dot(value, value);
function normalize(value: Vec3): Vec3 {
  const length = Math.sqrt(lengthSquared(value));
  return length > 1e-20 && Number.isFinite(length) ? [value[0] / length, value[1] / length, value[2] / length] : [0, 0, 1];
}
function magicAt(bytes: Uint8Array, offset: number) { return MAGIC.every((value, index) => bytes[offset + index] === value); }
/** Any mesh magic of the 0x007Axxxx family (0x007A22A0 in DUB cars, 0x007A1198 in SL500/SL55 —
 *  same layout, see `isMeshPayloadMagic` in pck.ts). Only trusted at the two fixed places a piece
 *  starts; the fallback scan keeps the exact standard magic, so it can't lock onto stray data. */
function familyMagicAt(bytes: Uint8Array, offset: number) {
  return offset + 4 <= bytes.length && bytes[offset + 2] === 0x7a && bytes[offset + 3] === 0x00 && (bytes[offset] | bytes[offset + 1]) !== 0;
}
function findMagic(bytes: Uint8Array) {
  for (let offset = 0; offset <= bytes.length - MAGIC.length; offset += 1) if (magicAt(bytes, offset)) return offset;
  return -1;
}
function meshCategory(name: string) {
  const stem = name.toLowerCase().replace(/\.mesh\.pck$/, "");
  if (stem.startsWith("vroot_tk_splr_")) return "splr";
  const match = stem.match(/^vroot_([^_]+)/);
  return match?.[1] ?? "other";
}

// Human-friendly labels for the naming-prefix conventions documented in the modding knowledge
// base. Categories not in this map (rare/car-specific prefixes) fall back to the raw prefix.
const CATEGORY_LABELS: Record<string, string> = {
  bumf: "Bumper Front", bmpf: "Bumper Front", bumr: "Bumper Rear",
  hd: "Hood", ss: "Side Skirt", splr: "Spoiler",
  tl: "Tail Light", hl: "Headlight", whl: "Wheel", axl: "Axle",
  trunk: "Trunk", window: "Window", decal: "Decal", shell: "Shell",
  lodgroup: "LOD Group", neonglow: "Neon Glow", other: "Other",
};

export function categoryLabel(category: string) {
  return CATEGORY_LABELS[category] ?? category.replace(/^[a-z]/, (c) => c.toUpperCase());
}

/** Body pieces that every version of the car carries, as opposed to the customization parts only
 *  the garage model needs. In the cars seen so far these all sit under the `lodgroup` prefix
 *  (shell/windows/interior/llod), but the keywords catch cars that name them some other way. */
const SHELL_KEYWORDS = ["shell", "window", "decal", "mirror", "interior"];

/**
 * True for pieces that belong on the Player and Opponent cars too, not just the garage one.
 * Decides where a piece gets embedded when it isn't embedded anywhere yet: shell-family pieces go
 * into every PCK that has a table row for them, everything else goes into the garage PCK alone.
 */
export function isShellFamily(meshName: string) {
  const stem = meshName.toLowerCase().replace(/\.mesh\.pck$/, "").replace(/\.pck$/, "");
  return meshCategory(meshName) === "lodgroup" || SHELL_KEYWORDS.some((keyword) => stem.includes(keyword));
}

function anchorDepth(document: PckDocument, index: number) {
  let depth = 0;
  for (let cursor = document.pieces[index].parentIndex; cursor !== null && depth < 256; cursor = document.pieces[cursor].parentIndex) depth += 1;
  return depth;
}

/**
 * The anchor a piece hangs from. A piece name spells its anchor path from the root —
 * `vroot_trunk_trunk_LOD_trunk_h` is the trunk anchor's, `vroot_Suspension_Arm_Rear_L_Rear_L` the
 * rear arm's — so the path is followed down the tree for as long as a child's name continues it.
 * Names that don't start at a root fall back to any anchor name inside them, deepest first.
 * (Picking the longest name found anywhere put trunks on vroot and rear arms on Suspension, whose
 * names happen to be just as long.)
 */
export function matchMeshAnchor(name: string, document: PckDocument) {
  const stem = name.toLowerCase().replace(/\.pck$/, "").replace(/\.mesh$/, "");
  for (const root of document.roots) {
    const rootName = document.pieces[root].name.toLowerCase();
    if (stem !== rootName && !stem.startsWith(`${rootName}_`)) continue;
    let node = root;
    let rest = stem.slice(rootName.length + 1);
    for (;;) {
      const next = (document.children.get(node) ?? [])
        .map((index) => ({ index, name: document.pieces[index].name.toLowerCase() }))
        .filter((child) => child.name && (rest === child.name || rest.startsWith(`${child.name}_`)))
        .sort((a, b) => b.name.length - a.name.length)[0];
      if (!next) return node;
      node = next.index;
      rest = rest.slice(next.name.length + 1);
    }
  }
  const padded = `_${stem}_`;
  const hits = document.pieces.filter((piece) => piece.name && padded.includes(`_${piece.name.toLowerCase()}_`));
  hits.sort((a, b) => anchorDepth(document, b.index) - anchorDepth(document, a.index) || b.name.length - a.name.length);
  return hits[0]?.index ?? null;
}

/**
 * Finds every HLOD/MLOD/LLOD table row whose Mesh_Name matches a loose mesh.pck's filename.
 * Matches by exact name equality (case-insensitive fallback) — the same criterion the precedent
 * mc3_fix_parts_ids tool uses — not by substring, which is unreliable for this purpose. Can
 * legitimately return more than one entry (a piece can appear in HLOD and MLOD, sometimes with
 * different IDs); callers must treat >1 result as ambiguous rather than picking one silently.
 */
export function matchLodEntries(pieceFileName: string, document: PckDocument): LodMeshEntry[] {
  const stem = pieceFileName.replace(/\.pck$/i, "");
  const exact = document.lodMeshes.filter((entry) => entry.name === stem);
  if (exact.length) return exact;
  const lower = stem.toLowerCase();
  return document.lodMeshes.filter((entry) => entry.name.toLowerCase() === lower);
}

/**
 * The anchor a piece hangs from. Its piece ID *is* that anchor's row index — the LOD-table ID equals
 * the anchor the name spells in 5,437 of 5,459 rows across the HostFS cars, and the rest are repeated
 * anchor names and IDs borrowed by mods — which is why a shell given a tail light's ID vanishes with
 * the tail light (modding KB §5.4). Motorcycle pieces (`spindle_front`, `chain`) carry no anchor in
 * their names at all, so the ID is the only way to place them. The table's value wins; an embedded
 * blob's own byte is next; the name is the fallback for a loose file with no table row.
 */
function hostAnchor(name: string, document: PckDocument, embeddedId: number | null) {
  const ids = new Set(matchLodEntries(name, document).map((entry) => entry.meshId));
  const id = ids.size === 1 ? [...ids][0] : embeddedId;
  return id !== null && id < document.pieces.length ? id : matchMeshAnchor(name, document);
}

/**
 * True for a piece the game only draws at a distance — an MLOD/LLOD body or group. Several cars
 * (300C, Bel Air) ship those as loose files named like stock parts, and drawn next to the HLOD they
 * read as one low-poly car with flat blocks for wheels. Embedded pieces know their level; a loose
 * file goes by its LOD-table rows, and by its name when no table lists it.
 */
export function isLowLodOnly(mesh: MeshGeometry, document: PckDocument | null) {
  if (mesh.lod) return mesh.lod !== "hlod";
  const entries = document ? matchLodEntries(mesh.name, document) : [];
  if (entries.length) return !entries.some((entry) => entry.lod === "hlod");
  return /(?:^|_)[ml]lod(?:_|\.|$)/i.test(mesh.name);
}

/** True when a car ships customization variants, which mark their stock choice with `stk` in
 *  the name (`vroot_bmpf_bone_bumpf_stk_srt4_…`). Exotics like the Viper, Gallardo or Esprit have
 *  no variants and no `stk` anywhere — every loose piece of theirs is fixed geometry and belongs in
 *  the default view, where on a tuner only the stock variant of each slot does. */
export const hasStockVariants = (meshes: MeshGeometry[]) => meshes.some((mesh) => mesh.origin === "loose" && /(?:^|_)stk(?:_|\.)/i.test(mesh.name));

/** The flat ground shadows (neonglow.mesh, Shadow_Neon, shadow*): real pieces, but drawn in the
 *  viewer they are a big plane under the car rather than part of it. */
export const isShadowPlane = (name: string) => /neonglow|shadow/i.test(name);

export type PieceIdInfo = {
  /** The ID to show/edit — the HLOD/MLOD/LLOD table's value when there's a clean match, since
   *  that's what the engine actually reads. Falls back to the standalone file's own byte only
   *  when there's no usable table match. */
  displayId: number;
  editable: boolean;
  entries: LodMeshEntry[];
  /** True when the standalone mesh.pck's own ID byte disagrees with the table. Common and
   *  expected for pieces mid-way through the "borrow another piece's ID to preview, then revert
   *  to 0 before final export" workflow documented in the modding KB — not necessarily a bug. */
  standaloneMismatch: boolean;
};

export function resolvePieceId(meshName: string, standaloneId: number, document: PckDocument | null): PieceIdInfo {
  if (!document) return { displayId: standaloneId, editable: false, entries: [], standaloneMismatch: false };
  const entries = matchLodEntries(meshName, document);
  if (entries.length === 0) return { displayId: standaloneId, editable: false, entries, standaloneMismatch: false };
  const ids = new Set(entries.map((entry) => entry.meshId));
  if (ids.size > 1) return { displayId: standaloneId, editable: false, entries, standaloneMismatch: false };
  const tableId = entries[0].meshId;
  return { displayId: tableId, editable: true, entries, standaloneMismatch: tableId !== standaloneId };
}

export type ShaderIdInfo = {
  /** The ID to show/edit — the embedded copies' value when there's a clean, unambiguous match
   *  (a piece can be embedded once per LOD level that references it, and all confirmed real cases
   *  keep those copies byte-identical — see project memory). Falls back to the standalone file's
   *  own value when there's no embedded copy to compare against. */
  displayId: number;
  editable: boolean;
  /** Every matched HLOD/MLOD/LLOD entry whose embedded blob has this material group — what an edit
   *  will write into, alongside the standalone mesh.pck. */
  entries: LodMeshEntry[];
  /** True when the standalone mesh.pck's own value disagrees with the (unambiguous) embedded value. */
  standaloneMismatch: boolean;
  /** True when the *displayed* value isn't committed to disk yet for whatever source it came from —
   *  either the currently-shown role's own embedded slot has a pending edit, or (when there's no
   *  embedded copy to show instead) the standalone mesh.pck's own bytes have a pending edit. Drives
   *  the "pending save" chip color; goes false everywhere once Save writes and re-syncs everything. */
  dirty: boolean;
};

/**
 * Resolves one material group's shader ID the same way resolvePieceId resolves the piece ID: prefer
 * the embedded copies (what the engine actually reads when the piece is embedded), fall back to the
 * standalone byte, and refuse to edit when multiple embedded copies disagree on the value rather than
 * silently picking one (mirrors the piece-ID "Inconsistent ID" safety lock).
 */
export function resolveGroupShaderId(meshName: string, group: number, mesh: MeshGeometry, document: PckDocument | null): ShaderIdInfo {
  const standaloneId = mesh.groupShaderIds[group];
  const standaloneDirty = mesh.groupShaderDirty[group] ?? false;
  if (!document) return { displayId: standaloneId, editable: true, entries: [], standaloneMismatch: false, dirty: standaloneDirty };
  const entries = matchLodEntries(meshName, document).filter((entry) => entry.meshBlockOffset !== null);
  if (entries.length === 0) return { displayId: standaloneId, editable: true, entries, standaloneMismatch: false, dirty: standaloneDirty };
  const values = entries.map((entry) => document.readGroupShaderId(entry.meshBlockOffset!, group));
  if (values.some((value) => value === null)) return { displayId: standaloneId, editable: false, entries, standaloneMismatch: false, dirty: standaloneDirty };
  const distinct = new Set(values);
  if (distinct.size > 1) return { displayId: standaloneId, editable: false, entries, standaloneMismatch: false, dirty: standaloneDirty };
  const embeddedId = values[0]!;
  const embeddedDirty = entries.some((entry) => document.isGroupShaderDirty(entry.meshBlockOffset!, group));
  return { displayId: embeddedId, editable: true, entries, standaloneMismatch: embeddedId !== standaloneId, dirty: embeddedDirty };
}

export function anchorWorldPosition(document: PckDocument, index: number, anchor: "a1" | "a2" = "a1") {
  const output: Vec3 = [0, 0, 0];
  const seen = new Set<number>();
  let cursor: number | null = index;
  while (cursor !== null && !seen.has(cursor)) {
    seen.add(cursor);
    const piece: Piece = document.pieces[cursor];
    const isRuntimeAbsolute = document.wheelLinks.has(cursor) || document.wheelFollowers.has(cursor) || document.exhaustLinks.has(cursor);
    // TBL_Wheels and TBL_Exhausts always store their world position in the raw A1 field (a wheel
    // follower's raw A1 mirrors its axle's slot, so it is absolute the same way),
    // regardless of which anchor is being accumulated for the caller, and that value
    // replaces the normal parent accumulation boundary rather than inheriting from above it.
    const position = isRuntimeAbsolute ? piece.a1 : piece[anchor];
    output[0] += position[0]; output[1] += position[1]; output[2] += position[2];
    if (isRuntimeAbsolute) break;
    cursor = piece.parentIndex;
  }
  return output;
}

/** The anchor rotations a piece inherits, root first, over the same chain anchorWorldPosition
 *  walks (it stops at a runtime-positioned wheel or exhaust the same way). Each is Euler radians. */
export function anchorRotationChain(document: PckDocument, index: number): Vec3[] {
  const output: Vec3[] = [];
  const seen = new Set<number>();
  let cursor: number | null = index;
  while (cursor !== null && !seen.has(cursor)) {
    seen.add(cursor);
    const piece: Piece = document.pieces[cursor];
    if (piece.rotation.some((value) => value !== 0)) output.unshift(piece.rotation);
    if (document.wheelLinks.has(cursor) || document.wheelFollowers.has(cursor) || document.exhaustLinks.has(cursor)) break;
    cursor = piece.parentIndex;
  }
  return output;
}

export function nearestMeshAnchor(document: PckDocument, selected: number, meshes: MeshGeometry[]) {
  const available = new Set(meshes.map((mesh) => mesh.anchorIndex).filter((index): index is number => index !== null));
  const seen = new Set<number>();
  let cursor: number | null = selected;
  while (cursor !== null && !seen.has(cursor)) {
    if (available.has(cursor)) return cursor;
    seen.add(cursor);
    cursor = document.pieces[cursor].parentIndex;
  }
  return null;
}

export function parseMeshPck(name: string, source: ArrayBuffer, document: PckDocument): MeshGeometry {
  const bytes = new Uint8Array(source.slice(0));
  const view = new DataView(bytes.buffer);
  if (bytes.length < 0x20) throw new Error(`${name}: mesh PCK is too small.`);
  const meshOffset = familyMagicAt(bytes, PAYLOAD_OFFSET) ? PAYLOAD_OFFSET : familyMagicAt(bytes, 0) ? 0 : findMagic(bytes);
  if (meshOffset < 0 || !inside(meshOffset, 0x20, bytes.length)) throw new Error(`${name}: standalone mesh magic was not found.`);
  let virtualBase = meshOffset === PAYLOAD_OFFSET ? u32(view, 0) : 0;
  if (!virtualBase) virtualBase = (u32(view, meshOffset + 0x0c) - 0x20) >>> 0;
  return parseMeshAt(name, bytes, meshOffset, (address) => meshOffset + ((address - virtualBase) | 0), document, null);
}

/**
 * Reads a piece straight out of a car PCK, where it's baked in and there is no loose mesh.pck.
 *
 * It can't be cut out and treated as a standalone file: in the car PCKs checked so far (the 350Z's
 * three) the piece's material table lives elsewhere in the PCK, ahead of the mesh block, so its
 * pointers only resolve against the car's own virtual base. Named like the loose file would be
 * (`<table name>.pck`) so every name-based lookup — LOD rows, anchors, visibility — works unchanged.
 */
export function parseEmbeddedMesh(entry: LodMeshEntry, document: PckDocument): MeshGeometry {
  if (entry.meshBlockOffset === null) throw new Error(`${entry.name}: not embedded in ${document.name}.`);
  return parseMeshAt(`${entry.name}.pck`, document.bytes, entry.meshBlockOffset, (address) => (address - document.pointerBase) | 0, document, entry.lod);
}

function parseMeshAt(name: string, bytes: Uint8Array, meshOffset: number, vaToOffset: (address: number) => number, document: PckDocument, lod: LodLevel | null): MeshGeometry {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const groupCount = u32(view, meshOffset + 0x08);
  if (groupCount < 1 || groupCount > 4096) throw new Error(`${name}: invalid material group count ${groupCount}.`);
  const materialTable = vaToOffset(u32(view, meshOffset + 0x0c));
  const pointerTable = vaToOffset(u32(view, meshOffset + 0x10));
  if (!inside(materialTable, groupCount * 2, bytes.length) || !inside(pointerTable, groupCount * 8, bytes.length)) throw new Error(`${name}: mesh tables are out of bounds.`);
  const meshId = bytes[meshOffset + 0x06];
  const groupShaderIds: number[] = [];
  const groupShaderOffsets: number[] = [];
  for (let group = 0; group < groupCount; group += 1) {
    groupShaderIds.push(u16(view, materialTable + group * 2));
    groupShaderOffsets.push(materialTable + group * 2);
  }

  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const vertexShaderIds: number[] = [];
  const vertexGroupIndices: number[] = [];
  const indices: number[] = [];
  let packetVertices = 0;
  const markerAt = (offset: number, markers: Set<string>, expectedCount?: number) => inside(offset, 4, bytes.length) && (expectedCount === undefined || view.getUint8(offset + 2) === expectedCount) && markers.has(markerKey(view, offset));
  const findMarker = (start: number, end: number, markers: Set<string>, expectedCount: number) => {
    for (let offset = Math.max(0, start); offset <= Math.min(bytes.length - 4, end); offset += 1) if (markerAt(offset, markers, expectedCount)) return offset;
    return -1;
  };
  let uvZeroedPackets = 0;
  // Walks the gap between the vertex and damage streams the way the reference PCK->OBJ tool does:
  // original meshes can put VIF/GIF setup bytes in there, so markers are searched, not assumed.
  // Returns null when the packet's UVs can't be decoded and have to be zero-filled.
  const decodeUvs = (start: number, damageOffset: number, count: number): [number, number][] | null => {
    const values: [number, number][] = [];
    for (let offset = start; offset <= damageOffset - 4 && values.length < count;) {
      if (!UV_MARKERS.has(markerKey(view, offset))) { offset += 1; continue; }
      if (bytes[offset + 3] !== UV_KIND_PLAIN) return null;
      const markerCount = bytes[offset + 2];
      const payload = offset + 4;
      if (payload + markerCount * 4 > damageOffset) return null;
      for (let index = 0; index < markerCount && values.length < count; index += 1) {
        values.push([s16(view, payload + index * 4) / UV_FIXED_SCALE, s16(view, payload + index * 4 + 2) / UV_FIXED_SCALE]);
      }
      offset = payload + markerCount * 4;
    }
    return values.length === count ? values : null;
  };
  const parseDataBlock = (blockOffset: number, blockSize: number) => {
    const end = blockOffset + blockSize;
    let cursor = blockOffset;
    const output: PacketVertex[][] = [];
    while (cursor < end) {
      let paddingOnly = true;
      for (let offset = cursor; offset < end; offset += 1) if (bytes[offset] !== 0 && bytes[offset] !== 0xcd) { paddingOnly = false; break; }
      if (paddingOnly) break;
      if (!inside(cursor, 44, end) || !BLOCK_HEADERS.has(bytesKey(bytes, cursor, 4))) throw new Error(`${name}: unsupported packet header at 0x${cursor.toString(16).toUpperCase()}.`);
      let scale = f32(view, cursor + 4); if (!Number.isFinite(scale) || scale <= 0) scale = 1;
      const count = u32(view, cursor + 20);
      if (count !== u32(view, cursor + 32) || count < 1 || count > 255) throw new Error(`${name}: invalid packet vertex count at 0x${cursor.toString(16).toUpperCase()}.`);
      let position = cursor + 36;
      if (!markerAt(position, VERTEX_MARKERS, count)) throw new Error(`${name}: unsupported vertex marker at 0x${position.toString(16).toUpperCase()}.`);
      position += 4;
      const vertexPayload = position;
      if (!inside(vertexPayload, count * 6, end)) throw new Error(`${name}: truncated vertex stream.`);
      position = align(vertexPayload + count * 6, 4);
      let damage = -1, normal = -1;
      for (let offset = position; offset <= Math.min(end - 4, position + 0x1000); offset += 1) {
        if (!markerAt(offset, DAMAGE_MARKERS, count)) continue;
        const expectedNormal = align(offset + 4 + (bytes[offset + 3] === DAMAGE_MASKED ? 0 : count * 4), 4);
        const foundNormal = findMarker(expectedNormal, expectedNormal + 0x80, NORMAL_MARKERS, count);
        if (foundNormal >= 0) { damage = offset; normal = foundNormal; break; }
      }
      if (damage < 0 || normal < 0) throw new Error(`${name}: damage/normal streams were not found.`);
      const normalPayload = normal + 4;
      if (!inside(normalPayload, count * 3, end)) throw new Error(`${name}: truncated normal stream.`);
      position = align(normalPayload + count * 3, 4);
      if (!FOOTERS.has(bytesKey(bytes, position, 8))) {
        for (let offset = position; offset <= Math.min(position + 0x40, end - 8); offset += 1) if (FOOTERS.has(bytesKey(bytes, offset, 8))) { position = offset; break; }
      }
      position += 8;
      const uvs = decodeUvs(align(vertexPayload + count * 6, 4), damage, count);
      if (!uvs) uvZeroedPackets += 1;
      const decoded: PacketVertex[] = [];
      for (let index = 0; index < count; index += 1) {
        const vertexOffset = vertexPayload + index * 6;
        const normalOffset = normalPayload + index * 3;
        const first = bytes[normalOffset];
        decoded.push({
          xyz: [s16(view, vertexOffset) * scale, s16(view, vertexOffset + 2) * scale, s16(view, vertexOffset + 4) * scale],
          normal: normalize([signed8(first & 0xfe) / 127, signed8(bytes[normalOffset + 1]) / 127, signed8(bytes[normalOffset + 2]) / 127]),
          uv: uvs ? uvs[index] : [0, 0],
          faceEnabled: (first & 1) === 0,
        });
      }
      // Every packet is an independent triangle-strip stream. Its first two
      // vertices are seeds marked as skip; removing them would connect the
      // first real face to the previous packet and create stretched bridges.
      output.push(decoded);
      const next = cursor + align(position - cursor, 16);
      if (next <= cursor) throw new Error(`${name}: packet parser did not advance.`);
      cursor = next;
    }
    return output;
  };

  for (let group = 0; group < groupCount; group += 1) {
    const pointerEntry = pointerTable + group * 8;
    const infoCount = u16(view, pointerEntry + 4);
    if (!infoCount) continue;
    if (infoCount > 1024) throw new Error(`${name}: suspicious block count in group ${group}.`);
    const infoList = vaToOffset(u32(view, pointerEntry));
    if (!inside(infoList, infoCount * 8, bytes.length)) throw new Error(`${name}: block list is out of bounds.`);
    for (let block = 0; block < infoCount; block += 1) {
      const info = infoList + block * 8;
      const blockOffset = vaToOffset(u32(view, info));
      const blockSize = u16(view, info + 4) * 16;
      if (!inside(blockOffset, blockSize, bytes.length) || blockSize <= 0) throw new Error(`${name}: geometry block is out of bounds.`);
      const packets = parseDataBlock(blockOffset, blockSize);
      const shaderId = groupShaderIds[group];
      for (const vertices of packets) {
        const base = positions.length / 3;
        for (const vertex of vertices) { positions.push(...vertex.xyz); normals.push(...vertex.normal); uvs.push(...vertex.uv); vertexShaderIds.push(shaderId); vertexGroupIndices.push(group); }
        for (let index = 2; index < vertices.length; index += 1) {
          if (!vertices[index].faceEnabled) continue;
          let triangle: [number, number, number] = index % 2 === 0 ? [index - 2, index - 1, index] : [index - 1, index - 2, index];
          const [a, b, c] = triangle.map((vertex) => vertices[vertex].xyz) as [Vec3, Vec3, Vec3];
          const face = cross(sub(b, a), sub(c, a));
          if (lengthSquared(face) <= 1e-18) continue;
          if (dot(normalize(face), vertices[index].normal) < 0) triangle = [triangle[1], triangle[0], triangle[2]];
          indices.push(base + triangle[0], base + triangle[1], base + triangle[2]);
        }
        packetVertices += vertices.length;
      }
    }
  }
  if (!indices.length) throw new Error(`${name}: no drawable triangles were decoded.`);
  return {
    name,
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint32Array(indices),
    vertexShaderIds: new Uint16Array(vertexShaderIds),
    vertexGroupIndices: new Uint16Array(vertexGroupIndices),
    groupShaderIds,
    groupShaderOffsets,
    groupShaderDirty: groupShaderIds.map(() => false),
    meshId,
    idByteOffset: meshOffset + 0x06,
    uvs: new Float32Array(uvs),
    uvZeroedPackets,
    origin: lod === null ? "loose" : "embedded",
    lod,
    materialGroups: groupCount,
    packetVertices,
    triangles: indices.length / 3,
    category: meshCategory(name),
    stock: /(?:^|_)stk(?:_|\.)/i.test(name) || meshCategory(name) === "lodgroup",
    anchorIndex: hostAnchor(name, document, lod === null ? null : meshId),
  };
}

const MESH_DOC_MAX_HISTORY = 20;
type MeshDocMeshIdEntry = { kind: "meshId"; before: number; after: number };
type MeshDocShaderEntry = { kind: "shader"; group: number; before: number; after: number };
type MeshDocHistoryEntry = MeshDocMeshIdEntry | MeshDocShaderEntry;

/**
 * A standalone mesh.pck held in memory with the same deferred-edit model as PckDocument: bytes are
 * retained (not discarded after parsing), edits go through setMeshId/setGroupShaderId with undo/redo,
 * and nothing touches disk until the caller writes `bytes` out and calls markSaved().
 */
export class MeshPckDocument {
  readonly path: string;
  readonly name: string;
  readonly originalBytes: Uint8Array;
  bytes: Uint8Array;
  savedBytes: Uint8Array;
  geometry: MeshGeometry;
  private readonly carDocument: PckDocument;
  /** Set when the whole file has been swapped out (a conversion), which a field-level dirty check
   *  can't see. Also true for a piece that doesn't exist on disk yet, so Save creates it. */
  private replacedSinceSave = false;
  undoStack: MeshDocHistoryEntry[] = [];
  redoStack: MeshDocHistoryEntry[] = [];

  constructor(path: string, name: string, source: ArrayBuffer, carDocument: PckDocument) {
    this.path = path;
    this.name = name;
    this.originalBytes = new Uint8Array(source.slice(0));
    this.bytes = new Uint8Array(source.slice(0));
    this.savedBytes = this.bytes.slice();
    this.carDocument = carDocument;
    this.geometry = parseMeshPck(name, source, carDocument);
    this.refreshGroupShaderDirty();
  }

  get meshId() { return this.geometry.meshId; }
  get dirty() {
    if (this.replacedSinceSave) return true;
    if (this.bytes[this.geometry.idByteOffset] !== this.savedBytes[this.geometry.idByteOffset]) return true;
    return this.geometry.groupShaderDirty.some(Boolean);
  }

  /**
   * Swaps this piece's entire contents for freshly converted bytes. Undo history is dropped
   * because the ID and shader edits it holds refer to offsets in the old geometry, which no
   * longer exist.
   */
  replaceBytes(source: Uint8Array) {
    this.bytes = source.slice();
    this.geometry = parseMeshPck(this.name, this.bytes.buffer as ArrayBuffer, this.carDocument);
    this.refreshGroupShaderDirty();
    this.replacedSinceSave = true;
    this.undoStack = [];
    this.redoStack = [];
  }

  /** Marks a document as not yet existing on disk, so Save writes it out even though nothing in
   *  it has been edited since it was built. */
  markAsNew() { this.replacedSinceSave = true; }
  /** Recomputes groupShaderDirty (bytes vs savedBytes, per group offset) and writes it back onto
   *  geometry — call after anything that changes `bytes` or `savedBytes`. */
  private refreshGroupShaderDirty() {
    const savedView = new DataView(this.savedBytes.buffer, this.savedBytes.byteOffset);
    const view = new DataView(this.bytes.buffer, this.bytes.byteOffset);
    const groupShaderDirty = this.geometry.groupShaderOffsets.map((offset) => u16(view, offset) !== u16(savedView, offset));
    this.geometry = { ...this.geometry, groupShaderDirty };
  }

  setMeshId(newId: number, record = true) {
    if (newId < 0 || newId > 0xff) throw new Error("Piece ID must be between 0 and 255.");
    const before = this.geometry.meshId;
    if (before === newId) return false;
    this.bytes[this.geometry.idByteOffset] = newId;
    this.geometry = { ...this.geometry, meshId: newId };
    if (record) {
      this.undoStack.push({ kind: "meshId", before, after: newId });
      if (this.undoStack.length > MESH_DOC_MAX_HISTORY) this.undoStack.shift();
      this.redoStack = [];
    }
    return true;
  }
  setGroupShaderId(group: number, newId: number, record = true) {
    if (newId < 0 || newId > 0xffff) throw new Error("Shader ID must be between 0 and 0xFFFF.");
    const offset = this.geometry.groupShaderOffsets[group];
    if (offset === undefined) throw new Error("Invalid material group.");
    const view = new DataView(this.bytes.buffer, this.bytes.byteOffset);
    const before = u16(view, offset);
    if (before === newId) return false;
    view.setUint16(offset, newId, true);
    // Re-parse rather than patching groupShaderIds/vertexShaderIds by hand: the per-vertex shader
    // assignment isn't retained as a separate group->vertex-range map after the first parse, and
    // this file is small enough that a full re-parse is cheap and can't drift from the read path.
    this.geometry = parseMeshPck(this.name, this.bytes.buffer as ArrayBuffer, this.carDocument);
    this.refreshGroupShaderDirty();
    if (record) {
      this.undoStack.push({ kind: "shader", group, before, after: newId });
      if (this.undoStack.length > MESH_DOC_MAX_HISTORY) this.undoStack.shift();
      this.redoStack = [];
    }
    return true;
  }
  undo() {
    const entry = this.undoStack.pop(); if (!entry) return false;
    if (entry.kind === "meshId") this.setMeshId(entry.before, false);
    else this.setGroupShaderId(entry.group, entry.before, false);
    this.redoStack.push(entry); return true;
  }
  redo() {
    const entry = this.redoStack.pop(); if (!entry) return false;
    if (entry.kind === "meshId") this.setMeshId(entry.after, false);
    else this.setGroupShaderId(entry.group, entry.after, false);
    this.undoStack.push(entry); return true;
  }
  markSaved() { this.savedBytes = this.bytes.slice(); this.replacedSinceSave = false; this.refreshGroupShaderDirty(); }
}
