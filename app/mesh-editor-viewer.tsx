import { tr, Tx } from "./i18n";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { hex, type PckDocument } from "../src/pck";
import { applyAnchorRotation } from "./anchor-rotation";
import { anchorWorldPosition, matchLodEntries, resolveGroupShaderId, resolvePieceId, type MeshGeometry } from "../src/mesh";
import { hexToRgb, rgbToHex, shaderColorRgb } from "./shader-color";
import { PieceIdChip, ShaderIdChip } from "./piece-id-chip";
import { registerDiagnosticViewer } from "./diagnostics";
import { countOf, flagsOf, triangleCount, type SelectMode, type SimilarScope, type TriangleCommand, type TriangleFlags } from "./mesh-selection";

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
  selectionMaterial: THREE.MeshBasicMaterial;
  pickMaterial: THREE.ShaderMaterial;
  uvChecker: THREE.Texture;
};
type TriangleHit = { parsed: MeshGeometry; triangle: number };
type BoxRect = { left: number; top: number; right: number; bottom: number };
type SelectTool = "none" | "box" | "brush";
type PickBuffer = { pixels: Uint8Array; width: number; height: number; ratio: number; ranges: { name: string; faceMap: Uint32Array; start: number }[] };
/** The circle's radius in CSS pixels, kept between sessions (a per-viewer convenience). */
const BRUSH_RADIUS_KEY = "mc3pae.brushRadius";
const BRUSH_MIN = 4, BRUSH_MAX = 300;
function loadBrushRadius() { try { const value = Number(localStorage.getItem(BRUSH_RADIUS_KEY)); return value >= BRUSH_MIN && value <= BRUSH_MAX ? value : 30; } catch { return 30; } }

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
// Box selection without X-ray renders each visible triangle in a flat color that encodes its number
// (id + 1 over 24 bits of RGB) and reads back the pixels under the box, so only what the camera
// actually sees gets picked.
const PICK_VERTEX_SHADER = "attribute vec3 pickColor; varying vec3 vPickColor; void main() { vPickColor = pickColor; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }";
const PICK_FRAGMENT_SHADER = "varying vec3 vPickColor; void main() { gl_FragColor = vec4(vPickColor, 1.0); }";
const DRAG_THRESHOLD = 4;

/** Writes the piece's visible triangles (in order) into the front of the geometry's index and limits
 *  the draw range to them; returns which triangle each drawn face is. The index buffer keeps its full
 *  size so hiding and revealing never allocate a new GPU buffer. */
function writeVisibleIndex(geometry: THREE.BufferGeometry, parsed: MeshGeometry, hidden: Uint8Array | null, only: Uint8Array | null = null) {
  const index = geometry.getIndex()!;
  const array = index.array as Uint32Array;
  const faces: number[] = [];
  for (let triangle = 0; triangle < triangleCount(parsed); triangle += 1) {
    if (hidden?.[triangle] || (only && !only[triangle])) continue;
    const at = faces.length * 3; const from = triangle * 3;
    array[at] = parsed.indices[from]; array[at + 1] = parsed.indices[from + 1]; array[at + 2] = parsed.indices[from + 2];
    faces.push(triangle);
  }
  geometry.setDrawRange(0, faces.length * 3);
  index.needsUpdate = true;
  return Uint32Array.from(faces);
}

/** Frees a piece object's GPU data, with its edge lines and selection overlay. The materials those
 *  children use are shared by the whole viewer and stay. */
function disposePieceObject(object: THREE.Mesh) {
  for (const child of object.children) (child as THREE.Mesh).geometry?.dispose();
  object.geometry?.dispose();
  (object.material as THREE.Material)?.dispose?.();
}

/**
 * "Assign shader ▾": moves the selected triangles to the slot of the chosen shader in each piece.
 * Lists the car's shader bank by name, the shaders the selected pieces already use first.
 */
function AssignShaderMenu({ bank, used, selectedCount, getColor, onPick }: { bank: { id: number; name: string }[] | null; used: number[]; selectedCount: number; getColor(id: number): Rgba; onPick(shaderId: number): void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { const close = (event: MouseEvent) => { if (!ref.current?.contains(event.target as Node)) setOpen(false); }; window.addEventListener("mousedown", close); return () => window.removeEventListener("mousedown", close); }, []);
  const disabled = !bank || !selectedCount;
  const row = (entry: { id: number; name: string }) => {
    const [r, g, b] = getColor(entry.id);
    return <button key={entry.id} type="button" className="assign-shader-row" onClick={() => { setOpen(false); onPick(entry.id); }}>
      <i style={{ background: `rgb(${Math.round(r * 255)} ${Math.round(g * 255)} ${Math.round(b * 255)})` }} /><span>{hex(entry.id, 2)}</span><em>{entry.name || tr("(unnamed)")}</em>
    </button>;
  };
  const inUse = bank ? used.map((id) => bank[id]).filter(Boolean) : [];
  return <div className="assign-shader" ref={ref}>
    <button className={open ? "active" : ""} disabled={disabled} onClick={() => setOpen((value) => !value)} title={!bank ? tr("This car's shader list wasn't found, so there is nothing to assign") : !selectedCount ? tr("Select triangles first") : tr("Move the selected triangles to another shader. Each piece moves them into its slot with that shader, or a new slot when it has none. The file changes; Undo reverts it.")}>{tr("Assign shader ▾")}</button>
    {open && bank && <div className="assign-shader-menu">
      <p><Tx t="Move {0} selected triangles to:" v={[selectedCount.toLocaleString()]} /></p>
      {inUse.length > 0 && <><strong>{tr("In the selected parts")}</strong>{inUse.map(row)}</>}
      <strong>{tr("All shaders of this car")}</strong>
      {bank.map(row)}
    </div>}
  </div>;
}

