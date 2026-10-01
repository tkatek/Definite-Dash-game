import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import * as engine from "./engine.js";

const raw = await readFile(new URL("./game-data.json", import.meta.url), "utf8");
const data = JSON.parse(raw);

const VALID_CATEGORIES = ["none", "definite", "indefinite"];

function expectedCategoryOf(questionId) {
  const q = data.questions.find((entry) => entry.id === questionId);
  assert.ok(q, `question ${questionId} exists in data`);
  return q.answer.category;
}

function wrongCategoryOf(questionId) {
  const expected = expectedCategoryOf(questionId);
  return VALID_CATEGORIES.find((c) => c !== expected);
}

function brokenData(mutate) {
  const clone = structuredClone(data);
  mutate(clone);
  return engine.validateGameData(clone);
}

// ---------------------------------------------------------------------------
// game-data.json integrity
// ---------------------------------------------------------------------------

describe("game-data.json structure", () => {
  it("parses as JSON and contains every required top-level section", () => {
    for (const section of [
      "meta",
      "settings",
      "scoring",
      "starRules",
      "ruleCatalog",
      "levels",
      "questions",
    ]) {
      assert.ok(section in data, `missing section "${section}"`);
    }
    assert.equal(data.meta.gameId, "article-runner");
    assert.equal(data.meta.defaultMode, "learn");
  });

  it("passes engine validation and loads through loadGameData", () => {
    const result = engine.validateGameData(data);
    assert.deepEqual(result, { ok: true, errors: [] });
    const loaded = engine.loadGameData(raw);
    assert.equal(loaded.meta.schemaVersion, data.meta.schemaVersion);
    assert.equal(loaded.meta.title, "Article Runner");
  });

  it("loadGameData rejects malformed JSON with a clear error", () => {
    assert.throws(() => engine.loadGameData("{ not json"), /not valid JSON/);
  });

  it("configures exactly the three lane answer categories", () => {
    assert.deepEqual([...data.settings.answerCategories].sort(), [...VALID_CATEGORIES].sort());
    assert.equal(data.settings.answerCategories.length, 3);
  });
});

