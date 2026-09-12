import { clear, el } from './dom.ts';

export type DebugSource = () => Record<string, string | number>;

/**
 * Development telemetry. The node is never built unless `DEBUG.enabled`, so a production
 * bundle carries no way to open it; F3 only toggles visibility.
 */
export class DebugPanel {
  readonly root = el('pre', { class: 'nr-debug', attrs: { 'aria-hidden': 'true' } });
  private visible = false;
  private accumulator = 0;

  constructor(private readonly source: DebugSource) {}

  toggle(): void {
    this.visible = !this.visible;
    this.root.classList.toggle('is-active', this.visible);
    if (!this.visible) clear(this.root);
  }

  get shown(): boolean {
    return this.visible;
  }

  update(dt: number): void {
    if (!this.visible) return;
    // Four lines of sight per second is plenty and keeps the panel from costing frame time.
    this.accumulator += dt;
    if (this.accumulator < 0.25) return;
    this.accumulator = 0;
    const data = this.source();
    const text = Object.entries(data).map(([k, v]) => `${k.padEnd(14)}${v}`).join('\n');
    if (this.root.textContent !== text) this.root.textContent = text;
  }

  dispose(): void {
    clear(this.root);
    this.root.remove();
  }
}
