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
css/start.css               Landing screen: hero over the approved countryside art
                            + fox mascot, level-selection modal (start screen only)
js/engine.js                ArticleRunnerEngine — the single canonical engine
js/game.js                  UI controller: renders engine state, forwards input
data/game-data.json         The single canonical data source (levels, questions,
                            rules, scoring and timing settings)
tests/engine.test.js        Test suite for js/engine.js (node:test, 162 tests)
assets/characters/          Approved fox run cycle (8 frames) + fox-hero mascot
                            for the start screen (webp + png sources)
assets/gates/               Approved gate artwork (webp + png sources)
assets/backgrounds/         Approved environment paintings (webp + png sources),
                            plus hero-countryside for the start screen
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

### Character and environment assets

`assets/characters/fox-run-01.png` … `fox-run-08.png` are the untouched
1254×1254 RGBA masters for the approved fox. Gameplay uses their normalized,
alpha-safe WebP builds in `assets/characters/runtime/`; the deterministic
translation/encoding recipe lives in `scripts/build-run-frames.py`. The eight
runtime frames retain one scale and canvas while encoding the mirrored
push-off → air → landing → compression gait. `assets/gates/` holds the approved
gate artwork
(`gate-blue/green/purple.webp`, PNG originals in `source/`).
`assets/backgrounds/` holds the responsive environment paintings:
`road-desktop.webp`, `road-tablet.webp`, and the cleaned portrait plate
`road-mobile-clean-v2.webp` (with its PNG source). Decorative roadside signs
live in `assets/environment/`, and the desktop helper owl lives in
`assets/ui/`; their high-resolution PNG sources are kept beside them in
`source/` folders. HUD symbols remain lightweight inline SVG so all live
numbers and labels stay accessible HTML.

### Fox run system (finalized, locked)

`js/player-animation.js` is the single run manifest. It locks the eight phase
names, frame order, fallback PNGs, 75–95ms cadence, and per-phase shadow
values. `js/game.js` advances that manifest from the existing
`requestAnimationFrame` accumulator, preloads and decodes the complete cycle
before Play, and keeps the current phase across questions and pause/resume.
Lane movement, lean, feedback reactions, frame playback, and the ground shadow
each use separate wrappers so their transforms cannot overwrite one another.
Reduced motion holds one planted compression frame while keeping lane input
functional. Level complete and Arcade game over also settle on that stable
pose. Do not reorder, rescale, or redraw this system unless a reproducible
animation bug is found.

### Environment / scene system (finalized, locked)

One scenic plate is selected per device class (**≤680px phone, 681–1100px
tablet, otherwise desktop**). Above it, a transparent code-built road finish
adds moving perspective dashes, sparse stones, worn patches and dust without
duplicating the scenery. `projectRoadPoint()` and `projectLanePoint()` provide
the shared geometry for road details, lane arrows and gates; CSS custom
properties supply each layout's horizon, collision line and lane anchors.
The engine's `gateProgress` and collision timing remain untouched while the
visual mapping applies layout-specific gate scale/spread floors for early
legibility. Pooled DOM objects and the existing single animation frame loop
keep motion lightweight, and a CSS sky gradient remains as the artwork
fallback.

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
