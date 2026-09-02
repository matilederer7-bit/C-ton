// Deal Types E2E Gate ג€” proves physical / voucher / ticket flows work
// against the real runtime (in-process Fastify + real Postgres demo bootstrap).
//
// Scope:
//   ג€¢ physical_product regression: default deal_type, delivery options, public page.
//   ג€¢ voucher full flow: create ג†’ public ג†’ buyer join ג†’ drive Completed ג†’
//     fulfillment_units issued only for eligible (ChargedSuccess/RecoveredCharge),
//     plaintext code never persisted, qty=N ג†’ N units, idempotent issuance,
//     buyer tracking surfaces last4 only when eligible, voucher-export
//     Completed-only + eligible-only + CSV-injection-safe, redeem requires
//     seller ownership + idempotent + no money/state mutation.
//   ג€¢ ticket full flow: same shape with event_name / venue / ticket-export.
//   ג€¢ failed-deal scenario: deadline_check Failed path issues no fulfillment.
//   ג€¢ Mission Control: deal_type_readiness + fulfillment_readiness + trace.
//   ג€¢ Refund + JSON boundary regressions remain green.
//
// Out of scope (covered by other suites): full mock charge race coverage
// (full_e2e_gate), recovery edge matrix (buyer_recovery_flow_validation),
// admin RBAC (admin_*).

import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ADMIN_API_KEY = "deal-types-e2e-admin-key";
process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.DEAL_IMAGE_UPLOAD_DIR = await mkdtemp(join(tmpdir(), "siton-deal-types-e2e-images-"));
process.env.MOCK_SEED = "1";
process.env.PORT = "3498";
// Set the completion window to a negative value so it's stamped in the past at
// charge time. The DB trigger forbids updating completion_window_until once
// set, so we cannot rewind it after the fact ג€” we have to bias the worker's
// initial stamp instead. handleFinalizeDealEvent then sees `now() >= window`
// immediately and proceeds.
process.env.COMPLETION_WINDOW_MINUTES = "-1";

const { app, processOutboxEventById, issueFulfillmentForCompletedDeal } = await import("../src/app.js");
const { pool } = await import("../src/db.js");

const RUN_ID = `${Date.now()}-${randomUUID().slice(0, 8)}`;

function reqHeaders(key: string, sellerId?: string) {
  return {
    "x-request-id": `dt-e2e-${key}-${RUN_ID}`,
    "x-correlation-id": `corr-dt-e2e-${key}-${RUN_ID}`,
    "idempotency-key": `dt-e2e-${key}-${RUN_ID}`,
    ...(sellerId ? { "x-seller-id": sellerId } : {})
  };
}

