-- Client-reported completions for analytics only; not authoritative reward settlement.
CREATE TABLE game_rewarded_video_events (
 app_id varchar(32) NOT NULL,
 user_id uuid NOT NULL,
 event_id uuid NOT NULL,
 placement varchar(64) NOT NULL,
 client_info jsonb NOT NULL DEFAULT '{}'::jsonb,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY (app_id,user_id,event_id),
 FOREIGN KEY (app_id,user_id) REFERENCES game_users(app_id,id) ON DELETE CASCADE,
 CHECK (char_length(placement) BETWEEN 1 AND 64 AND placement=btrim(placement)),
 CHECK (placement !~ '[[:cntrl:]]' AND octet_length(placement)<=256),
 CHECK (jsonb_typeof(client_info)='object'),
 -- JSONB adds spaces when serializing; API limits compact input to 8192 bytes.
 CHECK (octet_length(client_info::text)<=16384)
);
CREATE INDEX game_rewarded_video_events_app_time_idx ON game_rewarded_video_events(app_id,recorded_at DESC);
CREATE INDEX game_rewarded_video_events_placement_time_idx ON game_rewarded_video_events(app_id,placement,recorded_at DESC);
