// PILOT COMMUNICATIONS — canonical business event → exactly one transactional
// notification, proven on the REAL runtime (in-process Fastify, fresh migrated
// DB, mock money, dry-run provider — ZERO external delivery):
//   * seller_deal_published / buyer_joined_authorized / target reached (N
//     buyers + 1 seller) / deal completed / deal failed (finalize + deadline) /
//     voucher + ticket issued / recovery required + payment recovered (webhook
//     truth) / seller inquiry pointer / KYC approve + reject / admin alert
//   * recipients come from canonical rows only (buyer phone of THAT
//     participant, seller account of THAT deal, configured admin destination)
//   * deterministic idempotency: HTTP replay, outbox replay, duplicate webhook,
//     double admin submit, reopen → no second intended notification
//   * post-commit truth: a rolled-back transition leaves no notification
//   * template truth: mock money never claims a charge; no code, no message
//     body, no admin note, no legacy brand in any rendered message
//   * the real Worker maintenance pass drains the queue through the dry-run
//     provider and no attempt ever runs in a real provider mode
import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";

process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.ADMIN_API_KEY = "pilot-comms-admin-key";
process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.MOCK_SEED = "7";
process.env.COMPLETION_WINDOW_MINUTES = "-1";
process.env.PUBLIC_BASE_URL = "https://pilot.c-ton.test/";
process.env.ADMIN_ALERT_EMAIL = "ops-alerts@siton.test";
process.env.PAYMENT_WEBHOOK_SECRET = "pilot-comms-webhook-secret";
process.env.PAYMENT_WEBHOOK_PROVIDER = "mockpay";
process.env.NOTIFICATION_PROVIDER = "log-only";
process.env.NOTIFICATION_PROVIDER_MODE = "dry-run";
process.env.RATE_LIMIT_MAX = process.env.RATE_LIMIT_MAX || "20000";
process.env.RATE_LIMIT_SENSITIVE_MAX = process.env.RATE_LIMIT_SENSITIVE_MAX || "20000";
process.env.RATE_LIMIT_READ_MAX = process.env.RATE_LIMIT_READ_MAX || "20000";
process.env.PORT = process.env.PORT || "3611";

const { app, processOutboxEventById, issueFulfillmentForCompletedDeal, runWorkerMaintenance, withTx } = await import("../src/app.js");
const { pool } = await import("../src/db.js");
const { renderNotification, NOTIFICATION_EVENT_TYPES, supportedChannels } = await import("../src/notification_templates.js");
const { enqueueNotification, NotificationValidationError, describeNotificationForOperator } = await import("../src/notification_dispatch.js");
const { enqueueAdminSecurityAlert, enqueueSellerKycDecisionNotification, enqueueBuyerDealNotification, notificationLinks } = await import("../src/notification_events.js");
const { hashParticipantTrackingToken } = await import("../src/participant_tracking_security.js");
const { armTestFault, resetTestFaults } = await import("../src/fault_injection.js");
const { establishNamedAdminSession } = await import("./helpers/named_admin_session.js");

const RUN = `${Date.now().toString(36)}${randomUUID().slice(0, 6)}`;
const ORIGIN = "https://pilot.c-ton.test";
const sellerA = `seller-comms-a-${RUN}`;
const sellerB = `seller-comms-b-${RUN}`;
const SELLER_A_EMAIL = `${sellerA}@siton.test`;
const SELLER_B_EMAIL = `${sellerB}@siton.test`;
const HA = { "x-seller-id": sellerA, "content-type": "application/json" };
const HB = { "x-seller-id": sellerB, "content-type": "application/json" };
const { cookie: ADMIN_COOKIE } = await establishNamedAdminSession(app, pool);
const ADMIN = { "x-admin-key": "pilot-comms-admin-key", cookie: ADMIN_COOKIE, "content-type": "application/json" };

let passed = 0;
let failed = 0;
const report: string[] = [];
async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`PASS ${name}`); passed++; }
  catch (e: any) { console.error(`FAIL ${name}: ${e?.stack || e?.message || e}`); failed++; }
}

// ── helpers ──────────────────────────────────────────────────────────────────
let phoneSeq = 100;
function nextPhone() { phoneSeq += 1; return `05011${String(phoneSeq).padStart(5, "0")}`; }

async function seedSeller(sellerId: string, email: string, status = "approved") {
  await pool.query(
    `INSERT INTO siton.seller_accounts
       (seller_id, display_name, business_name, support_email, login_email, verification_status,
        settlement_status, payout_method, payout_details_masked, seller_status)
     VALUES ($1,$2,$3,$4,$4,$5,'active','manual','****','Active')
     ON CONFLICT (seller_id) DO UPDATE SET support_email=EXCLUDED.support_email, login_email=EXCLUDED.login_email,
       verification_status=EXCLUDED.verification_status, updated_at=now()`,
    [sellerId, `Seller ${sellerId}`, `עסק ${sellerId}`, email, status]
  );
}

async function createDeal(headers: Record<string, string>, body: Record<string, unknown>) {
  const res = await app.inject({
    method: "POST", url: "/deals", headers: { ...headers, "idempotency-key": `create-${randomUUID()}` },
    payload: {
      title: `עסקת פיילוט ${RUN}`, description_short: "תקשורת", description: "תיאור",
      price_per_unit: 40, min_units: 4, max_units: 12,
      deadline: new Date(Date.now() + 3 * 3600e3).toISOString(),
      deal_type: "physical_product",
      delivery_options: [{ option_type: "pickup", label: "רח׳ הרצל 12, תל אביב", cost: 0, sort_order: 0 }],
      ...body
    }
  });
  assert.equal(res.statusCode, 200, res.body);
  const json = res.json() as any;
  return String(json.deal?.deal_id || json.deal_id);
}

async function publish(headers: Record<string, string>, dealId: string, idem = `publish-${dealId}`) {
  return app.inject({
    method: "POST", url: `/deals/${dealId}/publish`, headers: { ...headers, "idempotency-key": idem },
    payload: { seller_terms_accepted: true, seller_critical_terms_accepted: true, seller_threshold_90_accepted: true }
  });
}

async function authorize(suffix: string) {
  const res = await app.inject({ method: "POST", url: "/api/payments/authorize-mock", payload: { payer_name: `Buyer ${suffix}`, payment_method_id: `pm_${suffix}` } });
  assert.equal(res.statusCode, 200, res.body);
  return res.json() as any;
}

async function join(dealId: string, phone: string, qty: number, extraHeaders: Record<string, string> = {}, idem = `join-${dealId}-${phone}`) {
  const auth = await authorize(phone);
  const res = await app.inject({
    method: "POST", url: `/deals/${dealId}/join`,
    headers: { "content-type": "application/json", "idempotency-key": idem, ...extraHeaders },
    payload: {
      buyer_id: phone, qty, buyer_name: `קונה ${phone.slice(-4)}`, buyer_email: `${phone}@buyer.siton.test`,
      buyer_terms_accepted: true, payment_disclosure_accepted: true,
      authorization_id: auth.authorization_id, authorization_provider: auth.provider || "mockpay"
    }
  });
  return { res, body: res.statusCode === 200 ? (res.json() as any) : null };
}

