import { ADAPTIVE, QUALITY } from '../data/config.ts';
import type { QualityTier } from '../data/types.ts';
import type { SettingsStore } from '../core/Stores.ts';

/** The adaptive sampler hands back one window; this is that shape, restated to keep the seam explicit. */
export interface WindowSample {
  frames: number;
  worstMs: number;
  meanMs: number;
}

export interface QualityBudget {
  tier: QualityTier;
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
  /** 0..1 multiplier applied to every emitter, derived from the tier. */
  effectBudget: number;
}

const LADDER: QualityTier[] = ['ultra', 'high', 'medium', 'low'];

function budgetFor(tier: QualityTier): QualityBudget {
  const q = QUALITY[tier];
  const rank = LADDER.indexOf(tier);
  return {
    tier,
    dprCap: q.dprCap,
    renderScale: q.renderScale,
    particles: q.particles,
    bloom: q.bloom,
    bloomResolutionScale: q.bloomResolutionScale,
    aberration: q.aberration,
    speedLines: q.speedLines,
    starCount: q.starCount,
    nebulaSteps: q.nebulaSteps,
    debrisInstances: q.debrisInstances,
    trailSegments: q.trailSegments,
    msaa: q.msaa,
    envRings: q.envRings,
    warpStreaks: q.warpStreaks,
    effectBudget: 0.55 + (LADDER.length - 1 - rank) * 0.15,
  };
}

/**
 * Chooses the rendering tier and keeps it honest.
 *
 * Automatic mode reads only the frame time the loop actually measured. A downgrade needs a
 * whole window of bad frames; an upgrade additionally requires that no frame in the window
 * spiked, because one hitch that goes unnoticed is worth far less than a tier that visibly
 * pumps between two settings. Changes are followed by a cooldown so the switch itself never
 * becomes the thing the player sees.
 */
export class QualityManager {
  private tier: QualityTier;
  private auto: boolean;
  private budget: QualityBudget;
  private badWindows = 0;
  private goodWindows = 0;
  private cooldownUntil = 0;
  private unsubscribe: (() => void) | null = null;
  private changeHandler: ((tier: QualityTier, reason: 'auto' | 'manual') => void) | null = null;

  constructor(settings: SettingsStore, ceiling: QualityTier = 'ultra') {
    this.auto = settings.get('autoQuality');
    this.tier = clampToCeiling(settings.get('quality'), ceiling);
    this.budget = budgetFor(this.tier);
    this.unsubscribe = settings.onChange(() => {
      const next = settings.get('quality');
      this.auto = settings.get('autoQuality');
      if (!this.auto) this.apply(clampToCeiling(next, ceiling), 'manual');
    });
  }

  get current(): QualityTier {
    return this.tier;
  }

  get profile(): QualityBudget {
    return this.budget;
  }

  get isAuto(): boolean {
    return this.auto;
  }

  onChange(handler: (tier: QualityTier, reason: 'auto' | 'manual') => void): void {
    this.changeHandler = handler;
  }

  setAuto(on: boolean): void {
    this.auto = on;
    this.badWindows = 0;
    this.goodWindows = 0;
  }

  /** Never render above what the GPU can sustain, without overriding an explicit choice. */
  setCeiling(ceiling: QualityTier): void {
    if (LADDER.indexOf(this.tier) < LADDER.indexOf(ceiling)) this.apply(ceiling, 'auto');
  }

  /**
   * One completed adaptive window.
   * @returns true when the tier changed and the renderer must be reconfigured.
   */
  observe(sample: WindowSample, nowSeconds: number): boolean {
    if (!this.auto || nowSeconds < this.cooldownUntil || sample.frames < ADAPTIVE.sampleFrames) return false;
    const bad = sample.meanMs > ADAPTIVE.badFrameMs || sample.worstMs > ADAPTIVE.badFrameMs * 2.6;
    const good = sample.meanMs < ADAPTIVE.goodFrameMs && sample.worstMs < ADAPTIVE.badFrameMs * 1.5;
    this.badWindows = bad ? this.badWindows + 1 : 0;
    this.goodWindows = good ? this.goodWindows + 1 : 0;

    const index = LADDER.indexOf(this.tier);
    const downNeeded = Math.ceil(ADAPTIVE.sampleFrames * ADAPTIVE.badRatioDown);
    const upNeeded = Math.ceil(ADAPTIVE.sampleFrames * ADAPTIVE.badRatioUp) * 2;
    if (this.badWindows >= downNeeded && this.tier !== ADAPTIVE.minTier && index < LADDER.length - 1) {
      this.apply(LADDER[index + 1], 'auto');
      this.armCooldown(nowSeconds, 1);
      return true;
    }
    if (this.goodWindows >= upNeeded && index > 0) {
      this.apply(LADDER[index - 1], 'auto');
      this.armCooldown(nowSeconds, 2);
      return true;
    }
    return false;
  }

  private armCooldown(nowSeconds: number, multiplier: number): void {
    this.cooldownUntil = nowSeconds + (ADAPTIVE.cooldownMs / 1000) * multiplier;
    this.badWindows = 0;
    this.goodWindows = 0;
  }

  private apply(tier: QualityTier, reason: 'auto' | 'manual'): void {
    if (tier === this.tier) return;
    this.tier = tier;
    this.budget = budgetFor(tier);
    this.changeHandler?.(tier, reason);
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.changeHandler = null;
  }
}

function clampToCeiling(tier: QualityTier, ceiling: QualityTier): QualityTier {
  return LADDER.indexOf(tier) < LADDER.indexOf(ceiling) ? LADDER.indexOf(ceiling) < 0 ? tier : ceiling : tier;
}
