/**
 * Garage shop cameras: `ASSETS/tune/garage/<car>.mcgarage`.
 *
 * Plain text, one camera per shop category as a pair of points: `Look<Name>` is where the camera
 * looks and `<Name>Camera` is where it stands (both "x<TAB>y<TAB>z " after the key, "%f" style).
 * The same 21 pairs, in the same order, LF line endings, in all 219 files of the Remix and VIP
 * HostFS trees (checked 2026-10-12). The field of view is not here: it is one global value,
 * `CameraFOV` in `garage.garageshared`, next to the per-car files.
 *
 * Axes: the file is the car PCK's space turned 180° about Y — X and Z both negated, Y unchanged.
 * Evidence: in the file +Z is the front (LookFrontBumper Z ≈ +2.1, LookRearBumper Z ≈ -2.4) while
 * the PCK has +Z at the rear; and the G500's one-sided side exhaust sits at PCK X -0.71, Z +0.86
 * while its LookExhaust / LookSideExhaust are at X +0.71, Z -0.79.
 *
 * Writing only rewrites the numbers of a pair that changed; every other byte (indentation, tabs,
 * the trailing space, untouched numbers) stays as it was read, so an unedited file saves identical.
 */
import type { Vec3 } from "./pck";

export const SHOP_CAMERAS = [
  "FrontBumper", "SidePanel", "RearBumper", "Spoiler", "Hood", "Tires", "FrontWindow", "RearWindow",
  "DoorDecals", "Vinyl", "LicensePlate", "RearPanel", "FrontWheels", "AllWheels", "Exhaust",
  "WheelieBar", "MiddlePanel", "TailLights", "SideExhaust", "SideBadges", "RearBadges",
] as const;
export type ShopCameraId = typeof SHOP_CAMERAS[number];
export type ShopCamera = { camera: Vec3; target: Vec3 };

export const lookKey = (id: ShopCameraId) => `Look${id}`;
export const cameraKey = (id: ShopCameraId) => `${id}Camera`;
/** "RearBumper" → "Rear Bumper". */
export const shopCameraLabel = (id: ShopCameraId) => id.replace(/([a-z])([A-Z])/g, "$1 $2");

/** File space ↔ the car PCK space the viewer draws in (a 180° turn about Y is its own inverse). */
export const garageToPck = (value: Vec3): Vec3 => [-value[0], value[1], -value[2]];
export const pckToGarage = garageToPck;

/**
 * A camera as an orbit around its target, in the file's axes: distance, yaw (0° = camera on the
 * car's front side, +Z; 180° = behind) and pitch (positive = above the target, looking down).
 * Moving one of them leaves the target where it is — "local" editing for a camera that always
 * looks at its target.
 */
export type CameraOrbit = { distance: number; yaw: number; pitch: number };
const DEG = Math.PI / 180;
export function cameraOrbit({ camera, target }: ShopCamera): CameraOrbit {
  const dx = camera[0] - target[0]; const dy = camera[1] - target[1]; const dz = camera[2] - target[2];
  const distance = Math.hypot(dx, dy, dz);
  return { distance, yaw: Math.atan2(dx, dz) / DEG, pitch: distance > 0 ? Math.asin(Math.max(-1, Math.min(1, dy / distance))) / DEG : 0 };
}
export function orbitPosition(target: Vec3, orbit: CameraOrbit): Vec3 {
  // Straight up or down has no yaw left to keep, and a zero distance no direction.
  const distance = Math.max(orbit.distance, 0.05);
  const pitch = Math.max(-89.9, Math.min(89.9, orbit.pitch)) * DEG; const yaw = orbit.yaw * DEG;
  const horizontal = distance * Math.cos(pitch);
  return [target[0] + horizontal * Math.sin(yaw), target[1] + distance * Math.sin(pitch), target[2] + horizontal * Math.cos(yaw)];
}

/** Default when garage.garageshared is missing or unreadable: the value every shipped copy has. */
export const DEFAULT_GARAGE_FOV = 40;

type NumberSpan = { start: number; end: number; text: string };
type Field = { line: number; numbers: NumberSpan[] };
type Edit = { key: string; before: Vec3; after: Vec3 };

const NUMBER = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;
/** "%f": six decimals. Rounded first so a value read back equals the one written. */
export const formatGarageNumber = (value: number) => (Math.round(value * 1e6) / 1e6).toFixed(6);
const roundVec = (value: Vec3) => value.map((component) => Math.round(component * 1e6) / 1e6) as Vec3;
const sameVec = (a: Vec3, b: Vec3) => a.every((value, index) => Object.is(value, b[index]));

/** Bytes ↔ text without any encoding guesswork: these files are ASCII, and latin1 round-trips any byte. */
export function decodeLatin1(bytes: Uint8Array) { let out = ""; for (const byte of bytes) out += String.fromCharCode(byte); return out; }
export function encodeLatin1(text: string) { const out = new Uint8Array(text.length); for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i) & 0xff; return out; }

/** Reads `CameraFOV` out of garage.garageshared; null when the line isn't there. */
export function parseGarageSharedFov(text: string): number | null {
  const match = /^\s*CameraFOV\s+([-+]?\d*\.?\d+)/m.exec(text);
  const value = match ? Number(match[1]) : NaN;
  return Number.isFinite(value) && value > 1 && value < 179 ? value : null;
}

