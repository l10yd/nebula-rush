import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DataTexture,
  DoubleSide,
  Float32BufferAttribute,
  FloatType,
  Mesh,
  MeshStandardMaterial,
  NearestFilter,
  NoColorSpace,
  RGBAFormat,
  ShaderMaterial,
  Texture,
  Vector3,
} from 'three';
import { LANE } from '../data/config.ts';
import type { BiomeTuning, QualityTier } from '../data/types.ts';
import type { LanePath } from '../game/LanePath.ts';
import type { LaneRow } from '../game/trackTypes.ts';
import { noiseTexture } from './ProceduralTextures.ts';

const PANEL_FLOOR = 0;
const PANEL_CEILING = 1;
const PANEL_LEFT = 2;
const PANEL_RIGHT = 3;
const PANEL_MEDIAN_L = 4;
const PANEL_MEDIAN_R = 5;

/** How far a fracturing panel peels away from the corridor before it drops out entirely. */
const PEEL_DISTANCE = 5.5;
const SAG_DISTANCE = 4.2;

/**
 * Author-facing hexes are screen colours. `new Color(hex)` decodes them into three's linear
 * working space, which is correct for lit materials — but the tunnel shader applies no lighting
 * of its own, and a value like #0a1630 lands at 0.003..0.03 linear, under the floor where ACES
 * tone mapping and the sRGB output encode crush it to black. Re-encoding the channels back to
 * display space makes the authored matte tones survive the grade and land where they read.
 */
function displaySpaceColor(hex: string): Color {
  return new Color(hex).convertLinearToSRGB();
}

const VERT = /* glsl */ `
precision highp float;

#define PEEL_DISTANCE ${PEEL_DISTANCE.toFixed(2)}
#define SAG_DISTANCE ${SAG_DISTANCE.toFixed(2)}

attribute vec4 aMeta;      // x: station, y: panel, z: lane u (-1..1), w: height 0..1
attribute vec2 aDims;      // x: half width, y: corridor height
attribute vec3 aNormal;    // inward facing
attribute vec3 aTan;       // along lane

uniform sampler2D uRowData;
uniform float uRowCount;
uniform float uRowLen;
uniform float uTime;

varying vec3 vWorld;
varying vec3 vNormal;
varying vec3 vView;
varying float vS;
varying float vUNorm;
varying float vH;
varying float vPanel;
varying float vPhase;
varying float vProg;
varying float vBand0;
varying float vBand1;
varying float vInBand;
varying float vSplit;
varying float vDist;
varying float vStation;

float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}

void main() {
  float station = aMeta.x;
  float row = clamp(floor(station), 0.0, uRowCount - 1.0);
  vec4 d = texture2D(uRowData, vec2((row + 0.5) / uRowCount, 0.5));
  float phase = floor(d.r + 0.0001);
  float prog = clamp(fract(d.r + 0.0001), 0.0, 1.0);

  vStation = station;
  vPanel = aMeta.y;
  vUNorm = aMeta.z;
  vH = aMeta.w;
  vPhase = phase;
  vProg = prog;
  vBand0 = d.g;
  vBand1 = d.b;
  vSplit = d.a;
  vS = station * uRowLen;

  float bandSpan = max(0.0001, d.b - d.g);
  float bandCenter = (d.g + d.b) * 0.5;
  // Distance in normalised lane units from the unsafe band's nearest edge.
  float edge = d.g > d.b ? 1.0 : min(abs(aMeta.z - d.g), abs(aMeta.z - d.b)) / max(bandSpan, 0.25);
  float insideBand = d.g > d.b ? 0.0 : (aMeta.z >= d.g && aMeta.z <= d.b ? 1.0 : 0.0);
  vInBand = insideBand;

  vec3 pos = position;
  // Panel jitter keeps a break looking structural instead of a clean slice.
  float jitter = (hash11(station * 3.7 + aMeta.y * 11.0) - 0.5);
  if (phase >= 1.0 && insideBand > 0.5) {
    float t = phase < 2.0 ? prog * 0.12 : phase < 3.0 ? 0.12 + prog * 0.88 : 1.0;
    if (phase > 3.0) t = 1.0 - prog;
    pos -= aNormal * (t * PEEL_DISTANCE);
    pos.y -= t * SAG_DISTANCE;
    pos += aTan * (t * jitter * 3.0);
    pos += aNormal * (t * t * jitter * 1.2);
  } else if (phase >= 1.0) {
    // Neighbouring panels bow outward as the section comes apart.
    float sympathy = (phase >= 2.0 ? prog : prog * 0.3) * max(0.0, 1.0 - edge * 1.6);
    pos -= aNormal * sympathy * 0.55;
    pos.y -= sympathy * 0.25;
  }

  vec4 world = modelMatrix * vec4(pos, 1.0);
  vWorld = world.xyz;
  vNormal = normalize(mat3(modelMatrix) * aNormal);
  vec4 mv = viewMatrix * world;
  vView = -mv.xyz;
  vDist = -mv.z;
  gl_Position = projectionMatrix * mv;
  // Pull far surfaces in to avoid z-fighting with the sky, but ONLY in front of the eye:
  // clamping a behind-camera vertex (w < 0) makes the hardware triangle clipper interpolate
  // clip coords across the eye plane and smears huge garbage polygons over the whole frame.
  if (gl_Position.w > 0.0) gl_Position.z = min(gl_Position.z, gl_Position.w * 0.9995);
}
`;