describe("question bank integrity", () => {
  it("has at least 40 questions with unique ids", () => {
    assert.ok(data.questions.length >= 40, `only ${data.questions.length} questions`);
    const ids = data.questions.map((q) => q.id);
    assert.equal(new Set(ids).size, ids.length, "question ids must be unique");
  });

  it("contains exactly one mid-sentence blank in every sentence", () => {
    for (const q of data.questions) {
      const count = q.sentence.split("___").length - 1;
      assert.equal(count, 1, `${q.id}: expected exactly one blank`);
      assert.ok(!q.sentence.startsWith("___"), `${q.id}: blank must not start the sentence`);
      assert.ok(!q.sentence.endsWith("___"), `${q.id}: blank must not end the sentence`);
      const i = q.sentence.indexOf("___");
      assert.equal(q.sentence[i - 1], " ", `${q.id}: blank needs a space before it`);
      assert.equal(q.sentence[i + 3], " ", `${q.id}: blank needs a space after it`);
    }
  });

  it("references only rules that exist in the rule catalog", () => {
    const ruleIds = new Set(data.ruleCatalog.map((r) => r.id));
    for (const q of data.questions) {
      assert.ok(ruleIds.has(q.rule), `${q.id}: unknown rule "${q.rule}"`);
    }
  });

  it("uses valid answer categories with exactly matching articles", () => {
    const allowed = { none: [""], definite: ["the"], indefinite: ["a", "an"] };
    for (const q of data.questions) {
      assert.ok(
        VALID_CATEGORIES.includes(q.answer.category),
        `${q.id}: invalid category "${q.answer.category}"`
      );
      assert.ok(
        allowed[q.answer.category].includes(q.answer.article),
        `${q.id}: article "${q.answer.article}" invalid for ${q.answer.category}`
      );
    }
    const articles = new Set(data.questions.map((q) => q.answer.article));
    assert.ok(articles.has("a"), "bank must contain 'a' answers");
    assert.ok(articles.has("an"), "bank must contain 'an' answers");
    assert.ok(articles.has("the"), "bank must contain 'the' answers");
    assert.ok(articles.has(""), "bank must contain no-article answers");
  });

  it("never stores 'a/an' as an article and never invents a fourth category", () => {
    for (const q of data.questions) {
      assert.notEqual(q.answer.article, "a/an", `${q.id}: sloppy 'a/an' article`);
    }
    const categories = new Set(data.questions.map((q) => q.answer.category));
    assert.equal(categories.size <= 3, true, "there can only be three answer categories");
  });

  it("gives every question a why-focused explanation and a completed sentence", () => {
    for (const q of data.questions) {
      assert.ok(q.explanation && q.explanation.trim().length >= 20, `${q.id}: weak explanation`);
      assert.ok(q.completedSentence && q.completedSentence.trim().length > 0, `${q.id}: missing completedSentence`);
    }
  });

  it("builds each completed sentence by filling the blank with the exact article", () => {
    const norm = (s) => s.replace(/\s+/g, " ").trim();
    for (const q of data.questions) {
      assert.equal(
        norm(q.completedSentence),
        norm(q.sentence.replace("___", q.answer.article)),
        `${q.id}: completedSentence does not match the filled blank`
      );
    }
  });

  it("contains no duplicate sentences", () => {
    const seen = new Set();
    for (const q of data.questions) {
      const key = q.sentence.replace(/\s+/g, " ").trim();
      assert.ok(!seen.has(key), `duplicate sentence: "${key}"`);
      seen.add(key);
    }
  });

  it("covers every catalog rule with at least two questions", () => {
    const counts = new Map();
    for (const q of data.questions) counts.set(q.rule, (counts.get(q.rule) ?? 0) + 1);
    for (const rule of data.ruleCatalog) {
      assert.ok(
        (counts.get(rule.id) ?? 0) >= 2,
        `rule "${rule.id}" has only ${counts.get(rule.id) ?? 0} questions`
      );
    }
  });

  it("uses valid CEFR levels consistent with the level progression", () => {
    const questionCefr = ["A1", "A2", "B1", "B2", "C1", "C2"];
    const rank = { A1: 1, "A1/A2": 1.5, A2: 2, "A2/B1": 2.5, B1: 3, "B1/B2": 3.5, B2: 4 };
    for (const q of data.questions) {
      assert.ok(questionCefr.includes(q.cefr), `${q.id}: invalid CEFR "${q.cefr}"`);
    }
    let previousRank = 0;
    for (const level of data.levels) {
      assert.ok(rank[level.cefr] !== undefined, `level ${level.id}: invalid CEFR "${level.cefr}"`);
      assert.ok(
        rank[level.cefr] >= previousRank,
        `level ${level.id}: CEFR must not go backwards`
      );
      previousRank = rank[level.cefr];
    }
  });
});

describe("level integrity", () => {
  it("references only known rules, or exactly the wildcard", () => {
    const ruleIds = new Set(data.ruleCatalog.map((r) => r.id));
    for (const level of data.levels) {
      assert.ok(Array.isArray(level.rules) && level.rules.length > 0, `level ${level.id}: no rules`);
      if (level.rules.includes("*")) {
        assert.deepEqual(level.rules, ["*"], `level ${level.id}: wildcard must stand alone`);
      } else {
        for (const ruleId of level.rules) {
          assert.ok(ruleIds.has(ruleId), `level ${level.id}: unknown rule "${ruleId}"`);
        }
      }
    }
  });

  it("has a full pool of eligible questions for every level", () => {
    for (const level of data.levels) {
      const eligible = engine.getEligibleQuestions(data, level);
      assert.ok(
        eligible.length >= level.questionCount,
        `level ${level.id} (${level.title}): ${eligible.length} eligible < ${level.questionCount} needed`
      );
    }
  });

  it("every catalog rule is trained by at least one explicit level", () => {
    const trained = new Set(data.levels.flatMap((l) => (l.rules.includes("*") ? [] : l.rules)));
    for (const rule of data.ruleCatalog) {
      assert.ok(trained.has(rule.id), `rule "${rule.id}" is not trained by any level`);
    }
  });

  it("keeps speed gradual and non-decreasing so sentences stay readable", () => {
    let previous = 0;
    for (const level of data.levels) {
      assert.ok(level.speed >= previous, `level ${level.id}: speed must never drop`);
      previous = level.speed;
    }
    assert.ok(data.levels[data.levels.length - 1].speed <= 0.1, "top speed must stay readable");
  });

  it("unlocks linearly through unlockAfter", () => {
    assert.equal(data.levels[0].unlockAfter, null);
    for (let i = 1; i < data.levels.length; i++) {
      assert.equal(data.levels[i].unlockAfter, data.levels[i - 1].id);
    }
  });
});

