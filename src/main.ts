import './ui/styles.css';
import {
  DAILY_CREDIT_MULT,
  DIFFICULTY,
  FINISH_CREDIT_BONUS,
  LANE,
  RACE,
  RANKS,
  SCORE_TO_CREDITS,
  BIOMES,
  SHIPS,
  TRAILS,
  DEBUG,
} from './data/config.ts';
import { i18n } from './data/i18n.ts';
import type { StringKey } from './data/i18n.ts';
import type { BiomeId, DifficultyId, GamePhase, InputAction, RaceMode, RaceResult } from './data/types.ts';
import { SafeStorage, detectCapabilities, onResize, onVisibility, requestFullscreen } from './core/Platform.ts';
import type { Capabilities } from './core/Platform.ts';
import { SaveSystem } from './core/SaveSystem.ts';
import { ProgressStore, SettingsStore } from './core/Stores.ts';
import { StateMachine } from './core/StateMachine.ts';
import { GameLoop } from './core/GameLoop.ts';
import { dailySeed, makeSeed, normalizeSeedInput } from './core/rng.ts';
import { InputManager } from './input/InputManager.ts';
import { AudioEngine, createSilentAudioEngine } from './audio/AudioEngine.ts';
import type { AudioEngineLike, SfxName } from './audio/AudioEngine.ts';
import { RaceRuntime, IDLE_INPUT } from './game/RaceRuntime.ts';
import type { RaceInput } from './game/RaceRuntime.ts';
import { generateTrackWithPath } from './game/TrackGenerator.ts';
import type { RenderableTrack } from './rendering/RendererManager.ts';
import { RendererManager } from './rendering/RendererManager.ts';
import { QualityManager } from './rendering/QualityManager.ts';
import type { RaceRequest, ScreenHost, TrackSummary } from './ui/Screens.ts';
import { UIManager } from './ui/UIManager.ts';
import { el } from './ui/dom.ts';
import { TiltSteering } from './input/TiltSteering.ts';
import { runSelfTest } from './core/SelfTest.ts';

/** Context handed to the state machine. One instance for the lifetime of the page. */
interface AppContext {
  app: App;
  from: GamePhase | null;
}

export class App implements ScreenHost {
  readonly caps: Capabilities;
  readonly settings: SettingsStore;
  readonly progress: ProgressStore;
  readonly input: InputManager;
  readonly quality: QualityManager;
  readonly ui: UIManager;
  readonly renderer: RendererManager;
  readonly audio: AudioEngineLike;
  private readonly save: SaveSystem;
  /** Mutable because the context has to point back at an instance that does not exist yet. */
  private readonly smCtx: AppContext = { app: null as unknown as App, from: null };
  private readonly sm = new StateMachine<AppContext>(this.smCtx);
  private loop: GameLoop | null = null;
  private rt: RaceRuntime | null = null;
  private track: RenderableTrack | null = null;
  private raceUnsubs: (() => void)[] = [];
  private lastCountdownShown = -1;
  private tilt: TiltSteering | null = null;
  private returnFromSettings: GamePhase = 'main_menu';
  private seedText = makeSeed('NEBULA', 1);
  private pendingRequest: RaceRequest | null = null;
  private lastResult: RaceResult | null = null;
  private offs: (() => void)[] = [];
  private disposed = false;
  /** Headless verification hook: samples the framebuffer after a render when armed. */
  pixelProbe = false;
  private probeResult: { mean: number; max: number; lit: number } | null = null;
  private readonly probeBuf = new Uint8Array(4);
  probeTick = 0;

