import { BOOST, CAMERA, COMBO, DIFFICULTY, DRIVING, LANE, POWER } from '../data/config.ts';
import type { DifficultyId, ScoreBreakdown } from '../data/types.ts';
import { clamp, clamp01, damp, lerp } from '../utils/math.ts';
import type { InputFrame } from '../input/InputManager.ts';

export interface SkillMoment {
  /** Lane distance at which the skill event happened (drives the perfect-boost window). */
  atS: number;
  at: number;
  kind: string;
}

/**
 * The player's simulated state. Everything is expressed in lane-local coordinates, which
 * means steering, drifting and collision are independent of the corridor's curvature, pitch
 * and roll — those are handed to the camera and the renderer instead.
 */
export class PlayerState {
  s = 0;
  prevS = 0;
  u = 0;
  h: number = LANE.hoverBase;
  speed = 0;
  velU = 0;
  velH = 0;

  energy: number = BOOST.energyMax;
  boosting = false;
  boostEnvelope = 0;
  boostHold = 0;
  perfectBoost = false;
  perfectTimer = 0;
  boostSeconds = 0;

  drifting = false;
  driftCharge = 0;
  driftReleaseArmed = false;
  driftTime = 0;
  slide = 0;

  chain = 0;
  chainTimer = 0;
  multiplier = 1;
  score = 0;
  abilityCharge: number = 0;
  abilityActive = 0;
  abilityUses = 0;

  shieldHits = 0;
  shieldTimer = 0;
  overdrive = 0;
  phase = 0;
  magnet = 0;

  damage = 0;
  stun = 0;
  hits = 0;
  scrapes = 0;
  alive = true;
  finished = false;
  finishTime = 0;
  timeSec = 0;
  distance = 0;
  topSpeed = 0;

  /** Visual-only state consumed by the renderer. */
  hoverTarget: number = LANE.hoverBase;
  bank = 0;
  pitchVis = 0;
  yawVis = 0;
  bob = 0;
  shakeImpulse = 0;
  flash = 0;

  lastSkill: SkillMoment | null = null;
  /** Score accounting, split the way the results screen presents it. */
  readonly parts: ScoreBreakdown = { distance: 0, skill: 0, combo: 0, finish: 0 };

  stats = {
    nearMisses: 0,
    gates: 0,
    perfectBoosts: 0,
    perfectDrifts: 0,
    collapsesEscaped: 0,
    pickups: 0,
    shieldSaves: 0,
    bestChain: 0,
    comboEvents: 0,
  };

  constructor(public difficulty: DifficultyId = 'pilot') {}

  get tuning(): (typeof DIFFICULTY)[DifficultyId] {
    return DIFFICULTY[this.difficulty];
  }

  get maxSpeed(): number {
    const t = this.tuning;
    return t.maxSpeed * (this.overdrive > 0 ? POWER.overdriveGain : 1);
  }

  get targetBoostSpeed(): number {
    const t = this.tuning;
    const perfect = this.perfectTimer > 0 ? BOOST.perfectGain : 1;
    return t.boostSpeed * perfect * (this.overdrive > 0 ? POWER.overdriveGain : 1);
  }

  get speed01(): number {
    return clamp01(this.speed / Math.max(1, this.tuning.boostSpeed * BOOST.perfectGain));
  }

  get boostReady(): boolean {
    return this.energy > 6;
  }

  get abilityReady(): boolean {
    return this.abilityCharge >= BOOST.abilityCostEvents && this.abilityActive <= 0;
  }

  get invulnerable(): boolean {
    return this.phase > 0 || this.abilityActive > 0;
  }