// ---------------------------------------------------------------------------
// Scoring math
// ---------------------------------------------------------------------------

describe("scoring math", () => {
  const scoring = data.scoring;

  it("awards the full speed bonus instantly and none after the window", () => {
    assert.equal(engine.calculateSpeedBonus(scoring, 0), scoring.fastBonusMax);
    assert.equal(engine.calculateSpeedBonus(scoring, 2250), 25);
    assert.equal(engine.calculateSpeedBonus(scoring, scoring.fastBonusWindowMs), 0);
    assert.equal(engine.calculateSpeedBonus(scoring, scoring.fastBonusWindowMs + 1), 0);
    assert.equal(engine.calculateSpeedBonus(scoring, -5), 0);
  });

  it("treats answers inside the perfect window as perfect", () => {
    assert.equal(engine.isPerfectAnswer(scoring, 0), true);
    assert.equal(engine.isPerfectAnswer(scoring, scoring.perfectWindowMs), true);
    assert.equal(engine.isPerfectAnswer(scoring, scoring.perfectWindowMs + 1), false);
  });

  it("grows the streak multiplier by streakStep and caps it", () => {
    assert.equal(engine.calculateStreakMultiplier(scoring, 1), 1);
    assert.equal(engine.calculateStreakMultiplier(scoring, 2), 1.1);
    assert.equal(engine.calculateStreakMultiplier(scoring, 11), 2.0);
    assert.equal(engine.calculateStreakMultiplier(scoring, 50), scoring.maxStreakMultiplier);
  });

  it("maps accuracy ratios to one, two and three stars with exact boundaries", () => {
    const stars = data.starRules;
    assert.equal(engine.calculateStars(stars, 1.0), 3);
    assert.equal(engine.calculateStars(stars, 0.75), 2);
    assert.equal(engine.calculateStars(stars, 0.7499), 1);
    assert.equal(engine.calculateStars(stars, 0.625), 1);
    assert.equal(engine.calculateStars(stars, 0.6249), 0);
    assert.equal(engine.calculateStars(stars, 0), 0);
  });

  it("derives required correct answers from accuracy and the pass floor", () => {
    const level1 = data.levels.find((l) => l.id === 1);
    const level10 = data.levels.find((l) => l.id === 10);
    assert.equal(engine.requiredCorrectFor(data, level1, 8), 5);
    assert.equal(engine.requiredCorrectFor(data, level10, 12), 9);
    assert.equal(engine.requiredCorrectFor(data, { requiredAccuracy: 0.625 }, 4), 5);
  });

  it("computes a hand-checkable total: 100 base + 37 speed + 25 perfect at 1200ms", () => {
    const breakdown = engine.calculateScore(scoring, 1200, 1);
    assert.equal(breakdown.speedBonus, 37);
    assert.equal(breakdown.perfectBonus, 25);
    assert.equal(breakdown.multiplier, 1);
    assert.equal(breakdown.total, 162);
  });
});

// ---------------------------------------------------------------------------
// Mastery, adaptive weighting, weak rules
// ---------------------------------------------------------------------------

