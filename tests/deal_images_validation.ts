import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
const { Pool } = pg;

process.env.PORT = String(process.env.PORT || "3426");
process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.DEAL_IMAGE_UPLOAD_DIR = await mkdtemp(join(tmpdir(), "siton-deal-images-"));

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

async function insertDraftDeal(sellerId: string) {
  const dealId = randomUUID();
  await pool.query(
    `INSERT INTO siton.deals
       (deal_id, seller_id, title, state, threshold_units, min_units, max_units,
        price_per_unit, deadline, created_at, updated_at)
     VALUES ($1,$2,$3,'Draft',1,1,10,100.00,now()+interval '7 days',now(),now())`,
    [dealId, sellerId, `Image Deal ${dealId.slice(0, 8)}`]
  );
  return dealId;
}

async function insertPublishedDeal(sellerId: string) {
  const dealId = randomUUID();
  await pool.query(
    `INSERT INTO siton.deals
       (deal_id, seller_id, title, state, threshold_units, min_units, max_units,
        price_per_unit, deadline, published_at, created_at, updated_at)
     VALUES ($1,$2,$3,'PendingTarget',1,1,10,100.00,now()+interval '7 days',now(),now(),now())`,
    [dealId, sellerId, `Published Image Deal ${dealId.slice(0, 8)}`]
  );
  return dealId;
}

function imagePayload(overrides: Record<string, unknown> = {}) {
  return {
    image_base64: Buffer.from("tiny-image").toString("base64"),
    mime_type: "image/png",
    original_filename: "product.png",
    ...overrides
  };
}

