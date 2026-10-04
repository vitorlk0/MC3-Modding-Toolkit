import * as THREE from "three";
import { anchorRotationChain } from "../src/mesh";
import type { PckDocument } from "../src/pck";

/** Turns a piece the way its anchor (and the anchors above it) are turned in the PCK — the
 *  suspension arms' ±90°, a rear axle's 180°, a bike's fork rake. Preview only. Yaw is outermost
 *  ("YXZ"): it is the order that makes the Murcielago's mirrored side vents (Y≈π plus a small X
 *  tilt on one side, the X tilt alone on the other) come out as mirror images; nearly every other
 *  rotated anchor turns about a single axis, where the order doesn't matter. */
export function applyAnchorRotation(object: THREE.Object3D, document: PckDocument, anchorIndex: number | null) {
  object.quaternion.identity();
  if (anchorIndex === null) return;
  for (const [x, y, z] of anchorRotationChain(document, anchorIndex)) object.quaternion.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z, "YXZ")));
}
