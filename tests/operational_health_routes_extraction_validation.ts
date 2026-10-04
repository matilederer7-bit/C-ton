// LEAN REFACTOR ROUND 2 — structural proof for the operational health route
// extraction. `GET /health` and `GET /readiness` moved verbatim from src/app.ts
// into src/operational_health_routes.ts; the readiness PROBE (createReadinessProbe,
// the canonical runtime check, its logging and its exported state) stayed in
// src/app.ts and is injected. This test pins the shape of that move so a later
// edit cannot silently register a route twice, drop one, give /health a database
// or provider dependency, build a second probe inside the module, or lose the
// `readinessProbe` export the HTTP tests and the pool shutdown path rely on.
// The live behaviour (status codes, headers, cache semantics) stays covered by
// tests/readiness_http_validation.ts and tests/r3_render_web_runtime_validation.ts.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(process.cwd(), "src");
const read = (file: string) => readFileSync(join(SRC, file), "utf8");
const app = read("app.ts");
const routes = read("operational_health_routes.ts");
// Every route module is required; only the Mission Control module (PR #202, may land before or after this slice) is optional.
const OPTIONAL_ROUTE_FILES = new Set(["admin_mission_control_routes.ts"]);
const ROUTE_FILES = ["app.ts", "frontend_runtime.ts", "receipt_content_routes.ts", "distribution_hub.ts", "admin_mission_control_routes.ts", "operational_health_routes.ts", "support_routes.ts"]
  .filter((file) => !OPTIONAL_ROUTE_FILES.has(file) || existsSync(join(SRC, file)));
const HEALTH_ROUTES = ["/health", "/readiness"];
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

check("/health and /readiness are each registered exactly once, as GET, in src/operational_health_routes.ts", () => {
  const sources = ROUTE_FILES.map((file) => [file, read(file)] as const);
  for (const route of HEALTH_ROUTES) {
    const pattern = new RegExp(`\\bapp\\.(get|post|put|patch|delete|options|head|all|route)\\(\\s*["'\`]${escape(route)}["'\`]`, "g");
    const registrations = sources.flatMap(([file, text]) => [...text.matchAll(pattern)].map((m) => ({ file, method: m[1] })));
    assert.deepEqual(registrations, [{ file: "operational_health_routes.ts", method: "get" }], route);
  }
  assert.equal((routes.match(/^  app\.get\(/gm) || []).length, HEALTH_ROUTES.length, "the module registers nothing beyond the two routes");
  assert.doesNotMatch(routes, /app\.(post|put|patch|delete|options|head|all|route)\(/, "the module is GET only");
});

check("src/app.ts no longer carries the handler bodies and wires the module exactly once", () => {
  assert.doesNotMatch(app, /app\.get\(\s*["'`]\/health["'`]/);
  assert.doesNotMatch(app, /app\.get\(\s*["'`]\/readiness["'`]/);
  assert.doesNotMatch(app, /x-readiness-cache|x-readiness-age-ms/, "the readiness response headers are set only by the module");
  assert.match(app, /^import \{ registerOperationalHealthRoutes \} from "\.\/operational_health_routes\.js";$/m);
  const calls = app.match(/registerOperationalHealthRoutes\(app, \{ readinessProbe, resolveTrustProxyHops \}\);/g) || [];
  assert.equal(calls.length, 1, "exactly one registration of the module");
  assert.equal((app.match(/registerOperationalHealthRoutes\(/g) || []).length, 1, "no second call shape");
  // the wiring sits right after the probe it depends on; the client error relay between the two old sites stays in app.ts
  const probeAt = app.indexOf("export const readinessProbe = createReadinessProbe({");
  const wiringAt = app.indexOf("registerOperationalHealthRoutes(app, {");
  assert.ok(probeAt > 0 && probeAt < wiringAt, "wired after the probe is created");
  assert.match(app, /app\.post\("\/api\/client-errors", \{ bodyLimit: 16 \* 1024 \}/, "POST /api/client-errors stays in app.ts");
});

check("/health is liveness only: no database, provider, auth or probe access in its handler", () => {
  const health = routes.match(/app\.get\("\/health"[\s\S]*?\}\)\);/);
  assert.ok(health, "/health handler must be locatable");
  assert.equal(health[0], 'app.get("/health", async () => ({ ok: true }));', "/health stays the byte-identical one-liner");
  assert.doesNotMatch(health[0], /withTx|pool|query|provider|readinessProbe|require|auth/i);
});

check("/readiness uses the injected probe and the injected trust-proxy resolver; the module never builds a probe or imports app.ts", () => {
  assert.doesNotMatch(routes, /createReadinessProbe\(/, "no second probe");
  assert.doesNotMatch(routes, /from "\.\/app\.js"|from "\.\/app"/, "no circular import of app.ts");
  assert.doesNotMatch(routes, /from "\.\/runtime_config\.js"|from "\.\/db\.js"|from "\.\/runtime_database_boundary\.js"/, "nothing resolved locally that app.ts injects");
  assert.match(routes, /^import type \{ ReadinessProbe \} from "\.\/readiness_probe\.js";$/m, "only the probe TYPE is imported");
  assert.match(routes, /const \{ readinessProbe, resolveTrustProxyHops \} = deps;/);
  // the whole handler block, byte-for-byte (comments included): an extra header or statement slipped in between the lines fails
  const readiness = routes.match(/app\.get\("\/readiness"[\s\S]*?\n  \}\);/);
  assert.ok(readiness, "/readiness handler must be locatable");
  assert.equal(readiness[0], [
    'app.get("/readiness", async (req: any, reply: any) => {',
    "    const verdict = await readinessProbe.probe();",
    '    reply.header("x-readiness-cache", verdict.cached ? "hit" : "miss");',
    '    reply.header("x-readiness-age-ms", String(verdict.age_ms));',
    "    if (!verdict.ok) return reply.code(503).send(verdict.body);",
    "    // Operational aid for the proxy hop configuration (A2): the address the",
    "    // runtime attributes to THIS caller. Lets an operator confirm from a",
    "    // browser that TRUST_PROXY_HOPS resolves their real address (not a proxy,",
    "    // not a spoofed X-Forwarded-For prefix). It is the caller's own address.",
    '    return { ...verdict.body, client_ip: String(req.ip || ""), trust_proxy_hops: resolveTrustProxyHops() };',
    "  });"
  ].join("\n"), "/readiness stays the byte-identical handler");
});

check("the probe stays in src/app.ts: created once, exported, with the canonical check and its logging", () => {
  assert.match(app, /^export const readinessProbe = createReadinessProbe\(\{$/m, "readinessProbe is still exported from src/app.ts");
  assert.equal((app.match(/createReadinessProbe\(/g) || []).length, 1, "exactly one probe");
  assert.match(app, /check: \(\) => assertCanonicalRuntimeReady\(pool, "web"\),/);
  assert.match(app, /if \(event\.kind === "recovered"\) app\.log\.info\(\{ readiness: event \}, "readiness_recovered"\);/);
  assert.match(app, /else app\.log\.warn\(\{ readiness: event \}, `readiness_\$\{event\.kind\}`\);/);
  assert.match(app, /readinessProbe\.reset\(\);/, "the pool shutdown path still resets the probe");
});

if (failed) {
  console.error(`operational_health_routes_extraction_validation failed=${failed}`);
  process.exit(1);
}
console.log("PASS operational_health_routes_extraction_validation");
