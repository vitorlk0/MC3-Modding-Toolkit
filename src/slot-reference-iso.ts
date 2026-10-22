import { runFlashArrays, scalarText, type AvmScalar } from "./avm1-run";
import { decodeCarcfg } from "./carcfg";
import { entriesByName, readDave, readEntry } from "./dave";
import type { IsoSession } from "./iso-install";
import { memoryReader } from "./iso9660";
import { PckDocument } from "./pck";
import { PAINT_ARRAYS, SLOT_REFERENCE, type PaintArrays, type SlotCatalog, type SlotReference } from "./slot-reference";

/**
 * Reads what Slot Retarget needs from a compiled MC3 ISO, so a mod can be moved onto a slot of the
 * very image it is installed into. Read-only. Used two ways:
 *   - scripts/extract-slot-reference.ts runs it once on the ORIGINAL disc to build the embedded
 *     reference (src/slot-reference-data.ts) that Tools 11 uses;
 *   - ISO Install runs it on the opened ISO (`readIsoCatalog`), whose catalogues may differ from the
 *     original's — a modded rim.ppf, a slot that already holds a mod.
 * The global catalogues are read up front; a slot's own data (its DAT, .carcfg and menus) only when
 * that slot is chosen, since reading every vehicle DAT of the disc takes a while.
 */

const latin1 = (bytes: Uint8Array) => { let out = ""; for (const byte of bytes) out += String.fromCharCode(byte); return out; };
const withoutComments = (text: string) => text.split(/\r?\n/).filter((line) => !/^\s*;/.test(line)).join("\n");

/** The Vehicle blocks of vehicle.lst, in order: the position is the car's index in the game. */
export function vehicleList(text: string) {
  const out: { name: string; className: string }[] = [];
  for (const match of withoutComments(text).matchAll(/\bVehicle\s*\{([\s\S]*?)\n\}/g)) {
    const name = /\bName\s+(\S+)/.exec(match[1])?.[1];
    const className = /\bClass\s+(\S+)/.exec(match[1])?.[1];
    if (!name || !className) throw new Error(`A Vehicle block without Name/Class: ${match[1].slice(0, 80)}`);
    out.push({ name: name.toLowerCase(), className });
  }
  return out;
}

/** Uncommented lines of one `name { ... }` section of customwheels/customexhausts.txt. */
function section(text: string, name: string) {
  const match = new RegExp(`\\b${name}\\s*\\{([^}]*)\\}`).exec(text);
  if (!match) throw new Error(`Section ${name} not found.`);
  return match[1].split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith(";"));
}

