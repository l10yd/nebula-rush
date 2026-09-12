/** Shared domain types. Kept free of runtime imports so any module can depend on them. */

export type Locale = 'en' | 'ru';

export type DifficultyId = 'novice' | 'pilot' | 'ace' | 'supernova';

export type QualityTier = 'ultra' | 'high' | 'medium' | 'low';

export type BiomeId = 'deep_space' | 'collapse_field' | 'stellar_forge' | 'void_rift';

export type ShipId = 'vireo' | 'kestrel' | 'onyx' | 'lumen' | 'hellion';

export type TrailId = 'cyan' | 'ultraviolet' | 'magenta' | 'solar' | 'emerald';

export type GamePhase =
  | 'boot'
  | 'loading'
  | 'main_menu'
  | 'garage'
  | 'settings'
  | 'howto'
  | 'briefing'
  | 'countdown'
  | 'racing'
  | 'paused'
  | 'finish'
  | 'results';

export type EntityKind =
  | 'asteroid'
  | 'mine'
  | 'anomaly'
  | 'plasma'
  | 'rogue'
  | 'gate'
  | 'boostpad'
  | 'pickup'
  | 'wreck'
  | 'shard';

export type PickupKind = 'energy' | 'shield' | 'overdrive' | 'phase' | 'magnet' | 'credit';

export type PowerKind = 'shield' | 'overdrive' | 'phase' | 'magnet';

export type InputAction =
  | 'throttle'
  | 'brake'
  | 'left'
  | 'right'
  | 'boost'
  | 'drift'
  | 'ability'
  | 'pause'
  | 'restart'
  | 'confirm'
  | 'back';

export type RaceMode = 'standard' | 'daily' | 'seed';

/** Lane-local position: s = distance along the star lane, u = lateral, h = height above floor. */
export interface LanePos {
  s: number;
  u: number;
  h: number;
}

export interface RaceStats {
  score: number;
  distance: number;
  timeSec: number;
  bestCombo: number;
  comboEvents: number;
  nearMisses: number;
  gateCount: number;
  boostSeconds: number;
  perfectBoosts: number;
  perfectDrifts: number;
  collapsesEscaped: number;
  pickups: number;
  credits: number;
  hits: number;
  shieldSaves: number;
  abilityUses: number;
}

export interface RaceResult extends RaceStats {
  seed: string;
  mode: RaceMode;
  difficulty: DifficultyId;
  biome: BiomeId;
  ship: ShipId;
  finished: boolean;
  rank: string;
  percentileScore: number;
  newBestScore: boolean;
  newBestTime: boolean;
  topSpeed: number;
}

export interface DifficultyTuning {
  id: DifficultyId;
  baseSpeed: number;
  maxSpeed: number;
  boostSpeed: number;
  obstacleDensity: number;
  collapseRate: number;
  reactionScale: number;
  scoreMultiplier: number;
  hazardDamage: number;
  energyDrain: number;
  aiPressure: number;
  unlockCost: number;
}

export interface BiomeTuning {
  id: BiomeId;
  palette: {
    deep: string;
    mid: string;
    accent: string;
    accentAlt: string;
    hot: string;
    danger: string;
  };
  fogColor: string;
  fogDensity: number;
  starDensity: number;
  nebulaIntensity: number;
  tunnelTint: string;
  ambient: number;
  keyLight: string;
  rimLight: string;
  unlockCost: number;
}

export interface ShipTuning {
  id: ShipId;
  hull: string;
  accent: string;
  glow: string;
  price: number;
  /** Cosmetic-only differences. Handling is identical for every hull by design. */
  profile: { length: number; wing: number; engine: number; fins: number; glass: string };
}

export interface TrailTuning {
  id: TrailId;
  core: string;
  halo: string;
  spark: string;
  price: number;
}

export interface Settings {
  locale: Locale;
  quality: QualityTier;
  autoQuality: boolean;
  masterVolume: number;
  musicVolume: number;
  sfxVolume: number;
  engineVolume: number;
  screenShake: boolean;
  reducedMotion: boolean;
  colorSafe: boolean;
  highContrastHud: boolean;
  uiScale: number;
  fovBias: number;
  invertLook: boolean;
  showFps: boolean;
  touchControls: 'auto' | 'on' | 'off';
  tiltSteering: boolean;
  keybinds: Record<InputAction, string[]>;
  musicDucking: boolean;
  damageFlash: boolean;
}

export interface Progress {
  credits: number;
  totalCredits: number;
  runs: number;
  distanceFlown: number;
  unlockedShips: ShipId[];
  unlockedTrails: TrailId[];
  unlockedBiomes: BiomeId[];
  unlockedDifficulties: DifficultyId[];
  ownedCosmetics: string[];
  selectedShip: ShipId;
  selectedTrail: TrailId;
  selectedBiome: BiomeId;
  selectedDifficulty: DifficultyId;
  bestScore: number;
  bestTimeSec: number;
  bestCombo: number;
  racesFinished: number;
  daily: Record<string, { score: number; timeSec: number }>;
  firstRaceDone: boolean;
  seenTutorialTips: string[];
}

export interface SaveData {
  version: number;
  settings: Settings;
  progress: Progress;
  createdAt: number;
  updatedAt: number;
}
