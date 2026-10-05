// LEAN REFACTOR — structural proof for the admin ops overview route
// extraction. The three read-only admin console routes
//   GET /api/admin/payment-ops-status
//   GET /api/admin/overview
//   GET /api/admin/launch-console
// moved verbatim from src/frontend_runtime.ts into
// src/admin_ops_overview_routes.ts. This test pins the shape of that move so a
// later edit cannot silently register a route twice, drop one, leave one behind
// in the runtime, move them in the registration order, weaken or reorder the
// admin read guard or the schema checks, copy a guard, schema check, projection
// or money helper into the module instead of using the runtime's injected
// closures, construct or call a provider, turn a read into a write, change the
// response sections, or change the money semantics the reads report
// (fee-ledger sums, successful-money settlement, the canonical fee helpers).
// The checks run against the real sources and then against mutated copies,
// which must each be rejected by the check that guards that property. The
// behaviour (status codes, figures from the same sources, scoping, read-only)
// is proved through the real app by tests/admin_ops_overview_read_validation.ts;
// the live block below pins the registry position and the response sections.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(process.cwd(), "src");
const read = (file: string) => readFileSync(join(SRC, file), "utf8");
const MODULE = "admin_ops_overview_routes.ts";
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
  "admin_growth_routes.ts",
  "admin_demo_readiness_routes.ts"
];

