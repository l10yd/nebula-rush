import {
  DoubleSide,
  DynamicDrawUsage,
  InstancedMesh,
  Matrix4,
  Object3D,
  Quaternion,
  Vector3,
} from 'three';
import { LANE } from '../data/config.ts';
import type { BiomeTuning, QualityTier } from '../data/types.ts';
import { applyMotion } from '../game/CollisionSystem.ts';
import { EF, type LaneEntity, type LaneRow } from '../game/trackTypes.ts';
import type { LanePath } from '../game/LanePath.ts';
import { createFrame } from '../game/LanePath.ts';
import {
  anomalyCoreGeometry,
  anomalyGeometry,
  asteroidGeometry,
  boostPadGeometry,
  emissiveMaterial,
  gateGeometry,
  gateStrutGeometry,
  mineGeometry,
  pickupGeometry,
  rogueGeometry,
  standardMaterial,
  wreckGeometry,
} from './factory/PropFactory.ts';

/** Instance budgets. Channels share a budget key so the totals stay predictable per tier. */
const BUDGET: Record<string, number> = {
  rock: 150,
  mine: 36,
  plasma: 12,
  anomaly: 16,
  rogue: 22,
  gate: 40,
  pad: 32,
  pickup: 36,
  wreck: 30,
};

const TIER_SCALE: Record<QualityTier, number> = { ultra: 1.4, high: 1, medium: 0.72, low: 0.48 };

interface Channel {
  mesh: InstancedMesh;
  capacity: number;
  used: number;
  budget?: string;
}

const AXIS_Y = new Vector3(0, 1, 0);
const AXIS_Z = new Vector3(0, 0, 1);

/**
 * Draws every hazard, gate, pad and pickup in the visible lane window with one instanced
 * draw call per visual class. Instances are refilled each frame from live entity state, so
 * collected cells, detonated mines and shattered rock disappear without any geometry churn.
 */
export class PropField {
  readonly root = new Object3D();
  /** Instances drawn on the last frame, for the debug panel. */
  get liveCount(): number {
    let n = 0;
    for (const mesh of this.instanced) n += mesh.count;
    return n;
  }

  private readonly channels = new Map<string, Channel>();
  private readonly scratch = new Object3D();
  private readonly frame = createFrame();
  private readonly position = new Vector3();
  private readonly basis = new Matrix4();
  private readonly right = new Vector3();
  private readonly up = new Vector3();
  private readonly fwd = new Vector3();
  private readonly laneQuat = new Quaternion();
  private readonly spinQuat = new Quaternion();
  private readonly instanced: InstancedMesh[] = [];
  private readonly tierScale: number;
  private readonly rows: LaneRow[];
  private readonly path: LanePath;

  constructor(rows: LaneRow[], path: LanePath, biome: BiomeTuning, quality: QualityTier) {
    this.rows = rows;
    this.path = path;
    this.tierScale = TIER_SCALE[quality] ?? 1;
    const detail = quality === 'ultra' ? 2 : quality === 'high' ? 1 : 0;
    const rock = standardMaterial('asteroid', { rock: biome.palette.mid, metal: biome.tunnelTint });
    const shard = standardMaterial('shard', { rock: biome.palette.deep, metal: biome.tunnelTint });
    const metal = standardMaterial('rogue', { rock: biome.palette.mid, metal: biome.tunnelTint });
    const wreckage = standardMaterial('wreck', { rock: biome.palette.deep, metal: biome.tunnelTint });

    const glow = (hex: string, intensity: number) => emissiveMaterial(hex, intensity);
    const accent = glow(biome.palette.accent, 1.7);
    const hot = glow(biome.palette.hot, 1.5);
    const danger = glow(biome.palette.danger, 1.4);
    const alt = glow(biome.palette.accentAlt, 1.25);

    this.add('rock0', asteroidGeometry(0, detail), rock, 'rock');
    this.add('rock1', asteroidGeometry(1, detail), rock, 'rock');
    this.add('rock2', asteroidGeometry(2, detail), rock, 'rock');
    this.add('rock3', asteroidGeometry(3, detail), rock, 'rock');
    this.add('shard', asteroidGeometry(2, 0), shard, 'rock');
    this.add('mine', mineGeometry(), metal, 'mine');
    this.add('rogue', rogueGeometry(), metal, 'rogue');
    this.add('wreck', wreckGeometry(0), wreckage, 'wreck');
    this.add('pad', boostPadGeometry(), accent, 'pad');
    this.add('pickup-energy', pickupGeometry('energy'), hot, 'pickup');
    this.add('pickup-shield', pickupGeometry('shield'), alt, 'pickup');
    this.add('pickup-overdrive', pickupGeometry('overdrive'), danger, 'pickup');
    this.add('pickup-phase', pickupGeometry('phase'), alt, 'pickup');
    this.add('pickup-magnet', pickupGeometry('magnet'), danger, 'pickup');
    this.add('pickup-credit', pickupGeometry('credit'), hot, 'pickup');
    this.add('plasma', gateGeometry(), this.doubleSided(danger), 'plasma');
    this.add('anomaly', anomalyGeometry(), this.doubleSided(alt), 'anomaly');
    this.add('anomalyCore', anomalyCoreGeometry(), this.doubleSided(glow(biome.palette.deep, 0.9)), 'anomaly');
    this.add('gate', gateGeometry(), accent, 'gate');
    this.add('gate-strut', gateStrutGeometry(), wreckage, 'gate');
  }

