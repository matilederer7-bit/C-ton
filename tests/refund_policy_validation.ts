import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function runTest(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

const app = await readFile("src/app.ts", "utf8");
const runtime = await readFile("src/frontend_runtime.ts", "utf8");
const controlPlane = await readFile("src/admin_control_plane.ts", "utf8");
const mission = await readFile("src/admin_mission_control.ts", "utf8");
const providerReadinessDoc = await readFile("docs/PROVIDER_LIVE_MONEY_READINESS.md", "utf8");
const adminControlDoc = await readFile("docs/ADMIN_CONTROL_PLANE.md", "utf8");
const supportDoc = await readFile("docs/SUPPORT_OPERATIONS.md", "utf8");
const legalDoc = await readFile("docs/LEGAL_TRUST_SURFACES.md", "utf8");
const refundPolicyDoc = await readFile("docs/REFUND_POLICY.md", "utf8");
const frontend = await readFile("frontend/app.js", "utf8");
const packageJson = await readFile("package.json", "utf8");

const sourceRuntime = `${app}\n${runtime}`;

await runTest("refund_policy_no_admin_manual_refund_validation", async () => {
  for (const action of [
    "manual_refund",
    "admin_refund",
    "merchant_refund",
    "seller_refund",
    "support_refund",
    "partial_refund",
    "manual_credit",
    "manual_void",
    "manual_capture"
  ]) {
    assert.match(controlPlane, new RegExp(`"${action}"`), `${action} must be explicitly forbidden`);
  }
  const safeActionArray = controlPlane.match(/ADMIN_SAFE_ACTION_TYPES\s*=\s*\[([\s\S]*?)\]\s*as const/)?.[1] || "";
  assert.doesNotMatch(safeActionArray, /manual_refund/i);
  assert.doesNotMatch(safeActionArray, /partial_refund/i);
  assert.match(runtime, /isForbiddenAdminAction\(actionType\)/);
  assert.match(runtime, /admin_action_forbidden/);
});

await runTest("refund_policy_no_seller_refund_validation", async () => {
  assert.doesNotMatch(sourceRuntime, /app\.(post|patch|put|delete)\(\s*["'][^"']*\/api\/seller\/[^"']*refund/i);
  assert.doesNotMatch(frontend, /data-action=["'][^"']*seller[^"']*refund/i);
  assert.match(frontend, /מחלוקת מסחרית/);
});

await runTest("refund_policy_no_support_refund_validation", async () => {
  assert.doesNotMatch(sourceRuntime, /app\.(post|patch|put|delete)\(\s*["'][^"']*\/api\/support\/[^"']*refund/i);
  assert.match(supportDoc, /commercial dispute/i);
  assert.match(frontend, /אין החזר כספי ידני דרך Support/);
  assert.match(app + runtime, /support-cases/);
});

await runTest("refund_policy_no_partial_refund_validation", async () => {
  assert.match(controlPlane, /"partial_refund"/);
  assert.doesNotMatch(sourceRuntime, /partial_refund\s*[:=]\s*true/i);
  assert.doesNotMatch(sourceRuntime, /amount_minor[^;\n]{0,120}partial/i);
});

await runTest("refund_policy_system_failed_deal_only_validation", async () => {
  assert.match(app, /actionName:\s*"charging\.finalize_failed"/);
  assert.match(app, /outbox:\s*\{\s*event_type:\s*"refund_issue"/);
  assert.match(app, /p\.money_state IN \('ChargedSuccess','RecoveredCharge'\)/);
  assert.match(app, /paymentMinorAmount\(\{\s*[\s\S]*qty:[\s\S]*pricePerUnit:[\s\S]*deliveryCost:/);
  assert.match(app, /decision\.captured >= decision\.threshold/);
  assert.match(app, /threshold_units/);
  assert.doesNotMatch(sourceRuntime, /app\.(post|patch|put|delete)\(\s*["'][^"']*\/refund/i);
});

await runTest("refund_policy_json_not_truth_validation", async () => {
  assert.match(refundPolicyDoc, /JSONB is not a refund eligibility source/i);
  assert.doesNotMatch(app, /payload(?:_jsonb)?\s*(?:->>|\.)(?:refund_eligible|is_refunded|refund_amount|partial_refund)/i);
  assert.doesNotMatch(runtime, /metadata_jsonb[\s\S]{0,120}(?:refund_eligible|is_refunded|refund_amount|partial_refund)/i);
});

await runTest("refund_policy_mission_control_validation", async () => {
  assert.match(mission, /refund_policy_readiness:\s*refundPolicyReadiness/);
  assert.match(mission, /manual_refund_allowed:\s*false/);
  assert.match(mission, /seller_refund_allowed:\s*false/);
  assert.match(mission, /admin_commercial_refund_allowed:\s*false/);
  assert.match(mission, /system_refund_on_failed_deal_required:\s*true/);
  assert.match(mission, /provider_sandbox_required:\s*true/);
});

await runTest("refund_policy_copy_validation", async () => {
  const combined = `${frontend}\n${adminControlDoc}\n${supportDoc}\n${legalDoc}\n${providerReadinessDoc}\n${refundPolicyDoc}`;
  const allowedManualRefundMentions = [
    "No seller, admin, or support user can initiate a manual commercial refund through the system.",
    "manual_refund",
    "manual refunds",
    "manual refund",
    "manual commercial refund",
    "no admin refund"
  ];
  for (const dangerous of ["seller can refund", "admin can refund", "refund request approved"]) {
    assert.doesNotMatch(combined, new RegExp(dangerous, "i"));
  }
  for (const mention of allowedManualRefundMentions) {
    assert.ok(combined.includes(mention) || combined.toLowerCase().includes(mention.toLowerCase()));
  }
  assert.doesNotMatch(frontend, /בקשת החזר/);
});

await runTest("refund_policy_provider_readiness_validation", async () => {
  assert.match(providerReadinessDoc, /system_mandated_refund_on_deal_failed/);
  assert.match(mission, /system_refund_provider_validation_status:\s*"pending_provider_sandbox"/);
  assert.match(mission, /admin_commercial_refund_allowed:\s*false/);
  assert.doesNotMatch(providerReadinessDoc, /requires?\s+admin manual refund/i);
});

await runTest("refund_policy_full_e2e_regression_validation", async () => {
  assert.match(packageJson, /"test:refund-policy"/);
  assert.match(packageJson, /"test:full-e2e-gate"/);
  assert.match(refundPolicyDoc, /Refunds in Siton are system-mandated only/);
});
