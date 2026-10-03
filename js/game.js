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
import {
  RUN_PHASES,
  STABLE_RUN_FRAME_INDEX,
  advanceRunClock,
  feedbackRunRateForWorldRate,
  runFrameDurationForSpeed,
} from './player-animation.js';

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
    answerLabel: 'THE',
    answerSublabel: 'DEFINITE',
    icon: GATE_ICONS.book,
    aria: 'Choose THE',
  },
  indefinite: {
    art: 'assets/gates/gate-green.webp',
    label: 'A / AN',
    answerLabel: 'A / AN',
    answerSublabel: 'INDEFINITE',
    icon: GATE_ICONS.leaf,
    aria: 'Choose A or AN',
  },
  none: {
    art: 'assets/gates/gate-purple.webp',
    label: 'NO ARTICLE',
    answerLabel: '—',
    answerSublabel: 'NO ARTICLE',
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
 * Runner geometry — visual constants only. ROAD_LAYOUTS owns every projected
 * ground value; CSS receives the resulting lane/collision variables so the
 * fox and road agree. Engine progress and collision timing never change.
 */
const RUNNER_GEO = {
  /**
   * Logical progress remains engine-owned. This exponent maps it to a visual
   * journey that lingers near the horizon, then accelerates toward the fox
   * without changing the collision frame.
   */
  gateProgressPower: 1.6,
  minGateScale: 0.2,
  maxGateScale: 1.08,
  gateSpawnFadePerSecond: 5,
  farOpacity: 0.72,
  /** Visual size in px below which labels get a counter-scale boost. */
  minLabelPx: 11,
  maxLabelBoost: 2.3,
  maxLabelWidthRatio: 0.86,
};

/* ------------------------------------------------------------------------
 * World-motion system — the coded perspective road (visual only)
 * ------------------------------------------------------------------------
 * One projection drives every world object. A normalized DEPTH value maps
 * onto the transparent road finish aligned over the responsive scenery plate:
 *
 *   depth 0    → the road's vanishing point (--scene-horizon-y)
 *   playerDepth → the fox/gate collision plane
 *   depth 1     → just beyond the bottom of the clipped game world
 *
 * t = depth^pEase is the perspective easing: y, scale and the road's local
 * half-width are all affine in t, so every ground line (lane centers, lane
 * dividers, road edges) is straight through one shared vanishing point and
 * lane geometry is scale-invariant along the road (a lane keeps the same
 * share of the road's width at every depth).
 *
 * Road props advance LINEARLY in depth — depth += worldSpeed·Δt — and wrap
 * with `if (depth ≥ 1) depth -= 1`,
 * which keeps their spacing perfectly even forever while the t-easing makes
 * them creep near the horizon and rush past the camera. Gates ride the SAME
 * projection. Engine progress is visually eased into projected depth during
 * PLAYING, still reaching the collision plane on the exact resolve frame,
 * then passing the fox instead of hitting it.
 *
 * All road objects are pooled DOM nodes animated with transforms only and
 * recycled near the horizon; nothing is created or destroyed during play.
 * ---------------------------------------------------------------------- */

/**
 * World layouts — per device class, keyed by the CSS --scene-layout custom
 * selected from the live runner dimensions. This table is the only source of
 * road projection geometry and base world speed:
 *
 *   far/nearHalfWidth   road half-width as a runner-width fraction at the
 *                       vanishing point and at the bottom (collision plane
 *                       and beyond extrapolate the same line)
 *   perspectivePower    perspective easing exponent (t = depth^power)
 *   roadShoulder        soft grass rim beyond the sand (grows toward camera)
 *   gateLaneFill        gate width as a share of one projected lane
 *   min/maxGateScale    safety bounds around the lane-derived scale
 *   far/nearLaneSpacing adjacent lane-centre separation
 *   playerDepth         collision depth shared by fox and gates
 */
const ROAD_LAYOUTS = {
  desktop: {
    horizonY: 0.425,
    bottomY: 1.015,
    centerX: 0.5,
    farHalfWidth: 0.085,
    nearHalfWidth: 0.49,
    farLaneSpacing: 0.0567,
    nearLaneSpacing: 0.3267,
    playerDepth: 0.8,
    worldSpeed: 0.5,
    perspectivePower: 1.75,
    gateStartDepth: 0.02,
    roadShoulder: 0.016,
    gateLaneFill: 0.75,
    minGateScale: 0.2,
    maxGateScale: 1.08,
    markerWidthPx: 10,
    markerHeightPx: 78,
    wearW: 0.11,
    grain: 0.26,
  },
  tablet: {
    horizonY: 0.43,
    bottomY: 1.015,
    centerX: 0.5,
    farHalfWidth: 0.08,
    nearHalfWidth: 0.5,
    farLaneSpacing: 0.0533,
    nearLaneSpacing: 0.3333,
    playerDepth: 0.81,
    worldSpeed: 0.52,
    perspectivePower: 1.85,
    gateStartDepth: 0.02,
    roadShoulder: 0.017,
    gateLaneFill: 0.75,
    minGateScale: 0.2,
    maxGateScale: 1.06,
    markerWidthPx: 9,
    markerHeightPx: 72,
    wearW: 0.11,
    grain: 0.24,
  },
  mobile: {
    horizonY: 0.28,
    bottomY: 1.02,
    centerX: 0.5,
    farHalfWidth: 0.105,
    nearHalfWidth: 0.515,
    farLaneSpacing: 0.07,
    nearLaneSpacing: 0.3433,
    playerDepth: 0.88,
    worldSpeed: 0.55,
    perspectivePower: 2,
    gateStartDepth: 0.02,
    roadShoulder: 0.016,
    gateLaneFill: 0.7,
    minGateScale: 0.22,
    maxGateScale: 1.02,
    markerWidthPx: 7,
    markerHeightPx: 62,
    wearW: 0.1,
    grain: 0.2,
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
  wearAlpha: 0.26,
};

/** Motion tuning for the world layer (visual only — never gameplay). */
const ROAD_MOTION = {
  markerMultiplier: 1,
  detailMultiplier: 1,
  textureMultiplier: 0.68,
  texturePixelsPerDepth: 180,
  feedbackBurstS: 0.1,
  crawlCorrect: 0.22,
  crawlWrong: 0.16,
  decelTau: 0.12,
  accelTau: 0.22,
  maxDeltaMs: 40,
  gatePassBoost: 3.2,
  dustEveryMs: 150,
  reducedFactor: 0.7,
};

/** Sparse bonus collectibles. These values intentionally live in one place:
 * coins are a brief surprise between learning decisions, never a road trail. */
const COIN_CONFIG = Object.freeze({
  assetPath: 'assets/ui/coin-star.png',
  minCooldownMs: 7000,
  maxCooldownMs: 14000,
  secondCoinChance: 0.25,
  sameLaneSecondChance: 0.65,
  maxActiveCoins: 2,
  stopSpawnAtGateProgress: 0.58,
  questionGraceMs: 2600,
  resumeGraceMs: 2400,
  spawnDepth: 0.28,
  secondCoinDepthGap: 0.2,
  gateDepthClearance: 0.14,
  collectionStart: 0.86,
  collectionEnd: 1.05,
  despawnDepth: 1.14,
  flightDurationMs: 500,
  sparkCount: 6,
  baseSizeMinPx: 58,
  mobileBaseSizeMinPx: 64,
  baseSizeMaxPx: 78,
  baseSizeRatio: Object.freeze({ desktop: 0.05, tablet: 0.09, mobile: 0.17 }),
});

const coinSystem = {
  pool: [],
  nextSpawnMs: Number.POSITIVE_INFINITY,
  collected: 0,
  displayed: 0,
  effects: new Set(),
  flights: new Set(),
};

const world = {
  built: false,
  W: 0,
  H: 0,
  layoutName: 'desktop',
  baseSpeed: ROAD_LAYOUTS.desktop.worldSpeed,
  speed: ROAD_LAYOUTS.desktop.worldSpeed,
  effectiveSpeed: 0,
  motionRate: 0,
  crawl: 1, // settled feedback slow-motion factor
  feedbackT: 0, // seconds since the gate crossed the collision plane
  horizonY: ROAD_LAYOUTS.desktop.horizonY,
  bottomY: ROAD_LAYOUTS.desktop.bottomY,
  centerX: ROAD_LAYOUTS.desktop.centerX,
  farHalfWidth: ROAD_LAYOUTS.desktop.farHalfWidth,
  nearHalfWidth: ROAD_LAYOUTS.desktop.nearHalfWidth,
  farLaneSpacing: ROAD_LAYOUTS.desktop.farLaneSpacing,
  nearLaneSpacing: ROAD_LAYOUTS.desktop.nearLaneSpacing,
  playerDepth: ROAD_LAYOUTS.desktop.playerDepth,
  perspectivePower: ROAD_LAYOUTS.desktop.perspectivePower,
  divAngle: [-7, 7], // straight divider-rail tilt per side (deg)
  markers: [],
  details: [],
  dusts: [],
  dustIdx: 0,
  dustTimer: 0,
  roadTextureOffset: 0,
  playerLane: 1,
  gate: { depth: 0, spawnFade: 0 },
};

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

function gateVisualDepth(progress) {
  return Math.pow(clamp01(progress), RUNNER_GEO.gateProgressPower);
}

function lerp(from, to, amount) {
  return from + (to - from) * amount;
}

/**
 * THE single perspective helper: normalized depth + continuous lane →
 * screen point. Lane offsets −1/0/+1 are answer lanes and ±0.5 are divider
 * rails. Scale is normalized to exactly 1 at the fox's playerDepth.
 */
function projectRoadPoint(depth, laneOffset = 0) {
  const safeDepth = Math.max(0, depth);
  const t = Math.pow(safeDepth, world.perspectivePower);
  const playerT = Math.pow(world.playerDepth, world.perspectivePower);
  const roadHalfWidth = lerp(world.farHalfWidth, world.nearHalfWidth, t);
  const laneSpacing = lerp(world.farLaneSpacing, world.nearLaneSpacing, t);
  const playerHalfWidth = lerp(world.farHalfWidth, world.nearHalfWidth, playerT);
  return {
    x: world.centerX + laneOffset * laneSpacing,
    y: lerp(world.horizonY, world.bottomY, t),
    roadHalfWidth,
    laneSpacing,
    scale: roadHalfWidth / playerHalfWidth,
    t,
    depth: safeDepth,
  };
}

/** Project one of the three answer lanes through the shared road geometry. */
function projectLanePoint(depth, laneIndex) {
  return projectRoadPoint(depth, laneIndex - 1);
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
  answerDock: document.getElementById('answer-dock'),
  runner: document.getElementById('runner'),
  scene: document.querySelector('.scene'),
  gatesRoot: document.getElementById('gates'),
  player: document.getElementById('player'),
  playerLean: document.getElementById('player-lean'),
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
const answerChoiceEls = [...dom.answerDock.querySelectorAll('.answer-dock__choice')];
const roadGuideEls = [...document.querySelectorAll('.road-guide')];

/* ========================================================================
 * 2. Module state
 * ====================================================================== */

let gameData = null;
let engine = null;
let selectedMode = GAME_MODES.LEARN;
let currentQuestionSentence = '';
let currentScreen = 'start';
let pauseReturnFocus = null;
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
  dom.devProgress.textContent =
    `gate ${Math.round(gateVisualProgress * 100)}% · ${world.layoutName} · ` +
    `${world.effectiveSpeed.toFixed(3)} depth/s · ${world.markers.length} markers · ` +
    `texture ${world.roadTextureOffset.toFixed(3)}`;
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
  // Start decoding immediately. startGame awaits this exact promise, so a
  // fast click can never enter gameplay before the complete cycle is ready.
  runFramesReady = preloadRunFrames();
  preloadGateArt(); // warm the 3 gate images once; reused from cache afterwards
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
    resetCoinSession();
    resetPlayerAnimation(); // only a new/restarted level restarts the gait
    clearStartNote();
    renderHUD();
  });
  engine.on('question:loaded', (payload) => {
    logEvent('question:loaded', payload);
    deferCoinSpawn(COIN_CONFIG.questionGraceMs);
    renderQuestion(payload);
  });
  engine.on('player:lane-changed', (payload) => {
    logEvent('player:lane-changed', payload);
    renderPlayer(payload.to);
    highlightChosenGate(payload.to);
    highlightAnswerChoice(payload.to);
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
  engine.on('game:resumed', () => {
    logEvent('game:resumed');
    deferCoinSpawn(COIN_CONFIG.resumeGraceMs);
  });
  engine.on('progress:reset', () => {
    logEvent('progress:reset');
    renderLevelList();
  });
}

function handleStateChanged({ to }) {
  // The fox runs while the engine is PLAYING and keeps trotting through
  // FEEDBACK (slowed by the world crawl in the loop); every other state
  // freezes the exact image + phase-driven shadow values.
  const running = to === GAME_STATES.PLAYING || to === GAME_STATES.FEEDBACK;
  dom.player.classList.toggle('is-running', running);
  updateAnswerDockState(to);
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
      showStablePlayerPose();
      renderPause(false);
      renderLevelList();
      showScreen('complete');
      break;
    case GAME_STATES.GAME_OVER:
      showStablePlayerPose();
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
  if (currentScreen === 'game' && name !== 'game') endCoinSession();
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
  const wasHidden = dom.overlayPause.classList.contains('hidden');
  dom.overlayPause.classList.toggle('hidden', !visible);
  dom.screenGame.classList.toggle('is-coin-paused', visible);
  if (visible && wasHidden) {
    pauseReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    requestAnimationFrame(() => dom.btnResume.focus());
  } else if (!visible && !wasHidden) {
    const target = pauseReturnFocus;
    pauseReturnFocus = null;
    requestAnimationFrame(() => {
      if (
        target?.isConnected &&
        currentScreen === 'game' &&
        !dom.screenGame.classList.contains('hidden')
      ) {
        target.focus();
      }
    });
  }
}

/* ========================================================================
 * 8. HUD rendering — everything the player sees at the top of the game.
 *     (visual pass: restyle here; data always comes from the snapshot)
 * ====================================================================== */

/** What the HUD last painted — used ONLY to trigger change animations.
 *  Never read as gameplay state; the engine snapshot stays the single
 *  source of truth for every value shown here. */
const hudPainted = { streak: null };

/** Restart a one-shot animation class on an element. */
function retriggerAnimation(el, className) {
  el.classList.remove(className);
  void el.offsetWidth; // flush so the class removal takes effect
  el.classList.add(className);
}

function renderCoinHud(pulse = false) {
  const count = coinSystem.displayed;
  dom.hudScore.textContent = `${count}`;
  dom.hudScorePill.title = 'Bonus coins';
  dom.hudScorePill.setAttribute(
    'aria-label',
    `${count} bonus coin${count === 1 ? '' : 's'}`,
  );
  if (pulse) retriggerAnimation(dom.hudScorePill, 'hud-coin--pulse');
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

  // The existing gold pill is the session-only bonus coin counter. Engine
  // score remains untouched and is still reported on result screens.
  renderCoinHud();

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

  // Place each fresh gate group at the vanishing point, then advance it
  // through the same projection used by the lane guides.
  const activeLayout = ROAD_LAYOUTS[world.layoutName];
  world.gate.depth = activeLayout.gateStartDepth;
  world.gate.spawnFade = 0;
  world.feedbackT = 0;

  // Sentence with a visible blank, built from text nodes only.
  dom.sentence.replaceChildren();
  currentQuestionSentence = payload.question.sentence;
  const [before, after = ''] = currentQuestionSentence.split('___');
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
  renderAnswerDock(payload.laneMap);
  renderPlayer(payload.playerLane);
  highlightChosenGate(payload.playerLane);
  highlightAnswerChoice(payload.playerLane);
  updateAnswerDockState(engine.state);
  hideFeedback();
  dom.player.classList.remove('player-correct', 'player-wrong');
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

/** The dock mirrors the same randomized laneMap rendered by the road gates. */
function renderAnswerDock(laneMap) {
  answerChoiceEls.forEach((choice, lane) => {
    const category = laneMap[lane];
    const visuals = GATE_VISUALS[category];
    if (!visuals) return;
    choice.dataset.lane = String(lane);
    choice.dataset.category = category;
    choice.querySelector('.answer-dock__label').textContent = visuals.answerLabel;
    choice.querySelector('.answer-dock__sublabel').textContent = visuals.answerSublabel;
    choice.setAttribute('aria-label', visuals.aria);
    choice.setAttribute('aria-pressed', 'false');
    choice.classList.remove('is-selected', 'is-correct', 'is-wrong');
  });
}

function updateAnswerDockState(state) {
  const visible =
    state === GAME_STATES.PLAYING ||
    state === GAME_STATES.PAUSED ||
    state === GAME_STATES.FEEDBACK;
  const interactive = state === GAME_STATES.PLAYING;
  dom.answerDock.classList.toggle('hidden', !visible);
  dom.answerDock.setAttribute('aria-hidden', String(!visible));
  answerChoiceEls.forEach((choice) => {
    choice.disabled = !interactive;
  });
}

function renderPlayer(lane) {
  world.playerLane = lane;
  dom.player.style.left = PLAYER_LANE_POSITIONS[lane];
  roadGuideEls.forEach((guide, index) => guide.classList.toggle('is-active', index === lane));
}

function renderLaneGuides() {
  if (world.W < 40 || roadGuideEls.length === 0) return;
  const offset = world.layoutName === 'mobile' ? 0.05 : world.layoutName === 'tablet' ? 0.07 : 0.09;
  const depth = Math.min(world.playerDepth - 0.02, world.gate.depth + offset);
  roadGuideEls.forEach((guide, lane) => {
    const p = projectLanePoint(depth, lane);
    const scale = Math.max(0.46, Math.min(0.82, p.scale * 1.45));
    guide.style.transform =
      `translate3d(${(p.x * world.W).toFixed(1)}px, ${(p.y * world.H).toFixed(1)}px, 0) ` +
      `translate(-50%, -50%) scale(${scale.toFixed(3)})`;
  });
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
  dom.playerLean.classList.remove('lean-left', 'lean-right');
  // Restart the transform transition cleanly when changes come rapid-fire.
  void dom.playerLean.offsetWidth;
  dom.playerLean.classList.add(to > from ? 'lean-right' : 'lean-left');
  clearTimeout(laneLeanTimer);
  laneLeanTimer = setTimeout(() => {
    dom.playerLean.classList.remove('lean-left', 'lean-right');
  }, 240);
}

function highlightChosenGate(lane) {
  gateEls.forEach((gate, index) => gate.classList.toggle('is-chosen', index === lane));
}

function highlightAnswerChoice(lane) {
  answerChoiceEls.forEach((choice, index) => {
    const selected = index === lane;
    choice.classList.toggle('is-selected', selected);
    choice.setAttribute('aria-pressed', String(selected));
  });
}

/* ---- perspective: gateProgress (engine, normalized 0..1) → visual depth ---
 * Everything below is derived per frame from the SAME progress value, so the
 * three gates always share one depth: ground line, scale, lane spread and
 * opacity move together. No CSS keyframes drive gate motion.
 * ------------------------------------------------------------------------ */

function selectRoadLayoutName(W, H) {
  const shortest = Math.min(W, H);
  const longest = Math.max(W, H);
  const aspect = longest / Math.max(1, shortest);
  if (shortest <= 600) return 'mobile';
  if (longest <= 1400 && aspect <= 1.7) return 'tablet';
  return 'desktop';
}

/** Base label font in px per gate (unscaled cqw size), refreshed on resize. */
let gateLabelBasePx = [0, 0, 0];
let gateLabelBaseWidthPx = [0, 0, 0];
let gateBaseWidthPx = [0, 0, 0];
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
    gateLabelBaseWidthPx[i] = label.offsetWidth;
    gateBaseWidthPx[i] = gate.clientWidth;
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

function buildRoadWorld() {
  if (world.built) return;
  const layer = roadLayer();
  if (!layer) return;
  world.built = true;

  const make = (cls) => {
    const el = document.createElement('div');
    el.className = cls;
    layer.appendChild(el);
    return el;
  };

  // Exactly eight paired markers per divider. Depths are seeded here once
  // and are never reconstructed on a question, resume, or resize.
  for (let line = 0; line < 2; line += 1) {
    for (let i = 0; i < 8; i += 1) {
      const el = make('lane-marker');
      world.markers.push({
        el,
        line,
        depth: (i + 0.35) / 8,
      });
    }
  }

  // Eight fixed road details. Their lane offsets stay stable when recycled,
  // so no stone can jump sideways or cross a divider while it approaches.
  const detailSeeds = [
    { depth: 0.08, laneOffset: -1.26, rot: -18 },
    { depth: 0.2, laneOffset: 0.08, rot: 24 },
    { depth: 0.32, laneOffset: 1.22, rot: -31 },
    { depth: 0.44, laneOffset: -0.12, rot: 11 },
    { depth: 0.56, laneOffset: -1.18, rot: 35 },
    { depth: 0.68, laneOffset: 1.16, rot: -9 },
    { depth: 0.8, laneOffset: 0.16, rot: 29 },
    { depth: 0.92, laneOffset: -1.24, rot: -38 },
  ];
  detailSeeds.forEach((seed, i) => {
    const el = make(`road-detail road-stone stone-${String.fromCharCode(97 + (i % 4))}`);
    world.details.push({
      el,
      ...seed,
    });
  });

  // Dust puffs behind the fox (spawned at runtime, pooled).
  for (let i = 0; i < 4; i += 1) {
    const el = make('dust-puff');
    el.style.opacity = '0';
    world.dusts.push({ el, depth: 0, m: 0, born: 0, size: 0.72 + i * 0.16 });
  }

  buildCoinPool(layer);
}

/**
 * Recompute every screen-space value the world needs: runner size, the
 * active layout's projection constants, the coded road polygons (sand
 * surface + grass shoulder), divider rail tilt, scenery placement and the
 * pooled elements' base sizes. Cheap, idempotent; called on init, when the
 * game screen shows and on resize.
 */
function rebuildWorldGeometry() {
  const rect = dom.runner.getBoundingClientRect();
  if (rect.width < 40 || rect.height < 40) return; // hidden screen — try again when shown

  world.W = rect.width;
  world.H = rect.height;
  world.layoutName = selectRoadLayoutName(world.W, world.H);
  dom.runner.dataset.roadLayout = world.layoutName;
  const layout = ROAD_LAYOUTS[world.layoutName];
  world.horizonY = layout.horizonY;
  world.bottomY = layout.bottomY;
  world.centerX = layout.centerX;
  world.farHalfWidth = layout.farHalfWidth;
  world.nearHalfWidth = layout.nearHalfWidth;
  world.farLaneSpacing = layout.farLaneSpacing;
  world.nearLaneSpacing = layout.nearLaneSpacing;
  world.playerDepth = layout.playerDepth;
  world.perspectivePower = layout.perspectivePower;
  world.baseSpeed = layout.worldSpeed * (prefersReducedMotion ? ROAD_MOTION.reducedFactor : 1);
  world.speed = world.baseSpeed;
  world.effectiveSpeed = world.baseSpeed * world.motionRate;

  // Preserve the gate's journey when geometry changes while play is frozen.
  // Re-projecting its stored progress prevents a resize/orientation snap.
  if (engine.state === GAME_STATES.PLAYING || engine.state === GAME_STATES.PAUSED) {
    world.gate.depth = lerp(
      layout.gateStartDepth,
      world.playerDepth,
      gateVisualDepth(gateVisualProgress),
    );
  }

  const playerGround = projectRoadPoint(world.playerDepth, 0);
  dom.runner.style.setProperty('--scene-horizon-y', `${(world.horizonY * 100).toFixed(2)}%`);
  dom.runner.style.setProperty('--scene-collision-y', `${(playerGround.y * 100).toFixed(2)}%`);
  for (let lane = 0; lane < 3; lane += 1) {
    const lanePoint = projectLanePoint(world.playerDepth, lane);
    dom.runner.style.setProperty(`--lane-x-${lane}`, `${(lanePoint.x * 100).toFixed(2)}%`);
  }
  dom.runner.style.setProperty('--lane-marker-width', `${layout.markerWidthPx}px`);
  dom.runner.style.setProperty('--lane-marker-height', `${layout.markerHeightPx}px`);

  // The gate's unscaled width is one safe share of a lane at the fox plane.
  const laneWidthAtPlayer = playerGround.laneSpacing * world.W;
  dom.gatesRoot.style.setProperty(
    '--gate-road-w',
    `${(laneWidthAtPlayer * (layout.gateLaneFill ?? 0.72)).toFixed(1)}px`,
  );

  // Divider rails are straight in projected t-space, so every marker on a
  // divider shares one stable angle for this viewport.
  const mDiv = (0.5 * (world.nearLaneSpacing - world.farLaneSpacing)) /
    (world.bottomY - world.horizonY);
  const angle = (Math.atan2(mDiv * world.W, world.H) * 180) / Math.PI;
  world.divAngle = [angle, -angle];

  drawCodedRoad(layout);
  // Resize changes intrinsic sizes only. Normalized depths and texture phase
  // remain untouched, so orientation and breakpoint changes never reset flow.
  dom.runner.style.setProperty('--road-grain-o', String(layout.grain ?? 0.5));
  const detailBase = Math.max(6, Math.min(14, world.W * 0.0095));
  world.details.forEach((detail, i) => {
    const size = detailBase * [0.72, 0.95, 1.12, 0.58][i % 4];
    detail.el.style.width = `${size.toFixed(1)}px`;
    detail.el.style.height = `${(size * 0.72).toFixed(1)}px`;
  });
  const dustBase = Math.max(10, Math.min(28, world.W * 0.02));
  world.dusts.forEach((p) => {
    p.el.style.width = `${(dustBase * p.size).toFixed(1)}px`;
    p.el.style.height = `${(dustBase * p.size).toFixed(1)}px`;
  });
  const coinRatio = COIN_CONFIG.baseSizeRatio[world.layoutName] ?? COIN_CONFIG.baseSizeRatio.desktop;
  const coinMin = world.layoutName === 'mobile'
    ? COIN_CONFIG.mobileBaseSizeMinPx
    : COIN_CONFIG.baseSizeMinPx;
  const coinBase = Math.min(
    COIN_CONFIG.baseSizeMaxPx,
    Math.max(coinMin, world.W * coinRatio),
  );
  coinSystem.pool.forEach((coin) => {
    coin.el.style.width = `${coinBase.toFixed(1)}px`;
    coin.el.style.height = `${coinBase.toFixed(1)}px`;
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

  const polygon = (grow) => {
    const STEPS = 12;
    const left = [];
    const right = [];
    for (let s = 0; s <= STEPS; s += 1) {
      const t = s / STEPS;
      const half = lerp(world.farHalfWidth, world.nearHalfWidth, t) + grow(t);
      const y = (lerp(world.horizonY, world.bottomY, t) * 100).toFixed(2);
      left.push(`${((world.centerX - half) * 100).toFixed(2)}% ${y}%`);
      right.push(`${((world.centerX + half) * 100).toFixed(2)}% ${y}%`);
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
        const t = s / STEPS;
        const half = lerp(world.farHalfWidth, world.nearHalfWidth, t);
        const y = (lerp(world.horizonY, world.bottomY, t) * 100).toFixed(2);
        outer.push(`${((world.centerX + side * half) * 100).toFixed(2)}% ${y}%`);
        inner.push(`${((world.centerX + side * half * (1 - wear)) * 100).toFixed(2)}% ${y}%`);
      }
      return `polygon(${outer.join(', ')}, ${inner.reverse().join(', ')})`;
    };
    roadShading.style.setProperty('--wear-clip-l', wear > 0 ? band(-1) : 'none');
    roadShading.style.setProperty('--wear-clip-r', wear > 0 ? band(1) : 'none');
    roadShading.style.setProperty('--wear-alpha', String(ROAD_TEXTURE.wearAlpha));
  }

  // Wheel-wear tracks follow the same lane-spacing interpolation as every
  // projected road object.
  const roadTracks = document.getElementById('road-tracks');
  if (roadTracks) {
    const TRACK_HALF = 0.16;
    [0, 1, 2].forEach((laneIndex, idx) => {
      const left = [];
      const right = [];
      for (let s = 0; s <= 8; s += 1) {
        const t = s / 8;
        const spacing = lerp(world.farLaneSpacing, world.nearLaneSpacing, t);
        const y = (lerp(world.horizonY, world.bottomY, t) * 100).toFixed(2);
        const centre = (world.centerX + (laneIndex - 1) * spacing) * 100;
        const trackHalf = TRACK_HALF * spacing * 100;
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
  for (const marker of world.markers) renderMarker(marker);
  for (const detail of world.details) renderRoadDetail(detail);
  for (const p of world.dusts) renderDust(p);
  for (const coin of coinSystem.pool) renderCoin(coin);
}

function setLayerZ(el, depth) {
  const z = 1 + Math.round(Math.min(Math.max(depth, 0), 1.45) * 2);
  el.style.zIndex = String(z);
}

function renderMarker(marker) {
  const divider = marker.line === 0 ? -0.5 : 0.5;
  const p = projectRoadPoint(marker.depth, divider);
  const scaleX = Math.max(0.16, p.scale);
  marker.el.style.transform =
    `translate3d(${(p.x * world.W).toFixed(1)}px, ${(p.y * world.H).toFixed(1)}px, 0) ` +
    `translate(-50%, -50%) rotate(${world.divAngle[marker.line].toFixed(1)}deg) ` +
    `scale3d(${scaleX.toFixed(3)}, ${p.scale.toFixed(3)}, 1)`;
  marker.el.style.opacity = Math.min(0.92, 0.38 + p.t * 1.2).toFixed(2);
}

function renderRoadDetail(detail) {
  const p = projectRoadPoint(detail.depth, detail.laneOffset);
  detail.el.style.transform =
    `translate3d(${(p.x * world.W).toFixed(1)}px, ${(p.y * world.H).toFixed(1)}px, 0) ` +
    `translate(-50%, -50%) rotate(${detail.rot}deg) scale(${p.scale.toFixed(3)})`;
  detail.el.style.opacity = Math.min(0.78, 0.14 + p.t * 1.3).toFixed(2);
}

function renderDust(puff) {
  if (puff.born <= 0) {
    puff.el.style.opacity = '0';
    return; // pooled but idle
  }
  const p = projectRoadPoint(puff.depth, puff.m);
  const lifeSpan = Math.max(0.08, 1 - puff.born);
  const life = clamp01((puff.depth - puff.born) / lifeSpan);
  puff.el.style.transform =
    `translate3d(${(p.x * world.W).toFixed(1)}px, ${(p.y * world.H).toFixed(1)}px, 0) ` +
    `translate(-50%, -50%) scale(${(p.scale * (0.62 + life * 0.42)).toFixed(3)})`;
  puff.el.style.opacity = (0.28 * (1 - life)).toFixed(3);
}

/**
 * Advance + render the whole world layer for one frame.
 * rate = the eased slow-motion multiplier (0 pauses every road cue). Every
 * pooled object advances linearly in normalized depth; the nonlinear shared
 * projection creates the apparent acceleration toward the camera.
 */
function updateWorldMotion(dt, rate, playerAnimFactor) {
  if (!world.built || world.W < 40) return;
  const worldAdvance = world.baseSpeed * rate * dt;
  const markerAdvance = worldAdvance * ROAD_MOTION.markerMultiplier;
  const detailAdvance = worldAdvance * ROAD_MOTION.detailMultiplier;
  world.effectiveSpeed = world.baseSpeed * rate;

  if (worldAdvance > 0) {
    for (const marker of world.markers) {
      marker.depth += markerAdvance;
      if (marker.depth >= 1) marker.depth -= 1;
      renderMarker(marker);
    }
    for (const detail of world.details) {
      detail.depth += detailAdvance;
      if (detail.depth >= 1) detail.depth -= 1;
      renderRoadDetail(detail);
    }
    for (const puff of world.dusts) {
      if (puff.born > 0) {
        puff.depth += detailAdvance;
        if (puff.depth >= 1) puff.born = 0;
        renderDust(puff);
      }
    }

    world.roadTextureOffset +=
      worldAdvance * ROAD_MOTION.textureMultiplier * ROAD_MOTION.texturePixelsPerDepth;
    dom.runner.style.setProperty(
      '--road-texture-offset-px',
      `${world.roadTextureOffset.toFixed(2)}px`,
    );

    // Dust spawning at the fox's ground line (skipped under reduced motion).
    if (!prefersReducedMotion && playerAnimFactor > 0) {
      world.dustTimer += dt * 1000 * playerAnimFactor;
      if (world.dustTimer >= ROAD_MOTION.dustEveryMs) {
        world.dustTimer %= ROAD_MOTION.dustEveryMs;
        const puff = world.dusts[world.dustIdx++ % world.dusts.length];
        puff.born = world.playerDepth;
        puff.depth = puff.born;
        puff.m = world.playerLane - 1 + randRange(-0.08, 0.08);
        renderDust(puff);
      }
    }
  }
}

function updateRoadMotionRate(dt, state) {
  if (state !== GAME_STATES.PLAYING && state !== GAME_STATES.FEEDBACK) {
    return 0;
  }
  const target = state === GAME_STATES.PLAYING || world.feedbackT < ROAD_MOTION.feedbackBurstS
    ? 1
    : world.crawl;
  const tau = target < world.motionRate ? ROAD_MOTION.decelTau : ROAD_MOTION.accelTau;
  const blend = 1 - Math.exp(-dt / tau);
  world.motionRate += (target - world.motionRate) * blend;
  return world.motionRate;
}

/* ---- collectible coins -------------------------------------------------
 * Two pooled road objects share the same projection and world delta as every
 * other road detail. Only the temporary, one-shot collection feedback is
 * created at runtime; all of it is removed when gameplay ends.
 * ---------------------------------------------------------------------- */

function buildCoinPool(layer) {
  if (coinSystem.pool.length > 0) return;
  for (let index = 0; index < COIN_CONFIG.maxActiveCoins; index += 1) {
    const el = document.createElement('div');
    el.className = 'road-coin';
    el.setAttribute('aria-hidden', 'true');
    el.style.display = 'none';

    const image = document.createElement('img');
    image.className = 'road-coin__image';
    image.src = COIN_CONFIG.assetPath;
    image.alt = '';
    image.draggable = false;
    image.decoding = 'async';
    image.style.animationDelay = `-${Math.round(randRange(0, 2200))}ms`;
    el.appendChild(image);
    layer.appendChild(el);

    coinSystem.pool.push({
      el,
      image,
      lane: 1,
      depth: 0,
      active: false,
      collected: false,
    });
  }
}

function randomCoinCooldown() {
  return Math.round(randRange(COIN_CONFIG.minCooldownMs, COIN_CONFIG.maxCooldownMs));
}

function deferCoinSpawn(minDelayMs) {
  if (!Number.isFinite(coinSystem.nextSpawnMs)) return;
  coinSystem.nextSpawnMs = Math.max(coinSystem.nextSpawnMs, minDelayMs);
}

function releaseCoin(coin) {
  coin.active = false;
  coin.collected = false;
  coin.el.classList.remove('is-active');
  coin.el.style.display = 'none';
  coin.el.style.opacity = '0';
}

function removeCoinEffect(effect) {
  coinSystem.flights.delete(effect);
  coinSystem.effects.delete(effect);
  effect.remove();
}

function clearCoinEffects() {
  coinSystem.flights.clear();
  for (const effect of coinSystem.effects) effect.remove();
  coinSystem.effects.clear();
}

function clearCoins() {
  coinSystem.pool.forEach(releaseCoin);
  clearCoinEffects();
  coinSystem.nextSpawnMs = Number.POSITIVE_INFINITY;
}

function resetCoinSession() {
  clearCoins();
  coinSystem.collected = 0;
  coinSystem.displayed = 0;
  coinSystem.nextSpawnMs = randomCoinCooldown();
  renderCoinHud();
}

function endCoinSession() {
  clearCoins();
  coinSystem.collected = 0;
  coinSystem.displayed = 0;
  renderCoinHud();
}

function spawnCoin(lane, depth) {
  const coin = coinSystem.pool.find((candidate) => !candidate.active);
  if (!coin) return false;
  coin.lane = lane;
  coin.depth = depth;
  coin.active = true;
  coin.collected = false;
  coin.image.style.animationDelay = `-${Math.round(randRange(0, 2200))}ms`;
  coin.el.style.display = '';
  coin.el.classList.add('is-active');
  renderCoin(coin);
  return true;
}

function spawnCoinEvent() {
  const firstLane = Math.floor(Math.random() * 3);
  // Never initialize a coin in the gate plane. It starts farther up-road and
  // reaches the fox well before the final grammar decision zone.
  const firstDepth = Math.min(
    COIN_CONFIG.spawnDepth,
    Math.max(0.08, world.gate.depth - COIN_CONFIG.gateDepthClearance),
  );
  if (!spawnCoin(firstLane, firstDepth)) return;

  const freeSlots = coinSystem.pool.filter((coin) => !coin.active).length;
  if (freeSlots > 0 && Math.random() < COIN_CONFIG.secondCoinChance) {
    const adjacentLane = firstLane === 1
      ? (Math.random() < 0.5 ? 0 : 2)
      : 1;
    const secondLane = Math.random() < COIN_CONFIG.sameLaneSecondChance
      ? firstLane
      : adjacentLane;
    const secondDepth = Math.max(0.025, firstDepth - COIN_CONFIG.secondCoinDepthGap);
    spawnCoin(secondLane, secondDepth);
  }

  coinSystem.nextSpawnMs = randomCoinCooldown();
}

function renderCoin(coin) {
  if (!coin.active || world.W < 40) return;
  const p = projectLanePoint(coin.depth, coin.lane);
  coin.el.style.transform =
    `translate3d(${(p.x * world.W).toFixed(1)}px, ${(p.y * world.H).toFixed(1)}px, 0) ` +
    `translate(-50%, -92%) scale(${p.scale.toFixed(3)})`;
  coin.el.style.opacity = Math.min(1, 0.28 + p.t * 2.2).toFixed(3);
  setLayerZ(coin.el, coin.depth);
}

function createCoinBurst(x, y) {
  const burst = document.createElement('span');
  burst.className = 'coin-burst';
  burst.setAttribute('aria-hidden', 'true');
  burst.style.setProperty('--coin-burst-x', `${x.toFixed(1)}px`);
  burst.style.setProperty('--coin-burst-y', `${y.toFixed(1)}px`);

  for (let index = 0; index < COIN_CONFIG.sparkCount; index += 1) {
    const angle = (Math.PI * 2 * index) / COIN_CONFIG.sparkCount + randRange(-0.16, 0.16);
    const distance = randRange(18, 31);
    const spark = document.createElement('i');
    spark.className = 'coin-spark';
    spark.style.setProperty('--spark-x', `${(Math.cos(angle) * distance).toFixed(1)}px`);
    spark.style.setProperty('--spark-y', `${(Math.sin(angle) * distance).toFixed(1)}px`);
    spark.style.animationDelay = `${index * 12}ms`;
    burst.appendChild(spark);
  }

  dom.screenGame.appendChild(burst);
  coinSystem.effects.add(burst);
  burst.lastElementChild?.addEventListener(
    'animationend',
    () => removeCoinEffect(burst),
    { once: true },
  );
}

function finishCoinFlight(flight) {
  if (!coinSystem.flights.has(flight)) return;
  removeCoinEffect(flight);
  coinSystem.displayed = Math.min(coinSystem.collected, coinSystem.displayed + 1);
  renderCoinHud(true);
}

function createCoinFlight(sourceRect) {
  const target = dom.hudScorePill.querySelector('.hud-icon--coin') ?? dom.hudScorePill;
  const targetRect = target.getBoundingClientRect();
  if (targetRect.width <= 0 || targetRect.height <= 0) {
    coinSystem.displayed = Math.min(coinSystem.collected, coinSystem.displayed + 1);
    renderCoinHud(true);
    return;
  }

  const fromX = sourceRect.left + sourceRect.width / 2;
  const fromY = sourceRect.top + sourceRect.height / 2;
  const toX = targetRect.left + targetRect.width / 2;
  const toY = targetRect.top + targetRect.height / 2;
  const curveLift = Math.min(70, Math.max(26, Math.abs(toX - fromX) * 0.08));
  const flight = document.createElement('img');
  flight.className = 'coin--collecting';
  flight.src = COIN_CONFIG.assetPath;
  flight.alt = '';
  flight.draggable = false;
  flight.setAttribute('aria-hidden', 'true');
  flight.style.setProperty('--coin-flight-size', `${Math.max(24, sourceRect.width).toFixed(1)}px`);
  flight.style.setProperty('--coin-flight-duration', `${COIN_CONFIG.flightDurationMs}ms`);
  flight.style.setProperty('--coin-from-x', `${fromX.toFixed(1)}px`);
  flight.style.setProperty('--coin-from-y', `${fromY.toFixed(1)}px`);
  flight.style.setProperty('--coin-mid-x', `${(fromX + (toX - fromX) * 0.48).toFixed(1)}px`);
  flight.style.setProperty(
    '--coin-mid-y',
    `${(fromY + (toY - fromY) * 0.48 - curveLift).toFixed(1)}px`,
  );
  flight.style.setProperty('--coin-to-x', `${toX.toFixed(1)}px`);
  flight.style.setProperty('--coin-to-y', `${toY.toFixed(1)}px`);
  dom.screenGame.appendChild(flight);
  coinSystem.effects.add(flight);
  coinSystem.flights.add(flight);
  flight.addEventListener('animationend', () => finishCoinFlight(flight), { once: true });
}

function collectCoin(coin) {
  if (!coin.active || coin.collected) return;
  coin.collected = true;
  const rect = coin.el.getBoundingClientRect();
  releaseCoin(coin);
  coinSystem.collected += 1;

  if (prefersReducedMotion) {
    coinSystem.displayed += 1;
    renderCoinHud(true);
    return;
  }

  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  createCoinBurst(x, y);
  createCoinFlight(rect);
}

function settleCoinEffectsForReducedMotion() {
  for (const effect of [...coinSystem.effects]) {
    if (coinSystem.flights.has(effect)) finishCoinFlight(effect);
    else removeCoinEffect(effect);
  }
}

function updateCoins(deltaMs, dt, rate, state) {
  if (coinSystem.pool.length === 0 || world.W < 40) return;
  const advance = world.speed * rate * dt;
  const playerLane = state === GAME_STATES.PLAYING || state === GAME_STATES.FEEDBACK
    ? engine.getSnapshot().playerLane
    : null;

  if (advance > 0) {
    for (const coin of coinSystem.pool) {
      if (!coin.active) continue;
      coin.depth += advance;
      renderCoin(coin);

      // COIN_CONFIG keeps the original 0..1 collection tuning, while the
      // responsive road places the fox at a layout-specific playerDepth.
      const playerRelativeDepth = coin.depth / world.playerDepth;
      const inCollectionZone =
        playerRelativeDepth >= COIN_CONFIG.collectionStart &&
        playerRelativeDepth <= COIN_CONFIG.collectionEnd;
      if (inCollectionZone && coin.lane === playerLane) {
        collectCoin(coin);
      } else if (playerRelativeDepth > COIN_CONFIG.despawnDepth) {
        releaseCoin(coin); // missed coins carry no penalty or message
      }
    }
  }

  if (
    state !== GAME_STATES.PLAYING ||
    currentScreen !== 'game' ||
    engine.gateProgress >= COIN_CONFIG.stopSpawnAtGateProgress
  ) {
    return;
  }

  coinSystem.nextSpawnMs -= deltaMs;
  if (
    coinSystem.nextSpawnMs <= 0 &&
    coinSystem.pool.filter((coin) => coin.active).length < COIN_CONFIG.maxActiveCoins
  ) {
    spawnCoinEvent();
  }
}

/**
 * Gate visual state per engine state:
 *  - PLAYING: eased visual depth follows gateProgress and reaches the
 *    collision plane at the exact frame the engine resolves the question.
 *  - FEEDBACK: the gate sweeps past the camera at gatePassBoost × world
 *    speed (~100–200ms from collision to fully behind us), scaling up and
 *    fading as it exits, while the road itself slows to the crawl factor.
 */
function updateGateVisual(dt, state) {
  const g = world.gate;
  if (state === GAME_STATES.PLAYING) {
    const layout = ROAD_LAYOUTS[world.layoutName];
    const start = layout.gateStartDepth;
    g.depth = lerp(start, world.playerDepth, gateVisualDepth(gateVisualProgress));
    g.spawnFade = Math.min(1, g.spawnFade + dt * RUNNER_GEO.gateSpawnFadePerSecond);
  } else if (state === GAME_STATES.FEEDBACK) {
    world.feedbackT += dt;
    g.spawnFade = 1;
    g.depth = Math.min(
      1.05,
      g.depth + world.baseSpeed * ROAD_MOTION.gatePassBoost * dt
    );
  }
}

function renderGates() {
  const laneMap = engine.laneMap;
  if (!laneMap || laneMap.length === 0) return;
  // Container-query sizes only resolve on screen — measure lazily on the
  // first visible frame rather than while #screen-game is display:none.
  if (gateLabelBaseStale) refreshGateLabelBase();
  const { farOpacity, minLabelPx, maxLabelBoost, maxLabelWidthRatio } = RUNNER_GEO;
  const layout = ROAD_LAYOUTS[world.layoutName];
  const D = world.gate.depth;
  const centerPoint = projectRoadPoint(D, 0);
  const playerPoint = projectRoadPoint(world.playerDepth, 0);
  const gateJourney = clamp01(
    (D - layout.gateStartDepth) / Math.max(0.001, world.playerDepth - layout.gateStartDepth),
  );
  const laneScale = centerPoint.laneSpacing / Math.max(0.0001, playerPoint.laneSpacing);
  const minScale = layout.minGateScale ?? RUNNER_GEO.minGateScale;
  const maxScale = layout.maxGateScale ?? RUNNER_GEO.maxGateScale;
  const scale = Math.min(maxScale, Math.max(minScale, laneScale));
  const passProgress = clamp01(
    (D - world.playerDepth) / Math.max(0.001, 1 - world.playerDepth),
  );
  const passFade = 1 - clamp01((passProgress - 0.04) / 0.62);
  const opacity =
    (farOpacity + (1 - farOpacity) * gateJourney) * world.gate.spawnFade * passFade;

  for (let lane = 0; lane < 3; lane += 1) {
    // Same projection as every road object; no post-projection lane spread.
    const p = projectLanePoint(D, lane);
    const el = gateEls[lane];
    // (x, y) is the gate's ground point: bottom-centered, standing on the road.
    el.style.transform =
      `translate3d(${(p.x * world.W).toFixed(1)}px, ${(p.y * world.H).toFixed(1)}px, 0) ` +
      `translate(-50%, -100%) scale(${scale.toFixed(4)})`;
    el.style.opacity = opacity.toFixed(3);
    // Contact shadow reads stronger as the gate gets close.
    el.style.setProperty('--gate-shadow-o', (0.22 + 0.4 * gateJourney).toFixed(3));

    // Keep labels readable at distance: counter-scale up while the gate is
    // small, but never beyond the signboard's safe single-line width.
    const base = gateLabelBasePx[lane];
    const baseWidth = gateLabelBaseWidthPx[lane];
    const fitBoost = baseWidth > 0
      ? (gateBaseWidthPx[lane] * maxLabelWidthRatio) / baseWidth
      : maxLabelBoost;
    const readabilityBoost = base > 0 ? Math.max(1, minLabelPx / (base * scale)) : 1;
    const boost = Math.min(maxLabelBoost, fitBoost, readabilityBoost);
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
  world.crawl = result.isCorrect ? ROAD_MOTION.crawlCorrect : ROAD_MOTION.crawlWrong;

  gateEls.forEach((gate) => {
    if (gate.dataset.category === result.correctCategory) gate.classList.add('is-correct');
  });
  const chosenGate = gateEls[result.selectedLane];
  if (chosenGate && !result.isCorrect) chosenGate.classList.add('is-wrong');
  answerChoiceEls.forEach((choice) => {
    if (choice.dataset.category === result.correctCategory) choice.classList.add('is-correct');
  });
  const chosenAnswer = answerChoiceEls[result.selectedLane];
  if (chosenAnswer && !result.isCorrect) chosenAnswer.classList.add('is-wrong');
  dom.player.classList.toggle('player-correct', result.isCorrect);
  dom.player.classList.toggle('player-wrong', !result.isCorrect);

  dom.feedback.classList.remove('hidden', 'feedback-correct', 'feedback-wrong');
  dom.feedback.classList.add(result.isCorrect ? 'feedback-correct' : 'feedback-wrong');
  dom.screenGame.classList.add('is-feedback');
  dom.feedbackTitle.textContent = result.isCorrect ? 'Correct!' : 'Not quite';

  // Rebuild from the exact source blank so the highlight always marks the
  // inserted answer, never an earlier matching substring such as the "a" in
  // "saw" or the "an" in "wants".
  dom.feedbackSentence.replaceChildren();
  if (result.correctArticle) {
    const parts = currentQuestionSentence.split('___');
    if (parts.length !== 2) {
      dom.feedbackSentence.textContent = result.completedSentence;
    } else {
      dom.feedbackSentence.append(document.createTextNode(parts[0]));
      const filled = document.createElement('span');
      filled.className = 'filled';
      filled.textContent = result.correctArticle;
      dom.feedbackSentence.append(filled, document.createTextNode(parts[1]));
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
      const unlocked =
        selectedMode === GAME_MODES.ARCADE || progress.unlockedLevels.includes(level.id);
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

let startGamePending = false;

async function startGame(levelId) {
  if (startGamePending) return;
  startGamePending = true;
  try {
    // Local assets normally decode during the start screen. Awaiting here is
    // the last guard against a blank/flickering first stride on slow devices.
    await runFramesReady;
    engine.startLevel(levelId, { mode: selectedMode });
  } catch (error) {
    logError('startLevel', error);
    showStartNote(error.message);
  } finally {
    startGamePending = false;
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

  // Dock choices are lane controls only; answer scoring remains engine-timed.
  for (const choice of answerChoiceEls) {
    choice.addEventListener('click', () => {
      movePlayerToLane(Number(choice.dataset.lane));
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

  // Respect live OS/browser preference changes without reloading the game.
  if (reducedMotionQuery?.addEventListener) {
    reducedMotionQuery.addEventListener('change', handleReducedMotionChange);
  } else if (reducedMotionQuery?.addListener) {
    reducedMotionQuery.addListener(handleReducedMotionChange);
  }

  // -- responsive geometry: normalized road phases survive every resize;
  //    only their projection and intrinsic sizes are recalculated. --
  buildRoadWorld(); // pooled road objects exist before the first level
  rebuildWorldGeometry(); // no-op while the game screen is hidden
  gateLabelBaseStale = true; // re-measured on the next visible frame
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
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
  renderLevelList();
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
  const focusedAnswer = event.target.closest?.('.answer-dock__choice');
  if (focusedAnswer && (event.key === ' ' || event.key === 'Enter')) {
    if (state === GAME_STATES.PLAYING) {
      event.preventDefault();
      movePlayerToLane(Number(focusedAnswer.dataset.lane));
    }
    return;
  }
  let handled = true;

  switch (event.key) {
    case 'ArrowLeft':
    case 'a':
    case 'A':
      if (state === GAME_STATES.PLAYING) {
        safeEngineCall(() => engine.moveLeft());
        if (focusedAnswer) {
          answerChoiceEls[engine.getSnapshot().playerLane]?.focus({ preventScroll: true });
        }
      }
      break;
    case 'ArrowRight':
    case 'd':
    case 'D':
      if (state === GAME_STATES.PLAYING) {
        safeEngineCall(() => engine.moveRight());
        if (focusedAnswer) {
          answerChoiceEls[engine.getSnapshot().playerLane]?.focus({ preventScroll: true });
        }
      }
      break;
    case '1':
    case '2':
    case '3':
      if (state === GAME_STATES.PLAYING) {
        const lane = Number(event.key) - 1;
        movePlayerToLane(lane);
        if (focusedAnswer) answerChoiceEls[lane]?.focus({ preventScroll: true });
      }
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

/** Single lane-position mapping (values live in CSS on .runner). */
const PLAYER_LANE_POSITIONS = ['var(--lane-x-0)', 'var(--lane-x-1)', 'var(--lane-x-2)'];

const reducedMotionQuery =
  typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : null;
let prefersReducedMotion = reducedMotionQuery?.matches ?? false;

let runFrameIndex = 0;
let runFrameAccumulator = 0;
let runFramesReady = Promise.resolve(false);
/** Keep decoded Image instances alive so swaps always hit decoded cache. */
let decodedRunImages = [];
/** Never cycle a partial gait: eight decoded phases or one planted fallback. */
let runtimeRunFrames = [{ ...RUN_PHASES[STABLE_RUN_FRAME_INDEX] }];

/**
 * Preload and decode every frame before gameplay so the first run never
 * flickers. Each WebP may fall back to its PNG master, but the game never
 * cycles an incomplete sequence: one missing phase selects a stable pose.
 */
// Eight high-resolution frames can take several seconds to decode together on
// a cold mobile cache. Keep a finite escape hatch for broken assets without
// discarding a valid run cycle on its first load.
const RUN_FRAME_PRELOAD_TIMEOUT_MS = 15000;

function loadDecodedImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    let settled = false;
    let timeoutId = null;

    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      if (timeoutId !== null) clearTimeout(timeoutId);
      img.onload = null;
      img.onerror = null;
      callback(value);
    };

    img.onload = async () => {
      try {
        if (typeof img.decode === 'function') await img.decode();
        if (img.naturalWidth <= 0) throw new Error(`Zero-width image: ${src}`);
        settle(resolve, img);
      } catch (error) {
        settle(reject, error);
      }
    };
    img.onerror = () => settle(reject, new Error(`Could not load ${src}`));
    timeoutId = setTimeout(() => {
      settle(reject, new Error(`Timed out decoding ${src}`));
      // Abort a candidate that is still pending before trying its fallback.
      img.src = '';
    }, RUN_FRAME_PRELOAD_TIMEOUT_MS);
    img.src = src;
  });
}

async function preloadOneFrame(frame) {
  for (const src of [frame.src, frame.fallbackSrc]) {
    try {
      const image = await loadDecodedImage(src);
      return { frame: { ...frame, src }, image };
    } catch (error) {
      if (DEBUG) console.warn(`[game] run frame candidate failed: ${src}`, error);
    }
  }
  return null;
}

async function preloadRunFrames() {
  const results = await Promise.all(RUN_PHASES.map(preloadOneFrame));
  const complete = results.every(Boolean);
  decodedRunImages = results.filter(Boolean).map((result) => result.image);

  if (complete) {
    runtimeRunFrames = results.map((result) => result.frame);
  } else {
    const stableResult = results[STABLE_RUN_FRAME_INDEX] ?? results.find(Boolean);
    runtimeRunFrames = stableResult
      ? [stableResult.frame]
      : [{ ...RUN_PHASES[STABLE_RUN_FRAME_INDEX] }];
    const missing = RUN_PHASES.filter((_, index) => !results[index]).map((frame) => frame.src);
    console.error('[game] incomplete fox run cycle; using a stable pose:', missing);
  }
  showStablePlayerPose();
  return complete;
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
  if (!prefersReducedMotion && runtimeRunFrames.length === RUN_PHASES.length) {
    return runtimeRunFrames;
  }
  const stable = runtimeRunFrames.find(
    (frame) => frame.id === RUN_PHASES[STABLE_RUN_FRAME_INDEX].id,
  );
  return [stable ?? runtimeRunFrames[0] ?? RUN_PHASES[STABLE_RUN_FRAME_INDEX]];
}

function activeFrameDuration() {
  return runFrameDurationForSpeed(
    world.speed,
    ROAD_LAYOUTS.desktop.worldSpeed,
    ROAD_LAYOUTS.mobile.worldSpeed,
  );
}

function paintRunFrame(frame, sourceIndex) {
  if (!frame) return;
  dom.player.style.setProperty('--shadow-scale', String(frame.shadowScale));
  dom.player.style.setProperty('--shadow-opacity', String(frame.shadowOpacity));
  dom.player.style.setProperty('--shadow-blur', `${frame.shadowBlurPx}px`);
  dom.player.dataset.runFrame = String(sourceIndex + 1);
  dom.player.dataset.runPhase = frame.id;
  if (!dom.playerImg.src.endsWith(frame.src)) dom.playerImg.src = frame.src;
}

function applyRunFrame(index) {
  const frames = activeRunFrames();
  const frame = frames[index];
  if (!frame) return;
  const sourceIndex = RUN_PHASES.findIndex((phase) => phase.id === frame.id);
  paintRunFrame(frame, Math.max(0, sourceIndex));
}

function updatePlayerAnimation(deltaMs) {
  const frames = activeRunFrames();
  if (frames.length < 2) {
    applyRunFrame(0);
    return;
  }
  const next = advanceRunClock(
    { index: runFrameIndex, accumulator: runFrameAccumulator },
    deltaMs,
    activeFrameDuration(),
    frames.length,
  );
  runFrameIndex = next.index;
  runFrameAccumulator = next.accumulator;
  applyRunFrame(runFrameIndex);
}

/** Back to the first push-off only for a genuinely new/restarted level. */
function resetPlayerAnimation() {
  runFrameIndex = 0;
  runFrameAccumulator = 0;
  applyRunFrame(0);
}

function showStablePlayerPose() {
  const stable = runtimeRunFrames.find(
    (frame) => frame.id === RUN_PHASES[STABLE_RUN_FRAME_INDEX].id,
  ) ?? runtimeRunFrames[0] ?? RUN_PHASES[STABLE_RUN_FRAME_INDEX];
  runFrameIndex = Math.max(0, runtimeRunFrames.indexOf(stable));
  runFrameAccumulator = 0;
  const sourceIndex = RUN_PHASES.findIndex((phase) => phase.id === stable.id);
  paintRunFrame(stable, sourceIndex >= 0 ? sourceIndex : STABLE_RUN_FRAME_INDEX);
}

function handleReducedMotionChange(event) {
  prefersReducedMotion = event.matches;
  const layout = ROAD_LAYOUTS[world.layoutName] ?? ROAD_LAYOUTS.desktop;
  world.baseSpeed = layout.worldSpeed * (prefersReducedMotion ? ROAD_MOTION.reducedFactor : 1);
  world.speed = world.baseSpeed;
  runFrameAccumulator = 0;
  if (prefersReducedMotion) {
    showStablePlayerPose();
    settleCoinEffectsForReducedMotion();
  }
  else applyRunFrame(runFrameIndex % Math.max(1, runtimeRunFrames.length));
}

/* ========================================================================
 * 15. Animation loop (single driver; the engine owns timing & collision)
 * ====================================================================== */

function startLoop() {
  if (rafId !== null) return;
  lastFrameTime = null;
  rafId = requestAnimationFrame(loop);
}

function stopLoop() {
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
}

function loop(now) {
  rafId = requestAnimationFrame(loop);
  const deltaMs = lastFrameTime === null ? 0 : now - lastFrameTime;
  lastFrameTime = now;

  try {
    if (!engine) return;

    const visualDeltaMs = Math.min(deltaMs, ROAD_MOTION.maxDeltaMs);
    if (engine.state === GAME_STATES.PLAYING) {
      engine.update(deltaMs); // engine clamps huge deltas (tab switches) itself
      // update() can auto-resolve the question (PLAYING → FEEDBACK) and the
      // engine resets its progress — re-check before adopting the value, or
      // the gates would flash back to the horizon on timed resolutions.
      if (engine.state === GAME_STATES.PLAYING) {
        gateVisualProgress = engine.gateProgress;
      } else if (engine.state === GAME_STATES.FEEDBACK) {
        gateVisualProgress = 1;
        world.gate.depth = world.playerDepth;
      }
    }
    const state = engine.state;

    if (currentScreen === 'game') {
      // Delta is clamped so a background tab can never teleport the road.
      const dt = visualDeltaMs / 1000;

      // Gate pass-through first: it owns the feedback clock (feedbackT).
      updateGateVisual(dt, state);

      // One eased rate drives markers, details, texture, dust, coins and the
      // fox gait. PAUSED returns zero without changing the stored rate.
      const rate = updateRoadMotionRate(dt, state);
      if (state === GAME_STATES.PLAYING) {
        updatePlayerAnimation(visualDeltaMs * Math.max(rate, 0.2));
      } else if (state === GAME_STATES.FEEDBACK) {
        // The fox keeps trotting through the feedback moment, matched to the
        // slow world crawl. Keep the run clock below normal speed; the separate
        // one-shot reaction wrapper carries the celebratory/hesitation accent.
        const feedbackRunRate = feedbackRunRateForWorldRate(rate);
        updatePlayerAnimation(visualDeltaMs * feedbackRunRate);
      }

      updateWorldMotion(dt, rate, rate);
      updateCoins(visualDeltaMs, dt, rate, state);
      renderGates();
      renderLaneGuides();
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
