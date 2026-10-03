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

/** Short, answer-safe prompts keyed by the engine's public grammar rule. */
const RULE_HINTS = {
  'indefinite-first-mention': 'Is this one new, nonspecific thing? Listen to its first sound too.',
  'indefinite-jobs': 'A singular job normally needs an article. Listen to the job’s first sound.',
  'definite-specific': 'Can the listener identify exactly which thing the sentence means?',
  'definite-unique': 'Ask whether there is only one of this thing in the situation or the world.',
  'definite-second-mention': 'Has this noun already been introduced earlier in the sentence or story?',
  'zero-meals': 'Is the meal named as part of an ordinary routine?',
  'zero-sports': 'Is the sentence talking about a sport in general?',
  'zero-languages': 'Is this the name of a language used in a general way?',
  'definite-superlative': 'Look for a superlative such as best, tallest, or most interesting.',
  'definite-ordinal': 'Look for a numbered position such as first, second, or third.',
  'definite-geography-water': 'Is this the name of a river, sea, ocean, or channel?',
  'zero-general-plural': 'Does the plural noun mean the whole category rather than a known group?',
  'zero-general-uncountable': 'Is the uncountable noun used generally rather than as a specific amount?',
  'definite-instruments': 'Notice whether the noun names a musical instrument after play or practise.',
  'zero-institutions-purpose': 'Does the place mean its normal purpose rather than a particular building?',
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
  /**
   * Gate scale is PERSPECTIVE-TRUE: it rides the road's own width ratio
   * (half(t)/nearHalf — the same curve every dash, stone and tuft follows),
   * so a distant gate can never be wider than the distant road and a near
   * gate grows exactly as fast as its lane spreads. floorFar/floorNear add
   * a gentle readability floor BELOW that curve so labels stay legible at
   * distance; WORLD_LAYOUTS may override them per device class
   * (farGateScale / nearGateScale). The floor never binds near the camera,
   * where the true perspective size is larger.
   */
  floorFar: 0.15,
  floorNear: 0.62,
  farOpacity: 0.72,
  /** Visual size in px below which labels get a counter-scale boost. */
  minLabelPx: 11,
  maxLabelBoost: 2.3,
};

/* ------------------------------------------------------------------------
 * World-motion system — the coded perspective road (visual only)
 * ------------------------------------------------------------------------
 * One projection drives every world object. A normalized DEPTH value maps
 * onto the code-built road between the two scenery pieces:
 *
 *   depth 0    → the road's vanishing point (--scene-horizon-y)
 *   depth 1    → the gate collision plane (CSS --scene-collision-y)
 *   depth > 1  → between the collision plane and the camera
 *
 * t = depth^pEase is the perspective easing: y, scale and the road's local
 * half-width are all affine in t, so every ground line (lane centers, lane
 * dividers, road edges) is straight through one shared vanishing point and
 * lane geometry is scale-invariant along the road (a lane keeps the same
 * share of the road's width at every depth).
 *
 * Road props (dashes, stones, tufts, dust) advance LINEARLY in depth —
 * depth += worldSpeed·Δt — and wrap with `if (depth ≥ cycle) depth -= cycle`,
 * which keeps their spacing perfectly even forever while the t-easing makes
 * them creep near the horizon and rush past the camera. Gates ride the SAME
 * projection: their depth IS the engine's gateProgress during PLAYING, so a
 * gate reaches the collision plane exactly when the engine resolves, then
 * passes the fox (depth > 1, growing and fading) instead of hitting it.
 *
 * All road objects are pooled DOM nodes animated with transforms only and
 * recycled near the horizon; nothing is created or destroyed during play.
 * ---------------------------------------------------------------------- */

/**
 * World layouts — per device class, keyed by the CSS --scene-layout custom
 * property (same 680px/1200px breakpoints the lane anchors use). Horizon,
 * collision line and lane anchors live in CSS (readSceneGeo()); this table
 * adds what CSS can't express:
 *
 *   farHalf / nearHalf  road half-width as a runner-width fraction at the
 *                       vanishing point and at the bottom (collision plane
 *                       and beyond extrapolate the same line)
 *   pEase               perspective easing exponent (t = depth^pEase)
 *   roadShoulder        soft grass rim beyond the sand (grows toward camera)
 *   sceneryW/Mode       side-scenery sizing: 'fit' preserves the artwork's
 *                       aspect anchored to the bottom edge; 'cover' fills a
 *                       full-height box with the road-side strip of the art
 *   dashW0/dashAspect   lane-marker size at the collision plane
 *   stones/tufts        pooled prop counts (dashes are fixed at 8 per line)
 */
const WORLD_LAYOUTS = {
  desktop: {
    farHalf: 0.078,
    nearHalf: 0.51,
    pEase: 1.48,
    roadShoulder: 0.012,
    gateStartDepth: 0.4,
    farGateScale: 0.58,
    nearGateScale: 0.88,
    dashesPerLine: 8,
    dashW0: 0.014,
    dashAspect: 2.8,
    stones: 10,
    patches: 2,
    tufts: 4,
    // road surface finishing (see ROAD_TEXTURE): edge-wear band width as a
    // share of the road's local half-width, 0 disables the band
    wearW: 0.08,
    grain: 0.22,
  },
  tablet: {
    farHalf: 0.072,
    nearHalf: 0.5,
    pEase: 1.5,
    roadShoulder: 0.014,
    gateStartDepth: 0.48,
    farGateScale: 0.58,
    nearGateScale: 0.86,
    dashesPerLine: 8,
    dashW0: 0.018,
    dashAspect: 2.8,
    stones: 9,
    patches: 2,
    tufts: 3,
    wearW: 0.08,
    grain: 0.2,
  },
  mobile: {
    // Phone portrait is its own composition, not a shrunken desktop: the
    // road dominates (88% of the width at the bottom), the horizon stays
    // wide enough for three readable gates, and the side artworks become
    // small cropped landmark strips that frame the road instead of
    // flanking it as two full-height posters.
    farHalf: 0.072,
    nearHalf: 0.53,
    pEase: 1.4,
    roadShoulder: 0.012,
    gateStartDepth: 0.68,
    // Reference: big readable boards for most of the approach, planted on
    // the lane at arrival — never tiny at spawn, never gigantic up close.
    farGateScale: 0.46,
    nearGateScale: 0.76,
    dashesPerLine: 7,
    dashW0: 0.028,
    dashAspect: 2.8,
    stones: 8,
    patches: 1,
    tufts: 2,
    wearW: 0.06,
    grain: 0.16,
  },
};

