import { inflateRaw } from "./deflate";

/**
 * Minimal ZIP reader: lists members from the central directory and extracts stored (0) or
 * deflated (8) ones on demand. Enough for mod packages; ZIP64 and encrypted archives are refused.
 */

export type ZipMember = {
  path: string;
  size: number;
  isDir: boolean;
  read: () => Promise<Uint8Array>;
};

export function readZip(bytes: Uint8Array, label = "ZIP"): ZipMember[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let pos = bytes.length - 22; pos >= Math.max(0, bytes.length - 22 - 0xffff); pos--) {
    if (view.getUint32(pos, true) === 0x06054b50) { eocd = pos; break; }
  }
  if (eocd < 0) throw new Error(`${label} is not a ZIP file (no end-of-central-directory record).`);
  const count = view.getUint16(eocd + 10, true);
  let pos = view.getUint32(eocd + 16, true);
  if (count === 0xffff || pos === 0xffffffff) throw new Error(`${label} is a ZIP64 archive, which isn't supported.`);
  const members: ZipMember[] = [];
  for (let i = 0; i < count; i++) {
    if (view.getUint32(pos, true) !== 0x02014b50) throw new Error(`${label} has a damaged central directory.`);
    const flags = view.getUint16(pos + 8, true);
    const method = view.getUint16(pos + 10, true);
    const compressedSize = view.getUint32(pos + 20, true);
    const size = view.getUint32(pos + 24, true);
    const nameLength = view.getUint16(pos + 28, true);
    const extraLength = view.getUint16(pos + 30, true);
    const commentLength = view.getUint16(pos + 32, true);
    const local = view.getUint32(pos + 42, true);
    const rawName = bytes.subarray(pos + 46, pos + 46 + nameLength);
    const path = (flags & 0x800 ? new TextDecoder("utf-8") : new TextDecoder("latin1")).decode(rawName).replace(/\\/g, "/");
    pos += 46 + nameLength + extraLength + commentLength;
    const isDir = path.endsWith("/");
    members.push({
      path, size, isDir,
      read: async () => {
        if (flags & 1) throw new Error(`${path} in ${label} is encrypted.`);
        if (view.getUint32(local, true) !== 0x04034b50) throw new Error(`${path} in ${label} has a damaged local header.`);
        const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
        const data = bytes.subarray(start, start + compressedSize);
        const out = method === 0 ? data : method === 8 ? await inflateRaw(data) : null;
        if (!out) throw new Error(`${path} in ${label} uses an unsupported compression method (${method}).`);
        if (out.length !== size) throw new Error(`${path} in ${label} extracted to ${out.length} bytes, expected ${size}.`);
        return out;
      },
    });
  }
  return members;
}
