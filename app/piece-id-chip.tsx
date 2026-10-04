import { tr, Tx } from "./i18n";
import { useEffect, useState } from "react";
import { hex } from "../src/pck";

function parseHexDigits(value: string, maxDigits: number) {
  const cleaned = value.trim().replace(/^0x/i, "");
  const pattern = new RegExp(`^[0-9a-f]{1,${maxDigits}}$`, "i");
  if (!pattern.test(cleaned)) return null;
  return parseInt(cleaned, 16);
}

/**
 * Generic hex-value chip used for both the piece-ID editor and the shader-ID editor: a small
 * readonly/clickable badge that turns into an inline hex input on click. `digits` bounds both the
 * display padding and the max hex length accepted while typing (piece ID is a byte, shader ID a
 * full u16 — see the Mesh Editor piece/shader ID project memory for why the ranges differ).
 */
export function HexIdChip({ value, editable, digits = 2, className = "", title, onCommit }: { value: number; editable: boolean; digits?: number; className?: string; title?: string; onCommit(newValue: number): void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(hex(value, digits));
  useEffect(() => setDraft(hex(value, digits)), [value, digits]);

  const label = hex(value, digits).replace(/^0x/i, "");
  const chipClass = `piece-id-chip ${className}`.trim();
  if (!editable) return <span className={chipClass} title={title ?? tr("Can't edit safely — see the inconsistency note")}>{label}</span>;

  if (!editing) {
    return <button type="button" className={`${chipClass} editable`} onClick={(event) => { event.stopPropagation(); setDraft(hex(value, digits)); setEditing(true); }} title={title}>{label}</button>;
  }

  const commit = () => {
    const parsed = parseHexDigits(draft, digits);
    if (parsed !== null && parsed !== value) onCommit(parsed);
    setEditing(false);
  };

  return <input
    className="piece-id-chip-input"
    type="text" autoFocus
    value={draft}
    onClick={(event) => event.stopPropagation()}
    onChange={(event) => setDraft(event.target.value)}
    onBlur={commit}
    onKeyDown={(event) => {
      if (event.key === "Enter") commit();
      else if (event.key === "Escape") { setDraft(hex(value, digits)); setEditing(false); }
    }}
  />;
}

export function PieceIdChip({ meshId, editable, onCommit }: { meshId: number; editable: boolean; onCommit(newId: number): void }) {
  return <HexIdChip value={meshId} editable={editable} digits={2} title={editable ? tr("Click to edit this piece's ID (00–FF)") : tr("Not found in a single, unambiguous HLOD/MLOD/LLOD entry — can't edit safely")} onCommit={onCommit} />;
}

export function ShaderIdChip({ shaderId, editable, dirty = false, onCommit }: { shaderId: number; editable: boolean; dirty?: boolean; onCommit(newId: number): void }) {
  const dirtyNote = dirty ? " · pending save (in memory, not written to disk yet)" : "";
  return <HexIdChip value={shaderId} editable={editable} digits={2} className={`shader-id-chip${dirty ? " dirty" : ""}`} title={(editable ? "Click to edit this group's shader ID" : "Embedded copies disagree on this shader ID — can't edit safely") + dirtyNote} onCommit={onCommit} />;
}
