import { BILINEAR, LANCZOS, pyRound, pySum, quantizeOctreeRgba, resample } from "./pillow";

/**
 * PS2 indexed textures inside MC3 PCKs — finding, decoding and replacing them. A port of
 * `mc3_pck_texture_finder_v01.py` (Texture Finder v0.5), kept numerically identical to it: the same
 * layouts, the same scan scores and tie order, and the same import pipeline, with its Pillow steps
 * reproduced in `src/pillow.ts`.
 *
 * Layouts the script treats as confirmed (modding KB §15):
 * - Non-remix: one 256×256 8-bit texture, 256-colour palette at texture + 0x10000.
 * - Remix: 256/128/64/32 mip chain at +0x0, +0x10100, +0x14200, +0x15300, sharing one palette at
 *   base + 0x15700.
 * - Flash / Shop (`ds_`/`ms_`/`ps_`/`vs_` PCKs): exact records behind the signature
 *   `04 CD CD CD 90 1C 21 00`, 4- or 8-bit, any power-of-two size.
 * Car PCK textures are found by a scored heuristic; Flash records are read exactly.
 */

export type PaletteOrder = "RGBA" | "BGRA" | "ARGB" | "ABGR";
export const paletteOrders: PaletteOrder[] = ["RGBA", "BGRA", "ARGB", "ABGR"];
export type Rgba = [number, number, number, number];

export type LayoutKind = "nonremix" | "remix" | "flash";
export const REMIX_MIP_LEVELS: [number, number][] = [[256, 0x00000], [128, 0x10100], [64, 0x14200], [32, 0x15300]];
const NON_REMIX = { kind: "nonremix" as const, paletteRelative: 0x10000, totalSize: 0x10400, hasMips: false };
const REMIX = { kind: "remix" as const, paletteRelative: 0x15700, totalSize: 0x15b00, hasMips: true };
export const REMIX_PALETTE_RELATIVE = REMIX.paletteRelative;
type ScanLayout = typeof NON_REMIX | typeof REMIX;
const FLASH_SIGNATURE = [0x04, 0xcd, 0xcd, 0xcd, 0x90, 0x1c, 0x21, 0x00];
const FLASH_HEADER_SIZE = 0x80;
const LOW_ALPHA_RGB_BLACK_CUTOFF = 16;
const TRANSPARENT_PALETTE_INDEX = 0;

export type Candidate = {
  textureOffset: number;
  paletteOffset: number;
  layout: LayoutKind;
  paletteOrder: PaletteOrder;
  score: number;
  coarseScore: number;
  alphaValid: number;
  alphaUnique: number;
  paletteUnique: number;
  indexUnique: number;
  entropy: number;
  edgeMean: number | null;
  mipError: number | null;
  notes: string[];
  width: number;
  height: number;
  bpp: 4 | 8;
  headerOffset: number | null;
  sequenceIndex: number | null;
  paletteColors: number;
};
export const hasMips = (candidate: Candidate) => candidate.layout === "remix";

// ---------------------------------------------------------------------------------------------
// Swizzle, palettes, decoding

/** The PS2 CSM1 palette stores entries 8–15 and 16–23 of every 32 swapped. */
export const ps2PaletteIndex = (index: number) => (index & 0xe7) | ((index & 0x08) << 1) | ((index & 0x10) >> 1);

function swizzledIndex8(x: number, y: number, width: number) {
  const blockLocation = (y & ~0xf) * width + (x & ~0xf) * 2;
  const swapSelector = (((y + 2) >> 2) & 1) * 4;
  const posY = ((((y & ~3) >> 1) + (y & 1)) & 7);
  const columnLocation = posY * width * 2 + ((x + swapSelector) & 7) * 4;
  const byteNum = ((y >> 1) & 1) + ((x >> 2) & 2);
  return blockLocation + columnLocation + byteNum;
}
const map8Cache = new Map<string, Int32Array>();
/** For each linear pixel, the byte it comes from in PSMT8 swizzled order. */
export function unswizzleMap8(width: number, height: number) {
  const key = `${width}x${height}`;
  let map = map8Cache.get(key);
  if (!map) {
    map = new Int32Array(width * height);
    const linear = width % 16 !== 0 || height % 16 !== 0;
    for (let y = 0, i = 0; y < height; y += 1) for (let x = 0; x < width; x += 1, i += 1) map[i] = linear ? i : swizzledIndex8(x, y, width);
    map8Cache.set(key, map);
  }
  return map;
}

