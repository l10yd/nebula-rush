import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Matrix4, Quaternion, Vector3 } from 'three';
import { LanePath, createFrame } from '../src/game/LanePath.ts';
import { CameraRig } from '../src/rendering/CameraRig.ts';
import type { CameraInput } from '../src/rendering/CameraRig.ts';
import { CAMERA } from '../src/data/config.ts';

function authoredPath(yaw: (i: number) => number, pitch = (_i: number): number => 0): LanePath {
  const rows = 300;
  const segs = 6;
  const n = rows * segs + 1;
  const yaws = new Float64Array(n);
  const pitches = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    yaws[i] = yaw(i);
    pitches[i] = pitch(i);
  }
  const hw = new Float64Array(n).fill(9.2);
  const hh = new Float64Array(n).fill(13);
  return new LanePath(rows, segs, 32, { yaw: yaws, pitch: pitches, roll: new Float64Array(n), halfWidth: hw, height: hh });
}

const straight = () => authoredPath(() => 0);

function inputAt(s: number, over: Partial<CameraInput> = {}): CameraInput {
  return {
    s, u: 0, h: 2.6, speed: 150, maxSpeed: 220, boost: 0, steer: 0, drift: 0,
    laneRoll: 0, bank: 0, pitch: 0, shake: 0, warp: 0, interior: 0, vortex: 0, damage: 0, perfect: false,
    ...over,
  };
}

/** Express a world vector in the corridor basis (right, up, dir) at station s. */
function corridorOffset(path: LanePath, s: number, world: Vector3): { side: number; lift: number; along: number } {
  const f = path.frameAt(s, createFrame());
  const right = new Vector3(f.rx, f.ry, f.rz);
  const up = new Vector3(f.ux, f.uy, f.uz);
  const dir = new Vector3(f.dx, f.dy, f.dz);
  return { side: world.dot(right), lift: world.dot(up), along: world.dot(dir) };
}

test('chase camera trails the ship and looks down the lane', () => {
  const path = straight();
  const rig = new CameraRig(16 / 9);
  const s = 500;
  rig.snap(path, inputAt(s));

  const ship = path.pointTo(s, 0, 2.6, new Vector3());
  const camToShip = ship.clone().sub(rig.camera.position);
  const off = corridorOffset(path, s, camToShip);
  // The ship sits ahead of the camera by the chase distance along the lane, the camera is
  // above the ship line, and near the ship's lateral band — never stacked on the ship.
  assert.ok(off.along > 10 && off.along < CAMERA.behind + 6, `along=${off.along}`);
  // lift here is (ship - camera) · corridor up: the camera rides above the ship line, so it
  // comes out negative.
  assert.ok(off.lift < -1.5 && off.lift > -6, `lift=${off.lift}`);
  assert.ok(Math.abs(off.side) < 2, `side=${off.side}`);
  assert.ok(rig.camera.position.distanceTo(ship) > 12, 'camera is stacked on the ship');

  // And it must aim down the corridor, not into the void or straight down.
  const f = path.frameAt(s, createFrame());
  const view = new Vector3(0, 0, -1).applyQuaternion(rig.camera.quaternion);
  const aim = view.dot(new Vector3(f.dx, f.dy, f.dz));
  assert.ok(aim > 0.97, `view axis dot lane dir = ${aim}`);
});

