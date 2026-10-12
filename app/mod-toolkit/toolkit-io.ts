import { join } from "@tauri-apps/api/path";
import { open } from "@tauri-apps/plugin-dialog";
import { readDir, readFile, writeFile } from "@tauri-apps/plugin-fs";

/**
 * File handling shared by the Mod Toolkit's tools.
 *
 * The toolkit works on loose files chosen one at a time, not on a vehicle folder, so it keeps its
 * own opening model rather than reusing the Anchor/Mesh Editor's vehicle-set state. What it does
 * share is the editing rule: bytes read here live in memory, and `writeVerified` — the only thing
 * in this tab that writes — is reachable only from a tool's explicit Save.
 */

export type ToolkitFile = { path: string; name: string; bytes: Uint8Array };

export function basename(path: string) { return path.replace(/^.*[\\/]/, ""); }

/** The folder a file sits in. */
export function parentPath(path: string) {
  const parent = path.replace(/[\\/][^\\/]*$/, "");
  return parent === path ? "" : parent;
}

/** The name of the folder a file sits in — shown next to a filename so two files with the same
 *  name in different folders can be told apart at a glance, without printing the whole path. */
export function parentFolder(path: string) {
  const parent = parentPath(path);
  return parent ? basename(parent) || parent : "";
}

export function sizeLabel(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function sameBytes(a: Uint8Array, b: Uint8Array) { return a.length === b.length && a.every((value, index) => value === b[index]); }

export async function readToolkitFile(path: string): Promise<ToolkitFile> {
  return { path, name: basename(path), bytes: await readFile(path) };
}

export async function pickFiles(filters: { name: string; extensions: string[] }[], multiple = false, defaultPath?: string) {
  const selection = await open({ multiple, filters, defaultPath });
  if (selection === null) return [];
  return Array.isArray(selection) ? selection : [selection];
}

export const isMeshPckName = (path: string) => /\.mesh\.pck$/i.test(basename(path));

export const CAR_ROLES = [["player", "", "Player"], ["garage", "_g", "Garage"], ["opponent", "_o", "Opponent"]] as const;
export type CarRole = typeof CAR_ROLES[number][0];

/** Finds `<car>.pck`, `<car>_g.pck` and `<car>_o.pck` directly inside a folder. */
export async function findCarFiles(folder: string) {
  const names = (await readDir(folder)).filter((entry) => !entry.isDirectory && /\.pck$/i.test(entry.name) && !isMeshPckName(entry.name)).map((entry) => entry.name);
  const bases = new Set(names.map((name) => name.replace(/(_g|_o)?\.pck$/i, "")));
  const folderName = basename(folder).toLowerCase();
  const base = [...bases].find((item) => item.toLowerCase() === folderName) ?? (bases.size === 1 ? [...bases][0] : null);
  if (!base) throw new Error(`Couldn't tell which car this is: ${basename(folder)} holds ${bases.size ? [...bases].join(", ") : "no car PCK"}. Open the car's own folder.`);
  const found: { role: CarRole; label: string; path: string }[] = [];
  for (const [role, suffix, label] of CAR_ROLES) {
    const name = names.find((item) => item.toLowerCase() === `${base}${suffix}.pck`.toLowerCase());
    if (name) found.push({ role, label, path: await join(folder, name) });
  }
  return { base, found };
}

/** Every loose `*.mesh.pck` directly inside a folder, sorted by name — how the precedent scripts
 *  picked up their pieces, by scanning the folder the car PCK sits in. */
export async function listMeshPcks(folder: string) {
  const entries = await readDir(folder);
  const names = entries.filter((entry) => !entry.isDirectory && isMeshPckName(entry.name)).map((entry) => entry.name);
  names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return Promise.all(names.map((name) => join(folder, name)));
}

/**
 * Writes a file and proves it landed, the same way the vehicle set's Save does: read the file back
 * and compare byte for byte, throwing rather than letting a caller clear its "modified" state on a
 * write that didn't fully take. Callers overwrite the file they opened, so a failure here leaves
 * the tool still holding the edit.
 */
export async function writeVerified(path: string, bytes: Uint8Array) {
  await writeFile(path, bytes);
  const actual = await readFile(path);
  if (!sameBytes(bytes, actual)) {
    throw new Error(`${basename(path)} was written, but read-back verification failed. The tool kept its pending changes.`);
  }
  for (const listener of writeListeners) listener(path);
}

/**
 * Told about every file a loose-file tool writes. The vehicle set holds its PCKs and mesh.pck files
 * in memory, so a tool writing one of them behind its back would leave a stale copy that the set's
 * next Save writes straight over the tool's work — the page listens here and reloads that file.
 */
const writeListeners = new Set<(path: string) => void>();
export function onFileWritten(listener: (path: string) => void) {
  writeListeners.add(listener);
  return () => { writeListeners.delete(listener); };
}
