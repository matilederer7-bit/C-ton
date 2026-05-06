import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// ── Static checks (no server needed) ─────────────────────────────────────────

const frontendRuntime = await readFile("src/frontend_runtime.ts", "utf8");
const frontendApp     = await readFile("frontend/app.js", "utf8");
const platformFee     = await readFile("src/platform_fee_money.ts", "utf8");

function check(name: string, fn: () => void) {
  try { fn(); console.log("PASS " + name); }
  catch (e) { console.error("FAIL " + name); throw e; }
}

// The endpoint must exist
check("demo-readiness route is registered", () => {
  assert.match(frontendRuntime, /app\.get\(["']\/api\/admin\/demo-readiness["']/);
});

// No marketplace / search / catalog route added
check("no marketplace route added", () => {
  assert.doesNotMatch(frontendRuntime, /app\.\w+\(["']\/api\/(marketplace|catalog|search)["']/i);
});

// Platform fee constant is 0.08
check("SITON_PLATFORM_FEE_RATE is 0.08", () => {
  assert.match(platformFee, /SITON_PLATFORM_FEE_RATE\s*=\s*0\.08/);
});

// No direct capture/refund/void/payout in the new endpoint block
check("demo-readiness endpoint has no money mutation", () => {
  const block = frontendRuntime.slice(
    frontendRuntime.indexOf("/api/admin/demo-readiness"),
    frontendRuntime.indexOf("/api/admin/demo-readiness") + 8000
  );
  assert.doesNotMatch(block, /capture|refund|void|payout\.execute|\.sale\(/i);
});

// No state transition in the new endpoint
check("demo-readiness endpoint has no state transition", () => {
  const block = frontendRuntime.slice(
    frontendRuntime.indexOf("/api/admin/demo-readiness"),
    frontendRuntime.indexOf("/api/admin/demo-readiness") + 8000
  );
  assert.doesNotMatch(block, /UPDATE\s+siton\.(deals|participants)\s+SET\s+state/i);
});

// Frontend admin page includes the demo readiness section renderer
check("admin page renders demo readiness section", () => {
  assert.match(frontendApp, /renderDemoReadinessSection/);
  assert.match(frontendApp, /adminDemoReadinessPayload/);
});

// Frontend has a refresh action for demo readiness
check("frontend has refresh-demo-readiness action", () => {
  assert.match(frontendApp, /refresh-demo-readiness/);
  assert.match(frontendApp, /loadDemoReadiness/);
});

// Product contract: buyer repeat purchase guard not removed
check("buyer repeat purchase contract not broken in product_contract block", () => {
  assert.match(frontendRuntime, /buyer_repeat_purchase_allowed.*true/);
});

// ── Live server checks ───────────────────────────────────────────────────────

process.env.ADMIN_API_KEY      = "demo-readiness-test-key";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.APP_DEPLOYMENT_MODE   = "demo-preview";
process.env.PORT                  = String(process.env.PORT || "3510");
delete process.env.EXPECTED_COMMIT_SHA;
delete process.env.RENDER_GIT_COMMIT;
delete process.env.COMMIT_SHA;

const { app } = await import("../src/app.js");
const ADMIN_H  = { "x-admin-key": "demo-readiness-test-key" };

async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log("PASS " + name); }
  catch (e) { console.error("FAIL " + name); throw e; }
}

try {
  // 1. Requires admin key
  await run("demo-readiness requires admin key", async () => {
    const res = await app.inject({ method: "GET", url: "/api/admin/demo-readiness" });
    assert.equal(res.statusCode, 401);
  });

  // 2. Returns valid basic structure
  await run("demo-readiness returns structured JSON", async () => {
    const res = await app.inject({ method: "GET", url: "/api/admin/demo-readiness", headers: ADMIN_H });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as any;
    assert.ok(typeof body.ok === "boolean",          "ok must be boolean");
    assert.ok(["ready","warning","blocked"].includes(body.verdict), "verdict must be valid");
    assert.ok(body.environment,                      "environment section missing");
    assert.ok(body.deploy_freshness,                 "deploy_freshness section missing");
    assert.ok(body.database,                         "database section missing");
    assert.ok(body.providers,                        "providers section missing");
    assert.ok(body.queues,                           "queues section missing");
    assert.ok(body.demo_data,                        "demo_data section missing");
    assert.ok(body.product_contract,                 "product_contract section missing");
    assert.ok(Array.isArray(body.blockers),          "blockers must be array");
    assert.ok(Array.isArray(body.warnings),          "warnings must be array");
    assert.ok(typeof body.checked_at === "string",   "checked_at must be string");
  });

  // 3. No EXPECTED_COMMIT_SHA → warning, not blocked, not stale
  await run("no expected_commit_sha produces warning not blocked", async () => {
    const res = await app.inject({ method: "GET", url: "/api/admin/demo-readiness", headers: ADMIN_H });
    const body = res.json() as any;
    assert.equal(body.deploy_freshness.is_stale, false,          "should not be stale without expected SHA");
    assert.equal(body.deploy_freshness.expected_commit_sha, null, "expected_commit_sha must be null");
    // must produce a warning about missing config
    const warnStr = JSON.stringify(body.warnings);
    assert.match(warnStr, /expected commit is not configured/, "warning about missing expected commit required");
    // must not be blocked for this reason alone
    assert.doesNotMatch(JSON.stringify(body.blockers), /commit/, "commit mismatch must not be a blocker without expected SHA");
  });

  // 4. Matching commit SHA → not stale
  await run("matching expected_commit_sha is not stale", async () => {
    const origExpected = process.env.EXPECTED_COMMIT_SHA;
    const origRuntime  = process.env.RENDER_GIT_COMMIT;
    process.env.RENDER_GIT_COMMIT   = "abc123";
    process.env.EXPECTED_COMMIT_SHA = "abc123";
    try {
      const res = await app.inject({ method: "GET", url: "/api/admin/demo-readiness", headers: ADMIN_H });
      const body = res.json() as any;
      assert.equal(body.deploy_freshness.is_stale, false,     "matching commit should not be stale");
      assert.doesNotMatch(JSON.stringify(body.blockers), /commit/, "matching commit must not block");
    } finally {
      if (origExpected === undefined) delete process.env.EXPECTED_COMMIT_SHA;
      else process.env.EXPECTED_COMMIT_SHA = origExpected;
      if (origRuntime === undefined) delete process.env.RENDER_GIT_COMMIT;
      else process.env.RENDER_GIT_COMMIT = origRuntime;
    }
  });

  // 5. Mismatched commit SHA → blocked + is_stale
  await run("mismatched expected_commit_sha → blocked and stale", async () => {
    const origExpected = process.env.EXPECTED_COMMIT_SHA;
    const origRuntime  = process.env.RENDER_GIT_COMMIT;
    process.env.RENDER_GIT_COMMIT   = "aaa111";
    process.env.EXPECTED_COMMIT_SHA = "bbb999";
    try {
      const res = await app.inject({ method: "GET", url: "/api/admin/demo-readiness", headers: ADMIN_H });
      const body = res.json() as any;
      assert.equal(body.deploy_freshness.is_stale, true,  "mismatched commit must be stale");
      assert.equal(body.verdict, "blocked",                "mismatched commit must block");
      assert.match(JSON.stringify(body.blockers), /runtime commit does not match expected commit/);
    } finally {
      if (origExpected === undefined) delete process.env.EXPECTED_COMMIT_SHA;
      else process.env.EXPECTED_COMMIT_SHA = origExpected;
      if (origRuntime === undefined) delete process.env.RENDER_GIT_COMMIT;
      else process.env.RENDER_GIT_COMMIT = origRuntime;
    }
  });

  // 6. Providers returned — no live activation occurred
  await run("provider readiness returned without live activation", async () => {
    const res = await app.inject({ method: "GET", url: "/api/admin/demo-readiness", headers: ADMIN_H });
    const body = res.json() as any;
    assert.ok(typeof body.providers.payment.provider === "string",  "payment provider must be string");
    assert.ok(typeof body.providers.payment.mode === "string",       "payment mode must be string");
    assert.ok(typeof body.providers.payout.provider === "string",    "payout provider must be string");
    assert.ok(typeof body.providers.notifications.provider === "string", "notifications provider must be string");
  });

  // 7. Product contract — fee is 8%
  await run("product_contract.platform_fee_8_percent is true", async () => {
    const res = await app.inject({ method: "GET", url: "/api/admin/demo-readiness", headers: ADMIN_H });
    const body = res.json() as any;
    assert.equal(body.product_contract.platform_fee_8_percent, true, "platform fee must be 8%");
    assert.equal(body.product_contract.platform_fee_rate,      0.08, "platform_fee_rate must be 0.08");
  });

  // 8. Product contract — buyer repeat purchase allowed
  await run("product_contract.buyer_repeat_purchase_allowed is true", async () => {
    const res = await app.inject({ method: "GET", url: "/api/admin/demo-readiness", headers: ADMIN_H });
    const body = res.json() as any;
    assert.equal(body.product_contract.buyer_repeat_purchase_allowed, true);
  });

  // 9. Product contract — no marketplace
  await run("product_contract.link_only_no_marketplace is true", async () => {
    const res = await app.inject({ method: "GET", url: "/api/admin/demo-readiness", headers: ADMIN_H });
    const body = res.json() as any;
    assert.equal(body.product_contract.link_only_no_marketplace, true);
  });

  // 10. No state was mutated by the call (deals count unchanged)
  await run("demo-readiness call does not mutate deals state", async () => {
    const before = await app.inject({ method: "GET", url: "/api/admin/demo-readiness", headers: ADMIN_H });
    const after  = await app.inject({ method: "GET", url: "/api/admin/demo-readiness", headers: ADMIN_H });
    const b1 = before.json() as any;
    const b2 = after.json() as any;
    assert.deepEqual(b1.demo_data, b2.demo_data, "demo_data must be stable across calls");
    assert.deepEqual(b1.database.missing_tables, b2.database.missing_tables, "DB tables must be stable");
  });

} finally {
  await app.close().catch(() => undefined);
}

process.exit(0);
