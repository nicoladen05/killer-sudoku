import { test } from "node:test";
import assert from "node:assert/strict";
import { testDb, call } from "./d1.mjs";
import { onRequestGet, onRequestPost } from "../functions/api/scores.js";
import { generate } from "../public/js/engine.js";

const A = "aaaaaaaa-1111";
const B = "bbbbbbbb-2222";
const C = "cccccccc-3333";
const H1 = "1".repeat(32);
const H2 = "2".repeat(32);

async function get(env, query) {
  const res = await onRequestGet({ request: new Request(`https://example.test/api/scores?${query}`), env });
  return [res.status, await res.json()];
}
const post = (env, body) => call(onRequestPost, env, "POST", { level: "easy", mistakes: 0, hints: 0, ...body });

test("level boards return the seed, puzzle and replay count, and leave replays out", async () => {
  const env = { DB: testDb() };
  assert.equal((await post(env, { player: A, name: "Ann", time: 300, puzzle: H1, seed: 12345 }))[0], 200);
  assert.equal((await post(env, { player: B, name: "Bob", time: 200, puzzle: H1, seed: 12345, replay: true }))[0], 200);
  assert.equal((await post(env, { player: C, name: "Cat", time: 250, puzzle: H1, seed: 12345, replay: true }))[0], 200);

  const [, board] = await get(env, `level=easy&player=${B}`);
  assert.equal(board.entries.length, 1, "replays don't show on the level board");
  assert.deepEqual(board.entries[0], { rank: 1, name: "Ann", time: 300, raw: 300, mistakes: 0, hints: 0, me: false, puzzle: H1, seed: 12345, replays: 2 });
  assert.equal(board.me, null, "a replay doesn't rank the player on the level board");

  const [, replays] = await get(env, `replays=${H1}&player=${B}`);
  assert.equal(replays.level, "easy");
  assert.deepEqual(replays.entries.map((r) => [r.rank, r.name, r.original, r.me]), [
    [1, "Bob", false, true], [2, "Cat", false, false], [3, "Ann", true, false],
  ]);
  assert.equal(replays.me.rank, 1);
  assert.equal(replays.me.total, 3);
});

test("a replay posts its rank on the replay list", async () => {
  const env = { DB: testDb() };
  await post(env, { player: A, name: "Ann", time: 300, puzzle: H1, seed: 1 });
  const [s, r] = await post(env, { player: B, name: "Bob", time: 400, puzzle: H1, seed: 1, replay: true });
  assert.equal(s, 200);
  assert.equal(r.best, true);
  assert.deepEqual([r.me.rank, r.me.total], [2, 2]);
});

test("a replay needs an original on a level board, at the same level", async () => {
  const env = { DB: testDb() };
  const [s1, r1] = await post(env, { player: B, name: "Bob", time: 400, puzzle: H2, replay: true });
  assert.equal(s1, 400);
  assert.match(r1.error, /isn't on the leaderboard/);

  await post(env, { player: A, name: "Ann", time: 300, puzzle: H1, seed: 1 });
  const [s2] = await post(env, { player: B, name: "Bob", level: "hard", time: 400, puzzle: H1, replay: true });
  assert.equal(s2, 400);

  // A replay of a replay doesn't count as an original.
  await post(env, { player: B, name: "Bob", time: 400, puzzle: H1, replay: true });
  env.DB.raw.prepare("DELETE FROM scores WHERE player = ?").run(A);
  const [s3] = await post(env, { player: C, name: "Cat", time: 400, puzzle: H1, replay: true });
  assert.equal(s3, 400);
});

test("replaying your own board counts once", async () => {
  const env = { DB: testDb() };
  await post(env, { player: A, name: "Ann", time: 300, puzzle: H1, seed: 1 });
  const [, r] = await post(env, { player: A, name: "Ann", time: 200, puzzle: H1, seed: 1, replay: true });
  assert.equal(r.duplicate, true);
  const [, board] = await get(env, "level=easy");
  assert.deepEqual([board.entries[0].time, board.entries[0].replays], [300, 0]);
});

test("seeds must be 32-bit integers; old entries have none", async () => {
  const env = { DB: testDb() };
  for (const seed of [-1, 2 ** 32, 1.5, "7"]) {
    assert.equal((await post(env, { player: A, name: "Ann", time: 300, puzzle: H1, seed }))[0], 400, String(seed));
  }
  await post(env, { player: A, name: "Ann", time: 300, puzzle: H1 });
  const [, board] = await get(env, "level=easy");
  assert.equal(board.entries[0].seed, null);
  assert.equal((await get(env, "replays=nope"))[0], 400);
});

test("daily boards don't offer replays", async () => {
  const env = { DB: testDb() };
  const { dailyDate } = await import("../public/js/daily.js");
  const daily = dailyDate();
  await post(env, { player: A, name: "Ann", level: "hard", time: 300, puzzle: H1, seed: 1, daily });
  const [, board] = await get(env, `daily=${daily}`);
  assert.equal(board.entries[0].seed, undefined);
  assert.equal((await post(env, { player: B, name: "Bob", level: "hard", time: 300, puzzle: H1, daily, replay: true }))[0], 400);
});

test("a seed rebuilds the same puzzle", () => {
  const a = generate("easy", 987654321);
  const b = generate("easy", 987654321);
  assert.deepEqual([a.givens, a.cages], [b.givens, b.cages]);
  assert.equal(a.seed, 987654321);
});
