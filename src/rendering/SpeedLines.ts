import { BufferGeometry, Color, DoubleSide, DynamicDrawUsage, Float32BufferAttribute, Mesh, ShaderMaterial } from 'three';
import type { Camera } from 'three';

const VERT = /* glsl */ `
precision highp float;

attribute vec4 aTint;   // rgb colour, a alpha

varying vec4 vTint;

void main() {
  vTint = aTint;
  // The mesh is parented to the camera, so modelViewMatrix is the identity and these
  // coordinates are already view space.
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAG = /* glsl */ `
precision highp float;

varying vec4 vTint;

void main() {
  if (vTint.a <= 0.002) discard;
  gl_FragColor = vec4(vTint.rgb * vTint.a, vTint.a);
}
`;

interface Streak {
  /** Direction of the streak's ray in the view plane. */
  ux: number;
  uy: number;
  /** Depth in view space (negative, ahead of the camera). */
  z: number;
  /** How far behind the head the tail trails, as a fraction of depth. */
  span: number;
  /** 0..1 brightness weight. */
  bias: number;
}

const DEEP = -190;
const NEAR_Z = -7;

/**
 * Speed, boost and warp streaks, built in camera space.
 *
 * Camera space is deliberate: a streak must point exactly at the vanishing point no matter how
 * the chase camera rolls, banks or shakes, and deriving them from world velocity would smear
 * during a bank. Each streak rides a fixed ray out of the centre, so the frame reads as forward
 * motion rather than noise, and the middle of the screen is left clear for the road.
 */
export class SpeedLines {
  readonly mesh: Mesh;
  private readonly geometry = new BufferGeometry();
  private readonly material: ShaderMaterial;
  private readonly position: Float32Array;
  private readonly tint: Float32Array;
  private readonly streaks: Streak[] = [];
  private readonly colour: Color;
  private readonly positionAttr: Float32BufferAttribute;
  private readonly tintAttr: Float32BufferAttribute;

  constructor(count: number, color: Color | string = '#cfeeff') {
    const n = Math.max(8, Math.floor(count));
    this.colour = color instanceof Color ? color : new Color(color);
    this.position = new Float32Array(n * 6 * 3);
    this.tint = new Float32Array(n * 6 * 4);
    this.positionAttr = new Float32BufferAttribute(this.position, 3).setUsage(DynamicDrawUsage);
    this.tintAttr = new Float32BufferAttribute(this.tint, 4).setUsage(DynamicDrawUsage);
    this.geometry.setAttribute('position', this.positionAttr);
    this.geometry.setAttribute('aTint', this.tintAttr);
    this.geometry.setDrawRange(0, 0);

    this.material = new ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: DoubleSide,
      toneMapped: false,
    });
    this.mesh = new Mesh(this.geometry, this.material);
    this.mesh.name = 'speed-lines';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6;
    this.mesh.visible = false;

    for (let i = 0; i < n; i++) {
      // Radii are spread out from the centre so nothing ever crosses the racing line.
      const golden = (i * 2.39996323) % (Math.PI * 2);
      const ring = 0.3 + ((i * 37) % 53) / 53 * 0.7;
      this.streaks.push({
        ux: Math.cos(golden) * ring,
        uy: Math.sin(golden) * ring,
        z: DEEP + (i / n) * (NEAR_Z - DEEP),
        span: 0.16 + ((i * 61) % 41) / 41 * 0.3,
        bias: 0.3 + ((i * 97) % 89) / 89 * 0.7,
      });
    }
  }

  /** Parent to the camera so the streaks ride the view exactly. */
  attachTo(camera: Camera): void {
    camera.add(this.mesh);
  }

  /**
   * @param intensity 0..1 speed above cruise
   * @param boost     0..1 boost envelope
   * @param warp      0..1 the wormhole spectacle beat
   * @param budget    0..1 quality multiplier
   */
  update(dt: number, intensity: number, boost: number, warp: number, budget: number, fovDeg: number, aspect: number): void {
    const energy = Math.min(1.4, Math.max(0, intensity) * 0.5 + boost * 0.8 + warp * 1.5);
    const active = Math.round(this.streaks.length * Math.min(1, energy * Math.max(0, budget)));
    if (active <= 0) {
      if (this.mesh.visible) {
        this.mesh.visible = false;
        this.geometry.setDrawRange(0, 0);
      }
      return;
    }
    this.mesh.visible = true;

    const step = Math.min(dt, 1 / 30);
    const speed = 130 + energy * 520 + warp * 1400;
    // Perspective spread: a direction times depth gives the view-space offset.
    const spread = Math.tan((((fovDeg || 80) * Math.PI) / 180) * 0.5) * Math.min(aspect || 1, 2.4);
    const width = 0.06 + boost * 0.06 + warp * 0.16;
    const pinch = 1 - warp * 0.42;

    let vi = 0;
    for (let i = 0; i < active; i++) {
      const s = this.streaks[i];
      s.z += step * speed * (0.6 + s.bias * 0.8);
      if (s.z > NEAR_Z) s.z -= NEAR_Z - DEEP;

      const zHead = s.z;
      const zTail = Math.min(NEAR_Z, s.z * (1 - s.span * (1 + warp * 1.6)));
      const ux = s.ux * pinch;
      const uy = s.uy * pinch;
      // Perpendicular in the view plane keeps the ribbon square to its own ray.
      const px = -uy;
      const py = ux;
      const hScale = -zHead * spread;
      const tScale = -zTail * spread;
      const alpha = Math.min(1, (0.1 + energy * 0.85) * (0.35 + s.bias));

      this.writeQuad(ux, uy, px, py, hScale, tScale, zHead, zTail, width, alpha, vi);
      vi += 6;
    }
    this.positionAttr.needsUpdate = true;
    this.tintAttr.needsUpdate = true;
    this.geometry.setDrawRange(0, vi);
  }

  private writeQuad(
    ux: number,
    uy: number,
    px: number,
    py: number,
    hScale: number,
    tScale: number,
    zHead: number,
    zTail: number,
    width: number,
    alpha: number,
    start: number,
  ): void {
    const c = this.colour;
    const corners: [number, number, number, number][] = [
      // head edge (a point), tail edge (a short segment): a tapered ribbon.
      [ux * hScale, uy * hScale, zHead, 0],
      [ux * tScale + px * width, uy * tScale + py * width, zTail, alpha],
      [ux * tScale - px * width, uy * tScale - py * width, zTail, alpha * 0.7],
      [ux * hScale, uy * hScale, zHead, 0],
      [ux * tScale - px * width, uy * tScale - py * width, zTail, alpha * 0.7],
      [ux * hScale - px * width * 0.25, uy * hScale - py * width * 0.25, zHead, 0],
    ];
    for (let k = 0; k < 6; k++) {
      const [x, y, z, a] = corners[k];
      const p = (start + k) * 3;
      const t = (start + k) * 4;
      this.position[p] = x;
      this.position[p + 1] = y;
      this.position[p + 2] = z;
      this.tint[t] = c.r;
      this.tint[t + 1] = c.g;
      this.tint[t + 2] = c.b;
      this.tint[t + 3] = a;
    }
  }

  reset(): void {
    this.geometry.setDrawRange(0, 0);
    this.mesh.visible = false;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }
}
