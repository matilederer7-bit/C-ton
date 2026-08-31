import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import {
  SELLER_AUTH_PRODUCT_CODES,
  safeSellerReturnTo,
  sellerAuthFailurePayload
} from "../src/seller_auth.js";

const { Pool } = pg;

async function run(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

await run("S1 seller auth failures expose stable product codes and explicit recovery semantics", async () => {
  const required = sellerAuthFailurePayload("required", { returnTo: "/app/seller/new?resume=draft" });
  assert.equal(required.code, SELLER_AUTH_PRODUCT_CODES.required);
  assert.equal(required.product_code, "SELLER_AUTH_REQUIRED");
  assert.equal(required.seller_auth.reason, "required");
  assert.equal(required.seller_auth.reauthentication_required, false);
  assert.equal(required.seller_auth.return_to, "/app/seller/new?resume=draft");

  const expired = sellerAuthFailurePayload("expired", { returnTo: "/app/seller" });
  assert.equal(expired.code, SELLER_AUTH_PRODUCT_CODES.expired);
  assert.equal(expired.product_code, "SELLER_SESSION_EXPIRED");
  assert.equal(expired.seller_auth.reason, "expired");
  assert.equal(expired.seller_auth.reauthentication_required, true);

  const forbidden = sellerAuthFailurePayload("forbidden", { reasonCode: "SELLER_SUSPENDED" });
  assert.equal(forbidden.code, "SELLER_SUSPENDED", "specific policy reason remains actionable");
  assert.equal(forbidden.product_code, "SELLER_FORBIDDEN", "stable product family code must remain present");
  assert.equal(forbidden.reason_code, "SELLER_SUSPENDED");
  assert.equal(forbidden.seller_auth.reason, "forbidden");

  const unavailable = sellerAuthFailurePayload("unavailable");
  assert.equal(unavailable.product_code, "SELLER_AUTH_UNAVAILABLE");
});

await run("S2 seller return_to accepts only same-origin seller product routes", async () => {
  const dealId = "00000000-0000-4000-8000-000000000001";
  assert.equal(safeSellerReturnTo("/app/seller"), "/app/seller");
  assert.equal(safeSellerReturnTo("/app/seller/new?resume=draft"), "/app/seller/new?resume=draft");
  assert.equal(
    safeSellerReturnTo(`/app/seller/deals/${dealId}?mode=edit`),
    `/app/seller/deals/${dealId}?mode=edit`
  );
  assert.equal(safeSellerReturnTo("/app/seller#seller-profile-section"), "/app/seller#seller-profile-section");
  assert.equal(safeSellerReturnTo("/app/seller#untrusted-fragment"), "/app/seller");

  for (const unsafe of [
    "https://evil.example/app/seller",
    "//evil.example/app/seller",
    "/app/admin",
    "/app/seller/../../admin",
    "\\\\evil.example\\app\\seller",
    "/app/seller\u0000/new"
  ]) {
    assert.equal(safeSellerReturnTo(unsafe), "/app/seller", `unsafe return_to accepted: ${JSON.stringify(unsafe)}`);
  }
  assert.equal(safeSellerReturnTo("/app/seller", "https://evil.example"), "/app/seller");
});

process.env.PORT = String(process.env.PORT || "3441");
process.env.APP_DEPLOYMENT_MODE = "internal-runtime";
process.env.SELLER_SESSION_SECRET = "seller-creation-depth-session-secret";
process.env.DISABLE_OUTBOX_WORKER = "1";

const { app } = await import("../src/app.js");
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton",
  max: 4
});
const { establishNamedAdminSession } = await import("./helpers/named_admin_session.js");

const RAW_DB_MESSAGE = "RAW_DB_DIAGNOSTIC_MUST_NOT_LEAK";
const RAW_DB_CODE = "23505";
app.get("/__test/v1-1/internal-error-envelope", async () => {
  const error: any = new Error(RAW_DB_MESSAGE);
  error.code = RAW_DB_CODE;
  throw error;
});

// R5C — seller provisioning is an admin mutation requiring a named admin
// identity. Established after all test route registration so the first inject
// (which readies the app) does not block later app.get registration.
const { cookie: ADMIN_COOKIE } = await establishNamedAdminSession(app, pool);

function asCookie(value: string | string[] | undefined) {
  return Array.isArray(value) ? String(value[0] || "") : String(value || "");
}

