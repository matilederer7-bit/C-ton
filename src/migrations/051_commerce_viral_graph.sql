-- Migration 051: canonical Siton COMMERCE VIRAL GRAPH.
--
-- Every participant can become a distributor of the deal. After a successful
-- Join the participant owns one personal share link; joins arriving through
-- that link are permanently attributed to the sharing participant, forming a
-- multi-generation viral tree per deal.
--
-- Design constraints (product constitution):
--   * Attribution is measurement/growth analytics ONLY. It never creates a
--     commission, balance, payout, wallet, or money authority (migration 020
--     removed the money side of affiliate structures deliberately; this
--     migration keeps that invariant — no money columns anywhere here).
--   * Personal links REUSE the canonical siton.affiliate_links table (one link
--     rail, one visit-event rail) instead of duplicating a parallel concept.
--   * Join stays fast: attribution resolution is O(1) indexed lookups; heavy
--     subtree aggregation happens asynchronously in the worker via the new
--     'viral_recompute' outbox event, cached in siton.viral_metrics_cache.
--   * Funnel events carry NO PII: no IP, no user agent, no buyer identity —
--     only opaque anonymous visitor/session identifiers (same policy as
--     affiliate_link_events, migration 046).

BEGIN;

-- 1) affiliate_links learns non-distributor origins (participant personal
--    links now; seller/campaign links become representable too).
ALTER TABLE siton.affiliate_links
  ALTER COLUMN affiliate_id DROP NOT NULL;

ALTER TABLE siton.affiliate_links
  ADD COLUMN IF NOT EXISTS origin_type TEXT NOT NULL DEFAULT 'distributor';
ALTER TABLE siton.affiliate_links
  ADD COLUMN IF NOT EXISTS origin_participant_id UUID NULL
    REFERENCES siton.participants(participant_id) ON DELETE CASCADE;
ALTER TABLE siton.affiliate_links
  ADD COLUMN IF NOT EXISTS origin_buyer_id TEXT NULL;

ALTER TABLE siton.affiliate_links
  DROP CONSTRAINT IF EXISTS affiliate_links_origin_shape_check;
ALTER TABLE siton.affiliate_links
  ADD CONSTRAINT affiliate_links_origin_shape_check CHECK (
    origin_type IN ('distributor','participant','seller','campaign')
    AND ((origin_type = 'distributor') = (affiliate_id IS NOT NULL))
    AND ((origin_type = 'participant') = (origin_participant_id IS NOT NULL))
    AND (origin_type <> 'participant' OR origin_buyer_id IS NOT NULL)
  );

-- One personal link per (deal, buyer share identity): a repeat purchase by the
-- same buyer keeps the SAME personal link — repeat purchases must not mint a
-- new viral identity.
CREATE UNIQUE INDEX IF NOT EXISTS ux_affiliate_links_personal_identity
  ON siton.affiliate_links (deal_id, origin_buyer_id)
  WHERE origin_type = 'participant';

CREATE INDEX IF NOT EXISTS idx_affiliate_links_origin_participant
  ON siton.affiliate_links (origin_participant_id)
  WHERE origin_participant_id IS NOT NULL;

-- 2) Per-participant attribution row: the permanent edge of the viral tree.
--    One row per participant (a participant IS the order/purchase unit, and a
--    transport retry replays the same participant, so conversion counting is
--    naturally idempotent).
CREATE TABLE IF NOT EXISTS siton.viral_attributions (
  participant_id UUID PRIMARY KEY
    REFERENCES siton.participants(participant_id) ON DELETE CASCADE,
  deal_id UUID NOT NULL REFERENCES siton.deals(deal_id) ON DELETE CASCADE,
  -- Resolved last-touch share entity at Join time (server-authoritative).
  parent_link_id UUID NULL REFERENCES siton.affiliate_links(link_id) ON DELETE SET NULL,
  parent_participant_id UUID NULL
    REFERENCES siton.participants(participant_id) ON DELETE SET NULL,
  -- Chain origin: the first link of this branch (a distributor/campaign/seller
  -- link, or the generation-1 personal link that started the branch).
  origin_link_id UUID NULL REFERENCES siton.affiliate_links(link_id) ON DELETE SET NULL,
  origin_ref_type TEXT NOT NULL DEFAULT 'none' CHECK (
    origin_ref_type IN ('none','distributor','participant','seller','campaign','account')
  ),
  -- 0 = joined directly (no share attribution); n>=1 = joined through a share
  -- chain of depth n.
  generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0 AND generation <= 500),
  -- Client-side attribution hints (bounded, non-authoritative history).
  first_touch_code TEXT NULL CHECK (first_touch_code IS NULL OR char_length(first_touch_code) <= 120),
  first_touch_at TIMESTAMPTZ NULL,
  last_touch_code TEXT NULL CHECK (last_touch_code IS NULL OR char_length(last_touch_code) <= 120),
  last_touch_at TIMESTAMPTZ NULL,
  -- Opaque anonymous identifiers minted in the browser. Never identity data.
  visitor_id TEXT NULL CHECK (visitor_id IS NULL OR char_length(visitor_id) <= 64),
  session_id TEXT NULL CHECK (session_id IS NULL OR char_length(session_id) <= 64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT viral_attributions_parent_shape_check CHECK (
    -- A participant parent edge always rides on a resolved personal link.
    parent_participant_id IS NULL OR parent_link_id IS NOT NULL
  ),
  CONSTRAINT viral_attributions_no_self_parent CHECK (
    parent_participant_id IS NULL OR parent_participant_id <> participant_id
  )
);

