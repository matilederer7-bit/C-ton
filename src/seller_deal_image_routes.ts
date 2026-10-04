import { createHash } from "crypto";
import { hitTestFault } from "./fault_injection.js";
import {
  deleteDealImageFile,
  getDealImagePublicUrl,
  resolveDealImageUrl,
  saveDealImage
} from "./product_image_storage.js";
import { assertSellerDealImageQuota, base64DecodedLength } from "./seller_upload_quota.js";
import { ensureRemainingProductSurfaceTables } from "./product_surface_support.js";
import { normalizeSellerId } from "./seller_auth.js";
import type { StorageProviderCode } from "./storage_adapter.js";

const DEAL_IMAGE_LIMIT = 12;

type SellerDealImageRouteDeps = {
  IMAGE_UPLOAD_BODY_LIMIT_BYTES: number;
  withTx: any;
  requireSellerAuthority: any;
  requireSellerAuthorityWithoutBody: any;
  ensureSellerActionAllowed: any;
  requireUuid: any;
  isAccepted: (value: unknown) => boolean;
  enqueueStorageCleanupTask: (storageProvider: StorageProviderCode, storageKey: string, reason: string) => Promise<any>;
  storageCleanupErrorCode: (error: unknown) => string;
};

function parseImageUploadBody(body: any) {
  const dataUrl = String(body?.image_data_url || body?.data_url || "").trim();
  const explicitBase64 = String(body?.image_base64 || body?.base64 || "").trim();
  const explicitMimeType = String(body?.mime_type || "").trim().toLowerCase();
  if (dataUrl) {
    const match = dataUrl.match(/^data:(image\/(?:jpeg|png|webp));base64,([a-zA-Z0-9+/=\r\n]+)$/);
    if (!match) {
      const err: any = new Error("invalid image data");
      err.statusCode = 400;
      err.code = "invalid_image_type";
      throw err;
    }
    return {
      mimeType: String(match[1] || ""),
      base64Data: String(match[2] || "").replace(/\s/g, "")
    };
  }
  return {
    mimeType: explicitMimeType,
    base64Data: explicitBase64.replace(/\s/g, "")
  };
}

