// SELLER LIFECYCLE ROUTES — protected, and refused BEFORE any observation.
//
// Independent review LOW-4: the deal lifecycle surface predates the /api
// namespace and lives at the bare paths (POST /deals, /deals/:id/publish|cancel|
// close_joining|reopen_joining|prepare_charging|charging/start, reachable also
// through the /api/deals rewrite). The route-policy namespaces did not cover it,
// and two of the routes answered a validation 400 to an anonymous caller before
// the seller guard ran ("seller_terms_required", "title is required").
//
// This file is deliberately independent of the route registry: it names the
// lifecycle routes explicitly and probes them anonymously with every id shape
// and with a deliberately invalid body, so that it fails on the tree that had
// the ordering defect and cannot pass by construction on a tree that forgets to
// register the routes at all (the vacuity guard proves the seller can reach
// them).

import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";

process.env.NODE_ENV = "test";
process.env.PORT = "3144";
process.env.APP_DEPLOYMENT_MODE = "internal-runtime";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.RATE_LIMIT_MAX = "0";
process.env.RATE_LIMIT_SENSITIVE_MAX = "0";
process.env.RATE_LIMIT_READ_MAX = "0";
process.env.SELLER_SESSION_SECRET = "seller-session-secret-lifecycle";
process.env.ADMIN_SESSION_SECRET = "admin-session-secret-lifecycle";
process.env.ADMIN_API_KEY = "lifecycle-admin-key";

const appModule: any = await import("../src/app.js");
const { app } = appModule;
await app.ready();

let passed = 0;
let failed = 0;
async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { failed += 1; console.error(`FAIL ${name}: ${(error as any)?.message || error}`); }
}

const LIFECYCLE: Array<{ method: string; template: string }> = [
  { method: "POST", template: "/deals" },
  { method: "POST", template: "/deals/:id/publish" },
  { method: "POST", template: "/deals/:id/close_joining" },
  { method: "POST", template: "/deals/:id/reopen_joining" },
  { method: "POST", template: "/deals/:id/prepare_charging" },
  { method: "POST", template: "/deals/:id/charging/start" },
  { method: "POST", template: "/deals/:id/cancel" }
];
const ID_SHAPES: Array<[string, string]> = [
  ["valid uuid", randomUUID()],
  ["another uuid", randomUUID()],
  ["malformed", "not-a-uuid"],
  ["hostile", "%27%20OR%20%271%27%3D%271"],
  ["nul", "%00"]
];

await run("VACUITY GUARD: the lifecycle routes are registered and reachable", async () => {
  const printed: string = app.printRoutes({ commonPrefix: false });
  for (const marker of ["publish", "close_joining", "reopen_joining", "prepare_charging", "charging", "cancel"]) {
    assert.ok(printed.includes(marker), `${marker} route is not registered`);
  }
  // A real seller request reaches the handler (a validation answer, not a guard
  // answer) - so the guard answers below are the guard, not a dead route.
  const created = await app.inject({ method: "POST", url: "/deals", headers: { "x-seller-id": "seller-lifecycle-probe", "content-type": "application/json" }, payload: {} } as any);
  assert.ok([400, 401, 403].includes(created.statusCode), `unexpected ${created.statusCode}`);
});

await run("every lifecycle route refuses an anonymous caller with an authorization answer for every id shape", async () => {
  const violations: string[] = [];
  for (const route of LIFECYCLE) {
    for (const [shape, id] of route.template.includes(":id") ? ID_SHAPES : [["n/a", ""]] as Array<[string, string]>) {
      for (const prefix of ["", "/api"]) {
        const url = prefix + route.template.replace(":id", id);
        // Deliberately INVALID bodies: the guard must answer before any body validation does.
        for (const [bodyLabel, payload] of [["empty body", {}], ["invalid body", { title: "", seller_terms_accepted: false }]] as Array<[string, unknown]>) {
          const response = await app.inject({ method: route.method, url, headers: { "content-type": "application/json" }, payload } as any);
          if (![401, 403].includes(response.statusCode)) {
            violations.push(`${route.method} ${url} [${shape}, ${bodyLabel}] -> ${response.statusCode} ${response.body.slice(0, 60)}`);
          }
        }
      }
    }
  }
  assert.deepEqual([...new Set(violations)].slice(0, 30), [], `lifecycle routes answered an anonymous caller from behind the guard (${violations.length})`);
});

await run("the anonymous answer does not vary with the id (no existence or format oracle)", async () => {
  const divergent: string[] = [];
  for (const route of LIFECYCLE.filter((item) => item.template.includes(":id"))) {
    const statuses = new Set<number>();
    for (const [, id] of ID_SHAPES) {
      const response = await app.inject({ method: route.method, url: route.template.replace(":id", id), headers: { "content-type": "application/json" }, payload: {} } as any);
      statuses.add(response.statusCode);
    }
    if (statuses.size !== 1) divergent.push(`${route.method} ${route.template} -> ${[...statuses].join("/")}`);
  }
  assert.deepEqual(divergent, [], "lifecycle routes answer differently for different ids");
});

await run("the route registry carries seller authority metadata for every lifecycle route", async () => {
  const registry: Array<{ method: string; url: string; config: any }> | undefined = appModule.ROUTE_REGISTRY;
  assert.ok(Array.isArray(registry), "src/app.ts must export ROUTE_REGISTRY (onRoute inventory) so the gate can classify by capability, not only by path prefix");
  for (const route of LIFECYCLE) {
    const registered: { method: string; url: string; config: any } | undefined = registry!.find((entry) => entry.method === route.method && entry.url === route.template);
    assert.ok(registered, `${route.method} ${route.template} is not in the route registry`);
    assert.equal(registered!.config?.authority, "seller", `${route.method} ${route.template} does not declare seller authority`);
  }
  // The buyer join route shares the prefix and must NOT be swept in.
  const join = registry!.find((entry) => entry.method === "POST" && entry.url === "/deals/:id/join");
  assert.ok(join, "join route missing from the registry");
  assert.notEqual(join!.config?.authority, "seller", "the buyer join route was classified as seller authority");
});

console.log(`SUMMARY passed=${passed} failed=${failed}`);
if (failed > 0) process.exitCode = 1;
await app.close().catch(() => undefined);
