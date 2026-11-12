import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanName, hintPenalty, penalty } from "../functions/api/scores.js";

test("names are trimmed, cleaned and capped at 20 characters", () => {
  assert.equal(cleanName("  Nico\u0007  "), "Nico");
  assert.equal(cleanName("a   b\n\tc"), "a b c");
  assert.equal(cleanName("x".repeat(30)), "x".repeat(20));
  assert.equal(cleanName(42), "");
  assert.equal(cleanName("​\u0000"), "");
});

test("each hint costs one minute more than the last", () => {
  assert.deepEqual([0, 1, 2, 3, 5, 10].map(hintPenalty), [0, 60, 180, 360, 900, 3300]);
});

test("each mistake adds a flat 30 seconds on top of the hint penalty", () => {
  assert.equal(penalty(0, 0), 0);
  assert.equal(penalty(1, 0), 30);
  assert.equal(penalty(2, 0), 60);
  assert.equal(penalty(2, 2), 240);
});
