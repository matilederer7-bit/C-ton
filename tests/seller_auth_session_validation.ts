import { strict as assert } from "node:assert";
import Fastify, { type FastifyInstance } from "fastify";
import pg from "pg";
import { hashSellerSessionToken } from "../src/seller_auth.js";

const { Pool } = pg;

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
  for (const key of ["APP_DEPLOYMENT_MODE", "SELLER_SESSION_SECRET", "PAYMENT_WEBHOOK_SECRET", "ADMIN_API_KEY"]) {
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
    deploymentMode: env.APP_DEPLOYMENT_MODE || "internal-runtime",
    isDemoPreview: (env.APP_DEPLOYMENT_MODE || "internal-runtime") === "demo-preview",
    notificationSummary: {
      provider: "log-only",
      mode: "log-only",
      external_delivery: false
    },
    debugSurfacesEnabled: false
  });
  return { app, pool, withTx };
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

function asCookie(value: string | string[] | undefined) {
  return Array.isArray(value) ? String(value[0] || "") : String(value || "");
}

function cookieToken(cookieHeader: string) {
  const match = /siton_seller_session=([^;]+)/.exec(cookieHeader || "");
  return match ? decodeURIComponent(String(match[1] || "")) : "";
}

async function provisionSeller(app: FastifyInstance, pool: any, sellerId: string, loginEmail: string, password: string) {
  const { establishNamedAdminSession } = await import("./helpers/named_admin_session.js");
  const { cookie } = await establishNamedAdminSession(app, pool);
  const response = await app.inject({
    method: "POST",
    url: `/api/admin/seller-auth/${sellerId}/provision`,
    headers: { cookie },
    payload: {
      display_name: sellerId === "seller-alpha" ? "Seller Alpha" : "Seller Beta",
      login_email: loginEmail,
      access_code: password,
      auth_enabled: true
    }
  });
  assert.equal(response.statusCode, 200, response.body);
}