  constructor(root: HTMLElement) {
    this.smCtx.app = this;
    const canvas = el('canvas', { class: 'nr-canvas', attrs: { tabindex: '-1' } });
    this.caps = detectCapabilities();
    this.save = new SaveSystem(new SafeStorage('nebula-rush'), this.caps);
    this.save.load();
    this.settings = new SettingsStore(this.save);
    this.progress = new ProgressStore(this.save);
    this.audio = typeof window.AudioContext === 'function' ? new AudioEngine(this.volumes()) : createSilentAudioEngine();
    this.input = new InputManager(canvas);
    this.input.setBindings(this.settings.value.keybinds);
    this.input.attach();
    this.quality = new QualityManager(this.settings, this.progress.effectiveQuality(this.settings.get('quality')));
    this.quality.onChange(() => this.renderer?.applyQuality());
    this.renderer = new RendererManager({
      canvas,
      quality: this.quality,
      reducedMotion: this.settings.get('reducedMotion'),
      shakeEnabled: this.settings.get('screenShake'),
    });
    this.ui = new UIManager({ root, canvas, host: this, settings: this.settings, progress: this.progress, input: this.input, debugSource: DEBUG.enabled ? () => this.debugSource() : undefined });
    this.quality.onChange(() => this.ui.applySettings());
    this.registerPhases();
    this.wireLifecycle();
    this.sm.onTransition((from, to) => {
      this.smCtx.from = from;
      if (to === 'settings' && from && from !== 'settings') this.returnFromSettings = from;
      this.ui.setPhase(to, to === 'results' ? this.lastResult ?? undefined : undefined);
    });
    this.ui.setPhase(this.sm.phase);
    this.applySettings();
  }

  /* ------------------------------------------------------------------ boot */

  async boot(): Promise<void> {
    this.sm.force('boot');
    this.startLoop();
    void this.sm.go('loading');
  }

  private startLoop(): void {
    if (this.loop) return;
    this.loop = new GameLoop({
      update: (dt) => this.step(dt),
      render: (_alpha, frameMs) => this.draw(frameMs),
      suspend: () => {
        this.audio.suspend();
        if (this.sm.is('racing', 'countdown')) this.sm.go('paused');
      },
      resume: () => {
        void this.audio.unlock();
      },
    });
    this.loop.start();
  }