const ROUTES = ["/api/admin/payment-ops-status", "/api/admin/overview", "/api/admin/launch-console"] as const;
const GUARD = "    if (!(await requireAdminRead(req, reply))) return;";
// Each handler's opening, verbatim: the guard, then its validation and schema checks, then the one transaction.
const OPENINGS: Record<(typeof ROUTES)[number], string[]> = {
  "/api/admin/payment-ops-status": [GUARD, "    await ensurePaymentOpsTables();", "    return deps.withTx(async (c) => {"],
  "/api/admin/overview": [GUARD, '    const q = String(req.query?.q || "").trim().slice(0, 200);', "    await ensureProductSurfaces();", "    return deps.withTx(async (c) => {"],
  "/api/admin/launch-console": [GUARD, "    await ensureProductSurfaces();", "    await ensureNotificationTables();", "    await ensureLegalAcceptanceTables();", "    return deps.withTx(async (c) => {"]
};
const INJECTED_DEPS = [
  "withTx: deps.withTx",
  "requireAdminRead",
  "ensurePaymentOpsTables",
  "ensureProductSurfaces",
  "ensureNotificationTables",
  "ensureLegalAcceptanceTables",
  "mapDealListRow",
  "paymentProvider: deps.paymentProvider",
  "notificationSummary: deps.notificationSummary"
];
const DESTRUCTURED = ["requireAdminRead", "ensurePaymentOpsTables", "ensureProductSurfaces", "ensureNotificationTables", "ensureLegalAcceptanceTables", "mapDealListRow"];
// The injected closures stay defined once, in the runtime.
const RUNTIME_DEFINITIONS = [
  "  async function requireAdminRead(req: any, reply: any): Promise<boolean> {",
  "  const ensurePaymentOpsTables = memoizeSchemaCheck(",
  "  const ensureProductSurfaces = memoizeSchemaCheck(",
  "  const ensureNotificationTables = memoizeSchemaCheck(",
  "  const ensureLegalAcceptanceTables = memoizeSchemaCheck(",
  "function mapDealListRow(row: DealListRow) {",
  "export type DealListRow = {"
];
const PRECEDING_ROUTE = '  app.post("/webhooks/invoices", handleWebhookInvoices);';
const FOLLOWING_WIRING = "  registerAdminMissionControlRoutes(app, {";
const ALLOWED_IMPORTS = [
  'import type { FastifyInstance } from "fastify";',
  'import { getPaymentProviderSummary, type PaymentProvider } from "./payment_provider.js";',
  'import { computeCustomerChargeVat } from "./vat_authority.js";',
  'import { SITON_PLATFORM_FEE_RATE } from "./platform_fee_money.js";',
  'import { DEFAULT_SELLER_ID, summarizeMoney } from "./product_surface_support.js";',
  // type-only: erased from the compiled module, so the runtime is never imported at run time
  'import type { DealListRow } from "./frontend_runtime.js";'
];
// Response sections, in order, and the keys of each section.
const SHAPES: Array<{ route: (typeof ROUTES)[number]; open: string; indent: string; keys: string[] }> = [
  { route: "/api/admin/payment-ops-status", open: "      return {\n", indent: "        ", keys: ["ok", "provider", "attempts_by_type", "webhook_reconciliation", "webhook_security", "buyer_payment_methods", "fee_ledger", "recent_attempts", "recent_ledger"] },
  { route: "/api/admin/payment-ops-status", open: "        webhook_reconciliation: {\n", indent: "          ", keys: ["processed", "ignored", "failed", "processing", "pending", "duplicate_rate"] },
  { route: "/api/admin/payment-ops-status", open: "        webhook_security: {\n", indent: "          ", keys: ["signature_failures", "latest_signature_failure_at"] },
  { route: "/api/admin/payment-ops-status", open: "        buyer_payment_methods: {\n", indent: "          ", keys: ["active", "invalid", "expired", "revoked", "hosted_payment_only"] },
  { route: "/api/admin/payment-ops-status", open: "        fee_ledger: {\n", indent: "          ", keys: ["gross_charged", "fee_base", "fee_vat", "fee_total", "entries", "refund_entries", "note"] },
  { route: "/api/admin/overview", open: "      return {\n", indent: "        ", keys: ["ok", "q", "admin_surface"] },
  { route: "/api/admin/overview", open: "        admin_surface: {\n", indent: "          ", keys: ["totals", "deals", "exceptional_deals", "search_results", "kyc_queue", "settlements", "support_tickets", "forensics"] },
  { route: "/api/admin/overview", open: "          totals: {\n", indent: "            ", keys: ["deals", "live", "exceptional", "draft"] },
  { route: "/api/admin/overview", open: "            seller_workspace: {\n", indent: "              ", keys: ["completed_deals", "gross_amount", "platform_fee_amount"] },
  { route: "/api/admin/launch-console", open: "      return {\n", indent: "        ", keys: ["ok", "generated_at", "system", "sellers", "deals", "launch_readiness", "notifications", "legal", "recent_deals", "recent_warnings"] },
  { route: "/api/admin/launch-console", open: "        system: {\n", indent: "          ", keys: ["status", "warnings"] },
  { route: "/api/admin/launch-console", open: "        sellers: {\n", indent: "          ", keys: ["total", "publish_ready", "incomplete_profile"] },
  { route: "/api/admin/launch-console", open: "        deals: {\n", indent: "          ", keys: ["total", "draft", "pending_target", "target_reached", "completed", "failed", "cancelled"] },
  { route: "/api/admin/launch-console", open: "        launch_readiness: {\n", indent: "          ", keys: ["deals_missing_images", "deals_missing_seller_profile", "deals_missing_legal_acceptance", "completed_deals_with_excel_available"] },
  { route: "/api/admin/launch-console", open: "        notifications: {\n", indent: "          ", keys: ["pending", "sent", "failed", "provider", "mode", "external_delivery"] },
  { route: "/api/admin/launch-console", open: "        legal: {\n", indent: "          ", keys: ["seller_publish_acceptances", "buyer_join_acceptances", "buyer_payment_disclosures"] }
];
const FEE_NOTE = 'note: "Siton fee = 8% of the authoritative charge base (incl. delivery, excl. VAT), from successful charges only"';
// The money the reads report, pinned exactly: what is summed, filtered and passed through the canonical helpers.
const MONEY_PINS: Array<[(typeof ROUTES)[number], string]> = [
  ["/api/admin/payment-ops-status", "provider: getPaymentProviderSummary(deps.paymentProvider),"],
  ["/api/admin/payment-ops-status", "COALESCE(SUM(gross_amount) FILTER (WHERE logical_entry_type='charge'),0)::numeric(14,2) AS gross_charged,"],
  ["/api/admin/payment-ops-status", "COALESCE(SUM(platform_fee_base_amount),0)::numeric(14,2) AS fee_base,"],
  ["/api/admin/payment-ops-status", "COALESCE(SUM(platform_fee_vat_amount),0)::numeric(14,2) AS fee_vat,"],
  ["/api/admin/payment-ops-status", "COALESCE(SUM(platform_fee_total_amount),0)::numeric(14,2) AS fee_total,"],
  ["/api/admin/payment-ops-status", "COUNT(*) FILTER (WHERE event_type='refund_issued')::int AS refund_entries"],
  ["/api/admin/payment-ops-status", "FROM siton.platform_fee_money_events`"],
  ["/api/admin/payment-ops-status", FEE_NOTE],
  ["/api/admin/payment-ops-status", "hosted_payment_only: true"],
  ["/api/admin/overview", "${SITON_PLATFORM_FEE_RATE}::numeric AS platform_fee_rate,"],
  ["/api/admin/overview", "COALESCE(SUM(p.qty) FILTER (WHERE p.money_state IN ('ChargedSuccess','RecoveredCharge')),0) AS settled_units,"],
  ["/api/admin/overview", "COALESCE(SUM(p.delivery_cost) FILTER (WHERE p.money_state IN ('ChargedSuccess','RecoveredCharge')),0) AS settled_delivery_cost,"],
  ["/api/admin/overview", 'const completedDeals = rows.filter((row) => row.state === "Completed");'],
  ["/api/admin/overview", "(sum, row) => sum + Number(row.price_per_unit || 0) * Number((row as any).settled_units || 0),"],
  ["/api/admin/overview", "(sum, row) => sum + Number((row as any).settled_delivery_cost || 0),"],
  ["/api/admin/overview", "const sellerSettlementGross = sellerSettlementProductGross + sellerSettlementDeliveryGross;"],
  ["/api/admin/overview", "const sellerSettlementVat = computeCustomerChargeVat({\n        productGrossAmount: sellerSettlementProductGross,\n        deliveryGrossAmount: sellerSettlementDeliveryGross\n      });"],
  ["/api/admin/overview", "platform_fee_amount: summarizeMoney({\n                grossAmount: sellerSettlementGross,\n                vatAmount: sellerSettlementVat.vat_amount\n              }).siton_fee_amount"]
];
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Never a vacuous position: a missing anchor throws instead of yielding -1.
function indexOrFail(text: string, needle: string, from: number, label: string) {
  const at = text.indexOf(needle, from);
  assert.ok(at >= 0, `${label}: missing ${needle.slice(0, 80)}`);
  return at;
}