async function rows(where: string, params: unknown[]) {
  const r = await pool.query(
    `SELECT notification_id, event_type, recipient_type, recipient_ref, channel, status, idempotency_key, payload_jsonb,
            deal_id, participant_id, seller_id, correlation_id, attempt_count, last_error, template_key, created_at, updated_at, scheduled_for, sent_at
     FROM siton.notification_events WHERE ${where} ORDER BY created_at ASC`, params);
  return r.rows as any[];
}
async function count(eventType: string, where = "TRUE", params: unknown[] = []) {
  const r = await pool.query(`SELECT count(*)::int AS n FROM siton.notification_events WHERE event_type=$1 AND (${where})`, [eventType, ...params]);
  return Number(r.rows[0].n);
}
async function participants(dealId: string) {
  const r = await pool.query(`SELECT participant_id, buyer_id, buyer_phone, buyer_state, money_state, qty FROM siton.participants WHERE deal_id=$1 ORDER BY created_at ASC`, [dealId]);
  return r.rows as any[];
}
async function dealState(dealId: string) {
  return String((await pool.query(`SELECT state FROM siton.deals WHERE deal_id=$1`, [dealId])).rows[0]?.state);
}
function rendered(row: any) {
  const out = renderNotification(row.event_type, row.channel, row.payload_jsonb, row.template_key);
  assert.ok(out, `template must render for ${row.event_type}/${row.channel}`);
  return out!;
}
function signWebhook(body: Record<string, unknown>) {
  return `sha256=${createHmac("sha256", process.env.PAYMENT_WEBHOOK_SECRET || "").update(JSON.stringify(body)).digest("hex")}`;
}
async function postWebhook(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return app.inject({ method: "POST", url: "/webhooks/payments", headers: { "x-webhook-signature": signWebhook(body), ...headers }, payload: body });
}

// Drive a published deal with joins through close → prepare → charge → finalize.
async function driveToFinal(dealId: string, headers: Record<string, string>) {
  for (const step of ["close_joining", "prepare_charging", "charging/start"]) {
    const res = await app.inject({ method: "POST", url: `/deals/${dealId}/${step}`, headers: { ...headers, "idempotency-key": `${step}-${dealId}` }, payload: {} });
    assert.equal(res.statusCode, 200, `${step}: ${res.body}`);
  }
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const charge = await pool.query(`SELECT event_uuid, status FROM siton.outbox_events WHERE aggregate_id=$1 AND event_type='charge_deal' ORDER BY created_at DESC LIMIT 1`, [dealId]);
    if (!charge.rowCount) break;
    const retry = await pool.query(
      `UPDATE siton.outbox_events SET event_uuid=gen_random_uuid(), available_at=now() - interval '1 second', processing_started_at=NULL, status='pending', attempt_count=0
       WHERE event_uuid=$1 RETURNING event_uuid`, [charge.rows[0].event_uuid]);
    const result = await processOutboxEventById(String(retry.rows[0].event_uuid));
    if (result?.status === "sent") break;
  }
  const finalize = await pool.query(`SELECT event_uuid FROM siton.outbox_events WHERE aggregate_id=$1 AND event_type='finalize_deal' AND status='pending' ORDER BY created_at DESC LIMIT 1`, [dealId]);
  assert.ok(finalize.rowCount, "finalize_deal outbox event expected");
  await processOutboxEventById(String(finalize.rows[0].event_uuid));
  return dealState(dealId);
}

async function seedChargingParticipant(suffix: string, phone: string, money: "ChargeAttempt" | "ChargeFailedRecovery") {
  const dealId = randomUUID();
  const pid = randomUUID();
  const correlationId = `corr-${suffix}-${RUN}`;
  await pool.query(
    `INSERT INTO siton.deals (deal_id, seller_id, state, title, price_per_unit, min_units, max_units, threshold_units, deadline, published_at, completion_window_until)
     VALUES ($1,$2,$3,$4,42,4,20,4,$5, now(), $6)`,
    [dealId, sellerA, money === "ChargeAttempt" ? "Charging" : "CompletionWindow", `עסקת שחזור ${suffix}`, new Date(Date.now() + 30 * 60_000).toISOString(), new Date(Date.now() + 10 * 60_000).toISOString()]
  );
  await pool.query(
    `INSERT INTO siton.participants (participant_id, deal_id, buyer_id, buyer_phone, buyer_name, qty, buyer_state, money_state, delivery_cost, created_at)
     VALUES ($1,$2,$3,$3,$4,2,$5,$6,0, now())`,
    [pid, dealId, phone, `קונה ${suffix}`, money === "ChargeAttempt" ? "ChargingAttempt" : "ChargeFailedCompletion", money]
  );
  await pool.query(
    `INSERT INTO siton.payment_attempts (participant_id, deal_id, attempt_type, result_class, correlation_id, created_at) VALUES ($1,$2,$3,'unknown',$4, now())`,
    [pid, dealId, money === "ChargeAttempt" ? "charge_start" : "recovery", correlationId]
  );
  return { dealId, pid, correlationId };
}

// ── S0 setup ─────────────────────────────────────────────────────────────────
let dealA = "";
const buyers: string[] = [];
await run("S0 setup: two approved sellers with distinct support e-mails", async () => {
  await seedSeller(sellerA, SELLER_A_EMAIL);
  await seedSeller(sellerB, SELLER_B_EMAIL);
});

// ── S1 seller_deal_published ─────────────────────────────────────────────────
await run("S1 publish → exactly one seller_deal_published for the DEAL's seller, canonical e-mail, canonical link; publish replay is a no-op", async () => {
  dealA = await createDeal(HA, {});
  const res = await publish(HA, dealA);
  assert.equal(res.statusCode, 200, res.body);
  const list = await rows(`event_type='seller_deal_published' AND deal_id=$1`, [dealA]);
  assert.equal(list.length, 1);
  const n = list[0];
  assert.equal(n.recipient_type, "seller");
  assert.equal(n.seller_id, sellerA);
  assert.equal(n.channel, "email");
  assert.equal(n.recipient_ref, SELLER_A_EMAIL, "recipient = seller A support e-mail (canonical row)");
  assert.equal(n.idempotency_key, `seller_deal_published:seller:${sellerA}:${dealA}:email`);
  assert.equal(n.payload_jsonb.deal_url, `${ORIGIN}/preview/#/seller/deal/${dealA}`);
  assert.ok(!String(n.payload_jsonb.deal_url).includes("/app/"), "no legacy /app link");
  assert.equal(rendered(n).body.includes("C-ton"), true);
  const replay = await publish(HA, dealA);
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(await count("seller_deal_published", "deal_id=$2", [dealA]), 1, "publish replay must not duplicate");
  assert.equal(await count("seller_deal_published", "seller_id=$2", [sellerB]), 0, "seller B never hears about seller A's deal");
  report.push(`seller_deal_published deal=${dealA.slice(0, 8)} → ${n.channel} ${n.recipient_ref.replace(/^(.).*@/, "$1***@")}`);
});

// ── S2 buyer_joined_authorized ───────────────────────────────────────────────
await run("S2 join → exactly one buyer_joined_authorized (sms to THAT buyer's phone, tokenized tracking link, mock-money truth); HTTP replay is a no-op", async () => {
  const phone = nextPhone();
  buyers.push(phone);
  const first = await join(dealA, phone, 2, {}, `join-${dealA}-${phone}`);
  assert.equal(first.res.statusCode, 200, first.res.body);
  const pid = String(first.body.participant_id);
  const list = await rows(`event_type='buyer_joined_authorized' AND participant_id=$1`, [pid]);
  assert.equal(list.length, 1);
  const n = list[0];
  assert.equal(n.recipient_type, "buyer");
  assert.equal(n.channel, "sms");
  assert.equal(n.recipient_ref, phone, "recipient = the participant's own phone");
  assert.equal(n.idempotency_key, `buyer_joined_authorized:buyer:${pid}:${dealA}:sms`);
  assert.equal(n.payload_jsonb.money_mode, "mock");
  const url = String(n.payload_jsonb.tracking_url);
  assert.ok(url.startsWith(`${ORIGIN}/preview/#/track/${pid}?t=`), `canonical tracking route with token: ${url}`);
  const token = decodeURIComponent(url.split("?t=")[1] || "");
  const tokenRow = await pool.query(`SELECT issued_via, status FROM siton.participant_tracking_tokens WHERE token_hash=$1`, [hashParticipantTrackingToken(token)]);
  assert.equal(tokenRow.rows[0]?.issued_via, "buyer_join", "the join notification reuses the Join's own tracking token (no second mint)");
  const body = rendered(n).body;
  assert.match(body, /סביבת פיילוט: לא בוצע חיוב אמיתי/);
  assert.ok(!body.includes("החיוב בוצע"), "mock money must never claim a charge");
  assert.ok(!body.includes("סיטון"), "legacy product name must not appear");
  const replay = await join(dealA, phone, 2, {}, `join-${dealA}-${phone}`);
  assert.equal(replay.res.statusCode, 200, replay.res.body);
  assert.equal(await count("buyer_joined_authorized", "participant_id=$2", [pid]), 1, "join replay must not duplicate");
  report.push(`buyer_joined_authorized participant=${pid.slice(0, 8)} → sms ${phone.slice(0, 5)}***`);
});

