import { BIOMES, COSMETIC_PRICES, DIFFICULTY, SHIPS, TRAILS } from '../data/config.ts';
import { i18n } from '../data/i18n.ts';
import type { StringKey } from '../data/i18n.ts';
import type {
  BiomeId,
  DifficultyId,
  GamePhase,
  InputAction,
  QualityTier,
  RaceMode,
  RaceResult,
  Settings,
  ShipId,
  TrailId,
} from '../data/types.ts';
import type { ProgressStore, SettingsStore } from '../core/Stores.ts';
import type { SfxName } from '../audio/AudioEngine.ts';
import { append, button, clear, el, formatNumber, formatTime } from './dom.ts';

export interface RaceRequest {
  mode: RaceMode;
  difficulty: DifficultyId;
  biome: BiomeId;
  seedText: string;
}

export interface TrackSummary {
  lengthMetres: number;
  parSeconds: number;
  seedText: string;
}

/** Everything a screen may ask of the application, so no screen touches a singleton. */
export interface ScreenHost {
  readonly settings: SettingsStore;
  readonly progress: ProgressStore;
  play(name: SfxName): void;
  notify(key: StringKey, params?: Record<string, string | number>): void;
  goto(phase: GamePhase): void;
  startRace(request: RaceRequest): void;
  previewSetup(): void;
  applySettings(): void;
  toggleFullscreen(): void;
  rebind(action: InputAction): void;
  resetBindings(): void;
  resetSave(): void;
  summarize(difficulty: DifficultyId, mode: RaceMode): TrackSummary;
  returnTarget(): GamePhase;
  dailyKey(): string;
  deviceSummary(): string;
  audioBlocked(): boolean;
}

const DIFFICULTIES: DifficultyId[] = ['novice', 'pilot', 'ace', 'supernova'];
const BIOME_IDS: BiomeId[] = ['deep_space', 'collapse_field', 'stellar_forge', 'void_rift'];
const SHIP_IDS: ShipId[] = ['vireo', 'kestrel', 'onyx', 'lumen', 'hellion'];
const TRAIL_IDS: TrailId[] = ['cyan', 'ultraviolet', 'magenta', 'solar', 'emerald'];
const COSMETIC_IDS = ['wing_lights', 'hud_frame', 'trail_sparkle', 'collapse_trail'] as const;
const QUALITIES: QualityTier[] = ['ultra', 'high', 'medium', 'low'];
const BIND_ORDER: InputAction[] = ['throttle', 'brake', 'left', 'right', 'boost', 'drift', 'ability', 'pause', 'restart'];
const BIND_LABEL: Record<InputAction, StringKey> = {
  throttle: 'howto.throttle',
  brake: 'howto.brake',
  left: 'howto.steer',
  right: 'howto.steer',
  boost: 'howto.boost',
  drift: 'howto.drift',
  ability: 'howto.ability',
  pause: 'howto.pause',
  restart: 'pause.restart',
  confirm: 'brief.start',
  back: 'common.back',
};

/* ------------------------------------------------------------------ shared */

function panel(children: (HTMLElement | null)[], extra = ''): HTMLElement {
  return el('div', { class: `nr-panel nr-scroll ${extra}`.trim(), children: children.filter(Boolean) as HTMLElement[] });
}

function title(key: StringKey): HTMLElement {
  return el('h2', { class: 'nr-title', text: i18n.t(key) });
}

function note(text: string): HTMLElement {
  return el('p', { class: 'nr-note', text });
}

function segment(options: { id: string; label: string; disabled?: boolean }[], value: string, onPick: (id: string) => void, ariaKey: StringKey): HTMLElement {
  return el('div', {
    class: 'nr-segment',
    attrs: { role: 'radiogroup', 'aria-label': i18n.t(ariaKey) },
    children: options.map((option) =>
      el('button', {
        text: option.label,
        attrs: { type: 'button', role: 'radio', 'aria-checked': option.id === value, disabled: option.disabled === true },
        on: {
          click: () => {
            if (!option.disabled) onPick(option.id);
          },
        },
      }),
    ),
  });
}

function row(labelKey: StringKey, control: HTMLElement, descKey?: StringKey): HTMLElement {
  return el('div', {
    class: 'nr-field',
    children: [
      el('span', { class: 'nr-field-label', text: i18n.t(labelKey) }),
      control,
      descKey ? el('p', { class: 'nr-field-desc', text: i18n.t(descKey) }) : null,
    ].filter(Boolean) as HTMLElement[],
  });
}