function source4(x: number, y: number, width: number): [number, boolean] {
  const pagesHorizontal = Math.floor((width + 127) / 128);
  const pageX = x & ~0x7f; const pageY = y & ~0x7f;
  const pageNumber = Math.floor(pageY / 128) * pagesHorizontal + Math.floor(pageX / 128);
  const page32Y = Math.floor(pageNumber / pagesHorizontal) * 32;
  const page32X = (pageNumber % pagesHorizontal) * 64;
  const pageLocation = page32Y * width * 2 + page32X * 4;
  const localX = x & 0x7f; const localY = y & 0x7f;
  const blockLocation = ((localX & ~0x1f) >> 1) * width + (localY & ~0xf) * 2;
  const swapSelector = (((y + 2) >> 2) & 1) * 4;
  const positionY = ((((y & ~3) >> 1) + (y & 1)) & 7);
  const columnLocation = positionY * width * 2 + ((x + swapSelector) & 7) * 4;
  const byteNumber = (x >> 3) & 3;
  return [pageLocation + blockLocation + columnLocation + byteNumber, ((y >> 1) & 1) === 1];
}
const map4Cache = new Map<string, { byte: Int32Array; high: Uint8Array }>();
/** PSMT4: for each linear pixel, the packed byte and whether it is the high nibble. */
export function unswizzleMap4(width: number, height: number) {
  const key = `${width}x${height}`;
  let map = map4Cache.get(key);
  if (!map) {
    const byte = new Int32Array(width * height); const high = new Uint8Array(width * height);
    const linear = width % 128 !== 0 || height % 128 !== 0;
    for (let y = 0, i = 0; y < height; y += 1) for (let x = 0; x < width; x += 1, i += 1) {
      if (linear) { byte[i] = i >> 1; high[i] = i & 1; }
      else { const [b, h] = source4(x, y, width); byte[i] = b; high[i] = h ? 1 : 0; }
    }
    map = { byte, high };
    map4Cache.set(key, map);
  }
  return map;
}

function orderedChannels(chunk: ArrayLike<number>, order: PaletteOrder) {
  const values: Record<string, number> = {};
  for (let i = 0; i < 4; i += 1) values[order[i]] = chunk[i];
  return values;
}

/** 256 entries, CSM1 order undone, alpha doubled to 0..255 unless `scaleAlpha` is off. */
export function unpackPalette8(raw: Uint8Array, order: PaletteOrder, scaleAlpha = true): Rgba[] {
  if (raw.length < 1024) throw new Error("Palette requires 0x400 bytes.");
  const linear: Rgba[] = new Array(256).fill(null).map(() => [0, 0, 0, 0] as Rgba);
  for (let i = 0; i < 256; i += 1) {
    const v = orderedChannels(raw.subarray(i * 4, i * 4 + 4), order);
    linear[ps2PaletteIndex(i)] = [v.R, v.G, v.B, scaleAlpha ? Math.min(255, v.A * 2) : v.A];
  }
  return linear;
}
export function unpackPalette4(raw: Uint8Array, order: PaletteOrder, scaleAlpha = true): Rgba[] {
  if (raw.length < 0x40) throw new Error("4-bit palette requires 0x40 bytes.");
  return Array.from({ length: 16 }, (_, i) => { const v = orderedChannels(raw.subarray(i * 4, i * 4 + 4), order); return [v.R, v.G, v.B, scaleAlpha ? Math.min(255, v.A * 2) : v.A] as Rgba; });
}

export type DecodeSpec = { textureOffset: number; paletteOffset: number; width: number; height: number; order: PaletteOrder; swizzled: boolean; flipVertical: boolean; bpp: 4 | 8 };
export const textureBytes = (width: number, height: number, bpp: 4 | 8) => bpp === 8 ? width * height : Math.floor((width * height + 1) / 2);

