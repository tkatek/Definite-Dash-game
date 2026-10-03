/* ==========================================================================
 * Article Runner — engine.test.js
 * --------------------------------------------------------------------------
 * Deep automated test suite for js/engine.js using node:test and
 * node:assert/strict. No external test framework, no real delays: timing is
 * simulated with injected clocks and deterministic random sequences, so the
 * whole suite runs in well under a second.
 * ========================================================================== */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import gameData from '../data/game-data.json' with { type: 'json' };
import {
  ArticleRunnerEngine,
  ANSWER_CATEGORIES,
  GAME_MODES,
  GAME_STATES,
  StorageAdapter,
  EventBus,
  createRng,
  LANE_COUNT,
  START_LANE,
  PROGRESS_STORAGE_KEY,
} from '../js/engine.js';

/* ------------------------------------------------------------------------
 * Shortcuts & helpers
 * ---------------------------------------------------------------------- */

const SC = gameData.scoring;
const STAR = gameData.starRules;

const ALL_CATEGORIES = [ANSWER_CATEGORIES.NONE, ANSWER_CATEGORIES.DEFINITE, ANSWER_CATEGORIES.INDEFINITE];

const questionById = new Map(gameData.questions.map((q) => [q.id, q]));
const correctCategoryFor = (id) => questionById.get(id).answer.category;
const wrongCategoryFor = (id) => ALL_CATEGORIES.find((c) => c !== correctCategoryFor(id));

const SLOW_MS = 10000; // beyond fastBonusWindowMs -> no speed/perfect bonus
const FAST_MS = 1500;  // at perfectWindowMs boundary -> perfect bonus + partial speed bonus

function cloneData() {
  return JSON.parse(JSON.stringify(gameData));
}

function constantRng(value) {
  return () => value;
}

function sequenceRng(values) {
  let i = 0;
  return () => values[i++ % values.length];
}

function seededRng(seed) {
  return createRng(seed);
}

function createClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    advance(ms) {
      t += ms;
      return t;
    },
    get value() {
      return t;
    },
  };
}

function createMemoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      map.set(key, String(value));
    },
    removeItem: (key) => {
      map.delete(key);
    },
    clear: () => map.clear(),
    _map: map,
  };
}

function makeEngine(overrides = {}) {
  const clock = overrides.clock ?? createClock();
  const engine = new ArticleRunnerEngine({
    data: overrides.data ?? cloneData(),
    rng: overrides.rng ?? constantRng(0),
    storage: overrides.storage ?? createMemoryStorage(),
    now: clock.now,
    mode: overrides.mode,
  });
  return { engine, clock };
}

function seededStorage(progress) {
  const storage = createMemoryStorage();
  storage.setItem(PROGRESS_STORAGE_KEY, JSON.stringify(progress));
  return storage;
}

/** Answer the currently loaded question once (correct or wrong). */
function answerOnce(engine, clock, { correct = true, advanceMs = SLOW_MS } = {}) {
  const snap = engine.getSnapshot();
  assert.ok(snap.question, 'a question must be loaded before answering');
  const category = correct
    ? correctCategoryFor(snap.question.id)
    : wrongCategoryFor(snap.question.id);
  clock.advance(advanceMs);
  engine.chooseCategory(category);
  return engine.submitCurrentLane();
}

/** Advance both the injected clock and the clamped engine gate to collision. */
function runGateToCollision(engine, clock, stepMs = 100) {
  let guard = 0;
  while (engine.state === GAME_STATES.PLAYING && guard < 300) {
    clock.advance(stepMs);
    engine.update(stepMs);
    guard += 1;
  }
  assert.equal(engine.state, GAME_STATES.FEEDBACK, 'gate should resolve within the guard');
  return engine.getSnapshot().lastResult;
}

/** Play a whole level; pattern true/false per question (default all correct). */
function runLevel(engine, clock, { pattern = [], advanceMs = SLOW_MS } = {}) {
  const results = [];
  let summary = null;
  let outcome = null;
  while (engine.state === GAME_STATES.PLAYING) {
    const wantCorrect = results.length < pattern.length ? !!pattern[results.length] : true;
    results.push(answerOnce(engine, clock, { correct: wantCorrect, advanceMs }));
    const step = engine.continueAfterFeedback();
    if (step.summary) {
      summary = step.summary;
      outcome = step.status;
    }
  }
  return { results, summary, outcome };
}

function runLevelTrace(engine, clock, { correct = true, advanceMs = SLOW_MS } = {}) {
  const trace = [];
  while (engine.state === GAME_STATES.PLAYING) {
    const question = engine.getSnapshot().question;
    const canonical = questionById.get(question.id);
    assert.ok(canonical, `unknown question ${question.id}`);
    const result = answerOnce(engine, clock, { correct, advanceMs });
    trace.push({
      id: question.id,
      rule: question.rule,
      category: canonical.answer.category,
      article: canonical.answer.article,
      result,
    });
    engine.continueAfterFeedback();
  }
  return trace;
}

function categoryCounts(trace) {
  return Object.fromEntries(
    ALL_CATEGORIES.map((category) => [category, trace.filter((entry) => entry.category === category).length])
  );
}

function longestCategoryRun(trace) {
  let longest = 0;
  let current = 0;
  let previous = null;
  for (const entry of trace) {
    current = entry.category === previous ? current + 1 : 1;
    previous = entry.category;
    longest = Math.max(longest, current);
  }
  return longest;
}

function hasRepeatingCategoryPattern(trace) {
  const categories = trace.map((entry) => entry.category);
  for (let i = 5; i < categories.length; i += 1) {
    const sequence = categories.slice(i - 5, i + 1);
    const repeatsTwo =
      sequence[0] === sequence[2] &&
      sequence[2] === sequence[4] &&
      sequence[1] === sequence[3] &&
      sequence[3] === sequence[5] &&
      sequence[0] !== sequence[1];
    const repeatsThree =
      sequence[0] === sequence[3] &&
      sequence[1] === sequence[4] &&
      sequence[2] === sequence[5] &&
      new Set(sequence.slice(0, 3)).size === 3;
    if (repeatsTwo || repeatsThree) return true;
  }
  return false;
}

function traceForLevel(levelId, seed, { storage, correct = true } = {}) {
  const made = makeEngine({ rng: seededRng(seed), storage });
  made.engine.startLevel(levelId, { ignoreLock: true });
  return runLevelTrace(made.engine, made.clock, { correct });
}

function expectedMultiplier(streakBefore) {
  return Math.round(Math.min(SC.maxStreakMultiplier, 1 + streakBefore * SC.streakStep) * 100) / 100;
}

function expectedSlowPoints(streakBefore) {
  return Math.round(SC.baseCorrect * expectedMultiplier(streakBefore));
}

const isPermutationOfCategories = (lanes) =>
  Array.isArray(lanes) &&
  lanes.length === 3 &&
  ALL_CATEGORIES.every((c) => lanes.filter((lane) => lane === c).length === 1);

/* ========================================================================
 * 1. Public constants & exports
 * ====================================================================== */

describe('public constants and exports', () => {
  test('ANSWER_CATEGORIES exposes exactly none, definite and indefinite', () => {
    assert.deepEqual({ ...ANSWER_CATEGORIES }, { NONE: 'none', DEFINITE: 'definite', INDEFINITE: 'indefinite' });
  });

  test('GAME_MODES exposes learn and arcade only', () => {
    assert.deepEqual({ ...GAME_MODES }, { LEARN: 'learn', ARCADE: 'arcade' });
  });

  test('GAME_STATES exposes the seven documented states', () => {
    assert.deepEqual(
      { ...GAME_STATES },
      {
        BOOT: 'BOOT',
        READY: 'READY',
        PLAYING: 'PLAYING',
        FEEDBACK: 'FEEDBACK',
        PAUSED: 'PAUSED',
        LEVEL_COMPLETE: 'LEVEL_COMPLETE',
        GAME_OVER: 'GAME_OVER',
      }
    );
  });

  test('lane geometry: three lanes, character starts in the center', () => {
    assert.equal(LANE_COUNT, 3);
    assert.equal(START_LANE, 1);
  });

  test('engine, storage adapter and event bus are exported constructors', () => {
    assert.equal(typeof ArticleRunnerEngine, 'function');
    assert.equal(typeof StorageAdapter, 'function');
    assert.equal(typeof EventBus, 'function');
  });
});

/* ========================================================================
 * 2. Static data validation (validateData)
 * ====================================================================== */

describe('validateData', () => {
  test('accepts the shipped game-data.json', () => {
    assert.deepEqual(ArticleRunnerEngine.validateData(gameData), { ok: true });
  });

  test('rejects null data', () => {
    assert.throws(() => ArticleRunnerEngine.validateData(null), /plain object/);
  });

  test('rejects array or string roots', () => {
    assert.throws(() => ArticleRunnerEngine.validateData([]), /plain object/);
    assert.throws(() => ArticleRunnerEngine.validateData('nope'), /plain object/);
  });

  test('rejects missing levels array', () => {
    const data = cloneData();
    delete data.levels;
    assert.throws(() => ArticleRunnerEngine.validateData(data), /levels/);
  });

  test('rejects missing questions array', () => {
    const data = cloneData();
    data.questions = [];
    assert.throws(() => ArticleRunnerEngine.validateData(data), /questions/);
  });

  test('rejects missing ruleCatalog', () => {
    const data = cloneData();
    delete data.ruleCatalog;
    assert.throws(() => ArticleRunnerEngine.validateData(data), /ruleCatalog/);
  });

  test('rejects duplicate question ids', () => {
    const data = cloneData();
    data.questions[1].id = data.questions[0].id;
    assert.throws(() => ArticleRunnerEngine.validateData(data), /Duplicate question id/);
  });

  test('rejects a sentence without a blank', () => {
    const data = cloneData();
    data.questions[0].sentence = 'I saw a dog near the park yesterday.';
    assert.throws(() => ArticleRunnerEngine.validateData(data), /exactly one/);
  });

  test('rejects a sentence with two blanks', () => {
    const data = cloneData();
    data.questions[0].sentence = 'I saw ___ dog near ___ park yesterday.';
    assert.throws(() => ArticleRunnerEngine.validateData(data), /exactly one/);
  });

  test('rejects a question referencing an unknown rule', () => {
    const data = cloneData();
    data.questions[0].rule = 'does-not-exist';
    assert.throws(() => ArticleRunnerEngine.validateData(data), /unknown rule/);
  });

  test('rejects an invalid answer category', () => {
    const data = cloneData();
    data.questions[0].answer.category = 'THE';
    assert.throws(() => ArticleRunnerEngine.validateData(data), /invalid answer.category/);
  });

  test("rejects a 'none' answer carrying the article 'the'", () => {
    const data = cloneData();
    const q = data.questions.find((entry) => entry.answer.category === 'none');
    q.answer.article = 'the';
    assert.throws(() => ArticleRunnerEngine.validateData(data), /not coherent/);
  });

  test("rejects an 'indefinite' answer carrying the article 'the'", () => {
    const data = cloneData();
    data.questions[0].answer.article = 'the';
    assert.throws(() => ArticleRunnerEngine.validateData(data), /not coherent/);
  });

  test("rejects a 'definite' answer carrying the article 'a'", () => {
    const data = cloneData();
    const q = data.questions.find((entry) => entry.answer.category === 'definite');
    q.answer.article = 'a';
    assert.throws(() => ArticleRunnerEngine.validateData(data), /not coherent/);
  });

  test('rejects a level referencing an unknown rule', () => {
    const data = cloneData();
    data.levels[0].rules = ['made-up-rule'];
    assert.throws(() => ArticleRunnerEngine.validateData(data), /references unknown rule/);
  });

  test('rejects a level with no eligible questions', () => {
    const data = cloneData();
    data.levels[0].rules = ['definite-instruments']; // exists, but nothing eligible for level 1
    data.levels[0].contrastRules = [];
    assert.throws(() => ArticleRunnerEngine.validateData(data), /no eligible questions/);
  });

  test('rejects unknown contrast rules and category targets that do not sum to one', () => {
    const badContrast = cloneData();
    badContrast.levels[0].contrastRules = ['made-up-contrast'];
    assert.throws(() => ArticleRunnerEngine.validateData(badContrast), /contrastRules references unknown rule/);

    const badTargets = cloneData();
    badTargets.levels[0].categoryTargets.none = 0.5;
    assert.throws(() => ArticleRunnerEngine.validateData(badTargets), /categoryTargets must sum to 1/);
  });

  test('rejects broken scoring configuration', () => {
    const data = cloneData();
    data.scoring.baseCorrect = 0;
    assert.throws(() => ArticleRunnerEngine.validateData(data), /scoring/);
  });

  test('rejects out-of-order star thresholds', () => {
    const data = cloneData();
    data.starRules.threeStarsAccuracy = 0.5; // below twoStarsAccuracy
    assert.throws(() => ArticleRunnerEngine.validateData(data), /ordered/);
  });

  test('combines multiple problems into one error message', () => {
    const data = cloneData();
    data.questions[0].sentence = 'No blank here.'; // problem 1
    data.questions[1].rule = 'ghost-rule'; // problem 2
    assert.throws(
      () => ArticleRunnerEngine.validateData(data),
      (error) => {
        assert.match(error.message, /2 problem\(s\)/);
        assert.match(error.message, /exactly one/);
        assert.match(error.message, /unknown rule/);
        return true;
      }
    );
  });
});

