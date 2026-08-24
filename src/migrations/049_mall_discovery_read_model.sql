BEGIN;

-- Mall is a discovery/read surface only. Canonical deal, buyer, inventory and
-- money state remain owned by the existing Siton state machine and ledgers.
ALTER TABLE siton.participants
  ADD COLUMN IF NOT EXISTS acquisition_source TEXT NOT NULL DEFAULT 'direct';

ALTER TABLE siton.participants
  DROP CONSTRAINT IF EXISTS participants_acquisition_source_check;
ALTER TABLE siton.participants
  ADD CONSTRAINT participants_acquisition_source_check
  CHECK (acquisition_source IN ('direct', 'mall', 'distributor', 'other'));

-- Anonymous discovery telemetry is intentionally PII-free. client_event_id is
-- an opaque browser-generated retry token, not an identity or contact value.
CREATE TABLE IF NOT EXISTS siton.discovery_events (
  event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type TEXT NOT NULL
    CHECK (event_type IN ('mall_session', 'card_impression', 'mall_deal_click', 'organic_deal_entry', 'mall_join')),
  client_event_id TEXT NOT NULL
    CHECK (char_length(client_event_id) BETWEEN 8 AND 100
      AND client_event_id ~ '^[A-Za-z0-9:_-]+$'),
  deal_id UUID NULL REFERENCES siton.deals(deal_id) ON DELETE CASCADE,
  deal_type TEXT NULL
    CHECK (deal_type IS NULL OR deal_type IN ('physical_product', 'voucher', 'ticket')),
  mall_status TEXT NULL
    CHECK (mall_status IS NULL OR mall_status IN ('underway', 'reached_target', 'succeeded', 'failed', 'cancelled')),
  acquisition_source TEXT NOT NULL DEFAULT 'mall'
    CHECK (acquisition_source = 'mall'),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT discovery_event_deal_required_check
    CHECK (event_type = 'mall_session' OR deal_id IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_discovery_events_client_retry
  ON siton.discovery_events (
    event_type,
    client_event_id,
    (COALESCE(deal_id, '00000000-0000-0000-0000-000000000000'::uuid))
  );

CREATE INDEX IF NOT EXISTS idx_discovery_events_type_created
  ON siton.discovery_events (event_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_discovery_events_deal_type_created
  ON siton.discovery_events (deal_id, event_type, created_at DESC)
  WHERE deal_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_participants_deal_acquisition
  ON siton.participants (deal_id, acquisition_source, buyer_state)
  INCLUDE (qty, created_at);

-- Page the canonical deal rows before joining seller/image/progress details.
-- These indexes match the bounded Mall filters and deterministic tie-breaker.
CREATE INDEX IF NOT EXISTS idx_deals_mall_published
  ON siton.deals (published_at DESC, deal_id DESC)
  INCLUDE (state, deal_type)
  WHERE published_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_deals_mall_type_published
  ON siton.deals (deal_type, published_at DESC, deal_id DESC)
  INCLUDE (state)
  WHERE published_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_deals_mall_state_published
  ON siton.deals (state, published_at DESC, deal_id DESC)
  INCLUDE (deal_type)
  WHERE published_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_deal_images_mall_order
  ON siton.deal_images (deal_id, is_primary DESC, sort_order, created_at)
  INCLUDE (image_id, mime_type, public_url);

CREATE INDEX IF NOT EXISTS idx_deal_delivery_options_mall_lookup
  ON siton.deal_delivery_options (deal_id, option_type);

COMMIT;
