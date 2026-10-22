import { FlashMovie, KEEP_CHARACTER, rebuildFrames, setPlacedCharacter, type DisplayList, type FrameItem } from "./flash-sprites";

/**
 * The dealership art of a slot, built from art the game already has (Roadmap: memory note
 * "dealership art layers"; read from the original Remix toplevel.pck / garage.pck):
 *
 *   toplevel.pck sprite 319  purchase carousel icon; frame k+1 = ShowRoomNames[k]
 *   toplevel.pck sprite 380  Manage Vehicles icon (33 profiles); same layers, one frame later
 *     layers: brand logo (depth 1), type silhouette, class letter (A–D), "REMIX" badge
 *     (vp_d_* cars), and a statusA/statusB clip
 *   garage.pck sprite 512    garage bottom band; frame k+1 = VehicleNames[k], one sprite per car
 *                            (brand logo + brand name)
 *
 * Icon frames only list changes from the previous frame, so a slot's frame — and the next one,
 * which was built on top of it — are rebuilt as self-contained frames (src/flash-sprites.ts).
 * The band frame places its own sprite, so it is changed in place to another car's band.
 */

export const BUY_SPRITE = 319;
export const MANAGE_SPRITE = 380;
export const BAND_SPRITE = 512;
/** Sprites that draw the class letter, and the type silhouettes, by the value the dealership arrays use. */
export const LETTER_ART: Record<string, number> = { A: 296, B: 278, C: 248, D: 201 };
export const TYPE_ART: Record<number, number> = { 1: 198, 2: 224, 3: 230, 4: 263, 5: 287, 6: 302, 7: 233, 8: 316 };
const BIKE_POLICE = 313;
export const REMIX_BADGE = 204;
/** The brand each logo sprite of the original toplevel.pck shows (read off the bitmaps; vehicle.lst's
 *  Manufacturer is not reliable for this — the Cobalt's says Dodge under a Chevrolet logo). */
export const LOGO_BRANDS: Record<number, string> = {
  195: "Scion", 209: "Mitsubishi", 212: "Volkswagen", 215: "Dodge", 218: "Chevrolet", 221: "Lexus", 227: "Hummer",
  236: "Chrysler", 239: "Infiniti", 242: "Cadillac", 245: "Nissan", 251: "Toyota", 254: "Lotus", 257: "Pontiac",
  260: "Hot Match", 266: "West Coast Choppers", 269: "GMC", 272: "Mercedes-Benz", 281: "Saleen", 284: "Ducati",
  290: "Gemballa", 293: "Kawasaki", 299: "Aprilia", 305: "Lamborghini", 308: "McLaren", 311: "Pagani",
};
const STATUS_CLIP = 206;
/** Depths of a rebuilt icon, in drawing order. All are depths the original sprites use. */
const DEPTH = { logo: 1, silhouette: 3, letter: 5, remix: 8, status: 10 };

/** `letter` -1: no class letter (the police icons). */
export type IconArt = { logo: number; silhouette: number; letter: number; remix: boolean };
export type SlotArt = IconArt & {
  /** Showroom index of the car. */
  index: number;
  /** Why this slot's art can't be changed, or null. */
  problem: string | null;
};
export type LogoChoice = { character: number; cars: string[] };

const letterOf = (character: number) => Object.entries(LETTER_ART).find(([, art]) => art === character)?.[0] ?? null;
const isSilhouette = (character: number) => character === BIKE_POLICE || Object.values(TYPE_ART).includes(character);

/** Sorts a frame's layers into the icon's parts; null when something isn't recognised. */
function readIcon(list: DisplayList): (IconArt & { status: number | null }) | null {
  let logo = -1, silhouette = -1, letter = -1, remix = false, status: number | null = null;
  for (const [depth, layer] of list) {
    const c = layer.character;
    if (c === KEEP_CHARACTER) return null;
    if (depth === 1) logo = c;
    else if (letterOf(c)) letter = c;
    else if (isSilhouette(c)) silhouette = c;
    else if (c === REMIX_BADGE) remix = true;
    else if (c === STATUS_CLIP) status = layer.record;
    else return null;
  }
  // Police icons have no class letter (letter stays -1); every other icon has one.
  return logo < 0 || silhouette < 0 ? null : { logo, silhouette, letter, remix, status };
}

