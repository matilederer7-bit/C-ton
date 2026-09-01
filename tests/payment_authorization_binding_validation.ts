import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import "dotenv/config";

// R9A — server-authoritative payment authorization binding.
//
// Join may transition money to AuthHeld ONLY by consuming a server-side
// binding whose provider, environment, deal, buyer, quantity, authoritative
// amount, currency and status all match — exactly once. Browser data is a
// lookup handle, never financial authority.

process.env.PORT = "3095";
process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.SELLER_SESSION_SECRET = "seller-session-secret-binding";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.OUTBOX_POLL_MS = "60000";
// Strict enforcement even on the synthetic mock provider: this suite proves
// the real-provider Join contract.
process.env.PAYMENT_BINDING_ENFORCEMENT = "strict";

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton"
});

const { app } = await import(`../src/app.js?binding-${Date.now()}`);

let passed = 0;
let failed = 0;
async function runTest(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`PASS ${name}`);
    passed += 1;
  } catch (error) {
    console.error(`FAIL ${name}: ${(error as any)?.message || error}`);
    failed += 1;
  }
}

async function seedDeal(prefix: string, pricePerUnit = 10) {
  const seller = `${prefix}-seller`;
  await pool.query(
    `INSERT INTO siton.seller_accounts(seller_id, display_name, auth_enabled) VALUES ($1,$2,false)
     ON CONFLICT (seller_id) DO NOTHING`,
    [seller, `${prefix} seller`]
  );
  const deal = await pool.query(
    `INSERT INTO siton.deals(seller_id,title,price_per_unit,state,min_units,max_units,threshold_units,deadline,published_at)
     VALUES ($1,$2,$3,'PendingTarget',2,50,10, now()+interval '1 day', now()) RETURNING deal_id`,
    [seller, `${prefix} deal`, pricePerUnit]
  );
  return deal.rows[0].deal_id as string;
}

