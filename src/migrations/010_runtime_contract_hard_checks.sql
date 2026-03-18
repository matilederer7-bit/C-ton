BEGIN;

SET search_path TO siton, public;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'siton.outbox_events'::regclass
      AND conname = 'outbox_events_event_type_check'
  ) THEN
    ALTER TABLE siton.outbox_events
      ADD CONSTRAINT outbox_events_event_type_check
      CHECK (
        event_type IN (
          'charge_deal',
          'recovery_deal',
          'finalize_deal',
          'refund_issue',
          'deadline_check',
          'cancel_refund'
        )
      ) NOT VALID;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'siton.payment_attempts'::regclass
      AND conname = 'payment_attempts_attempt_type_check'
  ) THEN
    ALTER TABLE siton.payment_attempts
      ADD CONSTRAINT payment_attempts_attempt_type_check
      CHECK (
        attempt_type IN (
          'charge_start',
          'recovery',
          'refund',
          'cancel_refund'
        )
      ) NOT VALID;
  END IF;
END
$$;

ALTER TABLE siton.outbox_events
  VALIDATE CONSTRAINT outbox_events_event_type_check;

ALTER TABLE siton.payment_attempts
  VALIDATE CONSTRAINT payment_attempts_attempt_type_check;

COMMIT;
