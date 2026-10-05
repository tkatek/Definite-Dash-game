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
const CORRECT_RESUME_AUTO_CONTINUE_MS = 600;
const CORRECT_FEEDBACK_MAX_MS = 700;
const FLYING_FOX_SRC = 'assets/characters/fox-flying-back-640.webp';

/* ------------------------------------------------------------------------
 * Audio — an original, procedural Web Audio palette. No sound is requested
 * from the network and no AudioContext is created until a real user gesture.
 * The small synthesized palette keeps first-play latency and memory bounded.
 * ---------------------------------------------------------------------- */

const AUDIO_VOLUME = Object.freeze({
  master: 0.76,
  music: 0.14,
  ambience: 0, // intentionally omitted: the wind bed already supplies space
  wind: 0.055,
  ui: 0.22,
  lane: 0.18,
  gate: 0.32,
  correct: 0.46,
  wrong: 0.32,
  coin: 0.26,
  hint: 0.2,
  pause: 0.22,
  levelComplete: 0.44,
  gameOver: 0.34,
});

const AUDIO_PRIORITY = Object.freeze({ low: 1, medium: 2, high: 3 });
const AUDIO_GATE_APPROACH_PROGRESS = 0.72;
const AUDIO_MAX_TRANSIENT_VOICES = 12;

const AUDIO_CUES = Object.freeze({
  uiClick: Object.freeze({
    volume: AUDIO_VOLUME.ui,
    priority: AUDIO_PRIORITY.medium,
    cooldownMs: 45,
    maxVoices: 2,
  }),
  laneChange: Object.freeze({
    volume: AUDIO_VOLUME.lane,
    priority: AUDIO_PRIORITY.medium,
    cooldownMs: 100,
    maxVoices: 1,
  }),
  gateApproach: Object.freeze({
    volume: AUDIO_VOLUME.gate * 0.62,
    priority: AUDIO_PRIORITY.medium,
    cooldownMs: 400,
    maxVoices: 1,
  }),
  gatePass: Object.freeze({
    volume: AUDIO_VOLUME.gate,
    priority: AUDIO_PRIORITY.high,
    cooldownMs: 250,
    maxVoices: 1,
  }),
  correct: Object.freeze({
    volume: AUDIO_VOLUME.correct,
    priority: AUDIO_PRIORITY.high,
    cooldownMs: 300,
    maxVoices: 1,
  }),
  wrong: Object.freeze({
    volume: AUDIO_VOLUME.wrong,
    priority: AUDIO_PRIORITY.high,
    cooldownMs: 300,
    maxVoices: 1,
  }),
  coin: Object.freeze({
    volume: AUDIO_VOLUME.coin,
    priority: AUDIO_PRIORITY.medium,
    cooldownMs: 45,
    maxVoices: 2,
  }),
  hint: Object.freeze({
    volume: AUDIO_VOLUME.hint,
    priority: AUDIO_PRIORITY.medium,
    cooldownMs: 180,
    maxVoices: 1,
  }),
  pause: Object.freeze({
    volume: AUDIO_VOLUME.pause,
    priority: AUDIO_PRIORITY.medium,
    cooldownMs: 180,
    maxVoices: 1,
  }),
  resume: Object.freeze({
    volume: AUDIO_VOLUME.pause,
    priority: AUDIO_PRIORITY.medium,
    cooldownMs: 180,
    maxVoices: 1,
  }),
  levelComplete: Object.freeze({
    volume: AUDIO_VOLUME.levelComplete,
    priority: AUDIO_PRIORITY.high,
    cooldownMs: 900,
    maxVoices: 1,
  }),
  gameOver: Object.freeze({
    volume: AUDIO_VOLUME.gameOver,
    priority: AUDIO_PRIORITY.high,
    cooldownMs: 900,
    maxVoices: 1,
  }),
});

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
 * fox and road agree. Engine rules and collision thresholds never change.
 */
const RUNNER_GEO = {
  gateFillByCount: Object.freeze({ 2: 0.84, 3: 0.9 }),
  gateSafeInsetRatio: 0.0065,
  // Native gate art is 960×930 px — ≥2.6× the widest projected gate, so it is
  // only ever downscaled. The element itself is sized to the projected width
  // each frame (renderGates); the CSS width mirrors 960px only as a hidden
  // first-paint fallback.
  gateArtAspectRatio: 960 / 930,
  gateMaxWidthPx: 360,
  gateMaxHeightRatioByLayout: Object.freeze({ desktop: 0.35, tablet: 0.34, mobile: 0.33 }),
  gateCollisionLeadDepth: 0.01,
  gateSpawnFadePerSecond: 5,
  gatePassThroughSeconds: 0.16,
  gateExitFadeStartSeconds: 0.1,
  gateExitFadeSeconds: 0.18,
  gateMaxPassDepth: 0.22,
  farOpacity: 0.72,
};

/** Phone portrait presentation only; engine timing and collision rules stay unchanged. */
const PHONE_PORTRAIT_VISUALS = Object.freeze({
  maxWidthPx: 480,
  nearHalfWidth: 0.61,
  playerDepth: 0.73,
  gateFillByCount: Object.freeze({ 2: 0.9, 3: 0.96 }),
  playerGateWidthRatio: 0.66,
});

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
 * projection. Engine progress maps linearly to projected depth during
 * PLAYING, still reaching the collision plane on the exact resolve frame,
 * then fading out at that bounded plane instead of growing past the fox.
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
 *   playerDepth         foreground depth used by the fox
 *
 * Lane centres and gate slots are deliberately absent from this table: both
 * are equal thirds of the road width returned by the projection.
 */
const ROAD_LAYOUTS = {
  desktop: {
    horizonY: 0.425,
    bottomY: 1.015,
    centerX: 0.5,
    farHalfWidth: 0.1,
    nearHalfWidth: 0.36,
    playerDepth: 0.8,
    worldSpeed: 0.5,
    perspectivePower: 1.75,
    gateStartDepth: 0.02,
    roadShoulder: 0.016,
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
    playerDepth: 0.81,
    worldSpeed: 0.52,
    perspectivePower: 1.3,
    gateStartDepth: 0.02,
    roadShoulder: 0.017,
    markerWidthPx: 9,
    markerHeightPx: 72,
    wearW: 0.11,
    grain: 0.24,
  },
  mobile: {
    horizonY: 0.28,
    bottomY: 1.02,
    centerX: 0.5,
    farHalfWidth: 0.18,
    nearHalfWidth: 0.56,
    // Keep the same projected collision plane as the earlier 0.83² layout,
    // while making category art readable much sooner in the approach.
    playerDepth: 0.707,
    worldSpeed: 0.55,
    perspectivePower: 1.1,
    gateStartDepth: 0.02,
    roadShoulder: 0.016,
    markerWidthPx: 7,
    markerHeightPx: 62,
    wearW: 0.1,
    grain: 0.2,
  },
};

/**
 * Road surface finishing — one central place for the "richness" knobs.
 * The wear bands (soft darkening along both road edges, drawn by
 * drawCodedRoad as clipped polygons) and the moving warm dust grain on
 * .road-surface are subtle on purpose: they add
 * depth cues, never clutter. Set grain to 0 for a perfectly flat road.
 */
const ROAD_TEXTURE = {
  /** wear band peak alpha at the road edge, fading to 0 inward. */
  wearAlpha: 0.2,
};

/**
 * Supplied road artwork, sized as a share of one projected lane at the
 * fox plane. Flat art stays subtle; upright clusters are shoulder-only.
 */
const ROAD_DETAIL_ASSETS = Object.freeze({
  dirt: Object.freeze({
    src: 'assets/road-details/road-dirt-patch.png',
    kind: 'flat',
    widthInLanes: 0.62,
    maxWidthPx: 220,
    anchorY: 50,
    rotationDeg: 11,
    alpha: Object.freeze([0.24, 0.34]),
  }),
  pebbles: Object.freeze({
    src: 'assets/road-details/road-pebble-scatter.png',
    kind: 'flat',
    widthInLanes: 0.38,
    maxWidthPx: 132,
    anchorY: 50,
    rotationDeg: 18,
    alpha: Object.freeze([0.42, 0.56]),
  }),
  branch: Object.freeze({
    src: 'assets/road-details/road-branch-debris.png',
    kind: 'raised',
    widthInLanes: 0.48,
    maxWidthPx: 152,
    anchorY: 76,
    rotationDeg: 24,
    alpha: Object.freeze([0.48, 0.62]),
  }),
  splinters: Object.freeze({
    src: 'assets/road-details/road-wood-splinters.png',
    kind: 'raised',
    widthInLanes: 0.44,
    maxWidthPx: 150,
    anchorY: 83,
    rotationDeg: 20,
    alpha: Object.freeze([0.46, 0.6]),
  }),
  rock: Object.freeze({
    src: 'assets/road-details/roadside-rock-cluster.png',
    kind: 'roadside',
    widthInLanes: 0.46,
    maxWidthPx: 122,
    anchorY: 67,
    rotationDeg: 7,
    alpha: Object.freeze([0.52, 0.66]),
  }),
  rockGrass: Object.freeze({
    src: 'assets/road-details/roadside-rock-grass-cluster.png',
    kind: 'roadside',
    widthInLanes: 0.31,
    maxWidthPx: 116,
    anchorY: 79,
    rotationDeg: 6,
    alpha: Object.freeze([0.54, 0.68]),
  }),
});

const ROAD_DETAIL_FAMILIES = Object.freeze({
  surface: Object.freeze(['dirt', 'pebbles']),
  wood: Object.freeze(['branch', 'splinters']),
  roadside: Object.freeze(['rock', 'rockGrass']),
});

/** Eight pooled details per layout retain texture without excess style work. */
const ROAD_DETAIL_DENSITY = Object.freeze({ desktop: 0, tablet: 0, mobile: 0 });
const ROAD_DETAIL_LAYOUT_SCALE = Object.freeze({ desktop: 1, tablet: 0.94, mobile: 0.86 });

/**
 * Hand-seeded spacing prevents a noisy random field. Recycled details keep
 * their family and side, but receive restrained asset/position variation
 * once they have passed below the viewport.
 */
const ROAD_DETAIL_SEEDS = Object.freeze([
  Object.freeze({ asset: 'dirt', family: 'surface', zone: 'edge', side: -1, depth: 0.05, laneOffset: -1.18, rot: -7, size: 0.94, alpha: 0.27, density: 0 }),
  Object.freeze({ asset: 'pebbles', family: 'surface', zone: 'edge', side: 1, depth: 0.18, laneOffset: 1.3, rot: 13, size: 0.9, alpha: 0.48, density: 0 }),
  Object.freeze({ asset: 'rockGrass', family: 'roadside', zone: 'outer', side: -1, depth: 0.24, laneOffset: -1.43, rot: -3, size: 0.9, alpha: 0.6, density: 1 }),
  Object.freeze({ asset: 'branch', family: 'wood', zone: 'edge', side: -1, depth: 0.31, laneOffset: -1.28, rot: -17, size: 0.94, alpha: 0.56, density: 0 }),
  Object.freeze({ asset: 'rockGrass', family: 'roadside', zone: 'outer', side: 1, depth: 0.38, laneOffset: 1.44, rot: 2, size: 0.86, alpha: 0.58, density: 2 }),
  Object.freeze({ asset: 'dirt', family: 'surface', zone: 'mid', side: 1, depth: 0.44, laneOffset: 0.73, rot: 6, size: 0.72, alpha: 0.24, density: 0 }),
  Object.freeze({ asset: 'splinters', family: 'wood', zone: 'edge', side: 1, depth: 0.57, laneOffset: 1.25, rot: 12, size: 0.86, alpha: 0.5, density: 0 }),
  Object.freeze({ asset: 'pebbles', family: 'surface', zone: 'edge', side: -1, depth: 0.7, laneOffset: -1.34, rot: -10, size: 1.02, alpha: 0.5, density: 0 }),
  Object.freeze({ asset: 'splinters', family: 'wood', zone: 'edge', side: -1, depth: 0.76, laneOffset: -1.2, rot: 18, size: 0.78, alpha: 0.48, density: 1 }),
  Object.freeze({ asset: 'rock', family: 'roadside', zone: 'outer', side: 1, depth: 0.83, laneOffset: 1.45, rot: -2, size: 0.92, alpha: 0.6, density: 0 }),
  Object.freeze({ asset: 'pebbles', family: 'surface', zone: 'mid', side: 1, depth: 0.89, laneOffset: 0.78, rot: 16, size: 0.78, alpha: 0.43, density: 2 }),
  Object.freeze({ asset: 'branch', family: 'wood', zone: 'edge', side: 1, depth: 0.96, laneOffset: 1.34, rot: -13, size: 0.82, alpha: 0.52, density: 0 }),
]);

/** Shared approach pacing plus state-specific world-motion tuning. */
const ROAD_MOTION = {
  // Level 1 uses engine speed .075, so 2.777... gives a 4.8 second
  // spawn-to-collision run: 1 / (.075 * 2.777...).
  playingTimeScale: 25 / 9,
  markerMultiplier: 1,
  detailMultiplier: 1,
  // Hold full motion only through the physical gate pass. Feedback then
  // freezes the world so an open card burns no render or decoder work.
  feedbackBurstS: 0.18,
  maxFrameDeltaMs: 100,
  maxEngineStepMs: 100,
  dustEveryMs: 150,
  reducedFactor: 1,
};

/** Run-local challenge ramp. Applied once to the shared PLAYING clock so
 * gates and every moving world layer stay synchronized. */
const SPEED_PROGRESSION = Object.freeze({
  initialMultiplier: 1,
  correctStep: 0.04,
  maxMultiplier: 1.4,
});

/** Native roadside media. The static device background remains authoritative
 * whenever video is unavailable or reduced motion is requested. */
const ROADSIDE_VIDEO_SOURCES = Object.freeze({
  left: 'assets/environment/video/roadside-left-400x900.mp4',
  right: 'assets/environment/video/roadside-right-400x900.mp4',
});

const ROADSIDE_VIDEO_PLAYBACK = Object.freeze({
  minRate: 0.1,
  maxRate: 1.5,
  bufferTimeoutMs: 6000,
  syncToleranceS: 0.08,
});

/** Sparse bonus collectibles. These values intentionally live in one place:
 * coins are a brief surprise between learning decisions, never a road trail. */
