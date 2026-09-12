import {
  AdditiveBlending,
  AmbientLight,
  BufferGeometry,
  CanvasTexture,
  Color,
  DirectionalLight,
  EquirectangularReflectionMapping,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshStandardMaterial,
  PMREMGenerator,
  Points,
  PointsMaterial,
  SRGBColorSpace,
  Vector3,
} from 'three';
import type { WebGLRenderer, Scene, Texture } from 'three';
import { LANE } from '../data/config.ts';
import type { BiomeTuning, QualityTier } from '../data/types.ts';
import type { LanePath } from '../game/LanePath.ts';
import { nebulaEquirect, starSprite } from './ProceduralTextures.ts';
import { shellGeometry } from './factory/PropFactory.ts';

const DECOR_OFFSETS = [120, 340, 620, 940, 1300, 1700];

interface Decor {
  mesh: Mesh;
  /** Lane distance ahead of the ship this piece keeps station at. */
  offset: number;
  /** Lateral/vertical placement in multiples of the corridor half-width. */
  side: number;
  lift: number;
  scale: number;
  drift: number;
}

/**
 * Everything outside the tube: the nebula that lights the scene, the starfield, and the
 * distant bodies that give the corridor a sense of place.
 *
 * The nebula is generated once per biome and pushed through PMREM, so the same image that
 * the player sees behind the corridor is also what reflects off the hull. Decor is parked far
 * outside the lane and re-stationed by lane distance, which means it stays correctly framed
 * even where a collapsed section opens a hole straight into space.
 */
export class SceneEnvironment {
  readonly group = new Group();
  readonly lights = new Group();
  private readonly ambient = new AmbientLight(0xffffff, 0.35);
  private readonly key = new DirectionalLight(0xffffff, 1.1);
  private readonly rim = new DirectionalLight(0xffffff, 0.7);
  private stars: Points | null = null;
  private starTexture: Texture | null = null;
  private decor: Decor[] = [];
  private envTarget: { dispose(): void } | null = null;
  private nebulaTexture: Texture | null = null;
  private readonly pmrem: PMREMGenerator;
  private biome: BiomeTuning | null = null;
  private tier: QualityTier = 'high';
  private time = 0;

  constructor(renderer: WebGLRenderer, private readonly scene: Scene) {
    this.pmrem = new PMREMGenerator(renderer);
    this.pmrem.compileEquirectangularShader();
    this.key.position.set(1, 1.4, 0.8);
    this.rim.position.set(-1.2, -0.6, -1);
    this.lights.add(this.ambient, this.key, this.rim);
    this.scene.add(this.group, this.lights);
  }

  setBiome(biome: BiomeTuning, quality: QualityTier): void {
    if (this.biome?.id === biome.id && this.tier === quality) return;
    this.biome = biome;
    this.tier = quality;
    this.rebuildSky(biome, quality);
    this.rebuildStars(biome, quality);
    this.rebuildDecor(biome, quality);
    this.ambient.color.set(biome.palette.mid).multiplyScalar(1.4);
    this.ambient.intensity = biome.ambient;
    this.key.color.set(biome.keyLight);
    this.rim.color.set(biome.rimLight);
  }

  private rebuildSky(biome: BiomeTuning, quality: QualityTier): void {
    const size = quality === 'low' ? 512 : quality === 'medium' ? 768 : 1024;
    this.nebulaTexture?.dispose();
    const canvas = nebulaEquirect(biome.palette, size);
    const tex = new CanvasTexture(canvas);
    tex.colorSpace = SRGBColorSpace;
    tex.mapping = EquirectangularReflectionMapping;
    this.nebulaTexture = tex;
    this.scene.background = tex;
    this.envTarget?.dispose();
    const env = this.pmrem.fromEquirectangular(tex);
    this.envTarget = env;
    this.scene.environment = env.texture;
    this.scene.environmentIntensity = biome.nebulaIntensity;
  }

