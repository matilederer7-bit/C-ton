// LEAN REFACTOR — structural proof for the admin demo-readiness route
// extraction. GET /api/admin/demo-readiness (the Demo Readiness Command
// Center) moved verbatim from src/frontend_runtime.ts into
// src/admin_demo_readiness_routes.ts, together with its registration-time
// timestamp. This test pins the shape of that move so a later edit cannot
// silently register the route twice, drop it, leave it behind in the runtime,
// move it in the registration order, weaken or reorder the admin read guard,
// copy the deploy-freshness / provider / launch-flag logic into the module
// instead of using the runtime's injected readers, construct or call a
// provider, change the response sections, or turn the timestamp into a
// per-request value. The checks run against the real sources and then against
// mutated copies, which must each be rejected by the check that guards that
// property. The live behaviour (freshness verdicts, provider fields, product
// contract, no state mutation) stays covered by
// tests/demo_readiness_validation.ts; the live block below pins the registry
// position and the exact response sections.
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
  "admin_growth_routes.ts",
  "admin_ops_overview_routes.ts"
];

const ROUTE = { method: "get", path: "/api/admin/demo-readiness" } as const;
const GUARD = "    if (!(await requireAdminRead(req, reply))) return;";
// The handler's opening, verbatim: the guard, then the injected freshness reader.
const OPENING = [
  GUARD,
  "",
  "    const freshness = deployFreshness();",
  "    const runtimeCommit = freshness.runtime_commit_sha;",
  '    const expectedCommit = freshness.expected_commit_sha || "";'
];
const TIMESTAMP = "  const _demoReadinessStartedAt = new Date().toISOString();";
const INJECTED_DEPS = [
  "withTx: deps.withTx",
  "requireAdminRead",
  "deployFreshness",
  "paymentProvider: deps.paymentProvider",
  "payoutProvider",
  "isDemoPreview: deps.isDemoPreview",
  "invoiceSummary: deps.invoiceSummary",
  "notificationSummary: deps.notificationSummary",
  "isPublicMallEnabled"
];
// Response sections, in order, and the keys of each section.
const TOP_LEVEL_KEYS = ["ok", "verdict", "environment", "deploy_freshness", "database", "providers", "queues", "demo_data", "product_contract", "blockers", "warnings", "checked_at"];
const SECTION_KEYS: Record<string, string[]> = {
  environment: ["node_env", "app_env", "demo_preview", "commit_sha", "build_time", "runtime_started_at"],
  deploy_freshness: ["expected_commit_sha", "runtime_commit_sha", "is_stale", "evidence"],
  database: ["ok", "schema_ready", "migrations_visible", "required_tables_present", "missing_tables"],
  providers: ["payment", "invoice", "payout", "notifications"],
  queues: ["outbox_pending", "outbox_processing", "outbox_failed", "dlq_count", "oldest_pending_age_seconds"],
  demo_data: ["has_demo_seller", "has_public_deal", "has_joinable_deal", "has_completed_deal", "has_failed_deal"],
  product_contract: ["direct_links_first_class", "public_mall_discovery", "mall_owns_state_or_money", "distributor_attribution_only", "platform_fee_8_percent", "platform_fee_rate", "buyer_repeat_purchase_allowed"]
};
const PROVIDER_KEYS: Record<string, string[]> = {
  payment: ["provider", "mode", "configured", "is_mock"],
  invoice: ["provider", "mode", "configured", "external_issuance"],
  payout: ["provider", "mode", "configured", "external_transfer"],
  notifications: ["provider", "mode", "external_delivery"]
};
const PRECEDING_WIRING = "  registerAdminControlCenterRoutes(app, {";
const FOLLOWING_ROUTE = '  app.get("/app/assets/styles.css"';
const ALLOWED_IMPORTS = [
  'import type { FastifyInstance } from "fastify";',
  'import { getPaymentProviderSummary, type PaymentProvider } from "./payment_provider.js";',
  'import { getPayoutProviderSummary, type PayoutProvider } from "./payout_provider.js";',
  'import { SITON_PLATFORM_FEE_RATE } from "./platform_fee_money.js";'
];
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Never a vacuous position: a missing anchor throws instead of yielding -1.
function indexOrFail(text: string, needle: string, from: number, label: string) {
  const at = text.indexOf(needle, from);
  assert.ok(at >= 0, `${label}: missing ${needle}`);
  return at;
}