// ── S3 post-commit truth on Join ─────────────────────────────────────────────
await run("S3 a Join that fails before COMMIT leaves no notification behind", async () => {
  const phone = nextPhone();
  const failedJoin = await join(dealA, phone, 1, { "x-siton-join-failure-point": "after_participant_before_commit" });
  assert.ok(failedJoin.res.statusCode >= 500, `join must fail: ${failedJoin.res.statusCode}`);
  assert.equal(await count("buyer_joined_authorized", "recipient_ref=$2", [phone]), 0);
  const parts = await pool.query(`SELECT count(*)::int AS n FROM siton.participants WHERE deal_id=$1 AND buyer_id=$2`, [dealA, phone]);
  assert.equal(parts.rows[0].n, 0, "the failed join rolled back entirely");
});

// ── S4 target reached ────────────────────────────────────────────────────────
await run("S4 the Join that crosses the threshold → N buyer_deal_target_reached (one per participant, own phone) + 1 seller_target_reached; later joins and a pause/reopen never re-notify", async () => {
  assert.equal(await dealState(dealA), "PendingTarget");
  const phone2 = nextPhone(); buyers.push(phone2);
  const j2 = await join(dealA, phone2, 2);
  assert.equal(j2.res.statusCode, 200, j2.res.body);
  assert.equal(await dealState(dealA), "TargetReached", "4 units ≥ threshold 4");
  let parts = await participants(dealA);
  assert.equal(parts.length, 2);
  const target = await rows(`event_type='buyer_deal_target_reached' AND deal_id=$1`, [dealA]);
  assert.equal(target.length, 2, "one target-reached message per participant");
  for (const p of parts) {
    const mine = target.filter((n) => n.participant_id === p.participant_id);
    assert.equal(mine.length, 1);
    assert.equal(mine[0].recipient_ref, p.buyer_phone, "each buyer's message goes to that buyer's own phone");
    assert.ok(String(mine[0].payload_jsonb.tracking_url).startsWith(`${ORIGIN}/preview/#/track/${p.participant_id}?t=`));
  }
  const seller = await rows(`event_type='seller_target_reached' AND deal_id=$1`, [dealA]);
  assert.equal(seller.length, 1);
  assert.equal(seller[0].recipient_ref, SELLER_A_EMAIL);
  // Late joiners: joined message only, no target message.
  for (let i = 0; i < 3; i += 1) {
    const phone = nextPhone(); buyers.push(phone);
    const late = await join(dealA, phone, 2);
    assert.equal(late.res.statusCode, 200, late.res.body);
  }
  parts = await participants(dealA);
  assert.equal(parts.length, 5);
  assert.equal(await count("buyer_joined_authorized", "deal_id=$2", [dealA]), 5);
  assert.equal(await count("buyer_deal_target_reached", "deal_id=$2", [dealA]), 2, "late joiners never receive a target-reached message");
  // Pause + reopen re-enters TargetReached — not a new business moment.
  const close = await app.inject({ method: "POST", url: `/deals/${dealA}/close_joining`, headers: HA, payload: {} });
  assert.equal(close.statusCode, 200, close.body);
  const reopen = await app.inject({ method: "POST", url: `/deals/${dealA}/reopen_joining`, headers: { ...HA, "idempotency-key": `reopen-${dealA}` }, payload: {} });
  assert.equal(reopen.statusCode, 200, reopen.body);
  assert.equal(await dealState(dealA), "TargetReached");
  assert.equal(await count("buyer_deal_target_reached", "deal_id=$2", [dealA]), 2);
  assert.equal(await count("seller_target_reached", "deal_id=$2", [dealA]), 1);
  report.push(`target_reached deal=${dealA.slice(0, 8)} → 2 buyers + 1 seller (5 participants total, 3 late)`);
});

// ── S5 deal completed ────────────────────────────────────────────────────────
await run("S5 finalize → Completed: buyer_deal_completed for every DealCompleted participant, buyer_deal_failed for every DealFailed one, exactly ONE seller_deal_completed, no seller_excel_ready; replay is a no-op", async () => {
  const state = await driveToFinal(dealA, HA);
  assert.equal(state, "Completed", `deal ended ${state}`);
  const parts = await participants(dealA);
  const completed = parts.filter((p) => p.buyer_state === "DealCompleted");
  const failedParts = parts.filter((p) => p.buyer_state === "DealFailed");
  assert.ok(completed.length >= 2, "at least two captures succeeded");
  assert.equal(completed.length + failedParts.length, parts.length);
  const done = await rows(`event_type='buyer_deal_completed' AND deal_id=$1`, [dealA]);
  assert.equal(done.length, completed.length, "one completion message per DealCompleted participant");
  for (const p of completed) {
    const mine = done.filter((n) => n.participant_id === p.participant_id);
    assert.equal(mine.length, 1);
    assert.equal(mine[0].recipient_ref, p.buyer_phone);
    assert.equal(mine[0].payload_jsonb.money_mode, "mock");
    assert.match(rendered(mine[0]).body, /לא בוצע חיוב אמיתי/);
  }
  const lost = await rows(`event_type='buyer_deal_failed' AND deal_id=$1`, [dealA]);
  assert.equal(lost.length, failedParts.length, "one failure message per DealFailed participant");
  const recoveries = await pool.query(`SELECT count(DISTINCT entity_id)::int AS n FROM siton.audit_log WHERE deal_id=$1 AND state_type='money_state' AND to_state='ChargeFailedRecovery'`, [dealA]);
  assert.equal(await count("buyer_recovery_required", "deal_id=$2", [dealA]), recoveries.rows[0].n, "recovery_required == participants whose capture failed");
  assert.equal(await count("seller_deal_completed", "deal_id=$2", [dealA]), 1);
  assert.equal(await count("seller_excel_ready", "deal_id=$2", [dealA]), 0, "one seller message per business moment");
  const sellerRow = (await rows(`event_type='seller_deal_completed' AND deal_id=$1`, [dealA]))[0];
  assert.equal(sellerRow.recipient_ref, SELLER_A_EMAIL);
  assert.equal(sellerRow.payload_jsonb.deal_url, `${ORIGIN}/preview/#/seller/deal/${dealA}`);
  // Replay of the finalize job (worker restart / duplicate outbox row).
  const replayEvent = await pool.query(
    `INSERT INTO siton.outbox_events (event_type, aggregate_type, aggregate_id, payload, status, attempt_count, available_at)
     VALUES ('finalize_deal','deal',$1,$2,'pending',0, now() - interval '1 second') RETURNING event_uuid`,
    [dealA, JSON.stringify({ deal_id: dealA })]
  );
  await processOutboxEventById(String(replayEvent.rows[0].event_uuid)).catch(() => undefined);
  assert.equal(await count("buyer_deal_completed", "deal_id=$2", [dealA]), completed.length);
  assert.equal(await count("seller_deal_completed", "deal_id=$2", [dealA]), 1);
  const total = await pool.query(`SELECT count(*)::int AS n FROM siton.notification_events WHERE deal_id=$1 AND recipient_type='seller'`, [dealA]);
  assert.equal(total.rows[0].n, 3, "seller: published + target + completed, nothing else");
  report.push(`deal_completed deal=${dealA.slice(0, 8)} → ${completed.length} buyers completed, ${failedParts.length} buyers failed, 1 seller`);
});

