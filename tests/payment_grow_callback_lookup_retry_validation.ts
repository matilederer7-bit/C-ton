// F-M5 — a Grow callback whose authoritative status lookup FAILED used to be
// stored as 'processed': every redelivery was a duplicate no-op and nothing
// else ever re-read the binding, so a paid hosted authorization stayed
// 'pending_provider_confirmation' for ever (the buyer could never join). The
// callback outcome is now retryable ('failed', re-claimable by redelivery) and
// a bounded maintenance sweep re-reads pending bindings (status only, never a
// money call) through the same amount-checked confirmation path.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

process.env.PORT = "3195";
process.env.APP_DEPLOYMENT_MODE = "internal-runtime";
process.env.SELLER_SESSION_SECRET = "seller-session-secret-fm5";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.OUTBOX_POLL_MS = "60000";
process.env.PAYMENT_PROVIDER = "grow";
process.env.PAYMENT_PROVIDER_MODE = "grow";
process.env.PAYMENT_ENVIRONMENT = "sandbox";
process.env.PAYMENT_PROVIDER_BASE_URL = "https://sandbox.meshulam.co.il/api/light/server/1.0";
process.env.PAYMENT_PROVIDER_TIMEOUT_MS = "1000";
process.env.GROW_USER_ID = "grow-sandbox-user";
process.env.GROW_PAGE_CODE = "grow-sandbox-page";
process.env.GROW_REFERENCE_ENCRYPTION_KEY = "grow-sandbox-reference-encryption-key-48-characters!";
process.env.GROW_SUCCESS_URL = "https://siton-staging.example.invalid/pay/success";
process.env.GROW_CANCEL_URL = "https://siton-staging.example.invalid/pay/cancel";
process.env.GROW_NOTIFY_URL = "https://siton-staging.example.invalid/webhooks/payments/grow";

type FakeProcess = { processToken: string; sum: string; paid: boolean };
const fake = { processes: new Map<string, FakeProcess>(), seq: 0, lookupMode: "ok" as "ok" | "http_503", lookups: 0, moneyCalls: 0 };

(globalThis as Record<string, unknown>).__SITON_GROW_TEST_TRANSPORT__ = async (request: { url: string; body: URLSearchParams }) => {
  const fields = Object.fromEntries(request.body.entries());
  const ok = (data: unknown) => ({ status: 200, body: { status: 1, err: "", data } });
  if (request.url.endsWith("/createPaymentProcess")) {
    fake.seq += 1;
    const processId = `fm5-${fake.seq}-${randomUUID().slice(0, 6)}`;
    fake.processes.set(processId, { processToken: `ptoken-${processId}`, sum: String(fields.sum), paid: false });
    return ok({ processId, processToken: `ptoken-${processId}`, url: `https://sandbox.meshulam.co.il/hosted/${processId}` });
  }
  if (request.url.endsWith("/getPaymentProcessInfo")) {
    fake.lookups += 1;
    if (fake.lookupMode === "http_503") return { status: 503, body: { status: 0, err: "gateway busy" } };
    const proc = fake.processes.get(String(fields.processId));
    if (!proc) return { status: 200, body: { status: 0, err: { id: 400, message: "process not found" }, data: "" } };
    const tx = proc.paid ? [{ transactionId: `tx-${fields.processId}`, transactionToken: `txt-${fields.processId}`, statusCode: "11", status: "עסקה מושהית", sum: proc.sum }] : [];
    return ok({ processId: fields.processId, processToken: fields.processToken, transactions: tx });
  }
  fake.moneyCalls += 1;
  return { status: 404, body: { status: 0, err: "unexpected endpoint in this test" } };
};

const appModule: any = await import(`../src/app.js?fm5-${Date.now()}`);
const { app } = appModule;
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

async function pendingGrowBinding(prefix: string) {
  const seller = `${prefix}-seller`;
  await pool.query(`INSERT INTO siton.seller_accounts(seller_id, display_name, auth_enabled) VALUES ($1,$1,false) ON CONFLICT (seller_id) DO NOTHING`, [seller]);
  const deal = await pool.query(
    `INSERT INTO siton.deals(seller_id,title,price_per_unit,state,min_units,max_units,threshold_units,deadline,published_at)
     VALUES ($1,$2,10,'PendingTarget',2,50,10, now()+interval '1 day', now()) RETURNING deal_id`,
    [seller, `${prefix} deal`]
  );
  const dealId = String(deal.rows[0].deal_id);
  const response = await app.inject({
    method: "POST",
    url: "/api/payments/authorize",
    headers: { "idempotency-key": `fm5-${randomUUID()}` },
    payload: { payer_name: "Israel Israeli", payer_phone: "0501234567", deal_id: dealId, buyer_id: `${prefix}-buyer`, qty: 2 }
  });
  assert.equal(response.statusCode, 200, response.body);
  const authorization = response.json() as { authorization_id: string; correlation_id: string };
  const processId = [...fake.processes.keys()].at(-1)!;
  return { dealId, processId, authorizationId: authorization.authorization_id, correlationId: authorization.correlation_id };
}

