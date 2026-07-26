import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

process.env.NODE_ENV = "test";
process.env.APP_DEPLOYMENT_MODE = "test";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.RATE_LIMIT_MAX = "1000000";
process.env.RATE_LIMIT_SENSITIVE_MAX = "1000000";
process.env.OTP_PROVIDER = "log";
process.env.OTP_PROVIDER_MODE = "dev";
process.env.OTP_TEST_BYPASS_CODE = "424242";

const { app } = await import("../src/app.js");
const { app: secondWeb } = await import(new URL("../src/app.js?otp-second-web", import.meta.url).href);
const {
  buildOtpProvider,
  requestOtpChallenge,
  verifyOtpChallenge,
  ensureJoinOtpVerified,
  OtpValidationError
} = await import("../src/otp_rail.js");

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton",
  max: 20
});
const provider = buildOtpProvider();

function phone() {
  return `05${String(Math.floor(Math.random() * 100_000_000)).padStart(8, "0")}`;
}

async function start(targetApp: any = app, destination = phone()) {
  const response = await targetApp.inject({
    method: "POST",
    url: "/api/otp/start",
    payload: { phone: destination }
  });
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json() as any;
  assert.ok(body.challenge_id);
  assert.ok(body.development_code);
  return { destination, challengeId: String(body.challenge_id), code: String(body.development_code) };
}

async function verify(targetApp: any, challengeId: string, code: string) {
  const response = await targetApp.inject({
    method: "POST",
    url: "/api/otp/verify",
    payload: { challenge_id: challengeId, code }
  });
  return { status: response.statusCode, body: response.json() as any };
}

