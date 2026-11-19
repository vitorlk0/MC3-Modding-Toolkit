import * as THREE from "three";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";
import { readCarShaders } from "../src/car-shaders";
import { anchorWorldPosition, resolveGroupShaderId, resolvePieceId, type MeshGeometry } from "../src/mesh";
import type { PckDocument } from "../src/pck";
import { encodePng } from "../src/png";
import type { RgbaImage } from "../src/ps2-texture";
import { anchorWorldQuaternion } from "./anchor-rotation";
import { GameTextureSet, NO_LIGHTS, compositeChild, externalTextureNames, gameMaterial, loadSharedTextures, type GameLookOptions } from "./game-look";

/**
 * File > Export: the whole car — every high-LOD piece the Anchor Editor draws — as one OBJ (+ MTL and
 * PNG textures) or one GLB, each piece its own object, placed by its anchor (position and rotation),
 * with one material per shader ID carrying the Game look's colors and the car's textures.
 *
 * Both formats use the per-piece exporter's frame (src/obj-export.ts): game (x, y, z) -> (-z, y, x),
 * the inverse of the OBJ converter's 90° Y turn, so a piece exported alone and the same piece in a
 * car export line up. OBJ has no object transforms, so its vertices are written in place and every
 * object's origin is the world origin. The GLB keeps each piece's own coordinates — the same numbers
 * the per-piece OBJ holds — under a node at its anchor, so in Blender each object's origin sits on
 * its anchor. Read-only: nothing here writes to the vehicle set.
 */

const hex = (value: number, digits: number) => value.toString(16).toUpperCase().padStart(digits, "0");
/** game -> export frame: a -90° turn about Y, (x, y, z) -> (-z, y, x). */
const TO_EXPORT = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.PI / 2);
const TO_EXPORT_INVERSE = TO_EXPORT.clone().invert();

export type CarExportInput = { document: PckDocument; meshes: MeshGeometry[]; assetsRoot: string | null; paint: string };
type ExportPiece = {
  name: string;
  pieceId: number;
  anchorName: string;
  mesh: MeshGeometry;
  /** Resolved shader ID of each material group, the value the Mesh Editor shows. */
  groupShaders: number[];
  /** Anchor transform in the export frame. */
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
};
type ExportMaterial = { id: number; name: string; className: string; material: THREE.Material };
export type CarExport = {
  pieces: ExportPiece[];
  materials: Map<number, ExportMaterial>;
  triangles: number;
  /** Shared textures the car's shaders name that could not be read (ASSETS not found, or missing files). */
  missingTextures: string[];
  dispose(): void;
};

/** "03 - carpaint": the form the OBJ converter reads back to shader 0x03 (parseShaderIdFromMaterial). */
function materialName(id: number, className: string) {
  return id <= 0xff ? `${hex(id, 2)} - ${className}` : `shader_${hex(id, 4)} - ${className}`;
}

/** Reads the car's shaders and textures and lays out every piece; the caller disposes the result. */
export async function buildCarExport({ document, meshes, assetsRoot, paint }: CarExportInput): Promise<CarExport> {
  const shaders = readCarShaders(document);
  const names = shaders ? externalTextureNames(shaders).filter((name) => name !== "__envmap__") : [];
  const external = assetsRoot && names.length ? await loadSharedTextures(assetsRoot, names) : new Map<string, RgbaImage | null>();
  const textures = new GameTextureSet(null, document, external);
  const options: GameLookOptions = { paint, lights: NO_LIGHTS, composite: {} };

  const used = new Set<string>();
  const pieces: ExportPiece[] = [];
  let triangles = 0;
  for (const mesh of meshes) {
    if (!mesh.indices.length) continue;
    const pieceId = resolvePieceId(mesh.name, mesh.meshId, document).displayId;
    const groupShaders = mesh.groupShaderIds.map((_id, group) => resolveGroupShaderId(mesh.name, group, mesh, document).displayId);
    const anchor = mesh.anchorIndex ?? 0;
    const [x, y, z] = anchorWorldPosition(document, anchor, "a2");
    const base = `${hex(pieceId & 0xff, 2)} - ${mesh.name.replace(/\.pck$/i, "")}`;
    let name = base;
    for (let copy = 2; used.has(name.toLowerCase()); copy += 1) name = `${base} (${copy})`;
    used.add(name.toLowerCase());
    pieces.push({
      name, pieceId, mesh, groupShaders,
      anchorName: document.pieces[anchor]?.name ?? "",
      position: new THREE.Vector3(x, y, z).applyQuaternion(TO_EXPORT),
      quaternion: TO_EXPORT.clone().multiply(anchorWorldQuaternion(document, anchor)).multiply(TO_EXPORT_INVERSE),
    });
    triangles += mesh.indices.length / 3;
  }

  const materials = new Map<number, ExportMaterial>();
  for (const piece of pieces) for (const id of piece.groupShaders) {
    if (materials.has(id)) continue;
    const shader = shaders?.shaders[id];
    const className = shader ? compositeChild(shader, options).className || "basic" : "unknown";
    let material = shader ? gameMaterial(shader, textures, options) : new THREE.MeshStandardMaterial({ color: 0x8a8a8a, roughness: 0.8, side: THREE.DoubleSide });
    // What the viewer hides (decals the game draws at runtime, masks it couldn't read) is written
    // fully transparent: exported as-is it would come out as an opaque white layer over the body.
    if (!material.visible) {
      material.dispose();
      material = new THREE.MeshStandardMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide });
    }
    // Lights are exported off: no emission, and no zero-strength emissive extension in the GLB.
    if (material instanceof THREE.MeshStandardMaterial && material.emissive.equals(new THREE.Color(0, 0, 0))) material.emissiveIntensity = 1;
    material.name = materialName(id, className);
    materials.set(id, { id, name: material.name, className, material });
  }

  const missingTextures = names.filter((name) => !external.get(name));
  return {
    pieces, materials, triangles, missingTextures,
    dispose() { for (const entry of materials.values()) entry.material.dispose(); textures.dispose(); },
  };
}

