import { SECTOR, bothEndian32, readIso, type ByteReader } from "./iso9660";
import { DAT_BYTE_LIMIT, type IsoFileSystem, type Progress } from "./iso-install";

/**
 * Compact ISO — rewrites a PS2 disc image as one tightly packed ISO9660 volume.
 *
 * An original MC3 disc image is a dual-layer DVD: layer 0 holds one ISO9660 volume (the game, its
 * DATs), layer 1 holds a second, separate volume (the VIDEO folder) whose sector numbers count from
 * the start of layer 1, and both layers are padded with ~2.9 GB of zeros so the files sit at chosen
 * places on the physical disc. The game finds files by name, so that placement doesn't matter to an
 * emulator or to OPL — it only costs space, and it pins ASSETS.DAT between other files.
 *
 * The compacted image keeps every file byte for byte and every directory record (names, dates,
 * flags) as the original wrote them, and copies the original system area (sectors 0-15) and primary
 * volume descriptor fields. What changes: the two volumes become one tree, there is no padding and
 * no UDF bridge, and the files are ordered for modding:
 *   ASSETS.DAT first, then a reserve of zeros for it to grow into (installs only write there),
 *   then the other layer-0 files, then the layer-1 videos.
 * Every .DAT must end below 4 GiB. A first version put ASSETS.DAT last (4.0-5.5 GB) and the game
 * froze on a black screen while every ImgBurn layout with ASSETS.DAT low on the disc ran — the
 * engine evidently addresses DAT contents with 32-bit byte offsets (inference from that test; the
 * original disc also keeps all of layer 0 under 4 GiB). Videos are streamed by sector and already
 * sit past 4 GiB in the working ImgBurn images, so they go last.
 */


type SourceNode = {
  /** Directory record as the source wrote it. */
  record: Uint8Array;
  identifier: string;
  path: string;
  isDir: boolean;
  /** Absolute source sector of the extent. */
  sourceLba: number;
  size: number;
  volume: number;
  /** For directories: the source "." and ".." records, and the children. */
  self?: Uint8Array;
  parent?: Uint8Array;
  children?: SourceNode[];
};

export type CompactAnalysis = {
  volumes: { lbaBase: number; volumeId: string; files: number }[];
  root: SourceNode;
  files: SourceNode[];
  directories: SourceNode[];
  sourceSize: number;
  dataBytes: number;
  pvd: Uint8Array;
  terminator: Uint8Array;
  systemArea: Uint8Array;
  notes: string[];
};

const u32 = (bytes: Uint8Array, offset: number) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
const alignUp = (value: number) => Math.ceil(value / SECTOR) * SECTOR;

function identifierOf(record: Uint8Array) {
  return String.fromCharCode(...record.subarray(33, 33 + record[32]));
}

/** ISO9660 §9.3 ordering: name then extension, each padded with spaces, then version descending. */
function compareIdentifiers(a: string, b: string) {
  const split = (id: string) => {
    const [base, version = "0"] = id.split(";");
    const dot = base.indexOf(".");
    return { name: dot < 0 ? base : base.slice(0, dot), ext: dot < 0 ? "" : base.slice(dot + 1), version: Number(version) || 0 };
  };
  const pad = (x: string, y: string) => { const n = Math.max(x.length, y.length); return [x.padEnd(n, " "), y.padEnd(n, " ")]; };
  const sa = split(a), sb = split(b);
  const [na, nb] = pad(sa.name, sb.name);
  if (na !== nb) return na < nb ? -1 : 1;
  const [ea, eb] = pad(sa.ext, sb.ext);
  if (ea !== eb) return ea < eb ? -1 : 1;
  return sb.version - sa.version;
}

