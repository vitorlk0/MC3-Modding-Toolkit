import type { AvmScalar } from "./avm1-run";
import { SLOT_REFERENCE_DATA } from "./slot-reference-data";

/**
 * What Slot Retarget knows about the original MC3 DUB Edition Remix — the game every retargeted mod
 * is converted for. Extracted once, read-only, from the original disc image by
 * `scripts/extract-slot-reference.ts` into `slot-reference-data.ts`; regenerate rather than edit.
 *
 * The catalogues (rims, exhaust tips, plates, paint categories, menu text keys) are global game
 * files the tool never changes: a mod's menus are cut down to what they hold. Per slot, it keeps
 * what a retarget has to restore from the slot being replaced: its `.carcfg` profile name (the save
 * identity), its stock rim and exhaust, and its own paint-category arrays.
 */

export type SlotStock = { token: string; brand: string };
export type SlotReference = {
  name: string;
  /** Position in vehicle.lst — the car's index in the game and the save. */
  index: number;
  className: string;
  /** Entries in the player PCK's TBL_Wheels: 4 for cars, 2 for bikes. */
  wheels: number;
  /** ProfileName1..13 of the slot's .carcfg. */
  profile: number[];
  rimMdlIdx: number | null;
  exhaustRear: number | null;
  stockRim: SlotStock | null;
  stockExhaust: SlotStock | null;
  /** LicencePlatesStyleNames of the slot's ds_; absent when equal to the catalogue default. */
  plates?: string[];
  /** The slot's ps_ paint-category arrays (PAINT_ARRAYS); absent when equal to the default. */
  paint?: PaintArrays;
  /** Which of the slot's four menu flash files exist. */
  flash: { ds: boolean; ms: boolean; ps: boolean; vs: boolean };
};
export type PaintArrays = Record<string, AvmScalar[]>;
export type SlotReferenceData = {
  source: string;
  rims: string[];
  namedRims: number;
  exhausts: string[];
  plates: string[];
  paint: PaintArrays;
  stringKeys: string[];
  slots: SlotReference[];
  /** Class of slots that exist only in the VIP (vehicle.lst of VIP v1.0.2), for the source check. */
  vipClasses: Record<string, string>;
};

/** A slot as a picker lists it, before its own data is read. `menus`: it has a vs_ menu. */
export type SlotListing = { name: string; index: number; className: string; menus: boolean };

/**
 * The game a mod is converted for: its catalogues and its slots. Tools 11 uses the original game
 * (ORIGINAL_CATALOG, embedded); ISO Install uses the opened ISO (src/slot-reference-iso.ts), which
 * reads a slot's own data only when it is asked for.
 */
export type SlotCatalog = {
  /** What the report calls this game: "the original game" or "this ISO". */
  where: string;
  rims: string[];
  namedRims: number;
  exhausts: string[];
  stringKeys: string[];
  /** Plates and paint arrays for a slot that has no ds_ / ps_ of its own. */
  plates: string[];
  paint: PaintArrays;
  listing: SlotListing[];
  slot: (name: string) => Promise<SlotReference | null>;
};

/** Paint arrays restored from the target slot, in the order the approved test wrote them. */
export const PAINT_ARRAYS = ["UpgradeTypesNames", "UpgradeTypesStatus", "UpgradeTypesPrice", "ColorUpgradeOrder"];

/**
 * Slot names compared by name in the code of SLUS_213.55_EDITED.ELF (HANDOFF-SLOT-RETARGET.md §8).
 * What each comparison controls was not identified, so a retarget to or from one of these is
 * flagged rather than refused.
 */
export const ELF_NAMED_SLOTS: { where: string; slots: string[] }[] = [
  { where: "garage list at 0x3342E8", slots: "vp_gto_68 vp_montecarlo_78 vp_z28_81 vp_elcamino_70 vp_delegance_03 vp_monster_sr4_04 vp_jetta_03 vp_d_lux_05 vp_350z_04 vp_saleen_sr_00 vp_charger_99 vp_aprilia_mille_04 vp_cuevito_99 vp_skully_01 vp_gto_70 vp_h2_03 vp_hummer_02 vp_corvette_68 vp_belair_57 vp_fleetline_49 vp_ducati_999r_04 vp_ducati_ss1000_04 vp_ninja_03 vp_srt4_04 vp_ram_04 vp_silverado_ss_04 vp_corvettez06_03 vp_golfr32_04 vp_eclipse_04 vp_lancer_04 vp_supra_98 vp_skyline_02 vp_wcc_cfl_03 vp_wcc_eldiablo_st_00".split(" ") },
  { where: "AMG/GT750 check at 0x32F1BC", slots: ["vp_cl55_amg_04", "vp_sl55_amg_04", "vp_g55_amg_03", "vp_d_cls55_05", "vp_d_gt750_04"] },
  { where: "SLR check at 0x2F6CB0", slots: ["vp_slr_mclaren_04"] },
  { where: "police checks at 0x3D9DE0", slots: ["vp_impalass_cop_s_96", "vp_impalass_cop_a_96", "vp_impalass_cop_d_96", "vp_d_tokyo_cop_01"] },
  { where: "default string next to \"blank\"", slots: ["vp_eclipse_04"] },
];

export const SLOT_REFERENCE: SlotReferenceData = SLOT_REFERENCE_DATA;

const bySlot = new Map(SLOT_REFERENCE.slots.map((slot) => [slot.name, slot]));
export const referenceSlot = (name: string) => bySlot.get(name.toLowerCase()) ?? null;

export const ORIGINAL_CATALOG: SlotCatalog = {
  where: "the original game",
  rims: SLOT_REFERENCE.rims, namedRims: SLOT_REFERENCE.namedRims, exhausts: SLOT_REFERENCE.exhausts, stringKeys: SLOT_REFERENCE.stringKeys,
  plates: SLOT_REFERENCE.plates, paint: SLOT_REFERENCE.paint,
  listing: SLOT_REFERENCE.slots.map(({ name, index, className, flash }) => ({ name, index, className, menus: flash.vs })),
  slot: async (name) => referenceSlot(name),
};

export const slotPlates = (slot: SlotReference, catalog: SlotCatalog = ORIGINAL_CATALOG) => slot.plates ?? catalog.plates;
export const slotPaint = (slot: SlotReference, catalog: SlotCatalog = ORIGINAL_CATALOG) => slot.paint ?? catalog.paint;
export const elfMentions = (name: string) => ELF_NAMED_SLOTS.filter((list) => list.slots.includes(name.toLowerCase())).map((list) => list.where);
/** A vehicle.lst class as the game's menus name it: CULTURE is the Tuner class. Display only;
 *  comparisons keep using the raw name. */
export const classLabel = (className: string) => className === "CULTURE" ? "TUNER" : className;
/** vehicle.lst classes of the motorbikes (KB §26.2). */
export const BIKE_CLASSES = new Set(["CHOPPER", "SPORTBIKE", "COPBIKE"]);
/** The class a slot has in vanilla, or in the VIP for slots only the VIP has; null when unknown. */
export const knownClass = (name: string) => referenceSlot(name)?.className ?? SLOT_REFERENCE.vipClasses[name.toLowerCase()] ?? null;
