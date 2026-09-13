import {
  AdditiveBlending,
  BufferGeometry,
  Color,
  ConeGeometry,
  IcosahedronGeometry,
  Matrix4,
  MeshBasicMaterial,
  MeshStandardMaterial,
  OctahedronGeometry,
  Quaternion,
  SphereGeometry,
  TetrahedronGeometry,
  TorusGeometry,
  TorusKnotGeometry,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Merges parts safely: three requires every input to agree on having an index, so each
 * geometry is flattened first. Returns the merge, or the first part when it cannot merge.
 */
function mergeParts(parts: BufferGeometry[], fallbackName = ''): BufferGeometry {
  const flat = parts.map((part) => (part.index ? part.toNonIndexed() : part));
  const merged = mergeGeometries(flat, false);
  for (let i = 0; i < flat.length; i++) {
    if (flat[i] !== merged && flat[i] !== parts[i]) flat[i].dispose();
    if (parts[i] !== flat[i]) parts[i].dispose();
  }
  const out = merged ?? flat[0] ?? new BufferGeometry();
  if (fallbackName) out.name = fallbackName;
  out.computeVertexNormals();
  out.computeBoundingSphere();
  return out;
}

/** Polyhedra arrive un-indexed; asking again only makes three warn. */
function flatten(geo: BufferGeometry): BufferGeometry {
  return geo.index ? geo.toNonIndexed() : geo;
}
const geometryCache = new Map<string, BufferGeometry>();
const materialCache = new Map<string, MeshStandardMaterial | MeshBasicMaterial>();

/** Deterministic hash noise so a variant always looks identical across runs and machines. */
function hash3(x: number, y: number, z: number, seed: number): number {
  let h = seed ^ 0x9e3779b9;
  h = Math.imul(h ^ (x | 0), 0x85ebca6b);
  h = Math.imul(h ^ (y | 0), 0xc2b2ae35);
  h = Math.imul(h ^ (z | 0), 0x27d4eb2f);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2545f491);
  return ((h ^ (h >>> 13)) >>> 0) / 4294967295;
}

function cached(key: string, build: () => BufferGeometry): BufferGeometry {
  const hit = geometryCache.get(key);
  if (hit) return hit;
  const made = build();
  geometryCache.set(key, made);
  return made;
}

function displace(geo: BufferGeometry, seed: number, amount: number, longWave: number): BufferGeometry {
  const flat = flatten(geo);
  const pos = flat.getAttribute('position');
  const v = new Vector3();
  const seen = new Map<string, number>();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const key = `${v.x.toFixed(4)},${v.y.toFixed(4)},${v.z.toFixed(4)}`;
    let scale = seen.get(key);
    if (scale === undefined) {
      const lattice = Math.round(longWave);
      const n =
        hash3(Math.round(v.x * lattice), Math.round(v.y * lattice), Math.round(v.z * lattice), seed) * 0.6 +
        hash3(Math.round(v.x * lattice * 2.3), Math.round(v.y * lattice * 2.3), Math.round(v.z * lattice * 2.3), seed + 7) * 0.4;
      scale = 1 - amount * 0.5 + n * amount;
      seen.set(key, scale);
    }
    pos.setXYZ(i, v.x * scale, v.y * scale, v.z * scale);
  }
  flat.computeVertexNormals();
  flat.computeBoundingSphere();
  return flat;
}

/** Four rock families: lump, elongated, fractured plate and porous, each faceted. */
export function asteroidGeometry(variant: number, detail: number): BufferGeometry {
  const v = ((variant % 4) + 4) % 4;
  return cached(`ast-${v}-${detail}`, () => {
    const geo = new IcosahedronGeometry(1, Math.min(2, detail));
    if (v === 1) geo.scale(1.5, 0.72, 0.8);
    if (v === 2) geo.scale(1.1, 1.05, 0.45);
    if (v === 3) geo.scale(0.92, 1.12, 0.96);
    const displaced = displace(geo, 1000 + v * 37, 0.42 + v * 0.06, 3 + v);
    geo.dispose();
    return displaced;
  });
}

export function mineGeometry(): BufferGeometry {
  return cached('mine', () => {
    const core = new IcosahedronGeometry(0.58, 1);
    const spikes: BufferGeometry[] = [core];
    const directions = [
      new Vector3(1, 0, 0),
      new Vector3(-1, 0, 0),
      new Vector3(0, 1, 0),
      new Vector3(0, -1, 0),
      new Vector3(0, 0, 1),
      new Vector3(0, 0, -1),
      new Vector3(1, 1, 1).normalize(),
      new Vector3(-1, 1, -1).normalize(),
      new Vector3(1, -1, -1).normalize(),
      new Vector3(-1, -1, 1).normalize(),
    ];
    for (const dir of directions) {
      const spike = new ConeGeometry(0.13, 0.52, 5);
      // Cone points +Y by default: rotate it onto the radial direction and push it out.
      spike.applyMatrix4(new Matrix4().makeRotationFromQuaternion(new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), dir)));
      spike.translate(dir.x * 0.72, dir.y * 0.72, dir.z * 0.72);
      spikes.push(spike);
    }
    return mergeParts([...spikes, core], 'mine');
  });
}

/** Gravity anomaly: a slow-turning knot around a dark core, reads as "pull" not "wall". */
export function anomalyGeometry(): BufferGeometry {
  return cached('anomaly', () => {
    const shell = new TorusKnotGeometry(0.86, 0.075, 64, 6, 2, 3);
    shell.computeBoundingSphere();
    return shell;
  });
}