/** Decodes to straight RGBA, alpha already doubled to the 0..255 range, like `decode_texture`. */
export function decodeTexture(data: Uint8Array, spec: DecodeSpec) {
  const { width, height, bpp } = spec;
  const pixels = width * height;
  const size = textureBytes(width, height, bpp);
  const paletteSize = bpp === 8 ? 0x400 : 0x40;
  if (spec.textureOffset < 0 || spec.textureOffset + size > data.length) throw new Error("Texture range is outside the file.");
  if (spec.paletteOffset < 0 || spec.paletteOffset + paletteSize > data.length) throw new Error("Palette range is outside the file.");
  const raw = data.subarray(spec.textureOffset, spec.textureOffset + size);
  const indices = new Uint8Array(pixels);
  if (bpp === 8) {
    const map = spec.swizzled ? unswizzleMap8(width, height) : null;
    for (let i = 0; i < pixels; i += 1) indices[i] = raw[map ? map[i] : i];
  } else if (spec.swizzled) {
    const map = unswizzleMap4(width, height);
    for (let i = 0; i < pixels; i += 1) { const v = raw[map.byte[i]]; indices[i] = map.high[i] ? (v >> 4) & 0xf : v & 0xf; }
  } else {
    for (let i = 0; i < pixels; i += 1) { const v = raw[i >> 1]; indices[i] = i & 1 ? v >> 4 : v & 0xf; }
  }
  const paletteRaw = data.subarray(spec.paletteOffset, spec.paletteOffset + paletteSize);
  const palette = bpp === 8 ? unpackPalette8(paletteRaw, spec.order) : unpackPalette4(paletteRaw, spec.order);
  const rgba = new Uint8Array(pixels * 4);
  for (let i = 0; i < pixels; i += 1) rgba.set(palette[indices[i]], i * 4);
  if (spec.flipVertical) {
    const row = width * 4; const flipped = new Uint8Array(rgba.length);
    for (let y = 0; y < height; y += 1) flipped.set(rgba.subarray((height - 1 - y) * row, (height - y) * row), y * row);
    return flipped;
  }
  return rgba;
}

// ---------------------------------------------------------------------------------------------
// Scanning

/** Shannon entropy over the byte histogram, summed in first-seen order as Python's Counter does. */
function shannonEntropy(sample: Uint8Array) {
  if (!sample.length) return 0;
  const counts = new Map<number, number>();
  for (const value of sample) counts.set(value, (counts.get(value) ?? 0) + 1);
  return -pySum([...counts.values()].map((count) => (count / sample.length) * Math.log2(count / sample.length)));
}

function detectAlphaPosition(palette: Uint8Array): [number, number] {
  let last = 0; let first = 0;
  for (let i = 0; i < 1024; i += 4) { if (palette[i + 3] <= 128) last += 1; if (palette[i] <= 128) first += 1; }
  return first > last ? [0, first] : [3, last];
}

function coarseScore(data: Uint8Array, textureOffset: number, layout: ScanLayout): Candidate | null {
  const paletteOffset = textureOffset + layout.paletteRelative;
  if (textureOffset < 0 || textureOffset + 0x10000 > data.length) return null;
  if (paletteOffset + 0x400 > data.length) return null;
  const palette = data.subarray(paletteOffset, paletteOffset + 0x400);
  const [alphaPos, alphaValid] = detectAlphaPosition(palette);
  if (alphaValid < 208) return null;
  const alphaSet = new Set<number>(); for (let i = alphaPos; i < 1024; i += 4) alphaSet.add(palette[i]);
  const entrySet = new Set<number>(); const view = new DataView(palette.buffer, palette.byteOffset, 1024);
  for (let i = 0; i < 1024; i += 4) entrySet.add(view.getUint32(i, true));
  let rgbUniqueSum = 0;
  for (let position = 0; position < 4; position += 1) {
    if (position === alphaPos) continue;
    const values = new Set<number>(); for (let i = position; i < 1024; i += 4) values.add(palette[i]);
    rgbUniqueSum += values.size;
  }
  const rgbUniqueMean = rgbUniqueSum / 3;
  const sample = new Uint8Array(1024);
  for (let i = 0; i < 1024; i += 1) sample[i] = data[textureOffset + i * 64];
  const frequency = new Map<number, number>(); for (const value of sample) frequency.set(value, (frequency.get(value) ?? 0) + 1);
  const indexUnique = frequency.size;
  const entropy = shannonEntropy(sample);
  const dominantRatio = Math.max(...frequency.values()) / sample.length;

  let score = (alphaValid / 256) * 65;
  if (alphaValid === 256) score += 15;
  score += Math.min(alphaSet.size / 64, 1) * 5;
  score += Math.min(entrySet.size / 192, 1) * 5;
  score += Math.min(rgbUniqueMean / 128, 1) * 5;
  score += Math.min(indexUnique / 128, 1) * 3;
  if (dominantRatio >= 0.01 && dominantRatio <= 0.65) score += 1;
  if (entropy >= 3 && entropy <= 7.5) score += 1;
  return {
    textureOffset, paletteOffset, layout: layout.kind, paletteOrder: alphaPos === 0 ? "ARGB" : "RGBA", score, coarseScore: score,
    alphaValid, alphaUnique: alphaSet.size, paletteUnique: entrySet.size, indexUnique, entropy, edgeMean: null, mipError: null,
    notes: alphaValid === 256 ? ["all palette alpha bytes are within PS2 0..128"] : [], width: 256, height: 256, bpp: 8, headerOffset: null, sequenceIndex: null, paletteColors: 256,
  };
}

