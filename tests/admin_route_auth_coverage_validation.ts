// Admin surface authorization COVERAGE.
//
// `admin_security_hardening_validation.ts` proves the guard's behaviour, but only
// against three hand-listed URLs, and `admin_mutation_route_inventory_validation.ts`
// reads source text. Neither notices a NEW admin route that ships without a guard:
// the route inventory reports dozens of admin routes whose authentication cannot be
// detected statically ("verified separately by real-HTTP authorization tests" — this
// file is that verification).
//
// Invariant proven here for EVERY registered `/api/admin/*` route, enumerated from
// the live Fastify router rather than from a list a human keeps up to date:
//
//   with ADMIN_API_KEY configured, an anonymous caller (no x-admin-key, no admin
//   session cookie) never receives a 2xx response — the guard answers before the
//   handler runs.
//
// The admin login entry point is excluded: it must be reachable anonymously, and it
// is covered by the admin auth suite. No money, no external calls.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

process.env.NODE_ENV = "test";
process.env.PORT = "3121";
process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.SELLER_SESSION_SECRET = "seller-session-secret-admin-coverage";
process.env.ADMIN_API_KEY = "admin-route-coverage-key";
process.env.ADMIN_SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || "admin-session-secret-admin-coverage";

const { app } = await import("../src/app.js");
await app.ready();

let passed = 0;
let failed = 0;
async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { failed += 1; console.error(`FAIL ${name}: ${(error as any)?.message || error}`); }
}

/**
 * Rebuild full paths from Fastify's route tree. `commonPrefix: false` prints one
 * segment per line with the methods in parentheses; children are indented by four
 * characters per level, so the full path is the concatenation of the segments on
 * the branch. Enumerating the router (instead of a hand-written list) is the whole
 * point: a route added tomorrow is covered without editing this file.
 */
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

// Two entry points answer an anonymous caller by design and are covered by the
// admin auth suite instead: the login endpoint (it cannot require the session it
// issues) and logout (idempotent session teardown - clearing a cookie that is not
// there is a success, and the response carries no admin data).
const ANONYMOUS_BY_DESIGN = new Set([
  "/api/admin/auth/login",
  "/api/admin/auth/logout",
  // Second factor of the login flow: the caller holds a challenge id issued by
  // login, never an admin session, so it cannot require one. Unknown or expired
  // challenges answer 401 - it never reveals whether a challenge id exists.
  "/api/admin/auth/mfa/verify"
]);

const adminRoutes = enumerateRoutes(app.printRoutes({ commonPrefix: false }))
  .filter((route) => route.path.startsWith("/api/admin/"))
  .filter((route) => !ANONYMOUS_BY_DESIGN.has(route.path));

function concreteUrl(path: string) {
  // Fastify prints a node that several routes registered under different parameter
  // names as ":dealId|:id"; the whole alternation is ONE path segment and must be
  // replaced by a single value, or the request carries a malformed id and the
  // handler answers 400 before any guard opinion is visible.
  return path.replace(/:[A-Za-z0-9_]+(?:\|:[A-Za-z0-9_]+)*/g, () => randomUUID());
}

await run("the live router exposes an admin surface worth guarding", async () => {
  assert.ok(adminRoutes.length >= 40, `expected the admin surface to be enumerated, found ${adminRoutes.length}`);
  // The inventory gate reports admin routes whose guard cannot be seen statically;
  // this file must cover at least that many.
  assert.ok(
    adminRoutes.some((route) => route.path.includes(":")),
    "parametric admin routes must be part of the enumeration"
  );
});

await run("EVERY registered admin route refuses an anonymous caller (no 2xx without credentials)", async () => {
  const leaks: string[] = [];
  const unexpected: string[] = [];
  for (const route of adminRoutes) {
    for (const method of route.methods) {
      if (method === "HEAD" || method === "OPTIONS") continue;
      const url = concreteUrl(route.path);
      const injection: Record<string, unknown> = { method, url, headers: { "x-request-id": randomUUID() } };
      if (method !== "GET") {
        (injection.headers as Record<string, string>)["content-type"] = "application/json";
        injection.payload = {};
      }
      const response = await app.inject(injection as any);
      if (response.statusCode >= 200 && response.statusCode < 300) {
        leaks.push(`${method} ${route.path} -> ${response.statusCode}`);
      } else if (![401, 403].includes(response.statusCode)) {
        unexpected.push(`${method} ${route.path} -> ${response.statusCode}`);
      }
    }
  }
  assert.deepEqual(leaks, [], `admin routes answered an anonymous caller with 2xx:\n  ${leaks.join("\n  ")}`);
  // A guard that runs before anything else answers 401/403. Anything else (400
  // from body validation, 404 from a param lookup, 500 from a handler) means the
  // request reached logic it should never have reached.
  assert.deepEqual(
    unexpected,
    [],
    `admin routes answered an anonymous caller past the guard:\n  ${unexpected.join("\n  ")}`
  );
});

await run("a wrong admin key is refused exactly like no key at all", async () => {
  const sample = adminRoutes.filter((route) => route.methods.includes("GET")).slice(0, 12);
  assert.ok(sample.length > 0, "expected readable admin routes in the enumeration");
  for (const route of sample) {
    const response = await app.inject({
      method: "GET",
      url: concreteUrl(route.path),
      headers: { "x-admin-key": "not-the-configured-key" }
    });
    assert.ok(
      [401, 403].includes(response.statusCode),
      `${route.path} accepted a wrong admin key with ${response.statusCode}`
    );
    assert.ok(
      !JSON.stringify(response.json()).includes("admin-route-coverage-key"),
      `${route.path} leaked the configured key value`
    );
  }
});

console.log(`SUMMARY passed=${passed} failed=${failed} admin_routes=${adminRoutes.length}`);
if (failed > 0) process.exitCode = 1;
await app.close().catch(() => undefined);
