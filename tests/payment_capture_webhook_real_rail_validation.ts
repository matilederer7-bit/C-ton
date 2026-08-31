import assert from "node:assert/strict";
import http from "node:http";
import { createHmac, randomUUID } from "node:crypto";
import pg from "pg";

const PORT = "3084";
const SELLER_SESSION_SECRET = "seller-session-secret-capture";
const PAYMENT_WEBHOOK_SECRET = "live-webhook-secret";

process.env.PORT = PORT;
process.env.APP_DEPLOYMENT_MODE = "internal-runtime";
process.env.SELLER_SESSION_SECRET = SELLER_SESSION_SECRET;
process.env.PAYMENT_PROVIDER = "payrail-http";
process.env.PAYMENT_PROVIDER_MODE = "provider-ready";
process.env.PAYMENT_PROVIDER_API_KEY = "live-provider-key";
process.env.PAYMENT_PROVIDER_AUTH_PATH = "/authorize";
process.env.PAYMENT_PROVIDER_CAPTURE_PATH = "/capture";
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
  const captureCalls: Array<any> = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on("end", async () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
      captureCalls.push({
        url: req.url,
        body
      });
      if (req.url === "/capture") {
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
    captureCalls,
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  };
}

const provider = await startProviderStub();
process.env.PAYMENT_PROVIDER_BASE_URL = provider.baseUrl;

const { buildPaymentProvider, getPaymentProviderSummary } = await import(
  `../src/payment_provider.js?capture-provider-${Date.now()}`
);
const paymentProviderSummary = getPaymentProviderSummary(buildPaymentProvider());
assert.equal(paymentProviderSummary.mode, "provider-ready");
assert.equal(paymentProviderSummary.authorization_transport_live, true);
assert.equal(paymentProviderSummary.capture_path, "/capture");

const { app, processOutboxEventById } = await import(`../src/app.js?capture-worker-${Date.now()}`);
const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton"
});

const { establishNamedAdminSession } = await import("./helpers/named_admin_session.js");
// R5C — seller provisioning requires a named admin identity.
const { cookie: ADMIN_COOKIE } = await establishNamedAdminSession(app, pool);
const provisionSeller = await app.inject({
  method: "POST",
  url: "/api/admin/seller-auth/seller-alpha/provision",
  headers: { cookie: ADMIN_COOKIE },
  payload: {
    display_name: "Seller Alpha",
    login_email: "alpha@example.com",
    access_code: "alpha-pass-123",
    auth_enabled: true
  }
});
assert.equal(provisionSeller.statusCode, 200, provisionSeller.body);

const sellerLogin = await app.inject({
  method: "POST",
  url: "/api/seller/session/login",
  payload: {
    identifier: "alpha@example.com",
    access_code: "alpha-pass-123"
  }
});
assert.equal(sellerLogin.statusCode, 200);
const sellerCookie = Array.isArray(sellerLogin.headers["set-cookie"])
  ? String(sellerLogin.headers["set-cookie"][0] || "")
  : String(sellerLogin.headers["set-cookie"] || "");