const sampleMapCache = new Map<number, Int32Array>();
function sampleMap(step: number) {
  let map = sampleMapCache.get(step);
  if (!map) {
    const out: number[] = [];
    for (let y = 0; y < 256; y += step) for (let x = 0; x < 256; x += step) out.push(swizzledIndex8(x, y, 256));
    map = Int32Array.from(out); sampleMapCache.set(step, map);
  }
  return map;
}

function edgeMean(data: Uint8Array, candidate: Candidate, step = 4): [number, number] {
  const texture = data.subarray(candidate.textureOffset, candidate.textureOffset + 0x10000);
  const palette = unpackPalette8(data.subarray(candidate.paletteOffset, candidate.paletteOffset + 0x400), candidate.paletteOrder, false);
  const map = sampleMap(step);
  const grid = 256 / step;
  const colors = new Array<Rgba>(map.length);
  const unique = new Set<number>();
  for (let i = 0; i < map.length; i += 1) { const c = palette[texture[map[i]]]; colors[i] = c; unique.add((c[0] << 16) | (c[1] << 8) | c[2]); }
  let total = 0; let count = 0;
  for (let y = 0; y < grid; y += 1) for (let x = 0; x < grid; x += 1) {
    const p = colors[y * grid + x];
    if (x) { const q = colors[y * grid + x - 1]; total += Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]); count += 3; }
    if (y) { const q = colors[(y - 1) * grid + x]; total += Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]); count += 3; }
  }
  return [count ? total / count : 255, unique.size];
}

const rgbOf = (rgba: Uint8Array) => { const out = new Uint8Array((rgba.length / 4) * 3); for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) { out[j] = rgba[i]; out[j + 1] = rgba[i + 1]; out[j + 2] = rgba[i + 2]; } return out; };

function remixMipError(data: Uint8Array, candidate: Candidate) {
  const decode = (offset: number, size: number) => rgbOf(decodeTexture(data, { textureOffset: offset, paletteOffset: candidate.paletteOffset, width: size, height: size, order: candidate.paletteOrder, swizzled: true, flipVertical: false, bpp: 8 }));
  const base = decode(candidate.textureOffset, 256);
  const errors: number[] = [];
  for (const [size, relative] of REMIX_MIP_LEVELS.slice(1)) {
    const mip = decode(candidate.textureOffset + relative, size);
    const reference = resample(base, 256, 256, 3, size, size, BILINEAR);
    const sums = [0, 0, 0];
    for (let i = 0; i < mip.length; i += 1) sums[i % 3] += Math.abs(reference[i] - mip[i]);
    const pixels = size * size;
    errors.push(pySum([sums[0] / pixels, sums[1] / pixels, sums[2] / pixels]) / 3);
  }
  return pySum(errors) / errors.length;
}

