import { FLASH_HEADER_SIZE, checkFlashContainer, flashFileOffset, flashVirtualAddress } from "./avm1-run";

/**
 * Sprite frames of an MC3 flash `.pck` (RAGE SWF): reading a sprite's display list frame by frame,
 * and replacing one frame's commands with a self-contained list.
 *
 * Layout (RAGE-SWF research flashpck.c, and the VIP author's stage_rx8_carousel_mazda.py, whose
 * `clone_cmd` / `append_frame` this ports):
 *   file 0x90  u32 VA of the object table (4 bytes per object, entry 0 unused)
 *   file 0xAA  u16 object count
 *   object     u8 type (2 = sprite); sprite: u16 frame count @+8, u32 VA of its frame table @+12
 *   frame table 8 bytes per frame; u32 VA of the frame's first command @+4
 *   command    u8 type @+0, u32 VA of the next command @+4 (0 ends the frame)
 *     2 Remove   12 bytes, u16 depth @+2
 *     3 DoAction 16 bytes, u32 VA of the action list @+12
 *     0 Place / 1 Place with a name and clip events: variable length, u16 depth @+12,
 *       u16 character @+14 (0xFFFF = keep the character already there), pointers @+16/@+20,
 *       clips also @+32 (event table, inside the record) / @+36, u32 event count @+28,
 *       12 bytes per event with a pointer @+4.
 * A frame lists only what changes from the previous frame, so a frame's picture is everything
 * placed up to it. Replacing a frame: its new command chain removes every depth the sprite uses,
 * then places what it should show — the way the VIP built its dealership frames, which run in
 * game. New bytes go after the end of the file; only the frame table entry is repointed.
 */