/** A piece's triangles bucketed by resolved shader ID, in ID order. */
function trianglesByShader(piece: ExportPiece) {
  const { mesh, groupShaders } = piece;
  const buckets = new Map<number, number[]>();
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const id = groupShaders[mesh.vertexGroupIndices[mesh.indices[t]]] ?? mesh.vertexShaderIds[mesh.indices[t]];
    let list = buckets.get(id);
    if (!list) buckets.set(id, list = []);
    list.push(t);
  }
  return [...buckets.entries()].sort((a, b) => a[0] - b[0]);
}

/** (x, y, z) -> (-z, y, x), for a whole position or normal array. */
function toExportFrame(source: Float32Array) {
  const out = new Float32Array(source.length);
  for (let i = 0; i < source.length; i += 3) { out[i] = -source[i + 2]; out[i + 1] = source[i + 1]; out[i + 2] = source[i]; }
  return out;
}

export async function exportCarGlb(car: CarExport): Promise<Uint8Array> {
  const scene = new THREE.Scene();
  const geometries: THREE.BufferGeometry[] = [];
  for (const piece of car.pieces) {
    const { mesh } = piece;
    const geometry = new THREE.BufferGeometry();
    geometry.name = piece.name;
    geometry.setAttribute("position", new THREE.BufferAttribute(toExportFrame(mesh.positions), 3));
    geometry.setAttribute("normal", new THREE.BufferAttribute(toExportFrame(mesh.normals), 3));
    // glTF reads v = 0 at the image's first row, which is how the GS samples it: UVs go as stored.
    geometry.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(mesh.uvs), 2));
    const index: number[] = [];
    const materials: THREE.Material[] = [];
    for (const [id, faces] of trianglesByShader(piece)) {
      geometry.addGroup(index.length, faces.length * 3, materials.length);
      materials.push(car.materials.get(id)!.material);
      for (const t of faces) index.push(mesh.indices[t], mesh.indices[t + 1], mesh.indices[t + 2]);
    }
    geometry.setIndex(index);
    geometries.push(geometry);
    const object = new THREE.Mesh(geometry, materials);
    object.name = piece.name;
    object.position.copy(piece.position);
    object.quaternion.copy(piece.quaternion);
    // glTF extras -> custom properties in Blender.
    object.userData = { mc3PieceId: `0x${hex(piece.pieceId, 2)}`, mc3Anchor: piece.anchorName, mc3Source: mesh.name };
    scene.add(object);
  }
  try {
    const result = await new GLTFExporter().parseAsync(scene, { binary: true, onlyVisible: false });
    return new Uint8Array(result as ArrayBuffer);
  } finally {
    for (const geometry of geometries) geometry.dispose();
  }
}

export type CarObjExport = { obj: string; mtlName: string; mtl: string; images: { fileName: string; bytes: Uint8Array }[] };

const fmt = (value: number) => {
  const text = value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  return text === "-0" ? "0" : text;
};
const safeFileName = (text: string) => text.replace(/[^0-9a-z_\-]+/gi, "_").replace(/^_+|_+$/g, "");

