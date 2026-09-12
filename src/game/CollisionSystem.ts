import { HAZARD, LANE, POWER } from '../data/config.ts';
import type { PickupKind } from '../data/types.ts';
import type { PlayerState } from './PlayerState.ts';
import { EF, EntityMotion, type LaneEntity, type LaneRow } from './trackTypes.ts';

export enum Contact {
  None = 0,
  Hit = 1,
  NearMiss = 2,
  Gate = 3,
  Pad = 4,
  Cell = 5,
}

export interface ContactEvent {
  entity: LaneEntity | null;
  contact: Contact;
  /** Metres from the ship surface at closest approach (negative when overlapping). */
  distance: number;
  s: number;
  u: number;
  h: number;
}

export interface SweepResult {
  events: ContactEvent[];
  count: number;
  pullU: number;
  pullH: number;
  /** Distance in metres to the nearest hazard of each class, or -1 when none is in range. */
  nearestAsteroid: number;
  nearestMine: number;
  nearestPlasma: number;
  nearestRogue: number;
  nearestAnomaly: number;
}

const SHIP_S = 2.7;
const SHIP_U = LANE.shipRadiusU;
const SHIP_H = LANE.shipRadiusH;

/** Signed separation along `s`; <= 0 means the swept interval overlaps the object. */
function sGap(center: number, radius: number, s0: number, s1: number, shipLength: number): number {
  const lo = center - radius - shipLength * 0.5;
  const hi = center + radius + shipLength * 0.5;
  if (hi < s0) return s0 - hi;
  if (lo > s1) return lo - s1;
  return -(Math.min(hi, s1) - Math.max(lo, s0));
}

export function createSweepResult(capacity = 32): SweepResult {
  const events: ContactEvent[] = [];
  for (let i = 0; i < capacity; i++) events.push({ entity: null, contact: Contact.None, distance: 0, s: 0, u: 0, h: 0 });
  return {
    events,
    count: 0,
    pullU: 0,
    pullH: 0,
    nearestAsteroid: -1,
    nearestMine: -1,
    nearestPlasma: -1,
    nearestRogue: -1,
    nearestAnomaly: -1,
  };
}

/**
 * Sweeps the lane band the player crossed this step and resolves every interaction.
 *
 * Tests are analytic in lane space over an `s` interval — no raycasts, no physics engine —
 * so they are exact at any frame rate, cannot tunnel at 350 m/s and cost microframes.
 */
export class CollisionSystem {
  /**
   * @param windowAhead how far ahead of the ship motion is evaluated (metres)
   */
  sweep(
    entities: LaneEntity[],
    rows: LaneRow[],
    player: PlayerState,
    time: number,
    dt: number,
    windowAhead: number,
    out: SweepResult,
  ): SweepResult {
    out.count = 0;
    out.pullU = 0;
    out.pullH = 0;
    out.nearestAsteroid = -1;
    out.nearestMine = -1;
    out.nearestPlasma = -1;
    out.nearestRogue = -1;
    out.nearestAnomaly = -1;

    const s0 = Math.min(player.prevS, player.s);
    const s1 = Math.max(player.prevS, player.s);
    const rowFrom = Math.max(0, Math.floor((s0 - LANE.rowLen * 2) / LANE.rowLen));
    const rowTo = Math.min(rows.length - 1, Math.floor((s1 + windowAhead) / LANE.rowLen));
    const magnetR = player.magnet > 0 ? POWER.magnetRadius : 0;

    for (let ri = rowFrom; ri <= rowTo; ri++) {
      const row = rows[ri];
      const limit = Math.max(0, row.halfWidth - 0.5);
      for (let ei = row.entityStart; ei < row.entityEnd; ei++) {
        const e = entities[ei];
        if (!e || e.s < s0 - LANE.rowLen * 2 || e.s > s1 + windowAhead) continue;
        this.move(e, time, limit, row.height);
        const ahead = e.cs - player.s;
        switch (e.kind) {
          case 'asteroid':
          case 'shard':
          case 'rogue':
          case 'wreck':
            this.solid(e, player, s0, s1, out, ahead);
            break;
          case 'mine':
            this.mine(e, player, s0, s1, dt, out, ahead);
            break;
          case 'plasma':
            this.plasma(e, player, s0, s1, out, ahead);
            break;
          case 'anomaly':
            this.anomaly(e, player, out, ahead);
            break;
          case 'gate':
            this.gate(e, player, s0, s1, out);
            break;
          case 'boostpad':
            this.pad(e, player, s0, s1, out);
            break;
          case 'pickup':
            this.cell(e, player, s0, s1, out, magnetR);
            break;
          default:
            break;
        }
      }
    }
    return out;
  }

  private move(e: LaneEntity, time: number, limit: number, height: number): void {
    applyMotion(e, time, limit, height);
  }

