import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { generate } from "../public/js/engine.js";
import {
  createDuel, joinDuel, step, view, nextAlarm, info, validPuzzle, newDuelCode, normDuelCode, seatOfToken,
  CODE_ALPHABET, COUNTDOWN, CLOCKS, WRONG_PENALTY, LAG_GRACE, LOBBY_TTL, KEEP, MAX_RACE,
} from "../lib/duel.js";
import { Duel, puzzleHash } from "../duel-worker/index.js";
import { onRequest } from "../functions/api/duel/[[path]].js";
import { testDb } from "./d1.mjs";

const P = generate("easy", 7); // 31 givens, so 50 cells to fill
const PUZZLE = { cages: P.cages, givens: P.givens, solution: P.solution };
const HASH = await puzzleHash(PUZZLE);
const EMPTY = [...Array(81).keys()].filter((i) => !P.givens[i]);
const A = "aaaaaaaa-1111";
const B = "bbbbbbbb-2222";
const T0 = 1_000_000;

/** Wrong digit for a cell. */
const wrong = (i) => (P.solution[i] % 9) + 1;

function lobby(mode = "classic", clock = "5+3") {
  return createDuel({ code: "ABCDEF", mode, level: "easy", clock, player: A, name: "Anna", token: "secret-token-anna", seed: 7, now: T0 });
}
/** Both seated and ready: the countdown has started at T0 + 10. */
function started(mode = "classic", first = 0) {
  let s = joinDuel(lobby(mode), { player: B, name: "Ben", token: "secret-token-ben" }).state;
  s = step(s, { type: "ready", seat: 0, hash: HASH, puzzle: PUZZLE }, T0 + 5).state;
  s = step(s, { type: "ready", seat: 1, hash: HASH, puzzle: PUZZLE, first }, T0 + 10).state;
  return s;
}
const GO = T0 + 10 + COUNTDOWN;
const move = (s, seat, cell, digit, now) => step(s, { type: "move", seat, cell, digit }, now);

// ---------- Codes and boards ----------

test("duel codes are 6 easy-to-read characters, typed in any form", () => {
  for (let i = 0; i < 50; i++) {
    const c = newDuelCode();
    assert.equal(c.length, 6);
    assert.ok([...c].every((ch) => CODE_ALPHABET.includes(ch)));
  }
  assert.equal(normDuelCode(" abc-def "), "ABCDEF");
  assert.equal(normDuelCode("ABCDE0"), "");
  assert.equal(normDuelCode("ABCDEFG"), "");
  assert.equal(normDuelCode(5), "");
});

test("only a real killer sudoku is accepted as the duel board", () => {
  assert.ok(validPuzzle(PUZZLE));
  for (const lvl of ["medium", "master"]) {
    const q = generate(lvl, 3);
    assert.ok(validPuzzle({ cages: q.cages, givens: q.givens, solution: q.solution }), lvl);
  }
  const swapped = P.solution.slice();
  [swapped[0], swapped[1]] = [swapped[1], swapped[0]];
  assert.ok(!validPuzzle({ ...PUZZLE, solution: swapped }), "not a sudoku");
  assert.ok(!validPuzzle({ ...PUZZLE, cages: PUZZLE.cages.map((c, i) => (i ? c : { ...c, sum: c.sum + 1 })) }), "wrong cage sum");
  assert.ok(!validPuzzle({ ...PUZZLE, cages: PUZZLE.cages.slice(1) }), "cells left out");
  const g = P.givens.slice();
  g[EMPTY[0]] = wrong(EMPTY[0]);
  assert.ok(!validPuzzle({ ...PUZZLE, givens: g }), "a given that disagrees");
  assert.ok(!validPuzzle(null));
  assert.ok(!validPuzzle({ ...PUZZLE, givens: "x" }));
});

// ---------- Lobby ----------

