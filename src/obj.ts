/**
 * OBJ → standalone `mesh.pck` converter.
 *
 * A port of the precedent Python tool's `strip` conversion path (the one its .bat drives), kept
 * byte-for-byte faithful to it so its output can be diffed against this one directly. The PS2
 * packet layout written here is the same one `parseMeshPck` in `./mesh.ts` reads back, which is
 * what makes a converted piece round-trip through this app.
 *
 * The pipeline is self-describing — nothing has to be supplied alongside the OBJ:
 * - the filename's hex prefix (`5D - name.mesh.obj`) becomes the piece ID at `0x86`;
 * - each material name's leading two hex characters (`05 - Carpaint`) become that group's shader ID;
 * - `usemtl` groups become the mesh's material groups, in first-seen order.
 */

export type Vec3 = [number, number, number];
export type Vec2 = [number, number];

const VIRTUAL_OFFSET = 0x01717300;
const XYZ_LENGTH = 6;
const UV_LENGTH = 4;
const NOR_LENGTH = 3;
const MAX_BLOCK_VERTICES = 40;
const MAX_STRIP_VERTICES = MAX_BLOCK_VERTICES;
const MAX_MESH_ENTRY_QWORDS = 65535;
const PACKET_VERTEX_SCALE = 256;
const UV_FIXED_SCALE = 4096;
const UV_SIGNED_MIN = -32768 / UV_FIXED_SCALE;
const UV_SIGNED_MAX = 32767 / UV_FIXED_SCALE;
const MESH_ID_OFFSET = 0x86;
const PAYLOAD_OFFSET = 0x80;

/** Conversion settings. The defaults are the precedent tool's own, i.e. what its .bat produces. */
export type ObjConvertOptions = {
  scale: number;
  packetVertexScale: number;
  rotateX: number; rotateY: number; rotateZ: number;
  flipX: boolean; flipY: boolean; flipZ: boolean;
  flipV: boolean;
  translateX: number; translateY: number; translateZ: number;
  rawOffsetX: number; rawOffsetY: number; rawOffsetZ: number;
  maxFacesPerMesh: number;
  maxEmittedVerticesPerMesh: number;
  virtualOffset: number;
};

export const defaultObjConvertOptions: ObjConvertOptions = {
  scale: 256,
  packetVertexScale: PACKET_VERTEX_SCALE,
  rotateX: 0, rotateY: 90, rotateZ: 0,
  flipX: false, flipY: false, flipZ: false,
  flipV: true,
  translateX: 0, translateY: 0, translateZ: 0,
  rawOffsetX: 0, rawOffsetY: 0, rawOffsetZ: 0,
  maxFacesPerMesh: 8000,
  maxEmittedVerticesPerMesh: 0,
  virtualOffset: VIRTUAL_OFFSET,
};

export type ConvertedMesh = {
  /** Output filename, i.e. the OBJ stem with the ID prefix stripped, plus `.pck`. */
  name: string;
  bytes: Uint8Array;
  meshId: number;
  shaderIds: number[];
  groupNames: string[];
  triangles: number;
};

type VertexRef = { v: number; vt: number | null; vn: number | null };
type Face = { refs: [VertexRef, VertexRef, VertexRef]; material: string };
type ObjData = { vertices: Vec3[]; uvs: Vec2[]; normals: Vec3[]; groups: Map<string, Face[]> };
type Transform = ObjConvertOptions;
/** A vertex as it will be written, with the engine's "skip the triangle closing here" flag. */
type BlockRecord = { ref: VertexRef; skip: boolean };

// --- numeric helpers ---------------------------------------------------------

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

/**
 * Python's built-in `round()` breaks ties to the nearest EVEN integer, while JavaScript's
 * `Math.round` breaks them upward. Quantizing vertices, normals and UVs lands on exact .5 often
 * enough that using the wrong one puts single-unit differences all over the output, so this
 * reproduces Python's rule rather than approximating it.
 */
