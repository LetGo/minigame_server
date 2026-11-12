-- 保留旧 UUID 文本；新实例将设备信息用下划线拼接，独立会话仍使用 UUID。
ALTER TABLE game_login_events ALTER COLUMN client_instance_id TYPE varchar(159) USING client_instance_id::text;
ALTER TABLE game_rewarded_video_events ALTER COLUMN client_instance_id TYPE varchar(159) USING client_instance_id::text;
ALTER TABLE game_save_access_events ALTER COLUMN client_instance_id TYPE varchar(159) USING client_instance_id::text;
