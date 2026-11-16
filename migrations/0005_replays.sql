-- Replays: anyone can play the board behind a leaderboard entry again.
-- `seed` is the generator seed of the puzzle (NULL for entries posted before
-- seeds were kept, which can't be replayed). Replays (replay = 1) share the
-- original's `puzzle` hash and only appear on that board's replay list, never
-- on the level board.
ALTER TABLE scores ADD COLUMN seed INTEGER;
ALTER TABLE scores ADD COLUMN replay INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS scores_puzzle ON scores (puzzle, replay);