test('camera follows the corridor into a curve, not a stale straight frame', () => {
  // A hard sweep from row ~12 on: by mid-corner the corridor has turned ~20 degrees.
  const path = authoredPath((i) => (i < 72 ? 0 : Math.min(1.2, (i - 72) * 0.02)));
  const rig = new CameraRig(16 / 9);
  const s = 480;
  rig.snap(path, inputAt(s, { speed: 200 }));
  const ship = path.pointTo(s, 0, 2.6, new Vector3());
  const off = corridorOffset(path, s, ship.clone().sub(rig.camera.position));
  assert.ok(off.along > 10, `corner camera not behind the ship: ${off.along}`);

  // The look axis must lead into the bend: closer to the heading ~lookAhead down the lane
  // than to the pre-corner straight. Staring down the entry tangent is exactly how a stale
  // frame betrays itself.
  const fMid = path.frameAt(s, createFrame());
  const fLead = path.frameAt(s + CAMERA.lookAhead, createFrame());
  const fEntry = path.frameAt(100, createFrame());
  const view = new Vector3(0, 0, -1).applyQuaternion(rig.camera.quaternion);
  const dotMid = view.dot(new Vector3(fMid.dx, fMid.dy, fMid.dz));
  const dotLead = view.dot(new Vector3(fLead.dx, fLead.dy, fLead.dz));
  const dotEntry = view.dot(new Vector3(fEntry.dx, fEntry.dy, fEntry.dz));
  assert.ok(dotMid > 0.9, `mid-corner aim ${dotMid}`);
  assert.ok(dotLead > dotEntry, `aim does not lead into the bend (lead=${dotLead} entry=${dotEntry})`);

  // Camera must remain inside the corridor tube around the bend.
  const camRel = rig.camera.position.clone().sub(path.pointTo(s, 0, 0, new Vector3()));
  const sideLift = corridorOffset(path, s, camRel);
  assert.ok(Math.abs(sideLift.side) < 9.2, `camera outside lane walls (side=${sideLift.side})`);
});

test('start-line grid shot extrapolates behind the entrance', () => {
  const path = straight();
  const rig = new CameraRig(16 / 9);
  rig.snap(path, inputAt(0, { speed: 0 }));
  const f0 = path.frameAt(0, createFrame());
  const dir = new Vector3(f0.dx, f0.dy, f0.dz);
  const start = new Vector3(f0.px, f0.py, f0.pz);
  const behindStart = rig.camera.position.clone().sub(start).dot(dir);
  // The camera stands *before* the corridor entry, and aims along the lane from there.
  assert.ok(behindStart < -CAMERA.behind + 4, `camera not pulled out to the grid: ${behindStart}`);
  assert.ok(behindStart > -CAMERA.behind - 4, `camera too far out: ${behindStart}`);
  const view = new Vector3(0, 0, -1).applyQuaternion(rig.camera.quaternion);
  assert.ok(view.dot(dir) > 0.97, `grid shot looks off the lane: ${view.dot(dir)}`);
});

test('update keeps the rig on the corridor between snaps', () => {
  const path = straight();
  const rig = new CameraRig(16 / 9);
  let s = 60;
  rig.snap(path, inputAt(s));
  for (let frame = 0; frame < 120; frame++) {
    s += 3.2;
    rig.update(1 / 60, path, inputAt(s, { u: Math.sin(s * 0.02) * 4 }), 'high', false, true);
  }
  const ship = path.pointTo(s, Math.sin(s * 0.02) * 4, 2.6, new Vector3());
  const off = corridorOffset(path, s, ship.clone().sub(rig.camera.position));
  assert.ok(off.along > 10 && off.along < 26, `damped rig drifted off station: ${off.along}`);
  const f = path.frameAt(s, createFrame());
  const view = new Vector3(0, 0, -1).applyQuaternion(rig.camera.quaternion);
  assert.ok(view.dot(new Vector3(f.dx, f.dy, f.dz)) > 0.95, 'running camera lost the lane');
});

test('hull basis from the lane frame is a true rotation with the nose forward', () => {
  // Mirrors what RendererManager composes: a mirrored (det -1) basis silently yields a
  // degenerate quaternion and the hull collapses.
  const path = authoredPath((i) => (i < 48 ? 0 : Math.sin((i - 48) * 0.01) * 0.7), (i) => Math.sin(i * 0.004) * 0.2);
  const f = path.frameAt(640, createFrame());
  const right = new Vector3(f.rx, f.ry, f.rz);
  const up = new Vector3(f.ux, f.uy, f.uz);
  const dir = new Vector3(f.dx, f.dy, f.dz);
  const basis = new Matrix4().makeBasis(right, up, dir);
  assert.equal(basis.determinant().toFixed(3), '1.000');
  const q = new Quaternion().setFromRotationMatrix(basis);
  assert.ok(Math.abs(q.length() - 1) < 1e-6, `quaternion not unit: ${q.length()}`);
  const nose = new Vector3(0, 0, 1).applyQuaternion(q);
  const canopy = new Vector3(0, 1, 0).applyQuaternion(q);
  assert.ok(nose.dot(dir) > 0.9999, 'local +z (model nose) must face down the lane');
  assert.ok(canopy.dot(up) > 0.9999, 'local +y (model canopy) must face corridor up');
});