const u8 = (bytes: Uint8Array, at: number) => bytes[at];
const u16 = (bytes: Uint8Array, at: number) => bytes[at] | (bytes[at + 1] << 8);
const u32 = (bytes: Uint8Array, at: number) => (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0;

const OBJECT_TABLE = 0x90;
const OBJECT_COUNT = 0xaa;
export const SPRITE = 2;
export const KEEP_CHARACTER = 0xffff;

export type FrameCommand = {
  /** File offset of the record. */
  at: number;
  type: number;
  depth: number;
  /** Placed character (Place commands), else -1. */
  character: number;
};

/** A depth's content at some frame: the record that placed it and its character. */
export type Layer = { record: number; character: number };
export type DisplayList = Map<number, Layer>;

export class FlashMovie {
  readonly bytes: Uint8Array;
  readonly label: string;
  constructor(bytes: Uint8Array, label = "flash file") {
    checkFlashContainer(bytes, label);
    this.bytes = bytes;
    this.label = label;
  }

  offset(va: number) {
    const at = flashFileOffset(this.bytes, va);
    if (at < FLASH_HEADER_SIZE || at >= this.bytes.length) throw new Error(`${this.label}: a pointer leads outside the file (0x${va.toString(16)}).`);
    return at;
  }
  pointer(field: number) { const va = u32(this.bytes, field); return va ? this.offset(va) : null; }

  get objectCount() { return u16(this.bytes, OBJECT_COUNT); }
  /** File offset of object `id`, or null. */
  object(id: number) {
    if (id < 1 || id >= this.objectCount) return null;
    return this.pointer(this.pointer(OBJECT_TABLE)! + id * 4);
  }
  objectType(id: number) { const at = this.object(id); return at === null ? null : u8(this.bytes, at); }

  sprite(id: number) {
    const at = this.object(id);
    if (at === null || u8(this.bytes, at) !== SPRITE) throw new Error(`${this.label}: object ${id} is not a sprite.`);
    return { at, frames: u16(this.bytes, at + 8), table: this.pointer(at + 12)! };
  }

  /** The commands of one frame, in order. */
  frame(spriteId: number, frame: number): FrameCommand[] {
    const { frames, table } = this.sprite(spriteId);
    if (frame < 0 || frame >= frames) throw new Error(`${this.label}: sprite ${spriteId} has no frame ${frame + 1}.`);
    const out: FrameCommand[] = [];
    const seen = new Set<number>();
    for (let at = this.pointer(table + frame * 8 + 4); at !== null; at = this.pointer(at + 4)) {
      if (seen.has(at) || out.length > 256) throw new Error(`${this.label}: frame ${frame + 1} of sprite ${spriteId} loops.`);
      seen.add(at);
      const type = u8(this.bytes, at);
      if (type > 4) throw new Error(`${this.label}: unknown command type ${type} at 0x${at.toString(16)}.`);
      out.push({ at, type, depth: type === 2 ? u16(this.bytes, at + 2) : type <= 1 ? u16(this.bytes, at + 12) : -1, character: type <= 1 ? u16(this.bytes, at + 14) : -1 });
    }
    return out;
  }

  /** What each frame of a sprite shows: the display list after its commands. A Place that keeps
   *  the character (0xFFFF) is recorded as such; callers that need the character refuse it. */
  displayLists(spriteId: number): DisplayList[] {
    const { frames } = this.sprite(spriteId);
    const lists: DisplayList[] = [];
    const state: DisplayList = new Map();
    for (let f = 0; f < frames; f++) {
      for (const command of this.frame(spriteId, f)) {
        if (command.type === 2) state.delete(command.depth);
        else if (command.type <= 1) state.set(command.depth, { record: command.at, character: command.character });
      }
      lists.push(new Map(state));
    }
    return lists;
  }

  /** Every depth a sprite's commands touch. */
  depths(spriteId: number) {
    const { frames } = this.sprite(spriteId);
    const out = new Set<number>();
    for (let f = 0; f < frames; f++) for (const command of this.frame(spriteId, f)) if (command.depth >= 0) out.add(command.depth);
    return [...out].sort((a, b) => a - b);
  }

  /** File offsets of every command record of every sprite — where a Place record ends when it is
   *  the last of its frame. */
  allCommandOffsets() {
    const out: number[] = [];
    for (let id = 1; id < this.objectCount; id++) {
      if (this.objectType(id) !== SPRITE) continue;
      const { frames } = this.sprite(id);
      for (let f = 0; f < frames; f++) for (const command of this.frame(id, f)) out.push(command.at);
    }
    // The movie's own timeline: header frame table at file 0x8C.
    const rootFrames = u16(this.bytes, 0x88);
    const rootTable = this.pointer(0x8c);
    if (rootTable !== null) {
      for (let f = 0; f < rootFrames; f++) {
        for (let at = this.pointer(rootTable + f * 8 + 4), n = 0; at !== null && n < 4096; at = this.pointer(at + 4), n++) out.push(at);
      }
    }
    return [...new Set(out)].sort((a, b) => a - b);
  }
}

/** One record to put in a rebuilt frame: an existing record cloned, with its depth and character
 *  optionally changed. */
export type FrameItem = { record: number; depth?: number; character?: number };

/**
 * Rebuilds frames of sprites so each shows exactly `items` (in order), independent of the frames
 * before it. Returns the new file; nothing in the original moves. For each frame: Remove for every
 * depth the sprite uses, the frame's own DoAction(s), then the cloned Places.
 */
export function rebuildFrames(movie: FlashMovie, edits: { sprite: number; frame: number; items: FrameItem[] }[]): Uint8Array {
  const original = movie.bytes;
  const chunks: Uint8Array[] = [];
  let length = original.length;
  const alloc = (size: number) => {
    const pad = (16 - (length % 16)) % 16;
    if (pad) { chunks.push(new Uint8Array(pad)); length += pad; }
    const at = length;
    const block = new Uint8Array(size);
    chunks.push(block);
    length += size;
    return { at, block };
  };
  const va = (offset: number) => flashVirtualAddress(original, offset);
  const setU32 = (block: Uint8Array, at: number, value: number) => { block[at] = value & 255; block[at + 1] = (value >>> 8) & 255; block[at + 2] = (value >>> 16) & 255; block[at + 3] = value >>> 24; };
  const setU16 = (block: Uint8Array, at: number, value: number) => { block[at] = value & 255; block[at + 1] = value >>> 8; };
  const boundaries = movie.allCommandOffsets();

  /** clone_cmd: copy a record, rebase the pointers that lead inside it, clear its next pointer. */
  const clone = (record: number) => {
    const type = u8(original, record);
    let end: number;
    if (type === 2) end = record + 12;
    else if (type === 3) end = record + 16;
    else if (type <= 1) {
      const next = movie.pointer(record + 4);
      end = next ?? boundaries.find((at) => at > record) ?? -1;
      if (end < 0 || end - record < 24 || end - record >= 1024) throw new Error(`${movie.label}: can't tell where the Place record at 0x${record.toString(16)} ends.`);
    } else throw new Error(`${movie.label}: command type ${type} can't be copied.`);
    const { at, block } = alloc(end - record);
    block.set(original.subarray(record, end));
    const fields = [4];
    if (type <= 1) fields.push(16, 20);
    if (type === 1) {
      fields.push(32, 36);
      const events = movie.pointer(record + 32);
      if (events !== null) {
        if (events < record || events >= end) throw new Error(`${movie.label}: the clip events of 0x${record.toString(16)} are outside its record.`);
        for (let i = 0; i < u32(original, record + 28); i++) fields.push(events - record + 12 * i + 4);
      }
    }
    if (type === 3) fields.push(12);
    for (const field of fields) {
      const target = movie.pointer(record + field);
      setU32(block, field, target === null ? 0 : target >= record && target < end ? va(at + (target - record)) : va(target));
    }
    setU32(block, 4, 0);
    return { at, block, type };
  };

  const patched = new Map<number, number>();
  for (const { sprite, frame, items } of edits) {
    const { table } = movie.sprite(sprite);
    const own = movie.frame(sprite, frame);
    const removal = own.find((command) => command.type === 2) ?? movie.frame(sprite, frame + 1 < movie.sprite(sprite).frames ? frame + 1 : 0).find((command) => command.type === 2);
    const anyRemoval = removal ?? (() => {
      for (let f = 0; f < movie.sprite(sprite).frames; f++) { const found = movie.frame(sprite, f).find((command) => command.type === 2); if (found) return found; }
      throw new Error(`${movie.label}: sprite ${sprite} has no Remove command to copy.`);
    })();
    const chain: { at: number; block: Uint8Array }[] = [];
    for (const depth of movie.depths(sprite)) {
      const copy = clone(anyRemoval.at);
      setU16(copy.block, 2, depth);
      chain.push(copy);
    }
    for (const command of own.filter((item) => item.type === 3)) chain.push(clone(command.at));
    for (const item of items) {
      const type = u8(original, item.record);
      if (type > 1) throw new Error(`${movie.label}: 0x${item.record.toString(16)} is not a Place.`);
      const copy = clone(item.record);
      if (item.depth !== undefined) setU16(copy.block, 12, item.depth);
      if (item.character !== undefined) setU16(copy.block, 14, item.character);
      if (u16(copy.block, 14) === KEEP_CHARACTER) throw new Error(`${movie.label}: a rebuilt frame can't keep a character it doesn't place.`);
      chain.push(copy);
    }
    chain.forEach((link, i) => { if (i + 1 < chain.length) setU32(link.block, 4, va(chain[i + 1].at)); });
    patched.set(table + frame * 8 + 4, va(chain[0].at));
  }

  const out = new Uint8Array(length);
  out.set(original);
  let pos = original.length;
  for (const chunk of chunks) { out.set(chunk, pos); pos += chunk.length; }
  for (const [field, value] of patched) { out[field] = value & 255; out[field + 1] = (value >>> 8) & 255; out[field + 2] = (value >>> 16) & 255; out[field + 3] = value >>> 24; }
  const size = out.length - FLASH_HEADER_SIZE;
  out[12] = size & 255; out[13] = (size >>> 8) & 255; out[14] = (size >>> 16) & 255; out[15] = size >>> 24;
  return out;
}

/** Same-size change: the character a frame's own Place at `depth` puts there. */
export function setPlacedCharacter(movie: FlashMovie, sprite: number, frame: number, depth: number, character: number) {
  const place = movie.frame(sprite, frame).find((command) => command.type <= 1 && command.depth === depth);
  if (!place) throw new Error(`${movie.label}: frame ${frame + 1} of sprite ${sprite} doesn't place anything at depth ${depth}.`);
  const out = movie.bytes.slice();
  out[place.at + 14] = character & 255;
  out[place.at + 15] = character >>> 8;
  return out;
}