// Python's heapq, reproduced: the scan keeps each layout's best windows in a heap, and the heap's
// array order is the order ties are later broken in.
type HeapItem = { score: number; offset: number; candidate: Candidate };
const heapLess = (a: HeapItem, b: HeapItem) => a.score < b.score || (a.score === b.score && a.offset < b.offset);
function siftDown(heap: HeapItem[], start: number, pos: number) {
  const item = heap[pos];
  while (pos > start) { const parentPos = (pos - 1) >> 1; const parent = heap[parentPos]; if (heapLess(item, parent)) { heap[pos] = parent; pos = parentPos; continue; } break; }
  heap[pos] = item;
}
function siftUp(heap: HeapItem[], pos: number) {
  const end = heap.length; const start = pos; const item = heap[pos];
  let child = 2 * pos + 1;
  while (child < end) { const right = child + 1; if (right < end && !heapLess(heap[child], heap[right])) child = right; heap[pos] = heap[child]; pos = child; child = 2 * pos + 1; }
  heap[pos] = item; siftDown(heap, start, pos);
}
const heapPush = (heap: HeapItem[], item: HeapItem) => { heap.push(item); siftDown(heap, 0, heap.length - 1); };
const heapReplace = (heap: HeapItem[], item: HeapItem) => { heap[0] = item; siftUp(heap, 0); };

export type ScanOptions = { nonRemix: boolean; remix: boolean; alignment: number; maxResults: number };
export type ScanProgress = (fraction: number, text: string) => void;
const hex8 = (value: number) => `0x${value.toString(16).toUpperCase().padStart(8, "0")}`;

/** `scan_candidates`: the heuristic search for car-PCK textures. */
export function scanCandidates(data: Uint8Array, options: ScanOptions, progress?: ScanProgress, stopped?: () => boolean): Candidate[] {
  const alignment = Math.max(1, options.alignment);
  const layouts = [options.nonRemix && NON_REMIX, options.remix && REMIX].filter(Boolean) as ScanLayout[];
  if (!layouts.length) return [];
  const totalWindows = layouts.reduce((sum, layout) => sum + Math.max(0, Math.floor((data.length - layout.totalSize) / alignment) + 1), 0);
  let completed = 0;
  const poolLimit = Math.max(256, options.maxResults * 6);
  const pools = new Map<LayoutKind, HeapItem[]>(layouts.map((layout) => [layout.kind, []]));
  for (const layout of layouts) {
    const last = data.length - layout.totalSize;
    if (last < 0) continue;
    const heap = pools.get(layout.kind)!;
    for (let offset = 0; offset <= last; offset += alignment) {
      if (stopped?.()) return [];
      const candidate = coarseScore(data, offset, layout);
      if (candidate) {
        const item = { score: candidate.coarseScore, offset, candidate };
        if (heap.length < poolLimit) heapPush(heap, item);
        else if (heapLess(heap[0], item)) heapReplace(heap, item);
      }
      completed += 1;
      if (progress && (completed % 512 === 0 || completed === totalWindows)) progress(completed / Math.max(1, totalWindows) * 0.92, `Scanning ${layout.kind === "remix" ? "Remix mip chain" : "Non-remix 256 + palette"}: ${hex8(offset)}`);
    }
  }
  const candidates = [...pools.values()].flatMap((heap) => heap.map((item) => item.candidate));

  progress?.(0.92, "Validating image coherence…");
  for (const candidate of candidates) {
    if (stopped?.()) return [];
    try {
      const [mean, uniqueColors] = edgeMean(data, candidate);
      candidate.edgeMean = mean;
      if (mean >= 15 && mean <= 70) candidate.score += Math.max(0, 3 - Math.abs(mean - 35) / 20);
      else if (mean < 15) { candidate.score += 0.25; candidate.notes.push("very flat image candidate"); }
      if (uniqueColors < 12) { candidate.score -= 8; candidate.notes.push("low decoded color diversity"); }
    } catch (error) { candidate.score -= 10; candidate.notes.push(`coherence check failed: ${error instanceof Error ? error.message : error}`); }
  }

  const remix = candidates.filter(hasMips).sort((a, b) => b.score - a.score);
  const checked = new Set<Candidate>();
  for (const candidate of remix.slice(0, Math.max(24, Math.floor(options.maxResults / 2)))) {
    if (stopped?.()) return [];
    try {
      const error = remixMipError(data, candidate);
      candidate.mipError = error; checked.add(candidate);
      if (error < 35) { candidate.score += 8; candidate.notes.push("mip chain is coherent"); }
      else if (error < 65) { candidate.score += 2; candidate.notes.push("mip chain is moderately coherent"); }
      else if (error > 85) { candidate.score -= 12; candidate.notes.push("mip chain is inconsistent"); }
      else candidate.score -= 5;
    } catch (error) { candidate.score -= 12; candidate.notes.push(`mip validation failed: ${error instanceof Error ? error.message : error}`); }
  }
  for (const candidate of remix) if (!checked.has(candidate)) candidate.score -= 2;

  const layoutOrder = (candidate: Candidate) => candidate.layout;
  candidates.sort((a, b) => (b.score - a.score) || (b.alphaValid - a.alphaValid) || (b.paletteUnique - a.paletteUnique) || (a.textureOffset - b.textureOffset));
  const result: Candidate[] = []; const seen = new Set<string>();
  for (const candidate of candidates) {
    const key = `${layoutOrder(candidate)}|${candidate.textureOffset}`;
    if (seen.has(key)) continue;
    seen.add(key); result.push(candidate);
    if (result.length >= options.maxResults) break;
  }
  progress?.(1, `Scan complete: ${result.length} candidates`);
  return result;
}