function sliderRow(
  host: ScreenHost,
  labelKey: StringKey,
  key: 'uiScale' | 'fovBias' | 'masterVolume' | 'musicVolume' | 'sfxVolume' | 'engineVolume',
  min: number,
  max: number,
  step: number,
  format: (value: number) => string,
  descKey?: StringKey,
): HTMLElement {
  const start = host.settings.get(key);
  const readout = el('span', { class: 'nr-field-value', text: format(start) });
  const input = el('input', {
    attrs: { type: 'range', min: String(min), max: String(max), step: String(step), value: String(start) },
    style: { '--nr-fill': `${((start - min) / (max - min)) * 100}%` },
    on: {
      input: () => {
        const value = Number(input.value);
        readout.textContent = format(value);
        input.style.setProperty('--nr-fill', `${((value - min) / (max - min)) * 100}%`);
      },
      change: () => {
        host.settings.set(key, Number(input.value) as never);
        host.applySettings();
      },
    },
  });
  return row(labelKey, el('div', { class: 'nr-slider', children: [input, readout] }), descKey);
}

function switchRow(host: ScreenHost, labelKey: StringKey, key: keyof Settings, descKey?: StringKey): HTMLElement {
  const input = el('input', {
    attrs: { type: 'checkbox', checked: Boolean(host.settings.get(key)) },
    on: {
      change: () => {
        host.settings.set(key, input.checked as never);
        host.applySettings();
      },
    },
  });
  return row(labelKey, el('label', { class: 'nr-switch', children: [input, el('i')] }), descKey);
}

/* ------------------------------------------------------------------ screens */

/** Base for every full-screen view. Rebuilds its subtree on show, so a locale switch is free. */
export abstract class Screen {
  readonly root: HTMLElement;

  protected constructor(protected readonly host: ScreenHost, name: string) {
    this.root = el('section', { class: 'nr-screen', dataset: { screen: name }, attrs: { role: 'dialog', 'aria-modal': 'true' } });
  }

  protected abstract body(): HTMLElement;

  show(data?: unknown): void {
    clear(this.root);
    append(this.root, [this.body()]);
    this.root.classList.add('is-active');
    this.onShow(data);
    window.setTimeout(() => this.root.querySelector<HTMLElement>('button:not(:disabled)')?.focus(), 0);
  }

  protected onShow(_data?: unknown): void {}

  hide(): void {
    this.root.classList.remove('is-active');
  }

  get visible(): boolean {
    return this.root.classList.contains('is-active');
  }

  /** Sound + action, so every control is audible without a separate wiring pass. */
  protected act(name: SfxName, fn: () => void): () => void {
    return () => {
      this.host.play(name);
      fn();
    };
  }
}

export class LoadingScreen extends Screen {
  private bar = el('i');
  private tip = el('p', { class: 'nr-loading-tip', text: '' });
  private lastPct = -1;

  constructor(host: ScreenHost) {
    super(host, 'loading');
  }

  protected body(): HTMLElement {
    return panel(
      [
        el('div', { class: 'nr-brand', children: [title('app.title'), el('p', { class: 'nr-brand-tag', text: i18n.t('app.tagline') })] }),
        el('div', { class: 'nr-loading-bar', children: [this.bar] }),
        this.tip,
      ],
      'nr-loading',
    );
  }

  setProgress(fraction: number, tipKey: StringKey): void {
    const pct = Math.round(Math.max(0, Math.min(1, fraction)) * 100);
    if (pct !== this.lastPct) {
      this.lastPct = pct;
      this.bar.style.width = `${pct}%`;
    }
    this.tip.textContent = i18n.t(tipKey);
  }
}

export class MainMenuScreen extends Screen {
  constructor(host: ScreenHost) {
    super(host, 'main');
  }

  protected body(): HTMLElement {
    const p = this.host.progress.value;
    const stat = (key: StringKey, value: string) =>
      el('div', { class: 'nr-menu-stat', children: [el('span', { text: i18n.t(key) }), el('strong', { text: value })] });

    return panel([
      el('div', {
        class: 'nr-brand',
        children: [
          el('h1', { class: 'nr-title', text: i18n.t('app.title') }),
          el('p', { class: 'nr-brand-tag', text: i18n.t('app.tagline') }),
          el('p', { class: 'nr-subtitle', text: i18n.t('howto.loop') }),
        ],
      }),
      el('div', {
        class: 'nr-list',
        children: [
          button('menu.play', this.act('uiClick', () => this.host.goto('briefing')), { variant: 'primary', className: 'wide' }),
          button('menu.daily', this.act('uiClick', () => this.host.startRace({ mode: 'daily', difficulty: p.selectedDifficulty, biome: p.selectedBiome, seedText: '' })), { className: 'wide' }),
          button('garage.title', this.act('uiClick', () => this.host.goto('garage')), { className: 'wide' }),
          button('settings.title', this.act('uiClick', () => this.host.goto('settings')), { className: 'wide' }),
          button('howto.title', this.act('uiClick', () => this.host.goto('howto')), { className: 'wide' }),
        ],
      }),
      el('div', { class: 'nr-row nr-row--between', children: [
        el('div', { class: 'nr-row', children: [
          this.localeButton(),
          button('menu.fullscreen', this.act('uiClick', () => this.host.toggleFullscreen()), { variant: 'ghost', icon: '⛶' }),
        ] }),
        el('span', { class: 'nr-price', text: `${i18n.t('app.creditShort')} ${formatNumber(p.credits)}` }),
      ] }),
      el('div', { class: 'nr-menu-stats', children: [
        stat('menu.bestScore', formatNumber(p.bestScore)),
        stat('menu.bestTime', p.bestTimeSec > 0 ? formatTime(p.bestTimeSec) : '—'),
        stat('menu.bestCombo', `×${p.bestCombo}`),
        stat('menu.runs', formatNumber(p.runs)),
        stat('menu.distance', `${(p.distanceFlown / 1000).toFixed(1)} ${i18n.t('unit.kilometres')}`),
      ] }),
      el('p', { class: 'nr-field-desc', text: i18n.t('app.version') }),
    ]);
  }

