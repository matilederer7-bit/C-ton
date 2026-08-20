import assert from "node:assert/strict";

process.env.ADMIN_API_KEY = "mission-control-admin-key";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.PORT = "3485";

const { app } = await import("../src/app.js");
const ADMIN_HEADERS = { "x-admin-key": "mission-control-admin-key" };

try {
  const unauthorizedStatus = await app.inject({ method: "GET", url: "/api/admin/system-status" });
  assert.equal(unauthorizedStatus.statusCode, 401);
  const mission = await app.inject({ method: "GET", url: "/api/admin/mission-control", headers: ADMIN_HEADERS });
  assert.equal(mission.statusCode, 200, mission.body);
  const body = mission.json() as any;
  assert.ok(body.system_status.outbox);
  assert.ok(body.system_status.payments);
  assert.ok(body.system_status.invoices);
  assert.ok(body.system_status.payouts);
  assert.equal(body.action_policy.manual_capture_enabled, false);
  assert.equal(body.action_policy.manual_refund_enabled, false);
  assert.equal(body.action_policy.manual_void_enabled, false);
  assert.equal(body.action_policy.manual_payout_enabled, false);
  assert.equal(body.action_policy.state_override_enabled, false);
  const systemStatus = await app.inject({ method: "GET", url: "/api/admin/system-status", headers: ADMIN_HEADERS });
  assert.equal(systemStatus.statusCode, 200, systemStatus.body);
  const systemBody = systemStatus.json() as any;
  assert.ok(["GREEN", "AMBER", "RED"].includes(systemBody.system_status.infrastructure.status));
  assert.ok(systemBody.system_status.infrastructure.recommendation);
  assert.equal(systemBody.system_status.compute_management.enabled, false);
  const unauthorizedUpgrade = await app.inject({
    method: "POST",
    url: "/api/admin/infrastructure/compute-upgrade",
    headers: { "idempotency-key": "unauthorized-compute-upgrade" },
    payload: { current_tier: "micro", target_tier: "small", downtime_acknowledged: true }
  });
  assert.equal(unauthorizedUpgrade.statusCode, 401);
  console.log("PASS mission control system status exposes rails with forbidden actions disabled");
} finally {
  await app.close().catch(() => undefined);
}
