// Controls for the route inventory report, the health contract check and the
// HTTP security smoke.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
require("dotenv").config({ quiet: true });
const { createFixtureRepo, REPO_ROOT } = require("./support/fixture_repo.cjs");
const isolation = require("../../scripts/lib/test_db_isolation.cjs");

let dbAvailable = false;
try { if (process.env.DATABASE_URL) { isolation.assertLocalBase(process.env.DATABASE_URL); dbAvailable = true; } } catch { dbAvailable = false; }

const ROUTE_FIXTURE = ["src/app.ts", "src/frontend_runtime.ts", "src/receipt_content_routes.ts", "src/distribution_hub.ts", "frontend/app.js", "scripts/lib", "scripts/protected_route_policy.cjs", "scripts/web_route_inventory.cjs", "scripts/route_inventory_report.cjs", "config/route-classification.json"];

test("route inventory report classifies every route on the real code and fails on a new unclassified sensitive route", () => {
  const clean = createFixtureRepo(ROUTE_FIXTURE);
  try {
    const ok = clean.run("scripts/route_inventory_report.cjs");
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /unclassified routes: every route is intentionally classified/);
    assert.match(ok.stdout, /ROUTE_INVENTORY_REPORT_PASS/);
  } finally { clean.cleanup(); }

  const mutated = createFixtureRepo(ROUTE_FIXTURE);
  try {
    mutated.mutate("src/app.ts", "app.get(\"/health\", async () => ({ ok: true }));", "app.get(\"/health\", async () => ({ ok: true }));\napp.post(\"/api/export/all-buyers\", async () => ({ ok: true }));");
    const result = mutated.run("scripts/route_inventory_report.cjs");
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /\[FAIL\] unclassified routes: 1 routes match no classification rule \(1 sensitive\)/);
    assert.match(result.stdout, /SENSITIVE POST \/api\/export\/all-buyers/);
  } finally { mutated.cleanup(); }
});

test("health contract check proves liveness vs readiness on a local runtime", { skip: !dbAvailable && "no local DATABASE_URL" }, () => {
  const result = spawnSync(process.execPath, [path.join(REPO_ROOT, "scripts", "health_contract_check.cjs")], { cwd: REPO_ROOT, encoding: "utf8", timeout: 240000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /HEALTH_CONTRACT_PASS/);
  assert.match(result.stdout, /\[PASS\] negative control: database gone -> \/health stays 200, \/readiness 503/);
  assert.match(result.stdout, /\[PASS\] worker readiness/);
});

// GAP-HTTP-1 is CLOSED: /readiness is in the dynamic no-store route list, so the
// smoke ASSERTS it like /health instead of recording it as a non-failing gap.
// This test now pins the closed state - it must fail if the gap ever returns.
test("http security smoke passes on a local runtime with /readiness no-store enforced", { skip: !dbAvailable && "no local DATABASE_URL" }, () => {
  const result = spawnSync(process.execPath, [path.join(REPO_ROOT, "scripts", "http_security_smoke.cjs")], { cwd: REPO_ROOT, encoding: "utf8", timeout: 240000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /HTTP_SECURITY_SMOKE_PASS/);
  assert.doesNotMatch(result.stdout, /GAP-HTTP-1/, "GAP-HTTP-1 must stay closed: /readiness must carry cache-control: no-store");
  assert.match(result.stdout, /\[PASS\] health \+ readiness responses/);
  assert.match(result.stdout, /no-store, security headers on \/health, \/readiness and \/health\/integrations/);
  assert.match(result.stdout, /\[PASS\] admin surface anonymous refusal/);
  assert.match(result.stdout, /\[PASS\] unsigned webhook refused without 500/);
});
