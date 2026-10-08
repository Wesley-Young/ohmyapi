CREATE FUNCTION guard_system_settings_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'system_settings records cannot be deleted';
  END IF;
  IF (to_jsonb(NEW) - 'currency') IS DISTINCT FROM (to_jsonb(OLD) - 'currency') THEN
    RAISE EXCEPTION 'Only system_settings.currency can be updated';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER system_settings_immutable ON system_settings;
--> statement-breakpoint
CREATE TRIGGER system_settings_immutable BEFORE UPDATE OR DELETE ON system_settings
FOR EACH ROW EXECUTE FUNCTION guard_system_settings_mutation();
