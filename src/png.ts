/**
 * PNG in and out, without going through a canvas.
 *
 * A canvas stores pixels premultiplied by alpha, so reading a semi-transparent pixel back loses its
 * colour — exactly the pixels a PS2 texture's 0..128 alpha is made of. Decoding here yields the
 * straight RGBA `Image.open(path).convert("RGBA")` gives in Pillow, which is what the texture
 * import pipeline was built against. Encoding writes straight RGBA as-is.
 */

import type { RgbaImage } from "./ps2-texture";

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

async function inflate(data: Uint8Array) {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function deflate(data: Uint8Array) {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function paeth(a: number, b: number, c: number) {
  const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export async function decodePng(bytes: Uint8Array): Promise<RgbaImage> {
  if (bytes.length < 8 || !SIGNATURE.every((value, i) => bytes[i] === value)) throw new Error("Not a PNG file.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  let palette: Uint8Array | null = null; let transparency: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  for (let at = 8; at + 8 <= bytes.length;) {
    const length = view.getUint32(at); const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    const body = bytes.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") { width = view.getUint32(at + 8); height = view.getUint32(at + 12); bitDepth = body[8]; colorType = body[9]; interlace = body[12]; }
    else if (type === "PLTE") palette = body;
    else if (type === "tRNS") transparency = body;
    else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
    at += 12 + length;
  }
  if (!width || !height) throw new Error("The PNG has no image header.");
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[colorType];
  if (!channels) throw new Error(`Unsupported PNG colour type ${colorType}.`);
  if (bitDepth === 16 && colorType === 0) throw new Error("16-bit greyscale PNGs are not supported — save it as 8-bit.");
  if (bitDepth === 16 && colorType === 4) throw new Error("16-bit greyscale PNGs are not supported — save it as 8-bit.");
  if (colorType === 3 && !palette) throw new Error("The PNG is paletted but has no palette.");
  const joined = new Uint8Array(idat.reduce((sum, chunk) => sum + chunk.length, 0));
  idat.reduce((offset, chunk) => { joined.set(chunk, offset); return offset + chunk.length; }, 0);
  const raw = await inflate(joined);
  const bitsPerPixel = channels * bitDepth;
  const bytesPerPixel = Math.max(1, bitsPerPixel >> 3);
  const out = new Uint8Array(width * height * 4);

  // Adam7 passes as [xStart, yStart, xStep, yStep]; a non-interlaced image is one full pass.
  const passes = interlace ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] : [[0, 0, 1, 1]];
  let offset = 0;
  const maxSample = (1 << bitDepth) - 1;
  const gray = (value: number) => bitDepth === 16 ? value : Math.round(value * 255 / maxSample);
  for (const [x0, y0, dx, dy] of passes) {
    const passWidth = Math.ceil((width - x0) / dx); const passHeight = Math.ceil((height - y0) / dy);
    if (passWidth <= 0 || passHeight <= 0) continue;
    const stride = Math.ceil(passWidth * bitsPerPixel / 8);
    let previous = new Uint8Array(stride);
    for (let row = 0; row < passHeight; row += 1) {
      const filter = raw[offset]; const line = raw.slice(offset + 1, offset + 1 + stride); offset += 1 + stride;
      for (let i = 0; i < stride; i += 1) {
        const left = i >= bytesPerPixel ? line[i - bytesPerPixel] : 0; const up = previous[i]; const upLeft = i >= bytesPerPixel ? previous[i - bytesPerPixel] : 0;
        if (filter === 1) line[i] = (line[i] + left) & 0xff;
        else if (filter === 2) line[i] = (line[i] + up) & 0xff;
        else if (filter === 3) line[i] = (line[i] + ((left + up) >> 1)) & 0xff;
        else if (filter === 4) line[i] = (line[i] + paeth(left, up, upLeft)) & 0xff;
      }
      previous = line;
      const sample = (index: number) => {
        if (bitDepth === 8) return line[index];
        if (bitDepth === 16) return line[index * 2]; // Pillow keeps the high byte of 16-bit samples.
        const bit = index * bitDepth; return (line[bit >> 3] >> (8 - bitDepth - (bit & 7))) & maxSample;
      };
      const y = y0 + row * dy;
      for (let column = 0; column < passWidth; column += 1) {
        const x = x0 + column * dx; const target = (y * width + x) * 4; const s = column * channels;
        let r: number, g: number, b: number, a = 255;
        if (colorType === 3) {
          const index = sample(s); r = palette![index * 3]; g = palette![index * 3 + 1]; b = palette![index * 3 + 2];
          if (transparency && index < transparency.length) a = transparency[index];
        } else if (colorType === 0 || colorType === 4) {
          const raw0 = sample(s); r = g = b = gray(raw0);
          if (colorType === 4) a = sample(s + 1);
          else if (transparency && transparency.length >= 2 && raw0 === ((transparency[0] << 8) | transparency[1])) a = 0;
        } else {
          r = sample(s); g = sample(s + 1); b = sample(s + 2);
          if (colorType === 6) a = sample(s + 3);
          else if (transparency && transparency.length >= 6 && bitDepth === 8 && r === transparency[1] && g === transparency[3] && b === transparency[5]) a = 0;
        }
        out[target] = r; out[target + 1] = g; out[target + 2] = b; out[target + 3] = a;
      }
    }
  }
  return { width, height, data: out };
}

const crcTable = (() => { const table = new Uint32Array(256); for (let n = 0; n < 256; n += 1) { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; } return table; })();
function crc32(parts: Uint8Array[]) { let c = 0xffffffff; for (const part of parts) for (const value of part) c = crcTable[(c ^ value) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

export async function encodePng(image: RgbaImage): Promise<Uint8Array> {
  const { width, height, data } = image;
  const raw = new Uint8Array(height * (1 + width * 4));
  for (let y = 0; y < height; y += 1) raw.set(data.subarray(y * width * 4, (y + 1) * width * 4), y * (1 + width * 4) + 1);
  const header = new Uint8Array(13); const headerView = new DataView(header.buffer);
  headerView.setUint32(0, width); headerView.setUint32(4, height); header[8] = 8; header[9] = 6;
  const chunks: [string, Uint8Array][] = [["IHDR", header], ["IDAT", await deflate(raw)], ["IEND", new Uint8Array(0)]];
  const size = 8 + chunks.reduce((sum, [, body]) => sum + 12 + body.length, 0);
  const out = new Uint8Array(size); const view = new DataView(out.buffer);
  out.set(SIGNATURE, 0);
  let at = 8;
  for (const [type, body] of chunks) {
    const typeBytes = new TextEncoder().encode(type);
    view.setUint32(at, body.length); out.set(typeBytes, at + 4); out.set(body, at + 8);
    view.setUint32(at + 8 + body.length, crc32([typeBytes, body]));
    at += 12 + body.length;
  }
  return out;
}
