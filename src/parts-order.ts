import type { FlashMenuAnalysis } from "./flash-avm1";
import type { LodMeshEntry, PckDocument } from "./pck";
import { readPartGroups } from "./carcfg-parts";

/**
 * Visual Shop piece order — which mesh each entry of a car's shop menu stands for, in the order the
 * menu shows them.
 *
 * A port of `mc3_export_vs_piece_order.py`. The garage PCK lists a category's parts in its own
 * order, which is not the menu's: the Skyline's second front bumper in the menu is the eleventh in
 * the PCK. A modder building parts against the PCK needs the mapping to know which slot shows up
 * where in the shop.
 *
 * Read-only on both inputs. The menu comes from the AVM1 arrays the Flash Menu Editor already
 * parses, and the pieces from `PckDocument` — so where the script scanned the `vs` for loose
 * strings (and picked up Flash internals as bumpers when a car had no grill menu) and matched mesh
 * names by substring against a fixed prefix list, this matches each menu token to the anchor of
 * the same name in the car's part categories, whatever those are called on that car.
 */

export type PartsOrderRow = {
  /** Position in the menu, as displayed. */
  position: number;
  /** The menu entry's internal name, e.g. `bumf15_bmx_uad473`. */
  token: string;
  mesh: { name: string; pieceId: number } | null;
  /** No mesh, but the car has an anchor by this name: a slot that deliberately draws nothing,
   *  like the stock "no side skirt" entry on the muscle cars. */
  emptySlot: boolean;
};
export type PartsOrderCategory = { array: string; title: string; rows: PartsOrderRow[] };
export type PartsOrder = {
  categories: PartsOrderCategory[];
  /** Menu categories with no piece in the car PCK at all — rims, tires and exhaust tips live in
   *  shared PPF containers, not in the car. */
  unmatched: { array: string; title: string; count: number }[];
};

/** The script's section titles, kept so an exported TXT reads the same as the ones it made. */
const TITLES: Record<string, string> = {
  BodyUpgradeFrontBumperNames: "Front bumper", BodyUpgradeRearBumperNames: "Rear bumper",
  BodyUpgradeSideSkirtNames: "Side skirt", BodyUpgradeSpoilerNames: "Spoiler",
  BodyUpgradeHoodStyleNames: "Hood style", BodyUpgradeFrontGrillNames: "Front grill",
  BodyUpgradeTaillightsStyleNames: "Taillights",
};

export function buildPartsOrder(menu: FlashMenuAnalysis, document: PckDocument): PartsOrder {
  const hlod = document.lodMeshes.filter((entry) => entry.lod === "hlod");
  const groups = readPartGroups(document);
  const variantMesh = new Map<string, LodMeshEntry>();
  for (const group of groups) {
    for (const variant of group.variants) {
      const entry = hlod.find((item) => item.name === variant.meshes[0]);
      if (entry && !variantMesh.has(variant.anchor.toLowerCase())) variantMesh.set(variant.anchor.toLowerCase(), entry);
    }
  }
  // Fallback for a part whose anchor sits outside a recognized group. Across the game's cars that is
  // a mesh named without the vroot path (`lss1_ebni_012_geo.mesh`), or a hood scoop whose menu
  // token (`mscp_hly_7220_bel57_lv`) is followed by a level digit in every mesh (`…_lv0_scoop…`) —
  // so the token must start at a word boundary but may run into the next character. When several
  // meshes carry it, the one where it appears earliest names the part itself: in
  // `vroot_bumf_bumf29_rzi_acura01_bumf26_ww_890639_geo.mesh`, bumf26 is only borrowed geometry.
  const byName = (token: string) => {
    const needle = `_${token.toLowerCase()}`;
    let best: { entry: LodMeshEntry; score: number } | null = null;
    for (const entry of hlod) {
      const name = `_${entry.name.toLowerCase()}_`;
      const at = name.indexOf(needle);
      if (at < 0) continue;
      const score = (name.includes(`${needle}_`) ? 2000 : 0) + (entry.name.startsWith("vroot_") ? 1000 : 0) - at;
      if (!best || score > best.score) best = { entry, score };
    }
    return best?.entry ?? null;
  };
  const anchors = new Set(document.pieces.map((piece) => piece.name.toLowerCase()));

  const categories: PartsOrderCategory[] = [];
  const unmatched: PartsOrder["unmatched"] = [];
  for (const category of menu.categories) {
    const title = TITLES[category.array] ?? category.label;
    const rows = category.items.map((item): PartsOrderRow => {
      const entry = variantMesh.get(item.token.toLowerCase()) ?? byName(item.token);
      return {
        position: item.index, token: item.token,
        mesh: entry ? { name: entry.name, pieceId: entry.meshId } : null,
        emptySlot: !entry && anchors.has(item.token.toLowerCase()),
      };
    });
    if (rows.some((row) => row.mesh)) categories.push({ array: category.array, title, rows });
    else unmatched.push({ array: category.array, title, count: rows.length });
  }
  return { categories, unmatched };
}

export const pieceIdHex = (id: number) => id.toString(16).toUpperCase().padStart(2, "0");

/** The script's TXT layout: `4C - vroot_….mesh` per entry, `?? - [NO MATCH] token` for an entry
 *  with no piece, then its Warnings block — so a file made here drops in wherever the old one went.
 *  One addition: `-- - [NO MESH] token` for an empty slot, which isn't a problem to warn about. */
export function formatPartsOrderText(order: PartsOrder) {
  const warnings: string[] = [];
  const sections = order.categories.map((category) => {
    const lines = [category.title, ""];
    for (const row of category.rows) {
      if (row.mesh) { lines.push(`${pieceIdHex(row.mesh.pieceId)} - ${row.mesh.name}`); continue; }
      if (row.emptySlot) { lines.push(`-- - [NO MESH] ${row.token}`); continue; }
      lines.push(`?? - [NO MATCH] ${row.token}`);
      warnings.push(`Sem match no PCK: ${category.title} -> ${row.token}`);
    }
    return lines.join("\n");
  });
  let text = `${sections.join("\n\n").trimEnd()}\n`;
  if (warnings.length) text += `\nWarnings\n\n${warnings.map((warning) => `- ${warning}\n`).join("")}`;
  return text;
}
