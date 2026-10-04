/**
 * Visual Shop menu editor — the AVM1 half of `vs_*.pck`.
 *
 * A port of the precedent Python tool (`mc3_flash_menu_editor_web.py`), kept faithful to it so its
 * output can be diffed against this one byte for byte. Nothing here touches vehicle PCKs: a
 * `vs_*.pck` is a Flash movie, and the menu the game shows is built by an AVM1 `Push` action that
 * stacks a category's item names and hands them to the `Array` constructor.
 *
 * Removing a menu item therefore means rewriting one `Push` payload — never moving bytes. The
 * rebuilt payload is always shorter than the original, and the slack is filled with stack-neutral
 * opcodes so every action after it keeps its offset and the movie's own length fields stay true.
 *
 * The four arrays behind one category (`…Names`, `…Status`, `…Price`, `…Brand`) are parallel: item
 * *n* of each belongs to the same part, so they are only ever patched as a group.
 */

const ACTION_END = 0x00;
const ACTION_POP = 0x17;
const ACTION_END_DRAG = 0x28;
const ACTION_PUSH_DUPLICATE = 0x4c;
const ACTION_CONSTANT_POOL = 0x88;
const ACTION_PUSH = 0x96;

/** How far into the file the constant-pool scan looks, and how far the action walk may run. Both
 *  are the precedent tool's own limits — a real vs_*.pck puts its global pool near the front. */
const POOL_SCAN_LIMIT = 0x40000;
const ACTION_WALK_LIMIT = 0x200000;

/** Named outright because a name alone can't always tell a physical part array from a paint or
 *  trim one, and getting that wrong would delete the wrong menu. */
const EXACT_PHYSICAL_ARRAYS = new Set([
  "BodyUpgradeFrontBumperNames", "BodyUpgradeRearBumperNames", "BodyUpgradeSideSkirtNames",
  "BodyUpgradeSpoilerNames", "BodyUpgradeHoodStyleNames", "BodyUpgradeTaillightsStyleNames",
  "BodyUpgradeExhaustTipsNames", "BodyUpgradeFrontGrillNames", "RimsNames", "TiresNames",
]);
const PHYSICAL_NAME_KEYWORDS = [
  "bumper", "skirt", "spoiler", "hoodstyle", "taillightsstyle", "exhausttips",
  "frontgrill", "wheeliebar", "choptop", "louvers", "mudflaps", "brushguard", "oneshotkit",
];
/** Arrays that read as physical by name but aren't: materials, sizes and ride heights are numeric
 *  or material pickers, and shortening them would desynchronize menus this tool doesn't model. */
const EXCLUDED_NAMES_ARRAYS = new Set([
  "UpgradeTypesNames", "BodyUpgradeNames", "BodyUpgradeHoodNames", "BodyUpgradeHoodMaterialNames",
  "BodyUpgradeTaillightsNames", "BodyUpgradeTaillightsMaterialNames", "WheelUpgradesNames",
  "WheelDimensionNames", "RimSizeNames", "TiresProfileNames", "TiresWidthNames",
  "RideHeightFrontNames", "RideHeightRearNames", "RideHeightNames",
]);
const NON_PHYSICAL_SUFFIX_HINTS = ["materialnames", "dimensionnames", "heightnames", "widthnames", "profilenames"];
const CATEGORY_LABELS: Record<string, string> = {
  BodyUpgradeFrontBumperNames: "Front Bumpers", BodyUpgradeRearBumperNames: "Rear Bumpers",
  BodyUpgradeSideSkirtNames: "Side Skirts", BodyUpgradeSpoilerNames: "Spoilers",
  BodyUpgradeHoodStyleNames: "Hoods", BodyUpgradeTaillightsStyleNames: "Tail Lights",
  BodyUpgradeExhaustTipsNames: "Exhaust Tips", BodyUpgradeFrontGrillNames: "Front Grills",
  RimsNames: "Rims", TiresNames: "Tires",
};
const PARALLEL_SUFFIXES = ["Status", "Price", "Brand"];

/** A value pushed by an AVM1 `Push` action. `raw` is the exact source encoding, which is what gets
 *  re-emitted on patch — an item's bytes are never rebuilt from its decoded value, so a constant-
 *  pool reference stays a reference and a literal stays a literal. */
export type PushValue = { typeId: number; value: string | number | null | Uint8Array; raw: Uint8Array };
export type ActionRecord = { off: number; opcode: number; payloadOff: number; payloadLen: number; endOff: number; payload: Uint8Array };

