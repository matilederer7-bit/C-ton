-- 064 — independent financial review remediation: a durable, provider-specific
-- SETTLEMENT HORIZON, the PROVENANCE of every negative money verdict, the
-- provider's NEGATIVE-FINALITY AUTHORITY, and the release-in-flight fence.
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
-- Final integration (docs/R9C_FINAL_FINANCIAL_INTEGRATION.md) closes three
-- residuals of that review:
--   A  horizon expiry BY ITSELF never authorises automatic recovery: the
--      negative finality of the status evidence must be explicitly classified
--      authoritative for the provider / operation contract (recorded on the
--      row at dispatch: negative_finality_authoritative). Unproven (Grow,
--      legacy rows) => permanently fenced, operator case.
--   B  a legacy row (armed before this migration, settlement_horizon_at NULL)
--      is NEVER "already elapsed": a horizon is backfilled where the original
--      dispatch instant is known (dispatched_at + the conservative 24 h
--      default), the authority stays NULL (= unproven), so the row remains
--      fenced until an operator records `failure_evidence = 'operator'`.
--   C  no capture / recovery identity while a RELEASE of the same
--      authorization is unresolved (unknown) or executed (success): the
--      INSERT guard refuses it; a hold released while a charge was pending
--      may move ChargeAttempt -> AuthReleased (the capture never dispatched).
--
-- Columns on siton.payment_attempts:
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
--                            operator           manual resolution after
--                                               provider-side verification
--                          A dispatch_response verdict is never downgraded to
--                          an inference (trigger).
--   negative_finality_authoritative
--                          whether the provider contract under which this
--                          row was dispatched proves NON-execution of the
--                          exact operation from a negative status (policy
--                          negative_status_authoritative at arm time).
--                          NULL = unproven (legacy rows, Grow).
--
-- siton.payment_capture_settlement_fence(participant, deal) returns the latest
-- open horizon of any capture-side (charge_start / recovery) row that is
-- permanent_fail WITHOUT exact-request or operator evidence, 'infinity' when
-- such a row can never be resolved automatically (no horizon, or negative
-- finality not authoritative), or NULL when no such row exists. While it is
-- not NULL:
--   * no recovery and no release identity may be minted (INSERT trigger —
--     DB-authoritative backstop of the application fence)
--   * the application defers the recovery / release job and the terminal
--     finalize decision to that instant (or holds them with an operator case
--     when the fence is permanent).
-- A row whose failure came from the exact dispatch response is NOT fenced:
-- the provider declared this very request failed.
--
-- No economics are touched. Migration 063 (lifecycle guards) is unchanged.
-- This migration was never applied outside disposable databases.

BEGIN;

ALTER TABLE siton.payment_attempts
  ADD COLUMN IF NOT EXISTS settlement_horizon_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS failure_evidence TEXT NULL,
  ADD COLUMN IF NOT EXISTS negative_finality_authoritative BOOLEAN NULL;

ALTER TABLE siton.payment_attempts
  DROP CONSTRAINT IF EXISTS payment_attempts_failure_evidence_check;
ALTER TABLE siton.payment_attempts
  ADD CONSTRAINT payment_attempts_failure_evidence_check
  CHECK (failure_evidence IS NULL OR failure_evidence IN ('dispatch_response', 'status_inference', 'provider_event', 'operator'));

CREATE INDEX IF NOT EXISTS payment_attempts_settlement_fence_idx
  ON siton.payment_attempts (participant_id, deal_id, settlement_horizon_at)
  WHERE result_class = 'permanent_fail' AND settlement_horizon_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Residual B — legacy rows. A capture-side operation dispatched before this
-- migration has no horizon. Where the ORIGINAL dispatch instant is durable
-- (dispatched_at, migration 063) the horizon is reconstructed with the
-- conservative provider-ready default of 24 h; the authority stays NULL, so
-- the row is fenced until an operator records exact evidence. Rows without a
-- dispatch instant keep NULL (never treated as elapsed — see the fence).
-- ---------------------------------------------------------------------------
UPDATE siton.payment_attempts
SET settlement_horizon_at = dispatched_at + interval '24 hours'
WHERE settlement_horizon_at IS NULL
  AND dispatched_at IS NOT NULL
  AND attempt_type IN ('charge_start', 'recovery');

-- ---------------------------------------------------------------------------
-- Fence predicate: the latest open settlement horizon of a capture-side
-- operation whose failure is NOT exact-request / operator evidence.
--   NULL        no fence
--   timestamp   fenced until that instant (authoritative provider, horizon open)
--   'infinity'  fenced until an operator resolves it (no horizon on the row,
--               or negative finality not authoritative for the provider)
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
  SELECT max(
    CASE
      WHEN pa.settlement_horizon_at IS NULL OR NOT COALESCE(pa.negative_finality_authoritative, false)
        THEN 'infinity'::timestamptz
      ELSE pa.settlement_horizon_at
    END)
  FROM siton.payment_attempts pa
  WHERE pa.participant_id = p_participant_id
    AND pa.deal_id = p_deal_id
    AND pa.attempt_type IN ('charge_start', 'recovery')
    AND pa.result_class = 'permanent_fail'
    AND pa.failure_evidence IS DISTINCT FROM 'dispatch_response'
    AND pa.failure_evidence IS DISTINCT FROM 'operator'
    AND (
      pa.settlement_horizon_at IS NULL
      OR pa.settlement_horizon_at > clock_timestamp()
      OR NOT COALESCE(pa.negative_finality_authoritative, false)
    );
