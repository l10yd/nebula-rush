import { COLLAPSE, COMBO, LANE } from '../data/config.ts';
import type { DifficultyTuning } from '../data/types.ts';
import { clamp, clamp01 } from '../utils/math.ts';
import { CollapsePhase, RF, type LaneRow } from './trackTypes.ts';
import type { PlayerState } from './PlayerState.ts';
import type { RaceBus } from './events.ts';
import type { FxQueue } from './FxQueue.ts';
import type { LanePath } from './LanePath.ts';
import { createFrame } from './LanePath.ts';

type EventPhase = 'idle' | 'warn' | 'fracture' | 'gone' | 'reform' | 'done';

interface CollapseEvent {
  rows: LaneRow[];
  startRow: number;
  endRow: number;
  side: number;
  phase: EventPhase;
  t: number;
  hitPlayer: boolean;
  rewarded: boolean;
  /** True once the ship has reached the event's first row. */
  entered: boolean;
}

/**
 * The signature system: sections of the star lane are unstable.
 *
 * Every event runs a telegraphed four-stage timeline — cracks spread, the corridor lights
 * change, a rising tone sounds, then the marked lateral band physically drops away. The band
 * is authored by the generator so at least one route always survives, and the player only
 * ever loses ground they were warned about.
 */
export class CollapseDirector {
  private events: CollapseEvent[] = [];
  private readonly frame = createFrame();
  private cooldown = 0;
  /** Rows currently unsafe to occupy: used by the renderer and by AI/pressure logic. */
  activeCount = 0;

  constructor(
    private readonly rows: LaneRow[],
    private readonly diff: DifficultyTuning,
    private readonly bus: RaceBus,
    private readonly fx: FxQueue,
    private readonly path: LanePath,
  ) {}

  reset(): void {
    this.events = [];
    this.cooldown = 6 / this.diff.reactionScale;
    this.activeCount = 0;
    const capable = this.rows.filter((r) => (r.flags & RF.collapseCapable) !== 0);
    // Group contiguous capable rows into events, spaced out across the lane.
    let i = 0;
    const gap = Math.max(6, Math.round(COLLAPSE.minGapRows / this.diff.reactionScale));
    while (i < capable.length) {
      const group: LaneRow[] = [capable[i]];
      let j = i + 1;
      while (j < capable.length && group.length < COLLAPSE.spreadMax && capable[j].index - group[group.length - 1].index <= 2) {
        group.push(capable[j]);
        j++;
      }
      const side = group[0].unsafeSide !== -1 ? group[0].unsafeSide : j % 2 === 0 ? -1 : 1;
      this.events.push({
        rows: group,
        startRow: group[0].index,
        endRow: group[group.length - 1].index,
        side,
        phase: 'idle',
        t: 0,
        hitPlayer: false,
        rewarded: false,
        entered: false,
      });
      i = j;
      while (i < capable.length && capable[i].index - group[group.length - 1].index < gap) i++;
    }
    for (const row of this.rows) {
      row.phase = CollapsePhase.Solid;
      row.phaseT = 0;
    }
  }

  get eventCount(): number {
    return this.events.length;
  }

  update(dt: number, player: PlayerState): void {
    this.cooldown = Math.max(0, this.cooldown - dt);
    const scale = this.diff.reactionScale;
    let active = 0;
    const pu = this.normalizedPlayerU(player);

    for (const ev of this.events) {
      const startS = ev.rows[0].s0;
      const endS = ev.rows[ev.rows.length - 1].s1;
      const distance = startS - player.s;
      // Arm by ETA, not by distance: the band must drop just as the player arrives at it,
      // whatever their speed, otherwise the drama happens behind them and reads as noise.
      const eta = distance / Math.max(40, player.speed);
      const warnDur = COLLAPSE.warnTime * scale;
      const fracDur = COLLAPSE.fractureTime * scale;
      const armEta = warnDur + fracDur + COLLAPSE.armLeadSeconds * scale;

      if (ev.phase === 'idle') {
        if (eta < armEta && distance > -LANE.rowLen * 2 && this.cooldown <= 0) {
          ev.phase = 'warn';
          ev.t = 0;
          ev.hitPlayer = false;
          ev.rewarded = false;
          ev.entered = false;
          this.cooldown = Math.max(2, COLLAPSE.goneTime * 0.5 / scale);
          for (const row of ev.rows) {
            row.phase = CollapsePhase.Warn;
            row.phaseT = 0;
          }
          const safeSide = -ev.side;
          this.bus.emit('collapseWarn', { side: ev.side, safeSide, row: ev.startRow });
          this.bus.emit('warning', { key: 'warn.collapse', side: safeSide, distance: Math.max(0, distance) });
        } else {
          continue;
        }
      }

      ev.t += dt;
      if (!ev.entered && player.s >= startS - LANE.rowLen * 0.5) {
        ev.entered = true;
        // Crossing into a section that is already breaking: the money moment.
        if (ev.phase === 'fracture' || ev.phase === 'gone') {
          if (this.inBand(ev, pu)) this.punish(ev, player, pu);
          else this.judge(ev, player, pu, true);
        }
      }
      switch (ev.phase) {
        case 'warn': {
          const dur = COLLAPSE.warnTime * scale;
          const k = clamp01(ev.t / dur);
          for (const row of ev.rows) {
            row.phase = CollapsePhase.Warn;
            row.phaseT = k;
          }
          if (ev.t >= dur) {
            ev.phase = 'fracture';
            ev.t = 0;
            for (const row of ev.rows) row.phase = CollapsePhase.Fracture;
            this.breakFx(ev);
            this.bus.emit('collapseBreak', { side: ev.side, row: ev.startRow });
          }
          break;
        }
        case 'fracture': {
          const dur = COLLAPSE.fractureTime * scale;
          const k = clamp01(ev.t / dur);
          for (const row of ev.rows) {
            row.phase = CollapsePhase.Fracture;
            row.phaseT = k;
          }
          if (player.s > startS - 6 && player.s < endS + 6 && this.inBand(ev, pu)) {
            this.punish(ev, player, pu);
          }
          if (ev.t >= dur) {
            ev.phase = 'gone';
            ev.t = 0;
            for (const row of ev.rows) row.phase = CollapsePhase.Gone;
            this.judge(ev, player, pu, true);
          }
          break;
        }
        case 'gone': {
          const dur = COLLAPSE.goneTime * scale;
          const k = clamp01(ev.t / dur);
          for (const row of ev.rows) {
            row.phase = CollapsePhase.Gone;
            row.phaseT = k;
          }
          active++;
          if (player.s > startS - 4 && player.s < endS + 4 && this.inBand(ev, pu)) {
            this.punish(ev, player, pu);
          }
          if (ev.t >= dur) {
            ev.phase = 'reform';
            ev.t = 0;
            for (const row of ev.rows) row.phase = CollapsePhase.Reform;
          }
          break;
        }
        case 'reform': {
          const dur = COLLAPSE.reformTime * scale;
          const k = clamp01(ev.t / dur);
          for (const row of ev.rows) {
            row.phase = CollapsePhase.Reform;
            row.phaseT = k;
          }
          if (ev.t >= dur) {
            // The group has played out; events only ever sit ahead of the ship, so retire it.
            ev.phase = 'done';
            for (const row of ev.rows) {
              row.phase = CollapsePhase.Solid;
              row.phaseT = 0;
            }
          }
          break;
        }
        default:
          break;
      }
    }
    this.activeCount = active;
  }

