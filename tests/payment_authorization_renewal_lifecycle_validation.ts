// LONG_HORIZON_DEALS — deal lifetime is independent of authorization lifetime.
//
// Property under test:
//   A buyer's financial COMMITMENT (participant AuthHeld → … → ChargeAttempt) is
//   long-lived according to Siton's state machine. The provider AUTHORIZATION
//   behind it is a replaceable technical instrument. When it is no longer
//   usable at the charging boundary the worker re-establishes it from the
//   stored payment-method reference through the provider abstraction and
//   captures the renewed authorization — with exactly ONE financial effect,
//   idempotently, under concurrent workers, after crashes, through
//   reconciliation, and without any visible state moving because an
//   authorization merely expired. Only a definitive inability to obtain the
//   payment result follows the existing failure/recovery rules.
//
// Harness: the REAL worker rails (processOutboxEventById → charge / recovery /
// reconcile) against a fake provider over HTTP (PAYMENT_PROVIDER_MODE=
// provider-ready) that models expired holds, stored-instrument
// re-authorization with idempotency-key replay, pending confirmations and
// declines. No real provider, no real money.
//
// Scenarios (letters refer to the task's proof list):
//   R1  (B,C,D,O) declared validity passed long before charging → renewal then
//       ONE capture on the renewed authorization; ChargedSuccess; the
//       participant never left ChargeAttempt in between; binding renewed once
//   R2  reactive: no declared validity, provider declines the capture because
//       the hold expired → identity settles as the exact decline, renewal, ONE
//       fresh capture; ONE ledger charge; no ChargeFailedRecovery
//   R3  (E) renewal declined by the provider → capture on the original
//       authorization → provider decline → existing recovery rules
//   R4  no stored instrument → no renewal path → provider decides → recovery
//   R5  (F,G) worker A stalls after the provider created the renewed
//       authorization; lease reclaimed; worker B re-sends the SAME identity
//       (provider replays) → ONE renewed authorization, ONE capture; A resumes
//       fenced. Then a crash between renewal commit and capture → retry
//       captures without a second renewal
//   R6  (H) renewal pending at the provider → identity UNKNOWN → NO visible
//       state change, charge job deferred; reconcile proves "authorized" →
//       renewal applied → capture on the next run
//   R7  (I) late / duplicate charge_captured webhooks after a renewed capture
//       are ignored: zero extra state, audit or ledger effect
//   R8  recovery rail: expired authorization renewed before the recovery
//       capture → RecoveredCharge
//   R9  DB guard (071): no capture / release while a renewal is unresolved;
//       no second renewal identity while one is unresolved
//   R10 (J,K) 90% threshold and completion window unchanged: the renewed
//       capture counts, finalize → Completed

import assert from "node:assert/strict";
import http from "node:http";
import { createHmac, randomUUID } from "node:crypto";
import pg from "pg";
import "dotenv/config";

process.env.NODE_ENV = "test";
process.env.PORT = "3141";
process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.SELLER_SESSION_SECRET = "seller-session-secret-lh";
process.env.PAYMENT_PROVIDER = "payrail-http";
process.env.PAYMENT_PROVIDER_MODE = "provider-ready";
process.env.PAYMENT_PROVIDER_API_KEY = "lh-provider-key";
process.env.PAYMENT_PROVIDER_AUTH_PATH = "/authorize";
process.env.PAYMENT_PROVIDER_CAPTURE_PATH = "/capture";
process.env.PAYMENT_PROVIDER_RECOVERY_PATH = "/recover";
process.env.PAYMENT_PROVIDER_REFUND_PATH = "/refund";
process.env.PAYMENT_PROVIDER_RELEASE_PATH = "/release";
process.env.PAYMENT_PROVIDER_STATUS_PATH = "/status";
process.env.PAYMENT_PROVIDER_REAUTHORIZE_PATH = "/reauthorize";
process.env.PAYMENT_PROVIDER_TIMEOUT_MS = "1500";
process.env.PAYMENT_SETTLEMENT_HORIZON_MS = "400";
process.env.OUTBOX_POLL_MS = "60000";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.PAYMENT_WEBHOOK_PROVIDER = "payrail-http";
process.env.PAYMENT_WEBHOOK_SECRET = "lh-webhook-secret";
process.env.WORKER_LEASE_MS = "6000";
process.env.OUTBOX_MAX_ATTEMPTS = "6";
process.env.RECOVERY_PREFLIGHT_CONFIRM_MS = "0";

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const database = await pool.query(`SELECT current_database() AS name`);
assert.match(String(database.rows[0]?.name || ""), /^siton_test_/, "this proof may run only in a disposable isolated test database");

let passed = 0;
async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { console.error(`FAIL ${name}`); throw error; }
}

type Call = { op: string; idempotency_key: string; authorization_id: string; payment_method: string; amount_minor: number | null };