  private localeButton(): HTMLElement {
    const next = i18n.current === 'en' ? 'ru' : 'en';
    return button(null, this.act('uiClick', () => {
      this.host.settings.set('locale', next);
      this.host.applySettings();
      this.show();
    }), { variant: 'ghost', icon: '🌐', hint: next.toUpperCase(), ariaKey: i18n.t('app.language') });
  }
}

export class BriefingScreen extends Screen {
  private mode: RaceMode = 'standard';
  private seedText = '';

  constructor(host: ScreenHost) {
    super(host, 'briefing');
  }

  protected override onShow(data?: unknown): void {
    if (typeof data === 'string') this.mode = data as RaceMode;
    const summary = this.host.summarize(this.host.progress.value.selectedDifficulty, this.mode);
    if (this.mode !== 'seed' || !this.seedText) this.seedText = summary.seedText;
  }

  protected body(): HTMLElement {
    const progress = this.host.progress;
    const difficulty = progress.value.selectedDifficulty;
    const biome = progress.value.selectedBiome;
    const summary = this.host.summarize(difficulty, this.mode);

    const seedInput = el('input', {
      class: 'nr-seed-input',
      attrs: { type: 'text', maxlength: '24', value: this.seedText, 'aria-label': i18n.t('brief.seed') },
      on: { input: () => { this.seedText = seedInput.value; } },
    });

    return panel([
      el('div', { class: 'nr-row nr-row--between', children: [
        title('brief.title'),
        el('span', { class: 'nr-badge', text: i18n.t('results.par', { t: formatTime(summary.parSeconds) }) }),
      ] }),
      el('div', { class: 'nr-grid', children: [
        this.infoCard('brief.difficulty', i18n.t(`difficulty.${difficulty}` as StringKey), i18n.t(`difficulty.${difficulty}.desc` as StringKey)),
        this.infoCard('brief.biome', i18n.t(`biome.${biome}` as StringKey), i18n.t(`biome.${biome}.desc` as StringKey)),
        this.infoCard('brief.laneLength', `${(summary.lengthMetres / 1000).toFixed(2)} ${i18n.t('unit.kilometres')}`, `${i18n.t('brief.parTime')}: ${formatTime(summary.parSeconds)}`),
      ] }),
      row('brief.modes', segment(
        [
          { id: 'standard', label: i18n.t('brief.modeStandard') },
          { id: 'daily', label: i18n.t('brief.modeDaily') },
          { id: 'seed', label: i18n.t('brief.modeSeed') },
        ],
        this.mode,
        (id) => {
          this.mode = id as RaceMode;
          this.show();
        },
        'brief.modes',
      )),
      this.mode === 'seed'
        ? el('div', { class: 'nr-field', children: [
          el('span', { class: 'nr-field-label', text: i18n.t('brief.seed') }),
          el('div', { class: 'nr-row', children: [seedInput, button('brief.randomize', this.act('uiClick', () => {
            this.seedText = this.host.summarize(difficulty, 'seed').seedText;
            this.show();
          }), { variant: 'ghost' })] }),
        ] })
        : null,
      this.mode === 'daily' ? this.dailyPanel() : null,
      el('div', { class: 'nr-row nr-row--end', children: [
        button('brief.back', this.act('uiBack', () => this.host.goto('main_menu')), { variant: 'ghost' }),
        button('brief.start', this.act('uiClick', () => this.host.startRace({ mode: this.mode, difficulty, biome, seedText: this.seedText })), { variant: 'primary' }),
      ] }),
      note(i18n.t('brief.hint')),
    ].filter(Boolean) as (HTMLElement | null)[]);
  }

