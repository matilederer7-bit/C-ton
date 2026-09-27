// Black-Sky A-F4 — `payment_method_id` is client-supplied. Before the fix the
// authorize route upserted it with ON CONFLICT ... SET buyer_id=EXCLUDED.buyer_id:
// any caller that presented another buyer's stored method reference took it
// over (ownership reassigned, recorded on the caller's binding, and picked up by
// the renewal path by buyer_id). A stored method now stays with the buyer that
// registered it; another buyer presenting it is refused with 409 before any
// provider I/O or durable write.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

process.env.PORT = "3192";
process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.SELLER_SESSION_SECRET = "seller-session-secret-af4";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.OUTBOX_POLL_MS = "60000";
process.env.PAYMENT_BINDING_ENFORCEMENT = "strict";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const { app } = await import(`../src/app.js?af4-${Date.now()}`);

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

async function seedDeal(prefix: string) {
  const seller = `${prefix}-seller`;
  await pool.query(
    `INSERT INTO siton.seller_accounts(seller_id, display_name, auth_enabled) VALUES ($1,$2,false) ON CONFLICT (seller_id) DO NOTHING`,
    [seller, `${prefix} seller`]
  );
  const deal = await pool.query(
    `INSERT INTO siton.deals(seller_id,title,price_per_unit,state,min_units,max_units,threshold_units,deadline,published_at)
     VALUES ($1,$2,10,'PendingTarget',2,50,10, now()+interval '1 day', now()) RETURNING deal_id`,
    [seller, `${prefix} deal`]
  );
  return String(deal.rows[0].deal_id);
}

function authorize(dealId: string, buyerId: string | null, paymentMethodId: string) {
  return app.inject({
    method: "POST",
    url: "/api/payments/authorize",
    payload: { payer_name: "Owner Test", payment_method_id: paymentMethodId, deal_id: dealId, ...(buyerId ? { buyer_id: buyerId } : {}), qty: 1 }
  });
}

async function owners(paymentMethodId: string) {
  const r = await pool.query(`SELECT buyer_id FROM siton.buyer_payment_methods WHERE provider_payment_method_id=$1`, [paymentMethodId]);
  return r.rows.map((row) => String(row.buyer_id));
}

async function bindingsWithMethod(buyerId: string, paymentMethodId: string) {
  const r = await pool.query(`SELECT count(*)::int AS n FROM siton.payment_authorization_bindings WHERE buyer_id=$1 AND payment_method_ref=$2`, [buyerId, paymentMethodId]);
  return Number(r.rows[0]?.n || 0);
}

const dealId = await seedDeal(`af4-${randomUUID().slice(0, 6)}`);
const victim = `buyer-victim-${randomUUID().slice(0, 8)}`;
const attacker = `buyer-attacker-${randomUUID().slice(0, 8)}`;
const victimMethod = `pm_victim_${randomUUID().slice(0, 12)}`;

await runTest("precondition: the victim registers a stored payment method", async () => {
  const response = await authorize(dealId, victim, victimMethod);
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(await owners(victimMethod), [victim]);
});

await runTest("another buyer presenting the victim's method is refused (409) and ownership is NOT reassigned", async () => {
  const response = await authorize(dealId, attacker, victimMethod);
  assert.equal(response.statusCode, 409, response.body);
  assert.equal((response.json() as any).code ?? (response.json() as any).error, "payment_method_not_owned");
  assert.deepEqual(await owners(victimMethod), [victim], "the stored method still belongs to the victim");
  assert.equal(await bindingsWithMethod(attacker, victimMethod), 0, "no authorization binding of the attacker references the victim's method");
});

await runTest("a caller with NO buyer identity cannot use a registered method either", async () => {
  const response = await authorize(dealId, null, victimMethod);
  assert.equal(response.statusCode, 409, response.body);
  assert.deepEqual(await owners(victimMethod), [victim]);
});

await runTest("negative: the owner re-using its own method still works", async () => {
  const response = await authorize(dealId, victim, victimMethod);
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(await owners(victimMethod), [victim]);
});

await runTest("negative: a fresh (unregistered) method is registered to the caller", async () => {
  const fresh = `pm_fresh_${randomUUID().slice(0, 12)}`;
  const response = await authorize(dealId, attacker, fresh);
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(await owners(fresh), [attacker]);
});

await pool.end();
await app.close().catch(() => undefined);
process.exit(failed ? 1 : 0);
