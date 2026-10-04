import { tr, Tx } from "./i18n";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { hex, type PckDocument } from "../src/pck";
import { applyAnchorRotation } from "./anchor-rotation";
import { anchorWorldPosition, matchLodEntries, resolveGroupShaderId, resolvePieceId, type MeshGeometry } from "../src/mesh";
import { hexToRgb, rgbToHex, shaderColorRgb } from "./shader-color";
import { PieceIdChip, ShaderIdChip } from "./piece-id-chip";

type ActiveCamera = THREE.PerspectiveCamera | THREE.OrthographicCamera;
type ViewDirection = "front" | "back" | "left" | "right" | "top" | "bottom";
type Projection = "perspective" | "orthographic";
type RenderMode = "solid" | "wireframe" | "solid-wire";
export type MeshSelection = { meshName: string; meshId: number; shaderId: number | null; group: number | null; triangleIndex: number | null };
type Rgba = [number, number, number, number];

type ViewerRuntime = {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  perspectiveCamera: THREE.PerspectiveCamera;
  orthographicCamera: THREE.OrthographicCamera;
  camera: ActiveCamera;
  controls: OrbitControls;
  modelGroup: THREE.Group;
  grid: THREE.GridHelper;
  raycaster: THREE.Raycaster;
  edgesMaterial: THREE.LineBasicMaterial;
  uvChecker: THREE.Texture;
};

const VIEW_OFFSETS: Record<ViewDirection, THREE.Vector3> = {
  front: new THREE.Vector3(0, 0, -1), back: new THREE.Vector3(0, 0, 1),
  left: new THREE.Vector3(-1, 0, 0), right: new THREE.Vector3(1, 0, 0),
  top: new THREE.Vector3(0, 1, 0), bottom: new THREE.Vector3(0, -1, 0),
};
const VIEW_UP: Record<ViewDirection, THREE.Vector3> = {
  front: new THREE.Vector3(0, 1, 0), back: new THREE.Vector3(0, 1, 0),
  left: new THREE.Vector3(0, 1, 0), right: new THREE.Vector3(0, 1, 0),
  top: new THREE.Vector3(0, 0, -1), bottom: new THREE.Vector3(0, 0, 1),
};
const PERSPECTIVE_FOV = 42;
function frameOrthographic(camera: THREE.OrthographicCamera, distance: number, aspect: number) {
  const halfHeight = Math.max(distance * Math.tan((PERSPECTIVE_FOV * Math.PI / 180) / 2), 0.05);
  camera.left = -halfHeight * aspect; camera.right = halfHeight * aspect;
  camera.top = halfHeight; camera.bottom = -halfHeight;
  camera.zoom = 1;
  camera.updateProjectionMatrix();
}
const UV_CHECKER_URL = new URL("./assets/uv-checker.png", import.meta.url).href;
const CHECKERBOARD = "repeating-conic-gradient(#3a4038 0% 25%,#20241e 0% 50%) 0 0/10px 10px";