  private dailyPanel(): HTMLElement {
    // The day key comes from the host: it is the same derivation the seed and the save use,
    // and a locally formatted date here would silently never match a stored best.
    const entry = this.host.progress.value.daily[this.host.dailyKey()];
    return el('div', { class: 'nr-col nr-daily', children: [
      el('div', { class: 'nr-row', children: [el('span', { class: 'nr-badge is-daily', text: i18n.t('daily.title') }), el('span', { class: 'nr-card-desc', text: i18n.t('daily.note') })] }),
      el('div', { class: 'nr-row', children: [
        el('span', { class: 'nr-price', text: `${i18n.t('daily.bestScore')}: ${entry ? formatNumber(entry.score) : i18n.t('daily.notYet')}` }),
        el('span', { class: 'nr-price', text: `${i18n.t('daily.bestTime')}: ${entry ? formatTime(entry.timeSec) : '—'}` }),
      ] }),
    ] });
  }

  private infoCard(key: StringKey, value: string, detail: string): HTMLElement {
    return el('div', { class: 'nr-card nr-card--static', children: [
      el('span', { class: 'nr-card-desc', text: i18n.t(key) }),
      el('strong', { class: 'nr-card-name', text: value }),
      el('span', { class: 'nr-card-desc', text: detail }),
    ] });
  }
}

export class GarageScreen extends Screen {
  private tab: 'hulls' | 'trails' | 'cosmetics' | 'setup' = 'hulls';

  constructor(host: ScreenHost) {
    super(host, 'garage');
  }

  protected body(): HTMLElement {
    const progress = this.host.progress;
    return panel([
      el('div', { class: 'nr-row nr-row--between', children: [
        title('garage.title'),
        el('span', { class: 'nr-price is-affordable', text: `${i18n.t('app.credits')} ${formatNumber(progress.credits)}` }),
      ] }),
      el('div', { class: 'nr-tabs', children: (['hulls', 'trails', 'cosmetics', 'setup'] as const).map((id) =>
        el('button', {
          class: `nr-tab ${this.tab === id ? 'is-active' : ''}`.trim(),
          text: i18n.t(`garage.tab.${id}` as StringKey),
          attrs: { type: 'button', role: 'tab', 'aria-selected': this.tab === id },
          on: { click: () => { this.host.play('uiHover'); this.tab = id; this.show(); } },
        }),
      ) }),
      this.body2(),
      el('div', { class: 'nr-row nr-row--between', children: [
        note(i18n.t('garage.note')),
        button('common.back', this.act('uiBack', () => this.host.goto('main_menu')), { variant: 'ghost' }),
      ] }),
    ]);
  }

  private body2(): HTMLElement {
    if (this.tab === 'hulls') return this.grid(SHIP_IDS.map((id) => this.shipCard(id)));
    if (this.tab === 'trails') return this.grid(TRAIL_IDS.map((id) => this.trailCard(id)));
    if (this.tab === 'cosmetics') return this.grid(COSMETIC_IDS.map((id) => this.cosmeticCard(id)));
    return this.setup();
  }

  private grid(cards: HTMLElement[]): HTMLElement {
    return el('div', { class: 'nr-grid nr-scroll', children: cards });
  }

  private priceTag(price: number, owned: boolean): HTMLElement {
    return owned
      ? el('span', { class: 'nr-badge is-best', text: i18n.t('garage.owned') })
      : el('span', { class: `nr-price ${this.host.progress.credits >= price ? 'is-affordable' : ''}`.trim(), text: formatNumber(price) });
  }

  private card(opts: { name: string; desc: string; owned: boolean; selected: boolean; price: number; art: HTMLElement | null; onPick: () => void }): HTMLElement {
    return el('div', {
      class: `nr-card ${opts.selected ? 'is-selected' : ''} ${opts.owned ? '' : 'is-locked'}`.trim(),
      attrs: { role: 'button', tabindex: '0', 'aria-pressed': opts.selected },
      on: {
        click: opts.onPick,
        keydown: (event) => {
          const key = (event as KeyboardEvent).key;
          if (key === 'Enter' || key === ' ') {
            event.preventDefault();
            opts.onPick();
          }
        },
      },
      children: [
        opts.art,
        el('div', { class: 'nr-card-body', children: [
          el('div', { class: 'nr-card-name', text: opts.name }),
          el('div', { class: 'nr-card-desc', text: opts.desc }),
          el('div', { class: 'nr-row nr-row--between', children: [this.priceTag(opts.price, opts.owned), el('span', { class: 'nr-btn-hint', text: i18n.t(opts.selected ? 'garage.equipped' : opts.owned ? 'garage.equip' : 'common.locked') })] }),
        ] }),
      ].filter(Boolean) as HTMLElement[],
    });
  }

