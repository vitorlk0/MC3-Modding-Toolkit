import { tr, Tx } from "../i18n";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { analyzeFlashMenu, patchFlashMenu, type FlashMenuAnalysis, type FlashMenuCategory, type FlashMenuRemoval } from "../../src/flash-avm1";
import { basename, parentFolder, pickFiles, readToolkitFile, sizeLabel, writeVerified, type ToolkitFile } from "./toolkit-io";
import { loadRecent, pushRecent, saveRecent } from "../recent-paths";

/**
 * Flash Menu Editor — trims the Visual Shop's physical part menus in one `vs_*.pck`.
 *
 * One file at a time, as the precedent tool works: which bumper or spoiler should disappear is a
 * judgement made per vehicle against its own item list, not something a batch pass can decide.
 *
 * Unchecking items only marks them; `src/flash-avm1.ts` rebuilds the AVM1 arrays and the file is
 * overwritten only by Save, which then re-reads it from disk so the next edit starts from what the
 * file actually holds.
 */

const vsFilters = [{ name: "MC3 Visual Shop PCK", extensions: ["pck"] }];
const RECENTS_KEY = "mc3pae.recentFlashMenuFiles";

/** "11" for a category whose freed space divides evenly, "10–15" for the large Rims arrays where
 *  entries mix 1- and 2-byte pool references and the space only narrows to a range. */
function removedAmount(removal: FlashMenuRemoval) {
  return removal.count !== null ? `${removal.count}` : removal.range ? `${removal.range[0]}–${removal.range[1]}` : "?";
}

