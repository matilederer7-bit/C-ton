/**
 * Admin security hardening tests.
 *
 * Verifies that admin endpoints are fail-closed in production-like
 * environments when ADMIN_API_KEY is missing, and that the standard
 * key-required / key-rejected paths still work otherwise.
 */
import { strict as assert } from "node:assert";
import Fastify from "fastify";

// Module load must happen with no ADMIN_API_KEY so the runtime check governs.
delete process.env.ADMIN_API_KEY;
delete process.env.NODE_ENV;
delete process.env.APP_ENV;
delete process.env.RENDER;
delete process.env.RENDER_EXTERNAL_URL;
process.env.APP_DEPLOYMENT_MODE = "demo-preview";

const { registerFrontendExperience } = await import("../src/frontend_runtime.js");

function fakeWithTx() {
  return async <T>(fn: (c: any) => Promise<T>): Promise<T> => {
    // Return harmless aggregates for any admin endpoint that runs queries.
    const fakeClient = {
      query: async (sql: string, params?: any[]) => {
        if (/information_schema\.tables/.test(sql)) {
          const tables = Array.isArray(params?.[0]) ? params[0] : [];
          return { rowCount: tables.length, rows: tables.map((table_name: string) => ({ table_name })) };
        }
        return { rowCount: 0, rows: [] };
      }
    };
    return fn(fakeClient);
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
    withTx: fakeWithTx() as any,
    paymentProvider: fakePaymentProvider() as any,
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

// Endpoints that all share the same requireAdminKey guard.
const ADMIN_ROUTES = [
  "/api/admin/launch-console",
  "/api/admin/notifications-status",
  "/api/admin/system-status"
] as const;

await run("dev/test without ADMIN_API_KEY allows admin access (legacy compatibility)", async () => {
  delete process.env.ADMIN_API_KEY;
  delete process.env.NODE_ENV;
  delete process.env.APP_ENV;
  delete process.env.RENDER;
  delete process.env.RENDER_EXTERNAL_URL;

  const res = await app.inject({ method: "GET", url: "/api/admin/launch-console" });
  // Legacy demo behaviour: no key, no production-like signal → endpoint runs.
  assert.notEqual(res.statusCode, 401);
  assert.notEqual(res.statusCode, 503);
});

await run("production-like (NODE_ENV=production) without ADMIN_API_KEY fails closed with admin_key_not_configured", async () => {
  delete process.env.ADMIN_API_KEY;
  process.env.NODE_ENV = "production";

  for (const url of ADMIN_ROUTES) {
    const res = await app.inject({ method: "GET", url });
    assert.equal(res.statusCode, 503, `${url} should fail closed with 503`);
    const body = res.json() as any;
    assert.equal(body.error, "admin_key_not_configured", `${url} should report admin_key_not_configured`);
    // Must not leak which env var is missing or any expected key value.
    assert.ok(!JSON.stringify(body).toLowerCase().includes("admin_api_key"));
  }

  delete process.env.NODE_ENV;
});

await run("production-like (APP_ENV=production) without ADMIN_API_KEY fails closed", async () => {
  delete process.env.ADMIN_API_KEY;
  process.env.APP_ENV = "production";

  const res = await app.inject({ method: "GET", url: "/api/admin/launch-console" });
  assert.equal(res.statusCode, 503);
  assert.equal((res.json() as any).error, "admin_key_not_configured");

  delete process.env.APP_ENV;
});

await run("production-like (RENDER=true) without ADMIN_API_KEY fails closed", async () => {
  delete process.env.ADMIN_API_KEY;
  process.env.RENDER = "true";

  const res = await app.inject({ method: "GET", url: "/api/admin/launch-console" });
  assert.equal(res.statusCode, 503);
  assert.equal((res.json() as any).error, "admin_key_not_configured");

  delete process.env.RENDER;
});

await run("production-like (RENDER_EXTERNAL_URL set) without ADMIN_API_KEY fails closed", async () => {
  delete process.env.ADMIN_API_KEY;
  process.env.RENDER_EXTERNAL_URL = "https://example.onrender.com";

  const res = await app.inject({ method: "GET", url: "/api/admin/launch-console" });
  assert.equal(res.statusCode, 503);
  assert.equal((res.json() as any).error, "admin_key_not_configured");

  delete process.env.RENDER_EXTERNAL_URL;
});

await run("admin endpoint requires x-admin-key header when ADMIN_API_KEY is configured", async () => {
  process.env.ADMIN_API_KEY = "hardening-test-key";
  delete process.env.NODE_ENV;
  delete process.env.APP_ENV;
  delete process.env.RENDER;
  delete process.env.RENDER_EXTERNAL_URL;

  for (const url of ADMIN_ROUTES) {
    const res = await app.inject({ method: "GET", url });
    assert.equal(res.statusCode, 401, `${url} should reject missing key with 401`);
    const body = res.json() as any;
    assert.equal(body.error, "admin_auth_required", `${url} should report admin_auth_required`);
    assert.ok(!JSON.stringify(body).includes("hardening-test-key"), "response must not leak the key value");
  }
});

await run("admin endpoint rejects wrong x-admin-key with 401 admin_auth_required", async () => {
  process.env.ADMIN_API_KEY = "hardening-test-key";

  const res = await app.inject({
    method: "GET",
    url: "/api/admin/launch-console",
    headers: { "x-admin-key": "wrong-key" }
  });
  assert.equal(res.statusCode, 401);
  const body = res.json() as any;
  assert.equal(body.error, "admin_auth_required");
  assert.ok(!JSON.stringify(body).includes("hardening-test-key"));
});

await run("admin endpoint accepts correct x-admin-key", async () => {
  process.env.ADMIN_API_KEY = "hardening-test-key";

  const res = await app.inject({
    method: "GET",
    url: "/api/admin/launch-console",
    headers: { "x-admin-key": "hardening-test-key" }
  });
  // The fake withTx returns empty aggregates so the endpoint completes successfully.
  assert.equal(res.statusCode, 200, res.body);
});

await run("production-like with valid ADMIN_API_KEY still requires the header", async () => {
  process.env.ADMIN_API_KEY = "hardening-test-key";
  process.env.NODE_ENV = "production";

  const noHeader = await app.inject({ method: "GET", url: "/api/admin/launch-console" });
  assert.equal(noHeader.statusCode, 401);
  assert.equal((noHeader.json() as any).error, "admin_auth_required");

  const withHeader = await app.inject({
    method: "GET",
    url: "/api/admin/launch-console",
    headers: { "x-admin-key": "hardening-test-key" }
  });
  assert.equal(withHeader.statusCode, 200);

  delete process.env.NODE_ENV;
});

await run("all canonical /api/admin readiness routes go through the same guard", async () => {
  // Sanity: with key required + no header, every route in our list returns 401.
  process.env.ADMIN_API_KEY = "hardening-test-key";
  delete process.env.NODE_ENV;

  for (const url of ADMIN_ROUTES) {
    const res = await app.inject({ method: "GET", url });
    assert.equal(res.statusCode, 401, `${url} must require x-admin-key`);
  }
});

await app.close().catch(() => undefined);

console.log("\nadmin security hardening: all checks passed");