/** Entries of rim.ppf that carry a wheel mesh name (rim KB §6.3); the format-B texture entries don't. */
function namedRimEntries(bytes: Uint8Array) {
  if (latin1(bytes.subarray(0, 4)) !== "pf05") throw new Error("rim.ppf is not a pf05 container.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(4, true);
  let named = 0;
  for (let i = 0; i < count; i++) {
    const block = view.getUint16(12 + i * 4, true), used = view.getUint16(14 + i * 4, true);
    if (/whld?_rm_[A-Za-z0-9_]+/.test(latin1(bytes.subarray(block * 0x800, block * 0x800 + used * 0x80)))) named++;
  }
  return named;
}

/** Key list of a .strtbl (modding KB §20.4). */
function strtblKeys(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 4 + 4 * view.getUint32(0, true);
  const keyCount = view.getUint32(pos + 4, true);
  pos += 8;
  const keys: string[] = [];
  for (let i = 0; i < keyCount; i++) {
    const length = view.getUint32(pos, true);
    keys.push(latin1(bytes.subarray(pos + 4, pos + 4 + length)));
    pos += 4 + length + 1;
  }
  return keys;
}

const carcfgInt = (text: string, key: string) => { const m = new RegExp(`^\\s*${key}\\s+(-?\\d+)`, "m").exec(text); return m ? Number(m[1]) : null; };

/** A file of ASSETS.DAT by its path, or null when the ISO doesn't have it. */
export async function assetFile(session: IsoSession, path: string) {
  const entry = session.byName.get(path.toLowerCase())?.[0];
  return entry ? readEntry(session.archive, entry) : null;
}
async function requiredAsset(session: IsoSession, path: string) {
  const bytes = await assetFile(session, path);
  if (!bytes) throw new Error(`${path} is not in this ISO's ASSETS.DAT.`);
  return bytes;
}

/** The global catalogues a mod's menus are checked against. */
export async function readIsoCatalogues(session: IsoSession) {
  const rims = section(latin1(await requiredAsset(session, "tune/vehicle/customdata/customwheels.txt")), "rims");
  const exhausts = section(latin1(await requiredAsset(session, "tune/vehicle/customdata/customexhausts.txt")), "exhausts");
  const namedRims = namedRimEntries(await requiredAsset(session, "resources/vehicle/rim.ppf"));
  if (namedRims !== rims.length) throw new Error(`rim.ppf has ${namedRims} named entries but customwheels.txt lists ${rims.length} rims.`);
  const stringKeys = [...new Set(strtblKeys(await requiredAsset(session, "fonts/mcstrings08.strtbl")))].sort();
  const vehicles = vehicleList(latin1(await requiredAsset(session, "tune/vehicle/vehicle.lst")));
  return { rims, namedRims, exhausts, stringKeys, vehicles };
}

/** One slot's own data: wheel count from its player PCK, save identity and stock values from its
 *  .carcfg, stock rim / exhaust, plates and paint arrays from its menus. `plates` and `paint` are
 *  always the slot's own here (null when it has no ds_ / ps_). */
export async function readIsoSlot(session: IsoSession, name: string, index: number, className: string) {
  const datBytes = await requiredAsset(session, `${name}.dat`);
  const dat = await readDave(memoryReader(datBytes), `${name}.dat`);
  const pckEntry = entriesByName(dat).get(`resources/vehicle/${name}/${name}.pck`)?.[0];
  if (!pckEntry) throw new Error(`${name}.dat has no ${name}.pck.`);
  const pckBytes = await readEntry(dat, pckEntry);
  const wheels = new PckDocument(`${name}.pck`, pckBytes.buffer.slice(pckBytes.byteOffset, pckBytes.byteOffset + pckBytes.byteLength) as ArrayBuffer).wheelSlots.length;

  const carcfg = decodeCarcfg(await requiredAsset(session, `tune/vehicle/customdata/${name}.carcfg`)).text;
  const profile = Array.from({ length: 13 }, (_, i) => carcfgInt(carcfg, `ProfileName${i + 1}`) ?? 0);

  const flashFile = async (prefix: string) => { const bytes = await assetFile(session, `flash/${prefix}_${name}.pck`); return bytes ? runFlashArrays(bytes, `${prefix}_${name}.pck`) : null; };
  const [vs, ds, ps] = [await flashFile("vs"), await flashFile("ds"), await flashFile("ps")];
  const ms = session.byName.has(`flash/ms_${name}.pck`);
  const stock = (base: string) => {
    const token = vs?.get(`${base}Names`)?.[0], brand = vs?.get(`${base}Brand`)?.[0];
    return token && brand ? { token: scalarText(token), brand: scalarText(brand) } : null;
  };
  const paint: PaintArrays | null = ps && PAINT_ARRAYS.every((key) => ps.has(key))
    ? Object.fromEntries(PAINT_ARRAYS.map((key) => [key, ps.get(key) as AvmScalar[]])) : null;
  return {
    name, index, className, wheels, profile,
    rimMdlIdx: carcfgInt(carcfg, "RimMdlIdx"), exhaustRear: carcfgInt(carcfg, "ExhaustRear"),
    stockRim: stock("Rims"), stockExhaust: stock("BodyUpgradeExhaustTips"),
    plates: ds?.get("LicencePlatesStyleNames")?.map(scalarText) ?? null,
    paint,
    flash: { ds: !!ds, ms, ps: !!ps, vs: !!vs },
  };
}

/** Slot Retarget's view of the opened ISO: its catalogues and slots. A slot without ds_ / ps_ falls
 *  back to the original game's default plates and paint arrays. */
export async function readIsoCatalog(session: IsoSession): Promise<SlotCatalog> {
  const { rims, namedRims, exhausts, stringKeys, vehicles } = await readIsoCatalogues(session);
  const listing = vehicles.map(({ name, className }, index) => ({ name, index, className, menus: session.byName.has(`flash/vs_${name}.pck`) }));
  const loaded = new Map<string, Promise<SlotReference | null>>();
  return {
    where: "this ISO",
    rims, namedRims, exhausts, stringKeys,
    plates: SLOT_REFERENCE.plates, paint: SLOT_REFERENCE.paint,
    listing,
    slot(name) {
      const key = name.toLowerCase();
      const known = listing.find((item) => item.name === key);
      if (!known) return Promise.resolve(null);
      let pending = loaded.get(key);
      if (!pending) {
        pending = readIsoSlot(session, known.name, known.index, known.className).then(({ plates, paint, ...slot }) => ({ ...slot, ...(plates ? { plates } : {}), ...(paint ? { paint } : {}) }));
        // A failed read is not kept, so choosing the slot again retries it.
        pending.catch(() => loaded.delete(key));
        loaded.set(key, pending);
      }
      return pending;
    },
  };
}
