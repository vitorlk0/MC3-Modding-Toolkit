/**
 * Builds src/slot-reference-data.ts — what Slot Retarget knows about the original game — from the
 * ORIGINAL MC3 DUB Edition Remix disc image. Read-only: the image is opened for reading and nothing
 * else is touched. Use the untouched disc, not a HostFS tree or a modded ISO, whose slots may already
 * carry someone's mod.
 *
 *   npx tsx scripts/extract-slot-reference.ts "<original>.iso" "<VIP ASSETS>/tune/vehicle/vehicle.lst"
 *
 * The VIP vehicle.lst only contributes the class of the slots the VIP added (so a mod made for one
 * of them can be checked against the target's class); nothing else is taken from the VIP.
 */
import { open, readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { openIsoSession } from "../src/iso-install";
import { readDave, readEntry, entriesByName } from "../src/dave";
import { memoryReader } from "../src/iso9660";
import { PckDocument } from "../src/pck";
import { runFlashArrays, scalarText, type AvmScalar } from "../src/avm1-run";
import { decodeCarcfg } from "../src/carcfg";
import type { PaintArrays, SlotReference, SlotReferenceData } from "../src/slot-reference";

const [isoPath, vipListPath] = process.argv.slice(2);
if (!isoPath || !vipListPath) throw new Error("usage: extract-slot-reference.ts <original.iso> <VIP vehicle.lst>");

const latin1 = (bytes: Uint8Array) => { let out = ""; for (const byte of bytes) out += String.fromCharCode(byte); return out; };
const withoutComments = (text: string) => text.split(/\r?\n/).filter((line) => !/^\s*;/.test(line)).join("\n");

function vehicles(text: string) {
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

const handle = await open(isoPath, "r");
const size = (await handle.stat()).size;
const session = await openIsoSession({ size, async read(offset: number, length: number) { const out = new Uint8Array(length); await handle.read(out, 0, length, offset); return out; } });
const asset = async (path: string) => {
  const entry = session.byName.get(path.toLowerCase())?.[0];
  return entry ? readEntry(session.archive, entry) : null;
};
const required = async (path: string) => { const bytes = await asset(path); if (!bytes) throw new Error(`${path} is not in ASSETS.DAT.`); return bytes; };

const rims = section(latin1(await required("tune/vehicle/customdata/customwheels.txt")), "rims");
const exhausts = section(latin1(await required("tune/vehicle/customdata/customexhausts.txt")), "exhausts");
const namedRims = namedRimEntries(await required("resources/vehicle/rim.ppf"));
if (namedRims !== rims.length) throw new Error(`rim.ppf has ${namedRims} named entries but customwheels.txt lists ${rims.length} rims.`);
const stringKeys = [...new Set(strtblKeys(await required("fonts/mcstrings08.strtbl")))].sort();

const mostCommon = <T>(values: T[]) => {
  const counts = new Map<string, { value: T; n: number }>();
  for (const value of values) { const key = JSON.stringify(value); const item = counts.get(key); if (item) item.n++; else counts.set(key, { value, n: 1 }); }
  return [...counts.values()].sort((a, b) => b.n - a.n)[0]?.value;
};

const vanilla = vehicles(latin1(await required("tune/vehicle/vehicle.lst")));
type Raw = Omit<SlotReference, "plates" | "paint"> & { plates: string[] | null; paint: PaintArrays | null };
const raw: Raw[] = [];
for (const [index, { name, className }] of vanilla.entries()) {
  const datBytes = await required(`${name}.dat`);
  const dat = await readDave(memoryReader(datBytes), `${name}.dat`);
  const pckEntry = entriesByName(dat).get(`resources/vehicle/${name}/${name}.pck`)?.[0];
  if (!pckEntry) throw new Error(`${name}.dat has no ${name}.pck.`);
  const pckBytes = await readEntry(dat, pckEntry);
  const wheels = new PckDocument(`${name}.pck`, pckBytes.buffer.slice(pckBytes.byteOffset, pckBytes.byteOffset + pckBytes.byteLength) as ArrayBuffer).wheelSlots.length;

  const carcfgBytes = await required(`tune/vehicle/customdata/${name}.carcfg`);
  const carcfg = decodeCarcfg(carcfgBytes).text;
  const profile = Array.from({ length: 13 }, (_, i) => carcfgInt(carcfg, `ProfileName${i + 1}`) ?? 0);

  const flashFile = async (prefix: string) => { const bytes = await asset(`flash/${prefix}_${name}.pck`); return bytes ? runFlashArrays(bytes, `${prefix}_${name}.pck`) : null; };
  const [vs, ds, ps, msBytes] = [await flashFile("vs"), await flashFile("ds"), await flashFile("ps"), await asset(`flash/ms_${name}.pck`)];
  const stock = (base: string) => {
    const token = vs?.get(`${base}Names`)?.[0], brand = vs?.get(`${base}Brand`)?.[0];
    return token && brand ? { token: scalarText(token), brand: scalarText(brand) } : null;
  };
  const paint: PaintArrays | null = ps && ["UpgradeTypesNames", "UpgradeTypesStatus", "UpgradeTypesPrice", "ColorUpgradeOrder"].every((key) => ps.has(key))
    ? Object.fromEntries(["UpgradeTypesNames", "UpgradeTypesStatus", "UpgradeTypesPrice", "ColorUpgradeOrder"].map((key) => [key, ps.get(key) as AvmScalar[]])) : null;
  raw.push({
    name, index, className, wheels, profile,
    rimMdlIdx: carcfgInt(carcfg, "RimMdlIdx"), exhaustRear: carcfgInt(carcfg, "ExhaustRear"),
    stockRim: stock("Rims"), stockExhaust: stock("BodyUpgradeExhaustTips"),
    plates: ds?.get("LicencePlatesStyleNames")?.map(scalarText) ?? null,
    paint,
    flash: { ds: !!ds, ms: !!msBytes, ps: !!ps, vs: !!vs },
  });
  process.stdout.write(`\r${index + 1}/${vanilla.length} ${name}            `);
}
await handle.close();
process.stdout.write("\n");

const plates = mostCommon(raw.map((slot) => slot.plates).filter((value): value is string[] => !!value))!;
const paint = mostCommon(raw.map((slot) => slot.paint).filter((value): value is PaintArrays => !!value))!;
const slots: SlotReference[] = raw.map(({ plates: own, paint: ownPaint, ...slot }) => ({
  ...slot,
  ...(own && JSON.stringify(own) !== JSON.stringify(plates) ? { plates: own } : {}),
  ...(ownPaint && JSON.stringify(ownPaint) !== JSON.stringify(paint) ? { paint: ownPaint } : {}),
}));

const vanillaNames = new Set(vanilla.map((slot) => slot.name));
const vipClasses = Object.fromEntries(vehicles(latin1(await readFile(vipListPath))).filter((slot) => !vanillaNames.has(slot.name)).map((slot) => [slot.name, slot.className]));

const data: SlotReferenceData = { source: basename(isoPath), rims, namedRims, exhausts, plates, paint, stringKeys, slots, vipClasses };
const body = `import type { SlotReferenceData } from "./slot-reference";

// Generated by scripts/extract-slot-reference.ts from ${basename(isoPath)} — do not edit by hand.
export const SLOT_REFERENCE_DATA: SlotReferenceData = ${JSON.stringify(data, null, 1)};
`;
await writeFile(new URL("../src/slot-reference-data.ts", import.meta.url), body);
console.log(`slots ${slots.length}, rims ${rims.length} (named entries ${namedRims}), exhausts ${exhausts.length}, plates ${plates.length}, paint ${paint.UpgradeTypesNames.length}, keys ${stringKeys.length}, VIP-only classes ${Object.keys(vipClasses).length}`);
console.log(`slots with own plates: ${slots.filter((slot) => slot.plates).map((slot) => slot.name).join(", ") || "none"}`);
console.log(`slots with own paint: ${slots.filter((slot) => slot.paint).map((slot) => slot.name).join(", ") || "none"}`);
console.log(`slots without menus: ${slots.filter((slot) => !slot.stockRim).map((slot) => slot.name).join(", ") || "none"}`);
console.log(`bikes: ${slots.filter((slot) => slot.wheels !== 4).map((slot) => `${slot.name}=${slot.wheels}`).join(", ")}`);
