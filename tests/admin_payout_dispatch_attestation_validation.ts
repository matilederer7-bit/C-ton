// Black-Sky follow-up — the admin action that resolves a payout
// dispatch_outcome_unknown case from an operator attestation is gated like the
// other sensitive money actions:
//   * without the proposed action_type migration the route answers 409 (never 500)
//   * attestation evidence is mandatory (outcome + provider reference, payout target)
//   * permission payout.resolve (SuperAdmin only), recent MFA, and four-eyes:
//     execute before approval and self-approval are refused
//   * an approved attestation for a batch without an open unknown case fails
//     closed with no side effect, and the admin_actions row is the audit trail
// The rail-level outcomes (paid / failed / refusals) are proven in
// seller_payout_rail_race_validation.ts.
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.PORT = "3154";
process.env.ADMIN_API_KEY = `attest-${randomUUID().slice(0, 8)}`;

const { app } = await import("../src/app.js");
const { pool } = await import("../src/db.js");
const { hashAdminPassword } = await import("../src/admin_identity.js");

let failed = 0;
async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (e: any) { console.error(`FAIL ${name}: ${e?.stack || e?.message}`); failed++; }
}

await app.inject({ method: "GET", url: "/api/admin/auth/me" });
async function admin(role: string, mfa: boolean) {
  const email = `attest-${role.toLowerCase()}-${randomUUID().slice(0, 6)}@siton.local`;
  await pool.query(
    `INSERT INTO siton.admin_users (email, display_name, role, status, password_hash, mfa_required, mfa_enabled)
     VALUES ($1,$1,$2,'Active',$3,$4,$4)`,
    [email, role, await hashAdminPassword("AttestPass123!"), mfa]
  );
  const login = await app.inject({ method: "POST", url: "/api/admin/auth/login", payload: { email, password: "AttestPass123!" } });
  assert.equal(login.statusCode, 200, login.body);
  let setCookie = login.headers["set-cookie"];
  if (mfa) {
    const ch = login.json() as any;
    const verify = await app.inject({ method: "POST", url: "/api/admin/auth/mfa/verify", payload: { mfa_challenge_id: ch.mfa_challenge_id, code: ch.dev_code } });
    assert.equal(verify.statusCode, 200, verify.body);
    setCookie = verify.headers["set-cookie"];
  }
  return { cookie: String(setCookie || "").split(";")[0] || "", "x-admin-key": String(process.env.ADMIN_API_KEY) };
}

const A = await admin("SuperAdmin", true);
const B = await admin("SuperAdmin", true);
const OPS = await admin("OpsAdmin", true);
const NO_MFA = await admin("SuperAdmin", false);

const valid = (overrides: Record<string, unknown> = {}) => ({
  action_type: "resolve_payout_dispatch_unknown",
  target_type: "payout",
  target_id: randomUUID(),
  reason: "provider console shows the transfer",
  idempotency_key: `attest-${randomUUID()}`,
  metadata: { attested_outcome: "paid", provider_reference: "PRV-TRANSFER-1234" },
  ...overrides
});
const create = (headers: Record<string, string>, payload: Record<string, unknown>) =>
  app.inject({ method: "POST", url: "/api/admin/actions", headers, payload });

await run("before the action_type migration the route answers 409, not 500", async () => {
  const res = await create(A, valid());
  assert.equal(res.statusCode, 409, res.body);
  assert.equal((res.json() as any).error, "admin_action_type_requires_migration");
});

// Apply the proposed migration to THIS isolated test database.
await pool.query(await readFile("docs/migration_proposals/078_admin_action_resolve_payout_dispatch_unknown.sql", "utf8"));

await run("attestation evidence is mandatory", async () => {
  for (const [payload, error] of [
    [valid({ metadata: { attested_outcome: "paid" } }), "provider_reference_required"],
    [valid({ metadata: { attested_outcome: "paid", provider_reference: "x" } }), "provider_reference_required"],
    [valid({ metadata: { attested_outcome: "refunded", provider_reference: "PRV-1234" } }), "attested_outcome_invalid"],
    [valid({ target_type: "deal" }), "target_type_must_be_payout"],
    [valid({ target_id: "not-a-uuid" }), "payout_batch_id_invalid"]
  ] as const) {
    const res = await create(A, payload as any);
    assert.equal(res.statusCode, 400, res.body);
    assert.equal((res.json() as any).error, error);
  }
});

await run("permission payout.resolve: OpsAdmin is refused; a SuperAdmin without recent MFA is refused", async () => {
  assert.equal((await create(OPS, valid())).statusCode, 403);
  assert.equal((await create(NO_MFA, valid())).statusCode, 403);
});

await run("four-eyes: awaiting approval, no execute before approval, no self-approval; approved -> fails closed without an open case, audited", async () => {
  const batchId = randomUUID();
  const created = await create(A, valid({ target_id: batchId }));
  assert.equal(created.statusCode, 200, created.body);
  const action = (created.json() as any).action;
  assert.equal(action.status, "AwaitingSecondApproval");
  assert.equal(action.requires_second_approval, true);
  const id = action.admin_action_id;

  const early = await app.inject({ method: "POST", url: `/api/admin/actions/${id}/execute`, headers: A, payload: {} });
  assert.equal(early.statusCode, 403, early.body);
  const self = await app.inject({ method: "POST", url: `/api/admin/actions/${id}/approve`, headers: A, payload: { reason: "self" } });
  assert.equal(self.statusCode, 403, self.body);
  assert.equal((self.json() as any).error, "self_approval_forbidden");
  const approved = await app.inject({ method: "POST", url: `/api/admin/actions/${id}/approve`, headers: B, payload: { reason: "checked the provider reference" } });
  assert.equal(approved.statusCode, 200, approved.body);

  const executed = await app.inject({ method: "POST", url: `/api/admin/actions/${id}/execute`, headers: A, payload: {} });
  assert.equal(executed.statusCode, 501, executed.body);
  const row = (executed.json() as any).action;
  assert.equal(row.status, "Failed");
  assert.equal(row.result_code, "PayoutDispatchUnknownNotResolved");
  assert.equal(row.result_message, "payout_batch_not_found");
  assert.ok(row.requested_by_admin_id && row.approved_by_admin_id && row.requested_by_admin_id !== row.approved_by_admin_id);
  const attempts = await pool.query(`SELECT count(*)::int AS n FROM siton.seller_payout_attempts WHERE correlation_id=$1`, [`admin-attestation:${id}`]);
  assert.equal(attempts.rows[0].n, 0, "no side effect for a batch without an open unknown case");
});

await app.close();
if (failed) process.exit(1);
console.log("PASS admin payout dispatch-unknown attestation gating");
