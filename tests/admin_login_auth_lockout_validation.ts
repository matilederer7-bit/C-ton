import { strict as assert } from "node:assert";
import Fastify, { type FastifyInstance } from "fastify";
import pg from "pg";

const { Pool } = pg;

// Red-team finding A3 (Medium) regression: the admin password login had NO
// per-account lockout, so with a spoofable client IP the password step had an
// unbounded guessing budget. The account now locks itself after
// ADMIN_LOGIN_MAX_FAILURES wrong passwords inside a sliding window — regardless
// of source IP — refuses even the CORRECT password while locked, and heals by
// itself once the lock expires. The lock is enforced internally and answers
// the SAME 401 body as a wrong password or an unknown e-mail, so exhausting a
// candidate's counter never reveals whether the account exists (no oracle,
// Codex on PR #97). Against the pre-fix code the "locked" assertions below
// fail: the correct password always succeeds.

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

const PASSWORD = "NamedAdminPassword123!";

async function seedAdmin(pool: any, mfa: boolean): Promise<string> {
  const { hashAdminPassword } = await import("../src/admin_identity.js");
  const email = `zzz-login-lockout-${Date.now()}-${Math.random().toString(16).slice(2)}@siton.local`;
  const passwordHash = await hashAdminPassword(PASSWORD);
  await pool.query(
    `INSERT INTO siton.admin_users (email, display_name, role, status, password_hash, mfa_required, mfa_enabled)
     VALUES ($1,$1,'SuperAdmin','Active',$2,$3,$3)`,
    [email, passwordHash, mfa]
  );
  return email;
}

function login(app: FastifyInstance, email: string, password: string, ip: string) {
  return app.inject({ method: "POST", url: "/api/admin/auth/login", headers: { "content-type": "application/json", "x-forwarded-for": ip }, payload: { email, password } });
}

const { ADMIN_LOGIN_MAX_FAILURES } = await import("../src/admin_identity.js");
const MAX = ADMIN_LOGIN_MAX_FAILURES;

await run("admin password login locks the account after the failure budget, ignoring X-Forwarded-For rotation, without an existence oracle", async () => {
  const { app, pool } = await buildRuntimeApp("admin-login-lock");
  try {
    const email = await seedAdmin(pool, false);
    // MAX-1 wrong passwords from rotating spoofed IPs: refused, not yet locked.
    for (let i = 0; i < MAX - 1; i++) {
      const res = await login(app, email, "wrong-password-" + i, `203.0.113.${i + 1}`);
      assert.equal(res.statusCode, 401, `attempt ${i + 1} body=${res.body}`);
      assert.equal(res.json().error, "admin_invalid_credentials");
    }
    // The MAX-th wrong password trips the lock (still a plain 401 — no oracle).
    const last = await login(app, email, "wrong-password-final", "198.51.100.9");
    assert.equal(last.statusCode, 401, last.body);
    // The CORRECT password is now refused — with the SAME 401 body as a wrong
    // password (no distinct status, no Retry-After: no account-existence oracle).
    const locked = await login(app, email, PASSWORD, "198.51.100.10");
    assert.equal(locked.statusCode, 401, locked.body);
    assert.deepEqual(locked.json(), { ok: false, error: "admin_invalid_credentials" });
    assert.equal(locked.headers["retry-after"], undefined, "a locked account must not announce itself");
    assert.ok(!String(locked.headers["set-cookie"] || "").includes("siton_admin_session="), "no admin session while locked");
    // Indistinguishable from an unknown account probed the same way.
    const unknown = await login(app, `nobody-${Date.now()}@siton.local`, PASSWORD, "198.51.100.10");
    assert.equal(unknown.statusCode, 401);
    assert.deepEqual(unknown.json(), locked.json(), "locked and unknown accounts answer identically");
    const row = await pool.query(`SELECT login_locked_until, failed_login_count FROM siton.admin_users WHERE email=$1`, [email]);
    assert.ok(row.rows[0].login_locked_until, "lock timestamp persisted");
    assert.equal(Number(row.rows[0].failed_login_count), 0, "counter reset when the lock engages");

    // Self-healing: once the lock expires the correct password works again and
    // the counters are clean.
    await pool.query(`UPDATE siton.admin_users SET login_locked_until=now() - interval '1 second' WHERE email=$1`, [email]);
    const healed = await login(app, email, PASSWORD, "198.51.100.11");
    assert.equal(healed.statusCode, 200, healed.body);
    assert.ok(String(healed.headers["set-cookie"] || "").includes("siton_admin_session="), "session issued after the lock expired");
    const clean = await pool.query(`SELECT login_locked_until, failed_login_count FROM siton.admin_users WHERE email=$1`, [email]);
    assert.equal(clean.rows[0].login_locked_until, null);
    assert.equal(Number(clean.rows[0].failed_login_count), 0);
  } finally {
    await pool.end();
  }
});

await run("the lockout also gates the password step of an MFA-required admin", async () => {
  const { app, pool } = await buildRuntimeApp("admin-login-lock-mfa");
  try {
    const email = await seedAdmin(pool, true);
    for (let i = 0; i < MAX; i++) {
      const res = await login(app, email, "nope-" + i, `203.0.113.${100 + (i % 50)}`);
      assert.equal(res.statusCode, 401, res.body);
    }
    const locked = await login(app, email, PASSWORD, "198.51.100.20");
    assert.equal(locked.statusCode, 401, locked.body);
    assert.equal(locked.json().error, "admin_invalid_credentials");
    assert.equal(locked.json().mfa_challenge_id, undefined, "no MFA challenge is issued while locked");
  } finally {
    await pool.end();
  }
});

await run("a successful login resets the failure window and an unknown account never locks", async () => {
  const { app, pool } = await buildRuntimeApp("admin-login-reset");
  try {
    const email = await seedAdmin(pool, false);
    for (let i = 0; i < MAX - 1; i++) assert.equal((await login(app, email, "bad", "203.0.113.200")).statusCode, 401);
    const ok = await login(app, email, PASSWORD, "203.0.113.200");
    assert.equal(ok.statusCode, 200, ok.body);
    const after = await pool.query(`SELECT failed_login_count FROM siton.admin_users WHERE email=$1`, [email]);
    assert.equal(Number(after.rows[0].failed_login_count), 0, "success resets the counter");
    // Unknown account: always the same 401 (no lock row to write, no oracle).
    for (let i = 0; i < MAX + 2; i++) {
      const res = await login(app, `nobody-${Date.now()}-${i}@siton.local`, "bad", "203.0.113.201");
      assert.equal(res.statusCode, 401, res.body);
      assert.equal(res.json().error, "admin_invalid_credentials");
    }
  } finally {
    await pool.end();
  }
});
