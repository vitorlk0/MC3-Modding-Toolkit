import { tr, Tx } from "../i18n";
import { useCallback, useEffect, useMemo, useState } from "react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import { analyzeFlashMenu, type FlashMenuAnalysis } from "../../src/flash-avm1";
import { PckDocument } from "../../src/pck";
import { buildPartsOrder, formatPartsOrderText, pieceIdHex } from "../../src/parts-order";
import { basename, parentFolder, parentPath, pickFiles, readToolkitFile, type ToolkitFile } from "./toolkit-io";
import { loadRecent, pushRecent, saveRecent } from "../recent-paths";
import { RecentList } from "./toolkit-ui";

/**
 * Flash Parts Mapper — lists a car's Visual Shop parts in menu order, with the piece ID and full
 * mesh name each entry stands for, and exports that as the piece-order TXT the modding workflow
 * uses.
 *
 * Purely a reader: the `vs_*.pck` and the `_g.pck` are opened and never written. The only file
 * this tool creates is the TXT, at a path the user picks.
 */

const vsFilters = [{ name: "MC3 Visual Shop PCK", extensions: ["pck"] }];
const garageFilters = [{ name: "MC3 garage car PCK", extensions: ["pck"] }];
const VS_RECENTS_KEY = "mc3pae.recentPartsMapperVs";
const GARAGE_RECENTS_KEY = "mc3pae.recentPartsMapperGarage";

const isVsName = (path: string) => /^vs_.*\.pck$/i.test(basename(path));
/** `vs_vp_skyline_02.pck` and `vp_skyline_02_g.pck` both reduce to `vp_skyline_02`. */
const carKey = (path: string) => basename(path).toLowerCase().replace(/\.pck$/, "").replace(/^vs_/, "").replace(/_[go]$/, "");

type Loaded<T> = { file: ToolkitFile; value: T };

