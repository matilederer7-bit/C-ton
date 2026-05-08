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

const app = await readFile("src/app.ts", "utf8");
const mission = await readFile("src/admin_mission_control.ts", "utf8");
const runtime = await readFile("src/frontend_runtime.ts", "utf8");
const enforcement = await readFile("src/seller_enforcement.ts", "utf8");
const doc = await readFile("docs/SELLER_ONBOARDING_KYC.md", "utf8");

await run("seller_onboarding_readiness_section_validation", async () => {
  assert.match(mission, /seller_onboarding_readiness/);
  for (const field of [
    "active_sellers",
    "pending_review",
    "rejected",
    "under_review",
    "suspended",
    "banned",
    "deals_blocked_by_kyc",
    "publish_blocked_for_unverified"
  ]) {
    assert.match(mission, new RegExp(field));
  }
});

await run("seller_pending_cannot_publish_in_production_validation", async () => {
  assert.match(app, /seller_kyc_not_approved/);
  assert.match(app, /isProductionLike[\s\S]{0,100}verification_status[\s\S]{0,200}approved/);
});

await run("seller_active_can_publish_in_demo_validation", async () => {
  // demo / non-production publishes still permitted: no KYC enforcement
  // outside production-like envs
  assert.match(app, /seller profile incomplete/);
  // ensure demo path is not unconditionally blocked
  assert.match(app, /isProductionLike\s*=\s*process\.env\.NODE_ENV === "production"/);
});

await run("seller_suspended_cannot_publish_validation", async () => {
  assert.match(enforcement, /sellerStatusBlocksAction/);
  assert.match(enforcement, /Suspended/);
  assert.match(enforcement, /Banned/);
  assert.match(app, /ensureSellerActionAllowed[\s\S]{0,80}publish/);
});

await run("admin_kyc_requires_reason_validation", async () => {
  assert.match(runtime, /\/api\/admin\/sellers\/:sellerId\/status/);
  assert.match(runtime, /seller_status_reason_required/);
  assert.match(runtime, /reason is required for every seller status change/);
});

await run("admin_kyc_audit_validation", async () => {
  assert.match(runtime, /siton\.seller_security_events/);
  assert.match(runtime, /seller\.status\.update/);
});

await run("seller_kyc_mission_control_validation", async () => {
  assert.match(mission, /buildSellerOnboardingReadiness/);
  assert.match(mission, /verification_status/);
  assert.match(mission, /seller_status/);
  assert.match(mission, /deals_blocked_by_kyc/);
});

await run("seller_kyc_doc_present_validation", async () => {
  assert.match(doc, /verification_status/);
  assert.match(doc, /seller_status/);
  assert.match(doc, /Publish Blocking/);
});