async function readVolume(reader: ByteReader, pvd: Uint8Array, lbaBase: number, volume: number): Promise<SourceNode> {
  const rootRecord = pvd.slice(156, 156 + pvd[156]);
  const root: SourceNode = { record: rootRecord, identifier: "", path: "/", isDir: true, sourceLba: lbaBase + u32(rootRecord, 2), size: u32(rootRecord, 10), volume };
  const visited = new Set<number>();
  const walk = async (dir: SourceNode) => {
    if (visited.has(dir.sourceLba)) throw new Error(`The directory tree loops at ${dir.path}.`);
    visited.add(dir.sourceLba);
    const data = await reader.read(dir.sourceLba * SECTOR, dir.size);
    dir.children = [];
    let pos = 0;
    while (pos < data.length) {
      const length = data[pos];
      if (length === 0) { pos = (Math.floor(pos / SECTOR) + 1) * SECTOR; continue; }
      if (length < 34 || pos + length > data.length) throw new Error(`Malformed directory record in ${dir.path}.`);
      const record = data.slice(pos, pos + length);
      pos += length;
      if (record[32] === 1 && record[33] === 0) { dir.self = record; continue; }
      if (record[32] === 1 && record[33] === 1) { dir.parent = record; continue; }
      if (record[25] & 0x80) throw new Error(`${dir.path} has a multi-extent file, which this tool doesn't handle.`);
      const identifier = identifierOf(record);
      const isDir = (record[25] & 2) !== 0;
      const name = identifier.replace(/;\d+$/, "");
      const child: SourceNode = { record, identifier, path: dir.path === "/" ? `/${name}` : `${dir.path}/${name}`, isDir, sourceLba: lbaBase + u32(record, 2), size: u32(record, 10), volume };
      dir.children.push(child);
      if (isDir) await walk(child);
    }
  };
  await walk(root);
  return root;
}

/** Merges the second layer's tree into the first: folders of the same name merge, files must not clash. */
function mergeInto(target: SourceNode, source: SourceNode) {
  for (const child of source.children ?? []) {
    const existing = target.children!.find((node) => node.identifier === child.identifier);
    if (!existing) { target.children!.push(child); continue; }
    if (existing.isDir && child.isDir) { mergeInto(existing, child); continue; }
    throw new Error(`${child.path} exists on both layers; this image can't be merged safely.`);
  }
}

export async function analyzeForCompaction(reader: ByteReader): Promise<CompactAnalysis> {
  const iso = await readIso(reader);
  const pvd = await reader.read(iso.pvdLba * SECTOR, SECTOR);
  const terminatorInfo = iso.descriptors.find((d) => d.id === "CD001" && d.type === 255);
  const terminator = terminatorInfo ? await reader.read(terminatorInfo.lba * SECTOR, SECTOR) : null;
  const systemArea = await reader.read(0, 16 * SECTOR);
  const notes: string[] = [];
  const volumes: CompactAnalysis["volumes"] = [];

  const root = await readVolume(reader, pvd, 0, 0);
  volumes.push({ lbaBase: 0, volumeId: iso.volumeId, files: 0 });

  // A dual-layer PS2 image repeats a primary volume descriptor at the first sector past layer 0's
  // volume; that second volume's sector numbers count from 16 sectors earlier (the start of layer 1).
  const layer0End = iso.volumeBlocks * SECTOR;
  if (reader.size > layer0End + 1024 * 1024) {
    const second = await reader.read(layer0End, SECTOR);
    if (second[0] === 1 && String.fromCharCode(...second.subarray(1, 6)) === "CD001") {
      const lbaBase = iso.volumeBlocks - 16;
      const layer1 = await readVolume(reader, second, lbaBase, 1);
      mergeInto(root, layer1);
      volumes.push({ lbaBase, volumeId: String.fromCharCode(...second.subarray(40, 72)).trim(), files: 0 });
      notes.push(`Dual-layer image: the second layer's volume (sector ${lbaBase} on) is merged into the first.`);
    } else {
      notes.push(`${((reader.size - layer0End) / (1024 * 1024)).toFixed(0)} MB past the ISO9660 volume aren't described by any volume and are dropped.`);
    }
  }

  const files: SourceNode[] = [];
  const directories: SourceNode[] = [];
  const collect = (dir: SourceNode) => {
    directories.push(dir);
    dir.children!.sort((a, b) => compareIdentifiers(a.identifier, b.identifier));
    for (const child of dir.children!) if (!child.isDir) files.push(child);
    for (const child of dir.children!) if (child.isDir) collect(child);
  };
  collect(root);
  for (const file of files) volumes[file.volume].files++;
  for (const file of files) {
    if (file.size > 0 && file.sourceLba * SECTOR + file.size > reader.size) throw new Error(`${file.path} points past the end of the image.`);
  }
  if (!terminator) notes.push("No volume descriptor terminator was found; a standard one is written.");
  return { volumes, root, files, directories, sourceSize: reader.size, dataBytes: files.reduce((sum, file) => sum + file.size, 0), pvd, terminator: terminator ?? standardTerminator(), systemArea, notes };
}