// ── S6 deal failed at deadline ───────────────────────────────────────────────
await run("S6 deadline → Failed: buyer_deal_failed per participant + exactly ONE seller_deal_failed; deadline replay is a no-op", async () => {
  const dealF = await createDeal(HA, { min_units: 6, max_units: 12 });
  assert.equal((await publish(HA, dealF)).statusCode, 200);
  const phone = nextPhone();
  const j = await join(dealF, phone, 1);
  assert.equal(j.res.statusCode, 200, j.res.body);
  const age = await pool.connect();
  try {
    await age.query(`SET session_replication_role = replica`);
    await age.query(`UPDATE siton.deals SET deadline = now() - interval '1 hour' WHERE deal_id=$1`, [dealF]);
  } finally {
    await age.query(`SET session_replication_role = origin`).catch(() => undefined);
    age.release();
  }
  const dl = await pool.query(`SELECT event_uuid FROM siton.outbox_events WHERE aggregate_id=$1 AND event_type='deadline_check' AND status='pending' ORDER BY created_at DESC LIMIT 1`, [dealF]);
  assert.equal(dl.rowCount, 1);
  await pool.query(`UPDATE siton.outbox_events SET available_at=now() WHERE event_uuid=$1`, [dl.rows[0].event_uuid]);
  await processOutboxEventById(String(dl.rows[0].event_uuid));
  assert.equal(await dealState(dealF), "Failed");
  const lost = await rows(`event_type='buyer_deal_failed' AND deal_id=$1`, [dealF]);
  assert.equal(lost.length, 1);
  assert.equal(lost[0].recipient_ref, phone);
  assert.match(rendered(lost[0]).body, /לא בוצע חיוב/);
  assert.equal(await count("seller_deal_failed", "deal_id=$2", [dealF]), 1);
  const replay = await pool.query(
    `INSERT INTO siton.outbox_events (event_type, aggregate_type, aggregate_id, payload, status, attempt_count, available_at)
     VALUES ('deadline_check','deal',$1,$2,'pending',0, now() - interval '1 second') RETURNING event_uuid`,
    [dealF, JSON.stringify({ deal_id: dealF })]
  ).catch(() => null);
  if (replay?.rowCount) await processOutboxEventById(String(replay.rows[0].event_uuid)).catch(() => undefined);
  assert.equal(await count("buyer_deal_failed", "deal_id=$2", [dealF]), 1);
  assert.equal(await count("seller_deal_failed", "deal_id=$2", [dealF]), 1);
  report.push(`deal_failed(deadline) deal=${dealF.slice(0, 8)} → 1 buyer + 1 seller`);
});

// ── S7 / S8 voucher + ticket ─────────────────────────────────────────────────
const VOUCHER_TERMS = {
  face_value_amount: 100, currency: "ILS",
  valid_from: new Date(Date.now() - 86_400_000).toISOString(), valid_until: new Date(Date.now() + 90 * 86_400_000).toISOString(),
  redemption_location: "מסעדת הדגים, רחוב הים 12", redemption_instructions: "להציג את הקוד בקופה.", terms: "תקף לארוחה אחת.",
  is_single_use: true, allow_partial_redemption: false, voucher_code_mode: "system_generated"
};
const TICKET_TERMS = {
  event_name: `הופעת ג'אז ${RUN}`, event_starts_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
  event_ends_at: new Date(Date.now() + 30 * 86_400_000 + 3 * 3600e3).toISOString(),
  venue_name: "מועדון הבלוז", venue_address: "רחוב אלנבי 50", venue_city: "תל אביב",
  entry_instructions: "כניסה מגיל 18.", ticket_type: "general_admission", seat_mode: "general_admission", transfer_allowed: false
};

async function fulfillmentScenario(kind: "voucher" | "ticket") {
  const eventType = kind === "voucher" ? "buyer_voucher_issued" : "buyer_ticket_issued";
  const deal = await createDeal(HA, {
    title: `${kind === "voucher" ? "שובר" : "כרטיס"} פיילוט ${RUN}`, deal_type: kind, min_units: 2, max_units: 8, delivery_options: [],
    ...(kind === "voucher" ? { voucher_terms: VOUCHER_TERMS } : { ticket_terms: TICKET_TERMS })
  });
  assert.equal((await publish(HA, deal)).statusCode, 200);
  for (let i = 0; i < 3; i += 1) {
    const j = await join(deal, nextPhone(), 2);
    assert.equal(j.res.statusCode, 200, j.res.body);
  }
  const state = await driveToFinal(deal, HA);
  assert.equal(state, "Completed");
  const parts = await participants(deal);
  const eligible = parts.filter((p) => p.buyer_state === "DealCompleted" && ["ChargedSuccess", "RecoveredCharge"].includes(p.money_state));
  assert.ok(eligible.length >= 1);
  const units = await pool.query(`SELECT participant_id, code_display_last4 FROM siton.fulfillment_units WHERE deal_id=$1`, [deal]);
  assert.ok(units.rowCount, "units issued");
  const issued = await rows(`event_type=$1 AND deal_id=$2`, [eventType, deal]);
  assert.equal(issued.length, eligible.length, `one ${eventType} per eligible participant`);
  for (const p of eligible) {
    const mine = issued.filter((n) => n.participant_id === p.participant_id);
    assert.equal(mine.length, 1);
    assert.equal(mine[0].recipient_ref, p.buyer_phone);
    const body = rendered(mine[0]).body;
    assert.ok(body.includes(`${ORIGIN}/preview/#/track/${p.participant_id}?t=`), "points the buyer to tracking");
    const serialized = JSON.stringify(mine[0].payload_jsonb) + body;
    for (const u of units.rows.filter((r: any) => r.participant_id === p.participant_id)) {
      assert.ok(!serialized.includes(`code_hash`) && !/[A-Z2-9]{16}/.test(body), "no code in the message");
      assert.ok(u.code_display_last4);
    }
  }
  const ineligible = parts.filter((p) => !eligible.some((e) => e.participant_id === p.participant_id));
  for (const p of ineligible) assert.equal(await count(eventType, "participant_id=$2", [p.participant_id]), 0, "unpaid participants get no voucher/ticket");
  await issueFulfillmentForCompletedDeal(deal);
  assert.equal(await count(eventType, "deal_id=$2", [deal]), eligible.length, "re-running issuance never re-notifies");
  report.push(`${eventType} deal=${deal.slice(0, 8)} → ${eligible.length} buyers`);
}
await run("S7 voucher deal completed → exactly one buyer_voucher_issued per eligible participant, no code in the message, issuance replay is a no-op", () => fulfillmentScenario("voucher"));
await run("S8 ticket deal completed → exactly one buyer_ticket_issued per eligible participant, no code in the message, issuance replay is a no-op", () => fulfillmentScenario("ticket"));

