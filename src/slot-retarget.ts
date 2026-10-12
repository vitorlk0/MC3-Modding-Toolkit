import { runFlashArrays, type AvmScalar, type FlashArrays } from "./avm1-run";
import { rewriteFlashArrays } from "./avm1-append";
import { decodeCarcfg, encodeCarcfg } from "./carcfg";
import { buildDave } from "./dave-build";
import { entriesByName, readDave, readEntry } from "./dave";
import { memoryReader } from "./iso9660";
import { detectPackage, type PackageFile } from "./iso-install";
import { PckDocument } from "./pck";
import {
  PAINT_ARRAYS, SLOT_REFERENCE, elfMentions, knownClass, referenceSlot, slotPaint, slotPlates, type SlotReference,
} from "./slot-reference";

/**
 * Slot Retarget — moves a car mod made for one slot onto another slot of the original game, as a
 * new package for ISO Install. The target slot is replaced entirely: the mod's PCKs carry the car,
 * its physics and its audio; only the slot's save identity (the .carcfg ProfileName) is kept.
 *
 * What the game finds by slot name (HANDOFF-SLOT-RETARGET.md §2–3), and so is renamed S → T:
 *   vp_S.dat (and the entry names inside it), vp_S_g.pck, the loose vehicle folder and its 3 PCKs,
 *   ds_/ms_/ps_/vs_/reward_vp_S.pck, vp_S.carcfg + vp_S_1..10.carcfg, the 6 cameras, vp_S.mcgarage,
 *   vp_S.damage, the vp_S folder holding default.mccarcustom.
 * The loose vroot_* parts keep their names: the PCK's LOD table names them, not the slot.
 *
 * Converted for the original MC3 (the VIP adds catalogue items the original doesn't have):
 *   vs_  rims / exhaust tips missing from customwheels/customexhausts leave the menu; a missing
 *        stock item becomes the target's stock;
 *   ds_  licence plates the target's own menu doesn't have leave;
 *   ps_  paint categories the target's menu doesn't have → the target's paint arrays;
 *   .carcfg  TypeName = T, ProfileName = T's, RimMdlIdx / ExhaustRear outside the original
 *        catalogues (or pointing at a replaced stock item) → T's stock.
 * Flash edits use the VIP's append technique (src/avm1-append.ts), byte-identical to the test that
 * was approved in game. Global files (vehicle.lst, .strtbl, toplevel/garage.pck) are never touched,
 * so the slot keeps its name, logo, price and class.
 */

export type RetargetLevel = "ok" | "info" | "fix" | "warn" | "block";
export type RetargetNote = { level: RetargetLevel; text: string };
export type RetargetChange = "renamed" | "converted" | "unchanged";
export type RetargetFile = { path: string; sourcePath: string; bytes: Uint8Array; change: RetargetChange };
export type RetargetSource = { car: string; className: string | null; files: PackageFile[]; notes: string[] };
export type RetargetResult = { source: string; target: string; files: RetargetFile[]; notes: RetargetNote[]; blocked: boolean };

const FLASH_PREFIXES = ["ds", "ms", "ps", "vs", "reward"] as const;
const OPPONENT_CARCFGS = 10;
const baseName = (path: string) => path.replace(/^.*[\\/]/, "");
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const list = (items: string[], max = 12) => items.length > max ? `${items.slice(0, max).join(", ")} … (+${items.length - max})` : items.join(", ");

/** Slots a mod can be moved onto: every original slot that has its own menus. */
export function retargetSlots(): SlotReference[] {
  return SLOT_REFERENCE.slots.filter((slot) => slot.flash.vs && slot.stockRim);
}

/** Reads the package's car the way ISO Install does, so a package it would refuse is refused here. */
export async function readRetargetSource(label: string, files: PackageFile[]): Promise<RetargetSource> {
  const pkg = await detectPackage(label, files);
  return { car: pkg.car, className: knownClass(pkg.car), files, notes: pkg.notes };
}

