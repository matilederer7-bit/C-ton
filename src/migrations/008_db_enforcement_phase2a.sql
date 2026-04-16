BEGIN;

SET search_path TO siton, public;

CREATE OR REPLACE FUNCTION siton.flag_is_set(flag_name text)
RETURNS boolean
LANGUAGE sql
AS $$
  SELECT COALESCE(current_setting(flag_name, true), '') = '1'
$$;

CREATE OR REPLACE FUNCTION siton.is_valid_action_name(action_name text)
RETURNS boolean
LANGUAGE sql
AS $$
  SELECT COALESCE(action_name, '') LIKE 'test.%'
    OR COALESCE(action_name, '') IN (
      'participant.join_authorize',
      'deal.publish',
      'deal.target_reached',
      'deal.close_joining',
      'deal.prepare_charging',
      'charging.start',
      'charging.capture_success',
      'charging.capture_failed',
      'charging.recovery_success',
      'charging.recovery_failed',
      'charging.to_completion_window',
      'charging.finalize_completed',
      'charging.finalize_failed',
      'deal.complete_participant',
      'deal.fail_participant',
      'deal.fail_participant_after_completed',
      'deal.deadline_check',
      'deal.cancel',
      'refund.issue'
    )
$$;

CREATE OR REPLACE FUNCTION siton.is_valid_deal_transition(v_from text, v_to text)
RETURNS boolean
LANGUAGE sql
AS $$
  SELECT CASE
    WHEN v_from = 'Draft' AND v_to IN ('PendingTarget', 'Cancelled') THEN true
    WHEN v_from = 'PendingTarget' AND v_to IN ('TargetReached', 'Failed') THEN true
    WHEN v_from = 'TargetReached' AND v_to = 'ClosedForJoining' THEN true
    WHEN v_from = 'ClosedForJoining' AND v_to = 'ReadyForCharging' THEN true
    WHEN v_from = 'ReadyForCharging' AND v_to = 'Charging' THEN true
    WHEN v_from = 'Charging' AND v_to = 'CompletionWindow' THEN true
    WHEN v_from = 'CompletionWindow' AND v_to IN ('Completed', 'Failed') THEN true
    ELSE false
  END
$$;

CREATE OR REPLACE FUNCTION siton.is_valid_buyer_transition(v_from text, v_to text)
RETURNS boolean
LANGUAGE sql
AS $$
  SELECT CASE
    WHEN v_from = 'NotJoined' AND v_to IN ('JoinedAuthorized', 'DealFailed') THEN true
    WHEN v_from = 'JoinedAuthorized' AND v_to IN ('LockedIn', 'DealFailed') THEN true
    WHEN v_from = 'LockedIn' AND v_to IN ('ChargingAttempt', 'DealFailed') THEN true
    WHEN v_from = 'ChargingAttempt' AND v_to IN ('ChargedSuccess', 'ChargeFailedCompletion', 'DealFailed') THEN true
    WHEN v_from = 'ChargeFailedCompletion' AND v_to IN ('Recovered', 'Dropped', 'DealFailed') THEN true
    WHEN v_from = 'ChargedSuccess' AND v_to IN ('DealCompleted', 'DealFailed') THEN true
    WHEN v_from = 'Recovered' AND v_to IN ('DealCompleted', 'DealFailed') THEN true
    WHEN v_from = 'Dropped' AND v_to = 'DealFailed' THEN true
    ELSE false
  END
$$;

CREATE OR REPLACE FUNCTION siton.is_valid_money_transition(v_from text, v_to text)
RETURNS boolean
LANGUAGE sql
AS $$
  SELECT CASE
    WHEN v_from = 'NoFinancial' AND v_to = 'AuthHeld' THEN true
    WHEN v_from = 'AuthHeld' AND v_to = 'AuthLocked' THEN true
    WHEN v_from = 'AuthLocked' AND v_to = 'ChargeAttempt' THEN true
    WHEN v_from = 'ChargeAttempt' AND v_to IN ('ChargedSuccess', 'ChargeFailedRecovery') THEN true
    WHEN v_from = 'ChargeFailedRecovery' AND v_to IN ('RecoveredCharge', 'AuthReleased') THEN true
    WHEN v_from IN ('ChargedSuccess', 'RecoveredCharge') AND v_to = 'Refunded' THEN true
    ELSE false
  END
