-- Passkeys: an optional way back to a player's progress, kept by the player's
-- password manager. The server only has the public key.
CREATE TABLE IF NOT EXISTS passkeys (
  id         TEXT    PRIMARY KEY,           -- credential id, base64url
  player     TEXT    NOT NULL,              -- as in scores.player
  name       TEXT    NOT NULL,              -- display name when saved ('' if none), used if they have no scores
  public_key TEXT    NOT NULL,              -- SPKI, base64url
  alg        INTEGER NOT NULL,              -- COSE algorithm: -7 (ES256) or -257 (RS256)
  sign_count INTEGER NOT NULL,              -- last signature counter (0 for synced passkeys)
  created_at INTEGER NOT NULL,              -- unix seconds
  used_at    INTEGER                        -- last sign-in, unix seconds
);
CREATE INDEX IF NOT EXISTS passkeys_player ON passkeys (player);

-- One-time challenges for saving or using a passkey; they expire after 5 minutes.
CREATE TABLE IF NOT EXISTS passkey_challenges (
  challenge  TEXT    PRIMARY KEY,           -- 32 random bytes, base64url
  kind       TEXT    NOT NULL,              -- register | login
  player     TEXT,                          -- the player saving a passkey (register only)
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS passkey_challenges_created ON passkey_challenges (created_at);
