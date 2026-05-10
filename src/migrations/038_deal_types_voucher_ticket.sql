-- Migration 038: Deal Type Expansion (physical_product / voucher / ticket).
--
-- Adds a canonical, closed-set deal_type column to siton.deals, plus per-type
-- fulfillment configuration tables (deal_voucher_terms, deal_ticket_terms) and
-- a unified fulfillment_units table for issuance.
--
-- Constraints honored:
--   • Default deal_type = 'physical_product' so historical deals keep working.
--   • Closed enum values via CHECK constraints (no JSONB as truth source).
--   • Idempotent (CREATE/ALTER ... IF NOT EXISTS, DO blocks for constraints).
--   • State machine, money logic, and 90% rule are NOT changed by this migration.
--   • No card data, no plaintext voucher codes by default — we store a hash and
--     a last4 display fragment only. Mission Control / docs flag the full-code
--     issuance pipeline as a follow-up.

SET search_path TO siton, public;

ALTER TABLE siton.deals
  ADD COLUMN IF NOT EXISTS deal_type TEXT NOT NULL DEFAULT 'physical_product';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'deals_deal_type_check'
      AND conrelid = 'siton.deals'::regclass
  ) THEN
    ALTER TABLE siton.deals
      ADD CONSTRAINT deals_deal_type_check
      CHECK (deal_type IN ('physical_product','voucher','ticket'));
  END IF;
END $$;

UPDATE siton.deals
   SET deal_type = 'physical_product'
 WHERE deal_type IS NULL OR btrim(deal_type) = '';

CREATE INDEX IF NOT EXISTS idx_deals_deal_type
  ON siton.deals (deal_type, created_at DESC);

-- ── Voucher fulfillment terms ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS siton.deal_voucher_terms (
  deal_id UUID PRIMARY KEY REFERENCES siton.deals(deal_id) ON DELETE CASCADE,
  face_value_amount NUMERIC(12,2) NOT NULL CHECK (face_value_amount > 0),
  currency TEXT NOT NULL DEFAULT 'ILS' CHECK (char_length(currency) BETWEEN 2 AND 8),
  valid_from TIMESTAMPTZ NULL,
  valid_until TIMESTAMPTZ NULL,
  redemption_location TEXT NOT NULL DEFAULT '',
  redemption_instructions TEXT NOT NULL DEFAULT '',
  terms TEXT NOT NULL DEFAULT '',
  is_single_use BOOLEAN NOT NULL DEFAULT TRUE,
  allow_partial_redemption BOOLEAN NOT NULL DEFAULT FALSE,
  voucher_code_mode TEXT NOT NULL DEFAULT 'system_generated'
    CHECK (voucher_code_mode IN ('system_generated','seller_uploaded','seller_external')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Ticket fulfillment terms ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS siton.deal_ticket_terms (
  deal_id UUID PRIMARY KEY REFERENCES siton.deals(deal_id) ON DELETE CASCADE,
  event_name TEXT NOT NULL CHECK (char_length(event_name) > 0),
  event_starts_at TIMESTAMPTZ NOT NULL,
  event_ends_at TIMESTAMPTZ NULL,
  venue_name TEXT NOT NULL DEFAULT '',
  venue_address TEXT NOT NULL DEFAULT '',
  venue_city TEXT NOT NULL DEFAULT '',
  entry_instructions TEXT NOT NULL DEFAULT '',
  ticket_type TEXT NOT NULL DEFAULT 'general_admission'
    CHECK (ticket_type IN ('general_admission','reserved_external','vip','other')),
  seat_mode TEXT NOT NULL DEFAULT 'general_admission'
    CHECK (seat_mode IN ('general_admission','assigned_seating_not_supported_yet','external_seating')),
  transfer_allowed BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Fulfillment units (issued strictly after Completed + eligibility) ────────
CREATE TABLE IF NOT EXISTS siton.fulfillment_units (
  fulfillment_unit_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id UUID NOT NULL REFERENCES siton.deals(deal_id) ON DELETE CASCADE,
  participant_id UUID NOT NULL REFERENCES siton.participants(participant_id) ON DELETE CASCADE,
  deal_type TEXT NOT NULL CHECK (deal_type IN ('physical_product','voucher','ticket')),
  fulfillment_kind TEXT NOT NULL CHECK (fulfillment_kind IN ('physical_delivery','voucher_code','event_ticket')),
  unit_index INT NOT NULL CHECK (unit_index >= 1),
  code_hash TEXT NULL,
  code_display_last4 TEXT NULL,
  status TEXT NOT NULL DEFAULT 'Issued'
    CHECK (status IN ('Pending','Issued','Sent','Redeemed','Expired','VoidedDueToDealFailure')),
  issued_at TIMESTAMPTZ NULL,
  sent_at TIMESTAMPTZ NULL,
  redeemed_at TIMESTAMPTZ NULL,
  expires_at TIMESTAMPTZ NULL,
  metadata_jsonb JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (deal_id, participant_id, unit_index)
);

CREATE INDEX IF NOT EXISTS idx_fulfillment_units_deal
  ON siton.fulfillment_units (deal_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fulfillment_units_participant
  ON siton.fulfillment_units (participant_id, created_at DESC);
