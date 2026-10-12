/**
 * Reads the menu arrays of an MC3 flash `.pck` the way the game builds them: by running the movie's
 * main AVM1 script and reading `_global` afterwards.
 *
 * Why not read the first `Push` of each array (what src/flash-avm1.ts does): the VIP edits a flash
 * by appending a bigger copy of the main script at the end of the file and repointing `+0xDC` at it,
 * often redefining an array item by item (`_global.X = new Array(0); _global.X[i] = v; ...`). The
 * old script stays in the file, orphaned. Only executing the script `+0xDC` points at gives the
 * values the game uses (KB §20.5–20.6).
 *
 * The main menu scripts are linear, so this is a tiny stack machine with just the opcodes they use:
 * Push, GetVariable, GetMember, SetMember, NewObject, Pop, ConstantPool, Stop, End — plus the no-op
 * fillers editors leave behind (0x01 from the VIP; 0x4C 0x17 pairs and a lone 0x28 from this app's
 * Flash Menu Editor). Anything else, branches included, is refused rather than guessed at.
 */

export const FLASH_HEADER_SIZE = 0x80;
/** File offset of the pointer to the movie's main script. */
export const MAIN_SCRIPT_POINTER = 0xdc;
/** An action list starts with two bytes before its first action. */
export const ACTION_LIST_PREFIX = 2;

/** A pushed or stored scalar, keeping the AVM1 type it was written with so it can be re-emitted. */
export type AvmScalar =
  | { kind: "string"; value: string }
  | { kind: "int"; value: number }
  | { kind: "float"; value: number }
  | { kind: "double"; value: number }
  | { kind: "bool"; value: boolean }
  | { kind: "null" }
  | { kind: "undefined" };
type AvmArray = { kind: "array"; items: AvmValue[] };
type AvmObject = { kind: "object"; members: Map<string, AvmValue> };
type AvmValue = AvmScalar | AvmArray | AvmObject;

export type FlashAction = { offset: number; opcode: number; payload: Uint8Array; size: number };
export type MainScript = {
  /** File offset of the action list (its 2-byte prefix). */
  listOffset: number;
  actions: FlashAction[];
  pool: string[];
};

const UNDEFINED: AvmScalar = { kind: "undefined" };

