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

const mission = await readFile("src/admin_mission_control.ts", "utf8");
const app = await readFile("src/app.ts", "utf8");
const frontendRuntime = await readFile("src/frontend_runtime.ts", "utf8");
const outboxHelpers = await readFile("src/outbox_worker_helpers.ts", "utf8");
const imageStorage = await readFile("src/product_image_storage.ts", "utf8");
const storageAdapter = await readFile("src/storage_adapter.ts", "utf8");

await runTest("scale_readiness_report_contract_validation", async () => {
  assert.match(mission, /scale_readiness: scaleReadiness/);
  for (const field of [
    "stateless_api",
    "in_memory_state_risks",
    "otp_scale_status",
    "rate_limit_scale_status",
    "storage_scale_status",
    "worker_parallelism_status",
    "idempotency_scale_status",
    "db_pool_status",
    "load_balancer_readiness",
    "blockers"
  ]) {
    assert.match(mission, new RegExp(field));
  }
});

await runTest("in_memory_state_inventory_validation", async () => {
  assert.match(app, /class MemoryRateLimiterStore/);
  assert.match(app, /const rateLimitStore: RateLimiterStore = new MemoryRateLimiterStore/);
  assert.match(frontendRuntime, /const legacyPhoneByChallenge = new Map/);
  assert.match(mission, /rateLimitStore/);
  assert.match(mission, /legacyPhoneByChallenge/);
  assert.match(mission, /single_instance_only/);
});

await runTest("worker_claim_parallel_safety_validation", async () => {
  assert.match(outboxHelpers, /FOR UPDATE SKIP LOCKED/);
  assert.match(outboxHelpers, /status='processing'/);
  assert.match(outboxHelpers, /processing_started_at=clock_timestamp\(\)/);
  assert.match(outboxHelpers, /lease_expires_at > clock_timestamp\(\)/);
});

await runTest("auth_session_not_memory_backed_validation", async () => {
  assert.match(app, /JOIN siton\.seller_accounts/);
  assert.match(app, /FROM siton\.seller_sessions/);
  assert.doesNotMatch(app, /sellerSessionStore\s*=\s*new Map/);
});

await runTest("storage_scale_readiness_validation", async () => {
  // After the storage adapter refactor, product_image_storage validates and
  // delegates to the adapter; the path traversal guard lives in storage_adapter.ts.
  assert.match(imageStorage, /storage_provider/);
  assert.match(imageStorage, /DEAL_IMAGE_MIME_TYPES/);
  assert.match(imageStorage, /DEAL_IMAGE_MAX_BYTES/);
  assert.match(storageAdapter, /final\.startsWith\(this\.root \+ sep\)|finalPath\.startsWith\(root\)|invalid_storage_key/);
  assert.match(mission, /object_storage_required_before_multi_instance/);
});
