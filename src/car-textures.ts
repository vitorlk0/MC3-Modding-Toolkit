import { PckDocument } from "./pck";
import { readCarShaders, type CarShader } from "./car-shaders";
import type { Candidate } from "./ps2-texture";
import type { MeshGeometry } from "./mesh";

/**
 * The textures a car PCK really uses, found by following its shaders (see car-shaders.ts) instead of
 * scanning: every rmcTexturePS2 a shader slot points to, directly or through a named reference. That
 * is the car's atlas (256x256, 128x128 in the _o; one mip, or four in the Remix layout) and the 8x8
 * 4-bit "window". Shared textures resolved by name (lamps, grills, carbon, __envmap__) live outside
 * the PCK and are not listed. Read-only.
 */
export type CarTextureUse = { shaderId: number; className: string };
export type CarTextureEntry = {
  /** File offset of the rmcTexturePS2 object. */
  objectOffset: number;
  name: string;
  width: number;
  height: number;
  bpp: 4 | 8;
  /** [size, offset relative to mip 0's pixels] for every mip, largest first, from the page pointers. */
  mips: [number, number][];
  textureOffset: number;
  paletteOffset: number;
  /** Bank entries (shader IDs) that draw with it; a composite counts when any of its children does. */
  usedBy: CarTextureUse[];
};

const describe = (shader: CarShader): string => shader.className || (shader.children.length ? shader.children.map(describe).join(" + ") : "basic");

/** Null when `bytes` isn't a car PCK whose shader list can be followed (Flash/UI, PSP, unexpected). */
export function listCarTextures(name: string, bytes: Uint8Array): { entries: CarTextureEntry[]; doc: PckDocument } | null {
  let doc: PckDocument;
  try { doc = new PckDocument(name, bytes.slice().buffer); } catch { return null; }
  const set = readCarShaders(doc);
  if (!set) return null;
  const view = doc.view; const length = doc.bytes.length;
  const byObject = new Map<number, CarTextureEntry>();
  const visit = (shader: CarShader, shaderId: number, root: CarShader) => {
    for (const pass of shader.passes) for (const texture of pass.textures) {
      if (texture?.kind !== "internal") continue;
      let entry = byObject.get(texture.offset);
      if (!entry) {
        const at = texture.offset;
        const low = view.getUint32(at + 0x10, true), high = view.getUint32(at + 0x14, true);
        const psm = (low >>> 20) & 63; const bpp = psm === 19 ? 8 : psm === 20 ? 4 : 0;
        const width = 1 << ((low >>> 26) & 15), height = 1 << (((low >>> 30) | (high << 2)) & 15);
        const count = doc.bytes[at + 0x86];
        const pixels = Array.from({ length: count }, (_, mip) => ((view.getUint32(at + 0x48 + mip * 12, true) - doc.pointerBase) >>> 0) + 0x90);
        if (!bpp || count < 1 || count > 4 || pixels.some((offset) => offset < 0x80 || offset >= length)) continue;
        const paletteOffset = pixels[count - 1] + view.getUint16(at + 0x80, true) * 16;
        if (paletteOffset + (bpp === 8 ? 0x400 : 0x40) > length) continue;
        entry = { objectOffset: at, name: texture.name, width, height, bpp, mips: pixels.map((offset, mip) => [width >> mip, offset - pixels[0]] as [number, number]), textureOffset: pixels[0], paletteOffset, usedBy: [] };
        byObject.set(at, entry);
      }
      if (!entry.usedBy.some((use) => use.shaderId === shaderId)) entry.usedBy.push({ shaderId, className: describe(root) });
    }
    for (const child of shader.children) visit(child, shaderId, root);
  };
  set.shaders.forEach((shader, id) => visit(shader, id, shader));
  const entries = [...byObject.values()].sort((a, b) => b.width * b.height - a.width * a.height || a.objectOffset - b.objectOffset);
  return { entries, doc };
}

/** The Textures tab's list item for an exact entry. Import/export read its sizes and mip offsets. */
export function carTextureCandidate(entry: CarTextureEntry): Candidate {
  return {
    textureOffset: entry.textureOffset, paletteOffset: entry.paletteOffset, layout: entry.mips.length > 1 ? "remix" : "nonremix", paletteOrder: "RGBA",
    score: 100, coarseScore: 100, alphaValid: 0, alphaUnique: 0, paletteUnique: 0, indexUnique: 0, entropy: 0, edgeMean: null, mipError: null, notes: [],
    width: entry.width, height: entry.height, bpp: entry.bpp, headerOffset: null, sequenceIndex: null, paletteColors: entry.bpp === 8 ? 256 : 16,
    mips: entry.mips, exact: { name: entry.name, objectOffset: entry.objectOffset, usedBy: entry.usedBy },
  };
}

/** For one piece, the UV triangles drawn with any of `shaderIds`: flat [u0, v0, u1, v1, u2, v2, …]. */
export function uvTriangles(mesh: MeshGeometry, shaderIds: Set<number>) {
  const out: number[] = [];
  for (let t = 0; t + 2 < mesh.indices.length; t += 3) {
    const a = mesh.indices[t], b = mesh.indices[t + 1], c = mesh.indices[t + 2];
    if (!shaderIds.has(mesh.vertexShaderIds[a])) continue;
    out.push(mesh.uvs[a * 2], mesh.uvs[a * 2 + 1], mesh.uvs[b * 2], mesh.uvs[b * 2 + 1], mesh.uvs[c * 2], mesh.uvs[c * 2 + 1]);
  }
  return out;
}