export function registerSellerDealImageRoutes(app: any, deps: SellerDealImageRouteDeps) {
  const {
    IMAGE_UPLOAD_BODY_LIMIT_BYTES,
    withTx,
    requireSellerAuthority,
    requireSellerAuthorityWithoutBody,
    ensureSellerActionAllowed,
    requireUuid,
    isAccepted,
    enqueueStorageCleanupTask,
    storageCleanupErrorCode
  } = deps;

  app.post("/api/seller/deals/:dealId/images", { bodyLimit: IMAGE_UPLOAD_BODY_LIMIT_BYTES }, async (req: any, reply: any) => {
    await ensureRemainingProductSurfaceTables(withTx);
    const dealId = String(req.params.dealId || "");

    const response = await withTx(async (c) => {
      const sellerAuthority = await requireSellerAuthority(req, c);
      await ensureSellerActionAllowed(c, sellerAuthority.seller_id, "operate");
      // Authorization precedes every observation: the id shape, the upload body
      // and the idempotency key are validated only for an authenticated seller.
      requireUuid(dealId, "deal_id");
      const body = req.body || {};
      const parsed = parseImageUploadBody(body);
      const originalFilename = String(body.original_filename || body.filename || "").trim() || null;
      const imageIdempotencyKey = String(req.headers?.["idempotency-key"] || "").trim();
      if (imageIdempotencyKey.length > 200) {
        throw Object.assign(new Error("idempotency key is too long"), { statusCode: 400, code: "IDEMPOTENCY_KEY_INVALID" });
      }
      const imageRequestHash = createHash("sha256")
        .update(parsed.mimeType)
        .update("\0")
        .update(parsed.base64Data)
        .update("\0")
        .update(originalFilename || "")
        .update("\0")
        .update(String(Boolean(isAccepted(body.is_primary))))
        .update("\0")
        .update(String(body.sort_order ?? ""))
        .digest("hex");
      // Serialize image-list mutations for this deal across Web instances.
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended('deal-image:' || $1, 0))", [dealId]);
      const dealResult = await c.query(
        `SELECT seller_id, state FROM siton.deals WHERE deal_id=$1`,
        [dealId]
      );
      if (!dealResult.rowCount) {
        const err: any = new Error("deal not found");
        err.statusCode = 404;
        throw err;
      }
      const deal = dealResult.rows[0];
      if (normalizeSellerId(deal.seller_id) !== sellerAuthority.seller_id) {
        const err: any = new Error("deal not found");
        err.statusCode = 404;
        throw err;
      }
      if (String(deal.state) !== "Draft") {
        const err: any = new Error("deal already published");
        err.statusCode = 409;
        err.code = "deal_already_published";
        throw err;
      }
      if (imageIdempotencyKey) {
        const prior = await c.query(
          `SELECT request_hash, response_jsonb
           FROM siton.idempotency_log
           WHERE entity_type='deal' AND entity_id=$1
             AND action_name='seller_deal_image_upload' AND idempotency_key=$2
           LIMIT 1`,
          [dealId, imageIdempotencyKey]
        );
        if (prior.rowCount) {
          if (String(prior.rows[0].request_hash || "") !== imageRequestHash) {
            throw Object.assign(new Error("idempotency key was already used with a different image payload"), {
              statusCode: 409,
              code: "IDEMPOTENCY_PAYLOAD_MISMATCH"
            });
          }
          const replay = prior.rows[0].response_jsonb && typeof prior.rows[0].response_jsonb === "object"
            ? prior.rows[0].response_jsonb
            : {};
          return { ...replay, idempotent_replay: true };
        }
      }
      const existingImages = await c.query(
        `SELECT image_id, is_primary FROM siton.deal_images WHERE deal_id=$1 ORDER BY sort_order ASC, created_at ASC`,
        [dealId]
      );
      if (existingImages.rowCount >= DEAL_IMAGE_LIMIT) {
        const err: any = new Error(`deal can have up to ${DEAL_IMAGE_LIMIT} images`);
        err.statusCode = 400;
        err.code = "deal_image_limit";
        throw err;
      }
      const requestedPrimary = isAccepted(body.is_primary) || existingImages.rowCount === 0 || !existingImages.rows.some((row: any) => Boolean(row.is_primary));
      const sortOrderRaw = Number(body.sort_order);
      const sortOrder = Number.isInteger(sortOrderRaw) && sortOrderRaw >= 0 ? Math.min(sortOrderRaw, DEAL_IMAGE_LIMIT - 1) : existingImages.rowCount;

      // Black-Sky B8: the per-deal cap above bounds ONE deal; this bounds what
      // ONE seller may accumulate across all deals (count + bytes), serialized
      // per seller, before any byte reaches storage.
      await assertSellerDealImageQuota(c, sellerAuthority.seller_id, base64DecodedLength(parsed.base64Data));

      const saved = await saveDealImage({
        dealId,
        originalFilename,
        mimeType: parsed.mimeType,
        base64Data: parsed.base64Data
      });

      let responsePayload: any;
      try {
        if (requestedPrimary) {
          await c.query(`UPDATE siton.deal_images SET is_primary=false WHERE deal_id=$1`, [dealId]);
        }
        const inserted = await c.query(
          `INSERT INTO siton.deal_images
             (deal_id, storage_provider, storage_key, public_url, original_filename, mime_type, size_bytes, checksum_sha256, sort_order, is_primary)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           RETURNING image_id, deal_id, mime_type, size_bytes, is_primary, sort_order`,
          [
            dealId,
            saved.storage_provider,
            saved.storage_key,
            saved.public_url,
            saved.original_filename,
            saved.mime_type,
            saved.size_bytes,
            saved.checksum_sha256,
            sortOrder,
            requestedPrimary
          ]
        );
        const image = inserted.rows[0];
        responsePayload = {
          ok: true,
          image: {
            image_id: image.image_id,
            deal_id: image.deal_id,
            public_url: saved.public_url || getDealImagePublicUrl(image),
            image_url: saved.public_url || getDealImagePublicUrl(image),
            mime_type: image.mime_type,
            size_bytes: Number(image.size_bytes),
            is_primary: Boolean(image.is_primary),
            sort_order: Number(image.sort_order || 0)
          }
        };
        if (imageIdempotencyKey) {
          await c.query(
            `INSERT INTO siton.idempotency_log
               (entity_type, entity_id, action_name, idempotency_key, request_hash, response_code, response_jsonb)
             VALUES ('deal',$1,'seller_deal_image_upload',$2,$3,'OK',$4)`,
            [dealId, imageIdempotencyKey, imageRequestHash, JSON.stringify(responsePayload)]
          );
        }
      } catch (error) {
        try {
          await deleteDealImageFile(saved.storage_key);
        } catch (cleanupError) {
          await enqueueStorageCleanupTask(saved.storage_provider, saved.storage_key, "deal_image_metadata_write_failed").catch((enqueueError) => {
            app.log.error({ cleanup_error_code: storageCleanupErrorCode(cleanupError), enqueue_error_code: storageCleanupErrorCode(enqueueError) }, "storage_cleanup_enqueue_failed");
          });
        }
        throw error;
      }
      return responsePayload;
    });

    // A successful write must not be visible to the client before COMMIT.
    await hitTestFault("http.upload.after_commit_before_response");
    return reply.code(201).send(response);
  });

  app.patch("/api/seller/deals/:dealId/images/order", async (req: any) => {
    await ensureRemainingProductSurfaceTables(withTx);
    const dealId = String(req.params.dealId || "");

    return withTx(async (c) => {
      const sellerAuthority = await requireSellerAuthorityWithoutBody(req, c);
      await ensureSellerActionAllowed(c, sellerAuthority.seller_id, "operate");
      // Authorization precedes every observation.
      requireUuid(dealId, "deal_id");
      const body = req.body || {};
      const requestedOrder = Array.isArray(body.ordered_image_ids)
        ? body.ordered_image_ids.map((value: unknown) => String(value || "").trim())
        : null;
      const requestedPrimary = body.primary_image_id === null || body.primary_image_id === undefined
        ? null
        : String(body.primary_image_id || "").trim();
      if (requestedOrder && requestedOrder.length > DEAL_IMAGE_LIMIT) {
        throw Object.assign(new Error(`deal can have up to ${DEAL_IMAGE_LIMIT} images`), { statusCode: 400, code: "deal_image_limit" });
      }
      for (const imageId of requestedOrder || []) requireUuid(imageId, "image_id");
      if (requestedPrimary) requireUuid(requestedPrimary, "primary_image_id");
      if (requestedOrder && new Set(requestedOrder).size !== requestedOrder.length) {
        throw Object.assign(new Error("ordered_image_ids must not contain duplicates"), { statusCode: 400, code: "DEAL_IMAGE_ORDER_INVALID" });
      }
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended('deal-image:' || $1, 0))", [dealId]);
      const dealResult = await c.query(`SELECT seller_id, state FROM siton.deals WHERE deal_id=$1 FOR UPDATE`, [dealId]);
      if (!dealResult.rowCount || normalizeSellerId(dealResult.rows[0].seller_id) !== sellerAuthority.seller_id) {
        throw Object.assign(new Error("deal not found"), { statusCode: 404, code: "deal_not_found" });
      }
      // P0.2 — reordering and choosing the primary image are PRESENTATIONAL over
      // the same locked image set, so they stay allowed after publication too
      // (adding/removing images remains Draft-only: buyers joined on what they
      // saw, and this route can neither add nor remove).
      const existing = await c.query(
        `SELECT image_id, public_url, mime_type, size_bytes, is_primary, sort_order
         FROM siton.deal_images
         WHERE deal_id=$1
         ORDER BY sort_order ASC, created_at ASC
         FOR UPDATE`,
        [dealId]
      );
      const existingIds = existing.rows.map((row: any) => String(row.image_id));
      const orderedIds = requestedOrder || existingIds;
      if (orderedIds.length !== existingIds.length || orderedIds.some((imageId: string) => !existingIds.includes(imageId))) {
        throw Object.assign(new Error("ordered_image_ids must contain every current deal image exactly once"), {
          statusCode: 409,
          code: "DEAL_IMAGE_ORDER_STALE"
        });
      }
      const currentPrimary = existing.rows.find((row: any) => Boolean(row.is_primary));
      const primaryImageId = requestedPrimary || String(currentPrimary?.image_id || orderedIds[0] || "");
      if (primaryImageId && !existingIds.includes(primaryImageId)) {
        throw Object.assign(new Error("primary_image_id must belong to this Draft"), { statusCode: 400, code: "DEAL_IMAGE_PRIMARY_INVALID" });
      }

      await c.query(`UPDATE siton.deal_images SET is_primary=false WHERE deal_id=$1`, [dealId]);
      for (const [sortOrder, imageId] of orderedIds.entries()) {
        await c.query(
          `UPDATE siton.deal_images
           SET sort_order=$3, is_primary=($2=$4)
           WHERE deal_id=$1 AND image_id=$2`,
          [dealId, imageId, sortOrder, primaryImageId || null]
        );
      }
      const updated = await c.query(
        `SELECT image_id, deal_id, public_url, mime_type, size_bytes, is_primary, sort_order
         FROM siton.deal_images
         WHERE deal_id=$1
         ORDER BY sort_order ASC, created_at ASC`,
        [dealId]
      );
      return {
        ok: true,
        images: updated.rows.map((image: any) => ({
          image_id: image.image_id,
          deal_id: image.deal_id,
          public_url: resolveDealImageUrl(image),
          image_url: resolveDealImageUrl(image),
          mime_type: image.mime_type,
          size_bytes: Number(image.size_bytes),
          is_primary: Boolean(image.is_primary),
          sort_order: Number(image.sort_order || 0)
        }))
      };
    });
  });

  app.delete("/api/seller/deals/:dealId/images/:imageId", async (req: any, reply: any) => {
    const dealId = String(req.params.dealId || "");
    const imageId = String(req.params.imageId || "");
    const removed = await withTx(async (c) => {
      const sellerAuthority = await requireSellerAuthority(req, c);
      await ensureSellerActionAllowed(c, sellerAuthority.seller_id, "operate");
      requireUuid(dealId, "deal_id"); // after the guard: authorization precedes observation
      requireUuid(imageId, "image_id");
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended('deal-image:' || $1, 0))", [dealId]);
      const result = await c.query(
        `SELECT i.storage_provider, i.storage_key, i.is_primary, d.seller_id, d.state
         FROM siton.deal_images i JOIN siton.deals d ON d.deal_id=i.deal_id
         WHERE i.deal_id=$1 AND i.image_id=$2 FOR UPDATE`,
        [dealId, imageId]
      );
      if (!result.rowCount) throw Object.assign(new Error("deal image not found"), { statusCode: 404, code: "deal_image_not_found" });
      const image = result.rows[0];
      if (normalizeSellerId(image.seller_id) !== sellerAuthority.seller_id) throw Object.assign(new Error("deal image not found"), { statusCode: 404, code: "deal_image_not_found" });
      if (String(image.state) !== "Draft") throw Object.assign(new Error("deal already published"), { statusCode: 409, code: "deal_already_published" });
      await c.query(`DELETE FROM siton.deal_images WHERE image_id=$1`, [imageId]);
      if (image.is_primary) {
        await c.query(
          `UPDATE siton.deal_images SET is_primary=true
           WHERE image_id=(SELECT image_id FROM siton.deal_images WHERE deal_id=$1 ORDER BY sort_order, created_at LIMIT 1)`,
          [dealId]
        );
      }
      // The same storage object may back another Deal's image. Product Library
      // metadata is no longer a runtime reference source (PR C1), so Deal-image
      // metadata alone decides whether the blob can be removed.
      const shared = await c.query(
        `SELECT EXISTS (
           SELECT 1 FROM siton.deal_images WHERE storage_provider=$1 AND storage_key=$2
         ) AS still_referenced`,
        [image.storage_provider, image.storage_key]
      );
      return { storage_provider: image.storage_provider as StorageProviderCode, storage_key: String(image.storage_key), can_delete: !shared.rows[0]?.still_referenced };
    });

    let deletion: "deleted" | "scheduled" | "retained_shared" = removed.can_delete ? "deleted" : "retained_shared";
    if (!removed.can_delete) {
      await hitTestFault("http.delete.after_commit_before_response");
      return reply.send({ ok: true, deletion });
    }
    try {
      await deleteDealImageFile(removed.storage_key);
    } catch (error) {
      await enqueueStorageCleanupTask(removed.storage_provider, removed.storage_key, "deal_image_deleted");
      deletion = "scheduled";
    }
    await hitTestFault("http.delete.after_commit_before_response");
    return reply.send({ ok: true, deletion });
  });
}
