import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import pg from "pg";
import "dotenv/config";

// R9A — UNKNOWN reconciliation boundaries: late resolution, duplicates,
// amount mismatch fail-closed, and bounded exhaustion into manual review.

process.env.PORT = "3097";
process.env.APP_DEPLOYMENT_MODE = "internal-runtime";
process.env.SELLER_SESSION_SECRET = "seller-session-secret-reconcile";
process.env.PAYMENT_PROVIDER = "payrail-http";
process.env.PAYMENT_PROVIDER_MODE = "provider-ready";
process.env.PAYMENT_PROVIDER_API_KEY = "live-provider-key";
process.env.PAYMENT_PROVIDER_TIMEOUT_MS = "500";
process.env.OUTBOX_POLL_MS = "60000";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.PAYMENT_WEBHOOK_PROVIDER = "payrail-http";
process.env.PAYMENT_WEBHOOK_SECRET = "reconcile-webhook-secret";

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

// Status behavior is keyed by the reference the reconcile job looks up.
const statusPlans = new Map<string, { state: string; final: boolean; amount_minor?: number }>();
const statusCalls: string[] = [];

async function startProviderStub() {
  const server = http.createServer((req, res) => {
    req.on("data", () => undefined);
    req.on("end", () => {
      if (req.url && req.url.startsWith("/status/")) {
        const reference = decodeURIComponent(req.url.split("/status/")[1]!.split("?")[0]!);
        statusCalls.push(reference);
        const plan = statusPlans.get(reference) || { state: "pending", final: false };
        res.setHeader("content-type", "application/json");
        res.statusCode = 200;
        res.end(JSON.stringify({ ...plan, provider_reference: reference }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not_found" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("stub port missing");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  };
}

const provider = await startProviderStub();
process.env.PAYMENT_PROVIDER_BASE_URL = provider.baseUrl;

const { processOutboxEventById } = await import(`../src/app.js?reconcile-${Date.now()}`);
const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton"
});

async function seedChargeAttemptParticipant(args: {
  suffix: string;
  authorizationId: string;
  buyerState?: string;
  moneyState?: string;
  bindingAmountMinor?: number;
  dealState?: string;
  completionWindowUntil?: string | null;
}) {
  const dealId = randomUUID();
  const participantId = randomUUID();
  await pool.query(
    `INSERT INTO siton.seller_accounts(seller_id, display_name, auth_enabled) VALUES ($1,$2,false)
     ON CONFLICT (seller_id) DO NOTHING`,
    [`rc-seller-${args.suffix}`, `Reconcile seller ${args.suffix}`]
  );
  await pool.query(
    `INSERT INTO siton.deals (
       deal_id, title, price_per_unit, min_units, max_units, threshold_units, deadline, state, published_at, created_at, completion_window_until, seller_id
     ) VALUES ($1,$2,42,2,50,9,$3,$4, now(), now(), $5, $6)`,
    [
      dealId,
      `Reconcile Deal ${args.suffix}`,
      new Date(Date.now() + 3_600_000).toISOString(),
      args.dealState || "Charging",
      args.completionWindowUntil ?? null,
      `rc-seller-${args.suffix}`
    ]
  );
  await pool.query(
    `INSERT INTO siton.participants (
       participant_id, deal_id, buyer_id, qty, buyer_state, money_state, delivery_cost, created_at
     ) VALUES ($1,$2,$3,10,$4,$5,0, now())`,
    [participantId, dealId, `buyer-${args.suffix}`, args.buyerState || "ChargingAttempt", args.moneyState || "ChargeAttempt"]
  );
  if (args.bindingAmountMinor !== undefined) {
    await pool.query(
      `INSERT INTO siton.payment_authorization_bindings
         (provider_code, provider_mode, provider_environment, authorization_id, provider_reference,
          deal_id, buyer_id, qty, amount_minor, currency, delivery_cost, status, correlation_id,
          consumed_by_participant_id, consumed_at)
       VALUES ('payrail-http','provider-ready','demo',$1,$1,$2,$3,10,$4,'ILS',0,'consumed',$5,$6,now())`,
      [args.authorizationId, dealId, `buyer-${args.suffix}`, args.bindingAmountMinor, `rc-corr-${randomUUID().replace(/-/g, "")}`, participantId]
    );
  }
  const correlation = `rc-${args.suffix}-${randomUUID().slice(0, 8)}`;
  await pool.query(
    `INSERT INTO siton.payment_attempts(participant_id, deal_id, attempt_type, result_class, correlation_id)
     VALUES ($1,$2,'charge_start','unknown',$3)`,
    [participantId, dealId, correlation]
  );
  return { dealId, participantId, correlation };
}

async function enqueueReconcile(args: {
  participantId: string;
  dealId: string;
  correlation: string;
  providerReference: string;
  attemptCount?: number;
}) {
  const eventId = randomUUID();
  await pool.query(
    `INSERT INTO siton.outbox_events (event_uuid, event_type, aggregate_type, aggregate_id, payload, status, attempt_count, available_at)
     VALUES ($1,'payment_reconcile','participant',$2,$3,'pending',$4, now())`,
    [
      eventId,
      args.participantId,
      JSON.stringify({
        participant_id: args.participantId,
        deal_id: args.dealId,
        attempt_type: "charge_start",
        correlation_id: args.correlation,
        operation: "capture",
        provider_reference: args.providerReference,
        reason: "test"
      }),
      args.attemptCount ?? 0
    ]
  );
  return eventId;
}

async function moneyState(participantId: string) {
  const r = await pool.query(`SELECT money_state, buyer_state FROM siton.participants WHERE participant_id=$1`, [participantId]);
  return r.rows[0] as { money_state: string; buyer_state: string };
}

await runTest("reconcile applies provider truth exactly once, and a duplicate reconcile is a no-op", async () => {
  const seeded = await seedChargeAttemptParticipant({ suffix: "dup", authorizationId: "rc-auth-dup" });
  statusPlans.set("rc-auth-dup", { state: "captured", final: true });

  const first = await enqueueReconcile({
    participantId: seeded.participantId,
    dealId: seeded.dealId,
    correlation: seeded.correlation,
    providerReference: "rc-auth-dup"
  });
  assert.equal((await processOutboxEventById(first))?.status, "sent");
  assert.equal((await moneyState(seeded.participantId)).money_state, "ChargedSuccess");

  const ledgerAfterFirst = await pool.query(
    `SELECT COUNT(*)::int AS n FROM siton.platform_fee_money_events WHERE participant_id=$1`,
    [seeded.participantId]
  );
  assert.equal(ledgerAfterFirst.rows[0].n, 1);

  const statusCallsBefore = statusCalls.filter((ref) => ref === "rc-auth-dup").length;
  const second = await enqueueReconcile({
    participantId: seeded.participantId,
    dealId: seeded.dealId,
    correlation: seeded.correlation,
    providerReference: "rc-auth-dup"
  });
  assert.equal((await processOutboxEventById(second))?.status, "sent");
  // Late/duplicate reconcile after resolution: no provider call, no changes.
  assert.equal(statusCalls.filter((ref) => ref === "rc-auth-dup").length, statusCallsBefore);
  const ledgerAfterSecond = await pool.query(
    `SELECT COUNT(*)::int AS n FROM siton.platform_fee_money_events WHERE participant_id=$1`,
    [seeded.participantId]
  );
  assert.equal(ledgerAfterSecond.rows[0].n, 1, "duplicate reconcile must not double the fee ledger");
});

await runTest("provider amount mismatch fails closed into a manual-review case without state mutation", async () => {
  const seeded = await seedChargeAttemptParticipant({
    suffix: "amount",
    authorizationId: "rc-auth-amount",
    bindingAmountMinor: 42_000
  });
  statusPlans.set("rc-auth-amount", { state: "captured", final: true, amount_minor: 999 });
  const eventId = await enqueueReconcile({
    participantId: seeded.participantId,
    dealId: seeded.dealId,
    correlation: seeded.correlation,
    providerReference: "rc-auth-amount"
  });
  assert.equal((await processOutboxEventById(eventId))?.status, "failed");
  assert.equal((await moneyState(seeded.participantId)).money_state, "ChargeAttempt", "no state guess on mismatch");
  const cases = await pool.query(
    `SELECT COUNT(*)::int AS n FROM siton.operational_cases WHERE auto_key=$1`,
    [`payment-reconcile-amount-mismatch:${seeded.participantId}:charge_start`]
  );
  assert.equal(cases.rows[0].n, 1);
});

await runTest("unresolvable UNKNOWN stays bounded and exits into a visible manual-review case", async () => {
  const seeded = await seedChargeAttemptParticipant({ suffix: "stuck", authorizationId: "rc-auth-stuck" });
  statusPlans.set("rc-auth-stuck", { state: "pending", final: false });
  // Simulate the final allowed outbox attempt.
  const eventId = await enqueueReconcile({
    participantId: seeded.participantId,
    dealId: seeded.dealId,
    correlation: seeded.correlation,
    providerReference: "rc-auth-stuck",
    attemptCount: 3
  });
  assert.equal((await processOutboxEventById(eventId))?.status, "failed");
  assert.equal((await moneyState(seeded.participantId)).money_state, "ChargeAttempt");
  const cases = await pool.query(
    `SELECT COUNT(*)::int AS n FROM siton.operational_cases WHERE auto_key=$1`,
    [`payment-reconcile-unresolved:${seeded.participantId}:charge_start`]
  );
  assert.equal(cases.rows[0].n, 1);
  const dlq = await pool.query(`SELECT COUNT(*)::int AS n FROM siton.outbox_dlq WHERE event_uuid=$1`, [eventId]);
  assert.equal(dlq.rows[0].n, 1, "exhausted reconcile must be DLQ-visible");
});

await runTest("late charge failure via reconcile re-arms recovery inside the completion window", async () => {
  const seeded = await seedChargeAttemptParticipant({
    suffix: "latefail",
    authorizationId: "rc-auth-latefail",
    dealState: "CompletionWindow",
    completionWindowUntil: new Date(Date.now() + 3_600_000).toISOString()
  });
  statusPlans.set("rc-auth-latefail", { state: "failed", final: true });
  const eventId = await enqueueReconcile({
    participantId: seeded.participantId,
    dealId: seeded.dealId,
    correlation: seeded.correlation,
    providerReference: "rc-auth-latefail"
  });
  assert.equal((await processOutboxEventById(eventId))?.status, "sent");
  const state = await moneyState(seeded.participantId);
  assert.equal(state.money_state, "ChargeFailedRecovery");
  assert.equal(state.buyer_state, "ChargeFailedCompletion");
  const recovery = await pool.query(
    `SELECT COUNT(*)::int AS n FROM siton.outbox_events WHERE event_type='recovery_deal' AND aggregate_id=$1 AND status='pending'`,
    [seeded.dealId]
  );
  assert.equal(recovery.rows[0].n, 1, "recovery_deal must be re-armed for a late-resolved charge failure");
});

console.log(`SUMMARY passed=${passed} failed=${failed}`);
await provider.close();
await pool.end();
// Windows/libuv teardown drain (uv_async close race under process.exit).
await new Promise((resolve) => setTimeout(resolve, 700));
process.exit(failed ? 1 : 0);
