-- 069 — LONG_HORIZON_DEALS: deal lifetime is decoupled from payment
-- authorization lifetime.
--
-- Product decision (2026-09-16): a buyer's financial commitment to a deal is
-- long-lived according to Siton's state machine; the provider authorization
-- that backs it is a REPLACEABLE technical instrument with a provider-defined
-- validity. Expiry of that instrument is a payment-maintenance event, never a
-- reason to fail a deal, drop a participant or cap the deal deadline. When
-- the original authorization is no longer usable at the charging boundary the
-- Worker re-establishes it from the stored provider payment-method reference
-- (never raw card data) and captures the renewed authorization — through the
-- same durable operation lifecycle (067/068) as every other money operation.
--
-- What this migration makes durable:
--
--   payment_authorization_bindings — the participant's CURRENT authorization
--     instrument (one consumed binding per participant, unchanged) gains the
--     metadata needed to renew it deterministically and audit every renewal:
--       payment_method_ref            provider-side stored instrument reference
--                                     (opaque token / payment method id; never
--                                     card data) used to re-establish the hold
--       authorization_established_at  when the CURRENT authorization_id was
--                                     established (join, or the latest renewal)
--       renewal_count                 how many times the instrument was renewed
--       renewed_at                    instant of the latest renewal
--       replaced_authorization_id     the authorization the latest renewal
--                                     replaced (the full chain is in
--                                     siton.payment_attempts, attempt_type
--                                     'reauthorize', one row per renewal
--                                     identity with its dispatch lifecycle)
--     expires_at (053) keeps its meaning — the provider-declared validity of
--     the CURRENT authorization — and is now actually populated by the
--     authorize route when the provider declares one.
--
--   payment_attempts.attempt_type 'reauthorize' — one durable identity per
--     re-authorization request, minted BEFORE provider I/O, armed under the
--     worker lease, settled by its dispatching owner (067 guards apply
--     unchanged: in-flight protection, terminal monotonicity, owner fencing).
--
--   eligibility guard (067) — extended, not weakened:
--     * no new 'reauthorize' identity while a prior one is unresolved (unknown)
--       — a renewal that SUCCEEDED does not block a later renewal (a very long
--       deal may renew more than once);
--     * no capture-side identity (charge_start / recovery) and no release while
--       a 'reauthorize' is unresolved: which authorization is current is not
--       known until the renewal resolves.
--   'reauthorize' is NOT a charge attempt: the 050 rolling three-attempt cap
--   and the 068 settlement fence are untouched (they read charge_start /
--   recovery only). No money-state transition changes: renewal happens while
--   the participant stays ChargeAttempt / ChargeFailedRecovery — no new
--   visible state exists for "authorization expired".
--
-- Forward-only; no history rewritten; existing rows keep working (all new
-- columns are nullable or defaulted, authorization_established_at is
-- backfilled from created_at).

BEGIN;

ALTER TABLE siton.payment_authorization_bindings
  ADD COLUMN IF NOT EXISTS payment_method_ref TEXT NULL,
  ADD COLUMN IF NOT EXISTS authorization_established_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS renewal_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS renewed_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS replaced_authorization_id TEXT NULL;

ALTER TABLE siton.payment_authorization_bindings
  DROP CONSTRAINT IF EXISTS payment_binding_renewal_shape;
ALTER TABLE siton.payment_authorization_bindings
  ADD CONSTRAINT payment_binding_renewal_shape CHECK (
    renewal_count >= 0
    AND ((renewal_count = 0) = (renewed_at IS NULL))
    AND (renewal_count > 0 OR replaced_authorization_id IS NULL)
  );

-- Existing rows: the current authorization was established when the row was created.
UPDATE siton.payment_authorization_bindings
SET authorization_established_at = created_at
WHERE renewal_count = 0 AND authorization_established_at <> created_at;

-- Payment-maintenance observability: committed participants whose CURRENT
-- authorization is past its declared validity (a renewal candidate at the
-- charging boundary — an internal signal, not a product state).
CREATE INDEX IF NOT EXISTS idx_payment_bindings_consumed_declared_expiry
  ON siton.payment_authorization_bindings (expires_at)
  WHERE status = 'consumed' AND expires_at IS NOT NULL;

-- One renewal request = one durable provider-operation identity.
ALTER TABLE siton.payment_attempts
  DROP CONSTRAINT IF EXISTS payment_attempts_attempt_type_check;
ALTER TABLE siton.payment_attempts
  ADD CONSTRAINT payment_attempts_attempt_type_check
  CHECK (attempt_type IN ('charge_start','recovery','refund','deadline_check','cancel_refund','release','reauthorize'));

-- ---------------------------------------------------------------------------
-- INSERT guard (067) — same rules, plus the 'reauthorize' family.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION siton.guard_payment_attempt_eligibility()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.attempt_type NOT IN ('charge_start', 'recovery', 'refund', 'cancel_refund', 'release', 'reauthorize') THEN
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

  -- 069: a re-authorization identity may not rotate while a prior renewal is
  -- unresolved; a renewal that executed (success) is complete and never blocks
  -- a later renewal of the same obligation.
  IF NEW.attempt_type = 'reauthorize' THEN
    IF EXISTS (
      SELECT 1 FROM siton.payment_attempts prior
      WHERE prior.participant_id = NEW.participant_id
        AND prior.deal_id = NEW.deal_id
        AND prior.attempt_type = 'reauthorize'
        AND prior.result_class = 'unknown'
    ) THEN
      RAISE EXCEPTION
        'reauthorization_identity_rotation_blocked: participant % deal % has an unresolved reauthorize operation; the SAME identity must be resolved first',
        NEW.participant_id, NEW.deal_id
        USING ERRCODE = 'SN409';
    END IF;
    RETURN NEW;
  END IF;

  -- 069: while a renewal is unresolved the CURRENT authorization is unknown —
  -- no capture, no recovery, no release may start.
  IF NEW.attempt_type IN ('charge_start', 'recovery', 'release') AND EXISTS (
    SELECT 1 FROM siton.payment_attempts prior
    WHERE prior.participant_id = NEW.participant_id
      AND prior.deal_id = NEW.deal_id
      AND prior.attempt_type = 'reauthorize'
      AND prior.result_class = 'unknown'
  ) THEN
    RAISE EXCEPTION
      'money_operation_blocked_by_unresolved_reauthorization: participant % deal % has an unresolved reauthorize operation; % may not start',
      NEW.participant_id, NEW.deal_id, NEW.attempt_type
      USING ERRCODE = 'SN409';
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

DO $renewal_selfcheck$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'siton' AND table_name = 'payment_authorization_bindings' AND column_name = 'payment_method_ref'
  ) THEN
    RAISE EXCEPTION 'payment_authorization_bindings.payment_method_ref was not installed';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_payment_attempts_eligibility' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'payment attempt eligibility trigger is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname = 'payment_attempts' AND c.conname = 'payment_attempts_attempt_type_check'
      AND pg_get_constraintdef(c.oid) LIKE '%reauthorize%'
  ) THEN
    RAISE EXCEPTION 'payment_attempts attempt_type check does not admit reauthorize';
  END IF;
END
$renewal_selfcheck$;

COMMIT;
