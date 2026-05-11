import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import Fastify from "fastify";
import pg from "pg";
import { registerFrontendExperience } from "../src/frontend_runtime.js";

process.env.APP_DEPLOYMENT_MODE = "demo-preview";

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton",
  max: 5
});

async function withTx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL search_path TO siton, public");
    const result = await fn(c);
    await c.query("COMMIT");
    return result;
  } catch (error) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    c.release();
  }
}

function buildApp(calls: any[]) {
  const app = Fastify();
  registerFrontendExperience(app, {
    withTx,
    paymentProvider: {
      providerCode: "authority-test",
      mode: "mock-backed",
      webhookProvider: "authority-test",
      configured: true,
      async authorize(input: any) {
        calls.push(input);
        return {
          ok: true,
          provider: "authority-test",
          authorization_id: `auth_${calls.length}`,
          provider_reference: `auth_${calls.length}`,
          correlation_id: `corr_${calls.length}`,
          authorization: "authorized",
          hold_message: "test authorization",
          mock: true
        };
      },
      async capture() {
        return { provider: "authority-test", result_class: "success", retryable: false, mock: true };
      },
      async recover() {
        return { provider: "authority-test", result_class: "success", retryable: false, mock: true };
      },
      async refund() {
        return { provider: "authority-test", result_class: "success", retryable: false, mock: true };
      }
    },
    deploymentMode: "demo-preview",
    isDemoPreview: true,
    notificationSummary: { provider: "log-only", mode: "log-only", external_delivery: false },
    debugSurfacesEnabled: false
  });
  return app;
}

async function verifiedOtp(app: ReturnType<typeof Fastify>) {
  const phone = `050${String(Date.now()).slice(-7)}`;
  const start = await app.inject({ method: "POST", url: "/api/otp/start", payload: { phone } });
  assert.equal(start.statusCode, 200, start.body);
  const started = start.json() as any;
  const verify = await app.inject({
    method: "POST",
    url: "/api/otp/verify",
    payload: { otp_session_id: started.otp_session_id, code: started.development_code }
  });
  assert.equal(verify.statusCode, 200, verify.body);
  return verify.json() as any;
}

async function seedDeal() {
  const dealId = randomUUID();
  const optionId = randomUUID();
  await pool.query(
    `INSERT INTO siton.deals
       (deal_id, seller_id, title, state, price_per_unit, min_units, max_units, threshold_units, deadline, published_at, created_at, updated_at)
     VALUES ($1,'seller-authority','Authority Deal','PendingTarget',77.00,1,10,2,now()+interval '1 day',now(),now(),now())`,
    [dealId]
  );
  await pool.query(
    `INSERT INTO siton.deal_delivery_options(option_id, deal_id, option_type, label, cost, sort_order)
     VALUES ($1,$2,'delivery','Courier',12.00,1)`,
    [optionId, dealId]
  );
  return { dealId, optionId };
}

async function cleanup(dealId: string) {
  await pool.query(`DELETE FROM siton.legal_acceptances WHERE deal_id=$1`, [dealId]).catch(() => undefined);
  await pool.query(`DELETE FROM siton.participants WHERE deal_id=$1`, [dealId]).catch(() => undefined);
  await pool.query(`DELETE FROM siton.deals WHERE deal_id=$1`, [dealId]).catch(() => undefined);
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

await run("payment authorization ignores forged client amount and uses DB deal price plus DB delivery cost", async () => {
  const calls: any[] = [];
  const app = buildApp(calls);
  const { dealId, optionId } = await seedDeal();
  try {
    const otp = await verifiedOtp(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/payments/authorize",
      payload: {
        holder_name: "Buyer",
        card_number: "4111111111111111",
        expiry: "12/28",
        cvv: "123",
        amount_minor: 1,
        currency: "ILS",
        buyer_id: otp.buyer_id,
        deal_id: dealId,
        qty: 3,
        delivery_option_id: optionId,
        delivery_cost: 9999,
        platform_fee_total_amount: 1,
        seller_net_amount: 1,
        otp_token: otp.otp_token,
        otp_challenge_id: otp.challenge_id || otp.otp_session_id
      }
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].amount_minor, 24300);
  } finally {
    await cleanup(dealId);
    await app.close();
  }
});

await run("payment authorization requires OTP before provider authorization for deal money", async () => {
  const calls: any[] = [];
  const app = buildApp(calls);
  const { dealId, optionId } = await seedDeal();
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/payments/authorize",
      payload: {
        holder_name: "Buyer",
        card_number: "4111111111111111",
        expiry: "12/28",
        cvv: "123",
        amount_minor: 24300,
        currency: "ILS",
        buyer_id: "0500000000",
        deal_id: dealId,
        qty: 3,
        delivery_option_id: optionId
      }
    });
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(calls.length, 0);
  } finally {
    await cleanup(dealId);
    await app.close();
  }
});

await run("payment authorization rejects non-numeric and exponent quantity before provider authorization", async () => {
  const calls: any[] = [];
  const app = buildApp(calls);
  const { dealId, optionId } = await seedDeal();
  try {
    const otp = await verifiedOtp(app);
    for (const qty of [true, "1e2", "3", 1.5, 0, -1]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/payments/authorize",
        payload: {
          holder_name: "Buyer",
          card_number: "4111111111111111",
          expiry: "12/28",
          cvv: "123",
          amount_minor: 24300,
          currency: "ILS",
          buyer_id: otp.buyer_id,
          deal_id: dealId,
          qty,
          delivery_option_id: optionId,
          otp_token: otp.otp_token,
          otp_challenge_id: otp.challenge_id || otp.otp_session_id
        }
      });
      assert.equal(response.statusCode, 400, `qty=${String(qty)} body=${response.body}`);
    }
    assert.equal(calls.length, 0);
  } finally {
    await cleanup(dealId);
    await app.close();
  }
});

await run("join route uses the same strict quantity parser before max_units math", async () => {
  const appSource = await readFile("src/app.ts", "utf8");
  assert.match(appSource, /function parsePositiveIntegerQuantity/);
  assert.match(appSource, /qtyRaw = parsePositiveIntegerQuantity\(body\.qty, 1\)/);
  assert.doesNotMatch(appSource, /const qtyRaw = Number\(body\.qty \?\? 1\)/);
});

await pool.end();
