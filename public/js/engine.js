// Killer Sudoku engine: solver + generator. No DOM access, so it runs in a
// Web Worker, the main thread, or Node (for tests).

import { logicSolve } from "./logic.js";

const FULL = 0x3fe; // bits 1..9

export const rowOf = (i) => (i / 9) | 0;
export const colOf = (i) => i % 9;
export const boxOf = (i) => ((rowOf(i) / 3) | 0) * 3 + ((colOf(i) / 3) | 0);

const UNITS = (() => {
  const u = Array.from({ length: 27 }, () => []);
  for (let i = 0; i < 81; i++) { u[rowOf(i)].push(i); u[9 + colOf(i)].push(i); u[18 + boxOf(i)].push(i); }
  return u;
})();

const popcount = (m) => {
  let c = 0;
  while (m) { m &= m - 1; c++; }
  return c;
};

// COMBOS[k][s] = every digit set (bitmask) of k distinct digits summing to s.
const COMBOS = (() => {
  const t = Array.from({ length: 10 }, () => Array.from({ length: 46 }, () => []));
  for (let m = 0; m < 512; m++) {
    const mask = m << 1;
    let k = 0, s = 0;
    for (let d = 1; d <= 9; d++) if (mask & (1 << d)) { k++; s += d; }
    t[k][s].push(mask);
  }
  return t;
})();

/** Digits still possible in a cage given the remaining sum/count and the digits used. */
let lastRequired = 0;
function cageAllowed(remCount, remSum, used) {
  lastRequired = 0;
  if (remCount <= 0 || remSum < 0 || remSum > 45) return 0;
  let out = 0, req = FULL;
  for (const m of COMBOS[remCount][remSum]) if ((m & used) === 0) { out |= m; req &= m; }
  lastRequired = out ? req : 0;
  return out;
}

/**
 * Count solutions of a killer puzzle (up to `limit`).
 * @param {{cells:number[], sum:number}[]} cages
 * @param {number[]} givens 81 entries, 0 = empty
 * @returns {{count:number, solutions:number[][], aborted:boolean}}
 */
