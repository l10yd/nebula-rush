import { COMBO, DIFFICULTY, LANE, POWER, RACE } from '../data/config.ts';
import type { BiomeId, DifficultyId, PickupKind } from '../data/types.ts';
import type { StringKey } from '../data/i18n.ts';
import { EventBus } from '../core/EventBus.ts';
import { clamp, clamp01 } from '../utils/math.ts';
import type { LanePath } from './LanePath.ts';
import { createFrame } from './LanePath.ts';
import { PlayerState } from './PlayerState.ts';
import { CollisionSystem, Contact, createSweepResult, type SweepResult } from './CollisionSystem.ts';
import { CollapseDirector } from './CollapseDirector.ts';
import { SpectacleRunner } from './SpectacleRunner.ts';
import { FxQueue } from './FxQueue.ts';
import { RF, type LaneEntity, type LaneRow } from './trackTypes.ts';
import type { RaceEvents } from './events.ts';

export interface RaceConfig {
  seed: string;
  difficulty: DifficultyId;
  biome: BiomeId;
  rows: LaneRow[];
  entities: LaneEntity[];
  path: LanePath;
  length: number;
}

export type RaceStatus = 'countdown' | 'running' | 'finished' | 'wrecked';

/** Normalised intent for one fixed step. */
export interface RaceInput {
  throttle: number;
  steer: number;
  boost: boolean;
  drift: boolean;
  abilityPressed: boolean;
  pausePressed: boolean;
  restartPressed: boolean;
}

export const IDLE_INPUT: RaceInput = {
  throttle: 0,
  steer: 0,
  boost: false,
  drift: false,
  abilityPressed: false,
  pausePressed: false,
  restartPressed: false,
};

/**
 * Owns one race: the ship simulation, the collapsing-lane director, the spectacle beats,
 * hazard interaction, scoring and the objective/warning stream that the HUD listens to.
 *
 * It is a pure simulation — it never touches the DOM or the GPU. The renderer is a
 * downstream consumer of the state and events produced here.
 */
export class RaceRuntime {
  readonly player = new PlayerState('pilot');
  readonly bus = new EventBus<RaceEvents>();
  readonly fx = new FxQueue(320);
  readonly collapse: CollapseDirector;
  readonly spectacle: SpectacleRunner;
  private readonly collisions = new CollisionSystem();
  private readonly sweep: SweepResult = createSweepResult(40);
  private readonly frame = createFrame();

  status: RaceStatus = 'countdown';
  /** Last intent seen by `step`, read by the renderer for throttle/brake visuals. */
  lastInput: RaceInput = IDLE_INPUT;
  countdown = RACE.countdownSteps.length + RACE.countdownGoTime;
  /** Guards the immediate first-tick announcement of the top countdown step (see `step`). */
  private countdownAnnounced = false;
  time = 0;
  raceClock = 0;
  gateChain = 0;
  lastGateAt = -99;
  objective: StringKey = 'objective.launch';
  objectiveTimer = 0;
  warnings: { key: StringKey; side: number; distance: number; life: number }[] = [];
  private nextWarningAt = 0;
  private nextObjectiveAt = 0;
  private corridorHalf: number = LANE.halfWidth;
  private ceiling: number = LANE.height;
  private laneRoll = 0;
  private lanePitch = 0;
  private laneYaw = 0;
  private pendingShake = 0;
  private deathChecked = false;

  constructor(public config: RaceConfig) {
    this.collapse = new CollapseDirector(config.rows, DIFFICULTY[config.difficulty], this.bus, this.fx, config.path);
    this.spectacle = new SpectacleRunner(config.rows, DIFFICULTY[config.difficulty], this.bus, this.fx, config.path);
  }

  get progress(): number {
    return clamp01(this.player.s / Math.max(1, this.config.length));
  }

  get rows(): LaneRow[] {
    return this.config.rows;
  }

