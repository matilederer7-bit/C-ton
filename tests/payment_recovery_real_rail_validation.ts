import assert from "node:assert/strict";
import http from "node:http";
import { createHmac, randomUUID } from "node:crypto";
import pg from "pg";

const PORT = "3086";
const PAYMENT_WEBHOOK_SECRET = "live-webhook-secret-recovery";

process.env.PORT = PORT;
process.env.APP_DEPLOYMENT_MODE = "internal-runtime";
process.env.SELLER_SESSION_SECRET = "seller-session-secret-recovery";
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
process.env.PAYMENT_WEBHOOK_SECRET = PAYMENT_WEBHOOK_SECRET;

async function runTest(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

async function waitFor<T>(fn: () => Promise<T>, predicate: (value: T) => boolean, timeoutMs = 5000, stepMs = 150) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await fn();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  return fn();
}

function createWebhookSignature(body: Record<string, unknown>) {
  const rawBody = JSON.stringify(body);
  const digest = createHmac("sha256", PAYMENT_WEBHOOK_SECRET).update(rawBody).digest("hex");
  return `sha256=${digest}`;
}

async function startProviderStub() {
  const recoveryCalls: Array<any> = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on("end", async () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
      recoveryCalls.push({
        url: req.url,
        body
      });

      if (req.url && req.url.startsWith("/status/")) {
        // Authoritative status lookup seam used by the payment_reconcile rail.
        res.setHeader("content-type", "application/json");
        res.statusCode = 200;
        res.end(
          JSON.stringify({
            state: "captured",
            final: true,
            provider_reference: decodeURIComponent(req.url.split("/status/")[1]!.split("?")[0]!)
          })
        );
        return;
      }

      if (req.url === "/recover") {
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
  if (!address || typeof address === "string") {
    throw new Error("provider stub did not expose a TCP port");
  }
  return {
    recoveryCalls,
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  };
}

const provider = await startProviderStub();
process.env.PAYMENT_PROVIDER_BASE_URL = provider.baseUrl;

const { buildPaymentProvider, getPaymentProviderSummary } = await import(
  `../src/payment_provider.js?recovery-provider-${Date.now()}`
);
const paymentProviderSummary = getPaymentProviderSummary(buildPaymentProvider());
assert.equal(paymentProviderSummary.mode, "provider-ready");
assert.equal(paymentProviderSummary.recovery_path, "/recover");
assert.equal(paymentProviderSummary.recovery_transport_live, true);

const { app, processOutboxEventById } = await import(`../src/app.js?recovery-worker-${Date.now()}`);
const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton"
});

const preview = await app.inject({
  method: "GET",
  url: "/api/preview/meta"
});
assert.equal(preview.statusCode, 200);
assert.equal((preview.json() as any).preview.operational_readiness.authorization_charge_recovery.state, "authorization-capture-recovery-refund-partial");