const COIN_CONFIG = Object.freeze({
  assetPath: 'assets/ui/coin-star-384.webp',
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

const PRELOAD_ASSETS = Object.freeze({
  critical: Object.freeze([
    Object.freeze({
      id: 'initial-markup-images',
      kind: 'document-images',
      candidates: Object.freeze([]),
    }),
    Object.freeze({
      id: 'loader-fox',
      kind: 'loader',
      candidates: Object.freeze(['assets/ui/loader-fox-768.webp']),
    }),
    ...Object.entries(GATE_VISUALS).map(([category, visual]) => Object.freeze({
      id: `gate-${category}`,
      kind: 'gate',
      candidates: Object.freeze([visual.art]),
    })),
    ...Object.entries(ROAD_DETAIL_ASSETS).map(([key, detail]) => Object.freeze({
      id: `road-detail-${key}`,
      kind: 'road-detail',
      candidates: Object.freeze([detail.src]),
    })),
    Object.freeze({
      id: 'fox-flying-back',
      kind: 'player',
      candidates: Object.freeze([FLYING_FOX_SRC]),
    }),
  ]),
  optional: Object.freeze([
    ...Object.entries(ROADSIDE_VIDEO_SOURCES).map(([side, src]) => Object.freeze({
      id: `roadside-video-${side}`,
      kind: 'roadside-video',
      side,
      candidates: Object.freeze([src]),
      fallbackAllowed: true,
    })),
    Object.freeze({
      id: 'coin-star',
      kind: 'optional',
      candidates: Object.freeze([COIN_CONFIG.assetPath]),
    }),
  ]),
  byLayout: Object.freeze({
    desktop: Object.freeze([
      Object.freeze({
        id: 'scenery-desktop',
        kind: 'scenery',
        candidates: Object.freeze(['assets/backgrounds/road-desktop.webp']),
      }),
    ]),
    tablet: Object.freeze([
      Object.freeze({
        id: 'scenery-tablet',
        kind: 'scenery',
        candidates: Object.freeze(['assets/backgrounds/road-tablet.webp']),
      }),
    ]),
    mobile: Object.freeze([
      Object.freeze({
        id: 'scenery-mobile',
        kind: 'scenery',
        candidates: Object.freeze(['assets/backgrounds/road-mobile-clean-v2.webp']),
      }),
    ]),
  }),
});

const coinSystem = {
  pool: [],
  nextSpawnMs: Number.POSITIVE_INFINITY,
  collected: 0,
  displayed: 0,
  effects: new Set(),
  flights: new Set(),
  hudTargetRect: null,
};

const world = {
  built: false,
  W: 0,
  H: 0,
  runnerLeft: 0,
  runnerRight: 0,
  gameTopBounds: null,
  layoutName: 'desktop',
  isPhonePortrait: false,
  baseSpeed: ROAD_LAYOUTS.desktop.worldSpeed,
  speed: ROAD_LAYOUTS.desktop.worldSpeed,
  effectiveSpeed: 0,
  motionRate: 0,
  feedbackT: 0, // seconds since the gate reached the collision plane
  horizonY: ROAD_LAYOUTS.desktop.horizonY,
  bottomY: ROAD_LAYOUTS.desktop.bottomY,
  centerX: ROAD_LAYOUTS.desktop.centerX,
  farHalfWidth: ROAD_LAYOUTS.desktop.farHalfWidth,
  nearHalfWidth: ROAD_LAYOUTS.desktop.nearHalfWidth,
  playerDepth: ROAD_LAYOUTS.desktop.playerDepth,
  perspectivePower: ROAD_LAYOUTS.desktop.perspectivePower,
  playerHalfWidth:
    ROAD_LAYOUTS.desktop.farHalfWidth +
    (ROAD_LAYOUTS.desktop.nearHalfWidth - ROAD_LAYOUTS.desktop.farHalfWidth) *
      Math.pow(ROAD_LAYOUTS.desktop.playerDepth, ROAD_LAYOUTS.desktop.perspectivePower),
  divAngle: [-7, 7], // straight divider-rail tilt per side (deg)
  markers: [],
  details: [],
  dusts: [],
  dustIdx: 0,
  dustTimer: 0,
  playerLane: 1,
  gate: { depth: 0, passDepth: 0, spawnFade: 0, approachDepthPerSecond: 0 },
};

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

function isPhonePortraitViewport(width, height) {
  return width <= PHONE_PORTRAIT_VISUALS.maxWidthPx && height > width;
}

function lerp(from, to, amount) {
  return from + (to - from) * amount;
}

/**
 * One small, fail-open Web Audio manager. Gameplay never awaits it, and a
 * browser without Web Audio simply gets a silent game. All sources are
 * bounded, short-lived nodes except for one reusable wind loop.
 */
const audioManager = (() => {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  const MUSIC_STEP_SECONDS = 0.5;
  // 64 half-second steps: one original, sparse 32-second D-major loop.
  const MUSIC_MELODY = Object.freeze([
    74, null, 78, null, 81, null, 78, null,
    76, null, 78, null, 83, null, 81, null,
    74, null, 76, null, 78, null, 81, null,
    79, null, 78, null, 76, null, 69, null,
    74, null, 78, null, 81, null, 83, null,
    81, null, 78, null, 76, null, 74, null,
    71, null, 74, null, 79, null, 78, null,
    76, null, 69, null, 73, null, 74, null,
  ]);
  const MUSIC_CHORD_ROOTS = Object.freeze([50, 47, 43, 45, 50, 45, 43, 45]);

  let context = null;
  let masterGain = null;
  let sfxGain = null;
  let backgroundGain = null;
  let duckGain = null;
  let musicGain = null;
  let windGain = null;
  let windFilter = null;
  let windSource = null;
  let noiseBuffer = null;
  let unlockPromise = null;
  let unlocked = false;
  let pageVisible = !document.hidden;
  let backgroundWanted = false;
  let gameplayPaused = false;
  let worldSpeed = 1;
  let musicTimer = null;
  let musicStep = 0;
  let nextMusicTime = 0;
  let lastCoinTimeMs = Number.NEGATIVE_INFINITY;
  const lastPlayedAt = new Map();
  const voices = [];
  const scheduledMusicSources = new Set();

  function midiFrequency(note) {
    return 440 * (2 ** ((note - 69) / 12));
  }

  function safeStop(source, when = context?.currentTime ?? 0) {
    try {
      source.stop(when);
    } catch {
      // An already-ended Web Audio source is harmless.
    }
  }

  function ramp(param, value, seconds, when = context?.currentTime ?? 0) {
    if (!param || !context) return;
    const safeValue = Math.max(0.0001, value);
    param.cancelScheduledValues(when);
    param.setValueAtTime(Math.max(0.0001, param.value), when);
    param.linearRampToValueAtTime(safeValue, when + Math.max(0.001, seconds));
  }

  function createNoiseBuffer() {
    const length = Math.max(1, Math.floor(context.sampleRate * 3));
    const buffer = context.createBuffer(1, length, context.sampleRate);
    const data = buffer.getChannelData(0);
    // Deterministic noise makes the shipped sound stable across every run.
    let seed = 0x2f6e2b1;
    for (let index = 0; index < length; index += 1) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      data[index] = ((seed / 0xffffffff) * 2 - 1) * 0.72;
    }
    // Crossfade the loop seam so the quiet wind never ticks every three seconds.
    const seamLength = Math.min(Math.floor(context.sampleRate * 0.12), length >> 2);
    for (let index = 0; index < seamLength; index += 1) {
      const mix = index / Math.max(1, seamLength - 1);
      const tailIndex = length - seamLength + index;
      data[tailIndex] = lerp(data[tailIndex], data[index], mix);
    }
    return buffer;
  }

  function initializeContext() {
    if (context || !AudioContextClass) return Boolean(context);
    try {
      try {
        context = new AudioContextClass({ latencyHint: 'interactive' });
      } catch {
        // Older WebKit builds support Web Audio but reject constructor options.
        context = new AudioContextClass();
      }
      masterGain = context.createGain();
      sfxGain = context.createGain();
      backgroundGain = context.createGain();
      duckGain = context.createGain();
      musicGain = context.createGain();
      windGain = context.createGain();
      const limiter = context.createDynamicsCompressor();

      masterGain.gain.value = AUDIO_VOLUME.master;
      sfxGain.gain.value = 1;
      backgroundGain.gain.value = 0.0001;
      duckGain.gain.value = 1;
      musicGain.gain.value = AUDIO_VOLUME.music;
      windGain.gain.value = AUDIO_VOLUME.wind;
      limiter.threshold.value = -18;
      limiter.knee.value = 18;
      limiter.ratio.value = 4;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.22;

      sfxGain.connect(masterGain);
      musicGain.connect(duckGain);
      windGain.connect(duckGain);
      duckGain.connect(backgroundGain);
      backgroundGain.connect(masterGain);
      masterGain.connect(limiter);
      limiter.connect(context.destination);
      noiseBuffer = createNoiseBuffer();
      return true;
    } catch (error) {
      context = null;
      if (DEBUG) console.warn('[audio] Web Audio unavailable', error);
      return false;
    }
  }

  function connectWithPan(node, destination, pan = 0) {
    if (typeof context.createStereoPanner !== 'function' || Math.abs(pan) < 0.01) {
      node.connect(destination);
      return;
    }
    const panner = context.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, pan));
    node.connect(panner);
    panner.connect(destination);
  }

  function addTone(
    sources,
    start,
    duration,
    frequency,
    endFrequency,
    volume,
    type = 'sine',
    pan = 0,
    destination = sfxGain,
  ) {
    const oscillator = context.createOscillator();
    const envelope = context.createGain();
    const attack = Math.min(0.012, duration * 0.18);
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(Math.max(20, frequency), start);
    oscillator.frequency.exponentialRampToValueAtTime(
      Math.max(20, endFrequency ?? frequency),
      start + duration,
    );
    envelope.gain.setValueAtTime(0.0001, start);
    envelope.gain.linearRampToValueAtTime(Math.max(0.0001, volume), start + attack);
    envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    oscillator.connect(envelope);
    connectWithPan(envelope, destination, pan);
    oscillator.start(start);
    oscillator.stop(start + duration + 0.025);
    sources.push(oscillator);
  }

  function addNoise(
    sources,
    start,
    duration,
    volume,
    startFrequency,
    endFrequency,
    type = 'bandpass',
    pan = 0,
    destination = sfxGain,
  ) {
    const source = context.createBufferSource();
    const filter = context.createBiquadFilter();
    const envelope = context.createGain();
    source.buffer = noiseBuffer;
    filter.type = type;
    filter.Q.value = type === 'bandpass' ? 0.75 : 0.35;
    filter.frequency.setValueAtTime(Math.max(80, startFrequency), start);
    filter.frequency.exponentialRampToValueAtTime(
      Math.max(80, endFrequency),
      start + duration,
    );
    envelope.gain.setValueAtTime(0.0001, start);
    envelope.gain.linearRampToValueAtTime(Math.max(0.0001, volume), start + 0.012);
    envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    source.connect(filter);
    filter.connect(envelope);
    connectWithPan(envelope, destination, pan);
    source.start(start, (start * 0.731) % Math.max(0.1, noiseBuffer.duration - duration));
    source.stop(start + duration + 0.025);
    sources.push(source);
  }

  function removeVoice(voice) {
    const index = voices.indexOf(voice);
    if (index >= 0) voices.splice(index, 1);
    if (voice.cleanupTimer !== null) window.clearTimeout(voice.cleanupTimer);
    voice.cleanupTimer = null;
  }

  function stopVoice(voice) {
    voice.sources.forEach((source) => safeStop(source));
    removeVoice(voice);
  }

  function pruneVoices() {
    if (!context) return;
    for (const voice of [...voices]) {
      if (voice.endTime <= context.currentTime) removeVoice(voice);
    }
  }

  function reserveVoice(name, cue) {
    pruneVoices();
    if (voices.filter((voice) => voice.name === name).length >= cue.maxVoices) return null;
    if (voices.length >= AUDIO_MAX_TRANSIENT_VOICES) {
      const victim = [...voices].sort((left, right) =>
        left.priority - right.priority || left.startedAt - right.startedAt
      )[0];
      if (!victim || victim.priority > cue.priority) return null;
      stopVoice(victim);
    }
    const voice = {
      name,
      priority: cue.priority,
      startedAt: performance.now(),
      endTime: context.currentTime,
      sources: [],
      cleanupTimer: null,
    };
    voices.push(voice);
    return voice;
  }

  function duckBackground() {
    if (!context || !duckGain) return;
    const now = context.currentTime;
    duckGain.gain.cancelScheduledValues(now);
    duckGain.gain.setValueAtTime(Math.max(0.0001, duckGain.gain.value), now);
    duckGain.gain.linearRampToValueAtTime(0.84, now + 0.025);
    duckGain.gain.setTargetAtTime(1, now + 0.14, 0.24);
  }

  function buildCue(name, cue, options, voice) {
    const delay = Math.max(0, Number(options.delay) || 0);
    const start = context.currentTime + delay;
    const sources = voice.sources;
    const volume = cue.volume;
    let duration = 0.2;

    switch (name) {
      case 'uiClick':
        duration = 0.075;
        addTone(sources, start, 0.065, 520, 390, volume, 'triangle');
        break;
      case 'laneChange': {
        duration = 0.15;
        const pan = Math.sign(options.direction || 0) * 0.42;
        addNoise(sources, start, 0.14, volume, 1850, 720, 'bandpass', pan);
        addTone(sources, start + 0.012, 0.1, 310, 240, volume * 0.16, 'sine', pan);
        break;
      }
      case 'gateApproach':
        duration = 0.23;
        addNoise(sources, start, 0.22, volume, 620, 1480, 'bandpass');
        addTone(sources, start + 0.06, 0.14, 330, 415, volume * 0.18, 'sine');
        break;
      case 'gatePass':
        duration = 0.29;
        addNoise(sources, start, 0.25, volume * 0.9, 2050, 610, 'bandpass');
        addTone(sources, start + 0.075, 0.16, 880, 1180, volume * 0.24, 'sine');
        addTone(sources, start + 0.13, 0.13, 1320, 1510, volume * 0.16, 'sine');
        break;
      case 'correct': {
        duration = 0.56;
        const notes = [523.25, 659.25, 783.99];
        notes.forEach((frequency, index) => {
          addTone(
            sources,
            start + index * 0.11,
            0.25 + index * 0.035,
            frequency,
            frequency * 1.008,
            volume * (0.66 - index * 0.05),
            index === 2 ? 'sine' : 'triangle',
          );
        });
        break;
      }
      case 'wrong':
        duration = 0.43;
        addTone(sources, start, 0.26, 392, 349.23, volume * 0.7, 'triangle');
        addTone(sources, start + 0.15, 0.27, 329.63, 293.66, volume * 0.62, 'sine');
        break;
      case 'coin': {
        duration = 0.2;
        const nowMs = performance.now();
        const lift = nowMs - lastCoinTimeMs < 480 ? 1.08 : 1;
        lastCoinTimeMs = nowMs;
        addTone(sources, start, 0.14, 987.77 * lift, 1050 * lift, volume * 0.82, 'sine');
        addTone(sources, start + 0.055, 0.13, 1318.51 * lift, 1390 * lift, volume * 0.52, 'sine');
        break;
      }
      case 'hint':
        duration = 0.23;
        addTone(sources, start, 0.16, 783.99, 880, volume * 0.62, 'sine');
        addTone(sources, start + 0.065, 0.15, 1046.5, 1174.66, volume * 0.48, 'sine');
        break;
      case 'pause':
        duration = 0.23;
        addTone(sources, start, 0.19, 440, 329.63, volume * 0.72, 'sine');
        addTone(sources, start + 0.05, 0.16, 329.63, 293.66, volume * 0.42, 'triangle');
        break;
      case 'resume':
        duration = 0.23;
        addTone(sources, start, 0.17, 293.66, 369.99, volume * 0.58, 'triangle');
        addTone(sources, start + 0.065, 0.16, 369.99, 440, volume * 0.64, 'sine');
        break;
      case 'levelComplete': {
        duration = 1.42;
        const phrase = [523.25, 659.25, 783.99, 1046.5, 987.77, 1046.5];
        const offsets = [0, 0.18, 0.36, 0.58, 0.84, 1.04];
        phrase.forEach((frequency, index) => {
          addTone(
            sources,
            start + offsets[index],
            index === phrase.length - 1 ? 0.36 : 0.24,
            frequency,
            frequency * 1.004,
            volume * (index === phrase.length - 1 ? 0.68 : 0.48),
            index % 2 === 0 ? 'triangle' : 'sine',
          );
        });
        break;
      }
      case 'gameOver':
        duration = 1.02;
        [440, 392, 329.63, 261.63].forEach((frequency, index) => {
          addTone(
            sources,
            start + index * 0.2,
            index === 3 ? 0.38 : 0.25,
            frequency,
            frequency * 0.992,
            volume * (0.5 - index * 0.045),
            index < 2 ? 'triangle' : 'sine',
          );
        });
        break;
      default:
        return false;
    }

    voice.endTime = start + duration + 0.05;
    voice.cleanupTimer = window.setTimeout(
      () => removeVoice(voice),
      Math.ceil((delay + duration + 0.25) * 1000),
    );
    return true;
  }

  function play(name, options = {}) {
    const cue = AUDIO_CUES[name];
    if (!cue || !unlocked || !context || context.state !== 'running' || !pageVisible) {
      return false;
    }
    const nowMs = performance.now();
    if (nowMs - (lastPlayedAt.get(name) ?? Number.NEGATIVE_INFINITY) < cue.cooldownMs) {
      return false;
    }
    const voice = reserveVoice(name, cue);
    if (!voice) return false;
    if (!buildCue(name, cue, options, voice)) {
      removeVoice(voice);
      return false;
    }
    lastPlayedAt.set(name, nowMs);
    if (cue.priority === AUDIO_PRIORITY.high) duckBackground();
    return true;
  }

  function ensureWind() {
    if (!context || !noiseBuffer || windSource) return;
    windSource = context.createBufferSource();
    windFilter = context.createBiquadFilter();
    windSource.buffer = noiseBuffer;
    windSource.loop = true;
    windFilter.type = 'lowpass';
    windFilter.Q.value = 0.22;
    windFilter.frequency.value = 680;
    windSource.connect(windFilter);
    windFilter.connect(windGain);
    windSource.start();
  }

  function addMusicPluck(start, note) {
    const sources = [];
    const frequency = midiFrequency(note);
    addTone(sources, start, 0.34, frequency, frequency * 1.003, 0.1, 'triangle', 0, musicGain);
    trackMusicSources(sources);
  }

  function addMusicPad(start, root) {
    const sources = [];
    [root, root + 7].forEach((note, index) => {
      addTone(
        sources,
        start,
        3.75,
        midiFrequency(note),
        midiFrequency(note) * 1.002,
        index === 0 ? 0.035 : 0.024,
        'sine',
        index === 0 ? -0.18 : 0.18,
        musicGain,
      );
    });
    trackMusicSources(sources);
  }

  function addMusicPercussion(start) {
    const sources = [];
    addNoise(sources, start, 0.055, 0.025, 2400, 1450, 'highpass', 0, musicGain);
    trackMusicSources(sources);
  }

  function trackMusicSources(sources) {
    for (const source of sources) {
      scheduledMusicSources.add(source);
      source.addEventListener('ended', () => scheduledMusicSources.delete(source), { once: true });
    }
  }

  function scheduleMusicStep(step, start) {
    const note = MUSIC_MELODY[step];
    if (note !== null) addMusicPluck(start, note);
    if (step % 8 === 0) addMusicPad(start, MUSIC_CHORD_ROOTS[(step / 8) % 8]);
    if (step % 4 === 2) addMusicPercussion(start);
  }

  function scheduleMusicAhead() {
    if (!context || context.state !== 'running') return;
    const now = context.currentTime;
    const horizon = now + 0.65;
    if (!Number.isFinite(nextMusicTime) || nextMusicTime < now - 0.05) {
      const skippedSteps = Math.max(1, Math.ceil((now - nextMusicTime) / MUSIC_STEP_SECONDS));
      musicStep = (musicStep + skippedSteps) % MUSIC_MELODY.length;
      nextMusicTime = now + 0.075;
    }
    const maxStepsPerTick = Math.ceil(0.65 / MUSIC_STEP_SECONDS) + 1;
    let scheduledSteps = 0;
    while (nextMusicTime < horizon && scheduledSteps < maxStepsPerTick) {
      scheduleMusicStep(musicStep, nextMusicTime);
      musicStep = (musicStep + 1) % MUSIC_MELODY.length;
      nextMusicTime += MUSIC_STEP_SECONDS;
      scheduledSteps += 1;
    }
  }

  function startMusicScheduler() {
    if (!context || context.state !== 'running' || musicTimer !== null) return;
    nextMusicTime = Math.max(context.currentTime + 0.075, nextMusicTime);
    scheduleMusicAhead();
    musicTimer = window.setInterval(scheduleMusicAhead, 220);
  }

  function stopMusicScheduler(stopDelay = 0.16) {
    if (musicTimer !== null) window.clearInterval(musicTimer);
    musicTimer = null;
    nextMusicTime = 0;
    const stopAt = (context?.currentTime ?? 0) + Math.max(0, stopDelay);
    for (const source of scheduledMusicSources) safeStop(source, stopAt);
  }

  function syncBackground() {
    if (!context || !unlocked) return;
    const active = backgroundWanted && !gameplayPaused && pageVisible;
    if (active) {
      ensureWind();
      startMusicScheduler();
      ramp(backgroundGain.gain, 1, 0.32);
    } else {
      ramp(backgroundGain.gain, 0.0001, 0.13);
      stopMusicScheduler();
    }
  }

  function setWorldSpeed(multiplier) {
    worldSpeed = Math.max(1, Math.min(SPEED_PROGRESSION.maxMultiplier, multiplier || 1));
    if (!context || !windGain || !windFilter) return;
    const normalized = (worldSpeed - 1) / Math.max(0.001, SPEED_PROGRESSION.maxMultiplier - 1);
    ramp(windGain.gain, AUDIO_VOLUME.wind * lerp(1, 1.26, normalized), 0.28);
    ramp(windFilter.frequency, lerp(680, 790, normalized), 0.32);
  }

  function stopAllSfx({ preserve = [] } = {}) {
    const keep = new Set(preserve);
    for (const voice of [...voices]) {
      if (!keep.has(voice.name)) stopVoice(voice);
    }
  }

  function resetForRun() {
    stopAllSfx({ preserve: ['uiClick'] });
    lastCoinTimeMs = Number.NEGATIVE_INFINITY;
    // The continuous bed is intentionally not restarted here. Keeping the
    // one scheduler preserves a seamless loop and guarantees no duplicate.
    syncBackground();
  }

  async function unlock() {
    if (unlocked && context?.state === 'running') {
      syncBackground();
      return true;
    }
    if (unlockPromise) return unlockPromise;
    unlockPromise = (async () => {
      if (!initializeContext()) return false;
      try {
        if (context.state !== 'running' && context.state !== 'closed') {
          await context.resume();
        }
        // A one-frame silent source completes iOS/Safari's media unlock path.
        const silent = context.createBufferSource();
        silent.buffer = context.createBuffer(1, 1, context.sampleRate);
        silent.connect(masterGain);
        silent.start();
        unlocked = context.state === 'running';
        if (unlocked) {
          ensureWind();
          setWorldSpeed(worldSpeed);
          syncBackground();
        }
        return unlocked;
      } catch (error) {
        if (DEBUG) console.warn('[audio] unlock failed', error);
        return false;
      }
    })().finally(() => {
      unlockPromise = null;
    });
    return unlockPromise;
  }

  function startMusic() {
    backgroundWanted = true;
    syncBackground();
  }

  function stopMusic() {
    backgroundWanted = false;
    syncBackground();
  }

  function pauseAll() {
    gameplayPaused = true;
    syncBackground();
  }

  function resumeAll() {
    gameplayPaused = false;
    if (
      unlocked &&
      context &&
      context.state !== 'running' &&
      context.state !== 'closed' &&
      pageVisible
    ) {
      void context.resume().then(syncBackground).catch(() => {});
    } else {
      syncBackground();
    }
  }

  function setPageVisible(visible) {
    pageVisible = Boolean(visible);
    if (!pageVisible) {
      stopMusicScheduler(0);
      stopAllSfx();
      if (context && context.state === 'running') {
        const suspendingContext = context;
        void suspendingContext.suspend().then(async () => {
          // A rapid hide/show can complete this older suspend after the
          // visible handler already ran. Reconcile against the latest state.
          if (!pageVisible || context !== suspendingContext || !unlocked) return;
          stopMusicScheduler(0);
          if (suspendingContext.state !== 'running' && suspendingContext.state !== 'closed') {
            await suspendingContext.resume();
          }
          if (pageVisible && context === suspendingContext) syncBackground();
        }).catch(() => {});
      }
      return;
    }
    if (
      unlocked &&
      context &&
      context.state !== 'running' &&
      context.state !== 'closed'
    ) {
      void context.resume().then(syncBackground).catch(() => {});
    } else {
      syncBackground();
    }
  }

  function destroy() {
    backgroundWanted = false;
    stopMusicScheduler();
    stopAllSfx();
    if (windSource) safeStop(windSource);
    windSource = null;
    windFilter = null;
    unlocked = false;
    if (context && context.state !== 'closed') void context.close().catch(() => {});
    context = null;
  }

  return Object.freeze({
    unlock,
    play,
    startMusic,
    stopMusic,
    pauseAll,
    resumeAll,
    setWorldSpeed,
    setPageVisible,
    resetForRun,
    stopAllSfx,
    destroy,
  });
})();

