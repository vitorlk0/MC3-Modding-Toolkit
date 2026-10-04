import { SECTOR, bothEndian32, memoryReader, readIso, sliceReader, type ByteReader, type IsoEntry, type IsoImage } from "./iso9660";
import { DAVE_TABLE_START, daveKey, entriesByName, isCompressed, readDave, readEntry, type DaveArchive, type DaveEntry } from "./dave";
import { deflateRaw } from "./deflate";

/** The game addresses .DAT contents with 32-bit byte offsets from the start of the disc: a .DAT that
 *  reaches past 4 GiB freezes it on a black screen (seen with ASSETS.DAT at 4.0-5.5 GB). */
export const DAT_BYTE_LIMIT = 0x1_0000_0000;
import { buildVehicleDat, findVehicleFolders } from "./dave-build";

/**
 * ISO Install — writes finished car mods into ASSETS.DAT of a compiled MC3 PS2 image.
 *
 * A mod replaces an existing car. Four kinds of file are recognised by name, wherever they sit in
 * the package, and each lands at its fixed ASSETS path:
 *   DAT     vp_x.dat               → vp_x.dat                                  (required)
 *   Garage  vp_x_g.pck             → resources/vehicle/vp_x/vp_x_g.pck          (required)
 *   Flash   ds_|ms_|ps_|vs_|reward_vp_x.pck → flash/…                           (optional)
 *   Carcfg  vp_x.carcfg, vp_x_N.carcfg → tune/vehicle/customdata/…             (optional)
 * A HostFS-style package has no vp_x.dat but the DAT's contents loose in a folder (vp_x.pck,
 * vp_x_o.pck and the parts): the DAT is then compiled from that folder (src/dave-build.ts). When a
 * vp_x.dat is present it always wins and loose vehicle PCKs are ignored.
 * Everything else (textures, readmes, scripts) is ignored. Nothing is ever added to ASSETS: a file
 * whose target entry doesn't exist is skipped with a warning.
 *
 * Writing, in order of preference:
 *   in place  every changed file fits the room its old copy had (up to the next entry) — only those
 *             bytes and the entry records are rewritten; the ISO keeps its size and layout.
 *   rebuild   something grew. The image is copied to a temp file with ASSETS extended at its end
 *             (new payloads appended there), every file after ASSETS moved forward by the same
 *             amount, their ISO9660 records re-pointed, then the temp file replaces the image.
 *             Only for single-layer images whose layout this can reason about (see `rebuildBlocker`).
 * Untouched ASSETS entries keep their exact bytes and offsets in both paths.
 */

// ---------------------------------------------------------------------------------------------
// Package detection

export type ModCategory = "dat" | "garage" | "flash" | "carcfg";
export const CATEGORY_ORDER: ModCategory[] = ["garage", "dat", "flash", "carcfg"];

export type PackageFile = { path: string; size: number; read: () => Promise<Uint8Array> };
export type ModFile = {
  category: ModCategory; name: string; sourcePath: string; target: string; size: number; read: () => Promise<Uint8Array>;
  /** Set when the DAT was compiled from a loose vehicle folder: how many PCKs went into it. */
  compiledFrom?: number;
};
export type ModPackage = {
  car: string;
  source: string;
  files: ModFile[];
  /** Files the package carries that are deliberately not installed. */
  ignored: string[];
  notes: string[];
};

const baseName = (path: string) => path.replace(/^.*[\\/]/, "");
const CAR_ID = "vp_[a-z0-9_]+";

export function targetFor(category: ModCategory, car: string, name: string) {
  switch (category) {
    case "dat": return `${car}.dat`;
    case "garage": return `resources/vehicle/${car}/${car}_g.pck`;
    case "flash": return `flash/${name}`;
    case "carcfg": return `tune/vehicle/customdata/${name}`;
  }
}

/**
 * Sorts a package's files into the four installable kinds. Throws — with the reason as the message —
 * when the package can't be used: no car found, more than one car, the DAT or garage PCK missing,
 * or two different files claiming the same target.
 */