export type ArrayDef = {
  name: string;
  action: ActionRecord;
  nameValue: PushValue;
  /** Items in stack order, which is reverse display order — AVM1 pushes the last menu entry first. */
  internalItems: PushValue[];
  countValue: PushValue;
  constructorValue: PushValue;
};

export type FlashModel = { constantPool: string[]; arrays: Map<string, ArrayDef> };

export type FlashMenuItem = { index: number; token: string };

/**
 * What a previous edit to this category left behind.
 *
 * Shortening a menu never erases the entry names: they live in the constant pool, which the patch
 * doesn't touch, and only the 2-3 byte reference to them is overwritten. The freed space becomes a
 * run of stack-neutral filler right after the array's Push, which is both the fingerprint that this
 * category was edited and a measure of how much was taken out.
 *
 * What is genuinely gone is position: kept entries are packed to the front and all the filler goes
 * to the end, so nothing records where a removed entry used to sit. Measured over 185 stock files,
 * constant-pool order matches display order in 7 categories out of 1192 — it cannot stand in for it.
 */
export type FlashMenuRemoval = {
  /** Bytes of filler following this category's Push — the space its removed entries gave back. */
  paddingBytes: number;
  /** How many entries that accounts for, when every surviving entry encodes to the same width. */
  count: number | null;
  /** Used instead of `count` for arrays that mix 1- and 2-byte pool references (large Rims lists),
   *  where the same freed space can only be narrowed to a range. */
  range: [number, number] | null;
  /** Entry names still in the constant pool that no array references any more and that belong to
   *  this category's family. A strong candidate list, not proof: a few stock files ship orphan
   *  names in the pool for parts that were never in that car's menu. */
  candidates: string[];
};

export type FlashMenuCategory = {
  array: string; label: string; count: number; companions: string[]; items: FlashMenuItem[];
  /** Null when this category carries no sign of a previous edit. */
  removal: FlashMenuRemoval | null;
};
export type FlashMenuAnalysis = { file: { name: string; size: number }; categories: FlashMenuCategory[]; totalItems: number };

export type FlashMenuGroupReport = { array: string; oldCount: number; newCount: number; kept: string[]; removed: string[]; patchedArrays: string[] };
export type FlashMenuReport = { originalSize: number; outputSize: number; categoriesChanged: number; itemsRemoved: number; groups: FlashMenuGroupReport[] };

function u16(bytes: Uint8Array, offset: number) {
  if (offset < 0 || offset + 2 > bytes.length) throw new Error(`Read past the end of the file at 0x${offset.toString(16)}.`);
  return bytes[offset] | (bytes[offset + 1] << 8);
}
function i32(bytes: Uint8Array, offset: number) {
  if (offset < 0 || offset + 4 > bytes.length) throw new Error(`Read past the end of the file at 0x${offset.toString(16)}.`);
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) | 0;
}
/** Flash strings are Latin-1, one byte per character — decoded here rather than through TextDecoder
 *  so every byte 0x00-0xFF round-trips to the same code point the Python side produced. */
function latin1(bytes: Uint8Array, start: number, end: number) {
  let output = "";
  for (let index = start; index < end; index += 1) output += String.fromCharCode(bytes[index]);
  return output;
}
function indexOfZero(bytes: Uint8Array, start: number, end: number) {
  for (let index = start; index < end; index += 1) if (bytes[index] === 0) return index;
  return -1;
}
function isString(value: PushValue["value"]): value is string { return typeof value === "string"; }

/** Item order as the menu shows it — the reverse of the stack order the file stores. */
export function displayItems(array: ArrayDef) { return [...array.internalItems].reverse(); }
export function displayStrings(array: ArrayDef) { return displayItems(array).map((item) => String(item.value)); }

/**
 * Reads a ConstantPool action at `offset`, returning its strings and the offset just past it —
 * which is where the action stream that uses those strings begins. Returns null for anything that
 * doesn't parse cleanly as one, since the scan below tries every 0x88 byte in the file.
 */
