import assert from "node:assert/strict";
import { cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app } from "../src/app.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, "..", "..");
const frontendSource = join(repoRoot, "frontend");
const frontendTarget = join(repoRoot, ".tmp_test_dist", "frontend");

async function runTest(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

async function ensureFrontendAssets() {
  await mkdir(frontendTarget, { recursive: true });
  await cp(frontendSource, frontendTarget, { recursive: true, force: true });
}

async function createDeal(title: string, suffix: string) {
  const unique = `${suffix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const response = await app.inject({
    method: "POST",
    url: "/deals",
    headers: {
      "x-request-id": `frontend-test-create-${unique}`,
      "idempotency-key": `frontend-test-create-${unique}`
    },
    payload: {
      title,
      price_per_unit: 42,
      min_units: 10,
      max_units: 20,
      deadline: new Date(Date.now() + 30 * 60_000).toISOString()
    }
  });

  assert.equal(response.statusCode, 200);
  return response.json() as { deal_id: string };
}

async function publishDeal(dealId: string, suffix: string) {
  const unique = `${suffix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const response = await app.inject({
    method: "POST",
    url: `/deals/${dealId}/publish`,
    headers: {
      "x-request-id": `frontend-test-publish-${unique}`,
      "idempotency-key": `frontend-test-publish-${unique}`
    },
    payload: {}
  });

  assert.equal(response.statusCode, 200);
}

async function main() {
  await ensureFrontendAssets();

  await runTest("frontend asset is served with payment adapter and polling hooks", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/app/assets/app.js"
    });

    assert.equal(response.statusCode, 200);
    assert.match(response.body, /paymentService/);
    assert.match(response.body, /setInterval/);
  });

  await runTest("public deal shell renders for a published deal", async () => {
    const created = await createDeal("Frontend Shell Deal", "shell");
    await publishDeal(created.deal_id, "shell");

    const response = await app.inject({
      method: "GET",
      url: `/app/deal/${created.deal_id}`
    });

    assert.equal(response.statusCode, 200);
    assert.match(response.body, /\/app\/assets\/app\.js/);
  });

  await runTest("draft deals stay non-joinable through the public API", async () => {
    const created = await createDeal("Frontend Draft Deal", "draft");

    const response = await app.inject({
      method: "GET",
      url: `/api/deals/${created.deal_id}/public`
    });

    assert.equal(response.statusCode, 200);
    const payload = response.json() as any;
    assert.equal(payload.deal.state, "Draft");
    assert.equal(payload.availability.canJoin, false);
  });

  await runTest("frontend happy path works through OTP, payment, join, and tracking", async () => {
    const created = await createDeal("Frontend Flow Deal", "flow");
    await publishDeal(created.deal_id, "flow");

    const otpStart = await app.inject({
      method: "POST",
      url: "/api/otp/start",
      payload: { phone: "0501234567" }
    });
    assert.equal(otpStart.statusCode, 200);
    const otpStartJson = otpStart.json() as any;

    const otpVerify = await app.inject({
      method: "POST",
      url: "/api/otp/verify",
      payload: {
        otp_session_id: otpStartJson.otp_session_id,
        code: "123456"
      }
    });
    assert.equal(otpVerify.statusCode, 200);
    const otpVerifyJson = otpVerify.json() as any;

    const payment = await app.inject({
      method: "POST",
      url: "/api/payments/authorize-mock",
      payload: {
        holder_name: "Frontend Buyer",
        card_number: "4111111111111111",
        expiry: "12/28",
        cvv: "123"
      }
    });
    assert.equal(payment.statusCode, 200);

    const join = await app.inject({
      method: "POST",
      url: `/deals/${created.deal_id}/join`,
      headers: {
        "x-request-id": "frontend-test-join-flow",
        "idempotency-key": `frontend-test-join-${created.deal_id}`
      },
      payload: {
        buyer_id: otpVerifyJson.buyer_id,
        qty: 3
      }
    });
    assert.equal(join.statusCode, 200);
    const joinJson = join.json() as any;
    assert.ok(joinJson.participant_id);

    const tracking = await app.inject({
      method: "GET",
      url: `/api/participants/${joinJson.participant_id}/tracking`
    });
    assert.equal(tracking.statusCode, 200);
    const trackingJson = tracking.json() as any;
    assert.equal(trackingJson.tracking.buyer_state, "JoinedAuthorized");
    assert.equal(trackingJson.tracking.money_state, "AuthHeld");

    const trackingShell = await app.inject({
      method: "GET",
      url: `/app/track/${joinJson.participant_id}`
    });
    assert.equal(trackingShell.statusCode, 200);
  });

  await runTest("frontend error branches stay available", async () => {
    const dealNotFound = await app.inject({
      method: "GET",
      url: "/api/deals/00000000-0000-0000-0000-000000000000/public"
    });
    assert.equal(dealNotFound.statusCode, 404);

    const otpStart = await app.inject({
      method: "POST",
      url: "/api/otp/start",
      payload: { phone: "0507654321" }
    });
    const otpStartJson = otpStart.json() as any;

    const invalidOtp = await app.inject({
      method: "POST",
      url: "/api/otp/verify",
      payload: {
        otp_session_id: otpStartJson.otp_session_id,
        code: "000000"
      }
    });
    assert.equal(invalidOtp.statusCode, 400);

    const paymentFailure = await app.inject({
      method: "POST",
      url: "/api/payments/authorize-mock",
      payload: {
        holder_name: "Failure Buyer",
        card_number: "4111111111110000",
        expiry: "12/28",
        cvv: "123"
      }
    });
    assert.equal(paymentFailure.statusCode, 402);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
