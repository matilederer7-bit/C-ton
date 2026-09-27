// Black-Sky A-F2 — a recovery capture may be dispatched ONLY while the deal is
// in CompletionWindow and its window is open, judged at the arm (the last step
// before provider I/O) under the deal row lock; and the terminal finalize
// decision is taken under the deal row lock, re-validated in that transaction.
//
// Before the fix the recovery rail read the deal state/window ONCE at the start
// of the job: a job that was slow (or blocked) past the window end — or past a
// terminal decision — still sent the recovery capture. And finalize decided on
// captured units read outside any lock, so a capture that became canonical while
// the decision was waiting on the deal row was refunded as a "failed deal".
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import pg from "pg";

process.env.PORT = "3191";
process.env.APP_DEPLOYMENT_MODE = "internal-runtime";
process.env.SELLER_SESSION_SECRET = "seller-session-secret-af2";
process.env.SELLER_AUTH_CREDENTIALS = JSON.stringify([{ seller_id: "seller-alpha", display_name: "Seller Alpha", access_code: "alpha-code" }]);
process.env.PAYMENT_PROVIDER = "payrail-http";
process.env.PAYMENT_PROVIDER_MODE = "provider-ready";
process.env.PAYMENT_PROVIDER_API_KEY = "live-provider-key";
process.env.PAYMENT_PROVIDER_AUTH_PATH = "/authorize";
process.env.PAYMENT_PROVIDER_CAPTURE_PATH = "/capture";
process.env.PAYMENT_PROVIDER_RECOVERY_PATH = "/recover";
process.env.PAYMENT_PROVIDER_TIMEOUT_MS = "500";
process.env.OUTBOX_POLL_MS = "60000";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.PAYMENT_WEBHOOK_PROVIDER = "payrail-http";
process.env.PAYMENT_WEBHOOK_SECRET = "live-webhook-secret-af2";