async function provisionActiveSeller(prefix: string) {
  const sellerId = `${prefix}-${randomUUID().slice(0, 12)}`;
  const loginEmail = `${sellerId}@example.invalid`;
  const accessCode = `depth-${randomUUID()}-pass`;
  const provisioned = await app.inject({
    method: "POST",
    url: `/api/admin/seller-auth/${sellerId}/provision`,
    headers: { cookie: ADMIN_COOKIE },
    payload: {
      display_name: `Seller ${prefix}`,
      login_email: loginEmail,
      access_code: accessCode,
      auth_enabled: true
    }
  });
  assert.equal(provisioned.statusCode, 200, provisioned.body);
  const login = await app.inject({
    method: "POST",
    url: "/api/seller/session/login",
    payload: { identifier: loginEmail, access_code: accessCode }
  });
  assert.equal(login.statusCode, 200, login.body);
  const cookie = asCookie(login.headers["set-cookie"]);
  assert.match(cookie, /siton_seller_session=/);
  return { sellerId, cookie };
}

function validDraftPayload(overrides: Record<string, unknown> = {}) {
  return {
    title: `Seller closure Draft ${randomUUID().slice(0, 8)}`,
    description: "V1.1 closure regression",
    deal_type: "physical_product",
    price_per_unit: 35,
    min_units: 2,
    max_units: 12,
    deadline: new Date(Date.now() + 4 * 60 * 60_000).toISOString(),
    delivery_options: [{ option_type: "delivery", label: "Delivery", cost: 19, sort_order: 0 }],
    ...overrides
  };
}

const voucherTerms = (suffix: string) => ({
  face_value_amount: 140,
  currency: "ILS",
  valid_until: new Date(Date.now() + 30 * 24 * 60 * 60_000).toISOString(),
  redemption_location: `Voucher location ${suffix}`,
  redemption_instructions: `Voucher instructions ${suffix}`,
  terms: `Voucher terms ${suffix}`,
  is_single_use: true,
  allow_partial_redemption: false,
  voucher_code_mode: "system_generated"
});

const ticketTerms = (suffix: string) => ({
  event_name: `Ticket event ${suffix}`,
  event_starts_at: new Date(Date.now() + 10 * 24 * 60 * 60_000).toISOString(),
  event_ends_at: new Date(Date.now() + 10 * 24 * 60 * 60_000 + 2 * 60 * 60_000).toISOString(),
  venue_name: `Venue ${suffix}`,
  venue_address: "1 Closure Street",
  venue_city: "Tel Aviv",
  entry_instructions: `Ticket instructions ${suffix}`,
  ticket_type: "general_admission",
  seat_mode: "general_admission",
  transfer_allowed: false
});

await run("S3 real seller endpoints distinguish required and expired 401 with safe continuation", async () => {
  const required = await app.inject({
    method: "GET",
    url: "/api/seller/deals",
    headers: { "x-siton-return-to": "/app/seller/new?resume=draft" }
  });
  assert.equal(required.statusCode, 401, required.body);
  assert.equal(required.json().code, "SELLER_AUTH_REQUIRED");
  assert.equal(required.json().product_code, "SELLER_AUTH_REQUIRED");
  assert.equal(required.json().seller_auth.reason, "required");
  assert.equal(required.json().seller_auth.return_to, "/app/seller/new?resume=draft");

  const expired = await app.inject({
    method: "GET",
    url: "/api/seller/deals",
    headers: {
      cookie: "siton_seller_session=expired-or-unknown-token",
      "x-siton-return-to": "https://evil.example/steal-session"
    }
  });
  assert.equal(expired.statusCode, 401, expired.body);
  assert.equal(expired.json().code, "SELLER_SESSION_EXPIRED");
  assert.equal(expired.json().product_code, "SELLER_SESSION_EXPIRED");
  assert.equal(expired.json().seller_auth.reason, "expired");
  assert.equal(expired.json().seller_auth.reauthentication_required, true);
  assert.equal(expired.json().seller_auth.return_to, "/app/seller");
});

