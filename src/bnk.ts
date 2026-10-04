/**
 * Sony 989SND/SCREAM sound banks (.bnk) and their .td name maps, as far as the MC3 audio preview
 * needs them — a port of the parsing subset embedded in `mc3_audio_curve_gui.py` (itself translated
 * from vgmstream's bnk_sony.c, psx_decoder.c and spu_utils.c), kept result-identical to it.
 *
 * Only the "tone" header family of SBlk versions 0x03–0x05 is read: every bank in the MC3 PS2
 * asset tree is SBlk 0x03, little-endian, PS-ADPCM (283 of 283 checked). Other versions are
 * refused rather than guessed at.
 */

export type BnkStream = {
  index: number; name: string; soundIndex: number | null;
  codec: "PSX" | "PCM16" | "MPEG"; sampleRate: number;
  loopFlag: boolean; loopStart: number; loopEnd: number; numSamples: number;
  startOffset: number; streamSize: number; warnings: string[];
};
export type BnkFile = { version: number; sblkVersion: number; bankName: string; dataOffset: number; dataSize: number; streams: BnkStream[] };

class Reader {
  private view: DataView;
  constructor(readonly data: Uint8Array) { this.view = new DataView(data.buffer, data.byteOffset, data.byteLength); }
  private check(off: number, size: number) { if (off < 0 || off + size > this.data.length) throw new RangeError(`read past the end of the bank at 0x${off.toString(16)}`); }
  u8(off: number) { this.check(off, 1); return this.data[off]; }
  u16(off: number) { this.check(off, 2); return this.view.getUint16(off, true); }
  u32(off: number) { this.check(off, 4); return this.view.getUint32(off, true); }
  u64IsZero(off: number) { this.check(off, 8); return this.view.getUint32(off, true) === 0 && this.view.getUint32(off + 4, true) === 0; }
  cstring(off: number, max: number) {
    let end = off; const limit = Math.min(this.data.length, off + max);
    while (end < limit && this.data[end] !== 0) end += 1;
    return String.fromCharCode(...this.data.subarray(off, end)); // latin-1
  }
}