export function anomalyCoreGeometry(): BufferGeometry {
  return cached('anomaly-core', () => new SphereGeometry(0.62, 12, 10));
}

/** Rogue craft: hostile, angular. Nose ends up at +Z, matching the hull and corridor basis. */
export function rogueGeometry(): BufferGeometry {
  return cached('rogue', () => {
    const hull = flatten(new IcosahedronGeometry(0.62, 0));
    hull.scale(0.9, 0.66, 1.7);
    const prow = new ConeGeometry(0.42, 1.1, 4);
    prow.rotateX(-Math.PI / 2);
    prow.translate(0, 0, -1.35);
    const wing = new TetrahedronGeometry(0.62, 0);
    wing.scale(1.7, 0.16, 0.7);
    wing.translate(0, -0.05, 0.3);
    const fin = new TetrahedronGeometry(0.4, 0);
    fin.scale(0.12, 0.9, 0.6);
    fin.translate(0, 0.4, 0.6);
    const merged = mergeParts([hull, prow, wing, fin], 'rogue');
    // Authored nose-first along -Z (the old mirrored-basis convention); the corridor now maps
    // local +Z to the direction of travel, so flip the part list once at build time.
    merged.rotateY(Math.PI);
    return merged;
  });
}

export function wreckGeometry(variant: number): BufferGeometry {
  const v = ((variant % 3) + 3) % 3;
  return cached(`wreck-${v}`, () => {
    const plate = new TetrahedronGeometry(0.8, 0);
    plate.scale(1.4, 0.3, 0.9 + v * 0.3);
    const rib = new TorusGeometry(0.5 + v * 0.12, 0.06, 4, 10, Math.PI * (1 + v * 0.3));
    return mergeParts([plate, rib], 'wreck');
  });
}

/** One unmistakable silhouette per pickup so a glance is enough at 300 m/s. */
export function pickupGeometry(kind: string): BufferGeometry {
  return cached(`pick-${kind}`, () => {
    switch (kind) {
      case 'shield':
        return new IcosahedronGeometry(0.7, 0);
      case 'overdrive': {
        const geo = new ConeGeometry(0.55, 1.3, 4);
        geo.rotateX(Math.PI / 2);
        return geo;
      }
      case 'phase':
        return new TorusGeometry(0.6, 0.17, 5, 14);
      case 'magnet': {
        const geo = new TorusGeometry(0.55, 0.16, 5, 14, Math.PI);
        geo.rotateZ(Math.PI);
        return geo;
      }
      case 'credit':
        return new OctahedronGeometry(0.62, 0);
      default:
        return new OctahedronGeometry(0.6, 1);
    }
  });
}

/** Gate ring: unit radius in the XY plane, extruded along +Z for a real hoop. */
export function gateGeometry(): BufferGeometry {
  return cached('gate', () => {
    const hoop = new TorusGeometry(1, 0.085, 6, 40);
    hoop.computeBoundingSphere();
    return hoop;
  });
}

/** Three struts anchoring a gate to the corridor, purely decorative. */
export function gateStrutGeometry(): BufferGeometry {
  return cached('gate-strut', () => {
    const strut = new ConeGeometry(0.055, 1, 4);
    strut.translate(0, 0.5, 0);
    strut.computeBoundingSphere();
    return strut;
  });
}

/** Angular fragment thrown off by a collapsing lane block. */
export function debrisChunkGeometry(variant: number): BufferGeometry {
  const v = ((variant % 5) + 5) % 5;
  return cached(`chunk-${v}`, () => {
    const geo = new TetrahedronGeometry(0.7, 0);
    const pos = geo.getAttribute('position');
    const arr = pos.array as Float32Array;
    for (let i = 0; i < arr.length; i++) arr[i] *= 0.55 + hash3(i, v, i >> 1, 4242 + v) * 1.35;
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    return geo;
  });
}

export function shellGeometry(): BufferGeometry {
  return cached('shell', () => new SphereGeometry(1, 26, 18));
}

export function boostPadGeometry(): BufferGeometry {
  return cached('pad', () => {
    const geo = new ConeGeometry(1, 0.55, 4);
    geo.rotateX(Math.PI / 2);
    geo.computeBoundingSphere();
    return geo;
  });
}

/** Physically-based props. `palette` supplies hull/accent/emissive per biome. */
export function standardMaterial(kind: string, palette: Record<string, string>): MeshStandardMaterial {
  const key = `std-${kind}-${palette.rock ?? '-'}-${palette.hull ?? '-'}`;
  const hit = materialCache.get(key);
  if (hit instanceof MeshStandardMaterial) return hit;
  const rock = palette.rock ?? '#7d7469';
  const metal = palette.metal ?? '#39404f';
  const mat = new MeshStandardMaterial({
    color: new Color(kind === 'asteroid' || kind === 'shard' || kind === 'debris' ? rock : kind === 'rogue' || kind === 'wreck' ? metal : '#6f7684'),
    metalness: kind === 'rogue' || kind === 'wreck' ? 0.78 : 0.12,
    roughness: kind === 'asteroid' || kind === 'shard' || kind === 'debris' ? 0.92 : 0.4,
    flatShading: kind !== 'rogue',
    envMapIntensity: kind === 'rogue' || kind === 'wreck' ? 1.4 : 0.7,
  });
  materialCache.set(key, mat);
  return mat;
}

export function emissiveMaterial(color: string, intensity: number): MeshBasicMaterial {
  const key = `em-${color}-${intensity}`;
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

export function disposeFactory(): void {
  for (const geo of geometryCache.values()) geo.dispose();
  geometryCache.clear();
  for (const mat of materialCache.values()) mat.dispose();
  materialCache.clear();
}
