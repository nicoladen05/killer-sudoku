// Sync codes: move a player's progress to another device, with no account
// (Cloudflare Pages Function, D1 binding `DB`).
//
//   POST /api/sync  { player, name }
//        -> { code, expires }  a one-time code, valid for 15 minutes
//   PUT  /api/sync  { code, player, name }
//        -> { player, name, dates }  the device that sends this now plays as
//           the player who made the code
//
// A player is only the random id kept in their browser, and that id is never
// shown or sent to anyone else. A code stands in for it: short, one-time and
// short-lived, so a code that leaks is useless after a few minutes.
//
// When a device enters a code, its own times and streak days move to the code's
// player, so nothing is lost. If both played the same puzzle, the code player's
// entry is kept. The code player's name wins, unless they never set one.

import { json, readJson, isPlayer, ipHash, cleanName, nowSec } from "../../lib/server.js";
import { streakDays } from "./streak.js";

export const TTL = 15 * 60;
/** No 0/O, 1/I/L, so a code is easy to read out and type. */
export const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const LEN = 8;
const RATE = { make: 20, miss: 10 }; // per IP per hour

export function newCode() {
  let out = "";
  while (out.length < LEN) {
    for (const b of crypto.getRandomValues(new Uint8Array(LEN * 2))) {
      // 248 = 8 * 31: drop the top few values so every character is equally likely.
      if (b < 248 && out.length < LEN) out += ALPHABET[b % ALPHABET.length];
    }
  }
  return out;
}

/** A typed or pasted code in canonical form (ABCDEFGH), or "" if it can't be one. */
export function normCode(raw) {
  if (typeof raw !== "string") return "";
  const s = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return s.length === LEN && [...s].every((c) => ALPHABET.includes(c)) ? s : "";
}

/** How often this IP did `kind` in the last hour. Also clears out old rows. */
async function tries(db, ip, kind, now) {
  await db.prepare("DELETE FROM sync_tries WHERE created_at <= ?1").bind(now - 3600).run();
  const row = await db.prepare("SELECT COUNT(*) AS n FROM sync_tries WHERE ip = ?1 AND kind = ?2").bind(ip, kind).first();
  return row?.n || 0;
}
const logTry = (db, ip, kind, now) =>
  db.prepare("INSERT INTO sync_tries (ip, kind, created_at) VALUES (?1, ?2, ?3)").bind(ip, kind, now);

/** Make a code for a player. Any older code of theirs stops working. */
export async function onRequestPost({ request, env }) {
  const b = await readJson(request);
  if (!isPlayer(b?.player)) return json({ error: "bad player" }, 400);
  const db = env.DB;
  const ip = await ipHash(request);
  const now = nowSec();
  if ((await tries(db, ip, "make", now)) >= RATE.make) return json({ error: "Too many codes. Try again later." }, 429);

  for (let attempt = 0; ; attempt++) {
    const code = newCode();
    try {
      await db.batch([
        db.prepare("DELETE FROM sync_codes WHERE created_at <= ?1 OR player = ?2").bind(now - TTL, b.player),
        db.prepare("INSERT INTO sync_codes (code, player, name, created_at) VALUES (?1, ?2, ?3, ?4)").bind(code, b.player, cleanName(b.name), now),
        logTry(db, ip, "make", now),
      ]);
      return json({ code, expires: TTL });
    } catch (e) {
      if (attempt >= 2) throw e; // a code that is already taken: try another
    }
  }
}

/** Use a code: this device becomes the code's player, bringing its own times and days along. */
export async function onRequestPut({ request, env }) {
  const b = await readJson(request);
  if (!isPlayer(b?.player)) return json({ error: "bad player" }, 400);
  const code = normCode(b.code);
  if (!code) return json({ error: "A code has 8 letters and digits, like ABCD-EFGH." }, 400);
  const db = env.DB;
  const ip = await ipHash(request);
  const now = nowSec();
  if ((await tries(db, ip, "miss", now)) >= RATE.miss) return json({ error: "Too many wrong codes. Try again in an hour." }, 429);

  const row = await db.prepare("SELECT player, name FROM sync_codes WHERE code = ?1 AND created_at > ?2").bind(code, now - TTL).first();
  if (!row) {
    await logTry(db, ip, "miss", now).run();
    return json({ error: "That code is wrong or has expired. Codes work for 15 minutes and only once." }, 404);
  }

  const to = row.player;
  const from = b.player;
  const name = row.name || cleanName(b.name);
  const steps = [db.prepare("DELETE FROM sync_codes WHERE code = ?1").bind(code)];
  if (from !== to) {
    steps.push(
      // OR IGNORE skips rows for a puzzle `to` already has; those are dropped next.
      db.prepare("UPDATE OR IGNORE scores SET player = ?1 WHERE player = ?2").bind(to, from),
      db.prepare("DELETE FROM scores WHERE player = ?1").bind(from),
      db.prepare("UPDATE OR IGNORE days SET player = ?1 WHERE player = ?2").bind(to, from),
      db.prepare("DELETE FROM days WHERE player = ?1").bind(from),
    );
  }
  if (name) steps.push(db.prepare("UPDATE scores SET name = ?1 WHERE player = ?2 AND name != ?1").bind(name, to));
  await db.batch(steps);
  return json({ player: to, name, dates: await streakDays(db, to) });
}