/** The name a package path gets when slot `from` becomes `to`; unchanged for files that aren't the slot's. */
export function retargetPath(path: string, from: string, to: string) {
  const parts = path.replace(/\\/g, "/").split("/");
  const own = new RegExp(`^${escape(from)}(\\.dat|\\.pck|_g\\.pck|_o\\.pck|\\.carcfg|_\\d+\\.carcfg|\\.mcgarage|\\.damage|_chase[1-4]\\.camtrackcs|_pov\\.campovcs|_reverse\\.camtrackcs)$`);
  const flash = new RegExp(`^(ds|ms|ps|vs|reward)_${escape(from)}\\.pck$`);
  return parts.map((part, index) => {
    const lower = part.toLowerCase();
    if (lower === from) return to;
    if (index < parts.length - 1) return part;
    const ownMatch = own.exec(lower);
    if (ownMatch) return `${to}${ownMatch[1]}`;
    const flashMatch = flash.exec(lower);
    if (flashMatch) return `${flashMatch[1]}_${to}.pck`;
    return part;
  }).join("/");
}

/** The family of a car PCK by the magic at PTR_LODs (modding KB §4.5). */
function pckFamily(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 0x1ac) return null;
  const lods = view.getUint32(0x1a8, true) - view.getUint32(0, true) + 0x80;
  if (lods < 0 || lods + 4 > bytes.length) return null;
  const magic = view.getUint32(lods, true);
  return { magic, name: magic === 0x007a9420 ? "standard" : magic === 0x007aa728 ? "DUB" : magic === 0x007a9620 ? "SL" : "unknown" };
}

type Notes = { add: (level: RetargetLevel, text: string) => void };

// ---------------------------------------------------------------------------------------------
// Menus

type FlashPlan = { arrays: [string, AvmScalar[]][]; stockRimReplaced: boolean; stockExhaustReplaced: boolean };
const strings = (items: AvmScalar[] | undefined) => (items ?? []).map((item) => item.kind === "string" ? item.value : null);

type Stock = { token: string; brand: string; why: string };

/** The item a missing stock rim / exhaust tip becomes. Rims: the target's stock rim. Exhaust tips:
 *  the target's stock tip — or, for the 42 original slots whose menu has no exhaust tips, the tip its
 *  .carcfg already fits (ExhaustRear), labelled with the car's make like every stock menu item. */
function stockFor(slot: SlotReference, kind: "rim" | "exhaust"): Stock | null {
  if (kind === "rim") return slot.stockRim && { ...slot.stockRim, why: `${slot.name}'s stock rim` };
  if (slot.stockExhaust) return { ...slot.stockExhaust, why: `${slot.name}'s stock exhaust tip` };
  const token = slot.exhaustRear !== null ? SLOT_REFERENCE.exhausts[slot.exhaustRear] : undefined;
  return token && slot.stockRim ? { token, brand: slot.stockRim.brand, why: `the exhaust tip ${slot.name}'s .carcfg fits (ExhaustRear ${slot.exhaustRear}), since ${slot.name}'s own menu has no exhaust tips` } : null;
}

/** Cuts a catalogue-backed category (Rims, BodyUpgradeExhaustTips) down to the original game's. */
function convertCatalogue(file: string, arrays: FlashArrays, base: string, label: string, valid: Set<string>, stock: Stock | null, target: string, notes: Notes, plan: FlashPlan) {
  const names = arrays.get(`${base}Names`);
  if (!names) return false;
  const parallel = ["Names", "Brand", "Price", "Status"].map((suffix) => `${base}${suffix}`).filter((key) => arrays.has(key));
  if (parallel.some((key) => arrays.get(key)!.length !== names.length)) {
    notes.add("block", `${file}: the ${base} arrays don't have the same number of items.`);
    return false;
  }
  const tokens = strings(names);
  const columns = new Map(parallel.map((key) => [key, [...arrays.get(key)!]]));
  let keep = tokens.flatMap((token, index) => token !== null && valid.has(token) ? [index] : []);
  let replaced = false;
  if (tokens.length && (tokens[0] === null || !valid.has(tokens[0]))) {
    if (!stock) { notes.add("block", `${file}: the stock ${label} ${tokens[0] ?? "(empty)"} doesn't exist in the original game, and ${target} has no stock ${label} to take its place.`); return false; }
    notes.add("fix", `${file}: the stock ${label} ${tokens[0] ?? "(empty)"} doesn't exist in the original game; it becomes ${stock.token}, ${stock.why}.`);
    columns.get(`${base}Names`)![0] = { kind: "string", value: stock.token };
    if (columns.has(`${base}Brand`)) columns.get(`${base}Brand`)![0] = { kind: "string", value: stock.brand };
    // The new stock item may already be on the menu further down; one entry per item.
    const repeated = keep.filter((index) => index !== 0 && tokens[index] === stock.token);
    if (repeated.length) notes.add("fix", `${file}: ${stock.token} was also further down the ${label} menu; that copy leaves, the stock item stays.`);
    keep = [0, ...keep.filter((index) => index !== 0 && !repeated.includes(index))];
    replaced = true;
  }
  const dropped = tokens.filter((token, index) => !keep.includes(index) && !(replaced && index > 0 && token === stock?.token)).map((token) => token ?? "(empty)");
  if (dropped.length || keep.length !== tokens.length) {
    if (dropped.length) notes.add("fix", `${file}: ${dropped.length} ${label} items that don't exist in the original game leave the menu: ${list(dropped)}.`);
    for (const key of parallel) plan.arrays.push([key, keep.map((index) => columns.get(key)![index])]);
  } else if (replaced) {
    for (const key of parallel) plan.arrays.push([key, columns.get(key)!]);
  } else {
    notes.add("ok", `${file}: ${names.length} ${label} items, all in the original game.`);
  }
  return replaced;
}