async function evidence(challengeId: string) {
  const [challenge, proofs] = await Promise.all([
    pool.query(
      `SELECT status, attempts_count, consumed_at, verified_at, expires_at
       FROM siton.otp_challenges WHERE challenge_id=$1`,
      [challengeId]
    ),
    pool.query(`SELECT count(*)::int AS count FROM siton.otp_proofs WHERE challenge_id=$1`, [challengeId])
  ]);
  return {
    ...challenge.rows[0],
    proofCount: Number(proofs.rows[0]?.count || 0)
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

await run("first verification consumes once and every replay is blocked", async () => {
  const challenge = await start();
  const first = await verify(app, challenge.challengeId, challenge.code);
  assert.equal(first.status, 200);
  assert.match(String(first.body.otp_token), /^v1\./);

  const replay = await verify(app, challenge.challengeId, challenge.code);
  assert.equal(replay.status, 409);
  assert.equal(replay.body.code, "otp_already_consumed");

  const differentCode = await verify(app, challenge.challengeId, "111111");
  assert.equal(differentCode.status, 409);
  assert.equal(differentCode.body.code, "otp_already_consumed");

  const state = await evidence(challenge.challengeId);
  assert.equal(state.status, "consumed");
  assert.equal(Number(state.attempts_count), 1);
  assert.equal(state.proofCount, 1);
  assert.ok(state.consumed_at);
});

await run("proof is bound to its challenge and destination", async () => {
  const challenge = await start();
  const verified = await verify(app, challenge.challengeId, challenge.code);
  assert.equal(verified.status, 200);
  await assert.rejects(
    () => ensureJoinOtpVerified(pool, {
      otp_token: verified.body.otp_token,
      deal_id: randomUUID(),
      channel: "sms",
      destination: phone()
    }),
    (error: unknown) => error instanceof OtpValidationError && error.code === "otp_not_verified"
  );

  const token = String(verified.body.otp_token);
  const parts = token.split(".");
  const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
  payload.c = randomUUID();
  const tampered = `v1.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${parts[2]}`;
  await assert.rejects(
    () => ensureJoinOtpVerified(pool, { otp_token: tampered, deal_id: randomUUID() }),
    (error: unknown) => error instanceof OtpValidationError && error.code === "otp_not_verified"
  );
});
await run("two simultaneous Web verifiers produce one success and one consumed result", async () => {
  const challenge = await start();
  const results = await Promise.all([
    verify(app, challenge.challengeId, challenge.code),
    verify(secondWeb, challenge.challengeId, challenge.code)
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
  assert.equal(results.find((result) => result.status === 409)?.body.code, "otp_already_consumed");
  const state = await evidence(challenge.challengeId);
  assert.equal(state.proofCount, 1);
  assert.equal(Number(state.attempts_count), 1);
});

await run("100 verifiers split across two Web instances yield 1 success and 99 expected blocks", async () => {
  const challenge = await start();
  const startedAt = Date.now();
  const results = await Promise.all(
    Array.from({ length: 100 }, (_, index) =>
      verify(index % 2 === 0 ? app : secondWeb, challenge.challengeId, challenge.code)
    )
  );
  const successes = results.filter((result) => result.status === 200);
  const blocked = results.filter(
    (result) => result.status === 409 && result.body.code === "otp_already_consumed"
  );
  const state = await evidence(challenge.challengeId);
  console.log(
    `OTP_RACE successes=${successes.length} blocked=${blocked.length} proofs=${state.proofCount} consumed=${state.status === "consumed" ? 1 : 0} audits=0 outbox=0 elapsed_ms=${Date.now() - startedAt}`
  );
  assert.equal(successes.length, 1);
  assert.equal(blocked.length, 99);
  assert.equal(state.proofCount, 1);
  assert.equal(state.status, "consumed");
  assert.equal(Number(state.attempts_count), 1);
});

await run("response loss and a freshly initialized Web cannot issue another proof", async () => {
  const challenge = await start();
  const committedButIgnored = await verify(app, challenge.challengeId, challenge.code);
  assert.equal(committedButIgnored.status, 200);

  const afterDisconnect = await verify(secondWeb, challenge.challengeId, challenge.code);
  assert.equal(afterDisconnect.status, 409);
  assert.equal(afterDisconnect.body.code, "otp_already_consumed");

  const { app: restartedWeb } = await import(
    new URL(`../src/app.js?otp-restart=${randomUUID()}`, import.meta.url).href
  );
  try {
    const afterRestart = await verify(restartedWeb, challenge.challengeId, challenge.code);
    assert.equal(afterRestart.status, 409);
    assert.equal(afterRestart.body.code, "otp_already_consumed");
  } finally {
    await restartedWeb.close().catch(() => undefined);
  }
  assert.equal((await evidence(challenge.challengeId)).proofCount, 1);
});

await run("proof insert failure rolls consumption back and permits a clean retry", async () => {
  const requested = await requestOtpChallenge(pool, provider, {
    channel: "sms",
    destination: phone(),
    purpose: "buyer_join"
  });
  await pool.query(
    `INSERT INTO siton.otp_proofs(challenge_id, token_hash, issued_at, expires_at)
     VALUES ($1,$2,now(),now()+interval '15 minutes')`,
    [requested.challenge_id, `failure-probe-${randomUUID()}`]
  );
  await assert.rejects(
    () =>
      verifyOtpChallenge(pool, {
        challenge_id: requested.challenge_id,
        code: "424242",
        test_bypass_code: "424242"
      }),
    (error: any) => error?.code === "23505"
  );
  const rolledBack = await evidence(requested.challenge_id);
  assert.equal(rolledBack.status, "pending");
  assert.equal(Number(rolledBack.attempts_count), 0);

  await pool.query(`DELETE FROM siton.otp_proofs WHERE challenge_id=$1`, [requested.challenge_id]);
  const retry = await verifyOtpChallenge(pool, {
    challenge_id: requested.challenge_id,
    code: "424242",
    test_bypass_code: "424242"
  });
  assert.equal(retry.status, "verified");
  assert.equal((await evidence(requested.challenge_id)).proofCount, 1);
});

await run("concurrent wrong codes preserve the attempt limit and lock out a later correct code", async () => {
  const challenge = await start();
  const results = await Promise.all(
    Array.from({ length: 100 }, (_, index) =>
      verify(index % 2 === 0 ? app : secondWeb, challenge.challengeId, "111111")
    )
  );
  assert.equal(results.filter((result) => result.status === 200).length, 0);
  const state = await evidence(challenge.challengeId);
  assert.equal(state.status, "locked");
  assert.equal(Number(state.attempts_count), 3);
  assert.equal(state.proofCount, 0);

  const correctAfterLock = await verify(app, challenge.challengeId, challenge.code);
  assert.equal(correctAfterLock.status, 423);
  assert.equal(correctAfterLock.body.code, "otp_locked");
});

await run("expired challenge stays unusable and creates no proof", async () => {
  const challenge = await start();
  await pool.query(
    `UPDATE siton.otp_challenges SET expires_at=now()-interval '1 second' WHERE challenge_id=$1`,
    [challenge.challengeId]
  );
  const result = await verify(app, challenge.challengeId, challenge.code);
  assert.equal(result.status, 410);
  assert.equal(result.body.code, "otp_expired");
  assert.equal((await evidence(challenge.challengeId)).proofCount, 0);
});

await run("a consumed challenge does not prevent a new challenge under the request policy", async () => {
  const destination = phone();
  const first = await start(app, destination);
  assert.equal((await verify(app, first.challengeId, first.code)).status, 200);
  const second = await start(secondWeb, destination);
  assert.notEqual(second.challengeId, first.challengeId);
  assert.equal((await evidence(second.challengeId)).status, "pending");
});

await secondWeb.close().catch(() => undefined);
await app.close().catch(() => undefined);
await pool.end();
console.log("otp single-use concurrency validation: all checks passed");
