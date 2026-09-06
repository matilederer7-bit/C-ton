// PROTECTED ROUTE AUTHORIZATION GATE - the CI invariant.
//
//   UNGUARDED_PROTECTED_ROUTES = 0
//   PROTECTED_PARAMETRIC_ROUTE_AUTH_ORDERING_GAPS = 0
//
// Not thresholds, not tolerances: zero, or the gate fails. The protected set is
// derived from the LIVE Fastify router (scripts/protected_route_policy.cjs):
// route metadata (`config.authority`) first, path namespace as the safety net.
// Nothing here is a hand-kept route list. The only hand-maintained list is the
// anonymous-by-design allowlist, and this file EXECUTES every entry's declared
// expectation - a stale, bogus or merely-guarded entry fails.
//
// The invariant is stronger than "no 2xx": AUTHORIZATION MUST PRECEDE EVERY
// OBSERVATION. An anonymous caller gets an authorization answer (401/403) and
// the SAME answer whatever it puts in an object identifier. The independent
// review found the previous version probed only well-formed UUIDs, so a route
// that validated the id before its guard (400 to an anonymous caller) was
// invisible to it. Every parametric protected route is now probed with:
//
//   valid uuid, a second valid uuid, malformed, empty terminal segment, and a
//   set of hostile strings
//
// and every answer must be an authorization refusal, all of them identical.
// Routing-level not-found (Fastify's own 404 for a shape the router cannot
// match at all) is recorded and ignored - it is not a handler answer.
//
// Runs in internal-runtime: demo-preview auto-creates a seller workspace for any
// caller (that IS the demo product) and would mask the seller surface entirely.
// No money, no external calls, no real provider.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

process.env.NODE_ENV = "test";
process.env.PORT = "3123";
process.env.APP_DEPLOYMENT_MODE = "internal-runtime";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.RATE_LIMIT_MAX = "0";
process.env.RATE_LIMIT_SENSITIVE_MAX = "0";
process.env.RATE_LIMIT_READ_MAX = "0";
process.env.SELLER_SESSION_SECRET = "seller-session-secret-authz-gate";
process.env.ADMIN_API_KEY = "authz-gate-admin-key";
process.env.ADMIN_SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || "admin-session-secret-authz-gate";
// Configured on purpose: an unconfigured distributor secret makes the affiliate
// surface answer 503 everywhere, which would prove nothing about its guard.
process.env.DISTRIBUTOR_SESSION_SECRET = "distributor-session-secret-authz-gate";

const requireCjs = createRequire(import.meta.url);
const policy = requireCjs(path.join(process.cwd(), "scripts", "protected_route_policy.cjs"));

const appModule: any = await import("../src/app.js");
const { app } = appModule;
await app.ready();

let passed = 0;
let failed = 0;
async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { failed += 1; console.error(`FAIL ${name}: ${(error as any)?.message || error}`); }
}

type Route = { path: string; methods: string[]; config: Record<string, unknown> };

/**
 * Rebuild full paths from Fastify's printed route tree. Kept as an independent
 * second source: the registry below is what the gate classifies from, and the
 * printed tree proves the registry did not silently miss a route.
 */