  /** Hazards and pickups, indexed by row ranges (read by the renderer and the tests). */
  get entities(): LaneEntity[] {
    return this.config.entities;
  }

  get path(): LanePath {
    return this.config.path;
  }

  get score(): number {
    return this.player.score;
  }

  get corridor(): { half: number; height: number; roll: number; lanes: number; median: number } {
    return { half: this.corridorHalf, height: this.ceiling, roll: this.laneRoll, lanes: this.currentRow.lanes, median: this.currentRow.medianHalf };
  }

  get currentRow(): LaneRow {
    return this.config.rows[this.config.path.rowAt(this.player.s)] ?? this.config.rows[0];
  }

  get shakeInput(): number {
    return this.pendingShake;
  }

  reset(): void {
    this.player.reset(this.config.difficulty);
    this.collisions.reset(this.config.entities);
    this.collapse.reset();
    this.spectacle.reset();
    this.fx.clear();
    this.status = 'countdown';
    this.countdown = RACE.countdownSteps.length + RACE.countdownGoTime;
    this.countdownAnnounced = false;
    this.time = 0;
    this.raceClock = 0;
    this.gateChain = 0;
    this.lastGateAt = -99;
    this.objective = 'objective.launch';
    this.objectiveTimer = 0;
    this.warnings.length = 0;
    this.nextWarningAt = 0;
    this.nextObjectiveAt = 0;
    this.deathChecked = false;
    this.pendingShake = 0;
    this.updateCorridor();
  }

  /** Fixed-timestep advance. `input` is a normalised intent frame. */
  step(dt: number, input: RaceInput): void {
    this.lastInput = input;
    this.time += dt;

    if (this.status === 'countdown') {
      if (!this.countdownAnnounced) {
        // The ceil-gate below only fires when the *displayed* number changes, so without this
        // announcement the HUD sits blank for the whole first second and the race visibly
        // "starts at 2". Announce the top step the instant the countdown begins.
        this.countdownAnnounced = true;
        this.bus.emit('countdown', { value: RACE.countdownSteps[0] });
      }
      const before = Math.ceil(this.countdown - RACE.countdownGoTime);
      this.countdown -= dt;
      const after = Math.ceil(this.countdown - RACE.countdownGoTime);
      if (after !== before && after >= 0) this.bus.emit('countdown', { value: after });
      this.updateCorridor();
      if (this.countdown <= 0) {
        this.status = 'running';
        this.bus.emit('countdown', { value: 0 });
      }
      return;
    }

    if (this.status !== 'running') {
      this.updateCorridor();
      this.collapse.update(dt, this.player);
      this.spectacle.update(dt, this.player);
      return;
    }

    this.raceClock += dt;
    if (input.abilityPressed && this.player.activateAbility()) {
      this.bus.emit('ability', {});
      this.fx.emit('ring', 0, 0, 0, { size: BOOST_RING, color: 0, power: 1, s: this.player.s, u: this.player.u, h: this.player.h });
    }

    this.updateCorridor();
    this.player.step(dt, input, this.corridorHalf, this.ceiling, this.pullU, this.pullH);
    const swept = this.collisions.sweep(this.config.entities, this.config.rows, this.player, this.time, dt, LANE.sightDistance * 0.25, this.sweep);
    this.applyContacts(swept);
    this.pullU = clamp(swept.pullU, -PULL_CAP, PULL_CAP);
    this.pullH = clamp(swept.pullH, -PULL_CAP * 0.6, PULL_CAP * 0.6);

    this.collapse.update(dt, this.player);
    this.spectacle.update(dt, this.player);
    this.scoreDistance(dt);
    this.updateObjective(dt);
    this.updateWarnings(swept, dt);
    this.checkEnd();
    this.pendingShake = this.player.shakeImpulse;
  }

  private pullU = 0;
  private pullH = 0;

