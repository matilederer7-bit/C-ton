import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import "dotenv/config";

process.env.PORT = "3094";
process.env.APP_DEPLOYMENT_MODE = "internal-runtime";
process.env.SELLER_SESSION_SECRET = "seller-session-secret-wave4a";
process.env.SELLER_AUTH_CREDENTIALS = JSON.stringify([
  { seller_id: "seller-alpha", display_name: "Seller Alpha", access_code: "alpha-code" }
]);
process.env.PAYMENT_WEBHOOK_PROVIDER = "payrail-http";
process.env.PAYMENT_WEBHOOK_SECRET = "wave4a-webhook-secret";
process.env.OUTBOX_POLL_MS = "60000";
process.env.DISABLE_OUTBOX_WORKER = "1";

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton"
});

const bootstrapSql = (await readFile("src/migrations/014_demo_preview_bootstrap.sql", "utf8")).replace(/^\uFEFF/, "");
const outboxSql = (await readFile("src/migrations/009_db_enforcement_phase2c.sql", "utf8")).replace(/^\uFEFF/, "");
await pool.query(bootstrapSql);
await pool.query(outboxSql);

const { app } = await import(`../src/app.js?wave4a-${Date.now()}`);

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

function signWebhook(body: Record<string, unknown>) {
  const rawBody = JSON.stringify(body);
  const digest = createHmac("sha256", process.env.PAYMENT_WEBHOOK_SECRET || "").update(rawBody).digest("hex");
  return `sha256=${digest}`;
}

