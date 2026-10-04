import { tr, Tx, confirmDialog } from "./i18n";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { readFile, writeFile } from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";
import {
  buildAllMipImport, buildFlashImport, buildSingleMipImport, decodeTexture, hasMips, paletteOrders, prepareImportSource, REMIX_MIP_LEVELS, REMIX_PALETTE_RELATIVE, textureBytes, unpackPalette8,
  type Candidate, type DecodeSpec, type PaletteOrder, type RgbaImage,
} from "../src/ps2-texture";
import { decodePng, encodePng } from "../src/png";
import type { ScanMessage } from "../src/texture-scan.worker";
import { basename, parentFolder, parentPath, readToolkitFile, sizeLabel, writeVerified } from "./mod-toolkit/toolkit-io";
import { loadRecent, pushRecent, saveRecent } from "./recent-paths";

/**
 * Textures — find, preview, export and replace the PS2 indexed textures inside one PCK: a car PCK
 * (non-remix 256 textures and remix mip chains, found by a scored scan) or a Flash/UI PCK
 * (ds_/ms_/ps_/vs_, whose texture records are read exactly). A port of the Texture Finder script;
 * every byte it computes is produced by `src/ps2-texture.ts`, validated against that script.
 *
 * A loose-file tool like the Mod Toolkit: it opens its own file, holds edits in memory with undo,
 * and writes only on Save. Saving goes through `writeVerified`, so a car PCK the vehicle set holds
 * is reloaded there instead of being overwritten by its stale copy later.
 */

type TextureFile = { path: string; name: string; bytes: Uint8Array; saved: Uint8Array };
type EditRange = { offset: number; before: Uint8Array; after: Uint8Array };
type EditAction = { label: string; ranges: EditRange[] };
type IndexLayout = "8s" | "4s" | "8l" | "4l";
type Manual = { texture: string; palette: string; width: number; height: number; layout: IndexLayout; order: PaletteOrder; flip: boolean; lockPalette: boolean };

const RECENTS_KEY = "mc3pae.recentTextureFiles";
const MAX_UNDO = 20;
const SIZES = [16, 32, 64, 128, 256, 512, 1024];
const layoutLabels: Record<IndexLayout, string> = { "8s": "PS2 8bpp swizzled", "4s": "PS2 4bpp swizzled", "8l": "Raw 8bpp linear", "4l": "Raw 4bpp linear" };
const hex8 = (value: number) => `0x${value.toString(16).toUpperCase().padStart(8, "0")}`;
const parseOffset = (text: string) => { const value = text.trim().replace(/_/g, ""); if (!value) return null; const parsed = /^0x[0-9a-f]+$/i.test(value) ? parseInt(value, 16) : /^\d+$/.test(value) ? Number(value) : NaN; return Number.isFinite(parsed) ? parsed : null; };
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((value, i) => value === b[i]);
const layoutName = (candidate: Candidate) => candidate.layout === "flash" ? "Flash / Shop" : candidate.layout === "remix" ? "Remix" : "Non-remix";
const mipLevels = (candidate: Candidate) => hasMips(candidate) ? REMIX_MIP_LEVELS : REMIX_MIP_LEVELS.slice(0, 1);
const isTyping = (target: EventTarget | null) => target instanceof HTMLElement && Boolean(target.closest("input, select, textarea"));

/** What the app's File and Edit menus need from this tab while it is the active one: the menus are
 *  drawn by the page, but every action runs against the PCK this tab holds, not the vehicle set. */
export type TextureMenu = {
  hasFile: boolean; dirty: boolean; canUndo: boolean; canRedo: boolean;
  open(): void; save(): void; saveAs(): void; close(): void; undo(): void; redo(): void;
};

function drawRgba(canvas: HTMLCanvasElement | null, image: RgbaImage | null) {
  if (!canvas) return;
  const context = canvas.getContext("2d"); if (!context) return;
  if (!image) { context.clearRect(0, 0, canvas.width, canvas.height); return; }
  canvas.width = image.width; canvas.height = image.height;
  context.putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0);
}

/** Byte spans a candidate's image comes from: its texture (a remix chain spans every level) and its palette. */
function candidateSpans(candidate: Candidate): [number, number][] {
  const texture = candidate.layout === "remix" ? 0x15700 : textureBytes(candidate.width, candidate.height, candidate.bpp);
  return [[candidate.textureOffset, candidate.textureOffset + texture], [candidate.paletteOffset, candidate.paletteOffset + (candidate.bpp === 8 ? 0x400 : 0x40)]];
}

/** Redrawn only when `version` changes — an edit that touched this candidate's bytes — not on every
 *  edit to the file, which would decode every thumbnail in the list each time. */
