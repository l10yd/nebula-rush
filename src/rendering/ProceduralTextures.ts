import { CanvasTexture, DataTexture, LinearFilter, LinearMipmapLinearFilter, NoColorSpace, RGBAFormat, RepeatWrapping, SRGBColorSpace, UnsignedByteType } from 'three';
import type { Texture } from 'three';
import { Rng } from '../core/rng.ts';

export interface PaletteSpec {
  deep: string;
  mid: string;
  accent: string;
  accentAlt: string;
  hot: string;
  danger: string;
}

/** Everything this module hands out, so a quality switch or a teardown can free the GPU. */
const registry = new Set<Texture>();

function track<T extends Texture>(texture: T): T {
  registry.add(texture);
  return texture;
}

function makeCanvas(w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');
  return { canvas, ctx };
}

function parseHex(hex: string): [number, number, number] {
  const v = parseInt(hex.replace('#', ''), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

/** Periodic value noise: tiles seamlessly along x, which is what an equirect map needs. */
function makeNoise(rng: Rng, lattice: number): { at: (x: number, y: number) => number } {
  const table = new Float32Array(lattice * lattice);
  for (let i = 0; i < table.length; i++) table[i] = rng.float();
  const smooth = (t: number) => t * t * (3 - 2 * t);
  return {
    at(x: number, y: number): number {
      const xi = Math.floor(x);
      const yi = Math.floor(y);
      const xf = x - xi;
      const yf = y - yi;
      const wrap = (v: number) => ((v % lattice) + lattice) % lattice;
      const x0 = wrap(xi);
      const x1 = wrap(xi + 1);
      const y0 = wrap(yi) * lattice;
      const y1 = wrap(yi + 1) * lattice;
      const a = table[x0 + y0];
      const b = table[x1 + y0];
      const c = table[x0 + y1];
      const d = table[x1 + y1];
      const u = smooth(xf);
      const v = smooth(yf);
      return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
    },
  };
}

function fbm(noise: { at: (x: number, y: number) => number }, x: number, y: number, octaves: number, lacunarity: number, gain: number): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let fx = x;
  let fy = y;
  for (let o = 0; o < octaves; o++) {
    sum += noise.at(fx, fy) * amp;
    norm += amp;
    amp *= gain;
    fx *= lacunarity;
    fy *= lacunarity;
  }
  return norm > 0 ? sum / norm : 0;
}

/**
 * The backdrop: a 2:1 equirect nebula with dust lanes and starfield, generated once per biome
 * and pushed through PMREM to become the scene's environment lighting as well.
 */
export function nebulaEquirect(palette: PaletteSpec, size = 1024): HTMLCanvasElement {
  const w = size;
  const h = size >> 1;
  const { canvas, ctx } = makeCanvas(w, h);
  const rng = new Rng(`nebula-${palette.accent}-${size}`);
  const cloud = makeNoise(rng, 128);
  const warp = makeNoise(rng, 64);
  const fine = makeNoise(rng, 256);

  const deep = parseHex(palette.deep);
  const mid = parseHex(palette.mid);
  const accent = parseHex(palette.accent);
  const accentAlt = parseHex(palette.accentAlt);
  const hot = parseHex(palette.hot);

  const image = ctx.createImageData(w, h);
  const data = image.data;
  const scale = 6;
  for (let y = 0; y < h; y++) {
    // Compress noise toward the poles so the equirect stretch keeps cloud density even.
    const v = y / h;
    const pole = 0.35 + 0.65 * Math.sin(Math.PI * v);
    for (let x = 0; x < w; x++) {
      const u = x / w;
      const wx = u * scale + fbm(warp, u * 3, v * 3, 3, 2, 0.5) * 1.6;
      const wy = v * scale * 0.5 + fbm(warp, u * 3 + 11, v * 3 + 7, 3, 2, 0.5) * 1.2;
      let n = fbm(cloud, wx, wy, 5, 2.1, 0.55);
      n = Math.pow(Math.max(0, n * (0.65 + 0.35 * pole)), 1.35);
      const detail = fbm(fine, u * 26, v * 26, 3, 2, 0.5);
      const band = Math.pow(Math.max(0, 1 - Math.abs(v - 0.5) * 2.4), 2);
      const mixA = Math.min(1, n * 1.9);
      const mixB = Math.pow(Math.max(0, n - 0.42) * 1.9, 1.4);
      const mixC = Math.pow(Math.max(0, n - 0.66) * 3.1, 1.2) * (0.4 + 0.6 * detail);
      const i = (y * w + x) * 4;
      const shimmer = 0.86 + 0.14 * detail;
      data[i] = (deep[0] + (mid[0] - deep[0]) * mixA + (accent[0] - mid[0]) * mixB + (hot[0] - accent[0]) * mixC) * shimmer + band * 0.012;
      data[i + 1] = (deep[1] + (mid[1] - deep[1]) * mixA + (accentAlt[1] - mid[1]) * mixB + (hot[1] - accentAlt[1]) * mixC) * shimmer + band * 0.01;
      data[i + 2] = (deep[2] + (mid[2] - deep[2]) * mixA + (accentAlt[2] - mid[2]) * mixB + (hot[2] - accentAlt[2]) * mixC) * shimmer + band * 0.016;
      data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);

  // Stars: dense small field plus a handful of bright ones with a bloom halo.
  ctx.globalCompositeOperation = 'lighter';
  const starCount = Math.round(w * 0.9);
  for (let i = 0; i < starCount; i++) {
    const sx = rng.float() * w;
    const sy = Math.pow(rng.float(), 0.85) * h;
    const mag = rng.float();
    const r = 0.35 + mag * mag * 1.5;
    const a = 0.2 + mag * 0.75;
    const tint = rng.chance(0.16) ? palette.hot : rng.chance(0.3) ? palette.accentAlt : '#ffffff';
    ctx.fillStyle = tint;
    ctx.globalAlpha = a;
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.fill();
    if (mag > 0.93) {
      ctx.globalAlpha = a * 0.16;
      ctx.beginPath();
      ctx.arc(sx, sy, r * 5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  return canvas;
}

function spriteCanvas(size: number, paint: (ctx: CanvasRenderingContext2D, s: number) => void): HTMLCanvasElement {
  const { canvas, ctx } = makeCanvas(size, size);
  paint(ctx, size);
  return canvas;
}

export function starSprite(): Texture {
  const canvas = spriteCanvas(64, (ctx, s) => {
    const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.25, 'rgba(255,255,255,0.75)');
    g.addColorStop(0.6, 'rgba(190,220,255,0.18)');
    g.addColorStop(1, 'rgba(120,160,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
  });
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  return track(tex);
}

export function sparkSprite(): Texture {
  const canvas = spriteCanvas(64, (ctx, s) => {
    const g = ctx.createLinearGradient(0, s / 2, s, s / 2);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.5, 'rgba(255,255,255,1)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, s / 2 - 2, s, 4);
    const glow = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s * 0.4);
    glow.addColorStop(0, 'rgba(255,255,255,0.55)');
    glow.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, s, s);
  });
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  return track(tex);
}

export function ringSprite(): Texture {
  const canvas = spriteCanvas(128, (ctx, s) => {
    const c = s / 2;
    for (let i = 0; i < 3; i++) {
      const r = c * (0.55 + i * 0.16);
      ctx.strokeStyle = `rgba(255,255,255,${0.85 - i * 0.3})`;
      ctx.lineWidth = 3 - i;
      ctx.beginPath();
      ctx.arc(c, c, r, 0, Math.PI * 2);
      ctx.stroke();
    }
    const fade = ctx.createRadialGradient(c, c, c * 0.4, c, c, c);
    fade.addColorStop(0, 'rgba(255,255,255,0)');
    fade.addColorStop(0.72, 'rgba(255,255,255,0.12)');
    fade.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = fade;
    ctx.fillRect(0, 0, s, s);
  });
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  return track(tex);
}

/** Grey panel + seam + decal map for hulls. Multiplied by a material colour, so it stays neutral. */
export function hullPanelTexture(seed: number): Texture {
  const size = 512;
  const { canvas, ctx } = makeCanvas(size, size);
  const rng = new Rng(seed >>> 0);
  ctx.fillStyle = '#b9bfc9';
  ctx.fillRect(0, 0, size, size);

  const cells = 4;
  const cell = size / cells;
  for (let cy = 0; cy < cells; cy++) {
    for (let cx = 0; cx < cells; cx++) {
      const shade = 0.72 + rng.float() * 0.3;
      ctx.fillStyle = `rgba(${Math.round(255 * shade)},${Math.round(255 * shade)},${Math.round(256 * shade)},0.85)`;
      const pad = 3 + rng.intRange(0,4);
      ctx.fillRect(cx * cell + pad, cy * cell + pad, cell - pad * 2, cell - pad * 2);
    }
  }
  ctx.strokeStyle = 'rgba(24,28,36,0.55)';
  ctx.lineWidth = 2;
  for (let i = 0; i <= cells; i++) {
    ctx.beginPath();
    ctx.moveTo(i * cell, 0);
    ctx.lineTo(i * cell, size);
    ctx.moveTo(0, i * cell);
    ctx.lineTo(size, i * cell);
    ctx.stroke();
  }
  for (let i = 0; i < 90; i++) {
    const x = rng.float() * size;
    const y = rng.float() * size;
    ctx.fillStyle = rng.chance(0.5) ? 'rgba(20,24,32,0.35)' : 'rgba(250,252,255,0.28)';
    ctx.fillRect(x, y, rng.intRange(2,16), rng.intRange(1,3));
  }
  for (let i = 0; i < 14; i++) {
    const x = rng.float() * size;
    const y = rng.float() * size;
    const w = rng.range(16, 60);
    ctx.fillStyle = rng.chance(0.4) ? 'rgba(255,196,92,0.5)' : 'rgba(150,170,200,0.5)';
    ctx.fillRect(x, y, w, 2);
  }
  const tex = new CanvasTexture(canvas);
  tex.wrapS = RepeatWrapping;
  tex.wrapT = RepeatWrapping;
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 4;
  return track(tex);
}

export function rockTexture(seed: number, color = '#8a7f78'): Texture {
  const size = 256;
  const { canvas, ctx } = makeCanvas(size, size);
  const rng = new Rng(seed >>> 0);
  const base = parseHex(color);
  const noise = makeNoise(rng, 64);
  const image = ctx.createImageData(size, size);
  const data = image.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = fbm(noise, (x / size) * 8, (y / size) * 8, 5, 2.2, 0.5);
      const craters = Math.pow(Math.max(0, fbm(noise, (x / size) * 18 + 4, (y / size) * 18 + 9, 3, 2, 0.5) - 0.55) * 2.4, 2);
      const k = 0.45 + n * 0.85 - craters * 0.5;
      const i = (y * size + x) * 4;
      data[i] = Math.min(255, base[0] * 255 * k);
      data[i + 1] = Math.min(255, base[1] * 255 * k);
      data[i + 2] = Math.min(255, base[2] * 255 * k);
      data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  const tex = new CanvasTexture(canvas);
  tex.wrapS = RepeatWrapping;
  tex.wrapT = RepeatWrapping;
  tex.colorSpace = SRGBColorSpace;
  return track(tex);
}

/** Tileable RGBA8 value noise in linear space: roughness, crack masks and shader detail. */
export function noiseTexture(size = 256): Texture {
  const rng = new Rng(0x51ed);
  const a = makeNoise(rng, 64);
  const b = makeNoise(rng, 128);
  const c = makeNoise(rng, 32);
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x / size) * 8;
      const v = (y / size) * 8;
      const i = (y * size + x) * 4;
      data[i] = Math.round(fbm(a, u, v, 4, 2, 0.5) * 255);
      data[i + 1] = Math.round(fbm(b, u, v, 4, 2, 0.5) * 255);
      data[i + 2] = Math.round(fbm(c, u, v, 4, 2, 0.5) * 255);
      data[i + 3] = Math.round(((data[i] + data[i + 1] + data[i + 2]) / 3) * 0.5 + 128);
    }
  }
  const tex = new DataTexture(data, size, size, RGBAFormat, UnsignedByteType);
  tex.wrapS = RepeatWrapping;
  tex.wrapT = RepeatWrapping;
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.colorSpace = NoColorSpace;
  tex.needsUpdate = true;
  return track(tex);
}