$$;

-- ---------------------------------------------------------------------------
-- Residual C predicate: a RELEASE of this authorization is unresolved (may
-- have released the hold) or executed (did release it). No capture-side money
-- operation may start while it is true.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION siton.payment_release_conflict(
  p_participant_id uuid,
  p_deal_id uuid
)
RETURNS text
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM siton.payment_attempts pa
      WHERE pa.participant_id = p_participant_id AND pa.deal_id = p_deal_id
        AND pa.attempt_type = 'release' AND pa.result_class = 'success'
    ) THEN 'released'
    WHEN EXISTS (
      SELECT 1 FROM siton.payment_attempts pa
      WHERE pa.participant_id = p_participant_id AND pa.deal_id = p_deal_id
        AND pa.attempt_type = 'release' AND pa.result_class = 'unknown'
    ) THEN 'unresolved'
    ELSE NULL
  END;
$$;

-- ---------------------------------------------------------------------------
-- INSERT guard: no recovery / release identity while a capture-side failure
-- is still inside its settlement horizon or can never be resolved
-- automatically; no capture / recovery identity while a release of the same
-- authorization is unresolved or executed (application fence backstops).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION siton.guard_payment_attempt_settlement_fence()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  fence timestamptz;
  release_conflict text;
BEGIN
  IF NEW.attempt_type NOT IN ('charge_start', 'recovery', 'release') THEN
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

  IF NEW.attempt_type IN ('recovery', 'release') THEN
    fence := siton.payment_capture_settlement_fence(NEW.participant_id, NEW.deal_id);
    IF fence IS NOT NULL THEN
      IF fence = 'infinity'::timestamptz THEN
        RAISE EXCEPTION
          'money_operation_fenced_negative_finality_unproven: participant % deal % has a capture-side failure whose negative finality is not authoritative for its provider (or no settlement horizon); % may not start until an operator records exact evidence',
          NEW.participant_id, NEW.deal_id, NEW.attempt_type
          USING ERRCODE = 'SN409';
      END IF;
      RAISE EXCEPTION
        'money_operation_fenced_by_settlement_horizon: participant % deal % has a capture-side operation whose status-inferred failure may still settle until %; % may not start',
        NEW.participant_id, NEW.deal_id, fence, NEW.attempt_type
        USING ERRCODE = 'SN409';
    END IF;
  END IF;

  IF NEW.attempt_type IN ('charge_start', 'recovery') THEN
    release_conflict := siton.payment_release_conflict(NEW.participant_id, NEW.deal_id);
    IF release_conflict IS NOT NULL THEN
      RAISE EXCEPTION
        'capture_blocked_by_%_release: participant % deal % has a release of the same authorization that is %; % may not start',
        release_conflict, NEW.participant_id, NEW.deal_id, release_conflict, NEW.attempt_type
        USING ERRCODE = 'SN409';
    END IF;
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
-- UPDATE guard: the horizon is monotonic (never shortened, never cleared),
-- exact-request failure evidence is never downgraded to an inference, and the
-- recorded negative-finality authority is never raised after dispatch.
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
  IF OLD.negative_finality_authoritative IS NOT NULL
     AND NEW.negative_finality_authoritative IS DISTINCT FROM OLD.negative_finality_authoritative
     AND NEW.negative_finality_authoritative = true THEN
    NEW.negative_finality_authoritative := OLD.negative_finality_authoritative;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_payment_attempts_settlement_horizon ON siton.payment_attempts;
CREATE TRIGGER trg_payment_attempts_settlement_horizon
BEFORE UPDATE ON siton.payment_attempts
FOR EACH ROW
EXECUTE FUNCTION siton.guard_payment_attempt_settlement_horizon();

-- ---------------------------------------------------------------------------
-- Residual C — a hold released while a charge was pending: the capture is
-- never dispatched (fenced above) and the money truth is AuthReleased.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION siton.is_valid_money_transition(v_from text, v_to text)
RETURNS boolean
LANGUAGE sql
AS $$
  SELECT CASE
    WHEN v_from = 'NoFinancial' AND v_to = 'AuthHeld' THEN true
    WHEN v_from = 'AuthHeld' AND v_to IN ('AuthLocked', 'AuthReleased') THEN true
    WHEN v_from = 'AuthLocked' AND v_to IN ('ChargeAttempt', 'AuthReleased') THEN true
    WHEN v_from = 'ChargeAttempt' AND v_to IN ('ChargedSuccess', 'ChargeFailedRecovery', 'AuthReleased') THEN true
    WHEN v_from = 'ChargeFailedRecovery' AND v_to IN ('RecoveredCharge', 'AuthReleased') THEN true
    WHEN v_from IN ('ChargedSuccess', 'RecoveredCharge') AND v_to = 'Refunded' THEN true
    ELSE false
  END
$$;

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
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'siton' AND p.proname = 'payment_release_conflict'
  ) THEN
    RAISE EXCEPTION 'payment_release_conflict predicate was not installed';
  END IF;
  IF NOT siton.is_valid_money_transition('ChargeAttempt', 'AuthReleased') THEN
    RAISE EXCEPTION 'ChargeAttempt -> AuthReleased (released hold, capture never dispatched) was not admitted';
  END IF;
END
$settlement_selfcheck$;

COMMIT;