test("a friend joins once; the host can't join their own invite", () => {
  const s = lobby();
  assert.equal(info(s).full, false);
  assert.match(joinDuel(s, { player: A, name: "Anna", token: "x" }).error, /your own invite/);
  const j = joinDuel(s, { player: B, name: "Ben", token: "secret-token-ben" });
  assert.equal(j.seat, 1);
  assert.equal(j.state.status, "preparing");
  assert.equal(s.status, "lobby", "the old state is left alone");
  assert.equal(seatOfToken(j.state, "secret-token-ben"), 1);
  // The same player again (say, a second tab) gets their seat and token back.
  assert.deepEqual([joinDuel(j.state, { player: B, name: "Ben", token: "new" }).seat, joinDuel(j.state, { player: B, name: "Ben", token: "new" }).token], [1, "secret-token-ben"]);
  assert.match(joinDuel(j.state, { player: "cccccccc-3333", name: "Cy", token: "tC" }).error, /two players/);
  assert.deepEqual(info(j.state), { code: "ABCDEF", mode: "classic", level: "easy", clock: null, status: "preparing", host: "Anna", full: true });
});

test("the duel starts after a countdown once both browsers built the same board", () => {
  let s = joinDuel(lobby(), { player: B, name: "Ben", token: "secret-token-ben" }).state;
  s = step(s, { type: "ready", seat: 1, hash: HASH, puzzle: PUZZLE }, T0 + 5).state;
  assert.equal(s.status, "preparing");
  assert.deepEqual(view(s, 0, T0).players.map((p) => p.ready), [false, true]);
  s = step(s, { type: "ready", seat: 0, hash: HASH, puzzle: PUZZLE }, T0 + 10).state;
  assert.equal(s.status, "playing");
  assert.equal(s.startAt, T0 + 10 + COUNTDOWN);
  assert.match(move(s, 0, EMPTY[0], P.solution[EMPTY[0]], GO - 1).error, /hasn't started/);
});

test("different boards from the same seed end the duel instead of starting it", () => {
  let s = joinDuel(lobby(), { player: B, name: "Ben", token: "secret-token-ben" }).state;
  s = step(s, { type: "ready", seat: 0, hash: HASH, puzzle: PUZZLE }, T0).state;
  s = step(s, { type: "ready", seat: 1, hash: "0".repeat(32), puzzle: PUZZLE }, T0).state;
  assert.equal(s.status, "over");
  assert.deepEqual(s.result, { winner: null, reason: "mismatch" });
});

test("a broken first board is refused", () => {
  const s = joinDuel(lobby(), { player: B, name: "Ben", token: "secret-token-ben" }).state;
  const r = step(s, { type: "ready", seat: 0, hash: HASH, puzzle: { ...PUZZLE, solution: P.solution.map(() => 1) } }, T0);
  assert.match(r.error, /isn't valid/);
  assert.equal(r.state, s);
});

test("cancelling before the start ends the duel without a winner", () => {
  const s = step(lobby(), { type: "resign", seat: 0 }, T0 + 1).state;
  assert.deepEqual(s.result, { winner: null, reason: "cancelled" });
});

test("an invite nobody takes expires, and finished duels are cleaned up later", () => {
  const s = lobby();
  assert.equal(nextAlarm(s), T0 + LOBBY_TTL);
  assert.equal(step(s, { type: "alarm" }, T0 + LOBBY_TTL - 1).state.status, "lobby");
  const over = step(s, { type: "alarm" }, T0 + LOBBY_TTL).state;
  assert.deepEqual(over.result, { winner: null, reason: "expired" });
  assert.equal(nextAlarm(over), T0 + LOBBY_TTL + KEEP);
  assert.ok(!step(over, { type: "alarm" }, T0 + LOBBY_TTL + KEEP - 1).gone);
  assert.ok(step(over, { type: "alarm" }, T0 + LOBBY_TTL + KEEP).gone);
});

// ---------- Classic race ----------

test("race: the first to fill the board wins", () => {
  let s = started("classic");
  // Ben is quick with a few cells; Anna solves everything.
  for (const i of EMPTY.slice(0, 5)) s = move(s, 1, i, P.solution[i], GO + 100).state;
  const v = view(s, 0, GO + 100);
  assert.deepEqual([v.players[0].filled, v.players[1].filled, v.total], [0, 5, 50]);
  for (const [k, i] of EMPTY.entries()) {
    s = move(s, 0, i, P.solution[i], GO + 1000 + k).state;
    if (k < EMPTY.length - 1) assert.equal(s.status, "playing");
  }
  assert.deepEqual(s.result, { winner: 0, reason: "solved", time: 1000 + EMPTY.length - 1 });
  assert.match(move(s, 1, EMPTY[9], P.solution[EMPTY[9]], GO + 5000).error, /over/);
});

test("race: three wrong digits lose, repeats and givens don't count", () => {
  let s = started("classic");
  const i = EMPTY[0];
  s = move(s, 0, i, P.solution[i], GO).state;
  s = move(s, 0, i, wrong(i), GO).state; // already solved there: ignored
  const given = P.givens.findIndex(Boolean);
  s = move(s, 0, given, (P.givens[given] % 9) + 1, GO).state;
  assert.equal(s.seats[0].mistakes, 0);
  s = move(s, 0, EMPTY[1], wrong(EMPTY[1]), GO).state;
  s = move(s, 0, EMPTY[1], wrong(EMPTY[1]), GO).state;
  assert.equal(s.status, "playing");
  s = move(s, 0, EMPTY[2], wrong(EMPTY[2]), GO + 7).state;
  assert.deepEqual(s.result, { winner: 1, reason: "mistakes" });
  assert.equal(nextAlarm(s), GO + 7 + KEEP);
});

test("race: a view never gives away the solution, ids or the opponent's cells", () => {
  let s = started("classic");
  s = move(s, 1, EMPTY[0], P.solution[EMPTY[0]], GO).state;
  const v = view(s, 0, GO, [true, false]);
  const text = JSON.stringify(v);
  for (const secret of [A, B, "secret-token-anna", "secret-token-ben", JSON.stringify(P.solution)]) assert.ok(!text.includes(secret), secret);
  assert.deepEqual(v.players.map((p) => [p.name, p.online, p.filled]), [["Anna", true, 0], ["Ben", false, 1]]);
  assert.equal(v.mine[EMPTY[0]], 0, "Anna's own board doesn't have Ben's digit");
  assert.equal(view(s, 1, GO).mine[EMPTY[0]], P.solution[EMPTY[0]]);
});

test("race: a race nobody finishes ends after a day", () => {
  const s = started("classic");
  assert.equal(nextAlarm(s), GO + MAX_RACE);
  assert.deepEqual(step(s, { type: "alarm" }, GO + MAX_RACE).state.result, { winner: null, reason: "abandoned" });
});

test("race: resigning hands the win to the other player", () => {
  assert.deepEqual(step(started("classic"), { type: "resign", seat: 1 }, GO).state.result, { winner: 0, reason: "resign" });
});

// ---------- Chess clock ----------

const BASE = CLOCKS["5+3"].base * 1000;
const INC = CLOCKS["5+3"].inc * 1000;

test("chess: players take turns; a right digit stays and adds the increment", () => {
  let s = started("chess", 1); // Ben moves first
  assert.deepEqual([s.turn, s.turnStart, s.left], [1, GO, [BASE, BASE]]);
  const [a, b] = EMPTY;
  assert.match(move(s, 0, a, P.solution[a], GO + 100).error, /not your turn/);
  s = move(s, 1, a, P.solution[a], GO + 10_000).state;
  assert.equal(s.values[a], P.solution[a]);
  assert.equal(s.owner[a], 1);
  assert.equal(s.left[1], BASE - (10_000 - LAG_GRACE) + INC);
  assert.deepEqual([s.turn, s.turnStart], [0, GO + 10_000]);
  assert.match(move(s, 0, a, P.solution[a], GO + 11_000).error, /already filled/);
  s = move(s, 0, b, P.solution[b], GO + 12_000).state;
  assert.equal(s.left[0], BASE - (2000 - LAG_GRACE) + INC);
  assert.deepEqual(s.last, { seat: 0, cell: b, digit: P.solution[b], ok: true, at: GO + 12_000 });
});

test("chess: a wrong digit is rejected, costs the penalty and passes the turn", () => {
  let s = started("chess", 0);
  const a = EMPTY[0];
  s = move(s, 0, a, wrong(a), GO + LAG_GRACE).state;
  assert.equal(s.values[a], 0);
  assert.equal(s.left[0], BASE - WRONG_PENALTY);
  assert.equal(s.seats[0].mistakes, 1);
  assert.equal(s.turn, 1);
  assert.deepEqual(s.last, { seat: 0, cell: a, digit: wrong(a), ok: false, at: GO + LAG_GRACE });
});

test("chess: a penalty that empties the clock loses", () => {
  let s = started("chess", 0);
  s.left[0] = WRONG_PENALTY;
  s = move(s, 0, EMPTY[0], wrong(EMPTY[0]), GO).state;
  assert.deepEqual([s.status, s.result, s.left[0]], ["over", { winner: 1, reason: "timeout" }, 0]);
});

test("chess: the clock running out loses, by alarm or by a late move", () => {
  const s = started("chess", 0);
  const flag = GO + BASE + LAG_GRACE;
  assert.equal(nextAlarm(s), flag);
  assert.equal(step(s, { type: "alarm" }, flag - 1).state.status, "playing");
  const out = step(s, { type: "alarm" }, flag).state;
  assert.deepEqual([out.result, out.left], [{ winner: 1, reason: "timeout" }, [0, BASE]]);
  const late = move(s, 0, EMPTY[0], P.solution[EMPTY[0]], flag + 5).state;
  assert.deepEqual(late.result, { winner: 1, reason: "timeout" });
  assert.equal(late.values[EMPTY[0]], 0, "a move after the flag doesn't count");
});

test("chess: when the board is full, more time left wins, and equal time is a draw", () => {
  let s = started("chess", 0);
  for (const i of EMPTY) s = move(s, s.turn, i, P.solution[i], s.turnStart + 1000).state;
  // 50 cells, 25 each, 1 s per move: the same time spent, but the last digit (Ben's) gets no increment.
  assert.equal(s.status, "over");
  assert.deepEqual(s.left, [BASE - 25 * (1000 - LAG_GRACE) + 25 * INC, BASE - 25 * (1000 - LAG_GRACE) + 24 * INC]);
  assert.deepEqual(s.result, { winner: 0, reason: "complete" });

  // Equal clocks after the last digit: a draw.
  let d = started("chess", 0);
  for (const [k, i] of EMPTY.entries()) {
    if (k === EMPTY.length - 1) d.left[d.turn] = d.left[1 - d.turn] + (1000 - LAG_GRACE);
    d = move(d, d.turn, i, P.solution[i], d.turnStart + 1000).state;
  }
  assert.deepEqual(d.result, { winner: null, reason: "complete" });
});

test("chess: views show the shared board and both clocks", () => {
  let s = started("chess", 0);
  s = move(s, 0, EMPTY[0], P.solution[EMPTY[0]], GO + 2000).state;
  const v = view(s, 1, GO + 3000, [true, true]);
  assert.equal(v.values[EMPTY[0]], P.solution[EMPTY[0]]);
  assert.equal(v.owner[EMPTY[0]], 0);
  assert.equal(v.owner[P.givens.findIndex(Boolean)], -1);
  assert.deepEqual([v.turn, v.left.length, v.clock, v.mine], [1, 2, "5+3", undefined]);
  assert.ok(!JSON.stringify(v).includes(JSON.stringify(P.solution)));
});

// ---------- Durable Object and API, with a fake runtime ----------

class FakeSocket {
  constructor() { this.sent = []; this.closed = false; }
  send(m) { if (this.closed) throw new Error("closed"); this.sent.push(JSON.parse(m)); }
  close() { this.closed = true; }
  last(type = "state") { return this.sent.filter((m) => m.type === type).at(-1); }
}

function fakeCtx() {
  const data = new Map();
  const sockets = [];
  const ctx = {
    alarm: null,
    storage: {
      get: async (k) => structuredClone(data.get(k)),
      put: async (k, v) => { data.set(k, structuredClone(v)); },
      deleteAll: async () => data.clear(),
      setAlarm: async (t) => { ctx.alarm = t; },
    },
    blockConcurrencyWhile(fn) { ctx.ready = fn(); },
    acceptWebSocket(ws, tags) { ws.tags = tags; sockets.push(ws); },
    getWebSockets: (tag) => sockets.filter((w) => !w.closed && (!tag || w.tags.includes(tag))),
    getTags: (ws) => ws.tags,
    data,
  };
  return ctx;
}

function fakeEnv() {
  const objects = new Map();
  const DUELS = {
    idFromName: (n) => n,
    get(id) {
      if (!objects.has(id)) { const ctx = fakeCtx(); objects.set(id, { ctx, obj: new Duel(ctx, {}) }); }
      const { ctx, obj } = objects.get(id);
      return { fetch: async (url, init) => { await ctx.ready; return obj.fetch(url instanceof Request ? url : new Request(url, init)); } };
    },
  };
  return { DB: testDb(), DUELS, objects };
}

async function api(env, method, path, body, ip = "1.2.3.4") {
  const request = new Request(`https://example.test/api/duel${path ? `/${path}` : ""}`, {
    method,
    headers: { "content-type": "application/json", "cf-connecting-ip": ip },
    body: body ? JSON.stringify(body) : undefined,
  });
  const res = await onRequest({ request, env, params: { path: path ? path.split("/") : undefined } });
  return [res.status, await res.json()];
}

test("API: create, look up, join and play a race through the Durable Object", async () => {
  const env = fakeEnv();
  assert.equal((await api(env, "POST", "", { player: A, name: "Anna", mode: "chess", level: "easy", clock: "1+0" }))[0], 400);
  assert.equal((await api(env, "POST", "", { player: A, name: " ", mode: "classic", level: "easy" }))[0], 400);
  const [st, made] = await api(env, "POST", "", { player: A, name: "Anna", mode: "classic", level: "easy" });
  assert.equal(st, 200);
  assert.equal(made.seat, 0);
  assert.ok(normDuelCode(made.code) && made.token.length >= 20);

  const [, about] = await api(env, "GET", made.code.toLowerCase());
  assert.deepEqual(about, { code: made.code, mode: "classic", level: "easy", clock: null, status: "lobby", host: "Anna", full: false });
  assert.equal((await api(env, "GET", "ZZZZZZ"))[0], 404);
  assert.equal((await api(env, "POST", `${made.code}/join`, { player: A, name: "Anna" }))[0], 409);
  const [, joined] = await api(env, "POST", `${made.code}/join`, { player: B, name: "Ben" });
  assert.equal(joined.seat, 1);

  // Connect both players straight to the object (the upgrade itself needs the Workers runtime).
  const { obj, ctx } = env.objects.get(made.code);
  const wa = new FakeSocket(), wb = new FakeSocket();
  obj.attach(wa, 0);
  obj.attach(wb, 1);
  assert.deepEqual(wa.last().players.map((p) => p.online), [true, true]);
  assert.equal(wa.last().seed, ctx.data.get("duel").seed);

  // A board whose hash doesn't match is refused.
  await obj.webSocketMessage(wa, JSON.stringify({ type: "ready", hash: "f".repeat(32), puzzle: PUZZLE }));
  assert.match(wa.last("error").error, /hash/);
  await obj.webSocketMessage(wa, JSON.stringify({ type: "ready", hash: HASH, puzzle: PUZZLE }));
  await obj.webSocketMessage(wb, JSON.stringify({ type: "ready", hash: HASH, puzzle: PUZZLE }));
  const v = wb.last();
  assert.equal(v.status, "playing");
  assert.equal(v.you, 1);
  assert.equal(ctx.alarm, v.startAt + MAX_RACE);

  // Play after the countdown, with a mocked clock.
  mock.timers.enable({ apis: ["Date"], now: v.startAt + 10 });
  try {
    for (const i of EMPTY) await obj.webSocketMessage(wb, JSON.stringify({ type: "move", cell: i, digit: P.solution[i] }));
  } finally {
    mock.timers.reset();
  }
  assert.deepEqual(wa.last().result, { winner: 1, reason: "solved", time: 10 });
  assert.equal(wa.last().players[1].filled, 50);

  // Rematch offers are passed to the other player.
  await obj.webSocketMessage(wa, JSON.stringify({ type: "rematch", code: "hjk-mnp" }));
  assert.deepEqual(wb.last("rematch"), { type: "rematch", code: "HJKMNP", name: "Anna" });

  // A player leaving shows as offline to the other.
  wb.closed = true;
  await obj.webSocketClose(wb, 1000);
  assert.deepEqual(wa.last().players.map((p) => p.online), [true, false]);

  // Long after the end, the alarm deletes the duel.
  mock.timers.enable({ apis: ["Date"], now: ctx.alarm });
  try { await obj.alarm(); } finally { mock.timers.reset(); }
  assert.equal(ctx.data.size, 0);
  assert.equal((await api(env, "GET", made.code))[0], 404);
});

test("API: chess moves, turn errors and a timeout from the alarm", async () => {
  const env = fakeEnv();
  const [, made] = await api(env, "POST", "", { player: A, name: "Anna", mode: "chess", level: "easy", clock: "3+2" });
  await api(env, "POST", `${made.code}/join`, { player: B, name: "Ben" });
  const { obj, ctx } = env.objects.get(made.code);
  const ws = [new FakeSocket(), new FakeSocket()];
  ws.forEach((w, i) => obj.attach(w, i));
  for (const w of ws) await obj.webSocketMessage(w, JSON.stringify({ type: "ready", hash: HASH, puzzle: PUZZLE }));
  const v = ws[0].last();
  const mover = v.turn;
  mock.timers.enable({ apis: ["Date"], now: v.startAt + 1000 });
  try {
    await obj.webSocketMessage(ws[1 - mover], JSON.stringify({ type: "move", cell: EMPTY[0], digit: P.solution[EMPTY[0]] }));
    assert.match(ws[1 - mover].last("error").error, /not your turn/);
    await obj.webSocketMessage(ws[mover], JSON.stringify({ type: "move", cell: EMPTY[0], digit: P.solution[EMPTY[0]] }));
    const after = ws[1 - mover].last();
    assert.equal(after.turn, 1 - mover);
    assert.equal(after.values[EMPTY[0]], P.solution[EMPTY[0]]);
    // The other player never moves: the alarm flags them.
    mock.timers.setTime(ctx.alarm);
    await obj.alarm();
  } finally {
    mock.timers.reset();
  }
  assert.deepEqual(ws[0].last().result, { winner: mover, reason: "timeout" });
});

test("API: a socket needs a seat's token", async () => {
  const env = fakeEnv();
  const [, made] = await api(env, "POST", "", { player: A, name: "Anna", mode: "classic", level: "easy" });
  const res = await onRequest({
    request: new Request(`https://example.test/api/duel/${made.code}/ws?token=nope`, { headers: { upgrade: "websocket" } }),
    env, params: { path: [made.code, "ws"] },
  });
  assert.equal(res.status, 403);
});

test("API: new duels and wrong codes are rate limited per IP", async () => {
  const env = fakeEnv();
  for (let i = 0; i < 30; i++) assert.equal((await api(env, "POST", "", { player: A, name: "Anna", mode: "classic", level: "easy" }, "9.9.9.9"))[0], 200);
  assert.equal((await api(env, "POST", "", { player: A, name: "Anna", mode: "classic", level: "easy" }, "9.9.9.9"))[0], 429);
  for (let i = 0; i < 30; i++) assert.equal((await api(env, "GET", "ZZZZZZ", null, "8.8.8.8"))[0], 404);
  assert.equal((await api(env, "GET", "ZZZZZZ", null, "8.8.8.8"))[0], 429);
  assert.equal((await api(env, "GET", "ZZZZZZ", null, "7.7.7.7"))[0], 404, "other IPs are fine");
});

test("API: says so when duels aren't configured", async () => {
  const [st] = await api({ DB: testDb() }, "POST", "", {});
  assert.equal(st, 503);
});
