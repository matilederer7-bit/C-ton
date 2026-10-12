// LEAN REFACTOR — structural proof for the admin growth route extraction. The
// six read-only admin pilot / growth / viral routes (pilot metrics, the
// windowed growth dashboard, per-deal viral metrics, viral-tree level and
// propagation sources — registerAdminGrowthRoutes — and the per-seller viral
// metrics — registerAdminSellerViralRoutes, wired at its own original point)
// moved verbatim from src/frontend_runtime.ts into src/admin_growth_routes.ts. This test pins the shape of that move so a later
// edit cannot silently register a route twice, drop one, leave a handler behind
// in the runtime, copy a guard or the shared viral-tree engine into the module,
// move the admin read guard behind the input it protects, move a schema check
// inside the transaction, reorder the registrations, or turn a read into a
// write. The checks run against the real sources and then against mutated
// copies, which must each be rejected by the check that guards that property.
// The live behaviour (status codes, response contracts, authorization) stays
// covered by tests/pilot_readiness_validation.ts,
// tests/buyer_feedback_support_operations_validation.ts,
// tests/admin_growth_window_validation.ts,
// tests/p05_admin_viral_support_validation.ts,
// tests/admin_viral_metrics_read_validation.ts,
// tests/seller_self_binding_security_validation.ts and
// tests/protected_route_authorization_gate.ts.
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
  "admin_control_center_routes.ts",
  "admin_demo_readiness_routes.ts",
  "admin_ops_overview_routes.ts",
  "admin_operational_status_routes.ts"
];

// In the original registration order (Fastify registers in call order).
const GROWTH_ROUTES: Array<{ method: "get"; path: string }> = [
  { method: "get", path: "/api/admin/pilot-metrics" },
  { method: "get", path: "/api/admin/growth" },
  { method: "get", path: "/api/admin/deals/:dealId/viral" },
  { method: "get", path: "/api/admin/deals/:dealId/viral-tree" },
  { method: "get", path: "/api/admin/deals/:dealId/propagation" }
];
// Registered by the second register function, wired at its own original point.
const SELLER_VIRAL_ROUTES: Array<{ method: "get"; path: string }> = [
  { method: "get", path: "/api/admin/sellers/:sellerId/viral" }
];
const ALL_ROUTES = [...GROWTH_ROUTES, ...SELLER_VIRAL_ROUTES];
const GUARD = "    if (!(await requireAdminRead(req, reply))) return;";
// Per-route opening, verbatim: the guard first, then input parsing/validation,
// then (pilot metrics) both memoized schema checks BEFORE the transaction takes
// its connection (Black-Sky C2), then exactly one transaction.
const OPENING: Record<string, string[]> = {
  "/api/admin/pilot-metrics": [
    GUARD,
    "    const daysRaw = Number(req.query?.days);",
    "    const days = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.min(365, Math.floor(daysRaw)) : 30;",
    "    const since = `now() - ($1::int * interval '1 day')`;",
    "    await ensureProductSurfaces();  // Black-Sky C2: schema check BEFORE taking the transaction's connection",
    "    await ensureInquiryTables();",
    "    return deps.withTx(async (c) => {"
  ],
  "/api/admin/growth": [
    GUARD,
    "    const resolved = resolveGrowthWindow(req.query || {});",
    "    if (!resolved.ok) return reply.code(400).send({ ok: false, error: resolved.error, message: resolved.message_he });",
    "    const window = resolved.window;",
    "    return deps.withTx(async (c) => {"
  ],
  "/api/admin/deals/:dealId/viral": [
    GUARD,
    '    const dealId = String(req.params.dealId || "");',
    '    requireUuid(dealId, "deal_id");',
    "    return deps.withTx(async (c) => {"
  ],
  "/api/admin/deals/:dealId/viral-tree": [
    GUARD,
    '    const dealId = String(req.params.dealId || "");',
    '    requireUuid(dealId, "deal_id");',
    "    const { parentId, sourceKey, limit } = viralTreeQueryParams(req);",
    "    return deps.withTx(async (c) => queryViralTreeLevel(c, dealId, parentId, limit, sourceKey));"
  ],
  "/api/admin/deals/:dealId/propagation": [
    GUARD,
    '    const dealId = String(req.params.dealId || "");',
    '    requireUuid(dealId, "deal_id");',
    "    return deps.withTx(async (c) => {",
    "      const result = await queryPropagationSources(c, dealId);"
  ],
  "/api/admin/sellers/:sellerId/viral": [
    GUARD,
    '    const sellerId = String(req.params.sellerId || "").slice(0, 120);',
    "    return deps.withTx(async (c) => {",
    '      const cached = await readViralMetricsCache(c, "seller", sellerId);'
  ]
};
const INJECTED_DEPS = [
  "withTx: deps.withTx",
  "requireAdminRead",
  "requireUuid",
  "ensureProductSurfaces",
  "ensureInquiryTables",
  "queryViralTreeLevel",
  "queryPropagationSources",
  "viralTreeQueryParams"
];
// The shared viral-tree engine stays defined once in the runtime: the seller
// explorer routes use the same functions.
const SHARED_ENGINE = ["queryViralTreeLevel", "queryPropagationSources", "viralTreeQueryParams"];
const PRECEDING_ROUTE = 'app.get("/api/seller/deals/:dealId/viral"';
const FOLLOWING_ROUTE = 'app.get("/api/seller/inquiries"';
const SELLER_VIRAL_INJECTED_DEPS = ["withTx: deps.withTx", "requireAdminRead"];
const SELLER_VIRAL_PRECEDING_ROUTE = 'app.get("/api/seller/deals/:dealId/viral-tree"';
const SELLER_VIRAL_FOLLOWING_ROUTE = 'app.post("/api/admin/viral/recompute"';
const FIRST_REGISTER = "export function registerAdminGrowthRoutes(";
const SECOND_REGISTER = "export function registerAdminSellerViralRoutes(";
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Never a vacuous position: a missing anchor throws instead of yielding -1.
function indexOrFail(text: string, needle: string, from: number, label: string) {
  const at = text.indexOf(needle, from);
  assert.ok(at >= 0, `${label}: missing ${needle}`);
  return at;
}

