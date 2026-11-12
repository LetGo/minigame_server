-- 实例标识只代表本地数据实例；历史记录和旧会话保持未知。
ALTER TABLE game_login_events ADD COLUMN client_instance_id uuid, ADD COLUMN session_id uuid, ADD COLUMN client_version varchar(64);
ALTER TABLE game_rewarded_video_events ADD COLUMN client_instance_id uuid, ADD COLUMN session_id uuid;
CREATE INDEX game_login_events_session_idx ON game_login_events(app_id,user_id,session_id);

-- 不保存存档正文或令牌，仅记录成功读写所见的版本与会话。
CREATE TABLE game_save_access_events (
  id uuid PRIMARY KEY,
  app_id varchar(32) NOT NULL,
  user_id uuid NOT NULL,
  operation varchar(4) NOT NULL CHECK (operation IN ('get','save')),
  version integer NOT NULL CHECK (version >= 0),
  client_instance_id uuid,
  session_id uuid,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (app_id,user_id) REFERENCES game_users(app_id,id) ON DELETE CASCADE
);
CREATE INDEX game_save_access_events_user_idx ON game_save_access_events(app_id,user_id,recorded_at DESC);
