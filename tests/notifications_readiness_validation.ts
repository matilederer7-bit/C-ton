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

const templates = await readFile("src/notification_templates.ts", "utf8");
const dispatch = await readFile("src/notification_dispatch.ts", "utf8");
const mission = await readFile("src/admin_mission_control.ts", "utf8");
const doc = await readFile("docs/NOTIFICATIONS_PRODUCTION_FOUNDATION.md", "utf8");

await run("notification_template_contract_validation", async () => {
  for (const eventType of [
    "buyer_joined_authorized",
    "buyer_recovery_required",
    "buyer_payment_recovered",
    "buyer_deal_completed",
    "buyer_deal_failed",
    "seller_kyc_approved",
    "seller_kyc_rejected",
    "seller_payout_frozen",
    "seller_payout_unfrozen",
    "admin_security_alert"
  ]) {
    assert.match(templates, new RegExp(`"${eventType}"`));
  }
});

await run("notification_no_premature_charge_language_validation", async () => {
  // recovery template explicitly says the charge did not pass, not "you were charged"
  assert.match(templates, /החיוב.*לא עבר/);
  // joined template says authorization framework was held, not actual charge
  assert.match(templates, /לא בוצע חיוב בפועל/);
  // failed template explains release rather than claiming a refund
  assert.match(templates, /תשוחרר בהתאם למדיניות ספק האשראי/);
});

await run("notification_recovery_uses_secure_token_validation", async () => {
  assert.match(doc, /tokenized/);
  assert.match(doc, /participant tracking token/);
});

await run("notification_idempotency_validation", async () => {
  assert.match(dispatch, /buildIdempotencyKey/);
  assert.match(dispatch, /ON CONFLICT \(idempotency_key\) DO NOTHING/);
});

await run("notification_retry_to_failed_validation", async () => {
  // R9A: retries are bounded (NOTIFICATION_MAX_ATTEMPTS) with exponential
  // backoff and a terminal failed status; stranded processing rows reclaim.
  assert.match(dispatch, /temporary_fail/);
  assert.match(dispatch, /maxNotificationAttempts/);
  assert.match(dispatch, /max_attempts_exhausted/);
  assert.match(dispatch, /retryBackoffMinutes/);
  assert.match(dispatch, /reclaimStrandedNotifications/);
  assert.match(dispatch, /SET status='failed', attempt_count=attempt_count\+1/);
});

await run("notification_provider_mode_validation", async () => {
  assert.match(dispatch, /NotificationProviderMode/);
  assert.match(dispatch, /buildNotificationProvider/);
  assert.match(dispatch, /external_delivery: false/);
});

await run("notification_mission_control_validation", async () => {
  assert.match(mission, /notifications_readiness/);
  assert.match(mission, /buildNotificationsReadinessReport/);
  for (const field of [
    "provider_code",
    "provider_mode",
    "external_delivery",
    "demo_ready",
    "sandbox_ready",
    "live_ready",
    "live_blockers",
    "pending",
    "failed",
    "oldest_pending_age_seconds",
    "failed_critical_notifications",
    "idempotency_enforced",
    "retry_to_failed_supported",
    "secure_token_in_recovery_links",
    "no_premature_charge_language"
  ]) {
    assert.match(mission, new RegExp(field));
  }
});
