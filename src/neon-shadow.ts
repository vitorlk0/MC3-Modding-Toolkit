import { PckDocument, type Vec3 } from "./pck";
import { anchorWorldPosition, isShadowPlane, parseEmbeddedMesh, type MeshGeometry } from "./mesh";
import { packetCullingBounds } from "./obj";

/**
 * Size of a car's colored neon and of its dark ground shadow (modding KB §13).
 *
 * They are two separate things:
 *   - the colored neon is projected from the BodyBounds cage, `BodyBounds_Active.ptr_points_A`:
 *     N Vec3 float32 (9, 11, 14 or 16 in the corpus). Scaling the whole cage in X/Z changed the
 *     neon in game (Gemballa); moving the `neon` anchor or editing neonglow.mesh did not.
 *   - the shadow is an ordinary embedded HLOD piece (neonglow.mesh, shadow_neon.mesh, shadow.mesh…;
 *     exactly one per car in the corpus), a flat sheet at Y = 0.
 *
 * Route to the cage, checked on 674/674 car PCKs (HostFS + VIP, all three families):
 *   file 0x8C            u32 VA of BodyBounds_Active
 *   [file 0x88] + 0xD8   u32 VA of the LODs block; LODs + 0x78 = VA of BodyBounds_AuxMirror
 *   BodyBounds +0x4C     u32 point count A;  +0x68 u32 VA of points A
 * The struct's type ID changes with the PCK family (0x007AE4B0 / 0x007AF7B8 / 0x007AE6B0), so it
 * is not used to recognize it. Active and Aux are separate copies with the same points in every
 * unmodified PCK.
 *
 * Only the points are written. The header's min/max equals the bounds of points A in every
 * unmodified PCK, but the in-game test that changed the neon left the header alone, and what else
 * reads it is unknown, so it is kept as it was. Points B (+0x6C) are not positions and are never
 * touched. The shadow's vertices are rewritten in place (same count, same size) and each packet's
 * culling bounds are recomputed (KB §10.4.1); when a vertex would not fit in s16 at the packet's
 * scale, that packet's scale is doubled until it does — the parser reads the scale per packet.
 *
 * Pure bytes in, bytes out: an edit is always recomputed from the file as it was opened.
 */

export type NeonShadowTransform = { scaleX: number; scaleZ: number; offsetZ: number };
export const IDENTITY_TRANSFORM: NeonShadowTransform = { scaleX: 1, scaleZ: 1, offsetZ: 0 };
export const isIdentity = (t: NeonShadowTransform) => t.scaleX === 1 && t.scaleZ === 1 && t.offsetZ === 0;

export type CageCopy = {
  /** File offset of the BodyBounds header. */
  header: number;
  /** File offset of points A. */
  pointsOffset: number;
  points: Vec3[];
  /** True when the header's min/max equals the bounds of the points, as in every unmodified PCK. */
  headerMatches: boolean;
};

export type NeonShadowSetup = {
  active: CageCopy;
  /** Null when the Aux pointer doesn't resolve to a cage this PCK can hold. */
  aux: CageCopy | null;
  /** Aux holds exactly Active's points (true in every unmodified PCK). */
  auxMatches: boolean;
  shadow: { name: string; geometry: MeshGeometry; offset: Vec3 } | null;
  /** Why the shadow can't be edited, when it can't. */
  shadowError: string | null;
};

export type NeonShadowEdit = { neon: NeonShadowTransform; shadow: NeonShadowTransform; includeAux: boolean };
export type NeonShadowResult = { bytes: Uint8Array; changed: boolean; neonWrites: number; shadowVertices: number; rescaledPackets: number };

const ACTIVE_SLOT = 0x8c;
const MAIN_ROOT_SLOT = 0x88;
const LODS_FROM_ROOT = 0xd8;
const AUX_FROM_LODS = 0x78;
const MAX_POINTS = 64;

const fail = (message: string): never => { throw new Error(message); };
const inside = (offset: number, size: number, total: number) => offset >= 0 && offset + size <= total;

