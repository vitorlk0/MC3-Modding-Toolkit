/**
 * Rear-bumper exhaust tips of a car PCK: which tips each rear bumper has, and turning them on or
 * off (modding KB §7.9.1/§7.9.2, Web/MC3_PAE/HANDOFF-EXHAUSTS.md).
 *
 * Three tables, all at fixed offsets from the main root (file 0xD0) in the three PCK families:
 *   root+0x2B5C  s32[24]     rear bumpers; group N = the N-th entry (the game's RearBumperIdx)
 *   root+0x2E94  s32[24][2]  slots: the anchor each tip uses, -1 = no tip
 *   file 0x1B8   Vec3[24][2] TBL_Exhausts: where each tip is drawn
 *
 * Turning a tip off is slot = -1 and position = 0. Turning one on reuses an anchor under the bumper
 * when there is one, and otherwise appends a mirrored copy of the other tip's anchor at the END of
 * the anchor list, the way `Roadmap/07_scripts/insert_anchor.py --at-end` does (validated in game):
 * no existing index changes, so nothing else in the car — LOD piece IDs, light tables, loose
 * mesh.pck files — has to follow. Inserting in the middle and renumbering broke shadows and brake
 * glows on the Eclipse; never do that here.
 *
 * Pure bytes in, bytes out, no imports: the edit is always recomputed from the file as it was
 * opened plus the wanted on/off state, so turning everything back reproduces the input exactly.
 */

export type ExhaustVec = [number, number, number];
export type ExhaustSide = "left" | "right";
/** Per group: whether a tip is wanted on each side. Groups left out keep what they have. */
export type ExhaustChoices = Record<number, { left: boolean; right: boolean }>;

export type ExhaustTip = { slot: 0 | 1; anchor: number; anchorName: string; position: ExhaustVec; side: ExhaustSide | null };
export type ExhaustGroup = {
  group: number;
  /** Rear-bumper anchor index, or -1 when the list has no bumper in this group. */
  bumper: number;
  bumperName: string;
  slots: [number, number];
  positions: [ExhaustVec, ExhaustVec];
  tips: ExhaustTip[];
  left: boolean;
  right: boolean;
  /** Null when the checkboxes can be used; otherwise why not. */
  locked: string | null;
  /** The checks of `exhaust_info.py`: slot/position disagreement and the cruise drawing rule. */
  warnings: string[];
};
export type ExhaustSetup = {
  anchorCount: number;
  field2: number;
  unk: number;
  cookie: number;
  tailCount: number;
  /** Anchors this tool (or insert_anchor.py) appended earlier, from this index on; null if none. */
  appendedFrom: number | null;
  /** Every group `exhaust_info.py` prints, in table order. */
  groups: ExhaustGroup[];
  /** True when no group has a tip slot at all (exotics and cars without customization). */
  noSlots: boolean;
};
export type ExhaustEditResult = {
  bytes: Uint8Array;
  changed: boolean;
  added: { group: number; index: number; name: string; side: ExhaustSide }[];
  /** True when the anchor list was copied to a new place (rather than rebuilt where it already was). */
  listCopied: boolean;
};

const ROOT = 0xd0;
const MAIN_ROOT_SLOT = 0x88;
const REAR_BUMPERS = ROOT + 0x2b5c;
const SLOTS = ROOT + 0x2e94;
const INDEX_REGION: [number, number] = [ROOT + 0x2970, ROOT + 0x315c];
const EXHAUSTS = 0x1b8;
const TAIL_COUNT = 0x3f8;
const ANCHOR_HEADER_SLOT = 0x1ac;
const ITEM = 0x44;
const GROUPS = 24;
const EXT_STRUCT_SIZE = 0x30;
/** |X| below this is "on the centre line": the side can't be told, so the group is left alone. */
const SIDE_EPSILON = 0.02;
const EXHAUST_NAME = /ext|exst|exhst|exhaust|nitro/i;

type Row = { name: string; nameOffset: number; extOffset: number | null; parent: number | null; next: number | null; child: number | null; a1x: number };
type Parsed = {
  bytes: Uint8Array; view: DataView; base: number; header: number;
  count: number; field2: number; unk: number; listOffset: number; rows: Row[];
  appendedFrom: number | null; tailStart: number | null;
  bumpers: number[]; slots: [number, number][]; positions: [ExhaustVec, ExhaustVec][];
};

