// STORAGE / FILE BOUNDARY — object-level authorization on imagery.
//
// The storage ADAPTER is already covered (atomicity, cleanup leases, fault
// boundaries, the Supabase broker, readiness). What those suites do not ask is
// the authorization question, and imagery is where it bites hardest: a Draft
// deal is never public, but its images are fetched through a route that has to
// serve anonymous buyers for published deals.
//
//   /api/deal-images/:imageId  is PUBLIC by contract. It must nevertheless
//   refuse a Draft image to everyone except that deal's owner, and refuse it in
//   a way that does not reveal the image exists.
//
// Also checked: the object key must not carry the uploader's identity or the
// original filename. Storage keys end up in CDN URLs, logs and support tickets;
// a key like "seller-acme/price-list-confidential.png" leaks the tenant and the
// document name to anyone who ever sees the URL.
//
// Cross-seller image MUTATIONS are already enumerated by the Phase 2 isolation
// suite (the /images routes are in the parametric seller surface), so this file
// checks the durable half those probes cannot: that a refused write left the
// victim's rows and files untouched.
//
// Synthetic images only - a handful of bytes each. No real media, no OCR, no
// external storage provider, no money.

import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import pg from "pg";

const { Pool } = pg;

process.env.NODE_ENV = "test";
process.env.PORT = "3129";
process.env.APP_DEPLOYMENT_MODE = "internal-runtime";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.SELLER_SESSION_SECRET = "seller-session-secret-storage";
process.env.ADMIN_API_KEY = "storage-admin-key";
process.env.ADMIN_SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || "admin-session-secret-storage";

const { app } = await import("../src/app.js");
const { establishNamedAdminSession } = await import("./helpers/named_admin_session.js");
await app.ready();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton",
  max: 5
});

let passed = 0;
let failed = 0;
async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { failed += 1; console.error(`FAIL ${name}: ${(error as any)?.message || error}`); }
}

// A one-pixel PNG. Real bytes, so the upload path is genuinely exercised.
const PNG_1PX_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

async function provisionSeller(sellerId: string) {
  const email = `${sellerId}@siton.test`;
  const accessCode = "StorageProbePass123!";
  const { cookie: adminCookie } = await establishNamedAdminSession(app, pool);
  const provision = await app.inject({
    method: "POST",
    url: `/api/admin/seller-auth/${sellerId}/provision`,
    headers: { cookie: adminCookie },
    payload: { display_name: sellerId, login_email: email, access_code: accessCode, auth_enabled: true }
  } as any);
  assert.equal(provision.statusCode, 200, provision.body);
  const login = await app.inject({
    method: "POST",
    url: "/api/seller/session/login",
    payload: { identifier: email, access_code: accessCode }
  } as any);
  assert.equal(login.statusCode, 200, login.body);
  return String(login.headers["set-cookie"] || "").split(";")[0] || "";
}

async function seedDraft(sellerId: string) {
  const result = await pool.query(
    `INSERT INTO siton.deals (title, price_per_unit, min_units, max_units, threshold_units, deadline, seller_id, state)
     VALUES ($1,50,1,20,5,$2,$3,'Draft') RETURNING deal_id`,
    [`Storage probe ${randomUUID().slice(0, 8)}`, new Date(Date.now() + 3 * 60 * 60_000).toISOString(), sellerId]
  );
  return String(result.rows[0].deal_id);
}

function uploadImage(cookie: string, dealId: string, extra: Record<string, unknown> = {}) {
  return app.inject({
    method: "POST",
    url: `/api/seller/deals/${dealId}/images`,
    headers: { cookie, "content-type": "application/json", "x-request-id": randomUUID() },
    payload: { image_data_url: `data:image/png;base64,${PNG_1PX_BASE64}`, ...extra }
  } as any);
}

const SELLER_A = `seller-store-a-${randomUUID().slice(0, 8)}`;
const SELLER_B = `seller-store-b-${randomUUID().slice(0, 8)}`;
const cookieA = await provisionSeller(SELLER_A);
const cookieB = await provisionSeller(SELLER_B);
const draftA = await seedDraft(SELLER_A);
const draftB = await seedDraft(SELLER_B);

