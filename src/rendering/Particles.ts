import {
  AdditiveBlending,
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  Points,
  ShaderMaterial,
  Vector3,
} from 'three';
import type { Texture } from 'three';
import { LANE } from '../data/config.ts';
import type { FxQueue, FxRequest } from '../game/FxQueue.ts';
import type { LanePath } from '../game/LanePath.ts';
import { sparkSprite } from './ProceduralTextures.ts';

export interface ParticlePalette {
  accent: Color;
  accentAlt: Color;
  hot: Color;
  danger: Color;
  white: Color;
}

export interface ParticleSpawnOptions {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  size: number;
  /** Index into the palette: 0 accent, 1 accentAlt, 2 hot, 3 danger, 4 white. */
  colorIndex: number;
  /** Velocity damping per second. */
  drag?: number;
  /** Downward acceleration; negative floats the particle upward. */
  gravity?: number;
  /** Size multiplier applied per second (1 = constant, >1 = expanding). */
  growth?: number;
}

const VERT = /* glsl */ `
precision highp float;

attribute float aLife;      // seconds remaining; <= 0 marks a free slot
attribute float aMaxLife;
attribute float aSize;
attribute float aColor;

uniform float uPixelRatio;
uniform float uSizeScale;

varying float vAlpha;
varying float vColor;
varying float vAge;

void main() {
  float t = aMaxLife > 0.0 ? clamp(1.0 - aLife / aMaxLife, 0.0, 1.0) : 1.0;
  // Quick fade-in then a long square-ish tail: sparks never pop, debris never blinks out.
  vAlpha = aLife > 0.0 ? smoothstep(0.0, 0.07, t) * (1.0 - t * t) : 0.0;
  vColor = aColor;
  vAge = t;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * uSizeScale * uPixelRatio * (300.0 / max(1.0, -mv.z));
  gl_Position = projectionMatrix * mv;
}
`;

const FRAG = /* glsl */ `
precision highp float;

uniform sampler2D uSprite;
uniform vec3 uC0;
uniform vec3 uC1;
uniform vec3 uC2;
uniform vec3 uC3;
uniform vec3 uC4;

varying float vAlpha;
varying float vColor;
varying float vAge;

vec3 palette() {
  if (vColor > 3.5) return uC4;
  if (vColor > 2.5) return uC3;
  if (vColor > 1.5) return uC2;
  if (vColor > 0.5) return uC1;
  return uC0;
}

void main() {
  if (vAlpha <= 0.001) discard;
  vec4 sprite = texture2D(uSprite, gl_PointCoord);
  float a = sprite.a * vAlpha;
  if (a <= 0.004) discard;
  // Young particles carry a white-hot core, then cool into their palette colour.
  vec3 col = mix(mix(palette(), vec3(1.0), 0.6), palette(), smoothstep(0.0, 0.35, vAge));
  gl_FragColor = vec4(col * a, a);
}
`;

/** Anything beyond this distance from the camera is invisible; drop those slots early. */
const CULL_DISTANCE = 700;

/**
 * A pooled particle cloud rendered as one `Points` draw call.
 *
 * Slots come from a stack-based free list so spawning is O(1) and no scanning happens per
 * frame. The whole system is visual-only: it reads nothing that the simulation depends on,
 * so pausing, restarting or dropping a frame can never change a race.
 */
export class ParticleSystem {
  readonly points: Points;
  readonly capacity: number;
  private readonly geometry = new BufferGeometry();
  private readonly material: ShaderMaterial;
  private readonly position: Float32Array;
  private readonly velocity: Float32Array;
  private readonly life: Float32Array;
  private readonly maxLife: Float32Array;
  private readonly size: Float32Array;
  private readonly color: Float32Array;
  private readonly drag: Float32Array;
  private readonly gravity: Float32Array;
  private readonly growth: Float32Array;
  private readonly free: Int32Array;
  private freeCount = 0;
  private live = 0;
  private readonly attributes: Float32BufferAttribute[] = [];

