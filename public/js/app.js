import { rowOf, colOf, boxOf } from "./engine.js";
import * as lb from "./leaderboard.js";
import { passkeysSupported, savePasskey, signInWithPasskey } from "./passkey.js";
import { DAILY_LEVEL, dailyDate, dailySeed, dailyLabel, addDays, addSolved, mergeDays, streak } from "./daily.js";
import { MODE_NAMES, DEFAULT_CLOCK, showDuelCode, duelLink, readDuelCode, createDuel, duelInfo, joinDuel, clockLeft, DuelSocket } from "./duel.js";

const MAX_MISTAKES = 3;
const LEVELS = { easy: "Easy", medium: "Medium", hard: "Hard", expert: "Expert", master: "Master" };
const STORE = {
  game: "cagey:game", theme: "cagey:theme", next: (d) => `cagey:next3:${d}`, level: "cagey:level",
  daily: "cagey:daily", // the current or last daily game (any run)
  dailyDone: "cagey:dailyDone", // dates on which a daily was finished, for the streak
  daysSynced: "cagey:daysSynced", // the dates the server is known to have
  mode: "cagey:mode", // "daily" or "duel" while that is the open game
  duel: "cagey:duel", // the current or last duel game, once its board is built
  duelSession: "cagey:duelSession", // { code, token, seat, mode, level, clock } of the current duel
  duelPrefs: "cagey:duelPrefs", // last duel settings: { mode, level, clock }
  duelAlerts: "cagey:duelAlerts", // false when chess-clock turn alerts (sound, vibration) are off
  passkey: "cagey:passkey", // set once a passkey was saved or used here
};

const $ = (id) => document.getElementById(id);
const board = $("board");
const cagesSvg = $("cages");
const keypad = $("keypad");

const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

// ---------- Puzzle generation (Web Worker) ----------

let worker = null;
const pending = new Map();
let reqId = 0;
function requestPuzzle(difficulty, seed) {
  if (!worker) {
    worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
    worker.onmessage = (e) => {
      const { id, puzzle, error } = e.data;
      const p = pending.get(id);
      pending.delete(id);
      if (p) error ? p.reject(new Error(error)) : p.resolve(puzzle);
    };
  }
  const id = ++reqId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, difficulty, seed });
  });
}

/** Keep one ready-made puzzle per difficulty so "New game" is instant. */
const prefetching = {};
function prefetch(difficulty) {
  if (store.get(STORE.next(difficulty)) || prefetching[difficulty]) return;
  prefetching[difficulty] = requestPuzzle(difficulty)
    .then((p) => store.set(STORE.next(difficulty), p))
    .finally(() => delete prefetching[difficulty]);
}
async function takePuzzle(difficulty) {
  const ready = store.get(STORE.next(difficulty));
  if (ready) { store.del(STORE.next(difficulty)); return ready; }
  if (prefetching[difficulty]) await prefetching[difficulty];
  const now = store.get(STORE.next(difficulty));
  if (now) { store.del(STORE.next(difficulty)); return now; }
  return requestPuzzle(difficulty);
}

// ---------- State ----------

/**
 * `daily` is the puzzle's date for a daily game. `ranked` is true only for the
 * first run of a daily; replays don't go on the leaderboard. `replay` is set when
 * the game replays a board from the leaderboard (`name` set the original time).
 * `duel` is set for a duel game ({ code, token, seat, mode, level, clock }); its
 * board is driven by the server and `duelLast` keeps the last state it sent.
 * In a chess-clock duel the puzzle has no solution: the server checks every digit.
 * @type {{puzzle:any, values:number[], notes:number[], mistakes:number, elapsed:number, status:string, history:any[], unlimited:boolean, daily?:string, ranked?:boolean, replay?:{name:string}, duel?:object, duelLast?:object}}
 */
let game = null;
let selected = -1;
let notesMode = false;
let area = null; // { type: "row"|"col"|"box", index, cells:number[] }
let areaFocus = -1; // far end of a shift+arrow / shift-click area; `selected` is the anchor
let cageOf = new Array(81);
let paused = false;

const cells = [];
const isGiven = (i) => game.puzzle.givens[i] !== 0;
// Without a solution (chess-clock duel), only digits the server accepted are on the board.
const isCorrect = (i) => game.values[i] !== 0 && (!game.puzzle.solution || game.values[i] === game.puzzle.solution[i]);
const unitCells = (type, index) => {
  const out = [];
  for (let i = 0; i < 81; i++) {
    if ((type === "row" && rowOf(i) === index) || (type === "col" && colOf(i) === index) || (type === "box" && boxOf(i) === index)) out.push(i);
  }
  return out;
};
const peersOf = (i) => {
  const out = [];
  for (let j = 0; j < 81; j++) {
    if (j !== i && (rowOf(j) === rowOf(i) || colOf(j) === colOf(i) || boxOf(j) === boxOf(i))) out.push(j);
  }
  return out;
};

function newGameState(puzzle) {
  return {
    puzzle,
    values: puzzle.givens.slice(),
    notes: new Array(81).fill(0),
    mistakes: 0,
    elapsed: 0,
    status: "playing",
    history: [],
    unlimited: false,
    hints: 0,
  };
}

function save() { if (game) store.set(game.duel ? STORE.duel : game.daily ? STORE.daily : STORE.game, game); }

// ---------- Board construction ----------

function buildBoard() {
  for (let i = 0; i < 81; i++) {
    const el = document.createElement("div");
    el.className = `cell r${rowOf(i)} c${colOf(i)}`;
    el.dataset.i = i;
    el.setAttribute("role", "gridcell");
    board.insertBefore(el, cagesSvg);
    cells.push(el);
  }
  for (let d = 1; d <= 9; d++) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "key";
    b.dataset.d = d;
    b.innerHTML = `${d}<small></small>`;
    keypad.appendChild(b);
  }
}

function setupCages() {
  cageOf = new Array(81);
  game.puzzle.cages.forEach((c, ci) => c.cells.forEach((i) => (cageOf[i] = ci)));
  for (const el of cells) el.querySelector(".sum")?.remove();
  game.puzzle.cages.forEach((c) => {
    const anchor = Math.min(...c.cells);
    const s = document.createElement("span");
    s.className = "sum";
    s.textContent = c.sum;
    cells[anchor].appendChild(s);
  });
  drawCages();
}

/** Dashed cage outlines, inset from the cell edges, with a gap for the sum label. */
function drawCages() {
  if (!game) return;
  const size = board.clientWidth;
  if (!size) return;
  const cs = size / 9;
  const inset = Math.max(3, cs * 0.08);
  const same = (i, r, c) => r >= 0 && r < 9 && c >= 0 && c < 9 && cageOf[r * 9 + c] === cageOf[i];
  const segs = [];
  const line = (x1, y1, x2, y2) => {
    if (y1 === y2 && x2 - x1 > 0.5) segs.push(`M${x1.toFixed(1)} ${y1.toFixed(1)}H${x2.toFixed(1)}`);
    else if (x1 === x2 && y2 - y1 > 0.5) segs.push(`M${x1.toFixed(1)} ${y1.toFixed(1)}V${y2.toFixed(1)}`);
  };
  for (let i = 0; i < 81; i++) {
    const r = rowOf(i), c = colOf(i);
    const x0 = c * cs, y0 = r * cs, x1 = x0 + cs, y1 = y0 + cs;
    const top = !same(i, r - 1, c), bottom = !same(i, r + 1, c), left = !same(i, r, c - 1), right = !same(i, r, c + 1);
    const isAnchor = Math.min(...game.puzzle.cages[cageOf[i]].cells) === i;
    // Each side bordering another cage gets a line inset by `inset`.
    // A side reaches the cell edge when the neighbouring cell continues the cage.
    let labelW = 0, labelH = 0;
    if (isAnchor) {
      // Leave a gap in the outline around the sum label.
      const s = cells[i].querySelector(".sum");
      labelW = s ? s.offsetLeft + s.offsetWidth + 2 : cs * 0.36;
      labelH = s ? s.offsetTop + s.offsetHeight + 1 : cs * 0.26;
    }
    if (top) {
      let a = left ? x0 + inset : x0, b = right ? x1 - inset : x1;
      if (isAnchor) a = Math.max(a, x0 + labelW);
      line(a, y0 + inset, b, y0 + inset);
    }
    if (bottom) line(left ? x0 + inset : x0, y1 - inset, right ? x1 - inset : x1, y1 - inset);
    if (left) {
      let a = top ? y0 + inset : y0, b = bottom ? y1 - inset : y1;
      if (isAnchor) a = Math.max(a, y0 + labelH);
      line(x0 + inset, a, x0 + inset, b);
    }
    if (right) line(x1 - inset, top ? y0 + inset : y0, x1 - inset, bottom ? y1 - inset : y1);
    // Inner corners: both neighbours in the cage, but the diagonal is not.
    const corner = (dr, dc) => {
      if (!same(i, r + dr, c) || !same(i, r, c + dc) || same(i, r + dr, c + dc)) return;
      const cx = dc < 0 ? x0 : x1, cy = dr < 0 ? y0 : y1;
      const ix = dc < 0 ? x0 + inset : x1 - inset, iy = dr < 0 ? y0 + inset : y1 - inset;
      line(Math.min(cx, ix), iy, Math.max(cx, ix), iy);
      line(ix, Math.min(cy, iy), ix, Math.max(cy, iy));
    };
    corner(-1, -1); corner(-1, 1); corner(1, -1); corner(1, 1);
  }
  cagesSvg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  cagesSvg.innerHTML = `<path d="${segs.join("")}"/>`;
}

// ---------- Rendering ----------

function render() {
  if (!game) return;
  const sel = selected;
  const selVal = sel >= 0 ? game.values[sel] : 0;
  const areaSet = area ? new Set(area.cells) : null;
  const lastTurn = duelLastTurn();

  // Cells that repeat a digit in a row, column or box.
  const conflict = new Set();
  for (let i = 0; i < 81; i++) {
    const v = game.values[i];
    if (!v || isCorrect(i)) continue;
    for (const j of peersOf(i)) if (game.values[j] === v) { conflict.add(j); }
  }

  for (let i = 0; i < 81; i++) {
    const el = cells[i];
    const v = game.values[i];
    const peer = sel >= 0 && i !== sel && (rowOf(i) === rowOf(sel) || colOf(i) === colOf(sel) || boxOf(i) === boxOf(sel));
    el.classList.toggle("selected", i === sel);
    el.classList.toggle("peer", !areaSet && peer);
    el.classList.toggle("same", !areaSet && selVal !== 0 && v === selVal && i !== sel);
    el.classList.toggle("area", !!areaSet && areaSet.has(i));
    el.classList.toggle("area-focus", !!areaSet && i === areaFocus && i !== sel);
    el.classList.toggle("conflict", conflict.has(i));
    el.classList.toggle("given", isGiven(i));
    el.classList.toggle("wrong", v !== 0 && !isCorrect(i));
    // Duels: the opponent's digits on a shared board, and digits shown for a moment.
    const temp = v ? null : duelTemp(i);
    el.classList.toggle("theirs", !!game.owner && game.owner[i] === 1 - game.duel.seat);
    el.classList.toggle("last-move", lastTurn.has(i));
    el.classList.toggle("pending", temp?.kind === "pending");
    el.classList.toggle("rejected", temp?.kind === "rejected");

    const key = v ? `v${v}` : temp ? `t${temp.digit}` : `n${game.notes[i]}:${selVal}`;
    if (el.dataset.key === key) continue;
    el.dataset.key = key;
    el.querySelector(".value, .notes")?.remove();
    if (v || temp) {
      const s = document.createElement("span");
      s.className = "value";
      s.textContent = v || temp.digit;
      el.prepend(s);
    } else if (game.notes[i]) {
      const n = document.createElement("div");
      n.className = "notes";
      for (let d = 1; d <= 9; d++) {
        const s = document.createElement("span");
        if (game.notes[i] & (1 << d)) { s.textContent = d; if (d === selVal) s.className = "hl"; }
        n.appendChild(s);
      }
      el.prepend(n);
    }
  }

  // Keypad: remaining counts, completed digits, and missing digits for the area.
  const counts = new Array(10).fill(0);
  for (let i = 0; i < 81; i++) if (isCorrect(i)) counts[game.values[i]]++;
  const present = new Set(area ? area.cells.map((i) => (isCorrect(i) ? game.values[i] : 0)) : []);
  for (const k of keypad.children) {
    const d = +k.dataset.d;
    k.classList.toggle("done", counts[d] >= 9);
    k.classList.toggle("missing", !!area && !present.has(d));
    k.querySelector("small").textContent = counts[d] >= 9 ? "" : 9 - counts[d];
  }
  document.body.classList.toggle("area-mode", !!area);
  document.body.classList.toggle("notes-mode", notesMode);

  $("notesBtn").setAttribute("aria-pressed", notesMode);
  $("notesBadge").textContent = notesMode ? "on" : "off";
  const m = $("mistakes");
  m.textContent = game.unlimited ? `${game.mistakes}` : `${game.mistakes}/${MAX_MISTAKES}`;
  m.classList.toggle("danger", game.mistakes > 0);
  $("levelLabel").textContent = game.daily ? "Daily" : `${LEVELS[game.puzzle.difficulty] || ""}${game.replay ? " replay" : ""}`;
  $("undoBtn").disabled = !game.history.length;
  renderTime();
  renderDuel();
}

