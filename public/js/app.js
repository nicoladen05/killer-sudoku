import { rowOf, colOf, boxOf } from "./engine.js";
import * as lb from "./leaderboard.js";
import { passkeysSupported, savePasskey, signInWithPasskey } from "./passkey.js";
import { DAILY_LEVEL, dailyDate, dailySeed, dailyLabel, addDays, addSolved, mergeDays, streak } from "./daily.js";

const MAX_MISTAKES = 3;
const LEVELS = { easy: "Easy", medium: "Medium", hard: "Hard", expert: "Expert", master: "Master" };
const STORE = {
  game: "cagey:game", theme: "cagey:theme", next: (d) => `cagey:next3:${d}`, level: "cagey:level",
  daily: "cagey:daily", // the current or last daily game (any run)
  dailyDone: "cagey:dailyDone", // dates on which a daily was finished, for the streak
  daysSynced: "cagey:daysSynced", // the dates the server is known to have
  mode: "cagey:mode", // "daily" while the daily is the open game
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
 * first run of a daily; replays don't go on the leaderboard.
 * @type {{puzzle:any, values:number[], notes:number[], mistakes:number, elapsed:number, status:string, history:any[], unlimited:boolean, daily?:string, ranked?:boolean}}
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
const isCorrect = (i) => game.values[i] !== 0 && game.values[i] === game.puzzle.solution[i];
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

function save() { if (game) store.set(game.daily ? STORE.daily : STORE.game, game); }

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

    const key = v ? `v${v}` : `n${game.notes[i]}:${selVal}`;
    if (el.dataset.key === key) continue;
    el.dataset.key = key;
    el.querySelector(".value, .notes")?.remove();
    if (v) {
      const s = document.createElement("span");
      s.className = "value";
      s.textContent = v;
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
  $("levelLabel").textContent = game.daily ? "Daily" : LEVELS[game.puzzle.difficulty] || "";
  $("undoBtn").disabled = !game.history.length;
  renderTime();
}

const fmt = (s) => {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const mm = String(m).padStart(2, "0"), ss = String(sec).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
};
function renderTime() { $("timer").textContent = fmt(Math.floor(game.elapsed)); }

// ---------- Timer ----------

let lastTick = performance.now();
setInterval(() => {
  const now = performance.now();
  const dt = (now - lastTick) / 1000;
  lastTick = now;
  if (game && game.status === "playing" && !paused && document.visibilityState === "visible") {
    const before = Math.floor(game.elapsed);
    game.elapsed += Math.min(dt, 2);
    if (Math.floor(game.elapsed) !== before) { renderTime(); if (Math.floor(game.elapsed) % 5 === 0) save(); }
  }
}, 250);

function setPaused(p) {
  if (!game || game.status !== "playing") p = false;
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

const canPlay = () => game && game.status === "playing" && !paused;

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

  if (game.values[i] === d) return;
  const affected = [i, ...peersOf(i).filter((j) => !game.values[j] && game.notes[j] & (1 << d))];
  game.history.push({ cells: snapshot(affected) });
  game.values[i] = d;
  game.notes[i] = 0;
  cells[i].classList.remove("pop"); void cells[i].offsetWidth; cells[i].classList.add("pop");

  if (d === game.puzzle.solution[i]) {
    for (const j of affected) if (j !== i) game.notes[j] &= ~(1 << d);
    if (game.values.every((v, j) => v === game.puzzle.solution[j])) return finish(true);
  } else {
    game.mistakes++;
    if (!game.unlimited && game.mistakes >= MAX_MISTAKES) { afterChange(); return finish(false); }
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
  for (const { i, v, n } of h.cells) { game.values[i] = v; game.notes[i] = n; }
  afterChange();
}

function hint() {
  if (!canPlay()) return;
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
  cells[i].classList.remove("pop"); void cells[i].offsetWidth; cells[i].classList.add("pop");
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
  const what = g.daily ? `Daily challenge (${dailyLabel(g.daily)})` : `${LEVELS[g.puzzle.difficulty]} puzzle`;
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
  };
  if (g.posted) { showPosted(g.posted); return; }
  if (lb.getName()) postSolve();
  else { $("lbForm").hidden = false; $("lbName").value = ""; }
}

function showPosted(r) {
  const me = r.me;
  const name = escapeHtml(me?.name || lb.getName());
  const board = solve.daily ? `the ${escapeHtml(dailyLabel(solve.daily))} daily` : LEVELS[solve.level];
  const where = me ? ` You're <b>#${me.rank}</b> of ${me.total} on ${board}.` : "";
  const note = r.best === false && me ? ` Your best is still ${fmt(me.time)} with ${me.mistakes ? plural(me.mistakes, "mistake") : "no mistakes"}.` : "";
  lbStatus(`Posted as ${name}.${where}${note} <button type="button" class="link-inline" data-open-board>See leaderboard</button>`);
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
  openBoard(solve?.daily ? "daily" : solve?.level);
});

