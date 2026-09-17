-- Migration 070: SELLER DISTRIBUTION HUB (attribution + analytics only).
--
-- A seller can mint several distribution links for the same deal (WhatsApp
-- group A, Facebook campaign, newsletter, an external person who spreads the
-- deal, ...) and measure each one separately. The links REUSE the canonical
-- siton.affiliate_links rail with origin_type='seller' (migration 051 already
-- made that origin representable) and the canonical click/entry event rail;
-- joins are attributed through siton.viral_attributions.parent_link_id by the
-- existing last-touch resolution inside the Join transaction.
--
-- Money truth: nothing here creates commission, balance, payout, invoice or any
-- other entitlement. Siton does not compute or manage any settlement between a
-- seller and a link holder. The optional external viewer below is a READ-ONLY,
-- link-scoped analytics credential: it is not a distributor role, it has no
-- seller surface, no participant data and no money authority.
--
-- Privacy: link events keep carrying no IP, user agent, buyer id, phone, email
-- or payment reference. visitor_id is the opaque anonymous browser id that the
-- viral funnel already uses (migration 051), so "unique visitors" can be
-- measured without identifying anyone.

BEGIN;

-- 1) Optional channel/source label on a link (seller-facing metadata only).
ALTER TABLE siton.affiliate_links
  ADD COLUMN IF NOT EXISTS channel TEXT NULL;
ALTER TABLE siton.affiliate_links
  DROP CONSTRAINT IF EXISTS affiliate_links_channel_length_check;
ALTER TABLE siton.affiliate_links
  ADD CONSTRAINT affiliate_links_channel_length_check
  CHECK (channel IS NULL OR char_length(btrim(channel)) BETWEEN 1 AND 40);

-- Seller links have no affiliate account, so the (affiliate_id, deal_id,
-- internal_name) uniqueness never applies to them. Keep internal names unique
-- per deal for the seller's own links so the comparison table stays readable.
CREATE UNIQUE INDEX IF NOT EXISTS ux_affiliate_links_seller_deal_name
  ON siton.affiliate_links (deal_id, lower(btrim(internal_name)))
  WHERE origin_type = 'seller';

-- 2) Opaque anonymous visitor id on click/entry events (unique visitors).
ALTER TABLE siton.affiliate_link_events
  ADD COLUMN IF NOT EXISTS visitor_id TEXT NULL;
ALTER TABLE siton.affiliate_link_events
  DROP CONSTRAINT IF EXISTS affiliate_link_events_visitor_id_check;
ALTER TABLE siton.affiliate_link_events
  ADD CONSTRAINT affiliate_link_events_visitor_id_check
  CHECK (visitor_id IS NULL OR char_length(visitor_id) BETWEEN 1 AND 64);
CREATE INDEX IF NOT EXISTS idx_affiliate_link_events_link_visitor
  ON siton.affiliate_link_events (link_id, event_type, visitor_id)
  WHERE visitor_id IS NOT NULL;

-- 3) External link viewer: a scoped read-only analytics identity.
--    Identity and link grants are separate tables so one identity can be
--    granted several links later without a schema change. Raw passwords are
--    never stored (scrypt hash, same scheme as seller access secrets).
CREATE TABLE IF NOT EXISTS siton.distribution_link_viewers (
  viewer_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT NOT NULL CHECK (username ~ '^[a-z0-9][a-z0-9_-]{5,63}$'),
  secret_hash TEXT NOT NULL CHECK (char_length(secret_hash) BETWEEN 20 AND 400),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_by_seller_id TEXT NOT NULL CHECK (char_length(created_by_seller_id) BETWEEN 1 AND 64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  secret_updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ NULL,
  revoked_at TIMESTAMPTZ NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_distribution_link_viewers_username
  ON siton.distribution_link_viewers (lower(username));

CREATE TABLE IF NOT EXISTS siton.distribution_link_viewer_grants (
  grant_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  viewer_id UUID NOT NULL REFERENCES siton.distribution_link_viewers(viewer_id) ON DELETE CASCADE,
  link_id UUID NOT NULL REFERENCES siton.affiliate_links(link_id) ON DELETE CASCADE,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ NULL,
  UNIQUE (viewer_id, link_id)
);

CREATE INDEX IF NOT EXISTS idx_distribution_link_viewer_grants_link_active
  ON siton.distribution_link_viewer_grants (link_id)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS siton.distribution_link_viewer_sessions (
  session_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  viewer_id UUID NOT NULL REFERENCES siton.distribution_link_viewers(viewer_id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ NULL,
  revoked_reason TEXT NULL CHECK (revoked_reason IS NULL OR char_length(revoked_reason) <= 120),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_distribution_link_viewer_session_expiry CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS idx_distribution_link_viewer_sessions_viewer_active
  ON siton.distribution_link_viewer_sessions (viewer_id, expires_at DESC)
  WHERE revoked_at IS NULL;

-- Login attempts are counted per caller address and per username so the
-- credential cannot be brute-forced. Only a bounded opaque key is stored.
CREATE TABLE IF NOT EXISTS siton.distribution_link_viewer_login_attempts (
  attempt_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_key TEXT NOT NULL CHECK (char_length(attempt_key) BETWEEN 1 AND 200),
  succeeded BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_distribution_link_viewer_login_attempts_key_created
  ON siton.distribution_link_viewer_login_attempts (attempt_key, created_at DESC);

COMMIT;