CREATE INDEX IF NOT EXISTS idx_viral_attributions_deal
  ON siton.viral_attributions (deal_id, generation);
CREATE INDEX IF NOT EXISTS idx_viral_attributions_parent_participant
  ON siton.viral_attributions (parent_participant_id)
  WHERE parent_participant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_viral_attributions_parent_link
  ON siton.viral_attributions (parent_link_id)
  WHERE parent_link_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_viral_attributions_origin_link
  ON siton.viral_attributions (origin_link_id)
  WHERE origin_link_id IS NOT NULL;

-- 3) PII-free growth funnel events that are not scoped to one link
--    (link click/entry stays on siton.affiliate_link_events).
CREATE TABLE IF NOT EXISTS siton.viral_events (
  event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type TEXT NOT NULL CHECK (
    event_type IN ('deal_view','share_button_click','personal_link_created','join_started')
  ),
  deal_id UUID NOT NULL REFERENCES siton.deals(deal_id) ON DELETE CASCADE,
  link_id UUID NULL REFERENCES siton.affiliate_links(link_id) ON DELETE CASCADE,
  ref_code TEXT NULL CHECK (ref_code IS NULL OR char_length(ref_code) <= 120),
  share_channel TEXT NULL CHECK (
    share_channel IS NULL
    OR share_channel IN ('whatsapp','telegram','facebook','x','email','copy','native','other')
  ),
  visitor_id TEXT NULL CHECK (visitor_id IS NULL OR char_length(visitor_id) <= 64),
  session_id TEXT NULL CHECK (session_id IS NULL OR char_length(session_id) <= 64),
  client_event_id TEXT NOT NULL CHECK (char_length(client_event_id) BETWEEN 8 AND 100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (deal_id, event_type, client_event_id)
);

CREATE INDEX IF NOT EXISTS idx_viral_events_deal_type_created
  ON siton.viral_events (deal_id, event_type, created_at DESC);

-- 4) Asynchronously computed metrics cache (worker-owned).
CREATE TABLE IF NOT EXISTS siton.viral_metrics_cache (
  scope_type TEXT NOT NULL CHECK (scope_type IN ('platform','deal','seller')),
  scope_id TEXT NOT NULL CHECK (char_length(scope_id) BETWEEN 1 AND 120),
  metrics JSONB NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  compute_ms INTEGER NULL,
  PRIMARY KEY (scope_type, scope_id)
);

-- 5) Canonical Supabase identity-binding columns. These mirror
--    supabase/staging/002_auth_identity_foundation.sql idempotently so that
--    ledger-managed databases (local dev / test templates) carry the columns
--    the actor resolver reads. The auth.users FK exists only on Supabase and
--    is deliberately not declared here.
ALTER TABLE siton.seller_accounts ADD COLUMN IF NOT EXISTS auth_user_id uuid NULL;
ALTER TABLE siton.admin_users ADD COLUMN IF NOT EXISTS auth_user_id uuid NULL;
ALTER TABLE siton.affiliate_accounts ADD COLUMN IF NOT EXISTS auth_user_id uuid NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_seller_accounts_auth_user
  ON siton.seller_accounts (auth_user_id) WHERE auth_user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_admin_users_auth_user
  ON siton.admin_users (auth_user_id) WHERE auth_user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_affiliate_accounts_auth_user
  ON siton.affiliate_accounts (auth_user_id) WHERE auth_user_id IS NOT NULL;

-- Owner/admin provisioning provenance (who/what created the admin binding).
ALTER TABLE siton.admin_users ADD COLUMN IF NOT EXISTS provisioned_via TEXT NULL;
ALTER TABLE siton.admin_users ADD COLUMN IF NOT EXISTS provisioned_at TIMESTAMPTZ NULL;

-- 6) New worker job type: viral_recompute (aggregate_type 'deal').
ALTER TABLE siton.outbox_events DROP CONSTRAINT IF EXISTS outbox_events_event_type_check;
ALTER TABLE siton.outbox_events
  ADD CONSTRAINT outbox_events_event_type_check
  CHECK (event_type IN (
    'charge_deal',
    'recovery_deal',
    'finalize_deal',
    'refund_issue',
    'deadline_check',
    'cancel_refund',
    'seller_payout_prepare',
    'seller_payout_dispatch',
    'seller_payout_reconcile',
    'invoice_document_issue',
    'invoice_document_reconcile',
    'viral_recompute'
  ));

ALTER TABLE siton.outbox_dlq DROP CONSTRAINT IF EXISTS outbox_dlq_event_type_archive_check;
ALTER TABLE siton.outbox_dlq
  ADD CONSTRAINT outbox_dlq_event_type_archive_check
  CHECK (event_type IN (
    'charge_deal',
    'recovery_deal',
    'finalize_deal',
    'refund_issue',
    'deadline_check',
    'cancel_refund',
    'seller_payout_prepare',
    'seller_payout_dispatch',
    'seller_payout_reconcile',
    'invoice_document_issue',
    'invoice_document_reconcile',
    'viral_recompute'
  )) NOT VALID;

COMMIT;