/** `scan_flash_textures`: the exact texture records of the ds_/ms_/ps_/vs_ shop PCKs. */
export function scanFlashTextures(data: Uint8Array): Candidate[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const candidates: Candidate[] = [];
  for (let header = 0; header + FLASH_SIGNATURE.length <= data.length; header += 1) {
    if (data[header] !== FLASH_SIGNATURE[0] || !FLASH_SIGNATURE.every((value, i) => data[header + i] === value)) continue;
    if (header + FLASH_HEADER_SIZE > data.length) continue;
    const width = view.getUint16(header + 0x0c, true); const height = view.getUint16(header + 0x0e, true);
    const repeatedWidth = view.getUint16(header + 0x4c, true); const repeatedHeight = view.getUint16(header + 0x4e, true);
    const formatType = view.getUint16(header + 0x48, true);
    if (width !== repeatedWidth || height !== repeatedHeight) continue;
    if (formatType !== 5 && formatType !== 6) continue;
    if (width <= 0 || height <= 0 || width > 2048 || height > 2048) continue;
    if ((width & (width - 1)) || (height & (height - 1))) continue;
    const bpp: 4 | 8 = formatType === 5 ? 8 : 4;
    const size = textureBytes(width, height, bpp);
    const paletteColors = bpp === 8 ? 256 : 16;
    const paletteSize = paletteColors * 4;
    const textureOffset = header + FLASH_HEADER_SIZE;
    const paletteOffset = textureOffset + size + (bpp === 8 ? 0xd0 : 0xe0);
    if (textureOffset + size > data.length || paletteOffset + paletteSize > data.length) continue;
    const palette = data.subarray(paletteOffset, paletteOffset + paletteSize);
    let alphaValid = 0; const alphas = new Set<number>(); const entries = new Set<number>();
    const paletteView = new DataView(palette.buffer, palette.byteOffset, paletteSize);
    for (let i = 0; i < paletteSize; i += 4) { if (palette[i + 3] <= 128) alphaValid += 1; alphas.add(palette[i + 3]); entries.add(paletteView.getUint32(i, true)); }
    if (alphaValid < Math.max(12, pyRound(paletteColors * 0.75))) continue;
    const raw = data.subarray(textureOffset, textureOffset + size);
    const indices = new Set<number>();
    if (bpp === 8) for (const value of raw) indices.add(value);
    else for (const value of raw) { indices.add(value & 0xf); indices.add(value >> 4); }
    const stride = Math.max(1, Math.floor(raw.length / 4096));
    const sample = new Uint8Array(Math.ceil(raw.length / stride)); for (let i = 0, j = 0; i < raw.length; i += stride, j += 1) sample[j] = raw[i];
    candidates.push({
      textureOffset, paletteOffset, layout: "flash", paletteOrder: "RGBA", score: 100, coarseScore: 100, alphaValid, alphaUnique: alphas.size,
      paletteUnique: entries.size, indexUnique: indices.size, entropy: shannonEntropy(sample), edgeMean: null, mipError: null,
      notes: ["exact Flash/UI texture record"], width, height, bpp, headerOffset: header, sequenceIndex: candidates.length, paletteColors,
    });
  }
  return candidates;
}

