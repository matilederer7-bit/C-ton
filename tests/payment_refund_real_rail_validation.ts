import assert from "node:assert/strict";
import http from "node:http";
import { createHmac, randomUUID } from "node:crypto";
import pg from "pg";

const PORT = "3087";
const PAYMENT_WEBHOOK_SECRET = "live-webhook-secret-refund";

process.env.PORT = PORT;
process.env.APP_DEPLOYMENT_MODE = "internal-runtime";
process.env.SELLER_SESSION_SECRET = "seller-session-secret-refund";
process.env.SELLER_AUTH_CREDENTIALS = JSON.stringify([
  { seller_id: "seller-alpha", display_name: "Seller Alpha", access_code: "alpha-code" }
]);
process.env.PAYMENT_PROVIDER = "payrail-http";
process.env.PAYMENT_PROVIDER_MODE = "provider-ready";
process.env.PAYMENT_PROVIDER_API_KEY = "live-provider-key";
process.env.PAYMENT_PROVIDER_AUTH_PATH = "/authorize";
process.env.PAYMENT_PROVIDER_CAPTURE_PATH = "/capture";
process.env.PAYMENT_PROVIDER_RECOVERY_PATH = "/recover";
process.env.PAYMENT_PROVIDER_REFUND_PATH = "/refund";
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
  const refundCalls: Array<any> = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on("end", async () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
      refundCalls.push({
        url: req.url,
        body
      });

      if (req.url && req.url.startsWith("/status/")) {
        // Authoritative status lookup seam used by the payment_reconcile rail.
        res.setHeader("content-type", "application/json");
        res.statusCode = 200;
        res.end(
          JSON.stringify({
            state: "refunded",
            final: true,
            provider_reference: decodeURIComponent(req.url.split("/status/")[1]!.split("?")[0]!)
          })
        );
        return;
      }

      if (req.url === "/refund") {
        const refundAnchor = String(body.capture_reference || body.authorization_id || "");
        if (refundAnchor.includes("timeout")) {
          await new Promise((resolve) => setTimeout(resolve, 400));
        }

        res.setHeader("content-type", "application/json");
        if (refundAnchor.includes("fail")) {
          res.statusCode = 402;
          res.end(
            JSON.stringify({
              status: "failed",
              error: "refund_declined",
              provider_reference: `ref-${refundAnchor}`,
              reference: body.reference
            })
          );
          return;
        }

        res.statusCode = 200;
        res.end(
          JSON.stringify({
            status: "refunded",
            refund_id: `ref-${refundAnchor}`,
            provider_reference: `ref-${refundAnchor}`,
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
    refundCalls,
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  };
}

const provider = await startProviderStub();
process.env.PAYMENT_PROVIDER_BASE_URL = provider.baseUrl;

const { buildPaymentProvider, getPaymentProviderSummary } = await import(
  `../src/payment_provider.js?refund-provider-${Date.now()}`
);
const paymentProviderSummary = getPaymentProviderSummary(buildPaymentProvider());
assert.equal(paymentProviderSummary.mode, "provider-ready");
assert.equal(paymentProviderSummary.refund_path, "/refund");
assert.equal(paymentProviderSummary.refund_transport_live, true);

const { app, processOutboxEventById } = await import(`../src/app.js?refund-worker-${Date.now()}`);
const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton"
});

const preview = await app.inject({
  method: "GET",
  url: "/api/preview/meta"
});
assert.equal(preview.statusCode, 200);
const previewJson = preview.json() as any;
assert.equal(previewJson.preview.operational_readiness.authorization_charge_recovery.state, "authorization-capture-recovery-refund-partial");
assert.match(previewJson.preview.operational_readiness.payment_provider.what_is_real, /refund transport/i);

async function createRefundParticipant(args: {
  suffix: string;
  captureReference: string;
}) {
  const dealId = randomUUID();
  const participantId = randomUUID();

  await pool.query(
    `INSERT INTO siton.deals (
       deal_id, title, price_per_unit, min_units, max_units, threshold_units, deadline, state, published_at, created_at, seller_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now(), now(), $9)`,
    [
      dealId,
      `Refund Deal ${args.suffix}`,
      42,
      10,
      20,
      9,
      new Date(Date.now() + 60 * 60_000).toISOString(),
      "Failed",
      "seller-alpha"
    ]
  );

  await pool.query(
    `INSERT INTO siton.participants (
       participant_id, deal_id, buyer_id, qty, buyer_state, money_state, delivery_cost, created_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7, now())`,
    [participantId, dealId, `buyer-${args.suffix}`, 10, "DealFailed", "ChargedSuccess", 0]
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
        authorization_id: `auth-${args.suffix}`,
        authorization_provider: "payrail-http",
        authorization_correlation_id: `payauth-${args.suffix}`
      })
    ]
  );

  await pool.query(
    `INSERT INTO siton.audit_log (
       entity_type, entity_id, deal_id, state_type, from_state, to_state, action_name, request_id, idempotency_key, payload
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      "participant",
      participantId,
      dealId,
      "money_state",
      "ChargeAttempt",
      "ChargedSuccess",
      "charging.capture_success",
      `seed:${args.suffix}:capture`,
      `seed-capture-${args.suffix}-${Date.now()}`,
      JSON.stringify({
        provider_reference: args.captureReference,
        correlation_id: `paycap-${args.suffix}`
      })
    ]
  );

  const outboxEventId = randomUUID();
  await pool.query(
    `INSERT INTO siton.outbox_events (
       event_uuid, event_type, aggregate_type, aggregate_id, payload, status, attempt_count, available_at, created_at, updated_at
     ) VALUES ($1,$2,$3,$4,$5,'pending',0, now(), now(), now())`,
    [outboxEventId, "refund_issue", "deal", dealId, JSON.stringify({ deal_id: dealId })]
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

async function latestRefundAttempt(participantId: string) {
  const result = await pool.query(
    `SELECT correlation_id, result_class
     FROM siton.payment_attempts
     WHERE participant_id = $1
       AND attempt_type = 'refund'
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

await runTest("refund success flows through the real provider path and late/duplicate webhooks stay safe", async () => {
  const refunding = await createRefundParticipant({
    suffix: "success",
    captureReference: "cap-refund-success-1"
  });
  await ensureOutboxStatus(refunding.outboxEventId, "sent");
  const tracked = await waitFor(
    () => readTracking(refunding.participantId),
    (row) => row.tracking.money_state === "Refunded"
  );

  assert.equal(tracked.tracking.money_state, "Refunded");
  assert.ok(
    provider.refundCalls.some((row) => row.url === "/refund" && row.body?.capture_reference === "cap-refund-success-1"),
    JSON.stringify(provider.refundCalls)
  );

  const attempt = await waitFor(
    () => Promise.resolve(latestRefundAttempt(refunding.participantId)),
    (row) => Boolean(row?.correlation_id)
  );
  assert.ok(attempt?.correlation_id);
  assert.equal(attempt?.result_class, "success");

  const lateWebhookBody = {
    provider: "payrail-http",
    event_id: `late-refund-${Date.now()}`,
    event_type: "refund_issued",
    correlation_id: attempt!.correlation_id,
    participant_id: refunding.participantId,
    deal_id: refunding.dealId,
    provider_reference: "ref-cap-refund-success-1",
    payload: {
      provider_reference: "ref-cap-refund-success-1"
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

await runTest("refund failure moves the outbox event to DLQ and preserves the participant state", async () => {
  const refunding = await createRefundParticipant({
    suffix: "fail",
    captureReference: "cap-refund-fail-1"
  });
  await ensureOutboxStatus(refunding.outboxEventId, "failed");

  const tracked = await waitFor(
    () => readTracking(refunding.participantId),
    (row) => row.tracking.money_state === "ChargedSuccess"
  );
  assert.equal(tracked.tracking.money_state, "ChargedSuccess");

  const attempt = await waitFor(
    () => Promise.resolve(latestRefundAttempt(refunding.participantId)),
    (row) => Boolean(row?.correlation_id)
  );
  assert.ok(attempt?.correlation_id);
  assert.equal(attempt?.result_class, "permanent_fail");

  const outboxRows = await pool.query(
    `SELECT status
     FROM siton.outbox_events
     WHERE event_uuid = $1`,
    [refunding.outboxEventId]
  );
  assert.equal(outboxRows.rowCount, 0);

  const dlqRows = await waitFor(
    () =>
      pool.query(
        `SELECT event_uuid, last_error
         FROM siton.outbox_dlq
         WHERE event_uuid = $1`,
        [refunding.outboxEventId]
      ),
    (result) => result.rowCount === 1
  );
  assert.equal(dlqRows.rowCount, 1);
  assert.match(String(dlqRows.rows[0].last_error || ""), /permanent_fail/i);
});

await runTest("refund timeout becomes durable UNKNOWN + reconcile (no blind provider retry), then resolves to exactly one refund", async () => {
  const refunding = await createRefundParticipant({
    suffix: "timeout",
    captureReference: "cap-refund-timeout-1"
  });
  // R9A: transport loss after dispatch is UNKNOWN ג€” the refund may have been
  // issued, so the refund event completes without a blind re-fire and the
  // payment_reconcile rail resolves the truth via the status seam.
  await ensureOutboxStatus(refunding.outboxEventId, "sent");

  let tracked = await readTracking(refunding.participantId);
  assert.equal(tracked.tracking.money_state, "ChargedSuccess");

  const reconcileRow = await pool.query(
    `SELECT event_uuid
     FROM siton.outbox_events
     WHERE event_type='payment_reconcile'
       AND aggregate_id=$1
     ORDER BY created_at DESC
     LIMIT 1`,
    [refunding.participantId]
  );
  assert.ok(reconcileRow.rowCount, "payment_reconcile job must be scheduled for the UNKNOWN refund attempt");

  const refundCallsBefore = provider.refundCalls.filter((row) => row.url === "/refund").length;
  await ensureOutboxStatus(String(reconcileRow.rows[0].event_uuid), "sent");

  tracked = await waitFor(
    () => readTracking(refunding.participantId),
    (row) => row.tracking.money_state === "Refunded"
  );
  assert.equal(tracked.tracking.money_state, "Refunded");

  const refundCallsAfter = provider.refundCalls.filter((row) => row.url === "/refund").length;
  assert.equal(refundCallsAfter, refundCallsBefore, "reconciliation must not re-fire the refund call");
});

await provider.close();
await pool.end();
// Windows/libuv teardown: let undici sockets from the reconcile status seam
// finish closing before exit (uv_async close race under process.exit).
await new Promise((resolve) => setTimeout(resolve, 700));
process.exit(0);
