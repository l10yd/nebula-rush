/**
 * Platform capability detection and safe access to browser facilities.
 * Everything here must degrade quietly — the game has to run (possibly at lower fidelity)
 * on any browser rather than crash.
 */

export interface Capabilities {
  webgl2: boolean;
  webgl: boolean;
  webgpu: boolean;
  renderer: 'webgl2' | 'webgl' | 'none';
  floatTextures: boolean;
  halfFloatLinear: boolean;
  maxTextureSize: number;
  maxUnifiedBlocks: number;
  touch: boolean;
  coarsePointer: boolean;
  gamepad: boolean;
  devicePixelRatio: number;
  cores: number;
  memoryGB: number;
  prefersReducedMotion: boolean;
  prefersHighContrast: boolean;
  localeGuess: 'en' | 'ru';
  secureContext: boolean;
  offscreenCanvas: boolean;
  storage: boolean;
  powerHint: string;
  tier: 'high' | 'medium' | 'low';
  gpuName: string;
}

function probeWebgl(): { webgl2: boolean; webgl: boolean; maxTextureSize: number; floatTextures: boolean; halfFloatLinear: boolean; gpuName: string } {
  const result = {
    webgl2: false,
    webgl: false,
    maxTextureSize: 4096,
    floatTextures: false,
    halfFloatLinear: false,
    gpuName: 'unknown',
  };
  try {
    const canvas = document.createElement('canvas');
    const gl2 = canvas.getContext('webgl2', { failIfMajorPerformanceCaveat: false });
    if (gl2) {
      result.webgl2 = true;
      result.floatTextures = !!gl2.getExtension('OES_texture_float');
      result.halfFloatLinear = !!gl2.getExtension('OES_texture_float_linear');
      result.maxTextureSize = gl2.getParameter(gl2.MAX_TEXTURE_SIZE) as number;
      const dbg = gl2.getExtension('WEBGL_debug_renderer_info');
      if (dbg) result.gpuName = String(gl2.getParameter(dbg.UNMASKED_RENDERER_WEBGL) ?? 'unknown');
      gl2.getExtension('WEBGL_lose_context')?.loseContext();
    } else {
      const gl1 = canvas.getContext('webgl') ?? canvas.getContext('experimental-webgl');
      if (gl1) {
        const ctx = gl1 as WebGLRenderingContext;
        result.webgl = true;
        result.floatTextures = !!ctx.getExtension('OES_texture_float');
        result.halfFloatLinear = !!ctx.getExtension('OES_texture_float_linear');
        result.maxTextureSize = ctx.getParameter(ctx.MAX_TEXTURE_SIZE) as number;
        ctx.getExtension('WEBGL_lose_context')?.loseContext();
      }
    }
  } catch {
    /* Feature probing must never break boot. */
  }
  return result;
}

function classifyTier(c: { webgl2: boolean; cores: number; memoryGB: number; dpr: number; coarse: boolean; gpuName: string }): 'high' | 'medium' | 'low' {
  const name = c.gpuName.toLowerCase();
  const soft = /swiftshader|llvmpipe|software|microsoft basic|angle \(generic/.test(name);
  if (!c.webgl2 || soft) return 'low';
  if (c.cores >= 8 && (c.memoryGB === 0 || c.memoryGB >= 4) && !/intel\(r\) UHD Graphics 6[0-3]0| UHD 620/.test(c.gpuName)) return 'high';
  if (c.cores >= 4 && !c.coarse) return 'medium';
  return 'low';
}

export function detectCapabilities(): Capabilities {
  const gl = probeWebgl();
  const nav = navigator as Navigator & { deviceMemory?: number };
  const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  const touch = coarse || ('ontouchstart' in window) || (nav.maxTouchPoints ?? 0) > 0;
  const memoryGB = typeof nav.deviceMemory === 'number' ? nav.deviceMemory : 0;
  const cores = Math.max(1, nav.hardwareConcurrency ?? 4);
  const locale = (nav.language || 'en').toLowerCase();
  const caps: Capabilities = {
    webgl2: gl.webgl2,
    webgl: gl.webgl || gl.webgl2,
    webgpu: 'gpu' in navigator,
    renderer: gl.webgl2 ? 'webgl2' : gl.webgl ? 'webgl' : 'none',
    floatTextures: gl.floatTextures,
    halfFloatLinear: gl.halfFloatLinear,
    maxTextureSize: gl.maxTextureSize,
    maxUnifiedBlocks: 12,
    touch,
    coarsePointer: coarse,
    gamepad: 'getGamepads' in navigator,
    devicePixelRatio: dpr,
    cores,
    memoryGB,
    prefersReducedMotion: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
    prefersHighContrast: window.matchMedia?.('(prefers-contrast: more)').matches ?? false,
    localeGuess: locale.startsWith('ru') || locale.startsWith('uk') || locale.startsWith('be') || locale.startsWith('kk') ? 'ru' : 'en',
    secureContext: window.isSecureContext !== false,
    offscreenCanvas: 'OffscreenCanvas' in window,
    storage: probeStorage(),
    powerHint: cores >= 8 ? 'high-performance' : 'default',
    tier: 'medium',
    gpuName: gl.gpuName,
  };
  caps.tier = classifyTier({ webgl2: caps.webgl2, cores, memoryGB, dpr, coarse, gpuName: gl.gpuName });
  return caps;
}

function probeStorage(): boolean {
  try {
    const k = '__nebula_probe__';
    window.localStorage.setItem(k, '1');
    window.localStorage.removeItem(k);
    return true;
  } catch {
    return false;
  }
}

/** localStorage that silently falls back to memory when blocked (private mode, disabled, etc.). */
export class SafeStorage {
  private readonly memory = new Map<string, string>();
  readonly available: boolean;

  constructor(private readonly prefix: string) {
    this.available = probeStorage();
  }

  read(key: string): string | null {
    const full = this.prefix + key;
    if (!this.available) return this.memory.get(full) ?? null;
    try {
      return window.localStorage.getItem(full);
    } catch {
      return this.memory.get(full) ?? null;
    }
  }

  write(key: string, value: string): boolean {
    const full = this.prefix + key;
    this.memory.set(full, value);
    if (!this.available) return false;
    try {
      window.localStorage.setItem(full, value);
      return true;
    } catch {
      return false;
    }
  }

  remove(key: string): void {
    const full = this.prefix + key;
    this.memory.delete(full);
    try {
      if (this.available) window.localStorage.removeItem(full);
    } catch {
      /* ignore */
    }
  }
}

export async function requestFullscreen(el: HTMLElement): Promise<boolean> {
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
      return false;
    }
    await el.requestFullscreen({ navigationUI: 'hide' });
    return true;
  } catch {
    return false;
  }
}

export function onVisibility(cb: (hidden: boolean) => void): () => void {
  const handler = () => cb(document.hidden);
  document.addEventListener('visibilitychange', handler);
  return () => document.removeEventListener('visibilitychange', handler);
}

export function onResize(cb: (w: number, h: number) => void): () => void {
  let raf = 0;
  const handler = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => cb(window.innerWidth, window.innerHeight));
  };
  window.addEventListener('resize', handler);
  window.addEventListener('orientationchange', handler);
  return () => {
    cancelAnimationFrame(raf);
    window.removeEventListener('resize', handler);
    window.removeEventListener('orientationchange', handler);
  };
}