async function createRecoveryParticipant(args: {
  suffix: string;
  authorizationId: string;
  withinWindow: boolean;
}) {
  const dealId = randomUUID();
  const participantId = randomUUID();
  const completionWindowUntil = args.withinWindow
    ? new Date(Date.now() + 30 * 60_000).toISOString()
    : new Date(Date.now() - 2 * 60_000).toISOString();

  await pool.query(
    `INSERT INTO siton.deals (
       deal_id, title, price_per_unit, min_units, max_units, threshold_units, deadline, state, published_at, created_at, completion_window_until, seller_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now(), now(), $9, $10)`,
    [
      dealId,
      `Recovery Deal ${args.suffix}`,
      42,
      10,
      20,
      9,
      new Date(Date.now() + 60 * 60_000).toISOString(),
      "CompletionWindow",
      completionWindowUntil,
      "seller-alpha"
    ]
  );

  await pool.query(
    `INSERT INTO siton.participants (
       participant_id, deal_id, buyer_id, qty, buyer_state, money_state, delivery_cost, created_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7, now())`,
    [participantId, dealId, `buyer-${args.suffix}`, 10, "ChargeFailedCompletion", "ChargeFailedRecovery", 0]
  );

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
      `seed:${args.suffix}`,
      `seed-join-${args.suffix}-${Date.now()}`,
      JSON.stringify({
        authorization: "provider_authorized",
        authorization_id: args.authorizationId,
        authorization_provider: "payrail-http",
        authorization_correlation_id: `payauth-${args.suffix}`
      })
    ]
  );

  const outboxEventId = randomUUID();
  await pool.query(
    `INSERT INTO siton.outbox_events (
       event_uuid, event_type, aggregate_type, aggregate_id, payload, status, attempt_count, available_at, created_at, updated_at
     ) VALUES ($1,$2,$3,$4,$5,'pending',0, now(), now(), now())`,
    [outboxEventId, "recovery_deal", "deal", dealId, JSON.stringify({ deal_id: dealId })]
  );

  return { dealId, participantId, outboxEventId };
}

async function readTracking(participantId: string) {
  const tracking = await app.inject({
    method: "GET",
    url: `/api/participants/${participantId}/tracking`
  });
  assert.equal(tracking.statusCode, 200);
  return tracking.json() as any;
}

async function latestRecoveryAttempt(participantId: string) {
  const result = await pool.query(
    `SELECT correlation_id, result_class
     FROM siton.payment_attempts
     WHERE participant_id = $1
       AND attempt_type = 'recovery'
     ORDER BY created_at DESC
     LIMIT 1`,
    [participantId]
  );
  return result.rows[0] as { correlation_id: string; result_class: string } | undefined;
}

async function readOutboxStatus(eventId: string) {
  const result = await pool.query(
    `SELECT status
     FROM siton.outbox_events
     WHERE event_uuid = $1`,
    [eventId]
  );
  return result.rows[0]?.status as string | undefined;
}

async function ensureOutboxStatus(eventId: string, expected: "sent" | "failed") {
  const processed = await processOutboxEventById(eventId);
  const status =
    processed?.status ||
    (await waitFor(() => Promise.resolve(readOutboxStatus(eventId)), (value) => value === "sent" || value === "failed"));
  assert.equal(status, expected);
}

await runTest("recovery success flows through the real provider path and late/duplicate webhooks stay safe", async () => {
  const recovering = await createRecoveryParticipant({
    suffix: "success",
    authorizationId: "auth-recovery-success-1",
    withinWindow: true
  });
  await ensureOutboxStatus(recovering.outboxEventId, "sent");
  const tracked = await readTracking(recovering.participantId);

  assert.equal(tracked.tracking.buyer_state, "Recovered");
  assert.equal(tracked.tracking.money_state, "RecoveredCharge");
  assert.ok(
    provider.recoveryCalls.some((row) => row.url === "/recover" && row.body?.authorization_id === "auth-recovery-success-1"),
    JSON.stringify(provider.recoveryCalls)
  );

  const attempt = await waitFor(
    () => Promise.resolve(latestRecoveryAttempt(recovering.participantId)),
    (row) => Boolean(row?.correlation_id)
  );
  assert.ok(attempt?.correlation_id);
  assert.equal(attempt?.result_class, "success");

  const lateWebhookBody = {
    provider: "payrail-http",
    event_id: `late-recovery-fail-${Date.now()}`,
    event_type: "recovery_failed",
    correlation_id: attempt!.correlation_id,
    participant_id: recovering.participantId,
    deal_id: recovering.dealId,
    provider_reference: "rec-auth-recovery-success-1",
    payload: {
      provider_reference: "rec-auth-recovery-success-1"
    }
  };
  const lateWebhook = await app.inject({
    method: "POST",
    url: "/webhooks/payments",
    headers: {
      "x-webhook-signature": createWebhookSignature(lateWebhookBody)
    },
    payload: lateWebhookBody
  });
  assert.equal(lateWebhook.statusCode, 200);
  assert.equal((lateWebhook.json() as any).status, "ignored");

  const duplicateWebhook = await app.inject({
    method: "POST",
    url: "/webhooks/payments",
    headers: {
      "x-webhook-signature": createWebhookSignature(lateWebhookBody)
    },
    payload: lateWebhookBody
  });
  assert.equal(duplicateWebhook.statusCode, 200);
  assert.equal((duplicateWebhook.json() as any).duplicate, true);
});

