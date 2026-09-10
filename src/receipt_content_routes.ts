import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { extractTrackingToken, verifyParticipantTrackingAccess } from "./participant_tracking_security.js";
import { saveDealImage, readDealImage, deleteDealImageFile } from "./product_image_storage.js";
import { failure, loadReceiptOrder, receiptForOrder, redeemReceipt, receiptConfig, validateReceiptConfig, publicSeller, safePublicName, RECEIPT_LABELS, type Db } from "./receipt_trust.js";
import { CONTENT_SECTIONS, readContent, validateContent } from "./site_content.js";

type Deps = {
  withTx: (fn: (c: any) => Promise<any>) => Promise<any>;
  requireSeller: (req: any, reply: any, c: any) => Promise<any>;
  requireAdminRead: (req: any, reply: any) => Promise<any>;
  requireAdminMutation: (req: any, reply: any, permission: string) => Promise<any>;
};
function uuid(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) failure("invalid_id");
  return value;
}
async function buyerOrder(c: Db, req: any) {
  const token = extractTrackingToken(req);
  if (!token) failure("tracking_token_required", 401);
  const id = uuid(req.params.id);
  const row = await loadReceiptOrder(c, id);
  if (!row) failure("receipt_access_denied", 403);
  const access = await verifyParticipantTrackingAccess(c, { participant_id: id, deal_id: row.deal_id, token, purposes: ["tracking", "receipt", "recovery", "support"] });
  if (!access.ok) failure("receipt_access_denied", 403);
  return await loadReceiptOrder(c, id, true) || failure("receipt_access_denied", 403);
}
export function registerReceiptContentRoutes(app: FastifyInstance, deps: Deps) {
  app.get("/api/deals/:id/receipt-info", async (req: any) => deps.withTx(async c => {
    const r = await c.query(`SELECT d.deal_type, d.receipt_config, sa.public_profile_id FROM siton.deals d
      LEFT JOIN siton.seller_accounts sa ON sa.seller_id=d.seller_id WHERE d.deal_id=$1 AND d.published_at IS NOT NULL AND d.state <> 'Draft'`, [uuid(req.params.id)]);
    if (!r.rows[0]) failure("deal_not_found", 404);
    const cfg = receiptConfig(r.rows[0]);
    return { ok: true, method: cfg.method, label: RECEIPT_LABELS[cfg.method], seller: r.rows[0].public_profile_id ? await publicSeller(c, r.rows[0].public_profile_id, 0, false) : null };
  }));
  app.get("/api/public-sellers/:id", async (req: any) => deps.withTx(async c => {
    const page = Number(req.query?.page || 0);
    if (!Number.isSafeInteger(page) || page < 0 || page > 1000000) failure("invalid_page");
    const seller = await publicSeller(c, uuid(req.params.id), page);
    if (!seller) failure("seller_not_found", 404);
    return { ok: true, seller };
  }));
  app.get("/api/seller/deals/:id/receipt", async (req: any, reply: any) => deps.withTx(async c => {
    const seller = await deps.requireSeller(req, reply, c); if (!seller) return reply;
    const r = await c.query(`SELECT deal_id, state, deal_type, receipt_config FROM siton.deals WHERE deal_id=$1 AND seller_id=$2 FOR UPDATE`, [uuid(req.params.id), seller.seller_id]);
    const deal = r.rows[0]; if (!deal) failure("deal_not_found", 404);
    return { ok: true, receipt: receiptConfig(deal), editable: deal.state === "Draft" };
  }));
  app.put("/api/seller/deals/:id/receipt", async (req: any, reply: any) => deps.withTx(async c => {
    const seller = await deps.requireSeller(req, reply, c); if (!seller) return reply;
    const r = await c.query(`SELECT deal_id, state, deal_type, receipt_config FROM siton.deals WHERE deal_id=$1 AND seller_id=$2 FOR UPDATE`, [uuid(req.params.id), seller.seller_id]);
    const deal = r.rows[0]; if (!deal) failure("deal_not_found", 404);
    if (deal.state !== "Draft") failure("receipt_locked_after_publish", 409);
    const config = validateReceiptConfig(req.body);
    await c.query(`UPDATE siton.deals SET receipt_config=$2::jsonb WHERE deal_id=$1`, [deal.deal_id, JSON.stringify(config)]);
    return { ok: true, receipt: config };
  }));
  app.get("/api/participants/:id/entitlement", async (req: any, reply: any) => {
    reply.header("Cache-Control", "no-store");
    return deps.withTx(async c => { const row = await buyerOrder(c, req); return { ok: true, entitlement: await receiptForOrder(c, row), configured: !!row.receipt_config, public_name_opt_in: row.public_name_opt_in }; });
  });
  app.put("/api/participants/:id/public-name", async (req: any) => deps.withTx(async c => {
    const row = await buyerOrder(c, req);
    if (typeof req.body?.opt_in !== "boolean") failure("invalid_opt_in");
    await c.query(`UPDATE siton.participants SET public_name_opt_in=$2 WHERE participant_id=$1`, [row.participant_id, req.body.opt_in]);
    return { ok: true, opt_in: req.body.opt_in };
  }));
  app.get("/api/deals/:id/public-names", async (req: any) => deps.withTx(async c => {
    const rows = (await c.query(`SELECT p.buyer_name FROM siton.participants p JOIN siton.deals d ON d.deal_id=p.deal_id
      WHERE p.deal_id=$1 AND p.public_name_opt_in=true AND d.published_at IS NOT NULL AND d.state <> 'Draft'
      ORDER BY p.created_at DESC LIMIT 30`, [uuid(req.params.id)])).rows;
    return { ok: true, names: rows.map((r: any) => safePublicName(r.buyer_name)) };
  }));
  app.get("/api/seller/receipts", async (req: any, reply: any) => deps.withTx(async c => {
    const seller = await deps.requireSeller(req, reply, c); if (!seller) return reply;
    const q = String(req.query?.q || "").trim().slice(0, 150);
    const code = q.replace(/[^A-Z0-9]/gi, "").toUpperCase();
    const rows = (await c.query(`SELECT p.participant_id FROM siton.participants p JOIN siton.deals d ON d.deal_id=p.deal_id
      WHERE d.seller_id=$1 AND d.state='Completed' AND p.buyer_state='DealCompleted' AND p.money_state IN ('ChargedSuccess','RecoveredCharge')
      AND ($2='' OR p.buyer_name ILIKE '%' || $2 || '%' OR p.buyer_phone ILIKE '%' || $2 || '%'
        OR EXISTS (SELECT 1 FROM siton.fulfillment_units f WHERE f.participant_id=p.participant_id AND replace(f.metadata_jsonb->>'receipt_code','-','')=$3))
      ORDER BY p.created_at DESC LIMIT 100`, [seller.seller_id, q, code])).rows;
    const orders = [];
    for (const r of rows) {
      const row = await loadReceiptOrder(c, r.participant_id, true);
      if (row.seller_id !== seller.seller_id) continue;
      const receipt = await receiptForOrder(c, row);
      if (receipt) orders.push({ participant_id: row.participant_id, name: row.buyer_name, phone: row.buyer_phone, ...receipt });
    }
    return { ok: true, orders };
  }));
  app.post("/api/seller/receipts/:id/redeem", async (req: any, reply: any) => deps.withTx(async c => {
    const seller = await deps.requireSeller(req, reply, c); if (!seller) return reply;
    return redeemReceipt(c, seller.seller_id, uuid(req.params.id), seller.seller_id);
  }));
  app.get("/api/seller/public-profile", async (req: any, reply: any) => deps.withTx(async c => {
    const seller = await deps.requireSeller(req, reply, c); if (!seller) return reply;
    const r = await c.query(`SELECT public_profile_id, profile_image_id FROM siton.seller_accounts WHERE seller_id=$1`, [seller.seller_id]);
    return { ok: true, profile: await publicSeller(c, r.rows[0].public_profile_id), image_id: r.rows[0].profile_image_id };
  }));
  app.put("/api/seller/public-profile", async (req: any, reply: any) => deps.withTx(async c => {
    const seller = await deps.requireSeller(req, reply, c); if (!seller) return reply;
    {
      const { name, about, image_id } = req.body || {};
      if (typeof name !== "string" || !name.trim() || name.length > 120 || typeof about !== "string" || about.length > 1000) failure("invalid_public_profile");
      if (image_id) {
        const asset = await c.query(`SELECT 1 FROM siton.content_assets WHERE asset_id=$1 AND owner_ref=$2`, [uuid(image_id), seller.seller_id]);
        if (!asset.rowCount) failure("invalid_profile_image");
      }
      await c.query(`UPDATE siton.seller_accounts SET business_name=$2, business_description=$3, profile_image_id=$4, updated_at=now() WHERE seller_id=$1`, [seller.seller_id, name.trim(), about.trim(), image_id || null]);
    }
    const r = await c.query(`SELECT public_profile_id, profile_image_id FROM siton.seller_accounts WHERE seller_id=$1`, [seller.seller_id]);
    return { ok: true, profile: await publicSeller(c, r.rows[0].public_profile_id), image_id: r.rows[0].profile_image_id };
  }));
  app.get("/api/site-content", async () => deps.withTx(async c => {
    const sections = await readContent(c);
    return { ok: true, content: Object.fromEntries(Object.entries(sections).map(([key, s]) => [key, s.value])) };
  }));
  app.get("/api/admin/site-content", async (req: any, reply: any) => {
    if (!(await deps.requireAdminRead(req, reply))) return reply;
    return deps.withTx(async c => ({ ok: true, sections: await readContent(c) }));
  });
  app.put("/api/admin/site-content/:key", async (req: any, reply: any) => {
    const admin = await deps.requireAdminMutation(req, reply, "admin_users.manage"); if (!admin) return reply;
    const key = String(req.params.key); const value = validateContent(key, req.body?.value);
    if (!Number.isInteger(req.body?.revision) || req.body.revision < 0) failure("invalid_content_revision");
    return deps.withTx(async c => {
      // Serialize even first creation; optimistic revision prevents lost edits.
      await c.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`site-content:${key}`]);
      const old = (await c.query(`SELECT revision FROM siton.site_content WHERE content_key=$1`, [key])).rows[0];
      if ((old?.revision || 0) !== req.body.revision) failure("content_changed_reload", 409);
      if (value.image) {
        const asset = await c.query(`SELECT 1 FROM siton.content_assets WHERE asset_id=$1 AND owner_ref LIKE 'admin:%'`, [value.image.split('/').pop()]);
        if (!asset.rowCount) failure("invalid_content_image");
      }
      await c.query(`INSERT INTO siton.site_content(content_key,value_jsonb,previous_value_jsonb,updated_by)
        VALUES ($1,$2::jsonb,$4::jsonb,$3) ON CONFLICT(content_key) DO UPDATE SET previous_value_jsonb=site_content.value_jsonb,
        value_jsonb=EXCLUDED.value_jsonb, revision=site_content.revision+1, updated_by=EXCLUDED.updated_by, updated_at=now()`,
        [key, JSON.stringify(value), String(admin.admin_user_id || admin.email), JSON.stringify(CONTENT_SECTIONS[key]!.defaults)]);
      return { ok: true, sections: await readContent(c) };
    });
  });
  app.post("/api/seller/content-assets", async (req: any, reply: any) => {
    const owner = await deps.withTx(c => deps.requireSeller(req, reply, c));
    if (!owner) return reply;
    const ref = owner.seller_id;
    const id = randomUUID();
    const file = await saveDealImage({ dealId: id, mimeType: req.body?.mime_type, base64Data: req.body?.base64_data, originalFilename: req.body?.filename });
    try {
      await deps.withTx(c => c.query(`INSERT INTO siton.content_assets(asset_id,owner_ref,storage_key,mime_type) VALUES($1,$2,$3,$4)`, [id, ref, file.storage_key, file.mime_type]));
    } catch (err) { await deleteDealImageFile(file.storage_key).catch(() => undefined); throw err; }
    return { ok: true, asset_id: id, url: `/api/content-assets/${id}` };
  });
  app.post("/api/admin/content-assets", async (req: any, reply: any) => {
    const owner = await deps.requireAdminMutation(req, reply, "admin_users.manage");
    if (!owner) return reply;
    const ref = `admin:${owner.admin_user_id || owner.email}`;
    const id = randomUUID();
    const file = await saveDealImage({ dealId: id, mimeType: req.body?.mime_type, base64Data: req.body?.base64_data, originalFilename: req.body?.filename });
    try {
      await deps.withTx(c => c.query(`INSERT INTO siton.content_assets(asset_id,owner_ref,storage_key,mime_type) VALUES($1,$2,$3,$4)`, [id, ref, file.storage_key, file.mime_type]));
    } catch (err) { await deleteDealImageFile(file.storage_key).catch(() => undefined); throw err; }
    return { ok: true, asset_id: id, url: `/api/content-assets/${id}` };
  });
  app.get("/api/content-assets/:id", async (req: any, reply: any) => {
    const asset = await deps.withTx(async c => (await c.query(`SELECT storage_key,mime_type FROM siton.content_assets WHERE asset_id=$1`, [uuid(req.params.id)])).rows[0]);
    if (!asset) failure("asset_not_found", 404);
    const file = await readDealImage(asset.storage_key);
    return reply.header("X-Content-Type-Options", "nosniff").type(asset.mime_type).send(file);
  });
}