/** 256×1 ramp used by the tunnel shader to colour instability without branching. */
export function gradientRamp(stops: [number, string][]): Texture {
  const data = new Uint8Array(256 * 4);
  const sorted = [...stops].sort((p, q) => p[0] - q[0]);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let lo = sorted[0];
    let hi = sorted[sorted.length - 1];
    for (let s = 0; s < sorted.length - 1; s++) {
      if (t >= sorted[s][0] && t <= sorted[s + 1][0]) {
        lo = sorted[s];
        hi = sorted[s + 1];
        break;
      }
    }
    const span = Math.max(1e-5, hi[0] - lo[0]);
    const k = Math.min(1, Math.max(0, (t - lo[0]) / span));
    const a = parseHex(lo[1]);
    const b = parseHex(hi[1]);
    data[i * 4] = Math.round((a[0] + (b[0] - a[0]) * k) * 255);
    data[i * 4 + 1] = Math.round((a[1] + (b[1] - a[1]) * k) * 255);
    data[i * 4 + 2] = Math.round((a[2] + (b[2] - a[2]) * k) * 255);
    data[i * 4 + 3] = 255;
  }
  const tex = new DataTexture(data, 256, 1);
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearFilter;
  tex.colorSpace = SRGBColorSpace;
  tex.needsUpdate = true;
  return track(tex);
}

export function disposeTextures(): void {
  for (const tex of registry) tex.dispose();
  registry.clear();
}
