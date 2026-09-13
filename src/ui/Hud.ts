import { i18n } from '../data/i18n.ts';
import type { StringKey } from '../data/i18n.ts';
import type { RaceRuntime } from '../game/RaceRuntime.ts';
import { append, clear, el, formatNumber, formatSpeed, formatTime } from './dom.ts';

/** Power-up slots: fixed order so the row never reflows when one expires. */
const POWERUP_SLOTS: { key: 'shield' | 'phase' | 'overdrive' | 'magnet'; glyph: string; label: StringKey }[] = [
  { key: 'shield', glyph: '◇', label: 'hud.shield' },
  { key: 'phase', glyph: '◈', label: 'howto.power.phase' },
  { key: 'overdrive', glyph: '⋀', label: 'hud.boost' },
  { key: 'magnet', glyph: '⊙', label: 'howto.power.energy' },
];

/**
 * In-race display layer.
 *
 * Every value is written through a cache so a steady HUD performs zero DOM writes, and the
 * centre band is deliberately left empty — the racing line is the only thing that may occupy
 * it (UI contract rule 6). Numbers are tabular and sized for glanceable reading at speed.
 */
export class Hud {
  readonly root = el('div', { class: 'nr-hud', attrs: { 'aria-hidden': 'true' } });

  private readonly objective = el('div', { class: 'nr-hud-objective nr-hud-plate', text: '' });
  private readonly daily = el('div', { class: 'nr-hud-daily nr-hud-plate', text: '' });
  private readonly warnings = el('div', { class: 'nr-hud-warnings' });
  private readonly combo = el('div', { class: 'nr-hud-combo', attrs: { 'data-tier': '1' } });
  private readonly flash = el('div', { class: 'nr-hud-flash' });
  private readonly speed = el('span', { class: 'nr-speed-value', text: '0' });
  private readonly energyFill = el('i', { class: 'nr-energy-fill' });
  private readonly boostRing = el('span', { class: 'nr-hud-boost', text: '' });
  private readonly progressFill = el('i', { class: 'nr-progress-fill' });
  private readonly progressMarker = el('i', { class: 'nr-progress-marker' });
  private readonly score = el('div', { class: 'nr-score-value', text: '0' });
  private readonly multiplier = el('div', { class: 'nr-hud-multiplier', text: '×1' });
  private readonly clock = el('div', { class: 'nr-hud-time', text: '0:00.00' });
  private readonly shieldRow = el('div', { class: 'nr-hud-shield' });
  private readonly powerRow = el('div', { class: 'nr-hud-powerups' });
  private readonly countdown = el('div', { class: 'nr-countdown' });
  private readonly fps = el('div', { class: 'nr-fps nr-hud-plate', text: '' });
  private readonly shieldPips = [0, 1, 2].map(() => el('i', { class: 'nr-shield-pip' }));
  private readonly powers = POWERUP_SLOTS.map((slot) => ({
    slot,
    node: el('div', { class: 'nr-powerup', attrs: { title: i18n.t(slot.label) } }),
    bar: el('i', { class: 'nr-powerup-bar' }),
    glyph: el('span', { class: 'nr-powerup-glyph', text: slot.glyph, attrs: { 'aria-hidden': 'true' } }),
  }));
  private readonly cache = new Map<string, string | number | boolean>();
  private flashUntil = 0;
  private countdownUntil = 0;

