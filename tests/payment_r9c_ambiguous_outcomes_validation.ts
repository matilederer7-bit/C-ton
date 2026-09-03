// R9C remediation regression — ambiguous provider outcomes AFTER dispatch
// (Codex C2) on every money rail, plus the pre-dispatch retry rule.
//
// Adapted from the independent Codex counterexample (branch
// codex/r9c-independent-review @ 550a976, same file name). The ORIGINAL proof
// PASSED when it reproduced TWO provider money effects for HTTP 503 and 429 on
// R9C SHA 33a2cb2 (temporary_fail → outbox retry → fresh identity n2). This
// version asserts the SAFE behaviour and therefore FAILS on the unfixed code:
//
//   CASE 3/4/5/6/7  capture executed, then 503 / 429 / connection drop / client
//                   timeout / malformed 2xx body → UNKNOWN on the SAME identity,
//                   reconciliation proves it, provider effects = 1, no n2 identity
//   CASE 2/18       proven PRE-dispatch failure (missing authorization) → the
//                   SAME identity is retried by normal outbox policy, one effect
//   CASE 12         recovery executed, then 503 → one recovery effect
//   CASE 13/14      refund executed, then 503 / 429 → one refund effect
//   CASE 15         release executed, then 503 → one release effect
//
// Provider: in-process HTTP stub (PAYMENT_PROVIDER_MODE=provider-ready) that
// records the money side effect BEFORE it answers. No real provider, no money.

import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import pg from "pg";
import "dotenv/config";

process.env.NODE_ENV = "test";
process.env.PORT = "3102";
process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.SELLER_SESSION_SECRET = "seller-session-secret-r9c-ambiguous";
process.env.PAYMENT_PROVIDER = "payrail-http";
process.env.PAYMENT_PROVIDER_MODE = "provider-ready";
process.env.PAYMENT_PROVIDER_API_KEY = "r9c-ambiguous-provider-key";
process.env.PAYMENT_PROVIDER_CAPTURE_PATH = "/capture";
process.env.PAYMENT_PROVIDER_RECOVERY_PATH = "/recover";
process.env.PAYMENT_PROVIDER_REFUND_PATH = "/refund";
process.env.PAYMENT_PROVIDER_RELEASE_PATH = "/release";
process.env.PAYMENT_PROVIDER_STATUS_PATH = "/status";
process.env.PAYMENT_PROVIDER_TIMEOUT_MS = "100";
process.env.OUTBOX_POLL_MS = "60000";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.PAYMENT_WEBHOOK_PROVIDER = "payrail-http";
process.env.PAYMENT_WEBHOOK_SECRET = "r9c-ambiguous-webhook-secret";
process.env.WORKER_LEASE_MS = "30000";
process.env.OUTBOX_MAX_ATTEMPTS = "4";

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
assert.match(
  String((await pool.query(`SELECT current_database() AS name`)).rows[0]?.name || ""),
  /^siton_test_/,
  "this proof may run only in a disposable isolated test database"
);

let passed = 0;
async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`PASS ${name}`); } catch (error) { console.error(`FAIL ${name}`); throw error; }
}

type Call = { op: string; scenario: string; key: string; auth: string };
const calls: Call[] = [];
const effects = new Map<string, number>(); // `${op}:${auth}`
const ops = (op: string, auth: string) => calls.filter((c) => c.op === op && c.auth === auth);
const effectsOf = (op: string, auth: string) => effects.get(`${op}:${auth}`) || 0;
const moneyEffects = (auth: string) => ["capture", "recover", "refund", "release"].reduce((sum, op) => sum + effectsOf(op, auth), 0);

