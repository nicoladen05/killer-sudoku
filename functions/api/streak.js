// Daily streak kept on the server (Cloudflare Pages Function, D1 binding `DB`).
//
//   POST /api/streak  { player, dates: ["2026-11-12", ...] }
//        -> { dates }  every day this player finished a daily, oldest first
//
// The browser sends the days it knows the server doesn't have yet (often none,
// just to read) and keeps the union of both lists. Days with a daily entry on
// the leaderboard count too.
//
// Like the leaderboard, this can't be proven: the game runs in the browser.
// Streaks aren't ranked anywhere, so past days are accepted as well (an older
// streak moves to the server the first time a browser syncs). The checks only
// keep out junk: real dates in the last 400 days and a per-IP limit.

import { dailyDate, addDays, isDate } from "../../public/js/daily.js";
import { json, readJson, isPlayer, ipHash, nowSec } from "../../lib/server.js";

export const KEEP_DAYS = 400;
/** New days one IP may add per day. A first sync can bring up to 400 at once. */
const PER_DAY = 1000;

/** The valid days from a request: real dates from the last 400 days up to today (German time). */
export function acceptedDays(dates, now = new Date()) {
  if (!Array.isArray(dates)) return [];
  const today = dailyDate(now);
  const first = addDays(today, -KEEP_DAYS);
  return [...new Set(dates.filter((d) => isDate(d) && d >= first && d <= today))].sort();
}

/** Every day `player` finished a daily, from the last 400 days, oldest first. */
export async function streakDays(db, player, now = new Date()) {
  const first = addDays(dailyDate(now), -KEEP_DAYS);
  const { results } = await db
    .prepare(`SELECT date FROM days WHERE player = ?1 AND date >= ?2
              UNION SELECT daily FROM scores WHERE player = ?1 AND daily >= ?2
              ORDER BY 1`)
    .bind(player, first)
    .all();
  return results.map((r) => r.date);
}

export async function onRequestPost({ request, env }) {
  const b = await readJson(request);
  if (!isPlayer(b?.player)) return json({ error: "bad player" }, 400);

  const known = await streakDays(env.DB, b.player);
  const have = new Set(known);
  const add = acceptedDays(b.dates).filter((d) => !have.has(d));
  if (!add.length) return json({ dates: known });

  const ip = await ipHash(request);
  const now = nowSec();
  const recent = await env.DB.prepare("SELECT COUNT(*) AS n FROM days WHERE ip = ?1 AND created_at > ?2").bind(ip, now - 86400).first();
  if ((recent?.n || 0) + add.length > PER_DAY) return json({ error: "Too many updates. Try again later." }, 429);

  const insert = env.DB.prepare("INSERT INTO days (player, date, ip, created_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT DO NOTHING");
  await env.DB.batch(add.map((d) => insert.bind(b.player, d, ip, now)));
  return json({ dates: [...known, ...add].sort() });
}
