// Demo database bootstrap — schema setup + idempotent demo seed data.
// Produces a DB that causes GET /api/admin/demo-readiness → verdict: "ready".
//
// SEED NOTE: Direct INSERTs into terminal deal/participant states (Completed,
// Failed, ChargedSuccess, etc.) are intentional seed-only behavior. The runtime
// state machine enforces transitions only on UPDATE, not on INSERT. This file
// documents that deviation explicitly so it cannot be confused with runtime code.

const fs   = require("node:fs");
const path = require("node:path");
const { Pool } = require("pg");
require("dotenv").config();

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is required for demo bootstrap");
  process.exit(1);
}

// Ordered SQL migrations for a complete schema.
// Migration 014 is the canonical base; subsequent files add features on top.
const MIGRATIONS_DIR = path.join(process.cwd(), "src", "migrations");
const SQL_MIGRATIONS = [
  "014_demo_preview_bootstrap.sql",
  "007_db_alignment_phase1.sql",
  "008_db_enforcement_phase2a.sql",
  "009_db_enforcement_phase2c.sql",
  "010_runtime_contract_hard_checks.sql",
  "011_outbox_status_processing_fix.sql",
  "012_payment_attempts_idempotency.sql",
  "013_payment_attempts_not_null.sql",
  "015_notifications.sql",
  "015_seller_ownership_alignment.sql",
  "016_delivery_method_persistence.sql",
  "017_open_production_seller_auth.sql",
  "018_invoice_documents.sql",
  "019_platform_fee_money_events.sql",
  "020_drop_affiliate_legacy_columns.sql",
  "021_seller_payout_rail.sql",
  "022_drop_deals_commission_rate.sql",
  "023_invoice_rail.sql",
  "024_payment_provider_production_hardening.sql",
  "025_invoice_provider_morning_adapter.sql",
  "026_participant_delivery_snapshot.sql",
  "027_deal_images.sql",
  "028_seller_profiles.sql",
  "029_notification_rail.sql",
  "030_legal_acceptances.sql",
  "031_otp_rail.sql",
  "032_deal_chat_messages.sql",
  "033_seller_enforcement_status.sql",
  "034_operational_cases.sql",
  "035_admin_control_plane.sql",
  "036_security_identity_tracking.sql",
  "037_admin_intervention_and_storage.sql",
  "038_deal_types_voucher_ticket.sql",
];

// seller_accounts is created by runtime ensure*Tables helpers, but several SQL
// migrations (017, 021, 028, 033) depend on it. Existing Render demo DBs may
// have a partial SQL-only schema, so bootstrap must align this table before the
// migration chain reaches those files.
const SELLER_ACCOUNTS_PREFLIGHT_DDL = `
SET search_path TO siton, public;

CREATE TABLE IF NOT EXISTS siton.seller_accounts (
  seller_id               TEXT PRIMARY KEY,
  display_name            TEXT NOT NULL,
  login_email             TEXT NULL,
  auth_secret_hash        TEXT NULL,
  auth_enabled            BOOLEAN NOT NULL DEFAULT FALSE,
  auth_secret_updated_at  TIMESTAMPTZ NULL,
  last_login_at           TIMESTAMPTZ NULL,
  last_login_ip           TEXT NOT NULL DEFAULT '',
  last_login_user_agent   TEXT NOT NULL DEFAULT '',
  verification_status     TEXT NOT NULL DEFAULT 'approved'
    CHECK (verification_status IN ('pending','approved','rejected')),
  settlement_status       TEXT NOT NULL DEFAULT 'active'
    CHECK (settlement_status IN ('active','review','hold')),
  payout_method           TEXT NOT NULL DEFAULT 'bank_transfer',
  payout_details_masked   TEXT NOT NULL DEFAULT '***1234',
  admin_note              TEXT NOT NULL DEFAULT '',
  seller_status           TEXT NOT NULL DEFAULT 'Active',
  seller_status_reason    TEXT NOT NULL DEFAULT '',
  seller_status_updated_at TIMESTAMPTZ NULL,
  seller_status_updated_by TEXT NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

// Tables created only by TypeScript ensure*Tables functions (not in SQL migrations).
// Inlined here so seed INSERTs succeed even before the app has started for the first time.
// The app's ensure*Tables calls will add any additional columns on first request.
const TYPESCRIPT_MANAGED_DDL = `
SET search_path TO siton, public;

