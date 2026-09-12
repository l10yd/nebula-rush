/**
 * The star lane centreline as a pure-data sampled frame chain.
 *
 * Deliberately free of any three.js / DOM dependency: the whole gameplay simulation
 * (and therefore the track generator) runs headless, which makes it unit-testable and
 * keeps the renderer an observer of simulation state rather than a participant.
 *
 * Lane-local space: `s` metres along the lane, `u` metres lateral (right positive),
 * `h` metres up from the floor. The corridor frame (dir/right/up) carries authored
 * yaw, pitch and roll, so vertical and banked sections need no extra simulation axes.
 */

export interface LaneFrame {
  px: number; py: number; pz: number;
  dx: number; dy: number; dz: number;
  rx: number; ry: number; rz: number;
  ux: number; uy: number; uz: number;
  hw: number; hh: number; row: number; roll: number;
}

export function createFrame(): LaneFrame {
  return {
    px: 0, py: 0, pz: 0, dx: 0, dy: 0, dz: 1, rx: 1, ry: 0, rz: 0, ux: 0, uy: 1, uz: 0,
    hw: 9, hh: 6.5, row: 0, roll: 0,
  };
}

export class LanePath {
  readonly ds: number;
  readonly sampleCount: number;
  readonly px: Float64Array;
  readonly py: Float64Array;
  readonly pz: Float64Array;
  readonly dx: Float64Array;
  readonly dy: Float64Array;
  readonly dz: Float64Array;
  readonly rx: Float64Array;
  readonly ry: Float64Array;
  readonly rz: Float64Array;
  readonly ux: Float64Array;
  readonly uy: Float64Array;
  readonly uz: Float64Array;
  readonly hw: Float64Array;
  readonly hh: Float64Array;
  readonly roll: Float64Array;
  readonly curvature: Float64Array;
  readonly totalLength: number;

  constructor(
    readonly rowCount: number,
    readonly segsPerRow: number,
    readonly rowLen: number,
    /** Per-sample authored data, length === sampleCount. */
    data: {
      yaw: Float64Array;
      pitch: Float64Array;
      roll: Float64Array;
      halfWidth: Float64Array;
      height: Float64Array;
    },
  ) {
    this.segsPerRow = Math.max(1, segsPerRow);
    this.sampleCount = rowCount * segsPerRow + 1;
    this.ds = rowLen / segsPerRow;
    this.totalLength = (this.sampleCount - 1) * this.ds;

    const n = this.sampleCount;
    this.px = new Float64Array(n);
    this.py = new Float64Array(n);
    this.pz = new Float64Array(n);
    this.dx = new Float64Array(n);
    this.dy = new Float64Array(n);
    this.dz = new Float64Array(n);
    this.rx = new Float64Array(n);
    this.ry = new Float64Array(n);
    this.rz = new Float64Array(n);
    this.ux = new Float64Array(n);
    this.uy = new Float64Array(n);
    this.uz = new Float64Array(n);
    this.hw = new Float64Array(n);
    this.hh = new Float64Array(n);
    this.roll = new Float64Array(n);
    this.curvature = new Float64Array(n);
    this.build(data);
  }

  private build(data: { yaw: Float64Array; pitch: Float64Array; roll: Float64Array; halfWidth: Float64Array; height: Float64Array }): void {
    const { px, py, pz, dx, dy, dz, rx, ry, rz, ux, uy, uz } = this;
    const n = this.sampleCount;
    const ds = this.ds;
    let x = 0;
    let y = 0;
    let z = 0;
    let prevAx = 0;
    let prevAz = 1;

    for (let i = 0; i < n; i++) {
      const yaw = data.yaw[Math.min(i, data.yaw.length - 1)] ?? 0;
      const pitch = data.pitch[Math.min(i, data.pitch.length - 1)] ?? 0;
      const roll = data.roll[Math.min(i, data.roll.length - 1)] ?? 0;
      const cp = Math.cos(pitch);
      const vx = Math.sin(yaw) * cp;
      const vy = Math.sin(pitch);
      const vz = Math.cos(yaw) * cp;

      // right = normalize(worldUp × dir), up = normalize(dir × right), then roll about dir.
      let rxA = -vz;
      let ryA = 0;
      let rzA = vx;
      const rLen = Math.hypot(rxA, ryA, rzA) || 1;
      rxA /= rLen; ryA /= rLen; rzA /= rLen;
      let uxA = vy * rzA - vz * ryA;
      let uyA = vz * rxA - vx * rzA;
      let uzA = vx * ryA - vy * rxA;
      const uLen = Math.hypot(uxA, uyA, uzA) || 1;
      uxA /= uLen; uyA /= uLen; uzA /= uLen;

      const cr = Math.cos(roll);
      const sr = Math.sin(roll);
      const rxB = rxA * cr + uxA * sr;
      const ryB = ryA * cr + uyA * sr;
      const rzB = rzA * cr + uzA * sr;
      const uxB = uxA * cr - rxA * sr;
      const uyB = uyA * cr - ryA * sr;
      const uzB = uzA * cr - rzA * sr;

      px[i] = x; py[i] = y; pz[i] = z;
      dx[i] = vx; dy[i] = vy; dz[i] = vz;
      rx[i] = rxB; ry[i] = ryB; rz[i] = rzB;
      ux[i] = uxB; uy[i] = uyB; uz[i] = uzB;
      this.hw[i] = data.halfWidth[Math.min(i, data.halfWidth.length - 1)] ?? 9;
      this.hh[i] = data.height[Math.min(i, data.height.length - 1)] ?? 13;
      this.roll[i] = roll;
      const dot = Math.max(-1, Math.min(1, vx * prevAx + vz * prevAz));
      this.curvature[i] = Math.abs(Math.acos(dot)) / ds;
      prevAx = vx; prevAz = vz;

      x += vx * ds;
      y += vy * ds;
      z += vz * ds;
    }
  }

