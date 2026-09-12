import {
  AdditiveBlending,
  BufferGeometry,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  SphereGeometry,
  TorusGeometry,
} from 'three';
import type { QualityTier, ShipTuning, TrailTuning } from '../../data/types.ts';
import { hullPanelTexture } from '../ProceduralTextures.ts';

export interface ShipVisualState {
  /** 0..1 boost envelope. */
  boost: number;
  /** -1..1 lateral steering input (banking). */
  steer: number;
  /** 0..1 drift slide. */
  drift: number;
  /** 0..1 throttle. */
  throttle: number;
  /** 0..1 braking. */
  brake: number;
  /** seconds since start, for idle animation. */
  time: number;
  /** 0..1 damage (flicker, exposed glow). */
  damage: number;
  /** 0..1 shield bubble opacity target. */
  shield: number;
  /** true while phase-drive is active (translucent hull). */
  phase: boolean;
  /** 0..1 overdrive. */
  overdrive: number;
}

export interface ShipVisual {
  root: Group;
  /** Exhaust emitter transforms (one per nacelle), in ship space. */
  engineAnchors: Object3D[];
  noseAnchor: Object3D;
  setBank(roll: number, pitch: number): void;
  update(dt: number, state: ShipVisualState): void;
  dispose(): void;
}

const geometryCache = new Map<string, BufferGeometry>();
const materialCache = new Map<string, MeshStandardMaterial | MeshBasicMaterial>();

function cached<T extends BufferGeometry>(key: string, build: () => T): T {
  const hit = geometryCache.get(key);
  if (hit) return hit as T;
  const made = build();
  geometryCache.set(key, made);
  return made;
}

/**
 * Fuselage: a faceted prism whose width swells mid-body and pinches at nose and tail.
 * Six sides keeps the silhouette hard-edged and legible against a bright tunnel.
 */
function fuselageGeometry(length: number, beam: number, spine: number, detail: number): BufferGeometry {
  return cached(`fuse-${length.toFixed(2)}-${beam.toFixed(2)}-${spine.toFixed(2)}-${detail}`, () => {
    const sides = 6;
    const rings = 4 + detail * 4;
    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    const nose = length * 0.55;
    for (let ring = 0; ring <= rings; ring++) {
      const t = ring / rings;
      const swell = Math.sin(Math.PI * Math.pow(t, 0.7));
      const width = beam * (0.1 + swell * 0.9);
      const height = spine * (0.14 + Math.pow(swell, 0.8) * 0.86);
      const z = nose - t * length;
      for (let s = 0; s <= sides; s++) {
        const a = (s / sides) * Math.PI * 2;
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        // Hardening the circle into facets: the flat panels catch the tunnel light.
        const fx = Math.sign(ca) * Math.pow(Math.abs(ca), 0.68);
        const fy = Math.sign(sa) * Math.pow(Math.abs(sa), 0.8);
        positions.push(width * fx, height * fy, z);
        uvs.push(s / sides, t);
      }
    }
    const stride = sides + 1;
    for (let ring = 0; ring < rings; ring++) {
      for (let s = 0; s < sides; s++) {
        const a = ring * stride + s;
        indices.push(a, a + stride, a + 1, a + 1, a + stride, a + stride + 1);
      }
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new Float32BufferAttribute(positions, 3));
    geo.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    return geo;
  });
}

/**
 * A wing panel as an explicit wedge: root chord at x=0 tapering out to the tip, with real
 * thickness so it reads from every angle. Reused for wings, fins and canards.
 */