// ── fake provider ───────────────────────────────────────────────────────────
function startProviderStub() {
  const calls: Call[] = [];
  const expiredHolds = new Set<string>();
  const authorizations = new Map<string, { captured: boolean; recovered: boolean; released: boolean }>();
  const renewalsByKey = new Map<string, string>();
  const pendingRenewals = new Set<string>();
  let renewalSequence = 0;
  const normalize = (ref: string) => String(ref || "").replace(/^(cap|rec|ref|rel)-/, "");
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on("end", async () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
      const url = new URL(String(req.url), "http://stub");
      res.setHeader("content-type", "application/json");
      const auth = normalize(String(body.authorization_id || body.capture_reference || ""));
      const method = String(body.payment_method?.id || "");
      const record = (op: string) => calls.push({ op, idempotency_key: String(req.headers["idempotency-key"] || ""), authorization_id: auth, payment_method: method, amount_minor: Number.isInteger(body.amount_minor) ? Number(body.amount_minor) : null });

      if (url.pathname === "/reauthorize") {
        record("reauthorize");
        const key = String(req.headers["idempotency-key"] || "");
        if (method.includes("decline")) { res.statusCode = 402; res.end(JSON.stringify({ status: "failed", error: "reauthorization_declined", reference: body.reference })); return; }
        // idempotent replay: the SAME identity yields the SAME authorization
        let created = renewalsByKey.get(key);
        if (!created) {
          renewalSequence += 1;
          created = `auth-renewed-${renewalSequence}`;
          renewalsByKey.set(key, created);
          authorizations.set(created, { captured: false, recovered: false, released: false });
          if (method.includes("pending")) pendingRenewals.add(created);
        }
        if (method.includes("slow")) await new Promise((resolve) => setTimeout(resolve, 50));
        res.statusCode = 200;
        res.end(JSON.stringify({
          status: pendingRenewals.has(created) ? "pending" : "authorized",
          authorization_id: created, provider_reference: created, reference: body.reference,
          expires_at: new Date(Date.now() + 7 * 24 * 3600_000).toISOString()
        }));
        return;
      }
      if (url.pathname === "/capture" || url.pathname === "/recover") {
        const op = url.pathname === "/capture" ? "capture" : "recover";
        record(op);
        if (expiredHolds.has(auth) || pendingRenewals.has(auth)) {
          res.statusCode = 402;
          res.end(JSON.stringify({ status: "failed", error: "authorization_expired", provider_reference: `cap-${auth}`, reference: body.reference }));
          return;
        }
        if (auth.includes("permfail")) { res.statusCode = 402; res.end(JSON.stringify({ status: "failed", error: "declined", provider_reference: `cap-${auth}`, reference: body.reference })); return; }
        const state = authorizations.get(auth) || { captured: false, recovered: false, released: false };
        authorizations.set(auth, { ...state, captured: op === "capture" ? true : state.captured, recovered: op === "recover" ? true : state.recovered });
        res.statusCode = 200;
        res.end(JSON.stringify({ status: op === "capture" ? "captured" : "recovered", provider_reference: `${op === "capture" ? "cap" : "rec"}-${auth}`, reference: body.reference }));
        return;
      }
      if (url.pathname === "/release") {
        record("release");
        const state = authorizations.get(auth) || { captured: false, recovered: false, released: false };
        authorizations.set(auth, { ...state, released: true });
        res.statusCode = 200; res.end(JSON.stringify({ status: "released", provider_reference: `rel-${auth}`, reference: body.reference })); return;
      }
      if (url.pathname.startsWith("/status/")) {
        const ref = normalize(decodeURIComponent(url.pathname.slice("/status/".length)));
        const operation = url.searchParams.get("operation") || "capture";
        calls.push({ op: `status:${operation}`, idempotency_key: "", authorization_id: ref, payment_method: "", amount_minor: null });
        const known = authorizations.get(ref) || { captured: false, recovered: false, released: false };
        let stateName = "authorized";
        if (operation === "authorization") stateName = pendingRenewals.has(ref) ? "pending" : (renewalsByKey.size && [...renewalsByKey.values()].includes(ref)) || authorizations.has(ref) ? "authorized" : "unknown";
        else if (operation === "release") stateName = known.released ? "released" : "authorized";
        else stateName = known.captured || known.recovered ? "captured" : expiredHolds.has(ref) ? "failed" : "authorized";
        res.statusCode = 200;
        res.end(JSON.stringify({ state: stateName, final: stateName !== "pending", provider_reference: ref, ...(stateName === "failed" ? { error_code: "authorization_expired" } : {}) }));
        return;
      }
      res.statusCode = 404; res.end(JSON.stringify({ error: "not_found" }));
    });
  });
  return new Promise<{ calls: Call[]; baseUrl: string; expiredHolds: Set<string>; confirmRenewal: (ref: string) => void; ops: (op: string, auth?: string) => Call[]; close: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("stub port");
      resolve({
        calls, baseUrl: `http://127.0.0.1:${address.port}`, expiredHolds,
        confirmRenewal: (ref) => pendingRenewals.delete(ref),
        ops: (op, auth) => calls.filter((c) => c.op === op && (!auth || c.authorization_id === auth)),
        close: () => new Promise<void>((done, fail) => server.close((error) => (error ? fail(error) : done())))
      });
    });
  });
}

const provider = await startProviderStub();
process.env.PAYMENT_PROVIDER_BASE_URL = provider.baseUrl;

