-- Leaderboard: one row per solved puzzle that was submitted.
CREATE TABLE IF NOT EXISTS scores (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  level      TEXT    NOT NULL,              -- easy | medium | hard | expert | master
  player     TEXT    NOT NULL,              -- random id kept in the player's browser
  name       TEXT    NOT NULL,              -- display name at the time of the solve
  time       INTEGER NOT NULL,              -- seconds
  mistakes   INTEGER NOT NULL,
  hints      INTEGER NOT NULL,
  puzzle     TEXT    NOT NULL,              -- hash of the puzzle, so a solve counts once
  ip         TEXT    NOT NULL,              -- salted hash, only for rate limiting
  created_at INTEGER NOT NULL               -- unix seconds
);
CREATE UNIQUE INDEX IF NOT EXISTS scores_player_puzzle ON scores (player, puzzle);
CREATE INDEX IF NOT EXISTS scores_level_time ON scores (level, time);
CREATE INDEX IF NOT EXISTS scores_ip_created ON scores (ip, created_at);
