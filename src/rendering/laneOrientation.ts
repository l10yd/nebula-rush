import { Matrix4, Quaternion, Vector3 } from 'three';
import type { LaneFrame } from '../game/LanePath.ts';

/**
 * The one correct way to orient anything that rides the lane.
 *
 * Model convention (set by the hull factories and shared by every prop): local +x is the
 * lane's right, +y the lane's up, +z the direction of travel — the nose. This builds exactly
 * the rotation that maps those axes onto the corridor frame, and it is a proper rotation:
 * det(+1), so setFromRotationMatrix cannot silently return a non-unit garbage quaternion.
 * (The recurring past bug was (right, up, -dir), which is mirrored: props and the hull then
 * came out skewed off the corridor, worst on banked curves.)
 */
const RIGHT = new Vector3();
const UP = new Vector3();
const FWD = new Vector3();
const LOCAL = new Matrix4();

export function laneOrientation(frame: LaneFrame, out: Quaternion): Quaternion {
  RIGHT.set(frame.rx, frame.ry, frame.rz);
  UP.set(frame.ux, frame.uy, frame.uz);
  FWD.set(frame.dx, frame.dy, frame.dz);
  return out.setFromRotationMatrix(LOCAL.makeBasis(RIGHT, UP, FWD));
}
