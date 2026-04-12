type WithTx = <T>(fn: (c: any) => Promise<T>) => Promise<T>;

export const DEFAULT_SELLER_ID = "seller-default";
export const DEFAULT_AFFILIATE_CODE = "affiliate-demo";
export const DEFAULT_AFFILIATE_NAME = "Affiliate Demo";
export const AFFILIATE_FEE_SHARE_OF_PLATFORM = 1;

let ensurePromise: Promise<void> | null = null;

export function isChargedMoneyState(moneyState: string | null | undefined) {
  return moneyState === "ChargedSuccess" || moneyState === "RecoveredCharge";
}

export function summarizeMoney(args: {
  grossAmount: number;
  commissionRate: number;
  affiliateAmount: number;
}) {
  const grossAmount = Number(args.grossAmount || 0);
  const commissionRate = Number(args.commissionRate || 0);
  const affiliateAmount = Number(args.affiliateAmount || 0);
  const sitonFeeAmount = roundMoney(grossAmount * commissionRate);
  return {
    gross_amount: grossAmount,
    siton_fee_rate: commissionRate,
    siton_fee_amount: sitonFeeAmount,
    affiliate_fee_amount: affiliateAmount,
    seller_net_amount: roundMoney(grossAmount - sitonFeeAmount)
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
        CREATE TABLE IF NOT EXISTS siton.affiliate_accounts (
          affiliate_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          affiliate_code TEXT NOT NULL UNIQUE,
          display_name TEXT NOT NULL,
          verification_status TEXT NOT NULL DEFAULT 'pending'
            CHECK (verification_status IN ('pending','verified','rejected')),
          payout_status TEXT NOT NULL DEFAULT 'pending_profile'
            CHECK (payout_status IN ('pending_profile','pending_review','approved','paid','hold')),
          payout_method TEXT NOT NULL DEFAULT 'bank_transfer',
          payout_details_masked TEXT NOT NULL DEFAULT '',
          admin_note TEXT NOT NULL DEFAULT '',
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`);

      await c.query(`
        CREATE TABLE IF NOT EXISTS siton.affiliate_attributions (
          attribution_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          affiliate_id UUID NOT NULL REFERENCES siton.affiliate_accounts(affiliate_id) ON DELETE CASCADE,
          deal_id UUID NOT NULL REFERENCES siton.deals(deal_id) ON DELETE CASCADE,
          participant_id UUID NOT NULL UNIQUE REFERENCES siton.participants(participant_id) ON DELETE CASCADE,
          share_code TEXT NOT NULL,
          commission_rate NUMERIC(6,4) NOT NULL DEFAULT 0,
          commission_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
          payout_status TEXT NOT NULL DEFAULT 'pending'
            CHECK (payout_status IN ('pending','approved','paid','void')),
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`);

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
        ON siton.affiliate_attributions (deal_id, payout_status, created_at DESC)`);
      await c.query(`
        CREATE INDEX IF NOT EXISTS idx_affiliate_attributions_affiliate
        ON siton.affiliate_attributions (affiliate_id, payout_status, created_at DESC)`);
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
        CREATE INDEX IF NOT EXISTS idx_deal_delivery_options_deal
        ON siton.deal_delivery_options (deal_id, sort_order, created_at)
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
           affiliate_code, display_name, verification_status, payout_status, payout_method, payout_details_masked, admin_note
         )
         VALUES ($1, $2, 'pending', 'pending_profile', 'bank_transfer', '', 'Demo affiliate profile used for current-spec closure surfaces')
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
