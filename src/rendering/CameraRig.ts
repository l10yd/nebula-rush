import { MathUtils, PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { CAMERA, LANE } from '../data/config.ts';
import type { QualityTier } from '../data/types.ts';
import { clamp, clamp01, damp } from '../utils/math.ts';
import type { LanePath } from '../game/LanePath.ts';
import { createFrame } from '../game/LanePath.ts';

export interface CameraInput {
  /** Lane distance along the corridor. */
  s: number;
  /** Lateral offset in metres. */
  u: number;
  /** Height above the floor in metres. */
  h: number;
  speed: number;
  maxSpeed: number;
  /** 0..1 boost envelope. */
  boost: number;
  /** -1..1 steering input, used for the bank read. */
  steer: number;
  /** 0..1 drift slide. */
  drift: number;
  /** Banked roll of the corridor itself. */
  laneRoll: number;
  /** Ship body roll in radians. */
  bank: number;
  /** Ship visual pitch in radians. */
  pitch: number;
  /** Impact impulse 0..1 from collisions. */
  shake: number;
  /** 0..1 spectacle states. */
  warp: number;
  interior: number;
  vortex: number;
  /** 0..1 damage — adds a dirty, unstable read. */
  damage: number;
  /** True on the frame a perfect boost landed. */
  perfect: boolean;
}

const SHAKE_LAYERS = 3;

/**
 * The chase camera. Everything the player *feels* funnels through here, so the rules are
 * strict: the camera always sits on the corridor's frame chain (never on a raw world axis),
 * it only leads the player by a distance that keeps the next hazard readable, and every
 * effect that could hide the road — shake, FOV punch, roll — is bounded and, when reduced
 * motion is on, collapses to a gentle dolly.
 */
export class CameraRig {
  readonly camera: PerspectiveCamera;

  private readonly frame = createFrame();
  private readonly entryFrame = createFrame();
  private readonly pos = new Vector3();
  private readonly look = new Vector3();
  private readonly up = new Vector3();
  private readonly right = new Vector3();
  private readonly fwd = new Vector3();
  private readonly basis = new Quaternion();
  private readonly shakeOffset = new Vector3();
  private readonly rotShake = new Vector3();

  private shakeEnergy = 0;
  private fov: number = CAMERA.fovBase;
  private distance: number = CAMERA.behind;
  private rollVis = 0;
  private pitchVis = 0;
  private yawVis = 0;
  private time = 0;
  private punch = 0;

  constructor(aspect: number) {
    this.camera = new PerspectiveCamera(CAMERA.fovBase, aspect, 0.35, LANE.fogFar * 2.2);
  }

  get viewDistance(): number {
    return this.distance;
  }

  /** Freeze-follow onto the ship instantly (race start, restart, teleport). */
  snap(path: LanePath, input: CameraInput): void {
    this.time = 0;
    this.shakeEnergy = 0;
    this.rollVis = input.laneRoll * CAMERA.bankFromRoll;
    this.pitchVis = 0;
    this.yawVis = 0;
    this.punch = 0;
    path.frameAt(input.s, this.frame);
    this.compose(path, input, 1);
    this.camera.position.copy(this.pos);
    this.camera.up.copy(this.up);
    this.camera.lookAt(this.look);
    this.camera.updateMatrixWorld(true);
  }

  update(dt: number, path: LanePath, input: CameraInput, quality: QualityTier, reducedMotion: boolean, shakeEnabled: boolean): void {
    this.time += dt;
    const speedRatio = clamp01(input.speed / Math.max(1, input.maxSpeed));

    // Impact energy is a decaying accumulator, so a chain of hits reads as a rumble and not
    // as one huge spike that would throw the player off the line.
    this.shakeEnergy = Math.max(this.shakeEnergy - dt * CAMERA.shakeDecay, input.shake);
    if (input.perfect) this.punch = Math.min(1, this.punch + 0.55);
    this.punch = damp(this.punch, 0, 7, dt);

    const shakeAllowed = shakeEnabled && !reducedMotion;
    const amplitude = shakeAllowed
      ? Math.min(1, this.shakeEnergy) * CAMERA.shakeMax * (quality === 'low' ? 0.55 : 1)
      : 0;

    this.computeShake(dt, amplitude, input.damage, reducedMotion);

    // Distance pulls back with speed: the frame widens exactly when the world gets faster.
    const wantDistance =
      CAMERA.behind +
      input.boost * CAMERA.behindBoostAdd +
      speedRatio * 2.4 +
      input.warp * -3.2 +
      (reducedMotion ? 1.2 : 0);
    this.distance = damp(this.distance, wantDistance, 4.2, dt);

    const wantFov =
      CAMERA.fovBase +
      speedRatio * (CAMERA.fovMax - CAMERA.fovBase) * 0.62 +
      input.boost * CAMERA.boostFOV +
      input.warp * CAMERA.warpFOV * 2.2 +
      this.punch * 3.4 +
      input.interior * 4 +
      input.vortex * 6;
    this.fov = damp(this.fov, clamp(wantFov, CAMERA.fovBase - 2, CAMERA.fovMax + (reducedMotion ? 4 : 12)), reducedMotion ? 3 : 6.5, dt);
    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }

    const wantRoll = input.laneRoll * CAMERA.bankFromRoll + input.bank * CAMERA.bankFromSteer * 0.5 + input.steer * 0.06;
    this.rollVis = damp(this.rollVis, wantRoll + (input.vortex > 0 ? Math.sin(this.time * 1.4) * 0.12 * input.vortex : 0), CAMERA.rollLambda, dt);
    this.pitchVis = damp(this.pitchVis, input.pitch + input.boost * 0.035 - speedRatio * 0.02, 5.5, dt);
    this.yawVis = damp(this.yawVis, clamp(input.drift * Math.sign(input.steer || 1) * 0.14, -0.2, 0.2), 5, dt);

    this.compose(path, input, 1 - this.shakeEnergy * 0.15);
    this.camera.position.copy(this.pos).add(this.shakeOffset);
    this.camera.up.copy(this.up);
    this.camera.lookAt(this.look);
    this.camera.rotateZ(this.rotShake.z + this.yawVis * 0.2);
    this.camera.rotateX(this.rotShake.x);
  }

  /** Menu / garage orbit, independent of lane state. */
  orbit(center: Vector3, radius: number, height: number, angle: number): void {
    this.camera.up.set(0, 1, 0);
    this.camera.position.set(Math.cos(angle) * radius, height, Math.sin(angle) * radius).add(center);
    this.camera.lookAt(center);
    this.camera.updateMatrixWorld(true);
  }

  private compose(path: LanePath, input: CameraInput, weight: number): void {
    const s = input.s;
    path.frameAt(s, this.frame);
    const back = s - this.distance;
    const side = input.u * CAMERA.lateralFollow;
    const lift = CAMERA.height * weight + input.h * 0.28;

    // The player's own frame belongs to station `s` only. The camera sits ~15 m behind and
    // aims ~60 m ahead, so those points must resolve on the frames of their own stations —
    // reusing `this.frame` there stacks the whole rig on top of the ship and the view axis
    // degenerates to "straight down over our own tail".
    if (back >= 0) {
      path.pointTo(back, side, lift, this.pos);
    } else {
      // Before the start line there is no corridor to stand in, so extrapolate along the
      // ENTRY tangent from the start-line frame (the opening rows are authored straight).
      // Measuring from the PLAYER's frame instead double-counts `s` and parks the camera at
      // `2s - distance` — it closes on the ship at twice ship speed, dives through the hull
      // around s = distance/2 (the ship swells, stretches and "stays in place" for the first
      // half-second of every race), then snaps back once the lane branch takes over.
      path.frameAt(0, this.entryFrame);
      this.pos.set(this.entryFrame.px, this.entryFrame.py, this.entryFrame.pz);
      this.pos.addScaledVector(this.fwd.set(this.entryFrame.dx, this.entryFrame.dy, this.entryFrame.dz), back);
      this.pos.addScaledVector(this.right.set(this.entryFrame.rx, this.entryFrame.ry, this.entryFrame.rz), side);
      this.pos.addScaledVector(this.up.set(this.entryFrame.ux, this.entryFrame.uy, this.entryFrame.uz), lift);
    }
    // Lead the aim point down the corridor and into the curve, so the visible road is always
    // the road the player is about to fly.
    const ahead = CAMERA.lookAhead + input.speed * 0.16 + input.warp * 60;
    this.look.copy(path.pointTo(s + ahead, input.u * 0.42, input.h + 1.4, this.look));

    this.up.set(this.frame.ux, this.frame.uy, this.frame.uz);
    this.right.set(this.frame.rx, this.frame.ry, this.frame.rz);
    this.fwd.set(this.frame.dx, this.frame.dy, this.frame.dz);

    // Roll the camera about its own view axis rather than tilting the world's up vector:
    // that keeps the horizon readable while banking through a curve.
    this.basis.setFromAxisAngle(this.fwd, -this.rollVis);
    this.up.applyQuaternion(this.basis);
    this.up.addScaledVector(this.right, Math.sin(this.pitchVis) * 0.35).normalize();
    if (this.up.lengthSq() < 1e-6) this.up.set(0, 1, 0);
  }

  private computeShake(dt: number, amplitude: number, damage: number, reducedMotion: boolean): void {
    const a = amplitude + damage * 0.06 * (reducedMotion ? 0.25 : 1);
    if (a <= 0.0005) {
      if (this.shakeOffset.lengthSq() > 0) this.shakeOffset.set(0, 0, 0);
      if (this.rotShake.lengthSq() > 0) this.rotShake.set(0, 0, 0);
      return;
    }
    // Layered incommensurate sines: cheap, smooth, repeatable, and nothing about it flickers
    // like white noise does at high frame rates.
    let x = 0;
    let y = 0;
    let z = 0;
    for (let i = 0; i < SHAKE_LAYERS; i++) {
      const f = 11.3 + i * 7.7;
      const p = this.time * f + i * 2.1;
      x += Math.sin(p) * (1 / (i + 1));
      y += Math.cos(p * 0.87 + 1.3) * (1 / (i + 1.4));
      z += Math.sin(p * 1.31 + 2.7) * (1 / (i + 1.8));
    }
    const norm = 1 / SHAKE_LAYERS;
    const metres = a * 0.62;
    this.shakeOffset.set(x * metres * norm, y * metres * norm * 0.8, z * metres * norm * 0.4);
    const radians = a * 0.022;
    this.rotShake.set(y * radians * norm, x * radians * norm * 0.6, z * radians * norm);
    void dt;
  }

  setAspect(aspect: number): void {
    if (!Number.isFinite(aspect) || aspect <= 0) return;
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** Near plane widens with speed so fast motion never clips through the corridor wall. */
  setSpeedClipping(speed: number): void {
    const near = MathUtils.lerp(0.35, 0.9, clamp01(speed / 320));
    if (Math.abs(this.camera.near - near) < 0.01) return;
    this.camera.near = near;
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    this.camera.clear();
  }
}
