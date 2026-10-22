import { flashFileOffset, runFlashArrays, scalarText, type AvmScalar, type FlashArrays } from "./avm1-run";
import { rewriteFlashArrays } from "./avm1-append";
import { readEntry } from "./dave";
import type { IsoSession, ModFile } from "./iso-install";
import { readStrtbl, setStrtblText, strtblText, writeStrtbl } from "./strtbl";
import { DealershipArt, LETTER_ART, LOGO_BRANDS, TYPE_ART, type IconArt } from "./dealership-art";

/**
 * Slot details — what the game shows for a slot, edited at install time: its name and short name
 * (the `<slot>` and `<slot>_short` keys of the 8 string tables) and its dealership card (the
 * parallel ShowRoom* arrays of flash/toplevel.pck, modding KB §20.8). These are global files every
 * car shares, so the edits of every car in an install are applied together, to the ISO's own copy,
 * in one rewrite of each file.
 *
 * The dealership fields change what the dealership SHOWS, text and icon: the class letter and type
 * also redraw the car's icon, and the brand logo and REMIX badge are icon layers taken from other
 * cars (src/dealership-art.ts; the logo also sets the garage's bottom band). Not changed here: the
 * group (vehicle.lst) and the unlock (unlockingrules.csv). The shown price was confirmed in game;
 * whether the purchase charges it was not checked.
 *
 * The real class is the slot's `Class` in tune/vehicle/vehicle.lst. It picks the special ability —
 * read from the Remix ELF (mc::CarDescription::CanUseInTheZone / CanUseAgro / CanUseRoar at
 * 0x4B2080 / 0x4B20D0 / 0x4B2128, laid out as in the alpha's MC.MAP):
 *   Zone  CULTURE, PERFORMANCE, SPORTBIKE — and any slot with ForceITZ (SC430, SL500, SL55)
 *   Agro  SUV, LUXURY, COPCAR (unless ForceITZ)
 *   Roar  MUSCLE, CHOPPER
 * and also what else the game ties to the class (SUV, bike and police behaviour, which events
 * take the car). A car never becomes a bike or the other way round.
 */

export const STRING_TABLES = ["01", "02", "04", "08"].flatMap((n) => [`fonts/mcstrings${n}.strtbl`, `fonts/mcstrings${n}_pal.strtbl`]);
const TOPLEVEL = "flash/toplevel.pck";
const VEHICLE_LIST = "tune/vehicle/vehicle.lst";
const GARAGE = "flash/garage.pck";
/** garage.pck's frame script that builds _global.VehicleNames (modding KB §20.9). */
const GARAGE_NAMES_SCRIPT = 0x181c;

/** ShowroomClass values and the vehicle.lst class of the original cars that carry each one (1 and 6
 *  were confirmed in game as "Tuners" and "Exotics"; the rest follow the class). */
export const SHOWROOM_TYPES: { value: number; label: string }[] = [
  { value: 1, label: "Tuner" }, { value: 2, label: "Muscle" }, { value: 3, label: "SUV" }, { value: 4, label: "Chopper" },
  { value: 5, label: "Sport bike" }, { value: 6, label: "Exotic" }, { value: 7, label: "Luxury" }, { value: 8, label: "Police" },
];
/** The class letter the dealership shows is ShowroomPerf, the vehicle.lst Group inverted (A→d … D→a). */
export const SHOWROOM_LETTERS = ["A", "B", "C", "D"];

export type CarClass = { value: string; label: string; ability: "Zone" | "Agro" | "Roar"; bike: boolean };
/** Real classes a slot can take; police classes are left out. */
export const CAR_CLASSES: CarClass[] = [
  { value: "CULTURE", label: "Tuner", ability: "Zone", bike: false },
  { value: "PERFORMANCE", label: "Exotic", ability: "Zone", bike: false },
  { value: "MUSCLE", label: "Muscle", ability: "Roar", bike: false },
  { value: "SUV", label: "SUV", ability: "Agro", bike: false },
  { value: "LUXURY", label: "Luxury", ability: "Agro", bike: false },
  { value: "SPORTBIKE", label: "Sport bike", ability: "Zone", bike: true },
  { value: "CHOPPER", label: "Chopper", ability: "Roar", bike: true },
];
const BIKE_CLASS = /^(CHOPPER|SPORTBIKE|COPBIKE)$/;

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
  /** Brand logo of the icon (a sprite of toplevel.pck); -1 when the icon can't be changed. */
  logo: number;
  /** The icon's "REMIX" badge. */
  remix: boolean;
  /** vehicle.lst Class: the special ability and the rest of the slot's class behaviour. */
  carClass: string;
};
export type SlotDetailsEdit = Partial<SlotDetails>;
export const DETAIL_KEYS: (keyof SlotDetails)[] = ["name", "shortName", "price", "letter", "showroomType", "logo", "remix", "carClass"];
/** A brand logo to choose, named after the cars that show it. */
export type LogoOption = { character: number; label: string };

