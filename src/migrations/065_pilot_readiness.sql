-- 065 — LAUNCH MODE: closed-web-pilot readiness (additive, no money semantics).
--
-- 1. deals.list_price_per_unit — the seller's regular ("normal") price per unit.
--    NULL = not provided. When present it must exceed the group price so the
--    public deal page can show the saving honestly; enforced again in the app.
-- 2. viral_events — two more PII-free funnel event types the pilot must
--    measure (join_failed, inquiry_started) plus a bounded, free-text
--    `detail` (e.g. the join refusal code). No PII is ever written here.
--
-- Numbering: 063/064 are reserved by the financial candidate branch; this
-- migration deliberately takes 065 so the ids never collide. Manifest order
-- (position) is what the ledger checks, and the branch merged second must be
-- appended after the branch merged first.

ALTER TABLE siton.deals
  ADD COLUMN IF NOT EXISTS list_price_per_unit NUMERIC(12,2) NULL;

ALTER TABLE siton.deals
  DROP CONSTRAINT IF EXISTS deals_list_price_per_unit_check;
ALTER TABLE siton.deals
  ADD CONSTRAINT deals_list_price_per_unit_check
  CHECK (list_price_per_unit IS NULL OR list_price_per_unit > 0);

ALTER TABLE siton.viral_events
  DROP CONSTRAINT IF EXISTS viral_events_event_type_check;
ALTER TABLE siton.viral_events
  ADD CONSTRAINT viral_events_event_type_check
  CHECK (event_type IN (
    'deal_view', 'share_button_click', 'personal_link_created', 'join_started',
    'join_failed', 'inquiry_started'
  ));

ALTER TABLE siton.viral_events
  ADD COLUMN IF NOT EXISTS detail TEXT NULL;

ALTER TABLE siton.viral_events
  DROP CONSTRAINT IF EXISTS viral_events_detail_check;
ALTER TABLE siton.viral_events
  ADD CONSTRAINT viral_events_detail_check
  CHECK (detail IS NULL OR char_length(detail) <= 120);
