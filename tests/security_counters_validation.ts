// Black-Sky F-M6 — security signals on the existing operator surface:
//   * 401 / 403 / 429 responses are counted (limiter refusals included)
//   * every failed admin login and wrong MFA code is counted as a security event
//     while the HTTP answer stays the same indistinguishable 401
//   * a forged payment webhook is counted and now INCLUDED in the infrastructure
//     webhook_failure_rate (it never reaches webhook_events, so it was excluded)
//   * GET /api/admin/system-status exposes the counters (admin-guarded)
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";

process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.PORT = "3152";
process.env.ADMIN_API_KEY = `counters-${randomUUID().slice(0, 8)}`;

const { app } = await import("../src/app.js");
const { pool } = await import("../src/db.js");
const { hashAdminPassword, ADMIN_MFA_MAX_ATTEMPTS } = await import("../src/admin_identity.js");
const { runtimeCounterValue } = await import("../src/runtime_counters.js");

let failed = 0;
async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (e: any) { console.error(`FAIL ${name}: ${e?.stack || e?.message}`); failed++; }
}
const delta = async (name: Parameters<typeof runtimeCounterValue>[0], fn: () => Promise<void>) => {
  const before = runtimeCounterValue(name);
  await fn();
  return runtimeCounterValue(name) - before;
};

const email = `counters-${randomUUID().slice(0, 6)}@siton.local`;
await app.inject({ method: "GET", url: "/api/admin/auth/me" }); // schema bootstrap
await pool.query(
  `INSERT INTO siton.admin_users (email, display_name, role, status, password_hash, mfa_required, mfa_enabled)
   VALUES ($1,$1,'SuperAdmin','Active',$2,true,true)`,
  [email, await hashAdminPassword("CountersPass123!")]
);

await run("401 responses are counted", async () => {
  const d = await delta("http_401_total", async () => {
    const res = await app.inject({ method: "GET", url: "/api/admin/actions" });
    assert.equal(res.statusCode, 401);
  });
  assert.equal(d, 1);
});

await run("failed admin logins are security events; the answer stays one 401 for every case", async () => {
  const bodies: string[] = [];
  const d = await delta("admin_login_failed_total", async () => {
    for (const payload of [
      { email, password: "wrong-password" },
      { email: `nobody-${randomUUID().slice(0, 6)}@siton.local`, password: "whatever" }
    ]) {
      const res = await app.inject({ method: "POST", url: "/api/admin/auth/login", payload });
      assert.equal(res.statusCode, 401);
      bodies.push(res.body);
    }
  });
  assert.equal(d, 2);
  assert.equal(bodies[0], bodies[1], "no account-existence oracle");
});

await run("wrong MFA codes are counted, and the lock answers 429 (counted)", async () => {
  const login = await app.inject({ method: "POST", url: "/api/admin/auth/login", payload: { email, password: "CountersPass123!" } });
  assert.equal(login.statusCode, 200, login.body);
  const challenge = login.json() as any;
  const wrong = challenge.dev_code === "000000" ? "111111" : "000000";
  const before429 = runtimeCounterValue("http_429_total");
  const d = await delta("admin_mfa_failed_total", async () => {
    for (let i = 0; i < ADMIN_MFA_MAX_ATTEMPTS; i++) {
      const res = await app.inject({ method: "POST", url: "/api/admin/auth/mfa/verify", payload: { mfa_challenge_id: challenge.mfa_challenge_id, code: wrong } });
      assert.ok([401, 429].includes(res.statusCode), res.body);
    }
  });
  assert.equal(d, ADMIN_MFA_MAX_ATTEMPTS);
  assert.equal(runtimeCounterValue("http_429_total") - before429, 1);
});

await run("a forged payment webhook is counted and included in the webhook failure rate", async () => {
  const d = await delta("webhook_signature_failed_total", async () => {
    const res = await app.inject({
      method: "POST", url: "/webhooks/payments",
      headers: { "content-type": "application/json", "x-webhook-signature": "sha256=deadbeef", "x-webhook-timestamp": String(Math.floor(Date.now() / 1000)) },
      payload: { event_id: `forged-${randomUUID()}`, type: "payment.authorized" }
    });
    assert.ok(res.statusCode >= 400 && res.statusCode < 500, `${res.statusCode} ${res.body}`);
  });
  assert.equal(d, 1);
  const rejected = await pool.query(`SELECT count(*)::int AS n FROM siton.payment_webhook_security_events WHERE created_at >= now() - interval '15 minutes'`);
  assert.ok(rejected.rows[0].n >= 1);

  const status = await app.inject({ method: "GET", url: "/api/admin/system-status", headers: { "x-admin-key": String(process.env.ADMIN_API_KEY) } });
  assert.equal(status.statusCode, 200, status.body);
  const body = status.json() as any;
  const rate = body.system_status.infrastructure.metrics.webhook_failure_rate;
  assert.equal(rate.availability, "available", JSON.stringify(rate));
  assert.ok(rate.value > 0, `a forged webhook must move the failure rate: ${JSON.stringify(rate)}`);
  const counters = body.system_status.security_counters;
  assert.equal(counters.scope, "process");
  for (const name of ["http_401_total", "http_403_total", "http_429_total", "admin_login_failed_total", "admin_mfa_failed_total", "webhook_signature_failed_total", "outbox_reclaim_row_failed_total"]) {
    assert.equal(typeof counters.counters[name], "number", name);
  }
  assert.ok(counters.counters.admin_login_failed_total >= 2);
  assert.ok(counters.counters.webhook_signature_failed_total >= 1);
});

await run("the counters are admin-only", async () => {
  const res = await app.inject({ method: "GET", url: "/api/admin/system-status" });
  assert.equal(res.statusCode, 401);
});

await app.close();
if (failed) process.exit(1);
console.log("PASS security counters (F-M6)");
