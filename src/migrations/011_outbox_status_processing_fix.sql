BEGIN;

SET search_path TO siton, public;

ALTER TABLE siton.outbox_events
  DROP CONSTRAINT IF EXISTS outbox_events_status_check;

ALTER TABLE siton.outbox_events
  ADD CONSTRAINT outbox_events_status_check
  CHECK (status IN ('pending','processing','sent','failed')) NOT VALID;

ALTER TABLE siton.outbox_events
  VALIDATE CONSTRAINT outbox_events_status_check;

COMMIT;
