import { test } from "node:test";
import assert from "node:assert/strict";
import { testDb, call } from "./d1.mjs";
import { onRequestPost as makeCode, onRequestPut as useCode, normCode, newCode, ALPHABET, TTL } from "../functions/api/sync.js";
import { onRequestPost as postStreak, acceptedDays } from "../functions/api/streak.js";
import { dailyDate, addDays, mergeDays } from "../public/js/daily.js";

const A = "aaaaaaaa-1111";
const B = "bbbbbbbb-2222";
const today = dailyDate();

function addScore(db, player, name, puzzle, time, daily = null) {
  db.raw.prepare(`INSERT INTO scores (level, player, name, time, mistakes, hints, puzzle, ip, created_at, daily)
                  VALUES ('hard', ?, ?, ?, 0, 0, ?, 'x', 1, ?)`).run(player, name, time, puzzle, daily);
}
const scoresOf = (db, player) => db.raw.prepare("SELECT name, puzzle, time FROM scores WHERE player = ? ORDER BY puzzle").all(player).map((r) => ({ ...r }));

test("codes are 8 easy-to-read characters, typed in any form", () => {
  for (let i = 0; i < 50; i++) {
    const c = newCode();
    assert.equal(c.length, 8);
    assert.ok([...c].every((ch) => ALPHABET.includes(ch)));
    assert.equal(normCode(c), c);
  }
  assert.equal(normCode(" abcd-efgh "), "ABCDEFGH");
  assert.equal(normCode("ABCD EFG"), "");
  assert.equal(normCode("ABCD-EFG0"), "", "0 isn't used, so it can't be a code");
  assert.equal(normCode(null), "");
});

test("merged days are sorted, without repeats or junk", () => {
  assert.deepEqual(mergeDays(["2026-11-03", "2026-11-01"], ["2026-11-01", "nope", "2026-11-02"]), ["2026-11-01", "2026-11-02", "2026-11-03"]);
  assert.deepEqual(mergeDays(null, undefined), []);
});

test("the server takes real days from the last 400 days, not the future", () => {
  const now = new Date("2026-11-12T12:00:00Z");
  assert.deepEqual(acceptedDays(["2026-11-12", "2026-11-11", "2026-11-11", "2026-11-13", "2025-01-01", "x", 5], now), ["2026-11-11", "2026-11-12"]);
  assert.deepEqual(acceptedDays("2026-11-12", now), []);
});

test("streak days are kept on the server, together with daily leaderboard entries", async () => {
  const env = { DB: testDb() };
  const yesterday = addDays(today, -1);
  addScore(env.DB, A, "Ann", "p1", 300, addDays(today, -2));
  let [status, body] = await call(postStreak, env, "POST", { player: A, dates: [] });
  assert.equal(status, 200);
  assert.deepEqual(body.dates, [addDays(today, -2)]);
  [, body] = await call(postStreak, env, "POST", { player: A, dates: [yesterday, today, addDays(today, 5)] });
  assert.deepEqual(body.dates, [addDays(today, -2), yesterday, today]);
  // Sending the same days again changes nothing.
  [, body] = await call(postStreak, env, "POST", { player: A, dates: [today] });
  assert.deepEqual(body.dates, [addDays(today, -2), yesterday, today]);
  [status] = await call(postStreak, env, "POST", { player: "no", dates: [] });
  assert.equal(status, 400);
});

test("a code moves the other device's times and days over to the code's player", async () => {
  const env = { DB: testDb() };
  addScore(env.DB, A, "Ann", "p1", 300);
  addScore(env.DB, A, "Ann", "shared", 400);
  addScore(env.DB, B, "Phone", "p2", 500);
  addScore(env.DB, B, "Phone", "shared", 350); // same puzzle on both: Ann's entry stays
  await call(postStreak, env, "POST", { player: A, dates: [today] });
  await call(postStreak, env, "POST", { player: B, dates: [today, addDays(today, -1)] });

  const [s1, made] = await call(makeCode, env, "POST", { player: A, name: "Ann" });
  assert.equal(s1, 200);
  assert.equal(made.expires, TTL);

  // A preview shows what would happen and leaves the code valid.
  const [s0, preview] = await call(useCode, env, "PUT", { code: made.code, player: B, preview: true });
  assert.equal(s0, 200);
  assert.deepEqual(preview, {
    same: false,
    device: { times: 2, days: 2 },
    player: { times: 2, days: 1 },
    merged: { times: 3, days: 2 },
  });

  const typed = `${made.code.slice(0, 4).toLowerCase()} ${made.code.slice(4)}`;
  const [s2, used] = await call(useCode, env, "PUT", { code: typed, player: B, name: "Phone" });
  assert.equal(s2, 200);
  assert.equal(used.player, A);
  assert.equal(used.name, "Ann");
  assert.deepEqual(used.dates, [addDays(today, -1), today]);
  assert.equal(used.passkeys, 0);
  assert.deepEqual(scoresOf(env.DB, A), [
    { name: "Ann", puzzle: "p1", time: 300 },
    { name: "Ann", puzzle: "p2", time: 500 },
    { name: "Ann", puzzle: "shared", time: 400 },
  ]);
  assert.deepEqual(scoresOf(env.DB, B), []);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM days WHERE player = ?").get(B).n, 0);

  // A code works once.
  const [s3, again] = await call(useCode, env, "PUT", { code: made.code, player: B });
  assert.equal(s3, 404);
  assert.match(again.error, /wrong or has expired/);
});

