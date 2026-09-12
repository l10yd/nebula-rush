import { IS_DEV } from '../core/env.ts';
import type { BiomeId, BiomeTuning, DifficultyId, DifficultyTuning, QualityTier, ShipId, ShipTuning, TrailId, TrailTuning } from './types.ts';

/**
 * Single source of truth for gameplay + presentation tuning.
 * Nothing else in the codebase should contain a bare gameplay magic number.
 */

export const LANE = {
  /** Length of one lane block along the star lane. */
  rowLen: 32,
  /** Subdivisions per row along s (tunnel silhouette resolution). */
  segsPerRow: 6,
  /** Default corridor half-width (metres). */
  halfWidth: 9.2,
  /** Default corridor height (metres). */
  height: 13,
  /** Narrow corridor sections. */
  narrowHalfWidth: 5.4,
  wideHalfWidth: 12.6,
  /** Half-width of the median barrier inside split sections. */
  medianHalf: 1.6,
  /** Hover height above the floor. */
  hoverBase: 2.6,
  hoverMin: 0.7,
  hoverMax: 9.4,
  shipRadiusU: 1.55,
  shipRadiusH: 1.15,
  /** Tunnel rows rendered at once, relative to the player row. */
  windowBack: 26,
  windowAhead: 78,
  /** How far ahead gameplay looks for spawning / warnings. */
  sightDistance: 1500,
  fogNear: 260,
  fogFar: 2350,
} as const;

export const DRIVING = {
  throttleAccel: 46,
  brakeDecel: 88,
  dragDecel: 16,
  coastTarget: 0.55,
  reverseMax: 9,
  steerVelocity: 40,
  steerAccel: 190,
  steerDamping: 9.5,
  driftSteerBoost: 1.55,
  driftLateralGain: 2.05,
  driftDamping: 3.1,
  driftMinSpeed: 90,
  driftChargeRate: 1.75,
  driftPerfectWindow: 0.55,
  driftPerfectMin: 0.62,
  driftPerfectBonus: 30,
  hoverSpring: 12,
  wallBounce: 0.32,
  /** Collision response */
  hitSpeedLoss: 0.55,
  hitStun: 0.42,
  scrapeSpeedLoss: 0.06,
  knockbackU: 12,
} as const;

export const BOOST = {
  energyMax: 100,
  energyRegen: 9.2,
  drain: 33,
  padRefund: 26,
  pickupRefund: 34,
  minDuration: 0.35,
  perfectWindow: 1.15,
  perfectDuration: 2.4,
  perfectGain: 1.34,
  entryRamp: 0.22,
  exitRamp: 0.5,
  fovAdd: 17,
  shakeAmp: 0.55,
  /** Ability: RUSH BURST */
  abilityChargePerEvents: 7,
  abilityCostEvents: 7,
  abilityDuration: 1.6,
  abilityGain: 1.55,
  abilityClearRadius: 26,
} as const;

export const POWER = {
  shieldDuration: 14,
  overdriveDuration: 7,
  overdriveGain: 1.22,
  phaseDuration: 5.2,
  magnetDuration: 12,
  magnetRadius: 26,
  energyRefund: 34,
} as const;

export const COMBO = {
  /** Seconds without a skill event before the chain decays. */
  window: 4.4,
  decayStep: 0.2,
  perStepGain: 0.08,
  maxMultiplier: 9,
  hitReset: true,
  points: {
    nearMiss: 95,
    gate: 130,
    boostGate: 210,
    perfectDrift: 240,
    perfectBoost: 280,
    collapseEscape: 430,
    dodge: 75,
    pickupEnergy: 45,
    pickupCredit: 160,
    pickupOther: 120,
    shortcut: 320,
    shockwaveEscape: 520,
    distancePerMetre: 0.14,
    finishBonus: 26000,
    finishTimePenalty: 48,
  },
} as const;

export const SCORE_TO_CREDITS = 210;
export const FINISH_CREDIT_BONUS = 90;
export const DAILY_CREDIT_MULT = 1.5;

export const RANKS: { rank: string; ratio: number }[] = [
  { rank: 'S+', ratio: 1.22 },
  { rank: 'S', ratio: 1.04 },
  { rank: 'A', ratio: 0.86 },
  { rank: 'B', ratio: 0.68 },
  { rank: 'C', ratio: 0.5 },
  { rank: 'D', ratio: 0 },
];

