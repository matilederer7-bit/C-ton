BEGIN;

ALTER TABLE siton.deals
  ADD COLUMN IF NOT EXISTS description TEXT NULL;

ALTER TABLE siton.deals
  DROP CONSTRAINT IF EXISTS deals_description_length_check;
ALTER TABLE siton.deals
  ADD CONSTRAINT deals_description_length_check
  CHECK (description IS NULL OR char_length(description) <= 420);

-- Distributor links are attribution-only measurement resources. They never
-- create commission, balance, payout, invoice, wallet, or money authority.
CREATE TABLE IF NOT EXISTS siton.affiliate_links (
  link_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  affiliate_id UUID NOT NULL REFERENCES siton.affiliate_accounts(affiliate_id) ON DELETE CASCADE,
  deal_id UUID NOT NULL REFERENCES siton.deals(deal_id) ON DELETE CASCADE,
  internal_name TEXT NOT NULL CHECK (char_length(btrim(internal_name)) BETWEEN 1 AND 80),
  source_code TEXT NOT NULL UNIQUE CHECK (source_code ~ '^[a-z0-9][a-z0-9_-]{7,63}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  disabled_at TIMESTAMPTZ NULL,
  UNIQUE (affiliate_id, deal_id, internal_name)
);

CREATE INDEX IF NOT EXISTS idx_affiliate_links_affiliate_created
  ON siton.affiliate_links (affiliate_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_affiliate_links_deal
  ON siton.affiliate_links (deal_id, created_at DESC);

-- Events deliberately contain no IP address, user agent, buyer id, phone,
-- email, payment reference, or other PII. A client event id only deduplicates
-- browser retries for the same anonymous visit.
CREATE TABLE IF NOT EXISTS siton.affiliate_link_events (
  event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  link_id UUID NOT NULL REFERENCES siton.affiliate_links(link_id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN ('click','entry')),
  client_event_id TEXT NOT NULL CHECK (char_length(client_event_id) BETWEEN 8 AND 100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (link_id, event_type, client_event_id)
);

CREATE INDEX IF NOT EXISTS idx_affiliate_link_events_link_type_created
  ON siton.affiliate_link_events (link_id, event_type, created_at DESC);

COMMIT;
