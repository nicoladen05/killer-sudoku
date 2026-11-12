// Passkeys (WebAuthn): an optional way back to a player's progress, with no
// email or password (Cloudflare Pages Function, D1 binding `DB`).
//
//   POST /api/passkey  { step: "register-options", player, name } -> creation options
//   POST /api/passkey  { step: "register", player, name, credential } -> { ok }
//   POST /api/passkey  { step: "login-options" }                  -> request options
//   POST /api/passkey  { step: "login", player, name, credential } -> { player, name, dates }
//
// A passkey is one more key to a player id, like a sync code, but it lives in
// the player's password manager and works without the old device. Signing in
// works like entering a sync code: this device's own times and days move to the
// passkey's player (see linkPlayer in sync.js).
//
// Saving needs no attestation: the browser hands over the public key in SPKI
// form (getPublicKey()), so no CBOR parsing is needed. Every challenge is
// random, used once and valid for 5 minutes. Signing in checks the challenge,
// the origin, the relying party (this host name), the user-presence flag, the
// signature, and the signature counter for authenticators that keep one.

import { json, readJson, isPlayer, ipHash, cleanName, nowSec, toB64url, fromB64url, sha256 } from "../../lib/server.js";
import { tries, logTry, linkPlayer } from "./sync.js";

export const TTL = 5 * 60;
const RATE = { pkstart: 30, pkmiss: 10 }; // per IP per hour
const RP_NAME = "Killer Sudoku";

/** Supported COSE algorithms: how to import the key and check a signature. */
export const ALGS = {
  [-7]: { key: { name: "ECDSA", namedCurve: "P-256" }, verify: { name: "ECDSA", hash: "SHA-256" }, der: true },
  [-257]: { key: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, verify: { name: "RSASSA-PKCS1-v1_5" } },
};

const FLAG_UP = 0x01; // user present
const FLAG_AT = 0x40; // attested credential data included

/** The fixed part of authenticator data, and the credential id when it is there. */
export function parseAuthData(bytes) {
  if (!bytes || bytes.length < 37) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = { rpIdHash: bytes.slice(0, 32), flags: bytes[32], signCount: view.getUint32(33) };
  if (out.flags & FLAG_AT) {
    if (bytes.length < 55) return null;
    const len = view.getUint16(53);
    if (bytes.length < 55 + len) return null;
    out.credentialId = bytes.slice(55, 55 + len);
  }
  return out;
}

/** An ECDSA signature in DER (as authenticators send it) to the raw r|s form WebCrypto wants. */
export function derToRaw(der, n = 32) {
  if (!der || der[0] !== 0x30 || der.length < 8) return null;
  let i = der[1] & 0x80 ? 2 + (der[1] & 0x7f) : 2;
  const out = new Uint8Array(2 * n);
  for (let k = 0; k < 2; k++) {
    if (der[i] !== 0x02) return null;
    const len = der[i + 1];
    let v = der.slice(i + 2, i + 2 + len);
    if (v.length !== len) return null;
    i += 2 + len;
    while (v.length > n && v[0] === 0) v = v.slice(1);
    if (v.length > n) return null;
    out.set(v, (k + 1) * n - v.length);
  }
  return out;
}

const same = (a, b) => a && b && a.length === b.length && a.every((x, i) => x === b[i]);

/** clientDataJSON, checked for type and origin, or null. */
function clientData(b64, type, origin) {
  const bytes = fromB64url(b64);
  if (!bytes) return null;
  try {
    const c = JSON.parse(new TextDecoder().decode(bytes));
    return c && c.type === type && c.origin === origin && typeof c.challenge === "string" ? { ...c, bytes } : null;
  } catch {
    return null;
  }
}

/** Use up a challenge: returns its row if it was valid, and deletes it either way. */
const takeChallenge = (db, challenge, kind, now) =>
  db.prepare("DELETE FROM passkey_challenges WHERE challenge = ?1 AND kind = ?2 AND created_at > ?3 RETURNING player")
    .bind(challenge, kind, now - TTL).first();

async function newChallenge(db, kind, player, ctx) {
  const challenge = toB64url(crypto.getRandomValues(new Uint8Array(32)));
  await db.batch([
    db.prepare("DELETE FROM passkey_challenges WHERE created_at <= ?1").bind(ctx.now - TTL),
    db.prepare("INSERT INTO passkey_challenges (challenge, kind, player, created_at) VALUES (?1, ?2, ?3, ?4)").bind(challenge, kind, player, ctx.now),
    logTry(db, ctx.ip, "pkstart", ctx.now),
  ]);
  return challenge;
}

const tooMany = () => json({ error: "Too many tries. Try again later." }, 429);
const bad = (msg = "That passkey couldn't be saved. Try again, or use a code instead.") => json({ error: msg }, 400);

async function registerOptions(b, { db, ...ctx }) {
  if (!isPlayer(b.player)) return json({ error: "bad player" }, 400);
  if ((await tries(db, ctx.ip, "pkstart", ctx.now)) >= RATE.pkstart) return tooMany();
  const challenge = await newChallenge(db, "register", b.player, ctx);
  const { results } = await db.prepare("SELECT id FROM passkeys WHERE player = ?1").bind(b.player).all();
  // The same handle for all of a player's passkeys, so a password manager keeps one per player. Not the id itself.
  const userId = toB64url((await sha256(`cagey-user:${b.player}`)).slice(0, 16));
  const name = cleanName(b.name) || "Player";
  return json({
    challenge,
    rp: { name: RP_NAME },
    user: { id: userId, name, displayName: name },
    pubKeyCredParams: Object.keys(ALGS).map((alg) => ({ type: "public-key", alg: Number(alg) })),
    authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "preferred" },
    excludeCredentials: results.map((r) => ({ type: "public-key", id: r.id })),
    attestation: "none",
    timeout: TTL * 1000,
  });
}