  private scoreDistance(dt: number): void {
    if (this.player.speed <= 0) return;
    this.player.score += COMBO.points.distancePerMetre * this.player.speed * dt * DIFFICULTY[this.config.difficulty].scoreMultiplier;
  }

  private updateCorridor(): void {
    const path = this.config.path;
    path.frameAt(this.player.s, this.frame);
    this.corridorHalf = this.frame.hw;
    this.ceiling = this.frame.hh;
    this.laneRoll = this.frame.roll;
    this.laneYaw = this.frame.dx;
    this.lanePitch = this.frame.dy;
  }

  private applyContacts(sweep: SweepResult): void {
    const player = this.player;
    for (let i = 0; i < sweep.count; i++) {
      const ev = sweep.events[i];
      const e = ev.entity;
      if (!e) continue;
      switch (ev.contact) {
        case Contact.Hit:
          this.onHit(e);
          break;
        case Contact.NearMiss:
          player.noteSkill('nearMiss');
          player.stats.nearMisses++;
          this.bus.emit('nearMiss', { kind: e.kind, distance: ev.distance });
          this.fx.emit('spark', 0, 0, 0, { size: 1.2, color: 1, power: 0.7, s: e.cs, u: e.cu, h: e.ch });
          break;
        case Contact.Gate:
          this.onGate(e, ev.distance);
          break;
        case Contact.Pad:
          this.onPad(e);
          break;
        case Contact.Cell:
          this.onCell(e);
          break;
        default:
          break;
      }
    }
  }

  private onHit(e: LaneEntity): void {
    const player = this.player;
    const heavy = e.tier >= 2 || e.kind === 'rogue';
    if (player.invulnerable) {
      this.fx.emit('burst', 0, 0, 0, { size: 3, color: 1, power: 0.8, s: e.cs, u: e.cu, h: e.ch });
      return;
    }
    const blocked = player.applyHit(heavy ? 1.3 : 1);
    if (blocked) {
      this.bus.emit('hit', { kind: e.kind, severity: heavy ? 2 : 1, blocked: false });
      this.fx.emit('explosion', 0, 0, 0, { size: heavy ? 6 : 4, color: 3, power: 1, s: e.cs, u: e.cu, h: e.ch });
      e.kind = 'shard';
      e.r = 0;
      e.tier = 0;
    } else {
      this.bus.emit('hit', { kind: e.kind, severity: heavy ? 2 : 1, blocked: true });
      this.bus.emit('shield', { on: false });
      this.fx.emit('shieldHit', 0, 0, 0, { size: 5, color: 0, power: 1, s: player.s, u: player.u, h: player.h });
    }
    this.bus.emit('damage', { level: player.damage, fatal: player.damage >= 1 });
    if (player.damage >= 1 && !this.deathChecked) {
      this.deathChecked = true;
      this.bus.emit('death', {});
      this.status = 'wrecked';
    }
  }

  private onGate(e: LaneEntity, distance: number): void {
    const player = this.player;
    const chained = this.time - this.lastGateAt < 3.4;
    this.gateChain = chained ? this.gateChain + 1 : 1;
    this.lastGateAt = this.time;
    player.stats.gates++;
    const center = distance < Math.max(1, e.size) * 0.42;
    const boosting = player.boostEnvelope > 0.4;
    const base = boosting ? COMBO.points.boostGate : COMBO.points.gate;
    player.noteSkill('gate');
    const gained = player.addScore(base + (center ? 60 : 0) + Math.max(0, this.gateChain - 1) * 25);
    player.addEnergy(BOOST_PAD_ENERGY * (boosting ? 1.4 : 1));
    this.bus.emit('gate', { boost: boosting, center, chain: this.gateChain });
    this.fx.emit('gateFlash', 0, 0, 0, { size: Math.max(2, e.size), color: boosting ? 0 : 4, power: 1, s: e.cs, u: e.cu, h: e.ch });
    void gained;
  }