export function PartsMapperTool({ dropped, onConsumeDrop, onStatus, isPathBlocked }: {
  dropped: string[] | null;
  onConsumeDrop: () => void;
  onStatus: (message: string) => void;
  isPathBlocked: (path: string) => string | null;
}) {
  const [menu, setMenu] = useState<Loaded<FlashMenuAnalysis> | null>(null);
  const [garage, setGarage] = useState<Loaded<PckDocument> | null>(null);
  const [vsRecents, setVsRecents] = useState<string[]>(() => loadRecent(VS_RECENTS_KEY));
  const [garageRecents, setGarageRecents] = useState<string[]>(() => loadRecent(GARAGE_RECENTS_KEY));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const loadMenu = useCallback(async (path: string) => {
    if (!isVsName(path)) { setError("The Visual Shop menu file must be named vs_*.pck."); return; }
    const blocked = isPathBlocked(path);
    if (blocked) { setError(blocked); return; }
    try {
      setBusy(true); setError("");
      const file = await readToolkitFile(path);
      const value = analyzeFlashMenu(file.name, file.bytes);
      setMenu({ file, value });
      setVsRecents(pushRecent(VS_RECENTS_KEY, file.path));
      onStatus(`${file.name} · ${value.categories.length} menu categories`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not read that VS PCK.");
    } finally { setBusy(false); }
  }, [isPathBlocked, onStatus]);

  const loadGarage = useCallback(async (path: string) => {
    const blocked = isPathBlocked(path);
    if (blocked) { setError(blocked); return; }
    try {
      setBusy(true); setError("");
      const file = await readToolkitFile(path);
      // A throwaway document: read here, never saved, and never shared with the vehicle set.
      const value = new PckDocument(file.name, file.bytes.buffer.slice(file.bytes.byteOffset, file.bytes.byteOffset + file.bytes.byteLength) as ArrayBuffer);
      if (!value.lodMeshes.some((entry) => entry.lod === "hlod")) { setError(`${file.name} has no HLOD mesh table, so there are no piece names to map to.`); return; }
      setGarage({ file, value });
      setGarageRecents(pushRecent(GARAGE_RECENTS_KEY, file.path));
      onStatus(`${file.name} loaded`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not read that car PCK.");
    } finally { setBusy(false); }
  }, [isPathBlocked, onStatus]);

  useEffect(() => {
    if (!dropped) return;
    const paths = dropped.filter((path) => path.toLowerCase().endsWith(".pck"));
    onConsumeDrop();
    if (!paths.length) { setError("Drop a vs_*.pck menu file and/or the car's _g.pck."); return; }
    const vs = paths.find(isVsName);
    const car = paths.find((path) => !isVsName(path));
    if (vs) void loadMenu(vs);
    if (car) void loadGarage(car);
  }, [dropped, loadMenu, loadGarage, onConsumeDrop]);

  const built = useMemo(() => {
    if (!menu || !garage) return { order: null, failure: "" };
    try { return { order: buildPartsOrder(menu.value, garage.value), failure: "" }; }
    catch (caught) { return { order: null, failure: caught instanceof Error ? caught.message : "The piece order could not be built." }; }
  }, [menu, garage]);
  const order = built.order;
  const shownError = error || built.failure;

  const mismatch = menu && garage && carKey(menu.file.path) !== carKey(garage.file.path);
  const missing = order ? order.categories.reduce((sum, category) => sum + category.rows.filter((row) => !row.mesh && !row.emptySlot).length, 0) : 0;

  const exportText = useCallback(async () => {
    if (!order || !garage) return;
    const target = await saveDialog({
      defaultPath: `${parentPath(garage.file.path)}\\piece_order_${carKey(garage.file.path)}.txt`,
      filters: [{ name: "Text file", extensions: ["txt"] }],
    });
    if (!target) return;
    if (!/\.txt$/i.test(target)) { setError("The piece order is saved as a .txt file."); return; }
    try {
      setBusy(true); setError("");
      await writeFile(target, new TextEncoder().encode(formatPartsOrderText(order)));
      onStatus(`Piece order saved · ${basename(target)}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The TXT could not be saved.");
    } finally { setBusy(false); }
  }, [order, garage, onStatus]);

  /** Copies `4C - name.mesh`, the exact form the Blender object names and the OBJ script expect. */
  const [copied, setCopied] = useState("");
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(""), 1200);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const copyLabel = useCallback(async (key: string, label: string) => {
    try { await navigator.clipboard.writeText(label); setCopied(key); onStatus(`Copied ${label}`); }
    catch { onStatus("Clipboard access was blocked."); }
  }, [onStatus]);

  return <>
    <section className="toolkit-hero">
      <div>
        <p className="eyebrow">{tr("VISUAL SHOP PIECE ORDER")}</p>
        <h2>{tr("See which piece each shop entry shows")}</h2>
        <p className="toolkit-hero-copy"><Tx t="A car's garage PCK lists its parts in a different order from the Visual Shop menu — the second bumper in the shop can be the eleventh in the PCK. This reads both and lists every category in {0}, with the piece ID and full mesh name behind each entry, then exports it as a TXT. Both files are only read." v={[<strong>{tr("menu order")}</strong>]} /></p>
      </div>
      <div className="toolkit-facts">
        <div><span>{tr("INPUT")}</span><strong>{tr("vs_*.pck + _g.pck")}</strong></div>
        <div><span>{tr("OUTPUT")}</span><strong>{tr("piece_order_*.txt")}</strong></div>
        <div><span>{tr("EDITS")}</span><strong>{tr("None — read only")}</strong></div>
      </div>
    </section>

    <section className="toolkit-panel">
      <div className="toolkit-panel-head">
        <div><span className="step-number">01</span><div><h3>{tr("Open the Visual Shop menu")}</h3><p><Tx t="The car's {0} sets the order." v={[<code>vs_*.pck</code>]} /></p></div></div>
        <span className="toolkit-required">{tr("REQUIRED")}</span>
      </div>
      <div className="toolkit-file-row">
        <button className="toolkit-drop" type="button" disabled={busy} onClick={() => void pickFiles(vsFilters, false, menu ? parentPath(menu.file.path) : undefined).then((paths) => { if (paths.length) void loadMenu(paths[0]); })}>
          <span className="toolkit-file-type">{tr("VS")}</span>
          <span className="toolkit-drop-copy">
            <strong>{menu ? menu.file.name : tr("Choose a vs_*.pck")}</strong>
            <small>{menu ? tr(`${menu.value.categories.length} menu categories · ${parentFolder(menu.file.path)}`) : tr("Click to browse, or drop it on the window")}</small>
          </span>
          <span className="toolkit-drop-action">{menu ? tr("CHANGE") : tr("+ OPEN")}</span>
        </button>
        <RecentList title={tr("Recent menus")} paths={vsRecents} activePath={menu?.file.path} busy={busy} onPick={(path) => void loadMenu(path)} onClear={() => { saveRecent(VS_RECENTS_KEY, []); setVsRecents([]); }} />
      </div>
    </section>

    <section className="toolkit-panel">
      <div className="toolkit-panel-head">
        <div><span className="step-number">02</span><div><h3>{tr("Open the car's garage PCK")}</h3><p>{tr("Where the piece IDs and full mesh names come from.")}</p></div></div>
        <span className="toolkit-required">{tr("REQUIRED")}</span>
      </div>
      <div className="toolkit-file-row">
        <button className="toolkit-drop" type="button" disabled={busy} onClick={() => void pickFiles(garageFilters, false, garage ? parentPath(garage.file.path) : undefined).then((paths) => { if (paths.length) void loadGarage(paths[0]); })}>
          <span className="toolkit-file-type">{tr("PCK")}</span>
          <span className="toolkit-drop-copy">
            <strong>{garage ? garage.file.name : tr("Choose the car's _g.pck")}</strong>
            <small>{garage ? parentFolder(garage.file.path) : tr("Click to browse, or drop it on the window")}</small>
          </span>
          <span className="toolkit-drop-action">{garage ? tr("CHANGE") : tr("+ OPEN")}</span>
        </button>
        <RecentList title={tr("Recent garage PCKs")} paths={garageRecents} activePath={garage?.file.path} busy={busy} onPick={(path) => void loadGarage(path)} onClear={() => { saveRecent(GARAGE_RECENTS_KEY, []); setGarageRecents([]); }} />
        {mismatch && <p className="carcfg-warning"><Tx t="These look like different cars: {0} and {1}. Entries will only match where the two share part names." v={[<code>{menu!.file.name}</code>, <code>{garage!.file.name}</code>]} /></p>}
      </div>
    </section>

    <section className="toolkit-panel">
      <div className="toolkit-panel-head">
        <div><span className="step-number">03</span><div><h3>{tr("Piece order")}</h3><p>{tr("Each category as the Visual Shop lists it.")}</p></div></div>
        {order && <div className="toolkit-chips">
          <span><Tx t="{0} categories" v={[<strong>{order.categories.length}</strong>]} /></span>
          <span className={missing ? "prior" : ""}><Tx t="{0} not found" v={[<strong>{missing}</strong>]} /></span>
        </div>}
      </div>
      {!order ? (
        <div className="toolkit-empty"><span>{tr("VS")}</span><strong>{menu || garage ? tr("Open the other file too") : tr("Nothing loaded yet")}</strong><p>{tr("The order appears once both the menu and the garage PCK are open.")}</p></div>
      ) : <>
        {order.unmatched.length > 0 && <p className="carcfg-note">
          <Tx t="Not listed: {0} — no piece in the car PCK carries these names. Rims, tires and exhaust tips live in the shared PPF files, not in the car." v={[order.unmatched.map((item) => `${item.title} (${item.count})`).join(", ")]} /></p>}
        <div className="carcfg-results">
          {order.categories.map((category, index) => {
            const notFound = category.rows.filter((row) => !row.mesh && !row.emptySlot).length;
            return <details className="toolkit-category" key={category.array} open={index === 0}>
              <summary>
                <span className="toolkit-category-index">{String(index + 1).padStart(2, "0")}</span>
                <span><strong>{tr(category.title)}</strong><small>{category.array}</small></span>
                {notFound > 0 && <span className="toolkit-category-removed-flag"><Tx t="{0} NOT FOUND" v={[notFound]} /></span>}
                <span className="toolkit-category-count"><Tx t="{0} ENTRIES" v={[category.rows.length]} /></span>
                <i />
              </summary>
              <div className="parts-order-table">
                <div className="parts-order-row head"><span>{tr("MENU")}</span><span>{tr("ENTRY")}</span><span>{tr("ID - MESH")}</span></div>
                {category.rows.map((row) => {
                  const label = row.mesh ? `${pieceIdHex(row.mesh.pieceId)} - ${row.mesh.name}` : "";
                  const copyKey = `${category.array}:${row.position}`;
                  return <div className={row.mesh ? "parts-order-row" : "parts-order-row missing"} key={row.position}>
                    <span>{row.position}</span>
                    <span>{row.token}</span>
                    {row.mesh
                      ? <button type="button" className="parts-order-copy" title={tr("Click to copy for Blender")} onClick={() => void copyLabel(copyKey, label)}>
                          <b>{pieceIdHex(row.mesh.pieceId)}</b> - {row.mesh.name}
                          {copied === copyKey && <em>{tr("Copied")}</em>}
                        </button>
                      : <span><b>{row.emptySlot ? "--" : "??"}</b> - {row.emptySlot ? tr("No mesh — an empty slot on this car") : tr("Not found in this PCK")}</span>}
                  </div>;
                })}
              </div>
            </details>;
          })}
        </div>
      </>}
    </section>

    {order && <section className="toolkit-actions">
      <div>
        <strong>{tr("Export the piece order")}</strong>
        <small>{tr("Same layout as the original script's TXT. Written only where you choose — the two PCKs are never touched.")}</small>
      </div>
      <div className="carcfg-actions">
        <button className="toolkit-primary" type="button" disabled={busy} onClick={() => void exportText()}><Tx t="EXPORT TXT{0}" v={[<span>→</span>]} /></button>
      </div>
    </section>}

    {shownError && <section className="toolkit-error"><span>!</span><div><strong>{tr("Action required")}</strong><p>{tr(shownError)}</p></div></section>}
  </>;
}