  reset(difficulty: DifficultyId): void {
    this.difficulty = difficulty;
    this.s = 0;
    this.prevS = 0;
    this.u = 0;
    this.h = LANE.hoverBase;
    this.speed = this.tuning.baseSpeed * 0.35;
    this.velU = 0;
    this.velH = 0;
    this.energy = BOOST.energyMax;
    this.boosting = false;
    this.boostEnvelope = 0;
    this.boostHold = 0;
    this.perfectBoost = false;
    this.perfectTimer = 0;
    this.boostSeconds = 0;
    this.drifting = false;
    this.driftCharge = 0;
    this.driftReleaseArmed = false;
    this.driftTime = 0;
    this.slide = 0;
    this.chain = 0;
    this.chainTimer = 0;
    this.multiplier = 1;
    this.score = 0;
    this.abilityCharge = 0;
    this.abilityActive = 0;
    this.abilityUses = 0;
    this.shieldHits = 0;
    this.shieldTimer = 0;
    this.overdrive = 0;
    this.phase = 0;
    this.magnet = 0;
    this.damage = 0;
    this.stun = 0;
    this.hits = 0;
    this.scrapes = 0;
    this.alive = true;
    this.finished = false;
    this.finishTime = 0;
    this.timeSec = 0;
    this.distance = 0;
    this.topSpeed = 0;
    this.bank = 0;
    this.pitchVis = 0;
    this.yawVis = 0;
    this.bob = 0;
    this.shakeImpulse = 0;
    this.flash = 0;
    this.lastSkill = null;
    this.parts.distance = 0;
    this.parts.skill = 0;
    this.parts.combo = 0;
    this.parts.finish = 0;
    this.stats = {
      nearMisses: 0,
      gates: 0,
      perfectBoosts: 0,
      perfectDrifts: 0,
      collapsesEscaped: 0,
      pickups: 0,
      shieldSaves: 0,
      bestChain: 0,
      comboEvents: 0,
    };
  }

  /** Registers a skill action; enables the perfect-boost window and grows the chain. */
  noteSkill(kind: string): void {
    this.lastSkill = { atS: this.s, at: this.timeSec, kind };
    this.chain += 1;
    this.chainTimer = COMBO.window;
    this.multiplier = Math.min(COMBO.maxMultiplier, 1 + this.chain * COMBO.perStepGain);
    this.stats.comboEvents++;
    if (this.chain > this.stats.bestChain) this.stats.bestChain = this.chain;
    this.abilityCharge = Math.min(BOOST.abilityCostEvents, this.abilityCharge + 1);
  }

  addScore(base: number, skill = false, bucket: 'distance' | 'skill' | 'finish' = skill ? 'skill' : 'distance'): number {
    const gained = Math.round(base * this.multiplier);
    this.score += gained;
    // Keep the buckets additive: the chain bonus is its own line, not a re-count.
    this.parts[bucket] += base;
    const bonus = gained - base;
    if (bonus > 0) this.parts.combo += bonus;
    if (skill) this.noteSkill('score');
    return gained;
  }

  breakChain(): void {
    this.chain = 0;
    this.multiplier = 1;
    this.chainTimer = 0;
  }

  addEnergy(amount: number): void {
    this.energy = clamp(this.energy + amount, 0, BOOST.energyMax);
  }

  applyHit(severity: number): boolean {
    if (this.invulnerable) return false;
    if (this.shieldHits > 0 || this.shieldTimer > 0) {
      this.shieldHits = Math.max(0, this.shieldHits - 1);
      this.shieldTimer = 0;
      this.stats.shieldSaves++;
      this.speed *= 0.86;
      this.shakeImpulse = Math.max(this.shakeImpulse, 0.5);
      this.flash = 0.55;
      return false;
    }
    this.hits++;
    this.speed *= DRIVING.hitSpeedLoss;
    this.stun = DRIVING.hitStun * severity;
    this.damage = clamp01(this.damage + 0.16 * severity * this.tuning.hazardDamage);
    this.shakeImpulse = Math.min(CAMERA_SHAKE_MAX, this.shakeImpulse + DRIVING.knockbackU * 0.06 * severity);
    this.flash = 1;
    this.breakChain();
    this.boosting = false;
    this.perfectTimer = 0;
    return true;
  }

