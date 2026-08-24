import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

process.env.ADMIN_API_KEY = "mission-control-admin-key";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.PORT = "3482";

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
const title = `Admin Omnisearch ${Date.now()}`;

try {
  await pool.query(
    `INSERT INTO siton.deals (deal_id, seller_id, title, state, price_per_unit, min_units, max_units, threshold_units, deadline)
     VALUES ($1,'seller-admin-search',$2,'Draft',10,1,5,1,now()+interval '1 day')`,
    [dealId, title]
  );

  await run("admin omnisearch finds operational deal without public marketplace semantics", async () => {
    const res = await app.inject({ method: "GET", url: `/api/admin/mission-control?q=${encodeURIComponent(title)}`, headers: ADMIN_HEADERS });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as any;
    assert.equal(body.omnisearch.scope, "admin_only_operational_search");
    assert.equal(body.omnisearch.public_discovery_scope, "separate_mall_read_surface");
    assert.ok(body.omnisearch.results.some((row: any) => row.entity_id === dealId));
    assert.ok(!JSON.stringify(body).toLowerCase().includes("public_catalog"));
    assert.ok(!JSON.stringify(body).toLowerCase().includes("deal_search"));
  });
} finally {
  await pool.query(`DELETE FROM siton.deals WHERE deal_id=$1`, [dealId]).catch(() => undefined);
  await app.close().catch(() => undefined);
}
