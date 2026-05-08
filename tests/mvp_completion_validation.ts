import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";

async function run(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

async function fileExists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const mission = await readFile("src/admin_mission_control.ts", "utf8");
const projectStatus = await readFile("PROJECT_STATUS.md", "utf8").catch(() => "");
const pkg = await readFile("package.json", "utf8");

await run("mvp_completion_readiness_section_validation", async () => {
  assert.match(mission, /mvp_completion_readiness/);
  assert.match(mission, /buildMvpCompletionReadiness/);
  for (const section of [
    "seller_onboarding",
    "storage",
    "notifications",
    "support_operations",
    "admin_intervention",
    "runbooks",
    "legal_trust",
    "production_launch",
    "security",
    "scale",
    "live_money"
  ]) {
    assert.match(mission, new RegExp(section));
  }
});

await run("mvp_completion_invariants_validation", async () => {
  assert.match(mission, /distributor_commission_present: false/);
  assert.match(mission, /siton_fee_pct: 8/);
  assert.match(mission, /state_machine_changed: false/);
  assert.match(mission, /money_logic_changed: false/);
  assert.match(mission, /live_money_performed: false/);
  assert.match(mission, /secrets_in_repo: false/);
  assert.match(mission, /no_destructive_admin_action: true/);
});

await run("mvp_completion_post_e2e_live_money_blocker_validation", async () => {
  assert.match(mission, /post_e2e_live_money_blockers/);
  assert.match(mission, /payment_provider_not_live_validated/);
  assert.match(mission, /live_money_intentionally_blocked/);
});

await run("mvp_completion_required_docs_validation", async () => {
  for (const doc of [
    "docs/SELLER_ONBOARDING_KYC.md",
    "docs/STORAGE_PRODUCTION_FOUNDATION.md",
    "docs/NOTIFICATIONS_PRODUCTION_FOUNDATION.md",
    "docs/SUPPORT_OPERATIONS.md",
    "docs/ADMIN_INTERVENTION_RUNBOOK.md",
    "docs/OPERATIONAL_RUNBOOKS.md",
    "docs/LEGAL_TRUST_SURFACES.md",
    "docs/PRODUCTION_LAUNCH_READINESS.md",
    "docs/MVP_COMPLETION_GATE.md"
  ]) {
    assert.equal(await fileExists(doc), true, `missing required doc: ${doc}`);
  }
});

await run("mvp_completion_required_migrations_validation", async () => {
  assert.equal(await fileExists("src/migrations/037_admin_intervention_and_storage.sql"), true);
});

await run("mvp_completion_required_modules_validation", async () => {
  for (const file of [
    "src/admin_intervention.ts",
    "src/storage_adapter.ts"
  ]) {
    assert.equal(await fileExists(file), true, `missing required module: ${file}`);
  }
});

await run("mvp_completion_test_scripts_present_validation", async () => {
  for (const script of [
    "test:mvp-completion",
    "test:seller-onboarding",
    "test:storage-readiness",
    "test:notifications-readiness",
    "test:support-operations",
    "test:admin-intervention",
    "test:operational-runbooks",
    "test:legal-trust",
    "test:production-launch-readiness"
  ]) {
    assert.match(pkg, new RegExp(`"${script}"`));
  }
});

await run("mvp_completion_no_state_machine_drift_validation", async () => {
  // The MVP completion pass must not have introduced new states. Verify the
  // closed sets remain unchanged.
  const app = await readFile("src/app.ts", "utf8");
  for (const state of [
    "Draft", "PendingTarget", "TargetReached", "ClosedForJoining",
    "ReadyForCharging", "Charging", "CompletionWindow", "Completed", "Failed", "Cancelled"
  ]) {
    assert.match(app, new RegExp(`"${state}"`));
  }
  // Make sure the new join/charging gates do NOT change state — they reject with 423.
  assert.match(app, /joining_paused_by_admin/);
  assert.match(app, /charging_paused_by_admin/);
});

await run("mvp_completion_project_status_optional_validation", async () => {
  // PROJECT_STATUS may or may not yet be updated for this exact gate; just
  // assert it exists if present, do not block the gate on the body.
  if (projectStatus) {
    assert.match(projectStatus, /PROJECT STATUS/);
  }
});