// ── S9 recovery (webhook truth) ──────────────────────────────────────────────
await run("S9 charge_failed webhook → ONE buyer_recovery_required; duplicate webhook + duplicate business event never duplicate; recovery_captured → ONE buyer_payment_recovered; an ordinary capture sends nothing", async () => {
  const phone = nextPhone();
  const seeded = await seedChargingParticipant("fail", phone, "ChargeAttempt");
  const eventId = `evt-fail-${RUN}`;
  const first = await postWebhook({ provider: "mockpay", event_id: eventId, event_type: "charge_failed", correlation_id: seeded.correlationId, participant_id: seeded.pid, deal_id: seeded.dealId, provider_reference: "cap-fail", payload: { provider_reference: "cap-fail" } });
  assert.equal(first.statusCode, 200, first.body);
  assert.equal((first.json() as any).status, "processed");
  const rec = await rows(`event_type='buyer_recovery_required' AND participant_id=$1`, [seeded.pid]);
  assert.equal(rec.length, 1);
  assert.equal(rec[0].recipient_ref, phone);
  assert.equal(rec[0].channel, "sms");
  assert.ok(String(rec[0].payload_jsonb.tracking_url).includes(`/preview/#/track/${seeded.pid}?t=`), "recovery points at the tokenized tracking route");
  assert.match(rendered(rec[0]).body, /החיוב .*לא עבר/);
  const dup = await postWebhook({ provider: "mockpay", event_id: eventId, event_type: "charge_failed", correlation_id: seeded.correlationId, participant_id: seeded.pid, deal_id: seeded.dealId, provider_reference: "cap-fail", payload: { provider_reference: "cap-fail" } });
  assert.equal(dup.statusCode, 200, dup.body);
  const again = await postWebhook({ provider: "mockpay", event_id: `${eventId}-2`, event_type: "charge_failed", correlation_id: seeded.correlationId, participant_id: seeded.pid, deal_id: seeded.dealId, provider_reference: "cap-fail", payload: { provider_reference: "cap-fail" } });
  assert.equal(again.statusCode, 200, again.body);
  assert.equal(await count("buyer_recovery_required", "participant_id=$2", [seeded.pid]), 1, "duplicate webhook / duplicate business event → one message");

  // Recovery success.
  await pool.query(`INSERT INTO siton.payment_attempts (participant_id, deal_id, attempt_type, result_class, correlation_id, created_at) VALUES ($1,$2,'recovery','unknown',$3, now())`, [seeded.pid, seeded.dealId, `${seeded.correlationId}-rec`]);
  const recovered = await postWebhook({ provider: "mockpay", event_id: `evt-rec-${RUN}`, event_type: "recovery_captured", correlation_id: `${seeded.correlationId}-rec`, participant_id: seeded.pid, deal_id: seeded.dealId, provider_reference: "rec-ok", payload: { provider_reference: "rec-ok" } });
  assert.equal(recovered.statusCode, 200, recovered.body);
  assert.equal((recovered.json() as any).status, "processed");
  const money = await pool.query(`SELECT money_state, buyer_state FROM siton.participants WHERE participant_id=$1`, [seeded.pid]);
  assert.equal(money.rows[0].money_state, "RecoveredCharge");
  const paid = await rows(`event_type='buyer_payment_recovered' AND participant_id=$1`, [seeded.pid]);
  assert.equal(paid.length, 1);
  assert.equal(paid[0].recipient_ref, phone);
  assert.match(rendered(paid[0]).body, /לא בוצע חיוב אמיתי/);
  const replay = await postWebhook({ provider: "mockpay", event_id: `evt-rec-${RUN}`, event_type: "recovery_captured", correlation_id: `${seeded.correlationId}-rec`, participant_id: seeded.pid, deal_id: seeded.dealId, provider_reference: "rec-ok", payload: { provider_reference: "rec-ok" } });
  assert.equal(replay.statusCode, 200);
  assert.equal(await count("buyer_payment_recovered", "participant_id=$2", [seeded.pid]), 1);

  // An ordinary successful capture is not a buyer-facing moment.
  const ok = await seedChargingParticipant("ok", nextPhone(), "ChargeAttempt");
  const captured = await postWebhook({ provider: "mockpay", event_id: `evt-ok-${RUN}`, event_type: "charge_captured", correlation_id: ok.correlationId, participant_id: ok.pid, deal_id: ok.dealId, provider_reference: "cap-ok", payload: { provider_reference: "cap-ok" } });
  assert.equal(captured.statusCode, 200, captured.body);
  assert.equal((captured.json() as any).status, "processed");
  const any = await pool.query(`SELECT count(*)::int AS n FROM siton.notification_events WHERE participant_id=$1`, [ok.pid]);
  assert.equal(any.rows[0].n, 0, "charge_captured emits no notification (the 'payment recovered' mis-alias is gone)");
  report.push(`recovery participant=${seeded.pid.slice(0, 8)} → 1 recovery_required + 1 payment_recovered`);
});

// ── S9b post-commit truth on a money transition ─────────────────────────────
await run("S9b a money transition that rolls back before COMMIT takes its notification with it; the next authoritative event produces exactly one", async () => {
  const phone = nextPhone();
  const seeded = await seedChargingParticipant("rollback", phone, "ChargeAttempt");
  armTestFault("atomic.after_durable_writes_before_commit", { kind: "throw", code: "test_rollback_before_commit" }, 1);
  let threw = false;
  try {
    const res = await postWebhook({ provider: "mockpay", event_id: `evt-rb-${RUN}`, event_type: "charge_failed", correlation_id: seeded.correlationId, participant_id: seeded.pid, deal_id: seeded.dealId, provider_reference: "cap-rb", payload: { provider_reference: "cap-rb" } });
    threw = res.statusCode >= 500;
  } catch { threw = true; }
  resetTestFaults();
  assert.ok(threw, "the transition must have failed");
  const state = await pool.query(`SELECT money_state FROM siton.participants WHERE participant_id=$1`, [seeded.pid]);
  assert.equal(state.rows[0].money_state, "ChargeAttempt", "money truth unchanged");
  assert.equal(await count("buyer_recovery_required", "participant_id=$2", [seeded.pid]), 0, "no notification survives a rollback");
  const retry = await postWebhook({ provider: "mockpay", event_id: `evt-rb2-${RUN}`, event_type: "charge_failed", correlation_id: seeded.correlationId, participant_id: seeded.pid, deal_id: seeded.dealId, provider_reference: "cap-rb", payload: { provider_reference: "cap-rb" } });
  assert.equal(retry.statusCode, 200, retry.body);
  assert.equal(await count("buyer_recovery_required", "participant_id=$2", [seeded.pid]), 1);
});