function standardTerminator() {
  const out = new Uint8Array(SECTOR);
  out[0] = 255; out.set([0x43, 0x44, 0x30, 0x30, 0x31], 1); out[6] = 1;
  return out;
}

// ---------------------------------------------------------------------------------------------
// Layout

export type CompactLayout = {
  /** Everything before the first file: system area, descriptors, path tables, directories. */
  header: Uint8Array;
  /** New sector of every file, in write order. */
  placements: { node: SourceNode; lba: number }[];
  totalSectors: number;
  outputSize: number;
  /** Zero bytes kept right after ASSETS.DAT. */
  reserveBytes: number;
};

function breadthFirst(root: SourceNode) {
  const order: SourceNode[] = [root];
  for (let i = 0; i < order.length; i++) for (const child of order[i].children!) if (child.isDir) order.push(child);
  return order;
}

function patchRecord(record: Uint8Array, lba: number, size: number) {
  const out = record.slice();
  out.set(bothEndian32(lba), 2);
  out.set(bothEndian32(size), 10);
  return out;
}

/**
 * A directory's records laid into sectors (a record never straddles a sector boundary), plus the
 * length its records say it has: the byte just past the last record, NOT rounded up to the sector.
 * That is what the original disc and ImgBurn write (root = 732 / 630 bytes), and it matters:
 * PCSX2 treats an image whose root directory length is exactly 2048 as a CD, and with the disc
 * typed as a CD the PS2's own cdvd driver failed to open SLUS_213.55 — a black screen at boot.
 */
function directoryBytes(records: Uint8Array[]) {
  let length = 0;
  for (const record of records) {
    if ((length % SECTOR) + record.length > SECTOR) length = alignUp(length);
    length += record.length;
  }
  const bytes = new Uint8Array(alignUp(length));
  let pos = 0;
  for (const record of records) {
    if ((pos % SECTOR) + record.length > SECTOR) pos = alignUp(pos);
    bytes.set(record, pos);
    pos += record.length;
  }
  return { bytes, length };
}

function pathTable(dirs: SourceNode[], numbers: Map<SourceNode, number>, lbas: Map<SourceNode, number>, parents: Map<SourceNode, SourceNode>, littleEndian: boolean) {
  const parts: number[] = [];
  for (const dir of dirs) {
    const id = dir === dirs[0] ? [0] : [...dir.identifier].map((c) => c.charCodeAt(0));
    const entry = new Uint8Array(8 + id.length + (id.length % 2));
    const view = new DataView(entry.buffer);
    entry[0] = id.length;
    view.setUint32(2, lbas.get(dir)!, littleEndian);
    view.setUint16(6, numbers.get(parents.get(dir) ?? dir)!, littleEndian);
    entry.set(id, 8);
    parts.push(...entry);
  }
  return new Uint8Array(parts);
}

/** Default free space kept after ASSETS.DAT for mods to grow into — ~4 MB per car, so room for
 *  about 120 cars before an install has to move the files behind it. */
export const DEFAULT_RESERVE = 512 * 1024 * 1024;

