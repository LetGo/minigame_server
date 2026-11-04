-- Per-invitee daily video reward receipts. One friend can be rewarded once per
-- Beijing calendar statistics day; historical rows are kept forever.
-- The primary key also guarantees a single inviter receipt per invitee per day.
CREATE TABLE game_invite_video_reward_claims (
  app_id varchar(32) NOT NULL,
  inviter_user_id uuid NOT NULL,
  invitee_user_id uuid NOT NULL,
  reward_date date NOT NULL,
  video_count integer NOT NULL,
  claim_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  claimed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (app_id, invitee_user_id, reward_date),
  FOREIGN KEY (app_id, inviter_user_id) REFERENCES game_users(app_id, id) ON DELETE CASCADE,
  FOREIGN KEY (app_id, invitee_user_id) REFERENCES game_users(app_id, id) ON DELETE CASCADE,
  CHECK (inviter_user_id <> invitee_user_id),
  CHECK (video_count > 0)
);