  private wireLifecycle(): void {
    this.offs.push(onResize((w, h) => this.renderer.resize(w, h)));
    this.offs.push(onVisibility((hidden) => {
      if (hidden) {
        this.save.flush();
        this.loop?.setPaused(true);
      } else {
        this.loop?.setPaused(false);
      }
    }));
    const unlock = (): void => {
      void this.audio.unlock().then((ok) => {
        if (!ok && !this.audio.ready) this.ui.toast('toast.audioBlocked');
        else this.audio.startMusic();
      });
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
    window.addEventListener('pointerdown', unlock, { once: false });
    window.addEventListener('keydown', unlock, { once: false });
    this.input.onGamepadChange = (connected) => this.ui.toast(connected ? 'toast.gamepadOn' : 'toast.gamepadOff');
    this.offs.push(this.i18nOff());
    const canvas = this.renderer.renderer.domElement;
    canvas.addEventListener('webglcontextlost', (event) => {
      event.preventDefault();
      this.loop?.stop();
      this.ui.toast('error.contextLost');
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this.rebuildFromScratch();
      this.loop?.start();
    });
    window.addEventListener('beforeunload', () => this.save.flush());
    window.addEventListener('keydown', this.onGlobalKey);
  }

  private i18nOff(): () => void {
    return i18n.onChange(() => {
      this.ui.refreshLocale();
      this.ui.applySettings();
    });
  }

  private rebuildFromScratch(): void {
    if (this.track) {
      this.renderer.loadTrack(this.track, BIOMES[this.biome()]);
      if (this.rt) this.renderer.bindRuntime(this.rt);
    }
    this.applyShip();
  }

  /* ------------------------------------------------------------- screenhost */

  play(name: SfxName): void {
    this.audio.playSfx(name, { intensity: 0.6 });
  }

  notify(key: StringKey, params?: Record<string, string | number>): void {
    this.ui.toast(key, params);
  }

  goto(phase: GamePhase): void {
    this.sm.go(phase);
  }

  startRace(request: RaceRequest): void {
    this.pendingRequest = request;
    if (request.mode === 'seed' && request.seedText) this.seedText = normalizeSeedInput(request.seedText);
    void this.sm.go('loading');
    if (!this.sm.can('loading')) {
      // Loading is only reachable from the menu phases; from briefing we jump straight in.
      void this.beginRace(request);
    }
  }

  previewSetup(): void {
    this.applyShip();
    this.ui.applySettings();
  }

  applySettings(): void {
    const s = this.settings.value;
    i18n.setLocale(s.locale);
    this.input.setBindings(s.keybinds);
    this.audio.setVolumes(this.volumes());
    this.audio.setDucking(s.musicDucking);
    this.renderer.setMotionSettings(s.reducedMotion, s.screenShake);
    this.syncTilt(s.tiltSteering);
    this.ui.applySettings();
    this.renderer.resize(window.innerWidth, window.innerHeight);
    if (s.quality !== this.quality.current && !s.autoQuality) this.quality.setCeiling(this.progress.effectiveQuality(s.quality));
  }

  toggleFullscreen(): void {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void requestFullscreen(this.ui.app);
  }

  /** Where the back button in settings should lead: menu, or straight back to the race. */
  returnTarget(): GamePhase {
    return this.returnFromSettings;
  }

  rebind(action: InputAction): void {
    this.ui.settingsScreen().setListening(action);
    void this.input.beginRebind(action).then((codes) => {
      this.ui.settingsScreen().setListening(null);
      if (!codes) {
        this.ui.toast('toast.rebindCancel');
        return;
      }
      const clash = BIND_SEARCH.find(this.settings.value.keybinds, codes, action);
      if (clash) this.ui.toast('settings.conflict');
      this.settings.setKeybind(action, codes);
      this.input.setBindings(this.settings.value.keybinds);
      this.ui.toast('toast.rebindDone');
      this.ui.settingsScreen().show();
    });
  }

  resetBindings(): void {
    this.save.reset();
    this.applySettings();
    this.ui.toast('toast.saveReset');
  }

  resetSave(): void {
    this.save.reset();
    this.settings.bus.emit('change', { key: 'all' });
    this.applySettings();
    this.ui.toast('toast.saveReset');
  }

  summarize(difficulty: DifficultyId, mode: RaceMode): TrackSummary {
    const tuning = DIFFICULTY[difficulty];
    const length = RACE.targetSeconds * tuning.maxSpeed * RACE.avgSpeedRatio;
    const seedText = mode === 'daily' ? dailySeed().seed : this.seedText;
    return {
      lengthMetres: mode === 'daily' ? DAILY_LENGTH_METRES : length,
      parSeconds: mode === 'daily' ? DAILY_LENGTH_METRES / (tuning.maxSpeed * RACE.avgSpeedRatio) : RACE.targetSeconds,
      seedText,
    };
  }

  /** Tilt is opt-in and needs a gesture to gain permission on iOS, hence the sync here. */
  private syncTilt(on: boolean): void {
    if (!on) {
      this.tilt?.disable();
      return;
    }
    this.tilt ??= new TiltSteering(this.input);
    if (!this.tilt.active) void this.tilt.enable().then((granted) => {
      if (!granted) this.ui.toast('toast.tiltDenied');
    });
  }

  deviceSummary(): string {
    const c = this.caps;
    const parts = [
      c.renderer,
      `${c.cores} cores`,
      `DPR ${c.devicePixelRatio}`,
      c.maxTextureSize ? `${c.maxTextureSize}px` : '',
      this.quality.current,
      this.settings.get('touchControls') === 'on' || c.coarsePointer ? 'touch' : 'kbd',
    ].filter(Boolean);
    return parts.join(' · ');
  }

  audioBlocked(): boolean {
    return !this.audio.ready;
  }

  dailyKey(): string {
    return dailySeed().dayKey;
  }

  /* ------------------------------------------------------------------ phases */

  private registerPhases(): void {
    this.sm.register('boot', {});
    this.sm.register('loading', {
      enter: async (_from, c) => {
        const request = c.app.pendingRequest;
        c.app.ui.setLoadingProgress(0.05, 'tip.launch');
        const difficulty = request?.difficulty ?? c.app.difficulty();
        const biome = request?.biome ?? c.app.biome();
        const mode = request?.mode ?? 'standard';
        const seedText = request?.seedText || c.app.seedText;
        await c.app.loadTrack(mode, difficulty, biome, seedText, request ? 0.4 : 0);
        c.app.ui.setLoadingProgress(1, 'tip.boost');
        window.setTimeout(() => {
          if (c.app.sm.is('loading')) void (request ? c.app.sm.go('countdown') : c.app.sm.go('main_menu'));
        }, 60);
      },
    });
    this.sm.register('main_menu', {
      enter: () => {
        this.audio.setMusicIntensity(0.25);
      },
    });
    this.sm.register('garage', { enter: () => this.audio.playSfx('uiOpen', { intensity: 0.4 }) });
    this.sm.register('settings', {});
    this.sm.register('howto', {});
    this.sm.register('briefing', {});
    this.sm.register('countdown', {
      enter: () => {
        this.resetRace();
        this.lastCountdownShown = -1;
      },
      update: (dt) => {
        const rt = this.rt;
        if (!rt) {
          void this.sm.go('racing');
          return;
        }
        this.raceUpdate(dt);
        if (rt.status === 'running') void this.sm.go('racing');
      },
      simulate: true,
    });
    this.sm.register('racing', {
      simulate: true,
      update: (dt) => this.raceUpdate(dt),
      canLeave: (to) => to !== 'racing',
    });
    this.sm.register('paused', {
      enter: () => {
        this.audio.setMusicIntensity(0.1);
        this.audio.playSfx('uiOpen', { intensity: 0.5 });
      },
      exit: () => this.audio.setMusicIntensity(0.6),
    });
    this.sm.register('finish', {
      enter: async () => {
        const result = this.buildResult();
        this.lastResult = result;
        this.commitResult(result);
        await sleep(900);
        if (!this.disposed) void this.sm.go('results');
      },
    });
    this.sm.register('results', {
      enter: () => {
        this.ui.resultsScreen().show(this.lastResult ?? undefined);
        this.audio.setMusicIntensity(0.3);
      },
    });
  }

  /* ------------------------------------------------------------------- race */

  private async beginRace(request: RaceRequest): Promise<void> {
    this.pendingRequest = request;
    await this.loadTrack(request.mode, request.difficulty, request.biome, request.seedText, 0);
    void this.sm.go('countdown');
  }

  private async loadTrack(mode: RaceMode, difficulty: DifficultyId, biome: BiomeId, seedText: string, _from: number): Promise<void> {
    const normalized = mode === 'daily' ? dailySeed().seed : normalizeSeedInput(seedText || this.seedText);
    if (mode === 'seed') this.seedText = normalized;
    // Yield once so the loading screen paints before the generator blocks on a big lane.
    await sleep(0);
    const generated = generateTrackWithPath({
      seed: normalized,
      difficulty,
      biome,
      rowCountOverride: mode === 'daily' ? DAILY_ROWS : undefined,
    });
    this.track = { ...generated, meta: generated.meta };
    const tuning = BIOMES[biome];
    this.renderer.loadTrack(this.track, tuning);
    this.applyShip();
    this.renderer.resize(window.innerWidth, window.innerHeight);
    this.rt = new RaceRuntime({
      seed: normalized,
      difficulty,
      biome,
      rows: this.track.rows,
      entities: this.track.entities,
      path: this.track.path,
      length: generated.meta.length,
    });
    this.bindRaceEvents(this.rt);
    this.renderer.bindRuntime(this.rt);
    await sleep(0);
  }

  private applyShip(): void {
    const p = this.progress.value;
    const ship = SHIPS[p.selectedShip] ?? SHIPS.vireo;
    const trail = TRAILS[p.selectedTrail] ?? TRAILS.cyan;
    this.renderer.setShip(ship as ShipTuningAlias, trail as TrailTuningAlias, p.ownedCosmetics);
  }

  private resetRace(): void {
    if (!this.rt) return;
    this.rt.reset();
    this.lastCountdownShown = -1;
    this.renderer.bindRuntime(this.rt);
  }

  private bindRaceEvents(rt: RaceRuntime): void {
    for (const off of this.raceUnsubs) off();
    this.raceUnsubs = [];
    const audio = this.audio;
    const on = <T>(event: string, handler: (payload: T) => void): void => {
      this.raceUnsubs.push(rt.bus.on(event, handler as unknown as (payload: unknown) => void));
    };
    on('countdown', (payload: { value: number }) => {
      const value = payload.value;
      if (value === this.lastCountdownShown) return;
      this.lastCountdownShown = value;
      this.ui.hud.showCountdown(value);
      audio.playSfx(value > 0 ? 'countdown' : 'countdownGo', { intensity: 1 });
    });
    on('gate', (payload: { boost: boolean }) => audio.playSfx('gate', { intensity: payload.boost ? 1 : 0.6 }));
    on('nearMiss', () => audio.playSfx('nearMiss', { intensity: 0.8 }));
    on('pickup', (payload: { kind: string }) => {
      audio.playSfx('gate', { intensity: 0.45 });
      const key = (`toast.${payload.kind}On`) as StringKey;
      this.ui.hud.showFlash('toast.energy');
      void key;
    });
    on('hit', (payload: { severity: number; blocked: boolean }) => {
      audio.playSfx(payload.blocked ? 'shieldBreak' : payload.severity > 0.6 ? 'hitHeavy' : 'hit', { intensity: 1 });
    });
    on('scrape', () => audio.playSfx('scrape', { intensity: 0.6 }));
    on('collapseWarn', () => audio.playSfx('collapseWarn', { intensity: 0.8 }));
    on('collapseBreak', () => audio.playSfx('collapseBreak', { intensity: 1 }));
    on('collapseEscape', (payload: { score: number }) => {
      audio.playSfx('perfectBoost', { intensity: 0.9 });
      this.ui.hud.showFlash('toast.collapseEscape', { score: payload.score });
    });
    on('shockwaveStart', () => audio.playSfx('shockwave', { intensity: 1 }));
    on('shockwaveEscape', () => this.ui.hud.showFlash('toast.shockwaveEscape'));
    on('perfectBoost', () => {
      audio.playSfx('perfectBoost', { intensity: 1 });
      this.ui.hud.showFlash('toast.perfectBoost');
    });
    on('perfectDrift', () => {
      audio.playSfx('perfectDrift', { intensity: 1 });
      this.ui.hud.showFlash('toast.perfectDrift');
    });
    on('comboBreak', (payload: { chain: number }) => {
      audio.playSfx('uiBack', { intensity: 0.5 });
      this.ui.hud.showFlash('toast.comboBroken', { chain: payload.chain });
    });
    on('shield', (payload: { on: boolean }) => {
      audio.playSfx(payload.on ? 'shieldUp' : 'shieldBreak', { intensity: 0.8 });
      this.ui.hud.showFlash(payload.on ? 'toast.shieldOn' : 'toast.shieldBreak');
    });
    on('powerup', (payload: { kind: string }) => {
      const key: Record<string, StringKey> = {
        overdrive: 'toast.overdrive',
        phase: 'toast.phase',
        magnet: 'toast.magnet',
        shield: 'toast.shieldOn',
        energy: 'toast.energy',
      };
      this.ui.hud.showFlash(key[payload.kind] ?? 'toast.energy');
    });
    on('ability', () => {
      audio.playSfx('ability', { intensity: 1 });
      this.ui.hud.showFlash('toast.abilityUsed');
    });
    on('spectacle', (payload: { id: string; phase: string }) => {
      if (payload.id === 'wormhole' && payload.phase === 'enter') audio.playSfx('wormhole', { intensity: 1 });
      if (payload.id === 'supernova' && payload.phase === 'enter') audio.playSfx('warp', { intensity: 1 });
    });
    on('finish', () => audio.playSfx('finish', { intensity: 1 }));
    on('death', () => audio.playSfx('hitHeavy', { intensity: 1 }));
  }

  private raceUpdate(dt: number): void {
    const rt = this.rt;
    if (!rt) return;
    const frame = this.input.update(dt);
    if (frame.restartPressed) {
      this.resetRace();
      void this.sm.go('countdown');
      return;
    }
    if (frame.pausePressed) {
      void this.sm.go('paused');
      return;
    }
    const input: RaceInput = rt.status === 'countdown' || rt.status === 'running'
      ? {
          throttle: this.settings.get('invertLook') ? frame.throttle : frame.throttle,
          steer: frame.steer,
          boost: frame.boost,
          drift: frame.drift,
          abilityPressed: frame.abilityPressed,
          pausePressed: false,
          restartPressed: false,
        }
      : IDLE_INPUT;
    rt.step(dt, input);
    rt.updateHud();
    this.updateAudioRumble(rt, dt);
    if (rt.status === 'finished' || rt.status === 'wrecked') void this.sm.go('finish');
  }

  private updateAudioRumble(rt: RaceRuntime, dt: number): void {
    const p = rt.player;
    const top = Math.max(60, p.topSpeed);
    this.audio.updateEngine(
      {
        speed01: Math.min(1, p.speed / top),
        boost: p.boostEnvelope,
        throttle: rt.lastInput.throttle,
        drifting: Math.min(1, Math.abs(p.slide)),
        damage: p.damage,
        active: rt.status === 'running',
      },
      dt,
    );
    this.audio.setWarning(rt.warnings.length > 0);
    this.audio.setMusicIntensity(0.35 + Math.min(0.65, (p.speed / top) * 0.4 + rt.collapse.activeCount * 0.12));
  }

  private buildResult(): RaceResult {
    const rt = this.rt;
    const mode = this.pendingRequest?.mode ?? 'standard';
    if (!rt) {
      throw new Error('result built without a race');
    }
    const p = rt.player;
    const finished = rt.status === 'finished';
    const length = this.track?.meta.length ?? 1;
    const par = length / (DIFFICULTY[rt.config.difficulty].maxSpeed * RACE.avgSpeedRatio);
    const ratio = finished ? par / Math.max(0.001, p.timeSec) : 0;
    const rank = finished ? RANKS.find((entry) => ratio >= entry.ratio)?.rank ?? 'D' : '—';
    const base = Math.round(p.score);
    const credits = Math.max(
      0,
      Math.round(base / SCORE_TO_CREDITS + (finished ? FINISH_CREDIT_BONUS : 0) * (mode === 'daily' ? DAILY_CREDIT_MULT : 1)),
    );
    const best = this.progress.value;
    const newBestScore = base > best.bestScore;
    const newBestTime = finished && p.timeSec > 0 && (best.bestTimeSec === 0 || p.timeSec < best.bestTimeSec);
    return {
      score: base,
      distance: Math.round(p.distance),
      timeSec: p.timeSec,
      bestCombo: p.stats.bestChain,
      comboEvents: p.stats.comboEvents,
      nearMisses: p.stats.nearMisses,
      gateCount: p.stats.gates,
      boostSeconds: p.boostSeconds,
      perfectBoosts: p.stats.perfectBoosts,
      perfectDrifts: p.stats.perfectDrifts,
      collapsesEscaped: p.stats.collapsesEscaped,
      pickups: p.stats.pickups,
      credits,
      hits: p.hits,
      shieldSaves: p.stats.shieldSaves,
      abilityUses: p.abilityUses,
      breakdown: { ...p.parts },
      topSpeed: p.topSpeed,
      ship: this.progress.value.selectedShip,
      seed: rt.config.seed,
      mode,
      difficulty: rt.config.difficulty,
      biome: rt.config.biome,
      finished,
      rank,
      percentileScore: Math.min(99, Math.round((base / Math.max(1, best.bestScore)) * 60)),
      newBestScore,
      newBestTime,
    };
  }

  private commitResult(result: RaceResult): void {
    const progress = this.progress;
    const p = progress.value;
    p.runs++;
    p.distanceFlown += result.distance;
    progress.addCredits(result.credits);
    progress.setBestScore(result.score);
    if (result.finished) {
      p.racesFinished++;
      progress.setBestTime(result.timeSec);
    }
    progress.setBestCombo(result.bestCombo);
    if (result.mode === 'daily') progress.recordDaily(dailySeed().dayKey, result.score, result.timeSec);
    if (!p.firstRaceDone) {
      p.firstRaceDone = true;
      this.save.save(true);
    }
    this.save.save(true);
  }

  /* -------------------------------------------------------------- per frame */

  private fpsAt = 0;

  /** The frame counter is a courtesy for players who turn it on, so it costs nothing else. */
  private fpsSampler(frameMs: number): void {
    const nowMs = performance.now();
    if (nowMs - this.fpsAt < 400) return;
    this.fpsAt = nowMs;
    if (!this.settings.get('showFps')) {
      this.ui.hud.setFps(null);
      return;
    }
    const fps = this.loop ? this.loop.stats.fps : 1000 / Math.max(1, frameMs);
    this.ui.hud.setFps(fps);
  }

  /**
   * Escape is the one navigation key that must work everywhere, including inside menus where
   * the race input poll is not running. It steps back through the phase graph rather than
   * jumping to the root, and stays out of the way while a keybind is being captured.
   */
  private onGlobalKey = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    const target = event.target as HTMLElement | null;
    if (target?.tagName === 'INPUT') return;
    if (document.querySelector('.nr-keybind.is-listening')) return;
    switch (this.sm.phase) {
      case 'settings':
      case 'howto':
        event.preventDefault();
        event.preventDefault();
        this.sm.go(this.returnFromSettings);
        break;
      case 'garage':
        event.preventDefault();
        this.sm.go('main_menu');
        break;
      case 'briefing':
        event.preventDefault();
        this.sm.go('main_menu');
        break;
      case 'results':
        event.preventDefault();
        this.sm.go('main_menu');
        break;
      case 'paused':
        event.preventDefault();
        this.sm.go('racing');
        break;
      case 'racing':
      case 'countdown':
        event.preventDefault();
        this.sm.go('paused');
        break;
      default:
        break;
    }
  };