/* ========================================================================
 * 3. Dataset integrity of game-data.json itself
 * ====================================================================== */

describe('game-data.json integrity', () => {
  test('every question id is unique', () => {
    const ids = gameData.questions.map((q) => q.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  test('every sentence contains exactly one blank', () => {
    for (const q of gameData.questions) {
      assert.equal(q.sentence.split('___').length - 1, 1, `question ${q.id}`);
    }
  });

  test('every answer is coherent with its category', () => {
    const allowed = { none: [''], definite: ['the'], indefinite: ['a', 'an'] };
    for (const q of gameData.questions) {
      assert.ok(allowed[q.answer.category], `question ${q.id} category`);
      assert.ok(
        allowed[q.answer.category].includes(q.answer.article),
        `question ${q.id} article ${q.answer.article} for ${q.answer.category}`
      );
    }
  });

  test('every question, primary level rule and contrast rule references the catalog', () => {
    const ruleIds = new Set(gameData.ruleCatalog.map((r) => r.id));
    for (const q of gameData.questions) assert.ok(ruleIds.has(q.rule), `question ${q.id}`);
    for (const level of gameData.levels) {
      const contrastRules = level.contrastRules ?? [];
      assert.ok(Array.isArray(contrastRules), `level ${level.id} contrastRules`);
      for (const rule of [...level.rules, ...contrastRules]) {
        assert.ok(rule === '*' || ruleIds.has(rule), `level ${level.id} rule ${rule}`);
      }
    }
  });

  test('every level defines positive category targets that sum to one', () => {
    const expectedCategories = [...ALL_CATEGORIES].sort();
    for (const level of gameData.levels) {
      assert.deepEqual(Object.keys(level.categoryTargets).sort(), expectedCategories, `level ${level.id} categories`);
      for (const category of ALL_CATEGORIES) {
        assert.ok(level.categoryTargets[category] > 0, `level ${level.id} ${category} target`);
      }
      const total = Object.values(level.categoryTargets).reduce((sum, target) => sum + target, 0);
      assert.ok(Math.abs(total - 1) < 1e-9, `level ${level.id} targets total ${total}`);
    }
  });

  test('every question category matches its rule catalog category', () => {
    const rules = new Map(gameData.ruleCatalog.map((r) => [r.id, r]));
    for (const q of gameData.questions) {
      assert.equal(q.answer.category, rules.get(q.rule).category, `question ${q.id}`);
    }
  });

  test('every level has at least questionCount eligible questions', () => {
    for (const level of gameData.levels) {
      const wildcard = level.rules.includes('*');
      const eligible = gameData.questions.filter((q) => {
        if (q.levelMin > level.id) return false;
        return wildcard || level.rules.includes(q.rule);
      }).length;
      assert.ok(
        eligible >= level.questionCount,
        `level ${level.id} has ${eligible} eligible but wants ${level.questionCount}`
      );
    }
  });

  test('star thresholds and required accuracies are sane', () => {
    assert.ok(STAR.threeStarsAccuracy >= STAR.twoStarsAccuracy);
    assert.ok(STAR.twoStarsAccuracy >= STAR.oneStarAccuracy);
    for (const level of gameData.levels) {
      assert.ok(level.requiredAccuracy > 0 && level.requiredAccuracy <= 1, `level ${level.id}`);
      assert.ok(level.speed > 0, `level ${level.id} speed`);
    }
  });

  test('level unlock chain is a well-ordered sequence', () => {
    const ids = new Set(gameData.levels.map((l) => l.id));
    assert.equal(gameData.levels[0].unlockAfter, null);
    for (const level of gameData.levels) {
      if (level.unlockAfter !== null) assert.ok(ids.has(level.unlockAfter), `level ${level.id}`);
    }
  });
});

/* ========================================================================
 * 4. Boot & construction
 * ====================================================================== */

describe('boot and construction', () => {
  test('a fresh engine boots into READY with no level or question', () => {
    const { engine } = makeEngine();
    assert.equal(engine.state, GAME_STATES.READY);
    const snap = engine.getSnapshot();
    assert.equal(snap.level, null);
    assert.equal(snap.question, null);
    assert.equal(snap.session, null);
    assert.equal(snap.laneMap.length, 0);
  });

  test('construction without data throws', () => {
    assert.throws(() => new ArticleRunnerEngine({}), /requires game data/);
  });

  test('construction with an invalid default mode throws', () => {
    assert.throws(() => new ArticleRunnerEngine({ data: cloneData(), mode: 'zen' }), /Invalid mode/);
  });

  test('construction validates the data and rejects broken data', () => {
    const data = cloneData();
    data.questions[0].sentence = 'broken';
    assert.throws(() => new ArticleRunnerEngine({ data }), /Invalid game data/);
  });

  test('without a storage backend the engine falls back to memory storage', () => {
    const { engine } = makeEngine();
    engine.startLevel(1);
    assert.equal(engine.state, GAME_STATES.PLAYING);
    assert.ok(engine.getProgress());
  });
});

/* ========================================================================
 * 5. startLevel
 * ====================================================================== */

describe('startLevel', () => {
  test('unknown level ids are rejected', () => {
    const { engine } = makeEngine();
    assert.throws(() => engine.startLevel(99), /Unknown level/);
  });

  test('invalid modes are rejected', () => {
    const { engine } = makeEngine();
    assert.throws(() => engine.startLevel(1, { mode: 'hardcore' }), /Invalid mode/);
  });

  test('locked levels are rejected in Learn Mode', () => {
    const { engine } = makeEngine();
    assert.throws(() => engine.startLevel(2), /locked/);
  });

  test('ignoreLock bypasses the lock for testing', () => {
    const { engine } = makeEngine();
    engine.startLevel(2, { ignoreLock: true });
    assert.equal(engine.state, GAME_STATES.PLAYING);
    assert.equal(engine.getSnapshot().level.id, 2);
  });

  test('string level ids are accepted alongside numbers', () => {
    const { engine } = makeEngine();
    engine.startLevel('1');
    assert.equal(engine.getSnapshot().level.id, 1);
  });

  test('Arcade Mode ignores the Learn Mode lock', () => {
    const { engine } = makeEngine();
    engine.startLevel(6, { mode: GAME_MODES.ARCADE });
    assert.equal(engine.state, GAME_STATES.PLAYING);
  });

  test('a Learn Mode session has no lives', () => {
    const { engine } = makeEngine();
    engine.startLevel(1);
    const snap = engine.getSnapshot();
    assert.equal(snap.session.mode, GAME_MODES.LEARN);
    assert.equal(snap.lives, null);
    assert.equal(snap.session.questionIndex, 0);
    assert.equal(snap.session.totalQuestions, 8);
    assert.equal(snap.session.correct, 0);
    assert.equal(snap.session.wrong, 0);
    assert.equal(snap.session.answered, 0);
    assert.equal(typeof snap.session.levelId, 'number');
  });

  test('an Arcade Mode session starts with the configured lives', () => {
    const { engine } = makeEngine();
    engine.startLevel(1, { mode: GAME_MODES.ARCADE });
    assert.equal(engine.getSnapshot().lives, gameData.settings.startingLivesArcade);
  });

  test('starting a level from PLAYING or FEEDBACK is an invalid transition', () => {
    const { engine } = makeEngine();
    engine.startLevel(1);
    assert.throws(() => engine.startLevel(1), /Cannot start a level from state "PLAYING"/);
    const { engine: second } = makeEngine();
    second.startLevel(1);
    second.submitCurrentLane();
    assert.throws(() => second.startLevel(1), /FEEDBACK/);
  });

  test('starting a level mid-run is rejected, restartLevel handles that case', () => {
    const { engine, clock } = makeEngine();
    engine.startLevel(1);
    answerOnce(engine, clock);
    assert.ok(engine.score > 0);
    engine.continueAfterFeedback();
    assert.throws(() => engine.startLevel(1), /Cannot start a level from state "PLAYING"/);
    const snap = engine.restartLevel();
    assert.equal(snap.score, 0);
    assert.equal(snap.state, GAME_STATES.PLAYING);
  });

  test('starting a finished level again resets score and streak', () => {
    const { engine, clock } = makeEngine();
    engine.startLevel(1);
    runLevel(engine, clock);
    assert.equal(engine.state, GAME_STATES.LEVEL_COMPLETE);
    engine.startLevel(1);
    const snap = engine.getSnapshot();
    assert.equal(snap.score, 0);
    assert.equal(snap.streak, 0);
    assert.equal(snap.session.questionIndex, 0);
  });

  test('level:started is emitted with level id and mode', () => {
    const { engine } = makeEngine();
    const events = [];
    engine.on('level:started', (payload) => events.push(payload));
    engine.startLevel(1, { mode: GAME_MODES.LEARN });
    assert.equal(events.length, 1);
    assert.equal(events[0].level.id, 1);
    assert.equal(events[0].mode, GAME_MODES.LEARN);
    assert.equal(events[0].totalQuestions, 8);
  });
});

/* ========================================================================
 * 6. Question presentation & lane maps
 * ====================================================================== */

describe('question presentation and lane maps', () => {
  test('public question data hides the answer, explanation and completed sentence', () => {
    const { engine } = makeEngine();
    engine.startLevel(1);
    const question = engine.getPublicQuestion();
    assert.ok(question.id);
    assert.ok(question.sentence.includes('___'));
    assert.ok(question.cefr);
    assert.ok(question.rule);
    assert.ok(question.ruleLabel);
    assert.equal(typeof question.levelMin, 'number');
    assert.ok(!('answer' in question));
    assert.ok(!('completedSentence' in question));
    assert.ok(!('explanation' in question));
    const snapQuestion = engine.getSnapshot().question;
    assert.ok(!('answer' in snapQuestion));
    assert.ok(!('completedSentence' in snapQuestion));
  });

  test('question:loaded carries the public question, lane map and geometry', () => {
    const { engine } = makeEngine();
    const events = [];
    engine.on('question:loaded', (payload) => events.push(payload));
    engine.startLevel(1);
    assert.equal(events.length, 1);
    assert.equal(events[0].question.id, engine.getSnapshot().question.id);
    assert.equal(events[0].playerLane, START_LANE);
    assert.equal(events[0].questionNumber, 1);
    assert.equal(events[0].totalQuestions, 8);
    assert.equal(events[0].gateDurationMs, Math.round(1000 / gameData.levels[0].speed));
  });

  test('every lane map is a permutation of the three categories', () => {
    const { engine, clock } = makeEngine();
    engine.startLevel(1);
    const seen = [];
    for (let i = 0; i < 5; i++) {
      const snap = engine.getSnapshot();
      assert.ok(isPermutationOfCategories(snap.laneMap), `lane map ${i}`);
      seen.push(snap.laneMap.join('|'));
      answerOnce(engine, clock);
      engine.continueAfterFeedback();
    }
    assert.equal(seen.length, 5);
  });

  test('the correct category is always present exactly once', () => {
    const { engine, clock } = makeEngine();
    engine.startLevel(1);
    for (let i = 0; i < 3; i++) {
      const snap = engine.getSnapshot();
      const correct = correctCategoryFor(snap.question.id);
      assert.equal(snap.laneMap.filter((c) => c === correct).length, 1);
      answerOnce(engine, clock);
      engine.continueAfterFeedback();
    }
  });

  test('lane order is randomized per question, not fixed', () => {
    const maps = [];
    for (const seed of [0, 0.5, 0.99]) {
      const { engine } = makeEngine({ rng: constantRng(seed) });
      engine.startLevel(1);
      maps.push(engine.getSnapshot().laneMap.join('|'));
    }
    assert.equal(new Set(maps).size, 3, `expected three distinct lane orders, got ${maps}`);
  });

  test('a category does not live in one fixed lane across shuffles', () => {
    const lanesOfDefinite = [];
    for (const seed of [0, 0.5, 0.99]) {
      const { engine } = makeEngine({ rng: constantRng(seed) });
      engine.startLevel(1);
      lanesOfDefinite.push(engine.getSnapshot().laneMap.indexOf('definite'));
    }
    assert.equal(new Set(lanesOfDefinite).size, 3);
  });
});

/* ========================================================================
 * 7. Lane movement
 * ====================================================================== */

describe('lane movement', () => {
  test('moveToLane moves to a valid lane and returns true', () => {
    const { engine } = makeEngine();
    engine.startLevel(1);
    assert.equal(engine.moveToLane(0), true);
    assert.equal(engine.playerLane, 0);
    assert.equal(engine.moveToLane(2), true);
    assert.equal(engine.playerLane, 2);
  });

  test('moveToLane rejects invalid indexes', () => {
    const { engine } = makeEngine();
    engine.startLevel(1);
    for (const bad of [-1, 3, 7, 1.5, '1', null]) {
      assert.throws(() => engine.moveToLane(bad), RangeError, `index ${bad}`);
    }
  });

  test('moving to the current lane is a no-op without an event', () => {
    const { engine } = makeEngine();
    engine.startLevel(1);
    let events = 0;
    engine.on('player:lane-changed', () => events++);
    assert.equal(engine.moveToLane(START_LANE), false);
    assert.equal(events, 0);
  });

  test('moveLeft and moveRight work from the center and emit lane events', () => {
    const { engine } = makeEngine();
    const events = [];
    engine.on('player:lane-changed', (payload) => events.push(payload));
    engine.startLevel(1);
    const laneMap = engine.getSnapshot().laneMap;
    assert.equal(engine.moveLeft(), true);
    assert.equal(engine.playerLane, 0);
    assert.equal(engine.moveRight(), true);
    assert.equal(engine.moveRight(), true);
    assert.equal(engine.playerLane, 2);
    assert.deepEqual(events.map((e) => [e.from, e.to]), [
      [1, 0],
      [0, 1],
      [1, 2],
    ]);
    assert.equal(events[0].category, laneMap[0]);
  });

  test('movement clamps at the left and right edges', () => {
    const { engine } = makeEngine();
    engine.startLevel(1);
    assert.equal(engine.moveToLane(0), true);
    assert.equal(engine.moveLeft(), false);
    assert.equal(engine.playerLane, 0);
    assert.equal(engine.moveToLane(2), true);
    assert.equal(engine.moveRight(), false);
    assert.equal(engine.playerLane, 2);
  });

  test('chooseCategory moves to the lane showing that category', () => {
    const { engine } = makeEngine();
    engine.startLevel(1);
    const laneMap = engine.getSnapshot().laneMap;
    engine.chooseCategory(ANSWER_CATEGORIES.DEFINITE);
    assert.equal(engine.playerLane, laneMap.indexOf('definite'));
    engine.chooseCategory(ANSWER_CATEGORIES.NONE);
    assert.equal(engine.playerLane, laneMap.indexOf('none'));
  });

  test('chooseCategory rejects unknown categories', () => {
    const { engine } = makeEngine();
    engine.startLevel(1);
    assert.throws(() => engine.chooseCategory('maybe'), /Unknown answer category/);
  });

  test('movement is blocked outside an unlocked PLAYING state', () => {
    const ready = makeEngine().engine;
    assert.throws(() => ready.moveToLane(0), /READY/);
    assert.throws(() => ready.moveLeft(), /READY/);
    assert.throws(() => ready.chooseCategory('none'), /READY/);

    const { engine, clock } = makeEngine();
    engine.startLevel(1);
    answerOnce(engine, clock); // now FEEDBACK
    assert.throws(() => engine.moveToLane(0), /input is locked|FEEDBACK/);
    assert.throws(() => engine.moveLeft(), /input is locked|FEEDBACK/);
    assert.throws(() => engine.moveRight(), /input is locked|FEEDBACK/);
    assert.throws(() => engine.chooseCategory('none'), /input is locked|FEEDBACK/);

    engine.continueAfterFeedback();
    engine.pause();
    assert.throws(() => engine.moveToLane(0), /PAUSED/);
  });
});

/* ========================================================================
 * 8. Gate timing (update)
 * ====================================================================== */

describe('gate timing', () => {
  test('update advances gateProgress proportionally to elapsed time', () => {
    const { engine } = makeEngine();
    engine.startLevel(1);
    engine.update(100);
    const expected = gameData.levels[0].speed * 0.1; // 100 ms
    assert.ok(Math.abs(engine.gateProgress - expected) < 1e-12);
  });

  test('level speed comes from the JSON (levels differ)', () => {
    const first = makeEngine();
    first.engine.startLevel(1);
    first.engine.update(1000);
    const second = makeEngine();
    second.engine.startLevel(2, { ignoreLock: true });
    second.engine.update(1000);
    assert.ok(first.engine.gateProgress < second.engine.gateProgress);
    assert.ok(Math.abs(second.engine.gateProgress - gameData.levels[1].speed * 0.1) < 1e-12); // clamp applies
  });

  test('extreme frame deltas are clamped to 100 ms', () => {
    const { engine } = makeEngine();
    const ticks = [];
    engine.on('game:tick', (payload) => ticks.push(payload));
    engine.startLevel(1);
    engine.update(100000); // tab freeze
    assert.ok(Math.abs(engine.gateProgress - gameData.levels[0].speed * 0.1) < 1e-12);
    assert.equal(ticks[0].deltaMs, 100);
    assert.equal(ticks[0].requestedDeltaMs, 100000);
  });

  test('negative, zero and non-numeric deltas are ignored', () => {
    const { engine } = makeEngine();
    engine.startLevel(1);
    engine.update(-500);
    engine.update(0);
    engine.update(NaN);
    engine.update('100');
    assert.equal(engine.gateProgress, 0);
  });

  test('update is a no-op outside PLAYING', () => {
    const { engine } = makeEngine();
    engine.update(500); // READY
    assert.equal(engine.gateProgress, 0);
    engine.startLevel(1);
    engine.pause();
    engine.update(500); // PAUSED
    assert.equal(engine.gateProgress, 0);
  });

  test('game:tick reports the clamped delta and progress', () => {
    const { engine } = makeEngine();
    const ticks = [];
    engine.on('game:tick', (payload) => ticks.push(payload));
    engine.startLevel(1);
    engine.update(50);
    assert.equal(ticks.length, 1);
    assert.equal(ticks[0].deltaMs, 50);
    assert.ok(ticks[0].gateProgress > 0);
    assert.equal(ticks[0].playerLane, START_LANE);
  });

  test('reaching the gate auto-resolves the current lane as a collision', () => {
    const { engine } = makeEngine();
    engine.startLevel(1);
    const questionId = engine.getSnapshot().question.id;
    engine.chooseCategory(correctCategoryFor(questionId));
    let guard = 0;
    while (engine.state === GAME_STATES.PLAYING && guard < 300) {
      engine.update(100);
      guard += 1;
    }
    assert.equal(engine.state, GAME_STATES.FEEDBACK);
    const result = engine.getSnapshot().lastResult;
    assert.equal(result.automatic, true);
    assert.equal(result.isCorrect, true);
    assert.equal(engine.inputLocked, true);
  });

  test('a collision while in the wrong lane counts as wrong', () => {
    const { engine } = makeEngine();
    engine.startLevel(1);
    const questionId = engine.getSnapshot().question.id;
    const wrongCategory = wrongCategoryFor(questionId);
    engine.chooseCategory(wrongCategory);
    const selectedLane = engine.playerLane;
    let guard = 0;
    while (engine.state === GAME_STATES.PLAYING && guard < 300) {
      engine.update(100);
      guard += 1;
    }
    const result = engine.getSnapshot().lastResult;
    assert.equal(result.isCorrect, false);
    assert.equal(result.selectedLane, selectedLane);
    assert.equal(result.selectedCategory, wrongCategory);
  });
});

/* ========================================================================
 * 9. Answer resolution & scoring
 * ====================================================================== */

describe('answer resolution and scoring', () => {
  test('a correct answer produces a complete result object', () => {
    const { engine, clock } = makeEngine();
    engine.startLevel(1);
    const result = answerOnce(engine, clock, { correct: true });
    const expectedKeys = [
      'questionId', 'selectedLane', 'selectedCategory', 'correctCategory', 'correctArticle',
      'isCorrect', 'automatic', 'responseMs', 'explanation', 'completedSentence', 'rule',
      'ruleLabel', 'pointsGained', 'speedBonus', 'perfectBonus', 'streakMultiplier',
      'totalScore', 'streak', 'bestStreak', 'livesRemaining', 'questionIndex',
      'totalQuestions', 'feedbackDelayMs',
    ];
    for (const key of expectedKeys) assert.ok(key in result, `missing result field ${key}`);
    assert.equal(result.isCorrect, true);
    assert.equal(result.automatic, false);
    assert.equal(result.streak, 1);
    assert.equal(result.totalScore, result.pointsGained);
    assert.ok(result.explanation.length > 0);
    assert.ok(result.completedSentence.length > 0);
  });

  test('the selected lane and its category are recorded in the result', () => {
    const { engine, clock } = makeEngine();
    engine.startLevel(1);
    const laneMap = engine.getSnapshot().laneMap;
    engine.moveToLane(2);
    clock.advance(SLOW_MS);
    const result = engine.submitCurrentLane();
    assert.equal(result.selectedLane, 2);
    assert.equal(result.selectedCategory, laneMap[2]);
  });

  test('the exact canonical article is preserved after resolution', () => {
    const trace = traceForLevel(1, 0xa11ce);
    for (const entry of trace) {
      assert.equal(entry.result.correctArticle, entry.article, entry.id);
      assert.equal(entry.result.completedSentence, questionById.get(entry.id).completedSentence, entry.id);
    }
  });

  test('a wrong answer scores zero, resets the streak and keeps lives untouched in Learn Mode', () => {
    const { engine, clock } = makeEngine();
    engine.startLevel(1);
    answerOnce(engine, clock, { correct: true });
    engine.continueAfterFeedback();
    const wrong = answerOnce(engine, clock, { correct: false });
    assert.equal(wrong.isCorrect, false);
    assert.equal(wrong.pointsGained, 0);
    assert.equal(wrong.streak, 0);
    assert.equal(wrong.livesRemaining, null); // Learn Mode never removes lives
    assert.equal(engine.getSnapshot().streak, 0);
  });

  test('the best streak survives a wrong answer', () => {
    const { engine, clock } = makeEngine();
    engine.startLevel(1);
    for (let i = 0; i < 3; i++) {
      answerOnce(engine, clock);
      engine.continueAfterFeedback();
    }
    answerOnce(engine, clock, { correct: false });
    const snap = engine.getSnapshot();
    assert.equal(snap.streak, 0);
    assert.equal(snap.bestStreak, 3);
    assert.equal(snap.lastResult.bestStreak, 3);
  });

  test('response time comes from the injected clock', () => {
    const { engine, clock } = makeEngine();
    engine.startLevel(1);
    const result = answerOnce(engine, clock, { advanceMs: 2500 });
    assert.equal(result.responseMs, 2500);
  });

  test('a slow correct answer earns exactly the base points times multiplier', () => {
    const { engine, clock } = makeEngine();
    engine.startLevel(1);
    const result = answerOnce(engine, clock, { advanceMs: SLOW_MS });
    assert.equal(result.speedBonus, 0);
    assert.equal(result.perfectBonus, 0);
    assert.equal(result.pointsGained, expectedSlowPoints(0));
    assert.equal(result.pointsGained, SC.baseCorrect);
  });

  test('a fast answer earns speed and perfect bonuses', () => {
    const { engine, clock } = makeEngine();
    engine.startLevel(1);
    const result = answerOnce(engine, clock, { advanceMs: FAST_MS });
    assert.equal(result.perfectBonus, SC.perfectQuestionBonus);
    const expectedSpeed = Math.round(SC.fastBonusMax * (1 - FAST_MS / SC.fastBonusWindowMs));
    assert.equal(result.speedBonus, expectedSpeed);
    assert.equal(result.pointsGained, Math.round((SC.baseCorrect + expectedSpeed + SC.perfectQuestionBonus) * 1));
  });

  test('an early lane decision earns reachable bonuses when the gate later resolves it', () => {
    const { engine, clock } = makeEngine();
    engine.startLevel(1);
    clock.advance(FAST_MS);
    engine.chooseCategory(correctCategoryFor(engine.getSnapshot().question.id));
    const result = runGateToCollision(engine, clock);
    assert.equal(result.automatic, true);
    assert.equal(result.responseMs, FAST_MS);
    assert.equal(result.perfectBonus, SC.perfectQuestionBonus);
    assert.ok(result.speedBonus > 0);
  });

  test('a lucky untouched center lane earns no speed or perfect bonus at collision', () => {
    const { engine, clock } = makeEngine({ rng: constantRng(0.6) });
    engine.startLevel(1);
    const snap = engine.getSnapshot();
    assert.equal(snap.laneMap[START_LANE], correctCategoryFor(snap.question.id));
    const result = runGateToCollision(engine, clock);
    assert.equal(result.isCorrect, true);
    assert.equal(result.speedBonus, 0);
    assert.equal(result.perfectBonus, 0);
    assert.ok(result.responseMs > SC.fastBonusWindowMs);
  });

  test('a same-lane answer tap records an intentional decision', () => {
    const { engine, clock } = makeEngine({ rng: constantRng(0.6) });
    engine.startLevel(1);
    const snap = engine.getSnapshot();
    const category = snap.laneMap[START_LANE];
    assert.equal(category, correctCategoryFor(snap.question.id));
    clock.advance(900);
    assert.equal(engine.chooseCategory(category), false);
    const result = runGateToCollision(engine, clock);
    assert.equal(result.responseMs, 900);
    assert.equal(result.perfectBonus, SC.perfectQuestionBonus);
  });

  test('collision scoring follows the final lane decision time and resets per question', () => {
    const { engine, clock } = makeEngine();
    engine.startLevel(1);
    const first = engine.getSnapshot().question.id;
    clock.advance(400);
    engine.chooseCategory(correctCategoryFor(first));
    clock.advance(900);
    engine.chooseCategory(wrongCategoryFor(first));
    clock.advance(1700);
    engine.chooseCategory(correctCategoryFor(first));
    const firstResult = runGateToCollision(engine, clock);
    assert.equal(firstResult.responseMs, 3000);

    engine.continueAfterFeedback();
    const secondResult = runGateToCollision(engine, clock);
    assert.ok(secondResult.responseMs > SC.fastBonusWindowMs);
    assert.equal(secondResult.speedBonus, 0);
  });

  test('fast answers outscore slow answers', () => {
    const slow = makeEngine();
    slow.engine.startLevel(1);
    const slowResult = answerOnce(slow.engine, slow.clock, { advanceMs: SLOW_MS });
    const fast = makeEngine();
    fast.engine.startLevel(1);
    const fastResult = answerOnce(fast.engine, fast.clock, { advanceMs: 500 });
    assert.ok(fastResult.pointsGained > slowResult.pointsGained);
  });

  test('the streak multiplier grows gradually with consecutive correct answers', () => {
    const { engine, clock } = makeEngine();
    engine.startLevel(1);
    const results = [];
    for (let i = 0; i < 5; i++) {
      results.push(answerOnce(engine, clock, { advanceMs: SLOW_MS }));
      engine.continueAfterFeedback();
    }
    for (let i = 0; i < 5; i++) {
      assert.equal(results[i].streakMultiplier, expectedMultiplier(i));
      assert.equal(results[i].pointsGained, expectedSlowPoints(i));
      assert.equal(results[i].streak, i + 1);
    }
  });

  test('the streak multiplier is capped by the configured maximum', () => {
    const { engine, clock } = makeEngine();
    engine.startLevel(10, { ignoreLock: true }); // 12 questions: enough to reach the cap
    const { results } = runLevel(engine, clock);
    assert.equal(results.length, 12);
    assert.equal(results[10].streakMultiplier, SC.maxStreakMultiplier);
    assert.equal(results[11].streakMultiplier, SC.maxStreakMultiplier);
    assert.equal(results[11].pointsGained, Math.round(SC.baseCorrect * SC.maxStreakMultiplier));
  });

  test('each answer advances the question index exactly once', () => {
    const { engine, clock } = makeEngine();
    engine.startLevel(1);
    answerOnce(engine, clock);
    assert.equal(engine.getSnapshot().session.questionIndex, 1);
    assert.equal(engine.getSnapshot().session.answered, 1);
    engine.continueAfterFeedback();
    answerOnce(engine, clock);
    assert.equal(engine.getSnapshot().session.questionIndex, 2);
  });

  test('a perfect slow level run totals the exact expected score', () => {
    const { engine, clock } = makeEngine();
    engine.startLevel(1);
    const { summary } = runLevel(engine, clock);
    const expected = Array.from({ length: 8 }, (_, i) => expectedSlowPoints(i)).reduce((a, b) => a + b, 0);
    assert.equal(summary.score, expected);
    assert.equal(summary.score, 1080);
  });

  test('attempts are recorded into long-term mastery immediately', () => {
    const { engine, clock } = makeEngine();
    engine.startLevel(1);
    const rule = engine.getSnapshot().question.rule;
    answerOnce(engine, clock);
    const mastery = engine.getMastery(rule);
    assert.equal(mastery.attempts, 1);
    assert.equal(mastery.correct, 1);
    assert.equal(mastery.mastered, false);
  });

  test('feedback delay comes from the JSON settings', () => {
    const { engine, clock } = makeEngine();
    engine.startLevel(1);
    const right = answerOnce(engine, clock, { correct: true });
    assert.equal(right.feedbackDelayMs, gameData.settings.feedbackDelayMs);
    engine.continueAfterFeedback();
    const wrong = answerOnce(engine, clock, { correct: false });
    assert.equal(wrong.feedbackDelayMs, gameData.settings.wrongAnswerFeedbackDelayMs);
  });
});

/* ========================================================================
 * 10. Input locking & double-submit protection
 * ====================================================================== */

describe('input locking and double-submit protection', () => {
  function answeredEngine() {
    const made = makeEngine();
    made.engine.startLevel(1);
    const result = answerOnce(made.engine, made.clock);
    return { ...made, result };
  }

  test('a second submitCurrentLane is rejected', () => {
    const { engine } = answeredEngine();
    assert.throws(() => engine.submitCurrentLane(), /already been resolved|not allowed|input is locked/);
  });

  test('movement and category choice are locked during feedback', () => {
    const { engine } = answeredEngine();
    assert.throws(() => engine.moveToLane(0), /FEEDBACK/);
    assert.throws(() => engine.chooseCategory('none'), /FEEDBACK/);
    assert.throws(() => engine.moveLeft(), /FEEDBACK/);
  });

  test('an answer is recorded exactly once even after a double attempt', () => {
    const { engine, clock } = answeredEngine();
    assert.throws(() => engine.submitCurrentLane());
    assert.equal(engine.getSnapshot().session.answered, 1);
    let resolvedEvents = 0;
    engine.on('answer:resolved', () => resolvedEvents++);
    engine.continueAfterFeedback();
    answerOnce(engine, clock);
    assert.equal(resolvedEvents, 1); // only the second answer emitted an event
    assert.equal(engine.getSnapshot().session.answered, 2);
  });

  test('submitting is impossible before a level starts', () => {
    const { engine } = makeEngine();
    assert.throws(() => engine.submitCurrentLane(), /READY/);
  });

  test('the gate does not advance and input stays locked while feedback shows', () => {
    const { engine } = answeredEngine();
    engine.update(1000);
    assert.equal(engine.gateProgress, 0);
    assert.equal(engine.inputLocked, true);
  });
});

/* ========================================================================
 * 11. continueAfterFeedback & flow control
 * ====================================================================== */

describe('continueAfterFeedback and flow control', () => {
  test('continueAfterFeedback is invalid outside FEEDBACK', () => {
    const { engine, clock } = makeEngine();
    assert.throws(() => engine.continueAfterFeedback(), /READY/);
    engine.startLevel(1);
    assert.throws(() => engine.continueAfterFeedback(), /PLAYING/);
    answerOnce(engine, clock);
    engine.continueAfterFeedback();
    assert.throws(() => engine.continueAfterFeedback(), /PLAYING/);
  });

  test('continuing loads the next question with a fresh lane setup', () => {
    const { engine, clock } = makeEngine();
    engine.startLevel(1);
    const firstLaneMap = engine.getSnapshot().laneMap;
    answerOnce(engine, clock);
    const step = engine.continueAfterFeedback();
    assert.equal(step.status, 'next-question');
    const snap = engine.getSnapshot();
    assert.equal(snap.state, GAME_STATES.PLAYING);
    assert.equal(snap.playerLane, START_LANE);
    assert.equal(snap.gateProgress, 0);
    assert.equal(snap.inputLocked, false);
    assert.equal(snap.session.questionIndex, 1);
    assert.ok(snap.laneMap.length === 3);
    assert.ok(isPermutationOfCategories(snap.laneMap));
    assert.notEqual(snap.question.id, undefined);
    assert.equal(firstLaneMap.length, 3);
  });

  test('the final question finishes the level with a summary event', () => {
    const { engine, clock } = makeEngine();
    const completions = [];
    engine.on('level:completed', (payload) => completions.push(payload));
    engine.startLevel(1);
    const { summary, outcome } = runLevel(engine, clock);
    assert.equal(outcome, 'level-complete');
    assert.equal(engine.state, GAME_STATES.LEVEL_COMPLETE);
    assert.equal(completions.length, 1);
    assert.equal(completions[0].summary.levelId, 1);
    assert.equal(summary.answered, 8);
    assert.equal(summary.totalQuestions, 8);
  });

  test('continuing after the level is complete is rejected', () => {
    const { engine, clock } = makeEngine();
    engine.startLevel(1);
    runLevel(engine, clock);
    assert.throws(() => engine.continueAfterFeedback(), /LEVEL_COMPLETE/);
  });

  test('losing the last life in Arcade Mode triggers GAME_OVER', () => {
    const { engine, clock } = makeEngine();
    const overs = [];
    engine.on('game:over', (payload) => overs.push(payload));
    engine.startLevel(1, { mode: GAME_MODES.ARCADE });
    const { results, outcome, summary } = runLevel(engine, clock, { pattern: [false, false, false] });
    assert.equal(results.length, 3);
    assert.equal(results[2].livesRemaining, 0);
    assert.equal(outcome, 'game-over');
    assert.equal(engine.state, GAME_STATES.GAME_OVER);
    assert.equal(overs.length, 1);
    assert.equal(overs[0].reason, 'out-of-lives');
    assert.equal(summary.gameOver, true);
    assert.equal(summary.correct, 0);
  });

  test('a game can be started again from GAME_OVER', () => {
    const { engine, clock } = makeEngine();
    engine.startLevel(1, { mode: GAME_MODES.ARCADE });
    runLevel(engine, clock, { pattern: [false, false, false] });
    engine.startLevel(1, { mode: GAME_MODES.ARCADE });
    assert.equal(engine.state, GAME_STATES.PLAYING);
    assert.equal(engine.getSnapshot().lives, 3);
  });
});

/* ========================================================================
 * 12. Question selection & adaptive weighting
 * ====================================================================== */

describe('question selection and adaptive weighting', () => {
  const assertUnique = (trace) => {
    const ids = trace.map((entry) => entry.id);
    assert.equal(new Set(ids).size, ids.length, `duplicate in ${ids.join(', ')}`);
  };

  const assertTargetMix = (trace, levelId) => {
    const level = gameData.levels.find((entry) => entry.id === levelId);
    const counts = categoryCounts(trace);
    assert.equal(trace.length, level.questionCount);
    for (const category of ALL_CATEGORIES) {
      const ideal = level.categoryTargets[category] * level.questionCount;
      assert.ok(
        Math.abs(counts[category] - ideal) < 1,
        `level ${levelId} ${category}: expected near ${ideal}, got ${counts[category]}`
      );
    }
  };

  test('level 1 uses the exact 4/2/2 primary-dominant category mix', () => {
    const trace = traceForLevel(1, 0x1a2b3c4d);
    assert.deepEqual(categoryCounts(trace), {
      none: 2,
      definite: 2,
      indefinite: 4,
    });
    assertUnique(trace);
    assert.ok(longestCategoryRun(trace) <= 2);
  });

  test('a focused level without explicit targets uses the 50/25/25 fallback', () => {
    const data = cloneData();
    delete data.levels[0].categoryTargets;
    const made = makeEngine({ data, rng: seededRng(0x0fa11bac) });
    made.engine.startLevel(1);
    const trace = runLevelTrace(made.engine, made.clock);
    assert.deepEqual(categoryCounts(trace), { none: 2, definite: 2, indefinite: 4 });
    assert.ok(longestCategoryRun(trace) <= 2);
  });

  test('the wildcard mastery level uses an exact balanced 4/4/4 mix', () => {
    const trace = traceForLevel(10, 0x5eed1234);
    assert.deepEqual(categoryCounts(trace), {
      none: 4,
      definite: 4,
      indefinite: 4,
    });
    assertUnique(trace);
    assert.ok(longestCategoryRun(trace) <= 2);
  });

  test('the mixed-basics level gives meaningful representation to all three categories', () => {
    const trace = traceForLevel(5, 0x51a5ed);
    assert.deepEqual(categoryCounts(trace), {
      none: 3,
      definite: 3,
      indefinite: 4,
    });
    assertUnique(trace);
    assert.ok(longestCategoryRun(trace) <= 2);
  });

  test('each focused level keeps its configured primary category dominant', () => {
    for (const levelId of [1, 2, 4, 6, 7, 8]) {
      const level = gameData.levels.find((entry) => entry.id === levelId);
      const primary = ALL_CATEGORIES.find((category) =>
        ALL_CATEGORIES.every((other) => level.categoryTargets[category] >= level.categoryTargets[other])
      );
      const counts = categoryCounts(traceForLevel(levelId, 0x600d0000 + levelId));
      for (const category of ALL_CATEGORIES) {
        if (category !== primary) {
          assert.ok(counts[primary] > counts[category], `level ${levelId}: ${primary} is not dominant`);
        }
      }
    }
  });

  test('primary and contrast pools are the only configured focused-level sources', () => {
    const level = gameData.levels.find((entry) => entry.id === 1);
    const allowedRules = new Set([...level.rules, ...(level.contrastRules ?? [])]);
    const trace = traceForLevel(1, 0x10203040);
    for (const entry of trace) {
      assert.ok(allowedRules.has(entry.rule), `question ${entry.id} uses unconfigured rule ${entry.rule}`);
      assert.ok(questionById.get(entry.id).levelMin <= level.id, `question ${entry.id} exceeds levelMin`);
    }
  });

  test('no category streak exceeds two across representative focused and mastery seeds', () => {
    const seeds = [1, 2, 3, 7, 11, 29, 97, 0xdecafbad];
    for (const levelId of [1, 10]) {
      for (const seed of seeds) {
        const trace = traceForLevel(levelId, seed);
        assert.ok(
          longestCategoryRun(trace) <= 2,
          `level ${levelId}, seed ${seed}: ${trace.map((entry) => entry.category).join(', ')}`
        );
      }
    }
  });

  test('seeded selection is reproducible while different seeds produce different valid sequences', () => {
    const first = traceForLevel(1, 0x12345678);
    const replay = traceForLevel(1, 0x12345678);
    const second = traceForLevel(1, 0x87654321);
    const ids = (trace) => trace.map((entry) => entry.id);

    assert.deepEqual(ids(replay), ids(first));
    assert.notDeepEqual(ids(second), ids(first));
    for (const trace of [first, replay, second]) {
      assert.deepEqual(categoryCounts(trace), { none: 2, definite: 2, indefinite: 4 });
      assertUnique(trace);
      assert.ok(longestCategoryRun(trace) <= 2);
    }
  });

  test('weak-rule weighting boosts that rule without changing category balance', () => {
    let neutralSelections = 0;
    let weakSelections = 0;

    for (let seed = 1; seed <= 64; seed++) {
      const neutral = traceForLevel(4, seed, {
        storage: seededStorage({
          version: 1,
          passedLevels: [],
          levels: {},
          mastery: {},
          totalAttempts: 0,
          totalCorrect: 0,
          recentQuestions: [],
        }),
      });
      const weak = traceForLevel(4, seed, {
        storage: seededStorage({
          version: 1,
          passedLevels: [],
          levels: {},
          mastery: { 'zero-sports': { attempts: 100, correct: 5 } },
          totalAttempts: 100,
          totalCorrect: 5,
          recentQuestions: [],
        }),
      });

      neutralSelections += neutral.filter((entry) => entry.rule === 'zero-sports').length;
      weakSelections += weak.filter((entry) => entry.rule === 'zero-sports').length;
      assertTargetMix(weak, 4);
      assertUnique(weak);
      assert.ok(longestCategoryRun(weak) <= 2, `seed ${seed}`);
    }

    assert.ok(
      weakSelections > neutralSelections,
      `expected weak-rule boost, neutral=${neutralSelections}, weak=${weakSelections}`
    );
  });

  test('rules below the adaptive minimum attempts behave like unseen rules', () => {
    const seed = 0x31415926;
    const unseen = makeEngine({ rng: seededRng(seed) });
    unseen.engine.startLevel(4, { ignoreLock: true });
    const belowMinimum = makeEngine({
      rng: seededRng(seed),
      storage: seededStorage({
        version: 1,
        passedLevels: [],
        levels: {},
        mastery: { 'zero-sports': { attempts: 2, correct: 0 } },
        totalAttempts: 2,
        totalCorrect: 0,
        recentQuestions: [],
      }),
    });
    belowMinimum.engine.startLevel(4, { ignoreLock: true });
    assert.equal(belowMinimum.engine.getSnapshot().question.id, unseen.engine.getSnapshot().question.id);
  });

  test('questions never repeat within a run', () => {
    for (const levelId of [1, 4, 10]) {
      for (const seed of [3, 17, 41, 89]) assertUnique(traceForLevel(levelId, seed));
    }
  });

  test('recent questions are avoided across runs while fresh ones remain', () => {
    const { engine, clock } = makeEngine({ rng: seededRng(0xabcdef01) });
    engine.startLevel(5, { ignoreLock: true });
    const firstRun = runLevelTrace(engine, clock);
    engine.startLevel(5, { ignoreLock: true });
    const nextId = engine.getSnapshot().question.id;
    assert.ok(!firstRun.some((entry) => entry.id === nextId), `repeated ${nextId} immediately after a run`);
  });

  test('the recent-question window is capped by the JSON setting', () => {
    const { engine, clock } = makeEngine({ rng: seededRng(0x42424242) });
    engine.startLevel(10, { ignoreLock: true });
    runLevel(engine, clock);
    const recent = engine.getProgress().recentQuestions;
    assert.equal(recent.length, gameData.settings.recentQuestionWindow);
  });

  test('exact a/an results survive randomized selection without order assumptions', () => {
    const seen = new Map();
    for (let seed = 1; seed <= 32 && seen.size < 2; seed++) {
      for (const entry of traceForLevel(1, seed)) {
        if (entry.article === 'a' || entry.article === 'an') {
          assert.equal(entry.result.correctArticle, entry.article, entry.id);
          assert.equal(
            entry.result.completedSentence,
            questionById.get(entry.id).completedSentence,
            entry.id
          );
          seen.set(entry.article, entry.id);
        }
      }
    }
    assert.ok(seen.has('a'), `no exact 'a' result found`);
    assert.ok(seen.has('an'), `no exact 'an' result found`);
  });

  test('100 deterministic representative runs preserve balance, variety and duplicate safety', () => {
    const signatures = new Set();
    for (let seed = 1; seed <= 100; seed++) {
      const levelId = seed % 2 === 0 ? 1 : 10;
      const trace = traceForLevel(levelId, seed);
      if (levelId === 1) {
        assert.deepEqual(categoryCounts(trace), { none: 2, definite: 2, indefinite: 4 });
      } else {
        assert.deepEqual(categoryCounts(trace), { none: 4, definite: 4, indefinite: 4 });
      }
      assertUnique(trace);
      assert.ok(longestCategoryRun(trace) <= 2, `level ${levelId}, seed ${seed}`);
      assert.equal(
        hasRepeatingCategoryPattern(trace),
        false,
        `level ${levelId}, seed ${seed}: repeating category block`
      );
      signatures.add(`${levelId}:${trace.map((entry) => entry.id).join('|')}`);
    }
    assert.ok(signatures.size >= 90, `only ${signatures.size} distinct sequences across 100 runs`);
  });
});

/* ========================================================================
 * 13. Mastery tracking
 * ====================================================================== */

describe('mastery tracking', () => {
  test('unknown rules report zero mastery', () => {
    const { engine } = makeEngine();
    assert.deepEqual(engine.getMastery('no-such-rule'), {
      attempts: 0,
      correct: 0,
      accuracy: 0,
      mastered: false,
    });
  });

  test('attempts and correct counts accumulate across a run', () => {
    const { engine, clock } = makeEngine();
    engine.startLevel(1);
    const pattern = [true, true, true, true, false, false, true, true];
    const expected = new Map();
    let index = 0;
    while (engine.state === GAME_STATES.PLAYING) {
      const rule = engine.getSnapshot().question.rule;
      const correct = pattern[index++];
      const stats = expected.get(rule) ?? { attempts: 0, correct: 0 };
      stats.attempts += 1;
      stats.correct += Number(correct);
      expected.set(rule, stats);
      answerOnce(engine, clock, { correct });
      engine.continueAfterFeedback();
    }
    for (const [rule, stats] of expected) {
      const mastery = engine.getMastery(rule);
      assert.deepEqual([mastery.attempts, mastery.correct], [stats.attempts, stats.correct], rule);
      assert.equal(mastery.accuracy, stats.correct / stats.attempts, rule);
    }
  });

  test('a rule is not mastered below the minimum attempt count', () => {
    const { engine, clock } = makeEngine();
    engine.startLevel(1);
    const trace = runLevelTrace(engine, clock);
    const attempts = new Map();
    for (const entry of trace) attempts.set(entry.rule, (attempts.get(entry.rule) ?? 0) + 1);
    const [rule, count] = [...attempts].find(([, value]) => value < gameData.settings.minimumAttemptsForMastery);
    const mastery = engine.getMastery(rule);
    assert.equal(mastery.accuracy, 1);
    assert.equal(mastery.attempts, count);
    assert.equal(mastery.mastered, false);
  });

  test('a rule becomes mastered after enough strong attempts', () => {
    const rule = gameData.levels[0].rules[0];
    const before = gameData.settings.minimumAttemptsForMastery - 1;
    const storage = seededStorage({
      version: 1,
      passedLevels: [],
      levels: {},
      mastery: { [rule]: { attempts: before, correct: before } },
      totalAttempts: before,
      totalCorrect: before,
      recentQuestions: [],
    });
    const { engine, clock } = makeEngine({ storage, rng: seededRng(0x77777777) });
    engine.startLevel(1);
    let found = false;
    while (engine.state === GAME_STATES.PLAYING) {
      const isTarget = engine.getSnapshot().question.rule === rule;
      answerOnce(engine, clock);
      if (isTarget) {
        found = true;
        break;
      }
      engine.continueAfterFeedback();
    }
    assert.equal(found, true, `no question for ${rule}`);
    const mastery = engine.getMastery(rule);
    assert.equal(mastery.attempts, gameData.settings.minimumAttemptsForMastery);
    assert.equal(mastery.accuracy, 1);
    assert.equal(mastery.mastered, true);
  });

  test('the mastery accuracy threshold comes from the JSON', () => {
    const storage = seededStorage({
      version: 1,
      passedLevels: [],
      levels: {},
      mastery: { 'zero-meals': { attempts: 5, correct: 4 } }, // 0.8 < 0.85
      totalAttempts: 5,
      totalCorrect: 4,
      recentQuestions: [],
    });
    const { engine } = makeEngine({ storage });
    const mastery = engine.getMastery('zero-meals');
    assert.equal(mastery.attempts, gameData.settings.minimumAttemptsForMastery);
    assert.ok(mastery.accuracy < gameData.settings.masteryThreshold);
    assert.equal(mastery.mastered, false);
  });

  test('total attempts and correct answers are tracked in progress', () => {
    const { engine, clock } = makeEngine();
    engine.startLevel(1);
    runLevel(engine, clock, { pattern: [true, true, true, true, true, true, false, false] });
    const progress = engine.getProgress();
    assert.equal(progress.totalAttempts, 8);
    assert.equal(progress.totalCorrect, 6);
  });
});

/* ========================================================================
 * 14. Level completion, stars & summaries
 * ====================================================================== */

describe('level completion, stars and summaries', () => {
  test('a perfect run earns three stars and a pass', () => {
    const { engine, clock } = makeEngine();
    engine.startLevel(1);
    const { summary } = runLevel(engine, clock);
    assert.equal(summary.accuracy, 1);
    assert.equal(summary.stars, 3);
    assert.equal(summary.passed, true);
    assert.equal(summary.correct, 8);
    assert.equal(summary.wrong, 0);
  });

  test('seven of eight (0.875) earns two stars', () => {
    const { engine, clock } = makeEngine();
    engine.startLevel(1);
    const { summary } = runLevel(engine, clock, { pattern: [true, true, true, true, true, true, true, false] });
    assert.equal(summary.accuracy, 0.875);
    assert.equal(summary.stars, 2);
    assert.equal(summary.passed, true);
  });

  test('the two-star threshold boundary is inclusive (6/8 = 0.75)', () => {
    const { engine, clock } = makeEngine();
    engine.startLevel(1);
    const { summary } = runLevel(engine, clock, { pattern: [true, true, true, true, true, true, false, false] });
    assert.equal(summary.stars, 2);
  });

  test('5/8 (0.625) passes with exactly one star at the boundary', () => {
    const { engine, clock } = makeEngine();
    engine.startLevel(1);
    const { summary } = runLevel(engine, clock, { pattern: [true, true, true, true, true, false, false, false] });
    assert.equal(summary.accuracy, 0.625);
    assert.equal(summary.stars, 1);
    assert.equal(summary.passed, true); // requiredAccuracy is 0.625
  });

  test('4/8 (0.5) fails with zero stars', () => {
    const { engine, clock } = makeEngine();
    engine.startLevel(1);
    const { summary } = runLevel(engine, clock, { pattern: [false, false, false, false, true, true, true, true] });
    assert.equal(summary.stars, 0);
    assert.equal(summary.passed, false);
  });

  test('the summary contains every field the UI needs', () => {
    const { engine, clock } = makeEngine();
    engine.startLevel(1);
    const { summary } = runLevel(engine, clock, { pattern: [true, true, true, true, false, false, true, true] });
    const expectedKeys = [
      'levelId', 'levelTitle', 'mode', 'correct', 'wrong', 'answered', 'totalQuestions',
      'accuracy', 'passed', 'stars', 'score', 'bestStreak', 'lives', 'weakRules',
      'durationMs', 'gameOver', 'completedAt',
    ];
    for (const key of expectedKeys) assert.ok(key in summary, `missing summary field ${key}`);
    assert.equal(summary.levelTitle, gameData.levels[0].title);
    assert.equal(summary.mode, GAME_MODES.LEARN);
    assert.ok(summary.durationMs >= 0);
    assert.ok(!Number.isNaN(Date.parse(summary.completedAt)));
  });

  test('weak rules are identified for the current run', () => {
    const { engine, clock } = makeEngine();
    engine.startLevel(1);
    const weakRule = engine.getSnapshot().question.rule;
    let weakAttempts = 0;
    let summary = null;
    while (engine.state === GAME_STATES.PLAYING) {
      const isWeakRule = engine.getSnapshot().question.rule === weakRule;
      weakAttempts += Number(isWeakRule);
      answerOnce(engine, clock, { correct: !isWeakRule });
      const step = engine.continueAfterFeedback();
      if (step.summary) summary = step.summary;
    }
    const weak = summary.weakRules.find((entry) => entry.rule === weakRule);
    assert.ok(weak, `missing weak rule ${weakRule}`);
    assert.equal(weak.attempts, weakAttempts);
    assert.equal(weak.correct, 0);
    assert.equal(weak.accuracy, 0);
    assert.equal(weak.label, gameData.ruleCatalog.find((entry) => entry.id === weakRule).label);
  });

  test('strong rules are never listed as weak', () => {
    const { engine, clock } = makeEngine();
    engine.startLevel(1);
    const strongRule = engine.getSnapshot().question.rule;
    let summary = null;
    while (engine.state === GAME_STATES.PLAYING) {
      const isStrongRule = engine.getSnapshot().question.rule === strongRule;
      answerOnce(engine, clock, { correct: isStrongRule });
      const step = engine.continueAfterFeedback();
      if (step.summary) summary = step.summary;
    }
    assert.ok(!summary.weakRules.some((entry) => entry.rule === strongRule));
  });

  test('multiple weak rules are sorted weakest first', () => {
    const { engine, clock } = makeEngine();
    engine.startLevel(1);
    const { summary } = runLevel(engine, clock, { pattern: Array(8).fill(false) });
    assert.ok(summary.weakRules.length >= 2);
    assert.equal(new Set(summary.weakRules.map((entry) => entry.rule)).size, summary.weakRules.length);
    for (let i = 1; i < summary.weakRules.length; i++) {
      assert.ok(summary.weakRules[i - 1].accuracy <= summary.weakRules[i].accuracy);
    }
  });
});

/* ========================================================================
 * 15. Progression, unlocking & records
 * ====================================================================== */

describe('progression, unlocking and records', () => {
  test('passing a level unlocks the next level', () => {
    const { engine, clock } = makeEngine();
    engine.startLevel(1);
    runLevel(engine, clock);
    const progress = engine.getProgress();
    assert.deepEqual(progress.passedLevels, [1]);
    assert.deepEqual(progress.unlockedLevels, [1, 2]);
    assert.equal(progress.highestUnlockedLevel, 2);
    engine.startLevel(2); // no throw
  });

  test('failing a level does not unlock the next one', () => {
    const { engine, clock } = makeEngine();
    engine.startLevel(1);
    runLevel(engine, clock, { pattern: [false, false, false, false, true, true, true, true] });
    assert.equal(engine.getProgress().highestUnlockedLevel, 1);
    assert.throws(() => engine.startLevel(2), /locked/);
  });

  test('level records store bests, lasts and completion counts', () => {
    const { engine, clock } = makeEngine();
    engine.startLevel(1);
    const { summary } = runLevel(engine, clock);
    const record = engine.getProgress().levels['1'];
    assert.equal(record.completions, 1);
    assert.equal(record.bestAccuracy, 1);
    assert.equal(record.bestStars, 3);
    assert.equal(record.bestScore, summary.score);
    assert.equal(record.lastAccuracy, 1);
    assert.equal(record.lastStars, 3);
    assert.equal(record.lastScore, summary.score);
    assert.ok(typeof record.lastCompletedAt === 'string');
  });

  test('a worse replay never overwrites a previous best', () => {
    const { engine, clock } = makeEngine();
    engine.startLevel(1);
    const { summary: first } = runLevel(engine, clock, { advanceMs: FAST_MS }); // high score
    engine.startLevel(1);
    const { summary: second } = runLevel(engine, clock, {
      pattern: [true, true, true, true, true, false, false, false],
    }); // 5/8, slow
    const record = engine.getProgress().levels['1'];
    assert.equal(record.completions, 2);
    assert.equal(record.bestAccuracy, 1);
    assert.equal(record.bestStars, 3);
    assert.equal(record.bestScore, Math.max(first.score, second.score));
    assert.equal(record.lastAccuracy, 0.625);
    assert.equal(record.lastStars, 1);
    assert.equal(record.lastScore, second.score);
    assert.ok(second.score < first.score);
  });

  test('Arcade Mode writes no level records', () => {
    const { engine, clock } = makeEngine();
    engine.startLevel(1, { mode: GAME_MODES.ARCADE });
    runLevel(engine, clock);
    const progress = engine.getProgress();
    assert.equal(progress.levels['1'], undefined);
    assert.deepEqual(progress.passedLevels, []);
  });

  test('Arcade Mode never unlocks Learn Mode progression', () => {
    const { engine, clock } = makeEngine();
    engine.startLevel(1, { mode: GAME_MODES.ARCADE });
    runLevel(engine, clock);
    assert.equal(engine.getProgress().highestUnlockedLevel, 1);
    assert.throws(() => engine.startLevel(2), /locked/);
  });

  test('restartLevel resets the run but keeps level and mode', () => {
    const { engine, clock } = makeEngine();
    engine.startLevel(1, { mode: GAME_MODES.ARCADE });
    answerOnce(engine, clock);
    engine.continueAfterFeedback();
    answerOnce(engine, clock);
    assert.ok(engine.score > 0);
    assert.equal(engine.getSnapshot().session.questionIndex, 2);
    const snap = engine.restartLevel();
    assert.equal(snap.state, GAME_STATES.PLAYING);
    assert.equal(snap.score, 0);
    assert.equal(snap.streak, 0);
    assert.equal(snap.session.questionIndex, 0);
    assert.equal(snap.session.answered, 0);
    assert.equal(snap.session.mode, GAME_MODES.ARCADE);
    assert.equal(snap.level.id, 1);
    assert.equal(snap.lives, gameData.settings.startingLivesArcade);
  });

  test('the full level chain unlocks level by level', () => {
    const { engine, clock } = makeEngine();
    for (const level of gameData.levels) {
      engine.startLevel(level.id);
      runLevel(engine, clock);
      assert.equal(engine.state, GAME_STATES.LEVEL_COMPLETE, `after level ${level.id}`);
    }
    const progress = engine.getProgress();
    assert.deepEqual(progress.passedLevels, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.equal(progress.highestUnlockedLevel, 10);
    engine.startLevel(10); // stays playable
  });

  test('a mid-chain level stays locked until its predecessor is passed', () => {
    const { engine, clock } = makeEngine();
    for (const id of [1, 2, 3]) {
      engine.startLevel(id);
      runLevel(engine, clock);
    }
    assert.throws(() => engine.startLevel(5), /locked/); // unlockAfter 4
    engine.startLevel(4);
    runLevel(engine, clock);
    engine.startLevel(5); // now open
  });

  test('resetProgress wipes records, mastery and unlocks', () => {
    const { engine, clock } = makeEngine();
    engine.startLevel(1);
    runLevel(engine, clock);
    let resetEvents = 0;
    engine.on('progress:reset', () => resetEvents++);
    engine.resetProgress();
    assert.equal(resetEvents, 1);
    const progress = engine.getProgress();
    assert.deepEqual(progress.passedLevels, []);
    assert.deepEqual(progress.levels, {});
    assert.deepEqual(progress.mastery, {});
    assert.equal(progress.totalAttempts, 0);
    assert.throws(() => engine.startLevel(2), /locked/);
  });
});

/* ========================================================================
 * 16. Persistence & storage
 * ====================================================================== */

describe('persistence and storage', () => {
  test('progress is persisted into the storage key after a run', () => {
    const storage = createMemoryStorage();
    const { engine, clock } = makeEngine({ storage });
    engine.startLevel(1);
    runLevel(engine, clock);
    const raw = storage._map.get(PROGRESS_STORAGE_KEY);
    assert.ok(raw, 'progress JSON must be written');
    const parsed = JSON.parse(raw);
    assert.equal(parsed.levels['1'].completions, 1);
    assert.equal(
      Object.values(parsed.mastery).reduce((total, mastery) => total + mastery.attempts, 0),
      gameData.levels[0].questionCount
    );
    assert.deepEqual(parsed.passedLevels, [1]);
  });

  test('a fresh engine instance restores progress from storage', () => {
    const storage = createMemoryStorage();
    const first = makeEngine({ storage });
    first.engine.startLevel(1);
    runLevel(first.engine, first.clock);

    const second = makeEngine({ storage });
    const progress = second.engine.getProgress();
    assert.equal(progress.highestUnlockedLevel, 2);
    assert.equal(progress.levels['1'].bestStars, 3);
    assert.deepEqual(progress.mastery, first.engine.getProgress().mastery);
    second.engine.startLevel(2); // unlocked by the previous engine
    assert.equal(second.engine.state, GAME_STATES.PLAYING);
  });

  test('the recent-question history survives into a new engine instance', () => {
    const storage = createMemoryStorage();
    const first = makeEngine({ storage });
    first.engine.startLevel(1);
    runLevel(first.engine, first.clock);
    const second = makeEngine({ storage });
    const recent = second.engine.getProgress().recentQuestions;
    assert.equal(recent.length, 8);
  });

  test('malformed stored JSON falls back to defaults without crashing', () => {
    const storage = createMemoryStorage();
    storage.setItem(PROGRESS_STORAGE_KEY, '{this is not json');
    const { engine } = makeEngine({ storage });
    assert.equal(engine.state, GAME_STATES.READY);
    const progress = engine.getProgress();
    assert.deepEqual(progress.passedLevels, []);
    assert.equal(progress.totalAttempts, 0);
    assert.throws(() => engine.startLevel(2), /locked/);
  });

  test('non-object stored progress falls back to defaults', () => {
    for (const bad of ['"just a string"', '[1,2,3]', '42']) {
      const storage = createMemoryStorage();
      storage.setItem(PROGRESS_STORAGE_KEY, bad);
      const { engine } = makeEngine({ storage });
      assert.deepEqual(engine.getProgress().passedLevels, []);
    }
  });

  test('storage write failures never crash the engine', () => {
    const failing = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota exceeded');
      },
      removeItem: () => {},
      clear: () => {},
    };
    const { engine, clock } = makeEngine({ storage: failing });
    engine.startLevel(1);
    const { summary } = runLevel(engine, clock);
    assert.equal(summary.passed, true);
    assert.equal(engine.getProgress().levels['1'].completions, 1); // still coherent in memory
  });

  test('getProgress returns a deep copy that cannot corrupt the engine', () => {
    const { engine, clock } = makeEngine();
    engine.startLevel(1);
    runLevel(engine, clock);
    const progress = engine.getProgress();
    const masteryRule = Object.keys(progress.mastery)[0];
    const originalAttempts = progress.mastery[masteryRule].attempts;
    progress.levels['1'].bestStars = 99;
    progress.mastery[masteryRule].attempts = 999;
    progress.passedLevels.push(42);
    progress.unlockedLevels.push(42);
    const fresh = engine.getProgress();
    assert.equal(fresh.levels['1'].bestStars, 3);
    assert.equal(fresh.mastery[masteryRule].attempts, originalAttempts);
    assert.deepEqual(fresh.passedLevels, [1]);
    assert.deepEqual(fresh.unlockedLevels, [1, 2]);
  });

  test('StorageAdapter round-trips values and returns fallbacks safely', () => {
    const backing = createMemoryStorage();
    const adapter = new StorageAdapter(backing);
    assert.equal(adapter.isPersistent, true); // injected backings are treated as durable
    assert.equal(new StorageAdapter().isPersistent, false); // Node has no localStorage: memory fallback
    assert.equal(adapter.get('missing', 'fallback'), 'fallback');
    assert.equal(adapter.set('k', { a: 1 }), true);
    assert.deepEqual(adapter.get('k'), { a: 1 });
    backing.setItem('bad', '{oops'); // raw malformed JSON sitting in the store
    assert.equal(adapter.get('bad', null), null);
    adapter.remove('k');
    assert.equal(adapter.get('k', null), null);
  });

  test('StorageAdapter reports failed writes as false', () => {
    const adapter = new StorageAdapter({
      getItem: () => null,
      setItem: () => {
        throw new Error('no');
      },
      removeItem: () => {},
    });
    assert.equal(adapter.set('k', 1), false);
  });
});

/* ========================================================================
 * 17. Pause & resume
 * ====================================================================== */

describe('pause and resume', () => {
  test('pause switches PLAYING to PAUSED and emits an event', () => {
    const { engine } = makeEngine();
    const events = [];
    engine.on('game:paused', (payload) => events.push(payload));
    engine.startLevel(1);
    engine.pause();
    assert.equal(engine.state, GAME_STATES.PAUSED);
    assert.equal(events.length, 1);
    assert.equal(events[0].levelId, 1);
  });

  test('pause is valid during PLAYING or FEEDBACK and rejects other states', () => {
    const { engine, clock } = makeEngine();
    assert.throws(() => engine.pause(), /READY/);
    engine.startLevel(1);
    answerOnce(engine, clock);
    engine.pause();
    assert.throws(() => engine.pause(), /PAUSED/); // double pause
    engine.resume();
    assert.equal(engine.state, GAME_STATES.FEEDBACK);
  });

  test('resume is only valid during PAUSED', () => {
    const { engine } = makeEngine();
    engine.startLevel(1);
    assert.throws(() => engine.resume(), /PLAYING/);
    engine.pause();
    engine.resume();
    assert.throws(() => engine.resume(), /PLAYING/);
  });

  test('the gate freezes while paused and continues after resume', () => {
    const { engine } = makeEngine();
    engine.startLevel(1);
    engine.update(100);
    const before = engine.gateProgress;
    engine.pause();
    engine.update(100);
    engine.update(5000);
    assert.equal(engine.gateProgress, before);
    let resumed = null;
    engine.on('game:resumed', (payload) => (resumed = payload));
    engine.resume();
    assert.equal(engine.state, GAME_STATES.PLAYING);
    assert.ok(resumed && typeof resumed.pausedFor === 'number');
    engine.update(100);
    assert.ok(engine.gateProgress > before);
  });

  test('time spent paused does not count as response time', () => {
    const { engine, clock } = makeEngine();
    engine.startLevel(1);
    clock.advance(2000);
    engine.pause();
    clock.advance(60000); // long pause menu visit
    engine.resume();
    clock.advance(1000);
    engine.chooseCategory(correctCategoryFor(engine.getSnapshot().question.id));
    const result = engine.submitCurrentLane();
    assert.equal(result.responseMs, 3000); // 2000 + 1000, not 63000
    assert.equal(result.speedBonus, Math.round(SC.fastBonusMax * (1 - 3000 / SC.fastBonusWindowMs)));
  });

  test('feedback pause resumes to FEEDBACK without changing the resolved answer', () => {
    const { engine, clock } = makeEngine();
    const transitions = [];
    const pauses = [];
    const resumes = [];
    engine.on('state:changed', ({ from, to }) => transitions.push(`${from}>${to}`));
    engine.on('game:paused', (payload) => pauses.push(payload));
    engine.on('game:resumed', (payload) => resumes.push(payload));
    engine.startLevel(1);
    const result = answerOnce(engine, clock, { advanceMs: 1200 });
    const before = engine.getSnapshot();
    engine.pause();
    clock.advance(45000);
    engine.update(1000);
    assert.equal(engine.state, GAME_STATES.PAUSED);
    assert.throws(() => engine.continueAfterFeedback(), /PAUSED/);
    engine.resume();
    const after = engine.getSnapshot();
    assert.equal(engine.state, GAME_STATES.FEEDBACK);
    assert.deepEqual(after.lastResult, result);
    assert.equal(after.session.questionIndex, before.session.questionIndex);
    assert.equal(pauses[0].fromState, GAME_STATES.FEEDBACK);
    assert.equal(resumes[0].toState, GAME_STATES.FEEDBACK);
    assert.ok(transitions.includes('FEEDBACK>PAUSED'));
    assert.ok(transitions.includes('PAUSED>FEEDBACK'));
  });

  test('feedback pause time is excluded from final level duration', () => {
    const data = cloneData();
    data.levels[0].questionCount = 1;
    const { engine, clock } = makeEngine({ data });
    engine.startLevel(1);
    answerOnce(engine, clock, { advanceMs: 1200 });
    engine.pause();
    clock.advance(60000);
    engine.resume();
    const { summary } = engine.continueAfterFeedback();
    assert.equal(summary.durationMs, 1200);
  });

  test('restarting from PAUSED resets the run cleanly', () => {
    const { engine, clock } = makeEngine();
    engine.startLevel(1);
    engine.update(100);
    engine.pause();
    const snap = engine.restartLevel();
    assert.equal(snap.state, GAME_STATES.PLAYING);
    assert.equal(snap.score, 0);
    assert.equal(snap.gateProgress, 0);
    assert.equal(snap.session.questionIndex, 0);
  });
});

/* ========================================================================
 * 18. Events
 * ====================================================================== */

describe('event system', () => {
  test('on() returns an unsubscribe function that stops delivery', () => {
    const { engine } = makeEngine();
    let ticks = 0;
    const off = engine.on('game:tick', () => ticks++);
    engine.startLevel(1);
    engine.update(50);
    assert.equal(ticks, 1);
    off();
    engine.update(50);
    assert.equal(ticks, 1);
  });

  test('a throwing handler does not break the engine or other handlers', () => {
    const { engine, clock } = makeEngine();
    let received = false;
    engine.on('answer:correct', () => {
      throw new Error('handler bug');
    });
    engine.on('answer:correct', () => {
      received = true;
    });
    engine.startLevel(1);
    const result = answerOnce(engine, clock);
    assert.equal(result.isCorrect, true);
    assert.equal(received, true);
    assert.equal(engine.state, GAME_STATES.FEEDBACK);
  });

  test('a full level run produces the exact state transition sequence', () => {
    const { engine, clock } = makeEngine();
    const transitions = [];
    engine.on('state:changed', (payload) => transitions.push(`${payload.from}>${payload.to}`));
    engine.startLevel(1);
    runLevel(engine, clock);
    assert.equal(transitions[0], 'READY>PLAYING');
    assert.equal(transitions[transitions.length - 1], 'FEEDBACK>LEVEL_COMPLETE');
    const playingFeedback = transitions.filter((t) => t === 'PLAYING>FEEDBACK').length;
    const feedbackPlaying = transitions.filter((t) => t === 'FEEDBACK>PLAYING').length;
    assert.equal(playingFeedback, 8); // one per question
    assert.equal(feedbackPlaying, 7); // between questions
  });

  test('question:loaded fires once per question', () => {
    const { engine, clock } = makeEngine();
    const loaded = [];
    engine.on('question:loaded', (payload) => loaded.push(payload.question.id));
    engine.startLevel(1);
    runLevel(engine, clock);
    assert.equal(loaded.length, 8);
    assert.equal(new Set(loaded).size, 8);
  });

  test('answer events fire with the full result payload', () => {
    const { engine, clock } = makeEngine();
    const correct = [];
    const wrong = [];
    const resolved = [];
    engine.on('answer:correct', (payload) => correct.push(payload));
    engine.on('answer:wrong', (payload) => wrong.push(payload));
    engine.on('answer:resolved', (payload) => resolved.push(payload));
    engine.startLevel(1);
    runLevel(engine, clock, { pattern: [true, false, true, false, true, false, true, false] });
    assert.equal(correct.length, 4);
    assert.equal(wrong.length, 4);
    assert.equal(resolved.length, 8);
    assert.ok(questionById.has(correct[0].questionId));
    assert.equal(correct[0].questionId, resolved[0].questionId);
    assert.equal(typeof wrong[0].pointsGained, 'number');
    assert.ok(resolved.every((r) => typeof r.isCorrect === 'boolean'));
  });

  test('player:lane-changed reports from, to and lane category', () => {
    const { engine } = makeEngine();
    const events = [];
    engine.on('player:lane-changed', (payload) => events.push(payload));
    engine.startLevel(1);
    const laneMap = engine.getSnapshot().laneMap;
    engine.moveLeft();
    assert.deepEqual(events[0], { from: 1, to: 0, category: laneMap[0] });
  });
});

/* ========================================================================
 * 19. Snapshots
 * ====================================================================== */

describe('getSnapshot', () => {
  test('snapshot before any level is clean and null-safe', () => {
    const { engine } = makeEngine();
    const snap = engine.getSnapshot();
    assert.equal(snap.state, GAME_STATES.READY);
    assert.equal(snap.mode, null);
    assert.equal(snap.level, null);
    assert.equal(snap.question, null);
    assert.equal(snap.session, null);
    assert.equal(snap.lives, null);
    assert.equal(snap.lastResult, null);
  });

  test('snapshot during play exposes the full render surface', () => {
    const { engine } = makeEngine();
    engine.startLevel(1);
    const snap = engine.getSnapshot();
    assert.equal(snap.state, GAME_STATES.PLAYING);
    assert.equal(snap.mode, GAME_MODES.LEARN);
    assert.equal(snap.level.id, 1);
    assert.equal(snap.level.title, 'A or An');
    assert.equal(snap.level.questionCount, 8);
    assert.equal(snap.level.requiredAccuracy, gameData.levels[0].requiredAccuracy);
    assert.equal(snap.playerLane, START_LANE);
    assert.equal(snap.gateProgress, 0);
    assert.equal(snap.inputLocked, false);
    assert.equal(snap.score, 0);
    assert.ok(snap.question.id);
    assert.ok(snap.session);
  });

  test('mutating the returned lane map cannot corrupt the engine', () => {
    const { engine } = makeEngine();
    engine.startLevel(1);
    const snap = engine.getSnapshot();
    snap.laneMap.push('bogus');
    snap.laneMap[0] = 'bogus';
    assert.ok(isPermutationOfCategories(engine.getSnapshot().laneMap));
  });

  test('mutating the returned session or result cannot corrupt the engine', () => {
    const { engine, clock } = makeEngine();
    engine.startLevel(1);
    answerOnce(engine, clock);
    const before = engine.getSnapshot();
    const snap = engine.getSnapshot();
    snap.session.correct = 999;
    snap.session.answered = 999;
    snap.lastResult.pointsGained = 99999;
    snap.score = 99999;
    const fresh = engine.getSnapshot();
    assert.equal(fresh.session.correct, 1);
    assert.equal(fresh.session.answered, 1);
    assert.equal(fresh.score, before.score);
    assert.equal(fresh.lastResult.pointsGained, before.lastResult.pointsGained);
  });
});

/* ========================================================================
 * 20. Determinism & injection
 * ====================================================================== */

describe('determinism and dependency injection', () => {
  test('two engines with identical rng and clocks behave identically', () => {
    const a = makeEngine();
    const b = makeEngine();
    a.engine.startLevel(1);
    b.engine.startLevel(1);
    const idsA = [];
    const idsB = [];
    const mapsA = [];
    const mapsB = [];
    while (a.engine.state === GAME_STATES.PLAYING) {
      idsA.push(a.engine.getSnapshot().question.id);
      mapsA.push(a.engine.getSnapshot().laneMap.join('|'));
      answerOnce(a.engine, a.clock);
      a.engine.continueAfterFeedback();
    }
    while (b.engine.state === GAME_STATES.PLAYING) {
      idsB.push(b.engine.getSnapshot().question.id);
      mapsB.push(b.engine.getSnapshot().laneMap.join('|'));
      answerOnce(b.engine, b.clock);
      b.engine.continueAfterFeedback();
    }
    assert.deepEqual(idsA, idsB);
    assert.deepEqual(mapsA, mapsB);
  });

  test('different seeded rng values produce different valid question sequences', () => {
    const first = traceForLevel(10, 0x11111111);
    const second = traceForLevel(10, 0x99999999);
    const idsA = first.map((entry) => entry.id);
    const idsB = second.map((entry) => entry.id);
    assert.notDeepEqual(idsA, idsB);
    assert.equal(new Set(idsA).size, idsA.length);
    assert.equal(new Set(idsB).size, idsB.length);
    assert.deepEqual(categoryCounts(first), { none: 4, definite: 4, indefinite: 4 });
    assert.deepEqual(categoryCounts(second), { none: 4, definite: 4, indefinite: 4 });
  });

  test('an injected clock controls timing without real delays', () => {
    const clock = createClock(5000);
    const { engine } = makeEngine({ clock });
    engine.startLevel(1);
    clock.advance(800);
    engine.chooseCategory(correctCategoryFor(engine.getSnapshot().question.id));
    const result = engine.submitCurrentLane();
    assert.equal(result.responseMs, 800);
    const expectedSpeed = Math.round(SC.fastBonusMax * (1 - 800 / SC.fastBonusWindowMs));
    assert.equal(result.speedBonus, expectedSpeed);
    assert.equal(result.perfectBonus, SC.perfectQuestionBonus);
  });
});

/* ========================================================================
 * 21. Arcade Mode specifics
 * ====================================================================== */

describe('arcade mode specifics', () => {
  test('a wrong answer removes exactly the configured life penalty', () => {
    const { engine, clock } = makeEngine();
    engine.startLevel(1, { mode: GAME_MODES.ARCADE });
    const result = answerOnce(engine, clock, { correct: false });
    assert.equal(
      gameData.settings.startingLivesArcade - result.livesRemaining,
      gameData.scoring.arcadeLifePenalty
    );
    assert.equal(result.livesRemaining, 2);
  });

  test('arcade finishing all questions with lives left completes the level', () => {
    const { engine, clock } = makeEngine();
    const overs = [];
    engine.on('game:over', () => overs.push(1));
    engine.startLevel(1, { mode: GAME_MODES.ARCADE });
    const { outcome, summary } = runLevel(engine, clock);
    assert.equal(outcome, 'level-complete');
    assert.equal(overs.length, 0);
    assert.equal(summary.mode, GAME_MODES.ARCADE);
    assert.equal(summary.lives, 3);
    assert.equal(engine.state, GAME_STATES.LEVEL_COMPLETE);
  });

  test('arcade results still track score, streak and mastery', () => {
    const { engine, clock } = makeEngine();
    engine.startLevel(1, { mode: GAME_MODES.ARCADE });
    const { summary } = runLevel(engine, clock);
    assert.ok(summary.score > 0);
    assert.equal(summary.bestStreak, 8);
    assert.equal(engine.getMastery('indefinite-first-mention').attempts, 4);
    assert.equal(engine.getProgress().totalAttempts, 8);
  });
});