function planFlash(prefix: string, file: string, arrays: FlashArrays, slot: SlotReference, notes: Notes): FlashPlan {
  const plan: FlashPlan = { arrays: [], stockRimReplaced: false, stockExhaustReplaced: false };
  if (prefix === "vs") {
    plan.stockRimReplaced = convertCatalogue(file, arrays, "Rims", "rim", new Set(SLOT_REFERENCE.rims), stockFor(slot, "rim"), slot.name, notes, plan);
    plan.stockExhaustReplaced = convertCatalogue(file, arrays, "BodyUpgradeExhaustTips", "exhaust tip", new Set(SLOT_REFERENCE.exhausts), stockFor(slot, "exhaust"), slot.name, notes, plan);
  } else if (prefix === "ds") {
    const base = "LicencePlatesStyle";
    const names = arrays.get(`${base}Names`);
    if (names) {
      const parallel = ["Names", "Price", "Status"].map((suffix) => `${base}${suffix}`).filter((key) => arrays.has(key));
      if (parallel.some((key) => arrays.get(key)!.length !== names.length)) notes.add("block", `${file}: the ${base} arrays don't have the same number of items.`);
      else {
        const valid = new Set(slotPlates(slot));
        const tokens = strings(names);
        const keep = tokens.flatMap((token, index) => token !== null && valid.has(token) ? [index] : []);
        if (keep.length !== tokens.length) {
          notes.add("fix", `${file}: licence plates that ${slot.name}'s menu doesn't have leave: ${list(tokens.filter((_, index) => !keep.includes(index)).map((token) => token ?? "(empty)"))}.`);
          for (const key of parallel) plan.arrays.push([key, keep.map((index) => arrays.get(key)![index])]);
        } else notes.add("ok", `${file}: ${tokens.length} licence plates, all in ${slot.name}'s menu.`);
      }
    }
  } else if (prefix === "ps") {
    const names = strings(arrays.get("UpgradeTypesNames"));
    const paint = slotPaint(slot);
    const own = new Set(strings(paint.UpgradeTypesNames));
    const extra = names.filter((name) => name === null || !own.has(name)).map((name) => name ?? "(empty)");
    if (extra.length) {
      notes.add("fix", `${file}: paint categories ${list(extra)} aren't in ${slot.name}'s menu; the paint arrays become ${slot.name}'s.`);
      for (const key of PAINT_ARRAYS) if (paint[key]) plan.arrays.push([key, paint[key]]);
    } else if (names.length) notes.add("ok", `${file}: ${names.length} paint categories, all in ${slot.name}'s menu.`);
  }
  return plan;
}

