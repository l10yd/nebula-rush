import { COLLAPSE, DIFFICULTY, LANE, RACE, SPECTACLE } from '../data/config.ts';
import type { BiomeId, DifficultyId, DifficultyTuning, PickupKind } from '../data/types.ts';
import { Rng } from '../core/rng.ts';
import { clamp, clamp01, lerp, smoothstep } from '../utils/math.ts';
import { CollapsePhase, EntityMotion, RF, type GeneratedTrack, type LaneEntity, type LaneRow, type SectionId, type SpectacleId, type TrackMeta } from './trackTypes.ts';
import { LanePath } from './LanePath.ts';

export interface GenerateOptions {
  seed: string;
  difficulty: DifficultyId;
  biome: BiomeId;
  /** Fixed-length override (the daily lane uses it so everyone races the same distance). */
  rowCountOverride?: number;
}

interface SectionDef {
  id: SectionId;
  rows: [number, number];
  yaw: [number, number];
  pitch: [number, number];
  bank: number;
  width: [number, number];
  lanes: 1 | 2;
  threat: number;
  minProgress: number;
  weight: number;
}

const SECTIONS: SectionDef[] = [
  { id: 'straight', rows: [8, 16], yaw: [-0.0012, 0.0012], pitch: [-0.0012, 0.0012], bank: 0.1, width: [8.6, 11.4], lanes: 1, threat: 0.5, minProgress: 0, weight: 1 },
  { id: 'sweep', rows: [12, 22], yaw: [-0.0062, 0.0062], pitch: [-0.0028, 0.0028], bank: 1, width: [8.4, 11], lanes: 1, threat: 0.75, minProgress: 0, weight: 1.5 },
  { id: 'tight', rows: [10, 16], yaw: [-0.0106, 0.0106], pitch: [-0.004, 0.004], bank: 1.35, width: [7.6, 9.6], lanes: 1, threat: 1, minProgress: 0.16, weight: 1.1 },
  { id: 'climb', rows: [10, 18], yaw: [-0.004, 0.004], pitch: [0.0044, 0.0072], bank: 0.5, width: [8.6, 11], lanes: 1, threat: 0.7, minProgress: 0.1, weight: 1 },
  { id: 'dive', rows: [10, 18], yaw: [-0.004, 0.004], pitch: [-0.0072, -0.0044], bank: 0.5, width: [8.6, 11], lanes: 1, threat: 0.7, minProgress: 0.1, weight: 1 },
  { id: 'bank', rows: [8, 14], yaw: [-0.0088, 0.0088], pitch: [-0.0018, 0.0018], bank: 2.1, width: [8, 10], lanes: 1, threat: 0.85, minProgress: 0.22, weight: 0.9 },
  { id: 'narrow', rows: [7, 13], yaw: [-0.005, 0.005], pitch: [-0.002, 0.002], bank: 0.7, width: [LANE.narrowHalfWidth, 6.6], lanes: 1, threat: 0.8, minProgress: 0.18, weight: 0.8 },
  { id: 'split', rows: [10, 18], yaw: [-0.0045, 0.0045], pitch: [-0.003, 0.003], bank: 0.8, width: [10.6, LANE.wideHalfWidth], lanes: 2, threat: 0.9, minProgress: 0.2, weight: 1 },
  { id: 'asteroids', rows: [10, 20], yaw: [-0.004, 0.004], pitch: [-0.0022, 0.0022], bank: 0.8, width: [9.4, 12], lanes: 1, threat: 1.15, minProgress: 0.24, weight: 1.2 },
  { id: 'mines', rows: [8, 14], yaw: [-0.0035, 0.0035], pitch: [-0.002, 0.002], bank: 0.6, width: [8.8, 11], lanes: 1, threat: 1.05, minProgress: 0.3, weight: 0.85 },
  { id: 'plasma', rows: [8, 15], yaw: [-0.003, 0.003], pitch: [-0.0016, 0.0016], bank: 0.7, width: [9.8, 12.2], lanes: 1, threat: 1.1, minProgress: 0.36, weight: 0.95 },
  { id: 'anomaly', rows: [9, 15], yaw: [-0.0052, 0.0052], pitch: [-0.003, 0.003], bank: 1.1, width: [10, 12.6], lanes: 1, threat: 0.85, minProgress: 0.4, weight: 0.8 },
  { id: 'rogue', rows: [7, 12], yaw: [-0.003, 0.003], pitch: [-0.0014, 0.0014], bank: 0.6, width: [10, 12.6], lanes: 1, threat: 1.2, minProgress: 0.48, weight: 0.75 },
  { id: 'boostRun', rows: [10, 18], yaw: [-0.002, 0.002], pitch: [-0.0012, 0.0012], bank: 0.35, width: [10.2, 12.6], lanes: 1, threat: 0.25, minProgress: 0, weight: 1.15 },
  { id: 'reward', rows: [6, 10], yaw: [-0.0016, 0.0016], pitch: [-0.001, 0.001], bank: 0.25, width: [9.6, 12], lanes: 1, threat: 0.1, minProgress: 0, weight: 0.8 },
  { id: 'collapse', rows: [9, 16], yaw: [-0.005, 0.005], pitch: [-0.0026, 0.0026], bank: 1.2, width: [10.6, LANE.wideHalfWidth], lanes: 1, threat: 0.95, minProgress: 0.14, weight: 1.05 },
];

