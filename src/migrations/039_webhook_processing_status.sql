-- Runtime webhook claiming uses an explicit processing state.  This belongs in
-- the canonical schema, not in an application startup repair.
ALTER TABLE siton.webhook_events
  DROP CONSTRAINT IF EXISTS webhook_events_status_check;

ALTER TABLE siton.webhook_events
  ADD CONSTRAINT webhook_events_status_check
  CHECK (status IN ('pending','processing','processed','ignored','failed'));

CREATE INDEX IF NOT EXISTS idx_webhook_provider_received
  ON siton.webhook_events (provider, received_at);

CREATE INDEX IF NOT EXISTS idx_webhook_deal_received
  ON siton.webhook_events (deal_id, received_at);
