import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import pg from "pg";

process.env.DISABLE_OUTBOX_WORKER = "1";

const { app } = await import("../src/app.js");
const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton";
const pool = new Pool({ connectionString: DATABASE_URL });

async function runTest(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

async function createDeal(suffix: string, opts: { min?: number; max?: number; publish?: boolean } = {}) {
  const unique = `buyer-tracking-${suffix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const response = await app.inject({
    method: "POST",
    url: "/deals",
    headers: {
      "x-request-id": `buyer-tracking-create-${unique}`,
      "idempotency-key": `buyer-tracking-create-${unique}`
    },
    payload: {
      title: `Buyer Tracking ${unique}`,
      price_per_unit: 42,
      min_units: opts.min ?? 10,
      max_units: opts.max ?? 20,
      deadline: new Date(Date.now() + 4 * 60 * 60_000).toISOString(),
      delivery_options: [
        { option_type: "pickup", label: "Pickup", cost: 0, sort_order: 0 },
        { option_type: "delivery", label: "Courier", cost: 15, sort_order: 1 }
      ]
    }
  });
  assert.equal(response.statusCode, 200, response.body);
  const dealId = (response.json() as any).deal_id as string;

  if (opts.publish !== false) {
    const publish = await app.inject({
      method: "POST",
      url: `/deals/${dealId}/publish`,
      headers: {
        "x-request-id": `buyer-tracking-publish-${unique}`,
        "idempotency-key": `buyer-tracking-publish-${unique}`
      },
      payload: { seller_terms_accepted: true, seller_critical_terms_accepted: true, seller_threshold_90_accepted: true }
    });
    assert.equal(publish.statusCode, 200, publish.body);
  }

  return dealId;
}

async function verifiedOtpForBuyer(dealId: string, suffix: string) {
  const phoneDigits = String(
    Math.abs(Array.from(`${dealId}-${suffix}`).reduce((sum, ch) => sum + ch.charCodeAt(0), 0))
  ).padStart(7, "0").slice(-7);
  const request = await app.inject({
    method: "POST",
    url: "/api/otp/start",
    payload: { phone: `050${phoneDigits}`, deal_id: dealId }
  });
  assert.equal(request.statusCode, 200, request.body);
  const requested = request.json() as any;
  const verify = await app.inject({
    method: "POST",
    url: "/api/otp/verify",
    payload: {
      otp_session_id: requested.otp_session_id,
      code: requested.development_code
    }
  });
  assert.equal(verify.statusCode, 200, verify.body);
  return verify.json() as any;
}

async function firstDeliveryOptionId(dealId: string) {
  const response = await app.inject({ method: "GET", url: `/api/deals/${dealId}/public` });
  assert.equal(response.statusCode, 200, response.body);
  return (response.json() as any).deal.delivery_options[0].option_id as string;
}

async function joinDeal(dealId: string, suffix: string, qty: number, buyerId = `buyer-${suffix}`) {
  const unique = `${suffix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const otp = await verifiedOtpForBuyer(dealId, unique);
  const response = await app.inject({
    method: "POST",
    url: `/deals/${dealId}/join`,
    headers: {
      "x-request-id": `buyer-tracking-join-${unique}`,
      "idempotency-key": `buyer-tracking-join-${unique}`
    },
    payload: {
      buyer_id: buyerId,
      qty,
      delivery_option_id: await firstDeliveryOptionId(dealId),
      buyer_terms_accepted: true,
      payment_disclosure_accepted: true,
      otp_token: otp.otp_token,
      otp_challenge_id: otp.challenge_id || otp.otp_session_id,
      authorization_id: `auth-${unique}`,
      authorization_provider: "mockpay",
      delivery_address: "Test Street 10",
      delivery_city: "Tel Aviv"
    }
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json() as { participant_id: string };
}

async function forceDealState(dealId: string, state: "Completed" | "Failed" | "Cancelled") {
  const paths: Record<string, Array<{ to: string; action: string }>> = {
    Completed: [
      { to: "TargetReached", action: "deal.target_reached" },
      { to: "ClosedForJoining", action: "deal.close_joining" },
      { to: "ReadyForCharging", action: "deal.prepare_charging" },
      { to: "Charging", action: "charging.start" },
      { to: "CompletionWindow", action: "charging.to_completion_window" },
      { to: "Completed", action: "charging.finalize_completed" }
    ],
    Failed: [{ to: "Failed", action: "deal.deadline_check" }],
    Cancelled: [{ to: "Cancelled", action: "deal.cancel" }]
  };
  const path = paths[state];
  assert.ok(path, `unsupported forced state ${state}`);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT set_config('siton.in_atomic', 'true', true)`);
    await client.query(`SELECT set_config('app.in_atomic', 'true', true)`);
    await client.query(`SELECT set_config('siton.audit_written', '1', true)`);
    await client.query(`SELECT set_config('siton.outbox_written', '1', true)`);
    for (const step of path) {
      await client.query(`SELECT set_config('siton.action_name', $1, true)`, [step.action]);
      await client.query(`UPDATE siton.deals SET state=$2 WHERE deal_id=$1`, [dealId, step.to]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function forceParticipantRecovery(participantId: string) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT set_config('siton.in_atomic', 'true', true)`);
    await client.query(`SELECT set_config('app.in_atomic', 'true', true)`);
    await client.query(`SELECT set_config('siton.audit_written', '1', true)`);
    await client.query(`SELECT set_config('siton.outbox_written', '1', true)`);
    await client.query(`SELECT set_config('siton.action_name', 'test.buyer_tracking_recovery', true)`);
    const dealRow = await client.query(
      `SELECT deal_id FROM siton.participants WHERE participant_id=$1`,
      [participantId]
    );
    const dealId = dealRow.rows[0]?.deal_id as string | undefined;
    if (dealId) {
      const completionWindowUntil = new Date(Date.now() + 30 * 60_000).toISOString();
      const dealStatePath = ["TargetReached", "ClosedForJoining", "ReadyForCharging", "Charging", "CompletionWindow"];
      for (const nextState of dealStatePath) {
        await client.query(`UPDATE siton.deals SET state=$2 WHERE deal_id=$1`, [dealId, nextState]);
      }
      await client.query(
        `UPDATE siton.deals SET completion_window_until=$2 WHERE deal_id=$1`,
        [dealId, completionWindowUntil]
      );
    }
    for (const buyerState of ["LockedIn", "ChargingAttempt", "ChargeFailedCompletion"]) {
      await client.query(`UPDATE siton.participants SET buyer_state=$2 WHERE participant_id=$1`, [participantId, buyerState]);
    }
    for (const moneyState of ["AuthLocked", "ChargeAttempt", "ChargeFailedRecovery"]) {
      await client.query(`UPDATE siton.participants SET money_state=$2 WHERE participant_id=$1`, [participantId, moneyState]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function scanKeys(value: unknown, blocked: RegExp, path: string[] = []) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanKeys(item, blocked, [...path, String(index)]));
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    assert.doesNotMatch([...path, key].join("."), blocked);
    scanKeys(child, blocked, [...path, key]);
  }
}

async function tracking(participantId: string) {
  const response = await app.inject({ method: "GET", url: `/api/participants/${participantId}/tracking` });
  assert.equal(response.statusCode, 200, response.body);
  return response.json() as any;
}

async function main() {
  const dealId = await createDeal("live", { min: 10, max: 20 });
  const first = await joinDeal(dealId, "first", 2, "repeat-buyer");
  const second = await joinDeal(dealId, "second", 4, "repeat-buyer");
  const third = await joinDeal(dealId, "third", 3, "another-buyer");

  await runTest("tracking endpoint returns personal status and live progress", async () => {
    const body = await tracking(first.participant_id);
    assert.equal(body.tracking.participant_id, first.participant_id);
    assert.equal(body.tracking.qty, 2);
    assert.equal(body.tracking.personal_status.action_required, false);
    assert.equal(body.tracking.progress.current_units, 9);
    assert.equal(
      body.tracking.progress.remaining_to_minimum,
      Math.max(0, Number(body.tracking.progress.target_units) - 9)
    );
    assert.equal(body.tracking.progress.max_units, 20);
    assert.equal(body.tracking.live.mechanism, "polling");
    assert.equal(body.tracking.live.interval_ms, 6000);
  });

  await runTest("progress chart is chronological and aggregates repeat purchases", async () => {
    const body = await tracking(second.participant_id);
    const points = body.tracking.chart_points;
    assert.equal(points.length, 3);
    assert.deepEqual(points.map((point: any) => point.added_units), [2, 4, 3]);
    assert.deepEqual(points.map((point: any) => point.cumulative_units), [2, 6, 9]);
    const sorted = [...points].sort((a: any, b: any) => Date.parse(a.at) - Date.parse(b.at));
    assert.deepEqual(points, sorted);
  });

  await runTest("activity feed and live payload are anonymous and do not expose payment data", async () => {
    const body = await tracking(third.participant_id);
    const feedText = JSON.stringify(body.tracking.activity_feed);
    assert.match(feedText, /נוספו|נוספה/);
    assert.doesNotMatch(feedText, /repeat-buyer|another-buyer|050|Test Street|Tel Aviv|buyer_email|buyer_phone|delivery_address/i);
    scanKeys(body.tracking.live, /buyer|phone|email|address|card|token|secret|provider|payment|authorization/i);
    scanKeys(body.tracking.activity_feed, /buyer|phone|email|address|card|token|secret|provider|payment|authorization/i);
  });

  await runTest("terminal deal states expose success and failure narratives", async () => {
    const completedDeal = await createDeal("completed");
    const completedJoin = await joinDeal(completedDeal, "completed", 3);
    await forceDealState(completedDeal, "Completed");
    const completed = await tracking(completedJoin.participant_id);
    assert.equal(completed.tracking.deal_status.kind, "success");
    assert.match(completed.tracking.deal_status.title, /הושלמה/);

    const failedDeal = await createDeal("failed");
    const failedJoin = await joinDeal(failedDeal, "failed", 3);
    await forceDealState(failedDeal, "Failed");
    const failed = await tracking(failedJoin.participant_id);
    assert.equal(failed.tracking.deal_status.kind, "failed");
    assert.match(failed.tracking.deal_status.title, /לא הושלמה/);

    const cancelledDeal = await createDeal("cancelled", { publish: false });
    await forceDealState(cancelledDeal, "Cancelled");
    const cancelledParticipantId = (await pool.query(
      `INSERT INTO siton.participants (deal_id, buyer_id, qty, buyer_state, money_state, delivery_cost)
       VALUES ($1,'cancelled-buyer',1,'JoinedAuthorized','AuthHeld',0)
       RETURNING participant_id`,
      [cancelledDeal]
    )).rows[0].participant_id;
    const cancelled = await tracking(cancelledParticipantId);
    assert.equal(cancelled.tracking.deal_status.kind, "cancelled");
  });

  await runTest("recovery CTA appears only when participant requires action", async () => {
    await forceParticipantRecovery(first.participant_id);
    const recovery = await tracking(first.participant_id);
    assert.equal(recovery.tracking.personal_status.action_required, true);
    assert.match(recovery.tracking.personal_status.title, /תשלום/);
    const normal = await tracking(second.participant_id);
    assert.equal(normal.tracking.personal_status.action_required, false);
  });

  await runTest("frontend tracking command center renders live, chart, activity, and no fake discovery", async () => {
    const [appJs, stylesCss] = await Promise.all([
      readFile("frontend/app.js", "utf8"),
      readFile("frontend/styles.css", "utf8")
    ]);
    const trackingSlice = appJs.slice(appJs.indexOf("function renderTrackingPage"), appJs.indexOf("function renderHome()"));
    assert.match(trackingSlice, /מרכז מעקב קונה חי/);
    assert.match(trackingSlice, /renderTrackingProgressChart/);
    assert.match(trackingSlice, /renderTrackingActivityFeed/);
    assert.match(trackingSlice, /כרגע לא נדרשת ממך פעולה/);
    assert.match(trackingSlice, /TRACKING_POLL_INTERVAL_MS/);
    assert.match(stylesCss, /\.tracking-chart/);
    assert.match(stylesCss, /\.tracking-activity-feed/);
    assert.doesNotMatch(trackingSlice, /marketplace|catalog|public discovery|global feed|inbox|private chat/i);
    assert.doesNotMatch(trackingSlice, /commission|payout/i);
  });
}

try {
  await main();
  await pool.end();
  await app.close();
  process.exit(0);
} catch (error) {
  await pool.end().catch(() => undefined);
  await app.close().catch(() => undefined);
  console.error(error);
  process.exit(1);
}