await run("VACUITY GUARD: a seller can upload to and read back its own draft image", async () => {
  const upload = await uploadImage(cookieA, draftA, { original_filename: "vacuity.png" });
  assert.ok(upload.statusCode >= 200 && upload.statusCode < 300, `own upload failed: ${upload.statusCode} ${upload.body}`);
  const stored = await pool.query(`SELECT COUNT(*)::int AS n FROM siton.deal_images WHERE deal_id=$1`, [draftA]);
  assert.ok(stored.rows[0].n >= 1, "the upload stored no row");

  const imageId = (await pool.query(
    `SELECT image_id FROM siton.deal_images WHERE deal_id=$1 ORDER BY created_at DESC LIMIT 1`,
    [draftA]
  )).rows[0].image_id;
  const own = await app.inject({ method: "GET", url: `/api/deal-images/${imageId}`, headers: { cookie: cookieA } } as any);
  assert.ok(own.statusCode >= 200 && own.statusCode < 300, `owner cannot read its own draft image: ${own.statusCode}`);
});

await run("a DRAFT image is refused to another seller and to the public, indistinguishably from a missing one", async () => {
  const upload = await uploadImage(cookieB, draftB, { original_filename: "private-b.png" });
  assert.ok(upload.statusCode >= 200 && upload.statusCode < 300, `setup upload failed: ${upload.body}`);
  const imageId = String((await pool.query(
    `SELECT image_id FROM siton.deal_images WHERE deal_id=$1 ORDER BY created_at DESC LIMIT 1`,
    [draftB]
  )).rows[0].image_id);

  const missingId = randomUUID();
  const probes: Array<[string, Record<string, string>]> = [
    ["anonymous", {}],
    ["foreign seller", { cookie: cookieA }]
  ];
  for (const [who, headers] of probes) {
    const foreign = await app.inject({ method: "GET", url: `/api/deal-images/${imageId}`, headers } as any);
    const missing = await app.inject({ method: "GET", url: `/api/deal-images/${missingId}`, headers } as any);
    assert.ok(
      foreign.statusCode < 200 || foreign.statusCode >= 300,
      `${who} was served seller B's DRAFT image (${foreign.statusCode})`
    );
    assert.equal(
      foreign.statusCode,
      missing.statusCode,
      `${who} can tell an existing draft image (${foreign.statusCode}) from a missing one (${missing.statusCode})`
    );
  }
});

await run("the object key carries neither the uploader's identity nor the original filename", async () => {
  const secretName = `CONFIDENTIAL-price-list-${randomUUID().slice(0, 8)}.png`;
  const upload = await uploadImage(cookieA, draftA, { original_filename: secretName });
  assert.ok(upload.statusCode >= 200 && upload.statusCode < 300, upload.body);

  const row = (await pool.query(
    `SELECT storage_key, public_url, original_filename
     FROM siton.deal_images WHERE deal_id=$1 ORDER BY created_at DESC LIMIT 1`,
    [draftA]
  )).rows[0] as any;

  const key = String(row.storage_key || "");
  const publicUrl = String(row.public_url || "");
  // Storage keys reach CDN URLs, access logs and support tickets. A key naming
  // the tenant or the document leaks both to anyone who ever sees the URL.
  for (const [what, needle] of [["the original filename", secretName], ["the seller id", SELLER_A]] as const) {
    assert.ok(!key.includes(needle), `the storage key contains ${what}: ${key}`);
    assert.ok(!publicUrl.includes(needle), `the public URL contains ${what}: ${publicUrl}`);
  }
  // The filename is still retained as metadata, which is fine - it just must not
  // be part of the addressable key.
  assert.equal(String(row.original_filename || ""), secretName, "the original filename was not retained as metadata");
});

await run("a filename carrying path traversal never reaches the object key", async () => {
  for (const hostile of ["../../etc/passwd.png", "..\\..\\windows\\system32\\a.png", "a/../../b.png"]) {
    const upload = await uploadImage(cookieA, draftA, { original_filename: hostile });
    assert.ok(upload.statusCode < 500, `a hostile filename faulted the upload: ${upload.statusCode} ${upload.body}`);
    if (upload.statusCode >= 300) continue;
    const key = String((await pool.query(
      `SELECT storage_key FROM siton.deal_images WHERE deal_id=$1 ORDER BY created_at DESC LIMIT 1`,
      [draftA]
    )).rows[0].storage_key);
    assert.ok(!key.includes(".."), `the storage key contains a traversal segment: ${key}`);
    assert.ok(!key.includes("\\"), `the storage key contains a backslash: ${key}`);
  }
});