  private doubleSided(material: ReturnType<typeof emissiveMaterial>): ReturnType<typeof emissiveMaterial> {
    material.side = DoubleSide;
    return material;
  }

  private add(key: string, geometry: ReturnType<typeof gateGeometry>, material: InstancedMesh['material'], budget: string): void {
    const capacity = Math.max(4, Math.round((BUDGET[budget] ?? 40) * this.tierScale));
    const mesh = new InstancedMesh(geometry, material, capacity);
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.name = key;
    this.root.add(mesh);
    this.channels.set(key, { mesh, capacity, used: 0, budget });
    this.instanced.push(mesh);
  }

  /**
   * Refills all instance buffers.
   *
   * @param far extra draw distance in metres, raised while warping so the tunnel stays full
   */
  update(entities: LaneEntity[], playerS: number, time: number, far = 0): void {
    for (const ch of this.channels.values()) ch.used = 0;
    const back = playerS - LANE.windowBack;
    const ahead = playerS + LANE.windowAhead + (this.tierScale >= 1 ? 240 : 120) + far;

    for (let i = 0; i < entities.length; i++) {
      const e = entities[i];
      if (e.s < back || e.s > ahead) continue;
      if ((e.flags & EF.consumed) !== 0 || (e.flags & EF.exploded) !== 0) continue;
      const row = this.rows[e.row];
      if (!row) continue;
      // Motion is evaluated by the same function collision uses, at the same sim time.
      applyMotion(e, time, Math.max(1, row.halfWidth - 0.5), row.height);
      this.place(e, row, time);
    }

    for (const ch of this.channels.values()) {
      if (ch.mesh.count !== ch.used) {
        ch.mesh.count = ch.used;
        ch.mesh.instanceMatrix.needsUpdate = true;
      }
    }
  }

