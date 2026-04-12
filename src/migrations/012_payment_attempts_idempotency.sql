BEGIN;

ALTER TABLE siton.payment_attempts
  DROP CONSTRAINT IF EXISTS payment_attempts_attempt_type_check;

ALTER TABLE siton.payment_attempts
  ADD CONSTRAINT payment_attempts_attempt_type_check
  CHECK (attempt_type IN ('charge_start','recovery','refund','deadline_check','cancel_refund'));

CREATE UNIQUE INDEX IF NOT EXISTS payment_attempts_unique_logical_attempt
ON siton.payment_attempts(participant_id, deal_id, attempt_type, correlation_id);

COMMIT;
