import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function runTest(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

await runTest("dynamic /api responses are no-store", async () => {
  const appSource = await readFile("src/app.ts", "utf8");
  // the classifier moved to src/http_security_headers.ts (Lean Refactor); the hook that applies it stays in app.ts
  const headersSource = await readFile("src/http_security_headers.ts", "utf8");
  assert.match(headersSource, /function isDynamicNoStoreRoute/);
  assert.match(headersSource, /path\.startsWith\("\/api\/"\)/);
  assert.match(appSource, /reply\.header\("cache-control", "no-store"\)/);
  assert.match(appSource, /reply\.header\("pragma", "no-cache"\)/);
  assert.match(appSource, /reply\.header\("expires", "0"\)/);
});

await runTest("webhook responses are no-store without requiring a successful side effect", async () => {
  const appSource = await readFile("src/app.ts", "utf8");
  const headersSource = await readFile("src/http_security_headers.ts", "utf8");
  assert.match(headersSource, /path\.startsWith\("\/webhooks\/"\)/);
  assert.match(appSource, /reply\.header\("cache-control", "no-store"\)/);
});

await runTest("published deal images are immutable while Draft images stay private", async () => {
  const appSource = await readFile("src/app.ts", "utf8");
  assert.match(appSource, /isImmutableDealImageRoute/);
  assert.match(
    appSource,
    /\.header\("cache-control", row\.published_at \? "public, max-age=31536000, immutable" : "private, no-store"\)/
  );
  assert.match(appSource, /!isImmutableDealImageRoute\(req\).*isDynamicNoStoreRoute/s);
});

await runTest("frontend shell is no-store", async () => {
  const runtimeSource = await readFile("src/frontend_runtime.ts", "utf8");
  assert.match(runtimeSource, /const sendShell = async/);
  assert.match(runtimeSource, /readFile\(join\(frontendDir, "index\.html"\), "utf8"\)/);
  assert.match(runtimeSource, /return reply\s*\.header\("cache-control", "no-store"\)/);
  assert.match(runtimeSource, /app\.get\("\/app", sendShell\)/);
});

await runTest("unhashed frontend assets require revalidation", async () => {
  const runtimeSource = await readFile("src/frontend_runtime.ts", "utf8");
  assert.match(runtimeSource, /: "no-cache, must-revalidate"/);
  assert.match(runtimeSource, /sendFrontendFile\(reply, "app\.js"/);
  assert.match(runtimeSource, /sendFrontendFile\(reply, "styles\.css"/);
});

await runTest("cache hardening added no dependency or business cache", async () => {
  const packageLock = await readFile("package-lock.json", "utf8");
  const appSource = await readFile("src/app.ts", "utf8");
  // support, seller fulfillment, admin control-center (R6), admin growth and admin demo-readiness routes moved out of frontend_runtime.ts (Lean Refactor); they stay in this scan
  const frontendRuntime = (await readFile("src/frontend_runtime.ts", "utf8")) + "\n" + (await readFile("src/support_routes.ts", "utf8")) + "\n" + (await readFile("src/seller_fulfillment_routes.ts", "utf8")) + "\n" + (await readFile("src/admin_control_center_routes.ts", "utf8")) + "\n" + (await readFile("src/admin_growth_routes.ts", "utf8")) + "\n" + (await readFile("src/admin_demo_readiness_routes.ts", "utf8")) + "\n" + (await readFile("src/admin_ops_overview_routes.ts", "utf8"));
  assert.doesNotMatch(packageLock, /"redis"|"ioredis"|"memcached"/i);
  assert.doesNotMatch(appSource + frontendRuntime, /money_state.*new Map|buyer_state.*new Map|outbox.*new Map|webhook.*new Map/i);
});
