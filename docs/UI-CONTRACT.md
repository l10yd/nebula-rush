# NEBULA RUSH — UI contract

`src/ui/*` builds DOM; `src/ui/styles.css` styles it. **This file is the only agreement between
them.** DOM never inlines gameplay animation; CSS never animates anything that must be frame
accurate (that belongs in WebGL).

## Root structure

```
#root
 └ .nr-app                     (position:fixed, inset:0)
    ├ canvas.nr-canvas         (WebGL, z-index 0)
    ├ .nr-overlay              (pointer-events:none, children opt back in)
    │  ├ .nr-hud               (in-race HUD, hidden unless phase=racing/countdown)
    │  ├ .nr-screen            (exactly one visible at a time; .is-active)
    │  ├ .nr-touch             (touch controls; only when .is-touch on .nr-app)
    │  └ .nr-debug             (dev build + F3 only)
    └ .nr-toasts
```

## Tokens (CSS custom properties on `:root`)

`--nr-bg` `--nr-panel` `--nr-panel-2` `--nr-line` `--nr-text` `--nr-text-dim`
`--nr-accent` `--nr-accent-2` `--nr-hot` `--nr-danger` `--nr-good`
`--nr-radius` (14px) `--nr-gap` (16px) `--nr-font` `--nr-font-num`
`--nr-scale` (UI scale, set from settings: 0.85–1.25)
`--nr-shadow` `--nr-glow`

Locale/quality hooks on `.nr-app`: `.locale-ru`, `.reduced-motion`, `.high-contrast`,
`.colour-safe`, `.is-touch`.

## Screens

`.nr-screen[data-screen="main|briefing|garage|settings|howto|pause|results|loading"]`

Common blocks:

| Class | Meaning |
| --- | --- |
| `.nr-panel` | frosted surface, `backdrop-filter`, border `--nr-line` |
| `.nr-title` / `.nr-subtitle` | screen heading pair |
| `.nr-btn` | base button; variants `.primary` `.ghost` `.danger` `.icon` |
| `.nr-btn.is-selected` | current choice in a list |
| `.nr-btn.is-locked` | not yet purchased (dim + lock glyph slot `.nr-lock`) |
| `.nr-list` | vertical stack of `.nr-btn` rows, scrollable |
| `.nr-grid` | responsive card grid (`auto-fit, minmax(200px,1fr)`) |
| `.nr-card` | selectable tile: art slot `.nr-card-art`, body `.nr-card-body` |
| `.nr-field` | label + control row (settings) |
| `.nr-slider` / `.nr-switch` / `.nr-keybind` | form controls |
| `.nr-tabs` + `.nr-tab` | tab strip inside garage/settings |
| `.nr-meter` + `.nr-meter-fill` | generic bar (price, stats, difficulty) |
| `.nr-price` | credit cost, `.nr-price.is-affordable` |
| `.nr-kbd` | keycap chip |
| `.nr-badge` | small status pill (NEW, BEST, DAILY) |
| `.nr-scroll` | custom scrollbar container |

## HUD

```
.nr-hud
 ├ .nr-hud-top     .nr-hud-objective, .nr-hud-warnings, .nr-hud-daily
 ├ .nr-hud-mid     .nr-hud-combo (centre), .nr-hud-flash
 └ .nr-hud-bottom  .nr-hud-speed, .nr-hud-energy(.nr-energy-fill), .nr-hud-boost,
                   .nr-hud-progress(.nr-progress-fill,.nr-progress-marker),
                   .nr-hud-score, .nr-hud-time, .nr-hud-multiplier,
                   .nr-hud-shield, .nr-hud-powerups(.nr-powerup.is-active)
```

State classes: `.is-boosting`, `.is-perfect`, `.is-damaged`, `.is-warn`, `.is-hidden`.
`.nr-hud-combo[data-tier="1|2|3|4"]` drives escalating colour.

Numbers use `font-variant-numeric: tabular-nums`; speed/score must not reflow.

## Readability rules (hard)

1. Body text ≥ 15px after `--nr-scale`; HUD numerals ≥ 20px.
2. Text on glass must pass 4.5:1 against both `--nr-panel` and the canvas; use `--nr-text` only.
3. Every interactive element: `:hover`, `:focus-visible` (2px `--nr-accent` ring, offset 2px),
   `:active`, `:disabled`. Focus ring is never `outline:none` without a replacement.
4. Hit targets ≥ 44×44px; on `.is-touch` ≥ 56×56px.
5. Motion: transitions ≤ 220ms; `.reduced-motion` kills transform animation but keeps fades.
6. Nothing may cover the centre 45%×35% of the frame while `.nr-hud.is-active`.

## i18n

All copy comes from `i18n.t(key)` — no literal strings in DOM modules. Russian strings are up
to ~35% longer: every row must wrap or ellipsis, never clip.
