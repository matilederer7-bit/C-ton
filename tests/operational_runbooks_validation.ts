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

const runbooks = await readFile("docs/OPERATIONAL_RUNBOOKS.md", "utf8");
const interventionDoc = await readFile("docs/ADMIN_INTERVENTION_RUNBOOK.md", "utf8");
const mission = await readFile("src/admin_mission_control.ts", "utf8");

await run("ops_runbook_docs_exist_validation", async () => {
  for (const heading of [
    "Outbox Stuck",
    "Payment Unknown",
    "Webhook Duplicate",
    "Invoice Failed",
    "Notification Failed",
    "Payout Freeze",
    "Seller KYC Rejection",
    "Suspicious Seller",
    "Security Alert",
    "Participant Cannot Access Tracking",
    "Emergency Pause Joining",
    "Emergency Pause Charging",
    "Deploy Stale",
    "DB Unavailable",
    "Storage Unavailable"
  ]) {
    assert.match(runbooks, new RegExp(heading));
  }
});

await run("ops_failure_drill_mission_control_validation", async () => {
  // Mission control surfaces every failure drill anomaly source we listed in runbooks.
  // Some domains are emitted via literal anomaly entries; invoices/notifications/payouts
  // share a dynamic domain dispatch in a for loop that filters anomalies via item.domain ===.
  for (const literalDomain of ["outbox", "webhooks", "payments", "state_machine", "security"]) {
    assert.match(mission, new RegExp(`domain: "${literalDomain}"`));
  }
  for (const dynamicDomain of ["invoices", "notifications", "payouts"]) {
    assert.match(mission, new RegExp(`item\\.domain === "${dynamicDomain}"`));
  }
  assert.match(mission, /admin_intervention_readiness/);
  assert.match(mission, /support_readiness/);
});

await run("ops_safe_action_from_anomaly_validation", async () => {
  // Safe actions must include the Phase 5 actions on top of the existing ones.
  for (const action of [
    "requeue_outbox_event",
    "retry_notification",
    "retry_invoice_failed",
    "open_support_case",
    "freeze_payouts",
    "unfreeze_payouts",
    "pause_joining_emergency",
    "pause_charging_emergency",
    "content_takedown_request",
    "trigger_reconcile"
  ]) {
    assert.match(mission, new RegExp(`"${action}"`));
  }
});

await run("ops_no_destructive_remediation_validation", async () => {
  // Runbooks must explicitly forbid destructive remediations
  assert.match(runbooks, /Forbidden/);
  assert.match(runbooks, /Deleting DLQ rows/);
  assert.match(runbooks, /Manual capture/);
  assert.match(interventionDoc, /never deletes/i);
});
