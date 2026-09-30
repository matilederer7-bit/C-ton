// Black-Sky BSC-3: a success acknowledgement must never escape before the
// transaction that it acknowledges has COMMITTED.
//
// Found by CI (receipt_content_integration: GET right after a 201 chat POST
// returned no message). Three handlers called reply.send() INSIDE withTx:
//   - POST /api/deals/:id/chat           (201 before the insert committed)
//   - POST /webhooks/invoices            (200 "queued" before the event row,
//     its status and the reconcile job committed: a failed COMMIT still told
//     the provider "delivered", so it never retried — reconciliation lost)
//   - POST /api/admin/actions/:id/execute (verdict before the commit)
// Contention is reached by construction with the db.before_commit fault, never
// by sleeps: a "block" parks the transaction open and the suite asserts no
// HTTP answer exists yet; a "throw" fails the COMMIT and the suite asserts the
// caller gets an error (so a provider retries) and nothing was persisted.
import assert from "node:assert/strict";
import Fastify from "fastify";
import pg from "pg";

process.env.NODE_ENV = "test";
process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.DISABLE_OUTBOX_WORKER = "1";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton", max: 2 });
const { app, withTx } = await import("../src/app.js");
const { registerFrontendExperience } = await import("../src/frontend_runtime.js");
const { armTestFault, resetTestFaults } = await import("../src/fault_injection.js");

function delay<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms).unref());
}
function timeout<T>(ms: number, message: string): Promise<T> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms).unref());
}

async function createPublishedDeal() {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const created = await app.inject({
    method: "POST",
    url: "/deals",
    headers: { "x-request-id": `ack-commit-create-${suffix}`, "idempotency-key": `ack-commit-create-${suffix}` },
    payload: {
      title: "Ack after commit",
      description: "Chat acknowledgement commit-ordering proof.",
      price_per_unit: 40,
      min_units: 2,
      max_units: 10,
      deadline: new Date(Date.now() + 6 * 60 * 60_000).toISOString(),
      delivery_options: [{ option_type: "delivery", label: "משלוח עד הבית", cost: 12, sort_order: 0 }]
    }
  });
  assert.equal(created.statusCode, 200, created.body);
  const dealId = (created.json() as any).deal_id as string;
  const published = await app.inject({
    method: "POST",
    url: `/deals/${dealId}/publish`,
    headers: { "x-request-id": `ack-commit-publish-${suffix}`, "idempotency-key": `ack-commit-publish-${suffix}` },
    payload: { seller_terms_accepted: true, seller_critical_terms_accepted: true, seller_threshold_90_accepted: true }
  });
  assert.equal(published.statusCode, 200, published.body);
  return dealId;
}

function postChat(dealId: string, title: string) {
  return app.inject({ method: "POST", url: `/api/deals/${dealId}/chat`, payload: { title, body: `גוף ${title}`, display_name: "בודק" } });
}
async function chatTitles(dealId: string) {
  const res = await app.inject({ method: "GET", url: `/api/deals/${dealId}/chat` });
  assert.equal(res.statusCode, 200, res.body);
  return ((res.json() as any).messages as any[]).map((m) => m.title);
}

// Asserts that `pending` produces no HTTP answer while the transaction is
// parked at db.before_commit, then releases it and returns the answer.
async function assertWithheldUntilCommit(barrier: NonNullable<ReturnType<typeof armTestFault>>, pending: Promise<any>, label: string) {
  let released = false;
  const release = () => { if (!released) { released = true; barrier.release(); } };
  try {
    await Promise.race([
      barrier.entered,
      pending.then((r) => { throw new Error(`${label} answered ${r.statusCode} ${r.body} before reaching the commit point`); }),
      timeout(20_000, `${label} never reached the commit point`)
    ]);
    const early = await Promise.race([pending.then((r) => ({ responded: true as const, r })), delay(750, { responded: false as const })]);
    assert.equal(early.responded, false, `${label} answered before its transaction committed`);
    release();
    return await pending;
  } finally {
    release();
  }
}