  private step(dt: number): void {
    this.sm.update(dt);
  }

  private draw(frameMs: number): void {
    if (this.pixelProbe) {
      // Composer passes each reset the counter, so accumulate the whole frame instead.
      this.renderer.renderer.info.autoReset = false;
      this.renderer.renderer.info.reset();
    }
    const phase = this.sm.phase;
    const racing = phase === 'racing' || phase === 'countdown' || phase === 'paused' || phase === 'finish';
    if (racing && this.rt) {
      const rt = this.rt;
      this.ui.hud.sync(rt, performance.now() / 1000);
      this.renderer.renderRaceFrame(rt, frameMs / 1000);
    } else if (phase === 'garage') {
      this.renderer.renderShowcase(Math.min(0.05, frameMs / 1000));
    } else {
      this.renderer.renderAmbient(Math.min(0.05, frameMs / 1000));
    }
    this.ui.update(Math.min(0.05, frameMs / 1000));
    if (this.loop && this.settings.get('autoQuality')) {
      const sample = this.loop.takeWindowSample();
      if (sample.frames > 0 && this.quality.observe(sample, performance.now() / 1000)) {
        this.renderer.applyQuality();
        this.ui.toast('toast.qualityAuto');
      }
    }
    if (this.pixelProbe) { this.probeTick++; this.sampleFrame(); this.renderer.renderer.info.autoReset = true; }
    this.fpsSampler(frameMs);
    if (this.settings.get('showFps') && this.loop) {
      // The debug panel owns the readout; this only feeds it.
      this.renderer.renderer.info.autoReset = true;
    }
  }