await run("S4 suspended seller gets stable 403 product code without creating a Draft", async () => {
  const sellerId = `seller-depth-${Date.now()}`;
  const loginEmail = `${sellerId}@example.invalid`;
  const accessCode = "seller-depth-pass-123";
  const provisioned = await app.inject({
    method: "POST",
    url: `/api/admin/seller-auth/${sellerId}/provision`,
    headers: { cookie: ADMIN_COOKIE },
    payload: {
      display_name: "Seller Depth",
      login_email: loginEmail,
      access_code: accessCode,
      auth_enabled: true
    }
  });
  assert.equal(provisioned.statusCode, 200, provisioned.body);

  const login = await app.inject({
    method: "POST",
    url: "/api/seller/session/login",
    payload: { identifier: loginEmail, access_code: accessCode }
  });
  assert.equal(login.statusCode, 200, login.body);
  const cookie = asCookie(login.headers["set-cookie"]);
  assert.match(cookie, /siton_seller_session=/);

  await pool.query(
    `UPDATE siton.seller_accounts SET seller_status='Suspended', seller_status_updated_at=now() WHERE seller_id=$1`,
    [sellerId]
  );
  const title = `Must not create ${Date.now()}`;
  const forbidden = await app.inject({
    method: "POST",
    url: "/deals",
    headers: { cookie, "x-siton-return-to": "/app/seller/new?resume=draft" },
    payload: {
      title,
      description: "Auth code regression",
      price_per_unit: 20,
      min_units: 2,
      max_units: 10,
      deadline: new Date(Date.now() + 3 * 60 * 60_000).toISOString()
    }
  });
  assert.equal(forbidden.statusCode, 403, forbidden.body);
  assert.equal(forbidden.json().code, "SELLER_SUSPENDED");
  assert.equal(forbidden.json().product_code, "SELLER_FORBIDDEN");
  assert.equal(forbidden.json().reason_code, "SELLER_SUSPENDED");
  assert.equal(forbidden.json().seller_auth.reason, "forbidden");

  const dealCount = await pool.query(`SELECT COUNT(*)::int AS count FROM siton.deals WHERE title=$1`, [title]);
  assert.equal(Number(dealCount.rows[0].count), 0, "forbidden create must not persist a Draft");
});

await run("S5 POST /deals idempotency replays, rejects drift, and serializes concurrent retries", async () => {
  const { sellerId, cookie } = await provisionActiveSeller("seller-idem");
  const replayKey = `seller-create:${randomUUID()}`;
  const replayPayload = validDraftPayload({ title: `Idempotent Draft ${randomUUID()}` });
  const first = await app.inject({
    method: "POST",
    url: "/deals",
    headers: { cookie, "idempotency-key": replayKey },
    payload: replayPayload
  });
  const replay = await app.inject({
    method: "POST",
    url: "/deals",
    headers: { cookie, "idempotency-key": replayKey },
    payload: replayPayload
  });
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(replay.json().deal_id, first.json().deal_id, "same key + same payload must recover the original Draft");
  assert.equal(replay.json().state, first.json().state);
  assert.equal(replay.json().deal_type, first.json().deal_type);

  const replayRows = await pool.query(
    `SELECT deal_id, description FROM siton.deals WHERE seller_id=$1 AND title=$2`,
    [sellerId, replayPayload.title]
  );
  assert.equal(replayRows.rowCount, 1, "a sequential replay must not duplicate the Draft");

  const drift = await app.inject({
    method: "POST",
    url: "/deals",
    headers: { cookie, "idempotency-key": replayKey },
    payload: { ...replayPayload, description: "payload drift must be rejected" }
  });
  assert.equal(drift.statusCode, 409, drift.body);
  assert.equal(drift.json().code, "IDEMPOTENCY_PAYLOAD_MISMATCH");
  const afterDrift = await pool.query(`SELECT description FROM siton.deals WHERE deal_id=$1`, [first.json().deal_id]);
  assert.equal(afterDrift.rows[0].description, replayPayload.description, "payload drift must not mutate the recovered Draft");

  const concurrentKey = `seller-create:${randomUUID()}`;
  const concurrentPayload = validDraftPayload({ title: `Concurrent Draft ${randomUUID()}` });
  const concurrent = await Promise.all(Array.from({ length: 6 }, () => app.inject({
    method: "POST",
    url: "/deals",
    headers: { cookie, "idempotency-key": concurrentKey },
    payload: concurrentPayload
  })));
  for (const response of concurrent) assert.equal(response.statusCode, 200, response.body);
  const concurrentIds = new Set(concurrent.map((response) => String(response.json().deal_id)));
  assert.equal(concurrentIds.size, 1, "all concurrent same-key requests must converge on one Draft id");
  const concurrentRows = await pool.query(
    `SELECT COUNT(*)::int AS count FROM siton.deals WHERE seller_id=$1 AND title=$2`,
    [sellerId, concurrentPayload.title]
  );
  assert.equal(Number(concurrentRows.rows[0].count), 1, "concurrent retries must persist exactly one Draft");
});