function enumeratePrinted(printed: string): Array<{ path: string; methods: string[] }> {
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

const PARAM = /:[A-Za-z0-9_]+(?:\|:[A-Za-z0-9_]+)*/g;
const shape = (routePath: string) => routePath.replace(PARAM, ":p");

/** Registry-backed enumeration (route metadata included), printRoutes fallback. */
function enumerateRoutes(): { routes: Route[]; source: "registry" | "printed" } {
  const registry: Array<{ method: string; url: string; config: Record<string, unknown> }> | undefined = appModule.ROUTE_REGISTRY;
  if (Array.isArray(registry) && registry.length) {
    const byUrl = new Map<string, Route>();
    for (const entry of registry) {
      const current = byUrl.get(entry.url) || { path: entry.url, methods: [], config: {} };
      if (!current.methods.includes(entry.method)) current.methods.push(entry.method);
      current.config = { ...current.config, ...(entry.config || {}) };
      byUrl.set(entry.url, current);
    }
    return { routes: [...byUrl.values()], source: "registry" };
  }
  return { routes: enumeratePrinted(app.printRoutes({ commonPrefix: false })).map((route) => ({ ...route, config: {} })), source: "printed" };
}

const { routes: allRoutes, source: enumerationSource } = enumerateRoutes();
const classified = allRoutes.map((route) => ({ ...route, klass: policy.classifyRoute(route.path, route.config) as string }));
const protectedRoutes = classified.filter((route) => route.klass === "protected");
const allowlisted = classified.filter((route) => route.klass === "anonymous-by-design");

type Probe = { method: string; path: string; shape: string; url: string; status: number; outcome: string };
const probes: Probe[] = [];

function concreteUrl(routePath: string, id: string, options: { emptyTerminal?: boolean } = {}) {
  if (options.emptyTerminal) {
    // Only the LAST segment is emptied; earlier params get a valid id so the
    // request is the "trailing slash / missing id" shape a client can send.
    const lastParam = routePath.search(/:[A-Za-z0-9_|:]+$/);
    if (lastParam === -1) return null;
    return routePath.slice(0, lastParam).replace(PARAM, () => randomUUID());
  }
  return routePath.replace(PARAM, () => id);
}

function anonymousInjection(method: string, url: string) {
  const headers: Record<string, string> = { "x-request-id": randomUUID() };
  const injection: Record<string, unknown> = { method, url, headers };
  if (method !== "GET") {
    headers["content-type"] = "application/json";
    injection.payload = {};
  }
  return injection;
}

function isFastifyNotFound(response: { statusCode: number; body: string }) {
  return response.statusCode === 404 && /"message":"Route [A-Z]+:[^"]* not found"/.test(response.body || "");
}

function outcomeFor(status: number, response: { statusCode: number; body: string }) {
  if (isFastifyNotFound(response)) return "unroutable";
  if (status >= 200 && status < 300) return "unguarded";
  if (policy.AUTHORIZATION_REFUSAL_CODES.includes(status)) return "refused";
  if (policy.FAIL_CLOSED_CODES.includes(status)) return "fail-closed";
  return "guard_ordering";
}

const HOSTILE_IDS = [
  "%00",
  "..%2F..%2Fetc%2Fpasswd",
  "%27%20OR%20%271%27%3D%271",
  "%3Cscript%3E",
  "0".repeat(80),
  "00000000-0000-0000-0000-00000000000"   // one char short
];

/** Every id shape a caller can put in the path of a parametric route. */
function idShapes(routePath: string): Array<{ shape: string; url: string | null }> {
  return [
    { shape: "uuid", url: concreteUrl(routePath, randomUUID()) },
    { shape: "uuid-2", url: concreteUrl(routePath, randomUUID()) },
    { shape: "malformed", url: concreteUrl(routePath, "not-a-uuid") },
    { shape: "empty-terminal", url: concreteUrl(routePath, "", { emptyTerminal: true }) },
    ...HOSTILE_IDS.map((hostile, index) => ({ shape: `hostile-${index}`, url: concreteUrl(routePath, hostile) }))
  ];
}

async function probeAnonymously(route: Route) {
  const results: Probe[] = [];
  const shapes = route.path.includes(":") ? idShapes(route.path) : [{ shape: "static", url: route.path }];
  for (const method of route.methods) {
    if (method === "HEAD" || method === "OPTIONS") continue;
    for (const item of shapes) {
      if (!item.url) continue;
      const response = await app.inject(anonymousInjection(method, item.url) as any);
      results.push({ method, path: route.path, shape: item.shape, url: item.url, status: response.statusCode, outcome: outcomeFor(response.statusCode, response) });
    }
  }
  return results;
}

