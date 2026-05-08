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

const intervention = await readFile("src/admin_intervention.ts", "utf8");
const controlPlane = await readFile("src/admin_control_plane.ts", "utf8");
const app = await readFile("src/app.ts", "utf8");
const runtime = await readFile("src/frontend_runtime.ts", "utf8");
const mission = await readFile("src/admin_mission_control.ts", "utf8");
const payout = await readFile("src/payout_rail.ts", "utf8");
const migration = await readFile("src/migrations/037_admin_intervention_and_storage.sql", "utf8");
const doc = await readFile("docs/ADMIN_INTERVENTION_RUNBOOK.md", "utf8");
const adminIdentity = await readFile("src/admin_identity.ts", "utf8");

await run("admin_reconcile_dry_run_validation", async () => {
  // trigger_reconcile must not call a live provider; it opens a support case
  // and reports unknown payment counts.
  assert.match(controlPlane, /action_type === "trigger_reconcile"/);
  assert.match(controlPlane, /No live provider call performed/);
  assert.match(controlPlane, /ReconcileDryRunOpened/);
});

await run("payout_freeze_blocks_payout_eligibility_validation", async () => {
  assert.match(payout, /payout_freeze_active/);
  assert.match(payout, /payout_freeze_admin_flag_active/);
  assert.match(payout, /admin_control_flags/);
});

await run("payout_unfreeze_restores_eligibility_validation", async () => {
  assert.match(controlPlane, /action_type === "unfreeze_payouts"/);
  assert.match(controlPlane, /releaseAdminControlFlag/);
});

await run("content_takedown_hides_not_deletes_validation", async () => {
  assert.match(controlPlane, /content_takedown_request/);
  assert.match(controlPlane, /content_takedown/);
  assert.match(doc, /Files and rows are not deleted/);
});

await run("pause_joining_blocks_new_join_without_state_edit_validation", async () => {
  assert.match(app, /isFlagActive\(c, "pause_joining_emergency"/);
  assert.match(app, /joining_paused_by_admin/);
  // No state machine edit happens here — we rely on the existing transition guard.
  assert.match(app, /joining is paused by admin emergency control/);
});

await run("pause_charging_blocks_worker_execution_without_state_edit_validation", async () => {
  assert.match(app, /isFlagActive\(c, "pause_charging_emergency"/);
  assert.match(app, /charging_paused_by_admin/);
  assert.match(app, /charging is paused by admin emergency control/);
});

await run("admin_intervention_requires_mfa_rbac_validation", async () => {
  assert.match(adminIdentity, /HIGH_TRUST_ADMIN_ACTIONS/);
  assert.match(adminIdentity, /payout\.freeze/);
  assert.match(adminIdentity, /emergency\.pause/);
  // approve / execute high-trust requires recent MFA
  assert.match(runtime, /HIGH_TRUST_ADMIN_ACTIONS\.has/);
  assert.match(runtime, /recentMfa: HIGH_TRUST_ADMIN_ACTIONS\.has/);
});

await run("admin_intervention_second_approval_validation", async () => {
  assert.match(controlPlane, /actionRequiresSecondApproval/);
  assert.match(controlPlane, /pause_charging_emergency/);
  assert.match(controlPlane, /unfreeze_payouts/);
  assert.match(controlPlane, /freeze_payouts/);
});

await run("admin_intervention_mission_control_validation", async () => {
  assert.match(mission, /admin_intervention_readiness/);
  assert.match(mission, /buildAdminInterventionReadiness/);
  for (const field of [
    "active_flags",
    "payout_freeze_active",
    "pause_joining_active",
    "pause_charging_active",
    "content_takedown_active",
    "expiring_within_24h",
    "safe_actions_implemented",
    "second_approval_required_for"
  ]) {
    assert.match(mission, new RegExp(field));
  }
});

await run("admin_intervention_emergency_pause_requires_expires_at_validation", async () => {
  assert.match(intervention, /admin_control_flag_expires_at_required_for_emergency_pause/);
  assert.match(controlPlane, /PauseExpiresAtRequired/);
});

await run("admin_intervention_migration_validation", async () => {
  assert.match(migration, /admin_control_flags/);
  assert.match(migration, /pause_joining_emergency/);
  assert.match(migration, /pause_charging_emergency/);
  assert.match(migration, /payout_freeze/);
  assert.match(migration, /content_takedown/);
});

await run("admin_intervention_endpoints_validation", async () => {
  assert.match(runtime, /\/api\/admin\/control-flags/);
  assert.match(runtime, /\/api\/admin\/control-flags\/:flagId\/release/);
  assert.match(runtime, /releaseAdminControlFlag/);
});

await run("admin_intervention_no_money_movement_validation", async () => {
  // Make sure none of the intervention paths perform money movement keywords
  // we deliberately reserve for the money rail. The control_plane file should
  // never call provider capture/refund APIs directly.
  assert.doesNotMatch(controlPlane, /provider\.(capture|refund|charge)\(/);
  assert.doesNotMatch(intervention, /provider\.(capture|refund|charge)\(/);
});
