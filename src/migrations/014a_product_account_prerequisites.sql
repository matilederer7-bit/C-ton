BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS siton;
SET search_path TO siton, public;

CREATE TABLE IF NOT EXISTS siton.seller_accounts (
  seller_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  login_email TEXT NULL,
  auth_secret_hash TEXT NULL,
  auth_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  auth_secret_updated_at TIMESTAMPTZ NULL,
  last_login_at TIMESTAMPTZ NULL,
  last_login_ip TEXT NOT NULL DEFAULT '',
  last_login_user_agent TEXT NOT NULL DEFAULT '',
  verification_status TEXT NOT NULL DEFAULT 'approved'
    CHECK (verification_status IN ('pending','approved','rejected')),
  settlement_status TEXT NOT NULL DEFAULT 'active'
    CHECK (settlement_status IN ('active','review','hold')),
  payout_method TEXT NOT NULL DEFAULT 'bank_transfer',
  payout_details_masked TEXT NOT NULL DEFAULT '***1234',
  admin_note TEXT NOT NULL DEFAULT '',
  seller_status TEXT NOT NULL DEFAULT 'Active',
  seller_status_reason TEXT NOT NULL DEFAULT '',
  seller_status_updated_at TIMESTAMPTZ NULL,
  seller_status_updated_by TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS siton.affiliate_accounts (
  affiliate_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  affiliate_code TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  verification_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (verification_status IN ('pending','verified','rejected')),
  admin_note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS siton.affiliate_attributions (
  attribution_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  affiliate_id UUID NOT NULL REFERENCES siton.affiliate_accounts(affiliate_id) ON DELETE CASCADE,
  deal_id UUID NOT NULL REFERENCES siton.deals(deal_id) ON DELETE CASCADE,
  participant_id UUID NOT NULL UNIQUE REFERENCES siton.participants(participant_id) ON DELETE CASCADE,
  share_code TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS siton.support_tickets (
  ticket_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_type TEXT NOT NULL CHECK (scope_type IN ('deal','participant','affiliate','seller','system')),
  scope_key TEXT NOT NULL,
  title TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal','high')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','investigating','resolved')),
  summary TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_affiliate_attributions_deal
  ON siton.affiliate_attributions (deal_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_affiliate_attributions_affiliate
  ON siton.affiliate_attributions (affiliate_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_tickets_status
  ON siton.support_tickets (status, created_at DESC);

COMMIT;
