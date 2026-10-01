// Article Runner — dependency-free game engine.
// Pure logic only: no DOM, no timers, no network. Every tunable gameplay value
// lives in game-data.json so designers can rebalance the game without touching code.

export const WILDCARD_RULE = "*";
export const BLANK = "___";

export const VALID_CATEGORIES = ["none", "definite", "indefinite"];
const VALID_ARTICLES = {
  none: [""],
  definite: ["the"],
  indefinite: ["a", "an"],
};
const QUESTION_CEFR = ["A1", "A2", "B1", "B2", "C1", "C2"];
const LEVEL_CEFR = [...QUESTION_CEFR, "A1/A2", "A2/B1", "B1/B2"];
const VALID_MODES = ["learn", "arcade"];
const REQUIRED_SECTIONS = [
  "meta",
  "settings",
  "scoring",
  "starRules",
  "ruleCatalog",
  "levels",
  "questions",
];

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
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}
function isRatio(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1;
}
function normalizeSpaces(text) {
  return String(text).replace(/\s+/g, " ").trim();
}

export function validateGameData(data) {
  const errors = [];
  const err = (message) => errors.push(message);

  if (!isPlainObject(data)) {
    return { ok: false, errors: ["Game data must be a JSON object."] };
  }
  for (const section of REQUIRED_SECTIONS) {
    if (!(section in data)) err(`Missing top-level section "${section}".`);
  }
  if (errors.length > 0) return { ok: false, errors };

  const { meta, settings, scoring, starRules, ruleCatalog, levels, questions } = data;

  if (!Number.isInteger(meta.schemaVersion) || meta.schemaVersion < 1) {
    err("meta.schemaVersion must be a positive integer.");
  }
  if (!isNonEmptyString(meta.gameId)) err("meta.gameId must be a non-empty string.");
  if (!isNonEmptyString(meta.title)) err("meta.title must be a non-empty string.");
  if (!VALID_MODES.includes(meta.defaultMode)) {
    err(`meta.defaultMode must be one of ${VALID_MODES.join(", ")}.`);
  }

  const cats = settings.answerCategories;
  if (
    !Array.isArray(cats) ||
    cats.length !== 3 ||
    !VALID_CATEGORIES.every((c) => cats.includes(c))
  ) {
    err(
      `settings.answerCategories must contain exactly the three lane categories: ${VALID_CATEGORIES.join(", ")}.`
    );
  }
  const positiveInts = [
    "recentQuestionWindow",
    "defaultQuestionCount",
    "minimumQuestionsToPass",
    "startingLivesArcade",
    "minimumAttemptsForMastery",
  ];
  for (const key of positiveInts) {
    if (!Number.isInteger(settings[key]) || settings[key] < 1) {
      err(`settings.${key} must be an integer >= 1.`);
    }
  }
  for (const key of ["feedbackDelayMs", "wrongAnswerFeedbackDelayMs"]) {
    if (typeof settings[key] !== "number" || !Number.isFinite(settings[key]) || settings[key] < 0) {
      err(`settings.${key} must be a number >= 0.`);
    }
  }
  if (typeof settings.maxAdaptiveWeight !== "number" || settings.maxAdaptiveWeight < 1) {
    err("settings.maxAdaptiveWeight must be a number >= 1.");
  }
  if (!isRatio(settings.masteryThreshold)) {
    err("settings.masteryThreshold must be a ratio between 0 (exclusive) and 1 (inclusive).");
  }

  const nonNegNumbers = [
    "baseCorrect",
    "fastBonusMax",
    "perfectQuestionBonus",
    "arcadeLifePenalty",
  ];
  for (const key of nonNegNumbers) {
    if (typeof scoring[key] !== "number" || !Number.isFinite(scoring[key]) || scoring[key] < 0) {
      err(`scoring.${key} must be a number >= 0.`);
    }
  }
  for (const key of ["fastBonusWindowMs", "perfectWindowMs"]) {
    if (typeof scoring[key] !== "number" || !Number.isFinite(scoring[key]) || scoring[key] <= 0) {
      err(`scoring.${key} must be a number > 0.`);
    }
  }
  if (typeof scoring.streakStep !== "number" || !Number.isFinite(scoring.streakStep) || scoring.streakStep < 0) {
    err("scoring.streakStep must be a number >= 0.");
  }
  if (typeof scoring.maxStreakMultiplier !== "number" || !Number.isFinite(scoring.maxStreakMultiplier) || scoring.maxStreakMultiplier < 1) {
    err("scoring.maxStreakMultiplier must be a number >= 1.");
  }

  for (const key of ["threeStarsAccuracy", "twoStarsAccuracy", "oneStarAccuracy"]) {
    if (!isRatio(starRules[key])) {
      err(`starRules.${key} must be a ratio between 0 (exclusive) and 1 (inclusive).`);
    }
  }
  if (starRules.threeStarsAccuracy < starRules.twoStarsAccuracy || starRules.twoStarsAccuracy < starRules.oneStarAccuracy) {
    err("starRules thresholds must be ordered: threeStarsAccuracy >= twoStarsAccuracy >= oneStarAccuracy.");
  }

  if (!Array.isArray(ruleCatalog) || ruleCatalog.length === 0) {
    err("ruleCatalog must be a non-empty array.");
  }
  const ruleIds = new Set();
  if (Array.isArray(ruleCatalog)) {
    for (const rule of ruleCatalog) {
      if (!isNonEmptyString(rule.id)) {
        err("Every rule needs a non-empty id.");
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
    err("levels must be a non-empty array.");
  }
  const levelIds = new Set();
  if (Array.isArray(levels)) {
    for (const level of levels) {
      if (!Number.isInteger(level.id) || level.id < 1) {
        err("Every level needs an integer id >= 1.");
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
      if (typeof level.speed !== "number" || !Number.isFinite(level.speed) || level.speed <= 0) {
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
      if (!isRatio(level.requiredAccuracy)) {
        err(`${tag} requiredAccuracy must be a ratio between 0 (exclusive) and 1 (inclusive).`);
      }
      if (level.unlockAfter !== null) {
        if (!levelIds.has(level.unlockAfter) && !levels.some((l) => l.id === level.unlockAfter)) {
          err(`${tag} unlockAfter must be null or an existing level id.`);
        } else if (level.unlockAfter >= level.id) {
          err(`${tag} unlockAfter must reference an earlier level.`);
        }
      }
    }
  }

  if (!Array.isArray(questions) || questions.length === 0) {
    err("questions must be a non-empty array.");
  }
  const questionIds = new Set();
  const sentences = new Set();
  if (Array.isArray(questions)) {
    for (const q of questions) {
      if (!isNonEmptyString(q.id)) {
        err("Every question needs a non-empty id.");
        continue;
      }
      if (questionIds.has(q.id)) err(`Duplicate question id "${q.id}".`);
      questionIds.add(q.id);
      const tag = `Question "${q.id}"`;

      if (typeof q.sentence !== "string") {
        err(`${tag} sentence must be a string.`);
      } else {
        const blankCount = q.sentence.split(BLANK).length - 1;
        if (blankCount !== 1) {
          err(`${tag} must contain exactly one "___" blank (found ${blankCount}).`);
        } else {
          const i = q.sentence.indexOf(BLANK);
          if (i === 0) err(`${tag} blank must not be at the start of the sentence.`);
          else if (q.sentence[i - 1] !== " ") err(`${tag} blank must be preceded by a space.`);
          if (i + BLANK.length >= q.sentence.length) {
            err(`${tag} blank must not be at the end of the sentence.`);
          } else if (q.sentence[i + BLANK.length] !== " ") {
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
          err(`${tag} has invalid answer category "${q.answer.category}".`);
        } else if (!VALID_ARTICLES[q.answer.category].includes(q.answer.article)) {
          err(
            `${tag} article "${q.answer.article}" does not match category "${q.answer.category}" ` +
              `(expected one of: ${VALID_ARTICLES[q.answer.category].map((a) => JSON.stringify(a)).join(", ")}).`
          );
        }
      }

      if (!isNonEmptyString(q.explanation)) err(`${tag} needs a non-empty explanation.`);
      if (typeof q.sentence === "string" && isNonEmptyString(q.completedSentence)) {
        const expected = normalizeSpaces(q.sentence.replace(BLANK, q.answer?.article ?? ""));
        if (expected !== normalizeSpaces(q.completedSentence)) {
          err(`${tag} completedSentence must equal the sentence with the blank filled in.`);
        }
      } else if (!isNonEmptyString(q.completedSentence)) {
        err(`${tag} needs a non-empty completedSentence.`);
      }
    }
  }

  if (Array.isArray(levels) && Array.isArray(questions) && ruleIds.size > 0) {
    for (const level of levels) {
      if (!Number.isInteger(level.id) || !Array.isArray(level.rules)) continue;
      const eligible = getEligibleQuestions(data, level);
      const required = Number.isInteger(level.questionCount) ? level.questionCount : 0;
      if (eligible.length < required) {
        err(
          `Level ${level.id} has only ${eligible.length} eligible questions but needs at least ${required}.`
        );
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

export function loadGameData(jsonString) {
  let parsed;
  try {
    parsed = JSON.parse(jsonString);
  } catch (error) {
    throw new Error(`game data is not valid JSON: ${error.message}`);
  }
  const { ok, errors } = validateGameData(parsed);
  if (!ok) throw new Error(`Invalid game data:\n- ${errors.join("\n- ")}`);
  return parsed;
}

export function getEligibleQuestions(data, level) {
  const wildcard = Array.isArray(level.rules) && level.rules.includes(WILDCARD_RULE);
  return data.questions.filter(
    (q) =>
      q.levelMin <= level.id &&
      (wildcard || (Array.isArray(level.rules) && level.rules.includes(q.rule)))
  );
}

// ---- Scoring math (pure functions so the UI and tests agree with the engine) ----

export function calculateSpeedBonus(scoring, elapsedMs) {
  if (typeof elapsedMs !== "number" || !Number.isFinite(elapsedMs) || elapsedMs < 0) return 0;
  if (elapsedMs > scoring.fastBonusWindowMs) return 0;
  return Math.round(scoring.fastBonusMax * (1 - elapsedMs / scoring.fastBonusWindowMs));
}

export function isPerfectAnswer(scoring, elapsedMs) {
  return typeof elapsedMs === "number" && Number.isFinite(elapsedMs) && elapsedMs >= 0 && elapsedMs <= scoring.perfectWindowMs;
}

export function calculateStreakMultiplier(scoring, streakCount) {
  const safeStreak = Math.max(0, Math.floor(streakCount));
  return Math.min(1 + scoring.streakStep * Math.max(0, safeStreak - 1), scoring.maxStreakMultiplier);
}

export function calculateScore(scoring, elapsedMs, streakAfter) {
  const speedBonus = calculateSpeedBonus(scoring, elapsedMs);
  const perfectBonus = isPerfectAnswer(scoring, elapsedMs) ? scoring.perfectQuestionBonus : 0;
  const multiplier = calculateStreakMultiplier(scoring, streakAfter);
  return {
    base: scoring.baseCorrect,
    speedBonus,
    perfectBonus,
    multiplier,
    total: Math.round((scoring.baseCorrect + speedBonus + perfectBonus) * multiplier),
  };
}

export function calculateStars(starRules, accuracy) {
  if (accuracy >= starRules.threeStarsAccuracy) return 3;
  if (accuracy >= starRules.twoStarsAccuracy) return 2;
  if (accuracy >= starRules.oneStarAccuracy) return 1;
  return 0;
}

export function requiredCorrectFor(data, level, totalQuestions) {
  const byAccuracy = Math.ceil(totalQuestions * level.requiredAccuracy);
  return Math.max(data.settings.minimumQuestionsToPass, byAccuracy);
}

// ---- Rule mastery and adaptive weighting ----

export function createRuleStats() {
  return { attempts: 0, correct: 0 };
}

export function ruleAccuracy(stats) {
  if (!stats || stats.attempts <= 0) return 0;
  return stats.correct / stats.attempts;
}

export function isRuleMastered(settings, stats) {
  return (
    !!stats &&
    stats.attempts >= settings.minimumAttemptsForMastery &&
    ruleAccuracy(stats) >= settings.masteryThreshold
  );
}

export function computeRuleWeight(settings, stats) {
  const weakness = !stats || stats.attempts === 0 ? 0.6 : 1 - ruleAccuracy(stats);
  const weight = 1 + (settings.maxAdaptiveWeight - 1) * weakness;
  return Math.round(Math.min(weight, settings.maxAdaptiveWeight) * 100) / 100;
}

export function pickWeightedQuestion(questions, settings, ruleStats, rng, excludeIds = []) {
  const pool = questions.filter((q) => !excludeIds.includes(q.id));
  if (pool.length === 0) return null;
  const weights = pool.map((q) => computeRuleWeight(settings, ruleStats[q.rule] ?? createRuleStats()));
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  let roll = rng() * totalWeight;
  for (let i = 0; i < pool.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return pool[i];
  }
  return pool[pool.length - 1];
}

export function getWeakRules(data, ruleStats, limit = 5) {
  return data.ruleCatalog
    .map((rule) => {
      const stats = ruleStats[rule.id] ?? createRuleStats();
      return {
        rule: rule.id,
        label: rule.label,
        attempts: stats.attempts,
        correct: stats.correct,
        accuracy: ruleAccuracy(stats),
        mastered: isRuleMastered(data.settings, stats),
      };
    })
    .filter((entry) => entry.attempts > 0 && !entry.mastered)
    .sort((a, b) => a.accuracy - b.accuracy || b.attempts - a.attempts)
    .slice(0, limit);
}

// ---- Progress persistence ----

export function createProgress() {
  return {
    version: 1,
    levels: {},
    ruleStats: {},
    recentQuestionIds: [],
    totals: { runs: 0, questionsAnswered: 0, correctAnswers: 0 },
  };
}

export function exportProgress(progress) {
  return JSON.stringify(progress);
}

export function loadProgress(json) {
  try {
    const parsed = JSON.parse(json);
    if (isPlainObject(parsed) && isPlainObject(parsed.levels) && isPlainObject(parsed.ruleStats)) {
      return parsed;
    }
  } catch {
    // fall through to a fresh progress file on any unreadable input
  }
  return createProgress();
}

export function isLevelUnlocked(data, progress, levelId) {
  const level = data.levels.find((l) => l.id === levelId);
  if (!level) return false;
  if (level.unlockAfter === null || level.unlockAfter === undefined) return true;
  return Boolean(progress?.levels?.[level.unlockAfter]?.passed);
}

export function getUnlockedLevels(data, progress) {
  return data.levels.filter((level) => isLevelUnlocked(data, progress, level.id));
}

// ---- Game session ----

export function createGame(options) {
  return new GameEngine(options);
}

export class GameEngine {
  constructor({ data, mode, levelId, rng, now, progress, questionCount } = {}) {
    if (!isPlainObject(data)) throw new TypeError("createGame requires a game data object.");
    const validation = validateGameData(data);
    if (!validation.ok) {
      throw new Error(`Cannot start a game with invalid data:\n- ${validation.errors.join("\n- ")}`);
    }
    this.data = data;
    this.settings = data.settings;
    this.scoring = data.scoring;

    this.mode = mode ?? data.meta.defaultMode;
    if (!VALID_MODES.includes(this.mode)) {
      throw new Error(`Unknown mode "${this.mode}". Expected one of: ${VALID_MODES.join(", ")}.`);
    }

    this.level = data.levels.find((l) => l.id === levelId);
    if (!this.level) throw new Error(`Unknown level id "${levelId}".`);

    this.rng = typeof rng === "function" ? rng : createRng((Date.now() ^ (Math.random() * 0xffffffff)) >>> 0);
    this.now = typeof now === "function" ? now : () => Date.now();

    this.progress = progress ?? createProgress();
    this.ruleStats = this._cloneRuleStats();

    this.totalQuestions =
      questionCount ?? this.level.questionCount ?? this.settings.defaultQuestionCount;

    this.score = 0;
    this.streak = 0;
    this.bestStreak = 0;
    this.correctCount = 0;
    this.wrongCount = 0;
    this.lives = this.mode === "arcade" ? this.settings.startingLivesArcade : null;
    this.results = [];
    this.finished = false;
    this.current = null;
    this.presentedAt = null;

    this.usedQuestionIds = [];
    this.recentQuestionIds = [];
    this._loadNext();
  }

  _cloneRuleStats() {
    const clone = {};
    for (const [ruleId, stats] of Object.entries(this.progress.ruleStats ?? {})) {
      clone[ruleId] = { attempts: stats.attempts ?? 0, correct: stats.correct ?? 0 };
    }
    return clone;
  }

  _eligibleQuestions() {
    return getEligibleQuestions(this.data, this.level);
  }

  _nextQuestion() {
    const eligible = this._eligibleQuestions();
    if (eligible.length === 0) return null;
    // Learn mode never repeats a question inside one run; arcade only avoids
    // the recent-question window so an endless session can recycle the pool.
    const exclude =
      this.mode === "learn" ? this.usedQuestionIds : this.recentQuestionIds.slice();
    let question = pickWeightedQuestion(eligible, this.settings, this.ruleStats, this.rng, exclude);
    if (!question) {
      question = pickWeightedQuestion(eligible, this.settings, this.ruleStats, this.rng, []);
    }
    return question;
  }

  _loadNext() {
    const question = this._nextQuestion();
    if (!question) {
      this.finished = true;
      return;
    }
    this.current = question;
    this.presentedAt = this.now();
  }

  getQuestion() {
    if (!this.current) return null;
    // Lane-safe view: the answer, explanation and completed sentence are only
    // revealed through submitAnswer so a UI can never leak them by accident.
    return {
      id: this.current.id,
      levelMin: this.current.levelMin,
      cefr: this.current.cefr,
      rule: this.current.rule,
      sentence: this.current.sentence,
      index: this.results.length + 1,
      total: this.totalQuestions,
    };
  }

  submitAnswer(category) {
    if (this.finished || !this.current) {
      throw new Error("No active question: the run is finished or has not started.");
    }
    if (!VALID_CATEGORIES.includes(category)) {
      throw new TypeError(`Unknown answer category "${category}". Expected one of: ${VALID_CATEGORIES.join(", ")}.`);
    }

    const question = this.current;
    const elapsedMs = Math.max(0, this.now() - this.presentedAt);
    const correct = category === question.answer.category;

    let scoreDelta = 0;
    let breakdown = null;
    if (correct) {
      this.streak += 1;
      this.bestStreak = Math.max(this.bestStreak, this.streak);
      this.correctCount += 1;
      breakdown = calculateScore(this.scoring, elapsedMs, this.streak);
      scoreDelta = breakdown.total;
      this.score += scoreDelta;
    } else {
      this.streak = 0;
      this.wrongCount += 1;
      if (this.mode === "arcade") {
        this.lives = Math.max(0, this.lives - this.scoring.arcadeLifePenalty);
      }
    }

    const stats = (this.ruleStats[question.rule] ??= createRuleStats());
    stats.attempts += 1;
    if (correct) stats.correct += 1;

    this.usedQuestionIds.push(question.id);
    this.recentQuestionIds.push(question.id);
    if (this.recentQuestionIds.length > this.settings.recentQuestionWindow) {
      this.recentQuestionIds.splice(0, this.recentQuestionIds.length - this.settings.recentQuestionWindow);
    }

    this.results.push({
      questionId: question.id,
      chosen: category,
      correct,
      scoreDelta,
      elapsedMs,
    });

    const answeredAll = this.results.length >= this.totalQuestions;
    const outOfLives = this.mode === "arcade" && this.lives <= 0;
    this.current = null;
    this.finished = answeredAll || outOfLives;
    if (!this.finished) this._loadNext();

    return {
      questionId: question.id,
      chosen: category,
      correct,
      expectedCategory: question.answer.category,
      article: question.answer.article,
      explanation: question.explanation,
      completedSentence: question.completedSentence,
      scoreDelta,
      breakdown,
      elapsedMs,
      streak: this.streak,
      lives: this.lives,
      feedbackDelayMs: correct
        ? this.settings.feedbackDelayMs
        : this.settings.wrongAnswerFeedbackDelayMs,
      finished: this.finished,
    };
  }

  getStatus() {
    return {
      mode: this.mode,
      levelId: this.level.id,
      levelTitle: this.level.title,
      cefr: this.level.cefr,
      speed: this.level.speed,
      questionIndex: this.current ? this.results.length + 1 : this.results.length,
      totalQuestions: this.totalQuestions,
      score: this.score,
      streak: this.streak,
      bestStreak: this.bestStreak,
      correctCount: this.correctCount,
      wrongCount: this.wrongCount,
      lives: this.lives,
      finished: this.finished,
    };
  }

  getAccuracy() {
    const answered = this.results.length;
    return answered === 0 ? 0 : this.correctCount / answered;
  }

  getRuleStats() {
    const clone = {};
    for (const [ruleId, stats] of Object.entries(this.ruleStats)) {
      clone[ruleId] = { ...stats };
    }
    return clone;
  }

  getWeakRules(limit = 5) {
    return getWeakRules(this.data, this.ruleStats, limit);
  }

  getResult() {
    const answered = this.results.length;
    const accuracy = this.getAccuracy();
    const requiredCorrect = requiredCorrectFor(this.data, this.level, this.totalQuestions);
    const passed =
      this.finished &&
      (this.mode === "learn"
        ? this.correctCount >= requiredCorrect
        : this.lives > 0);
    return {
      mode: this.mode,
      levelId: this.level.id,
      levelTitle: this.level.title,
      plannedQuestions: this.totalQuestions,
      answered,
      correctCount: this.correctCount,
      wrongCount: this.wrongCount,
      accuracy,
      requiredCorrect,
      passed,
      stars: this.finished ? calculateStars(this.data.starRules, accuracy) : 0,
      score: this.score,
      bestStreak: this.bestStreak,
      lives: this.lives,
      ruleStats: this.getRuleStats(),
      weakRules: this.getWeakRules(),
    };
  }

  saveProgress(progress = this.progress) {
    for (const [ruleId, stats] of Object.entries(this.ruleStats)) {
      const target = (progress.ruleStats[ruleId] ??= createRuleStats());
      target.attempts += stats.attempts;
      target.correct += stats.correct;
    }

    const previous = progress.levels[this.level.id] ?? {
      stars: 0,
      bestScore: 0,
      passed: false,
      attempts: 0,
    };
    const result = this.getResult();
    progress.levels[this.level.id] = {
      stars: Math.max(previous.stars, result.stars),
      bestScore: Math.max(previous.bestScore, result.score),
      passed: previous.passed || result.passed,
      attempts: previous.attempts + 1,
    };

    progress.recentQuestionIds = [...this.recentQuestionIds];
    progress.totals.runs += 1;
    progress.totals.questionsAnswered += result.answered;
    progress.totals.correctAnswers += result.correctCount;
    return progress;
  }
}