const MAX_YAW = 0.0118;
const MAX_PITCH_RATE = 0.0078;
const MAX_ROLL = 1.15;
const YAW_SLEW = 0.0016;
const PITCH_SLEW = 0.0012;
const ROLL_SLEW = 0.1;
const WIDTH_SLEW = 0.95;
/** Widest obstacle-free corridor that must exist at every point of the lane (metres). */
const MIN_GAP = 6.6;
/** Split branches are tight by design: they only have to fit the ship plus steering margin. */
const BRANCH_GAP = 4.4;

const PICKUP_TABLE: { value: PickupKind; weight: number }[] = [
  { value: 'energy', weight: 42 },
  { value: 'credit', weight: 24 },
  { value: 'shield', weight: 12 },
  { value: 'overdrive', weight: 9 },
  { value: 'phase', weight: 7 },
  { value: 'magnet', weight: 6 },
];

let nextEntityId = 1;

function approach(v: number, target: number, slew: number): number {
  const d = target - v;
  return Math.abs(d) <= slew ? target : v + Math.sign(d) * slew;
}

/**
 * Seeded star-lane generator.
 *
 * Output depends only on (seed, difficulty, biome) so a race is reproducible and balancable.
 * Sections are authored as rate-limited parameter targets, which makes the centreline smooth
 * by construction; a final validation pass guarantees a passable racing line everywhere and
 * pre-computes the lateral bands that collapse events will later make deadly.
 */
export class TrackGenerator {
  private rng!: Rng;
  private diff!: DifficultyTuning;
  private biome: BiomeId = 'deep_space';
  private rows: LaneRow[] = [];
  private entities: LaneEntity[] = [];

  generate(opts: GenerateOptions): GeneratedTrack {
    this.rng = new Rng(opts.seed);
    this.diff = DIFFICULTY[opts.difficulty];
    this.biome = opts.biome;
    this.rows = [];
    this.entities = [];

    const avgSpeed = this.diff.maxSpeed * RACE.avgSpeedRatio;
    const rowCount =
      opts.rowCountOverride ??
      clamp(Math.round((avgSpeed * RACE.targetSeconds) / LANE.rowLen), RACE.minRows, RACE.maxRows);

    this.authorRows(rowCount);
    const gateCount = this.populate();
    const spectacle = this.placeSpectacles();
    const collapsePlan = this.planCollapses();
    this.assignCollapseBands(collapsePlan);
    this.enforcePassableLine();
    const meta = this.describe(rowCount, gateCount, spectacle, collapsePlan.length, opts.seed);
    return { rows: this.rows, entities: this.entities, meta };
  }

  // ---- centreline + corridor authoring ---------------------------------------------

  private authorRows(rowCount: number): void {
    const rng = this.rng;
    const diff = this.diff;
    let yaw = 0;
    let pitch = 0;
    let roll = 0;
    let width: number = LANE.halfWidth;
    let lanes: 1 | 2 = 1;

    const push = (index: number, flags: number, section: SectionId, height: number) => {
      this.rows.push({
        index,
        s0: index * LANE.rowLen,
        s1: (index + 1) * LANE.rowLen,
        yawRate: yaw,
        pitchRate: pitch,
        roll,
        halfWidth: width,
        height,
        lanes,
        medianHalf: lanes === 2 ? LANE.medianHalf : 0,
        flags,
        section,
        spectacle: null,
        entityStart: 0,
        entityEnd: 0,
        phase: CollapsePhase.Solid,
        phaseT: 0,
        unsafeU0: 0,
        unsafeU1: 0,
        unsafeSide: -1,
        collapseCount: 0,
        hint: 0,
      });
    };

    const introRows = clamp(Math.round(7 * diff.reactionScale), 6, 12);
    const introYaw = rng.range(0.0005, 0.0016) * (rng.chance(0.5) ? -1 : 1);
    for (let i = 0; i < introRows && i < rowCount; i++) {
      const t = i / Math.max(1, introRows - 1);
      yaw = lerp(0, introYaw, smoothstep(0.2, 1, t));
      pitch = lerp(0, 0.0015, t);
      roll = lerp(0, 0.18, t);
      width = lerp(LANE.wideHalfWidth, LANE.halfWidth, t);
      lanes = 1;
      push(i, RF.intro | RF.calm, 'intro', LANE.height);
    }

    let index = introRows;
    let lastId: SectionId = 'intro';
    let justHadDrama = false;
    let collapseGap = Math.round(10 / diff.reactionScale);
    const seen = new Set<SectionId>();

    while (index < rowCount) {
      const progress = index / rowCount;
      if (progress > 0.955) {
        const rest = rowCount - index;
        for (let i = 0; i < rest; i++) {
          const t = i / Math.max(1, rest - 1);
          yaw = approach(yaw, 0, YAW_SLEW);
          pitch = approach(pitch, 0, PITCH_SLEW);
          roll = approach(roll, 0, ROLL_SLEW);
          width = approach(width, LANE.wideHalfWidth, WIDTH_SLEW);
          lanes = 1;
          push(index + i, RF.finish | RF.calm | (t > 0.3 ? RF.boostGate : 0), 'finish', LANE.height);
        }
        index = rowCount;
        break;
      }

      const def = this.pickSection(progress, lastId, justHadDrama, collapseGap, seen);
      const len = clamp(Math.round(rng.range(def.rows[0], def.rows[1])), 4, rowCount - index);
      const targetYaw = clamp(rng.range(def.yaw[0], def.yaw[1]), -MAX_YAW, MAX_YAW);
      const targetPitch = clamp(rng.range(def.pitch[0], def.pitch[1]), -MAX_PITCH_RATE, MAX_PITCH_RATE);
      const flip = rng.chance(0.5) ? -1 : 1;
      const height = def.id === 'narrow' ? LANE.height * 0.82 : LANE.height;
      const baseWidth = rng.range(def.width[0], def.width[1]);

      for (let i = 0; i < len; i++) {
        const t = i / Math.max(1, len - 1);
        const shape = Math.min(smoothstep(0, 0.34, t), 1 - smoothstep(0.7, 1, t));
        yaw = clamp(approach(yaw, lerp(yaw, targetYaw * flip, shape), YAW_SLEW), -MAX_YAW, MAX_YAW);
        pitch = clamp(approach(pitch, lerp(pitch, targetPitch, shape), PITCH_SLEW), -MAX_PITCH_RATE, MAX_PITCH_RATE);
        const targetRoll = clamp(yaw * 78 * def.bank, -MAX_ROLL, MAX_ROLL);
        roll = approach(roll, lerp(roll, targetRoll, shape), ROLL_SLEW);
        width = approach(width, lerp(width, baseWidth, shape), WIDTH_SLEW);
        width = clamp(width, LANE.narrowHalfWidth, LANE.wideHalfWidth);
        lanes = def.lanes === 2 && t > 0.2 && t < 0.8 ? 2 : 1;

        let flags = 0;
        if (lanes === 2) flags |= RF.split;
        if (def.width[1] < 7.4) flags |= RF.narrow;
        if (Math.abs(pitch) > 0.0034) flags |= RF.vertical;
        if (def.threat >= 0.6) flags |= RF.hazard;
        if (def.id === 'boostRun') flags |= RF.boostGate;
        if (def.id === 'straight' || def.id === 'reward') flags |= RF.calm;
        if (def.id === 'collapse' && width >= 9.4 && Math.abs(yaw) < 0.008) flags |= RF.collapseCapable;
        push(index + i, flags, def.id, height);
      }

      seen.add(def.id);
      justHadDrama = def.threat >= 1 || def.id === 'collapse';
      collapseGap = def.id === 'collapse' ? Math.round((COLLAPSE.minGapRows + len) / diff.reactionScale) : Math.max(0, collapseGap - len);
      lastId = def.id;
      index += len;
    }

    this.ensureCollapseCandidates();
  }

