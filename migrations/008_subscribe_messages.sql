-- Client callback observations only. These are NOT verified WeChat send credits.
CREATE TABLE game_subscription_reports (
 app_id varchar(32) NOT NULL,
 user_id uuid NOT NULL,
 event_id uuid NOT NULL,
 template_id varchar(128) NOT NULL,
 status text NOT NULL CHECK (status IN ('accept','reject','ban','filter')),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY (app_id,user_id,event_id),
 FOREIGN KEY (app_id,user_id) REFERENCES game_users(app_id,id) ON DELETE CASCADE
);
CREATE INDEX game_subscription_reports_latest_idx ON game_subscription_reports(app_id,user_id,template_id,recorded_at DESC,event_id DESC);

-- Durable operator-only receipts; no automatic worker or retry queue.
CREATE TABLE game_subscription_sends (
 app_id varchar(32) NOT NULL,
 request_id uuid NOT NULL,
 user_id uuid NOT NULL,
 template_id varchar(128) NOT NULL,
 page varchar(512) NOT NULL,
 state text NOT NULL CHECK (state IN ('sending','sent','failed','unknown')),
 upstream_code integer,
 started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 finished_at timestamptz,
 PRIMARY KEY (app_id,request_id),
 FOREIGN KEY (app_id,user_id) REFERENCES game_users(app_id,id) ON DELETE CASCADE,
 CHECK ((state='sending') = (finished_at IS NULL))
);
-- Uncertain sends must be investigated, not repeated under a different request ID.
CREATE UNIQUE INDEX game_subscription_sends_pending_idx ON game_subscription_sends(app_id,user_id) WHERE state IN ('sending','unknown');
