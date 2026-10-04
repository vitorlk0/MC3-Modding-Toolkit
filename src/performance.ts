/**
 * Vehicle performance — the VehSim / VehGyro / VehZone structures of a car PCK, as edited by the
 * community Performance Editor v1.1 (`PerformanceEditor.py`, @ZNXee171 & @mc3rxx). Field layout and
 * pointer walk are transcribed from that script and cross-checked against the modding KB (§8).
 *
 * Findings this module relies on, checked across the 276 car PCKs in the HostFS tree:
 * - A car's Player, Opponent and Garage PCKs carry identical performance values; only the blocks'
 *   addresses differ. So every PCK is resolved through its own pointers and written separately.
 * - Base and Mods never share a sub-block, so editing one mode can't leak into the other.
 * - The TBC sub-pointer (VehSim+0x7C) is a 0xCDCDCDxx sentinel in every file; the TBC fields are
 *   read inline from VehSim+0xBC, as the script does.
 * - 26 `vp_d_*` cars have no VehZone: the root at +0x44 points at another, unidentified structure
 *   (magic 0x007A2F80 or 0x007A1E78). VehZone is then reported unavailable, never written.
 *
 * PSP `.psppck` files use an inline layout for the first eight sub-blocks and shifted VehSim
 * offsets. That layout is read (a PSP car can be an import donor) exactly as the script reads it.
 */

export type PerfMode = "base" | "mods";
export type PerfFieldType = "f32" | "u32" | "s8";

export type PerfField = {
  key: string;
  label: string;
  type: PerfFieldType;
  /** Offset from the section's start. */
  offset: number;
  /** Offset in the PSP inline layout, where it differs from `offset` beyond the section shift. */
  pspOffset?: number;
  /** Named values for an enumerated field. */
  options?: { value: number; label: string }[];
};

type Anchor =
  | { kind: "vehsim"; start: number; pspStart: number }
  | { kind: "sub"; index: number; start: number; pspInline?: number }
  | { kind: "gyro" }
  | { kind: "zone" };

export type PerfSection = {
  id: string;
  label: string;
  group: string;
  /** "global" sections exist once per vehicle and are the same in Base and Mods. */
  scope: "mode" | "global";
  anchor: Anchor;
  fields: PerfField[];
  note?: string;
};

const f32Run = (prefix: string, start: number, labels: string[]): PerfField[] =>
  labels.map((label, i) => ({ key: `${prefix}.${label.replace(/[^A-Za-z0-9]/g, "")}`, label, type: "f32", offset: start + i * 4 }));

/** "rear"/"front" is which axle does the burnout on an AWD car. */
const drivetrainOptions = [
  { value: 0, label: "RWD" },
  { value: 1, label: "FWD" },
  { value: 2, label: "AWD rear" },
  { value: 3, label: "AWD front" },
];

const wheelLabels = ["Unknown 1", "Unknown 2", "Tire Disp Limit Lat", "Tire Disp Limit Long", "Tire Damp Coef Lat", "Tire Damp Coef Long", "Surface Drag Coef Lat", "Surface Drag Coef Long", "Steering Limit", "Camber Limit", "Wobble Limit", "Axle Limit", "Brake Coef", "Handbrake Coef", "Steering Offset", "Travel Limit", "Travel Extent", "Suspension Offset", "Suspension Limit", "Suspension Extent", "Suspension Clamp", "Suspension Factor", "Suspension Damp Coef", "Suspension Damp Factor", "Optimum Slip Percent", "Static Fric", "Sliding Fric"];

