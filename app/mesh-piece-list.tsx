import { tr, Tx } from "./i18n";
import { useEffect, useMemo, useRef, useState } from "react";
import { hex, type LodMeshEntry, type PckDocument } from "../src/pck";
import { categoryLabel, resolveGroupShaderId, resolvePieceId, type MeshGeometry } from "../src/mesh";
import { sizeLabel } from "./vehicle-types";
import type { MeshSelection } from "./mesh-editor-viewer";
import { PieceIdChip, ShaderIdChip } from "./piece-id-chip";

/** Renders how much of the viewed car a piece occupies, showing `was → now` while that differs
 *  from disk. Blue means it shrank, red means it grew. */
function PieceSize({ size }: { size: { embedded: number | null; embeddedSaved: number | null; loose: number | null; looseSaved: number | null; embeddedHere: boolean } }) {
  const { embedded, embeddedSaved, loose, embeddedHere } = size;
  const looseNote = loose !== null ? ` · loose mesh.pck is ${sizeLabel(loose)}` : "";
  if (embedded === null) {
    const why = embeddedHere
      ? "This copy came with the game, so its size isn't recorded in the file"
      : "Not embedded in this PCK — it costs this car nothing";
    return <small className="piece-size none" title={why + looseNote}>—</small>;
  }
  if (embeddedSaved === null || embeddedSaved === embedded) {
    return <small className="piece-size" title={tr(`Takes up ${sizeLabel(embedded)} of this PCK${looseNote}`)}>{sizeLabel(embedded)}</small>;
  }
  const grew = embedded > embeddedSaved;
  const delta = Math.abs(embedded - embeddedSaved);
  return <small
    className={`piece-size ${grew ? "grew" : "shrank"}`}
    title={tr(`${grew ? "Grew" : "Shrank"} by ${sizeLabel(delta)} — was ${sizeLabel(embeddedSaved)} on disk, will be ${sizeLabel(embedded)} once saved${looseNote}`)}
  >{sizeLabel(embeddedSaved)} → {sizeLabel(embedded)}</small>;
}

function lodTag(document: PckDocument | null, mesh: MeshGeometry) {
  const info = resolvePieceId(mesh.name, mesh.meshId, document);
  const mismatchNote = info.standaloneMismatch ? ` · mesh.pck has ${hex(mesh.meshId, 2)}` : "";
  if (!document) return { text: "—", className: "", ...info };
  if (info.entries.length === 0) return { text: "Not found", className: "warn", ...info };
  const idsAgree = new Set(info.entries.map((entry) => entry.meshId)).size === 1;
  if (!idsAgree) return { text: "Inconsistent ID", className: "warn", ...info };
  const embedded = info.entries.some((entry) => entry.meshBlockOffset !== null);
  const text = info.entries.length > 1
    ? `${info.entries.map((entry) => `${entry.lod.toUpperCase()} #${entry.index}`).join(" + ")}${embedded ? " · embedded" : ""}${mismatchNote}`
    : `${info.entries[0].lod.toUpperCase()} #${info.entries[0].index}${embedded ? " · embedded" : ""}${mismatchNote}`;
  if (mesh.origin === "embedded") return { text: `${info.entries[0].lod.toUpperCase()} #${info.entries[0].index} · PCK only`, className: "embedded-only", ...info };
  return { text, className: embedded ? "embedded" : (info.standaloneMismatch ? "warn" : ""), ...info };
}