const fmt = (s) => {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const mm = String(m).padStart(2, "0"), ss = String(sec).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
};
function renderTime() { if (!game.duel) $("timer").textContent = fmt(Math.floor(game.elapsed)); }

// ---------- Timer ----------

let lastTick = performance.now();
setInterval(() => {
  const now = performance.now();
  const dt = (now - lastTick) / 1000;
  lastTick = now;
  if (game?.duel) { renderDuel(); return; } // duel clocks come from the server
  if (game && game.status === "playing" && !paused && document.visibilityState === "visible") {
    const before = Math.floor(game.elapsed);
    game.elapsed += Math.min(dt, 2);
    if (Math.floor(game.elapsed) !== before) { renderTime(); if (Math.floor(game.elapsed) % 5 === 0) save(); }
  }
}, 250);

function setPaused(p) {
  if (!game || game.status !== "playing" || game.duel) p = false; // a duel can't be paused
  paused = p;
  $("pauseCover").hidden = !p;
  document.body.classList.toggle("paused", p);
  $("pauseBtn").setAttribute("aria-label", p ? "Resume" : "Pause");
  save();
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") save();
  else renderDailyBtn(); // the day may have changed
});

// ---------- Actions ----------

const canPlay = () => game && game.status === "playing" && !paused && (!game.duel || duelStarted());

function pop(i) { cells[i].classList.remove("pop"); void cells[i].offsetWidth; cells[i].classList.add("pop"); }

function snapshot(list) { return list.map((i) => ({ i, v: game.values[i], n: game.notes[i] })); }

function inputDigit(d) {
  if (!canPlay() || selected < 0) return;
  const i = selected;
  if (isGiven(i) || isCorrect(i)) return;

  if (notesMode) {
    if (game.values[i]) return;
    game.history.push({ cells: snapshot([i]) });
    game.notes[i] ^= 1 << d;
    afterChange();
    return;
  }

  if (game.duel?.mode === "chess") { chessMove(i, d); return; }
  if (game.values[i] === d) return;
  const affected = [i, ...peersOf(i).filter((j) => !game.values[j] && game.notes[j] & (1 << d))];
  game.history.push({ cells: snapshot(affected) });
  game.values[i] = d;
  game.notes[i] = 0;
  pop(i);

  // A race duel: the server counts digits and mistakes and decides who wins.
  if (game.duel) duelSend({ type: "move", cell: i, digit: d });
  if (d === game.puzzle.solution[i]) {
    for (const j of affected) if (j !== i) game.notes[j] &= ~(1 << d);
    if (!game.duel && game.values.every((v, j) => v === game.puzzle.solution[j])) return finish(true);
  } else {
    game.mistakes++;
    if (!game.duel && !game.unlimited && game.mistakes >= MAX_MISTAKES) { afterChange(); return finish(false); }
  }
  afterChange();
}

function erase() {
  if (!canPlay() || selected < 0) return;
  const i = selected;
  if (isGiven(i) || isCorrect(i) || (!game.values[i] && !game.notes[i])) return;
  game.history.push({ cells: snapshot([i]) });
  game.values[i] = 0;
  game.notes[i] = 0;
  afterChange();
}

function undo() {
  if (!canPlay()) return;
  const h = game.history.pop();
  if (!h) return;
  // On a shared board, undo only takes back notes: placed digits belong to the server.
  const shared = game.duel?.mode === "chess";
  for (const { i, v, n } of h.cells) {
    if (!shared) game.values[i] = v;
    if (!shared || !game.values[i]) game.notes[i] = n;
  }
  afterChange();
}

function hint() {
  if (!canPlay() || game.duel) return;
  let i = selected;
  if (i < 0 || isCorrect(i)) {
    const open = [];
    for (let j = 0; j < 81; j++) if (!isCorrect(j)) open.push(j);
    if (!open.length) return;
    i = open[Math.floor(Math.random() * open.length)];
    selected = i;
  }
  const d = game.puzzle.solution[i];
  game.hints = (game.hints || 0) + 1;
  const affected = [i, ...peersOf(i).filter((j) => !game.values[j] && game.notes[j] & (1 << d))];
  game.history.push({ cells: snapshot(affected) });
  game.values[i] = d;
  game.notes[i] = 0;
  for (const j of affected) if (j !== i) game.notes[j] &= ~(1 << d);
  pop(i);
  if (game.values.every((v, j) => v === game.puzzle.solution[j])) return finish(true);
  afterChange();
}

function afterChange() { save(); render(); }

function finish(won) {
  game.status = won ? "won" : "lost";
  area = null;
  // Any finished daily keeps the streak going, also replays and games past three mistakes.
  if (won && game.daily) { store.set(STORE.dailyDone, addSolved(store.get(STORE.dailyDone), game.daily)); renderDailyBtn(); syncStreak(); }
  save();
  render();
  showEnd(won, won ? 350 : 0);
}

function showEnd(won, delay = 0) {
  const g = game;
  $("endTitle").textContent = won ? "Solved" : "Three mistakes";
  const what = g.daily ? `Daily challenge (${dailyLabel(g.daily)})`
    : g.replay ? `${possessive(g.replay.name)} ${LEVELS[g.puzzle.difficulty]} board`
    : `${LEVELS[g.puzzle.difficulty]} puzzle`;
  let text = won
    ? `${what} in ${fmt(Math.floor(g.elapsed))} with ${plural(g.mistakes, "mistake")}.` + penaltyNote(g)
    : "That's the limit. You can start over, or keep going without a mistake limit.";
  if (won && g.daily) {
    const s = dailyStreak();
    text += ` Streak: ${plural(s.current, "day")}${s.best > s.current ? ` (best ${s.best})` : ""}.`;
  }
  $("endText").textContent = text;
  $("continueBtn").hidden = won;
  $("replayBtn").hidden = !g.daily;
  $("rematchBtn").hidden = true;
  $("shareBtn").hidden = !(won && g.daily);
  $("shareBtn").textContent = "Share";
  $("endDialog").returnValue = "";
  setupSubmit(won);
  setTimeout(() => { if (!$("endDialog").open) $("endDialog").showModal(); }, delay);
}

// ---------- Leaderboard ----------

const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
/** Leaderboard hint penalty in seconds: hint k costs k minutes. Must match functions/api/scores.js. */
const hintPenalty = (n) => 30 * n * (n + 1);
/** Short duration: 30s, 1m, 1m 30s. */
const dur = (s) => (s < 60 ? `${s}s` : s % 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s / 60}m`);
const hintText = (hints) => (hints ? `${plural(hints, "hint")} +${dur(hintPenalty(hints))}` : "");
/** Label for a mistake-count group in the leaderboard. */
const sectionName = (m) => (m ? plural(m, "mistake") : "No mistakes");
function penaltyNote(g) {
  const hints = g.hints || 0;
  if (g.unlimited || !hints) return "";
  return ` ${plural(hints, "hint")} add${hints === 1 ? "s" : ""} ${dur(hintPenalty(hints))}, so your leaderboard time is ${fmt(Math.floor(g.elapsed) + hintPenalty(hints))}.`;
}
const possessive = (name) => `${name}${/s$/i.test(name) ? "’" : "’s"}`;
const escapeHtml = (t) => String(t).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The solve that just finished, waiting for a name before it is posted. */
let solve = null;

function lbStatus(text, isError = false) {
  const el = $("lbStatus");
  el.hidden = !text;
  el.classList.toggle("error", isError);
  el.innerHTML = text || "";
}

async function setupSubmit(won) {
  solve = null;
  $("lbForm").hidden = true;
  lbStatus("");
  if (!won) return;
  if (game.unlimited) { lbStatus("Games played past three mistakes don't go on the leaderboard."); return; }
  if (game.daily && !game.ranked) { lbStatus(`Replays don't go on the leaderboard. Only your first run of the day counts. <button type="button" class="link-inline" data-open-board>See leaderboard</button>`); return; }
  const g = game;
  solve = {
    ...(g.daily ? { daily: g.daily } : {}),
    level: g.puzzle.difficulty,
    time: Math.floor(g.elapsed),
    mistakes: g.mistakes,
    hints: g.hints || 0,
    puzzle: g.puzzle.hash || (g.puzzle.hash = await lb.puzzleHash(g.puzzle)),
    ...(Number.isInteger(g.puzzle.seed) && !g.daily ? { seed: g.puzzle.seed } : {}),
    ...(g.replay ? { replay: true } : {}),
  };
  if (g.posted) { showPosted(g.posted); return; }
  if (lb.getName()) postSolve();
  else { $("lbForm").hidden = false; $("lbName").value = ""; }
}

function showPosted(r) {
  const me = r.me;
  const name = escapeHtml(me?.name || lb.getName());
  const see = ` <button type="button" class="link-inline" data-open-board>See leaderboard</button>`;
  if (solve.replay && r.duplicate) { lbStatus(`You already have a time on this board, so this one isn't posted.${see}`); return; }
  const board = solve.daily ? `the ${escapeHtml(dailyLabel(solve.daily))} daily`
    : solve.replay ? `the replays of ${escapeHtml(possessive(game?.replay?.name || "this"))} board`
    : LEVELS[solve.level];
  const where = me ? ` You're <b>#${me.rank}</b> of ${me.total} on ${board}.` : "";
  const note = r.best === false && me ? ` Your best is still ${fmt(me.time)} with ${me.mistakes ? plural(me.mistakes, "mistake") : "no mistakes"}.` : "";
  lbStatus(`Posted as ${name}.${where}${note}${see}`);
}

async function postSolve() {
  if (!solve) return;
  const g = game;
  lbStatus("Posting to the leaderboard…");
  try {
    const r = await lb.submitScore(solve);
    g.posted = r; save();
    showPosted(r);
  } catch (e) {
    lbStatus(e.status ? escapeHtml(e.message) : "Couldn't reach the leaderboard. It will be posted next time you're online.", true);
  }
}