// --- spu_utils.c: center_note/center_fine -> sample rate ------------------------------------------
const NOTE_PITCH = [0x8000, 0x879c, 0x8fac, 0x9837, 0xa145, 0xaadc, 0xb504, 0xbfc8, 0xcb2f, 0xd744, 0xe411, 0xf1a1];
const FINE_PITCH = [
  0x8000, 0x800e, 0x801d, 0x802c, 0x803b, 0x804a, 0x8058, 0x8067, 0x8076, 0x8085, 0x8094, 0x80a3, 0x80b1, 0x80c0, 0x80cf, 0x80de,
  0x80ed, 0x80fc, 0x810b, 0x811a, 0x8129, 0x8138, 0x8146, 0x8155, 0x8164, 0x8173, 0x8182, 0x8191, 0x81a0, 0x81af, 0x81be, 0x81cd,
  0x81dc, 0x81eb, 0x81fa, 0x8209, 0x8218, 0x8227, 0x8236, 0x8245, 0x8254, 0x8263, 0x8272, 0x8282, 0x8291, 0x82a0, 0x82af, 0x82be,
  0x82cd, 0x82dc, 0x82eb, 0x82fa, 0x830a, 0x8319, 0x8328, 0x8337, 0x8346, 0x8355, 0x8364, 0x8374, 0x8383, 0x8392, 0x83a1, 0x83b0,
  0x83c0, 0x83cf, 0x83de, 0x83ed, 0x83fd, 0x840c, 0x841b, 0x842a, 0x843a, 0x8449, 0x8458, 0x8468, 0x8477, 0x8486, 0x8495, 0x84a5,
  0x84b4, 0x84c3, 0x84d3, 0x84e2, 0x84f1, 0x8501, 0x8510, 0x8520, 0x852f, 0x853e, 0x854e, 0x855d, 0x856d, 0x857c, 0x858b, 0x859b,
  0x85aa, 0x85ba, 0x85c9, 0x85d9, 0x85e8, 0x85f8, 0x8607, 0x8617, 0x8626, 0x8636, 0x8645, 0x8655, 0x8664, 0x8674, 0x8683, 0x8693,
  0x86a2, 0x86b2, 0x86c1, 0x86d1, 0x86e0, 0x86f0, 0x8700, 0x870f, 0x871f, 0x872e, 0x873e, 0x874e, 0x875d, 0x876d, 0x877d, 0x878c,
];
const cDiv = (a: number, b: number) => Math.trunc(a / b);
function psNoteToPitch(centerNote: number, centerFine: number, note: number, fine: number) {
  let fineIdx = fine + centerFine;
  let fineAdjust = fineIdx;
  if (fineIdx < 0) fineAdjust = fineIdx + 0x7f;
  fineAdjust = cDiv(fineAdjust, 128);
  const noteAdjust = note + fineAdjust - centerNote;
  let unk3 = cDiv(noteAdjust, 6);
  if (noteAdjust < 0) unk3 -= 1;
  fineIdx -= fineAdjust * 128;
  let unk2 = noteAdjust < 0 ? -1 : 0;
  if (unk3 < 0) unk3 -= 1;
  unk2 = cDiv(unk3, 2) - unk2;
  let unk1 = unk2 - 2;
  let noteIdx = noteAdjust - unk2 * 12;
  if (noteIdx < 0 || (noteIdx === 0 && fineIdx < 0)) { noteIdx += 12; unk1 = unk2 - 3; }
  if (fineIdx < 0) { noteIdx = noteIdx - 1 + fineAdjust; fineIdx += (fineAdjust + 1) * 128; }
  let pitch = Math.floor((NOTE_PITCH[noteIdx] * FINE_PITCH[fineIdx]) / 65536);
  if (unk1 < 0) pitch = Math.floor((pitch + 2 ** (-unk1 - 1)) / 2 ** -unk1);
  return pitch & 0xffff;
}
export function centerToSampleRate(centerNote: number, centerFine: number) {
  const negative = (centerNote & 0x80) !== 0;
  let pitch = psNoteToPitch(negative ? 0x100 - centerNote : centerNote, centerFine, 60, 0);
  if (pitch > 0x4000) pitch = 0x4000;
  if (!negative) pitch = cDiv(pitch * 44100, 48000);
  return cDiv(48000 * pitch, 4096);
}

// --- psx_decoder.c ----------------------------------------------------------------------------------
const psBytesToSamples = (bytes: number, channels: number) => channels <= 0 ? 0 : Math.floor(Math.floor(Math.floor(bytes / channels) / 0x10) * 28);
function psFindLoopOffsets(data: Uint8Array, start: number, size: number, channels: number, interleave: number): [boolean, number, number] {
  if (size === 0 || channels === 0 || (channels > 1 && interleave === 0)) return [false, 0, 0];
  let numSamples = 0; let loopStart = 0; let loopEnd = 0; let startFound = false; let endFound = false;
  let offset = start; const max = start + size; let consumed = 0; const n = data.length;
  while (offset < max) {
    if (offset + 2 > n) break;
    const flag = data[offset + 1] & 0x0f;
    if (flag === 0x06 && !startFound) { loopStart = numSamples; startFound = true; }
    if (flag === 0x03 && !loopEnd) {
      loopEnd = numSamples + 28; endFound = true;
      if (channels === 1 && offset + 0x10 < max && offset + 0x12 <= n && (data[offset + 0x11] & 0x0f) === 0x06) { loopEnd = 0; endFound = false; }
      if (startFound && endFound) break;
    }
    numSamples += 28; offset += 0x10; consumed += 0x10;
    if (consumed === interleave) { consumed = 0; offset += interleave * (channels - 1); }
  }
  return startFound && endFound ? [true, loopStart, loopEnd] : [false, 0, 0];
}