function roundHalfToEven(value: number) {
  if (!Number.isFinite(value)) return 0;
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

const isFiniteVec = (v: number[]) => v.every((n) => Number.isFinite(n));

function normalizeVec(v: Vec3): Vec3 {
  const length = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  if (length === 0 || !Number.isFinite(length)) return [0, 0, 1];
  return [v[0] / length, v[1] / length, v[2] / length];
}

function padTo(parts: number[], alignment: number, padByte: number) {
  const padding = (alignment - (parts.length % alignment)) % alignment;
  for (let i = 0; i < padding; i += 1) parts.push(padByte);
  return parts;
}

const padSize = (size: number, alignment: number) => size + ((alignment - (size % alignment)) % alignment);

function pushU16(out: number[], value: number) { out.push(value & 0xff, (value >>> 8) & 0xff); }
function pushU32(out: number[], value: number) { out.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff); }
function pushF32(out: number[], value: number) {
  const buffer = new DataView(new ArrayBuffer(4));
  buffer.setFloat32(0, value, true);
  for (let i = 0; i < 4; i += 1) out.push(buffer.getUint8(i));
}
function pushS16(out: number[], value: number) {
  pushU16(out, clamp(roundHalfToEven(value), -32768, 32767) & 0xffff);
}
function pushHex(out: number[], hex: string) {
  const clean = hex.replace(/\s+/g, "");
  for (let i = 0; i < clean.length; i += 2) out.push(parseInt(clean.slice(i, i + 2), 16));
}

// --- OBJ parsing -------------------------------------------------------------

function resolveIndex(raw: string, amount: number) {
  const index = parseInt(raw, 10);
  if (index > 0) return index - 1;
  if (index < 0) return amount + index;
  throw new Error("OBJ index 0 is invalid.");
}

function parseFaceRef(token: string, vertexCount: number, uvCount: number, normalCount: number): VertexRef {
  const parts = token.split("/");
  return {
    v: resolveIndex(parts[0], vertexCount),
    vt: parts.length > 1 && parts[1] ? resolveIndex(parts[1], uvCount) : null,
    vn: parts.length > 2 && parts[2] ? resolveIndex(parts[2], normalCount) : null,
  };
}

/** Reads an OBJ, grouping faces by material (the precedent tool's `group_by=material` default).
 *  Quads and n-gons are fan-triangulated, matching how the reference tool reads them. */
export function readObj(text: string): ObjData {
  const vertices: Vec3[] = [];
  const uvs: Vec2[] = [];
  const normals: Vec3[] = [];
  const groups = new Map<string, Face[]>();
  let material = "default";
  groups.set(material, []);

  const lines = text.split(/\r?\n/);
  for (let lineNo = 0; lineNo < lines.length; lineNo += 1) {
    const stripped = lines[lineNo].trim();
    if (!stripped || stripped.startsWith("#")) continue;
    const parts = stripped.split(/\s+/);
    const tag = parts[0];
    if (tag === "v" && parts.length >= 4) {
      const vertex: Vec3 = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
      if (!isFiniteVec(vertex)) throw new Error(`Vertex has NaN/Inf coordinates at line ${lineNo + 1}.`);
      vertices.push(vertex);
    } else if (tag === "vt" && parts.length >= 3) {
      const uv: Vec2 = [Number(parts[1]), Number(parts[2])];
      uvs.push(isFiniteVec(uv) ? uv : [0, 0]);
    } else if (tag === "vn" && parts.length >= 4) {
      const normal: Vec3 = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
      normals.push(isFiniteVec(normal) ? normal : [0, 0, 1]);
    } else if (tag === "usemtl" && parts.length >= 2) {
      material = parts.slice(1).join(" ");
      if (!groups.has(material)) groups.set(material, []);
    } else if (tag === "f") {
      if (parts.length < 4) throw new Error(`Face with fewer than 3 vertices at line ${lineNo + 1}.`);
      const refs = parts.slice(1).map((token) => parseFaceRef(token, vertices.length, uvs.length, normals.length));
      const target = groups.get(material)!;
      for (let i = 1; i < refs.length - 1; i += 1) target.push({ refs: [refs[0], refs[i], refs[i + 1]], material });
    }
  }

  for (const [name, faces] of [...groups]) if (!faces.length) groups.delete(name);
  if (!groups.size) throw new Error("The OBJ has no faces.");
  return { vertices, uvs, normals, groups };
}