/**
 * Road surface finishing — one central place for the "richness" knobs.
 * The wear bands (soft darkening along both road edges, drawn by
 * drawCodedRoad as clipped polygons) and the sand grain (an inline SVG
 * turbulence layer on .road-surface) are subtle on purpose: they add
 * depth cues, never clutter. Set grain to 0 for a perfectly flat road.
 */
const ROAD_TEXTURE = {
  /** wear band peak alpha at the road edge, fading to 0 inward. */
  wearAlpha: 0.22,
  /** grain tile size in px (bigger = softer speckle). */
  grainSize: 170,
};

/** Motion tuning for the world layer (visual only — never gameplay). */
const WORLD_MOTION = {
  /** worldSpeed (depth units/s) = speedPerGate / gateDurationS, clamped. */
  speedPerGate: 6.4,
  speedMin: 0.44,
  speedMax: 0.62,
  /** feedback: brief full-speed burst, then the world settles to a crawl. */
  burstS: 0.22,
  crawlCorrect: 0.22,
  crawlWrong: 0.15,
  /** gates sweep past the camera this much faster than the road flows. */
  gatePassBoost: 3.2,
  /** road props recycle once their ground line passes this y fraction. */
  yExit: 1.05,
  dustEveryMs: 95,
  reducedFactor: 0.7,
};

const world = {
  built: false,
  W: 0,
  H: 0,
  speed: 0.5, // linear depth advance per second (worldSpeed)
  crawl: 1, // settled feedback slow-motion factor
  feedbackT: 0, // seconds since the gate crossed the collision plane
  yVp: 0.44,
  yCol: 0.86,
  laneSpanY: 0.42, // yCol − yVp, cached
  laneHalf: 0.31, // |lane anchor − 0.5| in runner-width fractions
  farHalf: 0.036,
  nearHalf: 0.45,
  laneFrac: 0.69, // laneHalf / nearHalf — lane position as share of road width
  pEase: 1.75,
  divAngle: [-7, 7], // straight divider-rail tilt per side (deg)
  cycle: 1.24, // depth wrap length (ground line exits past the bottom)
  dashes: [],
  stones: [],
  patches: [],
  tufts: [],
  dusts: [],
  dustIdx: 0,
  dustTimer: 0,
  gate: { depth: 0, spawnFade: 1 },
};

/** Perspective easing: depth → t (0 horizon, 1 collision plane, >1 past us). */
function easeDepth(depth) {
  return Math.pow(Math.max(depth, 0.0001), world.pEase);
}

/**
 * THE single perspective helper: normalized depth + continuous lane →
 * screen point. Lane −1/0/+1 are the three answer lanes (they land exactly
 * on the CSS --lane-x-* anchors at depth 1, where the engine resolves
 * collisions); ±0.5 are the lane dividers; ±1/laneFrac is the road's edge.
 * `scale` is the true perspective size ratio (road-width-proportional) for
 * objects lying ON the road; standing billboards like gates use their own
 * readability floor in RUNNER_GEO with the same t.
 */