const appModule = await import(`../src/app.js?lh-renewal-${Date.now()}`);
const { app, processOutboxEventById, reclaimWorkerJobs, closeWorkerDatabase } = appModule;
const { armTestFault, resetTestFaults } = await import("../src/fault_injection.js");
await app.ready();

// ── seeding ─────────────────────────────────────────────────────────────────
async function seed(args: {
  suffix: string; dealState: string; buyer_state: string; money_state: string;
  authorizationId: string; expiresAt: Date | null; paymentMethodRef: string | null;
  eventType: "charge_deal" | "recovery_deal" | null; completionWindowUntil?: Date | null; qty?: number;
  priorCaptureDeclined?: boolean;
}) {
  const dealId = randomUUID();
  const participantId = randomUUID();
  const deadline = new Date(Date.now() - 60 * 24 * 3600_000); // a deal that ran for 60 days
  await pool.query(
    `INSERT INTO siton.deals (deal_id, seller_id, state, title, price_per_unit, min_units, max_units, threshold_units, deadline, published_at, completion_window_until, created_at)
     VALUES ($1,'seller-lh',$2,$3,42,1,50,1,$4, now() - interval '61 days', $5, now() - interval '61 days')`,
    [dealId, args.dealState, `LH ${args.suffix}`, deadline.toISOString(), args.completionWindowUntil ? args.completionWindowUntil.toISOString() : null]
  );
  await pool.query(
    `INSERT INTO siton.participants (participant_id, deal_id, buyer_id, qty, buyer_state, money_state, delivery_cost, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,0, now() - interval '60 days')`,
    [participantId, dealId, `buyer-${args.suffix}`, args.qty ?? 1, args.buyer_state, args.money_state]
  );
  await pool.query(
    `INSERT INTO siton.audit_log (entity_type, entity_id, deal_id, state_type, from_state, to_state, action_name, request_id, idempotency_key, payload)
     VALUES ('participant',$1,$2,'buyer_state','NotJoined','JoinedAuthorized','participant.join_authorize',$3,$4,$5)`,
    [participantId, dealId, `seed:${args.suffix}`, `seed-join:${args.suffix}:${randomUUID()}`, JSON.stringify({ authorization: "provider_authorized", authorization_id: args.authorizationId, authorization_provider: "payrail-http", authorization_correlation_id: `payauth-${args.suffix}` })]
  );
  await pool.query(
    `INSERT INTO siton.payment_authorization_bindings
       (provider_code, provider_mode, provider_environment, authorization_id, provider_reference, deal_id, buyer_id, qty, amount_minor, currency, delivery_cost,
        status, status_reason, correlation_id, consumed_by_participant_id, consumed_at, expires_at, payment_method_ref, created_at, authorization_established_at)
     VALUES ('payrail-http','provider-ready','demo',$1,$1,$2,$3,$4,$5,'ILS',0,'consumed','join_consumed',$6,$7, now() - interval '60 days', $8, $9, now() - interval '60 days', now() - interval '60 days')`,
    [args.authorizationId, dealId, `buyer-${args.suffix}`, args.qty ?? 1, 4200 * (args.qty ?? 1), `payauth-${args.suffix}`, participantId, args.expiresAt ? args.expiresAt.toISOString() : null, args.paymentMethodRef]
  );
  if (args.priorCaptureDeclined) {
    await pool.query(
      `INSERT INTO siton.payment_attempts (participant_id, deal_id, attempt_type, result_class, correlation_id, dispatch_state, dispatched_at, resolved_at, provider_reference, failure_evidence, settlement_horizon_at, negative_finality_authoritative)
       VALUES ($1,$2,'charge_start','permanent_fail',$3,'responded', now() - interval '1 hour', now() - interval '1 hour', $4, 'dispatch_response', now() - interval '30 minutes', true)`,
      [participantId, dealId, `capture:seed:n1:${participantId}`, args.authorizationId]
    );
  }
  let outboxEventId: string | null = null;
  if (args.eventType) outboxEventId = await insertEvent(args.eventType, dealId);
  return { dealId, participantId, outboxEventId: outboxEventId as string };
}
async function insertEvent(eventType: string, dealId: string) {
  const eventId = randomUUID();
  await pool.query(
    `INSERT INTO siton.outbox_events (event_uuid, event_type, aggregate_type, aggregate_id, payload, status, attempt_count, available_at, created_at, updated_at)
     VALUES ($1,$2,'deal',$3,$4,'pending',0, now(), now(), now())`,
    [eventId, eventType, dealId, JSON.stringify({ deal_id: dealId })]
  );
  return eventId;
}
async function makeDue(eventId: string) {
  await pool.query(`UPDATE siton.outbox_events SET available_at=now() WHERE event_uuid=$1 AND status='pending'`, [eventId]);
}
async function expireLease(eventId: string) {
  const r = await pool.query(`UPDATE siton.outbox_events SET lease_expires_at = now() - interval '1 second' WHERE event_uuid=$1 AND status='processing'`, [eventId]);
  assert.equal(r.rowCount, 1, "exactly one owned lease must be expired");
}
async function participantState(participantId: string) {
  const r = await pool.query(`SELECT buyer_state, money_state FROM siton.participants WHERE participant_id=$1`, [participantId]);
  return r.rows[0] as { buyer_state: string; money_state: string };
}
async function dealState(dealId: string) { return String((await pool.query(`SELECT state FROM siton.deals WHERE deal_id=$1`, [dealId])).rows[0]?.state); }
async function binding(participantId: string) {
  const r = await pool.query(`SELECT authorization_id, provider_reference, expires_at, renewal_count, renewed_at, replaced_authorization_id, status, status_reason FROM siton.payment_authorization_bindings WHERE consumed_by_participant_id=$1`, [participantId]);
  return r.rows[0] as { authorization_id: string; provider_reference: string; expires_at: Date | null; renewal_count: number; renewed_at: Date | null; replaced_authorization_id: string | null; status: string; status_reason: string | null };
}
async function attempts(participantId: string, attemptType?: string) {
  const r = await pool.query(`SELECT attempt_type, correlation_id, result_class, failure_evidence, provider_reference, dispatch_state FROM siton.payment_attempts WHERE participant_id=$1 ${attemptType ? "AND attempt_type=$2" : ""} ORDER BY created_at ASC, correlation_id ASC`, attemptType ? [participantId, attemptType] : [participantId]);
  return r.rows as Array<{ attempt_type: string; correlation_id: string; result_class: string; failure_evidence: string | null; provider_reference: string | null; dispatch_state: string }>;
}
async function ledger(participantId: string) {
  const r = await pool.query(`SELECT logical_entry_type FROM siton.platform_fee_money_events WHERE participant_id=$1 ORDER BY created_at ASC`, [participantId]);
  return r.rows.map((row) => String(row.logical_entry_type));
}
async function transitions(participantId: string) {
  const r = await pool.query(`SELECT state_type, from_state, to_state, action_name FROM siton.audit_log WHERE entity_type='participant' AND entity_id=$1 AND action_name <> 'participant.join_authorize' ORDER BY created_at ASC`, [participantId]);
  return r.rows as Array<{ state_type: string; from_state: string; to_state: string; action_name: string }>;
}
async function eventStatus(eventId: string) {
  const r = await pool.query(`SELECT status, attempt_count, available_at > now() AS deferred FROM siton.outbox_events WHERE event_uuid=$1`, [eventId]);
  return r.rows[0] as { status: string; attempt_count: number; deferred: boolean };
}
async function pendingEvents(eventType: string, aggregateId: string) {
  const r = await pool.query(`SELECT event_uuid FROM siton.outbox_events WHERE event_type=$1 AND aggregate_id=$2 AND status='pending' ORDER BY created_at ASC`, [eventType, aggregateId]);
  return r.rows.map((row) => String(row.event_uuid));
}
function sign(body: Record<string, unknown>) {
  return `sha256=${createHmac("sha256", "lh-webhook-secret").update(JSON.stringify(body)).digest("hex")}`;
}
async function webhook(body: Record<string, unknown>) {
  const res = await app.inject({ method: "POST", url: "/webhooks/payments", headers: { "x-webhook-signature": sign(body) }, payload: body });
  assert.equal(res.statusCode, 200, res.body);
  return res.json() as { status?: string; duplicate?: boolean; reason?: string };
}