await run("S6 Draft PATCH persists matching voucher/ticket terms and rejects cross-type terms atomically", async () => {
  const { cookie } = await provisionActiveSeller("seller-terms");
  const voucherCreateTerms = voucherTerms("create");
  const voucherCreate = await app.inject({
    method: "POST",
    url: "/deals",
    headers: { cookie, "idempotency-key": `seller-create:${randomUUID()}` },
    payload: validDraftPayload({
      title: `Voucher Draft ${randomUUID()}`,
      deal_type: "voucher",
      delivery_options: [],
      voucher_terms: voucherCreateTerms
    })
  });
  assert.equal(voucherCreate.statusCode, 200, voucherCreate.body);
  const voucherDealId = String(voucherCreate.json().deal_id);
  const voucherRead = await app.inject({
    method: "GET",
    url: `/api/seller/deals/${voucherDealId}/draft`,
    headers: { cookie }
  });
  assert.equal(voucherRead.statusCode, 200, voucherRead.body);
  const voucherUpdatedTerms = voucherTerms("updated");
  const voucherPatch = await app.inject({
    method: "PATCH",
    url: `/api/seller/deals/${voucherDealId}/draft`,
    headers: { cookie },
    payload: {
      voucher_terms: voucherUpdatedTerms,
      expected_updated_at: voucherRead.json().editor_version
    }
  });
  assert.equal(voucherPatch.statusCode, 200, voucherPatch.body);
  const voucherRow = await pool.query(
    `SELECT face_value_amount, redemption_location, redemption_instructions, terms
     FROM siton.deal_voucher_terms WHERE deal_id=$1`,
    [voucherDealId]
  );
  assert.equal(voucherRow.rowCount, 1);
  assert.equal(Number(voucherRow.rows[0].face_value_amount), voucherUpdatedTerms.face_value_amount);
  assert.equal(voucherRow.rows[0].redemption_location, voucherUpdatedTerms.redemption_location);
  assert.equal(voucherRow.rows[0].redemption_instructions, voucherUpdatedTerms.redemption_instructions);
  assert.equal(voucherRow.rows[0].terms, voucherUpdatedTerms.terms);

  const voucherLatest = await app.inject({
    method: "GET",
    url: `/api/seller/deals/${voucherDealId}/draft`,
    headers: { cookie }
  });
  assert.equal(voucherLatest.statusCode, 200, voucherLatest.body);
  assert.equal(voucherLatest.json().draft.voucher_terms.redemption_location, voucherUpdatedTerms.redemption_location);
  const descriptionBeforeMismatch = String(voucherLatest.json().draft.description || "");
  const mismatched = await app.inject({
    method: "PATCH",
    url: `/api/seller/deals/${voucherDealId}/draft`,
    headers: { cookie },
    payload: {
      description: "must roll back with cross-type terms",
      ticket_terms: ticketTerms("wrong-type"),
      expected_updated_at: voucherLatest.json().editor_version
    }
  });
  assert.ok([400, 409].includes(mismatched.statusCode), mismatched.body);
  assert.match(String(mismatched.json().code || ""), /TERMS|DEAL_TYPE/i, mismatched.body);
  const voucherAfterMismatch = await pool.query(
    `SELECT d.description,
            (SELECT COUNT(*)::int FROM siton.deal_ticket_terms tt WHERE tt.deal_id=d.deal_id) AS ticket_terms_count
     FROM siton.deals d WHERE d.deal_id=$1`,
    [voucherDealId]
  );
  assert.equal(voucherAfterMismatch.rows[0].description || "", descriptionBeforeMismatch, "cross-type rejection must roll back base Draft edits");
  assert.equal(Number(voucherAfterMismatch.rows[0].ticket_terms_count), 0, "voucher Draft must never gain ticket terms");

  const ticketCreate = await app.inject({
    method: "POST",
    url: "/deals",
    headers: { cookie, "idempotency-key": `seller-create:${randomUUID()}` },
    payload: validDraftPayload({
      title: `Ticket Draft ${randomUUID()}`,
      deal_type: "ticket",
      delivery_options: [],
      ticket_terms: ticketTerms("create")
    })
  });
  assert.equal(ticketCreate.statusCode, 200, ticketCreate.body);
  const ticketDealId = String(ticketCreate.json().deal_id);
  const ticketRead = await app.inject({
    method: "GET",
    url: `/api/seller/deals/${ticketDealId}/draft`,
    headers: { cookie }
  });
  assert.equal(ticketRead.statusCode, 200, ticketRead.body);
  const ticketUpdatedTerms = ticketTerms("updated");
  const ticketPatch = await app.inject({
    method: "PATCH",
    url: `/api/seller/deals/${ticketDealId}/draft`,
    headers: { cookie },
    payload: {
      ticket_terms: ticketUpdatedTerms,
      expected_updated_at: ticketRead.json().editor_version
    }
  });
  assert.equal(ticketPatch.statusCode, 200, ticketPatch.body);
  const ticketRow = await pool.query(
    `SELECT event_name, venue_name, venue_address, venue_city, entry_instructions
     FROM siton.deal_ticket_terms WHERE deal_id=$1`,
    [ticketDealId]
  );
  assert.equal(ticketRow.rowCount, 1);
  assert.equal(ticketRow.rows[0].event_name, ticketUpdatedTerms.event_name);
  assert.equal(ticketRow.rows[0].venue_name, ticketUpdatedTerms.venue_name);
  assert.equal(ticketRow.rows[0].venue_address, ticketUpdatedTerms.venue_address);
  assert.equal(ticketRow.rows[0].venue_city, ticketUpdatedTerms.venue_city);
  assert.equal(ticketRow.rows[0].entry_instructions, ticketUpdatedTerms.entry_instructions);
});

