import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { withForcedTx, forcedDealPath, forcedDealStep, forcedParticipantStep } from "./helpers/forced_state.js";

process.env.DISABLE_OUTBOX_WORKER = "1";

const { app } = await import("../src/app.js");
const { issueParticipantTrackingToken } = await import("../src/participant_tracking_security.js");
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
        { option_type: "pickup", label: "Pickup — Herzl 12, Tel Aviv", cost: 0, sort_order: 0 },
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
  const joined = response.json() as { participant_id: string; tracking_access_token: string };
  trackingTokens.set(joined.participant_id, joined.tracking_access_token);
  return joined;
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
  // Per-row audit enforcement (migration 076): forced steps write audit rows.
  await withForcedTx(pool, path[0]!.action, async (client) => {
    await forcedDealPath(client, dealId, path);
  });
}

async function forceParticipantRecovery(participantId: string) {
  const ACTION = "test.buyer_tracking_recovery";
  await withForcedTx(pool, ACTION, async (client) => {
    const dealRow = await client.query(
      `SELECT deal_id FROM siton.participants WHERE participant_id=$1`,
      [participantId]
    );
    const dealId = dealRow.rows[0]?.deal_id as string | undefined;
    if (dealId) {
      const completionWindowUntil = new Date(Date.now() + 30 * 60_000).toISOString();
      for (const nextState of ["TargetReached", "ClosedForJoining", "ReadyForCharging", "Charging", "CompletionWindow"]) {
        await forcedDealStep(client, dealId, nextState, ACTION);
      }
      await client.query(
        `UPDATE siton.deals SET completion_window_until=$2 WHERE deal_id=$1`,
        [dealId, completionWindowUntil]
      );
    }
    for (const buyerState of ["LockedIn", "ChargingAttempt", "ChargeFailedCompletion"]) {
      await forcedParticipantStep(client, participantId, { buyer_state: buyerState }, ACTION);
    }
    for (const moneyState of ["AuthLocked", "ChargeAttempt", "ChargeFailedRecovery"]) {
      await forcedParticipantStep(client, participantId, { money_state: moneyState }, ACTION);
    }
  });
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

// Red-team fix A5: the tracking view always requires the join-issued
// tracking credential, so joinDeal records it per participant.
const trackingTokens = new Map<string, string>();

async function tracking(participantId: string) {
  const token = trackingTokens.get(participantId) || "";
  const response = await app.inject({ method: "GET", url: `/api/participants/${participantId}/tracking?t=${encodeURIComponent(token)}` });
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
    // DB-seeded participant (no join): issue its tracking credential directly.
    const cancelledToken = await issueParticipantTrackingToken(pool as any, {
      participant_id: cancelledParticipantId,
      deal_id: cancelledDeal,
      purpose: "tracking",
      issued_via: "test_seed"
    });
    trackingTokens.set(cancelledParticipantId, cancelledToken.token);
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

  // RETARGET (lr2): this test used to slice renderTrackingPage..renderHome() (a
  // legacy renderer with zero call sites). It now reads the surfaces that are
  // actually served: /app renderCtonTrackingPage and the React product page
  // web/src/pages/track.tsx (docs/CURRENT_ARCHITECTURE_2026-09-30.md).
  function extractFunction(source: string, name: string): string {
    const header = new RegExp(`(?:^|\\n)(?:async )?function ${name}\\(`, "g");
    const matches = [...source.matchAll(header)];
    assert.equal(matches.length, 1, `expected exactly one top-level function ${name} in frontend/app.js, found ${matches.length}`);
    const first = matches[0]!;
    const start = first.index as number;
    const nextHeader = /\n(?:async )?function \w+\(/g;
    nextHeader.lastIndex = start + first[0].length;
    const next = nextHeader.exec(source);
    const slice = source.slice(start, next ? next.index : source.length);
    assert.ok(slice.length > 400, `${name} slice is suspiciously small (${slice.length} chars); the assertion would be vacuous`);
    return slice;
  }

  const [appJs, stylesCss, trackTsx] = await Promise.all([
    readFile("frontend/app.js", "utf8"),
    readFile("frontend/styles.css", "utf8"),
    readFile("web/src/pages/track.tsx", "utf8")
  ]);
  assert.match(appJs, /route\.name === "tracking"\) return renderCtonTrackingPage\(/);
  assert.ok(trackTsx.length > 2000, "web/src/pages/track.tsx must be readable and non-empty");
  const ctonTracking = extractFunction(appJs, "renderCtonTrackingPage");
  const liveSurfaces = [["renderCtonTrackingPage", ctonTracking], ["web/src/pages/track.tsx", trackTsx]] as const;

  await runTest("live tracking surfaces render live progress, activity, polling, and the action-required CTA", async () => {
    // Requirement: live aggregate progress toward the deal target.
    // /app live construct: renderCtonProgressCard (legacy: renderProgressBlock); React: GroupMeter.
    assert.match(ctonTracking, /renderCtonProgressCard\(/);
    assert.match(ctonTracking, /progress_to_minimum_pct/);
    assert.match(trackTsx, /<GroupMeter/);
    assert.match(trackTsx, /progress\?\.current_units/);
    // Requirement: anonymous activity feed of real deal events. Delivered by React only
    // (/app live renderCtonTrackingPage has no feed; legacy renderTrackingActivityFeed is dead).
    assert.match(trackTsx, /tr\.activity_feed\.slice\(0, 10\)/);
    assert.match(trackTsx, /track\.what_happened_deal/);
    // Requirement: the personal-status CTA appears only when the server says action is required.
    // React renders the CTA only when personal_status.cta carries href+label (server-gated);
    // legacy copy "כרגע לא נדרשת ממך פעולה" is recorded in the GAP test below.
    assert.match(trackTsx, /tr\.personal_status\?\.cta\?\.href && tr\.personal_status\?\.cta\?\.label \?/);
    assert.match(trackTsx, /data-testid="track-personal-cta"/);
    // Requirement: the tracking screen refreshes itself live.
    // /app: the route poller uses TRACKING_POLL_INTERVAL_MS for tracking routes (same constant, set by the router, not the renderer).
    assert.match(appJs, /const TRACKING_POLL_INTERVAL_MS = 6000;/);
    assert.match(appJs, /startsWith\("tracking:"\)\s*\? TRACKING_POLL_INTERVAL_MS/);
    // React: TrackPage polls every 6 s.
    assert.match(trackTsx, /setInterval\(load, 6_000\)/);
    // Negatives: no discovery / chat / money-distribution surface on live tracking.
    for (const [label, slice] of liveSurfaces) {
      assert.doesNotMatch(slice, /marketplace|catalog|public discovery|global feed|inbox|private chat/i, label);
      assert.doesNotMatch(slice, /commission|payout/i, label);
    }
  });

  // GAP records: requirements asserted by the legacy test that the LIVE product does not deliver.
  // They are documented, not pinned to dead code. Each entry fails if a live surface starts
  // delivering it, so the gap is retired deliberately (retarget the assertion) rather than silently.
  await runTest("GAP record: legacy-only tracking requirements absent from the live product (owner decision)", async () => {
    const gaps: Array<{ requirement: string; legacy: string; liveDelivers: RegExp; where: string }> = [
      { requirement: "live-buyer-center headline eyebrow", legacy: "מרכז מעקב קונה חי", liveDelivers: /מרכז מעקב קונה חי/, where: "/app + React" },
      { requirement: "cumulative progress CHART over time (chart_points)", legacy: "renderTrackingProgressChart", liveDelivers: /renderTrackingProgressChart|chart_points|tracking-chart/, where: "/app + React" },
      { requirement: "anonymous activity feed on the /app shell", legacy: "renderTrackingActivityFeed", liveDelivers: /renderTrackingActivityFeed|activity_feed/, where: "/app renderCtonTrackingPage (React has it)" },
      { requirement: "explicit 'no action needed now' text", legacy: "כרגע לא נדרשת ממך פעולה", liveDelivers: /כרגע לא נדרשת ממך פעולה/, where: "/app + React" }
    ];
    for (const gap of gaps) {
      const scope = gap.where.startsWith("/app renderCtonTrackingPage") ? ctonTracking : `${ctonTracking}\n${trackTsx}`;
      const delivered = gap.liveDelivers.test(scope);
      console.log(`GAP legacy-only requirement not in live product: ${gap.requirement} [legacy: ${gap.legacy}; checked: ${gap.where}] — delivered by live: ${delivered}`);
      assert.equal(delivered, false, `live surface now delivers "${gap.requirement}": retarget the legacy assertion to it and remove this GAP entry`);
    }
    // Legacy CSS for the dead chart/activity markup: retained until the renderer-deletion PR removes both together.
    assert.match(stylesCss, /\.tracking-chart/);
    assert.match(stylesCss, /\.tracking-activity-feed/);
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