export const RACE = {
  /** First race is authored to land in the 2–4 minute band. */
  targetSeconds: 168,
  avgSpeedRatio: 0.82,
  minRows: 420,
  maxRows: 1080,
  countdownSteps: [3, 2, 1] as const,
  countdownGoTime: 0.95,
  /** Seconds of protected runway before hazards can appear. */
  openingCalmLength: 6,
  finishTunnelRows: 12,
} as const;

export const CAMERA = {
  fovBase: 70,
  fovMax: 96,
  fovSpeedRef: 250,
  behind: 15.4,
  behindBoostAdd: 5.2,
  height: 4.5,
  lookAhead: 62,
  lateralFollow: 0.72,
  followLambda: 9.5,
  rollLambda: 6.5,
  bankFromSteer: 0.42,
  bankFromRoll: 0.55,
  shakeDecay: 6.2,
  shakeMax: 1,
  collisionKick: 0.9,
  boostFOV: 15,
  warpFOV: 9,
} as const;

export const DIFFICULTY: Record<DifficultyId, DifficultyTuning> = {
  novice: {
    id: 'novice', baseSpeed: 92, maxSpeed: 168, boostSpeed: 214,
    obstacleDensity: 0.55, collapseRate: 0.45, reactionScale: 1.4, scoreMultiplier: 0.8,
    hazardDamage: 0.55, energyDrain: 0.75, aiPressure: 0.5, unlockCost: 0,
  },
  pilot: {
    id: 'pilot', baseSpeed: 108, maxSpeed: 204, boostSpeed: 272,
    obstacleDensity: 0.85, collapseRate: 0.85, reactionScale: 1.0, scoreMultiplier: 1,
    hazardDamage: 1, energyDrain: 1, aiPressure: 0.85, unlockCost: 0,
  },
  ace: {
    id: 'ace', baseSpeed: 124, maxSpeed: 238, boostSpeed: 318,
    obstacleDensity: 1.05, collapseRate: 1.2, reactionScale: 0.84, scoreMultiplier: 1.4,
    hazardDamage: 1.2, energyDrain: 1.1, aiPressure: 1.15, unlockCost: 2400,
  },
  supernova: {
    id: 'supernova', baseSpeed: 140, maxSpeed: 268, boostSpeed: 356,
    obstacleDensity: 1.3, collapseRate: 1.55, reactionScale: 0.7, scoreMultiplier: 1.9,
    hazardDamage: 1.45, energyDrain: 1.2, aiPressure: 1.45, unlockCost: 7200,
  },
};

export const BIOMES: Record<BiomeId, BiomeTuning> = {
  deep_space: {
    id: 'deep_space',
    palette: { deep: '#03050c', mid: '#0a1630', accent: '#5ef1ff', accentAlt: '#a86bff', hot: '#ffffff', danger: '#ff4d5e' },
    fogColor: '#050a18', fogDensity: 0.00042, starDensity: 1, nebulaIntensity: 0.85,
    tunnelTint: '#4fe6ff', ambient: 0.32, keyLight: '#cfe9ff', rimLight: '#7b4dff',
    unlockCost: 0,
  },
  collapse_field: {
    id: 'collapse_field',
    palette: { deep: '#050308', mid: '#1b0a22', accent: '#ff5cf0', accentAlt: '#6cf1ff', hot: '#fff3d6', danger: '#ff7a2f' },
    fogColor: '#12061c', fogDensity: 0.00055, starDensity: 0.75, nebulaIntensity: 1.1,
    tunnelTint: '#ff62e0', ambient: 0.26, keyLight: '#ffd7f4', rimLight: '#3fa9ff',
    unlockCost: 1500,
  },
  stellar_forge: {
    id: 'stellar_forge',
    palette: { deep: '#070402', mid: '#25100a', accent: '#ffb347', accentAlt: '#ffe9a8', hot: '#ffffff', danger: '#ff3d2e' },
    fogColor: '#1a0a06', fogDensity: 0.00068, starDensity: 0.55, nebulaIntensity: 1.25,
    tunnelTint: '#ffc061', ambient: 0.4, keyLight: '#ffdfae', rimLight: '#ff5a2a',
    unlockCost: 3200,
  },
  void_rift: {
    id: 'void_rift',
    palette: { deep: '#01020a', mid: '#050f24', accent: '#7dffd4', accentAlt: '#4c6bff', hot: '#eafcff', danger: '#ff2f6d' },
    fogColor: '#020512', fogDensity: 0.00035, starDensity: 1.35, nebulaIntensity: 0.6,
    tunnelTint: '#72ffd0', ambient: 0.2, keyLight: '#d8fff4', rimLight: '#3350ff',
    unlockCost: 5200,
  },
};

