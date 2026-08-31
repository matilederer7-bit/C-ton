import assert from "node:assert/strict";
import Fastify from "fastify";
import pg from "pg";

process.env.APP_DEPLOYMENT_MODE = "internal-runtime";
process.env.DISTRIBUTOR_SESSION_SECRET = "stage32d-distributor-session-test-secret";
process.env.BUYER_SESSION_SECRET = "stage32d-buyer-session-test-secret";
process.env.ADMIN_API_KEY = "stage32d-admin-key";
process.env.OTP_TEST_BYPASS_CODE = "424242";

const { Pool } = pg;
const { registerFrontendExperience } = await import("../src/frontend_runtime.js");

function withTransactions(pool: pg.Pool) {
  return async <T>(fn: (c: pg.PoolClient) => Promise<T>) => {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const result = await fn(c);
      await c.query("COMMIT");
      return result;
    } catch (error) {
      await c.query("ROLLBACK");
      throw error;
    } finally {
      c.release();
    }
  };
}

function fakePaymentProvider() {
  return {
    providerCode: "mockpay",
    mode: "mock-backed" as const,
    webhookProvider: "mockpay",
    configured: true,
    async authorize() {
      return { ok: true as const, provider: "mockpay", authorization_id: "auth", provider_reference: "ref", correlation_id: "corr", authorization: "authorized" as const, hold_message: "test", mock: true };
    },
    async capture() { return { provider: "mockpay", result_class: "success" as const, retryable: false, mock: true }; },
    async recover() { return { provider: "mockpay", result_class: "success" as const, retryable: false, mock: true }; },
    async refund() { return { provider: "mockpay", result_class: "success" as const, retryable: false, mock: true }; }
  };
}

