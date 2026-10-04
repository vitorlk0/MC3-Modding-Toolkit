import { Fragment, useSyncExternalStore, type ReactNode } from "react";
import { confirm, message } from "@tauri-apps/plugin-dialog";
import { PT } from "./i18n-pt";

/**
 * English / Portuguese interface.
 *
 * The code is written in English and the English text IS the key: `tr("Open the ISO")` returns the
 * Portuguese entry of `./i18n-pt.ts` when Portuguese is on, and the English text itself otherwise —
 * so anything not translated yet simply stays in English instead of breaking.
 *
 * Dynamic text is translated as a whole sentence, never word by word. A key may hold numbered gaps
 * (`"Installed {0} files in {1}s"`): the English sentence that reaches `tr` at runtime is matched
 * against it, and the captured values are put into the Portuguese sentence, where they can sit in
 * any order. Captured values are themselves passed through `tr`, so a gap filled by a translatable
 * phrase ("Garage", "written in place") comes out translated too. This is also how messages from the
 * engine (`src/`, which stays English-only) get translated: at the point they are shown.
 *
 * Sentences with markup (`<code>`, `<strong>`, values) use `<Tx t="Drop {0} here" v={[…]} />`, one
 * key for the whole sentence, so the translation can reorder the pieces.
 *
 * Technical names — PCK, ASSETS.DAT, anchor, shader ID, HLOD — are kept as they are in Portuguese:
 * they are what the modding community calls them.
 *
 * The language lives in a module variable so `tr` works outside components (dialogs, callbacks);
 * the page subscribes with `useLanguage()`, and since no component is memoized, its re-render
 * reaches every text on screen.
 */

export type Language = "en" | "pt";
const STORAGE_KEY = "mc3pae.language";

function detectLanguage(): Language {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "en" || stored === "pt") return stored;
  } catch { /* storage unavailable */ }
  return (navigator.language || "").toLowerCase().startsWith("pt") ? "pt" : "en";
}

let current: Language = detectLanguage();
const listeners = new Set<() => void>();
const cache = new Map<string, string>();

export function getLanguage() { return current; }

export function setLanguage(language: Language) {
  if (language === current) return;
  current = language;
  cache.clear();
  try { localStorage.setItem(STORAGE_KEY, language); } catch { /* storage unavailable */ }
  document.documentElement.lang = language === "pt" ? "pt-BR" : "en";
  for (const listener of listeners) listener();
}

export function useLanguage() {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => listeners.delete(listener); }, getLanguage);
}

type Pattern = { regex: RegExp; target: string };
let patterns: Pattern[] | null = null;

/** Keys with {n} gaps, most specific (longest literal text) first. */
function compiledPatterns() {
  if (patterns) return patterns;
  patterns = Object.entries(PT)
    .filter(([key]) => /\{\d+\}/.test(key))
    .map(([key, target]) => {
      const literal = key.replace(/\{\d+\}/g, "").length;
      const body = key.split(/(\{\d+\})/).map((part) => /^\{\d+\}$/.test(part) ? `(?<g${part.slice(1, -1)}>[\\s\\S]*?)` : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("");
      return { regex: new RegExp(`^${body}$`), target, literal };
    })
    .sort((a, b) => b.literal - a.literal);
  return patterns;
}

export function tr(text: string): string;
export function tr(text: string | undefined): string | undefined;
export function tr(text: string | undefined): string | undefined {
  if (current === "en" || !text) return text;
  const cached = cache.get(text);
  if (cached !== undefined) return cached;
  // Leading/trailing whitespace (a captured " and 3 more") is kept around the translated core.
  const core = text.trim();
  const lead = text.slice(0, text.indexOf(core)), tail = text.slice(text.indexOf(core) + core.length);
  let out = PT[core];
  if (out === undefined) {
    for (const pattern of compiledPatterns()) {
      const match = pattern.regex.exec(core);
      if (!match) continue;
      const groups = match.groups ?? {};
      out = pattern.target.replace(/\{(\d+)\}/g, (_, n: string) => groups[`g${n}`] !== undefined ? tr(groups[`g${n}`]) : `{${n}}`);
      break;
    }
  }
  if (out !== undefined) out = lead + out + tail;
  const result = out ?? text;
  cache.set(text, result);
  return result;
}

/** A translated sentence whose {n} gaps are filled with markup or values. */
export function Tx({ t, v = [] }: { t: string; v?: ReactNode[] }) {
  const parts = tr(t).split(/\{(\d+)\}/);
  return <>{parts.map((part, index) => index % 2 === 0 ? (part ? <Fragment key={index}>{part}</Fragment> : null) : <Fragment key={index}>{v[Number(part)]}</Fragment>)}</>;
}

/** Native confirm / message dialogs with the text and title translated. */
type DialogOptions = { title?: string; kind?: "info" | "warning" | "error" };
export const confirmDialog = (text: string, options?: DialogOptions) => confirm(tr(text), options ? { ...options, title: options.title && tr(options.title) } : undefined);
export const messageDialog = (text: string, options?: DialogOptions) => message(tr(text), options ? { ...options, title: options.title && tr(options.title) } : undefined);