export class DealershipArt {
  readonly top: FlashMovie;
  readonly garage: FlashMovie;
  readonly showroom: string[];
  readonly garageNames: string[];
  private buy: DisplayList[];
  private manage: DisplayList[];

  constructor(top: Uint8Array, garage: Uint8Array, showroom: string[], garageNames: string[]) {
    this.top = new FlashMovie(top, "toplevel.pck");
    this.garage = new FlashMovie(garage, "garage.pck");
    this.showroom = showroom;
    this.garageNames = garageNames;
    this.buy = this.top.displayLists(BUY_SPRITE);
    this.manage = this.top.displayLists(MANAGE_SPRITE);
  }

  /** The art a car shows today. */
  slot(car: string): SlotArt {
    const index = this.showroom.indexOf(car);
    if (index < 0) throw new Error(`${car} isn't in the dealership list.`);
    const fail = (problem: string): SlotArt => ({ index, logo: -1, silhouette: -1, letter: -1, remix: false, problem });
    // The frames that get rebuilt: the car's and the next one, in both sprites.
    const frames = [this.buy[index], this.buy[index + 1], this.manage[index + 1], this.manage[index + 2]].filter(Boolean);
    if (frames.length < 4) return fail("its icon frames are at the end of the art sprites.");
    const icon = readIcon(this.buy[index]);
    const manage = readIcon(this.manage[index + 1]);
    if (!icon || !manage) return fail("its icon uses layers this tool doesn't recognise (the Mercedes and AMG icons).");
    if (manage.logo !== icon.logo || manage.letter !== icon.letter || manage.silhouette !== icon.silhouette || manage.remix !== icon.remix) return fail("its purchase and Manage Vehicles icons differ.");
    if (frames.some((list) => [...list.values()].some((layer) => layer.character === KEEP_CHARACTER))) return fail("a neighbouring icon keeps a layer from the frame before it (the Mercedes icons), which can't be rebuilt yet.");
    if (this.bandFrame(car) === null) return fail("it has no garage band frame.");
    return { index, logo: icon.logo, silhouette: icon.silhouette, letter: icon.letter, remix: icon.remix, problem: null };
  }

  /** Brand logos the cars' icons use, with the cars that use each. */
  logos(): LogoChoice[] {
    const byLogo = new Map<number, string[]>();
    this.showroom.forEach((car, index) => {
      const icon = this.buy[index] && readIcon(this.buy[index]);
      if (!icon) return;
      byLogo.set(icon.logo, [...(byLogo.get(icon.logo) ?? []), car]);
    });
    return [...byLogo].map(([character, cars]) => ({ character, cars }));
  }

  private bandFrame(car: string) {
    const index = this.garageNames.indexOf(car);
    if (index < 0 || index >= this.garage.sprite(BAND_SPRITE).frames) return null;
    return this.garage.frame(BAND_SPRITE, index).some((command) => command.type <= 1 && command.depth === 1) ? index : null;
  }

  /** The garage band sprite a car shows. */
  band(car: string) {
    const frame = this.bandFrame(car);
    return frame === null ? null : this.garage.frame(BAND_SPRITE, frame).find((command) => command.type <= 1 && command.depth === 1)!.character;
  }

  /** A record that places `character` in `sprite`, preferring one at `depth`. */
  private donor(lists: DisplayList[], character: number, depth: number) {
    let any: number | null = null;
    for (const list of lists) {
      for (const [d, layer] of list) {
        if (layer.character !== character) continue;
        if (d === depth) return layer.record;
        any ??= layer.record;
      }
    }
    if (any === null) throw new Error(`No icon in toplevel.pck places character ${character}.`);
    return any;
  }

