/**
 * Opponent `.carcfg` part-index limiter.
 *
 * A port of the precedent Python tools (`mc3_opponent_carcfg_limiter.py` and its web derivative
 * `mc3_carcfg_randomizer_web.py`), which set the range of customization indexes the AI cars are
 * allowed to use by giving every listed field a fresh random value. A field draws either from a
 * typed MIN..MAX range or from an explicit list of indexes — the ones whose part the car's garage
 * PCK actually carries (see `carcfg-parts.ts`), which are rarely one contiguous range.
 *
 * The precedent tools' `clamp` mode is gone on purpose: it could only pull values into a range,
 * and a range cannot describe a car whose usable bumpers are 0, 6..12 and 18.
 *
 * These are text files, so the rule is to touch as little of them as possible. A line is rewritten
 * only when its value actually changes, and only the digits change — the original indentation,
 * separator, trailing text and line ending are all put back exactly as they were found. Files with
 * no changed field are handed back with their original bytes, not re-encoded.
 *
 * One deliberate departure from both Python tools: they decode with `utf-8-sig` and re-encode with
 * it too, and `utf-8-sig` *always writes* a byte-order mark — so every file they changed that had
 * no BOM silently gained three bytes in front of `type: a`. This keeps a file's BOM exactly as it
 * found it. (20 of the 1086 files in the reference set carry a BOM, all of them complete opponent
 * sets for two cars: the residue of an earlier run of the original script.)
 */

import { PythonRandom } from "./python-random";

/** `allowed`, when given, replaces the MIN..MAX range: the field draws only from these indexes.
 *  `fixed`, when given, replaces both: every file gets exactly that value and nothing is drawn. */
export type CarcfgParameter = { key: string; min: number; max: number; allowed?: number[]; fixed?: number };
type Limit = { min: number; max: number; allowed: number[] | null; fixed: number | null };
export type CarcfgEncoding = "utf-8" | "cp1252" | "latin-1";

export type CarcfgOccurrence = {
  value: number;
  line: number;
  /** True when the text after the integer starts a fraction, i.e. the field is really a float and
   *  the pattern only matched its whole part. Writing an index over `-2.500000` would leave
   *  `3.500000`. Both Python tools do exactly that; surfacing it lets the UI warn instead. */
  fractional: boolean;
};
export type CarcfgField = { key: string; present: boolean; occurrences: CarcfgOccurrence[]; outsideRange: number };
export type CarcfgScan = {
  encoding: CarcfgEncoding;
  hasBom: boolean;
  fields: CarcfgField[];
  present: number;
  missing: number;
  outsideRange: number;
};

/** `oldAllowed` is false when the old value sat outside what the field draws from; a fixed field
 *  only ever overwrites, so its old value is never flagged. */
export type CarcfgChange = { key: string; oldValue: number; newValue: number; line: number; oldAllowed: boolean };
export type CarcfgResult = {
  bytes: Uint8Array;
  changed: boolean;
  changes: CarcfgChange[];
  missingKeys: string[];
  fieldsSeen: number;
};

/** The precedent tools' line pattern, unchanged: indent, key, separator, integer, trailing, newline. */
const LINE_RE = /^(\s*)([A-Za-z_][A-Za-z0-9_]*)(\s+)(-?\d+)([^\r\n]*)(\r?\n?)$/;
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Everything Python's str.splitlines() treats as a break, so line numbers agree with the original. */
const LINE_BREAK = /\r\n|[\n\r\v\f\u001c\u001d\u001e\u0085\u2028\u2029]/g;
const BOM = [0xef, 0xbb, 0xbf];

/** cp1252's 0x80-0x9F block. The five gaps are undefined in the codec and make a decode fail,
 *  which is what sends Python on to latin-1 — so they have to fail here too. */
const CP1252_HIGH =
  "\u20AC\uFFFD\u201A\u0192\u201E\u2026\u2020\u2021\u02C6\u2030\u0160\u2039\u0152\uFFFD\u017D\uFFFD"
  + "\uFFFD\u2018\u2019\u201C\u201D\u2022\u2013\u2014\u02DC\u2122\u0161\u203A\u0153\uFFFD\u017E\u0178";