function projectRoadPoint(depth, lane = 0) {
  const t = easeDepth(depth);
  const half = world.farHalf + (world.nearHalf - world.farHalf) * t;
  return {
    x: 0.5 + lane * world.laneFrac * half,
    y: world.yVp + t * world.laneSpanY,
    scale: half / world.nearHalf,
    t,
  };
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
  btnPlayLabel: document.getElementById('btn-play-label'),
  btnModeLearn: document.getElementById('btn-mode-learn'),
  btnModeArcade: document.getElementById('btn-mode-arcade'),
  btnLevels: document.getElementById('btn-levels'),
  heroProgress: document.getElementById('hero-progress'),
  levelModal: document.getElementById('level-modal'),
  btnLevelsClose: document.getElementById('btn-levels-close'),
  levelModalProgress: document.getElementById('level-modal-progress'),
  levelList: document.getElementById('level-list'),
  startNote: document.getElementById('start-note'),
  btnResetProgress: document.getElementById('btn-reset-progress'),
  devTools: document.getElementById('dev-tools'),
  // game screen
  screenGame: document.getElementById('screen-game'),
  hudLevel: document.getElementById('hud-level'),
  hudLevelProgressFill: document.getElementById('hud-level-progress-fill'),
  hudQuestion: document.getElementById('hud-question'),
  hudProgress: document.getElementById('hud-progress'),
  hudProgressSegments: document.getElementById('hud-progress-segments'),
  hudScore: document.getElementById('hud-score'),
  hudScorePill: document.getElementById('hud-score-pill'),
  hudStreak: document.getElementById('hud-streak'),
  hudStreakPill: document.getElementById('hud-streak-pill'),
  hudLives: document.getElementById('hud-lives'),
  btnPause: document.getElementById('btn-pause'),
  sentence: document.getElementById('sentence'),
  runner: document.getElementById('runner'),
  scene: document.querySelector('.scene'),
  gatesRoot: document.getElementById('gates'),
  player: document.getElementById('player'),
  playerImg: document.getElementById('player-img'),
  scorePop: document.getElementById('score-pop'),
  tipText: document.getElementById('tip-text'),
  hintText: document.getElementById('hint-text'),
  mobileHintText: document.getElementById('mobile-hint-text'),
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
const roadGuideEls = [...document.querySelectorAll('.road-guide')];

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
  // (the two scenery PNGs are plain <img> tags in #runner — the browser
  // fetches and decodes them at page load, before the game screen shows)
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
  // The start screen manages its own height (css/start.css relaxes .app's
  // 480px gameplay guard while showing, so short landscape phones fit).
  dom.app.classList.toggle('showing-start', name === 'start');
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

/** What the HUD last painted — used ONLY to trigger change animations.
 *  Never read as gameplay state; the engine snapshot stays the single
 *  source of truth for every value shown here. */
const hudPainted = { score: null, streak: null };

/** Restart a one-shot animation class on an element. */
function retriggerAnimation(el, className) {
  el.classList.remove(className);
  void el.offsetWidth; // flush so the class removal takes effect
  el.classList.add(className);
}

const HEART_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
  '<path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>';

/** Paint the hearts row: filled for remaining lives, dimmed for lost ones.
 *  Hearts are rebuilt only when the maximum changes (mode/level switch), so
 *  a lost heart can animate in place on the next render. */
function renderHUDHearts(lives, max) {
  const wrap = dom.hudLives;
  if (wrap.children.length !== max) {
    wrap.replaceChildren(
      ...Array.from({ length: max }, () => {
        const heart = document.createElement('span');
        heart.className = 'hud-heart';
        heart.innerHTML = HEART_SVG;
        return heart;
      }),
    );
  }
  [...wrap.children].forEach((heart, index) => {
    const isFull = index < lives;
    const wasFull = heart.classList.contains('is-full');
    heart.classList.toggle('is-full', isFull);
    heart.classList.toggle('is-lost', !isFull);
    if (wasFull && !isFull) {
      retriggerAnimation(heart, 'just-lost'); // this heart just broke
    }
  });
}

function renderHUDSegments(current, total) {
  const wrap = dom.hudProgressSegments;
  if (!wrap) return;
  if (wrap.children.length !== total) {
    wrap.replaceChildren(
      ...Array.from({ length: total }, () => {
        const segment = document.createElement('span');
        segment.className = 'hud-progress__segment';
        return segment;
      }),
    );
  }
  [...wrap.children].forEach((segment, index) => {
    segment.classList.toggle('is-complete', index < current);
    segment.classList.toggle('is-current', index === Math.max(0, current - 1));
  });
}

function renderHUD() {
  const snap = engine.getSnapshot();
  if (!snap.session) return;

  dom.hudLevel.textContent = `Level ${snap.level.id}`;
  dom.hudLevel.parentElement?.parentElement?.setAttribute(
    'title',
    `${snap.level.title} · ${snap.level.cefr}`,
  );

  const answeredIndex =
    snap.state === GAME_STATES.FEEDBACK && snap.lastResult
      ? snap.lastResult.questionIndex
      : snap.session.questionIndex + 1;
  dom.hudQuestion.textContent = `${answeredIndex} / ${snap.session.totalQuestions}`;
  dom.hudProgress.setAttribute('aria-label', `Question ${answeredIndex} of ${snap.session.totalQuestions}`);
  const levelProgress = Math.round((answeredIndex / snap.session.totalQuestions) * 100);
  if (dom.hudLevelProgressFill) dom.hudLevelProgressFill.style.width = `${levelProgress}%`;
  renderHUDSegments(answeredIndex, snap.session.totalQuestions);

  dom.hudScore.textContent = `${snap.score}`;
  dom.hudScorePill.setAttribute('aria-label', `Score ${snap.score} points`);
  if (hudPainted.score !== null && hudPainted.score !== snap.score) {
    retriggerAnimation(dom.hudScorePill, 'is-pulse');
  }
  hudPainted.score = snap.score;

  dom.hudStreak.textContent = `${snap.streak}`;
  dom.hudStreakPill.setAttribute('aria-label', `Streak ${snap.streak}`);
  dom.hudStreakPill.classList.toggle('is-hot', snap.streak > 0);
  if (hudPainted.streak !== null && hudPainted.streak !== snap.streak) {
    retriggerAnimation(dom.hudStreakPill, 'is-pulse');
  }
  hudPainted.streak = snap.streak;

  // Learn Mode uses no lives — only Arcade shows them.
  if (snap.mode === GAME_MODES.ARCADE && snap.lives !== null) {
    renderHUDHearts(snap.lives, gameData.settings.startingLivesArcade);
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

  // New gate group: spawn AT the vanishing point (tiny, converged, fading
  // in) and spread out into the lanes as the question's gate clock runs.
  // The road itself (dashes/stones/tufts) never resets — it just keeps
  // flowing, so the next question reads as a new stretch of the same
  // endless road.
  const activeLayout = WORLD_LAYOUTS[sceneGeo.layout] ?? WORLD_LAYOUTS.desktop;
  world.gate.depth = activeLayout.gateStartDepth ?? 0.4;
  world.gate.spawnFade = 0;
  world.feedbackT = 0;
  world.crawl = 1;
  const durS = (payload.gateDurationMs ?? 12000) / 1000;
  const reduced = prefersReducedMotion ? WORLD_MOTION.reducedFactor : 1;
  world.speed =
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

  const rule = gameData.ruleCatalog.find((item) => item.id === payload.question.rule);
  const tip = rule?.summary ?? 'Read the whole sentence before choosing an article.';
  const hint = RULE_HINTS[payload.question.rule] ?? 'Look at what the noun means in this sentence.';
  if (dom.tipText) dom.tipText.textContent = tip;
  if (dom.hintText) dom.hintText.textContent = hint;
  if (dom.mobileHintText) dom.mobileHintText.textContent = hint;
  if (dom.scorePop) {
    dom.scorePop.textContent = '';
    dom.scorePop.classList.remove('is-visible');
  }

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
    const guide = roadGuideEls[lane];
    if (guide) guide.dataset.category = category;
    gate.classList.remove('is-chosen', 'is-correct', 'is-wrong');
  });
  renderLaneGuides();
}

