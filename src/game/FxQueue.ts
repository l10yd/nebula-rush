/**
 * Fixed-capacity ring buffer of visual-effect requests produced by the simulation and
 * consumed by the particle system. Pre-allocated: gameplay never allocates per frame.
 */

export type FxKind =
  | 'spark'
  | 'burst'
  | 'ring'
  | 'debris'
  | 'pickup'
  | 'explosion'
  | 'collapseFrag'
  | 'shock'
  | 'warp'
  | 'dust'
  | 'trailPuff'
  | 'shieldHit'
  | 'gateFlash'
  | 'text';

export interface FxRequest {
  kind: FxKind;
  /** World-space anchor. */
  x: number;
  y: number;
  z: number;
  /** Direction/velocity hint. */
  vx: number;
  vy: number;
  vz: number;
  /** Scale in metres. */
  size: number;
  /** Colour index into the palette LUT (0 accent, 1 accentAlt, 2 hot, 3 danger, 4 white). */
  color: number;
  /** Intensity 0..1. */
  power: number;
  /** Lane distance, for effects that must follow the corridor. */
  s: number;
  u: number;
  h: number;
  life: number;
}

function blank(): FxRequest {
  return { kind: 'spark', x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, size: 1, color: 0, power: 1, s: 0, u: 0, h: 0, life: 1 };
}

export class FxQueue {
  private readonly slots: FxRequest[] = [];
  private head = 0;
  private tail = 0;
  private count = 0;
  dropped = 0;

  constructor(readonly capacity = 256) {
    for (let i = 0; i < capacity; i++) this.slots.push(blank());
  }

  /** Writes a request into a reused slot. Returns false when the queue overflowed. */
  emit(kind: FxKind, x: number, y: number, z: number, opts?: Partial<FxRequest>): boolean {
    if (this.count === this.capacity) {
      // Overwrite the oldest request rather than stalling gameplay.
      this.tail = (this.tail + 1) % this.capacity;
      this.count--;
      this.dropped++;
    }
    const slot = this.slots[this.head];
    slot.kind = kind;
    slot.x = x;
    slot.y = y;
    slot.z = z;
    slot.vx = opts?.vx ?? 0;
    slot.vy = opts?.vy ?? 0;
    slot.vz = opts?.vz ?? 0;
    slot.size = opts?.size ?? 1;
    slot.color = opts?.color ?? 0;
    slot.power = opts?.power ?? 1;
    slot.s = opts?.s ?? 0;
    slot.u = opts?.u ?? 0;
    slot.h = opts?.h ?? 0;
    slot.life = opts?.life ?? 1;
    this.head = (this.head + 1) % this.capacity;
    this.count++;
    return true;
  }

  /** Drains the queue in order. The consumer must not retain the returned slot. */
  drain(consume: (fx: FxRequest) => void): void {
    while (this.count > 0) {
      consume(this.slots[this.tail]);
      this.tail = (this.tail + 1) % this.capacity;
      this.count--;
    }
  }

  get pending(): number {
    return this.count;
  }

  clear(): void {
    this.head = 0;
    this.tail = 0;
    this.count = 0;
  }
}