  private debugSource(): Record<string, string | number> {
    const rt = this.rt;
    const info = this.renderer.stats;
    const stats = this.loop?.stats;
    return {
      fps: stats ? Math.round(stats.fps) : 0,
      frame: stats ? `${stats.frameMs.toFixed(1)}ms` : '—',
      worst: stats ? `${stats.worstMs.toFixed(1)}ms` : '—',
      steps: stats?.lastSteps ?? 0,
      dropped: stats?.dropped ?? 0,
      tier: this.quality.current,
      draws: info.calls,
      tris: info.triangles,
      geo: info.geometries,
      tex: info.textures,
      particles: this.renderer.particleCount ?? 0,
      entities: rt ? rt.entities.length : 0,
      collapse: rt ? rt.collapse.activeCount : 0,
      speed: rt ? `${Math.round(rt.player.speed * 3.6)} km/h` : '—',
      seed: rt?.config.seed ?? this.seedText,
      mode: this.pendingRequest?.mode ?? '—',
    };
  }

  /* ------------------------------------------------------------ inspection */

  /** Read-only handles for the self-test harness and the debug panel. */
  get phase(): GamePhase {
    return this.sm.phase;
  }

  get runtime(): RaceRuntime | null {
    return this.rt;
  }

  /** Latest framebuffer probe, or null before the first sampled frame. */
  readPixels(): { mean: number; max: number; lit: number } | null {
    return this.probeResult;
  }