function ShaderChip({ id, name, rgba, active, onRgbChange, onAlphaChange, onSelectTriangles }: { id: number; name: string; rgba: Rgba; active: boolean; onRgbChange(hex: string): void; onAlphaChange(alpha: number): void; onSelectTriangles(deselect: boolean): void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { const close = (event: MouseEvent) => { if (!ref.current?.contains(event.target as Node)) setOpen(false); }; window.addEventListener("mousedown", close); return () => window.removeEventListener("mousedown", close); }, []);
  const [r, g, b, a] = rgba;
  const [r255, g255, b255] = [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
  const solidCss = `rgb(${r255} ${g255} ${b255})`;
  const rgbaCss = `rgba(${r255}, ${g255}, ${b255}, ${a})`;
  const alphaTrack = { "--alpha-track": `linear-gradient(to right, transparent, ${solidCss}), ${CHECKERBOARD}` } as React.CSSProperties;
  return <div className={`shader-legend-chip ${active ? "active" : ""}`} ref={ref}>
    {/* `background`, not backgroundImage: the checkerboard carries its position/size, which only the shorthand accepts. */}
    <button type="button" className="shader-swatch" style={{ background: `linear-gradient(${rgbaCss}, ${rgbaCss}), ${CHECKERBOARD}` }} onClick={(event) => { if (event.shiftKey) onSelectTriangles(event.ctrlKey || event.metaKey); else setOpen((value) => !value); }} title={tr(`Shader ${hex(id, 2)}${name ? ` ${name}` : ""} — click to recolor, Shift-click to select its triangles (Ctrl+Shift to deselect)`)} />
    <span>{hex(id, 2)}</span>
    {open && <div className="shader-picker-popover">
      <input type="color" className="shader-picker-color" value={rgbToHex([r, g, b])} onChange={(event) => onRgbChange(event.target.value)} />
      <input type="range" className="alpha-slider" style={alphaTrack} min={0} max={100} value={Math.round(a * 100)} onChange={(event) => onAlphaChange(Number(event.target.value) / 100)} />
      <div className="shader-picker-readout"><span>{hex(id, 2)}</span><span>{Math.round(a * 100)}%</span></div>
    </div>}
  </div>;
}

export function MeshEditorViewer({ meshes, visibleNames, document, selection, onSelect, onPieceContextMenu, onRevealPiece, onEditPieceId, onEditGroupShader, onUndo, onRedo, canUndo, canRedo, selectedTriangles, hiddenTriangles, onTriangleCommand, shaderBank, onAssignShader }: {
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
  selectedTriangles: TriangleFlags;
  hiddenTriangles: TriangleFlags;
  onTriangleCommand(command: TriangleCommand): void;
  shaderBank: { id: number; name: string }[] | null;
  onAssignShader(shaderId: number): void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const marqueeRef = useRef<HTMLDivElement>(null);
  const brushRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<ViewerRuntime | null>(null);
  const objectsRef = useRef(new Map<THREE.Object3D, MeshGeometry>());
  const edgesRef = useRef(new Map<THREE.Object3D, THREE.LineSegments>());
  // Per piece object: which triangle each drawn face is (hidden ones are left out of the index),
  // the hidden flags that index was written for, and the overlay that tints the selection.
  const faceMapsRef = useRef(new Map<THREE.Object3D, Uint32Array>());
  const appliedHiddenRef = useRef(new Map<THREE.Object3D, Uint8Array | null>());
  const overlaysRef = useRef(new Map<THREE.Object3D, THREE.Mesh>());
  const fittedRef = useRef(false);
  const documentRef = useRef(document);
  const contextMenuRef = useRef(onPieceContextMenu);
  const revealRef = useRef(onRevealPiece);
  const commandRef = useRef(onTriangleCommand);
  const selectedRef = useRef(selectedTriangles);
  const hiddenRef = useRef(hiddenTriangles);
  const [projection, setProjection] = useState<Projection>("perspective");
  const [renderMode, setRenderMode] = useState<RenderMode>("solid");
  const renderModeRef = useRef(renderMode);
  const [uvChecker, setUvChecker] = useState(false);
  // Selection tool on the left button: none (orbit), box or brush.
  const [tool, setTool] = useState<SelectTool>("none");
  const [xray, setXray] = useState(false);
  // On by default: the tab is about shaders, so Linked normally means "this patch of this shader".
  const [delimitShader, setDelimitShader] = useState(true);
  const [similarScope, setSimilarScope] = useState<SimilarScope>("part");
  const toolsRef = useRef({ tool, xray, delimitShader, similarScope });
  useEffect(() => {
    documentRef.current = document; contextMenuRef.current = onPieceContextMenu; revealRef.current = onRevealPiece;
    commandRef.current = onTriangleCommand; selectedRef.current = selectedTriangles; hiddenRef.current = hiddenTriangles;
    renderModeRef.current = renderMode; toolsRef.current = { tool, xray, delimitShader, similarScope };
  });
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
  const visibleTriangleCount = useMemo(() => visible.reduce((sum, mesh) => sum + mesh.triangles, 0), [visible]);
  const selectedCount = useMemo(() => visible.reduce((sum, mesh) => sum + countOf(selectedTriangles, mesh), 0), [visible, selectedTriangles]);
  const selectedPieces = useMemo(() => visible.filter((mesh) => countOf(selectedTriangles, mesh) > 0).length, [visible, selectedTriangles]);
  const hiddenCount = useMemo(() => visible.reduce((sum, mesh) => sum + countOf(hiddenTriangles, mesh), 0), [visible, hiddenTriangles]);
  const selectedPartShaders = useMemo(() => [...new Set(visible.filter((mesh) => countOf(selectedTriangles, mesh) > 0).flatMap((mesh) => mesh.groupShaderIds))].sort((a, b) => a - b), [visible, selectedTriangles]);
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

  const clearPieceMaps = () => {
    objectsRef.current.clear(); edgesRef.current.clear(); faceMapsRef.current.clear(); appliedHiddenRef.current.clear(); overlaysRef.current.clear();
  };
  /** Leaves the piece's hidden triangles out of what is drawn, raycast and outlined. */
  const applyHidden = (object: THREE.Mesh, parsed: MeshGeometry) => {
    const runtime = runtimeRef.current; if (!runtime) return;
    const hidden = flagsOf(hiddenRef.current, parsed);
    const faceMap = writeVisibleIndex(object.geometry, parsed, hidden);
    faceMapsRef.current.set(object, faceMap);
    appliedHiddenRef.current.set(object, hidden);
    const previous = edgesRef.current.get(object);
    if (previous) { object.remove(previous); previous.geometry.dispose(); }
    // Every triangle edge, like Blender's wireframe — not EdgesGeometry, which leaves out the edges
    // between faces in the same plane (a flat quad's diagonal). WireframeGeometry reads the whole
    // index, not the draw range, so it gets a trimmed copy. That copy is never drawn (and never
    // disposed: it shares the position buffer with the piece).
    const visibleOnly = new THREE.BufferGeometry();
    visibleOnly.setAttribute("position", object.geometry.getAttribute("position"));
    visibleOnly.setIndex(new THREE.BufferAttribute((object.geometry.getIndex()!.array as Uint32Array).slice(0, faceMap.length * 3), 1));
    const edges = new THREE.LineSegments(new THREE.WireframeGeometry(visibleOnly), runtime.edgesMaterial);
    edges.renderOrder = 3;
    edges.visible = renderModeRef.current === "solid-wire";
    object.add(edges);
    edgesRef.current.set(object, edges);
  };
  /** Tints the piece's selected triangles with an overlay that shares the piece's positions. */
  const applySelection = (object: THREE.Mesh, parsed: MeshGeometry) => {
    const runtime = runtimeRef.current; if (!runtime) return;
    const selected = flagsOf(selectedRef.current, parsed);
    let overlay = overlaysRef.current.get(object);
    if (!selected) { if (overlay) overlay.visible = false; return; }
    if (!overlay) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", object.geometry.getAttribute("position"));
      geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(triangleCount(parsed) * 3), 1));
      overlay = new THREE.Mesh(geometry, runtime.selectionMaterial);
      overlay.renderOrder = 2;
      object.add(overlay);
      overlaysRef.current.set(object, overlay);
    }
    const drawn = writeVisibleIndex(overlay.geometry, parsed, flagsOf(hiddenRef.current, parsed), selected);
    overlay.visible = drawn.length > 0;
  };

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
    // Transparent only to be drawn in the late pass, after the selection tint, so it never covers the lines.
    const edgesMaterial = new THREE.LineBasicMaterial({ color: 0x000000, transparent: true });
    // MC3 stores V pointing down (the OBJ export writes 1 - v), so the image is sampled from its top
    // row at v = 0 — the same placement Blender shows for an exported OBJ.
    const uvChecker = new THREE.TextureLoader().load(UV_CHECKER_URL);
    uvChecker.flipY = false;
    uvChecker.colorSpace = THREE.SRGBColorSpace;
    uvChecker.wrapS = uvChecker.wrapT = THREE.RepeatWrapping;
    uvChecker.anisotropy = renderer.capabilities.getMaxAnisotropy();

    const selectionMaterial = new THREE.MeshBasicMaterial({ color: 0xff9a1f, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false, fog: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4 });
    const pickMaterial = new THREE.ShaderMaterial({ vertexShader: PICK_VERTEX_SHADER, fragmentShader: PICK_FRAGMENT_SHADER, side: THREE.DoubleSide });

    runtimeRef.current = { renderer, scene, perspectiveCamera, orthographicCamera, camera: perspectiveCamera, controls, modelGroup, grid, raycaster: new THREE.Raycaster(), edgesMaterial, selectionMaterial, pickMaterial, uvChecker };
    const unregisterDiagnostics = registerDiagnosticViewer("Meshes", renderer, () => runtimeRef.current?.camera ?? perspectiveCamera, modelGroup);
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
    /** The visible triangle under a screen point, if any. Hidden triangles aren't in the index, so the
     *  ray can't land on them; the face index it reports is mapped back to the piece's own numbering. */
    const hitAt = (clientX: number, clientY: number): TriangleHit | null => {
      const runtime = runtimeRef.current; if (!runtime) return null;
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
      runtime.raycaster.setFromCamera(pointer, runtime.camera);
      const hits = runtime.raycaster.intersectObjects(modelGroup.children, false);
      const hit = hits.find((item) => objectsRef.current.has(item.object));
      if (!hit || typeof hit.faceIndex !== "number") return null;
      const faceMap = faceMapsRef.current.get(hit.object);
      const triangle = faceMap ? faceMap[hit.faceIndex] : hit.faceIndex;
      return triangle === undefined ? null : { parsed: objectsRef.current.get(hit.object)!, triangle };
    };
    /** Shows the triangle under the cursor in the readout (or clears it) and returns it. */
    const pickAt = (event: MouseEvent, clearOnMiss = true) => {
      const hit = hitAt(event.clientX, event.clientY);
      if (!hit) { if (clearOnMiss) onSelect(null); return null; }
      const { parsed, triangle } = hit;
      const vertexIndex = parsed.indices[triangle * 3];
      const shaderId = parsed.vertexShaderIds[vertexIndex];
      const group = parsed.vertexGroupIndices[vertexIndex];
      const displayId = resolvePieceId(parsed.name, parsed.meshId, documentRef.current).displayId;
      onSelect({ meshName: parsed.name, meshId: displayId, shaderId, group, triangleIndex: triangle });
      return hit;
    };
    // The browser fires click (and contextmenu) at the end of a drag too, so a left drag that orbited
    // or drew a box, or a right drag that panned, doesn't count as a click.
    let leftDown: { x: number; y: number } | null = null;
    let rightDown: { x: number; y: number } | null = null;
    const moved = (start: { x: number; y: number } | null, event: MouseEvent) => start !== null && Math.hypot(event.clientX - start.x, event.clientY - start.y) > DRAG_THRESHOLD;
    const handleClick = (event: MouseEvent) => {
      const start = leftDown; leftDown = null;
      if (moved(start, event)) return;
      // With the brush a press already painted its circle; the click that follows must not replace it.
      if (toolsRef.current.tool === "brush") return;
      const hit = pickAt(event, !event.shiftKey);
      if (hit) commandRef.current({ kind: "pick", meshName: hit.parsed.name, triangle: hit.triangle, toggle: event.shiftKey });
      else if (!event.shiftKey) commandRef.current({ kind: "clear" });
    };
    // Double-click also jumps the piece list to the picked piece, expanding its group.
    const handleDoubleClick = (event: MouseEvent) => { const hit = pickAt(event); if (hit) revealRef.current(hit.parsed.name); };
    const handleContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      const start = rightDown; rightDown = null;
      if (moved(start, event)) return;
      const hit = pickAt(event);
      if (hit) contextMenuRef.current(hit.parsed, event.clientX, event.clientY);
    };

    // Box and brush selection: with either tool on, the left button selects (OrbitControls has its
    // left button switched off then, see the tool effect). The box selects what it covers when it
    // is released; the brush adds (Ctrl: removes) what passes under its circle while dragging.
    let box: { startX: number; startY: number; endX: number; endY: number } | null = null;
    let stroke: { id: number; buffer: PickBuffer | null; mode: SelectMode; done: Map<string, Set<number>> } | null = null;
    let strokes = 0;
    let hover: { x: number; y: number } | null = null;
    let brushRadius = loadBrushRadius();
    const drawMarquee = () => {
      const marquee = marqueeRef.current; if (!marquee) return;
      if (!box) { marquee.hidden = true; return; }
      marquee.hidden = false;
      marquee.style.left = `${Math.min(box.startX, box.endX)}px`; marquee.style.top = `${Math.min(box.startY, box.endY)}px`;
      marquee.style.width = `${Math.abs(box.endX - box.startX)}px`; marquee.style.height = `${Math.abs(box.endY - box.startY)}px`;
    };
    const localPoint = (event: MouseEvent) => { const rect = renderer.domElement.getBoundingClientRect(); return { x: event.clientX - rect.left, y: event.clientY - rect.top }; };
    const drawBrush = (point: { x: number; y: number } | null) => {
      const circle = brushRef.current; if (!circle) return;
      if (!point || toolsRef.current.tool !== "brush") { circle.hidden = true; return; }
      circle.hidden = false;
      circle.style.left = `${point.x - brushRadius}px`; circle.style.top = `${point.y - brushRadius}px`;
      circle.style.width = circle.style.height = `${brushRadius * 2}px`;
    };
    /** One dab of the brush: what lies under the circle and wasn't taken earlier in this stroke. */
    const paint = (point: { x: number; y: number }) => {
      if (!stroke) return;
      const inside = (x: number, y: number) => (x - point.x) ** 2 + (y - point.y) ** 2 <= brushRadius ** 2;
      const hits = stroke.buffer
        ? pickBufferHits(stroke.buffer, { left: point.x - brushRadius, right: point.x + brushRadius, top: point.y - brushRadius, bottom: point.y + brushRadius }, inside)
        : trianglesThrough(inside);
      const fresh = new Map<string, number[]>();
      for (const [name, list] of hits) {
        const done = stroke.done.get(name) ?? new Set<number>();
        const added = list.filter((triangle) => !done.has(triangle));
        added.forEach((triangle) => done.add(triangle));
        stroke.done.set(name, done);
        if (added.length) fresh.set(name, added);
      }
      if (fresh.size) commandRef.current({ kind: "box", hits: fresh, mode: stroke.mode, stroke: stroke.id });
    };
    const handlePointerDown = (event: PointerEvent) => {
      if (event.button === 0) leftDown = { x: event.clientX, y: event.clientY };
      if (event.button === 2) rightDown = { x: event.clientX, y: event.clientY };
      if (event.button !== 0) return;
      const point = localPoint(event);
      if (toolsRef.current.tool === "box") {
        box = { startX: point.x, startY: point.y, endX: point.x, endY: point.y };
        renderer.domElement.setPointerCapture(event.pointerId);
        drawMarquee();
      } else if (toolsRef.current.tool === "brush") {
        // The camera can't move during a stroke, so the visible-triangle buffer is rendered once.
        strokes += 1;
        stroke = { id: strokes, buffer: toolsRef.current.xray ? null : renderPickBuffer(), mode: event.ctrlKey || event.metaKey ? "remove" : "add", done: new Map() };
        renderer.domElement.setPointerCapture(event.pointerId);
        paint(point);
      }
    };
    const handlePointerMove = (event: PointerEvent) => {
      hover = { x: event.clientX, y: event.clientY };
      const point = localPoint(event);
      drawBrush(point);
      if (stroke) paint(point);
      if (!box) return;
      box.endX = point.x; box.endY = point.y;
      drawMarquee();
    };
    const handlePointerUp = (event: PointerEvent) => {
      if (event.button !== 0) return;
      if (stroke) { stroke = null; return; }
      if (!box) return;
      const finished = box; box = null; drawMarquee();
      // A box this small was a click; the click handler picks the triangle.
      if (Math.abs(finished.endX - finished.startX) <= DRAG_THRESHOLD && Math.abs(finished.endY - finished.startY) <= DRAG_THRESHOLD) return;
      const rect = { left: Math.min(finished.startX, finished.endX), right: Math.max(finished.startX, finished.endX), top: Math.min(finished.startY, finished.endY), bottom: Math.max(finished.startY, finished.endY) };
      const mode: SelectMode = event.shiftKey ? "add" : event.ctrlKey || event.metaKey ? "remove" : "replace";
      const inside = (x: number, y: number) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
      if (toolsRef.current.xray) { commandRef.current({ kind: "box", hits: trianglesThrough(inside), mode }); return; }
      const buffer = renderPickBuffer();
      commandRef.current({ kind: "box", hits: buffer ? pickBufferHits(buffer, rect, () => true) : new Map(), mode });
    };
    const handlePointerLeave = () => { hover = null; drawBrush(null); };
    // Shift+wheel sizes the brush. Caught on the way down, before OrbitControls zooms with it.
    const handleWheel = (event: WheelEvent) => {
      if (event.target !== renderer.domElement || toolsRef.current.tool !== "brush" || !event.shiftKey) return;
      event.preventDefault(); event.stopPropagation();
      // With Shift held, some browsers report the wheel as horizontal scrolling.
      const delta = event.deltaY || event.deltaX;
      brushRadius = Math.round(Math.min(BRUSH_MAX, Math.max(BRUSH_MIN, brushRadius * (delta > 0 ? 0.9 : 1.1))));
      try { localStorage.setItem(BRUSH_RADIUS_KEY, String(brushRadius)); } catch { /* storage unavailable */ }
      drawBrush(localPoint(event));
    };

    /** X-ray: every visible triangle whose center lands inside the area on screen, in front of or behind others. */
    const trianglesThrough = (inside: (x: number, y: number) => boolean) => {
      const runtime = runtimeRef.current!;
      const width = Math.max(renderer.domElement.clientWidth, 1); const height = Math.max(renderer.domElement.clientHeight, 1);
      const hits = new Map<string, number[]>();
      const point = new THREE.Vector3();
      for (const [object, parsed] of objectsRef.current) {
        const faceMap = faceMapsRef.current.get(object); if (!faceMap) continue;
        object.updateWorldMatrix(true, false);
        const found: number[] = [];
        for (const triangle of faceMap) {
          const a = parsed.indices[triangle * 3] * 3, b = parsed.indices[triangle * 3 + 1] * 3, c = parsed.indices[triangle * 3 + 2] * 3;
          const p = parsed.positions;
          point.set((p[a] + p[b] + p[c]) / 3, (p[a + 1] + p[b + 1] + p[c + 1]) / 3, (p[a + 2] + p[b + 2] + p[c + 2]) / 3).applyMatrix4(object.matrixWorld).project(runtime.camera);
          if (point.z >= -1 && point.z <= 1 && inside((point.x + 1) / 2 * width, (1 - point.y) / 2 * height)) found.push(triangle);
        }
        if (found.length) hits.set(parsed.name, found);
      }
      return hits;
    };
    /** Renders every visible triangle in a flat color that encodes its number (see PICK_VERTEX_SHADER)
     *  and reads the whole frame back, so only what the camera actually sees gets picked. */
    const renderPickBuffer = (): PickBuffer | null => {
      const runtime = runtimeRef.current!;
      const canvas = renderer.domElement;
      const pickScene = new THREE.Scene();
      const ranges: PickBuffer["ranges"] = [];
      let nextId = 1;
      for (const [object, parsed] of objectsRef.current) {
        const faceMap = faceMapsRef.current.get(object); if (!faceMap?.length) continue;
        const positions = new Float32Array(faceMap.length * 9);
        const colors = new Uint8Array(faceMap.length * 9);
        for (let face = 0; face < faceMap.length; face += 1) {
          const id = nextId + face;
          for (let corner = 0; corner < 3; corner += 1) {
            const vertex = parsed.indices[faceMap[face] * 3 + corner];
            const at = (face * 3 + corner) * 3;
            positions[at] = parsed.positions[vertex * 3]; positions[at + 1] = parsed.positions[vertex * 3 + 1]; positions[at + 2] = parsed.positions[vertex * 3 + 2];
            colors[at] = id & 0xff; colors[at + 1] = (id >> 8) & 0xff; colors[at + 2] = (id >> 16) & 0xff;
          }
        }
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
        geometry.setAttribute("pickColor", new THREE.BufferAttribute(colors, 3, true));
        const mesh = new THREE.Mesh(geometry, runtime.pickMaterial);
        object.updateWorldMatrix(true, false);
        mesh.matrixAutoUpdate = false; mesh.matrix.copy(object.matrixWorld); mesh.matrixWorldNeedsUpdate = true;
        pickScene.add(mesh);
        ranges.push({ name: parsed.name, faceMap, start: nextId });
        nextId += faceMap.length;
      }
      if (!ranges.length) return null;
      const target = new THREE.WebGLRenderTarget(canvas.width, canvas.height);
      const clearColor = renderer.getClearColor(new THREE.Color()); const clearAlpha = renderer.getClearAlpha();
      renderer.setRenderTarget(target); renderer.setClearColor(0x000000, 1);
      renderer.render(pickScene, runtime.camera);
      renderer.setRenderTarget(null); renderer.setClearColor(clearColor, clearAlpha);
      const pixels = new Uint8Array(canvas.width * canvas.height * 4);
      renderer.readRenderTargetPixels(target, 0, 0, canvas.width, canvas.height, pixels);
      target.dispose();
      for (const child of pickScene.children) (child as THREE.Mesh).geometry.dispose();
      return { pixels, width: canvas.width, height: canvas.height, ratio: canvas.width / Math.max(canvas.clientWidth, 1), ranges };
    };
    /** The triangles the buffer shows inside a CSS-pixel rectangle, among the pixels `inside` keeps. */
    const pickBufferHits = (buffer: PickBuffer, rect: BoxRect, inside: (x: number, y: number) => boolean) => {
      const ids = new Set<number>();
      const x0 = Math.max(0, Math.floor(rect.left * buffer.ratio)), x1 = Math.min(buffer.width, Math.ceil(rect.right * buffer.ratio));
      const y0 = Math.max(0, Math.floor(rect.top * buffer.ratio)), y1 = Math.min(buffer.height, Math.ceil(rect.bottom * buffer.ratio));
      for (let y = y0; y < y1; y += 1) {
        // Render-target rows count from the bottom.
        const row = (buffer.height - 1 - y) * buffer.width;
        for (let x = x0; x < x1; x += 1) {
          if (!inside((x + 0.5) / buffer.ratio, (y + 0.5) / buffer.ratio)) continue;
          const at = (row + x) * 4;
          const id = buffer.pixels[at] | (buffer.pixels[at + 1] << 8) | (buffer.pixels[at + 2] << 16);
          if (id) ids.add(id);
        }
      }
      const hits = new Map<string, number[]>();
      for (const id of ids) {
        const range = buffer.ranges.find((item) => id >= item.start && id < item.start + item.faceMap.length);
        if (!range) continue;
        const list = hits.get(range.name) ?? []; list.push(range.faceMap[id - range.start]); hits.set(range.name, list);
      }
      return hits;
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT")) return;
      const run = (command: TriangleCommand) => { event.preventDefault(); commandRef.current(command); };
      const ctrl = event.ctrlKey || event.metaKey;
      const { delimitShader: delimit, similarScope: scope } = toolsRef.current;
      if (event.key === "Escape") {
        if (box) { box = null; drawMarquee(); } else if (stroke) stroke = null; else setTool("none");
        return;
      }
      // event.code, not event.key: Alt and Shift change the character the key types.
      if (ctrl) {
        if (event.code === "KeyI") run({ kind: "invert" });
        else if (event.code === "KeyL") run({ kind: "grow", delimitShader: delimit });
        return;
      }
      if (event.code === "KeyA") run(event.altKey ? { kind: "clear" } : { kind: "all" });
      else if (event.code === "KeyH") run(event.altKey ? { kind: "reveal" } : event.shiftKey ? { kind: "isolate" } : { kind: "hide" });
      else if (event.code === "KeyG" && event.shiftKey && !event.altKey) run({ kind: "similar", scope });
      else if (event.code === "KeyB" && !event.altKey && !event.shiftKey && !event.repeat) { event.preventDefault(); setTool((current) => current === "box" ? "none" : "box"); }
      else if (event.code === "KeyC" && !event.altKey && !event.shiftKey && !event.repeat) { event.preventDefault(); setTool((current) => current === "brush" ? "none" : "brush"); }
      else if (event.code === "KeyL" && !event.altKey && hover) {
        const hit = hitAt(hover.x, hover.y);
        if (hit) run({ kind: "linked", meshName: hit.parsed.name, triangle: hit.triangle, deselect: event.shiftKey, delimitShader: delimit });
      }
    };
    renderer.domElement.addEventListener("click", handleClick);
    renderer.domElement.addEventListener("dblclick", handleDoubleClick);
    renderer.domElement.addEventListener("pointerdown", handlePointerDown);
    renderer.domElement.addEventListener("pointermove", handlePointerMove);
    renderer.domElement.addEventListener("pointerup", handlePointerUp);
    renderer.domElement.addEventListener("pointerleave", handlePointerLeave);
    window.addEventListener("wheel", handleWheel, { capture: true, passive: false });
    renderer.domElement.addEventListener("contextmenu", handleContextMenu);
    window.addEventListener("keydown", handleKeyDown);

    let frame = 0;
    const render = () => {
      frame = requestAnimationFrame(render);
      const runtime = runtimeRef.current; if (!runtime) return;
      runtime.controls.update();
      runtime.renderer.render(runtime.scene, runtime.camera);
    };
    render();
    return () => {
      unregisterDiagnostics();
      cancelAnimationFrame(frame); observer.disconnect(); controls.dispose();
      renderer.domElement.removeEventListener("click", handleClick);
      renderer.domElement.removeEventListener("dblclick", handleDoubleClick);
      renderer.domElement.removeEventListener("pointerdown", handlePointerDown);
      renderer.domElement.removeEventListener("pointermove", handlePointerMove);
      renderer.domElement.removeEventListener("pointerup", handlePointerUp);
      renderer.domElement.removeEventListener("pointerleave", handlePointerLeave);
      window.removeEventListener("wheel", handleWheel, { capture: true });
      renderer.domElement.removeEventListener("contextmenu", handleContextMenu);
      window.removeEventListener("keydown", handleKeyDown);
      for (const child of modelGroup.children) disposePieceObject(child as THREE.Mesh);
      clearPieceMaps();
      edgesMaterial.dispose(); selectionMaterial.dispose(); pickMaterial.dispose(); uvChecker.dispose();
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
      disposePieceObject(child as THREE.Mesh);
    }
    clearPieceMaps();
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
      // A copy: applyHidden rewrites it in place, and parsed.indices is the piece's own numbering.
      geometry.setIndex(new THREE.BufferAttribute(parsed.indices.slice(), 1));
      geometry.computeBoundingSphere();
      const material = new THREE.MeshStandardMaterial({ vertexColors: !uvChecker, map: uvChecker ? runtime.uvChecker : null, transparent: true, wireframe: renderMode === "wireframe", roughness: 0.7, metalness: 0.05, side: THREE.DoubleSide });
      const object = new THREE.Mesh(geometry, material);
      object.userData.source = parsed.name;
      const position = document ? anchorWorldPosition(document, parsed.anchorIndex ?? 0, "a2") : [0, 0, 0];
      object.position.set(position[0], position[1], position[2]);
      if (document) applyAnchorRotation(object, document, parsed.anchorIndex ?? 0);
      runtime.modelGroup.add(object);
      objectsRef.current.set(object, parsed);
      applyHidden(object, parsed);
      applySelection(object, parsed);
    }
    if (!fittedRef.current && visible.length) { fittedRef.current = true; requestAnimationFrame(fitCamera); }
    // getColor, renderMode and uvChecker are intentionally left out of the deps below: this effect only needs
    // to seed colors/wireframe state at build time, and the effects below update existing
    // objects in place on every subsequent change, without rebuilding geometry. The same goes for
    // the hidden and selected triangles, read through their refs.
  }, [document, fitCamera, visible]);

  useEffect(() => {
    for (const [object, parsed] of objectsRef.current) {
      // Only pieces whose hidden flags changed get their index and edges rewritten.
      if (appliedHiddenRef.current.get(object) === flagsOf(hiddenTriangles, parsed)) continue;
      applyHidden(object as THREE.Mesh, parsed);
    }
    // applyHidden reads the flags through hiddenRef, already current when this runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hiddenTriangles]);

  useEffect(() => {
    for (const [object, parsed] of objectsRef.current) applySelection(object as THREE.Mesh, parsed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTriangles, hiddenTriangles]);

  useEffect(() => {
    const runtime = runtimeRef.current; if (!runtime) return;
    // With the Box or Brush tool the left button selects, so orbiting moves to the middle button
    // (Blender's own); right-drag still pans and the wheel still zooms.
    const selecting = tool !== "none";
    runtime.controls.mouseButtons.LEFT = selecting ? null : THREE.MOUSE.ROTATE;
    runtime.controls.mouseButtons.MIDDLE = selecting ? THREE.MOUSE.ROTATE : THREE.MOUSE.DOLLY;
    if (tool !== "brush" && brushRef.current) brushRef.current.hidden = true;
  }, [tool]);

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
    for (const edges of edgesRef.current.values()) edges.visible = showEdges;
  }, [renderMode]);

  useEffect(() => {
    const runtime = runtimeRef.current; if (!runtime) return;
    for (const object of objectsRef.current.keys()) {
      const material = (object as THREE.Mesh).material as THREE.MeshStandardMaterial;
      material.vertexColors = !uvChecker; material.map = uvChecker ? runtime.uvChecker : null; material.needsUpdate = true;
    }
  }, [uvChecker]);

  return <section className="viewer-pane mesh-editor-3d">
    <header className="viewer-header"><div><p className="eyebrow">{tr("SHADER MAP")}</p><strong>{tr("Triangle picking · shader colors")}</strong></div><div className="viewer-tools"><button disabled={!canUndo} onClick={onUndo} title={tr("Undo")}>{tr("↶ Undo")}</button><button disabled={!canRedo} onClick={onRedo} title={tr("Redo")}>{tr("↷ Redo")}</button></div></header>
    {/* Two rows so what moves the camera or changes the look is never mixed with what selects. */}
    <div className="view-controls mesh-toolbar">
      <div className="mesh-toolbar-row">
        <span className="mesh-toolbar-label">{tr("VIEW")}</span>
        <button onClick={() => applyView("front")}>{tr("Front")}</button>
        <button onClick={() => applyView("back")}>{tr("Back")}</button>
        <button onClick={() => applyView("left")}>{tr("Left")}</button>
        <button onClick={() => applyView("right")}>{tr("Right")}</button>
        <button onClick={() => applyView("top")}>{tr("Top")}</button>
        <button onClick={() => applyView("bottom")}>{tr("Bottom")}</button>
        <i />
        <button className={projection === "orthographic" ? "active" : ""} onClick={toggleProjection}>{projection === "orthographic" ? tr("Ortho") : tr("Persp")}</button>
        <i />
        <button className={renderMode !== "solid" ? "active" : ""} onClick={cycleRenderMode} title={tr("Cycle shading mode")}>{renderMode === "solid" ? tr("Solid") : renderMode === "wireframe" ? tr("Wireframe") : tr("Solid+Wire")}</button>
        <button className={uvChecker ? "active" : ""} onClick={() => setUvChecker((current) => !current)} title={tr("Show a numbered test texture on the UVs instead of the shader colors")}>{tr("UV Checker")}</button>
        <i />
        <button onClick={fitCamera}>{tr("Frame model")}</button>
      </div>
      <div className="mesh-toolbar-row selection-tools">
        <span className="mesh-toolbar-label">{tr("SELECT")}</span>
        <button className={tool === "box" ? "active" : ""} onClick={() => setTool((current) => current === "box" ? "none" : "box")} title={tr("Box select (B): left-drag draws a box, Shift adds, Ctrl removes. Orbit with the middle button meanwhile; Esc leaves the tool.")}>{tr("Box")}</button>
        <button className={tool === "brush" ? "active" : ""} onClick={() => setTool((current) => current === "brush" ? "none" : "brush")} title={tr("Brush select (C): left-drag paints the selection, Ctrl-drag removes. Shift+wheel resizes the circle; orbit with the middle button meanwhile; Esc leaves the tool.")}>{tr("Brush")}</button>
        <button className={xray ? "active" : ""} onClick={() => setXray((current) => !current)} title={tr("X-ray: the box and the brush also take the triangles behind others, not only what you see")}>{tr("X-ray")}</button>
        <i />
        <button onClick={() => onTriangleCommand({ kind: "all" })} title={tr("Select every visible triangle (A)")}>{tr("All")}</button>
        <button onClick={() => onTriangleCommand({ kind: "clear" })} title={tr("Clear the selection (Alt+A)")}>{tr("None")}</button>
        <button onClick={() => onTriangleCommand({ kind: "invert" })} title={tr("Invert the selection among the visible triangles (Ctrl+I)")}>{tr("Invert")}</button>
        <i />
        <button onClick={() => onTriangleCommand({ kind: "grow", delimitShader })} title={tr("Grow the selection to the triangles connected to it by the geometry (Ctrl+L). L selects the connected triangles under the cursor, Shift+L deselects them.")}>{tr("Linked")}</button>
        <button className={delimitShader ? "active" : ""} onClick={() => setDelimitShader((current) => !current)} title={tr("Linked stops where the shader changes, so it only takes the connected patch of the same shader. Off: it follows the geometry across every shader.")}>{tr("Stop at shader")}</button>
        <i />
        <button onClick={() => onTriangleCommand({ kind: "similar", scope: similarScope })} title={tr("Select every triangle with the same shader as the selection, connected or not (Shift+G)")}>{tr("Same shader")}</button>
        <span className="segmented" role="group">
          <button className={similarScope === "part" ? "active" : ""} onClick={() => setSimilarScope("part")} title={tr("Same shader looks only in the parts that already have something selected")}>{tr("This part")}</button>
          <button className={similarScope === "all" ? "active" : ""} onClick={() => setSimilarScope("all")} title={tr("Same shader looks in every visible part")}>{tr("All parts")}</button>
        </span>
        <i />
        <button onClick={() => onTriangleCommand({ kind: "hide" })} title={tr("Hide the selected triangles (H). View only — the file doesn't change.")}>{tr("Hide")}</button>
        <button onClick={() => onTriangleCommand({ kind: "isolate" })} title={tr("Hide everything except the selection (Shift+H)")}>{tr("Isolate")}</button>
        <button onClick={() => onTriangleCommand({ kind: "reveal" })} title={tr("Show every hidden triangle again (Alt+H)")}>{tr("Reveal")}</button>
        <i />
        {/* The one control here that changes the file, set apart at the end. */}
        <AssignShaderMenu bank={shaderBank} used={selectedPartShaders} selectedCount={selectedCount} getColor={getColor} onPick={onAssignShader} />
      </div>
    </div>
    <div className={`viewer-stage ${tool !== "none" ? "select-tool" : ""}`} ref={hostRef}>
      <div className="selection-marquee" ref={marqueeRef} hidden />
      <div className="selection-brush" ref={brushRef} hidden />
      {!visible.length && <div className="viewer-empty"><span>3D</span><strong>{tr("No visible geometry")}</strong><p>{tr("Show some parts in the pieces list to see them colored by shader here.")}</p></div>}
      <div className="viewer-stats"><span><Tx t="{0} parts" v={[visible.length]} /></span><span><Tx t="{0} tris" v={[visibleTriangleCount.toLocaleString()]} /></span><span><Tx t="{0} shaders" v={[shaderLegend.length]} /></span>{selectedCount > 0 && <span className="stat-selected"><Tx t="{0} selected in {1} parts" v={[selectedCount.toLocaleString(), selectedPieces]} /></span>}{hiddenCount > 0 && <span className="stat-hidden"><Tx t="{0} hidden" v={[hiddenCount.toLocaleString()]} /></span>}</div>
      <div className="shader-legend">{shaderLegend.map((id) => <ShaderChip key={id} id={id} name={shaderBank?.[id]?.name ?? ""} rgba={getColor(id)} active={selection?.shaderId === id} onRgbChange={(value) => setShaderRgb(id, value)} onAlphaChange={(value) => setShaderAlpha(id, value)} onSelectTriangles={(deselect) => onTriangleCommand({ kind: "shader", shaderId: id, deselect })} />)}</div>
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
    <footer className="viewer-footer"><span>{tr("Click a triangle to identify its piece + shader")}</span><span>{tr("Shift-click adds · L linked · Shift+G same shader · B box · C brush · H hide")}</span><span>{tr("Right-click for piece actions")}</span><span>{tool !== "none" ? tr("Middle-drag to orbit") : tr("Drag to orbit")}</span><span>{tr("Wheel to zoom")}</span></footer>
  </section>;
}
