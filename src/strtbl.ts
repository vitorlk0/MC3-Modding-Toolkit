/**
 * MC3 string tables (`fonts/mcstrings01/02/04/08(_pal).strtbl`, modding KB §20.4): the text the game
 * shows for a key — car names (`vp_x`, `vp_x_short`), part tokens, menu labels.
 *
 *   u32 languageCount, u32 offset per language
 *   u32 512, u32 keyCount, keyCount × [u32 length, ASCII, 0]
 *   per language at its offset: u32 count, then entries:
 *     u32 hash(key), u16 flags, u32 fontLength + font, u32 charCount + UTF-16LE text,
 *     f32 scaleX, f32 scaleY, u16
 *   hash = Jenkins one-at-a-time of the key. An empty language's offset points at the end of the
 *   file, and two languages can share one section (the original tables point 6 and 7 at the same).
 *
 * Only an entry's text is ever changed. Everything else — the key list, entry order, fonts, flags,
 * scales and any bytes between sections — is carried over as it was read, so an unchanged table
 * writes back byte for byte (checked on the original disc's 8 tables).
 */

const latin1 = (bytes: Uint8Array) => { let out = ""; for (const byte of bytes) out += String.fromCharCode(byte); return out; };

/** Jenkins one-at-a-time, the hash the tables index keys by. */
export function strtblHash(key: string) {
  let h = 0;
  for (let i = 0; i < key.length; i++) {
    h = (h + key.charCodeAt(i)) >>> 0;
    h = (h + (h << 10)) >>> 0;
    h = (h ^ (h >>> 6)) >>> 0;
  }
  h = (h + (h << 3)) >>> 0;
  h = (h ^ (h >>> 11)) >>> 0;
  return (h + (h << 15)) >>> 0;
}

type Entry = { hash: number; head: Uint8Array; text: Uint16Array; tail: Uint8Array };
/** One language's entries, in file order; `after` = any bytes up to the next section. */
type Section = { entries: Entry[]; after: Uint8Array };

export type StringTable = {
  keys: string[];
  /** Everything from the language offsets to the first section: key list and anything after it. */
  keyBlock: Uint8Array;
  /** Distinct sections in file order. */
  sections: Section[];
  /** Per language, the index of its section; null for an empty language. */
  languages: (number | null)[];
};

export function readStrtbl(bytes: Uint8Array, label = "string table"): StringTable {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const need = (pos: number, length: number) => { if (pos + length > bytes.length) throw new Error(`${label} is cut short at 0x${pos.toString(16)}.`); };
  need(0, 4);
  const count = view.getUint32(0, true);
  if (!count || count > 64) throw new Error(`${label} doesn't look like a string table (${count} languages).`);
  need(4, count * 4 + 8);
  const offsets = Array.from({ length: count }, (_, i) => view.getUint32(4 + i * 4, true));
  let pos = 4 + count * 4;
  const keyCount = view.getUint32(pos + 4, true);
  pos += 8;
  const keys: string[] = [];
  for (let i = 0; i < keyCount; i++) {
    need(pos, 4);
    const length = view.getUint32(pos, true);
    need(pos + 4, length + 1);
    keys.push(latin1(bytes.subarray(pos + 4, pos + 4 + length)));
    pos += 4 + length + 1;
  }
  const present = offsets.filter((offset) => offset + 4 <= bytes.length);
  const first = present.length ? Math.min(...present) : bytes.length;
  if (first < pos) throw new Error(`${label}: a language starts inside the key list.`);
  const keyBlock = bytes.slice(4 + count * 4, first);

  // Sections in file order, each one running up to the next.
  const starts = [...new Set(present)].sort((x, y) => x - y);
  const sections: Section[] = starts.map((offset, n) => {
    const end = n + 1 < starts.length ? starts[n + 1] : bytes.length;
    let q = offset;
    const entryCount = view.getUint32(q, true);
    q += 4;
    const entries: Entry[] = [];
    for (let i = 0; i < entryCount; i++) {
      need(q, 10);
      const start = q;
      const hash = view.getUint32(q, true);
      const fontLength = view.getUint32(q + 6, true);
      q += 10 + fontLength;
      need(q, 4);
      const head = bytes.slice(start, q);
      const chars = view.getUint32(q, true);
      need(q + 4, chars * 2 + 10);
      const text = new Uint16Array(chars);
      for (let c = 0; c < chars; c++) text[c] = view.getUint16(q + 4 + c * 2, true);
      q += 4 + chars * 2;
      entries.push({ hash, head, text, tail: bytes.slice(q, q + 10) });
      q += 10;
    }
    if (q > end) throw new Error(`${label}: the section at 0x${offset.toString(16)} runs into the next one.`);
    return { entries, after: bytes.slice(q, end) };
  });
  const languages = offsets.map((offset) => offset + 4 <= bytes.length ? starts.indexOf(offset) : null);
  return { keys, keyBlock, sections, languages };
}

/** The text a key has in each language that has it (null where it doesn't). Trailing NULs dropped. */
export function strtblText(table: StringTable, key: string): (string | null)[] {
  const hash = strtblHash(key);
  return table.languages.map((section) => {
    const entry = section === null ? undefined : table.sections[section].entries.find((item) => item.hash === hash);
    return entry ? String.fromCharCode(...entry.text).replace(/\0+$/, "") : null;
  });
}

/** Sets a key's text in every language that already has an entry for it. Returns how many changed.
 *  The NUL terminators the original entries end with are kept. */
export function setStrtblText(table: StringTable, key: string, text: string) {
  const hash = strtblHash(key);
  let changed = 0;
  for (const section of table.sections) {
    for (const entry of section.entries) {
      if (entry.hash !== hash) continue;
      let nuls = 0;
      while (nuls < entry.text.length && entry.text[entry.text.length - 1 - nuls] === 0) nuls++;
      const next = new Uint16Array(text.length + nuls);
      for (let i = 0; i < text.length; i++) next[i] = text.charCodeAt(i);
      if (next.length !== entry.text.length || next.some((value, i) => value !== entry.text[i])) { entry.text = next; changed++; }
    }
  }
  return changed;
}

export function writeStrtbl(table: StringTable): Uint8Array {
  const count = table.languages.length;
  const sizes = table.sections.map((section) => 4 + section.entries.reduce((sum, entry) => sum + entry.head.length + 4 + entry.text.length * 2 + entry.tail.length, 0) + section.after.length);
  const total = 4 + count * 4 + table.keyBlock.length + sizes.reduce((a, b) => a + b, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, count, true);
  out.set(table.keyBlock, 4 + count * 4);
  let pos = 4 + count * 4 + table.keyBlock.length;
  const starts = table.sections.map((section) => {
    const start = pos;
    view.setUint32(pos, section.entries.length, true);
    pos += 4;
    for (const entry of section.entries) {
      out.set(entry.head, pos); pos += entry.head.length;
      view.setUint32(pos, entry.text.length, true); pos += 4;
      for (const char of entry.text) { view.setUint16(pos, char, true); pos += 2; }
      out.set(entry.tail, pos); pos += entry.tail.length;
    }
    out.set(section.after, pos); pos += section.after.length;
    return start;
  });
  // Empty languages point at the end of the file, like the originals.
  table.languages.forEach((section, index) => view.setUint32(4 + index * 4, section === null ? total : starts[section], true));
  return out;
}