export const perfSections: PerfSection[] = [
  {
    id: "vehsim", label: "VehSim", group: "Chassis", scope: "mode", anchor: { kind: "vehsim", start: 0, pspStart: 0 },
    note: "Physics and collision parameters — Size and Model Offset are not the visual scale of the car.",
    fields: [
      { key: "vehsim.ModelOffsetX", label: "Model Offset X", type: "f32", offset: 0x0c, pspOffset: 0x10 },
      { key: "vehsim.ModelOffsetY", label: "Model Offset Y", type: "f32", offset: 0x10, pspOffset: 0x14 },
      { key: "vehsim.ModelOffsetZ", label: "Model Offset Z", type: "f32", offset: 0x14, pspOffset: 0x18 },
      { key: "vehsim.CenterOfMassX", label: "Center Of Mass X", type: "f32", offset: 0x18, pspOffset: 0x20 },
      { key: "vehsim.CenterOfMassY", label: "Center Of Mass Y", type: "f32", offset: 0x1c, pspOffset: 0x24 },
      { key: "vehsim.CenterOfMassZ", label: "Center Of Mass Z", type: "f32", offset: 0x20, pspOffset: 0x28 },
      { key: "vehsim.Mass", label: "Mass", type: "f32", offset: 0x24, pspOffset: 0x30 },
      { key: "vehsim.SizeX", label: "Size X", type: "f32", offset: 0x28, pspOffset: 0x40 },
      { key: "vehsim.SizeY", label: "Size Y", type: "f32", offset: 0x2c, pspOffset: 0x44 },
      { key: "vehsim.SizeZ", label: "Size Z", type: "f32", offset: 0x30, pspOffset: 0x48 },
      { key: "vehsim.InertiaBoxX", label: "Inertia Box X", type: "f32", offset: 0x34, pspOffset: 0x50 },
      { key: "vehsim.InertiaBoxY", label: "Inertia Box Y", type: "f32", offset: 0x38, pspOffset: 0x54 },
      { key: "vehsim.InertiaBoxZ", label: "Inertia Box Z", type: "f32", offset: 0x3c, pspOffset: 0x58 },
      { key: "vehsim.BoundFriction", label: "Bound Friction", type: "f32", offset: 0x40, pspOffset: 0x60 },
      { key: "vehsim.BoundElasticity", label: "Bound Elasticity", type: "f32", offset: 0x44, pspOffset: 0x64 },
      { key: "vehsim.BoundGravity", label: "Bound Gravity", type: "f32", offset: 0x48, pspOffset: 0x68 },
      { key: "vehsim.AirGravity", label: "Air Gravity", type: "f32", offset: 0x4c, pspOffset: 0x6c },
      { key: "vehsim.DriveTrainType", label: "Drive Train Type", type: "s8", offset: 0x50, pspOffset: 0x70, options: drivetrainOptions },
    ],
  },
  {
    id: "burnout", label: "Burnout", group: "Chassis", scope: "mode", anchor: { kind: "vehsim", start: 0xa0, pspStart: 0xb4 },
    fields: f32Run("burnout", 0, ["Threshold Speed", "Rev Threshold Speed", "Boost Speed", "Increase Speed", "Decrease Speed", "Damage Amount", "Weight Transfer"]),
  },
  {
    id: "tbc", label: "TBC", group: "Chassis", scope: "mode", anchor: { kind: "vehsim", start: 0xbc, pspStart: 0xd0 },
    note: "Read inline from VehSim: the TBC pointer is a sentinel in every shipped PCK. Names are the community editor's.",
    fields: f32Run("tbc", 0, ["Drift CG", "Backfire Frequency", "Car Friction Handling Wipeout", "Aero Damp Factor", "Landing Damp Factor", "Friction Handling Standard", "Landing Elasticity", "Bound Clearance", "Unknown"]),
  },
  { id: "wheelFront", label: "Wheel Front", group: "Wheels", scope: "mode", anchor: { kind: "sub", index: 0, start: 0x04, pspInline: 0x100 }, fields: f32Run("wheelFront", 0, wheelLabels) },
  { id: "wheelBack", label: "Wheel Back", group: "Wheels", scope: "mode", anchor: { kind: "sub", index: 1, start: 0x04, pspInline: 0x170 }, fields: f32Run("wheelBack", 0, wheelLabels) },
  {
    id: "engine", label: "Engine", group: "Powertrain", scope: "mode", anchor: { kind: "sub", index: 2, start: 0, pspInline: 0x1e0 },
    fields: f32Run("engine", 0, ["Ang Inertia", "Max Horse Power", "Idle RPM", "Opt RPM", "Max RPM", "Engage RPM", "GCL", "Gear Change Throttle", "Boost Duration", "Boost HP"]),
  },
  {
    id: "transmission", label: "Transmission", group: "Powertrain", scope: "mode", anchor: { kind: "sub", index: 3, start: 0, pspInline: 0x210 },
    fields: [
      { key: "transmission.ManualNumGears", label: "Manual Num Gears", type: "u32", offset: 0x00 },
      ...f32Run("transmission", 0x04, ["Reverse", "Low", "High", "Up Shift Bias", "Down Shift Bias Min", "Down Shift Bias Max"]),
      { key: "transmission.MaxDownShift", label: "Max Down Shift", type: "u32", offset: 0x1c },
      ...f32Run("transmission", 0x20, ["Gear Bias", "Gear Change Time"]),
    ],
  },
  { id: "drivetrain", label: "Drivetrain", group: "Powertrain", scope: "mode", anchor: { kind: "sub", index: 4, start: 0, pspInline: 0x238 }, fields: f32Run("drivetrain", 0, ["Ang Inertia", "Brake Dynamic Coef", "Brake Static Coef"]) },
  { id: "freetrain", label: "Free Train", group: "Powertrain", scope: "mode", anchor: { kind: "sub", index: 5, start: 0, pspInline: 0x244 }, fields: f32Run("freetrain", 0, ["Ang Inertia", "Brake Dynamic Coef", "Brake Static Coef"]) },
  { id: "axleFront", label: "Axle Front", group: "Powertrain", scope: "mode", anchor: { kind: "sub", index: 6, start: 0, pspInline: 0x250 }, fields: f32Run("axleFront", 0, ["Torque Coef", "Damp Coef"]) },
  { id: "axleBack", label: "Axle Back", group: "Powertrain", scope: "mode", anchor: { kind: "sub", index: 7, start: 0, pspInline: 0x258 }, fields: f32Run("axleBack", 0, ["Torque Coef", "Damp Coef"]) },
  {
    id: "aero", label: "Aero", group: "Dynamics", scope: "mode", anchor: { kind: "sub", index: 8, start: 0x04 },
    fields: [
      ...f32Run("aero", 0, ["Ang C Damp X", "Ang C Damp Y", "Ang C Damp Z", "Ang Vel Damp X", "Ang Vel Damp Y", "Ang Vel Damp Z", "Ang Vel2 Damp X", "Ang Vel2 Damp Y", "Ang Vel2 Damp Z", "Unknown 1", "Down"]),
      ...f32Run("aero", 0x34, ["Drag Slip Stream", "Drag", "Unknown 2"]),
    ],
  },
  {
    id: "fluid", label: "Fluid", group: "Dynamics", scope: "mode", anchor: { kind: "sub", index: 9, start: 0 },
    fields: [...f32Run("fluid", 0, ["Damp", "Unknown", "Current"]), ...f32Run("fluid", 0x10, ["Buoyancy", "Min Buoyancy", "Sink Rate"])],
  },
  {
    id: "hydraulics", label: "Hydraulics", group: "Dynamics", scope: "mode", anchor: { kind: "sub", index: 14, start: 0 },
    fields: f32Run("hydraulics", 0, ["Release Time", "Front Rise", "Back Rise", "Front Drop", "Back Drop", "Rate Rise", "Rate Drop", "Suspension Extent", "Suspension Damp", "Mass Offset", "Unknown"]),
  },
  {
    id: "nitro", label: "Nitro", group: "Boost", scope: "mode", anchor: { kind: "sub", index: 11, start: 0 },
    fields: [
      { key: "nitro.NitrosMax", label: "Nitros Max", type: "s8", offset: 0x00 },
      ...f32Run("nitro", 0x04, ["Nitro Boost Exp", "Nitro Boost Amount", "Nitro Boost Time", "Nitro FOV", "FOV Out Time", "FOV In Time", "Flame Time", "Flame Size"]),
    ],
  },
  {
    id: "ssturbo", label: "SS Turbo", group: "Boost", scope: "mode", anchor: { kind: "sub", index: 12, start: 0 },
    fields: [
      ...f32Run("ssturbo", 0, ["Turbo Boost Exp", "Turbo Boost Amount", "Turbo Use Time", "Turbo Regen Time", "Turbo Falloff Time", "Charged Falloff Time", "Stay Full Time", "Lose Charge Speed", "Lose Charge Speed 2", "Unknown", "FOV Out Time", "FOV In Time", "Turbo FOV", "Turbo Dist", "Blur Off Time", "Blur Start Amount", "Envelope D1", "Envelope D2", "Envelope D3", "Flame Time", "Flame Size", "Smoke Size"]),
      ...f32Run("ssturbo", 0x60, ["Smoke Start R", "Smoke Start G", "Smoke Start B", "Smoke Start A", "Smoke End R", "Smoke End G", "Smoke End B", "Smoke End A"]),
    ],
  },
  {
    id: "vehgyro", label: "VehGyro", group: "Handling", scope: "mode", anchor: { kind: "gyro" },
    fields: f32Run("vehgyro", 0x0c, ["Turn", "Drift", "Spin 180", "Reverse", "Yaw", "Pitch", "Roll Torque", "Lean", "Wheelie", "Turn Factor", "Unknown", "Turn Limit", "Turn Damp", "Turn Bias", "Lean Factor", "Lean Angle", "Lean Angle Max", "Lean Rate", "Lean Limit", "Lean Damp", "Impulse Up", "Lean Impulse Dn", "Lean Speed Min", "Lean Steer Limit", "Lean COG", "Noise Angle", "Wheelie Angle", "Wheelie Rate", "Wheelie Limit", "Wheelie Damp", "Roll Limit", "Roll Damp", "Drift Thrust", "Drift Decay", "Wheelie Boost Acc", "Wheelie Boost Duration", "Wobble Amplitude", "Wobble Frequency", "Burnout Rate", "Burnout Limit", "Burnout Turn", "Burnout Turn Rev", "Burnout Lean", "Burnout Grip", "Reverse Acc", "Reverse Limit"]),
  },
  {
    id: "aiinfo", label: "AI Info", group: "Handling", scope: "mode", anchor: { kind: "sub", index: 15, start: 0x04 },
    fields: f32Run("aiinfo", 0, ["Turn Const", "HB Early Time", "HB Steer Multiplier", "Max Brake Decel", "Steer Scalar", "Steer Gamma", "Car Friction Handling", "Friction Multiplier", "Sliding Friction Factor"]),
  },
  {
    id: "vehzone", label: "VehZone", group: "Global", scope: "global", anchor: { kind: "zone" },
    note: "Consumed while the Zone special ability is active — it has to travel with a performance transplant. One copy per vehicle, shared by Base and Mods. The 18 fields are not identified yet.",
    fields: Array.from({ length: 18 }, (_, i) => ({ key: `vehzone.${(0x0c + i * 4).toString(16)}`, label: `Unknown +0x${(0x0c + i * 4).toString(16).toUpperCase().padStart(2, "0")}`, type: "f32" as const, offset: 0x0c + i * 4 })),
  },
];