$("lbForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const name = $("lbName").value.trim();
  if (!name) return;
  lb.setName(name);
  $("lbForm").hidden = true;
  postSolve();
});

document.addEventListener("click", (e) => {
  if (!e.target.closest("[data-open-board]")) return;
  $("endDialog").close("board");
  if (solve?.replay) openReplays.add(solve.puzzle);
  openBoard(solve?.daily ? "daily" : solve?.level);
});

let boardLevel = null; // a level, or "daily"
let boardDate = null; // the day shown on the daily tab
let boardEntries = []; // entries of the level board on screen
const openReplays = new Set(); // puzzle hashes whose replay list is shown
async function openBoard(level) {
  boardLevel = level || (game?.daily ? "daily" : game?.puzzle.difficulty) || "medium";
  boardDate = solve?.daily || game?.daily || dailyDate();
  renderPlayingAs();
  if (!$("boardDialog").open) $("boardDialog").showModal();
  loadBoard();
}

function renderPlayingAs() {
  const name = lb.getName();
  $("lbRenameRow").hidden = true;
  const sync = ` · <button type="button" class="link-inline" data-open-sync>Other devices</button>`;
  $("lbPlayingAs").innerHTML = (name
    ? `Playing as <b>${escapeHtml(name)}</b> · <button type="button" class="link-inline" id="lbChange">Change name</button>`
    : "Solve a puzzle to add your time.") + sync;
}

async function loadBoard() {
  const level = boardLevel;
  for (const t of $("lbTabs").children) {
    const on = t.dataset.level === level;
    t.classList.toggle("current", on);
    t.setAttribute("aria-selected", on);
  }
  const list = $("lbList");
  list.innerHTML = `<p class="lb-empty">Loading…</p>`;
  const daily = level === "daily" ? boardDate : null;
  const head = daily
    ? `<p class="lb-day">${escapeHtml(dailyLabel(daily))} · ${LEVELS[DAILY_LEVEL]}</p>` : "";
  let data;
  try { data = await lb.fetchScores(level, daily); }
  catch (e) { if (level === boardLevel) list.innerHTML = `${head}<p class="lb-empty">${escapeHtml(e.message)}</p>`; return; }
  if (level !== boardLevel) return;
  boardEntries = daily ? [] : data.entries;
  if (!data.entries.length) { list.innerHTML = `${head}<p class="lb-empty">No times yet. Be the first.</p>`; return; }
  // One ranking: fewer mistakes first, then time. A quiet label marks where each mistake count starts.
  let group = -1;
  const rows = data.entries.map((r, i) => {
    const sep = r.mistakes !== group ? `<li class="lb-sep" aria-hidden="true"><span>${sectionName(r.mistakes)}</span></li>` : "";
    group = r.mistakes;
    const open = !daily && r.replays > 0 && openReplays.has(r.puzzle);
    const acts = daily ? "" : `<span class="lb-acts">${
      r.replays ? `<button type="button" class="lb-act lb-more" data-replays="${i}" aria-expanded="${open}" title="${open ? "Hide" : "Show"} ${plural(r.replays, "replay")}" aria-label="${plural(r.replays, "replay")} of ${escapeHtml(possessive(r.name))} board">${USERS_SVG}<span>${r.replays}</span></button>` : ""
    }${
      r.seed != null ? `<button type="button" class="lb-act" data-replay="${i}" title="Play this board" aria-label="Play ${escapeHtml(possessive(r.name))} board">${REPLAY_SVG}</button>` : ""
    }</span>`;
    return `${sep}
      <li class="${[r.me ? "me" : "", r.rank <= 3 ? "top" : "", open ? "open" : ""].join(" ").trim()}">
        <span class="lb-rank">${r.rank}</span>
        <span class="lb-name">${escapeHtml(r.name)}</span>
        <span class="lb-extra">${hintText(r.hints)}</span>
        ${acts}
        <span class="lb-time">${fmt(r.time)}</span>
      </li>${open ? replaysRow(r.puzzle) : ""}`;
  }).join("");
  const me = data.me && !data.entries.some((r) => r.me)
    ? `<p class="lb-me">Your best: <b>${fmt(data.me.time)}</b> with ${data.me.mistakes ? plural(data.me.mistakes, "mistake") : "no mistakes"}, #${data.me.rank} of ${data.me.total}</p>` : "";
  list.innerHTML = `${head}<p class="lb-msg" id="lbMsg" hidden></p><ol class="${daily ? "" : "has-acts"}">${rows}</ol>${me}`;
  for (const r of boardEntries) if (r.replays > 0 && openReplays.has(r.puzzle)) loadReplays(r.puzzle);
}

const USERS_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>`;
const REPLAY_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M10.5 9.2v5.6l4.4-2.8z"/></svg>`;

/** The (still empty) replay list under a board's entry. */
const replaysRow = (puzzle) => `<li class="lb-replays" data-puzzle="${puzzle}"><p class="lb-empty">Loading…</p></li>`;

/** Fill in the replay list of one board: the original and every replay, ranked. */
async function loadReplays(puzzle) {
  const find = () => [...$("lbList").querySelectorAll(".lb-replays")].find((el) => el.dataset.puzzle === puzzle);
  let data;
  try { data = await lb.fetchReplays(puzzle); }
  catch (e) { const el = find(); if (el) el.innerHTML = `<p class="lb-empty">${escapeHtml(e.message)}</p>`; return; }
  const el = find();
  if (!el) return;
  el.innerHTML = `<ol>${data.entries.map((r) => `
    <li class="${r.me ? "me" : ""}">
      <span class="lb-rank">${r.rank}</span>
      <span class="lb-name">${escapeHtml(r.name)}${r.original ? ` <span class="lb-tag">original</span>` : ""}</span>
      <span class="lb-extra">${[r.mistakes ? plural(r.mistakes, "mistake") : "", hintText(r.hints)].filter(Boolean).join(" · ")}</span>
      <span class="lb-time">${fmt(r.time)}</span>
    </li>`).join("")}</ol>`;
  enter(el, { y: -4, duration: 180 });
}

/** Play the board behind a leaderboard entry. Its replay goes on that board's replay list. */
async function startReplay(entry, btn) {
  const level = boardLevel;
  const msg = (text) => { const m = $("lbMsg"); if (m) { m.textContent = text; m.hidden = !text; } };
  msg("");
  btn.disabled = true;
  btn.classList.add("busy");
  try {
    const puzzle = await requestPuzzle(level, entry.seed);
    puzzle.hash = await lb.puzzleHash(puzzle);
    // The generator changed since this time was set, so the seed makes a different board.
    if (puzzle.hash !== entry.puzzle) { msg("This board was made by an older version of the game and can't be replayed."); return; }
    $("boardDialog").close();
    store.set(STORE.mode, "normal");
    loadGame({ ...newGameState(puzzle), replay: { name: entry.name } });
  } catch {
    msg("Couldn't build this board. Try again.");
  } finally {
    btn.disabled = false;
    btn.classList.remove("busy");
  }
}

$("lbList").addEventListener("click", (e) => {
  const play = e.target.closest("[data-replay]");
  if (play) { startReplay(boardEntries[+play.dataset.replay], play); return; }
  const more = e.target.closest("[data-replays]");
  if (!more) return;
  const r = boardEntries[+more.dataset.replays];
  const li = more.closest("li");
  const open = !openReplays.has(r.puzzle);
  open ? openReplays.add(r.puzzle) : openReplays.delete(r.puzzle);
  li.classList.toggle("open", open);
  more.setAttribute("aria-expanded", open);
  more.title = `${open ? "Hide" : "Show"} ${plural(r.replays, "replay")}`;
  if (open) { li.insertAdjacentHTML("afterend", replaysRow(r.puzzle)); loadReplays(r.puzzle); }
  else li.nextElementSibling?.classList.contains("lb-replays") && li.nextElementSibling.remove();
});

$("boardBtn").addEventListener("click", () => openBoard());
$("lbTabs").addEventListener("click", (e) => {
  const t = e.target.closest("[data-level]");
  if (t) { boardLevel = t.dataset.level; loadBoard(); }
});
$("lbNameForm").addEventListener("click", (e) => {
  if (!e.target.closest("#lbChange")) return;
  $("lbPlayingAs").innerHTML = "";
  $("lbRenameRow").hidden = false;
  $("lbRename").value = lb.getName();
  $("lbRename").focus();
  $("lbRename").select();
});
$("lbNameForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("lbRename").value.trim();
  if (!name) return;
  try { await lb.renameEverywhere(name); } catch {}
  renderPlayingAs();
  loadBoard();
});

$("endDialog").addEventListener("close", () => {
  const v = $("endDialog").returnValue;
  if (v === "continue" && game.status === "lost") {
    game.status = "playing";
    game.unlimited = true;
    afterChange();
  } else if (v === "new") {
    openNewDialog();
  } else if (v === "replay" && game.daily) {
    replayDaily();
  } else if (v === "rematch" && game.duel) {
    rematch();
  }
});

$("shareBtn").addEventListener("click", async () => {
  const text = shareText(game);
  try {
    if (navigator.share && matchMedia("(hover: none)").matches) { await navigator.share({ text }); return; }
    await navigator.clipboard.writeText(text);
    $("shareBtn").textContent = "Copied";
  } catch (e) {
    if (e?.name !== "AbortError") $("shareBtn").textContent = "Couldn't copy";
  }
});

/** Spoiler-free result for sharing. */
function shareText(g) {
  const s = dailyStreak();
  const me = g.ranked && g.posted?.me;
  const parts = [
    fmt(Math.floor(g.elapsed)),
    g.mistakes ? plural(g.mistakes, "mistake") : "no mistakes",
    g.hints ? plural(g.hints, "hint") : "",
    me ? `#${me.rank} of ${me.total}` : "",
  ].filter(Boolean);
  return [
    `Killer Sudoku daily · ${dailyLabel(g.daily)}`,
    parts.join(" · "),
    s.current > 1 ? `🔥 ${s.current}-day streak` : "",
    location.origin + location.pathname,
  ].filter(Boolean).join("\n");
}

/** Show a saved or new game on the board. */
function loadGame(g) {
  // Leaving a duel that has started: stop listening (a chess clock keeps running on the server).
  if (duel && g.duel?.code !== duel.code && duel.view?.status !== "lobby") disconnectDuel();
  game = g;
  selected = -1; area = null; notesMode = false;
  for (const el of cells) delete el.dataset.key;
  setupCages();
  setPaused(false);
  save();
  render();
}

async function startNew(difficulty) {
  store.set(STORE.level, difficulty);
  $("loading").hidden = false;
  try {
    const puzzle = await takePuzzle(difficulty);
    store.set(STORE.mode, "normal");
    loadGame(newGameState(puzzle));
  } finally {
    $("loading").hidden = true;
  }
  prefetch(difficulty);
}

/** The unfinished normal game, if there is one. */
function savedNormal() {
  const g = store.get(STORE.game);
  return g && g.puzzle && g.status === "playing" ? g : null;
}

function resumeNormal() {
  const g = savedNormal();
  if (!g) return openNewDialog();
  store.set(STORE.mode, "normal");
  loadGame(g);
}

// ---------- Daily challenge ----------

const dailyStreak = () => streak(store.get(STORE.dailyDone), dailyDate());

