import { open, readDir, readFile, remove, rename, SeekMode, stat, writeFile } from "@tauri-apps/plugin-fs";
import { invoke } from "@tauri-apps/api/core";
import { join } from "@tauri-apps/api/path";
import type { IsoFileSystem, PackageFile, RandomFile } from "../src/iso-install";
import { readZip } from "../src/zip-read";

/**
 * Tauri-side file access for the ISO Install tab. A disc image is several GB, so it is never read
 * whole: reads are a seek + read on a plugin-fs FileHandle, writes go through `write_at`. A handle
 * has a single cursor, so operations on one file are queued and never interleave.
 */

/** Raw-body write at an offset through the app's own `write_at` command (src-tauri/src/lib.rs):
 *  FileHandle.write would send the bytes as a JSON number array. */
const writeAt = (path: string, offset: number, bytes: Uint8Array) =>
  invoke("write_at", bytes, { headers: { path: encodeURIComponent(path), offset: String(offset) } });

async function tauriFile(path: string, options: Parameters<typeof open>[1]): Promise<RandomFile> {
  if (options?.create) await writeFile(path, new Uint8Array(0));
  const handle = await open(path, { read: true });
  let size = (await handle.stat()).size;
  let queue: Promise<unknown> = Promise.resolve();
  const run = <T,>(task: () => Promise<T>) => {
    const next = queue.then(task);
    queue = next.catch(() => undefined);
    return next;
  };
  return {
    get size() { return size; },
    read: (offset, length) => run(async () => {
      await handle.seek(offset, SeekMode.Start);
      const out = new Uint8Array(length);
      let got = 0;
      while (got < length) {
        const count = await handle.read(out.subarray(got));
        if (!count) throw new Error(`Unexpected end of file at 0x${(offset + got).toString(16)}.`);
        got += count;
      }
      return out;
    }),
    write: (offset, bytes) => run(async () => {
      await writeAt(path, offset, bytes);
      size = Math.max(size, offset + bytes.length);
    }),
    close: () => run(() => handle.close()),
  };
}

/** Opens the ISO for writing without writing anything (an empty `write_at`), so a file that another
 *  program holds — PCSX2 while the game runs — is caught before the user confirms the install. */
export const checkWritable = (path: string) => writeAt(path, 0, new Uint8Array(0));

/** Windows' "file in use" and "access denied" errors, reworded for the ISO Install tab. Anything else
 *  is returned unchanged. */
export function explainIsoError(message: string) {
  if (/os error 32|being used by another process/i.test(message)) return "The ISO is open in another program — most likely PCSX2. Close the game (or PCSX2) and press Install again.";
  if (/os error 5|access is denied/i.test(message)) return "Windows refused to write the ISO (access denied). Check that the file isn't read-only and that the folder can be written.";
  return message;
}

export const tauriIsoFs: IsoFileSystem = {
  openRead: (path) => tauriFile(path, { read: true }),
  openWrite: (path) => tauriFile(path, { read: true }),
  create: (path) => tauriFile(path, { read: true, create: true }),
  replace: (from, to) => rename(from, to),
  remove: (path) => remove(path),
};

export const isZipPath = (path: string) => /\.zip$/i.test(path);

/** Every file of a ZIP, or of a folder and its subfolders, as a package the detector can sort. */
export async function readPackageFiles(path: string): Promise<PackageFile[]> {
  if (isZipPath(path)) {
    return readZip(await readFile(path), path.replace(/^.*[\\/]/, "")).filter((member) => !member.isDir);
  }
  const info = await stat(path);
  if (!info.isDirectory) throw new Error("Choose a .zip file or a folder.");
  const files: PackageFile[] = [];
  const walk = async (folder: string, prefix: string) => {
    for (const entry of await readDir(folder)) {
      const full = await join(folder, entry.name);
      if (entry.isDirectory) await walk(full, `${prefix}${entry.name}/`);
      else if (entry.isFile) files.push({ path: `${prefix}${entry.name}`, size: 0, read: () => readFile(full) });
    }
  };
  await walk(path, "");
  return files;
}
