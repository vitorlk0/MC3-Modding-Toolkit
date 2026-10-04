import type { ByteReader } from "./iso9660";
import { inflateRaw } from "./deflate";

/**
 * Reader for Angel Studios / Rockstar San Diego DAVE archives (ASSETS.DAT, vp_*.dat).
 *
 * Layout, as implemented by the MC3 ISO Direct Explorer script from EdnessP's dave.py:
 *   0x00  magic "DAVE" (plain names) or "Dave" (6-bit packed names)
 *   0x04  u32 entry count, u32 entry-table size, u32 name-table size
 *   0x800 entry table, 0x10 bytes per entry: name offset, file offset, full size, stored size
 *   0x800 + tableSize: name table
 * An entry is compressed (raw DEFLATE) when its full and stored sizes differ.
 *
 * Only reading lives here. The installer changes an archive by rewriting the 12 bytes of an
 * entry's record (offset, full size, stored size); names and entry order are never touched.
 */

export const DAVE_CHARS = "\x00 #$()-./?0123456789_abcdefghijklmnopqrstuvwxyz~\x7F";
export const DAVE_TABLE_START = 0x800;

export type DaveEntry = {
  index: number;
  name: string;
  offset: number;
  sizeFull: number;
  sizeStored: number;
  isDir: boolean;
};

export type DaveArchive = {
  magic: "DAVE" | "Dave";
  count: number;
  tableSize: number;
  namesSize: number;
  size: number;
  entries: DaveEntry[];
  reader: ByteReader;
};

export const isCompressed = (entry: DaveEntry) => entry.sizeFull !== entry.sizeStored;

/** Absolute offset (inside the archive) of an entry's offset/full/stored triple. */
export const recordFieldsOffset = (entry: DaveEntry) => DAVE_TABLE_START + entry.index * 0x10 + 4;

/** Folds a path the way archive lookups compare them: forward slashes, no duplicate or edge slashes, lower case. */
export const daveKey = (name: string) => name.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/|\/$/g, "").toLowerCase();

function decodePackedName(names: Uint8Array, start: number, previous: string) {
  let pos = start;
  const bits: number[] = [];
  const readGroup = () => {
    if (pos + 3 > names.length) throw new Error("A packed DAVE filename runs past the name table.");
    const value = names[pos] | (names[pos + 1] << 8) | (names[pos + 2] << 16);
    pos += 3;
    for (let i = 0; i < 4; i++) bits.push((value >> (i * 6)) & 0x3f);
  };
  readGroup();
  let name = "";
  if (bits[0] >= 0x38) {
    const b0 = bits.shift()!;
    const b1 = bits.shift()!;
    const shared = (b1 - 0x20) * 8 + b0 - 0x38;
    if (shared < 0) throw new Error("Invalid packed DAVE filename prefix.");
    name = previous.slice(0, shared);
  }
  for (;;) {
    if (!bits.length) readGroup();
    const value = bits.shift()!;
    if (value === 0) break;
    if (value >= DAVE_CHARS.length) throw new Error("Invalid packed DAVE filename character.");
    name += DAVE_CHARS[value];
  }
  return name;
}

export async function readDave(reader: ByteReader, label = "archive"): Promise<DaveArchive> {
  if (reader.size < 0x800) throw new Error(`${label} is too small to be a DAVE archive.`);
  const header = await reader.read(0, 0x10);
  const magic = String.fromCharCode(...header.subarray(0, 4));
  if (magic !== "DAVE" && magic !== "Dave") throw new Error(`${label} is not a DAVE archive.`);
  const view = new DataView(header.buffer, header.byteOffset, 0x10);
  const count = view.getUint32(4, true), tableSize = view.getUint32(8, true), namesSize = view.getUint32(12, true);
  if (count > 2_000_000 || count * 0x10 > tableSize) throw new Error(`${label} has an implausible DAVE entry table.`);
  const namesBase = DAVE_TABLE_START + tableSize;
  if (namesBase + namesSize > reader.size) throw new Error(`${label}: the DAVE name table runs past the end of the file.`);
  const table = await reader.read(DAVE_TABLE_START, count * 0x10);
  const names = await reader.read(namesBase, namesSize);
  const tv = new DataView(table.buffer, table.byteOffset, table.byteLength);
  const entries: DaveEntry[] = [];
  let previous = "";
  for (let index = 0; index < count; index++) {
    const nameOffset = tv.getUint32(index * 16, true);
    const offset = tv.getUint32(index * 16 + 4, true);
    const sizeFull = tv.getUint32(index * 16 + 8, true);
    const sizeStored = tv.getUint32(index * 16 + 12, true);
    if (nameOffset >= names.length) throw new Error(`${label}: a DAVE filename pointer is outside the name table.`);
    let raw: string;
    if (magic === "DAVE") {
      const end = names.indexOf(0, nameOffset);
      if (end < 0) throw new Error(`${label}: unterminated DAVE filename.`);
      raw = String.fromCharCode(...names.subarray(nameOffset, end));
    } else {
      raw = decodePackedName(names, nameOffset, previous);
    }
    previous = raw;
    const isDir = raw.endsWith("/") || (sizeFull === 0 && sizeStored === 0);
    const name = raw.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "");
    if (!isDir && offset + sizeStored > reader.size) throw new Error(`${label}: ${name} points past the end of the archive.`);
    entries.push({ index, name, offset, sizeFull, sizeStored, isDir });
  }
  return { magic, count, tableSize, namesSize, size: reader.size, entries, reader };
}

/** Stored bytes as they sit in the archive (compressed entries stay compressed). */
export const readStored = (archive: DaveArchive, entry: DaveEntry) => archive.reader.read(entry.offset, entry.sizeStored);

/** The file's real content, inflated when the entry is compressed. */
export async function readEntry(archive: DaveArchive, entry: DaveEntry) {
  const stored = await readStored(archive, entry);
  if (!isCompressed(entry)) return stored;
  const out = await inflateRaw(stored);
  if (out.length !== entry.sizeFull) throw new Error(`${entry.name} inflated to ${out.length} bytes, expected ${entry.sizeFull}.`);
  return out;
}

/** Case-insensitive name → entries. A name can appear more than once in ASSETS.DAT (some .carcfg do). */
export function entriesByName(archive: DaveArchive) {
  const map = new Map<string, DaveEntry[]>();
  for (const entry of archive.entries) {
    if (entry.isDir) continue;
    const key = daveKey(entry.name);
    const list = map.get(key);
    if (list) list.push(entry); else map.set(key, [entry]);
  }
  return map;
}
