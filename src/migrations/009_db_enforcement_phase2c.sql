BEGIN;

SET search_path TO siton, public;

CREATE OR REPLACE FUNCTION siton.deals_outbox_enforce()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_action text;
BEGIN
  IF NEW.state IS DISTINCT FROM OLD.state THEN
    v_action := siton.require_action_name();

    IF v_action IN (
      'deal.publish',
      'charging.start',
      'charging.to_completion_window',
      'charging.finalize_failed',
      'deal.cancel'
    ) THEN
      IF NOT siton.flag_is_set('siton.outbox_written') THEN
        RAISE EXCEPTION 'deal state change requires outbox in same transaction. action=%', v_action;
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_deals_outbox_enforce ON siton.deals;
CREATE TRIGGER trg_deals_outbox_enforce
BEFORE UPDATE ON siton.deals
FOR EACH ROW
EXECUTE FUNCTION siton.deals_outbox_enforce();

COMMIT;
