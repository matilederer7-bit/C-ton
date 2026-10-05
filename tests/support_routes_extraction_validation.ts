// LEAN REFACTOR — structural proof for the support route extraction. The nine
// support routes (admin support cases, legacy support tickets, the public
// support/contact intake) moved verbatim from src/frontend_runtime.ts into
// src/support_routes.ts. This test pins the shape of that move so a later edit
// cannot silently register a route twice, drop one, leave a handler behind in
// the runtime, copy a guard into the module, or move a guard behind the
// validation and observation it protects. The checks run against the real
// sources and then against mutated copies, which must each be rejected. The
// live behaviour (status codes, response contracts) stays covered by
// tests/admin_support_cases_validation.ts,
// tests/admin_support_product_surfaces_validation.ts,
// tests/buyer_feedback_support_operations_validation.ts,
// tests/p05_admin_viral_support_validation.ts and
// tests/support_operations_validation.ts.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(process.cwd(), "src");
const read = (file: string) => readFileSync(join(SRC, file), "utf8");
const OTHER_ROUTE_FILES = ["app.ts", "receipt_content_routes.ts", "distribution_hub.ts", "admin_mission_control_routes.ts", "operational_health_routes.ts", "seller_deal_image_routes.ts", "seller_fulfillment_routes.ts", "admin_control_center_routes.ts", "admin_growth_routes.ts"];

type Guard = "admin-read" | "admin-mutation-identity" | "admin-mutation" | "public-intake";
const SUPPORT_ROUTES: Array<{ method: string; path: string; guard: Guard }> = [
  { method: "get", path: "/api/admin/support-cases", guard: "admin-read" },
  { method: "post", path: "/api/support/contact", guard: "public-intake" },
  { method: "post", path: "/api/admin/support-cases", guard: "admin-mutation-identity" },
  { method: "patch", path: "/api/admin/support-cases/:caseId", guard: "admin-mutation-identity" },
  { method: "get", path: "/api/admin/support-cases/:caseId", guard: "admin-read" },
  { method: "post", path: "/api/admin/support-cases/:caseId/reply", guard: "admin-mutation-identity" },
  { method: "post", path: "/api/admin/support-cases/:caseId/escalate", guard: "admin-mutation-identity" },
  { method: "post", path: "/api/admin/support", guard: "admin-mutation" },
  { method: "post", path: "/api/admin/support/:ticketId", guard: "admin-mutation" }
];
// The first statements of each handler: the guard, before any input is read or
// any table, row or rate-limit bucket is touched.
const GUARD_OPENING: Record<Guard, string[]> = {
  "admin-read": ["    if (!(await requireAdminRead(req, reply))) return;"],
  "admin-mutation-identity": [
    '    const adminIdentity = await requireAdminMutation(req, reply, "support.manage");',
    "    if (!adminIdentity) return;"
  ],
  "admin-mutation": ['    if (!(await requireAdminMutation(req, reply, "support.manage"))) return;'],
  "public-intake": ["    await ensureOperationalCaseTables(deps.withTx);", "    await ensureInquiryTables();"]
};
// The public intake has no identity; its protections must run in this order,
// all before the first database write.
const PUBLIC_INTAKE_ORDER = [
  "await ensureOperationalCaseTables(deps.withTx);",
  "await ensureInquiryTables();",
  'if (String(body.website || "").trim()) {',
  '"contact_name_required"',
  '"contact_email_invalid"',
  '"contact_category_invalid"',
  '"contact_message_too_short"',
  '"contact_message_too_long"',
  '"contact_deal_reference_required"',
  'if (!publicWriteCaps.consume("support_contact", String(req.ip || "unknown"))) {',
  "const created = await deps.withTx(async (c) => {",
  "if (Number(limits.per_email || 0) >= 3 || Number(limits.total || 0) >= 30) {",
  "const appended = await appendCustomerInquiryMessage(c, {",
  "INSERT INTO siton.operational_cases"
];
const INJECTED_DEPS = [
  "withTx: deps.withTx",
  "requireAdminRead",
  "requireAdminMutation",
  "adminActorRef",
  "requireUuid",
  "ensureProductSurfaces",
  "ensureInquiryTables",
  "appendCustomerInquiryMessage",
  "inquiryRequestId"
];
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function indexOrFail(text: string, needle: string, from: number, label: string) {
  const at = text.indexOf(needle, from);
  assert.ok(at >= 0, `${label}: missing ${needle}`);
  return at;
}

type Sources = { runtime: string; routes: string; others: Record<string, string> };

const CHECK = {
  REGISTRATION: "each of the nine routes is registered exactly once, with its method, in src/support_routes.ts",
  WIRING: "src/frontend_runtime.ts keeps no support handler and wires the module exactly once, at the original point",
  NO_COPY: "the module copies no guard or helper and never imports the runtime",
  GUARDS: "every handler opens with its guard, before any validation or observation",
  INTAKE: "the public intake keeps its protections in order: tables, honeypot, validation, per-client cap, DB caps, writes",
} as const;

