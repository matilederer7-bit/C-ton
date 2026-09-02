import { createClientFromRequest } from "npm:@base44/sdk";

const PRODUCT_TYPES = ["physical_product", "voucher", "ticket", "service"] as const;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function response(error: string, status: number) {
  return Response.json({ ok: false, error, code: error }, { status });
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function bounded(value: unknown, max: number) {
  return String(value ?? "").trim().slice(0, max);
}

async function sellerAuthority(base44: any) {
  let user: Record<string, unknown>;
  try { user = await base44.auth.me(); } catch { return { error: response("SELLER_AUTH_REQUIRED", 401) }; }
  const userId = bounded(user?.id, 160);
  if (!userId) return { error: response("SELLER_AUTH_REQUIRED", 401) };
  const rows = await base44.asServiceRole.entities.SellerIdentity.filter(
    { base44_user_id: userId }, "-updated_date", 20, 0,
    ["id", "base44_user_id", "seller_account_id"]
  );
  const identities = Array.isArray(rows) ? rows as Record<string, unknown>[] : [];
  const sellerIds = [...new Set(identities.map((row) => bounded(row.seller_account_id, 160)).filter(Boolean))];
  if (identities.length === 0) return { error: response("SELLER_ONBOARDING_REQUIRED", 409) };
  if (sellerIds.length !== 1 || identities.some((row) => bounded(row.base44_user_id, 160) !== userId)) {
    return { error: response("SELLER_FORBIDDEN", 403) };
  }
  return { userId, sellerId: sellerIds[0] };
}

function normalizedProduct(input: Record<string, unknown>, current: Record<string, unknown> = {}) {
  const name = bounded(input.name ?? current.name, 200);
  if (!name) throw new Error("product_name_required");
  const productType = bounded(input.product_type ?? current.product_type, 40);
  if (!(PRODUCT_TYPES as readonly string[]).includes(productType)) throw new Error("product_type_invalid");
  const imageRefs = input.image_refs ?? current.image_refs;
  return {
    name,
    short_description: bounded(input.short_description ?? current.short_description, 200),
    long_description: bounded(input.long_description ?? current.long_description, 4000),
    product_type: productType,
    category: bounded(input.category ?? current.category, 160),
    type_attributes: object(input.type_attributes ?? current.type_attributes),
    fulfillment_defaults: object(input.fulfillment_defaults ?? current.fulfillment_defaults),
    image_refs: Array.isArray(imageRefs)
      ? imageRefs.slice(0, 12).map((value: unknown) => bounded(value, 160)).filter(Boolean)
      : []
  };
}

async function ownedProduct(base44: any, productId: string, sellerId: string) {
  const rows = await base44.asServiceRole.entities.Product.filter(
    { product_id: productId }, "-updated_date", 2, 0,
    ["id", "product_id", "seller_account_id", "seller_user_id", "name", "short_description", "long_description", "product_type", "category", "type_attributes", "fulfillment_defaults", "image_refs", "status", "revision", "created_date", "updated_date"]
  );
  if (!Array.isArray(rows) || rows.length !== 1 || bounded(rows[0]?.seller_account_id, 160) !== sellerId) return null;
  return rows[0] as Record<string, unknown>;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return response("method_not_allowed", 405);
  const base44 = createClientFromRequest(req);
  try {
    const authority = await sellerAuthority(base44);
    if (authority.error) return authority.error;
    const input = object(await req.json().catch(() => ({})));
    const action = bounded(input.action || "list", 40);

    if (action === "list") {
      const rows = await base44.asServiceRole.entities.Product.filter(
        { seller_account_id: authority.sellerId }, "-updated_date", 200, 0,
        ["id", "product_id", "name", "short_description", "product_type", "category", "image_refs", "status", "revision", "created_date", "updated_date"]
      );
      return Response.json({ ok: true, products: Array.isArray(rows) ? rows : [] });
    }

    if (action === "create") {
      const product = normalizedProduct(input);
      const created = await base44.asServiceRole.entities.Product.create({
        product_id: crypto.randomUUID(), seller_account_id: authority.sellerId,
        seller_user_id: authority.userId, ...product, status: "active", revision: 1
      });
      return Response.json({ ok: true, product: created }, { status: 201 });
    }

    const productId = bounded(input.product_id, 80);
    if (!UUID_PATTERN.test(productId)) return response("product_id_invalid", 400);
    const current = await ownedProduct(base44, productId, authority.sellerId);
    if (!current) return response("product_not_found", 404);
    if (action === "get") return Response.json({ ok: true, product: current });
    if (action === "update") {
      const next = normalizedProduct(input, current);
      const updated = await base44.asServiceRole.entities.Product.update(String(current.id), {
        ...next, revision: Number(current.revision ?? 1) + 1
      });
      return Response.json({ ok: true, product: updated });
    }
    if (action === "archive") {
      const updated = await base44.asServiceRole.entities.Product.update(String(current.id), {
        status: "archived", revision: Number(current.revision ?? 1) + 1
      });
      return Response.json({ ok: true, product: updated });
    }
    return response("action_invalid", 400);
  } catch (error) {
    const code = bounded(error instanceof Error ? error.message : "product_operation_failed", 120) || "product_operation_failed";
    return response(code, code.endsWith("_required") || code.endsWith("_invalid") ? 400 : 500);
  }
});