  private push(e: LaneEntity, contact: Contact, distance: number, out: SweepResult): void {
    if (out.count >= out.events.length) return;
    const ev = out.events[out.count++];
    ev.entity = e;
    ev.contact = contact;
    ev.distance = distance;
    ev.s = e.cs;
    ev.u = e.cu;
    ev.h = e.ch;
  }

  private noteNearest(e: LaneEntity, ahead: number, out: SweepResult): void {
    if (ahead < 0 || ahead > 620) return;
    switch (e.kind) {
      case 'asteroid':
      case 'shard':
        out.nearestAsteroid = out.nearestAsteroid < 0 ? ahead : Math.min(out.nearestAsteroid, ahead);
        break;
      case 'mine':
        out.nearestMine = out.nearestMine < 0 ? ahead : Math.min(out.nearestMine, ahead);
        break;
      case 'plasma':
        out.nearestPlasma = out.nearestPlasma < 0 ? ahead : Math.min(out.nearestPlasma, ahead);
        break;
      case 'rogue':
        out.nearestRogue = out.nearestRogue < 0 ? ahead : Math.min(out.nearestRogue, ahead);
        break;
      case 'anomaly':
        out.nearestAnomaly = out.nearestAnomaly < 0 ? ahead : Math.min(out.nearestAnomaly, ahead);
        break;
      default:
        break;
    }
  }

  private solid(e: LaneEntity, player: PlayerState, s0: number, s1: number, out: SweepResult, ahead: number): void {
    this.noteNearest(e, ahead, out);
    if (e.tier === 0 || e.flags & EF.consumed) return;
    const ds = sGap(e.cs, e.r, s0, s1, SHIP_S);
    const du = Math.abs(e.cu - player.u) - (e.r + SHIP_U);
    const dh = Math.abs(e.ch - player.h) - (e.r + SHIP_H);
    if (ds <= 0 && du <= 0 && dh <= 0) {
      e.flags |= EF.consumed;
      this.push(e, Contact.Hit, Math.max(du, dh), out);
      return;
    }
    const clear = Math.max(du, dh);
    if (ds <= 8 && clear > 0 && clear < HAZARD.nearMissDistance && !(e.flags & EF.nearMissReported) && ahead > -6) {
      e.flags |= EF.nearMissReported;
      this.push(e, Contact.NearMiss, clear, out);
    }
  }

  private mine(e: LaneEntity, player: PlayerState, s0: number, s1: number, dt: number, out: SweepResult, ahead: number): void {
    this.noteNearest(e, ahead, out);
    if (e.flags & EF.exploded) return;
    const du = e.cu - player.u;
    const dh = e.ch - player.h;
    const ds = e.cs - player.s;
    const dist = Math.hypot(du, dh, ds);

    if (e.fuse > 0) {
      e.fuse -= dt;
      if (e.fuse <= 0) {
        e.fuse = 0;
        e.flags |= EF.exploded | EF.consumed;
        e.r = 0;
        e.tier = 0;
        e.kind = 'shard';
        if (dist < HAZARD.mine.blastRadius) this.push(e, Contact.Hit, dist - HAZARD.mine.blastRadius, out);
        else if (dist < HAZARD.mine.blastRadius + 10) this.push(e, Contact.NearMiss, dist, out);
      }
      return;
    }
    if (dist < HAZARD.mine.triggerRadius && !(e.flags & EF.armed)) {
      e.flags |= EF.armed;
      e.fuse = 0.34;
    }
    if (sGap(e.cs, e.r, s0, s1, SHIP_S) <= 0 && Math.abs(du) < e.r + SHIP_U && Math.abs(dh) < e.r + SHIP_H) {
      e.flags |= EF.exploded | EF.consumed;
      this.push(e, Contact.Hit, 0, out);
    }
  }

  private plasma(e: LaneEntity, player: PlayerState, s0: number, s1: number, out: SweepResult, ahead: number): void {
    this.noteNearest(e, ahead, out);
    if (e.flags & EF.consumed) return;
    const half = Math.max(1, e.size * 0.5);
    const lo = e.cu - half;
    const hi = e.cu + half;
    const ds = sGap(e.cs, HAZARD.plasma.thickness, s0, s1, SHIP_S);
    if (ds > 0) return;
    if (player.u + SHIP_U > lo && player.u - SHIP_U < hi) {
      e.flags |= EF.consumed;
      this.push(e, Contact.Hit, 0, out);
      return;
    }
    const edge = Math.min(Math.abs(player.u - lo), Math.abs(player.u - hi));
    if (edge < HAZARD.nearMissDistance && !(e.flags & EF.nearMissReported)) {
      e.flags |= EF.nearMissReported;
      this.push(e, Contact.NearMiss, edge, out);
    }
  }

