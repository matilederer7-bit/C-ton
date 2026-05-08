import { strict as assert } from "node:assert";
import Fastify from "fastify";
import pg from "pg";
import { registerFrontendExperience } from "../src/frontend_runtime.js";
import { ensureOtpRailTables } from "../src/otp_rail.js";

const { Pool } = pg;
const DB_URL = process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton";
const pool = new Pool({ connectionString: DB_URL, max: 5 });

async function realWithTx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
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

await ensureOtpRailTables(realWithTx);

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

function buildOtpApp(isDemoPreview: boolean) {
  const app = Fastify();
  registerFrontendExperience(app, {
    withTx: realWithTx,
    paymentProvider: fakePaymentProvider(),
    deploymentMode: isDemoPreview ? "demo-preview" : "internal-runtime",
    isDemoPreview,
    notificationSummary: {
      provider: "log-only",
      mode: "log-only",
      external_delivery: false
    },
    debugSurfacesEnabled: false
  });
  return app;
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

await run("demo-preview OTP returns a per-session development code", async () => {
  const app = buildOtpApp(true);
  // Different phones avoid the OTP rail's idempotent-window challenge reuse so each
  // call exercises a fresh challenge.
  const phoneA = `05012${String(Date.now()).slice(-5)}`;
  const phoneB = `05078${String(Date.now() + 1).slice(-5)}`;
  try {
    const first = await app.inject({
      method: "POST",
      url: "/api/otp/start",
      payload: { phone: phoneA }
    });
    assert.equal(first.statusCode, 200, first.body);
    const firstJson = first.json() as any;
    assert.match(String(firstJson.development_code || ""), /^\d{6}$/);

    const second = await app.inject({
      method: "POST",
      url: "/api/otp/start",
      payload: { phone: phoneB }
    });
    assert.equal(second.statusCode, 200, second.body);
    const secondJson = second.json() as any;
    assert.match(String(secondJson.development_code || ""), /^\d{6}$/);

    const verify = await app.inject({
      method: "POST",
      url: "/api/otp/verify",
      payload: {
        otp_session_id: firstJson.otp_session_id,
        code: firstJson.development_code
      }
    });
    assert.equal(verify.statusCode, 200, verify.body);
  } finally {
    await app.close();
  }
});

await run("production-like OTP does not leak a development code and rejects guessed codes", async () => {
  // dev_code suppression is gated on isProductionLikeEnv(), not on isDemoPreview.
  const prevNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  const app = buildOtpApp(false);
  const phone = `05076${String(Date.now()).slice(-5)}`;
  try {
    const start = await app.inject({
      method: "POST",
      url: "/api/otp/start",
      payload: { phone }
    });
    assert.equal(start.statusCode, 200, start.body);
    const startJson = start.json() as any;
    assert.ok(startJson.development_code === undefined || startJson.development_code === null,
      `production-like must not return development_code; got ${JSON.stringify(startJson.development_code)}`);

    const guessed = await app.inject({
      method: "POST",
      url: "/api/otp/verify",
      payload: {
        otp_session_id: startJson.otp_session_id,
        code: "123456"
      }
    });
    assert.equal(guessed.statusCode, 400);
  } finally {
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prevNodeEnv;
    await app.close();
  }
});

await pool.end();
process.exit(0);
