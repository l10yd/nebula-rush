import { COSMETIC_PRICES, SAVE_VERSION, STORAGE_KEY } from '../data/config.ts';
import type { BiomeId, DifficultyId, InputAction, Locale, Progress, QualityTier, SaveData, Settings, ShipId, TrailId } from '../data/types.ts';
import { boolOr, clamp, intOr, numOr, strOr } from '../utils/math.ts';
import { SafeStorage, type Capabilities } from './Platform.ts';

export const DEFAULT_KEYBINDS: Record<InputAction, string[]> = {
  throttle: ['KeyW', 'ArrowUp'],
  brake: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  boost: ['Space'],
  drift: ['ShiftLeft', 'ShiftRight'],
  ability: ['KeyE'],
  pause: ['Escape', 'KeyP'],
  restart: ['KeyR'],
  confirm: ['Enter', 'Space'],
  back: ['Escape', 'Backspace'],
};

const ACTIONS: InputAction[] = [
  'throttle', 'brake', 'left', 'right', 'boost', 'drift', 'ability', 'pause', 'restart', 'confirm', 'back',
];

const DIFFS: DifficultyId[] = ['novice', 'pilot', 'ace', 'supernova'];
const BIOMES: BiomeId[] = ['deep_space', 'collapse_field', 'stellar_forge', 'void_rift'];
const SHIPS: ShipId[] = ['vireo', 'kestrel', 'onyx', 'lumen', 'hellion'];
const TRAILS: TrailId[] = ['cyan', 'ultraviolet', 'magenta', 'solar', 'emerald'];
const QUALITIES: QualityTier[] = ['ultra', 'high', 'medium', 'low'];

export function defaultSettings(caps?: Capabilities): Settings {
  const locale: Locale = caps?.localeGuess ?? 'en';
  return {
    locale,
    quality: caps ? defaultQualityFor(caps) : 'high',
    autoQuality: true,
    masterVolume: 0.85,
    musicVolume: 0.6,
    sfxVolume: 0.8,
    engineVolume: 0.55,
    screenShake: true,
    reducedMotion: caps?.prefersReducedMotion ?? false,
    colorSafe: false,
    highContrastHud: caps?.prefersHighContrast ?? false,
    uiScale: 1,
    fovBias: 0,
    invertLook: false,
    showFps: false,
    touchControls: 'auto',
    tiltSteering: false,
    musicDucking: true,
    damageFlash: true,
    keybinds: { ...DEFAULT_KEYBINDS },
  };
}

function defaultQualityFor(caps: Capabilities): QualityTier {
  if (caps.tier === 'high') return caps.devicePixelRatio > 2.2 ? 'high' : 'ultra';
  if (caps.tier === 'medium') return 'high';
  return 'low';
}

export function defaultProgress(): Progress {
  return {
    credits: 0,
    totalCredits: 0,
    runs: 0,
    distanceFlown: 0,
    unlockedShips: ['vireo'],
    unlockedTrails: ['cyan'],
    unlockedBiomes: ['deep_space'],
    unlockedDifficulties: ['novice', 'pilot'],
    ownedCosmetics: [],
    selectedShip: 'vireo',
    selectedTrail: 'cyan',
    selectedBiome: 'deep_space',
    selectedDifficulty: 'pilot',
    bestScore: 0,
    bestTimeSec: 0,
    bestCombo: 0,
    racesFinished: 0,
    daily: {},
    firstRaceDone: false,
    seenTutorialTips: [],
  };
}

export function defaultSave(caps?: Capabilities): SaveData {
  const now = Date.now();
  return { version: SAVE_VERSION, settings: defaultSettings(caps), progress: defaultProgress(), createdAt: now, updatedAt: now };
}

const COSMETIC_IDS: readonly string[] = Object.keys(COSMETIC_PRICES.cosmetic);

function sanitizeLocale(v: unknown, fallback: Locale): Locale {
  return v === 'en' || v === 'ru' ? v : fallback;
}