await run("malformed, empty and mistyped uploads are refused with a bounded 4xx, never a fault", async () => {
  const hostile: Array<[string, Record<string, unknown>]> = [
    ["empty data url", { image_data_url: "" }],
    ["zero-byte payload", { image_data_url: "data:image/png;base64," }],
    ["unsupported mime", { image_data_url: "data:image/gif;base64,R0lGODlhAQABAAAAACw=" }],
    ["executable disguised as png", { image_data_url: "data:image/png;base64,TVqQAAMAAAAEAAAA" }],
    ["not base64 at all", { image_data_url: "data:image/png;base64,!!!not base64!!!" }],
    ["mime/data mismatch", { image_base64: PNG_1PX_BASE64, mime_type: "application/x-msdownload" }],
    ["html smuggled as mime", { image_base64: PNG_1PX_BASE64, mime_type: "text/html" }]
  ];
  for (const [label, payload] of hostile) {
    const response = await app.inject({
      method: "POST",
      url: `/api/seller/deals/${draftA}/images`,
      headers: { cookie: cookieA, "content-type": "application/json", "x-request-id": randomUUID() },
      payload
    } as any);
    assert.ok(response.statusCode < 500, `${label} produced a server fault (${response.statusCode}): ${response.body.slice(0, 200)}`);
    assert.ok(
      response.statusCode >= 400,
      `${label} was ACCEPTED (${response.statusCode}) - the upload validator let it through`
    );
  }

  // Nothing hostile may have been persisted.
  const stored = await pool.query(
    `SELECT mime_type FROM siton.deal_images WHERE deal_id=$1`,
    [draftA]
  );
  for (const row of stored.rows as any[]) {
    assert.ok(
      ["image/jpeg", "image/png", "image/webp"].includes(String(row.mime_type)),
      `a non-image mime type was persisted: ${row.mime_type}`
    );
  }
});

await run("a refused cross-seller image write leaves the victim's rows untouched", async () => {
  const before = await pool.query(
    `SELECT image_id, storage_key, sort_order, is_primary FROM siton.deal_images WHERE deal_id=$1 ORDER BY image_id`,
    [draftB]
  );
  assert.ok((before.rowCount ?? 0) >= 1, "seller B has no image to protect - probe is not meaningful");
  const victimImageId = String(before.rows[0].image_id);

  const attempts = [
    uploadImage(cookieA, draftB, { original_filename: "injected-by-a.png" }),
    app.inject({
      method: "PATCH",
      url: `/api/seller/deals/${draftB}/images/order`,
      headers: { cookie: cookieA, "content-type": "application/json", "x-request-id": randomUUID() },
      payload: { image_ids: [victimImageId] }
    } as any),
    app.inject({
      method: "DELETE",
      url: `/api/seller/deals/${draftB}/images/${victimImageId}`,
      headers: { cookie: cookieA, "x-request-id": randomUUID() }
    } as any)
  ];
  for (const response of await Promise.all(attempts)) {
    assert.ok(
      response.statusCode < 200 || response.statusCode >= 300,
      `a cross-seller image write was accepted (${response.statusCode})`
    );
  }

  const after = await pool.query(
    `SELECT image_id, storage_key, sort_order, is_primary FROM siton.deal_images WHERE deal_id=$1 ORDER BY image_id`,
    [draftB]
  );
  assert.deepEqual(
    after.rows.map((row: any) => ({ ...row, image_id: String(row.image_id) })),
    before.rows.map((row: any) => ({ ...row, image_id: String(row.image_id) })),
    "a refused cross-seller image write still changed seller B's rows"
  );
});

console.log(`SUMMARY passed=${passed} failed=${failed}`);
if (failed > 0) process.exitCode = 1;
await app.close().catch(() => undefined);
await pool.end().catch(() => undefined);