// Each check throws on a violation. They run on the real sources and on mutants.
const CHECKS: Record<string, (s: Sources) => void> = {
  [CHECK.REGISTRATION]: (s) => {
    const files: Array<[string, string]> = [["frontend_runtime.ts", s.runtime], ["support_routes.ts", s.routes], ...Object.entries(s.others)];
    for (const path of new Set(SUPPORT_ROUTES.map((route) => route.path))) {
      const pattern = new RegExp(`\\bapp\\.(get|post|put|patch|delete|options|head|all|route)\\(\\s*["'\`]${escape(path)}["'\`]`, "g");
      const registrations = files.flatMap(([file, text]) => [...text.matchAll(pattern)].map((m) => `${file} ${m[1]}`)).sort();
      const expected = SUPPORT_ROUTES.filter((route) => route.path === path).map((route) => `support_routes.ts ${route.method}`).sort();
      assert.deepEqual(registrations, expected, path);
    }
    const all = [...s.routes.matchAll(/\bapp\.(get|post|put|patch|delete|options|head|all|route)\(/g)];
    assert.equal(all.length, SUPPORT_ROUTES.length, "the module registers nothing beyond the nine support routes");
  },
  [CHECK.WIRING]: (s) => {
    assert.doesNotMatch(s.runtime, /app\.(get|post|put|patch|delete)\(\s*["'`]\/api\/(admin\/support|support\/contact)/, "a support handler stayed in the runtime");
    assert.doesNotMatch(s.runtime, /PUBLIC_CONTACT_CATEGORIES/, "the intake category table moved with its route");
    assert.match(s.runtime, /^import \{ registerSupportRoutes \} from "\.\/support_routes\.js";$/m);
    assert.equal((s.runtime.match(/registerSupportRoutes\(/g) || []).length, 1, "exactly one wiring call");
    const wiringAt = indexOrFail(s.runtime, "registerSupportRoutes(app, {", 0, "wiring");
    const before = indexOrFail(s.runtime, 'app.post("/api/admin/kyc/:subjectType/:subjectId/decision"', 0, "preceding route");
    const after = indexOrFail(s.runtime, 'app.get("/api/participants/:id/tracking"', 0, "following route");
    assert.ok(before < wiringAt && wiringAt < after, "wired where the routes were: after the KYC decision route, before participant tracking");
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
      /function (requireAdminRead|requireAdminMutation|requireAdminAuthContext|requireAdminKey|adminActorRef|requireUuid|isUuid|memoizeSchemaCheck|appendCustomerInquiryMessage|inquiryRequestId|ensure\w+)\b/,
      "guards and helpers are injected, not re-implemented"
    );
    assert.doesNotMatch(s.routes, /process\.env|timingSafeEqual|x-admin-key|memoizeSchemaCheck\(/, "no auth, configuration or schema-memo logic of its own");
    assert.match(s.routes, /^export function registerSupportRoutes\(app: FastifyInstance, deps: SupportRouteDeps\) \{$/m);
    const destructured = s.routes.slice(indexOrFail(s.routes, "const {", s.routes.indexOf("registerSupportRoutes("), "destructure"), indexOrFail(s.routes, "} = deps;", 0, "destructure end"));
    for (const name of INJECTED_DEPS.filter((dep) => !dep.includes(":"))) assert.match(destructured, new RegExp(`\\b${name}\\b`), `destructured from deps: ${name}`);
  },
  [CHECK.GUARDS]: (s) => {
    const handlers = s.routes.split(/\n  app\.(?=get\(|post\(|patch\(|put\(|delete\()/).slice(1);
    assert.equal(handlers.length, SUPPORT_ROUTES.length);
    for (const route of SUPPORT_ROUTES) {
      const handler = handlers.find((h) => h.startsWith(`${route.method}("${route.path}", async (req: any, reply: any) => {\n`));
      assert.ok(handler, `${route.method.toUpperCase()} ${route.path} handler located`);
      const opening = handler!.split("\n").slice(1, 1 + GUARD_OPENING[route.guard].length);
      assert.deepEqual(opening, GUARD_OPENING[route.guard], `${route.method.toUpperCase()} ${route.path} opens with its guard`);
    }
    // every admin mutation is a named-identity "support.manage" mutation; reads use the admin read guard
    const mutations = SUPPORT_ROUTES.filter((r) => r.guard.startsWith("admin-mutation")).length;
    assert.equal((s.routes.match(/await requireAdminMutation\(req, reply, "support\.manage"\)/g) || []).length, mutations, "support.manage on every admin mutation");
    assert.equal((s.routes.match(/await requireAdminMutation\(/g) || []).length, mutations, "no other admin permission");
    assert.equal((s.routes.match(/await requireAdminRead\(req, reply\)/g) || []).length, SUPPORT_ROUTES.filter((r) => r.guard === "admin-read").length);
  },
  [CHECK.INTAKE]: (s) => {
    const start = indexOrFail(s.routes, 'app.post("/api/support/contact"', 0, "public intake");
    const end = indexOrFail(s.routes, 'app.post("/api/admin/support-cases"', start, "public intake end");
    const intake = s.routes.slice(start, end);
    let cursor = 0;
    for (const step of PUBLIC_INTAKE_ORDER) {
      const at = intake.indexOf(step, cursor);
      assert.ok(at >= 0, `public intake: "${step}" missing or out of order`);
      cursor = at + step.length;
    }
    assert.equal((intake.match(/publicWriteCaps\.consume\(/g) || []).length, 1, "one per-client bucket");
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
  routes: read("support_routes.ts"),
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
const escalate = real.routes.slice(real.routes.indexOf('  app.post("/api/admin/support-cases/:caseId/escalate"'), real.routes.indexOf('  app.post("/api/admin/support",'));
const MUTANTS: Array<[string, string, () => Sources]> = [
  ["read guard removed from GET /api/admin/support-cases", CHECK.GUARDS, () => ({ ...real, routes: replaceOnce(real.routes, '  app.get("/api/admin/support-cases", async (req: any, reply: any) => {\n    if (!(await requireAdminRead(req, reply))) return;\n', '  app.get("/api/admin/support-cases", async (req: any, reply: any) => {\n') })],
  ["identity check dropped from PATCH /api/admin/support-cases/:caseId", CHECK.GUARDS, () => ({ ...real, routes: replaceOnce(real.routes, '  app.patch("/api/admin/support-cases/:caseId", async (req: any, reply: any) => {\n    const adminIdentity = await requireAdminMutation(req, reply, "support.manage");\n    if (!adminIdentity) return;\n', '  app.patch("/api/admin/support-cases/:caseId", async (req: any, reply: any) => {\n    const adminIdentity = await requireAdminMutation(req, reply, "support.manage");\n') })],
  ["guard moved behind id validation on the reply route", CHECK.GUARDS, () => ({ ...real, routes: replaceOnce(real.routes, '  app.post("/api/admin/support-cases/:caseId/reply", async (req: any, reply: any) => {\n    const adminIdentity = await requireAdminMutation(req, reply, "support.manage");\n', '  app.post("/api/admin/support-cases/:caseId/reply", async (req: any, reply: any) => {\n    requireUuid(String(req.params.caseId || "").trim(), "case_id");\n    const adminIdentity = await requireAdminMutation(req, reply, "support.manage");\n') })],
  ["ticket mutation downgraded to a weaker permission", CHECK.GUARDS, () => ({ ...real, routes: replaceOnce(real.routes, '  app.post("/api/admin/support/:ticketId", async (req: any, reply: any) => {\n    if (!(await requireAdminMutation(req, reply, "support.manage"))) return;', '  app.post("/api/admin/support/:ticketId", async (req: any, reply: any) => {\n    if (!(await requireAdminMutation(req, reply, "support.read"))) return;') })],
  ["per-client contact bucket removed", CHECK.INTAKE, () => ({ ...real, routes: replaceOnce(real.routes, 'if (!publicWriteCaps.consume("support_contact", String(req.ip || "unknown"))) {', "if (false) {") })],
  ["DB write moved ahead of the per-client contact bucket", CHECK.INTAKE, () => {
    const bucket = '    // Black-Sky C5: per-client budget before the platform-wide 30/h cap.\n    if (!publicWriteCaps.consume("support_contact", String(req.ip || "unknown"))) {\n      return reply.code(429).send({ ok: false, error: "support contact rate limited", code: "support_rate_limited" });\n    }\n';
    const moved = replaceOnce(real.routes, bucket, "");
    return { ...real, routes: replaceOnce(moved, "      return { ...inserted.rows[0], deal_context: dealContext, inquiry };\n    });\n", "      return { ...inserted.rows[0], deal_context: dealContext, inquiry };\n    });\n" + bucket) };
  }],
  ["escalate route registered a second time in the module", CHECK.REGISTRATION, () => ({ ...real, routes: replaceOnce(real.routes, "\n  });\n}\n", `\n  });\n${escalate}}\n`) })],
  ["escalate route left behind in the runtime as well", CHECK.REGISTRATION, () => ({ ...real, runtime: replaceOnce(real.runtime, '  app.get("/api/participants/:id/tracking"', `${escalate}  app.get("/api/participants/:id/tracking"`) })],
  ["module wired twice", CHECK.WIRING, () => ({ ...real, runtime: replaceOnce(real.runtime, "  registerSupportRoutes(app, {", "  registerSupportRoutes(app, deps as any);\n  registerSupportRoutes(app, {") })],
  ["module imports the runtime back", CHECK.NO_COPY, () => ({ ...real, routes: replaceOnce(real.routes, 'import type { FastifyInstance } from "fastify";', 'import type { FastifyInstance } from "fastify";\nimport { registerFrontendExperience } from "./frontend_runtime.js";') })],
  ["module re-implements a guard", CHECK.NO_COPY, () => ({ ...real, routes: replaceOnce(real.routes, "export function registerSupportRoutes(", "function requireAdminRead(req: any, reply: any) { return true; }\nexport function registerSupportRoutes(") })]
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

if (failed) {
  console.error(`support_routes_extraction_validation failed=${failed}`);
  process.exit(1);
}
console.log("PASS support_routes_extraction_validation");
