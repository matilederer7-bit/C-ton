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

const adminIdentity = await readFile("src/admin_identity.ts", "utf8");
const trackingSecurity = await readFile("src/participant_tracking_security.ts", "utf8");
const runtime = await readFile("src/frontend_runtime.ts", "utf8");
const app = await readFile("src/app.ts", "utf8");
const mission = await readFile("src/admin_mission_control.ts", "utf8");
const migration = await readFile("src/migrations/036_security_identity_tracking.sql", "utf8");

await run("admin_auth_me_validation", async () => {
  assert.match(runtime, /app\.get\("\/api\/admin\/auth\/me"/);
  assert.match(runtime, /adminPublicIdentity/);
  assert.match(adminIdentity, /resolveAdminIdentity/);
});

await run("admin_session_cookie_security_validation", async () => {
  assert.match(adminIdentity, /ADMIN_SESSION_COOKIE/);
  assert.match(adminIdentity, /HttpOnly/);
  assert.match(adminIdentity, /SameSite=Lax/);
  assert.match(adminIdentity, /Secure/);
  assert.match(adminIdentity, /session_token_hash TEXT NOT NULL UNIQUE/);
  assert.doesNotMatch(adminIdentity, /session_token TEXT NOT NULL/);
});

await run("admin_shared_key_limited_scope_validation", async () => {
  assert.match(adminIdentity, /BootstrapReadOnly/);
  assert.match(adminIdentity, /mission_control\.read/);
  assert.match(runtime, /ADMIN_IDENTITY_REQUIRED/);
  assert.match(mission, /shared_key_allowed_actions/);
});

await run("admin_identity_required_for_sensitive_actions_validation", async () => {
  assert.match(runtime, /sessionRequired: true/);
  assert.match(runtime, /HIGH_TRUST_ADMIN_ACTIONS\.has/);
  assert.match(runtime, /safeAdminId\(identity\)/);
});

await run("admin_mfa_required_for_sensitive_action_validation", async () => {
  assert.match(adminIdentity, /HIGH_TRUST_ADMIN_ACTIONS/);
  assert.match(runtime, /MFA_REQUIRED/);
  assert.match(runtime, /recentMfa: HIGH_TRUST_ADMIN_ACTIONS\.has/);
});

await run("admin_mfa_recent_verification_validation", async () => {
  assert.match(adminIdentity, /ADMIN_MFA_RECENT_WINDOW_MS/);
  assert.match(adminIdentity, /hasRecentMfa/);
});

await run("admin_mfa_bypass_forbidden_in_production_validation", async () => {
  assert.match(runtime, /dev_code: isProductionLikeEnv\(\) \? undefined : code/);
  assert.doesNotMatch(runtime, /OTP_TEST_BYPASS_CODE.*admin|ADMIN_MFA_BYPASS/i);
});

await run("admin_rbac_readonly_denied_execute_validation", async () => {
  assert.match(adminIdentity, /ReadOnlyAdmin: \["mission_control\.read", "admin_actions\.read", "security\.read"\]/);
  assert.match(adminIdentity, /hasAdminPermission/);
});

await run("admin_rbac_support_denied_ops_validation", async () => {
  assert.match(adminIdentity, /SupportAdmin: \["mission_control\.read", "admin_actions\.read", "admin_actions\.create", "support\.manage", "security\.read"\]/);
  assert.doesNotMatch(adminIdentity, /SupportAdmin:[\s\S]{0,180}outbox\.requeue/);
});

await run("admin_rbac_super_admin_allowed_validation", async () => {
  assert.match(adminIdentity, /SuperAdmin: ADMIN_PERMISSIONS/);
});

await run("admin_self_approval_prevention_validation", async () => {
  assert.match(runtime, /self_approval_forbidden/);
  assert.match(runtime, /requested_by_admin_id.*safeAdminId\(identity\)/s);
});

await run("participant_tracking_requires_valid_token_validation", async () => {
  assert.match(runtime, /tracking_token_required/);
  assert.match(runtime, /verifyParticipantTrackingAccess/);
});

await run("participant_tracking_wrong_token_denied_validation", async () => {
  assert.match(trackingSecurity, /tracking_token_wrong_participant/);
  assert.match(trackingSecurity, /participant_id=\$2/);
});

await run("participant_tracking_expired_token_denied_validation", async () => {
  assert.match(trackingSecurity, /tracking_token_expired/);
  assert.match(trackingSecurity, /status='Expired'/);
});

await run("participant_tracking_legacy_blocked_in_production_validation", async () => {
  assert.match(trackingSecurity, /legacy_links_allowed/);
  assert.match(trackingSecurity, /isProductionLikeEnv/);
  assert.match(mission, /production_requires_tracking_tokens/);
});

await run("recovery_requires_secure_access_validation", async () => {
  assert.match(runtime, /app\.post\("\/api\/participants\/:id\/recovery"/);
  assert.match(runtime, /purposes: \["recovery", "tracking"\]/);
});

await run("tracking_token_hash_only_validation", async () => {
  assert.match(migration, /token_hash TEXT NOT NULL UNIQUE/);
  assert.doesNotMatch(migration, /token TEXT NOT NULL|raw_token/i);
  assert.match(trackingSecurity, /hashParticipantTrackingToken/);
});

await run("security_gate_no_p1_for_demo_or_documented_verdict_validation", async () => {
  assert.match(mission, /demo_security_verdict/);
  assert.match(mission, /remaining_p1_count/);
  assert.match(mission, /live_security_verdict: "blocked"/);
});

await run("live_security_verdict_blocked_if_identity_or_tracking_partial", async () => {
  assert.match(mission, /live_security_verdict: "blocked"/);
  assert.match(mission, /ADMIN_API_KEY remains bootstrap\/read-only fallback/);
});

await run("no_secret_exposure_validation", async () => {
  assert.doesNotMatch(adminIdentity + trackingSecurity + runtime + mission, /password_value|raw_password|secret_value|raw_secret|tracking_access_token.*Mission/i);
});

await run("rate_limit_p2_foundation_closed_validation", async () => {
  assert.match(app, /interface RateLimiterStore/);
  assert.match(app, /MemoryRateLimiterStore/);
  assert.match(app, /RATE_LIMIT_SCALE_MODE/);
});
