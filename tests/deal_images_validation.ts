import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
const { Pool } = pg;

process.env.PORT = String(process.env.PORT || "3426");
process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.DISABLE_OUTBOX_WORKER = "1";
const uploadDir = await mkdtemp(join(tmpdir(), "siton-deal-images-"));
delete process.env.DEAL_IMAGE_UPLOAD_DIR;
process.env.UPLOAD_DIR = uploadDir;

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

async function publishDraftForReadProof(dealId: string, sellerId: string) {
  const profile = await app.inject({
    method: "PUT",
    url: "/api/seller/profile",
    headers: { "x-seller-id": sellerId },
    payload: { business_name: `Image seller ${sellerId}`, support_email: `${sellerId}@example.invalid` }
  });
  assert.equal(profile.statusCode, 200, `seller profile setup failed: ${profile.body}`);
  const published = await app.inject({
    method: "POST",
    url: `/deals/${dealId}/publish`,
    headers: {
      "x-seller-id": sellerId,
      "x-request-id": `image-publish-${randomUUID()}`,
      "idempotency-key": `image-publish-${dealId}`
    },
    payload: {
      seller_terms_accepted: true,
      seller_critical_terms_accepted: true,
      seller_threshold_90_accepted: true
    }
  });
  assert.equal(published.statusCode, 200, `Draft publish failed: ${published.body}`);
}

function imagePayload(overrides: Record<string, unknown> = {}) {
  return {
    image_base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    mime_type: "image/png",
    original_filename: "product.png",
    ...overrides
  };
}

await run("D0 upload dir is runtime-configurable and never tied to a legacy host path", async () => {
  const adapter = await readFile("src/storage_adapter.ts", "utf8");
  const environmentContract = await readFile("docs/ENVIRONMENT_CONTRACT.md", "utf8");
  assert.equal(process.env.UPLOAD_DIR, uploadDir);
  assert.match(adapter, /env\.UPLOAD_DIR/);
  assert.doesNotMatch(adapter, /\/app\/uploads/);
  assert.match(environmentContract, /UPLOAD_DIR/);
  assert.match(environmentContract, /writable/i);
});

await run("D1 Draft stays private while its owner can recover the draft and image bytes", async () => {
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
    `SELECT image_id, storage_key, checksum_sha256 FROM siton.deal_images WHERE deal_id=$1`,
    [dealId]
  );
  assert.equal(row.rowCount, 1, "image row was not persisted");
  assert.match(String(row.rows[0].checksum_sha256), /^[0-9a-f]{64}$/);
  const savedFile = await stat(join(uploadDir, String(row.rows[0].storage_key)));
  assert.equal(savedFile.isFile(), true, "uploaded image file was not written to UPLOAD_DIR");

  const publicDraft = await app.inject({
    method: "GET",
    url: `/api/deals/${dealId}/public`
  });
  assert.equal(publicDraft.statusCode, 404, `Draft must not be public: ${publicDraft.body}`);

  const ownerDraft = await app.inject({
    method: "GET",
    url: `/api/seller/deals/${dealId}/draft`,
    headers: { "x-seller-id": sellerId }
  });
  assert.equal(ownerDraft.statusCode, 200, `owner Draft read failed: ${ownerDraft.body}`);
  assert.equal(ownerDraft.json().draft.images.length, 1);
  assert.equal(ownerDraft.json().draft.images[0].image_id, body.image.image_id);

  const ownerImage = await app.inject({
    method: "GET",
    url: body.image.public_url,
    headers: { "x-seller-id": sellerId }
  });
  assert.equal(ownerImage.statusCode, 200, `owner image read failed: ${ownerImage.body}`);
  assert.equal(ownerImage.headers["cache-control"], "private, no-store");

  const otherSellerImage = await app.inject({
    method: "GET",
    url: body.image.public_url,
    headers: { "x-seller-id": `${sellerId}-other` }
  });
  assert.equal(otherSellerImage.statusCode, 404, "another seller must not read unpublished image bytes");

  await publishDraftForReadProof(dealId, sellerId);
  const publicDeal = await app.inject({ method: "GET", url: `/api/deals/${dealId}/public` });
  assert.equal(publicDeal.statusCode, 200, `published public deal failed: ${publicDeal.body}`);
  const publicBody = publicDeal.json();
  assert.equal(publicBody.deal.images.length, 1, "public payload should include one image");
  assert.equal(publicBody.deal.images[0].url, body.image.public_url);
  assert.equal(publicBody.deal.images[0].is_primary, true);
});