  constructor() {
    append(this.shieldRow, this.shieldPips);
    for (const p of this.powers) append(p.node, [p.glyph, p.bar]);
    append(this.powerRow, this.powers.map((p) => p.node));

    const speedBlock = el('div', {
      class: 'nr-hud-speed nr-hud-plate',
      children: [this.speed, el('span', { class: 'nr-speed-unit', text: 'km/h' })],
    });
    const energyBlock = el('div', { class: 'nr-hud-energy', children: [this.energyFill, this.boostRing] });
    const progressBlock = el('div', {
      class: 'nr-hud-progress',
      children: [this.progressFill, this.progressMarker, el('span', { class: 'nr-progress-label', text: i18n.t('hud.progress') })],
    });
    const stack = el('div', { class: 'nr-hud-stack', children: [energyBlock, progressBlock, el('div', { class: 'nr-hud-row nr-row', children: [this.shieldRow, this.powerRow] })] });
    const readouts = el('div', { class: 'nr-hud-readouts nr-hud-plate', children: [this.score, this.multiplier, this.clock] });

    append(this.root, [
      el('div', { class: 'nr-hud-top', children: [this.objective, el('div', { class: 'nr-row', children: [this.fps, this.daily] })] }),
      // The warning strip belongs to the top band: it must stay readable without ever reaching
      // into the centre of the frame where the lane is.
      this.warnings,
      el('div', { class: 'nr-hud-mid', children: [this.combo, this.flash] }),
      el('div', { class: 'nr-hud-bottom', children: [speedBlock, stack, readouts] }),
      this.countdown,
    ]);
  }

  /** @param dailyTag shown only on the daily lane, so a seeded run looks different */
  arm(dailyTag: string | null): void {
    this.daily.textContent = dailyTag ?? '';
    this.daily.style.display = dailyTag ? '' : 'none';
    this.reset();
  }

  private write<T extends string | number | boolean>(id: string, value: T, apply: (current: T) => void): boolean {
    if (this.cache.get(id) === value) return false;
    this.cache.set(id, value);
    apply(value);
    return true;
  }

  /** Pulls one frame of state. Called from the render step, after `runtime.updateHud()`. */
  sync(rt: RaceRuntime, time: number): void {
    const h = rt.hud;
    // The simulation runs in m/s; the dash reads in km/h like every real speedo.
    this.write('speed', Math.round(h.speed * 1.8), () => {
      this.speed.textContent = formatSpeed(h.speed * 3.6);
    });
    this.write('score', h.score, () => {
      this.score.textContent = formatNumber(h.score);
    });
    this.write('multi', Math.round(h.multiplier * 10), () => {
      this.multiplier.textContent = `×${h.multiplier < 10 ? h.multiplier.toFixed(1) : Math.round(h.multiplier)}`;
    });
    this.write('time', Math.round(h.time * 20), () => {
      this.clock.textContent = formatTime(h.time);
    });
    this.write('energy', Math.round(h.energy), () => {
      this.energyFill.style.width = `${Math.max(0, Math.min(100, h.energy))}%`;
      this.energyFill.parentElement?.classList.toggle('is-low', h.energy < 22);
    });
    this.write('progress', Math.round(h.progress * 400), () => {
      const pct = `${Math.max(0, Math.min(1, h.progress)) * 100}%`;
      this.progressFill.style.width = pct;
      this.progressMarker.style.left = pct;
    });
    this.write('objective', h.objective, () => {
      this.objective.textContent = i18n.t(h.objective);
    });
    this.write('chain', h.chain, () => {
      const tier = h.chain >= 40 ? '4' : h.chain >= 20 ? '3' : h.chain >= 8 ? '2' : '1';
      this.combo.dataset.tier = tier;
      this.combo.classList.toggle('is-active', h.chain >= 3);
      this.combo.textContent = h.chain >= 3 ? `${i18n.t('hud.combo')} ${h.chain}` : '';
    });
    this.write('boosting', h.boosting, (v) => this.root.classList.toggle('is-boosting', v));
    this.write('perfect', h.perfect, (v) => this.root.classList.toggle('is-perfect', v));
    this.write('shield', h.shield > 0 ? 1 : 0, () => {
      const hits = rt.player.shieldHits;
      this.shieldPips.forEach((pip, i) => pip.classList.toggle('is-on', i < hits));
    });
    this.write('boostRing', h.ability > 0.99 ? 1 : 0, () => {
      this.boostRing.textContent = h.ability > 0.99 ? i18n.t('hud.ready') : '';
    });
    this.write('drift', Math.round(h.driftCharge * 20), () => {
      this.combo.style.setProperty('--nr-drift', String(h.driftCharge.toFixed(2)));
    });

    const timers: Record<string, number> = {
      shield: rt.player.shieldHits > 0 ? Math.min(1, rt.player.shieldTimer / 6) : 0,
      phase: h.phase,
      overdrive: h.overdrive,
      magnet: h.magnet,
    };
    for (const p of this.powers) {
      const raw = timers[p.slot.key];
      const bucket = Math.round(raw * 8);
      this.write(`power-${p.slot.key}`, bucket, () => {
        p.node.classList.toggle('is-active', raw > 0.01);
        p.bar.style.height = `${Math.max(0, Math.min(1, raw / 8)) * 100}%`;
      });
    }

    const warned = rt.warnings.some((w) => w.key === 'warn.collapse');
    this.write('warnCollapse', warned, () => this.objective.classList.toggle('is-warn', warned));
    this.syncWarnings(rt);
    this.root.classList.toggle('is-damaged', rt.player.damage > 0.55);

    if (time >= this.countdownUntil && this.countdown.classList.contains('is-active')) {
      this.countdown.classList.remove('is-active');
      this.countdown.textContent = '';
    }

    if (time < this.flashUntil) return;
    if (this.flash.textContent) {
      this.flash.textContent = '';
      this.flash.classList.remove('is-active');
    }
  }