export const SHIPS: Record<ShipId, ShipTuning> = {
  vireo: {
    id: 'vireo', hull: '#c9d7ef', accent: '#5ef1ff', glow: '#5ef1ff', price: 0,
    profile: { length: 5.2, wing: 3.5, engine: 1.0, fins: 2, glass: '#0b1c2a' },
  },
  kestrel: {
    id: 'kestrel', hull: '#e6ecf8', accent: '#a86bff', glow: '#b584ff', price: 1200,
    profile: { length: 5.9, wing: 4.4, engine: 0.85, fins: 3, glass: '#141026' },
  },
  onyx: {
    id: 'onyx', hull: '#43495c', accent: '#ff5cf0', glow: '#ff62e0', price: 2100,
    profile: { length: 5.5, wing: 3.1, engine: 1.15, fins: 4, glass: '#05070c' },
  },
  lumen: {
    id: 'lumen', hull: '#f4f7ff', accent: '#ffe9a8', glow: '#ffd76b', price: 3000,
    profile: { length: 6.2, wing: 4.9, engine: 0.7, fins: 2, glass: '#1d2438' },
  },
  hellion: {
    id: 'hellion', hull: '#6c2a2a', accent: '#ff7a2f', glow: '#ff4326', price: 4400,
    profile: { length: 5.7, wing: 4.0, engine: 1.35, fins: 5, glass: '#1a0205' },
  },
};

export const TRAILS: Record<TrailId, TrailTuning> = {
  cyan: { id: 'cyan', core: '#ffffff', halo: '#5ef1ff', spark: '#9ff6ff', price: 0 },
  ultraviolet: { id: 'ultraviolet', core: '#f0e8ff', halo: '#a86bff', spark: '#c9a6ff', price: 500 },
  magenta: { id: 'magenta', core: '#fff0fb', halo: '#ff5cf0', spark: '#ff9df5', price: 900 },
  solar: { id: 'solar', core: '#fff8e0', halo: '#ffb347', spark: '#ffd88a', price: 1500 },
  emerald: { id: 'emerald', core: '#eafff8', halo: '#37ffc0', spark: '#8dffe0', price: 2400 },
};

export const COSMETIC_PRICES = {
  difficulty: { ace: DIFFICULTY.ace.unlockCost, supernova: DIFFICULTY.supernova.unlockCost } as Record<string, number>,
  biome: {
    collapse_field: BIOMES.collapse_field.unlockCost,
    stellar_forge: BIOMES.stellar_forge.unlockCost,
    void_rift: BIOMES.void_rift.unlockCost,
  } as Record<string, number>,
  // Cosmetic only. No ship in the game is faster than another, and nothing here is
  // required to finish a lane.
  cosmetic: {
    wing_lights: 320,
    hud_frame: 480,
    trail_sparkle: 260,
    collapse_trail: 700,
  } as Record<string, number>,
};

