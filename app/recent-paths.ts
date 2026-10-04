/**
 * Most-recently-used path lists, kept in localStorage under a caller-supplied key.
 *
 * Shared by the vehicle-folder and PPF-folder lists in the Anchor Editor and by the Mod Toolkit's
 * per-tool file lists, so all of them dedupe, order and cap the same way. Paths are stored whole:
 * two files can have the same name in different folders, and only the full path tells them apart.
 */

export const RECENT_LIMIT = 8;

export function loadRecent(key: string): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch { return []; }
}

export function saveRecent(key: string, list: string[]) {
  try { localStorage.setItem(key, JSON.stringify(list)); } catch { /* storage unavailable */ }
}

export function pushRecent(key: string, path: string) {
  const next = [path, ...loadRecent(key).filter((item) => item.toLowerCase() !== path.toLowerCase())].slice(0, RECENT_LIMIT);
  saveRecent(key, next);
  return next;
}
