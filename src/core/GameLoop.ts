/**
 * Fixed-timestep simulation loop with frame-time telemetry.
 * The simulation never sees a variable dt, which keeps steering and collisions stable
 * on 30 / 60 / 144 Hz displays.
 */

export interface FrameStats {
  /** Smoothed milliseconds per rAF callback. */
  frameMs: number;
  /** Rolling FPS estimate. */
  fps: number;
  /** Worst frame time in the current sample window. */
  worstMs: number;
  /** Simulation steps executed on the last frame. */
  lastSteps: number;
  /** Steps skipped by the catch-up limiter since boot. */
  dropped: number;
  /** Ring buffer of recent frame times for the performance graph. */
  history: Float32Array;
  historyIndex: number;
  /** Longest frame in the current adaptive-quality sample window. */
  windowWorst: number;
  /** Frames sampled in the current adaptive-quality window. */
  windowFrames: number;
}

export interface LoopHooks {
  /** Fixed simulation step. */
  update: (dt: number, elapsed: number) => void;
  /** Once per rendered frame, after all sim steps. */
  render: (alpha: number, frameMs: number) => void;
  /** Called when the tab becomes hidden / visible. */
  suspend?: () => void;
  resume?: () => void;
}

export const STEP = 1 / 120;
const MAX_STEPS = 6;
const MAX_FRAME_DT = 0.25;

export class GameLoop {
  readonly stats: FrameStats = {
    frameMs: 16.7,
    fps: 60,
    worstMs: 0,
    lastSteps: 0,
    dropped: 0,
    history: new Float32Array(96),
    historyIndex: 0,
    windowWorst: 0,
    windowFrames: 0,
  };

  private raf = 0;
  private last = 0;
  private accumulator = 0;
  private elapsed = 0;
  private running = false;
  private paused = false;
  private readonly hooks: LoopHooks;

  constructor(hooks: LoopHooks) {
    this.hooks = hooks;
  }

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.tick);
  }

  stop(): void {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  /** Suspend simulation *and* rendering work without tearing down the rAF chain. */
  setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    if (paused) this.hooks.suspend?.();
    else {
      this.hooks.resume?.();
      this.last = performance.now();
      this.accumulator = 0;
    }
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /** Force a single frame — used by the loading screen and garage idle spin. */
  stepOnce(): void {
    this.runFrame(1 / 60);
  }

  private readonly tick = (now: number): void => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.tick);
    let frameDt = (now - this.last) / 1000;
    this.last = now;
    if (frameDt > MAX_FRAME_DT) frameDt = MAX_FRAME_DT;
    this.runFrame(frameDt);
  };

  private runFrame(frameDt: number): void {
    const frameMs = frameDt * 1000;
    const s = this.stats;
    s.frameMs += (frameMs - s.frameMs) * 0.08;
    s.fps = 1000 / Math.max(0.5, s.frameMs);
    s.worstMs = Math.max(s.worstMs * 0.98, frameMs);
    s.windowWorst = Math.max(s.windowWorst, frameMs);
    s.windowFrames++;
    s.history[s.historyIndex] = frameMs;
    s.historyIndex = (s.historyIndex + 1) % s.history.length;

    if (!this.paused) {
      this.accumulator += frameDt;
      let steps = 0;
      while (this.accumulator >= STEP && steps < MAX_STEPS) {
        this.hooks.update(STEP, this.elapsed);
        this.accumulator -= STEP;
        this.elapsed += STEP;
        steps++;
      }
      if (steps === MAX_STEPS && this.accumulator > STEP) {
        s.dropped++;
        this.accumulator = 0;
      }
      s.lastSteps = steps;
    }

    this.hooks.render(this.accumulator / STEP, frameMs);
  }

  /** Consume and reset the adaptive-quality sample window. */
  takeWindowSample(): { frames: number; worstMs: number; meanMs: number } {
    let sum = 0;
    const n = Math.min(this.stats.history.length, Math.max(1, this.stats.windowFrames));
    for (let i = 0; i < n; i++) sum += this.stats.history[i];
    const sample = { frames: this.stats.windowFrames, worstMs: this.stats.windowWorst, meanMs: sum / n };
    this.stats.windowFrames = 0;
    this.stats.windowWorst = 0;
    return sample;
  }
}
