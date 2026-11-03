import type { MeshDataBlock, StoredVertex } from "./obj";
import { buildMeshPck, encodeStoredTriangles } from "./obj";
import type { MeshGeometry } from "./mesh";

/**
 * Moves a piece's triangles to another material slot (shader), the Meshes tab's "Assign shader".
 *
 * Re-encoding a whole native piece through the converter's stripifier draws the same triangles but
 * makes the piece ~21% bigger (1.97 emitted vertices per triangle against the game's 1.59), so the
 * piece is not re-encoded. Instead:
 * - every data block is copied byte for byte;
 * - each moved triangle is switched off where it is, by setting the face flag (bit 0 of the first
 *   normal byte) of the strip vertex that closes it — what the game itself uses to skip a triangle;
 * - a moved triangle that is still there switched off in a slot of the target shader (it was moved
 *   out of it earlier) is switched back on there;
 * - the others are written as fresh packets in a new data block of the target slot, with every
 *   vertex's stored values, crash-deformation damage included, carried over exactly.
 * A block this edit leaves with no drawn triangle is dropped, and so is a slot left drawing nothing,
 * so moving triangles back where they came from costs nothing.
 *
 * Checked on every loose piece of the HostFS and VIP installs (moving a patch of the biggest slot):
 * every drawn triangle comes back with the same position, UV, normal, damage, winding and shader,
 * at ~31-34 bytes per moved triangle.
 *
 * `source` is the bytes the piece was parsed from (a loose mesh.pck, or the car PCK for an embedded
 * copy); the result is always a standalone mesh.pck, ready for the loose file or replaceEmbeddedMesh.
 */
export type SlotMoveResult = { bytes: Uint8Array; moved: number; group: number; newSlot: boolean };