await runTest("recovery decline flows through webhook truth into the dropped/auth-released state", async () => {
  const recovering = await createRecoveryParticipant({
    suffix: "fail",
    authorizationId: "auth-recovery-fail-1",
    withinWindow: true
  });
  await ensureOutboxStatus(recovering.outboxEventId, "sent");
  const tracked = await readTracking(recovering.participantId);

  assert.equal(tracked.tracking.buyer_state, "Dropped");
  assert.equal(tracked.tracking.money_state, "AuthReleased");
});

await runTest("recovery timeout becomes durable UNKNOWN + reconcile (no blind provider retry), then resolves to exactly one recovery", async () => {
  const recovering = await createRecoveryParticipant({
    suffix: "timeout",
    authorizationId: "auth-recovery-timeout-1",
    withinWindow: true
  });
  // R9A: transport loss after dispatch is UNKNOWN ג€” the recovery event
  // completes without a blind retry and payment_reconcile owns resolution.
  const processed = await processOutboxEventById(recovering.outboxEventId);
  assert.equal(processed?.status, "sent");
  let tracked = await readTracking(recovering.participantId);
  assert.equal(tracked.tracking.buyer_state, "ChargeFailedCompletion");
  assert.equal(tracked.tracking.money_state, "ChargeFailedRecovery");

  const reconcileRow = await pool.query(
    `SELECT event_uuid
     FROM siton.outbox_events
     WHERE event_type='payment_reconcile'
       AND aggregate_id=$1
     ORDER BY created_at DESC
     LIMIT 1`,
    [recovering.participantId]
  );
  assert.ok(reconcileRow.rowCount, "payment_reconcile job must be scheduled for the UNKNOWN recovery attempt");

  const recoverCallsBefore = provider.recoveryCalls.filter((row) => row.url === "/recover").length;
  const reconcileProcessed = await processOutboxEventById(String(reconcileRow.rows[0].event_uuid));
  assert.equal(reconcileProcessed?.status, "sent");

  tracked = await readTracking(recovering.participantId);
  assert.equal(tracked.tracking.buyer_state, "Recovered");
  assert.equal(tracked.tracking.money_state, "RecoveredCharge");

  const recoverCallsAfter = provider.recoveryCalls.filter((row) => row.url === "/recover").length;
  assert.equal(recoverCallsAfter, recoverCallsBefore, "reconciliation must not re-fire the recovery call");
});

await runTest("recovery does not run outside the completion window", async () => {
  const recovering = await createRecoveryParticipant({
    suffix: "late-window",
    authorizationId: "auth-recovery-window-1",
    withinWindow: false
  });
  const processed = await processOutboxEventById(recovering.outboxEventId);
  assert.equal(processed?.status, "sent");

  const tracked = await readTracking(recovering.participantId);
  assert.equal(tracked.tracking.buyer_state, "ChargeFailedCompletion");
  assert.equal(tracked.tracking.money_state, "ChargeFailedRecovery");
  assert.equal(
    provider.recoveryCalls.some((row) => row.body?.authorization_id === "auth-recovery-window-1"),
    false
  );
});

await provider.close();
await pool.end();
// Windows/libuv teardown: let undici sockets from the reconcile status seam
// finish closing before exit (uv_async close race under process.exit).
await new Promise((resolve) => setTimeout(resolve, 700));
process.exit(0);