type Sources = { runtime: string; routes: string; others: Record<string, string> };

function handlerOf(routes: string) {
  const start = indexOrFail(routes, `  app.${ROUTE.method}("${ROUTE.path}", async (req: any, reply: any) => {\n`, 0, "handler");
  return routes.slice(start, indexOrFail(routes, "\n  });\n", start, "handler end") + "\n  });\n".length);
}

// Keys of an object literal at a given indentation, between an opening and its closing line.
function literalKeys(text: string, open: string, indent: string) {
  const start = indexOrFail(text, open, 0, `literal ${open.trim()}`);
  const close = indexOrFail(text, `\n${indent.slice(2)}}`, start, `literal end ${open.trim()}`);
  // a key is "name:" or a shorthand "name," / "name" at the section's indentation
  return [...text.slice(start + open.length, close).matchAll(new RegExp(`^${indent}([a-z0-9_]+)(?::|,?$)`, "gm"))].map((m) => m[1]);
}

const CHECK = {
  REGISTRATION: "GET /api/admin/demo-readiness is registered exactly once, in src/admin_demo_readiness_routes.ts",
  WIRING: "src/frontend_runtime.ts keeps no demo-readiness handler and wires the module exactly once, at the original point, injecting exactly its readers",
  NO_COPY: "the module copies no guard, freshness, provider or launch-flag logic, constructs and calls no provider, and never imports the runtime",
  GUARDS: "the handler opens with the admin read guard, before the freshness reader or any query",
  READ_ONLY: "the handler stays a read: one transaction, no write SQL, no mutation guard, no outbox write",
  SHAPE: "the response keeps its sections, in order, and each section's keys",
  TIMESTAMP: "the runtime_started_at timestamp is taken once at registration, never per request"
} as const;

