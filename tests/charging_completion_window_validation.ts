import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import "dotenv/config";

process.env.PORT = "3093";
process.env.APP_DEPLOYMENT_MODE = "internal-runtime";
process.env.SELLER_SESSION_SECRET = "seller-session-secret-wave3";
process.env.SELLER_AUTH_CREDENTIALS = JSON.stringify([
  { seller_id: "seller-alpha", display_name: "Seller Alpha", access_code: "alpha-code" }
]);
process.env.PAYMENT_PROVIDER = "payrail-http";
process.env.PAYMENT_PROVIDER_MODE = "provider-ready";
process.env.PAYMENT_PROVIDER_API_KEY = "live-provider-key";
process.env.PAYMENT_PROVIDER_AUTH_PATH = "/authorize";
process.env.PAYMENT_PROVIDER_CAPTURE_PATH = "/capture";
process.env.PAYMENT_PROVIDER_RECOVERY_PATH = "/recover";
process.env.PAYMENT_PROVIDER_TIMEOUT_MS = "150";
process.env.OUTBOX_POLL_MS = "60000";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.PAYMENT_WEBHOOK_PROVIDER = "payrail-http";
process.env.PAYMENT_WEBHOOK_SECRET = "wave3-webhook-secret";

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton"
});

const bootstrapSql = (await readFile("src/migrations/014_demo_preview_bootstrap.sql", "utf8")).replace(/^\uFEFF/, "");
const outboxSql = (await readFile("src/migrations/009_db_enforcement_phase2c.sql", "utf8")).replace(/^\uFEFF/, "");
await pool.query(bootstrapSql);
await pool.query(outboxSql);

async function runTest(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

async function expectTxFailure(name: string, fn: (client: pg.PoolClient) => Promise<void>, pattern: RegExp) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let threw = false;
    try {
      await fn(client);
    } catch (error: any) {
      threw = true;
      assert.match(String(error?.message || error), pattern, name);
    }
    assert.equal(threw, true, `${name} should fail`);
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }
}

async function startProviderStub() {
  const captureCalls: Array<any> = [];
  const recoveryCalls: Array<any> = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on("end", async () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};

      if (req.url === "/capture") {
        captureCalls.push(body);
        const authorizationId = String(body.authorization_id || "");
        if (authorizationId.includes("timeout")) {
          await new Promise((resolve) => setTimeout(resolve, 400));
        }
        res.setHeader("content-type", "application/json");
        if (authorizationId.includes("fail")) {
          res.statusCode = 402;
          res.end(
            JSON.stringify({
              status: "failed",
              error: "capture_declined",
              provider_reference: `cap-${authorizationId}`,
              reference: body.reference
            })
          );
          return;
        }
        if (authorizationId.includes("missingevt")) {
          res.statusCode = 200;
          res.end(
            JSON.stringify({
              status: "accepted_but_weird",
              provider_reference: `cap-${authorizationId}`,
              reference: body.reference
            })
          );
          return;
        }
        res.statusCode = 200;
        res.end(
          JSON.stringify({
            status: "captured",
            capture_id: `cap-${authorizationId}`,
            provider_reference: `cap-${authorizationId}`,
            reference: body.reference
          })
        );
        return;
      }

      if (req.url === "/recover") {
        recoveryCalls.push(body);
        const authorizationId = String(body.authorization_id || "");
        if (authorizationId.includes("timeout")) {
          await new Promise((resolve) => setTimeout(resolve, 400));
        }
        res.setHeader("content-type", "application/json");
        if (authorizationId.includes("fail")) {
          res.statusCode = 402;
          res.end(
            JSON.stringify({
              status: "failed",
              error: "recovery_declined",
              provider_reference: `rec-${authorizationId}`,
              reference: body.reference
            })
          );
          return;
        }
        if (authorizationId.includes("missingevt")) {
          res.statusCode = 200;
          res.end(
            JSON.stringify({
              status: "accepted_but_weird",
              provider_reference: `rec-${authorizationId}`,
              reference: body.reference
            })
          );
          return;
        }
        res.statusCode = 200;
        res.end(
          JSON.stringify({
            status: "recovered",
            recovery_id: `rec-${authorizationId}`,
            provider_reference: `rec-${authorizationId}`,
            reference: body.reference
          })
        );
        return;
      }

      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not_found" }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("provider stub did not expose a TCP port");
  return {
    captureCalls,
    recoveryCalls,
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  };
}

