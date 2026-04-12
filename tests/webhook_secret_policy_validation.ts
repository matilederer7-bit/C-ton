import { strict as assert } from "node:assert";

const originalDeploymentMode = process.env.APP_DEPLOYMENT_MODE;
const originalWebhookSecret = process.env.PAYMENT_WEBHOOK_SECRET;

async function loadRuntimeConfig(caseId: string, env: {
  APP_DEPLOYMENT_MODE: string;
  PAYMENT_WEBHOOK_SECRET?: string;
}) {
  process.env.APP_DEPLOYMENT_MODE = env.APP_DEPLOYMENT_MODE;
  if (env.PAYMENT_WEBHOOK_SECRET === undefined) {
    delete process.env.PAYMENT_WEBHOOK_SECRET;
  } else {
    process.env.PAYMENT_WEBHOOK_SECRET = env.PAYMENT_WEBHOOK_SECRET;
  }

  return import(`../src/runtime_config.js?case=${encodeURIComponent(caseId)}&t=${Date.now()}`);
}

async function run(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

await run("demo-preview may use the explicit demo webhook secret", async () => {
  const payload = await loadRuntimeConfig("demo-explicit-default", {
    APP_DEPLOYMENT_MODE: "demo-preview",
    PAYMENT_WEBHOOK_SECRET: "mock-webhook-secret"
  });
  assert.equal(payload.APP_DEPLOYMENT_MODE, "demo-preview");
  assert.equal(payload.PAYMENT_WEBHOOK_SECRET, "mock-webhook-secret");
  assert.equal(payload.PAYMENT_WEBHOOK_SECRET_IS_DEFAULT, true);
  assert.equal(payload.PAYMENT_WEBHOOK_SECRET_IS_SAFE, true);
});

await run("non-demo runtime without an explicit webhook secret is unsafe", async () => {
  const payload = await loadRuntimeConfig("non-demo-missing", {
    APP_DEPLOYMENT_MODE: "internal-runtime",
    PAYMENT_WEBHOOK_SECRET: ""
  });
  assert.equal(payload.APP_DEPLOYMENT_MODE, "internal-runtime");
  assert.equal(payload.PAYMENT_WEBHOOK_SECRET, "");
  assert.equal(payload.PAYMENT_WEBHOOK_SECRET_IS_DEFAULT, true);
  assert.equal(payload.PAYMENT_WEBHOOK_SECRET_IS_SAFE, false);
});

await run("non-demo runtime with the demo default webhook secret is unsafe", async () => {
  const payload = await loadRuntimeConfig("non-demo-default", {
    APP_DEPLOYMENT_MODE: "internal-runtime",
    PAYMENT_WEBHOOK_SECRET: "mock-webhook-secret"
  });
  assert.equal(payload.PAYMENT_WEBHOOK_SECRET, "mock-webhook-secret");
  assert.equal(payload.PAYMENT_WEBHOOK_SECRET_IS_DEFAULT, true);
  assert.equal(payload.PAYMENT_WEBHOOK_SECRET_IS_SAFE, false);
});

await run("non-demo runtime with an explicit non-default secret is safe", async () => {
  const payload = await loadRuntimeConfig("non-demo-safe", {
    APP_DEPLOYMENT_MODE: "internal-runtime",
    PAYMENT_WEBHOOK_SECRET: "prod-secret-123"
  });
  assert.equal(payload.PAYMENT_WEBHOOK_SECRET, "prod-secret-123");
  assert.equal(payload.PAYMENT_WEBHOOK_SECRET_IS_DEFAULT, false);
  assert.equal(payload.PAYMENT_WEBHOOK_SECRET_IS_SAFE, true);
});

if (originalDeploymentMode === undefined) {
  delete process.env.APP_DEPLOYMENT_MODE;
} else {
  process.env.APP_DEPLOYMENT_MODE = originalDeploymentMode;
}

if (originalWebhookSecret === undefined) {
  delete process.env.PAYMENT_WEBHOOK_SECRET;
} else {
  process.env.PAYMENT_WEBHOOK_SECRET = originalWebhookSecret;
}
