import { strict as assert } from "node:assert";
import pg from "pg";

async function run(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

await run("non-demo create and publish derive seller authority from the server session", async () => {
  process.env.APP_DEPLOYMENT_MODE = "internal-runtime";
  process.env.SELLER_SESSION_SECRET = "seller-session-secret-authority";
  process.env.PORT = "3048";

  const { buildSellerSessionToken, serializeSellerSessionCookie } = await import(`../src/seller_auth.js?seller-auth-app-${Date.now()}`);
  const { app } = await import(`../src/app.js?seller-auth-app-${Date.now()}`);
  const { Pool } = pg;
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton"
  });

  const alphaToken = buildSellerSessionToken(
    {
      seller_id: "seller-alpha",
      display_name: "Seller Alpha",
      iat: Date.now(),
      exp: Date.now() + 60 * 60 * 1000
    },
    process.env.SELLER_SESSION_SECRET
  );
  const betaToken = buildSellerSessionToken(
    {
      seller_id: "seller-beta",
      display_name: "Seller Beta",
      iat: Date.now(),
      exp: Date.now() + 60 * 60 * 1000
    },
    process.env.SELLER_SESSION_SECRET
  );
  const alphaCookie = serializeSellerSessionCookie(alphaToken, 60 * 60);
  const betaCookie = serializeSellerSessionCookie(betaToken, 60 * 60);

  try {
    const denied = await app.inject({
      method: "POST",
      url: "/deals",
      payload: {
        title: "Denied without session",
        price_per_unit: 20,
        min_units: 10,
        max_units: 20,
        deadline: new Date(Date.now() + 45 * 60_000).toISOString(),
        commission_rate: 0.08
      }
    });
    assert.equal(denied.statusCode, 401);

    const create = await app.inject({
      method: "POST",
      url: "/deals",
      headers: {
        cookie: alphaCookie,
        "x-seller-id": "seller-beta",
        "x-request-id": `seller-auth-create-${Date.now()}`,
        "idempotency-key": `seller-auth-create-${Date.now()}`
      },
      payload: {
        title: `Seller Auth Owned Deal ${Date.now()}`,
        price_per_unit: 25,
        min_units: 10,
        max_units: 20,
        deadline: new Date(Date.now() + 45 * 60_000).toISOString(),
        commission_rate: 0.08
      }
    });
    assert.equal(create.statusCode, 200);
    const created = create.json() as any;
    const ownership = await pool.query(`SELECT seller_id FROM siton.deals WHERE deal_id=$1`, [created.deal_id]);
    assert.equal(String(ownership.rows[0].seller_id), "seller-alpha");

    const wrongPublish = await app.inject({
      method: "POST",
      url: `/deals/${created.deal_id}/publish`,
      headers: {
        cookie: betaCookie,
        "x-seller-id": "seller-alpha",
        "x-request-id": `seller-auth-publish-wrong-${Date.now()}`,
        "idempotency-key": `seller-auth-publish-wrong-${created.deal_id}`
      },
      payload: {}
    });
    assert.equal(wrongPublish.statusCode, 404);

    const rightPublish = await app.inject({
      method: "POST",
      url: `/deals/${created.deal_id}/publish`,
      headers: {
        cookie: alphaCookie,
        "x-seller-id": "seller-beta",
        "x-request-id": `seller-auth-publish-right-${Date.now()}`,
        "idempotency-key": `seller-auth-publish-right-${created.deal_id}`
      },
      payload: {}
    });
    assert.equal(rightPublish.statusCode, 200);
  } finally {
    await pool.end();
    await app.close().catch(() => {});
  }
});

process.exit(0);
