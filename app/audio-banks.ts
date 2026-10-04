import { exists, readDir, readFile } from "@tauri-apps/plugin-fs";
import { BankSamples } from "../src/bnk";

/**
 * Finding and loading a logical bank (E_350Z → e_350z.bnk + e_350z.td) for the audio preview, with
 * the Audio Curve GUI's rules: exact names, case-insensitive; folders searched in order — the
 * configured banks folder, the PCK's own folder, then `<ASSETS>/audio/banks` above the PCK (where
 * the game keeps both); and a .td that isn't beside any .bnk is looked for up to two levels down.
 */

const BANKS_FOLDER_KEY = "mc3pae.audio.banksFolder";
export function loadBanksFolder() { try { return localStorage.getItem(BANKS_FOLDER_KEY) ?? ""; } catch { return ""; } }
export function saveBanksFolder(folder: string) { try { if (folder) localStorage.setItem(BANKS_FOLDER_KEY, folder); else localStorage.removeItem(BANKS_FOLDER_KEY); } catch { /* storage unavailable */ } }

const join = (dir: string, name: string) => `${dir.replace(/[\\/]+$/, "")}\\${name}`;
const parentOf = (path: string) => path.replace(/[\\/][^\\/]*$/, "");
/** The folders to search for `pckPath`'s banks, in order, without duplicates. */
export function bankDirs(configured: string, pckPath: string | null) {
  const dirs: string[] = [];
  if (configured.trim()) dirs.push(configured.trim());
  if (pckPath) {
    const folder = parentOf(pckPath); dirs.push(folder);
    const parts = folder.split(/[\\/]/);
    const assets = parts.map((p) => p.toLowerCase()).lastIndexOf("assets");
    if (assets >= 0) dirs.push([...parts.slice(0, assets + 1), "audio", "banks"].join("\\"));
  }
  const seen = new Set<string>();
  return dirs.map((dir) => dir.replace(/\//g, "\\").replace(/\\+$/, "")).filter((dir) => { const key = dir.toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; });
}

const listings = new Map<string, Promise<{ name: string; isDirectory: boolean }[]>>();
const list = (dir: string) => {
  let entries = listings.get(dir);
  if (!entries) { entries = readDir(dir).then((items) => items.map((i) => ({ name: i.name, isDirectory: i.isDirectory }))).catch(() => []); listings.set(dir, entries); }
  return entries;
};
export function forgetBankListings() { listings.clear(); }

export async function findBankFiles(bankName: string, dirs: string[]) {
  const logical = bankName.trim(); if (!logical) return { bnk: null, td: null };
  const wantBnk = `${logical.toLowerCase()}.bnk`; const wantTd = `${logical.toLowerCase()}.td`;
  let bnk: string | null = null; let td: string | null = null;
  const valid: string[] = [];
  for (const dir of dirs) {
    if (!(await exists(dir).catch(() => false))) continue;
    valid.push(dir);
    for (const entry of await list(dir)) {
      if (entry.isDirectory) continue;
      const lower = entry.name.toLowerCase();
      if (lower === wantBnk && !bnk) bnk = join(dir, entry.name);
      else if (lower === wantTd && !td) td = join(dir, entry.name);
    }
    if (bnk && td) return { bnk, td };
  }
  if (!td) {
    // Asset dumps sometimes keep the .td sidecars in a small child folder.
    const walk = async (dir: string, depth: number): Promise<string | null> => {
      const entries = await list(dir);
      for (const entry of entries) if (!entry.isDirectory && entry.name.toLowerCase() === wantTd) return join(dir, entry.name);
      if (depth >= 2) return null;
      for (const entry of entries) if (entry.isDirectory) { const found = await walk(join(dir, entry.name), depth + 1); if (found) return found; }
      return null;
    };
    for (const dir of valid) { td = await walk(dir, 0); if (td) break; }
  }
  return { bnk, td };
}

export type LoadedBank = { name: string; bnk: string; td: string | null; bank: BankSamples };
const banks = new Map<string, Promise<LoadedBank | { name: string; error: string }>>();
export function forgetBanks() { banks.clear(); forgetBankListings(); }
/** A bank by logical name, loaded once per search folders — a missing bank is an error value, not a throw. */
export function loadBank(bankName: string, dirs: string[]) {
  const key = `${bankName.toUpperCase()}|${dirs.join("|").toLowerCase()}`;
  let entry = banks.get(key);
  if (!entry) {
    entry = (async () => {
      const { bnk, td } = await findBankFiles(bankName, dirs);
      if (!bnk) return { name: bankName, error: `${bankName}.bnk wasn't found in ${dirs.length ? dirs.join(" · ") : "any folder"}.` };
      try {
        const tdText = td ? new TextDecoder("latin1").decode(await readFile(td)) : null;
        return { name: bankName, bnk, td, bank: new BankSamples(await readFile(bnk), tdText) };
      } catch (caught) { return { name: bankName, error: `${bnk}: ${caught instanceof Error ? caught.message : "could not be read."}` }; }
    })();
    banks.set(key, entry);
  }
  return entry;
}
