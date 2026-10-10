import { tr, Tx, confirmDialog } from "../i18n";
import { useCallback, useRef, useState } from "react";
import { FlashMenuTool } from "./flash-menu-tool";
import { CarcfgTool } from "./carcfg-tool";
import { PartsMapperTool } from "./parts-mapper-tool";
import { InjectorTool } from "./injector-tool";
import { IdSyncTool } from "./id-sync-tool";
import { DatBuilderTool } from "./dat-builder-tool";
import { CompactIsoTool } from "./compact-iso-tool";
import { CleanerTool } from "./cleaner-tool";
import { ExhaustTool } from "./exhaust-tool";
import { basename } from "./toolkit-io";

/**
 * Mod Toolkit — batch and one-off utilities that work on loose files.
 *
 * Deliberately separate from the Anchor/Mesh Editor's vehicle-set model: the files here are chosen
 * per tool and often aren't part of a vehicle set at all (`vs_*.pck`, `*.carcfg`). Each tool owns
 * its own state and its own Save; switching tools discards the current one's pending edits, which
 * is why an unsaved tool asks first.
 */

type ToolId = "injector" | "id-sync" | "flash-menu" | "carcfg" | "parts-mapper" | "cleaner" | "dat-builder" | "compact-iso" | "exhausts";
type ToolStatus = "active" | "next" | "planned";
type Tool = { id: ToolId; number: string; name: string; blurb: string; status: ToolStatus };

const tools: Tool[] = [
  { id: "parts-mapper", number: "01", name: "Flash Parts Mapper", blurb: "List the Visual Shop parts in menu order", status: "active" },
  { id: "cleaner", number: "02", name: "Car PCK Cleaner", blurb: "Remove embedded meshes to get a clean base", status: "active" },
  { id: "carcfg", number: "03", name: "Carcfg Randomizer", blurb: "Randomize opponent parts indexes", status: "active" },
  { id: "flash-menu", number: "04", name: "Flash Menu Editor", blurb: "Limit the Visual Shop menu entries", status: "active" },
  { id: "injector", number: "05", name: "Car PCK Mesh Injector", blurb: "Embed loose mesh.pck files into a car PCK in bulk", status: "active" },
  { id: "id-sync", number: "06", name: "Mesh ID Sync", blurb: "Stamp a car PCK's LOD table IDs onto loose meshes", status: "active" },
  { id: "dat-builder", number: "07", name: "Vehicle DAT Builder", blurb: "Pack a car folder into its vp_*.dat", status: "active" },
  { id: "compact-iso", number: "08", name: "Compact ISO", blurb: "Pack the original dual-layer ISO into one layer", status: "active" },
  { id: "exhausts", number: "09", name: "Exhaust Tips", blurb: "Turn rear-bumper exhaust tips on or off", status: "active" },
];

const statusBadges: Record<ToolStatus, string | null> = { active: null, next: "NEXT", planned: "SOON" };

