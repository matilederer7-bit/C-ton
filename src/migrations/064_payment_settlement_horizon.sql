-- 064 — independent financial review remediation: a durable, provider-specific
-- SETTLEMENT HORIZON and the PROVENANCE of every negative money verdict.
--
-- The review of the financial torture candidate (docs/R9C_FINANCIAL_REVIEW.md)
-- reproduced a double capture that no status-reading policy can prevent: a
-- capture that the provider settles asynchronously (answered "pending" or
-- lost after the effect), a status seam that answers a CONSISTENT
-- "failed/final" or "authorized/final" while that settlement is still in
-- progress, a reconcile verdict of charge_failed inferred from that status,
-- an automatic recovery capture, and then the original capture landing —
-- two captures for one obligation. The same inference also let the terminal
-- deal decision (finalize) run on money that was still moving.
--
-- Owner decision: automatic recovery (and release, and the terminal decision)
-- may not start merely because status reads say "failed" / "authorized"
-- after a capture may already have been dispatched. Recovery requires
-- exact-operation authoritative evidence AND a provider-specific settlement
-- horizon. If exact truth cannot be proven: UNKNOWN / HOLD / OPERATOR CASE.
--
-- This migration makes both facts durable on siton.payment_attempts:
--
--   settlement_horizon_at  the instant until which the provider may still
--                          settle the dispatched request. Set when the
--                          operation is ARMED for I/O (dispatched_at +
--                          provider policy horizon), only ever extended
--                          (worker retries, re-arms and status "pending"
--                          reads extend it; nothing shortens it — enforced by
--                          trigger), never reset by identity rotation (the
--                          fence reads EVERY capture-side row of the
--                          participant, not the newest one).
--   failure_evidence       why a permanent_fail row is believed:
--                            dispatch_response  the provider answered the
--                                               exact request with a decline
--                                               (exact-operation evidence)
--                            status_inference   derived from a status read
--                            provider_event     a provider callback
--                            operator           manual resolution
--                          A dispatch_response verdict is never downgraded to
--                          an inference (trigger).
--
-- siton.payment_capture_settlement_fence(participant, deal) returns the latest
-- open horizon of any capture-side (charge_start / recovery) row that is
-- permanent_fail WITHOUT exact-request evidence, or NULL when no such row
-- exists. While it is not NULL:
--   * no recovery and no release identity may be minted (INSERT trigger —
--     DB-authoritative backstop of the application fence)
--   * the application defers the recovery / release job and the terminal
--     finalize decision to that instant and keeps an operational case open.
-- A row whose failure came from the exact dispatch response is NOT fenced:
-- the provider declared this very request failed. A legacy row (armed before
-- this migration, horizon NULL) is not fenced either — the recovery
-- pre-flight refuses to proceed on an unverifiable status for such a row.
--
-- No economics are touched. Migration 063 (lifecycle guards) is unchanged.

BEGIN;

ALTER TABLE siton.payment_attempts
  ADD COLUMN IF NOT EXISTS settlement_horizon_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS failure_evidence TEXT NULL;

ALTER TABLE siton.payment_attempts
  DROP CONSTRAINT IF EXISTS payment_attempts_failure_evidence_check;
ALTER TABLE siton.payment_attempts
  ADD CONSTRAINT payment_attempts_failure_evidence_check
  CHECK (failure_evidence IS NULL OR failure_evidence IN ('dispatch_response', 'status_inference', 'provider_event', 'operator'));

CREATE INDEX IF NOT EXISTS payment_attempts_settlement_fence_idx
  ON siton.payment_attempts (participant_id, deal_id, settlement_horizon_at)
  WHERE result_class = 'permanent_fail' AND settlement_horizon_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Fence predicate: the latest open settlement horizon of a capture-side
-- operation whose failure is NOT exact-request evidence; NULL = no fence.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION siton.payment_capture_settlement_fence(
  p_participant_id uuid,
  p_deal_id uuid
)
RETURNS timestamptz
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT max(pa.settlement_horizon_at)
  FROM siton.payment_attempts pa
  WHERE pa.participant_id = p_participant_id
    AND pa.deal_id = p_deal_id
    AND pa.attempt_type IN ('charge_start', 'recovery')
    AND pa.result_class = 'permanent_fail'
    AND pa.failure_evidence IS DISTINCT FROM 'dispatch_response'
    AND pa.settlement_horizon_at IS NOT NULL
    AND pa.settlement_horizon_at > clock_timestamp();
$$;

-- ---------------------------------------------------------------------------
-- INSERT guard: no recovery / release identity while a capture-side failure
-- is still inside its settlement horizon (application fence backstop).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION siton.guard_payment_attempt_settlement_fence()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  fence timestamptz;
BEGIN
  IF NEW.attempt_type NOT IN ('recovery', 'release') THEN
    RETURN NEW;
  END IF;

  -- idempotent replay of an existing identity is admitted unchanged
  IF EXISTS (
    SELECT 1 FROM siton.payment_attempts existing
    WHERE existing.participant_id = NEW.participant_id
      AND existing.deal_id = NEW.deal_id
      AND existing.attempt_type = NEW.attempt_type
      AND existing.correlation_id = NEW.correlation_id
  ) THEN
    RETURN NEW;
  END IF;

  fence := siton.payment_capture_settlement_fence(NEW.participant_id, NEW.deal_id);
  IF fence IS NOT NULL THEN
    RAISE EXCEPTION
      'money_operation_fenced_by_settlement_horizon: participant % deal % has a capture-side operation whose status-inferred failure may still settle until %; % may not start',
      NEW.participant_id, NEW.deal_id, fence, NEW.attempt_type
      USING ERRCODE = 'SN409';
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_payment_attempts_settlement_fence ON siton.payment_attempts;
CREATE TRIGGER trg_payment_attempts_settlement_fence
BEFORE INSERT ON siton.payment_attempts
FOR EACH ROW
EXECUTE FUNCTION siton.guard_payment_attempt_settlement_fence();

-- ---------------------------------------------------------------------------
-- UPDATE guard: the horizon is monotonic (never shortened, never cleared) and
-- exact-request failure evidence is never downgraded to an inference.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION siton.guard_payment_attempt_settlement_horizon()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF OLD.settlement_horizon_at IS NOT NULL
     AND (NEW.settlement_horizon_at IS NULL OR NEW.settlement_horizon_at < OLD.settlement_horizon_at) THEN
    NEW.settlement_horizon_at := OLD.settlement_horizon_at;
  END IF;
  IF OLD.failure_evidence = 'dispatch_response'
     AND NEW.failure_evidence IS DISTINCT FROM 'dispatch_response' THEN
    NEW.failure_evidence := OLD.failure_evidence;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_payment_attempts_settlement_horizon ON siton.payment_attempts;
CREATE TRIGGER trg_payment_attempts_settlement_horizon
BEFORE UPDATE ON siton.payment_attempts
FOR EACH ROW
EXECUTE FUNCTION siton.guard_payment_attempt_settlement_horizon();

DO $settlement_selfcheck$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_payment_attempts_settlement_fence' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'payment attempt settlement fence trigger was not installed';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_payment_attempts_settlement_horizon' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'payment attempt settlement horizon trigger was not installed';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'siton' AND p.proname = 'payment_capture_settlement_fence'
  ) THEN
    RAISE EXCEPTION 'payment_capture_settlement_fence predicate was not installed';
  END IF;
END
$settlement_selfcheck$;

COMMIT;
