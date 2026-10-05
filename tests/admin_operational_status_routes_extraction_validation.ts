// LEAN REFACTOR — structural proof for the three read-only admin operational
// status routes extracted from src/frontend_runtime.ts.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(process.cwd(), "src");
const read = (file: string) => readFileSync(join(SRC, file), "utf8");
const MODULE = "admin_operational_status_routes.ts";
const ROUTES = [
  "/api/admin/outbox-status",
  "/api/admin/notifications-status",
  "/api/admin/invoice-status"
] as const;
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
  "admin_demo_readiness_routes.ts",
  "admin_ops_overview_routes.ts"
];

type Sources = { runtime: string; routes: string; others: Record<string, string> };

const escape = (text: string) =>
  text.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/[{}]/g, "\\$&");

function indexOrFail(text: string, needle: string, label: string) {
  const at = text.indexOf(needle);
  assert.ok(at >= 0, label + ": missing " + needle);
  return at;
}

function checkSources(s: Sources) {
  const files: Array<[string,string]> = [
    ["frontend_runtime.ts", s.runtime],
    [MODULE, s.routes],
    ...Object.entries(s.others)
  ];

  for (const route of ROUTES) {
    const pattern = new RegExp(
      "\\bapp\\.(get|post|put|patch|delete|options|head|all|route)\\(\\s*[\"']" +
      escape(route) + "[\"']",
      "g"
    );
    const registrations = files.flatMap(([file,text]) =>
      [...text.matchAll(pattern)].map((m) => file + " " + m[1])
    ).sort();
    assert.deepEqual(registrations, [MODULE + " get"], route + ": exactly one GET registration in the extracted module");
    assert.ok(!s.runtime.includes(route), route + ": no route text remains in frontend_runtime.ts");
  }

  const moduleRegistrations = [...s.routes.matchAll(
    /\bapp\.(get|post|put|patch|delete|options|head|all|route)\(\s*["']([^"']+)["']/g
  )].map((m) => m[1] + " " + m[2]);
  assert.deepEqual(moduleRegistrations, ROUTES.map((route) => "get " + route), "module registers exactly the three GET routes in order");

  assert.match(s.runtime, /^import \{ registerAdminOperationalStatusRoutes \} from "\.\/admin_operational_status_routes\.js";$/m);
  assert.equal((s.runtime.match(/registerAdminOperationalStatusRoutes\(/g) || []).length, 1, "one wiring call");

  const previousAt = indexOrFail(s.runtime, 'app.post("/api/admin/infrastructure/compute-upgrade"', "preceding compute-upgrade route");
  const wiringAt = indexOrFail(s.runtime, "registerAdminOperationalStatusRoutes(app, {", "operational-status wiring");
  const nextAt = indexOrFail(s.runtime, 'app.get("/api/admin/payout-status"', "following payout-status route");
  assert.ok(previousAt < wiringAt && wiringAt < nextAt, "wiring preserves the original route order");

  const wiringEnd = s.runtime.indexOf("\n  });", wiringAt);
  assert.ok(wiringEnd > wiringAt, "wiring block has an end");
  const wiring = s.runtime.slice(wiringAt, wiringEnd);
  for (const dep of [
    "withTx: deps.withTx",
    "requireAdminRead",
    "workerStuckTimeoutMs: deps.workerStuckTimeoutMs",
    "notificationSummary: deps.notificationSummary",
    "ensureInvoiceWebhookTables",
    "invoiceSummary: deps.invoiceSummary"
  ]) assert.ok(wiring.includes(dep), "wiring keeps dependency: " + dep);

  assert.equal((s.routes.match(/await requireAdminRead\(req, reply\)/g) || []).length, 3, "one admin read guard per route");
  assert.match(s.routes, /const notificationStatusHandler = async \(req: any, reply: any\) => \{\n    if \(!\(await requireAdminRead\(req, reply\)\)\) return;/);
  assert.match(s.routes, /app\.get\("\/api\/admin\/notifications-status", notificationStatusHandler\);/);
  assert.match(s.routes, /app\.get\("\/api\/admin\/invoice-status", async \(req: any, reply: any\) => \{\n    if \(!\(await requireAdminRead\(req, reply\)\)\) return;\n    await ensureInvoiceWebhookTables\(\);/);
  assert.match(s.routes, /app\.get\("\/api\/admin\/outbox-status", async \(req: any, reply: any\) => \{\n    if \(!\(await requireAdminRead\(req, reply\)\)\) return;\n    const stuckTimeoutMs = deps\.workerStuckTimeoutMs \?\? 60_000;/);

  assert.doesNotMatch(s.routes, /requireAdminMutation|requireAdminAuthContext|requireAdminPermission/, "no mutation authority in read module");
  assert.doesNotMatch(s.routes, /\b(?:INSERT\s+INTO|UPDATE\s+siton\.|DELETE\s+FROM|ALTER\s+TABLE|DROP\s+TABLE|CREATE\s+TABLE)\b/i, "no DB writes or DDL");
  assert.doesNotMatch(s.routes, /\.(authorize|capture|refund|release|transfer|payout|send|issue|dispatch)(\?\.)?\(/, "no external side-effect operation");

  for (const needle of [
    "scheduled_future:",
    "stuck_candidates:",
    "payment_maintenance:",
    "notifications: {",
    "by_channel:",
    "recent_events:",
    "invoice_documents: {",
    "provider_failures_by_class:",
    "webhook_ingestion:",
    "webhook_security:",
    "reconcile_backlog:",
    "by_type:"
  ]) assert.ok(s.routes.includes(needle), "response surface retained: " + needle);
}

const baseline: Sources = {
  runtime: read("frontend_runtime.ts"),
  routes: read(MODULE),
  others: Object.fromEntries(OTHER_ROUTE_FILES.map((file) => [file, read(file)]))
};
checkSources(baseline);

const mutants: Array<[string,(s: Sources) => Sources]> = [
  ["route dropped", (s) => ({...s, routes:s.routes.replace('app.get("/api/admin/outbox-status"', 'app.get("/api/admin/outbox-status-disabled"')})],
  ["GET becomes POST", (s) => ({...s, routes:s.routes.replace('app.get("/api/admin/invoice-status"', 'app.post("/api/admin/invoice-status"')})],
  ["guard removed", (s) => ({...s, routes:s.routes.replace("    if (!(await requireAdminRead(req, reply))) return;\n", "")})],
  ["write introduced", (s) => ({...s, routes:s.routes.replace("    return deps.withTx(async (c) => {", "    return deps.withTx(async (c) => {\n      await c.query(\"UPDATE siton.deals SET title=title\");")})],
  ["wiring removed", (s) => ({...s, runtime:s.runtime.replace("registerAdminOperationalStatusRoutes(app, {", "registerAdminOperationalStatusRoutes_REMOVED(app, {")})],
  ["route left in runtime", (s) => ({...s, runtime:s.runtime + '\napp.get("/api/admin/outbox-status", async () => ({}));\n'})],
  ["invoice schema check removed", (s) => ({...s, routes:s.routes.replace("    await ensureInvoiceWebhookTables();\n", "")})]
];

for (const [name, mutate] of mutants) {
  assert.throws(() => checkSources(mutate(baseline)), undefined, "mutant must be rejected: " + name);
}

console.log("ADMIN_OPERATIONAL_STATUS_ROUTES_EXTRACTION_PASS");
