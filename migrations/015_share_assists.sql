-- Daily, distinct helpers for an independent share placement; ordinary referrals are unchanged.
CREATE TABLE game_share_assists (
  app_id varchar(32) NOT NULL,
  share_id varchar(64) NOT NULL CHECK (share_id = 'diapig_invite'),
  inviter_user_id uuid NOT NULL,
  helper_user_id uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  activity_date date GENERATED ALWAYS AS ((recorded_at AT TIME ZONE 'Asia/Shanghai')::date) STORED,
  PRIMARY KEY (app_id, share_id, inviter_user_id, activity_date, helper_user_id),
  FOREIGN KEY (app_id, inviter_user_id) REFERENCES game_users(app_id, id) ON DELETE CASCADE,
  FOREIGN KEY (app_id, helper_user_id) REFERENCES game_users(app_id, id) ON DELETE CASCADE,
  CHECK (inviter_user_id <> helper_user_id)
);