export async function detectPackage(source: string, files: PackageFile[]): Promise<ModPackage> {
  const lower = (file: PackageFile) => baseName(file.path).toLowerCase();
  const cars = new Set<string>();
  for (const file of files) {
    const name = lower(file);
    const dat = new RegExp(`^(${CAR_ID})\\.dat$`).exec(name);
    const garage = new RegExp(`^(${CAR_ID})_g\\.pck$`).exec(name);
    if (dat) cars.add(dat[1]);
    if (garage) cars.add(garage[1]);
  }
  if (!cars.size) throw new Error("No car found: the package has no vp_*.dat and no vp_*_g.pck.");
  if (cars.size > 1) throw new Error(`The package mixes more than one car (${[...cars].join(", ")}). Put one car per ZIP.`);
  const car = [...cars][0];
  const escaped = car.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns: [ModCategory, RegExp][] = [
    ["dat", new RegExp(`^${escaped}\\.dat$`)],
    ["garage", new RegExp(`^${escaped}_g\\.pck$`)],
    ["flash", new RegExp(`^(ds|ms|ps|vs|reward)_${escaped}\\.pck$`)],
    ["carcfg", new RegExp(`^${escaped}(_\\d+)?\\.carcfg$`)],
  ];
  const otherCar = new RegExp(`^((ds|ms|ps|vs|reward)_)?${CAR_ID}(_\\d+)?\\.(pck|carcfg|dat)$`);
  // The DAT's contents, when the package carries them loose (HostFS layout).
  const vehicles = findVehicleFolders(files).filter((vehicle) => vehicle.car === car);
  if (vehicles.length > 1) throw new Error(`${car}'s vehicle files are in more than one folder (${vehicles.map((vehicle) => vehicle.folder || "the top folder").join(", ")}). Keep one.`);
  const vehicle = vehicles[0] ?? null;
  const looseVehicle = new Set(vehicle?.included.map((file) => file.path) ?? []);

  const byTarget = new Map<string, ModFile>();
  const ignored: string[] = [];
  const notes: string[] = [];
  for (const file of files) {
    const name = lower(file);
    if (looseVehicle.has(file.path)) continue;
    const match = patterns.find(([, pattern]) => pattern.test(name));
    if (!match) {
      if (otherCar.test(name)) throw new Error(`${baseName(file.path)} belongs to a different car than ${car}. Put one car per ZIP.`);
      ignored.push(file.path);
      continue;
    }
    const category = match[0];
    const target = targetFor(category, car, name);
    const modFile: ModFile = { category, name, sourcePath: file.path, target, size: file.size, read: file.read };
    const previous = byTarget.get(target);
    if (previous) {
      const [a, b] = await Promise.all([previous.read(), file.read()]);
      if (a.length !== b.length || a.some((value, index) => value !== b[index])) {
        throw new Error(`The package has two different copies of ${name} (${previous.sourcePath} and ${file.path}).`);
      }
      continue;
    }
    byTarget.set(target, modFile);
  }
  const datTarget = targetFor("dat", car, `${car}.dat`);
  if (byTarget.has(datTarget)) {
    if (looseVehicle.size) notes.push(`Using ${car}.dat from the package — the ${looseVehicle.size} loose vehicle PCKs in ${vehicle!.folder || "the top folder"} are ignored.`);
  } else if (vehicle) {
    let built: Promise<Uint8Array> | null = null;
    byTarget.set(datTarget, {
      category: "dat", name: `${car}.dat`, sourcePath: `${vehicle.folder || "."}/`, target: datTarget, size: 0,
      read: () => (built ??= buildVehicleDat(vehicle)), compiledFrom: vehicle.included.length,
    });
  }
  const modFiles = [...byTarget.values()].sort((a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  if (!modFiles.some((file) => file.category === "dat")) throw new Error(`${car}.dat is missing — a car mod needs its DAT, or the loose ${car}.pck / ${car}_o.pck / parts folder to compile it from.`);
  if (!modFiles.some((file) => file.category === "garage")) throw new Error(`${car}_g.pck is missing — a car mod needs its garage PCK.`);

  // The DAT must really be this car's vehicle archive, not just a file with the right name.
  const datFile = modFiles.find((file) => file.category === "dat")!;
  const datBytes = await datFile.read();
  let dat: DaveArchive;
  try { dat = await readDave(memoryReader(datBytes), datFile.name); }
  catch (caught) { throw new Error(`${datFile.name} is not a valid DAVE archive: ${caught instanceof Error ? caught.message : caught}`); }
  const inner = entriesByName(dat);
  if (!inner.has(`resources/vehicle/${car}/${car}.pck`)) throw new Error(`${datFile.name} doesn't contain resources/vehicle/${car}/${car}.pck — it isn't ${car}'s vehicle DAT.`);
  if (!inner.has(`resources/vehicle/${car}/${car}_o.pck`)) notes.push(`${datFile.name} has no ${car}_o.pck (opponent PCK) inside.`);

  return { car, source, files: modFiles, ignored, notes };
}

// ---------------------------------------------------------------------------------------------
// ISO session

export type IsoSession = {
  reader: ByteReader;
  iso: IsoImage;
  assets: IsoEntry;
  archive: DaveArchive;
  byName: Map<string, DaveEntry[]>;
  /** Why growing ASSETS is impossible on this image, or null when a rebuild is allowed. */
  rebuildBlocker: string | null;
  /** Bytes between the end of ASSETS.DAT and the next thing on disc — room it can grow into
   *  without moving anything (the reserve a Compact ISO leaves). Zero-checked before use. */
  assetsRoom: number;
};

const alignUp = (value: number, alignment = SECTOR) => Math.ceil(value / alignment) * alignment;

export async function openIsoSession(reader: ByteReader): Promise<IsoSession> {
  const iso = await readIso(reader);
  const matches = iso.entries.filter((entry) => !entry.isDir && entry.name.toLowerCase() === "assets.dat");
  if (!matches.length) throw new Error("ASSETS.DAT was not found in this ISO — is it a Midnight Club 3 image?");
  const assets = matches.reduce((a, b) => (b.size > a.size ? b : a));
  const archive = await readDave(sliceReader(reader, assets.lba * SECTOR, assets.size), "ASSETS.DAT");
  const tailStart = assets.lba * SECTOR + alignUp(assets.size);
  const nextStart = Math.min(reader.size, ...iso.entries.filter((entry) => entry !== assets && entry.size > 0 && entry.lba * SECTOR >= tailStart).map((entry) => entry.lba * SECTOR));
  return { reader, iso, assets, archive, byName: entriesByName(archive), rebuildBlocker: rebuildBlocker(reader.size, iso, assets), assetsRoom: Math.max(0, nextStart - tailStart) };
}

function rebuildBlocker(fileSize: number, iso: IsoImage, assets: IsoEntry): string | null {
  const tailStart = assets.lba * SECTOR + alignUp(assets.size);
  // ImgBurn leaves a UDF anchor sector past the ISO9660 volume end, which moves along harmlessly.
  // Anything larger there — an original disc's second layer — is addressed by absolute sector.
  const outside = fileSize - iso.volumeBlocks * SECTOR;
  if (outside < 0 || outside > 1024 * 1024) {
    return "This image has data outside its ISO9660 volume — typically an original dual-layer disc image, whose second layer can't be moved. Use a re-mastered single-layer ISO (like one made with ImgBurn).";
  }
  if (iso.descriptors.some((d) => d.id === "CD001" && d.type === 2)) return "This image has a secondary (Joliet) volume descriptor, which this tool doesn't update.";
  if (assets.flags & 0x80) return "ASSETS.DAT is stored as a multi-extent file, which this tool doesn't handle.";
  for (const entry of iso.entries) {
    if (entry === assets || entry.size === 0) continue;
    const start = entry.lba * SECTOR;
    if (entry.isDir && start >= tailStart) return `The folder ${entry.path} sits after ASSETS.DAT; moving folders isn't supported.`;
    if (!entry.isDir && start < tailStart && start + entry.size > assets.lba * SECTOR) return `${entry.path} overlaps ASSETS.DAT on disc.`;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Checking a package against the open ISO

export type CategoryReport = {
  category: ModCategory;
  /** Files of this kind in the package that have a target in ASSETS. */
  files: ModFile[];
  /** How many files of this kind the original car has in ASSETS. */
  expected: number;
};
export type CarReport = { pkg: ModPackage; errors: string[]; warnings: string[]; categories: Record<ModCategory, CategoryReport> };

export function checkPackage(session: IsoSession, pkg: ModPackage): CarReport {
  const errors: string[] = [];
  const warnings = [...pkg.notes];
  const { car } = pkg;
  if (!session.byName.has(`${car}.dat`)) errors.push(`${car} doesn't exist in this ISO (no ${car}.dat in ASSETS). A mod has to replace an existing car.`);
  const keys = [...session.byName.keys()];
  const expectedFlash = keys.filter((key) => new RegExp(`^flash/(ds|ms|ps|vs)_${car}\\.pck$`).test(key)).length;
  // Only the numbered opponent variants count towards a complete set; the plain vp_x.carcfg is optional.
  const expectedCarcfg = keys.filter((key) => new RegExp(`^tune/vehicle/customdata/${car}_\\d+\\.carcfg$`).test(key)).length;
  const categories = Object.fromEntries(CATEGORY_ORDER.map((category) => [category, {
    category, files: [] as ModFile[],
    expected: category === "flash" ? expectedFlash : category === "carcfg" ? expectedCarcfg : 1,
  }])) as Record<ModCategory, CategoryReport>;
  for (const file of pkg.files) {
    if (!session.byName.has(daveKey(file.target))) {
      if (file.category === "dat" || file.category === "garage") errors.push(`${file.target} doesn't exist in this ISO's ASSETS.`);
      else warnings.push(`${file.name} is skipped: ${car} has no ${file.target} in ASSETS to replace.`);
      continue;
    }
    categories[file.category].files.push(file);
  }
  // reward_ is an optional extra; "complete" means the four menu files.
  const flash = categories.flash.files.filter((file) => !file.name.startsWith("reward_")).length;
  const carcfg = categories.carcfg.files.filter((file) => /_\d+\.carcfg$/.test(file.name)).length;
  if (flash > 0 && flash < expectedFlash) warnings.push(`Only ${flash} of ${expectedFlash} flash files are in the package — the missing ones keep the original car's menus, which may not match.`);
  if (carcfg > 0 && carcfg < expectedCarcfg) warnings.push(`Only ${carcfg} of ${expectedCarcfg} carcfg files are in the package — the rest keep the original car's opponent setups.`);
  return { pkg, errors, warnings, categories };
}

// ---------------------------------------------------------------------------------------------
// Planning

export type Patch = { label: string; offset: number; bytes: Uint8Array };
export type ItemAction = "unchanged" | "in-place" | "append";
export type PlanItem = {
  car: string;
  file: ModFile;
  entries: DaveEntry[];
  source: Uint8Array;
  stored: Uint8Array;
  compressed: boolean;
  action: ItemAction;
  oldStored: number;
  /** Offset of the payload inside ASSETS after installation. */
  newOffset: number;
};
export type InstallPlan = {
  mode: "nothing" | "in-place" | "grow" | "rebuild";
  items: PlanItem[];
  oldAssetsSize: number;
  newAssetsSize: number;
  /** Bytes every file after ASSETS moves forward by (rebuild only). */
  shift: number;
  /** Where the moved tail starts in the source image (rebuild only). */
  tailStart: number;
  patches: Patch[];
  sourceSize: number;
  finalSize: number;
};

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((value, index) => value === b[index]);
const record12 = (offset: number, full: number, stored: number) => {
  const out = new Uint8Array(12);
  const view = new DataView(out.buffer);
  view.setUint32(0, offset, true); view.setUint32(4, full, true); view.setUint32(8, stored, true);
  return out;
};

/** Only .carcfg is stored compressed, and only where the original entry is — vehicle DATs, PCKs and
 *  flash stay raw like the original game keeps them. */
const shouldCompress = (file: ModFile, entries: DaveEntry[]) => file.category === "carcfg" && entries.every(isCompressed);

export async function buildPlan(session: IsoSession, selections: { car: string; files: ModFile[] }[]): Promise<InstallPlan> {
  const { archive, assets, iso } = session;
  const assetsStart = assets.lba * SECTOR;
  const payloads = archive.entries.filter((entry) => !entry.isDir && entry.sizeStored > 0);
  const starts = [...new Set(payloads.map((entry) => entry.offset))].sort((a, b) => a - b);
  const items: PlanItem[] = [];

  for (const { car, files } of selections) {
    for (const file of files) {
      const entries = session.byName.get(daveKey(file.target));
      if (!entries?.length) continue;
      const source = await file.read();
      let stored = source, compressed = false;
      if (shouldCompress(file, entries)) {
        const packed = await deflateRaw(source);
        if (packed.length < source.length) { stored = packed; compressed = true; }
      }
      let unchanged = true;
      for (const entry of entries) if (!sameBytes(await readEntry(archive, entry), source)) { unchanged = false; break; }
      const first = entries[0];
      const item: PlanItem = { car, file, entries, source, stored, compressed, action: "unchanged", oldStored: first.sizeStored, newOffset: first.offset };
      if (!unchanged) item.action = (await fitsInPlace(session, entries, stored.length, payloads, starts)) ? "in-place" : "append";
      items.push(item);
    }
  }

  const oldAssetsSize = assets.size;
  const appends = items.filter((item) => item.action === "append");
  let cursor = alignUp(oldAssetsSize);
  const appendStart = cursor;
  for (const item of appends) { item.newOffset = cursor; cursor = alignUp(cursor + item.stored.length); }
  const newAssetsSize = appends.length ? cursor : oldAssetsSize;
  if (newAssetsSize > 0xffffffff) throw new Error("ASSETS.DAT would grow past 4 GB, the limit of its offset fields.");
  const changed = items.filter((item) => item.action !== "unchanged");
  const tailStart = assetsStart + alignUp(oldAssetsSize);
  const growth = alignUp(newAssetsSize) - alignUp(oldAssetsSize);
  // Growing into zeros already sitting after ASSETS.DAT (the reserve a Compact ISO leaves) moves
  // nothing else: only those zeros, the entry records and the ASSETS.DAT size change.
  const fitsReserve = growth > 0 && growth <= session.assetsRoom
    && !(await session.reader.read(tailStart, growth)).some((value) => value !== 0);
  const mode = !changed.length ? "nothing" : !appends.length ? "in-place" : fitsReserve ? "grow" : "rebuild";
  if (assetsStart + newAssetsSize > DAT_BYTE_LIMIT) {
    throw new Error(`ASSETS.DAT would reach past 4 GB on the disc (it starts at ${(assetsStart / 1024 ** 3).toFixed(2)} GB), and the game reads DAT files with 32-bit byte offsets — it would freeze on a black screen. Use an ISO with ASSETS.DAT near the start, like one made by Tools › 07 Compact ISO.`);
  }
  if (mode === "rebuild") {
    for (const entry of iso.entries) {
      if (entry.isDir || entry === assets || entry.lba * SECTOR < tailStart || !/\.DAT$/i.test(entry.name)) continue;
      if (entry.lba * SECTOR + growth + entry.size > DAT_BYTE_LIMIT) throw new Error(`Growing ASSETS.DAT here would push ${entry.path} past 4 GB on the disc, where the game can't read DAT files. Re-compact the original ISO with a larger reserve (Tools › 07 Compact ISO).`);
    }
  }
  if (mode === "rebuild" && session.rebuildBlocker) {
    const examples = appends.slice(0, 3).map((item) => `${item.file.name} ${item.oldStored} → ${item.stored.length} bytes`).join(", ");
    const more = appends.length > 3 ? ` and ${appends.length - 3} more` : "";
    throw new Error(`Not enough room in this ISO: ${appends.length} file${appends.length === 1 ? " is" : "s are"} bigger than the space the original had (${examples}${more}), and ASSETS.DAT can't grow here. ${session.rebuildBlocker}`);
  }

  // Bytes every file after ASSETS.DAT moves forward by — only a rebuild moves anything.
  const shift = mode === "rebuild" ? growth : 0;
  const patches: Patch[] = [];
  for (const item of changed) {
    for (const entry of item.entries) {
      patches.push({ label: `record ${entry.name}`, offset: assetsStart + DAVE_TABLE_START + entry.index * 0x10 + 4, bytes: record12(item.newOffset, item.source.length, item.stored.length) });
    }
    if (item.action === "in-place") {
      // A smaller file zero-fills the rest of its old bytes, so no stale tail is left behind.
      const payload = new Uint8Array(Math.max(item.stored.length, item.oldStored));
      payload.set(item.stored);
      patches.push({ label: `payload ${item.file.target}`, offset: assetsStart + item.newOffset, bytes: payload });
    }
  }
  if (appends.length) {
    const region = new Uint8Array(newAssetsSize - appendStart);
    for (const item of appends) region.set(item.stored, item.newOffset - appendStart);
    patches.push({ label: "appended payloads", offset: assetsStart + appendStart, bytes: region });
  }
  if (mode === "rebuild" || mode === "grow") {
    patches.push({ label: "ASSETS.DAT size", offset: assets.recordOffset + 10, bytes: bothEndian32(newAssetsSize) });
    if (mode === "rebuild") {
      const moveSectors = shift / SECTOR;
      for (const entry of iso.entries) {
        if (entry.isDir || entry === assets || entry.lba * SECTOR < tailStart) continue;
        patches.push({ label: `LBA ${entry.path}`, offset: entry.recordOffset + 2, bytes: bothEndian32(entry.lba + moveSectors) });
      }
      patches.push({ label: "volume size", offset: iso.pvdLba * SECTOR + 80, bytes: bothEndian32(iso.volumeBlocks + moveSectors) });
    }
    // A UDF bridge would still describe the old ASSETS.DAT size and layout; blank its recognition
    // sequence so readers use the ISO9660 tree kept correct here (the PS2 and PCSX2 read ISO9660).
    for (const descriptor of iso.descriptors) {
      if (/^(BEA01|NSR0[23]|TEA01)$/.test(descriptor.id)) patches.push({ label: `disable UDF ${descriptor.id}`, offset: descriptor.lba * SECTOR, bytes: new Uint8Array(SECTOR) });
    }
  }
  patches.sort((a, b) => a.offset - b.offset);
  for (let i = 1; i < patches.length; i++) {
    if (patches[i].offset < patches[i - 1].offset + patches[i - 1].bytes.length) throw new Error(`Internal error: ${patches[i - 1].label} overlaps ${patches[i].label}.`);
  }
  return { mode, items, oldAssetsSize, newAssetsSize, shift, tailStart, patches, sourceSize: session.reader.size, finalSize: session.reader.size + shift };
}

async function fitsInPlace(session: IsoSession, entries: DaveEntry[], newStored: number, payloads: DaveEntry[], starts: number[]) {
  const first = entries[0];
  // Duplicate names are rewritten together, so they must share one payload to be patched in place.
  if (entries.some((entry) => entry.offset !== first.offset || entry.sizeStored !== first.sizeStored)) return false;
  const indices = new Set(entries.map((entry) => entry.index));
  const end = first.offset + Math.max(first.sizeStored, newStored);
  // Some archives point two different names at overlapping bytes; writing there would change both.
  if (payloads.some((other) => !indices.has(other.index) && other.offset < end && first.offset < other.offset + other.sizeStored)) return false;
  const next = starts.find((start) => start > first.offset) ?? session.archive.size;
  if (first.offset + newStored > next) return false;
  if (newStored > first.sizeStored) {
    const extra = await session.archive.reader.read(first.offset + first.sizeStored, newStored - first.sizeStored);
    if (extra.some((value) => value !== 0)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------------------------
// Applying

export interface RandomFile extends ByteReader {
  write(offset: number, bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
}
export interface IsoFileSystem {
  openRead(path: string): Promise<RandomFile>;
  /** Opens an existing file for reading and writing. */
  openWrite(path: string): Promise<RandomFile>;
  /** Creates (or empties) a file for reading and writing. */
  create(path: string): Promise<RandomFile>;
  /** Moves `from` over `to`, replacing it. */
  replace(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
}
export type Progress = (phase: string, done: number, total: number) => void;

const COPY_CHUNK = 16 * 1024 * 1024;

async function digest(bytes: Uint8Array) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
}

async function readAllPatches(file: RandomFile, patches: Patch[]) {
  return Promise.all(patches.map((patch) => file.read(patch.offset, patch.bytes.length)));
}

/** Re-opens the written image and proves the result: every installed file reads back as its source,
 *  every other ASSETS entry is where it was, and (after a rebuild) every moved ISO file moved exactly. */
async function verifyResult(file: RandomFile, before: IsoSession, plan: InstallPlan) {
  const after = await openIsoSession(file);
  if (after.assets.lba !== before.assets.lba) throw new Error("ASSETS.DAT moved on disc.");
  if (after.assets.size !== plan.newAssetsSize) throw new Error(`ASSETS.DAT size is ${after.assets.size}, expected ${plan.newAssetsSize}.`);
  if (after.archive.entries.length !== before.archive.entries.length) throw new Error("ASSETS.DAT entry count changed.");
  const touched = new Set(plan.items.filter((item) => item.action !== "unchanged").flatMap((item) => item.entries.map((entry) => entry.index)));
  before.archive.entries.forEach((entry, index) => {
    const now = after.archive.entries[index];
    if (now.name !== entry.name) throw new Error(`ASSETS entry ${index} was renamed.`);
    if (!touched.has(index) && (now.offset !== entry.offset || now.sizeFull !== entry.sizeFull || now.sizeStored !== entry.sizeStored)) throw new Error(`${entry.name} changed although it wasn't part of the install.`);
  });
  for (const item of plan.items) {
    if (item.action === "unchanged") continue;
    for (const entry of item.entries) {
      const now = after.archive.entries[entry.index];
      if (now.offset !== item.newOffset || now.sizeFull !== item.source.length || now.sizeStored !== item.stored.length) throw new Error(`${entry.name} has the wrong record after install.`);
      if (!sameBytes(await readEntry(after.archive, now), item.source)) throw new Error(`${entry.name} doesn't read back as the mod's file.`);
    }
  }
  const moveSectors = plan.shift / SECTOR;
  const beforeByPath = new Map(before.iso.entries.map((entry) => [entry.path, entry]));
  for (const entry of after.iso.entries) {
    const old = beforeByPath.get(entry.path);
    if (!old) throw new Error(`${entry.path} appeared in the ISO.`);
    if (old === before.assets) continue;
    const expectedLba = !old.isDir && old.lba * SECTOR >= plan.tailStart ? old.lba + moveSectors : old.lba;
    if (entry.lba !== expectedLba || entry.size !== old.size) throw new Error(`${entry.path} is at the wrong place after install.`);
  }
  if (after.iso.entries.length !== before.iso.entries.length) throw new Error("ISO file count changed.");
}

/** In place, or growing into the reserve: patches are written straight into the ISO, with the bytes
 *  they replace kept in memory to put back if anything fails. */
async function applyInPlace(fs: IsoFileSystem, path: string, session: IsoSession, plan: InstallPlan, progress: Progress) {
  const file = await fs.openWrite(path);
  const oldSize = file.size;
  const inside = plan.patches.filter((patch) => patch.offset + patch.bytes.length <= oldSize);
  if (plan.patches.some((patch) => patch.offset < oldSize && patch.offset + patch.bytes.length > oldSize)) {
    await file.close();
    throw new Error("Internal error: a write straddles the end of the ISO.");
  }
  let originals: Uint8Array[] | null = null;
  try {
    progress("Backing up the bytes to change", 0, 1);
    originals = (await readAllPatches(file, inside)).map((bytes) => bytes.slice());
    for (let i = 0; i < plan.patches.length; i++) {
      progress("Writing", i, plan.patches.length);
      await file.write(plan.patches[i].offset, plan.patches[i].bytes);
    }
    progress("Verifying", 0, 1);
    if (file.size !== plan.finalSize) throw new Error(`The ISO is ${file.size} bytes, expected ${plan.finalSize}.`);
    const written = await readAllPatches(file, plan.patches);
    plan.patches.forEach((patch, i) => { if (!sameBytes(written[i], patch.bytes)) throw new Error(`Read-back of ${patch.label} doesn't match what was written.`); });
    await verifyResult(file, session, plan);
  } catch (caught) {
    if (originals) {
      for (let i = inside.length - 1; i >= 0; i--) await file.write(inside[i].offset, originals[i]).catch(() => undefined);
    }
    await file.close();
    throw new Error(`${caught instanceof Error ? caught.message : caught} Every changed byte was restored.`);
  }
  await file.close();
}

async function applyRebuild(fs: IsoFileSystem, path: string, session: IsoSession, plan: InstallPlan, progress: Progress) {
  const temp = `${path}.mc3pae-tmp`;
  const source = await fs.openRead(path);
  const target = await fs.create(temp);
  try {
    // 1. Copy the image, opening a gap of `shift` bytes after the old ASSETS end.
    const segments = [
      { from: 0, to: 0, length: plan.tailStart },
      { from: plan.tailStart, to: plan.tailStart + plan.shift, length: plan.sourceSize - plan.tailStart },
    ];
    const total = plan.sourceSize;
    const hashes: { to: number; length: number; hash: Uint8Array }[] = [];
    let done = 0;
    for (const segment of segments) {
      for (let pos = 0; pos < segment.length; pos += COPY_CHUNK) {
        const length = Math.min(COPY_CHUNK, segment.length - pos);
        const chunk = await source.read(segment.from + pos, length);
        hashes.push({ to: segment.to + pos, length, hash: await digest(chunk) });
        await target.write(segment.to + pos, chunk);
        done += length;
        progress("Copying the ISO", done, total);
      }
    }
    await source.close();
    // 2. Prove the copy landed before anything is patched over it.
    done = 0;
    for (const chunk of hashes) {
      const hash = await digest(await target.read(chunk.to, chunk.length));
      if (!sameBytes(hash, chunk.hash)) throw new Error(`The copy is corrupt near offset 0x${chunk.to.toString(16)}.`);
      done += chunk.length;
      progress("Verifying the copy", done, total);
    }
    // 3. Patch: appended payloads, entry records, moved LBAs, sizes.
    for (let i = 0; i < plan.patches.length; i++) {
      progress("Writing the mods", i, plan.patches.length);
      await target.write(plan.patches[i].offset, plan.patches[i].bytes);
    }
    if (target.size !== plan.finalSize) throw new Error(`The new image is ${target.size} bytes, expected ${plan.finalSize}.`);
    progress("Verifying the mods", 0, 1);
    const written = await readAllPatches(target, plan.patches);
    plan.patches.forEach((patch, i) => { if (!sameBytes(written[i], patch.bytes)) throw new Error(`Read-back of ${patch.label} doesn't match what was written.`); });
    await verifyResult(target, session, plan);
    await target.close();
  } catch (caught) {
    await source.close().catch(() => undefined);
    await target.close().catch(() => undefined);
    await fs.remove(temp).catch(() => undefined);
    throw new Error(`${caught instanceof Error ? caught.message : caught} The ISO was not changed.`);
  }
  progress("Replacing the ISO", 0, 1);
  try { await fs.replace(temp, path); }
  catch (caught) {
    throw new Error(`The new image is complete and verified at ${temp}, but it couldn't replace the ISO (${caught instanceof Error ? caught.message : caught}). Is the ISO open in PCSX2? Close it and rename the file by hand.`);
  }
}

/** Writes the plan. The caller must have closed its own handles on `path` first. */
export async function applyPlan(fs: IsoFileSystem, path: string, session: IsoSession, plan: InstallPlan, progress: Progress = () => undefined) {
  if (plan.mode === "in-place" || plan.mode === "grow") await applyInPlace(fs, path, session, plan, progress);
  else if (plan.mode === "rebuild") await applyRebuild(fs, path, session, plan, progress);
}