const PS_COEFS: [number, number][] = [[0, 0], [0.9375, 0], [1.796875, -0.8125], [1.53125, -0.859375], [1.90625, -0.9375]];
/** Mono PS-ADPCM to int16, 28 samples per 16-byte frame — vgmstream's float-math decode_psx. */
export function decodePsAdpcm(payload: Uint8Array) {
  const frames = payload.length >= 0x10 ? Math.floor((payload.length - 0x10) / 0x10) + 1 : 0;
  const out = new Int16Array(frames * 28);
  let hist1 = 0; let hist2 = 0; let o = 0;
  for (let off = 0; off + 0x0f < payload.length; off += 0x10) {
    const header = payload[off];
    let coef = (header >> 4) & 0xf; let shiftFactor = header & 0xf;
    const flag = payload[off + 1] & 0x0f;
    if (coef > 4) coef = 0;
    if (shiftFactor > 12) shiftFactor = 9;
    const [c0, c1] = PS_COEFS[coef]; const shift = 20 - shiftFactor; const decode = flag < 0x07;
    for (let i = 0; i < 28; i += 1) {
      let sample = 0;
      if (decode) {
        const b = payload[off + 2 + (i >> 1)];
        let nibble = i & 1 ? b >> 4 : b & 0x0f;
        if (nibble >= 8) nibble -= 16;
        // Python ints: the shifts are exact multiplications and floor divisions here.
        sample = nibble * 2 ** shift + Math.trunc((c0 * hist1 + c1 * hist2) * 256);
        sample = Math.floor(sample / 256);
      }
      out[o++] = sample > 32767 ? 32767 : sample < -32768 ? -32768 : sample;
      hist2 = hist1; hist1 = sample;
    }
  }
  return out;
}