/** Open today's daily: resume it, show the finished one, or build it. */
async function openDaily() {
  const today = dailyDate();
  const saved = store.get(STORE.daily);
  if (game?.daily === today) { if (game.status !== "playing") showEnd(game.status === "won"); return; }
  if (saved?.daily === today && saved.puzzle) {
    store.set(STORE.mode, "daily");
    loadGame(saved);
    if (saved.status !== "playing") showEnd(saved.status === "won");
    return;
  }
  $("loading").hidden = false;
  try {
    const puzzle = await requestPuzzle(DAILY_LEVEL, dailySeed(today));
    puzzle.hash = await lb.puzzleHash(puzzle);
    store.set(STORE.mode, "daily");
    loadGame({ ...newGameState(puzzle), daily: today, ranked: true });
  } finally {
    $("loading").hidden = true;
  }
}

/** Play the same daily again. Only the first run is ranked. */
function replayDaily() {
  const { puzzle, daily } = game;
  loadGame({ ...newGameState(puzzle), daily, ranked: false });
}

/**
 * Keep the streak on the server too: send the days it doesn't have yet, then
 * keep both lists. Quietly does nothing while offline; the next sync catches up.
 */
let streakSync = null;
function syncStreak() {
  const run = async () => {
    const local = store.get(STORE.dailyDone) || [];
    const known = new Set(store.get(STORE.daysSynced) || []);
    try {
      const { dates } = await lb.syncStreak(local.filter((d) => !known.has(d)));
      store.set(STORE.daysSynced, dates);
      store.set(STORE.dailyDone, mergeDays(store.get(STORE.dailyDone), dates));
      renderDailyBtn();
    } catch {}
  };
  // One at a time, so two syncs don't send the same days.
  streakSync = (streakSync || Promise.resolve()).then(run);
  return streakSync;
}

function renderDailyBtn() {
  const s = dailyStreak();
  const badge = $("dailyBadge");
  badge.textContent = s.current || "";
  badge.hidden = !s.current && s.solvedToday;
  badge.classList.toggle("todo", !s.solvedToday);
  $("dailyBtn").title = `Daily challenge${s.solvedToday ? " (solved)" : ""}${s.current ? ` · ${plural(s.current, "day")} streak` : ""}`;
}

function openNewDialog() {
  const cur = game?.duel ? "duel" : game?.daily ? "daily" : game?.puzzle.difficulty || store.get(STORE.level) || "medium";
  for (const b of $("newDialog").querySelectorAll(".levels button")) b.classList.toggle("current", b.value === cur);
  const s = dailyStreak();
  $("dailyPickNote").textContent = `${dailyLabel(dailyDate())}${s.solvedToday ? " · solved" : ""}`;
  const normal = (game?.daily || game?.duel) && savedNormal();
  $("resumeNormalBtn").hidden = !normal;
  if (normal) $("resumeNormalBtn").textContent = `Back to your ${LEVELS[normal.puzzle.difficulty]} game`;
  $("resumeDuelBtn").hidden = !!game?.duel || !savedDuelGame(true);
  const waiting = duel?.view?.status === "lobby";
  $("newDialog").querySelector(".duel-pick small").textContent = waiting ? "Waiting for your friend" : "Race or chess clock";
  $("newDialog").showModal();
}
$("newDialog").addEventListener("close", () => {
  const v = $("newDialog").returnValue;
  if (LEVELS[v]) startNew(v);
  else if (v === "daily") openDaily();
  else if (v === "resume") resumeNormal();
  else if (v === "duel") openDuelDialog();
  else if (v === "resumeDuel") resumeDuel();
});

// ---------- Duels ----------
//
// The server (one Durable Object per duel, rules in lib/duel.js) decides
// everything: when the duel starts, which digits count, the clocks and who won.
// This tab builds the board from the server's seed, sends moves and shows the
// state it gets back.

/**
 * The duel this tab is connected to, or null.
 * { code, token, seat, mode, level, clock, socket, view, ready, pending, rejected, seenAt, notice, offer, asked, building, outbox }
 */
let duel = null;

/** The saved duel game to go back to (`any`: also when the open game isn't a duel). */
function savedDuelGame(any = false) {
  if (!any && store.get(STORE.mode) !== "duel") return null;
  const g = store.get(STORE.duel);
  if (!g?.puzzle || !g.duel) return null;
  return any ? (g.status === "playing" && store.get(STORE.duelSession)?.code === g.duel.code ? g : null) : g;
}

const isDuelGame = () => !!game?.duel && game.duel.code === duel?.code;
/** The latest state of the duel on the board (live, or saved with the game). */
const duelState = () => (isDuelGame() && duel.view) || game?.duelLast || null;
const duelNow = () => (duel?.socket ? duel.socket.serverNow() : Date.now());
function duelStarted() {
  const v = isDuelGame() && duel.view;
  return !!v && v.status === "playing" && v.startAt != null && duelNow() >= v.startAt;
}
const opponentName = (v) => v?.players?.[1 - v.you]?.name || "Your opponent";

function connectDuel(session) {
  if (duel?.code === session.code && !duel.socket.closed) return duel;
  disconnectDuel();
  store.set(STORE.duelSession, session);
  const me = { ...session, view: null, ready: null, pending: null, rejected: null, seenAt: null, notice: null, offer: null, asked: false, building: false, outbox: [] };
  me.socket = new DuelSocket(session.code, session.token, {
    onState: (v) => { if (duel === me) onDuelState(v); },
    onMessage: (m) => { if (duel === me) onDuelMessage(m); },
    onStatus: (st) => {
      if (duel !== me) return;
      if (st === "online") for (const m of me.outbox.splice(0)) me.socket.send(m);
      if (isDuelGame()) render();
      renderDuelWait();
    },
  });
  duel = me;
  return me;
}

function disconnectDuel() {
  duel?.socket.close();
  duel = null;
}

/** Forget the current duel (it ended before it started, or is gone). */
function dropDuel() {
  disconnectDuel();
  store.del(STORE.duelSession);
}

/** Send a race move; while offline it waits, so a mistake still counts once back online. */
function duelSend(msg) { if (isDuelGame() && !duel.socket.send(msg)) duel.outbox.push(msg); }

function onDuelState(v) {
  const first = !duel.view;
  duel.view = v;
  if (first && v.last) duel.seenAt = v.last.at; // don't replay an old rejected digit after a reload
  if (v.status === "lobby") { renderDuelWait(); return; }
  if (v.status === "over" && !isDuelGame() && !duel.building) {
    // Ended before this tab had a board: cancelled, expired, or the boards didn't match.
    renderDuelWait();
    if (v.result?.reason === "mismatch") {
      $("duelDialog").close();
      duelEndDialog(v);
    }
    dropDuel();
    return;
  }
  if ($("duelDialog").open) $("duelDialog").close();
  const needBoard = !isDuelGame() || (v.status === "preparing" && !v.players[v.you].ready && !duel.ready);
  if (needBoard) buildDuelBoard(v);
  else applyDuelView(v);
}

function onDuelMessage(m) {
  if (m.type === "error") {
    duel.pending = null;
    duel.notice = { text: m.error, until: Date.now() + 3000 };
    if (isDuelGame()) render();
  } else if (m.type === "rematch") {
    duel.offer = { code: m.code, name: m.name };
    if (isDuelGame() && game.status !== "playing") duelEndDialog(duelState());
  } else if (m.type === "gone") {
    // The server deleted the duel (hours after it ended).
    const waiting = $("duelDialog").open && !$("duelWait").hidden;
    const onBoard = isDuelGame();
    dropDuel();
    if (waiting) {
      $("duelWaitText").lastChild.textContent = "This invite has expired.";
      $("duelWaitText").classList.add("done");
    }
    if (onBoard && game.status === "playing") {
      game.status = "ended";
      game.duelLast = { ...game.duelLast, status: "over", result: { winner: null, reason: "abandoned" } };
      save();
      render();
    }
  }
}

/** Build the duel's board from the server's seed (in the worker) and tell the server it's ready. */
async function buildDuelBoard(v) {
  if (duel.building) return;
  const me = duel;
  me.building = true;
  $("loading").hidden = false;
  try {
    const puzzle = await requestPuzzle(v.level, v.seed);
    puzzle.hash = await lb.puzzleHash(puzzle);
    if (duel !== me) return;
    me.ready = { type: "ready", hash: puzzle.hash, puzzle: { cages: puzzle.cages, givens: puzzle.givens, solution: puzzle.solution } };
    // On a shared board, the server checks every digit, so this tab doesn't keep the solution.
    const { solution, ...unsolved } = puzzle;
    const info = { code: me.code, token: me.token, seat: me.seat, mode: me.mode, level: me.level, clock: me.clock, perTurn: me.perTurn ?? null };
    store.set(STORE.mode, "duel");
    loadGame({ ...newGameState(me.mode === "chess" ? unsolved : puzzle), duel: info });
    applyDuelView(me.view);
  } catch {
    me.notice = { text: "Couldn't build the board. Reload the page to try again.", until: Infinity };
  } finally {
    me.building = false;
    $("loading").hidden = true;
  }
}

/** Bring the board in line with what the server says. */
function applyDuelView(v) {
  if (!isDuelGame()) return;
  const me = v.you;
  if (v.status === "preparing" && !v.players[me].ready && duel.ready) duel.socket.send(duel.ready);

  if (v.mode === "chess" && v.values) {
    for (let i = 0; i < 81; i++) {
      const d = v.values[i];
      if (!d || game.values[i] === d) continue;
      game.values[i] = d;
      game.notes[i] = 0;
      for (const j of peersOf(i)) game.notes[j] &= ~(1 << d);
      if (v.last?.cell === i) pop(i);
    }
    game.owner = v.owner;
    game.mistakes = v.players[me].mistakes;
    // My digit was answered once there's a new move (it may stay my turn), the turn passed, or the duel ended.
    const fresh = !!v.last && v.last.at !== duel.seenAt;
    if (fresh || v.turn !== me || v.status !== "playing") duel.pending = null;
    if (fresh) {
      duel.seenAt = v.last.at;
      // Turn alerts: a tick when the opponent places a digit, a low tone for any rejected
      // digit, and a buzz (phones that support it) when the turn comes back to me.
      const theirs = v.last.seat !== me;
      if (theirs || !v.last.ok) turnAlert(v.last.ok ? "move" : "wrong", theirs && v.status === "playing" && v.turn === me);
      if (!v.last.ok) {
        duel.rejected = { cell: v.last.cell, digit: v.last.digit, until: performance.now() + 1200 };
        setTimeout(() => { if (game) render(); }, 1250);
      }
    }
  } else if (v.mine) {
    // A race: take the server's digits (e.g. after playing on with a lost connection),
    // and send right digits the server hasn't got yet.
    for (let i = 0; i < 81; i++) {
      if (v.mine[i] && game.values[i] !== v.mine[i]) { game.values[i] = v.mine[i]; game.notes[i] = 0; }
      else if (!v.mine[i] && v.status === "playing" && game.values[i] && game.values[i] === game.puzzle.solution[i]) {
        duel.socket.send({ type: "move", cell: i, digit: game.values[i] });
      }
    }
    game.mistakes = Math.max(game.mistakes, v.players[me].mistakes);
  }

  game.duelLast = v;
  if (v.status === "over" && game.status === "playing") {
    const w = v.result?.winner;
    game.status = w === me ? "won" : w == null ? "draw" : "lost";
    area = null;
    save();
    render();
    duelEndDialog(v, w === me ? 350 : 0);
    return;
  }
  save();
  render();
}