export const perfGroups = [...new Set(perfSections.map((section) => section.group))];
export const sectionById = new Map(perfSections.map((section) => [section.id, section]));

const VEHZONE_MAGIC = 0x007a1c78;
const fieldSize: Record<PerfFieldType, number> = { f32: 4, u32: 4, s8: 1 };
const MODE_SLOTS: Record<PerfMode, { vehsim: number; gyro: number }> = { base: { vehsim: 0xb4, gyro: 0xbc }, mods: { vehsim: 0xb8, gyro: 0xc0 } };
const ZONE_SLOT = 0xc4;

/** Where one field sits in one file, or why it can't be reached there. */
export type FieldLocation = { offset: number; size: number } | null;

/**
 * The performance structures of one PCK's bytes. Pointers only — values are read on demand, so a
 * layout built from a document's bytes stays valid as fields are edited (no field edit moves a
 * block, and compaction only ever moves the tool-appended mesh blocks at the end of the file).
 */
export class PerformanceLayout {
  readonly inline: boolean;
  readonly zoneOffset: number | null;
  private readonly view: DataView;
  private readonly pointerBase: number;
  private readonly vehsim: Record<PerfMode, number>;
  private readonly gyro: Record<PerfMode, number | null>;
  private readonly subs: Record<PerfMode, (number | null)[]>;

