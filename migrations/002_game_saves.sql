CREATE TABLE game_saves (
  user_id uuid PRIMARY KEY REFERENCES game_users(id) ON DELETE CASCADE,
  data text NOT NULL CHECK (octet_length(data) <= 65536),
  version integer NOT NULL CHECK (version >= 1),
  updated_at timestamptz NOT NULL DEFAULT now()
);
