// LEAN REFACTOR — structural proof for the admin control-center (R6) route
// extraction. The six read-only R6 routes (overview, deals, sellers, seller
// drilldown, audit tail, buyers roster) moved verbatim from
// src/frontend_runtime.ts into src/admin_control_center_routes.ts. This test
// pins the shape of that move so a later edit cannot silently register a route
// twice, drop one, leave a handler behind in the runtime, copy a guard or the
// ledger-aligned fee projection into the module, move the admin read guard
// behind the input it protects, reorder the registrations, or turn a read into
// a write. The checks run against the real sources and then against mutated
// copies, which must each be rejected by the check that guards that property.
// The live behaviour (status codes, response contracts, authorization) stays
// covered by tests/r6_owner_admin_authority_validation.ts,
// tests/admin_buyer_search_intent_validation.ts,
// tests/pilot_readiness_validation.ts,
// tests/seller_self_binding_security_validation.ts and
// tests/seller_distribution_hub_validation.ts.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(process.cwd(), "src");
const read = (file: string) => readFileSync(join(SRC, file), "utf8");
const OTHER_ROUTE_FILES = [
  "app.ts",
  "receipt_content_routes.ts",
  "distribution_hub.ts",
  "admin_mission_control_routes.ts",
  "operational_health_routes.ts",
  "seller_deal_image_routes.ts",
  "support_routes.ts",
  "seller_fulfillment_routes.ts",
  "admin_growth_routes.ts",
  "admin_demo_readiness_routes.ts"
];

// In the original registration order (Fastify registers in call order).
const R6_ROUTES: Array<{ method: "get"; path: string }> = [
  { method: "get", path: "/api/admin/r6/overview" },
  { method: "get", path: "/api/admin/r6/deals" },
  { method: "get", path: "/api/admin/r6/sellers" },
  { method: "get", path: "/api/admin/r6/sellers/:sellerId" },
  { method: "get", path: "/api/admin/r6/audit" },
  { method: "get", path: "/api/admin/r6/buyers" }
];
const GUARD = "    if (!(await requireAdminRead(req, reply))) return;";
// The overview runs its memoized schema check right after the guard and before
// it takes the transaction's connection (Black-Sky C2 ordering).
const OVERVIEW_OPENING = [GUARD, "    await ensureProductSurfaces();", "    return deps.withTx(async (c) => {"];
const INJECTED_DEPS = [
  "withTx: deps.withTx",
  "requireAdminRead",
  "ensureProductSurfaces",
  "projectPlatformFeeTotalForParticipants",
  "PROJECTION_PARTICIPANT_ROWS_SQL"
];
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function indexOrFail(text: string, needle: string, from: number, label: string) {
  const at = text.indexOf(needle, from);
  assert.ok(at >= 0, `${label}: missing ${needle}`);
  return at;
}