const fail = (message: string): never => { throw new Error(message); };
const align16 = (n: number) => n + ((16 - (n % 16)) % 16);
const sideOf = (x: number): ExhaustSide | null => x < -SIDE_EPSILON ? "left" : x > SIDE_EPSILON ? "right" : null;
const otherSide = (side: ExhaustSide): ExhaustSide => side === "left" ? "right" : "left";

function readCString(bytes: Uint8Array, offset: number) {
  let end = offset;
  while (end < bytes.length && bytes[end] !== 0) end += 1;
  let text = "";
  for (let i = offset; i < end; i += 1) text += String.fromCharCode(bytes[i]);
  return text;
}

/** insert_anchor.py's mirrored_name, plus the reverse direction for templates on the "1" side. */
export function mirroredAnchorName(name: string) {
  const pairs: [string, string][] = [["ext0", "ext1"], ["exst0", "exst1"], ["ext_0", "ext_1"], ["ext_00", "ext_01"], ["nitro_00", "nitro_01"], ["nitro_0", "nitro_1"], ["exhst0", "exhst1"]];
  for (const [a, b] of pairs) if (name.endsWith(a)) return name.slice(0, -a.length) + b;
  for (const [a, b] of pairs) if (name.endsWith(b)) return name.slice(0, -b.length) + a;
  return `${name}_m`;
}

function parse(source: Uint8Array): Parsed {
  const bytes = source;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < TAIL_COUNT + 2 || bytes.length < INDEX_REGION[1]) fail("The file is too small to be a car PCK.");
  const u32 = (o: number) => view.getUint32(o, true);
  const base = (u32(0) - 0x80) >>> 0;
  const toFile = (va: number) => (va - base) >>> 0;
  if (toFile(u32(MAIN_ROOT_SLOT)) !== ROOT) fail("The main root of this PCK is not at file 0xD0, so the exhaust tables can't be located.");

  const header = toFile(u32(ANCHOR_HEADER_SLOT));
  if (header + 12 > bytes.length) fail("The anchor table header is outside the file.");
  const count = view.getUint16(header, true), field2 = view.getUint16(header + 2, true), unk = u32(header + 4);
  const listOffset = toFile(u32(header + 8));
  if (!count || listOffset < 0x10 || listOffset + count * ITEM > bytes.length) fail("The anchor list is outside the file.");
  // field2/unk follow ~3 per anchor (exactly 0x10000 + 3*count in most of the corpus, a few units
  // less in 81 PCKs such as the Eclipse); anything outside that range is a layout this wasn't checked on.
  if (unk < 0x10000 || unk > 0x10000 + 3 * count) fail(`The anchor table header is outside the known range (count ${count}, ${unk.toString(16)}).`);
  if (view.getUint16(TAIL_COUNT, true) !== count) fail("The anchor count after TBL_Exhausts (file 0x3F8) does not match the anchor table.");
  // The list is a C++ new[] array: the game's unload path walks it by this cookie (KB §7.2).
  if (u32(listOffset - 0x10) !== count || bytes.subarray(listOffset - 0x0c, listOffset).some((b) => b !== 0xcd)) fail("The 16 bytes before the anchor list are not the expected new[] cookie.");
  for (let o = INDEX_REGION[0]; o < INDEX_REGION[1]; o += 4) {
    const v = view.getInt32(o, true);
    if (v !== -1 && (v < 0 || v >= count)) fail(`An anchor index table entry (file 0x${o.toString(16)}) is out of range.`);
  }

  const indexOf = (pointer: number) => {
    if (pointer === 0 || pointer === 0xcdcdcdcd) return null;
    const delta = toFile(pointer) - listOffset;
    if (delta < 0 || delta >= count * ITEM || delta % ITEM) fail(`An anchor link (0x${pointer.toString(16)}) points outside the anchor list.`);
    return delta / ITEM;
  };
  const rows: Row[] = [];
  for (let i = 0; i < count; i += 1) {
    const o = listOffset + i * ITEM;
    const nameOffset = toFile(u32(o + 0x0c));
    if (nameOffset >= bytes.length) fail(`Anchor #${i} has a name outside the file.`);
    const ext = u32(o + 0x40);
    const extOffset = ext ? toFile(ext) : null;
    if (extOffset !== null && extOffset + EXT_STRUCT_SIZE > bytes.length) fail(`Anchor #${i} has extra data outside the file.`);
    rows.push({ name: readCString(bytes, nameOffset), nameOffset, extOffset, parent: indexOf(u32(o + 0x1c)), next: indexOf(u32(o + 0x14)), child: indexOf(u32(o + 0x18)), a1x: view.getFloat32(o, true) });
  }

  // Anchors appended earlier (by this tool or insert_anchor.py --at-end) sit after the list, each
  // as name + CD padding + its +0x40 data, and that run is the very end of the file. Recognizing it
  // lets a later edit rebuild the run where it is instead of copying the list yet again. Only an
  // exact match of that layout counts, so a game file can never be mistaken for one and truncated.
  const listEnd = listOffset + count * ITEM;
  let appendedFrom: number | null = null;
  let tailStart: number | null = null;
  let first = count;
  while (first > 0 && rows[first - 1].nameOffset >= listEnd) first -= 1;
  if (first < count && first > 0 && (listOffset - 0x10) % 16 === 0) {
    const before = rows.slice(0, first).every((row) => row.nameOffset < listOffset - 0x10 && (row.extOffset === null || row.extOffset < listOffset - 0x10));
    let cursor = listEnd;
    let exact = true;
    for (const row of rows.slice(first)) {
      if (row.nameOffset !== cursor) { exact = false; break; }
      cursor = align16(cursor + row.name.length + 1);
      if (row.extOffset !== null) { if (row.extOffset !== cursor) { exact = false; break; } cursor += EXT_STRUCT_SIZE; }
    }
    if (before && exact && cursor === bytes.length) { appendedFrom = first; tailStart = listOffset - 0x10; }
  }

  const bumpers: number[] = [], slots: [number, number][] = [], positions: [ExhaustVec, ExhaustVec][] = [];
  const vec = (o: number): ExhaustVec => [view.getFloat32(o, true), view.getFloat32(o + 4, true), view.getFloat32(o + 8, true)];
  for (let g = 0; g < GROUPS; g += 1) {
    bumpers.push(view.getInt32(REAR_BUMPERS + g * 4, true));
    slots.push([view.getInt32(SLOTS + g * 8, true), view.getInt32(SLOTS + g * 8 + 4, true)]);
    positions.push([vec(EXHAUSTS + g * 0x18), vec(EXHAUSTS + g * 0x18 + 12)]);
  }
  return { bytes, view, base, header, count, field2, unk, listOffset, rows, appendedFrom, tailStart, bumpers, slots, positions };
}