function ShaderChip({ id, rgba, active, onRgbChange, onAlphaChange }: { id: number; rgba: Rgba; active: boolean; onRgbChange(hex: string): void; onAlphaChange(alpha: number): void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { const close = (event: MouseEvent) => { if (!ref.current?.contains(event.target as Node)) setOpen(false); }; window.addEventListener("mousedown", close); return () => window.removeEventListener("mousedown", close); }, []);
  const [r, g, b, a] = rgba;
  const [r255, g255, b255] = [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
  const solidCss = `rgb(${r255} ${g255} ${b255})`;
  const rgbaCss = `rgba(${r255}, ${g255}, ${b255}, ${a})`;
  const alphaTrack = { "--alpha-track": `linear-gradient(to right, transparent, ${solidCss}), ${CHECKERBOARD}` } as React.CSSProperties;
  return <div className={`shader-legend-chip ${active ? "active" : ""}`} ref={ref}>
    <button type="button" className="shader-swatch" style={{ backgroundImage: `linear-gradient(${rgbaCss}, ${rgbaCss}), ${CHECKERBOARD}` }} onClick={() => setOpen((value) => !value)} title={tr(`Shader ${hex(id, 2)} — click to recolor`)} />
    <span>{hex(id, 2)}</span>
    {open && <div className="shader-picker-popover">
      <input type="color" className="shader-picker-color" value={rgbToHex([r, g, b])} onChange={(event) => onRgbChange(event.target.value)} />
      <input type="range" className="alpha-slider" style={alphaTrack} min={0} max={100} value={Math.round(a * 100)} onChange={(event) => onAlphaChange(Number(event.target.value) / 100)} />
      <div className="shader-picker-readout"><span>{hex(id, 2)}</span><span>{Math.round(a * 100)}%</span></div>
    </div>}
  </div>;
}

export function MeshEditorViewer({ meshes, visibleNames, document, selection, onSelect, onPieceContextMenu, onRevealPiece, onEditPieceId, onEditGroupShader, onUndo, onRedo, canUndo, canRedo }: {
  meshes: MeshGeometry[];
  visibleNames: Set<string>;
  document: PckDocument | null;
  selection: MeshSelection | null;
  onSelect(selection: MeshSelection | null): void;
  onPieceContextMenu(mesh: MeshGeometry, x: number, y: number): void;
  onRevealPiece(meshName: string): void;
  onEditPieceId(newId: number): void;
  onEditGroupShader(group: number, newId: number): void;
  onUndo(): void;
  onRedo(): void;
  canUndo: boolean;
  canRedo: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<ViewerRuntime | null>(null);
  const objectsRef = useRef(new Map<THREE.Object3D, MeshGeometry>());
  const edgesRef = useRef<THREE.LineSegments[]>([]);
  const fittedRef = useRef(false);
  const documentRef = useRef(document);
  const contextMenuRef = useRef(onPieceContextMenu);
  const revealRef = useRef(onRevealPiece);
  useEffect(() => { documentRef.current = document; contextMenuRef.current = onPieceContextMenu; revealRef.current = onRevealPiece; });
  const [projection, setProjection] = useState<Projection>("perspective");
  const [renderMode, setRenderMode] = useState<RenderMode>("solid");
  const [uvChecker, setUvChecker] = useState(false);
  const [colorOverrides, setColorOverrides] = useState<Map<number, Rgba>>(new Map());
  const getColor = useCallback((shaderId: number): Rgba => {
    const override = colorOverrides.get(shaderId);
    if (override) return override;
    const [r, g, b] = shaderColorRgb(shaderId);
    return [r, g, b, 1];
  }, [colorOverrides]);
  const setShaderRgb = useCallback((shaderId: number, hexColor: string) => {
    setColorOverrides((current) => { const next = new Map(current); const [r, g, b] = hexToRgb(hexColor); next.set(shaderId, [r, g, b, getColor(shaderId)[3]]); return next; });
  }, [getColor]);
  const setShaderAlpha = useCallback((shaderId: number, alpha: number) => {
    setColorOverrides((current) => { const next = new Map(current); const [r, g, b] = getColor(shaderId); next.set(shaderId, [r, g, b, alpha]); return next; });
  }, [getColor]);

  const visible = useMemo(() => meshes.filter((mesh) => visibleNames.has(mesh.name)), [meshes, visibleNames]);
  const shaderLegend = useMemo(() => {
    const counts = new Map<number, number>();
    for (const mesh of visible) for (const id of mesh.groupShaderIds) counts.set(id, (counts.get(id) ?? 0) + 1);
    return [...counts.keys()].sort((a, b) => a - b);
  }, [visible]);
  const triangleCount = useMemo(() => visible.reduce((sum, mesh) => sum + mesh.triangles, 0), [visible]);
  const selectionLodMatches = useMemo(() => (selection && document ? matchLodEntries(selection.meshName, document) : []), [selection, document]);
  // Multiple matches are only a real problem (blocking edits) when they disagree on the current ID —
  // a piece intentionally listed at HLOD *and* MLOD *and* LLOD with the same ID is normal, not ambiguous.
  const selectionLodIdsAgree = selectionLodMatches.length > 0 && new Set(selectionLodMatches.map((entry) => entry.meshId)).size === 1;
  const canEditId = selectionLodMatches.length > 0 && selectionLodIdsAgree;

  const fitCamera = useCallback(() => {
    const runtime = runtimeRef.current; const host = hostRef.current;
    if (!runtime || !host || !runtime.modelGroup.children.length) return;
    const box = new THREE.Box3().setFromObject(runtime.modelGroup);
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(size.x, size.y, size.z, 1);
    const distance = radius * 1.55;
    runtime.controls.target.copy(center);
    runtime.camera.position.copy(center).add(new THREE.Vector3(1.15, 0.72, 1.35).normalize().multiplyScalar(distance));
    runtime.camera.up.set(0, 1, 0);
    runtime.camera.near = Math.max(radius / 1000, 0.002);
    runtime.camera.far = Math.max(radius * 100, 100);
    if (runtime.camera instanceof THREE.OrthographicCamera) frameOrthographic(runtime.camera, distance, host.clientWidth / Math.max(host.clientHeight, 1));
    runtime.camera.updateProjectionMatrix();
    runtime.controls.update();
  }, []);

  const applyView = useCallback((direction: ViewDirection) => {
    const runtime = runtimeRef.current; if (!runtime) return;
    const target = runtime.controls.target.clone();
    const distance = Math.max(runtime.camera.position.distanceTo(target), 0.5);
    runtime.camera.up.copy(VIEW_UP[direction]);
    runtime.camera.position.copy(target).addScaledVector(VIEW_OFFSETS[direction], distance);
    runtime.camera.lookAt(target);
    runtime.controls.update();
  }, []);

  const toggleProjection = useCallback(() => setProjection((current) => current === "perspective" ? "orthographic" : "perspective"), []);
  const cycleRenderMode = useCallback(() => setRenderMode((current) => current === "solid" ? "wireframe" : current === "wireframe" ? "solid-wire" : "solid"), []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b0e0c);
    scene.fog = new THREE.Fog(0x0b0e0c, 14, 34);
    const perspectiveCamera = new THREE.PerspectiveCamera(PERSPECTIVE_FOV, 1, 0.01, 200);
    const orthographicCamera = new THREE.OrthographicCamera(-5, 5, 5, -5, 0.01, 200);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.domElement.className = "viewer-canvas";
    host.appendChild(renderer.domElement);
    const controls = new OrbitControls(perspectiveCamera, renderer.domElement);
    controls.enableDamping = true; controls.dampingFactor = 0.08; controls.screenSpacePanning = true; controls.minDistance = 0.25; controls.maxDistance = 80;
    const modelGroup = new THREE.Group(); scene.add(modelGroup);
    const grid = new THREE.GridHelper(20, 40, 0x4a5c36, 0x222a23); scene.add(grid);
    const axes = new THREE.AxesHelper(0.65); axes.position.set(-0.01, 0.01, -0.01); scene.add(axes);
    scene.add(new THREE.HemisphereLight(0xdce8d8, 0x151915, 2.3));
    const key = new THREE.DirectionalLight(0xffffff, 1.4); key.position.set(4, 7, 5); scene.add(key);
    const edgesMaterial = new THREE.LineBasicMaterial({ color: 0x000000 });
    // MC3 stores V pointing down (the OBJ export writes 1 - v), so the image is sampled from its top
    // row at v = 0 — the same placement Blender shows for an exported OBJ.
    const uvChecker = new THREE.TextureLoader().load(UV_CHECKER_URL);
    uvChecker.flipY = false;
    uvChecker.colorSpace = THREE.SRGBColorSpace;
    uvChecker.wrapS = uvChecker.wrapT = THREE.RepeatWrapping;
    uvChecker.anisotropy = renderer.capabilities.getMaxAnisotropy();

    runtimeRef.current = { renderer, scene, perspectiveCamera, orthographicCamera, camera: perspectiveCamera, controls, modelGroup, grid, raycaster: new THREE.Raycaster(), edgesMaterial, uvChecker };
    const resize = () => {
      const width = Math.max(host.clientWidth, 1); const height = Math.max(host.clientHeight, 1);
      renderer.setSize(width, height, false);
      const aspect = width / height;
      perspectiveCamera.aspect = aspect; perspectiveCamera.updateProjectionMatrix();
      const currentHalfHeight = (orthographicCamera.top - orthographicCamera.bottom) / 2 || 5;
      orthographicCamera.left = -currentHalfHeight * aspect; orthographicCamera.right = currentHalfHeight * aspect; orthographicCamera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize); observer.observe(host); resize();

    const pointer = new THREE.Vector2();
    /** Selects whatever triangle is under the cursor (or clears the selection) and returns its piece. */
    const pickAt = (event: MouseEvent) => {
      const runtime = runtimeRef.current; if (!runtime) return null;
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      runtime.raycaster.setFromCamera(pointer, runtime.camera);
      const hits = runtime.raycaster.intersectObjects(modelGroup.children, false);
      const hit = hits.find((item) => objectsRef.current.has(item.object));
      if (!hit || typeof hit.faceIndex !== "number") { onSelect(null); return null; }
      const faceIndex = hit.faceIndex;
      const parsed = objectsRef.current.get(hit.object)!;
      const vertexIndex = parsed.indices[faceIndex * 3];
      const shaderId = parsed.vertexShaderIds[vertexIndex];
      const group = parsed.vertexGroupIndices[vertexIndex];
      const displayId = resolvePieceId(parsed.name, parsed.meshId, documentRef.current).displayId;
      onSelect({ meshName: parsed.name, meshId: displayId, shaderId, group, triangleIndex: faceIndex });
      return parsed;
    };
    const handleClick = (event: MouseEvent) => { pickAt(event); };
    // Double-click also jumps the piece list to the picked piece, expanding its group.
    const handleDoubleClick = (event: MouseEvent) => { const parsed = pickAt(event); if (parsed) revealRef.current(parsed.name); };
    // Right-drag pans the camera, and the browser still fires contextmenu when that drag ends, so
    // the menu only opens for a right click that stayed put.
    let rightDown: { x: number; y: number } | null = null;
    const handlePointerDown = (event: PointerEvent) => { if (event.button === 2) rightDown = { x: event.clientX, y: event.clientY }; };
    const handleContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      const start = rightDown; rightDown = null;
      if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4) return;
      const parsed = pickAt(event);
      if (parsed) contextMenuRef.current(parsed, event.clientX, event.clientY);
    };
    renderer.domElement.addEventListener("click", handleClick);
    renderer.domElement.addEventListener("dblclick", handleDoubleClick);
    renderer.domElement.addEventListener("pointerdown", handlePointerDown);
    renderer.domElement.addEventListener("contextmenu", handleContextMenu);

    let frame = 0;
    const render = () => {
      frame = requestAnimationFrame(render);
      const runtime = runtimeRef.current; if (!runtime) return;
      runtime.controls.update();
      runtime.renderer.render(runtime.scene, runtime.camera);
    };
    render();
    return () => {
      cancelAnimationFrame(frame); observer.disconnect(); controls.dispose();
      renderer.domElement.removeEventListener("click", handleClick);
      renderer.domElement.removeEventListener("dblclick", handleDoubleClick);
      renderer.domElement.removeEventListener("pointerdown", handlePointerDown);
      renderer.domElement.removeEventListener("contextmenu", handleContextMenu);
      for (const child of modelGroup.children) {
        const mesh = child as THREE.Mesh;
        mesh.geometry?.dispose();
        (mesh.material as THREE.Material)?.dispose?.();
      }
      objectsRef.current.clear();
      edgesRef.current = [];
      edgesMaterial.dispose(); uvChecker.dispose();
      renderer.dispose(); renderer.domElement.remove(); runtimeRef.current = null;
    };
    // onSelect is intentionally left out: it's a stable-enough callback from the parent and
    // re-subscribing the click listener on every render would be wasteful for no benefit here.
  }, []);

  useEffect(() => {
    const runtime = runtimeRef.current; const host = hostRef.current;
    if (!runtime || !host) return;
    const nextCamera = projection === "orthographic" ? runtime.orthographicCamera : runtime.perspectiveCamera;
    const previous = runtime.camera;
    if (nextCamera === previous) return;
    const target = runtime.controls.target.clone();
    const distance = Math.max(previous.position.distanceTo(target), 0.5);
    nextCamera.position.copy(previous.position);
    nextCamera.up.copy(previous.up);
    nextCamera.near = previous.near; nextCamera.far = previous.far;
    if (nextCamera instanceof THREE.OrthographicCamera) frameOrthographic(nextCamera, distance, host.clientWidth / Math.max(host.clientHeight, 1));
    else nextCamera.updateProjectionMatrix();
    nextCamera.lookAt(target);
    runtime.camera = nextCamera;
    runtime.controls.object = nextCamera;
    runtime.controls.update();
  }, [projection]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    for (const child of [...runtime.modelGroup.children]) {
      runtime.modelGroup.remove(child);
      (child as THREE.Mesh).geometry?.dispose();
      ((child as THREE.Mesh).material as THREE.Material)?.dispose?.();
    }
    objectsRef.current.clear();
    edgesRef.current = [];
    for (const parsed of visible) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(parsed.positions, 3));
      geometry.setAttribute("normal", new THREE.BufferAttribute(parsed.normals, 3));
      const colors = new Float32Array(parsed.vertexShaderIds.length * 4);
      for (let i = 0; i < parsed.vertexShaderIds.length; i += 1) {
        const [r, g, b, a] = getColor(parsed.vertexShaderIds[i]);
        colors[i * 4] = r; colors[i * 4 + 1] = g; colors[i * 4 + 2] = b; colors[i * 4 + 3] = a;
      }
      geometry.setAttribute("color", new THREE.BufferAttribute(colors, 4));
      geometry.setAttribute("uv", new THREE.BufferAttribute(parsed.uvs, 2));
      geometry.setIndex(new THREE.BufferAttribute(parsed.indices, 1));
      geometry.computeBoundingSphere();
      const material = new THREE.MeshStandardMaterial({ vertexColors: !uvChecker, map: uvChecker ? runtime.uvChecker : null, transparent: true, wireframe: renderMode === "wireframe", roughness: 0.7, metalness: 0.05, side: THREE.DoubleSide });
      const object = new THREE.Mesh(geometry, material);
      const position = document ? anchorWorldPosition(document, parsed.anchorIndex ?? 0, "a2") : [0, 0, 0];
      object.position.set(position[0], position[1], position[2]);
      if (document) applyAnchorRotation(object, document, parsed.anchorIndex ?? 0);
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 1), runtime.edgesMaterial);
      edges.visible = renderMode === "solid-wire";
      object.add(edges);
      edgesRef.current.push(edges);
      runtime.modelGroup.add(object);
      objectsRef.current.set(object, parsed);
    }
    if (!fittedRef.current && visible.length) { fittedRef.current = true; requestAnimationFrame(fitCamera); }
    // getColor, renderMode and uvChecker are intentionally left out of the deps below: this effect only needs
    // to seed colors/wireframe state at build time, and the next two effects update existing
    // objects in place on every subsequent change, without rebuilding geometry.
  }, [document, fitCamera, visible]);

  useEffect(() => {
    for (const [object, parsed] of objectsRef.current) {
      const color = (object as THREE.Mesh).geometry.getAttribute("color") as THREE.BufferAttribute;
      for (let i = 0; i < parsed.vertexShaderIds.length; i += 1) {
        const [r, g, b, a] = getColor(parsed.vertexShaderIds[i]);
        color.setXYZW(i, r, g, b, a);
      }
      color.needsUpdate = true;
    }
  }, [getColor]);

  useEffect(() => {
    const wireframeOn = renderMode === "wireframe";
    for (const object of objectsRef.current.keys()) ((object as THREE.Mesh).material as THREE.MeshStandardMaterial).wireframe = wireframeOn;
    const showEdges = renderMode === "solid-wire";
    for (const edges of edgesRef.current) edges.visible = showEdges;
  }, [renderMode]);

  useEffect(() => {
    const runtime = runtimeRef.current; if (!runtime) return;
    for (const object of objectsRef.current.keys()) {
      const material = (object as THREE.Mesh).material as THREE.MeshStandardMaterial;
      material.vertexColors = !uvChecker; material.map = uvChecker ? runtime.uvChecker : null; material.needsUpdate = true;
    }
  }, [uvChecker]);

  return <section className="viewer-pane mesh-editor-3d">
    <header className="viewer-header"><div><p className="eyebrow">{tr("SHADER MAP")}</p><strong>{tr("Triangle picking · shader colors")}</strong></div><div className="viewer-tools"><button disabled={!canUndo} onClick={onUndo} title={tr("Undo")}>{tr("↶ Undo")}</button><button disabled={!canRedo} onClick={onRedo} title={tr("Redo")}>{tr("↷ Redo")}</button><button className={renderMode !== "solid" ? "active" : ""} onClick={cycleRenderMode} title={tr("Cycle shading mode")}>{renderMode === "solid" ? tr("Solid") : renderMode === "wireframe" ? tr("Wireframe") : tr("Solid+Wire")}</button><button className={uvChecker ? "active" : ""} onClick={() => setUvChecker((current) => !current)} title={tr("Show a numbered test texture on the UVs instead of the shader colors")}>{tr("UV Checker")}</button><button onClick={fitCamera}>{tr("Frame model")}</button></div></header>
    <div className="view-controls">
      <div className="view-buttons">
        <button onClick={() => applyView("front")}>{tr("Front")}</button>
        <button onClick={() => applyView("back")}>{tr("Back")}</button>
        <button onClick={() => applyView("left")}>{tr("Left")}</button>
        <button onClick={() => applyView("right")}>{tr("Right")}</button>
        <button onClick={() => applyView("top")}>{tr("Top")}</button>
        <button onClick={() => applyView("bottom")}>{tr("Bottom")}</button>
      </div>
      <div className="view-toggles"><button className={projection === "orthographic" ? "active" : ""} onClick={toggleProjection}>{projection === "orthographic" ? tr("Ortho") : tr("Persp")}</button></div>
    </div>
    <div className="viewer-stage" ref={hostRef}>
      {!visible.length && <div className="viewer-empty"><span>3D</span><strong>{tr("No visible geometry")}</strong><p>{tr("Show some parts in the pieces list to see them colored by shader here.")}</p></div>}
      <div className="viewer-stats"><span><Tx t="{0} parts" v={[visible.length]} /></span><span><Tx t="{0} tris" v={[triangleCount.toLocaleString()]} /></span><span><Tx t="{0} shaders" v={[shaderLegend.length]} /></span></div>
      <div className="shader-legend">{shaderLegend.map((id) => <ShaderChip key={id} id={id} rgba={getColor(id)} active={selection?.shaderId === id} onRgbChange={(value) => setShaderRgb(id, value)} onAlphaChange={(value) => setShaderAlpha(id, value)} />)}</div>
      {selection && (() => {
        const shaderRgba = selection.shaderId !== null ? getColor(selection.shaderId) : null;
        const standaloneRaw = meshes.find((mesh) => mesh.name === selection.meshName)?.meshId;
        const standaloneMismatch = standaloneRaw !== undefined && standaloneRaw !== selection.meshId;
        const mismatchNote = standaloneMismatch ? ` · mesh.pck has ${hex(standaloneRaw!, 2)}` : "";
        const selectedMesh = selection.group !== null ? meshes.find((mesh) => mesh.name === selection.meshName) : undefined;
        const shaderInfo = selection.group !== null && selectedMesh ? resolveGroupShaderId(selection.meshName, selection.group, selectedMesh, document) : null;
        const lodLine = selectionLodMatches.length === 0
          ? "Not found in HLOD/MLOD/LLOD tables — ID can't be edited here"
          : !selectionLodIdsAgree
            ? `Inconsistent · ${selectionLodMatches.length} table matches disagree on the ID (${selectionLodMatches.map((entry) => `${entry.lod.toUpperCase()} ${hex(entry.meshId, 2)}`).join(", ")})`
            : selectionLodMatches.length > 1
              ? `${selectionLodMatches.map((entry) => `${entry.lod.toUpperCase()} #${entry.index}`).join(" + ")} · ${selectionLodMatches.some((entry) => entry.meshBlockOffset !== null) ? "embedded in this PCK" : "external mesh.pck only"}${mismatchNote}`
              : `${selectionLodMatches[0].lod.toUpperCase()} #${selectionLodMatches[0].index} · ${selectionLodMatches[0].meshBlockOffset !== null ? "embedded in this PCK" : "external mesh.pck only"}${mismatchNote}`;
        return <div className="pick-readout">
          {shaderRgba && <i style={{ background: `rgb(${Math.round(shaderRgba[0] * 255)} ${Math.round(shaderRgba[1] * 255)} ${Math.round(shaderRgba[2] * 255)})` }} />}
          <div>
            <strong>{selection.meshName}</strong>
            <span className="pick-readout-tags">
              <PieceIdChip meshId={selection.meshId} editable={canEditId} onCommit={onEditPieceId} />
              {shaderInfo && <ShaderIdChip shaderId={shaderInfo.displayId} editable={shaderInfo.editable} dirty={shaderInfo.dirty} onCommit={(newId) => onEditGroupShader(selection.group!, newId)} />}
              {selection.triangleIndex !== null && <span><Tx t="Triangle #{0}" v={[selection.triangleIndex]} /></span>}
            </span>
            <span>{lodLine}</span>
          </div>
        </div>;
      })()}
    </div>
    <footer className="viewer-footer"><span>{tr("Click a triangle to identify its piece + shader")}</span><span>{tr("Right-click for piece actions")}</span><span>{tr("Drag to orbit")}</span><span>{tr("Wheel to zoom")}</span></footer>
  </section>;
}
