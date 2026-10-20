-- Add scheduled_date to game_subscription_sends for daily check-in scheduling
ALTER TABLE game_subscription_sends ADD COLUMN scheduled_date date;

-- Ensure that for a given app/user and scheduled_date, there is at most one send (when scheduled_date is not null)
CREATE UNIQUE INDEX game_subscription_sends_scheduled_idx ON game_subscription_sends(app_id, user_id, scheduled_date) WHERE scheduled_date IS NOT NULL;