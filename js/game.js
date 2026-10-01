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
 * Runner geometry. Ground lines are percentages of the runner field; lane
 * x positions are owned by the CSS custom properties --lane-x-0/1/2 on
 * .runner (so phone/desktop road layouts live in one place) and only READ
 * here by readLaneX().
 */
const RUNNER_GEO = {
  horizonY: 17, // gate ground line where gates spawn (near the horizon)
  collisionY: 86, // gate ground line at the collision moment (player sits at 84)
  convergence: 0.42, // how much lanes converge at the horizon (0..1)
  farScale: 0.3,
  nearScale: 1.0,
  farOpacity: 0.6,
  /** Visual size in px below which labels get a counter-scale boost. */
  minLabelPx: 12,
  maxLabelBoost: 2.4,
};

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
  const running = to === GAME_STATES.PLAYING;
  // The fox runs only while the engine is in PLAYING; every other state
  // freezes the current frame (bob and shadow animations stop too).
  dom.player.classList.toggle('is-running', running);
  switch (to) {
    case GAME_STATES.READY:
      showScreen('start');
      break;
    case GAME_STATES.PLAYING:
      renderPause(false);
      hideFeedback();
      showScreen('game');
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
let laneXFractions = [0.31, 0.5, 0.69];

function readLaneX() {
  const style = getComputedStyle(dom.runner);
  const read = (name, fallback) => {
    const raw = parseFloat(style.getPropertyValue(name));
    return Number.isFinite(raw) ? raw / 100 : fallback;
  };
  laneXFractions = [
    read('--lane-x-0', 0.31),
    read('--lane-x-1', 0.5),
    read('--lane-x-2', 0.69),
  ];
}

/** Base label font in px per gate (unscaled cqw size), refreshed on resize. */
let gateLabelBasePx = [0, 0, 0];

function refreshGateLabelBase() {
  gateEls.forEach((gate, i) => {
    const label = gate.querySelector('.answer-gate__label');
    gateLabelBasePx[i] = parseFloat(getComputedStyle(label).fontSize) || 0;
  });
}

function renderGates() {
  const laneMap = engine.laneMap;
  if (!laneMap || laneMap.length === 0) return;
  // Container-query sizes only resolve on screen — measure lazily on the
  // first visible frame rather than while #screen-game is display:none.
  if (gateLabelBasePx.every((px) => px === 0)) refreshGateLabelBase();
  const { horizonY, collisionY, convergence, farScale, nearScale, farOpacity, minLabelPx, maxLabelBoost } =
    RUNNER_GEO;
  const p = gateVisualProgress;
  const scale = farScale + (nearScale - farScale) * p;

  for (let lane = 0; lane < 3; lane += 1) {
    // Lane spread: squeezed toward the vanishing point at the horizon, opening
    // to the real road lanes (CSS --lane-x-*) by the collision moment.
    const farX = 0.5 + (laneXFractions[lane] - 0.5) * convergence;
    const x = farX + (laneXFractions[lane] - farX) * p;
    const y = horizonY + (collisionY - horizonY) * p;

    const el = gateEls[lane];
    // (x, y) is the gate's ground point: bottom-centered, standing on the road.
    el.style.left = `${x * 100}%`;
    el.style.top = `${y}%`;
    el.style.transform = `translate(-50%, -100%) scale(${scale.toFixed(4)})`;
    el.style.opacity = (farOpacity + (1 - farOpacity) * p).toFixed(3);
    el.style.zIndex = String(1 + Math.round(p * 3)); // always below the player (z 5)
    // Contact shadow reads stronger as the gate gets close.
    el.style.setProperty('--gate-shadow-o', (0.22 + 0.4 * p).toFixed(3));

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

  // -- responsive geometry: lane spread + label metrics follow CSS breakpoints --
  readLaneX();
  refreshGateLabelBase();
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      readLaneX();
      refreshGateLabelBase();
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
 * 15. Animation loop (single rAF; the engine owns timing & collision)
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
    if (engine && engine.state === GAME_STATES.PLAYING) {
      engine.update(deltaMs); // engine clamps huge deltas (tab switches) itself
      gateVisualProgress = engine.gateProgress;
      updatePlayerAnimation(deltaMs); // same loop, same delta — presentation only
    }
    if (engine && currentScreen === 'game') {
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

// TEMPORARY QA hook (removed after visual QA): open the game with #qa to
// render gates at an arbitrary gateProgress without waiting for realtime
// gameplay. Engine is untouched; it only re-renders presentation.
if (typeof window !== 'undefined' && window.location.hash === '#qa') {
  window.__qa = {
    play: () => document.getElementById('btn-play').click(),
    renderAt: (p) => {
      gateVisualProgress = Math.min(1, Math.max(0, p));
      renderGates();
    },
  };
}

init();