export function MeshPieceList({ meshes, document, visibleNames, onSetVisible, selection, onSelect, onEditPieceId, onEditGroupShader, onUpdateEmbedded, describeEmbedTarget, describePieceSize, onPieceContextMenu, revealRequest, width }: {
  meshes: MeshGeometry[];
  document: PckDocument | null;
  visibleNames: Set<string>;
  onSetVisible(names: string[], visible: boolean): void;
  selection: MeshSelection | null;
  onSelect(selection: MeshSelection | null): void;
  onEditPieceId(meshName: string, entries: LodMeshEntry[], newId: number): void;
  onEditGroupShader(meshName: string, group: number, newId: number): void;
  onUpdateEmbedded(meshName: string): void;
  describeEmbedTarget(meshName: string): { targets: string[]; inserting: boolean; hasRow: boolean };
  describePieceSize(meshName: string): { embedded: number | null; embeddedSaved: number | null; loose: number | null; looseSaved: number | null; embeddedHere: boolean };
  onPieceContextMenu(mesh: MeshGeometry, x: number, y: number): void;
  revealRequest: { meshName: string } | null;
  width: number;
}) {
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const lastToggledRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pendingScrollRef = useRef<string | null>(null);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return meshes;
    return meshes.filter((mesh) => mesh.name.toLowerCase().includes(query) || hex(mesh.meshId, 2).toLowerCase().includes(query) || hex(resolvePieceId(mesh.name, mesh.meshId, document).displayId, 2).toLowerCase().includes(query));
  }, [meshes, search, document]);
  const groups = useMemo(() => {
    const byCategory = new Map<string, MeshGeometry[]>();
    for (const mesh of filtered) byCategory.set(mesh.category, [...(byCategory.get(mesh.category) ?? []), mesh]);
    for (const list of byCategory.values()) list.sort((a, b) => resolvePieceId(a.name, a.meshId, document).displayId - resolvePieceId(b.name, b.meshId, document).displayId);
    return [...byCategory.entries()].sort((a, b) => categoryLabel(a[0]).localeCompare(categoryLabel(b[0])));
  }, [filtered, document]);
  const flatOrder = useMemo(() => groups.flatMap(([, list]) => list.map((mesh) => mesh.name)), [groups]);

  // Expand the requested piece's group (clearing a search that hides it), then scroll to its row
  // once the row has rendered.
  useEffect(() => {
    if (!revealRequest) return;
    const mesh = meshes.find((item) => item.name === revealRequest.meshName);
    if (!mesh) return;
    if (!filtered.includes(mesh)) setSearch("");
    setExpanded((current) => current.has(mesh.category) ? current : new Set(current).add(mesh.category));
    pendingScrollRef.current = mesh.name;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealRequest]);
  useEffect(() => {
    const name = pendingScrollRef.current;
    if (!name) return;
    const row = [...(scrollRef.current?.querySelectorAll<HTMLElement>("[data-mesh-name]") ?? [])].find((element) => element.dataset.meshName === name);
    if (!row) return;
    pendingScrollRef.current = null;
    row.scrollIntoView({ block: "center" });
  });

  const toggleGroup = (category: string) => {
    setExpanded((current) => { const next = new Set(current); next.has(category) ? next.delete(category) : next.add(category); return next; });
  };

  const handleVisibilityClick = (mesh: MeshGeometry, category: string, event: React.MouseEvent) => {
    event.stopPropagation();
    const currentlyVisible = visibleNames.has(mesh.name);
    if (event.altKey) {
      const categoryNames = groups.find(([key]) => key === category)?.[1].map((item) => item.name) ?? [];
      onSetVisible(categoryNames.filter((name) => name !== mesh.name), false);
      onSetVisible([mesh.name], true);
      lastToggledRef.current = mesh.name;
      return;
    }
    if (event.shiftKey && lastToggledRef.current) {
      const from = flatOrder.indexOf(lastToggledRef.current);
      const to = flatOrder.indexOf(mesh.name);
      if (from >= 0 && to >= 0) {
        const [lo, hi] = from < to ? [from, to] : [to, from];
        onSetVisible(flatOrder.slice(lo, hi + 1), !currentlyVisible);
        lastToggledRef.current = mesh.name;
        return;
      }
    }
    onSetVisible([mesh.name], !currentlyVisible);
    lastToggledRef.current = mesh.name;
  };

  return <aside className="navigator mesh-piece-list" style={{ "--mesh-list-width": `${width}px` } as React.CSSProperties}>
    <div className="pane-heading"><div><span>03</span><strong>{tr("Pieces")}</strong></div><em>{meshes.length}</em></div>
    <div className="search"><span>⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={tr("Name or ID…")} /></div>
    <div className="tree-scroll" ref={scrollRef}>
      {groups.map(([category, groupMeshes]) => {
        // Groups start collapsed; a search expands every group that has a match.
        const isCollapsed = !search.trim() && !expanded.has(category);
        return <div className="mesh-piece-group" key={category}>
          <button className="mesh-piece-group-heading" onClick={() => toggleGroup(category)}>
            <span><i className={`tree-toggle ${isCollapsed ? "" : "open"}`}>{isCollapsed ? "+" : "−"}</i>{categoryLabel(category)}</span>
            <em>{groupMeshes.length}</em>
          </button>
          {!isCollapsed && groupMeshes.map((mesh) => {
            const active = selection?.meshName === mesh.name;
            const visible = visibleNames.has(mesh.name);
            const tag = lodTag(document, mesh);
            const firstGroup = mesh.groupShaderIds.length ? 0 : null;
            return <div key={mesh.name} data-mesh-name={mesh.name} className={`flat-anchor-row mesh-piece-row ${active ? "selected" : ""}`} onContextMenu={(event) => { event.preventDefault(); onSelect({ meshName: mesh.name, meshId: tag.displayId, shaderId: mesh.groupShaderIds[0] ?? null, group: firstGroup, triangleIndex: null }); onPieceContextMenu(mesh, event.clientX, event.clientY); }}>
              <div className="mesh-piece-row-top">
                <PieceIdChip meshId={tag.displayId} editable={tag.editable} onCommit={(newId) => onEditPieceId(mesh.name, tag.entries, newId)} />
                <button className="flat-anchor-main" onClick={() => onSelect({ meshName: mesh.name, meshId: tag.displayId, shaderId: mesh.groupShaderIds[0] ?? null, group: firstGroup, triangleIndex: null })}>
                  <span className="flat-name" title={mesh.name}>{mesh.name.replace(/\.mesh\.pck$/i, "")}</span>
                  <span className="mesh-piece-meta">
                    <small className={`mesh-piece-lod ${tag.className}`} title={mesh.origin === "embedded" ? tr("Baked into the car PCK with no loose mesh.pck beside it — read straight from the PCK. Nothing to sync; right-click to export it.") : undefined}>{tag.text}</small>
                    <PieceSize size={describePieceSize(mesh.name)} />
                  </span>
                </button>
                {(() => {
                  // An embedded-only piece has no loose file to sync from.
                  if (mesh.origin === "embedded") return null;
                  const plan = describeEmbedTarget(mesh.name);
                  if (!plan.targets.length) return null;
                  const where = plan.targets.map((role) => role[0].toUpperCase() + role.slice(1)).join(", ");
                  return <button
                    className={`mesh-reembed ${plan.inserting ? "inserting" : ""}`}
                    onClick={(event) => { event.stopPropagation(); onUpdateEmbedded(mesh.name); }}
                    title={plan.inserting
                      ? tr(`Insert this piece into ${where}. It has a table row there but no baked-in copy yet, so the game currently streams it from the loose mesh.pck. Stays in memory until you save.`)
                      : tr(`Update the baked-in copy of this piece in ${where} from the loose mesh.pck. Handles a changed mesh size, and stays in memory until you save.`)}
                  >{plan.inserting ? "+" : "⟳"}</button>;
                })()}
                <button className={`mesh-visibility ${visible ? "visible" : "hidden"}`} onClick={(event) => handleVisibilityClick(mesh, category, event)} title={tr(`${visible ? "Hide" : "Show"} this part · Shift-click for a range, Alt-click to solo within ${categoryLabel(category)}`)} aria-pressed={visible}><span /></button>
              </div>
              <div className="mesh-shader-chips">
                {mesh.groupShaderIds.map((_standaloneId, group) => {
                  const info = resolveGroupShaderId(mesh.name, group, mesh, document);
                  return <ShaderIdChip key={group} shaderId={info.displayId} editable={info.editable} dirty={info.dirty} onCommit={(newId) => onEditGroupShader(mesh.name, group, newId)} />;
                })}
              </div>
            </div>;
          })}
        </div>;
      })}
    </div>
  </aside>;
}
