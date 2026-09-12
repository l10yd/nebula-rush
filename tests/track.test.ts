import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DIFFICULTY, LANE } from '../src/data/config.ts';
import { TrackGenerator, buildLanePath, generateTrackWithPath } from '../src/game/TrackGenerator.ts';
import { CollapsePhase, RF, type LaneEntity, type LaneRow } from '../src/game/trackTypes.ts';
import { RaceRuntime } from '../src/game/RaceRuntime.ts';
import { Rng } from '../src/core/rng.ts';
import { clamp } from '../src/utils/math.ts';

/** Fingerprint of the authored lane: anything that changes generation shows up here. */
function fingerprint(rows: LaneRow[], entities: LaneEntity[]): string {
  let h = 2166136261 >>> 0;
  const feed = (n: number) => {
    h ^= Math.round(n * 100) | 0;
    h = Math.imul(h, 16777619) >>> 0;
  };
  for (const r of rows) {
    feed(r.yawRate);
    feed(r.pitchRate);
    feed(r.roll);
    feed(r.halfWidth);
    feed(r.lanes);
    feed(r.flags);
    feed(r.unsafeU0);
    feed(r.unsafeU1);
  }
  for (const e of entities) {
    feed(e.s);
    feed(e.u);
    feed(e.h);
    feed(e.r);
    feed(e.kind.length);
  }
  return (h >>> 0).toString(36);
}

test('generation is deterministic for a seed', () => {
  const a = new TrackGenerator().generate({ seed: 'ABC-DEF-GHI', difficulty: 'pilot', biome: 'deep_space' });
  const b = new TrackGenerator().generate({ seed: 'ABC-DEF-GHI', difficulty: 'pilot', biome: 'deep_space' });
  const c = new TrackGenerator().generate({ seed: 'XYZ-111-222', difficulty: 'pilot', biome: 'deep_space' });
  assert.equal(fingerprint(a.rows, a.entities), fingerprint(b.rows, b.entities));
  assert.notEqual(fingerprint(a.rows, a.entities), fingerprint(c.rows, c.entities));
  assert.equal(a.entities.length, b.entities.length);
});

test('lane length lands in the 2–4 minute band', () => {
  for (const id of ['novice', 'pilot', 'ace', 'supernova'] as const) {
    const { meta } = new TrackGenerator().generate({ seed: 'TIME-' + id, difficulty: id, biome: 'deep_space' });
    const par = meta.parTimeSec;
    assert.ok(par > 100 && par < 300, `${id} par time ${par.toFixed(0)}s out of band`);
  }
});

/** Every row must offer a survivable corridor: obstacles, median and collapse band included. */
function widestFreeInterval(row: LaneRow, entities: LaneEntity[]): number {
  const hw = row.halfWidth;
  const lo = -hw + LANE.shipRadiusU;
  const hi = hw - LANE.shipRadiusU;
  const intervals: { from: number; to: number }[] = [];
  if (row.lanes === 2) intervals.push({ from: -row.medianHalf - 1, to: row.medianHalf + 1 });
  if ((row.flags & RF.collapseCapable) !== 0 && row.unsafeU1 > row.unsafeU0) {
    intervals.push({ from: row.unsafeU0 * hw, to: row.unsafeU1 * hw });
  }
  for (const e of entities) {
    if (e.tier === 0 || e.kind === 'gate' || e.kind === 'boostpad' || e.kind === 'pickup' || e.kind === 'wreck') continue;
    // Only blockers that are actually at this row's distance count: obstacles 30 m apart are
    // dodged in sequence, not simultaneously.
    if (e.s < row.s0 - 4 || e.s > row.s1 + 4) continue;
    const half = e.kind === 'plasma' ? e.size * 0.5 : e.r;
    intervals.push({ from: e.u - half - LANE.shipRadiusU, to: e.u + half + LANE.shipRadiusU });
  }
  intervals.sort((a, b) => a.from - b.from);
  let cursor = lo;
  let best = 0;
  for (const iv of intervals) {
    if (iv.to <= lo || iv.from >= hi) continue;
    if (iv.from > cursor) best = Math.max(best, iv.from - cursor);
    cursor = Math.max(cursor, iv.to);
    if (cursor >= hi) break;
  }
  return Math.max(best, hi - cursor);
}

