/* ==========================================================================
 * Definite Dash — browser UI controller (js/game.js)
 * --------------------------------------------------------------------------
 * Thin layer between the DOM and ArticleRunnerEngine. It renders engine
 * state, forwards player input and reacts to engine events. ALL gameplay
 * decisions (questions, answers, scoring, streaks, lives, lanes, timing,
 * progression, mastery) come from the engine — nothing is reimplemented
 * here and the hidden answer is never touched before resolution.
 * ========================================================================== */

import { ArticleRunnerEngine, GAME_STATES, GAME_MODES } from './engine.js';

/* ========================================================================
 * 1. Configuration and DOM references
 * ====================================================================== */

/**
 * Development mode: enables the debug bar, dev controls, event logging and
 * window.articleRunnerDebug. Must stay false for production builds; turning
 * it off changes nothing about normal gameplay.
 */
const DEBUG = false;

const DATA_URL = 'data/game-data.json';

/* ------------------------------------------------------------------------
 * Gate visual system — the ONLY place category → gate appearance is mapped.
 * The engine knows nothing about colors, images, labels or icons; it only
 * reports categories ("definite" | "indefinite" | "none") per lane, and this
 * table decides what that category looks like on screen. Color, label and
 * icon follow the CATEGORY, never the lane.
 * ---------------------------------------------------------------------- */

/** Lightweight inline category icons (white strokes over the gate's top disc). */
const GATE_ICONS = {
  book:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 4h6a4 4 0 0 1 4 4v13a3 3 0 0 0-3-3H2z"/><path d="M22 4h-6a4 4 0 0 0-4 4v13a3 3 0 0 1 3-3h7z"/></svg>',
  leaf:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z"/><path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12"/></svg>',
  ban:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m5.7 5.7 12.6 12.6"/></svg>',
};

/** Category → gate artwork / dynamic label / icon / accessible name. */
const GATE_VISUALS = {
  definite: {
    art: 'assets/gates/gate-blue.webp',
    label: 'THE',
    icon: GATE_ICONS.book,
    aria: 'Choose THE',
  },
  indefinite: {
    art: 'assets/gates/gate-green.webp',
    label: 'A / AN',
    icon: GATE_ICONS.leaf,
    aria: 'Choose A or AN',
  },
  none: {
    art: 'assets/gates/gate-purple.webp',
    label: 'NO ARTICLE',
    icon: GATE_ICONS.ban,
    aria: 'Choose no article',
  },
};

/** Display labels for the three engine categories (display concern only). */
const CATEGORY_LABELS = {
  definite: GATE_VISUALS.definite.label,
  indefinite: GATE_VISUALS.indefinite.label,
  none: GATE_VISUALS.none.label,
};

/**
 * Runner geometry — visual constants only. Ground lines (horizon/collision)
 * and lane x positions are owned by the CSS custom properties on .runner
 * (see the "Scene / environment" block in css/game.css: one painting per
 * device class, 680px/1100px breakpoints) and only READ here by
 * readSceneGeo(). The engine's gateProgress and collision timing never
 * change — the SAME normalized progress is just mapped to different visual
 * coordinates per layout.
 */
const RUNNER_GEO = {
  farScale: 0.28,
  nearScale: 1.0,
  farOpacity: 0.72,
  /** Visual size in px below which labels get a counter-scale boost. */
  minLabelPx: 11,
  maxLabelBoost: 2.3,
};

/* ------------------------------------------------------------------------
 * World-motion system — the perspective road (visual only)
 * ------------------------------------------------------------------------
 * One projection drives every world object. A normalized DEPTH value maps
 * onto the same painted road the scene artwork shows:
 *
 *   depth 0    → the road's vanishing point (painted horizon row)
 *   depth 1    → the gate collision plane (CSS --scene-collision-y)
 *   depth > 1  → between the collision plane and the camera
 *
 * y(depth) is affine in depth, and every ground line (lane centers, painted
 * dividers, road edges) is straight through the vanishing point, so an
 * object's x is just slope · Δy and its scale is depth itself — exactly the
 * pinhole relation size ∝ 1/Z. Because of that, world flow follows the
 * perspective ODE d(depth)/dt = a·depth²: objects barely creep near the
 * horizon and rush as they pass the camera, which is what sells forward
 * motion. Gates reuse the SAME projection: gateProgress (the engine's
 * clock) is eased onto depth with the hyperbolic curve derived from a fixed
 * checkpoint approached at constant speed, D(p) = r / (1 − p·(1−r)), so a
 * gate reads as standing on the road while the camera closes in — then
 * slides past the fox at collision instead of hitting it.
 *
 * All road objects are pooled DOM nodes animated with transforms only and
 * recycled near the horizon; nothing is created or destroyed during play.
 * ---------------------------------------------------------------------- */

/**
 * Artwork rail geometry, measured in IMAGE space from the approved paintings
 * by pixel-scanning the painted divider stripes. The painted dividers bow
 * outward mid-road (a stylized fisheye road), so each is fit with a
 * quadratic through the vanishing point:
 *
 *   offset(Δy) = dividerA·Δy + dividerB·Δy²     (Δy = distance below horizon)
 *
 * The same curve family, scaled, gives the lane rails for gates/stones
 * (they must land on the CSS lane anchors at the collision plane) and the
 * road-edge rails for tufts (edgeScale ≈ where the painted edge sits at the
 * collision plane, in units of the divider offset). Cover-crop factors
 * convert everything to screen space per layout in rebuildWorldGeometry(),
 * so the moving overlays sit exactly on the painted stripes for any runner
 * aspect ratio. Also: painted dash proportions and the road tone the
 * divider masks repaint.
 */
const WORLD_ART = {
  desktop: {
    aspect: 1672 / 941,
    dividerA: 0.482,
    dividerB: -0.264,
    edgeA: 0.775, // road-edge rail: offset(Δy) = kx·edgeA·(Δy/ky)^edgePow
    edgePow: 0.636,
    dashAspect: 2.3, // painted dash length / width
    dashW0: 0.026, // moving dash width at the collision plane (fraction of runner width)
    maskHalf1: 0.026, // mask half-width at y = 100% (covers the painted stripe)
    maskTopY: 0.615, // painted dashes begin here; above it the mask would show on the bright road
    toneTop: '#fcc376',
    toneBottom: '#f9bc6a',
  },
  tablet: {
    aspect: 1448 / 1086,
    dividerA: 0.542,
    dividerB: -0.291,
    edgeA: 0.839,
    edgePow: 0.632,
    dashAspect: 2.4,
    dashW0: 0.025,
    maskHalf1: 0.027,
    maskTopY: 0.605,
    toneTop: '#fcc276',
    toneBottom: '#f9ba68',
  },
  mobile: {
    aspect: 941 / 1672,
    dividerA: 0.739,
    dividerB: -0.263,
    edgeA: 1.168,
    edgePow: 0.63,
    dashAspect: 3.2,
    dashW0: 0.048,
    maskHalf1: 0.042,
    maskTopY: 0.455,
    toneTop: '#fcc478',
    toneBottom: '#f9bd68',
  },
};

/** Motion tuning for the world layer (visual only — never gameplay). */
const WORLD_MOTION = {
  /** Gate spawn depth per layout: small fraction of the collision distance. */
  easeR: { desktop: 0.22, tablet: 0.24, mobile: 0.26 },
  /** Road-flow coefficient a = speedPerGate · level.speed (clamped). */
  speedPerGate: 26,
  speedMin: 1.6,
  speedMax: 2.6,
  /** World slow-motion during feedback: correct keeps trotting, wrong hesitates. */
  crawlCorrect: 0.45,
  crawlWrong: 0.15,
  /** Road objects recycle once their ground line passes this y fraction. */
  yExit: 1.04,
  dustEveryMs: 95,
  reducedFactor: 0.55,
};

const world = {
  built: false,
  W: 0,
  H: 0,
  a: 1.7, // perspective flow coefficient (per second)
  crawl: 1, // feedback slow-motion factor
  yVp: 0.426,
  yCol: 0.86,
  laneHalf: 0.31,
  laneSpanY: 0.434, // yCol − yVp, cached
  divA: 0.482, // screen-space quadratic rail: offset(Δy) = divA·Δy + divB·Δy²
  divB: -0.264,
  divBase: 0.367, // rail value at the collision plane (spread normalizer)
  edgeA: 0.775, // road-edge rail (screen space, incl. cover factors)
  edgePow: 0.636,
  masks: [],
  dashes: [],
  stones: [],
  tufts: [],
  dusts: [],
  dustIdx: 0,
  dustTimer: 0,
  gate: { depth: 0, r: 0.22, spawnFade: 1 },
};

