-- 050 — Literal rolling 30-minute charge/recovery attempt cap.
--
-- Canonical Siton money invariant: a participant may be subjected to at most
-- THREE applicable charge/recovery provider attempts per deal within any
-- rolling 30-minute window. This is enforced at the authoritative database
-- boundary so neither the Web runtime nor the Worker runtime — both of which
-- hold INSERT on siton.payment_attempts — can bypass it, and so concurrent
-- workers cannot race past the cap.
--
-- One row in siton.payment_attempts (one distinct correlation_id) is exactly
-- one real provider attempt. Idempotent replays reuse the same correlation_id
-- and are admitted unchanged (the ON CONFLICT DO NOTHING at the single insert
-- site makes them no-ops); only a genuinely new provider attempt carries a new
-- correlation_id and is counted. The application encodes the outbox
-- attempt_count into the correlation_id so every real retry is a distinct
-- attempt while a same-claim reprocess stays idempotent.
--
-- This complements — it does not replace — the outbox attempt caps, capped
-- exponential backoff, DLQ and UNKNOWN→reconciliation exits. Those bound the
-- machinery; this encodes the literal time-windowed business invariant.

-- Window query support: count charge_start + recovery rows for a
-- (participant, deal) by recency.
CREATE INDEX IF NOT EXISTS payment_attempts_charge_window_idx
  ON siton.payment_attempts (participant_id, deal_id, created_at)
  WHERE attempt_type IN ('charge_start', 'recovery');

CREATE OR REPLACE FUNCTION siton.enforce_charge_attempt_rate_limit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  window_attempts integer;
BEGIN
  -- Only charge/recovery provider attempts are constrained. Refunds,
  -- deadline checks and cancel-refunds are not charge attempts.
  IF NEW.attempt_type NOT IN ('charge_start', 'recovery') THEN
    RETURN NEW;
  END IF;

  -- Idempotent replay: this exact provider attempt already exists. Admit it;
  -- the caller's ON CONFLICT DO NOTHING will make the write a no-op. A replay
  -- is not a new provider attempt and must never consume the allowance.
  IF EXISTS (
    SELECT 1
    FROM siton.payment_attempts existing
    WHERE existing.participant_id = NEW.participant_id
      AND existing.deal_id = NEW.deal_id
      AND existing.attempt_type = NEW.attempt_type
      AND existing.correlation_id = NEW.correlation_id
  ) THEN
    RETURN NEW;
  END IF;

  -- Serialize concurrent NEW attempts for this exact (participant, deal) so two
  -- workers cannot both read "3" and both insert a 4th. The lock is
  -- transaction-scoped and released at COMMIT/ROLLBACK.
  PERFORM pg_advisory_xact_lock(
    hashtextextended(NEW.participant_id::text || ':' || NEW.deal_id::text, 0)
  );

  -- Re-check the idempotency guard now that we hold the lock (a concurrent
  -- transaction may have inserted the same correlation and committed).
  IF EXISTS (
    SELECT 1
    FROM siton.payment_attempts existing
    WHERE existing.participant_id = NEW.participant_id
      AND existing.deal_id = NEW.deal_id
      AND existing.attempt_type = NEW.attempt_type
      AND existing.correlation_id = NEW.correlation_id
  ) THEN
    RETURN NEW;
  END IF;

  SELECT count(*)
    INTO window_attempts
  FROM siton.payment_attempts prior
  WHERE prior.participant_id = NEW.participant_id
    AND prior.deal_id = NEW.deal_id
    AND prior.attempt_type IN ('charge_start', 'recovery')
    AND prior.created_at > (now() - interval '30 minutes');

  IF window_attempts >= 3 THEN
    RAISE EXCEPTION
      'charge_attempt_rate_limited: participant % deal % already has % charge/recovery attempts in the last 30 minutes (max 3)',
      NEW.participant_id, NEW.deal_id, window_attempts
      USING ERRCODE = 'SN429';
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_payment_attempts_charge_rate_limit ON siton.payment_attempts;
CREATE TRIGGER trg_payment_attempts_charge_rate_limit
BEFORE INSERT ON siton.payment_attempts
FOR EACH ROW
WHEN (NEW.attempt_type IN ('charge_start', 'recovery'))
EXECUTE FUNCTION siton.enforce_charge_attempt_rate_limit();

DO $rate_limit_selfcheck$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_payment_attempts_charge_rate_limit'
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'charge attempt rate-limit trigger was not installed';
  END IF;
END
$rate_limit_selfcheck$;
