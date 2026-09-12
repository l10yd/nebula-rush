import { AdditiveBlending, BufferAttribute, BufferGeometry, Color, DoubleSide, DynamicDrawUsage, Float32BufferAttribute, Mesh, ShaderMaterial, Vector3 } from 'three';

const VERT = /* glsl */ `
precision highp float;

attribute float aAge;     // 0 at the ship, 1 at the oldest sample
attribute float aSide;    // -1 / 1 across the ribbon

varying float vAge;
varying float vEdge;

void main() {
  vAge = aAge;
  vEdge = abs(aSide);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAG = /* glsl */ `
precision highp float;

uniform vec3 uCore;
uniform vec3 uHalo;
uniform float uOpacity;
uniform float uWidth;

varying float vAge;
varying float vEdge;

void main() {
  float across = 1.0 - vEdge;
  // Hot centre, soft chromatic edge: the trail reads as light, not as a painted ribbon.
  float body = pow(clamp(across, 0.0, 1.0), 1.6);
  float along = 1.0 - vAge;
  float a = body * along * uOpacity;
  if (a <= 0.003) discard;
  vec3 col = mix(uHalo, uCore, body * along);
  gl_FragColor = vec4(col * a * 1.6, a);
}
`;

/**
 * A ribbon of past positions behind the ship.
 *
 * The history is a fixed ring, so a trail costs the same at three minutes as at three seconds
 * and never allocates mid-race. Width tapers with age, which is what makes it read as motion
 * rather than as a static tube.
 */
export class RibbonTrail {
  readonly mesh: Mesh;
  private readonly geometry = new BufferGeometry();
  private readonly material: ShaderMaterial;
  private readonly position: Float32Array;
  private readonly age: Float32Array;
  private readonly side: Float32Array;
  private readonly history: Vector3[] = [];
  private readonly posAttr: Float32BufferAttribute;
  private readonly ageAttr: Float32BufferAttribute;
  private samples: number;
  private writeIndex = 0;
  private filled = 0;
  private timer = 0;
  private interval: number;

  constructor(samples: number, core: Color | string, halo: Color | string, width: number, sampleHz = 90) {
    this.samples = Math.max(4, Math.floor(samples));
    this.interval = 1 / sampleHz;
    const verts = this.samples * 2;
    this.position = new Float32Array(verts * 3);
    this.age = new Float32Array(verts);
    this.side = new Float32Array(verts);
    for (let i = 0; i < this.samples; i++) this.history.push(new Vector3());
    this.posAttr = new Float32BufferAttribute(this.position, 3).setUsage(DynamicDrawUsage);
    this.ageAttr = new Float32BufferAttribute(this.age, 1).setUsage(DynamicDrawUsage);
    const sideAttr = new Float32BufferAttribute(this.side, 1).setUsage(DynamicDrawUsage);
    this.geometry.setAttribute('position', this.posAttr);
    this.geometry.setAttribute('aAge', this.ageAttr);
    this.geometry.setAttribute('aSide', sideAttr);

    const indices = new Uint16Array((this.samples - 1) * 6);
    let k = 0;
    for (let i = 0; i < this.samples - 1; i++) {
      const a = i * 2;
      indices[k++] = a;
      indices[k++] = a + 1;
      indices[k++] = a + 2;
      indices[k++] = a + 1;
      indices[k++] = a + 3;
      indices[k++] = a + 2;
    }
    this.geometry.setIndex(new BufferAttribute(indices, 1));
    this.geometry.boundingSphere = null;

    this.material = new ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      blending: AdditiveBlending,
      toneMapped: false,
      uniforms: {
        uCore: { value: new Color(core) },
        uHalo: { value: new Color(halo) },
        uOpacity: { value: 0.9 },
        uWidth: { value: width },
      },
    });
    this.mesh = new Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    this.mesh.name = 'ribbon-trail';
    for (let i = 0; i < verts; i++) this.side[i] = i % 2 === 0 ? -1 : 1;
  }

  setColors(core: Color | string, halo: Color | string): void {
    (this.material.uniforms.uCore.value as Color).set(core as string);
    (this.material.uniforms.uHalo.value as Color).set(halo as string);
  }

  setWidth(width: number): void {
    this.material.uniforms.uWidth.value = width;
  }

  setOpacity(opacity: number): void {
    this.material.uniforms.uOpacity.value = opacity;
  }

  /** @param anchor live position of one nozzle; the ribbon is extruded between head and tail */
  sample(anchor: Vector3, dt: number, perpendicular: Vector3, speedRatio: number): void {
    this.timer += dt;
    if (this.timer < this.interval) {
      this.updateGeometry(perpendicular, speedRatio);
      return;
    }
    this.timer = 0;
    this.history[this.writeIndex].copy(anchor);
    this.writeIndex = (this.writeIndex + 1) % this.samples;
    this.filled = Math.min(this.samples, this.filled + 1);
    this.updateGeometry(perpendicular, speedRatio);
  }

  private updateGeometry(perpendicular: Vector3, speedRatio: number): void {
    const count = this.filled;
    if (count < 2) {
      this.geometry.setDrawRange(0, 0);
      return;
    }
    const width = (this.material.uniforms.uWidth.value as number) * (0.35 + speedRatio * 0.9);
    for (let i = 0; i < count; i++) {
      // Oldest sample first so the taper runs away from the ship.
      const sampleIndex = (this.writeIndex + i) % this.samples;
      const p = this.history[sampleIndex];
      const age = count > 1 ? i / (count - 1) : 0;
      const half = width * (1 - age * 0.82) * 0.5;
      const v = i * 2;
      this.position[v * 3] = p.x - perpendicular.x * half;
      this.position[v * 3 + 1] = p.y - perpendicular.y * half;
      this.position[v * 3 + 2] = p.z - perpendicular.z * half;
      this.position[(v + 1) * 3] = p.x + perpendicular.x * half;
      this.position[(v + 1) * 3 + 1] = p.y + perpendicular.y * half;
      this.position[(v + 1) * 3 + 2] = p.z + perpendicular.z * half;
      this.age[v] = age;
      this.age[v + 1] = age;
    }
    this.posAttr.needsUpdate = true;
    this.ageAttr.needsUpdate = true;
    this.geometry.setDrawRange(0, (count - 1) * 6);
  }

  reset(position: Vector3): void {
    for (const v of this.history) v.copy(position);
    this.writeIndex = 0;
    this.filled = 0;
    this.timer = 0;
    this.geometry.setDrawRange(0, 0);
  }

  /** Shortens the ribbon on lower tiers instead of changing its look. */
  setBudget(samples: number): void {
    this.samples = Math.max(4, Math.min(this.history.length, Math.floor(samples)));
    this.filled = Math.min(this.filled, this.samples);
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