function readCage(bytes: Uint8Array, view: DataView, base: number, pointer: number, label: string): CageCopy {
  const header = (pointer - base) >>> 0;
  if (!inside(header, 0x80, bytes.length)) fail(`The ${label} BodyBounds pointer (0x${pointer.toString(16)}) is outside the file.`);
  const count = view.getUint32(header + 0x4c, true);
  if (count < 1 || count > MAX_POINTS) fail(`The ${label} BodyBounds has ${count} points, outside the known range.`);
  const pointsOffset = (view.getUint32(header + 0x68, true) - base) >>> 0;
  if (!inside(pointsOffset, count * 12, bytes.length)) fail(`The ${label} BodyBounds points are outside the file.`);
  const points: Vec3[] = [];
  for (let i = 0; i < count; i += 1) {
    const point: Vec3 = [0, 1, 2].map((j) => view.getFloat32(pointsOffset + i * 12 + j * 4, true)) as Vec3;
    if (!point.every(Number.isFinite)) fail(`The ${label} BodyBounds point ${i} is not a number.`);
    points.push(point);
  }
  const stored = [0, 1, 2, 3, 4, 5].map((k) => view.getFloat32(header + 0x08 + k * 4, true));
  const actual = [...[0, 1, 2].map((j) => Math.min(...points.map((p) => p[j]))), ...[0, 1, 2].map((j) => Math.max(...points.map((p) => p[j])))];
  const headerMatches = stored.every((value, k) => Math.abs(value - actual[k]) < 1e-4);
  return { header, pointsOffset, points, headerMatches };
}

/** The shadow sheet: the single embedded HLOD piece named like one. */
function findShadow(document: PckDocument) {
  const entries = document.lodMeshes.filter((entry) => entry.lod === "hlod" && isShadowPlane(entry.name) && entry.meshBlockOffset !== null);
  if (!entries.length) return { shadow: null, shadowError: "No embedded shadow piece (neonglow / shadow) in this PCK." };
  if (entries.length > 1) return { shadow: null, shadowError: `More than one shadow piece (${entries.map((entry) => entry.name).join(", ")}).` };
  try {
    const geometry = parseEmbeddedMesh(entries[0], document);
    if (geometry.packets.some((packet) => !Number.isFinite(packet.scale) || packet.scale <= 0)) throw new Error("a packet has no valid scale");
    const offset = geometry.anchorIndex === null ? [0, 0, 0] as Vec3 : anchorWorldPosition(document, geometry.anchorIndex, "a2");
    return { shadow: { name: entries[0].name, geometry, offset }, shadowError: null };
  } catch (caught) {
    return { shadow: null, shadowError: `${entries[0].name} can't be read: ${caught instanceof Error ? caught.message : "unknown layout"}` };
  }
}

