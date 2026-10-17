-- Login-success DAU, not online users or general authenticated API activity.
CREATE TABLE game_daily_logins (
  app_id varchar(32) NOT NULL,
  user_id uuid NOT NULL,
  activity_date date NOT NULL,
  first_login_at timestamptz NOT NULL,
  PRIMARY KEY (app_id, activity_date, user_id),
  FOREIGN KEY (app_id, user_id) REFERENCES game_users(app_id, id) ON DELETE CASCADE,
  CHECK (activity_date = (first_login_at AT TIME ZONE 'Asia/Shanghai')::date)
);
CREATE INDEX game_daily_logins_user_history_idx ON game_daily_logins(user_id, activity_date DESC);
CREATE INDEX game_users_app_registration_idx ON game_users(app_id, created_at);

CREATE TABLE game_analytics_metadata (
  id boolean PRIMARY KEY CHECK (id),
  tracking_started_at timestamptz NOT NULL,
  coverage_start date NOT NULL
);
INSERT INTO game_analytics_metadata(id, tracking_started_at, coverage_start)
VALUES (true, clock_timestamp(), (clock_timestamp() AT TIME ZONE 'Asia/Shanghai')::date);

-- Current-day last_login_at is proof of a login today. Older daily history is unknown.
INSERT INTO game_daily_logins(app_id, user_id, activity_date, first_login_at)
SELECT app_id, id, (last_login_at AT TIME ZONE 'Asia/Shanghai')::date, last_login_at
FROM game_users
WHERE first_login_completed = true
  AND (last_login_at AT TIME ZONE 'Asia/Shanghai')::date =
      (SELECT coverage_start FROM game_analytics_metadata WHERE id = true);