// --- transforms --------------------------------------------------------------

function rotateXyz(v: Vec3, rx: number, ry: number, rz: number): Vec3 {
  let [x, y, z] = v;
  if (rx) {
    const a = (rx * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    [y, z] = [y * c - z * s, y * s + z * c];
  }
  if (ry) {
    const a = (ry * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    [x, z] = [x * c + z * s, -x * s + z * c];
  }
  if (rz) {
    const a = (rz * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    [x, y] = [x * c - y * s, x * s + y * c];
  }
  return [x, y, z];
}

function transformXyz(v: Vec3, t: Transform): Vec3 {
  let [x, y, z] = rotateXyz(v, t.rotateX, t.rotateY, t.rotateZ);
  if (t.flipX) x = -x;
  if (t.flipY) y = -y;
  if (t.flipZ) z = -z;
  return [x + t.translateX, y + t.translateY, z + t.translateZ];
}

/** Normals are only rotated and mirrored, never translated. */
function transformNormal(v: Vec3, t: Transform): Vec3 {
  let [x, y, z] = rotateXyz(v, t.rotateX, t.rotateY, t.rotateZ);
  if (t.flipX) x = -x;
  if (t.flipY) y = -y;
  if (t.flipZ) z = -z;
  return isFiniteVec([x, y, z]) ? [x, y, z] : [0, 0, 1];
}

function faceNormal(v0: Vec3, v1: Vec3, v2: Vec3): Vec3 {
  if (!isFiniteVec(v0) || !isFiniteVec(v1) || !isFiniteVec(v2)) return [0, 0, 1];
  const a: Vec3 = [v1[0] - v0[0], v1[1] - v0[1], v1[2] - v0[2]];
  const b: Vec3 = [v2[0] - v0[0], v2[1] - v0[1], v2[2] - v0[2]];
  const n: Vec3 = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const length = Math.sqrt(n[0] * n[0] + n[1] * n[1] + n[2] * n[2]);
  if (length === 0 || !Number.isFinite(length)) return [0, 0, 1];
  return [n[0] / length, n[1] / length, n[2] / length];
}

/** Area-weighted vertex normals, used for any vertex the OBJ doesn't give an explicit `vn`. */
function computeSmoothedNormals(faces: Face[], vertices: Vec3[], t: Transform) {
  const accum = new Map<number, Vec3>();
  for (const face of faces) {
    const p0 = transformXyz(vertices[face.refs[0].v], t);
    const p1 = transformXyz(vertices[face.refs[1].v], t);
    const p2 = transformXyz(vertices[face.refs[2].v], t);
    const n = faceNormal(p0, p1, p2);
    for (const ref of face.refs) {
      const current = accum.get(ref.v) ?? [0, 0, 0];
      accum.set(ref.v, [current[0] + n[0], current[1] + n[1], current[2] + n[2]]);
    }
  }
  const output = new Map<number, Vec3>();
  for (const [v, n] of accum) output.set(v, normalizeVec(n));
  return output;
}

// --- UV fitting --------------------------------------------------------------

type UvFit = { scale: Vec2; rebase: Vec2 };

/**
 * Finds a signed V2-16 safe transform for one material group's UVs.
 *
 * Whole-tile translation doesn't change a repeating texture, so the group is shifted as a unit
 * whenever that brings it inside the representable range. Only when an axis is genuinely wider
 * than the 16-unit window does it fall back to compressing that axis.
 */
function calculateUvRebase(faces: Face[], uvs: Vec2[], flipV: boolean): UvFit {
  const used = new Set<number>();
  for (const face of faces) for (const ref of face.refs) if (ref.vt !== null) used.add(ref.vt);
  if (!used.size) return { scale: [1, 1], rebase: [0, 0] };

  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (const index of used) {
    const [u, rawV] = uvs[index];
    const v = flipV ? 1 - rawV : rawV;
    minU = Math.min(minU, u); maxU = Math.max(maxU, u);
    minV = Math.min(minV, v); maxV = Math.max(maxV, v);
  }

  const axisTransform = (minimum: number, maximum: number): [number, number] => {
    const lowest = Math.ceil(UV_SIGNED_MIN - minimum);
    const highest = Math.floor(UV_SIGNED_MAX - maximum);
    if (lowest <= highest) {
      if (lowest <= 0 && 0 <= highest) return [1, 0];
      return [1, lowest > 0 ? lowest : highest];
    }
    const span = maximum - minimum;
    const margin = 1 / UV_FIXED_SCALE;
    const targetMin = UV_SIGNED_MIN + margin;
    const targetMax = UV_SIGNED_MAX - margin;
    const scale = (targetMax - targetMin) / span;
    const offset = (targetMin + targetMax) * 0.5 - ((minimum + maximum) * 0.5) * scale;
    return [scale, offset];
  };

  const [scaleU, offsetU] = axisTransform(minU, maxU);
  const [scaleV, offsetV] = axisTransform(minV, maxV);
  return { scale: [scaleU, scaleV], rebase: [offsetU, offsetV] };
}

function pushUv(out: number[], uv: Vec2 | null, flipV: boolean, fit: UvFit) {
  if (!uv) { pushU16(out, 0); pushU16(out, 0); return; }
  const v = flipV ? 1 - uv[1] : uv[1];
  for (const component of [uv[0] * fit.scale[0] + fit.rebase[0], v * fit.scale[1] + fit.rebase[1]]) {
    const scaled = roundHalfToEven(component * UV_FIXED_SCALE);
    if (scaled < -32768 || scaled > 32767) {
      throw new Error(`UV component ${component} is outside the signed V2-16 range [${UV_SIGNED_MIN}, ${UV_SIGNED_MAX}].`);
    }
    pushU16(out, scaled & 0xffff);
  }
}

/** Packs a normal into 3 bytes, with bit 0 of the first byte carrying the skip flag the engine
 *  uses to drop the triangle that would close at this vertex. */
function pushNormal(out: number[], normal: Vec3, faceEnabled: boolean) {
  const safe = isFiniteVec(normal) ? normal : ([0, 0, 1] as Vec3);
  const packed = safe.map((component) => clamp(roundHalfToEven(component * 127), -128, 127) & 0xff);
  packed[0] = faceEnabled ? packed[0] & 0xfe : packed[0] | 0x01;
  out.push(packed[0], packed[1], packed[2]);
}

// --- stripification ----------------------------------------------------------

const refKey = (ref: VertexRef) => `${ref.v}/${ref.vt ?? "_"}/${ref.vn ?? "_"}`;

/**
 * Greedy triangle stripification that preserves each source triangle's winding.
 *
 * The engine decides a strip triangle's winding from the global parity of its closing index, so
 * the next triangle is looked up by the exact directed edge that parity demands. Keeping winding
 * intact is what stops backface culling from inverting on the converted mesh.
 */
function buildStrips(faces: Face[], reverseWinding: boolean): VertexRef[][] {
  const edgeMap = new Map<string, { faceIndex: number; apex: VertexRef }[]>();
  const tris: [VertexRef, VertexRef, VertexRef][] = [];
  const edgeKey = (a: VertexRef, b: VertexRef) => `${refKey(a)}|${refKey(b)}`;

  faces.forEach((face, faceIndex) => {
    const [r0, r1, r2] = face.refs;
    const tri: [VertexRef, VertexRef, VertexRef] = reverseWinding ? [r0, r2, r1] : [r0, r1, r2];
    tris.push(tri);
    const [a, b, c] = tri;
    for (const [from, to, apex] of [[a, b, c], [b, c, a], [c, a, b]] as [VertexRef, VertexRef, VertexRef][]) {
      const key = edgeKey(from, to);
      const list = edgeMap.get(key);
      if (list) list.push({ faceIndex, apex }); else edgeMap.set(key, [{ faceIndex, apex }]);
    }
  });

  const used = new Array<boolean>(faces.length).fill(false);
  const strips: VertexRef[][] = [];
  for (let start = 0; start < faces.length; start += 1) {
    if (used[start]) continue;
    used[start] = true;
    const strip = [...tris[start]];
    while (strip.length < MAX_STRIP_VERTICES) {
      const n = strip.length;
      const secondLast = strip[n - 2];
      const last = strip[n - 1];
      // n even -> triangle (n-2, n-1, n), shared edge (secondLast, last)
      // n odd  -> triangle (n-1, n-2, n), shared edge (last, secondLast)
      const key = n % 2 === 0 ? edgeKey(secondLast, last) : edgeKey(last, secondLast);
      const candidate = (edgeMap.get(key) ?? []).find((entry) => !used[entry.faceIndex]);
      if (!candidate) break;
      used[candidate.faceIndex] = true;
      strip.push(candidate.apex);
    }
    strips.push(strip);
  }
  return strips;
}

/** Packs strips into independent blocks of at most 40 vertices. Every strip has to start on an
 *  even absolute index for the parity rule above to hold, so a single skip vertex is inserted
 *  whenever the running length is odd. */
function packStripsIntoBlocks(strips: VertexRef[][]): BlockRecord[][] {
  const blocks: BlockRecord[][] = [];
  let current: BlockRecord[] = [];
  for (const strip of strips) {
    const pad = current.length % 2 === 1 ? 1 : 0;
    if (current.length && current.length + pad + strip.length > MAX_BLOCK_VERTICES) {
      blocks.push(current);
      current = [];
    }
    if (current.length % 2 === 1) current.push({ ref: current[current.length - 1].ref, skip: true });
    strip.forEach((ref, localIndex) => current.push({ ref, skip: localIndex < 2 }));
  }
  if (current.length) blocks.push(current);
  return blocks;
}

// --- packet encoding ---------------------------------------------------------

/** MC3's per-packet culling data: the Y/Z midpoint of the quantized vertices and half the full
 *  3D AABB diagonal as a radius. Computed from the bytes actually written, not the source floats. */
function packetCullingBounds(vertexBytes: number[], packetScale: number): Vec3 {
  const view = new DataView(new Uint8Array(vertexBytes).buffer);
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let offset = 0; offset < vertexBytes.length; offset += XYZ_LENGTH) {
    const x = view.getInt16(offset, true) * packetScale;
    const y = view.getInt16(offset + 2, true) * packetScale;
    const z = view.getInt16(offset + 4, true) * packetScale;
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
  }
  const radius = 0.5 * Math.sqrt((maxX - minX) ** 2 + (maxY - minY) ** 2 + (maxZ - minZ) ** 2);
  return [(minY + maxY) * 0.5, (minZ + maxZ) * 0.5, radius];
}

/** Wraps one block's vertices into the four PS2 VIF sub-packets (position, UV, damage, normal)
 *  plus the footer. Every marker alternates on block parity, which the engine relies on. */
function encodeBlock(
  records: BlockRecord[],
  obj: ObjData,
  smoothed: Map<number, Vec3>,
  fit: UvFit,
  t: Transform,
  blockParity: number,
): number[] {
  const count = records.length;
  const vertexBytes: number[] = [];
  const uvBytes: number[] = [];
  const normalBytes: number[] = [];

  for (const { ref, skip } of records) {
    const [vx, vy, vz] = transformXyz(obj.vertices[ref.v], t);
    pushS16(vertexBytes, vx * t.scale + t.rawOffsetX);
    pushS16(vertexBytes, vy * t.scale + t.rawOffsetY);
    pushS16(vertexBytes, vz * t.scale + t.rawOffsetZ);
    pushUv(uvBytes, ref.vt !== null ? obj.uvs[ref.vt] : null, t.flipV, fit);
    const normal = ref.vn !== null ? transformNormal(obj.normals[ref.vn], t) : (smoothed.get(ref.v) ?? [0, 0, 1]);
    pushNormal(normalBytes, normal, !skip);
  }

  const even = blockParity % 2 === 0;
  const packetScale = 1 / t.packetVertexScale;
  const bounds = packetCullingBounds(vertexBytes, packetScale);

  const vertexChunk: number[] = [];
  pushHex(vertexChunk, even ? "9800026C" : "C501026C");
  pushF32(vertexChunk, packetScale);
  for (const value of bounds) pushF32(vertexChunk, value);
  pushU32(vertexChunk, count);
  pushF32(vertexChunk, 0); pushF32(vertexChunk, 0);
  pushU32(vertexChunk, count);
  pushHex(vertexChunk, even ? "EE00" : "1B02");
  vertexChunk.push(count & 0xff);
  pushHex(vertexChunk, "69");
  vertexChunk.push(...vertexBytes);
  padTo(vertexChunk, 4, 0);

  const uvChunk: number[] = [];
  pushHex(uvChunk, even ? "C400" : "F101");
  uvChunk.push(count & 0xff);
  pushHex(uvChunk, "65");
  uvChunk.push(...uvBytes);
  padTo(uvChunk, 4, 0);

  const damageChunk: number[] = [];
  pushHex(damageChunk, even ? "1841" : "4542");
  damageChunk.push(count & 0xff);
  pushHex(damageChunk, "6E");
  // 0x80808000 written big-endian, i.e. the bytes 80 80 80 00, once per vertex.
  for (let i = 0; i < count; i += 1) damageChunk.push(0x80, 0x80, 0x80, 0x00);
  padTo(damageChunk, 4, 0);

  const normalChunk: number[] = [];
  pushHex(normalChunk, even ? "9A00" : "C701");
  normalChunk.push(count & 0xff);
  pushHex(normalChunk, "6A");
  normalChunk.push(...normalBytes);
  padTo(normalChunk, 4, 0);

  const block = [...vertexChunk, ...uvChunk, ...damageChunk, ...normalChunk];
  pushHex(block, even ? "9800000406000014" : "C501000406000014");
  return padTo(block, 16, 0);
}

type MeshStream = { blocks: number[][]; vertexCount: number };

function buildStripStream(faces: Face[], obj: ObjData, t: Transform): MeshStream {
  // An odd number of axis mirrors flips triangle orientation, which would invert backface
  // culling; reversing the source winding cancels it out.
  const mirrors = Number(t.flipX) + Number(t.flipY) + Number(t.flipZ);
  const strips = buildStrips(faces, mirrors % 2 === 1);
  const packed = packStripsIntoBlocks(strips);
  const smoothed = computeSmoothedNormals(faces, obj.vertices, t);
  const fit = calculateUvRebase(faces, obj.uvs, t.flipV);

  const blocks = packed.map((records, index) => encodeBlock(records, obj, smoothed, fit, t, index));
  return { blocks, vertexCount: packed.reduce((sum, records) => sum + records.length, 0) };
}

/** Splits a group that would overflow one mesh entry, halving the face count until it fits.
 *  With the default 8000-face budget this accepts whole groups in one pass for normal pieces. */
function buildAutoSplitStreams(groupName: string, faces: Face[], obj: ObjData, t: Transform) {
  const names: string[] = [];
  const streams: MeshStream[] = [];
  let cursor = 0;
  let part = 1;

  while (cursor < faces.length) {
    let requested = Math.min(t.maxFacesPerMesh, faces.length - cursor);
    let accepted: MeshStream | null = null;
    let acceptedCount = 0;
    while (requested > 0) {
      const stream = buildStripStream(faces.slice(cursor, cursor + requested), obj, t);
      const blockSize = stream.blocks.reduce((sum, block) => sum + block.length, 0);
      const fitsEntry = Math.floor(blockSize / 16) <= MAX_MESH_ENTRY_QWORDS && stream.vertexCount <= 0xffff;
      const fitsVertexBudget = !t.maxEmittedVerticesPerMesh || stream.vertexCount <= t.maxEmittedVerticesPerMesh;
      if (fitsEntry && fitsVertexBudget) { accepted = stream; acceptedCount = requested; break; }
      requested = Math.floor(requested / 2);
    }
    if (!accepted || acceptedCount <= 0) throw new Error(`Could not fit even one face from group "${groupName}" into a single mesh entry.`);
    const needsSuffix = cursor > 0 || cursor + acceptedCount < faces.length;
    names.push(needsSuffix ? `${groupName}__part${String(part).padStart(3, "0")}` : groupName);
    streams.push(accepted);
    cursor += acceptedCount;
    part += 1;
  }
  return { names, streams };
}

// --- PCK assembly ------------------------------------------------------------

const mainPointerSizes = (groupCount: number) => ({
  materials: padSize(2 * groupCount, 16),
  count: padSize(4, 16),
  pointers: padSize(padSize(6, 8) * groupCount, 16),
});
const blockPointersSize = () => padSize(4, 16) + padSize(8, 16);

function meshHeader(mainPointers: number[], groupCount: number, virtualOffset: number) {
  const sizes = mainPointerSizes(groupCount);
  const materialPointer = virtualOffset + 32;
  const mainPointer = virtualOffset + 32 + sizes.materials + sizes.count;

  const header: number[] = [];
  pushHex(header, "980F7A00");
  pushU32(header, 0);              // piece ID field; the real ID is stamped at 0x86 afterwards
  pushU32(header, groupCount);
  pushU32(header, materialPointer);
  pushU32(header, mainPointer);
  pushU32(header, 0);
  padTo(header, 16, 0xcd);

  const materials: number[] = [];
  const pointers: number[] = [];
  for (let i = 0; i < groupCount; i += 1) {
    // Placeholder shader IDs; the real ones come from the material names in a later pass.
    pushU16(materials, Math.min(i + 1, 0xffff));
    const entry: number[] = [];
    pushU32(entry, mainPointers[i]);
    pushU16(entry, 1);
    pointers.push(...padTo(entry, 8, 0xcd));
  }
  padTo(materials, 16, 0xcd);
  const countChunk: number[] = [];
  pushU32(countChunk, groupCount);
  padTo(countChunk, 16, 0xcd);
  padTo(pointers, 16, 0xcd);

  return padTo([...header, ...materials, ...countChunk, ...pointers], 16, 0xcd);
}

function fileHeader(size: number, virtualOffset: number) {
  const header: number[] = [];
  pushU32(header, virtualOffset);
  pushU32(header, 22);
  pushU32(header, 1);
  pushU32(header, size);
  return padTo(header, 128, 0);
}

function makePckFile(streams: MeshStream[], virtualOffset: number) {
  const groupCount = streams.length;
  const sizes = mainPointerSizes(groupCount);
  const skip = sizes.materials + sizes.count + sizes.pointers + 32;
  const pointerBlockSize = blockPointersSize();

  const mainPointers: number[] = [];
  const tail: number[] = [];
  let fileSize = 0;

  for (const stream of streams) {
    const blockBytes = stream.blocks.flat();
    const blockSize = blockBytes.length;
    const offset = skip + pointerBlockSize + fileSize;
    if (Math.floor(blockSize / 16) > MAX_MESH_ENTRY_QWORDS) throw new Error(`A mesh entry is too large: ${Math.floor(blockSize / 16)} qwords (limit ${MAX_MESH_ENTRY_QWORDS}).`);
    if (stream.vertexCount > 0xffff) throw new Error(`A mesh entry has too many vertices: ${stream.vertexCount} (limit 65535).`);

    const amountChunk: number[] = [];
    pushU32(amountChunk, 1);
    padTo(amountChunk, 16, 0xcd);

    const pointerChunk: number[] = [];
    pushU32(pointerChunk, virtualOffset + offset);
    pushU16(pointerChunk, Math.floor(blockSize / 16));
    pushU16(pointerChunk, stream.vertexCount);
    padTo(pointerChunk, 16, 0xcd);

    mainPointers.push(virtualOffset + offset - pointerBlockSize + 16);
    tail.push(...amountChunk, ...pointerChunk, ...blockBytes);
    fileSize += blockSize + pointerBlockSize;
  }

  const mesh = [...meshHeader(mainPointers, groupCount, virtualOffset), ...tail];
  return new Uint8Array([...fileHeader(mesh.length, virtualOffset), ...mesh]);
}

// --- names and IDs -----------------------------------------------------------

/** `5D - name.mesh.obj` → piece ID 0x5D plus the clean stem. A missing or invalid prefix means
 *  ID 0 and the stem unchanged, matching the reference tool. */
export function parseObjFileName(fileName: string): { meshId: number; stem: string } {
  const stem = fileName.replace(/\.obj$/i, "");
  const dash = stem.indexOf("-");
  if (dash < 0) return { meshId: 0, stem };
  const prefix = stem.slice(0, dash).trim();
  const rest = stem.slice(dash + 1).trim();
  if (!rest) return { meshId: 0, stem };
  const hex = prefix.toLowerCase().startsWith("0x") ? prefix.slice(2) : prefix;
  if (!/^[0-9a-f]{1,2}$/i.test(hex)) return { meshId: 0, stem };
  const value = parseInt(hex, 16);
  if (!Number.isFinite(value) || value < 0 || value > 0xff) return { meshId: 0, stem };
  return { meshId: value, stem: rest };
}

/** `05 - Carpaint` → shader 0x05. Several legacy spellings are still accepted, mirroring the
 *  reference tool, because older exports used them. */
export function parseShaderIdFromMaterial(materialName: string): number {
  const name = materialName.trim();
  if (!name) throw new Error("Empty material name.");
  if (/^[0-9a-f]{2}$/i.test(name.slice(0, 2))) return parseInt(name.slice(0, 2), 16) & 0xffff;
  let match = /^0[xX]([0-9A-Fa-f]{1,4})$/.exec(name);
  if (match) return parseInt(match[1], 16) & 0xffff;
  match = /^[0-9A-Fa-f]{1,4}$/.exec(name);
  if (match) return parseInt(name, 16) & 0xffff;
  match = /(?:shader|shd|material|mat|id)[_\-\s:]*([0-9A-Fa-f]{1,4})(?![0-9A-Fa-f])/i.exec(name);
  if (match?.[1]) return parseInt(match[1], 16) & 0xffff;
  const tokens = name.match(/(?<![0-9A-Fa-f])([0-9A-Fa-f]{2})(?![0-9A-Fa-f])/g) ?? [];
  const [low, high] = tokens;
  if (low !== undefined && high !== undefined) return (parseInt(low, 16) | (parseInt(high, 16) << 8)) & 0xffff;
  if (low !== undefined) return parseInt(low, 16) & 0xffff;
  throw new Error(`Material name "${materialName}" does not start with a two-character hex shader ID. Use names like "02 - Carpaint".`);
}

// --- entry point -------------------------------------------------------------

/**
 * Converts one OBJ into the bytes of a standalone `mesh.pck`, with the piece ID taken from the
 * filename prefix and each group's shader ID from its material name.
 */
export function convertObjToMeshPck(objText: string, fileName: string, options?: Partial<ObjConvertOptions>): ConvertedMesh {
  const t: Transform = { ...defaultObjConvertOptions, ...options };
  const obj = readObj(objText);
  const { meshId, stem } = parseObjFileName(fileName);

  const names: string[] = [];
  const streams: MeshStream[] = [];
  let triangles = 0;
  for (const [groupName, faces] of obj.groups) {
    const split = buildAutoSplitStreams(groupName, faces, obj, t);
    names.push(...split.names);
    streams.push(...split.streams);
    triangles += faces.length;
  }

  const bytes = makePckFile(streams, t.virtualOffset);
  const view = new DataView(bytes.buffer);

  bytes[MESH_ID_OFFSET] = meshId & 0xff;

  // Stamp the real shader IDs over the placeholders now that the table's position is known.
  const materialPointer = view.getUint32(0x8c, true);
  const materialTable = PAYLOAD_OFFSET + (materialPointer - view.getUint32(0x00, true));
  if (materialTable < 0 || materialTable + streams.length * 2 > bytes.byteLength) throw new Error("The generated material table is out of bounds.");
  const shaderIds = names.map((name) => parseShaderIdFromMaterial(name));
  shaderIds.forEach((id, index) => view.setUint16(materialTable + index * 2, id & 0xffff, true));

  return { name: `${stem}.pck`, bytes, meshId, shaderIds, groupNames: names, triangles };
}
