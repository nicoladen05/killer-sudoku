// Leaderboard API (Cloudflare Pages Function, D1 binding `DB`).
//
//   GET  /api/scores?level=hard[&player=<id>]
//        -> top 50: fewer mistakes rank first, then ranked time. A player keeps
//           only their best entry (fewest mistakes, then fastest), so appears once.
//   GET  /api/scores?daily=2026-11-12[&player=<id>]
//        -> the same, for one day's daily challenge.
//
// Ranked time = solve time + hint penalty (see hintPenalty); `time` in responses
// is that ranked time and `raw` the clock time. Mistakes don't add time; they
// rank first instead.
//   POST /api/scores  { level, player, name, time, mistakes, hints, puzzle[, daily] }
//
// Daily entries carry the date of the puzzle (German time). Only today and
// yesterday are accepted (yesterday so a game finished just after midnight still
// counts). The first puzzle hash posted for a day is kept, and later entries must
// match it, so everyone on a daily board played the same puzzle. Daily entries
// only appear on the daily board, not on the Hard board.
//
// The game runs entirely in the browser, so a result can't be proven. These
// checks only keep out junk: valid level, sane numbers, a short clean name,
// one entry per player per puzzle and a per-IP rate limit.

import { DAILY_LEVEL, dailyDate, addDays, isDate } from "../../public/js/daily.js";
import { json, readJson, isPlayer, ipHash, cleanName } from "../../lib/server.js";

export { cleanName };

const LEVELS = ["easy", "medium", "hard", "expert", "master"];
/** Fastest believable solve per level, in seconds. */
const MIN_TIME = { easy: 20, medium: 30, hard: 45, expert: 60, master: 90 };
const MAX_TIME = 24 * 3600;
const TOP = 50;
const RATE = { perHour: 20, perDay: 100 };
/**
 * Seconds added to the ranked time for n hints. Each hint costs one minute more
 * than the one before (1, 2, 3 ... minutes), so the total grows with n squared and
 * pressing Hint repeatedly always costs far more than solving those cells.
 * Must match hintPenalty in public/js/app.js.
 */
export const hintPenalty = (n) => 30 * n * (n + 1);
const PENALTY_SQL = "30 * hints * (hints + 1)";

const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

/**
 * Each player's best entry within one board: fewest mistakes, then fastest
 * ranked time. The board is ranked the same way. ?1 is the level, or the date
 * for a daily board.
 */
const boardWhere = (daily) => (daily ? "daily = ?1" : "level = ?1 AND daily IS NULL");
const best = (daily) => `
  SELECT player, name, score, time, mistakes, hints, created_at FROM (
    SELECT player, name, time + ${PENALTY_SQL} AS score, time, mistakes, hints, created_at,
           ROW_NUMBER() OVER (PARTITION BY player ORDER BY mistakes, time + ${PENALTY_SQL}, created_at) AS n
    FROM scores WHERE ${boardWhere(daily)}
  ) WHERE n = 1`;
const ORDER = "mistakes, score, created_at";

/** A player's best entry on a board and its rank, or null. */
async function rankOf(db, key, player, daily = false) {
  const row = await db
    .prepare(`WITH best AS (${best(daily)}) SELECT
        (SELECT COUNT(*) FROM best b WHERE b.mistakes < me.mistakes
           OR (b.mistakes = me.mistakes AND (b.score < me.score
           OR (b.score = me.score AND b.created_at < me.created_at)))) + 1 AS rank,
        me.score AS time, me.time AS raw, me.mistakes, me.hints, me.name,
        (SELECT COUNT(*) FROM best) AS total
      FROM best me WHERE me.player = ?2`)
    .bind(key, player)
    .first();
  return row || null;
}

