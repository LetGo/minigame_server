-- Unknown historical sources remain NULL; never infer them from later launches.
ALTER TABLE game_users
  ADD COLUMN source_scene integer,
  ADD COLUMN source_scene_reported_at timestamptz,
  ADD CONSTRAINT game_users_source_scene_positive CHECK (source_scene > 0),
  ADD CONSTRAINT game_users_source_scene_pair CHECK (
    (source_scene IS NULL) = (source_scene_reported_at IS NULL)
  );

CREATE FUNCTION prevent_source_scene_rewrite() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.source_scene IS NOT NULL AND (
    NEW.source_scene IS DISTINCT FROM OLD.source_scene OR
    NEW.source_scene_reported_at IS DISTINCT FROM OLD.source_scene_reported_at
  ) THEN
    RAISE EXCEPTION 'Source scene is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER game_users_source_scene_write_once
  BEFORE UPDATE OF source_scene, source_scene_reported_at ON game_users
  FOR EACH ROW EXECUTE FUNCTION prevent_source_scene_rewrite();
