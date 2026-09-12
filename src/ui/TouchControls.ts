import type { InputManager } from '../input/InputManager.ts';
import { append, clear, el } from './dom.ts';

type Hold = 'steerLeft' | 'steerRight' | 'throttle' | 'brake' | 'boost' | 'drift' | 'ability';

/**
 * On-screen controls for touch devices.
 *
 * They write straight into the same `InputManager.touch` state a gamepad would, so the
 * simulation never learns the difference between a thumb and a key. Pointer capture keeps a
 * drag that slides off a pad from sticking at full lock.
 */
export class TouchControls {
  readonly root = el('div', { class: 'nr-touch', attrs: { 'aria-hidden': 'false' } });
  private readonly pads: { node: HTMLElement; hold: Hold }[] = [];
  private readonly active = new Map<Hold, PointerEvent['pointerId']>();

  constructor(private readonly input: InputManager) {
    const left = el('div', { class: 'nr-touch-group', children: [this.pad('steerLeft', '◀'), this.pad('steerRight', '▶')] });
    const right = el('div', { class: 'nr-touch-group', children: [
      this.pad('brake', '▽'),
      this.pad('throttle', '△'),
      this.pad('drift', '◇'),
      this.pad('boost', '»'),
      this.pad('ability', '✦'),
    ] });
    append(this.root, [left, right]);
  }

  private pad(hold: Hold, glyph: string): HTMLElement {
    const node = el('button', {
      class: 'nr-touch-btn',
      text: glyph,
      attrs: { type: 'button', 'aria-label': hold },
    });
    node.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      node.setPointerCapture(event.pointerId);
      this.active.set(hold, event.pointerId);
      this.apply(hold, true);
      node.classList.add('is-on');
    });
    const release = (event: PointerEvent) => {
      if (this.active.get(hold) !== event.pointerId) return;
      this.active.delete(hold);
      this.apply(hold, false);
      node.classList.remove('is-on');
    };
    node.addEventListener('pointerup', release);
    node.addEventListener('pointercancel', release);
    node.addEventListener('lostpointercapture', release);
    this.pads.push({ node, hold });
    return node;
  }

  private apply(hold: Hold, on: boolean): void {
    const t = this.input.touch;
    t.active = true;
    switch (hold) {
      case 'steerLeft': t.steer = on ? -1 : (this.active.has('steerRight') ? 1 : 0); break;
      case 'steerRight': t.steer = on ? 1 : (this.active.has('steerLeft') ? -1 : 0); break;
      case 'throttle': t.throttle = on ? 1 : (this.active.has('brake') ? -1 : 0); break;
      case 'brake': t.throttle = on ? -1 : (this.active.has('throttle') ? 1 : 0); break;
      case 'boost': t.boost = on; break;
      case 'drift': t.drift = on; break;
      case 'ability': t.ability = on; break;
    }
  }

  setVisible(on: boolean): void {
    this.root.style.display = on ? '' : 'none';
    if (!on) this.releaseAll();
  }

  private releaseAll(): void {
    for (const { node, hold } of this.pads) {
      node.classList.remove('is-on');
      this.apply(hold, false);
    }
    this.active.clear();
    this.input.touch.active = false;
  }

  dispose(): void {
    clear(this.root);
    this.root.remove();
  }
}