export function FlashMenuTool({ dropped, onConsumeDrop, onStatus, isPathBlocked, onPendingChange }: {
  dropped: string[] | null;
  onConsumeDrop: () => void;
  onStatus: (message: string) => void;
  isPathBlocked: (path: string) => string | null;
  onPendingChange: (pending: boolean) => void;
}) {
  const [file, setFile] = useState<ToolkitFile | null>(null);
  const [analysis, setAnalysis] = useState<FlashMenuAnalysis | null>(null);
  const [kept, setKept] = useState<Record<string, Set<number>>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [recents, setRecents] = useState<string[]>(() => loadRecent(RECENTS_KEY));
  const lastTouched = useRef<Record<string, number>>({});

  const keepAll = (next: FlashMenuAnalysis) =>
    Object.fromEntries(next.categories.map((category) => [category.array, new Set(category.items.map((item) => item.index))]));

  const load = useCallback(async (path: string) => {
    const name = basename(path);
    if (!/^vs_.*\.pck$/i.test(name)) { setError("The Visual Shop menu file must be named vs_*.pck."); return; }
    const blocked = isPathBlocked(path);
    if (blocked) { setError(blocked); return; }
    try {
      setBusy(true);
      setError("");
      const opened = await readToolkitFile(path);
      // Parsing is immediate here — there is no worker and no round trip — so opening the file and
      // reading its menus are one step rather than the separate "analyze" the web version needed.
      const next = analyzeFlashMenu(opened.name, opened.bytes);
      setFile(opened);
      setAnalysis(next);
      setKept(keepAll(next));
      lastTouched.current = {};
      // Only a file that actually parsed is worth offering again.
      setRecents(pushRecent(RECENTS_KEY, opened.path));
      onStatus(`${opened.name} · ${next.categories.length} menu categories · ${next.totalItems} items`);
    } catch (caught) {
      setFile(null); setAnalysis(null); setKept({});
      setError(caught instanceof Error ? caught.message : "Could not read that VS PCK.");
    } finally {
      setBusy(false);
    }
  }, [isPathBlocked, onStatus]);

  useEffect(() => {
    if (!dropped) return;
    const candidate = dropped.find((path) => /^vs_.*\.pck$/i.test(basename(path)));
    onConsumeDrop();
    if (candidate) void load(candidate);
    else setError("Drop a Visual Shop menu file named vs_*.pck.");
  }, [dropped, load, onConsumeDrop]);

  const removedCount = useMemo(
    () => analysis?.categories.reduce((sum, category) => sum + category.count - (kept[category.array]?.size ?? category.count), 0) ?? 0,
    [analysis, kept],
  );
  const emptyCategories = useMemo(
    () => analysis?.categories.filter((category) => (kept[category.array]?.size ?? 0) === 0) ?? [],
    [analysis, kept],
  );
  // Entries an earlier session already took out of this file — a lower bound where a category can
  // only be narrowed to a range.
  const removedEarlier = useMemo(
    () => analysis?.categories.reduce((sum, category) => sum + (category.removal?.count ?? category.removal?.range?.[0] ?? 0), 0) ?? 0,
    [analysis],
  );

  useEffect(() => { onPendingChange(removedCount > 0); }, [removedCount, onPendingChange]);

  const toggleItem = (category: FlashMenuCategory, index: number, checked: boolean, shiftKey: boolean) => {
    const previous = lastTouched.current[category.array];
    lastTouched.current[category.array] = index;
    setKept((current) => {
      const next = new Set(current[category.array]);
      const span = shiftKey && previous != null
        ? Array.from({ length: Math.abs(index - previous) + 1 }, (_, offset) => Math.min(index, previous) + offset)
        : [index];
      for (const item of span) checked ? next.add(item) : next.delete(item);
      return { ...current, [category.array]: next };
    });
    setError("");
  };

  const updateCategory = (category: FlashMenuCategory, action: "all" | "none" | "invert") => {
    setKept((current) => {
      const active = current[category.array] ?? new Set<number>();
      const next = action === "all" ? new Set(category.items.map((item) => item.index))
        : action === "none" ? new Set<number>()
          : new Set(category.items.filter((item) => !active.has(item.index)).map((item) => item.index));
      return { ...current, [category.array]: next };
    });
    delete lastTouched.current[category.array];
    setError("");
  };

  const save = useCallback(async () => {
    if (!file || !analysis || !removedCount) return;
    if (emptyCategories.length) {
      setError(`${emptyCategories.map((category) => category.label).join(", ")} must keep at least one item.`);
      return;
    }
    try {
      setBusy(true);
      setError("");
      const keepMap = Object.fromEntries(analysis.categories.map((category) => [category.array, [...(kept[category.array] ?? [])].sort((a, b) => a - b)]));
      const { bytes, report } = patchFlashMenu(file.bytes, keepMap);
      await writeVerified(file.path, bytes);
      // Re-read rather than trusting the in-memory copy: the next edit has to start from the file
      // as it now exists on disk, with the removed entries genuinely gone from its arrays.
      const reopened = await readToolkitFile(file.path);
      const next = analyzeFlashMenu(reopened.name, reopened.bytes);
      setFile(reopened);
      setAnalysis(next);
      setKept(keepAll(next));
      lastTouched.current = {};
      onStatus(`${reopened.name} saved · ${report.itemsRemoved} item${report.itemsRemoved === 1 ? "" : "s"} removed across ${report.categoriesChanged} categor${report.categoriesChanged === 1 ? "y" : "ies"}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The edited menu could not be saved.");
    } finally {
      setBusy(false);
    }
  }, [analysis, emptyCategories, file, kept, onStatus, removedCount]);

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      const pressed = event.key.toLowerCase();
      if (pressed === "o") { event.preventDefault(); void pickFiles(vsFilters).then((paths) => paths[0] && load(paths[0])); }
      if (pressed === "s") { event.preventDefault(); void save(); }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [load, save]);

  return <>
    <section className="toolkit-hero">
      <div>
        <p className="eyebrow">{tr("AVM1 MENU ARRAYS")}</p>
        <h2>{tr("Limit the Visual Shop menu entries")}</h2>
        <p className="toolkit-hero-copy"><Tx t="Detects the physical-part arrays inside a {0} and edits Names, Status, Price and Brand together, preserving the original display order. Removed entries are rewritten inside the existing action, so the file keeps its exact size." v={[<code>vs_*.pck</code>]} /></p>
      </div>
      <div className="toolkit-facts">
        <div><span>{tr("INPUT")}</span><strong>{tr("One vs_*.pck")}</strong></div>
        <div><span>{tr("EDITED ARRAYS")}</span><strong>{tr("Names · Status · Price · Brand")}</strong></div>
        <div><span>{tr("ON SAVE")}</span><strong>{tr("Overwritten, then verified")}</strong></div>
      </div>
    </section>

    <section className="toolkit-panel">
      <div className="toolkit-panel-head">
        <div><span className="step-number">01</span><div><h3>{tr("Select the Visual Shop PCK")}</h3><p>{tr("One menu file at a time. Nothing is written until you save.")}</p></div></div>
        <span className="toolkit-required">{tr("REQUIRED")}</span>
      </div>
      <div className="toolkit-file-row">
        {/* Hovering shows the whole path: the same filename lives in more than one folder, and the
            name alone can't tell the copy you are editing from the one you meant to edit. */}
        <button className="toolkit-drop" type="button" disabled={busy} title={file?.path ?? tr("Choose a vs_*.pck")} onClick={() => void pickFiles(vsFilters).then((paths) => paths[0] && load(paths[0]))}>
          <span className="toolkit-file-type">{tr("VS")}</span>
          <span className="toolkit-drop-copy">
            <strong>{file ? file.name : tr("Choose a vs_*.pck")}</strong>
            <small>{file ? tr(`${sizeLabel(file.bytes.length)} · in ${parentFolder(file.path)} · click to replace`) : tr("Click to browse, or drag one onto the window")}</small>
          </span>
          <span className="toolkit-drop-action">{file ? tr("CHANGE") : tr("+ OPEN")}</span>
        </button>
        {recents.length > 0 && <div className="toolkit-recents">
          <div className="toolkit-recents-head">
            <span>{tr("Recent files")}</span>
            <button className="link-button" type="button" onClick={() => { saveRecent(RECENTS_KEY, []); setRecents([]); }}>{tr("Clear list")}</button>
          </div>
          <div className="toolkit-recents-list">
            {recents.map((path) => <button
              key={path}
              className={`toolkit-recent-item ${file?.path === path ? "active" : ""}`}
              type="button"
              title={path}
              disabled={busy}
              onClick={() => void load(path)}
            >
              <strong>{basename(path)}</strong>
              <small>{parentFolder(path)}</small>
            </button>)}
          </div>
        </div>}
      </div>
    </section>

    <section className="toolkit-panel">
      <div className="toolkit-panel-head">
        <div><span className="step-number">02</span><div><h3>{tr("Edit selectable items")}</h3><p>{tr("Checked items stay in the menu. Shift-click selects a range.")}</p></div></div>
        {analysis && <div className="toolkit-chips"><span><Tx t="{0} categories" v={[<strong>{analysis.categories.length}</strong>]} /></span>{removedEarlier > 0 && <span className="prior"><Tx t="{0} removed earlier" v={[<strong>{removedEarlier}</strong>]} /></span>}<span><Tx t="{0} to remove" v={[<strong>{removedCount}</strong>]} /></span></div>}
      </div>
      {!analysis ? (
        <div className="toolkit-empty"><span>{tr("AVM1")}</span><strong>{tr("No menu loaded")}</strong><p><Tx t="Open a compatible {0} to list its physical customization categories." v={[<code>vs_*.pck</code>]} /></p></div>
      ) : (
        <div className="toolkit-category-list">
          {analysis.categories.map((category, categoryIndex) => {
            const active = kept[category.array] ?? new Set<number>();
            const removed = category.count - active.size;
            return <details className="toolkit-category" key={category.array} open={categoryIndex === 0}>
              <summary>
                <span className="toolkit-category-index">{String(categoryIndex + 1).padStart(2, "0")}</span>
                <span><strong>{tr(category.label)}</strong><small>{category.array}</small></span>
                {category.removal && <span className="toolkit-category-removed-flag" title={tr("This category was shortened by an earlier edit")}><Tx t="{0} REMOVED EARLIER" v={[removedAmount(category.removal)]} /></span>}
                <span className={removed ? "toolkit-category-count changed" : "toolkit-category-count"}><Tx t="{0} / {1} KEPT" v={[active.size, category.count]} /></span>
                <i />
              </summary>
              <div className="toolkit-category-tools">
                <span><Tx t="{0} parallel array{1} patched alongside" v={[category.companions.length - 1, category.companions.length === 2 ? "" : "s"]} /></span>
                <div>
                  <button type="button" onClick={() => updateCategory(category, "all")}>{tr("SELECT ALL")}</button>
                  <button type="button" onClick={() => updateCategory(category, "none")}>{tr("DESELECT ALL")}</button>
                  <button type="button" onClick={() => updateCategory(category, "invert")}>{tr("INVERT")}</button>
                </div>
              </div>
              <div className="toolkit-item-grid">
                {category.items.map((item) => <label
                  key={`${category.array}-${item.index}`}
                  title={item.token}
                  className={active.has(item.index) ? "toolkit-item" : "toolkit-item removed"}
                  onClick={(event) => { event.preventDefault(); toggleItem(category, item.index, !active.has(item.index), event.shiftKey); }}
                >
                  <input type="checkbox" checked={active.has(item.index)} readOnly />
                  <span className="toolkit-item-index">{String(item.index).padStart(2, "0")}</span>
                  <span><strong>{item.token}</strong></span>
                </label>)}
              </div>
              {category.removal && <div className="toolkit-removed">
                <div className="toolkit-removed-head">
                  <span><Tx t="Removed by an earlier edit · {0}" v={[removedAmount(category.removal)]} /></span>
                  <small>
                    {category.removal.candidates.length === 0
                      ? tr("Their names could not be recovered from this file.")
                      : category.removal.candidates.length === category.removal.count
                        ? tr("Recovered from the file's constant pool. Where each one sat in the list is not recoverable.")
                        : tr(`${category.removal.candidates.length} candidate names — more than the space accounts for, so some may never have been in this menu.`)}
                  </small>
                </div>
                <div className="toolkit-removed-list">
                  {category.removal.candidates.map((token) => <span className="toolkit-removed-chip" key={token} title={token}>{token}</span>)}
                </div>
              </div>}
            </details>;
          })}
        </div>
      )}
    </section>

    {analysis && <section className="toolkit-actions">
      <div>
        <strong><Tx t="{0} item{1} will be removed" v={[removedCount, removedCount === 1 ? "" : "s"]} /></strong>
        <small>{emptyCategories.length
          ? tr(`${emptyCategories.map((category) => category.label).join(", ")} must keep at least one item.`)
          : removedCount ? tr(`${file?.name} is overwritten in place, then read back and compared byte for byte.`) : tr("Uncheck the entries that should disappear from the menu.")}</small>
      </div>
      <button className="toolkit-primary" type="button" disabled={busy || !removedCount || emptyCategories.length > 0} onClick={() => void save()}>
        {busy ? tr("SAVING…") : tr("SAVE EDITED PCK")}<span>→</span>
      </button>
    </section>}

    {error && <section className="toolkit-error"><span>!</span><div><strong>{tr("Action required")}</strong><p>{tr(error)}</p></div></section>}
  </>;
}