function sanitizeKeybinds(raw: unknown): Record<InputAction, string[]> {
  const out = { ...DEFAULT_KEYBINDS } as Record<InputAction, string[]>;
  if (!raw || typeof raw !== 'object') return out;
  const obj = raw as Record<string, unknown>;
  for (const action of ACTIONS) {
    const value = obj[action];
    if (!Array.isArray(value)) continue;
    const codes = value
      .filter((c): c is string => typeof c === 'string' && /^[A-Za-z0-9_]{2,16}$/.test(c))
      .slice(0, 3);
    if (codes.length) out[action] = codes;
  }
  // Never allow pause to be unbound-ish.
  if (!out.pause.length) out.pause = [...DEFAULT_KEYBINDS.pause];
  return out;
}

function sanitizeStringList(raw: unknown, allowed: readonly string[]): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v === 'string' && allowed.includes(v) && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

function sanitizeSettings(raw: unknown, fallback: Settings): Settings {
  const s = defaultSettings();
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const vol = (v: unknown, d: number) => clamp(numOr(v, d), 0, 1);
  const quality = QUALITIES.includes(strOr(o.quality, '') as QualityTier) ? (o.quality as QualityTier) : fallback.quality;
  return {
    ...s,
    locale: sanitizeLocale(o.locale, fallback.locale),
    quality,
    autoQuality: boolOr(o.autoQuality, fallback.autoQuality),
    masterVolume: vol(o.masterVolume, fallback.masterVolume),
    musicVolume: vol(o.musicVolume, fallback.musicVolume),
    sfxVolume: vol(o.sfxVolume, fallback.sfxVolume),
    engineVolume: vol(o.engineVolume, fallback.engineVolume),
    screenShake: boolOr(o.screenShake, fallback.screenShake),
    reducedMotion: boolOr(o.reducedMotion, s.reducedMotion),
    colorSafe: boolOr(o.colorSafe, false),
    highContrastHud: boolOr(o.highContrastHud, s.highContrastHud),
    uiScale: clamp(numOr(o.uiScale, 1), 0.8, 1.55),
    fovBias: clamp(numOr(o.fovBias, 0), -8, 14),
    invertLook: boolOr(o.invertLook, false),
    showFps: boolOr(o.showFps, false),
    touchControls: o.touchControls === 'on' || o.touchControls === 'off' ? o.touchControls : 'auto',
    tiltSteering: boolOr(o.tiltSteering, false),
    musicDucking: boolOr(o.musicDucking, true),
    damageFlash: boolOr(o.damageFlash, true),
    keybinds: sanitizeKeybinds(o.keybinds),
  };
}