describe("mastery and adaptive selection", () => {
  const settings = data.settings;

  it("requires both the attempt floor and the accuracy threshold", () => {
    assert.equal(engine.isRuleMastered(settings, { attempts: 4, correct: 4 }), false);
    assert.equal(engine.isRuleMastered(settings, { attempts: 5, correct: 5 }), true);
    assert.equal(engine.isRuleMastered(settings, { attempts: 10, correct: 8 }), false);
    assert.equal(engine.isRuleMastered(settings, engine.createRuleStats()), false);
  });

  it("weights unseen and weak rules up to the configured maximum", () => {
    assert.equal(engine.computeRuleWeight(settings, null), 2.2);
    assert.equal(engine.computeRuleWeight(settings, { attempts: 5, correct: 5 }), 1);
    assert.equal(engine.computeRuleWeight(settings, { attempts: 2, correct: 1 }), 2);
    assert.equal(engine.computeRuleWeight(settings, { attempts: 4, correct: 0 }), 3);
  });

  it("picks the only question left when the rest are excluded", () => {
    const pool = data.questions.filter((q) => q.rule === "zero-meals");
    const excluded = pool.slice(0, 2).map((q) => q.id);
    const picked = engine.pickWeightedQuestion(pool, settings, {}, engine.createRng(1), excluded);
    assert.equal(picked.id, pool[2].id);
    assert.equal(
      engine.pickWeightedQuestion(pool, settings, {}, engine.createRng(1), pool.map((q) => q.id)),
      null
    );
  });

  it("tracks only practiced, unmastered rules as weak, worst first", () => {
    const stats = {
      "indefinite-jobs": { attempts: 5, correct: 2 },
      "indefinite-first-mention": { attempts: 5, correct: 5 },
      "definite-specific": { attempts: 3, correct: 1 },
    };
    const weak = engine.getWeakRules(data, stats);
    assert.deepEqual(
      weak.map((w) => w.rule),
      ["definite-specific", "indefinite-jobs"]
    );
    assert.ok(weak[0].accuracy < weak[1].accuracy);
  });
});

// ---------------------------------------------------------------------------
// Learn mode runs
// ---------------------------------------------------------------------------