/** A digit shown for a moment in an empty cell: my move on its way, or a rejected one. */
function duelTemp(i) {
  if (!game.duel || !duel) return null;
  if (duel.pending?.cell === i) return { kind: "pending", digit: duel.pending.digit };
  const r = duel.rejected;
  if (r?.cell === i && performance.now() < r.until) return { kind: "rejected", digit: r.digit };
  return null;
}

/** The digits the opponent placed in their last turn, while it's my move (chess clock). */
function duelLastTurn() {
  const v = game?.duel?.mode === "chess" ? duelState() : null;
  if (v?.status !== "playing" || v.turn !== v.you) return new Set();
  // Servers from before digits per turn only send `last`.
  if (v.prevTurn) return new Set(v.prevTurn.seat !== v.you ? v.prevTurn.cells : []);
  return new Set(v.last?.ok && v.last.seat !== v.you ? [v.last.cell] : []);
}

// ----- Turn alerts (chess clock): a short sound, and a buzz on phones that support it -----

const alertsOn = () => store.get(STORE.duelAlerts) !== false;
let audio = null;
/** Browsers only let a page start sound after a tap or key press, so get ready on the first one. */
function unlockAudio() {
  // Also while creating or joining a duel, so the first alert can already play.
  if (!(game?.duel || $("duelDialog").open) || !alertsOn()) return;
  try {
    audio ||= new AudioContext();
    if (audio.state === "suspended") audio.resume();
  } catch {}
}
addEventListener("pointerdown", unlockAudio, true);
addEventListener("keydown", unlockAudio, true);

/** "move": a soft high tick; "wrong": a low falling tone. `buzz` also vibrates. Made in the browser, no files. */
function turnAlert(kind, buzz = false) {
  if (!alertsOn()) return;
  if (buzz) try { navigator.vibrate?.([60, 40, 60]); } catch {}
  try {
    audio ||= new AudioContext();
    if (audio.state !== "running") return;
    const t = audio.currentTime;
    const [type, from, to, length, volume] = kind === "move" ? ["sine", 880, 660, 0.12, 0.12] : ["triangle", 240, 150, 0.25, 0.15];
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(from, t);
    osc.frequency.exponentialRampToValueAtTime(to, t + length);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(volume, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + length);
    osc.connect(gain).connect(audio.destination);
    osc.start(t);
    osc.stop(t + length + 0.02);
  } catch {}
}

$("duelAlerts").addEventListener("click", () => {
  const on = !alertsOn();
  store.set(STORE.duelAlerts, on);
  if (on) { unlockAudio(); audio?.resume().then(() => turnAlert("move")).catch(() => {}); }
  renderDuel();
});

function chessMove(i, d) {
  const v = duel.view;
  if (game.values[i] || duel.pending) return;
  if (v.turn !== v.you) { nudge($("duelStatus")); return; }
  if (!duel.socket.send({ type: "move", cell: i, digit: d })) {
    duel.notice = { text: "Reconnecting…", until: Date.now() + 2000 };
    render();
    return;
  }
  duel.pending = { cell: i, digit: d };
  render();
}

/** Resign (or cancel before the start). The first press asks; a second within 3 s resigns. */
let resignTimer = 0;
function resign() {
  const btn = $("resignBtn");
  if (!isDuelGame() || game.status !== "playing") return;
  if (!btn.classList.contains("confirm")) {
    btn.classList.add("confirm");
    btn.querySelector("span").textContent = "Sure?";
    clearTimeout(resignTimer);
    resignTimer = setTimeout(() => { btn.classList.remove("confirm"); btn.querySelector("span").textContent = "Resign"; }, 3000);
    return;
  }
  clearTimeout(resignTimer);
  btn.classList.remove("confirm");
  btn.querySelector("span").textContent = "Resign";
  if (!duel.socket.send({ type: "resign" })) { duel.notice = { text: "Reconnecting…", until: Date.now() + 2000 }; render(); }
}

/** Chess clock: 4:05, and tenths under 10 seconds (9.4). */
function fmtClock(ms) {
  if (ms > 0 && ms < 10_000) return (Math.floor(ms / 100) / 10).toFixed(1);
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** The duel bar (both players), the cover with the countdown, and the duel-only tools. */
function renderDuel() {
  const on = !!game?.duel;
  document.body.classList.toggle("in-duel", on);
  $("duelBar").hidden = !on;
  $("resignBtn").hidden = !on;
  $("hintBtn").hidden = on;
  if (!on) { $("duelCover").hidden = true; document.body.classList.remove("not-turn", "my-turn"); return; }

  const g = game.duel;
  const v = duelState();
  const live = isDuelGame();
  const now = duelNow();
  const me = g.seat;
  const chess = g.mode === "chess";
  const started = v?.status === "playing" && now >= v.startAt;
  $("duelBar").dataset.mode = g.mode;

  for (const [el, seat] of [[$("duelMe"), me], [$("duelThem"), 1 - me]]) {
    const p = v?.players?.[seat];
    el.querySelector(".duel-name").textContent = seat === me ? "You" : p?.name || "Opponent";
    el.classList.toggle("online", live && (seat === me ? duel.socket.online : !!p?.online));
    const m = p?.mistakes || 0;
    el.querySelector(".duel-meta").textContent = chess ? (m ? `${m} ✗` : "") : `${m}/${MAX_MISTAKES} ✗`;
    el.querySelector(".duel-meta").classList.toggle("danger", m > 0);
    const clock = el.querySelector(".duel-clock");
    if (chess) {
      const ms = v?.left ? clockLeft(v, seat, now) : null;
      clock.textContent = ms == null ? "–:––" : fmtClock(ms);
      clock.classList.toggle("low", ms != null && ms < 20_000 && v.status === "playing");
      el.classList.toggle("turn", started && v.turn === seat);
    } else {
      const total = v?.total ?? game.puzzle.givens.filter((x) => !x).length;
      const filled = seat === me
        ? game.values.reduce((n, x, i) => n + (x && !isGiven(i) && isCorrect(i) ? 1 : 0), 0)
        : p?.filled || 0;
      clock.textContent = `${filled}/${total}`;
      el.querySelector(".duel-progress i").style.width = `${total ? (100 * filled) / total : 0}%`;
      el.classList.remove("turn");
    }
  }
  document.body.classList.toggle("not-turn", chess && started && v.turn !== me);
  document.body.classList.toggle("my-turn", chess && started && v.turn === me);
  $("duelAlerts").hidden = !chess;
  $("duelAlerts").setAttribute("aria-pressed", alertsOn());

  // Status line under the players.
  let status = "";
  const them = opponentName(v);
  if (duel?.notice && Date.now() < duel.notice.until) status = duel.notice.text;
  else if (!v) status = live ? "Connecting…" : "";
  else if (v.status === "over") status = game.status === "won" ? "You won" : game.status === "draw" ? "Draw" : v.result?.winner == null ? "Duel ended" : `${them} won`;
  else if (live && !duel.socket.online) status = "Reconnecting…";
  else if (v.status === "preparing") status = v.players[1 - me]?.ready ? "Getting ready…" : `Waiting for ${them}…`;
  else if (!started) status = "Get ready";
  else if (chess) {
    const l = v.last;
    if (l && !l.ok && now - l.at < 3000) status = l.seat === me ? "Wrong digit · −15 s" : `${them} placed a wrong digit · −15 s`;
    else {
      status = v.turn === me ? "Your move" : `${them}’s move`;
      const per = v.perTurn || 1;
      if (per > 1) status += ` · ${plural(per - (v.placed || 0), "digit")} to go`;
    }
  } else status = `${LEVELS[g.level]} race · ${fmt(Math.max(0, Math.floor((now - v.startAt) / 1000)))}`;
  $("duelStatus").textContent = status;

  // Cover over the board until the start: the board is hidden until both can see it.
  let cover = "";
  if (!v || v.status === "preparing") cover = status || "Getting ready…";
  else if (v.status === "playing" && !started) cover = String(Math.max(1, Math.ceil((v.startAt - now) / 1000)));
  $("duelCover").hidden = !cover;
  $("duelCover").classList.toggle("count", /^\d$/.test(cover));
  if ($("duelCoverText").textContent !== cover) $("duelCoverText").textContent = cover;
}

// ----- Duel dialog: set up, wait for a friend, join -----

function duelView(id) {
  for (const v of ["duelSetup", "duelWait", "duelJoin"]) $(v).hidden = v !== id;
}
const duelSummary = ({ mode, level, clock, perTurn }) =>
  [MODE_NAMES[mode], LEVELS[level], mode === "chess" && clock ? clock.replace("+", " + ") : "", mode === "chess" && perTurn > 1 ? `${perTurn} digits per turn` : ""]
    .filter(Boolean).join(" · ");

function duelMsg(id, text, isError = true) {
  const el = $(id);
  el.textContent = text;
  el.hidden = !text;
  el.classList.toggle("error", isError);
}

function openDuelDialog() {
  if (duel?.view?.status === "lobby") { renderDuelWait(); duelView("duelWait"); $("duelDialog").showModal(); return; }
  const prefs = store.get(STORE.duelPrefs) || {};
  const form = $("duelSetup");
  for (const [name, val] of [["mode", prefs.mode || "classic"], ["level", prefs.level || store.get(STORE.level) || "medium"], ["clock", prefs.clock || DEFAULT_CLOCK], ["perTurn", prefs.perTurn || 1]]) {
    const input = form.querySelector(`input[name="${name}"][value="${val}"]`);
    if (input) input.checked = true;
  }
  showChessOptions(form.elements.mode.value === "chess");
  $("duelNameField").hidden = !!lb.getName();
  form.elements.name.value = "";
  $("duelCodeInput").value = "";
  duelMsg("duelMsg", "");
  duelView("duelSetup");
  $("duelDialog").showModal();
}

/** Clock and digits per turn only apply to the chess clock. */
function showChessOptions(on) {
  $("duelClocks").hidden = !on;
  $("duelPerTurn").hidden = !on;
}
$("duelSetup").addEventListener("change", (e) => {
  if (e.target.name === "mode") showChessOptions(e.target.value === "chess");
});

/** Take the name from a dialog's name field if it's shown. False if one is needed. */
function takeName(form, msgId) {
  if (lb.getName()) return true;
  const name = form.elements.name.value.trim();
  if (!name) { duelMsg(msgId, "Please enter a name."); form.elements.name.focus(); return false; }
  lb.setName(name);
  return true;
}

$("duelSetup").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = $("duelSetup");
  if (!takeName(form, "duelMsg")) return;
  const settings = { mode: form.elements.mode.value, level: form.elements.level.value, clock: form.elements.clock.value, perTurn: Number(form.elements.perTurn.value) };
  store.set(STORE.duelPrefs, settings);
  const btn = $("duelCreate");
  btn.disabled = true;
  duelMsg("duelMsg", "");
  try {
    const r = await createDuel(settings);
    if (duel?.view?.status === "lobby") duel.socket.send({ type: "resign" }); // replace an older invite
    const chess = settings.mode === "chess";
    connectDuel({ code: r.code, token: r.token, seat: r.seat, ...settings, clock: chess ? settings.clock : null, perTurn: chess ? settings.perTurn : null });
    renderDuelWait();
    duelView("duelWait");
  } catch (err) {
    duelMsg("duelMsg", err.status ? err.message : offline);
  } finally {
    btn.disabled = false;
  }
});

function joinFromInput() {
  const code = readDuelCode($("duelCodeInput").value);
  if (!code) { duelMsg("duelMsg", "Codes look like ABC-DEF."); $("duelCodeInput").focus(); return; }
  showJoin(code);
}
$("duelJoinCode").addEventListener("click", joinFromInput);
$("duelCodeInput").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); joinFromInput(); } });