let boardLevel = null; // a level, or "daily"
let boardDate = null; // the day shown on the daily tab
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
  if (!data.entries.length) { list.innerHTML = `${head}<p class="lb-empty">No times yet. Be the first.</p>`; return; }
  // One ranking: fewer mistakes first, then time. A quiet label marks where each mistake count starts.
  let group = -1;
  const rows = data.entries.map((r) => {
    const sep = r.mistakes !== group ? `<li class="lb-sep" aria-hidden="true"><span>${sectionName(r.mistakes)}</span></li>` : "";
    group = r.mistakes;
    return `${sep}
      <li class="${[r.me ? "me" : "", r.rank <= 3 ? "top" : ""].join(" ").trim()}">
        <span class="lb-rank">${r.rank}</span>
        <span class="lb-name">${escapeHtml(r.name)}</span>
        <span class="lb-extra">${hintText(r.hints)}</span>
        <span class="lb-time">${fmt(r.time)}</span>
      </li>`;
  }).join("");
  const me = data.me && !data.entries.some((r) => r.me)
    ? `<p class="lb-me">Your best: <b>${fmt(data.me.time)}</b> with ${data.me.mistakes ? plural(data.me.mistakes, "mistake") : "no mistakes"}, #${data.me.rank} of ${data.me.total}</p>` : "";
  list.innerHTML = `${head}<ol>${rows}</ol>${me}`;
}

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
  const cur = game?.daily ? "daily" : game?.puzzle.difficulty || store.get(STORE.level) || "medium";
  for (const b of $("newDialog").querySelectorAll(".levels button")) b.classList.toggle("current", b.value === cur);
  const s = dailyStreak();
  $("dailyPickNote").textContent = `${dailyLabel(dailyDate())}${s.solvedToday ? " · solved" : ""}`;
  const normal = game?.daily && savedNormal();
  $("resumeNormalBtn").hidden = !normal;
  if (normal) $("resumeNormalBtn").textContent = `Back to your ${LEVELS[normal.puzzle.difficulty]} game`;
  $("newDialog").showModal();
}
$("newDialog").addEventListener("close", () => {
  const v = $("newDialog").returnValue;
  if (LEVELS[v]) startNew(v);
  else if (v === "daily") openDaily();
  else if (v === "resume") resumeNormal();
});

// ---------- Other devices (sync codes) ----------

function syncStatus(text, isError = false) {
  const el = $("syncStatus");
  el.hidden = !text;
  el.classList.toggle("error", isError);
  el.innerHTML = text || "";
}

/** `code` fills in the code field, e.g. from a sync link. */
function openSync(code = "") {
  $("syncCodeBox").hidden = true;
  $("syncMake").hidden = false;
  $("syncMake").disabled = false;
  $("syncInput").value = code.length === 8 ? showCode(code) : code;
  syncStatus(code ? "Press Link to bring your progress from the other device to this one." : "");
  if ($("boardDialog").open) $("boardDialog").close();
  if (!$("syncDialog").open) $("syncDialog").showModal();
  renderPasskey();
  if (code) $("syncInput").focus();
}

/** After a sync code or passkey: take over the player's days, push this device's own, and say who we are now. */
async function adoptPlayer(r) {
  store.set(STORE.daysSynced, r.dates);
  store.set(STORE.dailyDone, mergeDays(store.get(STORE.dailyDone), r.dates));
  await syncStreak();
  renderDailyBtn();
  lb.retryPending();
  const s = dailyStreak();
  const who = r.name ? ` You're playing as <b>${escapeHtml(r.name)}</b>` : " Linked";
  return `Done.${who}${s.current ? ` with a ${s.current}-day streak` : ""}.`;
}

