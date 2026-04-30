import { strict as assert } from "node:assert";
import { app } from "../src/app.js";

async function run(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

async function main() {
  await run("preview meta exposes demo guardrails", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/preview/meta"
    });
    assert.equal(response.statusCode, 200);
    const payload = response.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.preview.deployment_mode, "demo-preview");
    assert.equal(payload.preview.is_demo_preview, true);
    assert.equal(payload.preview.guardrails.payment_is_real, false);
    assert.equal(payload.preview.guardrails.invoice_is_real, false);
    assert.equal(payload.preview.guardrails.shipping_is_real, false);
    assert.equal(payload.preview.guardrails.payout_is_real, false);
    assert.equal(payload.preview.guardrails.kyc_is_real, false);
    assert.equal(payload.preview.operational_readiness.debug_surfaces.state, "disabled");
  });

  await run("integrations health reports deployment mode and mock-backed rails", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/health/integrations"
    });
    assert.equal(response.statusCode, 200);
    const payload = response.json();
    assert.equal(payload.deployment_mode, "demo-preview");
    assert.equal(payload.integrations.payment.mode, "mock-backed");
    assert.equal(payload.integrations.notifications.mode, "dev");
    assert.equal(payload.integrations.notifications.provider, "log-only");
    assert.equal(payload.operational_readiness.preview_demo_mode.state, "active-demo-preview");
  });

  await run("debug deal route stays blocked by default even in demo-preview", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/debug/deals/9e594fc6-7713-4005-8b42-edaf0bc520ed"
    });
    assert.equal(response.statusCode, 404);
  });

  await run("admin system status keeps explicit demo boundary", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/admin/system-status"
    });
    assert.equal(response.statusCode, 200);
    const payload = response.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.system_status.deployment.mode, "demo-preview");
    assert.equal(payload.system_status.deployment.is_demo_preview, true);
    assert.match(payload.system_status.notes.join(" "), /demo \/ preview/i);
  });
}

main()
  .then(async () => {
    await app.close();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error(error);
    await app.close().catch(() => undefined);
    process.exit(1);
  });