  private shipCard(id: ShipId): HTMLElement {
    const ship = SHIPS[id];
    const progress = this.host.progress;
    const owned = id === 'vireo' || progress.hasShip(id);
    return this.card({
      name: `${i18n.t('garage.hull')} · ${ship.id.toUpperCase()}`,
      desc: i18n.t('garage.previewHint'),
      owned,
      selected: progress.value.selectedShip === id,
      price: ship.price,
      art: el('div', { class: 'nr-card-art', style: { background: `radial-gradient(120% 130% at 50% 130%, ${ship.accent}66, ${ship.hull}22 55%, transparent 75%)` } }),
      onPick: () => this.buy(owned, ship.price, () => {
        if (!owned) progress.unlock('ship', id);
        progress.select('selectedShip', id);
        this.host.previewSetup();
      }),
    });
  }

  private trailCard(id: TrailId): HTMLElement {
    const trail = TRAILS[id];
    const progress = this.host.progress;
    const owned = id === 'cyan' || progress.hasTrail(id);
    return this.card({
      name: `${i18n.t('garage.trail')} · ${id}`,
      desc: i18n.t('garage.previewHint'),
      owned,
      selected: progress.value.selectedTrail === id,
      price: trail.price,
      art: el('div', { class: 'nr-card-art', style: { background: `linear-gradient(90deg, transparent, ${trail.halo}, ${trail.core})` } }),
      onPick: () => this.buy(owned, trail.price, () => {
        if (!owned) progress.unlock('trail', id);
        progress.select('selectedTrail', id);
        this.host.previewSetup();
      }),
    });
  }

  private cosmeticCard(id: string): HTMLElement {
    const progress = this.host.progress;
    const owned = progress.hasCosmetic(id);
    const key = `garage.cosmetic.${id}` as StringKey;
    return this.card({
      name: i18n.t(key),
      desc: i18n.t(`${key}.desc` as StringKey),
      owned,
      selected: owned,
      price: COSMETIC_PRICES.cosmetic[id] ?? 0,
      art: null,
      onPick: () => this.buy(owned, COSMETIC_PRICES.cosmetic[id] ?? 0, () => {
        progress.unlock('cosmetic', id);
        this.host.previewSetup();
      }),
    });
  }

  private buy(owned: boolean, price: number, onOwned: () => void): void {
    const progress = this.host.progress;
    if (!owned) {
      if (progress.credits < price) {
        this.host.play('uiBack');
        this.host.notify('toast.notEnough');
        return;
      }
      if (!progress.spend(price)) return;
      this.host.notify('toast.unlocked', { name: i18n.t('garage.title') });
    }
    onOwned();
    this.host.play('uiClick');
    this.show();
  }

  private setup(): HTMLElement {
    const progress = this.host.progress;
    const difficulty = progress.value.selectedDifficulty;
    const biome = progress.value.selectedBiome;
    return el('div', { class: 'nr-col', children: [
      row('brief.difficulty', segment(
        DIFFICULTIES.map((id) => ({ id, label: i18n.t(`difficulty.${id}` as StringKey), disabled: !progress.hasDifficulty(id) })),
        difficulty,
        (id) => this.unlockChoice(id as DifficultyId, 'difficulty'),
        'brief.difficulty',
      ), `difficulty.${difficulty}.desc` as StringKey),
      row('brief.biome', segment(
        BIOME_IDS.map((id) => ({ id, label: i18n.t(`biome.${id}` as StringKey), disabled: !progress.hasBiome(id) })),
        biome,
        (id) => this.unlockChoice(id as BiomeId, 'biome'),
        'brief.biome',
      ), `biome.${biome}.desc` as StringKey),
      row('settings.quality', segment(
        QUALITIES.map((id) => ({ id, label: i18n.t(`quality.${id}` as StringKey) })),
        this.host.settings.get('quality'),
        (id) => {
          this.host.settings.set('quality', id as QualityTier);
          this.host.applySettings();
          this.show();
        },
        'settings.quality',
      )),
      switchRow(this.host, 'settings.autoQuality', 'autoQuality', 'settings.autoQuality.desc'),
    ] });
  }

  private unlockChoice(id: string, kind: 'difficulty' | 'biome'): void {
    const progress = this.host.progress;
    const owned = kind === 'difficulty' ? progress.hasDifficulty(id as DifficultyId) : progress.hasBiome(id as BiomeId);
    const price = kind === 'difficulty' ? DIFFICULTY[id as DifficultyId].unlockCost : BIOMES[id as BiomeId].unlockCost;
    if (!owned) {
      if (progress.credits < price) {
        this.host.play('uiBack');
        this.host.notify('toast.notEnough');
        return;
      }
      if (!progress.spend(price)) return;
      progress.unlock(kind, id);
      this.host.notify('toast.unlocked', { name: i18n.t(kind === 'difficulty' ? (`difficulty.${id}` as StringKey) : (`biome.${id}` as StringKey)) });
    }
    progress.select(kind === 'difficulty' ? 'selectedDifficulty' : 'selectedBiome', id);
    this.host.play('uiOpen');
    this.host.previewSetup();
    this.show();
  }
}