export function layoutCompactImage(analysis: CompactAnalysis, reserveBytes = DEFAULT_RESERVE): CompactLayout {
  const dirs = breadthFirst(analysis.root);
  const parents = new Map<SourceNode, SourceNode>();
  for (const dir of dirs) for (const child of dir.children!) if (child.isDir) parents.set(child, dir);
  const numbers = new Map(dirs.map((dir, index) => [dir, index + 1]));

  // Directory sizes don't depend on where things go (records keep their lengths), so size them first.
  const dirSize = new Map<SourceNode, number>();
  for (const dir of dirs) {
    const records = [dir.self ?? dir.record, dir.parent ?? dir.record, ...dir.children!.map((child) => child.record)];
    dirSize.set(dir, directoryBytes(records).length);
    if (dir === analysis.root && dirSize.get(dir) === SECTOR) throw new Error("The root directory fills exactly one sector, which PCSX2 would take for a CD image.");
  }
  // Path table size, measured with placeholder sector numbers.
  const placeholder = new Map(dirs.map((dir) => [dir, 0]));
  const tableSize = pathTable(dirs, numbers, placeholder, parents, true).length;
  const tableSectors = alignUp(tableSize) / SECTOR;

  // The original disc and ImgBurn both start the ISO9660 structures at sector 257 (18-256 hold the UDF
  // bridge there); kept the same here.
  const lTableLba = 257;
  const mTableLba = lTableLba + tableSectors;
  let cursor = mTableLba + tableSectors;
  const dirLba = new Map<SourceNode, number>();
  for (const dir of dirs) { dirLba.set(dir, cursor); cursor += alignUp(dirSize.get(dir)!) / SECTOR; }

  // Files: ASSETS.DAT first with its reserve behind it, then the rest in original order (layer 0 by
  // sector, then layer 1 — the videos, which may cross 4 GiB).
  const isAssets = (node: SourceNode) => node.path.toUpperCase() === "/ASSETS.DAT";
  const ordered = [...analysis.files].sort((a, b) => Number(isAssets(b)) - Number(isAssets(a)) || a.volume - b.volume || a.sourceLba - b.sourceLba);
  const fileLba = new Map<SourceNode, number>();
  const placements: CompactLayout["placements"] = [];
  const reserveSectors = alignUp(reserveBytes) / SECTOR;
  for (const node of ordered) {
    fileLba.set(node, cursor);
    placements.push({ node, lba: cursor });
    cursor += alignUp(node.size) / SECTOR;
    if (isAssets(node)) cursor += reserveSectors;
  }
  for (const { node, lba } of placements) {
    if (/\.DAT$/i.test(node.path) && lba * SECTOR + node.size > DAT_BYTE_LIMIT) {
      throw new Error(`${node.path} would end past 4 GB on the disc, which the game can't read. Choose a smaller reserve.`);
    }
  }
  const totalSectors = cursor;

  // Header bytes: system area, PVD, terminator, path tables, directories.
  const firstFile = placements.length ? placements[0].lba : totalSectors;
  const header = new Uint8Array(firstFile * SECTOR);
  header.set(analysis.systemArea, 0);
  const pvd = analysis.pvd.slice();
  const rootLba = dirLba.get(analysis.root)!, rootSize = dirSize.get(analysis.root)!;
  pvd.set(bothEndian32(totalSectors), 80);
  pvd.set(bothEndian32(tableSize), 132);
  const pvdView = new DataView(pvd.buffer);
  pvdView.setUint32(140, lTableLba, true);
  pvdView.setUint32(144, 0, true);
  pvdView.setUint32(148, mTableLba, false);
  pvdView.setUint32(152, 0, false);
  pvd.set(patchRecord(analysis.pvd.subarray(156, 156 + analysis.pvd[156]), rootLba, rootSize), 156);
  header.set(pvd, 16 * SECTOR);
  header.set(analysis.terminator, 17 * SECTOR);
  header.set(pathTable(dirs, numbers, dirLba, parents, true), lTableLba * SECTOR);
  header.set(pathTable(dirs, numbers, dirLba, parents, false), mTableLba * SECTOR);
  for (const dir of dirs) {
    const parent = parents.get(dir) ?? dir;
    const records = [
      patchRecord(dir.self ?? dir.record, dirLba.get(dir)!, dirSize.get(dir)!),
      patchRecord(dir.parent ?? dir.record, dirLba.get(parent)!, dirSize.get(parent)!),
      ...dir.children!.map((child) => child.isDir ? patchRecord(child.record, dirLba.get(child)!, dirSize.get(child)!) : patchRecord(child.record, fileLba.get(child)!, child.size)),
    ];
    header.set(directoryBytes(records).bytes, dirLba.get(dir)! * SECTOR);
  }
  return { header, placements, totalSectors, outputSize: totalSectors * SECTOR, reserveBytes: reserveSectors * SECTOR };
}