const isZero = (v: ExhaustVec) => v.every((n) => n === 0);

function underBumper(p: Parsed, anchor: number, bumper: number) {
  let cursor: number | null = anchor;
  const seen = new Set<number>();
  while (cursor !== null && cursor !== bumper && !seen.has(cursor)) { seen.add(cursor); cursor = p.rows[cursor].parent; }
  return cursor === bumper;
}

function slotUsers(p: Parsed) {
  const users = new Map<number, number>();
  for (const pair of p.slots) for (const anchor of pair) if (anchor >= 0) users.set(anchor, (users.get(anchor) ?? 0) + 1);
  return users;
}

/** Direct children of the bumper that look like exhaust anchors and no group's slot uses — the
 *  ones a tip can be switched back onto (an anchor left behind when a tip was turned off). */
function freeExhaustChildren(p: Parsed, bumper: number, users: Map<number, number>) {
  const output: { anchor: number; side: ExhaustSide }[] = [];
  for (let c = p.rows[bumper].child, guard = 0; c !== null && guard < p.count; c = p.rows[c].next, guard += 1) {
    const row = p.rows[c];
    if (users.has(c) || !(row.extOffset !== null || EXHAUST_NAME.test(row.name))) continue;
    const side = sideOf(row.a1x);
    if (side) output.push({ anchor: c, side });
  }
  return output;
}

