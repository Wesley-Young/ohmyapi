-- Historical financial records and initialized billing conventions are append-only.
CREATE FUNCTION reject_historical_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% records cannot be updated or deleted', TG_TABLE_NAME;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER wallet_ledger_immutable BEFORE UPDATE OR DELETE ON wallet_ledger
FOR EACH ROW EXECUTE FUNCTION reject_historical_mutation();
--> statement-breakpoint
CREATE TRIGGER admin_audit_logs_immutable BEFORE UPDATE OR DELETE ON admin_audit_logs
FOR EACH ROW EXECUTE FUNCTION reject_historical_mutation();
--> statement-breakpoint
CREATE TRIGGER system_settings_immutable BEFORE UPDATE OR DELETE ON system_settings
FOR EACH ROW EXECUTE FUNCTION reject_historical_mutation();
--> statement-breakpoint
-- Serialize draft-rule edits with publication of their parent version.
CREATE FUNCTION guard_price_rule_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  version_id uuid;
  version_status price_status;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.price_version_id <> OLD.price_version_id THEN
    RAISE EXCEPTION 'Price rules cannot be moved between versions';
  END IF;
  IF TG_OP = 'DELETE' THEN version_id := OLD.price_version_id;
  ELSE version_id := NEW.price_version_id;
  END IF;
  SELECT status INTO version_status FROM price_versions WHERE id = version_id FOR UPDATE;
  IF version_status = 'published' THEN
    RAISE EXCEPTION 'Published price rules are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER price_rules_guard BEFORE INSERT OR UPDATE OR DELETE ON price_rules
FOR EACH ROW EXECUTE FUNCTION guard_price_rule_mutation();
--> statement-breakpoint
CREATE FUNCTION guard_price_version_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' AND OLD.status = 'published' THEN
    RAISE EXCEPTION 'Published price versions are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF TG_OP = 'INSERT' AND NEW.status = 'published' THEN
    RAISE EXCEPTION 'Create a draft with rules before publishing';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.status = 'published' THEN
    IF NOT EXISTS (SELECT 1 FROM price_rules WHERE price_version_id = NEW.id AND kind = 'default') THEN
      RAISE EXCEPTION 'Published prices require a default rule';
    END IF;
    IF EXISTS (
      SELECT 1 FROM price_rules a JOIN price_rules b
        ON a.price_version_id = b.price_version_id AND a.kind = b.kind AND a.id < b.id
      WHERE a.price_version_id = NEW.id AND a.kind <> 'default'
        AND (a.kind = 'time' OR (
          (b.context_max IS NULL OR a.context_min < b.context_max)
          AND (a.context_max IS NULL OR b.context_min < a.context_max)
        ))
        AND (a.kind = 'context' OR (
          (a.weekdays_mask & b.weekdays_mask) <> 0
          AND a.start_minute < b.end_minute AND b.start_minute < a.end_minute
        ))
    ) THEN
      RAISE EXCEPTION 'Price rules of the same priority must not overlap';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER price_versions_guard BEFORE INSERT OR UPDATE OR DELETE ON price_versions
FOR EACH ROW EXECUTE FUNCTION guard_price_version_mutation();