  private pickSection(progress: number, lastId: SectionId, cool: boolean, collapseGap: number, seen: Set<SectionId>): SectionDef {
    const diff = this.diff;
    const entries = SECTIONS.filter((s) => {
      if (s.minProgress > progress) return false;
      if (s.id === lastId) return false;
      if (s.id === 'collapse' && collapseGap > 0) return false;
      if (cool && s.threat >= 1.1) return false;
      return true;
    }).map((s) => {
      let w = s.weight;
      w *= lerp(1.5, 0.6, smoothstep(0, 0.4, progress)) ** (s.threat < 0.5 ? 1 : 0);
      w *= lerp(0.5, 1.7, smoothstep(0.12, 0.8, progress)) ** (s.threat >= 1 ? 1 : 0);
      if (!seen.has(s.id)) w *= 1.3;
      if (this.biome === 'collapse_field' && (s.id === 'collapse' || s.id === 'asteroids')) w *= 1.7;
      if (this.biome === 'stellar_forge' && (s.id === 'plasma' || s.id === 'anomaly')) w *= 1.6;
      if (this.biome === 'void_rift' && (s.id === 'anomaly' || s.id === 'narrow')) w *= 1.7;
      if (this.biome === 'deep_space' && (s.id === 'sweep' || s.id === 'boostRun')) w *= 1.35;
      if (diff.obstacleDensity > 1.05 && s.threat > 1) w *= 1.3;
      if (diff.obstacleDensity < 0.7 && s.threat > 1) w *= 0.45;
      return { value: s, weight: Math.max(0.02, w) };
    });
    if (entries.length === 0) return SECTIONS[0];
    return this.rng.weighted(entries);
  }

  private ensureCollapseCandidates(): void {
    const rows = this.rows;
    const wanted = clamp(Math.round(rows.length * 0.055 * this.diff.collapseRate), 8, 70);
    let capable = 0;
    for (const r of rows) if (r.flags & RF.collapseCapable) capable++;
    if (capable >= wanted) return;
    const candidates = rows.filter(
      (r) =>
        r.halfWidth >= 9 &&
        r.lanes === 1 &&
        Math.abs(r.yawRate) < 0.0075 &&
        (r.flags & (RF.narrow | RF.finish | RF.intro)) === 0 &&
        (r.flags & RF.collapseCapable) === 0,
    );
    this.rng.shuffle(candidates);
    for (let i = 0; i < candidates.length && capable < wanted; i++, capable++) {
      candidates[i].flags |= RF.collapseCapable;
    }
  }

  // ---- entity population -------------------------------------------------------------

