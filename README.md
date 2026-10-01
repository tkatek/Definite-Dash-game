# Definite Dash — English Article Runner

A three-lane runner game for learning English articles (a / an / the / no article).
Read a sentence with a blank, switch lanes to pick the right article, and let the
approaching gate resolve your answer.

**Current phase: playable prototype with approved visuals for the fox, the
answer gates and the road/environment art.** Gameplay correctness, engine
integration and the full loop work end to end. Remaining visual phases: HUD,
question panel, feedback UI, mascot details, animations polish and audio.

## Project structure

```
index.html                  DOM skeleton: screens, HUD, road, gates, overlays
css/game.css                Styling: layout, breakpoints, scene/gate/fox systems
js/engine.js                ArticleRunnerEngine — the single canonical engine
js/game.js                  UI controller: renders engine state, forwards input
data/game-data.json         The single canonical data source (levels, questions,
                            rules, scoring and timing settings)
tests/engine.test.js        Test suite for js/engine.js (node:test, 162 tests)
assets/characters/          Approved fox run cycle (8 frames, 1254×1254 PNG)
assets/gates/               Approved gate artwork (webp + png sources)
assets/backgrounds/         Approved environment paintings (webp + png sources)
assets/environment|ui|audio/ Placeholders for the remaining visual phases
```

There is exactly one engine (`js/engine.js`) and one data file
(`data/game-data.json`). The browser loads the data over `fetch`, so the game
must be served over HTTP — opening `index.html` directly from disk will not work:

```bash
npx serve .
# or any other static file server, then open the printed URL
```

## Tests

```bash
npm test
```

Runs the engine test suite with Node's built-in test runner
(`node --test tests/*.test.js`). The project is intentionally dependency-free:
plain HTML, CSS, JavaScript, JSON and `node:test` — no frameworks, no bundler.

## Architecture

- **The engine owns everything**: state machine (`READY / PLAYING / FEEDBACK /
  PAUSED / LEVEL_COMPLETE / GAME_OVER`), question selection with adaptive
  rule weighting, lane randomization (`laneMap` per question), gate timing
  (`gateProgress`, frame deltas clamped to 100 ms), scoring with speed/streak
  bonuses, lives in Arcade Mode, feedback payloads, level summaries, stars,
  unlock progression and localStorage persistence
  (key `article-runner:progress:v1`). It is fully DOM-free and also runs in
  Node under the test suite.
- **The UI owns nothing gameplay-related**: `js/game.js` loads the canonical
  data, instantiates the engine, listens to engine events, forwards input
  (`moveLeft / moveRight / moveToLane / chooseCategory`), pumps
  `engine.update(deltaMs)` from a single `requestAnimationFrame` loop, and
  renders state. The hidden answer is never read before the engine resolves
  a question. Rendering is grouped behind small functions
  (`renderHUD`, `renderQuestion`, `renderLanes`, `renderGates`, `renderPlayer`,
  `renderFeedback`, `renderPause`, `renderLevelComplete`, `renderGameOver`)
  so the upcoming visual pass can restyle each surface without touching
  engine integration.

### Development mode

`const DEBUG = false;` at the top of `js/game.js` centralizes all development
tooling. Set it to `true` to get the debug bar (engine state, lane, gate
progress, question id), the dev-only *Reset progress* and *Submit lane*
controls, gate key hints, verbose event logging and
`window.articleRunnerDebug.engine`. With `DEBUG = false` none of these appear
and gameplay is unaffected.

### Asset placeholders

`assets/characters/` holds the approved, final fox run cycle
(`fox-run-01.png` … `fox-run-08.png`, 1254×1254 RGBA PNGs, order chosen by
measured stride continuity). `assets/gates/` holds the approved gate artwork
(`gate-blue/green/purple.webp`, PNG originals in `source/`).
`assets/backgrounds/` holds the approved environment paintings — one per
device class (`road-desktop.webp` 1672×941, `road-tablet.webp` 1448×1086,
`road-mobile.webp` 941×1672, PNG originals in `source/`). The remaining
folders are placeholders for the upcoming production pass: scenery props in
`environment/`, HUD icons (heart, star, flame) in `ui/`, and music plus
effect sounds in `audio/`.

### Environment / scene system (finalized, locked)

The road and scenery exist only as the approved paintings; lane logic,
collision and timing never live in the artwork or CSS. One painting per
device class is selected by the scene breakpoints (**≤680px phone, ≤1200px
tablet, otherwise desktop**) — the same media queries retune lane anchors,
gate sizing and horizon, so artwork and gameplay geometry cannot drift
apart. Alignment is guaranteed by construction: `background-position:
50% var(--scene-bg-pos-y)` pins each painting's horizon row to the same
fraction of the game world for any `cover` crop, and gates spawn exactly at
that fraction (`--scene-horizon-y`), following the painted lane stripes via
measured per-layout profiles (`GATE_X_PROFILES` in `js/game.js`). The
engine's `gateProgress` and collision timing are untouched — only the
visual mapping is responsive. If an artwork fails to load, a CSS sky
fallback keeps the game playable.

## Controls

| Input | Action |
| --- | --- |
| ← / A, → / D | switch lanes |
| 1 / 2 / 3 | jump to a lane (handy for quick testing) |
| tap a gate / road third | move to that lane (mobile) |
| Esc / Pause | pause / resume |
| Space / Enter / Continue | proceed after feedback |

Learn Mode shows no lives; Arcade Mode gives 3 lives and ends the run at zero.
Pass a level in Learn Mode (accuracy ≥ level threshold, min 5 correct) to
unlock the next one; stars are awarded at 100% / 75% / 62.5% accuracy.
