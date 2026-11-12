-- Streaks on the server, so they survive cleared browser data and follow a
-- player to other devices. One row per player per day a daily was finished
-- (any finished run counts, as in the browser). Days with a daily entry in
-- `scores` count too, so they don't need a row here.
CREATE TABLE IF NOT EXISTS days (
  player     TEXT    NOT NULL,              -- as in scores.player
  date       TEXT    NOT NULL,              -- YYYY-MM-DD, German time
  ip         TEXT    NOT NULL,              -- salted hash, only for rate limiting
  created_at INTEGER NOT NULL,              -- unix seconds
  PRIMARY KEY (player, date)
);
CREATE INDEX IF NOT EXISTS days_ip_created ON days (ip, created_at);

-- Short one-time codes that move a player's progress to another device.
CREATE TABLE IF NOT EXISTS sync_codes (
  code       TEXT    PRIMARY KEY,           -- 8 characters, shown as ABCD-EFGH
  player     TEXT    NOT NULL UNIQUE,       -- the player the code hands over
  name       TEXT    NOT NULL,              -- their display name ('' if none yet)
  created_at INTEGER NOT NULL               -- unix seconds; codes expire after 15 minutes
);
CREATE INDEX IF NOT EXISTS sync_codes_created ON sync_codes (created_at);

-- Recent code requests and failed code entries, for rate limiting.
CREATE TABLE IF NOT EXISTS sync_tries (
  ip         TEXT    NOT NULL,              -- salted hash
  kind       TEXT    NOT NULL,              -- make | miss
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sync_tries_ip ON sync_tries (ip, kind, created_at);
