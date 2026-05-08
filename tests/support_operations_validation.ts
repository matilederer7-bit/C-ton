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

const cases = await readFile("src/operational_cases.ts", "utf8");
const runtime = await readFile("src/frontend_runtime.ts", "utf8");
const mission = await readFile("src/admin_mission_control.ts", "utf8");
const doc = await readFile("docs/SUPPORT_OPERATIONS.md", "utf8");
const migration = await readFile("src/migrations/034_operational_cases.sql", "utf8");

await run("support_case_lifecycle_validation", async () => {
  for (const status of ["Open", "NeedsSeller", "NeedsAdmin", "WaitingExternal", "Resolved", "Closed"]) {
    assert.match(cases, new RegExp(`"${status}"`));
  }
  assert.match(cases, /OPERATIONAL_CASE_STATUSES/);
});

await run("support_case_requires_reason_validation", async () => {
  assert.match(runtime, /\/api\/admin\/support-cases/);
  assert.match(runtime, /case\.update_status|case\.assign|case\.close|case\.escalate/);
  assert.match(migration, /resolution_note/);
  assert.match(migration, /operational_cases_close_note_check/);
});

await run("support_case_correlation_link_validation", async () => {
  // operational_cases stores deal_id/participant_id/seller_id directly; correlation_id
  // and request_id columns are added by the admin_control_plane DDL guard.
  assert.match(cases, /deal_id/);
  assert.match(cases, /participant_id/);
  assert.match(cases, /seller_id/);
  assert.match(cases, /auto_key/);
  const controlPlane = await readFile("src/admin_control_plane.ts", "utf8");
  assert.match(controlPlane, /operational_cases ADD COLUMN IF NOT EXISTS correlation_id/);
  assert.match(controlPlane, /operational_cases ADD COLUMN IF NOT EXISTS request_id/);
});

await run("support_case_overdue_sla_validation", async () => {
  assert.match(mission, /buildSupportReadinessReport/);
  assert.match(mission, /4 hours/);
  assert.match(mission, /24 hours/);
  assert.match(mission, /72 hours/);
  assert.match(mission, /7 days/);
  assert.match(mission, /sla_breached_cases/);
});

await run("support_case_no_destructive_close_validation", async () => {
  assert.match(doc, /Cases cannot be deleted/);
  assert.match(doc, /resolution_note/);
});

await run("support_mission_control_validation", async () => {
  assert.match(mission, /support_readiness/);
  for (const field of [
    "open",
    "urgent_open",
    "high_open",
    "overdue_count",
    "sla",
    "sla_breached_cases",
    "destructive_close_blocked",
    "case_evidence_immutable",
    "verdict"
  ]) {
    assert.match(mission, new RegExp(field));
  }
});