  /** Fractional sample index for an `s` value. */
  frac(s: number): number {
    return Math.max(0, Math.min(this.sampleCount - 1, s / this.ds));
  }

  rowAt(s: number): number {
    return Math.max(0, Math.min(this.rowCount - 1, Math.floor(s / this.rowLen)));
  }

  /** Writes the interpolated frame at distance `s` into `out`. Allocation-free. */
  frameAt(s: number, out: LaneFrame): LaneFrame {
    const f = this.frac(s);
    const i = Math.min(this.sampleCount - 2, Math.floor(f));
    const k = f - i;
    const j = i + 1;
    const { px, py, pz, dx, dy, dz, rx, ry, rz, hw, hh, roll } = this;
    out.px = px[i] + (px[j] - px[i]) * k;
    out.py = py[i] + (py[j] - py[i]) * k;
    out.pz = pz[i] + (pz[j] - pz[i]) * k;
    let vx = dx[i] + (dx[j] - dx[i]) * k;
    let vy = dy[i] + (dy[j] - dy[i]) * k;
    let vz = dz[i] + (dz[j] - dz[i]) * k;
    let vl = Math.hypot(vx, vy, vz) || 1;
    out.dx = vx / vl; out.dy = vy / vl; out.dz = vz / vl;
    vx = out.dx; vy = out.dy; vz = out.dz;

    let ax = rx[i] + (rx[j] - rx[i]) * k;
    let ay = ry[i] + (ry[j] - ry[i]) * k;
    let az = rz[i] + (rz[j] - rz[i]) * k;
    // Re-orthogonalise right against dir so the frame stays a rigid basis after interpolation.
    const dp = ax * vx + ay * vy + az * vz;
    ax -= vx * dp; ay -= vy * dp; az -= vz * dp;
    let al = Math.hypot(ax, ay, az) || 1;
    ax /= al; ay /= al; az /= al;
    out.rx = ax; out.ry = ay; out.rz = az;
    out.ux = vy * az - vz * ay;
    out.uy = vz * ax - vx * az;
    out.uz = vx * ay - vy * ax;
    out.hw = hw[i] + (hw[j] - hw[i]) * k;
    out.hh = hh[i] + (hh[j] - hh[i]) * k;
    out.roll = roll[i] + (roll[j] - roll[i]) * k;
    out.row = this.rowAt(s);
    return out;
  }

  /**
   * Converts lane-local (s,u,h) to world space, writing into a 3-number array.
   * `frame` is a pure cache for the frame **at exactly this `s`** — when given, it is used as
   * the origin/basis verbatim and `s` is not sampled. Passing a frame from another station
   * silently ignores the `s` argument; callers that convert points at a different station
   * (camera back/look-ahead) must omit `frame` and let it resolve per point.
   */
  pointTo<T extends { x: number; y: number; z: number }>(s: number, u: number, h: number, out: T, frame?: LaneFrame): T {
    const f = frame ?? this.frameAt(s, scratch);
    const hh = Math.max(0.001, h - 0);
    out.x = f.px + f.rx * u + f.ux * hh;
    out.y = f.py + f.ry * u + f.uy * hh;
    out.z = f.pz + f.rz * u + f.uz * hh;
    return out;
  }

  /** Unit basis vectors of the lane frame at `s` (allocation-free). */
  rightAt<T extends { x: number; y: number; z: number }>(s: number, out: T, frame?: LaneFrame): T {
    const f = frame ?? this.frameAt(s, scratch);
    out.x = f.rx; out.y = f.ry; out.z = f.rz;
    return out;
  }

  upAt<T extends { x: number; y: number; z: number }>(s: number, out: T, frame?: LaneFrame): T {
    const f = frame ?? this.frameAt(s, scratch);
    out.x = f.ux; out.y = f.uy; out.z = f.uz;
    return out;
  }

  /** Total heading change over a window of lane, used to shape the camera and HUD. */
  bendAhead(s: number, distance: number): number {
    const a = this.frameAt(s, scratch);
    const b = this.frameAt(Math.min(this.totalLength, s + distance), scratch2);
    const dot = Math.max(-1, Math.min(1, a.dx * b.dx + a.dy * b.dy + a.dz * b.dz));
    return Math.acos(dot);
  }

  heightDelta(s: number, distance: number): number {
    const a = this.frameAt(s, scratch);
    const b = this.frameAt(Math.min(this.totalLength, s + distance), scratch2);
    return b.py - a.py;
  }
}

const scratch = createFrame();
const scratch2 = createFrame();