const SHOWROOM_ARRAYS: Record<"price" | "letter" | "showroomType", string> = {
  price: "ShowRoomPrice", letter: "ShowroomPerf", showroomType: "ShowroomClass",
};

const parsePrice = (text: string) => Number(text.replace(/[$,\s]/g, ""));
const formatPrice = (value: number) => `$${value.toFixed(2)}`;

/** Why a value can't be written, or null. */
export function detailProblem(key: keyof SlotDetails, value: string | number | boolean): string | null {
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
  if (key === "carClass") return CAR_CLASSES.some((item) => item.value === value) ? null : "Not a class a slot can take.";
  if (key === "logo") return Number.isInteger(number) && number > 0 ? null : "Not a brand logo.";
  if (key === "remix") return typeof value === "boolean" || value === "true" || value === "false" ? null : "On or off.";
  return SHOWROOM_TYPES.some((type) => type.value === number) ? null : "Not a dealership type.";
}

/** The ISO's global files, read once and reused for every slot. */
export type SlotDetailsSource = {
  details(slot: string): Promise<SlotDetails & { artProblem: string | null; forceZone: boolean }>;
  logos(): Promise<LogoOption[]>;
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

  let dealership: Promise<DealershipArt> | null = null;
  const art = () => (dealership ??= (async () => {
    const [top, garage, shown] = [await asset(TOPLEVEL), await asset(GARAGE), await arrays()];
    const pointer = garage[GARAGE_NAMES_SCRIPT] | (garage[GARAGE_NAMES_SCRIPT + 1] << 8) | (garage[GARAGE_NAMES_SCRIPT + 2] << 16) | (garage[GARAGE_NAMES_SCRIPT + 3] << 24);
    const garageNames = runFlashArrays(garage, "garage.pck", flashFileOffset(garage, pointer >>> 0)).get("VehicleNames");
    if (!garageNames) throw new Error("garage.pck has no VehicleNames list.");
    return new DealershipArt(top, garage, shown.get("ShowRoomNames")!.map(scalarText), garageNames.map(scalarText));
  })());
  /** The text of vehicle.lst and the extent of each car's Vehicle block in it. */
  let vehicles: Promise<{ text: string; blocks: Map<string, { start: number; end: number }> }> | null = null;
  const vehicleList = () => (vehicles ??= asset(VEHICLE_LIST).then((bytes) => {
    let text = "";
    for (const byte of bytes) text += String.fromCharCode(byte);
    const blocks = new Map<string, { start: number; end: number }>();
    for (const match of text.matchAll(/\bVehicle\s*\{[^{}]*?\bName\s+(\S+)[\s\S]*?\n\}/g)) {
      blocks.set(match[1].toLowerCase(), { start: match.index!, end: match.index! + match[0].length });
    }
    return { text, blocks };
  }));
  const classOf = (text: string, block: { start: number; end: number }) => /\bClass\s+(\S+)/.exec(text.slice(block.start, block.end))?.[1] ?? "";
  let manufacturers: Promise<Map<string, string>> | null = null;
  const makes = () => (manufacturers ??= asset("tune/vehicle/vehicle.lst").then((bytes) => {
    let text = "";
    for (const byte of bytes) text += String.fromCharCode(byte);
    const out = new Map<string, string>();
    for (const block of text.split(/\bVehicle\s*\{/).slice(1)) {
      const name = /\bName\s+(\S+)/.exec(block)?.[1], make = /\bManufacturer\s+(\S+)/.exec(block)?.[1];
      if (name && make) out.set(name.toLowerCase(), make);
    }
    return out;
  }));
  /** The icon a slot gets from an edit; null when the edit doesn't touch it or the slot can't change. */
  const iconFor = async (slot: string, edit: SlotDetailsEdit): Promise<IconArt | null> => {
    if (edit.letter === undefined && edit.showroomType === undefined && edit.logo === undefined && edit.remix === undefined) return null;
    const now = (await art()).slot(slot);
    if (now.problem) return null;
    const next: IconArt = {
      logo: edit.logo ?? now.logo,
      letter: edit.letter !== undefined ? LETTER_ART[edit.letter] : now.letter,
      silhouette: edit.showroomType !== undefined ? TYPE_ART[edit.showroomType] : now.silhouette,
      remix: edit.remix ?? now.remix,
    };
    return next.logo === now.logo && next.letter === now.letter && next.silhouette === now.silhouette && next.remix === now.remix ? null : next;
  };

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
      let icon: { logo: number; remix: boolean; problem: string | null };
      try { icon = (await art()).slot(slot); }
      catch (caught) { icon = { logo: -1, remix: false, problem: caught instanceof Error ? caught.message : String(caught) }; }
      const list = await vehicleList();
      const block = list.blocks.get(slot);
      const blockText = block ? list.text.slice(block.start, block.end) : "";
      return {
        carClass: block ? classOf(list.text, block) : "",
        forceZone: /\bForceITZ\b/.test(blockText),
        logo: icon.problem ? -1 : icon.logo, remix: icon.remix, artProblem: icon.problem,
        name: strtblText(strings, slot)[0] ?? "",
        shortName: strtblText(strings, `${slot}_short`)[0] ?? "",
        price: parsePrice(at("price")),
        letter: at("letter").toUpperCase(),
        showroomType: Number(at("showroomType")),
      };
    },

    async logos() {
      const [choices, made, strings] = [(await art()).logos(), await makes(), await table()];
      return choices.map(({ character, cars }) => {
        const make = LOGO_BRANDS[character] ?? made.get(cars[0]) ?? "?";
        const examples = cars.slice(0, 2).map((car) => (strtblText(strings, `${car}_short`)[0] ?? car).trim()).join(", ");
        return { character, label: `${make} — ${examples}${cars.length > 2 ? "…" : ""}` };
      }).sort((a, b) => a.label.localeCompare(b.label));
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
      const dealer = edits.filter(({ edit }) => (["price", "letter", "showroomType", "logo", "remix"] as const).some((key) => edit[key] !== undefined));
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
            const withArrays = arraysToWrite.length ? rewriteFlashArrays(bytes, arraysToWrite, "toplevel.pck").bytes : bytes;
            // Then the icons, rebuilt on that file (the array rewrite moves no frame record).
            const icons = (await Promise.all(dealer.map(async ({ slot, edit }) => ({ car: slot, art: await iconFor(slot, edit) }))))
              .filter((item): item is { car: string; art: IconArt } => item.art !== null);
            return icons.length ? (await art()).apply(withArrays, icons) : withArrays;
          })()),
        });
      }
      const classed = edits.filter(({ edit }) => edit.carClass !== undefined);
      if (classed.length) {
        let built: Promise<Uint8Array> | null = null;
        files.push({
          category: "shared", name: "vehicle.lst", sourcePath: VEHICLE_LIST, target: VEHICLE_LIST, size: 0,
          read: () => (built ??= (async () => {
            const { text, blocks } = await vehicleList();
            // Rewrite block by block from the end, so earlier offsets stay valid.
            const changes = classed.map(({ slot, edit }) => {
              const block = blocks.get(slot);
              if (!block) throw new Error(`${slot} has no Vehicle block in vehicle.lst.`);
              const old = classOf(text, block);
              if (BIKE_CLASS.test(old) !== BIKE_CLASS.test(edit.carClass!)) throw new Error(`${slot} is a ${old} — a car's class can't become a bike's, nor the other way round.`);
              return { slot, block, value: edit.carClass! };
            }).sort((a, b) => b.block.start - a.block.start);
            let out = text;
            for (const { block, value } of changes) {
              const body = out.slice(block.start, block.end).replace(/(\bClass\s+)\S+/, `$1${value}`);
              out = out.slice(0, block.start) + body + out.slice(block.end);
            }
            // Prove it: every Vehicle block reads back with the same name and class, except the edited ones.
            const after = [...out.matchAll(/\bVehicle\s*\{[^{}]*?\bName\s+(\S+)[\s\S]*?\n\}/g)];
            if (after.length !== blocks.size) throw new Error("vehicle.lst lost a Vehicle block.");
            for (const match of after) {
              const name = match[1].toLowerCase();
              const want = changes.find((item) => item.slot === name)?.value ?? classOf(text, blocks.get(name)!);
              if (/\bClass\s+(\S+)/.exec(match[0])?.[1] !== want) throw new Error(`vehicle.lst: ${name} didn't come out with class ${want}.`);
            }
            if (out.replace(/\bClass\s+\S+/g, "") !== text.replace(/\bClass\s+\S+/g, "")) throw new Error("vehicle.lst changed outside the Class lines.");
            return Uint8Array.from(out, (char) => char.charCodeAt(0));
          })()),
        });
      }
      const branded = edits.filter(({ edit }) => edit.logo !== undefined);
      if (branded.length && session.byName.has(GARAGE)) {
        let built: Promise<Uint8Array> | null = null;
        files.push({
          category: "shared", name: "garage.pck", sourcePath: GARAGE, target: GARAGE, size: 0,
          read: () => (built ??= (async () => {
            const dealership = await art();
            const bands = branded.filter(({ slot }) => !dealership.slot(slot).problem).map(({ slot, edit }) => ({ car: slot, logo: edit.logo! }));
            return dealership.applyBands(await asset(GARAGE), bands);
          })()),
        });
      }
      return files;
    },
  };
}