  /**
   * One fixed simulation step.
   * @param dt fixed timestep
   * @param input normalised input frame
   * @param corridorHalf half-width of the corridor at the player's position (metres)
   * @param ceiling corridor height at the player's position
   */
  step(dt: number, input: InputFrame, corridorHalf: number, ceiling: number, dragU = 0, dragH = 0): void {
    this.timeSec += dt;
    const t = this.tuning;

    // --- boost -------------------------------------------------------------------
    const wantsBoost = input.boost && this.energy > 0.5 && this.stun <= 0;
    if (wantsBoost) {
      if (!this.boosting) {
        const fresh = this.lastSkill !== null && this.timeSec - this.lastSkill.at <= BOOST.perfectWindow * t.reactionScale;
        this.perfectBoost = fresh && !this.perfectTimerActive;
        if (this.perfectBoost) {
          this.perfectTimer = BOOST.perfectDuration;
          this.stats.perfectBoosts++;
        }
        this.boosting = true;
        this.boostHold = 0;
      }
      this.boostHold += dt;
      if (this.boostHold > BOOST.minDuration) {
        this.energy = clamp(this.energy - BOOST.drain * t.energyDrain * dt, 0, BOOST.energyMax);
      }
      this.boostSeconds += dt;
    } else if (this.boosting) {
      this.boosting = false;
    }
    if (this.perfectTimer > 0) this.perfectTimer = Math.max(0, this.perfectTimer - dt);

    const boostTarget = this.boosting && this.energy > 0 ? 1 : 0;
    const ramp = boostTarget > this.boostEnvelope ? BOOST.entryRamp : BOOST.exitRamp;
    this.boostEnvelope = clamp01(this.boostEnvelope + (boostTarget - this.boostEnvelope) * (dt / ramp));

    // --- longitudinal --------------------------------------------------------------
    const speedRatio = this.speed / Math.max(1, t.maxSpeed);
    const ceilingSpeed = this.boosting && this.energy > 0 ? this.targetBoostSpeed : this.maxSpeed;
    let target: number;
    if (this.stun > 0) {
      this.stun -= dt;
      target = t.baseSpeed * 0.5;
    } else if (input.throttle > 0.02) {
      target = ceilingSpeed * lerp(0.82, 1, input.throttle);
    } else if (input.throttle < -0.02) {
      target = DRIVING.reverseMax * input.throttle;
    } else {
      target = Math.max(t.baseSpeed * 0.45, DRIVING.coastTarget * ceilingSpeed);
    }
    const accel =
      this.speed < target
        ? DRIVING.throttleAccel * (this.boosting ? 2.15 : 1) * lerp(1.25, 0.34, clamp01(this.speed / Math.max(1, ceilingSpeed)))
        : DRIVING.brakeDecel * (input.throttle < -0.02 ? 1.25 : 0.55);
    this.speed += clamp(target - this.speed, -accel * dt, accel * dt);
    if (Math.abs(input.throttle) < 0.02) {
      this.speed -= Math.sign(this.speed) * Math.min(Math.abs(this.speed), DRIVING.dragDecel * dt);
    }
    if (this.abilityActive > 0) {
      this.abilityActive = Math.max(0, this.abilityActive - dt);
      this.speed = Math.max(this.speed, this.targetBoostSpeed * 0.98);
    }
    this.speed = clamp(this.speed, -DRIVING.reverseMax, t.boostSpeed * BOOST.perfectGain * 1.1);
    this.topSpeed = Math.max(this.topSpeed, this.speed);

    this.prevS = this.s;
    this.s += this.speed * dt;
    this.distance = Math.max(this.distance, this.s);
    if (this.s < 0) this.s = 0;

    // --- lateral --------------------------------------------------------------------
    const steerInput = clamp(input.steer + dragU * 0.02, -1.4, 1.4);
    const sliding = input.drift && Math.abs(steerInput) > 0.25 && this.speed > DRIVING.driftMinSpeed && this.stun <= 0;
    if (sliding && !this.drifting) {
      this.drifting = true;
      this.driftCharge = 0;
    }
    if (!sliding && this.drifting) {
      this.drifting = false;
      if (this.driftCharge >= DRIFT_PERFECT_MIN) {
        this.stats.perfectDrifts++;
        this.addEnergy(BOOST.padRefund * 0.9 + DRIVING.driftPerfectBonus);
        this.noteSkill('perfectDrift');
        this.driftReleaseArmed = true;
      }
      this.driftCharge = 0;
    }

    const speedFactor = lerp(1.2, 0.55, clamp01(this.speed / Math.max(1, t.boostSpeed)));
    const gain = this.drifting ? DRIVING.driftSteerBoost : 1;
    const lateralGain = this.drifting ? DRIVING.driftLateralGain : 1;
    const targetVelU = steerInput * DRIVING.steerVelocity * speedFactor * lateralGain * (this.boosting ? 1.12 : 1);
    const lambda = this.drifting ? DRIVING.driftDamping : DRIVING.steerDamping;
    this.velU = damp(this.velU, targetVelU, lambda * gain, dt);
    this.velU += dragU * dt;
    this.u += this.velU * dt;

    if (this.drifting) {
      this.driftCharge = clamp01(this.driftCharge + dt * DRIVING.driftChargeRate);
      this.driftTime += dt;
    }
    this.slide = damp(this.slide, this.drifting ? clamp01(Math.abs(this.velU) / 42) : 0, 9, dt);

    // --- corridor constraints --------------------------------------------------------
    const limit = Math.max(1.2, corridorHalf - LANE.shipRadiusU);
    if (this.u > limit) {
      this.u = limit;
      this.wallContact(-1);
    } else if (this.u < -limit) {
      this.u = -limit;
      this.wallContact(1);
    }

    const hBase = LANE.hoverBase + clamp01(this.speed / Math.max(1, t.maxSpeed)) * 1.35;
    this.velH = damp(this.velH, dragH, 7.5, dt);
    this.h += this.velH * dt;
    const hMin = LANE.hoverMin;
    const hMax = Math.max(hMin + 1, ceiling - LANE.shipRadiusH);
    if (this.h > hMax) {
      this.h = hMax;
      this.velH *= -DRIVING.wallBounce * 0.5;
    } else if (this.h < hMin) {
      this.h = hMin;
      this.velH *= -DRIVING.wallBounce * 0.5;
    }
    this.hoverTarget = hBase;
    this.h = damp(this.h, lerp(this.h, hBase, 0.25), DRIVING.hoverSpring * 0.35, dt);

    // --- powerups / combo ------------------------------------------------------------
    if (this.overdrive > 0) this.overdrive = Math.max(0, this.overdrive - dt);
    if (this.phase > 0) this.phase = Math.max(0, this.phase - dt);
    if (this.magnet > 0) this.magnet = Math.max(0, this.magnet - dt);
    if (this.shieldTimer > 0) this.shieldTimer = Math.max(0, this.shieldTimer - dt);
    this.energy = clamp(this.energy + BOOST.energyRegen * dt, 0, BOOST.energyMax);
    if (this.chainTimer > 0) {
      this.chainTimer -= dt;
      if (this.chainTimer <= 0) {
        this.chain = Math.floor(this.chain * (1 - COMBO.decayStep));
        this.multiplier = Math.min(COMBO.maxMultiplier, 1 + this.chain * COMBO.perStepGain);
      }
    }
    this.damage = clamp01(this.damage - dt * 0.004);
    this.flash = Math.max(0, this.flash - dt * 2.4);
    this.shakeImpulse = Math.max(0, this.shakeImpulse - dt * 1.8);

    // --- visuals --------------------------------------------------------------------
    this.bank = damp(this.bank, clamp(-steerInput * CAMERA.bankFromSteer - this.slide * Math.sign(steerInput || 1) * 0.5, -1.15, 1.15), 8.5, dt);
    this.pitchVis = damp(this.pitchVis, clamp((input.throttle > 0 ? -0.06 : 0.05) - this.boostEnvelope * 0.05, -0.18, 0.14), 6, dt);
    this.yawVis = damp(this.yawVis, clamp(this.velU / 55, -0.32, 0.32) + (this.drifting ? Math.sign(this.velU) * 0.2 : 0), 9, dt);
    this.bob += dt * (1.6 + speedRatio * 3.2);
  }

  private get perfectTimerActive(): boolean {
    return this.perfectTimer > 0;
  }

  private wallContact(dir: number): void {
    if (Math.abs(this.velU) < 3) {
      this.velU = -this.velU * DRIVING.wallBounce;
      return;
    }
    this.scrapes++;
    this.speed *= 1 - DRIVING.scrapeSpeedLoss;
    this.velU = -this.velU * DRIVING.wallBounce;
    this.u += dir * 0.2;
    this.shakeImpulse = Math.min(CAMERA_SHAKE_MAX, this.shakeImpulse + 0.16);
  }

  /** Applies an external lateral impulse (gravity anomalies, shockwaves). */
  push(forceU: number, forceH: number): void {
    this.velU += forceU;
    this.velH += forceH;
  }

  activateAbility(): boolean {
    if (!this.abilityReady) return false;
    this.abilityCharge = 0;
    this.abilityActive = BOOST.abilityDuration;
    this.abilityUses++;
    this.perfectTimer = BOOST.perfectDuration * 0.8;
    this.stats.perfectBoosts++;
    this.noteSkill('ability');
    return true;
  }
}

const CAMERA_SHAKE_MAX = 1.6;
const DRIFT_PERFECT_MIN = DRIVING.driftPerfectMin;
