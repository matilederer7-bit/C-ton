import { createClientFromRequest } from "npm:@base44/sdk";

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_IMAGES = 5;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY_PATTERN = /^[A-Za-z0-9:_-]{8,160}$/;
const MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function response(error: string, status: number) {
  return Response.json({ ok: false, error, code: error }, { status });
}

function bytesMatchMime(bytes: Uint8Array, mimeType: string) {
  if (mimeType === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mimeType === "image/png") {
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    return bytes.length >= signature.length && signature.every((value, index) => bytes[index] === value);
  }
  return mimeType === "image/webp" && bytes.length >= 12
    && new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF"
    && new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP";
}

async function sellerAuthority(base44: any, req: Request) {
  let user: Record<string, unknown>;
  try {
    user = await base44.auth.me();
  } catch {
    return { error: response("SELLER_AUTH_REQUIRED", 401) };
  }
  const userId = String(user?.id ?? "").trim();
  if (!userId) return { error: response("SELLER_AUTH_REQUIRED", 401) };
  const identities = await base44.asServiceRole.entities.SellerIdentity.filter(
    { base44_user_id: userId }, "-updated_date", 20, 0,
    ["id", "base44_user_id", "seller_account_id", "updated_date"]
  );
  const rows = Array.isArray(identities) ? identities as Record<string, unknown>[] : [];
  const sellerIds = [...new Set(rows.map((row) => String(row.seller_account_id ?? "").trim()).filter(Boolean))];
  if (rows.length === 0) return { error: response("SELLER_ONBOARDING_REQUIRED", 409) };
  if (sellerIds.length !== 1 || rows.some((row) => String(row.base44_user_id ?? "") !== userId)) {
    return { error: response("SELLER_FORBIDDEN", 403) };
  }
  return { userId, sellerId: sellerIds[0], request: req };
}

async function ownedDraft(base44: any, dealId: string, sellerId: string) {
  const deals = await base44.asServiceRole.entities.Deal.filter(
    { deal_id: dealId }, "-updated_date", 2, 0,
    ["id", "deal_id", "seller_id", "state", "published_at"]
  );
  if (!Array.isArray(deals) || deals.length !== 1 || String(deals[0]?.seller_id ?? "") !== sellerId) return null;
  return String(deals[0]?.state ?? "") === "Draft" ? deals[0] as Record<string, unknown> : null;
}

async function ownerImages(base44: any, dealId: string, userId: string) {
  const rows = await base44.asServiceRole.entities.DealImage.filter(
    { deal_id: dealId, seller_user_id: userId }, "sort_order", MAX_IMAGES + 2, 0,
    ["id", "deal_id", "seller_user_id", "upload_key", "public_url", "thumbnail_url", "mime_type", "size_bytes", "sort_order", "is_primary", "is_published"]
  );
  return Array.isArray(rows) ? rows as Record<string, unknown>[] : [];
}

