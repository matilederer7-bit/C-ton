import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import "dotenv/config";

process.env.ADMIN_API_KEY = "admin-support-cases-key";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.PORT = "3497";

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton"
});

const { app } = await import("../src/app.js");
const { establishNamedAdminSession } = await import("./helpers/named_admin_session.js");
// R5C — admin mutations now require a named admin identity, not the shared key.
const { cookie: ADMIN_COOKIE } = await establishNamedAdminSession(app, pool);

async function run(name: string, fn: () => Promise<void> | void) {
  await fn();
  console.log(`PASS ${name}`);
}

function adminHeaders(extra: Record<string, string> = {}) {
  return {
    "x-admin-key": "admin-support-cases-key",
    "x-admin-user": "admin-support-test",
    cookie: ADMIN_COOKIE,
    ...extra
  };
}

async function eventCount(caseId: string, eventType?: string) {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS count
     FROM siton.operational_case_events
     WHERE case_id=$1
       AND ($2::text IS NULL OR event_type=$2)`,
    [caseId, eventType || null]
  );
  return Number(result.rows[0].count || 0);
}

async function createManualCase(payload: Record<string, unknown> = {}) {
  return app.inject({
    method: "POST",
    url: "/api/admin/support-cases",
    headers: adminHeaders({
      "x-request-id": `case-create:${Date.now()}`,
      "idempotency-key": `case-create:${randomUUID()}`
    }),
    payload: {
      case_type: "BuyerComplaint",
      priority: "Normal",
      subject: `Support case ${Date.now()}`,
      description: "Detailed enough operational description for a manual case.",
      ...payload
    }
  });
}

async function seedCompletedDealWithoutCharges() {
  const dealId = randomUUID();
  await pool.query(
    `INSERT INTO siton.deals
       (deal_id, title, price_per_unit, min_units, max_units, threshold_units, deadline, state, seller_id, published_at)
     VALUES ($1,$2,10,1,5,1,$3,'Completed','seller-support-case-test',now())`,
    [dealId, `Auto case completed mismatch ${Date.now()}`, new Date(Date.now() + 4 * 60 * 60_000).toISOString()]
  );
  return dealId;
}

async function seedParticipantForRefundCase() {
  const dealId = randomUUID();
  const participantId = randomUUID();
  await pool.query(
    `INSERT INTO siton.deals
       (deal_id, title, price_per_unit, min_units, max_units, threshold_units, deadline, state, seller_id, published_at)
     VALUES ($1,$2,10,1,5,1,$3,'PendingTarget','seller-refund-case-test',now())`,
    [dealId, `Refund case deal ${Date.now()}`, new Date(Date.now() + 4 * 60 * 60_000).toISOString()]
  );
  await pool.query(
    `INSERT INTO siton.participants
       (participant_id, deal_id, buyer_id, qty, buyer_state, money_state)
     VALUES ($1,$2,'buyer-refund-case',1,'JoinedAuthorized','AuthHeld')`,
    [participantId, dealId]
  );
  return { dealId, participantId };
}

try {
  await run("manual case creation succeeds with valid case_type and writes audit event", async () => {
    const res = await createManualCase({ case_type: "RefundRequest", deal_id: randomUUID() });
    assert.equal(res.statusCode, 201, res.body);
    const body = res.json() as any;
    assert.equal(body.case.case_type, "RefundRequest");
    assert.equal(await eventCount(body.case.case_id, "case.create"), 1);
    assert.equal(await eventCount(body.case.case_id, "case.refund_request_marked"), 1);
  });

  await run("unknown case_type fails", async () => {
    const res = await createManualCase({ case_type: "NotAType" });
    assert.equal(res.statusCode, 400, res.body);
    assert.equal((res.json() as any).error, "invalid_case_type");
  });

  await run("unknown priority fails", async () => {
    const res = await createManualCase({ priority: "Emergency" });
    assert.equal(res.statusCode, 400, res.body);
    assert.equal((res.json() as any).error, "invalid_case_priority");
  });

  await run("unknown status fails", async () => {
    const created = await createManualCase();
    const caseId = (created.json() as any).case.case_id;
    const res = await app.inject({
      method: "PATCH",
      url: `/api/admin/support-cases/${caseId}`,
      headers: adminHeaders(),
      payload: { status: "Done" }
    });
    assert.equal(res.statusCode, 400, res.body);
    assert.equal((res.json() as any).error, "invalid_case_status");
  });

  await run("closing without resolution_note fails and closing with note succeeds", async () => {
    const created = await createManualCase();
    const caseId = (created.json() as any).case.case_id;
    const missing = await app.inject({
      method: "PATCH",
      url: `/api/admin/support-cases/${caseId}`,
      headers: adminHeaders(),
      payload: { status: "Closed" }
    });
    assert.equal(missing.statusCode, 400, missing.body);
    assert.equal((missing.json() as any).error, "resolution_note_required_to_close");

    const closed = await app.inject({
      method: "PATCH",
      url: `/api/admin/support-cases/${caseId}`,
      headers: adminHeaders(),
      payload: { status: "Closed", resolution_note: "Handled by operations and documented." }
    });
    assert.equal(closed.statusCode, 200, closed.body);
    assert.equal((closed.json() as any).case.status, "Closed");
    assert.equal(await eventCount(caseId, "case.close"), 1);
  });

  await run("escalate raises priority to Urgent and writes audit event", async () => {
    const created = await createManualCase({ priority: "High" });
    const caseId = (created.json() as any).case.case_id;
    const res = await app.inject({
      method: "POST",
      url: `/api/admin/support-cases/${caseId}/escalate`,
      headers: adminHeaders(),
      payload: { reason: "test escalation" }
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal((res.json() as any).case.priority, "Urgent");
    assert.equal(await eventCount(caseId, "case.escalate"), 1);
  });

  await run("RefundRequest does not execute refund or mutate money state", async () => {
    const seeded = await seedParticipantForRefundCase();
    const before = await pool.query(`SELECT money_state FROM siton.participants WHERE participant_id=$1`, [seeded.participantId]);
    const outboxBefore = await pool.query(`SELECT COUNT(*)::int AS count FROM siton.outbox_events WHERE event_type ILIKE '%refund%'`);
    const created = await createManualCase({
      case_type: "RefundRequest",
      deal_id: seeded.dealId,
      participant_id: seeded.participantId,
      subject: "Refund review only"
    });
    assert.equal(created.statusCode, 201, created.body);
    const after = await pool.query(`SELECT money_state FROM siton.participants WHERE participant_id=$1`, [seeded.participantId]);
    const outboxAfter = await pool.query(`SELECT COUNT(*)::int AS count FROM siton.outbox_events WHERE event_type ILIKE '%refund%'`);
    assert.equal(after.rows[0].money_state, before.rows[0].money_state);
    assert.equal(Number(outboxAfter.rows[0].count), Number(outboxBefore.rows[0].count));
  });

  await run("Support Hub does not mutate DealState, BuyerState, or MoneyState", async () => {
    const seeded = await seedParticipantForRefundCase();
    const before = await pool.query(
      `SELECT d.state, p.buyer_state, p.money_state
       FROM siton.deals d
       JOIN siton.participants p ON p.deal_id=d.deal_id
       WHERE p.participant_id=$1`,
      [seeded.participantId]
    );
    await createManualCase({
      case_type: "DeliveryIssue",
      deal_id: seeded.dealId,
      participant_id: seeded.participantId,
      subject: "Delivery issue case only"
    });
    const after = await pool.query(
      `SELECT d.state, p.buyer_state, p.money_state
       FROM siton.deals d
       JOIN siton.participants p ON p.deal_id=d.deal_id
       WHERE p.participant_id=$1`,
      [seeded.participantId]
    );
    assert.deepEqual(after.rows[0], before.rows[0]);
  });

  await run("auto-case is idempotent for the same open exception", async () => {
    const dealId = await seedCompletedDealWithoutCharges();
    for (let i = 0; i < 2; i += 1) {
      const res = await app.inject({
        method: "GET",
        url: "/api/admin/support-cases",
        headers: adminHeaders()
      });
      assert.equal(res.statusCode, 200, res.body);
    }
    const count = await pool.query(
      `SELECT COUNT(*)::int AS count
       FROM siton.operational_cases
       WHERE auto_key=$1
         AND status IN ('Open','NeedsSeller','NeedsAdmin','WaitingExternal')`,
      [`completed_without_charged_success:${dealId}`]
    );
    assert.equal(Number(count.rows[0].count), 1);
  });

  await run("guardrails: no duplicate catalog/search API, affiliate payout, or request-thread money action", async () => {
    const [frontendRuntime, appTs, appJs] = await Promise.all([
      readFile("src/frontend_runtime.ts", "utf8"),
      readFile("src/app.ts", "utf8"),
      readFile("frontend/app.js", "utf8")
    ]);
    assert.doesNotMatch(frontendRuntime, /app\.get\(["']\/api\/marketplace/i);
    assert.doesNotMatch(frontendRuntime, /app\.get\(["']\/api\/catalog/i);
    assert.match(frontendRuntime, /app\.get\(["']\/api\/mall\/deals/i);
    assert.doesNotMatch(frontendRuntime, /affiliate.*commission/i);
    assert.doesNotMatch(frontendRuntime, /affiliate-payout/i);
    assert.doesNotMatch(appJs, /manual_refund_enabled:\s*true|manual_capture_enabled:\s*true|manual_void_enabled:\s*true|manual_payout_enabled:\s*true/i);
    assert.doesNotMatch(appTs, /UNIQUE\s*\(\s*deal_id\s*,\s*buyer_id\s*\)/i);
  });
} finally {
  await app.close().catch(() => undefined);
  await pool.end();
}
