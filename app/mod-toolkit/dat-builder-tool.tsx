import { tr, Tx } from "../i18n";
import { useCallback, useEffect, useState } from "react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { join } from "@tauri-apps/api/path";
import { buildVehicleDat, findVehicleFolders, type VehicleFolder } from "../../src/dave-build";
import { entriesByName, readDave, readEntry } from "../../src/dave";
import { memoryReader } from "../../src/iso9660";
import { readPackageFiles } from "../iso-io";
import type { PackageFile } from "../../src/iso-install";
import { basename, parentPath, sizeLabel, writeVerified } from "./toolkit-io";
import { loadRecent, pushRecent, saveRecent } from "../recent-paths";
import { RecentList } from "./toolkit-ui";

/**
 * Vehicle DAT Builder — compiles a car's loose folder (HostFS layout) into its `vp_*.dat`.
 *
 * The folder can be dropped at any level: the car folder itself, or the HostFS root / `resources` /
 * `vehicle` above it — the car folder is the one holding `vp_x.pck`. Inside the DAT every file sits
 * under `resources/vehicle/vp_x/`, as in all 94 original car DATs, whatever the folder was called on
 * disk. Only `.pck` files go in, and never the garage `_g.pck` (it lives in ASSETS, not in the DAT).
 * The archive is src/dave-build.ts — dave.py `-cn`'s exact layout.
 */

const RECENTS_KEY = "mc3pae.recentDatBuilderFolders";

type Scan = { root: string; vehicle: VehicleFolder<PackageFile> };