await run("non-demo seller sessions are DB-backed, isolated, revocable, and ignore forged headers", async () => {
  const secret = "seller-session-secret-db";
  const { app, pool, withTx } = await buildRuntimeApp("seller-auth-db", {
    APP_DEPLOYMENT_MODE: "internal-runtime",
    SELLER_SESSION_SECRET: secret
  });

  try {
    await provisionSeller(app, pool, "seller-alpha", "alpha@example.com", "alpha-pass-123");
    await provisionSeller(app, pool, "seller-beta", "beta@example.com", "beta-pass-123");

    const seeded = await withTx(async (c) => {
      const alpha = await c.query(
        `INSERT INTO siton.deals (
           title, price_per_unit, min_units, max_units, threshold_units, deadline, seller_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING deal_id`,
        [`Seller Alpha Deal ${Date.now()}`, 50, 10, 20, 9, new Date(Date.now() + 60 * 60_000).toISOString(), "seller-alpha"]
      );
      const beta = await c.query(
        `INSERT INTO siton.deals (
           title, price_per_unit, min_units, max_units, threshold_units, deadline, seller_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING deal_id`,
        [`Seller Beta Deal ${Date.now()}`, 60, 10, 20, 9, new Date(Date.now() + 60 * 60_000).toISOString(), "seller-beta"]
      );
      return {
        alphaDealId: String(alpha.rows[0].deal_id),
        betaDealId: String(beta.rows[0].deal_id)
      };
    });

    const forgedOnly = await app.inject({
      method: "GET",
      url: "/api/seller/deals",
      headers: { "x-seller-id": "seller-beta" }
    });
    assert.equal(forgedOnly.statusCode, 401);

    const loginFail = await app.inject({
      method: "POST",
      url: "/api/seller/session/login",
      payload: { identifier: "alpha@example.com", access_code: "wrong-pass" }
    });
    assert.equal(loginFail.statusCode, 401);

    const alphaLogin = await app.inject({
      method: "POST",
      url: "/api/seller/session/login",
      payload: { identifier: "alpha@example.com", access_code: "alpha-pass-123" }
    });
    assert.equal(alphaLogin.statusCode, 200);
    const alphaCookie = asCookie(alphaLogin.headers["set-cookie"]);
    assert.ok(alphaCookie.includes("siton_seller_session="));
    const alphaToken = cookieToken(alphaCookie);
    assert.ok(alphaToken);

    const sessionRow = await pool.query(
      `SELECT seller_id, revoked_at IS NULL AS active
       FROM siton.seller_sessions
       WHERE token_hash = $1`,
      [hashSellerSessionToken(alphaToken, secret) || ""]
    );
    assert.equal(sessionRow.rowCount, 1);
    assert.equal(String(sessionRow.rows[0].seller_id), "seller-alpha");
    assert.equal(Boolean(sessionRow.rows[0].active), true);

    const currentSession = await app.inject({
      method: "GET",
      url: "/api/seller/session",
      headers: { cookie: alphaCookie, "x-seller-id": "seller-beta" }
    });
    assert.equal(currentSession.statusCode, 200);
    assert.equal((currentSession.json() as any).seller_auth.seller_context.seller_id, "seller-alpha");

    const workspace = await app.inject({
      method: "GET",
      url: "/api/seller/deals",
      headers: { cookie: alphaCookie, "x-seller-id": "seller-beta" }
    });
    assert.equal(workspace.statusCode, 200);
    const workspacePayload = workspace.json() as any;
    assert.equal(workspacePayload.seller_surface.seller_profile.seller_id, "seller-alpha");
    assert.ok(workspacePayload.seller_surface.deals.some((row: any) => row.deal_id === seeded.alphaDealId));
    assert.ok(!workspacePayload.seller_surface.deals.some((row: any) => row.deal_id === seeded.betaDealId));

    const crossSellerDetail = await app.inject({
      method: "GET",
      url: `/api/seller/deals/${seeded.betaDealId}`,
      headers: { cookie: alphaCookie, "x-seller-id": "seller-beta" }
    });
    assert.equal(crossSellerDetail.statusCode, 404);

    const betaLogin = await app.inject({
      method: "POST",
      url: "/api/seller/session/login",
      payload: { identifier: "beta@example.com", access_code: "beta-pass-123" }
    });
    assert.equal(betaLogin.statusCode, 200);
    const betaCookie = asCookie(betaLogin.headers["set-cookie"]);

    const tabA = await app.inject({ method: "GET", url: "/api/seller/deals", headers: { cookie: alphaCookie } });
    const tabB = await app.inject({ method: "GET", url: "/api/seller/deals", headers: { cookie: betaCookie } });
    assert.equal((tabA.json() as any).seller_surface.seller_profile.seller_id, "seller-alpha");
    assert.equal((tabB.json() as any).seller_surface.seller_profile.seller_id, "seller-beta");

    const logout = await app.inject({
      method: "POST",
      url: "/api/seller/session/logout",
      headers: { cookie: alphaCookie }
    });
    assert.equal(logout.statusCode, 200);

    const afterLogout = await app.inject({
      method: "GET",
      url: "/api/seller/deals",
      headers: { cookie: alphaCookie }
    });
    assert.equal(afterLogout.statusCode, 401);

    const revokedCheck = await pool.query(
      `SELECT revoked_at IS NOT NULL AS revoked
       FROM siton.seller_sessions
       WHERE token_hash = $1`,
      [hashSellerSessionToken(alphaToken, secret) || ""]
    );
    assert.equal(Boolean(revokedCheck.rows[0].revoked), true);

    const secondAlphaLogin = await app.inject({
      method: "POST",
      url: "/api/seller/session/login",
      payload: { identifier: "seller-alpha", access_code: "alpha-pass-123" }
    });
    assert.equal(secondAlphaLogin.statusCode, 200);
    const secondAlphaCookie = asCookie(secondAlphaLogin.headers["set-cookie"]);
    const secondAlphaToken = cookieToken(secondAlphaCookie);

    await pool.query(
      `UPDATE siton.seller_sessions
       SET expires_at = now() - interval '1 minute'
       WHERE token_hash = $1`,
      [hashSellerSessionToken(secondAlphaToken, secret) || ""]
    );

    const expired = await app.inject({
      method: "GET",
      url: "/api/seller/deals",
      headers: { cookie: secondAlphaCookie }
    });
    assert.equal(expired.statusCode, 401);
  } finally {
    await app.close();
    await pool.end();
  }
});

await run("demo-preview keeps explicit seller context switching isolated from non-demo seller auth", async () => {
  const { app, pool } = await buildRuntimeApp("seller-auth-demo", {
    APP_DEPLOYMENT_MODE: "demo-preview",
    SELLER_SESSION_SECRET: ""
  });

  try {
    const contextSave = await app.inject({
      method: "POST",
      url: "/api/seller/context",
      payload: {
        seller_id: "seller-demo",
        display_name: "Seller Demo"
      }
    });
    assert.equal(contextSave.statusCode, 200);
    assert.equal((contextSave.json() as any).seller_context.seller_id, "seller-demo");

    const login = await app.inject({
      method: "POST",
      url: "/api/seller/session/login",
      payload: {
        identifier: "seller-demo",
        access_code: "demo-code"
      }
    });
    assert.equal(login.statusCode, 409);
  } finally {
    await app.close();
    await pool.end();
  }
});

process.exit(0);