  private populate(): number {
    const rng = this.rng;
    const diff = this.diff;
    const rows = this.rows;
    const entities = this.entities;
    let gates = 0;
    let gateCooldown = 3;
    let pickupCooldown = 5;
    let energyCooldown = 0;

    const mk = (partial: Partial<LaneEntity> & Pick<LaneEntity, 'kind' | 's' | 'u' | 'h'>): LaneEntity => {
      const e: LaneEntity = {
        id: nextEntityId++,
        kind: partial.kind,
        row: 0,
        s: partial.s,
        u: partial.u,
        h: partial.h,
        r: partial.r ?? 2,
        size: partial.size ?? 1,
        variant: partial.variant ?? 0,
        pickup: partial.pickup ?? '',
        motion: partial.motion ?? EntityMotion.Static,
        ampU: partial.ampU ?? 0,
        ampH: partial.ampH ?? 0,
        freq: partial.freq ?? 0,
        phase0: partial.phase0 ?? 0,
        cu: partial.u,
        ch: partial.h,
        cs: partial.s,
        spin: partial.spin ?? 0,
        active: true,
        consumedAt: 0,
        t: partial.t ?? 1,
        scores: partial.scores ?? false,
        tier: partial.tier ?? 1,
        flags: 0,
        fuse: 0,
      };
      entities.push(e);
      return e;
    };

    for (let ri = 0; ri < rows.length; ri++) {
      const row = rows[ri];
      const progress = ri / rows.length;
      const hw = row.halfWidth;
      const hh = row.height;
      const threat = diff.obstacleDensity * lerp(0.3, 1.35, smoothstep(0, 0.8, progress));
      const mid = row.s0 + LANE.rowLen * 0.5;
      const split = row.lanes === 2;

      gateCooldown--;
      if (gateCooldown <= 0 && ri > 3) {
        gateCooldown = Math.round(rng.range(7, 12));
        const isBoost = (row.flags & RF.boostGate) !== 0;
        if (split) {
          for (const side of [-1, 1]) {
            mk({ kind: 'gate', s: mid, u: side * hw * 0.5, h: LANE.hoverBase + 1.1, r: 4.4, size: hw * 0.42, scores: true });
          }
          gates += 2;
        } else {
          const lineU = clamp(-row.yawRate * 2400, -hw * 0.4, hw * 0.4);
          mk({ kind: 'gate', s: mid, u: lineU, h: LANE.hoverBase + 1.1, r: 4.6, size: Math.min(hw, hh) * 0.55, scores: true });
          gates++;
        }
        if (isBoost || rng.chance(0.18)) {
          mk({ kind: 'boostpad', s: mid + 7, u: split ? hw * 0.5 : 0, h: 0.3, r: 5.4, size: 5, tier: 0 });
        }
      }

      pickupCooldown--;
      energyCooldown--;
      const rewarding = row.section === 'reward' || row.section === 'boostRun';
      if ((pickupCooldown <= 0 || rewarding) && row.index > 3) {
        pickupCooldown = Math.round(rng.range(5, 11) / Math.max(0.45, diff.energyDrain));
        let kind: PickupKind = rng.weighted(PICKUP_TABLE);
        if (kind === 'energy' && energyCooldown > 0 && !rewarding) kind = 'credit';
        if (rewarding && rng.chance(0.55)) kind = 'energy';
        if (kind === 'energy') energyCooldown = 7;
        const count = rewarding && rng.chance(0.5) ? 3 : 1;
        for (let c = 0; c < count; c++) {
          mk({
            kind: 'pickup',
            pickup: kind,
            s: row.s0 + rng.range(0.2, 0.8) * LANE.rowLen + c * 9,
            u: clamp((split ? (c % 2 === 0 ? -1 : 1) * hw * 0.5 : 0) + rng.spread(hw * 0.22), -hw + 1.6, hw - 1.6),
            h: LANE.hoverBase + rng.range(-0.5, 2.2),
            r: 2.6,
            size: 1.5,
            tier: 0,
            scores: true,
            motion: c > 0 ? EntityMotion.LateralSine : EntityMotion.Static,
            ampU: hw * 0.1,
            freq: 0.1,
            phase0: c * 1.1,
          });
        }
      }

      if (row.index < RACE.openingCalmLength) {
        if (row.index === Math.floor(RACE.openingCalmLength * 0.6)) {
          // A single lonely, obvious rock: teaches steering without punishing.
          mk({ kind: 'asteroid', s: mid, u: hw * 0.2, h: LANE.hoverBase + 0.4, r: 3.1, size: 3.1, variant: 0, motion: EntityMotion.LateralSine, ampU: hw * 0.1, freq: 0.14, phase0: 0.4 });
        }
        continue;
      }
      if ((row.flags & RF.noSpawn) !== 0) continue;

      switch (row.section) {
        case 'asteroids': this.spawnAsteroidCluster(row, mk, threat, 2.6); break;
        case 'mines': this.spawnMine(row, mk, threat); break;
        case 'plasma': this.spawnPlasma(row, mk, threat); break;
        case 'anomaly': this.spawnAnomaly(row, mk, threat); break;
        case 'rogue': this.spawnRogue(row, mk, threat); break;
        case 'narrow': this.spawnNarrowRock(row, mk, threat); break;
        case 'split': this.spawnSplitHazard(row, mk, threat); break;
        case 'collapse': this.spawnCollapseHazard(row, mk, threat); break;
        default: this.spawnRareRock(row, mk, threat); break;
      }
    }

    // Atmosphere: drifting wrecks hugging the corridor walls. Never a threat.
    for (let ri = RACE.openingCalmLength; ri < rows.length; ri++) {
      if (!rng.chance(0.09)) continue;
      const row = rows[ri];
      const side = rng.chance(0.5) ? -1 : 1;
      mk({
        kind: 'wreck',
        s: row.s0 + rng.range(0, 1) * LANE.rowLen,
        u: side * row.halfWidth * rng.range(0.72, 0.97),
        h: rng.range(1, row.height * 0.9),
        r: 0,
        size: rng.range(2.6, 7.5),
        variant: rng.int(3),
        tier: 0,
        motion: EntityMotion.Orbit,
        freq: rng.range(0.03, 0.09),
        phase0: rng.float() * 6.283,
      });
    }

    entities.sort((a, b) => a.s - b.s);
    let cursor = 0;
    for (const row of rows) {
      row.entityStart = cursor;
      while (cursor < entities.length && entities[cursor].s < row.s1) {
        entities[cursor].row = row.index;
        cursor++;
      }
      row.entityEnd = cursor;
    }
    const last = rows[rows.length - 1];
    if (last) {
      for (let i = cursor; i < entities.length; i++) entities[i].row = last.index;
      last.entityEnd = entities.length;
    }
    return gates;
  }