// --- bnk_sony.c, tone-header family --------------------------------------------------------------
export function parseBnk(data: Uint8Array): BnkFile {
  if (data.length < 0x20) throw new Error("Too small to be a sound bank.");
  const br = new Reader(data);
  const le = new DataView(data.buffer, data.byteOffset, 4).getUint32(0, true);
  const be = new DataView(data.buffer, data.byteOffset, 4).getUint32(0, false);
  if (!(le === 1 || le === 3) && (be === 1 || be === 3)) throw new Error("Big-endian banks aren't supported by this preview.");
  const version = br.u32(0x00);
  if (version !== 1 && version !== 3) throw new Error(`Unknown header (version ${version}) — not a Sony/SCREAM .bnk.`);
  const sections = br.u32(0x04);
  if (sections < 2 || sections > 3) throw new Error(`Invalid section count (${sections}).`);
  const sblkOffset = br.u32(0x08); const dataOffset = br.u32(0x10); const dataSize = br.u32(0x14);
  if (sblkOffset > 0x20) throw new Error(`Invalid sblk offset 0x${sblkOffset.toString(16)}.`);
  if (version !== 3 || br.u32(sblkOffset) !== 0x6b6c4253 /* "SBlk" */) throw new Error("Only SBlk (version 3) banks are supported — the kind MC3 uses.");
  const v = br.u32(sblkOffset + 0x04);
  if (v !== 0x03 && v !== 0x04 && v !== 0x05) throw new Error(`SBlk version 0x${v.toString(16)} isn't supported — MC3's banks are 0x03.`);

  const so = sblkOffset;
  const soundsEntries = br.u16(so + 0x16); const grainsEntries = br.u16(so + 0x18);
  const table1 = so + br.u32(so + 0x1c); const table2 = so + br.u32(so + 0x20);
  const table3 = so + br.u32(so + 0x34); const table4 = so + br.u32(so + 0x38);
  const t1Size = 0x0c;

  const findSoundIndex = (t2: number) => {
    if (table1 === 0 || soundsEntries === 0) return null;
    for (let i = 0; i < soundsEntries; i += 1) {
      const entryOffset = br.u32(table1 + i * t1Size + 0x08); const count = br.u8(table1 + i * t1Size + 0x04);
      if (entryOffset <= t2 && t2 < entryOffset + count * 0x08) return i;
    }
    return null;
  };

  const streams: BnkStream[] = []; const t2Offsets: number[] = [];
  let idx = 0;
  for (let i = 0; i < grainsEntries; i += 1) {
    const value = br.u32(table2 + i * 0x08);
    if (((value >>> 16) & 0xffff) !== 0x0100) continue;
    idx += 1;
    const t2 = i * 0x08; const sndh = table3 + (value & 0xffff);
    const centerNote = br.u8(sndh + 0x02); const centerFine = br.u8(sndh + 0x03);
    const flags = br.u16(sndh + 0x0e); const streamOffset = br.u32(sndh + 0x10);
    let size = br.u32(sndh + 0x14);
    const s: BnkStream = { index: idx, name: "", soundIndex: findSoundIndex(t2), codec: "PSX", sampleRate: centerToSampleRate(centerNote, centerFine), loopFlag: false, loopStart: 0, loopEnd: 0, numSamples: 0, startOffset: dataOffset + streamOffset, streamSize: 0, warnings: [] };
    if (v <= 0x03 && size === 0 && (flags & 0x80) === 0) {
      // Early versions don't store the PS-ADPCM size: scan for the silent/end frame.
      const max = data.length; let offset = dataOffset + streamOffset + 0x10; size = 0x10;
      while (offset < max) {
        const loZero = offset + 8 <= max ? br.u64IsZero(offset) : false;
        const hiZero = offset + 16 <= max ? br.u64IsZero(offset + 8) : false;
        if (loZero && hiZero) break;
        size += 0x10;
        if (offset + 8 <= max) { const b0 = br.u32(offset); const b1 = br.u32(offset + 4); if ((b0 === 0x00077777 && b1 === 0x77777777) || (b0 === 0x00070000 && b1 === 0)) break; }
        offset += 0x10;
      }
      s.warnings.push("Size found by scanning (the table stores 0).");
    }
    s.streamSize = size;
    let loopLength = 0; let extradata = 0;
    if (flags & 0x80) s.codec = "PCM16";
    else if (flags & 0x1000) {
      s.numSamples = new DataView(data.buffer, data.byteOffset).getInt32(s.startOffset + 0x24, true);
      extradata = 0x80; s.codec = "MPEG";
    } else {
      const [found, ls, le2] = psFindLoopOffsets(data, s.startOffset, s.streamSize, 1, s.streamSize);
      if (found) { s.loopStart = ls; s.loopEnd = le2; }
    }
    s.startOffset += extradata; s.streamSize -= extradata;
    if (s.loopStart < 0) { s.loopStart = 0; loopLength = 0; }
    if (loopLength) s.loopEnd = s.loopStart + loopLength;
    s.loopFlag = s.loopStart >= 0 && s.loopEnd > 0;
    if (s.codec === "PCM16") s.numSamples = Math.floor(s.streamSize / 2);
    else if (s.codec === "PSX") s.numSamples = psBytesToSamples(s.streamSize, 1);
    streams.push(s); t2Offsets.push(t2);
  }

  // Names from table4, best effort (the .td sidecar is what the game looks names up in).
  let bankName = "";
  if (table4 > sblkOffset) {
    try {
      bankName = br.cstring(table4, 0x100);
      const t1Entry = (t2: number) => { for (let i = 0; i < soundsEntries; i += 1) { const e = br.u32(table1 + i * t1Size + 0x08); const c = br.u8(table1 + i * t1Size + 0x04); if (e <= t2 && t2 < e + c * 0x08) return i; } return null; };
      if (v === 0x03) {
        const entries = table4 + 0x18; const names = table4 + br.u32(table4 + 0x08);
        streams.forEach((s, k) => {
          const id = t1Entry(t2Offsets[k]); if (id === null) return;
          let found: string | null = null;
          for (let i = 0; i < 32 && !found; i += 1) {
            let nameOff = names + br.u16(entries + i * 2) * 0x14;
            while (br.u8(nameOff)) {
              const chk = (br.u8(nameOff) + br.u8(nameOff + 4) + br.u8(nameOff + 8) + br.u8(nameOff + 12)) & 0x1f;
              if (chk !== i) { found = "__bad_chain__"; break; }
              if (br.u16(nameOff + 0x10) === id) { found = br.cstring(nameOff, 0x100); break; }
              nameOff += 0x14;
            }
          }
          if (found && found !== "__bad_chain__") s.name = found;
        });
      } else {
        const entries = table4 + br.u32(table4 + 0x08); const names = table4 + br.u32(table4 + 0x0c);
        streams.forEach((s, k) => {
          const id = t1Entry(t2Offsets[k]); if (id === null) return;
          for (let i = 0; i < soundsEntries; i += 1) if (br.u16(entries + i * 0x10 + 0x0c) === id) { s.name = br.cstring(names + br.u32(entries + i * 0x10), 0x100); break; }
        });
      }
    } catch { for (const s of streams) s.warnings.push("Could not read the names table; names may be missing."); }
  }
  return { version, sblkVersion: v, bankName, dataOffset, dataSize, streams };
}

