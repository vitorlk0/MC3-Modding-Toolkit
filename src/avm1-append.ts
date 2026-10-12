import {
  ACTION_LIST_PREFIX, FLASH_HEADER_SIZE, MAIN_SCRIPT_POINTER, flashFileOffset, flashVirtualAddress, readMainScript,
  runFlashArrays, sameScalars, type AvmScalar,
} from "./avm1-run";

/**
 * Redefines menu arrays in an MC3 flash `.pck` — the VIP's technique, as its author's `mc3edit`
 * (EditSession with allow_growth, relocate mode) does it:
 *
 *   1. the main script is copied, with `_global.<Array> = new Array(items...)` statements added
 *      before its End, to the end of the file (aligned to 4 with 0xCD, its 2-byte list prefix kept);
 *   2. every pointer to the old list is repointed at the copy — found by walking the movie's object
 *      graph (frame commands, clip events, button actions), never by scanning for values;
 *   3. the header size field (+0x0C) is updated. The old script stays in the file, orphaned.
 *
 * Nothing already in the file moves, so every other baked pointer stays valid. Each statement has
 * the shape of the original menu scripts (items stacked in reverse, an i32 count, NewObject,
 * SetMember), so the result runs the same way the shipped arrays do. This is the write path the
 * slot-retarget test (Roadmap 08) used and that was approved in game.
 */

/** Limits from the VIP author's manual: more arguments per NewObject corrupt the player, and a
 *  script must stay under 9,999 actions. */
export const MAX_ARRAY_ITEMS = 120;
export const MAX_SCRIPT_ACTIONS = 9999;

const u8 = (bytes: Uint8Array, offset: number) => bytes[offset];
const u16 = (bytes: Uint8Array, offset: number) => bytes[offset] | (bytes[offset + 1] << 8);
const u32 = (bytes: Uint8Array, offset: number) => (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
const i32 = (bytes: Uint8Array, offset: number) => u32(bytes, offset) | 0;

/** Pointer fields that lead to each action list, by the list's file offset (its prefix). A port of
 *  mc3pck's `actionlist_refs`: the only things pointing at an action list are these fields. */
export function actionListRefs(bytes: Uint8Array): Map<number, number[]> {
  const pointer = (field: number) => {
    if (field < 0 || field + 4 > bytes.length) return null;
    const value = u32(bytes, field);
    if (value === 0) return null;
    const offset = flashFileOffset(bytes, value);
    return offset >= 0 && offset < bytes.length ? offset : null;
  };
  const objects: { offset: number; type: number }[] = [];
  const table = pointer(FLASH_HEADER_SIZE + 0x10);
  const count = u16(bytes, FLASH_HEADER_SIZE + 0x2a);
  if (table !== null) {
    for (let i = 1; i < count; i++) {
      const offset = pointer(table + i * 4);
      if (offset !== null) objects.push({ offset, type: u8(bytes, offset) });
    }
  }
  const refs = new Map<number, number[]>();
  const add = (field: number) => {
    const target = pointer(field);
    if (target === null) return;
    const list = refs.get(target);
    if (list) { if (!list.includes(field)) list.push(field); } else refs.set(target, [field]);
  };
  const sprites = [FLASH_HEADER_SIZE, ...objects.filter((object) => object.type === 2).map((object) => object.offset)];
  for (const sprite of sprites) {
    const frames = pointer(sprite + 0x0c);
    if (frames === null) continue;
    const frameCount = u16(bytes, sprite + 8);
    for (let frame = 0; frame < frameCount; frame++) {
      const seen = new Set<number>();
      let command = pointer(frames + frame * 8 + 4);
      while (command !== null && !seen.has(command)) {
        seen.add(command);
        const type = u8(bytes, command);
        if (type === 3 || type === 4) add(command + 0x0c);
        else if (type === 1) {
          const events = pointer(command + 0x20);
          const eventCount = i32(bytes, command + 0x1c);
          if (events !== null && eventCount > 0 && eventCount < 4096) for (let k = 0; k < eventCount; k++) add(events + k * 0x0c + 4);
        }
        command = pointer(command + 4);
      }
    }
  }
  for (const object of objects) {
    if (object.type !== 3) continue;
    const conditions = pointer(object.offset + 0x10);
    if (conditions === null) continue;
    for (let k = 0; k < u8(bytes, object.offset + 0x0a); k++) add(conditions + k * 8 + 4);
  }
  return refs;
}

const latin1Bytes = (text: string) => {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > 0xff) throw new Error(`"${text}" has a character a flash string can't store.`);
    out[i] = code;
  }
  return out;
};