await run("D1 seller can upload valid product image before publish and public payload includes URL", async () => {
  const sellerId = `seller-img-${randomUUID().slice(0, 8)}`;
  const dealId = await insertDraftDeal(sellerId);

  const upload = await app.inject({
    method: "POST",
    url: `/api/seller/deals/${dealId}/images`,
    headers: { "x-seller-id": sellerId },
    payload: imagePayload()
  });

  assert.equal(upload.statusCode, 201, `upload failed: ${upload.body}`);
  const body = upload.json();
  assert.ok(body.image.image_id, "missing image_id");
  assert.match(body.image.public_url, /^\/api\/deal-images\//);
  assert.equal(body.image.mime_type, "image/png");
  assert.equal(body.image.is_primary, true);

  const row = await pool.query(
    `SELECT image_id FROM siton.deal_images WHERE deal_id=$1`,
    [dealId]
  );
  assert.equal(row.rowCount, 1, "image row was not persisted");

  const publicDeal = await app.inject({
    method: "GET",
    url: `/api/deals/${dealId}/public`
  });
  assert.equal(publicDeal.statusCode, 200, `public deal failed: ${publicDeal.body}`);
  const publicBody = publicDeal.json();
  assert.equal(publicBody.deal.images.length, 1, "public payload should include one image");
  assert.equal(publicBody.deal.images[0].url, body.image.public_url);
  assert.equal(publicBody.deal.images[0].is_primary, true);
});

await run("D2 unauthorized seller cannot upload", async () => {
  const sellerId = `seller-img-owner-${randomUUID().slice(0, 8)}`;
  const otherSellerId = `seller-img-other-${randomUUID().slice(0, 8)}`;
  const dealId = await insertDraftDeal(sellerId);

  const res = await app.inject({
    method: "POST",
    url: `/api/seller/deals/${dealId}/images`,
    headers: { "x-seller-id": otherSellerId },
    payload: imagePayload()
  });

  assert.equal(res.statusCode, 403, `expected 403, got ${res.statusCode}: ${res.body}`);
  const count = await pool.query(`SELECT COUNT(*)::int AS count FROM siton.deal_images WHERE deal_id=$1`, [dealId]);
  assert.equal(Number(count.rows[0].count), 0, "unauthorized upload should not create image row");
});

await run("D3 invalid mime type is rejected", async () => {
  const sellerId = `seller-img-mime-${randomUUID().slice(0, 8)}`;
  const dealId = await insertDraftDeal(sellerId);

  const res = await app.inject({
    method: "POST",
    url: `/api/seller/deals/${dealId}/images`,
    headers: { "x-seller-id": sellerId },
    payload: imagePayload({ mime_type: "text/plain" })
  });

  assert.equal(res.statusCode, 400, `expected 400, got ${res.statusCode}: ${res.body}`);
  assert.equal(res.json().code, "invalid_image_type");
});

await run("D4 too large image is rejected", async () => {
  const sellerId = `seller-img-large-${randomUUID().slice(0, 8)}`;
  const dealId = await insertDraftDeal(sellerId);
  const tooLarge = Buffer.alloc(5 * 1024 * 1024 + 1, 1).toString("base64");

  const res = await app.inject({
    method: "POST",
    url: `/api/seller/deals/${dealId}/images`,
    headers: { "x-seller-id": sellerId },
    payload: imagePayload({ image_base64: tooLarge })
  });

  assert.equal(res.statusCode, 400, `expected 400, got ${res.statusCode}: ${res.body}`);
  assert.equal(res.json().code, "image_too_large");
});

await run("D5 path traversal filename is stored safely", async () => {
  const sellerId = `seller-img-safe-${randomUUID().slice(0, 8)}`;
  const dealId = await insertDraftDeal(sellerId);

  const res = await app.inject({
    method: "POST",
    url: `/api/seller/deals/${dealId}/images`,
    headers: { "x-seller-id": sellerId },
    payload: imagePayload({ original_filename: "../../evil.png" })
  });

  assert.equal(res.statusCode, 201, `upload failed: ${res.body}`);
  const row = await pool.query(
    `SELECT storage_key, original_filename FROM siton.deal_images WHERE deal_id=$1`,
    [dealId]
  );
  assert.ok(row.rowCount, "image row missing");
  assert.doesNotMatch(String(row.rows[0].storage_key), /\.\.|\\/);
  assert.equal(row.rows[0].original_filename, "evil.png");
});

await run("D6 public deal payload does not expose storage_key", async () => {
  const sellerId = `seller-img-public-${randomUUID().slice(0, 8)}`;
  const dealId = await insertDraftDeal(sellerId);
  await app.inject({
    method: "POST",
    url: `/api/seller/deals/${dealId}/images`,
    headers: { "x-seller-id": sellerId },
    payload: imagePayload()
  });

  const publicDeal = await app.inject({ method: "GET", url: `/api/deals/${dealId}/public` });
  assert.equal(publicDeal.statusCode, 200);
  assert.doesNotMatch(publicDeal.body, /storage_key/);
  assert.doesNotMatch(publicDeal.body, /uploads/);
});

await run("D7 no image returns safe empty images array", async () => {
  const sellerId = `seller-img-empty-${randomUUID().slice(0, 8)}`;
  const dealId = await insertDraftDeal(sellerId);
  const publicDeal = await app.inject({ method: "GET", url: `/api/deals/${dealId}/public` });
  assert.equal(publicDeal.statusCode, 200);
  assert.deepEqual(publicDeal.json().deal.images, []);
});

await run("D8 image upload is blocked after publish", async () => {
  const sellerId = `seller-img-pub-${randomUUID().slice(0, 8)}`;
  const dealId = await insertPublishedDeal(sellerId);
  const res = await app.inject({
    method: "POST",
    url: `/api/seller/deals/${dealId}/images`,
    headers: { "x-seller-id": sellerId },
    payload: imagePayload()
  });
  assert.equal(res.statusCode, 409, `expected 409, got ${res.statusCode}: ${res.body}`);
  assert.equal(res.json().code, "deal_already_published");
});

await pool.end();
await app.close();
console.log("All deal image tests passed.");
