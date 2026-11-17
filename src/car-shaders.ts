import type { PckDocument } from "./pck";

/**
 * The car's shader objects, read by following pointers (never by scanning): file 0x88 ->
 * rmcCarModelType, +0xD8 -> drwShaderModel, +0x08 -> rmcShaderGroup. The group's +0x04 array is the
 * shader bank a piece's shader ID indexes; +0x0C is a linked list of named "locals" (CarPaintFresnel*,
 * tint*, *_lights_on, …) that shader tails refer to by index. Validated on 655 car PCKs (HostFS +
 * VIP): the group is always the bank `PckDocument.shaderBank()` finds. Read-only.
 *
 * A shader's class is `flags & 0x7F` (+0x04). Type 0 is a basic shader with a texture at +0x08. All
 * others carry an inline 0x20-byte pass at +0x08 (texture-slot array at pass+0x08, texture count /
 * texgen / combine bytes at pass+0x18..0x1A, next pass at pass+0x1C), the `*.shadert` name at +0x28 and
 * a class tail from +0x30. A null name means a composite: children at +0x30, count at +0x38, and the
 * locals that pick the child from +0x3C (hood paint/carbon, taillight casing, decal normal/chrome).
 * The class tokens at +0x00 differ between PCK families, so they are never used.
 */
export type CarTexture =
  /** An rmcTexturePS2 inside this PCK (the car's atlas, or the 8x8 "window"), by file offset. */
  | { kind: "internal"; name: string; offset: number }
  /** A shared texture the game resolves by name: ASSETS/vehicle/shared_texture/texture or ASSETS/texture,
   *  or one it makes at runtime (__logo__, __decal__, __licenseplate__, none). */
  | { kind: "external"; name: string };
export type CarShaderPass = { textures: (CarTexture | null)[]; texgen: number; combine: number };
export type CarShader = {
  offset: number;
  type: number;
  /** "carpaint", "chrome", … ("" for basic and composite shaders). */
  className: string;
  passes: CarShaderPass[];
  /** Locals this shader's tail refers to, by name. */
  params: Record<string, number>;
  /** chrome / masked_chrome / exhaust_chrome tail: RGB and a reflection factor. */
  tint: [number, number, number, number] | null;
  children: CarShader[];
  /** Composite: the local that picks the child, and its saved value. */
  selector: { name: string; value: number } | null;
};
export type CarShaderSet = { shaders: CarShader[]; locals: { name: string; value: number }[] };

/** Tails that are lists of u8 local indices at +0x30 (count = how many to read). */
const INDEX_TAILS_30: Record<string, number> = { carpaint: 4, carpaint_novinyl: 4, car_window: 9, aa_chrome: 4, aa_trim: 4 };
const FLOAT_TAILS = new Set(["chrome", "masked_chrome", "exhaust_chrome", "more_chrome_wheel_hi_lod"]);
/** Emissive and glass shaders keep their light switches at +0x3C (padded with CD). */
const switchTail = (className: string) => className.startsWith("emissive_") || className.startsWith("player_") || className === "colored_glass";

