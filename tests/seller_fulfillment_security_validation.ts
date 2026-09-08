// LAUNCH SPRINT 3 — physical fulfillment routes: authorization surface in the
// HOSTED runtime shape (internal-runtime: the x-seller-id header is NOT
// authority, seller identity comes from a session only).
//
//   * anonymous callers get 401/403 on every fulfillment route, for every
//     input shape (valid code, hostile strings, empty), with ONE status per
//     route and no reflected input
//   * a forged x-seller-id header is refused exactly like anonymous
//   * a BUYER tracking token presented as a bearer is refused (a buyer cannot
//     mark themselves fulfilled)
//   * the routes are protected by the shared policy (registry-enumerated), so
//     the CI route-authorization gate covers them automatically
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import nodePath from "node:path";

process.env.NODE_ENV = "test";
process.env.PORT = "3124";
process.env.APP_DEPLOYMENT_MODE = "internal-runtime";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.SELLER_SESSION_SECRET = "seller-session-secret-fulfillment-security";
process.env.ADMIN_API_KEY = "fulfillment-security-admin-key";

const policy = createRequire(import.meta.url)(nodePath.join(process.cwd(), "scripts", "protected_route_policy.cjs"));
const { app } = await import("../src/app.js");
await app.ready();

let passed = 0;
let failed = 0;
async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { failed += 1; console.error(`FAIL ${name}: ${(error as any)?.message || error}`); }
}

const HOSTILE = ["CT-4839-2175", "48392175", "", "%00", "../../etc/passwd", "' OR 1=1 --", "<script>alert(1)</script>", "0".repeat(80), "CT-ABCD-EFGH"];
const ROUTES: Array<{ method: "GET" | "POST"; build: (input: string) => { url: string; payload?: any } }> = [
  { method: "GET", build: (i) => ({ url: `/api/seller/fulfillment/resolve?code=${encodeURIComponent(i)}` }) },
  { method: "GET", build: (i) => ({ url: `/api/seller/fulfillment/search?q=${encodeURIComponent(i)}` }) },
  { method: "POST", build: (i) => ({ url: "/api/seller/fulfillment/handoff", payload: { participant_id: i, order_code: i, expected_qty: 1, source: "scan" } }) },
  { method: "GET", build: (i) => ({ url: `/api/seller/deals/${encodeURIComponent(i || "x")}/fulfillment` }) }
];

await run("the four fulfillment routes are registered inside the protected /api/seller namespace and classified 'protected' by the shared policy", async () => {
  const printed = app.printRoutes({ commonPrefix: false });
  for (const path of ["/api/seller/fulfillment/resolve", "/api/seller/fulfillment/search", "/api/seller/fulfillment/handoff", "/api/seller/deals/:dealId/fulfillment"]) {
    assert.ok(printed.includes(path.replace("/api/seller/", "").split("/").pop()!), `route ${path} printed`);
    assert.equal(policy.classifyRoute(path, {}), "protected", path);
  }
});

await run("anonymous: every route × every input shape → 401/403 only, one status per route, nothing reflected, no PII words", async () => {
  for (const route of ROUTES) {
    const statuses = new Set<number>();
    for (const input of HOSTILE) {
      const built = route.build(input);
      const r = await app.inject({ method: route.method, url: built.url, ...(built.payload ? { payload: built.payload, headers: { "content-type": "application/json" } } : {}) });
      assert.ok([401, 403].includes(r.statusCode), `${route.method} ${built.url.slice(0, 60)} → ${r.statusCode} ${r.body.slice(0, 120)}`);
      statuses.add(r.statusCode);
      if (input.length > 3) assert.ok(!r.body.includes(input), `reflected input on ${built.url.slice(0, 60)}`);
      assert.doesNotMatch(r.body, /buyer_name|buyer_phone|order_code|delivery_address|money_state/);
    }
    assert.equal(statuses.size, 1, `${route.method} ${route.build("x").url}: statuses ${[...statuses].join(",")}`);
  }
});

await run("a forged x-seller-id header is refused exactly like anonymous on every route", async () => {
  for (const route of ROUTES) {
    const built = route.build("CT-4839-2175");
    const anon = await app.inject({ method: route.method, url: built.url, ...(built.payload ? { payload: built.payload, headers: { "content-type": "application/json" } } : {}) });
    const forged = await app.inject({ method: route.method, url: built.url, headers: { "x-seller-id": "seller-alpha", ...(built.payload ? { "content-type": "application/json" } : {}) }, ...(built.payload ? { payload: built.payload } : {}) });
    assert.equal(forged.statusCode, anon.statusCode, `${built.url.slice(0, 60)}: forged ${forged.statusCode} vs anon ${anon.statusCode}`);
    assert.ok([401, 403].includes(forged.statusCode));
  }
});

await run("a buyer tracking token (or any random bearer) presented to the seller handoff is refused — a buyer cannot mark themselves fulfilled", async () => {
  for (const bearer of ["tracking-token-looking-value-0123456789abcdef", "Bearer", "x".repeat(512)]) {
    const r = await app.inject({ method: "POST", url: "/api/seller/fulfillment/handoff", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" }, payload: { participant_id: "00000000-0000-4000-8000-000000000000", expected_qty: 1 } });
    assert.ok([401, 403].includes(r.statusCode), `${r.statusCode} ${r.body.slice(0, 120)}`);
  }
});

await run("the buyer tracking route itself never accepts a seller-style header as buyer authority (tracking token required in the hosted shape)", async () => {
  const r = await app.inject({ method: "GET", url: "/api/participants/00000000-0000-4000-8000-000000000000/tracking", headers: { "x-seller-id": "seller-alpha" } });
  assert.ok([401, 403, 404].includes(r.statusCode), `${r.statusCode} ${r.body.slice(0, 120)}`);
  assert.doesNotMatch(r.body, /order_code|qr_payload/);
});

await app.close();
console.log(`\nFULFILLMENT_SECURITY passed=${passed} failed=${failed}`);
process.exit(failed ? 1 : 0);
