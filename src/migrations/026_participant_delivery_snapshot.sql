-- Migration 026: persist buyer contact and delivery address snapshot on participants.
-- These fields are captured at join time and used for the seller shipping export.
-- They are NOT a full buyer profile — just a per-participation snapshot of what
-- was provided at join time for fulfilment purposes.

BEGIN;

SET search_path TO siton, public;

ALTER TABLE siton.participants
  ADD COLUMN IF NOT EXISTS buyer_name TEXT NULL;

ALTER TABLE siton.participants
  ADD COLUMN IF NOT EXISTS buyer_phone TEXT NULL;

ALTER TABLE siton.participants
  ADD COLUMN IF NOT EXISTS buyer_email TEXT NULL;

ALTER TABLE siton.participants
  ADD COLUMN IF NOT EXISTS delivery_address TEXT NULL;

ALTER TABLE siton.participants
  ADD COLUMN IF NOT EXISTS delivery_city TEXT NULL;

ALTER TABLE siton.participants
  ADD COLUMN IF NOT EXISTS delivery_notes TEXT NULL;

COMMIT;