  /**
   * toplevel.pck with the icons of `edits` rebuilt (run on the file the dealership arrays were
   * already rewritten in — no record moves there), and the garage.pck band edits.
   */
  apply(top: Uint8Array, edits: { car: string; art: IconArt }[]) {
    const movie = new FlashMovie(top, "toplevel.pck");
    const buy = movie.displayLists(BUY_SPRITE);
    const manage = movie.displayLists(MANAGE_SPRITE);
    type Frame = { sprite: number; frame: number; items: FrameItem[] };
    const frames = new Map<string, Frame>();
    const original = (sprite: number, lists: DisplayList[], frame: number): Frame => ({
      sprite, frame, items: [...lists[frame]].sort(([a], [b]) => a - b).map(([depth, layer]) => ({ record: layer.record, depth, character: layer.character })),
    });
    for (const { car, art } of edits) {
      const now = this.slot(car);
      if (now.problem) throw new Error(`${car}'s dealership icon can't be changed: ${now.problem}`);
      for (const [sprite, lists, frame] of [[BUY_SPRITE, buy, now.index], [MANAGE_SPRITE, manage, now.index + 1]] as const) {
        const status = readIcon(lists[frame])?.status ?? null;
        const items: FrameItem[] = [
          { record: this.donor(lists, art.logo, DEPTH.logo), depth: DEPTH.logo },
          { record: this.donor(lists, art.silhouette, DEPTH.silhouette), depth: DEPTH.silhouette },
          ...(art.letter >= 0 ? [{ record: this.donor(lists, art.letter, DEPTH.letter), depth: DEPTH.letter }] : []),
          ...(art.remix ? [{ record: this.donor(lists, REMIX_BADGE, DEPTH.remix), depth: DEPTH.remix }] : []),
          ...(status !== null ? [{ record: status, depth: DEPTH.status }] : []),
        ];
        frames.set(`${sprite}:${frame}`, { sprite, frame, items });
        // The next frame was built on top of this one: make it stand on its own, unless it is edited too.
        const next = `${sprite}:${frame + 1}`;
        if (!frames.has(next)) frames.set(next, original(sprite, lists, frame + 1));
      }
    }
    // A car's own frame always wins over the "next frame" copy its neighbour queued: frames.set
    // above overwrites, and a queued copy never replaces an edited frame.
    const out = rebuildFrames(movie, [...frames.values()]);

    // Prove it: only the rebuilt frames show something different, and each shows what was asked.
    const check = new FlashMovie(out, "toplevel.pck");
    const text = (pairs: [number, number][]) => pairs.map(([depth, character]) => `${depth}:${character}`).sort().join(" ");
    for (const [sprite, before] of [[BUY_SPRITE, buy], [MANAGE_SPRITE, manage]] as const) {
      const after = check.displayLists(sprite);
      before.forEach((list, frame) => {
        const want = frames.get(`${sprite}:${frame}`);
        const expected = want
          ? text(want.items.map((item) => [item.depth!, item.character ?? characterAt(movie, item.record)]))
          : text([...list].map(([depth, layer]) => [depth, layer.character]));
        const got = text([...after[frame]].map(([depth, layer]) => [depth, layer.character]));
        if (got !== expected) throw new Error(`toplevel.pck: frame ${frame + 1} of sprite ${sprite} came out as [${got}], expected [${expected}].`);
      });
    }
    return out;
  }

  /** garage.pck with each car's bottom band set to the band of a car that uses `logo`. */
  applyBands(garage: Uint8Array, edits: { car: string; logo: number }[]) {
    let bytes = garage;
    for (const { car, logo } of edits) {
      const frame = this.bandFrame(car);
      if (frame === null) throw new Error(`${car} has no garage band frame.`);
      const donor = this.showroom.find((other, index) => readIcon(this.buy[index])?.logo === logo && this.band(other) !== null);
      if (!donor) throw new Error(`No car with that logo has a garage band to copy.`);
      bytes = setPlacedCharacter(new FlashMovie(bytes, "garage.pck"), BAND_SPRITE, frame, 1, this.band(donor)!);
    }
    return bytes;
  }
}

function characterAt(movie: FlashMovie, record: number) {
  return movie.bytes[record + 14] | (movie.bytes[record + 15] << 8);
}