function constantPoolAt(bytes: Uint8Array, offset: number): { pool: string[]; actionStart: number } | null {
  if (offset < 0 || offset + 5 > bytes.length || bytes[offset] !== ACTION_CONSTANT_POOL) return null;
  const length = u16(bytes, offset + 1);
  const payloadOff = offset + 3;
  const payloadEnd = payloadOff + length;
  if (payloadEnd > bytes.length || length < 2) return null;
  const count = u16(bytes, payloadOff);
  let pos = payloadOff + 2;
  const pool: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const end = indexOfZero(bytes, pos, payloadEnd);
    if (end < 0) return null;
    pool.push(latin1(bytes, pos, end));
    pos = end + 1;
  }
  // The declared count has to consume the payload exactly; anything left over means this 0x88 was
  // a coincidence inside other data rather than a real pool.
  return pos === payloadEnd ? { pool, actionStart: payloadEnd } : null;
}

/**
 * Finds the movie's global constant pool by scoring every candidate on how much it looks like the
 * one that defines the shop menus, rather than trusting the first that parses. A vs_*.pck holds
 * several pools; only one carries the `BodyUpgrade…Names` symbols this editor works on.
 */
function findPool(bytes: Uint8Array): { pool: string[]; actionStart: number } {
  const candidates: { score: number; offset: number; pool: string[]; actionStart: number }[] = [];
  const scanEnd = Math.min(bytes.length, POOL_SCAN_LIMIT);
  for (let offset = 0; offset < scanEnd; offset += 1) {
    if (bytes[offset] !== ACTION_CONSTANT_POOL) continue;
    const parsed = constantPoolAt(bytes, offset);
    if (!parsed) continue;
    const unique = new Set(parsed.pool);
    let score = (unique.has("_global") ? 10 : 0) + (unique.has("Array") ? 10 : 0);
    for (const value of parsed.pool) {
      if (value.endsWith("Names")) score += 1;
      if (value.startsWith("BodyUpgrade") && value.endsWith("Names")) score += 5;
    }
    if (score >= 25) candidates.push({ score, offset, pool: parsed.pool, actionStart: parsed.actionStart });
  }
  if (!candidates.length) throw new Error("Could not find the global AVM1 constant pool in this VS PCK.");
  candidates.sort((a, b) => b.score - a.score || a.offset - b.offset);
  return { pool: candidates[0].pool, actionStart: candidates[0].actionStart };
}

/** Splits one `Push` action's payload into its values. Throws on anything malformed; the caller
 *  treats that as "this action isn't an array initializer" and moves on. */
function pushValues(payload: Uint8Array, pool: string[]): PushValue[] {
  const values: PushValue[] = [];
  let pos = 0;
  const need = (count: number) => { if (pos + count > payload.length) throw new Error("Push payload ended mid-value."); };
  while (pos < payload.length) {
    const start = pos;
    const typeId = payload[pos];
    pos += 1;
    let value: PushValue["value"];
    if (typeId === 0) {
      const end = indexOfZero(payload, pos, payload.length);
      if (end < 0) throw new Error("Unterminated Push string.");
      value = latin1(payload, pos, end);
      pos = end + 1;
    } else if (typeId === 1) {
      need(4);
      value = new DataView(payload.buffer, payload.byteOffset + pos, 4).getFloat32(0, true);
      pos += 4;
    } else if (typeId === 2 || typeId === 3) {
      value = null;
    } else if (typeId === 4 || typeId === 5) {
      need(1);
      value = payload[pos];
      pos += 1;
    } else if (typeId === 6) {
      need(8);
      value = payload.slice(pos, pos + 8);
      pos += 8;
    } else if (typeId === 7) {
      need(4);
      value = i32(payload, pos);
      pos += 4;
    } else if (typeId === 8) {
      need(1);
      const index = payload[pos];
      if (index >= pool.length) throw new Error("Push references a constant outside the pool.");
      value = pool[index];
      pos += 1;
    } else if (typeId === 9) {
      need(2);
      const index = u16(payload, pos);
      if (index >= pool.length) throw new Error("Push references a constant outside the pool.");
      value = pool[index];
      pos += 2;
    } else {
      throw new Error(`Unsupported AVM1 push type 0x${typeId.toString(16).toUpperCase().padStart(2, "0")}`);
    }
    values.push({ typeId, value, raw: payload.slice(start, pos) });
  }
  return values;
}