  /**
   * Nine framebuffer reads across the visible band. Only ever runs while the self-test is
   * armed, so a normal frame never pays for a synchronous GPU read.
   */
  private sampleFrame(): void {
    const gl = this.renderer.renderer.getContext();
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    let sum = 0;
    let max = 0;
    let lit = 0;
    let n = 0;
    for (let gy = 0; gy < 3; gy++) {
      for (let gx = 0; gx < 3; gx++) {
        const x = Math.floor(((gx + 0.5) / 3) * w);
        const y = Math.floor(((gy + 0.5) / 3) * h);
        if (x >= w || y >= h) continue;
        gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, this.probeBuf);
        const luma = 0.2126 * this.probeBuf[0] + 0.7152 * this.probeBuf[1] + 0.0722 * this.probeBuf[2];
        sum += luma;
        if (luma > max) max = luma;
        if (luma > 8) lit++;
        n++;
      }
    }
    this.probeResult = { mean: sum / Math.max(1, n), max: Math.round(max), lit: lit / Math.max(1, n) };
  }

  /* ------------------------------------------------------------------ misc */

  private difficulty(): DifficultyId {
    return this.progress.value.selectedDifficulty;
  }

  private biome(): BiomeId {
    return this.progress.value.selectedBiome;
  }

  private volumes(): { master: number; music: number; sfx: number; engine: number } {
    const s = this.settings?.value ?? this.save.settings;
    return { master: s.masterVolume, music: s.musicVolume, sfx: s.sfxVolume, engine: s.engineVolume };
  }

  dispose(): void {
    this.disposed = true;
    for (const off of this.offs) off();
    for (const off of this.raceUnsubs) off();
    this.loop?.stop();
    this.input.detach();
    this.audio.dispose();
    this.renderer.dispose();
    this.ui.dispose();
    this.quality.dispose();
    this.save.flush();
  }
}

