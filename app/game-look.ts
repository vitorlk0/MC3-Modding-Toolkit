import * as THREE from "three";
import { useEffect, useMemo, useState } from "react";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { readCarShaders, shaderTextures, type CarShader, type CarShaderSet, type CarTexture } from "../src/car-shaders";
import { decodeTexFile, readCarTexture, type RgbaImage } from "../src/ps2-texture";
import type { PckDocument } from "../src/pck";
import type { MeshGeometry } from "../src/mesh";
import { readFile } from "@tauri-apps/plugin-fs";

/**
 * "Game look" for the Meshes and Anchor viewers: one three.js material per car shader, approximating what the
 * game's PS2 shader programs (ASSETS/shaderlib/*.shadert) do with the textures and locals the PCK
 * binds. View only; nothing here writes anything.
 */

export type GameLights = { head: boolean; tail: boolean; brake: boolean; reverse: boolean };
export type GameLookOptions = {
  paint: string;
  lights: GameLights;
  /** Composite choice by selector local name (HoodShaderIdx, TaillightCasingShaderIdx); the saved value otherwise. */
  composite: Record<string, number>;
};
/** Game look paint color, kept between sessions and shared by both viewers (a per-viewer convenience). */
const PAINT_KEY = "mc3pae.gamePaint";
export function loadGamePaint() { try { const value = localStorage.getItem(PAINT_KEY); return value && /^#[0-9a-f]{6}$/i.test(value) ? value : "#b3262b"; } catch { return "#b3262b"; } }
export function saveGamePaint(value: string) { try { localStorage.setItem(PAINT_KEY, value); } catch { /* storage unavailable */ } }
export const NO_LIGHTS: GameLights = { head: false, tail: false, brake: false, reverse: false };

/** One draw group per run of faces with the same shader, its material index = the shader ID, so a
 *  per-shader material array applies. `faceMap` lists the drawn triangles (all of them when absent).
 *  A single material ignores the groups. */
export function writeShaderGroups(geometry: THREE.BufferGeometry, parsed: MeshGeometry, faceMap?: ArrayLike<number>) {
  geometry.clearGroups();
  const count = faceMap ? faceMap.length : Math.floor(parsed.indices.length / 3);
  const shaderOf = (face: number) => parsed.vertexShaderIds[parsed.indices[(faceMap ? faceMap[face] : face) * 3]];
  let start = 0;
  for (let face = 1; face <= count; face += 1) {
    if (face < count && shaderOf(face) === shaderOf(start)) continue;
    geometry.addGroup(start * 3, (face - start) * 3, shaderOf(start));
    start = face;
  }
}

/** Shared textures the game makes at runtime: there is no file to read for them. */
export const RUNTIME_TEXTURES = new Set(["__logo__", "__decal__", "__licenseplate__", "none"]);
/** Where the game resolves a shared texture by name, relative to ASSETS, in lookup order. */
export const SHARED_TEXTURE_FOLDERS = ["vehicle/shared_texture/texture", "texture"];

/** The game's ASSETS folder for a car PCK opened from `…/ASSETS/resources/vehicle/<car>/`; null otherwise. */
export function assetsRootOf(path: string | null | undefined) {
  if (!path) return null;
  const parts = path.split(/[\\/]/);
  for (let i = parts.length - 2; i > 0; i -= 1) if (parts[i].toLowerCase() === "resources" && parts[i + 1]?.toLowerCase() === "vehicle") return parts.slice(0, i).join(path.includes("\\") ? "\\" : "/");
  return null;
}

/** Reads and decodes shared textures by name from ASSETS; a name it can't find or decode maps to null. */
export async function loadSharedTextures(assetsRoot: string, names: string[]) {
  const separator = assetsRoot.includes("\\") ? "\\" : "/";
  const result = new Map<string, RgbaImage | null>();
  await Promise.all(names.map(async (name) => {
    for (const folder of SHARED_TEXTURE_FOLDERS) {
      try {
        const image = decodeTexFile(await readFile([assetsRoot, ...folder.split("/"), `${name}.tex`].join(separator)));
        if (image) { result.set(name, image); return; }
      } catch { /* not in this folder */ }
    }
    result.set(name, null);
  }));
  return result;
}

/** Every shared (by-name) texture the car's shaders read, without the runtime ones. */
export function externalTextureNames(set: CarShaderSet) {
  const names = new Set<string>(["__envmap__"]);
  for (const shader of set.shaders) for (const texture of shaderTextures(shader)) if (texture.kind === "external" && !RUNTIME_TEXTURES.has(texture.name)) names.add(texture.name);
  return [...names];
}

const lightOf = (className: string): keyof GameLights | null =>
  className === "emissive_headlight" ? "head"
    : className.endsWith("_taillight") ? "tail"
      : className.endsWith("_brakelight") || className === "emissive_thirdbrakelight" ? "brake"
        : className.endsWith("_reverselight") ? "reverse" : null;

/** The child a composite shows: the user's choice for its selector, else the value saved in the PCK. */
export function compositeChild(shader: CarShader, options: GameLookOptions) {
  if (!shader.children.length) return shader;
  const wanted = shader.selector ? options.composite[shader.selector.name] ?? shader.selector.value : 0;
  const index = Math.min(Math.max(Math.round(Number.isFinite(wanted) ? wanted : 0), 0), shader.children.length - 1);
  return compositeChild(shader.children[index], options);
}

/** Sphere map (PS2 texgen "reflect", scale/slide 0.5) -> equirectangular, for three's PMREM. */
function sphereToEquirect(sphere: RgbaImage) {
  const width = 512, height = 256;
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const lat = ((y + 0.5) / height - 0.5) * Math.PI;
    for (let x = 0; x < width; x += 1) {
      const lon = ((x + 0.5) / width - 0.5) * 2 * Math.PI;
      // three's equirect direction for (u, v); the sphere is seen from a camera looking down -Z.
      const rx = Math.cos(lat) * Math.cos(lon), ry = Math.sin(lat), rz = -Math.cos(lat) * Math.sin(lon);
      const m = 2 * Math.sqrt(rx * rx + ry * ry + (rz + 1) * (rz + 1)) || 1;
      const s = Math.min(sphere.width - 1, Math.max(0, Math.floor((rx / m + 0.5) * sphere.width)));
      // Row 0 of the stored map is the top of the sphere.
      const t = Math.min(sphere.height - 1, Math.max(0, Math.floor((0.5 - ry / m) * sphere.height)));
      const from = (t * sphere.width + s) * 4, to = (y * width + x) * 4;
      // The reflection passes combine with modulate2x: the PS2 draws the map at twice its stored value.
      // The game's map is a night city (median luminance 3/255, a few bright lights), so a sky/horizon
      // studio gradient goes under it to keep chrome readable in an empty viewer.
      const studio = ry > 0 ? 75 + 40 * ry : 60 + 45 * ry;
      for (let c = 0; c < 3; c += 1) out[to + c] = Math.min(255, studio + sphere.data[from + c] * 2);
      out[to + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(out, width, height, THREE.RGBAFormat);
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Textures and the environment for one car document. Decoded once and kept until `dispose`, so
 * rebuilding materials (paint, lights) never decodes again.
 */
export class GameTextureSet {
  private readonly cache = new Map<string, THREE.Texture | null>();
  /** Null without a renderer: a set made for exporting has no reflections to light. */
  readonly environment: THREE.Texture | null;
  /** True when the reflections come from the game's own __envmap__. */
  readonly gameEnvironment: boolean;
  constructor(private readonly renderer: THREE.WebGLRenderer | null, private readonly doc: PckDocument, private readonly external: Map<string, RgbaImage | null>) {
    if (!renderer) { this.environment = null; this.gameEnvironment = false; return; }
    const pmrem = new THREE.PMREMGenerator(renderer);
    const sphere = external.get("__envmap__");
    if (sphere) {
      const equirect = sphereToEquirect(sphere);
      this.environment = pmrem.fromEquirectangular(equirect).texture;
      equirect.dispose();
    } else {
      this.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    }
    this.gameEnvironment = Boolean(sphere);
    pmrem.dispose();
  }
  private make(image: RgbaImage) {
    const texture = new THREE.DataTexture(image.data, image.width, image.height, THREE.RGBAFormat);
    // Stored row 0 is what the GS samples at v = 0, and the parser hands out the UVs as stored.
    texture.flipY = false;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.generateMipmaps = true;
    texture.anisotropy = this.renderer?.capabilities.getMaxAnisotropy() ?? 1;
    texture.needsUpdate = true;
    return texture;
  }
  private image(texture: CarTexture): RgbaImage | null {
    if (texture.kind === "internal") return readCarTexture(this.doc.bytes, this.doc.pointerBase, texture.offset);
    return this.external.get(texture.name) ?? null;
  }
  /** The texture as a color map; null for runtime/missing ones. */
  color(texture: CarTexture | null | undefined) {
    if (!texture) return null;
    const key = texture.kind === "internal" ? `i:${texture.offset}` : `e:${texture.name}`;
    if (!this.cache.has(key)) {
      const image = this.image(texture);
      const made = image ? this.make(image) : null;
      // The texture's own name (atlas, shared texture) — what an export names its image after.
      if (made) made.name = texture.name;
      this.cache.set(key, made);
    }
    return this.cache.get(key)!;
  }
  /** Only the texture's alpha, over a flat color: masks (masked_chrome) and the drop shadow. */
  mask(texture: CarTexture | null | undefined, rgb: [number, number, number]) {
    if (!texture) return null;
    const key = `${texture.kind === "internal" ? `i:${texture.offset}` : `e:${texture.name}`}:${rgb.join(",")}`;
    if (!this.cache.has(key)) {
      const image = this.image(texture);
      if (!image) this.cache.set(key, null);
      else {
        const data = new Uint8Array(image.data.length);
        for (let i = 0; i < data.length; i += 4) { data[i] = rgb[0]; data[i + 1] = rgb[1]; data[i + 2] = rgb[2]; data[i + 3] = image.data[i + 3]; }
        const made = this.make({ width: image.width, height: image.height, data });
        made.name = `${texture.name}_mask`;
        this.cache.set(key, made);
      }
    }
    return this.cache.get(key)!;
  }
  /**
   * Carbon fibre as the game builds it: fx_carbon_fiber's RGB is nearly black (luminance 16-28) and the
   * weave's contrast lives in its alpha (0-133), which the shader uses as the shine mask. So the color
   * is the RGB doubled (modulate2x) plus the alpha weave as highlight. `scale` tiles it (see gameMaterial).
   */
  carbon(texture: CarTexture | null | undefined, scale: number) {
    if (!texture) return null;
    const key = `carbon${scale}:${texture.kind === "internal" ? `i:${texture.offset}` : `e:${texture.name}`}`;
    if (!this.cache.has(key)) {
      const image = this.image(texture);
      if (!image) this.cache.set(key, null);
      else {
        const data = new Uint8Array(image.data.length);
        for (let i = 0; i < data.length; i += 4) {
          const shine = image.data[i + 3] * 0.55;
          for (let c = 0; c < 3; c += 1) data[i + c] = Math.min(255, image.data[i + c] * 2 + shine);
          data[i + 3] = 255;
        }
        const made = this.make({ width: image.width, height: image.height, data });
        made.name = `${texture.name}_carbon`;
        made.repeat.set(scale, scale); made.offset.set(0.5, 0.5);
        this.cache.set(key, made);
      }
    }
    return this.cache.get(key)!;
  }
  /** Forgets the textures decoded from the PCK itself (atlas, window), so they're read again after an edit. */
  dropInternal() {
    for (const [key, texture] of [...this.cache]) if (/(^|:)i:/.test(key)) { texture?.dispose(); this.cache.delete(key); }
  }
  dispose() {
    for (const texture of this.cache.values()) texture?.dispose();
    this.cache.clear();
    this.environment?.dispose();
  }
}

/** Builds the material for one bank entry (resolving composites). Every material is new; the caller disposes it. */
export function gameMaterial(shader: CarShader, textures: GameTextureSet, options: GameLookOptions): THREE.Material {
  const used = compositeChild(shader, options);
  const name = used.className;
  const tex0 = used.passes[0]?.textures[0];
  const map = textures.color(tex0);
  const common = { side: THREE.DoubleSide, envMap: textures.environment } as const;
  const paint = new THREE.Color(options.paint);
  const chromeTint = () => {
    const p = used.params;
    if (used.tint) return new THREE.Color(used.tint[0], used.tint[1], used.tint[2]);
    if (p.chrome_color_r !== undefined) return new THREE.Color(p.chrome_color_r, p.chrome_color_g ?? 1, p.chrome_color_b ?? 1);
    if (p.trim_color_r !== undefined) return new THREE.Color(p.trim_color_r, p.trim_color_g ?? 1, p.trim_color_b ?? 1);
    return new THREE.Color(1, 1, 1);
  };
  let material: THREE.Material;
  if (name === "carpaint" || name === "carpaint_novinyl") {
    const p = used.params;
    material = new THREE.MeshPhysicalMaterial({ ...common, color: paint, metalness: 0.35, roughness: 0.32, clearcoat: (p.CarPaintFresnelMax ?? 0.9) * 0.85, clearcoatRoughness: 0.03, envMapIntensity: 0.5 });
  } else if (name === "chrome" || name === "aa_chrome" || name === "exhaust_chrome" || name === "more_chrome_wheel_hi_lod" || name === "sprocket") {
    material = new THREE.MeshStandardMaterial({ ...common, color: chromeTint(), metalness: 1, roughness: 0.06, envMapIntensity: 1.25 });
  } else if (name === "aa_trim") {
    // Panel gaps (door/fender seams): the body paint, a shade darker and without vinyl, × trim_color.
    material = new THREE.MeshPhysicalMaterial({ ...common, color: paint.clone().multiply(chromeTint()).multiplyScalar(0.6), metalness: 0.1, roughness: 0.5, clearcoat: 0.4, clearcoatRoughness: 0.08, envMapIntensity: 0.2 });
  } else if (name === "masked_chrome") {
    // Pass 1 writes only the mask's alpha; pass 2 blends the reflection in by that alpha.
    const mask = textures.mask(tex0, [255, 255, 255]);
    material = new THREE.MeshStandardMaterial({ ...common, color: chromeTint(), map: mask, metalness: 1, roughness: 0.06, envMapIntensity: 1.25, transparent: true, depthWrite: false, alphaTest: 0.02, visible: Boolean(mask) });
  } else if (name === "car_window") {
    const p = used.params;
    material = new THREE.MeshPhysicalMaterial({ ...common, color: new THREE.Color(p.tintR ?? 0.25, p.tintG ?? 0.285, p.tintB ?? 0.25).multiplyScalar(0.35), metalness: 0, roughness: 0.04, transparent: true, opacity: Math.min(0.92, (p.tintA ?? 0.5) + 0.3), depthWrite: false, envMapIntensity: (p.WinFresnelMax ?? 0.9) * 0.45 });
  } else if (name === "colored_glass") {
    // The lens over a lamp. Its usual texture, the car's 8x8 "window", is plain white: the color is
    // the lamp seen through it, so it is drawn as clear glass. Other textures keep their own alpha.
    const clear = !map || (tex0?.kind === "internal" && tex0.name === "window");
    material = new THREE.MeshStandardMaterial({ ...common, map: clear ? null : map, color: 0xffffff, metalness: 0, roughness: 0.04, transparent: true, opacity: clear ? 0.16 : 1, depthWrite: false, envMapIntensity: 0.9 });
  } else if (lightOf(name)) {
    const light = lightOf(name)!;
    const on = options.lights[light];
    // The brake lamps also glow, dimmer, with the tail lights (their tail references tlights_on).
    const intensity = on ? 2.2 : light === "brake" && options.lights.tail && used.params.tlights_on !== undefined ? 0.7 : 0;
    material = new THREE.MeshStandardMaterial({ ...common, map, color: 0xffffff, emissive: intensity ? 0xffffff : 0x000000, emissiveMap: intensity ? map : null, emissiveIntensity: intensity, metalness: 0.1, roughness: 0.15, envMapIntensity: 0.6, alphaTest: 0.25 });
  } else if (name === "carbon_fiber") {
    // Carbon parts have UVs made for tiling (about 12 units across a spoiler) and use the shader's
    // 0.5 scale. A composite's carbon (hood, light casing) shares the body's 0..1 paint layout, where
    // that scale would stretch a few texels over the panel, so it is tiled 20x tighter (the value left
    // commented in carbon_fiber.shadert). A viewer choice, not read from the game.
    const weave = textures.carbon(tex0, used === shader ? 0.5 : 10);
    material = new THREE.MeshPhysicalMaterial({ ...common, map: weave, color: weave ? 0xffffff : 0x202020, metalness: 0.25, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.04, envMapIntensity: 0.6 });
  } else if (name === "default_shiny") {
    material = new THREE.MeshStandardMaterial({ ...common, map, color: map ? 0xffffff : 0x9a9a9a, metalness: 0.2, roughness: 0.35, envMapIntensity: 0.45, alphaTest: 0.25 });
  } else if (name === "rubber") {
    material = new THREE.MeshStandardMaterial({ ...common, map, color: map ? 0xffffff : 0x1a1a1a, metalness: 0, roughness: 0.85, envMapIntensity: 0.25 });
  } else if (name === "black_matte" || name === "wheel_inner") {
    material = new THREE.MeshStandardMaterial({ ...common, color: 0x0b0b0b, metalness: 0, roughness: 1, envMapIntensity: 0.1 });
  } else if (name === "drop_shadow") {
    const mask = textures.mask(tex0, [0, 0, 0]);
    material = new THREE.MeshBasicMaterial({ map: mask, color: 0xffffff, transparent: true, opacity: 0.8, depthWrite: false, side: THREE.DoubleSide, visible: Boolean(mask) });
  } else if (name === "car_decal" || name === "car_decal_chrome") {
    // The decal is the manufacturer logo / vinyl the game draws at runtime: nothing to show here.
    material = new THREE.MeshBasicMaterial({ visible: false });
  } else if (name === "licenseplate") {
    material = new THREE.MeshStandardMaterial({ ...common, color: 0xe8e8e0, metalness: 0, roughness: 0.6, envMapIntensity: 0.3 });
  } else {
    // lit_textured and the rest: the texture, lit, cut out where its alpha is low (alpharef 32).
    material = new THREE.MeshStandardMaterial({ ...common, map, color: map ? 0xffffff : 0x8a8a8a, metalness: 0, roughness: 0.75, envMapIntensity: 0.3, alphaTest: 0.25 });
  }
  material.userData.gameLook = true;
  return material;
}

/**
 * The Game look for one viewer: decodes the car's textures once per document (kept while the look is
 * off, so toggling back is instant) and builds one material per shader ID, rebuilt when the options
 * change. `materials` is null while off or loading; the viewer swaps it in for its own material.
 */
export function useGameMaterials({ enabled, document, getRenderer, assetsRoot, options, meshes, textureVersion = 0 }: {
  enabled: boolean; document: PckDocument | null; getRenderer(): THREE.WebGLRenderer | null; assetsRoot: string | null; options: GameLookOptions; meshes: MeshGeometry[];
  /** Changes when the PCK's own textures were edited: they are decoded again, the shared ones are kept. */
  textureVersion?: number;
}) {
  const shaders = useMemo(() => (document ? readCarShaders(document) : null), [document]);
  const [textures, setTextures] = useState<{ document: PckDocument; set: GameTextureSet; missing: string[] } | null>(null);
  const [loading, setLoading] = useState(false);
  // On by default, so the first pass runs before the viewer's own mount effect has made its renderer.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  useEffect(() => {
    if (!mounted || !enabled || !document || !shaders || textures?.document === document) return;
    const renderer = getRenderer(); if (!renderer) return;
    let cancelled = false;
    const names = externalTextureNames(shaders);
    setLoading(true);
    void (assetsRoot ? loadSharedTextures(assetsRoot, names) : Promise.resolve(new Map<string, RgbaImage | null>())).then((external) => {
      if (cancelled) return;
      const set = new GameTextureSet(renderer, document, external);
      setTextures({ document, set, missing: assetsRoot ? names.filter((name) => !external.get(name)) : [] });
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [mounted, enabled, document, shaders, assetsRoot, textures, getRenderer]);
  useEffect(() => () => { textures?.set.dispose(); }, [textures]);
  const maxShader = useMemo(() => Math.max(255, ...meshes.flatMap((mesh) => mesh.groupShaderIds)), [meshes]);
  const [materials, setMaterials] = useState<THREE.Material[] | null>(null);
  const { paint, lights, composite } = options;
  // Runs before the material effect below (declaration order), so the rebuild reads the new bytes.
  const [decodedVersion, setDecodedVersion] = useState(textureVersion);
  useEffect(() => {
    if (textureVersion === decodedVersion) return;
    textures?.set.dropInternal();
    setDecodedVersion(textureVersion);
  }, [textureVersion, decodedVersion, textures]);
  useEffect(() => {
    if (!enabled || !shaders || !textures || textures.document !== document) { setMaterials(null); return; }
    const resolved: GameLookOptions = { paint, lights, composite };
    const fallback = new THREE.MeshStandardMaterial({ color: 0x8a8a8a, roughness: 0.8, side: THREE.DoubleSide });
    const built = Array.from({ length: maxShader + 1 }, (_, id) => (shaders.shaders[id] ? gameMaterial(shaders.shaders[id], textures.set, resolved) : fallback));
    setMaterials(built);
    return () => { for (const material of new Set(built)) material.dispose(); };
  }, [enabled, shaders, textures, document, paint, lights, composite, maxShader, decodedVersion]);
  return { shaders, materials, loading, missing: textures?.document === document ? textures.missing : [] };
}