// ---------------------------------------------------------------------------------------------
// Writing

const CHUNK = 16 * 1024 * 1024;
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((value, index) => value === b[index]);
const digest = async (bytes: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));

/**
 * Writes the compacted image to `targetPath` (never over the source), proves every copied byte by
 * reading it back, then re-reads the new image's tree and checks every file against the source.
 */
export async function writeCompactImage(fs: IsoFileSystem, sourcePath: string, targetPath: string, analysis: CompactAnalysis, layout: CompactLayout, progress: Progress = () => undefined) {
  if (sourcePath.replace(/\//g, "\\").toLowerCase() === targetPath.replace(/\//g, "\\").toLowerCase()) throw new Error("Choose a different file for the compacted ISO — the original is kept as it is.");
  const source = await fs.openRead(sourcePath);
  const target = await fs.create(targetPath);
  try {
    const hashes: { at: number; length: number; hash: Uint8Array }[] = [];
    const total = layout.header.length + analysis.dataBytes;
    let done = 0;
    await target.write(0, layout.header);
    hashes.push({ at: 0, length: layout.header.length, hash: await digest(layout.header) });
    done += layout.header.length;
    for (const { node, lba } of layout.placements) {
      const padded = alignUp(node.size);
      for (let pos = 0; pos < padded; pos += CHUNK) {
        const length = Math.min(CHUNK, padded - pos);
        const real = Math.max(0, Math.min(length, node.size - pos));
        const chunk = new Uint8Array(length);
        if (real) chunk.set(await source.read(node.sourceLba * SECTOR + pos, real));
        await target.write(lba * SECTOR + pos, chunk);
        hashes.push({ at: lba * SECTOR + pos, length, hash: await digest(chunk) });
        done += real;
        progress("Writing the compact ISO", done, total);
      }
      if (node.path.toUpperCase() === "/ASSETS.DAT" && layout.reserveBytes) {
        // The reserve is written out as zeros (not left as a hole) so it is verified like the rest.
        const start = lba * SECTOR + padded;
        const zeros = new Uint8Array(Math.min(CHUNK, layout.reserveBytes));
        const zeroHash = await digest(zeros);
        for (let pos = 0; pos < layout.reserveBytes; pos += CHUNK) {
          const length = Math.min(CHUNK, layout.reserveBytes - pos);
          const chunk = length === zeros.length ? zeros : zeros.subarray(0, length);
          await target.write(start + pos, chunk);
          hashes.push({ at: start + pos, length, hash: length === zeros.length ? zeroHash : await digest(chunk) });
        }
      }
    }
    await source.close();
    if (target.size !== layout.outputSize) throw new Error(`The new image is ${target.size} bytes, expected ${layout.outputSize}.`);
    done = 0;
    for (const chunk of hashes) {
      if (!sameBytes(await digest(await target.read(chunk.at, chunk.length)), chunk.hash)) throw new Error(`The new image is corrupt near offset 0x${chunk.at.toString(16)}.`);
      done += chunk.length;
      progress("Verifying", done, layout.outputSize);
    }
    // The written tree must list exactly the source files, at the planned sectors, with their sizes.
    const written = await readIso(target);
    const byPath = new Map(written.entries.filter((entry) => !entry.isDir).map((entry) => [entry.path, entry]));
    if (byPath.size !== layout.placements.length) throw new Error(`The new image lists ${byPath.size} files, expected ${layout.placements.length}.`);
    for (const { node, lba } of layout.placements) {
      const entry = byPath.get(node.path);
      if (!entry || entry.lba !== lba || entry.size !== node.size) throw new Error(`${node.path} is wrong in the new image's directory.`);
    }
    await target.close();
  } catch (caught) {
    await source.close().catch(() => undefined);
    await target.close().catch(() => undefined);
    await fs.remove(targetPath).catch(() => undefined);
    throw caught;
  }
}