export class SettingsScreen extends Screen {
  private tab: 'graphics' | 'audio' | 'gameplay' | 'controls' | 'data' = 'graphics';
  private listening: InputAction | null = null;

  constructor(host: ScreenHost) {
    super(host, 'settings');
  }

  setListening(action: InputAction | null): void {
    this.listening = action;
    if (this.visible) this.show();
  }

  protected body(): HTMLElement {
    return panel([
      el('div', { class: 'nr-row nr-row--between', children: [
        title('settings.title'),
        button('common.back', this.act('uiBack', () => this.host.goto('main_menu')), { variant: 'ghost' }),
      ] }),
      el('div', { class: 'nr-tabs', children: (['graphics', 'audio', 'gameplay', 'controls', 'data'] as const).map((id) =>
        el('button', {
          class: `nr-tab ${this.tab === id ? 'is-active' : ''}`.trim(),
          text: i18n.t(`settings.${id}` as StringKey),
          attrs: { type: 'button', role: 'tab', 'aria-selected': this.tab === id },
          on: { click: () => { this.host.play('uiHover'); this.tab = id; this.show(); } },
        }),
      ) }),
      this.body2(),
    ]);
  }

  private body2(): HTMLElement {
    const host = this.host;
    if (this.tab === 'graphics') {
      return el('div', { class: 'nr-col', children: [
        row('settings.quality', segment(
          QUALITIES.map((id) => ({ id, label: i18n.t(`quality.${id}` as StringKey) })),
          host.settings.get('quality'),
          (id) => { host.settings.set('quality', id as QualityTier); host.applySettings(); this.show(); },
          'settings.quality',
        )),
        switchRow(host, 'settings.autoQuality', 'autoQuality', 'settings.autoQuality.desc'),
        sliderRow(host, 'settings.uiScale', 'uiScale', 0.85, 1.25, 0.05, (v) => `${Math.round(v * 100)}%`),
        sliderRow(host, 'settings.fov', 'fovBias', -10, 14, 1, (v) => `${v > 0 ? '+' : ''}${v}°`),
        switchRow(host, 'settings.shake', 'screenShake'),
        switchRow(host, 'settings.damageFlash', 'damageFlash'),
        switchRow(host, 'settings.reducedMotion', 'reducedMotion', 'settings.reducedMotion.desc'),
        switchRow(host, 'settings.colorSafe', 'colorSafe', 'settings.colorSafe.desc'),
        switchRow(host, 'settings.contrast', 'highContrastHud'),
        switchRow(host, 'settings.fps', 'showFps'),
        row('settings.device', el('span', { class: 'nr-field-value nr-field-value--wrap', text: host.deviceSummary() })),
      ] });
    }
    if (this.tab === 'audio') {
      const pct = (v: number) => `${Math.round(v * 100)}%`;
      return el('div', { class: 'nr-col', children: [
        sliderRow(host, 'settings.master', 'masterVolume', 0, 1, 0.02, pct),
        sliderRow(host, 'settings.music', 'musicVolume', 0, 1, 0.02, pct),
        sliderRow(host, 'settings.sfx', 'sfxVolume', 0, 1, 0.02, pct),
        sliderRow(host, 'settings.engine', 'engineVolume', 0, 1, 0.02, pct),
        switchRow(host, 'settings.ducking', 'musicDucking'),
      ] });
    }
    if (this.tab === 'gameplay') {
      return el('div', { class: 'nr-col', children: [
        row('app.language', segment(
          [{ id: 'en', label: 'English' }, { id: 'ru', label: 'Русский' }],
          host.settings.get('locale'),
          (id) => { host.settings.set('locale', id as 'en' | 'ru'); host.applySettings(); this.show(); },
          'app.language',
        )),
        row('settings.touch', segment(
          [
            { id: 'auto', label: i18n.t('settings.touch.auto') },
            { id: 'on', label: i18n.t('settings.touch.on') },
            { id: 'off', label: i18n.t('settings.touch.off') },
          ],
          host.settings.get('touchControls'),
          (id) => { host.settings.set('touchControls', id as Settings['touchControls']); host.applySettings(); this.show(); },
          'settings.touch',
        )),
        switchRow(host, 'settings.tilt', 'tiltSteering'),
        switchRow(host, 'settings.reducedMotion', 'reducedMotion', 'settings.reducedMotion.desc'),
      ] });
    }
    if (this.tab === 'controls') {
      return el('div', { class: 'nr-col', children: [
        ...BIND_ORDER.map((action) => this.bindRow(action)),
        el('div', { class: 'nr-row', children: [
          el('span', { class: 'nr-card-desc', text: i18n.t('howto.gamepad') }),
          el('span', { class: 'nr-card-desc', text: i18n.t('howto.mouse') }),
        ] }),
        button('settings.resetBinds', this.act('uiClick', () => { host.resetBindings(); this.show(); }), { variant: 'ghost' }),
      ] });
    }
    return el('div', { class: 'nr-col', children: [
      row('menu.bestScore', el('span', { class: 'nr-field-value', text: formatNumber(host.progress.value.bestScore) })),
      row('menu.bestTime', el('span', { class: 'nr-field-value', text: host.progress.value.bestTimeSec > 0 ? formatTime(host.progress.value.bestTimeSec) : '—' })),
      row('menu.runs', el('span', { class: 'nr-field-value', text: formatNumber(host.progress.value.runs) })),
      el('div', { class: 'nr-row', children: [
        button('settings.resetSave', this.act('uiBack', () => this.confirmReset()), { variant: 'danger' }),
        button('common.close', this.act('uiBack', () => this.host.goto('main_menu')), { variant: 'ghost' }),
      ] }),
    ] });
  }