export function DatBuilderTool({ dropped, onConsumeDrop, onStatus }: {
  dropped: string[] | null;
  onConsumeDrop: () => void;
  onStatus: (message: string) => void;
}) {
  const [scan, setScan] = useState<Scan | null>(null);
  const [recents, setRecents] = useState<string[]>(() => loadRecent(RECENTS_KEY));
  const [error, setError] = useState("");
  const [result, setResult] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (root: string) => {
    try {
      setBusy(true); setError(""); setResult(""); setScan(null);
      const vehicles = findVehicleFolders(await readPackageFiles(root));
      if (!vehicles.length) { setError(`No car folder found in ${basename(root)}: nothing there or below holds a vp_*.pck player PCK.`); return; }
      if (vehicles.length > 1) { setError(`${basename(root)} holds more than one car (${vehicles.map((vehicle) => vehicle.car).join(", ")}). Drop one car's folder.`); return; }
      setScan({ root, vehicle: vehicles[0] });
      setRecents(pushRecent(RECENTS_KEY, root));
      onStatus(`${vehicles[0].car} · ${vehicles[0].included.length} PCKs to pack`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not read that folder.");
    } finally { setBusy(false); }
  }, [onStatus]);

  useEffect(() => {
    if (!dropped) return;
    const paths = dropped;
    onConsumeDrop();
    if (paths.length) void load(paths[0]);
  }, [dropped, onConsumeDrop, load]);

  const pickFolder = async () => {
    const selection = await openDialog({ directory: true, multiple: false, defaultPath: scan?.root });
    if (typeof selection === "string") void load(selection);
  };

  const build = useCallback(async () => {
    if (!scan) return;
    const { vehicle, root } = scan;
    try {
      setBusy(true); setError(""); setResult("");
      // Suggest the folder next to the one that was chosen, never inside it: a stray .dat inside a
      // HostFS tree would sit among the files the emulator serves.
      const target = await saveDialog({ defaultPath: await join(parentPath(root) || root, `${vehicle.car}.dat`), filters: [{ name: "Vehicle DAT", extensions: ["dat"] }] });
      if (!target) return;
      if (basename(target).toLowerCase() !== `${vehicle.car}.dat`) {
        setError(`The game looks the DAT up as ${vehicle.car}.dat — save it under that name.`);
        return;
      }
      const bytes = await buildVehicleDat(vehicle);
      // Prove the archive before it is written: every member reads back as its source file.
      const archive = await readDave(memoryReader(bytes), basename(target));
      const byName = entriesByName(archive);
      for (const file of vehicle.included) {
        const entry = byName.get(`resources/vehicle/${vehicle.car}/${basename(file.path).toLowerCase()}`)?.[0];
        const source = await file.read();
        const packed = entry ? await readEntry(archive, entry) : null;
        if (!packed || packed.length !== source.length || packed.some((value, index) => value !== source[index])) throw new Error(`${basename(file.path)} didn't pack correctly; nothing was written.`);
      }
      await writeVerified(target, bytes);
      const message = `${vehicle.car}.dat built · ${vehicle.included.length} PCKs · ${sizeLabel(bytes.length)} · ${target}`;
      setResult(message);
      onStatus(message);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The DAT could not be built.");
    } finally { setBusy(false); }
  }, [scan, onStatus]);

  const vehicle = scan?.vehicle;
  return <>
    <section className="toolkit-hero">
      <div>
        <p className="eyebrow">{tr("HOSTFS FOLDER → VEHICLE DAT")}</p>
        <h2>{tr("Pack a car folder into its vp_*.dat")}</h2>
        <p className="toolkit-hero-copy"><Tx t="Drop the car's folder — or any folder above it, like the HostFS root. Everything is packed under {0} inside the DAT, the layout every original car DAT uses, so the folder doesn't need to be in that structure on disk. Only {1} files go in, and the garage {2} is always left out." v={[<code>resources/vehicle/vp_x/</code>, <code>.pck</code>, <code>_g.pck</code>]} /></p>
      </div>
      <div className="toolkit-facts">
        <div><span>{tr("INPUT")}</span><strong>{tr("Car folder (HostFS layout)")}</strong></div>
        <div><span>{tr("OUTPUT")}</span><strong>{tr("vp_*.dat — dave.py -cn layout")}</strong></div>
        <div><span>{tr("EDITS")}</span><strong>{tr("None — the folder is only read")}</strong></div>
      </div>
    </section>

    <section className="toolkit-panel">
      <div className="toolkit-panel-head">
        <div><span className="step-number">01</span><div><h3>{tr("Choose the car folder")}</h3><p><Tx t="The folder with {0}, {1} and the parts, or one above it." v={[<code>vp_x.pck</code>, <code>vp_x_o.pck</code>]} /></p></div></div>
        <span className="toolkit-required">{tr("REQUIRED")}</span>
      </div>
      <div className="toolkit-file-row">
        <button className="toolkit-drop" type="button" disabled={busy} onClick={() => void pickFolder()}>
          <span className="toolkit-file-type">{tr("DIR")}</span>
          <span className="toolkit-drop-copy">
            <strong>{vehicle ? vehicle.car : busy ? tr("Scanning…") : tr("Choose a folder")}</strong>
            <small>{scan ? (vehicle!.folder ? `${basename(scan.root)}/${vehicle!.folder}` : scan.root) : tr("Click to browse, or drop it on the window")}</small>
          </span>
          <span className="toolkit-drop-action">{scan ? tr("CHANGE") : tr("+ OPEN")}</span>
        </button>
        <RecentList title={tr("Recent folders")} paths={recents} activePath={scan?.root} busy={busy} onPick={(path) => void load(path)} onClear={() => { saveRecent(RECENTS_KEY, []); setRecents([]); }} />
      </div>
    </section>

    <section className="toolkit-panel">
      <div className="toolkit-panel-head">
        <div><span className="step-number">02</span><div><h3>{tr("Contents")}</h3><p>{tr("What goes into the DAT, and what stays out.")}</p></div></div>
        {vehicle && <div className="toolkit-chips">
          <span><Tx t="{0} packed" v={[<strong>{vehicle.included.length}</strong>]} /></span>
          <span className={vehicle.excluded.length ? "prior" : ""}><Tx t="{0} left out" v={[<strong>{vehicle.excluded.length}</strong>]} /></span>
        </div>}
      </div>
      {!vehicle ? (
        <div className="toolkit-empty"><span>{tr("DAT")}</span><strong>{tr("No folder yet")}</strong><p>{tr("The list appears once a car folder is chosen.")}</p></div>
      ) : <div className="toolkit-category-list">
        <details className="toolkit-category">
          <summary>
            <span className="toolkit-category-index">{tr("IN")}</span>
            <span><strong><Tx t="Packed into {0}.dat" v={[vehicle.car]} /></strong><small><Tx t="resources/vehicle/{0}/" v={[vehicle.car]} /></small></span>
            <span className="toolkit-category-count"><Tx t="{0} FILES" v={[vehicle.included.length]} /></span>
            <i />
          </summary>
          <div className="dat-file-list">{[...vehicle.included].sort((a, b) => a.path.localeCompare(b.path)).map((file) => <code key={file.path}>{basename(file.path)}</code>)}</div>
        </details>
        {vehicle.excluded.length > 0 && <details className="toolkit-category" open>
          <summary>
            <span className="toolkit-category-index">{tr("OUT")}</span>
            <span><strong>{tr("Left out")}</strong><small>{tr("not part of a vehicle DAT")}</small></span>
            <span className="toolkit-category-removed-flag"><Tx t="{0} SKIPPED" v={[vehicle.excluded.length]} /></span>
            <i />
          </summary>
          <div className="dat-file-list">{vehicle.excluded.map((file) => <code key={file.path}>{basename(file.path)} <em>— {tr(file.reason)}</em></code>)}</div>
        </details>}
      </div>}
    </section>

    {vehicle && <section className="toolkit-actions">
      <div>
        <strong><Tx t="Build {0}.dat" v={[vehicle.car]} /></strong>
        <small>{tr("Written only where you choose, then read back and compared. Put it in ASSETS (or add it to a mod ZIP) to install it.")}</small>
      </div>
      <div className="carcfg-actions">
        <button className="toolkit-primary" type="button" disabled={busy} onClick={() => void build()}>{busy ? tr("BUILDING…") : tr("BUILD DAT")}<span>→</span></button>
      </div>
    </section>}

    {result && <section className="iso-result"><span>✓</span><p>{tr(result)}</p></section>}
    {error && <section className="toolkit-error"><span>!</span><div><strong>{tr("Action required")}</strong><p>{tr(error)}</p></div></section>}
  </>;
}
