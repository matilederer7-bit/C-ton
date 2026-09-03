-- 063 — R9C remediation: ONE durable lifecycle per logical money operation.
--
-- Independent review (docs/R9C_CODEX_INDEPENDENT_REVIEW.md) proved two
-- double-money paths on the R9C branch:
--   C1  a capture request already in flight raced its own reconciliation;
--       reconciliation read "authorized/final", declared charge_failed and
--       scheduled recovery; capture + recovery both moved money.
--   C2  the provider moved money and then answered HTTP 503/429; the adapter
--       called that temporary_fail, the outbox retried and a FRESH capture
--       identity moved money again.
--
-- Root cause: siton.payment_attempts knew the identity of an operation but not
-- its dispatch lifecycle. "result_class = unknown" conflated NOT-DISPATCHED,
-- IN-FLIGHT and POST-DISPATCH-AMBIGUOUS, so a reconciler could not tell that a
-- negative provider observation was racing a live request, and a worker could
-- not tell that a temporary failure arrived AFTER dispatch.
--
-- This migration makes the lifecycle durable and DB-enforced:
--
--   dispatch_state  'recorded'    identity minted, no request has left the process
--                   'dispatching' a worker holding outbox lease (owner_event_uuid,
--                                 owner_lease_generation) has armed provider I/O;
--                                 the request may be in flight
--                   'responded'   the client side of the request is over
--   result_class    'unknown'        unresolved (any dispatch_state)
--                   'success'        provider-declared executed
--                   'permanent_fail' provider-declared / authoritatively NOT executed
--                   'temporary_fail' legacy value; new rows never end here after
--                                    dispatch (post-dispatch ambiguity = unknown)
--
-- siton.payment_operation_in_flight(owner, generation) is TRUE while the owning
-- outbox job still holds a live lease. Guards:
--   * terminal truth never downgrades (success/permanent_fail -> unknown is
--     rejected; success is never overwritten by permanent_fail)
--   * nobody but the dispatching owner may declare a NEGATIVE result, re-arm or
--     disarm an operation that is in flight (C1 — DB-authoritative)
--   * no new identity of the same money type while a prior one is unresolved
--     (C2 — identity rotation is impossible, whatever the outbox does)
--   * recovery / refund / release may not be minted while a capture-side
--     operation is unresolved, and recovery/release never while a capture is
--     recorded as SUCCESS (money already moved)
--
-- The 050 rolling three-attempt cap and the 012 unique logical identity are
-- unchanged. No economics are touched.

BEGIN;

ALTER TABLE siton.payment_attempts
  ADD COLUMN IF NOT EXISTS dispatch_state TEXT NOT NULL DEFAULT 'responded',
  ADD COLUMN IF NOT EXISTS owner_event_uuid UUID NULL,
  ADD COLUMN IF NOT EXISTS owner_lease_generation INTEGER NULL,
  ADD COLUMN IF NOT EXISTS dispatched_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS provider_reference TEXT NULL,
  ADD COLUMN IF NOT EXISTS outcome_note TEXT NULL,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE siton.payment_attempts
  DROP CONSTRAINT IF EXISTS payment_attempts_dispatch_state_check;
ALTER TABLE siton.payment_attempts
  ADD CONSTRAINT payment_attempts_dispatch_state_check
  CHECK (dispatch_state IN ('recorded', 'dispatching', 'responded'));

-- Legacy rows: a terminal result is by definition responded; an unresolved
-- legacy 'unknown' row keeps the conservative default 'responded' (it must be
-- resolved through authoritative status before its identity may be reused).
UPDATE siton.payment_attempts
SET resolved_at = COALESCE(resolved_at, created_at)
WHERE result_class IN ('success', 'permanent_fail', 'temporary_fail')
  AND resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS payment_attempts_unresolved_idx
  ON siton.payment_attempts (participant_id, deal_id)
  WHERE result_class = 'unknown';

-- ---------------------------------------------------------------------------
-- In-flight predicate: the owning outbox job still holds a live lease.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION siton.payment_operation_in_flight(
  p_owner_event_uuid uuid,
  p_owner_lease_generation integer
)
RETURNS boolean
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT p_owner_event_uuid IS NOT NULL
     AND p_owner_lease_generation IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM siton.outbox_events o
       WHERE o.event_uuid = p_owner_event_uuid
         AND o.lease_generation = p_owner_lease_generation
         AND o.status = 'processing'
         AND o.lease_expires_at IS NOT NULL
         AND o.lease_expires_at > clock_timestamp()
     );