// The text of one register function: from its declaration to the next top-level close.
function functionBody(routes: string, declaration: string) {
  const start = indexOrFail(routes, declaration, 0, declaration);
  return routes.slice(start, indexOrFail(routes, "\n}\n", start, `${declaration} end`) + 3);
}

// One wiring call: located once, between its two neighbours, injecting exactly its dependencies.
function assertWiring(runtime: string, call: string, preceding: string, following: string, injected: string[]) {
  const wiringAt = indexOrFail(runtime, `\n  ${call}(app, {`, 0, `${call} wiring`);
  const before = indexOrFail(runtime, preceding, 0, "preceding route");
  const after = indexOrFail(runtime, following, 0, "following route");
  assert.ok(before < wiringAt && wiringAt < after, `${call} wired where its routes were: after ${preceding}, before ${following}`);
  const gap = runtime.slice(before + 1, wiringAt);
  assert.doesNotMatch(gap, /\n  app\.(get|post|put|patch|delete)\(|\n  register\w+Routes\(/, `${call}: the wiring call directly follows the preceding route`);
  const block = runtime.slice(wiringAt, indexOrFail(runtime, "\n  });\n", wiringAt + 1, `${call} wiring block end`));
  const injectedKeys = [...block.matchAll(/^\s+([A-Za-z_]+)(?::|,|$)/gm)].map((m) => m[1]);
  assert.deepEqual(injectedKeys.sort(), injected.map((dep) => dep.split(":")[0]).sort(), `${call}: no extra and no missing dependency`);
  for (const dep of injected) assert.match(block, new RegExp(`^\\s+${escape(dep)},?$`, "m"), `${call} injected: ${dep}`);
  return wiringAt;
}

function handlersOf(routes: string) {
  return routes.split(/\n  app\.(?=get\(|post\(|patch\(|put\(|delete\()/).slice(1);
}

type Sources = { runtime: string; routes: string; others: Record<string, string> };

const CHECK = {
  REGISTRATION: "each of the six admin growth routes is registered exactly once, as a GET, in src/admin_growth_routes.ts, inside its own register function",
  ORDER: "the module registers the six routes in their original order",
  WIRING: "src/frontend_runtime.ts keeps no moved handler and wires each register function exactly once, at its original point (the first after the shared engine)",
  NO_COPY: "the module copies no guard, helper or viral-tree engine and never imports the runtime",
  GUARDS: "every handler opens with the admin read guard, then its original validation, schema checks and one transaction",
  READ_ONLY: "every handler stays a read: one transaction per request, no write or DDL SQL, no mutation guard"
} as const;

// Each check throws on a violation. They run on the real sources and on mutants.
const CHECKS: Record<string, (s: Sources) => void> = {
  [CHECK.REGISTRATION]: (s) => {
    const files: Array<[string, string]> = [["frontend_runtime.ts", s.runtime], ["admin_growth_routes.ts", s.routes], ...Object.entries(s.others)];
    for (const route of ALL_ROUTES) {
      const pattern = new RegExp(`\\bapp\\.(get|post|put|patch|delete|options|head|all|route)\\(\\s*["'\`]${escape(route.path)}["'\`]`, "g");
      const registrations = files.flatMap(([file, text]) => [...text.matchAll(pattern)].map((m) => `${file} ${m[1]}`)).sort();
      assert.deepEqual(registrations, [`admin_growth_routes.ts ${route.method}`], route.path);
    }
    const all = [...s.routes.matchAll(/\bapp\.(get|post|put|patch|delete|options|head|all|route)\(/g)];
    assert.equal(all.length, ALL_ROUTES.length, "the module registers nothing beyond the six admin growth routes");
    // each route lives in the register function that is wired at its original point
    const placed = (body: string) => [...body.matchAll(/\n  app\.(get|post|put|patch|delete)\("([^"]+)"/g)].map((m) => m[2]);
    assert.deepEqual(placed(functionBody(s.routes, FIRST_REGISTER)), GROWTH_ROUTES.map((r) => r.path), "registerAdminGrowthRoutes registers exactly the five growth routes");
    assert.deepEqual(placed(functionBody(s.routes, SECOND_REGISTER)), SELLER_VIRAL_ROUTES.map((r) => r.path), "registerAdminSellerViralRoutes registers exactly the seller viral route");
  },
  [CHECK.ORDER]: (s) => {
    const registered = [...s.routes.matchAll(/\n  app\.(get|post|put|patch|delete)\("([^"]+)"/g)].map((m) => `${m[1]} ${m[2]}`);
    assert.deepEqual(registered, ALL_ROUTES.map((route) => `${route.method} ${route.path}`));
  },
  [CHECK.WIRING]: (s) => {
    for (const route of ALL_ROUTES) {
      assert.ok(!s.runtime.includes(`app.${route.method}("${route.path}"`), `a moved handler stayed in the runtime: ${route.path}`);
    }
    assert.match(s.runtime, /^import \{ registerAdminGrowthRoutes, registerAdminSellerViralRoutes \} from "\.\/admin_growth_routes\.js";$/m);
    assert.equal((s.runtime.match(/registerAdminGrowthRoutes\(/g) || []).length, 1, "exactly one registerAdminGrowthRoutes wiring call");
    assert.equal((s.runtime.match(/registerAdminSellerViralRoutes\(/g) || []).length, 1, "exactly one registerAdminSellerViralRoutes wiring call");
    const wiringAt = assertWiring(s.runtime, "registerAdminGrowthRoutes", PRECEDING_ROUTE, FOLLOWING_ROUTE, INJECTED_DEPS);
    assertWiring(s.runtime, "registerAdminSellerViralRoutes", SELLER_VIRAL_PRECEDING_ROUTE, SELLER_VIRAL_FOLLOWING_ROUTE, SELLER_VIRAL_INJECTED_DEPS);
    // the shared engine is defined once, in the runtime, before the wiring call (no reliance on hoisting)
    for (const name of SHARED_ENGINE) {
      const defs = [...s.runtime.matchAll(new RegExp(`^  (?:async )?function ${name}\\(`, "gm"))];
      assert.equal(defs.length, 1, `${name} defined once in the runtime`);
      assert.ok(defs[0]!.index! < wiringAt, `${name} defined before the wiring call`);
    }
  },
  [CHECK.NO_COPY]: (s) => {
    assert.doesNotMatch(s.routes, /from "\.\/frontend_runtime(\.js)?"/, "no circular import of the runtime");
    assert.doesNotMatch(s.routes, /\bimport\([^)]*frontend_runtime/, "no dynamic import of the runtime");
    assert.doesNotMatch(
      s.routes,
      /function (requireAdminRead|requireAdminMutation|requireAdminAuthContext|requireAdminKey|adminActorRef|requireUuid|isUuid|memoizeSchemaCheck|queryViralTreeLevel|queryPropagationSources|viralTreeQueryParams|maskTreeName|ensure\w+)\b/,
      "guards and helpers are injected, not re-implemented"
    );
    assert.doesNotMatch(s.routes, /\b(const|let|var)\s+(queryViralTreeLevel|queryPropagationSources|viralTreeQueryParams|maskTreeName)\s*=/, "the shared engine is injected, not copied");
    assert.doesNotMatch(s.routes, /viral_attributions|affiliate_links|WITH RECURSIVE/i, "no viral-tree engine SQL of its own");
    assert.doesNotMatch(s.routes, /process\.env|timingSafeEqual|x-admin-key|memoizeSchemaCheck\(/, "no auth, configuration or schema-memo logic of its own");
    assert.match(s.routes, /^export function registerAdminGrowthRoutes\(app: FastifyInstance, deps: AdminGrowthRouteDeps\) \{$/m);
    const registerAt = indexOrFail(s.routes, FIRST_REGISTER, 0, "register");
    const destructured = s.routes.slice(indexOrFail(s.routes, "const {", registerAt, "destructure"), indexOrFail(s.routes, "} = deps;", registerAt, "destructure end"));
    for (const name of INJECTED_DEPS.filter((dep) => !dep.includes(":"))) assert.match(destructured, new RegExp(`\\b${name}\\b`), `destructured from deps: ${name}`);
    assert.match(s.routes, /^export type AdminSellerViralRouteDeps = Pick<AdminGrowthRouteDeps, "withTx" \| "requireAdminRead">;$/m, "the seller viral read takes only the guard and the transaction");
    assert.match(s.routes, /^export function registerAdminSellerViralRoutes\(app: FastifyInstance, deps: AdminSellerViralRouteDeps\) \{\n  const \{ requireAdminRead \} = deps;$/m);
  },
  [CHECK.GUARDS]: (s) => {
    const handlers = handlersOf(s.routes);
    assert.equal(handlers.length, ALL_ROUTES.length);
    for (const route of ALL_ROUTES) {
      const handler = handlers.find((h) => h.startsWith(`${route.method}("${route.path}", async (req: any, reply: any) => {\n`));
      assert.ok(handler, `${route.method.toUpperCase()} ${route.path} handler located`);
      const expected = OPENING[route.path]!;
      assert.deepEqual(handler!.split("\n").slice(1, 1 + expected.length), expected, `${route.method.toUpperCase()} ${route.path} keeps its opening`);
    }
    assert.equal((s.routes.match(/await requireAdminRead\(req, reply\)/g) || []).length, ALL_ROUTES.length, "one admin read guard per route");
  },
  [CHECK.READ_ONLY]: (s) => {
    assert.doesNotMatch(s.routes, /requireAdminMutation|requireAdminAuthContext/, "no mutation guard: the module only reads");
    assert.doesNotMatch(s.routes, /\b(INSERT\s+INTO|UPDATE\s+siton\.|DELETE\s+FROM|TRUNCATE|ALTER\s+TABLE|CREATE\s+TABLE|DROP\s+TABLE)\b/i, "no write or DDL SQL");
    assert.doesNotMatch(s.routes, /enqueue\w*\(|recordOperationalCaseEvent|appendAuditLog|insertAudit|recordViralFunnelEvent/, "no outbox, case, audit or funnel write");
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
  routes: read("admin_growth_routes.ts"),
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
  const start = indexOrFail(real.routes, `  app.get("${path}",`, 0, `slice ${path}`);
  const end = nextPath ? indexOrFail(real.routes, `  app.get("${nextPath}",`, start, `slice end ${nextPath}`) : indexOrFail(real.routes, "\n}\n", start, `slice end of function after ${path}`) + 1;
  assert.ok(end > start, `slice ${path}`);
  return real.routes.slice(start, end);
};
const growth = handlerSlice("/api/admin/growth", "/api/admin/deals/:dealId/viral");
const viralTree = handlerSlice("/api/admin/deals/:dealId/viral-tree", "/api/admin/deals/:dealId/propagation");
const propagation = handlerSlice("/api/admin/deals/:dealId/propagation", null);
const sellerViral = handlerSlice("/api/admin/sellers/:sellerId/viral", null);
// the close of the first register function (the second function follows it)
const FIRST_END = "\n  });\n}\n\nexport type AdminSellerViralRouteDeps";
const open = (path: string) => `  app.get("${path}", async (req: any, reply: any) => {\n`;
const wiringStart = real.runtime.indexOf("  registerAdminGrowthRoutes(app, {");
const wiring = real.runtime.slice(wiringStart, real.runtime.indexOf("\n  });\n", wiringStart) + "\n  });\n".length);
const MUTANTS: Array<[string, string, () => Sources]> = [
  // guards
  ["read guard removed from GET /api/admin/pilot-metrics", CHECK.GUARDS, () => ({ ...real, routes: replaceOnce(real.routes, `${open("/api/admin/pilot-metrics")}${GUARD}\n`, open("/api/admin/pilot-metrics")) })],
  ["guard moved behind the growth-window validation", CHECK.GUARDS, () => ({ ...real, routes: replaceOnce(real.routes, `${open("/api/admin/growth")}${GUARD}\n    const resolved = resolveGrowthWindow(req.query || {});\n`, `${open("/api/admin/growth")}    const resolved = resolveGrowthWindow(req.query || {});\n${GUARD}\n`) })],
  ["guard moved behind the uuid check on GET /api/admin/deals/:dealId/propagation", CHECK.GUARDS, () => ({ ...real, routes: replaceOnce(real.routes, `${open("/api/admin/deals/:dealId/propagation")}${GUARD}\n    const dealId = String(req.params.dealId || "");\n    requireUuid(dealId, "deal_id");\n`, `${open("/api/admin/deals/:dealId/propagation")}    const dealId = String(req.params.dealId || "");\n    requireUuid(dealId, "deal_id");\n${GUARD}\n`) })],
  ["uuid validation dropped from GET /api/admin/deals/:dealId/viral-tree", CHECK.GUARDS, () => ({ ...real, routes: replaceOnce(real.routes, `${open("/api/admin/deals/:dealId/viral-tree")}${GUARD}\n    const dealId = String(req.params.dealId || "");\n    requireUuid(dealId, "deal_id");\n`, `${open("/api/admin/deals/:dealId/viral-tree")}${GUARD}\n    const dealId = String(req.params.dealId || "");\n`) })],
  ["pilot-metrics schema check moved inside the transaction", CHECK.GUARDS, () => ({ ...real, routes: replaceOnce(real.routes, "    await ensureInquiryTables();\n    return deps.withTx(async (c) => {\n", "    return deps.withTx(async (c) => {\n    await ensureInquiryTables();\n") })],
  // read-only
  ["viral metrics read downgraded to a mutation guard", CHECK.READ_ONLY, () => ({ ...real, routes: replaceOnce(real.routes, `${open("/api/admin/deals/:dealId/viral")}${GUARD}\n`, `${open("/api/admin/deals/:dealId/viral")}${GUARD}\n    if (!(await requireAdminMutation(req, reply, "outbox.requeue"))) return;\n`) })],
  ["growth read turned into a write", CHECK.READ_ONLY, () => ({ ...real, routes: replaceOnce(real.routes, "      const windowed = await computeGrowthWindowMetrics(c, window);\n", "      const windowed = await computeGrowthWindowMetrics(c, window);\n      await c.query(`DELETE FROM siton.viral_metrics_cache WHERE scope_type = 'platform'`);\n") })],
  ["propagation split over two transactions", CHECK.READ_ONLY, () => ({ ...real, routes: replaceOnce(real.routes, "      return result;\n    });\n", "      return result;\n    }).then((r: any) => deps.withTx(async () => r));\n") })],
  // registration
  ["growth route registered a second time in the module", CHECK.REGISTRATION, () => ({ ...real, routes: replaceOnce(real.routes, FIRST_END, `\n  });\n${growth}}\n\nexport type AdminSellerViralRouteDeps`) })],
  ["viral-tree route left behind in the runtime as well", CHECK.REGISTRATION, () => ({ ...real, runtime: replaceOnce(real.runtime, `  ${FOLLOWING_ROUTE}`, `${viralTree}  ${FOLLOWING_ROUTE}`) })],
  ["propagation route dropped (omission)", CHECK.REGISTRATION, () => ({ ...real, routes: replaceOnce(real.routes, propagation, "") })],
  // order
  ["viral-tree and propagation registered in swapped order", CHECK.ORDER, () => ({ ...real, routes: replaceOnce(real.routes, viralTree + propagation, propagation + viralTree) })],
  ["growth moved to the end of the first register function", CHECK.ORDER, () => ({ ...real, routes: replaceOnce(replaceOnce(real.routes, growth, ""), FIRST_END, `\n  });\n${growth}}\n\nexport type AdminSellerViralRouteDeps`) })],
  // wiring
  ["module wired twice", CHECK.WIRING, () => ({ ...real, runtime: replaceOnce(real.runtime, "  registerAdminGrowthRoutes(app, {", "  registerAdminGrowthRoutes(app, deps as any);\n  registerAdminGrowthRoutes(app, {") })],
  ["module wired after the seller inquiries (registration order changes)", CHECK.WIRING, () => {
    const moved = replaceOnce(real.runtime, wiring, "");
    return { ...real, runtime: replaceOnce(moved, '  app.post("/api/seller/inquiries/:threadId/reply"', `${wiring}  app.post("/api/seller/inquiries/:threadId/reply"`) };
  }],
  ["module wired before the shared engine is defined (relies on hoisting)", CHECK.WIRING, () => {
    const moved = replaceOnce(real.runtime, wiring, "");
    const engineAt = moved.indexOf("  // ONE canonical viral-tree engine");
    assert.ok(engineAt > 0, "engine comment anchor");
    return { ...real, runtime: moved.slice(0, engineAt) + wiring + "\n" + moved.slice(engineAt) };
  }],
  ["preceding neighbour route renamed (a -1 position must fail, not pass)", CHECK.WIRING, () => ({ ...real, runtime: replaceOnce(real.runtime, PRECEDING_ROUTE, 'app.get("/api/seller/deals/:dealId/viral-renamed"') })],
  ["an extra dependency injected", CHECK.WIRING, () => ({ ...real, runtime: replaceOnce(real.runtime, "    requireAdminRead,\n    requireUuid,\n    ensureProductSurfaces,\n    ensureInquiryTables,", "    requireAdminRead,\n    requireAdminMutation,\n    requireUuid,\n    ensureProductSurfaces,\n    ensureInquiryTables,") })],
  ["a dependency dropped from the wiring", CHECK.WIRING, () => ({ ...real, runtime: replaceOnce(real.runtime, "    queryPropagationSources,\n    viralTreeQueryParams\n  });", "    viralTreeQueryParams\n  } as any);") })],
  ["the shared engine duplicated in the runtime", CHECK.WIRING, () => ({ ...real, runtime: replaceOnce(real.runtime, "  function viralTreeQueryParams(req: any) {", "  function viralTreeQueryParams(req: any) { return { parentId: null, sourceKey: null, limit: 60 }; }\n  function viralTreeQueryParamsShadow(req: any) {").replace("\n  registerAdminGrowthRoutes(app, {", "\n  function viralTreeQueryParams(req: any) { return {}; }\n  registerAdminGrowthRoutes(app, {") })],
  // copies
  ["module imports the runtime back", CHECK.NO_COPY, () => ({ ...real, routes: replaceOnce(real.routes, 'import type { FastifyInstance } from "fastify";', 'import type { FastifyInstance } from "fastify";\nimport { registerFrontendExperience } from "./frontend_runtime.js";') })],
  ["module re-implements the admin read guard", CHECK.NO_COPY, () => ({ ...real, routes: replaceOnce(real.routes, "export function registerAdminGrowthRoutes(", "function requireAdminRead(req: any, reply: any) { return true; }\nexport function registerAdminGrowthRoutes(") })],
  ["module copies the viral-tree engine", CHECK.NO_COPY, () => ({ ...real, routes: replaceOnce(real.routes, "export function registerAdminGrowthRoutes(", "async function queryViralTreeLevel(c: any, dealId: string) { return c.query(`SELECT * FROM siton.viral_attributions WHERE deal_id = $1`, [dealId]); }\nexport function registerAdminGrowthRoutes(") })],
  ["module copies the viral-tree query parser as a const", CHECK.NO_COPY, () => ({ ...real, routes: replaceOnce(real.routes, "export function registerAdminGrowthRoutes(", "const viralTreeQueryParams = (req: any) => ({ parentId: null, sourceKey: null, limit: 200 });\nexport function registerAdminGrowthRoutes(") })],
  // the per-seller viral read and its own wiring point
  ["read guard removed from GET /api/admin/sellers/:sellerId/viral", CHECK.GUARDS, () => ({ ...real, routes: replaceOnce(real.routes, `${open("/api/admin/sellers/:sellerId/viral")}${GUARD}\n`, open("/api/admin/sellers/:sellerId/viral")) })],
  ["seller viral read moved into the first register function (registry order changes)", CHECK.REGISTRATION, () => ({ ...real, routes: replaceOnce(replaceOnce(real.routes, sellerViral, ""), FIRST_END, `\n  });\n${sellerViral}}\n\nexport type AdminSellerViralRouteDeps`) })],
  ["seller viral read left behind in the runtime as well", CHECK.REGISTRATION, () => ({ ...real, runtime: replaceOnce(real.runtime, `  ${SELLER_VIRAL_FOLLOWING_ROUTE}`, `${sellerViral}  ${SELLER_VIRAL_FOLLOWING_ROUTE}`) })],
  ["seller viral read dropped (omission)", CHECK.REGISTRATION, () => ({ ...real, routes: replaceOnce(real.routes, sellerViral, "") })],
  ["seller viral wiring removed", CHECK.WIRING, () => {
    const start = real.runtime.indexOf("  registerAdminSellerViralRoutes(app, {");
    const end = real.runtime.indexOf("\n  });\n", start) + "\n  });\n".length;
    return { ...real, runtime: real.runtime.slice(0, start) + real.runtime.slice(end) };
  }],
  ["seller viral wired after the viral recompute mutation (registration order changes)", CHECK.WIRING, () => {
    const start = real.runtime.indexOf("  registerAdminSellerViralRoutes(app, {");
    const end = real.runtime.indexOf("\n  });\n", start) + "\n  });\n".length;
    const call = real.runtime.slice(start, end);
    const moved = real.runtime.slice(0, start) + real.runtime.slice(end);
    return { ...real, runtime: replaceOnce(moved, "  registerAdminControlCenterRoutes(app, {", `${call}  registerAdminControlCenterRoutes(app, {`) };
  }],
  ["seller viral wiring injects an extra dependency", CHECK.WIRING, () => ({ ...real, runtime: replaceOnce(real.runtime, "  registerAdminSellerViralRoutes(app, {\n    withTx: deps.withTx,\n    requireAdminRead\n  });", "  registerAdminSellerViralRoutes(app, {\n    withTx: deps.withTx,\n    requireAdminRead,\n    requireAdminMutation\n  } as any);") })],
  ["seller viral neighbour anchor renamed (a -1 position must fail, not pass)", CHECK.WIRING, () => ({ ...real, runtime: replaceOnce(real.runtime, SELLER_VIRAL_PRECEDING_ROUTE, 'app.get("/api/seller/deals/:dealId/viral-tree-renamed"') })],
  ["the viral recompute mutation pulled into the read module", CHECK.READ_ONLY, () => ({ ...real, routes: replaceOnce(real.routes, "export function registerAdminSellerViralRoutes(app: FastifyInstance, deps: AdminSellerViralRouteDeps) {\n  const { requireAdminRead } = deps;\n", "export function registerAdminSellerViralRoutes(app: FastifyInstance, deps: AdminSellerViralRouteDeps) {\n  const { requireAdminRead } = deps;\n  const requireAdminMutation: any = (deps as any).requireAdminMutation;\n") })]
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
  process.env.SELLER_SESSION_SECRET = process.env.SELLER_SESSION_SECRET || "seller-session-secret-growth-extraction";
  process.env.ADMIN_API_KEY = process.env.ADMIN_API_KEY || "growth-extraction-admin-key";
  process.env.ADMIN_SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || "admin-session-secret-growth-extraction";
  const appModule: any = await import("../src/app.js");
  try {
    await appModule.app.ready();
    const registry: Array<{ method: string; url: string }> | undefined = appModule.ROUTE_REGISTRY;
    assert.ok(Array.isArray(registry) && registry.length > 150, "src/app.ts exports the onRoute ROUTE_REGISTRY");
    const entries = registry!.filter((r) => r.method !== "HEAD").map((r) => `${r.method} ${r.url}`);
    const expected = GROWTH_ROUTES.map((r) => `${r.method.toUpperCase()} ${r.path}`);
    for (const entry of expected) assert.equal(entries.filter((e) => e === entry).length, 1, `registered once: ${entry}`);
    const first = entries.indexOf(expected[0]!);
    assert.ok(first > 0, "the first growth route is registered");
    assert.deepEqual(entries.slice(first, first + expected.length), expected, "contiguous, in the original order");
    assert.equal(entries[first - 1], "GET /api/seller/deals/:dealId/viral", "preceded by the seller deal viral route");
    assert.equal(entries[first + expected.length], "GET /api/seller/inquiries", "followed by the seller inquiries route");
    // the per-seller viral read keeps its own original place
    const sellerViralEntry = "GET /api/admin/sellers/:sellerId/viral";
    assert.equal(entries.filter((e) => e === sellerViralEntry).length, 1, `registered once: ${sellerViralEntry}`);
    const sv = entries.indexOf(sellerViralEntry);
    assert.ok(sv > 0, "the seller viral read is registered");
    assert.equal(entries[sv - 1], "GET /api/seller/deals/:dealId/viral-tree", "preceded by the seller viral explorer");
    assert.equal(entries[sv + 1], "POST /api/admin/viral/recompute", "followed by the viral recompute mutation");
    for (const r of ALL_ROUTES) {
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
  console.error(`admin_growth_routes_extraction_validation failed=${failed}`);
  process.exit(1);
}
console.log("PASS admin_growth_routes_extraction_validation");
process.exit(0);
