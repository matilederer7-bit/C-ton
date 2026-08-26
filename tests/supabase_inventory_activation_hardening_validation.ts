import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const sqlPath = path.join(process.cwd(), "base44", "supabase", "siton_inventory_activation_hardening.sql");
const sql = fs.readFileSync(sqlPath, "utf8");

assert.match(sql, /^BEGIN;/m);
assert.match(sql, /^COMMIT;/m);
assert.equal((sql.match(/ALTER FUNCTION/gi) || []).length, 2);
assert.match(sql, /ALTER FUNCTION siton_inventory\.reject_participant_state_audit_mutation\(\)\s+SET search_path = '';/s);
assert.match(sql, /ALTER FUNCTION siton_inventory\.reject_deal_state_audit_mutation\(\)\s+SET search_path = '';/s);

assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|TRUNCATE|DROP|CREATE TABLE)\b/i);
assert.doesNotMatch(sql, /\bGRANT\b/i);
assert.doesNotMatch(sql, /\b(?:anon|authenticated|service_role)\b/i);
assert.doesNotMatch(sql, /\bsiton\.(?!inventory)/i);
assert.doesNotMatch(sql, /049_mall_discovery_read_model/i);

console.log("PASS Supabase inventory activation hardening is two fixed-search_path ALTER FUNCTION statements only");
