import { COMBO, HAZARD, LANE } from '../data/config.ts';
import type { DifficultyTuning } from '../data/types.ts';
import { clamp, clamp01, damp, lerp } from '../utils/math.ts';
import { type LaneRow, type SpectacleId } from './trackTypes.ts';
import type { PlayerState } from './PlayerState.ts';
import type { RaceBus } from './events.ts';
import type { FxQueue } from './FxQueue.ts';
import type { LanePath } from './LanePath.ts';

export interface SpectacleState {
  active: SpectacleId | null;
  /** 0..1 progress through the current beat. */
  progress: number;
  /** Absolute lane position of the shockwave front, or -1 when inactive. */
  shockwaveS: number;
  shockwaveActive: boolean;
  /** 0..1 chase pressure for the HUD and audio. */
  shockPressure: number;
  /** Global warp amount used by the renderer and post-processing. */
  warp: number;
  /** Interior-of-a-star glow amount. */
  interior: number;
  /** Black-hole vortex pull strength. */
  vortex: number;
}

interface Beat {
  id: SpectacleId;
  startRow: number;
  endRow: number;
  fired: boolean;
}

const WORMHOLE_ENERGY = 30;

/**
 * Orchestrates the memorable moments of a lane: wormhole transit, the interior of a collapsing
 * star, the twin-rock squeeze, a shockwave chase, a gate sprint, a black-hole vortex and the
 * finish warp.
 *
 * Beats change the staging — world effects, camera pressure, audio intensity, the physics of a
 * chasing shockwave — but never take control away from the player.
 */
export class SpectacleRunner {
  private beats: Beat[] = [];
  readonly state: SpectacleState = {
    active: null,
    progress: 0,
    shockwaveS: -1,
    shockwaveActive: false,
    shockPressure: 0,
    warp: 0,
    interior: 0,
    vortex: 0,
  };
  private shockTimer = 0;
  private shockHits = 0;

  constructor(
    private readonly rows: LaneRow[],
    private readonly diff: DifficultyTuning,
    private readonly bus: RaceBus,
    private readonly fx: FxQueue,
    private readonly path: LanePath,
  ) {}

  reset(): void {
    this.state.active = null;
    this.state.progress = 0;
    this.state.shockwaveS = -1;
    this.state.shockwaveActive = false;
    this.state.shockPressure = 0;
    this.state.warp = 0;
    this.state.interior = 0;
    this.state.vortex = 0;
    this.shockTimer = 0;
    this.shockHits = 0;
    const beats: Beat[] = [];
    for (const row of this.rows) {
      if (!row.spectacle) continue;
      const last = beats[beats.length - 1];
      if (last && last.id === row.spectacle && row.index === last.endRow + 1) last.endRow = row.index;
      else beats.push({ id: row.spectacle, startRow: row.index, endRow: row.index, fired: false });
    }
    this.beats = beats;
  }

  update(dt: number, player: PlayerState): void {
    const s = this.state;
    const lead = LANE.rowLen * 3;
    let active: SpectacleId | null = null;
    let progress = 0;
    let warpTarget = 0;
    let interiorTarget = 0;
    let vortexTarget = 0;

    for (const beat of this.beats) {
      const startS = this.rows[beat.startRow].s0;
      const endS = this.rows[beat.endRow].s1;
      if (!beat.fired && player.s > startS - lead) {
        beat.fired = true;
        this.bus.emit('spectacle', { id: beat.id, phase: 'enter', row: beat.startRow });
        this.onEnter(beat.id, player);
      }
      if (beat.fired && player.s > endS + LANE.rowLen) {
        beat.fired = false;
        beat.startRow = Math.min(this.rows.length - 1, beat.endRow + 1);
        this.bus.emit('spectacle', { id: beat.id, phase: 'exit', row: beat.endRow });
      }
      if (player.s >= startS - lead && player.s <= endS) {
        active = beat.id;
        progress = clamp01((player.s - (startS - lead)) / Math.max(1, endS - startS + lead));
        if (beat.id === 'wormhole') warpTarget = 1;
        else if (beat.id === 'starInterior') interiorTarget = 1;
        else if (beat.id === 'vortex') vortexTarget = 1;
      }
    }

    s.active = active;
    s.progress = active ? progress : 0;
    s.warp = damp(s.warp, warpTarget, 3.4, dt);
    s.interior = damp(s.interior, interiorTarget, 2.4, dt);
    s.vortex = damp(s.vortex, vortexTarget, 2.4, dt);

    if (s.warp > 0.15) {
      // Transit hands the player a free speed envelope: the lane is carrying them.
      player.speed = Math.max(player.speed, this.diff.maxSpeed * lerp(1.02, 1.18, s.warp));
    }
    if (s.interior > 0.1) {
      this.fx.emit('dust', 0, 0, 0, { power: s.interior, size: 1, color: 2, s: player.s, u: 0, h: player.h });
    }
    if (s.vortex > 0.1) {
      const t = player.timeSec;
      player.push(Math.sin(t * 0.7) * 160 * s.vortex * this.diff.aiPressure * dt, Math.cos(t * 0.53) * 42 * s.vortex * dt);
    }

    this.updateShockwave(dt, player);
  }

  private updateShockwave(dt: number, player: PlayerState): void {
    const s = this.state;
    if (!s.shockwaveActive) {
      s.shockPressure = damp(s.shockPressure, 0, 4, dt);
      return;
    }
    this.shockTimer += dt;
    // The front travels slightly faster than a coasting ship, so idling is always punished.
    const waveSpeed = this.diff.baseSpeed * 1.08 + this.diff.maxSpeed * 0.16 * this.diff.aiPressure;
    s.shockwaveS += waveSpeed * dt;
    const gap = player.s - s.shockwaveS;
    s.shockPressure = clamp01(1 - gap / 220);
    if (gap < 14) {
      this.shockHits++;
      player.applyHit(1.3);
      this.bus.emit('shockwaveHit', { row: this.path.rowAt(player.s) });
      s.shockwaveS -= 60;
    }
    if (this.shockTimer > HAZARD.shockwave.activeSeconds) {
      s.shockwaveActive = false;
      s.shockwaveS = -1;
      if (this.shockHits === 0) {
        player.noteSkill('shockwaveEscape');
        const gained = player.addScore(COMBO.points.shockwaveEscape);
        this.bus.emit('shockwaveEscape', { score: gained });
      }
    }
  }

  private onEnter(id: SpectacleId, player: PlayerState): void {
    if (id === 'shockwave') {
      this.state.shockwaveActive = true;
      this.state.shockwaveS = Math.max(0, player.s - 150);
      this.shockTimer = 0;
      this.shockHits = 0;
      this.bus.emit('shockwaveStart', { fromRow: this.path.rowAt(player.s) });
    } else if (id === 'wormhole') {
      player.addEnergy(WORMHOLE_ENERGY);
    }
  }

  /** How close a shockwave front is to a given lane position: 0 (far) → 1 (contact). */
  shockProximity(s: number): number {
    if (!this.state.shockwaveActive) return 0;
    return clamp(1 - (s - this.state.shockwaveS) / 180, 0, 1);
  }
}