describe("learn mode", () => {
  it("plays a perfect run with the exact expected score, stars and pass state", () => {
    let t = 1000;
    const now = () => t;
    const game = engine.createGame({
      data,
      mode: "learn",
      levelId: 1,
      rng: engine.createRng(7),
      now,
    });

    const expectedDeltas = [162, 178, 194, 211, 227, 243, 259, 275];
    for (let i = 0; i < expectedDeltas.length; i++) {
      const view = game.getQuestion();
      assert.ok(view, `question ${i + 1} should be available`);
      t += 1200;
      const result = game.submitAnswer("indefinite");
      assert.equal(result.correct, true);
      assert.equal(result.scoreDelta, expectedDeltas[i], `score delta for answer ${i + 1}`);
    }

    assert.equal(game.finished, true);
    const summary = game.getResult();
    assert.equal(summary.answered, 8);
    assert.equal(summary.correctCount, 8);
    assert.equal(summary.accuracy, 1);
    assert.equal(summary.score, 1749);
    assert.equal(summary.stars, 3);
    assert.equal(summary.passed, true);
    assert.equal(summary.requiredCorrect, 5);
    assert.equal(summary.lives, null);
    assert.equal(game.getQuestion(), null);
  });

  it("resets the streak and applies the wrong-answer feedback delay after a mistake", () => {
    let t = 5000;
    const game = engine.createGame({
      data,
      mode: "learn",
      levelId: 1,
      rng: engine.createRng(3),
      now: () => t,
    });

    t += 1200;
    const id1 = game.getQuestion().id;
    const right = game.submitAnswer(expectedCategoryOf(id1));
    assert.equal(right.correct, true);
    assert.equal(right.feedbackDelayMs, data.settings.feedbackDelayMs);
    assert.equal(game.streak, 1);
    const scoreAfterFirst = game.score;

    t += 1200;
    const id2 = game.getQuestion().id;
    const wrong = game.submitAnswer(wrongCategoryOf(id2));
    assert.equal(wrong.correct, false);
    assert.equal(wrong.scoreDelta, 0);
    assert.equal(wrong.expectedCategory, expectedCategoryOf(id2));
    assert.equal(wrong.feedbackDelayMs, data.settings.wrongAnswerFeedbackDelayMs);
    assert.ok(wrong.explanation.length > 0);
    assert.ok(wrong.completedSentence.length > 0);
    assert.equal(game.streak, 0);
    assert.equal(game.score, scoreAfterFirst);

    t += 1200;
    const id3 = game.getQuestion().id;
    game.submitAnswer(expectedCategoryOf(id3));
    const restart = game.getResult();
    assert.equal(restart.bestStreak, 1);
    assert.equal(game.streak, 1, "streak restarts from one after a correct answer");
  });

  it("fails the run below the required accuracy and grants exactly one star at the threshold", () => {
    const play = (correctCount) => {
      let t = 0;
      const game = engine.createGame({
        data,
        mode: "learn",
        levelId: 1,
        rng: engine.createRng(11),
        now: () => t,
      });
      for (let i = 0; i < 8; i++) {
        const id = game.getQuestion().id;
        t += 3000;
        game.submitAnswer(i < correctCount ? expectedCategoryOf(id) : wrongCategoryOf(id));
      }
      return game.getResult();
    };

    const failed = play(4);
    assert.equal(failed.accuracy, 0.5);
    assert.equal(failed.stars, 0);
    assert.equal(failed.passed, false);

    const scraped = play(5);
    assert.equal(scraped.accuracy, 0.625);
    assert.equal(scraped.stars, 1);
    assert.equal(scraped.passed, true);
  });

  it("never repeats a question inside one run and hides answers from the lane view", () => {
    let t = 0;
    const game = engine.createGame({
      data,
      mode: "learn",
      levelId: 5,
      rng: engine.createRng(99),
      now: () => t,
    });
    const seen = [];
    for (let i = 0; i < 10; i++) {
      const view = game.getQuestion();
      assert.equal(view.total, 10);
      assert.equal(view.index, i + 1);
      assert.equal("answer" in view, false, "lane view must not leak the answer");
      assert.equal("explanation" in view, false, "lane view must not leak the explanation");
      seen.push(view.id);
      t += 2000;
      game.submitAnswer(expectedCategoryOf(view.id));
    }
    assert.equal(new Set(seen).size, 10, "learn run must not repeat questions");
    assert.equal(game.getResult().answered, 10);
  });

  it("uses the full level 9 pool exactly once across a complete run", () => {
    let t = 0;
    const game = engine.createGame({
      data,
      mode: "learn",
      levelId: 9,
      rng: engine.createRng(21),
      now: () => t,
    });
    const level = data.levels.find((l) => l.id === 9);
    const poolIds = engine.getEligibleQuestions(data, level).map((q) => q.id);
    const played = [];
    for (let i = 0; i < level.questionCount; i++) {
      const view = game.getQuestion();
      played.push(view.id);
      t += 1500;
      game.submitAnswer(expectedCategoryOf(view.id));
    }
    assert.deepEqual([...played].sort(), [...poolIds].sort());
  });
});

// ---------------------------------------------------------------------------
// Arcade mode
// ---------------------------------------------------------------------------

