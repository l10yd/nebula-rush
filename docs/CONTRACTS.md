# NEBULA RUSH — module contracts

This document is the **authoritative interface contract** for the modules listed below.
Implementations must match the signatures exactly — other modules are already written
against them. Do not rename exports, change parameter shapes, or add required options.

## Global rules

- TypeScript `strict` (see `tsconfig.json`: `noUnusedLocals`, `noUnusedParameters`, `verbatimModuleSyntax`).
  Type-only imports **must** use `import type`.
- Runtime target: modern desktop browsers, WebGL2, `three@0.169` (installed). **No new dependencies.**
- Never throw from these modules. Log at most one `console.warn` per failure mode.
- No allocations in per-frame code paths: reuse `THREE.Vector3` / arrays / typed arrays.
- All user-visible strings come from `src/data/i18n.ts` (`import { t } from '../data/i18n'`) —
  but **modules below should not render text at all**; they expose data and hooks.
- Tuning values live in `src/data/config.ts`. Import them; do not hardcode gameplay numbers.
- Verify with: `npx tsc --noEmit -p tsconfig.json` and fix **only** errors mentioning your files
  (the rest of the project is being written in parallel).

---

## A) `src/audio/AudioEngine.ts`

Fully procedural Web Audio: no external audio files. Everything synthesised.

```ts
export type SfxName =
  | 'uiHover' | 'uiClick' | 'uiBack' | 'uiOpen' | 'uiClose'
  | 'boostStart' | 'boostEnd' | 'perfectBoost' | 'warp'
  | 'driftStart' | 'driftEnd' | 'perfectDrift'
  | 'hit' | 'hitHeavy' | 'scrape' | 'shieldUp' | 'shieldBreak'
  | 'gate' | 'nearMiss' | 'collapseWarn' | 'collapseBreak' | 'shockwave'
  | 'wormhole' | 'countdown' | 'countdownGo' | 'finish' | 'ability'
  | 'pickupEnergy' | 'pickupShield' | 'pickupOverdrive' | 'pickupPhase'
  | 'pickupMagnet' | 'pickupCredit';

export interface EngineState {
  /** 0..1 normalised speed for pitch. */ speed01: number;
  /** 0..1 boost envelope (ramp in/out is done by the caller). */ boost: number;
  /** -1..1 throttle/brake input. */ throttle: number;
  /** 0..1 drift slide amount. */ drifting: number;
  /** 0..1 damage level (adds grit / detune). */ damage: number;
  /** true while the ship engine should run. */ active: boolean;
}

export interface AudioVolumes { master: number; music: number; sfx: number; engine: number }

export class AudioEngine {
  constructor(volumes: AudioVolumes);
  /** Lazily creates AudioContext. Safe to call repeatedly (idempotent). */
  init(): Promise<boolean>;
  /** Call from a user gesture; returns whether audio is now running. */
  unlock(): Promise<boolean>;
  suspend(): void;
  resumeCtx(): void;
  setVolumes(v: AudioVolumes): void;
  setMusicIntensity(v: number): void;          // 0..1, cross-fades layers
  startMusic(): void;
  stopMusic(): void;
  setDucking(on: boolean): void;               // duck music under warnings
  setWarning(active: boolean): void;           // looping danger tone
  updateEngine(state: EngineState, dt: number): void;
  playSfx(name: SfxName, opts?: { intensity?: number; detune?: number }): void;
  /** 0..1 energy of the last collision layer, for UI meter use. */
  get ready(): boolean;
  dispose(): void;
}
```

Requirements: master chain → compressor/limiter → destination, plus a procedurally generated
impulse-response convolver reverb on a send bus. Engine voice = detuned saw pair + sub +
filtered noise through a lowpass whose cutoff and pitch track `speed01`, plus a boost "whine".
Music = a 16-step lookahead scheduler (kick / snare / hat / acid bass / arpeggio / pad) whose
layer mix and tempo follow `setMusicIntensity`; must keep running correctly when suspended.
SFX must be short, punchy, non-clicking (attack/release ramps), and each one must be safe to
trigger many times per second (voice budget, no unbounded node growth — disconnect on ended).

## B) `src/rendering/factory/ShipFactory.ts` and `src/rendering/factory/PropFactory.ts`

