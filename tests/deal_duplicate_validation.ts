import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";

process.env.PORT = String(process.env.PORT || "3472");
process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.DISABLE_OUTBOX_WORKER = "1";

const { app } = await import("../src/app.js");

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton",
  max: 5
});

async function run(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

async function seedSeller(label: string) {
  const sellerId = `dup-${label}-${randomUUID().slice(0, 8)}`;
  await pool.query(
    `INSERT INTO siton.seller_accounts (seller_id, display_name, business_name, support_email)
     VALUES ($1,$2,$2,$3)
     ON CONFLICT (seller_id) DO UPDATE
     SET business_name=EXCLUDED.business_name, support_email=EXCLUDED.support_email`,
    [sellerId, `Duplicate ${label} Seller`, `${label}@example.test`]
  );
  return sellerId;
}

async function seedDeal(sellerId: string, state = "Completed") {
  const dealId = randomUUID();
  await pool.query(
    `INSERT INTO siton.deals
       (deal_id, seller_id, title, state, threshold_units, min_units, max_units,
        price_per_unit, deadline, published_at, created_at, updated_at)
     VALUES ($1,$2,$3,$4::siton.deal_state,2,2,20,88.00,
             now()+interval '7 days',
             CASE WHEN $4::text='Draft' THEN NULL ELSE now() END,
             now(),now())`,
    [dealId, sellerId, `Duplicate Source ${dealId.slice(0, 8)}`, state]
  );
  await pool.query(
    `INSERT INTO siton.deal_delivery_options (deal_id, option_type, label, cost, sort_order)
     VALUES
       ($1,'pickup','Pickup point',0,0),
       ($1,'delivery','Courier',19.90,1)`,
    [dealId]
  );
  await pool.query(
    `INSERT INTO siton.deal_images
       (deal_id, storage_provider, storage_key, public_url, original_filename, mime_type, size_bytes, sort_order, is_primary)
     VALUES ($1,'local',$2,$3,'product.png','image/png',128,0,true)`,
    [dealId, `deal-images/${dealId}/product.png`, `/api/deal-images/${randomUUID()}`]
  );
  return dealId;
}

async function seedParticipantAndSideEffects(dealId: string, sellerId: string) {
  const participantId = randomUUID();
  await pool.query(
    `INSERT INTO siton.participants
       (participant_id, deal_id, buyer_id, qty, buyer_state, money_state, created_at, updated_at)
     VALUES ($1,$2,'buyer-duplicate-test',2,'DealCompleted','ChargedSuccess',now(),now())`,
    [participantId, dealId]
  );
  await pool.query(
    `INSERT INTO siton.payment_attempts
       (participant_id, deal_id, attempt_type, result_class, correlation_id)
     VALUES ($1,$2,'charge_start','success',$3)`,
    [participantId, dealId, `dup-${participantId}`]
  );
  await pool.query(
    `INSERT INTO siton.outbox_events (event_type, aggregate_type, aggregate_id, payload, status)
     VALUES ('deadline_check','deal',$1,'{}','pending')
     ON CONFLICT DO NOTHING`,
    [dealId]
  );
  await pool.query(
    `INSERT INTO siton.notification_events
       (event_type, recipient_type, recipient_ref, deal_id, participant_id, seller_id,
        channel, template_key, payload_jsonb, status, idempotency_key)
     VALUES ('seller_deal_completed','seller',$2,$1,NULL,$2,'internal','seller_deal_completed_he','{}','pending',$3)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [dealId, sellerId, `dup-notification-${dealId}`]
  );
  await pool.query(
    `INSERT INTO siton.legal_acceptances
       (actor_type, actor_ref, deal_id, participant_id, acceptance_type, policy_version)
     VALUES ('seller',$2,$1,NULL,'seller_publish_terms','2026-04-26')
     ON CONFLICT DO NOTHING`,
    [dealId, sellerId]
  );
  return participantId;
}

async function duplicateDeal(dealId: string, sellerId: string) {
  return app.inject({
    method: "POST",
    url: `/api/seller/deals/${dealId}/duplicate`,
    headers: { "x-seller-id": sellerId }
  });
}

async function countByDeal(table: string, dealId: string) {
  const result = await pool.query(`SELECT COUNT(*)::int AS count FROM siton.${table} WHERE deal_id=$1`, [dealId]);
  return Number(result.rows[0].count);
}

async function cleanupDeals(dealIds: string[]) {
  for (const dealId of dealIds) {
    await pool.query(`DELETE FROM siton.notification_events WHERE deal_id=$1`, [dealId]).catch(() => undefined);
    await pool.query(`DELETE FROM siton.legal_acceptances WHERE deal_id=$1`, [dealId]).catch(() => undefined);
    await pool.query(`DELETE FROM siton.payment_attempts WHERE deal_id=$1`, [dealId]).catch(() => undefined);
    await pool.query(`DELETE FROM siton.outbox_events WHERE aggregate_id=$1`, [dealId]).catch(() => undefined);
    await pool.query(`DELETE FROM siton.participants WHERE deal_id=$1`, [dealId]).catch(() => undefined);
    await pool.query(`DELETE FROM siton.deal_delivery_options WHERE deal_id=$1`, [dealId]).catch(() => undefined);
    await pool.query(`DELETE FROM siton.deal_images WHERE deal_id=$1`, [dealId]).catch(() => undefined);
    await pool.query(`DELETE FROM siton.audit_log WHERE deal_id=$1`, [dealId]).catch(() => undefined);
    await pool.query(`DELETE FROM siton.deals WHERE deal_id=$1`, [dealId]).catch(() => undefined);
  }
}

await run("seller can duplicate own completed deal as Draft", async () => {
  const sellerId = await seedSeller("own");
  const sourceDealId = await seedDeal(sellerId, "Completed");
  let newDealId = "";
  try {
    const res = await duplicateDeal(sourceDealId, sellerId);
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();
    assert.equal(body.source_deal_id, sourceDealId);
    assert.equal(body.state, "Draft");
    newDealId = body.new_deal_id;
    const row = await pool.query(`SELECT seller_id, state, published_at, completion_window_until FROM siton.deals WHERE deal_id=$1`, [newDealId]);
    assert.equal(row.rows[0].seller_id, sellerId);
    assert.equal(row.rows[0].state, "Draft");
    assert.equal(row.rows[0].published_at, null);
    assert.equal(row.rows[0].completion_window_until, null);
  } finally {
    await cleanupDeals([sourceDealId, newDealId].filter(Boolean));
  }
});

await run("wrong seller receives ownership-hidden not-found and creates no side effects", async () => {
  const ownerSellerId = await seedSeller("owner");
  const otherSellerId = await seedSeller("other");
  const sourceDealId = await seedDeal(ownerSellerId, "Completed");
  const before = {
    deals: Number((await pool.query(`SELECT COUNT(*)::int AS count FROM siton.deals`)).rows[0].count),
    options: Number((await pool.query(`SELECT COUNT(*)::int AS count FROM siton.deal_delivery_options`)).rows[0].count),
    images: Number((await pool.query(`SELECT COUNT(*)::int AS count FROM siton.deal_images`)).rows[0].count),
    notifications: Number((await pool.query(`SELECT COUNT(*)::int AS count FROM siton.notification_events`)).rows[0].count),
    legal: Number((await pool.query(`SELECT COUNT(*)::int AS count FROM siton.legal_acceptances`)).rows[0].count),
    outbox: Number((await pool.query(`SELECT COUNT(*)::int AS count FROM siton.outbox_events`)).rows[0].count)
  };
  try {
    const res = await duplicateDeal(sourceDealId, otherSellerId);
    assert.equal(res.statusCode, 404, res.body);
    assert.equal((res.json() as any).code, "deal_not_found");
    const after = {
      deals: Number((await pool.query(`SELECT COUNT(*)::int AS count FROM siton.deals`)).rows[0].count),
      options: Number((await pool.query(`SELECT COUNT(*)::int AS count FROM siton.deal_delivery_options`)).rows[0].count),
      images: Number((await pool.query(`SELECT COUNT(*)::int AS count FROM siton.deal_images`)).rows[0].count),
      notifications: Number((await pool.query(`SELECT COUNT(*)::int AS count FROM siton.notification_events`)).rows[0].count),
      legal: Number((await pool.query(`SELECT COUNT(*)::int AS count FROM siton.legal_acceptances`)).rows[0].count),
      outbox: Number((await pool.query(`SELECT COUNT(*)::int AS count FROM siton.outbox_events`)).rows[0].count)
    };
    assert.deepEqual(after, before);
  } finally {
    await cleanupDeals([sourceDealId]);
  }
});

await run("duplicate copies delivery options and image metadata but not participants or side effects", async () => {
  const sellerId = await seedSeller("copy");
  const sourceDealId = await seedDeal(sellerId, "Completed");
  await seedParticipantAndSideEffects(sourceDealId, sellerId);
  let newDealId = "";
  try {
    const res = await duplicateDeal(sourceDealId, sellerId);
    assert.equal(res.statusCode, 200, res.body);
    newDealId = res.json().new_deal_id;
    assert.equal(await countByDeal("participants", newDealId), 0);
    assert.equal(await countByDeal("payment_attempts", newDealId), 0);
    assert.equal(await countByDeal("notification_events", newDealId), 0);
    assert.equal(await countByDeal("legal_acceptances", newDealId), 0);
    assert.equal(await countByDeal("deal_delivery_options", newDealId), 2);
    assert.equal(await countByDeal("deal_images", newDealId), 1);

    const publicDeal = await app.inject({ method: "GET", url: `/api/deals/${newDealId}/public` });
    assert.equal(publicDeal.statusCode, 404, "duplicated Draft must remain hidden from the public API");
    const ownerDraft = await app.inject({
      method: "GET",
      url: `/api/seller/deals/${newDealId}/draft`,
      headers: { "x-seller-id": sellerId }
    });
    assert.equal(ownerDraft.statusCode, 200, ownerDraft.body);
    const ownerBody = ownerDraft.json() as any;
    assert.equal(ownerBody.draft.images.length, 1);
    assert.ok(ownerBody.draft.images[0].url);
    assert.ok(!JSON.stringify(ownerBody).includes("storage_key"));
  } finally {
    await cleanupDeals([sourceDealId, newDealId].filter(Boolean));
  }
});

await run("duplicated draft still requires seller legal acceptance before publish", async () => {
  const sellerId = await seedSeller("legal");
  const sourceDealId = await seedDeal(sellerId, "Completed");
  let newDealId = "";
  try {
    const res = await duplicateDeal(sourceDealId, sellerId);
    assert.equal(res.statusCode, 200, res.body);
    newDealId = res.json().new_deal_id;
    const publish = await app.inject({
      method: "POST",
      url: `/deals/${newDealId}/publish`,
      headers: { "x-seller-id": sellerId }
    });
    assert.equal(publish.statusCode, 400, publish.body);
    assert.equal(publish.json().code, "seller_terms_required");
  } finally {
    await cleanupDeals([sourceDealId, newDealId].filter(Boolean));
  }
});

await run("failed and cancelled deals can also duplicate only as Draft", async () => {
  const sellerId = await seedSeller("closed");
  const failedSource = await seedDeal(sellerId, "Failed");
  const cancelledSource = await seedDeal(sellerId, "Cancelled");
  const newDealIds: string[] = [];
  try {
    for (const source of [failedSource, cancelledSource]) {
      const res = await duplicateDeal(source, sellerId);
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(res.json().state, "Draft");
      newDealIds.push(res.json().new_deal_id);
    }
  } finally {
    await cleanupDeals([failedSource, cancelledSource, ...newDealIds].filter(Boolean));
  }
});

await run("frontend exposes the seller duplicate CTA and endpoint wiring", async () => {
  const appJs = await readFile("frontend/app.js", "utf8");
  assert.match(appJs, /צור עסקה דומה/);
  assert.match(appJs, /\/api\/seller\/deals\/.*\/duplicate/);
  assert.match(appJs, /\["Completed", "Failed", "Cancelled"\]\.includes\(item\.state\)/);
});

await app.close().catch(() => undefined);
await pool.end().catch(() => undefined);
