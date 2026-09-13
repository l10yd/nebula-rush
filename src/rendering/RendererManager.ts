import {
  ACESFilmicToneMapping,
  Color,
  Group,
  PerspectiveCamera,
  Quaternion,
  Scene,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { LANE } from '../data/config.ts';
import type { QualityManager } from './QualityManager.ts';
import type { BiomeTuning, ShipTuning, TrailTuning } from '../data/types.ts';
import type { LanePath } from '../game/LanePath.ts';
import { createFrame } from '../game/LanePath.ts';
import type { LaneFrame } from '../game/LanePath.ts';
import type { GeneratedTrack } from '../game/trackTypes.ts';
import type { RaceRuntime } from '../game/RaceRuntime.ts';
import { CameraRig } from './CameraRig.ts';
import { laneOrientation } from './laneOrientation.ts';
import type { CameraInput } from './CameraRig.ts';
import { SceneEnvironment } from './Environment.ts';
import { FxDispatcher, ParticleSystem } from './Particles.ts';
import { disposeTextures } from './ProceduralTextures.ts';
import { PropField } from './PropField.ts';
import { PostFX } from './PostFX.ts';
import { SpeedLines } from './SpeedLines.ts';
import { createShipVisual, disposeShipFactory } from './factory/ShipFactory.ts';
import type { ShipVisual } from './factory/ShipFactory.ts';
import { disposeFactory } from './factory/PropFactory.ts';
import { RibbonTrail } from './Trails.ts';
import { buildTunnel, updateTunnel } from './TunnelMesh.ts';
import type { TunnelHandles } from './TunnelMesh.ts';

/** A generated track plus the baked centreline the renderer needs. */
export type RenderableTrack = GeneratedTrack & { path: LanePath };

export interface RendererOptions {
  canvas: HTMLCanvasElement;
  quality: QualityManager;
  reducedMotion: boolean;
  shakeEnabled: boolean;
}

const RIGHT = new Vector3();
const QUAT = new Quaternion();
const VEC = new Vector3();

/**
 * Bloom budget. The corridor is built from emissive strips; blooming at strength 0.78 with a
 * 0.58 threshold made nearly every panel glow and turned each row of arches flown through into
 * a full-screen white-out. Only genuinely over-range highlights bloom now, softly. Reduced
 * motion switches bloom off entirely — the setting already promises that flashing is calmed.
 */
const BLOOM = { strength: 0.32, radius: 0.45, threshold: 0.9 };

/**
 * The renderer facade. It owns the GPU resources and every per-frame visual subsystem, and it
 * is the only render-side module allowed to read the race runtime — the simulation is always
 * the authority, this class reads it and never writes to it.
 */
export class RendererManager {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly rig: CameraRig;

  private readonly environment: SceneEnvironment;
  private readonly props = new Group();
  private readonly shipRoot = new Group();
  private readonly frame: LaneFrame = createFrame();
  private readonly options: RendererOptions;
  private tunnel: TunnelHandles | null = null;
  private propField: PropField | null = null;
  private particles: ParticleSystem | null = null;
  private fx: FxDispatcher | null = null;
  private speedLines: SpeedLines | null = null;
  private post: PostFX | null = null;
  private ship: ShipVisual | null = null;
  private cosmetics: readonly string[] = [];
  private collapseWake = 0;
  private frameTick = 0;
  private trails: RibbonTrail[] = [];
  private track: RenderableTrack | null = null;
  private biome: BiomeTuning | null = null;
  private bound: RaceRuntime | null = null;
  private unbind: (() => void)[] = [];
  private elapsed = 0;
  private hitPulse = 0;
  private ambientS = 0;
  private collapsePulse = 0;
  private showcaseAngle = 0;
  private width = 1;
  private height = 1;

  constructor(options: RendererOptions) {
    this.options = options;
    this.renderer = new WebGLRenderer({
      canvas: options.canvas,
      antialias: false,
      powerPreference: 'high-performance',
      stencil: false,
      alpha: false,
    });
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.02;
    this.renderer.setClearColor(0x000000, 1);

    this.rig = new CameraRig(1);
    this.scene.add(this.props, this.rig.camera, this.shipRoot);
    this.environment = new SceneEnvironment(this.renderer, this.scene);
    this.applyQuality();
  }

  get camera(): PerspectiveCamera {
    return this.rig.camera;
  }

  get stats(): { calls: number; triangles: number; geometries: number; textures: number } {
    const info = this.renderer.info;
    return { calls: info.render.calls, triangles: info.render.triangles, geometries: info.memory.geometries, textures: info.memory.textures };
  }

  resize(width: number, height: number): void {
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    const budget = this.options.quality.profile;
    const dpr = Math.min(window.devicePixelRatio || 1, budget.dprCap);
    // renderScale is folded into the pixel ratio so the whole pipeline, bloom included,
    // renders at one internal resolution instead of blitting twice.
    this.renderer.setPixelRatio(dpr * budget.renderScale);
    this.renderer.setSize(this.width, this.height, false);
    this.rig.setAspect(this.width / this.height);
    const buffer = this.renderer.getDrawingBufferSize(new Vector2());
    this.post?.setSize(Math.max(2, Math.floor(buffer.x)), Math.max(2, Math.floor(buffer.y)));
    this.particles?.setPixelRatio(dpr);
  }

  /** Rebuilds every track-bound resource. Called on load and whenever the seed changes. */
  loadTrack(track: RenderableTrack, biome: BiomeTuning): void {
    this.disposeTrackResources();
    this.track = track;
    this.biome = biome;
    const tier = this.options.quality.current;
    const budget = this.options.quality.profile;

    this.tunnel = buildTunnel(track.rows, track.path, biome, tier);
    this.props.add(this.tunnel.mesh);
    this.propField = new PropField(track.rows, track.path, biome, tier);
    this.props.add(this.propField.root);
    this.particles = new ParticleSystem(budget.particles, {
      accent: new Color(biome.palette.accent),
      accentAlt: new Color(biome.palette.accentAlt),
      hot: new Color(biome.palette.hot),
      danger: new Color(biome.palette.danger),
      white: new Color('#ffffff'),
    });
    this.particles.setSizeScale(tier === 'low' ? 0.85 : 1);
    this.scene.add(this.particles.points);
    this.fx = new FxDispatcher(this.particles, track.path);

    this.speedLines?.dispose();
    this.speedLines = new SpeedLines(budget.warpStreaks, biome.palette.accent);
    this.speedLines.attachTo(this.rig.camera);

    this.environment.setBiome(biome, tier);
    this.post?.dispose();
    this.post = new PostFX(this.renderer, this.scene, this.rig.camera, {
      bloom: budget.bloom && !this.options.reducedMotion,
      strength: BLOOM.strength,
      radius: BLOOM.radius,
      threshold: BLOOM.threshold,
      aberration: budget.aberration,
      resolutionScale: 1,
    });
    this.post.setQualityGrain(tier === 'low' ? 0.012 : 0.024, 0.42);
    this.resize(this.width, this.height);
  }

  setShip(ship: ShipTuning, trail: TrailTuning, cosmetics: readonly string[]): void {
    this.ship?.dispose();
    for (const t of this.trails) {
      this.scene.remove(t.mesh);
      t.dispose();
    }
    this.trails = [];
    this.cosmetics = cosmetics;
    this.ship = createShipVisual(ship, trail, cosmetics, this.options.quality.current);
    this.shipRoot.add(this.ship.root);
    const segments = this.options.quality.profile.trailSegments;
    for (let i = 0; i < this.ship.engineAnchors.length; i++) {
      const ribbon = new RibbonTrail(segments, trail.core, trail.halo, 0.5 + i * 0.04);
      this.scene.add(ribbon.mesh);
      this.trails.push(ribbon);
    }
  }

  /** Subscribes the visual feedback pulses to one race. Idempotent per runtime. */
  bindRuntime(rt: RaceRuntime): void {
    if (this.bound === rt) return;
    this.unbindAll();
    this.bound = rt;
    this.unbind.push(
      rt.bus.on('hit', () => {
        this.hitPulse = 1;
      }),
      rt.bus.on('collapseBreak', () => {
        this.collapsePulse = 1;
      }),
      rt.bus.on('shockwaveStart', () => {
        this.collapsePulse = 1;
      }),
      rt.bus.on('collapseBreak', () => {
        if (this.cosmetics.includes('collapse_trail')) this.collapseWake = 1;
      }),
      rt.bus.on('death', () => {
        this.hitPulse = 1;
      }),
    );
    for (const t of this.trails) t.reset(this.shipRoot.position);
    if (this.track) {
      const p = rt.player;
      this.rig.snap(this.track.path, this.cameraInput(rt, p.speed));
    }
  }

  private unbindAll(): void {
    for (const off of this.unbind) off();
    this.unbind = [];
  }

  private cameraInput(rt: RaceRuntime, maxSpeed: number): CameraInput {
    const p = rt.player;
    return {
      s: p.s,
      u: p.u,
      h: p.h,
      speed: p.speed,
      maxSpeed: Math.max(1, maxSpeed),
      boost: p.boostEnvelope,
      steer: rt.lastInput.steer,
      drift: Math.abs(p.slide),
      laneRoll: rt.laneAttitude.roll,
      bank: p.bank,
      pitch: p.pitchVis,
      shake: p.shakeImpulse,
      warp: rt.spectacle.state.warp,
      interior: rt.spectacle.state.interior,
      vortex: rt.spectacle.state.vortex,
      damage: p.damage,
      perfect: p.perfectTimer > 0.2,
    };
  }

  /** Scene census for the debug panel and the headless harness. */
  get sceneInfo(): { children: number; tunnel: boolean; props: number; ship: boolean; particleCapacity: number } {
    return {
      children: this.scene.children.length,
      tunnel: this.tunnel !== null,
      props: this.propField?.liveCount ?? 0,
      ship: this.ship !== null,
      particleCapacity: this.particles?.capacity ?? 0,
    };
  }

  /** Live particle count, surfaced for the debug panel. */
  get particleCount(): number {
    return this.particles?.liveCount ?? 0;
  }

  /** Applies the quality manager's current tier to every subsystem. */
  applyQuality(): void {
    const budget = this.options.quality.profile;
    const dpr = Math.min(window.devicePixelRatio || 1, budget.dprCap);
    this.renderer.setPixelRatio(dpr * budget.renderScale);
    this.particles?.setSizeScale(budget.tier === 'low' ? 0.85 : 1);
    this.post?.setBloom(budget.bloom && !this.options.reducedMotion, BLOOM.strength, BLOOM.radius, BLOOM.threshold);
    this.post?.setAberration(budget.aberration);
    this.post?.setQualityGrain(budget.tier === 'low' ? 0.012 : 0.024, 0.42);
    for (const t of this.trails) t.setBudget(budget.trailSegments);
    if (this.track && this.biome) {
      this.propField?.dispose();
      if (this.propField) this.props.remove(this.propField.root);
      this.propField = new PropField(this.track.rows, this.track.path, this.biome, budget.tier);
      this.props.add(this.propField.root);
      this.environment.setBiome(this.biome, budget.tier);
    }
    if (this.width > 1) this.resize(this.width, this.height);
  }

  /** Garage and loading presentation: a hero orbit that needs no race state. */
  renderShowcase(dt: number, shipYaw = 0): void {
    this.elapsed += dt;
    this.frameTick++;
    this.showcaseAngle += dt * 0.18;
    if (this.ship) {
      this.ship.root.position.set(0, 0, 0);
      this.ship.root.rotation.set(0, shipYaw + this.showcaseAngle * 0.35, 0);
      this.ship.setBank(Math.sin(this.elapsed * 0.4) * 0.12, 0);
      this.ship.update(dt, {
        boost: 0.3 + Math.sin(this.elapsed * 0.9) * 0.18,
        steer: 0,
        drift: 0,
        throttle: 0.7,
        brake: 0,
        time: this.elapsed,
        damage: 0,
        shield: Math.max(0, Math.sin(this.elapsed * 0.45)) * 0.35,
        phase: false,
        overdrive: 0,
      });
    }
    const radius = 10.5 + Math.sin(this.elapsed * 0.25) * 1.2;
    this.rig.orbit(VEC.set(0, 0, 0), radius, 2.2 + Math.sin(this.elapsed * 0.2) * 0.7, this.showcaseAngle);
    this.environment.follow(this.rig.camera.position);
    this.particles?.update(dt, this.rig.camera);
    this.draw();
  }

  /**
   * Menu and garage backdrop: a slow cinematic dolly down the lane. The same subsystems run
   * as in a race, minus the ship's own telemetry, so what the player sees in the menu is the
   * real corridor rather than a facsimile.
   */
  renderAmbient(dt: number): void {
    const path = this.track?.path;
    if (!path || !this.tunnel || !this.track) {
      this.renderShowcase(dt);
      return;
    }
    const budget = this.options.quality.profile;
    this.elapsed += dt;
    this.frameTick++;
    const span = Math.max(200, this.track.meta.length - 400);
    this.ambientS = (this.ambientS + dt * 95) % span;
    const s = this.ambientS;
    const u = Math.sin(s * 0.0042) * LANE.halfWidth * 0.45;
    const h = LANE.hoverBase + Math.sin(s * 0.0031) * 1.4;
    path.frameAt(s, this.frame);
    this.rig.update(
      dt,
      path,
      {
        s,
        u,
        h,
        speed: 95,
        maxSpeed: 240,
        boost: 0.12 + Math.sin(this.elapsed * 0.7) * 0.12,
        steer: Math.cos(s * 0.0042) * 0.4,
        drift: 0,
        laneRoll: this.frame.roll ?? 0,
        bank: Math.sin(s * 0.0021) * 0.2,
        pitch: 0,
        shake: 0,
        warp: 0,
        interior: 0,
        vortex: 0,
        damage: 0,
        perfect: false,
      },
      budget.tier,
      true,
      false,
    );
    if (this.ship) {
      const body = this.ship.root;
      body.position.copy(path.pointTo(s, u, h, VEC, this.frame));
      body.quaternion.copy(laneOrientation(this.frame, QUAT));
      body.rotateY(-Math.sin(s * 0.0042) * 0.12);
      this.ship.setBank(Math.sin(s * 0.0042) * 0.25, 0);
      this.ship.update(dt, {
        boost: 0.2,
        steer: 0,
        drift: 0,
        throttle: 1,
        brake: 0,
        time: this.elapsed,
        damage: 0,
        shield: 0,
        phase: false,
        overdrive: 0,
      });
    }
    updateTunnel(this.tunnel, this.track.rows, {
      time: this.elapsed,
      playerS: s,
      flow: 0.9,
      unstable: 0,
      hurt: 0,
      bandPulse: 0,
    });
    this.propField?.update(this.track.entities, s, this.elapsed, 0);
    this.particles?.update(dt, this.rig.camera);
    this.speedLines?.update(dt, 0.15, 0.1, 0, budget.speedLines * 0.4, this.rig.camera.fov, this.rig.camera.aspect);
    this.environment.follow(this.rig.camera.position);
    this.environment.update(dt, s, path);
    this.post?.update({
      time: this.elapsed,
      aberration: budget.aberration ? 0.25 : 0,
      boost: 0.1,
      warp: 0,
      hit: 0,
      danger: 0,
      desaturate: 0,
      flashX: 0,
      flashY: 0,
    });
    this.draw();
  }

  /** The per-frame entry point while racing. */
  renderRaceFrame(rt: RaceRuntime, dt: number): void {
    const path = this.track?.path;
    if (!path || !this.tunnel || !this.track) return;
    const budget = this.options.quality.profile;
    const p = rt.player;
    const topSpeed = Math.max(60, p.topSpeed);
    this.elapsed += dt;
    this.frameTick++;
    this.hitPulse = Math.max(0, this.hitPulse - dt * 2.4);
    this.collapsePulse = Math.max(0, this.collapsePulse - dt * 0.8);

    const speedRatio = Math.min(1, p.speed / topSpeed);
    this.rig.update(dt, path, this.cameraInput(rt, topSpeed), budget.tier, this.options.reducedMotion, this.options.shakeEnabled);
    this.rig.setSpeedClipping(p.speed);
    path.frameAt(p.s, this.frame);

    if (this.ship) {
      const world = path.pointTo(p.s, p.u, p.h, VEC, this.frame);
      const body = this.ship.root;
      body.position.copy(world);
      RIGHT.set(this.frame.rx, this.frame.ry, this.frame.rz);
      body.quaternion.copy(laneOrientation(this.frame, QUAT));
      body.rotateY(-p.yawVis);
      body.rotateX(p.pitchVis);
      this.ship.setBank(p.bank, p.pitchVis * 0.4);
      // Owned cosmetics only: both are particle dressing, never a gameplay difference.
      if (this.cosmetics.includes('trail_sparkle') && p.boostEnvelope > 0.35 && this.particles) {
        for (let i = 0; i < 2; i++) {
          const jitter = ((this.frameTick * 7 + i * 13) % 11) / 11 - 0.5;
          this.particles.spawn({
            x: body.position.x - this.frame.dx * 2.4 + RIGHT.x * jitter * 1.6,
            y: body.position.y - this.frame.dy * 2.4 + RIGHT.y * jitter * 1.6 + 0.3,
            z: body.position.z - this.frame.dz * 2.4 + RIGHT.z * jitter * 1.6,
            vx: -this.frame.dx * 26 + jitter * 8,
            vy: -this.frame.dy * 26 + 3,
            vz: -this.frame.dz * 26 + jitter * 8,
            life: 0.5,
            size: 0.5,
            colorIndex: i % 2,
            drag: 1.6,
            growth: 0.4,
          });
        }
      }
      if (this.collapseWake > 0 && this.particles) {
        this.collapseWake = Math.max(0, this.collapseWake - dt * 1.4);
        const count = Math.ceil(this.collapseWake * 3);
        for (let i = 0; i < count; i++) {
          const a = (this.frameTick * 2.399963 + i) % 6.283;
          this.particles.spawn({
            x: body.position.x + Math.cos(a) * 1.5,
            y: body.position.y + Math.sin(a) * 1.2,
            z: body.position.z + Math.sin(a * 2) * 1.5,
            vx: -this.frame.dx * 70,
            vy: 0,
            vz: -this.frame.dz * 70,
            life: 0.85 * this.collapseWake,
            size: 0.9,
            colorIndex: 1,
            drag: 0.9,
            growth: 1.7,
          });
        }
      }
      this.ship.update(dt, {
        boost: p.boostEnvelope,
        steer: rt.lastInput.steer,
        drift: Math.abs(p.slide),
        throttle: rt.lastInput.throttle,
        brake: rt.lastInput.throttle < -0.2 ? 1 : 0,
        time: this.elapsed,
        damage: p.damage,
        shield: p.shieldHits > 0 ? 0.45 + Math.min(1, p.shieldTimer / 4) * 0.55 : 0,
        phase: p.phase > 0,
        overdrive: p.overdrive > 0 ? Math.min(1, p.overdrive / 2) : 0,
      });
    }

    RIGHT.set(this.frame.rx, this.frame.ry, this.frame.rz);
    for (let i = 0; i < this.trails.length; i++) {
      const anchor = this.ship?.engineAnchors[i];
      if (!anchor) continue;
      anchor.getWorldPosition(VEC);
      this.trails[i].sample(VEC, dt, RIGHT, speedRatio);
    }

    updateTunnel(this.tunnel, this.track.rows, {
      time: this.elapsed,
      playerS: p.s,
      flow: 0.25 + speedRatio * 1.8 + p.boostEnvelope * 1.1,
      unstable: Math.min(1, rt.collapse.activeCount / 2),
      hurt: this.hitPulse,
      bandPulse: this.collapsePulse,
    });
    this.propField?.update(rt.entities, p.s, rt.time, rt.spectacle.state.warp * 900);
    if (this.fx && this.particles) this.fx.dispatch(rt.fx, budget.effectBudget, this.rig.camera.position);
    this.particles?.update(dt, this.rig.camera);

    this.speedLines?.update(
      dt,
      Math.max(0, (p.speed - topSpeed * 0.5) / (topSpeed * 0.5)),
      p.boostEnvelope,
      rt.spectacle.state.warp,
      budget.speedLines,
      this.rig.camera.fov,
      this.rig.camera.aspect,
    );

    this.environment.follow(this.rig.camera.position);
    this.environment.update(dt, p.s, path);
    this.post?.update({
      time: this.elapsed,
      aberration: budget.aberration ? 0.35 + speedRatio * 1.1 + p.boostEnvelope * 1.5 : 0,
      boost: p.boostEnvelope,
      warp: rt.spectacle.state.warp,
      hit: this.hitPulse,
      danger: Math.min(1, this.collapsePulse + rt.collapse.activeCount * 0.15),
      desaturate: p.damage > 0.6 ? (p.damage - 0.6) * 0.9 : 0,
      flashX: 0,
      flashY: 0,
    });
    this.draw();
  }

  private draw(): void {
    if (this.post) this.post.render();
    else this.renderer.render(this.scene, this.rig.camera);
  }

  setMotionSettings(reducedMotion: boolean, shakeEnabled: boolean): void {
    this.options.reducedMotion = reducedMotion;
    this.options.shakeEnabled = shakeEnabled;
    // Bloom is a flash source by definition; honour the reduced-motion promise live.
    const budget = this.options.quality.profile;
    this.post?.setBloom(budget.bloom && !reducedMotion, BLOOM.strength, BLOOM.radius, BLOOM.threshold);
  }

  /** Frees track-bound resources without tearing down the renderer itself. */
  private disposeTrackResources(): void {
    this.unbindAll();
    this.bound = null;
    this.tunnel?.dispose();
    if (this.tunnel) this.props.remove(this.tunnel.mesh);
    this.tunnel = null;
    this.propField?.dispose();
    if (this.propField) this.props.remove(this.propField.root);
    this.propField = null;
    if (this.particles) {
      this.scene.remove(this.particles.points);
      this.particles.dispose();
      this.particles = null;
    }
    this.fx = null;
  }

  dispose(): void {
    this.disposeTrackResources();
    this.speedLines?.dispose();
    this.speedLines = null;
    this.post?.dispose();
    this.post = null;
    for (const t of this.trails) t.dispose();
    this.trails = [];
    this.ship?.dispose();
    this.ship = null;
    this.environment.dispose();
    this.rig.dispose();
    disposeFactory();
    disposeShipFactory();
    disposeTextures();
    this.scene.clear();
    this.renderer.dispose();
  }
}