type Sources = { runtime: string; routes: string; others: Record<string, string> };

function handlerOf(routes: string, route: string) {
  const start = indexOrFail(routes, `  app.get("${route}", async (req: any, reply: any) => {\n`, 0, `handler ${route}`);
  return routes.slice(start, indexOrFail(routes, "\n  });\n", start, `handler end ${route}`) + "\n  });\n".length);
}

// Keys of an object literal at a given indentation, between an opening and its closing line.
function literalKeys(text: string, open: string, indent: string) {
  const start = indexOrFail(text, open, 0, `literal ${open.trim()}`);
  const close = indexOrFail(text, `\n${indent.slice(2)}}`, start, `literal end ${open.trim()}`);
  // a key is "name:" or a shorthand "name," / "name" at the section's indentation
  return [...text.slice(start + open.length, close).matchAll(new RegExp(`^${indent}([a-z0-9_]+)(?::|,?$)`, "gm"))].map((m) => m[1]);
}

const CHECK = {
  REGISTRATION: "the three routes are registered exactly once each, as GET, in src/admin_ops_overview_routes.ts, and nothing else is",
  WIRING: "src/frontend_runtime.ts keeps none of the handlers and wires the module exactly once, at the original point, injecting exactly its closures",
  NO_COPY: "the module copies no guard, schema check, projection or money helper, constructs and calls no provider, and imports the runtime for a type only",
  GUARDS: "each handler opens with the admin read guard, then its own validation and schema checks, in order, before its transaction",
  READ_ONLY: "each handler stays a read: one transaction, no write or DDL SQL, no mutation guard, no outbox, case or audit write",
  SHAPE: "each response keeps its sections, in order, and each section's keys",
  MONEY: "the money the reads report keeps its exact sources: fee-ledger sums, successful-money settlement and the canonical fee helpers"
} as const;

