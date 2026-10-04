import type { Vec3 } from "./pck";

export type PpfKind = "exhaust" | "rim" | "tire";

export type PpfGeometry = {
  kind: PpfKind;
  name: string;
  entryIndex: number;
  entryCount: number;
  packets: number;
  packetVertices: number;
  triangles: number;
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  boundsMin: Vec3;
  boundsMax: Vec3;
};

type PacketLayout = "0x60" | "0x6c";
type Packet = {
  offset: number;
  end: number;
  layout: PacketLayout;
  scale: number;
  vertexCount: number;
  positionOffset: number;
  normalOffset: number;
};

const PF05 = [0x70, 0x66, 0x30, 0x35];
const PACKET_MAGICS = new Map<string, PacketLayout>([
  ["98000260", "0x60"],
  ["c5010260", "0x60"],
  ["9800026c", "0x6c"],
  ["c501026c", "0x6c"],
] as const);

const inside = (offset: number, size: number, total: number) => offset >= 0 && size >= 0 && offset + size <= total;
const bytesKey = (bytes: Uint8Array, offset: number, size: number) => [...bytes.slice(offset, offset + size)].map((value) => value.toString(16).padStart(2, "0")).join("");
const signed8 = (value: number) => value >= 128 ? value - 256 : value;
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const lengthSquared = (value: Vec3) => dot(value, value);
function normalize(value: Vec3): Vec3 {
  const length = Math.sqrt(lengthSquared(value));
  return length > 1e-20 && Number.isFinite(length) ? [value[0] / length, value[1] / length, value[2] / length] : [0, 0, 1];
}

function locateStreamHeader(bytes: Uint8Array, start: number, end: number, vertexCount: number, command: number, itemSize: number) {
  let result = -1;
  const payloadSize = vertexCount * itemSize;
  for (let offset = start; offset + 4 + payloadSize <= end; offset += 1) {
    if (bytes[offset + 2] === vertexCount && bytes[offset + 3] === command) result = offset;
  }
  return result;
}

function collectPackets(bytes: Uint8Array, view: DataView, entryOffset: number, entryEnd: number) {
  const candidates: { offset: number; layout: PacketLayout }[] = [];
  for (let offset = entryOffset; offset <= entryEnd - 4; offset += 1) {
    const layout = PACKET_MAGICS.get(bytesKey(bytes, offset, 4));
    if (layout) candidates.push({ offset, layout });
  }
  const packets: Packet[] = [];
  candidates.forEach((candidate, index) => {
    const end = candidates[index + 1]?.offset ?? entryEnd;
    const countOffset = candidate.layout === "0x60" ? candidate.offset + 0x08 : candidate.offset + 0x14;
    const repeatedCountOffset = candidate.offset + 0x20;
    const positionHeader = candidate.layout === "0x60" ? candidate.offset + 0x0c : candidate.offset + 0x24;
    if (!inside(candidate.offset, candidate.layout === "0x60" ? 0x10 : 0x28, end)) return;
    const scale = view.getFloat32(candidate.offset + 4, true);
    const vertexCount = view.getUint32(countOffset, true);
    if (!Number.isFinite(scale) || scale === 0 || Math.abs(scale) > 1_000_000 || vertexCount < 3 || vertexCount > 0xff) return;
    if (candidate.layout === "0x6c" && (!inside(repeatedCountOffset, 4, end) || view.getUint32(repeatedCountOffset, true) !== vertexCount)) return;
    if (!inside(positionHeader, 4 + vertexCount * 6, end) || bytes[positionHeader + 2] !== vertexCount || bytes[positionHeader + 3] !== 0x69) return;
    const positionOffset = positionHeader + 4;
    const normalHeader = locateStreamHeader(bytes, positionOffset + vertexCount * 6, end, vertexCount, 0x6a, 3);
    if (normalHeader < 0) return;
    packets.push({ offset: candidate.offset, end, layout: candidate.layout, scale, vertexCount, positionOffset, normalOffset: normalHeader + 4 });
  });
  return packets;
}