// ── S10 seller inquiry ───────────────────────────────────────────────────────
await run("S10 inquiry → exactly one seller_customer_inquiry to the DEAL's seller (a spoofed seller_id is ignored), retry never duplicates, the message carries a pointer and no customer text", async () => {
  const dealI = await createDeal(HA, { title: `עסקת פניות ${RUN}` });
  assert.equal((await publish(HA, dealI)).statusCode, 200);
  const message = `שלום, האם אפשר לאסוף בערב? סוד-לקוח-${RUN}`;
  const res = await app.inject({ method: "POST", url: `/api/deals/${dealI}/inquiries`, headers: { "content-type": "application/json" }, payload: { name: "רות הקונה", email: `buyer-${RUN}@buyer.siton.test`, message, seller_id: sellerB } });
  assert.equal(res.statusCode, 201, res.body);
  const body = res.json() as any;
  assert.equal(body.notification?.result, "queued");
  const list = await rows(`event_type='seller_customer_inquiry' AND deal_id=$1`, [dealI]);
  assert.equal(list.length, 1);
  const n = list[0];
  assert.equal(n.seller_id, sellerA);
  assert.equal(n.recipient_ref, SELLER_A_EMAIL, "the DEAL decides the seller — never the request body");
  assert.equal(n.payload_jsonb.inquiry_url, `${ORIGIN}/preview/#/seller/inquiries/${body.thread_id}`);
  const out = rendered(n);
  assert.ok(!out.body.includes(`סוד-לקוח-${RUN}`) && !JSON.stringify(n.payload_jsonb).includes(`סוד-לקוח-${RUN}`), "no customer text in the external message");
  assert.ok(!out.body.includes("buyer.siton.test"), "no customer e-mail in the external message");
  assert.ok(out.body.includes(`/preview/#/seller/inquiries/${body.thread_id}`), "pointer back into the product");
  const retry = await app.inject({ method: "POST", url: `/api/deals/${dealI}/inquiries`, headers: { "content-type": "application/json" }, payload: { name: "רות הקונה", email: `buyer-${RUN}@buyer.siton.test`, message } });
  assert.equal(retry.statusCode, 200, retry.body);
  assert.equal((retry.json() as any).duplicate, true);
  assert.equal(await count("seller_customer_inquiry", "deal_id=$2", [dealI]), 1);
  assert.equal(await count("seller_customer_inquiry", "seller_id=$2", [sellerB]), 0, "seller B never receives seller A's inquiry");
  report.push(`seller_customer_inquiry deal=${dealI.slice(0, 8)} → 1 seller pointer`);
});

// ── S11 KYC ──────────────────────────────────────────────────────────────────
await run("S11 KYC: approve → ONE seller_kyc_approved (login e-mail); re-approve → nothing; reject with a seller-facing reason → ONE seller_kyc_rejected carrying the reason and NOT the admin note; a later re-approval is a new decision", async () => {
  const pending = `seller-kyc-${RUN}`;
  const email = `${pending}@siton.test`;
  await pool.query(
    `INSERT INTO siton.seller_accounts (seller_id, display_name, business_name, login_email, verification_status, settlement_status, auth_enabled)
     VALUES ($1,$2,$3,$4,'pending','active',true)`,
    [pending, "מוכר חדש", "חנות הפיילוט", email]
  );
  const decide = (decision: string, extra: Record<string, unknown> = {}) =>
    app.inject({ method: "POST", url: `/api/admin/kyc/seller/${pending}/decision`, headers: ADMIN, payload: { decision, admin_note: `INTERNAL-NOTE-${RUN}`, ...extra } });
  const approve = await decide("approve");
  assert.equal(approve.statusCode, 200, approve.body);
  assert.equal((approve.json() as any).notification?.result, "queued");
  let approved = await rows(`event_type='seller_kyc_approved' AND seller_id=$1`, [pending]);
  assert.equal(approved.length, 1);
  assert.equal(approved[0].recipient_ref, email);
  assert.equal(approved[0].channel, "email");
  assert.equal(approved[0].idempotency_key, `seller_kyc_approved:seller:${pending}:kyc:1:email`);
  assert.equal(approved[0].payload_jsonb.workspace_url, `${ORIGIN}/preview/#/seller`);
  assert.match(rendered(approved[0]).body, /חנות הפיילוט/);
  assert.ok(!rendered(approved[0]).body.includes("סיטון"), "brand C-ton only");
  const again = await decide("approve");
  assert.equal(again.statusCode, 200, again.body);
  assert.equal((again.json() as any).notification?.result, "not_needed");
  assert.equal(await count("seller_kyc_approved", "seller_id=$2", [pending]), 1, "an unchanged decision is not a new business fact");
  const audits = await pool.query(`SELECT count(*)::int AS n FROM siton.seller_security_events WHERE seller_id=$1 AND event_type='seller.kyc.decision'`, [pending]);
  assert.equal(audits.rows[0].n, 1);

  const reject = await decide("reject", { seller_reason: `חסר <script>alert(1)</script> מסמך עוסק מורשה ${"א".repeat(400)}` });
  assert.equal(reject.statusCode, 200, reject.body);
  const rejected = await rows(`event_type='seller_kyc_rejected' AND seller_id=$1`, [pending]);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].idempotency_key, `seller_kyc_rejected:seller:${pending}:kyc:2:email`);
  const reason = String(rejected[0].payload_jsonb.reason);
  assert.ok(reason.startsWith("חסר alert(1) מסמך עוסק מורשה"), `sanitized reason: ${reason}`);
  assert.ok(reason.length <= 300, "bounded reason");
  assert.ok(!reason.includes("<"), "no markup");
  const rejectedBody = rendered(rejected[0]).body;
  assert.ok(rejectedBody.includes("סיבה: חסר alert(1) מסמך"), "the seller-facing reason is rendered");
  assert.ok(!rejectedBody.includes(`INTERNAL-NOTE-${RUN}`) && !JSON.stringify(rejected[0].payload_jsonb).includes("INTERNAL-NOTE"), "the internal admin note never reaches the seller");
  assert.match(rejectedBody, /לא בוצעה תנועת כסף/);

  const reapprove = await decide("approve");
  assert.equal(reapprove.statusCode, 200, reapprove.body);
  approved = await rows(`event_type='seller_kyc_approved' AND seller_id=$1`, [pending]);
  assert.equal(approved.length, 2, "a re-approval after a rejection is a new decision");
  assert.equal(approved[1].idempotency_key, `seller_kyc_approved:seller:${pending}:kyc:3:email`);

  // A rejection without a seller-facing reason renders no "סיבה" line.
  const bare = renderNotification("seller_kyc_rejected", "email", { seller_name: "מוכר" })!;
  assert.ok(!bare.body.includes("סיבה"), "no reason line when no seller-facing reason exists");
  report.push(`seller_kyc seller=${pending} → approved ×2 (decisions 1,3), rejected ×1 (decision 2)`);
});

// ── S12 admin security alert ─────────────────────────────────────────────────
await run("S12 a rejected webhook signature → ONE admin_security_alert per hour bucket to the configured admin destination only", async () => {
  const bad = { provider: "mockpay", event_id: `evt-bad-${RUN}`, event_type: "charge_captured", payload: {} };
  const r1 = await app.inject({ method: "POST", url: "/webhooks/payments", headers: { "x-webhook-signature": "sha256=00" }, payload: bad });
  assert.equal(r1.statusCode, 401);
  const r2 = await app.inject({ method: "POST", url: "/webhooks/payments", headers: { "x-webhook-signature": "sha256=00" }, payload: { ...bad, event_id: `evt-bad2-${RUN}` } });
  assert.equal(r2.statusCode, 401);
  const security = await pool.query(`SELECT count(*)::int AS n FROM siton.payment_webhook_security_events WHERE event_id IN ($1,$2)`, [`evt-bad-${RUN}`, `evt-bad2-${RUN}`]);
  assert.equal(security.rows[0].n, 2, "every occurrence is durable");
  const hour = new Date().toISOString().slice(0, 13);
  const alerts = await rows(`event_type='admin_security_alert' AND idempotency_key LIKE $1`, [`admin_security_alert:admin:webhook:mockpay:invalid_webhook_signature:${hour}:%`]);
  assert.equal(alerts.length, 1, "a burst collapses to one alert per hour bucket");
  assert.equal(alerts[0].recipient_type, "admin");
  assert.equal(alerts[0].channel, "email");
  assert.equal(alerts[0].recipient_ref, "ops-alerts@siton.test", "configured destination only");
  assert.match(rendered(alerts[0]).body, /invalid_webhook_signature/);
  // Module-level: the same alert identity is one row; an unconfigured destination degrades to internal.
  const key = `case:test:${RUN}`;
  await withTx(async (c) => {
    const a = await enqueueAdminSecurityAlert(c, { alert_key: key, alert_title: "בדיקה", alert_ref: "ref" });
    const b = await enqueueAdminSecurityAlert(c, { alert_key: key, alert_title: "בדיקה", alert_ref: "ref" });
    assert.equal(a.result, "queued");
    assert.equal(b.result, "duplicate");
    const internal = await enqueueAdminSecurityAlert(c, { alert_key: `${key}-internal`, alert_title: "בדיקה", env: {} as NodeJS.ProcessEnv });
    assert.equal(internal.channel, "internal");
  });
  report.push(`admin_security_alert webhook signature ×2 → 1 alert (${hour})`);
});

