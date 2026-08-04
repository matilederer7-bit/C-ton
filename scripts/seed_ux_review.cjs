const { Pool } = require("pg");
require("dotenv").config({ quiet: true });

const deploymentMode = String(process.env.APP_DEPLOYMENT_MODE || "");
const paymentProvider = String(process.env.PAYMENT_PROVIDER || "");
const paymentMode = String(process.env.PAYMENT_PROVIDER_MODE || "");
if (deploymentMode !== "demo-preview") throw new Error("UX review fixtures require APP_DEPLOYMENT_MODE=demo-preview");
if (!['mock', 'mockpay'].includes(paymentProvider) || !['mock', 'mock-backed'].includes(paymentMode)) {
  throw new Error("UX review fixtures require mock payment only");
}
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

const sellerId = "ux-review-seller";
const deals = [
  ["d1000000-0000-0000-0000-000000000001", "Draft", "UX Demo - Draft coffee kit", 179, 5, 25, 5, null],
  ["d1000000-0000-0000-0000-000000000002", "PendingTarget", "UX Demo - Open picnic bundle", 229, 10, 40, 10, 2],
  ["d1000000-0000-0000-0000-000000000003", "PendingTarget", "UX Demo - Near target cookware", 349, 10, 25, 10, 9],
  ["d1000000-0000-0000-0000-000000000004", "TargetReached", "UX Demo - Target reached bedding", 299, 10, 30, 10, 10],
  ["d1000000-0000-0000-0000-000000000005", "ClosedForJoining", "UX Demo - Joining closed speakers", 459, 5, 15, 5, 6],
  ["d1000000-0000-0000-0000-000000000006", "Cancelled", "UX Demo - Cancelled garden set", 389, 8, 20, 8, null],
  ["d1000000-0000-0000-0000-000000000007", "PendingTarget", "UX Demo - Last units travel case", 189, 2, 3, 2, 2],
  ["d1000000-0000-0000-0000-000000000008", "PendingTarget", "UX Demo - Delivery choice pantry box", 269, 5, 20, 5, 3],
  ["d1000000-0000-0000-0000-000000000009", "PendingTarget", "UX Demo - Product with image", 149, 4, 18, 4, 1],
  ["d1000000-0000-0000-0000-000000000010", "PendingTarget", "UX Demo - Product without image", 119, 4, 18, 4, null]
];

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
async function main() {
  const client = await pool.connect();
  const future = new Date(Date.now() + 10 * 86400000).toISOString();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO siton.seller_accounts
         (seller_id,display_name,login_email,verification_status,settlement_status,business_name,support_email)
       VALUES ($1,'UX Review Seller','ux-review@siton.example','approved','active','UX Review Seller','ux-review@siton.example')
       ON CONFLICT (seller_id) DO UPDATE SET display_name=EXCLUDED.display_name,business_name=EXCLUDED.business_name`,
      [sellerId]
    );
    for (const [dealId, state, title, price, min, max, threshold, joined] of deals) {
      await client.query(
        `INSERT INTO siton.deals
           (deal_id,seller_id,state,title,price_per_unit,min_units,max_units,threshold_units,deadline,published_at)
         VALUES ($1,$2,$3::siton.deal_state,$4,$5,$6,$7,$8,$9,CASE WHEN $3::text='Draft' THEN NULL ELSE now() END)
         ON CONFLICT (deal_id) DO NOTHING`,
        [dealId, sellerId, state, title, price, min, max, threshold, future]
      );
      if (joined) {
        const participantId = dealId.replace(/^d1/, "b1");
        const closed = state === "ClosedForJoining";
        await client.query(
          `INSERT INTO siton.participants
             (participant_id,deal_id,buyer_id,qty,buyer_state,money_state,delivery_method_type,delivery_method_label,delivery_cost,buyer_name)
           VALUES ($1,$2,$3,$4,$5,$6,'pickup','Synthetic pickup',0,'Synthetic UX Buyer')
           ON CONFLICT (participant_id) DO NOTHING`,
          [participantId, dealId, `ux-buyer-${dealId.slice(-4)}`, joined, closed ? "LockedIn" : "JoinedAuthorized", closed ? "AuthLocked" : "AuthHeld"]
        );
      }
    }
    const deliveryDeal = deals[7][0];
    const options = [
      ["e1000000-0000-0000-0000-000000000081", "delivery", "Home delivery - synthetic", 35, 1],
      ["e1000000-0000-0000-0000-000000000082", "pickup", "Pickup point - synthetic", 0, 2],
      ["e1000000-0000-0000-0000-000000000083", "distribution_point", "Community distribution - synthetic", 15, 3]
    ];
    for (const [id, type, label, cost, order] of options) {
      await client.query(
        `INSERT INTO siton.deal_delivery_options(option_id,deal_id,option_type,label,cost,sort_order)
         VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(option_id) DO UPDATE SET label=EXCLUDED.label,cost=EXCLUDED.cost,sort_order=EXCLUDED.sort_order`,
        [id, deliveryDeal, type, label, cost, order]
      );
    }
    const imageUrl = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1200' height='800'%3E%3Crect width='1200' height='800' fill='%23F4A261'/%3E%3Ccircle cx='600' cy='330' r='190' fill='%23FFF7ED'/%3E%3Ctext x='600' y='650' text-anchor='middle' font-family='Arial' font-size='64' fill='%23312E2B'%3ESynthetic demo product%3C/text%3E%3C/svg%3E";
    await client.query(
      `INSERT INTO siton.deal_images(image_id,deal_id,storage_provider,storage_key,public_url,original_filename,mime_type,size_bytes,width,height,sort_order,is_primary)
       VALUES('a1000000-0000-0000-0000-000000000091',$1,'ux-fixture','synthetic-demo-product.svg',$2,'synthetic-demo-product.svg','image/png',512,1200,800,0,true)
       ON CONFLICT(image_id) DO UPDATE SET public_url=EXCLUDED.public_url,is_primary=true`,
      [deals[8][0], imageUrl]
    );
    await client.query("COMMIT");
    console.log(`UX_REVIEW_SEED_COMPLETE deals=${deals.length} seller=${sellerId} synthetic_only=true`);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}
main().catch((error) => { console.error(`UX_REVIEW_SEED_FAILED ${error.message}`); process.exitCode = 1; });