function decodeEntry(bytes: Uint8Array, view: DataView, entryOffset: number, entryEnd: number) {
  const packets = collectPackets(bytes, view, entryOffset, entryEnd);
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  let packetVertices = 0;
  for (const packet of packets) {
    const vertices: Vec3[] = [];
    const vertexNormals: Vec3[] = [];
    const enabled: boolean[] = [];
    const base = positions.length / 3;
    for (let vertex = 0; vertex < packet.vertexCount; vertex += 1) {
      const positionOffset = packet.positionOffset + vertex * 6;
      const normalOffset = packet.normalOffset + vertex * 3;
      const xyz: Vec3 = [
        view.getInt16(positionOffset, true) * packet.scale,
        view.getInt16(positionOffset + 2, true) * packet.scale,
        view.getInt16(positionOffset + 4, true) * packet.scale,
      ];
      const first = bytes[normalOffset];
      const normal = normalize([signed8(first & 0xfe) / 127, signed8(bytes[normalOffset + 1]) / 127, signed8(bytes[normalOffset + 2]) / 127]);
      vertices.push(xyz); vertexNormals.push(normal); enabled.push((first & 1) === 0);
      positions.push(...xyz); normals.push(...normal);
    }
    for (let vertex = 2; vertex < packet.vertexCount; vertex += 1) {
      if (!enabled[vertex]) continue;
      let triangle: [number, number, number] = vertex % 2 === 0 ? [vertex - 2, vertex - 1, vertex] : [vertex - 1, vertex - 2, vertex];
      const [a, b, c] = triangle.map((item) => vertices[item]) as [Vec3, Vec3, Vec3];
      const face = cross(sub(b, a), sub(c, a));
      if (lengthSquared(face) <= 1e-18) continue;
      if (dot(normalize(face), vertexNormals[vertex]) < 0) triangle = [triangle[1], triangle[0], triangle[2]];
      indices.push(base + triangle[0], base + triangle[1], base + triangle[2]);
    }
    packetVertices += packet.vertexCount;
  }
  return { packets, packetVertices, positions, normals, indices };
}

export function parseFirstPpfModel(name: string, source: ArrayBuffer, kind: PpfKind): PpfGeometry {
  const bytes = new Uint8Array(source.slice(0));
  const view = new DataView(bytes.buffer);
  if (bytes.length < 0x10 || !PF05.every((value, index) => bytes[index] === value)) throw new Error(`${name}: expected a pf05 container.`);
  const entryCount = view.getUint32(4, true);
  const stride = view.getUint32(8, true);
  if (entryCount < 1 || entryCount > 0x10000 || stride < 0x80 || !inside(0x0c, entryCount * 4, bytes.length)) throw new Error(`${name}: invalid pf05 header.`);
  for (let entryIndex = 0; entryIndex < entryCount; entryIndex += 1) {
    const descriptor = 0x0c + entryIndex * 4;
    const blockIndex = view.getUint16(descriptor, true);
    const sizeUnits = view.getUint16(descriptor + 2, true);
    const entryOffset = blockIndex * 0x800;
    const usedSize = sizeUnits * 0x80;
    if (!usedSize || !inside(entryOffset, usedSize, bytes.length)) continue;
    const decoded = decodeEntry(bytes, view, entryOffset, entryOffset + usedSize);
    if (!decoded.indices.length) continue;
    const boundsMin: Vec3 = [Infinity, Infinity, Infinity];
    const boundsMax: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (let offset = 0; offset < decoded.positions.length; offset += 3) {
      for (let axis = 0; axis < 3; axis += 1) {
        boundsMin[axis] = Math.min(boundsMin[axis], decoded.positions[offset + axis]);
        boundsMax[axis] = Math.max(boundsMax[axis], decoded.positions[offset + axis]);
      }
    }
    return {
      kind, name, entryIndex, entryCount, packets: decoded.packets.length, packetVertices: decoded.packetVertices,
      triangles: decoded.indices.length / 3, positions: new Float32Array(decoded.positions), normals: new Float32Array(decoded.normals),
      indices: new Uint32Array(decoded.indices), boundsMin, boundsMax,
    };
  }
  throw new Error(`${name}: no drawable model was found in ${entryCount} pf05 entries.`);
}