  constructor(readonly name: string, readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.byteLength < 0x100) throw new Error(`${name} is too small to be a car PCK.`);
    // The script's base rule: a PS2 PCK's root pointer starts with a 0x00 byte and its data begins
    // at +0x80; anything else is taken as-is.
    const root = this.u32(0);
    this.pointerBase = bytes[0] === 0 ? (root - 0x80) >>> 0 : root;

    const vehsim = { base: this.resolve(this.u32(MODE_SLOTS.base.vehsim)), mods: this.resolve(this.u32(MODE_SLOTS.mods.vehsim)) };
    if (vehsim.base === null || vehsim.mods === null) throw new Error(`${name} has no valid VehSim pointer, so its performance can't be read.`);
    this.vehsim = { base: vehsim.base, mods: vehsim.mods };
    this.gyro = { base: this.resolve(this.u32(MODE_SLOTS.base.gyro)), mods: this.resolve(this.u32(MODE_SLOTS.mods.gyro)) };
    const readSubs = (mode: PerfMode) => Array.from({ length: 16 }, (_, i) => this.inside(this.vehsim[mode] + 0x54 + i * 4, 4) ? this.resolve(this.u32(this.vehsim[mode] + 0x54 + i * 4)) : null);
    this.subs = { base: readSubs("base"), mods: readSubs("mods") };
    // The script falls back to the PSP inline layout whenever any of the first eight sub-pointers
    // is unusable — which is also how a .psppck presents.
    this.inline = /\.psppck$/i.test(name) || (["base", "mods"] as PerfMode[]).some((mode) => this.subs[mode].slice(0, 8).some((offset) => offset === null));
    const zone = this.resolve(this.u32(ZONE_SLOT));
    this.zoneOffset = zone !== null && this.inside(zone, 0x54) && this.u32(zone) === VEHZONE_MAGIC ? zone : null;
  }

  private u32(offset: number) { return this.view.getUint32(offset, true); }
  private inside(offset: number, size: number) { return offset >= 0 && offset + size <= this.bytes.byteLength; }
  private resolve(pointer: number) {
    if (!pointer || (pointer & 0xffffff00) === 0xcdcdcd00 || pointer === 0xcdcdcdcd) return null;
    const offset = (pointer - this.pointerBase) >>> 0;
    return this.inside(offset, 4) ? offset : null;
  }

  sectionAvailable(section: PerfSection, mode: PerfMode) {
    return section.fields.every((field) => this.locate(section, field, mode) !== null);
  }

  locate(section: PerfSection, field: PerfField, mode: PerfMode): FieldLocation {
    const anchor = section.anchor;
    let offset: number | null;
    if (anchor.kind === "vehsim") offset = this.vehsim[mode] + (this.inline ? anchor.pspStart + (field.pspOffset ?? field.offset) : anchor.start + field.offset);
    else if (anchor.kind === "gyro") { const base = this.gyro[mode]; offset = base === null ? null : base + field.offset; }
    else if (anchor.kind === "zone") offset = this.zoneOffset === null ? null : this.zoneOffset + field.offset;
    else if (this.inline && anchor.pspInline !== undefined) offset = this.vehsim[mode] + anchor.pspInline + anchor.start + field.offset;
    else { const base = this.subs[mode][anchor.index]; offset = base === null ? null : base + anchor.start + field.offset; }
    const size = fieldSize[field.type];
    return offset !== null && this.inside(offset, size) ? { offset, size } : null;
  }

  read(section: PerfSection, field: PerfField, mode: PerfMode, from: Uint8Array = this.bytes): number | null {
    const location = this.locate(section, field, mode);
    if (!location || location.offset + location.size > from.byteLength) return null;
    return decodeField(field.type, from, location.offset);
  }
}