async function postWebhook(body: Record<string, unknown>) {
  const response = await app.inject({
    method: "POST",
    url: "/webhooks/payments",
    headers: {
      "x-webhook-signature": signWebhook(body)
    },
    payload: body
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json() as any;
}

async function fetchOne<T>(sql: string, params: any[] = []) {
  const result = await pool.query(sql, params);
  return (result.rows[0] || null) as T | null;
}

async function fetchAll<T>(sql: string, params: any[] = []) {
  const result = await pool.query(sql, params);
  return result.rows as T[];
}

async function seedChargeAwaitingWebhook(suffix: string, correlationId = `corr-charge-${suffix}-${Date.now()}`) {
  const dealId = randomUUID();
  const participantId = randomUUID();
  await pool.query(
    `INSERT INTO siton.deals (
       deal_id, seller_id, state, title, price_per_unit, min_units, max_units, threshold_units, deadline, published_at
     ) VALUES ($1,$2,'Charging',$3,$4,$5,$6,$7,$8, now())`,
    [dealId, "seller-alpha", `Wave4A Charge ${suffix}`, 42, 10, 20, 9, new Date(Date.now() + 30 * 60_000).toISOString()]
  );
  await pool.query(
    `INSERT INTO siton.participants (
       participant_id, deal_id, buyer_id, qty, buyer_state, money_state, delivery_cost, created_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7, now())`,
    [participantId, dealId, `buyer-${suffix}`, 10, "ChargingAttempt", "ChargeAttempt", 0]
  );
  await pool.query(
    `INSERT INTO siton.payment_attempts (
       participant_id, deal_id, attempt_type, result_class, correlation_id, created_at
     ) VALUES ($1,$2,'charge_start','unknown',$3, now())`,
    [participantId, dealId, correlationId]
  );
  return { dealId, participantId, correlationId };
}

async function seedRecoveryAwaitingWebhook(suffix: string, correlationId = `corr-recovery-${suffix}-${Date.now()}`) {
  const dealId = randomUUID();
  const participantId = randomUUID();
  await pool.query(
    `INSERT INTO siton.deals (
       deal_id, seller_id, state, title, price_per_unit, min_units, max_units, threshold_units, deadline, published_at, completion_window_until
     ) VALUES ($1,$2,'CompletionWindow',$3,$4,$5,$6,$7,$8, now(), $9)`,
    [dealId, "seller-alpha", `Wave4A Recovery ${suffix}`, 42, 10, 20, 9, new Date(Date.now() + 30 * 60_000).toISOString(), new Date(Date.now() + 10 * 60_000).toISOString()]
  );
  await pool.query(
    `INSERT INTO siton.participants (
       participant_id, deal_id, buyer_id, qty, buyer_state, money_state, delivery_cost, created_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7, now())`,
    [participantId, dealId, `buyer-${suffix}`, 10, "ChargeFailedCompletion", "ChargeFailedRecovery", 0]
  );
  await pool.query(
    `INSERT INTO siton.payment_attempts (
       participant_id, deal_id, attempt_type, result_class, correlation_id, created_at
     ) VALUES ($1,$2,'recovery','unknown',$3, now())`,
    [participantId, dealId, correlationId]
  );
  return { dealId, participantId, correlationId };
}

async function seedClosedParticipant(args: {
  suffix: string;
  dealState: "Completed" | "Failed";
  buyerState: string;
  moneyState: string;
  attemptType: "charge_start" | "recovery" | "refund";
  attemptClass: "success" | "permanent_fail" | "unknown";
  correlationId: string;
}) {
  const dealId = randomUUID();
  const participantId = randomUUID();
  await pool.query(
    `INSERT INTO siton.deals (
       deal_id, seller_id, state, title, price_per_unit, min_units, max_units, threshold_units, deadline, published_at, completion_window_until
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now(), $10)`,
    [
      dealId,
      "seller-alpha",
      args.dealState,
      `Wave4A Closed ${args.suffix}`,
      42,
      10,
      20,
      9,
      new Date(Date.now() + 30 * 60_000).toISOString(),
      new Date(Date.now() - 10 * 60_000).toISOString()
    ]
  );
  await pool.query(
    `INSERT INTO siton.participants (
       participant_id, deal_id, buyer_id, qty, buyer_state, money_state, delivery_cost, created_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7, now())`,
    [participantId, dealId, `buyer-${args.suffix}`, 10, args.buyerState, args.moneyState, 0]
  );
  await pool.query(
    `INSERT INTO siton.payment_attempts (
       participant_id, deal_id, attempt_type, result_class, correlation_id, created_at
     ) VALUES ($1,$2,$3,$4,$5, now())`,
    [participantId, dealId, args.attemptType, args.attemptClass, args.correlationId]
  );
  return { dealId, participantId, correlationId: args.correlationId };
}

async function webhookEventRow(provider: string, eventId: string) {
  return fetchOne<{
    status: string;
    corr: string | null;
    provider_reference: string | null;
    classification_reason: string | null;
  }>(
    `SELECT
       status,
       payload_jsonb->>'correlation_id' AS corr,
       payload_jsonb->>'provider_reference' AS provider_reference,
       payload_jsonb->>'classification_reason' AS classification_reason
     FROM siton.webhook_events
     WHERE provider=$1 AND event_id=$2`,
    [provider, eventId]
  );
}

await runTest("duplicate success webhook is persisted once and does not mutate twice", async () => {
  const seeded = await seedChargeAwaitingWebhook("dup-success");
  const eventId = `wave4a-dup-success-${Date.now()}`;
  const body = {
    provider: "payrail-http",
    event_id: eventId,
    event_type: "charge_captured",
    correlation_id: seeded.correlationId,
    participant_id: seeded.participantId,
    deal_id: seeded.dealId,
    provider_reference: "cap-wave4a-dup-success",
    payload: {
      provider_reference: "cap-wave4a-dup-success"
    }
  };

  const first = await postWebhook(body);
  assert.equal(first.duplicate, false);
  assert.equal(first.status, "processed");
  assert.equal(first.reason, "capture_success");

  for (let i = 0; i < 5; i += 1) {
    const duplicate = await postWebhook(body);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.status, "processed");
  }

  const eventRow = await webhookEventRow("payrail-http", eventId);
  const participant = await fetchOne<{ buyer_state: string; money_state: string }>(
    `SELECT buyer_state, money_state FROM siton.participants WHERE participant_id=$1`,
    [seeded.participantId]
  );
  const auditCount = await fetchOne<{ cnt: string }>(
    `SELECT COUNT(*) AS cnt
     FROM siton.audit_log
     WHERE deal_id=$1
       AND action_name='charging.capture_success'`,
    [seeded.dealId]
  );
  const attempt = await fetchOne<{ result_class: string }>(
    `SELECT result_class
     FROM siton.payment_attempts
     WHERE participant_id=$1 AND correlation_id=$2`,
    [seeded.participantId, seeded.correlationId]
  );
  const webhookCount = await fetchOne<{ cnt: string }>(
    `SELECT COUNT(*) AS cnt
     FROM siton.webhook_events
     WHERE provider='payrail-http' AND event_id=$1`,
    [eventId]
  );

  assert.equal(webhookCount?.cnt, "1");
  assert.equal(eventRow?.status, "processed");
  assert.equal(eventRow?.corr, seeded.correlationId);
  assert.equal(eventRow?.provider_reference, "cap-wave4a-dup-success");
  assert.equal(eventRow?.classification_reason, "capture_success");
  assert.equal(participant?.buyer_state, "ChargedSuccess");
  assert.equal(participant?.money_state, "ChargedSuccess");
  assert.equal(auditCount?.cnt, "2");
  assert.equal(attempt?.result_class, "success");
});

await runTest("duplicate webhook during processing is idempotent and does not mutate state", async () => {
  const seeded = await seedChargeAwaitingWebhook("dup-processing");
  const eventId = `wave4a-dup-processing-${Date.now()}`;
  const payload = {
    event_type: "charge_captured",
    correlation_id: seeded.correlationId,
    provider_reference: "cap-wave4a-processing",
    deal_id: seeded.dealId,
    participant_id: seeded.participantId,
    payload: {
      provider_reference: "cap-wave4a-processing"
    }
  };
  await pool.query(
    `INSERT INTO siton.webhook_events(provider, event_id, payload_jsonb, deal_id, participant_id, status)
     VALUES ($1,$2,$3,$4,$5,'processing')`,
    ["payrail-http", eventId, JSON.stringify(payload), seeded.dealId, seeded.participantId]
  );

  const response = await postWebhook({
    provider: "payrail-http",
    event_id: eventId,
    event_type: "charge_captured",
    correlation_id: seeded.correlationId,
    participant_id: seeded.participantId,
    deal_id: seeded.dealId,
    provider_reference: "cap-wave4a-processing",
    payload: {
      provider_reference: "cap-wave4a-processing"
    }
  });

  const participant = await fetchOne<{ buyer_state: string; money_state: string }>(
    `SELECT buyer_state, money_state FROM siton.participants WHERE participant_id=$1`,
    [seeded.participantId]
  );
  const auditCount = await fetchOne<{ cnt: string }>(
    `SELECT COUNT(*) AS cnt
     FROM siton.audit_log
     WHERE deal_id=$1
       AND action_name='charging.capture_success'`,
    [seeded.dealId]
  );

  assert.equal(response.duplicate, true);
  assert.equal(response.status, "processing");
  assert.equal(participant?.buyer_state, "ChargingAttempt");
  assert.equal(participant?.money_state, "ChargeAttempt");
  assert.equal(auditCount?.cnt, "0");
});

await runTest("failed webhook row can be retried with the same event id and becomes processed", async () => {
  const seeded = await seedChargeAwaitingWebhook("retry-failed");
  const eventId = `wave4a-retry-failed-${Date.now()}`;
  const payload = {
    event_type: "charge_captured",
    correlation_id: seeded.correlationId,
    provider_reference: "cap-wave4a-retry",
    deal_id: seeded.dealId,
    participant_id: seeded.participantId,
    payload: {
      provider_reference: "cap-wave4a-retry"
    },
    classification_reason: "missing_correlation_target"
  };
  await pool.query(
    `INSERT INTO siton.webhook_events(provider, event_id, payload_jsonb, deal_id, participant_id, status, processed_at)
     VALUES ($1,$2,$3,$4,$5,'failed', now())`,
    ["payrail-http", eventId, JSON.stringify(payload), seeded.dealId, seeded.participantId]
  );

  const response = await postWebhook({
    provider: "payrail-http",
    event_id: eventId,
    event_type: "charge_captured",
    correlation_id: seeded.correlationId,
    participant_id: seeded.participantId,
    deal_id: seeded.dealId,
    provider_reference: "cap-wave4a-retry",
    payload: {
      provider_reference: "cap-wave4a-retry"
    }
  });

  const eventRow = await webhookEventRow("payrail-http", eventId);
  const participant = await fetchOne<{ buyer_state: string; money_state: string }>(
    `SELECT buyer_state, money_state FROM siton.participants WHERE participant_id=$1`,
    [seeded.participantId]
  );
  const attempt = await fetchOne<{ result_class: string }>(
    `SELECT result_class
     FROM siton.payment_attempts
     WHERE participant_id=$1 AND correlation_id=$2`,
    [seeded.participantId, seeded.correlationId]
  );

  assert.equal(response.duplicate, true);
  assert.equal(response.status, "processed");
  assert.equal(response.reason, "capture_success");
  assert.equal(eventRow?.status, "processed");
  assert.equal(eventRow?.classification_reason, "capture_success");
  assert.equal(participant?.buyer_state, "ChargedSuccess");
  assert.equal(participant?.money_state, "ChargedSuccess");
  assert.equal(attempt?.result_class, "success");
});

await runTest("late and conflicting webhooks are persisted but do not reopen closed state", async () => {
  const completed = await seedClosedParticipant({
    suffix: "late-completed",
    dealState: "Completed",
    buyerState: "DealCompleted",
    moneyState: "ChargedSuccess",
    attemptType: "charge_start",
    attemptClass: "success",
    correlationId: `corr-completed-${Date.now()}`
  });
  const lateFail = await postWebhook({
    provider: "payrail-http",
    event_id: `wave4a-late-fail-${Date.now()}`,
    event_type: "charge_failed",
    correlation_id: completed.correlationId,
    participant_id: completed.participantId,
    deal_id: completed.dealId,
    provider_reference: "cap-wave4a-completed",
    payload: {
      provider_reference: "cap-wave4a-completed"
    }
  });
  const completedParticipant = await fetchOne<{ buyer_state: string; money_state: string }>(
    `SELECT buyer_state, money_state FROM siton.participants WHERE participant_id=$1`,
    [completed.participantId]
  );
  assert.equal(lateFail.status, "ignored");
  assert.equal(lateFail.reason, "not_waiting_for_charge_failure");
  assert.equal(completedParticipant?.buyer_state, "DealCompleted");
  assert.equal(completedParticipant?.money_state, "ChargedSuccess");

  const refunded = await seedClosedParticipant({
    suffix: "late-refund",
    dealState: "Failed",
    buyerState: "DealFailed",
    moneyState: "Refunded",
    attemptType: "refund",
    attemptClass: "success",
    correlationId: `corr-refunded-${Date.now()}`
  });
  const lateRefund = await postWebhook({
    provider: "payrail-http",
    event_id: `wave4a-late-refund-${Date.now()}`,
    event_type: "refund_issued",
    correlation_id: refunded.correlationId,
    participant_id: refunded.participantId,
    deal_id: refunded.dealId,
    provider_reference: "ref-wave4a-refunded",
    payload: {
      provider_reference: "ref-wave4a-refunded"
    }
  });
  const refundedParticipant = await fetchOne<{ buyer_state: string; money_state: string }>(
    `SELECT buyer_state, money_state FROM siton.participants WHERE participant_id=$1`,
    [refunded.participantId]
  );
  assert.equal(lateRefund.status, "ignored");
  assert.equal(lateRefund.reason, "already_refunded");
  assert.equal(refundedParticipant?.buyer_state, "DealFailed");
  assert.equal(refundedParticipant?.money_state, "Refunded");
});

await runTest("unknown truth stays unknown until reconcile success provides a real target", async () => {
  const seeded = await seedChargeAwaitingWebhook("unknown-then-reconcile");

  const unknown = await postWebhook({
    provider: "payrail-http",
    event_id: `wave4a-unknown-${Date.now()}`,
    event_type: "charge_captured",
    payload: {
      provider_reference: "cap-wave4a-unknown"
    }
  });

  const afterUnknownEvent = await webhookEventRow("payrail-http", unknown.event_id);
  const afterUnknownParticipant = await fetchOne<{ buyer_state: string; money_state: string }>(
    `SELECT buyer_state, money_state FROM siton.participants WHERE participant_id=$1`,
    [seeded.participantId]
  );
  const afterUnknownAttempt = await fetchOne<{ result_class: string }>(
    `SELECT result_class FROM siton.payment_attempts WHERE participant_id=$1 AND correlation_id=$2`,
    [seeded.participantId, seeded.correlationId]
  );

  assert.equal(unknown.status, "failed");
  assert.equal(unknown.reason, "missing_correlation_target");
  assert.equal(afterUnknownEvent?.status, "failed");
  assert.equal(afterUnknownEvent?.classification_reason, "missing_correlation_target");
  assert.equal(afterUnknownParticipant?.buyer_state, "ChargingAttempt");
  assert.equal(afterUnknownParticipant?.money_state, "ChargeAttempt");
  assert.equal(afterUnknownAttempt?.result_class, "unknown");

  const reconciled = await postWebhook({
    provider: "payrail-http",
    event_id: `wave4a-reconcile-success-${Date.now()}`,
    event_type: "charge_captured",
    correlation_id: seeded.correlationId,
    provider_reference: "cap-wave4a-reconcile",
    payload: {
      provider_reference: "cap-wave4a-reconcile"
    }
  });

  const reconciledParticipant = await fetchOne<{ buyer_state: string; money_state: string }>(
    `SELECT buyer_state, money_state FROM siton.participants WHERE participant_id=$1`,
    [seeded.participantId]
  );
  const reconciledAttempt = await fetchOne<{ result_class: string }>(
    `SELECT result_class FROM siton.payment_attempts WHERE participant_id=$1 AND correlation_id=$2`,
    [seeded.participantId, seeded.correlationId]
  );

  assert.equal(reconciled.status, "processed");
  assert.equal(reconciled.reason, "capture_success");
  assert.equal(reconciledParticipant?.buyer_state, "ChargedSuccess");
  assert.equal(reconciledParticipant?.money_state, "ChargedSuccess");
  assert.equal(reconciledAttempt?.result_class, "success");
});

await runTest("conflicting events are recorded but the logical state wins", async () => {
  const failedThenLateSuccess = await seedChargeAwaitingWebhook("conflict-charge");
  const failure = await postWebhook({
    provider: "payrail-http",
    event_id: `wave4a-charge-failed-${Date.now()}`,
    event_type: "charge_failed",
    correlation_id: failedThenLateSuccess.correlationId,
    participant_id: failedThenLateSuccess.participantId,
    deal_id: failedThenLateSuccess.dealId,
    provider_reference: "cap-wave4a-conflict",
    payload: {
      provider_reference: "cap-wave4a-conflict"
    }
  });
  assert.equal(failure.status, "processed");
  assert.equal(failure.reason, "capture_failed");

  const lateSuccess = await postWebhook({
    provider: "payrail-http",
    event_id: `wave4a-charge-success-late-${Date.now()}`,
    event_type: "charge_captured",
    correlation_id: failedThenLateSuccess.correlationId,
    participant_id: failedThenLateSuccess.participantId,
    deal_id: failedThenLateSuccess.dealId,
    provider_reference: "cap-wave4a-conflict",
    payload: {
      provider_reference: "cap-wave4a-conflict"
    }
  });

  const failedParticipant = await fetchOne<{ buyer_state: string; money_state: string }>(
    `SELECT buyer_state, money_state FROM siton.participants WHERE participant_id=$1`,
    [failedThenLateSuccess.participantId]
  );
  const failedAttempt = await fetchOne<{ result_class: string }>(
    `SELECT result_class FROM siton.payment_attempts WHERE participant_id=$1 AND correlation_id=$2`,
    [failedThenLateSuccess.participantId, failedThenLateSuccess.correlationId]
  );

  assert.equal(lateSuccess.status, "ignored");
  assert.equal(lateSuccess.reason, "not_waiting_for_charge_capture");
  assert.equal(failedParticipant?.buyer_state, "ChargeFailedCompletion");
  assert.equal(failedParticipant?.money_state, "ChargeFailedRecovery");
  assert.equal(failedAttempt?.result_class, "permanent_fail");

  const recovered = await seedRecoveryAwaitingWebhook("conflict-recovery");
  const recoverySuccess = await postWebhook({
    provider: "payrail-http",
    event_id: `wave4a-recovery-success-${Date.now()}`,
    event_type: "recovery_captured",
    correlation_id: recovered.correlationId,
    participant_id: recovered.participantId,
    deal_id: recovered.dealId,
    provider_reference: "rec-wave4a-conflict",
    payload: {
      provider_reference: "rec-wave4a-conflict"
    }
  });
  assert.equal(recoverySuccess.status, "processed");

  const lateCapture = await postWebhook({
    provider: "payrail-http",
    event_id: `wave4a-late-capture-after-recovery-${Date.now()}`,
    event_type: "charge_captured",
    correlation_id: recovered.correlationId,
    participant_id: recovered.participantId,
    deal_id: recovered.dealId,
    provider_reference: "cap-wave4a-late-after-recovery",
    payload: {
      provider_reference: "cap-wave4a-late-after-recovery"
    }
  });

  const recoveredParticipant = await fetchOne<{ buyer_state: string; money_state: string }>(
    `SELECT buyer_state, money_state FROM siton.participants WHERE participant_id=$1`,
    [recovered.participantId]
  );
  const recoveredAttempt = await fetchOne<{ result_class: string }>(
    `SELECT result_class FROM siton.payment_attempts WHERE participant_id=$1 AND correlation_id=$2`,
    [recovered.participantId, recovered.correlationId]
  );

  assert.equal(lateCapture.status, "ignored");
  assert.equal(lateCapture.reason, "not_waiting_for_charge_capture");
  assert.equal(recoveredParticipant?.buyer_state, "Recovered");
  assert.equal(recoveredParticipant?.money_state, "RecoveredCharge");
  assert.equal(recoveredAttempt?.result_class, "success");
});

await pool.end();
process.exit(0);
