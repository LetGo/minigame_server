-- Per-successful-login scene events.
-- Append-only history: one row for every successful auth.login, with the exact login
-- timestamp and the optional launch scene of that request. Unlike game_daily_logins this
-- is never deduplicated per day, so repeated visits (and their scenes) are retained.
CREATE TABLE game_login_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  app_id varchar(32) NOT NULL,
  user_id uuid NOT NULL,
  login_at timestamptz NOT NULL,
  scene integer,
  FOREIGN KEY (app_id, user_id) REFERENCES game_users(app_id, id) ON DELETE CASCADE,
  CONSTRAINT game_login_events_scene_positive CHECK (scene IS NULL OR scene > 0)
);

-- Per-user historical union/dedupe (e.g. dashboard "logged in since" filtering).
CREATE INDEX game_login_events_app_history_idx ON game_login_events(app_id, user_id, login_at);
-- App-wide newest-first paging, with id as the stable tie-breaker.
CREATE INDEX game_login_events_app_time_idx ON game_login_events(app_id, login_at DESC, id DESC);