const calls: Array<{ url: string; body: any }> = [];
const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
  req.on("end", () => {
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    calls.push({ url: String(req.url || ""), body });
    res.setHeader("content-type", "application/json");
    if (req.url && req.url.startsWith("/status/")) {
      const reference = decodeURIComponent(req.url.split("/status/")[1]!.split("?")[0]!);
      res.end(JSON.stringify({ state: "authorized", final: true, provider_reference: reference }));
      return;
    }
    if (req.url === "/recover") {
      res.end(JSON.stringify({ status: "recovered", provider_reference: `rec-${body.authorization_id}`, reference: body.reference }));
      return;
    }
    if (req.url === "/release") {
      res.end(JSON.stringify({ ok: true, status: "released", provider_reference: String(body.authorization_id || ""), reference: body.reference }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not_found" }));
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
const address = server.address();
if (!address || typeof address === "string") throw new Error("provider stub has no port");
process.env.PAYMENT_PROVIDER_BASE_URL = `http://127.0.0.1:${address.port}`;

const { processOutboxEventById } = await import(`../src/app.js?af2-${Date.now()}`);
const { armTestFault, resetTestFaults } = await import("../src/fault_injection.js");
const { forcedDealStep, forcedParticipantStep } = await import("./helpers/forced_state.js");

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

let failures = 0;
async function runTest(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}`);
    console.error(error);
  } finally {
    resetTestFaults();
  }
}

async function seedDeal(args: { windowUntil: Date; participantState: "recovery" | "failed_charge"; authorizationId: string }) {
  const dealId = randomUUID();
  const participantId = randomUUID();
  await pool.query(
    `INSERT INTO siton.deals (deal_id, title, price_per_unit, min_units, max_units, threshold_units, deadline, state, published_at, created_at, completion_window_until, seller_id)
     VALUES ($1,$2,42,10,20,9,$3,'CompletionWindow', now(), now(), $4, 'seller-alpha')`,
    [dealId, `A-F2 ${dealId.slice(0, 8)}`, new Date(Date.now() - 60 * 60_000).toISOString(), args.windowUntil.toISOString()]
  );
  await pool.query(
    `INSERT INTO siton.participants (participant_id, deal_id, buyer_id, qty, buyer_state, money_state, delivery_cost, created_at)
     VALUES ($1,$2,$3,10,'ChargeFailedCompletion','ChargeFailedRecovery',0, now())`,
    [participantId, dealId, `buyer-${participantId.slice(0, 8)}`]
  );
  await pool.query(
    `INSERT INTO siton.audit_log (entity_type, entity_id, deal_id, state_type, from_state, to_state, action_name, request_id, idempotency_key, payload)
     VALUES ('participant',$1,$2,'buyer_state','NotJoined','JoinedAuthorized','participant.join_authorize',$3,$3,$4)`,
    [participantId, dealId, `seed:${participantId}`, JSON.stringify({ authorization: "provider_authorized", authorization_id: args.authorizationId, authorization_provider: "payrail-http" })]
  );
  return { dealId, participantId };
}

async function enqueue(eventType: string, dealId: string) {
  const eventId = randomUUID();
  await pool.query(
    `INSERT INTO siton.outbox_events (event_uuid, event_type, aggregate_type, aggregate_id, payload, status, attempt_count, available_at, created_at, updated_at)
     VALUES ($1,$2,'deal',$3,$4,'pending',0, now(), now(), now())`,
    [eventId, eventType, dealId, JSON.stringify({ deal_id: dealId })]
  );
  return eventId;
}

async function participantState(participantId: string) {
  const r = await pool.query(`SELECT buyer_state, money_state FROM siton.participants WHERE participant_id=$1`, [participantId]);
  return r.rows[0] as { buyer_state: string; money_state: string };
}

async function recoveryAttempts(participantId: string) {
  const r = await pool.query(
    `SELECT result_class, dispatch_state, dispatched_at, outcome_note FROM siton.payment_attempts WHERE participant_id=$1 AND attempt_type='recovery'`,
    [participantId]
  );
  return r.rows as Array<{ result_class: string; dispatch_state: string; dispatched_at: string | null; outcome_note: string | null }>;
}

async function waitForLockWait(timeoutMs = 10_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const r = await pool.query(
      `SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`
    );
    if (Number(r.rows[0]?.n || 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("finalize never waited on the deal row lock");
}

await runTest("recovery job that reaches the arm AFTER the completion window ended sends NO recovery capture", async () => {
  const authorizationId = `auth-af2-window-${randomUUID().slice(0, 8)}`;
  // completion_window_until is immutable once set (DB guard): use a short real
  // window and let it elapse while the job is held before provider I/O.
  const windowUntil = new Date(Date.now() + 3_000);
  const seeded = await seedDeal({ windowUntil, participantState: "recovery", authorizationId });
  const eventId = await enqueue("recovery_deal", seeded.dealId);
  const barrier = armTestFault("payment.before_provider_io", { kind: "block" })!;
  const processing = processOutboxEventById(eventId);
  await barrier.entered;
  // The job passed its (only) window read while the window was open; the
  // window now ends before it reaches the provider.
  const open = await pool.query(`SELECT clock_timestamp() < completion_window_until AS open FROM siton.deals WHERE deal_id=$1`, [seeded.dealId]);
  assert.equal(open.rows[0]?.open, true, "precondition: the job entered the rail inside the window");
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, windowUntil.getTime() - Date.now()) + 300));
  barrier.release();
  await processing;
  assert.equal(calls.filter((call) => call.url === "/recover" && call.body?.authorization_id === authorizationId).length, 0, "no recovery capture may reach the provider after the window");
  assert.deepEqual(await participantState(seeded.participantId), { buyer_state: "ChargeFailedCompletion", money_state: "ChargeFailedRecovery" });
  const attempts = await recoveryAttempts(seeded.participantId);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0]!.dispatched_at, null, "the minted identity was never dispatched");
  assert.notEqual(attempts[0]!.result_class, "unknown", "the never-dispatched identity is retired, not left UNKNOWN");
  assert.match(String(attempts[0]!.outcome_note || ""), /deal_phase_closed/);
});

await runTest("recovery job that reaches the arm after the deal was FAILED sends NO recovery capture", async () => {
  const authorizationId = `auth-af2-failed-${randomUUID().slice(0, 8)}`;
  const seeded = await seedDeal({ windowUntil: new Date(Date.now() + 30 * 60_000), participantState: "recovery", authorizationId });
  const eventId = await enqueue("recovery_deal", seeded.dealId);
  const barrier = armTestFault("payment.before_provider_io", { kind: "block" })!;
  const processing = processOutboxEventById(eventId);
  await barrier.entered;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await forcedDealStep(client, seeded.dealId, "Failed", "charging.finalize_failed");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  barrier.release();
  await processing;
  assert.equal(calls.filter((call) => call.url === "/recover" && call.body?.authorization_id === authorizationId).length, 0, "no recovery capture on a Failed deal");
  const attempts = await recoveryAttempts(seeded.participantId);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0]!.dispatched_at, null);
  assert.notEqual(attempts[0]!.result_class, "unknown");
});

await runTest("negative control: a recovery inside an open window of a CompletionWindow deal is still dispatched", async () => {
  const authorizationId = `auth-af2-open-${randomUUID().slice(0, 8)}`;
  const seeded = await seedDeal({ windowUntil: new Date(Date.now() + 30 * 60_000), participantState: "recovery", authorizationId });
  const eventId = await enqueue("recovery_deal", seeded.dealId);
  const processed = await processOutboxEventById(eventId);
  assert.equal(processed?.status, "sent");
  assert.equal(calls.filter((call) => call.url === "/recover" && call.body?.authorization_id === authorizationId).length, 1);
  assert.deepEqual(await participantState(seeded.participantId), { buyer_state: "Recovered", money_state: "RecoveredCharge" });
});

await runTest("finalize decides under the deal row lock: a capture that became canonical while it waited flips the decision -> deferred, never Failed+refund", async () => {
  const seeded = await seedDeal({ windowUntil: new Date(Date.now() - 60_000), participantState: "recovery", authorizationId: `auth-af2-fin-${randomUUID().slice(0, 8)}` });
  const eventId = await enqueue("finalize_deal", seeded.dealId);
  // A concurrent money writer holds the deal row (as an arm does, FOR SHARE).
  const holder = await pool.connect();
  let finalizing: Promise<any> | null = null;
  try {
    await holder.query("BEGIN");
    await holder.query(`SELECT deal_id FROM siton.deals WHERE deal_id=$1 FOR SHARE`, [seeded.dealId]);
    finalizing = processOutboxEventById(eventId);
    await waitForLockWait();
    // While finalize waits, the participant's recovery becomes canonical: the
    // provisional "0 captured -> Failed" is now false.
    await forcedParticipantStep(holder, seeded.participantId, { buyer_state: "Recovered", money_state: "RecoveredCharge" }, "charging.recovery_success");
    await holder.query("COMMIT");
  } catch (error) {
    await holder.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    holder.release();
  }
  await finalizing;
  const deal = await pool.query(`SELECT state FROM siton.deals WHERE deal_id=$1`, [seeded.dealId]);
  assert.equal(deal.rows[0]?.state, "CompletionWindow", "the stale Failed decision must not commit");
  const refunds = await pool.query(`SELECT count(*)::int AS n FROM siton.outbox_events WHERE event_type='refund_issue' AND aggregate_id=$1`, [seeded.dealId]);
  assert.equal(refunds.rows[0]?.n, 0, "no refund job for a recovered participant on a stale decision");
  assert.deepEqual(await participantState(seeded.participantId), { buyer_state: "Recovered", money_state: "RecoveredCharge" });

  // Second attack / convergence: the next finalize run decides on the truth.
  await pool.query(`UPDATE siton.outbox_events SET available_at = now() WHERE event_uuid=$1`, [eventId]);
  const again = await processOutboxEventById(eventId);
  assert.equal(again?.status, "sent");
  const decided = await pool.query(`SELECT state FROM siton.deals WHERE deal_id=$1`, [seeded.dealId]);
  assert.equal(decided.rows[0]?.state, "Completed");
});

await pool.end();
await new Promise<void>((resolve) => server.close(() => resolve()));
await new Promise((resolve) => setTimeout(resolve, 300));
process.exit(failures ? 1 : 0);
