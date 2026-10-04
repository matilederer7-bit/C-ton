// LEAN REFACTOR — structural proof for the seller fulfillment route extraction.
// The eleven seller fulfillment, delivery-handoff and export routes (shipping
// export, delivery handoff JSON + Excel, the physical pickup rail resolve /
// search / handoff, the per-deal fulfillment list, voucher and ticket CSV
// exports, voucher/ticket redemption and the seller deal Excel export) moved
// verbatim from src/frontend_runtime.ts into src/seller_fulfillment_routes.ts.
// This test pins the shape of that move so a later edit cannot silently
// register a route twice, drop or rename one, leave a handler behind in the
// runtime, copy a guard into the module, move a guard behind the input it
// protects, weaken an ownership check, or reorder the redemption state checks.
// Every positional check first proves its anchor exists (indexOrFail) and only
// then compares positions, so a missing anchor can never pass vacuously. The
// checks run against the real sources and then against mutated copies, which
// must each be rejected by the check that guards that property. Finally the
// live Fastify route registry is read to prove each route is registered once,
// in its original order, between its original neighbours. The live behaviour
// (status codes, response contracts, CSV/Excel output) stays covered by
// tests/seller_shipping_export_validation.ts,
// tests/seller_delivery_handoff_validation.ts,
// tests/seller_delivery_excel_export_validation.ts,
// tests/seller_pickup_fulfillment_validation.ts,
// tests/seller_fulfillment_security_validation.ts,
// tests/pickup_fulfillment_concurrency_validation.ts,
// tests/receipt_redeem_concurrency_validation.ts,
// tests/deal_types_validation.ts, tests/seller_deal_excel_export_validation.ts
// and the protected-route authorization gate.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
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
  "support_routes.ts"
];

