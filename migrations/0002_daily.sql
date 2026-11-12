-- Daily challenge: one shared Hard puzzle per day (German time).
-- Daily solves go in `scores` with the puzzle's date; other solves leave it NULL.
ALTER TABLE scores ADD COLUMN daily TEXT;
CREATE INDEX IF NOT EXISTS scores_daily ON scores (daily);

-- The first puzzle hash posted for a day. Later daily entries must match it.
CREATE TABLE IF NOT EXISTS daily (
  date       TEXT    PRIMARY KEY,           -- YYYY-MM-DD, German time
  puzzle     TEXT    NOT NULL,              -- puzzle hash, as in scores.puzzle
  created_at INTEGER NOT NULL               -- unix seconds
);