/** Walks the action stream from `start` to its End opcode, recording each action's exact extent. */
function actions(bytes: Uint8Array, start: number): ActionRecord[] {
  const result: ActionRecord[] = [];
  let pos = start;
  const hardEnd = Math.min(bytes.length, start + ACTION_WALK_LIMIT);
  while (pos < hardEnd) {
    const off = pos;
    const opcode = bytes[pos];
    pos += 1;
    let payloadLen = 0;
    let payloadOff = pos;
    let endOff = pos;
    let payload = new Uint8Array(0);
    // Opcodes with the high bit set carry a u16 length and a payload; the rest are bare.
    if (opcode >= 0x80) {
      payloadLen = u16(bytes, pos);
      pos += 2;
      payloadOff = pos;
      endOff = pos + payloadLen;
      if (endOff > hardEnd) throw new Error(`AVM1 action at 0x${off.toString(16).toUpperCase()} exceeds file`);
      payload = bytes.slice(payloadOff, endOff);
      pos = endOff;
    }
    result.push({ off, opcode, payloadOff, payloadLen, endOff, payload });
    if (opcode === ACTION_END) return result;
  }
  throw new Error("AVM1 action stream has no End opcode within the scan window.");
}

/**
 * Builds the model of every `Array` initializer in the movie.
 *
 * The shape being matched is one `Push` that stacks: the array's variable name, its items, an i32
 * item count, and the constant `"Array"`. Requiring the count to agree with the number of items is
 * what keeps unrelated pushes out.
 */
export function parseModel(bytes: Uint8Array): FlashModel {
  const { pool, actionStart } = findPool(bytes);
  const arrays = new Map<string, ArrayDef>();
  for (const action of actions(bytes, actionStart)) {
    if (action.opcode !== ACTION_PUSH) continue;
    let values: PushValue[];
    try { values = pushValues(action.payload, pool); } catch { continue; }
    if (values.length < 4 || !isString(values[0].value) || values[values.length - 1].value !== "Array") continue;
    const countValue = values[values.length - 2];
    const items = values.slice(1, values.length - 2);
    if (countValue.typeId !== 7 || countValue.value !== items.length) continue;
    if (!items.every((item) => isString(item.value))) continue;
    arrays.set(String(values[0].value), {
      name: String(values[0].value),
      action,
      nameValue: values[0],
      internalItems: items,
      countValue,
      constructorValue: values[values.length - 1],
    });
  }
  if (!arrays.size) throw new Error("No AVM1 Array initializers were detected in the VS PCK.");
  return { constantPool: pool, arrays };
}

/** Whether an array drives a physical part menu — the only kind this editor will shorten. */
function isPhysical(name: string, array: ArrayDef) {
  if (EXCLUDED_NAMES_ARRAYS.has(name)) return false;
  if (EXACT_PHYSICAL_ARRAYS.has(name)) return true;
  const lower = name.toLowerCase();
  if (!name.endsWith("Names")) return false;
  if (PHYSICAL_NAME_KEYWORDS.some((keyword) => lower.includes(keyword))) {
    return !NON_PHYSICAL_SUFFIX_HINTS.some((hint) => lower.includes(hint));
  }
  // Unrecognized BodyUpgrade array: accept it only when every item reads like a mesh token
  // (underscored, no spaces), which is what distinguishes part names from display labels.
  const tokens = displayStrings(array);
  return tokens.length >= 2 && tokens.every((token) => token.includes("_") && !token.includes(" ")) && name.startsWith("BodyUpgrade");
}

function label(name: string) {
  const known = CATEGORY_LABELS[name];
  if (known) return known;
  const stripped = name.replace(/^BodyUpgrade/, "").replace(/Names$/, "");
  return stripped.replace(/(?<!^)(?=[A-Z])/g, " ").trim() || name;
}

/** The parallel arrays that must be patched together with `array`, itself included, in patch order. */
function companionNames(model: FlashModel, array: ArrayDef) {
  const names = [array.name];
  const base = array.name.slice(0, -5);
  for (const suffix of PARALLEL_SUFFIXES) {
    const candidate = model.arrays.get(base + suffix);
    if (!candidate) continue;
    if (candidate.internalItems.length !== array.internalItems.length) {
      throw new Error(`${array.name}: companion ${candidate.name} has a different item count.`);
    }
    names.push(candidate.name);
  }
  return names;
}

/**
 * Measures the run of stack-neutral filler starting at `offset`.
 *
 * `padding()` below emits PushDuplicate/Pop pairs, preceded by a lone EndDrag when the gap is odd —
 * so a bare EndDrag with no pair after it is something this tool never writes, and doesn't count.
 */
