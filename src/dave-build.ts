import { DAVE_CHARS } from "./dave";

/**
 * Builds a "Dave" archive (packed names) — a byte-for-byte port of EdnessP's dave.py v1.5.3
 * `build_dave` with `-cn` and its defaults (0x800 alignment, no file compression, no directory
 * entries), the settings every car mod DAT so far was built with and that run in game.
 *
 * Compared with a vehicle DAT straight off the disc, the header, entry table and name table come out
 * identical; only the physical order of the payloads differs (Rockstar's packer used its own order,
 * dave.py follows the sorted names), which the game doesn't care about — it looks entries up by name.
 *
 * Quirks kept on purpose so the output matches dave.py exactly:
 *   - `calcAlign` always advances to the NEXT multiple, even from an aligned value, so a table or a
 *     file ending exactly on a 0x800 boundary is followed by a whole empty block;
 *   - names are lower-cased, sorted by their index in DAVE_CHARS, and share a prefix with the
 *     previous name (at most 32 in a row) to save space.
 * The only intended difference is the tag in the header padding (dave.py writes its own name).
 */

export type DaveSource = { name: string; bytes: Uint8Array };

const ALIGN = 0x800;
const calcAlign = (size: number, align = ALIGN) => (Math.floor(size / align) + 1) * align;
const SIGNATURE = "MC3 Modding Toolkit - Dave builder (dave.py v1.5.3 layout)";

const charIndex = (c: string, name: string) => {
  const index = DAVE_CHARS.indexOf(c);
  if (index < 0) throw new Error(`"${name}" has a character DAVE names can't store: "${c}". Allowed: a-z 0-9 _ - . / space # $ ( ) ? ~`);
  return index;
};

function compareKeys(a: number[], b: number[]) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

/** Packs a name (with its shared-prefix header) the way dave.py does: 6 bits per char, little-endian. */
function packName(name: string, fullName: string, dedup: [number, number] | null) {
  let value = 0n;
  for (const c of [...name].reverse()) value = (value << 6n) | BigInt(charIndex(c, fullName));
  let bits = name.length + 1;
  if (dedup) {
    value = (value << 12n) | BigInt(((dedup[0] + 0x20) << 6) | (dedup[1] + 0x38));
    bits += 2;
  }
  const size = Math.ceil(bits * 0.75);
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) { out[i] = Number(value & 0xffn); value >>= 8n; }
  return out;
}

