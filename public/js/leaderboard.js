// Leaderboard client: talks to /api/scores (Pages Function + D1).

const KEY = { player: "cagey:player", name: "cagey:name", pending: "cagey:pending" };
const API = "/api/scores";

const get = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const set = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} };

/** A random id for this browser, so a player's best time is kept together. */
export function playerId() {
  let id = get(KEY.player);
  if (!id || !/^[a-z0-9-]{8,40}$/.test(id)) {
    id = crypto.randomUUID ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
    set(KEY.player, id);
  }
  return id;
}

export const getName = () => get(KEY.name) || "";
export const setName = (n) => set(KEY.name, n || null);

/** Short, stable id for a puzzle, so the same solve is only counted once. */
export async function puzzleHash(puzzle) {
  const text = JSON.stringify([puzzle.givens, puzzle.cages]);
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf).slice(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function call(method, body, query = "") {
  const res = await fetch(API + query, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) {
    const err = new Error((data && data.error) || `Leaderboard unavailable (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export function fetchScores(level) {
  return call("GET", null, `?level=${encodeURIComponent(level)}&player=${encodeURIComponent(playerId())}`);
}

/** Submit a solve. If the network fails it is kept and retried later. */
export async function submitScore(entry) {
  const body = { ...entry, player: playerId(), name: getName() };
  try {
    const r = await call("POST", body);
    set(KEY.pending, null);
    return r;
  } catch (e) {
    if (!e.status) set(KEY.pending, JSON.stringify(entry)); // offline: retry later
    throw e;
  }
}

export async function retryPending() {
  const raw = get(KEY.pending);
  if (!raw || !getName()) return;
  try { await submitScore(JSON.parse(raw)); } catch {}
}

export function renameEverywhere(name) {
  setName(name);
  return call("PUT", { player: playerId(), name });
}