/** The single browser-autoplay entry point used by pointer and keyboard input. */
function unlockAudio() {
  return audioManager.unlock();
}

/**
 * THE single perspective helper: normalized depth + continuous lane →
 * screen point. Lane offsets −1/0/+1 are the centres of three equal road
 * slots and ±0.5 are their dividers. Scale is normalized to exactly 1 at
 * the fox's playerDepth.
 */
function writeProjectedRoadPoint(target, depth, laneOffset = 0) {
  const safeDepth = Math.max(0, depth);
  const t = Math.pow(safeDepth, world.perspectivePower);
  const roadHalfWidth = lerp(world.farHalfWidth, world.nearHalfWidth, t);
  const laneSpacing = (roadHalfWidth * 2) / 3;
  target.x = world.centerX + laneOffset * laneSpacing;
  target.y = lerp(world.horizonY, world.bottomY, t);
  target.roadHalfWidth = roadHalfWidth;
  target.laneSpacing = laneSpacing;
  target.scale = roadHalfWidth / world.playerHalfWidth;
  target.t = t;
  target.depth = safeDepth;
  return target;
}

function projectRoadPoint(depth, laneOffset = 0) {
  return writeProjectedRoadPoint({}, depth, laneOffset);
}

/** Project one of the three answer lanes through the shared road geometry. */
function projectLanePoint(depth, laneIndex) {
  return projectRoadPoint(depth, laneIndex - 1);
}

function gateCollisionDepth() {
  return Math.max(0, world.playerDepth - RUNNER_GEO.gateCollisionLeadDepth);
}

function gateRenderDepth() {
  return world.gate.depth + world.gate.passDepth;
}

/**
 * The authoritative gate geometry. Full artwork bounds, including posts and
 * stone bases, fit inside equal road slots after a small edge safety inset.
 */
function writeGateLayoutAtDepth(target, depth, requestedCount) {
  const gateCount = Math.max(1, Math.floor(requestedCount) || 3);
  const point = writeProjectedRoadPoint(target.point, depth, 0);
  const roadWidth = point.roadHalfWidth * 2 * world.W;
  const roadLeft = point.x * world.W - roadWidth / 2;
  const roadRight = roadLeft + roadWidth;
  const safeInset = roadWidth * RUNNER_GEO.gateSafeInsetRatio;
  const slotWidth = roadWidth / gateCount;
  const fillByCount = world.isPhonePortrait
    ? PHONE_PORTRAIT_VISUALS.gateFillByCount
    : RUNNER_GEO.gateFillByCount;
  const fill = fillByCount[gateCount] ?? fillByCount[3] ?? RUNNER_GEO.gateFillByCount[3];
  const maxHeightRatio = RUNNER_GEO.gateMaxHeightRatioByLayout[world.layoutName] ?? 0.35;
  const maxWidthFromHeight = world.H * maxHeightRatio * RUNNER_GEO.gateArtAspectRatio;
  const maxWidthInsideRoad = Math.max(0, slotWidth - safeInset * 2);
  const gateWidth = Math.min(
    slotWidth * fill,
    maxWidthInsideRoad,
    RUNNER_GEO.gateMaxWidthPx,
    maxWidthFromHeight,
  );
  target.roadLeft = roadLeft;
  target.roadRight = roadRight;
  target.roadWidth = roadWidth;
  target.safeInset = safeInset;
  target.slotWidth = slotWidth;
  target.gateWidth = gateWidth;
  return target;
}

function getGateLayoutAtDepth(depth, requestedCount) {
  return writeGateLayoutAtDepth({ point: {} }, depth, requestedCount);
}

function gateCenterX(geometry, lane) {
  return geometry.roadLeft + geometry.slotWidth * (lane + 0.5);
}

const dom = {
  loader: document.getElementById('game-loader'),
  loaderImage: document.getElementById('game-loader-image'),
  loaderTitle: document.getElementById('game-loader-title'),
  loaderMessage: document.getElementById('game-loader-message'),
  loaderProgress: document.getElementById('game-loader-progress'),
  loaderProgressFill: document.getElementById('game-loader-progress-fill'),
  loaderPercent: document.getElementById('game-loader-percent'),
  loaderRetry: document.getElementById('game-loader-retry'),
  app: document.getElementById('app'),
  // error screen
  screenError: document.getElementById('screen-error'),
  errorMessage: document.getElementById('error-message'),
  btnErrorReload: document.getElementById('btn-error-reload'),
  // start screen
  screenStart: document.getElementById('screen-start'),
  startHero: document.querySelector('#screen-start .hero'),
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
  hudCoinIcon: document.querySelector('#hud-score-pill .hud-icon--coin'),
  hudStreak: document.getElementById('hud-streak'),
  hudStreakPill: document.getElementById('hud-streak-pill'),
  hudLives: document.getElementById('hud-lives'),
  btnPause: document.getElementById('btn-pause'),
  sentence: document.getElementById('sentence'),
  answerDock: document.getElementById('answer-dock'),
  runner: document.getElementById('runner'),
  gameTop: document.querySelector('.game-top'),
  scene: document.querySelector('.scene'),
  roadsideWorld: document.getElementById('roadside-world'),
  roadsideVideoLeft: document.getElementById('roadside-video-left'),
  roadsideVideoRight: document.getElementById('roadside-video-right'),
  gatesRoot: document.getElementById('gates'),
  player: document.getElementById('player'),
  playerLean: document.getElementById('player-lean'),
  playerFrame: document.querySelector('.player-frame'),
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
  gameOverTitle: document.getElementById('gameover-title'),
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
const roadsideVideos = Object.freeze({
  left: dom.roadsideVideoLeft,
  right: dom.roadsideVideoRight,
});

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
let speedMultiplier = SPEED_PROGRESSION.initialMultiplier;
let speedIncreaseQueued = false;
let rafId = null;
let lastFrameTime = null;
let fatalHandled = false;
let devBarLastUpdate = 0;
let feedbackAutoContinueTimer = null;
let feedbackAutoContinueDueAt = null;
let feedbackAutoContinueRemainingMs = null;
let activeFeedbackIsCorrect = null;
let activeLaneMap = [];
let decisionFocusActive = false;
const audioEventState = {
  gateApproachPlayed: false,
  gatePassPlayed: false,
  feedbackPlayed: false,
};
const roadsideVideoState = {
  ready: new Set(),
  failed: new Set(),
  lockedFallback: new Set(),
  autoplayBlocked: new Set(),
  playRequests: new WeakMap(),
  lastRate: null,
  ratePhase: null,
  gestureRetryInstalled: false,
};

function resetQuestionAudioState() {
  audioEventState.gateApproachPlayed = false;
  audioEventState.gatePassPlayed = false;
  audioEventState.feedbackPlayed = false;
}

function playAnswerFeedbackAudio(name) {
  if (!audioEventState.gatePassPlayed) {
    audioEventState.gatePassPlayed = true;
    audioManager.play('gatePass');
  }
  // Terminal answers can move directly to a completion screen. The physical
  // pass remains audible, while the terminal cue replaces answer feedback.
  if (engine?.state !== GAME_STATES.FEEDBACK || audioEventState.feedbackPlayed) return;
  audioEventState.feedbackPlayed = true;
  audioManager.play(name, { delay: 0.065 });
}

function currentGameplayRate() {
  return ROAD_MOTION.playingTimeScale * speedMultiplier;
}

function advanceEngineByScaledTime(totalDeltaMs) {
  let remainingMs = Math.max(0, totalDeltaMs);
  while (remainingMs > 0 && engine?.state === GAME_STATES.PLAYING) {
    const stepMs = Math.min(ROAD_MOTION.maxEngineStepMs, remainingMs);
    engine.update(stepMs);
    remainingMs -= stepMs;
  }
}

function resetSpeedProgression() {
  speedMultiplier = SPEED_PROGRESSION.initialMultiplier;
  speedIncreaseQueued = false;
  audioManager.setWorldSpeed(speedMultiplier);
  syncRoadsideVideoRate(engine?.state, world.motionRate, true);
}

function queueSpeedIncrease() {
  speedIncreaseQueued = true;
}

function applyQueuedSpeedIncrease() {
  if (!speedIncreaseQueued) return;
  speedIncreaseQueued = false;
  speedMultiplier = Math.min(
    SPEED_PROGRESSION.maxMultiplier,
    speedMultiplier + SPEED_PROGRESSION.correctStep,
  );
  audioManager.setWorldSpeed(speedMultiplier);
  syncRoadsideVideoRate(engine?.state, world.motionRate, true);
}

function roadsidePanelFor(video) {
  return video?.closest('.roadside-panel') ?? null;
}

function markRoadsideVideoReady(side) {
  const video = roadsideVideos[side];
  if (!video || prefersReducedMotion || roadsideVideoState.lockedFallback.has(side)) return;
  roadsideVideoState.failed.delete(side);
  roadsideVideoState.ready.add(side);
  video.dataset.ready = 'true';
  syncRoadsideVideoRate(engine?.state, world.motionRate, true);
  syncRoadsideVideoPlayback();
}

function markRoadsideVideoLoading(side) {
  const video = roadsideVideos[side];
  if (!video || roadsideVideoState.lockedFallback.has(side)) return;
  roadsideVideoState.ready.delete(side);
  video.dataset.ready = 'false';
  video.dataset.playing = 'false';
  roadsidePanelFor(video)?.classList.remove('is-ready');
}

function markRoadsideVideoFailed(side, lockFallback = true) {
  const video = roadsideVideos[side];
  if (!video) return;
  roadsideVideoState.ready.delete(side);
  roadsideVideoState.failed.add(side);
  roadsideVideoState.autoplayBlocked.delete(side);
  if (lockFallback) roadsideVideoState.lockedFallback.add(side);
  video.dataset.ready = 'false';
  video.dataset.playing = 'false';
  video.dataset.playIntent = 'paused';
  roadsidePanelFor(video)?.classList.remove('is-ready');
  video.pause();
}

function retryBlockedRoadsideVideos() {
  roadsideVideoState.gestureRetryInstalled = false;
  document.removeEventListener('click', retryBlockedRoadsideVideos);
  document.removeEventListener('keyup', retryBlockedRoadsideVideos);

  // Bubble-phase click (or keyup) runs after the game control that may have
  // entered PLAYING. If the gesture did not start/resume gameplay, keep the
  // one-shot recovery armed for the next meaningful gesture.
  if (!shouldRoadsideVideosPlay()) {
    installRoadsideGestureRetry();
    return;
  }

  for (const [side, video] of Object.entries(roadsideVideos)) {
    if (!video || !roadsideVideoState.autoplayBlocked.has(side)) continue;
    requestRoadsideVideoPlay(side, video, true);
  }
}

function installRoadsideGestureRetry() {
  if (roadsideVideoState.gestureRetryInstalled) return;
  roadsideVideoState.gestureRetryInstalled = true;
  document.addEventListener('click', retryBlockedRoadsideVideos);
  document.addEventListener('keyup', retryBlockedRoadsideVideos);
}

function markRoadsideAutoplayBlocked(side) {
  const video = roadsideVideos[side];
  if (!video || roadsideVideoState.lockedFallback.has(side)) return;
  roadsideVideoState.autoplayBlocked.add(side);
  video.dataset.playing = 'false';
  roadsidePanelFor(video)?.classList.remove('is-ready');
  installRoadsideGestureRetry();
}

function configureRoadsideVideos() {
  for (const [side, video] of Object.entries(roadsideVideos)) {
    if (!video) continue;
    video.controls = false;
    video.muted = true;
    video.defaultMuted = true;
    video.loop = true;
    video.playsInline = true;
    video.preload = prefersReducedMotion ? 'none' : 'auto';
    video.pause();
    video.dataset.playIntent = 'paused';
    video.addEventListener('loadstart', () => markRoadsideVideoLoading(side));
    video.addEventListener('canplay', () => markRoadsideVideoReady(side));
    video.addEventListener('error', () => {
      if (!prefersReducedMotion) markRoadsideVideoFailed(side);
    });
    if (!prefersReducedMotion && video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
      markRoadsideVideoReady(side);
    }
  }
}

function roadsideVideoRateForState(state = engine?.state, motionRate = world.motionRate) {
  // The footage is authored at the base 1x run and follows the exact same
  // relative rate as the coded world while that world is moving.
  const worldRate = speedMultiplier * (
    state === GAME_STATES.FEEDBACK ? motionRate : 1
  );
  return Math.min(
    ROADSIDE_VIDEO_PLAYBACK.maxRate,
    Math.max(ROADSIDE_VIDEO_PLAYBACK.minRate, worldRate),
  );
}

function roadsideVideoRatePhase(state = engine?.state, motionRate = world.motionRate) {
  if (state === GAME_STATES.PLAYING) return 'playing';
  if (state === GAME_STATES.FEEDBACK && motionRate >= 1) return 'feedback-burst';
  return 'inactive';
}

function syncRoadsideVideoRate(
  state = engine?.state,
  motionRate = world.motionRate,
  force = false,
) {
  if (state !== GAME_STATES.PLAYING && state !== GAME_STATES.FEEDBACK) return;
  const nextPhase = roadsideVideoRatePhase(state, motionRate);
  const nextRate = roadsideVideoRateForState(state, motionRate);
  if (
    !force &&
    nextPhase === roadsideVideoState.ratePhase &&
    roadsideVideoState.lastRate !== null &&
    Math.abs(nextRate - roadsideVideoState.lastRate) < 0.001
  ) return;

  roadsideVideoState.ratePhase = nextPhase;
  roadsideVideoState.lastRate = nextRate;
  for (const [side, video] of Object.entries(roadsideVideos)) {
    if (!video || !roadsideVideoState.ready.has(side)) continue;
    // Some embedded/mobile media implementations reject uncommon rates.
    // Keep the native fallback playing at its current rate instead of letting
    // one media assignment interrupt the shared gameplay loop.
    try {
      video.defaultPlaybackRate = nextRate;
      video.playbackRate = nextRate;
    } catch {
      video.dataset.rateUnsupported = 'true';
    }
  }
}

function alignRoadsideVideoToPeer(side, video) {
  if (!video || !Number.isFinite(video.duration) || video.duration <= 0) return;
  const peer = Object.entries(roadsideVideos).find(([peerSide, candidate]) => (
    peerSide !== side &&
    candidate &&
    roadsideVideoState.ready.has(peerSide) &&
    !roadsideVideoState.lockedFallback.has(peerSide) &&
    Number.isFinite(candidate.duration) &&
    candidate.duration > 0
  ));
  if (!peer) return;

  const reference = peer[1];
  const targetTime = ((reference.currentTime / reference.duration) % 1) * video.duration;
  const directGap = Math.abs(video.currentTime - targetTime);
  const loopGap = Math.min(directGap, Math.max(0, video.duration - directGap));
  if (loopGap <= ROADSIDE_VIDEO_PLAYBACK.syncToleranceS) return;

  try {
    video.currentTime = targetTime;
  } catch {
    // Metadata/seek support can vary on embedded browsers. Native playback is
    // still a safe fallback even when this one-time phase correction is not.
  }
}

function alignRoadsideVideoPair() {
  const readyVideos = Object.entries(roadsideVideos).filter(([side, video]) => (
    video &&
    roadsideVideoState.ready.has(side) &&
    !roadsideVideoState.lockedFallback.has(side)
  ));
  if (readyVideos.length < 2) return;

  // Prefer the side already moving so a later-ready/autoplay-retried peer
  // joins the visible loop instead of restarting both panels at frame zero.
  const leader = readyVideos.find(([, video]) => !video.paused) ?? readyVideos[0];
  for (const [side, video] of readyVideos) {
    if (video === leader[1]) continue;
    alignRoadsideVideoToPeer(side, video);
  }
}

function requestRoadsideVideoPlay(side, video, retryBlocked = false) {
  if (
    !roadsideVideoState.ready.has(side) ||
    roadsideVideoState.lockedFallback.has(side) ||
    (!retryBlocked && roadsideVideoState.autoplayBlocked.has(side)) ||
    roadsideVideoState.playRequests.has(video)
  ) return;
  if (!video.paused) {
    video.dataset.playing = 'true';
    roadsideVideoState.autoplayBlocked.delete(side);
    roadsidePanelFor(video)?.classList.add('is-ready');
    return;
  }

  alignRoadsideVideoToPeer(side, video);
  const request = video.play();
  if (!request || typeof request.then !== 'function') {
    video.dataset.playing = video.paused ? 'false' : 'true';
    if (video.paused) markRoadsideAutoplayBlocked(side);
    return;
  }

  roadsideVideoState.playRequests.set(video, request);
  void request
    .then(() => {
      if (video.dataset.playIntent !== 'playing') {
        video.pause();
        video.dataset.playing = 'false';
        return;
      }
      roadsideVideoState.autoplayBlocked.delete(side);
      video.dataset.playing = video.paused ? 'false' : 'true';
      if (!video.paused) {
        roadsidePanelFor(video)?.classList.add('is-ready');
      }
    })
    .catch((error) => {
      if (video.dataset.playIntent !== 'playing') return;
      if (error?.name === 'NotAllowedError') {
        markRoadsideAutoplayBlocked(side);
      } else if (error?.name !== 'AbortError') {
        // Decode/source failures are terminal for this run; the static scene
        // remains visible and a late media event cannot flash the panel in.
        markRoadsideVideoFailed(side, true);
      }
    })
    .finally(() => {
      roadsideVideoState.playRequests.delete(video);
      // A pause/resume can race an in-flight play() promise. Reconcile once
      // it settles so the video cannot remain frozen after a fast resume.
      if (
        video.dataset.playIntent === 'playing' &&
        video.paused &&
        roadsideVideoState.ready.has(side) &&
        !roadsideVideoState.autoplayBlocked.has(side)
      ) requestRoadsideVideoPlay(side, video);
    });
}

function shouldRoadsideVideosPlay() {
  const state = engine?.state;
  return (
    !document.hidden &&
    !prefersReducedMotion &&
    currentScreen === 'game' &&
    (state === GAME_STATES.PLAYING ||
      (state === GAME_STATES.FEEDBACK && world.motionRate > 0))
  );
}

function syncRoadsideVideoPlayback() {
  const state = engine?.state;
  const shouldPlay = shouldRoadsideVideosPlay();

  if (shouldPlay) {
    syncRoadsideVideoRate(state, world.motionRate, true);
    alignRoadsideVideoPair();
  } else {
    roadsideVideoState.ratePhase = 'inactive';
  }
  for (const [side, video] of Object.entries(roadsideVideos)) {
    if (!video) continue;
    video.dataset.playIntent = shouldPlay ? 'playing' : 'paused';
    if (shouldPlay) {
      requestRoadsideVideoPlay(side, video);
    } else {
      video.pause();
      video.dataset.playing = 'false';
    }
  }
}

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
    `${world.effectiveSpeed.toFixed(3)} depth/s · ${world.markers.length} markers`;
  dom.devQuestion.textContent = snap.question ? snap.question.id : '–';
}