export function decodeField(type: PerfFieldType, bytes: Uint8Array, offset: number) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return type === "f32" ? view.getFloat32(offset, true) : type === "u32" ? view.getUint32(offset, true) : view.getInt8(offset);
}

export function encodeField(type: PerfFieldType, value: number) {
  const bytes = new Uint8Array(fieldSize[type]);
  const view = new DataView(bytes.buffer);
  if (type === "f32") view.setFloat32(0, value, true);
  else if (type === "u32") view.setUint32(0, value >>> 0, true);
  else view.setInt8(0, value);
  return bytes;
}

/** Bit-level equality once stored: 0.1 typed twice is one float32, and NaN equals NaN. */
export function sameStored(type: PerfFieldType, a: number | null, b: number | null) {
  if (a === null || b === null) return a === b;
  const x = encodeField(type, a); const y = encodeField(type, b);
  return x.every((byte, i) => byte === y[i]);
}

/** Validates a typed value against its field's storage type; returns an error message or null. */
export function checkFieldValue(field: PerfField, value: number): string | null {
  if (!Number.isFinite(value)) return "Enter a finite number.";
  if (field.type === "u32" && (!Number.isInteger(value) || value < 0 || value > 0xffffffff)) return "Must be a whole number of zero or more.";
  if (field.type === "s8" && (!Number.isInteger(value) || value < -128 || value > 127)) return "Must be a whole number between -128 and 127.";
  if (field.type === "f32" && Math.abs(value) > 3.4028234663852886e38) return "Too large for a float32.";
  return null;
}

/** The shortest decimal that reads back as the same float32 — what the file actually holds. */
export function formatFieldValue(type: PerfFieldType, value: number | null) {
  if (value === null) return "—";
  if (type !== "f32") return String(value);
  if (!Number.isFinite(value)) return String(value);
  for (let precision = 1; precision <= 9; precision += 1) {
    const candidate = Number(value.toPrecision(precision));
    if (Math.fround(candidate) === value) return String(candidate);
  }
  return String(value);
}
