// Helpers shared by the Pages Functions in ./functions/api.

export const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

/** The request body as an object, or null. */
export async function readJson(request) {
  try {
    const b = await request.json();
    return b && typeof b === "object" ? b : null;
  } catch {
    return null;
  }
}

/** A player id: the random id kept in the player's browser. */
export const isPlayer = (v) => typeof v === "string" && /^[a-z0-9-]{8,40}$/.test(v);

export const nowSec = () => Math.floor(Date.now() / 1000);

/** Trim, collapse whitespace, drop control/format characters, cap at 20 chars. */
export function cleanName(raw) {
  if (typeof raw !== "string") return "";
  const s = raw.normalize("NFKC").replace(/\s+/g, " ").replace(/[\p{C}]/gu, "").trim();
  return [...s].slice(0, 20).join("");
}

export async function ipHash(request) {
  // Hashed with the current day so it can't be linked across days; only used for rate limiting.
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const day = new Date().toISOString().slice(0, 10);
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`cagey:${day}:${ip}`));
  return [...new Uint8Array(buf)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Bytes to base64url without padding (as WebAuthn uses). */
export function toB64url(buf) {
  let s = "";
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** base64url to bytes, or null if it isn't valid. */
export function fromB64url(s) {
  if (typeof s !== "string" || !/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) return null;
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

export async function sha256(data) {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}