  constructor(capacity: number, palette: ParticlePalette) {
    const n = Math.max(64, Math.floor(capacity));
    this.capacity = n;
    this.position = new Float32Array(n * 3);
    this.velocity = new Float32Array(n * 3);
    this.life = new Float32Array(n);
    this.maxLife = new Float32Array(n);
    this.size = new Float32Array(n);
    this.color = new Float32Array(n);
    this.drag = new Float32Array(n);
    this.gravity = new Float32Array(n);
    this.growth = new Float32Array(n);
    this.free = new Int32Array(n);
    for (let i = 0; i < n; i++) this.free[i] = n - 1 - i;
    this.freeCount = n;

    const attrs = [
      ['position', this.position, 3],
      ['aLife', this.life, 1],
      ['aMaxLife', this.maxLife, 1],
      ['aSize', this.size, 1],
      ['aColor', this.color, 1],
    ] as const;
    for (const [name, array, itemSize] of attrs) {
      const attr = new Float32BufferAttribute(array, itemSize);
      attr.setUsage(35048); // DynamicDrawUsage
      this.geometry.setAttribute(name, attr);
      this.attributes.push(attr);
    }
    // The cloud spans the whole visible corridor, so bounds-based culling only wastes time.
    this.geometry.boundingSphere = null;

    this.material = new ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      uniforms: {
        uSprite: { value: sparkSprite() },
        uPixelRatio: { value: 1 },
        uSizeScale: { value: 1 },
        uC0: { value: palette.accent },
        uC1: { value: palette.accentAlt },
        uC2: { value: palette.hot },
        uC3: { value: palette.danger },
        uC4: { value: palette.white },
      },
    });
    this.material.toneMapped = false;
    this.points = new Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.points.name = 'particles';
  }

  get liveCount(): number {
    return this.live;
  }

  setPixelRatio(ratio: number): void {
    this.material.uniforms.uPixelRatio.value = ratio;
  }

  /** Global size multiplier so lower quality tiers draw smaller, cheaper sprites. */
  setSizeScale(scale: number): void {
    this.material.uniforms.uSizeScale.value = scale;
  }

  /** Returns false when the pool is saturated, which is how callers budget their bursts. */
  spawn(o: ParticleSpawnOptions): boolean {
    if (this.freeCount <= 0) return false;
    const i = this.free[--this.freeCount];
    const i3 = i * 3;
    this.position[i3] = o.x;
    this.position[i3 + 1] = o.y;
    this.position[i3 + 2] = o.z;
    this.velocity[i3] = o.vx;
    this.velocity[i3 + 1] = o.vy;
    this.velocity[i3 + 2] = o.vz;
    const life = Math.max(0.05, o.life);
    this.life[i] = life;
    this.maxLife[i] = life;
    this.size[i] = Math.max(0.02, o.size);
    this.color[i] = o.colorIndex;
    this.drag[i] = o.drag ?? 1.6;
    this.gravity[i] = o.gravity ?? 0;
    this.growth[i] = o.growth ?? 1;
    this.live++;
    return true;
  }

  update(dt: number, camera: { position: Vector3 }): void {
    if (this.live === 0) return;
    const step = Math.min(dt, 1 / 30);
    const cx = camera.position.x;
    const cy = camera.position.y;
    const cz = camera.position.z;
    const cullSq = CULL_DISTANCE * CULL_DISTANCE;
    for (let i = 0; i < this.life.length; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= step;
      const i3 = i * 3;
      if (this.life[i] <= 0) {
        this.life[i] = 0;
        this.free[this.freeCount++] = i;
        this.live--;
        continue;
      }
      const damp = Math.max(0, 1 - this.drag[i] * step);
      let vx = this.velocity[i3] * damp;
      let vy = this.velocity[i3 + 1] * damp - this.gravity[i] * step;
      let vz = this.velocity[i3 + 2] * damp;
      let px = this.position[i3] + vx * step;
      let py = this.position[i3 + 1] + vy * step;
      let pz = this.position[i3 + 2] + vz * step;
      const dx = px - cx;
      const dy = py - cy;
      const dz = pz - cz;
      if (dx * dx + dy * dy + dz * dz > cullSq) {
        this.life[i] = 0;
        this.free[this.freeCount++] = i;
        this.live--;
        continue;
      }
      this.velocity[i3] = vx;
      this.velocity[i3 + 1] = vy;
      this.velocity[i3 + 2] = vz;
      this.position[i3] = px;
      this.position[i3 + 1] = py;
      this.position[i3 + 2] = pz;
      const g = this.growth[i];
      if (g !== 1) this.size[i] *= 1 + (g - 1) * step;
    }
    for (const attr of this.attributes) attr.needsUpdate = true;
  }

  reset(): void {
    this.life.fill(0);
    this.live = 0;
    for (let i = 0; i < this.capacity; i++) this.free[i] = this.capacity - 1 - i;
    this.freeCount = this.capacity;
    for (const attr of this.attributes) attr.needsUpdate = true;
  }

  dispose(): void {
    (this.material.uniforms.uSprite.value as Texture).dispose();
    this.material.dispose();
    this.geometry.dispose();
  }
}

interface KindProfile {
  count: number;
  life: number;
  size: number;
  speed: number;
  spread: number;
  drag: number;
  gravity: number;
  growth: number;
  color: number;
}