const FRAG = /* glsl */ `
precision highp float;

uniform vec3 uDeep;
uniform vec3 uMid;
uniform vec3 uAccent;
uniform vec3 uAccentAlt;
uniform vec3 uHot;
uniform vec3 uDanger;
uniform vec3 uFogColor;
uniform float uFogNear;
uniform float uFogFar;
uniform float uTime;
uniform float uFlow;
uniform float uPlayerS;
uniform float uRowLen;
uniform float uUnstable;
uniform sampler2D uNoise;
uniform float uGrain;
uniform float uHurt;
uniform float uBandPulse;

varying vec3 vWorld;
varying vec3 vNormal;
varying vec3 vView;
varying float vS;
varying float vUNorm;
varying float vH;
varying float vPanel;
varying float vPhase;
varying float vProg;
varying float vBand0;
varying float vBand1;
varying float vInBand;
varying float vSplit;
varying float vDist;
varying float vStation;

void main() {
  // Dissolve: a gone section must actually be see-through, so drop those fragments.
  if (vInBand > 0.5 && vPhase >= 2.0) {
    float cut = vPhase < 3.0 ? vProg : (vPhase < 4.0 ? 1.0 : 1.0 - vProg);
    vec2 nseed = vec2(vStation * 0.37, vPanel * 1.7 + vUNorm * 3.0);
    float nz = texture2D(uNoise, nseed * 0.05).r;
    if (nz < cut * 1.15 - 0.08) discard;
  }

  vec3 n = normalize(vNormal);
  vec3 v = normalize(vView);
  float facing = clamp(dot(n, v), 0.0, 1.0);
  // Grazing surfaces must stay visible. The corridor palette is dark matte, and with a steep
  // facing curve every wall the player looked DOWN along dropped into the same black as the
  // void behind the fog — so each curved section read as a black rectangle with a turquoise
  // frame standing across the road: the only pixels bright enough to survive the grade were
  // the accent edge lines. Grazing angles now keep at least 62% of a panel's tone.
  float facingShade = 0.62 + 0.38 * pow(facing, 0.7);

  float side = abs(vUNorm);
  float isWall = vPanel > 1.5 && vPanel < 3.5 ? 1.0 : 0.0;
  float isMedian = vPanel > 3.5 ? 1.0 : 0.0;
  float isCeil = vPanel > 0.5 && vPanel < 1.5 ? 1.0 : 0.0;
  float floorLike = vPanel < 1.5 ? 1.0 : 0.0;

  // The corridor is a road and it must READ as one at speed. uMid/uDeep arrive in display
  // space (see buildTunnel), so this hierarchy is what the player actually sees: floor is the
  // brightest plane in the frame, walls a clear step darker, ceiling dim, the median fins a
  // solid divider. Dark biomes (deep_space mid ~ (0.04,0.09,0.19)) otherwise collapse under the
  // ACES + sRGB grade to a value indistinguishable from the void, so the base tone is floored
  // to a legible slate: this keeps the tube reading as ENCLOSED (walls and ceiling present)
  // instead of a road floating in black, without washing the neon look back on.
  vec3 tone = max(uMid, vec3(0.11, 0.13, 0.17));
  vec3 base = tone * 1.15;
  base = mix(base, tone * 0.82, isWall);
  base = mix(base, tone * 0.5, isCeil);
  base = mix(base, mix(uDeep, tone, 0.9) * 0.95, isMedian);
  // A soft fall-off up the walls and toward the far rail keeps the tube from flattening out.
  base *= 1.0 - isWall * vH * 0.28;
  vec3 col = base * facingShade;

  // Road markings: a dim dashed centre guide plus thin edge lines where the floor meets the
  // walls. They orient the player at 250 km/h without becoming the only lit thing left.
  float floorEdge = smoothstep(0.94, 1.0, side) * floorLike;
  float wallFoot = isWall * smoothstep(0.06, 0.0, vH);
  col += uAccent * (floorEdge + wallFoot) * 0.22;
  float laneLine = (1.0 - step(0.02, abs(vUNorm))) * floorLike;
  float dash = step(0.55, fract(vS * 0.0625));
  col += uAccent * laneLine * dash * 0.16;
  // Split sections: a pair of guide lines so each branch reads before the fin does.
  float branchLine = (1.0 - step(0.018, abs(abs(vUNorm) - 0.5))) * floorLike * vSplit;
  col += uAccent * branchLine * 0.10;

  // Instability overlay: tint, cracks and a rising warning glow.
  float bandDist = vInBand;
  if (vPhase > 0.5 && bandDist > 0.5) {
    float warn = vPhase < 2.0 ? vProg : 1.0;
    float crackNoise = texture2D(uNoise, vec2(vS * 0.02 + vStation * 0.01, vUNorm * 0.5 + vPanel)).r;
    float threshold = mix(0.98, 0.25, warn);
    float crack = smoothstep(threshold, threshold + 0.05, crackNoise);
    float pulse = 0.5 + 0.5 * sin(uTime * (6.0 + vProg * 14.0));
    col = mix(col, uDanger * (0.4 + 0.25 * pulse), warn * 0.5);
    col += uDanger * crack * (0.45 + warn * 1.1);
    col += uHot * crack * crack * warn * 0.6;
  } else if (vPhase > 0.5) {
    // Neighbouring panels bleed a little danger light.
    float bleed = max(0.0, 1.0 - abs(vUNorm - clamp(vUNorm, vBand0, vBand1)) * 4.0) * min(vProg, 1.0);
    col += uDanger * bleed * 0.12;
  }

  // Outer shell of a doomed section: highlight the fracture boundary itself. Rows without an
  // authored band (u0 == u1 == 0) must be excluded, or every plain panel gets a glowing seam
  // painted down the middle of the road the moment any collapse is running.
  float bandActive = step(0.001, vBand1 - vBand0);
  float boundary = vInBand < 0.5 ? smoothstep(0.06, 0.0, min(abs(vUNorm - vBand0), abs(vUNorm - vBand1))) : 0.0;
  col += mix(uDanger, uHot, 0.4) * boundary * uUnstable * 0.9 * bandActive * step(0.5, vPhase);

  float hurt = uHurt * smoothstep(0.0, 1.0, 1.0 - facing);
  col = mix(col, uDanger, hurt * 0.5);
  col += uBandPulse * uDanger * 0.03;

  // Distance fog matched to the sky, plus per-biome grain so flat panels never band.
  float fogK = 1.0 - exp(-pow(max(0.0, (vDist - uFogNear)) / max(1.0, uFogFar - uFogNear), 2.2));
  col = mix(col, uFogColor, clamp(fogK, 0.0, 1.0));
  float grain = texture2D(uNoise, (vWorld.xz + vWorld.y) * 0.017).g;
  col += (grain - 0.5) * uGrain;

  gl_FragColor = vec4(max(col, vec3(0.0)), 1.0);
}
`;

