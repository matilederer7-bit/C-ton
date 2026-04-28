import assert from "node:assert/strict";

process.env.ADMIN_API_KEY = "mission-control-admin-key";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.PORT = "3485";

const { app } = await import("../src/app.js");
const ADMIN_HEADERS = { "x-admin-key": "mission-control-admin-key" };

try {
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
  console.log("PASS mission control system status exposes rails with forbidden actions disabled");
} finally {
  await app.close().catch(() => undefined);
}
