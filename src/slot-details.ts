import { runFlashArrays, scalarText, type AvmScalar, type FlashArrays } from "./avm1-run";
import { rewriteFlashArrays } from "./avm1-append";
import { readEntry } from "./dave";
import type { IsoSession, ModFile } from "./iso-install";
import { readStrtbl, setStrtblText, strtblText, writeStrtbl } from "./strtbl";

/**
 * Slot details — what the game shows for a slot, edited at install time: its name and short name
 * (the `<slot>` and `<slot>_short` keys of the 8 string tables) and its dealership card (the
 * parallel ShowRoom* arrays of flash/toplevel.pck, modding KB §20.8). These are global files every
 * car shares, so the edits of every car in an install are applied together, to the ISO's own copy,
 * in one rewrite of each file.
 *
 * The dealership fields change what the dealership SHOWS. Not changed here: the real class and
 * group (vehicle.lst), the unlock (unlockingrules.csv), the logo (the art frame tables). Whether the
 * price charged on purchase follows ShowRoomPrice is not known yet.
 */

export const STRING_TABLES = ["01", "02", "04", "08"].flatMap((n) => [`fonts/mcstrings${n}.strtbl`, `fonts/mcstrings${n}_pal.strtbl`]);
const TOPLEVEL = "flash/toplevel.pck";

/** ShowroomClass values and the vehicle.lst class of the original cars that carry each one (1 and 6
 *  were confirmed in game as "Tuners" and "Exotics"; the rest follow the class). */
export const SHOWROOM_TYPES: { value: number; label: string }[] = [
  { value: 1, label: "Tuner" }, { value: 2, label: "Muscle" }, { value: 3, label: "SUV" }, { value: 4, label: "Chopper" },
  { value: 5, label: "Sport bike" }, { value: 6, label: "Exotic" }, { value: 7, label: "Luxury" }, { value: 8, label: "Police" },
];
/** The class letter the dealership shows is ShowroomPerf, the vehicle.lst Group inverted (A→d … D→a). */
export const SHOWROOM_LETTERS = ["A", "B", "C", "D"];

export const NAME_MAX = 21;
export const SHORT_NAME_MAX = 12;

export type SlotDetails = {
  name: string;
  shortName: string;
  /** Dollars, as the dealership shows them. */
  price: number;
  /** Class letter as shown: A–D. */
  letter: string;
  showroomType: number;
};
export type SlotDetailsEdit = Partial<SlotDetails>;
export const DETAIL_KEYS: (keyof SlotDetails)[] = ["name", "shortName", "price", "letter", "showroomType"];

const SHOWROOM_ARRAYS: Record<"price" | "letter" | "showroomType", string> = {
  price: "ShowRoomPrice", letter: "ShowroomPerf", showroomType: "ShowroomClass",
};

const parsePrice = (text: string) => Number(text.replace(/[$,\s]/g, ""));
const formatPrice = (value: number) => `$${value.toFixed(2)}`;

/** Why a value can't be written, or null. */
export function detailProblem(key: keyof SlotDetails, value: string | number): string | null {
  if (key === "name" || key === "shortName") {
    const text = String(value);
    const max = key === "name" ? NAME_MAX : SHORT_NAME_MAX;
    if (!text.trim()) return "Can't be empty.";
    if (text.length > max) return `At most ${max} characters.`;
    if (!/^[\x20-\x7e]*$/.test(text)) return "Letters, digits, spaces and plain punctuation only — the game's fonts may not have other characters.";
    return null;
  }
  const number = Number(value);
  if (key === "price") return Number.isInteger(number) && number >= 0 && number <= 9_999_999 ? null : "A whole number of dollars, up to 9,999,999.";
  if (key === "letter") return SHOWROOM_LETTERS.includes(String(value)) ? null : "A, B, C or D.";
  return SHOWROOM_TYPES.some((type) => type.value === number) ? null : "Not a dealership type.";
}

/** The ISO's global files, read once and reused for every slot. */
export type SlotDetailsSource = {
  details(slot: string): Promise<SlotDetails>;
  /** The shared files that carry `edits`, built from the ISO's own copies. Files no edit touches are
   *  left out; an edit that changes nothing writes nothing (the plan reads them as unchanged). */
  sharedFiles(edits: { slot: string; edit: SlotDetailsEdit }[]): ModFile[];
};