const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
  req.on("end", async () => {
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    const url = new URL(String(req.url), "http://stub");
    const auth = String(body.authorization_id || body.capture_reference || decodeURIComponent(url.pathname.split("/").pop() || "")).replace(/^(cap|rec|ref|rel)-/, "");
    const scenario = auth.replace(/^auth-/, "");

    if (url.pathname.startsWith("/status/")) {
      const operation = url.searchParams.get("operation") || "capture";
      calls.push({ op: `status:${operation}`, scenario, key: "", auth });
      const state = operation === "refund"
        ? (effectsOf("refund", auth) > 0 ? "refunded" : "captured")
        : operation === "release"
          ? (effectsOf("release", auth) > 0 ? "released" : "authorized")
          : (effectsOf("capture", auth) + effectsOf("recover", auth) > 0 ? "captured" : "authorized");
      res.setHeader("content-type", "application/json");
      res.statusCode = 200;
      res.end(JSON.stringify({ state, final: true, provider_reference: auth, amount_minor: 4200 }));
      return;
    }

    const op = url.pathname === "/capture" ? "capture" : url.pathname === "/recover" ? "recover" : url.pathname === "/refund" ? "refund" : url.pathname === "/release" ? "release" : null;
    if (!op) { res.statusCode = 404; res.end(); return; }
    calls.push({ op, scenario, key: String(req.headers["idempotency-key"] || ""), auth });
    // The money moves NOW — before the client learns anything.
    effects.set(`${op}:${auth}`, effectsOf(op, auth) + 1);
    const nth = ops(op, auth).length;
    const kind = scenario.replace(/^(rec|ref|rel)/, "");
    if (nth === 1 && (kind === "503" || kind === "429")) {
      res.setHeader("content-type", "application/json");
      res.statusCode = Number(kind);
      res.end(JSON.stringify({ error: `after_dispatch_${kind}`, provider_reference: auth }));
      return;
    }
    if (nth === 1 && kind === "drop") { req.socket.destroy(); return; }
    if (nth === 1 && kind === "timeout") await new Promise((resolve) => setTimeout(resolve, 350));
    if (nth === 1 && kind === "malformed") {
      res.setHeader("content-type", "application/json");
      res.statusCode = 200;
      res.end('{"status":"captured","capture_id":"cap-' + auth); // truncated body
      return;
    }
    if (!res.destroyed) {
      res.setHeader("content-type", "application/json");
      res.statusCode = 200;
      const status = op === "capture" ? "captured" : op === "recover" ? "recovered" : op === "refund" ? "refunded" : "released";
      res.end(JSON.stringify({ status, [`${op === "release" ? "authorization" : op === "recover" ? "recovery" : op === "refund" ? "refund" : "capture"}_id`]: `${op.slice(0, 3)}-${auth}`, provider_reference: `${op.slice(0, 3)}-${auth}`, reference: body.reference }));
    }
  });
});
await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
const address = server.address();
if (!address || typeof address === "string") throw new Error("provider stub did not bind");
process.env.PAYMENT_PROVIDER_BASE_URL = `http://127.0.0.1:${address.port}`;

const { app, processOutboxEventById, closeWorkerDatabase } = await import(`../src/app.js?r9c-ambiguous-${Date.now()}`);

async function insertJoinAudit(participantId: string, dealId: string, authorizationId: string, suffix: string) {
  await pool.query(
    `INSERT INTO siton.audit_log (entity_type, entity_id, deal_id, state_type, from_state, to_state, action_name, request_id, idempotency_key, payload)
     VALUES ('participant',$1,$2,'buyer_state','NotJoined','JoinedAuthorized','participant.join_authorize',$3,$4,$5)`,
    [participantId, dealId, `seed-${suffix}`, `seed-${suffix}:${participantId}:${randomUUID().slice(0, 8)}`, JSON.stringify({ authorization: "provider_authorized", authorization_id: authorizationId, authorization_provider: "payrail-http" })]
  );
}