function decodeUtf8(bytes: Uint8Array): string | null {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return null; }
}

function decodeCp1252(bytes: Uint8Array): string | null {
  let output = "";
  for (const byte of bytes) {
    if (byte < 0x80 || byte > 0x9f) { output += String.fromCharCode(byte); continue; }
    const mapped = CP1252_HIGH[byte - 0x80];
    if (mapped === "�") return null;
    output += mapped;
  }
  return output;
}

/** One character back into a single-byte codec, with Python's errors="replace" behaviour: anything
 *  the codec cannot hold becomes "?". */
function encodeChar(character: string, encoding: "cp1252" | "latin-1") {
  const code = character.charCodeAt(0);
  if (code <= 0x7f) return code;
  if (encoding === "latin-1") return code <= 0xff ? code : 0x3f;
  if (code >= 0xa0 && code <= 0xff) return code;
  const high = character === "�" ? -1 : CP1252_HIGH.indexOf(character);
  return high >= 0 ? 0x80 + high : 0x3f;
}

/** Mirrors the precedent tools' encoding ladder, with the BOM tracked separately instead of being
 *  baked into the codec name. */
export function decodeCarcfg(bytes: Uint8Array): { text: string; encoding: CarcfgEncoding; hasBom: boolean } {
  const hasBom = bytes.length >= 3 && BOM.every((byte, index) => bytes[index] === byte);
  const body = hasBom ? bytes.subarray(3) : bytes;
  const utf8 = decodeUtf8(body);
  if (utf8 !== null) return { text: utf8, encoding: "utf-8", hasBom };
  const cp1252 = decodeCp1252(body);
  if (cp1252 !== null) return { text: cp1252, encoding: "cp1252", hasBom: false };
  let latin = "";
  for (const byte of body) latin += String.fromCharCode(byte);
  return { text: latin, encoding: "latin-1", hasBom: false };
}

export function encodeCarcfg(text: string, encoding: CarcfgEncoding, hasBom: boolean): Uint8Array {
  let body: Uint8Array;
  if (encoding === "utf-8") {
    body = new TextEncoder().encode(text);
  } else {
    const out = new Uint8Array(text.length);
    for (let index = 0; index < text.length; index += 1) out[index] = encodeChar(text[index], encoding);
    body = out;
  }
  if (!hasBom) return body;
  const withBom = new Uint8Array(body.length + 3);
  withBom.set(BOM);
  withBom.set(body, 3);
  return withBom;
}

/** Splits like Python's splitlines(keepends=True): every break stays attached to its own line. */
function splitLines(text: string): string[] {
  const lines: string[] = [];
  let start = 0;
  LINE_BREAK.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = LINE_BREAK.exec(text)) !== null) {
    lines.push(text.slice(start, match.index + match[0].length));
    start = match.index + match[0].length;
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}

const isIndex = (value: number) => Number.isInteger(value) && value >= 0;

/** Validates and de-duplicates the limiter parameters, keeping the order they were given in. */
export function normalizeParameters(parameters: CarcfgParameter[]): Map<string, Limit> {
  const result = new Map<string, Limit>();
  for (const parameter of parameters) {
    const key = parameter.key.trim();
    if (!KEY_RE.test(key)) throw new Error(`Invalid CarCfg field name: ${key || "(empty)"}`);
    if (parameter.fixed !== undefined) {
      if (!isIndex(parameter.fixed)) throw new Error(`${key}: the fixed value must be a non-negative integer`);
      result.set(key, { min: 0, max: 0, allowed: null, fixed: parameter.fixed });
      continue;
    }
    if (parameter.allowed) {
      if (!parameter.allowed.length) throw new Error(`${key}: no index is left to draw from`);
      if (!parameter.allowed.every(isIndex)) throw new Error(`${key}: allowed indexes must be non-negative integers`);
      // Sorted and de-duplicated, so the same set always maps the same draws to the same values.
      result.set(key, { min: 0, max: 0, allowed: [...new Set(parameter.allowed)].sort((a, b) => a - b), fixed: null });
      continue;
    }
    if (!isIndex(parameter.min) || !isIndex(parameter.max)) throw new Error(`${key}: MIN and MAX must be non-negative integers`);
    if (parameter.min > parameter.max) throw new Error(`${key}: MIN cannot be greater than MAX`);
    result.set(key, { min: parameter.min, max: parameter.max, allowed: null, fixed: null });
  }
  if (!result.size) throw new Error("Add at least one limiter parameter.");
  return result;
}