  private bindRow(action: InputAction): HTMLElement {
    const codes = this.host.settings.get('keybinds')[action] ?? [];
    const chip = el('button', {
      class: `nr-btn nr-keybind ${this.listening === action ? 'is-listening' : ''}`.trim(),
      text: this.listening === action ? i18n.t('settings.pressed') : codes.map((c) => c.replace('Key', '').replace('Digit', '')).join(' / ') || '—',
      attrs: { type: 'button' },
      on: { click: () => this.host.rebind(action) },
    });
    return row(BIND_LABEL[action], chip, this.listening === action ? 'settings.rebindPrompt' : undefined);
  }

  private confirmReset(): void {
    if (this.resetArmed) {
      this.host.resetSave();
      this.host.goto('main_menu');
      return;
    }
    this.resetArmed = true;
    this.host.notify('settings.resetSaveConfirm');
    this.show();
    window.setTimeout(() => { this.resetArmed = false; }, 6000);
  }

  private resetArmed = false;
}

export class HowToScreen extends Screen {
  constructor(host: ScreenHost) {
    super(host, 'howto');
  }

  protected body(): HTMLElement {
    const t = (key: StringKey) => i18n.t(key);
    const kbd = (keys: string[]) => el('div', { class: 'nr-row', children: keys.map((k) => el('span', { class: 'nr-kbd', text: k })) });
    const section = (headingKey: StringKey, children: HTMLElement[]) => el('section', { children: [el('h3', { class: 'nr-title--sm', text: t(headingKey) }), ...children] });

    return panel([
      el('div', { class: 'nr-row nr-row--between', children: [
        title('howto.title'),
        button('common.back', this.act('uiBack', () => this.host.goto('main_menu')), { variant: 'ghost' }),
      ] }),
      el('p', { class: 'nr-subtitle', text: t('howto.loop') }),
      el('div', { class: 'nr-howto-body', children: [
        section('howto.controls', [
          kbd(['W', 'S']), kbd(['A', 'D']), kbd(['SHIFT']), kbd(['SPACE']), kbd(['E']), kbd(['ESC']),
          el('p', { text: t('howto.gamepad') }),
          el('p', { text: t('howto.mouse') }),
        ]),
        section('howto.boostTitle', [el('p', { text: t('howto.boostBody') })]),
        section('howto.driftTitle', [el('p', { text: t('howto.driftBody') })]),
        section('howto.collapseTitle', [el('p', { text: t('howto.collapseBody') })]),
        section('howto.comboTitle', [el('p', { text: t('howto.comboBody') })]),
        section('howto.hazardsTitle', [el('ul', { children: (['asteroid', 'mine', 'anomaly', 'plasma', 'gate', 'rogue', 'shockwave'] as const).map((k) => el('li', { text: t(`howto.hazard.${k}` as StringKey) })) })]),
        section('howto.powerTitle', [el('ul', { children: (['energy', 'shield', 'overdrive', 'phase', 'magnet'] as const).map((k) => el('li', { text: t(`howto.power.${k}` as StringKey) })) })]),
        section('howto.tipsTitle', [el('ul', { children: (['tip1', 'tip2', 'tip3', 'tip4'] as const).map((k) => el('li', { text: t(`howto.${k}` as StringKey) })) })]),
      ] }),
    ]);
  }
}

export class PauseScreen extends Screen {
  private confirming = false;

  constructor(host: ScreenHost) {
    super(host, 'pause');
  }

