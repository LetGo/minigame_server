-- Existing accounts must stay old when referral tracking is introduced.
ALTER TABLE game_users ADD COLUMN first_login_completed boolean NOT NULL DEFAULT true;
ALTER TABLE game_users ADD CONSTRAINT game_users_app_id_id_key UNIQUE (app_id, id);

CREATE TABLE game_profiles (
  user_id uuid PRIMARY KEY REFERENCES game_users(id) ON DELETE CASCADE,
  nickname varchar(64) NOT NULL,
  avatar_url text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (char_length(nickname) BETWEEN 1 AND 64),
  CHECK (char_length(avatar_url) BETWEEN 1 AND 2048)
);

CREATE TABLE game_invitations (
  app_id varchar(32) NOT NULL,
  inviter_user_id uuid NOT NULL,
  invitee_user_id uuid PRIMARY KEY,
  invited_at timestamptz NOT NULL DEFAULT now(),
  claim_id uuid UNIQUE,
  reward_claimed_at timestamptz,
  FOREIGN KEY (app_id, inviter_user_id) REFERENCES game_users(app_id, id) ON DELETE CASCADE,
  FOREIGN KEY (app_id, invitee_user_id) REFERENCES game_users(app_id, id) ON DELETE CASCADE,
  CHECK (inviter_user_id <> invitee_user_id),
  CHECK ((claim_id IS NULL) = (reward_claimed_at IS NULL))
);
CREATE INDEX game_invitations_inviter_page_idx
  ON game_invitations (app_id, inviter_user_id, invited_at DESC, invitee_user_id DESC);