function isAllowed(limit: Limit, value: number) {
  if (limit.fixed !== null) return value === limit.fixed;
  return limit.allowed ? limit.allowed.includes(value) : value >= limit.min && value <= limit.max;
}

/** A range draws with `randint(min, max)` — with MIN at 0 that is exactly the precedent tools'
 *  draw, so their seeds still reproduce. A list draws with `choice`, as Python would. A fixed value draws
 *  nothing, so switching one on or off never shifts what a seed gives the other fields. */
function draw(limit: Limit, rng: PythonRandom) {
  if (limit.fixed !== null) return limit.fixed;
  return limit.allowed ? rng.choice(limit.allowed) : rng.randint(limit.min, limit.max);
}

/** Reads what a file holds for each parameter, without changing anything. */
export function scanCarcfg(bytes: Uint8Array, parameters: CarcfgParameter[]): CarcfgScan {
  const limits = normalizeParameters(parameters);
  const { text, encoding, hasBom } = decodeCarcfg(bytes);
  const found = new Map<string, CarcfgOccurrence[]>([...limits.keys()].map((key) => [key, []]));
  splitLines(text).forEach((line, index) => {
    const match = LINE_RE.exec(line);
    if (!match) return;
    const hits = found.get(match[2]);
    if (!hits) return;
    hits.push({ value: parseInt(match[4], 10), line: index + 1, fractional: /^\.\d/.test(match[5]) });
  });
  const fields: CarcfgField[] = [...limits].map(([key, limit]) => {
    const occurrences = found.get(key)!;
    return {
      key, occurrences,
      present: occurrences.length > 0,
      outsideRange: occurrences.filter((hit) => !isAllowed(limit, hit.value)).length,
    };
  });
  return {
    encoding, hasBom, fields,
    present: fields.filter((field) => field.present).length,
    missing: fields.filter((field) => !field.present).length,
    outsideRange: fields.reduce((sum, field) => sum + field.outsideRange, 0),
  };
}

/**
 * Applies the limiter to one file's bytes and hands back the result, writing nothing.
 *
 * `rng` is threaded in rather than created here because the precedent tools draw from a single
 * stream across every file in a run — giving each file its own generator would produce a different
 * result for the same seed.
 */
export function processCarcfg(bytes: Uint8Array, parameters: CarcfgParameter[], rng: PythonRandom): CarcfgResult {
  const limits = normalizeParameters(parameters);
  const { text, encoding, hasBom } = decodeCarcfg(bytes);
  const changes: CarcfgChange[] = [];
  const seen = new Set<string>();
  const output: string[] = [];

  splitLines(text).forEach((line, index) => {
    const match = LINE_RE.exec(line);
    if (!match || !limits.has(match[2])) { output.push(line); return; }
    const [, indent, key, separator, valueText, trailing, newline] = match;
    const oldValue = parseInt(valueText, 10);
    const limit = limits.get(key)!;
    seen.add(key);
    const newValue = draw(limit, rng);
    if (oldValue !== newValue) changes.push({ key, oldValue, newValue, line: index + 1, oldAllowed: limit.fixed !== null || isAllowed(limit, oldValue) });
    output.push(`${indent}${key}${separator}${newValue}${trailing}${newline}`);
  });

  return {
    // An unchanged file keeps its original bytes: re-encoding it could only introduce differences.
    bytes: changes.length ? encodeCarcfg(output.join(""), encoding, hasBom) : bytes,
    changed: changes.length > 0,
    changes,
    missingKeys: [...limits.keys()].filter((key) => !seen.has(key)),
    fieldsSeen: seen.size,
  };
}

/** The car a `.carcfg` belongs to, from its `TypeName` line — used to catch a garage PCK loaded
 *  for a different car than the setups being randomized. */
export function readCarcfgTypeName(bytes: Uint8Array): string | null {
  const match = /^\s*TypeName\s+(\S+)/m.exec(decodeCarcfg(bytes).text);
  return match ? match[1] : null;
}