$$;

CREATE OR REPLACE FUNCTION siton.is_valid_transition(v_state_type text, v_from text, v_to text)
RETURNS boolean
LANGUAGE sql
AS $$
  SELECT CASE
    WHEN v_state_type = 'deal_state' THEN siton.is_valid_deal_transition(v_from, v_to)
    WHEN v_state_type = 'buyer_state' THEN siton.is_valid_buyer_transition(v_from, v_to)
    WHEN v_state_type = 'money_state' THEN siton.is_valid_money_transition(v_from, v_to)
    ELSE false
  END
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
  IF NOT siton.is_valid_action_name(v) THEN
    RAISE EXCEPTION 'invalid siton.action_name in current transaction: %', v;
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

    IF NOT siton.is_valid_deal_transition(OLD.state::text, NEW.state::text) THEN
      RAISE EXCEPTION 'illegal deal transition from=% to=% action=%', OLD.state, NEW.state, v_action;
    END IF;

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

    IF NEW.buyer_state IS DISTINCT FROM OLD.buyer_state
       AND NOT siton.is_valid_buyer_transition(OLD.buyer_state::text, NEW.buyer_state::text) THEN
      RAISE EXCEPTION 'illegal participant buyer_state transition % -> % action=%', OLD.buyer_state, NEW.buyer_state, v_action;
    END IF;

    IF NEW.money_state IS DISTINCT FROM OLD.money_state
       AND NOT siton.is_valid_money_transition(OLD.money_state::text, NEW.money_state::text) THEN
      RAISE EXCEPTION 'illegal participant money_state transition % -> % action=%', OLD.money_state, NEW.money_state, v_action;
    END IF;

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

CREATE OR REPLACE FUNCTION siton.audit_log_before_insert_enforce()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.entity_type = 'deal' AND NEW.state_type <> 'deal_state' THEN
    RAISE EXCEPTION 'audit_log entity_type/state_type mismatch for deal';
  END IF;

  IF NEW.entity_type = 'participant' AND NEW.state_type NOT IN ('buyer_state', 'money_state') THEN
    RAISE EXCEPTION 'audit_log entity_type/state_type mismatch for participant';
  END IF;

  IF btrim(COALESCE(NEW.action_name, '')) = '' OR NOT siton.is_valid_action_name(NEW.action_name) THEN
    RAISE EXCEPTION 'audit_log action_name is invalid: %', NEW.action_name;
  END IF;

  IF NEW.from_state = NEW.to_state THEN
    RAISE EXCEPTION 'audit_log from_state must differ from to_state';
  END IF;

  IF NOT siton.is_valid_transition(NEW.state_type, NEW.from_state, NEW.to_state) THEN
    RAISE EXCEPTION 'audit_log illegal transition state_type=% from=% to=%', NEW.state_type, NEW.from_state, NEW.to_state;
  END IF;

  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION siton.audit_log_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END
$$;

DROP TRIGGER IF EXISTS trg_audit_log_before_insert_enforce ON siton.audit_log;
CREATE TRIGGER trg_audit_log_before_insert_enforce
BEFORE INSERT ON siton.audit_log
FOR EACH ROW
EXECUTE FUNCTION siton.audit_log_before_insert_enforce();

DROP TRIGGER IF EXISTS trg_audit_log_append_only_update ON siton.audit_log;
CREATE TRIGGER trg_audit_log_append_only_update
BEFORE UPDATE ON siton.audit_log
FOR EACH ROW
EXECUTE FUNCTION siton.audit_log_append_only();

DROP TRIGGER IF EXISTS trg_audit_log_append_only_delete ON siton.audit_log;
CREATE TRIGGER trg_audit_log_append_only_delete
BEFORE DELETE ON siton.audit_log
FOR EACH ROW
EXECUTE FUNCTION siton.audit_log_append_only();

COMMIT;
