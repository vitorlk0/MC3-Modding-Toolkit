import { tr, Tx } from "./i18n";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  activeCurveRows, CURVE_COLORS, CURVE_FIELDS, curveCapacity, curveEditWrites, curveKnots, curveRowValid, curvesFromClipboard, curvesToClipboard,
  deleteCurvePoint, editCurveField, evalCurveRow, insertCurvePoint, moveCurveControl, moveCurveKnot, sampleCurveRow, type AudioBlock,
} from "../src/audio";
import { fmt, NumberField } from "./audio-fields";

/**
 * The Audio Curve GUI's graph editor for one AudioBlockFull: Volume, Pitch, High Pitch, Upshift and
 * Downshift on one plot. Knots and their control handles drag; a double-click (or middle click) on a
 * curve splits the span there; a right-click on a knot, or Delete with it selected, removes it. Each
 * gesture is one undo step, and every change is refitted and written by `src/audio.ts` with the
 * script's rules — this component only turns pointer positions into curve coordinates.
 */

type Write = { offset: number; bytes: Uint8Array };
type Handle = { key: string; point: number };
type Frame = { xmin: number; xmax: number; ymin: number; ymax: number };
/** A preview being played: where its RPM is at each moment, shown as a line across the plot. */
export type Playhead = { startedAt: number; duration: number; rpmAt: ((t: number) => number) | null; minRpm: number; maxRpm: number };
type Drag = { kind: "knot" | "control"; key: string; index: number; clientX: number; clientY: number; started: boolean; base: number[][]; rows: number[][] | null; frame: Frame };

const COLUMNS = ["X0", "Y0", "CX", "CY", "X1", "Y1", "A", "B", "C"];
const COLUMN_HINTS = ["span start X", "span start Y", "control X — refits A/B/C", "control Y — refits A/B/C", "span end X", "span end Y", "A of y = A·x² + B·x + C, written as typed", "B, written as typed", "C, written as typed"];
const HEIGHT = 330;
const M = { l: 50, r: 18, t: 16, b: 46 };
const HIT = 10;