/** Part tokens of a vs_ with no menu text in the original game (modding KB §20.4). */
function untranslatedTokens(arrays: FlashArrays) {
  const keys = new Set(SLOT_REFERENCE.stringKeys);
  const missing = new Set<string>();
  for (const [name, items] of arrays) {
    if (!name.endsWith("Names")) continue;
    for (const item of items) if (item.kind === "string" && /^[a-z0-9_]+$/.test(item.value) && item.value.includes("_") && !keys.has(item.value)) missing.add(item.value);
  }
  return [...missing].sort();
}

// ---------------------------------------------------------------------------------------------
// .carcfg

function convertCarcfg(file: string, bytes: Uint8Array, source: string, slot: SlotReference, main: boolean, stock: { rim: boolean; exhaust: boolean }, notes: Notes) {
  const decoded = decodeCarcfg(bytes);
  let text = decoded.text;
  let blocked = false;
  const typeName = /^(\s*TypeName\s+)(\S+)/m.exec(text);
  if (!typeName) { notes.add("block", `${file}: no TypeName line.`); blocked = true; }
  else {
    if (typeName[2].toLowerCase() !== source) notes.add("warn", `${file}: TypeName was ${typeName[2]}, not ${source}; it becomes ${slot.name} anyway.`);
    text = text.replace(/^(\s*TypeName\s+)(\S+)/m, `$1${slot.name}`);
  }
  slot.profile.forEach((value, index) => {
    const pattern = new RegExp(`^(\\s*ProfileName${index + 1}\\s+)(-?\\d+)`, "m");
    if (!pattern.test(text)) { notes.add("block", `${file}: no ProfileName${index + 1} line.`); blocked = true; return; }
    text = text.replace(pattern, `$1${value}`);
  });
  const field = (key: string) => { const match = new RegExp(`^\\s*${key}\\s+(-?\\d+)`, "m").exec(text); return match ? Number(match[1]) : null; };
  const set = (key: string, value: number) => { text = text.replace(new RegExp(`^(\\s*${key}\\s+)(-?\\d+)`, "m"), `$1${value}`); };
  const rim = field("RimMdlIdx");
  if (rim !== null && (rim < 0 || rim >= SLOT_REFERENCE.namedRims || (main && stock.rim))) {
    if (slot.rimMdlIdx === null) notes.add("warn", `${file}: RimMdlIdx ${rim} is outside the original game's rims, and ${slot.name} has no stock value to use.`);
    else { set("RimMdlIdx", slot.rimMdlIdx); notes.add("fix", `${file}: RimMdlIdx ${rim} → ${slot.rimMdlIdx} (${slot.name}'s stock rim).`); }
  }
  const exhaust = field("ExhaustRear");
  if (exhaust !== null && (exhaust < 0 || exhaust >= SLOT_REFERENCE.exhausts.length || (main && stock.exhaust))) {
    if (slot.exhaustRear === null) notes.add("warn", `${file}: ExhaustRear ${exhaust} is outside the original game's exhausts, and ${slot.name} has no stock value to use.`);
    else { set("ExhaustRear", slot.exhaustRear); notes.add("fix", `${file}: ExhaustRear ${exhaust} → ${slot.exhaustRear} (${slot.name}'s stock exhaust).`); }
  }
  return blocked ? null : encodeCarcfg(text, decoded.encoding, decoded.hasBom);
}

// ---------------------------------------------------------------------------------------------
// Vehicle DAT

async function retargetDat(bytes: Uint8Array, label: string, from: string, to: string) {
  const archive = await readDave(memoryReader(bytes), label);
  const sources = [];
  for (const entry of archive.entries) {
    if (entry.isDir) continue;
    sources.push({ name: retargetPath(entry.name, from, to), bytes: await readEntry(archive, entry) });
  }
  const out = buildDave(sources);
  // Prove it: every member reads back under its new name.
  const rebuilt = await readDave(memoryReader(out), label);
  const byName = entriesByName(rebuilt);
  for (const source of sources) {
    const entry = byName.get(source.name.toLowerCase())?.[0];
    const packed = entry ? await readEntry(rebuilt, entry) : null;
    if (!packed || packed.length !== source.bytes.length || packed.some((value, index) => value !== source.bytes[index])) throw new Error(`${source.name} didn't pack correctly into the new DAT.`);
  }
  return { bytes: out, entries: sources };
}

// ---------------------------------------------------------------------------------------------

