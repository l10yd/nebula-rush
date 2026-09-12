# NEBULA RUSH

A single-player arcade racer through collapsing star lanes. Everything you see is generated at
runtime: the track, the corridor geometry, the nebula that lights it, the ship, the sound. No
artwork is downloaded, and no two seeded lanes are the same.

Built with Vite + TypeScript (strict) + three.js. No other runtime dependencies.

## Run it

```bash
pnpm install
pnpm dev          # http://localhost:5173
pnpm build        # type-check + production bundle in dist/
pnpm preview      # serve the built game
pnpm test         # headless simulation tests (Node, no browser)
pnpm typecheck    # both tsconfigs
```

The build output is static: any file server can host `dist/`, including one with no network
access at all.

## Playing

| | |
| --- | --- |
| `W` / `S` | throttle, brake |
| `A` / `D` | steer across the lane |
| `Shift` | drift (hold into a turn, release for a burst) |
| `Space` | boost (perfect boost if fired the instant a gate opens) |
| `E` | ability burst (charges from skill actions) |
| `Esc` | pause |
| `F3` | debug panel (dev builds only) |

Gamepad, mouse steering and touch are all supported and never fight each other — the last
actively-used device wins.

**The loop.** Every lane is a sequence of generated sections: open sprint, hazard field, split
corridor, collapsing spans, gates. Sections behind you fall apart on a timer, so dawdling is
punished by the track itself, not only by hazards. Readability comes first: the safe path is
always lit, the collapse band is unmistakable, and the centre of the screen is kept clear of
effects.

**Combo.** Near misses, gates, drifts, perfect boosts and escapes all extend the chain. The
multiplier applies to distance and skill points alike; a hit breaks it.

**Cosmetics.** Credits are earned by flying. Ships differ only in silhouette, never in
performance — there is nothing to grind for an advantage.

## How it works

The interesting part is that the ship does not move through a world. Simulation state is
three numbers: `s` along the lane, `u` across it, `h` above the floor. Corridor curvature,
pitch and roll are baked into a frame chain that only the camera and the renderer read. That
keeps collision math trivially exact at any speed, makes the whole game deterministic from a
seed, and lets the simulation be tested in Node without a browser.

| Module | Role |
| --- | --- |
| `src/game/` | pure simulation: track generation, player, collisions, collapse director, spectacle, scoring |
| `src/rendering/` | three.js: one static corridor mesh animated entirely in the vertex shader, instanced props, particle pool, chase camera, post chain |
| `src/audio/` | WebAudio synthesis, adaptive music, engine model — no samples |
| `src/ui/` | DOM overlay (HUD, menus), styled by `src/ui/styles.css` |
| `src/core/` | loop, state machine, save, RNG, platform detection |

The corridor is a single draw call. Per-row state (collapse phase, danger band) is uploaded as
one row of a float texture each frame, and the vertex shader peels, sags and dissolves panels
from it. Props are instanced per visual class and refilled from the entity list every frame.

## Determinism and the daily lane

`Rng` is a seeded sfc32 generator; generation, hazard motion and spectacle timing all derive
from it. The same seed always produces the same lane, the same par time and the same replay.
The daily lane is today's date fed through the same path, so it is identical for every player
without a server.

## Accessibility

- Reduce motion (setting or `prefers-reduced-motion`): camera shake, FOV punch and warp streaks
  are damped; nothing essential is motion-only.
- Screen shake toggle, damage flash toggle.
- Colour-safe palette plus non-colour cues (dashed borders, patterns) for danger states.
- High-contrast HUD mode.
- UI scale, FOV bias, remappable keyboard controls.
- Full keyboard navigation with visible focus; the HUD is `aria-hidden` decoration and all
  actionable UI is real buttons.
- Touch controls appear on coarse pointers, or always if you ask.

## Quality

Four tiers (`ultra` → `low`) covering resolution scale, particle budget, bloom, aberration,
prop window and star count. Automatic mode watches measured frame time, steps down after a
sustained bad window and is deliberately slower to step back up, so the setting never pumps.

## Development

- `?selftest` on the URL runs the headless harness: it walks every screen, samples the
  framebuffer, starts a race and asserts the ship actually moves. Read it with
  `chrome --headless --dump-dom "http://localhost:5173/?selftest"`.
- `docs/CONTRACTS.md` records the interfaces between layers that were built in parallel.
- `docs/UI-CONTRACT.md` is the agreement between the DOM modules and the stylesheet.
- `pnpm test` runs the simulation in Node: determinism, passability of every generated lane,
  par-time band, collapse behaviour, difficulty ladder and a full autopiloted race.
