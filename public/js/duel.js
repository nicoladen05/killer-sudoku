// Duels in the browser: the /api/duel calls and the live connection to a duel.
// The rules are enforced on the server (lib/duel.js); this module only talks to it.

import { api, playerId, getName } from "./leaderboard.js";

const API = "/api/duel";

export const MODE_NAMES = { classic: "Race", chess: "Chess clock" };
export const CLOCKS = ["3+2", "5+3", "10+5"];
export const DEFAULT_CLOCK = "5+3";

/** ABCDEF -> ABC-DEF */
export const showDuelCode = (code) => `${code.slice(0, 3)}-${code.slice(3)}`;
export const duelLink = (code) => `${location.origin}${location.pathname}#duel=${code}`;
/** A typed or pasted code (or invite link) as ABCDEF, or "". */
export function readDuelCode(raw) {
  const m = String(raw || "").match(/#duel=([A-Za-z0-9-]+)/);
  const c = (m ? m[1] : String(raw || "")).toUpperCase().replace(/[^A-Z0-9]/g, "");
  return /^[A-HJKMNP-Z2-9]{6}$/.test(c) ? c : "";
}

export const createDuel = ({ mode, level, clock }) =>
  api("POST", API, { player: playerId(), name: getName(), mode, level, clock: mode === "chess" ? clock : undefined });
export const duelInfo = (code) => api("GET", `${API}/${code}`);
export const joinDuel = (code) => api("POST", `${API}/${code}/join`, { player: playerId(), name: getName() });

/**
 * A chess clock in ms as it stands at server time `now`: the player to move
 * loses time from the start of their turn (after the countdown).
 */
export function clockLeft(v, seat, now) {
  if (v.mode !== "chess" || !v.left) return null;
  let left = v.left[seat];
  if (v.status === "playing" && v.turn === seat && now > v.turnStart) left -= now - v.turnStart;
  return Math.max(0, left);
}

/**
 * The live connection to one duel. Reconnects on its own (1 s, 2 s, 4 s ... up
 * to 10 s) until closed. Calls `onState(view)` for every state the server sends,
 * `onMessage(msg)` for anything else, and `onStatus("online" | "offline")`.
 */
export class DuelSocket {
  constructor(code, token, { onState, onMessage, onStatus }) {
    Object.assign(this, { code, token, onState, onMessage, onStatus });
    this.ws = null;
    this.closed = false;
    this.retry = 0;
    this.offset = null; // server time minus local time
    this.connect();
  }

  get online() { return this.ws?.readyState === WebSocket.OPEN; }

  /** Best guess of the server's clock (the least-delayed sample since connecting). */
  serverNow() { return Date.now() + (this.offset ?? 0); }

  connect() {
    if (this.closed) return;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}${API}/${this.code}/ws?token=${encodeURIComponent(this.token)}`);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.offset = null;
      clearInterval(this.ping);
      this.ping = setInterval(() => { if (this.online) ws.send("ping"); }, 25_000);
      this.onStatus?.("online");
    };
    ws.onmessage = (e) => {
      if (e.data === "pong") return;
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === "state") {
        // A message is never early, so the largest offset is the closest to the truth.
        const sample = msg.now - Date.now();
        this.offset = this.offset == null ? sample : Math.max(this.offset, sample);
        this.onState?.(msg);
      } else {
        this.onMessage?.(msg);
      }
    };
    ws.onclose = () => {
      clearInterval(this.ping);
      if (this.ws !== ws) return;
      this.onStatus?.("offline");
      if (this.closed) return;
      // After a few failed tries, check that the duel still exists (it is deleted
      // some hours after the end); if not, stop trying.
      if (this.retry >= 2) {
        duelInfo(this.code).catch((err) => {
          if (err.status !== 404 || this.closed) return;
          this.close();
          this.onMessage?.({ type: "gone" });
        });
      }
      const wait = Math.min(10_000, 1000 * 2 ** this.retry++);
      this.timer = setTimeout(() => this.connect(), wait);
    };
  }

  /** Send a message; false when not connected (nothing is queued). */
  send(msg) {
    if (!this.online) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    clearInterval(this.ping);
    try { this.ws?.close(1000); } catch {}
  }
}
