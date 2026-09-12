import type { EntityKind, PickupKind } from '../data/types.ts';

/** Row flags bitmask. */
export const RF = {
  gate: 1 << 0,
  boostGate: 1 << 1,
  narrow: 1 << 2,
  split: 1 << 3,
  vertical: 1 << 4,
  collapseCapable: 1 << 5,
  collapsedSideL: 1 << 6,
  collapsedSideR: 1 << 7,
  spectacle: 1 << 8,
  calm: 1 << 9,
  finish: 1 << 10,
  intro: 1 << 11,
  hazard: 1 << 12,
  noSpawn: 1 << 13,
  warp: 1 << 14,
  interior: 1 << 15,
  vortex: 1 << 16,
} as const;

export type SectionId =
  | 'intro'
  | 'calm'
  | 'straight'
  | 'sweep'
  | 'tight'
  | 'climb'
  | 'dive'
  | 'bank'
  | 'narrow'
  | 'split'
  | 'asteroids'
  | 'mines'
  | 'plasma'
  | 'anomaly'
  | 'rogue'
  | 'boostRun'
  | 'reward'
  | 'collapse'
  | 'finish';

export type SpectacleId = 'wormhole' | 'starInterior' | 'twinRocks' | 'shockwave' | 'gateSprint' | 'vortex' | 'finishWarp';

/** Collapse phase of a lane block. Plain (not `const`) so the simulation stays runnable by Node. */
export enum CollapsePhase {
  Solid = 0,
  Warn = 1,
  Fracture = 2,
  Gone = 3,
  Reform = 4,
}

export interface LaneRow {
  readonly index: number;
  readonly s0: number;
  readonly s1: number;
  /** Authored per-metre rates used to bake the centreline. */
  yawRate: number;
  pitchRate: number;
  roll: number;
  halfWidth: number;
  height: number;
  lanes: 1 | 2;
  medianHalf: number;
  flags: number;
  section: SectionId;
  spectacle: SpectacleId | null;
  /** Entities in `TrackData.entities`, [entityStart, entityEnd). */
  entityStart: number;
  entityEnd: number;
  /** Collapse runtime. */
  phase: CollapsePhase;
  phaseT: number;
  /** Normalised lateral band [-1,1] that becomes deadly when this row collapses. */
  unsafeU0: number;
  unsafeU1: number;
  /** Side index (0 left / 1 right / -1 whole corridor band) for split collapses. */
  unsafeSide: number;
  /** Number of times this row has collapsed (used to limit repeat drama). */
  collapseCount: number;
  hint: number;
}

export const enum EntityMotion {
  Static = 0,
  LateralSine = 1,
  LateralTraverse = 2,
  VerticalSine = 3,
  Orbit = 4,
  HomingSlow = 5,
}

export interface LaneEntity {
  readonly id: number;
  kind: EntityKind;
  row: number;
  s: number;
  u: number;
  h: number;
  /** Collision radius (metres). */
  r: number;
  /** Visual scale multiplier. */
  size: number;
  variant: number;
  pickup: PickupKind | '';
  motion: EntityMotion;
  ampU: number;
  ampH: number;
  freq: number;
  phase0: number;
  /** Runtime lateral position after motion evaluation (written by TrackRuntime). */
  cu: number;
  ch: number;
  cs: number;
  spin: number;
  active: boolean;
  consumedAt: number;
  /** Gate open fraction 1..0; plasma/rogue use it as traversal progress. */
  t: number;
  /** True when the entity was authored as a scoring gate. */
  scores: boolean;
  /** Damage tier: 0 = harmless, 1 = normal, 2 = heavy. */
  tier: number;
  /** Runtime bookkeeping bitmask (see EF). */
  flags: number;
  /** Fuse countdown used by mines; > 0 while armed. */
  fuse: number;
}

/** Entity runtime flags. */
export const EF = {
  nearMissReported: 1 << 0,
  consumed: 1 << 1,
  armed: 1 << 2,
  exploded: 1 << 3,
} as const;

export interface TrackMeta {
  seed: string;
  length: number;
  rowCount: number;
  parTimeSec: number;
  entityCount: number;
  gateCount: number;
  collapseRows: number;
  splitRows: number;
  spectacle: { id: SpectacleId; atS: number }[];
  sectionList: { id: SectionId; fromRow: number; toRow: number }[];
}

export interface GeneratedTrack {
  rows: LaneRow[];
  entities: LaneEntity[];
  meta: TrackMeta;
}
