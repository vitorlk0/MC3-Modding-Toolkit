import { tr, Tx } from "./i18n";
import { useRef, useState } from "react";
import { evaluateFieldInput } from "../src/expression";

// Enter just blurs and the blur commits, so a value is applied once. Esc flags the blur as a cancel —
// clearing the draft alone wouldn't stop it, since that blur still sees the old draft.

/** The shortest decimal that reads back as the same f32. */
export const fmt = (value: number) => { if (!Number.isFinite(value)) return String(value); for (let p = 1; p <= 9; p += 1) { const c = Number(value.toPrecision(p)); if (Math.fround(c) === value) return String(c); } return String(value); };

export function TextField({ value, maxLength, disabled, title, onCommit }: { value: string; maxLength: number; disabled?: boolean; title?: string; onCommit(value: string): string | null }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState("");
  const cancelled = useRef(false);
  const commit = () => {
    if (cancelled.current) { cancelled.current = false; setDraft(null); setError(""); return; }
    if (draft === null) return;
    if (draft === value) { setDraft(null); setError(""); return; }
    const problem = onCommit(draft);
    if (problem) { setError(problem); return; }
    setDraft(null); setError("");
  };
  return <input className={`perf-input au-text${error ? " invalid" : ""}`} value={draft ?? value} disabled={disabled} maxLength={maxLength} spellCheck={false} title={error || title}
    onFocus={() => setDraft(value)} onChange={(event) => { setDraft(event.target.value); setError(""); }} onBlur={commit}
    onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); (event.target as HTMLInputElement).blur(); } if (event.key === "Escape") { cancelled.current = true; (event.target as HTMLInputElement).blur(); } }} />;
}

export function NumberField({ value, disabled, title, onCommit }: { value: number; disabled?: boolean; title?: string; onCommit(value: number): string | null }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState("");
  const cancelled = useRef(false);
  const shown = fmt(value);
  const commit = () => {
    if (cancelled.current) { cancelled.current = false; setDraft(null); setError(""); return; }
    if (draft === null) return;
    const trimmed = draft.trim();
    if (trimmed === "" || trimmed === shown) { setDraft(null); setError(""); return; }
    const parsed = evaluateFieldInput(trimmed);
    if (parsed === null || !Number.isFinite(parsed)) { setError("Not a number or expression."); return; }
    const problem = onCommit(parsed);
    if (problem) { setError(problem); return; }
    setDraft(null); setError("");
  };
  return <input className={`perf-input${error ? " invalid" : ""}`} value={draft ?? shown} disabled={disabled} spellCheck={false} title={error || title || tr("A value or an expression — click at the end and type *1.1 or +500. Enter applies, Esc cancels.")}
    onFocus={() => setDraft(shown)} onChange={(event) => { setDraft(event.target.value); setError(""); }} onBlur={commit}
    onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); (event.target as HTMLInputElement).blur(); } if (event.key === "Escape") { cancelled.current = true; (event.target as HTMLInputElement).blur(); } }} />;
}