export const QUALITY: Record<QualityTier, {
  label: QualityTier;
  dprCap: number;
  renderScale: number;
  particles: number;
  bloom: boolean;
  bloomResolutionScale: number;
  aberration: boolean;
  speedLines: number;
  starCount: number;
  nebulaSteps: number;
  debrisInstances: number;
  trailSegments: number;
  msaa: number;
  envRings: number;
  warpStreaks: number;
}> = {
  ultra: {
    label: 'ultra', dprCap: 2, renderScale: 1, particles: 6200, bloom: true, bloomResolutionScale: 0.72,
    aberration: true, speedLines: 1, starCount: 5200, nebulaSteps: 6, debrisInstances: 420, trailSegments: 46,
    msaa: 0, envRings: 5, warpStreaks: 220,
  },
  high: {
    label: 'high', dprCap: 1.75, renderScale: 1, particles: 4000, bloom: true, bloomResolutionScale: 0.6,
    aberration: true, speedLines: 0.85, starCount: 3800, nebulaSteps: 5, debrisInstances: 300, trailSegments: 36,
    msaa: 0, envRings: 4, warpStreaks: 170,
  },
  medium: {
    label: 'medium', dprCap: 1.5, renderScale: 0.92, particles: 2300, bloom: true, bloomResolutionScale: 0.45,
    aberration: false, speedLines: 0.6, starCount: 2600, nebulaSteps: 4, debrisInstances: 190, trailSegments: 26,
    msaa: 0, envRings: 3, warpStreaks: 120,
  },
  low: {
    label: 'low', dprCap: 1, renderScale: 0.8, particles: 1100, bloom: false, bloomResolutionScale: 0.35,
    aberration: false, speedLines: 0.35, starCount: 1500, nebulaSteps: 3, debrisInstances: 90, trailSegments: 16,
    msaa: 0, envRings: 2, warpStreaks: 70,
  },
};

/** Adaptive quality thresholds: sustained frame time above bad → downgrade. */
export const ADAPTIVE = {
  sampleFrames: 90,
  badFrameMs: 20.5,
  goodFrameMs: 12.5,
  badRatioDown: 0.34,
  badRatioUp: 0.03,
  cooldownMs: 3200,
  minTier: 'low' as QualityTier,
} as const;

export const HAZARD = {
  asteroid: { radiusMin: 2.2, radiusMax: 6.4, damage: 1, spin: 0.6, driftSpeed: 3.2 },
  mine: { triggerRadius: 7.5, blastRadius: 13.5, damage: 1.15, pulseHz: 1.8 },
  anomaly: { pullRadius: 62, pullForce: 30, damage: 0.7 },
  plasma: { damage: 1, warnLead: 1.35, thickness: 1.6 },
  rogue: { damage: 1.05, sweepSpeed: 7.5, length: 12 },
  shockwave: { travelBackSpeed: 34, damage: 1.1, warnSeconds: 2.6, activeSeconds: 11 },
  gate: { warnLead: 1.2 },
  nearMissDistance: 4.2,
} as const;

export const COLLAPSE = {
  /** Phases: telegraph → fracture → gone → reform. Durations in seconds (scaled by difficulty reactionScale). */
  warnTime: 2.9,
  fractureTime: 1.15,
  goneTime: 6.5,
  reformTime: 2.4,
  /** Rows affected by one collapse event. */
  spreadMin: 2,
  spreadMax: 4,
  /** Minimum rows between collapse events. */
  minGapRows: 12,
  /** How far ahead of the player collapses are scheduled. */
  leadRows: 26,
  /**
   * Extra notice on top of warn+fracture. The band is armed by estimated time of arrival,
   * never by a fixed distance, so the corridor always breaks open just as the player reaches it.
   */
  armLeadSeconds: 1.25,
  crackMax: 1,
} as const;

export const SPECTACLE = {
  /** Fraction of the track where each signature moment is placed. */
  wormholeAt: 0.16,
  starInteriorAt: 0.34,
  twinRocksAt: 0.5,
  shockwaveAt: 0.63,
  blackholeAt: 0.77,
  gateSprintAt: 0.9,
  wormholeRows: 14,
  starInteriorRows: 26,
  gateSprintRows: 22,
} as const;

export const AUDIO = {
  engineBaseHz: 42,
  engineMaxHz: 205,
  engineSpeedRef: 260,
  musicBpm: 138,
  musicBpmHigh: 152,
  lookaheadMs: 26,
  scheduleAheadSec: 0.16,
  masterCeiling: -6,
} as const;

export const UI = {
  hudFadeAfterSec: 0,
  panelSpring: { stiffness: 210, damping: 20 },
  resultsStaggerMs: 90,
  toastSeconds: 2.4,
} as const;

export const STORAGE_KEY = 'nebula-rush.save.v1';
export const SAVE_VERSION = 3;

export const DEBUG = {
  /** Debug tooling is compiled out of production builds. */
  enabled: IS_DEV,
  hotkeys: { debug: 'F3', jump: 'F4', restart: 'KeyR' },
} as const;