test('a passable racing line always exists', () => {
  for (const seed of ['A-1', 'B-2', 'C-3', 'D-4', 'E-5']) {
    for (const id of ['novice', 'pilot', 'ace', 'supernova'] as const) {
      const { rows, entities, meta } = new TrackGenerator().generate({ seed, difficulty: id, biome: 'collapse_field' });
      let worst = Infinity;
      let worstRow = -1;
      for (const row of rows) {
        if (row.flags & (RF.intro | RF.finish)) continue;
        const gap = widestFreeInterval(row, entities);
        // Split branches are deliberately tight corridors: they only have to fit the ship
        // plus steering margin. A single corridor must always leave room to manoeuvre.
        const required = row.lanes === 2 ? 4.0 : 4.6;
        if (gap < required) {
          assert.ok(false, `${seed}/${id}: row ${row.index} (lanes ${row.lanes}) leaves ${gap.toFixed(2)} m`);
        }
        if (gap < worst) {
          worst = gap;
          worstRow = row.index;
        }
      }
      assert.ok(worst >= 4.0, `${seed}/${id}: tightest row ${worstRow} leaves ${worst.toFixed(2)} m`);
      assert.ok(meta.collapseRows > 0, `${seed}/${id}: no collapse candidates`);
    }
  }
});

test('centreline is finite, smooth and monotonic in s', () => {
  const { rows } = new TrackGenerator().generate({ seed: 'PATHCHECK', difficulty: 'ace', biome: 'void_rift' });
  const path = buildLanePath(rows);
  assert.ok(Number.isFinite(path.totalLength));
  let maxBend = 0;
  const probe = { x: 0, y: 0, z: 0 };
  for (let s = 0; s < path.totalLength - 40; s += 40) {
    const p = path.pointTo(s, 0, 0, probe);
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z), `NaN at s=${s}`);
    maxBend = Math.max(maxBend, path.bendAhead(s, LANE.rowLen));
  }
  // The authored ceiling is ~0.38 rad per row; anything above means a kink in the corridor.
  assert.ok(maxBend < 0.5, `lane bends too sharply: ${maxBend.toFixed(3)} rad / row`);
});

interface BotFrame {
  throttle: number;
  steer: number;
  boost: boolean;
  drift: boolean;
  abilityPressed: boolean;
  pausePressed: boolean;
  restartPressed: boolean;
}

/** An honest autopilot: it reads the same information the player's screen shows. */
function autopilot(rt: RaceRuntime, rng: Rng): BotFrame {
  const p = rt.player;
  const s = p.s;
  const rowIdx = rt.path.rowAt(s);
  const frame: BotFrame = { throttle: 1, steer: 0, boost: false, drift: false, abilityPressed: false, pausePressed: false, restartPressed: false };
  const lookRows = rt.rows.slice(rowIdx, rowIdx + 7);

  let targetU = 0;
  let bestScore = -Infinity;
  for (let candidate = -1; candidate <= 1.0001; candidate += 0.08) {
    let ok = true;
    let score = -Math.abs(candidate) * 0.15;
    for (const row of lookRows) {
      const hw = row.halfWidth;
      const uAbs = candidate * hw;
      if (Math.abs(uAbs) > hw - LANE.shipRadiusU - 0.6) ok = false;
      if (row.lanes === 2 && Math.abs(uAbs) < row.medianHalf + LANE.shipRadiusU + 0.6) ok = false;
      if ((row.phase === CollapsePhase.Fracture || row.phase === CollapsePhase.Gone) && candidate >= row.unsafeU0 && candidate <= row.unsafeU1) ok = false;
      for (let ei = row.entityStart; ei < row.entityEnd; ei++) {
        const e = rt.entities[ei];
        if (!e || e.tier === 0) continue;
        if (e.s < s - 8 || e.s > s + 320) continue;
        const half = e.kind === 'plasma' ? e.size * 0.5 : e.r;
        if (Math.abs(uAbs - e.cu) < half + LANE.shipRadiusU + 1.6) score -= 8;
      }
    }
    if (ok && score > bestScore) {
      bestScore = score;
      targetU = candidate;
    }
  }

  const hw = rt.corridor.half;
  frame.steer = clamp((targetU * hw - p.u) / 6, -1, 1);
  frame.boost = p.energy > 45 || p.perfectTimer > 0;
  if (p.abilityReady && rng.chance(0.4)) frame.abilityPressed = true;
  return frame;
}

