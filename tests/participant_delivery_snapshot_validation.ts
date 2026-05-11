/**
 * Participant Delivery Snapshot Validation
 *
 * Tests that the join endpoint persists buyer contact and delivery address
 * fields, that the shipping export includes them, and that validation works
 * correctly for delivery-type options requiring an address.
 *
 *   S1 — schema: snapshot columns exist in siton.participants
 *   S2 — join persists buyer_phone, delivery_method, delivery_address, delivery_city, delivery_notes
 *   S3 — join persists buyer_name and buyer_email when provided
 *   S4 — shipping export CSV includes snapshot fields
 *   S5 — pickup option does NOT require delivery_address
 *   S6 — delivery option DOES require delivery_address (returns 400 + delivery_address_required)
 *   S7 — invalid delivery_option_id returns invalid_delivery_option
 *   S8 — ownership 403 still enforced after schema change
 */

import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import pg from "pg";
const { Pool } = pg;

process.env.PORT = String(process.env.PORT || "3418");
process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.DISABLE_OUTBOX_WORKER = "1";

const { app } = await import("../src/app.js");

const pool = new Pool({ connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton", max: 5 });

async function run(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

async function createDeal(sellerId: string, options?: {
  withDeliveryOption?: boolean;
  deliveryOptionType?: "delivery" | "pickup" | "distribution_point";
}) {
  const dealId = randomUUID();
  await pool.query(
    `INSERT INTO siton.deals
       (deal_id, seller_id, title, state, threshold_units, min_units, max_units,
        price_per_unit, deadline, published_at, created_at, updated_at)
     VALUES ($1,$2,$3,'PendingTarget',1,1,50,100.00,
             now()+interval '7 days', now(), now(), now())
     ON CONFLICT (deal_id) DO NOTHING`,
    [dealId, sellerId, `Test Deal ${dealId.slice(0, 8)}`]
  );

  if (options?.withDeliveryOption) {
    const optionType = options.deliveryOptionType ?? "delivery";
    await pool.query(
      `INSERT INTO siton.deal_delivery_options (deal_id, option_type, label, cost, sort_order)
       VALUES ($1, $2, $3, 0, 0)
       ON CONFLICT DO NOTHING`,
      [dealId, optionType, optionType === "delivery" ? "Courier Delivery" : "Self Pickup"]
    );
  }

  return dealId;
}

// Insert a pre-verified OTP challenge so the join endpoint accepts it without a real OTP flow.
async function createVerifiedOtpChallenge(dealId: string): Promise<string> {
  const challengeId = randomUUID();
  const idempotencyKey = `test:buyer_join:${challengeId}`;
  await pool.query(
    `INSERT INTO siton.otp_challenges
       (challenge_id, channel, destination_hash, destination_display, purpose,
        code_hash, status, expires_at, verified_at, max_attempts, attempts_count,
        resend_count, idempotency_key, deal_id, created_at, updated_at)
     VALUES ($1,'sms','test-hash','test-display','buyer_join',
             'test-code-hash','verified',now()+interval '1 hour',now(),3,1,
             0,$2,$3,now(),now())`,
    [challengeId, idempotencyKey, dealId]
  );
  return challengeId;
}

async function completeDealWithParticipants(
  sellerId: string,
  participants: Array<{ buyerState: string; moneyState: string; buyerName?: string; buyerPhone?: string; buyerEmail?: string; deliveryAddress?: string; deliveryCity?: string; deliveryNotes?: string }>
) {
  const dealId = randomUUID();
  await pool.query(
    `INSERT INTO siton.deals
       (deal_id, seller_id, title, state, threshold_units, min_units, max_units,
        price_per_unit, deadline, published_at, created_at, updated_at)
     VALUES ($1,$2,'עסקה בדיקה snapshot','Completed',1,1,10,100.00,
             now()+interval '7 days', now(), now(), now())
     ON CONFLICT (deal_id) DO NOTHING`,
    [dealId, sellerId]
  );

  const participantIds: string[] = [];
  for (const p of participants) {
    const pid = randomUUID();
    await pool.query(
      `INSERT INTO siton.participants
         (participant_id, deal_id, buyer_id, qty, buyer_state, money_state,
          buyer_name, buyer_phone, buyer_email,
          delivery_address, delivery_city, delivery_notes,
          created_at, updated_at)
       VALUES ($1,$2,$3,1,$4,$5,$6,$7,$8,$9,$10,$11,now(),now())
       ON CONFLICT (participant_id) DO NOTHING`,
      [
        pid, dealId, p.buyerPhone || "+972500000000", p.buyerState, p.moneyState,
        p.buyerName ?? null, p.buyerPhone ?? null, p.buyerEmail ?? null,
        p.deliveryAddress ?? null, p.deliveryCity ?? null, p.deliveryNotes ?? null
      ]
    );
    participantIds.push(pid);
  }
  return { dealId, participantIds };
}

// ─── S1: schema columns exist ────────────────────────────────────────────────
await run("S1 snapshot columns exist in siton.participants", async () => {
  const result = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'siton' AND table_name = 'participants'
       AND column_name IN ('buyer_name','buyer_phone','buyer_email',
                           'delivery_address','delivery_city','delivery_notes')`
  );
  const cols = result.rows.map((r: any) => r.column_name as string);
  for (const expected of ["buyer_name", "buyer_phone", "buyer_email", "delivery_address", "delivery_city", "delivery_notes"]) {
    assert.ok(cols.includes(expected), `column ${expected} missing from siton.participants`);
  }
});

// ─── S2: join persists delivery snapshot ─────────────────────────────────────
await run("S2 join persists buyer_phone (from buyer_id), delivery_address, delivery_city, delivery_notes", async () => {
  const sellerId = `seller-snap-${randomUUID().slice(0, 8)}`;
  const dealId = await createDeal(sellerId, { withDeliveryOption: true, deliveryOptionType: "delivery" });
  const otpChallengeId = await createVerifiedOtpChallenge(dealId);

  const buyerId = "+972501234567";
  const res = await app.inject({
    method: "POST",
    url: `/deals/${dealId}/join`,
    payload: {
      buyer_id: buyerId,
      otp_challenge_id: otpChallengeId,
      delivery_address: "רחוב הרצל 5",
      delivery_city: "תל אביב",
      delivery_notes: "קומה 3, דירה 12",
      qty: 1,
      buyer_terms_accepted: true,
      payment_disclosure_accepted: true
    }
  });
  assert.equal(res.statusCode, 200, `join failed: ${res.body}`);
  const { participant_id } = res.json();
  assert.ok(participant_id, "no participant_id in response");

  const row = await pool.query(
    `SELECT buyer_phone, delivery_address, delivery_city, delivery_notes
     FROM siton.participants WHERE participant_id = $1`,
    [participant_id]
  );
  assert.ok(row.rowCount, "participant not found");
  const p = row.rows[0] as any;
  assert.equal(p.buyer_phone, buyerId, "buyer_phone should equal buyer_id (OTP phone)");
  assert.equal(p.delivery_address, "רחוב הרצל 5", "delivery_address not persisted");
  assert.equal(p.delivery_city, "תל אביב", "delivery_city not persisted");
  assert.equal(p.delivery_notes, "קומה 3, דירה 12", "delivery_notes not persisted");
});

// ─── S3: join persists optional buyer_name and buyer_email ───────────────────
await run("S3 join persists buyer_name and buyer_email when provided", async () => {
  const sellerId = `seller-snap-nm-${randomUUID().slice(0, 8)}`;
  const dealId = await createDeal(sellerId, { withDeliveryOption: true, deliveryOptionType: "delivery" });
  const otpChallengeId = await createVerifiedOtpChallenge(dealId);

  const res = await app.inject({
    method: "POST",
    url: `/deals/${dealId}/join`,
    payload: {
      buyer_id: "+972509876543",
      otp_challenge_id: otpChallengeId,
      buyer_name: "ישראל ישראלי",
      buyer_email: "israel@example.com",
      delivery_address: "שדרות רוטשילד 10",
      qty: 1,
      buyer_terms_accepted: true,
      payment_disclosure_accepted: true
    }
  });
  assert.equal(res.statusCode, 200, `join failed: ${res.body}`);
  const { participant_id } = res.json();

  const row = await pool.query(
    `SELECT buyer_name, buyer_email FROM siton.participants WHERE participant_id = $1`,
    [participant_id]
  );
  const p = row.rows[0] as any;
  assert.equal(p.buyer_name, "ישראל ישראלי", "buyer_name not persisted");
  assert.equal(p.buyer_email, "israel@example.com", "buyer_email not persisted");
});

// ─── S4: export CSV includes snapshot fields ──────────────────────────────────
await run("S4 shipping export CSV includes buyer_name, buyer_phone, delivery_address", async () => {
  const sellerId = `seller-snap-exp-${randomUUID().slice(0, 8)}`;
  const { dealId } = await completeDealWithParticipants(sellerId, [
    {
      buyerState: "DealCompleted", moneyState: "ChargedSuccess",
      buyerName: "מרים כהן", buyerPhone: "+972541111111", buyerEmail: "miriam@example.com",
      deliveryAddress: "דרך בן גוריון 7", deliveryCity: "חיפה", deliveryNotes: "בבקשה להשאיר בדלת"
    }
  ]);

  const res = await app.inject({
    method: "GET",
    url: `/api/seller/deals/${dealId}/shipping-export`,
    headers: { "x-seller-id": sellerId }
  });
  assert.equal(res.statusCode, 200, `export failed: ${res.body}`);

  const csv = res.body.replace(/^﻿/, "");
  const lines = csv.split("\r\n").filter((l: string) => l.trim());
  assert.ok(lines.length >= 2, `expected header + at least 1 row, got: ${csv}`);

  const headerCols = (lines[0] ?? "").split(",");
  assert.ok(headerCols.includes("buyer_name"), "CSV missing buyer_name column");
  assert.ok(headerCols.includes("buyer_phone"), "CSV missing buyer_phone column");
  assert.ok(headerCols.includes("buyer_email"), "CSV missing buyer_email column");
  assert.ok(headerCols.includes("delivery_address"), "CSV missing delivery_address column");
  assert.ok(headerCols.includes("delivery_city"), "CSV missing delivery_city column");
  assert.ok(headerCols.includes("delivery_notes"), "CSV missing delivery_notes column");

  const dataRow = lines[1] ?? "";
  assert.ok(dataRow.includes("מרים כהן"), "buyer_name value missing from export row");
  assert.ok(dataRow.includes("+972541111111"), "buyer_phone value missing from export row");
  assert.ok(dataRow.includes("חיפה"), "delivery_city missing from export row");
});

// ─── S5: pickup does NOT require delivery_address ────────────────────────────
await run("S5 pickup option does not require delivery_address", async () => {
  const sellerId = `seller-pickup-${randomUUID().slice(0, 8)}`;
  const dealId = await createDeal(sellerId, { withDeliveryOption: true, deliveryOptionType: "pickup" });
  const otpChallengeId = await createVerifiedOtpChallenge(dealId);

  const res = await app.inject({
    method: "POST",
    url: `/deals/${dealId}/join`,
    payload: {
      buyer_id: "+972502222222",
      otp_challenge_id: otpChallengeId,
      qty: 1,
      buyer_terms_accepted: true,
      payment_disclosure_accepted: true
      // no delivery_address — pickup should succeed without it
    }
  });
  assert.equal(res.statusCode, 200, `pickup join failed unexpectedly: ${res.body}`);
});

// ─── S6: delivery option DOES require delivery_address ───────────────────────
await run("S6 delivery option returns 400 delivery_address_required when address is missing", async () => {
  const sellerId = `seller-deliv-${randomUUID().slice(0, 8)}`;
  const dealId = await createDeal(sellerId, { withDeliveryOption: true, deliveryOptionType: "delivery" });
  const otpChallengeId = await createVerifiedOtpChallenge(dealId);

  const res = await app.inject({
    method: "POST",
    url: `/deals/${dealId}/join`,
    payload: {
      buyer_id: "+972503333333",
      otp_challenge_id: otpChallengeId,
      qty: 1,
      buyer_terms_accepted: true,
      payment_disclosure_accepted: true
      // deliberately omit delivery_address
    }
  });
  assert.equal(res.statusCode, 400, `expected 400, got ${res.statusCode}: ${res.body}`);
  const body = res.json();
  const msg = String(body.error || body.message || body.code || "");
  assert.ok(
    msg.toLowerCase().includes("delivery_address") || msg.toLowerCase().includes("address"),
    `expected delivery_address error, got: ${JSON.stringify(body)}`
  );
});

// ─── S7: invalid delivery_option_id returns error ────────────────────────────
await run("S7 invalid delivery_option_id returns invalid_delivery_option and creates no participant", async () => {
  const sellerId = `seller-invalid-opt-${randomUUID().slice(0, 8)}`;
  const dealId = await createDeal(sellerId, { withDeliveryOption: true, deliveryOptionType: "delivery" });
  const otpChallengeId = await createVerifiedOtpChallenge(dealId);
  const invalidOptionId = randomUUID();
  const buyerId = "+972504444444";

  const res = await app.inject({
    method: "POST",
    url: `/deals/${dealId}/join`,
    payload: {
      buyer_id: buyerId,
      otp_challenge_id: otpChallengeId,
      delivery_option_id: invalidOptionId,
      delivery_address: "רחוב הנביאים 1",
      qty: 1,
      buyer_terms_accepted: true,
      payment_disclosure_accepted: true
    }
  });

  assert.ok([400, 409].includes(res.statusCode), `expected 400/409, got ${res.statusCode}: ${res.body}`);
  const body = res.json();
  const code = String(body.code || body.error || body.message || "");
  assert.ok(code.includes("invalid_delivery_option"), `expected invalid_delivery_option, got: ${JSON.stringify(body)}`);

  const participants = await pool.query(
    `SELECT COUNT(*)::int AS count FROM siton.participants WHERE deal_id=$1 AND buyer_id=$2`,
    [dealId, buyerId]
  );
  assert.equal(Number(participants.rows[0]?.count || 0), 0, "invalid delivery option must not create a participant");
});

await run("S8 join rejects boolean, string, exponent, decimal and non-positive qty values", async () => {
  const sellerId = `seller-bad-qty-${randomUUID().slice(0, 8)}`;
  const dealId = await createDeal(sellerId, { withDeliveryOption: true, deliveryOptionType: "pickup" });
  for (const qty of [true, "1", "1e2", 1.5, 0, -1]) {
    const otpChallengeId = await createVerifiedOtpChallenge(dealId);
    const buyerId = `+97250${String(randomUUID()).replace(/\D/g, "").slice(0, 7).padEnd(7, "0")}`;
    const res = await app.inject({
      method: "POST",
      url: `/deals/${dealId}/join`,
      payload: {
        buyer_id: buyerId,
        otp_challenge_id: otpChallengeId,
        qty,
        buyer_terms_accepted: true,
        payment_disclosure_accepted: true
      }
    });
    assert.equal(res.statusCode, 400, `qty=${String(qty)} should be rejected: ${res.body}`);
    const participants = await pool.query(
      `SELECT COUNT(*)::int AS count FROM siton.participants WHERE deal_id=$1 AND buyer_id=$2`,
      [dealId, buyerId]
    );
    assert.equal(Number(participants.rows[0]?.count || 0), 0, `qty=${String(qty)} must not create a participant`);
  }
});

await run("S9 ownership 403 still enforced after schema migration", async () => {
  const ownerSellerId = `seller-owner2-${randomUUID().slice(0, 8)}`;
  const otherSellerId = `seller-other2-${randomUUID().slice(0, 8)}`;
  const { dealId } = await completeDealWithParticipants(ownerSellerId, [
    { buyerState: "DealCompleted", moneyState: "ChargedSuccess" }
  ]);

  const res = await app.inject({
    method: "GET",
    url: `/api/seller/deals/${dealId}/shipping-export`,
    headers: { "x-seller-id": otherSellerId }
  });
  assert.equal(res.statusCode, 403, `expected 403, got ${res.statusCode}: ${res.body}`);
});

await pool.end();
await app.close();
console.log("All participant delivery snapshot tests passed.");
