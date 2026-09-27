// Black-Sky B8 (per-seller upload quotas) and B7 (share page origin) —
// against the real Fastify router on an isolated migrated database.
//
// B8: one seller cannot accumulate unbounded content assets or deal images;
//     the refusal happens before any byte reaches storage, is per seller (a
//     second seller is unaffected) and the byte ceiling is enforced too.
// B7: the publicly cacheable /d/:id share page takes its absolute og: origin
//     from configuration, never from Host / X-Forwarded-Host; with no
//     configured origin the header-derived page is served no-store.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";

process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.RATE_LIMIT_MAX = "10000";
process.env.RATE_LIMIT_SENSITIVE_MAX = "10000";
process.env.RATE_LIMIT_READ_MAX = "10000";
process.env.PORT = "3611";
delete process.env.PUBLIC_BASE_URL;
delete process.env.RENDER_EXTERNAL_URL;
const uploadDir = await mkdtemp(join(tmpdir(), "siton-quota-images-"));
delete process.env.DEAL_IMAGE_UPLOAD_DIR;
process.env.UPLOAD_DIR = uploadDir;
process.env.SELLER_CONTENT_ASSET_MAX_COUNT = "2";
process.env.SELLER_DEAL_IMAGE_MAX_COUNT = "3";

const { app } = await import("../src/app.js");
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton", max: 5 });
const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
let passed = 0;
async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`PASS ${name}`); } catch (error) { console.error(`FAIL ${name}`); throw error; }
}
async function countStoredFiles(dir: string): Promise<number> {
  let n = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    n += entry.isDirectory() ? await countStoredFiles(join(dir, entry.name)) : 1;
  }
  return n;
}
async function insertDeal(sellerId: string, published = false) {
  const dealId = randomUUID();
  await pool.query(
    `INSERT INTO siton.deals (deal_id, seller_id, title, state, threshold_units, min_units, max_units, price_per_unit, deadline, published_at, created_at, updated_at)
     VALUES ($1,$2,$3,$4,1,1,10,100.00,now()+interval '7 days',$5,now(),now())`,
    [dealId, sellerId, `Quota Deal ${dealId.slice(0, 8)}`, published ? "PendingTarget" : "Draft", published ? new Date().toISOString() : null]
  );
  return dealId;
}
const uploadDealImage = (sellerId: string, dealId: string) => app.inject({
  method: "POST", url: `/api/seller/deals/${dealId}/images`, headers: { "x-seller-id": sellerId },
  payload: { image_base64: PIXEL, mime_type: "image/png", original_filename: "p.png" }
});
const uploadAsset = (sellerId: string) => app.inject({
  method: "POST", url: "/api/seller/content-assets", headers: { "x-seller-id": sellerId, "content-type": "application/json" },
  payload: { filename: "p.png", mime_type: "image/png", base64_data: PIXEL }
});

try {
  await app.ready();

  await run("B8: seller content assets stop at the per-seller count quota (429, no stored object); another seller is unaffected", async () => {
    const seller = `quota-assets-${randomUUID().slice(0, 8)}`;
    for (let i = 0; i < 2; i += 1) assert.equal((await uploadAsset(seller)).statusCode, 200);
    const before = await countStoredFiles(uploadDir);
    const refused = await uploadAsset(seller);
    assert.equal(refused.statusCode, 429, refused.body);
    assert.equal((refused.json() as any).code, "seller_content_asset_quota_exceeded");
    assert.equal(await countStoredFiles(uploadDir), before, "a refused upload writes nothing to storage");
    assert.equal(Number((await pool.query(`SELECT COUNT(*)::int AS n FROM siton.content_assets WHERE owner_ref=$1`, [seller])).rows[0].n), 2);
    assert.equal((await uploadAsset(`quota-other-${randomUUID().slice(0, 8)}`)).statusCode, 200);
  });

  await run("B8: deal images are capped per SELLER across deals (count), before any byte is stored", async () => {
    const seller = `quota-images-${randomUUID().slice(0, 8)}`;
    const dealA = await insertDeal(seller);
    const dealB = await insertDeal(seller);
    assert.equal((await uploadDealImage(seller, dealA)).statusCode, 201);
    assert.equal((await uploadDealImage(seller, dealA)).statusCode, 201);
    assert.equal((await uploadDealImage(seller, dealB)).statusCode, 201);
    const before = await countStoredFiles(uploadDir);
    const refused = await uploadDealImage(seller, dealB);
    assert.equal(refused.statusCode, 429, refused.body);
    assert.equal((refused.json() as any).code, "seller_deal_image_quota_exceeded");
    assert.equal(await countStoredFiles(uploadDir), before);
    const other = `quota-images-other-${randomUUID().slice(0, 8)}`;
    assert.equal((await uploadDealImage(other, await insertDeal(other))).statusCode, 201);
  });

  await run("B8: deal images are capped per seller by total bytes", async () => {
    const previous = process.env.SELLER_DEAL_IMAGE_MAX_BYTES;
    process.env.SELLER_DEAL_IMAGE_MAX_BYTES = String(Buffer.from(PIXEL, "base64").length + 10);
    try {
      const seller = `quota-bytes-${randomUUID().slice(0, 8)}`;
      const deal = await insertDeal(seller);
      assert.equal((await uploadDealImage(seller, deal)).statusCode, 201);
      const refused = await uploadDealImage(seller, deal);
      assert.equal(refused.statusCode, 429, refused.body);
      assert.equal((refused.json() as any).code, "seller_deal_image_quota_exceeded");
    } finally {
      if (previous === undefined) delete process.env.SELLER_DEAL_IMAGE_MAX_BYTES; else process.env.SELLER_DEAL_IMAGE_MAX_BYTES = previous;
    }
  });

  const shareDeal = await insertDeal(`share-seller-${randomUUID().slice(0, 8)}`, true);
  const spoofed = { host: "attacker.example.invalid", "x-forwarded-host": "attacker.example.invalid", "x-forwarded-proto": "https" };

  await run("B7: with a configured public origin the cacheable share page ignores Host / X-Forwarded-Host", async () => {
    process.env.PUBLIC_BASE_URL = "https://c-ton.example.invalid/";
    try {
      const r = await app.inject({ method: "GET", url: `/d/${shareDeal}`, headers: spoofed });
      assert.equal(r.statusCode, 200, r.body.slice(0, 300));
      assert.doesNotMatch(r.body, /attacker\.example\.invalid/, "no caller-controlled host in the page");
      assert.match(r.body, new RegExp(`<meta property="og:url" content="https://c-ton\\.example\\.invalid/d/${shareDeal}">`));
      assert.match(r.body, /<meta property="og:image" content="https:\/\/c-ton\.example\.invalid\//);
      assert.equal(r.headers["cache-control"], "public, max-age=300");
    } finally {
      delete process.env.PUBLIC_BASE_URL;
    }
  });

  await run("B7: without a configured origin a header-derived share page is never publicly cached", async () => {
    const r = await app.inject({ method: "GET", url: `/d/${shareDeal}`, headers: spoofed });
    assert.equal(r.statusCode, 200);
    assert.equal(r.headers["cache-control"], "no-store");
  });
} finally {
  await app.close().catch(() => undefined);
  await pool.end();
}
console.log(`SELLER_UPLOAD_QUOTA_SHARE_ORIGIN_PASS ${passed}`);
process.exit(0);