function Thumbnail({ data, candidate, version }: { data: Uint8Array; candidate: Candidate; version: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const dataRef = useRef(data);
  dataRef.current = data;
  useEffect(() => {
    const data = dataRef.current;
    try {
      const rgba = decodeTexture(data, { textureOffset: candidate.textureOffset, paletteOffset: candidate.paletteOffset, width: candidate.width, height: candidate.height, order: candidate.paletteOrder, swizzled: true, flipVertical: false, bpp: candidate.bpp });
      drawRgba(ref.current, { width: candidate.width, height: candidate.height, data: rgba });
    } catch { drawRgba(ref.current, null); }
  }, [candidate, version]);
  return <canvas ref={ref} className="tex-thumb" />;
}

export function TextureWorkspace({ active, dropped, onConsumeDrop, onStatus, isPathBlocked, onPendingChange, menuRef }: {
  /** The tab is kept mounted while hidden, so pending edits survive a trip to another tab. */
  active: boolean;
  dropped: string[] | null;
  onConsumeDrop(): void;
  onStatus(message: string): void;
  isPathBlocked(path: string): string | null;
  onPendingChange(pending: boolean): void;
  /** Refreshed on every render; the page reads it when it draws the File and Edit menus. */
  menuRef: React.MutableRefObject<TextureMenu | null>;
}) {
  const [file, setFile] = useState<TextureFile | null>(null);
  const [dirty, setDirty] = useState(false);
  const undoStack = useRef<EditAction[]>([]);
  const thumbVersions = useRef(new Map<Candidate, number>());
  const redoStack = useRef<EditAction[]>([]);
  const [, setHistoryTick] = useState(0);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [mip, setMip] = useState(256);
  const [manual, setManual] = useState<Manual>({ texture: "0x00000000", palette: "0x00010000", width: 256, height: 256, layout: "8s", order: "RGBA", flip: false, lockPalette: true });
  const [scanOptions, setScanOptions] = useState({ alignment: 0x10, maxResults: 50 });
  /** Which layouts the list shows. A view filter over the last scan — toggling one never rescans. */
  const [filters, setFilters] = useState<Record<Candidate["layout"], boolean>>({ nonremix: true, remix: true, flash: true });
  const [scan, setScan] = useState<{ fraction: number; text: string } | null>(null);
  const [zoom, setZoom] = useState<number | "fit">("fit");
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [error, setError] = useState("");
  const [recents, setRecents] = useState<string[]>(() => loadRecent(RECENTS_KEY));
  const workerRef = useRef<Worker | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);

  useEffect(() => { onPendingChange(dirty); }, [dirty, onPendingChange]);
  useEffect(() => () => workerRef.current?.terminate(), []);

  const candidate = selected !== null ? candidates[selected] ?? null : null;
  const touchThumbnails = (ranges: EditRange[]) => {
    for (const item of candidates) {
      if (candidateSpans(item).some(([start, end]) => ranges.some((range) => range.offset < end && range.offset + range.after.length > start))) {
        thumbVersions.current.set(item, (thumbVersions.current.get(item) ?? 0) + 1);
      }
    }
  };

  const spec = useMemo<DecodeSpec | null>(() => {
    const textureOffset = parseOffset(manual.texture); const paletteOffset = parseOffset(manual.palette);
    if (textureOffset === null || paletteOffset === null) return null;
    return { textureOffset, paletteOffset, width: manual.width, height: manual.height, order: manual.order, swizzled: manual.layout.endsWith("s"), flipVertical: manual.flip, bpp: manual.layout.startsWith("4") ? 4 : 8 };
  }, [manual]);
  const decoded = useMemo<{ image: RgbaImage | null; error: string }>(() => {
    if (!file) return { image: null, error: "" };
    if (!spec) return { image: null, error: "Offsets must be hexadecimal (0x…) or decimal numbers." };
    try { return { image: { width: spec.width, height: spec.height, data: decodeTexture(file.bytes, spec) }, error: "" }; }
    catch (caught) { return { image: null, error: caught instanceof Error ? caught.message : "Could not decode." }; }
  }, [file, spec]);
  useEffect(() => { drawRgba(canvasRef.current, decoded.image); }, [decoded.image]);

  useEffect(() => {
    const stage = stageRef.current; if (!stage) return;
    const observer = new ResizeObserver(() => setViewport({ width: stage.clientWidth, height: stage.clientHeight }));
    observer.observe(stage);
    return () => observer.disconnect();
  }, [file]);
  const scale = decoded.image ? zoom === "fit" ? Math.max(0.1, Math.min(16, Math.min((viewport.width - 32) / decoded.image.width, (viewport.height - 32) / decoded.image.height))) : zoom : 1;
  const setZoomLevel = (value: number) => setZoom(Math.max(0.1, Math.min(16, value)));

  /** Points the decoder at one level of a candidate, the way selecting it in the script does. */
  const showCandidate = useCallback((next: Candidate, size = 256) => {
    const level = next.layout === "flash" ? 0 : (mipLevels(next).find(([levelSize]) => levelSize === size) ?? [256, 0])[1];
    const width = next.layout === "flash" ? next.width : size; const height = next.layout === "flash" ? next.height : size;
    setMip(next.layout === "flash" ? 256 : size);
    setManual((current) => ({ ...current, texture: hex8(next.textureOffset + level), palette: hex8(next.paletteOffset), width, height, order: next.paletteOrder, layout: next.bpp === 4 ? "4s" : "8s" }));
  }, []);
  const selectCandidate = useCallback((index: number) => {
    setSelected(index);
    const next = candidates[index]; if (next) showCandidate(next, 256);
  }, [candidates, showCandidate]);

  const startScan = useCallback((target: TextureFile | null = file) => {
    if (!target) return;
    workerRef.current?.terminate();
    const worker = new Worker(new URL("../src/texture-scan.worker.ts", import.meta.url), { type: "module" });
    workerRef.current = worker;
    setScan({ fraction: 0, text: "Starting scan…" }); setCandidates([]); setSelected(null);
    worker.onmessage = (event: MessageEvent<ScanMessage>) => {
      const message = event.data;
      if (message.kind === "progress") { setScan({ fraction: message.fraction, text: message.text }); return; }
      worker.terminate(); if (workerRef.current === worker) workerRef.current = null;
      setScan(null);
      if (message.kind === "error") { setError(`Scan failed: ${message.message}`); return; }
      setCandidates(message.candidates);
      if (message.candidates.length) { setSelected(0); showCandidate(message.candidates[0]); }
      onStatus(message.flash ? `${message.candidates.length} Flash/UI texture${message.candidates.length === 1 ? "" : "s"} read exactly` : `Scan complete · ${message.candidates.length} ranked candidates`);
    };
    worker.postMessage({ data: target.bytes, options: { nonRemix: true, remix: true, ...scanOptions }, flash: true });
  }, [file, onStatus, scanOptions, showCandidate]);
  const stopScan = () => { workerRef.current?.terminate(); workerRef.current = null; setScan(null); onStatus("Scan stopped"); };

  const openPath = useCallback(async (path: string) => {
    const blocked = isPathBlocked(path);
    if (blocked) { setError(blocked); return; }
    try {
      setError("");
      const opened = await readToolkitFile(path);
      const next = { path: opened.path, name: opened.name, bytes: opened.bytes, saved: opened.bytes.slice() };
      setFile(next); setDirty(false); undoStack.current = []; redoStack.current = []; setHistoryTick((tick) => tick + 1);
      setRecents(pushRecent(RECENTS_KEY, opened.path));
      setZoom("fit");
      onStatus(`${opened.name} loaded · ${sizeLabel(opened.bytes.length)}`);
      startScan(next);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not open that file."); }
  }, [isPathBlocked, onStatus, startScan]);

  const confirmDiscard = useCallback(async () => {
    if (!dirty) return true;
    return confirmDialog(`${file?.name} has unsaved texture edits. Discard them?`, { title: "Unsaved changes", kind: "warning" });
  }, [dirty, file]);
  const browse = useCallback(async () => {
    if (!await confirmDiscard()) return;
    const selection = await open({ multiple: false, defaultPath: file ? parentPath(file.path) : undefined, filters: [{ name: "MC3 PCK", extensions: ["pck", "psppck", "xbck"] }, { name: "All files", extensions: ["*"] }] });
    if (typeof selection === "string") void openPath(selection);
  }, [confirmDiscard, file, openPath]);
  const openRecent = useCallback(async (path: string) => { if (await confirmDiscard()) void openPath(path); }, [confirmDiscard, openPath]);

  useEffect(() => {
    if (!dropped) return;
    const path = dropped[0]; onConsumeDrop();
    if (path) void openRecent(path);
  }, [dropped, onConsumeDrop, openRecent]);

  const applyChanges = (changes: [number, Uint8Array][], label: string) => {
    if (!file) return false;
    const ranges: EditRange[] = [];
    const sorted = [...changes].sort((a, b) => a[0] - b[0]);
    let occupiedEnd = -1;
    for (const [offset, payload] of sorted) {
      if (offset < 0 || offset + payload.length > file.bytes.length) throw new Error(`Edit does not fit inside the PCK: ${hex8(offset)}..${hex8(offset + payload.length)}.`);
      if (offset < occupiedEnd) throw new Error("Import ranges overlap.");
      occupiedEnd = offset + payload.length;
      const before = file.bytes.slice(offset, offset + payload.length);
      if (!sameBytes(before, payload)) ranges.push({ offset, before, after: payload.slice() });
    }
    if (!ranges.length) { onStatus("The import produced no byte changes."); return false; }
    const bytes = file.bytes.slice();
    for (const range of ranges) bytes.set(range.after, range.offset);
    touchThumbnails(ranges);
    undoStack.current.push({ label, ranges }); if (undoStack.current.length > MAX_UNDO) undoStack.current.shift();
    redoStack.current = [];
    setFile({ ...file, bytes }); setDirty(!sameBytes(bytes, file.saved)); setHistoryTick((tick) => tick + 1);
    return true;
  };
  const replay = (from: React.MutableRefObject<EditAction[]>, to: React.MutableRefObject<EditAction[]>, side: "before" | "after") => {
    if (!file) return;
    const action = from.current.pop(); if (!action) return;
    const bytes = file.bytes.slice();
    for (const range of side === "before" ? [...action.ranges].reverse() : action.ranges) bytes.set(range[side], range.offset);
    touchThumbnails(action.ranges);
    to.current.push(action);
    setFile({ ...file, bytes }); setDirty(!sameBytes(bytes, file.saved)); setHistoryTick((tick) => tick + 1);
    onStatus(`${side === "before" ? "Undo" : "Redo"} · ${action.label}`);
  };
  const undo = () => replay(undoStack, redoStack, "before");
  const redo = () => replay(redoStack, undoStack, "after");

  const saveTo = async (path: string) => {
    if (!file) return;
    const blocked = isPathBlocked(path);
    if (blocked) { setError(blocked); return; }
    try {
      await writeVerified(path, file.bytes);
      setFile({ ...file, path, name: basename(path), saved: file.bytes.slice() }); setDirty(false);
      if (path !== file.path) setRecents(pushRecent(RECENTS_KEY, path));
      onStatus(`${basename(path)} saved · read back and verified`);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "The file could not be saved."); }
  };
  const save = () => { if (file && dirty) void saveTo(file.path); };
  const saveAs = async () => {
    if (!file) return;
    const target = await saveDialog({ defaultPath: file.path, filters: [{ name: "MC3 PCK", extensions: ["pck", "psppck"] }] });
    if (target) void saveTo(target);
  };

  /** Back to the tab's start screen — the PCK, its scan and its undo history are dropped. */
  const close = async () => {
    if (!file || !await confirmDiscard()) return;
    workerRef.current?.terminate(); workerRef.current = null; setScan(null);
    setFile(null); setDirty(false); setCandidates([]); setSelected(null); setError("");
    undoStack.current = []; redoStack.current = []; thumbVersions.current.clear(); setHistoryTick((tick) => tick + 1);
    onStatus(`${file.name} closed`);
  };

  const pickImage = async () => {
    const selection = await open({ multiple: false, defaultPath: file ? parentPath(file.path) : undefined, filters: [{ name: "PNG image", extensions: ["png"] }] });
    if (typeof selection !== "string") return null;
    return { name: basename(selection), image: prepareImportSource(await decodePng(await readFile(selection))) };
  };
  const importLevel = async () => {
    if (!file || !candidate) return;
    try {
      const picked = await pickImage(); if (!picked) return;
      const { image, name } = picked; const order = manual.order;
      const source = `${name} (${image.width}×${image.height})`;
      if (candidate.layout === "flash") {
        const built = buildFlashImport(image, candidate.width, candidate.height, candidate.bpp, order);
        if (applyChanges([[candidate.textureOffset, built.indices], [candidate.paletteOffset, built.palette]], `Import Flash item #${candidate.sequenceIndex} from ${name}`)) {
          candidate.paletteOrder = order; onStatus(`Imported ${source} as Flash item #${candidate.sequenceIndex}, ${candidate.width}×${candidate.height} ${candidate.bpp}-bit. Not saved yet.`);
        }
      } else if (hasMips(candidate)) {
        const level = REMIX_MIP_LEVELS.find(([size]) => size === mip)!;
        const palette = unpackPalette8(file.bytes.subarray(candidate.paletteOffset, candidate.paletteOffset + 0x400), order, false);
        if (applyChanges([[candidate.textureOffset + level[1], buildSingleMipImport(image, mip, palette)]], `Import ${mip}×${mip} mip from ${name}`)) {
          candidate.paletteOrder = order; onStatus(`Imported ${source} into the ${mip}×${mip} mip, keeping the shared palette. Not saved yet.`);
        }
      } else {
        const built = buildAllMipImport(image, REMIX_MIP_LEVELS.slice(0, 1), order);
        if (applyChanges([[candidate.textureOffset, built.indices.get(256)!], [candidate.paletteOffset, built.palette]], `Import texture from ${name}`)) {
          candidate.paletteOrder = order; onStatus(`Imported ${source} as a 256×256 texture with its palette. Not saved yet.`);
        }
      }
    } catch (caught) { setError(caught instanceof Error ? `Import failed: ${caught.message}` : "Import failed."); }
  };
  const importAll = async () => {
    if (!file || !candidate) return;
    if (candidate.layout === "flash") { void importLevel(); return; }
    try {
      const picked = await pickImage(); if (!picked) return;
      const levels = mipLevels(candidate);
      const built = buildAllMipImport(picked.image, levels, manual.order);
      const changes: [number, Uint8Array][] = levels.map(([size, relative]) => [candidate.textureOffset + relative, built.indices.get(size)!]);
      changes.push([candidate.paletteOffset, built.palette]);
      if (applyChanges(changes, `Import all levels from ${picked.name}`)) {
        candidate.paletteOrder = manual.order;
        onStatus(`Imported ${picked.name} into ${hasMips(candidate) ? "mips 256/128/64/32 with one shared palette" : "the 256×256 texture and its palette"}. Not saved yet.`);
      }
    } catch (caught) { setError(caught instanceof Error ? `Import failed: ${caught.message}` : "Import failed."); }
  };

  const exportCurrent = async () => {
    if (!file || !decoded.image || !spec) return;
    const target = await saveDialog({ defaultPath: await join(parentPath(file.path), `${file.name.replace(/\.[^.]+$/, "")}_tex_${spec.textureOffset.toString(16).toUpperCase().padStart(8, "0")}.png`), filters: [{ name: "PNG image", extensions: ["png"] }] });
    if (!target) return;
    try { await writeFile(target, await encodePng(decoded.image)); onStatus(`Exported ${basename(target)}`); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Could not export the PNG."); }
  };
  const exportAll = async () => {
    if (!file || !candidate) return;
    const folder = await open({ directory: true, defaultPath: parentPath(file.path) });
    if (typeof folder !== "string") return;
    const stem = file.name.replace(/\.[^.]+$/, "");
    let written = 0;
    try {
      const jobs = candidate.layout === "flash"
        ? candidates.filter((item) => item.layout === "flash").map((item) => ({ name: `${stem}_flash_${String(item.sequenceIndex).padStart(3, "0")}_${item.width}x${item.height}_${item.bpp}bit.png`, spec: { textureOffset: item.textureOffset, paletteOffset: item.paletteOffset, width: item.width, height: item.height, order: item.paletteOrder, swizzled: true, flipVertical: manual.flip, bpp: item.bpp } as DecodeSpec }))
        : mipLevels(candidate).map(([size, relative]) => ({ name: `${stem}_set_${candidate.textureOffset.toString(16).toUpperCase().padStart(8, "0")}_${size}.png`, spec: { textureOffset: candidate.textureOffset + relative, paletteOffset: candidate.paletteOffset, width: size, height: size, order: candidate.paletteOrder, swizzled: true, flipVertical: manual.flip, bpp: 8 } as DecodeSpec }));
      for (const job of jobs) {
        await writeFile(await join(folder, job.name), await encodePng({ width: job.spec.width, height: job.spec.height, data: decodeTexture(file.bytes, job.spec) }));
        written += 1;
      }
      onStatus(`Exported ${written} PNG${written === 1 ? "" : "s"} to ${basename(folder)}`);
    } catch (caught) { setError(`${caught instanceof Error ? caught.message : "Export failed."} ${written} file${written === 1 ? "" : "s"} were written before the error.`); }
  };

  const nudge = (delta: number) => setManual((current) => {
    const texture = parseOffset(current.texture); const palette = parseOffset(current.palette);
    if (texture === null || palette === null) return current;
    return { ...current, texture: hex8(Math.max(0, texture + delta)), palette: hex8(Math.max(0, current.lockPalette ? palette + delta : palette)) };
  });
  const paletteAfterTexture = () => setManual((current) => { const texture = parseOffset(current.texture); return texture === null ? current : { ...current, palette: hex8(texture + textureBytes(current.width, current.height, current.layout.startsWith("4") ? 4 : 8)) }; });
  const paletteRemix = () => setManual((current) => { const texture = parseOffset(current.texture); return texture === null ? current : { ...current, palette: hex8(texture + REMIX_PALETTE_RELATIVE) }; });
  const copyOffsets = async () => {
    const lines = candidate
      ? candidate.layout === "flash"
        ? [`FlashItem=${candidate.sequenceIndex}`, `HeaderOffset=${hex8(candidate.headerOffset ?? 0)}`, `TextureOffset=${hex8(candidate.textureOffset)}`, `PaletteOffset=${hex8(candidate.paletteOffset)}`, `Dimensions=${candidate.width}x${candidate.height}`, `Format=${candidate.bpp}bpp`]
        : [`BaseTextureOffset=${hex8(candidate.textureOffset)}`, `PaletteOffset=${hex8(candidate.paletteOffset)}`, ...mipLevels(candidate).map(([size, relative]) => `Texture${size}Offset=${hex8(candidate.textureOffset + relative)}`)]
      : [`BaseTextureOffset=${manual.texture}`, `PaletteOffset=${manual.palette}`];
    try { await navigator.clipboard.writeText(lines.join("\n")); onStatus("Texture offsets copied to the clipboard"); }
    catch { setError("The clipboard could not be written."); }
  };

  useEffect(() => {
    if (!active) return;
    const key = (event: KeyboardEvent) => {
      const pressed = event.key.toLowerCase();
      if (event.ctrlKey || event.metaKey) {
        if (pressed === "o") { event.preventDefault(); void browse(); }
        else if (pressed === "s") { event.preventDefault(); event.shiftKey ? void saveAs() : save(); }
        else if (pressed === "z" && !event.shiftKey) { event.preventDefault(); undo(); }
        else if (pressed === "y" || (pressed === "z" && event.shiftKey)) { event.preventDefault(); redo(); }
        else if (pressed === "e") { event.preventDefault(); void (event.shiftKey ? exportCurrent() : exportAll()); }
        else if (pressed === "i") { event.preventDefault(); void (event.shiftKey ? importLevel() : importAll()); }
        return;
      }
      if (event.key === "F5") { event.preventDefault(); startScan(); return; }
      if (isTyping(event.target)) return;
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); nudge((event.key === "ArrowLeft" ? -1 : 1) * (event.shiftKey ? 0x10 : 1)); return; }
      const number = ["1", "2", "3", "4"].indexOf(event.key);
      if (number >= 0 && candidate && hasMips(candidate)) { event.preventDefault(); showCandidate(candidate, REMIX_MIP_LEVELS[number][0]); }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });

  menuRef.current = {
    hasFile: !!file, dirty, canUndo: undoStack.current.length > 0, canRedo: redoStack.current.length > 0,
    open: () => void browse(), save, saveAs: () => void saveAs(), close: () => void close(), undo, redo,
  };

  if (!file) {
    return <main className="welcome tex-welcome">
      <div className="drop-card">
        <div className="file-glyph"><span>{tr("TEX")}</span></div>
        <p className="eyebrow">{tr("TEXTURES")}</p>
        <h1><Tx t="Open a PCK.{0}Find and replace its textures." v={[<br />]} /></h1>
        <p className="welcome-copy">{tr("Car PCKs are searched for non-remix textures and remix mip chains; Flash/UI PCKs (ds_, ms_, ps_, vs_) are read exactly. Replace any of them with a PNG so the mod works on real PS2 hardware, not only through the emulator's texture replacement.")}</p>
        <div className="welcome-actions"><button className="primary" onClick={() => void browse()}>{tr("Open PCK…")}</button></div>
        {recents.length > 0 && <div className="recent-folders"><div className="recent-folders-heading"><span>{tr("Recent files")}</span><button className="link-button" onClick={() => { saveRecent(RECENTS_KEY, []); setRecents([]); }}>{tr("Clear list")}</button></div><div className="recent-folders-list">{recents.map((path) => <button key={path} className="recent-folder-item" title={path} onClick={() => void openRecent(path)}>{basename(path)}</button>)}</div></div>}
        {error && <p className="tex-welcome-error">{tr(error)}</p>}
        <div className="capability-row"><span><Tx t="Finds {0}" v={[<b>{tr("Non-remix · Remix · Flash")}</b>]} /></span><span><Tx t="Imports {0}" v={[<b>{tr("PNG, PS2 alpha and swizzle")}</b>]} /></span><span><Tx t="Saves {0}" v={[<b>{tr("In place, verified")}</b>]} /></span></div>
      </div>
    </main>;
  }

  const isFlashFile = candidates.length > 0 && candidates[0].layout === "flash";
  const visible = candidates.map((item, index) => ({ item, index })).filter(({ item }) => filters[item.layout]);
  const flashCandidate = candidate?.layout === "flash";
  const levelsAvailable = candidate && !flashCandidate ? mipLevels(candidate).map(([size]) => size) : [];

  return <main className="tex-shell">
    <section className="vehicle-set-bar tex-bar">
      <div className="set-summary">
        <p className="eyebrow">{tr("TEXTURES")}</p>
        <strong title={file.path}>{file.name}{dirty ? " *" : ""}</strong>
        <span><Tx t="{0} · in {1}{2}" v={[sizeLabel(file.bytes.length), parentFolder(file.path), dirty ? tr(" · unsaved") : ""]} /></span>
      </div>
      <div className="tex-bar-actions">
        <button className="folder-button" disabled={!undoStack.current.length} onClick={undo} title={tr("Undo (Ctrl+Z)")}>{tr("Undo")}</button>
        <button className="folder-button" disabled={!redoStack.current.length} onClick={redo} title={tr("Redo (Ctrl+Y)")}>{tr("Redo")}</button>
        <span className="tex-bar-divider" />
        <button className="folder-button" onClick={() => void browse()} title={tr("Open another PCK (Ctrl+O)")}>{tr("Open…")}</button>
        <button className="folder-button" disabled={!dirty} onClick={save} title={tr("Overwrite the PCK, then read it back and compare (Ctrl+S)")}>{tr("Save")}</button>
        <button className="folder-button" onClick={() => void saveAs()} title={tr("Write to another file (Ctrl+Shift+S)")}>{tr("Save as…")}</button>
        <button className="folder-button" onClick={() => void close()} title={tr("Close this PCK")}>{tr("Close")}</button>
      </div>
    </section>

    <div className="tex-body">
      <aside className="tex-list">
        <div className="tex-scan">
          <div className="tex-scan-toggles">
            {([["nonremix", "Non-remix"], ["remix", "Remix"], ["flash", "Flash"]] as const).map(([key, label]) => <label key={key} title={tr(`Show or hide ${label} results — filters the list, no rescan`)}><input type="checkbox" checked={filters[key]} onChange={(event) => setFilters((current) => ({ ...current, [key]: event.target.checked }))} />{label}<small>{candidates.filter((item) => item.layout === key).length}</small></label>)}
          </div>
          <div className="tex-scan-row">
            <label><Tx t="Align{0}" v={[<select value={scanOptions.alignment} onChange={(event) => setScanOptions((current) => ({ ...current, alignment: Number(event.target.value) }))}>{[0x10, 0x20, 0x40, 0x80].map((value) => <option key={value} value={value}>0x{value.toString(16)}</option>)}</select>]} /></label>
            <label><Tx t="Results{0}" v={[<input type="number" min={10} max={300} value={scanOptions.maxResults} onChange={(event) => setScanOptions((current) => ({ ...current, maxResults: Math.max(10, Math.min(300, Number(event.target.value) || 50)) }))} />]} /></label>
            {scan ? <button className="folder-button" onClick={stopScan}>{tr("Stop")}</button> : <button className="folder-button tex-scan-button" onClick={() => startScan()} title={tr("Search the file again (F5)")}>{tr("Smart Scan")}</button>}
          </div>
          {scan && <div className="tex-progress"><span style={{ width: `${Math.round(scan.fraction * 100)}%` }} /><small>{scan.text}</small></div>}
        </div>
        <div className="tex-list-head"><span>{isFlashFile ? tr("Flash / UI textures") : tr("Ranked texture sets")}</span><small>{visible.length === candidates.length ? candidates.length : tr(`${visible.length} of ${candidates.length}`)}</small></div>
        <div className="tex-candidates">
          {!candidates.length && !scan && <p className="tex-list-empty">{tr("No candidates. Adjust the scan options, or point the decoder at an offset by hand.")}</p>}
          {candidates.length > 0 && !visible.length && <p className="tex-list-empty">{tr("Every result is hidden by the filters above.")}</p>}
          {visible.map(({ item, index }) => <button key={`${item.layout}-${item.textureOffset}`} className={`tex-candidate${index === selected ? " active" : ""}`} onClick={() => selectCandidate(index)} title={item.notes.join("; ")}>
            <Thumbnail data={file.bytes} candidate={item} version={thumbVersions.current.get(item) ?? 0} />
            <span className="tex-candidate-copy">
              <strong>{item.layout === "flash" ? `#${String(item.sequenceIndex).padStart(2, "0")} · ${item.width}×${item.height}` : hex8(item.textureOffset)}</strong>
              <small>{item.layout === "flash" ? tr(`${item.bpp}-bit · ${hex8(item.textureOffset)}`) : tr(`${hasMips(item) ? "256 + mips" : "256×256"} · 8-bit`)}</small>
            </span>
            <span className="tex-candidate-meta">
              <em className={`tex-layout ${item.layout}`}>{layoutName(item)}</em>
              {item.layout !== "flash" && <small>{Math.max(0, Math.min(100, item.score)).toFixed(1)}</small>}
            </span>
          </button>)}
        </div>
      </aside>

      <section className="tex-viewer">
        <div className="view-controls tex-view-controls">
          <div className="view-buttons">
            <button className={zoom === "fit" ? "active" : ""} onClick={() => setZoom("fit")}>{tr("Fit")}</button>
            <button onClick={() => setZoom(1)}>1:1</button>
            <button onClick={() => setZoomLevel(scale / 1.25)}>−</button>
            <button onClick={() => setZoomLevel(scale * 1.25)}>+</button>
            <span className="tex-zoom">{Math.round(scale * 100)}%</span>
          </div>
          <div className="view-buttons tex-mips">
            <span>{flashCandidate ? tr("Single Flash/UI texture") : tr("Level")}</span>
            {!flashCandidate && REMIX_MIP_LEVELS.map(([size], index) => <button key={size} className={candidate && mip === size ? "active" : ""} disabled={!levelsAvailable.includes(size)} onClick={() => candidate && showCandidate(candidate, size)} title={`${size}×${size} (${index + 1})`}>{size}</button>)}
          </div>
        </div>
        <div className="tex-stage" ref={stageRef} onWheel={(event) => { if (decoded.image) setZoomLevel(event.deltaY < 0 ? scale * 1.25 : scale / 1.25); }}>
          {decoded.image
            ? <canvas ref={canvasRef} className={`tex-canvas${scale >= 1 ? " pixelated" : ""}`} style={{ width: decoded.image.width * scale, height: decoded.image.height * scale }} />
            : <p className="tex-stage-empty">{decoded.error || tr("No decoded image")}</p>}
        </div>
        <div className="tex-details">
          {candidate ? <>
            <span><b>{selected !== null ? tr(`Rank ${selected + 1}`) : ""}</b>{candidate.layout !== "flash" && tr(` · score ${Math.max(0, Math.min(100, candidate.score)).toFixed(1)}`)} · {layoutName(candidate)}</span>
            <span><Tx t="alpha valid {0}/{1} · palette colours {2} · indices {3} · entropy {4}{5}{6}" v={[candidate.alphaValid, candidate.paletteColors, candidate.paletteUnique, candidate.indexUnique, candidate.entropy.toFixed(3), candidate.edgeMean !== null ? tr(` · edge ${candidate.edgeMean.toFixed(2)}`) : "", candidate.mipError !== null ? tr(` · mip error ${candidate.mipError.toFixed(2)}`) : ""]} /></span>
            {candidate.notes.length > 0 && <span className="tex-notes">{candidate.notes.join("; ")}</span>}
          </> : <span><Tx t="Manual decode · {0}" v={[spec ? tr(`${hex8(spec.textureOffset)} · palette ${hex8(spec.paletteOffset)}`) : tr("invalid offsets")]} /></span>}
        </div>
      </section>

      <aside className="tex-inspector">
        {error && <div className="tex-error"><strong>{tr("Action required")}</strong><p>{tr(error)}</p><button className="link-button" onClick={() => setError("")}>{tr("Dismiss")}</button></div>}
        <div className="tex-card">
          <header><strong>{tr("Replace")}</strong><span>{tr("PNG")}</span></header>
          <div className="tex-actions">
            <button className="primary" disabled={!candidate} onClick={() => void importLevel()} title={candidate ? undefined : tr("Select a scanned texture first")}>{flashCandidate ? tr("Import texture…") : candidate && hasMips(candidate) ? tr(`Import ${mip}×${mip} mip…`) : tr("Import texture…")}</button>
            <button className="secondary" disabled={!candidate || flashCandidate} onClick={() => void importAll()}>{flashCandidate ? tr("Single texture — no mips") : tr("Import all levels…")}</button>
            <p><Tx t="{0} Nothing is written until you save." v={[!candidate ? tr("Select a scanned texture to replace it.") : flashCandidate ? tr(`Resized to ${candidate.width}×${candidate.height} and reduced to ${candidate.bpp === 4 ? 16 : 256} colours with its own palette.`) : hasMips(candidate) ? tr("One level keeps the shared palette; all levels rebuild it from the 256 master.") : tr("Rebuilds the 256×256 texture and its palette.")]} /></p>
          </div>
        </div>
        <div className="tex-card">
          <header><strong>{tr("Export")}</strong><span>{tr("PNG")}</span></header>
          <div className="tex-actions">
            <button className="secondary" disabled={!decoded.image} onClick={() => void exportCurrent()}>{tr("Export this image…")}</button>
            <button className="secondary" disabled={!candidate} onClick={() => void exportAll()}>{flashCandidate ? tr("Export all Flash textures…") : tr("Export all levels…")}</button>
          </div>
        </div>
        <div className="tex-card">
          <header><strong>{tr("Decoder")}</strong><span>{manual.width}×{manual.height}</span></header>
          <div className="tex-fields">
            <label><Tx t="Texture offset{0}" v={[<input className="tex-input" value={manual.texture} spellCheck={false} onChange={(event) => setManual({ ...manual, texture: event.target.value })} />]} /></label>
            <label><Tx t="Palette offset{0}" v={[<input className="tex-input" value={manual.palette} spellCheck={false} onChange={(event) => setManual({ ...manual, palette: event.target.value })} />]} /></label>
            <div className="tex-pair">
              <label><Tx t="Width{0}" v={[<select className="tex-input" value={manual.width} onChange={(event) => setManual({ ...manual, width: Number(event.target.value) })}>{SIZES.map((size) => <option key={size} value={size}>{size}</option>)}</select>]} /></label>
              <label><Tx t="Height{0}" v={[<select className="tex-input" value={manual.height} onChange={(event) => setManual({ ...manual, height: Number(event.target.value) })}>{SIZES.map((size) => <option key={size} value={size}>{size}</option>)}</select>]} /></label>
            </div>
            <label><Tx t="Index layout{0}" v={[<select className="tex-input" value={manual.layout} onChange={(event) => setManual({ ...manual, layout: event.target.value as IndexLayout })}>{(Object.keys(layoutLabels) as IndexLayout[]).map((key) => <option key={key} value={key}>{tr(layoutLabels[key])}</option>)}</select>]} /></label>
            <label><Tx t="Palette order{0}" v={[<select className="tex-input" value={manual.order} onChange={(event) => setManual({ ...manual, order: event.target.value as PaletteOrder })}>{paletteOrders.map((order) => <option key={order} value={order}>{order}</option>)}</select>]} /></label>
            <div className="tex-checks">
              <label><Tx t="{0}Vertical flip" v={[<input type="checkbox" checked={manual.flip} onChange={(event) => setManual({ ...manual, flip: event.target.checked })} />]} /></label>
              <label><Tx t="{0}Move palette with texture" v={[<input type="checkbox" checked={manual.lockPalette} onChange={(event) => setManual({ ...manual, lockPalette: event.target.checked })} />]} /></label>
            </div>
          </div>
        </div>
        <div className="tex-card">
          <header><strong>{tr("Offset navigation")}</strong><span>{tr("← → · Shift ×0x10")}</span></header>
          <div className="tex-nudges">{[-0x100, -0x10, -1, 1, 0x10, 0x100].map((delta) => <button key={delta} onClick={() => nudge(delta)}>{delta < 0 ? "−" : "+"}{Math.abs(delta) === 1 ? "1" : `0x${Math.abs(delta).toString(16).toUpperCase()}`}</button>)}</div>
          <div className="tex-helpers">
            <button onClick={paletteAfterTexture}>{tr("Palette = texture + image size")}</button>
            <button onClick={paletteRemix}>{tr("Palette = texture + 0x15700")}</button>
            <button onClick={() => void copyOffsets()}>{tr("Copy offsets")}</button>
          </div>
        </div>
      </aside>
    </div>
  </main>;
}