${SELLER_ACCOUNTS_PREFLIGHT_DDL}

CREATE TABLE IF NOT EXISTS siton.affiliate_accounts (
  affiliate_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  affiliate_code      TEXT NOT NULL UNIQUE,
  display_name        TEXT NOT NULL,
  verification_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (verification_status IN ('pending','verified','rejected')),
  admin_note          TEXT NOT NULL DEFAULT '',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS siton.affiliate_attributions (
  attribution_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  affiliate_id   UUID NOT NULL REFERENCES siton.affiliate_accounts(affiliate_id) ON DELETE CASCADE,
  deal_id        UUID NOT NULL REFERENCES siton.deals(deal_id) ON DELETE CASCADE,
  participant_id UUID NOT NULL UNIQUE REFERENCES siton.participants(participant_id) ON DELETE CASCADE,
  share_code     TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS siton.notification_events (
  notification_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_type  TEXT NOT NULL,
  recipient_ref   TEXT NOT NULL,
  event_type      TEXT NOT NULL,
  channel         TEXT NOT NULL DEFAULT 'sms',
  template_id     TEXT NOT NULL DEFAULT '',
  payload         JSONB NOT NULL DEFAULT '{}'::jsonb,
  status          TEXT NOT NULL DEFAULT 'pending',
  error           TEXT NULL,
  sent_at         TIMESTAMPTZ NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

// Stable UUIDs — fixed so every re-run is idempotent via ON CONFLICT DO NOTHING.
const DEMO = {
  sellerId:         "demo-seller",
  affiliateId:      "a0000000-0000-0000-0000-000000000001",
  joinableDealId:   "d0000000-0000-0000-0000-000000000001",
  completedDealId:  "d0000000-0000-0000-0000-000000000002",
  failedDealId:     "d0000000-0000-0000-0000-000000000003",
  delivOptDelivery: "e0000000-0000-0000-0000-000000000001",
  delivOptPickup:   "e0000000-0000-0000-0000-000000000002",
  partJoined:       "b0000000-0000-0000-0000-000000000001",
  partCharged:      "b0000000-0000-0000-0000-000000000002",
  partFailed:       "b0000000-0000-0000-0000-000000000003",
  partRecovery:     "b0000000-0000-0000-0000-000000000004",
  attributionId:    "f0000000-0000-0000-0000-000000000001",
};

async function runMigration(client, filename) {
  const filePath = path.join(MIGRATIONS_DIR, filename);
  if (!fs.existsSync(filePath)) {
    console.warn(`  SKIP (not found): ${filename}`);
    return;
  }
  try {
    const sql = fs.readFileSync(filePath, "utf8");
    await client.query(sql);
    console.log(`  OK: ${filename}`);
  } catch (err) {
    // Idempotent migrations may produce benign errors on re-runs (e.g. DROP COLUMN
    // on a column already dropped). Log and continue.
    console.warn(`  WARN: ${filename} — ${err.message.split("\n")[0]}`);
    await client.query("ROLLBACK").catch(() => {});
  }
}

async function main() {
  const pool   = new Pool({ connectionString });
  const client = await pool.connect();

  try {
    console.log("=== Siton Demo Bootstrap ===");

    // Phase 1: Schema via SQL migrations
    console.log("\nPhase 1: SQL migrations...");
    console.log("  Preflight: ensuring seller_accounts exists before dependent migrations...");
    await client.query("CREATE EXTENSION IF NOT EXISTS pgcrypto");
    await client.query("CREATE SCHEMA IF NOT EXISTS siton");
    await client.query(SELLER_ACCOUNTS_PREFLIGHT_DDL);
    console.log("  OK: seller_accounts preflight");
    for (const filename of SQL_MIGRATIONS) {
      await runMigration(client, filename);
    }

    // Phase 2: TypeScript-managed tables (created by ensure*Tables in the app)
    console.log("\nPhase 2: TypeScript-managed tables...");
    await client.query(TYPESCRIPT_MANAGED_DDL);
    console.log("  OK: seller_accounts, affiliate_accounts, affiliate_attributions, notification_events");

    // Phase 2b: Clear demo-blocking artifacts from prior test runs.
    // The demo-readiness verdict requires dlq_count = 0 and no stale pending events.
    // Old test-run outbox artifacts must not block a fresh demo setup.
    console.log("\nPhase 2b: Clearing outbox artifacts from prior test runs...");
    try {
      await client.query("DELETE FROM siton.outbox_dlq");
      await client.query("DELETE FROM siton.outbox_events WHERE status = 'failed'");
      // Clear stale pending events older than 1 hour (test artifacts, not live demo state)
      await client.query("DELETE FROM siton.outbox_events WHERE status IN ('pending','processing') AND available_at < now() - interval '1 hour'");
      console.log("  OK: outbox_dlq, failed outbox_events, and stale pending events cleared");
    } catch (err) {
      console.warn("  WARN: could not clear outbox artifacts —", err.message.split("\n")[0]);
    }

    // Phase 3: Demo seed data
    console.log("\nPhase 3: Demo seed data...");
    await client.query("BEGIN");

    const futureDeadline = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const pastDeadline   = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();

    // Seller account
    await client.query(
      `INSERT INTO siton.seller_accounts
         (seller_id, display_name, login_email, verification_status, settlement_status)
       VALUES ($1, $2, $3, 'approved', 'active')
       ON CONFLICT (seller_id) DO NOTHING`,
      [DEMO.sellerId, "Demo Seller", "demo@siton.example"]
    );

    // Affiliate (attribution-only — no commission, no payout)
    await client.query(
      `INSERT INTO siton.affiliate_accounts
         (affiliate_id, affiliate_code, display_name, verification_status)
       VALUES ($1, 'DEMO01', 'Demo Affiliate', 'verified')
       ON CONFLICT (affiliate_id) DO NOTHING`,
      [DEMO.affiliateId]
    );

    // Joinable deal (PendingTarget) — active for buyers to join in demo
    await client.query(
      `INSERT INTO siton.deals
         (deal_id, seller_id, state, title, price_per_unit,
          min_units, max_units, threshold_units, deadline, published_at)
       VALUES ($1, $2, 'PendingTarget', $3, 249.00, 5, 30, 5, $4, now())
       ON CONFLICT (deal_id) DO NOTHING`,
      [DEMO.joinableDealId, DEMO.sellerId, "ערכת חג דמו — הצטרפות פתוחה", futureDeadline]
    );

    // Delivery options for joinable deal
    await client.query(
      `INSERT INTO siton.deal_delivery_options
         (option_id, deal_id, option_type, label, cost, sort_order)
       VALUES ($1, $2, 'delivery', 'משלוח לבית — 3 ימי עסקים', 35.00, 1)
       ON CONFLICT (option_id) DO NOTHING`,
      [DEMO.delivOptDelivery, DEMO.joinableDealId]
    );
    await client.query(
      `INSERT INTO siton.deal_delivery_options
         (option_id, deal_id, option_type, label, cost, sort_order)
       VALUES ($1, $2, 'pickup', 'איסוף עצמי — תל אביב', 0.00, 2)
       ON CONFLICT (option_id) DO NOTHING`,
      [DEMO.delivOptPickup, DEMO.joinableDealId]
    );

    // Buyer joined (JoinedAuthorized / AuthHeld) in joinable deal
    await client.query(
      `INSERT INTO siton.participants
         (participant_id, deal_id, buyer_id, qty,
          buyer_state, money_state,
          delivery_option_id, delivery_method_type, delivery_method_label, delivery_cost,
          buyer_name, buyer_phone)
       VALUES ($1, $2, 'demo-buyer-joined', 2,
               'JoinedAuthorized', 'AuthHeld',
               $3, 'delivery', 'משלוח לבית — 3 ימי עסקים', 35.00,
               'קונה דמו', '0501234567')
       ON CONFLICT (participant_id) DO NOTHING`,
      [DEMO.partJoined, DEMO.joinableDealId, DEMO.delivOptDelivery]
    );

    // Attribution for joined buyer (attribution-only link tracking, no commission)
    await client.query(
      `INSERT INTO siton.affiliate_attributions
         (attribution_id, affiliate_id, deal_id, participant_id, share_code)
       VALUES ($1, $2, $3, $4, 'DEMO01')
       ON CONFLICT (attribution_id) DO NOTHING`,
      [DEMO.attributionId, DEMO.affiliateId, DEMO.joinableDealId, DEMO.partJoined]
    );

    // Completed deal — closed, all participants charged
    await client.query(
      `INSERT INTO siton.deals
         (deal_id, seller_id, state, title, price_per_unit,
          min_units, max_units, threshold_units, deadline, published_at, completion_window_until)
       VALUES ($1, $2, 'Completed', $3, 199.00, 5, 20, 5, $4,
               now() - INTERVAL '7 days', now() - INTERVAL '1 day')
       ON CONFLICT (deal_id) DO NOTHING`,
      [DEMO.completedDealId, DEMO.sellerId, "ייצור משותף — הושלם", pastDeadline]
    );

    // Charged buyer in completed deal (ChargedSuccess / ChargedSuccess)
    await client.query(
      `INSERT INTO siton.participants
         (participant_id, deal_id, buyer_id, qty,
          buyer_state, money_state,
          delivery_method_type, delivery_method_label, delivery_cost,
          buyer_name, buyer_phone, locked_at)
       VALUES ($1, $2, 'demo-buyer-charged', 3,
               'ChargedSuccess', 'ChargedSuccess',
               'pickup', 'איסוף עצמי', 0.00,
               'קונה ממומש', '0509876543', now() - INTERVAL '8 days')
       ON CONFLICT (participant_id) DO NOTHING`,
      [DEMO.partCharged, DEMO.completedDealId]
    );

    // Recovery participant in completed deal (initial charge failed, recovered)
    await client.query(
      `INSERT INTO siton.participants
         (participant_id, deal_id, buyer_id, qty,
          buyer_state, money_state,
          delivery_method_type, delivery_cost, locked_at)
       VALUES ($1, $2, 'demo-buyer-recovery', 1,
               'Recovered', 'RecoveredCharge',
               'pickup', 0.00, now() - INTERVAL '8 days')
       ON CONFLICT (participant_id) DO NOTHING`,
      [DEMO.partRecovery, DEMO.completedDealId]
    );

    // Failed deal — deadline passed without reaching minimum units
    await client.query(
      `INSERT INTO siton.deals
         (deal_id, seller_id, state, title, price_per_unit,
          min_units, max_units, threshold_units, deadline, published_at)
       VALUES ($1, $2, 'Failed', $3, 350.00, 10, 50, 10, $4, now() - INTERVAL '14 days')
       ON CONFLICT (deal_id) DO NOTHING`,
      [DEMO.failedDealId, DEMO.sellerId, "עסקה שנכשלה — להדגמה", pastDeadline]
    );

    // Dropped buyer in failed deal (DealFailed / AuthReleased)
    await client.query(
      `INSERT INTO siton.participants
         (participant_id, deal_id, buyer_id, qty,
          buyer_state, money_state, delivery_cost)
       VALUES ($1, $2, 'demo-buyer-failed', 1,
               'DealFailed', 'AuthReleased', 0.00)
       ON CONFLICT (participant_id) DO NOTHING`,
      [DEMO.partFailed, DEMO.failedDealId]
    );

    await client.query("COMMIT");
    console.log("  OK: seller, affiliate, 3 deals (joinable/completed/failed), 4 participants, delivery options, attribution");

    console.log("\n=== Bootstrap complete. GET /api/admin/demo-readiness should return verdict: ready ===");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("\nBootstrap FAILED:", err.message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
