import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function runTest(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

const mission = await readFile("src/admin_mission_control.ts", "utf8");
const app = await readFile("src/app.ts", "utf8");
const paymentProvider = await readFile("src/payment_provider.ts", "utf8");
const webhookIngestion = await readFile("src/webhook_ingestion.ts", "utf8");
const invoiceDispatch = await readFile("src/invoice_dispatch.ts", "utf8");

await runTest("provider_live_money_readiness_contract_validation", async () => {
  assert.match(mission, /live_money_readiness: liveMoneyReadiness/);
  for (const field of [
    "payment_provider_status",
    "webhook_status",
    "reconcile_status",
    "refund_status",
    "invoice_status",
    "payout_status",
    "admin_intervention_status",
    "security_status",
    "live_readiness_verdict",
    "blockers",
    "warnings",
    "evidence"
  ]) {
    assert.match(mission, new RegExp(field));
  }
});

await runTest("payment_provider_mode_validation", async () => {
  assert.match(mission, /payment_provider_not_live_validated/);
  assert.match(mission, /live_ready: false/);
  assert.match(paymentProvider, /configured/);
});

await runTest("webhook_secret_policy_validation", async () => {
  assert.match(mission, /payment_webhook_secret_missing_for_live/);
  assert.match(mission, /PAYMENT_WEBHOOK_SECRET/);
  assert.match(mission, /STRIPE_WEBHOOK_SECRET/);
});

await runTest("no_raw_card_data_validation", async () => {
  assert.doesNotMatch(mission, /card_number|cvv|cvc|raw_card/i);
  assert.match(paymentProvider, /payment_method_id/);
});

await runTest("money_actions_not_in_request_thread_validation", async () => {
  assert.match(app, /workerProcessEvent/);
  assert.match(app, /capture_worker|recovery_worker|refund_worker/);
  assert.doesNotMatch(app, /app\.post\(".*\/capture/);
  assert.doesNotMatch(app, /app\.post\(".*\/refund/);
});

await runTest("duplicate_webhook_idempotency_validation", async () => {
  assert.match(webhookIngestion, /event_id/);
  assert.match(webhookIngestion, /ON CONFLICT|duplicate/i);
});

await runTest("invoice_no_duplicate_issuance_validation", async () => {
  assert.match(invoiceDispatch, /provider_document_id|idempotency/i);
  assert.match(invoiceDispatch, /retry/i);
});

await runTest("payout_freeze_blocker_validation", async () => {
  assert.match(mission, /freeze_payouts_admin_action_foundation_only/);
  assert.match(mission, /live_readiness_verdict: "blocked"/);
});