async function register(b, { db, ...ctx }) {
  if (!isPlayer(b.player)) return json({ error: "bad player" }, 400);
  const c = b.credential || {};
  const client = clientData(c.clientDataJSON, "webauthn.create", ctx.origin);
  if (!client) return bad();
  const row = await takeChallenge(db, client.challenge, "register", ctx.now);
  if (!row || row.player !== b.player) return bad("That took too long. Please try again.");

  const id = fromB64url(c.id);
  const auth = parseAuthData(fromB64url(c.authenticatorData));
  if (!id || id.length > 1023 || !auth || !(auth.flags & FLAG_UP) || !same(auth.credentialId, id)) return bad();
  if (!same(auth.rpIdHash, await sha256(ctx.rpId))) return bad();
  const alg = ALGS[c.publicKeyAlgorithm];
  const spki = fromB64url(c.publicKey);
  if (!alg || !spki) return bad("This passkey type isn't supported. Try another password manager, or use a code.");
  try { await crypto.subtle.importKey("spki", spki, alg.key, false, ["verify"]); } catch { return bad(); }

  const res = await db
    .prepare(`INSERT INTO passkeys (id, player, name, public_key, alg, sign_count, created_at)
              VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT (id) DO NOTHING`)
    .bind(toB64url(id), b.player, cleanName(b.name), toB64url(spki), c.publicKeyAlgorithm, auth.signCount, ctx.now)
    .run();
  if (!res.meta.changes) return json({ error: "This passkey is already saved." }, 409);
  return json({ ok: true });
}

async function loginOptions(b, { db, ...ctx }) {
  if ((await tries(db, ctx.ip, "pkstart", ctx.now)) >= RATE.pkstart) return tooMany();
  const challenge = await newChallenge(db, "login", null, ctx);
  return json({ challenge, userVerification: "preferred", timeout: TTL * 1000 });
}

/** Check a sign-in. Returns the passkey row and new counter, or null. */
async function checkLogin(c, { db, ...ctx }) {
  const client = clientData(c.clientDataJSON, "webauthn.get", ctx.origin);
  if (!client || !(await takeChallenge(db, client.challenge, "login", ctx.now))) return null;
  const key = typeof c.id === "string" ? await db.prepare("SELECT * FROM passkeys WHERE id = ?1").bind(c.id).first() : null;
  const authBytes = fromB64url(c.authenticatorData);
  const auth = parseAuthData(authBytes);
  if (!key || !auth || !(auth.flags & FLAG_UP) || !same(auth.rpIdHash, await sha256(ctx.rpId))) return null;
  const alg = ALGS[key.alg];
  let sig = fromB64url(c.signature);
  if (alg?.der) sig = derToRaw(sig);
  if (!alg || !sig) return null;
  const signed = new Uint8Array([...authBytes, ...(await sha256(client.bytes))]);
  try {
    const pub = await crypto.subtle.importKey("spki", fromB64url(key.public_key), alg.key, false, ["verify"]);
    if (!(await crypto.subtle.verify(alg.verify, pub, sig, signed))) return null;
  } catch {
    return null;
  }
  // A counter that doesn't go up means a copied authenticator. Synced passkeys always send 0.
  if ((auth.signCount || key.sign_count) && auth.signCount <= key.sign_count) return null;
  return { key, signCount: auth.signCount };
}

async function login(b, ctx) {
  const { db } = ctx;
  if (!isPlayer(b.player)) return json({ error: "bad player" }, 400);
  if ((await tries(db, ctx.ip, "pkmiss", ctx.now)) >= RATE.pkmiss) return tooMany();
  const ok = await checkLogin(b.credential || {}, ctx);
  if (!ok) {
    await logTry(db, ctx.ip, "pkmiss", ctx.now).run();
    return json({ error: "That passkey didn't work. Try again, or use a code instead." }, 401);
  }
  const to = ok.key.player;
  const latest = await db.prepare("SELECT name FROM scores WHERE player = ?1 ORDER BY created_at DESC LIMIT 1").bind(to).first();
  return json(await linkPlayer(db, b.player, to, latest?.name || ok.key.name || cleanName(b.name), [
    db.prepare("UPDATE passkeys SET sign_count = ?1, used_at = ?2 WHERE id = ?3").bind(ok.signCount, ctx.now, ok.key.id),
  ]));
}

const STEPS = { "register-options": registerOptions, register, "login-options": loginOptions, login };

export async function onRequestPost({ request, env }) {
  const b = await readJson(request);
  const step = b && Object.hasOwn(STEPS, b.step) ? STEPS[b.step] : null;
  if (!step) return json({ error: "bad step" }, 400);
  const url = new URL(request.url);
  return step(b, { db: env.DB, ip: await ipHash(request), now: nowSec(), origin: url.origin, rpId: url.hostname });
}