export function solve(cages, givens, limit = 2, nodeLimit = 300000) {
  const grid = givens.slice();
  const rows = new Array(9).fill(0), cols = new Array(9).fill(0), boxes = new Array(9).fill(0);
  const cageOf = new Array(81);
  const remSum = cages.map((c) => c.sum);
  const remCount = cages.map((c) => c.cells.length);
  const used = cages.map(() => 0);
  cages.forEach((c, ci) => c.cells.forEach((i) => (cageOf[i] = ci)));

  for (let i = 0; i < 81; i++) {
    const d = grid[i];
    if (!d) continue;
    const b = 1 << d, ci = cageOf[i];
    if ((rows[rowOf(i)] | cols[colOf(i)] | boxes[boxOf(i)] | used[ci]) & b) {
      return { count: 0, solutions: [], aborted: false };
    }
    rows[rowOf(i)] |= b; cols[colOf(i)] |= b; boxes[boxOf(i)] |= b;
    used[ci] |= b; remSum[ci] -= d; remCount[ci]--;
  }

  const solutions = [];
  let nodes = 0, aborted = false;
  const allowed = new Array(cages.length);
  const cand = new Array(81).fill(0);
  const required = new Array(cages.length).fill(0);

  function search() {
    if (++nodes > nodeLimit) { aborted = true; return; }
    for (let c = 0; c < cages.length; c++) {
      allowed[c] = remCount[c] ? cageAllowed(remCount[c], remSum[c], used[c]) : 0;
      required[c] = remCount[c] ? lastRequired : 0;
      if (remCount[c] && !allowed[c]) return;
      if (!remCount[c] && remSum[c] !== 0) return;
    }
    let best = -1, bestMask = 0, bestN = 10;
    for (let i = 0; i < 81; i++) {
      if (grid[i]) { cand[i] = 0; continue; }
      const m = FULL & ~(rows[rowOf(i)] | cols[colOf(i)] | boxes[boxOf(i)]) & allowed[cageOf[i]];
      cand[i] = m;
      const n = popcount(m);
      if (n === 0) return;
      if (n < bestN) { best = i; bestMask = m; bestN = n; }
    }
    if (best === -1) { solutions.push(grid.slice()); return; }
    // Hidden singles: a digit with only one possible cell in a unit.
    if (bestN > 1) {
      outer: for (const unit of UNITS) {
        let once = 0, twice = 0, placed = 0;
        for (const i of unit) {
          if (grid[i]) { placed |= 1 << grid[i]; continue; }
          twice |= once & cand[i];
          once |= cand[i];
        }
        if ((once | placed) !== FULL) return;
        const single = once & ~twice;
        if (single) {
          const b = single & -single;
          for (const i of unit) if (cand[i] & b) { best = i; bestMask = b; bestN = 1; break outer; }
        }
      }
      // Digits every remaining combo of a cage needs must fit somewhere in it.
      if (bestN > 1) outer2: for (let c = 0; c < cages.length; c++) {
        const req = required[c];
        if (!req) continue;
        let once = 0, twice = 0;
        for (const i of cages[c].cells) { if (grid[i]) continue; twice |= once & cand[i]; once |= cand[i]; }
        if ((once & req) !== req) return;
        const single = req & once & ~twice;
        if (single) {
          const b = single & -single;
          for (const i of cages[c].cells) if (!grid[i] && cand[i] & b) { best = i; bestMask = b; bestN = 1; break outer2; }
        }
      }
    }
    const r = rowOf(best), c = colOf(best), bx = boxOf(best), ci = cageOf[best];
    for (let d = 1; d <= 9; d++) {
      const b = 1 << d;
      if (!(bestMask & b)) continue;
      grid[best] = d;
      rows[r] |= b; cols[c] |= b; boxes[bx] |= b;
      used[ci] |= b; remSum[ci] -= d; remCount[ci]--;
      search();
      rows[r] &= ~b; cols[c] &= ~b; boxes[bx] &= ~b;
      used[ci] &= ~b; remSum[ci] += d; remCount[ci]++;
      grid[best] = 0;
      if (solutions.length >= limit || aborted) return;
    }
  }
  search();
  return { count: solutions.length, solutions, aborted };
}

// ---------- Generator ----------

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function randomSolution(rng) {
  const g = new Array(81).fill(0);
  const ok = (i, d) => {
    const r = rowOf(i), c = colOf(i), b = boxOf(i);
    for (let j = 0; j < 81; j++) {
      if (g[j] === d && (rowOf(j) === r || colOf(j) === c || boxOf(j) === b)) return false;
    }
    return true;
  };
  const fill = (i) => {
    if (i === 81) return true;
    for (const d of shuffle([1, 2, 3, 4, 5, 6, 7, 8, 9], rng)) {
      if (ok(i, d)) { g[i] = d; if (fill(i + 1)) return true; g[i] = 0; }
    }
    return false;
  };
  fill(0);
  return g;
}

const neighbors = (i) => {
  const r = rowOf(i), c = colOf(i), out = [];
  if (r > 0) out.push(i - 9);
  if (r < 8) out.push(i + 9);
  if (c > 0) out.push(i - 1);
  if (c < 8) out.push(i + 1);
  return out;
};

/** Split the solved grid into connected cages without repeated digits. */
function makeCages(solution, sizes, rng) {
  const cageOf = new Array(81).fill(-1);
  const cages = [];
  for (const start of shuffle([...Array(81).keys()], rng)) {
    if (cageOf[start] !== -1) continue;
    const target = sizes[Math.floor(rng() * sizes.length)];
    const id = cages.length;
    const cells = [start];
    let digits = 1 << solution[start];
    cageOf[start] = id;
    while (cells.length < target) {
      const options = [];
      for (const c of cells) for (const n of neighbors(c)) {
        if (cageOf[n] === -1 && !(digits & (1 << solution[n]))) options.push(n);
      }
      if (!options.length) break;
      const n = options[Math.floor(rng() * options.length)];
      cells.push(n); cageOf[n] = id; digits |= 1 << solution[n];
    }
    cages.push(cells);
  }

  // Fold single-cell cages into a neighbouring cage when no digit repeats.
  let changed = true;
  while (changed) {
    changed = false;
    for (let id = 0; id < cages.length; id++) {
      const cells = cages[id];
      if (cells.length !== 1) continue;
      const i = cells[0];
      const opts = shuffle(neighbors(i).map((n) => cageOf[n]), rng).filter((o) => {
        const other = cages[o];
        return other.length && other.length < 9 && !other.some((j) => solution[j] === solution[i]);
      });
      if (!opts.length) continue;
      const to = opts[0];
      cages[to].push(i); cageOf[i] = to; cages[id] = [];
      changed = true;
    }
  }

  return cages
    .filter((c) => c.length)
    .map((cells) => ({
      cells: cells.sort((a, b) => a - b),
      sum: cells.reduce((s, i) => s + solution[i], 0),
    }));
}