function encodeScalar(value: AvmScalar): number[] {
  const out: number[] = [];
  const view = new DataView(new ArrayBuffer(8));
  switch (value.kind) {
    case "string": out.push(0, ...latin1Bytes(value.value), 0); break;
    case "int": view.setInt32(0, value.value, true); out.push(7, ...new Uint8Array(view.buffer, 0, 4)); break;
    case "float": view.setFloat32(0, value.value, true); out.push(1, ...new Uint8Array(view.buffer, 0, 4)); break;
    case "double": {
      view.setFloat64(0, value.value, true);
      const raw = new Uint8Array(view.buffer);
      out.push(6, ...raw.subarray(4, 8), ...raw.subarray(0, 4));
      break;
    }
    case "bool": out.push(5, value.value ? 1 : 0); break;
    case "null": out.push(2); break;
    case "undefined": out.push(3); break;
  }
  return out;
}

function pushAction(values: AvmScalar[]) {
  const payload = values.flatMap(encodeScalar);
  if (payload.length > 0xffff) throw new Error("An array is too large for one Push action.");
  return [0x96, payload.length & 0xff, payload.length >> 8, ...payload];
}

/** `_global.<name> = new Array(items...)` in the shape of the shipped menu scripts — 5 actions. */
function arrayStatement(name: string, items: AvmScalar[]) {
  if (items.length > MAX_ARRAY_ITEMS) throw new Error(`${name} would have ${items.length} items; a flash array can be built with at most ${MAX_ARRAY_ITEMS}.`);
  return [
    ...pushAction([{ kind: "string", value: "_global" }]),
    0x1c, // GetVariable
    ...pushAction([{ kind: "string", value: name }, ...[...items].reverse(), { kind: "int", value: items.length }, { kind: "string", value: "Array" }]),
    0x40, // NewObject
    0x4f, // SetMember
  ];
}

export type FlashRewrite = { bytes: Uint8Array; actions: number; arrays: string[] };

/**
 * Returns a copy of `source` whose main script also (re)defines `arrays`, in the order given, and
 * proves it: the result is run again and every array must come out as asked, every other array as
 * it was. Throws — with nothing returned — if anything doesn't hold.
 */
export function rewriteFlashArrays(source: Uint8Array, arrays: [string, AvmScalar[]][], label = "flash file"): FlashRewrite {
  const before = runFlashArrays(source, label);
  const script = readMainScript(source, label);
  const end = script.actions[script.actions.length - 1];
  if (end.opcode !== 0x00) throw new Error(`${label}: the main script doesn't end with End.`);
  if (script.actions.some((action) => action.opcode === 0x99 || action.opcode === 0x9d)) throw new Error(`${label}: the main script branches; only linear menu scripts can be rewritten.`);
  const refs = actionListRefs(source).get(script.listOffset) ?? [];
  if (!refs.includes(MAIN_SCRIPT_POINTER)) throw new Error(`${label}: the object graph doesn't reach the main script through +0xDC; the file isn't laid out like a menu flash.`);

  const body = source.subarray(script.listOffset + ACTION_LIST_PREFIX, end.offset);
  const statements = arrays.flatMap(([name, items]) => arrayStatement(name, items));
  const actionCount = script.actions.length + arrays.length * 5;
  if (actionCount >= MAX_SCRIPT_ACTIONS) throw new Error(`${label}: the main script would have ${actionCount} actions; the player handles fewer than ${MAX_SCRIPT_ACTIONS}.`);

  const padding = (4 - (source.length % 4)) % 4;
  const listOffset = source.length + padding;
  const size = listOffset + ACTION_LIST_PREFIX + body.length + statements.length + 1;
  const out = new Uint8Array(size);
  out.set(source);
  out.fill(0xcd, source.length, listOffset);
  out.set(source.subarray(script.listOffset, script.listOffset + ACTION_LIST_PREFIX), listOffset);
  out.set(body, listOffset + ACTION_LIST_PREFIX);
  out.set(statements, listOffset + ACTION_LIST_PREFIX + body.length);
  out[size - 1] = 0x00;
  const view = new DataView(out.buffer);
  const va = flashVirtualAddress(out, listOffset);
  for (const field of refs) view.setUint32(field, va, true);
  view.setUint32(0x0c, out.length - FLASH_HEADER_SIZE, true);

  // Prove it.
  const after = runFlashArrays(out, label);
  const wanted = new Map(arrays);
  if (after.size !== new Set([...before.keys(), ...wanted.keys()]).size) throw new Error(`${label}: the set of arrays changed after the rewrite.`);
  for (const [name, items] of after) {
    const expected = wanted.get(name) ?? before.get(name);
    if (!expected || !sameScalars(items, expected)) throw new Error(`${label}: ${name} didn't come out as expected after the rewrite.`);
  }
  if (readMainScript(out, label).actions.length !== actionCount) throw new Error(`${label}: the rewritten script has an unexpected number of actions.`);
  return { bytes: out, actions: actionCount, arrays: arrays.map(([name]) => name) };
}