/** Painted-divider rail offset at Δy below the horizon (screen fractions). */
function railOffset(dy) {
  return world.divA * dy + world.divB * dy * dy;
}

/**
 * Lane-rail spread factor at depth D (exactly 1 at the collision plane,
 * where gates must land on the CSS lane anchors). Uses the measured rail
 * curve so gates/stones track the painted lanes' outward bow mid-road:
 * spread(D) = family(D·L)/family(L) = D·(divA + divB·D·L)/(divA + divB·L).
 */
function laneSpread(depth) {
  return (depth * (world.divA + world.divB * depth * world.laneSpanY)) / world.divBase;
}

/** The single perspective helper: depth + continuous lane → screen point. */
function projectRoadPoint(depth, lane) {
  const y = world.yVp + depth * world.laneSpanY;
  const x = 0.5 + lane * world.laneHalf * laneSpread(depth);
  return { x: x * world.W, y: y * world.H, scale: depth };
}

/** Same projection for the painted divider rails (and edges, scaled). */
function edgeRailX(depth, side) {
  const dy = depth * world.laneSpanY;
  const y = world.yVp + dy;
  const x = 0.5 + side * world.edgeA * Math.pow(dy, world.edgePow);
  return { x: x * world.W, y: y * world.H, scale: depth };
}

/** Perspective ODE step: how fast a fixed world point flows toward us. */
function flowDepth(depth, dt, coeff) {
  return depth + coeff * depth * depth * dt;
}

/** gateProgress → depth on the shared projection (r = spawn depth). */
function gateEase(p) {
  const r = world.gate.r;
  return r / (1 - p * (1 - r));
}

const dom = {
  app: document.getElementById('app'),
  // error screen
  screenError: document.getElementById('screen-error'),
  errorMessage: document.getElementById('error-message'),
  btnErrorReload: document.getElementById('btn-error-reload'),
  // start screen
  screenStart: document.getElementById('screen-start'),
  btnPlay: document.getElementById('btn-play'),
  btnModeLearn: document.getElementById('btn-mode-learn'),
  btnModeArcade: document.getElementById('btn-mode-arcade'),
  levelList: document.getElementById('level-list'),
  startNote: document.getElementById('start-note'),
  btnResetProgress: document.getElementById('btn-reset-progress'),
  devTools: document.getElementById('dev-tools'),
  // game screen
  screenGame: document.getElementById('screen-game'),
  hudLevel: document.getElementById('hud-level'),
  hudQuestion: document.getElementById('hud-question'),
  hudScore: document.getElementById('hud-score'),
  hudStreak: document.getElementById('hud-streak'),
  hudLives: document.getElementById('hud-lives'),
  btnPause: document.getElementById('btn-pause'),
  sentence: document.getElementById('sentence'),
  runner: document.getElementById('runner'),
  scene: document.querySelector('.scene'),
  gatesRoot: document.getElementById('gates'),
  player: document.getElementById('player'),
  playerImg: document.getElementById('player-img'),
  feedback: document.getElementById('feedback'),
  feedbackTitle: document.getElementById('feedback-title'),
  feedbackSentence: document.getElementById('feedback-sentence'),
  feedbackDetail: document.getElementById('feedback-detail'),
  btnContinue: document.getElementById('btn-continue'),
  // pause overlay
  overlayPause: document.getElementById('overlay-pause'),
  btnResume: document.getElementById('btn-resume'),
  btnQuit: document.getElementById('btn-quit'),
  // level complete
  screenComplete: document.getElementById('screen-complete'),
  completeTitle: document.getElementById('complete-title'),
  completeStars: document.getElementById('complete-stars'),
  completeCorrect: document.getElementById('complete-correct'),
  completeWrong: document.getElementById('complete-wrong'),
  completeAccuracy: document.getElementById('complete-accuracy'),
  completeScore: document.getElementById('complete-score'),
  completeStreak: document.getElementById('complete-streak'),
  completeWeak: document.getElementById('complete-weak'),
  completeWeakList: document.getElementById('complete-weak-list'),
  btnNextLevel: document.getElementById('btn-next-level'),
  btnPlayAgain: document.getElementById('btn-play-again'),
  btnCompleteMenu: document.getElementById('btn-complete-menu'),
  // game over
  screenGameOver: document.getElementById('screen-gameover'),
  gameOverAnswered: document.getElementById('gameover-answered'),
  gameOverCorrect: document.getElementById('gameover-correct'),
  gameOverScore: document.getElementById('gameover-score'),
  gameOverStreak: document.getElementById('gameover-streak'),
  btnRetry: document.getElementById('btn-retry'),
  btnGameOverMenu: document.getElementById('btn-gameover-menu'),
  // dev
  devBar: document.getElementById('dev-bar'),
  devState: document.getElementById('dev-state'),
  devLane: document.getElementById('dev-lane'),
  devProgress: document.getElementById('dev-progress'),
  devQuestion: document.getElementById('dev-question'),
  btnDevSubmit: document.getElementById('btn-dev-submit'),
};

const gateEls = [...dom.gatesRoot.querySelectorAll('.answer-gate')];

/* ========================================================================
 * 2. Module state
 * ====================================================================== */

let gameData = null;
let engine = null;
let selectedMode = GAME_MODES.LEARN;
let currentScreen = 'start';
let gateVisualProgress = 0; // frozen while not PLAYING so gates don't snap back
let rafId = null;
let lastFrameTime = null;
let fatalHandled = false;
let devBarLastUpdate = 0;

/* ========================================================================
 * 3. Development helpers (centralized; everything gated behind DEBUG)
 * ====================================================================== */

function logEvent(name, payload) {
  if (!DEBUG) return;
  console.debug(`[event] ${name}`, payload ?? '');
}

function logError(context, error) {
  console.error(`[game] ${context}:`, error);
}

function updateDebugBar(now) {
  if (!DEBUG || !engine || now - devBarLastUpdate < 100) return;
  devBarLastUpdate = now;
  const snap = engine.getSnapshot();
  dom.devState.textContent = snap.state;
  dom.devLane.textContent = `lane ${snap.playerLane ?? '–'}`;
  dom.devProgress.textContent = `gate ${Math.round(gateVisualProgress * 100)}%`;
  dom.devQuestion.textContent = snap.question ? snap.question.id : '–';
}

/* ========================================================================
 * 4. Error handling
 * ====================================================================== */

/** Fatal, page-level failure: stop the loop and explain; never silently ignore. */
function fatalError(message, error) {
  if (fatalHandled) return;
  fatalHandled = true;
  if (error) logError(message, error);
  stopLoop();
  dom.errorMessage.textContent = error ? `${message}\n\n${error && error.stack ? error.stack : error}` : message;
  showScreen('error');
}

function showStartNote(message) {
  dom.startNote.textContent = message;
  dom.startNote.classList.remove('hidden');
}

function clearStartNote() {
  dom.startNote.textContent = '';
  dom.startNote.classList.add('hidden');
}

/* ========================================================================
 * 5. Data loading and engine initialization
 * ====================================================================== */

