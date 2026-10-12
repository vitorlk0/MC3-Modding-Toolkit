import { tr, Tx } from "./i18n";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import type { PckDocument, Vec3 } from "../src/pck";
import { anchorWorldPosition, nearestMeshAnchor, type MeshGeometry } from "../src/mesh";
import { applyAnchorRotation } from "./anchor-rotation";
import type { PpfGeometry, PpfKind } from "../src/ppf";

type ActiveCamera = THREE.PerspectiveCamera | THREE.OrthographicCamera;
type ViewDirection = "front" | "back" | "left" | "right" | "top" | "bottom";
type Projection = "perspective" | "orthographic";
type GizmoSpace = "world" | "local";

export type CameraHandle = "camera" | "target";
export type ShopCameraPoints = { camera: Vec3; target: Vec3 };
/** A garage shop camera being edited, in the car PCK space the viewer draws in. */
export type CameraEdit = ShopCameraPoints & {
  handle: CameraHandle;
  lookThrough: boolean;
  /** Draws the red focus plane at the target. */
  targetPlane: boolean;
  /** Marks where the shop's own UI covers the frame, in the view through the camera. */
  safeAreas: boolean;
  /** Game field of view in degrees and the screen shape to preview it at. */
  fov: number;
  aspect: number;
  onSelectHandle(handle: CameraHandle): void;
  onToggleLookThrough(): void;
  /** "preview" while dragging (not recorded), "commit" once at the end with where it started. */
  onMove(next: ShopCameraPoints, mode: "preview" | "commit", start?: ShopCameraPoints): void;
};
// CameraFOV in garage.garageshared is the vertical angle of a 4:3 frame (three.js convention).
// Checked against an in-game shot of the VIP Mustang's RearBumper camera: the rear bumper spans
// 51.6% of the frame width in game and 50.5% in this preview at 4:3; as a horizontal angle, or at
// 16:9, it would be far off. A 16:9 PCSX2 window just stretches that 4:3 frame.
const verticalFov = (fov: number) => fov;
const GIZMO_SPACE_KEY = "mc3pae.gizmoSpace";
// Share of the frame height the Body Shop UI covers, full width: title, "N OF M", brand and price on
// top; money and the button row at the bottom. Measured on an in-game shot (VIP Mustang, Front
// Bumpers): top band down to 34.4%, bottom band from 79.4%. A widescreen patch may lay it out differently.
const GAME_UI_TOP = 0.344;
const GAME_UI_BOTTOM = 0.206;
const round6 = (value: number) => Math.round(value * 1e6) / 1e6;
const toVec = (vector: THREE.Vector3): Vec3 => [round6(vector.x), round6(vector.y), round6(vector.z)];
/** Orientation of a camera at `from` looking at `to`, Y up, no roll — the shop camera's own axes. */
function lookQuaternion(from: Vec3, to: Vec3) {
  const matrix = new THREE.Matrix4().lookAt(new THREE.Vector3(...from), new THREE.Vector3(...to), new THREE.Vector3(0, 1, 0));
  return new THREE.Quaternion().setFromRotationMatrix(matrix);
}

type ViewerRuntime = {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  perspectiveCamera: THREE.PerspectiveCamera;
  orthographicCamera: THREE.OrthographicCamera;
  camera: ActiveCamera;
  controls: OrbitControls;
  transformControls: TransformControls;
  gizmoTarget: THREE.Object3D;
  modelGroup: THREE.Group;
  markerGroup: THREE.Group;
  grid: THREE.GridHelper;
  material: THREE.MeshStandardMaterial;
  selectedMaterial: THREE.MeshStandardMaterial;
  edgesMaterial: THREE.LineBasicMaterial;
  referenceMaterials: Record<PpfKind, THREE.MeshStandardMaterial>;
  markerA1: THREE.Mesh;
  markerA2: THREE.Mesh;
  cameraGroup: THREE.Group;
  shopCamera: THREE.PerspectiveCamera;
  shopHelper: THREE.CameraHelper;
  cameraMarker: THREE.Mesh;
  targetMarker: THREE.Mesh;
  cameraLine: THREE.Line;
  targetPlane: THREE.Group;
};

type ReferencePlacement = { kind: PpfKind; geometry: PpfGeometry; anchorIndex: number };