function wingGeometry(span: number, rootChord: number, tipChord: number, sweep: number, thickness: number, detail: number): BufferGeometry {
  return cached(`wing-${span.toFixed(2)}-${rootChord.toFixed(2)}-${sweep.toFixed(2)}-${detail}`, () => {
    const rows = 1 + detail;
    const positions: number[] = [];
    const indices: number[] = [];
    const half = thickness * 0.5;
    for (let side = -1; side <= 1; side += 2) {
      for (let face = 0; face < 2; face++) {
        const ySign = face === 0 ? 1 : -1;
        const base = positions.length / 3;
        for (let r = 0; r <= rows; r++) {
          const u = r / rows;
          const chord = rootChord + (tipChord - rootChord) * u;
          const z = -chord * 0.5 + sweep * u;
          const x = side * span * u;
          positions.push(x, ySign * half * (1 - u * 0.55), z + chord * 0.5);
          positions.push(x, ySign * half * (1 - u * 0.55), z - chord * 0.5);
        }
        for (let i = 0; i < rows; i++) {
          const a = base + i * 2;
          if (side > 0 === ySign > 0) indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
          else indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
        }
      }
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new Float32BufferAttribute(positions, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    return geo;
  });
}

function nacelleGeometry(radius: number, length: number, detail: number): BufferGeometry {
  return cached(`nac-${radius.toFixed(2)}-${length.toFixed(2)}-${detail}`, () => {
    const sides = 8 + detail * 2;
    const rings = 6 + detail * 4;
    const positions: number[] = [];
    const indices: number[] = [];
    for (let r = 0; r <= rings; r++) {
      const t = r / rings;
      const z = length * (0.5 - t);
      // Rounded intake at the front, straight barrel, then the exhaust bell flare.
      const intake = t < 0.16 ? Math.max(0.32, Math.sin(Math.min(1, t / 0.16) * Math.PI * 0.5)) : 1;
      const bell = t > 0.74 ? 1 + Math.pow((t - 0.74) / 0.26, 1.8) * 0.5 : 1;
      const rad = radius * intake * bell;
      for (let s = 0; s <= sides; s++) {
        const a = (s / sides) * Math.PI * 2;
        positions.push(Math.cos(a) * rad, Math.sin(a) * rad, z);
      }
    }
    const stride = sides + 1;
    for (let r = 0; r < rings; r++) {
      for (let s = 0; s < sides; s++) {
        const a = r * stride + s;
        indices.push(a, a + stride, a + 1, a + 1, a + stride, a + stride + 1);
      }
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new Float32BufferAttribute(positions, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    return geo;
  });
}

function canopyGeometry(width: number, length: number, detail: number): BufferGeometry {
  return cached(`cap-${width.toFixed(2)}-${length.toFixed(2)}-${detail}`, () => {
    const geo = new SphereGeometry(1, 8 + detail * 4, 5 + detail * 2, 0, Math.PI * 2, 0, Math.PI * 0.52);
    geo.scale(width, 0.46, length);
    return geo;
  });
}

function exhaustRingGeometry(radius: number, detail: number): BufferGeometry {
  return cached(`exr-${radius.toFixed(2)}-${detail}`, () => new TorusGeometry(radius, radius * 0.16, 4 + detail * 2, 10 + detail * 6));
}

function hullMaterial(color: string): MeshStandardMaterial {
  const key = `hull-${color}`;
  const hit = materialCache.get(key);
  if (hit instanceof MeshStandardMaterial) return hit;
  const mat = new MeshStandardMaterial({
    color: new Color(color),
    map: hullPanelTexture(0x5eed),
    metalness: 0.62,
    roughness: 0.42,
    envMapIntensity: 1.25,
  });
  mat.map!.repeat.set(3, 1.5);
  materialCache.set(key, mat);
  return mat;
}

function emissiveMaterial(color: string, intensity: number): MeshBasicMaterial {
  const key = `emi-${color}-${intensity}`;
  const hit = materialCache.get(key);
  if (hit instanceof MeshBasicMaterial) return hit;
  const mat = new MeshBasicMaterial({
    color: new Color(color).multiplyScalar(intensity),
    blending: AdditiveBlending,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
  });
  materialCache.set(key, mat);
  return mat;
}

function glassMaterial(color: string): MeshStandardMaterial {
  const key = `glass-${color}`;
  const hit = materialCache.get(key);
  if (hit instanceof MeshStandardMaterial) return hit;
  const mat = new MeshStandardMaterial({
    color: new Color(color),
    metalness: 0.15,
    roughness: 0.08,
    transparent: true,
    opacity: 0.78,
    side: DoubleSide,
    envMapIntensity: 2.6,
  });
  materialCache.set(key, mat);
  return mat;
}

/**
 * Builds one playable ship. Silhouette comes entirely from the tuning profile — length,
 * wingspan, engine size and fin count — so five hulls look genuinely different while the
 * collision shape and handling stay identical.
 */
export function createShipVisual(ship: ShipTuning, trail: TrailTuning, cosmetics: readonly string[], quality: QualityTier): ShipVisual {
  const detail = quality === 'ultra' ? 2 : quality === 'high' ? 1 : 0;
  const length = ship.profile.length;
  const beam = length * 0.14;
  const spine = length * 0.085;
  const engineScale = ship.profile.engine;
  const span = ship.profile.wing * 0.5;

  const root = new Group();
  root.name = `ship-${ship.id}`;
  // All visible parts live under a dressing group: the chase renderer writes root.position/
  // quaternion from the corridor frame every frame, and the animated trim below (hover bob,
  // brake push, bank blend) must never fight that for the same transform.
  const dressing = new Group();
  root.add(dressing);
  const hull = hullMaterial(ship.hull);
  const darkHull = hullMaterial('#2a3040');
  const accent = emissiveMaterial(ship.accent, 1.9);
  const core = emissiveMaterial(trail.core, 2.4);
  const halo = emissiveMaterial(trail.halo, 1.8);
  const disposables = new Set<BufferGeometry>();
  const ownedMaterials = new Set<MeshBasicMaterial | MeshStandardMaterial>();

  const body = new Mesh(cached('body-' + ship.id, () => fuselageGeometry(length, beam, spine, detail)), hull);
  disposables.add(body.geometry);
  dressing.add(body);

  const wing = new Mesh(cached('wing-' + ship.id, () => wingGeometry(span, length * 0.42, length * 0.16, length * 0.3, spine * 0.9, detail)), hull);
  wing.position.set(0, -spine * 0.25, -length * 0.02);
  disposables.add(wing.geometry);
  dressing.add(wing);

  // Fins are distributed around the tail: the fin count is the clearest silhouette tell.
  const fins = Math.max(2, ship.profile.fins);
  const finGeo = cached('fin-' + ship.id, () => wingGeometry(span * 0.42, length * 0.2, length * 0.06, length * 0.14, spine * 0.55, detail));
  disposables.add(finGeo);
  for (let f = 0; f < fins; f++) {
    const fin = new Mesh(finGeo, f % 2 === 0 ? darkHull : hull);
    const a = (f / fins) * Math.PI * 2 + Math.PI / fins;
    fin.position.set(0, 0, -length * 0.3);
    fin.rotation.set(0, 0, a);
    fin.scale.setScalar(0.9);
    dressing.add(fin);
  }

  const canopy = new Mesh(cached('canopy-' + ship.id, () => canopyGeometry(beam * 0.78, length * 0.26, detail)), glassMaterial(ship.profile.glass));
  canopy.position.set(0, spine * 0.72, length * 0.14);
  disposables.add(canopy.geometry);
  dressing.add(canopy);

  // Readability spine: a thin emissive line down the dorsal centre, always visible from chase.
  const spineGeo = cached('spine-' + ship.id, () => fuselageGeometry(length * 0.62, 0.045, 0.045, 0));
  disposables.add(spineGeo);
  const spineStrip = new Mesh(spineGeo, accent);
  spineStrip.position.set(0, spine * 0.92, -length * 0.04);
  dressing.add(spineStrip);

  const nacRadius = beam * 0.34 * engineScale;
  const nacLength = length * 0.42 * engineScale;
  const nacGeo = cached('nac-' + ship.id + detail, () => nacelleGeometry(nacRadius, nacLength, detail));
  disposables.add(nacGeo);
  const ringGeo = cached('ring-' + ship.id + detail, () => exhaustRingGeometry(nacRadius * 1.12, detail));
  disposables.add(ringGeo);

  const engineAnchors: Object3D[] = [];
  const exhaustRings: Mesh[] = [];
  const spacing = beam * 1.55;
  for (const side of [-1, 1]) {
    const nac = new Mesh(nacGeo, hull);
    nac.position.set(side * spacing, -spine * 0.15, -length * 0.16);
    dressing.add(nac);

    const ring = new Mesh(ringGeo, halo);
    ring.position.set(side * spacing, -spine * 0.15, -length * 0.16 - nacLength * 0.5);
    dressing.add(ring);
    exhaustRings.push(ring);

    const inner = new Mesh(ringGeo, core);
    inner.scale.setScalar(0.62);
    inner.position.copy(ring.position);
    inner.position.z -= 0.02;
    dressing.add(inner);
    exhaustRings.push(inner);

    const anchor = new Object3D();
    anchor.position.set(side * spacing, -spine * 0.15, ring.position.z - nacRadius * 0.4);
    dressing.add(anchor);
    engineAnchors.push(anchor);
  }

  // Cosmetic-only extras the player can buy; never touches handling.
  if (cosmetics.includes('wing-lights')) {
    const tipGeo = cached('tip-' + ship.id, () => exhaustRingGeometry(0.09, 0));
    disposables.add(tipGeo);
    for (const side of [-1, 1]) {
      const tip = new Mesh(tipGeo, accent);
      tip.position.set(side * span, -spine * 0.25, -length * 0.02 + length * 0.28);
      dressing.add(tip);
    }
  }

  const noseAnchor = new Object3D();
  noseAnchor.position.set(0, 0, length * 0.55);
  dressing.add(noseAnchor);

  const shieldGeo = cached('shield', () => new SphereGeometry(1, 20, 14));
  disposables.add(shieldGeo);
  const shieldMat = new MeshBasicMaterial({
    color: new Color('#8ff0ff'),
    transparent: true,
    opacity: 0,
    depthWrite: false,
    side: DoubleSide,
    blending: AdditiveBlending,
  });
  ownedMaterials.add(shieldMat);
  const shieldMesh = new Mesh(shieldGeo, shieldMat);
  shieldMesh.scale.setScalar(length * 0.46);
  shieldMesh.visible = false;
  dressing.add(shieldMesh);

  const tintedMaterials = [halo, core];
  let shieldLevel = 0;
  let targetRoll = 0;
  let targetPitch = 0;

  const visual: ShipVisual = {
    root,
    engineAnchors,
    noseAnchor,
    setBank(roll, pitch) {
      targetRoll = roll;
      targetPitch = pitch;
    },
    update(dt, state) {
      const k = Math.min(1, dt * 9);
      dressing.rotation.z += (targetRoll - dressing.rotation.z) * k;
      dressing.rotation.x += (targetPitch - dressing.rotation.x) * Math.min(1, dt * 7);
      // Hover bob: tiny, high frequency, sells mass without ever hiding the silhouette.
      dressing.position.y = Math.sin(state.time * 2.2) * 0.03 + Math.sin(state.time * 5.7) * 0.012;
      dressing.position.z = -state.brake * 0.12 + state.drift * 0.05;

      const flare = 0.5 + state.throttle * 0.5 + state.boost * 1.5 + state.overdrive * 0.7;
      const pulse = 1 + Math.sin(state.time * 26) * 0.05 * (0.35 + state.boost);
      halo.color.setStyle(trail.halo).multiplyScalar(flare * pulse);
      core.color.setStyle(trail.core).multiplyScalar((0.7 + flare * 1.3) * pulse);
      for (const ring of exhaustRings) ring.scale.setScalar(0.86 + flare * 0.34);
      for (const anchor of engineAnchors) anchor.scale.setScalar(1 + state.boost * 0.4);

      const hurt = state.damage > 0.66 ? 0.6 + 0.4 * Math.abs(Math.sin(state.time * 17)) : 1;
      spineStrip.visible = hurt > 0.85;

      shieldLevel += (state.shield - shieldLevel) * Math.min(1, dt * 8);
      shieldMesh.visible = shieldLevel > 0.015;
      shieldMat.opacity = shieldLevel * 0.26 * hurt;
      shieldMesh.scale.setScalar(length * (0.44 + Math.sin(state.time * 5.5) * 0.012) * (1 + shieldLevel * 0.05));

      const wantTransparent = state.phase;
      const alpha = state.phase ? 0.36 : 1;
      for (const m of [hull, darkHull]) {
        if (m.transparent !== wantTransparent) {
          m.transparent = wantTransparent;
          m.needsUpdate = true;
        }
        m.opacity = alpha;
      }
      for (const m of tintedMaterials) m.visible = true;
    },
    dispose() {
      for (const g of disposables) g.dispose();
      for (const m of ownedMaterials) m.dispose();
      disposables.clear();
      ownedMaterials.clear();
      root.clear();
    },
  };
  return visual;
}

/** Frees every cached ship resource (quality switch, hot reload, teardown). */
export function disposeShipFactory(): void {
  for (const geo of geometryCache.values()) geo.dispose();
  geometryCache.clear();
  for (const mat of materialCache.values()) mat.dispose();
  materialCache.clear();
}