  private spawnAsteroidCluster(row: LaneRow, mk: EntitySpawner, threat: number, maxScale: number): void {
    const rng = this.rng;
    const hw = row.halfWidth;
    const hh = row.height;
    const n = 1 + Math.round(clamp01(threat * 0.8) * rng.range(0, 2));
    for (let i = 0; i < n; i++) {
      const size = rng.range(2, maxScale);
      mk({
        kind: 'asteroid',
        s: row.s0 + rng.range(0.1, 0.9) * LANE.rowLen,
        u: rng.spread(hw * 0.68),
        h: LANE.hoverBase + rng.range(-0.3, hh * 0.5),
        r: size,
        size,
        variant: rng.int(4),
        spin: rng.spread(0.8),
        motion: rng.chance(0.4) ? EntityMotion.LateralSine : EntityMotion.Static,
        ampU: hw * rng.range(0.05, 0.18),
        freq: rng.range(0.05, 0.16),
        phase0: rng.float() * 6.283,
      });
    }
    if (this.biome === 'collapse_field' && rng.chance(0.22)) {
      // The "squeeze": two huge rocks with a guaranteed corridor between them.
      const gap = rng.spread(hw * 0.3);
      for (const side of [-1, 1]) {
        mk({ kind: 'asteroid', s: row.s0 + LANE.rowLen * 0.5, u: gap + side * hw * 0.62, h: hh * 0.35, r: 6.4, size: 6.4, variant: rng.int(4) });
      }
    }
  }

  private spawnMine(row: LaneRow, mk: EntitySpawner, threat: number): void {
    const rng = this.rng;
    if (!rng.chance(clamp01(0.45 * threat))) return;
    const hw = row.halfWidth;
    mk({
      kind: 'mine',
      s: row.s0 + rng.range(0.2, 0.8) * LANE.rowLen,
      u: (rng.chance(0.5) ? -1 : 1) * rng.range(0.15, 0.6) * hw,
      h: LANE.hoverBase + rng.range(-0.4, 2.6),
      r: 2,
      size: 2.1,
      variant: rng.int(2),
      motion: EntityMotion.VerticalSine,
      ampH: 1.5,
      freq: rng.range(0.1, 0.24),
      phase0: rng.float() * 6.283,
      tier: 2,
    });
  }

  private spawnPlasma(row: LaneRow, mk: EntitySpawner, threat: number): void {
    const rng = this.rng;
    if (!rng.chance(clamp01(0.5 * threat))) return;
    const hw = row.halfWidth;
    // Blocked band always leaves MIN_GAP of clear corridor on the far side.
    const maxBlock = Math.max(3, hw * 2 - MIN_GAP - 2 * LANE.shipRadiusU);
    const block = clamp(hw * rng.range(0.5, 0.62), 3, maxBlock);
    const side = row.index % 2 === 0 ? -1 : 1;
    mk({
      kind: 'plasma',
      s: row.s0 + LANE.rowLen * 0.5,
      u: side * (hw - block * 0.5 + 0.4),
      h: row.height * 0.5,
      r: block * 0.5,
      size: block,
      variant: row.index % 3,
      motion: rng.chance(0.22) ? EntityMotion.LateralSine : EntityMotion.Static,
      ampU: Math.max(0, hw - block),
      freq: rng.range(0.05, 0.11),
      phase0: rng.float() * 6.283,
      tier: 2,
    });
  }

  private spawnAnomaly(row: LaneRow, mk: EntitySpawner, threat: number): void {
    const rng = this.rng;
    if (!rng.chance(clamp01(0.4 * threat))) return;
    const hw = row.halfWidth;
    mk({
      kind: 'anomaly',
      s: row.s0 + rng.range(0.3, 0.9) * LANE.rowLen,
      u: rng.spread(hw * 0.45),
      h: LANE.hoverBase + rng.range(1.5, 4.5),
      r: 6.5,
      size: rng.range(5.5, 9),
      variant: rng.int(2),
      motion: EntityMotion.LateralSine,
      ampU: hw * 0.28,
      freq: rng.range(0.04, 0.1),
      phase0: rng.float() * 6.283,
      tier: 1,
    });
  }

  private spawnRogue(row: LaneRow, mk: EntitySpawner, threat: number): void {
    const rng = this.rng;
    if (!rng.chance(clamp01(0.34 * threat))) return;
    const hw = row.halfWidth;
    const side = rng.chance(0.5) ? -1 : 1;
    mk({
      kind: 'rogue',
      s: row.s0 + LANE.rowLen * rng.range(0.2, 0.8),
      u: side * hw * 0.8,
      h: LANE.hoverBase + rng.range(0.4, 3.4),
      r: 3.2,
      size: 6.4,
      variant: rng.int(2),
      motion: EntityMotion.LateralTraverse,
      ampU: hw * 0.8,
      freq: rng.range(0.07, 0.12),
      phase0: rng.float() * 6.283,
      tier: 2,
    });
  }

