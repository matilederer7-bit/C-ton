import { strict as assert } from "node:assert";
import Fastify, { type FastifyInstance } from "fastify";
import pg from "pg";

const { Pool } = pg;

// Red-team §9 regression: seller login had NO per-account failed-attempt
// lockout. The only throttle was the generic per-IP HTTP limiter, which keys
// on req.ip — a value the client controls through X-Forwarded-For under
// `trustProxy: true` (the app's own rate_limiter_validation test spoofs exactly
// that) — and the seller login path is not even in the sensitive bucket. So an
// attacker rotating X-Forwarded-For could guess a named seller's access code
// without bound. This test proves the per-account lockout on
// siton.seller_security_events engages regardless of source IP, and that it is
// isolated per account.

function fakePaymentProvider() {
  return {
    providerCode: "mockpay",
    mode: "mock-backed" as const,
    webhookProvider: "mockpay",
    configured: true,
    async authorize() {
      return {
        ok: true as const,
        provider: "mockpay",
        authorization_id: "auth_test",
        provider_reference: "ref_test",
        correlation_id: "corr_test",
        authorization: "authorized" as const,
        hold_message: "test",
        mock: true
      };
    },
    async capture() {
      return { provider: "mockpay", result_class: "success" as const, retryable: false, mock: true };
    },
    async recover() {
      return { provider: "mockpay", result_class: "success" as const, retryable: false, mock: true };
    },
    async refund() {
      return { provider: "mockpay", result_class: "success" as const, retryable: false, mock: true };
    }
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

async function buildRuntimeApp(tag: string, env: Record<string, string>) {
  for (const key of ["APP_DEPLOYMENT_MODE", "SELLER_SESSION_SECRET"]) {
    if (env[key] === undefined) delete process.env[key];
  }
  Object.assign(process.env, env);
  const { ensureRemainingProductSurfaceTables } = await import(`../src/product_surface_support.js?${tag}-${Date.now()}`);
  const { registerFrontendExperience } = await import(`../src/frontend_runtime.js?${tag}-${Date.now()}`);
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton"
  });
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
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

async function provisionSeller(app: FastifyInstance, pool: any, sellerId: string, loginEmail: string, password: string) {
  const { establishNamedAdminSession } = await import("./helpers/named_admin_session.js");
  const { cookie } = await establishNamedAdminSession(app, pool);
  const response = await app.inject({
    method: "POST",
    url: `/api/admin/seller-auth/${sellerId}/provision`,
    headers: { cookie },
    payload: { display_name: sellerId, login_email: loginEmail, access_code: password, auth_enabled: true }
  });
  assert.equal(response.statusCode, 200, response.body);
}

function login(app: FastifyInstance, identifier: string, password: string, spoofedIp: string) {
  return app.inject({
    method: "POST",
    url: "/api/seller/session/login",
    headers: { "content-type": "application/json", "x-forwarded-for": spoofedIp },
    payload: { identifier, access_code: password }
  });
}

const MAX = 3; // SELLER_LOGIN_MAX_FAILURES set below

await run("seller login locks per-account after too many failures and ignores X-Forwarded-For rotation", async () => {
  const { app, pool } = await buildRuntimeApp("seller-login-throttle", {
    APP_DEPLOYMENT_MODE: "internal-runtime",
    SELLER_SESSION_SECRET: "seller-session-secret-throttle-test-0001",
    SELLER_LOGIN_MAX_FAILURES: String(MAX),
    SELLER_LOGIN_FAIL_WINDOW_MINUTES: "15"
  });

  try {
    const suffix = Date.now();
    const alpha = `seller-alpha-${suffix}`;
    const beta = `seller-beta-${suffix}`;
    await provisionSeller(app, pool, alpha, `alpha-${suffix}@example.com`, "alpha-correct-pass-123");
    await provisionSeller(app, pool, beta, `beta-${suffix}@example.com`, "beta-correct-pass-123");

    // MAX wrong-password attempts, each from a DIFFERENT spoofed IP. If the
    // throttle were per-IP (the only pre-fix control), rotating the IP would
    // reset it and every attempt would return 401 forever. It must lock.
    for (let i = 0; i < MAX; i++) {
      const res = await login(app, alpha, "wrong-guess", `203.0.113.${i + 1}`);
      assert.equal(res.statusCode, 401, `attempt ${i + 1} should be 401 invalid, got ${res.statusCode} ${res.body}`);
      assert.equal(res.json().error, "seller_auth_invalid_credentials");
    }

    // Next attempt is locked out — even with the CORRECT password and yet
    // another fresh IP. This response code cannot occur without the fix.
    const lockedCorrect = await login(app, alpha, "alpha-correct-pass-123", "198.51.100.7");
    assert.equal(lockedCorrect.statusCode, 429, `locked account should 429, got ${lockedCorrect.statusCode} ${lockedCorrect.body}`);
    assert.equal(lockedCorrect.json().error, "seller_auth_rate_limited");
    assert.equal(String(lockedCorrect.headers["set-cookie"] || ""), "", "a locked login must not mint a session cookie");

    // Isolation: a different seller is unaffected and still logs in.
    const betaOk = await login(app, beta, "beta-correct-pass-123", "203.0.113.1");
    assert.equal(betaOk.statusCode, 200, `unrelated seller should log in, got ${betaOk.statusCode} ${betaOk.body}`);
    assert.equal(betaOk.json().ok, true);

    // The failures were durably recorded on the append-only rail (not in
    // per-IP memory), which is what makes the lockout survive IP rotation.
    const withTx = createWithTx(pool);
    const recorded = await withTx(async (c) =>
      c.query(
        `SELECT COUNT(*)::int AS n FROM siton.seller_security_events
          WHERE seller_id = $1 AND event_type = 'seller.login.failed'`,
        [alpha]
      )
    );
    assert.ok(Number(recorded.rows[0].n) >= MAX, "each failed attempt should be recorded once");
  } finally {
    await pool.end();
  }
});

console.log("seller_login_bruteforce_throttle_validation: all checks passed");