export interface TunnelHandles {
  mesh: Mesh;
  material: ShaderMaterial;
  geometry: BufferGeometry;
  rowTexture: DataTexture;
  rowBytes: Float32Array;
  dispose(): void;
}

/**
 * Builds the entire star lane as one static mesh and animates it entirely in the vertex
 * shader from a per-row instability texture. No per-frame geometry uploads, so a collapse
 * across the whole visible corridor costs one texture write.
 */
export function buildTunnel(rows: LaneRow[], path: LanePath, biome: BiomeTuning, quality: QualityTier): TunnelHandles {
  // The grid sits on s = 0 and the chase camera trails the ship by 16-25 m, so the tunnel MUST
  // exist behind the start line — otherwise the countdown opens on the tube seen from outside:
  // an empty black rectangle framed by the teal edge lines, which is the first thing every
  // player sees. A few stations of entry corridor are extruded straight back along the entry
  // tangent (the opening rows are authored straight, so this is visually exact).
  const PRE_STATIONS = 8;
  const stations = rows.length + 1 + PRE_STATIONS;
  const segs = quality === 'low' ? Math.max(3, LANE.segsPerRow - 2) : LANE.segsPerRow;
  const panels = 6;
  const perStation = panels * (segs + 1);
  const totalVerts = stations * perStation;

  const position = new Float32Array(totalVerts * 3);
  const normal = new Float32Array(totalVerts * 3);
  const tangent = new Float32Array(totalVerts * 3);
  const meta = new Float32Array(totalVerts * 4);
  const dims = new Float32Array(totalVerts * 2);
  const uv = new Float32Array(totalVerts * 2);
  // 1080 stations × 6 panels × 7 vertices is already past 65k, so indices need 32 bits.
  const index = new Uint32Array((stations - 1) * panels * segs * 6);

  const frame = { px: 0, py: 0, pz: 0, dx: 0, dy: 0, dz: 1, rx: 1, ry: 0, rz: 0, ux: 0, uy: 1, uz: 0, hw: 9, hh: 6.5, row: 0, roll: 0 };
  const p = new Vector3();
  let vi = 0;
  let ii = 0;

  const writeVertex = (
    station: number,
    panel: number,
    uNorm: number,
    hNorm: number,
    hw: number,
    hh: number,
  ): void => {
    const base = vi * 3;
    position[base] = p.x;
    position[base + 1] = p.y;
    position[base + 2] = p.z;
    // Inward normal per panel: floor up, ceiling down, walls toward the centre line.
    let nx = frame.ux;
    let ny = frame.uy;
    let nz = frame.uz;
    if (panel === PANEL_CEILING) {
      nx = -frame.ux;
      ny = -frame.uy;
      nz = -frame.uz;
    } else if (panel === PANEL_LEFT) {
      nx = frame.rx;
      ny = frame.ry;
      nz = frame.rz;
    } else if (panel === PANEL_RIGHT || panel === PANEL_MEDIAN_L) {
      nx = -frame.rx;
      ny = -frame.ry;
      nz = -frame.rz;
    } else if (panel === PANEL_MEDIAN_R) {
      nx = frame.rx;
      ny = frame.ry;
      nz = frame.rz;
    }
    normal[base] = nx;
    normal[base + 1] = ny;
    normal[base + 2] = nz;
    tangent[base] = frame.dx;
    tangent[base + 1] = frame.dy;
    tangent[base + 2] = frame.dz;
    const m = vi * 4;
    meta[m] = station;
    meta[m + 1] = panel;
    meta[m + 2] = uNorm;
    meta[m + 3] = hNorm;
    const dm = vi * 2;
    dims[dm] = hw;
    dims[dm + 1] = hh;
    uv[dm] = (uNorm + 1) * 0.5;
    uv[dm + 1] = hNorm;
    vi++;
  };

  // Which stations carry median fins. Quads across an on/off boundary must not be built:
  // the fin panel collapses to a single point (u = 0, h = 0) wherever there is no divider,
  // so the boundary quad swept from the fin's edge down to the centre of the floor — a big
  // black triangle wing standing across the road at every split-section start and end,
  // which at speed looked like a solid frame the ship flew "through".
  const medianFlags = new Uint8Array(stations);
  for (let station = 0; station < stations; station++) {
    const rowIdx = station - PRE_STATIONS;
    medianFlags[station] = rowIdx >= 0 && rowIdx < rows.length && rows[rowIdx].lanes === 2 ? 1 : 0;
  }

  for (let station = 0; station < stations; station++) {
    const rowIdx = station - PRE_STATIONS; // lane-space station; negative = entry apron
    const s = rowIdx >= 0 ? Math.min(rowIdx * LANE.rowLen, rows[rows.length - 1].s1) : 0;
    path.frameAt(s, frame);
    if (rowIdx < 0) {
      // Extrude straight back along the entry tangent: the apron behind the start line.
      const back = rowIdx * LANE.rowLen;
      frame.px += frame.dx * back;
      frame.py += frame.dy * back;
      frame.pz += frame.dz * back;
    }
    const hw = frame.hw;
    const hh = frame.hh;
    const medianOn = medianFlags[station] === 1;
    const medianHalf = medianOn ? Math.max(0.8, rows[Math.max(0, rowIdx)].medianHalf) : 0;

    for (let panel = 0; panel < panels; panel++) {
      const first = vi;
      for (let k = 0; k <= segs; k++) {
        const t = k / segs;
        if (panel === PANEL_FLOOR || panel === PANEL_CEILING) {
          const uNorm = -1 + t * 2;
          const u = uNorm * hw;
          const h = panel === PANEL_FLOOR ? 0 : hh;
          path.pointTo(s, u, h, p, frame);
          writeVertex(rowIdx, panel, uNorm, t, hw, hh);
        } else if (panel === PANEL_LEFT || panel === PANEL_RIGHT) {
          const uNorm = panel === PANEL_LEFT ? -1 : 1;
          const u = uNorm * (hw - 0.02);
          const h = t * hh;
          path.pointTo(s, u, h, p, frame);
          writeVertex(rowIdx, panel, uNorm, t, hw, hh);
        } else {
          // Median panels collapse to a degenerate strip wherever there is no divider.
          const uNorm = panel === PANEL_MEDIAN_L ? -medianHalf / Math.max(0.001, hw) : medianHalf / Math.max(0.001, hw);
          const u = medianOn ? (panel === PANEL_MEDIAN_L ? -medianHalf : medianHalf) : 0;
          const h = medianOn ? t * hh * 0.42 : 0;
          path.pointTo(s, u, h, p, frame);
          writeVertex(rowIdx, panel, medianOn ? uNorm : 0, t, hw, hh);
        }
      }
      if (panel === PANEL_MEDIAN_L || panel === PANEL_MEDIAN_R) {
        // No strip segment between a fin station and a collapsed one (see medianFlags).
        if (medianFlags[station] !== 1 || medianFlags[station + 1] !== 1) continue;
      }
      // Cells connect this station to the NEXT one; the final station is a rim, not a cell.
      if (station >= stations - 1) continue;
      for (let k = 0; k < segs; k++) {
        const a = first + k;
        const b = a + 1;
        // The strip runs ALONG the lane: a quad of panel `p` is bounded by the same panel's
        // vertex k/k+1 at this station and at the next one. The next station's copy of this
        // panel starts exactly `perStation` vertices later (the buffer is laid out
        // [station][panel][k]). Using `segs + 1` here — one panel's worth — stitched each
        // panel to the NEXT PANEL of the same station (floor→ceiling, left wall→right wall…),
        // which is why the mesh was never a corridor at all: it was a chain of vertical
        // curtains stretched across the bore — the black rectangles with turquoise frames —
        // with no floor, walls or ceiling emitted anywhere.
        const c = a + perStation;
        const d = c + 1;
        if (panel === PANEL_CEILING || panel === PANEL_RIGHT || panel === PANEL_MEDIAN_L) {
          index[ii++] = a;
          index[ii++] = b;
          index[ii++] = c;
          index[ii++] = b;
          index[ii++] = d;
          index[ii++] = c;
        } else {
          index[ii++] = a;
          index[ii++] = c;
          index[ii++] = b;
          index[ii++] = b;
          index[ii++] = c;
          index[ii++] = d;
        }
      }
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(position, 3));
  geometry.setAttribute('aNormal', new Float32BufferAttribute(normal, 3));
  geometry.setAttribute('aTan', new Float32BufferAttribute(tangent, 3));
  geometry.setAttribute('aMeta', new Float32BufferAttribute(meta, 4));
  geometry.setAttribute('aDims', new Float32BufferAttribute(dims, 2));
  geometry.setAttribute('uv', new Float32BufferAttribute(uv, 2));
  geometry.setIndex(new BufferAttribute(index.subarray(0, ii), 1));
  geometry.computeBoundingSphere();

  const rowCount = rows.length;
  const rowBytes = new Float32Array(rowCount * 4);
  const rowTexture = makeRowTexture(rowCount, rowBytes);
  const noise = noiseTexture(256);

  const material = new ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    side: DoubleSide,
    // Lane panels are opaque; only the dissolve is done with `discard`, so depth stays correct.
    transparent: false,
    depthWrite: true,
    uniforms: {
      uRowData: { value: rowTexture },
      uRowCount: { value: rowCount },
      uRowLen: { value: LANE.rowLen },
      uTime: { value: 0 },
      uFlow: { value: 0.35 },
      uPlayerS: { value: 0 },
      uUnstable: { value: 0 },
      uHurt: { value: 0 },
      uBandPulse: { value: 0 },
      uGrain: { value: quality === 'low' ? 0.012 : 0.02 },
      uNoise: { value: noise },
      // The panel tone hexes (deep/mid) are very dark by design — in three's linear working
      // space they land around 0.003..0.03 and the ACES + sRGB output encode crushes that to
      // black, which is why the road was invisible and only the bright accent lines survived.
      // Passing them as raw display-space values (no decode) puts the authored matte tones
      // exactly where the author intended them to sit on screen.
      uDeep: { value: displaySpaceColor(biome.palette.deep) },
      uMid: { value: displaySpaceColor(biome.palette.mid) },
      uAccent: { value: new Color(biome.palette.accent) },
      uAccentAlt: { value: new Color(biome.palette.accentAlt) },
      uHot: { value: new Color(biome.palette.hot) },
      uDanger: { value: new Color(biome.palette.danger) },
      uFogColor: { value: new Color(biome.fogColor) },
      uFogNear: { value: LANE.fogNear },
      uFogFar: { value: LANE.fogFar },
    },
  });
  // Colour management: hand-authored sRGB hexes are already converted by THREE.Color.
  material.toneMapped = false;

  const mesh = new Mesh(geometry, material);
  mesh.name = 'star-lane';
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;

  return {
    mesh,
    material,
    geometry,
    rowTexture,
    rowBytes,
    dispose() {
      geometry.dispose();
      material.dispose();
      rowTexture.dispose();
      (material.uniforms.uNoise.value as Texture).dispose();
    },
  };
}

