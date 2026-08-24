import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { PUBLIC_MALL_DEAL_FIELDS } from "../src/mall_read_model.js";

const { Pool } = pg;

process.env.PORT = String(process.env.PORT || "3437");
process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.OTP_TEST_BYPASS_CODE = "424242";

const { app } = await import("../src/app.js");
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton",
  max: 5
});

async function run(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

type SeedDealInput = {
  sellerId: string;
  title: string;
  state: "Draft" | "PendingTarget" | "TargetReached" | "Completed" | "Failed" | "Cancelled";
  dealType: "physical_product" | "voucher" | "ticket";
  published: boolean;
  publishedOffsetMinutes: number;
};

async function seedDeal(input: SeedDealInput) {
  const dealId = randomUUID();
  await pool.query(
    `INSERT INTO siton.deals
       (deal_id, seller_id, title, description, state, deal_type,
        threshold_units, min_units, max_units, price_per_unit, deadline,
        published_at, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,90,1,100,42.50,now()+interval '7 days',
             CASE WHEN $7::boolean THEN now() + ($8::int * interval '1 minute') ELSE NULL END,
             now(),now())`,
    [
      dealId,
      input.sellerId,
      input.title,
      `Public summary for ${input.title}`,
      input.state,
      input.dealType,
      input.published,
      input.publishedOffsetMinutes
    ]
  );
  return dealId;
}

async function issueBuyerOtp(destination: string) {
  const requested = await app.inject({
    method: "POST",
    url: "/api/otp/request",
    payload: { channel: "sms", destination, purpose: "buyer_join" }
  });
  assert.equal(requested.statusCode, 200, requested.body);
  const challengeId = String(requested.json().challenge_id);
  const verified = await app.inject({
    method: "POST",
    url: "/api/otp/verify",
    payload: { challenge_id: challengeId, code: "424242" }
  });
  assert.equal(verified.statusCode, 200, verified.body);
  return { challengeId, otpToken: String(verified.json().otp_token) };
}

async function joinDeal(args: {
  dealId: string;
  buyerId: string;
  source?: "direct" | "mall";
  mallSessionId?: string;
  affiliateRef?: string;
}) {
  const otp = await issueBuyerOtp(args.buyerId);
  return app.inject({
    method: "POST",
    url: `/deals/${args.dealId}/join`,
    headers: {
      "x-request-id": `mall-runtime-${randomUUID()}`,
      "idempotency-key": `mall-runtime-${randomUUID()}`
    },
    payload: {
      buyer_id: args.buyerId,
      qty: 1,
      buyer_terms_accepted: true,
      payment_disclosure_accepted: true,
      otp_token: otp.otpToken,
      otp_challenge_id: otp.challengeId,
      ...(args.source ? { source: args.source } : {}),
      ...(args.mallSessionId ? { mall_session_id: args.mallSessionId } : {}),
      ...(args.affiliateRef ? { affiliate_ref: args.affiliateRef } : {})
    }
  });
}

const sellerId = `seller-mall-${randomUUID().slice(0, 8)}`;
await pool.query(
  `INSERT INTO siton.seller_accounts (seller_id, display_name, business_name, support_email)
   VALUES ($1,'Mall fallback name','Mall Business','mall-support@example.invalid')
   ON CONFLICT (seller_id) DO UPDATE SET business_name=EXCLUDED.business_name`,
  [sellerId]
);

const underwayPhysical = await seedDeal({
  sellerId,
  title: "Mall underway physical",
  state: "PendingTarget",
  dealType: "physical_product",
  published: true,
  publishedOffsetMinutes: -4
});
const underwayTicket = await seedDeal({
  sellerId,
  title: "Mall underway ticket",
  state: "PendingTarget",
  dealType: "ticket",
  published: true,
  publishedOffsetMinutes: -3
});
const succeededVoucher = await seedDeal({
  sellerId,
  title: "Mall succeeded voucher",
  state: "Completed",
  dealType: "voucher",
  published: true,
  publishedOffsetMinutes: -2
});
const failedTicket = await seedDeal({
  sellerId,
  title: "Mall failed ticket",
  state: "Failed",
  dealType: "ticket",
  published: true,
  publishedOffsetMinutes: -1
});
const draftDeal = await seedDeal({
  sellerId,
  title: "Mall must never expose this Draft",
  state: "Draft",
  dealType: "physical_product",
  published: false,
  publishedOffsetMinutes: 0
});
const unpublishedCanonicalDeal = await seedDeal({
  sellerId,
  title: "Mall must never expose unpublished canonical deal",
  state: "PendingTarget",
  dealType: "physical_product",
  published: false,
  publishedOffsetMinutes: 0
});

await run("M1 Mall returns only published canonical projections from a strict public allowlist", async () => {
  const response = await app.inject({ method: "GET", url: "/api/mall/deals?status=all&sort=newest&limit=48" });
  assert.equal(response.statusCode, 200, response.body);
  assert.match(String(response.headers["cache-control"] || ""), /public/);
  const body = response.json() as any;
  assert.equal(body.ok, true);
  const seededIds = new Set<string>([underwayPhysical, underwayTicket, succeededVoucher, failedTicket]);
  const seededRows = body.deals.filter((row: any) => seededIds.has(String(row.deal_id)));
  assert.equal(seededRows.length, 4, response.body);
  assert.ok(!body.deals.some((row: any) => row.deal_id === draftDeal));
  assert.ok(!body.deals.some((row: any) => row.deal_id === unpublishedCanonicalDeal));

  const allowed = new Set([
    ...PUBLIC_MALL_DEAL_FIELDS,
    "state",
    "primary_image",
    "progress_to_target_pct",
    "availability"
  ]);
  const forbidden = [
    "seller_id",
    "buyer_id",
    "buyer_email",
    "buyer_phone",
    "storage_key",
    "authorization_id",
    "payment_reference",
    "ledger_id"
  ];
  for (const row of seededRows) {
    for (const key of Object.keys(row)) assert.ok(allowed.has(key), `unexpected public Mall field: ${key}`);
    for (const key of forbidden) assert.equal(Object.hasOwn(row, key), false, `private field leaked: ${key}`);
    assert.equal(row.seller_business_name, "Mall Business");
    assert.equal(row.visibility, "public");
  }
  for (const privateValue of [sellerId, "mall-support@example.invalid"]) {
    assert.equal(response.body.includes(privateValue), false, `private value leaked: ${privateValue}`);
  }
});

await run("M2 Mall filters and opaque cursor pagination are bounded and stable", async () => {
  const voucher = await app.inject({
    method: "GET",
    url: "/api/mall/deals?type=voucher&status=succeeded&sort=oldest&limit=48"
  });
  assert.equal(voucher.statusCode, 200, voucher.body);
  assert.ok(voucher.json().deals.some((row: any) => row.deal_id === succeededVoucher));
  assert.ok(voucher.json().deals.every((row: any) => row.deal_type === "voucher" && row.mall_status === "succeeded"));

  const firstPage = await app.inject({
    method: "GET",
    url: "/api/mall/deals?status=underway&sort=oldest&limit=1"
  });
  assert.equal(firstPage.statusCode, 200, firstPage.body);
  const firstBody = firstPage.json() as any;
  assert.equal(firstBody.deals.length, 1);
  assert.equal(firstBody.page.has_more, true);
  assert.match(String(firstBody.page.next_cursor), /^[A-Za-z0-9_-]+$/);

  const secondPage = await app.inject({
    method: "GET",
    url: `/api/mall/deals?status=underway&sort=oldest&limit=1&cursor=${encodeURIComponent(firstBody.page.next_cursor)}`
  });
  assert.equal(secondPage.statusCode, 200, secondPage.body);
  assert.equal(secondPage.json().deals.length, 1);
  assert.notEqual(secondPage.json().deals[0].deal_id, firstBody.deals[0].deal_id);

  const wrongScope = await app.inject({
    method: "GET",
    url: `/api/mall/deals?type=ticket&status=underway&sort=oldest&limit=1&cursor=${encodeURIComponent(firstBody.page.next_cursor)}`
  });
  assert.equal(wrongScope.statusCode, 400, wrongScope.body);
  assert.equal(wrongScope.json().code, "mall_cursor_invalid");

  const invalidType = await app.inject({ method: "GET", url: "/api/mall/deals?type=private_inventory" });
  assert.equal(invalidType.statusCode, 400, invalidType.body);
  assert.equal(invalidType.json().code, "mall_type_invalid");
});

await run("M3 discovery events are retry-safe, PII-free, source-locked, and derive deal truth server-side", async () => {
  const rawClientEventId = `mall_event_${randomUUID()}`;
  const event = await app.inject({
    method: "POST",
    url: "/api/mall/events",
    payload: {
      event_type: "mall_deal_click",
      client_event_id: rawClientEventId,
      deal_id: underwayPhysical,
      deal_type: "ticket",
      mall_status: "failed",
      source: "mall",
      email: "must-not-persist@example.invalid",
      phone: "+972500000000",
      user_agent: "must-not-persist"
    }
  });
  assert.equal(event.statusCode, 202, event.body);
  assert.equal(event.json().accepted, true);
  assert.equal(event.headers["cache-control"], "no-store");

  const replay = await app.inject({
    method: "POST",
    url: "/api/mall/events",
    payload: {
      event_type: "mall_deal_click",
      client_event_id: rawClientEventId,
      deal_id: underwayPhysical,
      source: "mall"
    }
  });
  assert.equal(replay.statusCode, 202, replay.body);

  const persisted = await pool.query(
    `SELECT event_type, client_event_id, deal_id::text AS deal_id, deal_type, mall_status, acquisition_source
     FROM siton.discovery_events
     WHERE event_type='mall_deal_click' AND deal_id=$1`,
    [underwayPhysical]
  );
  assert.equal(persisted.rowCount, 1, "event replay must not duplicate telemetry");
  assert.equal(persisted.rows[0].event_type, "mall_deal_click");
  assert.notEqual(persisted.rows[0].client_event_id, rawClientEventId, "raw browser token must be one-way derived");
  assert.match(String(persisted.rows[0].client_event_id), /^evt_[0-9a-f]{64}$/);
  assert.equal(persisted.rows[0].deal_type, "physical_product", "client deal_type must not be authoritative");
  assert.equal(persisted.rows[0].mall_status, "underway", "client status must not be authoritative");
  assert.equal(persisted.rows[0].acquisition_source, "mall");

  const columns = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema='siton' AND table_name='discovery_events'`
  );
  const columnNames = new Set(columns.rows.map((row: any) => String(row.column_name)));
  for (const forbiddenColumn of ["email", "phone", "ip", "ip_address", "user_agent", "buyer_id", "seller_id"]) {
    assert.equal(columnNames.has(forbiddenColumn), false, `PII column must not exist: ${forbiddenColumn}`);
  }

  const draftEvent = await app.inject({
    method: "POST",
    url: "/api/mall/events",
    payload: {
      event_type: "mall_deal_click",
      client_event_id: `draft_event_${randomUUID()}`,
      deal_id: draftDeal,
      source: "mall"
    }
  });
  assert.equal(draftEvent.statusCode, 202, draftEvent.body);
  assert.equal(draftEvent.json().accepted, false);

  const wrongSource = await app.inject({
    method: "POST",
    url: "/api/mall/events",
    payload: { event_type: "mall_session", client_event_id: `direct_event_${randomUUID()}`, source: "direct" }
  });
  assert.equal(wrongSource.statusCode, 400, wrongSource.body);
  assert.equal(wrongSource.json().code, "mall_event_source_invalid");

  const piiAsIdentity = await app.inject({
    method: "POST",
    url: "/api/mall/events",
    payload: { event_type: "mall_session", client_event_id: "email@example.invalid", source: "mall" }
  });
  assert.equal(piiAsIdentity.statusCode, 400, piiAsIdentity.body);
  assert.equal(piiAsIdentity.json().code, "mall_client_event_id_invalid");

  const forgedJoin = await app.inject({
    method: "POST",
    url: "/api/mall/events",
    payload: {
      event_type: "mall_join",
      client_event_id: `forged_join_${randomUUID()}`,
      deal_id: underwayPhysical,
      source: "mall"
    }
  });
  assert.equal(forgedJoin.statusCode, 400, forgedJoin.body);
  assert.equal(forgedJoin.json().code, "mall_event_type_invalid");
  const forgedJoinRows = await pool.query(
    `SELECT COUNT(*)::int AS count FROM siton.discovery_events
     WHERE event_type='mall_join' AND deal_id=$1 AND client_event_id LIKE 'evt_%'`,
    [underwayPhysical]
  );
  assert.equal(Number(forgedJoinRows.rows[0].count), 0, "public telemetry must not forge canonical mall_join acquisition events");
});

await run("M4 join persists direct, Mall, and verified distributor acquisition without changing commission", async () => {
  const affiliateCode = `mall-affiliate-${randomUUID().slice(0, 8)}`;
  await pool.query(
    `INSERT INTO siton.affiliate_accounts (affiliate_code, display_name, verification_status)
     VALUES ($1,'Mall test distributor','verified')`,
    [affiliateCode]
  );

  const directBuyer = `+97250${String(Date.now()).slice(-7)}`;
  const mallBuyer = `+97251${String(Date.now() + 1).slice(-7)}`;
  const distributorBuyer = `+97252${String(Date.now() + 2).slice(-7)}`;
  const direct = await joinDeal({ dealId: underwayPhysical, buyerId: directBuyer, source: "direct" });
  const mall = await joinDeal({
    dealId: underwayPhysical,
    buyerId: mallBuyer,
    source: "mall",
    mallSessionId: `mall_session_${randomUUID()}`
  });
  const distributor = await joinDeal({
    dealId: underwayPhysical,
    buyerId: distributorBuyer,
    source: "mall",
    mallSessionId: `mall_session_${randomUUID()}`,
    affiliateRef: affiliateCode
  });
  for (const response of [direct, mall, distributor]) assert.equal(response.statusCode, 200, response.body);
  assert.equal(direct.json().acquisition_source, "direct");
  assert.equal(mall.json().acquisition_source, "mall");
  assert.equal(distributor.json().acquisition_source, "distributor", "valid affiliate attribution takes precedence");

  const sources = await pool.query(
    `SELECT buyer_id, acquisition_source FROM siton.participants
     WHERE deal_id=$1 AND buyer_id = ANY($2::text[])`,
    [underwayPhysical, [directBuyer, mallBuyer, distributorBuyer]]
  );
  const sourceByBuyer = new Map(sources.rows.map((row: any) => [String(row.buyer_id), String(row.acquisition_source)]));
  assert.equal(sourceByBuyer.get(directBuyer), "direct");
  assert.equal(sourceByBuyer.get(mallBuyer), "mall");
  assert.equal(sourceByBuyer.get(distributorBuyer), "distributor");

  const attribution = await pool.query(
    `SELECT attribution_id FROM siton.affiliate_attributions WHERE participant_id=$1`,
    [distributor.json().participant_id]
  );
  assert.equal(attribution.rowCount, 1, "verified distributor attribution must be recorded");
  const attributionColumns = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema='siton' AND table_name='affiliate_attributions'`
  );
  const attributionColumnNames = new Set(attributionColumns.rows.map((row: any) => String(row.column_name)));
  assert.equal(attributionColumnNames.has("commission_amount"), false);
  assert.equal(attributionColumnNames.has("commission_rate"), false);

  const invalidSource = await app.inject({
    method: "POST",
    url: `/deals/${underwayPhysical}/join`,
    payload: {
      buyer_id: "+972539999999",
      qty: 1,
      payment_disclosure_accepted: true,
      source: "advertising_network"
    }
  });
  assert.equal(invalidSource.statusCode, 400, invalidSource.body);
  assert.equal(invalidSource.json().code, "acquisition_source_invalid");
});

await pool.end();
await app.close();
console.log("All Mall runtime tests passed.");