await run("the live router exposes the protected surface this gate claims to cover", async () => {
  assert.ok(allRoutes.length >= 150, `router enumeration looks truncated: ${allRoutes.length} routes`);
  for (const namespace of policy.PROTECTED_NAMESPACES) {
    assert.ok(
      classified.some((route) => route.path.startsWith(namespace)),
      `no routes enumerated under the protected namespace ${namespace}`
    );
  }
  // A collapsed enumeration would make every later assertion vacuously true.
  assert.ok(protectedRoutes.length >= 80, `expected the protected surface to be enumerated, found ${protectedRoutes.length}`);
  assert.ok(protectedRoutes.some((route) => route.path.includes(":")), "parametric protected routes must be part of the enumeration");
});

await run("the registry and the printed route tree agree (neither source silently drops a route)", async () => {
  const printed = enumeratePrinted(app.printRoutes({ commonPrefix: false }));
  const printedShapes = new Set(printed.map((route) => shape(route.path)));
  const enumeratedShapes = new Set(allRoutes.map((route) => shape(route.path)));
  const missingFromEnumeration = [...printedShapes].filter((item) => !enumeratedShapes.has(item));
  const missingFromPrinted = [...enumeratedShapes].filter((item) => !printedShapes.has(item));
  assert.deepEqual(missingFromEnumeration, [], `routes in the router but not in the ${enumerationSource} enumeration`);
  assert.deepEqual(missingFromPrinted, [], `routes in the ${enumerationSource} enumeration but not in the router`);
});

await run("the three route classes are disjoint and exhaustive (no silent equivalence)", async () => {
  for (const route of classified) {
    assert.ok(["protected", "anonymous-by-design", "public"].includes(route.klass), `${route.path} fell outside every class: ${route.klass}`);
  }
  const protectedPaths = new Set(protectedRoutes.map((route) => route.path));
  for (const route of allowlisted) {
    assert.ok(!protectedPaths.has(route.path), `${route.path} is in two classes at once`);
    assert.ok(policy.isProtectedNamespace(route.path), `${route.path} is allowlisted but lives outside every protected namespace`);
  }
  const publicCount = classified.filter((route) => route.klass === "public").length;
  assert.equal(classified.length, protectedRoutes.length + allowlisted.length + publicCount, "classes do not partition the router");
});

// The allowlist is pinned HERE as well as in the policy. Growing it means
// editing two files in the same review, on purpose - never one file quietly.
const EXPECTED_ANONYMOUS_BY_DESIGN = [
  "/api/admin/auth/login",
  "/api/admin/auth/logout",
  "/api/admin/auth/mfa/verify",
  "/api/affiliate/links/visit",
  "/api/distributor/session",
  "/api/distributor/session/login",
  "/api/distributor/session/logout",
  "/api/seller/session",
  "/api/seller/session/login",
  "/api/seller/session/logout"
];

await run("the anonymous-by-design allowlist is exactly the reviewed set", async () => {
  const actual = policy.ANONYMOUS_BY_DESIGN.map((entry: any) => entry.path).sort();
  assert.deepEqual(actual, [...EXPECTED_ANONYMOUS_BY_DESIGN].sort(), "the allowlist changed without this gate being updated in the same review");
});

