/**
 * The handful of Pillow 12.2 operations the texture importer depends on, reproduced so an imported
 * texture comes out byte for byte the same as `mc3_pck_texture_finder_v01.py` produces on Windows.
 *
 * Sources followed, per function: `libImaging/Resample.c` (resampling), `libImaging/QuantOctree.c`
 * and `Quant.c` (FASTOCTREE quantization), `libImaging/Chops.c` (multiply/difference), and the MSVC
 * UCRT `qsort.cpp`, because the octree sorts its color buckets with the C runtime's unstable qsort
 * and the order of equally-counted buckets decides the palette.
 */

/** Python 3 `round()` on a float: halves go to the even neighbour. */
export function pyRound(value: number) {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** Python 3.12+ `sum()` over floats: Neumaier-compensated, as CPython's builtin_sum does it. */
export function pySum(values: Iterable<number>) {
  let total = 0; let compensation = 0;
  for (const x of values) {
    const t = total + x;
    compensation += Math.abs(total) >= Math.abs(x) ? (total - t) + x : (x - t) + total;
    total = t;
  }
  return compensation && Number.isFinite(compensation) ? total + compensation : total;
}

// ---------------------------------------------------------------------------------------------
// Resample.c — separable convolution with 22-bit fixed-point coefficients, 8 bits per channel.

type Filter = { support: number; weight(x: number): number };
const sinc = (x: number) => { if (x === 0) return 1; x *= Math.PI; return Math.sin(x) / x; };
export const BILINEAR: Filter = { support: 1, weight: (x) => { if (x < 0) x = -x; return x < 1 ? 1 - x : 0; } };
export const LANCZOS: Filter = { support: 3, weight: (x) => (-3 <= x && x < 3 ? sinc(x) * sinc(x / 3) : 0) };

const PRECISION_BITS = 32 - 8 - 2;

function precomputeCoeffs(inSize: number, outSize: number, filter: Filter) {
  const scale = inSize / outSize;
  const filterScale = Math.max(scale, 1);
  const support = filter.support * filterScale;
  const ksize = Math.ceil(support) * 2 + 1;
  const kk = new Int32Array(outSize * ksize);
  const bounds = new Int32Array(outSize * 2);
  const weights = new Float64Array(ksize);
  for (let xx = 0; xx < outSize; xx += 1) {
    const center = (xx + 0.5) * scale;
    const ss = 1 / filterScale;
    let xmin = Math.trunc(center - support + 0.5); if (xmin < 0) xmin = 0;
    let xmax = Math.trunc(center + support + 0.5); if (xmax > inSize) xmax = inSize;
    xmax -= xmin;
    let ww = 0;
    for (let x = 0; x < xmax; x += 1) { const w = filter.weight((x + xmin - center + 0.5) * ss); weights[x] = w; ww += w; }
    for (let x = 0; x < xmax; x += 1) {
      const k = ww !== 0 ? weights[x] / ww : weights[x];
      // normalize_coeffs_8bpc: round half away from zero into 22-bit fixed point.
      kk[xx * ksize + x] = k < 0 ? Math.trunc(-0.5 + k * (1 << PRECISION_BITS)) : Math.trunc(0.5 + k * (1 << PRECISION_BITS));
    }
    bounds[xx * 2] = xmin; bounds[xx * 2 + 1] = xmax;
  }
  return { ksize, kk, bounds };
}

const clip8 = (value: number) => { const v = value >> PRECISION_BITS; return v < 0 ? 0 : v > 255 ? 255 : v; };

/**
 * Resizes `channels` interleaved 8-bit planes (1 for "L", 3 for "RGB") exactly as
 * `Image.resize(size, filter)` does: horizontal pass over the source rows the vertical pass needs,
 * then the vertical pass, each skipped when that axis keeps its size.
 */
export function resample(source: Uint8Array, width: number, height: number, channels: number, outWidth: number, outHeight: number, filter: Filter) {
  if (outWidth === width && outHeight === height) return source.slice();
  const horizontal = precomputeCoeffs(width, outWidth, filter);
  const vertical = precomputeCoeffs(height, outHeight, filter);
  const needHorizontal = outWidth !== width;
  const needVertical = outHeight !== height;
  const yFirst = vertical.bounds[0];
  const yLast = vertical.bounds[outHeight * 2 - 2] + vertical.bounds[outHeight * 2 - 1];

  let image = source; let imageWidth = width; let rowOffset = 0;
  if (needHorizontal) {
    const rows = yLast - yFirst;
    const out = new Uint8Array(outWidth * rows * channels);
    for (let yy = 0; yy < rows; yy += 1) {
      const inRow = (yy + yFirst) * width * channels;
      for (let xx = 0; xx < outWidth; xx += 1) {
        const xmin = horizontal.bounds[xx * 2]; const xmax = horizontal.bounds[xx * 2 + 1]; const k = xx * horizontal.ksize;
        for (let c = 0; c < channels; c += 1) {
          let ss = 1 << (PRECISION_BITS - 1);
          for (let x = 0; x < xmax; x += 1) ss += source[inRow + (x + xmin) * channels + c] * horizontal.kk[k + x];
          out[(yy * outWidth + xx) * channels + c] = clip8(ss);
        }
      }
    }
    image = out; imageWidth = outWidth; rowOffset = yFirst;
  }
  if (!needVertical) return image;
  const out = new Uint8Array(imageWidth * outHeight * channels);
  for (let yy = 0; yy < outHeight; yy += 1) {
    const ymin = vertical.bounds[yy * 2] - rowOffset; const ymax = vertical.bounds[yy * 2 + 1]; const k = yy * vertical.ksize;
    for (let xx = 0; xx < imageWidth; xx += 1) {
      for (let c = 0; c < channels; c += 1) {
        let ss = 1 << (PRECISION_BITS - 1);
        for (let y = 0; y < ymax; y += 1) ss += image[((y + ymin) * imageWidth + xx) * channels + c] * vertical.kk[k + y];
        out[(yy * imageWidth + xx) * channels + c] = clip8(ss);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// MSVC UCRT qsort — median-of-three quicksort with a selection-sort cutoff. Not stable, and the
// octree's palette depends on exactly how it orders equal keys.

export function msvcQsort<T>(items: T[], compare: (a: T, b: T) => number) {
  const swap = (a: number, b: number) => { if (a !== b) { const t = items[a]; items[a] = items[b]; items[b] = t; } };
  const cmp = (a: number, b: number) => compare(items[a], items[b]);
  const shortsort = (lo: number, hi: number) => {
    while (hi > lo) {
      let max = lo;
      for (let p = lo + 1; p <= hi; p += 1) if (cmp(p, max) > 0) max = p;
      swap(max, hi);
      hi -= 1;
    }
  };
  if (items.length < 2) return items;
  const loStack: number[] = []; const hiStack: number[] = [];
  let lo = 0; let hi = items.length - 1;
  for (;;) {
    const size = hi - lo + 1;
    let pushed = false;
    if (size <= 8) shortsort(lo, hi);
    else {
      let mid = lo + Math.floor(size / 2);
      if (cmp(lo, mid) > 0) swap(lo, mid);
      if (cmp(lo, hi) > 0) swap(lo, hi);
      if (cmp(mid, hi) > 0) swap(mid, hi);
      let loguy = lo; let higuy = hi;
      for (;;) {
        if (mid > loguy) { do loguy += 1; while (loguy < mid && cmp(loguy, mid) <= 0); }
        if (mid <= loguy) { do loguy += 1; while (loguy <= hi && cmp(loguy, mid) <= 0); }
        do higuy -= 1; while (higuy > mid && cmp(higuy, mid) > 0);
        if (higuy < loguy) break;
        swap(loguy, higuy);
        if (mid === higuy) mid = loguy;
      }
      higuy += 1;
      if (mid < higuy) { do higuy -= 1; while (higuy > mid && cmp(higuy, mid) === 0); }
      if (mid >= higuy) { do higuy -= 1; while (higuy > lo && cmp(higuy, mid) === 0); }
      if (higuy - lo >= hi - loguy) {
        if (lo < higuy) { loStack.push(lo); hiStack.push(higuy); }
        if (loguy < hi) { lo = loguy; pushed = true; }
      } else {
        if (loguy < hi) { loStack.push(loguy); hiStack.push(hi); }
        if (lo < higuy) { hi = higuy; pushed = true; }
      }
    }
    if (pushed) continue;
    if (!loStack.length) return items;
    lo = loStack.pop()!; hi = hiStack.pop()!;
  }
}

// ---------------------------------------------------------------------------------------------
// QuantOctree.c — FASTOCTREE for RGBA images.

type Bucket = { count: number; r: number; g: number; b: number; a: number };
type Cube = { bits: [number, number, number, number]; offsets: [number, number, number, number]; buckets: Bucket[] };
const emptyBucket = (): Bucket => ({ count: 0, r: 0, g: 0, b: 0, a: 0 });

function newCube(r: number, g: number, b: number, a: number): Cube {
  const size = 1 << (r + g + b + a);
  return { bits: [r, g, b, a], offsets: [g + b + a, b + a, a, 0], buckets: Array.from({ length: size }, emptyBucket) };
}
const cubePos = (cube: Cube, r: number, g: number, b: number, a: number) => (r << cube.offsets[0]) | (g << cube.offsets[1]) | (b << cube.offsets[2]) | (a << cube.offsets[3]);
const cubeOffset = (cube: Cube, p: readonly number[]) => cubePos(cube, p[0] >> (8 - cube.bits[0]), p[1] >> (8 - cube.bits[1]), p[2] >> (8 - cube.bits[2]), p[3] >> (8 - cube.bits[3]));
const usedBuckets = (cube: Cube) => cube.buckets.reduce((sum, bucket) => sum + (bucket.count > 0 ? 1 : 0), 0);

/** avg_color_from_color_bucket: sums and count as float32, divided in float32, truncated. */
function averageColor(bucket: Bucket): [number, number, number, number] {
  const count = Math.fround(bucket.count);
  if (count === 0) return [0, 0, 0, 0];
  const channel = (sum: number) => { const v = Math.trunc(Math.fround(Math.fround(sum) / count)); return v < 0 ? 0 : v > 255 ? 255 : v; };
  return [channel(bucket.r), channel(bucket.g), channel(bucket.b), channel(bucket.a)];
}

function copyCube(cube: Cube, r: number, g: number, b: number, a: number) {
  const result = newCube(r, g, b, a);
  const srcReduce = [0, 0, 0, 0]; const dstReduce = [0, 0, 0, 0]; const width = [0, 0, 0, 0];
  for (let i = 0; i < 4; i += 1) {
    if (cube.bits[i] > result.bits[i]) { dstReduce[i] = cube.bits[i] - result.bits[i]; width[i] = 1 << cube.bits[i]; }
    else { srcReduce[i] = result.bits[i] - cube.bits[i]; width[i] = 1 << result.bits[i]; }
  }
  for (let rr = 0; rr < width[0]; rr += 1) for (let gg = 0; gg < width[1]; gg += 1) for (let bb = 0; bb < width[2]; bb += 1) for (let aa = 0; aa < width[3]; aa += 1) {
    const src = cube.buckets[cubePos(cube, rr >> srcReduce[0], gg >> srcReduce[1], bb >> srcReduce[2], aa >> srcReduce[3])];
    const dst = result.buckets[cubePos(result, rr >> dstReduce[0], gg >> dstReduce[1], bb >> dstReduce[2], aa >> dstReduce[3])];
    dst.count += src.count; dst.r += src.r; dst.g += src.g; dst.b += src.b; dst.a += src.a;
  }
  return result;
}

/** compare_bucket_count returns `b->count - a->count` as a C int from uint32 subtraction. */
const compareCount = (x: Bucket, y: Bucket) => ((y.count - x.count) | 0);
function sortedPalette(cube: Cube) {
  return msvcQsort(cube.buckets.map((bucket) => ({ ...bucket })), compareCount);
}

function subtractBuckets(cube: Cube, buckets: Bucket[], start: number, count: number) {
  for (let i = start; i < start + count; i += 1) {
    const subtrahend = buckets[i];
    if (!subtrahend || subtrahend.count === 0) continue;
    const minuend = cube.buckets[cubeOffset(cube, averageColor(subtrahend))];
    minuend.count -= subtrahend.count; minuend.r -= subtrahend.r; minuend.g -= subtrahend.g; minuend.b -= subtrahend.b; minuend.a -= subtrahend.a;
  }
}

function addLookup(cube: Cube, palette: Bucket[], count: number, offset: number) {
  for (let i = offset + count - 1; i >= offset; i -= 1) cube.buckets[cubeOffset(cube, averageColor(palette[i]))].count = i;
}

const CUBE_LEVELS_ALPHA = [3, 4, 3, 3, 2, 2, 2, 2] as const;

/**
 * `Image.quantize(colors, method=FASTOCTREE)` on an RGBA image. Returns the palette as RGBA and the
 * index of every pixel. Pillow's Quant.c first gives every fully transparent pixel the RGB of the
 * first transparent pixel, which this repeats.
 */
export function quantizeOctreeRgba(rgba: Uint8Array, colors: number) {
  const pixelCount = rgba.length / 4;
  const pixels: [number, number, number, number][] = new Array(pixelCount);
  let transparent: [number, number, number] | null = null;
  for (let i = 0; i < pixelCount; i += 1) {
    let r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
    const a = rgba[i * 4 + 3];
    if (a === 0) { if (!transparent) transparent = [r, g, b]; else [r, g, b] = transparent; }
    pixels[i] = [r, g, b, a];
  }
  const levels = CUBE_LEVELS_ALPHA;
  const fine = newCube(levels[0], levels[1], levels[2], levels[3]);
  for (const p of pixels) { const bucket = fine.buckets[cubeOffset(fine, p)]; bucket.count += 1; bucket.r += p[0]; bucket.g += p[1]; bucket.b += p[2]; bucket.a += p[3]; }
  const coarse = copyCube(fine, levels[4], levels[5], levels[6], levels[7]);
  let coarseColors = Math.min(usedBuckets(coarse), colors);
  let fineColors = colors - coarseColors;
  const fineBuckets = sortedPalette(fine);
  subtractBuckets(coarse, fineBuckets, 0, fineColors);
  while (coarseColors > usedBuckets(coarse)) {
    const already = fineColors;
    coarseColors = usedBuckets(coarse);
    fineColors = colors - coarseColors;
    subtractBuckets(coarse, fineBuckets, already, fineColors - already);
  }
  const coarseBuckets = sortedPalette(coarse);
  const paletteBuckets = [...coarseBuckets.slice(0, coarseColors), ...fineBuckets.slice(0, fineColors)];
  const coarseLookup = newCube(levels[4], levels[5], levels[6], levels[7]);
  addLookup(coarseLookup, paletteBuckets, coarseColors, 0);
  const lookup = copyCube(coarseLookup, levels[0], levels[1], levels[2], levels[3]);
  addLookup(lookup, paletteBuckets, fineColors, coarseColors);
  const indices = new Uint8Array(pixelCount);
  for (let i = 0; i < pixelCount; i += 1) indices[i] = lookup.buckets[cubeOffset(lookup, pixels[i])].count & 0xff;
  const palette = Array.from({ length: colors }, (_, i) => averageColor(paletteBuckets[i] ?? emptyBucket()));
  return { palette, indices };
}