async function parseInput(req: Request) {
  const contentType = String(req.headers.get("content-type") ?? "").toLowerCase();
  if (contentType.includes("multipart/form-data")) {
    const form = await req.formData();
    return {
      input: Object.fromEntries([...form.entries()].filter(([, value]) => typeof value === "string")),
      file: form.get("file") instanceof File ? form.get("file") as File : null
    };
  }
  try {
    return { input: recordValue(await req.json()) ?? {}, file: null };
  } catch {
    return { input: {}, file: null };
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return response("method_not_allowed", 405);
  const base44 = createClientFromRequest(req);
  try {
    const authority = await sellerAuthority(base44, req);
    if (authority.error) return authority.error;
    const { input, file } = await parseInput(req);
    const action = String(input.action ?? "upload");
    const dealId = String(input.deal_id ?? "").trim();
    if (!UUID_PATTERN.test(dealId)) return response("deal_id_invalid", 400);
    const deal = await ownedDraft(base44, dealId, String(authority.sellerId));
    if (!deal) return response("deal_not_found", 404);
    const images = await ownerImages(base44, dealId, String(authority.userId));

    if (action === "list") {
      return Response.json({
        ok: true,
        editable: true,
        images: images.map((image) => ({
          image_id: image.id,
          file_url: image.public_url,
          thumbnail_url: image.thumbnail_url,
          mime_type: image.mime_type,
          size_bytes: image.size_bytes,
          sort_order: image.sort_order,
          is_primary: image.is_primary === true
        }))
      });
    }

    if (action === "delete") {
      const imageId = String(input.image_id ?? "").trim();
      const image = images.find((row) => String(row.id ?? "") === imageId);
      if (!image) return response("image_not_found", 404);
      await base44.asServiceRole.entities.DealImage.delete(imageId);
      const remaining = images.filter((row) => String(row.id ?? "") !== imageId);
      if (image.is_primary === true && remaining[0]?.id) {
        await base44.asServiceRole.entities.DealImage.update(remaining[0].id, { is_primary: true });
      }
      return Response.json({ ok: true, deleted: true, image_id: imageId });
    }

    if (action === "reorder") {
      const order = Array.isArray(input.images) ? input.images.slice(0, MAX_IMAGES) : [];
      const requestedIds = order.map((row) => String(recordValue(row)?.image_id ?? ""));
      const existingIds = images.map((row) => String(row.id ?? ""));
      if (requestedIds.length !== existingIds.length || new Set(requestedIds).size !== requestedIds.length
        || requestedIds.some((id) => !existingIds.includes(id))) return response("image_order_invalid", 400);
      const normalizedOrder = order.map((raw, index) => ({
        id: requestedIds[index],
        sort_order: index,
        is_primary: recordValue(raw)?.is_primary === true
      }));
      const primaryCount = normalizedOrder.filter((row) => row.is_primary).length;
      if (primaryCount !== 1) return response("image_primary_invalid", 400);
      await base44.asServiceRole.entities.DealImage.bulkUpdate(normalizedOrder);
      return Response.json({ ok: true, reordered: true });
    }

    if (action !== "upload" || !file) return response("image_file_required", 400);
    const uploadKey = String(input.idempotency_key ?? req.headers.get("idempotency-key") ?? "").trim();
    if (!KEY_PATTERN.test(uploadKey)) return response("IDEMPOTENCY_KEY_INVALID", 400);
    const replay = images.find((row) => String(row.upload_key ?? "") === uploadKey);
    if (replay) return Response.json({ ok: true, duplicate: true, image: replay });
    if (images.length >= MAX_IMAGES) return response("image_limit_exceeded", 409);
    const mimeType = String(file.type ?? "").toLowerCase();
    if (!(MIME_TYPES as readonly string[]).includes(mimeType)) return response("invalid_image_type", 415);
    if (file.size < 1 || file.size > MAX_IMAGE_BYTES) return response("image_too_large", 413);
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!bytesMatchMime(bytes, mimeType)) return response("image_content_mismatch", 415);
    const safeName = String(file.name || "siton-product-image").replace(/[^A-Za-z0-9._-]/g, "-").slice(-120);
    const verifiedFile = new File([bytes], safeName || "siton-product-image", { type: mimeType });
    const uploaded = await base44.integrations.Core.UploadFile({ file: verifiedFile });
    const publicUrl = String(uploaded?.file_url ?? "").trim();
    if (!/^https:\/\/[^\s]+$/i.test(publicUrl)) return response("image_storage_unavailable", 503);
    const makePrimary = images.length === 0
      || !images.some((image) => image.is_primary === true)
      || input.is_primary === true
      || String(input.is_primary) === "true";
    let created = await base44.asServiceRole.entities.DealImage.create({
      deal_id: dealId,
      seller_user_id: authority.userId,
      storage_object_ref: publicUrl,
      upload_key: uploadKey,
      public_url: publicUrl,
      thumbnail_url: publicUrl,
      mime_type: mimeType,
      size_bytes: bytes.byteLength,
      sort_order: Math.min(images.length, Math.max(0, Number(input.sort_order ?? images.length) || 0)),
      is_primary: makePrimary && images.length === 0,
      is_published: false
    });
    if (makePrimary && images.length > 0) {
      if (!created?.id) throw new Error("image_record_id_missing");
      const updates = [
        ...images
          .filter((image) => image.is_primary === true && image.id)
          .map((image) => ({ id: image.id, is_primary: false })),
        { id: created.id, is_primary: true }
      ];
      const updated = await base44.asServiceRole.entities.DealImage.bulkUpdate(updates);
      const promoted = Array.isArray(updated)
        ? updated.find((image) => String(image?.id ?? "") === String(created.id))
        : null;
      created = promoted ?? { ...created, is_primary: true };
    }
    return Response.json({ ok: true, duplicate: false, image: created }, { status: 201 });
  } catch {
    return response("seller_image_unavailable", 503);
  }
});
