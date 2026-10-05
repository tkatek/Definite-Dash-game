# Definite Dash — English Article Runner

A three-lane runner game for learning English articles (a / an / the / no article).
Read a sentence with a blank, switch lanes to pick the right article, and let the
approaching gate resolve your answer.

The project is a production-ready, dependency-free browser game with complete
Learn and Arcade loops, responsive layouts, accessible controls, persistent
progress, adaptive practice, predecoded gameplay art, and automated engine and
asset-integrity coverage.

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
tests/                       Engine test suite (178 tests)
assets/characters/          Active rear-view flying fox + start-screen fox mascot
assets/gates/               Approved gate artwork (gate-blue/green/purple.webp)
assets/backgrounds/         Approved environment paintings per device layout,
                            plus hero-countryside for the start screen
assets/road-details/        Active dirt, pebble, wood, and roadside detail art
assets/environment|ui/      Active signs, roadside videos, helper owl, loader,
                            and bonus coin art
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
  so presentation work remains isolated from engine integration.

### Development mode

`const DEBUG = false;` at the top of `js/game.js` centralizes all development
tooling. Set it to `true` to get the debug bar (engine state, lane, gate
progress, question id), the dev-only *Reset progress* and *Submit lane*
controls, gate key hints, verbose event logging and
`window.articleRunnerDebug.engine`. With `DEBUG = false` none of these appear
and gameplay is unaffected.

### Character and environment assets

`assets/characters/fox-flying-back-640.webp` is the active 1254×1254-class
rear-view gameplay pose. `assets/gates/` holds the approved gate artwork
(`gate-blue/green/purple.webp`). `assets/backgrounds/` holds the responsive
environment paintings: `road-desktop.webp`, `road-tablet.webp`, and the cleaned
portrait plate `road-mobile-clean-v2.webp`. Decorative roadside signs, the
looping roadside videos (with per-device `-mobile` / `-400x900` variants and
poster stills), the desktop helper owl, loader fox, and bonus coin live under
`assets/environment/` and `assets/ui/`. HUD symbols remain lightweight inline
SVG so all live numbers and labels stay accessible HTML.

### Gameplay fox flight system (finalized)

`js/game.js` preloads and decodes the single rear-view flying pose before Play,
then animates only its presentation wrappers: projected lane travel, a short
bank/glide response, calm hover, and the ground shadow. Those transforms stay
separate so pointer dragging and lane changes cannot overwrite one another.
Pause freezes the exact current pose, while reduced-motion mode removes hover
and glide without affecting lane input. Level complete and Arcade game over
settle the fox cleanly. `js/player-animation.js` and its tests preserve the
earlier approved run-cycle source contract, but they are not imported by the
live controller.

### Environment / scene system (finalized, locked)

One scenic plate is selected per live runner geometry, including dedicated
phone, tablet, desktop, and short-landscape treatment. Above it, a transparent
code-built road finish adds moving perspective dashes, supplied dirt/pebble/
wood/rock details, worn patches and dust without duplicating the scenery.
`projectRoadPoint()` and `projectLanePoint()` provide
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
