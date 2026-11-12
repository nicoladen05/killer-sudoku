import { rowOf, colOf, boxOf } from "./engine.js";
import * as lb from "./leaderboard.js";

const MAX_MISTAKES = 3;
const LEVELS = { easy: "Easy", medium: "Medium", hard: "Hard", expert: "Expert", master: "Master" };
const STORE = { game: "cagey:game", theme: "cagey:theme", next: (d) => `cagey:next3:${d}`, level: "cagey:level", lbClosed: "cagey:lbClosed" };

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
function requestPuzzle(difficulty) {
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
    worker.postMessage({ id, difficulty });
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

/** @type {{puzzle:any, values:number[], notes:number[], mistakes:number, elapsed:number, status:string, history:any[], unlimited:boolean}} */
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

function save() { if (game) store.set(STORE.game, game); }

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
  $("levelLabel").textContent = LEVELS[game.puzzle.difficulty] || "";
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
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") save(); });

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
  save();
  render();
  $("endTitle").textContent = won ? "Solved" : "Three mistakes";
  $("endText").textContent = won
    ? `${LEVELS[game.puzzle.difficulty]} puzzle in ${fmt(Math.floor(game.elapsed))} with ${plural(game.mistakes, "mistake")}.` + penaltyNote(game)
    : "That's the limit. You can start over, or keep going without a mistake limit.";
  $("continueBtn").hidden = won;
  $("endDialog").returnValue = "";
  setupSubmit(won);
  setTimeout(() => $("endDialog").showModal(), won ? 350 : 0);
}

// ---------- Leaderboard ----------

const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
/** Leaderboard hint penalty in seconds: hint k costs k minutes. Must match functions/api/scores.js. */
const hintPenalty = (n) => 30 * n * (n + 1);
/** Short duration: 30s, 1m, 1m 30s. */
const dur = (s) => (s < 60 ? `${s}s` : s % 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s / 60}m`);
const hintText = (hints) => (hints ? `${plural(hints, "hint")} +${dur(hintPenalty(hints))}` : "");
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
  const g = game;
  solve = {
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
  const where = me ? ` You're <b>#${me.rank}</b> of ${me.total} on ${LEVELS[solve.level]} with ${me.mistakes ? plural(me.mistakes, "mistake") : "no mistakes"}.` : "";
  const note = r.best === false && me ? ` Your best is still ${fmt(me.time)}.` : "";
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
  openBoard(solve?.level);
});

let boardLevel = null;
async function openBoard(level) {
  boardLevel = level || game?.puzzle.difficulty || "medium";
  renderPlayingAs();
  if (!$("boardDialog").open) $("boardDialog").showModal();
  loadBoard();
}

function renderPlayingAs() {
  const name = lb.getName();
  $("lbRenameRow").hidden = true;
  $("lbPlayingAs").innerHTML = name
    ? `Playing as <b>${escapeHtml(name)}</b> · <button type="button" class="link-inline" id="lbChange">Change name</button>`
    : "Solve a puzzle to add your time.";
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
  let data;
  try { data = await lb.fetchScores(level); }
  catch (e) { if (level === boardLevel) list.innerHTML = `<p class="lb-empty">${escapeHtml(e.message)}</p>`; return; }
  if (level !== boardLevel) return;
  const sections = data.sections || [];
  if (!sections.some((s) => s.entries.length)) { list.innerHTML = `<p class="lb-empty">No times yet. Be the first.</p>`; return; }
  const closed = new Set(store.get(STORE.lbClosed) || []);
  list.innerHTML = sections.map((s) => {
    const rows = s.entries.map((r) => `
      <li class="${r.me ? "me" : ""}">
        <span class="lb-rank">${r.rank}</span>
        <span class="lb-name">${escapeHtml(r.name)}</span>
        <span class="lb-extra">${hintText(r.hints)}</span>
        <span class="lb-time">${fmt(r.time)}</span>
      </li>`).join("");
    const me = s.me && !s.entries.some((r) => r.me)
      ? `<p class="lb-me">Your best: <b>${fmt(s.me.time)}</b>, #${s.me.rank} of ${s.me.total}</p>` : "";
    return `<details class="lb-section" data-m="${s.mistakes}"${closed.has(s.mistakes) ? "" : " open"}>
      <summary><span>${sectionName(s.mistakes)}</span><span class="lb-count">${s.total ? plural(s.total, "player") : ""}</span></summary>
      ${rows ? `<ol>${rows}</ol>` : `<p class="lb-none">No times yet.</p>`}${me}
    </details>`;
  }).join("");
}
// Remember which sections are collapsed.
$("lbList").addEventListener("toggle", (e) => {
  const d = e.target.closest?.(".lb-section");
  if (!d) return;
  const closed = new Set(store.get(STORE.lbClosed) || []);
  const m = +d.dataset.m;
  d.open ? closed.delete(m) : closed.add(m);
  store.set(STORE.lbClosed, [...closed]);
}, true);

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
  }
});

async function startNew(difficulty) {
  store.set(STORE.level, difficulty);
  $("loading").hidden = false;
  try {
    const puzzle = await takePuzzle(difficulty);
    game = newGameState(puzzle);
    selected = -1; area = null; notesMode = false;
    for (const el of cells) delete el.dataset.key;
    setupCages();
    setPaused(false);
    save();
    render();
  } finally {
    $("loading").hidden = true;
  }
  prefetch(difficulty);
}

function openNewDialog() {
  const cur = game?.puzzle.difficulty || store.get(STORE.level) || "medium";
  for (const b of $("newDialog").querySelectorAll(".levels button")) b.classList.toggle("current", b.value === cur);
  $("newDialog").showModal();
}
$("newDialog").addEventListener("close", () => {
  const v = $("newDialog").returnValue;
  if (LEVELS[v]) startNew(v);
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

const saved = store.get(STORE.game);
if (saved && saved.puzzle && saved.status === "playing") {
  game = saved;
  setupCages();
  render();
  prefetch(game.puzzle.difficulty);
} else {
  startNew(store.get(STORE.level) || "medium");
}