function describe(p: Parsed): ExhaustSetup {
  const users = slotUsers(p);
  const groups: ExhaustGroup[] = [];
  for (let g = 0; g < GROUPS; g += 1) {
    const bumper = p.bumpers[g], slots = p.slots[g], positions = p.positions[g];
    if (bumper === -1 && slots[0] === -1 && slots[1] === -1 && isZero(positions[0]) && isZero(positions[1])) continue;
    const warnings: string[] = [];
    const tips: ExhaustTip[] = [];
    for (const k of [0, 1] as const) {
      if ((slots[k] === -1) !== isZero(positions[k])) warnings.push(`slot${k}/pos mismatch`);
      if (slots[k] >= 0 && bumper >= 0) {
        if (!underBumper(p, slots[k], bumper)) warnings.push(`slot${k} not under the bumper -> hidden in cruise`);
        if ((users.get(slots[k]) ?? 0) > 1) warnings.push(`slot${k} shared with another group -> hidden in cruise`);
      }
      if (slots[k] >= 0) tips.push({ slot: k, anchor: slots[k], anchorName: p.rows[slots[k]].name, position: positions[k], side: isZero(positions[k]) ? null : sideOf(positions[k][0]) });
    }
    let locked: string | null = null;
    if (bumper < 0) locked = "This group has exhaust data but no rear bumper.";
    else if (tips.some((tip) => tip.side === null)) locked = "A tip sits on the centre line (or has no position), so left and right can't be told apart.";
    else if (tips.length === 2 && tips[0].side === tips[1].side) locked = "Both tips are on the same side.";
    else if (!tips.length && !freeExhaustChildren(p, bumper, users).length) locked = "This bumper has no exhaust anchor to copy a tip from.";
    groups.push({
      group: g, bumper, bumperName: bumper >= 0 ? p.rows[bumper].name : "", slots: [slots[0], slots[1]], positions: [positions[0], positions[1]], tips,
      left: tips.some((tip) => tip.side === "left"), right: tips.some((tip) => tip.side === "right"), locked, warnings,
    });
  }
  return {
    anchorCount: p.count, field2: p.field2, unk: p.unk, cookie: p.view.getUint32(p.listOffset - 0x10, true), tailCount: p.view.getUint16(TAIL_COUNT, true),
    appendedFrom: p.appendedFrom, groups, noSlots: p.slots.every(([a, b]) => a === -1 && b === -1),
  };
}

/** Reads the exhaust setup of one car PCK. Throws, with the reason, on a layout it doesn't know. */
export function readExhaustSetup(bytes: Uint8Array): ExhaustSetup { return describe(parse(bytes)); }

type NewAnchor = { group: number; template: number; bumper: number; side: ExhaustSide; slot: 0 | 1; position: ExhaustVec };

/**
 * Applies the wanted on/off state to one car PCK and returns the new bytes. Always works from the
 * bytes given, so passing the file as it was opened plus the current checkboxes is the whole edit.
 */
