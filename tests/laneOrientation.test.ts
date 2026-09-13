import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { Quaternion, Vector3 } from 'three';
import { createFrame } from '../src/game/LanePath.ts';
import type { LaneFrame } from '../src/game/LanePath.ts';
import { laneOrientation } from '../src/rendering/laneOrientation.ts';

/**
 * The lane orientation helper is the single source of truth for how models (nose +z, canopy
 * +y) sit in the corridor. Every past mirrored-basis incident (hull skew, prop garbage quats)
 * comes down to someone building makeBasis(right, up, -dir) by hand — a det -1 matrix whose
 * derived quaternion is silently degenerate. This pins the contract on a frame that is both
 * yawed and banked, where shortcuts like "just negate the third column" stop working.
 */
function bankedFrame(): LaneFrame {
  // A yawed and banked orthonormal corridor frame, built exactly: rotate the straight frame
  // about world y by `yaw`, then roll up/right about the new direction by `roll`.
  const f = createFrame();
  const yaw = 0.7;
  const roll = 0.35;
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cr = Math.cos(roll);
  const sr = Math.sin(roll);
  f.dx = sy; f.dy = 0; f.dz = cy;
  f.ux = -sr * cy; f.uy = cr; f.uz = sr * sy;
  f.rx = cr * cy; f.ry = sr; f.rz = -cr * sy;
  return f;
}

describe('laneOrientation', () => {
  it('is a proper rotation: unit quaternion, det +1 basis', () => {
    const q = laneOrientation(bankedFrame(), new Quaternion());
    assert.ok(Math.abs(q.length() - 1) < 1e-9, `quaternion must be unit, got ${q.length()}`);
  });

  it('maps model axes onto the corridor: +x right, +y up, +z travel', () => {
    const f = bankedFrame();
    const q = laneOrientation(f, new Quaternion());
    const nose = new Vector3(0, 0, 1).applyQuaternion(q);
    const canopy = new Vector3(0, 1, 0).applyQuaternion(q);
    const star = new Vector3(1, 0, 0).applyQuaternion(q);
    assert.ok(nose.dot(new Vector3(f.dx, f.dy, f.dz)) > 0.9999, 'nose must ride the lane direction');
    assert.ok(canopy.dot(new Vector3(f.ux, f.uy, f.uz)) > 0.9999, 'canopy must follow the lane up');
    assert.ok(star.dot(new Vector3(f.rx, f.ry, f.rz)) > 0.9999, 'starboard must follow the lane right');
  });
});