function renderDuelWait() {
  if (!duel) return;
  $("duelCode").textContent = showDuelCode(duel.code);
  $("duelWaitSummary").textContent = duelSummary(duel);
  const v = duel.view;
  const text = v?.status === "over" ? (v.result?.reason === "expired" ? "This invite has expired." : "This duel was cancelled.")
    : !duel.socket.online && v ? "Reconnecting…"
    : "Waiting for your friend…";
  $("duelWaitText").lastChild.textContent = text;
  $("duelWaitText").classList.toggle("done", v?.status === "over");
}

/** Copy (or on phones, share) an invite; the button says how it went for a moment. */
async function copyText(btn, text, share = false) {
  const label = btn.querySelector("span");
  const say = (words) => {
    label.textContent = words;
    clearTimeout(btn.resetTimer);
    btn.resetTimer = setTimeout(() => { label.textContent = btn.dataset.label; }, 1600);
  };
  btn.dataset.label ||= label.textContent;
  try {
    if (share && navigator.share && matchMedia("(hover: none)").matches) {
      await navigator.share({ text: `Duel me in Killer Sudoku: ${text}` });
      return;
    }
    await navigator.clipboard.writeText(text);
    say("Copied");
  } catch (err) {
    if (err?.name !== "AbortError") say("Couldn't copy");
  }
}
$("duelCopyLink").addEventListener("click", (e) => duel && copyText(e.currentTarget, duelLink(duel.code), true));
$("duelCopyCode").addEventListener("click", (e) => duel && copyText(e.currentTarget, showDuelCode(duel.code)));
$("duelCancel").addEventListener("click", () => {
  if (duel?.view?.status === "lobby") duel.socket.send({ type: "resign" });
  dropDuel();
  $("duelDialog").close();
});
$("duelDialog").addEventListener("click", (e) => { if (e.target.closest("[data-close]")) $("duelDialog").close(); });

/** The join view for a code from a link or typed in. */
let joining = null; // { code, info }
async function showJoin(code) {
  if (duel?.code === code) {
    // Already in this duel (e.g. the invite link opened again).
    if (duel.view?.status === "lobby") { renderDuelWait(); duelView("duelWait"); if (!$("duelDialog").open) $("duelDialog").showModal(); }
    else if (!isDuelGame()) resumeDuel();
    return;
  }
  joining = { code, info: null };
  duelView("duelJoin");
  $("duelJoinText").textContent = "Looking up the duel…";
  $("duelJoinNameField").hidden = !!lb.getName();
  $("duelJoin").elements.name.value = "";
  $("duelJoinBtn").disabled = true;
  duelMsg("duelJoinMsg", "");
  if (!$("duelDialog").open) $("duelDialog").showModal();
  try {
    const info = await duelInfo(code);
    if (joining?.code !== code) return;
    joining.info = info;
    const per = info.perTurn || 1;
    const how = info.mode === "chess"
      ? `One shared board: take turns placing ${per === 1 ? "a digit" : `${per} digits`} while your clock runs. A wrong digit costs 15 seconds and ends your turn. Most time left at the end wins.`
      : "You each get the same board. First to solve it wins; three mistakes and you're out.";
    $("duelJoinText").textContent = `${info.host} invites you to a duel: ${duelSummary(info)}. ${how}`;
    if (info.status === "over") duelMsg("duelJoinMsg", "This duel has ended.");
    else if (info.full) duelMsg("duelJoinMsg", "This duel already has two players.");
    $("duelJoinBtn").disabled = info.status === "over";
  } catch (err) {
    if (joining?.code !== code) return;
    $("duelJoinText").textContent = err.status === 404 ? "This duel doesn't exist or has expired." : offline;
  }
}

$("duelJoin").addEventListener("submit", async (e) => {
  e.preventDefault();
  const j = joining;
  if (!j?.info || !takeName($("duelJoin"), "duelJoinMsg")) return;
  const btn = $("duelJoinBtn");
  btn.disabled = true;
  duelMsg("duelJoinMsg", "");
  try {
    const r = await joinDuel(j.code);
    if (duel?.view?.status === "lobby") duel.socket.send({ type: "resign" }); // our own invite isn't needed now
    connectDuel({ code: j.code, token: r.token, seat: r.seat, mode: j.info.mode, level: j.info.level, clock: j.info.clock, perTurn: j.info.perTurn ?? null });
    duelMsg("duelJoinMsg", "Joined. Building the board…", false);
  } catch (err) {
    duelMsg("duelJoinMsg", err.status ? err.message : offline);
    btn.disabled = false;
  }
});

