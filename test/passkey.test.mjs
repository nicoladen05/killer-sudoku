import { test } from "node:test";
import assert from "node:assert/strict";
import { testDb, call } from "./d1.mjs";
import { onRequestPost as passkey, derToRaw, parseAuthData } from "../functions/api/passkey.js";
import { onRequestPost as postStreak } from "../functions/api/streak.js";
import { toB64url, fromB64url, sha256 } from "../lib/server.js";
import { dailyDate } from "../public/js/daily.js";

// call() sends requests to https://example.test, so that is the origin and relying party.
const ORIGIN = "https://example.test";
const A = "aaaaaaaa-1111";
const B = "bbbbbbbb-2222";

/** raw r|s to DER, as an authenticator would send it. */
function rawToDer(raw) {
  const int = (b) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    b = b.slice(i);
    return b[0] & 0x80 ? [0x02, b.length + 1, 0, ...b] : [0x02, b.length, ...b];
  };
  const body = [...int(raw.slice(0, 32)), ...int(raw.slice(32))];
  return new Uint8Array([0x30, body.length, ...body]);
}

/** A software authenticator, enough to act like a real one for these tests. */
async function authenticator(alg = -7, { counter = 0 } = {}) {
  const params = alg === -7
    ? { gen: { name: "ECDSA", namedCurve: "P-256" }, sign: { name: "ECDSA", hash: "SHA-256" } }
    : { gen: { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, sign: { name: "RSASSA-PKCS1-v1_5" } };
  const keys = await crypto.subtle.generateKey(params.gen, false, ["sign", "verify"]);
  const id = crypto.getRandomValues(new Uint8Array(16));
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", keys.publicKey));
  let count = counter;
  const authData = async ({ rpId = "example.test", flags = 0x05, attested = false } = {}) => {
    const head = [...(await sha256(rpId)), flags | (attested ? 0x40 : 0), ...new Uint8Array(new Uint32Array([0]).buffer)];
    const c = count ? count++ : 0;
    head.splice(33, 4, (c >>> 24) & 255, (c >>> 16) & 255, (c >>> 8) & 255, c & 255);
    return new Uint8Array(attested ? [...head, ...new Uint8Array(16), 0, id.length, ...id, 0xa0] : head);
  };
  const client = (type, challenge, origin = ORIGIN) => new TextEncoder().encode(JSON.stringify({ type, challenge, origin }));
  return {
    id: toB64url(id),
    async create(options, opts = {}) {
      return {
        id: toB64url(id),
        clientDataJSON: toB64url(client("webauthn.create", options.challenge, opts.origin)),
        authenticatorData: toB64url(await authData({ attested: true, rpId: opts.rpId })),
        publicKey: toB64url(spki),
        publicKeyAlgorithm: alg,
      };
    },
    async get(options, opts = {}) {
      const cd = client("webauthn.get", options.challenge, opts.origin);
      const ad = await authData({ rpId: opts.rpId, flags: opts.flags });
      const signed = new Uint8Array([...ad, ...(await sha256(cd))]);
      let sig = new Uint8Array(await crypto.subtle.sign(params.sign, keys.privateKey, signed));
      if (alg === -7) sig = rawToDer(sig);
      if (opts.tamper) sig[sig.length - 1] ^= 1;
      return { id: toB64url(id), clientDataJSON: toB64url(cd), authenticatorData: toB64url(ad), signature: toB64url(sig) };
    },
    setCount: (n) => { count = n; },
  };
}

async function save(env, auth, player = A, name = "Ann") {
  const [, o] = await call(passkey, env, "POST", { step: "register-options", player, name });
  return call(passkey, env, "POST", { step: "register", player, name, credential: await auth.create(o) });
}
async function signIn(env, auth, player = B, opts = {}, ip) {
  const [, o] = await call(passkey, env, "POST", { step: "login-options" }, ip);
  return call(passkey, env, "POST", { step: "login", player, name: "Phone", credential: await auth.get(o, opts) }, ip);
}

test("ECDSA signatures in DER are turned into raw r|s", () => {
  const raw = new Uint8Array(64).map((_, i) => (i === 0 || i === 32 ? 0x80 : i)); // high bits need a 0 pad in DER
  assert.deepEqual(derToRaw(rawToDer(raw)), raw);
  const small = new Uint8Array(64); small[31] = 1; small[63] = 2;
  assert.deepEqual(derToRaw(rawToDer(small)), small);
  assert.equal(derToRaw(new Uint8Array([1, 2, 3])), null);
});

test("base64url round trips and rejects junk", () => {
  const bytes = crypto.getRandomValues(new Uint8Array(33));
  for (const n of [0, 1, 2, 3, 31, 32, 33]) assert.deepEqual(fromB64url(toB64url(bytes.slice(0, n))), bytes.slice(0, n));
  assert.equal(fromB64url("a+b/"), null);
  assert.equal(fromB64url("abcde"), null);
});

for (const [alg, label] of [[-7, "ES256"], [-257, "RS256"]]) {
  test(`${label}: save a passkey, then sign in on another device and bring its progress along`, async () => {
    const env = { DB: testDb() };
    const auth = await authenticator(alg);
    env.DB.raw.prepare("INSERT INTO scores (level, player, name, time, mistakes, hints, puzzle, ip, created_at) VALUES ('hard', ?, 'Ann', 300, 0, 0, 'p1', 'x', 1)").run(A);
    assert.deepEqual(await save(env, auth), [200, { ok: true }]);

    await call(postStreak, env, "POST", { player: B, dates: [dailyDate()] });
    const [status, body] = await signIn(env, auth, B);
    assert.equal(status, 200);
    assert.deepEqual(body, { player: A, name: "Ann", dates: [dailyDate()] });
  });
}

test("saving checks the challenge, origin, relying party and credential", async () => {
  const env = { DB: testDb() };
  const auth = await authenticator();
  const opts = async (player = A) => (await call(passkey, env, "POST", { step: "register-options", player, name: "Ann" }))[1];

  const o = await opts();
  assert.equal(o.user.name, "Ann");
  assert.notEqual(o.user.id, toB64url(new TextEncoder().encode(A)), "the player id isn't handed to the authenticator");
  assert.deepEqual(o.pubKeyCredParams.map((p) => p.alg), [-7, -257]);

  // A challenge made for one player can't save a passkey for another.
  assert.equal((await call(passkey, env, "POST", { step: "register", player: B, credential: await auth.create(o) }))[0], 400);
  // Each challenge works once.
  assert.equal((await call(passkey, env, "POST", { step: "register", player: A, credential: await auth.create(o) }))[0], 400);
  assert.equal((await call(passkey, env, "POST", { step: "register", player: A, credential: await auth.create(await opts(), { origin: "https://evil.test" }) }))[0], 400);
  assert.equal((await call(passkey, env, "POST", { step: "register", player: A, credential: await auth.create(await opts(), { rpId: "evil.test" }) }))[0], 400);
  const swapped = await auth.create(await opts());
  swapped.id = toB64url(new Uint8Array(16));
  assert.equal((await call(passkey, env, "POST", { step: "register", player: A, credential: swapped }))[0], 400);

  assert.deepEqual(await save(env, auth), [200, { ok: true }]);
  const again = await opts();
  assert.deepEqual(again.excludeCredentials, [{ type: "public-key", id: auth.id }]);
  assert.equal((await call(passkey, env, "POST", { step: "register", player: A, credential: await auth.create(again) }))[0], 409);
});

test("sign-in checks the signature, challenge, origin, presence and counter", async () => {
  const env = { DB: testDb() };
  const auth = await authenticator();
  await save(env, auth);

  assert.equal((await signIn(env, auth, B, { tamper: true }))[0], 401);
  assert.equal((await signIn(env, auth, B, { origin: "https://evil.test" }))[0], 401);
  assert.equal((await signIn(env, auth, B, { rpId: "evil.test" }))[0], 401);
  assert.equal((await signIn(env, auth, B, { flags: 0x04 }))[0], 401, "user not present");
  const stranger = await authenticator();
  assert.equal((await signIn(env, stranger, B))[0], 401, "a passkey the server doesn't know");

  // Replaying a used challenge fails.
  const [, o] = await call(passkey, env, "POST", { step: "login-options" });
  const cred = await auth.get(o);
  assert.equal((await call(passkey, env, "POST", { step: "login", player: B, credential: cred }))[0], 200);
  assert.equal((await call(passkey, env, "POST", { step: "login", player: B, credential: cred }))[0], 401);

  // Too many failures from one IP.
  const statuses = [];
  for (let i = 0; i < 5; i++) statuses.push((await signIn(env, auth, B, { tamper: true }))[0]); // 6 failures so far, 10 allowed
  assert.deepEqual(statuses.slice(-2), [401, 429]);
  assert.equal((await signIn(env, auth, B, {}, "9.9.9.9"))[0], 200, "another IP still works");
});

test("a player with no scores yet keeps the name saved with the passkey", async () => {
  const env = { DB: testDb() };
  const auth = await authenticator();
  await save(env, auth, A, "Ann");
  const [, body] = await signIn(env, auth, B);
  assert.equal(body.name, "Ann");
});

test("an authenticator with a counter must count up", async () => {
  const env = { DB: testDb() };
  const auth = await authenticator(-7, { counter: 5 });
  await save(env, auth);
  assert.equal((await signIn(env, auth))[0], 200);
  auth.setCount(3); // a copy of the key, behind the original
  assert.equal((await signIn(env, auth))[0], 401);
});

test("authenticator data is parsed with and without a credential", async () => {
  assert.equal(parseAuthData(new Uint8Array(10)), null);
  const plain = parseAuthData(new Uint8Array([...new Uint8Array(32), 0x05, 0, 0, 1, 2]));
  assert.equal(plain.flags, 5);
  assert.equal(plain.signCount, 258);
  assert.equal(plain.credentialId, undefined);
  assert.equal(parseAuthData(new Uint8Array([...new Uint8Array(32), 0x45, 0, 0, 0, 0, ...new Uint8Array(16), 0, 9, 1])), null, "credential id cut short");
});
