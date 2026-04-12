/**
 * Admin API key auth tests.
 * Uses registerFrontendExperience directly so ADMIN_API_KEY can be set
 * before the module loads.
 */
import { strict as assert } from "node:assert";
import Fastify from "fastify";
import { createHmac } from "node:crypto";

// Must be set before importing frontend_runtime (reads ADMIN_API_KEY at module init)
process.env.ADMIN_API_KEY = "test-admin-key-abc123";
process.env.APP_DEPLOYMENT_MODE = "demo-preview";

const { registerFrontendExperience } = await import("../src/frontend_runtime.js");

function fakeWithTx() {
  return async <T>(_fn: (c: any) => Promise<T>): Promise<T> => {
    throw Object.assign(new Error("db not available in auth tests"), { statusCode: 503 });
  };
}

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

function buildAdminApp() {
  const app = Fastify();
  registerFrontendExperience(app, {
    withTx: fakeWithTx(),
    paymentProvider: fakePaymentProvider(),
    deploymentMode: "demo-preview",
    isDemoPreview: true,
    notificationSummary: { provider: "log-only", mode: "log-only", external_delivery: false },
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

const app = buildAdminApp();

await run("admin endpoint rejects request with no x-admin-key header", async () => {
  const res = await app.inject({ method: "GET", url: "/api/admin/overview" });
  assert.equal(res.statusCode, 401);
  const body = res.json() as any;
  assert.equal(body.error, "admin_auth_required");
  // Response must not leak which key is expected
  assert.ok(!JSON.stringify(body).includes("test-admin-key"), "response must not leak the key value");
});

await run("admin endpoint rejects request with wrong x-admin-key header", async () => {
  const res = await app.inject({
    method: "GET",
    url: "/api/admin/overview",
    headers: { "x-admin-key": "wrong-key" }
  });
  assert.equal(res.statusCode, 401);
  const body = res.json() as any;
  assert.equal(body.error, "admin_auth_required");
});

await run("admin endpoint rejects request with empty x-admin-key header", async () => {
  const res = await app.inject({
    method: "GET",
    url: "/api/admin/overview",
    headers: { "x-admin-key": "" }
  });
  assert.equal(res.statusCode, 401);
});

await run("admin endpoint rejects request with whitespace-only x-admin-key header", async () => {
  const res = await app.inject({
    method: "GET",
    url: "/api/admin/overview",
    headers: { "x-admin-key": "   " }
  });
  assert.equal(res.statusCode, 401);
});

await run("admin endpoint passes auth with correct x-admin-key (backend may error, not 401)", async () => {
  const res = await app.inject({
    method: "GET",
    url: "/api/admin/overview",
    headers: { "x-admin-key": "test-admin-key-abc123" }
  });
  // Auth check passed — DB is unavailable so we expect 503, but NOT 401
  assert.notEqual(res.statusCode, 401, "correct key must not produce 401");
  assert.notEqual(res.statusCode, 403, "correct key must not produce 403");
});

await run("admin system-status also requires key", async () => {
  const blocked = await app.inject({ method: "GET", url: "/api/admin/system-status" });
  assert.equal(blocked.statusCode, 401);

  const passed = await app.inject({
    method: "GET",
    url: "/api/admin/system-status",
    headers: { "x-admin-key": "test-admin-key-abc123" }
  });
  assert.notEqual(passed.statusCode, 401);
});

await app.close();
process.exit(0);