const INCHES_TO_METERS = 0.0254;
function referenceScale(placement: ReferencePlacement, rimSizeInches: number) {
  if (placement.kind === "exhaust") return 1;
  const diameter = Math.max(
    placement.geometry.boundsMax[1] - placement.geometry.boundsMin[1],
    placement.geometry.boundsMax[2] - placement.geometry.boundsMin[2],
  );
  return diameter > 1e-6 ? rimSizeInches * INCHES_TO_METERS / diameter : 1;
}
// The exhaust anchor sits correctly for game logic, but the placeholder PPF model's own origin
// isn't exactly at its mounting point, so placing it exactly at the anchor reads slightly too far
// forward in the preview. +Z is rearward in this coordinate system (confirmed against front/rear
// bumper anchors) — purely a preview nudge, never touches anchor data.
const EXHAUST_TIP_VISUAL_OFFSET_Z = -0.442;
// Same idea for wheels: the placeholder rim/tire models aren't centered on their own origin, so
// placing them exactly at the wheel anchor reads as offset inward. whl_0/whl_2 are the left-side
// slots, whl_1/whl_3 are right-side — nudge each outward along X. Preview-only, never touches
// anchor data.
const WHEEL_X_VISUAL_OFFSET = 0.06;
function wheelVisualOffsetX(document: PckDocument, anchorIndex: number) {
  const slot = document.wheelLinks.get(anchorIndex);
  // A two-wheeler's wheels sit on the centreline; there is no outward side to nudge towards.
  if (slot === undefined || document.wheelSlots.length !== 4) return 0;
  return slot === 0 || slot === 2 ? WHEEL_X_VISUAL_OFFSET : -WHEEL_X_VISUAL_OFFSET;
}
function referenceWorldPosition(document: PckDocument, placement: ReferencePlacement) {
  const position = anchorWorldPosition(document, placement.anchorIndex, "a2");
  if (placement.kind === "exhaust") position[2] += EXHAUST_TIP_VISUAL_OFFSET_Z;
  if (placement.kind === "rim" || placement.kind === "tire") position[0] += wheelVisualOffsetX(document, placement.anchorIndex);
  return position;
}
const VIEW_OFFSETS: Record<ViewDirection, THREE.Vector3> = {
  front: new THREE.Vector3(0, 0, -1),
  back: new THREE.Vector3(0, 0, 1),
  left: new THREE.Vector3(-1, 0, 0),
  right: new THREE.Vector3(1, 0, 0),
  top: new THREE.Vector3(0, 1, 0),
  bottom: new THREE.Vector3(0, -1, 0),
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
const round5 = (value: number) => Math.round(value * 100000) / 100000;

export function MeshViewer({ document, selected, multiSelected, meshes, visibleAnchors, referenceGeometry, rimSizeInches, revision, onMoveSelection, cameraEdit = null }: { document: PckDocument; selected: number; multiSelected: Set<number>; meshes: MeshGeometry[]; visibleAnchors: Set<number>; referenceGeometry: Partial<Record<PpfKind, PpfGeometry>>; rimSizeInches: number; revision: number; onMoveSelection(moves: { index: number; value: Vec3 }[], mode: "preview" | "scrub-commit", startMoves?: { index: number; value: Vec3 }[]): void; cameraEdit?: CameraEdit | null }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<ViewerRuntime | null>(null);
  const objectsRef = useRef(new Map<MeshGeometry, THREE.Mesh>());
  const referenceObjectsRef = useRef<{ placement: ReferencePlacement; object: THREE.Mesh }[]>([]);
  const fittedRef = useRef(false);
  const lastMeshSetRef = useRef<string | null>(null);
  const lastReferenceSetRef = useRef<typeof referenceGeometry | null>(null);
  const dragRef = useRef<{ anchors: { index: number; start: Vec3 }[]; startWorld: THREE.Vector3 } | null>(null);
  // A gizmo drag of a shop camera point, and an orbit/zoom/pan while looking through the camera.
  const cameraDragRef = useRef<{ start: ShopCameraPoints; handle: CameraHandle; startWorld: THREE.Vector3 } | null>(null);
  const orbitStartRef = useRef<ShopCameraPoints | null>(null);
  // Read by the render loop and the orbit listeners, which outlive any one render.
  const lookThroughRef = useRef({ active: false, aspect: 4 / 3, savedTarget: new THREE.Vector3() });
  const latestRef = useRef({ document, multiSelected, onMoveSelection, cameraEdit });
  const edgesRef = useRef<THREE.LineSegments[]>([]);
  const [gridVisible, setGridVisible] = useState(true);
  const [renderMode, setRenderMode] = useState<"solid" | "wireframe" | "solid-wire">("solid");
  const [projection, setProjection] = useState<Projection>("perspective");
  const [gizmoVisible, setGizmoVisible] = useState(true);
  const [gizmoSpace, setGizmoSpace] = useState<GizmoSpace>(() => { try { return localStorage.getItem(GIZMO_SPACE_KEY) === "local" ? "local" : "world"; } catch { return "world"; } });
  useEffect(() => { try { localStorage.setItem(GIZMO_SPACE_KEY, gizmoSpace); } catch { /* storage unavailable */ } }, [gizmoSpace]);
  useEffect(() => { latestRef.current = { document, multiSelected, onMoveSelection, cameraEdit }; });
  const lookingThrough = Boolean(cameraEdit?.lookThrough);
  const visible = useMemo(() => meshes.filter((mesh) => mesh.anchorIndex !== null && visibleAnchors.has(mesh.anchorIndex)), [meshes, visibleAnchors]);
  const referencePlacements = useMemo(() => {
    const output: ReferencePlacement[] = [];
    const wheelAnchors = [...document.wheelLinks.keys()];
    if (referenceGeometry.rim) for (const anchorIndex of wheelAnchors) output.push({ kind: "rim", geometry: referenceGeometry.rim, anchorIndex });
    if (referenceGeometry.tire) for (const anchorIndex of wheelAnchors) output.push({ kind: "tire", geometry: referenceGeometry.tire, anchorIndex });
    if (referenceGeometry.exhaust && document.exhaustLinks.has(selected)) output.push({ kind: "exhaust", geometry: referenceGeometry.exhaust, anchorIndex: selected });
    return output;
  }, [document, referenceGeometry, selected]);
  const highlightedAnchors = useMemo(() => {
    const set = new Set<number>();
    for (const index of multiSelected) { const nearest = nearestMeshAnchor(document, index, meshes); if (nearest !== null) set.add(nearest); }
    return set;
  }, [document, meshes, multiSelected]);
  const triangleCount = useMemo(() => visible.reduce((sum, mesh) => sum + mesh.triangles, 0), [visible]);
  const referenceTriangleCount = useMemo(() => referencePlacements.reduce((sum, item) => sum + item.geometry.triangles, 0), [referencePlacements]);

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
    // The orbit controls drive the shop camera while looking through it; a preset view is a
    // request for the editor's own camera back.
    if (lookThroughRef.current.active) { latestRef.current.cameraEdit?.onToggleLookThrough(); return; }
    const target = runtime.controls.target.clone();
    const distance = Math.max(runtime.camera.position.distanceTo(target), 0.5);
    runtime.camera.up.copy(VIEW_UP[direction]);
    runtime.camera.position.copy(target).addScaledVector(VIEW_OFFSETS[direction], distance);
    runtime.camera.lookAt(target);
    runtime.controls.update();
  }, []);

  const toggleProjection = useCallback(() => { setProjection((current) => current === "perspective" ? "orthographic" : "perspective"); }, []);
  const toggleGizmo = useCallback(() => { setGizmoVisible((value) => !value); }, []);
  const toggleGizmoSpace = useCallback(() => { setGizmoSpace((value) => value === "local" ? "world" : "local"); }, []);

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
    renderer.shadowMap.enabled = false;
    renderer.domElement.className = "viewer-canvas";
    host.appendChild(renderer.domElement);
    const controls = new OrbitControls(perspectiveCamera, renderer.domElement);
    controls.enableDamping = true; controls.dampingFactor = 0.08; controls.screenSpacePanning = true; controls.minDistance = 0.25; controls.maxDistance = 80;
    const modelGroup = new THREE.Group(); const markerGroup = new THREE.Group(); scene.add(modelGroup, markerGroup);
    const grid = new THREE.GridHelper(20, 40, 0x4a5c36, 0x222a23); grid.position.y = 0; scene.add(grid);
    const axes = new THREE.AxesHelper(0.65); axes.position.set(-0.01, 0.01, -0.01); scene.add(axes);
    scene.add(new THREE.HemisphereLight(0xdce8d8, 0x151915, 2.1));
    const key = new THREE.DirectionalLight(0xffffff, 2.8); key.position.set(4, 7, 5); scene.add(key);
    const rim = new THREE.DirectionalLight(0xa1e304, 1.15); rim.position.set(-5, 3, -4); scene.add(rim);
    const material = new THREE.MeshStandardMaterial({ color: 0x9da69d, roughness: 0.72, metalness: 0.08, side: THREE.DoubleSide });
    const selectedMaterial = new THREE.MeshStandardMaterial({ color: 0xb5beb4, roughness: 0.65, metalness: 0.1, side: THREE.DoubleSide });
    const edgesMaterial = new THREE.LineBasicMaterial({ color: 0x000000 });
    const referenceMaterials: Record<PpfKind, THREE.MeshStandardMaterial> = {
      exhaust: new THREE.MeshStandardMaterial({ color: 0xaab3ad, roughness: 0.38, metalness: 0.62, side: THREE.DoubleSide }),
      rim: new THREE.MeshStandardMaterial({ color: 0x87938c, roughness: 0.46, metalness: 0.48, side: THREE.DoubleSide }),
      tire: new THREE.MeshStandardMaterial({ color: 0x242a26, roughness: 0.94, metalness: 0.02, side: THREE.DoubleSide }),
    };
    const markerGeometry = new THREE.SphereGeometry(0.055, 18, 12);
    const markerA1 = new THREE.Mesh(markerGeometry, new THREE.MeshBasicMaterial({ color: 0xa1e304 }));
    const markerA2 = new THREE.Mesh(markerGeometry.clone(), new THREE.MeshBasicMaterial({ color: 0x6cc7b9, transparent: true, opacity: 0.82 }));
    markerGroup.add(markerA1, markerA2);

    // Shop camera: a frustum out to the look-at distance, a line to the target, and a marker at each
    // end. The camera marker is a little box so the two read apart at a glance.
    const cameraGroup = new THREE.Group(); cameraGroup.visible = false; scene.add(cameraGroup);
    const shopCamera = new THREE.PerspectiveCamera(40, 4 / 3, 0.05, 5);
    const shopHelper = new THREE.CameraHelper(shopCamera);
    shopHelper.setColors(new THREE.Color(0xf0b84a), new THREE.Color(0xf0b84a), new THREE.Color(0xf0b84a), new THREE.Color(0x7d6a3a), new THREE.Color(0x7d6a3a));
    const cameraMarker = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.11, 0.11), new THREE.MeshBasicMaterial({ color: 0xf0b84a }));
    const targetMarker = new THREE.Mesh(markerGeometry.clone(), new THREE.MeshBasicMaterial({ color: 0xf0b84a }));
    const cameraLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), new THREE.LineDashedMaterial({ color: 0xf0b84a, dashSize: 0.08, gapSize: 0.05 }));
    cameraGroup.add(shopHelper, cameraMarker, targetMarker, cameraLine);
    // Focus plane at the target, square to the line of sight (like Blender's Photographer add-on):
    // it shows where the camera aims, and where it cuts the car. Kept out of cameraGroup so it is
    // drawn in the view through the camera too; it writes no depth, so it hides nothing behind it.
    const targetPlane = new THREE.Group(); targetPlane.visible = false; scene.add(targetPlane);
    const planeGeometry = new THREE.PlaneGeometry(3, 2);
    targetPlane.add(
      new THREE.Mesh(planeGeometry, new THREE.MeshBasicMaterial({ color: 0xe0302a, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false })),
      new THREE.LineSegments(new THREE.EdgesGeometry(planeGeometry), new THREE.LineBasicMaterial({ color: 0xff4a40, transparent: true, opacity: 0.9, depthWrite: false })),
    );

    const gizmoTarget = new THREE.Object3D(); scene.add(gizmoTarget);
    const transformControls = new TransformControls(perspectiveCamera, renderer.domElement);
    transformControls.mode = "translate";
    transformControls.attach(gizmoTarget);
    const gizmoHelper = transformControls.getHelper();
    scene.add(gizmoHelper);
    const cameraMoveFrom = (start: ShopCameraPoints, handle: CameraHandle, delta: THREE.Vector3): ShopCameraPoints => {
      const moved = toVec(new THREE.Vector3(...start[handle]).add(delta));
      return handle === "camera" ? { camera: moved, target: start.target } : { camera: start.camera, target: moved };
    };
    transformControls.addEventListener("dragging-changed", (event) => {
      controls.enabled = !event.value;
      const shop = latestRef.current.cameraEdit;
      if (shop || cameraDragRef.current) {
        if (event.value && shop) cameraDragRef.current = { start: { camera: [...shop.camera], target: [...shop.target] }, handle: shop.handle, startWorld: gizmoTarget.position.clone() };
        else if (!event.value && cameraDragRef.current) {
          const { start, handle, startWorld } = cameraDragRef.current;
          cameraDragRef.current = null;
          latestRef.current.cameraEdit?.onMove(cameraMoveFrom(start, handle, gizmoTarget.position.clone().sub(startWorld)), "commit", start);
        }
        return;
      }
      if (event.value) {
        const { document: doc, multiSelected: sel } = latestRef.current;
        const anchors = [...sel].map((index) => ({ index, start: [...doc.pieces[index].a2] as Vec3 }));
        dragRef.current = { anchors, startWorld: gizmoTarget.position.clone() };
      } else if (dragRef.current) {
        const { anchors, startWorld } = dragRef.current;
        const { onMoveSelection: move } = latestRef.current;
        const delta = gizmoTarget.position.clone().sub(startWorld);
        const moves = anchors.map(({ index, start }) => ({ index, value: [round5(start[0] + delta.x), round5(start[1] + delta.y), round5(start[2] + delta.z)] as Vec3 }));
        const startMoves = anchors.map(({ index, start }) => ({ index, value: start }));
        if (moves.some((move2, i) => !move2.value.every((v, c) => Object.is(v, startMoves[i].value[c])))) move(moves, "scrub-commit", startMoves);
        dragRef.current = null;
      }
    });
    transformControls.addEventListener("objectChange", () => {
      const cameraDrag = cameraDragRef.current;
      if (cameraDrag) { latestRef.current.cameraEdit?.onMove(cameraMoveFrom(cameraDrag.start, cameraDrag.handle, gizmoTarget.position.clone().sub(cameraDrag.startWorld)), "preview"); return; }
      const drag = dragRef.current; if (!drag) return;
      const { onMoveSelection: move } = latestRef.current;
      const delta = gizmoTarget.position.clone().sub(drag.startWorld);
      const moves = drag.anchors.map(({ index, start }) => ({ index, value: [round5(start[0] + delta.x), round5(start[1] + delta.y), round5(start[2] + delta.z)] as Vec3 }));
      move(moves, "preview");
    });

    // Looking through the shop camera hands it the orbit controls: drag orbits around the target,
    // the wheel walks the camera in or out, right-drag pans both. Each gesture is one undo step.
    const shopPoints = (): ShopCameraPoints => ({ camera: toVec(shopCamera.position), target: toVec(controls.target) });
    controls.addEventListener("start", () => {
      const shop = latestRef.current.cameraEdit;
      if (lookThroughRef.current.active && shop) orbitStartRef.current = { camera: [...shop.camera], target: [...shop.target] };
    });
    controls.addEventListener("change", () => {
      if (lookThroughRef.current.active && orbitStartRef.current) latestRef.current.cameraEdit?.onMove(shopPoints(), "preview");
    });
    controls.addEventListener("end", () => {
      const start = orbitStartRef.current; orbitStartRef.current = null;
      if (lookThroughRef.current.active && start) latestRef.current.cameraEdit?.onMove(shopPoints(), "commit", start);
    });
    // Clicking the camera or target marker picks which one the gizmo moves. A drag (orbit) isn't a click.
    let pointerDown: { x: number; y: number } | null = null;
    const raycaster = new THREE.Raycaster();
    const onPointerDown = (event: PointerEvent) => { pointerDown = { x: event.clientX, y: event.clientY }; };
    const onPointerUp = (event: PointerEvent) => {
      const down = pointerDown; pointerDown = null;
      const shop = latestRef.current.cameraEdit; const runtime = runtimeRef.current;
      if (!down || !shop || !runtime || lookThroughRef.current.active || transformControls.dragging) return;
      if (Math.hypot(event.clientX - down.x, event.clientY - down.y) > 4) return;
      const rect = renderer.domElement.getBoundingClientRect();
      raycaster.setFromCamera(new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1), runtime.camera);
      const hit = raycaster.intersectObjects([cameraMarker, targetMarker], false)[0];
      if (hit) shop.onSelectHandle(hit.object === cameraMarker ? "camera" : "target");
    };
    renderer.domElement.addEventListener("pointerdown", onPointerDown);
    renderer.domElement.addEventListener("pointerup", onPointerUp);

    runtimeRef.current = { renderer, scene, perspectiveCamera, orthographicCamera, camera: perspectiveCamera, controls, transformControls, gizmoTarget, modelGroup, markerGroup, grid, material, selectedMaterial, edgesMaterial, referenceMaterials, markerA1, markerA2, cameraGroup, shopCamera, shopHelper, cameraMarker, targetMarker, cameraLine, targetPlane };
    const resize = () => {
      const width = Math.max(host.clientWidth, 1); const height = Math.max(host.clientHeight, 1);
      renderer.setSize(width, height, false);
      const aspect = width / height;
      perspectiveCamera.aspect = aspect; perspectiveCamera.updateProjectionMatrix();
      const currentHalfHeight = (orthographicCamera.top - orthographicCamera.bottom) / 2 || 5;
      orthographicCamera.left = -currentHalfHeight * aspect; orthographicCamera.right = currentHalfHeight * aspect; orthographicCamera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize); observer.observe(host); resize();
    let frame = 0;
    const render = () => {
      frame = requestAnimationFrame(render);
      const runtime = runtimeRef.current; if (!runtime) return;
      runtime.controls.update();
      const look = lookThroughRef.current;
      if (!look.active) { runtime.renderer.render(runtime.scene, runtime.camera); return; }
      // The game's frame, letterboxed to its screen shape inside whatever shape the pane has.
      const width = Math.max(host.clientWidth, 1); const height = Math.max(host.clientHeight, 1);
      const frameWidth = Math.min(width, height * look.aspect); const frameHeight = frameWidth / look.aspect;
      const x = (width - frameWidth) / 2; const y = (height - frameHeight) / 2;
      runtime.renderer.setScissorTest(false); runtime.renderer.setClearColor(0x030403, 1); runtime.renderer.clear();
      runtime.renderer.setViewport(x, y, frameWidth, frameHeight); runtime.renderer.setScissor(x, y, frameWidth, frameHeight); runtime.renderer.setScissorTest(true);
      const gizmoShown = gizmoHelper.visible;
      runtime.cameraGroup.visible = false; gizmoHelper.visible = false;
      // The shop camera's far plane sits at the target so the drawn frustum ends there; the game
      // doesn't clip there, so the view through it gets the editor camera's reach instead.
      const frustumFar = runtime.shopCamera.far;
      runtime.shopCamera.far = 200; runtime.shopCamera.updateProjectionMatrix();
      runtime.renderer.render(runtime.scene, runtime.shopCamera);
      runtime.shopCamera.far = frustumFar; runtime.shopCamera.updateProjectionMatrix();
      runtime.cameraGroup.visible = true; gizmoHelper.visible = gizmoShown;
      runtime.renderer.setScissorTest(false); runtime.renderer.setViewport(0, 0, width, height);
    };
    render();
    return () => {
      cancelAnimationFrame(frame); observer.disconnect(); controls.dispose(); transformControls.dispose();
      renderer.domElement.removeEventListener("pointerdown", onPointerDown); renderer.domElement.removeEventListener("pointerup", onPointerUp);
      shopHelper.dispose(); cameraMarker.geometry.dispose(); (cameraMarker.material as THREE.Material).dispose(); targetMarker.geometry.dispose(); (targetMarker.material as THREE.Material).dispose(); cameraLine.geometry.dispose(); (cameraLine.material as THREE.Material).dispose();
      planeGeometry.dispose(); for (const child of targetPlane.children) { ((child as THREE.Mesh).geometry as THREE.BufferGeometry).dispose(); ((child as THREE.Mesh).material as THREE.Material).dispose(); }
      for (const child of modelGroup.children) {
        (child as THREE.Mesh).geometry?.dispose();
        for (const sub of child.children) if (sub instanceof THREE.LineSegments) sub.geometry.dispose();
      }
      objectsRef.current.clear();
      referenceObjectsRef.current = [];
      edgesRef.current = [];
      markerGeometry.dispose(); (markerA1.material as THREE.Material).dispose(); markerA2.geometry.dispose(); (markerA2.material as THREE.Material).dispose();
      material.dispose(); selectedMaterial.dispose(); edgesMaterial.dispose(); Object.values(referenceMaterials).forEach((item) => item.dispose()); renderer.dispose(); renderer.domElement.remove(); runtimeRef.current = null;
    };
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
    // While looking through the shop camera the controls belong to it; they come back to the
    // editor camera, whichever projection it has by then, when that ends.
    if (!lookThroughRef.current.active) runtime.controls.object = nextCamera;
    runtime.transformControls.camera = nextCamera;
    runtime.controls.update();
  }, [projection]);

  useEffect(() => {
    const runtime = runtimeRef.current; if (!runtime) return;
    runtime.transformControls.enabled = gizmoVisible && !lookingThrough;
    runtime.transformControls.getHelper().visible = gizmoVisible && !lookingThrough;
  }, [gizmoVisible, lookingThrough]);

  // Hand the orbit controls to the shop camera and back.
  useEffect(() => {
    const runtime = runtimeRef.current; if (!runtime) return;
    const look = lookThroughRef.current;
    const shop = latestRef.current.cameraEdit;
    if (lookingThrough && shop && !look.active) {
      look.savedTarget.copy(runtime.controls.target);
      runtime.shopCamera.position.set(...shop.camera); runtime.shopCamera.up.set(0, 1, 0); runtime.shopCamera.lookAt(...shop.target);
      runtime.controls.object = runtime.shopCamera;
      runtime.controls.target.set(...shop.target);
      // Damping would keep moving the camera after a gesture ends, after its edit was committed.
      runtime.controls.enableDamping = false;
      look.active = true;
    } else if (!lookingThrough && look.active) {
      look.active = false; orbitStartRef.current = null;
      runtime.controls.object = runtime.camera;
      runtime.controls.target.copy(look.savedTarget);
      runtime.controls.enableDamping = true;
      runtime.controls.update();
    }
  }, [lookingThrough]);

  // Esc leaves the camera view; Numpad 0 enters and leaves it, like Blender.
  useEffect(() => {
    if (!cameraEdit) return;
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(input|textarea|select)$/i.test(target.tagName)) return;
      const shop = latestRef.current.cameraEdit; if (!shop) return;
      if (event.code === "Numpad0" || (event.key === "Escape" && shop.lookThrough)) { event.preventDefault(); shop.onToggleLookThrough(); }
      else if (!event.ctrlKey && !event.altKey && !event.metaKey && (event.code === "KeyC" || event.code === "KeyT")) shop.onSelectHandle(event.code === "KeyC" ? "camera" : "target");
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [cameraEdit !== null]);

  // Shop camera visuals, kept in step with the edited values (and the look-through camera with them,
  // unless a gesture of its own is what's moving it).
  useEffect(() => {
    const runtime = runtimeRef.current; if (!runtime) return;
    runtime.cameraGroup.visible = Boolean(cameraEdit);
    runtime.markerGroup.visible = !cameraEdit;
    runtime.targetPlane.visible = Boolean(cameraEdit?.targetPlane);
    if (!cameraEdit) return;
    const look = lookThroughRef.current;
    look.aspect = cameraEdit.aspect;
    const from = new THREE.Vector3(...cameraEdit.camera); const to = new THREE.Vector3(...cameraEdit.target);
    const shopCamera = runtime.shopCamera;
    shopCamera.fov = verticalFov(cameraEdit.fov); shopCamera.aspect = cameraEdit.aspect;
    shopCamera.near = 0.05; shopCamera.far = Math.max(from.distanceTo(to), 0.1);
    if (!(look.active && orbitStartRef.current)) {
      shopCamera.position.copy(from); shopCamera.up.set(0, 1, 0); shopCamera.lookAt(to);
      if (look.active) runtime.controls.target.copy(to);
    }
    shopCamera.updateProjectionMatrix(); shopCamera.updateMatrixWorld(true); runtime.shopHelper.update();
    runtime.cameraMarker.position.copy(from); runtime.cameraMarker.quaternion.copy(lookQuaternion(cameraEdit.camera, cameraEdit.target));
    runtime.targetMarker.position.copy(to);
    runtime.targetPlane.position.copy(to); runtime.targetPlane.quaternion.copy(runtime.cameraMarker.quaternion);
    runtime.cameraLine.geometry.setFromPoints([from, to]); runtime.cameraLine.computeLineDistances();
    const active = 0xffe08a; const idle = 0x9c7c3c;
    (runtime.cameraMarker.material as THREE.MeshBasicMaterial).color.setHex(cameraEdit.handle === "camera" ? active : idle);
    (runtime.targetMarker.material as THREE.MeshBasicMaterial).color.setHex(cameraEdit.handle === "target" ? active : idle);
    runtime.cameraMarker.scale.setScalar(cameraEdit.handle === "camera" ? 1.25 : 1);
    runtime.targetMarker.scale.setScalar(cameraEdit.handle === "target" ? 1.25 : 1);
  }, [cameraEdit]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(input|textarea|select)$/i.test(target.tagName)) return;
      if (event.code === "Numpad1") { event.preventDefault(); applyView(event.ctrlKey ? "back" : "front"); }
      else if (event.code === "Numpad3") { event.preventDefault(); applyView(event.ctrlKey ? "right" : "left"); }
      else if (event.code === "Numpad7") { event.preventDefault(); applyView("top"); }
      else if (event.code === "Numpad9") { event.preventDefault(); applyView("bottom"); }
      else if (event.code === "Numpad5") { event.preventDefault(); toggleProjection(); }
      else if (event.ctrlKey && event.key.toLowerCase() === "g") { event.preventDefault(); toggleGizmo(); }
      else if (event.ctrlKey && event.key.toLowerCase() === "l") { event.preventDefault(); toggleGizmoSpace(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [applyView, toggleGizmo, toggleGizmoSpace, toggleProjection]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    // Compare by piece names, not array identity — `meshes` is re-derived (new array reference)
    // on every anchor-position edit (see revision-driven useMemo in page.tsx), which would
    // otherwise make this look like a freshly loaded vehicle on every drag/scrub tick and force
    // fitCamera() to re-run continuously, chasing the piece around as it moves.
    const meshKey = meshes.map((mesh) => mesh.name).join("|");
    const newMeshSet = lastMeshSetRef.current !== meshKey || lastReferenceSetRef.current !== referenceGeometry;
    lastMeshSetRef.current = meshKey;
    lastReferenceSetRef.current = referenceGeometry;
    for (const child of [...runtime.modelGroup.children]) {
      runtime.modelGroup.remove(child);
      const mesh = child as THREE.Mesh; mesh.geometry?.dispose();
      for (const sub of child.children) if (sub instanceof THREE.LineSegments) sub.geometry.dispose();
    }
    objectsRef.current.clear();
    referenceObjectsRef.current = [];
    edgesRef.current = [];
    for (const parsed of visible) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(parsed.positions, 3));
      geometry.setAttribute("normal", new THREE.BufferAttribute(parsed.normals, 3));
      geometry.setIndex(new THREE.BufferAttribute(parsed.indices, 1));
      geometry.computeBoundingSphere();
      const isSelected = parsed.anchorIndex !== null && highlightedAnchors.has(parsed.anchorIndex);
      const object = new THREE.Mesh(geometry, isSelected ? runtime.selectedMaterial : runtime.material);
      object.userData.source = parsed.name;
      const position = anchorWorldPosition(document, parsed.anchorIndex ?? 0, "a2"); object.position.set(position[0], position[1], position[2]);
      applyAnchorRotation(object, document, parsed.anchorIndex ?? 0);
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 1), runtime.edgesMaterial);
      edges.visible = renderMode === "solid-wire";
      object.add(edges); edgesRef.current.push(edges);
      runtime.modelGroup.add(object); objectsRef.current.set(parsed, object);
    }
    for (const placement of referencePlacements) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(placement.geometry.positions, 3));
      geometry.setAttribute("normal", new THREE.BufferAttribute(placement.geometry.normals, 3));
      geometry.setIndex(new THREE.BufferAttribute(placement.geometry.indices, 1));
      geometry.computeBoundingSphere();
      const object = new THREE.Mesh(geometry, runtime.referenceMaterials[placement.kind]);
      object.userData.source = `${placement.kind}:${placement.geometry.name}`;
      object.scale.setScalar(referenceScale(placement, rimSizeInches));
      const position = referenceWorldPosition(document, placement); object.position.set(position[0], position[1], position[2]);
      runtime.modelGroup.add(object); referenceObjectsRef.current.push({ placement, object });
    }
    if ((newMeshSet || !fittedRef.current) && (visible.length || referencePlacements.length)) { fittedRef.current = true; requestAnimationFrame(fitCamera); }
  }, [document, fitCamera, meshes, referenceGeometry, referencePlacements, highlightedAnchors, visible]);

  useEffect(() => {
    for (const { placement, object } of referenceObjectsRef.current) object.scale.setScalar(referenceScale(placement, rimSizeInches));
  }, [rimSizeInches]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    for (const [parsed, object] of objectsRef.current) { const position = anchorWorldPosition(document, parsed.anchorIndex ?? 0, "a2"); object.position.set(position[0], position[1], position[2]); }
    for (const { placement, object } of referenceObjectsRef.current) { const position = referenceWorldPosition(document, placement); object.position.set(position[0], position[1], position[2]); }
    // The A1/A2 markers follow the editor's display convention: the "A1" card edits the raw A2
    // field (the one that actually moves pieces), so the A1 marker shows that raw A2 position.
    const displayA1 = anchorWorldPosition(document, selected, "a2"); const displayA2 = anchorWorldPosition(document, selected, "a1");
    runtime.markerA1.position.set(displayA1[0], displayA1[1], displayA1[2]); runtime.markerA2.position.set(displayA2[0], displayA2[1], displayA2[2]);
    runtime.markerA1.visible = true; runtime.markerA2.visible = displayA1.some((value, index) => Math.abs(value - displayA2[index]) > 1e-7);
    runtime.transformControls.space = gizmoSpace;
    // Don't fight an in-progress gizmo drag with a recomputed (should-be-equal) position, nor turn
    // the gizmo under the cursor: local axes are taken when a drag starts and held through it.
    if (runtime.transformControls.dragging) return;
    if (cameraEdit) {
      const point = cameraEdit.handle === "camera" ? cameraEdit.camera : cameraEdit.target;
      runtime.gizmoTarget.position.set(...point);
      // Local = the shop camera's own axes, the same for both of its points: Z runs along the line
      // of sight, so a local Z drag of the camera walks it straight in or out from the target.
      runtime.gizmoTarget.quaternion.copy(lookQuaternion(cameraEdit.camera, cameraEdit.target));
      return;
    }
    runtime.gizmoTarget.position.set(displayA1[0], displayA1[1], displayA1[2]);
    // Local = the primary anchor's rotation (and its parents'), the way its piece is drawn.
    applyAnchorRotation(runtime.gizmoTarget, document, selected);
  }, [document, revision, selected, visible, cameraEdit, gizmoSpace]);

  useEffect(() => { if (runtimeRef.current) runtimeRef.current.grid.visible = gridVisible; }, [gridVisible]);
  useEffect(() => {
    const runtime = runtimeRef.current; if (!runtime) return;
    const wireframeOn = renderMode === "wireframe";
    runtime.material.wireframe = wireframeOn; runtime.selectedMaterial.wireframe = wireframeOn;
    const showEdges = renderMode === "solid-wire";
    for (const edges of edgesRef.current) edges.visible = showEdges;
  }, [renderMode]);

  return <section className="viewer-pane">
    <header className="viewer-header"><div><p className="eyebrow">{tr("03 · LIVE PREVIEW")}</p><strong>{tr("Geometry viewer")}</strong></div><div className="viewer-tools"><button className={renderMode !== "solid" ? "active" : ""} onClick={() => setRenderMode((current) => current === "solid" ? "wireframe" : current === "wireframe" ? "solid-wire" : "solid")} title={tr("Cycle shading mode")}>{renderMode === "solid" ? tr("Solid") : renderMode === "wireframe" ? tr("Wireframe") : tr("Solid+Wire")}</button><button onClick={() => setGridVisible((value) => !value)}>{gridVisible ? tr("Hide grid") : tr("Show grid")}</button><button onClick={fitCamera}>{tr("Frame model")}</button></div></header>
    <div className="view-controls">
      <div className="view-buttons">
        <button onClick={() => applyView("front")} title={tr("Front (Numpad 1)")}>{tr("Front")}</button>
        <button onClick={() => applyView("back")} title={tr("Back (Ctrl+Numpad 1)")}>{tr("Back")}</button>
        <button onClick={() => applyView("left")} title={tr("Left (Numpad 3)")}>{tr("Left")}</button>
        <button onClick={() => applyView("right")} title={tr("Right (Ctrl+Numpad 3)")}>{tr("Right")}</button>
        <button onClick={() => applyView("top")} title={tr("Top (Numpad 7)")}>{tr("Top")}</button>
        <button onClick={() => applyView("bottom")} title={tr("Bottom (Numpad 9)")}>{tr("Bottom")}</button>
      </div>
      <div className="view-toggles">
        <button className={projection === "orthographic" ? "active" : ""} onClick={toggleProjection} title={tr("Toggle orthographic / perspective (Numpad 5)")}>{projection === "orthographic" ? tr("Ortho") : tr("Persp")}</button>
        <button className={gizmoVisible ? "active" : ""} onClick={toggleGizmo} title={tr("Toggle move gizmo (Ctrl+G)")}>{tr("Gizmo")}</button>
        <button className={gizmoSpace === "local" ? "active" : ""} onClick={toggleGizmoSpace} title={cameraEdit ? tr("Gizmo axes: global, or the shop camera's own (Z along the line of sight) · Ctrl+L") : tr("Gizmo axes: global, or the selected anchor's own rotation · Ctrl+L")}>{gizmoSpace === "local" ? tr("Local") : tr("Global")}</button>
        {cameraEdit && <button className={cameraEdit.lookThrough ? "active" : ""} onClick={cameraEdit.onToggleLookThrough} title={tr("See what the shop camera frames (Numpad 0) · Esc to leave")}>{tr("Camera view")}</button>}
      </div>
    </div>
    <div className="viewer-stage" ref={hostRef}>{!meshes.length && !referencePlacements.length && <div className="viewer-empty"><span>3D</span><strong>{tr("No external geometry loaded")}</strong><p>{tr("Open the complete vehicle folder for mesh.pck geometry, or load reference PPFs for wheels and exhausts.")}</p></div>}<div className="viewer-stats"><span><Tx t="{0} loaded" v={[meshes.length]} /></span><span><Tx t="{0} visible" v={[visible.length]} /></span>{referencePlacements.length > 0 && <span><Tx t="{0} refs" v={[referencePlacements.length]} /></span>}<span><Tx t="{0} tris" v={[(triangleCount + referenceTriangleCount).toLocaleString()]} /></span></div>{cameraEdit ? <div className="viewer-legend"><span><i className="cam-dot" />{tr("Camera")}</span><span><i className="target-dot" />{tr("Target")}</span></div> : <div className="viewer-legend"><span><i className="a1-dot" />A1</span><span><i className="a2-dot" />A2</span></div>}{cameraEdit?.lookThrough && cameraEdit.safeAreas && <div className="camera-frame" style={{ width: `min(100cqw, calc(100cqh * ${cameraEdit.aspect}))`, aspectRatio: String(cameraEdit.aspect) }}><div className="game-ui-band top" style={{ height: `${GAME_UI_TOP * 100}%` }}><span>{tr("Game UI")}</span></div><div className="game-ui-band bottom" style={{ height: `${GAME_UI_BOTTOM * 100}%` }}><span>{tr("Game UI")}</span></div></div>}</div>
    {cameraEdit?.lookThrough
      ? <footer className="viewer-footer camera-view-footer"><strong>{tr("Shop camera view")}</strong><span><Tx t="FOV {0}° · {1}" v={[cameraEdit.fov, Math.abs(cameraEdit.aspect - 16 / 9) < 0.01 ? "16:9" : "4:3"]} /></span><span>{tr("Drag orbits the target · wheel moves the camera in/out · right-drag pans · Esc leaves")}</span></footer>
      : <footer className="viewer-footer"><span>{tr("Drag to orbit")}</span><span>{tr("Wheel to zoom")}</span><span>{tr("Right-drag to pan")}</span></footer>}
  </section>;
}
