import { tr, Tx } from "./i18n";
import { useCallback, useEffect, useState } from "react";
import type { LodMeshEntry, PckDocument } from "../src/pck";
import { hasStockVariants, isLowLodOnly, isShadowPlane, matchLodEntries, type MeshGeometry, type MeshPckDocument } from "../src/mesh";
import { roleLabels, roles, sizeLabel, type VehicleRole, type VehicleSlots } from "./vehicle-types";
import { MeshEditorViewer, type MeshSelection } from "./mesh-editor-viewer";
import { MeshPieceList } from "./mesh-piece-list";
import { ResizeHandle } from "./resize-handle";
import { ContextMenu, type ContextMenuState } from "./context-menu";

const plannedFeatures = [
  { title: "Piece ID + shader editing", detail: "Edit a piece's ID and per-group shader IDs, kept in sync across the Player, Garage and Opponent PCKs." },
  { title: "Garage (_g.pck) piece updater", detail: "Re-embed a loose mesh.pck into the PCKs that bake it in, appending and repointing when the geometry size changes." },
];

// Visibility here is keyed by the mesh's own (unique) filename, not by the fuzzy anchor-name match
// used for 3D positioning — some pieces (e.g. the LOD group meshes) all resolve to the same anchor
// via that heuristic, which would make them share one visibility flag if we reused it.
// Pieces start visible at HLOD only — embedded or loose, since some cars ship their M/L body as
// loose "stk" files — so the M/L copies of the same shell don't sit on top of it; the shadow planes
// (neonglow, Shadow_Neon) are flat sheets under the car and would just cover the grid.
function defaultVisibleNames(meshes: MeshGeometry[], document: PckDocument | null) {
  const customizable = hasStockVariants(meshes);
  return new Set(meshes.filter((mesh) => (mesh.origin === "embedded" || mesh.stock || mesh.category === "lodgroup" || !customizable)
    && !isLowLodOnly(mesh, document) && !isShadowPlane(mesh.name)).map((mesh) => mesh.name));
}