  private spawnNarrowRock(row: LaneRow, mk: EntitySpawner, threat: number): void {
    const rng = this.rng;
    if (!rng.chance(clamp01(0.42 * threat))) return;
    const hw = row.halfWidth;
    const side = rng.chance(0.5) ? -1 : 1;
    mk({
      kind: 'asteroid',
      s: row.s0 + LANE.rowLen * rng.range(0.3, 0.7),
      u: side * rng.range(0.3, 0.55) * hw,
      h: LANE.hoverBase + rng.range(-0.2, 1.8),
      r: rng.range(1.6, Math.min(2.6, hw - MIN_GAP / 2)),
      size: 2.2,
      variant: rng.int(4),
      motion: EntityMotion.VerticalSine,
      ampH: 0.8,
      freq: rng.range(0.08, 0.16),
      phase0: rng.float() * 6.283,
    });
  }

  private spawnSplitHazard(row: LaneRow, mk: EntitySpawner, threat: number): void {
    const rng = this.rng;
    if (!rng.chance(clamp01(0.36 * threat))) return;
    const hw = row.halfWidth;
    const side = rng.chance(0.5) ? -1 : 1;
    mk({
      kind: rng.chance(0.55) ? 'asteroid' : 'mine',
      s: row.s0 + LANE.rowLen * 0.5,
      u: side * hw * 0.5,
      h: LANE.hoverBase + rng.range(0, 2.4),
      r: 2.4,
      size: 2.6,
      variant: rng.int(4),
      motion: EntityMotion.LateralSine,
      ampU: hw * 0.06,
      freq: rng.range(0.06, 0.14),
      phase0: rng.float() * 6.283,
    });
  }

  private spawnCollapseHazard(row: LaneRow, mk: EntitySpawner, threat: number): void {
    const rng = this.rng;
    if (!rng.chance(clamp01(0.3 * threat))) return;
    const hw = row.halfWidth;
    mk({
      kind: rng.chance(0.6) ? 'asteroid' : 'shard',
      s: row.s0 + rng.range(0.2, 0.8) * LANE.rowLen,
      u: rng.spread(hw * 0.55),
      h: LANE.hoverBase + rng.range(0, 3),
      r: rng.range(1.8, 3),
      size: 2.6,
      variant: rng.int(4),
      motion: EntityMotion.LateralSine,
      ampU: hw * 0.12,
      freq: rng.range(0.05, 0.12),
      phase0: rng.float() * 6.283,
    });
  }

  private spawnRareRock(row: LaneRow, mk: EntitySpawner, threat: number): void {
    const rng = this.rng;
    if (!rng.chance(clamp01(0.18 * threat))) return;
    const hw = row.halfWidth;
    mk({
      kind: 'asteroid',
      s: row.s0 + rng.range(0.2, 0.8) * LANE.rowLen,
      u: rng.spread(hw * 0.6),
      h: LANE.hoverBase + rng.range(-0.3, 2.8),
      r: rng.range(1.7, 2.9),
      size: 2.3,
      variant: rng.int(4),
      motion: rng.chance(0.3) ? EntityMotion.LateralSine : EntityMotion.Static,
      ampU: hw * 0.14,
      freq: rng.range(0.05, 0.13),
      phase0: rng.float() * 6.283,
    });
  }

  // ---- collapsing star lanes ----------------------------------------------------------

  /** Picks the row groups that are eligible to collapse during the race, in order. */
  private planCollapses(): { start: number; end: number; rows: LaneRow[] }[] {
    const rng = this.rng;
    const diff = this.diff;
    const plan: { start: number; end: number; rows: LaneRow[] }[] = [];
    const minGap = Math.round(COLLAPSE.minGapRows / diff.reactionScale);
    let i = Math.round(RACE.openingCalmLength + minGap);
    let lastEnd = -minGap;
    while (i < this.rows.length - 12) {
      const row = this.rows[i];
      const capableCount = this.rows.slice(i, i + COLLAPSE.spreadMax + 1).filter((r) => r.flags & RF.collapseCapable).length;
      if ((row.flags & RF.collapseCapable) !== 0 && i - lastEnd >= minGap && capableCount >= 2) {
        const spread = rng.intRange(COLLAPSE.spreadMin, COLLAPSE.spreadMax);
        const group = this.rows.slice(i, Math.min(this.rows.length, i + spread)).filter((r) => (r.flags & RF.collapseCapable) !== 0 || r.lanes === 2);
        if (group.length >= 2) {
          plan.push({ start: group[0].index, end: group[group.length - 1].index, rows: group });
          lastEnd = group[group.length - 1].index;
        }
        i += spread + minGap;
      } else {
        i += 3;
      }
    }
    return plan;
  }