/** A .td sidecar: `TD_FILE 3.0`, `NUMSOUNDS n`, then name / index / flag per sound. */
export function parseTd(text: string) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length || !lines[0].startsWith("TD_FILE")) throw new Error("Not a .td file (expected 'TD_FILE' on the first line).");
  if (lines.length < 2 || !lines[1].startsWith("NUMSOUNDS")) throw new Error("Expected 'NUMSOUNDS N' on the second line.");
  const count = parseInt(lines[1].split(/\s+/)[1], 10);
  const sounds: { name: string; index: number; flag: number }[] = [];
  for (let i = 0, pos = 2; i < count; i += 1, pos += 3) {
    if (pos + 2 >= lines.length + 1 || pos + 1 >= lines.length) throw new Error("Truncated .td file.");
    sounds.push({ name: lines[pos], index: parseInt(lines[pos + 1], 10), flag: parseInt(lines[pos + 2], 10) });
  }
  return sounds;
}

export type BankSample = { payload: Uint8Array; rate: number; loop: boolean; loopStart: number; loopEnd: number; streamIndex: number; pcm: Int16Array | null };
/** The script's BankSamples: PS-ADPCM streams by upper-case name (from the .td, else table4), decoded lazily. */
export class BankSamples {
  readonly samples = new Map<string, BankSample>();
  hasNameMapping = false;
  constructor(bnk: Uint8Array, td: string | null) {
    const bank = parseBnk(bnk);
    const bySound = new Map<number, string>();
    if (td !== null) { for (const s of parseTd(td)) bySound.set(s.index, s.name); this.hasNameMapping = bySound.size > 0; }
    for (const s of bank.streams) {
      if (s.codec !== "PSX") continue;
      const mapped = s.soundIndex === null ? undefined : bySound.get(s.soundIndex);
      const embedded = s.name.trim();
      const name = mapped || embedded || `STREAM_${String(s.index).padStart(3, "0")}`;
      if (mapped || embedded) this.hasNameMapping = true;
      const key = name.toUpperCase();
      if (!this.samples.has(key)) this.samples.set(key, { payload: bnk.slice(s.startOffset, s.startOffset + s.streamSize), rate: s.sampleRate > 0 ? s.sampleRate : 32000, loop: s.loopFlag, loopStart: s.loopStart, loopEnd: s.loopEnd, streamIndex: s.index, pcm: null });
    }
    if (!this.samples.size) throw new Error("The bank holds no PS-ADPCM streams this preview can play.");
  }
  names() { return [...this.samples.keys()]; }
  get(name: string) {
    const entry = this.samples.get((name || "").toUpperCase());
    if (entry && !entry.pcm) entry.pcm = decodePsAdpcm(entry.payload);
    return entry ?? null;
  }
}

export function buildWav(samples: Int16Array, sampleRate: number, channels = 1) {
  const out = new Uint8Array(44 + samples.length * 2); const view = new DataView(out.buffer);
  const tag = (off: number, text: string) => { for (let i = 0; i < 4; i += 1) out[off + i] = text.charCodeAt(i); };
  tag(0, "RIFF"); view.setUint32(4, 36 + samples.length * 2, true); tag(8, "WAVE"); tag(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true); view.setUint16(32, channels * 2, true); view.setUint16(34, 16, true);
  tag(36, "data"); view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i += 1) view.setInt16(44 + i * 2, samples[i], true);
  return out;
}
