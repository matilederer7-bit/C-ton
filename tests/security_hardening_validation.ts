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

const app = await readFile("src/app.ts", "utf8");
const runtime = await readFile("src/frontend_runtime.ts", "utf8");
const mission = await readFile("src/admin_mission_control.ts", "utf8");
const imageStorage = await readFile("src/product_image_storage.ts", "utf8");
const sellerAuth = await readFile("src/seller_auth.ts", "utf8");
const packageJson = await readFile("package.json", "utf8");
const allSource = [
  app,
  runtime,
  mission,
  imageStorage,
  sellerAuth,
  await readFile("src/webhook_ingestion.ts", "utf8"),
  await readFile("src/payment_provider.ts", "utf8"),
  await readFile("src/platform_fee_money.ts", "utf8")
].join("\n");

await runTest("security_admin_auth_validation", async () => {
  assert.match(runtime, /function requireAdminKey/);
  assert.match(runtime, /admin_key_not_configured/);
  assert.match(runtime, /timingSafeEqual/);
  assert.match(runtime, /app\.get\("\/api\/admin\/mission-control"/);
  // R6: admin READ surfaces gate through requireAdminRead (named identity via
  // Supabase/cookie, or the timing-safe ops key inside requireAdminKey).
  assert.match(runtime, /function requireAdminRead/);
  assert.ok((runtime.match(/await requireAdminRead\(req, reply\)/g) || []).length >= 10);
  // the key check still backs the read guard (fail-closed when unconfigured in
  // production-like environments)
  assert.match(runtime, /return requireAdminKey\(req as FastifyRequest, reply as FastifyReply\);/);
});

await runTest("security_admin_actions_forbidden_validation", async () => {
  assert.match(await readFile("src/admin_control_plane.ts", "utf8"), /manual_capture|manual_refund|manual_state_edit|manual_money_state_edit|delete_audit|delete_outbox|delete_webhook/);
});

await runTest("security_no_secret_exposure_validation", async () => {
  assert.match(mission, /maskEnvPresence/);
  assert.match(mission, /security_hardening_gate/);
  assert.doesNotMatch(mission, /secret_value|api_key_value|raw_secret|raw_api_key/i);
});

await runTest("security_headers_validation", async () => {
  for (const header of ["x-content-type-options", "referrer-policy", "x-frame-options", "permissions-policy"]) {
    assert.match(app, new RegExp(header));
  }
  assert.match(app, /nosniff/);
  assert.match(app, /no-referrer/);
  assert.match(app, /DENY/);
});

await runTest("security_api_no_store_validation", async () => {
  assert.match(app, /path\.startsWith\("\/api\/"\)/);
  assert.match(app, /path\.startsWith\("\/webhooks\/"\)/);
  assert.match(app, /reply\.header\("cache-control", "no-store"\)/);
});

await runTest("security_upload_validation", async () => {
  assert.match(imageStorage, /DEAL_IMAGE_MIME_TYPES/);
  assert.match(imageStorage, /DEAL_IMAGE_MAX_BYTES/);
  // Path traversal protection is now enforced in the storage adapter abstraction.
  const storageAdapter = await readFile("src/storage_adapter.ts", "utf8");
  assert.match(storageAdapter, /final\.startsWith\(this\.root \+ sep\)/);
  assert.match(storageAdapter, /invalid_storage_key/);
  assert.doesNotMatch(imageStorage, /image\/svg|text\/html|application\/javascript/);
});

await runTest("security_csv_excel_injection_validation", async () => {
  assert.match(runtime, /Prevent formula injection/);
  assert.ok(runtime.includes("/^[=+\\-@]/") || runtime.includes("/^[=\\-+@*]/"));
  assert.match(runtime, /function safeTextDH/);
});

await runTest("security_xss_sanitization_validation", async () => {
  assert.match(runtime, /replace\(\s*\/\[<>\]\//);
  assert.match(await readFile("frontend/app.js", "utf8"), /function esc/);
  assert.doesNotMatch(await readFile("frontend/app.js", "utf8"), /dangerouslySetInnerHTML|document\.write/);
});

await runTest("security_webhook_signature_policy_validation", async () => {
  assert.match(runtime, /verifyWebhookSignature/);
  assert.match(runtime, /PAYMENT_WEBHOOK_SECRET_IS_SAFE/);
  assert.match(runtime, /WEBHOOK_REPLAY_WINDOW_MS/);
  assert.match(await readFile("src/webhook_ingestion.ts", "utf8"), /ON CONFLICT|duplicate/i);
});

await runTest("security_idor_seller_ownership_validation", async () => {
  assert.match(runtime, /forbidden: you do not own this deal|seller is not authorized|WHERE deal_id=\$1 AND seller_id=\$2/);
});

await runTest("security_participant_tracking_access_validation", async () => {
  assert.match(mission, /SEC-P1-PARTICIPANT-BEARER-LINK/);
  assert.match(runtime, /app\.get\("\/api\/participants\/:id\/tracking"/);
  const trackingStart = runtime.indexOf('app.get("/api/participants/:id/tracking"');
  const trackingEnd = runtime.indexOf('app.post("/api/participants/:id/recovery"', trackingStart);
  assert.ok(trackingStart >= 0);
  assert.ok(trackingEnd > trackingStart);
  const trackingSlice = runtime.slice(trackingStart, trackingEnd);
  assert.doesNotMatch(trackingSlice, /card_number|cvv|cvc|raw_card/i);
});

await runTest("security_error_disclosure_validation", async () => {
  assert.match(app, /setErrorHandler/);
  assert.doesNotMatch(app, /error\.stack|stack:/);
});

await runTest("security_static_scan_validation", async () => {
  assert.doesNotMatch(allSource, /eval\(|new Function\(|dangerouslySetInnerHTML|document\.write/);
  assert.doesNotMatch(allSource, /child_process|exec\(|spawn\(/);
  assert.doesNotMatch(allSource, /postgres:\/\/postgres:861434Ml/);
  assert.match(packageJson, /"test:security-hardening"/);
});