export function readCarShaders(doc: PckDocument): CarShaderSet | null {
  if (doc.format !== "pck") return null;
  const bytes = doc.bytes; const view = doc.view; const length = bytes.length;
  const u32 = (at: number) => view.getUint32(at, true);
  const ptr = (at: number) => { if (at < 0 || at + 4 > length) return null; const value = u32(at); if (!value) return null; const offset = (value - doc.pointerBase) >>> 0; return offset >= 0x80 && offset < length ? offset : null; };
  const text = (offset: number | null) => {
    if (offset === null) return null;
    let end = offset;
    while (end < length && end - offset < 96 && bytes[end] !== 0) end += 1;
    if (end === offset || end >= length) return null;
    const value = String.fromCharCode(...bytes.subarray(offset, end));
    return /^[\x20-\x7e]+$/.test(value) ? value : null;
  };
  const modelType = ptr(0x88); if (modelType === null) return null;
  const shaderModel = ptr(modelType + 0xd8); if (shaderModel === null) return null;
  const group = ptr(shaderModel + 8); if (group === null || group + 16 > length) return null;
  const array = ptr(group + 4); const count = view.getUint16(group + 8, true);
  if (array === null || array + count * 4 > length || count < 1 || count > 256) return null;

  const locals: { name: string; value: number }[] = [];
  const seen = new Set<number>();
  for (let node = ptr(group + 12); node !== null && node + 12 <= length && !seen.has(node) && locals.length < 512; node = ptr(node)) {
    seen.add(node);
    locals.push({ name: text(ptr(node + 4)) ?? "", value: view.getFloat32(node + 8, true) });
  }
  const local = (index: number) => (index < locals.length ? locals[index] : null);

  const texture = (offset: number | null): CarTexture | null => {
    if (offset === null || offset + 0x10 > length) return null;
    const kind = bytes[offset + 4];
    if (kind === 0 && offset + 0xa0 <= length) return { kind: "internal", name: text(ptr(offset + 0x78)) ?? "", offset };
    if (kind !== 2) return null;
    const name = text(ptr(offset + 8)) ?? "";
    // In-file target = this car's own texture; anything else is a stale address of a global one.
    const target = ptr(offset + 12);
    if (target !== null && target + 0xa0 <= length && bytes[target + 4] === 0) return { kind: "internal", name: text(ptr(target + 0x78)) ?? name, offset: target };
    return { kind: "external", name };
  };

  const read = (offset: number | null, depth: number): CarShader | null => {
    if (offset === null || offset + 0x40 > length || depth > 4) return null;
    const type = u32(offset + 4) & 0x7f;
    const base: CarShader = { offset, type, className: "", passes: [], params: {}, tint: null, children: [], selector: null };
    if (type === 0) return { ...base, passes: [{ textures: [texture(ptr(offset + 8))], texgen: 0, combine: 0 }] };
    const name = text(ptr(offset + 0x28));
    const childCount = u32(offset + 0x38); const children = ptr(offset + 0x30);
    if (name === null && children !== null && childCount >= 1 && childCount <= 16 && children + childCount * 4 <= length) {
      base.children = Array.from({ length: childCount }, (_, i) => read(ptr(children + i * 4), depth + 1)).filter((child): child is CarShader => child !== null);
      const pick = local(bytes[offset + 0x3c]);
      if (pick) base.selector = { name: pick.name, value: pick.value };
      return base;
    }
    base.className = (name ?? "").replace(/\.shadert$/, "");
    for (let pass: number | null = offset + 8, n = 0; pass !== null && n < 4; n += 1) {
      const slots = ptr(pass + 8); const textureCount = Math.min(bytes[pass + 0x18], 4);
      base.passes.push({ textures: Array.from({ length: textureCount }, (_, i) => (slots === null ? null : texture(ptr(slots + i * 4)))), texgen: bytes[pass + 0x19], combine: bytes[pass + 0x1a] });
      pass = ptr(pass + 0x1c);
    }
    const indexTail = INDEX_TAILS_30[base.className];
    const indices = indexTail ? [...bytes.subarray(offset + 0x30, offset + 0x30 + indexTail)] : switchTail(base.className) ? [...bytes.subarray(offset + 0x3c, offset + 0x40)].filter((value) => value !== 0xcd) : [];
    for (const index of indices) { const entry = local(index); if (entry?.name) base.params[entry.name] = entry.value; }
    if (FLOAT_TAILS.has(base.className)) {
      const values = [0, 4, 8, 12].map((at) => view.getFloat32(offset + 0x30 + at, true));
      if (values.every((value) => Number.isFinite(value) && value >= 0 && value <= 4)) base.tint = values as [number, number, number, number];
    }
    return base;
  };

  const shaders: CarShader[] = [];
  for (let i = 0; i < count; i += 1) {
    const shader = read(ptr(array + i * 4), 0);
    if (!shader) return null;
    shaders.push(shader);
  }
  return { shaders, locals };
}

/** Every texture a shader (and its children) reads, for preloading. */
export function shaderTextures(shader: CarShader): CarTexture[] {
  return [...shader.passes.flatMap((pass) => pass.textures.filter((item): item is CarTexture => item !== null)), ...shader.children.flatMap(shaderTextures)];
}

/**
 * The car paint shader an imported material without a shader ID gets: the lowest ID whose shader is
 * a plain `carpaint` in every given set, else a plain `carpaint_novinyl`. Composites (hood paint +
 * carbon) are skipped even when a child is carpaint. Null when the sets don't share one.
 */
export function defaultCarpaintShaderId(sets: CarShaderSet[]): { id: number; className: string } | null {
  if (!sets.length) return null;
  for (const className of ["carpaint", "carpaint_novinyl"]) {
    const ids = sets[0].shaders.flatMap((shader, id) => (shader.className === className ? [id] : []));
    const id = ids.find((candidate) => sets.every((set) => set.shaders[candidate]?.className === className));
    if (id !== undefined) return { id, className };
  }
  return null;
}

const shaderLabel = (shader: CarShader): string => shader.className || (shader.children.length ? shader.children.map(shaderLabel).join(" + ") : "basic");

/** The car's shader list as a text table: ID, shader, the textures it reads. */
export function shaderListText(fileName: string, set: CarShaderSet) {
  const rows = set.shaders.map((shader, id) => ({
    id: `0x${id.toString(16).toUpperCase().padStart(2, "0")}`,
    name: shaderLabel(shader),
    textures: [...new Set(shaderTextures(shader).map((texture) => texture.name || "?"))].join(", "),
  }));
  const width = Math.max(6, ...rows.map((row) => row.name.length));
  return [`${fileName}: ${rows.length} shaders`, "", `ID    ${"Shader".padEnd(width)}  Textures`, ...rows.map((row) => `${row.id}  ${row.name.padEnd(width)}  ${row.textures}`), ""].join("\r\n");
}