await run("every anonymous-by-design entry is real, reasoned, and BEHAVES as an anonymous entry point", async () => {
  const registered = new Map(allRoutes.map((route) => [route.path, route]));
  const problems: string[] = [];
  for (const entry of policy.ANONYMOUS_BY_DESIGN) {
    const route = registered.get(entry.path);
    if (!route) { problems.push(`${entry.path}: not registered any more`); continue; }
    if (!policy.isProtectedNamespace(entry.path)) problems.push(`${entry.path}: does not need an allowlist entry`);
    if (typeof entry.reason !== "string" || entry.reason.trim().length < 40) problems.push(`${entry.path}: reason too thin`);
    const probe = entry.probe || {};
    const expect = entry.expect || {};
    if (!probe.method || !route.methods.includes(probe.method)) { problems.push(`${entry.path}: probe method ${probe.method} is not registered`); continue; }
    if (!Array.isArray(expect.status) || !expect.status.length || !(expect.marker instanceof RegExp)) { problems.push(`${entry.path}: expectation incomplete`); continue; }
    // The marker must be specific to the anonymous behaviour: it may not match a bare guard refusal.
    for (const refusal of policy.GUARD_REFUSAL_ERRORS) {
      if (expect.marker.test(`{"ok":false,"error":"${refusal}"}`)) problems.push(`${entry.path}: marker ${expect.marker} matches a plain guard refusal (${refusal})`);
    }
    const injection: Record<string, unknown> = { method: probe.method, url: entry.path, headers: { "x-request-id": randomUUID() } };
    if (probe.method !== "GET") { (injection.headers as any)["content-type"] = "application/json"; injection.payload = probe.payload ?? {}; }
    const response = await app.inject(injection as any);
    if (!expect.status.includes(response.statusCode)) problems.push(`${entry.path}: answered ${response.statusCode}, expected ${expect.status.join("/")}`);
    if (!expect.marker.test(response.body || "")) problems.push(`${entry.path}: body does not show the declared anonymous behaviour (${response.body.slice(0, 80)})`);
    if (policy.isBareGuardRefusal(response.body)) problems.push(`${entry.path}: anonymous answer is a bare guard refusal - this is a guarded route, not an anonymous entry point`);
  }
  assert.deepEqual(problems, [], "allowlist integrity");
});

await run("UNGUARDED_PROTECTED_ROUTES = 0 and PROTECTED_PARAMETRIC_ROUTE_AUTH_ORDERING_GAPS = 0", async () => {
  for (const route of protectedRoutes) probes.push(...(await probeAnonymously(route)));

  const unguarded = probes.filter((probe) => probe.outcome === "unguarded");
  const ordering = probes.filter((probe) => probe.outcome === "guard_ordering");

  // Counted and asserted separately on purpose. The first is disclosure; the
  // second is an oracle (existence, format, or validation). Reporting them as
  // one number hides which one you have.
  assert.deepEqual(
    unguarded.map((probe) => `${probe.method} ${probe.path} [${probe.shape}] -> ${probe.status}`),
    [],
    "protected routes served an anonymous caller"
  );
  assert.deepEqual(
    ordering.map((probe) => `${probe.method} ${probe.path} [${probe.shape}] -> ${probe.status}`),
    [],
    "protected routes answered an anonymous caller from behind the guard (existence/format/validation oracle)"
  );
});

await run("no protected route's anonymous answer varies with the object identifier", async () => {
  // Every id shape that routes at all must get the same authorization answer.
  const byRoute = new Map<string, Set<number>>();
  for (const probe of probes) {
    if (probe.outcome === "unroutable") continue;
    const key = `${probe.method} ${probe.path}`;
    if (!byRoute.has(key)) byRoute.set(key, new Set());
    byRoute.get(key)!.add(probe.status);
  }
  const divergent = [...byRoute.entries()].filter(([, statuses]) => statuses.size > 1).map(([key, statuses]) => `${key} -> ${[...statuses].join(" vs ")}`);
  assert.deepEqual(divergent, [], "protected routes answered differently for different object ids");
});

await run("allowlisted routes disclose no principal data to an anonymous caller", async () => {
  const forbidden = /"(seller_id|admin_user_id|distributor_id|login_email|email)"\s*:\s*"[^"]+"/;
  for (const route of allowlisted) {
    for (const probe of await probeAnonymously(route)) {
      if (probe.outcome !== "unguarded") continue;
      const body = (await app.inject(anonymousInjection(probe.method, probe.url) as any)).body || "";
      assert.ok(!forbidden.test(body), `${probe.method} ${route.path} returned principal data to an anonymous caller`);
    }
  }
});

