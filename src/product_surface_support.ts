type WithTx = <T>(fn: (c: any) => Promise<T>) => Promise<T>;

import { SITON_PLATFORM_FEE_RATE } from "./platform_fee_money.js";
import { SITON_PLATFORM_FEE_VAT_RATE } from "./runtime_config.js";

export const DEFAULT_SELLER_ID = "seller-default";
export const DEFAULT_AFFILIATE_CODE = "affiliate-demo";
export const DEFAULT_AFFILIATE_NAME = "Affiliate Demo";

let ensurePromise: Promise<void> | null = null;

export function isChargedMoneyState(moneyState: string | null | undefined) {
  return moneyState === "ChargedSuccess" || moneyState === "RecoveredCharge";
}

// Siton platform fee base = everything actually collected from the buyer
// (price × qty + delivery). Excludes VAT. The fee itself is the system
// constant SITON_PLATFORM_FEE_RATE = 0.08. Distributors do NOT receive a fee.
export function summarizeMoney(args: {
  grossAmount: number;
  vatAmount?: number;
}) {
  const grossAmount = Number(args.grossAmount || 0);
  const vatAmount = Math.max(0, Number(args.vatAmount || 0));
  const feeBaseAmount = roundMoney(Math.max(0, grossAmount - vatAmount));
  const sitonFeeBaseAmount = roundMoney(feeBaseAmount * SITON_PLATFORM_FEE_RATE);
  const sitonFeeVatAmount = roundMoney(sitonFeeBaseAmount * SITON_PLATFORM_FEE_VAT_RATE);
  const sitonFeeTotalAmount = roundMoney(sitonFeeBaseAmount + sitonFeeVatAmount);
  return {
    gross_amount: grossAmount,
    vat_amount: roundMoney(vatAmount),
    fee_base_amount: feeBaseAmount,
    siton_fee_rate: SITON_PLATFORM_FEE_RATE,
    siton_fee_vat_rate: SITON_PLATFORM_FEE_VAT_RATE,
    siton_fee_base_amount: sitonFeeBaseAmount,
    siton_fee_vat_amount: sitonFeeVatAmount,
    siton_fee_total_amount: sitonFeeTotalAmount,
    siton_fee_amount: sitonFeeTotalAmount,
    seller_net_amount: roundMoney(grossAmount - sitonFeeTotalAmount)
  };
}

export function roundMoney(value: number) {
  // Use Math.round with scaling to avoid toFixed floating-point artifacts
  return Math.round((Number(value) || 0) * 100) / 100;
}