export function applyExhaustChoices(source: Uint8Array, choices: ExhaustChoices): ExhaustEditResult {
  const p = parse(source);
  const setup = describe(p);
  const out = source.slice();
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const users = slotUsers(p);
  const writeVec = (o: number, v: ExhaustVec) => v.forEach((n, i) => view.setFloat32(o + i * 4, n, true));
  const mirror = (v: ExhaustVec): ExhaustVec => [-v[0], v[1], v[2]];
  const newAnchors: NewAnchor[] = [];
  /** Existing anchors switched to the other side: their A1/A2/+0x40 X is mirrored with the tip. */
  const flipped = new Set<number>();
  const slotWrites: { group: number; slot: 0 | 1; anchor: number; position: ExhaustVec }[] = [];

  for (const [key, wanted] of Object.entries(choices)) {
    const g = Number(key);
    const group = setup.groups.find((item) => item.group === g);
    if (!group) fail(`Group ${g} has no rear bumper here.`);
    if (wanted.left === group!.left && wanted.right === group!.right) continue;
    if (group!.locked) fail(`Group ${g} (${group!.bumperName}) can't be changed: ${group!.locked}`);
    // What already sits on each side: the group's own tip, or else a spare exhaust anchor under the
    // bumper (one a previous edit turned off). A spare is placed at its own A1.
    type Source = { slot: 0 | 1 | null; anchor: number; position: ExhaustVec };
    const spares = freeExhaustChildren(p, group!.bumper, users);
    const existing = (side: ExhaustSide): Source | undefined => {
      const own = group!.tips.find((item) => item.side === side);
      if (own) return { slot: own.slot, anchor: own.anchor, position: own.position };
      const spare = spares.find((item) => item.side === side);
      if (!spare) return undefined;
      const o = p.listOffset + spare.anchor * ITEM;
      return { slot: null, anchor: spare.anchor, position: [p.view.getFloat32(o, true), p.view.getFloat32(o + 4, true), p.view.getFloat32(o + 8, true)] };
    };
    type Plan = { slot: 0 | 1 | null; anchor: number | null; position: ExhaustVec; template?: number; flip?: boolean };
    const plans = new Map<ExhaustSide, Plan>();
    for (const side of ["left", "right"] as ExhaustSide[]) {
      if (!wanted[side]) continue;
      const here = existing(side);
      if (here) { plans.set(side, here); continue; }
      // Nothing on this side: mirror the other side's tip — moving it across when that side is
      // being turned off, appending a new anchor when both stay on.
      const other = otherSide(side);
      const source = existing(other);
      if (!source) fail(`Group ${g} (${group!.bumperName}) has no tip to mirror onto the ${side}.`);
      plans.set(side, wanted[other]
        ? { slot: null, anchor: null, position: mirror(source!.position), template: source!.anchor }
        : { slot: source!.slot, anchor: source!.anchor, position: mirror(source!.position), flip: true });
    }
    // Tips that keep their slot first; the rest take the lowest free one; unclaimed slots are cleared.
    const taken: [boolean, boolean] = [false, false];
    for (const plan of plans.values()) if (plan.slot !== null) taken[plan.slot] = true;
    for (const [side, plan] of plans) {
      let slot = plan.slot;
      if (slot === null) { slot = taken[0] ? 1 : 0; if (taken[slot]) fail(`Group ${g} has no free slot left.`); taken[slot] = true; }
      if (plan.anchor === null) newAnchors.push({ group: g, template: plan.template!, bumper: group!.bumper, side, slot, position: plan.position });
      else { slotWrites.push({ group: g, slot, anchor: plan.anchor, position: plan.position }); if (plan.flip) flipped.add(plan.anchor); }
    }
    for (const k of [0, 1] as const) if (!taken[k]) slotWrites.push({ group: g, slot: k, anchor: -1, position: [0, 0, 0] });
  }

  for (const write of slotWrites) {
    view.setInt32(SLOTS + write.group * 8 + write.slot * 4, write.anchor, true);
    writeVec(EXHAUSTS + write.group * 0x18 + write.slot * 12, write.position);
  }
  // A tip moved to the other side takes its anchor with it, so the anchor (and the +0x40 points the
  // game keeps next to it) still describe where the tip is, as a mirrored copy would.
  for (const anchor of flipped) {
    const o = p.listOffset + anchor * ITEM;
    for (const field of [0x00, 0x20]) view.setFloat32(o + field, -view.getFloat32(o + field, true), true);
    const ext = p.rows[anchor].extOffset;
    if (ext !== null) for (const field of [0x18, 0x24]) view.setFloat32(ext + field, -view.getFloat32(ext + field, true), true);
  }

  if (!newAnchors.length) return { bytes: out, changed: !sameBytes(out, source), added: [], listCopied: false };
  return appendAnchors(p, out, newAnchors);
}

/**
 * Appends anchors at the end of the list: the list is copied (with its new[] cookie) to the end of
 * the file, or rebuilt where it is when an earlier append already put it there. Byte-for-byte what
 * insert_anchor.py --at-end writes when a single anchor is added to a fresh file.
 */
