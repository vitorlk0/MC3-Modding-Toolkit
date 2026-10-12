import * as THREE from "three";
import { anchorRotationChain } from "../src/mesh";
import type { PckDocument, Vec3 } from "../src/pck";

const EULER_ORDER = "YXZ";

/** Turns a piece the way its anchor (and the anchors above it) are turned in the PCK — the
 *  suspension arms' ±90°, a rear axle's 180°, a bike's fork rake. Yaw is outermost ("YXZ"): it is
 *  the order that makes the Murcielago's mirrored side vents (Y≈π plus a small X tilt on one side,
 *  the X tilt alone on the other) come out as mirror images; nearly every other rotated anchor
 *  turns about a single axis, where the order doesn't matter. Confirmed in game since. */
export function applyAnchorRotation(object: THREE.Object3D, document: PckDocument, anchorIndex: number | null) {
  object.quaternion.copy(anchorWorldQuaternion(document, anchorIndex));
}

/** The anchor's own rotation composed under every rotated anchor above it, root first. */
export function anchorWorldQuaternion(document: PckDocument, anchorIndex: number | null) {
  const quaternion = new THREE.Quaternion();
  if (anchorIndex === null) return quaternion;
  for (const rotation of anchorRotationChain(document, anchorIndex)) quaternion.multiply(quaternionFromEuler(rotation));
  return quaternion;
}

const quaternionFromEuler = ([x, y, z]: Vec3) => new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z, EULER_ORDER));

/** What the anchors above this one contribute — nothing for a wheel or exhaust, which the
 *  chain treats as absolute (see anchorRotationChain). */
export function anchorParentQuaternion(document: PckDocument, anchorIndex: number) {
  const runtimeAbsolute = document.wheelLinks.has(anchorIndex) || document.wheelFollowers.has(anchorIndex) || document.exhaustLinks.has(anchorIndex);
  const parent = document.pieces[anchorIndex].parentIndex;
  return runtimeAbsolute || parent === null ? new THREE.Quaternion() : anchorWorldQuaternion(document, parent);
}

const TAU = Math.PI * 2;
const SAME_ANGLE = 1e-6;
/** `angle` plus whole turns, as close as possible to `reference`. */
const unwrapNear = (angle: number, reference: number) => angle + Math.round((reference - angle) / TAU) * TAU;

/**
 * The YXZ Euler angles (radians) of a local rotation, picked to stay close to `reference`.
 * Every orientation has two YXZ solutions — (x, y, z) and (π − x, y + π, z + π) — and each angle
 * can gain whole turns; a gizmo drag shouldn't make an anchor at Y = 180° jump to (180, 0, 180).
 */
export function eulerNear(local: THREE.Quaternion, reference: Vec3): Vec3 {
  const euler = new THREE.Euler().setFromQuaternion(local, EULER_ORDER);
  const candidates: Vec3[] = [[euler.x, euler.y, euler.z], [Math.PI - euler.x, euler.y + Math.PI, euler.z + Math.PI]];
  // At X = ±90° (gimbal lock) only Y ∓ Z is defined and three.js puts it all in Y; offer the split
  // that keeps the reference Z (vp_sc430_04's engine_smk_0 sits exactly there). Kept only if it
  // really reproduces the rotation.
  const locked: Vec3 = [euler.x, euler.y + Math.sign(euler.x) * reference[2], reference[2]];
  if (quaternionFromEuler(locked).angleTo(local) < SAME_ANGLE) candidates.push(locked);
  let best: Vec3 = candidates[0], bestDistance = Infinity;
  for (const candidate of candidates) {
    const unwrapped = candidate.map((angle, component) => unwrapNear(angle, reference[component])) as Vec3;
    const distance = unwrapped.reduce((sum, angle, component) => sum + Math.abs(angle - reference[component]), 0);
    if (distance < bestDistance) { best = unwrapped; bestDistance = distance; }
  }
  // An axis the drag didn't turn comes back with float noise; keep its stored value instead, so
  // setAnchorRotation leaves those bits alone.
  return best.map((angle, component) => Math.abs(angle - reference[component]) < SAME_ANGLE ? reference[component] : angle) as Vec3;
}

/** The local rotation an anchor needs so that its world orientation becomes `world`. */
export function localRotationFor(document: PckDocument, anchorIndex: number, world: THREE.Quaternion, reference: Vec3): Vec3 {
  const local = anchorParentQuaternion(document, anchorIndex).invert().multiply(world);
  return eulerNear(local, reference);
}
