import { i18n } from '../data/i18n.ts';
import type { StringKey } from '../data/i18n.ts';

/** Element with the handful of children helpers actually used by the UI layer. */
export interface El<T extends HTMLElement> extends T {}

type Child = Node | string | null | undefined | false;

/**
 * The only DOM builder in the project.
 *
 * `textContent` everywhere (never `innerHTML`) so no runtime string can ever become markup,
 * and a typed attribute bag so the screens stay declarative without a framework.
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: {
    class?: string;
    text?: string;
    attrs?: Record<string, string | number | boolean>;
    dataset?: Record<string, string>;
    style?: Record<string, string>;
    on?: Record<string, (event: Event) => void>;
    children?: Child[];
    aria?: Record<string, string>;
  } = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.class) node.className = props.class;
  if (props.text !== undefined) node.textContent = props.text;
  if (props.dataset) for (const [k, v] of Object.entries(props.dataset)) node.dataset[k] = v;
  if (props.style) for (const [k, v] of Object.entries(props.style)) node.style.setProperty(camel(k), v);
  if (props.attrs) {
    for (const [k, v] of Object.entries(props.attrs)) {
      if (v === false) continue;
      node.setAttribute(k, v === true ? '' : String(v));
    }
  }
  if (props.aria) for (const [k, v] of Object.entries(props.aria)) node.setAttribute(`aria-${k}`, v);
  if (props.on) for (const [k, v] of Object.entries(props.on)) node.addEventListener(k, v);
  if (props.children) append(node, props.children);
  return node;
}

function camel(name: string): string {
  return name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

export function append(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
}

export function clear(node: Node): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** Localised text node that re-renders itself when the locale changes. */
export function label(key: StringKey, className = '', params?: Record<string, string | number>): HTMLElement {
  const node = el('span', { class: className, text: i18n.t(key, params) });
  subscribe(node, key, params);
  return node;
}

const bindings = new WeakMap<Node, { key: StringKey; params?: Record<string, string | number> }>();

function subscribe(node: Node, key: StringKey, params?: Record<string, string | number>): void {
  bindings.set(node, { key, params });
}

/** Re-applies every `label()` binding. Called once per locale change by the UIManager. */
export function refreshLabels(root: Node): void {
  const walk = (node: Node): void => {
    const bound = bindings.get(node);
    if (bound && node.textContent !== null) {
      node.textContent = i18n.t(bound.key, bound.params);
    }
    for (const child of Array.from(node.childNodes)) walk(child);
  };
  walk(root);
}

/** Button with a click handler that ignores pointer events on a disabled control. */
export function button(
  key: StringKey | null,
  onClick: () => void,
  opts: { variant?: 'primary' | 'ghost' | 'danger' | 'icon'; className?: string; icon?: string; hint?: string; ariaKey?: string } = {},
): HTMLButtonElement {
  const classes = ['nr-btn'];
  if (opts.variant) classes.push(opts.variant);
  if (opts.className) classes.push(opts.className);
  const node = el('button', {
    class: classes.join(' '),
    type: 'button',
    attrs: { disabled: false },
    on: {
      click: (event) => {
        event.preventDefault();
        if (node.disabled) return;
        onClick();
      },
    },
    children: [
      opts.icon ? el('span', { class: 'nr-btn-icon', text: opts.icon, attrs: { 'aria-hidden': 'true' } }) : null,
      key ? label(key, 'nr-btn-label') : null,
      opts.hint ? el('span', { class: 'nr-btn-hint', text: opts.hint }) : null,
    ],
  });
  if (opts.ariaKey) node.setAttribute('aria-label', opts.ariaKey);
  return node;
}

export function meter(value: number, opts: { className?: string; labelKey?: StringKey } = {}): HTMLElement {
  const fill = el('i', { class: 'nr-meter-fill', style: { width: `${Math.max(0, Math.min(1, value)) * 100}%` } });
  const bar = el('div', {
    class: `nr-meter ${opts.className ?? ''}`.trim(),
    attrs: { role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(value * 100)) },
    children: [fill, opts.labelKey ? label(opts.labelKey, 'nr-meter-label') : null],
  });
  bar.dataset.value = String(value);
  return bar;
}

export function setMeter(bar: HTMLElement, value: number): void {
  const fill = bar.querySelector<HTMLElement>('.nr-meter-fill');
  const clamped = Math.max(0, Math.min(1, value));
  if (fill) fill.style.width = `${clamped * 100}%`;
  bar.setAttribute('aria-valuenow', String(Math.round(clamped * 100)));
  bar.dataset.value = String(clamped);
}

export function toggleClass(node: Element | null, name: string, on: boolean): void {
  if (node) node.classList.toggle(name, on);
}

export function formatNumber(value: number, group = ' '): string {
  const rounded = Math.round(value);
  return rounded.toString().replace(/\B(?=(\d{3})+(?!\d))/g, group);
}

export function formatTime(seconds: number): string {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${m}:${rest < 10 ? '0' : ''}${rest.toFixed(2)}`;
}

export function formatSpeed(kmh: number): string {
  return Math.round(kmh).toString();
}
