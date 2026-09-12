import { Color, HalfFloatType, Vector2 } from 'three';
import type { Texture, WebGLRenderer } from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import type { Scene, Camera } from 'three';

/**
 * Final grade: the single pass that decides how the whole picture reads, so every knob that
 * could hurt legibility is deliberately bounded and wired to a setting.
 */
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null as Texture | null },
    uTime: { value: 0 },
    uAberration: { value: 0 },
    uVignette: { value: 0.42 },
    uGrain: { value: 0.03 },
    uWarp: { value: 0 },
    uHit: { value: 0 },
    uDanger: { value: 0 },
    uBoost: { value: 0 },
    uDesaturate: { value: 0 },
    uExposure: { value: 1.0 },
    uScanline: { value: 0 },
    uResolution: { value: new Vector2(1, 1) },
    uFlash: { value: new Vector2(0, 0) },
    uHurtColor: { value: new Color('#ff4d5e') },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    precision highp float;

    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uAberration;
    uniform float uVignette;
    uniform float uGrain;
    uniform float uWarp;
    uniform float uHit;
    uniform float uDanger;
    uniform float uBoost;
    uniform float uDesaturate;
    uniform float uExposure;
    uniform float uScanline;
    uniform vec2 uResolution;
    uniform vec2 uFlash;
    uniform vec3 uHurtColor;

    varying vec2 vUv;

    float hash12(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }

    void main() {
      vec2 uv = vUv;
      vec2 fromCentre = uv - 0.5;
      float radius = length(fromCentre);

      // Radial chromatic aberration: strong at the rim, zero on the racing line, so the
      // centre of the frame — where all the reading happens — always stays sharp.
      vec2 dir = fromCentre / max(radius, 1e-5);
      float ab = uAberration * (0.25 + radius * radius * 1.6);
      vec2 offset = dir * ab * 0.012;
      vec3 col;
      col.r = texture2D(tDiffuse, uv + offset).r;
      col.g = texture2D(tDiffuse, uv).g;
      col.b = texture2D(tDiffuse, uv - offset).b;

      // Warp streaks: a cheap radial blur sampled toward the vanishing point during a
      // wormhole, instead of a real multi-tap blur.
      if (uWarp > 0.001) {
        vec3 acc = col;
        float w = 0.0;
        for (int i = 1; i <= 6; i++) {
          float k = float(i) / 6.0;
          vec2 s = uv - dir * k * uWarp * 0.055;
          acc += texture2D(tDiffuse, s).rgb * (1.0 - k * 0.6);
          w += 1.0 - k * 0.6;
        }
        col = mix(col, acc / max(w, 1e-4), clamp(uWarp, 0.0, 1.0));
      }

      float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(col, vec3(luma), clamp(uDesaturate, 0.0, 1.0) * 0.8);

      col *= uExposure;
      // Boost pushes the highlights warm; danger pulls the rim toward the warning hue.
      col += uBoost * vec3(0.06, 0.09, 0.14) * (0.4 + radius);
      col = mix(col, col * vec3(1.25, 0.65, 0.62), uDanger * (0.12 + radius * 0.5));

      // Screen-edge hit flash, anchored away from the centre so it never masks the road.
      float edge = smoothstep(0.25, 0.72, radius);
      col = mix(col, uHurtColor, uHit * edge * 0.55);
      col += vec3(uFlash.x, uFlash.x * 0.6 + uFlash.y * 0.4, uFlash.y) * (0.5 + 0.5 * sin(uTime * 40.0)) * edge;

      float vig = 1.0 - uVignette * smoothstep(0.42, 1.05, radius * 1.25);
      col *= vig;

      if (uScanline > 0.001) {
        float sl = 0.97 + 0.03 * sin(uv.y * uResolution.y * 1.6);
        col *= mix(1.0, sl, uScanline);
      }

      float grain = hash12(uv * uResolution + vec2(uTime * 37.0, uTime * 11.0));
      col += (grain - 0.5) * uGrain;

      gl_FragColor = vec4(max(col, vec3(0.0)), 1.0);
    }
  `,
};

export interface GradeState {
  time: number;
  /** 0..1 speed-above-cruise, drives aberration. */
  aberration: number;
  boost: number;
  warp: number;
  /** 0..1 impact flash. */
  hit: number;
  /** 0..1 how close the collapsing section is. */
  danger: number;
  desaturate: number;
  flashX: number;
  flashY: number;
}

/**
 * Owns the composer: scene → bloom → grade → output.
 *
 * Bloom is the whole look (every strip, gate and spark is emissive), but it is the first
 * thing a weak GPU must lose, so it is a real toggle rather than a strength of zero.
 */
export class PostFX {
  private readonly composer: EffectComposer;
  private readonly renderPass: RenderPass;
  private bloom: UnrealBloomPass | null;
  private readonly grade: ShaderPass;
  private readonly output: OutputPass;
  private width: number;
  private height: number;

  constructor(
    renderer: WebGLRenderer,
    scene: Scene,
    camera: Camera,
    opts: { bloom: boolean; strength: number; radius: number; threshold: number; aberration: boolean; resolutionScale: number },
  ) {
    const size = renderer.getDrawingBufferSize(new Vector2());
    const width = Math.max(2, Math.floor(size.x * opts.resolutionScale));
    const height = Math.max(2, Math.floor(size.y * opts.resolutionScale));
    this.width = width;
    this.height = height;
    this.composer = new EffectComposer(renderer);
    this.composer.setSize(width, height);
    // Half-float targets keep bloom from clipping the emissive strips that define the look.
    this.composer.renderTarget1.texture.type = HalfFloatType;
    this.composer.renderTarget2.texture.type = HalfFloatType;

    this.renderPass = new RenderPass(scene, camera);
    this.composer.addPass(this.renderPass);

    this.bloom = opts.bloom ? new UnrealBloomPass(new Vector2(width, height), opts.strength, opts.radius, opts.threshold) : null;
    if (this.bloom) this.composer.addPass(this.bloom);

    this.grade = new ShaderPass(GradeShader);
    this.grade.uniforms.uAberration.value = opts.aberration ? 1 : 0;
    this.composer.addPass(this.grade);

    this.output = new OutputPass();
    this.composer.addPass(this.output);
  }

  setBloom(on: boolean, strength: number, radius: number, threshold: number): void {
    if (on && !this.bloom) {
      this.bloom = new UnrealBloomPass(new Vector2(this.width, this.height), strength, radius, threshold);
      // Bloom has to sit between the scene pass and the grade to affect emissive highlights.
      this.composer.insertPass(this.bloom, 1);
    } else if (!on && this.bloom) {
      this.composer.removePass(this.bloom);
      this.bloom.dispose();
      this.bloom = null;
    }
    if (this.bloom) {
      this.bloom.strength = strength;
      this.bloom.radius = radius;
      this.bloom.threshold = threshold;
    }
  }

  setAberration(on: boolean): void {
    this.grade.uniforms.uAberration.value = on ? 1 : 0;
  }

  setQualityGrain(grain: number, vignette: number): void {
    this.grade.uniforms.uGrain.value = grain;
    this.grade.uniforms.uVignette.value = vignette;
  }

  setSize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.composer.setSize(width, height);
    this.bloom?.setSize(width, height);
    this.grade.uniforms.uResolution.value.set(width, height);
  }

  update(state: GradeState): void {
    const u = this.grade.uniforms;
    u.uTime.value = state.time;
    u.uAberration.value = Math.max(0, Math.min(2.5, state.aberration));
    u.uWarp.value = Math.max(0, Math.min(1, state.warp));
    u.uHit.value = Math.max(0, Math.min(1, state.hit));
    u.uDanger.value = Math.max(0, Math.min(1, state.danger));
    u.uBoost.value = Math.max(0, Math.min(1, state.boost));
    u.uDesaturate.value = Math.max(0, Math.min(1, state.desaturate));
    u.uFlash.value.set(state.flashX, state.flashY);
  }

  render(): void {
    this.composer.render();
  }

  dispose(): void {
    this.bloom?.dispose();
    this.grade.dispose();
    this.output.dispose();
    this.renderPass.dispose();
    this.composer.dispose();
  }
}