$$;

-- ---------------------------------------------------------------------------
-- UPDATE guard: terminal truth is monotonic; an in-flight operation may only
-- be settled NEGATIVELY, re-armed or disarmed by its dispatching owner (the
-- owner identifies itself through set_config('siton.payment_dispatch_owner',
-- '<event_uuid>:<lease_generation>', true) inside its own transaction).
-- SUCCESS is provider truth and is always admitted.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION siton.guard_payment_attempt_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  owner_setting text := current_setting('siton.payment_dispatch_owner', true);
  old_owner text := CASE
    WHEN OLD.owner_event_uuid IS NULL OR OLD.owner_lease_generation IS NULL THEN NULL
    ELSE OLD.owner_event_uuid::text || ':' || OLD.owner_lease_generation::text
  END;
  old_in_flight boolean;
BEGIN
  NEW.updated_at := clock_timestamp();

  IF OLD.result_class = 'success' AND NEW.result_class <> 'success' THEN
    RAISE EXCEPTION
      'payment_attempt_terminal_downgrade: % % may not leave success (attempted %)',
      OLD.attempt_type, OLD.correlation_id, NEW.result_class
      USING ERRCODE = 'SN409';
  END IF;
  IF OLD.result_class = 'permanent_fail' AND NEW.result_class NOT IN ('permanent_fail', 'success') THEN
    RAISE EXCEPTION
      'payment_attempt_terminal_downgrade: % % may not leave permanent_fail (attempted %)',
      OLD.attempt_type, OLD.correlation_id, NEW.result_class
      USING ERRCODE = 'SN409';
  END IF;

  old_in_flight := OLD.dispatch_state = 'dispatching'
    AND siton.payment_operation_in_flight(OLD.owner_event_uuid, OLD.owner_lease_generation);

  IF old_in_flight AND (owner_setting IS NULL OR owner_setting IS DISTINCT FROM old_owner) THEN
    IF NEW.result_class IN ('permanent_fail', 'temporary_fail') THEN
      RAISE EXCEPTION
        'payment_attempt_in_flight_negative_settle: % % is dispatching under a live lease; a negative outcome may not be declared while the request may be in flight',
        OLD.attempt_type, OLD.correlation_id
        USING ERRCODE = 'SN409';
    END IF;
    IF NEW.dispatch_state = 'dispatching'
       AND (NEW.owner_event_uuid IS DISTINCT FROM OLD.owner_event_uuid
            OR NEW.owner_lease_generation IS DISTINCT FROM OLD.owner_lease_generation) THEN
      RAISE EXCEPTION
        'payment_attempt_dispatch_in_flight: % % is already dispatching under a live lease',
        OLD.attempt_type, OLD.correlation_id
        USING ERRCODE = 'SN409';
    END IF;
    IF NEW.dispatch_state = 'recorded' THEN
      RAISE EXCEPTION
        'payment_attempt_in_flight_disarm: % % may only be disarmed by its dispatching owner',
        OLD.attempt_type, OLD.correlation_id
        USING ERRCODE = 'SN409';
    END IF;
  END IF;

  IF NEW.result_class IN ('success', 'permanent_fail') THEN
    IF NEW.resolved_at IS NULL THEN NEW.resolved_at := clock_timestamp(); END IF;
    NEW.dispatch_state := 'responded';
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_payment_attempts_lifecycle_guard ON siton.payment_attempts;
CREATE TRIGGER trg_payment_attempts_lifecycle_guard
BEFORE UPDATE ON siton.payment_attempts
FOR EACH ROW
EXECUTE FUNCTION siton.guard_payment_attempt_lifecycle();

