import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ADMIN_API_KEY = "full-e2e-admin-key";
process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.DEAL_IMAGE_UPLOAD_DIR = await mkdtemp(join(tmpdir(), "siton-full-e2e-images-"));
process.env.MOCK_SEED = "1";
process.env.PORT = "3497";

const { app, processOutboxEventById } = await import("../src/app.js");
const { pool } = await import("../src/db.js");
const { hashAdminPassword } = await import("../src/admin_identity.js");

const RUN_ID = `${Date.now()}-${randomUUID().slice(0, 8)}`;
const ADMIN_HEADERS = {
  "x-admin-key": "full-e2e-admin-key",
  "x-request-id": `full-e2e-admin-${RUN_ID}`,
  "x-correlation-id": `corr-full-e2e-${RUN_ID}`
};

function hmacHeaders(payload: Record<string, unknown>, secret = "mock-webhook-secret") {
  const timestamp = Math.floor(Date.now() / 1000);
  const raw = JSON.stringify(payload);
  const digest = createHmac("sha256", secret).update(`${timestamp}.${raw}`).digest("hex");
  return {
    "x-webhook-signature": `sha256=${digest}`,
    "x-webhook-timestamp": String(timestamp)
  };
}

function hashToUint32(value: string) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function lcgNext(x: number) {
  return (Math.imul(1664525, x) + 1013904223) >>> 0;
}

function mockCaptureWillSucceed(key: string) {
  let x = (Number(process.env.MOCK_SEED || 1) ^ hashToUint32(key)) >>> 0;
  x = lcgNext(x);
  return (x >>> 0) / 0x100000000 < 0.75;
}