await run("the enumeration is capability-aware: seller lifecycle routes are protected by metadata, not by prefix", async () => {
  assert.equal(enumerationSource, "registry", "src/app.ts must export ROUTE_REGISTRY (onRoute inventory); prefix-only classification cannot see the /deals lifecycle surface");
  for (const lifecycle of ["/deals", "/deals/:id/publish", "/deals/:id/cancel", "/deals/:id/close_joining", "/deals/:id/reopen_joining", "/deals/:id/prepare_charging", "/deals/:id/charging/start"]) {
    const route = classified.find((item) => item.path === lifecycle);
    assert.ok(route, `${lifecycle} is not in the enumeration`);
    assert.equal(route!.klass, "protected", `${lifecycle} is not classified protected`);
    assert.ok(!policy.isProtectedNamespace(lifecycle), `${lifecycle} sits in a namespace - this assertion should be about metadata`);
  }
  const join = classified.find((item) => item.path === "/deals/:id/join");
  assert.ok(join && join.klass === "public", "the buyer join route must stay public");
});

const artifactDir = path.join(process.cwd(), ".ci-artifacts");
mkdirSync(artifactDir, { recursive: true });
const parametricProtected = protectedRoutes.filter((route) => route.path.includes(":"));
const summary = {
  generated_at: new Date().toISOString(),
  deployment_mode: process.env.APP_DEPLOYMENT_MODE,
  enumeration_source: enumerationSource,
  routes_in_router: allRoutes.length,
  protected_routes_enumerated: protectedRoutes.length,
  protected_parametric_routes: parametricProtected.length,
  anonymous_by_design_routes: allowlisted.length,
  public_routes: classified.filter((route) => route.klass === "public").length,
  probes: probes.length,
  unguarded_protected_routes: probes.filter((probe) => probe.outcome === "unguarded").length,
  guard_ordering_violations: probes.filter((probe) => probe.outcome === "guard_ordering").length,
  refused: probes.filter((probe) => probe.outcome === "refused").length,
  fail_closed: probes.filter((probe) => probe.outcome === "fail-closed").length,
  unroutable: probes.filter((probe) => probe.outcome === "unroutable").length,
  per_namespace: Object.fromEntries(
    policy.PROTECTED_NAMESPACES.map((namespace: string) => [namespace, protectedRoutes.filter((route) => route.path.startsWith(namespace)).length])
  ),
  protected_by_metadata_only: protectedRoutes.filter((route) => !policy.isProtectedNamespace(route.path)).map((route) => route.path),
  anonymous_by_design: policy.ANONYMOUS_BY_DESIGN.map((entry: any) => ({ path: entry.path, reason: entry.reason })),
  violations: probes.filter((probe) => probe.outcome === "unguarded" || probe.outcome === "guard_ordering"),
  passed,
  failed
};
writeFileSync(path.join(artifactDir, "route-authorization-gate.json"), JSON.stringify(summary, null, 2));

console.log("ROUTE_AUTHORIZATION_GATE " + JSON.stringify({
  enumeration_source: enumerationSource,
  protected_routes_enumerated: summary.protected_routes_enumerated,
  protected_parametric_routes: summary.protected_parametric_routes,
  probes: summary.probes,
  UNGUARDED_PROTECTED_ROUTES: summary.unguarded_protected_routes,
  PROTECTED_PARAMETRIC_ROUTE_AUTH_ORDERING_GAPS: summary.guard_ordering_violations,
  unroutable_shapes_ignored: summary.unroutable,
  anonymous_by_design: summary.anonymous_by_design_routes,
  per_namespace: summary.per_namespace,
  protected_by_metadata_only: summary.protected_by_metadata_only
}));
console.log(`SUMMARY passed=${passed} failed=${failed} protected_routes=${protectedRoutes.length} probes=${probes.length}`);
if (failed > 0) process.exitCode = 1;
await app.close().catch(() => undefined);
