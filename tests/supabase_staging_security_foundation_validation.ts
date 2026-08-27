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

const inventory = await readFile("supabase/staging/001_siton_inventory_v1.sql", "utf8");
const auth = await readFile("supabase/staging/002_auth_identity_foundation.sql", "utf8");
const security = await readFile("supabase/staging/003_browser_fail_closed.sql", "utf8");
const storage = await readFile("supabase/staging/004_deal_images_bucket.sql", "utf8");
const verification = await readFile("supabase/staging/verify_r1_foundation.sql", "utf8");
const extractor = await readFile("scripts/extract_base44_inventory_sql.ps1", "utf8");

await run("inventory_source_is_git_reconstructable", async () => {
  assert.match(extractor, /supabase-schema-admin\/entry\.ts/);
  assert.match(extractor, /supabase-inventory-rpc-admin\/entry\.ts/);
  assert.match(extractor, /SCHEMA_SQL/);
  assert.match(extractor, /RPC_SQL/);
  assert.match(extractor, /HARDENING_SQL/);
});

await run("inventory_schema_contains_exact_five_tables", async () => {
  const tables = [...inventory.matchAll(/CREATE TABLE IF NOT EXISTS siton_inventory\.([a-z_]+)/g)].map((match) => match[1]);
  assert.deepEqual(tables.sort(), [
    "deal_state_audit",
    "inventory_action_idempotency",
    "inventory_deals",
    "inventory_reservations",
    "participant_state_audit",
  ]);
});

await run("inventory_is_service_only_and_fail_closed", async () => {
  assert.equal((inventory.match(/ENABLE ROW LEVEL SECURITY/g) || []).length, 5);
  assert.match(inventory, /GRANT EXECUTE ON FUNCTION public\.siton_inventory_rpc\(text,jsonb\) TO service_role/);
  assert.match(inventory, /REVOKE ALL ON FUNCTION public\.siton_inventory_rpc\(text,jsonb\) FROM PUBLIC, anon, authenticated/);
  assert.doesNotMatch(inventory, /GRANT\s+(?:ALL|SELECT|INSERT|UPDATE|DELETE).*\b(?:anon|authenticated)\b/i);
});

await run("inventory_append_only_and_search_path_guards", async () => {
  assert.equal((inventory.match(/CREATE TRIGGER .*_append_only/g) || []).length, 2);
  assert.match(inventory, /participant_state_audit is append-only/);
  assert.match(inventory, /deal_state_audit is append-only/);
  assert.equal((inventory.match(/SET search_path = (?:''|pg_catalog(?:, siton_inventory)?)/g) || []).length, 8);
});

await run("auth_foundation_maps_only_registered_roles", async () => {
  for (const table of ["seller_accounts", "admin_users", "affiliate_accounts"]) {
    assert.match(auth, new RegExp(`ALTER TABLE siton\\.${table}[\\s\\S]*ADD COLUMN IF NOT EXISTS auth_user_id uuid NULL`));
    assert.match(auth, new RegExp(`FOREIGN KEY \\(auth_user_id\\) REFERENCES auth\\.users\\(id\\) ON DELETE SET NULL`));
  }
  assert.doesNotMatch(auth, /INSERT INTO auth\.users/i);
  assert.doesNotMatch(auth, /buyer.*auth_user_id/i);
});

await run("browser_core_access_is_fail_closed", async () => {
  assert.match(security, /REVOKE ALL ON SCHEMA siton FROM PUBLIC, anon, authenticated/);
  assert.match(security, /ENABLE ROW LEVEL SECURITY/);
  assert.doesNotMatch(security, /CREATE POLICY/i);
  assert.match(verification, /browser_table_privilege_count/);
  assert.match(verification, /browser_schema_usage_count/);
});

await run("deal_images_bucket_is_private_and_bounded", async () => {
  assert.match(storage, /'deal-images'/);
  assert.match(storage, /false,\s*2097152/);
  for (const mime of ["image/jpeg", "image/png", "image/webp"]) assert.match(storage, new RegExp(mime));
  assert.doesNotMatch(storage, /CREATE POLICY/i);
});
