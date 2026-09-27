// Black-Sky A-F9 — refunds are system-mandated ONLY as a consequence of a
// deal-level failure (docs/REFUND_POLICY.md). Before the fix the refund worker
// refunded every ChargedSuccess / RecoveredCharge participant of whatever deal a
// refund_issue job named — a Completed deal included. The job is now refused
// with an operational case unless the deal is Failed (or Cancelled for
// cancel_refund); no provider call, no state change.
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import pg from "pg";

process.env.PORT = "3194";
process.env.APP_DEPLOYMENT_MODE = "internal-runtime";
process.env.SELLER_SESSION_SECRET = "seller-session-secret-af9";
process.env.SELLER_AUTH_CREDENTIALS = JSON.stringify([{ seller_id: "seller-alpha", display_name: "Seller Alpha", access_code: "alpha-code" }]);
process.env.PAYMENT_PROVIDER = "payrail-http";
process.env.PAYMENT_PROVIDER_MODE = "provider-ready";
process.env.PAYMENT_PROVIDER_API_KEY = "live-provider-key";
process.env.PAYMENT_PROVIDER_AUTH_PATH = "/authorize";
process.env.PAYMENT_PROVIDER_CAPTURE_PATH = "/capture";
process.env.PAYMENT_PROVIDER_RECOVERY_PATH = "/recover";
process.env.PAYMENT_PROVIDER_REFUND_PATH = "/refund";
process.env.PAYMENT_PROVIDER_TIMEOUT_MS = "500";
process.env.OUTBOX_POLL_MS = "60000";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.PAYMENT_WEBHOOK_PROVIDER = "payrail-http";
process.env.PAYMENT_WEBHOOK_SECRET = "af9-webhook-secret";

const calls: Array<{ url: string; body: any }> = [];
const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
  req.on("end", () => {
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    calls.push({ url: String(req.url || ""), body });
    res.setHeader("content-type", "application/json");
    if (req.url === "/refund") {
      const anchor = String(body.capture_reference || body.authorization_id || "");
      res.end(JSON.stringify({ status: "refunded", refund_id: `ref-${anchor}`, provider_reference: `ref-${anchor}`, reference: body.reference }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not_found" }));
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
const address = server.address();
if (!address || typeof address === "string") throw new Error("stub has no port");
process.env.PAYMENT_PROVIDER_BASE_URL = `http://127.0.0.1:${address.port}`;

const { processOutboxEventById } = await import(`../src/app.js?af9-${Date.now()}`);
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

let failed = 0;
async function runTest(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}: ${(error as any)?.message || error}`);
  }
}

async function seed(dealState: string, buyerState: string) {
  const dealId = randomUUID();
  const participantId = randomUUID();
  const captureReference = `cap-af9-${participantId.slice(0, 8)}`;
  await pool.query(
    `INSERT INTO siton.deals (deal_id, title, price_per_unit, min_units, max_units, threshold_units, deadline, state, published_at, created_at, seller_id, completion_window_until)
     VALUES ($1,'A-F9',42,10,20,9, now() - interval '1 hour', $2, now(), now(), 'seller-alpha', now() - interval '1 minute')`,
    [dealId, dealState]
  );
  await pool.query(
    `INSERT INTO siton.participants (participant_id, deal_id, buyer_id, qty, buyer_state, money_state, delivery_cost, created_at)
     VALUES ($1,$2,$3,10,$4,'ChargedSuccess',0, now())`,
    [participantId, dealId, `buyer-af9-${participantId.slice(0, 6)}`, buyerState]
  );
  await pool.query(
    `INSERT INTO siton.audit_log (entity_type, entity_id, deal_id, state_type, from_state, to_state, action_name, request_id, idempotency_key, payload)
     VALUES ('participant',$1,$2,'money_state','ChargeAttempt','ChargedSuccess','charging.capture_success',$3,$3,$4)`,
    [participantId, dealId, `seed:${participantId}:cap`, JSON.stringify({ provider_reference: captureReference })]
  );
  const eventId = randomUUID();
  await pool.query(
    `INSERT INTO siton.outbox_events (event_uuid, event_type, aggregate_type, aggregate_id, payload, status, attempt_count, available_at, created_at, updated_at)
     VALUES ($1,'refund_issue','deal',$2,$3,'pending',0, now(), now(), now())`,
    [eventId, dealId, JSON.stringify({ deal_id: dealId })]
  );
  return { dealId, participantId, captureReference, eventId };
}

async function refundCalls(captureReference: string) {
  return calls.filter((call) => call.url === "/refund" && String(call.body?.capture_reference || call.body?.authorization_id || "") === captureReference).length;
}

for (const [dealState, buyerState] of [["Completed", "DealCompleted"], ["CompletionWindow", "ChargedSuccess"]] as const) {
  await runTest(`a refund job for a ${dealState} deal moves no money and opens a case`, async () => {
    const seeded = await seed(dealState, buyerState);
    const processed = await processOutboxEventById(seeded.eventId);
    assert.equal(processed?.status, "sent", "the refused job is acknowledged (no retry loop)");
    assert.equal(await refundCalls(seeded.captureReference), 0, `no provider refund for a ${dealState} deal`);
    const p = await pool.query(`SELECT money_state FROM siton.participants WHERE participant_id=$1`, [seeded.participantId]);
    assert.equal(p.rows[0].money_state, "ChargedSuccess");
    const attempts = await pool.query(`SELECT count(*)::int AS n FROM siton.payment_attempts WHERE participant_id=$1 AND attempt_type IN ('refund','cancel_refund')`, [seeded.participantId]);
    assert.equal(attempts.rows[0].n, 0, "no refund identity is minted");
    const cases = await pool.query(`SELECT count(*)::int AS n FROM siton.operational_cases WHERE auto_key=$1`, [`refund-refused-deal-not-failed:${seeded.dealId}:refund_issue`]);
    assert.equal(cases.rows[0].n, 1);
  });
}

await runTest("negative: a refund job for a Failed deal still refunds the charged participant", async () => {
  const seeded = await seed("Failed", "DealFailed");
  const processed = await processOutboxEventById(seeded.eventId);
  assert.equal(processed?.status, "sent");
  assert.equal(await refundCalls(seeded.captureReference), 1);
  const p = await pool.query(`SELECT money_state FROM siton.participants WHERE participant_id=$1`, [seeded.participantId]);
  assert.equal(p.rows[0].money_state, "Refunded");
});

await pool.end();
await new Promise<void>((resolve) => server.close(() => resolve()));
await new Promise((resolve) => setTimeout(resolve, 300));
process.exit(failed ? 1 : 0);
