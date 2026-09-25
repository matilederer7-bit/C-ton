import { strict as assert } from "node:assert";
import Fastify, { type FastifyInstance } from "fastify";
import pg from "pg";

const { Pool } = pg;

// Red-team finding A1 (High) regression: the admin MFA second factor had NO
// per-challenge attempt cap. A 6-digit code with a 10-minute window and no
// lockout is brute-forceable (10^6 space), and the only throttle was the
// per-IP HTTP limiter — spoofable via X-Forwarded-For under trustProxy. This
// test proves the challenge now locks after ADMIN_MFA_MAX_ATTEMPTS wrong codes
// regardless of source IP, that a correct code AFTER the lock is refused, and
// that the happy path (correct code within budget) still verifies.
// Against the pre-fix code every assertion below fails: the challenge never
// leaves 'Pending' and a correct code always succeeds no matter how many wrong
// codes preceded it.

function fakePaymentProvider() {
  return {
    providerCode: "mockpay",
    mode: "mock-backed" as const,
    webhookProvider: "mockpay",
    configured: true,
    async authorize() {
      return { ok: true as const, provider: "mockpay", authorization_id: "auth_test", provider_reference: "ref_test", correlation_id: "corr_test", authorization: "authorized" as const, hold_message: "test", mock: true };
    },
    async capture() { return { provider: "mockpay", result_class: "success" as const, retryable: false, mock: true }; },
    async recover() { return { provider: "mockpay", result_class: "success" as const, retryable: false, mock: true }; },
    async refund() { return { provider: "mockpay", result_class: "success" as const, retryable: false, mock: true }; }
  };
}

function createWithTx(pool: pg.Pool) {
  return async <T>(fn: (c: any) => Promise<T>) => {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const result = await fn(c);
      await c.query("COMMIT");
      return result;
    } catch (error) {
      await c.query("ROLLBACK");
      throw error;
    } finally {
      c.release();
    }
  };
}

async function buildRuntimeApp(tag: string) {
  for (const key of ["APP_DEPLOYMENT_MODE", "SELLER_SESSION_SECRET"]) delete process.env[key];
  process.env.APP_DEPLOYMENT_MODE = "internal-runtime";
  const { ensureRemainingProductSurfaceTables } = await import(`../src/product_surface_support.js?${tag}-${Date.now()}`);
  const { registerFrontendExperience } = await import(`../src/frontend_runtime.js?${tag}-${Date.now()}`);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton" });
  const withTx = createWithTx(pool);
  await ensureRemainingProductSurfaceTables(withTx);
  const app = Fastify();
  registerFrontendExperience(app, {
    withTx,
    paymentProvider: fakePaymentProvider(),
    deploymentMode: "internal-runtime",
    isDemoPreview: false,
    notificationSummary: { provider: "log-only", mode: "log-only", external_delivery: false },
    debugSurfacesEnabled: false
  });
  return { app, pool };
}

async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (error) { console.error(`FAIL ${name}`); throw error; }
}

async function seedAdmin(pool: any): Promise<string> {
  const { hashAdminPassword } = await import("../src/admin_identity.js");
  const email = `zzz-mfa-bruteforce-${Date.now()}-${Math.random().toString(16).slice(2)}@siton.local`;
  const passwordHash = await hashAdminPassword("NamedAdminPassword123!");
  await pool.query(
    `INSERT INTO siton.admin_users (email, display_name, role, status, password_hash, mfa_required, mfa_enabled)
     VALUES ($1,$1,'SuperAdmin','Active',$2,true,true)`,
    [email, passwordHash]
  );
  return email;
}

async function startLogin(app: FastifyInstance, email: string): Promise<{ challengeId: string; devCode: string }> {
  const login = await app.inject({ method: "POST", url: "/api/admin/auth/login", payload: { email, password: "NamedAdminPassword123!" } });
  assert.equal(login.statusCode, 200, login.body);
  const body = login.json();
  assert.ok(body.mfa_challenge_id, "login must issue an MFA challenge");
  assert.ok(/^\d{6}$/.test(String(body.dev_code)), "non-production login must expose a 6-digit dev_code");
  return { challengeId: body.mfa_challenge_id, devCode: String(body.dev_code) };
}

function verify(app: FastifyInstance, challengeId: string, code: string, ip: string) {
  return app.inject({ method: "POST", url: "/api/admin/auth/mfa/verify", headers: { "content-type": "application/json", "x-forwarded-for": ip }, payload: { mfa_challenge_id: challengeId, code } });
}

const { ADMIN_MFA_MAX_ATTEMPTS } = await import("../src/admin_identity.js");
const MAX = ADMIN_MFA_MAX_ATTEMPTS;

