import type { App } from '../main.ts';
import type { GamePhase } from '../data/types.ts';

/**
 * Headless verification harness, armed by `?selftest`.
 *
 * Nothing about a build can prove the game actually draws, so this walks the real phase graph,
 * samples the framebuffer after each rendered frame and asserts the race is alive: speed rises,
 * score accrues, particles exist, draw calls are non-zero. The result is written into the DOM
 * (`document.title` and a `<pre>` node) so a headless run can read it back with `--dump-dom`.
 */

export interface Probe {
  mean: number;
  max: number;
  lit: number;
}

const SCREENS: GamePhase[] = ['main_menu', 'garage', 'settings', 'howto', 'briefing'];

export async function runSelfTest(app: App): Promise<Record<string, unknown>> {
  app.pixelProbe = true;
  // Software rasterisers are the only renderer available headless, so the harness
  // deliberately runs the cheapest tier: it is verifying wiring, not image quality.
  app.settings.set('autoQuality', false);
  app.settings.set('quality', 'low');
  app.applySettings();
  app.renderer.applyQuality();
  const report: Record<string, unknown> = { ok: false, steps: [] as string[], errors: [] as string[] };
  const steps = report.steps as string[];
  const errors = report.errors as string[];

  window.addEventListener('error', (event) => errors.push(`error: ${event.message}`));
  window.addEventListener('unhandledrejection', (event) => errors.push(`rejection: ${String((event as PromiseRejectionEvent).reason)}`));

  try {
    await waitFor(() => app.phase === 'main_menu', 20000, 'reach main menu');
    const menu = await probe(app);
    steps.push(`main_menu pixels=${fmt(menu)}`);
    expectLit(menu, errors, 'main menu framebuffer');

    for (const phase of SCREENS.slice(1)) {
      app.goto(phase);
      await waitFor(() => app.phase === phase, 4000, `enter ${phase}`);
      const sample = await probe(app);
      const screen = document.querySelector('.nr-screen.is-active')?.getAttribute('data-screen') ?? 'none';
      steps.push(`${phase} screen=${screen} pixels=${fmt(sample)}`);
      expectLit(sample, errors, `${phase} framebuffer`);
      if (screen === 'none') errors.push(`${phase}: no active screen`);
    }

    app.goto('main_menu');
    await waitFor(() => app.phase === 'main_menu', 4000, 'back to menu');
    // Both locales must be complete: a raw key rendering on screen is a visible bug, and the
    // dictionary types only guarantee coverage at compile time in one direction.
    for (const locale of ['ru', 'en'] as const) {
      app.settings.set('locale', locale);
      app.applySettings();
      await sleep(120);
      for (const phase of ['main_menu', 'briefing', 'garage', 'settings', 'howto'] as const) {
        app.goto(phase);
        await waitFor(() => app.phase === phase, 4000, `enter ${phase} (${locale})`).catch(() => undefined);
        const leak = rawKeyLeak();
        steps.push(`locale=${locale} ${phase} leak=${leak || 'none'}`);
        if (leak) errors.push(`${locale}/${phase} shows an untranslated key: ${leak}`);
      }
      app.goto('main_menu');
      await waitFor(() => app.phase === 'main_menu', 4000, 'menu after locale').catch(() => undefined);
    }


    app.startRace({ mode: 'seed', difficulty: 'pilot', biome: 'collapse_field', seedText: 'SELFTEST-2024' });
    await waitFor(() => app.phase === 'countdown' || app.phase === 'racing', 25000, 'start race');
    steps.push(`started phase=${app.phase}`);

    await waitFor(() => app.phase === 'racing', 90000, 'countdown to racing');
    await waitFor(() => {
      const rt = app.runtime;
      return !!rt && rt.hud.speed > 40;
    }, 40000, 'ship accelerates');

    const rt = app.runtime;
    if (!rt) throw new Error('runtime vanished during race');
    const start = { s: rt.player.s, score: rt.hud.score };
    // Progress is measured in rendered frames, not wall clock: a software rasteriser may
    // take a tenth of a second per frame, and then elapsed time proves nothing.
    const tickStart = app.probeTick;
    // A single black frame is reportable, but it may also be a momentary darkness inside a
    // spectacle. Take a run of samples so the two are distinguishable.
    const shots: string[] = [];
    let dark = 0;
    for (let i = 0; i < 5; i++) {
      const sample = await probe(app);
      shots.push(fmt(sample));
      if (sample.lit < 0.1) dark++;
    }
    await waitFor(() => app.probeTick > tickStart + 90, 120000, 'ninety rendered frames');
    const st = rt.spectacle.state;
    const info = app.renderer.stats;
    const scene = app.renderer.sceneInfo;
    steps.push(
      `racing s=${rt.player.s.toFixed(0)} speed=${rt.hud.speed.toFixed(0)} score=${rt.hud.score} chain=${rt.hud.chain} particles=${app.renderer.particleCount} props=${scene.props} draws=${info.calls} tris=${info.triangles}`,
    );
    steps.push(`racing pixels=[${shots.join(' ')}] tier=${app.quality.current} warp=${st.warp.toFixed(2)} interior=${st.interior.toFixed(2)} vortex=${st.vortex.toFixed(2)}`);
    if (dark >= 4) errors.push(`race framebuffer was black in ${dark}/5 samples`);
    if (rt.player.s <= start.s + 5) errors.push('ship did not advance along the lane');
    if (info.calls < 3) errors.push(`suspiciously few draw calls: ${info.calls}`);
    if (!scene.tunnel) errors.push('no tunnel mesh in the scene');
    if (!scene.ship) errors.push('no ship in the scene');
    if (scene.props < 1) errors.push('no props were uploaded to the GPU');
    if (info.triangles < 2000) errors.push(`almost nothing was rasterised: ${info.triangles} triangles`);
    if (rt.hud.score <= start.score) errors.push('score did not accrue while flying');
    if (!Number.isFinite(rt.player.s) || !Number.isFinite(rt.hud.score)) errors.push('non-finite race state');

    const speedNode = document.querySelector('.nr-speed-value')?.textContent ?? '';
    const scoreNode = document.querySelector('.nr-score-value')?.textContent ?? '';
    steps.push(`hud dom speed=${speedNode} score=${scoreNode}`);
    if (!speedNode.trim()) errors.push('HUD speed readout is empty');

    app.goto('paused');
    await waitFor(() => app.phase === 'paused', 4000, 'pause');
    steps.push('paused ok');
    app.goto('racing');
    await waitFor(() => app.phase === 'racing', 4000, 'resume');

    // A wrecked or finished run both prove the end-of-race path; either is acceptable.
    const ended = await until(() => app.phase === 'finish' || app.phase === 'results', 45000);
    if (ended) {
      await waitFor(() => app.phase === 'results', 8000, 'results panel').catch(() => undefined);
      const result = document.querySelector('[data-screen="results"]')?.classList.contains('is-active');
      steps.push(`ended phase=${app.phase} resultsShown=${!!result}`);
    } else {
      steps.push(`ended=false s=${(app.runtime?.player.s ?? 0).toFixed(0)}`);
    }
    report.ok = errors.length === 0;
  } catch (error) {
    errors.push(`fatal: ${error instanceof Error ? error.message : String(error)}`);
  }

  app.pixelProbe = false;
  const text = JSON.stringify(report, null, 1);
  document.title = report.ok ? 'SELFTEST OK' : 'SELFTEST FAIL';
  const pre = document.createElement('pre');
  pre.id = 'selftest-result';
  pre.style.cssText = 'position:fixed;inset:auto 0 0 0;max-height:45%;overflow:auto;margin:0;font:11px/1.4 monospace;color:#8fff;background:rgba(0,0,0,.85);z-index:99';
  pre.textContent = text;
  document.body.appendChild(pre);
  return report;
}

