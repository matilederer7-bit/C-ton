BEGIN;

SET search_path TO siton, public;

CREATE OR REPLACE FUNCTION siton.flag_is_set(flag_name text)
RETURNS boolean
LANGUAGE sql
AS $$
  SELECT COALESCE(current_setting(flag_name, true), '') = '1'
$$;

CREATE OR REPLACE FUNCTION siton.require_action_name()
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v text;
BEGIN
  v := current_setting('siton.action_name', true);
  IF v IS NULL OR btrim(v) = '' THEN
    RAISE EXCEPTION 'missing siton.action_name in current transaction';
  END IF;
  RETURN v;
END
$$;

CREATE OR REPLACE FUNCTION siton.deals_before_update_enforce()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_action text;
BEGIN
  IF OLD.published_at IS NOT NULL AND NEW.published_at IS DISTINCT FROM OLD.published_at THEN
    RAISE EXCEPTION 'deals.published_at is immutable once set';
  END IF;

  IF OLD.published_at IS NOT NULL THEN
    IF NEW.threshold_units IS DISTINCT FROM OLD.threshold_units THEN
      RAISE EXCEPTION 'deals.threshold_units is immutable after publish';
    END IF;

    IF NEW.price_per_unit IS DISTINCT FROM OLD.price_per_unit THEN
      RAISE EXCEPTION 'deals.price_per_unit is immutable after publish';
    END IF;

    IF NEW.min_units IS DISTINCT FROM OLD.min_units THEN
      RAISE EXCEPTION 'deals.min_units is immutable after publish';
    END IF;

    IF NEW.max_units IS DISTINCT FROM OLD.max_units THEN
      RAISE EXCEPTION 'deals.max_units is immutable after publish';
    END IF;

    IF NEW.deadline IS DISTINCT FROM OLD.deadline THEN
      RAISE EXCEPTION 'deals.deadline is immutable after publish';
    END IF;

    IF NEW.commission_rate IS DISTINCT FROM OLD.commission_rate THEN
      RAISE EXCEPTION 'deals.commission_rate is immutable after publish';
    END IF;
  END IF;

  IF OLD.completion_window_until IS NOT NULL
     AND NEW.completion_window_until IS DISTINCT FROM OLD.completion_window_until THEN
    RAISE EXCEPTION 'deals.completion_window_until is immutable once set';
  END IF;

  IF NEW.state IS DISTINCT FROM OLD.state THEN
    v_action := siton.require_action_name();

    IF NOT siton.flag_is_set('siton.audit_written') THEN
      RAISE EXCEPTION 'deal state change requires audit_log in same transaction. action=%', v_action;
    END IF;
  END IF;

  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION siton.participants_before_update_enforce()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_action text;
BEGIN
  IF OLD.locked_at IS NOT NULL AND NEW.locked_at IS DISTINCT FROM OLD.locked_at THEN
    RAISE EXCEPTION 'participants.locked_at is immutable once set';
  END IF;

  IF OLD.locked_at IS NOT NULL AND NEW.qty IS DISTINCT FROM OLD.qty THEN
    RAISE EXCEPTION 'participants.qty is immutable once locked_at is set';
  END IF;

  IF NEW.buyer_state IS DISTINCT FROM OLD.buyer_state
     OR NEW.money_state IS DISTINCT FROM OLD.money_state THEN
    v_action := siton.require_action_name();

    IF NOT siton.flag_is_set('siton.audit_written') THEN
      RAISE EXCEPTION 'participant state change requires audit_log in same transaction. action=%', v_action;
    END IF;
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_deals_before_update_enforce ON siton.deals;
CREATE TRIGGER trg_deals_before_update_enforce
BEFORE UPDATE ON siton.deals
FOR EACH ROW
EXECUTE FUNCTION siton.deals_before_update_enforce();

DROP TRIGGER IF EXISTS trg_participants_before_update_enforce ON siton.participants;
CREATE TRIGGER trg_participants_before_update_enforce
BEFORE UPDATE ON siton.participants
FOR EACH ROW
EXECUTE FUNCTION siton.participants_before_update_enforce();

COMMIT;
