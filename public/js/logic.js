// Human-style Killer Sudoku solver. It only uses deductions a person can make
// with pencil marks, never guessing, and reports the hardest technique it
// needed. The generator uses it to keep only puzzles that can be solved by
// logic and to grade them.
//
// Techniques by tier (a puzzle's tier is the hardest one it needed):
//   1  singles (naked, hidden) and cage combinations
//   2  rule of 45 on one row/column/box, locked candidates (pointing and
//      claiming, also for digits a cage must contain), naked/hidden pairs
//   3  rule of 45 on two or three rows/columns/boxes, naked/hidden triples, X-wing
//   4  naked/hidden quads, swordfish, XY-wing

const FULL = 0x3fe; // bits 1..9

const rowOf = (i) => (i / 9) | 0;
const colOf = (i) => i % 9;
const boxOf = (i) => ((rowOf(i) / 3) | 0) * 3 + ((colOf(i) / 3) | 0);

const UNITS = (() => {
  const u = Array.from({ length: 27 }, () => []);
  for (let i = 0; i < 81; i++) { u[rowOf(i)].push(i); u[9 + colOf(i)].push(i); u[18 + boxOf(i)].push(i); }
  return u;
})();
const UNITS_OF = Array.from({ length: 81 }, (_, i) => [rowOf(i), 9 + colOf(i), 18 + boxOf(i)]);
const IS_PEER = (() => {
  const m = new Uint8Array(81 * 81);
  for (let i = 0; i < 81; i++) for (let j = 0; j < 81; j++) {
    if (i !== j && (rowOf(i) === rowOf(j) || colOf(i) === colOf(j) || boxOf(i) === boxOf(j))) m[i * 81 + j] = 1;
  }
  return m;
})();
const PEERS = Array.from({ length: 81 }, (_, i) => [...Array(81).keys()].filter((j) => IS_PEER[i * 81 + j]));

const POP = new Uint8Array(1024);
for (let m = 1; m < 1024; m++) POP[m] = POP[m & (m - 1)] + 1;
const LOW = (m) => 31 - Math.clz32(m & -m); // lowest set digit
const HIGH = (m) => 31 - Math.clz32(m);

function combinations(arr, k) {
  const out = [], pick = [];
  const rec = (start) => {
    if (pick.length === k) { out.push(pick.slice()); return; }
    for (let i = start; i <= arr.length - (k - pick.length); i++) { pick.push(arr[i]); rec(i + 1); pick.pop(); }
  };
  rec(0);
  return out;
}

// ---------- Sum constraints (cages and rule-of-45 regions) ----------

/**
 * Build every sum constraint the solver reasons with: the cages themselves
 * (tier 1), and the "innies" and "outies" of the rule of 45 for single houses
 * (tier 2) and for two or three neighbouring houses (tier 3).
 */
function buildConstraints(cages) {
  const cageOf = new Array(81);
  cages.forEach((c, ci) => c.cells.forEach((i) => (cageOf[i] = ci)));
  const out = cages.map((c) => ({ cells: c.cells.slice(), sum: c.sum, distinct: true, tier: 1 }));
  const seen = new Set(out.map((c) => c.cells.join(",")));
  const add = (cells, sum, tier) => {
    if (!cells.length || cells.length > 6) return;
    cells.sort((a, b) => a - b);
    const key = cells.join(",");
    if (seen.has(key)) return;
    seen.add(key);
    // Cells of a region only have to differ when they share a house.
    let distinct = true;
    for (let a = 0; a < cells.length && distinct; a++)
      for (let b = a + 1; b < cells.length; b++) if (!IS_PEER[cells[a] * 81 + cells[b]]) { distinct = false; break; }
    out.push({ cells, sum, distinct, tier });
  };

  const regions = [];
  for (let u = 0; u < 27; u++) regions.push({ cells: UNITS[u], houses: 1, tier: 2 });
  const span = (kind, from, n) => {
    const cells = [];
    for (let k = from; k < from + n; k++) cells.push(...UNITS[kind * 9 + k]);
    return cells;
  };
  for (const kind of [0, 1]) for (let k = 0; k < 9; k++) {
    if (k + 1 < 9) regions.push({ cells: span(kind, k, 2), houses: 2, tier: 3 });
    if (k + 2 < 9) regions.push({ cells: span(kind, k, 3), houses: 3, tier: 3 });
  }
  for (let b = 0; b < 9; b++) {
    if (b % 3 < 2) regions.push({ cells: [...UNITS[18 + b], ...UNITS[19 + b]], houses: 2, tier: 3 });
    if (b < 6) regions.push({ cells: [...UNITS[18 + b], ...UNITS[21 + b]], houses: 2, tier: 3 });
  }

  for (const r of regions) {
    const inRegion = new Set(r.cells);
    const touched = [...new Set(r.cells.map((i) => cageOf[i]))];
    let insideSum = 0, touchedSum = 0;
    const innies = [], outies = [];
    for (const ci of touched) {
      const cells = cages[ci].cells;
      touchedSum += cages[ci].sum;
      if (cells.every((i) => inRegion.has(i))) insideSum += cages[ci].sum;
      else {
        for (const i of cells) (inRegion.has(i) ? innies : outies).push(i);
      }
    }
    add(innies, 45 * r.houses - insideSum, r.tier);
    add(outies, touchedSum - 45 * r.houses, r.tier);
  }
  return out;
}

