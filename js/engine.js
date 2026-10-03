/**
 * Article Runner — browser engine (js/engine.js)
 * --------------------------------------------------------------------------
 * Stateful game engine that drives the three-lane runner UI. Owns everything:
 * state machine, question presentation (answer hidden until resolution),
 * lane randomization, gate timing, scoring, streaks, lives, mastery,
 * level progression and localStorage persistence.
 *
 * The UI layer (js/game.js) only renders snapshots/events and forwards input.
 *
 * Pure, dependency-free and DOM-free so the same file runs in Node tests
 * (tests/engine.test.js) and in the browser. This is the single canonical
 * engine for the project; all tuning lives in data/game-data.json.
 */

/* ------------------------------------------------------------------ */
/* Public constants                                                    */
/* ------------------------------------------------------------------ */

export const ANSWER_CATEGORIES = Object.freeze({
  NONE: 'none',
  DEFINITE: 'definite',
  INDEFINITE: 'indefinite',
});

export const GAME_MODES = Object.freeze({
  LEARN: 'learn',
  ARCADE: 'arcade',
});

export const GAME_STATES = Object.freeze({
  BOOT: 'BOOT',
  READY: 'READY',
  PLAYING: 'PLAYING',
  FEEDBACK: 'FEEDBACK',
  PAUSED: 'PAUSED',
  LEVEL_COMPLETE: 'LEVEL_COMPLETE',
  GAME_OVER: 'GAME_OVER',
});

export const LANE_COUNT = 3;
export const START_LANE = 1;
export const PROGRESS_STORAGE_KEY = 'article-runner:progress:v1';

/** Frame deltas are clamped so a tab switch can never cause a huge jump. */
const MAX_FRAME_DELTA_MS = 100;

const VALID_CATEGORIES = ['none', 'definite', 'indefinite'];
const VALID_ARTICLES = { none: [''], definite: ['the'], indefinite: ['a', 'an'] };
const VALID_MODES = ['learn', 'arcade'];
const BLANK = '___';
const WILDCARD_RULE = '*';
const QUESTION_CEFR = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
const LEVEL_CEFR = [...QUESTION_CEFR, 'A1/A2', 'A2/B1', 'B1/B2'];
const REQUIRED_SECTIONS = ['meta', 'settings', 'scoring', 'starRules', 'ruleCatalog', 'levels', 'questions'];
const INDEFINITE_ARTICLES = ['a', 'an'];
const CATEGORY_TARGET_SUM_TOLERANCE = 0.001;
const MAX_FEASIBILITY_SEARCH_ITEMS = 24;
const MAX_FEASIBILITY_SEARCH_STATES = 50000;

/* ------------------------------------------------------------------ */
/* Small utilities                                                     */
/* ------------------------------------------------------------------ */

// Deterministic RNG (mulberry32) so tests and replays are reproducible.
export function createRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}
function isRatio(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1;
}
function normalizeSpaces(text) {
  return String(text).replace(/\s+/g, ' ').trim();
}
function round2(value) {
  return Math.round(value * 100) / 100;
}
function deepCopy(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function countRecord(keys, initial = 0) {
  return Object.fromEntries(keys.map((key) => [key, initial]));
}

function listAllowsRule(rules, ruleId) {
  return Array.isArray(rules) && (rules.includes(WILDCARD_RULE) || rules.includes(ruleId));
}

function levelAllowsRule(level, ruleId) {
  return listAllowsRule(level.rules, ruleId) || listAllowsRule(level.contrastRules, ruleId);
}

/**
 * Hamilton / largest-remainder allocation followed by capacity-aware
 * redistribution. The bounded redistribution loop runs at most `total` times.
 */
function allocateCappedQuotas(total, targets, capacities, keys) {
  const safeTotal = Math.max(0, Math.trunc(total));
  const raw = Object.fromEntries(keys.map((key) => [key, safeTotal * (targets[key] ?? 0)]));
  const quotas = Object.fromEntries(keys.map((key) => [key, Math.floor(raw[key])]));
  const keyOrder = new Map(keys.map((key, index) => [key, index]));

  let unassigned = safeTotal - keys.reduce((sum, key) => sum + quotas[key], 0);
  const remainderOrder = [...keys].sort(
    (a, b) =>
      raw[b] - Math.floor(raw[b]) - (raw[a] - Math.floor(raw[a])) ||
      keyOrder.get(a) - keyOrder.get(b)
  );
  for (let i = 0; i < unassigned; i += 1) {
    quotas[remainderOrder[i % remainderOrder.length]] += 1;
  }

  for (const key of keys) {
    const capacity = Math.max(0, Math.trunc(capacities[key] ?? 0));
    quotas[key] = Math.min(quotas[key], capacity);
  }

  unassigned = safeTotal - keys.reduce((sum, key) => sum + quotas[key], 0);
  for (let i = 0; i < unassigned; i += 1) {
    const candidates = keys.filter((key) => quotas[key] < Math.max(0, Math.trunc(capacities[key] ?? 0)));
    if (candidates.length === 0) break;
    candidates.sort(
      (a, b) =>
        raw[b] - quotas[b] - (raw[a] - quotas[a]) ||
        (targets[b] ?? 0) - (targets[a] ?? 0) ||
        keyOrder.get(a) - keyOrder.get(b)
    );
    quotas[candidates[0]] += 1;
  }
  return quotas;
}

function trailingRun(history) {
  if (history.length === 0) return { value: null, length: 0 };
  const value = history[history.length - 1];
  let length = 1;
  for (let i = history.length - 2; i >= 0 && history[i] === value; i -= 1) length += 1;
  return { value, length };
}

function wouldMakeThirdRepeat(history, candidate) {
  return history.length >= 2 && history[history.length - 1] === candidate && history[history.length - 2] === candidate;
}

function wouldCompleteCategoryPattern(history, candidate) {
  if (history.length < 5) return false;
  const sequence = [...history.slice(-5), candidate];
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
  return repeatsTwo || repeatsThree;
}

function runCapacityIsFeasible(remaining, keys, lastValue, lastRunLength) {
  const total = keys.reduce((sum, key) => sum + remaining[key], 0);
  return keys.every((key) => {
    const count = remaining[key];
    const otherCount = total - count;
    const firstBlockCapacity = key === lastValue ? Math.max(0, 2 - lastRunLength) : 2;
    return count <= firstBlockCapacity + 2 * otherCount;
  });
}

/**
 * Exact bounded backtracking for ordinary level sizes, with the equivalent
 * run-capacity test as a safe large-input/state-budget fallback.
 */
function canCompleteWithoutThirdRepeat(remainingInput, history, keys, avoidCategoryPatterns = false) {
  const remaining = Object.fromEntries(keys.map((key) => [key, Math.max(0, Math.trunc(remainingInput[key] ?? 0))]));
  const total = keys.reduce((sum, key) => sum + remaining[key], 0);
  const tail = trailingRun(history);
  if (!runCapacityIsFeasible(remaining, keys, tail.value, tail.length)) return false;
  if (total > MAX_FEASIBILITY_SEARCH_ITEMS) return true;

  const memo = new Map();
  let states = 0;
  const search = (recentHistory, left) => {
    if (left === 0) return true;
    const currentTail = trailingRun(recentHistory);
    if (states >= MAX_FEASIBILITY_SEARCH_STATES) {
      return runCapacityIsFeasible(remaining, keys, currentTail.value, currentTail.length);
    }
    states += 1;
    const patternTail = recentHistory.slice(-5);
    const key = `${keys.map((name) => remaining[name]).join(',')}|${patternTail.join(',')}`;
    if (memo.has(key)) return memo.get(key);
    if (!runCapacityIsFeasible(remaining, keys, currentTail.value, currentTail.length)) {
      memo.set(key, false);
      return false;
    }

    const choices = keys
      .filter((name) => remaining[name] > 0 && !wouldMakeThirdRepeat(recentHistory, name))
      .filter((name) => !avoidCategoryPatterns || !wouldCompleteCategoryPattern(recentHistory, name))
      .sort((a, b) => remaining[b] - remaining[a] || String(a).localeCompare(String(b)));
    for (const choice of choices) {
      remaining[choice] -= 1;
      const possible = search([...patternTail, choice], left - 1);
      remaining[choice] += 1;
      if (possible) {
        memo.set(key, true);
        return true;
      }
    }
    memo.set(key, false);
    return false;
  };

  return search(history.slice(-5), total);
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
  };
}