const provider = await startProviderStub();
process.env.PAYMENT_PROVIDER_BASE_URL = provider.baseUrl;

const { app, processOutboxEventById } = await import(`../src/app.js?wave3-${Date.now()}`);

async function fetchOne<T = any>(sql: string, params: unknown[] = []) {
  const result = await pool.query(sql, params);
  return result.rows[0] as T | undefined;
}

async function fetchAll<T = any>(sql: string, params: unknown[] = []) {
  const result = await pool.query(sql, params);
  return result.rows as T[];
}

async function post(url: string, requestId: string, payload: Record<string, unknown> = {}) {
  return app.inject({
    method: "POST",
    url,
    headers: {
      "x-request-id": requestId,
      "idempotency-key": requestId
    },
    payload
  });
}

async function insertJoinAudit(participantId: string, dealId: string, authorizationId: string, suffix: string) {
  await pool.query(
    `INSERT INTO siton.audit_log (
       entity_type, entity_id, deal_id, state_type, from_state, to_state, action_name, request_id, idempotency_key, payload
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      "participant",
      participantId,
      dealId,
      "buyer_state",
      "NotJoined",
      "JoinedAuthorized",
      "participant.join_authorize",
      `seed:${suffix}`,
      `seed-join:${suffix}:${Date.now()}`,
      JSON.stringify({
        authorization: "provider_authorized",
        authorization_id: authorizationId,
        authorization_provider: "payrail-http",
        authorization_correlation_id: `payauth-${suffix}`
      })
    ]
  );
}

async function seedReadyForChargingDeal(suffix: string) {
  const dealId = randomUUID();
  const participantId = randomUUID();
  await pool.query(
    `INSERT INTO siton.deals (
       deal_id, seller_id, state, title, price_per_unit, min_units, max_units, threshold_units, deadline, published_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())`,
    [dealId, "seller-alpha", "ReadyForCharging", `Wave3 Start ${suffix}`, 42, 10, 20, 9, new Date(Date.now() + 30 * 60_000).toISOString()]
  );
  await pool.query(
    `INSERT INTO siton.participants (
       participant_id, deal_id, buyer_id, qty, buyer_state, money_state, delivery_cost, locked_at, created_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7, now(), now())`,
    [participantId, dealId, `buyer-${suffix}`, 10, "LockedIn", "AuthLocked", 0]
  );
  return { dealId, participantId };
}

async function seedChargingDeal(args: {
  suffix: string;
  participants: Array<{ qty: number; authorizationId: string }>;
  thresholdUnits?: number;
}) {
  const dealId = randomUUID();
  await pool.query(
    `INSERT INTO siton.deals (
       deal_id, seller_id, state, title, price_per_unit, min_units, max_units, threshold_units, deadline, published_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())`,
    [
      dealId,
      "seller-alpha",
      "Charging",
      `Wave3 Charge ${args.suffix}`,
      42,
      10,
      50,
      args.thresholdUnits ?? 9,
      new Date(Date.now() + 30 * 60_000).toISOString()
    ]
  );

  const seededParticipants: Array<{ participantId: string; authorizationId: string; qty: number }> = [];
  for (const participant of args.participants) {
    const participantId = randomUUID();
    await pool.query(
      `INSERT INTO siton.participants (
         participant_id, deal_id, buyer_id, qty, buyer_state, money_state, delivery_cost, created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7, now())`,
      [participantId, dealId, `buyer-${args.suffix}-${participant.qty}`, participant.qty, "ChargingAttempt", "ChargeAttempt", 0]
    );
    await insertJoinAudit(participantId, dealId, participant.authorizationId, `${args.suffix}-${participant.authorizationId}`);
    seededParticipants.push({ participantId, authorizationId: participant.authorizationId, qty: participant.qty });
  }

  const outboxEventId = randomUUID();
  await pool.query(
    `INSERT INTO siton.outbox_events (
       event_uuid, event_type, aggregate_type, aggregate_id, payload, status, attempt_count, available_at, created_at, updated_at
     ) VALUES ($1,'charge_deal','deal',$2,$3,'pending',0, now(), now(), now())`,
    [outboxEventId, dealId, JSON.stringify({ deal_id: dealId })]
  );

  return { dealId, outboxEventId, participants: seededParticipants };
}

async function seedRecoveryDeal(args: {
  suffix: string;
  authorizationId?: string;
  dealState: string;
  withinWindow: boolean;
  participantState?: { buyer_state: string; money_state: string } | null;
}) {
  const dealId = randomUUID();
  const completionWindowUntil = args.withinWindow
    ? new Date(Date.now() + 20 * 60_000).toISOString()
    : new Date(Date.now() - 2 * 60_000).toISOString();

  await pool.query(
    `INSERT INTO siton.deals (
       deal_id, seller_id, state, title, price_per_unit, min_units, max_units, threshold_units, deadline, published_at, completion_window_until
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now(), $10)`,
    [
      dealId,
      "seller-alpha",
      args.dealState,
      `Wave3 Recovery ${args.suffix}`,
      42,
      10,
      20,
      9,
      new Date(Date.now() + 30 * 60_000).toISOString(),
      completionWindowUntil
    ]
  );

  let participantId: string | null = null;
  if (args.participantState) {
    participantId = randomUUID();
    await pool.query(
      `INSERT INTO siton.participants (
         participant_id, deal_id, buyer_id, qty, buyer_state, money_state, delivery_cost, created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7, now())`,
      [participantId, dealId, `buyer-${args.suffix}`, 10, args.participantState.buyer_state, args.participantState.money_state, 0]
    );
    await insertJoinAudit(participantId, dealId, args.authorizationId || `auth-${args.suffix}`, `${args.suffix}-recovery`);
  }

  const outboxEventId = randomUUID();
  await pool.query(
    `INSERT INTO siton.outbox_events (
       event_uuid, event_type, aggregate_type, aggregate_id, payload, status, attempt_count, available_at, created_at, updated_at
     ) VALUES ($1,'recovery_deal','deal',$2,$3,'pending',0, now(), now(), now())`,
    [outboxEventId, dealId, JSON.stringify({ deal_id: dealId })]
  );

  return { dealId, participantId, outboxEventId };
}

async function seedFinalizeDeal(args: {
  suffix: string;
  minUnits: number;
  thresholdUnits: number;
  completionMode: "future" | "past" | "now";
  participants: Array<{ qty: number; buyer_state: string; money_state: string }>;
}) {
  const dealId = randomUUID();
  const completionWindowUntil =
    args.completionMode === "future"
      ? new Date(Date.now() + 20 * 60_000).toISOString()
      : args.completionMode === "past"
        ? new Date(Date.now() - 2 * 60_000).toISOString()
        : new Date().toISOString();

  await pool.query(
    `INSERT INTO siton.deals (
       deal_id, seller_id, state, title, price_per_unit, min_units, max_units, threshold_units, deadline, published_at, completion_window_until
     ) VALUES ($1,$2,'CompletionWindow',$3,$4,$5,$6,$7,$8, now(), $9)`,
    [
      dealId,
      "seller-alpha",
      `Wave3 Finalize ${args.suffix}`,
      42,
      args.minUnits,
      Math.max(args.minUnits, 200),
      args.thresholdUnits,
      new Date(Date.now() + 60 * 60_000).toISOString(),
      completionWindowUntil
    ]
  );

  const participantIds: string[] = [];
  for (const participant of args.participants) {
    const participantId = randomUUID();
    participantIds.push(participantId);
    await pool.query(
      `INSERT INTO siton.participants (
         participant_id, deal_id, buyer_id, qty, buyer_state, money_state, delivery_cost, created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7, now())`,
      [participantId, dealId, `buyer-${args.suffix}-${participantIds.length}`, participant.qty, participant.buyer_state, participant.money_state, 0]
    );
  }

  const outboxEventId = randomUUID();
  await pool.query(
    `INSERT INTO siton.outbox_events (
       event_uuid, event_type, aggregate_type, aggregate_id, payload, status, attempt_count, available_at, created_at, updated_at
     ) VALUES ($1,'finalize_deal','deal',$2,$3,'pending',0, now(), now(), now())`,
    [outboxEventId, dealId, JSON.stringify({ deal_id: dealId })]
  );

  return { dealId, outboxEventId, participantIds };
}

await runTest("charging.start rejects replay on wrong state and keeps one charge outbox", async () => {
  const seeded = await seedReadyForChargingDeal("duplicate-start");

  const first = await post(`/deals/${seeded.dealId}/charging/start`, `wave3-start-1-${Date.now()}`);
  assert.equal(first.statusCode, 200);

  const second = await post(`/deals/${seeded.dealId}/charging/start`, `wave3-start-2-${Date.now()}`);
  assert.equal(second.statusCode, 409);

  const deal = await fetchOne<{ state: string }>(`SELECT state FROM siton.deals WHERE deal_id=$1`, [seeded.dealId]);
  const outboxRows = await fetchAll<{ event_type: string }>(
    `SELECT event_type FROM siton.outbox_events WHERE aggregate_id=$1 AND event_type='charge_deal'`,
    [seeded.dealId]
  );
  const auditRows = await fetchAll<{ state_type: string }>(
    `SELECT state_type FROM siton.audit_log WHERE deal_id=$1 AND action_name='charging.start' ORDER BY created_at ASC`,
    [seeded.dealId]
  );

  assert.equal(deal?.state, "Charging");
  assert.equal(outboxRows.length, 1);
  assert.equal(auditRows.length, 3);
});

await runTest("charge_deal mixed outcome records attempts, opens completion window once, and enqueues finalize plus recovery atomically", async () => {
  const charging = await seedChargingDeal({
    suffix: "mixed",
    participants: [
      { qty: 6, authorizationId: "auth-capture-success-1" },
      { qty: 4, authorizationId: "auth-capture-fail-1" }
    ],
    thresholdUnits: 9
  });

  const processed = await processOutboxEventById(charging.outboxEventId);
  assert.equal(processed?.status, "sent");

  const deal = await fetchOne<{ state: string; completion_window_until: string }>(
    `SELECT state, completion_window_until FROM siton.deals WHERE deal_id=$1`,
    [charging.dealId]
  );
  assert.equal(deal?.state, "CompletionWindow");
  assert.ok(deal?.completion_window_until);

  const participantStates = await fetchAll<{ participant_id: string; buyer_state: string; money_state: string }>(
    `SELECT participant_id, buyer_state, money_state
     FROM siton.participants
     WHERE deal_id=$1
     ORDER BY participant_id ASC`,
    [charging.dealId]
  );
  assert.deepEqual(
    participantStates.map((row) => `${row.buyer_state}:${row.money_state}`).sort(),
    ["ChargeFailedCompletion:ChargeFailedRecovery", "ChargedSuccess:ChargedSuccess"]
  );

  const attempts = await fetchAll<{ result_class: string }>(
    `SELECT result_class
     FROM siton.payment_attempts
     WHERE deal_id=$1
       AND attempt_type='charge_start'
     ORDER BY created_at ASC`,
    [charging.dealId]
  );
  assert.deepEqual(attempts.map((row) => row.result_class).sort(), ["permanent_fail", "success"]);

  const outboxRows = await fetchAll<{ event_type: string; available_at: string }>(
    `SELECT event_type, available_at
     FROM siton.outbox_events
     WHERE aggregate_id=$1
       AND event_type IN ('finalize_deal','recovery_deal')
     ORDER BY event_type ASC`,
    [charging.dealId]
  );
  assert.deepEqual(outboxRows.map((row) => row.event_type), ["finalize_deal", "recovery_deal"]);
  const finalizeOutbox = outboxRows.find((row) => row.event_type === "finalize_deal");
  assert.equal(new Date(finalizeOutbox!.available_at).toISOString(), new Date(deal!.completion_window_until).toISOString());

  await expectTxFailure(
    "completion window is immutable once set",
    async (client) => {
      await client.query(`UPDATE siton.deals SET completion_window_until = now() + interval '1 hour' WHERE deal_id=$1`, [charging.dealId]);
    },
    /completion_window_until is immutable/i
  );
});

await runTest("capture without reconciliation truth stays in Charging and marks the attempt unknown", async () => {
  const charging = await seedChargingDeal({
    suffix: "capture-missing",
    participants: [{ qty: 10, authorizationId: "auth-capture-missingevt-1" }],
    thresholdUnits: 9
  });

  const processed = await processOutboxEventById(charging.outboxEventId);
  assert.equal(processed?.status, "failed");

  const deal = await fetchOne<{ state: string; completion_window_until: string | null }>(
    `SELECT state, completion_window_until FROM siton.deals WHERE deal_id=$1`,
    [charging.dealId]
  );
  const participant = await fetchOne<{ buyer_state: string; money_state: string }>(
    `SELECT buyer_state, money_state FROM siton.participants WHERE deal_id=$1`,
    [charging.dealId]
  );
  const attempt = await fetchOne<{ result_class: string }>(
    `SELECT result_class
     FROM siton.payment_attempts
     WHERE deal_id=$1
       AND attempt_type='charge_start'
     ORDER BY created_at DESC
     LIMIT 1`,
    [charging.dealId]
  );
  const outbox = await fetchOne<{ status: string; last_error: string | null }>(
    `SELECT status, last_error
     FROM siton.outbox_events
     WHERE event_uuid=$1`,
    [charging.outboxEventId]
  );

  assert.equal(deal?.state, "Charging");
  assert.equal(deal?.completion_window_until, null);
  assert.equal(participant?.buyer_state, "ChargingAttempt");
  assert.equal(participant?.money_state, "ChargeAttempt");
  assert.equal(attempt?.result_class, "unknown");
  assert.equal(outbox?.status, "pending");
  assert.match(String(outbox?.last_error || ""), /capture_missing_reconciliation_event_type/i);
});

await runTest("recovery only runs inside CompletionWindow for eligible participants and missing truth stays unknown", async () => {
  const completed = await seedRecoveryDeal({
    suffix: "completed-noop",
    authorizationId: "auth-recovery-completed-1",
    dealState: "Completed",
    withinWindow: true,
    participantState: { buyer_state: "ChargeFailedCompletion", money_state: "ChargeFailedRecovery" }
  });
  const completedProcessed = await processOutboxEventById(completed.outboxEventId);
  assert.equal(completedProcessed?.status, "sent");
  const completedAttempts = await fetchAll(
    `SELECT attempt_id FROM siton.payment_attempts WHERE deal_id=$1 AND attempt_type='recovery'`,
    [completed.dealId]
  );
  assert.equal(completedAttempts.length, 0);

  const noEligible = await seedRecoveryDeal({
    suffix: "no-eligible",
    authorizationId: "auth-recovery-noeligible-1",
    dealState: "CompletionWindow",
    withinWindow: true,
    participantState: { buyer_state: "Dropped", money_state: "AuthReleased" }
  });
  const noEligibleProcessed = await processOutboxEventById(noEligible.outboxEventId);
  assert.equal(noEligibleProcessed?.status, "sent");
  const noEligibleAttempts = await fetchAll(
    `SELECT attempt_id FROM siton.payment_attempts WHERE deal_id=$1 AND attempt_type='recovery'`,
    [noEligible.dealId]
  );
  assert.equal(noEligibleAttempts.length, 0);

  const missingTruth = await seedRecoveryDeal({
    suffix: "recovery-missingevt",
    authorizationId: "auth-recovery-missingevt-1",
    dealState: "CompletionWindow",
    withinWindow: true,
    participantState: { buyer_state: "ChargeFailedCompletion", money_state: "ChargeFailedRecovery" }
  });
  const missingTruthProcessed = await processOutboxEventById(missingTruth.outboxEventId);
  assert.equal(missingTruthProcessed?.status, "failed");
  const missingParticipant = await fetchOne<{ buyer_state: string; money_state: string }>(
    `SELECT buyer_state, money_state FROM siton.participants WHERE participant_id=$1`,
    [missingTruth.participantId]
  );
  const missingAttempt = await fetchOne<{ result_class: string }>(
    `SELECT result_class
     FROM siton.payment_attempts
     WHERE deal_id=$1 AND attempt_type='recovery'
     ORDER BY created_at DESC
     LIMIT 1`,
    [missingTruth.dealId]
  );
  const missingOutbox = await fetchOne<{ status: string; last_error: string | null }>(
    `SELECT status, last_error
     FROM siton.outbox_events
     WHERE event_uuid=$1`,
    [missingTruth.outboxEventId]
  );
  assert.equal(missingParticipant?.buyer_state, "ChargeFailedCompletion");
  assert.equal(missingParticipant?.money_state, "ChargeFailedRecovery");
  assert.equal(missingAttempt?.result_class, "unknown");
  assert.equal(missingOutbox?.status, "pending");
  assert.match(String(missingOutbox?.last_error || ""), /recovery_missing_reconciliation_event_type/i);
});

await runTest("finalize defers before expiry, replays safely, and enforces the 90 percent rule by threshold_units", async () => {
  const beforeExpiry = await seedFinalizeDeal({
    suffix: "before-expiry",
    minUnits: 10,
    thresholdUnits: 9,
    completionMode: "future",
    participants: [{ qty: 9, buyer_state: "ChargedSuccess", money_state: "ChargedSuccess" }]
  });
  const deferred = await processOutboxEventById(beforeExpiry.outboxEventId);
  assert.equal(deferred?.status, "failed");
  const deferredDeal = await fetchOne<{ state: string; completion_window_until: string }>(
    `SELECT state, completion_window_until FROM siton.deals WHERE deal_id=$1`,
    [beforeExpiry.dealId]
  );
  const deferredOutbox = await fetchOne<{ status: string; available_at: string; last_error: string | null }>(
    `SELECT status, available_at, last_error FROM siton.outbox_events WHERE event_uuid=$1`,
    [beforeExpiry.outboxEventId]
  );
  assert.equal(deferredDeal?.state, "CompletionWindow");
  assert.equal(deferredOutbox?.status, "pending");
  assert.equal(new Date(deferredOutbox!.available_at).toISOString(), new Date(deferredDeal!.completion_window_until).toISOString());
  assert.match(String(deferredOutbox?.last_error || ""), /finalize_not_ready_yet/i);

  const matrixCases = [
    {
      label: "min100-success89-fail",
      minUnits: 100,
      thresholdUnits: 90,
      completionMode: "past" as const,
      participants: [
        { qty: 89, buyer_state: "ChargedSuccess", money_state: "ChargedSuccess" },
        { qty: 4, buyer_state: "ChargeFailedCompletion", money_state: "ChargeFailedRecovery" },
        { qty: 2, buyer_state: "Dropped", money_state: "AuthReleased" }
      ],
      expectedDeal: "Failed",
      expectedCompleted: 0,
      expectedFailed: 3
    },
    {
      label: "min100-success90-pass",
      minUnits: 100,
      thresholdUnits: 90,
      completionMode: "past" as const,
      participants: [
        { qty: 90, buyer_state: "ChargedSuccess", money_state: "ChargedSuccess" },
        { qty: 4, buyer_state: "ChargeFailedCompletion", money_state: "ChargeFailedRecovery" },
        { qty: 2, buyer_state: "Dropped", money_state: "AuthReleased" }
      ],
      expectedDeal: "Completed",
      expectedCompleted: 1,
      expectedFailed: 2
    },
    {
      label: "min11-success9-fail",
      minUnits: 11,
      thresholdUnits: 10,
      completionMode: "past" as const,
      participants: [
        { qty: 9, buyer_state: "ChargedSuccess", money_state: "ChargedSuccess" },
        { qty: 1, buyer_state: "ChargeFailedCompletion", money_state: "ChargeFailedRecovery" },
        { qty: 1, buyer_state: "Dropped", money_state: "AuthReleased" }
      ],
      expectedDeal: "Failed",
      expectedCompleted: 0,
      expectedFailed: 3
    },
    {
      label: "min11-success10-pass",
      minUnits: 11,
      thresholdUnits: 10,
      completionMode: "past" as const,
      participants: [
        { qty: 10, buyer_state: "ChargedSuccess", money_state: "ChargedSuccess" },
        { qty: 1, buyer_state: "Dropped", money_state: "AuthReleased" }
      ],
      expectedDeal: "Completed",
      expectedCompleted: 1,
      expectedFailed: 1
    },
    {
      label: "min51-success45-fail",
      minUnits: 51,
      thresholdUnits: 46,
      completionMode: "past" as const,
      participants: [
        { qty: 45, buyer_state: "ChargedSuccess", money_state: "ChargedSuccess" },
        { qty: 4, buyer_state: "ChargeFailedCompletion", money_state: "ChargeFailedRecovery" },
        { qty: 2, buyer_state: "Dropped", money_state: "AuthReleased" }
      ],
      expectedDeal: "Failed",
      expectedCompleted: 0,
      expectedFailed: 3
    },
    {
      label: "min51-success46-pass",
      minUnits: 51,
      thresholdUnits: 46,
      completionMode: "past" as const,
      participants: [
        { qty: 46, buyer_state: "ChargedSuccess", money_state: "ChargedSuccess" },
        { qty: 3, buyer_state: "ChargeFailedCompletion", money_state: "ChargeFailedRecovery" },
        { qty: 2, buyer_state: "Dropped", money_state: "AuthReleased" }
      ],
      expectedDeal: "Completed",
      expectedCompleted: 1,
      expectedFailed: 2
    },
    {
      label: "min50-success45-pass",
      minUnits: 50,
      thresholdUnits: 45,
      completionMode: "past" as const,
      participants: [
        { qty: 45, buyer_state: "ChargedSuccess", money_state: "ChargedSuccess" },
        { qty: 5, buyer_state: "Dropped", money_state: "AuthReleased" }
      ],
      expectedDeal: "Completed",
      expectedCompleted: 1,
      expectedFailed: 1
    },
    {
      label: "mixed-charged-plus-recovered-counts",
      minUnits: 100,
      thresholdUnits: 90,
      completionMode: "past" as const,
      participants: [
        { qty: 87, buyer_state: "ChargedSuccess", money_state: "ChargedSuccess" },
        { qty: 3, buyer_state: "Recovered", money_state: "RecoveredCharge" },
        { qty: 4, buyer_state: "ChargeFailedCompletion", money_state: "ChargeFailedRecovery" },
        { qty: 2, buyer_state: "Dropped", money_state: "AuthReleased" }
      ],
      expectedDeal: "Completed",
      expectedCompleted: 2,
      expectedFailed: 2
    },
    {
      label: "recovered-only-counts",
      minUnits: 10,
      thresholdUnits: 10,
      completionMode: "past" as const,
      participants: [{ qty: 10, buyer_state: "Recovered", money_state: "RecoveredCharge" }],
      expectedDeal: "Completed",
      expectedCompleted: 1,
      expectedFailed: 0
    },
    {
      label: "stored-threshold-source-of-truth",
      minUnits: 100,
      thresholdUnits: 1,
      completionMode: "past" as const,
      participants: [
        { qty: 1, buyer_state: "ChargedSuccess", money_state: "ChargedSuccess" },
        { qty: 20, buyer_state: "Dropped", money_state: "AuthReleased" }
      ],
      expectedDeal: "Completed",
      expectedCompleted: 1,
      expectedFailed: 1
    }
  ];

  for (const testCase of matrixCases) {
    const finalize = await seedFinalizeDeal({
      suffix: testCase.label,
      minUnits: testCase.minUnits,
      thresholdUnits: testCase.thresholdUnits,
      completionMode: testCase.completionMode,
      participants: testCase.participants
    });

    const processed = await processOutboxEventById(finalize.outboxEventId);
    if (processed?.status !== "sent") {
      console.error("FINALIZE_MATRIX_ERROR", testCase.label, processed);
    }
    assert.equal(processed?.status, "sent", testCase.label);

    const deal = await fetchOne<{ state: string }>(`SELECT state FROM siton.deals WHERE deal_id=$1`, [finalize.dealId]);
    const participants = await fetchAll<{ buyer_state: string; money_state: string; qty: number }>(
      `SELECT buyer_state, money_state, qty
       FROM siton.participants
       WHERE deal_id=$1
       ORDER BY qty DESC, created_at ASC`,
      [finalize.dealId]
    );
    assert.equal(deal?.state, testCase.expectedDeal, testCase.label);

    if (testCase.expectedDeal === "Completed") {
      const expectedRecovered =
        testCase.participants.filter((row) => row.money_state === "RecoveredCharge").length;
      const expectedCharged =
        testCase.participants.filter((row) => row.money_state === "ChargedSuccess").length;
      assert.equal(participants.filter((row) => row.money_state === "ChargedSuccess").length, expectedCharged, testCase.label);
      assert.equal(participants.filter((row) => row.money_state === "RecoveredCharge").length, expectedRecovered, testCase.label);
      assert.equal(participants.filter((row) => row.buyer_state === "DealCompleted").length, testCase.expectedCompleted, testCase.label);
      assert.equal(participants.filter((row) => row.buyer_state === "DealFailed").length, testCase.expectedFailed, testCase.label);
    } else {
      assert.equal(participants.filter((row) => row.buyer_state === "DealFailed").length, testCase.expectedFailed, testCase.label);
      assert.equal(participants.filter((row) => row.buyer_state === "DealCompleted").length, testCase.expectedCompleted, testCase.label);
      const refundOutbox = await fetchOne<{ event_type: string; status: string }>(
        `SELECT event_type, status
         FROM siton.outbox_events
         WHERE aggregate_id=$1
           AND event_type='refund_issue'
         ORDER BY created_at DESC
         LIMIT 1`,
        [finalize.dealId]
      );
      assert.equal(refundOutbox?.event_type, "refund_issue", testCase.label);
      assert.equal(["pending", "processing", "sent"].includes(String(refundOutbox?.status || "")), true, testCase.label);
    }
  }

  const boundary = await seedFinalizeDeal({
    suffix: "boundary-now",
    minUnits: 50,
    thresholdUnits: 45,
    completionMode: "now",
    participants: [
      { qty: 45, buyer_state: "ChargedSuccess", money_state: "ChargedSuccess" },
      { qty: 2, buyer_state: "Dropped", money_state: "AuthReleased" }
    ]
  });
  const boundaryProcessed = await processOutboxEventById(boundary.outboxEventId);
  assert.equal(boundaryProcessed?.status, "sent");
  const boundaryDeal = await fetchOne<{ state: string }>(`SELECT state FROM siton.deals WHERE deal_id=$1`, [boundary.dealId]);
  assert.equal(boundaryDeal?.state, "Completed");

  const replayEventId = randomUUID();
  await pool.query(
    `INSERT INTO siton.outbox_events (
       event_uuid, event_type, aggregate_type, aggregate_id, payload, status, attempt_count, available_at, created_at, updated_at
     ) VALUES ($1,'finalize_deal','deal',$2,$3,'pending',0, now(), now(), now())`,
    [replayEventId, boundary.dealId, JSON.stringify({ deal_id: boundary.dealId })]
  );
  const replay = await processOutboxEventById(replayEventId);
  assert.equal(replay?.status, "sent");
  const replayAudit = await fetchAll(
    `SELECT audit_id
     FROM siton.audit_log
     WHERE deal_id=$1
       AND action_name IN ('charging.finalize_completed','charging.finalize_failed')
     ORDER BY created_at ASC`,
    [boundary.dealId]
  );
  assert.equal(replayAudit.length, 1);
});

await provider.close();
await pool.end();
process.exit(0);
