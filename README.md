# Definite Dash — English Article Runner

A three-lane runner game for learning English articles (a / an / the / no article).
Read a sentence with a blank, switch lanes to pick the right article, and let the
approaching gate resolve your answer.

**Current phase: playable browser prototype.** Gameplay correctness, engine
integration and the full loop work end to end. Visual production (countryside
art, character animation, particles, sound, responsive polish) comes later.

## Project structure

```
index.html                  DOM skeleton: screens, HUD, road, gates, overlays
css/game.css                Prototype styling (layout + breakpoints, no final art)
js/engine.js                ArticleRunnerEngine — the single source of truth
js/game.js                  UI controller: renders engine state, forwards input
data/game-data.json         Levels, questions, rules, scoring and timing settings
tests/engine.test.js        162-test suite for js/engine.js (node:test)
article-runner-engine/      Core reference module + its own 53-test suite
assets/                     (placeholder art/audio for the production phase)
```

## Running

The browser layer fetches JSON and uses ES modules, so serve the folder over
HTTP (opening `index.html` from disk will not work):

```bash
npx serve .
# or any static server, e.g.:
node -e "require('http').createServer((q,s)=>{const f=require('fs').readFileSync('.'+decodeURIComponent(q.url.split('?')[0]).replace(/\/$/,'/index.html'));s.end(f)}).listen(8080)"
```

Then open the served URL (e.g. http://localhost:8080).

## Tests

```bash
npm test          # runs tests/engine.test.js against js/engine.js (162 tests)
npm run test:core # runs the core module's own suite (53 tests)
```

## Architecture

- **The engine owns everything**: state machine (`READY / PLAYING / FEEDBACK /
  PAUSED / LEVEL_COMPLETE / GAME_OVER`), question selection with adaptive
  rule weighting, lane randomization (`laneMap` per question), gate timing
  (`gateProgress`, clamped frame deltas), scoring with speed/streak bonuses,
  lives in Arcade Mode, feedback payloads, level summaries, stars, unlock
  progression and localStorage persistence (`article-runner:progress:v1`).
- **The UI owns nothing gameplay-related**: `js/game.js` renders snapshots and
  events, forwards input (`moveLeft/moveRight/moveToLane/chooseCategory`),
  pumps `engine.update(deltaMs)` from a single `requestAnimationFrame` loop,
  and calls `pause/resume/continueAfterFeedback/restartLevel/startLevel`.
  The hidden answer is never read before the engine resolves a question.
- **Event payloads are contracts**: e.g. `state:changed` emits `{ from, to }`.
  The browser layer destructures exactly those fields (see `handleStateChanged`).

### Development helpers

- `DEBUG = true` in `js/game.js` enables the debug bar, centralized event
  logging, gate key hints, the dev *Submit lane* button and
  `window.articleRunnerDebug.engine`. Flip it off for production.
- *Reset progress (dev)* on the start screen wipes localStorage progression.
- Locked levels are enforced by the engine; Arcade Mode ignores the learn lock.

## Controls

| Input | Action |
| --- | --- |
| ← / A, → / D | switch lanes |
| 1 / 2 / 3 | jump to lane (debug-friendly) |
| tap a gate / road third | move to that lane (mobile) |
| Esc / Pause | pause / resume |
| Space / Enter / Continue | proceed after feedback |

Learn Mode shows no lives; Arcade Mode gives 3 lives and ends the run at zero.
Pass a level in Learn Mode (accuracy ≥ level threshold, min 5 correct) to
unlock the next one; stars are awarded at 100% / 75% / 62.5% accuracy.