export async function ensureRemainingProductSurfaceTables(withTx: WithTx) {
  if (!ensurePromise) {
    // Assign the promise BEFORE starting async work to prevent concurrent duplicate executions
    ensurePromise = (async () => await withTx(async (c) => {
      await c.query(`
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
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`);

      await c.query(`
        ALTER TABLE siton.seller_accounts
        ADD COLUMN IF NOT EXISTS login_email TEXT NULL
      `);
      await c.query(`
        ALTER TABLE siton.seller_accounts
        ADD COLUMN IF NOT EXISTS auth_secret_hash TEXT NULL
      `);
      await c.query(`
        ALTER TABLE siton.seller_accounts
        ADD COLUMN IF NOT EXISTS auth_enabled BOOLEAN NOT NULL DEFAULT FALSE
      `);
      await c.query(`
        ALTER TABLE siton.seller_accounts
        ADD COLUMN IF NOT EXISTS auth_secret_updated_at TIMESTAMPTZ NULL
      `);
      await c.query(`
        ALTER TABLE siton.seller_accounts
        ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ NULL
      `);
      await c.query(`
        ALTER TABLE siton.seller_accounts
        ADD COLUMN IF NOT EXISTS last_login_ip TEXT NOT NULL DEFAULT ''
      `);
      await c.query(`
        ALTER TABLE siton.seller_accounts
        ADD COLUMN IF NOT EXISTS last_login_user_agent TEXT NOT NULL DEFAULT ''
      `);
      await c.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_seller_accounts_login_email
        ON siton.seller_accounts (lower(login_email))
        WHERE login_email IS NOT NULL AND btrim(login_email) <> ''
      `);

      await c.query(`
        CREATE TABLE IF NOT EXISTS siton.seller_sessions (
          session_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          seller_id TEXT NOT NULL REFERENCES siton.seller_accounts(seller_id) ON DELETE CASCADE,
          token_hash TEXT NOT NULL UNIQUE,
          issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          expires_at TIMESTAMPTZ NOT NULL,
          revoked_at TIMESTAMPTZ NULL,
          revoked_reason TEXT NOT NULL DEFAULT '',
          last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          created_ip TEXT NOT NULL DEFAULT '',
          created_user_agent TEXT NOT NULL DEFAULT ''
        )`);
      await c.query(`
        CREATE INDEX IF NOT EXISTS idx_seller_sessions_active
        ON siton.seller_sessions (seller_id, expires_at DESC)
      `);

      // Distributors are attribution-only per spec: link tracking, click/join
      // counts, attributed units. No commission, no payout, no settlement.
      await c.query(`
        CREATE TABLE IF NOT EXISTS siton.affiliate_accounts (
          affiliate_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          affiliate_code TEXT NOT NULL UNIQUE,
          display_name TEXT NOT NULL,
          verification_status TEXT NOT NULL DEFAULT 'pending'
            CHECK (verification_status IN ('pending','verified','rejected')),
          admin_note TEXT NOT NULL DEFAULT '',
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`);

      // Clean up pre-purge deployments where the attribution-only tables still
      // carry the distributor commission/payout columns.
      await c.query(`ALTER TABLE siton.affiliate_accounts DROP COLUMN IF EXISTS payout_status`);
      await c.query(`ALTER TABLE siton.affiliate_accounts DROP COLUMN IF EXISTS payout_method`);
      await c.query(`ALTER TABLE siton.affiliate_accounts DROP COLUMN IF EXISTS payout_details_masked`);

      await c.query(`
        CREATE TABLE IF NOT EXISTS siton.affiliate_attributions (
          attribution_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          affiliate_id UUID NOT NULL REFERENCES siton.affiliate_accounts(affiliate_id) ON DELETE CASCADE,
          deal_id UUID NOT NULL REFERENCES siton.deals(deal_id) ON DELETE CASCADE,
          participant_id UUID NOT NULL UNIQUE REFERENCES siton.participants(participant_id) ON DELETE CASCADE,
          share_code TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`);

      await c.query(`DROP INDEX IF EXISTS siton.idx_affiliate_attributions_deal`);
      await c.query(`DROP INDEX IF EXISTS siton.idx_affiliate_attributions_affiliate`);
      await c.query(`ALTER TABLE siton.affiliate_attributions DROP COLUMN IF EXISTS commission_rate`);
      await c.query(`ALTER TABLE siton.affiliate_attributions DROP COLUMN IF EXISTS commission_amount`);
      await c.query(`ALTER TABLE siton.affiliate_attributions DROP COLUMN IF EXISTS payout_status`);

      await c.query(`
        CREATE TABLE IF NOT EXISTS siton.delivery_records (
          delivery_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          deal_id UUID NOT NULL REFERENCES siton.deals(deal_id) ON DELETE CASCADE,
          participant_id UUID NOT NULL UNIQUE REFERENCES siton.participants(participant_id) ON DELETE CASCADE,
          status TEXT NOT NULL DEFAULT 'ready_to_fulfill'
            CHECK (status IN ('ready_to_fulfill','shipped','delivered','issue')),
          tracking_number TEXT NULL,
          issue_note TEXT NOT NULL DEFAULT '',
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`);

      await c.query(`
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
        )`);

      await c.query(`
        CREATE INDEX IF NOT EXISTS idx_affiliate_attributions_deal
        ON siton.affiliate_attributions (deal_id, created_at DESC)`);
      await c.query(`
        CREATE INDEX IF NOT EXISTS idx_affiliate_attributions_affiliate
        ON siton.affiliate_attributions (affiliate_id, created_at DESC)`);
      await c.query(`
        CREATE INDEX IF NOT EXISTS idx_delivery_records_deal
        ON siton.delivery_records (deal_id, status, updated_at DESC)`);
      await c.query(`
        CREATE INDEX IF NOT EXISTS idx_support_tickets_status
        ON siton.support_tickets (status, created_at DESC)`);

      await c.query(`
        CREATE TABLE IF NOT EXISTS siton.deal_delivery_options (
          option_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          deal_id UUID NOT NULL REFERENCES siton.deals(deal_id) ON DELETE CASCADE,
          option_type TEXT NOT NULL CHECK (option_type IN ('delivery','pickup','distribution_point')),
          label TEXT NOT NULL,
          cost NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (cost >= 0),
          sort_order INT NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`);

      await c.query(`
        CREATE TABLE IF NOT EXISTS siton.deal_images (
          image_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          deal_id UUID NOT NULL REFERENCES siton.deals(deal_id) ON DELETE CASCADE,
          storage_provider TEXT NOT NULL DEFAULT 'local',
          storage_key TEXT NOT NULL,
          public_url TEXT NULL,
          original_filename TEXT NULL,
          mime_type TEXT NOT NULL CHECK (mime_type IN ('image/jpeg','image/png','image/webp')),
          size_bytes INT NOT NULL CHECK (size_bytes > 0),
          width INT NULL,
          height INT NULL,
          sort_order INT NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
          is_primary BOOLEAN NOT NULL DEFAULT false,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`);

      await c.query(`
        ALTER TABLE siton.participants
        ADD COLUMN IF NOT EXISTS delivery_option_id UUID NULL
          REFERENCES siton.deal_delivery_options(option_id) ON DELETE SET NULL
      `);
      await c.query(`
        ALTER TABLE siton.participants
        ADD COLUMN IF NOT EXISTS delivery_method_type TEXT NULL
      `);
      await c.query(`
        ALTER TABLE siton.participants
        ADD COLUMN IF NOT EXISTS delivery_method_label TEXT NULL
      `);
      await c.query(`
        ALTER TABLE siton.participants
        ADD COLUMN IF NOT EXISTS delivery_cost NUMERIC(12,2) NOT NULL DEFAULT 0
      `);

      await c.query(`
        ALTER TABLE siton.participants
        ADD COLUMN IF NOT EXISTS buyer_name TEXT NULL
      `);
      await c.query(`
        ALTER TABLE siton.participants
        ADD COLUMN IF NOT EXISTS buyer_phone TEXT NULL
      `);
      await c.query(`
        ALTER TABLE siton.participants
        ADD COLUMN IF NOT EXISTS buyer_email TEXT NULL
      `);
      await c.query(`
        ALTER TABLE siton.participants
        ADD COLUMN IF NOT EXISTS delivery_address TEXT NULL
      `);
      await c.query(`
        ALTER TABLE siton.participants
        ADD COLUMN IF NOT EXISTS delivery_city TEXT NULL
      `);
      await c.query(`
        ALTER TABLE siton.participants
        ADD COLUMN IF NOT EXISTS delivery_notes TEXT NULL
      `);

      // Migration 028: seller business profile fields
      await c.query(`ALTER TABLE siton.seller_accounts ADD COLUMN IF NOT EXISTS business_name        TEXT NULL`);
      await c.query(`ALTER TABLE siton.seller_accounts ADD COLUMN IF NOT EXISTS contact_name         TEXT NULL`);
      await c.query(`ALTER TABLE siton.seller_accounts ADD COLUMN IF NOT EXISTS support_phone        TEXT NULL`);
      await c.query(`ALTER TABLE siton.seller_accounts ADD COLUMN IF NOT EXISTS support_email        TEXT NULL`);
      await c.query(`ALTER TABLE siton.seller_accounts ADD COLUMN IF NOT EXISTS business_description TEXT NULL`);
      await c.query(`ALTER TABLE siton.seller_accounts ADD COLUMN IF NOT EXISTS business_identifier  TEXT NULL`);

      await c.query(`
        CREATE INDEX IF NOT EXISTS idx_deal_delivery_options_deal
        ON siton.deal_delivery_options (deal_id, sort_order, created_at)
      `);
      await c.query(`
        CREATE INDEX IF NOT EXISTS idx_deal_images_deal_order
        ON siton.deal_images (deal_id, sort_order, created_at)
      `);
      await c.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_deal_images_one_primary
        ON siton.deal_images (deal_id)
        WHERE is_primary = true
      `);
      await c.query(`
        CREATE INDEX IF NOT EXISTS idx_participants_delivery_option
        ON siton.participants (delivery_option_id)
      `);

      await c.query(
        `INSERT INTO siton.seller_accounts (
           seller_id, display_name, verification_status, settlement_status, payout_method, payout_details_masked, admin_note
         )
         VALUES ($1, 'Default Seller Workspace', 'approved', 'active', 'bank_transfer', '***1234', 'Single-tenant internal seller profile')
         ON CONFLICT (seller_id) DO NOTHING`,
        [DEFAULT_SELLER_ID]
      );

      await c.query(`
        ALTER TABLE siton.deals
        ADD COLUMN IF NOT EXISTS seller_id TEXT
      `);

      await c.query(
        `UPDATE siton.deals
         SET seller_id = $1
         WHERE seller_id IS NULL OR btrim(seller_id) = ''`,
        [DEFAULT_SELLER_ID]
      );

      await c.query(`
        CREATE INDEX IF NOT EXISTS idx_deals_seller_created
        ON siton.deals (seller_id, created_at DESC)
      `);

      await c.query(
        `INSERT INTO siton.affiliate_accounts (
           affiliate_code, display_name, verification_status, admin_note
         )
         VALUES ($1, $2, 'pending', 'Demo affiliate profile used for attribution-only surfaces')
         ON CONFLICT (affiliate_code) DO NOTHING`,
        [DEFAULT_AFFILIATE_CODE, DEFAULT_AFFILIATE_NAME]
      );
    }))().catch((error) => {
      ensurePromise = null;
      throw error;
    });
  }

  return ensurePromise;
}