// ── S13 isolation over everything recorded so far ───────────────────────────
await run("S13 no cross-seller and no cross-buyer leak anywhere in the queue", async () => {
  const sellerRows = await rows(`recipient_type='seller' AND seller_id IN ($1,$2)`, [sellerA, sellerB]);
  for (const n of sellerRows) {
    const expected = n.seller_id === sellerA ? SELLER_A_EMAIL : SELLER_B_EMAIL;
    assert.equal(n.recipient_ref, expected, `seller row ${n.event_type} must go to its own seller`);
    if (n.deal_id) {
      const owner = await pool.query(`SELECT seller_id FROM siton.deals WHERE deal_id=$1`, [n.deal_id]);
      assert.equal(String(owner.rows[0].seller_id), n.seller_id, "seller notification bound to the deal's owner");
    }
  }
  const buyerRows = await rows(`recipient_type='buyer' AND participant_id IS NOT NULL`, []);
  for (const n of buyerRows) {
    const p = await pool.query(`SELECT buyer_phone, deal_id FROM siton.participants WHERE participant_id=$1`, [n.participant_id]);
    if (!p.rowCount) continue;
    assert.equal(n.recipient_ref, p.rows[0].buyer_phone, `buyer row ${n.event_type} must go to that participant's own phone`);
    assert.equal(String(n.deal_id), String(p.rows[0].deal_id));
    const url = String(n.payload_jsonb.tracking_url || "");
    if (url) assert.ok(url.includes(`/track/${n.participant_id}`), "tracking link belongs to the same participant");
  }
  assert.equal(await count("seller_excel_ready"), 0);
  const keys = await pool.query(`SELECT count(*)::int AS total, count(DISTINCT idempotency_key)::int AS distinct_keys FROM siton.notification_events`);
  assert.equal(keys.rows[0].total, keys.rows[0].distinct_keys);
});

// ── S14 the real Worker maintenance pass, dry-run provider ──────────────────
await run("S14 the real Worker pass drains every pending row through the dry-run provider: valid destinations 'sent' with a dry-run message id, nothing failed, zero attempts in a real mode", async () => {
  const before = await pool.query(`SELECT count(*)::int AS n FROM siton.notification_events WHERE status='pending'`);
  assert.ok(before.rows[0].n > 0);
  for (let i = 0; i < 20; i += 1) {
    await runWorkerMaintenance();
    const left = await pool.query(`SELECT count(*)::int AS n FROM siton.notification_events WHERE status='pending' AND (scheduled_for IS NULL OR scheduled_for <= now())`);
    if (!left.rows[0].n) break;
  }
  const summary = await pool.query(`SELECT status, count(*)::int AS n FROM siton.notification_events GROUP BY status ORDER BY status`);
  const byStatus = Object.fromEntries(summary.rows.map((r: any) => [r.status, r.n]));
  assert.equal(byStatus.failed || 0, 0, `nothing failed: ${JSON.stringify(byStatus)}`);
  assert.equal(byStatus.pending || 0, 0);
  assert.ok((byStatus.sent || 0) > 10);
  const attempts = await pool.query(`SELECT provider, provider_mode, count(*)::int AS n FROM siton.notification_attempts GROUP BY provider, provider_mode`);
  for (const a of attempts.rows) {
    assert.notEqual(a.provider_mode, "real", "no attempt may run in real mode");
    assert.equal(a.provider, "dry-run");
  }
  const sent = await pool.query(`SELECT provider_message_id FROM siton.notification_attempts WHERE result_status='success' LIMIT 5`);
  for (const r of sent.rows) assert.match(String(r.provider_message_id), /^dryrun_[0-9a-f]{24}$/);
  // Operator read model: masked destination, redacted body, business correlation.
  const sample = (await rows(`event_type='buyer_joined_authorized' AND deal_id=$1`, [dealA]))[0];
  const view = await app.inject({ method: "GET", url: `/api/admin/notifications/${sample.notification_id}`, headers: ADMIN });
  assert.equal(view.statusCode, 200, view.body);
  const v = view.json() as any;
  assert.equal(v.notification.status, "sent");
  assert.equal(v.notification.recipient_masked, `+97250***${sample.recipient_ref.slice(-3)}`, "masked destination");
  assert.equal(v.notification.status, "sent", "sample row drained");
  assert.ok(!view.body.includes(sample.recipient_ref), "raw phone never leaves the read model");
  assert.ok(!view.body.includes("?t=") || /\?t=\*\*\*/.test(view.body), "tracking token redacted");
  assert.ok(!/[?&]t=[A-Za-z0-9_-]{20,}/.test(view.body), "no token material in the operator view");
  assert.equal(v.notification.why.deal_id, dealA);
  assert.equal(v.notification.safety.current.allowed, true);
  assert.equal(v.notification.safety.real_mode_shadow.allowed, false, "a real adapter would still be blocked by the master switch today");
  assert.equal(v.attempts.length, 1);
  assert.equal(v.provider.external_delivery, false);
  const status = await app.inject({ method: "GET", url: "/api/admin/notifications-status", headers: ADMIN });
  assert.equal(status.statusCode, 200);
  const s = status.json() as any;
  assert.equal(typeof s.notifications.blocked, "number");
  assert.equal(typeof s.notifications.retry_scheduled, "number");
  assert.equal(s.notifications.provider.external_delivery, false);
  report.push(`worker pass → ${JSON.stringify(byStatus)} external_delivery=0`);
});

