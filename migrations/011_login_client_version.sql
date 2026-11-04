-- Latest client-reported version per player identity. Additive and nullable:
-- legacy players and clients that omit the field keep NULL / their prior value.
-- The 64-character limit is enforced by the column type; the grammar mirrors the
-- API validator so a version can never be stored that the API would reject.
ALTER TABLE game_users ADD COLUMN IF NOT EXISTS last_client_version varchar(64);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'game_users'::regclass
      AND conname = 'game_users_last_client_version_format'
  ) THEN
    ALTER TABLE game_users ADD CONSTRAINT game_users_last_client_version_format
      CHECK (last_client_version IS NULL OR last_client_version ~ '^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$');
  END IF;
END
$$;