function cookieFrom(response: any, name: string) {
  const raw = Array.isArray(response.headers["set-cookie"])
    ? String(response.headers["set-cookie"][0] || "")
    : String(response.headers["set-cookie"] || "");
  const match = new RegExp(`${name}=([^;]+)`).exec(raw);
  assert.ok(match, `${name} cookie must be issued`);
  return `${name}=${match[1]}`;
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

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const withTx = withTransactions(pool);
const app = Fastify();
registerFrontendExperience(app, {
  withTx,
  pool,
  paymentProvider: fakePaymentProvider(),
  deploymentMode: "internal-runtime",
  isDemoPreview: false,
  notificationSummary: { provider: "log-only", mode: "log-only", external_delivery: false },
  debugSurfacesEnabled: false
});

const affiliateA = "a0000000-0000-0000-0000-000000000001";
const affiliateB = "b0000000-0000-0000-0000-000000000002";
const dealA = "d0000000-0000-0000-0000-000000000001";
const dealB = "d0000000-0000-0000-0000-000000000002";
let deliveryOptionId = "";

async function seed() {
  await pool.query(
    `UPDATE siton.affiliate_accounts SET verification_status='verified' WHERE affiliate_id=$1`,
    [affiliateA]
  );
  await pool.query(
    `INSERT INTO siton.affiliate_accounts (affiliate_id, affiliate_code, display_name, verification_status)
     VALUES ($1,'affiliate-beta','Distributor Beta','verified') ON CONFLICT (affiliate_id) DO NOTHING`,
    [affiliateB]
  );
  for (const [dealId, title] of [[dealA, "Stage 32D Deal A"], [dealB, "Stage 32D Deal B"]]) {
    await pool.query(
      `INSERT INTO siton.deals
         (deal_id, seller_id, state, title, price_per_unit, min_units, max_units,
          threshold_units, deadline, published_at)
       VALUES ($1,'seller-default','PendingTarget',$2,50,1,10,9,now()+interval '1 day',now())
       ON CONFLICT (deal_id) DO NOTHING`,
      [dealId, title]
    );
  }
  const delivery = await pool.query(
    `INSERT INTO siton.deal_delivery_options (deal_id, option_type, label, cost, sort_order)
     VALUES ($1,'pickup','Pickup',0,0) RETURNING option_id`,
    [dealA]
  );
  deliveryOptionId = String(delivery.rows[0].option_id);
}

// R5C — distributor provisioning is an admin mutation requiring a named admin
// identity. Established lazily so app route registration completes first.
let _adminCookie = "";
async function adminCookie(): Promise<string> {
  if (!_adminCookie) {
    const { establishNamedAdminSession } = await import("./helpers/named_admin_session.js");
    _adminCookie = (await establishNamedAdminSession(app, pool)).cookie;
  }
  return _adminCookie;
}

async function provisionDistributor(affiliateId: string, email: string, accessCode: string) {
  const response = await app.inject({
    method: "POST",
    url: `/api/admin/distributor-auth/${affiliateId}/provision`,
    headers: { "x-admin-key": "stage32d-admin-key", cookie: await adminCookie() },
    payload: { login_email: email, access_code: accessCode, auth_enabled: true }
  });
  assert.equal(response.statusCode, 200, response.body);
}

async function loginDistributor(identifier: string, accessCode: string) {
  const response = await app.inject({
    method: "POST",
    url: "/api/distributor/session/login",
    payload: { identifier, access_code: accessCode }
  });
  assert.equal(response.statusCode, 200, response.body);
  return cookieFrom(response, "siton_distributor_session");
}

async function authenticateBuyer(phone: string, dealId = dealA) {
  const started = await app.inject({ method: "POST", url: "/api/otp/start", payload: { phone, deal_id: dealId } });
  assert.equal(started.statusCode, 200, started.body);
  const startBody = started.json() as any;
  const verified = await app.inject({
    method: "POST",
    url: "/api/otp/verify",
    payload: { challenge_id: startBody.challenge_id, code: startBody.development_code }
  });
  assert.equal(verified.statusCode, 200, verified.body);
  assert.equal((verified.json() as any).resume_session, true);
  return cookieFrom(verified, "siton_buyer_session");
}

try {
  await seed();

  await run("production distributor management fails closed without a server session", async () => {
    const session = await app.inject({ method: "GET", url: "/api/distributor/session" });
    const overview = await app.inject({ method: "GET", url: "/api/affiliate/overview" });
    const create = await app.inject({ method: "POST", url: "/api/affiliate/links", payload: { deal_id: dealA, internal_name: "anonymous" } });
    assert.equal(session.statusCode, 401);
    assert.equal(overview.statusCode, 401);
    assert.equal(create.statusCode, 401);
  });

  await provisionDistributor(affiliateA, "alpha@example.test", "alpha-password");
  await provisionDistributor(affiliateB, "beta@example.test", "beta-password");
  const cookieA = await loginDistributor("affiliate-demo", "alpha-password");
  const cookieB = await loginDistributor("beta@example.test", "beta-password");

  let sourceCode = "";
  await run("named links are owned by the authenticated distributor and client tenant IDs are rejected", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/affiliate/links",
      headers: { cookie: cookieA },
      payload: { deal_id: dealA, internal_name: "Alpha owned link" }
    });
    assert.equal(created.statusCode, 201, created.body);
    sourceCode = String((created.json() as any).link.source_code);
    const forged = await app.inject({
      method: "POST",
      url: "/api/affiliate/links",
      headers: { cookie: cookieB },
      payload: { deal_id: dealA, internal_name: "forged", affiliate_id: affiliateA }
    });
    assert.equal(forged.statusCode, 400);
  });

  await run("distributor aggregates are tenant-isolated and contain neither buyer PII nor financial entitlement", async () => {
    const sessionA = await app.inject({ method: "GET", url: "/api/distributor/session", headers: { cookie: cookieA } });
    const overviewA = await app.inject({ method: "GET", url: "/api/affiliate/overview", headers: { cookie: cookieA } });
    const overviewB = await app.inject({ method: "GET", url: "/api/affiliate/overview", headers: { cookie: cookieB } });
    assert.equal(sessionA.statusCode, 200, sessionA.body);
    assert.equal(overviewA.statusCode, 200, overviewA.body);
    assert.equal(overviewB.statusCode, 200, overviewB.body);
    assert.match(overviewA.body, new RegExp(sourceCode));
    assert.doesNotMatch(overviewB.body, new RegExp(sourceCode));
    for (const forbidden of ["buyer_phone", "buyer_email", "buyer_name", "admin_note", "auth_secret_hash", "commission", "balance", "wallet", "payout", "withdrawal", "invoice_entitlement"]) {
      assert.doesNotMatch(sessionA.body, new RegExp(`"${forbidden}"`, "i"));
      assert.doesNotMatch(overviewA.body, new RegExp(`"${forbidden}"`, "i"));
    }
  });

  await run("buyer resume stores only allowlisted server context and survives simulated cross-device authentication", async () => {
    const cookieOne = await authenticateBuyer("0501234567");
    const unsafe = await app.inject({
      method: "PUT",
      url: `/api/buyer/resume/${dealA}`,
      headers: { cookie: cookieOne },
      payload: { selected_quantity: 2, otp_token: "forbidden" }
    });
    assert.equal(unsafe.statusCode, 400);
    const saved = await app.inject({
      method: "PUT",
      url: `/api/buyer/resume/${dealA}`,
      headers: { cookie: cookieOne },
      payload: { selected_quantity: 2, delivery_option_id: deliveryOptionId, attribution_ref: sourceCode, workflow_position: "payment" }
    });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.doesNotMatch(saved.body, /phone|otp|authorization|payment_token|tracking|secret/i);

    const cookieTwo = await authenticateBuyer("0501234567");
    const resumed = await app.inject({ method: "GET", url: `/api/buyer/resume/${dealA}`, headers: { cookie: cookieTwo } });
    assert.equal(resumed.statusCode, 200, resumed.body);
    const body = (resumed.json() as any).resume;
    assert.equal(body.selected_quantity, 2);
    assert.equal(body.delivery_option_id, deliveryOptionId);
    assert.equal(body.attribution_ref, sourceCode);
  });

  await run("buyer resume rejects wrong buyer, wrong deal, forged IDs, expiry and changed inventory", async () => {
    const ownerCookie = await authenticateBuyer("0507654321");
    const saved = await app.inject({
      method: "PUT",
      url: `/api/buyer/resume/${dealA}`,
      headers: { cookie: ownerCookie },
      payload: { selected_quantity: 2, delivery_option_id: deliveryOptionId, workflow_position: "payment" }
    });
    assert.equal(saved.statusCode, 200, saved.body);
    const wrongBuyerCookie = await authenticateBuyer("0500000001");
    assert.equal((await app.inject({ method: "GET", url: `/api/buyer/resume/${dealA}`, headers: { cookie: wrongBuyerCookie } })).statusCode, 404);
    assert.equal((await app.inject({ method: "GET", url: `/api/buyer/resume/${dealB}`, headers: { cookie: ownerCookie } })).statusCode, 401);
    assert.equal((await app.inject({ method: "GET", url: "/api/buyer/resume/not-a-uuid", headers: { cookie: ownerCookie } })).statusCode, 400);

    await pool.query(
      `INSERT INTO siton.participants (deal_id,buyer_id,qty,buyer_state,money_state)
       VALUES ($1,'inventory-change',9,'JoinedAuthorized','AuthHeld')`,
      [dealA]
    );
    const inventoryChanged = await app.inject({ method: "GET", url: `/api/buyer/resume/${dealA}`, headers: { cookie: ownerCookie } });
    assert.equal(inventoryChanged.statusCode, 409);
    assert.equal((inventoryChanged.json() as any).error, "inventory_changed");

    await pool.query(`DELETE FROM siton.participants WHERE deal_id=$1 AND buyer_id='inventory-change'`, [dealA]);
    await pool.query(
      `UPDATE siton.buyer_resume_contexts
       SET created_at=now()-interval '2 days', expires_at=now()-interval '1 day'
       WHERE deal_id=$1`,
      [dealA]
    );
    const expired = await app.inject({ method: "GET", url: `/api/buyer/resume/${dealA}`, headers: { cookie: ownerCookie } });
    assert.equal(expired.statusCode, 410);
  });

  await run("identity schema contains no distributor financial columns or sensitive buyer resume fields", async () => {
    const columns = await pool.query(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema='siton' AND table_name IN ('affiliate_accounts','affiliate_links','affiliate_link_events','distributor_sessions','buyer_resume_contexts')`
    );
    const names = columns.rows.map((row) => `${row.table_name}.${row.column_name}`).join("\n");
    assert.doesNotMatch(names, /commission|balance|wallet|payout|withdrawal|invoice_entitlement/i);
    assert.doesNotMatch(names, /otp|phone|payment_token|authorization_token|tracking_credential|secret$/i);
  });
} finally {
  await app.close();
  await pool.end();
}