// ── S15 template + payload hygiene (pure) ────────────────────────────────────
await run("S15 every pilot template renders on each compatible channel, money truth is mode-dependent, and secret-like payloads are refused at enqueue", async () => {
  for (const eventType of NOTIFICATION_EVENT_TYPES) {
    const payload: Record<string, unknown> = { deal_title: "מבצע", deal_id: randomUUID(), seller_name: "מוכר", reason: "סיבה", thread_id: randomUUID(), inquiry_url: `${ORIGIN}/preview/#/seller/inquiries/x`, alert_title: "התראה", money_mode: "mock" };
    for (const channel of supportedChannels(eventType)) {
      const out = renderNotification(eventType, channel, payload);
      assert.ok(out && out.body.trim().length > 10, `${eventType}/${channel}`);
      assert.ok(!out!.body.includes("סיטון"), `${eventType}: legacy brand`);
    }
  }
  assert.match(renderNotification("buyer_deal_completed", "sms", { deal_title: "x", money_mode: "real" })!.body, /החיוב בוצע/);
  assert.ok(!renderNotification("buyer_deal_completed", "sms", { deal_title: "x", money_mode: "mock" })!.body.includes("החיוב בוצע"));
  assert.ok(!renderNotification("buyer_deal_completed", "sms", { deal_title: "x" })!.body.includes("החיוב בוצע"), "unknown money mode renders conservatively");
  const base = { event_type: "buyer_joined_authorized" as const, recipient_type: "buyer" as const, recipient_ref: "+972501234567", channel: "sms" as const };
  // Secret-shaped fixtures are assembled at runtime so no literal in this file
  // ever matches a secret scanner (GitHub push protection included).
  for (const payload of [
    { deal_title: "x", note: ["sk", "live", "ABCDEFGHIJKLMNOPQRSTUV"].join("_") },
    { deal_title: "x", note: "AKIA" + "ABCDEFGHIJKLMNOP" },
    { deal_title: "x", card: ["4111", "1111", "1111", "1111"].join(" ") },
    { deal_title: "x", password: "hunter2" },
    { deal_title: "x", jwt: ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "abcdefghijklmnop"].join(".") },
    { deal_title: "x".repeat(2100) }
  ]) {
    await assert.rejects(
      enqueueNotification({ ...base, payload_jsonb: payload as any, idempotency_key: `hyg-${randomUUID()}` }, pool),
      (e: any) => e instanceof NotificationValidationError
    );
  }
  // A sanctioned tokenized link is allowed.
  const ok = await enqueueNotification({ ...base, payload_jsonb: { deal_title: "x", tracking_url: notificationLinks.buyerTracking(ORIGIN, randomUUID(), "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG") }, idempotency_key: `hyg-ok-${RUN}` }, pool);
  assert.equal(ok, "queued");
  // Module-level rollback: a notification enqueued in a transaction that rolls back does not exist.
  const ghost = randomUUID();
  await withTx(async (c) => {
    const r = await enqueueSellerKycDecisionNotification(c, { seller_id: sellerA, decision: "approved", ordinal: 99, seller_name: "x", origin: ORIGIN, correlation_id: ghost });
    assert.equal(r.result, "queued");
    throw new Error("rollback-on-purpose");
  }).catch(() => undefined);
  assert.equal(await count("seller_kyc_approved", "correlation_id=$2", [ghost]), 0);
  // A participant that does not exist is skipped, never guessed.
  await withTx(async (c) => {
    const r = await enqueueBuyerDealNotification(c, { event_type: "buyer_deal_completed", participant_id: randomUUID(), deal_id: dealA, ctx: { origin: ORIGIN, money_mode: "mock" } });
    assert.equal(r.result, "skipped");
  });
  const view = describeNotificationForOperator({ notification_id: randomUUID(), event_type: "buyer_joined_authorized", recipient_type: "buyer", recipient_ref: "+972501234567", channel: "sms", template_key: "buyer_joined_authorized_he", status: "pending", attempt_count: 0, payload_jsonb: { deal_title: "x", tracking_url: `${ORIGIN}/preview/#/track/p?t=SECRETTOKEN123456789` }, idempotency_key: "k" }, "dry-run");
  assert.ok(!view.body_preview!.includes("SECRETTOKEN"), "operator preview redacts tokens");
  assert.equal(view.recipient_masked, "+97250***567");
});

await run("S16 notification read/insert/token SQL failures preserve committed business truth", async () => {
  const { enqueueTargetReachedNotifications, enqueueDealOutcomeNotifications, enqueueFulfillmentIssuedNotification } = await import("../src/notification_events.js");
  const pid = String((await participants(dealA))[0].participant_id);
  const ctx = { origin: ORIGIN, money_mode: "mock" as const };
  const common = { deal_id: dealA, ...ctx, default_seller_id: sellerA };
  const cases = [
    { name: "target header", pattern: /SELECT title, seller_id/, call: (c: any) => enqueueTargetReachedNotifications(c, common) },
    { name: "target participants", pattern: /SELECT participant_id, buyer_state/, call: (c: any) => enqueueTargetReachedNotifications(c, common) },
    { name: "outcome header", pattern: /SELECT title, seller_id/, call: (c: any) => enqueueDealOutcomeNotifications(c, { ...common, outcome: "completed", classify: () => "completed" }) },
    { name: "outcome participants", pattern: /SELECT participant_id, buyer_state/, call: (c: any) => enqueueDealOutcomeNotifications(c, { ...common, outcome: "completed", classify: () => "completed" }) },
    { name: "fulfillment read", pattern: /FROM siton.fulfillment_units/, call: (c: any) => enqueueFulfillmentIssuedNotification(c, { ...common, participant_id: pid, deal_type: "voucher" }) },
    { name: "buyer recipient", pattern: /SELECT p.participant_id, p.buyer_id/, call: (c: any) => enqueueBuyerDealNotification(c, { event_type: "buyer_ticket_issued", participant_id: pid, deal_id: dealA, ctx }) },
    { name: "notification insert", pattern: /INSERT INTO siton.notification_events/, call: (c: any) => enqueueBuyerDealNotification(c, { event_type: "buyer_ticket_issued", participant_id: pid, deal_id: dealA, ctx }) },
    { name: "tracking token", pattern: /INSERT INTO siton.participant_tracking_tokens/, call: (c: any) => enqueueBuyerDealNotification(c, { event_type: "buyer_ticket_issued", participant_id: pid, deal_id: dealA, ctx }) }
  ];
  for (const test of cases) {
    const correlation = `failure-proof-${randomUUID()}`;
    let injected = false;
    await withTx(async (c) => {
      // A real PostgreSQL statement error poisons the transaction unless the
      // notification helper actually rolls back to a savepoint.
      const proxy = { query: (sql: string, values?: any[]) => {
        if (!injected && test.pattern.test(sql)) { injected = true; return c.query("SELECT 1 / 0"); }
        return c.query(sql, values);
      } };
      await c.query("CREATE TEMP TABLE IF NOT EXISTS notification_business_proof (id text) ON COMMIT PRESERVE ROWS");
      await c.query("INSERT INTO notification_business_proof VALUES ($1)", [correlation]);
      await test.call(proxy);
      assert.equal(injected, true, test.name);
      assert.equal((await c.query("SELECT count(*)::int AS n FROM notification_business_proof WHERE id=$1", [correlation])).rows[0].n, 1, test.name);
    });
  }
});

await run("S17 failed inquiry notification insert cannot roll back the customer message", async () => {
  const deal = await createDeal(HA, { title: `Inquiry failure ${RUN}` });
  assert.equal((await publish(HA, deal)).statusCode, 200);
  await pool.query(`CREATE FUNCTION siton.test_inquiry_notification_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.event_type='seller_customer_inquiry' THEN RAISE EXCEPTION 'injected notification insert failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER test_inquiry_notification_failure BEFORE INSERT ON siton.notification_events FOR EACH ROW EXECUTE FUNCTION siton.test_inquiry_notification_failure()`);
  try {
    const payload = { name: "Inquiry tester", email: `failure-${RUN}@buyer.siton.test`, message: "Please confirm pickup hours" };
    const result = await app.inject({ method: "POST", url: `/api/deals/${deal}/inquiries`, payload });
    assert.equal(result.statusCode, 201, result.body);
    const body = result.json() as any;
    assert.equal(body.notification.result, "error");
    assert.equal((await pool.query("SELECT 1 FROM siton.seller_inquiry_messages WHERE message_id=$1", [body.message_id])).rowCount, 1);
    assert.equal(await count("seller_customer_inquiry", "deal_id=$2", [deal]), 0);
    const retry = await app.inject({ method: "POST", url: `/api/deals/${deal}/inquiries`, payload });
    assert.equal(retry.statusCode, 200, retry.body);
    assert.equal((retry.json() as any).duplicate, true);
  } finally {
    await pool.query("DROP TRIGGER test_inquiry_notification_failure ON siton.notification_events; DROP FUNCTION siton.test_inquiry_notification_failure()");
  }
});

console.log("\nPILOT_COMMS_REPORT");
for (const line of report) console.log(`  ${line}`);
console.log(`SUMMARY passed=${passed} failed=${failed} real_email_sent=0 real_sms_sent=0 external_delivery=0`);
await pool.end();
await new Promise((r) => setTimeout(r, 300));
process.exit(failed ? 1 : 0);
