/**
 * Read-only ISO9660 walker for PS2 disc images.
 *
 * Only what the ISO Install tab needs: every file and directory with its extent (LBA + size) and the
 * absolute offset of the directory record that describes it, so a record can be patched in place.
 * Reads go through a `ByteReader`, so a multi-GB image is never loaded into memory.
 *
 * Mirrors the walker in the MC3 ISO Direct Explorer script (ISO9660Image): the primary volume
 * descriptor is searched from LBA 16, names lose their `;1` version suffix, and a zero record
 * length skips to the next 2048-byte sector.
 */

export const SECTOR = 2048;

export interface ByteReader {
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

export type IsoEntry = {
  name: string;
  path: string;
  lba: number;
  size: number;
  isDir: boolean;
  flags: number;
  /** Absolute file offset of this entry's record in its parent directory. */
  recordOffset: number;
  children: IsoEntry[];
};

export type VolumeDescriptor = { lba: number; type: number; id: string };

export type IsoImage = {
  volumeId: string;
  /** PVD "volume space size", in sectors (both-endian field at PVD+80). */
  volumeBlocks: number;
  pvdLba: number;
  root: IsoEntry;
  /** Every descriptor of the volume recognition area (CD001, BEA01, NSR02, TEA01, …). */
  descriptors: VolumeDescriptor[];
  entries: IsoEntry[];
};

const u32 = (bytes: Uint8Array, offset: number) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);

function recordName(raw: Uint8Array) {
  if (raw.length === 1 && raw[0] === 0) return ".";
  if (raw.length === 1 && raw[0] === 1) return "..";
  let name = String.fromCharCode(...raw);
  const semicolon = name.indexOf(";");
  if (semicolon >= 0) name = name.slice(0, semicolon);
  return name.replace(/\.+$/, "");
}

export async function readIso(reader: ByteReader): Promise<IsoImage> {
  const descriptors: VolumeDescriptor[] = [];
  let pvd: Uint8Array | null = null;
  let pvdLba = -1;
  for (let lba = 16; lba < 64 && (lba + 1) * SECTOR <= reader.size; lba++) {
    const block = await reader.read(lba * SECTOR, SECTOR);
    const id = String.fromCharCode(...block.subarray(1, 6));
    if (!/^(CD001|BEA01|NSR0[23]|TEA01|BOOT2|CDW02)$/.test(id)) break;
    descriptors.push({ lba, type: block[0], id });
    if (id === "CD001" && block[0] === 1 && !pvd) { pvd = block; pvdLba = lba; }
  }
  if (!pvd) throw new Error("This is not an ISO9660 image: no primary volume descriptor (CD001) was found.");
  const volumeId = String.fromCharCode(...pvd.subarray(40, 72)).trim();
  const volumeBlocks = u32(pvd, 80);
  const rootRecord = pvd.subarray(156, 156 + pvd[156]);
  const root: IsoEntry = { name: "", path: "/", lba: u32(rootRecord, 2), size: u32(rootRecord, 10), isDir: true, flags: 2, recordOffset: pvdLba * SECTOR + 156, children: [] };
  const entries: IsoEntry[] = [];
  const visited = new Set<number>();

  const walk = async (dir: IsoEntry) => {
    if (visited.has(dir.lba)) return;
    visited.add(dir.lba);
    const data = await reader.read(dir.lba * SECTOR, dir.size);
    let pos = 0;
    while (pos < data.length) {
      const length = data[pos];
      if (length === 0) { pos = (Math.floor(pos / SECTOR) + 1) * SECTOR; continue; }
      if (length < 34 || pos + length > data.length) throw new Error(`Malformed ISO9660 directory record in ${dir.path}.`);
      const record = data.subarray(pos, pos + length);
      const name = recordName(record.subarray(33, 33 + record[32]));
      if (name !== "." && name !== "..") {
        const flags = record[25];
        const entry: IsoEntry = {
          name, path: dir.path === "/" ? `/${name}` : `${dir.path}/${name}`,
          lba: u32(record, 2), size: u32(record, 10), isDir: (flags & 2) !== 0, flags,
          recordOffset: dir.lba * SECTOR + pos, children: [],
        };
        dir.children.push(entry);
        entries.push(entry);
        if (entry.isDir) await walk(entry);
      }
      pos += length;
    }
  };
  await walk(root);
  return { volumeId, volumeBlocks, pvdLba, root, descriptors, entries };
}

/** Both-endian u32 as ISO9660 stores it: little-endian then big-endian. */
export function bothEndian32(value: number) {
  const out = new Uint8Array(8);
  const view = new DataView(out.buffer);
  view.setUint32(0, value, true);
  view.setUint32(4, value, false);
  return out;
}

/** A reader over bytes already in memory — for DAVE archives that come out of a ZIP. */
export function memoryReader(bytes: Uint8Array): ByteReader {
  return {
    size: bytes.length,
    read: async (offset, length) => {
      if (offset < 0 || length < 0 || offset + length > bytes.length) throw new Error("Read outside the in-memory file.");
      return bytes.subarray(offset, offset + length);
    },
  };
}

/** A window onto part of another reader — ASSETS.DAT inside the ISO. */
export function sliceReader(base: ByteReader, start: number, size: number): ByteReader {
  return {
    size,
    read: (offset, length) => {
      if (offset < 0 || length < 0 || offset + length > size) return Promise.reject(new Error("Read outside the archive."));
      return base.read(start + offset, length);
    },
  };
}
