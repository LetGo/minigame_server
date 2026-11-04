-- Additive only: restricted administrative recovery receipts and exact original saves.
-- No cascading FK: a later player deletion must not silently erase recovery evidence.
CREATE TABLE game_dashboard_save_repairs (
 app_id varchar(32) NOT NULL,
 request_id uuid NOT NULL,
 user_id uuid NOT NULL,
 actor varchar(64) NOT NULL,
 reason varchar(200) NOT NULL,
 request_hash char(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
 before_data text NOT NULL CHECK (octet_length(before_data)<=65536),
 after_data text NOT NULL CHECK (octet_length(after_data)<=65536),
 before_version integer NOT NULL CHECK (before_version>=1 AND before_version<2147483647),
 after_version integer NOT NULL CHECK (after_version=before_version+1),
 result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(app_id,request_id)
);
CREATE INDEX game_dashboard_save_repairs_user_time_idx ON game_dashboard_save_repairs(app_id,user_id,created_at DESC);
-- Grant SELECT/INSERT only to a dedicated minigame_save_repair_app role at an
-- explicitly authorized rollout. Existing dashboard and game runtime stay read-only
-- with respect to this audit table. Migration does not enable any writes itself.