type Guard = "deal" | "unit" | "pickup-read" | "pickup-mutation";
// In the original registration order (Fastify registers in call order).
const FULFILLMENT_ROUTES: Array<{ method: "get" | "post"; path: string; guard: Guard }> = [
  { method: "get", path: "/api/seller/deals/:dealId/shipping-export", guard: "deal" },
  { method: "get", path: "/api/seller/deals/:dealId/delivery-handoff", guard: "deal" },
  { method: "get", path: "/api/seller/deals/:dealId/delivery-handoff/export.xlsx", guard: "deal" },
  { method: "get", path: "/api/seller/fulfillment/resolve", guard: "pickup-read" },
  { method: "get", path: "/api/seller/fulfillment/search", guard: "pickup-read" },
  { method: "post", path: "/api/seller/fulfillment/handoff", guard: "pickup-mutation" },
  { method: "get", path: "/api/seller/deals/:dealId/fulfillment", guard: "deal" },
  { method: "get", path: "/api/seller/deals/:dealId/voucher-export", guard: "deal" },
  { method: "get", path: "/api/seller/deals/:dealId/ticket-export", guard: "deal" },
  { method: "post", path: "/api/seller/fulfillment/:unitId/redeem", guard: "unit" },
  { method: "get", path: "/api/seller/deals/:dealId/export.xlsx", guard: "deal" }
];
// The first statements inside each handler's transaction: the seller guard,
// before any input is validated and before any row is read.
const RESOLVE = "      const sellerContext = await resolveRequiredSellerContext(req, reply, c, { autoCreate: true });";
const GUARD_OPENING: Record<Guard, string[]> = {
  deal: [RESOLVE, "      if (!sellerContext) return reply;", '      requireUuid(dealId, "deal_id"); // after the guard: authorization precedes observation'],
  unit: [RESOLVE, "      if (!sellerContext) return reply;", '      requireUuid(unitId, "fulfillment_unit_id"); // after the guard: authorization precedes observation'],
  "pickup-read": [RESOLVE, "      if (!sellerContext) return reply;", '      if (!(await ensureSellerActionAllowed(c, sellerContext.seller_id, "operate", reply))) return reply;'],
  "pickup-mutation": [RESOLVE, "      if (!sellerContext) return null;", '      if (!(await ensureSellerActionAllowed(c, sellerContext.seller_id, "operate", reply))) return null;']
};
// Deal-scoped routes: the deal lookup is the only query before the ownership check.
const DEAL_OWNERSHIP = /if \(!?(?:dealResult\.rowCount \|\| )?String\((?:deal|dealResult\.rows\[0\])\.effective_seller_id\) !== sellerId\)/g;
// Redemption: lock, ownership, completion, entitlement, idempotent replay, status, guarded update.
const REDEEM_ORDER = [
  RESOLVE,
  "if (!sellerContext) return reply;",
  'requireUuid(unitId, "fulfillment_unit_id");',
  "FOR UPDATE`,",
  'err.code = "fulfillment_unit_not_found";',
  "if (String(unit.seller_id) !== sellerId) {",
  'err.code = "fulfillment_unit_forbidden";',
  'if (String(unit.deal_state) !== "Completed") {',
  "if (!decideFulfillmentIssuance({ dealState: unit.deal_state, buyerState: unit.buyer_state, moneyState: unit.money_state }).shouldIssue) {",
  'if (String(unit.status) === "Redeemed") {',
  "idempotent: true,",
  'if (!["Issued", "Sent"].includes(String(unit.status))) {',
  "UPDATE siton.fulfillment_units",
  "AND status IN ('Issued','Sent')",
  'err.code = "fulfillment_unit_race";'
];
// Pickup handoff: guard, operate, body, id validation, then the seller-scoped
// mutation inside the transaction; the reply is sent only after commit.
const HANDOFF_ORDER = [
  "await ensureDealTypeTables(deps.withTx);",
  "const result = await deps.withTx(async (c) => {",
  RESOLVE.trim(),
  "if (!sellerContext) return null;",
  'if (!(await ensureSellerActionAllowed(c, sellerContext.seller_id, "operate", reply))) return null;',
  "const body = req.body && typeof req.body === \"object\" ? req.body : {}; // after the guard",
  'requireUuid(participantId, "participant_id");',
  'const idempotencyKey = String(req.headers?.["idempotency-key"] || body.idempotency_key || `handoff:${participantId}`).trim().slice(0, 200);',
  "const outcome = await handoffPhysicalOrder(c, {\n        sellerId: sellerContext.seller_id,",
  "actorRef: handoffActorRef(sellerContext),",
  "idempotencyKey\n      });",
  "    });\n    if (!result) return reply;\n    return reply.code(result.status).send(result.body);\n  });"
];
const INJECTED_DEPS = [
  "withTx: deps.withTx",
  "resolveRequiredSellerContext",
  "ensureSellerActionAllowed",
  "requireUuid",
  "ensureProductSurfaces",
  "mockMoneyRuntime"
];
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function indexOrFail(text: string, needle: string, from: number, label: string) {
  const at = text.indexOf(needle, from);
  assert.ok(at >= 0, `${label}: missing ${needle.slice(0, 120)}`);
  return at;
}
function countOf(text: string, needle: string) {
  return text.split(needle).length - 1;
}

type Sources = { runtime: string; routes: string; others: Record<string, string> };

