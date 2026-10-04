import type { PckDocument } from "./pck";

/**
 * Which part variants a car actually carries, read from its garage `_g.pck`.
 *
 * A `.carcfg` part field (`FrontBumperIdx 6`) is a position inside one of the car's part
 * categories. The categories live in the anchor tree: each is an anchor whose children are the
 * variants, in index order, and every variant's meshes are named `vroot_<path>_<variant>_…` in the
 * HLOD table (`vroot_bumf_bumf8_bmx_uad156_…`, or `vroot_tk_splr_splr12_…` one level deeper).
 * Across the 95 `_g.pck` files in the reference set, the HLOD order of those meshes matched the
 * anchor order in every group, so the anchor order is taken as the index.
 *
 * A variant counts as in use when at least one of its meshes is embedded in the `_g.pck`. The
 * opponent PCKs ship with every slot's name but no meshes (loaded from loose files), so an index
 * whose variant was never put in the car resolves to nothing and the part simply doesn't draw.
 *
 * This only reads what `PckDocument` already parsed — the anchor tree and the LOD tables. It
 * walks no table and reads no byte of its own.
 */

export type PartVariant = { index: number; anchor: string; meshes: string[]; embedded: boolean };
export type PartGroup = {
  /** Anchor path below vroot, joined the way the mesh names join it: `bumf`, `tk_splr`. */
  path: string;
  variants: PartVariant[];
};

/** Every anchor whose children all own HLOD meshes, found top-down: a group's own variants are
 *  not searched for nested groups, so each mesh belongs to exactly one group. */
export function readPartGroups(document: PckDocument): PartGroup[] {
  const hlod = document.lodMeshes.filter((entry) => entry.lod === "hlod");
  const root = document.pieces.find((piece) => piece.name.toLowerCase() === "vroot");
  if (!root || !hlod.length) return [];
  const groups: PartGroup[] = [];
  const walk = (index: number, path: string) => {
    const children = document.children.get(index) ?? [];
    const variants = children.map((child, position) => {
      const anchor = document.pieces[child].name;
      const entries = hlod.filter((entry) => entry.name.startsWith(`${path}_${anchor}_`));
      return { index: position, anchor, meshes: entries.map((entry) => entry.name), embedded: entries.some((entry) => entry.meshBlockOffset !== null) };
    });
    // Suspension arms also sit one mesh per child anchor, but they are fixed geometry, not a choice.
    if (variants.length >= 2 && variants.every((variant) => variant.meshes.length > 0) && !/suspension/i.test(document.pieces[index].name)) {
      groups.push({ path: path.replace(/^vroot_/, ""), variants });
      return;
    }
    for (const child of children) walk(child, `${path}_${document.pieces[child].name}`);
  };
  walk(root.index, "vroot");
  return groups;
}

/** Group-path patterns per carcfg field, covering the spellings seen across the reference set
 *  (`bumf`, `bmpf_bone`, `f_bumpers`, `hood_bne`, `trunkbone_splr_bone`, …). A guess only — the
 *  tool lets the user pick another group for any field. */
const FIELD_PATTERNS: Record<string, RegExp> = {
  FrontBumperIdx: /bumf|bmpf|bumpf|(^|_)f_bump/i,
  RearBumperIdx: /bumr|bmpr|bumpr|(^|_)r_bump/i,
  SideSkirtIdx: /(^|_)ss(_|$)|side_?skirt/i,
  SpoilerIdx: /splr|spoiler/i,
  HoodIdx: /(^|_)hd(_|$)|hood/i,
  TaillightGeomIdx: /(^|_)tl(_|$)|tail_?light/i,
  FrontGrillIdx: /gril/i,
  BrushGuardIdx: /bguard|brush/i,
  OneShotKitIdx: /oneshot/i,
  BlowerIdx: /blower/i,
  WheelieBarIdx: /wheelie/i,
  BodyIdx: /(^|_)body(_|$)/i,
};

export function guessGroup(field: string, groups: PartGroup[]): PartGroup | null {
  const pattern = FIELD_PATTERNS[field];
  return pattern ? groups.find((group) => pattern.test(group.path)) ?? null : null;
}

export function embeddedIndexes(group: PartGroup): number[] {
  return group.variants.filter((variant) => variant.embedded).map((variant) => variant.index);
}