export function ModToolkitWorkspace({ onStatus, dirtyVehiclePaths, dropped, onConsumeDrop, onBusyChange }: {
  onStatus: (message: string) => void;
  /** Files the vehicle set is holding with unsaved edits — the toolkit refuses to open those, so
   *  two editing models can never write over each other's pending work. */
  dirtyVehiclePaths: string[];
  dropped: string[] | null;
  onConsumeDrop: () => void;
  /** True while a tool is writing a disc image — the window must not close then. */
  onBusyChange: (busy: boolean) => void;
}) {
  const [activeTool, setActiveTool] = useState<ToolId>(tools[0].id);
  const pending = useRef<Partial<Record<ToolId, boolean>>>({});

  const isPathBlocked = useCallback((path: string) => {
    const normalize = (value: string) => value.replace(/\//g, "\\").toLowerCase();
    const normalized = normalize(path);
    return dirtyVehiclePaths.some((held) => normalize(held) === normalized)
      ? `${basename(path)} is open in the vehicle set with unsaved changes. Save or close it there first.`
      : null;
  }, [dirtyVehiclePaths]);

  const setPending = useCallback((tool: ToolId, value: boolean) => { pending.current[tool] = value; }, []);
  const flashMenuPending = useCallback((value: boolean) => setPending("flash-menu", value), [setPending]);
  const carcfgPending = useCallback((value: boolean) => setPending("carcfg", value), [setPending]);
  const injectorPending = useCallback((value: boolean) => setPending("injector", value), [setPending]);
  const idSyncPending = useCallback((value: boolean) => setPending("id-sync", value), [setPending]);
  const cleanerPending = useCallback((value: boolean) => setPending("cleaner", value), [setPending]);
  const exhaustsPending = useCallback((value: boolean) => setPending("exhausts", value), [setPending]);

  const selectTool = async (tool: Tool) => {
    if (tool.status !== "active" || tool.id === activeTool) return;
    if (pending.current[activeTool]) {
      const discard = await confirmDialog(
        `${tools.find((item) => item.id === activeTool)!.name} has unsaved changes. Switching tools will discard them. Continue?`,
        { title: "Unsaved changes", kind: "warning" },
      );
      if (!discard) return;
      pending.current[activeTool] = false;
    }
    setActiveTool(tool.id);
  };

  const active = tools.find((tool) => tool.id === activeTool)!;

  return <div className="mod-toolkit">
    <aside className="toolkit-nav">
      <p className="toolkit-nav-heading">{tr("Tools")}</p>
      {tools.map((tool) => <button
        key={tool.id}
        type="button"
        className={`toolkit-nav-item ${tool.id === activeTool ? "active" : ""} ${tool.status === "active" ? "" : "unavailable"}`}
        disabled={tool.status !== "active"}
        onClick={() => void selectTool(tool)}
      >
        <span className="toolkit-nav-number">{tool.number}</span>
        <span className="toolkit-nav-copy"><strong>{tr(tool.name)}</strong><small>{tr(tool.blurb)}</small></span>
        {statusBadges[tool.status] && <span className="toolkit-nav-badge">{statusBadges[tool.status]}</span>}
      </button>)}
      <div className="toolkit-nav-note">
        <strong>{tr("Loose files")}</strong>
        <small>{tr("This tab opens files on its own, independently of the vehicle set used by the Meshes, Anchors, Performance and Audio tabs.")}</small>
      </div>
    </aside>

    <main className="toolkit-main">
      <header className="toolkit-main-head">
        <p className="eyebrow"><Tx t="TOOL {0}" v={[active.number]} /></p>
        <h1>{tr(active.name)}</h1>
      </header>
      {activeTool === "flash-menu" && <FlashMenuTool
        dropped={dropped}
        onConsumeDrop={onConsumeDrop}
        onStatus={onStatus}
        isPathBlocked={isPathBlocked}
        onPendingChange={flashMenuPending}
      />}
      {activeTool === "carcfg" && <CarcfgTool
        dropped={dropped}
        onConsumeDrop={onConsumeDrop}
        onStatus={onStatus}
        isPathBlocked={isPathBlocked}
        onPendingChange={carcfgPending}
      />}
      {activeTool === "parts-mapper" && <PartsMapperTool
        dropped={dropped}
        onConsumeDrop={onConsumeDrop}
        onStatus={onStatus}
        isPathBlocked={isPathBlocked}
      />}
      {activeTool === "cleaner" && <CleanerTool
        dropped={dropped}
        onConsumeDrop={onConsumeDrop}
        onStatus={onStatus}
        isPathBlocked={isPathBlocked}
        onPendingChange={cleanerPending}
      />}
      {activeTool === "injector" && <InjectorTool
        dropped={dropped}
        onConsumeDrop={onConsumeDrop}
        onStatus={onStatus}
        isPathBlocked={isPathBlocked}
        onPendingChange={injectorPending}
      />}
      {activeTool === "compact-iso" && <CompactIsoTool
        dropped={dropped}
        onConsumeDrop={onConsumeDrop}
        onStatus={onStatus}
        onBusyChange={onBusyChange}
      />}
      {activeTool === "dat-builder" && <DatBuilderTool
        dropped={dropped}
        onConsumeDrop={onConsumeDrop}
        onStatus={onStatus}
      />}
      {activeTool === "exhausts" && <ExhaustTool
        dropped={dropped}
        onConsumeDrop={onConsumeDrop}
        onStatus={onStatus}
        isPathBlocked={isPathBlocked}
        onPendingChange={exhaustsPending}
      />}
      {activeTool === "id-sync" && <IdSyncTool
        dropped={dropped}
        onConsumeDrop={onConsumeDrop}
        onStatus={onStatus}
        isPathBlocked={isPathBlocked}
        onPendingChange={idSyncPending}
      />}
    </main>
  </div>;
}