function handlersOf(routes: string) {
  return routes.split(/\n  app\.(?=get\(|post\(|patch\(|put\(|delete\()/).slice(1);
}

type Sources = { runtime: string; routes: string; others: Record<string, string> };

const CHECK = {
  REGISTRATION: "each of the six R6 routes is registered exactly once, as a GET, in src/admin_control_center_routes.ts",
  ORDER: "the module registers the six routes in their original order",
  WIRING: "src/frontend_runtime.ts keeps no R6 handler and wires the module exactly once, at the original point",
  NO_COPY: "the module copies no guard, helper or fee projection and never imports the runtime",
  GUARDS: "every handler opens with the admin read guard, before any input is read or any query runs",
  READ_ONLY: "every handler stays a read: one transaction per request, no write SQL, no mutation guard"
} as const;

// Each check throws on a violation. They run on the real sources and on mutants.
const CHECKS: Record<string, (s: Sources) => void> = {
  [CHECK.REGISTRATION]: (s) => {
    const files: Array<[string, string]> = [["frontend_runtime.ts", s.runtime], ["admin_control_center_routes.ts", s.routes], ...Object.entries(s.others)];
    for (const route of R6_ROUTES) {
      const pattern = new RegExp(`\\bapp\\.(get|post|put|patch|delete|options|head|all|route)\\(\\s*["'\`]${escape(route.path)}["'\`]`, "g");
      const registrations = files.flatMap(([file, text]) => [...text.matchAll(pattern)].map((m) => `${file} ${m[1]}`)).sort();
      assert.deepEqual(registrations, [`admin_control_center_routes.ts ${route.method}`], route.path);
    }
    const all = [...s.routes.matchAll(/\bapp\.(get|post|put|patch|delete|options|head|all|route)\(/g)];
    assert.equal(all.length, R6_ROUTES.length, "the module registers nothing beyond the six R6 routes");
    for (const [file, text] of files) {
      if (file === "admin_control_center_routes.ts") continue;
      assert.doesNotMatch(text, /\bapp\.(get|post|put|patch|delete|options|head|all)\(\s*["'`]\/api\/admin\/r6\//, `${file} registers an R6 route`);
    }
  },
  [CHECK.ORDER]: (s) => {
    const registered = [...s.routes.matchAll(/\n  app\.(get|post|put|patch|delete)\("([^"]+)"/g)].map((m) => `${m[1]} ${m[2]}`);
    assert.deepEqual(registered, R6_ROUTES.map((route) => `${route.method} ${route.path}`));
  },
  [CHECK.WIRING]: (s) => {
    assert.doesNotMatch(s.runtime, /app\.(get|post|put|patch|delete)\(\s*["'`]\/api\/admin\/r6\//, "an R6 handler stayed in the runtime");
    assert.match(s.runtime, /^import \{ registerAdminControlCenterRoutes \} from "\.\/admin_control_center_routes\.js";$/m);
    assert.equal((s.runtime.match(/registerAdminControlCenterRoutes\(/g) || []).length, 1, "exactly one wiring call");
    const wiringAt = indexOrFail(s.runtime, "  registerAdminControlCenterRoutes(app, {", 0, "wiring");
    const before = indexOrFail(s.runtime, 'app.post("/api/admin/viral/recompute"', 0, "preceding route");
    // the demo-readiness read that followed the R6 block moved into
    // src/admin_demo_readiness_routes.ts (Lean Refactor); its wiring call is the next registration
    const after = indexOrFail(s.runtime, "  registerAdminDemoReadinessRoutes(app, {", 0, "following route");
    assert.ok(before < wiringAt && wiringAt < after, "wired where the routes were: after the viral recompute route, before demo readiness");
    // nothing else registers between the preceding route's handler and the wiring call
    const gap = s.runtime.slice(before + 1, wiringAt);
    assert.doesNotMatch(gap, /\n  app\.(get|post|put|patch|delete)\(|\n  register\w+Routes\(/, "the wiring call directly follows the preceding route");
    const block = s.runtime.slice(wiringAt, indexOrFail(s.runtime, "\n  });\n", wiringAt, "wiring block end"));
    const injectedKeys = [...block.matchAll(/^\s+([A-Za-z_]+)(?::|,|$)/gm)].map((m) => m[1]);
    assert.deepEqual(injectedKeys.sort(), INJECTED_DEPS.map((dep) => dep.split(":")[0]).sort(), "no extra and no missing dependency");
    for (const dep of INJECTED_DEPS) assert.match(block, new RegExp(`^\\s+${escape(dep)},?$`, "m"), `injected: ${dep}`);
    // the fee projection and its population query stay defined once, in the runtime
    assert.equal((s.runtime.match(/^function projectPlatformFeeTotalForParticipants\(/gm) || []).length, 1, "projection defined in the runtime");
    assert.equal((s.runtime.match(/^const PROJECTION_PARTICIPANT_ROWS_SQL = `/gm) || []).length, 1, "projection query defined in the runtime");
  },
  [CHECK.NO_COPY]: (s) => {
    assert.doesNotMatch(s.routes, /from "\.\/frontend_runtime(\.js)?"/, "no circular import of the runtime");
    assert.doesNotMatch(s.routes, /\bimport\([^)]*frontend_runtime/, "no dynamic import of the runtime");
    assert.doesNotMatch(
      s.routes,
      /function (requireAdminRead|requireAdminMutation|requireAdminAuthContext|requireAdminKey|adminActorRef|requireUuid|isUuid|memoizeSchemaCheck|projectPlatformFeeTotalForParticipants|ensure\w+)\b/,
      "guards and helpers are injected, not re-implemented"
    );
    assert.doesNotMatch(s.routes, /\b(const|let|var)\s+PROJECTION_PARTICIPANT_ROWS_SQL\s*=/, "the projection query is injected, not copied");
    assert.doesNotMatch(s.routes, /calculatePlatformFeeMoney|computeCustomerChargeVat|roundMoney|SITON_PLATFORM_FEE_RATE|from "\.\/(platform_fee_money|vat_authority)(\.js)?"/, "no fee arithmetic of its own");
    assert.doesNotMatch(s.routes, /process\.env|timingSafeEqual|x-admin-key|memoizeSchemaCheck\(/, "no auth, configuration or schema-memo logic of its own");
    assert.match(s.routes, /^export function registerAdminControlCenterRoutes\(app: FastifyInstance, deps: AdminControlCenterRouteDeps\) \{$/m);
    const destructured = s.routes.slice(indexOrFail(s.routes, "const {", s.routes.indexOf("registerAdminControlCenterRoutes("), "destructure"), indexOrFail(s.routes, "} = deps;", 0, "destructure end"));
    for (const name of INJECTED_DEPS.filter((dep) => !dep.includes(":"))) assert.match(destructured, new RegExp(`\\b${name}\\b`), `destructured from deps: ${name}`);
  },
  [CHECK.GUARDS]: (s) => {
    const handlers = handlersOf(s.routes);
    assert.equal(handlers.length, R6_ROUTES.length);
    for (const route of R6_ROUTES) {
      const handler = handlers.find((h) => h.startsWith(`${route.method}("${route.path}", async (req: any, reply: any) => {\n`));
      assert.ok(handler, `${route.method.toUpperCase()} ${route.path} handler located`);
      const lines = handler!.split("\n");
      assert.equal(lines[1], GUARD, `${route.method.toUpperCase()} ${route.path} opens with the admin read guard`);
      if (route.path === "/api/admin/r6/overview") assert.deepEqual(lines.slice(1, 1 + OVERVIEW_OPENING.length), OVERVIEW_OPENING, "overview: guard, schema check, then the transaction");
    }
    assert.equal((s.routes.match(/await requireAdminRead\(req, reply\)/g) || []).length, R6_ROUTES.length, "one admin read guard per route");
  },
  [CHECK.READ_ONLY]: (s) => {
    assert.doesNotMatch(s.routes, /requireAdminMutation|requireAdminAuthContext/, "no mutation guard: the module only reads");
    assert.doesNotMatch(s.routes, /\b(INSERT\s+INTO|UPDATE\s+siton\.|DELETE\s+FROM|TRUNCATE|ALTER\s+TABLE|CREATE\s+TABLE|DROP\s+TABLE)\b/i, "no write or DDL SQL");
    assert.doesNotMatch(s.routes, /enqueue\w*\(|recordOperationalCaseEvent|appendAuditLog|insertAudit/, "no outbox, case or audit write");
    for (const handler of handlersOf(s.routes)) {
      const head = handler.slice(0, handler.indexOf("\n"));
      assert.equal((handler.match(/deps\.withTx\(/g) || []).length, 1, `${head}: one transaction per request`);
    }
  }
};

function failures(s: Sources) {
  const out: string[] = [];
  for (const [name, check] of Object.entries(CHECKS)) {
    try {
      check(s);
    } catch (error: any) {
      out.push(`${name}: ${error?.message || error}`);
    }
  }
  return out;
}

const real: Sources = {
  runtime: read("frontend_runtime.ts"),
  routes: read("admin_control_center_routes.ts"),
  others: Object.fromEntries(OTHER_ROUTE_FILES.map((file) => [file, read(file)]))
};

let failed = 0;
const realFailures = failures(real);
// Mutation controls are meaningful only against a clean baseline.
const baselineClean = realFailures.length === 0;
for (const name of Object.keys(CHECKS)) {
  const hit = realFailures.find((f) => f.startsWith(`${name}:`));
  if (hit) {
    failed += 1;
    console.error(`FAIL ${hit}`);
  } else {
    console.log(`PASS ${name}`);
  }
}

// Mutation controls: each mutant must be rejected by the check that guards that property.
function replaceOnce(text: string, from: string, to: string) {
  assert.equal(text.split(from).length - 1, 1, `mutation anchor must be unique: ${from.slice(0, 80)}`);
  return text.replace(from, to);
}
const handlerSlice = (path: string, nextPath: string | null) => {
  const start = real.routes.indexOf(`  app.get("${path}",`);
  const end = nextPath ? real.routes.indexOf(`  app.get("${nextPath}",`) : real.routes.lastIndexOf("}\n");
  assert.ok(start >= 0 && end > start, `slice ${path}`);
  return real.routes.slice(start, end);
};
const audit = handlerSlice("/api/admin/r6/audit", "/api/admin/r6/buyers");
const deals = handlerSlice("/api/admin/r6/deals", "/api/admin/r6/sellers");
const sellers = handlerSlice("/api/admin/r6/sellers", "/api/admin/r6/sellers/:sellerId");
const open = (path: string) => `  app.get("${path}", async (req: any, reply: any) => {\n`;
const MUTANTS: Array<[string, string, () => Sources]> = [
  ["read guard removed from GET /api/admin/r6/buyers", CHECK.GUARDS, () => ({ ...real, routes: replaceOnce(real.routes, `${open("/api/admin/r6/buyers")}${GUARD}\n`, open("/api/admin/r6/buyers")) })],
  ["guard moved behind the query parsing on GET /api/admin/r6/deals", CHECK.GUARDS, () => ({ ...real, routes: replaceOnce(real.routes, `${open("/api/admin/r6/deals")}${GUARD}\n    const stateFilter = String(req.query?.state || "").trim();\n`, `${open("/api/admin/r6/deals")}    const stateFilter = String(req.query?.state || "").trim();\n${GUARD}\n`) })],
  ["schema check moved inside the overview transaction", CHECK.GUARDS, () => ({ ...real, routes: replaceOnce(real.routes, "    await ensureProductSurfaces();\n    return deps.withTx(async (c) => {\n", "    return deps.withTx(async (c) => {\n    await ensureProductSurfaces();\n") })],
  ["drilldown downgraded to a mutation guard", CHECK.READ_ONLY, () => ({ ...real, routes: replaceOnce(real.routes, `${open("/api/admin/r6/sellers/:sellerId")}${GUARD}\n`, `${open("/api/admin/r6/sellers/:sellerId")}${GUARD}\n    if (!(await requireAdminMutation(req, reply, "sellers.manage"))) return;\n`) })],
  ["audit tail turned into a write", CHECK.READ_ONLY, () => ({ ...real, routes: replaceOnce(real.routes, "      return { ok: true, audit: rows.rows };\n", "      await c.query(`DELETE FROM siton.audit_log WHERE audit_id = $1`, [q]);\n      return { ok: true, audit: rows.rows };\n") })],
  ["deals roster split over two transactions", CHECK.READ_ONLY, () => ({ ...real, routes: replaceOnce(real.routes, "      return { ok: true, deals: rows.rows };\n    });\n", "      return { ok: true, deals: rows.rows };\n    }).then((r: any) => deps.withTx(async () => r));\n") })],
  ["audit route registered a second time in the module", CHECK.REGISTRATION, () => ({ ...real, routes: replaceOnce(real.routes, "\n  });\n}\n", `\n  });\n${audit}}\n`) })],
  ["audit route left behind in the runtime as well", CHECK.REGISTRATION, () => ({ ...real, runtime: replaceOnce(real.runtime, "  registerAdminDemoReadinessRoutes(app, {", `${audit}  registerAdminDemoReadinessRoutes(app, {`) })],
  ["audit route dropped (omission)", CHECK.REGISTRATION, () => ({ ...real, routes: replaceOnce(real.routes, audit, "") })],
  ["sellers list and drilldown registered in swapped order", CHECK.ORDER, () => {
    const drilldown = handlerSlice("/api/admin/r6/sellers/:sellerId", "/api/admin/r6/audit");
    return { ...real, routes: replaceOnce(real.routes, sellers + drilldown, drilldown + sellers) };
  }],
  ["deals roster moved to the end of the module", CHECK.ORDER, () => ({ ...real, routes: replaceOnce(replaceOnce(real.routes, deals, ""), "\n  });\n}\n", `\n  });\n${deals}}\n`) })],
  ["module wired twice", CHECK.WIRING, () => ({ ...real, runtime: replaceOnce(real.runtime, "  registerAdminControlCenterRoutes(app, {", "  registerAdminControlCenterRoutes(app, deps as any);\n  registerAdminControlCenterRoutes(app, {") })],
  ["module wired after demo readiness", CHECK.WIRING, () => {
    const start = real.runtime.indexOf("  registerAdminControlCenterRoutes(app, {");
    const end = real.runtime.indexOf("\n  });\n", start) + "\n  });\n".length;
    const wiring = real.runtime.slice(start, end);
    const moved = replaceOnce(real.runtime, wiring, "");
    return { ...real, runtime: replaceOnce(moved, '  app.get("/app/assets/styles.css"', `${wiring}  app.get("/app/assets/styles.css"`) };
  }],
  ["an extra dependency injected", CHECK.WIRING, () => ({ ...real, runtime: replaceOnce(real.runtime, "    requireAdminRead,\n    ensureProductSurfaces,\n    projectPlatformFeeTotalForParticipants,", "    requireAdminRead,\n    requireAdminMutation,\n    ensureProductSurfaces,\n    projectPlatformFeeTotalForParticipants,") })],
  ["module imports the runtime back", CHECK.NO_COPY, () => ({ ...real, routes: replaceOnce(real.routes, 'import type { FastifyInstance } from "fastify";', 'import type { FastifyInstance } from "fastify";\nimport { registerFrontendExperience } from "./frontend_runtime.js";') })],
  ["module re-implements the admin read guard", CHECK.NO_COPY, () => ({ ...real, routes: replaceOnce(real.routes, "export function registerAdminControlCenterRoutes(", "function requireAdminRead(req: any, reply: any) { return true; }\nexport function registerAdminControlCenterRoutes(") })],
  ["module copies the fee projection with a flat 8%", CHECK.NO_COPY, () => ({ ...real, routes: replaceOnce(real.routes, "export function registerAdminControlCenterRoutes(", "function projectPlatformFeeTotalForParticipants(rows: any[]) { return rows.length * 0.08; }\nexport function registerAdminControlCenterRoutes(") })],
  ["module copies the projection query", CHECK.NO_COPY, () => ({ ...real, routes: replaceOnce(real.routes, "export function registerAdminControlCenterRoutes(", "const PROJECTION_PARTICIPANT_ROWS_SQL = `SELECT 1`;\nexport function registerAdminControlCenterRoutes(") })]
];
for (const [label, expectedCheck, make] of MUTANTS) {
  let mutant: Sources;
  try {
    mutant = make();
  } catch (error: any) {
    failed += 1;
    console.error(`FAIL mutant could not be built (${label}): ${error?.message || error}`);
    continue;
  }
  // the mutant must be rejected by the check that guards that property, not incidentally by another
  const caught = failures(mutant);
  if (baselineClean && caught.some((f) => f.startsWith(`${expectedCheck}:`))) {
    console.log(`PASS mutant rejected: ${label}`);
  } else {
    failed += 1;
    console.error(`FAIL mutant survived its intended check (${expectedCheck}): ${label}${caught.length ? ` [caught only by: ${caught.map((f) => f.split(":")[0]).join("; ")}]` : ""}`);
  }
}

// Live registry: boot the real app and read Fastify's onRoute inventory.
{
  const label = "the live Fastify registry lists each route once, in the original order, between its original neighbours";
  process.env.DISABLE_OUTBOX_WORKER = "1";
  process.env.SELLER_SESSION_SECRET = process.env.SELLER_SESSION_SECRET || "seller-session-secret-control-center-extraction";
  process.env.ADMIN_API_KEY = process.env.ADMIN_API_KEY || "control-center-extraction-admin-key";
  process.env.ADMIN_SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || "admin-session-secret-control-center-extraction";
  const appModule: any = await import("../src/app.js");
  try {
    await appModule.app.ready();
    const registry: Array<{ method: string; url: string }> | undefined = appModule.ROUTE_REGISTRY;
    assert.ok(Array.isArray(registry) && registry.length > 150, "src/app.ts exports the onRoute ROUTE_REGISTRY");
    const entries = registry!.filter((r) => r.method !== "HEAD").map((r) => `${r.method} ${r.url}`);
    const expected = R6_ROUTES.map((r) => `${r.method.toUpperCase()} ${r.path}`);
    for (const entry of expected) assert.equal(entries.filter((e) => e === entry).length, 1, `registered once: ${entry}`);
    const first = entries.indexOf(expected[0]!);
    assert.ok(first > 0, "the first R6 route is registered");
    assert.deepEqual(entries.slice(first, first + expected.length), expected, "contiguous, in the original order");
    assert.equal(entries[first - 1], "POST /api/admin/viral/recompute", "preceded by the viral recompute route");
    assert.equal(entries[first + expected.length], "GET /api/admin/demo-readiness", "followed by the demo readiness route");
    for (const r of R6_ROUTES) {
      assert.equal(registry!.filter((e) => e.method === "HEAD" && e.url === r.path).length, 1, `HEAD twin once: ${r.path}`);
    }
    console.log(`PASS ${label}`);
  } catch (error: any) {
    failed += 1;
    console.error(`FAIL ${label}: ${error?.message || error}`);
  } finally {
    await appModule.app.close().catch(() => undefined);
  }
}

if (failed) {
  console.error(`admin_control_center_routes_extraction_validation failed=${failed}`);
  process.exit(1);
}
console.log("PASS admin_control_center_routes_extraction_validation");
process.exit(0);
