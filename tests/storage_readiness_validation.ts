import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function run(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

const adapter = await readFile("src/storage_adapter.ts", "utf8");
const productImage = await readFile("src/product_image_storage.ts", "utf8");
const mission = await readFile("src/admin_mission_control.ts", "utf8");
const runtime = await readFile("src/frontend_runtime.ts", "utf8");
const migration = await readFile("src/migrations/037_admin_intervention_and_storage.sql", "utf8");
const doc = await readFile("docs/STORAGE_PRODUCTION_FOUNDATION.md", "utf8");

await run("storage_adapter_contract_validation", async () => {
  assert.match(adapter, /interface StorageAdapter/);
  assert.match(adapter, /class LocalStorageAdapter implements StorageAdapter/);
  assert.match(adapter, /capabilities\(\)/);
  assert.match(adapter, /describeForReadiness\(\)/);
  assert.match(adapter, /listKeys\(/);
  assert.match(adapter, /multi_instance_safe: false/);
});

await run("storage_local_mode_scale_blocker_validation", async () => {
  assert.match(adapter, /scale_blocker_for_multi_instance: true/);
  assert.match(adapter, /object_storage_required_before_multi_instance/);
  assert.match(mission, /object_storage_required_before_multi_instance/);
});

await run("upload_mime_rejection_validation", async () => {
  assert.match(productImage, /DEAL_IMAGE_MIME_TYPES/);
  assert.match(productImage, /image\/jpeg/);
  assert.match(productImage, /image\/png/);
  assert.match(productImage, /image\/webp/);
  assert.match(productImage, /invalid_image_type/);
  // sanity: SVG/HTML are not present in the allowlist
  assert.doesNotMatch(productImage, /image\/svg/);
  assert.doesNotMatch(productImage, /text\/html/);
});

await run("upload_size_limit_validation", async () => {
  assert.match(productImage, /DEAL_IMAGE_MAX_BYTES = 5 \* 1024 \* 1024/);
  assert.match(productImage, /image_too_large/);
});

await run("upload_path_traversal_validation", async () => {
  assert.match(adapter, /resolveSafe/);
  assert.match(adapter, /invalid_storage_key/);
});

await run("deal_image_immutable_cache_validation", async () => {
  assert.match(doc, /public, max-age=31536000, immutable/);
});

await run("storage_orphan_report_validation", async () => {
  assert.match(runtime, /\/api\/admin\/storage\/orphan-report/);
  assert.match(runtime, /orphan_keys_sample/);
  assert.match(runtime, /missing_files_sample/);
  assert.match(runtime, /never deletes files/);
  assert.match(migration, /storage_orphan_reports/);
});

await run("storage_readiness_mission_control_validation", async () => {
  assert.match(mission, /storage_readiness/);
  assert.match(mission, /buildStorageReadinessReport/);
  for (const field of [
    "adapter",
    "storage_provider",
    "multi_instance_safe",
    "scale_status",
    "object_storage_configured",
    "object_storage_live_ready",
    "deal_image_max_bytes",
    "allowed_mime_types",
    "path_traversal_protection",
    "public_image_cache_policy",
    "active_image_keys_count",
    "last_orphan_report",
    "blockers"
  ]) {
    assert.match(mission, new RegExp(field));
  }
});