function makeRace(seed: string, difficulty: 'novice' | 'pilot' | 'ace' | 'supernova', biome: 'deep_space' | 'collapse_field' | 'stellar_forge' | 'void_rift'): RaceRuntime {
  const t = generateTrackWithPath({ seed, difficulty, biome });
  const rt = new RaceRuntime({ seed, difficulty, biome, rows: t.rows, entities: t.entities, path: t.path, length: t.meta.length });
  rt.reset();
  return rt;
}

test('a full simulated race completes, scores and never produces NaN', () => {
  const rt = makeRace('SIM-RACE-1', 'pilot', 'deep_space');
  const rng = new Rng('driver');
  const dt = 1 / 120;
  let steps = 0;
  let collapseBreaks = 0;
  let gates = 0;
  let hits = 0;
  rt.bus.on('collapseBreak', () => collapseBreaks++);
  rt.bus.on('gate', () => gates++);
  rt.bus.on('hit', () => hits++);

  while ((rt.status === 'running' || rt.status === 'countdown') && steps++ < 120 * 400) {
    rt.step(dt, autopilot(rt, rng));
    const p = rt.player;
    assert.ok(
      Number.isFinite(p.s) && Number.isFinite(p.u) && Number.isFinite(p.speed) && Number.isFinite(p.score),
      'NaN in player state',
    );
  }

  assert.equal(rt.status, 'finished', `race did not finish (status ${rt.status}, progress ${(rt.progress * 100).toFixed(1)}%, hits ${hits})`);
  assert.ok(rt.time > 60 && rt.time < 400, `race time out of band: ${rt.time.toFixed(0)}s`);
  assert.ok(gates > 20, `too few gates encountered: ${gates}`);
  assert.ok(collapseBreaks > 0, 'the signature collapse never fired');
  assert.ok(rt.player.score > 5000, `score suspiciously low: ${rt.player.score}`);
  assert.ok(rt.player.stats.collapsesEscaped > 0, 'no collapse escapes recorded');
});

test('restart replays identically', () => {
  const run = (rt: RaceRuntime): number => {
    const rng = new Rng('driver');
    const dt = 1 / 120;
    for (let i = 0; i < 120 * 60; i++) {
      rt.step(dt, autopilot(rt, rng));
      if (rt.status !== 'running' && rt.status !== 'countdown') break;
    }
    return Math.round(rt.player.score);
  };
  assert.equal(run(makeRace('RESTART-1', 'ace', 'stellar_forge')), run(makeRace('RESTART-1', 'ace', 'stellar_forge')));
});

test('difficulty scales the lane, not just the damage', () => {
  const metrics = (id: 'novice' | 'pilot' | 'ace' | 'supernova') => {
    const { rows, entities, meta } = new TrackGenerator().generate({ seed: 'LADDER', difficulty: id, biome: 'deep_space' });
    const hazards = entities.filter((e) => e.tier > 0 && e.kind !== 'shard').length;
    return {
      hazards,
      rows: rows.length,
      collapseRows: meta.collapseRows,
      density: hazards / rows.length,
      speed: DIFFICULTY[id].maxSpeed,
    };
  };
  const novice = metrics('novice');
  const pilot = metrics('pilot');
  const ace = metrics('ace');
  const nova = metrics('supernova');
  assert.ok(pilot.speed > novice.speed && ace.speed > pilot.speed && nova.speed > ace.speed);
  assert.ok(nova.density > novice.density, `hazard density did not scale (${nova.density.toFixed(3)} vs ${novice.density.toFixed(3)})`);
  assert.ok(nova.collapseRows >= novice.collapseRows, 'collapse frequency did not scale');
});

test('collapse director leaves exactly one surviving route', () => {
  const rt = makeRace('BANDS', 'pilot', 'collapse_field');
  const withBands = rt.rows.filter((r) => (r.flags & RF.collapseCapable) !== 0 && r.unsafeU1 > r.unsafeU0);
  assert.ok(withBands.length > 0, 'no collapse bands were authored');
  for (const row of withBands) {
    const safeWidth = Math.max(row.unsafeU0 - -1, 1 - row.unsafeU1);
    assert.ok(safeWidth > 0.28, `row ${row.index} leaves only ${(safeWidth * 2 * row.halfWidth).toFixed(1)} m of corridor`);
  }
});