  private onPad(e: LaneEntity): void {
    const player = this.player;
    player.addEnergy(BOOST_PAD_ENERGY * 1.6);
    player.noteSkill('pad');
    this.fx.emit('ring', 0, 0, 0, { size: 4, color: 0, power: 0.9, s: e.cs, u: e.cu, h: e.ch });
  }

  private onCell(e: LaneEntity): void {
    const player = this.player;
    const kind: PickupKind = e.pickup || 'energy';
    let seconds = 0;
    switch (kind) {
      case 'energy':
        player.addEnergy(POWER.energyRefund);
        player.noteSkill('energy');
        break;
      case 'shield':
        player.shieldHits = Math.min(3, player.shieldHits + 1);
        player.shieldTimer = POWER.shieldDuration;
        seconds = POWER.shieldDuration;
        this.bus.emit('shield', { on: true });
        break;
      case 'overdrive':
        player.overdrive = POWER.overdriveDuration;
        seconds = POWER.overdriveDuration;
        break;
      case 'phase':
        player.phase = POWER.phaseDuration;
        seconds = POWER.phaseDuration;
        break;
      case 'magnet':
        player.magnet = POWER.magnetDuration;
        seconds = POWER.magnetDuration;
        break;
      case 'credit':
        player.addScore(COMBO.points.pickupCredit);
        break;
    }
    if (kind !== 'credit') player.addScore(COMBO.points.pickupEnergy);
    player.stats.pickups++;
    this.bus.emit('pickup', { kind, score: 0 });
    if (seconds > 0) this.bus.emit('powerup', { kind, seconds });
    this.fx.emit('pickup', 0, 0, 0, { size: 2.4, color: kind === 'energy' ? 0 : 2, power: 1, s: e.cs, u: e.cu, h: e.ch });
  }

  // ---- objectives and warnings ---------------------------------------------------------

  private updateObjective(dt: number): void {
    this.objectiveTimer = Math.max(0, this.objectiveTimer - dt);
    if (this.time < this.nextObjectiveAt) return;
    const row = this.currentRow;
    const ahead = this.lookaheadRow(14);
    let key: StringKey = 'objective.free';
    let hold = 5.5;
    const progress = this.progress;

    if (row.flags & RF.intro) {
      key = 'objective.launch';
      hold = 8;
    } else if (this.spectacle.state.shockwaveActive) {
      key = 'objective.shockwave';
      hold = 6;
    } else if (this.spectacle.state.warp > 0.3) {
      key = 'objective.wormhole';
      hold = 6;
    } else if (this.spectacle.state.interior > 0.3) {
      key = 'objective.star';
      hold = 7;
    } else if ((ahead.flags & RF.collapseCapable) !== 0 && this.collapseWarnActive()) {
      key = 'objective.collapse';
      hold = 5;
    } else if (progress > 0.94) {
      key = 'objective.finish';
      hold = 8;
    } else if ((row.flags & RF.boostGate) !== 0) {
      key = 'objective.gates';
      hold = 5;
    } else if (row.section === 'intro' && this.player.timeSec < 22) {
      key = 'objective.steer';
      hold = 6;
    }

    if (key !== this.objective) {
      this.objective = key;
      this.objectiveTimer = hold;
      this.nextObjectiveAt = this.time + hold;
      this.bus.emit('objective', { key, holdSeconds: hold });
    }
  }

  private collapseWarnActive(): boolean {
    return this.warnings.some((w) => w.key === 'warn.collapse' && w.life > 0);
  }

  private lookaheadRow(rows_: number): LaneRow {
    const idx = clamp(this.config.path.rowAt(this.player.s) + rows_, 0, this.config.rows.length - 1);
    return this.config.rows[idx];
  }

