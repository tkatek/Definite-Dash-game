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

const DEBUG = true; // prototype phase: centralized logging + debug bar; flip off later

const DATA_URL = 'data/game-data.json';

/** Display labels for the three engine categories (display concern only). */
const CATEGORY_LABELS = {
  definite: 'THE',
  indefinite: 'A / AN',
  none: 'NO ARTICLE',
};

/** Runner geometry in percentages of the runner field. */
const RUNNER_GEO = {
  horizonTop: 14, // where gates spawn (near the horizon)
  playerTop: 84, // player lane line
  convergence: 0.22, // how much lanes converge at the horizon
  gateScaleMin: 0.32,
  gateScaleRange: 0.8,
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

const gateEls = [...dom.gatesRoot.querySelectorAll('.gate')];

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
  renderLevelList();
  showScreen('start');
  startLoop();
}

/** A fresh engine instance (READY state) sharing the same persisted progress. */
function recreateEngine() {
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
    clearStartNote();
    updateHud();
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
  switch (to) {
    case GAME_STATES.READY:
      showScreen('start');
      break;
    case GAME_STATES.PLAYING:
      dom.overlayPause.classList.add('hidden');
      hideFeedback();
      showScreen('game');
      break;
    case GAME_STATES.FEEDBACK:
      showScreen('game');
      break;
    case GAME_STATES.PAUSED:
      dom.overlayPause.classList.remove('hidden');
      break;
    case GAME_STATES.LEVEL_COMPLETE:
      dom.overlayPause.classList.add('hidden');
      renderLevelList();
      showScreen('complete');
      break;
    case GAME_STATES.GAME_OVER:
      dom.overlayPause.classList.add('hidden');
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

/* ========================================================================
 * 8. HUD rendering
 * ====================================================================== */

function updateHud() {
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

  // Lane labels follow the engine's randomized lane map — never a fixed order.
  payload.laneMap.forEach((category, lane) => {
    const gate = gateEls[lane];
    gate.dataset.category = category;
    gate.querySelector('.gate-label').textContent = CATEGORY_LABELS[category] ?? category;
    gate.classList.remove('is-chosen', 'is-correct', 'is-wrong');
  });

  renderPlayer(payload.playerLane);
  highlightChosenGate(payload.playerLane);
  hideFeedback();
  dom.player.classList.remove('player-correct', 'player-wrong');
  updateHud();
}

function renderPlayer(lane) {
  const x = ((lane + 0.5) / 3) * 100;
  dom.player.style.left = `${x}%`;
}

function highlightChosenGate(lane) {
  gateEls.forEach((gate, index) => gate.classList.toggle('is-chosen', index === lane));
}

function renderGates() {
  const laneMap = engine.laneMap;
  if (!laneMap || laneMap.length === 0) return;
  const { horizonTop, playerTop, convergence, gateScaleMin, gateScaleRange } = RUNNER_GEO;
  const p = gateVisualProgress;

  for (let lane = 0; lane < 3; lane += 1) {
    const bottomX = (lane + 0.5) / 3;
    const topX = 0.5 + (bottomX - 0.5) * convergence;
    const x = topX + (bottomX - topX) * p;
    const y = horizonTop + (playerTop - 6 - horizonTop) * p;
    const scale = gateScaleMin + gateScaleRange * p;
    const el = gateEls[lane];
    el.style.left = `${x * 100}%`;
    el.style.top = `${y}%`;
    el.style.transform = `translate(-50%, -50%) scale(${scale.toFixed(3)})`;
    el.style.opacity = (0.55 + 0.45 * p).toFixed(2);
    el.style.zIndex = String(1 + Math.round(p * 3));
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
  updateHud();
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
    dom.overlayPause.classList.add('hidden');
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
 * 14. Animation loop (single rAF; the engine owns timing & collision)
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

init();
