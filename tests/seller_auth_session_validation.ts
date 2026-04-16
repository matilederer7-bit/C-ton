import { strict as assert } from "node:assert";
import Fastify from "fastify";
import pg from "pg";
import { ensureRemainingProductSurfaceTables } from "../src/product_surface_support.js";

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
  for (const key of ["APP_DEPLOYMENT_MODE", "SELLER_SESSION_SECRET", "SELLER_AUTH_CREDENTIALS", "PAYMENT_WEBHOOK_SECRET"]) {
    if (env[key] === undefined) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, env);
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
    deploymentMode: env.APP_DEPLOYMENT_MODE,
    isDemoPreview: env.APP_DEPLOYMENT_MODE === "demo-preview",
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

await run("non-demo seller workspace requires a server session and ignores forged headers", async () => {
  const { app, pool, withTx } = await buildRuntimeApp("seller-auth-non-demo", {
    APP_DEPLOYMENT_MODE: "internal-runtime",
    SELLER_SESSION_SECRET: "seller-session-secret-test",
    SELLER_AUTH_CREDENTIALS: JSON.stringify([
      { seller_id: "seller-alpha", display_name: "Seller Alpha", access_code: "alpha-code" },
      { seller_id: "seller-beta", display_name: "Seller Beta", access_code: "beta-code" }
    ])
  });

  try {
    const seeded = await withTx(async (c) => {
      const alpha = await c.query(
        `INSERT INTO siton.deals (
           title, price_per_unit, min_units, max_units, threshold_units, deadline, commission_rate, seller_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING deal_id`,
        [
          `Seller Alpha Deal ${Date.now()}`,
          50,
          10,
          20,
          9,
          new Date(Date.now() + 60 * 60_000).toISOString(),
          0.08,
          "seller-alpha"
        ]
      );
      const beta = await c.query(
        `INSERT INTO siton.deals (
           title, price_per_unit, min_units, max_units, threshold_units, deadline, commission_rate, seller_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING deal_id`,
        [
          `Seller Beta Deal ${Date.now()}`,
          60,
          10,
          20,
          9,
          new Date(Date.now() + 60 * 60_000).toISOString(),
          0.08,
          "seller-beta"
        ]
      );
      return {
        alphaDealId: String(alpha.rows[0].deal_id),
        betaDealId: String(beta.rows[0].deal_id)
      };
    });

    const forgedOnly = await app.inject({
      method: "GET",
      url: "/api/seller/deals",
      headers: {
        "x-seller-id": "seller-beta"
      }
    });
    assert.equal(forgedOnly.statusCode, 401);

    const login = await app.inject({
      method: "POST",
      url: "/api/seller/session/login",
      payload: {
        seller_id: "seller-alpha",
        access_code: "alpha-code"
      }
    });
    assert.equal(login.statusCode, 200);
    const sessionCookie = login.headers["set-cookie"];
    assert.ok(sessionCookie);

    const workspace = await app.inject({
      method: "GET",
      url: "/api/seller/deals",
      headers: {
        cookie: Array.isArray(sessionCookie) ? sessionCookie[0] : String(sessionCookie),
        "x-seller-id": "seller-beta"
      }
    });
    assert.equal(workspace.statusCode, 200);
    const workspacePayload = workspace.json() as any;
    assert.equal(workspacePayload.seller_surface.seller_profile.seller_id, "seller-alpha");
    assert.ok(workspacePayload.seller_surface.deals.some((row: any) => row.deal_id === seeded.alphaDealId));
    assert.ok(!workspacePayload.seller_surface.deals.some((row: any) => row.deal_id === seeded.betaDealId));

    const forgedDetail = await app.inject({
      method: "GET",
      url: `/api/seller/deals/${seeded.betaDealId}`,
      headers: {
        cookie: Array.isArray(sessionCookie) ? sessionCookie[0] : String(sessionCookie),
        "x-seller-id": "seller-beta"
      }
    });
    assert.equal(forgedDetail.statusCode, 404);
  } finally {
    await app.close();
    await pool.end();
  }
});

await run("demo-preview keeps explicit seller context switching isolated from server-session login", async () => {
  const { app, pool } = await buildRuntimeApp("seller-auth-demo", {
    APP_DEPLOYMENT_MODE: "demo-preview",
    SELLER_SESSION_SECRET: "",
    SELLER_AUTH_CREDENTIALS: ""
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
    const contextPayload = contextSave.json() as any;
    assert.equal(contextPayload.seller_context.seller_id, "seller-demo");

    const login = await app.inject({
      method: "POST",
      url: "/api/seller/session/login",
      payload: {
        seller_id: "seller-demo",
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
