import type { PckDocument, Vec3 } from "./pck";

/**
 * Tail light glow anchors — the `tail_`, `rev_` and `brake_` entries that sit under each taillight
 * part (`tl_stk_*`, `tl1_elgte_01` … ) and position the light glow sprites.
 *
 * A car carries one set per aftermarket taillight variant — 61 of them across 12 parents on the
 * test vehicle — so repositioning the glows on a modded car means editing every one by hand. This
 * module classifies them by side so a single left-hand value can drive the whole set.
 */

export const lightFamilies = ["tail", "rev", "brake"] as const;
export type LightFamily = (typeof lightFamilies)[number];
export const lightFamilyLabels: Record<LightFamily, string> = { tail: "Left Tail Anchor", rev: "Left Rev Anchor", brake: "Left Brake Anchor" };

const FAMILY_PATTERN = /^(tail|rev|brake)_/i;

export type LightAnchor = { index: number; name: string; family: LightFamily; side: "left" | "right"; value: Vec3 };

/**
 * Every glow anchor in the document, tagged left/right.
 *
 * Side comes from the order the anchors appear within their own parent and family: the taillight
 * children are always laid out left, right, left, right. On the test vehicle this agrees with the
 * even/odd numeric name suffix for all 61 anchors, but ordering is what the table actually
 * guarantees — the suffix is only a naming convention, and it is not always contiguous.
 *
 * Note this classifies by position in the table, not by the sign of the existing X. That is
 * deliberate: the shipped data is not always right (on the test vehicle `tail_3` sits at the same
 * negative X as `tail_2`), and the whole point of the feature is to overwrite those values.
 */
export function collectLightAnchors(document: PckDocument): LightAnchor[] {
  const seenPerParent = new Map<string, number>();
  const found: LightAnchor[] = [];
  for (const piece of document.pieces) {
    const match = FAMILY_PATTERN.exec(piece.name);
    if (!match) continue;
    const family = match[1]!.toLowerCase() as LightFamily;
    const key = `${piece.parentIndex}:${family}`;
    const position = seenPerParent.get(key) ?? 0;
    seenPerParent.set(key, position + 1);
    found.push({ index: piece.index, name: piece.name, family, side: position % 2 === 0 ? "left" : "right", value: [...piece.a1] as Vec3 });
  }
  return found;
}

export type LightFamilySummary = { family: LightFamily; left: number; right: number; sample: Vec3 | null; varies: boolean };

/** Counts per family, plus the current left-hand value — flagged when the left anchors disagree. */
export function summarizeLightAnchors(anchors: LightAnchor[]): Record<LightFamily, LightFamilySummary> {
  const summaries = {} as Record<LightFamily, LightFamilySummary>;
  for (const family of lightFamilies) {
    const mine = anchors.filter((anchor) => anchor.family === family);
    const left = mine.filter((anchor) => anchor.side === "left");
    const sample = left[0]?.value ?? null;
    summaries[family] = {
      family,
      left: left.length,
      right: mine.length - left.length,
      sample: sample ? ([...sample] as Vec3) : null,
      varies: sample !== null && left.some((anchor) => anchor.value.some((component, axis) => !Object.is(component, sample[axis]))),
    };
  }
  return summaries;
}

/**
 * Turns left-hand values into the moves that set the whole vehicle's glow anchors: the left side
 * gets the value as typed, the right side gets it with X flipped, and A1 and A2 both receive it —
 * every glow anchor in the shipped data has A1 == A2.
 *
 * Families absent from `values` are left completely untouched, so a partly filled panel only moves
 * the rows the user actually filled in.
 */
export function planGlobalLightAnchors(anchors: LightAnchor[], values: Partial<Record<LightFamily, Vec3>>) {
  const moves: { index: number; a1: Vec3; a2: Vec3 }[] = [];
  for (const anchor of anchors) {
    const left = values[anchor.family];
    if (!left) continue;
    // `left[0] === 0 ? 0 : -left[0]` rather than plain negation: -0 is a distinct float that would
    // write a different byte pattern and mark the anchor dirty for no visible reason.
    const x = anchor.side === "left" ? left[0] : (left[0] === 0 ? 0 : -left[0]);
    const target: Vec3 = [x, left[1], left[2]];
    moves.push({ index: anchor.index, a1: [...target] as Vec3, a2: [...target] as Vec3 });
  }
  return moves;
}