describe("arcade mode", () => {
  it("starts with configured lives and removes one per wrong answer until game over", () => {
    let t = 0;
    const game = engine.createGame({
      data,
      mode: "arcade",
      levelId: 9,
      rng: engine.createRng(5),
      now: () => t,
    });
    assert.equal(game.getStatus().lives, data.settings.startingLivesArcade);

    for (let i = 0; i < data.settings.startingLivesArcade; i++) {
      const id = game.getQuestion().id;
      t += 1000;
      const result = game.submitAnswer(wrongCategoryOf(id));
      assert.equal(result.correct, false);
    }

    assert.equal(game.getStatus().lives, 0);
    assert.equal(game.finished, true);
    const summary = game.getResult();
    assert.equal(summary.answered, data.settings.startingLivesArcade);
    assert.equal(summary.passed, false, "losing all lives fails the arcade run");
    assert.throws(() => game.submitAnswer("definite"), /No active question/);
  });

  it("passes a surviving perfect arcade run and keeps every life", () => {
    let t = 0;
    const game = engine.createGame({
      data,
      mode: "arcade",
      levelId: 9,
      rng: engine.createRng(13),
      now: () => t,
    });
    for (let i = 0; i < 10; i++) {
      const id = game.getQuestion().id;
      t += 900;
      game.submitAnswer(expectedCategoryOf(id));
    }
    const summary = game.getResult();
    assert.equal(summary.passed, true);
    assert.equal(summary.lives, data.settings.startingLivesArcade);
    assert.equal(summary.stars, 3);
    assert.equal(summary.accuracy, 1);
  });

  it("does not repeat any question while the recent window lasts", () => {
    let t = 0;
    const game = engine.createGame({
      data,
      mode: "arcade",
      levelId: 10,
      rng: engine.createRng(31),
      now: () => t,
    });
    const seen = [];
    for (let i = 0; i < game.getStatus().totalQuestions; i++) {
      const id = game.getQuestion().id;
      assert.ok(!seen.includes(id), `question ${id} repeated within the recent window`);
      seen.push(id);
      t += 1200;
      game.submitAnswer(expectedCategoryOf(id));
    }
  });
});

// ---------------------------------------------------------------------------
// Progress, unlocking and determinism
// ---------------------------------------------------------------------------

describe("progress and determinism", () => {
  it("unlocks level 1 only, then level 2 after passing level 1, and round-trips through JSON", () => {
    const progress = engine.createProgress();
    assert.deepEqual(
      engine.getUnlockedLevels(data, progress).map((l) => l.id),
      [1]
    );
    assert.equal(engine.isLevelUnlocked(data, progress, 2), false);

    let t = 0;
    const game = engine.createGame({
      data,
      mode: "learn",
      levelId: 1,
      rng: engine.createRng(7),
      now: () => t,
      progress,
    });
    for (let i = 0; i < 8; i++) {
      t += 1200;
      game.submitAnswer("indefinite");
    }
    game.saveProgress();

    const record = progress.levels[1];
    assert.equal(record.stars, 3);
    assert.equal(record.bestScore, 1749);
    assert.equal(record.passed, true);
    assert.equal(record.attempts, 1);
    assert.equal(engine.isLevelUnlocked(data, progress, 2), true);
    assert.equal(engine.isLevelUnlocked(data, progress, 3), false);
    assert.equal(progress.totals.runs, 1);
    assert.equal(progress.totals.questionsAnswered, 8);
    assert.equal(progress.totals.correctAnswers, 8);

    const reloaded = engine.loadProgress(engine.exportProgress(progress));
    assert.deepEqual(reloaded, progress);
    assert.deepEqual(engine.loadProgress("not json at all"), engine.createProgress());
  });

  it("accumulates rule statistics across saved runs and reaches mastery", () => {
    const progress = engine.createProgress();
    const seed = engine.createRuleStats();
    seed.attempts = 5;
    seed.correct = 5;
    progress.ruleStats["indefinite-first-mention"] = seed;
    assert.equal(engine.isRuleMastered(data.settings, seed), true);

    let t = 0;
    const game = engine.createGame({
      data,
      mode: "learn",
      levelId: 1,
      rng: engine.createRng(7),
      now: () => t,
      progress,
    });
    for (let i = 0; i < 8; i++) {
      t += 1200;
      game.submitAnswer("indefinite");
    }
    game.saveProgress();

    const merged = progress.ruleStats;
    const attempts = Object.values(merged).reduce((sum, s) => sum + s.attempts, 0);
    assert.equal(attempts, 13, "run stats merge on top of existing progress (5 + 8)");
    assert.equal(
      merged["indefinite-first-mention"].attempts,
      5 + merged["indefinite-jobs"].attempts,
      "first-mention carries its five prior attempts plus its share of the run"
    );
    assert.equal(merged["indefinite-jobs"].attempts, 4, "the run split 4/4 across the two rules");
  });

  it("reproduces the same question sequence for the same seed and clock", () => {
    const play = () => {
      let t = 0;
      const game = engine.createGame({
        data,
        mode: "learn",
        levelId: 10,
        rng: engine.createRng(42),
        now: () => t,
      });
      const ids = [];
      for (let i = 0; i < 12; i++) {
        const view = game.getQuestion();
        ids.push(view.id);
        t += 1200;
        game.submitAnswer(expectedCategoryOf(view.id));
      }
      return ids;
    };
    assert.deepEqual(play(), play());
  });
});