function paddingRunAt(bytes: Uint8Array, offset: number) {
  let pos = offset;
  if (bytes[pos] === ACTION_END_DRAG) pos += 1;
  let pairs = 0;
  while (pos + 1 < bytes.length && bytes[pos] === ACTION_PUSH_DUPLICATE && bytes[pos + 1] === ACTION_POP) { pos += 2; pairs += 1; }
  return pairs === 0 ? 0 : pos - offset;
}

/**
 * The family a menu entry name belongs to, used to attribute an orphaned name back to a category.
 *
 * Normally the leading letters of the first segment (`bumf15_bmx_uad473` → `bumf`). A first segment
 * with no digits is a container word rather than an entry name, so the second segment joins it —
 * which is what keeps `whl_rm` (rims) apart from `whl_tir` (tires), the one collision in the corpus.
 */
function tokenFamily(token: string) {
  const segments = token.toLowerCase().split("_");
  const head = (/^[a-z]+/.exec(segments[0]) ?? [""])[0];
  if (/\d/.test(segments[0]) || segments.length < 2) return head;
  return `${head}_${(/^[a-z]+/.exec(segments[1]) ?? [""])[0]}`;
}

function describeRemoval(bytes: Uint8Array, array: ArrayDef, orphansByFamily: Map<string, string[]>): FlashMenuRemoval | null {
  const paddingBytes = paddingRunAt(bytes, array.action.endOff);
  if (!paddingBytes) return null;
  // Each removed entry gave back exactly its own encoding, so the freed space divided by one
  // entry's width is the number taken out — as long as the surviving entries agree on that width.
  const widths = [...new Set(array.internalItems.map((item) => item.raw.length))].sort((a, b) => a - b);
  const exact = widths.length === 1 && paddingBytes % widths[0] === 0 ? paddingBytes / widths[0] : null;
  const range: [number, number] | null = exact === null && widths.length
    ? [Math.ceil(paddingBytes / widths[widths.length - 1]), Math.floor(paddingBytes / widths[0])]
    : null;
  const families = new Set(displayStrings(array).map(tokenFamily));
  const candidates = [...families].flatMap((family) => orphansByFamily.get(family) ?? []);
  return { paddingBytes, count: exact, range, candidates };
}

/** Reads the physical part menus out of a `vs_*.pck`, without modifying anything. */
export function analyzeFlashMenu(name: string, source: Uint8Array): FlashMenuAnalysis {
  const model = parseModel(source);
  const physical = [...model.arrays.values()].filter((array) => isPhysical(array.name, array));
  physical.sort((a, b) => a.action.off - b.action.off);
  if (!physical.length) throw new Error("No physical part arrays were detected in the selected VS PCK.");
  // A pool name no array points at is a name nothing can show — either an entry a previous edit took
  // out, or (in a few stock files) a part that was never offered for this car. Grouped by family so
  // each category can claim the ones that look like its own.
  const referenced = new Set<string>();
  for (const array of model.arrays.values()) for (const token of displayStrings(array)) referenced.add(token);
  const orphansByFamily = new Map<string, string[]>();
  for (const token of new Set(model.constantPool)) {
    if (referenced.has(token)) continue;
    const family = tokenFamily(token);
    orphansByFamily.set(family, [...(orphansByFamily.get(family) ?? []), token]);
  }
  const categories = physical.map((array) => ({
    array: array.name,
    label: label(array.name),
    count: array.internalItems.length,
    companions: companionNames(model, array),
    items: displayStrings(array).map((token, index) => ({ index, token })),
    removal: describeRemoval(source, array, orphansByFamily),
  }));
  return {
    file: { name, size: source.length },
    categories,
    totalItems: categories.reduce((sum, category) => sum + category.count, 0),
  };
}

/**
 * Builds `size` bytes of AVM1 that leave the stack exactly as they found it.
 *
 * PushDuplicate followed by Pop is the two-byte unit; an odd remainder is absorbed by a leading
 * EndDrag, which takes one byte and does nothing outside a drag. One byte of slack on its own has
 * no such filler, hence the refusal below — but it can't arise, because dropping any item frees at
 * least that item's encoding plus nothing smaller than the two-byte unit needs.
 */