// Split the module into handlers: each starts at a 2-space `app.<method>(` and
// runs until the next one (the last runs to the end of the module).
function handlersOf(routes: string) {
  return routes.split(/\n  app\.(?=get\(|post\(|put\(|patch\(|delete\()/).slice(1);
}
function handlerFor(routes: string, route: { method: string; path: string }) {
  const header = `${route.method}("${route.path}", async (req: any, reply: any) => {\n`;
  const matching = handlersOf(routes).filter((h) => h.startsWith(header));
  assert.equal(matching.length, 1, `${route.method.toUpperCase()} ${route.path}: exactly one handler located`);
  return matching[0]!;
}
function assertInOrder(text: string, steps: string[], label: string) {
  let cursor = 0;
  for (const step of steps) {
    const at = text.indexOf(step, cursor);
    assert.ok(at >= 0, `${label}: "${step.slice(0, 100)}" missing or out of order`);
    cursor = at + step.length;
  }
}

const CHECK = {
  REGISTRATION: "each of the eleven routes is registered exactly once, with its method, in src/seller_fulfillment_routes.ts, in the original order",
  WIRING: "src/frontend_runtime.ts keeps no fulfillment handler and wires the module exactly once, at the original point",
  NO_COPY: "the module copies no guard or helper and never imports the runtime; the two local helpers moved, mockMoneyRuntime stayed",
  GUARDS: "every handler opens its transaction with the seller guard, before any validation or row read",
  OWNERSHIP: "every route scopes to the guarded seller before it reads another row",
  REDEEM: "redemption keeps its lock, ownership, completion, entitlement, idempotency and guarded-update order",
  HANDOFF: "the pickup handoff keeps guard, operate, validation, seller-scoped mutation and reply-after-commit order"
} as const;

const CHECKS: Record<string, (s: Sources) => void> = {
  [CHECK.REGISTRATION]: (s) => {
    const files: Array<[string, string]> = [["frontend_runtime.ts", s.runtime], ["seller_fulfillment_routes.ts", s.routes], ...Object.entries(s.others)];
    for (const route of FULFILLMENT_ROUTES) {
      const pattern = new RegExp(`\\bapp\\.(get|post|put|patch|delete|options|head|all|route)\\(\\s*["'\`]${escape(route.path)}["'\`]`, "g");
      const registrations = files.flatMap(([file, text]) => [...text.matchAll(pattern)].map((m) => `${file} ${m[1]}`));
      assert.deepEqual(registrations, [`seller_fulfillment_routes.ts ${route.method}`], route.path);
    }
    const registered = [...s.routes.matchAll(/\bapp\.(get|post|put|patch|delete|options|head|all|route)\(\s*["'`]([^"'`]+)["'`]/g)].map((m) => `${m[1]} ${m[2]}`);
    assert.equal((s.routes.match(/\bapp\.[a-z]+\(/g) || []).length, FULFILLMENT_ROUTES.length, "the module registers nothing beyond the eleven routes");
    assert.deepEqual(registered, FULFILLMENT_ROUTES.map((r) => `${r.method} ${r.path}`), "registered in the original order");
  },
  [CHECK.WIRING]: (s) => {
    for (const route of FULFILLMENT_ROUTES) {
      assert.ok(!s.runtime.includes(`"${route.path}"`), `the runtime still names ${route.path}`);
    }
    assert.doesNotMatch(s.runtime, /function (pickupCodeNotFound|handoffActorRef)\b/, "the moved helpers are not left behind");
    assert.match(s.runtime, /^import \{ registerSellerFulfillmentRoutes \} from "\.\/seller_fulfillment_routes\.js";$/m);
    assert.equal(countOf(s.runtime, "registerSellerFulfillmentRoutes("), 1, "exactly one wiring call in the runtime");
    for (const [file, text] of Object.entries(s.others)) {
      assert.ok(!text.includes("registerSellerFulfillmentRoutes") && !text.includes("seller_fulfillment_routes"), `${file} must not wire the module`);
    }
    const wiringAt = indexOrFail(s.runtime, "  registerSellerFulfillmentRoutes(app, {\n", 0, "wiring");
    const before = indexOrFail(s.runtime, '  app.get("/api/seller/deals/:id", async (req: any, reply: any) => {', 0, "preceding route");
    const after = indexOrFail(s.runtime, '  app.post("/webhooks/payments"', 0, "following route");
    assert.ok(before < wiringAt && wiringAt < after, "wired where the routes were: after GET /api/seller/deals/:id, before POST /webhooks/payments");
    const between = s.runtime.slice(before + 10, after);
    assert.equal((between.match(/\n  app\.[a-z]+\(/g) || []).length, 0, "no other route is registered between the preceding route's end and the webhook route");
    const block = s.runtime.slice(wiringAt, indexOrFail(s.runtime, "\n  });\n", wiringAt, "wiring block end"));
    const injectedKeys = [...block.matchAll(/^\s+([A-Za-z_]+)(?::|,|$)/gm)].map((m) => m[1]);
    assert.deepEqual(injectedKeys.sort(), INJECTED_DEPS.map((dep) => dep.split(":")[0]).sort(), "no extra and no missing dependency");
    for (const dep of INJECTED_DEPS) assert.match(block, new RegExp(`^\\s+${escape(dep)},?$`, "m"), `injected: ${dep}`);
  },
  [CHECK.NO_COPY]: (s) => {
    assert.doesNotMatch(s.routes, /from "\.\/frontend_runtime(\.js)?"/, "no circular import of the runtime");
    assert.doesNotMatch(s.routes, /\bimport\([^)]*frontend_runtime/, "no dynamic import of the runtime");
    assert.doesNotMatch(
      s.routes,
      /function (resolveRequiredSellerContext|resolveSellerContext|resolveOptionalSellerContext|ensureSellerActionAllowed|requireUuid|isUuid|mockMoneyRuntime|memoizeSchemaCheck|ensureProductSurfaces|ensure\w+Tables)\b/,
      "guards and helpers are injected, not re-implemented"
    );
    assert.doesNotMatch(s.routes, /process\.env|timingSafeEqual|x-admin-key|seller_session|memoizeSchemaCheck\(/, "no auth, configuration or schema-memo logic of its own");
    assert.match(s.routes, /^export function registerSellerFulfillmentRoutes\(app: FastifyInstance, deps: SellerFulfillmentRouteDeps\) \{$/m);
    const fnAt = indexOrFail(s.routes, "export function registerSellerFulfillmentRoutes(", 0, "register function");
    const destructureAt = indexOrFail(s.routes, "  const {\n", fnAt, "destructure");
    const destructured = s.routes.slice(destructureAt, indexOrFail(s.routes, "} = deps;", destructureAt, "destructure end"));
    for (const name of INJECTED_DEPS.filter((dep) => !dep.includes(":"))) assert.match(destructured, new RegExp(`\\b${name}\\b`), `destructured from deps: ${name}`);
    for (const helper of ["pickupCodeNotFound", "handoffActorRef"]) {
      assert.equal(countOf(s.routes, `function ${helper}(`), 1, `${helper} moved with its routes, defined once`);
    }
    assert.equal(countOf(s.runtime, "function mockMoneyRuntime("), 1, "mockMoneyRuntime stays in the runtime (buyer tracking uses it too)");
  },
  [CHECK.GUARDS]: (s) => {
    for (const route of FULFILLMENT_ROUTES) {
      const handler = handlerFor(s.routes, route);
      const label = `${route.method.toUpperCase()} ${route.path}`;
      assert.equal(countOf(handler, "deps.withTx(async (c) => {\n"), 1, `${label}: one transaction`);
      const txAt = indexOrFail(handler, "deps.withTx(async (c) => {\n", 0, label);
      const preamble = handler.slice(0, txAt);
      assert.doesNotMatch(preamble, /c\.query|req\.body|req\.query|requireUuid|reply\.(code|send|header)/, `${label}: nothing is read or answered before the guard`);
      const opening = handler.slice(txAt).split("\n").slice(1, 1 + GUARD_OPENING[route.guard].length);
      assert.deepEqual(opening, GUARD_OPENING[route.guard], `${label} opens its transaction with its guard`);
    }
    assert.equal(countOf(s.routes, "await resolveRequiredSellerContext(req, reply, c, { autoCreate: true })"), FULFILLMENT_ROUTES.length, "one seller guard per route");
    assert.equal(countOf(s.routes, "await ensureSellerActionAllowed("), FULFILLMENT_ROUTES.filter((r) => r.guard.startsWith("pickup")).length, "seller-status enforcement on every pickup route");
    assert.equal(countOf(s.routes, 'ensureSellerActionAllowed(c, sellerContext.seller_id, "operate", reply)'), 3, "no other seller action");
  },
  [CHECK.OWNERSHIP]: (s) => {
    for (const route of FULFILLMENT_ROUTES.filter((r) => r.guard === "deal")) {
      const handler = handlerFor(s.routes, route);
      const label = `${route.method.toUpperCase()} ${route.path}`;
      const checks = [...handler.matchAll(DEAL_OWNERSHIP)];
      assert.equal(checks.length, 1, `${label}: exactly one deal ownership check`);
      const ownAt = checks[0]!.index!;
      const lookupAt = indexOrFail(handler, "COALESCE(seller_id, $2) AS effective_seller_id", 0, `${label} deal lookup`);
      assert.ok(lookupAt < ownAt, `${label}: ownership is checked on the deal lookup`);
      assert.equal(countOf(handler.slice(0, ownAt), "c.query("), 1, `${label}: the deal lookup is the only query before the ownership check`);
      for (const later of ["listDealPhysicalOrders(", "ExcelJS.Workbook", "text/csv"]) {
        const at = handler.indexOf(later);
        if (at >= 0) assert.ok(at > ownAt, `${label}: ${later} only after the ownership check`);
      }
    }
    const redeem = handlerFor(s.routes, FULFILLMENT_ROUTES.find((r) => r.guard === "unit")!);
    assert.equal(countOf(redeem, "if (String(unit.seller_id) !== sellerId) {"), 1, "redeem: one unit ownership check");
    assert.equal(countOf(redeem, "err.statusCode = 403;"), 1, "redeem: ownership answers 403");
    // pickup rail: every lookup and the mutation are scoped by the guarded seller
    assert.equal(countOf(s.routes, "findSellerOrderByCode(c, { sellerId: sellerContext.seller_id, digits })"), 2, "code lookups are seller-scoped");
    assert.equal(countOf(s.routes, "searchSellerPhysicalOrders(c, { sellerId: sellerContext.seller_id, query, limit: 20 })"), 1, "search is seller-scoped");
    assert.equal(countOf(s.routes, "handoffPhysicalOrder(c, {\n        sellerId: sellerContext.seller_id,"), 1, "handoff is seller-scoped");
    assert.equal(countOf(s.routes, "listDealPhysicalOrders(c, { sellerId, dealId })"), 1, "the per-deal list is seller-scoped");
    assert.equal(countOf(s.routes, "findSellerOrderByCode("), 2, "no unscoped code lookup");
    assert.equal(countOf(s.routes, "searchSellerPhysicalOrders("), 1, "no unscoped search");
    assert.equal(countOf(s.routes, "handoffPhysicalOrder("), 1, "no unscoped handoff");
    assert.equal(countOf(s.routes, "listDealPhysicalOrders("), 1, "no unscoped list");
  },
  [CHECK.REDEEM]: (s) => {
    const redeem = handlerFor(s.routes, FULFILLMENT_ROUTES.find((r) => r.guard === "unit")!);
    assertInOrder(redeem, REDEEM_ORDER, "redeem");
    assert.equal(countOf(redeem, "UPDATE siton."), 1, "redeem writes exactly one table");
    assert.equal(countOf(redeem, "FOR UPDATE"), 1, "the unit row is locked once");
  },
  [CHECK.HANDOFF]: (s) => {
    const handoff = handlerFor(s.routes, FULFILLMENT_ROUTES.find((r) => r.guard === "pickup-mutation")!);
    assertInOrder(handoff, HANDOFF_ORDER, "handoff");
    assert.equal(countOf(handoff, "reply.code("), 1, "handoff answers once, after the transaction");
    assert.doesNotMatch(handoff, /c\.query\(/, "handoff writes only through the seller-scoped rail");
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
  routes: read("seller_fulfillment_routes.ts"),
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

// No other src file wires the module or registers one of the eleven paths.
{
  const label = "no other src file registers a fulfillment path or wires the module";
  try {
    const allowed = new Set(["frontend_runtime.ts", "seller_fulfillment_routes.ts"]);
    for (const file of readdirSync(SRC).filter((f) => f.endsWith(".ts") && !allowed.has(f))) {
      const text = read(file);
      assert.ok(!text.includes("registerSellerFulfillmentRoutes"), `${file} wires the module`);
      for (const route of FULFILLMENT_ROUTES) {
        assert.doesNotMatch(text, new RegExp(`\\bapp\\.[a-z]+\\(\\s*["'\`]${escape(route.path)}["'\`]`), `${file} registers ${route.path}`);
      }
    }
    console.log(`PASS ${label}`);
  } catch (error: any) {
    failed += 1;
    console.error(`FAIL ${label}: ${error?.message || error}`);
  }
}

// Mutation controls: each mutant must be rejected by the check that guards that property.
function replaceOnce(text: string, from: string, to: string) {
  assert.equal(countOf(text, from), 1, `mutation anchor must be unique: ${from.slice(0, 80)}`);
  return text.replace(from, to);
}
// Replace an anchor inside ONE handler, even when the same text appears in other handlers.
function replaceInHandler(routes: string, route: { method: string; path: string }, from: string, to: string) {
  const handler = handlerFor(routes, route);
  return replaceOnce(routes, handler, replaceOnce(handler, from, to));
}
const route = (path: string) => FULFILLMENT_ROUTES.find((r) => r.path === path)!;
const REDEEM = route("/api/seller/fulfillment/:unitId/redeem");
const HANDOFF = route("/api/seller/fulfillment/handoff");
const VOUCHER = route("/api/seller/deals/:dealId/voucher-export");
const WIRING_CALL = `  registerSellerFulfillmentRoutes(app, {
    withTx: deps.withTx,
    resolveRequiredSellerContext,
    ensureSellerActionAllowed,
    requireUuid,
    ensureProductSurfaces,
    mockMoneyRuntime
  });
`;
const ticketHandler = "  app." + handlerFor(real.routes, route("/api/seller/deals/:dealId/ticket-export"));
const MUTANTS: Array<[string, string, () => Sources]> = [
  ["module registration deleted from the runtime", CHECK.WIRING, () => ({ ...real, runtime: replaceOnce(real.runtime, WIRING_CALL, "") })],
  ["module registered twice", CHECK.WIRING, () => ({ ...real, runtime: replaceOnce(real.runtime, WIRING_CALL, WIRING_CALL + WIRING_CALL) })],
  ["module wired after the webhook routes instead of at the original point", CHECK.WIRING, () => {
    const moved = replaceOnce(real.runtime, WIRING_CALL, "");
    return { ...real, runtime: replaceOnce(moved, '  app.post("/webhooks/payments/mock", handleWebhookPayments);\n', '  app.post("/webhooks/payments/mock", handleWebhookPayments);\n' + WIRING_CALL) };
  }],
  ["an injected dependency dropped from the wiring", CHECK.WIRING, () => ({ ...real, runtime: replaceOnce(real.runtime, "    ensureProductSurfaces,\n    mockMoneyRuntime\n  });", "    mockMoneyRuntime\n  });") })],
  ["ticket export route deleted from the module", CHECK.REGISTRATION, () => ({ ...real, routes: replaceOnce(real.routes, ticketHandler, "") })],
  ["voucher export path changed", CHECK.REGISTRATION, () => ({ ...real, routes: replaceOnce(real.routes, 'app.get("/api/seller/deals/:dealId/voucher-export"', 'app.get("/api/seller/deals/:dealId/vouchers-export"') })],
  ["redeem method changed from POST to GET", CHECK.REGISTRATION, () => ({ ...real, routes: replaceOnce(real.routes, 'app.post("/api/seller/fulfillment/:unitId/redeem"', 'app.get("/api/seller/fulfillment/:unitId/redeem"') })],
  ["ticket export left behind in the runtime as well", CHECK.REGISTRATION, () => ({ ...real, runtime: replaceOnce(real.runtime, '  app.post("/webhooks/payments"', `${ticketHandler}  app.post("/webhooks/payments"`) })],
  ["ticket export registered a second time in the module", CHECK.REGISTRATION, () => ({ ...real, routes: replaceOnce(real.routes, "\n  });\n}\n", `\n  });\n${ticketHandler}}\n`) })],
  ["two routes swapped (registration order changed)", CHECK.REGISTRATION, () => {
    const voucher = "  app." + handlerFor(real.routes, VOUCHER);
    const withoutTicket = replaceOnce(real.routes, ticketHandler, "");
    return { ...real, routes: replaceOnce(withoutTicket, voucher, ticketHandler + voucher) };
  }],
  ["seller-status guard removed from the handoff mutation", CHECK.GUARDS, () => ({ ...real, routes: replaceInHandler(real.routes, HANDOFF, '      if (!(await ensureSellerActionAllowed(c, sellerContext.seller_id, "operate", reply))) return null;\n', "") })],
  ["seller guard removed from the redeem mutation", CHECK.GUARDS, () => ({ ...real, routes: replaceInHandler(real.routes, REDEEM, "      const sellerContext = await resolveRequiredSellerContext(req, reply, c, { autoCreate: true });\n      if (!sellerContext) return reply;\n", "      const sellerContext: any = { seller_id: String(req.headers?.[\"x-seller-id\"] || \"\") };\n") })],
  ["redeem validates the unit id before the seller guard", CHECK.GUARDS, () => {
    const swapped = replaceInHandler(real.routes, REDEEM, '      requireUuid(unitId, "fulfillment_unit_id"); // after the guard: authorization precedes observation\n', "");
    return { ...real, routes: replaceInHandler(swapped, REDEEM, "    return deps.withTx(async (c) => {\n", '    return deps.withTx(async (c) => {\n      requireUuid(unitId, "fulfillment_unit_id");\n') };
  }],
  ["voucher export ownership check inverted", CHECK.OWNERSHIP, () => ({ ...real, routes: replaceInHandler(real.routes, VOUCHER, "if (String(deal.effective_seller_id) !== sellerId)", "if (String(deal.effective_seller_id) === sellerId)") })],
  ["redeem unit ownership check removed", CHECK.OWNERSHIP, () => ({ ...real, routes: replaceInHandler(real.routes, REDEEM, "if (String(unit.seller_id) !== sellerId) {", "if (false) {") })],
  ["pickup code lookup no longer scoped to the guarded seller", CHECK.OWNERSHIP, () => ({ ...real, routes: replaceInHandler(real.routes, route("/api/seller/fulfillment/resolve"), "findSellerOrderByCode(c, { sellerId: sellerContext.seller_id, digits })", "findSellerOrderByCode(c, { sellerId: String(req.query?.seller_id || \"\"), digits })") })],
  ["redeem idempotent replay moved ahead of the ownership check", CHECK.REDEEM, () => {
    const replay = '      if (String(unit.status) === "Redeemed") {\n        return {\n          ok: true,\n          idempotent: true,\n          fulfillment_unit_id: unit.fulfillment_unit_id,\n          status: "Redeemed"\n        };\n      }\n';
    const removed = replaceInHandler(real.routes, REDEEM, replay, "");
    return { ...real, routes: replaceInHandler(removed, REDEEM, "      const unit = lookup.rows[0] as any;\n", "      const unit = lookup.rows[0] as any;\n" + replay) };
  }],
  ["redeem row lock removed", CHECK.REDEEM, () => ({ ...real, routes: replaceInHandler(real.routes, REDEEM, "          FOR UPDATE`,", "`,") })],
  ["redeem update no longer guarded by status", CHECK.REDEEM, () => ({ ...real, routes: replaceInHandler(real.routes, REDEEM, "            AND status IN ('Issued','Sent')\n", "") })],
  ["handoff answers from inside the transaction", CHECK.HANDOFF, () => ({ ...real, routes: replaceInHandler(real.routes, HANDOFF, "      const outcome = await handoffPhysicalOrder(c, {", "      void reply.code(202).send({ ok: true });\n      const outcome = await handoffPhysicalOrder(c, {") })],
  ["handoff idempotency key no longer derived from the request", CHECK.HANDOFF, () => ({ ...real, routes: replaceInHandler(real.routes, HANDOFF, 'String(req.headers?.["idempotency-key"] || body.idempotency_key || `handoff:${participantId}`)', "String(Date.now())") })],
  ["module imports the runtime back", CHECK.NO_COPY, () => ({ ...real, routes: replaceOnce(real.routes, 'import type { FastifyInstance } from "fastify";', 'import type { FastifyInstance } from "fastify";\nimport { registerFrontendExperience } from "./frontend_runtime.js";') })],
  ["module re-implements the seller guard", CHECK.NO_COPY, () => ({ ...real, routes: replaceOnce(real.routes, "export function registerSellerFulfillmentRoutes(", "async function resolveRequiredSellerContext(req: any) { return { seller_id: req.headers.seller }; }\nexport function registerSellerFulfillmentRoutes(") })],
  ["module copies mockMoneyRuntime instead of receiving it", CHECK.NO_COPY, () => ({ ...real, routes: replaceOnce(real.routes, "  function pickupCodeNotFound(reply: any) {", "  function mockMoneyRuntime() { return true; }\n  function pickupCodeNotFound(reply: any) {") })]
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
  process.env.SELLER_SESSION_SECRET = process.env.SELLER_SESSION_SECRET || "seller-session-secret-fulfillment-extraction";
  process.env.ADMIN_API_KEY = process.env.ADMIN_API_KEY || "fulfillment-extraction-admin-key";
  process.env.ADMIN_SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || "admin-session-secret-fulfillment-extraction";
  const appModule: any = await import("../src/app.js");
  try {
    await appModule.app.ready();
    const registry: Array<{ method: string; url: string }> | undefined = appModule.ROUTE_REGISTRY;
    assert.ok(Array.isArray(registry) && registry.length > 150, "src/app.ts exports the onRoute ROUTE_REGISTRY");
    const entries = registry!.filter((r) => r.method !== "HEAD").map((r) => `${r.method} ${r.url}`);
    const expected = FULFILLMENT_ROUTES.map((r) => `${r.method.toUpperCase()} ${r.path}`);
    for (const entry of expected) assert.equal(entries.filter((e) => e === entry).length, 1, `registered once: ${entry}`);
    const first = entries.indexOf(expected[0]!);
    assert.ok(first > 0, "the first fulfillment route is registered");
    assert.deepEqual(entries.slice(first, first + expected.length), expected, "contiguous, in the original order");
    assert.equal(entries[first - 1], "GET /api/seller/deals/:id", "preceded by the seller deal detail route");
    assert.equal(entries[first + expected.length], "POST /webhooks/payments", "followed by the payment webhook route");
    for (const r of FULFILLMENT_ROUTES.filter((x) => x.method === "get")) {
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
  console.error(`seller_fulfillment_routes_extraction_validation failed=${failed}`);
  process.exit(1);
}
console.log("PASS seller_fulfillment_routes_extraction_validation");
process.exit(0);
