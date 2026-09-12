/**
 * Deterministic seeded RNG (sfc32) so a race is fully reproducible from its seed.
 * Never use Math.random() for gameplay content — only for cosmetic jitter.
 */

export type Seed = string;

function hashString(str: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(seed: Seed | number) {
    const s = typeof seed === 'number' ? seed >>> 0 : hashString(seed);
    // Avoid the all-zero state.
    this.a = (s ^ 0x9e3779b9) >>> 0 || 1;
    this.b = (s ^ 0x85ebca6b) >>> 0 || 2;
    this.c = (s ^ 0xc2b2ae35) >>> 0 || 3;
    this.d = (s ^ 0x27d4eb2f) >>> 0 || 4;
    for (let i = 0; i < 12; i++) this.uint32();
  }

  /** Raw uint32. */
  uint32(): number {
    const { a, b, c, d } = this;
    const t = (((a + b) | 0) + d) | 0;
    this.d = (d + 1) | 0;
    const nb = (b ^ (b >>> 9)) | 0;
    this.b = (c + (c << 1)) | 0;
    this.c = (this.c + nb) | 0;
    this.a = t;
    return t >>> 0;
  }

  /** [0,1) */
  float(): number {
    return this.uint32() / 4294967296;
  }

  range(min: number, max: number): number {
    return min + (max - min) * this.float();
  }

  /** Symmetric [-mag, mag) */
  spread(mag: number): number {
    return (this.float() * 2 - 1) * mag;
  }

  int(maxExclusive: number): number {
    return Math.floor(this.float() * maxExclusive);
  }

  intRange(minIncl: number, maxIncl: number): number {
    return minIncl + Math.floor(this.float() * (maxIncl - minIncl + 1));
  }

  chance(p: number): boolean {
    return this.float() < p;
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.float() * items.length)];
  }

  weighted<T>(entries: readonly { value: T; weight: number }[]): T {
    let total = 0;
    for (const e of entries) total += e.weight;
    let r = this.float() * total;
    for (const e of entries) {
      r -= e.weight;
      if (r <= 0) return e.value;
    }
    return entries[entries.length - 1].value;
  }

  /** Fisher-Yates in place. */
  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(this.float() * (i + 1));
      const tmp = items[i];
      items[i] = items[j];
      items[j] = tmp;
    }
    return items;
  }

  fork(tag: string): Rng {
    return new Rng(hashString(`${this.a >>> 0}:${this.b >>> 0}:${tag}`));
  }
}

/** Cheap deterministic hash → [0,1). Used for per-instance shader jitter. */
export function hash01(n: number): number {
  let x = (Math.imul(n | 0, 1664525) + 1013904223) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 2246822507) >>> 0;
  x ^= x >>> 13;
  return (x >>> 0) / 4294967296;
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Human-readable seed like "QR7-2MT-9KD". */
export function makeSeed(label: string, salt: number): Seed {
  const r = new Rng(`${label}:${salt >>> 0}`);
  let out = '';
  for (let g = 0; g < 3; g++) {
    if (g > 0) out += '-';
    for (let i = 0; i < 3; i++) out += ALPHABET[r.int(ALPHABET.length)];
  }
  return out;
}

/** Daily star lane seed: identical for every player on a given UTC day. */
export function dailySeed(date = new Date()): { seed: Seed; dayKey: string } {
  const key = `${date.getUTCFullYear()}-${date.getUTCMonth() + 1}-${date.getUTCDate()}`;
  const dayIndex = Math.floor(date.getTime() / 86400000);
  return { seed: makeSeed('DAILY', dayIndex), dayKey: key };
}

export function normalizeSeedInput(input: string): Seed {
  const cleaned = input.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
  if (cleaned.length === 0) return makeSeed('RUSH', 1);
  let out = '';
  for (let i = 0; i < cleaned.length; i++) {
    if (i > 0 && i % 3 === 0) out += '-';
    out += cleaned[i];
  }
  return out;
}