function appendAnchors(p: Parsed, edited: Uint8Array, additions: NewAnchor[]): ExhaustEditResult {
  const { count, base, listOffset } = p;
  const total = count + additions.length;
  const kept = p.tailStart === null ? edited : edited.subarray(0, p.tailStart);
  const start = p.tailStart === null ? align16(edited.length) : p.tailStart;
  // Lay out cookie + list, then each appended anchor's name and +0x40 data, old appended ones first.
  const chunks: { offset: number; bytes: Uint8Array }[] = [];
  let cursor = start + 0x10;
  const newList = cursor;
  cursor += total * ITEM;
  const nameOffsets = new Map<number, number>(), extOffsets = new Map<number, number>();
  const editedView = new DataView(edited.buffer, edited.byteOffset, edited.byteLength);
  const encoder = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0) & 0xff);
  const placeTail = (row: number, name: string, ext: Uint8Array | null) => {
    const nameBytes = new Uint8Array(name.length + 1); nameBytes.set(encoder(name));
    nameOffsets.set(row, cursor); chunks.push({ offset: cursor, bytes: nameBytes }); cursor = align16(cursor + nameBytes.length);
    if (ext) { extOffsets.set(row, cursor); chunks.push({ offset: cursor, bytes: ext }); cursor += ext.length; }
  };
  for (let i = p.appendedFrom ?? count; i < count; i += 1) {
    const row = p.rows[i];
    placeTail(i, row.name, row.extOffset === null ? null : edited.slice(row.extOffset, row.extOffset + EXT_STRUCT_SIZE));
  }
  additions.forEach((addition, k) => {
    const template = p.rows[addition.template];
    let ext: Uint8Array | null = null;
    if (template.extOffset !== null) {
      ext = edited.slice(template.extOffset, template.extOffset + EXT_STRUCT_SIZE);
      const extView = new DataView(ext.buffer);
      for (const field of [0x18, 0x24]) extView.setFloat32(field, -extView.getFloat32(field, true), true);
    }
    placeTail(count + k, mirroredAnchorName(template.name), ext);
  });

  const out = new Uint8Array(cursor);
  out.set(kept);
  out.fill(0xcd, kept.length, cursor);
  const view = new DataView(out.buffer);
  for (const chunk of chunks) out.set(chunk.bytes, chunk.offset);
  view.setUint32(start, total, true);
  const va = (row: number) => (newList + row * ITEM + base) >>> 0;
  const fileToVa = (offset: number) => (offset + base) >>> 0;

  // Existing rows, links rewritten to the new list; their own index at +0x38 as insert_anchor writes it.
  for (let i = 0; i < count; i += 1) {
    const o = newList + i * ITEM;
    out.set(edited.subarray(listOffset + i * ITEM, listOffset + (i + 1) * ITEM), o);
    const links = [[0x14, p.rows[i].next], [0x18, p.rows[i].child], [0x1c, p.rows[i].parent]] as const;
    for (const [field, target] of links) if (target !== null) view.setUint32(o + field, va(target), true);
    view.setUint16(o + 0x38, i, true);
    if (nameOffsets.has(i)) view.setUint32(o + 0x0c, fileToVa(nameOffsets.get(i)!), true);
    if (extOffsets.has(i)) view.setUint32(o + 0x40, fileToVa(extOffsets.get(i)!), true);
  }
  // New rows: the template mirrored on X, a child of the bumper, appended after its last child.
  const lastChild = new Map<number, number | null>();
  const nextOf = (row: number) => { const v = view.getUint32(newList + row * ITEM + 0x14, true); return v ? (v - base - newList) / ITEM : null; };
  const added: ExhaustEditResult["added"] = [];
  additions.forEach((addition, k) => {
    const row = count + k;
    const o = newList + row * ITEM;
    out.set(edited.subarray(listOffset + addition.template * ITEM, listOffset + (addition.template + 1) * ITEM), o);
    for (const field of [0x00, 0x20]) view.setFloat32(o + field, -view.getFloat32(o + field, true), true);
    view.setUint32(o + 0x0c, fileToVa(nameOffsets.get(row)!), true);
    view.setUint32(o + 0x14, 0, true);
    view.setUint32(o + 0x18, 0, true);
    view.setUint32(o + 0x1c, va(addition.bumper), true);
    view.setUint16(o + 0x38, row, true);
    view.setUint32(o + 0x40, extOffsets.has(row) ? fileToVa(extOffsets.get(row)!) : 0, true);
    let last = lastChild.get(addition.bumper);
    if (last === undefined) {
      last = null;
      const childPointer = view.getUint32(newList + addition.bumper * ITEM + 0x18, true);
      for (let c: number | null = childPointer ? (childPointer - base - newList) / ITEM : null; c !== null; c = nextOf(c)) last = c;
    }
    if (last === null) view.setUint32(newList + addition.bumper * ITEM + 0x18, va(row), true);
    else view.setUint32(newList + last * ITEM + 0x14, va(row), true);
    lastChild.set(addition.bumper, row);
    view.setInt32(SLOTS + addition.group * 8 + addition.slot * 4, row, true);
    addition.position.forEach((n, i) => view.setFloat32(EXHAUSTS + addition.group * 0x18 + addition.slot * 12 + i * 4, n, true));
    added.push({ group: addition.group, index: row, name: mirroredAnchorName(p.rows[addition.template].name), side: addition.side });
  });

  // Counts: anchor header (+3 per anchor in field2/unk, as validated in game), 0x3F8, file size.
  view.setUint16(p.header, total, true);
  view.setUint16(p.header + 2, (p.field2 + 3 * additions.length) & 0xff, true);
  view.setUint32(p.header + 4, p.unk + 3 * additions.length, true);
  view.setUint32(p.header + 8, fileToVa(newList), true);
  view.setUint16(TAIL_COUNT, total, true);
  view.setUint32(0x0c, out.length - 0x80, true);
  return { bytes: out, changed: true, added, listCopied: p.tailStart === null };
}

function sameBytes(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}