async function bindingStatus(authorizationId: string) {
  const r = await pool.query(`SELECT status FROM siton.payment_authorization_bindings WHERE authorization_id=$1 ORDER BY created_at DESC LIMIT 1`, [authorizationId]);
  return String(r.rows[0]?.status || "");
}

function callback(b: { processId: string; correlationId: string }) {
  const proc = fake.processes.get(b.processId)!;
  return app.inject({
    method: "POST",
    url: "/webhooks/payments/grow",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams({ processId: b.processId, processToken: proc.processToken, statusCode: "11", sum: "20.00", cField1: b.correlationId }).toString()
  });
}

await runTest("a callback whose status lookup FAILED is retryable: the provider's redelivery confirms the binding", async () => {
  const b = await pendingGrowBinding(`fm5a-${randomUUID().slice(0, 6)}`);
  fake.processes.get(b.processId)!.paid = true; // the customer paid at Grow
  fake.lookupMode = "http_503";
  const first = await callback(b);
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(await bindingStatus(b.authorizationId), "pending_provider_confirmation");
  fake.lookupMode = "ok";
  const redelivery = await callback(b);
  assert.equal(redelivery.statusCode, 200, redelivery.body);
  assert.notEqual((redelivery.json() as any).duplicate, true, "the redelivery must not be swallowed as a duplicate of a failed lookup");
  assert.equal(await bindingStatus(b.authorizationId), "authorized");
});

await runTest("a pending binding whose callback lookup failed (and never redelivered) is confirmed by the bounded sweep — status only", async () => {
  const b = await pendingGrowBinding(`fm5b-${randomUUID().slice(0, 6)}`);
  fake.processes.get(b.processId)!.paid = true;
  fake.lookupMode = "http_503";
  await callback(b);
  fake.lookupMode = "ok";
  assert.equal(typeof appModule.reconcilePendingAuthorizationBindings, "function", "a sweep/reconcile path for pending bindings must exist");
  await pool.query(`UPDATE siton.payment_authorization_bindings SET created_at = created_at - interval '10 minutes' WHERE authorization_id=$1`, [b.authorizationId]);
  await pool.query(`ALTER TABLE siton.payment_authorization_bindings DISABLE TRIGGER trg_payment_bindings_updated_at`);
  await pool.query(`UPDATE siton.payment_authorization_bindings SET updated_at = now() - interval '10 minutes' WHERE authorization_id=$1`, [b.authorizationId]);
  await pool.query(`ALTER TABLE siton.payment_authorization_bindings ENABLE TRIGGER trg_payment_bindings_updated_at`);
  const moneyBefore = fake.moneyCalls;
  const swept = await appModule.reconcilePendingAuthorizationBindings(50, 60_000, 30_000);
  assert.ok(swept.confirmed >= 1, JSON.stringify(swept));
  assert.equal(await bindingStatus(b.authorizationId), "authorized");
  assert.equal(fake.moneyCalls, moneyBefore, "the sweep never makes a money call");
});

await runTest("negative: the sweep respects its backoff and leaves an unpaid binding pending", async () => {
  const b = await pendingGrowBinding(`fm5c-${randomUUID().slice(0, 6)}`);
  // not paid; fresh binding — not due yet
  const lookupsBefore = fake.lookups;
  await appModule.reconcilePendingAuthorizationBindings(50, 60_000, 30_000);
  assert.equal(fake.lookups, lookupsBefore, "a fresh binding is not re-read before its minimum age");
  await pool.query(`UPDATE siton.payment_authorization_bindings SET created_at = created_at - interval '10 minutes' WHERE authorization_id=$1`, [b.authorizationId]);
  await pool.query(`ALTER TABLE siton.payment_authorization_bindings DISABLE TRIGGER trg_payment_bindings_updated_at`);
  await pool.query(`UPDATE siton.payment_authorization_bindings SET updated_at = now() - interval '10 minutes' WHERE authorization_id=$1`, [b.authorizationId]);
  await pool.query(`ALTER TABLE siton.payment_authorization_bindings ENABLE TRIGGER trg_payment_bindings_updated_at`);
  await appModule.reconcilePendingAuthorizationBindings(50, 60_000, 30_000);
  assert.equal(await bindingStatus(b.authorizationId), "pending_provider_confirmation", "an unpaid process stays pending");
  const lookupsAfterFirst = fake.lookups;
  await appModule.reconcilePendingAuthorizationBindings(50, 60_000, 30_000);
  assert.equal(fake.lookups, lookupsAfterFirst, "the same binding is not re-read again within the backoff");
});

await runTest("negative: a callback with a successful lookup is still final (processed; a redelivery is a duplicate)", async () => {
  const b = await pendingGrowBinding(`fm5d-${randomUUID().slice(0, 6)}`);
  fake.processes.get(b.processId)!.paid = true;
  fake.lookupMode = "ok";
  const first = await callback(b);
  assert.equal((first.json() as any).status, "processed");
  assert.equal(await bindingStatus(b.authorizationId), "authorized");
  const again = await callback(b);
  assert.equal((again.json() as any).duplicate, true);
});

await pool.end();
process.exit(failed ? 1 : 0);