await run("S7 seller editor source preserves optimistic version and full delivery option fidelity", async () => {
  const source = await readFile("frontend/app.js", "utf8");
  const hydrateStart = source.indexOf("function hydrateSellerDraftEditor");
  const hydrateEnd = source.indexOf("\nasync function loadSellerDeal", hydrateStart);
  assert.ok(hydrateStart >= 0 && hydrateEnd > hydrateStart, "seller Draft hydrate function is missing");
  const hydrate = source.slice(hydrateStart, hydrateEnd);
  assert.match(source, /sellerDraftEditorVersion/, "editor version must be retained in client state");
  assert.match(source, /expected_updated_at\s*:\s*state\.sellerDraftEditorVersion/, "Draft PATCH must send its loaded editor version");
  assert.match(hydrate, /sellerDeliveryInstructions/, "encoded pickup/distribution instructions must be hydrated");
  assert.match(hydrate, /sellerDeliveryLocationUrl/, "encoded pickup/distribution location URL must be hydrated");
  assert.match(hydrate, /sellerDeliveryCost/, "delivery/pickup cost must be hydrated");
  assert.match(hydrate, /option\.option_type/, "each option must preserve its canonical option_type");
  assert.match(hydrate, /parseDistributionPointLabel/, "hydration must use the encoded-label parser");
  const parserStart = source.indexOf("function parseDistributionPointLabel");
  const parserEnd = source.indexOf("\nfunction persistSellerCreateResume", parserStart);
  assert.ok(parserStart >= 0 && parserEnd > parserStart, "encoded delivery-label parser is missing");
  const parser = source.slice(parserStart, parserEnd);
  assert.match(parser, /הוראות:/, "the encoded instructions segment must be parsed explicitly");
  assert.match(parser, /קישור מיקום:/, "the encoded location URL segment must be parsed explicitly");

  const collectStart = source.indexOf("function collectSellerDeliveryOptions");
  const collectEnd = source.indexOf("\nfunction buildDistributionPointLabel", collectStart);
  assert.ok(collectStart >= 0 && collectEnd > collectStart, "seller delivery collector is missing");
  const collect = source.slice(collectStart, collectEnd);
  assert.match(collect, /sellerDeliveryCost1/, "home-delivery cost must come from the hydrated/form value");
  assert.doesNotMatch(
    collect.slice(0, collect.indexOf("for (let index")),
    /cost:\s*0\s*,/,
    "home delivery must not silently reset a persisted non-zero cost"
  );
});

await run("S8 unhandled 500 response never exposes raw database diagnostics", async () => {
  const response = await app.inject({ method: "GET", url: "/__test/v1-1/internal-error-envelope" });
  assert.equal(response.statusCode, 500, response.body);
  const body = response.json() as Record<string, unknown>;
  assert.equal(body.ok, false);
  assert.equal(body.error, "internal_error");
  assert.equal(Object.hasOwn(body, "code"), false, "raw database code must not be sent to the client");
  assert.doesNotMatch(response.body, new RegExp(RAW_DB_MESSAGE));
  assert.doesNotMatch(response.body, new RegExp(RAW_DB_CODE));
});

await pool.end();
await app.close();
console.log("All seller creation depth tests passed.");