/** A #duel=CODE invite link: show who is inviting and offer to join. */
function openDuelLink() {
  const m = location.hash.match(/^#duel=([A-Za-z0-9-]{6,8})$/);
  if (!m) return;
  history.replaceState(null, "", location.pathname + location.search);
  const code = readDuelCode(m[1]);
  if (code) showJoin(code);
}

function resumeDuel() {
  const g = savedDuelGame(true) || savedDuelGame();
  const session = store.get(STORE.duelSession);
  if (!g || session?.code !== g.duel.code) return openNewDialog();
  store.set(STORE.mode, "duel");
  connectDuel(session);
  loadGame(g);
}

// ----- End of a duel -----

function duelEndDialog(v, delay = 0) {
  if (!v?.result) return;
  const { winner, reason, time } = v.result;
  const me = v.you;
  const them = opponentName(v);
  const won = winner === me;
  const left = v.left ? ` You had ${fmtClock(v.left[me])} left, ${them} had ${fmtClock(v.left[1 - me])}.` : "";
  const texts = {
    solved: `${won ? "You" : them} solved it first, in ${fmt(Math.round((time || 0) / 1000))}.`,
    mistakes: won ? `${them} made three mistakes.` : "Three mistakes. That's the limit in a race.",
    complete: `The board is full.${left}`,
    timeout: won ? `${them} ran out of time.` : "You ran out of time.",
    resign: won ? `${them} resigned.` : "You resigned.",
    mismatch: "Your two devices built different boards from the same duel. Reload the page on both and start a new duel.",
    cancelled: "The duel was cancelled.",
    expired: "The invite expired before the duel started.",
    abandoned: "Nobody finished within a day.",
  };
  $("endTitle").textContent = winner == null ? (reason === "complete" ? "Draw" : "Duel over") : won ? "You won" : `${them} won`;
  $("endText").textContent = texts[reason] || "";
  $("lbForm").hidden = true;
  $("shareBtn").hidden = true;
  $("continueBtn").hidden = true;
  $("replayBtn").hidden = true;
  const canRematch = isDuelGame() && v.players.length === 2 && reason !== "mismatch";
  const btn = $("rematchBtn");
  btn.hidden = !canRematch;
  btn.textContent = duel?.offer ? "Accept rematch" : duel?.asked ? "Rematch sent" : "Rematch";
  btn.disabled = !duel?.offer && !!duel?.asked;
  lbStatus(canRematch && duel.offer ? `${escapeHtml(duel.offer.name)} wants a rematch.` : "");
  $("endDialog").returnValue = "";
  setTimeout(() => { if (!$("endDialog").open) $("endDialog").showModal(); }, delay);
}

/** Accept the other player's rematch, or offer one: a new duel with the same settings. */
async function rematch() {
  const old = duel;
  if (!old || !isDuelGame()) return;
  if (old.offer) { await showJoin(old.offer.code); return; }
  const settings = { mode: old.mode, level: old.level, clock: old.clock || DEFAULT_CLOCK, perTurn: old.perTurn || 1 };
  try {
    const r = await createDuel(settings);
    old.asked = true;
    old.socket.send({ type: "rematch", code: r.code });
    connectDuel({ code: r.code, token: r.token, seat: r.seat, mode: settings.mode, level: settings.level, clock: old.clock, perTurn: old.perTurn ?? null });
    renderDuelWait();
    $("duelWaitText").lastChild.textContent = `Rematch offered. Waiting for ${opponentName(game.duelLast)}…`;
    duelView("duelWait");
    $("duelDialog").showModal();
  } catch (err) {
    lbStatus(escapeHtml(err.status ? err.message : offline), true);
    $("endDialog").showModal();
  }
}

// ---------- Other devices (sync codes and passkeys) ----------

const showCode = (code) => `${code.slice(0, 4)}-${code.slice(4)}`;
const syncLink = (code) => `${location.origin}${location.pathname}#sync=${code}`;
/** A typed or pasted code as ABCD-EFGH when it has the right length, else as typed. */
const tidyCode = (raw) => {
  const c = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return c.length === 8 ? showCode(c) : raw.trim();
};
const offline = "Couldn't reach the server. Check your connection and try again.";
const CHECK_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>`;

// Motion: short, ease-out, transform and opacity (plus a 2px blur to soften swaps).
// WAAPI rather than keyframes, so a newer animation simply replaces an older one.
// With reduced motion, things only fade.
const EASE_OUT = "cubic-bezier(0.23, 1, 0.32, 1)";
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");

/** Animate `el` in from a small offset, scale or blur. */
function enter(el, { x = 0, y = 0, scale = 1, blur = 0, delay = 0, duration = 200 } = {}) {
  if (!el?.animate) return;
  const still = { opacity: 1, transform: "none", filter: "none" };
  const from = reduceMotion.matches
    ? { opacity: 0 }
    : { opacity: 0, transform: `translate(${x}px, ${y}px) scale(${scale})`, filter: blur ? `blur(${blur}px)` : "none" };
  el.animate([from, reduceMotion.matches ? { opacity: 1 } : still], { duration, delay, easing: EASE_OUT, fill: "backwards" });
}

/** A small horizontal shake for a rejected entry. */
function nudge(el) {
  if (reduceMotion.matches || !el?.animate) return;
  el.animate(
    [{ transform: "none" }, { transform: "translateX(-4px)" }, { transform: "translateX(4px)" }, { transform: "translateX(-2px)" }, { transform: "none" }],
    { duration: 280, easing: "ease-out" },
  );
}

/** Show a spinner in place of a button's icon while its request runs. */
function busy(btn, on) {
  if (on && !btn.querySelector(".spin")) btn.insertAdjacentHTML("afterbegin", `<span class="spin" aria-hidden="true"></span>`);
  btn.disabled = on;
  btn.classList.toggle("busy", on);
  btn.setAttribute("aria-busy", on);
}

/** This player's current code: { code, player, expires (ms) }, kept while the page is open. */
let myCode = null;
let codeLoading = false;
let codeTimer = 0;
/** The code being confirmed on the merge screen. */
let pendingCode = null;
/** The code the tiles show, so only a new code gets the reveal. */
let shownCode = null;

function statusLine(id, text, kind = "") {
  const el = $(id);
  const changed = text && (el.hidden || el.innerHTML !== text);
  el.hidden = !text;
  el.className = `sync-status ${kind}`.trim();
  el.innerHTML = text || "";
  if (changed) enter(el, { y: -4, blur: 2 });
}
const syncStatus = (text, kind) => statusLine("syncStatus", text, kind);
const mergeStatus = (text, kind) => statusLine("mergeStatus", text, kind);

/** Switch screens. `dir` 1 slides the new one in from the right (forward), -1 from the left (back). */
function syncView(name, dir = 0) {
  const next = $(name === "main" ? "syncMain" : "syncMerge");
  const was = next.hidden;
  $("syncMain").hidden = name !== "main";
  $("syncMerge").hidden = name !== "merge";
  if (was && dir) enter(next, { x: 16 * dir, blur: 2, duration: 220 });
}

/** `code` comes from a sync link: go straight to the merge screen for it. */
function openSync(code = "") {
  syncView("main");
  syncStatus("");
  $("syncInput").value = "";
  renderPasskey();
  if ($("boardDialog").open) $("boardDialog").close();
  if (!$("syncDialog").open) $("syncDialog").showModal();
  loadCode();
  if (code) {
    $("syncInput").value = tidyCode(code);
    reviewCode($("syncInput").value);
  }
}
$("syncDialog").addEventListener("close", () => { clearInterval(codeTimer); codeTimer = 0; });

function renderCode(error = "") {
  const code = myCode?.code;
  const chars = code ? [...code] : Array(8).fill("");
  const tile = (c) => `<span class="sync-tile">${escapeHtml(c)}</span>`;
  const tiles = $("syncTiles");
  tiles.innerHTML = `${chars.slice(0, 4).map(tile).join("")}<span class="sync-dash"></span>${chars.slice(4).map(tile).join("")}`;
  tiles.setAttribute("aria-label", code ? `Your code: ${showCode(code)}` : "Getting a code");
  tiles.classList.toggle("waiting", !code);
  tiles.hidden = !!error;
  $("syncCodeMsg").hidden = !error;
  $("syncCodeMsg").textContent = error;
  $("syncCopyRow").hidden = !!error;
  $("syncRetry").hidden = !error;
  $("syncCopyCode").disabled = $("syncCopyLink").disabled = !code;
  $("syncTimer").hidden = !code;
  $("syncRefresh").hidden = !!error;
  $("syncRefresh").disabled = !code;
  // A new code: the characters come in one after another.
  if (code && code !== shownCode) {
    tiles.querySelectorAll(".sync-tile, .sync-dash").forEach((t, i) => enter(t, { y: 6, blur: 2, delay: i * 30, duration: 220 }));
  }
  shownCode = code || null;
  if (error) enter($("syncCodeMsg"), { y: -4 });
}

/** Count down the code's 15 minutes; get a new one when it runs out. */
function tick() {
  if (!myCode) return;
  const left = Math.max(0, Math.round((myCode.expires - Date.now()) / 1000));
  $("syncTimerText").textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
  $("syncTimer").classList.toggle("ending", left <= 60);
  if (!left) { myCode = null; loadCode(); }
}

/**
 * Show this player's code, reusing the current one while it has more than a minute left.
 * `renew` always gets a new one (the server then cancels the old code).
 */
async function loadCode(renew = false) {
  clearInterval(codeTimer);
  codeTimer = setInterval(tick, 1000);
  const fresh = !renew && myCode && myCode.player === lb.playerId() && myCode.expires - Date.now() > 60000;
  if (!fresh) {
    myCode = null;
    renderCode();
    if (codeLoading) return;
    codeLoading = true;
    try {
      await syncStreak(); // so the other device gets every day
      const { code, expires } = await lb.makeSyncCode(renew);
      myCode = { code, player: lb.playerId(), expires: Date.now() + expires * 1000 };
    } catch (e) {
      clearInterval(codeTimer);
      renderCode(e.status ? e.message : "Couldn't get a code. Check your connection.");
      return;
    } finally {
      codeLoading = false;
    }
  }
  renderCode();
  tick();
}
$("syncRetry").addEventListener("click", () => loadCode());

// A code works once: after another device used it, get a new one here.
$("syncRefresh").addEventListener("click", () => {
  const icon = $("syncRefresh").querySelector("svg");
  if (!reduceMotion.matches) icon.animate([{ transform: "rotate(0)" }, { transform: "rotate(360deg)" }], { duration: 450, easing: EASE_OUT });
  syncStatus("");
  loadCode(true);
});

/** Swap a button's label for a moment ("Copied"), crossfading the label and icon with a slight blur. */
function flash(btn, text) {
  const label = btn.querySelector("span");
  const set = (copied, words) => {
    btn.classList.toggle("copied", copied);
    label.textContent = words;
    enter(label, { blur: 2, duration: 180 });
    enter(btn.querySelector(copied ? ".i-done" : ".i-idle"), { scale: 0.9, blur: 2, duration: 180 });
  };
  set(text === "Copied", text);
  clearTimeout(btn.flashTimer);
  btn.flashTimer = setTimeout(() => set(false, btn.dataset.label), 1600);
}

$("syncCopyCode").addEventListener("click", async () => {
  if (!myCode) return;
  try { await navigator.clipboard.writeText(showCode(myCode.code)); flash($("syncCopyCode"), "Copied"); }
  catch { flash($("syncCopyCode"), "Couldn't copy"); }
});

$("syncCopyLink").addEventListener("click", async () => {
  if (!myCode) return;
  const url = syncLink(myCode.code);
  try {
    if (navigator.share && matchMedia("(hover: none)").matches) { await navigator.share({ url }); return; }
    await navigator.clipboard.writeText(url);
    flash($("syncCopyLink"), "Copied");
  } catch (e) {
    if (e?.name !== "AbortError") flash($("syncCopyLink"), "Couldn't copy");
  }
});

/** Check a code and show what linking would do, before anything changes. */
async function reviewCode(raw) {
  const btn = $("syncGo");
  busy(btn, true);
  syncStatus("");
  try {
    await syncStreak(); // count this device's newest days too
    const p = await lb.previewSyncCode(raw);
    if (p.same) {
      syncStatus("That's this device's own code. Enter it on your other device.", "error");
      nudge($("syncInput").parentElement);
      return;
    }
    pendingCode = raw;
    renderMerge(p, tidyCode(raw));
    mergeStatus("");
    syncView("merge", 1);
    // The parts of the sum arrive in reading order.
    const parts = [".merge-pair", ".merge-down", ".merge-result"].map((sel) => $("syncMerge").querySelector(sel));
    parts.forEach((el, i) => enter(el, { y: 6, scale: i === 2 ? 0.98 : 1, delay: 60 + i * 50, duration: 240 }));
    $("mergeGo").focus({ preventScroll: true });
  } catch (e) {
    syncStatus(e.status ? escapeHtml(e.message) : offline, "error");
    if (e.status) nudge($("syncInput").parentElement);
  } finally {
    busy(btn, false);
  }
}

function renderMerge(p, code) {
  $("mergeGo").querySelector("span:not(.spin)").textContent = "Merge & link";
  const stat = (id, n, one, many) => { $(id).textContent = n; $(`${id}L`).textContent = n === 1 ? one : many; };
  for (const [prefix, c] of [["mDev", p.device], ["mPl", p.player], ["mAll", p.merged]]) {
    stat(`${prefix}Times`, c.times, "time", "times");
    stat(`${prefix}Days`, c.days, "day", "days");
  }
  $("mergeCode").textContent = code;
}

$("syncForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const code = $("syncInput").value.trim();
  if (code) reviewCode(code);
});
$("syncInput").addEventListener("blur", () => { $("syncInput").value = tidyCode($("syncInput").value); });

function backToMain() {
  pendingCode = null;
  syncView("main", -1);
  $("syncInput").focus();
}
$("mergeBack").addEventListener("click", backToMain);
$("mergeCancel").addEventListener("click", backToMain);

$("mergeGo").addEventListener("click", async () => {
  if (!pendingCode) return;
  const btn = $("mergeGo");
  busy(btn, true);
  $("mergeBack").disabled = $("mergeCancel").disabled = true;
  mergeStatus("");
  let party = null;
  try {
    const r = await lb.useSyncCode(pendingCode);
    party = celebrateMerge(); // only once the server has really merged
    const msg = await adoptPlayer(r);
    await party.done;
    pendingCode = null;
    $("syncInput").value = "";
    syncView("main", -1);
    party.reset();
    syncStatus(msg, "ok");
  } catch (e) {
    party?.reset();
    mergeStatus(e.status ? escapeHtml(e.message) : offline, "error");
  } finally {
    busy(btn, false);
    btn.classList.remove("done");
    $("mergeBack").disabled = $("mergeCancel").disabled = false;
  }
});

/**
 * The merge, shown: the two cards fly into the total, which pops with a ring
 * and a burst of sparks while its numbers bounce; the button turns "Linked".
 * A rare moment, so it may take a little over a second. Reduced motion: none of it.
 * Each step starts when the previous animation finishes (not on timers), so it stays in step under load.
 * Returns { done, reset }: `done` resolves when it's over, `reset` puts the screen back.
 */
function celebrateMerge() {
  const root = $("syncMerge");
  const anims = [];
  const extras = [];
  const reset = () => { anims.forEach((a) => a.cancel()); extras.forEach((e) => e.remove()); };
  if (reduceMotion.matches || !root.animate) return { done: Promise.resolve(), reset };

  const run = (el, frames, opts) => { const a = el.animate(frames, { fill: "forwards", ...opts }); anims.push(a); return a; };
  const btn = $("mergeGo");
  btn.classList.remove("busy"); // the server has answered; the button waits for the show
  btn.classList.add("done");
  const result = root.querySelector(".merge-result");
  const icon = root.querySelector(".merge-result-icon");
  const target = result.getBoundingClientRect();
  const tx = target.left + target.width / 2;
  const ty = target.top + target.height / 2;
  const FLIGHT = 380;

  // 1. The "+" and the arrow step aside; both cards fly into the total and are absorbed.
  for (const sel of [".merge-plus", ".merge-down"]) {
    run(root.querySelector(sel), [{ opacity: 1 }, { opacity: 0, transform: "scale(0.6)" }], { duration: 150, easing: EASE_OUT });
  }
  const flights = [...root.querySelectorAll(".merge-card")].map((card, i) => {
    const r = card.getBoundingClientRect();
    const dx = tx - (r.left + r.width / 2);
    const dy = ty - (r.top + r.height / 2);
    return run(card, [
      { transform: "none", opacity: 1 },
      { transform: `translate(${dx * 0.3}px, ${dy * 0.15 - 6}px) scale(0.92)`, opacity: 1, offset: 0.35 },
      { transform: `translate(${dx}px, ${dy}px) scale(0.35)`, opacity: 0 },
    ], { duration: FLIGHT - 40 * i, delay: 40 * i, easing: "cubic-bezier(0.77, 0, 0.175, 1)" });
  });

  // 2. Impact: the total pops (slight overshoot), a ring pulses out, sparks burst, numbers count up.
  const impact = () => {
    run(result, [{ transform: "scale(1)" }, { transform: "scale(1.045)", offset: 0.35 }, { transform: "scale(1)" }],
      { duration: 480, easing: "cubic-bezier(0.34, 1.56, 0.64, 1)" });
    run(icon, [{ transform: "none" }, { transform: "scale(1.18) rotate(-10deg)", offset: 0.4 }, { transform: "none" }],
      { duration: 500, easing: "cubic-bezier(0.34, 1.56, 0.64, 1)" });

    const ring = document.createElement("span");
    ring.className = "merge-ring";
    result.append(ring);
    extras.push(ring);
    const pulse = run(ring, [{ transform: "scale(1)", opacity: 0.7 }, { transform: "scale(1.08, 1.25)", opacity: 0 }], { duration: 560, easing: EASE_OUT });

    const colors = ["var(--accent)", "var(--warm)", "var(--ok)"];
    for (let i = 0; i < 12; i++) {
      const spark = document.createElement("span");
      spark.className = "merge-spark";
      spark.style.background = colors[i % 3];
      icon.append(spark);
      extras.push(spark);
      const angle = (i / 12) * Math.PI * 2 + (Math.random() - 0.5) * 0.4;
      const dist = 30 + Math.random() * 22;
      run(spark, [
        { transform: "translate(-50%, -50%) scale(1)", opacity: 1 },
        { transform: `translate(calc(-50% + ${Math.cos(angle) * dist}px), calc(-50% + ${Math.sin(angle) * dist}px)) scale(0)`, opacity: 0.9 },
      ], { duration: 520 + Math.random() * 160, easing: EASE_OUT });
    }

    // The total already shows the merged numbers; they bounce as the cards land in them.
    [$("mAllTimes"), $("mAllDays")].forEach((n, i) => {
      run(n, [{ transform: "none" }, { transform: "translateY(-3px) scale(1.18)", offset: 0.4 }, { transform: "none" }],
        { duration: 420, delay: 60 * i, easing: "cubic-bezier(0.34, 1.56, 0.64, 1)" });
    });

    btn.querySelector("span:not(.spin)").textContent = "Linked";
    enter(btn.querySelector("span:not(.spin)"), { blur: 2, duration: 180 });
    navigator.vibrate?.(12);
    // 3. A short beat on the finished total before leaving the screen.
    return pulse.finished.then(() => run(result, [{ opacity: 1 }, { opacity: 1 }], { duration: 260 }).finished);
  };

  const done = Promise.all(flights.map((a) => a.finished)).then(impact).catch(() => {}); // cancelled: just end
  return { done, reset };
}

/** After a sync code or passkey: take over the player's days, push this device's own, and say who we are now. */
async function adoptPlayer(r) {
  store.set(STORE.daysSynced, r.dates);
  store.set(STORE.dailyDone, mergeDays(store.get(STORE.dailyDone), r.dates));
  store.set(STORE.passkey, r.passkeys ? 1 : 0);
  myCode = null; // it was for the player this device used to be
  await syncStreak();
  renderDailyBtn();
  renderPasskey();
  loadCode();
  lb.retryPending();
  const s = dailyStreak();
  const who = r.name ? ` You're playing as <b>${escapeHtml(r.name)}</b>` : " This device is linked";
  return `Done.${who}${s.current ? ` with a ${s.current}-day streak` : ""}.`;
}

