CREATE TABLE game_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id varchar(32) NOT NULL,
  open_id varchar(128) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (app_id, open_id)
);