/** A failed passkey prompt: say nothing when the player just closed it. */
function passkeyError(e, fallback) {
  if (e?.name === "NotAllowedError" || e?.name === "AbortError") return syncStatus("");
  if (e?.name === "InvalidStateError") return syncStatus("This password manager already has a passkey for you.");
  syncStatus(e?.status ? escapeHtml(e.message) : fallback, true);
}

function renderPasskey() {
  $("passkeyBox").hidden = !passkeysSupported();
  if (store.get(STORE.passkey)) $("passkeyNote").textContent = "You have a passkey. Use Sign in on any device where your password manager has it.";
}

$("pkSave").addEventListener("click", async () => {
  $("pkSave").disabled = true;
  syncStatus("");
  try {
    await savePasskey();
    store.set(STORE.passkey, 1);
    renderPasskey();
    syncStatus("Passkey saved. To play on another device, tap Sign in there.");
  } catch (e) {
    passkeyError(e, "Couldn't save the passkey. Check your connection and try again.");
  } finally {
    $("pkSave").disabled = false;
  }
});

$("pkSignIn").addEventListener("click", async () => {
  $("pkSignIn").disabled = true;
  syncStatus("");
  try {
    const r = await signInWithPasskey();
    store.set(STORE.passkey, 1);
    renderPasskey();
    syncStatus(await adoptPlayer(r));
  } catch (e) {
    passkeyError(e, "Couldn't sign in. Check your connection and try again.");
  } finally {
    $("pkSignIn").disabled = false;
  }
});

const syncLink = (code) => `${location.origin}${location.pathname}#sync=${code}`;
const showCode = (code) => `${code.slice(0, 4)}-${code.slice(4)}`;

$("syncMake").addEventListener("click", async () => {
  $("syncMake").disabled = true;
  syncStatus("");
  try {
    await syncStreak(); // so the other device gets every day
    const { code } = await lb.makeSyncCode();
    $("syncCode").textContent = showCode(code);
    $("syncCopy").dataset.code = code;
    $("syncCopy").textContent = "Copy link";
    $("syncCodeBox").hidden = false;
    $("syncMake").hidden = true;
  } catch (e) {
    $("syncMake").disabled = false;
    syncStatus(e.status ? escapeHtml(e.message) : "Couldn't reach the server. Check your connection and try again.", true);
  }
});

$("syncCopy").addEventListener("click", async () => {
  const url = syncLink($("syncCopy").dataset.code);
  try {
    if (navigator.share && matchMedia("(hover: none)").matches) { await navigator.share({ url }); return; }
    await navigator.clipboard.writeText(url);
    $("syncCopy").textContent = "Copied";
  } catch (e) {
    if (e?.name !== "AbortError") $("syncCopy").textContent = "Couldn't copy";
  }
});

$("syncForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const code = $("syncInput").value.trim();
  if (!code) return;
  const btn = $("syncForm").querySelector("button");
  btn.disabled = true;
  syncStatus("Linking…");
  try {
    syncStatus(await adoptPlayer(await lb.useSyncCode(code)));
    $("syncInput").value = "";
  } catch (err) {
    syncStatus(err.status ? escapeHtml(err.message) : "Couldn't reach the server. Check your connection and try again.", true);
  } finally {
    btn.disabled = false;
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

// A sync link (#sync=CODE) from another device: offer to link, but only on a click.
{
  const m = location.hash.match(/^#sync=([A-Za-z0-9-]{8,12})$/);
  if (m) {
    history.replaceState(null, "", location.pathname + location.search);
    openSync(m[1].toUpperCase().replace(/-/g, ""));
  }
}

/** The daily to reopen on load: today's, or yesterday's if it is still being played. */
function savedDaily() {
  if (store.get(STORE.mode) !== "daily") return null;
  const g = store.get(STORE.daily);
  const today = dailyDate();
  if (!g?.puzzle) return null;
  return g.daily === today || (g.daily === addDays(today, -1) && g.status === "playing") ? g : null;
}

const saved = savedDaily() || savedNormal();
if (saved) {
  game = saved;
  setupCages();
  render();
  prefetch(game.daily ? store.get(STORE.level) || "medium" : game.puzzle.difficulty);
} else {
  startNew(store.get(STORE.level) || "medium");
}