const CHECKS: Record<string, (s: Sources) => void> = {
  [CHECK.REGISTRATION]: (s) => {
    const files: Array<[string, string]> = [["frontend_runtime.ts", s.runtime], ["admin_demo_readiness_routes.ts", s.routes], ...Object.entries(s.others)];
    const pattern = new RegExp(`\\bapp\\.(get|post|put|patch|delete|options|head|all|route)\\(\\s*["'\`]${escape(ROUTE.path)}["'\`]`, "g");
    const registrations = files.flatMap(([file, text]) => [...text.matchAll(pattern)].map((m) => `${file} ${m[1]}`)).sort();
    assert.deepEqual(registrations, [`admin_demo_readiness_routes.ts ${ROUTE.method}`], ROUTE.path);
    const all = [...s.routes.matchAll(/\bapp\.(get|post|put|patch|delete|options|head|all|route)\(/g)];
    assert.equal(all.length, 1, "the module registers nothing beyond the demo-readiness route");
  },
  [CHECK.WIRING]: (s) => {
    assert.ok(!s.runtime.includes(ROUTE.path), "no demo-readiness route text stays in the runtime");
    assert.ok(!s.runtime.includes("_demoReadinessStartedAt"), "the registration timestamp moved with the route");
    assert.match(s.runtime, /^import \{ registerAdminDemoReadinessRoutes \} from "\.\/admin_demo_readiness_routes\.js";$/m);
    assert.equal((s.runtime.match(/registerAdminDemoReadinessRoutes\(/g) || []).length, 1, "exactly one wiring call");
    const wiringAt = indexOrFail(s.runtime, "\n  registerAdminDemoReadinessRoutes(app, {", 0, "wiring");
    const before = indexOrFail(s.runtime, PRECEDING_WIRING, 0, "preceding registration");
    const after = indexOrFail(s.runtime, FOLLOWING_ROUTE, 0, "following route");
    assert.ok(before < wiringAt && wiringAt < after, "wired where the route was: after the R6 wiring, before the /app static assets");
    const gapStart = indexOrFail(s.runtime, "\n  });\n", before, "preceding wiring end");
    assert.doesNotMatch(s.runtime.slice(gapStart, wiringAt), /\n  app\.(get|post|put|patch|delete)\(|\n  register\w+Routes\(/, "the wiring call directly follows the R6 wiring");
    assert.doesNotMatch(s.runtime.slice(wiringAt + 1, after), /\n  app\.(get|post|put|patch|delete)\(|\n  register\w+Routes\(/, "nothing registers between the wiring call and the /app static assets");
    const block = s.runtime.slice(wiringAt, indexOrFail(s.runtime, "\n  });\n", wiringAt + 1, "wiring block end"));
    const injectedKeys = [...block.matchAll(/^\s+([A-Za-z_]+)(?::|,|$)/gm)].map((m) => m[1]);
    assert.deepEqual(injectedKeys.sort(), INJECTED_DEPS.map((dep) => dep.split(":")[0]).sort(), "no extra and no missing dependency");
    for (const dep of INJECTED_DEPS) assert.match(block, new RegExp(`^\\s+${escape(dep)},?$`, "m"), `injected: ${dep}`);
    // the injected readers stay defined once, in the runtime
    assert.equal((s.runtime.match(/^function deployFreshness\(\) \{$/gm) || []).length, 1, "deployFreshness defined in the runtime");
    assert.equal((s.runtime.match(/^function runtimeCommitSha\(\) \{$/gm) || []).length, 1, "runtimeCommitSha defined in the runtime");
    assert.equal((s.runtime.match(/^  const isPublicMallEnabled = \(\) =>$/gm) || []).length, 1, "isPublicMallEnabled defined in the runtime");
    assert.equal((s.runtime.match(/^  const payoutProvider = deps\.payoutProvider \?\? buildPayoutProvider\(\);$/gm) || []).length, 1, "payoutProvider resolved in the runtime");
  },
  [CHECK.NO_COPY]: (s) => {
    assert.doesNotMatch(s.routes, /from "\.\/frontend_runtime(\.js)?"/, "no circular import of the runtime");
    assert.doesNotMatch(s.routes, /\bimport\([^)]*\)/, "no dynamic import");
    const imports = s.routes.split("\n").filter((line) => /^import /.test(line));
    assert.deepEqual(imports, ALLOWED_IMPORTS, "imports are exactly the type, the two provider summaries and the fee constant");
    assert.doesNotMatch(
      s.routes,
      /function (requireAdminRead|requireAdminKey|requireAdminMutation|deployFreshness|runtimeCommitSha|isPublicMallEnabled|getPaymentProviderSummary|getPayoutProviderSummary)\b/,
      "guards and readers are injected or imported, not re-implemented"
    );
    assert.doesNotMatch(s.routes, /\b(const|let|var)\s+(deployFreshness|runtimeCommitSha|isPublicMallEnabled|payoutProvider|paymentProvider)\s*=/, "no local copy of an injected reader");
    assert.doesNotMatch(s.routes, /EXPECTED_COMMIT_SHA|RENDER_GIT_COMMIT|COMMIT_SHA|GIT_COMMIT|PUBLIC_MALL_ENABLED|ADMIN_API_KEY|x-admin-key|timingSafeEqual/, "no freshness, launch-flag or auth configuration of its own");
    const envReads = [...new Set([...s.routes.matchAll(/process\.env\.([A-Z_]+)/g)].map((m) => m[1]))].sort();
    assert.deepEqual(envReads, ["APP_DEPLOYMENT_MODE", "APP_ENV", "NODE_ENV"], "only the environment labels the handler always reported");
    assert.doesNotMatch(s.routes, /build(Payment|Payout)Provider|create\w*Provider|new \w*Provider/, "no provider is constructed");
    assert.doesNotMatch(s.routes, /\.(authorize|capture|refund|charge|void|sale|execute|transfer|payout|send|issue)(\?\.)?\(/, "no provider or money action is called (plain or optional call)");
    assert.equal((s.routes.match(/getPaymentProviderSummary\(deps\.paymentProvider\)/g) || []).length, 1, "the payment provider is only summarised");
    assert.equal((s.routes.match(/getPayoutProviderSummary\(payoutProvider\)/g) || []).length, 1, "the payout provider is only summarised");
    assert.match(s.routes, /^export function registerAdminDemoReadinessRoutes\(app: FastifyInstance, deps: AdminDemoReadinessRouteDeps\) \{$/m);
    const registerAt = indexOrFail(s.routes, "export function registerAdminDemoReadinessRoutes(", 0, "register");
    const destructured = s.routes.slice(indexOrFail(s.routes, "const {", registerAt, "destructure"), indexOrFail(s.routes, "} = deps;", registerAt, "destructure end"));
    for (const name of ["requireAdminRead", "deployFreshness", "payoutProvider", "isPublicMallEnabled"]) assert.match(destructured, new RegExp(`\\b${name}\\b`), `destructured from deps: ${name}`);
  },
  [CHECK.GUARDS]: (s) => {
    const handler = handlerOf(s.routes);
    assert.deepEqual(handler.split("\n").slice(1, 1 + OPENING.length), OPENING, "guard first, then the freshness reader");
    assert.equal((s.routes.match(/await requireAdminRead\(req, reply\)/g) || []).length, 1, "one admin read guard");
    assert.ok(handler.indexOf(GUARD) < indexOrFail(handler, "deps.withTx(", 0, "transaction"), "the guard runs before the transaction");
  },
  [CHECK.READ_ONLY]: (s) => {
    const handler = handlerOf(s.routes);
    assert.doesNotMatch(s.routes, /requireAdminMutation|requireAdminAuthContext/, "no mutation guard");
    assert.doesNotMatch(s.routes, /\b(INSERT\s+INTO|UPDATE\s+siton\.|DELETE\s+FROM|TRUNCATE|ALTER\s+TABLE|CREATE\s+TABLE|DROP\s+TABLE)\b/i, "no write or DDL SQL");
    assert.doesNotMatch(s.routes, /enqueue\w*\(|recordOperationalCaseEvent|appendAuditLog|insertAudit/, "no outbox, case or audit write");
    assert.equal((handler.match(/deps\.withTx\(/g) || []).length, 1, "one transaction per request");
  },
  [CHECK.SHAPE]: (s) => {
    const handler = handlerOf(s.routes);
    assert.deepEqual(literalKeys(handler, "    return {\n", "      "), TOP_LEVEL_KEYS, "top-level sections, in order");
    for (const [section, keys] of Object.entries(SECTION_KEYS)) {
      assert.deepEqual(literalKeys(handler, `      ${section}: {\n`, "        "), keys, `${section} keys, in order`);
    }
    for (const [provider, keys] of Object.entries(PROVIDER_KEYS)) {
      assert.deepEqual(literalKeys(handler, `        ${provider}: {\n`, "          "), keys, `providers.${provider} keys, in order`);
    }
  },
  [CHECK.TIMESTAMP]: (s) => {
    assert.equal((s.routes.match(/_demoReadinessStartedAt = /g) || []).length, 1, "assigned once");
    const registerAt = indexOrFail(s.routes, "export function registerAdminDemoReadinessRoutes(", 0, "register");
    const stampAt = indexOrFail(s.routes, `\n${TIMESTAMP}\n`, registerAt, "registration-time timestamp");
    assert.ok(stampAt < indexOrFail(s.routes, `  app.get("${ROUTE.path}"`, 0, "route"), "taken at registration, before the route");
    assert.match(handlerOf(s.routes), /runtime_started_at: _demoReadinessStartedAt$/m, "reported as runtime_started_at");
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
  routes: read("admin_demo_readiness_routes.ts"),
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
const handler = handlerOf(real.routes);
const wiringStart = indexOrFail(real.runtime, "  registerAdminDemoReadinessRoutes(app, {", 0, "wiring");
const wiring = real.runtime.slice(wiringStart, indexOrFail(real.runtime, "\n  });\n", wiringStart, "wiring end") + "\n  });\n".length);
const routeOpen = `  app.get("${ROUTE.path}", async (req: any, reply: any) => {\n`;
const MUTANTS: Array<[string, string, () => Sources]> = [
  // guard
  ["admin read guard removed", CHECK.GUARDS, () => ({ ...real, routes: replaceOnce(real.routes, `${routeOpen}${GUARD}\n`, routeOpen) })],
  ["guard moved behind the freshness reader", CHECK.GUARDS, () => ({ ...real, routes: replaceOnce(real.routes, `${routeOpen}${GUARD}\n\n    const freshness = deployFreshness();\n`, `${routeOpen}    const freshness = deployFreshness();\n${GUARD}\n\n`) })],
  // registration
  ["route registered a second time in the module", CHECK.REGISTRATION, () => ({ ...real, routes: replaceOnce(real.routes, handler, handler + handler) })],
  ["route left behind in the runtime as well", CHECK.REGISTRATION, () => ({ ...real, runtime: replaceOnce(real.runtime, FOLLOWING_ROUTE, `${handler}${FOLLOWING_ROUTE}`) })],
  ["route dropped (omission)", CHECK.REGISTRATION, () => ({ ...real, routes: replaceOnce(real.routes, handler, "") })],
  // wiring and order
  ["module wired twice", CHECK.WIRING, () => ({ ...real, runtime: replaceOnce(real.runtime, wiring, wiring + wiring) })],
  ["module wired after the /app static assets (registration order changes)", CHECK.WIRING, () => {
    const moved = replaceOnce(real.runtime, wiring, "");
    return { ...real, runtime: replaceOnce(moved, '  app.get("/app/offline"', `${wiring}  app.get("/app/offline"`) };
  }],
  ["module wired before the R6 wiring (registration order changes)", CHECK.WIRING, () => {
    const moved = replaceOnce(real.runtime, wiring, "");
    return { ...real, runtime: replaceOnce(moved, PRECEDING_WIRING, `${wiring}${PRECEDING_WIRING}`) };
  }],
  ["R6 wiring anchor renamed (a -1 position must fail, not pass)", CHECK.WIRING, () => ({ ...real, runtime: replaceOnce(real.runtime, PRECEDING_WIRING, "  registerAdminControlCentreRoutes(app, {") })],
  ["an extra dependency injected", CHECK.WIRING, () => ({ ...real, runtime: replaceOnce(real.runtime, "    deployFreshness,\n    paymentProvider: deps.paymentProvider,", "    deployFreshness,\n    requireAdminKey,\n    paymentProvider: deps.paymentProvider,") })],
  ["the payout provider dropped from the wiring", CHECK.WIRING, () => ({ ...real, runtime: replaceOnce(real.runtime, "    paymentProvider: deps.paymentProvider,\n    payoutProvider,\n", "    paymentProvider: deps.paymentProvider,\n") })],
  ["the freshness reader replaced by a constant in the wiring", CHECK.WIRING, () => ({ ...real, runtime: replaceOnce(real.runtime, "    requireAdminRead,\n    deployFreshness,\n    paymentProvider", "    requireAdminRead,\n    deployFreshness: () => ({ expected_commit_sha: null, runtime_commit_sha: \"unknown\", is_stale: false, evidence: \"\" }),\n    paymentProvider") })],
  // copies
  ["module imports the runtime back", CHECK.NO_COPY, () => ({ ...real, routes: replaceOnce(real.routes, 'import type { FastifyInstance } from "fastify";', 'import type { FastifyInstance } from "fastify";\nimport { registerFrontendExperience } from "./frontend_runtime.js";') })],
  ["module re-implements the freshness reader", CHECK.NO_COPY, () => ({ ...real, routes: replaceOnce(real.routes, "export function registerAdminDemoReadinessRoutes(", "function deployFreshness() { return { expected_commit_sha: process.env.EXPECTED_COMMIT_SHA || null, runtime_commit_sha: \"unknown\", is_stale: false, evidence: \"\" }; }\nexport function registerAdminDemoReadinessRoutes(") })],
  ["module reads the launch flag itself", CHECK.NO_COPY, () => ({ ...real, routes: replaceOnce(real.routes, "public_mall_discovery:          isPublicMallEnabled(),", "public_mall_discovery:          process.env.PUBLIC_MALL_ENABLED === \"1\",") })],
  ["module constructs its own payout provider", CHECK.NO_COPY, () => ({ ...real, routes: replaceOnce(real.routes, 'import { getPayoutProviderSummary, type PayoutProvider } from "./payout_provider.js";', 'import { buildPayoutProvider, getPayoutProviderSummary, type PayoutProvider } from "./payout_provider.js";') })],
  ["module calls a provider action", CHECK.NO_COPY, () => ({ ...real, routes: replaceOnce(real.routes, "    const paymentSummary = getPaymentProviderSummary(deps.paymentProvider);\n", "    const paymentSummary = getPaymentProviderSummary(deps.paymentProvider);\n    await (deps.paymentProvider as any).capture?.({ amount: 0 });\n") })],
  // read-only
  ["handler turned into a write", CHECK.READ_ONLY, () => ({ ...real, routes: replaceOnce(real.routes, '            c.query("SELECT COUNT(*) AS dlq_count FROM siton.outbox_dlq"),\n', '            c.query("DELETE FROM siton.outbox_dlq"),\n') })],
  ["handler split over two transactions", CHECK.READ_ONLY, () => ({ ...real, routes: replaceOnce(real.routes, "    // Providers — read config only, never activate\n", "    await deps.withTx(async () => undefined);\n    // Providers — read config only, never activate\n") })],
  // shape
  ["a response section dropped", CHECK.SHAPE, () => ({ ...real, routes: replaceOnce(real.routes, "      blockers,\n      warnings,\n", "      warnings,\n") })],
  ["a provider field renamed", CHECK.SHAPE, () => ({ ...real, routes: replaceOnce(real.routes, "          is_mock:    paymentSummary.mock_backed\n", "          mock:       paymentSummary.mock_backed\n") })],
  ["deploy freshness section reordered", CHECK.SHAPE, () => ({ ...real, routes: replaceOnce(real.routes, "        expected_commit_sha: freshness.expected_commit_sha,\n        runtime_commit_sha:  freshness.runtime_commit_sha,\n", "        runtime_commit_sha:  freshness.runtime_commit_sha,\n        expected_commit_sha: freshness.expected_commit_sha,\n") })],
  // timestamp
  ["registration timestamp turned into a per-request value", CHECK.TIMESTAMP, () => ({ ...real, routes: replaceOnce(replaceOnce(real.routes, `${TIMESTAMP}\n`, ""), `${routeOpen}${GUARD}\n`, `${routeOpen}${GUARD}\n${TIMESTAMP.replace("  const", "    const")}\n`) })]
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

// Live: the real app's registry position and the response sections.
{
  const label = "the live registry lists the route once, between its original neighbours, and the response keeps its sections";
  process.env.DISABLE_OUTBOX_WORKER = "1";
  process.env.ADMIN_API_KEY = process.env.ADMIN_API_KEY || "demo-readiness-extraction-admin-key";
  process.env.SELLER_SESSION_SECRET = process.env.SELLER_SESSION_SECRET || "seller-session-secret-demo-readiness-extraction";
  process.env.ADMIN_SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || "admin-session-secret-demo-readiness-extraction";
  const appModule: any = await import("../src/app.js");
  try {
    await appModule.app.ready();
    const registry: Array<{ method: string; url: string }> | undefined = appModule.ROUTE_REGISTRY;
    assert.ok(Array.isArray(registry) && registry.length > 150, "src/app.ts exports the onRoute ROUTE_REGISTRY");
    const entries = registry!.filter((r) => r.method !== "HEAD").map((r) => `${r.method} ${r.url}`);
    const entry = `GET ${ROUTE.path}`;
    assert.equal(entries.filter((e) => e === entry).length, 1, `registered once: ${entry}`);
    const at = entries.indexOf(entry);
    assert.ok(at > 0, "the route is registered");
    assert.equal(entries[at - 1], "GET /api/admin/r6/buyers", "preceded by the last R6 route");
    assert.equal(entries[at + 1], "GET /app/assets/styles.css", "followed by the /app static assets");
    assert.equal(registry!.filter((e) => e.method === "HEAD" && e.url === ROUTE.path).length, 1, "HEAD twin once");

    const denied = await appModule.app.inject({ method: "GET", url: ROUTE.path });
    assert.equal(denied.statusCode, 401, "no credentials: denied");
    const res = await appModule.app.inject({ method: "GET", url: ROUTE.path, headers: { "x-admin-key": process.env.ADMIN_API_KEY } });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();
    assert.deepEqual(Object.keys(body), TOP_LEVEL_KEYS, "top-level sections, in order");
    for (const [section, keys] of Object.entries(SECTION_KEYS)) assert.deepEqual(Object.keys(body[section]), keys, `${section} keys`);
    for (const [provider, keys] of Object.entries(PROVIDER_KEYS)) assert.deepEqual(Object.keys(body.providers[provider]), keys, `providers.${provider} keys`);
    const again = (await appModule.app.inject({ method: "GET", url: ROUTE.path, headers: { "x-admin-key": process.env.ADMIN_API_KEY } })).json();
    assert.equal(again.environment.runtime_started_at, body.environment.runtime_started_at, "runtime_started_at is fixed at registration");
    console.log(`PASS ${label}`);
  } catch (error: any) {
    failed += 1;
    console.error(`FAIL ${label}: ${error?.message || error}`);
  } finally {
    await appModule.app.close().catch(() => undefined);
  }
}

if (failed) {
  console.error(`admin_demo_readiness_routes_extraction_validation failed=${failed}`);
  process.exit(1);
}
console.log("PASS admin_demo_readiness_routes_extraction_validation");
process.exit(0);