const u16 = (bytes: Uint8Array, offset: number) => bytes[offset] | (bytes[offset + 1] << 8);
const u32 = (bytes: Uint8Array, offset: number) => (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;

/** File offset of a virtual address in a flash `.pck` (VA base = `u32@0 - 0x80`). */
export function flashFileOffset(bytes: Uint8Array, va: number) { return va - (u32(bytes, 0) - FLASH_HEADER_SIZE); }
export function flashVirtualAddress(bytes: Uint8Array, offset: number) { return (offset + u32(bytes, 0) - FLASH_HEADER_SIZE) >>> 0; }

/** The container checks every flash `.pck` passes (KB §20.5): version 5 or 6, flag 1, size field. */
export function checkFlashContainer(bytes: Uint8Array, label = "flash file") {
  if (bytes.length < MAIN_SCRIPT_POINTER + 4) throw new Error(`${label} is too small to be a flash .pck.`);
  const version = u32(bytes, 4), flag = u32(bytes, 8), size = u32(bytes, 0x0c);
  if (!(version === 5 || version === 6) || flag !== 1 || size !== bytes.length - FLASH_HEADER_SIZE) {
    throw new Error(`${label} is not a flash .pck (header ${version}/${flag}/${size} for ${bytes.length} bytes).`);
  }
}

const latin1 = (bytes: Uint8Array) => { let out = ""; for (const byte of bytes) out += String.fromCharCode(byte); return out; };

/** Decodes the main script's action list, stopping at its End. */
export function readMainScript(bytes: Uint8Array, label = "flash file"): MainScript {
  checkFlashContainer(bytes, label);
  const listOffset = flashFileOffset(bytes, u32(bytes, MAIN_SCRIPT_POINTER));
  if (listOffset < FLASH_HEADER_SIZE || listOffset + ACTION_LIST_PREFIX >= bytes.length) throw new Error(`${label}: the main script pointer (+0xDC) points outside the file.`);
  const actions: FlashAction[] = [];
  let pool: string[] = [];
  let pos = listOffset + ACTION_LIST_PREFIX;
  for (;;) {
    if (pos >= bytes.length) throw new Error(`${label}: the main script runs past the end of the file without an End action.`);
    const opcode = bytes[pos];
    let size = 1, payload: Uint8Array = new Uint8Array(0);
    if (opcode >= 0x80) {
      if (pos + 3 > bytes.length) throw new Error(`${label}: truncated action at 0x${pos.toString(16)}.`);
      const length = u16(bytes, pos + 1);
      if (pos + 3 + length > bytes.length) throw new Error(`${label}: an action at 0x${pos.toString(16)} runs past the end of the file.`);
      payload = bytes.subarray(pos + 3, pos + 3 + length);
      size = 3 + length;
    }
    if (opcode === 0x88) {
      const count = u16(payload, 0);
      const strings: string[] = [];
      let at = 2;
      for (let i = 0; i < count; i++) {
        const end = payload.indexOf(0, at);
        if (end < 0) throw new Error(`${label}: damaged constant pool at 0x${pos.toString(16)}.`);
        strings.push(latin1(payload.subarray(at, end)));
        at = end + 1;
      }
      pool = strings;
    }
    actions.push({ offset: pos, opcode, payload, size });
    if (opcode === 0x00) break;
    pos += size;
  }
  return { listOffset, actions, pool };
}

function pushValues(payload: Uint8Array, pool: string[], at: number): AvmScalar[] {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const values: AvmScalar[] = [];
  let i = 0;
  const poolString = (index: number) => {
    if (index >= pool.length) throw new Error(`Push at 0x${at.toString(16)} references constant ${index}, but the pool has ${pool.length}.`);
    return pool[index];
  };
  while (i < payload.length) {
    const type = payload[i++];
    switch (type) {
      case 0: {
        const end = payload.indexOf(0, i);
        if (end < 0) throw new Error(`Unterminated string in the Push at 0x${at.toString(16)}.`);
        values.push({ kind: "string", value: latin1(payload.subarray(i, end)) });
        i = end + 1;
        break;
      }
      case 1: values.push({ kind: "float", value: view.getFloat32(i, true) }); i += 4; break;
      case 2: values.push({ kind: "null" }); break;
      case 3: values.push(UNDEFINED); break;
      case 5: values.push({ kind: "bool", value: payload[i] !== 0 }); i += 1; break;
      case 6: {
        // AVM1 stores a double as its two 32-bit halves swapped.
        const swapped = new DataView(new ArrayBuffer(8));
        swapped.setUint32(0, view.getUint32(i + 4, true), true);
        swapped.setUint32(4, view.getUint32(i, true), true);
        values.push({ kind: "double", value: swapped.getFloat64(0, true) });
        i += 8;
        break;
      }
      case 7: values.push({ kind: "int", value: view.getInt32(i, true) }); i += 4; break;
      case 8: values.push({ kind: "string", value: poolString(payload[i]) }); i += 1; break;
      case 9: values.push({ kind: "string", value: poolString(view.getUint16(i, true)) }); i += 2; break;
      default: throw new Error(`Push at 0x${at.toString(16)} uses value type ${type}, which menu scripts don't.`);
    }
  }
  return values;
}

/** Property key the way AVM1 indexes: integral numbers and digit strings become array indices. */
function asKey(value: AvmValue): string | number {
  if (value.kind === "int") return value.value;
  if (value.kind === "float" || value.kind === "double") return Number.isInteger(value.value) ? value.value : String(value.value);
  if (value.kind === "string") return /^\d+$/.test(value.value) ? Number(value.value) : value.value;
  if (value.kind === "bool") return String(value.value);
  if (value.kind === "null") return "null";
  if (value.kind === "undefined") return "undefined";
  throw new Error("An object or array was used as a property name.");
}

function asCount(value: AvmValue) {
  const key = asKey(value);
  if (typeof key !== "number" || key < 0) throw new Error(`Expected a count, got ${JSON.stringify(key)}.`);
  return key;
}

export type FlashArrays = Map<string, AvmScalar[]>;

/** Runs the main script and returns every `_global` array, items in menu order. Non-scalar items
 *  (an array inside an array) are refused — menu arrays hold strings and numbers only. */
export function runFlashArrays(bytes: Uint8Array, label = "flash file"): FlashArrays {
  const script = readMainScript(bytes, label);
  const global: AvmObject = { kind: "object", members: new Map() };
  const stack: AvmValue[] = [];
  const pop = (at: number): AvmValue => {
    const value = stack.pop();
    if (value === undefined) throw new Error(`${label}: stack underflow at 0x${at.toString(16)}.`);
    return value;
  };
  for (const action of script.actions) {
    const at = action.offset;
    switch (action.opcode) {
      case 0x96: stack.push(...pushValues(action.payload, script.pool, at)); break;
      case 0x1c: { // GetVariable
        const name = pop(at);
        stack.push(name.kind === "string" && name.value === "_global" ? global : global.members.get(String(asKey(name))) ?? UNDEFINED);
        break;
      }
      case 0x4e: { // GetMember
        const key = asKey(pop(at));
        const target = pop(at);
        if (target.kind === "array") stack.push(typeof key === "number" ? target.items[key] ?? UNDEFINED : key === "length" ? { kind: "int", value: target.items.length } : UNDEFINED);
        else if (target.kind === "object") stack.push(target.members.get(String(key)) ?? UNDEFINED);
        else stack.push(UNDEFINED);
        break;
      }
      case 0x4f: { // SetMember
        const value = pop(at);
        const key = asKey(pop(at));
        const target = pop(at);
        if (target.kind === "array") {
          if (key === "length") {
            const length = asCount(value);
            target.items.length = Math.min(target.items.length, length);
            while (target.items.length < length) target.items.push(UNDEFINED);
          } else if (typeof key === "number") {
            while (target.items.length <= key) target.items.push(UNDEFINED);
            target.items[key] = value;
          }
        } else if (target.kind === "object") target.members.set(String(key), value);
        break;
      }
      case 0x40: { // NewObject
        const className = pop(at);
        const count = asCount(pop(at));
        const args: AvmValue[] = [];
        for (let i = 0; i < count; i++) args.push(pop(at));
        if (className.kind === "string" && className.value === "Array") {
          // new Array(n) with one numeric argument makes n empty slots; anything else lists the items.
          const single = args.length === 1 && args[0].kind !== "string" ? asKey(args[0]) : null;
          stack.push({ kind: "array", items: typeof single === "number" ? Array.from({ length: single }, () => UNDEFINED) : args });
        } else stack.push({ kind: "object", members: new Map() });
        break;
      }
      case 0x17: pop(at); break; // Pop
      case 0x4c: stack.push(stack[stack.length - 1] ?? UNDEFINED); break; // PushDuplicate (filler pair with Pop)
      case 0x88: case 0x00: case 0x07: case 0x01: case 0x28: break; // ConstantPool, End, Stop, no-op fillers
      default: throw new Error(`${label}: the main script uses opcode 0x${action.opcode.toString(16).padStart(2, "0")} at 0x${at.toString(16)}, which this reader doesn't run.`);
    }
  }
  const arrays: FlashArrays = new Map();
  for (const [name, value] of global.members) {
    if (value.kind !== "array") continue;
    arrays.set(name, value.items.map((item) => {
      if (item.kind === "array" || item.kind === "object") throw new Error(`${label}: _global.${name} holds a nested object.`);
      return item;
    }));
  }
  return arrays;
}

/** An item as text, the way the menus use it (tokens, prices, statuses). */
export function scalarText(value: AvmScalar) {
  switch (value.kind) {
    case "string": return value.value;
    case "int": case "float": case "double": return String(value.value);
    case "bool": return String(value.value);
    default: return value.kind;
  }
}

export const sameScalar = (a: AvmScalar, b: AvmScalar) => a.kind === b.kind && ("value" in a ? a.value === (b as typeof a).value : true);
export const sameScalars = (a: AvmScalar[], b: AvmScalar[]) => a.length === b.length && a.every((value, i) => sameScalar(value, b[i]));