  private updateWarnings(sweep: SweepResult, dt: number): void {
    for (const w of this.warnings) w.life -= dt;
    for (let i = this.warnings.length - 1; i >= 0; i--) {
      if (this.warnings[i].life <= 0) this.warnings.splice(i, 1);
    }
    if (this.time < this.nextWarningAt) return;
    const reaction = DIFFICULTY[this.config.difficulty].reactionScale;
    const look = 300 * reaction;
    const add = (key: StringKey, side: number, distance: number) => {
      if (this.warnings.some((w) => w.key === key)) return;
      this.warnings.push({ key, side, distance, life: WARNING_LIFE });
      this.nextWarningAt = this.time + WARNING_LIFE * 0.75;
      this.bus.emit('warning', { key, side, distance });
    };
    if (sweep.nearestPlasma > 0 && sweep.nearestPlasma < look) add('warn.plasma', 0, sweep.nearestPlasma);
    else if (sweep.nearestMine > 0 && sweep.nearestMine < look * 0.8) add('warn.mine', 0, sweep.nearestMine);
    else if (sweep.nearestRogue > 0 && sweep.nearestRogue < look) add('warn.rogue', 0, sweep.nearestRogue);
    else if (sweep.nearestAnomaly > 0 && sweep.nearestAnomaly < look) add('warn.anomaly', 0, sweep.nearestAnomaly);
    else if (sweep.nearestAsteroid > 0 && sweep.nearestAsteroid < look * 0.55) add('warn.asteroid', 0, sweep.nearestAsteroid);
    const row = this.currentRow;
    if (row.lanes === 2 && this.lookaheadRow(2).lanes === 1) add('warn.split', 0, 60);
  }

  private checkEnd(): void {
    if (this.status !== 'running') return;
    if (this.player.s >= this.config.length - LANE.rowLen * 0.5) {
      this.status = 'finished';
      this.player.finished = true;
      this.player.finishTime = this.raceClock;
      // Reaching the end is its own reward line on the results screen.
      this.player.addScore(Math.round(450 * this.player.tuning.scoreMultiplier), false, 'finish');
    }
  }

  /** Snapshot of the values the HUD renders, resolved once per frame. */
  readonly hud = {
    speed: 0,
    energy: 0,
    multiplier: 1,
    chain: 0,
    score: 0,
    progress: 0,
    shield: 0,
    ability: 0,
    time: 0,
    boosting: false,
    perfect: false,
    phase: 0,
    overdrive: 0,
    magnet: 0,
    objective: 'objective.launch' as StringKey,
    driftCharge: 0,
    collapsePressure: 0,
  };

  updateHud(): void {
    const p = this.player;
    const h = this.hud;
    h.speed = p.speed;
    h.energy = p.energy;
    h.multiplier = p.multiplier;
    h.chain = p.chain;
    h.score = Math.round(p.score);
    h.progress = this.progress;
    h.shield = p.shieldHits > 0 ? p.shieldTimer / POWER.shieldDuration : 0;
    h.ability = clamp01(p.abilityCharge / BOOST_ABILITY_COST);
    h.time = this.raceClock;
    h.boosting = p.boostEnvelope > 0.35;
    h.perfect = p.perfectTimer > 0;
    h.phase = p.phase;
    h.overdrive = p.overdrive;
    h.magnet = p.magnet;
    h.objective = this.objective;
    h.driftCharge = p.driftCharge;
    h.collapsePressure = clamp01(this.collapse.activeCount / 3);
  }

  /** 0..1 lane roll / pitch used to blend the camera and HUD horizon. */
  get laneAttitude(): { roll: number; pitch: number; yaw: number } {
    return { roll: this.laneRoll, pitch: this.lanePitch, yaw: this.laneYaw };
  }

  rowWindow(base: number, count: number, out: Float32Array): Float32Array {
    this.collapse.writeWindow(out, base, count);
    return out;
  }
}

const BOOST_PAD_ENERGY = 26;
const BOOST_ABILITY_COST = 7;
const BOOST_RING = 6;
const PULL_CAP = 260;
const WARNING_LIFE = 2.6;