/* ========================================================================
 * 4. Error handling
 * ====================================================================== */

/** Fatal, page-level failure: stop the loop and explain; never silently ignore. */
function fatalError(message, error) {
  if (fatalHandled) return;
  fatalHandled = true;
  resetFeedbackFlow();
  audioManager.stopMusic();
  audioManager.stopAllSfx();
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
    return false;
  }

  try {
    gameData = JSON.parse(raw);
    engine = new ArticleRunnerEngine({ data: gameData }); // validates and throws on bad data
  } catch (error) {
    fatalError('The game data failed validation.', error);
    return false;
  }

  if (DEBUG) {
    document.body.classList.add('debug');
    dom.devTools.classList.remove('hidden');
    dom.devBar.classList.remove('hidden');
    window.articleRunnerDebug = { get engine() { return engine; } };
  }

  bindEngineEvents();
  bindUiEvents();
  renderLevelList();
  showScreen('start');
  return true;
}

/** A fresh engine instance (READY state) sharing the same persisted progress. */
function recreateEngine() {
  resetFeedbackFlow();
  audioManager.stopMusic();
  audioManager.stopAllSfx({ preserve: ['uiClick'] });
  engine = new ArticleRunnerEngine({ data: gameData, mode: selectedMode });
  bindEngineEvents();
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
    audioManager.resetForRun();
    resetSpeedProgression();
    resetFeedbackFlow();
    resetCoinSession();
    resetPlayerFlightAnimation();
    clearStartNote();
    renderHUD();
  });
  engine.on('question:loaded', (payload) => {
    logEvent('question:loaded', payload);
    resetQuestionAudioState();
    applyQueuedSpeedIncrease();
    deferCoinSpawn(COIN_CONFIG.questionGraceMs);
    renderQuestion(payload);
  });
  engine.on('player:lane-changed', (payload) => {
    logEvent('player:lane-changed', payload);
    renderPlayer(payload.to);
    highlightChosenGate(payload.to);
    highlightAnswerChoice(payload.to);
    applyLaneLean(payload.from, payload.to);
    audioManager.play('laneChange', { direction: payload.to - payload.from });
  });
  engine.on('game:tick', () => {
    /* handled by the render loop; no per-tick work here */
  });
  engine.on('answer:correct', (result) => {
    logEvent('answer:correct', result);
    // Commit on the next question so the resolved collision keeps the exact
    // speed it had on approach.
    queueSpeedIncrease();
    renderFeedback(result);
    playAnswerFeedbackAudio('correct');
  });
  engine.on('answer:wrong', (result) => {
    logEvent('answer:wrong', result);
    renderFeedback(result);
    playAnswerFeedbackAudio('wrong');
  });
  engine.on('level:completed', (payload) => {
    logEvent('level:completed', payload.summary);
    audioManager.stopMusic();
    audioManager.play('levelComplete');
    renderLevelComplete(payload.summary);
  });
  engine.on('game:over', (payload) => {
    logEvent('game:over', payload);
    audioManager.stopMusic();
    audioManager.play('gameOver');
    renderGameOver(payload.summary);
  });
  engine.on('game:paused', (payload) => {
    logEvent('game:paused', payload);
    audioManager.play('pause');
    audioManager.pauseAll();
  });
  engine.on('game:resumed', (payload) => {
    logEvent('game:resumed', payload);
    audioManager.resumeAll();
    audioManager.play('resume');
    deferCoinSpawn(COIN_CONFIG.resumeGraceMs);
    if (payload.toState === GAME_STATES.FEEDBACK) {
      renderPause(false);
      if (activeFeedbackIsCorrect === true) {
        if (!resumeFeedbackAutoContinue()) {
          scheduleAutoContinue(CORRECT_RESUME_AUTO_CONTINUE_MS);
        }
      } else {
        focusWrongFeedbackContinueWhenVisible();
      }
    }
  });
  engine.on('progress:reset', () => {
    logEvent('progress:reset');
    renderLevelList();
  });
}

function handleStateChanged({ to }) {
  if (to !== GAME_STATES.PLAYING) cancelLaneGesture();

  updateAnswerDockState(to);
  switch (to) {
    case GAME_STATES.READY:
      resetFeedbackFlow();
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
      suspendFeedbackAutoContinue();
      audioManager.pauseAll();
      renderPause(true);
      stopLoop();
      break;
    case GAME_STATES.LEVEL_COMPLETE:
      resetFeedbackFlow();
      settlePlayerFlightPose();
      renderPause(false);
      renderLevelList();
      showScreen('complete');
      break;
    case GAME_STATES.GAME_OVER:
      resetFeedbackFlow();
      settlePlayerFlightPose();
      renderPause(false);
      renderLevelList();
      showScreen('gameover');
      break;
    default:
      break;
  }
  syncRoadsideVideoPlayback();
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

  const shouldAnimate = name === 'game' && engine && (
    engine.state === GAME_STATES.PLAYING || engine.state === GAME_STATES.FEEDBACK
  );
  if (shouldAnimate) {
    audioManager.resumeAll();
    audioManager.startMusic();
    startLoop();
  } else {
    audioManager.stopMusic();
    stopLoop();
  }
  syncRoadsideVideoPlayback();
}

/**
 * Pause overlay rendering. (visual pass: restyle the pause screen here;
 * pause/resume decisions stay in the engine)
 */
