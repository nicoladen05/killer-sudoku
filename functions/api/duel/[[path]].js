// Duels API (Cloudflare Pages Function). Each duel is a Durable Object in the
// cagey-duel Worker (duel-worker/index.js), reached through the DUELS binding
// and named by its invite code.
//
//   POST /api/duel             { player, name, mode, level[, clock] } -> { code, token, seat }
//   GET  /api/duel/<code>      -> { code, mode, level, clock, status, host, full }
//   POST /api/duel/<code>/join { player, name }                     -> { code, token, seat }
//   GET  /api/duel/<code>/ws?token=<token>  WebSocket for one player
//
// `token` is a seat's secret for the socket; the player id never leaves this
// server, so the other player doesn't learn it. Rules: lib/duel.js.

import { json, readJson, isPlayer, ipHash, cleanName, nowSec } from "../../../lib/server.js";
import { MODES, LEVELS, CLOCKS, newDuelCode, normDuelCode } from "../../../lib/duel.js";

/** Per IP per hour: new duels, and lookups of codes that don't exist. */
export const RATE = { duel: 30, duelmiss: 30 };

async function tooMany(db, ip, kind) {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM sync_tries WHERE ip = ?1 AND kind = ?2 AND created_at > ?3")
    .bind(ip, kind, nowSec() - 3600)
    .first();
  return (row?.n || 0) >= RATE[kind];
}
const note = (db, ip, kind) =>
  db.prepare("INSERT INTO sync_tries (ip, kind, created_at) VALUES (?1, ?2, ?3)").bind(ip, kind, nowSec()).run();

const stubFor = (env, code) => env.DUELS.get(env.DUELS.idFromName(code));
const post = (body) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function create(request, env) {
  const b = await readJson(request);
  const name = cleanName(b?.name);
  if (!isPlayer(b?.player)) return json({ error: "bad player" }, 400);
  if (!name) return json({ error: "Please enter a name." }, 400);
  if (!MODES.includes(b.mode)) return json({ error: "bad mode" }, 400);
  if (!LEVELS.includes(b.level)) return json({ error: "bad level" }, 400);
  if (b.mode === "chess" && !CLOCKS[b.clock]) return json({ error: "bad clock" }, 400);
  const ip = await ipHash(request);
  if (await tooMany(env.DB, ip, "duel")) return json({ error: "Too many duels. Try again later." }, 429);
  await note(env.DB, ip, "duel");
  // A code can only be taken once; on the rare clash, draw another.
  for (let i = 0; i < 5; i++) {
    const code = newDuelCode();
    const res = await stubFor(env, code).fetch("https://duel/create", post({ code, mode: b.mode, level: b.level, clock: b.clock, player: b.player, name }));
    if (res.status === 409) continue;
    const out = await res.json();
    return res.ok ? json({ code, ...out }) : json(out, res.status);
  }
  return json({ error: "Couldn't make a code. Try again." }, 503);
}

/** Pass the Durable Object's answer on, counting lookups of codes that don't exist. */
async function forward(request, env, res) {
  if (res.status === 404) await note(env.DB, await ipHash(request), "duelmiss");
  return json(await res.json(), res.status);
}

export async function onRequest({ request, env, params }) {
  if (!env.DUELS) return json({ error: "Duels aren't available on this server." }, 503);
  const path = [].concat(params?.path ?? []);
  const method = request.method;

  if (!path.length) return method === "POST" ? create(request, env) : json({ error: "not found" }, 404);

  const code = normDuelCode(path[0]);
  if (!code || path.length > 2) return json({ error: "That isn't a duel code." }, 404);
  const action = path[1] ?? "";
  if (action !== "ws" && (await tooMany(env.DB, await ipHash(request), "duelmiss"))) {
    return json({ error: "Too many wrong codes. Try again later." }, 429);
  }
  const stub = stubFor(env, code);

  if (action === "" && method === "GET") return forward(request, env, await stub.fetch("https://duel/info"));

  if (action === "join" && method === "POST") {
    const b = await readJson(request);
    const name = cleanName(b?.name);
    if (!isPlayer(b?.player)) return json({ error: "bad player" }, 400);
    if (!name) return json({ error: "Please enter a name." }, 400);
    const res = await stub.fetch("https://duel/join", post({ player: b.player, name }));
    if (!res.ok) return forward(request, env, res);
    return json({ code, ...(await res.json()) });
  }

  if (action === "ws" && method === "GET") {
    const token = new URL(request.url).searchParams.get("token") || "";
    // Keep the original request (and its Upgrade header) so the socket reaches the Durable Object.
    return stub.fetch(new Request(`https://duel/ws?token=${encodeURIComponent(token)}`, request));
  }

  return json({ error: "not found" }, 404);
}