// ---------------------------------------------------------------------------------------------
// Import — a straight RGBA image into PS2 indices and palette

export type RgbaImage = { width: number; height: number; data: Uint8Array };

/** `load_import_source`: alpha rescaled to PS2's 0..128 when the image uses the full range, and
 *  the colour under near-transparent pixels cleared. */
export function prepareImportSource(image: RgbaImage): RgbaImage {
  const pixels = image.data.slice();
  let maxAlpha = 0; for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > maxAlpha) maxAlpha = pixels[i];
  if (maxAlpha > 128) for (let i = 3; i < pixels.length; i += 4) pixels[i] = Math.max(0, Math.min(128, pyRound(pixels[i] * 128 / 255)));
  return { ...image, data: cleanLowAlpha(pixels) };
}

function cleanLowAlpha(pixels: Uint8Array) {
  for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 3] <= LOW_ALPHA_RGB_BLACK_CUTOFF) { pixels[i] = 0; pixels[i + 1] = 0; pixels[i + 2] = 0; }
  return pixels;
}

/** `resize_rgba_ps2_alpha`: Lanczos in premultiplied space, with PS2 alpha (0..128). */
export function resizePs2Alpha(image: RgbaImage, width: number, height: number): RgbaImage {
  if (image.width === width && image.height === height) return { width, height, data: cleanLowAlpha(image.data.slice()) };
  const count = image.width * image.height;
  const plane = (channel: number) => { const out = new Uint8Array(count); for (let i = 0; i < count; i += 1) out[i] = image.data[i * 4 + channel]; return out; };
  const alpha = plane(3);
  const alpha255 = alpha.map((value) => Math.max(0, Math.min(255, pyRound(value * 255 / 128))));
  // ImageChops.multiply: (a * b) / 255, integer division.
  const premultiplied = [0, 1, 2].map((channel) => {
    const values = plane(channel);
    for (let i = 0; i < count; i += 1) values[i] = Math.trunc((values[i] * alpha255[i]) / 255);
    return resample(values, image.width, image.height, 1, width, height, LANCZOS);
  });
  const resizedAlpha = resample(alpha, image.width, image.height, 1, width, height, LANCZOS);
  const out = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const a = resizedAlpha[i];
    if (a <= 0) continue;
    for (let c = 0; c < 3; c += 1) out[i * 4 + c] = Math.max(0, Math.min(255, pyRound(premultiplied[c][i] * 128 / a)));
    out[i * 4 + 3] = Math.max(0, Math.min(128, a));
  }
  return { width, height, data: cleanLowAlpha(out) };
}

/** `quantize_master_palette`: FASTOCTREE colours, each entry's alpha the mean of its pixels. */
export function quantizeMasterPalette(image: RgbaImage, colors = 256): Rgba[] {
  const { palette: octree, indices } = quantizeOctreeRgba(image.data, colors);
  const alphaSum = new Array(colors).fill(0); const alphaCount = new Array(colors).fill(0);
  for (let i = 0; i < indices.length; i += 1) { alphaSum[indices[i]] += image.data[i * 4 + 3]; alphaCount[indices[i]] += 1; }
  const palette: Rgba[] = octree.map(([r, g, b], i) => {
    const alpha = alphaCount[i] ? pyRound(alphaSum[i] / alphaCount[i]) : 0;
    return alpha <= LOW_ALPHA_RGB_BLACK_CUTOFF ? [0, 0, 0, alpha] : [r, g, b, alpha];
  });
  if (palette.length) palette[TRANSPARENT_PALETTE_INDEX] = [0, 0, 0, 0];
  return palette;
}

function nearestPaletteIndex(r: number, g: number, b: number, a: number, palette: Rgba[]) {
  if (a === 0) return TRANSPARENT_PALETTE_INDEX;
  if (a <= LOW_ALPHA_RGB_BLACK_CUTOFF) { r = 0; g = 0; b = 0; }
  const pr = r * a / 128; const pg = g * a / 128; const pb = b * a / 128;
  let best = 0; let bestDistance = Infinity;
  for (let i = 0; i < palette.length; i += 1) {
    const [qr, qg, qb, qa] = palette[i];
    const dr = pr - qr * qa / 128; const dg = pg - qg * qa / 128; const db = pb - qb * qa / 128; const da = a - qa;
    const distance = dr * dr + dg * dg + db * db + da * da * 16;
    if (distance < bestDistance) { bestDistance = distance; best = i; }
  }
  return best;
}