async function createChargingParticipant(suffix: string, authorizationId: string) {
  const dealId = randomUUID();
  const participantId = randomUUID();
  const auditIdempotency = `seed-join-${suffix}-${Date.now()}`;
  const deadline = new Date(Date.now() + 30 * 60_000).toISOString();

  await pool.query(
    `INSERT INTO siton.deals (
       deal_id, title, price_per_unit, min_units, max_units, threshold_units, deadline, state, published_at, created_at, seller_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now(), now(), $9)`,
    [dealId, `Capture Deal ${suffix}`, 42, 10, 20, 9, deadline, "Charging", "seller-alpha"]
  );

  await pool.query(
    `INSERT INTO siton.participants (
       participant_id, deal_id, buyer_id, qty, buyer_state, money_state, delivery_cost, created_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7, now())`,
    [participantId, dealId, `buyer-${suffix}`, 10, "ChargingAttempt", "ChargeAttempt", 0]
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
      `seed:${suffix}`,
      auditIdempotency,
      JSON.stringify({
        authorization: "provider_authorized",
        authorization_id: authorizationId,
        authorization_provider: "payrail-http",
        authorization_correlation_id: `payauth-${suffix}`
      })
    ]
  );

  const outboxEventId = randomUUID();
  await pool.query(
    `INSERT INTO siton.outbox_events (
       event_uuid, event_type, aggregate_type, aggregate_id, payload, status, attempt_count, available_at, created_at, updated_at
     ) VALUES ($1,$2,$3,$4,$5,'pending',0, now(), now(), now())`,
    [outboxEventId, "charge_deal", "deal", dealId, JSON.stringify({ deal_id: dealId })]
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

async function latestChargeAttempt(participantId: string) {
  const result = await pool.query(
    `SELECT correlation_id, result_class
     FROM siton.payment_attempts
     WHERE participant_id = $1
       AND attempt_type = 'charge_start'
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

await runTest("capture success flows through the real provider path and late/duplicate webhooks stay safe", async () => {
  const charging = await createChargingParticipant("success", "auth-success-1");
  await ensureOutboxStatus(charging.outboxEventId, "sent");
  const tracked = await readTracking(charging.participantId);

  assert.equal(tracked.tracking.buyer_state, "ChargedSuccess");
  assert.equal(tracked.tracking.money_state, "ChargedSuccess");
  assert.ok(
    provider.captureCalls.some((row) => row.url === "/capture" && row.body?.authorization_id === "auth-success-1"),
    JSON.stringify(provider.captureCalls)
  );

  const attempt = await waitFor(
    () => Promise.resolve(latestChargeAttempt(charging.participantId)),
    (row) => Boolean(row?.correlation_id)
  );
  assert.ok(attempt?.correlation_id);
  assert.equal(attempt?.result_class, "success");

  const lateWebhookBody = {
    provider: "payrail-http",
    event_id: `late-fail-${Date.now()}`,
    event_type: "charge_failed",
    correlation_id: attempt!.correlation_id,
    participant_id: charging.participantId,
    deal_id: charging.dealId,
    provider_reference: "cap-auth-success-1",
    payload: {
      provider_reference: "cap-auth-success-1"
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
  const lateWebhookJson = lateWebhook.json() as any;
  assert.equal(lateWebhookJson.status, "ignored");

  const duplicateWebhook = await app.inject({
    method: "POST",
    url: "/webhooks/payments",
    headers: {
      "x-webhook-signature": createWebhookSignature(lateWebhookBody)
    },
    payload: lateWebhookBody
  });
  assert.equal(duplicateWebhook.statusCode, 200);
  const duplicateWebhookJson = duplicateWebhook.json() as any;
  assert.equal(duplicateWebhookJson.duplicate, true);
});

await runTest("capture decline flows through webhook truth into the existing failed-charge state", async () => {
  const charging = await createChargingParticipant("fail", "auth-fail-1");
  await ensureOutboxStatus(charging.outboxEventId, "sent");
  const tracked = await readTracking(charging.participantId);

  assert.equal(tracked.tracking.buyer_state, "ChargeFailedCompletion");
  assert.equal(tracked.tracking.money_state, "ChargeFailedRecovery");
});

await runTest("capture timeout keeps outbox discipline and does not force an invalid state transition", async () => {
  const charging = await createChargingParticipant("timeout", "auth-timeout-1");
  await ensureOutboxStatus(charging.outboxEventId, "failed");
  const tracked = await readTracking(charging.participantId);
  assert.equal(tracked.tracking.buyer_state, "ChargingAttempt");
  assert.equal(tracked.tracking.money_state, "ChargeAttempt");

  const outboxResult = await pool.query(
    `SELECT attempt_count, status, last_error
     FROM siton.outbox_events
     WHERE aggregate_id = $1
       AND event_type = 'charge_deal'
     ORDER BY created_at DESC
     LIMIT 1`,
    [charging.dealId]
  );
  const outbox = outboxResult.rows[0] as { attempt_count: number; status: string; last_error: string | null } | undefined;

  assert.ok(outbox);
  assert.equal(outbox!.status, "pending");
  assert.match(String(outbox!.last_error || ""), /temporary_fail/i);
});

await provider.close();
await pool.end();
process.exit(0);