  /** Pre-computes the deadly lateral band for every collapse event, keeping a safe route. */
  private assignCollapseBands(plan: { rows: LaneRow[] }[]): void {
    const rng = this.rng;
    for (const event of plan) {
      const side = rng.chance(0.5) ? -1 : 1;
      const splitGroup = event.rows.some((r) => r.lanes === 2);
      if (splitGroup && rng.chance(0.65)) {
        // Branch collapse: one whole side of a split section drops away.
        for (const row of event.rows) {
          row.unsafeSide = side;
          if (row.lanes === 2) {
            row.unsafeU0 = side > 0 ? 0.08 : -1;
            row.unsafeU1 = side > 0 ? 1 : -0.08;
            row.flags |= side > 0 ? RF.collapsedSideR : RF.collapsedSideL;
          } else {
            // Single corridor inside a split event: take most of one side.
            row.unsafeU0 = side > 0 ? 0.12 : -1;
            row.unsafeU1 = side > 0 ? 1 : -0.12;
          }
        }
      } else {
        // Fracture band: a lateral slice of the corridor peels away.
        const width = rng.range(0.44, 0.56);
        const edge = side > 0 ? 1 - width * 2 * 0.5 : -1 + width * 2 * 0.5;
        const u0 = side > 0 ? edge : -1;
        const u1 = side > 0 ? 1 : edge;
        for (const row of event.rows) {
          row.unsafeU0 = u0;
          row.unsafeU1 = u1;
          row.unsafeSide = side;
          row.flags |= side > 0 ? RF.collapsedSideR : RF.collapsedSideL;
        }
      }
    }
  }

  // ---- validation --------------------------------------------------------------------

  /**
   * Post-pass. Guarantees a survivable corridor at every row, over a full row window, and
   * counting each obstacle's motion amplitude — a rock that swings 3 m sideways must not be
   * able to close the only gap. Anything that would break the invariant is demoted to scenery.
   */
  private enforcePassableLine(): void {
    const rows = this.rows;
    for (const row of rows) {
      const hw = row.halfWidth;
      const blockers: { e: LaneEntity; lo: number; hi: number }[] = [];
      for (const e of this.entities) {
        if (e.tier === 0 || !e.active) continue;
        if (e.kind === 'gate' || e.kind === 'boostpad' || e.kind === 'pickup' || e.kind === 'wreck') continue;
        if (e.s < row.s0 - 4 || e.s > row.s1 + 4) continue;
        const reach = e.kind === 'plasma' ? e.size * 0.5 : e.r + Math.abs(e.ampU);
        blockers.push({ e, lo: e.u - reach - LANE.shipRadiusU, hi: e.u + reach + LANE.shipRadiusU });
      }
      if (!blockers.length) continue;

      if (row.lanes === 2) {
        // A split is two independent branches: each one must stay flyable on its own.
        const wall = row.medianHalf + 1.2;
        for (const side of [-1, 1]) {
          const lo = side < 0 ? -hw + LANE.shipRadiusU * 0.75 : wall;
          const hi = side < 0 ? -wall : hw - LANE.shipRadiusU * 0.75;
          const inBranch = blockers.filter((b) => b.hi > lo && b.lo < hi).map((b) => ({ e: b.e as LaneEntity | null, lo: b.lo, hi: b.hi }));
          if (this.collapseInterval(row, hw)) inBranch.push(this.collapseInterval(row, hw) as { e: null; lo: number; hi: number });
          this.clearTo(inBranch, lo, hi, BRANCH_GAP);
        }
        continue;
      }

      const minU = -hw + LANE.shipRadiusU * 0.75;
      const maxU = hw - LANE.shipRadiusU * 0.75;
      if (maxU <= minU) continue;
      const intervals: { e: LaneEntity | null; lo: number; hi: number }[] = blockers.map((b) => ({ e: b.e, lo: b.lo, hi: b.hi }));
      const band = this.collapseInterval(row, hw);
      if (band) intervals.push(band);
      this.clearTo(intervals, minU, maxU, MIN_GAP);
    }
  }

  private collapseInterval(row: LaneRow, hw: number): { e: null; lo: number; hi: number } | null {
    if ((row.flags & RF.collapseCapable) === 0 || row.unsafeU1 <= row.unsafeU0) return null;
    return { e: null, lo: row.unsafeU0 * hw, hi: row.unsafeU1 * hw };
  }

  /** Removes blockers until a corridor of `required` metres survives. */
  private clearTo(intervals: { e: LaneEntity | null; lo: number; hi: number }[], minU: number, maxU: number, required: number): void {
    let guard = 0;
    while (widestFreeGap(intervals, minU, maxU) < required && guard++ < 24) {
      const removable = intervals.filter((i) => i.e) as { e: LaneEntity; lo: number; hi: number }[];
      if (!removable.length) break;
      removable.sort((a, b) => b.hi - b.lo - (a.hi - a.lo));
      const victim = removable[0];
      intervals.splice(intervals.indexOf(victim), 1);
      this.demoteToScenery(victim.e);
    }
  }

  private demoteToScenery(e: LaneEntity): void {
    e.active = false;
    e.tier = 0;
    e.r = 0;
    e.kind = 'shard';
    e.size = Math.min(e.size, 1.2);
    e.motion = EntityMotion.Static;
    e.ampU = 0;
    e.ampH = 0;
  }