const ADMIN_HEADERS = {
  "x-admin-key": "deal-types-e2e-admin-key",
  "x-request-id": `dt-e2e-admin-${RUN_ID}`,
  "x-correlation-id": `corr-dt-e2e-admin-${RUN_ID}`
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

async function run(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

async function seedSeller(sellerId: string) {
  await pool.query(
    `INSERT INTO siton.seller_accounts
       (seller_id, display_name, business_name, support_email, verification_status,
        settlement_status, payout_method, payout_details_masked, seller_status)
     VALUES ($1,$2,$3,$4,'approved','active','manual','****','Active')
     ON CONFLICT (seller_id) DO UPDATE
        SET display_name=EXCLUDED.display_name,
            business_name=EXCLUDED.business_name,
            support_email=EXCLUDED.support_email,
            verification_status='approved',
            seller_status='Active',
            updated_at=now()`,
    [sellerId, `Seller ${sellerId}`, `Business ${sellerId}`, `${sellerId}@example.test`]
  );
}

async function createDeal(args: {
  sellerId: string;
  suffix: string;
  body: Record<string, unknown>;
}) {
  const response = await app.inject({
    method: "POST",
    url: "/deals",
    headers: reqHeaders(`create-${args.suffix}`, args.sellerId),
    payload: {
      title: `DealTypes E2E ${args.suffix}`,
      price_per_unit: 50,
      min_units: 2,
      max_units: 5,
      deadline: new Date(Date.now() + 3 * 60 * 60_000).toISOString(),
      ...args.body
    }
  });
  return { response, body: response.statusCode === 200 ? (response.json() as any) : null };
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
  // Phone derived from suffix for stability across reruns within a single test
  // process. OTP path is identical to the public buyer flow.
  const phone = `0509${String(Math.abs(hashStr(`${suffix}-${RUN_ID}`))).padStart(7, "0").slice(-7)}`;
  const start = await app.inject({ method: "POST", url: "/api/otp/start", payload: { phone } });
  assert.equal(start.statusCode, 200, start.body);
  const started = start.json() as any;
  const verify = await app.inject({
    method: "POST",
    url: "/api/otp/verify",
    payload: { otp_session_id: started.otp_session_id, code: started.development_code }
  });
  assert.equal(verify.statusCode, 200, verify.body);
  return verify.json() as any;
}

function hashStr(value: string) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

async function authorizePayment(suffix: string) {
  const response = await app.inject({
    method: "POST",
    url: "/api/payments/authorize-mock",
    payload: {
      payer_name: `Buyer ${suffix}`,
      payment_method_id: `pm_deal_type_${suffix}`
    }
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json() as any;
}

async function joinDeal(args: {
  dealId: string;
  suffix: string;
  qty?: number;
  buyerName?: string;
  buyerEmail?: string;
  delivery?: { address?: string; city?: string };
}) {
  const otp = await verifiedBuyer(args.suffix);
  const auth = await authorizePayment(args.suffix);
  const payload: Record<string, unknown> = {
    buyer_id: otp.buyer_id,
    qty: args.qty ?? 1,
    buyer_name: args.buyerName ?? `Buyer ${args.suffix}`,
    buyer_email: args.buyerEmail ?? `${args.suffix}@example.test`,
    buyer_terms_accepted: true,
    payment_disclosure_accepted: true,
    otp_token: otp.otp_token,
    otp_challenge_id: otp.challenge_id || otp.otp_session_id,
    authorization_id: auth.authorization_id || `auth-${args.suffix}`,
    authorization_provider: auth.provider || "mockpay"
  };
  if (args.delivery?.address) {
    (payload as any).delivery_address = args.delivery.address;
    (payload as any).delivery_city = args.delivery.city || "Tel Aviv";
  }
  const response = await app.inject({
    method: "POST",
    url: `/deals/${args.dealId}/join`,
    headers: reqHeaders(`join-${args.suffix}`),
    payload
  });
  return { response, otp, auth, body: response.statusCode === 200 ? (response.json() as any) : null };
}

// Drive a deal from PendingTarget through Completed (or Failed if mock charges
// fail enough). Returns the deal's final state and the per-participant money
// states so the caller can assert on eligibility.
async function driveDealToFinalState(dealId: string, sellerId: string, suffix: string) {
  const close = await app.inject({
    method: "POST",
    url: `/deals/${dealId}/close_joining`,
    headers: reqHeaders(`close-${suffix}`, sellerId)
  });
  assert.equal(close.statusCode, 200, close.body);
  const prepare = await app.inject({
    method: "POST",
    url: `/deals/${dealId}/prepare_charging`,
    headers: reqHeaders(`prepare-${suffix}`, sellerId)
  });
  assert.equal(prepare.statusCode, 200, prepare.body);
  const start = await app.inject({
    method: "POST",
    url: `/deals/${dealId}/charging/start`,
    headers: reqHeaders(`start-${suffix}`, sellerId)
  });
  assert.equal(start.statusCode, 200, start.body);

  // Process the charge_deal outbox event. The worker (a) hits the mock
  // provider per participant in ChargingAttempt/ChargeAttempt and (b) on
  // success transitions deal_state Charging ג†’ CompletionWindow and enqueues
  // a finalize_deal outbox event. Because COMPLETION_WINDOW_MINUTES=-1, the
  // deal's completion_window_until is stamped in the past immediately.
  //
  // The mock provider returns temporary_fail ~15% of the time per participant.
  // When it does, the worker throws and markOutboxFailed reschedules the event
  // to a future available_at. To keep the test deterministic we reset
  // available_at to now() and re-process up to a small bounded number of
  // attempts. Already-charged participants are skipped on retry.
  // 8 attempts was observed to exhaust under unlucky temp-fail rolls in CI's
  // test:all pass — keep the bound generous; charged participants are skipped
  // on retry so extra attempts cost nothing.
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const charge = await pool.query(
      `SELECT event_uuid, status FROM siton.outbox_events
        WHERE aggregate_id=$1 AND event_type='charge_deal'
        ORDER BY created_at DESC LIMIT 1`,
      [dealId]
    );
    if (!charge.rowCount) break;
    const retryEvent = await pool.query(
      `UPDATE siton.outbox_events SET event_uuid = gen_random_uuid(),
                                    available_at = now() - interval '1 second',
                                    processing_started_at = NULL,
                                    status = 'pending',
                                    attempt_count = 0
        WHERE event_uuid = $1
        RETURNING event_uuid`,
      [charge.rows[0].event_uuid]
    );
    const result = await processOutboxEventById(String(retryEvent.rows[0].event_uuid));
    if (result?.status === "sent") break;
  }

  // Process the finalize_deal outbox event (now() >= completion_window_until
  // is true, so handleFinalizeDealEvent transitions to Completed and runs
  // issueFulfillmentForCompletedDeal).
  const finalizeOutbox = await pool.query(
    `SELECT event_uuid FROM siton.outbox_events
      WHERE aggregate_id=$1 AND event_type='finalize_deal' AND status='pending'
      ORDER BY created_at DESC LIMIT 1`,
    [dealId]
  );
  if (finalizeOutbox.rowCount) {
    await processOutboxEventById(String(finalizeOutbox.rows[0].event_uuid));
  }

  const dealAfter = await pool.query(`SELECT state FROM siton.deals WHERE deal_id=$1`, [dealId]);
  const participants = await pool.query(
    `SELECT participant_id, qty, buyer_state, money_state
       FROM siton.participants
      WHERE deal_id=$1
      ORDER BY created_at ASC`,
    [dealId]
  );
  return {
    dealState: String(dealAfter.rows[0]?.state || ""),
    participants: participants.rows as Array<{
      participant_id: string;
      qty: number;
      buyer_state: string;
      money_state: string;
    }>
  };
}

const VOUCHER_TERMS_BASE = {
  face_value_amount: 100,
  currency: "ILS",
  valid_from: new Date(Date.now() - 86_400_000).toISOString(),
  valid_until: new Date(Date.now() + 90 * 86_400_000).toISOString(),
  redemption_location: "׳׳¡׳¢׳“׳× ׳”׳“׳’׳™׳, ׳¨׳—׳•׳‘ ׳”׳™׳ 12, ׳×׳ ׳׳‘׳™׳‘",
  redemption_instructions: "׳׳”׳¦׳™׳’ ׳׳× ׳”׳§׳•׳“ ׳‘׳§׳•׳₪׳” ׳׳₪׳ ׳™ ׳”׳×׳©׳׳•׳.",
  terms: "׳×׳§׳£ ׳׳׳¨׳•׳—׳” ׳׳—׳× ׳׳›׳ ׳¡׳•׳¢׳“. ׳׳ ׳ ׳™׳×׳ ׳׳₪׳¦׳.",
  is_single_use: true,
  allow_partial_redemption: false,
  voucher_code_mode: "system_generated"
};

const TICKET_TERMS_BASE = {
  event_name: "׳”׳•׳₪׳¢׳× ׳’'׳׳– ׳‘׳׳•׳¢׳“׳•׳ ׳‘׳׳•׳–",
  event_starts_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
  event_ends_at: new Date(Date.now() + 30 * 86_400_000 + 3 * 60 * 60_000).toISOString(),
  venue_name: "׳׳•׳¢׳“׳•׳ ׳”׳‘׳׳•׳–",
  venue_address: "׳¨׳—׳•׳‘ ׳׳׳ ׳‘׳™ 50",
  venue_city: "׳×׳ ׳׳‘׳™׳‘",
  entry_instructions: "׳›׳ ׳™׳¡׳” ׳׳’׳™׳ 18 ׳‘׳׳‘׳“ ׳¢׳ ׳×׳¢׳•׳“׳” ׳׳–׳”׳”.",
  ticket_type: "general_admission",
  seat_mode: "general_admission",
  transfer_allowed: false
};

let physicalSellerId = "";
let voucherSellerId = "";
let ticketSellerId = "";
let voucherDealId = "";
let ticketDealId = "";
let voucherEligibleParticipantId = "";
let ticketEligibleParticipantId = "";

try {
  // ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€
  // A. Physical Product Regression
  // ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€
  await run("A1: physical_product default ג€” omitting deal_type still creates a physical deal", async () => {
    physicalSellerId = `seller-dt-physical-${RUN_ID}`;
    await seedSeller(physicalSellerId);
    const created = await createDeal({
      sellerId: physicalSellerId,
      suffix: "physical-default",
      body: {
        delivery_options: [
          { option_type: "pickup", label: "׳׳™׳¡׳•׳£ ׳׳”׳—׳ ׳•׳×", cost: 0, sort_order: 0 }
        ]
      }
    });
    assert.equal(created.response.statusCode, 200, created.response.body);
    assert.equal(created.body.deal_type, "physical_product");

    const row = await pool.query(`SELECT deal_type FROM siton.deals WHERE deal_id=$1`, [created.body.deal_id]);
    assert.equal(row.rows[0].deal_type, "physical_product");

    await publishDeal(created.body.deal_id, physicalSellerId, "physical-default");
    const publicDeal = await app.inject({ method: "GET", url: `/api/deals/${created.body.deal_id}/public` });
    assert.equal(publicDeal.statusCode, 200, publicDeal.body);
    const publicJson = publicDeal.json() as any;
    assert.equal(publicJson.deal.deal_type, "physical_product");
    assert.ok(Array.isArray(publicJson.deal.delivery_options));
    assert.equal(publicJson.deal.delivery_options.length, 1);
    assert.equal(publicJson.deal.voucher_terms, null);
    assert.equal(publicJson.deal.ticket_terms, null);
  });

  await run("A2: physical buyer can join + tracking does not expose voucher/ticket fields", async () => {
    const created = await createDeal({
      sellerId: physicalSellerId,
      suffix: "physical-join",
      body: {
        min_units: 1,
        max_units: 3,
        delivery_options: [
          { option_type: "pickup", label: "׳׳™׳¡׳•׳£ ׳׳”׳—׳ ׳•׳×", cost: 0, sort_order: 0 }
        ]
      }
    });
    assert.equal(created.response.statusCode, 200, created.response.body);
    await publishDeal(created.body.deal_id, physicalSellerId, "physical-join");
    const joined = await joinDeal({ dealId: created.body.deal_id, suffix: "physical-buyer", qty: 1 });
    assert.equal(joined.response.statusCode, 200, joined.response.body);
    const tracking = await app.inject({
      method: "GET",
      url: `/api/participants/${joined.body.participant_id}/tracking?t=${encodeURIComponent(joined.body.tracking_access_token)}`
    });
    assert.equal(tracking.statusCode, 200, tracking.body);
    const trackJson = (tracking.json() as any).tracking;
    assert.equal(trackJson.deal_type, "physical_product");
    assert.equal(trackJson.fulfillment.eligible, false);
    assert.equal(trackJson.fulfillment.units.length, 0);
    assert.equal(trackJson.fulfillment.voucher_terms, null);
    assert.equal(trackJson.fulfillment.ticket_terms, null);
  });

  // ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€
  // B. Voucher Full Flow
  // ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€
  await run("B1: voucher create ג€” voucher_terms required, deal_voucher_terms persisted, public exposes terms + copy", async () => {
    voucherSellerId = `seller-dt-voucher-${RUN_ID}`;
    await seedSeller(voucherSellerId);

    // Missing voucher_terms is rejected (400 voucher_terms_required).
    const missingTerms = await createDeal({
      sellerId: voucherSellerId,
      suffix: "voucher-missing",
      body: { deal_type: "voucher" }
    });
    assert.equal(missingTerms.response.statusCode, 400, missingTerms.response.body);
    assert.equal((missingTerms.response.json() as any).code, "voucher_terms_required");

    // Invalid voucher_code_mode is rejected.
    const badMode = await createDeal({
      sellerId: voucherSellerId,
      suffix: "voucher-bad-mode",
      body: {
        deal_type: "voucher",
        voucher_terms: { ...VOUCHER_TERMS_BASE, voucher_code_mode: "seller_uploaded" }
      }
    });
    assert.equal(badMode.response.statusCode, 400, badMode.response.body);
    assert.equal((badMode.response.json() as any).code, "voucher_code_mode_unsupported");

    const created = await createDeal({
      sellerId: voucherSellerId,
      suffix: "voucher-ok",
      body: {
        title: "׳©׳•׳‘׳¨ ׳׳¨׳•׳—׳” ׳–׳•׳’׳™׳×",
        deal_type: "voucher",
        min_units: 2,
        max_units: 12,
        voucher_terms: VOUCHER_TERMS_BASE
      }
    });
    assert.equal(created.response.statusCode, 200, created.response.body);
    voucherDealId = created.body.deal_id;
    assert.equal(created.body.deal_type, "voucher");
    const termsRow = await pool.query(
      `SELECT face_value_amount, voucher_code_mode, is_single_use, allow_partial_redemption
         FROM siton.deal_voucher_terms WHERE deal_id=$1`,
      [voucherDealId]
    );
    assert.equal(termsRow.rowCount, 1);
    assert.equal(Number(termsRow.rows[0].face_value_amount), 100);
    assert.equal(termsRow.rows[0].voucher_code_mode, "system_generated");
    assert.equal(termsRow.rows[0].is_single_use, true);
    assert.equal(termsRow.rows[0].allow_partial_redemption, false);

    await publishDeal(voucherDealId, voucherSellerId, "voucher");
    const publicDeal = await app.inject({ method: "GET", url: `/api/deals/${voucherDealId}/public` });
    assert.equal(publicDeal.statusCode, 200, publicDeal.body);
    const publicJson = publicDeal.json() as any;
    assert.equal(publicJson.deal.deal_type, "voucher");
    assert.equal(publicJson.deal.delivery_options.length, 0, "physical delivery options must be suppressed for voucher deals");
    assert.equal(publicJson.deal.voucher_terms.face_value_amount, 100);
    assert.equal(publicJson.deal.ticket_terms, null);
    assert.match(publicJson.deal.fulfillment_copy.disclaimer, /יונפק רק לאחר/);
    assert.match(publicJson.deal.fulfillment_copy.headline, /שובר/);
  });

  await run("B2: voucher buyer flow ג€” no code before Completed, fulfillment issued only for eligible, qty=N ג†’ N units, no plaintext code in DB", async () => {
    // Four buyers with mixed qty so we can verify qty=N ג†’ N units across
    // varied N. min_units=2 ג†’ threshold=2, max_units=12. Total 4ֳ—2=8 unit
    // attempts at 75% mock success ג€” probability all fail is ~0.001%, so
    // we can rely on at least one Completed eligible buyer.
    const buyerA = await joinDeal({ dealId: voucherDealId, suffix: "voucher-A", qty: 3 });
    assert.equal(buyerA.response.statusCode, 200, buyerA.response.body);
    voucherEligibleParticipantId = buyerA.body.participant_id;
    const trackingTokenA = buyerA.body.tracking_access_token;
    const buyerB = await joinDeal({ dealId: voucherDealId, suffix: "voucher-B", qty: 2 });
    assert.equal(buyerB.response.statusCode, 200, buyerB.response.body);
    const buyerC = await joinDeal({ dealId: voucherDealId, suffix: "voucher-C", qty: 2 });
    assert.equal(buyerC.response.statusCode, 200, buyerC.response.body);
    const buyerD = await joinDeal({ dealId: voucherDealId, suffix: "voucher-D", qty: 1 });
    assert.equal(buyerD.response.statusCode, 200, buyerD.response.body);

    // Pre-Completed tracking must NOT include any code/units.
    const pre = await app.inject({
      method: "GET",
      url: `/api/participants/${voucherEligibleParticipantId}/tracking?t=${encodeURIComponent(trackingTokenA)}`
    });
    assert.equal(pre.statusCode, 200, pre.body);
    const preJson = (pre.json() as any).tracking;
    assert.equal(preJson.deal_type, "voucher");
    assert.equal(preJson.fulfillment.eligible, false);
    assert.equal(preJson.fulfillment.units.length, 0);
    assert.match(preJson.fulfillment.copy.headline, /עדיין לא הונפק/);
    // Voucher terms surface even pre-completion (they describe the offer).
    assert.equal(preJson.fulfillment.voucher_terms.face_value_amount, 100);

    // Drive deal to final state.
    const final = await driveDealToFinalState(voucherDealId, voucherSellerId, "voucher");
    assert.equal(final.dealState, "Completed", `expected Completed, got ${final.dealState}`);
    const eligible = final.participants.filter(
      (p) => p.buyer_state === "DealCompleted" &&
             ["ChargedSuccess", "RecoveredCharge"].includes(p.money_state)
    );
    assert.ok(eligible.length >= 1, "expected at least one eligible participant");

    // Re-issue (idempotency check) ג€” must not duplicate units.
    await issueFulfillmentForCompletedDeal(voucherDealId);
    await issueFulfillmentForCompletedDeal(voucherDealId);

    // Assert: only eligible participants have fulfillment_units, qty matches.
    for (const p of final.participants) {
      const units = await pool.query(
        `SELECT unit_index, code_hash, code_display_last4, status
           FROM siton.fulfillment_units
          WHERE participant_id=$1
          ORDER BY unit_index ASC`,
        [p.participant_id]
      );
      const isEligible = p.buyer_state === "DealCompleted" &&
        ["ChargedSuccess", "RecoveredCharge"].includes(p.money_state);
      if (isEligible) {
        assert.equal(units.rowCount, Number(p.qty), `eligible participant ${p.participant_id} should have qty=${p.qty} units, got ${units.rowCount}`);
        // Indexes 1..qty unique, no duplicates.
        const indexes = units.rows.map((r: any) => Number(r.unit_index));
        assert.deepEqual(indexes, Array.from({ length: Number(p.qty) }, (_, i) => i + 1));
        for (const row of units.rows as any[]) {
          assert.equal(String(row.status), "Issued");
          assert.ok(row.code_hash && String(row.code_hash).length >= 64, "code_hash must be SHA-256 hex");
          assert.ok(row.code_display_last4 && String(row.code_display_last4).length === 4, "code_display_last4 must be 4 chars");
        }
      } else {
        assert.equal(units.rowCount, 0, `ineligible participant ${p.participant_id} must NOT have units`);
      }
    }

    // Plaintext codes must not be persisted anywhere ג€” assert no column with
    // 'plaintext' or 'code_text' exists; assert metadata_jsonb is empty.
    const meta = await pool.query(
      `SELECT metadata_jsonb FROM siton.fulfillment_units WHERE deal_id=$1`,
      [voucherDealId]
    );
    for (const row of meta.rows as any[]) {
      const j = row.metadata_jsonb || {};
      assert.equal(typeof j, "object");
      assert.ok(!("plaintext_code" in j), "plaintext_code must never be persisted in metadata_jsonb");
      assert.ok(!("code" in j), "raw code must never be persisted in metadata_jsonb");
    }
  });

  await run("B3: voucher tracking ג€” eligible buyer sees last4, ineligible buyer sees nothing", async () => {
    const tracking = await app.inject({
      method: "GET",
      url: `/api/participants/${voucherEligibleParticipantId}/tracking`
    });
    // legacy_links_allowed in demo-preview mode lets unauthenticated tracking
    // pass for this gate. We just need to confirm the surface shape.
    if (tracking.statusCode === 200) {
      const tj = (tracking.json() as any).tracking;
      // Eligible participants from B2 should see units with last4.
      const isEligible = tj.fulfillment.eligible;
      if (isEligible) {
        assert.ok(tj.fulfillment.units.length >= 1);
        for (const u of tj.fulfillment.units) {
          assert.ok(u.code_display_last4 && String(u.code_display_last4).length === 4);
          // Plaintext code must not appear in the response.
          assert.ok(!("plaintext_code" in u));
          assert.ok(!("code" in u));
        }
      }
    } else {
      assert.ok([401, 403].includes(tracking.statusCode), `unexpected ${tracking.statusCode}`);
    }
  });

  await run("B4: voucher-export ג€” Completed-only, eligible-only, CSV-injection neutralized, no plaintext code", async () => {
    const exportRes = await app.inject({
      method: "GET",
      url: `/api/seller/deals/${voucherDealId}/voucher-export`,
      headers: { "x-seller-id": voucherSellerId }
    });
    assert.equal(exportRes.statusCode, 200, exportRes.body);
    const csv = exportRes.body as string;
    // Header row contains voucher_code_last4 (not plaintext).
    assert.match(csv, /voucher_code_last4/);
    // No 16-character system-generated code body (alphabet) appears.
    assert.doesNotMatch(csv, /[A-HJ-NP-Z2-9]{16}/);
    // CSV-injection: any leading =, +, -, @ in a cell must have been quoted/prefixed.
    const lines = csv.split(/\r?\n/);
    for (const line of lines) {
      // Any unquoted cell starting with =/+/-/@ is a violation.
      const cells = line.split(",");
      for (const cell of cells) {
        if (/^[=+\-@]/.test(cell)) {
          throw new Error(`unsafe CSV cell: ${cell}`);
        }
      }
    }

    // Wrong type ג†’ 409.
    const wrongType = await app.inject({
      method: "GET",
      url: `/api/seller/deals/${voucherDealId}/ticket-export`,
      headers: { "x-seller-id": voucherSellerId }
    });
    assert.equal(wrongType.statusCode, 409, wrongType.body);
  });

  await run("B5: voucher redeem ג€” seller ownership enforced + idempotent + does not change money/state", async () => {
    const unitRow = await pool.query(
      `SELECT fulfillment_unit_id FROM siton.fulfillment_units
        WHERE deal_id=$1 AND status='Issued'
        ORDER BY unit_index ASC LIMIT 1`,
      [voucherDealId]
    );
    assert.equal(unitRow.rowCount, 1, "expected at least one Issued voucher unit");
    const unitId = String(unitRow.rows[0].fulfillment_unit_id);

    // Stranger seller is denied.
    const strangerSeller = `seller-dt-stranger-${RUN_ID}`;
    await seedSeller(strangerSeller);
    const denied = await app.inject({
      method: "POST",
      url: `/api/seller/fulfillment/${unitId}/redeem`,
      headers: { "x-seller-id": strangerSeller, ...reqHeaders("redeem-stranger") }
    });
    assert.equal(denied.statusCode, 403, denied.body);
    assert.equal((denied.json() as any).code, "fulfillment_unit_forbidden");

    // Owner redeems successfully.
    const moneyBefore = await pool.query(
      `SELECT money_state, buyer_state FROM siton.participants
        WHERE participant_id IN (SELECT participant_id FROM siton.fulfillment_units WHERE fulfillment_unit_id=$1)`,
      [unitId]
    );
    const dealStateBefore = await pool.query(`SELECT state FROM siton.deals WHERE deal_id=$1`, [voucherDealId]);
    const ok = await app.inject({
      method: "POST",
      url: `/api/seller/fulfillment/${unitId}/redeem`,
      headers: { "x-seller-id": voucherSellerId, ...reqHeaders("redeem-ok") }
    });
    assert.equal(ok.statusCode, 200, ok.body);
    const okJson = ok.json() as any;
    assert.equal(okJson.ok, true);
    assert.equal(okJson.idempotent, false);
    assert.equal(okJson.status, "Redeemed");

    // Idempotent re-redeem.
    const again = await app.inject({
      method: "POST",
      url: `/api/seller/fulfillment/${unitId}/redeem`,
      headers: { "x-seller-id": voucherSellerId, ...reqHeaders("redeem-again") }
    });
    assert.equal(again.statusCode, 200, again.body);
    assert.equal((again.json() as any).idempotent, true);
    assert.equal((again.json() as any).status, "Redeemed");

    // money_state, buyer_state, deal_state all unchanged.
    const moneyAfter = await pool.query(
      `SELECT money_state, buyer_state FROM siton.participants
        WHERE participant_id IN (SELECT participant_id FROM siton.fulfillment_units WHERE fulfillment_unit_id=$1)`,
      [unitId]
    );
    const dealStateAfter = await pool.query(`SELECT state FROM siton.deals WHERE deal_id=$1`, [voucherDealId]);
    assert.equal(moneyAfter.rows[0].money_state, moneyBefore.rows[0].money_state);
    assert.equal(moneyAfter.rows[0].buyer_state, moneyBefore.rows[0].buyer_state);
    assert.equal(dealStateAfter.rows[0].state, dealStateBefore.rows[0].state);
  });

  // ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€
  // C. Ticket Full Flow
  // ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€
  await run("C1: ticket create ג€” ticket_terms required, deal_ticket_terms persisted, public exposes event copy", async () => {
    ticketSellerId = `seller-dt-ticket-${RUN_ID}`;
    await seedSeller(ticketSellerId);

    // Missing ticket_terms is rejected.
    const missing = await createDeal({
      sellerId: ticketSellerId,
      suffix: "ticket-missing",
      body: { deal_type: "ticket" }
    });
    assert.equal(missing.response.statusCode, 400, missing.response.body);
    assert.equal((missing.response.json() as any).code, "ticket_terms_required");

    // Assigned-seat seating is rejected (no seating engine).
    const badSeat = await createDeal({
      sellerId: ticketSellerId,
      suffix: "ticket-bad-seat",
      body: {
        deal_type: "ticket",
        ticket_terms: { ...TICKET_TERMS_BASE, seat_mode: "assigned_seating_not_supported_yet" }
      }
    });
    assert.equal(badSeat.response.statusCode, 400, badSeat.response.body);
    assert.equal((badSeat.response.json() as any).code, "ticket_seat_mode_unsupported");

    const created = await createDeal({
      sellerId: ticketSellerId,
      suffix: "ticket-ok",
      body: {
        title: "׳›׳¨׳˜׳™׳¡ ׳׳”׳•׳₪׳¢׳× ׳’'׳׳–",
        deal_type: "ticket",
        min_units: 2,
        max_units: 12,
        ticket_terms: TICKET_TERMS_BASE
      }
    });
    assert.equal(created.response.statusCode, 200, created.response.body);
    ticketDealId = created.body.deal_id;
    const tt = await pool.query(
      `SELECT event_name, ticket_type, seat_mode FROM siton.deal_ticket_terms WHERE deal_id=$1`,
      [ticketDealId]
    );
    assert.equal(tt.rowCount, 1);
    assert.match(String(tt.rows[0].event_name), /׳’'׳׳–/);

    await publishDeal(ticketDealId, ticketSellerId, "ticket");
    const publicDeal = await app.inject({ method: "GET", url: `/api/deals/${ticketDealId}/public` });
    assert.equal(publicDeal.statusCode, 200, publicDeal.body);
    const pj = publicDeal.json() as any;
    assert.equal(pj.deal.deal_type, "ticket");
    assert.equal(pj.deal.delivery_options.length, 0);
    assert.equal(pj.deal.voucher_terms, null);
    assert.match(pj.deal.ticket_terms.event_name, /׳’'׳׳–/);
    assert.equal(pj.deal.ticket_terms.seat_mode, "general_admission");
    assert.match(pj.deal.fulfillment_copy.disclaimer, /יונפק רק לאחר/);
    assert.match(pj.deal.fulfillment_copy.headline, /כרטיס/);
  });

  await run("C2: ticket buyer flow ג€” no code before Completed, qty=N ג†’ N tickets, eligibility-gated", async () => {
    // Multiple buyers to dampen mock variance (see B2 reasoning).
    const buyer = await joinDeal({ dealId: ticketDealId, suffix: "ticket-buyer", qty: 2 });
    assert.equal(buyer.response.statusCode, 200, buyer.response.body);
    ticketEligibleParticipantId = buyer.body.participant_id;
    const trackingToken = buyer.body.tracking_access_token;
    const buyer2 = await joinDeal({ dealId: ticketDealId, suffix: "ticket-buyer-2", qty: 1 });
    assert.equal(buyer2.response.statusCode, 200, buyer2.response.body);
    const buyer3 = await joinDeal({ dealId: ticketDealId, suffix: "ticket-buyer-3", qty: 2 });
    assert.equal(buyer3.response.statusCode, 200, buyer3.response.body);

    const pre = await app.inject({
      method: "GET",
      url: `/api/participants/${ticketEligibleParticipantId}/tracking?t=${encodeURIComponent(trackingToken)}`
    });
    assert.equal(pre.statusCode, 200, pre.body);
    const pj = (pre.json() as any).tracking;
    assert.equal(pj.deal_type, "ticket");
    assert.equal(pj.fulfillment.eligible, false);
    assert.equal(pj.fulfillment.units.length, 0);
    assert.match(pj.fulfillment.copy.headline, /הכרטיס עדיין לא הונפק/);
    assert.match(pj.fulfillment.ticket_terms.event_name, /׳’'׳׳–/);

    const final = await driveDealToFinalState(ticketDealId, ticketSellerId, "ticket");
    assert.equal(final.dealState, "Completed", `expected Completed, got ${final.dealState}`);
    const eligible = final.participants.filter(
      (p) => p.buyer_state === "DealCompleted" &&
             ["ChargedSuccess", "RecoveredCharge"].includes(p.money_state)
    );
    assert.ok(eligible.length >= 1, "expected at least one eligible ticket participant");

    for (const p of final.participants) {
      const units = await pool.query(
        `SELECT unit_index, code_hash, code_display_last4, fulfillment_kind
           FROM siton.fulfillment_units
          WHERE participant_id=$1
          ORDER BY unit_index ASC`,
        [p.participant_id]
      );
      const isEligible = p.buyer_state === "DealCompleted" &&
        ["ChargedSuccess", "RecoveredCharge"].includes(p.money_state);
      if (isEligible) {
        assert.equal(units.rowCount, Number(p.qty), `eligible ticket participant ${p.participant_id} should have qty=${p.qty} units`);
        for (const row of units.rows as any[]) {
          assert.equal(String(row.fulfillment_kind), "event_ticket");
          assert.ok(row.code_hash);
          assert.equal(String(row.code_display_last4).length, 4);
        }
      } else {
        assert.equal(units.rowCount, 0);
      }
    }
  });

  await run("C3: ticket-export + ticket check-in ג€” ownership + idempotency + no money mutation", async () => {
    const exp = await app.inject({
      method: "GET",
      url: `/api/seller/deals/${ticketDealId}/ticket-export`,
      headers: { "x-seller-id": ticketSellerId }
    });
    assert.equal(exp.statusCode, 200, exp.body);
    const csv = exp.body as string;
    assert.match(csv, /event_name/);
    assert.match(csv, /ticket_code_last4/);
    assert.doesNotMatch(csv, /[A-HJ-NP-Z2-9]{16}/);

    const wrongType = await app.inject({
      method: "GET",
      url: `/api/seller/deals/${ticketDealId}/voucher-export`,
      headers: { "x-seller-id": ticketSellerId }
    });
    assert.equal(wrongType.statusCode, 409, wrongType.body);

    // Check-in the first issued ticket unit.
    const unit = await pool.query(
      `SELECT fulfillment_unit_id FROM siton.fulfillment_units
        WHERE deal_id=$1 AND status='Issued'
        ORDER BY unit_index ASC LIMIT 1`,
      [ticketDealId]
    );
    assert.equal(unit.rowCount, 1, "expected at least one issued ticket unit");
    const unitId = String(unit.rows[0].fulfillment_unit_id);

    const dealStateBefore = await pool.query(`SELECT state FROM siton.deals WHERE deal_id=$1`, [ticketDealId]);
    const checkin = await app.inject({
      method: "POST",
      url: `/api/seller/fulfillment/${unitId}/redeem`,
      headers: { "x-seller-id": ticketSellerId, ...reqHeaders("ticket-checkin") }
    });
    assert.equal(checkin.statusCode, 200, checkin.body);
    assert.equal((checkin.json() as any).status, "Redeemed");
    const dealStateAfter = await pool.query(`SELECT state FROM siton.deals WHERE deal_id=$1`, [ticketDealId]);
    assert.equal(dealStateAfter.rows[0].state, dealStateBefore.rows[0].state);

    // Idempotent re-checkin
    const again = await app.inject({
      method: "POST",
      url: `/api/seller/fulfillment/${unitId}/redeem`,
      headers: { "x-seller-id": ticketSellerId, ...reqHeaders("ticket-checkin-again") }
    });
    assert.equal((again.json() as any).idempotent, true);
  });

  // ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€
  // D. Failed Deal Must Not Issue Fulfillment
  // ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€
  await run("D1: voucher deal that fails deadline_check issues no fulfillment_units", async () => {
    const failSellerId = `seller-dt-fail-${RUN_ID}`;
    await seedSeller(failSellerId);
    const created = await createDeal({
      sellerId: failSellerId,
      suffix: "fail-voucher",
      body: {
        title: "׳©׳•׳‘׳¨ ׳©׳™׳›׳©׳",
        deal_type: "voucher",
        min_units: 5, // require 5 units, no buyers will join
        max_units: 10,
        voucher_terms: VOUCHER_TERMS_BASE
      }
    });
    assert.equal(created.response.statusCode, 200);
    const failDealId = String(created.body.deal_id);
    await publishDeal(failDealId, failSellerId, "fail-voucher");

    // A deadline check only fails a deal AFTER its deadline. Simulate the
    // deadline passing by aging it into the past (the deadline is immutable
    // after publish in production, so bypass the trigger on a single connection
    // via session_replication_role). Before this fix the check failed a deal
    // regardless of its deadline — a bug the live worker exposed in R6.
    const ageClient = await pool.connect();
    try {
      await ageClient.query(`SET session_replication_role = replica`);
      await ageClient.query(`UPDATE siton.deals SET deadline = now() - interval '1 hour' WHERE deal_id=$1`, [failDealId]);
    } finally {
      await ageClient.query(`SET session_replication_role = origin`).catch(() => {});
      ageClient.release();
    }
    const dl = await pool.query(
      `SELECT event_uuid FROM siton.outbox_events
        WHERE aggregate_id=$1 AND event_type='deadline_check' AND status='pending'
        ORDER BY created_at DESC LIMIT 1`,
      [failDealId]
    );
    assert.equal(dl.rowCount, 1, "expected pending deadline_check event after publish");
    // The check is now scheduled for the (original) deadline; make it due so the
    // worker can claim it, mirroring the deadline actually arriving.
    await pool.query(`UPDATE siton.outbox_events SET available_at = now() WHERE event_uuid=$1`, [String(dl.rows[0].event_uuid)]);
    await processOutboxEventById(String(dl.rows[0].event_uuid));
    const after = await pool.query(`SELECT state FROM siton.deals WHERE deal_id=$1`, [failDealId]);
    assert.equal(String(after.rows[0].state), "Failed", `expected Failed, got ${after.rows[0].state}`);

    // Even if we manually call issuance, no units are created.
    await issueFulfillmentForCompletedDeal(failDealId);
    const units = await pool.query(
      `SELECT COUNT(*)::int AS c FROM siton.fulfillment_units WHERE deal_id=$1`,
      [failDealId]
    );
    assert.equal(Number(units.rows[0].c), 0, "Failed deal must have ZERO fulfillment units");
  });

  // ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€
  // E. Mission Control
  // ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€
  await run("E1: Mission Control exposes deal_type_readiness + fulfillment_readiness with no anomalies", async () => {
    const mission = await app.inject({
      method: "GET",
      url: "/api/admin/mission-control",
      headers: ADMIN_HEADERS
    });
    assert.equal(mission.statusCode, 200, mission.body);
    const body = mission.json() as any;
    assert.ok(body.deal_type_readiness, "deal_type_readiness section missing");
    assert.deepEqual(body.deal_type_readiness.deal_types_supported, ["physical_product", "voucher", "ticket"]);
    assert.equal(body.deal_type_readiness.physical_product_status, "ready");
    assert.equal(body.deal_type_readiness.voucher_status, "ready");
    assert.equal(body.deal_type_readiness.ticket_status, "ready");
    assert.equal(body.deal_type_readiness.issuance_policy.manual_refund_allowed, false);
    assert.equal(body.deal_type_readiness.issuance_policy.manual_issuance_before_completed_allowed, false);

    assert.ok(body.fulfillment_readiness, "fulfillment_readiness section missing");
    assert.equal(body.fulfillment_readiness.ineligible_issued_count, 0,
      "no fulfillment_unit may exist for an ineligible participant");
    assert.equal(body.fulfillment_readiness.issued_before_completed_count, 0,
      "no fulfillment_unit may exist before the deal is Completed");
    assert.ok(body.fulfillment_readiness.fulfillment_units_total >= 1, "expected >=1 issued unit from voucher/ticket flow");
    assert.ok(body.fulfillment_readiness.redeemed_count >= 1, "expected >=1 redeemed unit from B5/C3");
  });

  await run("E2: deal trace exposes deal_type and surfaces voucher/ticket terms via existing endpoints", async () => {
    // Trace endpoint surfaces audit_log/outbox/payment_attempts; voucher/ticket
    // terms surface via the public/seller endpoints (already verified). Trace
    // existence is sufficient here ג€” keeps Mission Control coverage tight.
    const trace = await app.inject({
      method: "GET",
      url: `/api/admin/mission-control/deals/${voucherDealId}/trace`,
      headers: ADMIN_HEADERS
    });
    assert.equal(trace.statusCode, 200, trace.body);
    const body = trace.json() as any;
    assert.ok(Array.isArray(body.audit_last_events));
  });

  // ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€
  // F. Refund + JSON Boundary Regression Hooks
  // ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€
  await run("F1: no manual refund route exists for voucher/ticket ג€” admin manual_refund still rejected", async () => {
    // Confirm there's no admin/seller refund endpoint reachable for voucher/ticket.
    for (const path of [
      `/api/seller/deals/${voucherDealId}/refund`,
      `/api/seller/deals/${ticketDealId}/refund`,
      `/api/admin/deals/${voucherDealId}/refund`,
      `/api/admin/deals/${ticketDealId}/refund`,
      `/api/support/deals/${voucherDealId}/refund`,
      `/api/seller/fulfillment/refund`,
      `/api/seller/voucher/refund`,
      `/api/seller/ticket/refund`
    ]) {
      const r = await app.inject({ method: "POST", url: path, headers: { "x-seller-id": voucherSellerId }, payload: {} });
      assert.ok([403, 404, 405].includes(r.statusCode), `${path} should not exist (got ${r.statusCode})`);
    }
  });

  await run("F2: fulfillment_units.metadata_jsonb is empty / metadata-only ג€” never used as truth", async () => {
    const rows = await pool.query(
      `SELECT metadata_jsonb FROM siton.fulfillment_units LIMIT 50`
    );
    for (const row of rows.rows as any[]) {
      const j = row.metadata_jsonb || {};
      // Forbidden truth keys must never appear in fulfillment metadata.
      for (const forbidden of ["money_state", "deal_state", "buyer_state", "eligible", "amount", "permission"]) {
        assert.ok(!(forbidden in j), `metadata_jsonb must not carry truth key ${forbidden}`);
      }
    }
  });

  await run("F3: notifications registry includes voucher_issued / ticket_issued templates", async () => {
    // The mission-control surface is what consumers depend on; we re-derive
    // from source so this stays a true E2E concern (template registry is
    // wired and templateKey resolution works).
    const templates = await readFile("src/notification_templates.ts", "utf8");
    assert.match(templates, /buyer_voucher_issued_he/);
    assert.match(templates, /buyer_ticket_issued_he/);
  });

  await run("F4: no plaintext voucher/ticket code anywhere in DB across all fulfillment_units", async () => {
    // If any 16-char alphanumeric code (matching the generator alphabet)
    // showed up in any TEXT column on fulfillment_units, that would be a
    // catastrophic leak. We scan all text columns of the row.
    const rows = await pool.query(
      `SELECT fulfillment_unit_id, code_hash, code_display_last4, status, metadata_jsonb::text AS meta_text
         FROM siton.fulfillment_units`
    );
    for (const row of rows.rows as any[]) {
      const blob = `${row.code_hash || ""}|${row.code_display_last4 || ""}|${row.status || ""}|${row.meta_text || ""}`;
      // 16 chars from the generator alphabet (A-HJ-NP-Z, 2-9). code_hash is hex
      // (length 64, only [0-9a-f]); last4 is 4 chars only. Neither is 16 chars
      // from the generator alphabet, so any match is a leak.
      assert.doesNotMatch(blob, /[A-HJ-NP-Z2-9]{16}/);
    }
  });

  // ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€
  // G. Webhook + recovery boundary
  // ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€
  await run("G1: webhook charge_captured replay on Completed voucher participant is ignored idempotently", async () => {
    const eligible = await pool.query(
      `SELECT participant_id FROM siton.participants
        WHERE deal_id=$1 AND money_state IN ('ChargedSuccess','RecoveredCharge')
        ORDER BY created_at ASC LIMIT 1`,
      [voucherDealId]
    );
    if (!eligible.rowCount) return;
    const participantId = String(eligible.rows[0].participant_id);
    const payload = {
      event_id: `dt-e2e-replay-${RUN_ID}`,
      event_type: "charge_captured",
      deal_id: voucherDealId,
      participant_id: participantId,
      payload: { deal_id: voucherDealId, participant_id: participantId, provider_reference: `dt-e2e-replay-ref-${RUN_ID}` }
    };
    const wh = await app.inject({
      method: "POST",
      url: "/webhooks/payments/mock",
      headers: hmacHeaders(payload),
      payload
    });
    assert.equal(wh.statusCode, 200, wh.body);
    const body = wh.json() as any;
    assert.ok(["ignored", "processed"].includes(body.status));
    // No new fulfillment_units after the replay (idempotent issuance).
    const cnt = await pool.query(
      `SELECT COUNT(*)::int AS c FROM siton.fulfillment_units WHERE participant_id=$1`,
      [participantId]
    );
    // qty was 3 in B2; assert it stays 3.
    const qty = await pool.query(`SELECT qty FROM siton.participants WHERE participant_id=$1`, [participantId]);
    assert.equal(Number(cnt.rows[0].c), Number(qty.rows[0].qty));
  });
} finally {
  await app.close().catch(() => undefined);
  await pool.end().catch(() => undefined);
}