/* ------------------------------------------------------------------ */
/* StorageAdapter & EventBus                                           */
/* ------------------------------------------------------------------ */

/**
 * JSON storage wrapper around any { getItem, setItem, removeItem } backend.
 * Strings are stored raw so pre-serialized JSON round-trips unchanged.
 */
export class StorageAdapter {
  constructor(backend) {
    const injected = backend ?? createMemoryStorage();
    this._backend = injected;
    // An explicitly injected backend is treated as durable; only the internal
    // in-memory fallback reports itself as non-persistent.
    this.isPersistent = backend !== undefined && backend !== null;
  }

  get(key, fallback = null) {
    try {
      const raw = this._backend.getItem(key);
      if (raw === null || raw === undefined) return fallback;
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  }

  set(key, value) {
    try {
      this._backend.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  }

  remove(key) {
    try {
      this._backend.removeItem(key);
      return true;
    } catch {
      return false;
    }
  }
}

/** Minimal event bus; one throwing handler never breaks the others. */
export class EventBus {
  constructor() {
    this._handlers = new Map();
  }

  on(name, handler) {
    if (typeof handler !== 'function') throw new TypeError('Event handler must be a function.');
    if (!this._handlers.has(name)) this._handlers.set(name, new Set());
    this._handlers.get(name).add(handler);
    return () => this.off(name, handler);
  }

  off(name, handler) {
    this._handlers.get(name)?.delete(handler);
  }

  emit(name, payload) {
    const handlers = this._handlers.get(name);
    if (!handlers || handlers.size === 0) return;
    for (const handler of [...handlers]) {
      try {
        handler(payload);
      } catch (error) {
        // Isolate handler bugs so gameplay never depends on UI correctness.
        if (typeof console !== 'undefined' && typeof console.error === 'function') {
          console.error(`[ArticleRunnerEngine] handler for "${name}" threw:`, error);
        }
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Scoring math (pure functions so the UI and tests agree with the engine) */
/* ------------------------------------------------------------------ */

function speedBonusFor(scoring, elapsedMs) {
  if (elapsedMs > scoring.fastBonusWindowMs) return 0;
  return Math.round(scoring.fastBonusMax * (1 - elapsedMs / scoring.fastBonusWindowMs));
}

function perfectBonusFor(scoring, elapsedMs) {
  return elapsedMs >= 0 && elapsedMs <= scoring.perfectWindowMs ? scoring.perfectQuestionBonus : 0;
}

function streakMultiplierFor(scoring, streakAfter) {
  const safe = Math.max(1, Math.floor(streakAfter));
  return round2(Math.min(1 + scoring.streakStep * (safe - 1), scoring.maxStreakMultiplier));
}

function starsFor(starRules, accuracy) {
  if (accuracy >= starRules.threeStarsAccuracy) return 3;
  if (accuracy >= starRules.twoStarsAccuracy) return 2;
  if (accuracy >= starRules.oneStarAccuracy) return 1;
  return 0;
}

/* ------------------------------------------------------------------ */
/* Static data validation                                              */
/* ------------------------------------------------------------------ */

function collectDataProblems(data) {
  const errors = [];
  const err = (message) => errors.push(message);

  if (!isPlainObject(data)) {
    return ['Game data must be a plain object.'];
  }
  for (const section of REQUIRED_SECTIONS) {
    if (!(section in data)) err(`Missing required section "${section}".`);
  }
  if (errors.length > 0) return errors;

  const { meta, settings, scoring, starRules, ruleCatalog, levels, questions } = data;

  if (!Number.isInteger(meta.schemaVersion) || meta.schemaVersion < 1) {
    err('meta.schemaVersion must be a positive integer.');
  }
  if (!isNonEmptyString(meta.gameId)) err('meta.gameId must be a non-empty string.');
  if (!isNonEmptyString(meta.title)) err('meta.title must be a non-empty string.');
  if (!VALID_MODES.includes(meta.defaultMode)) {
    err(`meta.defaultMode must be one of ${VALID_MODES.join(', ')}.`);
  }

  const cats = settings.answerCategories;
  if (!Array.isArray(cats) || cats.length !== 3 || !VALID_CATEGORIES.every((c) => cats.includes(c))) {
    err(`settings.answerCategories must contain exactly the three lane categories: ${VALID_CATEGORIES.join(', ')}.`);
  }
  for (const key of [
    'recentQuestionWindow',
    'defaultQuestionCount',
    'minimumQuestionsToPass',
    'startingLivesArcade',
    'minimumAttemptsForMastery',
  ]) {
    if (!Number.isInteger(settings[key]) || settings[key] < 1) {
      err(`settings.${key} must be an integer >= 1.`);
    }
  }
  for (const key of ['feedbackDelayMs', 'wrongAnswerFeedbackDelayMs']) {
    if (typeof settings[key] !== 'number' || !Number.isFinite(settings[key]) || settings[key] < 0) {
      err(`settings.${key} must be a number >= 0.`);
    }
  }
  if (typeof settings.maxAdaptiveWeight !== 'number' || !Number.isFinite(settings.maxAdaptiveWeight) || settings.maxAdaptiveWeight < 1) {
    err('settings.maxAdaptiveWeight must be a number >= 1.');
  }
  if (!isRatio(settings.masteryThreshold)) {
    err('settings.masteryThreshold must be a ratio between 0 (exclusive) and 1 (inclusive).');
  }

  if (typeof scoring.baseCorrect !== 'number' || !Number.isFinite(scoring.baseCorrect) || scoring.baseCorrect <= 0) {
    err('scoring.baseCorrect must be a positive number.');
  }
  for (const key of ['fastBonusMax', 'perfectQuestionBonus', 'arcadeLifePenalty']) {
    if (typeof scoring[key] !== 'number' || !Number.isFinite(scoring[key]) || scoring[key] < 0) {
      err(`scoring.${key} must be a number >= 0.`);
    }
  }
  for (const key of ['fastBonusWindowMs', 'perfectWindowMs']) {
    if (typeof scoring[key] !== 'number' || !Number.isFinite(scoring[key]) || scoring[key] <= 0) {
      err(`scoring.${key} must be a number > 0.`);
    }
  }
  if (typeof scoring.streakStep !== 'number' || !Number.isFinite(scoring.streakStep) || scoring.streakStep < 0) {
    err('scoring.streakStep must be a number >= 0.');
  }
  if (typeof scoring.maxStreakMultiplier !== 'number' || !Number.isFinite(scoring.maxStreakMultiplier) || scoring.maxStreakMultiplier < 1) {
    err('scoring.maxStreakMultiplier must be a number >= 1.');
  }

  for (const key of ['threeStarsAccuracy', 'twoStarsAccuracy', 'oneStarAccuracy']) {
    if (!isRatio(starRules[key])) {
      err(`starRules.${key} must be a ratio between 0 (exclusive) and 1 (inclusive).`);
    }
  }
  if (
    starRules.threeStarsAccuracy < starRules.twoStarsAccuracy ||
    starRules.twoStarsAccuracy < starRules.oneStarAccuracy
  ) {
    err('starRules thresholds must be ordered: threeStarsAccuracy >= twoStarsAccuracy >= oneStarAccuracy.');
  }

  if (!Array.isArray(ruleCatalog) || ruleCatalog.length === 0) {
    err('ruleCatalog must be a non-empty array.');
  }
  const ruleIds = new Set();
  if (Array.isArray(ruleCatalog)) {
    for (const rule of ruleCatalog) {
      if (!isPlainObject(rule) || !isNonEmptyString(rule.id)) {
        err('Every rule needs a non-empty id.');
        continue;
      }
      if (ruleIds.has(rule.id)) err(`Duplicate rule id "${rule.id}" in ruleCatalog.`);
      ruleIds.add(rule.id);
      if (!isNonEmptyString(rule.label)) err(`Rule "${rule.id}" needs a non-empty label.`);
      if (!isNonEmptyString(rule.summary)) err(`Rule "${rule.id}" needs a non-empty summary.`);
      if (!VALID_CATEGORIES.includes(rule.category)) {
        err(`Rule "${rule.id}" has invalid category "${rule.category}".`);
      }
      if (!QUESTION_CEFR.includes(rule.cefr)) {
        err(`Rule "${rule.id}" has invalid CEFR level "${rule.cefr}".`);
      }
    }
  }

  if (!Array.isArray(levels) || levels.length === 0) {
    err('levels must be a non-empty array.');
  }
  const levelIds = new Set();
  if (Array.isArray(levels)) {
    for (const level of levels) {
      if (!isPlainObject(level) || !Number.isInteger(level.id) || level.id < 1) {
        err('Every level needs an integer id >= 1.');
        continue;
      }
      if (levelIds.has(level.id)) err(`Duplicate level id ${level.id}.`);
      levelIds.add(level.id);
      const tag = `Level ${level.id}`;
      if (!isNonEmptyString(level.title)) err(`${tag} needs a non-empty title.`);
      if (!LEVEL_CEFR.includes(level.cefr)) err(`${tag} has invalid CEFR level "${level.cefr}".`);
      if (!Number.isInteger(level.questionCount) || level.questionCount < 1) {
        err(`${tag} questionCount must be an integer >= 1.`);
      }
      if (typeof level.speed !== 'number' || !Number.isFinite(level.speed) || level.speed <= 0) {
        err(`${tag} speed must be a number > 0.`);
      }
      if (!Array.isArray(level.rules) || level.rules.length === 0) {
        err(`${tag} must list at least one rule (or the wildcard "*").`);
      } else if (level.rules.includes(WILDCARD_RULE)) {
        if (level.rules.length !== 1) err(`${tag} wildcard "*" must be the only rule entry.`);
      } else {
        for (const ruleId of level.rules) {
          if (!ruleIds.has(ruleId)) err(`${tag} references unknown rule "${ruleId}".`);
        }
      }
      if (level.contrastRules !== undefined) {
        if (!Array.isArray(level.contrastRules)) {
          err(`${tag} contrastRules must be an array when provided.`);
        } else if (level.contrastRules.includes(WILDCARD_RULE)) {
          if (level.contrastRules.length !== 1) {
            err(`${tag} contrastRules wildcard "*" must be the only entry.`);
          }
        } else {
          for (const ruleId of level.contrastRules) {
            if (!ruleIds.has(ruleId)) err(`${tag} contrastRules references unknown rule "${ruleId}".`);
          }
        }
      }
      if (level.categoryTargets !== undefined) {
        if (!isPlainObject(level.categoryTargets)) {
          err(`${tag} categoryTargets must be an object when provided.`);
        } else {
          const targetKeys = Object.keys(level.categoryTargets);
          const hasExactlyThreeCategories =
            targetKeys.length === VALID_CATEGORIES.length &&
            VALID_CATEGORIES.every((category) => targetKeys.includes(category));
          if (!hasExactlyThreeCategories) {
            err(`${tag} categoryTargets must contain exactly: ${VALID_CATEGORIES.join(', ')}.`);
          }
          let targetsAreRatios = true;
          for (const category of VALID_CATEGORIES) {
            if (!isRatio(level.categoryTargets[category])) {
              targetsAreRatios = false;
              err(`${tag} categoryTargets.${category} must be a positive ratio no greater than 1.`);
            }
          }
          if (targetsAreRatios) {
            const sum = VALID_CATEGORIES.reduce((total, category) => total + level.categoryTargets[category], 0);
            if (Math.abs(sum - 1) > CATEGORY_TARGET_SUM_TOLERANCE) {
              err(`${tag} categoryTargets must sum to 1 (within ${CATEGORY_TARGET_SUM_TOLERANCE}).`);
            }
          }
        }
      }
      if (!isRatio(level.requiredAccuracy)) {
        err(`${tag} requiredAccuracy must be a ratio between 0 (exclusive) and 1 (inclusive).`);
      }
      if (level.unlockAfter !== null && level.unlockAfter !== undefined) {
        if (!levelIds.has(level.unlockAfter) && !levels.some((l) => l.id === level.unlockAfter)) {
          err(`${tag} unlockAfter must be null or an existing level id.`);
        } else if (level.unlockAfter >= level.id) {
          err(`${tag} unlockAfter must reference an earlier level.`);
        }
      }
    }
  }

  if (!Array.isArray(questions) || questions.length === 0) {
    err('questions must be a non-empty array.');
  }
  const questionIds = new Set();
  const sentences = new Set();
  const errorCountBeforeQuestions = errors.length;
  if (Array.isArray(questions)) {
    for (const q of questions) {
      if (!isPlainObject(q) || !isNonEmptyString(q.id)) {
        err('Every question needs a non-empty id.');
        continue;
      }
      if (questionIds.has(q.id)) err(`Duplicate question id "${q.id}".`);
      questionIds.add(q.id);
      const tag = `Question "${q.id}"`;
      let answerOk = false;

      if (typeof q.sentence !== 'string') {
        err(`${tag} sentence must be a string.`);
      } else {
        const blankCount = q.sentence.split(BLANK).length - 1;
        if (blankCount !== 1) {
          err(`${tag} must contain exactly one "___" blank (found ${blankCount}).`);
        } else {
          const i = q.sentence.indexOf(BLANK);
          if (i === 0) err(`${tag} blank must not be at the start of the sentence.`);
          else if (q.sentence[i - 1] !== ' ') err(`${tag} blank must be preceded by a space.`);
          if (i + BLANK.length >= q.sentence.length) {
            err(`${tag} blank must not be at the end of the sentence.`);
          } else if (q.sentence[i + BLANK.length] !== ' ') {
            err(`${tag} blank must be followed by a space and at least one more word.`);
          }
        }
        const normalized = normalizeSpaces(q.sentence);
        if (sentences.has(normalized)) err(`${tag} duplicates an earlier sentence.`);
        sentences.add(normalized);
      }

      if (!ruleIds.has(q.rule)) err(`${tag} references unknown rule "${q.rule}".`);
      if (!QUESTION_CEFR.includes(q.cefr)) err(`${tag} has invalid CEFR level "${q.cefr}".`);
      if (!Number.isInteger(q.levelMin) || q.levelMin < 1) {
        err(`${tag} levelMin must be an integer >= 1.`);
      }
      if (!isPlainObject(q.answer)) {
        err(`${tag} needs an answer object.`);
      } else {
        if (!VALID_CATEGORIES.includes(q.answer.category)) {
          err(`${tag} has invalid answer.category "${q.answer.category}".`);
        } else if (!VALID_ARTICLES[q.answer.category].includes(q.answer.article)) {
          err(
            `${tag} answer article "${q.answer.article}" is not coherent with category "${q.answer.category}" ` +
              `(expected one of: ${VALID_ARTICLES[q.answer.category].map((a) => JSON.stringify(a)).join(', ')}).`
          );
        } else {
          answerOk = true;
        }
      }
      if (!isNonEmptyString(q.explanation)) err(`${tag} needs a non-empty explanation.`);
      if (!isNonEmptyString(q.completedSentence)) {
        err(`${tag} needs a non-empty completedSentence.`);
      } else if (typeof q.sentence === 'string' && answerOk) {
        // Only cross-check consistency when the sentence itself is well-formed,
        // so one broken field does not cascade into duplicate problems.
        const blankCount = q.sentence.split(BLANK).length - 1;
        if (blankCount === 1) {
          const expected = normalizeSpaces(q.sentence.replace(BLANK, q.answer.article ?? ''));
          if (expected !== normalizeSpaces(q.completedSentence)) {
            err(`${tag} completedSentence must equal the sentence with the blank filled in.`);
          }
        }
      }
    }
  }
  const questionsHaveErrors = errors.length > errorCountBeforeQuestions;

  // Only audit level pools when the questions themselves are clean, so a
  // single broken question does not cascade into pool-shortage problems.
  if (!questionsHaveErrors && Array.isArray(levels) && Array.isArray(questions) && ruleIds.size > 0) {
    for (const level of levels) {
      if (!Number.isInteger(level.id) || !Array.isArray(level.rules)) continue;
      const eligible = questions.filter(
        (q) => q.levelMin <= level.id && levelAllowsRule(level, q.rule)
      );
      if (eligible.length === 0) {
        err(`Level ${level.id} has no eligible questions for its rules.`);
      } else if (Number.isInteger(level.questionCount) && eligible.length < level.questionCount) {
        err(`Level ${level.id} has only ${eligible.length} eligible questions but needs at least ${level.questionCount}.`);
      }
    }
  }

  return errors;
}

/* ------------------------------------------------------------------ */
/* Progress helpers                                                    */
/* ------------------------------------------------------------------ */

function createDefaultProgress() {
  return {
    version: 1,
    passedLevels: [],
    levels: {},
    mastery: {},
    totalAttempts: 0,
    totalCorrect: 0,
    recentQuestions: [],
  };
}

function toCount(value) {
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

function sanitizeProgress(raw, data) {
  const progress = createDefaultProgress();
  if (!isPlainObject(raw)) return progress;

  const levelIdSet = new Set(data.levels.map((l) => l.id));
  if (Array.isArray(raw.passedLevels)) {
    progress.passedLevels = [
      ...new Set(
        raw.passedLevels
          .map((id) => (typeof id === 'string' && levelIdSet.has(Number(id)) ? Number(id) : id))
          .filter((id) => levelIdSet.has(id))
      ),
    ].sort((a, b) => a - b);
  }
  if (isPlainObject(raw.levels)) {
    for (const [id, record] of Object.entries(raw.levels)) {
      if (!isPlainObject(record)) continue;
      progress.levels[id] = {
        completions: toCount(record.completions),
        bestAccuracy: Number.isFinite(record.bestAccuracy) ? record.bestAccuracy : 0,
        bestStars: toCount(record.bestStars),
        bestScore: toCount(record.bestScore),
        lastAccuracy: Number.isFinite(record.lastAccuracy) ? record.lastAccuracy : 0,
        lastStars: toCount(record.lastStars),
        lastScore: toCount(record.lastScore),
        lastCompletedAt: typeof record.lastCompletedAt === 'string' ? record.lastCompletedAt : null,
      };
    }
  }
  if (isPlainObject(raw.mastery)) {
    for (const [ruleId, stats] of Object.entries(raw.mastery)) {
      if (!isPlainObject(stats)) continue;
      progress.mastery[ruleId] = { attempts: toCount(stats.attempts), correct: toCount(stats.correct) };
    }
  }
  progress.totalAttempts = toCount(raw.totalAttempts);
  progress.totalCorrect = toCount(raw.totalCorrect);
  if (Array.isArray(raw.recentQuestions)) {
    progress.recentQuestions = raw.recentQuestions.filter((id) => typeof id === 'string' || Number.isInteger(id));
  }
  return progress;
}

/* ------------------------------------------------------------------ */
/* The engine                                                          */
/* ------------------------------------------------------------------ */

export class ArticleRunnerEngine {
  /**
   * @param {object} options
   * @param {object} options.data          parsed game-data.json (required)
   * @param {function} [options.rng]       () => number in [0, 1)
   * @param {Storage|object} [options.storage] getItem/setItem/removeItem backend
   * @param {function} [options.now]       () => number, injectable clock
   * @param {string} [options.mode]        default mode override
   */
  constructor({ data, rng, storage, now, mode } = {}) {
    if (!isPlainObject(data)) {
      throw new TypeError('ArticleRunnerEngine requires game data (options.data).');
    }
    const problems = collectDataProblems(data);
    if (problems.length > 0) {
      throw new Error(`Invalid game data (${problems.length} problem(s)):\n- ${problems.join('\n- ')}`);
    }

    this._data = data;
    this._settings = data.settings;
    this._scoring = data.scoring;
    this._ruleLabel = new Map(data.ruleCatalog.map((rule) => [rule.id, rule.label]));
    this._ruleCategory = new Map(data.ruleCatalog.map((rule) => [rule.id, rule.category]));

    this._mode = mode ?? data.meta.defaultMode;
    if (!VALID_MODES.includes(this._mode)) {
      throw new Error(`Invalid mode "${this._mode}". Expected one of: ${VALID_MODES.join(', ')}.`);
    }

    this._rng = typeof rng === 'function' ? rng : createRng((Date.now() ^ (Math.random() * 0xffffffff)) >>> 0);
    this._now = typeof now === 'function' ? now : () => Date.now();

    let backend = storage;
    if (!backend || typeof backend.getItem !== 'function') {
      try {
        if (typeof localStorage !== 'undefined') backend = localStorage;
      } catch {
        backend = null;
      }
      if (!backend) backend = createMemoryStorage();
    }
    this._storage = new StorageAdapter(backend);
    this._events = new EventBus();

    this._progress = sanitizeProgress(this._storage.get(PROGRESS_STORAGE_KEY, null), data);

    this._state = GAME_STATES.READY;
    this._level = null;
    this._sessionMode = null;
    this._totalQuestions = 0;
    this._current = null;
    this._presentedAt = 0;
    this._runStartedAt = 0;
    this._playerLane = START_LANE;
    this._laneMap = [];
    this._gateElapsedMs = 0;
    this._score = 0;
    this._streak = 0;
    this._bestStreak = 0;
    this._lives = null;
    this._results = [];
    this._lastResult = null;
    this._usedQuestionIds = [];
    this._categoryTargets = countRecord(VALID_CATEGORIES);
    this._categoryQuotas = countRecord(VALID_CATEGORIES);
    this._categoryCounts = countRecord(VALID_CATEGORIES);
    this._categoryHistory = [];
    this._articleQuotas = countRecord(INDEFINITE_ARTICLES);
    this._articleCounts = countRecord(INDEFINITE_ARTICLES);
    this._articleHistory = [];
    this._sessionRuleStats = {};
    this._pauseStartedAt = null;
  }

  /* ------------ statics ------------ */

  /** Validate a game data object; returns { ok: true } or throws with every problem. */
  static validateData(data) {
    const problems = collectDataProblems(data);
    if (problems.length > 0) {
      throw new Error(`Invalid game data (${problems.length} problem(s)):\n- ${problems.join('\n- ')}`);
    }
    return { ok: true };
  }

  /* ------------ events ------------ */

  on(name, handler) {
    return this._events.on(name, handler);
  }

  off(name, handler) {
    this._events.off(name, handler);
  }

  /* ------------ simple getters ------------ */

  get state() {
    return this._state;
  }

  get playerLane() {
    return this._playerLane;
  }

  get laneMap() {
    return [...this._laneMap];
  }

  get gateProgress() {
    if (!this._level || this._state === GAME_STATES.READY) return 0;
    return Math.min(1, (this._gateElapsedMs * this._level.speed) / 1000);
  }

  get inputLocked() {
    return this._state !== GAME_STATES.PLAYING;
  }

  get score() {
    return this._score;
  }

  get streak() {
    return this._streak;
  }

  get bestStreak() {
    return this._bestStreak;
  }

  get lives() {
    return this._lives;
  }

  get mode() {
    return this._sessionMode;
  }

  /** Public, lane-safe view of the current question (answer stays hidden). */
  getPublicQuestion() {
    if (!this._current) return null;
    const q = this._current;
    return {
      id: q.id,
      sentence: q.sentence,
      cefr: q.cefr,
      rule: q.rule,
      ruleLabel: this._ruleLabel.get(q.rule) ?? q.rule,
      levelMin: q.levelMin,
      index: this._results.length + 1,
      total: this._totalQuestions,
    };
  }

  getSnapshot() {
    return {
      state: this._state,
      mode: this._sessionMode,
      level: this._level
        ? {
            id: this._level.id,
            title: this._level.title,
            cefr: this._level.cefr,
            questionCount: this._level.questionCount,
            requiredAccuracy: this._level.requiredAccuracy,
            speed: this._level.speed,
          }
        : null,
      question: this.getPublicQuestion(),
      session: this._level
        ? {
            mode: this._sessionMode,
            levelId: this._level.id,
            questionIndex: this._results.length,
            totalQuestions: this._totalQuestions,
            correct: this._results.filter((r) => r.isCorrect).length,
            wrong: this._results.filter((r) => !r.isCorrect).length,
            answered: this._results.length,
          }
        : null,
      lives: this._lives,
      playerLane: this._playerLane,
      laneMap: [...this._laneMap],
      gateProgress: this.gateProgress,
      inputLocked: this.inputLocked,
      score: this._score,
      streak: this._streak,
      bestStreak: this._bestStreak,
      lastResult: this._lastResult ? deepCopy(this._lastResult) : null,
    };
  }

  /* ------------ level lifecycle ------------ */

  startLevel(levelId, { mode, ignoreLock = false } = {}) {
    return this._startLevel(levelId, { mode, ignoreLock, allowAnyState: false });
  }

  restartLevel() {
    if (!this._level) throw new Error('No level to restart: startLevel() first.');
    return this._startLevel(this._level.id, { mode: this._sessionMode, ignoreLock: true, allowAnyState: true });
  }

  _startLevel(levelId, { mode, ignoreLock, allowAnyState }) {
    if (!allowAnyState && ![GAME_STATES.READY, GAME_STATES.LEVEL_COMPLETE, GAME_STATES.GAME_OVER].includes(this._state)) {
      throw new Error(
        `Cannot start a level from state "${this._state}". Use restartLevel() to retry the current run.`
      );
    }

    const level = this._data.levels.find((l) => l.id === levelId || String(l.id) === String(levelId));
    if (!level) throw new Error(`Unknown level "${levelId}".`);

    const runMode = mode ?? this._mode;
    if (!VALID_MODES.includes(runMode)) {
      throw new Error(`Invalid mode "${runMode}". Expected one of: ${VALID_MODES.join(', ')}.`);
    }

    if (!ignoreLock && runMode === GAME_MODES.LEARN && !this._isLevelUnlocked(level)) {
      throw new Error(
        `Level ${level.id} is locked. Pass level ${level.unlockAfter} in Learn Mode first (or use ignoreLock).`
      );
    }

    this._level = level;
    this._sessionMode = runMode;
    this._totalQuestions = level.questionCount ?? this._settings.defaultQuestionCount;
    this._score = 0;
    this._streak = 0;
    this._bestStreak = 0;
    this._lives = runMode === GAME_MODES.ARCADE ? this._settings.startingLivesArcade : null;
    this._results = [];
    this._lastResult = null;
    this._usedQuestionIds = [];
    this._categoryCounts = countRecord(VALID_CATEGORIES);
    this._categoryHistory = [];
    this._articleCounts = countRecord(INDEFINITE_ARTICLES);
    this._articleHistory = [];
    this._sessionRuleStats = {};
    this._runStartedAt = this._now();
    this._pauseStartedAt = null;
    this._initializeQuestionSelectionPlan();

    this._setState(GAME_STATES.PLAYING);
    this._events.emit('level:started', {
      level: { ...level },
      mode: runMode,
      totalQuestions: this._totalQuestions,
    });
    this._loadNextQuestion();
    return this.getSnapshot();
  }

  _isLevelUnlocked(level) {
    if (level.unlockAfter === null || level.unlockAfter === undefined) return true;
    return this._progress.passedLevels.includes(level.unlockAfter);
  }

  /* ------------ question selection ------------ */

  _categoryTargetsForLevel(level) {
    if (isPlainObject(level.categoryTargets)) {
      return Object.fromEntries(VALID_CATEGORIES.map((category) => [category, level.categoryTargets[category]]));
    }

    const primaryCategories = level.rules.includes(WILDCARD_RULE)
      ? [...VALID_CATEGORIES]
      : [
          ...new Set(
            level.rules
              .map((ruleId) => this._ruleCategory.get(ruleId))
              .filter((category) => VALID_CATEGORIES.includes(category))
          ),
        ];
    const targets = countRecord(VALID_CATEGORIES);
    if (primaryCategories.length === 1) {
      for (const category of VALID_CATEGORIES) {
        targets[category] = primaryCategories.includes(category) ? 0.5 : 0.25;
      }
    } else if (primaryCategories.length === 2) {
      for (const category of VALID_CATEGORIES) {
        targets[category] = primaryCategories.includes(category) ? 0.375 : 0.25;
      }
    } else {
      for (const category of VALID_CATEGORIES) targets[category] = 1 / VALID_CATEGORIES.length;
    }
    return targets;
  }

  _initializeQuestionSelectionPlan() {
    const eligible = this._eligibleQuestions();
    const categoryAvailability = countRecord(VALID_CATEGORIES);
    for (const question of eligible) categoryAvailability[question.answer.category] += 1;

    this._categoryTargets = this._categoryTargetsForLevel(this._level);
    this._categoryQuotas = allocateCappedQuotas(
      this._totalQuestions,
      this._categoryTargets,
      categoryAvailability,
      VALID_CATEGORIES
    );

    const articleAvailability = countRecord(INDEFINITE_ARTICLES);
    for (const question of eligible) {
      if (question.answer.category === ANSWER_CATEGORIES.INDEFINITE) {
        articleAvailability[question.answer.article] += 1;
      }
    }
    this._articleQuotas = allocateCappedQuotas(
      this._categoryQuotas[ANSWER_CATEGORIES.INDEFINITE],
      { a: 0.5, an: 0.5 },
      articleAvailability,
      INDEFINITE_ARTICLES
    );
  }

  _eligibleQuestions() {
    const level = this._level;
    return this._data.questions.filter(
      (q) => q.levelMin <= level.id && levelAllowsRule(level, q.rule)
    );
  }

  /** Adaptive weight: unseen / low-sample rules stay neutral, weak rules get boosted. */
  _ruleWeight(ruleId) {
    const stats = this._progress.mastery[ruleId];
    if (!stats || stats.attempts < this._settings.minimumAttemptsForMastery) return 1;
    const weakness = 1 - stats.correct / stats.attempts;
    const max = this._settings.maxAdaptiveWeight;
    return Math.round(Math.min(1 + (max - 1) * weakness, max) * 100) / 100;
  }

  _weightedPick(items, weightFor) {
    if (items.length === 0) return null;
    const weights = items.map((item) => {
      const weight = weightFor(item);
      return typeof weight === 'number' && Number.isFinite(weight) && weight > 0 ? weight : 0;
    });
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
    if (totalWeight <= 0) return items[Math.min(items.length - 1, Math.floor(this._rng() * items.length))];

    let roll = this._rng() * totalWeight;
    for (let i = 0; i < items.length; i += 1) {
      roll -= weights[i];
      if (roll <= 0) return items[i];
    }
    return items[items.length - 1];
  }

  _categoryChoiceKeepsQuotasFeasible(category) {
    const remaining = Object.fromEntries(
      VALID_CATEGORIES.map((name) => [name, Math.max(0, this._categoryQuotas[name] - this._categoryCounts[name])])
    );
    if (remaining[category] <= 0) return false;
    if (wouldMakeThirdRepeat(this._categoryHistory, category)) return false;
    if (wouldCompleteCategoryPattern(this._categoryHistory, category)) return false;
    remaining[category] -= 1;
    return canCompleteWithoutThirdRepeat(
      remaining,
      [...this._categoryHistory, category],
      VALID_CATEGORIES,
      true
    );
  }

  _articleChoiceKeepsQuotasFeasible(article) {
    const remaining = Object.fromEntries(
      INDEFINITE_ARTICLES.map((name) => [name, Math.max(0, this._articleQuotas[name] - this._articleCounts[name])])
    );
    if (remaining[article] <= 0) return false;
    remaining[article] -= 1;
    return canCompleteWithoutThirdRepeat(remaining, [...this._articleHistory, article], INDEFINITE_ARTICLES);
  }

  _firstViableOptionSet(stages, patternCheck = null) {
    for (const stage of stages) {
      if (stage.length === 0) continue;
      if (patternCheck) {
        const patternSafe = stage.filter((option) => !patternCheck(option));
        if (patternSafe.length > 0) return patternSafe;
      }
      return stage;
    }
    return [];
  }

  _pickCategory(questionsByCategory) {
    const available = VALID_CATEGORIES.filter((category) => questionsByCategory[category].length > 0);
    const remaining = Object.fromEntries(
      VALID_CATEGORIES.map((category) => [
        category,
        Math.max(0, this._categoryQuotas[category] - this._categoryCounts[category]),
      ])
    );
    const withQuota = available.filter((category) => remaining[category] > 0);
    const noThird = (category) => !wouldMakeThirdRepeat(this._categoryHistory, category);
    const feasible = (category) => this._categoryChoiceKeepsQuotasFeasible(category);
    const options = this._firstViableOptionSet(
      [
        withQuota.filter((category) => noThird(category) && feasible(category)),
        withQuota.filter(noThird),
        available.filter(noThird),
        withQuota.filter(feasible),
        withQuota,
        available,
      ],
      (category) => wouldCompleteCategoryPattern(this._categoryHistory, category)
    );
    return this._weightedPick(options, (category) => remaining[category] || 0.25);
  }

  _pickIndefiniteQuestion(candidates, recent) {
    const questionsByArticle = Object.fromEntries(INDEFINITE_ARTICLES.map((article) => [article, []]));
    for (const question of candidates) questionsByArticle[question.answer.article].push(question);

    const available = INDEFINITE_ARTICLES.filter((article) => questionsByArticle[article].length > 0);
    const remaining = Object.fromEntries(
      INDEFINITE_ARTICLES.map((article) => [
        article,
        Math.max(0, this._articleQuotas[article] - this._articleCounts[article]),
      ])
    );
    const withQuota = available.filter((article) => remaining[article] > 0);
    const noThird = (article) => !wouldMakeThirdRepeat(this._articleHistory, article);
    const feasible = (article) => this._articleChoiceKeepsQuotasFeasible(article);
    const articleOptions = this._firstViableOptionSet([
      withQuota.filter((article) => noThird(article) && feasible(article)),
      withQuota.filter(noThird),
      available.filter(noThird),
      withQuota.filter(feasible),
      withQuota,
      available,
    ]);
    const article = this._weightedPick(articleOptions, (name) => remaining[name] || 0.25);
    if (!article) return null;

    const articleCandidates = questionsByArticle[article];
    const nonRecent = articleCandidates.filter((question) => !recent.has(question.id));
    const pool = nonRecent.length > 0 ? nonRecent : articleCandidates;
    return this._weightedPick(pool, (question) => this._ruleWeight(question.rule));
  }

  _pickQuestion() {
    const eligible = this._eligibleQuestions();
    if (eligible.length === 0) return null;

    const used = new Set(this._usedQuestionIds);
    const recent = new Set(this._progress.recentQuestions);
    let pool = eligible.filter((question) => !used.has(question.id));
    if (pool.length === 0) {
      const previousId = this._usedQuestionIds[this._usedQuestionIds.length - 1];
      const withoutImmediateRepeat = eligible.filter((question) => question.id !== previousId);
      pool = withoutImmediateRepeat.length > 0 ? withoutImmediateRepeat : eligible;
    }

    const questionsByCategory = Object.fromEntries(VALID_CATEGORIES.map((category) => [category, []]));
    for (const question of pool) questionsByCategory[question.answer.category].push(question);
    const category = this._pickCategory(questionsByCategory);
    if (!category) return this._weightedPick(pool, (question) => this._ruleWeight(question.rule));

    const categoryCandidates = questionsByCategory[category];
    if (category === ANSWER_CATEGORIES.INDEFINITE) {
      return (
        this._pickIndefiniteQuestion(categoryCandidates, recent) ??
        this._weightedPick(categoryCandidates, (question) => this._ruleWeight(question.rule))
      );
    }

    const nonRecent = categoryCandidates.filter((question) => !recent.has(question.id));
    const questionPool = nonRecent.length > 0 ? nonRecent : categoryCandidates;
    return this._weightedPick(questionPool, (question) => this._ruleWeight(question.rule));
  }

  _shuffleLanes() {
    const lanes = [...this._settings.answerCategories];
    for (let i = lanes.length - 1; i > 0; i -= 1) {
      const j = Math.floor(this._rng() * (i + 1));
      [lanes[i], lanes[j]] = [lanes[j], lanes[i]];
    }
    return lanes;
  }

  _loadNextQuestion() {
    const question = this._pickQuestion();
    this._current = question;
    this._presentedAt = this._now();
    this._gateElapsedMs = 0;
    this._playerLane = START_LANE;
    this._laneMap = this._shuffleLanes();
    this._setState(GAME_STATES.PLAYING);
    if (question) {
      this._usedQuestionIds.push(question.id);
      this._categoryHistory.push(question.answer.category);
      this._categoryCounts[question.answer.category] += 1;
      if (question.answer.category === ANSWER_CATEGORIES.INDEFINITE) {
        this._articleHistory.push(question.answer.article);
        this._articleCounts[question.answer.article] += 1;
      }
      this._events.emit('question:loaded', {
        question: this.getPublicQuestion(),
        questionNumber: this._results.length + 1,
        totalQuestions: this._totalQuestions,
        laneMap: [...this._laneMap],
        playerLane: this._playerLane,
        gateDurationMs: Math.round(1000 / this._level.speed),
      });
    }
  }

  /* ------------ main loop ------------ */

  /**
   * Advance the gate by one frame. Only valid while PLAYING; deltas are
   * clamped to MAX_FRAME_DELTA_MS so a background tab cannot fast-forward
   * the gate. When progress reaches 1 the current lane resolves as a
   * collision.
   */
  update(deltaMs) {
    if (this._state !== GAME_STATES.PLAYING || !this._current) return false;
    if (typeof deltaMs !== 'number' || !Number.isFinite(deltaMs) || deltaMs <= 0) return false;

    const clamped = Math.min(deltaMs, MAX_FRAME_DELTA_MS);
    this._gateElapsedMs += clamped;
    const progress = this.gateProgress;
    this._events.emit('game:tick', {
      deltaMs: clamped,
      requestedDeltaMs: deltaMs,
      gateProgress: progress,
      playerLane: this._playerLane,
    });
    if (progress >= 1) {
      this._resolveCurrentQuestion(true);
    }
    return true;
  }

  /* ------------ player input ------------ */

  _assertMovementAllowed() {
    if (this._state !== GAME_STATES.PLAYING) {
      throw new Error(`Player input is locked while in state "${this._state}".`);
    }
  }

  moveToLane(lane) {
    this._assertMovementAllowed();
    if (!Number.isInteger(lane) || lane < 0 || lane >= LANE_COUNT) {
      throw new RangeError(`moveToLane expects an integer lane between 0 and ${LANE_COUNT - 1}.`);
    }
    if (lane === this._playerLane) return false;
    const from = this._playerLane;
    this._playerLane = lane;
    this._events.emit('player:lane-changed', { from, to: lane, category: this._laneMap[lane] });
    return true;
  }

  moveLeft() {
    this._assertMovementAllowed();
    if (this._playerLane === 0) return false;
    return this.moveToLane(this._playerLane - 1);
  }

  moveRight() {
    this._assertMovementAllowed();
    if (this._playerLane === LANE_COUNT - 1) return false;
    return this.moveToLane(this._playerLane + 1);
  }

  chooseCategory(category) {
    this._assertMovementAllowed();
    if (!VALID_CATEGORIES.includes(category)) {
      throw new Error(`Unknown answer category "${category}". Expected one of: ${VALID_CATEGORIES.join(', ')}.`);
    }
    const lane = this._laneMap.indexOf(category);
    if (lane === -1 || lane === this._playerLane) return false;
    return this.moveToLane(lane);
  }

  /** Resolve the current question with whatever lane the player is in. */
  submitCurrentLane() {
    if (this._state === GAME_STATES.READY) {
      throw new Error(`Cannot submit an answer from state "${GAME_STATES.READY}": no level is running.`);
    }
    if (this._state !== GAME_STATES.PLAYING) {
      throw new Error(`The current question has already been resolved (state "${this._state}").`);
    }
    return this._resolveCurrentQuestion(false);
  }

  /* ------------ pause / resume ------------ */

  pause() {
    if (this._state !== GAME_STATES.PLAYING) {
      throw new Error(`pause() is only valid during PLAYING (current state "${this._state}").`);
    }
    this._pauseStartedAt = this._now();
    this._setState(GAME_STATES.PAUSED);
    this._events.emit('game:paused', { levelId: this._level?.id ?? null });
    return this.getSnapshot();
  }

  resume() {
    if (this._state !== GAME_STATES.PAUSED) {
      throw new Error(`resume() is only valid during PAUSED (current state "${this._state}").`);
    }
    const pausedFor = Math.max(0, this._now() - (this._pauseStartedAt ?? this._now()));
    // Paused time must not count towards the answer's response time.
    this._presentedAt += pausedFor;
    this._runStartedAt += pausedFor;
    this._pauseStartedAt = null;
    this._setState(GAME_STATES.PLAYING);
    this._events.emit('game:resumed', { pausedFor });
    return this.getSnapshot();
  }

  /* ------------ answer resolution ------------ */

  _resolveCurrentQuestion(automatic) {
    if (this._state !== GAME_STATES.PLAYING || !this._current) return null;

    const question = this._current;
    const selectedLane = this._playerLane;
    const selectedCategory = this._laneMap[selectedLane];
    const isCorrect = selectedCategory === question.answer.category;
    const responseMs = Math.max(0, this._now() - this._presentedAt);

    let pointsGained = 0;
    let speedBonus = 0;
    let perfectBonus = 0;
    let streakMultiplier = 1;

    if (isCorrect) {
      this._streak += 1;
      this._bestStreak = Math.max(this._bestStreak, this._streak);
      speedBonus = speedBonusFor(this._scoring, responseMs);
      perfectBonus = perfectBonusFor(this._scoring, responseMs);
      streakMultiplier = streakMultiplierFor(this._scoring, this._streak);
      pointsGained = Math.round(
        (this._scoring.baseCorrect + speedBonus + perfectBonus) * streakMultiplier
      );
      this._score += pointsGained;
    } else {
      this._streak = 0;
      if (this._sessionMode === GAME_MODES.ARCADE) {
        this._lives = Math.max(0, this._lives - this._scoring.arcadeLifePenalty);
      }
    }

    const stats = (this._sessionRuleStats[question.rule] ??= { attempts: 0, correct: 0 });
    stats.attempts += 1;
    if (isCorrect) stats.correct += 1;

    const longTerm = (this._progress.mastery[question.rule] ??= { attempts: 0, correct: 0 });
    longTerm.attempts += 1;
    if (isCorrect) longTerm.correct += 1;
    this._progress.totalAttempts += 1;
    if (isCorrect) this._progress.totalCorrect += 1;

    this._progress.recentQuestions.push(question.id);
    if (this._progress.recentQuestions.length > this._settings.recentQuestionWindow) {
      this._progress.recentQuestions.splice(0, this._progress.recentQuestions.length - this._settings.recentQuestionWindow);
    }

    const result = {
      questionId: question.id,
      selectedLane,
      selectedCategory,
      correctCategory: question.answer.category,
      correctArticle: question.answer.article,
      isCorrect,
      automatic,
      responseMs,
      explanation: question.explanation,
      completedSentence: question.completedSentence,
      rule: question.rule,
      ruleLabel: this._ruleLabel.get(question.rule) ?? question.rule,
      pointsGained,
      speedBonus,
      perfectBonus,
      streakMultiplier,
      totalScore: this._score,
      streak: this._streak,
      bestStreak: this._bestStreak,
      livesRemaining: this._sessionMode === GAME_MODES.ARCADE ? this._lives : null,
      questionIndex: this._results.length + 1,
      totalQuestions: this._totalQuestions,
      feedbackDelayMs: isCorrect
        ? this._settings.feedbackDelayMs
        : this._settings.wrongAnswerFeedbackDelayMs,
    };

    this._results.push({
      questionId: question.id,
      chosen: selectedCategory,
      isCorrect,
      pointsGained,
      responseMs,
      selectedLane,
    });
    this._lastResult = result;
    this._current = null;
    this._gateElapsedMs = 0;

    this._saveProgress();

    this._setState(GAME_STATES.FEEDBACK);
    this._events.emit(isCorrect ? 'answer:correct' : 'answer:wrong', deepCopy(result));
    this._events.emit('answer:resolved', deepCopy(result));
    return result;
  }

  /* ------------ flow control ------------ */

  continueAfterFeedback() {
    if (this._state !== GAME_STATES.FEEDBACK) {
      throw new Error(`continueAfterFeedback is only valid in FEEDBACK (current state "${this._state}").`);
    }

    const outOfLives = this._sessionMode === GAME_MODES.ARCADE && this._lives <= 0;
    if (outOfLives) {
      const summary = this._buildSummary(true);
      this._setState(GAME_STATES.GAME_OVER);
      this._events.emit('game:over', { reason: 'out-of-lives', summary: deepCopy(summary) });
      return { status: 'game-over', summary: deepCopy(summary) };
    }

    if (this._results.length < this._totalQuestions) {
      this._loadNextQuestion();
      return { status: 'next-question', summary: null };
    }

    const summary = this._buildSummary(false);
    this._recordLevelResult(summary);
    this._setState(GAME_STATES.LEVEL_COMPLETE);
    this._events.emit('level:completed', { summary: deepCopy(summary) });
    return { status: 'level-complete', summary: deepCopy(summary) };
  }

  _buildSummary(gameOver) {
    const answered = this._results.length;
    const correct = this._results.filter((r) => r.isCorrect).length;
    const accuracy = answered === 0 ? 0 : correct / answered;
    const requiredCorrect = Math.max(
      this._settings.minimumQuestionsToPass,
      Math.ceil(this._totalQuestions * this._level.requiredAccuracy)
    );
    const passed = gameOver
      ? false
      : this._sessionMode === GAME_MODES.LEARN
        ? correct >= requiredCorrect
        : this._lives > 0;

    const weakRules = Object.entries(this._sessionRuleStats)
      .filter(([, stats]) => stats.attempts > 0 && stats.correct / stats.attempts < this._settings.masteryThreshold)
      .map(([rule, stats]) => ({
        rule,
        label: this._ruleLabel.get(rule) ?? rule,
        attempts: stats.attempts,
        correct: stats.correct,
        accuracy: stats.correct / stats.attempts,
      }))
      .sort((a, b) => a.accuracy - b.accuracy || String(a.rule).localeCompare(String(b.rule)));

    return {
      mode: this._sessionMode,
      levelId: this._level.id,
      levelTitle: this._level.title,
      cefr: this._level.cefr,
      correct,
      wrong: answered - correct,
      answered,
      totalQuestions: this._totalQuestions,
      requiredCorrect,
      accuracy,
      passed,
      stars: gameOver ? 0 : starsFor(this._data.starRules, accuracy),
      score: this._score,
      bestStreak: this._bestStreak,
      lives: this._lives,
      weakRules,
      durationMs: Math.max(0, this._now() - this._runStartedAt),
      gameOver,
      completedAt: new Date(this._now()).toISOString(),
    };
  }

  _recordLevelResult(summary) {
    this._progress.totalAttempts = this._progress.totalAttempts; // totals already tracked per answer
    if (this._sessionMode !== GAME_MODES.LEARN) {
      this._saveProgress();
      return;
    }

    const key = String(this._level.id);
    const previous = this._progress.levels[key] ?? {
      completions: 0,
      bestAccuracy: 0,
      bestStars: 0,
      bestScore: 0,
      lastAccuracy: 0,
      lastStars: 0,
      lastScore: 0,
      lastCompletedAt: null,
    };
    this._progress.levels[key] = {
      completions: previous.completions + 1,
      bestAccuracy: Math.max(previous.bestAccuracy, summary.accuracy),
      bestStars: Math.max(previous.bestStars, summary.stars),
      bestScore: Math.max(previous.bestScore, summary.score),
      lastAccuracy: summary.accuracy,
      lastStars: summary.stars,
      lastScore: summary.score,
      lastCompletedAt: summary.completedAt,
    };

    if (summary.passed && !this._progress.passedLevels.includes(this._level.id)) {
      this._progress.passedLevels.push(this._level.id);
      this._progress.passedLevels.sort((a, b) => a - b);
    }
    this._saveProgress();
  }

  /* ------------ mastery & progress ------------ */

  getMastery(ruleId) {
    const stats = this._progress.mastery[ruleId];
    const attempts = stats?.attempts ?? 0;
    const correct = stats?.correct ?? 0;
    const accuracy = attempts > 0 ? correct / attempts : 0;
    return {
      attempts,
      correct,
      accuracy,
      mastered:
        attempts >= this._settings.minimumAttemptsForMastery && accuracy >= this._settings.masteryThreshold,
    };
  }

  getProgress() {
    const unlockedLevels = this._data.levels
      .filter((level) => {
        if (level.unlockAfter === null || level.unlockAfter === undefined) return true;
        return this._progress.passedLevels.includes(level.unlockAfter);
      })
      .map((level) => level.id);
    return deepCopy({
      ...this._progress,
      unlockedLevels,
      highestUnlockedLevel: unlockedLevels.length > 0 ? Math.max(...unlockedLevels) : null,
    });
  }

  resetProgress() {
    this._progress = createDefaultProgress();
    this._storage.remove(PROGRESS_STORAGE_KEY);
    this._events.emit('progress:reset', {});
    return this.getProgress();
  }

  _saveProgress() {
    this._storage.set(PROGRESS_STORAGE_KEY, this._progress);
  }

  /* ------------ internals ------------ */

  _setState(next) {
    if (this._state === next) return;
    const from = this._state;
    this._state = next;
    this._events.emit('state:changed', { from, to: next });
  }
}

export default ArticleRunnerEngine;
