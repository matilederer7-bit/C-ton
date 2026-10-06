// LEAN REFACTOR ROUND 2 — structural proof for the Mission Control route
// extraction. The seven read-only admin GET routes moved verbatim from
// src/frontend_runtime.ts into src/admin_mission_control_routes.ts. This test
// pins the shape of that move so a later edit cannot silently re-register a
// route twice, drop one, copy a guard into the module, or loosen the auth,
// validation and read-only action policy the handlers carry. The live
// behaviour (status codes, response contracts) stays covered by
// tests/mission_control_validation.ts and
// tests/admin_mission_control_outbox_trace_validation.ts.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(process.cwd(), "src");
const read = (file: string) => readFileSync(join(SRC, file), "utf8");
const runtime = read("frontend_runtime.ts");
const routes = read("admin_mission_control_routes.ts");
const ROUTE_FILES = ["app.ts", "frontend_runtime.ts", "receipt_content_routes.ts", "distribution_hub.ts", "admin_mission_control_routes.ts", "support_routes.ts", "seller_fulfillment_routes.ts", "admin_control_center_routes.ts", "admin_growth_routes.ts", "admin_demo_readiness_routes.ts", "admin_ops_overview_routes.ts", "admin_operational_status_routes.ts"];
const MISSION_ROUTES = [
  "/api/admin/mission-control",
  "/api/admin/mission-control/anomalies",
  "/api/admin/mission-control/deals/:dealId/trace",
  "/api/admin/mission-control/participants/:participantId/trace",
  "/api/admin/mission-control/correlation/:correlationId",
  "/api/admin/mission-control/outbox/:eventId",
  "/api/admin/mission-control/webhooks/:provider/:eventId"
];
const INJECTED_DEPS = [
  "withTx: deps.withTx",
  "requireAdminRead",
  "requireUuid",
  "ensureProductSurfaces",
  "ensurePayoutTables",
  "ensureNotificationTables",
  "ensureLegalAcceptanceTables",
  "ensureInvoiceWebhookTables",
  "ensurePaymentOpsTables",
  "ensureAdminControlPlane",
  "frontendDir",
  "payoutProvider",
  "paymentProvider: deps.paymentProvider",
  "deploymentMode: deps.deploymentMode",
  "isDemoPreview: deps.isDemoPreview",
  "invoiceSummary: deps.invoiceSummary",
  "notificationSummary: deps.notificationSummary",
  "debugSurfacesEnabled: deps.debugSurfacesEnabled",
  "getWorkerRunning: deps.getWorkerRunning"
];
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

let failed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error: any) {
    failed += 1;
    console.error(`FAIL ${name}: ${error?.message || error}`);
  }
}