await run("admin MFA challenge locks after the attempt cap and ignores X-Forwarded-For rotation", async () => {
  const { app, pool } = await buildRuntimeApp("admin-mfa-lock");
  try {
    const email = await seedAdmin(pool);
    const { challengeId, devCode } = await startLogin(app, email);
    const wrong = devCode === "000000" ? "111111" : "000000";

    // MAX-1 wrong codes, each from a DIFFERENT spoofed IP: still refused, not locked.
    for (let i = 0; i < MAX - 1; i++) {
      const res = await verify(app, challengeId, wrong, `203.0.113.${i + 1}`);
      assert.equal(res.statusCode, 401, `attempt ${i + 1} body=${res.body}`);
      assert.equal(res.json().error, "mfa_code_invalid", res.body);
    }
    const stillPending = await pool.query(`SELECT status FROM siton.admin_mfa_challenges WHERE mfa_challenge_id=$1`, [challengeId]);
    assert.equal(stillPending.rows[0].status, "Pending", "challenge stays Pending below the cap");

    // The MAX-th wrong code locks the challenge.
    const locked = await verify(app, challengeId, wrong, "198.51.100.9");
    assert.equal(locked.statusCode, 429, locked.body);
    assert.equal(locked.json().error, "mfa_challenge_locked", locked.body);
    // Poll the persisted status (a fresh out-of-band SELECT can trail the
    // handler's COMMIT by a tick under light-my-request; the behavioural proof
    // below is the authoritative security assertion).
    let persistedStatus = "";
    for (let i = 0; i < 50; i++) {
      const row = await pool.query(`SELECT status FROM siton.admin_mfa_challenges WHERE mfa_challenge_id=$1`, [challengeId]);
      persistedStatus = row.rows[0].status;
      if (persistedStatus === "Revoked") break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(persistedStatus, "Revoked", "locked challenge is Revoked");

    // A CORRECT code AFTER the lock must NOT grant a session (brute-force bounded).
    const afterLock = await verify(app, challengeId, devCode, "198.51.100.10");
    assert.equal(afterLock.statusCode, 401, afterLock.body);
    assert.equal(afterLock.json().error, "mfa_challenge_invalid", afterLock.body);
    assert.ok(!String(afterLock.headers["set-cookie"] || "").includes("siton_admin_session="), "no admin session after lock");
  } finally {
    await pool.end();
  }
});

await run("admin MFA happy path still verifies with the correct code within the attempt budget", async () => {
  const { app, pool } = await buildRuntimeApp("admin-mfa-happy");
  try {
    const email = await seedAdmin(pool);
    const { challengeId, devCode } = await startLogin(app, email);
    const wrong = devCode === "000000" ? "111111" : "000000";
    // One wrong code, then the correct one — must still succeed (cap not tripped).
    const bad = await verify(app, challengeId, wrong, "203.0.113.50");
    assert.equal(bad.statusCode, 401, bad.body);
    const good = await verify(app, challengeId, devCode, "203.0.113.50");
    assert.equal(good.statusCode, 200, good.body);
    assert.ok(String(good.headers["set-cookie"] || "").includes("siton_admin_session="), "correct code issues an admin session");
  } finally {
    await pool.end();
  }
});

await run("re-login revokes the prior Pending login challenge (no parallel-challenge accumulation)", async () => {
  const { app, pool } = await buildRuntimeApp("admin-mfa-parallel");
  try {
    const email = await seedAdmin(pool);
    const first = await startLogin(app, email);
    // A second login for the same admin must revoke the first challenge, so an
    // attacker cannot hold N live challenges each worth ADMIN_MFA_MAX_ATTEMPTS.
    const second = await startLogin(app, email);
    assert.notEqual(first.challengeId, second.challengeId);
    const firstNow = await verify(app, first.challengeId, first.devCode, "203.0.113.77");
    assert.equal(firstNow.statusCode, 401, firstNow.body);
    assert.equal(firstNow.json().error, "mfa_challenge_invalid", "the superseded challenge is no longer usable");
    // At most one Pending login challenge exists for the admin.
    const pending = await pool.query(
      `SELECT COUNT(*)::int AS n FROM siton.admin_mfa_challenges c
         JOIN siton.admin_users u ON u.admin_user_id=c.admin_user_id
        WHERE u.email=$1 AND c.purpose='login' AND c.status='Pending'`,
      [email]
    );
    assert.equal(pending.rows[0].n, 1, "only one Pending login challenge remains");

    // Concurrent logins for the same admin must not race the revoke-then-insert
    // into multiple Pending challenges (Codex PR #92 P1). The admin row is
    // locked FOR UPDATE, so the replacements serialize.
    await Promise.all([
      app.inject({ method: "POST", url: "/api/admin/auth/login", payload: { email, password: "NamedAdminPassword123!" } }),
      app.inject({ method: "POST", url: "/api/admin/auth/login", payload: { email, password: "NamedAdminPassword123!" } }),
      app.inject({ method: "POST", url: "/api/admin/auth/login", payload: { email, password: "NamedAdminPassword123!" } })
    ]);
    const afterConcurrent = await pool.query(
      `SELECT COUNT(*)::int AS n FROM siton.admin_mfa_challenges c
         JOIN siton.admin_users u ON u.admin_user_id=c.admin_user_id
        WHERE u.email=$1 AND c.purpose='login' AND c.status='Pending'`,
      [email]
    );
    assert.equal(afterConcurrent.rows[0].n, 1, "concurrent logins still leave exactly one Pending login challenge");
  } finally {
    await pool.end();
  }
});

console.log("PASS admin MFA second factor is brute-force-bounded (attempt cap + lock + single live challenge)");