/** `remap_to_palette`: every pixel to its nearest entry, in premultiplied space. */
export function remapToPalette(image: RgbaImage, palette: Rgba[]) {
  const pixels = cleanLowAlpha(image.data.slice());
  const cache = new Map<number, number>();
  const out = new Uint8Array(image.width * image.height);
  for (let i = 0; i < out.length; i += 1) {
    const r = pixels[i * 4], g = pixels[i * 4 + 1], b = pixels[i * 4 + 2], a = pixels[i * 4 + 3];
    const key = ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
    let index = cache.get(key);
    if (index === undefined) { index = nearestPaletteIndex(r, g, b, a, palette); cache.set(key, index); }
    out[i] = index;
  }
  return out;
}

export function swizzle8(linear: Uint8Array, width: number, height: number) {
  if (width % 16 || height % 16) return linear.slice();
  const map = unswizzleMap8(width, height);
  const out = new Uint8Array(width * height);
  for (let i = 0; i < linear.length; i += 1) out[map[i]] = linear[i];
  return out;
}
export function swizzle4(linear: Uint8Array, width: number, height: number) {
  const map = unswizzleMap4(width, height);
  const packed = new Uint8Array(Math.floor((width * height + 1) / 2));
  for (let i = 0; i < linear.length; i += 1) {
    const value = linear[i] & 0xf; const at = map.byte[i];
    packed[at] = map.high[i] ? (packed[at] & 0x0f) | (value << 4) : (packed[at] & 0xf0) | value;
  }
  return packed;
}

export function packPalette8(palette: Rgba[], order: PaletteOrder) {
  if (palette.length !== 256) throw new Error("Palette must contain exactly 256 colors.");
  const file: Rgba[] = new Array(256);
  palette.forEach((color, i) => { file[ps2PaletteIndex(i)] = color; });
  return packEntries(file, order);
}
export function packPalette4(palette: Rgba[], order: PaletteOrder) {
  if (palette.length !== 16) throw new Error("4-bit palette must contain exactly 16 colors.");
  return packEntries(palette, order);
}
function packEntries(entries: Rgba[], order: PaletteOrder) {
  const out = new Uint8Array(entries.length * 4);
  entries.forEach(([r, g, b, a], i) => {
    const values: Record<string, number> = { R: r, G: g, B: b, A: Math.max(0, Math.min(128, pyRound(a))) };
    for (let c = 0; c < 4; c += 1) out[i * 4 + c] = values[order[c]];
  });
  return out;
}

/** `build_flash_texture_import`: one Flash record, its own palette of 16 or 256 colours. */
export function buildFlashImport(source: RgbaImage, width: number, height: number, bpp: 4 | 8, order: PaletteOrder) {
  const resized = resizePs2Alpha(source, width, height);
  const palette = quantizeMasterPalette(resized, bpp === 4 ? 16 : 256);
  const linear = remapToPalette(resized, palette);
  return bpp === 4 ? { indices: swizzle4(linear, width, height), palette: packPalette4(palette, order) } : { indices: swizzle8(linear, width, height), palette: packPalette8(palette, order) };
}

/** `build_all_mip_import`: every level remapped against one palette built from the 256 master. */
export function buildAllMipImport(source: RgbaImage, levels: [number, number][], order: PaletteOrder) {
  const master = resizePs2Alpha(source, 256, 256);
  const palette = quantizeMasterPalette(master);
  const indices = new Map<number, Uint8Array>();
  for (const [size] of levels) {
    const resized = size === 256 ? master : resizePs2Alpha(source, size, size);
    indices.set(size, swizzle8(remapToPalette(resized, palette), size, size));
  }
  return { indices, palette: packPalette8(palette, order) };
}

/** `build_single_mip_import`: one level against the palette already in the file. */
export function buildSingleMipImport(source: RgbaImage, size: number, palette: Rgba[]) {
  return swizzle8(remapToPalette(resizePs2Alpha(source, size, size), palette), size, size);
}
