import { test } from "node:test";
import assert from "node:assert/strict";
import { generate, solve, rowOf, colOf, boxOf, DIFFICULTIES } from "../public/js/engine.js";
import { logicSolve } from "../public/js/logic.js";

const isValidSolution = (g) => {
  for (let i = 0; i < 81; i++) for (let j = i + 1; j < 81; j++) {
    if (g[i] === g[j] && (rowOf(i) === rowOf(j) || colOf(i) === colOf(j) || boxOf(i) === boxOf(j))) return false;
  }
  return g.every((v) => v >= 1 && v <= 9);
};

for (const level of ["easy", "medium", "hard", "expert", "master"]) {
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

  test(`${level}: puzzle is solvable by logic alone, graded by technique`, () => {
    const cfg = DIFFICULTIES[level];
    for (const seed of [1, 2, 3]) {
      const p = generate(level, seed);
      const res = logicSolve(p.cages, p.givens, cfg.maxTier);
      assert.ok(res.solved, "logic solver finishes without guessing");
      assert.deepEqual(res.grid, p.solution);
      assert.ok(p.tier <= cfg.maxTier);
      if (cfg.master) assert.ok(p.tier >= cfg.targetTier, `master needs tier ${cfg.targetTier}, got ${p.tier}`);
      else assert.equal(p.givens.filter(Boolean).length, cfg.givens, "level sets the digits shown");
    }
  });
}

test("logic solver never guesses: it stalls on a puzzle that needs a guess", () => {
  // Horizontal two-cell cages and no givens usually leave several solutions.
  const p = generate("easy", 5);
  const pairs = [];
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 8; c += 2) {
      const cells = [r * 9 + c, r * 9 + c + 1];
      pairs.push({ cells, sum: cells.reduce((s, i) => s + p.solution[i], 0) });
    }
    pairs.push({ cells: [r * 9 + 8], sum: p.solution[r * 9 + 8] });
  }
  const res = logicSolve(pairs, new Array(81).fill(0), 4);
  assert.ok(res.valid);
  const brute = solve(pairs, new Array(81).fill(0), 2, 1e6);
  assert.equal(brute.count, 2, "test puzzle should be ambiguous");
  assert.ok(!res.solved);
});

test("easy to expert share one sudoku.com-style cage layout", () => {
  for (const level of ["easy", "medium", "hard", "expert"]) for (const seed of [1, 2, 3]) {
    const p = generate(level, seed);
    assert.ok(p.cages.length >= 31 && p.cages.length <= 35, `${level}: ${p.cages.length} cages`);
    assert.ok(p.cages.every((c) => c.cells.length <= 5), "cages have at most 5 cells");
    assert.ok(p.cages.filter((c) => c.cells.length === 1).length <= 3, "at most 3 single-cell cages");
  }
});

test("expert base needs the rule of 45 but nothing harder", () => {
  for (const seed of [1, 2, 3]) {
    const p = generate("expert", seed);
    const res = logicSolve(p.cages, p.givens, 2);
    assert.ok(res.solved);
    assert.equal(res.tier, 2);
    assert.ok(res.used["rule of 45"] >= 1 && res.used["rule of 45"] <= 3);
  }
});

test("same seed gives the same puzzle", () => {
  assert.deepEqual(generate("medium", 42), generate("medium", 42));
});
