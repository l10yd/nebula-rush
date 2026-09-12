import { i18n } from '../data/i18n.ts';
import type { BiomeId, DifficultyId, InputAction, Progress, QualityTier, Settings, ShipId, TrailId } from '../data/types.ts';
import type { SaveSystem } from './SaveSystem.ts';
import { EventBus } from './EventBus.ts';

export interface SettingsEvents extends Record<string, unknown> {
  change: { key: keyof Settings | 'all' };
}

export interface ProgressEvents extends Record<string, unknown> {
  change: { key: keyof Progress | 'all' };
  credits: { delta: number; total: number };
}

/** Reactive wrapper around persisted settings. Mutations flow through `set`. */
export class SettingsStore {
  readonly bus = new EventBus<SettingsEvents>();

  constructor(private readonly save: SaveSystem) {
    if (save.data.settings.locale) i18n.setLocale(save.data.settings.locale);
  }

  get value(): Settings {
    return this.save.data.settings;
  }

  get<K extends keyof Settings>(key: K): Settings[K] {
    return this.save.data.settings[key];
  }

  set<K extends keyof Settings>(key: K, value: Settings[K]): void {
    const settings = this.save.data.settings;
    if (settings[key] === value) return;
    settings[key] = value;
    if (key === 'locale') i18n.setLocale(value as Settings['locale']);
    this.save.save();
    this.bus.emit('change', { key });
  }

  setKeybind(action: InputAction, codes: string[]): void {
    this.save.data.settings.keybinds[action] = codes;
    this.save.save();
    this.bus.emit('change', { key: 'keybinds' });
  }

  patch(partial: Partial<Settings>): void {
    Object.assign(this.save.data.settings, partial);
    if (partial.locale) i18n.setLocale(partial.locale);
    this.save.save(true);
    this.bus.emit('change', { key: 'all' });
  }

  onChange(cb: (payload: SettingsEvents['change']) => void): () => void {
    return this.bus.on('change', cb);
  }
}

/** Progression + records. Also handles unlocks and spending. */
export class ProgressStore {
  readonly bus = new EventBus<ProgressEvents>();

  constructor(private readonly save: SaveSystem) {}

  get value(): Progress {
    return this.save.data.progress;
  }

  private touch(key: keyof Progress | 'all'): void {
    this.save.save();
    this.bus.emit('change', { key });
  }

  get credits(): number {
    return this.value.credits;
  }

  addCredits(amount: number): void {
    const p = this.value;
    const delta = Math.max(0, Math.round(amount));
    p.credits += delta;
    p.totalCredits += delta;
    this.save.save();
    this.bus.emit('credits', { delta, total: p.credits });
    this.bus.emit('change', { key: 'credits' });
  }

  spend(amount: number): boolean {
    const p = this.value;
    if (p.credits < amount) return false;
    p.credits -= amount;
    this.touch('credits');
    this.bus.emit('credits', { delta: -amount, total: p.credits });
    return true;
  }

  hasShip(id: ShipId): boolean {
    return this.value.unlockedShips.includes(id);
  }

  hasTrail(id: TrailId): boolean {
    return this.value.unlockedTrails.includes(id);
  }

  hasBiome(id: BiomeId): boolean {
    return this.value.unlockedBiomes.includes(id);
  }

  hasDifficulty(id: DifficultyId): boolean {
    return this.value.unlockedDifficulties.includes(id);
  }

  hasCosmetic(id: string): boolean {
    return this.value.ownedCosmetics.includes(id);
  }

  unlock(kind: 'ship' | 'trail' | 'biome' | 'difficulty' | 'cosmetic', id: string): boolean {
    const p = this.value;
    switch (kind) {
      case 'ship':
        if (p.unlockedShips.includes(id as ShipId)) return false;
        p.unlockedShips.push(id as ShipId);
        break;
      case 'trail':
        if (p.unlockedTrails.includes(id as TrailId)) return false;
        p.unlockedTrails.push(id as TrailId);
        break;
      case 'biome':
        if (p.unlockedBiomes.includes(id as BiomeId)) return false;
        p.unlockedBiomes.push(id as BiomeId);
        break;
      case 'difficulty':
        if (p.unlockedDifficulties.includes(id as DifficultyId)) return false;
        p.unlockedDifficulties.push(id as DifficultyId);
        p.unlockedDifficulties.sort((a, b) => ['novice', 'pilot', 'ace', 'supernova'].indexOf(a) - ['novice', 'pilot', 'ace', 'supernova'].indexOf(b));
        break;
      case 'cosmetic':
        if (p.ownedCosmetics.includes(id)) return false;
        p.ownedCosmetics.push(id);
        break;
    }
    this.touch('unlockedShips');
    return true;
  }

  select(field: 'selectedShip' | 'selectedTrail' | 'selectedBiome' | 'selectedDifficulty', id: string): void {
    const p = this.value;
    (p[field] as string) = id;
    this.touch(field);
  }

  recordDaily(dayKey: string, score: number, timeSec: number): boolean {
    const p = this.value;
    const prev = p.daily[dayKey];
    if (prev && prev.score >= score && prev.timeSec <= timeSec) return false;
    p.daily[dayKey] = {
      score: Math.max(score, prev?.score ?? 0),
      timeSec: prev?.timeSec && prev.timeSec <= timeSec && timeSec > 0 ? prev.timeSec : timeSec,
    };
    this.touch('daily');
    return true;
  }

  setBestScore(score: number): boolean {
    if (score <= this.value.bestScore) return false;
    this.value.bestScore = score;
    this.touch('bestScore');
    return true;
  }

  setBestTime(timeSec: number): boolean {
    const p = this.value;
    if (!(timeSec > 0) || (p.bestTimeSec > 0 && timeSec >= p.bestTimeSec)) return false;
    p.bestTimeSec = timeSec;
    this.touch('bestTimeSec');
    return true;
  }

  setBestCombo(combo: number): boolean {
    if (combo <= this.value.bestCombo) return false;
    this.value.bestCombo = combo;
    this.touch('bestCombo');
    return true;
  }

  /** Auto-resolved quality when the user leaves it on adaptive. */
  effectiveQuality(requested: QualityTier): QualityTier {
    return requested;
  }
}