/** The daily lane is the same length for every player, every day. */
const DAILY_ROWS = 720;
const DAILY_LENGTH_METRES = DAILY_ROWS * LANE.rowLen;

type ShipTuningAlias = Parameters<RendererManager['setShip']>[0];
type TrailTuningAlias = Parameters<RendererManager['setShip']>[1];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/* ------------------------------------------------------------------- entry */

/** Reports a binding that already belongs to another action. */
const BIND_SEARCH = {
  find(map: Record<string, string[]>, codes: string[], ignore: string): string | null {
    for (const [action, list] of Object.entries(map)) {
      if (action === ignore) continue;
      if (list.some((code) => codes.includes(code))) return action;
    }
    return null;
  },
};

function showError(error: unknown): void {
  const root = document.getElementById('root');
  if (!root) return;
  const message = error instanceof Error ? error.message : String(error);
  const panel = el('div', {
    class: 'nr-screen is-active',
    children: [
      el('div', {
        class: 'nr-panel nr-panel--narrow',
        children: [
          el('h2', { class: 'nr-title', text: i18n.t('error.title') }),
          el('p', { class: 'nr-subtitle', text: message }),
          el('div', { class: 'nr-row', children: [
            el('button', { class: 'nr-btn primary', text: i18n.t('error.reload'), attrs: { type: 'button' }, on: { click: () => window.location.reload() } }),
          ] }),
        ],
      }),
    ],
  });
  root.appendChild(panel);
}

async function main(): Promise<void> {
  const root = document.getElementById('root');
  if (!root) return;
  try {
    const app = new App(root);
    window.__nebula = app;
    await app.boot();
    if (new URLSearchParams(window.location.search).has('selftest')) void runSelfTest(app);
  } catch (error) {
    showError(error);
  }
}

if (typeof window === 'object') {
  window.addEventListener('error', (event) => showError(event.error ?? event.message));
  window.addEventListener('unhandledrejection', (event) => showError(event.reason));
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => void main());
  else void main();
}

declare global {
  interface Window {
    __nebula?: App;
  }
}