check("each of the seven routes is registered exactly once, as GET, in src/admin_mission_control_routes.ts", () => {
  const sources = ROUTE_FILES.map((file) => [file, read(file)] as const);
  for (const route of MISSION_ROUTES) {
    const pattern = new RegExp(`\\bapp\\.(get|post|put|patch|delete|options|head)\\(\\s*["'\`]${escape(route)}["'\`]`, "g");
    const registrations = sources.flatMap(([file, text]) => [...text.matchAll(pattern)].map((m) => ({ file, method: m[1] })));
    assert.deepEqual(registrations, [{ file: "admin_mission_control_routes.ts", method: "get" }], route);
  }
  assert.equal((routes.match(/^  app\.get\(/gm) || []).length, MISSION_ROUTES.length, "the module registers nothing beyond the seven routes");
  assert.doesNotMatch(routes, /app\.(post|put|patch|delete|options|head)\(/, "the module is read-only: GET only");
});

check("src/frontend_runtime.ts no longer carries the handler bodies and wires the module exactly once", () => {
  assert.doesNotMatch(runtime, /app\.get\(\s*["'`]\/api\/admin\/mission-control/);
  assert.match(runtime, /^import \{ registerAdminMissionControlRoutes \} from "\.\/admin_mission_control_routes\.js";$/m);
  const calls = runtime.match(/registerAdminMissionControlRoutes\(app, \{/g) || [];
  assert.equal(calls.length, 1);
  // the wiring sits where the routes were: after the admin ops overview reads
  // (payment-ops-status, overview, launch-console — moved into
  // src/admin_ops_overview_routes.ts by the Lean Refactor, wired by the call
  // below), before /api/admin/actions. A missing anchor fails instead of
  // comparing -1.
  const wiringAt = runtime.indexOf("registerAdminMissionControlRoutes(app, {");
  const opsOverviewWiringAt = runtime.indexOf("registerAdminOpsOverviewRoutes(app, {");
  const actionsAt = runtime.indexOf('app.get("/api/admin/actions"');
  assert.ok(wiringAt >= 0, "Mission Control wiring call present");
  assert.ok(opsOverviewWiringAt >= 0, "admin ops overview wiring call present");
  assert.ok(actionsAt >= 0, "/api/admin/actions present");
  assert.ok(opsOverviewWiringAt < wiringAt, "wired after the admin ops overview reads");
  assert.ok(wiringAt < actionsAt, "wired before /api/admin/actions");
  // the module receives exactly the closures the handlers used before
  const block = runtime.slice(wiringAt, runtime.indexOf("\n  });\n", wiringAt));
  for (const dep of INJECTED_DEPS) {
    assert.match(block, new RegExp(`^\\s+${escape(dep)},?$`, "m"), `injected: ${dep}`);
  }
  const injectedKeys = [...block.matchAll(/^\s+([A-Za-z_]+)(?::|,|$)/gm)].map((m) => m[1]);
  assert.deepEqual(injectedKeys.sort(), INJECTED_DEPS.map((dep) => dep.split(":")[0]).sort(), "no extra and no missing dependency");
});

check("the module copies no helper: guards, validators and schema checks are injected, not re-implemented", () => {
  assert.doesNotMatch(routes, /function (requireAdminRead|requireAdminKey|requireUuid|isUuid|memoizeSchemaCheck|ensure\w+Tables|ensureAdminControlPlane|ensureProductSurfaces)\b/);
  assert.doesNotMatch(routes, /from "\.\/frontend_runtime\.js"/, "no circular import of the runtime");
  assert.doesNotMatch(routes, /process\.env|timingSafeEqual|x-admin-key/, "no auth or configuration logic of its own");
  assert.match(routes, /^export function registerAdminMissionControlRoutes\(app: FastifyInstance, deps: AdminMissionControlRouteDeps\)/m);
  const destructured = routes.slice(routes.indexOf("const {", routes.indexOf("registerAdminMissionControlRoutes(")), routes.indexOf("} = deps;"));
  for (const name of ["requireAdminRead", "requireUuid", "ensureProductSurfaces", "ensurePayoutTables", "ensureNotificationTables", "ensureLegalAcceptanceTables", "ensureInvoiceWebhookTables", "ensurePaymentOpsTables", "ensureAdminControlPlane", "frontendDir", "payoutProvider"]) {
    assert.match(destructured, new RegExp(`\\b${name}\\b`), `destructured from deps: ${name}`);
  }
  for (const imported of ["buildAdminMissionControlPayload", "buildMissionCorrelationTrace", "buildMissionDealTrace", "buildMissionOutboxTrace", "buildMissionParticipantTrace", "buildMissionWebhookTrace"]) {
    assert.match(routes, new RegExp(`^\\s+${imported},?$`, "m"), `builder imported from ./admin_mission_control.js: ${imported}`);
  }
  assert.match(routes, /from "\.\/admin_mission_control\.js";/);
  assert.match(routes, /import \{ getPaymentProviderSummary, type PaymentProvider \} from "\.\/payment_provider\.js";/);
  assert.match(routes, /import \{ getPayoutProviderSummary, type PayoutProvider \} from "\.\/payout_provider\.js";/);
  assert.match(routes, /import \{ DEFAULT_SELLER_ID \} from "\.\/product_surface_support\.js";/);
});

check("auth contract: every handler opens with the runtime's requireAdminRead guard and owns one transaction", () => {
  const handlers = routes.split(/\n  app\.get\(/).slice(1);
  assert.equal(handlers.length, MISSION_ROUTES.length);
  for (const handler of handlers) {
    const [signature, firstStatement] = handler.split("\n");
    assert.equal(firstStatement, "    if (!(await requireAdminRead(req, reply))) return;", String(signature));
  }
  assert.equal((routes.match(/await requireAdminRead\(req, reply\)/g) || []).length, MISSION_ROUTES.length);
  assert.equal((routes.match(/deps\.withTx\(/g) || []).length, MISSION_ROUTES.length, "exactly one withTx boundary per route");
  assert.doesNotMatch(routes, /c\.query\(\s*["'`]\s*(INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE)\b/i, "read-only SQL only");
});

check("validation and error contract preserved", () => {
  assert.match(routes, /const q = String\(req\.query\?\.q \|\| ""\)\.trim\(\)\.slice\(0, 200\);/);
  assert.match(routes, /const dealId = String\(req\.params\.dealId \|\| ""\)\.trim\(\);\n\s+requireUuid\(dealId, "deal_id"\);/);
  assert.match(routes, /const participantId = String\(req\.params\.participantId \|\| ""\)\.trim\(\);\n\s+requireUuid\(participantId, "participant_id"\);/);
  assert.match(routes, /const eventId = String\(req\.params\.eventId \|\| ""\)\.trim\(\);\n\s+requireUuid\(eventId, "event_id"\);/);
  assert.match(routes, /const correlationId = String\(req\.params\.correlationId \|\| ""\)\.trim\(\)\.slice\(0, 200\);\n\s+if \(!correlationId\) return reply\.code\(400\)\.send\(\{ ok: false, error: "correlation_id_required" \}\);/);
  assert.match(routes, /const provider = String\(req\.params\.provider \|\| ""\)\.trim\(\)\.slice\(0, 80\);\n\s+const eventId = String\(req\.params\.eventId \|\| ""\)\.trim\(\)\.slice\(0, 200\);\n\s+if \(!provider \|\| !eventId\) return reply\.code\(400\)\.send\(\{ ok: false, error: "provider_and_event_id_required" \}\);/);
  assert.match(routes, /return deps\.withTx\(\(c\) => buildMissionDealTrace\(c, dealId\)\);/);
  assert.match(routes, /return deps\.withTx\(\(c\) => buildMissionParticipantTrace\(c, participantId\)\);/);
  assert.match(routes, /return deps\.withTx\(\(c\) => buildMissionCorrelationTrace\(c, correlationId\)\);/);
  assert.match(routes, /return deps\.withTx\(\(c\) => buildMissionOutboxTrace\(c, eventId\)\);/);
  assert.match(routes, /return deps\.withTx\(\(c\) => buildMissionWebhookTrace\(c, provider, eventId\)\);/);
});

check("schema checks of the overview and anomaly routes preserved, in order", () => {
  const overview = routes.slice(routes.indexOf('app.get("/api/admin/mission-control"'), routes.indexOf('app.get("/api/admin/mission-control/anomalies"'));
  const anomalies = routes.slice(routes.indexOf('app.get("/api/admin/mission-control/anomalies"'), routes.indexOf('app.get("/api/admin/mission-control/deals/'));
  const ensures = (text: string) => [...text.matchAll(/await (ensure\w+)\(\);/g)].map((m) => m[1]);
  assert.deepEqual(ensures(overview), ["ensureProductSurfaces", "ensurePayoutTables", "ensureNotificationTables", "ensureLegalAcceptanceTables", "ensureInvoiceWebhookTables", "ensurePaymentOpsTables", "ensureAdminControlPlane"]);
  assert.deepEqual(ensures(anomalies), ["ensureProductSurfaces", "ensurePayoutTables", "ensureNotificationTables", "ensureInvoiceWebhookTables", "ensurePaymentOpsTables", "ensureAdminControlPlane"]);
  assert.match(overview, /rootDir: join\(frontendDir, "\.\."\)/);
  assert.match(anomalies, /rootDir: join\(frontendDir, "\.\."\)/);
  assert.match(anomalies, /anomaly_center: payload\.anomaly_center,\n\s+recommended_actions: payload\.recommended_actions/);
});

check("read-only money and action policy preserved verbatim", () => {
  for (const flag of ["state_override_enabled", "manual_capture_enabled", "manual_refund_enabled", "manual_void_enabled", "manual_payout_enabled", "manual_money_actions_enabled", "request_thread_transfers_enabled", "export_csv_available"]) {
    assert.match(routes, new RegExp(`\\b${flag}: false\\b`), flag);
    assert.doesNotMatch(routes, new RegExp(`\\b${flag}: true\\b`), flag);
  }
  assert.match(routes, /sensitive_actions_require_reason_and_audit: true/);
  assert.match(routes, /immutable_audit_log: true/);
  assert.match(routes, /stale_after_seconds: 60/);
  assert.match(routes, /scope: "admin_only_operational_search"/);
  assert.match(routes, /provider: getPayoutProviderSummary\(payoutProvider\)/);
  assert.match(routes, /provider: getPaymentProviderSummary\(deps\.paymentProvider\)/);
  assert.match(routes, /seller_id: String\(row\.seller_id \|\| DEFAULT_SELLER_ID\)/);
});

if (failed) {
  console.error(`FAILED ${failed} mission-control route extraction checks`);
  process.exit(1);
}
console.log("All mission-control route extraction checks passed.");
