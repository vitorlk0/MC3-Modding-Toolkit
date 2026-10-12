import { deflateRaw } from "./deflate";

/**
 * Minimal ZIP writer — the counterpart of zip-read.ts, for packages the app hands back to the user
 * (Slot Retarget's converted mod). Each member is DEFLATE-compressed when that makes it smaller and
 * stored otherwise; no ZIP64, so the archive and every member stay under 4 GB.
 */

export type ZipInput = { path: string; bytes: Uint8Array };

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date: Date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((Math.max(1980, date.getFullYear()) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

export async function writeZip(members: ZipInput[], date = new Date()): Promise<Uint8Array> {
  const { time, day } = dosDateTime(date);
  const seen = new Set<string>();
  const prepared = [];
  for (const member of members) {
    const path = member.path.replace(/\\/g, "/").replace(/^\/+/, "");
    if (!path || path.endsWith("/")) throw new Error(`"${member.path}" is not a file name.`);
    if (seen.has(path.toLowerCase())) throw new Error(`${path} appears twice in the ZIP.`);
    seen.add(path.toLowerCase());
    const packed = await deflateRaw(member.bytes);
    const deflated = packed.length < member.bytes.length;
    const name = new TextEncoder().encode(path);
    prepared.push({ name, utf8: /[^\x20-\x7e]/.test(path), crc: crc32(member.bytes), size: member.bytes.length, data: deflated ? packed : member.bytes, method: deflated ? 8 : 0 });
  }
  const localSize = prepared.reduce((sum, item) => sum + 30 + item.name.length + item.data.length, 0);
  const centralSize = prepared.reduce((sum, item) => sum + 46 + item.name.length, 0);
  if (localSize + centralSize + 22 > 0xffffffff || prepared.length > 0xffff) throw new Error("The ZIP would need ZIP64, which isn't supported.");
  const out = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(out.buffer);
  let pos = 0;
  const offsets: number[] = [];
  for (const item of prepared) {
    offsets.push(pos);
    view.setUint32(pos, 0x04034b50, true);
    view.setUint16(pos + 4, 20, true);
    view.setUint16(pos + 6, item.utf8 ? 0x800 : 0, true);
    view.setUint16(pos + 8, item.method, true);
    view.setUint16(pos + 10, time, true);
    view.setUint16(pos + 12, day, true);
    view.setUint32(pos + 14, item.crc, true);
    view.setUint32(pos + 18, item.data.length, true);
    view.setUint32(pos + 22, item.size, true);
    view.setUint16(pos + 26, item.name.length, true);
    view.setUint16(pos + 28, 0, true);
    out.set(item.name, pos + 30);
    out.set(item.data, pos + 30 + item.name.length);
    pos += 30 + item.name.length + item.data.length;
  }
  const central = pos;
  prepared.forEach((item, i) => {
    view.setUint32(pos, 0x02014b50, true);
    view.setUint16(pos + 4, 20, true);
    view.setUint16(pos + 6, 20, true);
    view.setUint16(pos + 8, item.utf8 ? 0x800 : 0, true);
    view.setUint16(pos + 10, item.method, true);
    view.setUint16(pos + 12, time, true);
    view.setUint16(pos + 14, day, true);
    view.setUint32(pos + 16, item.crc, true);
    view.setUint32(pos + 20, item.data.length, true);
    view.setUint32(pos + 24, item.size, true);
    view.setUint16(pos + 28, item.name.length, true);
    view.setUint32(pos + 42, offsets[i], true);
    out.set(item.name, pos + 46);
    pos += 46 + item.name.length;
  });
  view.setUint32(pos, 0x06054b50, true);
  view.setUint16(pos + 8, prepared.length, true);
  view.setUint16(pos + 10, prepared.length, true);
  view.setUint32(pos + 12, pos - central, true);
  view.setUint32(pos + 16, central, true);
  return out;
}