  private normalizedPlayerU(player: PlayerState): number {
    this.path.frameAt(player.s, this.frame);
    const hw = Math.max(1, this.frame.hw);
    return clamp(player.u / hw, -1, 1);
  }

  private inBand(ev: CollapseEvent, pu: number): boolean {
    const row = ev.rows[0];
    if (row.unsafeU1 <= row.unsafeU0) return false;
    return pu >= row.unsafeU0 && pu <= row.unsafeU1;
  }

  private judge(ev: CollapseEvent, player: PlayerState, pu: number, justBroke: boolean): void {
    const startS = ev.rows[0].s0;
    const endS = ev.rows[ev.rows.length - 1].s1;
    const near = player.s > startS - LANE.rowLen * 2 && player.s < endS + LANE.rowLen * 3;
    if (justBroke && near && !this.inBand(ev, pu) && !ev.rewarded) {
      ev.rewarded = true;
      player.stats.collapsesEscaped++;
      player.noteSkill('collapseEscape');
      const gained = player.addScore(COMBO.points.collapseEscape);
      this.bus.emit('collapseEscape', { row: ev.startRow, score: gained });
    }
  }

  private punish(ev: CollapseEvent, player: PlayerState, pu: number): void {
    if (ev.hitPlayer) return;
    ev.hitPlayer = true;
    player.applyHit(1.25);
    this.bus.emit('collapseHit', { row: ev.startRow });
    // Nudge the ship back onto the surviving route so the player is never helplessly stuck.
    const row = ev.rows[0];
    const dir = pu > (row.unsafeU0 + row.unsafeU1) / 2 ? -1 : 1;
    player.push(dir * 16, -6);
    this.path.frameAt(player.s, this.frame);
    this.fx.emit('collapseFrag', this.frame.px, this.frame.py, this.frame.pz, {
      size: 6,
      color: 3,
      power: 1,
      s: player.s,
      u: player.u,
      h: player.h,
    });
  }

  private breakFx(ev: CollapseEvent): void {
    for (const row of ev.rows) {
      const s = row.s0 + LANE.rowLen * 0.5;
      this.path.frameAt(s, this.frame);
      const hw = this.frame.hw;
      const u = ((row.unsafeU0 + row.unsafeU1) / 2) * hw;
      this.fx.emit('collapseFrag', this.frame.px + this.frame.rx * u, this.frame.py + this.frame.ry * u, this.frame.pz + this.frame.rz * u, {
        size: 8,
        color: 3,
        power: 1,
        s,
        u,
        h: this.frame.hh * 0.5,
      });
    }
  }

  /** Packs the per-row instability data the tunnel shader needs for the visible window. */
  writeWindow(out: Float32Array, baseRow: number, count: number): void {
    for (let i = 0; i < count; i++) {
      const row = this.rows[baseRow + i];
      const o = i * 4;
      if (!row) {
        out[o] = 0;
        out[o + 1] = 0;
        out[o + 2] = 0;
        out[o + 3] = 0;
        continue;
      }
      // x: phase + progress (packed), y: unsafe u0, z: unsafe u1, w: flags
      out[o] = row.phase + row.phaseT;
      out[o + 1] = row.unsafeU0;
      out[o + 2] = row.unsafeU1;
      out[o + 3] = row.lanes === 2 ? 1 : 0;
    }
  }
}