  private place(e: LaneEntity, row: LaneRow, time: number): void {
    this.path.frameAt(e.s, this.frame);
    this.path.pointTo(e.s, e.cu, e.ch, this.position, this.frame);
    const laneQuat = this.orientation();
    const scale = Math.max(0.35, e.size);

    switch (e.kind) {
      case 'asteroid':
        this.emit(`rock${e.variant % 4}`, this.position, laneQuat, scale, scale, scale);
        break;
      case 'shard':
        this.emit('shard', this.position, laneQuat, scale, scale * 0.8, scale);
        break;
      case 'wreck':
        this.emit('wreck', this.position, laneQuat, scale, scale, scale);
        break;
      case 'mine': {
        const armed = (e.flags & EF.armed) !== 0;
        const pulse = 1 + Math.sin(time * (armed ? 26 : 5) + e.phase0) * (armed ? 0.18 : 0.04);
        this.emit('mine', this.position, laneQuat, scale * pulse, scale * pulse, scale * pulse);
        break;
      }
      case 'rogue': {
        this.spinQuat.setFromAxisAngle(AXIS_Z, Math.sin(time * 1.4 + e.phase0) * 0.3);
        laneQuat.multiply(this.spinQuat);
        this.emit('rogue', this.position, laneQuat, scale, scale, scale);
        break;
      }
      case 'plasma': {
        const width = Math.max(1, e.size);
        const throb = 0.5 + Math.sin(time * 7 + e.phase0) * 0.16;
        this.emit('plasma', this.position, laneQuat, width, width * 0.74, throb);
        break;
      }
      case 'anomaly': {
        this.spinQuat.setFromAxisAngle(AXIS_Z, time * 0.9 + e.phase0);
        laneQuat.multiply(this.spinQuat);
        this.emit('anomaly', this.position, laneQuat, scale, scale, scale);
        this.emit('anomalyCore', this.position, laneQuat, scale * 0.62, scale * 0.62, scale * 0.62);
        break;
      }
      case 'gate': {
        const radius = Math.max(1.8, e.size);
        // A closing gate shrinks its hoop: the read has to be about the hole, not the frame.
        const open = 0.42 + 0.58 * clamp01(e.t);
        const tremble = e.t < 0.66 ? 1 + Math.sin(time * 22) * 0.015 : 1;
        this.emit('gate', this.position, laneQuat, radius * open * tremble, radius * open * tremble, 1);
        if (this.tierScale > 0.6) {
          for (const side of [-1, 0, 1]) {
            this.spinQuat.setFromAxisAngle(AXIS_Y, side * 0.5);
            this.right.set(side * radius * 0.92, -row.height * 0.5 + radius * 0.15, 0).applyQuaternion(laneQuat);
            this.emit('gate-strut', this.position.add(this.right), this.laneQuat.clone().multiply(this.spinQuat), radius * 0.14, row.height * 0.62, radius * 0.14);
            this.position.sub(this.right);
          }
        }
        break;
      }
      case 'boostpad': {
        const chev = 1 + Math.sin(time * 7 + e.s * 0.08) * 0.09;
        this.emit('pad', this.position, laneQuat, e.size * chev, e.size * 0.55 * chev, 0.7);
        break;
      }
      case 'pickup': {
        const bob = Math.sin(time * 3 + e.phase0) * 0.35;
        const pulse = 1 + Math.sin(time * 5 + e.phase0) * 0.07;
        this.up.set(0, bob, 0).applyQuaternion(laneQuat);
        this.spinQuat.setFromAxisAngle(AXIS_Z, time * 1.6 + e.phase0);
        this.emit(`pickup-${e.pickup || 'energy'}`, this.position.add(this.up), laneQuat.clone().multiply(this.spinQuat), scale * pulse, scale * pulse, scale * pulse);
        this.position.sub(this.up);
        break;
      }
      default:
        break;
    }
  }

  private emit(key: string, pos: Vector3, quat: Quaternion, sx: number, sy: number, sz: number): void {
    const ch = this.channels.get(key);
    if (!ch) return;
    if (ch.budget) {
      const total = this.budgetUsed(ch.budget);
      if (total >= Math.round((BUDGET[ch.budget] ?? 40) * this.tierScale)) return;
    }
    if (ch.used >= ch.capacity) return;
    const d = this.scratch;
    d.position.copy(pos);
    d.quaternion.copy(quat);
    d.scale.set(sx, sy, sz);
    d.updateMatrix();
    ch.mesh.setMatrixAt(ch.used++, d.matrix);
  }

  private budgetUsed(budget: string): number {
    let total = 0;
    for (const ch of this.channels.values()) if (ch.budget === budget) total += ch.used;
    return total;
  }

  /** Lane-frame orientation baked from the path, so props sit square in a banked corridor. */
  private orientation(): Quaternion {
    this.right.set(this.frame.rx, this.frame.ry, this.frame.rz);
    this.up.set(this.frame.ux, this.frame.uy, this.frame.uz);
    this.fwd.set(-this.frame.dx, -this.frame.dy, -this.frame.dz);
    this.basis.makeBasis(this.right, this.up, this.fwd);
    return this.laneQuat.setFromRotationMatrix(this.basis);
  }

  dispose(): void {
    for (const mesh of this.instanced) mesh.dispose();
    this.instanced.length = 0;
    this.channels.clear();
    this.root.clear();
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