/** Per-FxKind tuning. `text` is intentionally weightless: the HUD draws numbers, not particles. */
const KIND: Record<string, KindProfile> = {
  spark: { count: 10, life: 0.42, size: 0.45, speed: 26, spread: 0.5, drag: 3.2, gravity: 0, growth: 0.5, color: 4 },
  burst: { count: 22, life: 0.6, size: 0.65, speed: 34, spread: 0.9, drag: 2.6, gravity: 2, growth: 0.7, color: 0 },
  ring: { count: 26, life: 0.45, size: 0.5, speed: 30, spread: 1.1, drag: 2.2, gravity: 0, growth: 1.9, color: 0 },
  debris: { count: 16, life: 1.1, size: 0.85, speed: 22, spread: 1.3, drag: 1.1, gravity: 9, growth: 0.85, color: 3 },
  pickup: { count: 14, life: 0.55, size: 0.5, speed: 16, spread: 0.7, drag: 2.8, gravity: -2, growth: 1.2, color: 2 },
  explosion: { count: 34, life: 0.85, size: 1.35, speed: 46, spread: 1.9, drag: 1.8, gravity: 3, growth: 1.6, color: 3 },
  collapseFrag: { count: 26, life: 1.4, size: 1.1, speed: 18, spread: 2.8, drag: 0.9, gravity: 12, growth: 0.9, color: 1 },
  shock: { count: 40, life: 0.9, size: 1, speed: 60, spread: 3.6, drag: 1.4, gravity: 0, growth: 1.5, color: 2 },
  warp: { count: 30, life: 0.7, size: 0.8, speed: 90, spread: 5, drag: 0.6, gravity: 0, growth: 1.1, color: 0 },
  dust: { count: 8, life: 0.9, size: 1.3, speed: 6, spread: 1.8, drag: 2.4, gravity: -0.5, growth: 1.3, color: 1 },
  trailPuff: { count: 3, life: 0.35, size: 0.55, speed: 8, spread: 0.35, drag: 3.4, gravity: 0, growth: 1.4, color: 0 },
  shieldHit: { count: 18, life: 0.5, size: 0.75, speed: 24, spread: 1.5, drag: 2.4, gravity: 0, growth: 1.6, color: 1 },
  gateFlash: { count: 20, life: 0.5, size: 0.7, speed: 30, spread: 2.2, drag: 2.6, gravity: 0, growth: 1.5, color: 2 },
  text: { count: 0, life: 0, size: 0, speed: 0, spread: 0, drag: 1, gravity: 0, growth: 1, color: 4 },
};

/**
 * The single translation point between the simulation and the screen: it drains the runtime's
 * FX queue and turns each request into pooled particles. Effects live in lane space (`s`,`u`,`h`)
 * whenever they can, so they stay welded to the corridor as it curves and banks.
 */
export class FxDispatcher {
  private readonly world = new Vector3();
  private readonly request: ParticleSpawnOptions = {
    x: 0,
    y: 0,
    z: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    life: 1,
    size: 1,
    colorIndex: 0,
  };

  constructor(private readonly particles: ParticleSystem, private readonly path: LanePath) {}

  /** @param budget 0..1 global effect multiplier from the quality manager */
  dispatch(queue: FxQueue, budget: number, cameraPosition: Vector3): void {
    if (queue.pending === 0) return;
    queue.drain((fx: FxRequest) => this.emit(fx, budget, cameraPosition));
  }

  private emit(fx: FxRequest, budget: number, cameraPosition: Vector3): void {
    const profile = KIND[fx.kind] ?? KIND.spark;
    const count = Math.round(profile.count * budget * (0.5 + fx.power * 0.9));
    if (count <= 0) return;

    const laneAnchored = Number.isFinite(fx.s) && fx.s !== 0;
    const world = laneAnchored
      ? this.path.pointTo(fx.s, fx.u ?? 0, fx.h ?? LANE.hoverBase, this.world)
      : this.world.set(fx.x, fx.y, fx.z);

    const dx = world.x - cameraPosition.x;
    const dy = world.y - cameraPosition.y;
    const dz = world.z - cameraPosition.z;
    if (dx * dx + dy * dy + dz * dz > CULL_DISTANCE * CULL_DISTANCE) return;

    const o = this.request;
    o.life = profile.life;
    o.size = profile.size * Math.max(0.25, fx.size);
    o.colorIndex = fx.color >= 0 ? fx.color : profile.color;
    o.drag = profile.drag;
    o.gravity = profile.gravity;
    o.growth = profile.growth;

    for (let i = 0; i < count; i++) {
      // Golden-angle spiral with a deterministic pseudo-random radius: even coverage,
      // no Math.random, so a replay of the same race sprays the same way.
      const a = i * 2.39996323 + fx.s * 0.013;
      const u = 1 - (i / Math.max(1, count - 1)) * 2;
      const ring = Math.sqrt(Math.max(0, 1 - u * u));
      const jitter = 0.55 + (((i * 7919) % 97) / 97) * 0.65;
      const speed = profile.speed * Math.max(0.15, fx.power) * jitter;
      o.x = world.x + Math.cos(a) * ring * profile.spread;
      o.y = world.y + u * profile.spread;
      o.z = world.z + Math.sin(a) * ring * profile.spread;
      o.vx = Math.cos(a) * ring * speed + fx.vx;
      o.vy = u * speed + fx.vy;
      o.vz = Math.sin(a) * ring * speed + fx.vz;
      if (!this.particles.spawn(o)) break;
    }
  }
}
