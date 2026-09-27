const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { MIGRATIONS } = require("../../scripts/migration_manifest.cjs");

const source = fs.readFileSync(path.resolve(__dirname, "..", "..", "src", "schema_contract.ts"), "utf8");

function tsArray(name) {
  const match = new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const;`).exec(source);
  assert.ok(match, `${name} present in schema_contract.ts`);
  return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

test("the runtime schema contract requires EVERY manifest migration (readiness fails closed on a stale database)", () => {
  const required = tsArray("REQUIRED_MIGRATION_IDS");
  const manifest = MIGRATIONS.map((m) => m.id);
  assert.deepEqual(required, manifest, "REQUIRED_MIGRATION_IDS must equal the manifest, in manifest order");
  assert.ok(required.includes("075") && required.includes("076"));
});

test("the contract checks the 076 evidence table, its triggers and the 075/076 live objects", () => {
  assert.ok(tsArray("REQUIRED_TABLES").includes("outbox_enqueue_evidence"));
  for (const needle of [
    "trg_outbox_events_record_enqueue",
    "trg_outbox_enqueue_evidence_no_update",
    "login_locked_until",
    "outbox_row_written_in_tx(p_aggregate_type text, p_aggregate_id uuid, p_event_type text)",
    "row_xmin_is_current_tx(p_xmin xid)"
  ]) assert.ok(source.includes(needle), `schema contract must check ${needle}`);
});