  private placeSpectacles(): TrackMeta['spectacle'] {
    const rng = this.rng;
    const rows = this.rows;
    const marks: { id: SpectacleId; atS: number }[] = [];
    const anchors: Record<SpectacleId, { at: number; span: number; flag: number }> = {
      wormhole: { at: SPECTACLE.wormholeAt, span: SPECTACLE.wormholeRows, flag: RF.warp },
      starInterior: { at: SPECTACLE.starInteriorAt, span: SPECTACLE.starInteriorRows, flag: RF.interior },
      twinRocks: { at: SPECTACLE.twinRocksAt, span: 7, flag: RF.spectacle },
      shockwave: { at: SPECTACLE.shockwaveAt, span: 10, flag: RF.spectacle },
      gateSprint: { at: SPECTACLE.gateSprintAt, span: SPECTACLE.gateSprintRows, flag: RF.boostGate },
      vortex: { at: SPECTACLE.blackholeAt, span: 12, flag: RF.vortex },
      finishWarp: { at: 0.975, span: RACE.finishTunnelRows, flag: RF.finish },
    };
    const order: SpectacleId[] = ['wormhole', 'starInterior', 'twinRocks', 'shockwave', 'vortex', 'gateSprint'];
    for (const id of order) {
      const a = anchors[id];
      const start = clamp(Math.round(a.at * rows.length + rng.spread(0.02 * rows.length)), 6, rows.length - 10);
      for (let i = start; i < Math.min(rows.length, start + a.span); i++) {
        rows[i].flags |= a.flag | RF.spectacle;
        if (!rows[i].spectacle) rows[i].spectacle = id;
      }
      marks.push({ id, atS: start * LANE.rowLen });
    }
    const fa = anchors.finishWarp;
    const fstart = clamp(Math.round(fa.at * rows.length), rows.length - 26, rows.length - 1);
    for (let i = fstart; i < rows.length; i++) rows[i].flags |= fa.flag | RF.spectacle;
    rows[rows.length - 1].spectacle = 'finishWarp';
    marks.push({ id: 'finishWarp', atS: fstart * LANE.rowLen });

    const sprint = marks.find((m) => m.id === 'gateSprint');
    if (sprint) {
      const start = Math.floor(sprint.atS / LANE.rowLen);
      for (let i = start; i < Math.min(rows.length, start + SPECTACLE.gateSprintRows); i += 2) rows[i].flags |= RF.boostGate;
    }
    for (const row of rows) {
      if (row.flags & (RF.warp | RF.intro | RF.finish)) row.flags &= ~RF.collapseCapable;
    }
    return marks;
  }

  private describe(rowCount: number, gates: number, spectacle: TrackMeta['spectacle'], collapseEvents: number, seed: string): TrackMeta {
    const rows = this.rows;
    const length = rowCount * LANE.rowLen;
    const sectionList: TrackMeta['sectionList'] = [];
    let current = rows[0]?.section ?? 'intro';
    let from = 0;
    for (let i = 1; i <= rows.length; i++) {
      const sec = i < rows.length ? rows[i].section : null;
      if (sec !== current) {
        sectionList.push({ id: current, fromRow: from, toRow: i });
        current = sec ?? current;
        from = i;
      }
    }
    return {
      seed,
      length,
      rowCount,
      parTimeSec: length / (this.diff.maxSpeed * 0.84),
      entityCount: this.entities.length,
      gateCount: gates,
      collapseRows: collapseEvents,
      splitRows: rows.filter((r) => r.lanes === 2).length,
      spectacle,
      sectionList,
    };
  }
}

type EntitySpawner = (partial: Partial<LaneEntity> & Pick<LaneEntity, 'kind' | 's' | 'u' | 'h'>) => LaneEntity;

function widestFreeGap(intervals: { lo: number; hi: number }[], min: number, max: number): number {
  const sorted = [...intervals].sort((a, b) => a.lo - b.lo);
  let cursor = min;
  let best = 0;
  for (const iv of sorted) {
    if (iv.hi <= min || iv.lo >= max) continue;
    if (iv.lo > cursor) best = Math.max(best, iv.lo - cursor);
    cursor = Math.max(cursor, iv.hi);
    if (cursor >= max) break;
  }
  return Math.max(best, max - cursor);
}

/**
 * Integrates the authored row rates into a sampled centreline.
 * Heading is accumulated per metre, so the resulting curve is C1-continuous by construction
 * and can never contain the impossible kinks a point-cloud generator would produce.
 */
export function buildLanePath(rows: LaneRow[]): LanePath {
  const segs = LANE.segsPerRow;
  const ds = LANE.rowLen / segs;
  const n = rows.length * segs + 1;
  const yaw = new Float64Array(n);
  const pitch = new Float64Array(n);
  const roll = new Float64Array(n);
  const halfWidth = new Float64Array(n);
  const height = new Float64Array(n);
  let y = 0;
  let p = 0;
  for (let i = 0; i < n; i++) {
    const s = i * ds;
    const rowIdx = clamp(Math.floor(s / LANE.rowLen), 0, rows.length - 1);
    const row = rows[rowIdx];
    const next = rows[Math.min(rows.length - 1, rowIdx + 1)];
    const t = clamp01((s - row.s0) / LANE.rowLen);
    yaw[i] = y;
    pitch[i] = p;
    roll[i] = lerp(row.roll, next.roll, t);
    halfWidth[i] = lerp(row.halfWidth, next.halfWidth, t);
    height[i] = lerp(row.height, next.height, t);
    y += lerp(row.yawRate, next.yawRate, t) * ds;
    p = clamp(p + lerp(row.pitchRate, next.pitchRate, t) * ds, -0.62, 0.62);
  }
  return new LanePath(rows.length, segs, LANE.rowLen, { yaw, pitch, roll, halfWidth, height });
}

/** Convenience: generate a race and its centreline in one call. */
export function generateTrackWithPath(opts: GenerateOptions): GeneratedTrack & { path: LanePath } {
  const track = new TrackGenerator().generate(opts);
  return { ...track, path: buildLanePath(track.rows) };
}
