BEGIN;

SET search_path TO siton, public;

CREATE TABLE IF NOT EXISTS siton.deal_delivery_options (
  option_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id UUID NOT NULL REFERENCES siton.deals(deal_id) ON DELETE CASCADE,
  option_type TEXT NOT NULL CHECK (option_type IN ('delivery','pickup','distribution_point')),
  label TEXT NOT NULL,
  cost NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (cost >= 0),
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE IF EXISTS siton.participants
  ADD COLUMN IF NOT EXISTS delivery_option_id UUID NULL REFERENCES siton.deal_delivery_options(option_id) ON DELETE SET NULL;

ALTER TABLE IF EXISTS siton.participants
  ADD COLUMN IF NOT EXISTS delivery_method_type TEXT NULL;

ALTER TABLE IF EXISTS siton.participants
  ADD COLUMN IF NOT EXISTS delivery_method_label TEXT NULL;

ALTER TABLE IF EXISTS siton.participants
  ADD COLUMN IF NOT EXISTS delivery_cost NUMERIC(12,2) NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_deal_delivery_options_deal
  ON siton.deal_delivery_options (deal_id, sort_order, created_at);

CREATE INDEX IF NOT EXISTS idx_participants_delivery_option
  ON siton.participants (delivery_option_id);

COMMIT;