export function makeRowTexture(rowCount: number, data: Float32Array): DataTexture {
  const tex = new DataTexture(data, rowCount, 1, RGBAFormat, FloatType);
  tex.minFilter = NearestFilter;
  tex.magFilter = NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

export interface TunnelFrameInput {
  time: number;
  playerS: number;
  flow: number;
  unstable: number;
  hurt: number;
  bandPulse: number;
}

export function updateTunnel(handles: TunnelHandles, rows: LaneRow[], input: TunnelFrameInput): void {
  const u = handles.material.uniforms;
  u.uTime.value = input.time;
  u.uPlayerS.value = input.playerS;
  u.uFlow.value = input.flow;
  u.uUnstable.value = input.unstable;
  u.uHurt.value = input.hurt;
  u.uBandPulse.value = input.bandPulse;
  const bytes = handles.rowBytes;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const o = i * 4;
    bytes[o] = row.phase + row.phaseT;
    bytes[o + 1] = row.unsafeU0;
    bytes[o + 2] = row.unsafeU1;
    bytes[o + 3] = row.lanes === 2 ? 1 : 0;
  }
  handles.rowTexture.needsUpdate = true;
}

export function tunnelMaterialForSky(biome: BiomeTuning): MeshStandardMaterial {
  return new MeshStandardMaterial({
    color: new Color(biome.tunnelTint),
    roughness: 0.85,
    metalness: 0.1,
    side: DoubleSide,
  });
}