const CHECKS: Record<string, (s: Sources) => void> = {
  [CHECK.REGISTRATION]: (s) => {
    const files: Array<[string, string]> = [["frontend_runtime.ts", s.runtime], [MODULE, s.routes], ...Object.entries(s.others)];
    for (const route of ROUTES) {
      const pattern = new RegExp(`\\bapp\\.(get|post|put|patch|delete|options|head|all|route)\\(\\s*["'\`]${escape(route)}["'\`]`, "g");
      const registrations = files.flatMap(([file, text]) => [...text.matchAll(pattern)].map((m) => `${file} ${m[1]}`)).sort();
      assert.deepEqual(registrations, [`${MODULE} get`], route);
    }
    const all = [...s.routes.matchAll(/\bapp\.(get|post|put|patch|delete|options|head|all|route)\(\s*["'`]([^"'`]+)["'`]/g)].map((m) => `${m[1]} ${m[2]}`);
    assert.deepEqual(all, ROUTES.map((route) => `get ${route}`), "the module registers exactly the three routes, as GET, in their original order");
  },
  [CHECK.WIRING]: (s) => {
    for (const route of ROUTES) assert.ok(!s.runtime.includes(route), `no route text stays in the runtime: ${route}`);
    assert.match(s.runtime, /^import \{ registerAdminOpsOverviewRoutes \} from "\.\/admin_ops_overview_routes\.js";$/m);
    assert.equal((s.runtime.match(/registerAdminOpsOverviewRoutes\(/g) || []).length, 1, "exactly one wiring call");
    const wiringAt = indexOrFail(s.runtime, "\n  registerAdminOpsOverviewRoutes(app, {", 0, "wiring");
    const before = indexOrFail(s.runtime, PRECEDING_ROUTE, 0, "preceding route");
    const after = indexOrFail(s.runtime, FOLLOWING_WIRING, 0, "following registration");
    assert.ok(before < wiringAt && wiringAt < after, "wired where the routes were: after POST /webhooks/invoices, before the Mission Control wiring");
    const registers = /\n  app\.(get|post|put|patch|delete|options|head|all|route)\(|\n  register\w+Routes\(/;
    assert.doesNotMatch(s.runtime.slice(before + PRECEDING_ROUTE.length, wiringAt), registers, "nothing registers between POST /webhooks/invoices and the wiring call");
    const blockEnd = indexOrFail(s.runtime, "\n  });\n", wiringAt + 1, "wiring block end");
    assert.doesNotMatch(s.runtime.slice(blockEnd, after), registers, "nothing registers between the wiring call and the Mission Control wiring");
    const block = s.runtime.slice(wiringAt, blockEnd);
    const injectedKeys = [...block.matchAll(/^\s+([A-Za-z_]+)(?::|,|$)/gm)].map((m) => m[1]);
    assert.deepEqual(injectedKeys.sort(), INJECTED_DEPS.map((dep) => dep.split(":")[0]).sort(), "no extra and no missing dependency");
    for (const dep of INJECTED_DEPS) assert.match(block, new RegExp(`^\\s+${escape(dep)},?$`, "m"), `injected: ${dep}`);
    for (const definition of RUNTIME_DEFINITIONS) {
      assert.equal(s.runtime.split(`\n${definition}`).length - 1, 1, `defined once in the runtime: ${definition}`);
    }
  },
  [CHECK.NO_COPY]: (s) => {
    const imports = s.routes.split("\n").filter((line) => /^import /.test(line));
    assert.deepEqual(imports, ALLOWED_IMPORTS, "imports are exactly the type, the provider summary, the VAT authority, the fee constant, the money summary and the deal-row type");
    assert.doesNotMatch(s.routes, /^import \{[^}]*\} from "\.\/frontend_runtime(\.js)?";$/m, "no value import of the runtime");
    assert.doesNotMatch(s.routes, /\bimport\([^)]*\)|\brequire\(/, "no dynamic import");
    assert.doesNotMatch(
      s.routes,
      /function (requireAdminRead|requireAdminKey|requireAdminMutation|memoizeSchemaCheck|ensure\w+|mapDealListRow|deriveDealAvailability|computeCustomerChargeVat|summarizeMoney|getPaymentProviderSummary|calculatePlatformFeeMoney)\b/,
      "guards, schema checks, projections and money helpers are injected or imported, not re-implemented"
    );
    assert.doesNotMatch(s.routes, /\b(const|let|var)\s+(requireAdminRead|ensure\w+|mapDealListRow|paymentProvider|computeCustomerChargeVat|summarizeMoney)\s*=/, "no local copy of an injected closure or helper");
    assert.doesNotMatch(s.routes, /process\.env|ADMIN_API_KEY|x-admin-key|timingSafeEqual/, "no auth or configuration logic of its own");
    assert.doesNotMatch(s.routes, /build(Payment|Payout)Provider|create\w*Provider|new \w*Provider/, "no provider is constructed");
    assert.doesNotMatch(s.routes, /\.(authorize|capture|refund|charge|void|sale|execute|transfer|payout|send|issue|dispatch)(\?\.)?\(/, "no provider, money or delivery action is called (plain or optional call)");
    assert.equal((s.routes.match(/getPaymentProviderSummary\(/g) || []).length, 1, "the payment provider is only summarised, once");
    assert.match(s.routes, /^export function registerAdminOpsOverviewRoutes\(app: FastifyInstance, deps: AdminOpsOverviewRouteDeps\) \{$/m);
    const registerAt = indexOrFail(s.routes, "export function registerAdminOpsOverviewRoutes(", 0, "register");
    const destructured = s.routes.slice(indexOrFail(s.routes, "const {", registerAt, "destructure"), indexOrFail(s.routes, "} = deps;", registerAt, "destructure end"));
    assert.deepEqual([...destructured.matchAll(/^\s+([A-Za-z_]+),?$/gm)].map((m) => m[1]), DESTRUCTURED, "destructured from deps");
  },
  [CHECK.GUARDS]: (s) => {
    assert.equal((s.routes.match(/await requireAdminRead\(req, reply\)/g) || []).length, ROUTES.length, "one admin read guard per route");
    for (const route of ROUTES) {
      const opening = OPENINGS[route];
      assert.deepEqual(handlerOf(s.routes, route).split("\n").slice(1, 1 + opening.length), opening, `${route}: guard first, then validation and schema checks, then the transaction`);
    }
  },
  [CHECK.READ_ONLY]: (s) => {
    assert.doesNotMatch(s.routes, /requireAdminMutation|requireAdminAuthContext|requireAdminPermission/, "no mutation guard");
    assert.doesNotMatch(s.routes, /\b(INSERT\s+INTO|UPDATE\s+siton\.|DELETE\s+FROM|TRUNCATE|ALTER\s+TABLE|CREATE\s+TABLE|DROP\s+TABLE|FOR\s+UPDATE)\b/i, "no write, lock or DDL SQL");
    assert.doesNotMatch(s.routes, /enqueue\w*\(|recordOperationalCaseEvent|appendAuditLog|insertAudit|outbox_events/, "no outbox, case or audit write");
    for (const route of ROUTES) assert.equal((handlerOf(s.routes, route).match(/deps\.withTx\(/g) || []).length, 1, `${route}: one transaction per request`);
  },
  [CHECK.SHAPE]: (s) => {
    for (const shape of SHAPES) {
      assert.deepEqual(literalKeys(handlerOf(s.routes, shape.route), shape.open, shape.indent), shape.keys, `${shape.route} ${shape.open.trim()} keys, in order`);
    }
  },
  [CHECK.MONEY]: (s) => {
    for (const [route, pin] of MONEY_PINS) {
      const handler = handlerOf(s.routes, route);
      assert.equal(handler.split(pin).length - 1, 1, `${route}: ${pin.split("\n")[0]}`);
    }
    assert.doesNotMatch(s.routes, /\b0?\.0[0-9]\b|\b8\s*\/\s*100\b|\bfee_rate\s*[:=]/, "no hard-coded fee rate");
    assert.equal((s.routes.match(/SITON_PLATFORM_FEE_RATE/g) || []).length, 2, "the fee rate comes from the one constant (import + use)");
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
  routes: read(MODULE),
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

function replaceOnce(text: string, from: string, to: string) {
  assert.equal(text.split(from).length - 1, 1, `mutation anchor must be unique: ${from.slice(0, 80)}`);
  return text.replace(from, to);
}
const [PAYMENT_OPS, OVERVIEW, LAUNCH] = ROUTES;
const open = (route: string) => `  app.get("${route}", async (req: any, reply: any) => {\n`;
const paymentOps = handlerOf(real.routes, PAYMENT_OPS);
const launch = handlerOf(real.routes, LAUNCH);
const wiringStart = indexOrFail(real.runtime, "  registerAdminOpsOverviewRoutes(app, {", 0, "wiring");
const wiring = real.runtime.slice(wiringStart, indexOrFail(real.runtime, "\n  });\n", wiringStart, "wiring end") + "\n  });\n".length);
const MUTANTS: Array<[string, string, () => Sources]> = [
  // guards and schema checks
  ["payment-ops-status guard removed", CHECK.GUARDS, () => ({ ...real, routes: replaceOnce(real.routes, `${open(PAYMENT_OPS)}${GUARD}\n`, open(PAYMENT_OPS)) })],
  ["launch-console guard moved behind the schema checks", CHECK.GUARDS, () => ({ ...real, routes: replaceOnce(real.routes, `${open(LAUNCH)}${GUARD}\n    await ensureProductSurfaces();\n`, `${open(LAUNCH)}    await ensureProductSurfaces();\n${GUARD}\n`) })],
  ["overview schema check dropped", CHECK.GUARDS, () => ({ ...real, routes: replaceOnce(real.routes, '.slice(0, 200);\n    await ensureProductSurfaces();\n', '.slice(0, 200);\n') })],
  ["overview query no longer trimmed", CHECK.GUARDS, () => ({ ...real, routes: replaceOnce(real.routes, 'const q = String(req.query?.q || "").trim().slice(0, 200);', 'const q = String(req.query?.q || "").slice(0, 200);') })],
  // registration
  ["a route registered a second time in the module", CHECK.REGISTRATION, () => ({ ...real, routes: replaceOnce(real.routes, launch, launch + launch) })],
  ["a route left behind in the runtime as well", CHECK.REGISTRATION, () => ({ ...real, runtime: replaceOnce(real.runtime, FOLLOWING_WIRING, `${paymentOps}${FOLLOWING_WIRING}`) })],
  ["a route dropped (omission)", CHECK.REGISTRATION, () => ({ ...real, routes: replaceOnce(real.routes, paymentOps, "") })],
  ["a route turned into a POST", CHECK.REGISTRATION, () => ({ ...real, routes: replaceOnce(real.routes, `  app.get("${OVERVIEW}",`, `  app.post("${OVERVIEW}",`) })],
  // wiring and order
  ["module wired twice", CHECK.WIRING, () => ({ ...real, runtime: replaceOnce(real.runtime, wiring, wiring + wiring) })],
  ["module wired after the Mission Control wiring (registration order changes)", CHECK.WIRING, () => {
    const moved = replaceOnce(real.runtime, wiring, "");
    return { ...real, runtime: replaceOnce(moved, '  app.get("/api/admin/actions"', `${wiring}  app.get("/api/admin/actions"`) };
  }],
  ["module wired before POST /webhooks/invoices (registration order changes)", CHECK.WIRING, () => {
    const moved = replaceOnce(real.runtime, wiring, "");
    return { ...real, runtime: replaceOnce(moved, PRECEDING_ROUTE, `${wiring}${PRECEDING_ROUTE}`) };
  }],
  ["preceding route anchor renamed (a -1 position must fail, not pass)", CHECK.WIRING, () => ({ ...real, runtime: replaceOnce(real.runtime, PRECEDING_ROUTE, '  app.post("/webhooks/invoice", handleWebhookInvoices);') })],
  ["following wiring anchor renamed (a -1 position must fail, not pass)", CHECK.WIRING, () => ({ ...real, runtime: replaceOnce(real.runtime, FOLLOWING_WIRING, "  registerAdminMissionCtrlRoutes(app, {") })],
  ["an extra dependency injected", CHECK.WIRING, () => ({ ...real, runtime: replaceOnce(real.runtime, "    requireAdminRead,\n    ensurePaymentOpsTables,\n", "    requireAdminRead,\n    requireAdminKey,\n    ensurePaymentOpsTables,\n") })],
  ["the deal-list projection dropped from the wiring", CHECK.WIRING, () => ({ ...real, runtime: replaceOnce(real.runtime, "    ensureLegalAcceptanceTables,\n    mapDealListRow,\n    paymentProvider: deps.paymentProvider,", "    ensureLegalAcceptanceTables,\n    paymentProvider: deps.paymentProvider,") })],
  ["the notification summary replaced by a constant in the wiring", CHECK.WIRING, () => ({ ...real, runtime: replaceOnce(real.runtime, "    notificationSummary: deps.notificationSummary\n  });", '    notificationSummary: { provider: "internal", mode: "internal", external_delivery: false }\n  });') })],
  // copies
  ["module re-implements the deal-list projection", CHECK.NO_COPY, () => ({ ...real, routes: replaceOnce(real.routes, "export function registerAdminOpsOverviewRoutes(", "function mapDealListRow(row: DealListRow) { return row; }\nexport function registerAdminOpsOverviewRoutes(") })],
  ["module imports the runtime as a value", CHECK.NO_COPY, () => ({ ...real, routes: replaceOnce(real.routes, 'import type { DealListRow } from "./frontend_runtime.js";', 'import type { DealListRow } from "./frontend_runtime.js";\nimport { registerFrontendExperience } from "./frontend_runtime.js";') })],
  ["module constructs its own payment provider", CHECK.NO_COPY, () => ({ ...real, routes: replaceOnce(real.routes, 'import { getPaymentProviderSummary, type PaymentProvider } from "./payment_provider.js";', 'import { buildPaymentProvider, getPaymentProviderSummary, type PaymentProvider } from "./payment_provider.js";') })],
  ["module calls a provider money action", CHECK.NO_COPY, () => ({ ...real, routes: replaceOnce(real.routes, "    await ensurePaymentOpsTables();\n", "    await ensurePaymentOpsTables();\n    await (deps.paymentProvider as any).refund?.({ amount: 0 });\n") })],
  ["module reads its own configuration", CHECK.NO_COPY, () => ({ ...real, routes: replaceOnce(real.routes, "        hosted_payment_only: true\n", "        hosted_payment_only: process.env.HOSTED_ONLY !== \"0\"\n") })],
  // read-only
  ["a handler turned into a write", CHECK.READ_ONLY, () => ({ ...real, routes: replaceOnce(real.routes, "`SELECT COUNT(*) AS signature_failures, MAX(created_at) AS latest_signature_failure_at FROM siton.payment_webhook_security_events`", "`DELETE FROM siton.payment_webhook_security_events RETURNING 0 AS signature_failures, NULL AS latest_signature_failure_at`") })],
  ["a handler split over two transactions", CHECK.READ_ONLY, () => ({ ...real, routes: replaceOnce(real.routes, "      const sellers = sellerCounts.rows[0] || {};\n", "      await deps.withTx(async () => undefined);\n      const sellers = sellerCounts.rows[0] || {};\n") })],
  // shape
  ["a payment-ops section dropped", CHECK.SHAPE, () => ({ ...real, routes: replaceOnce(real.routes, "        webhook_security: {\n          signature_failures: Number(securityRow.signature_failures ?? 0),\n          latest_signature_failure_at: securityRow.latest_signature_failure_at ?? null\n        },\n", "") })],
  ["an overview section renamed", CHECK.SHAPE, () => ({ ...real, routes: replaceOnce(real.routes, "          kyc_queue: kycQueue.rows,\n", "          verification_queue: kycQueue.rows,\n") })],
  ["launch-console sections reordered", CHECK.SHAPE, () => ({ ...real, routes: replaceOnce(real.routes, "        generated_at: new Date().toISOString(),\n        system: {\n", "        system: {\n") .replace("        recent_warnings: warnings.slice(0, 10)\n", "        recent_warnings: warnings.slice(0, 10),\n        generated_at: new Date().toISOString()\n") })],
  // money
  ["settlement counts joined (unpaid) units", CHECK.MONEY, () => ({ ...real, routes: replaceOnce(real.routes, "COALESCE(SUM(p.qty) FILTER (WHERE p.money_state IN ('ChargedSuccess','RecoveredCharge')),0) AS settled_units,", "COALESCE(SUM(p.qty),0) AS settled_units,") })],
  ["fee-ledger gross counts refunds too", CHECK.MONEY, () => ({ ...real, routes: replaceOnce(real.routes, "COALESCE(SUM(gross_amount) FILTER (WHERE logical_entry_type='charge'),0)::numeric(14,2) AS gross_charged,", "COALESCE(SUM(gross_amount),0)::numeric(14,2) AS gross_charged,") })],
  ["settlement fee bypasses the canonical money summary", CHECK.MONEY, () => ({ ...real, routes: replaceOnce(real.routes, "              platform_fee_amount: summarizeMoney({\n                grossAmount: sellerSettlementGross,\n                vatAmount: sellerSettlementVat.vat_amount\n              }).siton_fee_amount\n", "              platform_fee_amount: sellerSettlementGross * 0.08\n") })],
  ["settlement VAT drops the delivery portion", CHECK.MONEY, () => ({ ...real, routes: replaceOnce(real.routes, "        deliveryGrossAmount: sellerSettlementDeliveryGross\n", "        deliveryGrossAmount: 0\n") })],
  ["deal fee rate hard-coded instead of the constant", CHECK.MONEY, () => ({ ...real, routes: replaceOnce(real.routes, "${SITON_PLATFORM_FEE_RATE}::numeric AS platform_fee_rate,", "0.08::numeric AS platform_fee_rate,") })],
  ["fee-ledger note rewritten", CHECK.MONEY, () => ({ ...real, routes: replaceOnce(real.routes, FEE_NOTE, 'note: "Siton fee = 8% of every charge"') })]
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
  const caught = failures(mutant);
  if (baselineClean && caught.some((f) => f.startsWith(`${expectedCheck}:`))) {
    console.log(`PASS mutant rejected: ${label}`);
  } else {
    failed += 1;
    console.error(`FAIL mutant survived its intended check (${expectedCheck}): ${label}${caught.length ? ` [caught only by: ${caught.map((f) => f.split(":")[0]).join("; ")}]` : ""}`);
  }
}
console.log(`MUTANTS ${MUTANTS.length}`);

// Live: the real app's registry position and the response sections.
{
  const label = "the live registry lists the three routes once each, in order, between their original neighbours, and each response keeps its sections";
  process.env.DISABLE_OUTBOX_WORKER = "1";
  process.env.ADMIN_API_KEY = process.env.ADMIN_API_KEY || "ops-overview-extraction-admin-key";
  process.env.SELLER_SESSION_SECRET = process.env.SELLER_SESSION_SECRET || "seller-session-secret-ops-overview-extraction";
  process.env.ADMIN_SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || "admin-session-secret-ops-overview-extraction";
  const appModule: any = await import("../src/app.js");
  try {
    await appModule.app.ready();
    const registry: Array<{ method: string; url: string }> | undefined = appModule.ROUTE_REGISTRY;
    assert.ok(Array.isArray(registry) && registry.length > 150, "src/app.ts exports the onRoute ROUTE_REGISTRY");
    const entries = registry!.filter((r) => r.method !== "HEAD").map((r) => `${r.method} ${r.url}`);
    for (const route of ROUTES) {
      assert.equal(entries.filter((e) => e === `GET ${route}`).length, 1, `registered once: ${route}`);
      assert.equal(registry!.filter((e) => e.method === "HEAD" && e.url === route).length, 1, `HEAD twin once: ${route}`);
    }
    const at = entries.indexOf(`GET ${PAYMENT_OPS}`);
    assert.ok(at > 0, "the routes are registered");
    assert.deepEqual(entries.slice(at - 1, at + 4), ["POST /webhooks/invoices", ...ROUTES.map((route) => `GET ${route}`), "GET /api/admin/mission-control"], "between POST /webhooks/invoices and Mission Control, in order");

    const top = Object.fromEntries(SHAPES.filter((shape) => shape.open === "      return {\n").map((shape) => [shape.route, shape.keys]));
    for (const route of ROUTES) {
      const denied: any = await appModule.app.inject({ method: "GET", url: route });
      assert.equal(denied.statusCode, 401, `${route}: no credentials, denied`);
      const res: any = await appModule.app.inject({ method: "GET", url: route, headers: { "x-admin-key": process.env.ADMIN_API_KEY } });
      assert.equal(res.statusCode, 200, `${route}: ${res.body}`);
      assert.deepEqual(Object.keys(res.json()), top[route], `${route}: top-level sections, in order`);
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
  console.error(`admin_ops_overview_routes_extraction_validation failed=${failed}`);
  process.exit(1);
}
console.log("PASS admin_ops_overview_routes_extraction_validation");
process.exit(0);
