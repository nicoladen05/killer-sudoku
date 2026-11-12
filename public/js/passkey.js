// Passkeys in the browser (WebAuthn). The server side is functions/api/passkey.js.

import * as lb from "./leaderboard.js";

const toB64url = (buf) => {
  let s = "";
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const fromB64url = (s) =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

const step = (body) => lb.api("POST", "/api/passkey", body);

/** Saving needs getPublicKey(), so the server doesn't have to parse CBOR (all current browsers have it). */
export function passkeysSupported() {
  const A = window.AuthenticatorAttestationResponse;
  return !!(window.PublicKeyCredential && navigator.credentials && A
    && typeof A.prototype.getPublicKey === "function" && typeof A.prototype.getAuthenticatorData === "function");
}

/** Save a passkey for this player in the device's password manager. */
export async function savePasskey() {
  const o = await step({ step: "register-options", player: lb.playerId(), name: lb.getName() });
  const cred = await navigator.credentials.create({
    publicKey: {
      ...o,
      challenge: fromB64url(o.challenge),
      user: { ...o.user, id: fromB64url(o.user.id) },
      excludeCredentials: o.excludeCredentials.map((c) => ({ ...c, id: fromB64url(c.id) })),
    },
  });
  const r = cred.response;
  const publicKey = r.getPublicKey();
  if (!publicKey) {
    const err = new Error("This passkey type isn't supported. Try another password manager, or use a code.");
    err.status = 400;
    throw err;
  }
  return step({
    step: "register",
    player: lb.playerId(),
    name: lb.getName(),
    credential: {
      id: cred.id,
      clientDataJSON: toB64url(r.clientDataJSON),
      authenticatorData: toB64url(r.getAuthenticatorData()),
      publicKey: toB64url(publicKey),
      publicKeyAlgorithm: r.getPublicKeyAlgorithm(),
    },
  });
}

/** Sign in with a passkey: from now on this browser plays as its player. */
export async function signInWithPasskey() {
  const o = await step({ step: "login-options" });
  const cred = await navigator.credentials.get({ publicKey: { ...o, challenge: fromB64url(o.challenge) } });
  const r = cred.response;
  const res = await step({
    step: "login",
    player: lb.playerId(),
    name: lb.getName(),
    credential: {
      id: cred.id,
      clientDataJSON: toB64url(r.clientDataJSON),
      authenticatorData: toB64url(r.authenticatorData),
      signature: toB64url(r.signature),
    },
  });
  lb.setPlayerId(res.player);
  if (res.name) lb.setName(res.name);
  return res;
}
