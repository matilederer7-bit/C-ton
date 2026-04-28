import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

process.env.ADMIN_API_KEY = "mission-control-admin-key";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.PORT = "3483";

const { app } = await import("../src/app.js");
const { pool } = await import("../src/db.js");
const ADMIN_HEADERS = { "x-admin-key": "mission-control-admin-key" };

async function run(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

const dealId = randomUUID();

try {
  await pool.query(
    `INSERT INTO siton.deals (deal_id, seller_id, title, state, price_per_unit, min_units, max_units, threshold_units, deadline)
     VALUES ($1,'seller-admin-profile','Admin Deal Profile','Draft',20,2,10,2,now()+interval '1 day')`,
    [dealId]
  );

  await run("admin deal profile returns quantities, money-adjacent summaries and operational status", async () => {
    const profile = await app.inject({ method: "GET", url: `/api/admin/deals/${dealId}/profile`, headers: ADMIN_HEADERS });
    assert.equal(profile.statusCode, 200, profile.body);
    const body = profile.json() as any;
    assert.equal(body.profile.deal.deal_id, dealId);
    assert.ok(Array.isArray(body.profile.audit));
    assert.ok(Array.isArray(body.profile.payment_attempts));
    assert.ok(Array.isArray(body.profile.payout_batches));

    const ops = await app.inject({ method: "GET", url: `/api/admin/deals/${dealId}/ops-summary`, headers: ADMIN_HEADERS });
    assert.equal(ops.statusCode, 200, ops.body);
    const opsBody = ops.json() as any;
    assert.equal(opsBody.deal.deal_id, dealId);
    assert.ok(opsBody.participants);
    assert.ok(opsBody.invoice_documents);
    assert.ok(opsBody.outbox);
  });
} finally {
  await pool.query(`DELETE FROM siton.deals WHERE deal_id=$1`, [dealId]).catch(() => undefined);
  await app.close().catch(() => undefined);
}