const longAgo = new Date(Date.now() - 53 * 24 * 3600_000); // a 7-day hold taken 60 days ago lapsed 53 days ago

try {
  // ── R1 ──────────────────────────────────────────────────────────────────
  await run("R1 declared validity lapsed 53 days before charging → renewal from the stored instrument, ONE capture on the renewed authorization, ChargedSuccess; no visible state moved on the expiry", async () => {
    provider.expiredHolds.add("auth-r1");
    const s = await seed({ suffix: "r1", dealState: "Charging", buyer_state: "ChargingAttempt", money_state: "ChargeAttempt", authorizationId: "auth-r1", expiresAt: longAgo, paymentMethodRef: "pm-r1", eventType: "charge_deal" });
    assert.equal((await participantState(s.participantId)).money_state, "ChargeAttempt", "commitment intact although the authorization lapsed weeks ago");
    const result = await processOutboxEventById(s.outboxEventId);
    assert.equal(result?.status, "sent", JSON.stringify(result));
    assert.equal(provider.ops("reauthorize").length, 1, "exactly one re-authorization request");
    assert.equal(provider.ops("capture", "auth-r1").length, 0, "the lapsed authorization was never captured");
    const captures = provider.ops("capture");
    assert.equal(captures.length, 1, "exactly one capture");
    assert.equal(captures[0]!.authorization_id, "auth-renewed-1", "capture used the renewed authorization");
    assert.equal((await participantState(s.participantId)).money_state, "ChargedSuccess");
    const b = await binding(s.participantId);
    assert.equal(b.renewal_count, 1);
    assert.equal(b.replaced_authorization_id, "auth-r1");
    assert.equal(b.authorization_id, "auth-renewed-1");
    assert.ok(b.expires_at && new Date(b.expires_at).getTime() > Date.now(), "renewed instrument carries the provider-declared validity");
    const reauth = await attempts(s.participantId, "reauthorize");
    assert.equal(reauth.length, 1); assert.equal(reauth[0]!.result_class, "success"); assert.equal(reauth[0]!.provider_reference, "auth-renewed-1");
    const captureRows = await attempts(s.participantId, "charge_start");
    assert.equal(captureRows.length, 1); assert.equal(captureRows[0]!.result_class, "success");
    assert.deepEqual(await ledger(s.participantId), ["charge"], "ONE fee-ledger charge entry");
    const moves = await transitions(s.participantId);
    assert.deepEqual(moves.map((m) => m.to_state), ["ChargedSuccess", "ChargedSuccess"], "the only transitions are the capture success — nothing moved because the authorization expired");
    assert.equal(await dealState(s.dealId), "CompletionWindow");
  });

  // ── R2 ──────────────────────────────────────────────────────────────────
  await run("R2 no declared validity, provider declines the capture as authorization_expired → exact decline recorded, renewal, ONE fresh capture identity, ONE ledger charge, never ChargeFailedRecovery", async () => {
    provider.expiredHolds.add("auth-r2");
    const s = await seed({ suffix: "r2", dealState: "Charging", buyer_state: "ChargingAttempt", money_state: "ChargeAttempt", authorizationId: "auth-r2", expiresAt: null, paymentMethodRef: "pm-r2", eventType: "charge_deal" });
    const before = provider.ops("reauthorize").length;
    const result = await processOutboxEventById(s.outboxEventId);
    assert.equal(result?.status, "sent", JSON.stringify(result));
    assert.equal(provider.ops("capture", "auth-r2").length, 1, "the original authorization was tried once (the provider is the authority on usability)");
    assert.equal(provider.ops("reauthorize").length - before, 1, "exactly one renewal");
    const renewed = provider.ops("reauthorize").at(-1)!;
    assert.equal(renewed.payment_method, "pm-r2");
    const rows = await attempts(s.participantId, "charge_start");
    assert.equal(rows.length, 2, "two capture identities: the declined original and the fresh one");
    assert.equal(rows[0]!.result_class, "permanent_fail"); assert.equal(rows[0]!.failure_evidence, "dispatch_response");
    assert.equal(rows[1]!.result_class, "success");
    assert.equal((await participantState(s.participantId)).money_state, "ChargedSuccess");
    assert.deepEqual(await ledger(s.participantId), ["charge"]);
    const moves = await transitions(s.participantId);
    assert.ok(!moves.some((m) => m.to_state === "ChargeFailedRecovery" || m.to_state === "ChargeFailedCompletion"), "an expired instrument never became a buyer charge failure");
    assert.equal((await binding(s.participantId)).renewal_count, 1);
  });

  // ── R3 ──────────────────────────────────────────────────────────────────
  await run("R3 renewal declined by the provider → capture proceeds on the original authorization → provider decline → existing recovery rules (ChargeFailedCompletion / ChargeFailedRecovery), binding not renewed", async () => {
    provider.expiredHolds.add("auth-r3");
    const s = await seed({ suffix: "r3", dealState: "Charging", buyer_state: "ChargingAttempt", money_state: "ChargeAttempt", authorizationId: "auth-r3", expiresAt: longAgo, paymentMethodRef: "pm-decline-r3", eventType: "charge_deal" });
    const result = await processOutboxEventById(s.outboxEventId);
    assert.equal(result?.status, "sent", JSON.stringify(result));
    const reauth = await attempts(s.participantId, "reauthorize");
    assert.equal(reauth.length, 1); assert.equal(reauth[0]!.result_class, "permanent_fail");
    assert.equal(provider.ops("capture", "auth-r3").length, 1, "the provider decided on the original authorization");
    const state = await participantState(s.participantId);
    assert.equal(state.buyer_state, "ChargeFailedCompletion"); assert.equal(state.money_state, "ChargeFailedRecovery");
    const b = await binding(s.participantId);
    assert.equal(b.renewal_count, 0); assert.equal(b.authorization_id, "auth-r3");
    assert.deepEqual(await ledger(s.participantId), []);
    assert.equal(await dealState(s.dealId), "CompletionWindow");
    assert.equal((await pendingEvents("recovery_deal", s.dealId)).length, 1, "the buyer gets the recovery window as before");
  });

  // ── R4 ──────────────────────────────────────────────────────────────────
  await run("R4 no stored instrument → no renewal path → provider decides on the original authorization → recovery rules; no reauthorize identity minted", async () => {
    provider.expiredHolds.add("auth-r4");
    const s = await seed({ suffix: "r4", dealState: "Charging", buyer_state: "ChargingAttempt", money_state: "ChargeAttempt", authorizationId: "auth-r4", expiresAt: longAgo, paymentMethodRef: null, eventType: "charge_deal" });
    const before = provider.ops("reauthorize").length;
    const result = await processOutboxEventById(s.outboxEventId);
    assert.equal(result?.status, "sent", JSON.stringify(result));
    assert.equal(provider.ops("reauthorize").length, before, "no renewal request without a stored instrument");
    assert.equal((await attempts(s.participantId, "reauthorize")).length, 0);
    assert.equal(provider.ops("capture", "auth-r4").length, 1);
    assert.equal((await participantState(s.participantId)).money_state, "ChargeFailedRecovery");
  });

  // ── R5 ──────────────────────────────────────────────────────────────────
  await run("R5 CRITICAL concurrency: worker A stalls after the provider created the renewed authorization, lease reclaimed, worker B re-sends the SAME identity → ONE renewed authorization, ONE capture, A resumes fenced; then a crash before the capture retries without a second renewal", async () => {
    provider.expiredHolds.add("auth-r5");
    const s = await seed({ suffix: "r5", dealState: "Charging", buyer_state: "ChargingAttempt", money_state: "ChargeAttempt", authorizationId: "auth-r5", expiresAt: longAgo, paymentMethodRef: "pm-r5", eventType: "charge_deal" });
    const renewalsBefore = provider.ops("reauthorize").length;
    const barrier = armTestFault("payment.after_provider_io", { kind: "block" });
    assert.ok(barrier);
    const runA = processOutboxEventById(s.outboxEventId);
    await barrier!.entered;
    assert.equal(provider.ops("reauthorize").length - renewalsBefore, 1, "A sent the renewal before stalling");
    const identityA = (await attempts(s.participantId, "reauthorize"))[0]!;
    assert.equal(identityA.result_class, "unknown"); assert.equal(identityA.dispatch_state, "dispatching");
    assert.equal((await binding(s.participantId)).renewal_count, 0, "nothing applied locally while A is stalled");
    assert.equal((await participantState(s.participantId)).money_state, "ChargeAttempt");

    await expireLease(s.outboxEventId);
    const reclaimed = await reclaimWorkerJobs(1);
    assert.ok(reclaimed.outbox >= 1, "expired lease reclaimed");
    const runB = await processOutboxEventById(s.outboxEventId);
    assert.equal(runB?.status, "sent", `B must complete the job: ${JSON.stringify(runB)}`);
    const renewals = provider.ops("reauthorize").slice(renewalsBefore);
    assert.equal(renewals.length, 2, "B re-sent the SAME identity (the provider replays it)");
    assert.equal(renewals[0]!.idempotency_key, renewals[1]!.idempotency_key, "one durable identity for the whole episode");
    const b = await binding(s.participantId);
    assert.equal(b.renewal_count, 1, "exactly one renewal applied");
    assert.equal(provider.ops("capture", b.authorization_id).length, 1, "exactly one capture on the renewed authorization");
    assert.equal((await participantState(s.participantId)).money_state, "ChargedSuccess");

    barrier!.release();
    const resultA = await runA;
    assert.equal(resultA?.status, "lease_lost", `stale worker must not ACK: ${JSON.stringify(resultA)}`);
    assert.equal((await attempts(s.participantId, "reauthorize")).length, 1, "ONE renewal identity");
    assert.equal(provider.ops("capture", b.authorization_id).length, 1, "A's resumption produced no capture");
    assert.deepEqual(await ledger(s.participantId), ["charge"]);
    resetTestFaults();

    // crash between the renewal commit and the capture dispatch (fresh participant)
    provider.expiredHolds.add("auth-r5b");
    const s2 = await seed({ suffix: "r5b", dealState: "Charging", buyer_state: "ChargingAttempt", money_state: "ChargeAttempt", authorizationId: "auth-r5b", expiresAt: longAgo, paymentMethodRef: "pm-r5b", eventType: "charge_deal" });
    const beforeRenewals = provider.ops("reauthorize").length;
    const stall = armTestFault("payment.after_provider_io", { kind: "block" });
    const first = processOutboxEventById(s2.outboxEventId);
    await stall!.entered; // the renewal answer is in hand; the capture has not been dispatched
    armTestFault("payment.before_provider_io", { kind: "throw", code: "crash_before_capture" });
    stall!.release();
    const crashed = await first;
    assert.notEqual(crashed?.status, "sent", `the job must not ACK after the injected crash: ${JSON.stringify(crashed)}`);
    resetTestFaults();
    const renewedS2 = await binding(s2.participantId);
    assert.equal(renewedS2.renewal_count, 1, "the renewal committed atomically with its identity before the crash");
    assert.equal(provider.ops("capture", renewedS2.authorization_id).length, 0, "no capture was dispatched before the crash");
    await makeDue(s2.outboxEventId);
    const retry = await processOutboxEventById(s2.outboxEventId);
    assert.equal(retry?.status, "sent", JSON.stringify(retry));
    assert.equal(provider.ops("reauthorize").length - beforeRenewals, 1, "retry after the crash did NOT renew again");
    assert.equal(provider.ops("capture", (await binding(s2.participantId)).authorization_id).length, 1, "exactly one capture after the retry");
    assert.equal((await participantState(s2.participantId)).money_state, "ChargedSuccess");
    assert.deepEqual(await ledger(s2.participantId), ["charge"]);
  });

  // ── R6 ──────────────────────────────────────────────────────────────────
  await run("R6 renewal pending at the provider → identity UNKNOWN, job deferred, NO visible state change; reconcile proves authorized → renewal applied and the charge job re-queued → capture", async () => {
    provider.expiredHolds.add("auth-r6");
    const s = await seed({ suffix: "r6", dealState: "Charging", buyer_state: "ChargingAttempt", money_state: "ChargeAttempt", authorizationId: "auth-r6", expiresAt: longAgo, paymentMethodRef: "pm-pending-r6", eventType: "charge_deal" });
    const result = await processOutboxEventById(s.outboxEventId);
    assert.equal(result?.status, "failed", `deferred while the renewal is pending: ${JSON.stringify(result)}`);
    const st = await eventStatus(s.outboxEventId);
    assert.equal(st.status, "pending"); assert.equal(st.deferred, true);
    const reauth = await attempts(s.participantId, "reauthorize");
    assert.equal(reauth.length, 1); assert.equal(reauth[0]!.result_class, "unknown");
    assert.equal((await participantState(s.participantId)).money_state, "ChargeAttempt", "UNKNOWN never mutates visible state");
    assert.equal(await dealState(s.dealId), "Charging");
    assert.equal((await binding(s.participantId)).renewal_count, 0);
    assert.equal(provider.ops("capture").filter((c) => c.authorization_id === reauth[0]!.provider_reference).length, 0, "no capture on an unconfirmed authorization");
    const reconcile = await pool.query(`SELECT event_uuid, payload FROM siton.outbox_events WHERE event_type='payment_reconcile' AND aggregate_id=$1 AND status='pending'`, [s.participantId]);
    assert.equal(reconcile.rowCount, 1, "a reconcile is live for the pending renewal");
    assert.equal(String(reconcile.rows[0].payload.operation), "authorization");
    // the provider confirms the pending renewal
    provider.confirmRenewal(String(reauth[0]!.provider_reference));
    const reconciled = await processOutboxEventById(String(reconcile.rows[0].event_uuid));
    assert.equal(reconciled?.status, "sent", JSON.stringify(reconciled));
    const b = await binding(s.participantId);
    assert.equal(b.renewal_count, 1); assert.equal(b.authorization_id, reauth[0]!.provider_reference);
    assert.equal((await attempts(s.participantId, "reauthorize"))[0]!.result_class, "success");
    assert.equal((await participantState(s.participantId)).money_state, "ChargeAttempt", "the renewal itself moves no participant state");
    // the deferred charge job (or the re-queued one) captures on the renewed authorization
    const charge = (await pendingEvents("charge_deal", s.dealId))[0]!;
    await makeDue(charge);
    const captured = await processOutboxEventById(charge);
    assert.equal(captured?.status, "sent", JSON.stringify(captured));
    assert.equal(provider.ops("capture", b.authorization_id).length, 1);
    assert.equal((await participantState(s.participantId)).money_state, "ChargedSuccess");
    assert.equal((await attempts(s.participantId, "reauthorize")).length, 1, "still ONE renewal identity");
    assert.deepEqual(await ledger(s.participantId), ["charge"]);
  });

  // ── R7 ──────────────────────────────────────────────────────────────────
  await run("R7 late and duplicate charge_captured webhooks after a renewed capture are ignored: zero extra state, audit or ledger effect", async () => {
    provider.expiredHolds.add("auth-r7");
    const s = await seed({ suffix: "r7", dealState: "Charging", buyer_state: "ChargingAttempt", money_state: "ChargeAttempt", authorizationId: "auth-r7", expiresAt: longAgo, paymentMethodRef: "pm-r7", eventType: "charge_deal" });
    assert.equal((await processOutboxEventById(s.outboxEventId))?.status, "sent");
    const b = await binding(s.participantId);
    const movesBefore = (await transitions(s.participantId)).length;
    const lateOld = { provider: "payrail-http", event_id: `late-old-${randomUUID()}`, event_type: "charge_captured", correlation_id: `capture:late:${s.participantId}`, participant_id: s.participantId, deal_id: s.dealId, provider_reference: "cap-auth-r7", payload: { provider_reference: "cap-auth-r7" } };
    assert.equal((await webhook(lateOld)).status, "ignored", "a late event naming the OLD authorization moves nothing");
    const captureRow = (await attempts(s.participantId, "charge_start"))[0]!;
    const dupNew = { provider: "payrail-http", event_id: `dup-new-${randomUUID()}`, event_type: "charge_captured", correlation_id: captureRow.correlation_id, participant_id: s.participantId, deal_id: s.dealId, provider_reference: `cap-${b.authorization_id}`, payload: {} };
    assert.equal((await webhook(dupNew)).status, "ignored", "a duplicate of the renewed capture is ignored");
    const again = await webhook(dupNew);
    assert.equal(again.duplicate, true);
    assert.equal((await transitions(s.participantId)).length, movesBefore);
    assert.deepEqual(await ledger(s.participantId), ["charge"]);
    assert.equal((await participantState(s.participantId)).money_state, "ChargedSuccess");
  });

  // ── R8 ──────────────────────────────────────────────────────────────────
  await run("R8 recovery rail: the original capture was declined on an authorization that later lapsed → renewal before the recovery capture → RecoveredCharge, ONE ledger charge", async () => {
    provider.expiredHolds.add("auth-r8");
    const windowUntil = new Date(Date.now() + 60 * 60_000);
    const s = await seed({ suffix: "r8", dealState: "CompletionWindow", buyer_state: "ChargeFailedCompletion", money_state: "ChargeFailedRecovery", authorizationId: "auth-r8", expiresAt: longAgo, paymentMethodRef: "pm-r8", eventType: "recovery_deal", completionWindowUntil: windowUntil, priorCaptureDeclined: true });
    const result = await processOutboxEventById(s.outboxEventId);
    assert.equal(result?.status, "sent", JSON.stringify(result));
    const b = await binding(s.participantId);
    assert.equal(b.renewal_count, 1);
    assert.equal(provider.ops("recover", b.authorization_id).length, 1, "one recovery capture on the renewed authorization");
    assert.equal(provider.ops("recover", "auth-r8").length, 0);
    const state = await participantState(s.participantId);
    assert.equal(state.money_state, "RecoveredCharge"); assert.equal(state.buyer_state, "Recovered");
    assert.deepEqual(await ledger(s.participantId), ["charge"]);
  });

  // ── R9 ──────────────────────────────────────────────────────────────────
  await run("R9 DB guard (071): while a renewal identity is unresolved no capture / recovery / release identity may be minted, and no second renewal identity; a completed renewal never blocks a later one", async () => {
    const s = await seed({ suffix: "r9", dealState: "Charging", buyer_state: "ChargingAttempt", money_state: "ChargeAttempt", authorizationId: "auth-r9", expiresAt: longAgo, paymentMethodRef: "pm-r9", eventType: null });
    await pool.query(`INSERT INTO siton.payment_attempts (participant_id, deal_id, attempt_type, result_class, correlation_id, dispatch_state) VALUES ($1,$2,'reauthorize','unknown',$3,'responded')`, [s.participantId, s.dealId, `reauth:seed:n1:${s.participantId}`]);
    for (const type of ["charge_start", "recovery", "release"]) {
      await assert.rejects(
        pool.query(`INSERT INTO siton.payment_attempts (participant_id, deal_id, attempt_type, result_class, correlation_id, dispatch_state) VALUES ($1,$2,$3,'unknown',$4,'recorded')`, [s.participantId, s.dealId, type, `${type}:seed:n1:${s.participantId}`]),
        (error: any) => String(error?.code) === "SN409" && /unresolved_reauthorization/.test(String(error?.message)),
        `${type} must be refused while a renewal is unresolved`
      );
    }
    await assert.rejects(
      pool.query(`INSERT INTO siton.payment_attempts (participant_id, deal_id, attempt_type, result_class, correlation_id, dispatch_state) VALUES ($1,$2,'reauthorize','unknown',$3,'recorded')`, [s.participantId, s.dealId, `reauth:seed:n2:${s.participantId}`]),
      (error: any) => String(error?.code) === "SN409" && /reauthorization_identity_rotation_blocked/.test(String(error?.message))
    );
    await pool.query(`UPDATE siton.payment_attempts SET result_class='success', provider_reference='auth-renewed-x' WHERE participant_id=$1 AND attempt_type='reauthorize'`, [s.participantId]);
    await pool.query(`INSERT INTO siton.payment_attempts (participant_id, deal_id, attempt_type, result_class, correlation_id, dispatch_state) VALUES ($1,$2,'reauthorize','unknown',$3,'recorded')`, [s.participantId, s.dealId, `reauth:seed:n2:${s.participantId}`]);
    assert.equal((await attempts(s.participantId, "reauthorize")).length, 2, "a completed renewal does not block a later renewal of a very long deal");
  });

  // ── R10 ─────────────────────────────────────────────────────────────────
  await run("R10 90% threshold and completion window unchanged: the renewed capture counts toward the threshold and finalize completes the deal", async () => {
    provider.expiredHolds.add("auth-r10");
    // R1's deal opened a 24 h window (C6 unchanged); this deal is seeded with a
    // short window (the column is immutable once set) so finalize can run now.
    const r1Window = await pool.query(`SELECT (completion_window_until - now()) > interval '23 hours' AS about_a_day FROM siton.deals WHERE state='CompletionWindow' AND title='LH r1'`);
    assert.equal(r1Window.rows[0]?.about_a_day, true, "completion window still 24 h (C6)");
    const s = await seed({ suffix: "r10", dealState: "Charging", buyer_state: "ChargingAttempt", money_state: "ChargeAttempt", authorizationId: "auth-r10", expiresAt: longAgo, paymentMethodRef: "pm-r10", eventType: "charge_deal", completionWindowUntil: new Date(Date.now() + 1500) });
    assert.equal((await processOutboxEventById(s.outboxEventId))?.status, "sent");
    assert.equal(await dealState(s.dealId), "CompletionWindow");
    await new Promise((resolve) => setTimeout(resolve, 1700));
    const finalize = (await pendingEvents("finalize_deal", s.dealId))[0]!;
    await makeDue(finalize);
    const finalized = await processOutboxEventById(finalize);
    assert.equal(finalized?.status, "sent", JSON.stringify(finalized));
    assert.equal(await dealState(s.dealId), "Completed");
    assert.equal((await participantState(s.participantId)).buyer_state, "DealCompleted");
  });

  console.log(`SUMMARY passed=${passed} failed=0`);
} finally {
  resetTestFaults();
  await app.close().catch(() => undefined);
  await closeWorkerDatabase().catch(() => undefined);
  await pool.end();
  await provider.close();
}