  private syncWarnings(rt: RaceRuntime): void {
    const live = rt.warnings;
    const signature = live.map((w) => `${w.key}${w.side}`).join('|');
    if (!this.write('warnSig', signature, () => undefined)) return;
    clear(this.warnings);
    for (const w of live) {
      append(this.warnings, [
        el('div', {
          class: `nr-warning nr-hud-plate ${w.side === 0 ? '' : `is-side-${w.side > 0 ? 'right' : 'left'}`}`.trim(),
          text: i18n.t(w.key),
        }),
      ]);
    }
  }

  /** Centre-flash a momentary event (PERFECT, +500, NEAR MISS…). */
  showFlash(key: StringKey, params?: Record<string, string | number>, seconds = 0.9): void {
    this.flash.textContent = i18n.t(key, params);
    this.flash.classList.add('is-active');
    this.flashUntil = performance.now() / 1000 + seconds;
  }

  showCountdown(value: number): void {
    this.countdown.textContent = value > 0 ? String(value) : i18n.t('countdown.go');
    this.countdown.classList.remove('is-active');
    // Restart the animation without forcing a synchronous reflow of the whole subtree.
    requestAnimationFrame(() => this.countdown.classList.add('is-active'));
    // Nothing else ever takes `is-active` off, so the final "GO" used to sit at full-screen
    // opacity over the whole race: each tick hides itself when its beat is over.
    this.countdownUntil = performance.now() / 1000 + (value > 0 ? 0.9 : 1.15);
  }

  /** Optional readout; hidden unless the player asked for it in settings. */
  setFps(value: number | null): void {
    if (value === null || value <= 0) {
      if (this.fps.textContent) this.fps.textContent = '';
      return;
    }
    const text = `${Math.round(value)} FPS`;
    if (this.fps.textContent !== text) this.fps.textContent = text;
  }

  setVisible(on: boolean): void {
    this.root.classList.toggle('is-hidden', !on);
  }

  reset(): void {
    this.cache.clear();
    clear(this.warnings);
    this.flash.textContent = '';
    this.countdown.classList.remove('is-active');
    this.root.classList.remove('is-boosting', 'is-perfect', 'is-damaged');
  }

  refreshLocale(): void {
    this.cache.clear();
  }

  dispose(): void {
    clear(this.root);
    this.root.remove();
  }
}