export function MeshEditorWorkspace({ document, activeRole, slots, onSelectRole, meshes, onEditPieceId, onEditGroupShader, onUpdateEmbedded, onUpdateAllEmbedded, onConvertObjs, zeroShellId, onSetZeroShellId, onExportObj, embeddedUnreadable, objFolder, describeEmbedTarget, describePieceSize, onUndo, onRedo, canUndo, canRedo, vehicleBase, loadedCount, onOpenFolder, recentVehicleFolders, onOpenRecentFolder, onClearRecentFolders, listWidth, onResizeList }: {
  document: PckDocument | null;
  activeRole: VehicleRole | null;
  slots: VehicleSlots;
  onSelectRole(role: VehicleRole): void;
  meshes: MeshGeometry[];
  onEditPieceId(meshName: string, entries: LodMeshEntry[], newId: number): void;
  onEditGroupShader(meshName: string, group: number, newId: number): void;
  onUpdateEmbedded(meshName: string): void;
  onUpdateAllEmbedded(): void;
  onConvertObjs(): void;
  /** Sync (and Convert OBJs' embed) sets the table ID of pieces named "shell" to 0 first. */
  zeroShellId: boolean;
  onSetZeroShellId(value: boolean): void;
  onExportObj(mesh: MeshGeometry): void;
  /** Embedded-only pieces the parser couldn't read, so they're missing from the list. */
  embeddedUnreadable: string[];
  objFolder: string;
  describeEmbedTarget(meshName: string): { targets: string[]; inserting: boolean; hasRow: boolean };
  describePieceSize(meshName: string): { embedded: number | null; embeddedSaved: number | null; loose: number | null; looseSaved: number | null; embeddedHere: boolean };
  onUndo(): void;
  onRedo(): void;
  canUndo: boolean;
  canRedo: boolean;
  vehicleBase: string;
  loadedCount: number;
  onOpenFolder(): void;
  recentVehicleFolders: string[];
  onOpenRecentFolder(path: string): void;
  onClearRecentFolders(): void;
  listWidth: number;
  onResizeList(deltaX: number): void;
}) {
  const [selection, setSelection] = useState<MeshSelection | null>(null);
  const [visibleNames, setVisibleNames] = useState<Set<string>>(() => defaultVisibleNames(meshes, document));
  useEffect(() => { setVisibleNames(defaultVisibleNames(meshes, document)); setSelection(null); }, [meshes, document]);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  // A fresh object per request so double-clicking the same piece twice still re-scrolls to it.
  const [revealRequest, setRevealRequest] = useState<{ meshName: string } | null>(null);
  const closeContextMenu = useCallback(() => setContextMenu(null), []);
  const openPieceMenu = (mesh: MeshGeometry, x: number, y: number) => {
    const plan = describeEmbedTarget(mesh.name);
    const where = plan.targets.map((role) => roleLabels[role as VehicleRole] ?? role).join(", ");
    const syncBlocked = mesh.origin === "embedded"
      ? "This piece only exists inside the car PCKs — there is no loose mesh.pck to sync from."
      : !plan.hasRow ? "No HLOD/MLOD/LLOD row in any loaded PCK, so there is no slot to sync it into."
      : !plan.targets.length ? "No loaded PCK to sync this piece into." : null;
    setContextMenu({ x, y, heading: mesh.name.replace(/\.mesh\.pck$/i, ""), items: [
      { label: plan.inserting ? "Sync piece (insert)" : "Sync piece", disabled: syncBlocked !== null, title: syncBlocked ?? `Bring the copy baked into ${where} in line with the loose mesh.pck. Stays in memory until you save.`, onSelect: () => onUpdateEmbedded(mesh.name) },
      { label: "Export as OBJ…", title: "Write this piece to an OBJ the OBJ converter reads back as-is: piece ID in the filename, one material per group named by shader ID, normals and UVs.", onSelect: () => onExportObj(mesh) },
    ] });
  };
  const setVisible = (names: string[], visible: boolean) => {
    setVisibleNames((current) => { const next = new Set(current); for (const name of names) visible ? next.add(name) : next.delete(name); return next; });
  };
  const editSelectedPieceId = (newId: number) => {
    if (!document || !selection) return;
    onEditPieceId(selection.meshName, matchLodEntries(selection.meshName, document), newId);
    setSelection({ ...selection, meshId: newId });
  };
  const editSelectedGroupShader = (group: number, newId: number) => {
    if (!selection) return;
    onEditGroupShader(selection.meshName, group, newId);
    setSelection({ ...selection, shaderId: newId });
  };

  if (!document) {
    return (
      <main className="welcome mesh-editor-welcome">
        <div className="drop-card">
          <div className="file-glyph"><span>{tr("MESH")}</span></div>
          <p className="eyebrow">{tr("MESH EDITOR")}</p>
          <h1><Tx t="Open the vehicle folder.{0}See it colored by shader." v={[<br />]} /></h1>
          <p className="welcome-copy">
            {tr("Uses the same vehicle folder as the Anchors tab — the three car PCKs and the loose mesh.pck files. Click any triangle to identify its piece and shader.")}</p>
          <div className="welcome-actions"><button className="primary" onClick={onOpenFolder}>{tr("Open vehicle folder")}</button></div>
          {recentVehicleFolders.length > 0 && <div className="recent-folders"><div className="recent-folders-heading"><span>{tr("Recent folders")}</span><button className="link-button" onClick={onClearRecentFolders}>{tr("Clear list")}</button></div><div className="recent-folders-list">{recentVehicleFolders.map((path) => <button key={path} className="recent-folder-item" title={path} onClick={() => onOpenRecentFolder(path)}>{path.replace(/^.*[\\/]/, "")}</button>)}</div></div>}
          <ul className="mesh-editor-feature-list">
            {plannedFeatures.map((feature) => (
              <li key={tr(feature.title)}>
                <strong>{tr(feature.title)}</strong>
                <span>{feature.detail}</span>
              </li>
            ))}
          </ul>
        </div>
      </main>
    );
  }

  return (
    <main className="mesh-editor-loaded">
      <section className="vehicle-set-bar">
        <div className="set-summary"><p className="eyebrow">{tr("VEHICLE SET")}</p><strong>{vehicleBase}</strong><span><Tx t="{0}/3 files ready · shared with Anchors" v={[loadedCount]} /></span>{embeddedUnreadable.length > 0 && <span className="warn" title={embeddedUnreadable.join("\n")}><Tx t="{0} embedded piece{1} couldn't be read" v={[embeddedUnreadable.length, embeddedUnreadable.length === 1 ? "" : "s"]} /></span>}</div>
        <div className="mesh-role-tabs">{roles.filter((role) => slots[role]).map((role) => {
          const roleDocument = slots[role]!.document;
          const pending = roleDocument.dirty;
          return <button key={role} className={role === activeRole ? "active" : ""} onClick={() => onSelectRole(role)} title={`${roleLabels[role]} · ${sizeLabel(roleDocument.projectedSize)}${pending ? " once saved (disk still has the old contents)" : ""}`}>
            {tr(roleLabels[role])}
            <small className={pending ? "size-pending" : ""}>{sizeLabel(roleDocument.projectedSize)}{pending ? " *" : ""}</small>
          </button>;
        })}</div>
        <button className="folder-button" onClick={onConvertObjs} title={objFolder ? tr(`Convert the OBJs in ${objFolder} into mesh.pck pieces and embed them. Last used folder is remembered; nothing is written until you save.`) : tr("Pick a folder of OBJs to convert into mesh.pck pieces and embed in one pass. Nothing is written until you save.")}>{tr("Convert OBJs…")}</button>
        <button className="folder-button" onClick={onUpdateAllEmbedded} title={tr("Bring every loose mesh.pck in line at once: update the ones already baked in, and insert the ones that only have an empty table row waiting. Stays in memory until you save.")}>{tr("Sync all")}</button>
        <label className="sync-option" title={tr("When syncing or converting OBJs, pieces with 'shell' in their name get ID 0 in every loaded PCK and in the embedded copy. Clears an ID a shell borrowed to preview.")}>
          <input type="checkbox" checked={zeroShellId} onChange={(event) => onSetZeroShellId(event.target.checked)} />
          <span>{tr("Zero shell ID")}</span>
        </label>
        <button className="folder-button" onClick={onOpenFolder}>{tr("Open folder…")}</button>
      </section>
      <div className="mesh-editor-body">
        <MeshPieceList key={vehicleBase} meshes={meshes} document={document} visibleNames={visibleNames} onSetVisible={setVisible} selection={selection} onSelect={setSelection} onEditPieceId={onEditPieceId} onEditGroupShader={onEditGroupShader} onUpdateEmbedded={onUpdateEmbedded} describeEmbedTarget={describeEmbedTarget} describePieceSize={describePieceSize} onPieceContextMenu={openPieceMenu} revealRequest={revealRequest} width={listWidth} />
        <ResizeHandle variant="resize-mesh-list" onDrag={onResizeList} />
        <MeshEditorViewer meshes={meshes} visibleNames={visibleNames} document={document} selection={selection} onSelect={setSelection} onPieceContextMenu={openPieceMenu} onRevealPiece={(meshName) => setRevealRequest({ meshName })} onEditPieceId={editSelectedPieceId} onEditGroupShader={editSelectedGroupShader} onUndo={onUndo} onRedo={onRedo} canUndo={canUndo} canRedo={canRedo} />
      </div>
      {contextMenu && <ContextMenu menu={contextMenu} onClose={closeContextMenu} />}
    </main>
  );
}