/** Reads a 3x3 grid of framebuffer samples: proof that something was actually drawn. */
async function probe(app: App): Promise<Probe> {
  const before = app.probeTick;
  await waitFor(() => app.probeTick > before, 2000, 'a rendered frame').catch(() => undefined);
  return app.readPixels() ?? { mean: -1, max: -1, lit: -1 };
}

/** Finds text that still looks like an i18n key (`brief.title`) rather than translated copy. */
function rawKeyLeak(): string {
  const active = document.querySelector('.nr-screen.is-active');
  if (!active) return '';
  const lines = (active.textContent ?? '').split(/[\n\r]+/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^[a-z][a-z0-9]{2,12}\.[a-z][A-Za-z0-9]{2,}$/.test(trimmed)) return trimmed;
  }
  return '';
}

function expectLit(probe: Probe, errors: string[], what: string): void {
  if (probe.mean < 0) errors.push(`${what}: no pixel sample`);
  else if (probe.max < 6) errors.push(`${what} is black (max=${probe.max})`);
  else if (probe.lit < 0.1) errors.push(`${what} mostly empty (lit=${probe.lit.toFixed(2)})`);
}

function fmt(p: Probe): string {
  return `mean=${p.mean.toFixed(1)} max=${p.max} lit=${p.lit.toFixed(2)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const hit = await until(predicate, timeoutMs);
  if (!hit) throw new Error(`timeout waiting to ${label}`);
}

async function until(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(120);
  }
  return predicate();
}
