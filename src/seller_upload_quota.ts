// Black-Sky B8: per-seller upload quotas for seller-originated media.
//
// Two seller-authenticated upload surfaces store binary content on the
// platform's object storage without any ceiling on how much ONE seller may
// accumulate: profile/content assets (/api/seller/content-assets) and deal
// images (/api/seller/deals/:id/images). Per-request size and per-deal image
// counts were already bounded, but a seller account could still create an
// unbounded number of assets or drafts and fill the bucket (cost + storage
// exhaustion). These quotas are enforced server-side, inside the transaction
// that records the object, serialized per seller by an advisory lock so two
// concurrent uploads cannot both squeeze under the ceiling.
//
// Limits are environment-tunable, never client-controllable, and default to
// generous pilot values (content assets: 40 objects; deal images: 240 objects
// / 512 MiB per seller = 20 fully illustrated deals at the 12-image cap).
// content_assets carries no size column (and this track adds no migration),
// so its byte ceiling is the count cap times the per-object maximum enforced
// upstream (DEAL_IMAGE_MAX_BYTES).

export const SELLER_CONTENT_ASSET_MAX_COUNT_DEFAULT = 40;
export const SELLER_DEAL_IMAGE_MAX_COUNT_DEFAULT = 240;
export const SELLER_DEAL_IMAGE_MAX_BYTES_DEFAULT = 512 * 1024 * 1024;

type Queryable = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

function positiveIntegerEnv(name: string, fallback: number): number {
  const raw = String(process.env[name] || "").trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function sellerUploadQuotaLimits() {
  return {
    content_asset_max_count: positiveIntegerEnv("SELLER_CONTENT_ASSET_MAX_COUNT", SELLER_CONTENT_ASSET_MAX_COUNT_DEFAULT),
    deal_image_max_count: positiveIntegerEnv("SELLER_DEAL_IMAGE_MAX_COUNT", SELLER_DEAL_IMAGE_MAX_COUNT_DEFAULT),
    deal_image_max_bytes: positiveIntegerEnv("SELLER_DEAL_IMAGE_MAX_BYTES", SELLER_DEAL_IMAGE_MAX_BYTES_DEFAULT)
  };
}

export class SellerUploadQuotaError extends Error {
  readonly statusCode = 429;
  constructor(readonly code: "seller_content_asset_quota_exceeded" | "seller_deal_image_quota_exceeded", message: string, readonly limit: number, readonly current: number) {
    super(message);
    this.name = "SellerUploadQuotaError";
  }
}

async function lockSellerUploads(c: Queryable, sellerId: string) {
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended('seller-upload-quota:' || $1, 0))", [sellerId]);
}

/** Refuses when the seller already holds the maximum number of content assets. Call inside the recording transaction. */
export async function assertSellerContentAssetQuota(c: Queryable, sellerId: string): Promise<{ count: number; limit: number }> {
  const limits = sellerUploadQuotaLimits();
  await lockSellerUploads(c, sellerId);
  const r = await c.query(`SELECT COUNT(*)::int AS count FROM siton.content_assets WHERE owner_ref=$1`, [sellerId]);
  const count = Number(r.rows[0]?.count || 0);
  if (count >= limits.content_asset_max_count) {
    throw new SellerUploadQuotaError("seller_content_asset_quota_exceeded", `seller content asset quota reached (${limits.content_asset_max_count} objects)`, limits.content_asset_max_count, count);
  }
  return { count, limit: limits.content_asset_max_count };
}

/** Refuses when adding `incomingBytes` would exceed the seller's deal-image count or byte quota. Call inside the recording transaction. */
export async function assertSellerDealImageQuota(c: Queryable, sellerId: string, incomingBytes: number): Promise<{ count: number; bytes: number }> {
  const limits = sellerUploadQuotaLimits();
  await lockSellerUploads(c, sellerId);
  const r = await c.query(
    `SELECT COUNT(*)::int AS count, COALESCE(SUM(i.size_bytes), 0)::bigint AS bytes
     FROM siton.deal_images i JOIN siton.deals d ON d.deal_id=i.deal_id
     WHERE d.seller_id=$1`,
    [sellerId]
  );
  const count = Number(r.rows[0]?.count || 0);
  const bytes = Number(r.rows[0]?.bytes || 0);
  if (count >= limits.deal_image_max_count) {
    throw new SellerUploadQuotaError("seller_deal_image_quota_exceeded", `seller deal image quota reached (${limits.deal_image_max_count} objects)`, limits.deal_image_max_count, count);
  }
  if (bytes + Math.max(0, Math.floor(incomingBytes)) > limits.deal_image_max_bytes) {
    throw new SellerUploadQuotaError("seller_deal_image_quota_exceeded", `seller deal image storage quota reached (${limits.deal_image_max_bytes} bytes)`, limits.deal_image_max_bytes, bytes);
  }
  return { count, bytes };
}

/** Decoded byte length of a base64 payload without allocating the buffer. */
export function base64DecodedLength(base64: string): number {
  const clean = String(base64 || "").replace(/\s+/g, "");
  if (!clean) return 0;
  const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((clean.length * 3) / 4) - padding);
}