/** Dates a daily entry may be posted for right now: today and yesterday (German time). */
export function openDailyDates(now = new Date()) {
  const today = dailyDate(now);
  return [today, addDays(today, -1)];
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const daily = url.searchParams.get("daily");
  const level = url.searchParams.get("level");
  if (daily != null ? !isDate(daily) : !LEVELS.includes(level)) return json({ error: daily != null ? "bad date" : "bad level" }, 400);
  const isDaily = daily != null;
  const key = isDaily ? daily : level;
  const raw = url.searchParams.get("player");
  const player = isPlayer(raw) ? raw : null;
  const { results } = await env.DB
    .prepare(`${best(isDaily)} ORDER BY ${ORDER} LIMIT ${TOP}`)
    .bind(key)
    .all();
  return json({
    ...(isDaily ? { daily, level: DAILY_LEVEL } : { level }),
    entries: results.map((r, i) => ({ rank: i + 1, name: r.name, time: r.score, raw: r.time, mistakes: r.mistakes, hints: r.hints, me: r.player === player })),
    me: player ? await rankOf(env.DB, key, player, isDaily) : null,
  });
}

export async function onRequestPost({ request, env }) {
  const b = await readJson(request);
  if (!b) return json({ error: "bad body" }, 400);

  const level = b.level;
  const name = cleanName(b.name);
  if (!LEVELS.includes(level)) return json({ error: "bad level" }, 400);
  if (!isPlayer(b.player)) return json({ error: "bad player" }, 400);
  if (typeof b.puzzle !== "string" || !/^[a-f0-9]{16,64}$/.test(b.puzzle)) return json({ error: "bad puzzle" }, 400);
  if (!name) return json({ error: "Please enter a name." }, 400);
  if (!isInt(b.time, MIN_TIME[level], MAX_TIME)) return json({ error: "That time doesn't look right." }, 400);
  if (!isInt(b.mistakes, 0, 2) || !isInt(b.hints, 0, 81)) return json({ error: "bad counts" }, 400);
  const daily = b.daily ?? null;
  if (daily !== null) {
    if (!isDate(daily) || level !== DAILY_LEVEL) return json({ error: "bad daily" }, 400);
    if (!openDailyDates().includes(daily)) return json({ error: "That daily challenge has ended." }, 400);
  }

  const ip = await ipHash(request);
  const now = Math.floor(Date.now() / 1000);
  const recent = await env.DB
    .prepare("SELECT SUM(created_at > ?2) AS hour, COUNT(*) AS day FROM scores WHERE ip = ?1 AND created_at > ?3")
    .bind(ip, now - 3600, now - 86400)
    .first();
  if ((recent?.hour || 0) >= RATE.perHour || (recent?.day || 0) >= RATE.perDay) {
    return json({ error: "Too many submissions. Try again later." }, 429);
  }

  if (daily) {
    // The first hash posted for a day becomes that day's puzzle.
    await env.DB.prepare("INSERT INTO daily (date, puzzle, created_at) VALUES (?1, ?2, ?3) ON CONFLICT (date) DO NOTHING")
      .bind(daily, b.puzzle, now).run();
    const day = await env.DB.prepare("SELECT puzzle FROM daily WHERE date = ?1").bind(daily).first();
    if (day?.puzzle !== b.puzzle) return json({ error: "This isn't the daily puzzle everyone else played. Reload the page to get the current version." }, 409);
  }

  const res = await env.DB
    .prepare(`INSERT INTO scores (level, player, name, time, mistakes, hints, puzzle, ip, created_at, daily)
              VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10) ON CONFLICT (player, puzzle) DO NOTHING`)
    .bind(level, b.player, name, b.time, b.mistakes, b.hints, b.puzzle, ip, now, daily)
    .run();
  // A name change applies to all of this player's entries.
  await env.DB.prepare("UPDATE scores SET name = ?1 WHERE player = ?2 AND name != ?1").bind(name, b.player).run();

  const me = await rankOf(env.DB, daily || level, b.player, !!daily);
  return json({ ok: true, duplicate: res.meta.changes === 0, best: me?.mistakes === b.mistakes && me?.time === b.time + hintPenalty(b.hints), me });
}

/** Change the display name on all of a player's entries. */
export async function onRequestPut({ request, env }) {
  const b = await readJson(request);
  const name = cleanName(b?.name);
  if (!isPlayer(b?.player)) return json({ error: "bad player" }, 400);
  if (!name) return json({ error: "Please enter a name." }, 400);
  const res = await env.DB.prepare("UPDATE scores SET name = ?1 WHERE player = ?2").bind(name, b.player).run();
  return json({ ok: true, updated: res.meta.changes });
}
