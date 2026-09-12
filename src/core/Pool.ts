/**
 * Object pooling. Pools are pre-sized and never grow beyond `max`; when exhausted the
 * oldest live object is recycled instead of allocating — this keeps the frame loop GC-free.
 */

export interface Poolable {
  live: boolean;
}

export class Pool<T> {
  private free: T[] = [];
  readonly live: T[] = [];

  constructor(
    factory: () => T,
    private readonly reset: (item: T) => void,
    private readonly onRelease: ((item: T) => void) | undefined,
    readonly max: number,
  ) {
    for (let i = 0; i < max; i++) this.free.push(factory());
  }

  get freeCount(): number {
    return this.free.length;
  }

  obtain(): T | null {
    let item = this.free.pop();
    if (!item) {
      if (this.live.length === 0) return null;
      item = this.live[0];
      this.release(item);
      item = this.free.pop();
      if (!item) return null;
    }
    this.reset(item);
    this.live.push(item);
    return item;
  }

  release(item: T): void {
    const idx = this.live.indexOf(item);
    if (idx < 0) return;
    this.live.splice(idx, 1);
    this.onRelease?.(item);
    this.free.push(item);
  }

  releaseAll(): void {
    while (this.live.length) {
      const item = this.live.pop() as T;
      this.onRelease?.(item);
      this.free.push(item);
    }
  }
}

/** A struct-of-ish typed pool used by the particle system: fixed slots + free list. */
export class SlotPool {
  readonly freeList: Int32Array;
  private top = 0;
  count = 0;

  constructor(readonly capacity: number) {
    this.freeList = new Int32Array(capacity);
    for (let i = capacity - 1; i >= 0; i--) this.freeList[this.top++] = i;
  }

  reset(): void {
    this.top = this.capacity;
    this.count = 0;
    for (let i = this.capacity - 1; i >= 0; i--) this.freeList[i] = i;
  }

  obtain(): number {
    if (this.top === 0) return -1;
    this.top--;
    this.count++;
    return this.freeList[this.top];
  }

  release(slot: number): void {
    if (slot < 0 || this.top >= this.capacity) return;
    this.freeList[this.top++] = slot;
    this.count--;
  }
}
