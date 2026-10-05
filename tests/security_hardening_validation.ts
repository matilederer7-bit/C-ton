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
// seller fulfillment, delivery and export routes moved out of frontend_runtime.ts (Lean Refactor);
// the CSV/Excel-injection and seller-ownership checks keep reading them
const runtimeWithSellerFulfillment = runtime + "\n" + (await readFile("src/seller_fulfillment_routes.ts", "utf8"));
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
  await readFile("src/platform_fee_money.ts", "utf8"),
  // moved out of frontend_runtime.ts by the Lean Refactor; stays in the static scan
  await readFile("src/legal_html.ts", "utf8"),
  // moved out of app.ts by the Lean Refactor; stays in the static scan
  await readFile("src/http_security_headers.ts", "utf8"),
  // Mission Control routes moved out of frontend_runtime.ts by the Lean Refactor; stay in the static scan
  await readFile("src/admin_mission_control_routes.ts", "utf8"),
  // /health + /readiness moved out of app.ts by the Lean Refactor; stay in the static scan
  await readFile("src/operational_health_routes.ts", "utf8"),
  // seller deal image mutation routes moved out of app.ts; keep their auth/storage surface in the scan
  await readFile("src/seller_deal_image_routes.ts", "utf8"),
  // support routes moved out of frontend_runtime.ts by the Lean Refactor; stay in the static scan
  await readFile("src/support_routes.ts", "utf8"),
  // seller fulfillment, delivery and export routes moved out of frontend_runtime.ts by the Lean Refactor; stay in the static scan
  await readFile("src/seller_fulfillment_routes.ts", "utf8"),
  // admin control-center (R6) read routes moved out of frontend_runtime.ts by the Lean Refactor; stay in the static scan
  await readFile("src/admin_control_center_routes.ts", "utf8"),
  // admin pilot / growth / viral read routes moved out of frontend_runtime.ts by the Lean Refactor; stay in the static scan
  await readFile("src/admin_growth_routes.ts", "utf8"),
  // the admin demo-readiness read moved out of frontend_runtime.ts by the Lean Refactor; stays in the static scan
  await readFile("src/admin_demo_readiness_routes.ts", "utf8"),
  // the admin ops overview reads (payment-ops-status, overview, launch-console) moved out of frontend_runtime.ts by the Lean Refactor; stay in the static scan
  await readFile("src/admin_ops_overview_routes.ts", "utf8")
].join("\n");

await runTest("security_admin_auth_validation", async () => {
  assert.match(runtime, /function requireAdminKey/);
  assert.match(runtime, /admin_key_not_configured/);
  assert.match(runtime, /timingSafeEqual/);
  // the Mission Control routes live in src/admin_mission_control_routes.ts since the Lean Refactor; same guard, same registration
  const missionControlRoutes = await readFile("src/admin_mission_control_routes.ts", "utf8");
  assert.match(missionControlRoutes, /app\.get\("\/api\/admin\/mission-control"/);
  assert.match(missionControlRoutes, /if \(!\(await requireAdminRead\(req, reply\)\)\) return;/);
  // R6: admin READ surfaces gate through requireAdminRead (named identity via
  // Supabase/cookie, or the timing-safe ops key inside requireAdminKey).
  assert.match(runtime, /function requireAdminRead/);
  // the admin read routes moved out of frontend_runtime.ts (Lean Refactor) still count toward the bound
  const adminReadSurfaces = runtime + "\n" + (await readFile("src/admin_control_center_routes.ts", "utf8")) + "\n" + (await readFile("src/admin_growth_routes.ts", "utf8")) + "\n" + (await readFile("src/admin_demo_readiness_routes.ts", "utf8")) + "\n" + (await readFile("src/admin_ops_overview_routes.ts", "utf8"));
  assert.ok((adminReadSurfaces.match(/await requireAdminRead\(req, reply\)/g) || []).length >= 10);
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
  // The response headers live in src/http_security_headers.ts (moved out of app.ts
  // by the Lean Refactor); app.ts applies them on every request (onRequest hook).
  const headers = await readFile("src/http_security_headers.ts", "utf8");
  assert.match(app, /applySecurityHeaders\(reply\);/);
  for (const header of ["x-content-type-options", "referrer-policy", "x-frame-options", "permissions-policy"]) {
    assert.match(headers, new RegExp(header));
  }
  assert.match(headers, /nosniff/);
  assert.match(headers, /no-referrer/);
  assert.match(headers, /DENY/);
  // Red-team hardening (A6): HSTS is emitted on production-like hosts (only),
  // so a downgrade/SSL-strip cannot expose session cookies or payment traffic.
  assert.match(headers, /if \(isProductionLikeEnv\(\)\) \{\s*reply\.header\("strict-transport-security", "max-age=31536000; includeSubDomains"\);/);
});

await runTest("security_api_no_store_validation", async () => {
  // classifier in src/http_security_headers.ts; the no-store header is set by app.ts's onRequest hook
  const headers = await readFile("src/http_security_headers.ts", "utf8");
  assert.match(headers, /path\.startsWith\("\/api\/"\)/);
  assert.match(headers, /path\.startsWith\("\/webhooks\/"\)/);
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
  assert.match(runtimeWithSellerFulfillment, /Prevent formula injection/);
  assert.ok(runtimeWithSellerFulfillment.includes("/^[=+\\-@]/") || runtimeWithSellerFulfillment.includes("/^[=\\-+@*]/"));
  assert.match(runtimeWithSellerFulfillment, /function safeTextDH/);
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
  assert.match(runtimeWithSellerFulfillment, /forbidden: you do not own this deal|seller is not authorized|WHERE deal_id=\$1 AND seller_id=\$2/);
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