  private anomaly(e: LaneEntity, player: PlayerState, out: SweepResult, ahead: number): void {
    this.noteNearest(e, ahead, out);
    const du = e.cu - player.u;
    const dh = e.ch - player.h;
    const ds = e.cs - player.s;
    const d = Math.hypot(du, dh, ds);
    const radius = HAZARD.anomaly.pullRadius * (e.size / 7);
    if (d >= radius || d < 0.001) return;
    const falloff = 1 - d / radius;
    const strength = HAZARD.anomaly.pullForce * falloff * falloff;
    out.pullU += (-du / d) * strength;
    out.pullH += (-dh / d) * strength * 0.5;
    if (d < e.size * 0.5 && !(e.flags & EF.consumed)) {
      e.flags |= EF.consumed;
      this.push(e, Contact.Hit, d, out);
    }
  }

  private gate(e: LaneEntity, player: PlayerState, s0: number, s1: number, out: SweepResult): void {
    if (e.flags & EF.consumed) return;
    if (e.cs < s0 || e.cs > Math.max(s1, s0 + 0.001)) return;
    const du = Math.abs(e.cu - player.u);
    const dh = Math.abs(e.ch - player.h);
    const r = Math.max(1, e.size);
    if (du < r * 0.94 && dh < r * 1.4) {
      e.flags |= EF.consumed;
      this.push(e, Contact.Gate, Math.hypot(du, dh), out);
    }
  }

  private pad(e: LaneEntity, player: PlayerState, s0: number, s1: number, out: SweepResult): void {
    if (e.flags & EF.consumed) return;
    if (sGap(e.cs, 3, s0, s1, SHIP_S) > 0) return;
    if (Math.abs(e.cu - player.u) > e.size) return;
    e.flags |= EF.consumed;
    this.push(e, Contact.Pad, 0, out);
  }

  private cell(e: LaneEntity, player: PlayerState, s0: number, s1: number, out: SweepResult, magnetR: number): void {
    if (e.flags & EF.consumed) return;
    const du = e.cu - player.u;
    const dh = e.ch - player.h;
    const ds = e.cs - player.s;
    const d = Math.hypot(du, dh, ds);
    if (magnetR > 0 && d < magnetR && d > 0.001) {
      const k = (1 - d / magnetR) * 0.3;
      e.cu -= du * k;
      e.ch -= dh * k;
      e.cs -= ds * k;
    }
    const grab = e.r + SHIP_U + (magnetR > 0 ? 4 : 0);
    if (sGap(e.cs, e.r, s0, s1, SHIP_S) > 0) return;
    if (Math.abs(du) > grab || Math.abs(dh) > grab + 1.5) return;
    e.flags |= EF.consumed;
    e.active = false;
    this.push(e, Contact.Cell, 0, out);
  }

  /** Clears per-run interaction state so a restart replays identically. */
  reset(entities: LaneEntity[]): void {
    for (const e of entities) {
      e.flags = 0;
      e.fuse = 0;
      e.cu = e.u;
      e.ch = e.h;
      e.cs = e.s;
      if (e.kind === 'shard' && e.r === 0) continue;
      e.active = e.r > 0 || e.tier === 0;
    }
  }
}

function clampUnit(v: number, limit: number): number {
  return clamp(v, -limit, limit);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Evaluates an entity's animated position at a sim time. Shared by collision and the renderer
 * so a hazard can never appear somewhere the simulation did not put it.
 */
export function applyMotion(e: LaneEntity, time: number, limit: number, height: number): void {
  if (e.motion === EntityMotion.Static) {
    e.cu = e.u;
    e.ch = e.h;
    e.cs = e.s;
    return;
  }
  const w = time * e.freq * Math.PI * 2 + e.phase0;
  switch (e.motion) {
    case EntityMotion.LateralSine:
      e.cu = clampUnit(e.u + Math.sin(w) * e.ampU, limit - e.r);
      e.ch = e.h;
      break;
    case EntityMotion.LateralTraverse:
      e.cu = clampUnit(Math.sin(w) * e.ampU, limit - e.r);
      e.ch = e.h;
      break;
    case EntityMotion.VerticalSine:
      e.cu = clampUnit(e.u, limit - e.r);
      e.ch = clamp(e.h + Math.sin(w) * e.ampH, 0.6, height - 1);
      break;
    case EntityMotion.Orbit:
      e.cu = clampUnit(e.u + Math.cos(w) * 2.2, limit - e.r);
      e.ch = clamp(e.h + Math.sin(w * 0.7) * 2.2, 0.5, height - 0.6);
      break;
    default:
      e.cu = e.u;
      e.ch = e.h;
      break;
  }
  e.cs = e.s;
}

export function pickupKind(entity: LaneEntity): PickupKind {
  return entity.pickup || 'energy';
}
