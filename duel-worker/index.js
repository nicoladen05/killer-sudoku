// Duels: one Durable Object per duel, holding the board, the clocks and both
// players' WebSockets. The rules live in lib/duel.js; this class only stores the
// state, runs alarms and passes messages. Deployed as its own Worker
// ("cagey-duel", see duel-worker/wrangler.toml) because Pages can't define
// Durable Objects. The Pages Function functions/api/duel/[[path]].js talks to it
// through the DUELS binding.
//
// Internal routes (only the Pages Function calls these):
//   POST /create { code, mode, level, clock, player, name } -> { token, seat }
//   GET  /info                                          -> lib/duel.js info()
//   POST /join   { player, name }                       -> { token, seat }
//   GET  /ws?token=...  (WebSocket upgrade)
//
// Socket messages from a browser:
//   { type: "ready", hash, puzzle: { cages, givens, solution } }
//   { type: "move", cell, digit }
//   { type: "resign" }
//   { type: "rematch", code }  relayed to the other player as { type: "rematch", code, name }
//   "ping" (answered with "pong" without waking the object)
// Every change sends each connected player { type: "state", ... } (lib/duel.js view()).
// A rejected message gets { type: "error", error } back.

import { createDuel, joinDuel, step, view, info, nextAlarm, seatOfToken, normDuelCode } from "../lib/duel.js";
import { toB64url } from "../lib/server.js";

const reply = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
const newToken = () => toB64url(crypto.getRandomValues(new Uint8Array(18)));
const randomSeed = () => crypto.getRandomValues(new Uint32Array(1))[0];
const MAX_MESSAGE = 32 * 1024;

/** Same as puzzleHash in public/js/leaderboard.js. */
export async function puzzleHash(puzzle) {
  const text = JSON.stringify([puzzle.givens, puzzle.cages]);
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf).slice(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
}

export class Duel {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.s = null;
    ctx.blockConcurrencyWhile(async () => { this.s = (await ctx.storage.get("duel")) ?? null; });
    // Keep-alive pings are answered by the runtime, so an idle duel can hibernate.
    if (typeof WebSocketRequestResponsePair === "function") {
      ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    const now = Date.now();
    const route = `${request.method} ${url.pathname}`;

    if (route === "POST /create") {
      if (this.s) return reply({ error: "taken" }, 409);
      const b = await request.json();
      const token = newToken();
      try {
        this.s = createDuel({ ...b, code: normDuelCode(b.code), token, seed: randomSeed(), now });
      } catch (e) {
        return reply({ error: e.message }, 400);
      }
      await this.commit();
      return reply({ token, seat: 0 });
    }

    if (!this.s) return reply({ error: "That duel doesn't exist or has expired." }, 404);

    if (route === "GET /info") return reply(info(this.s));

    if (route === "POST /join") {
      const b = await request.json();
      const r = joinDuel(this.s, { player: b.player, name: b.name, token: newToken() });
      if (r.error) return reply({ error: r.error }, r.status);
      if (r.state !== this.s) {
        this.s = r.state;
        await this.commit();
        this.broadcast();
      }
      return reply({ token: r.token, seat: r.seat });
    }

    if (route === "GET /ws") {
      const seat = seatOfToken(this.s, url.searchParams.get("token"));
      if (seat < 0) return reply({ error: "Not a player in this duel." }, 403);
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return reply({ error: "Expected a WebSocket." }, 426);
      const [client, server] = Object.values(new WebSocketPair());
      this.attach(server, seat);
      return new Response(null, { status: 101, webSocket: client });
    }

    return reply({ error: "not found" }, 404);
  }

  /** Take a player's socket (hibernatable) and tell everyone. */
  attach(ws, seat) {
    this.ctx.acceptWebSocket(ws, [`s${seat}`]);
    this.broadcast();
  }

  seatOf(ws) {
    return this.ctx.getTags(ws).includes("s1") ? 1 : 0;
  }

  async webSocketMessage(ws, data) {
    if (!this.s || typeof data !== "string" || data.length > MAX_MESSAGE) return;
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (!msg || typeof msg !== "object") return;
    const seat = this.seatOf(ws);
    const send = (body) => { try { ws.send(JSON.stringify(body)); } catch {} };

    if (msg.type === "rematch") {
      const code = normDuelCode(msg.code);
      if (!code) return;
      for (const other of this.ctx.getWebSockets(`s${1 - seat}`)) {
        try { other.send(JSON.stringify({ type: "rematch", code, name: this.s.seats[seat].name })); } catch {}
      }
      return;
    }

    let ev;
    if (msg.type === "ready") {
      if (typeof msg.hash !== "string" || !msg.puzzle || typeof msg.puzzle !== "object") return send({ type: "error", error: "bad ready" });
      // The board must be what its hash says, so the other browser's hash can vouch for it.
      if ((await puzzleHash(msg.puzzle)) !== msg.hash) return send({ type: "error", error: "bad board hash" });
      ev = { type: "ready", seat, hash: msg.hash, puzzle: msg.puzzle, first: randomSeed() & 1 };
    } else if (msg.type === "move") {
      ev = { type: "move", seat, cell: msg.cell, digit: msg.digit };
    } else if (msg.type === "resign") {
      ev = { type: "resign", seat };
    } else {
      return;
    }

    // Read this.s only now: another message may have changed it while the hash was computed.
    const r = step(this.s, ev, Date.now());
    if (r.error) send({ type: "error", error: r.error });
    if (r.state === this.s) return;
    this.s = r.state;
    await this.commit();
    this.broadcast();
  }

  async webSocketClose(ws, code) {
    try { ws.close(code === 1005 ? 1000 : code, "bye"); } catch {}
    this.broadcast(ws);
  }

  async webSocketError(ws) {
    this.broadcast(ws);
  }

  async alarm() {
    if (!this.s) return;
    const r = step(this.s, { type: "alarm" }, Date.now());
    if (r.gone) {
      for (const ws of this.ctx.getWebSockets()) { try { ws.close(1000, "expired"); } catch {} }
      await this.ctx.storage.deleteAll();
      this.s = null;
      return;
    }
    const changed = r.state.status !== this.s.status;
    this.s = r.state;
    await this.commit();
    if (changed) this.broadcast();
  }

  async commit() {
    await this.ctx.storage.put("duel", this.s);
    await this.ctx.storage.setAlarm(nextAlarm(this.s));
  }

  /** Send every connected player their view. `gone` is a socket that is closing. */
  broadcast(gone = null) {
    if (!this.s) return;
    const now = Date.now();
    const sockets = this.ctx.getWebSockets().filter((ws) => ws !== gone);
    const online = [0, 1].map((seat) => sockets.some((ws) => this.seatOf(ws) === seat));
    for (const ws of sockets) {
      try { ws.send(JSON.stringify(view(this.s, this.seatOf(ws), now, online))); } catch {}
    }
  }
}

export default {
  fetch: () => new Response("Duels are reached through the site's /api/duel.", { status: 404 }),
};
