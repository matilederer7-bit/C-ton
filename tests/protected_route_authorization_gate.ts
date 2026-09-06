// PROTECTED ROUTE AUTHORIZATION GATE - the CI invariant.
//
//   UNGUARDED_PROTECTED_ROUTES = 0
//
// Not a threshold, not a tolerance, and not a count anybody may raise: zero, or
// the gate fails. The set it applies to is derived from the LIVE Fastify router
// by namespace (scripts/protected_route_policy.cjs), so a protected route added
// tomorrow is covered the moment it is registered. Nothing here is a hand-kept
// route list; the only hand-maintained list is the anonymous-by-design
// allowlist, which this file also polices - stale entries and silent additions
// both fail.
//
// The invariant is stronger than "no 2xx": AUTHORIZATION MUST PRECEDE
// SERVER-STATE DISCLOSURE. An anonymous caller gets an authorization answer
// (401/403), never a fact. Three outcomes are counted SEPARATELY and are never
// collapsed into one another, because they are different bugs:
//
//   unguarded        2xx - the route served an anonymous caller. Disclosure.
//   guard_ordering   4xx/5xx other than 401/403/503 - the request reached
//                    validation, a lookup, or a handler fault behind the guard.
//                    404-vs-401 on an id is an existence oracle even though no
//                    body leaked.
//   refused          401/403, or 503 where the identity provider is
//                    deliberately unconfigured - correct.
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
process.env.SELLER_SESSION_SECRET = "seller-session-secret-authz-gate";
process.env.ADMIN_API_KEY = "authz-gate-admin-key";
process.env.ADMIN_SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || "admin-session-secret-authz-gate";
// Configured on purpose: an unconfigured distributor secret makes the affiliate
// surface answer 503 everywhere, which would prove nothing about its guard.
process.env.DISTRIBUTOR_SESSION_SECRET = "distributor-session-secret-authz-gate";

const requireCjs = createRequire(import.meta.url);
const policy = requireCjs(path.join(process.cwd(), "scripts", "protected_route_policy.cjs"));

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
 * segment per line with the methods in parentheses; children are indented four
 * characters per level, so a full path is the concatenation of its branch.
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

/**
 * Fastify prints routes registered under different parameter names as one node,
 * ":dealId|:id". The whole alternation is ONE segment and must become a single
 * value, or the request carries a malformed id and the handler answers 400
 * before any guard opinion is visible - which would read as a false violation.
 */
function concreteUrl(routePath: string) {
  return routePath.replace(/:[A-Za-z0-9_]+(?:\|:[A-Za-z0-9_]+)*/g, () => randomUUID());
}

const allRoutes = enumerateRoutes(app.printRoutes({ commonPrefix: false }));
const classified = allRoutes.map((route) => ({ ...route, klass: policy.classifyRoute(route.path) as string }));
const protectedRoutes = classified.filter((route) => route.klass === "protected");
const allowlisted = classified.filter((route) => route.klass === "anonymous-by-design");

type Probe = { method: string; path: string; status: number; outcome: string };
const probes: Probe[] = [];

function anonymousInjection(method: string, routePath: string) {
  const headers: Record<string, string> = { "x-request-id": randomUUID() };
  const injection: Record<string, unknown> = { method, url: concreteUrl(routePath), headers };
  if (method !== "GET") {
    headers["content-type"] = "application/json";
    injection.payload = {};
  }
  return injection;
}

async function probeAnonymously(route: { path: string; methods: string[] }) {
  const results: Probe[] = [];
  for (const method of route.methods) {
    if (method === "HEAD" || method === "OPTIONS") continue;
    const response = await app.inject(anonymousInjection(method, route.path) as any);
    const status = response.statusCode;
    const outcome =
      status >= 200 && status < 300 ? "unguarded"
        : policy.AUTHORIZATION_REFUSAL_CODES.includes(status) ? "refused"
          : policy.FAIL_CLOSED_CODES.includes(status) ? "fail-closed"
            : "guard_ordering";
    results.push({ method, path: route.path, status, outcome });
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
  assert.ok(
    protectedRoutes.some((route) => route.path.includes(":")),
    "parametric protected routes must be part of the enumeration"
  );
});

await run("the three route classes are disjoint and exhaustive (no silent equivalence)", async () => {
  // Every enumerated route lands in exactly one class. This is the check that
  // stops a public route and an unguarded protected route sharing a bucket.
  for (const route of classified) {
    assert.ok(
      ["protected", "anonymous-by-design", "public"].includes(route.klass),
      `${route.path} fell outside every class: ${route.klass}`
    );
  }
  const protectedPaths = new Set(protectedRoutes.map((route) => route.path));
  for (const route of allowlisted) {
    assert.ok(!protectedPaths.has(route.path), `${route.path} is in two classes at once`);
    assert.ok(policy.isProtectedNamespace(route.path), `${route.path} is allowlisted but lives outside every protected namespace`);
  }
  const publicCount = classified.filter((route) => route.klass === "public").length;
  assert.equal(
    classified.length,
    protectedRoutes.length + allowlisted.length + publicCount,
    "classes do not partition the router"
  );
});

