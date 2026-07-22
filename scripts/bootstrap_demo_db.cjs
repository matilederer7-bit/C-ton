// Canonical schema migrations followed by explicit, idempotent demo seed DML.
const { Pool } = require("pg");
const { runMigrations } = require("./run_migrations.cjs");
require("dotenv").config({ quiet: true });

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for demo bootstrap");

const DEMO = {
  sellerId: "demo-seller",
  affiliateId: "a0000000-0000-0000-0000-000000000001",
  joinableDealId: "d0000000-0000-0000-0000-000000000001",
  completedDealId: "d0000000-0000-0000-0000-000000000002",
  failedDealId: "d0000000-0000-0000-0000-000000000003",
  delivOptDelivery: "e0000000-0000-0000-0000-000000000001",
  delivOptPickup: "e0000000-0000-0000-0000-000000000002",
  partJoined: "b0000000-0000-0000-0000-000000000001",
  partCharged: "b0000000-0000-0000-0000-000000000002",
  partFailed: "b0000000-0000-0000-0000-000000000003",
  partRecovery: "b0000000-0000-0000-0000-000000000004",
  attributionId: "f0000000-0000-0000-0000-000000000001"
};

async function seedDemo(client) {
  const futureDeadline = new Date(Date.now() + 7 * 86400000).toISOString();
  const pastDeadline = new Date(Date.now() - 3 * 86400000).toISOString();
  await client.query("BEGIN");
  try {
    await client.query(
      `INSERT INTO siton.seller_accounts
         (seller_id, display_name, login_email, verification_status, settlement_status,
          business_name, support_email)
       VALUES ($1,'Demo Seller','demo@siton.example','approved','active','Demo Seller','demo@siton.example')
       ON CONFLICT (seller_id) DO NOTHING`,
      [DEMO.sellerId]
    );
    await client.query(
      `INSERT INTO siton.affiliate_accounts
         (affiliate_id, affiliate_code, display_name, verification_status)
       VALUES ($1,'DEMO01','Demo Affiliate','verified')
       ON CONFLICT (affiliate_id) DO NOTHING`,
      [DEMO.affiliateId]
    );
    await client.query(
      `INSERT INTO siton.deals
         (deal_id,seller_id,state,title,price_per_unit,min_units,max_units,threshold_units,deadline,published_at)
       VALUES ($1,$2,'PendingTarget','Demo joinable deal',249,5,30,5,$3,now())
       ON CONFLICT (deal_id) DO NOTHING`,
      [DEMO.joinableDealId, DEMO.sellerId, futureDeadline]
    );
    await client.query(
      `INSERT INTO siton.deal_delivery_options
         (option_id,deal_id,option_type,label,cost,sort_order)
       VALUES ($1,$2,'delivery','Home delivery',35,1),($3,$2,'pickup','Self pickup',0,2)
       ON CONFLICT (option_id) DO NOTHING`,
      [DEMO.delivOptDelivery, DEMO.joinableDealId, DEMO.delivOptPickup]
    );
    await client.query(
      `INSERT INTO siton.participants
         (participant_id,deal_id,buyer_id,qty,buyer_state,money_state,
          delivery_option_id,delivery_method_type,delivery_method_label,delivery_cost,buyer_name,buyer_phone)
       VALUES ($1,$2,'demo-buyer-joined',2,'JoinedAuthorized','AuthHeld',
               $3,'delivery','Home delivery',35,'Demo Buyer','0501234567')
       ON CONFLICT (participant_id) DO NOTHING`,
      [DEMO.partJoined, DEMO.joinableDealId, DEMO.delivOptDelivery]
    );
    await client.query(
      `INSERT INTO siton.affiliate_attributions
         (attribution_id,affiliate_id,deal_id,participant_id,share_code)
       VALUES ($1,$2,$3,$4,'DEMO01') ON CONFLICT (attribution_id) DO NOTHING`,
      [DEMO.attributionId, DEMO.affiliateId, DEMO.joinableDealId, DEMO.partJoined]
    );
    await client.query(
      `INSERT INTO siton.deals
         (deal_id,seller_id,state,title,price_per_unit,min_units,max_units,threshold_units,
          deadline,published_at,completion_window_until)
       VALUES ($1,$2,'Completed','Demo completed deal',199,5,20,5,$3,
               now()-interval '7 days',now()-interval '1 day')
       ON CONFLICT (deal_id) DO NOTHING`,
      [DEMO.completedDealId, DEMO.sellerId, pastDeadline]
    );
    await client.query(
      `INSERT INTO siton.participants
         (participant_id,deal_id,buyer_id,qty,buyer_state,money_state,
          delivery_method_type,delivery_method_label,delivery_cost,buyer_name,buyer_phone,locked_at)
       VALUES ($1,$2,'demo-buyer-charged',3,'ChargedSuccess','ChargedSuccess',
               'pickup','Self pickup',0,'Charged Buyer','0509876543',now()-interval '8 days')
       ON CONFLICT (participant_id) DO NOTHING`,
      [DEMO.partCharged, DEMO.completedDealId]
    );
    await client.query(
      `INSERT INTO siton.participants
         (participant_id,deal_id,buyer_id,qty,buyer_state,money_state,delivery_method_type,delivery_cost,locked_at)
       VALUES ($1,$2,'demo-buyer-recovery',1,'Recovered','RecoveredCharge','pickup',0,now()-interval '8 days')
       ON CONFLICT (participant_id) DO NOTHING`,
      [DEMO.partRecovery, DEMO.completedDealId]
    );
    await client.query(
      `INSERT INTO siton.deals
         (deal_id,seller_id,state,title,price_per_unit,min_units,max_units,threshold_units,deadline,published_at)
       VALUES ($1,$2,'Failed','Demo failed deal',350,10,50,10,$3,now()-interval '14 days')
       ON CONFLICT (deal_id) DO NOTHING`,
      [DEMO.failedDealId, DEMO.sellerId, pastDeadline]
    );
    await client.query(
      `INSERT INTO siton.participants
         (participant_id,deal_id,buyer_id,qty,buyer_state,money_state,delivery_cost)
       VALUES ($1,$2,'demo-buyer-failed',1,'DealFailed','AuthReleased',0)
       ON CONFLICT (participant_id) DO NOTHING`,
      [DEMO.partFailed, DEMO.failedDealId]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function main() {
  console.log("=== Siton Demo Bootstrap ===");
  await runMigrations(connectionString);
  const pool = new Pool({ connectionString });
  const client = await pool.connect();
  try {
    await client.query("DELETE FROM siton.outbox_dlq");
    await client.query("DELETE FROM siton.outbox_events WHERE status='failed'");
    await client.query(
      `DELETE FROM siton.outbox_events
       WHERE status IN ('pending','processing') AND available_at < now()-interval '1 hour'`
    );
    await seedDemo(client);
    console.log("BOOTSTRAP_COMPLETE migrations=canonical seed=demo");
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(`BOOTSTRAP_FAILED ${error.message}`);
  process.exitCode = 1;
});
