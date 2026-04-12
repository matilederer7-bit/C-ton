BEGIN;

ALTER TABLE siton.payment_attempts
  ALTER COLUMN participant_id SET NOT NULL;

ALTER TABLE siton.payment_attempts
  ALTER COLUMN deal_id SET NOT NULL;

ALTER TABLE siton.payment_attempts
  ALTER COLUMN attempt_type SET NOT NULL;

ALTER TABLE siton.payment_attempts
  ALTER COLUMN correlation_id SET NOT NULL;

COMMIT;