await run("D2 unauthorized seller cannot upload and ownership stays undisclosed", async () => {
  const sellerId = `seller-img-owner-${randomUUID().slice(0, 8)}`;
  const otherSellerId = `seller-img-other-${randomUUID().slice(0, 8)}`;
  const dealId = await insertDraftDeal(sellerId);

  const res = await app.inject({
    method: "POST",
    url: `/api/seller/deals/${dealId}/images`,
    headers: { "x-seller-id": otherSellerId },
    payload: imagePayload()
  });

  assert.equal(res.statusCode, 404, `expected ownership-hiding 404, got ${res.statusCode}: ${res.body}`);
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

await run("D3b declared MIME must match image content", async () => {
  const sellerId = `seller-img-content-${randomUUID().slice(0, 8)}`;
  const dealId = await insertDraftDeal(sellerId);
  const res = await app.inject({
    method: "POST",
    url: `/api/seller/deals/${dealId}/images`,
    headers: { "x-seller-id": sellerId },
    payload: imagePayload({ image_base64: Buffer.from("not a png").toString("base64") })
  });
  assert.equal(res.statusCode, 400, res.body);
  assert.equal(res.json().code, "image_content_mismatch");
  const count = await pool.query(`SELECT COUNT(*)::int AS count FROM siton.deal_images WHERE deal_id=$1`, [dealId]);
  assert.equal(Number(count.rows[0].count), 0);
});
await run("D4 too large image is rejected", async () => {
  const sellerId = `seller-img-large-${randomUUID().slice(0, 8)}`;
  const dealId = await insertDraftDeal(sellerId);
  const tooLarge = Buffer.alloc(2 * 1024 * 1024 + 1, 1).toString("base64");

  const res = await app.inject({
    method: "POST",
    url: `/api/seller/deals/${dealId}/images`,
    headers: { "x-seller-id": sellerId },
    payload: imagePayload({ image_base64: tooLarge })
  });

  assert.equal(res.statusCode, 400, `expected 400, got ${res.statusCode}: ${res.body}`);
  assert.equal(res.json().code, "image_too_large");
});

await run("D5 path traversal filename is rejected", async () => {
  const sellerId = `seller-img-safe-${randomUUID().slice(0, 8)}`;
  const dealId = await insertDraftDeal(sellerId);

  const res = await app.inject({
    method: "POST",
    url: `/api/seller/deals/${dealId}/images`,
    headers: { "x-seller-id": sellerId },
    payload: imagePayload({ original_filename: "../../evil.png" })
  });

  assert.equal(res.statusCode, 400, `expected traversal rejection: ${res.body}`);
  assert.equal(res.json().code, "invalid_image_filename");
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

  await publishDraftForReadProof(dealId, sellerId);

  const publicDeal = await app.inject({ method: "GET", url: `/api/deals/${dealId}/public` });
  assert.equal(publicDeal.statusCode, 200);
  assert.doesNotMatch(publicDeal.body, /storage_key/);
  assert.doesNotMatch(publicDeal.body, /uploads/);
});

await run("D7 no image returns safe empty images array", async () => {
  const sellerId = `seller-img-empty-${randomUUID().slice(0, 8)}`;
  const dealId = await insertPublishedDeal(sellerId);
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

await run("D9 draft deal supports up to twelve images with one primary image", async () => {
  // P0.2 — the canonical image capacity is 12 per deal.
  const sellerId = `seller-img-gallery-${randomUUID().slice(0, 8)}`;
  const dealId = await insertDraftDeal(sellerId);
  for (let index = 0; index < 12; index += 1) {
    const res = await app.inject({
      method: "POST",
      url: `/api/seller/deals/${dealId}/images`,
      headers: { "x-seller-id": sellerId },
      payload: imagePayload({
        original_filename: `product-${index}.png`,
        is_primary: index === 2,
        sort_order: index
      })
    });
    assert.equal(res.statusCode, 201, `upload ${index} failed: ${res.body}`);
  }

  const rows = await pool.query(
    `SELECT COUNT(*)::int AS count,
            SUM(CASE WHEN is_primary THEN 1 ELSE 0 END)::int AS primary_count,
            MIN(CASE WHEN is_primary THEN sort_order ELSE NULL END)::int AS primary_sort_order
     FROM siton.deal_images
     WHERE deal_id=$1`,
    [dealId]
  );
  assert.equal(Number(rows.rows[0].count), 12);
  assert.equal(Number(rows.rows[0].primary_count), 1);
  assert.equal(Number(rows.rows[0].primary_sort_order), 2);

  const thirteenth = await app.inject({
    method: "POST",
    url: `/api/seller/deals/${dealId}/images`,
    headers: { "x-seller-id": sellerId },
    payload: imagePayload({ original_filename: "product-13.png" })
  });
  assert.equal(thirteenth.statusCode, 400, `expected 400 for thirteenth image, got ${thirteenth.statusCode}: ${thirteenth.body}`);
  assert.equal(thirteenth.json().code, "deal_image_limit");
});

await run("D9b image upload replay is idempotent and rejects payload drift", async () => {
  const sellerId = `seller-img-replay-${randomUUID().slice(0, 8)}`;
  const dealId = await insertDraftDeal(sellerId);
  const idempotencyKey = `image-replay-${randomUUID()}`;
  const payload = imagePayload({ original_filename: "replay.png" });

  const first = await app.inject({
    method: "POST",
    url: `/api/seller/deals/${dealId}/images`,
    headers: { "x-seller-id": sellerId, "idempotency-key": idempotencyKey },
    payload
  });
  const replay = await app.inject({
    method: "POST",
    url: `/api/seller/deals/${dealId}/images`,
    headers: { "x-seller-id": sellerId, "idempotency-key": idempotencyKey },
    payload
  });
  assert.equal(first.statusCode, 201, first.body);
  assert.equal(replay.statusCode, 201, replay.body);
  assert.equal(replay.json().idempotent_replay, true);
  assert.equal(replay.json().image.image_id, first.json().image.image_id);
  assert.equal(
    Number((await pool.query(`SELECT COUNT(*)::int AS count FROM siton.deal_images WHERE deal_id=$1`, [dealId])).rows[0].count),
    1,
    "a replay must not create another image"
  );

  const mismatch = await app.inject({
    method: "POST",
    url: `/api/seller/deals/${dealId}/images`,
    headers: { "x-seller-id": sellerId, "idempotency-key": idempotencyKey },
    payload: imagePayload({ original_filename: "different.png" })
  });
  assert.equal(mismatch.statusCode, 409, mismatch.body);
  assert.equal(mismatch.json().code, "IDEMPOTENCY_PAYLOAD_MISMATCH");
});

await run("D9c owner can reorder Draft images and choose primary while IDOR stays hidden", async () => {
  const sellerId = `seller-img-order-${randomUUID().slice(0, 8)}`;
  const otherSellerId = `seller-img-order-other-${randomUUID().slice(0, 8)}`;
  const dealId = await insertDraftDeal(sellerId);
  const imageIds: string[] = [];
  for (let index = 0; index < 3; index += 1) {
    const uploaded = await app.inject({
      method: "POST",
      url: `/api/seller/deals/${dealId}/images`,
      headers: { "x-seller-id": sellerId },
      payload: imagePayload({ original_filename: `order-${index}.png` })
    });
    assert.equal(uploaded.statusCode, 201, uploaded.body);
    imageIds.push(String(uploaded.json().image.image_id));
  }

  const requestedOrder = [imageIds[2], imageIds[0], imageIds[1]];
  const reordered = await app.inject({
    method: "PATCH",
    url: `/api/seller/deals/${dealId}/images/order`,
    headers: { "x-seller-id": sellerId },
    payload: { ordered_image_ids: requestedOrder, primary_image_id: imageIds[1] }
  });
  assert.equal(reordered.statusCode, 200, reordered.body);
  assert.deepEqual(reordered.json().images.map((image: any) => String(image.image_id)), requestedOrder);
  assert.deepEqual(
    reordered.json().images.filter((image: any) => image.is_primary).map((image: any) => String(image.image_id)),
    [imageIds[1]]
  );

  const staleOrder = await app.inject({
    method: "PATCH",
    url: `/api/seller/deals/${dealId}/images/order`,
    headers: { "x-seller-id": sellerId },
    payload: { ordered_image_ids: requestedOrder.slice(0, 2) }
  });
  assert.equal(staleOrder.statusCode, 409, staleOrder.body);
  assert.equal(staleOrder.json().code, "DEAL_IMAGE_ORDER_STALE");

  const crossSeller = await app.inject({
    method: "PATCH",
    url: `/api/seller/deals/${dealId}/images/order`,
    headers: { "x-seller-id": otherSellerId },
    payload: { ordered_image_ids: requestedOrder, primary_image_id: imageIds[0] }
  });
  assert.equal(crossSeller.statusCode, 404, crossSeller.body);
  assert.equal(crossSeller.json().code, "deal_not_found");
});

await run("D10 authorized draft image deletion removes DB metadata and stored bytes", async () => {
  const sellerId = `seller-img-delete-${randomUUID().slice(0, 8)}`;
  const dealId = await insertDraftDeal(sellerId);
  const uploaded = await app.inject({ method: "POST", url: `/api/seller/deals/${dealId}/images`, headers: { "x-seller-id": sellerId }, payload: imagePayload() });
  assert.equal(uploaded.statusCode, 201, uploaded.body);
  const imageId = uploaded.json().image.image_id;
  const before = await pool.query(`SELECT storage_key FROM siton.deal_images WHERE image_id=$1`, [imageId]);
  const storedPath = join(uploadDir, String(before.rows[0].storage_key));
  assert.equal((await stat(storedPath)).isFile(), true);
  const deleted = await app.inject({ method: "DELETE", url: `/api/seller/deals/${dealId}/images/${imageId}`, headers: { "x-seller-id": sellerId } });
  assert.equal(deleted.statusCode, 200, deleted.body);
  assert.equal(deleted.json().deletion, "deleted");
  assert.equal(Number((await pool.query(`SELECT COUNT(*)::int AS count FROM siton.deal_images WHERE image_id=$1`, [imageId])).rows[0].count), 0);
  await assert.rejects(() => stat(storedPath), (error: any) => error?.code === "ENOENT");
});

await run("D11 frontend assigns a stable per-image request key and sends it on upload", async () => {
  const source = await readFile("frontend/app.js", "utf8");
  const normalizeStart = source.indexOf("function normalizeSellerImages");
  const normalizeEnd = source.indexOf("\nfunction setSellerImages", normalizeStart);
  assert.ok(normalizeStart >= 0 && normalizeEnd > normalizeStart, "seller image normalization is missing");
  const normalizeSource = source.slice(normalizeStart, normalizeEnd);
  assert.match(normalizeSource, /uploadRequestKey/, "the stable upload key must survive local-state normalization/retry");

  const uploadStart = source.indexOf("async function uploadSellerDealImage");
  const uploadEnd = source.indexOf("\nasync function publishDeal", uploadStart);
  assert.ok(uploadStart >= 0 && uploadEnd > uploadStart, "seller image upload function is missing");
  const uploadSource = source.slice(uploadStart, uploadEnd);
  assert.match(uploadSource, /uploadRequestKey/, "image upload must use its per-image request key");
  assert.match(uploadSource, /["']idempotency-key["']\s*:\s*uploadRequestKey/, "image upload must send its stable idempotency-key header");
  assert.match(uploadSource, /["']x-request-id["']\s*:\s*uploadRequestKey/, "image upload must reuse the same stable request identity for tracing");
});
await pool.end();
await app.close();
console.log("All deal image tests passed.");
