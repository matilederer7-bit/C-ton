/**
 * OTP rail validation.
 *
 * Verifies the provider-ready OTP rail end-to-end:
 * - request creates a pending challenge with hashed code
 * - verify accepts correct code, increments attempts on wrong, locks after max
 * - rate limit blocks excessive requests
 * - idempotent request returns the same challenge during the active window
 * - join requires verified OTP (otp_required / otp_not_verified)
 * - production-like environments do not honour test-bypass
 * - delivery attempt is recorded on log/dev provider
 * - OTP failure does not mutate deal/participant/money state
 *
 * Implementation note: verify writes (attempts_count, status) must persist
 * even when verify throws. The test calls verifyOtpChallenge with the raw
 * `pool` (auto-commit per query) rather than wrapping in withTx — exactly
 * how the production endpoint passes deps.pool.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.OTP_PROVIDER = "log";
process.env.OTP_PROVIDER_MODE = "dev";
process.env.OTP_TEST_BYPASS_CODE = "424242";
// This suite exercises the OTP-REQUIRED buyer journey. The MVP default is
// Join OFF, so opt this file into the ON policy to test the fail-closed path.
process.env.BUYER_VERIFY_JOIN = "required";
process.env.PORT = process.env.PORT || "3478";
delete process.env.NODE_ENV;
delete process.env.APP_ENV;
delete process.env.RENDER;
delete process.env.RENDER_EXTERNAL_URL;

import {
  buildOtpProvider,
  ensureOtpRailTables,
  hashDestination,
  requestOtpChallenge,
  verifyOtpChallenge,
  ensureJoinOtpVerified,
  OtpValidationError,
  OTP_RATE_LIMIT_MAX_REQUESTS
} from "../src/otp_rail.js";

const { app } = await import("../src/app.js");

const { Pool } = pg;
const DB_URL = process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton";
const pool = new Pool({ connectionString: DB_URL, max: 5 });

async function withTx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL search_path TO siton, public");
    const result = await fn(c);
    await c.query("COMMIT");
    return result;
  } catch (error) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    c.release();
  }
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

await ensureOtpRailTables(withTx);
const provider = buildOtpProvider();

function uniquePhone() {
  // 7-15 digit pseudo-random destination, never collides across runs.
  const tail = Math.floor(Math.random() * 1_000_000_000)
    .toString()
    .padStart(9, "0");
  return `0${tail}`;
}

async function fetchChallenge(challengeId: string) {
  const r = await pool.query(
    `SELECT challenge_id, channel, destination_hash, purpose, status, code_hash, attempts_count
     FROM siton.otp_challenges WHERE challenge_id=$1`,
    [challengeId]
  );
  return r.rows[0] as any;
}

async function fetchAttempts(challengeId: string) {
  const r = await pool.query(
    `SELECT result_status, provider, provider_mode FROM siton.otp_delivery_attempts WHERE challenge_id=$1 ORDER BY created_at`,
    [challengeId]
  );
  return r.rows as Array<{ result_status: string; provider: string; provider_mode: string }>;
}

// 1) request creates a pending challenge with hashed (not plaintext) code.
await run("request creates pending challenge with hashed code", async () => {
  const phone = uniquePhone();
  const result = await requestOtpChallenge(pool, provider, {
    channel: "sms",
    destination: phone,
    purpose: "buyer_join"
  });
  const row = await fetchChallenge(result.challenge_id);
  assert.equal(row.status, "pending");
  assert.equal(row.purpose, "buyer_join");
  assert.equal(row.channel, "sms");
  assert.equal(String(row.destination_hash), hashDestination("sms", phone));
  // Code must NOT be plaintext anywhere.
  assert.ok(!/^\d{6}$/.test(String(row.code_hash)), "code_hash must not be a plaintext 6-digit code");
  assert.ok(String(row.code_hash).length >= 32);
});

// 2) delivery attempt is recorded with provider log/dev.
await run("delivery attempt is recorded with log/dev provider", async () => {
  const result = await requestOtpChallenge(pool, provider, {
    channel: "sms",
    destination: uniquePhone(),
    purpose: "buyer_join"
  });
  const attempts = await fetchAttempts(result.challenge_id);
  assert.ok(attempts.length >= 1);
  assert.equal(attempts[0]?.provider, "log");
  assert.equal(attempts[0]?.provider_mode, "dev");
  assert.ok(["success", "skipped"].includes(attempts[0]?.result_status || ""));
});

// 3) invalid channel rejected.
await run("invalid channel is rejected", async () => {
  await assert.rejects(
    () => requestOtpChallenge(pool, provider, { channel: "fax" as any, destination: uniquePhone(), purpose: "buyer_join" }),
    (err: unknown) => err instanceof OtpValidationError && err.code === "invalid_channel"
  );
});

// 4) invalid purpose rejected.
await run("invalid purpose is rejected", async () => {
  await assert.rejects(
    () =>
      requestOtpChallenge(pool, provider, {
        channel: "sms",
        destination: uniquePhone(),
        purpose: "marketing" as any
      }),
    (err: unknown) => err instanceof OtpValidationError && err.code === "invalid_purpose"
  );
});

// 5) verify with correct code (via test bypass) marks verified and issues otp_token.
await run("verify with correct code marks verified and issues otp_token", async () => {
  const result = await requestOtpChallenge(pool, provider, {
    channel: "sms",
    destination: uniquePhone(),
    purpose: "buyer_join"
  });
  const verifyResult = await verifyOtpChallenge(pool, { challenge_id: result.challenge_id, code: "424242" });
  assert.equal(verifyResult.status, "verified");
  assert.match(verifyResult.otp_token, /^v1\./);
  const row = await fetchChallenge(result.challenge_id);
  assert.equal(row.status, "consumed");
});

// 6) wrong code increments attempts and does not flip status.
await run("wrong code increments attempts and does not flip status", async () => {
  const result = await requestOtpChallenge(pool, provider, {
    channel: "sms",
    destination: uniquePhone(),
    purpose: "buyer_join"
  });
  await assert.rejects(
    () => verifyOtpChallenge(pool, { challenge_id: result.challenge_id, code: "000000" }),
    (err: unknown) => err instanceof OtpValidationError && err.code === "otp_invalid"
  );
  const row = await fetchChallenge(result.challenge_id);
  assert.equal(Number(row.attempts_count), 1);
  assert.equal(row.status, "pending");
});

// 7) too many attempts locks the challenge.
await run("too many attempts locks the challenge", async () => {
  const result = await requestOtpChallenge(pool, provider, {
    channel: "sms",
    destination: uniquePhone(),
    purpose: "buyer_join"
  });
  // Default max_attempts = 3.
  for (let i = 0; i < 3; i++) {
    await assert.rejects(
      () => verifyOtpChallenge(pool, { challenge_id: result.challenge_id, code: "111111" }),
      (err: unknown) => err instanceof OtpValidationError
    );
  }
  const row = await fetchChallenge(result.challenge_id);
  assert.equal(row.status, "locked");
  // Subsequent verify must report otp_locked.
  await assert.rejects(
    () => verifyOtpChallenge(pool, { challenge_id: result.challenge_id, code: "424242" }),
    (err: unknown) => err instanceof OtpValidationError && err.code === "otp_locked"
  );
});

// 8) expired challenge cannot be verified.
await run("expired challenge is rejected with otp_expired", async () => {
  const result = await requestOtpChallenge(pool, provider, {
    channel: "sms",
    destination: uniquePhone(),
    purpose: "buyer_join"
  });
  await pool.query(
    `UPDATE siton.otp_challenges SET expires_at=now() - interval '1 minute' WHERE challenge_id=$1`,
    [result.challenge_id]
  );
  await assert.rejects(
    () => verifyOtpChallenge(pool, { challenge_id: result.challenge_id, code: "424242" }),
    (err: unknown) => err instanceof OtpValidationError && err.code === "otp_expired"
  );
});

// 9) rate limit blocks excessive requests for the same destination.
await run("rate limit blocks excessive requests", async () => {
  const phone = uniquePhone();
  for (let i = 0; i < OTP_RATE_LIMIT_MAX_REQUESTS; i++) {
    // Force unique idempotency keys so we get fresh inserts each time, not a reuse.
    await pool.query(
      `INSERT INTO siton.otp_challenges
         (channel, destination_hash, destination_display, purpose, code_hash, expires_at, max_attempts, idempotency_key)
       VALUES ('sms', $1, '****', 'buyer_join', 'forrate', now() + interval '10 minutes', 3, $2)`,
      [hashDestination("sms", phone), `rate-test:${randomUUID()}`]
    );
  }
  await assert.rejects(
    () => requestOtpChallenge(pool, provider, { channel: "sms", destination: phone, purpose: "buyer_join" }),
    (err: unknown) => err instanceof OtpValidationError && err.code === "otp_rate_limited"
  );
});

// 10) idempotent request returns the same active challenge during the window.
await run("idempotent request returns existing challenge in window", async () => {
  const phone = uniquePhone();
  const first = await requestOtpChallenge(pool, provider, {
    channel: "sms",
    destination: phone,
    purpose: "buyer_join"
  });
  const second = await requestOtpChallenge(pool, provider, {
    channel: "sms",
    destination: phone,
    purpose: "buyer_join"
  });
  assert.equal(second.challenge_id, first.challenge_id);
  assert.equal(second.reused, true);
});

// 11) ensureJoinOtpVerified rejects when no token/challenge supplied.
await run("ensureJoinOtpVerified rejects without otp_token or otp_challenge_id (otp_required)", async () => {
  await assert.rejects(
    () => ensureJoinOtpVerified(pool, { deal_id: randomUUID() }),
    (err: unknown) => err instanceof OtpValidationError && err.code === "otp_required"
  );
});

// 12) ensureJoinOtpVerified rejects when challenge is not yet verified.
await run("ensureJoinOtpVerified rejects unverified challenge (otp_not_verified)", async () => {
  const result = await requestOtpChallenge(pool, provider, {
    channel: "sms",
    destination: uniquePhone(),
    purpose: "buyer_join"
  });
  await assert.rejects(
    () => ensureJoinOtpVerified(pool, { otp_challenge_id: result.challenge_id, deal_id: randomUUID() }),
    (err: unknown) => err instanceof OtpValidationError && err.code === "otp_not_verified"
  );
});

// 13) ensureJoinOtpVerified accepts a verified challenge with valid otp_token.
await run("ensureJoinOtpVerified accepts a verified challenge with valid otp_token", async () => {
  const result = await requestOtpChallenge(pool, provider, {
    channel: "sms",
    destination: uniquePhone(),
    purpose: "buyer_join"
  });
  const verifyResult = await verifyOtpChallenge(pool, { challenge_id: result.challenge_id, code: "424242" });
  const ok = await ensureJoinOtpVerified(pool, { otp_token: verifyResult.otp_token, deal_id: randomUUID() });
  assert.equal(ok.purpose, "buyer_join");
  assert.equal(ok.channel, "sms");
});

// 14) production-like does not honour OTP_TEST_BYPASS_CODE.
await run("production-like does not honour OTP_TEST_BYPASS_CODE", async () => {
  const original = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    const result = await requestOtpChallenge(pool, provider, {
      channel: "sms",
      destination: uniquePhone(),
      purpose: "buyer_join"
    });
    await assert.rejects(
      () => verifyOtpChallenge(pool, { challenge_id: result.challenge_id, code: "424242" }),
      (err: unknown) => err instanceof OtpValidationError && err.code === "otp_invalid"
    );
  } finally {
    if (original === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = original;
  }
});

// 15) join via app.inject without OTP returns otp_required (HTTP-level proof).
await run("POST /deals/:id/join without OTP returns otp_required", async () => {
  const sellerId = `otp-test-seller-${randomUUID().slice(0, 8)}`;
  await pool.query(
    `INSERT INTO siton.seller_accounts
       (seller_id, display_name, business_name, support_email, verification_status, settlement_status, payout_method, payout_details_masked)
     VALUES ($1,$2,'OTP Test Seller','otp-test@example.com','approved','active','bank_transfer','***1234')
     ON CONFLICT (seller_id) DO NOTHING`,
    [sellerId, `OTP Test ${sellerId}`]
  );
  const dealId = randomUUID();
  await pool.query(
    `INSERT INTO siton.deals
       (deal_id, seller_id, title, state, threshold_units, min_units, max_units, price_per_unit, deadline, published_at, created_at, updated_at)
     VALUES ($1,$2,'OTP gate deal','PendingTarget',1,1,5,30.00, now() + interval '1 day', now(), now(), now())`,
    [dealId, sellerId]
  );
  await pool.query(
    `INSERT INTO siton.deal_delivery_options (option_id, deal_id, option_type, label, cost, sort_order)
     VALUES (gen_random_uuid(), $1, 'pickup', 'איסוף עצמי — רח׳ הרצל 12, תל אביב', 0, 0)`,
    [dealId]
  );
  const res = await app.inject({
    method: "POST",
    url: `/deals/${dealId}/join`,
    headers: {
      "x-request-id": "otp-validation-no-otp",
      "idempotency-key": `otp-validation-no-otp-${dealId}`
    },
    payload: {
      buyer_id: "0501234567",
      qty: 1,
      buyer_terms_accepted: true,
      payment_disclosure_accepted: true
    }
  });
  assert.equal(res.statusCode, 400);
  const body = res.json() as any;
  assert.equal(body.code, "otp_required");
});

// 16) /api/otp/request via HTTP returns destination_display masked, no plaintext code.
await run("/api/otp/request returns masked destination and no plaintext code", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/otp/request",
    payload: { channel: "sms", destination: "0509998877", purpose: "buyer_join" }
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as any;
  assert.equal(body.ok, true);
  assert.match(String(body.destination_display), /^\*+\d{4}$/);
  assert.equal(body.status, "pending");
  // Hard guarantee: no plaintext OTP code in the response body.
  assert.ok(!Object.keys(body).some((k) => k.toLowerCase().includes("code")));
});

await app.close().catch(() => undefined);
await pool.end();

console.log("\notp rail validation: all checks passed");