export function openSlotDetails(session: IsoSession): SlotDetailsSource {
  const raw = new Map<string, Promise<Uint8Array>>();
  const asset = (path: string) => {
    let pending = raw.get(path);
    if (!pending) {
      const entry = session.byName.get(path)?.[0];
      pending = entry ? readEntry(session.archive, entry) : Promise.reject(new Error(`${path} is not in this ISO's ASSETS.DAT.`));
      pending.catch(() => raw.delete(path));
      raw.set(path, pending);
    }
    return pending;
  };
  let showroom: Promise<FlashArrays> | null = null;
  const arrays = () => (showroom ??= asset(TOPLEVEL).then((bytes) => runFlashArrays(bytes, "toplevel.pck")));
  // Names come from the US English table everyone sees first; the others hold the same keys.
  let names: Promise<ReturnType<typeof readStrtbl>> | null = null;
  const table = () => (names ??= asset("fonts/mcstrings08.strtbl").then((bytes) => readStrtbl(bytes, "mcstrings08.strtbl")));

  const showroomIndex = (top: FlashArrays, slot: string) => {
    const index = (top.get("ShowRoomNames") ?? []).findIndex((item) => item.kind === "string" && item.value.toLowerCase() === slot);
    if (index < 0) throw new Error(`${slot} isn't in the dealership list of toplevel.pck.`);
    for (const name of Object.values(SHOWROOM_ARRAYS)) if ((top.get(name)?.length ?? 0) <= index) throw new Error(`toplevel.pck's ${name} is shorter than its car list.`);
    return index;
  };

  return {
    async details(slot) {
      const [top, strings] = [await arrays(), await table()];
      const index = showroomIndex(top, slot);
      const at = (key: keyof typeof SHOWROOM_ARRAYS) => scalarText(top.get(SHOWROOM_ARRAYS[key])![index]);
      return {
        name: strtblText(strings, slot)[0] ?? "",
        shortName: strtblText(strings, `${slot}_short`)[0] ?? "",
        price: parsePrice(at("price")),
        letter: at("letter").toUpperCase(),
        showroomType: Number(at("showroomType")),
      };
    },

    sharedFiles(edits) {
      const files: ModFile[] = [];
      const named = edits.filter(({ edit }) => edit.name !== undefined || edit.shortName !== undefined);
      for (const path of named.length ? STRING_TABLES : []) {
        if (!session.byName.has(path)) continue;
        let built: Promise<Uint8Array> | null = null;
        files.push({
          category: "shared", name: path.replace(/^.*\//, ""), sourcePath: path, target: path, size: 0,
          read: () => (built ??= asset(path).then((bytes) => {
            const strings = readStrtbl(bytes, path);
            for (const { slot, edit } of named) {
              if (edit.name !== undefined) setStrtblText(strings, slot, edit.name);
              if (edit.shortName !== undefined) setStrtblText(strings, `${slot}_short`, edit.shortName);
            }
            const out = writeStrtbl(strings);
            // Prove it: each edited key reads back, and nothing else changed.
            const check = readStrtbl(out, path);
            const before = readStrtbl(bytes, path);
            for (const key of before.keys) {
              const edit = named.find(({ slot }) => key === slot || key === `${slot}_short`);
              const want = edit ? (key === edit.slot ? edit.edit.name : edit.edit.shortName) : undefined;
              const old = strtblText(before, key), now = strtblText(check, key);
              const expected = want === undefined ? old : old.map((text) => text === null ? null : want);
              if (JSON.stringify(now) !== JSON.stringify(expected)) throw new Error(`${path}: ${key} didn't come out as expected.`);
            }
            return out;
          })),
        });
      }
      const dealer = edits.filter(({ edit }) => (Object.keys(SHOWROOM_ARRAYS) as (keyof typeof SHOWROOM_ARRAYS)[]).some((key) => edit[key] !== undefined));
      if (dealer.length) {
        let built: Promise<Uint8Array> | null = null;
        files.push({
          category: "shared", name: "toplevel.pck", sourcePath: TOPLEVEL, target: TOPLEVEL, size: 0,
          read: () => (built ??= (async () => {
            const bytes = await asset(TOPLEVEL);
            const top = runFlashArrays(bytes, "toplevel.pck");
            const changed = new Map<string, AvmScalar[]>();
            for (const { slot, edit } of dealer) {
              const index = showroomIndex(top, slot);
              for (const [key, array] of Object.entries(SHOWROOM_ARRAYS) as [keyof typeof SHOWROOM_ARRAYS, string][]) {
                const value = edit[key];
                if (value === undefined) continue;
                const items = changed.get(array) ?? [...top.get(array)!];
                const old = items[index];
                // Keep each array's own AVM1 type: ShowroomClass is an int, the rest are strings.
                const text = key === "price" ? formatPrice(Number(value)) : key === "letter" ? String(value).toLowerCase() : String(value);
                items[index] = old.kind === "int" ? { kind: "int", value: Number(value) } : { kind: "string", value: text };
                changed.set(array, items);
              }
            }
            // Arrays whose items all came out the same are not redefined.
            const arraysToWrite = [...changed].filter(([name, items]) => items.some((item, i) => scalarText(item) !== scalarText(top.get(name)![i]) || item.kind !== top.get(name)![i].kind));
            return arraysToWrite.length ? rewriteFlashArrays(bytes, arraysToWrite, "toplevel.pck").bytes : bytes;
          })()),
        });
      }
      return files;
    },
  };
}