/**
 * Narrow the candidates of a sum constraint to the digits that appear in at
 * least one valid filling. Returns false when no filling exists.
 */
function filterConstraint(cand, con, budget = 20000, firstOnly = false) {
  const cells = con.cells.slice().sort((a, b) => POP[cand[a]] - POP[cand[b]]);
  const n = cells.length;
  const masks = cells.map((i) => cand[i]);
  const reach = new Array(n).fill(0);
  const val = new Array(n).fill(0);
  // Suffix bounds on the sum still achievable, ignoring distinctness.
  const minS = new Array(n + 1).fill(0), maxS = new Array(n + 1).fill(0);
  for (let k = n - 1; k >= 0; k--) {
    if (!masks[k]) return false;
    minS[k] = minS[k + 1] + LOW(masks[k]);
    maxS[k] = maxS[k + 1] + HIGH(masks[k]);
  }
  let full = 0, nodes = 0, aborted = false;
  const peerOf = cells.map((a, x) => cells.map((b, y) => y < x && (con.distinct || IS_PEER[a * 81 + b])));
  const dfs = (k, rem) => {
    if (++nodes > budget) { aborted = true; return true; }
    if (k === n) {
      if (rem !== 0) return false;
      if (firstOnly) return true;
      for (let x = 0; x < n; x++) reach[x] |= 1 << val[x];
      full = 0;
      for (let x = 0; x < n; x++) if (reach[x] === masks[x]) full++;
      return full === n; // stop once nothing can be narrowed any more
    }
    if (rem < minS[k] || rem > maxS[k]) return false;
    let m = masks[k];
    for (let x = 0; x < k; x++) if (peerOf[k][x]) m &= ~(1 << val[x]);
    while (m) {
      const b = m & -m; m ^= b;
      const d = 31 - Math.clz32(b);
      if (d > rem) break;
      val[k] = d;
      if (dfs(k + 1, rem - d)) return true;
    }
    return false;
  };
  const found = dfs(0, con.sum);
  if (aborted) return true; // too wide to analyse: make no claim
  if (firstOnly) return found;
  if (reach.every((r) => r === 0)) return false;
  let changed = false;
  for (let x = 0; x < n; x++) if (reach[x] !== cand[cells[x]]) { cand[cells[x]] = reach[x]; changed = true; }
  return changed ? "changed" : true;
}

// The generator re-solves near-identical puzzles many times, so remember results.
const cache = new Map();
function filterCached(cand, con) {
  let key = con.sum + (con.distinct ? "d" : "p");
  for (const i of con.cells) key += "," + i + ":" + cand[i];
  let hit = cache.get(key);
  if (hit === undefined) {
    const copy = cand.slice();
    const r = filterConstraint(copy, con);
    hit = r === false ? false : con.cells.map((i) => copy[i]);
    if (cache.size > 200000) cache.clear();
    cache.set(key, hit);
  }
  if (hit === false) return false;
  let changed = false;
  con.cells.forEach((i, k) => { if (cand[i] !== hit[k]) { cand[i] = hit[k]; changed = true; } });
  return changed ? "changed" : true;
}

/** Can the constraint still be filled if digit d is removed from all its cells? */
function feasibleWithout(cand, con, d) {
  const saved = con.cells.map((i) => cand[i]);
  con.cells.forEach((i) => (cand[i] &= ~(1 << d)));
  const ok = con.cells.every((i) => cand[i]) && filterConstraint(cand, con, 5000, true);
  con.cells.forEach((i, k) => (cand[i] = saved[k]));
  return ok;
}

