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
  assert.match(appSource, /function isDynamicNoStoreRoute/);
  assert.match(appSource, /path\.startsWith\("\/api\/"\)/);
  assert.match(appSource, /reply\.header\("cache-control", "no-store"\)/);
  assert.match(appSource, /reply\.header\("pragma", "no-cache"\)/);
  assert.match(appSource, /reply\.header\("expires", "0"\)/);
});

await runTest("webhook responses are no-store without requiring a successful side effect", async () => {
  const appSource = await readFile("src/app.ts", "utf8");
  assert.match(appSource, /path\.startsWith\("\/webhooks\/"\)/);
  assert.match(appSource, /reply\.header\("cache-control", "no-store"\)/);
});

await runTest("deal images keep immutable cache policy", async () => {
  const appSource = await readFile("src/app.ts", "utf8");
  assert.match(appSource, /isImmutableDealImageRoute/);
  assert.match(appSource, /\.header\("cache-control", "public, max-age=31536000, immutable"\)/);
  assert.match(appSource, /!isImmutableDealImageRoute\(req\).*isDynamicNoStoreRoute/s);
});

await runTest("frontend shell is no-store", async () => {
  const runtimeSource = await readFile("src/frontend_runtime.ts", "utf8");
  assert.match(runtimeSource, /filename === "index\.html" \? "no-store"/);
  assert.match(runtimeSource, /sendFrontendFile\(reply, "index\.html"/);
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
  const frontendRuntime = await readFile("src/frontend_runtime.ts", "utf8");
  assert.doesNotMatch(packageLock, /"redis"|"ioredis"|"memcached"/i);
  assert.doesNotMatch(appSource + frontendRuntime, /money_state.*new Map|buyer_state.*new Map|outbox.*new Map|webhook.*new Map/i);
});