async function main() {
  // ---- chat: acknowledgement withheld until COMMIT; failed COMMIT is not acked
  const dealId = await createPublishedDeal();
  const warm = await postChat(dealId, "חימום");
  assert.equal(warm.statusCode, 201, warm.body);

  const chatBarrier = armTestFault("db.before_commit", { kind: "block" });
  assert.ok(chatBarrier);
  const held = await assertWithheldUntilCommit(chatBarrier!, postChat(dealId, "מוחזק"), "chat POST");
  assert.equal(held.statusCode, 201, held.body);
  assert.deepEqual(await chatTitles(dealId), ["חימום", "מוחזק"], "the acknowledged message is visible to the very next read");
  console.log("PASS chat 201 is withheld until the insert commits and is visible to the next read");

  armTestFault("db.before_commit", { kind: "throw", code: "ack_commit_failure" });
  const failed = await postChat(dealId, "נכשל");
  assert.ok(failed.statusCode >= 500, `a failed COMMIT must not be acknowledged; got ${failed.statusCode} ${failed.body}`);
  resetTestFaults();
  assert.deepEqual(await chatTitles(dealId), ["חימום", "מוחזק"], "a rolled-back message never appears");
  console.log("PASS chat never acknowledges a rolled-back message");

  // ---- invoice webhook: a failed COMMIT answers an error, so the provider retries
  const provider = "ackcommit";
  const eventId = `evt_ack_commit_${Date.now().toString(36)}`;
  const invoiceProvider: any = {
    providerCode: provider,
    verifyWebhook: () => true,
    parseInvoiceWebhookEvent: (payload: Record<string, unknown>) => ({
      provider,
      event_id: String(payload.event_id),
      provider_document_id: `doc-${String(payload.event_id)}`,
      document_id: null,
      document_key: null,
      correlation_id: null,
      payload
    })
  };
  const hook = Fastify({ logger: false });
  registerFrontendExperience(hook, {
    withTx,
    paymentProvider: { providerCode: "mockpay", mode: "mock-backed", webhookProvider: "mockpay", configured: true } as any,
    invoiceProvider,
    invoiceSummary: { provider: provider, mode: "test" } as any,
    deploymentMode: "demo-preview",
    isDemoPreview: true,
    notificationSummary: { provider: "log-only", mode: "log-only", external_delivery: false }
  } as any);
  const deliver = (id: string) => hook.inject({ method: "POST", url: "/webhooks/invoices", payload: { event_id: id } });
  const eventRows = async (id: string) =>
    (await pool.query(`SELECT status FROM siton.invoice_webhook_events WHERE provider=$1 AND event_id=$2`, [provider, id])).rows;
  try {
    const warmHook = await deliver(`${eventId}_warm`);
    assert.equal(warmHook.statusCode, 202, warmHook.body);

    const hookBarrier = armTestFault("db.before_commit", { kind: "block" });
    assert.ok(hookBarrier);
    const heldHook = await assertWithheldUntilCommit(hookBarrier!, deliver(`${eventId}_held`), "invoice webhook");
    assert.equal(heldHook.statusCode, 202, heldHook.body);
    assert.equal((await eventRows(`${eventId}_held`))[0]?.status, "ignored", "the acknowledged event is committed");
    console.log("PASS invoice webhook ack is withheld until the event row commits");

    armTestFault("db.before_commit", { kind: "throw", code: "ack_commit_failure" });
    const failedHook = await deliver(eventId);
    assert.ok(failedHook.statusCode >= 500, `a failed COMMIT must answer an error so the provider retries; got ${failedHook.statusCode} ${failedHook.body}`);
    resetTestFaults();
    assert.equal((await eventRows(eventId)).length, 0, "nothing persisted for the failed delivery");

    const retried = await deliver(eventId);
    assert.equal(retried.statusCode, 202, retried.body);
    assert.equal((await retried.json() as any).duplicate, undefined, "the retry is processed, not swallowed as a duplicate");
    assert.equal((await eventRows(eventId))[0]?.status, "ignored");
    console.log("PASS invoice webhook answers an error on a failed COMMIT and the provider retry is processed");
  } finally {
    resetTestFaults();
    await hook.close();
    await pool.query(`DELETE FROM siton.invoice_webhook_events WHERE provider=$1`, [provider]).catch(() => undefined);
  }
  console.log("BLACK_SKY_ACK_AFTER_COMMIT_PASS");
}

try {
  await main();
} finally {
  resetTestFaults();
  await app.close();
  await pool.end();
}
