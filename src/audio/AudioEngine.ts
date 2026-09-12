/**
 * NEBULA RUSH — fully procedural Web Audio engine (contract §A).
 *
 * Zero external assets: every sound is synthesised from oscillators, a shared noise
 * buffer and biquad filters. A procedurally generated decaying-noise impulse response
 * drives a convolver on a reverb send bus.
 *
 * Signal flow:
 *   destination ← masterCompressor (limiter, ceiling AUDIO.masterCeiling) ← masterGain
 *     ← { sfx, music, engine } buses, each: gain → limiter compressor → masterGain
 *     ← reverbReturn ← convolver(IR) ← reverbIn (send bus)
 *   music:  six persistent layer gains (kick/snare/hat/bass/arp/pad) → music sum → music bus
 *   engine: persistent detuned saw pair + sub + filtered-noise grit + drift squeal + boost
 *           whine, all automated with setTargetAtTime (never re-created per frame)
 *
 * The AudioContext is created lazily on the first `init()`/`unlock()` (user gesture),
 * every public method is guarded so a suspended/unsupported context degrades to silence,
 * and one-shot voices are capped by an actual budget manager with steal/drop semantics.
 */

import { clamp01, damp, lerp, smoothstep } from '../utils/math.ts';
import { Rng } from '../core/rng.ts';

// ---------------------------------------------------------------------------
// Contract types (§A) — exact names and signatures.
// ---------------------------------------------------------------------------

export type SfxName =
  | 'uiHover' | 'uiClick' | 'uiBack' | 'uiOpen' | 'uiClose'
  | 'boostStart' | 'boostEnd' | 'perfectBoost' | 'warp'
  | 'driftStart' | 'driftEnd' | 'perfectDrift'
  | 'hit' | 'hitHeavy' | 'scrape' | 'shieldUp' | 'shieldBreak'
  | 'gate' | 'nearMiss' | 'collapseWarn' | 'collapseBreak' | 'shockwave'
  | 'wormhole' | 'countdown' | 'countdownGo' | 'finish' | 'ability'
  | 'pickupEnergy' | 'pickupShield' | 'pickupOverdrive' | 'pickupPhase'
  | 'pickupMagnet' | 'pickupCredit';

export interface EngineState {
  /** 0..1 normalised speed for pitch. */ speed01: number;
  /** 0..1 boost envelope (ramp in/out is done by the caller). */ boost: number;
  /** -1..1 throttle/brake input. */ throttle: number;
  /** 0..1 drift slide amount. */ drifting: number;
  /** 0..1 damage level (adds grit / detune). */ damage: number;
  /** true while the ship engine should run. */ active: boolean;
}

export interface AudioVolumes { master: number; music: number; sfx: number; engine: number }

/** Public surface of {@link AudioEngine}; also implemented by the silent fallback. */
export interface AudioEngineLike {
  readonly ready: boolean;
  /** 0..1 energy of the last collision-layer sfx, for UI meter use. */
  readonly lastCollisionEnergy: number;
  /** Lazily creates AudioContext. Safe to call repeatedly (idempotent). */
  init(): Promise<boolean>;
  /** Call from a user gesture; returns whether audio is now running. */
  unlock(): Promise<boolean>;
  suspend(): void;
  resumeCtx(): void;
  setVolumes(v: AudioVolumes): void;
  setMusicIntensity(v: number): void;
  startMusic(): void;
  stopMusic(): void;
  setDucking(on: boolean): void;
  setWarning(active: boolean): void;
  updateEngine(state: EngineState, dt: number): void;
  playSfx(name: SfxName, opts?: { intensity?: number; detune?: number }): void;
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Tuning tables. Gameplay numbers come from config.ts; these are audio-only
// presentation constants (config.AUDIO has no voice limits / bus gains, so the
// budgets and mix levels live here, in one place).
// ---------------------------------------------------------------------------

import { AUDIO } from '../data/config.ts';

/** Max simultaneous one-shot sfx voices; oldest-ending voice is stolen when full. */
const SFX_VOICE_CAP = 26;
/** Max simultaneous scheduled music-note voices (per tick, notes are ~16th-length). */
const MUSIC_VOICE_CAP = 22;
/** Hard ceiling of notes the scheduler may queue in one look, tab-throttle guard. */
const MAX_STEPS_PER_LOOK = 24;
/** Reverb return level (post-bus, pre-master-compressor). */
const REVERB_RETURN = 0.9;
/** Music bus multiplier while ducked. */
const MUSIC_DUCK = 0.32;
/** Engine pitch sweeps exponentially between these config bounds. */
const ENGINE_RATIO = AUDIO.engineMaxHz / AUDIO.engineBaseHz;
/** Boost whine is tuned against the top engine partial, scaled by engineSpeedRef. */
const WHINE_TRACK = AUDIO.engineMaxHz / AUDIO.engineSpeedRef;
/** One bar = 16 steps at 16th-note resolution. */
const STEPS = 16;
const TICK_SECONDS = AUDIO.lookaheadMs / 1000;

const SFX_COOLDOWN: Record<SfxName, number> = {
  uiHover: 0.05, uiClick: 0.045, uiBack: 0.06, uiOpen: 0.08, uiClose: 0.08,
  boostStart: 0.12, boostEnd: 0.12, perfectBoost: 0.1, warp: 0.25,
  driftStart: 0.12, driftEnd: 0.12, perfectDrift: 0.12,
  hit: 0.07, hitHeavy: 0.1, scrape: 0.05, shieldUp: 0.12, shieldBreak: 0.1,
  gate: 0.05, nearMiss: 0.09, collapseWarn: 0.2, collapseBreak: 0.2, shockwave: 0.2,
  wormhole: 0.3, countdown: 0.08, countdownGo: 0.15, finish: 0.3, ability: 0.1,
  pickupEnergy: 0.05, pickupShield: 0.05, pickupOverdrive: 0.05, pickupPhase: 0.05,
  pickupMagnet: 0.05, pickupCredit: 0.04,
};

const SFX_REVERB: Partial<Record<SfxName, number>> = {
  perfectBoost: 0.35, perfectDrift: 0.3, gate: 0.22, warp: 0.45, wormhole: 0.5,
  finish: 0.4, shieldBreak: 0.3, collapseWarn: 0.2, collapseBreak: 0.55, shockwave: 0.5,
  ability: 0.25, countdown: 0.08, countdownGo: 0.12, uiBack: 0.05, pickupShield: 0.12,
  pickupPhase: 0.2, hitHeavy: 0.18, shieldUp: 0.15, nearMiss: 0.12,
};

const SFX_PAN_JITTER = new Set<SfxName>(['hit', 'hitHeavy', 'scrape', 'nearMiss', 'shockwave']);

/** Collision-layer feedback energy reported to the UI meter, per sfx (× intensity). */
const SFX_COLLISION_ENERGY: Partial<Record<SfxName, number>> = {
  hit: 0.5, hitHeavy: 1, scrape: 0.25, shieldBreak: 0.8, collapseBreak: 1, shockwave: 0.7,
};

/** Big events that briefly duck the music (seconds). */
const SFX_AUTO_DUCK: Partial<Record<SfxName, number>> = {
  hitHeavy: 0.45, collapseBreak: 0.7, shieldBreak: 0.35, shockwave: 0.5, warp: 0.3,
};

// --- music theory tables (presentation-only) --------------------------------
// i–VI–III–VII in A minor. Bass roots, triad voicings, arp extensions.
const BASS_ROOTS: readonly number[] = [55.0, 43.65, 65.41, 49.0];
const CHORDS: readonly (readonly number[])[] = [
  [220.0, 261.63, 329.63],   // Am
  [174.61, 220.0, 261.63],   // F
  [261.63, 329.63, 392.0],   // C
  [196.0, 246.94, 293.66],   // G
];
const ARP_UP: readonly number[] = [0, 1, 2, 1];
const ARP_DOWN: readonly number[] = [0, 1, 2, 1, 0, 2, 1, 0];

const KICK_STEPS = new Set<number>([0, 6, 10]);
const SNARE_STEPS = new Set<number>([4, 12]);
/** -1 rest; else bass scale-degree multiplier: 0 root, 1 octave-up, 2 fifth. */
const BASS_STEPS: readonly number[] = [0, -1, -1, 0, -1, 1, -1, -1, 0, -1, -1, 2, -1, -1, 1, -1];
/** Pad chord extension (seventh) per progression degree, × root. */
const PAD_SEVENTHS: readonly number[] = [1.8, 1.5, 1.5, 1.66];
const FIFTH = 1.5;

// ---------------------------------------------------------------------------
// Voice budget — real pooled limiting, not hopeful counting.
// ---------------------------------------------------------------------------

interface Voice {
  readonly root: GainNode;
  readonly nodes: AudioNode[];
  /** Source expected to end last; its `onended` releases the voice. */
  final: AudioScheduledSourceNode | null;
  lastEnd: number;
  /** Scheduled end time used for watchdog sweep + steal victim selection. */
  endTime: number;
  alive: boolean;
}

class VoiceBudget {
  private readonly live: Voice[] = [];
  // NOTE: explicit field assignment, not constructor parameter properties —
  // Node's strip-only type conversion cannot erase those.
  private readonly ctx: AudioContext;
  readonly cap: number;