async function init() {
  let raw;
  try {
    const response = await fetch(DATA_URL, { cache: 'no-cache' });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText} while loading ${DATA_URL}`);
    }
    raw = await response.text();
  } catch (error) {
    fatalError(
      `Could not load game data (${DATA_URL}). Serve the project over HTTP — e.g. "npx serve" or "python -m http.server" — opening index.html directly from disk will not work.`,
      error
    );
    return;
  }

  try {
    gameData = JSON.parse(raw);
    engine = new ArticleRunnerEngine({ data: gameData }); // validates and throws on bad data
  } catch (error) {
    fatalError('The game data failed validation.', error);
    return;
  }

  if (DEBUG) {
    document.body.classList.add('debug');
    dom.devTools.classList.remove('hidden');
    dom.devBar.classList.remove('hidden');
    window.articleRunnerDebug = { get engine() { return engine; } };
  }

  bindEngineEvents();
  bindUiEvents();
  preloadRunFrames(); // concurrent, non-blocking: decode can stall in occluded tabs
  preloadGateArt(); // warm the 3 gate images once; reused from cache afterwards
  preloadSceneImage(); // warm the active breakpoint's environment painting
  renderLevelList();
  showScreen('start');
  startLoop();
}

/** A fresh engine instance (READY state) sharing the same persisted progress. */
function recreateEngine() {
  engine = new ArticleRunnerEngine({ data: gameData, mode: selectedMode });
  bindEngineEvents();
  dom.player.classList.remove('is-running'); // fresh engine starts in READY
  if (DEBUG) window.articleRunnerDebug = { get engine() { return engine; } };
}

/* ========================================================================
 * 6. Engine event bindings
 * ====================================================================== */

function bindEngineEvents() {
  engine.on('state:changed', (payload) => {
    logEvent('state:changed', payload);
    handleStateChanged(payload);
  });
  engine.on('level:started', (payload) => {
    logEvent('level:started', payload);
    clearStartNote();
    renderHUD();
  });
  engine.on('question:loaded', (payload) => {
    logEvent('question:loaded', payload);
    renderQuestion(payload);
  });
  engine.on('player:lane-changed', (payload) => {
    logEvent('player:lane-changed', payload);
    renderPlayer(payload.to);
    highlightChosenGate(payload.to);
    applyLaneLean(payload.from, payload.to);
  });
  engine.on('game:tick', () => {
    /* handled by the render loop; no per-tick work here */
  });
  engine.on('answer:correct', (result) => {
    logEvent('answer:correct', result);
    renderFeedback(result);
  });
  engine.on('answer:wrong', (result) => {
    logEvent('answer:wrong', result);
    renderFeedback(result);
  });
  engine.on('level:completed', (payload) => {
    logEvent('level:completed', payload.summary);
    renderLevelComplete(payload.summary);
  });
  engine.on('game:over', (payload) => {
    logEvent('game:over', payload);
    renderGameOver(payload.summary);
  });
  engine.on('game:paused', () => logEvent('game:paused'));
  engine.on('game:resumed', () => logEvent('game:resumed'));
  engine.on('progress:reset', () => {
    logEvent('progress:reset');
    renderLevelList();
  });
}

function handleStateChanged({ to }) {
  // The fox runs while the engine is PLAYING and keeps trotting through
  // FEEDBACK (slowed by the world crawl in the loop); every other state
  // freezes the current frame (bob and shadow animations stop too).
  const running = to === GAME_STATES.PLAYING || to === GAME_STATES.FEEDBACK;
  dom.player.classList.toggle('is-running', running);
  switch (to) {
    case GAME_STATES.READY:
      showScreen('start');
      break;
    case GAME_STATES.PLAYING:
      renderPause(false);
      hideFeedback();
      showScreen('game');
      // First visible frame (or return from menus): the runner now has a
      // real size, so (re)compute the world geometry off the live layout.
      buildRoadWorld();
      rebuildWorldGeometry();
      break;
    case GAME_STATES.FEEDBACK:
      showScreen('game');
      break;
    case GAME_STATES.PAUSED:
      renderPause(true);
      break;
    case GAME_STATES.LEVEL_COMPLETE:
      renderPause(false);
      renderLevelList();
      showScreen('complete');
      break;
    case GAME_STATES.GAME_OVER:
      renderPause(false);
      renderLevelList();
      showScreen('gameover');
      break;
    default:
      break;
  }
}

/* ========================================================================
 * 7. Screen rendering
 * ====================================================================== */

const screens = {
  start: dom.screenStart,
  game: dom.screenGame,
  complete: dom.screenComplete,
  gameover: dom.screenGameOver,
  error: dom.screenError,
};

function showScreen(name) {
  currentScreen = name;
  for (const [key, element] of Object.entries(screens)) {
    element.classList.toggle('hidden', key !== name);
  }
  if (name === 'start') {
    renderLevelList();
  }
}

/**
 * Pause overlay rendering. (visual pass: restyle the pause screen here;
 * pause/resume decisions stay in the engine)
 */
function renderPause(visible) {
  dom.overlayPause.classList.toggle('hidden', !visible);
}

/* ========================================================================
 * 8. HUD rendering — everything the player sees at the top of the game.
 *     (visual pass: restyle here; data always comes from the snapshot)
 * ====================================================================== */

function renderHUD() {
  const snap = engine.getSnapshot();
  if (!snap.session) return;

  dom.hudLevel.textContent = `${snap.level.title} · ${snap.level.cefr}`;

  const answeredIndex =
    snap.state === GAME_STATES.FEEDBACK && snap.lastResult
      ? snap.lastResult.questionIndex
      : snap.session.questionIndex + 1;
  dom.hudQuestion.textContent = `${answeredIndex} / ${snap.session.totalQuestions}`;

  dom.hudScore.textContent = `${snap.score} pts`;
  dom.hudStreak.textContent = `Streak ${snap.streak}`;

  // Learn Mode uses no lives — only Arcade shows them.
  if (snap.mode === GAME_MODES.ARCADE && snap.lives !== null) {
    const max = gameData.settings.startingLivesArcade;
    const hearts = '♥'.repeat(snap.lives) + '·'.repeat(Math.max(0, max - snap.lives));
    dom.hudLives.textContent = hearts;
    dom.hudLives.classList.remove('hidden');
    dom.hudLives.setAttribute('aria-label', `${snap.lives} lives left`);
  } else {
    dom.hudLives.classList.add('hidden');
  }
}

/* ========================================================================
 * 9. Question & lane rendering
 * ====================================================================== */

function renderQuestion(payload) {
  gateVisualProgress = 0;
  gateLabelBaseStale = true; // fresh question → remeasure label metrics on screen

  // New gate group: spawn far ahead at the horizon and fade in. The road
  // (dashes/stones/tufts) never resets — it just keeps flowing, so the next
  // question reads as a new stretch of the same endless road.
  world.gate.depth = world.gate.r;
  world.gate.spawnFade = 0;
  world.crawl = 1;
  const durS = (payload.gateDurationMs ?? 12000) / 1000;
  const reduced = prefersReducedMotion ? WORLD_MOTION.reducedFactor : 1;
  world.a =
    Math.min(
      WORLD_MOTION.speedMax,
      Math.max(WORLD_MOTION.speedMin, WORLD_MOTION.speedPerGate / durS)
    ) * reduced;

  // Sentence with a visible blank, built from text nodes only.
  dom.sentence.replaceChildren();
  const [before, after = ''] = payload.question.sentence.split('___');
  dom.sentence.append(document.createTextNode(before));
  const blank = document.createElement('span');
  blank.className = 'blank';
  blank.textContent = '_______';
  dom.sentence.append(blank, document.createTextNode(after));

  renderLanes(payload.laneMap);
  renderPlayer(payload.playerLane);
  highlightChosenGate(payload.playerLane);
  hideFeedback();
  dom.player.classList.remove('player-correct', 'player-wrong');
  resetPlayerAnimation(); // smooth, valid pose for the new question
  renderHUD();
}

/**
 * Lane rendering: artwork, label and icon follow the engine's randomized
 * laneMap — never a fixed order. Each gate element keeps one <img>/<span>
 * pair for its lifetime; only the data wired into them changes per question.
 */
function renderLanes(laneMap) {
  laneMap.forEach((category, lane) => {
    const gate = gateEls[lane];
    const visuals = GATE_VISUALS[category];
    if (!visuals) return; // unknown category: keep previous visuals rather than blank
    if (gate.dataset.category !== category) {
      gate.dataset.category = category;
      const art = gate.querySelector('.answer-gate__art');
      if (!art.src.endsWith(visuals.art)) art.src = visuals.art;
      gate.querySelector('.answer-gate__icon').innerHTML = visuals.icon;
      gate.querySelector('.answer-gate__label').textContent = visuals.label;
      gate.setAttribute('aria-label', `${visuals.aria} (key ${lane + 1})`);
    }
    gate.classList.remove('is-chosen', 'is-correct', 'is-wrong');
  });
}

function renderPlayer(lane) {
  dom.player.style.left = PLAYER_LANE_POSITIONS[lane];
  setSceneParallax(lane);
}

/**
 * Micro-parallax: the scenery drifts a couple of px opposite the fox's lane
 * (fox left → world shifts right), which reads as gentle camera sway. The
 * static scale(1.006) on .scene provides the edge slack. Disabled under
 * prefers-reduced-motion — it is pure decoration.
 */
function setSceneParallax(lane) {
  if (prefersReducedMotion) return;
  const driftPx = 2;
  const shift = (1 - lane) * driftPx; // lane 0 → +2px, lane 2 → −2px
  dom.runner.style.setProperty('--scene-parallax-x', `${shift}px`);
}

/**
 * Subtle directional lean during a lane change: a 3deg tilt applied to the
 * container (with the same easing/duration as the lane slide) and removed a
 * moment later, so the fox straightens as it settles. Purely cosmetic — the
 * engine's lane value remains the only source of truth.
 */
let laneLeanTimer = null;

function applyLaneLean(from, to) {
  if (from === null || from === undefined || from === to) return;
  dom.player.classList.remove('lean-left', 'lean-right');
  // Restart the transform transition cleanly when changes come rapid-fire.
  void dom.player.offsetWidth;
  dom.player.classList.add(to > from ? 'lean-right' : 'lean-left');
  clearTimeout(laneLeanTimer);
  laneLeanTimer = setTimeout(() => {
    dom.player.classList.remove('lean-left', 'lean-right');
  }, 240);
}

function highlightChosenGate(lane) {
  gateEls.forEach((gate, index) => gate.classList.toggle('is-chosen', index === lane));
}

/* ---- perspective: gateProgress (engine, normalized 0..1) → visual depth ---
 * Everything below is derived per frame from the SAME progress value, so the
 * three gates always share one depth: ground line, scale, lane spread and
 * opacity move together. No CSS keyframes drive gate motion.
 * ------------------------------------------------------------------------ */

/** Lane x positions as fractions (0..1), read from CSS so layouts stay in CSS. */
let laneXFractions = [0.2, 0.5, 0.8];

/**
 * Scene geometry as fractions, refreshed from the same CSS custom properties
 * that paint the environment (see css/game.css). horizonY is the painted
 * road horizon — the CSS background pins that image row to the same runner
 * fraction, so gates spawning here emerge exactly from the artwork's road.
 */
let sceneGeo = { layout: 'desktop', horizonY: 0.426, collisionY: 0.86 };

function readSceneGeo() {
  const style = getComputedStyle(dom.runner);
  const read = (name, fallback) => {
    const raw = parseFloat(style.getPropertyValue(name));
    return Number.isFinite(raw) ? raw / 100 : fallback;
  };
  laneXFractions = [
    read('--lane-x-0', 0.2),
    read('--lane-x-1', 0.5),
    read('--lane-x-2', 0.8),
  ];
  sceneGeo = {
    layout: style.getPropertyValue('--scene-layout').trim() || 'desktop',
    horizonY: read('--scene-horizon-y', 0.426),
    collisionY: read('--scene-collision-y', 0.86),
  };
}

/** Base label font in px per gate (unscaled cqw size), refreshed on resize. */
let gateLabelBasePx = [0, 0, 0];
/**
 * Re-measure lazily on the first render after layout changes. Container-query
 * sizes resolve to fallbacks while #screen-game is display:none, so measuring
 * must happen only on visible frames.
 */
let gateLabelBaseStale = true;

function refreshGateLabelBase() {
  gateEls.forEach((gate, i) => {
    const label = gate.querySelector('.answer-gate__label');
    gateLabelBasePx[i] = parseFloat(getComputedStyle(label).fontSize) || 0;
  });
  gateLabelBaseStale = false;
}

/* ---- world layer: pooled road objects ----------------------------------
 * Built once, then only transforms/opacity are touched. Dashes ride the
 * painted divider rails, stones the lane rails (avoiding the dividers),
 * tufts the painted road-edge rails, dust the fox's own rail. Everything
 * advances with the same perspective flow coefficient and recycles near
 * the horizon, so the road reads as one endless surface under a camera
 * that never stops moving forward.
 * ---------------------------------------------------------------------- */

const roadLayer = () => document.getElementById('road-layer');

/** Depth at which a road object's ground line passes a given y fraction. */
function depthAtY(yFrac) {
  return (yFrac - world.yVp) / world.laneSpanY;
}

function randRange(min, max) {
  return min + Math.random() * (max - min);
}

/** A random lane-unit position for stones that avoids both divider rails. */
function stoneLaneU() {
  // divider offset in lane units (constant across depth for this rail family)
  const divU = (world.laneSpanY * world.divBase) / world.laneHalf;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const u = randRange(-1.38, 1.38);
    const nearDivider = Math.abs(u - divU) < 0.32 || Math.abs(u + divU) < 0.32;
    if (!nearDivider) return u;
  }
  return 0; // dead center is always clear
}

function buildRoadWorld() {
  if (world.built) return;
  world.built = true;
  const layer = roadLayer();
  if (!layer) return;

  const make = (cls) => {
    const el = document.createElement('div');
    el.className = cls;
    layer.appendChild(el);
    return el;
  };

  // Two static road-tone masks that subtly repaint the baked divider stripes,
  // so the moving dashes never fight a second, static set of markings.
  world.masks = [make('lane-mask lane-mask--left'), make('lane-mask lane-mask--right')];

  // 8 dashes per divider line, spread evenly in depth from just below the
  // horizon to just past the collision plane, second line phase-shifted.
  const dashSpacing = 0.94 / 7;
  for (let line = 0; line < 2; line += 1) {
    for (let i = 0; i < 8; i += 1) {
      const el = make('road-dash');
      world.dashes.push({
        el,
        line,
        depth: 0.03 + dashSpacing * i + (line ? dashSpacing * 0.5 : 0),
      });
    }
  }

  // Stones: modest count, three size variants, random rotation.
  const stoneCls = ['road-stone stone-a', 'road-stone stone-b', 'road-stone stone-c'];
  for (let i = 0; i < 11; i += 1) {
    const el = make(stoneCls[i % 3]);
    world.stones.push({
      el,
      depth: randRange(0.12, 1.2),
      u: stoneLaneU(),
      rot: randRange(-40, 40),
    });
  }

  // Roadside tufts (grass + occasional flower) on the painted road edges.
  for (let i = 0; i < 6; i += 1) {
    const el = make(i % 3 === 0 ? 'road-tuft tuft-flower' : 'road-tuft');
    world.tufts.push({ el, side: i % 2 === 0 ? 1 : -1, depth: randRange(0.14, 0.48) });
  }

  // Dust puffs behind the fox (spawned at runtime, pooled).
  for (let i = 0; i < 6; i += 1) {
    const el = make('dust-puff');
    el.style.opacity = '0';
    world.dusts.push({ el, depth: 0, m: 0, born: 0, size: randRange(0.6, 1.3) });
  }
}

/**
 * Recompute every screen-space value the world layer needs: runner size,
 * cover-crop factors for the active painting, divider/edge slopes, dash
 * rotations, mask shapes and pooled element base sizes. Cheap, idempotent;
 * called on init, when the game screen shows and on resize.
 */
function rebuildWorldGeometry() {
  const art = WORLD_ART[sceneGeo.layout] ?? WORLD_ART.desktop;
  const rect = dom.runner.getBoundingClientRect();
  if (rect.width < 40 || rect.height < 40) return; // hidden screen — try again when shown

  world.W = rect.width;
  world.H = rect.height;
  world.yVp = sceneGeo.horizonY;
  world.yCol = sceneGeo.collisionY;
  world.laneSpanY = world.yCol - world.yVp;
  world.laneHalf = (Math.abs(laneXFractions[0] - 0.5) + Math.abs(laneXFractions[2] - 0.5)) / 2;
  world.gate.r = WORLD_MOTION.easeR[sceneGeo.layout] ?? WORLD_MOTION.easeR.desktop;

  // Cover-crop factors of the pinned scene painting (see css/game.css):
  // the painting's horizon row is pinned to the same runner fraction, so a
  // painted line through the vanishing point maps affinely here — the
  // quadratic rail coefficients transform the same way.
  const runnerAspect = world.W / world.H;
  const kx = art.aspect > runnerAspect ? art.aspect / runnerAspect : 1;
  const ky = runnerAspect > art.aspect ? runnerAspect / art.aspect : 1;
  world.divA = (kx * art.dividerA) / ky;
  world.divB = (kx * art.dividerB) / (ky * ky);
  // spread normalizer: family(L)/L = divA + divB·L (so laneSpread(1) === 1)
  world.divBase = world.divA + world.divB * world.laneSpanY;
  world.edgeA = (kx * art.edgeA) / Math.pow(ky, art.edgePow);
  world.edgePow = art.edgePow;

  // Masks: thin curved strips from just above the painted dashes' first row
  // to past the bottom, tapering to a point exactly like the stripes they
  // replace (11 samples along the fitted rail).
  const yTop = art.maskTopY;
  const yBot = 1.03;
  world.masks.forEach((mask, i) => {
    const side = i === 0 ? -1 : 1;
    const rightEdge = [];
    const leftEdge = [];
    const STEPS = 10;
    for (let s = 0; s <= STEPS; s += 1) {
      const yF = yTop + ((yBot - yTop) * s) / STEPS;
      const dy = yF - sceneGeo.horizonY;
      const c = 50 + side * railOffset(dy) * 100;
      const hw = Math.max(0.02, (art.maskHalf1 * dy * 100) / (1 - sceneGeo.horizonY));
      rightEdge.push(`${(c + hw).toFixed(2)}% ${(yF * 100).toFixed(2)}%`);
      leftEdge.push(`${(c - hw).toFixed(2)}% ${(yF * 100).toFixed(2)}%`);
    }
    mask.style.clipPath = `polygon(${rightEdge.join(', ')}, ${leftEdge.reverse().join(', ')})`;
    mask.style.background = `linear-gradient(to bottom, ${art.toneTop}, ${art.toneBottom})`;
  });

  // Base sizes at the collision plane (scale 1); per-frame scale = depth.
  const dashW = art.dashW0 * world.W;
  for (const d of world.dashes) {
    d.el.style.width = `${dashW.toFixed(1)}px`;
    d.el.style.height = `${(dashW * art.dashAspect).toFixed(1)}px`;
  }
  const stoneBase = world.W * 0.013;
  world.stones.forEach((s, i) => {
    const v = 0.75 + (i % 3) * 0.42;
    s.el.style.width = `${(stoneBase * v).toFixed(1)}px`;
    s.el.style.height = `${(stoneBase * v * 0.72).toFixed(1)}px`;
  });
  const tuftBase = world.W * 0.02;
  world.tufts.forEach((t, i) => {
    const v = 0.8 + (i % 2) * 0.5;
    t.el.style.width = `${(tuftBase * v).toFixed(1)}px`;
    t.el.style.height = `${(tuftBase * v * 0.62).toFixed(1)}px`;
  });
  const dustBase = world.W * 0.024;
  world.dusts.forEach((p) => {
    p.el.style.width = `${(dustBase * p.size).toFixed(1)}px`;
    p.el.style.height = `${(dustBase * p.size).toFixed(1)}px`;
  });

  renderWorldStatic();
}

/** Reposition every pooled object from its stored depth (after geometry
 * changes); keeps the world intact across resizes and breakpoints. */
function renderWorldStatic() {
  if (!world.built || world.W < 40) return;
  for (const d of world.dashes) renderDash(d);
  for (const s of world.stones) renderStone(s);
  for (const t of world.tufts) renderTuft(t);
  for (const p of world.dusts) renderDust(p);
}

function setLayerZ(el, depth) {
  const z = 1 + Math.round(Math.min(Math.max(depth, 0), 1.45) * 2);
  el.style.zIndex = String(z);
}

function renderDash(d) {
  const side = d.line === 0 ? -1 : 1;
  const dy = d.depth * world.laneSpanY;
  const y = (world.yVp + dy) * world.H;
  const x = (0.5 + side * railOffset(dy)) * world.W;
  // local tangent of the curved rail → dash rotation (px space)
  const mLocal = side * (world.divA + 2 * world.divB * dy);
  const angle = (Math.atan2(mLocal * world.W, world.H) * 180) / Math.PI;
  d.el.style.transform =
    `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) ` +
    `translate(-50%, -50%) rotate(${angle.toFixed(1)}deg) scale(${d.depth.toFixed(3)})`;
  d.el.style.opacity = Math.min(1, 0.25 + d.depth * 3).toFixed(2);
  setLayerZ(d.el, d.depth);
}

function renderStone(s) {
  const p = projectRoadPoint(s.depth, s.u);
  s.el.style.transform =
    `translate3d(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px, 0) ` +
    `translate(-50%, -50%) rotate(${s.rot.toFixed(0)}deg) scale(${(s.depth * 0.92).toFixed(3)})`;
  s.el.style.opacity = Math.min(0.85, 0.2 + s.depth * 2.2).toFixed(2);
  setLayerZ(s.el, s.depth);
}

function renderTuft(t) {
  const p = edgeRailX(t.depth, t.side);
  t.el.style.transform =
    `translate3d(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px, 0) ` +
    `translate(-50%, -60%) scale(${t.depth.toFixed(3)})`;
  t.el.style.opacity = Math.min(0.9, 0.3 + t.depth * 2.6).toFixed(2);
  setLayerZ(t.el, t.depth);
}

function renderDust(p) {
  if (p.born <= 0) {
    p.el.style.opacity = '0';
    return; // pooled but idle
  }
  const x = (0.5 + p.m * p.depth) * world.W;
  const y = (world.yVp + p.depth * world.laneSpanY) * world.H;
  const life = Math.min(1, Math.max(0, (p.depth - p.born) / 0.26));
  p.el.style.transform =
    `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) ` +
    `translate(-50%, -50%) scale(${(0.55 + p.depth * 0.5).toFixed(3)})`;
  p.el.style.opacity = (0.3 * (1 - life)).toFixed(3);
  setLayerZ(p.el, Math.min(p.depth, 1.3));
}

/**
 * Advance + render the whole world layer for one frame.
 * coeff = world.a · slow-motion factor (0 pauses everything: gates, dashes,
 * stones, dust). Dust is spawned at the fox's feet and rides the same flow.
 */
function updateWorldMotion(dt, coeff, playerAnimFactor) {
  if (!world.built || world.W < 40) return;
  const dExit = depthAtY(WORLD_MOTION.yExit);
  const dSpawnBase = depthAtY(world.yVp + 0.018);

  if (coeff > 0) {
    for (const d of world.dashes) {
      d.depth = flowDepth(d.depth, dt, coeff);
      if (d.depth > dExit) d.depth = dSpawnBase + Math.random() * dSpawnBase * 0.8;
      renderDash(d);
    }
    for (const s of world.stones) {
      s.depth = flowDepth(s.depth, dt, coeff);
      if (s.depth > 1.3) {
        s.depth = randRange(0.1, 0.22);
        s.u = stoneLaneU();
      }
      renderStone(s);
    }
    for (const t of world.tufts) {
      t.depth = flowDepth(t.depth, dt, coeff);
      const x = edgeRailX(t.depth, t.side).x / world.W;
      if (t.depth > 1.25 || x < -0.06 || x > 1.06) t.depth = randRange(0.12, 0.2);
      renderTuft(t);
    }
    for (const p of world.dusts) {
      if (p.born > 0) {
        p.depth = flowDepth(p.depth, dt, coeff);
        if (p.depth > p.born + 0.3) p.born = 0;
        renderDust(p);
      }
    }

    // Dust spawning at the fox's ground line (skipped under reduced motion).
    if (!prefersReducedMotion && playerAnimFactor > 0) {
      world.dustTimer += dt * 1000 * playerAnimFactor;
      if (world.dustTimer >= WORLD_MOTION.dustEveryMs) {
        world.dustTimer = 0;
        const puff = world.dusts[world.dustIdx++ % world.dusts.length];
        const foxLeft = parseFloat(getComputedStyle(dom.player).left);
        const foxX = Number.isFinite(foxLeft) && foxLeft > 0 ? foxLeft / world.W : 0.5;
        puff.born = depthAtY(0.955) - randRange(0.04, 0.11);
        puff.depth = puff.born;
        puff.m = (foxX - 0.5) / puff.depth + randRange(-0.035, 0.035);
        renderDust(puff);
      }
    }
  }
}

/**
 * Gate visual state per engine state:
 *  - PLAYING: depth follows gateEase(gateProgress) exactly, so the gate
 *    reaches the collision plane at the same instant the engine resolves.
 *  - FEEDBACK: the gate keeps flowing with the world (slowed by the crawl
 *    factor), sliding past/behind the fox rather than stopping in its face.
 */
function updateGateVisual(dt, state) {
  const g = world.gate;
  if (state === GAME_STATES.PLAYING) {
    g.depth = gateEase(gateVisualProgress);
    g.spawnFade = Math.min(1, g.spawnFade + dt * 3.6);
  } else if (state === GAME_STATES.FEEDBACK) {
    g.spawnFade = 1;
    g.depth = Math.min(1.42, flowDepth(g.depth, dt, world.a * world.crawl));
  }
}

function renderGates() {
  const laneMap = engine.laneMap;
  if (!laneMap || laneMap.length === 0) return;
  // Container-query sizes only resolve on screen — measure lazily on the
  // first visible frame rather than while #screen-game is display:none.
  if (gateLabelBaseStale) refreshGateLabelBase();
  const { farScale, nearScale, farOpacity, minLabelPx, maxLabelBoost } = RUNNER_GEO;
  const D = world.gate.depth;
  const scale = farScale + (nearScale - farScale) * D;
  const yFrac = world.yVp + D * world.laneSpanY;
  // Fade in from the horizon on spawn, fade out once passed behind the fox.
  const passFade = 1 - Math.min(1, Math.max(0, (D - 1.12) / 0.2));
  const opacity =
    (farOpacity + (1 - farOpacity) * Math.min(1, D / 0.45)) * world.gate.spawnFade * passFade;

  for (let lane = 0; lane < 3; lane += 1) {
    // Gates ride the lane rails: squeezed to the vanishing point at spawn,
    // following the painted lanes' mid-road bow (laneSpread), and landing
    // exactly on the CSS lane anchors (--lane-x-*) at the collision moment.
    const xFrac = 0.5 + (laneXFractions[lane] - 0.5) * laneSpread(D);
    const el = gateEls[lane];
    // (x, y) is the gate's ground point: bottom-centered, standing on the road.
    el.style.transform =
      `translate3d(${(xFrac * world.W).toFixed(1)}px, ${(yFrac * world.H).toFixed(1)}px, 0) ` +
      `translate(-50%, -100%) scale(${scale.toFixed(4)})`;
    el.style.opacity = opacity.toFixed(3);
    setLayerZ(el, D); // always below the player (z 5)
    // Contact shadow reads stronger as the gate gets close.
    el.style.setProperty('--gate-shadow-o', (0.22 + 0.4 * Math.min(D, 1)).toFixed(3));

    // Keep labels readable at distance: counter-scale up while the gate is
    // small, easing back to 1 once the board itself is large enough.
    const base = gateLabelBasePx[lane];
    const boost =
      base > 0 ? Math.min(maxLabelBoost, Math.max(1, minLabelPx / (base * scale))) : 1;
    el.style.setProperty('--label-boost', boost.toFixed(3));
  }
}

/* ========================================================================
 * 10. Feedback rendering (engine payload only — no UI-side explanations)
 * ====================================================================== */

function hideFeedback() {
  dom.feedback.classList.add('hidden');
  dom.feedback.classList.remove('feedback-correct', 'feedback-wrong');
}

function renderFeedback(result) {
  if (engine.state !== GAME_STATES.FEEDBACK) return; // e.g. game-over screens take over

  // World slow-motion through the feedback moment: correct answers keep the
  // fox trotting forward (gate slides past quickly), wrong answers hesitate.
  world.crawl = result.isCorrect ? WORLD_MOTION.crawlCorrect : WORLD_MOTION.crawlWrong;

  gateEls.forEach((gate) => {
    if (gate.dataset.category === result.correctCategory) gate.classList.add('is-correct');
  });
  const chosenGate = gateEls[result.selectedLane];
  if (chosenGate && !result.isCorrect) chosenGate.classList.add('is-wrong');
  dom.player.classList.toggle('player-correct', result.isCorrect);
  dom.player.classList.toggle('player-wrong', !result.isCorrect);

  dom.feedback.classList.remove('hidden', 'feedback-correct', 'feedback-wrong');
  dom.feedback.classList.add(result.isCorrect ? 'feedback-correct' : 'feedback-wrong');
  dom.feedbackTitle.textContent = result.isCorrect ? 'Correct!' : 'Not quite';

  // Completed sentence with the filled article emphasized (when there is one).
  dom.feedbackSentence.replaceChildren();
  if (result.correctArticle) {
    // Highlight only the first occurrence — an article like "a" appears many times.
    const at = result.completedSentence.indexOf(result.correctArticle);
    if (at === -1) {
      dom.feedbackSentence.textContent = result.completedSentence;
    } else {
      dom.feedbackSentence.append(
        document.createTextNode(result.completedSentence.slice(0, at))
      );
      const filled = document.createElement('span');
      filled.className = 'filled';
      filled.textContent = result.correctArticle;
      dom.feedbackSentence.append(
        filled,
        document.createTextNode(result.completedSentence.slice(at + result.correctArticle.length))
      );
    }
  } else {
    dom.feedbackSentence.textContent = result.completedSentence;
  }

  if (result.isCorrect) {
    dom.feedbackDetail.textContent = `+${result.pointsGained} points · streak ${result.streak} · ${result.ruleLabel}`;
  } else {
    const article = result.correctArticle ? `"${result.correctArticle}"` : 'no article';
    dom.feedbackDetail.textContent =
      `Correct answer: ${article} (${CATEGORY_LABELS[result.correctCategory] ?? result.correctCategory}). ` +
      `${result.explanation}`;
  }

  dom.btnContinue.focus({ preventScroll: true });
  renderHUD();
}

/* ========================================================================
 * 11. Level complete & game over rendering
 * ====================================================================== */

function starsText(stars) {
  return '★'.repeat(stars) + '☆'.repeat(Math.max(0, 3 - stars));
}

function renderLevelComplete(summary) {
  dom.completeTitle.textContent =
    summary.passed ? `${summary.levelTitle} complete!` : `${summary.levelTitle} — keep practicing`;
  dom.completeStars.textContent = starsText(summary.stars);
  dom.completeCorrect.textContent = summary.correct;
  dom.completeWrong.textContent = summary.wrong;
  dom.completeAccuracy.textContent = `${Math.round(summary.accuracy * 100)}%`;
  dom.completeScore.textContent = summary.score;
  dom.completeStreak.textContent = summary.bestStreak;

  if (summary.weakRules.length > 0) {
    dom.completeWeak.classList.remove('hidden');
    dom.completeWeakList.replaceChildren(
      ...summary.weakRules.map((weak) => {
        const li = document.createElement('li');
        li.textContent = `${weak.label} — ${Math.round(weak.accuracy * 100)}% (${weak.correct}/${weak.attempts})`;
        return li;
      })
    );
  } else {
    dom.completeWeak.classList.add('hidden');
  }

  // Next level availability comes from the engine's stored progression.
  const nextLevel = nextLevelAfter(summary.levelId);
  if (nextLevel) {
    const unlocked = engine.getProgress().unlockedLevels.includes(nextLevel.id);
    dom.btnNextLevel.classList.remove('hidden');
    dom.btnNextLevel.disabled = !unlocked;
    dom.btnNextLevel.textContent = unlocked ? `Next: ${nextLevel.title}` : `Next: ${nextLevel.title} (locked)`;
  } else {
    dom.btnNextLevel.classList.add('hidden');
  }
}

function nextLevelAfter(levelId) {
  const index = gameData.levels.findIndex((level) => level.id === levelId);
  return gameData.levels[index + 1] ?? null;
}

function renderGameOver(summary) {
  dom.gameOverAnswered.textContent = `${summary.answered} / ${summary.totalQuestions}`;
  dom.gameOverCorrect.textContent = summary.correct;
  dom.gameOverScore.textContent = summary.score;
  dom.gameOverStreak.textContent = summary.bestStreak;
}

/* ========================================================================
 * 12. Level selector (start screen)
 * ====================================================================== */

function renderLevelList() {
  if (!engine) return;
  const progress = engine.getProgress();
  dom.levelList.replaceChildren(
    ...gameData.levels.map((level) => {
      const unlocked = progress.unlockedLevels.includes(level.id);
      const record = progress.levels[String(level.id)];
      const stars = record ? starsText(record.bestStars) : '';
      const meta = [`CEFR ${level.cefr}`, `${level.questionCount} questions`];
      if (record) meta.push(`best ${record.bestScore} pts`);

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'level-item';
      button.disabled = !unlocked;
      button.setAttribute('aria-label', unlocked ? `Play ${level.title}` : `${level.title} (locked)`);
      const title = document.createElement('span');
      title.className = 'level-item-title';
      title.textContent = unlocked ? `${level.id}. ${level.title}` : `🔒 ${level.id}. ${level.title}`;
      const metaSpan = document.createElement('span');
      metaSpan.className = 'level-item-meta';
      metaSpan.textContent = meta.join(' · ');
      const starsSpan = document.createElement('span');
      starsSpan.className = 'level-item-stars';
      starsSpan.textContent = stars;
      button.append(title, metaSpan, starsSpan);
      button.addEventListener('click', () => startGame(level.id));
      return button;
    })
  );

  const passedCount = progress.passedLevels.length;
  const allPassed = passedCount === gameData.levels.length;
  dom.btnPlay.textContent = allPassed ? `Play ${gameData.levels[gameData.levels.length - 1].title}` : 'Play';
}

/** First unlocked level not passed yet in Learn Mode (or the last level). */
function pickDefaultLevel() {
  const progress = engine.getProgress();
  const next = gameData.levels.find(
    (level) => progress.unlockedLevels.includes(level.id) && !progress.passedLevels.includes(level.id)
  );
  return (next ?? gameData.levels[gameData.levels.length - 1]).id;
}

function startGame(levelId) {
  try {
    engine.startLevel(levelId, { mode: selectedMode });
  } catch (error) {
    logError('startLevel', error);
    showStartNote(error.message);
  }
}

/* ========================================================================
 * 13. Input handling (keyboard + pointer)
 * ====================================================================== */

function bindUiEvents() {
  // -- start screen --
  dom.btnPlay.addEventListener('click', () => {
    clearStartNote();
    startGame(pickDefaultLevel());
  });
  dom.btnModeLearn.addEventListener('click', () => setMode(GAME_MODES.LEARN));
  dom.btnModeArcade.addEventListener('click', () => setMode(GAME_MODES.ARCADE));
  dom.btnResetProgress.addEventListener('click', () => {
    engine.resetProgress(); // dev-only control; refreshes the level list via event
  });
  dom.btnErrorReload.addEventListener('click', () => window.location.reload());

  // -- game screen --
  dom.btnPause.addEventListener('click', () => togglePause());
  dom.btnContinue.addEventListener('click', () => continueAfterFeedback());

  // Tap a gate to move to its lane; tapping never resolves the question.
  for (const gate of gateEls) {
    gate.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      movePlayerToLane(Number(gate.dataset.lane));
    });
  }

  // Tap anywhere on the road to move to that lane (mobile-friendly).
  dom.runner.addEventListener('pointerdown', (event) => {
    const rect = dom.runner.getBoundingClientRect();
    const lane = Math.floor(((event.clientX - rect.left) / rect.width) * 3);
    movePlayerToLane(lane);
  });

  // -- pause overlay --
  dom.btnResume.addEventListener('click', () => togglePause());
  dom.btnQuit.addEventListener('click', () => {
    // Abandon the run: a fresh engine shares the same persisted progress.
    recreateEngine();
    renderPause(false);
    showScreen('start');
  });

  // -- level complete --
  dom.btnPlayAgain.addEventListener('click', () => {
    try {
      engine.restartLevel();
    } catch (error) {
      logError('restartLevel', error);
    }
  });
  dom.btnNextLevel.addEventListener('click', () => {
    const next = nextLevelAfter(engine.getSnapshot().level?.id);
    if (next) startGame(next.id);
  });
  dom.btnCompleteMenu.addEventListener('click', () => showScreen('start'));

  // -- game over --
  dom.btnRetry.addEventListener('click', () => {
    try {
      engine.restartLevel();
    } catch (error) {
      logError('restartLevel', error);
    }
  });
  dom.btnGameOverMenu.addEventListener('click', () => showScreen('start'));

  // -- dev --
  dom.btnDevSubmit.addEventListener('click', () => {
    if (engine.state !== GAME_STATES.PLAYING) return;
    try {
      engine.submitCurrentLane();
    } catch (error) {
      logError('submitCurrentLane', error);
    }
  });

  // -- keyboard --
  window.addEventListener('keydown', handleKeydown);

  // -- responsive geometry: lanes, horizon + label metrics follow the scene
  //    breakpoints in CSS (680px / 1100px); rotation/resize re-reads them --
  readSceneGeo();
  buildRoadWorld(); // pooled road objects exist before the first level
  rebuildWorldGeometry(); // no-op while the game screen is hidden
  gateLabelBaseStale = true; // re-measured on the next visible frame
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const layoutBefore = sceneGeo.layout;
      readSceneGeo();
      rebuildWorldGeometry(); // slopes, masks and pooled sizes follow the new layout
      gateLabelBaseStale = true;
      // Breakpoint crossed (e.g. tablet rotated): warm the newly selected
      // painting before CSS swaps it in, so the scene never flashes.
      if (sceneGeo.layout !== layoutBefore) preloadSceneImage();
    }, 120);
  });
}

function setMode(mode) {
  selectedMode = mode;
  dom.btnModeLearn.classList.toggle('is-active', mode === GAME_MODES.LEARN);
  dom.btnModeArcade.classList.toggle('is-active', mode === GAME_MODES.ARCADE);
  dom.btnModeLearn.setAttribute('aria-pressed', String(mode === GAME_MODES.LEARN));
  dom.btnModeArcade.setAttribute('aria-pressed', String(mode === GAME_MODES.ARCADE));
}

/** All movement goes through the engine; the UI never tracks lanes itself. */
function movePlayerToLane(lane) {
  if (engine.state !== GAME_STATES.PLAYING) return; // respects inputLocked
  if (!Number.isInteger(lane) || lane < 0 || lane > 2) return;
  try {
    engine.moveToLane(lane);
  } catch (error) {
    logError('moveToLane', error);
  }
}

function handleKeydown(event) {
  if (!engine || currentScreen === 'start' || currentScreen === 'error') return;
  const state = engine.state;
  let handled = true;

  switch (event.key) {
    case 'ArrowLeft':
    case 'a':
    case 'A':
      if (state === GAME_STATES.PLAYING) safeEngineCall(() => engine.moveLeft());
      break;
    case 'ArrowRight':
    case 'd':
    case 'D':
      if (state === GAME_STATES.PLAYING) safeEngineCall(() => engine.moveRight());
      break;
    case '1':
    case '2':
    case '3':
      if (state === GAME_STATES.PLAYING) movePlayerToLane(Number(event.key) - 1);
      break;
    case 'Escape':
      togglePause();
      break;
    case ' ':
    case 'Enter':
      if (state === GAME_STATES.FEEDBACK) continueAfterFeedback();
      else if (state === GAME_STATES.PAUSED) togglePause();
      else handled = state === GAME_STATES.PLAYING; // don't swallow space while playing
      break;
    default:
      handled = false;
  }

  if (handled && (event.key === ' ' || event.key.startsWith('Arrow') || event.key === 'Escape')) {
    event.preventDefault(); // stop page scrolling / button re-clicking
  }
}

function safeEngineCall(action) {
  try {
    action();
  } catch (error) {
    // State changed between check and call (rapid input) — safe to log and skip.
    logError('engine call', error);
  }
}

function togglePause() {
  const state = engine.state;
  if (state === GAME_STATES.PLAYING) {
    safeEngineCall(() => engine.pause());
  } else if (state === GAME_STATES.PAUSED) {
    safeEngineCall(() => engine.resume());
  }
}

function continueAfterFeedback() {
  if (engine.state !== GAME_STATES.FEEDBACK) return;
  safeEngineCall(() => engine.continueAfterFeedback());
}

/* ========================================================================
 * 14. Player character animation (fox) — presentation only.
 *     The engine never sees filenames, frame timing or images; this
 *     controller only READS game state and renders the character.
 * ====================================================================== */

/** Approved run cycle (order chosen by measured stride continuity). */
const RUN_FRAMES = [
  { src: 'assets/characters/fox-run-01.png', cls: 'pf-1' },
  { src: 'assets/characters/fox-run-02.png', cls: 'pf-2' },
  { src: 'assets/characters/fox-run-03.png', cls: 'pf-3' },
  { src: 'assets/characters/fox-run-04.png', cls: 'pf-4' },
  { src: 'assets/characters/fox-run-05.png', cls: 'pf-5' },
  { src: 'assets/characters/fox-run-06.png', cls: 'pf-6' },
  { src: 'assets/characters/fox-run-07.png', cls: 'pf-7' },
  { src: 'assets/characters/fox-run-08.png', cls: 'pf-8' },
];

/** Milliseconds per running frame (visual only — never affects scoring). */
const RUN_FRAME_DURATION = 88;

const RUN_FRAME_DURATION_REDUCED = 220;

/** Single lane-position mapping (values live in CSS on .runner). */
const PLAYER_LANE_POSITIONS = ['var(--lane-x-0)', 'var(--lane-x-1)', 'var(--lane-x-2)'];

const prefersReducedMotion =
  typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;

let runFrameIndex = 0;
let runFrameAccumulator = 0;
/** Frames that preloaded successfully; always falls back to the first valid one. */
let runtimeRunFrames = [];

/**
 * Preload and decode every frame before gameplay so the first run never
 * flickers. Runs concurrently with boot and NEVER blocks the app: some
 * browsers stall img.decode() while the page is occluded, so each frame is
 * raced against a timeout and init() does not await completion. Frames that
 * genuinely fail (naturalWidth stays 0) are dropped and logged in DEBUG mode;
 * the animation then simply runs on the frames that did load.
 */
const FRAME_PRELOAD_TIMEOUT_MS = 4000;

function preloadOneFrame(frame) {
  return new Promise((resolve) => {
    const img = new Image();
    const done = () => resolve({ frame, ok: img.naturalWidth > 0 });
    img.onload = done;
    img.onerror = () => resolve({ frame, ok: false });
    img.src = frame.src;
    if (typeof img.decode === 'function') {
      img.decode().then(done, done); // decode result is advisory; onload/timeout settle it
    }
    setTimeout(done, FRAME_PRELOAD_TIMEOUT_MS);
  });
}

async function preloadRunFrames() {
  const results = await Promise.all(RUN_FRAMES.map(preloadOneFrame));
  runtimeRunFrames = results.filter((r) => r.ok).map((r) => r.frame);
  if (runtimeRunFrames.length < RUN_FRAMES.length && DEBUG) {
    const missing = RUN_FRAMES.filter((f) => !runtimeRunFrames.includes(f)).map((f) => f.src);
    console.warn('[game] player frames failed to preload:', missing);
  }
  applyRunFrame(0);
}

/**
 * Warm the three gate artworks exactly once, before the first level can
 * start (init kicks this off while the start screen renders). Loaded images
 * stay in the browser cache; renderLanes then only re-points cached srcs,
 * never creating new image requests per question. On failure the gates root
 * gets .gates-art-failed and CSS draws a plain fallback gate instead — the
 * game must keep working without the artwork.
 */
async function preloadGateArt() {
  const load = (src) =>
    new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve({ src, ok: img.naturalWidth > 0 });
      img.onerror = () => resolve({ src, ok: false });
      img.src = src;
      if (typeof img.decode === 'function') {
        img.decode().then(() => resolve({ src, ok: img.naturalWidth > 0 }), () => resolve({ src, ok: false }));
      }
    });

  const results = await Promise.all(Object.values(GATE_VISUALS).map((v) => load(v.art)));
  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.error('[game] gate artwork failed to load, using CSS fallback:', failed.map((f) => f.src));
    dom.gatesRoot.classList.add('gates-art-failed');
  } else {
    dom.gatesRoot.classList.add('gates-ready');
  }
}

/**
 * Preload + decode the ONE environment painting the current breakpoint
 * actually uses, before gameplay begins, so the world never flashes in
 * half-painted. The URL is read from the resolved CSS background (the same
 * media queries that paint it) — no breakpoint logic is duplicated here.
 * Only the active variant is fetched; the other device-class images stay
 * untouched. Purely best-effort: a failed load just leaves the CSS sky
 * fallback in place, gameplay is unaffected.
 */
function preloadSceneImage() {
  if (!dom.scene || typeof Image === 'undefined') return;
  const match = getComputedStyle(dom.scene).backgroundImage.match(/url\((['"]?)([^'")]+)\1\)/);
  if (!match) return;
  const img = new Image();
  img.src = match[2];
  if (typeof img.decode === 'function') {
    img.decode().catch(() => {}); // advisory only — onload/timeout settle it
  }
}

/** Frames actually cycled in the current motion-preference mode. */
function activeRunFrames() {
  if (!prefersReducedMotion || runtimeRunFrames.length < 2) return runtimeRunFrames;
  // Reduced motion: slow two-frame loop (first + opposite phase of the cycle).
  const mid = Math.floor(runtimeRunFrames.length / 2);
  return [runtimeRunFrames[0], runtimeRunFrames[mid]];
}

function activeFrameDuration() {
  return prefersReducedMotion ? RUN_FRAME_DURATION_REDUCED : RUN_FRAME_DURATION;
}

function applyRunFrame(index) {
  const frame = activeRunFrames()[index];
  if (!frame || dom.playerImg.src.endsWith(frame.src)) return;
  dom.playerImg.src = frame.src;
  dom.playerImg.className = `player-img ${frame.cls}`;
}

function updatePlayerAnimation(deltaMs) {
  const frames = activeRunFrames();
  if (frames.length === 0) return;
  // Clamp so one long frame (tab switch) cannot fast-forward the cycle.
  runFrameAccumulator += Math.min(deltaMs, 250);
  const duration = activeFrameDuration();
  while (runFrameAccumulator >= duration) {
    runFrameAccumulator -= duration;
    runFrameIndex = (runFrameIndex + 1) % frames.length;
  }
  applyRunFrame(runFrameIndex);
}

/** Back to a valid pose for a new question, level restart or fresh run. */
function resetPlayerAnimation() {
  runFrameIndex = 0;
  runFrameAccumulator = 0;
  applyRunFrame(0);
}

/* ========================================================================
 * 15. Animation loop (single driver; the engine owns timing & collision)
 * ====================================================================== */

/**
 * Dev/test fallback: "?frameloop=interval" drives the identical loop from a
 * 16ms timer. Browsers starve requestAnimationFrame in occluded webviews
 * (e.g. automated visual checks), which would otherwise freeze the world;
 * the flag changes nothing about gameplay or timing semantics.
 */
const FORCE_INTERVAL_LOOP =
  typeof location !== 'undefined' && /[?&]frameloop=interval/.test(location.search);

function startLoop() {
  if (rafId !== null) return;
  lastFrameTime = null;
  if (FORCE_INTERVAL_LOOP) {
    rafId = setInterval(() => loop(performance.now()), 16);
    return;
  }
  rafId = requestAnimationFrame(loop);
}

function stopLoop() {
  if (rafId !== null) {
    if (FORCE_INTERVAL_LOOP) clearInterval(rafId);
    else cancelAnimationFrame(rafId);
    rafId = null;
  }
}

function loop(now) {
  if (!FORCE_INTERVAL_LOOP) rafId = requestAnimationFrame(loop);
  const deltaMs = lastFrameTime === null ? 0 : now - lastFrameTime;
  lastFrameTime = now;

  try {
    if (!engine) return;

    if (engine.state === GAME_STATES.PLAYING) {
      engine.update(deltaMs); // engine clamps huge deltas (tab switches) itself
      // update() can auto-resolve the question (PLAYING → FEEDBACK) and the
      // engine resets its progress — re-check before adopting the value, or
      // the gates would flash back to the horizon on timed resolutions.
      if (engine.state === GAME_STATES.PLAYING) {
        gateVisualProgress = engine.gateProgress;
        updatePlayerAnimation(deltaMs); // same loop, same delta — presentation only
      }
    }
    const state = engine.state;

    if (currentScreen === 'game') {
      // World flow: full speed while running, slow-motion crawl through
      // feedback, frozen while paused/elsewhere. Delta is clamped so a
      // background tab can never teleport the road.
      const dt = Math.min(deltaMs, 40) / 1000;
      const coeff =
        state === GAME_STATES.PLAYING ? world.a
        : state === GAME_STATES.FEEDBACK ? world.a * world.crawl
        : 0;

      if (state === GAME_STATES.FEEDBACK) {
        // The fox keeps trotting through the feedback moment, matched to the
        // world crawl so it never looks like it crashed into the gate.
        updatePlayerAnimation(Math.min(deltaMs, 40) * (0.35 + world.crawl));
      }

      updateWorldMotion(dt, coeff, state === GAME_STATES.PLAYING ? 1 : world.crawl * 1.6);
      updateGateVisual(dt, state);
      renderGates();
      updateDebugBar(now);
    }
  } catch (error) {
    fatalError('The game loop hit an unexpected error. Progress in localStorage is untouched.', error);
  }
}

/* ========================================================================
 * Boot
 * ====================================================================== */

init();
