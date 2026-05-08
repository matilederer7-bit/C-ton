import assert from "node:assert/strict";

process.env.ADMIN_API_KEY = "control-plane-admin-key";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.PORT = "3492";
process.env.PAYMENT_PROVIDER_API_KEY = "sk_control_plane_must_not_leak";

const { app } = await import("../src/app.js");
const { pool } = await import("../src/db.js");
const { hashAdminPassword } = await import("../src/admin_identity.js");

let ADMIN_HEADERS: Record<string, string> = {
  "x-admin-key": "control-plane-admin-key",
  "x-admin-user": "admin-a",
  "x-request-id": "req-control-plane-test",
  "x-correlation-id": "corr-control-plane-test"
};
const RUN_ID = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

async function run(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

async function postAction(payload: Record<string, unknown>, headers = ADMIN_HEADERS) {
  return app.inject({
    method: "POST",
    url: "/api/admin/actions",
    headers,
    payload
  });
}

async function loginAdmin(email: string, password: string) {
  const login = await app.inject({ method: "POST", url: "/api/admin/auth/login", payload: { email, password } });
  assert.equal(login.statusCode, 200, login.body);
  const body = login.json() as any;
  const verify = await app.inject({
    method: "POST",
    url: "/api/admin/auth/mfa/verify",
    payload: { mfa_challenge_id: body.mfa_challenge_id, code: body.dev_code }
  });
  assert.equal(verify.statusCode, 200, verify.body);
  const cookie = String(verify.headers["set-cookie"] || "").split(";")[0] || "";
  assert.match(cookie, /siton_admin_session=/);
  return cookie;
}

async function seedAdmin(email: string, password: string, role: string) {
  const passwordHash = await hashAdminPassword(password);
  await pool.query(
    `INSERT INTO siton.admin_users (email, display_name, role, status, password_hash, mfa_required, mfa_enabled)
     VALUES ($1,$2,$3,'Active',$4,true,true)
     ON CONFLICT (email) DO UPDATE
     SET role=EXCLUDED.role, status='Active', password_hash=EXCLUDED.password_hash,
         mfa_required=true, mfa_enabled=true, updated_at=now()`,
    [email, email, role, passwordHash]
  );
}

try {
  await app.inject({ method: "GET", url: "/api/admin/auth/me", headers: ADMIN_HEADERS });
  await seedAdmin("admin-a@siton.local", "AdminPassA123!", "SuperAdmin");
  await seedAdmin("admin-b@siton.local", "AdminPassB123!", "SuperAdmin");
  const adminACookie = await loginAdmin("admin-a@siton.local", "AdminPassA123!");
  const adminBCookie = await loginAdmin("admin-b@siton.local", "AdminPassB123!");
  ADMIN_HEADERS = { ...ADMIN_HEADERS, cookie: adminACookie };
  await run("correlation_request_headers_validation", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/mission-control",
      headers: ADMIN_HEADERS
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.headers["x-request-id"], "req-control-plane-test");
    assert.equal(res.headers["x-correlation-id"], "corr-control-plane-test");
  });

  await run("mission_control_correlation_trace_validation", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/mission-control/correlation/corr-control-plane-test",
      headers: ADMIN_HEADERS
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as any;
    assert.ok(["missing", "partial"].includes(body.correlation_id_support));
    assert.ok(body.correlation_coverage);
  });

  await run("admin_actions_auth_validation", async () => {
    const list = await app.inject({ method: "GET", url: "/api/admin/actions" });
    assert.equal(list.statusCode, 401);
    const create = await app.inject({ method: "POST", url: "/api/admin/actions", payload: {} });
    assert.equal(create.statusCode, 401);
  });

  await run("admin_actions_create_validation", async () => {
    let res = await postAction({ action_type: "open_support_case", target_type: "system", target_id: "x", idempotency_key: "cp-missing-reason" });
    assert.equal(res.statusCode, 400);
    assert.equal((res.json() as any).error, "reason_required");

    res = await postAction({ action_type: "open_support_case", target_type: "system", target_id: "x", reason: "reason" });
    assert.equal(res.statusCode, 400);
    assert.equal((res.json() as any).error, "idempotency_key_required");

    res = await postAction({ action_type: "not_real", target_type: "system", target_id: "x", reason: "reason", idempotency_key: "cp-invalid-action" });
    assert.equal(res.statusCode, 400);

    res = await postAction({ action_type: "open_support_case", target_type: "not_real", target_id: "x", reason: "reason", idempotency_key: "cp-invalid-target" });
    assert.equal(res.statusCode, 400);
  });

  await run("admin_actions_idempotency_validation", async () => {
    const payload = {
      action_type: "open_support_case",
      target_type: "system",
      target_id: "idempotent-target",
      reason: "בדיקת idempotency",
      idempotency_key: `cp-idem-open-support-${RUN_ID}`
    };
    const first = await postAction(payload);
    const second = await postAction(payload);
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(second.statusCode, 200, second.body);
    assert.equal((first.json() as any).action.admin_action_id, (second.json() as any).action.admin_action_id);
  });

  await run("admin_actions_forbidden_actions_validation", async () => {
    const res = await postAction({
      action_type: "manual_capture",
      target_type: "payment",
      target_id: "pay-1",
      reason: "must be forbidden",
      idempotency_key: `cp-forbidden-capture-${RUN_ID}`
    });
    assert.equal(res.statusCode, 403);
    assert.equal((res.json() as any).error, "admin_action_forbidden");
  });

  await run("admin_actions_second_approval_validation", async () => {
    const created = await postAction({
      action_type: "freeze_payouts",
      target_type: "seller",
      target_id: `seller-control-plane-${RUN_ID}`,
      reason: "חריג payout לבדיקה",
      idempotency_key: `cp-freeze-second-approval-${RUN_ID}`
    });
    assert.equal(created.statusCode, 200, created.body);
    const action = (created.json() as any).action;
    assert.equal(action.requires_second_approval, true);

    const beforeApproval = await app.inject({
      method: "POST",
      url: `/api/admin/actions/${action.admin_action_id}/execute`,
      headers: ADMIN_HEADERS
    });
    assert.equal(beforeApproval.statusCode, 403);

    const selfApproval = await app.inject({
      method: "POST",
      url: `/api/admin/actions/${action.admin_action_id}/approve`,
      headers: ADMIN_HEADERS,
      payload: { reason: "self approval should fail" }
    });
    assert.equal(selfApproval.statusCode, 403);

    const approved = await app.inject({
      method: "POST",
      url: `/api/admin/actions/${action.admin_action_id}/approve`,
      headers: { ...ADMIN_HEADERS, cookie: adminBCookie, "x-admin-user": "admin-b" },
      payload: { reason: "אישור מנהל שני" }
    });
    assert.equal(approved.statusCode, 200, approved.body);
    assert.equal((approved.json() as any).action.status, "Approved");
  });

  await run("admin_actions_execute_readiness_validation", async () => {
    // After Phase 5, trigger_reconcile is implemented as a non-money internal
    // dry-run that opens or reuses a PaymentMismatch support case. It does not
    // call a live provider. Execution is therefore Completed with a
    // ReconcileDryRunOpened result code, never NotImplemented.
    const created = await postAction({
      action_type: "trigger_reconcile",
      target_type: "deal",
      target_id: "00000000-0000-0000-0000-000000000001",
      reason: "בדיקת dry-run reconcile",
      idempotency_key: `cp-reconcile-dry-run-${RUN_ID}`
    });
    assert.equal(created.statusCode, 200, created.body);
    const action = (created.json() as any).action;
    const executed = await app.inject({
      method: "POST",
      url: `/api/admin/actions/${action.admin_action_id}/execute`,
      headers: ADMIN_HEADERS
    });
    assert.equal(executed.statusCode, 200, executed.body);
    const executedBody = executed.json() as any;
    assert.equal(executedBody.action.status, "Completed");
    assert.ok(["ReconcileDryRunOpened", "ReconcileDryRunFailed"].includes(executedBody.action.result_code));
    assert.match(String(executedBody.action.result_message || ""), /לא בוצעה קריאה לספק חי/);
  });

  await run("admin_actions_no_state_mutation_validation", async () => {
    const before = await pool.query(`SELECT COUNT(*)::int AS count FROM siton.deals WHERE state='Completed'`);
    const created = await postAction({
      action_type: "open_support_case",
      target_type: "system",
      target_id: `no-state-mutation-${RUN_ID}`,
      reason: "בדיקה שאין שינוי state",
      idempotency_key: `cp-no-state-mutation-${RUN_ID}`
    });
    assert.equal(created.statusCode, 200, created.body);
    const after = await pool.query(`SELECT COUNT(*)::int AS count FROM siton.deals WHERE state='Completed'`);
    assert.equal(Number(before.rows[0].count), Number(after.rows[0].count));
  });

  await run("admin_actions_secret_masking_validation", async () => {
    const res = await app.inject({ method: "GET", url: "/api/admin/actions", headers: ADMIN_HEADERS });
    assert.equal(res.statusCode, 200, res.body);
    assert.ok(!res.body.includes("control-plane-admin-key"));
    assert.ok(!res.body.includes("sk_control_plane_must_not_leak"));
  });
} finally {
  await app.close().catch(() => undefined);
  await pool.end().catch(() => undefined);
}