  constructor(ctx: AudioContext, cap: number) {
    this.ctx = ctx;
    this.cap = cap;
  }

  /** Returns a fresh voice, steals the soonest-ending one, or null when everything is fresh. */
  create(now: number): Voice | null {
    if (this.live.length >= this.cap) {
      let victim: Voice | null = null;
      for (const v of this.live) if (!victim || v.endTime < victim.endTime) victim = v;
      // Stealing a voice that still has >250ms left audibly truncates it: drop instead.
      if (!victim || victim.endTime > now + 0.25) return null;
      this.release(victim);
    }
    const root = this.ctx.createGain();
    root.gain.value = 1;
    return { root, nodes: [], final: null, lastEnd: 0, endTime: 0, alive: true };
  }

  /** Registers a fully built voice; hooks its release on the final source ending. */
  track(v: Voice): void {
    v.endTime = v.lastEnd + 0.12;
    this.live.push(v);
    const final = v.final;
    if (final) {
      final.onended = () => this.release(v);
    } else {
      this.release(v); // degenerate recipe: nothing was scheduled
    }
  }

  release(v: Voice): void {
    if (!v.alive) return;
    v.alive = false;
    const idx = this.live.indexOf(v);
    if (idx >= 0) this.live.splice(idx, 1);
    for (const n of v.nodes) {
      try { n.disconnect(); } catch { /* already detached */ }
    }
    v.nodes.length = 0;
    try { v.root.disconnect(); } catch { /* already detached */ }
  }

  /** Fallback reclamation for voices whose `onended` was swallowed by a suspend. */
  sweep(now: number): void {
    for (let i = this.live.length - 1; i >= 0; i--) {
      const v = this.live[i];
      if (v.endTime <= now - 0.05) this.release(v);
    }
  }

  releaseAll(): void {
    while (this.live.length > 0) this.release(this.live[this.live.length - 1]);
  }
}

// ---------------------------------------------------------------------------
// Persistent sub-graph rigs (built once per context, automated, never rebuilt).
// ---------------------------------------------------------------------------

interface BusChain { input: GainNode; limiter: DynamicsCompressorNode }

interface EngineRig {
  sum: GainNode;
  tone1: OscillatorNode; tone2: OscillatorNode; sub: OscillatorNode;
  toneFilter: BiquadFilterNode; toneGain: GainNode; subGain: GainNode;
  noiseFilter: BiquadFilterNode; noiseGain: GainNode;
  squealFilter: BiquadFilterNode; squealGain: GainNode;
  whine: OscillatorNode; whineFilter: BiquadFilterNode; whineGain: GainNode;
  noiseSrc: AudioBufferSourceNode;
  cutoffLfo: OscillatorNode; cutoffDepth: GainNode;
  wobbleLfo: OscillatorNode; wobbleDepth: GainNode;
}

interface WarningRig {
  tone1: OscillatorNode; tone2: OscillatorNode; tone3: OscillatorNode;
  filter: BiquadFilterNode; mod: GainNode; level: GainNode;
  lfo: OscillatorNode; depth: GainNode;
}

interface MusicRig {
  sum: GainNode;
  kick: GainNode; snare: GainNode; hat: GainNode;
  bass: GainNode; arp: GainNode; pad: GainNode;
}

// ---------------------------------------------------------------------------
// AudioEngine
// ---------------------------------------------------------------------------

export class AudioEngine implements AudioEngineLike {
  private volumes: AudioVolumes;
  private ctx: AudioContext | null = null;
  private initPromise: Promise<boolean> | null = null;
  private disposed = false;
  private warned = new Set<string>();
  private readonly rng = new Rng('nebula-audio');

  // master / buses
  private masterGain: GainNode | null = null;
  private masterComp: DynamicsCompressorNode | null = null;
  private sfx: BusChain | null = null;
  private musicBus: BusChain | null = null;
  private engineBus: BusChain | null = null;
  private reverbIn: GainNode | null = null;
  private reverbConv: ConvolverNode | null = null;
  private reverbReturn: GainNode | null = null;
  private noise: AudioBuffer | null = null;

  // rigs
  private engine: EngineRig | null = null;
  private warning: WarningRig | null = null;
  private music: MusicRig | null = null;

  // voice budgets
  private sfxVoices: VoiceBudget | null = null;
  private musicVoices: VoiceBudget | null = null;
  private readonly lastSfxAt = new Map<SfxName, number>();

  // music scheduler state
  private tickId: ReturnType<typeof setInterval> | null = null;
  private musicWanted = false;
  private musicOn = false;
  private stalled = false;
  private nextNoteTime = 0;
  private step = 0;
  private bar = 0;
  private bpm: number = AUDIO.musicBpm;
  private bpmTarget: number = AUDIO.musicBpm;
  private intensity = 0;
  private ducking = false;
  private autoDuckUntil = 0;
  /** Last duck state actually written to the music bus (tick applies transitions). */
  private duckApplied = false;

  // engine automation caches (per-param delta guards; filled lazily in updateEngine)
  private engCache: Record<string, number> = {};

  private collisionEnergy = 0;

  constructor(volumes: AudioVolumes) {
    this.volumes = {
      master: clamp01(volumes.master),
      music: clamp01(volumes.music),
      sfx: clamp01(volumes.sfx),
      engine: clamp01(volumes.engine),
    };
  }

  /** True once the context exists and is actually running. */
  get ready(): boolean {
    return this.ctx !== null && this.ctx.state === 'running';
  }

  get lastCollisionEnergy(): number {
    return this.collisionEnergy;
  }

  // -------------------------------------------------------------- lifecycle