async function seed(args: {
  suffix: string;
  dealState: string;
  buyer_state: string;
  money_state: string;
  eventType: "charge_deal" | "recovery_deal" | "refund_issue" | "payment_release";
  completionWindowUntil?: Date | null;
  withAuthorization?: boolean;
  priorChargeAttempt?: "permanent_fail";
}) {
  const dealId = randomUUID();
  const participantId = randomUUID();
  const eventId = randomUUID();
  const authorizationId = `auth-${args.suffix}`;
  await pool.query(
    `INSERT INTO siton.deals (deal_id, seller_id, state, title, price_per_unit, min_units, max_units, threshold_units, deadline, published_at, completion_window_until)
     VALUES ($1,'seller-r9c',$2,$3,42,1,50,1,$4,now(),$5)`,
    [dealId, args.dealState, `R9C ambiguous ${args.suffix}`, new Date(Date.now() + 30 * 60_000).toISOString(), args.completionWindowUntil ? args.completionWindowUntil.toISOString() : null]
  );
  await pool.query(
    `INSERT INTO siton.participants (participant_id, deal_id, buyer_id, qty, buyer_state, money_state, delivery_cost, created_at)
     VALUES ($1,$2,$3,1,$4,$5,0,now())`,
    [participantId, dealId, `buyer-r9c-${args.suffix}`, args.buyer_state, args.money_state]
  );
  if (args.withAuthorization !== false) await insertJoinAudit(participantId, dealId, authorizationId, args.suffix);
  if (args.priorChargeAttempt) {
    await pool.query(
      `INSERT INTO siton.payment_attempts (participant_id, deal_id, attempt_type, result_class, correlation_id) VALUES ($1,$2,'charge_start',$3,$4)`,
      [participantId, dealId, args.priorChargeAttempt, `capture:prior:n1:${participantId}`]
    );
  }
  const participantScoped = args.eventType === "payment_release";
  await pool.query(
    `INSERT INTO siton.outbox_events (event_uuid, event_type, aggregate_type, aggregate_id, payload, status, attempt_count, available_at, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,'pending',0,now(),now(),now())`,
    [eventId, args.eventType, participantScoped ? "participant" : "deal", participantScoped ? participantId : dealId, JSON.stringify(participantScoped ? { participant_id: participantId, deal_id: dealId, reason: "r9c" } : { deal_id: dealId })]
  );
  return { dealId, participantId, eventId, authorizationId };
}

async function attempts(participantId: string, attemptType: string) {
  return (await pool.query(
    `SELECT correlation_id, result_class, dispatch_state, owner_event_uuid FROM siton.payment_attempts WHERE participant_id=$1 AND attempt_type=$2 ORDER BY created_at, correlation_id`,
    [participantId, attemptType]
  )).rows as Array<{ correlation_id: string; result_class: string; dispatch_state: string; owner_event_uuid: string | null }>;
}
async function moneyState(participantId: string) {
  return String((await pool.query(`SELECT money_state FROM siton.participants WHERE participant_id=$1`, [participantId])).rows[0]?.money_state);
}
async function ledger(participantId: string) {
  return (await pool.query(`SELECT logical_entry_type FROM siton.platform_fee_money_events WHERE participant_id=$1 ORDER BY created_at`, [participantId])).rows.map((r) => String(r.logical_entry_type));
}
async function pendingReconcile(participantId: string) {
  return (await pool.query(`SELECT event_uuid FROM siton.outbox_events WHERE event_type='payment_reconcile' AND aggregate_id=$1 AND status='pending' ORDER BY created_at`, [participantId])).rows.map((r) => String(r.event_uuid));
}
async function outboxError(eventId: string) {
  return (await pool.query(`SELECT status, last_error FROM siton.outbox_events WHERE event_uuid=$1`, [eventId])).rows[0] as { status: string; last_error: string | null };
}

async function assertSingleIdentityResolved(participantId: string, attemptType: string, expectedKey: string) {
  const rows = await attempts(participantId, attemptType);
  assert.equal(rows.length, 1, "exactly one durable identity — no n2 was ever minted");
  assert.equal(rows[0]!.result_class, "success");
  assert.equal(rows[0]!.dispatch_state, "responded");
  assert.equal(rows[0]!.correlation_id, expectedKey, "the provider saw exactly this identity");
  assert.doesNotMatch(rows[0]!.correlation_id, /:n2:/);
}