/** A failed passkey prompt: say nothing when the player just closed it. */
function passkeyError(e, fallback) {
  if (e?.name === "NotAllowedError" || e?.name === "AbortError") return syncStatus("");
  if (e?.name === "InvalidStateError") return syncStatus("This password manager already has a passkey for you.");
  syncStatus(e?.status ? escapeHtml(e.message) : fallback, "error");
}

function renderPasskey() {
  const saved = !!store.get(STORE.passkey);
  const changed = saved !== $("passkeyBox").classList.contains("saved") && $("pkState").textContent !== "";
  $("passkeyBox").hidden = !passkeysSupported();
  $("passkeyBox").classList.toggle("saved", saved);
  $("pkState").innerHTML = saved ? `${CHECK_SVG}Saved` : "Not saved yet";
  const label = saved ? "Save another passkey" : "Save a passkey";
  $("pkSave").setAttribute("aria-label", label);
  $("pkSave").title = label;
  if (changed) enter($("pkState"), { y: 4, blur: 2 });
}

$("pkSave").addEventListener("click", async () => {
  busy($("pkSave"), true);
  syncStatus("");
  try {
    await savePasskey();
    store.set(STORE.passkey, 1);
    renderPasskey();
    syncStatus("Passkey saved. On another device, tap Sign in.", "ok");
  } catch (e) {
    passkeyError(e, "Couldn't save the passkey. Check your connection and try again.");
  } finally {
    busy($("pkSave"), false);
  }
});

$("pkSignIn").addEventListener("click", async () => {
  busy($("pkSignIn"), true);
  syncStatus("");
  try {
    syncStatus(await adoptPlayer(await signInWithPasskey()), "ok");
  } catch (e) {
    passkeyError(e, "Couldn't sign in. Check your connection and try again.");
  } finally {
    busy($("pkSignIn"), false);
  }
});

document.addEventListener("click", (e) => {
  if (e.target.closest("[data-open-sync]")) openSync();
});

// ---------- Selection and area dragging ----------

/** The row, column or box holding both cells (row, then column, then box), or null. */
function sharedUnit(a, b) {
  const u =
    rowOf(a) === rowOf(b) ? { type: "row", index: rowOf(a) } :
    colOf(a) === colOf(b) ? { type: "col", index: colOf(a) } :
    boxOf(a) === boxOf(b) ? { type: "box", index: boxOf(a) } : null;
  return u && { ...u, cells: unitCells(u.type, u.index) };
}

/** The unit containing `start` that covers most of `list` (row, then column, then box on ties). */
function unitFor(start, list) {
  const options = [
    ["row", rowOf(start), (i) => rowOf(i) === rowOf(start)],
    ["col", colOf(start), (i) => colOf(i) === colOf(start)],
    ["box", boxOf(start), (i) => boxOf(i) === boxOf(start)],
  ];
  let best = null, bestN = 1;
  for (const [type, index, test] of options) {
    const n = list.filter(test).length;
    if (n > bestN) { best = { type, index }; bestN = n; }
  }
  return best ? { ...best, cells: unitCells(best.type, best.index) } : null;
}

const cellAt = (x, y) => {
  const el = document.elementFromPoint(x, y)?.closest?.(".cell");
  return el && board.contains(el) ? +el.dataset.i : -1;
};

let drag = null; // { start, visited:Set, pointerId }

board.addEventListener("pointerdown", (e) => {
  if (!game || paused) return;
  const i = cellAt(e.clientX, e.clientY);
  if (i < 0) return;
  e.preventDefault();

  // Desktop: shift-click marks the unit shared with the selected cell.
  if (e.shiftKey && selected >= 0 && selected !== i) {
    area = sharedUnit(selected, i);
    areaFocus = area ? i : -1;
    render();
    return;
  }

  selected = i;
  area = null;
  areaFocus = -1;
  drag = { start: i, visited: [i], pointerId: e.pointerId };
  board.setPointerCapture(e.pointerId);
  render();
});

board.addEventListener("pointermove", (e) => {
  if (!drag || e.pointerId !== drag.pointerId) return;
  const i = cellAt(e.clientX, e.clientY);
  if (i < 0 || drag.visited.includes(i)) return;
  drag.visited.push(i);
  area = unitFor(drag.start, drag.visited);
  render();
});

const endDrag = (e) => {
  if (!drag || e.pointerId !== drag.pointerId) return;
  drag = null;
};
board.addEventListener("pointerup", endDrag);
board.addEventListener("pointercancel", endDrag);

// Tapping outside the board and the controls clears the area highlight.
document.addEventListener("pointerdown", (e) => {
  if (!area) return;
  if (board.contains(e.target) || e.target.closest(".keypad, .tools, dialog")) return;
  area = null;
  render();
});

// ---------- Controls ----------

keypad.addEventListener("click", (e) => {
  const k = e.target.closest(".key");
  if (k) inputDigit(+k.dataset.d);
});
$("undoBtn").addEventListener("click", undo);
$("eraseBtn").addEventListener("click", erase);
$("hintBtn").addEventListener("click", hint);
$("resignBtn").addEventListener("click", resign);
$("notesBtn").addEventListener("click", () => { notesMode = !notesMode; render(); });
$("newBtn").addEventListener("click", openNewDialog);
$("dailyBtn").addEventListener("click", openDaily);
$("pauseBtn").addEventListener("click", () => setPaused(!paused));
$("resumeBtn").addEventListener("click", () => setPaused(false));

$("themeBtn").addEventListener("click", () => {
  const root = document.documentElement;
  const dark = root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  const next = dark ? "light" : "dark";
  root.dataset.theme = next;
  try { localStorage.setItem(STORE.theme, next); } catch {}
});

document.addEventListener("keydown", (e) => {
  if (document.querySelector("dialog[open]")) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); undo(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key;
  if (k >= "1" && k <= "9") { inputDigit(+k); return; }
  if (k === "Backspace" || k === "Delete" || k === "0") { erase(); return; }
  if (k === "n" || k === "N") { notesMode = !notesMode; render(); return; }
  if (k === "h" || k === "H") { hint(); return; }
  if (k === "p" || k === "P" || k === " ") { e.preventDefault(); setPaused(!paused); return; }
  if (k === "Escape") { area = null; render(); return; }
  const moves = { ArrowUp: -9, ArrowDown: 9, ArrowLeft: -1, ArrowRight: 1 };
  if (k in moves && game && !paused) {
    e.preventDefault();
    if (e.shiftKey && selected >= 0) { extendArea(k); return; }
    areaFocus = -1;
    if (selected < 0) selected = 40;
    else {
      const r = rowOf(selected), c = colOf(selected);
      if (k === "ArrowUp") selected = ((r + 8) % 9) * 9 + c;
      if (k === "ArrowDown") selected = ((r + 1) % 9) * 9 + c;
      if (k === "ArrowLeft") selected = r * 9 + ((c + 8) % 9);
      if (k === "ArrowRight") selected = r * 9 + ((c + 1) % 9);
    }
    area = null;
    render();
  }
});

/**
 * Shift+arrow: keyboard twin of shift-click. The selected cell stays put as the
 * anchor and a focus cell moves away from it; the area is the unit holding both.
 * Moves that would leave every unit shared with the anchor are ignored, so
 * Shift+Right/Left sweep the row, Shift+Up/Down the column, and turning a corner
 * (e.g. Shift+Right then Shift+Down) switches to the box.
 */
function extendArea(key) {
  const from = area && areaFocus >= 0 ? areaFocus : selected;
  const r = rowOf(from), c = colOf(from);
  const [dr, dc] = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[key];
  const nr = r + dr, nc = c + dc;
  if (nr < 0 || nr > 8 || nc < 0 || nc > 8) return;
  const to = nr * 9 + nc;
  if (to === selected) { area = null; areaFocus = -1; render(); return; }
  const unit = sharedUnit(selected, to);
  if (!unit) return;
  area = unit;
  areaFocus = to;
  render();
}

new ResizeObserver(() => drawCages()).observe(board);

// ---------- Boot ----------

buildBoard();
lb.retryPending();
renderDailyBtn();
syncStreak();

// A sync link (#sync=CODE) from another device: show what linking would do; nothing changes until "Merge & link".
// Also when the link is opened in a tab that already has the game (only the hash changes then).
function openSyncLink() {
  const m = location.hash.match(/^#sync=([A-Za-z0-9-]{8,12})$/);
  if (!m) return;
  history.replaceState(null, "", location.pathname + location.search);
  openSync(m[1].toUpperCase().replace(/-/g, ""));
}
openSyncLink();
addEventListener("hashchange", openSyncLink);

/** The daily to reopen on load: today's, or yesterday's if it is still being played. */
function savedDaily() {
  if (store.get(STORE.mode) !== "daily") return null;
  const g = store.get(STORE.daily);
  const today = dailyDate();
  if (!g?.puzzle) return null;
  return g.daily === today || (g.daily === addDays(today, -1) && g.status === "playing") ? g : null;
}

const saved = savedDuelGame() || savedDaily() || savedNormal();
// Reconnect to the current duel: the one on the board, or an invite still waiting for a friend.
const session = store.get(STORE.duelSession);
if (session && (saved?.duel ? saved.duel.code === session.code : store.get(STORE.duel)?.duel?.code !== session.code)) connectDuel(session);
if (saved) {
  game = saved;
  setupCages();
  render();
  prefetch(game.daily || game.duel ? store.get(STORE.level) || "medium" : game.puzzle.difficulty);
} else {
  startNew(store.get(STORE.level) || "medium");
}
openDuelLink();
addEventListener("hashchange", openDuelLink);