  init(): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false);
    // Context already built: report construction success, not the running state
    // (a suspended context is fixed up by unlock()/resumeCtx(), not by re-init).
    if (this.ctx) return Promise.resolve(true);
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.build();
    return this.initPromise;
  }

  unlock(): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false);
    return this.init().then((ok) => {
      if (!ok || !this.ctx) return false;
      if (this.ctx.state === 'running') return true;
      return this.ctx.resume()
        .then(() => this.ctx !== null && this.ctx.state === 'running')
        .catch(() => false);
    });
  }

  suspend(): void {
    this.safeRun('suspend', () => {
      this.ctx?.suspend().catch(() => { /* autoplay policy may reject; silence is fine */ });
    });
  }

  resumeCtx(): void {
    this.safeRun('resume', () => {
      this.ctx?.resume().then(() => this.onResumed()).catch(() => { /* stays silent */ });
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const ctx = this.ctx;
    if (this.tickId !== null) { clearInterval(this.tickId); this.tickId = null; }
    this.sfxVoices?.releaseAll();
    this.musicVoices?.releaseAll();
    this.sfxVoices = null;
    this.musicVoices = null;
    this.musicOn = false;
    this.musicWanted = false;
    if (!ctx) return;
    // direct try/catch: safeRun would short-circuit on the disposed flag set above
    try {
      this.stopOscillators();
      for (const n of this.allBuses()) {
        try { n.disconnect(); } catch { /* already detached */ }
      }
      ctx.close().catch(() => { /* already closed */ });
    } catch (e) {
      this.warnOnce('dispose', e);
    }
    this.engine = null;
    this.warning = null;
    this.music = null;
    this.masterGain = null;
    this.masterComp = null;
    this.sfx = null;
    this.musicBus = null;
    this.engineBus = null;
    this.reverbIn = null;
    this.reverbConv = null;
    this.reverbReturn = null;
    this.noise = null;
    this.engCache = {};
    this.ctx = null;
    this.initPromise = null;
  }

  // ------------------------------------------------------------------ mix

  setVolumes(v: AudioVolumes): void {
    this.volumes = {
      master: clamp01(v.master),
      music: clamp01(v.music),
      sfx: clamp01(v.sfx),
      engine: clamp01(v.engine),
    };
    this.safeRun('volumes', () => this.applyVolumes(0.03));
  }

  setDucking(on: boolean): void {
    this.ducking = on;
    this.safeRun('duck', () => this.applyVolumes(0.04));
  }

  setWarning(active: boolean): void {
    this.safeRun('warning', () => {
      const w = this.warning;
      if (!w || !this.ctx) return;
      const now = this.ctx.currentTime;
      w.level.gain.setTargetAtTime(active ? 0.14 : 0, now, active ? 0.08 : 0.3);
    });
  }

  // --------------------------------------------------------------- engine

  /**
   * Continuous automation only (`setTargetAtTime`), with per-parameter delta
   * guards; no node creation, no per-frame `setValueAtTime` spam.
   */
  updateEngine(state: EngineState, dt: number): void {
    const ctx = this.ctx;
    const rig = this.engine;
    if (!ctx || !rig || this.disposed) return;
    try {
      const now = ctx.currentTime;
      const tc = Math.max(dt, 0.012);
      const s = clamp01(state.speed01);
      const b = clamp01(state.boost);
      const dr = clamp01(state.drifting);
      const dmg = clamp01(state.damage);
      const thr = Math.max(-1, Math.min(1, state.throttle));

      if (!state.active) {
        this.auto('level', rig.toneGain.gain, 0, now, 0.35, 0.002);
        this.auto('sub', rig.subGain.gain, 0, now, 0.3, 0.002);
        this.auto('whine0', rig.whineGain.gain, 0, now, 0.25, 0.002);
        this.auto('squeal0', rig.squealGain.gain, 0, now, 0.25, 0.002);
        this.auto('noise0', rig.noiseGain.gain, 0, now, 0.25, 0.002);
        return;
      }

      const freq = AUDIO.engineBaseHz * Math.pow(ENGINE_RATIO, s);
      this.auto('f1', rig.tone1.frequency, freq, now, tc, 0.4);
      this.auto('f2', rig.tone2.frequency, freq * 1.004, now, tc, 0.4);
      this.auto('fs', rig.sub.frequency, freq * 0.5, now, tc, 0.2);
      this.auto('fw', rig.whine.frequency, 200 + 430 * (s + b * 1.6) * WHINE_TRACK + s * s * 900, now, tc * 1.5, 0.5);

      const cutoff = lerp(380, 5400, Math.pow(s, 1.25)) * (1 + 0.28 * Math.max(0, thr));
      this.auto('cut', rig.toneFilter.frequency, cutoff, now, tc, 0.5);
      this.auto('nfcut', rig.noiseFilter.frequency, lerp(650, 2600, s), now, tc, 0.5);
      this.auto('squealHz', rig.squealFilter.frequency, lerp(2150, 3350, s), now, tc * 2, 0.5);

      this.auto('level', rig.toneGain.gain, 0.15 + 0.10 * s + 0.08 * b + 0.04 * Math.max(0, thr), now, tc, 0.002);
      this.auto('sub', rig.subGain.gain, 0.12 + 0.10 * (1 - s) + 0.05 * Math.max(0, thr), now, tc, 0.002);
      this.auto('noise0', rig.noiseGain.gain, 0.045 + 0.14 * s + 0.10 * dmg, now, tc, 0.002);
      this.auto('squeal0', rig.squealGain.gain, dr * (0.10 + 0.05 * b), now, tc, 0.002);
      this.auto('whine0', rig.whineGain.gain, b * (0.045 + 0.07 * s), now, tc, 0.002);

      this.auto('detune', rig.tone2.detune, 14 + dmg * 85, now, tc * 2, 0.5);
      this.auto('wd', rig.wobbleDepth.gain, 6 + dmg * 55, now, 0.2, 0.2);
      this.auto('cd', rig.cutoffDepth.gain, 70 + dmg * 480, now, 0.2, 1);
      this.auto('rate', rig.noiseSrc.playbackRate, 0.85 + 0.5 * s, now, tc, 0.005);
    } catch (e) {
      this.warnOnce('engine', e);
    }
  }

  // ---------------------------------------------------------------- music

  setMusicIntensity(v: number): void {
    this.intensity = clamp01(v);
    this.bpmTarget = lerp(AUDIO.musicBpm, AUDIO.musicBpmHigh, this.intensity);
    this.safeRun('music-intensity', () => this.applyLayerMix(0.45));
  }

  startMusic(): void {
    this.musicWanted = true;
    this.safeRun('music-start', () => {
      if (!this.ctx || !this.music) return;
      this.beginMusicScheduling();
    });
  }

  stopMusic(): void {
    this.musicWanted = false;
    this.safeRun('music-stop', () => {
      if (!this.ctx || !this.music) return;
      this.musicOn = false;
      const now = this.ctx.currentTime;
      this.music.sum.gain.setTargetAtTime(0, now, 0.3);
    });
  }

  // ------------------------------------------------------------------ sfx

  playSfx(name: SfxName, opts?: { intensity?: number; detune?: number }): void {
    const ctx = this.ctx;
    if (!ctx || this.disposed || !this.sfx || ctx.state !== 'running') return;
    try {
      const now = ctx.currentTime;
      const last = this.lastSfxAt.get(name) ?? -10;
      if (now - last < SFX_COOLDOWN[name]) return;
      this.lastSfxAt.set(name, now);

      const i = clamp01(opts?.intensity ?? 1);
      if (i <= 0.01) return;
      const cents = opts?.detune ?? 0;

      const duck = SFX_AUTO_DUCK[name];
      if (duck !== undefined) this.autoDuckUntil = Math.max(this.autoDuckUntil, now + duck);
      const energy = SFX_COLLISION_ENERGY[name];
      if (energy !== undefined) this.collisionEnergy = clamp01(energy * (0.4 + 0.6 * i));

      const budget = this.sfxVoices;
      if (!budget) return;
      const v = budget.create(now);
      if (!v) return; // budget exhausted with all voices fresh: silently drop

      const pan = SFX_PAN_JITTER.has(name) ? this.rng.spread(0.5) : 0;
      this.voiceRoute(v, this.sfx.input, pan, SFX_REVERB[name] ?? 0);
      this.synthSfx(v, name, now + 0.001, i, cents);
      budget.track(v);
    } catch (e) {
      this.warnOnce('sfx', e);
    }
  }

  // -------------------------------------------------------- graph builders

  private async build(): Promise<boolean> {
    try {
      const g = globalThis as unknown as Record<string, unknown>;
      const Ctor = (g.AudioContext ?? g.webkitAudioContext) as
        (new (options?: { latencyHint?: string }) => AudioContext) | undefined;
      if (typeof Ctor !== 'function') {
        this.warnOnce('unsupported', 'Web Audio unavailable — running silent');
        this.initPromise = null;
        return false;
      }
      const ctx = new Ctor({ latencyHint: 'interactive' });
      this.ctx = ctx;

      // --- master chain: buses (each with limiter) → master gain → limiter compressor
      this.masterComp = ctx.createDynamicsCompressor();
      this.masterComp.threshold.value = AUDIO.masterCeiling; // DynamicsCompressor takes dB
      this.masterComp.knee.value = 4;
      this.masterComp.ratio.value = 12;
      this.masterComp.attack.value = 0.003;
      this.masterComp.release.value = 0.16;
      this.masterGain = ctx.createGain();
      this.masterGain.connect(this.masterComp);
      this.masterComp.connect(ctx.destination);

      this.sfx = this.makeBus();
      this.musicBus = this.makeBus();
      this.engineBus = this.makeBus();

      // --- procedural impulse response on a send bus
      this.reverbIn = ctx.createGain();
      const conv = ctx.createConvolver();
      conv.normalize = true;
      conv.buffer = this.makeImpulseResponse(ctx);
      const returnGain = ctx.createGain();
      returnGain.gain.value = REVERB_RETURN;
      this.reverbIn.connect(conv);
      conv.connect(returnGain);
      returnGain.connect(this.masterGain);
      this.reverbConv = conv;
      this.reverbReturn = returnGain;

      // --- shared noise
      this.noise = this.makeNoiseBuffer(ctx);

      // --- budgets
      this.sfxVoices = new VoiceBudget(ctx, SFX_VOICE_CAP);
      this.musicVoices = new VoiceBudget(ctx, MUSIC_VOICE_CAP);

      this.buildEngineRig(ctx);
      this.buildWarningRig(ctx);
      this.buildMusicRig(ctx);

      this.applyVolumes(0.001);
      this.applyLayerMix(0.001);

      if (this.musicWanted) this.beginMusicScheduling();

      // Context may start suspended (autoplay policy); unlock()/resumeCtx() fixes it.
      if (ctx.state !== 'running') ctx.resume().catch(() => { /* await gesture */ });
      return true;
    } catch (e) {
      this.warnOnce('build', e);
      this.initPromise = null;
      try { this.ctx?.close().catch(() => { /* ignore */ }); } catch { /* ignore */ }
      this.ctx = null;
      return false;
    }
  }

  private makeBus(): BusChain {
    const ctx = this.ctx as AudioContext;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -8;
    limiter.knee.value = 2;
    limiter.ratio.value = 14;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.1;
    const input = ctx.createGain();
    input.connect(limiter);
    limiter.connect(this.masterGain as GainNode);
    return { input, limiter };
  }

  private buildEngineRig(ctx: AudioContext): void {
    const sum = ctx.createGain();
    sum.gain.value = 0.85;
    sum.connect(this.engineBus!.input);

    const toneFilter = ctx.createBiquadFilter();
    toneFilter.type = 'lowpass';
    toneFilter.frequency.value = 500;
    toneFilter.Q.value = 0.8;
    const toneGain = ctx.createGain();
    toneGain.gain.value = 0;
    toneFilter.connect(toneGain);
    toneGain.connect(sum);

    const tone1 = ctx.createOscillator();
    tone1.type = 'sawtooth';
    tone1.frequency.value = AUDIO.engineBaseHz;
    const tone2 = ctx.createOscillator();
    tone2.type = 'sawtooth';
    tone2.frequency.value = AUDIO.engineBaseHz * 1.004;
    tone1.connect(toneFilter);
    tone2.connect(toneFilter);

    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.value = AUDIO.engineBaseHz * 0.5;
    const subGain = ctx.createGain();
    subGain.gain.value = 0;
    sub.connect(subGain);
    subGain.connect(sum);

    const noiseSrc = ctx.createBufferSource();
    noiseSrc.buffer = this.noise!;
    noiseSrc.loop = true;
    const noiseFilter = ctx.createBiquadFilter();
    noiseFilter.type = 'lowpass';
    noiseFilter.frequency.value = 900;
    noiseFilter.Q.value = 0.7;
    const noiseGain = ctx.createGain();
    noiseGain.gain.value = 0;
    noiseSrc.connect(noiseFilter);
    noiseFilter.connect(noiseGain);
    noiseGain.connect(sum);

    const squealFilter = ctx.createBiquadFilter();
    squealFilter.type = 'bandpass';
    squealFilter.frequency.value = 2400;
    squealFilter.Q.value = 7;
    const squealGain = ctx.createGain();
    squealGain.gain.value = 0;
    noiseSrc.connect(squealFilter);
    squealFilter.connect(squealGain);
    squealGain.connect(sum);

    const whine = ctx.createOscillator();
    whine.type = 'sawtooth';
    whine.frequency.value = 500;
    const whineFilter = ctx.createBiquadFilter();
    whineFilter.type = 'lowpass';
    whineFilter.frequency.value = 2600;
    whineFilter.Q.value = 2;
    const whineGain = ctx.createGain();
    whineGain.gain.value = 0;
    whine.connect(whineFilter);
    whineFilter.connect(whineGain);
    whineGain.connect(sum);

    // slow filter wobble + damage tremolo, as param modulation
    const cutoffLfo = ctx.createOscillator();
    cutoffLfo.type = 'triangle';
    cutoffLfo.frequency.value = 6.3;
    const cutoffDepth = ctx.createGain();
    cutoffDepth.gain.value = 70;
    cutoffLfo.connect(cutoffDepth);
    cutoffDepth.connect(toneFilter.frequency);

    const wobbleLfo = ctx.createOscillator();
    wobbleLfo.type = 'sine';
    wobbleLfo.frequency.value = 9.1;
    const wobbleDepth = ctx.createGain();
    wobbleDepth.gain.value = 6;
    wobbleLfo.connect(wobbleDepth);
    wobbleDepth.connect(tone2.detune);

    tone1.start(); tone2.start(); sub.start(); whine.start(); noiseSrc.start();
    cutoffLfo.start(); wobbleLfo.start();

    this.engine = {
      sum, tone1, tone2, sub, toneFilter, toneGain, subGain,
      noiseFilter, noiseGain, squealFilter, squealGain,
      whine, whineFilter, whineGain, noiseSrc,
      cutoffLfo, cutoffDepth, wobbleLfo, wobbleDepth,
    };
  }

  private buildWarningRig(ctx: AudioContext): void {
    // Looping klaxon-ish danger tone, routed through the engine bus.
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 340;
    filter.Q.value = 2.2;
    const mod = ctx.createGain();
    mod.gain.value = 0.55;
    const level = ctx.createGain();
    level.gain.value = 0;
    filter.connect(mod);
    mod.connect(level);
    level.connect(this.engineBus!.input);

    const tone1 = ctx.createOscillator();
    tone1.type = 'sawtooth';
    tone1.frequency.value = 76;
    const tone2 = ctx.createOscillator();
    tone2.type = 'sawtooth';
    tone2.frequency.value = 80.5;
    const tone3 = ctx.createOscillator();
    tone3.type = 'square';
    tone3.frequency.value = 152;
    tone1.connect(filter);
    tone2.connect(filter);
    const t3g = ctx.createGain();
    t3g.gain.value = 0.25;
    tone3.connect(t3g);
    t3g.connect(filter);

    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 3.1;
    const depth = ctx.createGain();
    depth.gain.value = 0.4;
    lfo.connect(depth);
    depth.connect(mod.gain);

    tone1.start(); tone2.start(); tone3.start(); lfo.start();
    this.warning = { tone1, tone2, tone3, filter, mod, level, lfo, depth };
  }

  private buildMusicRig(ctx: AudioContext): void {
    const sum = ctx.createGain();
    sum.gain.value = 0;
    sum.connect(this.musicBus!.input);
    const layer = (): GainNode => {
      const g = ctx.createGain();
      g.gain.value = 0;
      g.connect(sum);
      return g;
    };
    this.music = {
      sum,
      kick: layer(), snare: layer(), hat: layer(),
      bass: layer(), arp: layer(), pad: layer(),
    };
  }

  private makeNoiseBuffer(ctx: AudioContext): AudioBuffer {
    const len = Math.floor(ctx.sampleRate * 2);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = this.rng.float() * 2 - 1;
    }
    return buf;
  }

  /** Exponentially decaying stereo noise IR with a handful of early reflections. */
  private makeImpulseResponse(ctx: AudioContext): AudioBuffer {
    const len = Math.max(1024, Math.floor(ctx.sampleRate * 1.7));
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const x = i / len;
        d[i] = (this.rng.float() * 2 - 1) * Math.pow(1 - x, 2.8);
      }
      let head = (0.011 + ch * 0.004) * ctx.sampleRate;
      for (let r = 0; r < 5 && head < len; r++) {
        d[head] = (this.rng.float() * 2 - 1) * 0.6 * Math.pow(0.55, r);
        head += (0.017 + r * 0.009) * ctx.sampleRate;
      }
    }
    return buf;
  }

  // ------------------------------------------------------------- mixing

  private applyVolumes(tc: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.masterGain || !this.sfx || !this.musicBus || !this.engineBus) return;
    const now = ctx.currentTime;
    const ducked = this.ducking || now < this.autoDuckUntil;
    this.duckApplied = ducked;
    this.masterGain.gain.setTargetAtTime(this.volumes.master, now, tc);
    this.sfx.input.gain.setTargetAtTime(this.volumes.sfx, now, tc);
    this.engineBus.input.gain.setTargetAtTime(this.volumes.engine, now, tc);
    this.musicBus.input.gain.setTargetAtTime(this.volumes.music * (ducked ? MUSIC_DUCK : 1), now, tc);
  }

  private applyLayerMix(tc: number): void {
    const m = this.music;
    const ctx = this.ctx;
    if (!m || !ctx) return;
    const now = ctx.currentTime;
    const i = this.intensity;
    const set = (g: GainNode, v: number): void => { g.gain.setTargetAtTime(v, now, tc); };
    set(m.kick, 0.92 * smoothstep(0.03, 0.2, i));
    set(m.snare, 0.55 * smoothstep(0.2, 0.36, i));
    set(m.hat, 0.34 * smoothstep(0.36, 0.55, i));
    set(m.bass, 0.5 * smoothstep(0.18, 0.42, i));
    set(m.arp, 0.4 * smoothstep(0.46, 0.72, i));
    set(m.pad, 0.26 * smoothstep(0.1, 0.65, i));
  }

  // ------------------------------------------------------- music scheduler
  // 25 ms-tick lookahead over ctx.currentTime. Never setInterval note timing:
  // notes are scheduled ahead on the audio clock, and missed windows resync
  // without flooding when the tab was backgrounded or the context suspended.

  private beginMusicScheduling(): void {
    if (this.musicOn || !this.ctx || !this.music) return;
    const ctx = this.ctx;
    if (ctx.state === 'closed') return;
    this.musicOn = true;
    this.stalled = ctx.state !== 'running';
    this.nextNoteTime = ctx.currentTime + 0.08;
    this.step = 0;
    this.bar = 0;
    this.bpm = this.bpmTarget;
    this.music.sum.gain.setTargetAtTime(1, ctx.currentTime, 0.25);
    if (this.tickId === null) {
      this.tickId = setInterval(() => this.tick(), AUDIO.lookaheadMs);
    }
  }

  private onResumed(): void {
    if (this.musicOn) this.stalled = true;
  }

  private tick(): void {
    const ctx = this.ctx;
    if (!ctx || this.disposed) return;
    try {
      const now = ctx.currentTime;
      this.sfxVoices?.sweep(now);
      this.musicVoices?.sweep(now);

      // auto-duck expiry is detected here (audio-clock accurate, survives throttled tabs)
      const wantDuck = this.ducking || now < this.autoDuckUntil;
      if (this.autoDuckUntil > 0 && now >= this.autoDuckUntil) this.autoDuckUntil = 0;
      if (wantDuck !== this.duckApplied) this.applyVolumes(0.05);

      if (!this.musicOn || !this.music) return;
      if (ctx.state !== 'running') { this.stalled = true; return; }
      if (this.stalled) {
        // resync after suspend/background: skip the backlog, never flood
        this.stalled = false;
        this.nextNoteTime = now + 0.05;
      }
      if (now - this.nextNoteTime > 0.4) this.nextNoteTime = now + 0.02;

      // tempo glides once per look, not per queued step
      this.bpm = damp(this.bpm, this.bpmTarget, 1.2, TICK_SECONDS);
      const stepDur = 60 / this.bpm / 4;
      let guard = 0;
      while (this.nextNoteTime < now + AUDIO.scheduleAheadSec && guard++ < MAX_STEPS_PER_LOOK) {
        this.scheduleStep(this.step, this.bar, this.nextNoteTime, stepDur);
        this.step = (this.step + 1) % STEPS;
        if (this.step === 0) this.bar = (this.bar + 1) % 4;
        this.nextNoteTime += stepDur;
      }
    } catch (e) {
      this.warnOnce('music-tick', e);
    }
  }

  private scheduleStep(step: number, bar: number, t: number, stepDur: number): void {
    const i = this.intensity;
    if (step === 0 && i > 0.06) {
      // pad chord once per bar, with a one-bar long envelope
      const rig = this.music;
      const budget = this.musicVoices;
      if (rig && budget) {
        const pad = budget.create(t);
        if (pad) {
          this.voiceRoute(pad, rig.pad, 0, 0.4);
          this.schedulePad(pad, t, bar, stepDur * STEPS, i);
          budget.track(pad);
        }
      }
    }

    if (KICK_STEPS.has(step)) this.scheduleKick(t, i);
    if (SNARE_STEPS.has(step) && i > 0.22) this.scheduleSnare(t, 0.5 + 0.5 * i);
    if (step % 2 === 1 && i > 0.38) this.scheduleHat(t, step === 15 ? 0.16 : 0.1, false);
    if (step === 14 && i > 0.78) this.scheduleHat(t, 0.12, true);
    if (i > 0.3) {
      const deg = BASS_STEPS[step];
      if (deg >= 0) this.scheduleBass(t, BASS_ROOTS[bar] * (deg === 1 ? 2 : deg === 2 ? FIFTH : 1), stepDur, i);
    }
    if (i > 0.5 && (step % 2 === 0 || i > 0.82)) {
      const seq = bar % 2 === 0 ? ARP_UP : ARP_DOWN;
      const note = CHORDS[bar][seq[(step + (bar << 1)) % seq.length]];
      this.scheduleArp(t, note * ((step >> 3) % 2 === 0 ? 2 : 4), 0.22 + 0.2 * i);
    }
  }

  // ------------------------------------------------------- one-shot synth

  private synthSfx(v: Voice, name: SfxName, t: number, i: number, cents: number): void {
    switch (name) {
      case 'uiHover': {
        this.tone(v, 'sine', 880, 1180, t, 0.055, 0.10 * i, 0.004, cents);
        return;
      }
      case 'uiClick': {
        this.tone(v, 'square', 720, 540, t, 0.05, 0.08 * i, 0.003, cents);
        this.noiseBurst(v, t, 0.04, 900, 7200, 0.8, 0.12 * i, 0);
        return;
      }
      case 'uiBack': {
        this.tone(v, 'sine', 620, 330, t, 0.12, 0.11 * i, 0.005, cents);
        return;
      }
      case 'uiOpen': {
        this.tone(v, 'sine', 320, 700, t, 0.18, 0.07 * i, 0.01, cents);
        this.noiseBurst(v, t, 0.22, 400, 5200, 1.2, 0.1 * i, 0);
        return;
      }
      case 'uiClose': {
        this.tone(v, 'sine', 700, 260, t, 0.2, 0.07 * i, 0.01, cents);
        this.noiseBurst(v, t, 0.22, 5200, 400, 1.2, 0.1 * i, 0);
        return;
      }
      case 'boostStart': {
        this.tone(v, 'sawtooth', 110, 880, t, 0.32, 0.16 * i, 0.02, cents, 'lowpass', 1600);
        this.noiseBurst(v, t, 0.36, 240, 6200, 1.4, 0.16 * i, 0);
        return;
      }
      case 'boostEnd': {
        this.tone(v, 'sawtooth', 720, 150, t, 0.26, 0.14 * i, 0.015, cents, 'lowpass', 1500);
        this.noiseBurst(v, t, 0.3, 6000, 300, 1.3, 0.12 * i, 0);
        return;
      }
      case 'perfectBoost': {
        const g = 0.1 * i;
        this.tone(v, 'triangle', 523.25, 0, t, 0.3, g, 0.006, cents);
        this.tone(v, 'triangle', 659.25, 0, t + 0.05, 0.3, g, 0.006, cents);
        this.tone(v, 'sine', 1046.5, 0, t + 0.1, 0.42, 0.13 * i, 0.006, cents);
        this.noiseBurst(v, t + 0.02, 0.2, 3000, 9000, 1, 0.05 * i, 0);
        return;
      }
      case 'warp': {
        this.tone(v, 'sawtooth', 70, 1500, t, 0.5, 0.17 * i, 0.05, cents, 'lowpass', 3800);
        this.tone(v, 'sawtooth', 74, 1460, t + 0.02, 0.48, 0.12 * i, 0.05, cents, 'lowpass', 3400);
        this.noiseBurst(v, t, 0.55, 150, 8000, 1.6, 0.16 * i, 0);
        this.tone(v, 'sine', 40, 30, t, 0.5, 0.2 * i, 0.03, cents);
        return;
      }
      case 'driftStart': {
        this.noiseBurst(v, t, 0.3, 900, 2600, 4.5, 0.14 * i, 0);
        this.tone(v, 'triangle', 300, 460, t, 0.25, 0.05 * i, 0.02, cents);
        return;
      }
      case 'driftEnd': {
        this.noiseBurst(v, t, 0.24, 2600, 500, 4, 0.12 * i, 0);
        this.tone(v, 'triangle', 420, 220, t, 0.2, 0.05 * i, 0.02, cents);
        return;
      }
      case 'perfectDrift': {
        this.tone(v, 'sine', 1318.5, 0, t, 0.22, 0.11 * i, 0.005, cents);
        this.tone(v, 'sine', 1975.5, 0, t + 0.07, 0.26, 0.1 * i, 0.005, cents);
        this.noiseBurst(v, t, 0.18, 4200, 11000, 1, 0.06 * i, 0);
        return;
      }
      case 'hit': {
        this.tone(v, 'sine', 160, 46, t, 0.17, 0.4 * i, 0.002, cents);
        this.noiseBurst(v, t, 0.12, 220, 1800, 1.1, 0.26 * i, 0);
        return;
      }
      case 'hitHeavy': {
        this.tone(v, 'sine', 120, 30, t, 0.42, 0.55 * i, 0.003, cents);
        this.tone(v, 'square', 70, 34, t, 0.2, 0.12 * i, 0.002, cents, 'lowpass', 500);
        this.noiseBurst(v, t, 0.32, 120, 2600, 1.2, 0.32 * i, 0);
        return;
      }
      case 'scrape': {
        this.noiseBurst(v, t, 0.22, 1600, 3400, 9, 0.2 * i, 0);
        this.tone(v, 'sawtooth', 1900, 2500, t, 0.2, 0.05 * i, 0.01, cents, 'bandpass', 2200);
        return;
      }
      case 'shieldUp': {
        this.tone(v, 'sine', 520, 1040, t, 0.26, 0.1 * i, 0.012, cents);
        this.tone(v, 'sine', 780, 1560, t, 0.22, 0.06 * i, 0.012, cents);
        this.noiseBurst(v, t, 0.24, 800, 6800, 1.4, 0.06 * i, 0);
        return;
      }
      case 'shieldBreak': {
        this.tone(v, 'sine', 900, 160, t, 0.3, 0.24 * i, 0.003, cents);
        this.noiseBurst(v, t, 0.36, 400, 9000, 1.2, 0.3 * i, 0);
        this.tone(v, 'square', 240, 80, t, 0.16, 0.1 * i, 0.003, cents, 'lowpass', 900);
        return;
      }
      case 'gate': {
        const boost = i > 0.6;
        this.tone(v, 'square', 880, 0, t, 0.06, 0.08 * i, 0.003, cents, 'lowpass', 3000);
        this.tone(v, 'sine', boost ? 1318.5 : 1046.5, 0, t + 0.05, 0.1, 0.12 * i, 0.004, cents);
        if (boost) this.tone(v, 'sine', 1760, 0, t + 0.1, 0.12, 0.09 * i, 0.004, cents);
        return;
      }
      case 'nearMiss': {
        this.noiseBurst(v, t, 0.2, 600, 4800, 2.2, 0.16 * i, 1);
        return;
      }
      case 'collapseWarn': {
        const pulse = (pt: number): void => {
          this.tone(v, 'sawtooth', 150, 138, pt, 0.16, 0.15 * i, 0.008, cents, 'lowpass', 700);
        };
        pulse(t); pulse(t + 0.24); pulse(t + 0.48);
        return;
      }
      case 'collapseBreak': {
        this.noiseBurst(v, t, 0.5, 90, 1800, 0.8, 0.24 * i, 0);
        this.tone(v, 'sine', 180, 26, t, 0.9, 0.55 * i, 0.004, cents);
        this.tone(v, 'sawtooth', 90, 40, t, 0.6, 0.12 * i, 0.004, cents, 'lowpass', 320);
        this.noiseBurst(v, t + 0.02, 0.8, 1200, 120, 1.2, 0.16 * i, 0);
        return;
      }
      case 'shockwave': {
        this.tone(v, 'sine', 90, 24, t, 0.7, 0.45 * i, 0.03, cents);
        this.noiseBurst(v, t, 0.75, 140, 5200, 1.5, 0.24 * i, 0);
        this.tone(v, 'triangle', 300, 100, t, 0.5, 0.1 * i, 0.02, cents, 'lowpass', 900);
        return;
      }
      case 'wormhole': {
        this.noiseBurst(v, t, 0.85, 300, 1400, 3, 0.2 * i, 0);
        this.tone(v, 'sine', 62, 58, t, 0.85, 0.28 * i, 0.06, cents);
        this.tone(v, 'triangle', 232, 246, t, 0.8, 0.07 * i, 0.06, cents, 'bandpass', 1200);
        return;
      }
      case 'countdown': {
        this.tone(v, 'sine', 660, 0, t, 0.14, 0.22 * i, 0.006, cents);
        this.tone(v, 'square', 660, 0, t, 0.1, 0.03 * i, 0.006, cents, 'lowpass', 2400);
        return;
      }
      case 'countdownGo': {
        this.tone(v, 'sine', 990, 0, t, 0.34, 0.24 * i, 0.006, cents);
        this.tone(v, 'sine', 1485, 0, t + 0.01, 0.32, 0.1 * i, 0.006, cents);
        this.noiseBurst(v, t, 0.2, 2000, 9000, 1, 0.08 * i, 0);
        return;
      }
      case 'finish': {
        const notes: readonly number[] = [523.25, 659.25, 783.99, 1046.5];
        for (let n = 0; n < notes.length; n++) {
          this.tone(v, 'triangle', notes[n], 0, t + n * 0.09, 0.34, 0.13 * i, 0.006, cents);
        }
        this.tone(v, 'sine', 1568, 0, t + 0.36, 0.55, 0.09 * i, 0.01, cents);
        return;
      }
      case 'ability': {
        this.tone(v, 'sawtooth', 200, 1500, t, 0.2, 0.14 * i, 0.006, cents, 'lowpass', 4200);
        this.tone(v, 'square', 100, 52, t + 0.16, 0.26, 0.22 * i, 0.005, cents, 'lowpass', 700);
        this.noiseBurst(v, t + 0.16, 0.16, 800, 4000, 1.4, 0.12 * i, 0);
        return;
      }
      case 'pickupEnergy': {
        this.tone(v, 'square', 520, 1040, t, 0.12, 0.09 * i, 0.004, cents, 'lowpass', 3600);
        return;
      }
      case 'pickupShield': {
        this.tone(v, 'sine', 700, 1400, t, 0.2, 0.12 * i, 0.008, cents);
        this.tone(v, 'sine', 1050, 0, t + 0.06, 0.16, 0.06 * i, 0.008, cents);
        return;
      }
      case 'pickupOverdrive': {
        this.tone(v, 'sawtooth', 150, 620, t, 0.24, 0.13 * i, 0.012, cents, 'lowpass', 2200);
        this.tone(v, 'square', 75, 310, t, 0.2, 0.06 * i, 0.012, cents, 'lowpass', 800);
        return;
      }
      case 'pickupPhase': {
        this.tone(v, 'sine', 830, 0, t, 0.32, 0.1 * i, 0.02, cents);
        this.tone(v, 'sine', 838, 0, t, 0.32, 0.08 * i, 0.02, cents + 7);
        this.noiseBurst(v, t, 0.3, 1800, 5600, 2, 0.04 * i, 0);
        return;
      }
      case 'pickupMagnet': {
        this.noiseBurst(v, t, 0.03, 400, 2000, 2, 0.16 * i, 0);
        this.tone(v, 'square', 320, 0, t, 0.16, 0.1 * i, 0.004, cents, 'bandpass', 340);
        return;
      }
      case 'pickupCredit': {
        this.tone(v, 'square', 988, 0, t, 0.07, 0.08 * i, 0.003, cents, 'lowpass', 4200);
        this.tone(v, 'square', 1319, 0, t + 0.07, 0.12, 0.09 * i, 0.003, cents, 'lowpass', 4200);
        return;
      }
    }
  }

  /**
   * Route a voice's root gain into its destination bus (optionally panned) and
   * the reverb send. Nodes are recorded on the voice so release disconnects all.
   */
  private voiceRoute(v: Voice, dest: AudioNode, pan: number, send: number): void {
    const ctx = this.ctx as AudioContext;
    if (pan !== 0) {
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      v.root.connect(p);
      p.connect(dest);
      v.nodes.push(p);
    } else {
      v.root.connect(dest);
    }
    if (send > 0) {
      const s = ctx.createGain();
      s.gain.value = send;
      v.root.connect(s);
      s.connect(this.reverbIn!);
      v.nodes.push(s);
    }
  }

  /**
   * Single enveloped oscillator voice: osc → (optional filter) → gain → v.root.
   * `to === 0` means a steady pitch. All envelopes are non-clicking ramps.
   */
  private tone(
    v: Voice, type: OscillatorType, from: number, to: number,
    t0: number, dur: number, peak: number, attack: number, cents: number,
    filterType?: BiquadFilterType, filterHz?: number,
  ): void {
    const ctx = this.ctx as AudioContext;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(from, t0);
    if (to > 0 && to !== from) osc.frequency.exponentialRampToValueAtTime(Math.max(to, 0.01), t0 + dur);
    if (cents !== 0) osc.detune.setValueAtTime(cents, t0);
    let node: AudioNode = osc;
    if (filterType !== undefined && filterHz !== undefined) {
      const f = ctx.createBiquadFilter();
      f.type = filterType;
      f.frequency.setValueAtTime(filterHz, t0);
      f.Q.value = 1;
      osc.connect(f);
      v.nodes.push(f);
      node = f;
    }
    const g = ctx.createGain();
    this.envelope(g.gain, t0, peak, attack, Math.max(dur - attack, 0.01));
    node.connect(g);
    g.connect(v.root);
    v.nodes.push(osc, g);
    osc.start(t0);
    osc.stop(t0 + dur + 0.06);
    this.mark(v, osc, t0 + dur + 0.02);
  }

  /**
   * Filtered noise burst off the shared noise buffer. `doppler` > 0 makes the
   * cutoff pass high→low (something screaming by); otherwise fromHz→toHz sweeps.
   */
  private noiseBurst(
    v: Voice, t0: number, dur: number, fromHz: number, toHz: number,
    q: number, peak: number, doppler: number,
  ): void {
    const ctx = this.ctx as AudioContext;
    const src = ctx.createBufferSource();
    src.buffer = this.noise!;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = q;
    const startHz = doppler > 0 ? toHz : fromHz;
    const endHz = doppler > 0 ? fromHz : toHz;
    filter.frequency.setValueAtTime(startHz, t0);
    if (endHz !== startHz) {
      filter.frequency.exponentialRampToValueAtTime(Math.max(endHz, 1), t0 + dur);
    }
    const g = ctx.createGain();
    this.envelope(g.gain, t0, peak, Math.min(0.008, dur * 0.2), dur);
    src.connect(filter);
    filter.connect(g);
    g.connect(v.root);
    v.nodes.push(src, filter, g);
    src.start(t0, this.rng.float() * 1.5);
    src.stop(t0 + dur + 0.03);
    this.mark(v, src, t0 + dur);
  }

  private envelope(p: AudioParam, t0: number, peak: number, attack: number, decay: number): void {
    const safe = Math.max(peak, 0.0002);
    p.setValueAtTime(0.0001, t0);
    p.linearRampToValueAtTime(safe, t0 + Math.max(attack, 0.001));
    p.exponentialRampToValueAtTime(0.0001, t0 + Math.max(attack, 0.001) + Math.max(decay, 0.02));
  }

  private mark(v: Voice, src: AudioScheduledSourceNode, end: number): void {
    if (end >= v.lastEnd) {
      v.lastEnd = end;
      v.final = src;
    }
  }

  // ---------------------------------------------------- music instrumentation

  private musicVoice(vel: number, dest: GainNode, send: number): Voice | null {
    const budget = this.musicVoices;
    const ctx = this.ctx;
    if (!budget || !ctx) return null;
    const v = budget.create(ctx.currentTime);
    if (!v) return null;
    v.root.gain.value = vel;
    this.voiceRoute(v, dest, 0, send);
    return v;
  }

  private scheduleKick(t: number, i: number): void {
    const rig = this.music;
    if (!rig) return;
    const v = this.musicVoice(1, rig.kick, 0.06 * i);
    if (!v) return;
    const ctx = this.ctx as AudioContext;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(150 + 40 * i, t);
    osc.frequency.exponentialRampToValueAtTime(40, t + 0.1);
    const g = ctx.createGain();
    this.envelope(g.gain, t, 0.95, 0.004, 0.2 + 0.05 * i);
    osc.connect(g);
    g.connect(v.root);
    v.nodes.push(osc, g);
    osc.start(t);
    osc.stop(t + 0.32);
    this.mark(v, osc, t + 0.28);
    this.musicVoices!.track(v);
  }

  private scheduleSnare(t: number, vel: number): void {
    const rig = this.music;
    if (!rig) return;
    const v = this.musicVoice(0.8 * vel, rig.snare, 0.2 * vel);
    if (!v) return;
    this.noiseBurst(v, t, 0.13, 1800, 900, 0.7, 0.5, 0);
    this.tone(v, 'triangle', 190, 140, t, 0.08, 0.3, 0.002, 0);
    this.musicVoices!.track(v);
  }

  private scheduleHat(t: number, vel: number, open: boolean): void {
    const rig = this.music;
    if (!rig) return;
    const v = this.musicVoice(vel, rig.hat, 0.1);
    if (!v) return;
    this.noiseBurst(v, t, open ? 0.14 : 0.035, 7000, 9500, 0.8, open ? 0.3 : 0.45, 0);
    this.musicVoices!.track(v);
  }

  private scheduleBass(t: number, freq: number, stepDur: number, i: number): void {
    const rig = this.music;
    if (!rig) return;
    const v = this.musicVoice(0.9, rig.bass, 0.05);
    if (!v) return;
    const ctx = this.ctx as AudioContext;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(freq, t);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.Q.value = 7;
    f.frequency.setValueAtTime(180 + (700 + 1900 * i) * (0.6 + 0.4 * this.rng.float()), t);
    f.frequency.exponentialRampToValueAtTime(140, t + stepDur * 1.7);
    const g = ctx.createGain();
    this.envelope(g.gain, t, 0.5, 0.006, stepDur * 1.5);
    osc.connect(f);
    f.connect(g);
    g.connect(v.root);
    v.nodes.push(osc, f, g);
    osc.start(t);
    osc.stop(t + stepDur * 1.8 + 0.05);
    this.mark(v, osc, t + stepDur * 1.6);
    this.musicVoices!.track(v);
  }

  private scheduleArp(t: number, freq: number, vel: number): void {
    const rig = this.music;
    if (!rig) return;
    const v = this.musicVoice(vel, rig.arp, 0.24);
    if (!v) return;
    const ctx = this.ctx as AudioContext;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(freq, t);
    osc.detune.value = this.rng.spread(9);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(1200 + 2800 * this.intensity, t);
    f.Q.value = 3;
    const g = ctx.createGain();
    this.envelope(g.gain, t, 0.45, 0.004, 0.13);
    osc.connect(f);
    f.connect(g);
    g.connect(v.root);
    v.nodes.push(osc, f, g);
    osc.start(t);
    osc.stop(t + 0.2);
    this.mark(v, osc, t + 0.17);
    this.musicVoices!.track(v);
  }

  private schedulePad(v: Voice, t: number, bar: number, barSec: number, i: number): void {
    const ctx = this.ctx as AudioContext;
    const root = BASS_ROOTS[bar] * 4;
    const chord = CHORDS[bar];
    const total = barSec + 0.6;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(500 + 1500 * i, t);
    filter.Q.value = 1.2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.1 + 0.08 * i, t + barSec * 0.4);
    g.gain.setTargetAtTime(0.0001, t + barSec * 0.72, barSec * 0.18);
    filter.connect(g);
    g.connect(v.root);
    v.nodes.push(filter, g);
    let last: OscillatorNode | null = null;
    for (const n of chord) {
      const a = ctx.createOscillator();
      a.type = 'sawtooth';
      a.frequency.value = n;
      a.detune.value = -7;
      const b = ctx.createOscillator();
      b.type = 'sawtooth';
      b.frequency.value = n;
      b.detune.value = 7;
      a.connect(filter);
      b.connect(filter);
      v.nodes.push(a, b);
      last = b;
    }
    const seventh = ctx.createOscillator();
    seventh.type = 'triangle';
    seventh.frequency.value = root * PAD_SEVENTHS[bar];
    seventh.connect(filter);
    v.nodes.push(seventh);
    last = seventh;
    for (const n of v.nodes) {
      if (n instanceof OscillatorNode) {
        n.start(t);
        n.stop(t + total);
      }
    }
    if (last) this.mark(v, last, t + total - 0.05);
  }

  // -------------------------------------------------------------- internals

  private auto(
    key: string, p: AudioParam, value: number, now: number, tc: number, eps: number,
  ): void {
    const cache = this.engCache;
    if (key in cache && Math.abs(value - cache[key]) < eps) return;
    p.setTargetAtTime(value, now, tc);
    cache[key] = value;
  }

  private safeRun(label: string, fn: () => void): void {
    if (this.disposed || !this.ctx) return;
    try {
      fn();
    } catch (e) {
      this.warnOnce(label, e);
    }
  }

  private warnOnce(key: string, msg: unknown): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    console.warn(`[AudioEngine:${key}]`, msg);
  }

  private stopOscillators(): void {
    const sources: AudioScheduledSourceNode[] = [];
    const e = this.engine;
    if (e) sources.push(e.tone1, e.tone2, e.sub, e.whine, e.noiseSrc, e.cutoffLfo, e.wobbleLfo);
    const w = this.warning;
    if (w) sources.push(w.tone1, w.tone2, w.tone3, w.lfo);
    for (const s of sources) {
      try { s.stop(); } catch { /* already stopped */ }
    }
  }

  /** Every persistent node, for disconnecting the whole graph on dispose. */
  private allBuses(): AudioNode[] {
    const list: AudioNode[] = [];
    if (this.masterGain) list.push(this.masterGain);
    if (this.masterComp) list.push(this.masterComp);
    for (const b of [this.sfx, this.musicBus, this.engineBus]) if (b) list.push(b.input, b.limiter);
    if (this.reverbIn) list.push(this.reverbIn);
    if (this.reverbConv) list.push(this.reverbConv);
    if (this.reverbReturn) list.push(this.reverbReturn);
    const e = this.engine;
    if (e) list.push(e.sum, e.toneFilter, e.toneGain, e.subGain, e.noiseFilter, e.noiseGain, e.squealFilter, e.squealGain, e.whineFilter, e.whineGain, e.cutoffDepth, e.wobbleDepth);
    const w = this.warning;
    if (w) list.push(w.filter, w.mod, w.level, w.depth);
    const m = this.music;
    if (m) list.push(m.sum, m.kick, m.snare, m.hat, m.bass, m.arp, m.pad);
    return list;
  }
}

// ---------------------------------------------------------------------------
// Silent fallback — same shape, zero behaviour. For tests and browsers
// without Web Audio.
// ---------------------------------------------------------------------------

export function createSilentAudioEngine(): AudioEngineLike {
  return {
    ready: false,
    lastCollisionEnergy: 0,
    init: async () => false,
    unlock: async () => false,
    suspend: () => { /* silent */ },
    resumeCtx: () => { /* silent */ },
    setVolumes: () => { /* silent */ },
    setMusicIntensity: () => { /* silent */ },
    startMusic: () => { /* silent */ },
    stopMusic: () => { /* silent */ },
    setDucking: () => { /* silent */ },
    setWarning: () => { /* silent */ },
    updateEngine: () => { /* silent */ },
    playSfx: () => { /* silent */ },
    dispose: () => { /* silent */ },
  };
}