export function CurveEditor({ block, buf, saved, sourceName, onWrite, onStatus, playhead = null }: {
  block: AudioBlock;
  buf: Uint8Array;
  saved: Uint8Array;
  sourceName: string;
  onWrite(writes: Write[], label: string): void;
  onStatus(message: string): void;
  playhead?: Playhead | null;
}) {
  const [visible, setVisible] = useState<Record<string, boolean>>(() => Object.fromEntries(CURVE_FIELDS.map((f) => [f.key, true])));
  const [scale, setScale] = useState<"global" | "fit">("global");
  const [draw, setDraw] = useState<"poly" | "linear">("poly");
  const [labels, setLabels] = useState(true);
  const [showInfo, setShowInfo] = useState(false);
  const [active, setActive] = useState<Handle | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [width, setWidth] = useState(800);
  const boxRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  useEffect(() => { setActive(null); setDrag(null); }, [block.rootRel]);
  useEffect(() => {
    const box = boxRef.current; if (!box) return;
    const observer = new ResizeObserver(() => setWidth(Math.max(360, Math.floor(box.clientWidth))));
    observer.observe(box);
    return () => observer.disconnect();
  }, []);

  const labelOf = (key: string) => CURVE_FIELDS.find((f) => f.key === key)?.label ?? key;
  const rowsOf = (key: string) => drag?.rows && drag.key === key ? drag.rows : block.curves[key] ? activeCurveRows(block.curves[key]) : [];
  const shown = CURVE_FIELDS.map((f) => f.key).filter((key) => visible[key] && rowsOf(key).some(curveRowValid));
  const activeHandle = active && shown.includes(active.key) && active.point <= rowsOf(active.key).length ? active : null;
  /** Rows whose control handle belongs to the selected knot: the span on its left and on its right. */
  const handleRows = (key: string) => {
    if (!activeHandle || activeHandle.key !== key) return [];
    const count = rowsOf(key).length; const p = activeHandle.point;
    return [p - 1, p].filter((r) => r >= 0 && r < count && curveRowValid(rowsOf(key)[r]));
  };

  // The plot's extent. Global is the 0–1 frame the script compares cars in (widened if a point ever
  // falls outside it); Fit zooms to what's shown. A drag keeps the frame it started with, so the axes
  // don't slide under the pointer.
  const computeFrame = (): Frame => {
    // Global widens only for points and handles — a polynomial dipping a hair below 0 between two
    // points is clipped rather than knocking the axis off round numbers.
    const xs: number[] = []; const ys: number[] = [];
    for (const key of shown) {
      if (scale === "fit") for (const row of rowsOf(key)) for (const [x, y] of sampleCurveRow(row, 32, draw)) { xs.push(x); ys.push(y); }
      for (const [, x, y] of curveKnots(rowsOf(key))) { xs.push(x); ys.push(y); }
      for (const r of handleRows(key)) { xs.push(rowsOf(key)[r][2]); ys.push(rowsOf(key)[r][3]); }
    }
    if (scale === "global") return { xmin: Math.min(0, ...xs), xmax: Math.max(1, ...xs), ymin: Math.min(0, ...ys), ymax: Math.max(1, ...ys) };
    if (!xs.length) return { xmin: 0, xmax: 1, ymin: 0, ymax: 1 };
    let xmin = Math.min(...xs); let xmax = Math.max(...xs); let ymin = Math.min(...ys); let ymax = Math.max(...ys);
    if (xmax - xmin < 1e-9) { xmin -= 0.5; xmax += 0.5; } else { const p = (xmax - xmin) * 0.06; xmin -= p; xmax += p; }
    if (ymax - ymin < 1e-9) { ymin -= 0.5; ymax += 0.5; } else { const p = (ymax - ymin) * 0.12; ymin -= p; ymax += p; }
    return { xmin, xmax, ymin, ymax };
  };
  const frame = drag?.frame ?? computeFrame();
  const pw = width - M.l - M.r; const ph = HEIGHT - M.t - M.b;
  const sx = (x: number) => M.l + (x - frame.xmin) / (frame.xmax - frame.xmin) * pw;
  const playRef = useRef<SVGGElement>(null);
  const plotRef = useRef({ sx: (x: number) => x, top: 0, bottom: 0 });
  plotRef.current = { sx: (x: number) => M.l + (x - frame.xmin) / (frame.xmax - frame.xmin) * pw, top: M.t, bottom: M.t + ph };
  // The playing preview's RPM, mapped onto the normalized X the Volume and Pitch curves read —
  // moved every frame straight on the SVG, so playback doesn't re-render the editor.
  useEffect(() => {
    const group = playRef.current;
    if (!group || !playhead?.rpmAt || playhead.maxRpm <= playhead.minRpm) { if (group) group.style.display = "none"; return; }
    const line = group.querySelector("line")!; const label = group.querySelector("text")!;
    let frameId = 0;
    const tick = () => {
      const t = (performance.now() - playhead.startedAt) / 1000;
      if (t > playhead.duration) { group.style.display = "none"; return; }
      const rpm = playhead.rpmAt!(Math.max(0, t));
      const x = plotRef.current.sx(Math.min(Math.max((rpm - playhead.minRpm) / (playhead.maxRpm - playhead.minRpm), 0), 1));
      group.style.display = "";
      line.setAttribute("x1", String(x)); line.setAttribute("x2", String(x));
      line.setAttribute("y1", String(plotRef.current.top)); line.setAttribute("y2", String(plotRef.current.bottom));
      label.setAttribute("x", String(x + 5)); label.setAttribute("y", String(plotRef.current.bottom - 6));
      label.textContent = `${Math.round(rpm)} rpm`;
      frameId = requestAnimationFrame(tick);
    };
    frameId = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(frameId); group.style.display = "none"; };
  }, [playhead]);
  const sy = (y: number) => M.t + (1 - (y - frame.ymin) / (frame.ymax - frame.ymin)) * ph;
  const toData = (clientX: number, clientY: number, f: Frame) => {
    const rect = svgRef.current!.getBoundingClientRect();
    const x = f.xmin + (clientX - rect.left - M.l) / Math.max(1, pw) * (f.xmax - f.xmin);
    const y = f.ymin + (1 - (clientY - rect.top - M.t) / Math.max(1, ph)) * (f.ymax - f.ymin);
    // Kept inside the visible frame, as the script does, so a drag past the edge can't fling a value.
    return [Math.min(Math.max(x, f.xmin), f.xmax), Math.min(Math.max(y, f.ymin), f.ymax)] as const;
  };
  const rpmAt = (x: number) => block.maxRpmRec > block.minRpmRec ? block.minRpmRec + x * (block.maxRpmRec - block.minRpmRec) : null;

  const commit = (key: string, rows: number[][], what: string) => {
    try { onWrite(curveEditWrites(buf.length, block.curves[key], rows), `${block.label} · ${labelOf(key)} · ${what}`); return true; }
    catch (caught) { onStatus(caught instanceof Error ? caught.message : "That curve edit could not be written."); return false; }
  };

  // --- Gestures --------------------------------------------------------------------------------------
  const startDrag = (event: ReactPointerEvent, kind: Drag["kind"], key: string, index: number) => {
    if (event.button !== 0) return;
    event.stopPropagation(); event.preventDefault();
    if (kind === "knot") setActive({ key, point: index });
    else if (!activeHandle) setActive({ key, point: index + 1 });
    try { svgRef.current?.setPointerCapture(event.pointerId); } catch { /* the pointer is already gone */ }
    svgRef.current?.focus();
    setDrag({ kind, key, index, clientX: event.clientX, clientY: event.clientY, started: false, base: rowsOf(key), rows: null, frame });
  };
  const moveDrag = (event: ReactPointerEvent) => {
    if (!drag) return;
    if (!drag.started && Math.hypot(event.clientX - drag.clientX, event.clientY - drag.clientY) < 3) return;
    const [x, y] = toData(event.clientX, event.clientY, drag.frame);
    setDrag({ ...drag, started: true, rows: drag.kind === "knot" ? moveCurveKnot(drag.base, drag.index, x, y) : moveCurveControl(drag.base, drag.index, x, y) });
  };
  const endDrag = () => {
    if (!drag) return;
    if (drag.started && drag.rows) commit(drag.key, drag.rows, drag.kind === "knot" ? `move point ${drag.index}` : `move handle c${drag.index}`);
    setDrag(null);
  };
  /** The visible span nearest a client position, within a few pixels, and the point on it there. */
  const spanNear = (clientX: number, clientY: number) => {
    const rect = svgRef.current!.getBoundingClientRect();
    const px = clientX - rect.left; const py = clientY - rect.top;
    let best = null as { key: string; row: number; x: number; y: number; d: number } | null;
    for (const key of shown) rowsOf(key).forEach((row, r) => {
      const pts = sampleCurveRow(row, 48, draw);
      for (let i = 0; i + 1 < pts.length; i += 1) {
        const ax = sx(pts[i][0]); const ay = sy(pts[i][1]); const bx = sx(pts[i + 1][0]); const by = sy(pts[i + 1][1]);
        const vx = bx - ax; const vy = by - ay; const len = vx * vx + vy * vy;
        const t = len <= 1e-12 ? 0 : Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / len));
        const d = Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
        if (d < 14 && (!best || d < best.d)) {
          const x = pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t;
          // On the curve itself, not at the pointer's height.
          best = { key, row: r, x, y: draw === "linear" ? pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t : evalCurveRow(row, x), d };
        }
      }
    });
    return best;
  };
  const insertAt = (clientX: number, clientY: number) => {
    const span = spanNear(clientX, clientY);
    if (!span) { onStatus("Double-click on a curve to add a point there."); return; }
    try {
      const rows = insertCurvePoint(rowsOf(span.key), curveCapacity(buf.length, block.curves[span.key]), span.row, span.x, span.y);
      if (commit(span.key, rows, `add point ${span.row + 1}`)) setActive({ key: span.key, point: span.row + 1 });
    } catch (caught) { onStatus(caught instanceof Error ? caught.message : "Could not add a point there."); }
  };
  const removePoint = (handle: Handle) => {
    const rows = rowsOf(handle.key);
    try {
      const next = deleteCurvePoint(rows, handle.point);
      if (commit(handle.key, next, `remove point ${handle.point}`)) setActive({ key: handle.key, point: Math.min(handle.point >= rows.length ? next.length : handle.point, next.length) });
    } catch (caught) { onStatus(caught instanceof Error ? caught.message : "Could not remove that point."); }
  };

  const copyCurves = async () => {
    try { await navigator.clipboard.writeText(curvesToClipboard(block, shown, sourceName)); onStatus(`Copied ${shown.length} curve${shown.length === 1 ? "" : "s"} from ${block.label}`); }
    catch { onStatus("The clipboard could not be written."); }
  };
  const pasteCurves = async () => {
    try {
      const { paste, skipped } = curvesFromClipboard(await navigator.clipboard.readText(), block, CURVE_FIELDS.map((f) => f.key).filter((key) => visible[key]), buf.length);
      const writes = paste.flatMap((item) => curveEditWrites(buf.length, block.curves[item.key], item.rows));
      if (paste.length) onWrite(writes, `${block.label} · paste ${paste.map((item) => labelOf(item.key)).join(", ")}`);
      onStatus(`Pasted ${paste.length} curve${paste.length === 1 ? "" : "s"} into ${block.label}${skipped.length ? ` · skipped ${skipped.join("; ")}` : ""}`);
    } catch (caught) { onStatus(caught instanceof Error ? caught.message : "Could not paste curves."); }
  };

  // --- Drawing ---------------------------------------------------------------------------------------
  const xTicks = Array.from({ length: 6 }, (_, i) => frame.xmin + (i / 5) * (frame.xmax - frame.xmin));
  const yTicks = Array.from({ length: 5 }, (_, i) => frame.ymax - (i / 4) * (frame.ymax - frame.ymin));
  const readout = (() => {
    const handle = drag?.started ? drag : null;
    if (handle?.rows) {
      const r = handle.rows; const [x, y] = handle.kind === "knot" ? (handle.index === 0 ? [r[0][0], r[0][1]] : [r[handle.index - 1][4], r[handle.index - 1][5]]) : [r[handle.index][2], r[handle.index][3]];
      return { x, y, label: `${labelOf(handle.key)} ${handle.kind === "knot" ? `point ${handle.index}` : `handle c${handle.index}`}` };
    }
    if (!activeHandle) return null;
    const knot = curveKnots(rowsOf(activeHandle.key)).find(([i]) => i === activeHandle.point);
    return knot ? { x: knot[1], y: knot[2], label: `${labelOf(activeHandle.key)} point ${activeHandle.point}` } : null;
  })();
  const rowChanged = (key: string, r: number) => {
    const off = block.curves[key]?.pointsFileOff; if (off == null) return false;
    for (let i = off + r * 36; i < off + r * 36 + 36; i += 1) if (buf[i] !== saved[i]) return true;
    return false;
  };

  return <div className="au-curve-editor">
    <div className="au-curve-bar">
      <div className="au-curve-toggles">{CURVE_FIELDS.map((f) => {
        const c = block.curves[f.key]; const count = c ? c.pointCount : 0;
        return <button key={f.key} className={visible[f.key] ? "active" : ""} onClick={() => setVisible((current) => ({ ...current, [f.key]: !current[f.key] }))} title={count ? tr(`${count} of ${c ? curveCapacity(buf.length, c) : 0} rows used`) : tr("Not used by this block")}>
          <i style={{ background: CURVE_COLORS[f.key] }} />{tr(f.label)}<small>{count}</small>
        </button>;
      })}</div>
      <div className="au-seg"><button className={scale === "global" ? "active" : ""} onClick={() => setScale("global")}>{tr("Global 0–1")}</button><button className={scale === "fit" ? "active" : ""} onClick={() => setScale("fit")}>{tr("Fit")}</button></div>
      <div className="au-seg"><button className={draw === "poly" ? "active" : ""} onClick={() => setDraw("poly")} title={tr("Draw y = A·x² + B·x + C — what the game evaluates")}>{tr("Polynomial")}</button><button className={draw === "linear" ? "active" : ""} onClick={() => setDraw("linear")} title={tr("Straight lines between the points")}>{tr("Linear")}</button></div>
      <label className="au-check"><Tx t="{0}Labels" v={[<input type="checkbox" checked={labels} onChange={(event) => setLabels(event.target.checked)} />]} /></label>
      <span className="au-curve-spacer" />
      <button className="au-mini" disabled={!shown.length} onClick={() => void copyCurves()} title={tr("Copy the shown curves as JSON — the Audio Curve GUI's format, so it pastes there too")}>{tr("Copy curves")}</button>
      <button className="au-mini" onClick={() => void pasteCurves()} title={tr("Paste curves from the clipboard into the shown curves of this block")}>{tr("Paste")}</button>
    </div>

    <div className="au-plot" ref={boxRef}>
      <svg ref={svgRef} width={width} height={HEIGHT} tabIndex={0} className={drag?.started ? "dragging" : ""}
        onPointerDown={(event) => { if (event.button === 1) { event.preventDefault(); insertAt(event.clientX, event.clientY); } else if (event.button === 0) setActive(null); }}
        onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={() => setDrag(null)}
        onDoubleClick={(event) => insertAt(event.clientX, event.clientY)}
        onContextMenu={(event) => event.preventDefault()}
        onKeyDown={(event) => { if ((event.key === "Delete" || event.key === "Backspace") && activeHandle) { event.preventDefault(); removePoint(activeHandle); } if (event.key === "Escape") setActive(null); }}>
        <rect x={M.l} y={M.t} width={pw} height={ph} className="au-plot-bg" />
        {xTicks.map((x, i) => <g key={`x${i}`}>
          <line x1={sx(x)} x2={sx(x)} y1={M.t} y2={M.t + ph} className="au-grid" />
          <text x={sx(x)} y={M.t + ph + 15} className="au-tick" textAnchor="middle">{Number(x.toPrecision(3))}</text>
          {scale === "global" && rpmAt(x) !== null && <text x={sx(x)} y={M.t + ph + 28} className="au-tick rpm" textAnchor="middle"><Tx t="{0} rpm" v={[Math.round(rpmAt(x)!)]} /></text>}
        </g>)}
        {yTicks.map((y, i) => <g key={`y${i}`}>
          <line x1={M.l} x2={M.l + pw} y1={sy(y)} y2={sy(y)} className="au-grid" />
          <text x={M.l - 7} y={sy(y) + 3} className="au-tick" textAnchor="end">{Number(y.toPrecision(3))}</text>
        </g>)}
        <rect x={M.l} y={M.t} width={pw} height={ph} className="au-plot-frame" />
        <clipPath id="au-plot-clip"><rect x={M.l - 8} y={M.t - 8} width={pw + 16} height={ph + 16} /></clipPath>
        <g clipPath="url(#au-plot-clip)">
          {shown.map((key) => <path key={key} className="au-curve-line" stroke={CURVE_COLORS[key]}
            d={rowsOf(key).map((row) => sampleCurveRow(row, 32, draw).map(([x, y], i) => `${i ? "L" : "M"}${sx(x).toFixed(1)},${sy(y).toFixed(1)}`).join("")).join("")} />)}
          {shown.map((key) => {
            const rows = rowsOf(key); const knots = curveKnots(rows); const color = CURVE_COLORS[key];
            const knot = activeHandle?.key === key ? knots.find(([i]) => i === activeHandle.point) : undefined;
            return <g key={`${key}-points`}>
              {knot && handleRows(key).map((r) => <g key={`c${r}`}>
                <line x1={sx(knot[1])} y1={sy(knot[2])} x2={sx(rows[r][2])} y2={sy(rows[r][3])} stroke={color} className="au-handle-line" />
                <rect x={sx(rows[r][2]) - 4.5} y={sy(rows[r][3]) - 4.5} width={9} height={9} className="au-handle" />
                {labels && <text x={sx(rows[r][2]) + 8} y={sy(rows[r][3]) + 11} className="au-point-label">c{r}</text>}
                <circle cx={sx(rows[r][2])} cy={sy(rows[r][3])} r={HIT} className="au-hit" onPointerDown={(event) => startDrag(event, "control", key, r)} />
              </g>)}
              {knots.map(([i, x, y]) => {
                const on = activeHandle?.key === key && activeHandle.point === i;
                return <g key={i}>
                  <circle cx={sx(x)} cy={sy(y)} r={on ? 5.5 : 4} fill={on ? "#fff" : color} stroke={on ? color : "none"} strokeWidth={2} />
                  {labels && <text x={sx(x) + 7} y={sy(y) - 7} fill={on ? "#fff" : color} className="au-point-label">{i}</text>}
                  <circle cx={sx(x)} cy={sy(y)} r={HIT} className="au-hit"
                    onPointerDown={(event) => startDrag(event, "knot", key, i)}
                    onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); removePoint({ key, point: i }); }} />
                </g>;
              })}
            </g>;
          })}
        </g>
        {!shown.length && <text x={M.l + pw / 2} y={M.t + ph / 2} className="au-plot-empty" textAnchor="middle">{tr("No shown curve has points in this block.")}</text>}
        {readout && <text x={M.l + pw - 6} y={M.t + 14} className="au-readout" textAnchor="end">{tr(readout.label)} · x {fmt(Math.fround(readout.x))} · y {fmt(Math.fround(readout.y))}{rpmAt(readout.x) !== null ? tr(` · ≈ ${Math.round(rpmAt(readout.x)!)} rpm`) : ""}</text>}
        <g ref={playRef} className="au-playhead" style={{ display: "none" }}><line /><text /></g>
        <text x={M.l} y={HEIGHT - 4} className="au-axis-note">{tr("X · normalized RPM (shift curves: event time) · Y · curve output")}</text>
      </svg>
    </div>
    <p className="au-curve-hint">{tr("Drag a point or its handles · double-click a curve to add a point · right-click a point, or select it and press Delete, to remove it · each curve holds up to 8 spans.")}</p>

    <button className={`au-toggle${showInfo ? " open" : ""}`} onClick={() => setShowInfo((v) => !v)} aria-expanded={showInfo}>
      <Tx t="{0}Info{1}" v={[<span className="au-toggle-caret">▸</span>, <small><Tx t="{0} spans · points, control handles and A/B/C of each curve{1}" v={[shown.reduce((n, key) => n + rowsOf(key).length, 0), shown.reduce((n, key) => n + rowsOf(key).filter((_, r) => rowChanged(key, r)).length, 0) ? tr(` · ${shown.reduce((n, key) => n + rowsOf(key).filter((_, r) => rowChanged(key, r)).length, 0)} changed`) : ""]} /></small>]} />
    </button>
    {showInfo && <>
      <div className="au-table au-curve-rows">
        <div className="au-row head"><span>{tr("CURVE")}</span><span>#</span>{COLUMNS.map((c, i) => <span key={c} title={COLUMN_HINTS[i]}>{c}</span>)}</div>
        {shown.map((key) => rowsOf(key).map((row, r) => {
          const near = activeHandle?.key === key && (activeHandle.point === r || activeHandle.point === r + 1);
          return <div key={`${key}-${r}`} className={`au-row${near ? " near" : ""}${rowChanged(key, r) ? " changed" : ""}`}>
            <span><i style={{ background: CURVE_COLORS[key] }} />{labelOf(key)}</span><span>{r}</span>
            {row.slice(0, 9).map((value, field) => <NumberField key={field} value={Math.fround(value)} title={COLUMN_HINTS[field]}
              onCommit={(next) => { try { return commit(key, editCurveField(rowsOf(key), r, field, next), `row ${r} ${COLUMNS[field]}`) ? null : "Not written."; } catch (caught) { return caught instanceof Error ? caught.message : "Invalid."; } }} />)}
          </div>;
        }))}
      </div>
    </>}
  </div>;
}