function sanitizeProgress(raw: unknown, fallback: Progress): Progress {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const credits = Math.max(0, intOr(o.credits, fallback.credits));
  const daily: Progress['daily'] = {};
  if (o.daily && typeof o.daily === 'object') {
    for (const [k, v] of Object.entries(o.daily as Record<string, unknown>).slice(0, 60)) {
      if (!v || typeof v !== 'object') continue;
      const rec = v as Record<string, unknown>;
      daily[k.slice(0, 24)] = {
        score: Math.max(0, Math.round(numOr(rec.score, 0))),
        timeSec: clamp(numOr(rec.timeSec, 0), 0, 3600),
      };
    }
  }
  const unlockedShips = sanitizeStringList(o.unlockedShips, SHIPS) as ShipId[];
  const unlockedTrails = sanitizeStringList(o.unlockedTrails, TRAILS) as TrailId[];
  const unlockedBiomes = sanitizeStringList(o.unlockedBiomes, BIOMES) as BiomeId[];
  const unlockedDifficulties = sanitizeStringList(o.unlockedDifficulties, DIFFS) as DifficultyId[];
  const pick = <T extends string>(v: unknown, list: T[], fallbackV: T, unlocked: T[]): T => {
    return list.includes(v as T) && (unlocked.includes(v as T) || v === fallbackV) ? (v as T) : fallbackV;
  };
  return {
    credits,
    totalCredits: Math.max(credits, intOr(o.totalCredits, fallback.totalCredits)),
    runs: Math.max(0, intOr(o.runs, 0)),
    distanceFlown: Math.max(0, numOr(o.distanceFlown, 0)),
    unlockedShips: unlockedShips.length ? unlockedShips : ['vireo'],
    unlockedTrails: unlockedTrails.length ? unlockedTrails : ['cyan'],
    unlockedBiomes: unlockedBiomes.length ? unlockedBiomes : ['deep_space'],
    unlockedDifficulties: unlockedDifficulties.length
      ? Array.from(new Set([...unlockedDifficulties, 'novice' as DifficultyId, 'pilot' as DifficultyId])).sort((a, b) => DIFFS.indexOf(a) - DIFFS.indexOf(b))
      : ['novice', 'pilot'],
    // Derived from the catalogue so a purchasable id can never be dropped by the sanitizer
    // and silently vanish from the save on the next load.
    ownedCosmetics: sanitizeStringList(o.ownedCosmetics, COSMETIC_IDS),
    selectedShip: pick(o.selectedShip, SHIPS, 'vireo', unlockedShips),
    selectedTrail: pick(o.selectedTrail, TRAILS, 'cyan', unlockedTrails),
    selectedBiome: pick(o.selectedBiome, BIOMES, 'deep_space', unlockedBiomes),
    selectedDifficulty: pick(o.selectedDifficulty, DIFFS, 'pilot', unlockedDifficulties),
    bestScore: Math.max(0, Math.round(numOr(o.bestScore, 0))),
    bestTimeSec: clamp(numOr(o.bestTimeSec, 0), 0, 3600),
    bestCombo: Math.max(0, Math.round(numOr(o.bestCombo, 0))),
    racesFinished: Math.max(0, intOr(o.racesFinished, 0)),
    daily,
    firstRaceDone: boolOr(o.firstRaceDone, false),
    seenTutorialTips: Array.isArray(o.seenTutorialTips)
      ? (o.seenTutorialTips.filter((v) => typeof v === 'string').slice(0, 40) as string[])
      : [],
  };
}

function migrate(data: SaveData): SaveData {
  // Older saves keep their values; anything missing is filled with defaults by the sanitizer.
  data.version = SAVE_VERSION;
  return data;
}

export class SaveSystem {
  data: SaveData;
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | 0 = 0;

  constructor(private readonly storage: SafeStorage, caps?: Capabilities) {
    this.data = defaultSave(caps);
    this.load();
  }

  load(): void {
    const fallback = this.data;
    const raw = this.storage.read(STORAGE_KEY);
    if (!raw) return;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
      const o = parsed as Record<string, unknown>;
      this.data = migrate({
        version: intOr(o.version, 0),
        settings: sanitizeSettings(o.settings, fallback.settings),
        progress: sanitizeProgress(o.progress, fallback.progress),
        createdAt: numOr(o.createdAt, Date.now()),
        updatedAt: numOr(o.updatedAt, Date.now()),
      });
    } catch (err) {
      // Corrupted save: keep playing with defaults and quarantine the bad payload.
      console.warn('[nebula] Save data was unreadable, starting fresh.', err);
      this.storage.write(`${STORAGE_KEY}.corrupt`, raw.slice(0, 4000));
      this.storage.remove(STORAGE_KEY);
      this.data = defaultSave();
      this.data.settings = fallback.settings;
    }
  }

  flush(): void {
    if (!this.dirty) return;
    this.dirty = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = 0;
    }
    this.data.updatedAt = Date.now();
    this.data.version = SAVE_VERSION;
    try {
      this.storage.write(STORAGE_KEY, JSON.stringify(this.data));
    } catch (err) {
      console.warn('[nebula] Could not persist save data.', err);
    }
  }

  save(immediate = false): void {
    this.dirty = true;
    if (immediate) {
      this.flush();
      return;
    }
    if (this.timer) return;
    // The bare global, not window: the save layer has to work in a test runner too.
    this.timer = setTimeout(() => {
      this.timer = 0;
      this.flush();
    }, 600);
  }

  reset(): void {
    const locale = this.data.settings.locale;
    this.data = defaultSave();
    this.data.settings.locale = locale;
    this.save(true);
  }

  get settings(): Settings {
    return this.data.settings;
  }

  get progress(): Progress {
    return this.data.progress;
  }
}
