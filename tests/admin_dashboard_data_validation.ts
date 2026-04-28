import assert from "node:assert/strict";

process.env.ADMIN_API_KEY = "mission-control-admin-key";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.PORT = "3481";

const { app } = await import("../src/app.js");
const ADMIN_HEADERS = { "x-admin-key": "mission-control-admin-key" };

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
  await run("mission control requires admin key", async () => {
    const res = await app.inject({ method: "GET", url: "/api/admin/mission-control" });
    assert.equal(res.statusCode, 401);
  });

  await run("mission control returns dashboard summary and exception cards", async () => {
    const res = await app.inject({ method: "GET", url: "/api/admin/mission-control", headers: ADMIN_HEADERS });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as any;
    assert.equal(body.ok, true);
    assert.ok(["green", "yellow", "red"].includes(body.system.status));
    assert.equal(typeof body.generated_at, "string");
    assert.equal(body.stale_after_seconds, 60);
    assert.ok(Array.isArray(body.exception_cards));
    assert.ok(body.system_status.outbox);
    assert.ok(body.system_status.payments);
    assert.ok(body.system_status.invoices);
    assert.ok(body.system_status.payouts);
  });
} finally {
  await app.close().catch(() => undefined);
}