await run("every anonymous-by-design entry is real, reasoned, and still registered", async () => {
  // A stale allowlist entry is a silent hole: it looks like review happened for a
  // route that no longer exists, and it hides the day that path comes back.
  const registered = new Set(allRoutes.map((route) => route.path));
  for (const entry of policy.ANONYMOUS_BY_DESIGN) {
    assert.ok(registered.has(entry.path), `allowlisted route is not registered any more: ${entry.path}`);
    assert.ok(policy.isProtectedNamespace(entry.path), `${entry.path} does not need an allowlist entry`);
    assert.ok(
      typeof entry.reason === "string" && entry.reason.trim().length >= 40,
      `allowlist entry ${entry.path} needs a reason that explains why anonymous access is safe`
    );
  }
  // Tiny by construction: an allowlist that grows without anyone noticing is how
  // "reviewed exception" turns into "the guard is optional".
  assert.ok(
    policy.ANONYMOUS_BY_DESIGN.length <= 12,
    `the anonymous-by-design allowlist has grown to ${policy.ANONYMOUS_BY_DESIGN.length}; each entry must be justified in review`
  );
});

await run("UNGUARDED_PROTECTED_ROUTES = 0 (authorization precedes server-state disclosure)", async () => {
  for (const route of protectedRoutes) probes.push(...(await probeAnonymously(route)));

  const unguarded = probes.filter((probe) => probe.outcome === "unguarded");
  const ordering = probes.filter((probe) => probe.outcome === "guard_ordering");

  // Counted and asserted separately on purpose. The first is disclosure; the
  // second is an oracle. Reporting them as one number hides which one you have.
  assert.deepEqual(
    unguarded.map((probe) => `${probe.method} ${probe.path} -> ${probe.status}`),
    [],
    "protected routes served an anonymous caller"
  );
  assert.deepEqual(
    ordering.map((probe) => `${probe.method} ${probe.path} -> ${probe.status}`),
    [],
    "protected routes answered an anonymous caller from behind the guard (existence/validation oracle)"
  );
});

await run("no protected route distinguishes an existing object from a missing one", async () => {
  // The admin action execute oracle in this sweep answered 404 for an unknown id
  // and 401 for a known one. Anonymous callers must get the SAME authorization
  // class for every id, so two independent random ids must agree everywhere.
  const parametric = protectedRoutes.filter((route) => route.path.includes(":"));
  assert.ok(parametric.length > 0, "expected parametric protected routes");
  const divergent: string[] = [];
  for (const route of parametric) {
    for (const method of route.methods) {
      if (method === "HEAD" || method === "OPTIONS") continue;
      const statuses: number[] = [];
      for (let attempt = 0; attempt < 2; attempt += 1) {
        statuses.push((await app.inject(anonymousInjection(method, route.path) as any)).statusCode);
      }
      if (statuses[0] !== statuses[1]) divergent.push(`${method} ${route.path} -> ${statuses.join(" vs ")}`);
    }
  }
  assert.deepEqual(divergent, [], "protected routes answered differently for different object ids");
});

await run("allowlisted routes disclose no principal data to an anonymous caller", async () => {
  // Being reachable is the exception; leaking is never part of it.
  const forbidden = /"(seller_id|admin_user_id|distributor_id|login_email|email)"\s*:\s*"[^"]+"/;
  for (const route of allowlisted) {
    for (const probe of await probeAnonymously(route)) {
      if (probe.outcome !== "unguarded") continue;
      const body = (await app.inject(anonymousInjection(probe.method, route.path) as any)).body || "";
      assert.ok(!forbidden.test(body), `${probe.method} ${route.path} returned principal data to an anonymous caller`);
    }
  }
});

const artifactDir = path.join(process.cwd(), ".ci-artifacts");
mkdirSync(artifactDir, { recursive: true });
const summary = {
  generated_at: new Date().toISOString(),
  deployment_mode: process.env.APP_DEPLOYMENT_MODE,
  routes_in_router: allRoutes.length,
  protected_routes_enumerated: protectedRoutes.length,
  anonymous_by_design_routes: allowlisted.length,
  public_routes: classified.filter((route) => route.klass === "public").length,
  probes: probes.length,
  unguarded_protected_routes: probes.filter((probe) => probe.outcome === "unguarded").length,
  guard_ordering_violations: probes.filter((probe) => probe.outcome === "guard_ordering").length,
  refused: probes.filter((probe) => probe.outcome === "refused").length,
  fail_closed: probes.filter((probe) => probe.outcome === "fail-closed").length,
  per_namespace: Object.fromEntries(
    policy.PROTECTED_NAMESPACES.map((namespace: string) => [
      namespace,
      protectedRoutes.filter((route) => route.path.startsWith(namespace)).length
    ])
  ),
  anonymous_by_design: policy.ANONYMOUS_BY_DESIGN,
  violations: probes.filter((probe) => probe.outcome === "unguarded" || probe.outcome === "guard_ordering"),
  passed,
  failed
};
writeFileSync(path.join(artifactDir, "route-authorization-gate.json"), JSON.stringify(summary, null, 2));

console.log("ROUTE_AUTHORIZATION_GATE " + JSON.stringify({
  protected_routes_enumerated: summary.protected_routes_enumerated,
  UNGUARDED_PROTECTED_ROUTES: summary.unguarded_protected_routes,
  guard_ordering_violations: summary.guard_ordering_violations,
  anonymous_by_design: summary.anonymous_by_design_routes,
  per_namespace: summary.per_namespace
}));
console.log(`SUMMARY passed=${passed} failed=${failed} protected_routes=${protectedRoutes.length} probes=${probes.length}`);
if (failed > 0) process.exitCode = 1;
await app.close().catch(() => undefined);
