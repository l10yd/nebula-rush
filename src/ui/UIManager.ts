import { DEBUG, UI } from '../data/config.ts';
import { i18n } from '../data/i18n.ts';
import type { StringKey } from '../data/i18n.ts';
import type { GamePhase } from '../data/types.ts';
import type { ProgressStore, SettingsStore } from '../core/Stores.ts';
import type { InputManager } from '../input/InputManager.ts';
import { append, clear, el } from './dom.ts';
import { Hud } from './Hud.ts';
import { DebugPanel } from './DebugPanel.ts';
import type { DebugSource } from './DebugPanel.ts';
import { TouchControls } from './TouchControls.ts';
import { BriefingScreen, GarageScreen, HowToScreen, LoadingScreen, MainMenuScreen, PauseScreen, ResultsScreen, SettingsScreen } from './Screens.ts';
import type { Screen, ScreenHost } from './Screens.ts';

const SCREEN_FOR_PHASE: Partial<Record<GamePhase, 'loading' | 'main' | 'garage' | 'settings' | 'howto' | 'briefing' | 'pause' | 'results'>> = {
  boot: 'loading',
  loading: 'loading',
  main_menu: 'main',
  garage: 'garage',
  settings: 'settings',
  howto: 'howto',
  briefing: 'briefing',
  paused: 'pause',
  finish: 'results',
  results: 'results',
};

export interface UiPorts {
  root: HTMLElement;
  canvas: HTMLCanvasElement;
  host: ScreenHost;
  settings: SettingsStore;
  progress: ProgressStore;
  input: InputManager;
  debugSource?: DebugSource;
}

/**
 * Owns the DOM overlay: which screen is up, what the HUD is doing, and every cosmetic class
 * the settings can toggle. Phases arrive from the state machine; nothing here decides logic.
 */
export class UIManager {
  readonly app = el('div', { class: 'nr-app' });
  readonly overlay = el('div', { class: 'nr-overlay' });
  readonly hud: Hud;
  readonly touch: TouchControls;
  readonly loading: LoadingScreen;
  readonly debug: DebugPanel | null;
  private readonly canvas: HTMLCanvasElement;
  private readonly toasts = el('div', { class: 'nr-toasts', attrs: { 'aria-live': 'polite' } });
  private readonly screens: Record<string, Screen>;
  private current: Screen | null = null;
  private readonly offs: (() => void)[] = [];
  private readonly timers = new Set<number>();

  constructor(private readonly ports: UiPorts) {
    this.canvas = ports.canvas;
    this.app.appendChild(this.canvas);
    this.hud = new Hud();
    this.touch = new TouchControls(ports.input);
    this.loading = new LoadingScreen(ports.host);
    this.screens = {
      loading: this.loading,
      main: new MainMenuScreen(ports.host),
      garage: new GarageScreen(ports.host),
      settings: new SettingsScreen(ports.host),
      howto: new HowToScreen(ports.host),
      briefing: new BriefingScreen(ports.host),
      pause: new PauseScreen(ports.host),
      results: new ResultsScreen(ports.host),
    };
    append(this.overlay, [this.hud.root, ...Object.values(this.screens).map((screen) => screen.root), this.touch.root, this.toasts]);
    this.debug = DEBUG.enabled && ports.debugSource ? new DebugPanel(ports.debugSource) : null;
    if (this.debug) this.overlay.appendChild(this.debug.root);
    append(this.app, [
      this.overlay,
      el('div', { class: 'nr-rotate', children: [el('p', { class: 'nr-title--sm', text: i18n.t('app.title') }), el('p', { class: 'nr-subtitle', text: i18n.t('brief.hint') })] }),
    ]);
    ports.root.appendChild(this.app);
    this.applySettings();
    this.offs.push(ports.settings.onChange(() => this.applySettings()));
    window.addEventListener('keydown', this.onKeyDown);
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'F3' && this.debug) {
      event.preventDefault();
      this.debug.toggle();
    }
  };

  setLoadingProgress(fraction: number, tipKey: StringKey): void {
    this.loading.setProgress(fraction, tipKey);
  }

  /** Routes a state-machine phase to its screen and the matching input mode. */
  setPhase(phase: GamePhase, data?: unknown): void {
    const name = SCREEN_FOR_PHASE[phase];
    const next = name ? this.screens[name] : null;
    if (this.current && this.current !== next) this.current.hide();
    this.current = next;
    if (next) next.show(data);
    const racing = phase === 'racing' || phase === 'countdown';
    this.hud.setVisible(racing || phase === 'paused');
    this.touch.setVisible(racing);
    this.ports.input.setMode(next ? 'ui' : 'game');
  }

  get activeScreen(): Screen | null {
    return this.current;
  }

  toast(key: StringKey, params?: Record<string, string | number>): void {
    const node = el('div', { class: 'nr-toast', text: i18n.t(key, params) });
    append(this.toasts, [node]);
    const timer = window.setTimeout(() => {
      node.remove();
      this.timers.delete(timer);
    }, UI.toastSeconds * 1000);
    this.timers.add(timer);
    // More than four at once is unreadable, and unreadable is worse than missing.
    while (this.toasts.childElementCount > 4) this.toasts.firstElementChild?.remove();
  }

  settingsScreen(): SettingsScreen {
    return this.screens.settings as SettingsScreen;
  }

  briefingScreen(): BriefingScreen {
    return this.screens.briefing as BriefingScreen;
  }

  resultsScreen(): ResultsScreen {
    return this.screens.results as ResultsScreen;
  }

  /** Reflects every presentation-affecting setting onto the overlay. */
  applySettings(): void {
    const s = this.ports.settings.value;
    const app = this.app;
    app.dataset.biome = this.ports.progress.value.selectedBiome;
    app.classList.toggle('reduced-motion', s.reducedMotion);
    app.classList.toggle('high-contrast', s.highContrastHud);
    app.classList.toggle('colour-safe', s.colorSafe);
    app.style.setProperty('--nr-scale', String(s.uiScale));
    document.documentElement.lang = i18n.current;
    const coarse = window.matchMedia('(pointer: coarse)').matches;
    app.classList.toggle('is-touch', s.touchControls === 'on' || (s.touchControls === 'auto' && coarse));
    this.hud.root.classList.toggle('is-frame-aegis', this.ports.progress.hasCosmetic('hud_frame'));
  }

  refreshLocale(): void {
    this.hud.refreshLocale();
    this.current?.show();
  }

  update(dt: number): void {
    this.debug?.update(dt);
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
    for (const timer of this.timers) window.clearTimeout(timer);
    this.timers.clear();
    window.removeEventListener('keydown', this.onKeyDown);
    this.hud.dispose();
    this.touch.dispose();
    this.debug?.dispose();
    clear(this.overlay);
    this.app.remove();
  }
}
