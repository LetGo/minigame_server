-- Empty avatar requests are represented by SQL NULL, not an invalid empty URL.
-- Existing nonempty values and the 1..2048 length CHECK are preserved.
ALTER TABLE game_profiles ALTER COLUMN avatar_url DROP NOT NULL;
