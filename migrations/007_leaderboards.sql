-- Durable highest scores and a coalescing transactional outbox in the same row.
CREATE TABLE game_leaderboard_scores (
  app_id varchar(32) NOT NULL,
  board_type text NOT NULL CHECK (board_type IN ('stage','boss')),
  user_id uuid NOT NULL,
  value integer NOT NULL CHECK (value >= 0),
  dirty boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (app_id, board_type, user_id),
  FOREIGN KEY (app_id,user_id) REFERENCES game_users(app_id,id) ON DELETE CASCADE
);
CREATE INDEX game_leaderboard_pending_idx ON game_leaderboard_scores(app_id,board_type,user_id) WHERE dirty;