const isConnected = (cells) => {
  if (!cells.length) return false;
  const set = new Set(cells), seen = new Set([cells[0]]), stack = [cells[0]];
  while (stack.length) for (const n of neighbors(stack.pop())) {
    if (set.has(n) && !seen.has(n)) { seen.add(n); stack.push(n); }
  }
  return seen.size === cells.length;
};

/** Split the cage holding cell i into two connected cages; false if impossible. */
function splitCage(cages, i, solution, rng) {
  const ci = cages.findIndex((c) => c.cells.includes(i));
  const cells = cages[ci].cells;
  if (cells.length < 2) return false;
  for (let tries = 0; tries < 12; tries++) {
    // Avoid creating single-cell cages when the cage is big enough.
    const lo = cells.length >= 4 ? 2 : 1;
    const want = lo + Math.floor(rng() * (cells.length - 2 * lo + 1));
    const part = [i];
    while (part.length < want) {
      const opts = [];
      for (const c of part) for (const n of neighbors(c)) if (cells.includes(n) && !part.includes(n)) opts.push(n);
      if (!opts.length) break;
      part.push(opts[Math.floor(rng() * opts.length)]);
    }
    const rest = cells.filter((c) => !part.includes(c));
    if (!rest.length || !isConnected(rest)) continue;
    const mk = (cs) => ({ cells: cs.sort((a, b) => a - b), sum: cs.reduce((s, j) => s + solution[j], 0) });
    cages.splice(ci, 1, mk(part), mk(rest));
    return true;
  }
  return false;
}

/**
 * Make the puzzle solvable by logic alone (up to `maxTier`). Whenever the
 * logic solver gets stuck, reveal a digit at a stuck cell while under the
 * givens budget, and split the cage there once past it.
 */
function makeLogical(cages, givens, solution, rng, cfg) {
  let added = givens.filter(Boolean).length;
  for (let guard = 0; guard < 200; guard++) {
    const res = logicSolve(cages, givens, cfg.maxTier);
    if (!res.valid) return null;
    if (res.solved) return res;
    const open = [];
    for (let i = 0; i < 81; i++) if (!res.grid[i]) open.push(i);
    // Prefer cells with the most candidates left: that is where logic stalled hardest.
    const most = Math.max(...open.map((i) => popcount(res.cand[i])));
    const wide = open.filter((i) => popcount(res.cand[i]) === most);
    const i = wide[Math.floor(rng() * wide.length)];
    if (added < cfg.maxGivens || !splitCage(cages, i, solution, rng)) {
      givens[i] = solution[i];
      added++;
    }
  }
  return null;
}

const meets = (res, cfg) => res.tier >= cfg.targetTier && res.hard >= cfg.minHard;
const rank = (res) => res.tier * 1000 + res.hard;

/**
 * Make a logic-solvable puzzle harder while keeping it solvable within
 * `maxTier`: merge neighbouring cages and take back revealed digits.
 */
