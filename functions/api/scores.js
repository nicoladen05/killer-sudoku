// Leaderboard API (Cloudflare Pages Function, D1 binding `DB`).
//
//   GET  /api/scores?level=hard[&player=<id>]
//        -> top 50: fewer mistakes rank first, then ranked time. A player keeps
//           only their best entry (fewest mistakes, then fastest), so appears once.
//
// Ranked time = solve time + hint penalty (see hintPenalty); `time` in responses
// is that ranked time and `raw` the clock time. Mistakes don't add time; they
// rank first instead.
//   POST /api/scores  { level, player, name, time, mistakes, hints, puzzle }
//
// The game runs entirely in the browser, so a result can't be proven. These
// checks only keep out junk: valid level, sane numbers, a short clean name,
// one entry per player per puzzle and a per-IP rate limit.

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

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

/** Trim, collapse whitespace, drop control/format characters, cap at 20 chars. */
export function cleanName(raw) {
  if (typeof raw !== "string") return "";
  const s = raw.normalize("NFKC").replace(/\s+/g, " ").replace(/[\p{C}]/gu, "").trim();
  return [...s].slice(0, 20).join("");
}

async function ipHash(request) {
  // Hashed with the current day so it can't be linked across days; only used for rate limiting.
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const day = new Date().toISOString().slice(0, 10);
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`cagey:${day}:${ip}`));
  return [...new Uint8Array(buf)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Each player's best entry within one level (?1): fewest mistakes, then
 * fastest ranked time. The board is ranked the same way.
 */
const BEST = `
  SELECT player, name, score, time, mistakes, hints, created_at FROM (
    SELECT player, name, time + ${PENALTY_SQL} AS score, time, mistakes, hints, created_at,
           ROW_NUMBER() OVER (PARTITION BY player ORDER BY mistakes, time + ${PENALTY_SQL}, created_at) AS n
    FROM scores WHERE level = ?1
  ) WHERE n = 1`;
const ORDER = "mistakes, score, created_at";

/** A player's best entry and its rank, or null. */
async function rankOf(db, level, player) {
  const row = await db
    .prepare(`WITH best AS (${BEST}) SELECT
        (SELECT COUNT(*) FROM best b WHERE b.mistakes < me.mistakes
           OR (b.mistakes = me.mistakes AND (b.score < me.score
           OR (b.score = me.score AND b.created_at < me.created_at)))) + 1 AS rank,
        me.score AS time, me.time AS raw, me.mistakes, me.hints, me.name,
        (SELECT COUNT(*) FROM best) AS total
      FROM best me WHERE me.player = ?2`)
    .bind(level, player)
    .first();
  return row || null;
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const level = url.searchParams.get("level");
  if (!LEVELS.includes(level)) return json({ error: "bad level" }, 400);
  const raw = url.searchParams.get("player");
  const player = raw && /^[a-z0-9-]{8,40}$/.test(raw) ? raw : null;
  const { results } = await env.DB
    .prepare(`${BEST} ORDER BY ${ORDER} LIMIT ${TOP}`)
    .bind(level)
    .all();
  return json({
    level,
    entries: results.map((r, i) => ({ rank: i + 1, name: r.name, time: r.score, raw: r.time, mistakes: r.mistakes, hints: r.hints, me: r.player === player })),
    me: player ? await rankOf(env.DB, level, player) : null,
  });
}

export async function onRequestPost({ request, env }) {
  let b;
  try { b = await request.json(); } catch { return json({ error: "bad json" }, 400); }
  if (!b || typeof b !== "object") return json({ error: "bad body" }, 400);

  const level = b.level;
  const name = cleanName(b.name);
  if (!LEVELS.includes(level)) return json({ error: "bad level" }, 400);
  if (typeof b.player !== "string" || !/^[a-z0-9-]{8,40}$/.test(b.player)) return json({ error: "bad player" }, 400);
  if (typeof b.puzzle !== "string" || !/^[a-f0-9]{16,64}$/.test(b.puzzle)) return json({ error: "bad puzzle" }, 400);
  if (!name) return json({ error: "Please enter a name." }, 400);
  if (!isInt(b.time, MIN_TIME[level], MAX_TIME)) return json({ error: "That time doesn't look right." }, 400);
  if (!isInt(b.mistakes, 0, 2) || !isInt(b.hints, 0, 81)) return json({ error: "bad counts" }, 400);

  const ip = await ipHash(request);
  const now = Math.floor(Date.now() / 1000);
  const recent = await env.DB
    .prepare("SELECT SUM(created_at > ?2) AS hour, COUNT(*) AS day FROM scores WHERE ip = ?1 AND created_at > ?3")
    .bind(ip, now - 3600, now - 86400)
    .first();
  if ((recent?.hour || 0) >= RATE.perHour || (recent?.day || 0) >= RATE.perDay) {
    return json({ error: "Too many submissions. Try again later." }, 429);
  }

  const res = await env.DB
    .prepare(`INSERT INTO scores (level, player, name, time, mistakes, hints, puzzle, ip, created_at)
              VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) ON CONFLICT (player, puzzle) DO NOTHING`)
    .bind(level, b.player, name, b.time, b.mistakes, b.hints, b.puzzle, ip, now)
    .run();
  // A name change applies to all of this player's entries.
  await env.DB.prepare("UPDATE scores SET name = ?1 WHERE player = ?2 AND name != ?1").bind(name, b.player).run();

  const me = await rankOf(env.DB, level, b.player);
  return json({ ok: true, duplicate: res.meta.changes === 0, best: me?.mistakes === b.mistakes && me?.time === b.time + hintPenalty(b.hints), me });
}

/** Change the display name on all of a player's entries. */
export async function onRequestPut({ request, env }) {
  let b;
  try { b = await request.json(); } catch { return json({ error: "bad json" }, 400); }
  const name = cleanName(b?.name);
  if (typeof b?.player !== "string" || !/^[a-z0-9-]{8,40}$/.test(b.player)) return json({ error: "bad player" }, 400);
  if (!name) return json({ error: "Please enter a name." }, 400);
  const res = await env.DB.prepare("UPDATE scores SET name = ?1 WHERE player = ?2").bind(name, b.player).run();
  return json({ ok: true, updated: res.meta.changes });
}