/** Reads the neon cage and shadow of one car PCK. Throws, with the reason, when the cage can't be found. */
export function readNeonShadow(name: string, bytes: Uint8Array): NeonShadowSetup {
  const document = new PckDocument(name, bytes.slice().buffer as ArrayBuffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const base = document.pointerBase;
  const root = (view.getUint32(MAIN_ROOT_SLOT, true) - base) >>> 0;
  if (!inside(root, LODS_FROM_ROOT + 4, bytes.length)) fail("The main root of this PCK is outside the file.");
  const lods = (view.getUint32(root + LODS_FROM_ROOT, true) - base) >>> 0;
  if (!inside(lods, AUX_FROM_LODS + 4, bytes.length)) fail("The LODs block of this PCK is outside the file.");
  const active = readCage(bytes, view, base, view.getUint32(ACTIVE_SLOT, true), "Active");
  let aux: CageCopy | null = null;
  try { aux = readCage(bytes, view, base, view.getUint32(lods + AUX_FROM_LODS, true), "Aux"); } catch { aux = null; }
  // A shared points block would be written twice; treat it as no separate Aux.
  if (aux && aux.pointsOffset === active.pointsOffset) aux = null;
  const auxMatches = Boolean(aux && aux.points.length === active.points.length && aux.points.every((p, i) => p.every((v, j) => v === active.points[i][j])));
  return { active, aux, auxMatches, ...findShadow(document) };
}

const extent = (values: number[]) => [Math.min(...values), Math.max(...values)] as const;
const center = (values: number[]) => { const [low, high] = extent(values); return (low + high) / 2; };

/** X/Z pivot the cage is scaled around: the middle of its own bounds. */
export function cagePivot(points: Vec3[]): [number, number] { return [center(points.map((p) => p[0])), center(points.map((p) => p[2]))]; }

/** X/Z pivot of the shadow, in the piece's own coordinates. */
export function shadowPivot(geometry: MeshGeometry): [number, number] {
  const xs: number[] = [], zs: number[] = [];
  for (let i = 0; i < geometry.positions.length; i += 3) { xs.push(geometry.positions[i]); zs.push(geometry.positions[i + 2]); }
  return [center(xs), center(zs)];
}

export function transformXZ(x: number, z: number, pivot: [number, number], t: NeonShadowTransform): [number, number] {
  return [pivot[0] + (x - pivot[0]) * t.scaleX, pivot[1] + (z - pivot[1]) * t.scaleZ + t.offsetZ];
}

function validate(t: NeonShadowTransform, label: string) {
  if (!(t.scaleX > 0) || !(t.scaleZ > 0) || !Number.isFinite(t.scaleX) || !Number.isFinite(t.scaleZ) || !Number.isFinite(t.offsetZ)) fail(`The ${label} values are not valid numbers.`);
  if (t.scaleX > 4 || t.scaleZ > 4 || t.scaleX < 0.1 || t.scaleZ < 0.1) fail(`The ${label} scale must stay between 10% and 400%.`);
}

/** Banker's rounding, the way the converter quantizes (src/obj.ts). */
const roundHalfToEven = (value: number) => {
  const floor = Math.floor(value), diff = value - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
};

/**
 * Applies the neon and shadow transforms to one car PCK and returns the new bytes. Always works from
 * the bytes given, so the file as opened plus the current values is the whole edit.
 */
export function applyNeonShadow(name: string, source: Uint8Array, edit: NeonShadowEdit): NeonShadowResult {
  const setup = readNeonShadow(name, source);
  const out = source.slice();
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  let neonWrites = 0, shadowVertices = 0, rescaledPackets = 0;

  if (!isIdentity(edit.neon)) {
    validate(edit.neon, "neon");
    // One pivot for both copies, so Active and Aux stay identical when they started identical.
    const pivot = cagePivot(setup.active.points);
    const copies = [setup.active, ...(edit.includeAux && setup.aux ? [setup.aux] : [])];
    for (const copy of copies) {
      copy.points.forEach((point, i) => {
        const [x, z] = transformXZ(point[0], point[2], pivot, edit.neon);
        view.setFloat32(copy.pointsOffset + i * 12, x, true);
        view.setFloat32(copy.pointsOffset + i * 12 + 8, z, true);
        neonWrites += 1;
      });
    }
  }

  if (!isIdentity(edit.shadow)) {
    validate(edit.shadow, "shadow");
    if (!setup.shadow) fail(setup.shadowError ?? "This PCK has no shadow piece.");
    const { geometry } = setup.shadow!;
    const pivot = shadowPivot(geometry);
    for (const packet of geometry.packets) {
      const targets: [number, number, number][] = [];
      for (let i = 0; i < packet.count; i += 1) {
        const o = packet.vertexOffset + i * 6;
        const [x, z] = transformXZ(view.getInt16(o, true) * packet.scale, view.getInt16(o + 4, true) * packet.scale, pivot, edit.shadow);
        targets.push([x, view.getInt16(o + 2, true) * packet.scale, z]);
      }
      // The coarsest grid needed for every vertex to fit in s16; Y is re-quantized only if the grid changes.
      let scale = packet.scale;
      const fits = (s: number) => targets.every((v) => v.every((n) => Math.abs(roundHalfToEven(n / s)) <= 32767));
      while (!fits(scale)) { scale *= 2; if (scale > 1) fail(`${setup.shadow!.name} would be too big to store.`); }
      if (scale !== packet.scale) { view.setFloat32(packet.offset + 4, scale, true); rescaledPackets += 1; }
      targets.forEach((v, i) => {
        const o = packet.vertexOffset + i * 6;
        view.setInt16(o, roundHalfToEven(v[0] / scale), true);
        if (scale !== packet.scale) view.setInt16(o + 2, roundHalfToEven(v[1] / scale), true);
        view.setInt16(o + 4, roundHalfToEven(v[2] / scale), true);
      });
      const [centerY, centerZ, radius] = packetCullingBounds(out.subarray(packet.vertexOffset, packet.vertexOffset + packet.count * 6), scale);
      view.setFloat32(packet.offset + 0x08, centerY, true);
      view.setFloat32(packet.offset + 0x0c, centerZ, true);
      view.setFloat32(packet.offset + 0x10, radius, true);
      shadowVertices += packet.count;
    }
  }

  let changed = out.length !== source.length;
  for (let i = 0; !changed && i < out.length; i += 1) if (out[i] !== source[i]) changed = true;
  return { bytes: out, changed, neonWrites, shadowVertices, rescaledPackets };
}
