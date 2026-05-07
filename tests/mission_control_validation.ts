import assert from "node:assert/strict";

process.env.ADMIN_API_KEY = "mission-control-secret-value";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.PORT = "3491";
process.env.PAYMENT_PROVIDER_API_KEY = "sk_test_mission_control_must_not_leak";
process.env.PAYMENT_WEBHOOK_SECRET = "whsec_mission_control_must_not_leak";
process.env.DEBUG_SURFACES_ACCESS_KEY = "debug_secret_must_not_leak";

const { app } = await import("../src/app.js");

const ADMIN_HEADERS = { "x-admin-key": "mission-control-secret-value" };

async function run(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

try {
  await run("mission_control_admin_auth_validation", async () => {
    const blocked = await app.inject({ method: "GET", url: "/api/admin/mission-control" });
    assert.equal(blocked.statusCode, 401);

    const allowed = await app.inject({ method: "GET", url: "/api/admin/mission-control", headers: ADMIN_HEADERS });
    assert.equal(allowed.statusCode, 200, allowed.body);
  });

  await run("mission_control_response_contract_validation", async () => {
    const res = await app.inject({ method: "GET", url: "/api/admin/mission-control", headers: ADMIN_HEADERS });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as any;
    assert.ok(["green", "yellow", "red"].includes(body.verdict));
    for (const key of [
      "system_summary",
      "frontend_surface",
      "api_surface",
      "database",
      "state_machine_integrity",
      "outbox",
      "workers",
      "webhooks",
      "payments",
      "invoices",
      "payouts",
      "notifications",
      "security",
      "storage_uploads",
      "performance",
      "business_metrics",
      "anomaly_center",
      "recommended_actions"
    ]) {
      assert.ok(body[key], `missing section ${key}`);
    }
    assert.ok(Array.isArray(body.anomaly_center.anomalies));
    for (const anomaly of body.anomaly_center.anomalies) {
      assert.ok(["info", "warning", "critical"].includes(anomaly.severity));
      assert.ok(anomaly.domain);
      assert.ok(anomaly.title);
      assert.ok("safe_admin_action_available" in anomaly);
    }
  });

  await run("mission_control_security_masking_validation", async () => {
    const res = await app.inject({ method: "GET", url: "/api/admin/mission-control", headers: ADMIN_HEADERS });
    assert.equal(res.statusCode, 200, res.body);
    const text = res.body;
    assert.ok(!text.includes("mission-control-secret-value"));
    assert.ok(!text.includes("sk_test_mission_control_must_not_leak"));
    assert.ok(!text.includes("whsec_mission_control_must_not_leak"));
    assert.ok(!text.includes("debug_secret_must_not_leak"));
    assert.equal((res.json() as any).payments.secret_presence.PAYMENT_PROVIDER_API_KEY.configured, true);
  });

  await run("mission_control_anomalies_endpoint_validation", async () => {
    const res = await app.inject({ method: "GET", url: "/api/admin/mission-control/anomalies", headers: ADMIN_HEADERS });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as any;
    assert.ok(["green", "yellow", "red"].includes(body.verdict));
    assert.ok(Array.isArray(body.anomaly_center.anomalies));
    assert.ok(Array.isArray(body.recommended_actions));
  });

  await run("mission_control_no_destructive_actions_validation", async () => {
    const forbidden = await app.inject({
      method: "POST",
      url: "/api/admin/mission-control/outbox/00000000-0000-0000-0000-000000000001",
      headers: ADMIN_HEADERS
    });
    assert.notEqual(forbidden.statusCode, 200);

    const contract = await app.inject({ method: "GET", url: "/api/admin/mission-control", headers: ADMIN_HEADERS });
    const body = contract.json() as any;
    assert.equal(body.action_policy.manual_capture_enabled, false);
    assert.equal(body.action_policy.manual_refund_enabled, false);
    assert.equal(body.action_policy.manual_payout_enabled, false);
    assert.ok(body.recommended_actions.every((action: any) => action.destructive === false));
  });

  await run("mission_control_drilldown_auth_validation", async () => {
    const blocked = await app.inject({
      method: "GET",
      url: "/api/admin/mission-control/correlation/test-correlation"
    });
    assert.equal(blocked.statusCode, 401);

    const allowed = await app.inject({
      method: "GET",
      url: "/api/admin/mission-control/correlation/test-correlation",
      headers: ADMIN_HEADERS
    });
    assert.equal(allowed.statusCode, 200, allowed.body);
    assert.ok(["missing", "partial", "present"].includes((allowed.json() as any).correlation_id_support));
  });
} finally {
  await app.close().catch(() => undefined);
}
