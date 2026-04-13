import { strict as assert } from "node:assert";
import Fastify from "fastify";
import { registerFrontendExperience } from "../src/frontend_runtime.js";

function fakeWithTx() {
  return async <T>(_fn: (c: any) => Promise<T>): Promise<T> => {
    throw new Error("withTx should not be reached in OTP-only validation");
  };
}

function fakePaymentProvider() {
  return {
    providerCode: "mockpay",
    mode: "mock-backed" as const,
    webhookProvider: "mockpay",
    configured: true,
    async authorize() {
      return {
        ok: true as const,
        provider: "mockpay",
        authorization_id: "auth_test",
        provider_reference: "ref_test",
        correlation_id: "corr_test",
        authorization: "authorized" as const,
        hold_message: "test",
        mock: true
      };
    },
    async capture() {
      return { provider: "mockpay", result_class: "success" as const, retryable: false, mock: true };
    },
    async recover() {
      return { provider: "mockpay", result_class: "success" as const, retryable: false, mock: true };
    },
    async refund() {
      return { provider: "mockpay", result_class: "success" as const, retryable: false, mock: true };
    }
  };
}

function buildOtpApp(isDemoPreview: boolean) {
  const app = Fastify();
  registerFrontendExperience(app, {
    withTx: fakeWithTx(),
    paymentProvider: fakePaymentProvider(),
    deploymentMode: isDemoPreview ? "demo-preview" : "internal-runtime",
    isDemoPreview,
    notificationSummary: {
      provider: "log-only",
      mode: "log-only",
      external_delivery: false
    },
    debugSurfacesEnabled: false
  });
  return app;
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

await run("demo-preview OTP returns a per-session development code", async () => {
  const app = buildOtpApp(true);
  try {
    const first = await app.inject({
      method: "POST",
      url: "/api/otp/start",
      payload: { phone: "0501234567" }
    });
    assert.equal(first.statusCode, 200);
    const firstJson = first.json() as any;
    assert.match(String(firstJson.development_code || ""), /^\d{6}$/);

    const second = await app.inject({
      method: "POST",
      url: "/api/otp/start",
      payload: { phone: "0501234567" }
    });
    assert.equal(second.statusCode, 200);
    const secondJson = second.json() as any;
    assert.match(String(secondJson.development_code || ""), /^\d{6}$/);
    assert.notEqual(firstJson.development_code, secondJson.development_code);

    const verify = await app.inject({
      method: "POST",
      url: "/api/otp/verify",
      payload: {
        otp_session_id: firstJson.otp_session_id,
        code: firstJson.development_code
      }
    });
    assert.equal(verify.statusCode, 200);
  } finally {
    await app.close();
  }
});

await run("non-demo OTP does not leak a development code and rejects guessed codes", async () => {
  const app = buildOtpApp(false);
  try {
    const start = await app.inject({
      method: "POST",
      url: "/api/otp/start",
      payload: { phone: "0507654321" }
    });
    assert.equal(start.statusCode, 200);
    const startJson = start.json() as any;
    assert.equal("development_code" in startJson, false);

    const guessed = await app.inject({
      method: "POST",
      url: "/api/otp/verify",
      payload: {
        otp_session_id: startJson.otp_session_id,
        code: "123456"
      }
    });
    assert.equal(guessed.statusCode, 400);
  } finally {
    await app.close();
  }
});

process.exit(0);