export class McGarageDocument {
  readonly path: string;
  readonly name: string;
  /** Lines without their "\n"; a "\r" (none in the shipped files) would stay part of the line. */
  private readonly lines: string[];
  private readonly fields = new Map<string, Field>();
  private readonly values = new Map<string, Vec3>();
  private saved = new Map<string, Vec3>();
  readonly cameras: ShopCameraId[];
  undoStack: Edit[][] = [];
  redoStack: Edit[][] = [];

  constructor(path: string, name: string, text: string) {
    this.path = path; this.name = name;
    this.lines = text.split("\n");
    if (!/^\s*mcGarage\s*\{/m.test(text)) throw new Error(`${name} is not a garage camera file (no "mcGarage {" block).`);
    const wanted = new Set(SHOP_CAMERAS.flatMap((id) => [lookKey(id), cameraKey(id)]));
    this.lines.forEach((line, lineIndex) => {
      const head = /^(\s*)([A-Za-z_][A-Za-z0-9_]*)(?=\s)/.exec(line);
      if (!head || !wanted.has(head[2])) return;
      const numbers: NumberSpan[] = [];
      NUMBER.lastIndex = head[0].length;
      for (let match = NUMBER.exec(line); match; match = NUMBER.exec(line)) numbers.push({ start: match.index, end: match.index + match[0].length, text: match[0] });
      if (numbers.length !== 3) throw new Error(`${name}: ${head[2]} on line ${lineIndex + 1} has ${numbers.length} numbers instead of 3.`);
      if (this.fields.has(head[2])) throw new Error(`${name}: ${head[2]} appears twice.`);
      this.fields.set(head[2], { line: lineIndex, numbers });
      this.values.set(head[2], numbers.map((item) => Number(item.text)) as Vec3);
    });
    this.cameras = SHOP_CAMERAS.filter((id) => this.fields.has(lookKey(id)) && this.fields.has(cameraKey(id)));
    if (!this.cameras.length) throw new Error(`${name} has no complete Look…/…Camera pair.`);
    this.saved = new Map([...this.values].map(([key, value]) => [key, [...value] as Vec3]));
  }

  /** Both points of one shop camera, in the file's own space. */
  get(id: ShopCameraId): ShopCamera {
    return { camera: [...this.values.get(cameraKey(id))!] as Vec3, target: [...this.values.get(lookKey(id))!] as Vec3 };
  }
  getSaved(id: ShopCameraId): ShopCamera {
    return { camera: [...this.saved.get(cameraKey(id))!] as Vec3, target: [...this.saved.get(lookKey(id))!] as Vec3 };
  }

  /** Writes either or both points of a camera. Recorded writes form one undo step. */
  set(id: ShopCameraId, next: Partial<ShopCamera>, record = true): boolean {
    return this.setMany([[id, next]], record) > 0;
  }
  /** Several cameras as one undo step; returns how many cameras changed. */
  setMany(entries: [ShopCameraId, Partial<ShopCamera>][], record = true): number {
    const edits: Edit[] = [];
    let changedCameras = 0;
    for (const [id, next] of entries) {
      let changed = false;
      for (const [key, value] of [[cameraKey(id), next.camera], [lookKey(id), next.target]] as const) {
        if (!value) continue;
        const before = this.values.get(key); if (!before) continue;
        const after = roundVec(value);
        if (sameVec(before, after)) continue;
        edits.push({ key, before: [...before] as Vec3, after });
        this.values.set(key, after);
        changed = true;
      }
      if (changed) changedCameras += 1;
    }
    if (edits.length && record) { this.undoStack.push(edits); if (this.undoStack.length > 100) this.undoStack.shift(); this.redoStack = []; }
    return changedCameras;
  }

  private replay(from: Edit[][], to: Edit[][], side: "before" | "after"): ShopCameraId | null {
    const step = from.pop(); if (!step) return null;
    for (const edit of step) this.values.set(edit.key, [...edit[side]] as Vec3);
    to.push(step);
    return SHOP_CAMERAS.find((id) => step.some((edit) => edit.key === lookKey(id) || edit.key === cameraKey(id))) ?? null;
  }
  undo() { return this.replay(this.undoStack, this.redoStack, "before"); }
  redo() { return this.replay(this.redoStack, this.undoStack, "after"); }

  isCameraDirty(id: ShopCameraId) {
    return [cameraKey(id), lookKey(id)].some((key) => !sameVec(this.values.get(key)!, this.saved.get(key)!));
  }
  get dirtyCameras() { return this.cameras.filter((id) => this.isCameraDirty(id)); }
  get dirty() { return this.dirtyCameras.length > 0; }

  /** The file text with the current values; unchanged numbers keep their exact original text. */
  text() {
    const lines = [...this.lines];
    for (const [key, field] of this.fields) {
      const value = this.values.get(key)!; const saved = this.saved.get(key)!;
      if (sameVec(value, saved)) continue;
      let line = lines[field.line];
      // Right to left, so earlier spans keep their offsets.
      for (let component = 2; component >= 0; component -= 1) {
        const span = field.numbers[component];
        line = line.slice(0, span.start) + formatGarageNumber(value[component]) + line.slice(span.end);
      }
      lines[field.line] = line;
    }
    return lines.join("\n");
  }
  bytes() { return encodeLatin1(this.text()); }

  /** After a verified write: the written text becomes the new baseline, spans included. */
  markSaved() {
    const text = this.text();
    const fresh = new McGarageDocument(this.path, this.name, text);
    this.lines.splice(0, this.lines.length, ...text.split("\n"));
    this.fields.clear(); for (const [key, field] of fresh.fields) this.fields.set(key, field);
    this.saved = new Map([...this.values].map(([key, value]) => [key, [...value] as Vec3]));
  }
}