try {
  for (const scenario of ["503", "429", "drop", "timeout", "malformed"] as const) {
    await run(`CASE capture → ${scenario} after the money moved → UNKNOWN on the SAME identity, reconciliation proves it, ONE provider effect`, async () => {
      const s = await seed({ suffix: scenario, dealState: "Charging", buyer_state: "ChargingAttempt", money_state: "ChargeAttempt", eventType: "charge_deal" });
      const first = await processOutboxEventById(s.eventId);
      assert.equal(first?.status, "sent", `${scenario}: an ambiguous outcome never fails the job into a blind retry: ${JSON.stringify(first)}`);
      const afterFirst = await attempts(s.participantId, "charge_start");
      assert.equal(afterFirst.length, 1, `${scenario}: one identity`);
      assert.equal(afterFirst[0]!.result_class, "unknown", `${scenario}: post-dispatch ambiguity is UNKNOWN, never temporary_fail`);
      assert.equal(afterFirst[0]!.dispatch_state, "responded");
      assert.equal(await moneyState(s.participantId), "ChargeAttempt", `${scenario}: nothing guessed`);
      assert.equal(ops("capture", s.authorizationId).length, 1);
      assert.equal(effectsOf("capture", s.authorizationId), 1);
      const reconcile = await pendingReconcile(s.participantId);
      assert.equal(reconcile.length, 1, `${scenario}: UNKNOWN schedules reconciliation`);
      const reconciled = await processOutboxEventById(reconcile[0]!);
      assert.equal(reconciled?.status, "sent", JSON.stringify(reconciled));
      assert.equal(ops("capture", s.authorizationId).length, 1, `${scenario}: reconciliation never sends another capture`);
      assert.equal(moneyEffects(s.authorizationId), 1, `${scenario}: exactly one provider money effect`);
      assert.equal(await moneyState(s.participantId), "ChargedSuccess");
      assert.deepEqual(await ledger(s.participantId), ["charge"]);
      await assertSingleIdentityResolved(s.participantId, "charge_start", ops("capture", s.authorizationId)[0]!.key);
    });
  }

  await run("CASE 2/18: proven PRE-dispatch failure (no authorization available) → the SAME identity is retried by normal outbox policy → one capture, one effect", async () => {
    const s = await seed({ suffix: "predispatch", dealState: "Charging", buyer_state: "ChargingAttempt", money_state: "ChargeAttempt", eventType: "charge_deal", withAuthorization: false });
    const first = await processOutboxEventById(s.eventId);
    assert.equal(first?.status, "failed", JSON.stringify(first));
    assert.match(String(first?.error), /temporary_fail/);
    assert.match(String(first?.error), /pre-dispatch/);
    assert.equal(ops("capture", s.authorizationId).length, 0, "nothing reached the provider");
    const afterFirst = await attempts(s.participantId, "charge_start");
    assert.equal(afterFirst.length, 1);
    assert.equal(afterFirst[0]!.result_class, "unknown");
    assert.equal(afterFirst[0]!.dispatch_state, "recorded", "disarmed back to NOT_DISPATCHED");
    assert.equal(afterFirst[0]!.owner_event_uuid, null);
    assert.equal((await outboxError(s.eventId)).status, "pending", "normal bounded retry remains available");
    // The operator/provider makes the authorization available; the outbox retries.
    await insertJoinAudit(s.participantId, s.dealId, s.authorizationId, "predispatch-fixed");
    await pool.query(`UPDATE siton.outbox_events SET available_at=now() WHERE event_uuid=$1`, [s.eventId]);
    const second = await processOutboxEventById(s.eventId);
    assert.equal(second?.status, "sent", JSON.stringify(second));
    assert.equal(ops("capture", s.authorizationId).length, 1);
    assert.equal(moneyEffects(s.authorizationId), 1);
    assert.equal(await moneyState(s.participantId), "ChargedSuccess");
    await assertSingleIdentityResolved(s.participantId, "charge_start", ops("capture", s.authorizationId)[0]!.key);
    assert.equal(ops("capture", s.authorizationId)[0]!.key, afterFirst[0]!.correlation_id, "the retry reused the identity minted before the pre-dispatch failure (no rolling-cap consumption)");
  });

  await run("CASE 12: recovery executed, then 503 → UNKNOWN on the same identity → ONE recovery effect, RecoveredCharge", async () => {
    const s = await seed({ suffix: "rec503", dealState: "CompletionWindow", buyer_state: "ChargeFailedCompletion", money_state: "ChargeFailedRecovery", eventType: "recovery_deal", completionWindowUntil: new Date(Date.now() + 20 * 60_000), priorChargeAttempt: "permanent_fail" });
    const first = await processOutboxEventById(s.eventId);
    assert.equal(first?.status, "sent", JSON.stringify(first));
    assert.equal(ops("recover", s.authorizationId).length, 1);
    assert.deepEqual((await attempts(s.participantId, "recovery")).map((r) => r.result_class), ["unknown"]);
    assert.equal(await moneyState(s.participantId), "ChargeFailedRecovery");
    const reconcile = await pendingReconcile(s.participantId);
    assert.equal(reconcile.length, 1);
    assert.equal((await processOutboxEventById(reconcile[0]!))?.status, "sent");
    assert.equal(ops("recover", s.authorizationId).length, 1, "no second recovery request");
    assert.equal(moneyEffects(s.authorizationId), 1);
    assert.equal(await moneyState(s.participantId), "RecoveredCharge");
    assert.deepEqual(await ledger(s.participantId), ["charge"]);
    await assertSingleIdentityResolved(s.participantId, "recovery", ops("recover", s.authorizationId)[0]!.key);
  });

  for (const scenario of ["ref503", "ref429"] as const) {
    await run(`CASE refund executed, then ${scenario.slice(3)} → UNKNOWN on the same identity → ONE refund effect, Refunded`, async () => {
      const s = await seed({ suffix: scenario, dealState: "Failed", buyer_state: "DealFailed", money_state: "ChargedSuccess", eventType: "refund_issue" });
      const first = await processOutboxEventById(s.eventId);
      assert.equal(first?.status, "sent", JSON.stringify(first));
      assert.equal(ops("refund", s.authorizationId).length, 1);
      assert.deepEqual((await attempts(s.participantId, "refund")).map((r) => r.result_class), ["unknown"]);
      assert.equal(await moneyState(s.participantId), "ChargedSuccess", "no Refunded guess");
      const reconcile = await pendingReconcile(s.participantId);
      assert.equal(reconcile.length, 1);
      assert.equal((await processOutboxEventById(reconcile[0]!))?.status, "sent");
      assert.equal(ops("refund", s.authorizationId).length, 1, "no second refund request");
      assert.equal(moneyEffects(s.authorizationId), 1);
      assert.equal(await moneyState(s.participantId), "Refunded");
      assert.equal((await ledger(s.participantId)).filter((e) => e === "refund_adjustment").length, 1, "exactly one signed refund adjustment");
      await assertSingleIdentityResolved(s.participantId, "refund", ops("refund", s.authorizationId)[0]!.key);
    });
  }

  await run("CASE 15: release executed, then 503 → UNKNOWN on the same identity → ONE release effect, AuthReleased", async () => {
    const s = await seed({ suffix: "rel503", dealState: "Failed", buyer_state: "DealFailed", money_state: "AuthHeld", eventType: "payment_release" });
    const first = await processOutboxEventById(s.eventId);
    assert.equal(first?.status, "sent", JSON.stringify(first));
    assert.equal(ops("release", s.authorizationId).length, 1);
    assert.deepEqual((await attempts(s.participantId, "release")).map((r) => r.result_class), ["unknown"]);
    assert.equal(await moneyState(s.participantId), "AuthHeld", "no AuthReleased guess");
    const reconcile = await pendingReconcile(s.participantId);
    assert.equal(reconcile.length, 1);
    assert.equal((await processOutboxEventById(reconcile[0]!))?.status, "sent");
    assert.equal(ops("release", s.authorizationId).length, 1, "no second release request");
    assert.equal(moneyEffects(s.authorizationId), 1);
    assert.equal(await moneyState(s.participantId), "AuthReleased");
    await assertSingleIdentityResolved(s.participantId, "release", ops("release", s.authorizationId)[0]!.key);
  });

  const evidence = {
    provider_calls: calls,
    provider_money_effects: Object.fromEntries(effects),
    payment_attempts: (await pool.query(
      `SELECT p.buyer_id, pa.attempt_type, pa.correlation_id, pa.result_class, pa.dispatch_state FROM siton.payment_attempts pa JOIN siton.participants p ON p.participant_id=pa.participant_id WHERE p.buyer_id LIKE 'buyer-r9c-%' ORDER BY p.buyer_id, pa.attempt_type, pa.created_at`
    )).rows,
    participants: (await pool.query(`SELECT buyer_id, buyer_state, money_state FROM siton.participants WHERE buyer_id LIKE 'buyer-r9c-%' ORDER BY buyer_id`)).rows
  };
  console.log(`R9C_AMBIGUOUS_EVIDENCE ${JSON.stringify(evidence)}`);
  console.log(`PAYMENT_R9C_AMBIGUOUS_OUTCOMES_VALIDATION passed=${passed}`);
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve())).catch(() => undefined);
  await app.close().catch(() => undefined);
  await closeWorkerDatabase().catch(() => undefined);
  await pool.end().catch(() => undefined);
  // Windows libuv teardown drain (mixed aborted + successful undici fetches).
  await new Promise((resolve) => setTimeout(resolve, 700));
}