async function authorize(dealId: string, buyerId: string, qty: number, methodSuffix = "4242") {
  const response = await app.inject({
    method: "POST",
    url: "/api/payments/authorize",
    payload: {
      payer_name: "Binding Buyer",
      payment_method_id: `pm_binding_${methodSuffix}_${randomUUID().slice(0, 8)}`,
      deal_id: dealId,
      buyer_id: buyerId,
      qty
    }
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json() as { authorization_id: string; correlation_id: string; provider: string };
}

async function join(dealId: string, buyerId: string, qty: number, authorizationId: string | null, idem?: string) {
  return app.inject({
    method: "POST",
    url: `/deals/${dealId}/join`,
    headers: idem ? { "idempotency-key": idem } : {},
    payload: {
      buyer_id: buyerId,
      qty,
      payment_disclosure_accepted: true,
      ...(authorizationId ? { authorization_id: authorizationId, authorization_provider: "mockpay" } : {})
    }
  });
}

async function bindingRow(authorizationId: string, dealId: string) {
  const r = await pool.query(
    `SELECT * FROM siton.payment_authorization_bindings WHERE authorization_id=$1 AND deal_id=$2 ORDER BY created_at DESC LIMIT 1`,
    [authorizationId, dealId]
  );
  return r.rows[0] || null;
}

async function insertBinding(args: {
  dealId: string;
  buyerId: string;
  authorizationId: string;
  qty: number;
  amountMinor: number;
  status?: string;
  providerCode?: string;
  providerMode?: string;
  environment?: string;
  currency?: string;
  expiresAt?: string | null;
}) {
  await pool.query(
    `INSERT INTO siton.payment_authorization_bindings
       (provider_code, provider_mode, provider_environment, authorization_id, provider_reference,
        deal_id, buyer_id, qty, amount_minor, currency, delivery_cost, status, correlation_id)
     VALUES ($1,$2,$3,$4,$4,$5,$6,$7,$8,$9,0,$10,$11)`,
    [
      args.providerCode || "mockpay",
      args.providerMode || "mock-backed",
      args.environment || "demo",
      args.authorizationId,
      args.dealId,
      args.buyerId,
      args.qty,
      args.amountMinor,
      args.currency || "ILS",
      args.status || "authorized",
      `bindtest_${randomUUID().replace(/-/g, "")}`
    ]
  );
  if (args.expiresAt !== undefined) {
    await pool.query(
      `UPDATE siton.payment_authorization_bindings SET expires_at=$2 WHERE authorization_id=$1`,
      [args.authorizationId, args.expiresAt]
    );
  }
}

await runTest("authorize creates a durable authorized binding with the authoritative server amount", async () => {
  const dealId = await seedDeal("bind-auth", 25);
  const auth = await authorize(dealId, "0501110001", 2);
  const binding = await bindingRow(auth.authorization_id, dealId);
  assert.ok(binding, "binding row must exist");
  assert.equal(binding.status, "authorized");
  assert.equal(Number(binding.amount_minor), 2 * 25 * 100);
  assert.equal(Number(binding.qty), 2);
  assert.equal(binding.buyer_id, "0501110001");
  assert.equal(binding.provider_code, "mockpay");
});

await runTest("join consumes a matching binding exactly once and reaches AuthHeld", async () => {
  const dealId = await seedDeal("bind-happy", 25);
  const auth = await authorize(dealId, "0501110002", 2);
  const res = await join(dealId, "0501110002", 2, auth.authorization_id);
  assert.equal(res.statusCode, 200, res.body);
  const participantId = (res.json() as any).participant_id as string;
  const participant = await pool.query(
    `SELECT buyer_state, money_state FROM siton.participants WHERE participant_id=$1`,
    [participantId]
  );
  assert.equal(participant.rows[0].buyer_state, "JoinedAuthorized");
  assert.equal(participant.rows[0].money_state, "AuthHeld");
  const binding = await bindingRow(auth.authorization_id, dealId);
  assert.equal(binding.status, "consumed");
  assert.equal(binding.consumed_by_participant_id, participantId);

  const audit = await pool.query(
    `SELECT payload FROM siton.audit_log WHERE entity_id=$1 AND state_type='money_state' AND to_state='AuthHeld'`,
    [participantId]
  );
  assert.equal(audit.rows[0].payload.authorization_binding_verified, true);
});

await runTest("idempotent join replay does not consume twice", async () => {
  const dealId = await seedDeal("bind-replay", 25);
  const auth = await authorize(dealId, "0501110003", 1);
  const idem = `bind-replay-${randomUUID()}`;
  const first = await join(dealId, "0501110003", 1, auth.authorization_id, idem);
  assert.equal(first.statusCode, 200, first.body);
  const second = await join(dealId, "0501110003", 1, auth.authorization_id, idem);
  assert.equal(second.statusCode, 200, second.body);
  assert.equal((second.json() as any).participant_id, (first.json() as any).participant_id);
  const participants = await pool.query(
    `SELECT COUNT(*)::int AS n FROM siton.participants WHERE deal_id=$1`,
    [dealId]
  );
  assert.equal(participants.rows[0].n, 1);
});

await runTest("duplicate consumption of the same authorization fails closed", async () => {
  const dealId = await seedDeal("bind-dup", 25);
  const auth = await authorize(dealId, "0501110004", 1);
  const first = await join(dealId, "0501110004", 1, auth.authorization_id, `dup-a-${randomUUID()}`);
  assert.equal(first.statusCode, 200, first.body);
  const second = await join(dealId, "0501110004", 1, auth.authorization_id, `dup-b-${randomUUID()}`);
  assert.equal(second.statusCode, 409, second.body);
  assert.match(second.body, /already_consumed|already used/i);
});

await runTest("strict mode requires an authorization", async () => {
  const dealId = await seedDeal("bind-required", 25);
  const res = await join(dealId, "0501110005", 1, null);
  assert.equal(res.statusCode, 402, res.body);
  assert.match(res.body, /payment_authorization_required/);
});

await runTest("wrong deal fails closed", async () => {
  const dealA = await seedDeal("bind-deal-a", 25);
  const dealB = await seedDeal("bind-deal-b", 25);
  const auth = await authorize(dealA, "0501110006", 1);
  const res = await join(dealB, "0501110006", 1, auth.authorization_id);
  assert.equal(res.statusCode, 402, res.body);
  assert.match(res.body, /payment_authorization_not_found/);
});

await runTest("wrong buyer fails closed", async () => {
  const dealId = await seedDeal("bind-buyer", 25);
  const auth = await authorize(dealId, "0501110007", 1);
  const res = await join(dealId, "0509990007", 1, auth.authorization_id);
  assert.equal(res.statusCode, 402, res.body);
  assert.match(res.body, /payment_authorization_not_found/);
});

await runTest("wrong quantity fails closed", async () => {
  const dealId = await seedDeal("bind-qty", 25);
  const auth = await authorize(dealId, "0501110008", 1);
  const res = await join(dealId, "0501110008", 2, auth.authorization_id);
  assert.equal(res.statusCode, 409, res.body);
  assert.match(res.body, /quantity_mismatch/);
});

await runTest("wrong authoritative amount fails closed", async () => {
  const dealId = await seedDeal("bind-amount", 25);
  await insertBinding({
    dealId,
    buyerId: "0501110009",
    authorizationId: "auth-wrong-amount",
    qty: 1,
    amountMinor: 999
  });
  const res = await join(dealId, "0501110009", 1, "auth-wrong-amount");
  assert.equal(res.statusCode, 409, res.body);
  assert.match(res.body, /amount_mismatch/);
});

await runTest("pending provider confirmation is not consumable", async () => {
  const dealId = await seedDeal("bind-pending", 25);
  await insertBinding({
    dealId,
    buyerId: "0501110010",
    authorizationId: "auth-pending-hosted",
    qty: 1,
    amountMinor: 2500,
    status: "pending_provider_confirmation"
  });
  const res = await join(dealId, "0501110010", 1, "auth-pending-hosted");
  assert.equal(res.statusCode, 402, res.body);
  assert.match(res.body, /not_confirmed/);
});

await runTest("wrong provider fails closed", async () => {
  const dealId = await seedDeal("bind-provider", 25);
  await insertBinding({
    dealId,
    buyerId: "0501110011",
    authorizationId: "auth-wrong-provider",
    qty: 1,
    amountMinor: 2500,
    providerCode: "otherpay"
  });
  const res = await join(dealId, "0501110011", 1, "auth-wrong-provider");
  assert.equal(res.statusCode, 409, res.body);
  assert.match(res.body, /provider_mismatch/);
});

await runTest("wrong provider environment fails closed", async () => {
  const dealId = await seedDeal("bind-env", 25);
  await insertBinding({
    dealId,
    buyerId: "0501110012",
    authorizationId: "auth-wrong-env",
    qty: 1,
    amountMinor: 2500,
    environment: "live"
  });
  const res = await join(dealId, "0501110012", 1, "auth-wrong-env");
  assert.equal(res.statusCode, 409, res.body);
  assert.match(res.body, /environment_mismatch/);
});

await runTest("expired authorization fails closed on every consume attempt", async () => {
  const dealId = await seedDeal("bind-expired", 25);
  await insertBinding({
    dealId,
    buyerId: "0501110013",
    authorizationId: "auth-expired",
    qty: 1,
    amountMinor: 2500,
    expiresAt: new Date(Date.now() - 60_000).toISOString()
  });
  const res = await join(dealId, "0501110013", 1, "auth-expired");
  assert.equal(res.statusCode, 402, res.body);
  assert.match(res.body, /expired/);
  const retry = await join(dealId, "0501110013", 1, "auth-expired", `expired-retry-${randomUUID()}`);
  assert.equal(retry.statusCode, 402, retry.body);
  const participants = await pool.query(`SELECT COUNT(*)::int AS n FROM siton.participants WHERE deal_id=$1`, [dealId]);
  assert.equal(participants.rows[0].n, 0);
});

await runTest("failed join never leaves AuthHeld or a consumed binding behind", async () => {
  const dealId = await seedDeal("bind-atomic", 25);
  const auth = await authorize(dealId, "0501110014", 1);
  const res = await join(dealId, "0501110014", 2, auth.authorization_id); // qty mismatch aborts
  assert.equal(res.statusCode, 409);
  const participants = await pool.query(`SELECT COUNT(*)::int AS n FROM siton.participants WHERE deal_id=$1`, [dealId]);
  assert.equal(participants.rows[0].n, 0, "join transaction must roll back completely");
  const binding = await bindingRow(auth.authorization_id, dealId);
  assert.equal(binding.status, "authorized", "binding must remain consumable after a failed join");
});

console.log(`SUMMARY passed=${passed} failed=${failed}`);
await pool.end();
process.exit(failed ? 1 : 0);
