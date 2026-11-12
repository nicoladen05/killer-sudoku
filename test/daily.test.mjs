import { test } from "node:test";
import assert from "node:assert/strict";
import { dailyDate, dailySeed, addDays, addSolved, streak, isDate, DAILY_LEVEL } from "../public/js/daily.js";
import { generate } from "../public/js/engine.js";
import { openDailyDates } from "../functions/api/scores.js";

test("the day changes at midnight German time", () => {
  // Winter (CET, UTC+1): midnight in Berlin is 23:00 UTC.
  assert.equal(dailyDate(new Date("2026-11-12T22:59:59Z")), "2026-11-12");
  assert.equal(dailyDate(new Date("2026-11-12T23:00:00Z")), "2026-11-13");
  // Summer (CEST, UTC+2): midnight in Berlin is 22:00 UTC.
  assert.equal(dailyDate(new Date("2026-07-01T21:59:59Z")), "2026-07-01");
  assert.equal(dailyDate(new Date("2026-07-01T22:00:00Z")), "2026-07-02");
});

test("dates move across months, years and leap days", () => {
  assert.equal(addDays("2026-11-30", 1), "2026-12-01");
  assert.equal(addDays("2027-01-01", -1), "2026-12-31");
  assert.equal(addDays("2028-02-28", 1), "2028-02-29");
  assert.ok(isDate("2026-11-12"));
  assert.ok(!isDate("2026-13-01") && !isDate("12.11.2026") && !isDate(null));
});

test("every browser builds the same daily puzzle, and each day a different one", () => {
  assert.equal(dailySeed("2026-11-12"), dailySeed("2026-11-12"));
  assert.notEqual(dailySeed("2026-11-12"), dailySeed("2026-11-13"));
  const a = generate(DAILY_LEVEL, dailySeed("2026-11-12"));
  const b = generate(DAILY_LEVEL, dailySeed("2026-11-12"));
  assert.deepEqual([a.givens, a.cages], [b.givens, b.cages]);
  assert.equal(a.difficulty, "hard");
});

test("streak counts consecutive days and survives until the day is over", () => {
  const days = ["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-09", "2026-11-10", "2026-11-11"];
  assert.deepEqual(streak(days, "2026-11-11"), { current: 3, best: 3, solvedToday: true });
  // Today not solved yet: the streak from yesterday still counts.
  assert.deepEqual(streak(days, "2026-11-12"), { current: 3, best: 3, solvedToday: false });
  // A missed day ends it.
  assert.deepEqual(streak(days, "2026-11-13"), { current: 0, best: 3, solvedToday: false });
  assert.deepEqual(streak([], "2026-11-12"), { current: 0, best: 0, solvedToday: false });
  assert.deepEqual(streak(null, "2026-11-12"), { current: 0, best: 0, solvedToday: false });
});

test("solved days are stored once, sorted and capped", () => {
  assert.deepEqual(addSolved(["2026-11-02", "bad"], "2026-11-01"), ["2026-11-01", "2026-11-02"]);
  assert.deepEqual(addSolved(["2026-11-01"], "2026-11-01"), ["2026-11-01"]);
  let list = [];
  for (let i = 0; i < 450; i++) list = addSolved(list, addDays("2025-01-01", i));
  assert.equal(list.length, 400);
  assert.equal(list.at(-1), addDays("2025-01-01", 449));
});

test("the API takes daily entries for today and yesterday only", () => {
  assert.deepEqual(openDailyDates(new Date("2026-11-12T23:30:00Z")), ["2026-11-13", "2026-11-12"]);
});
