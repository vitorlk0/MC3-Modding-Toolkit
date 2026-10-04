import type { MeshGeometry } from "./mesh";

export type ObjExport = { fileName: string; text: string; triangles: number; groups: number; uvZeroedPackets: number };

const fmt = (value: number) => {
  const text = value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  return text === "-0" ? "0" : text;
};
const hex2 = (value: number) => value.toString(16).toUpperCase().padStart(2, "0");

/** Material name the OBJ->PCK converter reads back to the same shader ID (parseShaderIdFromMaterial).
 *  The slot number keeps groups that share a shader apart, since the converter groups by material. */
function materialName(group: number, shaderId: number) {
  const slot = `slot_${group.toString().padStart(3, "0")}`;
  return shaderId <= 0xff ? `${hex2(shaderId)} - ${slot}` : `${slot}_shader_${shaderId.toString(16).toUpperCase().padStart(4, "0")}`;
}

/**
 * Writes a piece as an OBJ the OBJ->PCK converter turns back into the same piece: the filename
 * carries the piece ID (`55 - name.mesh.obj`), one material per group carries its shader ID in
 * group order, normals are the ones stored in the PCK, and V is flipped to undo the converter's
 * default flipV. Coordinates stay in the piece's own space — no anchor offset — so it re-imports in
 * place. Every packet vertex is written as-is (no welding), like the reference PCK->OBJ tool.
 */
export function exportMeshObj(mesh: MeshGeometry, pieceId: number, shaderIds: number[]): ObjExport {
  const stem = mesh.name.replace(/\.pck$/i, "");
  const lines: string[] = [
    "# MC3 Modding Toolkit — piece export",
    `# source: ${mesh.name}${mesh.origin === "embedded" ? ` (embedded ${mesh.lod?.toUpperCase()} copy)` : ""}`,
    `# piece id: 0x${hex2(pieceId)}`,
  ];
  if (mesh.uvZeroedPackets) lines.push(`# ${mesh.uvZeroedPackets} packet(s) use an undecoded UV variant; their UVs are written as 0`);
  lines.push(`o ${stem}`);
  const vertexCount = mesh.positions.length / 3;
  // The converter turns OBJ space into game space with a 90° Y rotation (x, z) -> (z, -x), so the
  // inverse (x, y, z) -> (-z, y, x) goes here, for positions and normals alike.
  const toObj = (source: Float32Array, i: number) => `${fmt(-source[i * 3 + 2])} ${fmt(source[i * 3 + 1])} ${fmt(source[i * 3])}`;
  for (let i = 0; i < vertexCount; i += 1) lines.push(`v ${toObj(mesh.positions, i)}`);
  for (let i = 0; i < vertexCount; i += 1) lines.push(`vt ${fmt(mesh.uvs[i * 2])} ${fmt(1 - mesh.uvs[i * 2 + 1])}`);
  for (let i = 0; i < vertexCount; i += 1) lines.push(`vn ${toObj(mesh.normals, i)}`);

  // Every vertex of a packet belongs to one group, so a triangle's first vertex names its group.
  const byGroup = new Map<number, number[]>();
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const group = mesh.vertexGroupIndices[mesh.indices[t]];
    let list = byGroup.get(group);
    if (!list) byGroup.set(group, list = []);
    list.push(t);
  }
  const groups = [...byGroup.keys()].sort((a, b) => a - b);
  for (const group of groups) {
    const name = materialName(group, shaderIds[group] ?? mesh.groupShaderIds[group]);
    lines.push(`g ${name.replace(/\s+/g, "_")}`, `usemtl ${name}`);
    for (const t of byGroup.get(group)!) {
      const [a, b, c] = [mesh.indices[t] + 1, mesh.indices[t + 1] + 1, mesh.indices[t + 2] + 1];
      lines.push(`f ${a}/${a}/${a} ${b}/${b}/${b} ${c}/${c}/${c}`);
    }
  }
  return {
    fileName: `${hex2(pieceId & 0xff)} - ${stem}.obj`,
    text: lines.join("\n") + "\n",
    triangles: mesh.indices.length / 3,
    groups: groups.length,
    uvZeroedPackets: mesh.uvZeroedPackets,
  };
}