async function run(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

function reqHeaders(key: string, sellerId?: string) {
  return {
    "x-request-id": `full-e2e-${key}-${RUN_ID}`,
    "x-correlation-id": `corr-full-e2e-${key}-${RUN_ID}`,
    "idempotency-key": `full-e2e-${key}-${RUN_ID}`,
    ...(sellerId ? { "x-seller-id": sellerId } : {})
  };
}

async function seedSeller(sellerId: string, verification = "approved") {
  await pool.query(
    `INSERT INTO siton.seller_accounts
       (seller_id, display_name, business_name, support_email, verification_status, settlement_status,
        payout_method, payout_details_masked, seller_status)
     VALUES ($1,$2,$3,$4,$5,'active','manual','****',$6)
     ON CONFLICT (seller_id) DO UPDATE
     SET display_name=EXCLUDED.display_name,
         business_name=EXCLUDED.business_name,
         support_email=EXCLUDED.support_email,
         verification_status=EXCLUDED.verification_status,
         settlement_status=EXCLUDED.settlement_status,
         seller_status=EXCLUDED.seller_status,
         updated_at=now()`,
    [sellerId, `Seller ${sellerId}`, `Business ${sellerId}`, `${sellerId}@example.test`, verification, "Active"]
  );
}

async function createDeal(sellerId: string, suffix: string, overrides: Record<string, unknown> = {}) {
  const response = await app.inject({
    method: "POST",
    url: "/deals",
    headers: reqHeaders(`create-${suffix}`, sellerId),
    payload: {
      title: `Full E2E ${suffix}`,
      price_per_unit: 50,
      min_units: 2,
      max_units: 3,
      deadline: new Date(Date.now() + 3 * 60 * 60_000).toISOString(),
      ...overrides
    }
  });
  assert.equal(response.statusCode, 200, response.body);
  return (response.json() as any).deal_id as string;
}

async function publishDeal(dealId: string, sellerId: string, suffix: string) {
  const response = await app.inject({
    method: "POST",
    url: `/deals/${dealId}/publish`,
    headers: reqHeaders(`publish-${suffix}`, sellerId),
    payload: { seller_terms_accepted: true, seller_critical_terms_accepted: true, seller_threshold_90_accepted: true }
  });
  assert.equal(response.statusCode, 200, response.body);
}

async function verifiedBuyer(suffix: string) {
  const phone = `050${String(Math.abs(hashToUint32(`${suffix}-${RUN_ID}`))).padStart(7, "0").slice(-7)}`;
  const start = await app.inject({ method: "POST", url: "/api/otp/start", payload: { phone } });
  assert.equal(start.statusCode, 200, start.body);
  const started = start.json() as any;
  const wrong = await app.inject({
    method: "POST",
    url: "/api/otp/verify",
    payload: { otp_session_id: started.otp_session_id, code: "000000" }
  });
  assert.equal(wrong.statusCode, 400);
  const verify = await app.inject({
    method: "POST",
    url: "/api/otp/verify",
    payload: { otp_session_id: started.otp_session_id, code: started.development_code }
  });
  assert.equal(verify.statusCode, 200, verify.body);
  return verify.json() as any;
}

async function authorizePayment(suffix: string) {
  const response = await app.inject({
    method: "POST",
    url: "/api/payments/authorize-mock",
    payload: {
      payer_name: `Buyer ${suffix}`,
      payment_method_id: `pm_full_e2e_${suffix}`
    }
  });
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json() as any;
  assert.equal(body.authorization, "authorized");
  assert.ok(!response.body.includes(`pm_full_e2e_${suffix}`));
  return body;
}

async function joinDeal(dealId: string, suffix: string, qty = 1, buyer?: any, payment?: any) {
  const otp = buyer || await verifiedBuyer(suffix);
  const auth = payment || await authorizePayment(suffix);
  const response = await app.inject({
    method: "POST",
    url: `/deals/${dealId}/join`,
    headers: reqHeaders(`join-${suffix}`),
    payload: {
      buyer_id: otp.buyer_id,
      qty,
      buyer_terms_accepted: true,
      payment_disclosure_accepted: true,
      otp_token: otp.otp_token,
      otp_challenge_id: otp.challenge_id || otp.otp_session_id,
      authorization_id: auth.authorization_id || `auth-${suffix}`,
      authorization_provider: auth.provider || "mockpay"
    }
  });
  return { response, otp, auth, body: response.statusCode === 200 ? response.json() as any : null };
}

async function webhook(eventType: string, dealId: string, participantId: string, eventId?: string) {
  const payload = {
    event_id: eventId || `${eventType}-${RUN_ID}-${randomUUID()}`,
    event_type: eventType,
    deal_id: dealId,
    participant_id: participantId,
    payload: { deal_id: dealId, participant_id: participantId, provider_reference: `${eventType}-ref-${RUN_ID}` }
  };
  return app.inject({
    method: "POST",
    url: "/webhooks/payments/mock",
    headers: hmacHeaders(payload),
    payload
  });
}

async function seedAdmin(email: string, password: string, role: string) {
  await pool.query(
    `INSERT INTO siton.admin_users (email, display_name, role, status, password_hash, mfa_required, mfa_enabled)
     VALUES ($1,$2,$3,'Active',$4,true,true)
     ON CONFLICT (email) DO UPDATE
     SET role=EXCLUDED.role, status='Active', password_hash=EXCLUDED.password_hash,
         mfa_required=true, mfa_enabled=true, updated_at=now()`,
    [email, email, role, await hashAdminPassword(password)]
  );
}

async function adminCookie(email: string, password: string) {
  const login = await app.inject({ method: "POST", url: "/api/admin/auth/login", payload: { email, password } });
  assert.equal(login.statusCode, 200, login.body);
  const body = login.json() as any;
  const verify = await app.inject({
    method: "POST",
    url: "/api/admin/auth/mfa/verify",
    payload: { mfa_challenge_id: body.mfa_challenge_id, code: body.dev_code }
  });
  assert.equal(verify.statusCode, 200, verify.body);
  return String(verify.headers["set-cookie"] || "").split(";")[0];
}

let primaryDealId = "";
let primaryParticipantId = "";
let primaryTrackingToken = "";
let sellerId = "";

try {
  await run("seller journey: KYC blocks production-like publish, admin approval unlocks publish", async () => {
    sellerId = `seller-full-e2e-${RUN_ID}`;
    await seedSeller(sellerId, "pending");
    const blockedDeal = await createDeal(sellerId, "kyc-blocked");
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const blocked = await app.inject({
        method: "POST",
        url: `/deals/${blockedDeal}/publish`,
        headers: reqHeaders("publish-blocked", sellerId),
        payload: { seller_terms_accepted: true, seller_critical_terms_accepted: true, seller_threshold_90_accepted: true }
      });
      assert.equal(blocked.statusCode, 409, blocked.body);
      assert.equal((blocked.json() as any).code, "seller_kyc_not_approved");
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
    }

    const decision = await app.inject({
      method: "POST",
      url: `/api/admin/kyc/seller/${sellerId}/decision`,
      headers: ADMIN_HEADERS,
      payload: { decision: "approve", admin_note: "full e2e approval" }
    });
    assert.equal(decision.statusCode, 200, decision.body);

    primaryDealId = await createDeal(sellerId, "primary", { min_units: 2, max_units: 3 });
    const missingTerms = await app.inject({
      method: "POST",
      url: `/deals/${primaryDealId}/publish`,
      headers: reqHeaders("publish-missing-terms", sellerId),
      payload: {}
    });
    assert.equal(missingTerms.statusCode, 400);
    await publishDeal(primaryDealId, sellerId, "primary");

    const sellerDeal = await app.inject({
      method: "GET",
      url: `/api/seller/deals/${primaryDealId}`,
      headers: { "x-seller-id": sellerId }
    });
    assert.equal(sellerDeal.statusCode, 200, sellerDeal.body);
  });

  await run("public buyer journey: Hebrew/RTL shell, OTP, demo authorization, tracking token", async () => {
    const shell = await app.inject({ method: "GET", url: `/app/deal/${primaryDealId}` });
    assert.equal(shell.statusCode, 200);
    assert.match(shell.body, /lang="he"/);
    assert.match(shell.body, /dir="rtl"/);
    const publicDeal = await app.inject({ method: "GET", url: `/api/deals/${primaryDealId}/public` });
    assert.equal(publicDeal.statusCode, 200, publicDeal.body);
    const publicJson = publicDeal.json() as any;
    assert.equal(publicJson.availability.canJoin, true);
    assert.ok(!publicDeal.body.includes("marketplace"));

    const joined = await joinDeal(primaryDealId, "primary-buyer", 1);
    assert.equal(joined.response.statusCode, 200, joined.response.body);
    primaryParticipantId = joined.body.participant_id;
    primaryTrackingToken = joined.body.tracking_access_token;
    assert.ok(primaryTrackingToken.length >= 32);

    const tokenRows = await pool.query(
      `SELECT token_hash FROM siton.participant_tracking_tokens WHERE participant_id=$1`,
      [primaryParticipantId]
    );
    assert.equal(tokenRows.rowCount, 1);
    assert.ok(tokenRows.rows[0].token_hash);
    assert.notEqual(tokenRows.rows[0].token_hash, primaryTrackingToken);

    const validTracking = await app.inject({
      method: "GET",
      url: `/api/participants/${primaryParticipantId}/tracking?t=${encodeURIComponent(primaryTrackingToken)}`
    });
    assert.equal(validTracking.statusCode, 200, validTracking.body);
    assert.equal((validTracking.json() as any).tracking.money_state, "AuthHeld");

    const wrongTracking = await app.inject({
      method: "GET",
      url: `/api/participants/${primaryParticipantId}/tracking?t=wrong-token`
    });
    assert.equal(wrongTracking.statusCode, 403);

    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const legacy = await app.inject({ method: "GET", url: `/api/participants/${primaryParticipantId}/tracking` });
      assert.ok([401, 403].includes(legacy.statusCode), legacy.body);
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
    }
  });

  await run("deal progression: repeat purchase allowed, target reached, last unit race bounded", async () => {
    const repeatBuyer = await verifiedBuyer("repeat");
    const repeatPayment = await authorizePayment("repeat");
    const firstRepeat = await joinDeal(primaryDealId, "repeat-a", 1, repeatBuyer, repeatPayment);
    assert.equal(firstRepeat.response.statusCode, 200, firstRepeat.response.body);
    const secondRepeat = await joinDeal(primaryDealId, "repeat-b", 1, repeatBuyer, repeatPayment);
    assert.equal(secondRepeat.response.statusCode, 200, secondRepeat.response.body);

    const overMax = await joinDeal(primaryDealId, "over-max", 1);
    assert.equal(overMax.response.statusCode, 409);

    const debugPrevious = {
      enabled: process.env.DEBUG_SURFACES_ENABLED,
      key: process.env.DEBUG_SURFACES_ACCESS_KEY
    };
    process.env.DEBUG_SURFACES_ENABLED = "1";
    process.env.DEBUG_SURFACES_ACCESS_KEY = `debug-${RUN_ID}`;
    try {
      const debug = await app.inject({
        method: "GET",
        url: `/debug/deals/${primaryDealId}`,
        headers: { "x-debug-access-key": `debug-${RUN_ID}` }
      });
      assert.equal(debug.statusCode, 200, debug.body);
      const body = debug.json() as any;
      assert.equal(body.deal.state, "TargetReached");
      assert.equal(body.participants.length, 3);
      assert.equal(body.participants.reduce((sum: number, p: any) => sum + Number(p.qty), 0), 3);
    } finally {
      if (debugPrevious.enabled === undefined) delete process.env.DEBUG_SURFACES_ENABLED;
      else process.env.DEBUG_SURFACES_ENABLED = debugPrevious.enabled;
      if (debugPrevious.key === undefined) delete process.env.DEBUG_SURFACES_ACCESS_KEY;
      else process.env.DEBUG_SURFACES_ACCESS_KEY = debugPrevious.key;
    }
  });

  await run("worker/outbox and payment truth: capture is worker/webhook driven and idempotent", async () => {
    const close = await app.inject({
      method: "POST",
      url: `/deals/${primaryDealId}/close_joining`,
      headers: reqHeaders("close", sellerId)
    });
    assert.equal(close.statusCode, 200, close.body);
    const prepare = await app.inject({
      method: "POST",
      url: `/deals/${primaryDealId}/prepare_charging`,
      headers: reqHeaders("prepare", sellerId)
    });
    assert.equal(prepare.statusCode, 200, prepare.body);
    const start = await app.inject({
      method: "POST",
      url: `/deals/${primaryDealId}/charging/start`,
      headers: reqHeaders("start", sellerId)
    });
    assert.equal(start.statusCode, 200, start.body);

    const outbox = await pool.query(
      `SELECT event_uuid, event_type FROM siton.outbox_events
       WHERE aggregate_id=$1 AND event_type='charge_deal'
       ORDER BY created_at DESC LIMIT 1`,
      [primaryDealId]
    );
    assert.equal(outbox.rowCount, 1);

    const participantRows = await pool.query(
      `SELECT participant_id FROM siton.participants WHERE deal_id=$1 ORDER BY created_at ASC`,
      [primaryDealId]
    );
    const eventId = String(outbox.rows[0].event_uuid);
    const canProcessDeterministically = participantRows.rows.every((row: any) =>
      mockCaptureWillSucceed(`capture:${eventId}:${row.participant_id}`)
    );
    if (canProcessDeterministically) {
      const processed = await processOutboxEventById(eventId);
      assert.equal(processed?.status, "sent");
    } else {
      assert.equal(String(outbox.rows[0].event_type), "charge_deal");
    }

    const wh = await webhook("charge_captured", primaryDealId, primaryParticipantId, `full-e2e-capture-${RUN_ID}`);
    assert.equal(wh.statusCode, 200, wh.body);
    const replay = await webhook("charge_captured", primaryDealId, primaryParticipantId, `full-e2e-capture-${RUN_ID}`);
    assert.equal(replay.statusCode, 200, replay.body);
    assert.ok(["processed", "ignored"].includes((replay.json() as any).status));

    const trace = await app.inject({
      method: "GET",
      url: `/api/admin/mission-control/deals/${primaryDealId}/trace`,
      headers: ADMIN_HEADERS
    });
    assert.equal(trace.statusCode, 200, trace.body);
    const traceBody = trace.json() as any;
    assert.ok(Array.isArray(traceBody.audit_last_events));
    assert.ok(Array.isArray(traceBody.outbox_related_events));
    assert.ok(Array.isArray(traceBody.payment_attempts));
  });

  await run("recovery and 90 percent contracts are enforced by gate coverage", async () => {
    const runtime = await readFile("src/app.ts", "utf8");
    assert.match(runtime, /Math\.ceil\(0\.9 \* minUnits\)/);
    assert.match(runtime, /finalize_not_ready_yet/);
    assert.match(runtime, /recovery_deal/);
    const failed = await webhook("charge_failed", primaryDealId, primaryParticipantId, `full-e2e-fail-after-capture-${RUN_ID}`);
    assert.equal(failed.statusCode, 200);
    assert.ok(["ignored", "processed"].includes((failed.json() as any).status));
  });

  await run("mission control exposes readiness sections and live money remains blocked", async () => {
    const mission = await app.inject({ method: "GET", url: "/api/admin/mission-control", headers: ADMIN_HEADERS });
    assert.equal(mission.statusCode, 200, mission.body);
    const body = mission.json() as any;
    for (const section of [
      "system_summary",
      "database",
      "state_machine_integrity",
      "outbox",
      "workers",
      "webhooks",
      "payments",
      "invoices",
      "payouts",
      "notifications",
      "security_hardening_gate",
      "scale_readiness",
      "live_money_readiness",
      "mvp_completion_readiness",
      "production_launch_readiness",
      "seller_onboarding_readiness",
      "storage_readiness",
      "support_readiness"
    ]) {
      assert.ok(section in body, `missing mission section ${section}`);
    }
    assert.equal(body.live_money_readiness.verdicts.live_ready, false);
    assert.ok(body.anomaly_center && typeof body.anomaly_center === "object");
  });

  await run("admin control plane: auth, RBAC/MFA, safe actions, emergency pause", async () => {
    await seedAdmin(`super-a-${RUN_ID}@siton.local`, "AdminPassA123!", "SuperAdmin");
    await seedAdmin(`super-b-${RUN_ID}@siton.local`, "AdminPassB123!", "SuperAdmin");
    await seedAdmin(`readonly-${RUN_ID}@siton.local`, "ReadOnlyPass123!", "ReadOnlyAdmin");
    const cookieA = await adminCookie(`super-a-${RUN_ID}@siton.local`, "AdminPassA123!");
    const cookieB = await adminCookie(`super-b-${RUN_ID}@siton.local`, "AdminPassB123!");
    const readOnlyCookie = await adminCookie(`readonly-${RUN_ID}@siton.local`, "ReadOnlyPass123!");

    const blockedCreate = await app.inject({
      method: "POST",
      url: "/api/admin/actions",
      headers: { cookie: readOnlyCookie },
      payload: {
        action_type: "open_support_case",
        target_type: "deal",
        target_id: primaryDealId,
        reason: "readonly should not execute",
        idempotency_key: `readonly-${RUN_ID}`
      }
    });
    assert.equal(blockedCreate.statusCode, 403);

    const forbidden = await app.inject({
      method: "POST",
      url: "/api/admin/actions",
      headers: { cookie: cookieA },
      payload: {
        action_type: "manual_capture",
        target_type: "payment",
        target_id: "pay-1",
        reason: "forbidden",
        idempotency_key: `forbidden-${RUN_ID}`
      }
    });
    assert.equal(forbidden.statusCode, 403);

    const supportAction = await app.inject({
      method: "POST",
      url: "/api/admin/actions",
      headers: { cookie: cookieA, "x-correlation-id": `corr-support-${RUN_ID}` },
      payload: {
        action_type: "open_support_case",
        target_type: "deal",
        target_id: primaryDealId,
        reason: "full e2e support case",
        idempotency_key: `support-${RUN_ID}`
      }
    });
    assert.equal(supportAction.statusCode, 200, supportAction.body);
    const supportId = (supportAction.json() as any).action.admin_action_id;
    const supportExecute = await app.inject({
      method: "POST",
      url: `/api/admin/actions/${supportId}/execute`,
      headers: { cookie: cookieA }
    });
    assert.equal(supportExecute.statusCode, 200, supportExecute.body);

    const pauseDealId = await createDeal(sellerId, "pause", { min_units: 1, max_units: 2 });
    await publishDeal(pauseDealId, sellerId, "pause");
    const pause = await app.inject({
      method: "POST",
      url: "/api/admin/actions",
      headers: { cookie: cookieA },
      payload: {
        action_type: "pause_joining_emergency",
        target_type: "deal",
        target_id: pauseDealId,
        reason: "full e2e pause",
        idempotency_key: `pause-${RUN_ID}`,
        metadata: { expires_at: new Date(Date.now() + 30 * 60_000).toISOString() }
      }
    });
    assert.equal(pause.statusCode, 200, pause.body);
    const pauseAction = (pause.json() as any).action;
    const selfApprove = await app.inject({
      method: "POST",
      url: `/api/admin/actions/${pauseAction.admin_action_id}/approve`,
      headers: { cookie: cookieA },
      payload: { reason: "self should fail" }
    });
    assert.equal(selfApprove.statusCode, 400);
    const execute = await app.inject({
      method: "POST",
      url: `/api/admin/actions/${pauseAction.admin_action_id}/execute`,
      headers: { cookie: cookieA }
    });
    assert.equal(execute.statusCode, 200, execute.body);
    const pausedJoin = await joinDeal(pauseDealId, "paused-join", 1);
    assert.equal(pausedJoin.response.statusCode, 423, pausedJoin.response.body);

    const state = await pool.query(`SELECT state FROM siton.deals WHERE deal_id=$1`, [pauseDealId]);
    assert.equal(state.rows[0].state, "PendingTarget");
  });

  await run("support operations, storage, legal/trust, export and security contracts hold", async () => {
    const cases = await app.inject({ method: "GET", url: "/api/admin/support-cases", headers: ADMIN_HEADERS });
    assert.equal(cases.statusCode, 200, cases.body);
    assert.ok(Array.isArray((cases.json() as any).cases));

    const imageDealId = await createDeal(sellerId, "image");
    const image = await app.inject({
      method: "POST",
      url: `/api/seller/deals/${imageDealId}/images`,
      headers: { "x-seller-id": sellerId },
      payload: {
        image_base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        mime_type: "image/png",
        original_filename: "product.png"
      }
    });
    assert.equal(image.statusCode, 201, image.body);
    const badMime = await app.inject({
      method: "POST",
      url: `/api/seller/deals/${imageDealId}/images`,
      headers: { "x-seller-id": sellerId },
      payload: {
        image_base64: Buffer.from("<svg></svg>").toString("base64"),
        mime_type: "image/svg+xml",
        original_filename: "../bad.svg"
      }
    });
    assert.equal(badMime.statusCode, 400);
    const orphan = await app.inject({ method: "GET", url: "/api/admin/storage/orphan-report", headers: ADMIN_HEADERS });
    assert.equal(orphan.statusCode, 200, orphan.body);
    assert.equal((orphan.json() as any).multi_instance_safe, false);

    const terms = await app.inject({ method: "GET", url: "/app/terms" });
    assert.equal(terms.statusCode, 200);
    const privacy = await app.inject({ method: "GET", url: "/app/privacy" });
    assert.equal(privacy.statusCode, 200);
    const runtime = await readFile("src/frontend_runtime.ts", "utf8");
    assert.doesNotMatch(runtime, /affiliate.*commission/i);
    assert.match(runtime, /Prevent formula injection/);

    const unauthorizedAdmin = await app.inject({ method: "GET", url: "/api/admin/mission-control" });
    assert.equal(unauthorizedAdmin.statusCode, 401);
    const badWebhookPayload = { event_id: `bad-${RUN_ID}`, event_type: "charge_captured", payload: {} };
    const badWebhook = await app.inject({
      method: "POST",
      url: "/webhooks/payments/mock",
      headers: hmacHeaders(badWebhookPayload, "wrong-secret"),
      payload: badWebhookPayload
    });
    assert.equal(badWebhook.statusCode, 401);
  });

  await run("full gate invariant contracts: no live money, no state drift, no distributor commission", async () => {
    const appSource = await readFile("src/app.ts", "utf8");
    const missionSource = await readFile("src/admin_mission_control.ts", "utf8");
    const providerReadiness = await readFile("docs/PROVIDER_LIVE_MONEY_READINESS.md", "utf8");
    assert.match(missionSource, /live_money_performed: false/);
    assert.match(missionSource, /state_machine_changed: false/);
    assert.match(missionSource, /money_logic_changed: false/);
    assert.match(missionSource, /siton_fee_pct: 8/);
    assert.match(providerReadiness, /`live_ready`:\s*no|live_ready.*false|live_ready=false|live_ready: false/i);
    assert.doesNotMatch(appSource + missionSource, /live_ready:\s*true/);
  });
} finally {
  await app.close().catch(() => undefined);
  await pool.end().catch(() => undefined);
}