-- ---------------------------------------------------------------------------
-- INSERT guard: a NEW money-operation identity may only be minted when no
-- prior operation that could conflict with it is unresolved. Idempotent
-- replays of an existing identity are admitted unchanged (the single insert
-- site uses ON CONFLICT DO NOTHING). Serialized per (participant, deal) with
-- the same advisory lock migration 050 takes.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION siton.guard_payment_attempt_eligibility()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.attempt_type NOT IN ('charge_start', 'recovery', 'refund', 'cancel_refund', 'release') THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1 FROM siton.payment_attempts existing
    WHERE existing.participant_id = NEW.participant_id
      AND existing.deal_id = NEW.deal_id
      AND existing.attempt_type = NEW.attempt_type
      AND existing.correlation_id = NEW.correlation_id
  ) THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(NEW.participant_id::text || ':' || NEW.deal_id::text, 0)
  );

  IF EXISTS (
    SELECT 1 FROM siton.payment_attempts existing
    WHERE existing.participant_id = NEW.participant_id
      AND existing.deal_id = NEW.deal_id
      AND existing.attempt_type = NEW.attempt_type
      AND existing.correlation_id = NEW.correlation_id
  ) THEN
    RETURN NEW;
  END IF;

  -- Same money type: never rotate identity while a prior operation is unresolved
  -- (unknown) or already executed (success never persisted into state).
  IF EXISTS (
    SELECT 1 FROM siton.payment_attempts prior
    WHERE prior.participant_id = NEW.participant_id
      AND prior.deal_id = NEW.deal_id
      AND prior.attempt_type = NEW.attempt_type
      AND prior.result_class IN ('unknown', 'success')
  ) THEN
    RAISE EXCEPTION
      'payment_attempt_identity_rotation_blocked: participant % deal % has an unresolved or executed % operation; the SAME identity must be resolved first',
      NEW.participant_id, NEW.deal_id, NEW.attempt_type
      USING ERRCODE = 'SN409';
  END IF;

  -- Recovery is a second capture of the same obligation: forbidden while the
  -- original capture is unresolved or recorded as executed.
  IF NEW.attempt_type = 'recovery' AND EXISTS (
    SELECT 1 FROM siton.payment_attempts prior
    WHERE prior.participant_id = NEW.participant_id
      AND prior.deal_id = NEW.deal_id
      AND prior.attempt_type = 'charge_start'
      AND prior.result_class IN ('unknown', 'success')
  ) THEN
    RAISE EXCEPTION
      'recovery_blocked_by_unresolved_capture: participant % deal % has a charge_start operation that is unresolved or succeeded',
      NEW.participant_id, NEW.deal_id
      USING ERRCODE = 'SN409';
  END IF;

  -- Refund / release must not begin while any capture-side operation is
  -- unresolved; release never while a capture is recorded as executed.
  IF NEW.attempt_type IN ('refund', 'cancel_refund', 'release') AND EXISTS (
    SELECT 1 FROM siton.payment_attempts prior
    WHERE prior.participant_id = NEW.participant_id
      AND prior.deal_id = NEW.deal_id
      AND prior.attempt_type IN ('charge_start', 'recovery')
      AND prior.result_class = 'unknown'
  ) THEN
    RAISE EXCEPTION
      'money_operation_blocked_by_unresolved_capture: participant % deal % has an unresolved capture-side operation; % may not start',
      NEW.participant_id, NEW.deal_id, NEW.attempt_type
      USING ERRCODE = 'SN409';
  END IF;

  IF NEW.attempt_type = 'release' AND EXISTS (
    SELECT 1 FROM siton.payment_attempts prior
    WHERE prior.participant_id = NEW.participant_id
      AND prior.deal_id = NEW.deal_id
      AND prior.attempt_type IN ('charge_start', 'recovery')
      AND prior.result_class = 'success'
  ) THEN
    RAISE EXCEPTION
      'release_blocked_by_captured_money: participant % deal % has an executed capture; the hold cannot be released',
      NEW.participant_id, NEW.deal_id
      USING ERRCODE = 'SN409';
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_payment_attempts_eligibility ON siton.payment_attempts;
CREATE TRIGGER trg_payment_attempts_eligibility
BEFORE INSERT ON siton.payment_attempts
FOR EACH ROW
EXECUTE FUNCTION siton.guard_payment_attempt_eligibility();

DO $lifecycle_selfcheck$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_payment_attempts_lifecycle_guard' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'payment attempt lifecycle guard trigger was not installed';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_payment_attempts_eligibility' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'payment attempt eligibility trigger was not installed';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'siton' AND p.proname = 'payment_operation_in_flight'
  ) THEN
    RAISE EXCEPTION 'payment_operation_in_flight predicate was not installed';
  END IF;
END
$lifecycle_selfcheck$;

COMMIT;