export function buildDave(sources: DaveSource[]): Uint8Array {
  const files = sources.map((source) => {
    const name = source.name.replace(/\\/g, "/").toLowerCase();
    if (name.length >= 256) throw new Error(`"${source.name}" is too long for a DAVE name (255 characters at most).`);
    return { name, bytes: source.bytes, key: [...name].map((c) => charIndex(c, source.name)) };
  });
  files.sort((a, b) => compareKeys(a.key, b.key));
  for (let i = 1; i < files.length; i++) if (files[i].name === files[i - 1].name) throw new Error(`"${files[i].name}" appears twice.`);

  // Name block, with dave.py's prefix sharing.
  const packed: Uint8Array[] = [];
  let dedupIndex = 0;
  let previous = "";
  for (const file of files) {
    let name = file.name;
    let dedup: [number, number] | null = null;
    if (dedupIndex) {
      let shared = 0;
      while (shared < Math.min(previous.length, name.length) && previous[shared] === name[shared]) shared++;
      if (shared) { dedup = [Math.floor(shared / 8), shared % 8]; name = name.slice(shared); }
      else dedupIndex = 0;
    }
    packed.push(packName(name, file.name, dedup));
    previous = file.name;
    dedupIndex = (dedupIndex + 1) & 0x1f;
  }
  const namesLength = packed.reduce((sum, bytes) => sum + bytes.length, 0);
  const tableSize = calcAlign(files.length * 0x10);
  const namesSize = calcAlign(namesLength);

  // Payload layout: every file on the next 0x800 boundary after the previous one ends.
  const offsets: number[] = [];
  let cursor = 0x800 + tableSize + namesSize;
  for (const file of files) { offsets.push(cursor); cursor = calcAlign(cursor + file.bytes.length); }
  if (cursor > 0xffffffff) throw new Error("The archive would be larger than 4 GB.");

  const out = new Uint8Array(cursor);
  const view = new DataView(out.buffer);
  out.set([0x44, 0x61, 0x76, 0x65]); // "Dave"
  view.setUint32(4, files.length, true);
  view.setUint32(8, tableSize, true);
  view.setUint32(12, namesSize, true);
  const tag = new TextEncoder().encode(SIGNATURE);
  out.set(tag, 0x800 - tag.length);

  // Packed names are stored last-to-first; each entry points at its own name.
  const nameOffsets = new Array<number>(files.length);
  let running = 0;
  for (let i = files.length - 1; i >= 0; i--) { nameOffsets[i] = running; running += packed[i].length; }
  let namePos = 0x800 + tableSize;
  for (let i = files.length - 1; i >= 0; i--) { out.set(packed[i], namePos); namePos += packed[i].length; }

  files.forEach((file, i) => {
    const record = 0x800 + i * 0x10;
    view.setUint32(record, nameOffsets[i], true);
    view.setUint32(record + 4, offsets[i], true);
    view.setUint32(record + 8, file.bytes.length, true);
    view.setUint32(record + 12, file.bytes.length, true);
    out.set(file.bytes, offsets[i]);
  });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Finding a vehicle folder

export type VehicleFileRef = { path: string; read: () => Promise<Uint8Array> };
export type VehicleFolder<T extends VehicleFileRef = VehicleFileRef> = {
  car: string;
  /** The folder holding `<car>.pck`, relative to what was scanned ("" = the scanned folder itself). */
  folder: string;
  /** Files that go into the DAT: every .pck in the folder except the garage `_g.pck`. */
  included: T[];
  /** Files in or under the folder that stay out, with the reason. */
  excluded: { path: string; reason: string }[];
};

const dirOf = (path: string) => path.replace(/\\/g, "/").replace(/\/?[^/]*$/, "");
const nameOf = (path: string) => path.replace(/^.*[\\/]/, "");

/**
 * Finds the car folders among a scanned file list: a folder counts when it holds `vp_x.pck`.
 */
export function findVehicleFolders<T extends VehicleFileRef>(files: T[]): VehicleFolder<T>[] {
  const byFolder = new Map<string, T[]>();
  for (const file of files) {
    const folder = dirOf(file.path);
    const list = byFolder.get(folder);
    if (list) list.push(file); else byFolder.set(folder, [file]);
  }
  const found: VehicleFolder<T>[] = [];
  for (const [folder, list] of byFolder) {
    const names = new Set(list.map((file) => nameOf(file.path).toLowerCase()));
    // Car IDs end in their year digits (vp_350z_04), so a _o / _g suffix is always the opponent or
    // garage PCK, never a car of its own — even in a folder without the player PCK.
    const cars = [...names].map((name) => /^(vp_[a-z0-9_]+)\.pck$/.exec(name)?.[1]).filter((car): car is string => !!car && !/_(o|g)$/.test(car));
    for (const car of cars) {
      const included: T[] = [];
      const excluded: { path: string; reason: string }[] = [];
      for (const file of list) {
        const name = nameOf(file.path).toLowerCase();
        if (name === `${car}_g.pck`) excluded.push({ path: file.path, reason: "garage PCK — lives in ASSETS, not in the DAT" });
        else if (!name.endsWith(".pck")) excluded.push({ path: file.path, reason: "not a .pck" });
        else included.push(file);
      }
      const prefix = folder ? `${folder}/` : "";
      for (const file of files) {
        if (file.path.replace(/\\/g, "/").startsWith(prefix) && dirOf(file.path) !== folder) excluded.push({ path: file.path, reason: "in a subfolder" });
      }
      found.push({ car, folder, included, excluded });
    }
  }
  return found;
}

/** Validates a vehicle folder and builds its DAT with names under `resources/vehicle/<car>/`. */
export async function buildVehicleDat(vehicle: VehicleFolder): Promise<Uint8Array> {
  const names = new Set(vehicle.included.map((file) => nameOf(file.path).toLowerCase()));
  for (const required of [`${vehicle.car}.pck`, `${vehicle.car}_o.pck`]) {
    if (!names.has(required)) throw new Error(`${required} is missing from ${vehicle.folder || "the folder"} — every car DAT holds the player and the opponent PCK.`);
  }
  const sources = await Promise.all(vehicle.included.map(async (file) => ({ name: `resources/vehicle/${vehicle.car}/${nameOf(file.path)}`, bytes: await file.read() })));
  return buildDave(sources);
}