Procedural geometry/material factories (no external models). Only `three` + `src/data/*` imports.

```ts
// ShipFactory.ts
import type * as THREE from 'three';
import type { ShipTuning, TrailTuning } from '../../../data/types';
import type { QualityTier } from '../../../data/types';

export interface ShipVisualState {
  /** 0..1 boost envelope. */ boost: number;
  /** -1..1 lateral steering input (banking). */ steer: number;
  /** 0..1 drift slide. */ drift: number;
  /** 0..1 throttle. */ throttle: number;
  /** 0..1 braking. */ brake: number;
  /** seconds since start, for idle animation. */ time: number;
  /** 0..1 damage (flicker, exposed glow). */ damage: number;
  /** 0..1 shield bubble opacity target. */ shield: number;
  /** true while phase-drive is active (translucent hull). */ phase: boolean;
  /** 0..1 overdrive. */ overdrive: number;
}

export interface ShipVisual {
  root: THREE.Group;                 // ship faces -Z forward, +Y up, ~5.6 units long
  engineAnchors: THREE.Object3D[];    // exhaust emitter transforms (one per nacelle)
  noseAnchor: THREE.Object3D;
  setBank(roll: number, pitch: number): void;
  update(dt: number, state: ShipVisualState): void;
  dispose(): void;
}

export function createShipVisual(
  ship: ShipTuning,
  trail: TrailTuning,
  cosmetics: readonly string[],
  quality: QualityTier,
): ShipVisual;

// PropFactory.ts — all geometry must be cached per key and reused.
export function asteroidGeometry(variant: number, detail: number): THREE.BufferGeometry;   // 4 variants, irregular rock
export function mineGeometry(): THREE.BufferGeometry;
export function anomalyGeometry(): THREE.BufferGeometry;
export function rogueGeometry(): THREE.BufferGeometry;      // small hostile craft, faces -Z
export function wreckGeometry(variant: number): THREE.BufferGeometry;
export function pickupGeometry(kind: string): THREE.BufferGeometry; // energy|shield|overdrive|phase|magnet|credit
export function gateGeometry(): THREE.BufferGeometry;       // flat ring, radius 1, in XY plane
export function debrisChunkGeometry(variant: number): THREE.BufferGeometry; // angular shard for collapse fragments
export function shellGeometry(): THREE.BufferGeometry;      // unit sphere for planets
export function standardMaterial(kind: string, palette: Record<string, string>): THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial;
export function emissiveMaterial(color: string, intensity: number): THREE.MeshBasicMaterial;
export function disposeFactory(): void;   // frees every cached geometry/material
```

Design bar: premium arcade sci-fi, silhouette readable at distance, emissive strips used
sparingly against dark hulls, no visible seams, LOD (`detail`) respected, ≤ 6k triangles per
ship, ≤ 12 materials total in the factory cache.

## C) `src/rendering/ProceduralTextures.ts`

Canvas/Data-texture generators used by materials, the sky and the tunnel shader.

```ts
export interface PaletteSpec { deep: string; mid: string; accent: string; accentAlt: string; hot: string; danger: string }
export function nebulaEquirect(palette: PaletteSpec, size?: number): HTMLCanvasElement;   // 2:1 equirect nebula+stars
export function starSprite(): THREE.CanvasTexture;          // soft round additive sprite
export function sparkSprite(): THREE.CanvasTexture;         // additive elongated spark
export function ringSprite(): THREE.CanvasTexture;          // additive shockwave ring
export function hullPanelTexture(seed: number): THREE.CanvasTexture;  // grey panel/decals for MeshStandardMaterial maps
export function rockTexture(seed: number, color?: string): THREE.CanvasTexture;
export function noiseTexture(size?: number): THREE.DataTexture;       // RGBA8 tileable value noise
export function gradientRamp(stops: [number, string][]): THREE.DataTexture; // 256x1 sRGB ramp
export function disposeTextures(): void;
```

All textures must be power-of-two, tileable where stated, and use correct colour spaces
(`THREE.SRGBColorSpace` for albedo/authoring maps, `NoColorSpace`/linear for data maps).

## D) CSS design system — `src/ui/styles.css`

Written **later** by the UI owner's brief; see `docs/UI-CONTRACT.md` (created when the DOM
modules exist). Ignore this section until that file exists.