function harden(cages, givens, solution, rng, cfg, res) {
  const cageIdx = () => {
    const of = new Array(81);
    cages.forEach((c, ci) => c.cells.forEach((i) => (of[i] = ci)));
    return of;
  };
  let fails = 0;
  while (fails < cfg.hardenTries) {
    const shown = [];
    for (let i = 0; i < 81; i++) if (givens[i]) shown.push(i);
    if (shown.length && rng() < 0.5) {
      const i = shown[Math.floor(rng() * shown.length)];
      givens[i] = 0;
      const r = logicSolve(cages, givens, cfg.maxTier);
      if (r.solved) { res = r; fails = 0; continue; }
      givens[i] = solution[i];
      fails++;
      continue;
    }
    const of = cageIdx();
    const i = Math.floor(rng() * 81);
    const ns = neighbors(i).filter((n) => of[n] !== of[i]);
    if (!ns.length) { fails++; continue; }
    const a = of[i], b = of[ns[Math.floor(rng() * ns.length)]];
    const cells = [...cages[a].cells, ...cages[b].cells];
    const digits = new Set(cells.map((j) => solution[j]));
    if (cells.length > cfg.maxCage || digits.size !== cells.length) { fails++; continue; }
    const merged = { cells: cells.sort((x, y) => x - y), sum: cages[a].sum + cages[b].sum };
    const next = cages.filter((_, ci) => ci !== a && ci !== b);
    next.push(merged);
    const r = logicSolve(next, givens, cfg.maxTier);
    if (r.solved) { cages.splice(0, cages.length, ...next); res = r; fails = 0; } else fails++;
    if (meets(res, cfg) && fails > cfg.hardenTries / 2) break;
  }
  return res;
}

/**
 * Levels are graded by the hardest technique a puzzle needs (see logic.js):
 * the puzzle must be solvable using techniques up to `maxTier`, and should
 * need one of tier `targetTier`. Expert also needs several such hard steps
 * (`minHard`), since killer cages rarely leave work for tier-4 techniques.
 */
export const DIFFICULTIES = {
  easy:   { sizes: [2, 2, 2, 3, 3],    maxCage: 3, maxGivens: 40, extraGivens: 6, maxTier: 1, targetTier: 1, minHard: 0, hardenTries: 0 },
  medium: { sizes: [2, 2, 3, 3, 4],    maxCage: 4, maxGivens: 6,  extraGivens: 0, maxTier: 2, targetTier: 2, minHard: 0, hardenTries: 30 },
  hard:   { sizes: [2, 3, 3, 4, 4, 5], maxCage: 5, maxGivens: 0,  extraGivens: 0, maxTier: 3, targetTier: 3, minHard: 1, hardenTries: 60 },
  expert: { sizes: [3, 4, 4, 5, 6],    maxCage: 6, maxGivens: 0,  extraGivens: 0, maxTier: 4, targetTier: 3, minHard: 2, hardenTries: 80 },
};

/**
 * Generate a puzzle with a unique solution that can be solved by logic alone.
 * @returns {{cages, givens:number[], solution:number[], difficulty:string, tier:number, techniques:Object, seed:number}}
 */
export function generate(difficulty = "medium", seed = (Math.random() * 2 ** 32) >>> 0) {
  const cfg = DIFFICULTIES[difficulty] || DIFFICULTIES.medium;
  const rng = mulberry32(seed);
  let best = null;
  for (let attempt = 0; attempt < 8 || !best; attempt++) {
    const solution = randomSolution(rng);
    const cages = makeCages(solution, cfg.sizes, rng);
    const givens = new Array(81).fill(0);
    let res = makeLogical(cages, givens, solution, rng, cfg);
    if (!res) continue;
    if (cfg.hardenTries) res = harden(cages, givens, solution, rng, cfg, res);
    // Logic proves uniqueness already; the brute-force solver double-checks it.
    const check = solve(cages, givens, 2, 30000);
    if (check.count > 1 || (!check.aborted && check.count !== 1)) continue;
    const cand = { cages, givens, solution, tier: res.tier, techniques: res.used, res };
    if (!best || rank(res) > rank(best.res)) best = cand;
    if (meets(best.res, cfg)) break;
  }
  // Easy reveals a few extra digits on top of what logic needs.
  const free = shuffle([...Array(81).keys()].filter((i) => !best.givens[i]), rng);
  for (let k = 0; k < cfg.extraGivens && k < free.length; k++) best.givens[free[k]] = best.solution[free[k]];
  const { res, ...puzzle } = best;
  return { ...puzzle, difficulty, seed };
}