function renderPause(visible) {
  const wasHidden = dom.overlayPause.classList.contains('hidden');
  dom.overlayPause.classList.toggle('hidden', !visible);
  dom.screenGame.toggleAttribute('inert', visible);
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
  requestAnimationFrame(() => el.classList.add(className));
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

function setDecisionFocus(active) {
  const next = Boolean(active);
  if (decisionFocusActive === next) return;
  decisionFocusActive = next;
  dom.screenGame.classList.toggle('is-decision-focus', next);
}

function renderQuestion(payload) {
  resetQuestionAudioState();
  beginPlayerFlightRecovery();
  gateVisualProgress = 0;
  setDecisionFocus(false);

  // Place each fresh gate group at the vanishing point, then advance it
  // through the same projection used by the lane guides.
  const activeLayout = ROAD_LAYOUTS[world.layoutName];
  world.gate.depth = activeLayout.gateStartDepth;
  world.gate.passDepth = 0;
  world.gate.spawnFade = 0;
  world.gate.approachDepthPerSecond = 0;
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

  const tip = 'Read the whole sentence. Decide whether the noun is new, known, or general.';
  const hint = RULE_HINTS[payload.question.rule] ?? 'Look at what the noun means in this sentence.';
  if (dom.tipText) dom.tipText.textContent = tip;
  if (dom.hintText) dom.hintText.textContent = hint;
  if (dom.mobileHintText) dom.mobileHintText.textContent = hint;
  if (dom.scorePop) {
    dom.scorePop.textContent = '';
    dom.scorePop.classList.remove('is-visible');
  }

  activeLaneMap = [...payload.laneMap];
  renderLanes(activeLaneMap);
  renderAnswerDock(payload.laneMap);
  renderPlayer(payload.playerLane);
  highlightChosenGate(payload.playerLane);
  highlightAnswerChoice(payload.playerLane);
  updateAnswerDockState(engine.state);
  hideFeedback();
  playerFlight.gatePassing = false;
  dom.player.classList.remove('player-correct', 'player-wrong', 'is-gate-passing');
  renderHUD();
  cacheGameTopBounds();
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
    const icon = choice.querySelector('.answer-dock__icon');
    if (icon) icon.innerHTML = visuals.icon;
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
  dom.runner.dataset.playerLane = String(lane);
  beginPlayerLaneTransition(lane);
  roadGuideEls.forEach((guide, index) => guide.classList.toggle('is-active', index === lane));
}

const gateFrameGeometryCache = {
  gateCount: 0,
  size: { point: {} },
  position: { point: {} },
  collision: { point: {} },
};

function getGateFrameGeometry() {
  const gateCount = Math.min(activeLaneMap?.length || 3, gateEls.length);
  if (world.W < 40 || gateCount <= 0) return null;
  gateFrameGeometryCache.gateCount = gateCount;
  writeGateLayoutAtDepth(gateFrameGeometryCache.size, world.gate.depth, gateCount);
  writeGateLayoutAtDepth(gateFrameGeometryCache.position, gateRenderDepth(), gateCount);
  writeGateLayoutAtDepth(gateFrameGeometryCache.collision, gateCollisionDepth(), gateCount);
  return gateFrameGeometryCache;
}

function renderLaneGuides(frameGeometry = null) {
  if (world.W < 40 || roadGuideEls.length === 0) return;
  const frame = frameGeometry ?? getGateFrameGeometry();
  if (!frame) return;
  const gateCount = Math.min(frame.gateCount, roadGuideEls.length);
  const geometry = frame.position;
  const collisionGeometry = frame.collision;
  const guideScale = Math.max(
    0.42,
    Math.min(0.86, (geometry.gateWidth / collisionGeometry.gateWidth) * 0.82),
  );
  const guideY = geometry.point.y * world.H + Math.max(
    10,
    Math.min(world.H * 0.055, geometry.gateWidth * 0.22),
  );
  roadGuideEls.forEach((guide, lane) => {
    const active = lane < gateCount;
    guide.hidden = !active;
    if (!active) return;
    const baseOpacity = guide.classList.contains('is-active') ? 0.96 : 0.78;
    guide.style.opacity = (baseOpacity * world.gate.spawnFade).toFixed(3);
    guide.style.transform =
      `translate3d(${gateCenterX(geometry, lane).toFixed(1)}px, ${guideY.toFixed(1)}px, 0) ` +
      `translate(-50%, -50%) scale(${guideScale.toFixed(3)})`;
  });
}

function applyLaneLean(from, to) {
  if (from === null || from === undefined || from === to) return;
  setPlayerBankDirection(Math.sign(to - from));
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

function setRoadDetailAsset(detail, assetKey) {
  const asset = ROAD_DETAIL_ASSETS[assetKey];
  if (!asset) return;
  detail.assetKey = assetKey;
  detail.anchorY = asset.anchorY;
  detail.el.className = `road-detail road-detail--${asset.kind}`;
  detail.el.src = asset.src;
}

function sizeRoadDetail(detail, laneWidthAtPlayer) {
  const asset = ROAD_DETAIL_ASSETS[detail.assetKey];
  if (!asset || world.W < 40) return;
  const layoutScale = ROAD_DETAIL_LAYOUT_SCALE[world.layoutName] ?? 1;
  const width = Math.min(
    asset.maxWidthPx,
    laneWidthAtPlayer * asset.widthInLanes * detail.size * layoutScale,
  );
  detail.el.style.width = `${Math.max(24, width).toFixed(1)}px`;
}

function nextRoadDetailRandom(detail) {
  detail.randomState = (Math.imul(detail.randomState, 1664525) + 1013904223) >>> 0;
  return detail.randomState / 4294967296;
}

function recycleRoadDetail(detail) {
  const family = ROAD_DETAIL_FAMILIES[detail.family];
  if (family?.length) {
    let assetIndex = Math.floor(nextRoadDetailRandom(detail) * family.length);
    if (family.length > 1 && family[assetIndex] === detail.assetKey) {
      assetIndex = (assetIndex + 1) % family.length;
    }
    setRoadDetailAsset(detail, family[assetIndex]);
  }

  const laneRange = detail.zone === 'mid'
    ? [0.66, 0.84]
    : detail.zone === 'outer'
      ? [1.36, 1.46]
      : [1.14, 1.36];
  detail.laneOffset = detail.side * lerp(
    laneRange[0],
    laneRange[1],
    nextRoadDetailRandom(detail),
  );

  const asset = ROAD_DETAIL_ASSETS[detail.assetKey];
  detail.rot = (nextRoadDetailRandom(detail) * 2 - 1) * asset.rotationDeg;
  detail.size = 0.84 + nextRoadDetailRandom(detail) * 0.22;
  detail.alpha = lerp(asset.alpha[0], asset.alpha[1], nextRoadDetailRandom(detail));
  const playerLaneWidth = projectRoadPoint(world.playerDepth, 0).laneSpacing * world.W;
  sizeRoadDetail(detail, playerLaneWidth);
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
        projection: {},
      });
    }
  }

  // Supplied art replaces the placeholder CSS stones. The largest pool is
  // built once; rebuildWorldGeometry activates a calmer subset per device.
  ROAD_DETAIL_SEEDS.forEach((seed, i) => {
    const el = document.createElement('img');
    el.alt = '';
    el.draggable = false;
    el.decoding = 'async';
    el.setAttribute('aria-hidden', 'true');
    layer.appendChild(el);
    const detail = {
      el,
      ...seed,
      active: true,
      projection: {},
      randomState: (0x9e3779b9 ^ Math.imul(i + 1, 0x85ebca6b)) >>> 0,
    };
    setRoadDetailAsset(detail, seed.asset);
    world.details.push(detail);
  });

  // Dust puffs behind the fox (spawned at runtime, pooled).
  for (let i = 0; i < 4; i += 1) {
    const el = make('dust-puff');
    el.style.opacity = '0';
    world.dusts.push({
      el,
      depth: 0,
      m: 0,
      born: 0,
      size: 0.72 + i * 0.16,
      projection: {},
    });
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
function cacheGameTopBounds() {
  const rect = dom.gameTop?.getBoundingClientRect();
  world.gameTopBounds = rect && rect.width > 0
    ? { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }
    : null;
}

function rebuildWorldGeometry() {
  const rect = dom.runner.getBoundingClientRect();
  if (rect.width < 40 || rect.height < 40) return; // hidden screen — try again when shown

  world.W = rect.width;
  world.H = rect.height;
  world.runnerLeft = rect.left;
  world.runnerRight = rect.right;
  cacheGameTopBounds();
  world.layoutName = selectRoadLayoutName(world.W, world.H);
  world.isPhonePortrait = isPhonePortraitViewport(world.W, world.H);
  dom.runner.dataset.roadLayout = world.layoutName;
  dom.screenGame.dataset.roadLayout = world.layoutName;
  const layout = ROAD_LAYOUTS[world.layoutName];
  world.horizonY = layout.horizonY;
  world.bottomY = layout.bottomY;
  world.centerX = layout.centerX;
  world.farHalfWidth = layout.farHalfWidth;
  world.nearHalfWidth = world.isPhonePortrait
    ? PHONE_PORTRAIT_VISUALS.nearHalfWidth
    : layout.nearHalfWidth;
  world.playerDepth = world.isPhonePortrait
    ? PHONE_PORTRAIT_VISUALS.playerDepth
    : layout.playerDepth;
  world.perspectivePower = layout.perspectivePower;
  world.playerHalfWidth = lerp(
    world.farHalfWidth,
    world.nearHalfWidth,
    Math.pow(world.playerDepth, world.perspectivePower),
  );
  world.baseSpeed = layout.worldSpeed * (prefersReducedMotion ? ROAD_MOTION.reducedFactor : 1);
  world.speed = world.baseSpeed;
  world.effectiveSpeed = world.baseSpeed * currentGameplayRate() * world.motionRate;

  // Preserve the gate's journey when geometry changes while play is frozen.
  // Re-projecting its stored progress prevents a resize/orientation snap.
  if (engine.state === GAME_STATES.PLAYING || engine.state === GAME_STATES.PAUSED) {
    world.gate.depth = lerp(
      layout.gateStartDepth,
      gateCollisionDepth(),
      gateVisualProgress,
    );
  }

  const playerGround = projectRoadPoint(world.playerDepth, 0);
  dom.runner.style.setProperty('--scene-horizon-y', `${(world.horizonY * 100).toFixed(2)}%`);
  dom.runner.style.setProperty('--scene-collision-y', `${(playerGround.y * 100).toFixed(2)}%`);
  for (let lane = 0; lane < 3; lane += 1) {
    const lanePoint = projectLanePoint(world.playerDepth, lane);
    dom.runner.style.setProperty(`--lane-x-${lane}`, `${(lanePoint.x * 100).toFixed(2)}%`);
  }
  syncPlayerFlightToLayout();
  dom.runner.style.setProperty('--lane-marker-width', `${layout.markerWidthPx}px`);
  dom.runner.style.setProperty('--lane-marker-height', `${layout.markerHeightPx}px`);

  const laneWidthAtPlayer = playerGround.laneSpacing * world.W;

  // Divider rails are straight in projected t-space, so every marker on a
  // divider shares one stable angle for this viewport.
  const farLaneSpacing = (world.farHalfWidth * 2) / 3;
  const nearLaneSpacing = (world.nearHalfWidth * 2) / 3;
  const mDiv = (0.5 * (nearLaneSpacing - farLaneSpacing)) /
    (world.bottomY - world.horizonY);
  const angle = (Math.atan2(mDiv * world.W, world.H) * 180) / Math.PI;
  world.divAngle = [angle, -angle];

  drawCodedRoad(layout);
  // Resize changes intrinsic sizes only. Normalized depths and texture phase
  // remain untouched, so orientation and breakpoint changes never reset flow.
  dom.runner.style.setProperty('--road-grain-o', String(layout.grain ?? 0.5));
  const detailDensity = ROAD_DETAIL_DENSITY[world.layoutName] ?? 2;
  world.details.forEach((detail) => {
    detail.active = detail.density <= detailDensity;
    detail.el.hidden = !detail.active;
    sizeRoadDetail(detail, laneWidthAtPlayer);
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
    coin.baseSizePx = coinBase;
    coin.el.style.width = `${coinBase.toFixed(1)}px`;
    coin.el.style.height = `${coinBase.toFixed(1)}px`;
  });
  const coinTargetRect = (dom.hudCoinIcon ?? dom.hudScorePill)?.getBoundingClientRect();
  coinSystem.hudTargetRect = coinTargetRect
    ? {
        left: coinTargetRect.left,
        top: coinTargetRect.top,
        width: coinTargetRect.width,
        height: coinTargetRect.height,
      }
    : null;

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

  // Wheel-wear tracks follow the same equal-slot road geometry as every
  // projected lane object.
  const roadTracks = document.getElementById('road-tracks');
  if (roadTracks) {
    const TRACK_HALF = 0.16;
    [0, 1, 2].forEach((laneIndex, idx) => {
      const left = [];
      const right = [];
      for (let s = 0; s <= 8; s += 1) {
        const t = s / 8;
        const roadHalfWidth = lerp(world.farHalfWidth, world.nearHalfWidth, t);
        const spacing = (roadHalfWidth * 2) / 3;
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
  const z = 110 + Math.round(Math.min(Math.max(depth, 0), 1.45) * 4);
  el.style.zIndex = String(z);
}

function renderMarker(marker) {
  const divider = marker.line === 0 ? -0.5 : 0.5;
  const p = writeProjectedRoadPoint(marker.projection, marker.depth, divider);
  const scaleX = Math.max(0.16, p.scale);
  marker.el.style.transform =
    `translate3d(${(p.x * world.W).toFixed(1)}px, ${(p.y * world.H).toFixed(1)}px, 0) ` +
    `translate(-50%, -50%) rotate(${world.divAngle[marker.line].toFixed(1)}deg) ` +
    `scale3d(${scaleX.toFixed(3)}, ${p.scale.toFixed(3)}, 1)`;
  marker.el.style.opacity = Math.min(0.9, 0.24 + p.t * 1.05).toFixed(2);
}

function renderRoadDetail(detail) {
  if (!detail.active) return;
  const p = writeProjectedRoadPoint(detail.projection, detail.depth, detail.laneOffset);
  const visibility = clamp01((p.t - 0.055) / 0.22);
  detail.el.style.zIndex = String(1 + Math.round(clamp01(detail.depth) * 80));
  detail.el.style.transform =
    `translate3d(${(p.x * world.W).toFixed(1)}px, ${(p.y * world.H).toFixed(1)}px, 0) ` +
    `translate(-50%, -${detail.anchorY}%) rotate(${detail.rot.toFixed(1)}deg) ` +
    `scale(${p.scale.toFixed(3)})`;
  detail.el.style.opacity = (detail.alpha * visibility * (0.48 + 0.52 * p.t)).toFixed(2);
}

function renderDust(puff) {
  if (puff.born <= 0) {
    puff.el.style.opacity = '0';
    return; // pooled but idle
  }
  const p = writeProjectedRoadPoint(puff.projection, puff.depth, puff.m);
  const lifeSpan = Math.max(0.08, 1 - puff.born);
  const life = clamp01((puff.depth - puff.born) / lifeSpan);
  puff.el.style.transform =
    `translate3d(${(p.x * world.W).toFixed(1)}px, ${(p.y * world.H).toFixed(1)}px, 0) ` +
    `translate(-50%, -50%) scale(${(p.scale * (0.62 + life * 0.42)).toFixed(3)})`;
  puff.el.style.opacity = (0.28 * (1 - life)).toFixed(3);
}

/**
 * Advance + render the whole world layer for one frame.
 * effectiveRate is the one shared real-time travel rate: base gameplay pace
 * × answer-speed multiplier × the explicit feedback factor. Every pooled
 * object advances linearly in normalized depth; the nonlinear shared
 * projection creates the apparent acceleration toward the camera.
 */
function updateWorldMotion(dt, effectiveRate) {
  if (!world.built || world.W < 40) return;
  const worldAdvance = world.baseSpeed * effectiveRate * dt;
  const markerAdvance = worldAdvance * ROAD_MOTION.markerMultiplier;
  const detailAdvance = worldAdvance * ROAD_MOTION.detailMultiplier;
  world.effectiveSpeed = world.baseSpeed * effectiveRate;

  if (worldAdvance > 0) {
    for (const marker of world.markers) {
      marker.depth += markerAdvance;
      if (marker.depth >= 1) marker.depth -= 1;
      renderMarker(marker);
    }
    for (const detail of world.details) {
      if (!detail.active) continue;
      detail.depth += detailAdvance;
      if (detail.depth >= 1) {
        detail.depth -= 1;
        recycleRoadDetail(detail);
      }
      renderRoadDetail(detail);
    }
    for (const puff of world.dusts) {
      if (puff.born > 0) {
        puff.depth += detailAdvance;
        if (puff.depth >= 1) puff.born = 0;
        renderDust(puff);
      }
    }

    // Dust spawning at the fox's ground line (skipped under reduced motion).
    if (!prefersReducedMotion && effectiveRate > 0) {
      world.dustTimer += dt * 1000 * effectiveRate;
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

function updateRoadMotionRate(state, feedbackTime = world.feedbackT) {
  if (state === GAME_STATES.PLAYING) {
    // Never carry feedback crawl into a new approach or brake near collision.
    world.motionRate = 1;
    return world.motionRate;
  }
  if (state !== GAME_STATES.FEEDBACK) return 0;
  const target = feedbackTime < ROAD_MOTION.feedbackBurstS ? 1 : 0;
  // Feedback has one explicit post-collision clock boundary. Keeping the rate
  // discrete lets native video switch once instead of receiving writes on
  // every animation frame.
  world.motionRate = target;
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
      projection: {},
      baseSizePx: COIN_CONFIG.baseSizeMinPx,
      screenRect: { left: 0, top: 0, width: 0, height: 0 },
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
  const p = writeProjectedRoadPoint(coin.projection, coin.depth, coin.lane - 1);
  const renderedSize = coin.baseSizePx * p.scale;
  coin.screenRect.left = p.x * world.W - renderedSize / 2;
  coin.screenRect.top = p.y * world.H - renderedSize * 0.92;
  coin.screenRect.width = renderedSize;
  coin.screenRect.height = renderedSize;
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

  const sparkCount = world.layoutName === 'mobile' ? 4 : COIN_CONFIG.sparkCount;
  for (let index = 0; index < sparkCount; index += 1) {
    const angle = (Math.PI * 2 * index) / sparkCount + randRange(-0.16, 0.16);
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

function createCoinFlight(sourceRect, targetRect) {
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
  audioManager.play('coin');
  // Both endpoints are cached during projection/layout work, so collecting a
  // coin never forces synchronous layout in the animation frame.
  const rect = { ...coin.screenRect };
  const targetRect = prefersReducedMotion ? null : coinSystem.hudTargetRect;
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
  createCoinFlight(rect, targetRect);
}

function settleCoinEffectsForReducedMotion() {
  for (const effect of [...coinSystem.effects]) {
    if (coinSystem.flights.has(effect)) finishCoinFlight(effect);
    else removeCoinEffect(effect);
  }
}

function updateCoins(travelDeltaMs, dt, effectiveRate, state) {
  if (coinSystem.pool.length === 0 || world.W < 40) return;
  const advance = world.speed * effectiveRate * dt;
  const playerLane = state === GAME_STATES.PLAYING || state === GAME_STATES.FEEDBACK
    ? world.playerLane
    : null;

  if (advance > 0) {
    for (const coin of coinSystem.pool) {
      if (!coin.active) continue;
      const previousRelativeDepth = coin.depth / world.playerDepth;
      coin.depth += advance;
      renderCoin(coin);

      // COIN_CONFIG keeps the original 0..1 collection tuning, while the
      // responsive road places the fox at a layout-specific playerDepth.
      const playerRelativeDepth = coin.depth / world.playerDepth;
      const inCollectionZone =
        playerRelativeDepth >= COIN_CONFIG.collectionStart &&
        previousRelativeDepth <= COIN_CONFIG.collectionEnd;
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

  coinSystem.nextSpawnMs -= travelDeltaMs;
  if (
    coinSystem.nextSpawnMs <= 0 &&
    coinSystem.pool.filter((coin) => coin.active).length < COIN_CONFIG.maxActiveCoins
  ) {
    spawnCoinEvent();
  }
}

/**
 * Gate visual state per engine state:
 *  - PLAYING: linear visual depth follows gateProgress and reaches the
 *    road-bounded collision plane at the exact frame the engine resolves.
 *  - FEEDBACK: size freezes at that plane while position keeps advancing on
 *    the shared world clock for one short physical pass, then fades.
 */
function updateGateVisual(realDt, travelDt, state) {
  const g = world.gate;
  if (state === GAME_STATES.PLAYING) {
    const layout = ROAD_LAYOUTS[world.layoutName];
    const start = layout.gateStartDepth;
    const nextDepth = lerp(
      start,
      gateCollisionDepth(),
      gateVisualProgress,
    );
    if (travelDt > 0 && nextDepth >= g.depth) {
      g.approachDepthPerSecond = (nextDepth - g.depth) / travelDt;
    }
    g.depth = nextDepth;
    g.passDepth = 0;
    g.spawnFade = Math.min(1, g.spawnFade + realDt * RUNNER_GEO.gateSpawnFadePerSecond);
  } else if (state === GAME_STATES.FEEDBACK) {
    const previousFeedbackT = world.feedbackT;
    world.feedbackT += realDt;
    g.depth = gateCollisionDepth();
    const remainingPassSeconds = Math.max(
      0,
      RUNNER_GEO.gatePassThroughSeconds - previousFeedbackT,
    );
    const passFrameShare = realDt > 0
      ? Math.min(1, remainingPassSeconds / realDt)
      : 0;
    g.passDepth = Math.min(
      RUNNER_GEO.gateMaxPassDepth,
      g.passDepth +
        (g.approachDepthPerSecond || world.baseSpeed) * travelDt * passFrameShare,
    );
    const fadeDuration = Math.max(
      0.001,
      RUNNER_GEO.gateExitFadeSeconds - RUNNER_GEO.gateExitFadeStartSeconds,
    );
    g.spawnFade = 1 - clamp01(
      (world.feedbackT - RUNNER_GEO.gateExitFadeStartSeconds) / fadeDuration,
    );
  }
}

function renderGates(frameGeometry = null) {
  const laneMap = activeLaneMap;
  if (!laneMap || laneMap.length === 0) return;
  const frame = frameGeometry ?? getGateFrameGeometry();
  if (!frame) return;
  const { farOpacity } = RUNNER_GEO;
  const layout = ROAD_LAYOUTS[world.layoutName];
  const D = world.gate.depth;
  const gateCount = Math.min(laneMap.length, frame.gateCount);
  const sizeGeometry = frame.size;
  const positionGeometry = frame.position;
  const gateJourney = clamp01(
    (D - layout.gateStartDepth) /
      Math.max(0.001, gateCollisionDepth() - layout.gateStartDepth),
  );
  const opacity = (farOpacity + (1 - farOpacity) * gateJourney) * world.gate.spawnFade;

  // Gates carry their real projected size in pixels. A transform that re-scales
  // every frame keeps the element on one GPU layer whose raster goes stale, so
  // the compositor resamples it and the art smears; an element whose width is
  // set instead re-rasterizes at its exact display size and only translates
  // afterwards. Integer pixels keep both the size and the ground point stable.
  const gateWidthCss = `${Math.round(sizeGeometry.gateWidth)}px`;

  gateEls.forEach((el, lane) => {
    const active = lane < gateCount;
    el.hidden = !active;
    if (!active) return;
    // (x, y) is the gate's ground point: bottom-centered, standing on the road.
    if (el.style.width !== gateWidthCss) el.style.width = gateWidthCss;
    el.style.transform =
      `translate3d(${Math.round(gateCenterX(positionGeometry, lane))}px, ` +
      `${Math.round(positionGeometry.point.y * world.H)}px, 0) ` +
      `translate(-50%, -100%)`;
    el.style.opacity = opacity.toFixed(3);
    // Contact shadow reads stronger as the gate gets close.
    el.style.setProperty('--gate-shadow-o', (0.22 + 0.4 * gateJourney).toFixed(3));
  });
}

/* ========================================================================
 * 10. Feedback rendering (engine payload only — no UI-side explanations)
 * ====================================================================== */

function clearFeedbackAutoContinue() {
  if (feedbackAutoContinueTimer !== null) {
    window.clearTimeout(feedbackAutoContinueTimer);
    feedbackAutoContinueTimer = null;
  }
  feedbackAutoContinueDueAt = null;
  feedbackAutoContinueRemainingMs = null;
}

function suspendFeedbackAutoContinue() {
  if (feedbackAutoContinueTimer === null) return;
  feedbackAutoContinueRemainingMs = Math.max(
    0,
    (feedbackAutoContinueDueAt ?? performance.now()) - performance.now(),
  );
  window.clearTimeout(feedbackAutoContinueTimer);
  feedbackAutoContinueTimer = null;
  feedbackAutoContinueDueAt = null;
}

function resumeFeedbackAutoContinue() {
  if (
    feedbackAutoContinueRemainingMs === null ||
    engine?.state !== GAME_STATES.FEEDBACK ||
    activeFeedbackIsCorrect !== true
  ) return false;
  scheduleAutoContinue(feedbackAutoContinueRemainingMs);
  return true;
}

function resetFeedbackFlow() {
  clearFeedbackAutoContinue();
  activeFeedbackIsCorrect = null;
}

function feedbackPoseSettleSeconds() {
  return RUNNER_GEO.gatePassThroughSeconds + PLAYER_FLIGHT.recoveryDurationMs / 1000;
}

function scheduleAutoContinue(delay) {
  clearFeedbackAutoContinue();
  const safeDelay = Number.isFinite(delay) ? Math.max(0, delay) : 0;
  feedbackAutoContinueRemainingMs = safeDelay;
  feedbackAutoContinueDueAt = performance.now() + safeDelay;
  feedbackAutoContinueTimer = window.setTimeout(() => {
    feedbackAutoContinueTimer = null;
    feedbackAutoContinueDueAt = null;
    feedbackAutoContinueRemainingMs = null;
    if (
      engine?.state === GAME_STATES.FEEDBACK &&
      activeFeedbackIsCorrect === true
    ) {
      const remainingPoseMs = Math.max(
        0,
        (feedbackPoseSettleSeconds() - world.feedbackT) * 1000,
      );
      if (remainingPoseMs > 1) {
        scheduleAutoContinue(Math.max(16, remainingPoseMs));
        return;
      }
      continueAfterFeedback('auto');
    }
  }, safeDelay);
}

function hideFeedback() {
  resetFeedbackFlow();
  dom.feedback.classList.add('hidden');
  dom.feedback.classList.remove('feedback-correct', 'feedback-wrong');
  dom.screenGame.classList.remove('is-feedback');
  dom.screenGame.classList.remove('is-world-idle');
  if (dom.scorePop) dom.scorePop.classList.remove('is-visible');
}

function renderFeedback(result) {
  if (engine.state !== GAME_STATES.FEEDBACK) return; // e.g. game-over screens take over

  clearFeedbackAutoContinue();
  activeFeedbackIsCorrect = result.isCorrect;

  // Keep full motion while the fox punches through the gate, then let correct
  // feedback retain a light shared crawl. Wrong/manual explanations may rest.
  world.feedbackT = 0;
  dom.screenGame.classList.remove('is-world-idle');

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
  if (dom.tipText) dom.tipText.textContent = result.explanation;

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
    dom.feedbackDetail.textContent = `+${result.pointsGained} points · ${result.explanation}`;
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

  dom.btnContinue.hidden = result.isCorrect;
  dom.btnContinue.disabled = result.isCorrect;
  if (result.isCorrect) {
    scheduleAutoContinue(Math.min(result.feedbackDelayMs, CORRECT_FEEDBACK_MAX_MS));
  } else {
    focusWrongFeedbackContinueWhenVisible();
  }
  renderHUD();
}

function focusWrongFeedbackContinueWhenVisible() {
  const focusIfCurrent = () => {
    if (
      engine?.state === GAME_STATES.FEEDBACK &&
      activeFeedbackIsCorrect === false &&
      !dom.btnContinue.hidden
    ) dom.btnContinue.focus({ preventScroll: true });
  };

  if (prefersReducedMotion || Number.parseFloat(getComputedStyle(dom.feedback).opacity) >= 0.95) {
    requestAnimationFrame(focusIfCurrent);
    return;
  }
  dom.feedback.addEventListener('animationend', focusIfCurrent, { once: true });
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
  requestAnimationFrame(() => dom.completeTitle.focus({ preventScroll: true }));
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
  requestAnimationFrame(() => dom.gameOverTitle.focus({ preventScroll: true }));
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
  dom.startHero?.setAttribute('inert', '');
  dom.btnLevelsClose.focus({ preventScroll: true });
}

function closeLevelModal() {
  if (dom.levelModal.classList.contains('hidden')) return;
  dom.levelModal.classList.add('hidden');
  dom.startHero?.removeAttribute('inert');
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
    // The game never starts until the single player image is decoded.
    await playerAssetReady;
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

const coarsePointerQuery =
  typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(pointer: coarse)')
    : null;
const SWIPE_HORIZONTAL_BIAS = 1.2;
const SWIPE_TAP_SLOP_PX = 10;
const SWIPE_MAX_LANE_FOLLOW = 0.24;
const SWIPE_MAX_LEAN_DEG = 2.5;
let laneGesture = null;

function isLaneGesturePointer(event) {
  if (!event.isPrimary) return false;
  if (event.pointerType === 'touch' || event.pointerType === 'pen') return true;
  const hasTouch = typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0;
  return event.pointerType === '' && (coarsePointerQuery?.matches || hasTouch);
}

function laneGesturesAllowed() {
  return Boolean(
    engine && currentScreen === 'game' && engine.state === GAME_STATES.PLAYING
  );
}

function pointIsInsideBounds(clientX, clientY, bounds) {
  if (!bounds) return false;
  return (
    clientX >= bounds.left && clientX <= bounds.right &&
    clientY >= bounds.top && clientY <= bounds.bottom
  );
}

function isLaneGestureBlocked(event) {
  // .game-top has pointer-events:none, so use its bounds as well as the
  // event target to keep the HUD/question area out of the road gesture zone.
  if (pointIsInsideBounds(event.clientX, event.clientY, world.gameTopBounds)) return true;
  if (!(event.target instanceof Element)) return false;
  if (event.target.closest('.answer-gate')) return false;
  return Boolean(event.target.closest(
    '.game-top, .answer-dock, .feedback, .overlay, ' +
    'button:not(.answer-gate), a[href], input, select, textarea, ' +
    '[role="button"], [contenteditable="true"]'
  ));
}

function laneAtClientX(clientX) {
  if (world.W <= 0) return world.playerLane;
  const lane = Math.floor(((clientX - world.runnerLeft) / world.W) * 3);
  return Math.max(0, Math.min(2, lane));
}

function laneAtGestureStart(event) {
  const gate = event.target instanceof Element
    ? event.target.closest('.answer-gate')
    : null;
  const gateLane = Number(gate?.dataset.lane);
  return Number.isInteger(gateLane) && gateLane >= 0 && gateLane <= 2
    ? gateLane
    : laneAtClientX(event.clientX);
}

function swipeThresholdPx() {
  const runnerWidth = world.W || window.innerWidth;
  const viewportWidth = Math.min(window.innerWidth || runnerWidth, runnerWidth || window.innerWidth);
  return Math.max(36, Math.min(56, viewportWidth * 0.1));
}

function playerLaneSpacingPx() {
  if (world.W > 0) {
    return projectRoadPoint(world.playerDepth, 0).laneSpacing * world.W;
  }
  return (window.innerWidth || 1) / 3;
}

function renderLaneDrag(deltaX) {
  const maxOffset = Math.max(1, playerLaneSpacingPx() * SWIPE_MAX_LANE_FOLLOW);
  const offset = Math.max(-maxOffset, Math.min(maxOffset, deltaX * 0.55));
  const lean = (offset / maxOffset) * SWIPE_MAX_LEAN_DEG;
  dom.player.classList.add('is-dragging');
  dom.playerLean.classList.add('is-dragging');
  dom.player.style.setProperty('--player-drag-x', `${offset.toFixed(1)}px`);
  dom.playerLean.style.setProperty('--player-drag-lean', `${lean.toFixed(2)}deg`);
}

function resetLaneDragVisual() {
  const dragOffset = Number.parseFloat(
    dom.player.style.getPropertyValue('--player-drag-x'),
  ) || 0;
  absorbPlayerDragOffset(dragOffset);
  dom.player.classList.remove('is-dragging');
  dom.playerLean.classList.remove('is-dragging');
  dom.player.style.removeProperty('--player-drag-x');
  dom.playerLean.style.removeProperty('--player-drag-lean');
}

function cancelLaneGesture(releaseCapture = true) {
  const pointerId = laneGesture?.pointerId;
  laneGesture = null;
  resetLaneDragVisual();
  if (
    releaseCapture &&
    pointerId !== undefined &&
    dom.runner.hasPointerCapture?.(pointerId)
  ) {
    dom.runner.releasePointerCapture(pointerId);
  }
}

function handleRunnerPointerDown(event) {
  if (event.button !== 0 || isLaneGestureBlocked(event)) return;

  if (!isLaneGesturePointer(event)) {
    // Preserve the existing mouse/trackpad road-tap path without turning
    // desktop dragging into a primary control.
    if (event.isPrimary) movePlayerToLane(laneAtClientX(event.clientX));
    return;
  }
  if (!laneGesturesAllowed() || laneGesture) return;

  laneGesture = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    currentX: event.clientX,
    currentY: event.clientY,
    threshold: swipeThresholdPx(),
    tapLane: laneAtGestureStart(event),
    horizontalIntent: false,
    consumed: false,
  };

  try {
    dom.runner.setPointerCapture(event.pointerId);
  } catch (error) {
    logError('pointer capture', error);
  }
}

function handleRunnerPointerMove(event) {
  const gesture = laneGesture;
  if (!gesture || event.pointerId !== gesture.pointerId) return;
  if (!laneGesturesAllowed()) {
    cancelLaneGesture();
    return;
  }

  gesture.currentX = event.clientX;
  gesture.currentY = event.clientY;
  const deltaX = gesture.currentX - gesture.startX;
  const deltaY = gesture.currentY - gesture.startY;
  const absX = Math.abs(deltaX);
  const absY = Math.abs(deltaY);

  if (
    !gesture.horizontalIntent &&
    absX >= 6 &&
    absX > absY * SWIPE_HORIZONTAL_BIAS
  ) {
    gesture.horizontalIntent = true;
  }
  if (!gesture.horizontalIntent) return;

  event.preventDefault();
  if (absX >= gesture.threshold) gesture.consumed = true;
  renderLaneDrag(deltaX);
}

function handleDesktopCursorFollow(event) {
  if (
    event.pointerType !== 'mouse' ||
    world.layoutName !== 'desktop' ||
    !laneGesturesAllowed() ||
    isLaneGestureBlocked(event)
  ) return;

  const lane = laneAtClientX(event.clientX);
  if (lane !== world.playerLane) movePlayerToLane(lane);
}

function finishLaneGesture(event, cancelled = false) {
  const gesture = laneGesture;
  if (!gesture || event.pointerId !== gesture.pointerId) return;

  gesture.currentX = event.clientX;
  gesture.currentY = event.clientY;
  const deltaX = gesture.currentX - gesture.startX;
  const deltaY = gesture.currentY - gesture.startY;
  const distance = Math.hypot(deltaX, deltaY);
  const horizontal =
    gesture.horizontalIntent &&
    Math.abs(deltaX) > Math.abs(deltaY) * SWIPE_HORIZONTAL_BIAS;
  const validSwipe =
    !cancelled &&
    laneGesturesAllowed() &&
    horizontal &&
    Math.abs(deltaX) >= gesture.threshold;
  const validTap =
    !cancelled &&
    laneGesturesAllowed() &&
    !gesture.consumed &&
    distance <= SWIPE_TAP_SLOP_PX;
  const tapLane = gesture.tapLane;
  const pointerId = gesture.pointerId;

  if (gesture.horizontalIntent || gesture.consumed) event.preventDefault();
  laneGesture = null;
  resetLaneDragVisual();
  if (dom.runner.hasPointerCapture?.(pointerId)) {
    dom.runner.releasePointerCapture(pointerId);
  }

  if (validSwipe) {
    safeEngineCall(() => (deltaX < 0 ? engine.moveLeft() : engine.moveRight()));
  } else if (validTap) {
    movePlayerToLane(tapLane);
  }
}

const DIALOG_FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function activeModalDialog() {
  if (!dom.overlayPause.classList.contains('hidden')) return dom.overlayPause;
  if (!dom.levelModal.classList.contains('hidden')) return dom.levelModal;
  return null;
}

function trapDialogFocus(event) {
  if (event.key !== 'Tab') return false;
  const dialog = activeModalDialog();
  if (!dialog) return false;
  const focusable = [...dialog.querySelectorAll(DIALOG_FOCUSABLE_SELECTOR)]
    .filter((element) => !element.hidden && element.getClientRects().length > 0);
  if (focusable.length === 0) {
    event.preventDefault();
    return true;
  }
  const first = focusable[0];
  const last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
  return true;
}

function playUiAudioCue(name = 'uiClick', options = {}) {
  if (audioManager.play(name, options)) return;
  // On the very first interaction resume() may settle between pointerdown and
  // click. Queue only that first cue; normal gameplay events never wait here.
  void unlockAudio().then((ready) => {
    if (ready) audioManager.play(name, options);
  });
}

function handleAudioUnlockGesture(event) {
  if (event.type === 'keydown' && event.repeat) return;
  void unlockAudio();
}

function handleUiAudioClick(event) {
  if (!(event.target instanceof Element)) return;
  const control = event.target.closest(
    'button, [role="button"], input[type="button"], input[type="submit"]',
  );
  if (!control || control.disabled || control.getAttribute('aria-disabled') === 'true') return;

  if (
    control === dom.btnPause ||
    control === dom.btnResume ||
    control === dom.btnContinue ||
    control === dom.btnModeLearn ||
    control === dom.btnModeArcade ||
    control.classList.contains('answer-gate')
  ) return;

  if (control.matches(
    '#btn-hint, [data-audio="hint"], ' +
    '[aria-controls="hint-text"], [aria-controls="mobile-hint-text"]',
  )) {
    playUiAudioCue('hint');
    return;
  }
  playUiAudioCue('uiClick');
}

function handleHintToggle(event) {
  const details = event.target;
  if (
    typeof HTMLDetailsElement !== 'undefined' &&
    details instanceof HTMLDetailsElement &&
    details.open &&
    (details.contains(dom.hintText) || details.contains(dom.mobileHintText))
  ) playUiAudioCue('hint');
}

function bindUiEvents() {
  // Keep these capture listeners installed: after a mobile browser suspends
  // audio in the background, the next real gesture can safely resume the same
  // singleton context without constructing a duplicate.
  document.addEventListener('pointerdown', handleAudioUnlockGesture, {
    capture: true,
    passive: true,
  });
  document.addEventListener('keydown', handleAudioUnlockGesture, { capture: true });
  document.addEventListener('click', handleUiAudioClick);
  document.addEventListener('toggle', handleHintToggle, true);

  // -- start screen --
  dom.btnPlay.addEventListener('click', () => {
    clearStartNote();
    startGame(pickDefaultLevel());
  });
  dom.btnModeLearn.addEventListener('click', () => setMode(GAME_MODES.LEARN));
  dom.btnModeArcade.addEventListener('click', () => setMode(GAME_MODES.ARCADE));
  [dom.btnModeLearn, dom.btnModeArcade].forEach((button, index, buttons) => {
    button.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const targetIndex = event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? buttons.length - 1
          : event.key === 'ArrowLeft'
            ? (index - 1 + buttons.length) % buttons.length
            : (index + 1) % buttons.length;
      const mode = targetIndex === 0 ? GAME_MODES.LEARN : GAME_MODES.ARCADE;
      setMode(mode);
      buttons[targetIndex].focus();
    });
  });
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
      if (!event.isPrimary) return;
      // Touch/pen taps and drags are resolved by the runner gesture path so
      // starting on a gate still permits a full-road swipe.
      if (isLaneGesturePointer(event)) return;
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

  // The full road accepts coarse-pointer taps, swipes and tactile dragging.
  dom.runner.addEventListener('pointerdown', handleRunnerPointerDown);
  dom.runner.addEventListener('pointermove', handleDesktopCursorFollow);
  dom.runner.addEventListener('pointermove', handleRunnerPointerMove, { passive: false });
  dom.runner.addEventListener('pointerup', (event) => finishLaneGesture(event));
  dom.runner.addEventListener('pointercancel', (event) => finishLaneGesture(event, true));
  dom.runner.addEventListener('lostpointercapture', (event) => {
    if (laneGesture?.pointerId === event.pointerId) cancelLaneGesture(false);
  });

  // -- pause overlay --
  dom.btnResume.addEventListener('click', () => togglePause());
  dom.btnQuit.addEventListener('click', () => {
    // Abandon the run: a fresh engine shares the same persisted progress.
    audioManager.stopAllSfx({ preserve: ['uiClick'] });
    resetFeedbackFlow();
    recreateEngine();
    renderPause(false);
    showScreen('start');
  });

  // -- level complete --
  dom.btnPlayAgain.addEventListener('click', () => {
    try {
      resetFeedbackFlow();
      engine.restartLevel();
    } catch (error) {
      logError('restartLevel', error);
    }
  });
  dom.btnNextLevel.addEventListener('click', () => {
    const next = nextLevelAfter(engine.getSnapshot().level?.id);
    if (next) startGame(next.id);
  });
  dom.btnCompleteMenu.addEventListener('click', () => {
    audioManager.stopAllSfx({ preserve: ['uiClick'] });
    resetFeedbackFlow();
    showScreen('start');
  });

  // -- game over --
  dom.btnRetry.addEventListener('click', () => {
    try {
      resetFeedbackFlow();
      engine.restartLevel();
    } catch (error) {
      logError('restartLevel', error);
    }
  });
  dom.btnGameOverMenu.addEventListener('click', () => {
    audioManager.stopAllSfx({ preserve: ['uiClick'] });
    resetFeedbackFlow();
    showScreen('start');
  });

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
  // Boot performs asynchronous decoding before these listeners are bound, so
  // resample once to catch a preference change made while the loader was up.
  if (reducedMotionQuery && prefersReducedMotion !== reducedMotionQuery.matches) {
    handleReducedMotionChange(reducedMotionQuery);
  }
  if (reducedMotionQuery?.addEventListener) {
    reducedMotionQuery.addEventListener('change', handleReducedMotionChange);
  } else if (reducedMotionQuery?.addListener) {
    reducedMotionQuery.addListener(handleReducedMotionChange);
  }

  // Resume from a fresh clock origin instead of simulating time spent in a
  // throttled or suspended background tab.
  document.addEventListener('visibilitychange', () => {
    lastFrameTime = null;
    audioManager.setPageVisible(!document.hidden);
    if (document.hidden) {
      suspendFeedbackAutoContinue();
      stopLoop();
    } else {
      resumeFeedbackAutoContinue();
      if (
        currentScreen === 'game' &&
        (engine?.state === GAME_STATES.PLAYING || engine?.state === GAME_STATES.FEEDBACK)
      ) startLoop();
    }
    syncRoadsideVideoPlayback();
  });

  // -- responsive geometry: normalized road phases survive every resize;
  //    only their projection and intrinsic sizes are recalculated. --
  buildRoadWorld(); // pooled road objects exist before the first level
  rebuildWorldGeometry(); // no-op while the game screen is hidden
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      rebuildWorldGeometry(); // road polygons + pooled sizes follow the new layout
    }, 120);
  });
}

function setMode(mode) {
  playUiAudioCue('uiClick');
  selectedMode = mode;
  dom.btnModeLearn.classList.toggle('is-active', mode === GAME_MODES.LEARN);
  dom.btnModeArcade.classList.toggle('is-active', mode === GAME_MODES.ARCADE);
  dom.btnModeLearn.setAttribute('aria-checked', String(mode === GAME_MODES.LEARN));
  dom.btnModeArcade.setAttribute('aria-checked', String(mode === GAME_MODES.ARCADE));
  dom.btnModeLearn.tabIndex = mode === GAME_MODES.LEARN ? 0 : -1;
  dom.btnModeArcade.tabIndex = mode === GAME_MODES.ARCADE ? 0 : -1;
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
  if (trapDialogFocus(event)) return;
  // The start screen owns Escape while the level overlay is open.
  if (currentScreen === 'start' && event.key === 'Escape') {
    if (engine && !dom.levelModal.classList.contains('hidden')) closeLevelModal();
    return;
  }
  if (!engine || currentScreen === 'start' || currentScreen === 'error') return;
  if (event.repeat && (event.key === ' ' || event.key === 'Enter' || event.key === 'Escape')) {
    event.preventDefault();
    return;
  }
  const state = engine.state;
  const focusedAnswer = event.target.closest?.('.answer-dock__choice');
  if (focusedAnswer && (event.key === ' ' || event.key === 'Enter')) {
    if (state === GAME_STATES.PLAYING) {
      event.preventDefault();
      playUiAudioCue('uiClick');
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
          answerChoiceEls[engine.playerLane]?.focus({ preventScroll: true });
        }
      }
      break;
    case 'ArrowRight':
    case 'd':
    case 'D':
      if (state === GAME_STATES.PLAYING) {
        safeEngineCall(() => engine.moveRight());
        if (focusedAnswer) {
          answerChoiceEls[engine.playerLane]?.focus({ preventScroll: true });
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
      if (state === GAME_STATES.FEEDBACK) continueAfterFeedback('manual');
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
  if (state === GAME_STATES.PLAYING || state === GAME_STATES.FEEDBACK) {
    safeEngineCall(() => engine.pause());
  } else if (state === GAME_STATES.PAUSED) {
    safeEngineCall(() => engine.resume());
  }
}

function continueAfterFeedback(source = 'manual') {
  if (engine.state !== GAME_STATES.FEEDBACK) return;
  const isAutomatic = source === 'auto';
  if (activeFeedbackIsCorrect !== isAutomatic) return;
  if (!isAutomatic) audioManager.play('uiClick');
  clearFeedbackAutoContinue();
  safeEngineCall(() => engine.continueAfterFeedback());
}

/* ========================================================================
 * 14. Player character animation (fox) — presentation only.
 *     The engine never sees filenames, frame timing or images; this
 *     controller only READS game state and renders the character.
 * ====================================================================== */

const PLAYER_FLIGHT = Object.freeze({
  laneDurationMs: 245,
  bankMaxDeg: 4.5,
  bankPeakProgress: 0.28,
  glideLiftPx: 3,
  hoverPeriodMs: 1800,
  hoverAmplitudePx: Object.freeze({ desktop: 3, tablet: 2.5, mobile: 2 }),
  decisionFocusProgress: 0.65,
  descentStartProgress: 0.7,
  landingCompleteProgress: 0.94,
  recoveryDurationMs: 320,
  gateLayerStartProgress: 0.92,
  cruisePitchDeg: -1.25,
  landingPitchDeg: 0,
  gateOpeningWidthRatio: 0.588,
  foxVisibleWidthRatio: 0.905,
  openingBreathingRatio: 1.18,
  openingCenterAboveGroundRatio: 0.29,
  landingDropRatioByLayout: Object.freeze({ desktop: 0.15, tablet: 0.15, mobile: 0.2 }),
  landingDropMinPxByLayout: Object.freeze({ desktop: 15, tablet: 12, mobile: 10 }),
  landingDropMaxPxByLayout: Object.freeze({ desktop: 35, tablet: 28, mobile: 25 }),
});

const reducedMotionQuery =
  typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : null;
let prefersReducedMotion = reducedMotionQuery?.matches ?? false;

let playerAssetReady = Promise.resolve(false);
const playerFlight = {
  ready: false,
  currentX: 0,
  startX: 0,
  targetX: 0,
  targetLane: 1,
  elapsedMs: 0,
  moving: false,
  bankDirection: 0,
  bankStartDeg: 0,
  bankDeg: 0,
  glideY: 0,
  hoverClockMs: 0,
  hoverY: 0,
  hoverNormalized: 0,
  heightY: 0,
  landingAmount: 0,
  landingDropPx: 0,
  recoveryStartHeightY: 0,
  recoveryElapsedMs: 0,
  recovering: false,
  gatePassing: false,
};

/* ------------------------------------------------------------------------
 * Startup image preloader
 * ---------------------------------------------------------------------- */

const IMAGE_PRELOAD_TIMEOUT_MS = 45000;
const LOADER_MIN_VISIBLE_MS = 350;
const LOADER_FADE_MS = 360;

/** Retain decoded images for the life of this page and share duplicate URLs. */
const decodedImagesByUrl = new Map();
const decodedImageRequests = new Map();
const decodedAssetsById = new Map();
const optionalAssetFailures = new Set();
const failedDocumentImages = new WeakSet();
let preloadLayoutName = null;
let loaderMessageTimers = [];
let bootPromise = null;
let initializationPromise = null;
let gameInitialized = false;
const loaderShownAt = performance.now();

function loadDecodedImage(src) {
  const cacheKey = new URL(src, document.baseURI).href;
  const decoded = decodedImagesByUrl.get(cacheKey);
  if (decoded) return Promise.resolve(decoded);

  const activeRequest = decodedImageRequests.get(cacheKey);
  if (activeRequest) return activeRequest;

  const request = new Promise((resolve, reject) => {
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
      let decodeError = null;
      try {
        if (typeof img.decode === 'function') await img.decode();
      } catch (error) {
        // Some browsers reject decode() for an otherwise complete cached image.
        decodeError = error;
      }

      if (img.complete && img.naturalWidth > 0) {
        settle(resolve, img);
      } else {
        settle(reject, decodeError ?? new Error(`Could not decode ${src}`));
      }
    };

    img.onerror = () => settle(reject, new Error(`Could not load ${src}`));
    timeoutId = setTimeout(() => {
      settle(reject, new Error(`Timed out loading ${src}`));
      img.src = '';
    }, IMAGE_PRELOAD_TIMEOUT_MS);
    img.src = src;
  })
    .then((image) => {
      decodedImagesByUrl.set(cacheKey, image);
      return image;
    })
    .finally(() => decodedImageRequests.delete(cacheKey));

  decodedImageRequests.set(cacheKey, request);
  return request;
}

function waitForWindowLoad() {
  if (document.readyState === 'complete') return Promise.resolve();

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      window.removeEventListener('load', handleLoad);
      reject(new Error('Timed out waiting for initial page images'));
    }, IMAGE_PRELOAD_TIMEOUT_MS);
    const handleLoad = () => {
      clearTimeout(timeoutId);
      resolve();
    };
    window.addEventListener('load', handleLoad, { once: true });
  });
}

async function decodeDocumentImage(image) {
  const source = image.currentSrc || image.getAttribute('src');
  if (!source) return image;

  if (!(image.complete && image.naturalWidth > 0) && failedDocumentImages.has(image)) {
    // A Retry can recover an element that failed before the connection came
    // back: warm the URL, then point only that broken element at the cache.
    await loadDecodedImage(source);
    image.src = source;
  }

  let decodeError = null;
  try {
    if (typeof image.decode === 'function') await image.decode();
  } catch (error) {
    decodeError = error;
  }

  if (image.complete && image.naturalWidth > 0) {
    failedDocumentImages.delete(image);
    return image;
  }

  failedDocumentImages.add(image);
  throw decodeError ?? new Error('An initial page image could not load');
}

async function preloadDocumentImages() {
  await waitForWindowLoad();
  const explicitSources = new Set([
    ...PRELOAD_ASSETS.critical,
    ...PRELOAD_ASSETS.optional,
    ...Object.values(PRELOAD_ASSETS.byLayout).flat(),
  ].flatMap((entry) => entry.candidates));
  const images = [...document.images].filter((image) => {
    const source = image.getAttribute('src')?.replace(/^\.\//, '');
    if (!source || explicitSources.has(source)) return false;
    if (preloadLayoutName !== 'desktop' && image.closest('.world-sign')) return false;
    return true;
  });
  await Promise.all(images.map(decodeDocumentImage));
  return images;
}

function preloadRoadsideVideo(entry) {
  const side = entry.side;
  const video = roadsideVideos[side];
  if (!video) return Promise.reject(new Error(`Missing ${side} roadside video element`));

  return new Promise((resolve, reject) => {
    let settled = false;
    let timeoutId = null;

    const cleanup = () => {
      if (timeoutId !== null) clearTimeout(timeoutId);
      video.removeEventListener('canplay', onReady);
      video.removeEventListener('error', onError);
      document.removeEventListener('visibilitychange', onSuspended);
      if (reducedMotionQuery?.removeEventListener) {
        reducedMotionQuery.removeEventListener('change', onSuspended);
      } else {
        reducedMotionQuery?.removeListener?.(onSuspended);
      }
    };
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onReady = () => {
      markRoadsideVideoReady(side);
      settle(resolve, {
        entry,
        src: video.currentSrc || entry.candidates[0],
        video,
      });
    };
    const onError = () => {
      markRoadsideVideoFailed(side);
      settle(reject, new Error(`Could not buffer ${entry.candidates[0]}`));
    };
    const onSuspended = () => {
      if (!document.hidden && !reducedMotionQuery?.matches) return;
      // A hidden page or newly requested reduced-motion view does not make
      // the source invalid. Let boot continue with the static fallback and
      // allow a later visible/non-reduced canplay event to recover it.
      settle(resolve, {
        entry,
        src: video.currentSrc || entry.candidates[0],
        video,
        skipped: true,
      });
    };

    video.addEventListener('canplay', onReady);
    video.addEventListener('error', onError);
    document.addEventListener('visibilitychange', onSuspended);
    if (reducedMotionQuery?.addEventListener) {
      reducedMotionQuery.addEventListener('change', onSuspended);
    } else {
      reducedMotionQuery?.addListener?.(onSuspended);
    }
    timeoutId = setTimeout(() => {
      if (document.hidden || reducedMotionQuery?.matches) {
        onSuspended();
        return;
      }
      // Lock this side to the static fallback for the run. A late canplay must
      // not fade one panel in after gameplay has already begun.
      markRoadsideVideoFailed(side, true);
      settle(reject, new Error(`Timed out buffering ${entry.candidates[0]}`));
    }, ROADSIDE_VIDEO_PLAYBACK.bufferTimeoutMs);

    if (video.readyState >= 3) {
      onReady();
    } else {
      video.load();
    }
  });
}

async function preloadAsset(entry) {
  const cached = decodedAssetsById.get(entry.id);
  if (cached) return cached;

  if (entry.kind === 'document-images') {
    const images = await preloadDocumentImages();
    const result = { entry, src: 'document-images', image: images };
    decodedAssetsById.set(entry.id, result);
    return result;
  }

  if (entry.kind === 'roadside-video') {
    const result = await preloadRoadsideVideo(entry);
    decodedAssetsById.set(entry.id, result);
    return result;
  }

  let lastError = null;
  for (const src of entry.candidates) {
    try {
      const image = await loadDecodedImage(src);
      const result = { entry, src, image };
      decodedAssetsById.set(entry.id, result);
      return result;
    } catch (error) {
      lastError = error;
      if (DEBUG) console.warn(`[game] preload candidate failed: ${src}`, error);
    }
  }

  throw lastError ?? new Error(`No usable image candidate for ${entry.id}`);
}

function activePreloadManifest() {
  if (!preloadLayoutName) {
    const width = document.documentElement.clientWidth || window.innerWidth;
    const height = document.documentElement.clientHeight || window.innerHeight;
    preloadLayoutName = selectRoadLayoutName(width, height);
  }

  const manifest = [
    ...PRELOAD_ASSETS.critical.map((entry) => ({ ...entry, critical: true })),
    ...PRELOAD_ASSETS.byLayout[preloadLayoutName].map((entry) => ({ ...entry, critical: true })),
    ...PRELOAD_ASSETS.optional.map((entry) => ({ ...entry, critical: false })),
  ];
  return prefersReducedMotion
    ? manifest.filter((entry) => entry.kind !== 'roadside-video')
    : manifest;
}

function updateLoaderProgress(completed, total) {
  const percent = total > 0 ? Math.round((completed / total) * 100) : 100;
  const clamped = Math.min(100, Math.max(0, percent));
  dom.loaderProgressFill.style.width = `${clamped}%`;
  dom.loaderPercent.textContent = `${clamped}%`;
  dom.loaderProgress.setAttribute('aria-valuenow', String(clamped));
}

function setLoaderMessage(message, accessibleLabel) {
  dom.loaderMessage.textContent = message;
  dom.loader.setAttribute('aria-label', accessibleLabel);
}

function clearLoaderMessageTimers() {
  loaderMessageTimers.forEach((timerId) => clearTimeout(timerId));
  loaderMessageTimers = [];
}

function scheduleLoaderMessages() {
  clearLoaderMessageTimers();
  const changeMessage = (message, label) => {
    if (dom.loader.dataset.state === 'loading') setLoaderMessage(message, label);
  };
  loaderMessageTimers = [
    setTimeout(() => changeMessage('Loading the game world…', 'Loading the game world'), 2500),
    setTimeout(() => changeMessage('Almost ready…', 'Almost ready'), 6500),
  ];
}

function resetLoaderForAttempt() {
  document.body.classList.add('is-loading');
  dom.app.setAttribute('inert', '');
  dom.app.setAttribute('aria-hidden', 'true');
  dom.loader.hidden = false;
  dom.loader.removeAttribute('aria-hidden');
  dom.loader.classList.remove('is-leaving');
  dom.loader.dataset.state = 'loading';
  dom.loader.setAttribute('aria-busy', 'true');
  dom.loaderTitle.textContent = 'Definite Dash';
  setLoaderMessage('Getting your adventure ready…', 'Loading Definite Dash');
  dom.loaderRetry.dataset.action = 'retry';
  dom.loaderRetry.textContent = 'Try Again';
  dom.loaderRetry.disabled = true;
  dom.loaderRetry.hidden = true;
  updateLoaderProgress(0, 1);
  scheduleLoaderMessages();
}

function showLoaderError(title, message, action = 'retry') {
  clearLoaderMessageTimers();
  dom.loader.dataset.state = 'error';
  dom.loader.setAttribute('aria-busy', 'false');
  dom.loaderTitle.textContent = title;
  setLoaderMessage(message, 'Load failed');
  dom.loaderRetry.dataset.action = action;
  dom.loaderRetry.textContent = action === 'reload' ? 'Reload Page' : 'Try Again';
  dom.loaderRetry.hidden = false;
  dom.loaderRetry.disabled = false;
  requestAnimationFrame(() => dom.loaderRetry.focus({ preventScroll: true }));
}

function prepareFlyingPlayerElement(src = FLYING_FOX_SRC) {
  if (!dom.playerImg) return;
  const flightWrapper = dom.playerFrame?.parentElement;
  flightWrapper?.classList.remove('player-run');
  flightWrapper?.classList.add('player-flight');
  dom.playerImg.id = 'player-img';
  dom.playerImg.className = 'player-img';
  dom.playerImg.src = src;
  dom.playerImg.alt = '';
  dom.playerImg.draggable = false;
  dom.playerImg.decoding = 'async';
  dom.playerImg.width = 640;
  dom.playerImg.height = 640;
  if (dom.playerFrame && (
    dom.playerFrame.children.length !== 1 || dom.playerFrame.firstElementChild !== dom.playerImg
  )) {
    dom.playerFrame.replaceChildren(dom.playerImg);
  }
  dom.player.dataset.flightState = 'gliding';
}

function applyPreloadedGameplayAssets(manifest) {
  const playerEntry = manifest.find((entry) => entry.kind === 'player');
  const playerResult = playerEntry ? decodedAssetsById.get(playerEntry.id) : null;
  if (playerResult) prepareFlyingPlayerElement(playerResult.src);

  const gateEntries = manifest.filter((entry) => entry.kind === 'gate');
  const gatesReady = gateEntries.every((entry) => decodedAssetsById.has(entry.id));
  dom.gatesRoot.classList.toggle('gates-art-failed', !gatesReady);
}

async function preloadGameAssets() {
  const manifest = activePreloadManifest();
  const criticalManifest = manifest.filter((entry) => entry.critical);
  const optionalManifest = manifest.filter((entry) => !entry.critical);
  const criticalFailures = [];
  let completed = 0;
  const pending = [];

  for (const entry of criticalManifest) {
    if (decodedAssetsById.has(entry.id)) {
      completed += 1;
    } else {
      pending.push(entry);
    }
  }
  updateLoaderProgress(completed, criticalManifest.length);

  await Promise.all(pending.map(async (entry) => {
    try {
      await preloadAsset(entry);
      completed += 1;
    } catch (error) {
      if (entry.fallbackAllowed) {
        completed += 1;
        optionalAssetFailures.add(entry.id);
      } else {
        criticalFailures.push({ entry, error });
      }
    } finally {
      updateLoaderProgress(completed, criticalManifest.length);
    }
  }));

  applyPreloadedGameplayAssets(manifest);
  // Optional flourishes warm in the background and never hold the loader.
  for (const entry of optionalManifest) {
    if (decodedAssetsById.has(entry.id) || optionalAssetFailures.has(entry.id)) continue;
    void preloadAsset(entry).catch((error) => {
      optionalAssetFailures.add(entry.id);
      if (DEBUG) console.warn(`[game] optional preload failed: ${entry.id}`, error);
    });
  }
  return { ok: criticalFailures.length === 0, criticalFailures };
}

function initializeGameOnce() {
  if (gameInitialized) return Promise.resolve(true);
  if (!initializationPromise) {
    fatalHandled = false;
    initializationPromise = init().then((initialized) => {
      if (initialized) {
        gameInitialized = true;
      } else {
        // Data/network failures happen before event binding, so a retry is safe.
        initializationPromise = null;
      }
      return initialized;
    });
  }
  return initializationPromise;
}

function waitFor(milliseconds) {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function revealLoadedGame() {
  const remainingMinimum = LOADER_MIN_VISIBLE_MS - (performance.now() - loaderShownAt);
  await waitFor(remainingMinimum);

  document.body.classList.remove('is-loading');
  dom.app.removeAttribute('inert');
  dom.app.removeAttribute('aria-hidden');
  dom.loader.classList.add('is-leaving');
  await waitFor(prefersReducedMotion ? 0 : LOADER_FADE_MS);
  dom.loader.hidden = true;
  dom.loader.setAttribute('aria-hidden', 'true');
}

async function performBoot() {
  resetLoaderForAttempt();
  // Replace the markup fallback before document-image decoding so none of the
  // retired gameplay frames are warmed or mounted by the loader.
  prepareFlyingPlayerElement();

  const preloadPromise = preloadGameAssets();
  playerAssetReady = preloadPromise.then((result) => result.ok, () => false);
  const preloadResult = await preloadPromise;

  if (!preloadResult.ok) {
    showLoaderError('Connection problem', "Some game files couldn't load.");
    return false;
  }

  clearLoaderMessageTimers();
  updateLoaderProgress(1, 1);
  setLoaderMessage('Starting the game…', 'Starting Definite Dash');

  const initialized = await initializeGameOnce();
  if (!initialized) {
    showLoaderError('Connection problem', "The game couldn't start. Check your connection and try again.");
    return false;
  }

  dom.loader.dataset.state = 'ready';
  dom.loader.setAttribute('aria-busy', 'false');
  setLoaderMessage('Game ready.', 'Game ready');
  await revealLoadedGame();
  return true;
}

function bootGame() {
  if (gameInitialized && dom.loader.hidden) return Promise.resolve(true);
  if (bootPromise) return bootPromise;

  bootPromise = performBoot()
    .catch((error) => {
      if (DEBUG) console.error('[game] startup failed:', error);
      showLoaderError(
        'Couldn’t start the game',
        'Please reload the page and try again.',
        'reload',
      );
      return false;
    })
    .finally(() => {
      bootPromise = null;
    });
  return bootPromise;
}

function easeOutCubic(value) {
  return 1 - ((1 - clamp01(value)) ** 3);
}

function easeInOutSine(value) {
  return -(Math.cos(Math.PI * clamp01(value)) - 1) / 2;
}

function playerLaneOffsetPx(lane) {
  if (world.W < 40) return 0;
  const lanePoint = projectLanePoint(world.playerDepth, lane);
  return (lanePoint.x - world.centerX) * world.W;
}

function playerGateFitGeometry() {
  const gateCount = Math.min(activeLaneMap?.length || 3, gateEls.length || 3);
  const gateGeometry = getGateLayoutAtDepth(gateCollisionDepth(), gateCount);
  const playerWidthRatio = world.isPhonePortrait
    ? PHONE_PORTRAIT_VISUALS.playerGateWidthRatio
    : PLAYER_FLIGHT.gateOpeningWidthRatio /
      (PLAYER_FLIGHT.openingBreathingRatio * PLAYER_FLIGHT.foxVisibleWidthRatio);
  const playerSizePx = gateGeometry.gateWidth * playerWidthRatio;
  const dropRatio = PLAYER_FLIGHT.landingDropRatioByLayout[world.layoutName] ?? 0.15;
  const minDrop = PLAYER_FLIGHT.landingDropMinPxByLayout[world.layoutName] ?? 10;
  const maxDrop = PLAYER_FLIGHT.landingDropMaxPxByLayout[world.layoutName] ?? 35;
  const landingDropPx = Math.min(maxDrop, Math.max(minDrop, playerSizePx * dropRatio));
  const gateHeightPx = gateGeometry.gateWidth / RUNNER_GEO.gateArtAspectRatio;
  return { gateGeometry, playerSizePx, landingDropPx, gateHeightPx };
}

function paintPlayerFlightTransform() {
  const landingAmount = clamp01(playerFlight.landingAmount);
  const pitchDeg = lerp(
    PLAYER_FLIGHT.cruisePitchDeg,
    PLAYER_FLIGHT.landingPitchDeg,
    landingAmount,
  );
  const hoverShadow = playerFlight.hoverNormalized * (1 - landingAmount);
  const shadowScale = 0.96 + landingAmount * 0.12 + hoverShadow * 0.012;
  const shadowOpacity = 0.27 + landingAmount * 0.09 + hoverShadow * 0.015;
  dom.player.style.setProperty('--player-lane-offset', `${playerFlight.currentX.toFixed(2)}px`);
  dom.player.style.setProperty('--player-bank-angle', `${playerFlight.bankDeg.toFixed(3)}deg`);
  dom.player.style.setProperty('--player-glide-y', `${playerFlight.glideY.toFixed(2)}px`);
  dom.player.style.setProperty('--player-hover-y', `${playerFlight.hoverY.toFixed(2)}px`);
  dom.player.style.setProperty('--player-flight-y', `${playerFlight.heightY.toFixed(2)}px`);
  dom.player.style.setProperty('--player-flight-pitch', `${pitchDeg.toFixed(3)}deg`);
  dom.player.style.setProperty('--player-shadow-scale', shadowScale.toFixed(4));
  dom.player.style.setProperty('--player-shadow-opacity', shadowOpacity.toFixed(3));
}

function syncPlayerFlightToLayout() {
  if (world.W < 40) return;
  const {
    gateGeometry,
    playerSizePx,
    landingDropPx,
    gateHeightPx,
  } = playerGateFitGeometry();
  dom.player.style.width = `${playerSizePx.toFixed(2)}px`;
  const computedBottomPx = Number.parseFloat(getComputedStyle(dom.player).bottom) || 0;
  const unshiftedPlayerCenterY = world.H - computedBottomPx - playerSizePx / 2;
  const landingCenterY =
    gateGeometry.point.y * world.H -
    gateHeightPx * PLAYER_FLIGHT.openingCenterAboveGroundRatio;
  const cruiseLiftPx = landingCenterY - unshiftedPlayerCenterY - landingDropPx;
  dom.player.style.setProperty('--player-flight-lift', `${cruiseLiftPx.toFixed(2)}px`);

  const offset = playerLaneOffsetPx(world.playerLane);
  const priorLandingAmount = playerFlight.landingAmount;
  playerFlight.ready = true;
  playerFlight.currentX = offset;
  playerFlight.startX = offset;
  playerFlight.targetX = offset;
  playerFlight.targetLane = world.playerLane;
  playerFlight.elapsedMs = 0;
  playerFlight.moving = false;
  playerFlight.bankDirection = 0;
  playerFlight.bankStartDeg = 0;
  playerFlight.bankDeg = 0;
  playerFlight.glideY = 0;
  playerFlight.landingDropPx = landingDropPx;
  playerFlight.heightY = landingDropPx * priorLandingAmount;
  if (playerFlight.recovering) {
    playerFlight.recoveryStartHeightY = playerFlight.heightY;
    playerFlight.recoveryElapsedMs = 0;
  }
  paintPlayerFlightTransform();
}

function beginPlayerFlightRecovery() {
  playerFlight.recoveryElapsedMs = 0;
  playerFlight.recoveryStartHeightY = playerFlight.heightY;
  playerFlight.recovering = playerFlight.heightY > 0.1;
}

function beginPlayerLaneTransition(lane) {
  if (!Number.isInteger(lane) || lane < 0 || lane > 2 || world.W < 40) return;
  const targetX = playerLaneOffsetPx(lane);

  if (!playerFlight.ready) {
    syncPlayerFlightToLayout();
    return;
  }
  if (playerFlight.targetLane === lane && playerFlight.moving) return;

  playerFlight.startX = playerFlight.currentX;
  playerFlight.targetX = targetX;
  playerFlight.targetLane = lane;
  playerFlight.elapsedMs = 0;
  playerFlight.bankStartDeg = playerFlight.bankDeg;
  playerFlight.bankDirection = Math.sign(targetX - playerFlight.currentX);
  playerFlight.moving = Math.abs(targetX - playerFlight.currentX) > 0.25;

  if (prefersReducedMotion || !playerFlight.moving) {
    playerFlight.currentX = targetX;
    playerFlight.moving = false;
    playerFlight.bankDirection = 0;
    playerFlight.bankStartDeg = 0;
    playerFlight.bankDeg = 0;
    playerFlight.glideY = 0;
  }
  paintPlayerFlightTransform();
}

function setPlayerBankDirection(direction) {
  if (prefersReducedMotion || !playerFlight.moving) return;
  playerFlight.bankStartDeg = playerFlight.bankDeg;
  playerFlight.bankDirection = Math.sign(direction);
}

function absorbPlayerDragOffset(offset) {
  if (!playerFlight.ready || !Number.isFinite(offset) || Math.abs(offset) < 0.05) return;
  playerFlight.currentX += offset;
  playerFlight.startX = playerFlight.currentX;
  playerFlight.targetX = playerLaneOffsetPx(world.playerLane);
  playerFlight.targetLane = world.playerLane;
  playerFlight.elapsedMs = 0;
  playerFlight.bankStartDeg = playerFlight.bankDeg;
  playerFlight.bankDirection = Math.sign(playerFlight.targetX - playerFlight.currentX);
  playerFlight.moving = !prefersReducedMotion &&
    Math.abs(playerFlight.targetX - playerFlight.currentX) > 0.25;
  if (!playerFlight.moving) playerFlight.currentX = playerFlight.targetX;
  paintPlayerFlightTransform();
}

function updatePlayerLaneFlight(deltaMs) {
  if (!playerFlight.moving) return;
  playerFlight.elapsedMs = Math.min(
    PLAYER_FLIGHT.laneDurationMs,
    playerFlight.elapsedMs + deltaMs,
  );
  const progress = playerFlight.elapsedMs / PLAYER_FLIGHT.laneDurationMs;
  playerFlight.currentX = lerp(
    playerFlight.startX,
    playerFlight.targetX,
    easeOutCubic(progress),
  );

  const peak = PLAYER_FLIGHT.bankPeakProgress;
  const peakAngle = playerFlight.bankDirection * PLAYER_FLIGHT.bankMaxDeg;
  if (progress < peak) {
    playerFlight.bankDeg = lerp(
      playerFlight.bankStartDeg,
      peakAngle,
      easeOutCubic(progress / peak),
    );
  } else {
    playerFlight.bankDeg = lerp(
      peakAngle,
      0,
      easeInOutSine((progress - peak) / (1 - peak)),
    );
  }
  playerFlight.glideY = -Math.sin(Math.PI * progress) * PLAYER_FLIGHT.glideLiftPx;

  if (progress >= 1) {
    playerFlight.currentX = playerFlight.targetX;
    playerFlight.moving = false;
    playerFlight.bankDirection = 0;
    playerFlight.bankStartDeg = 0;
    playerFlight.bankDeg = 0;
    playerFlight.glideY = 0;
  }
}

function updatePlayerHover(deltaMs) {
  if (prefersReducedMotion) {
    playerFlight.hoverY = 0;
    playerFlight.hoverNormalized = 0;
    return;
  }
  playerFlight.hoverClockMs =
    (playerFlight.hoverClockMs + deltaMs) % PLAYER_FLIGHT.hoverPeriodMs;
  const phase = (playerFlight.hoverClockMs / PLAYER_FLIGHT.hoverPeriodMs) * Math.PI * 2;
  const baseAmplitude = PLAYER_FLIGHT.hoverAmplitudePx[world.layoutName] ?? 3;
  const amplitude = baseAmplitude * (1 - playerFlight.landingAmount * 0.75);
  const hoverY = Math.sin(phase) * amplitude;
  playerFlight.hoverY = hoverY;
  playerFlight.hoverNormalized = baseAmplitude > 0 ? hoverY / baseAmplitude : 0;
}

function updatePlayerGateFlight(deltaMs, state) {
  if (state === GAME_STATES.FEEDBACK) {
    playerFlight.recovering = false;
    const recoveryElapsedMs = Math.max(
      0,
      world.feedbackT * 1000 - RUNNER_GEO.gatePassThroughSeconds * 1000,
    );
    const recoveryProgress = clamp01(
      recoveryElapsedMs / PLAYER_FLIGHT.recoveryDurationMs,
    );
    playerFlight.heightY = lerp(
      playerFlight.landingDropPx,
      0,
      easeInOutSine(recoveryProgress),
    );
    playerFlight.landingAmount = playerFlight.landingDropPx > 0
      ? clamp01(playerFlight.heightY / playerFlight.landingDropPx)
      : 0;
  } else if (gateVisualProgress >= PLAYER_FLIGHT.descentStartProgress) {
    playerFlight.recovering = false;
    const descentProgress = clamp01(
      (gateVisualProgress - PLAYER_FLIGHT.descentStartProgress) /
      (PLAYER_FLIGHT.landingCompleteProgress - PLAYER_FLIGHT.descentStartProgress),
    );
    playerFlight.landingAmount = easeInOutSine(descentProgress);
    playerFlight.heightY = playerFlight.landingDropPx * playerFlight.landingAmount;
  } else if (playerFlight.recovering) {
    playerFlight.recoveryElapsedMs = Math.min(
      PLAYER_FLIGHT.recoveryDurationMs,
      playerFlight.recoveryElapsedMs + deltaMs,
    );
    const recoveryProgress =
      playerFlight.recoveryElapsedMs / PLAYER_FLIGHT.recoveryDurationMs;
    playerFlight.heightY = lerp(
      playerFlight.recoveryStartHeightY,
      0,
      easeInOutSine(recoveryProgress),
    );
    playerFlight.landingAmount = playerFlight.landingDropPx > 0
      ? clamp01(playerFlight.heightY / playerFlight.landingDropPx)
      : 0;
    if (recoveryProgress >= 1) playerFlight.recovering = false;
  } else {
    playerFlight.heightY = 0;
    playerFlight.landingAmount = 0;
  }

  const gateIsPassing =
    (state === GAME_STATES.PLAYING &&
      gateVisualProgress >= PLAYER_FLIGHT.gateLayerStartProgress) ||
    (state === GAME_STATES.FEEDBACK &&
      world.feedbackT < RUNNER_GEO.gateExitFadeSeconds);
  if (playerFlight.gatePassing !== gateIsPassing) {
    playerFlight.gatePassing = gateIsPassing;
    dom.player.classList.toggle('is-gate-passing', gateIsPassing);
  }
}

function updatePlayerFlightAnimation(deltaMs, state) {
  if (state !== GAME_STATES.PLAYING && state !== GAME_STATES.FEEDBACK) return;
  updatePlayerLaneFlight(deltaMs);
  updatePlayerGateFlight(deltaMs, state);
  updatePlayerHover(deltaMs);
  paintPlayerFlightTransform();
}

function settlePlayerFlightPose() {
  playerFlight.hoverClockMs = 0;
  if (playerFlight.ready && world.W >= 40) {
    const offset = playerLaneOffsetPx(world.playerLane);
    playerFlight.currentX = offset;
    playerFlight.startX = offset;
    playerFlight.targetX = offset;
    playerFlight.targetLane = world.playerLane;
  }
  playerFlight.elapsedMs = 0;
  playerFlight.moving = false;
  playerFlight.bankDirection = 0;
  playerFlight.bankStartDeg = 0;
  playerFlight.bankDeg = 0;
  playerFlight.glideY = 0;
  playerFlight.hoverY = 0;
  playerFlight.hoverNormalized = 0;
  playerFlight.heightY = 0;
  playerFlight.landingAmount = 0;
  playerFlight.recoveryStartHeightY = 0;
  playerFlight.recoveryElapsedMs = 0;
  playerFlight.recovering = false;
  playerFlight.gatePassing = false;
  dom.player.classList.remove('is-gate-passing');
  paintPlayerFlightTransform();
}

function resetPlayerFlightAnimation() {
  settlePlayerFlightPose();
}

function handleReducedMotionChange(event) {
  prefersReducedMotion = event.matches;
  const layout = ROAD_LAYOUTS[world.layoutName] ?? ROAD_LAYOUTS.desktop;
  world.baseSpeed = layout.worldSpeed * (prefersReducedMotion ? ROAD_MOTION.reducedFactor : 1);
  world.speed = world.baseSpeed;
  if (prefersReducedMotion) {
    const preservedGateFlight = {
      heightY: playerFlight.heightY,
      landingAmount: playerFlight.landingAmount,
      recoveryStartHeightY: playerFlight.recoveryStartHeightY,
      recoveryElapsedMs: playerFlight.recoveryElapsedMs,
      recovering: playerFlight.recovering,
      gatePassing: playerFlight.gatePassing,
    };
    settlePlayerFlightPose();
    Object.assign(playerFlight, preservedGateFlight);
    dom.player.classList.toggle('is-gate-passing', playerFlight.gatePassing);
    paintPlayerFlightTransform();
    settleCoinEffectsForReducedMotion();
    for (const video of Object.values(roadsideVideos)) {
      if (!video) continue;
      video.preload = 'none';
      roadsidePanelFor(video)?.classList.remove('is-ready');
    }
  } else {
    playerFlight.hoverClockMs = 0;
    for (const video of Object.values(roadsideVideos)) {
      if (!video) continue;
      video.preload = 'auto';
      video.load();
    }
  }
  syncRoadsideVideoPlayback();
}

/* ========================================================================
 * 15. Animation loop (single driver; the engine owns timing & collision)
 * ====================================================================== */

function startLoop() {
  if (rafId !== null) return;
  dom.screenGame.classList.remove('is-world-idle');
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
    if (!engine || document.hidden) return;

    // Clamp only the abnormal real-frame gap, then scale it. The engine keeps
    // its own 100ms safety limit, so larger scaled totals are fed in bounded
    // substeps. This makes 30fps and 60fps complete an approach identically.
    const visualDeltaMs = Math.min(
      Math.max(0, deltaMs),
      ROAD_MOTION.maxFrameDeltaMs,
    );
    const gameplayRate = currentGameplayRate();
    const playingDeltaMs = visualDeltaMs * gameplayRate;
    const stateBeforeUpdate = engine.state;
    if (engine.state === GAME_STATES.PLAYING) {
      advanceEngineByScaledTime(playingDeltaMs);
      // update() can auto-resolve the question (PLAYING → FEEDBACK) and the
      // engine resets its progress — re-check before adopting the value, or
      // the gates would flash back to the horizon on timed resolutions.
      if (engine.state === GAME_STATES.PLAYING) {
        gateVisualProgress = engine.gateProgress;
      } else if (engine.state === GAME_STATES.FEEDBACK) {
        gateVisualProgress = 1;
        world.gate.depth = gateCollisionDepth();
      }
    }
    const state = engine.state;
    const enteredFeedbackThisFrame =
      stateBeforeUpdate === GAME_STATES.PLAYING && state === GAME_STATES.FEEDBACK;

    if (currentScreen === 'game') {
      if (
        state === GAME_STATES.PLAYING &&
        !audioEventState.gateApproachPlayed &&
        gateVisualProgress >= AUDIO_GATE_APPROACH_PROGRESS
      ) {
        audioEventState.gateApproachPlayed = true;
        audioManager.play('gateApproach');
      }
      const visualStateActive =
        state === GAME_STATES.PLAYING || state === GAME_STATES.FEEDBACK;
      if (!visualStateActive) {
        setDecisionFocus(false);
        updateDebugBar(now);
        return;
      }
      const realDt = visualDeltaMs / 1000;
      // The resolve frame draws the gate at the collision plane. Begin the
      // physical pass clock on the following frame so a 30fps/slow frame
      // cannot silently consume most of the readable 160ms pass-through.
      const gateRealDt = enteredFeedbackThisFrame ? 0 : realDt;
      const gateTravelDt = gateRealDt * gameplayRate;
      const feedbackTimeBeforeFrame = world.feedbackT;

      // Gate exit first: it owns the feedback clock (feedbackT).
      updateGateVisual(gateRealDt, gateTravelDt, state);

      // One authoritative rate drives scenery, markers, details, dust and
      // coins. No gate-distance term can alter it during PLAYING.
      const feedbackRate = updateRoadMotionRate(state, feedbackTimeBeforeFrame);
      const effectiveWorldRate = gameplayRate * feedbackRate;
      // Native video changes only on the pass/crawl boundary. It receives no
      // per-frame playbackRate or currentTime writes.
      if (
        state === GAME_STATES.FEEDBACK &&
        roadsideVideoState.ratePhase !== roadsideVideoRatePhase(state, feedbackRate)
      ) syncRoadsideVideoPlayback();
      setDecisionFocus(
        state === GAME_STATES.PLAYING &&
        gateVisualProgress >= PLAYER_FLIGHT.decisionFocusProgress,
      );
      updatePlayerFlightAnimation(visualDeltaMs, state);

      if (effectiveWorldRate > 0) {
        updateWorldMotion(realDt, effectiveWorldRate);
        updateCoins(
          visualDeltaMs * effectiveWorldRate,
          realDt,
          effectiveWorldRate,
          state,
        );
      }
      const gateFrameGeometry = getGateFrameGeometry();
      renderGates(gateFrameGeometry);
      renderLaneGuides(gateFrameGeometry);
      updateDebugBar(now);

      if (
        state === GAME_STATES.FEEDBACK &&
        world.feedbackT >= feedbackPoseSettleSeconds()
      ) {
        settlePlayerFlightPose();
        dom.screenGame.classList.add('is-world-idle');
        stopLoop();
      }
    }
  } catch (error) {
    fatalError('The game loop hit an unexpected error. Progress in localStorage is untouched.', error);
  }
}

/* ========================================================================
 * Boot
 * ====================================================================== */

dom.loaderRetry.addEventListener('click', () => {
  if (dom.loaderRetry.dataset.action === 'reload') {
    window.location.reload();
    return;
  }
  void bootGame();
});

configureRoadsideVideos();
void bootGame();
