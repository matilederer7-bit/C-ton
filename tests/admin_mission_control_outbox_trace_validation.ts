// OVERNIGHT HARDENING — mission-control outbox traces must read the REAL
// outbox schema. The deal / correlation / outbox drill-downs selected a column
// named `event_id` that does not exist on siton.outbox_events (the key is
// `event_uuid`), and the savepoint-guarded safeQuery swallowed the error, so an
// operator looking at a deal trace saw an EMPTY outbox section while the deal
// had a live pending event. The admin UI was presenting a silent failure as
// "nothing here". This proof publishes a real deal (which enqueues its
// deadline_check outbox event) and asserts the three traces expose it.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
const { Pool } = pg;

process.env.ADMIN_API_KEY = "mission-control-outbox-trace-secret";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.APP_DEPLOYMENT_MODE = "demo-preview";

const { app } = await import("../src/app.js");
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton",
  max: 3
});

const ADMIN_HEADERS = { "x-admin-key": "mission-control-outbox-trace-secret" };
const sellerId = `seller-mc-outbox-${randomUUID().slice(0, 8)}`;
const SELLER = { "x-seller-id": sellerId, "content-type": "application/json" };

let failed = 0;
async function run(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error: any) {
    failed += 1;
    console.error(`FAIL ${name}: ${error?.message || error}`);
  }
}

let dealId = "";
let outboxRow: { event_uuid: string; event_type: string; correlation_id: string | null; request_id: string | null } | null = null;

try {
  await run("setup: a seller publishes a deal, which enqueues a real outbox event", async () => {
    const profile = await app.inject({
      method: "PUT",
      url: "/api/seller/business-profile",
      headers: SELLER,
      payload: { business_name: `עסק ${sellerId}`, business_id_number: "515000009", contact_name: "בודק", contact_phone: "0509876543", contact_email: `${sellerId}@siton.test` }
    });
    assert.equal(profile.statusCode, 200, profile.body);

    const created = await app.inject({
      method: "POST",
      url: "/deals",
      headers: { ...SELLER, "idempotency-key": `mc-outbox-${randomUUID()}` },
      payload: {
        title: "עסקה לבדיקת trace",
        description_short: "בדיקה",
        description: "בדיקת outbox trace",
        price_per_unit: 40,
        min_units: 3,
        max_units: 10,
        deadline: new Date(Date.now() + 2 * 864e5).toISOString(),
        deal_type: "physical_product",
        delivery_options: [{ option_type: "delivery", label: "משלוח", cost: 15, sort_order: 0 }]
      }
    });
    assert.equal(created.statusCode, 200, created.body);
    const createdBody = created.json() as any;
    dealId = String(createdBody.deal?.deal_id || createdBody.deal_id);

    const published = await app.inject({
      method: "POST",
      url: `/deals/${dealId}/publish`,
      headers: { ...SELLER, "idempotency-key": `mc-outbox-publish-${randomUUID()}`, "x-correlation-id": `mc-outbox-corr-${dealId}` },
      payload: { seller_terms_accepted: true, seller_critical_terms_accepted: true, seller_threshold_90_accepted: true }
    });
    assert.equal(published.statusCode, 200, published.body);

    const rows = await pool.query(
      `SELECT event_uuid, event_type, correlation_id, request_id
       FROM siton.outbox_events WHERE aggregate_type='deal' AND aggregate_id=$1
       ORDER BY created_at DESC`,
      [dealId]
    );
    assert.ok(rows.rowCount && rows.rowCount >= 1, "publish must enqueue at least one outbox event");
    outboxRow = rows.rows[0];
  });

  await run("deal trace exposes the deal's outbox events keyed by event_uuid", async () => {
    const res = await app.inject({ method: "GET", url: `/api/admin/mission-control/deals/${dealId}/trace`, headers: ADMIN_HEADERS });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as any;
    assert.ok(Array.isArray(body.outbox_related_events), "outbox_related_events must be an array");
    assert.ok(body.outbox_related_events.length >= 1, "deal trace must list the real outbox event (was silently empty)");
    const listed = body.outbox_related_events.find((row: any) => String(row.event_uuid) === outboxRow!.event_uuid);
    assert.ok(listed, "the enqueued event_uuid must be in the trace");
    assert.equal(String(listed.event_id), outboxRow!.event_uuid, "event_id is an alias of the canonical event_uuid");
    assert.equal(String(listed.event_type), outboxRow!.event_type);
    assert.ok(typeof listed.status === "string" && listed.status.length > 0);
  });

  await run("outbox drill-down resolves the event by its uuid", async () => {
    const res = await app.inject({ method: "GET", url: `/api/admin/mission-control/outbox/${outboxRow!.event_uuid}`, headers: ADMIN_HEADERS });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as any;
    assert.ok(body.event, "event must be resolved (was null for every real event)");
    assert.equal(String(body.event.event_uuid), outboxRow!.event_uuid);
    assert.equal(String(body.event.event_id), outboxRow!.event_uuid);
    assert.notEqual(body.status, "unknown");
    assert.deepEqual(body.related_entity, { type: "deal", id: dealId });
    assert.equal(body.dlq_status, "not_found");
  });

  await run("correlation trace finds the outbox event through its correlation / request id", async () => {
    const key = outboxRow!.correlation_id || outboxRow!.request_id;
    if (!key) {
      console.log("  (outbox row carries no correlation/request id; correlation lookup not applicable)");
      return;
    }
    const res = await app.inject({ method: "GET", url: `/api/admin/mission-control/correlation/${encodeURIComponent(key)}`, headers: ADMIN_HEADERS });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as any;
    const outbox = body.outbox ?? body.outbox_events ?? body.outbox_related_events;
    assert.ok(Array.isArray(outbox), `correlation trace must expose an outbox array (keys: ${Object.keys(body).join(",")})`);
    assert.ok(outbox.some((row: any) => String(row.event_uuid) === outboxRow!.event_uuid), "correlated outbox event must be listed");
  });

  await run("an unknown outbox uuid answers a clean not-found shape, never a 5xx", async () => {
    const res = await app.inject({ method: "GET", url: `/api/admin/mission-control/outbox/${randomUUID()}`, headers: ADMIN_HEADERS });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as any;
    assert.equal(body.event, null);
    assert.equal(body.status, "unknown");
  });
} finally {
  await app.close().catch(() => undefined);
  await pool.end().catch(() => undefined);
}

if (failed > 0) {
  console.error(`FAILED ${failed} mission-control outbox trace checks`);
  process.exit(1);
}
console.log("All mission-control outbox trace checks passed.");
