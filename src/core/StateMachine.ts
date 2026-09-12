import type { GamePhase } from '../data/types.ts';

export interface PhaseHandlers<C> {
  enter?: (from: GamePhase | null, ctx: C) => void | Promise<void>;
  exit?: (to: GamePhase, ctx: C) => void;
  update?: (dt: number, ctx: C) => void;
  /** Return true to allow the transition. */
  canLeave?: (to: GamePhase, ctx: C) => boolean;
  /** Simulation is frozen while paused/menu phases run, rendering continues. */
  simulate?: boolean;
}

const TRANSITIONS: Record<GamePhase, GamePhase[]> = {
  boot: ['loading'],
  loading: ['main_menu', 'countdown'],
  main_menu: ['briefing', 'garage', 'settings', 'howto', 'loading'],
  garage: ['main_menu', 'briefing', 'settings'],
  settings: ['main_menu', 'garage', 'briefing', 'howto', 'paused'],
  howto: ['main_menu', 'briefing'],
  briefing: ['main_menu', 'countdown', 'settings', 'garage', 'howto'],
  countdown: ['racing', 'paused', 'main_menu'],
  racing: ['paused', 'finish', 'main_menu', 'countdown'],
  paused: ['racing', 'countdown', 'main_menu', 'settings'],
  finish: ['results', 'main_menu'],
  results: ['countdown', 'briefing', 'main_menu', 'garage', 'settings'],
};

export class StateMachine<C> {
  private current: GamePhase | null = null;
  private readonly handlers = new Map<GamePhase, PhaseHandlers<C>>();
  private readonly listeners = new Set<(from: GamePhase | null, to: GamePhase) => void>();

  constructor(private readonly ctx: C) {}

  register(phase: GamePhase, handlers: PhaseHandlers<C>): void {
    this.handlers.set(phase, handlers);
  }

  get phase(): GamePhase {
    return this.current ?? 'boot';
  }

  get phaseHandlers(): PhaseHandlers<C> | undefined {
    return this.current ? this.handlers.get(this.current) : undefined;
  }

  get isSimulating(): boolean {
    return this.phaseHandlers?.simulate ?? false;
  }

  is(...phases: GamePhase[]): boolean {
    return phases.includes(this.phase);
  }

  can(to: GamePhase): boolean {
    if (!this.current) return to === 'boot' || to === 'loading';
    if (this.current === to) return false;
    return TRANSITIONS[this.current]?.includes(to) ?? false;
  }

  onTransition(cb: (from: GamePhase | null, to: GamePhase) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  force(to: GamePhase): void {
    this.transition(to, true);
  }

  go(to: GamePhase): boolean {
    if (!this.can(to)) {
      console.warn(`[nebula] Blocked state transition ${String(this.current)} → ${to}`);
      return false;
    }
    this.transition(to, false);
    return true;
  }

  private transition(to: GamePhase, ignoreGuards: boolean): void {
    const from = this.current;
    if (from === to) return;
    const prev = from ? this.handlers.get(from) : undefined;
    if (prev?.canLeave && !ignoreGuards && !prev.canLeave(to, this.ctx)) return;
    prev?.exit?.(to, this.ctx);
    this.current = to;
    for (const cb of [...this.listeners]) cb(from, to);
    const next = this.handlers.get(to);
    void next?.enter?.(from, this.ctx);
  }

  update(dt: number): void {
    this.phaseHandlers?.update?.(dt, this.ctx);
  }
}
