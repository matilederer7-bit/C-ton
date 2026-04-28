import assert from "node:assert/strict";

process.env.ADMIN_API_KEY = "mission-control-admin-key";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.PORT = "3484";

const { app } = await import("../src/app.js");

try {
  const res = await app.inject({
    method: "GET",
    url: "/api/admin/mission-control",
    headers: { "x-admin-key": "mission-control-admin-key" }
  });
  assert.equal(res.statusCode, 200, res.body);
  const serialized = JSON.stringify(res.json()).toLowerCase();
  for (const forbidden of ["commission", "affiliate_fee", "revenue_share", "withdrawal"]) {
    assert.ok(!serialized.includes(forbidden), `${forbidden} must not appear in mission control response`);
  }
  console.log("PASS admin mission control keeps affiliates attribution-only without commission semantics");
} finally {
  await app.close().catch(() => undefined);
}