test("a player who never set a name takes the other device's name", async () => {
  const env = { DB: testDb() };
  addScore(env.DB, B, "Phone", "p2", 500);
  const [, made] = await call(makeCode, env, "POST", { player: A, name: "" });
  const [, used] = await call(useCode, env, "PUT", { code: made.code, player: B, name: "Phone" });
  assert.equal(used.name, "Phone");
  assert.deepEqual(scoresOf(env.DB, A), [{ name: "Phone", puzzle: "p2", time: 500 }]);
});

test("asking again hands back the current code; renewing replaces it", async () => {
  const env = { DB: testDb() };
  const [, first] = await call(makeCode, env, "POST", { player: A, name: "Ann" });
  const [, again] = await call(makeCode, env, "POST", { player: A, name: "Annie" });
  assert.equal(again.code, first.code);
  assert.ok(again.expires <= TTL && again.expires > TTL - 5);
  const [, renewed] = await call(makeCode, env, "POST", { player: A, name: "Annie", renew: true });
  assert.notEqual(renewed.code, first.code);
  assert.equal((await call(useCode, env, "PUT", { code: first.code, player: B }))[0], 404);
  // The name sent last is the one the other device gets.
  const [, used] = await call(useCode, env, "PUT", { code: renewed.code, player: B });
  assert.equal(used.name, "Annie");
  // A code about to expire is replaced instead of handed back.
  const [, next] = await call(makeCode, env, "POST", { player: A });
  env.DB.raw.prepare("UPDATE sync_codes SET created_at = created_at - ?").run(TTL - 30);
  const [, fresh] = await call(makeCode, env, "POST", { player: A });
  assert.notEqual(fresh.code, next.code);
  assert.equal(fresh.expires, TTL);
});

test("only new codes count toward the per-IP limit", async () => {
  const env = { DB: testDb() };
  for (let i = 0; i < 100; i++) assert.equal((await call(makeCode, env, "POST", { player: A }))[0], 200); // same code each time
  const statuses = [];
  for (let i = 0; i < 60; i++) statuses.push((await call(makeCode, env, "POST", { player: A, renew: true }))[0]); // the first request above made code 1 of 60
  assert.deepEqual(statuses.slice(-2), [200, 429]);
  assert.equal((await call(makeCode, env, "POST", { player: A, renew: true }, "5.6.7.8"))[0], 200, "another network is unaffected");
});

test("codes expire, a new code replaces the old one, and wrong guesses are limited", async () => {
  const env = { DB: testDb() };
  const [, first] = await call(makeCode, env, "POST", { player: A, name: "Ann" });
  const [, second] = await call(makeCode, env, "POST", { player: A, name: "Ann", renew: true });
  assert.equal((await call(useCode, env, "PUT", { code: first.code, player: B }))[0], 404);

  env.DB.raw.prepare("UPDATE sync_codes SET created_at = created_at - ?").run(TTL);
  assert.equal((await call(useCode, env, "PUT", { code: second.code, player: B }))[0], 404);

  assert.equal((await call(useCode, env, "PUT", { code: "nope", player: B }))[0], 400);
  const statuses = [];
  for (let i = 0; i < 9; i++) statuses.push((await call(useCode, env, "PUT", { code: "ABCD-EFGH", player: B }))[0]);
  assert.deepEqual(statuses.slice(-2), [404, 429]);
  // Another IP isn't affected.
  assert.equal((await call(useCode, env, "PUT", { code: "ABCD-EFGH", player: B }, "5.6.7.8"))[0], 404);
});