  protected body(): HTMLElement {
    this.confirming = false;
    return panel(
      [
        title('pause.title'),
        el('div', { class: 'nr-list', children: [
          button('pause.resume', this.act('uiClick', () => this.host.goto('racing')), { variant: 'primary', className: 'wide' }),
          button('pause.restart', this.act('uiClick', () => this.host.goto('countdown')), { className: 'wide' }),
          button('settings.title', this.act('uiClick', () => this.host.goto('settings')), { className: 'wide' }),
          button('pause.quit', this.act('uiBack', () => this.quit()), { variant: 'danger', className: 'wide' }),
        ] }),
      ],
      'nr-panel--narrow',
    );
  }

  private quit(): void {
    if (this.confirming) {
      this.host.goto('main_menu');
      return;
    }
    this.confirming = true;
    this.host.notify('pause.confirmQuit');
    this.show();
  }
}

export class ResultsScreen extends Screen {
  private result: RaceResult | null = null;

  constructor(host: ScreenHost) {
    super(host, 'results');
  }

  protected override onShow(data?: unknown): void {
    if (data && typeof data === 'object') this.result = data as RaceResult;
  }

  protected body(): HTMLElement {
    const r = this.result;
    if (!r) return panel([title('results.title')], 'nr-panel--narrow');
    const stat = (key: StringKey, value: string, delay = 0) =>
      el('div', { class: 'nr-stat', style: { animation: `nr-screen-in 220ms ease-out ${delay}ms backwards` }, children: [
        el('dt', { text: i18n.t(key) }),
        el('dd', { text: value }),
      ] });

    const list: HTMLElement[] = [
      stat('results.score', formatNumber(r.score)),
      stat('results.time', formatTime(r.timeSec)),
      stat('results.distance', `${(r.distance / 1000).toFixed(2)} ${i18n.t('unit.kilometres')}`),
      stat('results.combo', `×${r.bestCombo}`),
      stat('results.nearMiss', formatNumber(r.nearMisses)),
      stat('results.gates', formatNumber(r.gateCount)),
      stat('results.boostTime', `${r.boostSeconds.toFixed(1)} ${i18n.t('unit.seconds')}`),
      stat('results.perfectBoosts', formatNumber(r.perfectBoosts)),
      stat('results.perfectDrifts', formatNumber(r.perfectDrifts)),
      stat('results.collapses', formatNumber(r.collapsesEscaped)),
      stat('results.pickups', formatNumber(r.pickups)),
      stat('results.hits', formatNumber(r.hits)),
      stat('results.saves', formatNumber(r.shieldSaves)),
      stat('results.topSpeed', `${Math.round(r.topSpeed * 3.6)} ${i18n.t('unit.kmh')}`),
    ];

    return panel([
      el('div', { class: 'nr-row nr-row--between', children: [
        title('results.title'),
        el('span', { class: 'nr-badge is-best', text: `${i18n.t('results.rank')}: ${r.rank}` }),
      ] }),
      el('p', { class: 'nr-subtitle', text: i18n.t(r.finished ? 'finish.sub' : 'fail.sub') }),
      el('div', { class: 'nr-row', children: [
        r.newBestScore ? el('span', { class: 'nr-badge is-best', text: i18n.t('results.newRecord') }) : null,
        r.newBestTime ? el('span', { class: 'nr-badge is-best', text: i18n.t('results.newTimeRecord') }) : null,
        el('span', { class: 'nr-price', text: `${i18n.t('results.seed')}: ${r.seed}` }),
      ].filter(Boolean) as HTMLElement[] }),
      el('h3', { class: 'nr-heading', text: i18n.t('results.breakdown') }),
      el('dl', { class: 'nr-col nr-results-grid', children: list }),
      el('dl', { class: 'nr-col nr-results-grid', children: [
        stat('results.distPoints', formatNumber(r.breakdown.distance)),
        stat('results.skillPoints', formatNumber(r.breakdown.skill)),
        stat('results.comboPoints', formatNumber(r.breakdown.combo)),
        stat('results.finishPoints', formatNumber(r.breakdown.finish)),
      ] }),
      el('dl', { class: 'nr-stat nr-results-total', children: [
        el('dt', { text: i18n.t('results.credits') }),
        el('dd', { text: `+${formatNumber(r.credits)}` }),
      ] }),
      el('div', { class: 'nr-row nr-row--end', children: [
        button('results.menu', this.act('uiBack', () => this.host.goto('main_menu')), { variant: 'ghost' }),
        button('results.setup', this.act('uiClick', () => this.host.goto('garage')), { variant: 'ghost' }),
        button('results.again', this.act('uiClick', () => this.host.startRace({ mode: r.mode, difficulty: r.difficulty, biome: r.biome, seedText: r.seed })), { variant: 'primary' }),
      ] }),
    ]);
  }
}
