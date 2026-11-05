import { test } from "node:test";
import assert from "node:assert/strict";
import { generate, solve, rowOf, colOf, boxOf } from "../public/js/engine.js";

const isValidSolution = (g) => {
  for (let i = 0; i < 81; i++) for (let j = i + 1; j < 81; j++) {
    if (g[i] === g[j] && (rowOf(i) === rowOf(j) || colOf(i) === colOf(j) || boxOf(i) === boxOf(j))) return false;
  }
  return g.every((v) => v >= 1 && v <= 9);
};

for (const level of ["easy", "medium", "hard", "expert"]) {
  test(`${level}: puzzle has exactly one solution`, () => {
    for (const seed of [1, 2, 3]) {
      const p = generate(level, seed);
      assert.ok(isValidSolution(p.solution));
      const covered = p.cages.flatMap((c) => c.cells).sort((a, b) => a - b);
      assert.deepEqual(covered, [...Array(81).keys()], "cages cover every cell once");
      for (const c of p.cages) {
        const digits = c.cells.map((i) => p.solution[i]);
        assert.equal(new Set(digits).size, digits.length, "no repeated digit in a cage");
        assert.equal(digits.reduce((a, b) => a + b, 0), c.sum);
      }
      const res = solve(p.cages, p.givens, 2, 1e7);
      assert.equal(res.count, 1);
      assert.deepEqual(res.solutions[0], p.solution);
    }
  });
}

test("same seed gives the same puzzle", () => {
  assert.deepEqual(generate("medium", 42), generate("medium", 42));
});