/** OBJ + MTL text and the textures' PNGs; `stem` names the MTL and PNG files written next to the OBJ. */
export async function exportCarObj(car: CarExport, stem: string): Promise<CarObjExport> {
  const mtlName = `${stem}.mtl`;
  const lines: string[] = ["# MC3 Modding Toolkit — car export", `# ${car.pieces.length} pieces, placed by their anchors; every object's origin is the world origin (OBJ has no object transforms)`, `mtllib ${mtlName}`];
  const vertex = new THREE.Vector3();
  let base = 1;
  for (const piece of car.pieces) {
    const { mesh, position, quaternion } = piece;
    const count = mesh.positions.length / 3;
    lines.push(`o ${piece.name}`);
    for (let i = 0; i < count; i += 1) {
      vertex.set(-mesh.positions[i * 3 + 2], mesh.positions[i * 3 + 1], mesh.positions[i * 3]).applyQuaternion(quaternion).add(position);
      lines.push(`v ${fmt(vertex.x)} ${fmt(vertex.y)} ${fmt(vertex.z)}`);
    }
    // OBJ's v = 0 is the image's bottom row: V is flipped, as in the per-piece export.
    for (let i = 0; i < count; i += 1) lines.push(`vt ${fmt(mesh.uvs[i * 2])} ${fmt(1 - mesh.uvs[i * 2 + 1])}`);
    for (let i = 0; i < count; i += 1) {
      vertex.set(-mesh.normals[i * 3 + 2], mesh.normals[i * 3 + 1], mesh.normals[i * 3]).applyQuaternion(quaternion);
      lines.push(`vn ${fmt(vertex.x)} ${fmt(vertex.y)} ${fmt(vertex.z)}`);
    }
    for (const [id, faces] of trianglesByShader(piece)) {
      lines.push(`usemtl ${car.materials.get(id)!.name}`);
      for (const t of faces) {
        const [a, b, c] = [mesh.indices[t] + base, mesh.indices[t + 1] + base, mesh.indices[t + 2] + base];
        lines.push(`f ${a}/${a}/${a} ${b}/${b}/${b} ${c}/${c}/${c}`);
      }
    }
    base += count;
  }

  const images: { fileName: string; bytes: Uint8Array }[] = [];
  const textureFiles = new Map<THREE.Texture, string>();
  const takenFiles = new Set<string>();
  const mtl: string[] = ["# MC3 Modding Toolkit — car export materials (one per shader ID; colors are the Game look's)"];
  for (const entry of [...car.materials.values()].sort((a, b) => a.id - b.id)) {
    const material = entry.material as THREE.MeshStandardMaterial;
    const roughness = material.roughness ?? 1;
    const metalness = material.metalness ?? 0;
    const opacity = material.transparent ? material.opacity : 1;
    mtl.push("", `newmtl ${entry.name}`, `Kd ${fmt(material.color.r)} ${fmt(material.color.g)} ${fmt(material.color.b)}`, "Ks 0.5 0.5 0.5", `Ns ${fmt((1 - roughness) ** 2 * 1000)}`, `Pr ${fmt(roughness)}`, `Pm ${fmt(metalness)}`, `d ${fmt(opacity)}`, "illum 2");
    const map = material.map;
    const image = map?.image as RgbaImage | undefined;
    if (map && image?.data) {
      let fileName = textureFiles.get(map);
      if (!fileName) {
        // Named after the texture (the car's atlas, a shared texture), which several materials share.
        const base = `${stem}_${safeFileName(map.name || entry.name) || "texture"}`;
        fileName = `${base}.png`;
        for (let copy = 2; takenFiles.has(fileName.toLowerCase()); copy += 1) fileName = `${base}_${copy}.png`;
        takenFiles.add(fileName.toLowerCase());
        textureFiles.set(map, fileName);
        images.push({ fileName, bytes: await encodePng({ width: image.width, height: image.height, data: image.data }) });
      }
      const scale = map.repeat.x !== 1 || map.repeat.y !== 1 ? `-s ${fmt(map.repeat.x)} ${fmt(map.repeat.y)} 1 ` : "";
      mtl.push(`map_Kd ${scale}${fileName}`);
      if (material.alphaTest > 0 || material.transparent) mtl.push(`map_d ${scale}${fileName}`);
    }
  }
  return { obj: lines.join("\n") + "\n", mtlName, mtl: mtl.join("\n") + "\n", images };
}