function padding(size: number) {
  if (size < 0) throw new Error("Negative AVM1 padding size");
  const output: number[] = [];
  let remaining = size;
  if (remaining % 2) {
    if (remaining < 3) throw new Error(`Cannot build safe AVM1 padding of ${remaining} byte(s)`);
    output.push(ACTION_END_DRAG);
    remaining -= 1;
  }
  for (let index = 0; index < remaining / 2; index += 1) output.push(ACTION_PUSH_DUPLICATE, ACTION_POP);
  return Uint8Array.from(output);
}

/**
 * Rewrites one array's `Push` in place, keeping only `keepIndices` (in display order).
 *
 * The action keeps its original extent: a shorter payload, a corrected length field, and padding
 * for the difference. Nothing after this action moves, which is why the movie needs no other fixups.
 */
function patchArray(bytes: Uint8Array, array: ArrayDef, keepIndices: number[]) {
  if (!keepIndices.length) throw new Error(`${array.name}: at least one item must remain`);
  const shown = displayItems(array);
  const internal = keepIndices.map((index) => shown[index]).reverse();
  const countPush = Uint8Array.from([7, 0, 0, 0, 0]);
  new DataView(countPush.buffer).setInt32(1, internal.length, true);
  const parts = [array.nameValue.raw, ...internal.map((item) => item.raw), countPush, array.constructorValue.raw];
  const payloadLength = parts.reduce((sum, part) => sum + part.length, 0);
  if (payloadLength > array.action.payloadLen) throw new Error(`${array.name}: rebuilt Push payload grew unexpectedly`);
  const payload = new Uint8Array(payloadLength);
  let cursor = 0;
  for (const part of parts) { payload.set(part, cursor); cursor += part.length; }
  new DataView(bytes.buffer, bytes.byteOffset).setUint16(array.action.off + 1, payloadLength, true);
  bytes.set(payload, array.action.payloadOff);
  bytes.set(padding(array.action.payloadLen - payloadLength), array.action.payloadOff + payloadLength);
}

/**
 * Produces an edited copy of a `vs_*.pck` keeping only the selected items per category.
 *
 * `keepMap` is keyed by the `…Names` array; its companions come along automatically. Categories
 * where nothing was removed are skipped rather than rewritten, so an untouched menu keeps its
 * original bytes exactly. The result is re-parsed and checked against what was asked for before it
 * is returned — a movie that no longer parses never reaches the caller.
 */
export function patchFlashMenu(source: Uint8Array, keepMap: Map<string, number[]> | Record<string, number[]>) {
  const bytes = source.slice();
  const model = parseModel(bytes);
  const entries = keepMap instanceof Map ? [...keepMap] : Object.entries(keepMap);
  const groups: FlashMenuGroupReport[] = [];
  for (const [arrayName, keepIndices] of entries) {
    const array = model.arrays.get(arrayName);
    if (!array || !isPhysical(arrayName, array)) throw new Error(`Physical menu array not found: ${arrayName}`);
    const count = array.internalItems.length;
    const indices = [...new Set(keepIndices.map((index) => Math.trunc(index)))].sort((a, b) => a - b);
    if (!indices.length) throw new Error(`${arrayName}: at least one item must remain`);
    if (indices.some((index) => index < 0 || index >= count)) throw new Error(`${arrayName}: item index outside the array`);
    if (indices.length === count) continue;
    const companions = companionNames(model, array);
    const tokens = displayStrings(array);
    const kept = indices.map((index) => tokens[index]);
    const removed = tokens.filter((_, index) => !indices.includes(index));
    for (const companion of companions) patchArray(bytes, model.arrays.get(companion)!, indices);
    groups.push({ array: arrayName, oldCount: count, newCount: indices.length, kept, removed, patchedArrays: companions });
  }
  if (!groups.length) throw new Error("No menu items were disabled.");
  const validated = parseModel(bytes);
  for (const group of groups) {
    for (const name of group.patchedArrays) {
      const array = validated.arrays.get(name);
      if (!array || array.internalItems.length !== group.newCount) throw new Error(`Validation failed for patched array: ${name}`);
    }
    const shown = displayStrings(validated.arrays.get(group.array)!);
    if (shown.length !== group.kept.length || shown.some((token, index) => token !== group.kept[index])) {
      throw new Error(`Validation failed: display order changed in ${group.array}`);
    }
  }
  const report: FlashMenuReport = {
    originalSize: source.length,
    outputSize: bytes.length,
    categoriesChanged: groups.length,
    itemsRemoved: groups.reduce((sum, group) => sum + group.removed.length, 0),
    groups,
  };
  return { bytes, report };
}
