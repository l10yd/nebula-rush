import type { EventBus } from '../core/EventBus.ts';
import type { EntityKind, PickupKind } from '../data/types.ts';
import type { StringKey } from '../data/i18n.ts';
import type { FxQueue } from './FxQueue.ts';
import type { LaneRow, SpectacleId } from './trackTypes.ts';

export interface RaceEvents extends Record<string, unknown> {
  nearMiss: { kind: EntityKind; distance: number };
  hit: { kind: EntityKind; severity: number; blocked: boolean };
  scrape: { side: number };
  gate: { boost: boolean; center: boolean; chain: number };
  boostpad: { energy: number };
  pickup: { kind: PickupKind; score: number };
  collapseWarn: { side: number; safeSide: number; row: number };
  collapseBreak: { side: number; row: number };
  collapseHit: { row: number };
  collapseEscape: { row: number; score: number };
  shockwaveStart: { fromRow: number };
  shockwaveHit: { row: number };
  shockwaveEscape: { score: number };
  spectacle: { id: SpectacleId; phase: 'enter' | 'exit'; row: number };
  objective: { key: StringKey; holdSeconds: number };
  warning: { key: StringKey; side: number; distance: number };
  comboBreak: { chain: number };
  chain: { chain: number; multiplier: number; kind: string; score: number };
  perfectBoost: {};
  perfectDrift: {};
  ability: {};
  shield: { on: boolean };
  powerup: { kind: PickupKind; seconds: number };
  damage: { level: number; fatal: boolean };
  finish: { timeSec: number; score: number; rank: string };
  death: {};
  countdown: { value: number };
}

export type RaceBus = EventBus<RaceEvents>;

export interface RuntimeRow {
  row: LaneRow;
  /** Cached world-space centre of the row for cheap distance tests. */
  t: number;
}

export type { RaceBus as Bus };

export interface FxHandle {
  fx: FxQueue;
}