export async function retargetPackage(label: string, source: RetargetSource, target: string): Promise<RetargetResult> {
  const notesList: RetargetNote[] = [];
  const notes: Notes = { add: (level, text) => notesList.push({ level, text }) };
  const from = source.car;
  const slot = referenceSlot(target);
  const finish = (files: RetargetFile[]) => ({ source: from, target, files, notes: notesList, blocked: notesList.some((note) => note.level === "block") });
  if (!slot || !retargetSlots().includes(slot)) { notes.add("block", `${target} is not a slot of the original game that a mod can take.`); return finish([]); }
  if (slot.name === from) { notes.add("block", `The mod is already for ${from}.`); return finish([]); }
  for (const note of source.notes) notes.add("info", note);

  // ---- the files, renamed
  const files = source.files.map((file) => ({ file, path: retargetPath(file.path, from, slot.name) }));
  const named = (pattern: RegExp) => files.filter((item) => pattern.test(baseName(item.path).toLowerCase()));
  const T = escape(slot.name);

  // ---- the mod's player PCK: wheels and family
  const datItem = named(new RegExp(`^${T}\\.dat$`))[0];
  let dat: Awaited<ReturnType<typeof retargetDat>> | null = null;
  if (datItem) {
    try { dat = await retargetDat(await datItem.file.read(), baseName(datItem.file.path), from, slot.name); }
    catch (caught) { notes.add("block", `${baseName(datItem.file.path)}: ${caught instanceof Error ? caught.message : caught}`); }
  }
  const playerPck = dat?.entries.find((entry) => entry.name.toLowerCase() === `resources/vehicle/${slot.name}/${slot.name}.pck`)?.bytes
    ?? await named(new RegExp(`^${T}\\.pck$`))[0]?.file.read();
  if (playerPck) {
    const wheels = new PckDocument(`${from}.pck`, playerPck.buffer.slice(playerPck.byteOffset, playerPck.byteOffset + playerPck.byteLength) as ArrayBuffer).wheelSlots.length;
    if (!wheels) notes.add("warn", `The wheel table of ${from}.pck couldn't be read, so car versus bike wasn't checked.`);
    else if (wheels !== slot.wheels) notes.add("block", `Wheels: the mod has ${wheels}, ${slot.name} has ${slot.wheels}. A car can't take a bike's slot, or the other way round.`);
    else notes.add("ok", `Wheels: ${wheels} on both.`);
    const family = pckFamily(playerPck);
    if (family && family.name !== "standard") notes.add("warn", `${from}.pck is from the ${family.name} PCK family (0x${family.magic.toString(16).toUpperCase().padStart(8, "0")}); moving a car to another slot was only tested with the standard family.`);
  } else notes.add("warn", `The package has no ${from}.pck to check, so car versus bike wasn't checked.`);

  // ---- class and slots the game's code names
  if (!source.className) notes.add("warn", `The class of ${from} is unknown (it isn't an original or a VIP slot), so it couldn't be compared with ${slot.name}'s (${slot.className}).`);
  else if (source.className !== slot.className) notes.add("warn", `Class changes: ${from} is ${source.className}, ${slot.name} is ${slot.className}. What depends on the class (Zone, Agro, Roar, bike or SUV handling) follows the slot.`);
  else notes.add("ok", `Same class: ${slot.className}.`);
  for (const car of [from, slot.name]) for (const where of elfMentions(car)) notes.add("warn", `${car} is named in the game's code (${where}); what that special case does wasn't identified.`);

  // ---- menus
  const out: RetargetFile[] = [];
  const stock = { rim: false, exhaust: false };
  const flashFiles = new Map<string, number>();
  for (const prefix of FLASH_PREFIXES) {
    for (const item of named(new RegExp(`^${prefix}_${T}\\.pck$`))) {
      const name = baseName(item.path);
      flashFiles.set(prefix, (flashFiles.get(prefix) ?? 0) + 1);
      const bytes = await item.file.read();
      if (prefix === "ms" || prefix === "reward") { out.push({ path: item.path, sourcePath: item.file.path, bytes, change: "renamed" }); continue; }
      try {
        const arrays = runFlashArrays(bytes, name);
        const plan = planFlash(prefix, name, arrays, slot, notes);
        stock.rim ||= plan.stockRimReplaced;
        stock.exhaust ||= plan.stockExhaustReplaced;
        let final = arrays, written = bytes, change: RetargetChange = "renamed";
        if (plan.arrays.length) {
          const rewrite = rewriteFlashArrays(bytes, plan.arrays, name);
          notes.add("info", `${name} rewritten: ${rewrite.arrays.length} arrays redefined, ${rewrite.actions} actions in the main script, checked by running it again.`);
          written = rewrite.bytes; change = "converted"; final = runFlashArrays(written, name);
        }
        if (prefix === "vs") {
          const missing = untranslatedTokens(final);
          if (missing.length) notes.add("warn", `${name}: ${missing.length} part tokens have no text in the original game's mcstrings08.strtbl, so the shop shows them without a name: ${list(missing)}.`);
          else notes.add("ok", `${name}: every part token has text in the original game.`);
        }
        out.push({ path: item.path, sourcePath: item.file.path, bytes: written, change });
      } catch (caught) {
        notes.add("block", `${name}: ${caught instanceof Error ? caught.message : caught}`);
      }
    }
  }
  for (const prefix of ["ds", "ms", "ps", "vs"]) if (!flashFiles.has(prefix)) notes.add("warn", `The mod has no ${prefix}_${from}.pck; ${slot.name} keeps its own.`);

  // ---- .carcfg
  const carcfgs = named(new RegExp(`^${T}(_\\d+)?\\.carcfg$`));
  for (const item of carcfgs) {
    const name = baseName(item.path);
    const main = name.toLowerCase() === `${slot.name}.carcfg`;
    const bytes = convertCarcfg(name, await item.file.read(), from, slot, main, stock, notes);
    if (bytes) out.push({ path: item.path, sourcePath: item.file.path, bytes, change: "converted" });
  }
  const profile = String.fromCharCode(...slot.profile).replace(/\0.*$/s, "").trimEnd();
  if (carcfgs.length) notes.add("info", `TypeName ${slot.name} and ${slot.name}'s save identity (ProfileName "${profile}") written into ${carcfgs.length} .carcfg file${carcfgs.length === 1 ? "" : "s"}.`);
  if (!carcfgs.some((item) => baseName(item.path).toLowerCase() === `${slot.name}.carcfg`)) notes.add("warn", `The mod has no ${from}.carcfg; ${slot.name} keeps its own.`);
  const opponents = carcfgs.filter((item) => /_\d+\.carcfg$/i.test(item.path)).length;
  if (opponents < OPPONENT_CARCFGS) notes.add("warn", `The mod has ${opponents} of ${OPPONENT_CARCFGS} opponent .carcfg files; the rest keep ${slot.name}'s, whose part indexes are for the old car.`);

  // ---- everything else: renamed or copied as it is
  const handled = new Set(out.map((file) => file.sourcePath));
  for (const item of files) {
    if (handled.has(item.file.path)) continue;
    if (item === datItem) {
      if (dat) out.push({ path: item.path, sourcePath: item.file.path, bytes: dat.bytes, change: "converted" });
      continue;
    }
    out.push({ path: item.path, sourcePath: item.file.path, bytes: await item.file.read(), change: item.path === item.file.path.replace(/\\/g, "/") ? "unchanged" : "renamed" });
  }
  out.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));

  notes.add("info", `${slot.name} keeps its name, logo, price, class and career unlock: those live in global game files this tool never changes.`);

  // ---- the result must read as a package for the target slot
  if (!notesList.some((note) => note.level === "block")) {
    try {
      const check = await detectPackage(label, out.map((file) => ({ path: file.path, size: file.bytes.length, read: async () => file.bytes })));
      if (check.car !== slot.name) throw new Error(`it reads as ${check.car}.`);
      // A file the rename should have caught would still be renamed by S → anything.
      const stale = out.filter((file) => retargetPath(file.path, from, "\u0001").includes("\u0001"));
      if (stale.length) throw new Error(`${list(stale.map((file) => file.path))} still belong to ${from} by name.`);
    } catch (caught) {
      notes.add("block", `The converted package failed its own check: ${caught instanceof Error ? caught.message : caught}`);
    }
  }
  return finish(out);
}