export function moveTrianglesToShader(source: Uint8Array, mesh: MeshGeometry, triangles: Iterable<number>, shaderId: number, compact: boolean): SlotMoveResult {
  if (mesh.uvZeroedPackets) throw new Error(`${mesh.name} has packets without UVs, which can't be carried over.`);
  const scale = Math.min(...mesh.packets.map((packet) => packet.scale));
  if (!Number.isFinite(scale) || scale <= 0) throw new Error(`${mesh.name} has a packet with an invalid scale.`);

  const shaderOf = (triangle: number) => mesh.groupShaderIds[mesh.vertexGroupIndices[mesh.indices[triangle * 3]]];
  const moving = [...new Set(triangles)].filter((triangle) => triangle >= 0 && triangle < mesh.triangleSources.length && shaderOf(triangle) !== shaderId);
  if (!moving.length) return { bytes: source, moved: 0, group: -1, newSlot: false };

  // Copies of every block, which the face flags are then set and cleared in.
  const blocks = mesh.groupBlocks.map((list) => list.map((block) => ({ ...block, bytes: source.slice(block.offset, block.offset + block.size), drawn: 0, removed: 0, revived: 0 })));
  for (const sourceId of mesh.triangleSources) {
    const packet = mesh.packets[Math.floor(sourceId / 256)];
    blocks[packet.group][packet.block].drawn += 1;
  }

  // A vertex's stored values, and a triangle's in the winding the game draws it with: the strip
  // parity of the vertex that closes it (KB §10.6.2).
  const storedValue = (vertex: number): StoredVertex => {
    const xyz = [0, 1, 2].map((k) => mesh.positions[vertex * 3 + k] / scale) as [number, number, number];
    if (!xyz.every(Number.isInteger)) throw new Error(`${mesh.name} mixes packet grids in a way this can't carry over.`);
    const normalAt = mesh.vertexNormalOffsets[vertex];
    return {
      xyz,
      uv: [Math.round(mesh.uvs[vertex * 2] * 4096), Math.round(mesh.uvs[vertex * 2 + 1] * 4096)],
      normal: [source[normalAt] & 0xfe, source[normalAt + 1], source[normalAt + 2]],
      damage: Array.from(mesh.vertexDamage.subarray(vertex * 4, vertex * 4 + 4)) as StoredVertex["damage"],
    };
  };
  const valueKey = (value: StoredVertex) => `${value.xyz}|${value.uv}|${value.normal}|${value.damage}`;
  const stripOrder = (firstVertex: number, closing: number) => (closing % 2 === 0 ? [closing - 2, closing - 1, closing] : [closing - 1, closing - 2, closing]).map((local) => firstVertex + local);
  const triangleKey = (corners: number[]) => {
    const keys = corners.map((vertex) => valueKey(storedValue(vertex)));
    return [0, 1, 2].map((r) => `${keys[r]};${keys[(r + 1) % 3]};${keys[(r + 2) % 3]}`).sort()[0];
  };

  // Triangles switched off in the slots that already use this shader, by what they would draw: a
  // triangle moved back to a shader it left is switched on again there instead of written anew.
  const dormant = new Map<string, { group: number; block: number; flagAt: number }[]>();
  for (const packet of mesh.packets) {
    if (mesh.groupShaderIds[packet.group] !== shaderId) continue;
    const block = blocks[packet.group][packet.block];
    for (let closing = 2; closing < packet.count; closing += 1) {
      const at = mesh.vertexNormalOffsets[packet.firstVertex + closing];
      if (!(source[at] & 0x01)) continue;
      const key = triangleKey(stripOrder(packet.firstVertex, closing));
      const list = dormant.get(key) ?? [];
      list.push({ group: packet.group, block: packet.block, flagAt: at - block.offset });
      dormant.set(key, list);
    }
  }

  // The rest are written fresh; their vertices are shared when every stored value repeats, so strips can join.
  const vertices: StoredVertex[] = [];
  const shared = new Map<string, number>();
  const stored = (vertex: number): number => {
    const value = storedValue(vertex);
    const key = valueKey(value);
    let index = shared.get(key);
    if (index === undefined) { index = vertices.length; shared.set(key, index); vertices.push(value); }
    return index;
  };
  const fresh: [number, number, number][] = [];
  for (const triangle of moving) {
    const sourceId = mesh.triangleSources[triangle];
    const packet = mesh.packets[Math.floor(sourceId / 256)];
    const closing = sourceId % 256;
    const block = blocks[packet.group][packet.block];
    const flagAt = mesh.vertexNormalOffsets[packet.firstVertex + closing] - block.offset;
    if (flagAt < 0 || flagAt >= block.size) throw new Error(`${mesh.name}: a triangle's face flag is outside its block.`);
    block.bytes[flagAt] |= 0x01;
    block.removed += 1;
    const corners = stripOrder(packet.firstVertex, closing);
    const match = dormant.get(triangleKey(corners))?.pop();
    if (match) {
      const home = blocks[match.group][match.block];
      home.bytes[match.flagAt] &= 0xfe;
      home.revived += 1;
    } else fresh.push(corners.map(stored) as [number, number, number]);
  }

  // A block this edit emptied is dropped; a slot left drawing nothing is dropped with its blocks.
  const existing = mesh.groupShaderIds.indexOf(shaderId);
  const target = fresh.length ? (existing >= 0 ? existing : mesh.groupShaderIds.length) : -1;
  const groups: { shaderId: number; blocks: MeshDataBlock[]; keep: boolean }[] = mesh.groupShaderIds.map((id, group) => {
    const list = blocks[group];
    const alive = (block: (typeof list)[number]) => block.drawn - block.removed + block.revived;
    const kept = list.filter((block) => !(block.removed > 0 && alive(block) === 0));
    const touched = list.some((block) => block.removed > 0);
    const drawing = list.reduce((sum, block) => sum + alive(block), 0) > 0 || group === target;
    return { shaderId: id, blocks: kept.map(({ bytes, vertexCount }) => ({ bytes, vertexCount })), keep: drawing || !touched };
  });
  if (target === groups.length) groups.push({ shaderId, blocks: [], keep: true });
  if (target >= 0) groups[target].blocks.push(...encodeStoredTriangles(vertices, fresh, 1 / scale, compact));
  const output = groups.filter((group) => group.keep);
  if (!output.length) throw new Error(`${mesh.name} would be left with no material slot.`);
  return { bytes: buildMeshPck(output, mesh.meshId), moved: moving.length, group: target >= 0 ? output.indexOf(groups[target]) : -1, newSlot: target === mesh.groupShaderIds.length };
}