  private rebuildStars(biome: BiomeTuning, quality: QualityTier): void {
    if (this.stars) {
      this.stars.geometry.dispose();
      (this.stars.material as PointsMaterial).dispose();
      this.group.remove(this.stars);
      this.stars = null;
    }
    if (this.starTexture) {
      this.starTexture.dispose();
      this.starTexture = null;
    }
    const count = Math.round(QUALITY_STARS[quality] * biome.starDensity);
    const radius = LANE.sightDistance * 1.35;
    const position = new Float32Array(count * 3);
    const tint = new Float32Array(count * 3);
    const accent = new Color(biome.palette.accent);
    const hot = new Color(biome.palette.hot);
    for (let i = 0; i < count; i++) {
      // Even sphere coverage: the golden-angle pair avoids the clumping a naive random gives.
      const a = i * 2.39996323;
      const y = 1 - (i / Math.max(1, count - 1)) * 2;
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      position[i * 3] = Math.cos(a) * r * radius;
      position[i * 3 + 1] = y * radius;
      position[i * 3 + 2] = Math.sin(a) * r * radius;
      const pick = ((i * 7919) % 101) / 101;
      const c = pick > 0.86 ? accent : pick > 0.7 ? hot : WHITE;
      const mag = 0.35 + pick * 0.65;
      tint[i * 3] = c.r * mag;
      tint[i * 3 + 1] = c.g * mag;
      tint[i * 3 + 2] = c.b * mag;
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(position, 3));
    geometry.setAttribute('color', new Float32BufferAttribute(tint, 3));
    const material = new PointsMaterial({
      size: quality === 'low' ? 1.6 : 2.2,
      map: starSprite(),
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      sizeAttenuation: false,
    });
    material.toneMapped = false;
    const points = new Points(geometry, material);
    points.frustumCulled = false;
    points.name = 'starfield';
    points.renderOrder = -1;
    this.group.add(points);
    this.stars = points;
    this.starTexture = material.map;
  }

  private rebuildDecor(biome: BiomeTuning, quality: QualityTier): void {
    for (const d of this.decor) {
      this.group.remove(d.mesh);
      (d.mesh.material as MeshStandardMaterial).dispose();
    }
    this.decor = [];
    if (quality === 'low') return;
    const bodies = [biome.palette.accentAlt, biome.palette.mid, biome.palette.hot, biome.palette.deep, biome.palette.danger, biome.palette.accent];
    for (let i = 0; i < (quality === 'ultra' ? DECOR_OFFSETS.length : 4); i++) {
      const material = new MeshStandardMaterial({
        color: new Color(bodies[i % bodies.length]).lerp(BLACK, 0.55),
        roughness: 0.92,
        metalness: 0,
        emissive: new Color(bodies[i % bodies.length]).multiplyScalar(0.12),
        envMapIntensity: 0.7,
      });
      const mesh = new Mesh(shellGeometry(), material);
      const scale = 90 + ((i * 53) % 37) * 12;
      mesh.scale.setScalar(scale);
      this.group.add(mesh);
      this.decor.push({
        mesh,
        offset: DECOR_OFFSETS[i % DECOR_OFFSETS.length],
        side: (i % 2 === 0 ? -1 : 1) * (2.6 + ((i * 17) % 9) * 0.5),
        lift: 0.6 + ((i * 29) % 7) * 0.55,
        scale,
        drift: ((i * 11) % 5) * 0.02,
      });
    }
  }

  update(dt: number, playerS: number, path: LanePath): void {
    this.time += dt;
    if (this.stars) {
      // Stars ride with the ship so the parallax never runs out of sky, with a slow rotation
      // for the sense of drifting through a galaxy rather than a static cubemap.
      this.stars.rotation.y = this.time * 0.004;
      this.stars.rotation.x = Math.sin(this.time * 0.02) * 0.01;
    }
    for (const d of this.decor) {
      const s = playerS + d.offset;
      if (s > LANE.sightDistance * 4) continue;
      const p = path.pointTo(s, d.side * LANE.halfWidth * 8, d.lift * LANE.height * 6, TMP);
      d.mesh.position.copy(p);
      d.mesh.rotation.y += dt * d.drift;
    }
  }

  /** Keeps the sky centred on the camera so a fast dolly never exposes its edge. */
  follow(cameraPosition: Vector3): void {
    this.group.position.copy(cameraPosition);
    this.lights.position.copy(cameraPosition);
  }

  dispose(): void {
    for (const d of this.decor) (d.mesh.material as MeshStandardMaterial).dispose();
    this.decor = [];
    this.stars?.geometry.dispose();
    (this.stars?.material as PointsMaterial)?.dispose();
    this.starTexture?.dispose();
    this.nebulaTexture?.dispose();
    this.envTarget?.dispose();
    this.pmrem.dispose();
    this.scene.environment = null;
    this.scene.background = null;
    this.scene.remove(this.group);
    this.scene.remove(this.lights);
    this.group.clear();
    this.lights.clear();
  }
}


const QUALITY_STARS: Record<QualityTier, number> = { ultra: 5200, high: 3800, medium: 2600, low: 1500 };
const WHITE = new Color('#ffffff');
const BLACK = new Color('#000000');
const TMP = new Vector3();