function renderPlayer(lane) {
  dom.player.style.left = PLAYER_LANE_POSITIONS[lane];
  roadGuideEls.forEach((guide, index) => guide.classList.toggle('is-active', index === lane));
  setSceneParallax(lane);
}

function renderLaneGuides() {
  if (world.W < 40 || roadGuideEls.length === 0) return;
  const depth = sceneGeo.layout === 'mobile' ? 0.76 : sceneGeo.layout === 'tablet' ? 0.64 : 0.58;
  roadGuideEls.forEach((guide, lane) => {
    const laneU = lane === 1 ? 0 : lane === 0 ? -1 : 1;
    const p = projectRoadPoint(depth, laneU);
    const scale = Math.max(0.46, Math.min(0.82, p.scale * 1.45));
    guide.style.transform =
      `translate3d(${(p.x * world.W).toFixed(1)}px, ${(p.y * world.H).toFixed(1)}px, 0) ` +
      `translate(-50%, -50%) scale(${scale.toFixed(3)})`;
  });
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
 * coded lane-divider rails (straight lines through the vanishing point),
 * stones the lane rails (avoiding the dividers), tufts the road's grass
 * shoulder, dust the fox's own lane. Everything advances linearly in depth
 * with the same worldSpeed and wraps at the cycle length, so spacing stays
 * even forever and the road reads as one endless surface under a camera
 * that never stops moving forward.
 * ---------------------------------------------------------------------- */

const roadLayer = () => document.getElementById('road-layer');

function randRange(min, max) {
  return min + Math.random() * (max - min);
}

/** A random lane-unit position for stones that avoids both divider rails
 * (the dividers sit at ±0.5 lane units at EVERY depth in this projection). */
function stoneLaneU() {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const u = randRange(-1.3, 1.3);
    const nearDivider = Math.abs(u - 0.5) < 0.3 || Math.abs(u + 0.5) < 0.3;
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

  // Pools are built at the MAXIMUM count any layout uses; each layout
  // activates only its own counts in rebuildWorldGeometry (dashesPerLine /
  // stones / tufts in WORLD_LAYOUTS — the central detail knobs).
  const layouts = Object.values(WORLD_LAYOUTS);
  const maxPerLine = Math.max(...layouts.map((l) => l.dashesPerLine || 10));
  const maxStones = Math.max(...layouts.map((l) => l.stones || 10));
  const maxTufts = Math.max(...layouts.map((l) => l.tufts || 6));

  // Lane dashes per divider line, spread evenly across the depth cycle —
  // the wrap in updateWorldMotion preserves this spacing forever; the
  // second line is phase-shifted half a slot.
  for (let line = 0; line < 2; line += 1) {
    for (let i = 0; i < maxPerLine; i += 1) {
      const el = make('road-dash');
      world.dashes.push({
        el,
        line,
        depth: ((i + (line ? 0.5 : 0)) / (maxPerLine * 2)) * 1.22,
      });
    }
  }

  // Stones: modest count, four size variants (last = tiny pebble), random rotation.
  const stoneCls = [
    'road-stone stone-a',
    'road-stone stone-b',
    'road-stone stone-c',
    'road-stone stone-d',
  ];
  for (let i = 0; i < maxStones; i += 1) {
    const el = make(stoneCls[i % 4]);
    world.stones.push({
      el,
      depth: randRange(0.1, 1.2),
      u: stoneLaneU(),
      rot: randRange(-40, 40),
    });
  }

  // Worn patches: faint repair/bleach blotches riding the world flow like
  // the stones — the surface reads lived-on without cluttering the lanes.
  const maxPatches = Math.max(...layouts.map((l) => l.patches || 0));
  for (let i = 0; i < maxPatches; i += 1) {
    const el = make(i % 2 === 0 ? 'road-patch patch-a' : 'road-patch patch-b');
    world.patches.push({
      el,
      depth: randRange(0.05, 1.15),
      u: stoneLaneU(),
      rot: randRange(0, 360),
      squash: randRange(0.75, 1.45),
    });
  }

  // Shoulder tufts (grass + occasional flower) hugging the coded road edge.
  for (let i = 0; i < maxTufts; i += 1) {
    const flowerCls = i % 6 === 0 ? 'road-tuft tuft-flower flower-b' : i % 3 === 0 ? 'road-tuft tuft-flower' : 'road-tuft';
    const el = make(flowerCls);
    world.tufts.push({
      el,
      side: i % 2 === 0 ? 1 : -1,
      edge: randRange(0.94, 1.12), // share of the road's local half-width
      depth: randRange(0.1, 0.6),
    });
  }

  // Dust puffs behind the fox (spawned at runtime, pooled).
  for (let i = 0; i < 6; i += 1) {
    const el = make('dust-puff');
    el.style.opacity = '0';
    world.dusts.push({ el, depth: 0, m: 0, born: 0, size: randRange(0.6, 1.3) });
  }
}

/**
 * Recompute every screen-space value the world needs: runner size, the
 * active layout's projection constants, the coded road polygons (sand
 * surface + grass shoulder), divider rail tilt, scenery placement and the
 * pooled elements' base sizes. Cheap, idempotent; called on init, when the
 * game screen shows and on resize.
 */
function rebuildWorldGeometry() {
  // Re-read the CSS scene variables first: a resize may have crossed a
  // breakpoint while the game screen was hidden (no live runner rect).
  readSceneGeo();
  const layout = WORLD_LAYOUTS[sceneGeo.layout] ?? WORLD_LAYOUTS.desktop;
  const rect = dom.runner.getBoundingClientRect();
  if (rect.width < 40 || rect.height < 40) return; // hidden screen — try again when shown

  world.W = rect.width;
  world.H = rect.height;
  world.yVp = sceneGeo.horizonY;
  world.yCol = sceneGeo.collisionY;
  world.laneSpanY = world.yCol - world.yVp;
  world.laneHalf = (Math.abs(laneXFractions[0] - 0.5) + Math.abs(laneXFractions[2] - 0.5)) / 2;
  world.farHalf = layout.farHalf;
  // The road is always wider than the lanes it carries (edge lane ≈ 1.39).
  world.nearHalf = Math.max(layout.nearHalf, world.laneHalf * 1.32);
  world.laneFrac = world.laneHalf / world.nearHalf;
  world.pEase = layout.pEase;

  // Depth wrap: the ground line exits past the bottom edge (t units).
  const tExit = (WORLD_MOTION.yExit - world.yVp) / world.laneSpanY;
  world.cycle = Math.pow(tExit, 1 / world.pEase);

  // Divider rails are straight lines through the vanishing point (x ∝ t,
  // y ∝ t), so each dash keeps one constant tilt per side.
  const mDiv = (0.5 * world.laneFrac * (world.nearHalf - world.farHalf)) / world.laneSpanY;
  const angle = (Math.atan2(mDiv * world.W, world.H) * 180) / Math.PI;
  world.divAngle = [-angle, angle];

  drawCodedRoad(layout);

  // Activate exactly this layout's detail counts (WORLD_LAYOUTS): dashes
  // keep perfectly even spacing per line; surplus pool nodes hide.
  const perLine = layout.dashesPerLine || 10;
  const lineCount = [0, 0];
  for (const d of world.dashes) {
    const idx = lineCount[d.line]++;
    const active = idx < perLine;
    d.el.style.display = active ? '' : 'none';
    if (active) d.depth = ((idx + (d.line ? 0.5 : 0)) / (perLine * 2)) * 1.22;
  }
  world.stones.forEach((s, i) => {
    s.el.style.display = i < (layout.stones || 10) ? '' : 'none';
  });
  world.patches.forEach((pa, i) => {
    pa.el.style.display = i < (layout.patches || 0) ? '' : 'none';
  });
  world.tufts.forEach((t, i) => {
    t.el.style.display = i < (layout.tufts || 6) ? '' : 'none';
  });
  // Sand grain intensity per layout (0 removes the layer).
  dom.runner.style.setProperty('--road-grain-o', String(layout.grain ?? 0.5));

  // Base sizes at the collision plane (scale 1); per-frame scale comes from
  // the projection's road-width ratio.
  const dashW = layout.dashW0 * world.W;
  for (const d of world.dashes) {
    d.el.style.width = `${dashW.toFixed(1)}px`;
    d.el.style.height = `${(dashW * layout.dashAspect).toFixed(1)}px`;
  }
  const stoneBase = world.W * 0.013;
  world.stones.forEach((s, i) => {
    const variant = i % 4; // 0-2 pebbles, 3 = tiny speck
    const v = variant === 3 ? 0.42 : 0.75 + variant * 0.42;
    s.el.style.width = `${(stoneBase * v).toFixed(1)}px`;
    s.el.style.height = `${(stoneBase * v * 0.72).toFixed(1)}px`;
  });
  const patchBase = world.W * 0.1;
  world.patches.forEach((pa) => {
    pa.el.style.width = `${patchBase.toFixed(1)}px`;
    pa.el.style.height = `${(patchBase * 0.62).toFixed(1)}px`;
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
  renderLaneGuides();
}

/**
 * Draw the coded road polygons through the shared projection: the sand
 * surface, the (slightly wider, blurred) grass shoulder under it, and the
 * soft edge-wear bands hugging the sand's slanted sides. All run from the
 * vanishing point to past the bottom edge, so the meadow, scenery and road
 * join without seams.
 */
function drawCodedRoad(layout) {
  const roadSurface = document.getElementById('road-surface');
  const roadEdge = document.getElementById('road-edge');
  const roadShading = document.getElementById('road-shading');
  if (!roadSurface || !roadEdge) return;

  const tExit = Math.pow(world.cycle, world.pEase); // y = yExit at the bottom
  const polygon = (grow) => {
    const STEPS = 12;
    const left = [];
    const right = [];
    for (let s = 0; s <= STEPS; s += 1) {
      const t = (tExit * s) / STEPS;
      const half = world.farHalf + (world.nearHalf - world.farHalf) * t + grow(t);
      const y = ((world.yVp + t * world.laneSpanY) * 100).toFixed(2);
      left.push(`${((0.5 - half) * 100).toFixed(2)}% ${y}%`);
      right.push(`${((0.5 + half) * 100).toFixed(2)}% ${y}%`);
    }
    return `polygon(${left.join(', ')}, ${right.reverse().join(', ')})`;
  };

  roadSurface.style.clipPath = polygon(() => 0);
  // the shoulder rim widens toward the camera, like the road itself
  roadEdge.style.clipPath = polygon(
    (t) => layout.roadShoulder * (0.35 + t * 0.75)
  );

  // Edge-wear bands: a slanted ring between the sand edge and a
  // proportionally inset line on each side (perspective-true — the band is
  // a constant SHARE of the road width). Clipped after a small blur so the
  // inner boundary is soft; the CSS fill alpha is set below.
  if (roadShading) {
    const wear = layout.wearW || 0;
    const band = (side) => {
      const STEPS = 8;
      const outer = [];
      const inner = [];
      for (let s = 0; s <= STEPS; s += 1) {
        const t = (tExit * s) / STEPS;
        const half = world.farHalf + (world.nearHalf - world.farHalf) * t;
        const y = ((world.yVp + t * world.laneSpanY) * 100).toFixed(2);
        outer.push(`${((0.5 + side * half) * 100).toFixed(2)}% ${y}%`);
        inner.push(`${((0.5 + side * half * (1 - wear)) * 100).toFixed(2)}% ${y}%`);
      }
      return `polygon(${outer.join(', ')}, ${inner.reverse().join(', ')})`;
    };
    roadShading.style.setProperty('--wear-clip-l', wear > 0 ? band(-1) : 'none');
    roadShading.style.setProperty('--wear-clip-r', wear > 0 ? band(1) : 'none');
    roadShading.style.setProperty('--wear-alpha', String(ROAD_TEXTURE.wearAlpha));
  }

  // Wheel-wear tracks: one soft band down each lane centre, following the
  // exact lane projection (x = 0.5 + laneU × laneFrac × half) so a track
  // always lands under the lane the fox and gates use.
  const roadTracks = document.getElementById('road-tracks');
  if (roadTracks) {
    const TRACK_HALF = 0.17; // lane units
    [-1, 0, 1].forEach((laneU, idx) => {
      const left = [];
      const right = [];
      for (let s = 0; s <= 8; s += 1) {
        const t = (tExit * s) / 8;
        const half = world.farHalf + (world.nearHalf - world.farHalf) * t;
        const y = ((world.yVp + t * world.laneSpanY) * 100).toFixed(2);
        const centre = (0.5 + laneU * world.laneFrac * half) * 100;
        const trackHalf = TRACK_HALF * world.laneFrac * half * 100;
        left.push(`${(centre - trackHalf).toFixed(2)}% ${y}%`);
        right.push(`${(centre + trackHalf).toFixed(2)}% ${y}%`);
      }
      roadTracks.style.setProperty(
        `--track-clip-${idx}`,
        `polygon(${left.join(', ')}, ${right.reverse().join(', ')})`
      );
    });
  }
}

/** Reposition every pooled object from its stored depth (after geometry
 * changes); keeps the world intact across resizes and breakpoints. */
function renderWorldStatic() {
  if (!world.built || world.W < 40) return;
  for (const d of world.dashes) renderDash(d);
  for (const s of world.stones) renderStone(s);
  for (const pa of world.patches) renderPatch(pa);
  for (const t of world.tufts) renderTuft(t);
  for (const p of world.dusts) renderDust(p);
}

function setLayerZ(el, depth) {
  const z = 1 + Math.round(Math.min(Math.max(depth, 0), 1.45) * 2);
  el.style.zIndex = String(z);
}

function renderDash(d) {
  const rail = d.line === 0 ? -0.5 : 0.5; // lane units of the divider rail
  const p = projectRoadPoint(d.depth, rail);
  d.el.style.transform =
    `translate3d(${(p.x * world.W).toFixed(1)}px, ${(p.y * world.H).toFixed(1)}px, 0) ` +
    `translate(-50%, -50%) rotate(${world.divAngle[d.line].toFixed(1)}deg) scale(${p.scale.toFixed(3)})`;
  d.el.style.opacity = Math.min(1, 0.38 + p.t * 2.4).toFixed(2);
  setLayerZ(d.el, d.depth);
}

function renderStone(s) {
  const p = projectRoadPoint(s.depth, s.u);
  s.el.style.transform =
    `translate3d(${(p.x * world.W).toFixed(1)}px, ${(p.y * world.H).toFixed(1)}px, 0) ` +
    `translate(-50%, -50%) rotate(${s.rot.toFixed(0)}deg) scale(${p.scale.toFixed(3)})`;
  s.el.style.opacity = Math.min(0.85, 0.2 + p.t * 2.2).toFixed(2);
  setLayerZ(s.el, s.depth);
}

/** Worn patch: same flow as a stone, but a wide faint blob with its own
 * squash factor so no two patches read alike. */
function renderPatch(pa) {
  const p = projectRoadPoint(pa.depth, pa.u);
  pa.el.style.transform =
    `translate3d(${(p.x * world.W).toFixed(1)}px, ${(p.y * world.H).toFixed(1)}px, 0) ` +
    `translate(-50%, -50%) rotate(${pa.rot.toFixed(0)}deg) ` +
    `scale(${(p.scale * pa.squash).toFixed(3)}, ${p.scale.toFixed(3)})`;
  pa.el.style.opacity = Math.min(0.55, 0.1 + p.t * 1.5).toFixed(2);
  setLayerZ(pa.el, pa.depth);
}

function renderTuft(t) {
  // right on the road's local edge line: u = ±edge / laneFrac of half-width
  const p = projectRoadPoint(t.depth, (t.side * t.edge) / world.laneFrac);
  t.el.style.transform =
    `translate3d(${(p.x * world.W).toFixed(1)}px, ${(p.y * world.H).toFixed(1)}px, 0) ` +
    `translate(-50%, -60%) scale(${p.scale.toFixed(3)})`;
  t.el.style.opacity = Math.min(0.9, 0.3 + p.t * 2.6).toFixed(2);
  setLayerZ(t.el, t.depth);
}

function renderDust(puff) {
  if (puff.born <= 0) {
    puff.el.style.opacity = '0';
    return; // pooled but idle
  }
  const p = projectRoadPoint(puff.depth, puff.m);
  const life = Math.min(1, Math.max(0, (puff.depth - puff.born) / 0.26));
  puff.el.style.transform =
    `translate3d(${(p.x * world.W).toFixed(1)}px, ${(p.y * world.H).toFixed(1)}px, 0) ` +
    `translate(-50%, -50%) scale(${(0.55 + p.t * 0.5).toFixed(3)})`;
  puff.el.style.opacity = (0.3 * (1 - life)).toFixed(3);
  setLayerZ(puff.el, Math.min(puff.depth, 1.3));
}

/**
 * Advance + render the whole world layer for one frame.
 * rate = slow-motion multiplier of worldSpeed (0 pauses everything: dashes,
 * stones, tufts, dust). Every prop advances LINEARLY in depth and wraps by
 * the cycle length, which keeps the markers' spacing perfectly even — the
 * perspective feel comes from the t-easing in the projection, not from the
 * flow. Dust is spawned at the fox's feet and rides the same flow.
 */
function updateWorldMotion(dt, rate, playerAnimFactor) {
  if (!world.built || world.W < 40) return;
  const adv = world.speed * rate * dt;

  if (adv > 0) {
    for (const d of world.dashes) {
      d.depth += adv;
      if (d.depth >= world.cycle) d.depth -= world.cycle;
      renderDash(d);
    }
    for (const s of world.stones) {
      s.depth += adv;
      if (s.depth >= world.cycle) {
        s.depth -= world.cycle;
        s.u = stoneLaneU(); // fresh lane on each pass for variety
      }
      renderStone(s);
    }
    for (const pa of world.patches) {
      pa.depth += adv;
      if (pa.depth >= world.cycle) {
        pa.depth -= world.cycle;
        pa.u = stoneLaneU();
        pa.rot = randRange(0, 360);
        pa.squash = randRange(0.75, 1.45);
      }
      renderPatch(pa);
    }
    for (const t of world.tufts) {
      t.depth += adv;
      if (t.depth >= world.cycle * 0.62) {
        // tufts live on the visible far/mid shoulder only
        t.depth -= world.cycle * 0.62;
        t.edge = randRange(0.94, 1.12);
      }
      renderTuft(t);
    }
    for (const puff of world.dusts) {
      if (puff.born > 0) {
        puff.depth += adv;
        if (puff.depth > puff.born + 0.3) puff.born = 0;
        renderDust(puff);
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
        puff.born = 1 + randRange(-0.03, 0.06); // right at the fox's ground line
        puff.depth = puff.born;
        puff.m = (foxX - 0.5) / world.laneHalf + randRange(-0.06, 0.06);
        renderDust(puff);
      }
    }
  }
}

/**
 * Gate visual state per engine state:
 *  - PLAYING: depth IS gateProgress — the gate reaches the collision plane
 *    at the exact frame the engine resolves the question.
 *  - FEEDBACK: the gate sweeps past the camera at gatePassBoost × world
 *    speed (~100–200ms from collision to fully behind us), scaling up and
 *    fading as it exits, while the road itself slows to the crawl factor.
 */
function updateGateVisual(dt, state) {
  const g = world.gate;
  if (state === GAME_STATES.PLAYING) {
    const layout = WORLD_LAYOUTS[sceneGeo.layout] ?? WORLD_LAYOUTS.desktop;
    const start = layout.gateStartDepth ?? 0.4;
    g.depth = start + (1 - start) * gateVisualProgress;
    g.spawnFade = Math.min(1, g.spawnFade + dt * 3);
  } else if (state === GAME_STATES.FEEDBACK) {
    world.feedbackT += dt;
    g.spawnFade = 1;
    g.depth = Math.min(
      world.cycle,
      g.depth + world.speed * WORLD_MOTION.gatePassBoost * dt
    );
  }
}

function renderGates() {
  const laneMap = engine.laneMap;
  if (!laneMap || laneMap.length === 0) return;
  // Container-query sizes only resolve on screen — measure lazily on the
  // first visible frame rather than while #screen-game is display:none.
  if (gateLabelBaseStale) refreshGateLabelBase();
  const { farOpacity, minLabelPx, maxLabelBoost } = RUNNER_GEO;
  // Layouts may lift the readability floor (phone boards must read from
  // spawn); the true perspective curve still owns the near-camera size.
  const activeLayout = WORLD_LAYOUTS[sceneGeo.layout] ?? WORLD_LAYOUTS.desktop;
  const floorFar = activeLayout.farGateScale ?? RUNNER_GEO.floorFar;
  const floorNear = activeLayout.nearGateScale ?? RUNNER_GEO.floorNear;
  const D = world.gate.depth;
  const t = easeDepth(D);
  // Perspective-true gate size: the road's own width ratio at this depth,
  // with the readability floor underneath (the floor only binds far away).
  const roadScale = (world.farHalf + (world.nearHalf - world.farHalf) * t) / world.nearHalf;
  const floor = floorFar + (floorNear - floorFar) * Math.min(t, 1);
  const scale = Math.max(roadScale, floor);
  // Fade in from the horizon on spawn; once past the collision plane the
  // gate fades quickly (t 1.02→1.14) so the pass-through never reads as a
  // giant wall flashing across — or past — the screen edges.
  const passFade = 1 - Math.min(1, Math.max(0, (t - 1.02) / 0.12));
  const opacity =
    (farOpacity + (1 - farOpacity) * Math.min(1, t / 0.45)) * world.gate.spawnFade * passFade;

  for (let lane = 0; lane < 3; lane += 1) {
    // Same projection as every road object: squeezed to the vanishing point
    // at spawn, landing exactly on the CSS lane anchors (--lane-x-*) at the
    // collision moment, then spreading past the camera during pass-through.
    const laneU = lane === 1 ? 0 : lane === 0 ? -1 : 1;
    const p = projectRoadPoint(D, laneU);
    const el = gateEls[lane];
    // (x, y) is the gate's ground point: bottom-centered, standing on the road.
    el.style.transform =
      `translate3d(${(p.x * world.W).toFixed(1)}px, ${(p.y * world.H).toFixed(1)}px, 0) ` +
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
  dom.screenGame.classList.remove('is-feedback');
  if (dom.scorePop) dom.scorePop.classList.remove('is-visible');
}

function renderFeedback(result) {
  if (engine.state !== GAME_STATES.FEEDBACK) return; // e.g. game-over screens take over

  // World slow-motion through the feedback moment: a short full-speed burst
  // (the fox punches through the gate), then the world settles to a crawl —
  // correct answers keep trotting, wrong answers hesitate harder.
  world.feedbackT = 0;
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
  dom.screenGame.classList.add('is-feedback');
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
    if (dom.scorePop) {
      dom.scorePop.textContent = `+${result.pointsGained}`;
      retriggerAnimation(dom.scorePop, 'is-visible');
    }
  } else {
    if (dom.scorePop) dom.scorePop.classList.remove('is-visible');
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
 * 12. Level selector (start screen hero + selection overlay)
 * ====================================================================== */

/** Lock icon shown on cards the engine has not unlocked yet. */
const LEVEL_LOCK_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';

function renderLevelList() {
  if (!engine) return;
  const progress = engine.getProgress();
  const defaultLevelId = pickDefaultLevel();
  dom.levelList.replaceChildren(
    ...gameData.levels.map((level) => {
      const unlocked = progress.unlockedLevels.includes(level.id);
      const record = progress.levels[String(level.id)];
      const stars = record ? record.bestStars : 0;
      const isCurrent = unlocked && level.id === defaultLevelId;

      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `level-card${isCurrent ? ' is-current' : ''}`;
      button.disabled = !unlocked; // the engine owns unlocks — locked stays locked
      button.setAttribute(
        'aria-label',
        unlocked
          ? `Play level ${level.id}: ${level.title}, ${stars} of 3 stars`
          : `Level ${level.id}: ${level.title} — locked, pass the previous level to unlock`
      );

      const num = document.createElement('span');
      num.className = 'level-card__num';
      if (unlocked) num.textContent = String(level.id);
      else num.innerHTML = LEVEL_LOCK_ICON;

      const title = document.createElement('span');
      title.className = 'level-card__title';
      title.textContent = level.title;

      const meta = document.createElement('span');
      meta.className = 'level-card__meta';
      meta.textContent = `CEFR ${level.cefr} · ${level.questionCount} questions`;

      const starsSpan = document.createElement('span');
      starsSpan.className = 'level-card__stars';
      starsSpan.textContent = starsText(stars); // star count also lives in the aria-label
      starsSpan.setAttribute('aria-hidden', 'true');

      button.append(num, title, meta, starsSpan);
      if (isCurrent) {
        const tag = document.createElement('span');
        tag.className = 'level-card__tag';
        tag.textContent = 'Next up';
        button.append(tag);
      }
      button.addEventListener('click', () => {
        closeLevelModal();
        startGame(level.id);
      });
      item.append(button);
      return item;
    })
  );

  // Progress summaries (hero chip + overlay header) and the Play label.
  const total = gameData.levels.length;
  const passedCount = progress.passedLevels.length;
  const starSum = gameData.levels.reduce(
    (sum, level) => sum + (progress.levels[String(level.id)]?.bestStars ?? 0),
    0
  );
  const allPassed = passedCount === total;
  dom.heroProgress.textContent = `${passedCount} / ${total} levels · ${starSum} ★`;
  dom.levelModalProgress.textContent =
    `${passedCount} of ${total} levels passed · ${starSum} of ${total * 3} stars earned`;
  dom.btnPlayLabel.textContent = allPassed
    ? `Play ${gameData.levels[total - 1].title}`
    : 'Play Now';
}

/** Open/close the level-selection overlay (focus returns to its trigger). */
function openLevelModal() {
  dom.levelModal.classList.remove('hidden');
  dom.btnLevelsClose.focus({ preventScroll: true });
}

function closeLevelModal() {
  if (dom.levelModal.classList.contains('hidden')) return;
  dom.levelModal.classList.add('hidden');
  dom.btnLevels.focus({ preventScroll: true });
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
  dom.btnLevels.addEventListener('click', openLevelModal);
  dom.btnLevelsClose.addEventListener('click', closeLevelModal);
  // tapping the scrim (not the card) dismisses the overlay
  dom.levelModal.addEventListener('pointerdown', (event) => {
    if (event.target === dom.levelModal) closeLevelModal();
  });
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
      readSceneGeo();
      rebuildWorldGeometry(); // road polygons + pooled sizes follow the new layout
      gateLabelBaseStale = true;
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
  // The start screen owns Escape while the level overlay is open.
  if (currentScreen === 'start' && event.key === 'Escape') {
    if (engine && !dom.levelModal.classList.contains('hidden')) closeLevelModal();
    return;
  }
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
 * Frames actually cycled in the current motion-preference mode.
 */
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
      // Delta is clamped so a background tab can never teleport the road.
      const dt = Math.min(deltaMs, 40) / 1000;

      // Gate pass-through first: it owns the feedback clock (feedbackT).
      updateGateVisual(dt, state);

      // World flow: full speed while running, a short full-speed burst
      // right after the gate is passed, then slow-motion crawl through the
      // rest of feedback, frozen while paused/elsewhere.
      const rate =
        state === GAME_STATES.PLAYING ? 1
        : state === GAME_STATES.FEEDBACK
          ? world.feedbackT < WORLD_MOTION.burstS ? 1 : world.crawl
          : 0;

      if (state === GAME_STATES.FEEDBACK) {
        // The fox keeps trotting through the feedback moment, matched to the
        // world rate so it never looks like it crashed into the gate.
        updatePlayerAnimation(Math.min(deltaMs, 40) * (0.35 + Math.max(rate, 0.15)));
      }

      updateWorldMotion(dt, rate, state === GAME_STATES.PLAYING ? 1 : Math.max(rate, 0.15) * 1.6);
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
