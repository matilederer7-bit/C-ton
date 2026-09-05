// Seller surface authorization COVERAGE (non-demo runtime).
//
// `seller_auth_authority_validation.ts` proves that the DEAL LIFECYCLE routes derive
// their authority from DB-backed seller sessions, and `seller_enforcement_validation.ts`
// covers seller status. Neither enumerates the seller API surface, so a new seller
// route can ship without a guard and no test notices — and this surface carries buyer
// personal data (delivery exports), fulfillment secrets (voucher and ticket codes) and
// redemption.
//
// Invariant proven here for EVERY registered `/api/seller/*` route, enumerated from the
// live Fastify router: outside demo-preview, an anonymous caller never receives a 2xx.
//
// The deployment mode matters and is deliberate: demo-preview auto-creates a seller
// workspace for anyone (that IS the demo product), so this file runs the runtime in
// `internal-runtime` mode, where a real seller session is required.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

process.env.NODE_ENV = "test";
process.env.PORT = "3122";
process.env.APP_DEPLOYMENT_MODE = "internal-runtime";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.SELLER_SESSION_SECRET = "seller-session-secret-seller-coverage";
process.env.ADMIN_API_KEY = "seller-route-coverage-admin-key";

const { app } = await import("../src/app.js");
await app.ready();

let passed = 0;
let failed = 0;
async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { failed += 1; console.error(`FAIL ${name}: ${(error as any)?.message || error}`); }
}

/** Rebuild full paths from Fastify's route tree (see the admin coverage proof). */
function enumerateRoutes(printed: string): Array<{ path: string; methods: string[] }> {
  const routes: Array<{ path: string; methods: string[] }> = [];
  const branch: string[] = [];
  for (const raw of printed.split("\n")) {
    if (!raw.trim()) continue;
    const cleaned = raw.replace(/[│├└─]/g, " ");
    const depth = Math.floor((cleaned.length - cleaned.trimStart().length) / 4);
    const text = cleaned.trim();
    const withMethods = text.match(/^(.*?)\s*\(([A-Z, ]+)\)\s*$/);
    const segment = withMethods ? withMethods[1]! : text;
    branch[depth] = segment;
    branch.length = depth + 1;
    if (!withMethods) continue;
    const full = branch.join("");
    routes.push({
      path: full.startsWith("/") ? full : `/${full}`,
      methods: withMethods[2]!.split(",").map((value) => value.trim()).filter(Boolean)
    });
  }
  return routes;
}

// The session endpoints answer an anonymous caller by design: login is the entry
// point, logout is idempotent teardown, and GET session is how the browser asks
// "am I signed in?" - it reports the unauthenticated state instead of failing.
const ANONYMOUS_BY_DESIGN = new Set([
  "/api/seller/session",
  "/api/seller/session/login",
  "/api/seller/session/logout"
]);

const sellerRoutes = enumerateRoutes(app.printRoutes({ commonPrefix: false }))
  .filter((route) => route.path.startsWith("/api/seller/"))
  .filter((route) => !ANONYMOUS_BY_DESIGN.has(route.path));

function concreteUrl(path: string) {
  // Fastify prints a node that several routes registered under different parameter
  // names as ":dealId|:id"; the whole alternation is ONE path segment and must be
  // replaced by a single value, or the request carries a malformed id and the
  // handler answers 400 before any guard opinion is visible.
  return path.replace(/:[A-Za-z0-9_]+(?:\|:[A-Za-z0-9_]+)*/g, () => randomUUID());
}

await run("the live router exposes the seller surface", async () => {
  assert.ok(sellerRoutes.length >= 25, `expected the seller surface to be enumerated, found ${sellerRoutes.length}`);
  for (const marker of [/export\.xlsx$/, /voucher-export$/, /fulfillment\/.+\/redeem$/]) {
    assert.ok(
      sellerRoutes.some((route) => marker.test(route.path)),
      `${marker} must be part of the enumerated surface (buyer data / fulfillment secrets)`
    );
  }
});

await run("EVERY seller route refuses an anonymous caller outside demo-preview (no 2xx without a session)", async () => {
  const leaks: string[] = [];
  const pastGuard: string[] = [];
  for (const route of sellerRoutes) {
    for (const method of route.methods) {
      if (method === "HEAD" || method === "OPTIONS") continue;
      const injection: Record<string, unknown> = {
        method,
        url: concreteUrl(route.path),
        headers: { "x-request-id": randomUUID() }
      };
      if (method !== "GET") {
        (injection.headers as Record<string, string>)["content-type"] = "application/json";
        injection.payload = {};
      }
      const response = await app.inject(injection as any);
      if (response.statusCode >= 200 && response.statusCode < 300) {
        leaks.push(`${method} ${route.path} -> ${response.statusCode}`);
      } else if (![401, 403].includes(response.statusCode)) {
        pastGuard.push(`${method} ${route.path} -> ${response.statusCode}`);
      }
    }
  }
  assert.deepEqual(leaks, [], `seller routes answered an anonymous caller with 2xx:\n  ${leaks.join("\n  ")}`);
  assert.deepEqual(
    pastGuard,
    [],
    `seller routes answered an anonymous caller past the guard:\n  ${pastGuard.join("\n  ")}`
  );
});

await run("a forged seller header is not authority", async () => {
  // The seller identity comes from a signed session, never from a header the
  // caller controls: the demo-preview convenience header must not work here.
  const sample = sellerRoutes.filter((route) => route.methods.includes("GET")).slice(0, 10);
  assert.ok(sample.length > 0, "expected readable seller routes in the enumeration");
  for (const route of sample) {
    const response = await app.inject({
      method: "GET",
      url: concreteUrl(route.path),
      headers: { "x-seller-id": "seller-forged", "x-request-id": randomUUID() }
    });
    assert.ok(
      [401, 403].includes(response.statusCode),
      `${route.path} accepted a caller-supplied x-seller-id with ${response.statusCode}`
    );
  }
});

console.log(`SUMMARY passed=${passed} failed=${failed} seller_routes=${sellerRoutes.length}`);
if (failed > 0) process.exitCode = 1;
await app.close().catch(() => undefined);
