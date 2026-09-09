import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import pg from "pg";

// Apply the reviewed SQL only to a disposable test role, inside a rolled-back
// transaction on the isolated runner's local database. Never hosted Supabase.
const url = new URL(process.env.DATABASE_URL || "");
assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
assert.match(url.pathname, /^\/siton_test_/);
const c = new pg.Client({ connectionString: url.toString() });
await c.connect();
const role = `comms_grant_${randomUUID().replaceAll("-", "")}`;
try {
  await c.query("BEGIN");
  await c.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
  await c.query(`GRANT USAGE ON SCHEMA siton TO ${role}`);
  const sql = readFileSync("supabase/staging/023_pilot_communications_worker_grants.sql", "utf8").replaceAll("siton_worker_runtime", role);
  await c.query(sql);
  for (const [table, column, expected] of [
    ["participant_tracking_tokens", "tracking_token_id", true],
    ["participant_tracking_tokens", "token_hash", false],
    ["seller_business_profiles", "seller_id", true],
    ["seller_business_profiles", "contact_email", true],
    ["seller_business_profiles", "contact_name", false],
    ["seller_business_profiles", "bank_account_number", false],
    ["participants", "buyer_phone", false]
  ] as const) {
    const result = await c.query("SELECT has_column_privilege($1,$2,$3,'SELECT') AS allowed", [role, `siton.${table}`, column]);
    assert.equal(result.rows[0].allowed, expected, `${table}.${column}`);
  }
  await c.query(`SET LOCAL ROLE ${role}`);
  // Empty INSERT still checks every permission needed by the actual token
  // issuer's INSERT ... RETURNING, including column SELECT privileges.
  await c.query(`INSERT INTO siton.participant_tracking_tokens
    (participant_id, deal_id, token_hash, purpose, status, expires_at, issued_via, correlation_id)
    SELECT NULL::uuid,NULL::uuid,'hash','tracking','Active',now(),'notification:test',NULL WHERE false
    RETURNING tracking_token_id, participant_id, deal_id, purpose, status, expires_at`);
  await c.query("SELECT contact_email FROM siton.seller_business_profiles WHERE seller_id='missing'");
  console.log("PASS grant 023: token INSERT RETURNING and seller contact lookup; no token hash, bank, unrelated contact or participant read");
} finally {
  await c.query("ROLLBACK");
  await c.end();
}