// ---------- Solver ----------

/**
 * Solve with human techniques up to `maxTier`.
 * @param {{cells:number[], sum:number}[]} cages
 * @param {number[]} givens 81 entries, 0 = empty
 * `tier` is the hardest technique needed and `hard` counts the steps of tier 3
 * and up (tier 4 counts triple), as a finer measure of difficulty.
 * @returns {{solved:boolean, valid:boolean, tier:number, hard:number, grid:number[], cand:number[], used:Object<string,number>}}
 */
export function logicSolve(cages, givens, maxTier = 4) {
  const cand = new Array(81).fill(FULL);
  const grid = new Array(81).fill(0);
  const constraints = buildConstraints(cages).filter((c) => c.tier <= maxTier);
  const used = {};
  let tier = 0, hard = 0, valid = true;

  const note = (name, t) => {
    used[name] = (used[name] || 0) + 1;
    if (t > tier) tier = t;
    if (t >= 3) hard += t === 4 ? 3 : 1;
  };
  const place = (i, d) => {
    grid[i] = d; cand[i] = 1 << d;
    for (const p of PEERS[i]) cand[p] &= ~(1 << d);
  };
  const eliminate = (cells, mask) => {
    let hit = false;
    for (const i of cells) if (!grid[i] && cand[i] & mask) { cand[i] &= ~mask; hit = true; }
    return hit;
  };

  for (let i = 0; i < 81; i++) if (givens[i]) place(i, givens[i]);

  // Each technique returns true if it changed anything.
  const nakedSingles = () => {
    let hit = false;
    for (let i = 0; i < 81; i++) {
      if (grid[i]) continue;
      if (!cand[i]) { valid = false; return false; }
      if (POP[cand[i]] === 1) { place(i, LOW(cand[i])); hit = true; }
    }
    return hit;
  };
  const hiddenSingles = () => {
    for (const unit of UNITS) {
      let once = 0, twice = 0, placed = 0;
      for (const i of unit) {
        if (grid[i]) { placed |= 1 << grid[i]; continue; }
        twice |= once & cand[i]; once |= cand[i];
      }
      if ((once | placed) !== FULL) { valid = false; return false; }
      const single = once & ~twice & ~placed;
      if (single) {
        const b = single & -single;
        for (const i of unit) if (!grid[i] && cand[i] & b) { place(i, LOW(b)); return true; }
      }
    }
    return false;
  };
  const sumFilter = (t) => () => {
    let hit = false;
    for (const con of constraints) {
      if (con.tier !== t) continue;
      // Skip constraints whose cells have not changed since they were last checked.
      const key = con.cells.map((i) => cand[i]).join();
      if (key === con.seen) continue;
      const r = filterCached(cand, con);
      con.seen = con.cells.map((i) => cand[i]).join();
      if (r === false) { valid = false; return false; }
      if (r === "changed") hit = true;
    }
    return hit;
  };
  // Locked candidates: a digit confined to one house inside another house (or
  // a digit a cage must contain, confined to one house) clears the rest.
  const lockedCandidates = () => {
    for (let u = 0; u < 27; u++) {
      const cells = UNITS[u].filter((i) => !grid[i]);
      for (let d = 1; d <= 9; d++) {
        const b = 1 << d;
        const where = cells.filter((i) => cand[i] & b);
        if (where.length < 2) continue;
        for (const v of UNITS_OF[where[0]]) {
          if (v === u || !where.every((i) => UNITS_OF[i].includes(v))) continue;
          if (eliminate(UNITS[v].filter((i) => !where.includes(i)), b)) return true;
        }
      }
    }
    for (const con of constraints) {
      if (!con.distinct || con.tier > 2) continue;
      const open = con.cells.filter((i) => !grid[i]);
      if (!open.length) continue;
      let union = 0;
      for (const i of open) union |= cand[i];
      for (let d = 1; d <= 9; d++) {
        const b = 1 << d;
        if (!(union & b)) continue;
        const where = open.filter((i) => cand[i] & b);
        const shared = UNITS_OF[where[0]].filter((v) => where.every((i) => UNITS_OF[i].includes(v)));
        if (!shared.length) continue;
        const targets = shared.flatMap((v) => UNITS[v]).filter((i) => !con.cells.includes(i));
        if (!targets.some((i) => !grid[i] && cand[i] & b)) continue;
        if (feasibleWithout(cand, con, d)) continue; // the cage does not have to contain d
        if (eliminate(targets, b)) return true;
      }
    }
    return false;
  };
  const nakedSubset = (n) => () => {
    for (const unit of UNITS) {
      const open = unit.filter((i) => !grid[i] && POP[cand[i]] <= n);
      if (open.length < n) continue;
      for (const set of combinations(open, n)) {
        let m = 0;
        for (const i of set) m |= cand[i];
        if (POP[m] !== n) continue;
        if (eliminate(unit.filter((i) => !set.includes(i)), m)) return true;
      }
    }
    return false;
  };
  const hiddenSubset = (n) => () => {
    for (const unit of UNITS) {
      const open = unit.filter((i) => !grid[i]);
      const digits = [];
      for (let d = 1; d <= 9; d++) {
        const c = open.filter((i) => cand[i] & (1 << d)).length;
        if (c >= 2 && c <= n) digits.push(d);
      }
      if (digits.length < n) continue;
      for (const ds of combinations(digits, n)) {
        let m = 0;
        for (const d of ds) m |= 1 << d;
        const where = open.filter((i) => cand[i] & m);
        if (where.length !== n) continue;
        let hit = false;
        for (const i of where) if (cand[i] & ~m) { cand[i] &= m; hit = true; }
        if (hit) return true;
      }
    }
    return false;
  };
  const fish = (n) => () => {
    for (let d = 1; d <= 9; d++) {
      const b = 1 << d;
      for (const byRow of [true, false]) {
        const lines = [];
        for (let a = 0; a < 9; a++) {
          let pos = 0;
          for (let k = 0; k < 9; k++) {
            const i = byRow ? a * 9 + k : k * 9 + a;
            if (!grid[i] && cand[i] & b) pos |= 1 << k;
          }
          const c = POP[pos];
          if (c >= 2 && c <= n) lines.push([a, pos]);
        }
        if (lines.length < n) continue;
        for (const set of combinations(lines, n)) {
          let pos = 0;
          for (const [, p] of set) pos |= p;
          if (POP[pos] !== n) continue;
          const base = set.map(([a]) => a);
          const targets = [];
          for (let k = 0; k < 9; k++) if (pos & (1 << k)) for (let a = 0; a < 9; a++) {
            if (!base.includes(a)) targets.push(byRow ? a * 9 + k : k * 9 + a);
          }
          if (eliminate(targets, b)) return true;
        }
      }
    }
    return false;
  };
  const xyWing = () => {
    const bi = [];
    for (let i = 0; i < 81; i++) if (!grid[i] && POP[cand[i]] === 2) bi.push(i);
    for (const p of bi) {
      const wings = bi.filter((w) => w !== p && IS_PEER[p * 81 + w] && POP[cand[w] & cand[p]] === 1);
      for (let x = 0; x < wings.length; x++) for (let y = x + 1; y < wings.length; y++) {
        const a = wings[x], b = wings[y];
        const z = cand[a] & cand[b] & ~cand[p];
        if (POP[z] !== 1 || (cand[a] & cand[p]) === (cand[b] & cand[p])) continue;
        const targets = PEERS[a].filter((i) => i !== p && IS_PEER[b * 81 + i]);
        if (eliminate(targets, z)) return true;
      }
    }
    return false;
  };

  const techniques = [
    ["naked single", 1, nakedSingles],
    ["hidden single", 1, hiddenSingles],
    ["cage combinations", 1, sumFilter(1)],
    ["rule of 45", 2, sumFilter(2)],
    ["locked candidates", 2, lockedCandidates],
    ["naked pair", 2, nakedSubset(2)],
    ["hidden pair", 2, hiddenSubset(2)],
    ["rule of 45 (several houses)", 3, sumFilter(3)],
    ["naked triple", 3, nakedSubset(3)],
    ["hidden triple", 3, hiddenSubset(3)],
    ["x-wing", 3, fish(2)],
    ["naked quad", 4, nakedSubset(4)],
    ["hidden quad", 4, hiddenSubset(4)],
    ["swordfish", 4, fish(3)],
    ["xy-wing", 4, xyWing],
  ].filter(([, t]) => t <= maxTier);

  // Always retry the easiest technique after any progress, like a person would.
  outer: for (;;) {
    if (grid.every((v) => v)) break;
    for (const [name, t, fn] of techniques) {
      const hit = fn();
      if (!valid) break outer;
      if (hit) { note(name, t); continue outer; }
    }
    break;
  }
  const solved = valid && grid.every((v) => v);
  return { solved, valid, tier, hard, grid, cand, used };
}