// ---------------------------------------------------------------------------
// Validation catches corrupted data
// ---------------------------------------------------------------------------

describe("validation rejects broken data", () => {
  it("flags duplicate question ids", () => {
    const result = brokenData((d) => d.questions.push(structuredClone(d.questions[0])));
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /Duplicate question id/);
  });

  it("flags the sloppy 'a/an' article", () => {
    const result = brokenData((d) => {
      const q = d.questions.find((entry) => entry.answer.category === "indefinite");
      q.answer.article = "a/an";
    });
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /article .* does not match category/);
  });

  it("flags invented answer categories", () => {
    const result = brokenData((d) => {
      d.questions[0].answer.category = "sometimes";
    });
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /invalid answer category/);
  });

  it("flags sentences with two blanks", () => {
    const result = brokenData((d) => {
      d.questions[0].sentence = d.questions[0].sentence.replace("___", "___ ___");
    });
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /exactly one/);
  });

  it("flags sentence-initial blanks", () => {
    const result = brokenData((d) => {
      d.questions[0].sentence = "___ sun is bright today.";
      d.questions[0].completedSentence = "The sun is bright today.";
    });
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /must not be at the start/);
  });

  it("flags unknown rule references in questions and levels", () => {
    const questionResult = brokenData((d) => {
      d.questions[0].rule = "definite-made-up";
    });
    assert.match(questionResult.errors.join("\n"), /references unknown rule/);

    const levelResult = brokenData((d) => {
      d.levels[0].rules = ["definite-made-up"];
    });
    assert.match(levelResult.errors.join("\n"), /references unknown rule/);
  });

  it("flags completed sentences that do not match the blank fill", () => {
    const result = brokenData((d) => {
      d.questions[0].completedSentence = "Something else entirely.";
    });
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /completedSentence/);
  });

  it("flags duplicate sentences", () => {
    const result = brokenData((d) => {
      d.questions[1].sentence = d.questions[0].sentence;
      d.questions[1].completedSentence = d.questions[0].completedSentence;
    });
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /duplicates an earlier sentence/);
  });

  it("flags levels whose question pool is too small", () => {
    const result = brokenData((d) => {
      d.levels.find((l) => l.id === 9).questionCount = 50;
    });
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /eligible questions/);
  });

  it("flags unordered star thresholds", () => {
    const result = brokenData((d) => {
      d.starRules.threeStarsAccuracy = 0.5;
    });
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /ordered/);
  });

  it("flags missing top-level sections", () => {
    const result = brokenData((d) => delete d.questions);
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /Missing top-level section/);
    assert.deepEqual(engine.validateGameData({}).errors.length, 7);
  });

  it("refuses to start a game on corrupted data or an unknown level", () => {
    const corrupted = structuredClone(data);
    corrupted.questions[0].answer.article = "a/an";
    assert.throws(() => engine.createGame({ data: corrupted, levelId: 1 }), /invalid data/i);
    assert.throws(() => engine.createGame({ data, levelId: 99 }), /Unknown level id/);
    assert.throws(() => engine.createGame({ data, levelId: 1, mode: "chaos" }), /Unknown mode/);
  });

  it("rejects submissions with an unknown lane category", () => {
    const game = engine.createGame({
      data,
      levelId: 1,
      rng: engine.createRng(1),
      now: () => 0,
    });
    assert.throws(() => game.submitAnswer("maybe"), /Unknown answer category/);
  });
});
