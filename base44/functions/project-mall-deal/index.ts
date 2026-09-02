import { createClientFromRequest } from "npm:@base44/sdk";

const STATUS_BY_STATE: Record<string, string> = {
  PendingTarget: "underway",
  TargetReached: "reached_target",
  ClosedForJoining: "reached_target",
  ReadyForCharging: "reached_target",
  Charging: "reached_target",
  CompletionWindow: "reached_target",
  Completed: "succeeded",
  Failed: "failed",
  Cancelled: "cancelled"
};
const DEAL_TYPES = ["physical_product", "voucher", "ticket", "service"] as const;
const HOOK_ENTITIES = ["Deal", "DealImage"] as const;
const HOOK_EVENTS = ["create", "update", "delete"] as const;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function nonNegative(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function excerpt(value: unknown): string {
  return String(value ?? "").trim().slice(0, 180);
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

async function resolveInvocation(base44: any, body: Record<string, unknown>) {
  const event = recordValue(body.event);
  if (!event) {
    return {
      kind: "manual" as const,
      deal_id: String(body.deal_id ?? "").trim(),
      event_type: null,
      delete_deal: false,
      no_op: false
    };
  }

  const entityName = String(event.entity_name ?? "");
  const eventType = String(event.type ?? "");
  const entityId = String(event.entity_id ?? "").trim();
  if (!(HOOK_ENTITIES as readonly string[]).includes(entityName)
    || !(HOOK_EVENTS as readonly string[]).includes(eventType)
    || !entityId) {
    throw new Error("invalid_hook_payload");
  }

  let source = eventType === "delete" ? recordValue(body.old_data) : recordValue(body.data);
  if (body.payload_too_large === true && eventType !== "delete") {
    source = entityName === "Deal"
      ? await base44.asServiceRole.entities.Deal.get(entityId)
      : await base44.asServiceRole.entities.DealImage.get(entityId);
  }
  let dealId = String(source?.deal_id ?? (entityName === "Deal" ? source?.id : "") ?? "").trim();
  if (!dealId && eventType === "delete") {
    const sourceField = entityName === "Deal" ? "source_deal_record_id" : "source_image_record_id";
    const projections = await base44.asServiceRole.entities.MallDealProjection.filter(
      { [sourceField]: entityId }, "-updated_date", 2, 0, ["deal_id"]
    );
    if (Array.isArray(projections) && projections.length > 1) throw new Error("hook_source_ambiguous");
    dealId = Array.isArray(projections) && projections.length === 1 ? String(projections[0]?.deal_id ?? "") : "";
    if (!dealId && entityName === "DealImage") {
      return {
        kind: "automation" as const,
        deal_id: "",
        event_type: eventType,
        delete_deal: false,
        no_op: true
      };
    }
    if (!dealId && entityName === "Deal") dealId = entityId;
  }
  if (!dealId) throw new Error(body.payload_too_large === true ? "hook_payload_too_large_unresolved" : "hook_deal_id_missing");
  return {
    kind: "automation" as const,
    deal_id: dealId,
    event_type: eventType,
    delete_deal: entityName === "Deal" && eventType === "delete",
    no_op: false
  };
}

async function existingProjection(base44: any, dealId: string) {
  const records = await base44.asServiceRole.entities.MallDealProjection.filter(
    { deal_id: dealId }, "created_date", 20, 0,
    ["id", "created_date", "deal_id", "canonical_state", "mall_status", "visibility", "projection_version", "source_deal_record_id", "source_image_record_id"]
  );
  const rows = Array.isArray(records) ? records as Record<string, unknown>[] : [];
  if (rows.length > 1) {
    // Derived projections must never perform destructive cleanup implicitly.
    // Fail closed and leave any anomaly for an explicit, audited repair.
    throw new Error("mall_projection_ambiguous");
  }
  return rows[0] ?? null;
}

async function hideProjection(base44: any, dealId: string, existing: Record<string, unknown> | null) {
  if (!existing?.id) return 0;
  const version = nonNegative(existing.projection_version) + 1;
  await base44.asServiceRole.entities.MallDealProjection.update(existing.id, {
    visibility: "hidden",
    source_updated_at: new Date().toISOString(),
    projection_version: version
  });
  return version;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return Response.json({ ok: false, error: "method_not_allowed" }, { status: 405 });
  }
  const base44 = createClientFromRequest(req);
  let user: Record<string, unknown>;
  try {
    user = await base44.auth.me();
  } catch {
    return Response.json({ ok: false, error: "authentication_required" }, { status: 401 });
  }
  if (String(user?.role ?? "") !== "admin") {
    return Response.json({ ok: false, error: "admin_required" }, { status: 403 });
  }

  let body: Record<string, unknown> = {};
  try {
    body = recordValue(await req.json()) ?? {};
  } catch {
    body = {};
  }

  let invocation: Awaited<ReturnType<typeof resolveInvocation>>;
  try {
    invocation = await resolveInvocation(base44, body);
  } catch (error) {
    const code = String((error as Error)?.message ?? "invalid_hook_payload");
    const status = code === "hook_payload_too_large_unresolved" ? 202 : 400;
    return Response.json({ ok: false, error: code }, { status });
  }
  const dealId = invocation.deal_id;
  if (invocation.no_op) {
    return Response.json({
      ok: true,
      projected: false,
      deal_id: null,
      visibility: "unchanged",
      mall_status: null,
      projection_version: null,
      source: invocation.kind,
      event_type: invocation.event_type
    });
  }
  if (!UUID_PATTERN.test(dealId)) {
    return Response.json({ ok: false, error: "deal_id_invalid" }, { status: 400 });
  }

  try {
    const existing = await existingProjection(base44, dealId);
    if (invocation.delete_deal) {
      const projectionVersion = await hideProjection(base44, dealId, existing);
      return Response.json({
        ok: true,
        projected: false,
        deal_id: dealId,
        visibility: "hidden",
        mall_status: null,
        projection_version: projectionVersion,
        source: invocation.kind,
        event_type: invocation.event_type
      });
    }

    const dealFields = [
      "id", "deal_id", "title", "short_description", "deal_type", "state", "price_per_unit",
      "threshold_units", "max_units", "reserved_units", "join_reservations", "deadline",
      "published_at", "updated_date", "seller_id", "delivery_options"
    ];
    const deals = await base44.asServiceRole.entities.Deal.filter({ deal_id: dealId }, "-updated_date", 1, 0, dealFields);
    if (!Array.isArray(deals) || deals.length === 0) {
      return Response.json({ ok: false, error: "deal_not_found" }, { status: 404 });
    }
    const deal = deals[0] as Record<string, unknown>;
    const state = String(deal.state ?? "");
    const mallStatus = STATUS_BY_STATE[state] ?? null;
    const publishedAt = deal.published_at ? String(deal.published_at) : null;

    if (!mallStatus || !publishedAt) {
      const projectionVersion = await hideProjection(base44, dealId, existing);
      return Response.json({
        ok: true,
        projected: false,
        deal_id: dealId,
        visibility: "hidden",
        mall_status: null,
        projection_version: projectionVersion,
        source: invocation.kind,
        event_type: invocation.event_type
      });
    }

    const dealType = String(deal.deal_type ?? "");
    if (!(DEAL_TYPES as readonly string[]).includes(dealType)) {
      return Response.json({ ok: false, error: "deal_type_invalid" }, { status: 422 });
    }
    const sellerRows = deal.seller_id
      ? await base44.asServiceRole.entities.SellerAccount.filter(
        { seller_id: String(deal.seller_id) }, "-updated_date", 1, 0,
        ["seller_id", "business_name", "display_name"]
      ) : [];
    const sellerIdentities = deal.seller_id
      ? await base44.asServiceRole.entities.SellerIdentity.filter(
        { seller_account_id: String(deal.seller_id) }, "-updated_date", 2, 0,
        ["base44_user_id", "seller_account_id"]
      ) : [];
    const sellerIdentityRows = Array.isArray(sellerIdentities)
      ? sellerIdentities as Record<string, unknown>[]
      : [];
    const sellerUserIds = [...new Set(sellerIdentityRows
      .map((identity) => String(identity.base44_user_id ?? "").trim())
      .filter(Boolean))];
    const sellerUserId = sellerUserIds.length === 1
      && sellerIdentityRows.every((identity) => String(identity.seller_account_id ?? "") === String(deal.seller_id ?? ""))
      ? sellerUserIds[0]
      : "";
    const imageRows = sellerUserId
      ? await base44.asServiceRole.entities.DealImage.filter(
        { deal_id: dealId, seller_user_id: sellerUserId }, "sort_order", 10, 0,
        ["id", "public_url", "thumbnail_url", "is_primary", "is_published", "sort_order"]
      ) : [];
    const images = Array.isArray(imageRows) ? imageRows as Record<string, unknown>[] : [];
    const image = images.find((entry: Record<string, unknown>) => entry.is_primary === true) ?? images[0] ?? null;
    const seller = Array.isArray(sellerRows) && sellerRows.length > 0 ? sellerRows[0] as Record<string, unknown> : null;
    const sellerName = String(seller?.business_name ?? "").trim()
      || String(seller?.display_name ?? "").trim()
      || "Siton seller";
    const maxUnits = nonNegative(deal.max_units);
    const joinedUnits = Math.min(maxUnits, nonNegative(deal.reserved_units));
    const remainingUnits = Math.max(0, maxUnits - joinedUnits);
    const joinReservations = Array.isArray(deal.join_reservations)
      ? deal.join_reservations as Record<string, unknown>[]
      : [];
    const participantsCount = joinReservations.filter((reservation) =>
      !["NotJoined", "DealFailed", "Dropped"].includes(String(reservation.buyer_state ?? ""))
    ).length;
    const deliveryOptions = Array.isArray(deal.delivery_options)
      ? deal.delivery_options as Record<string, unknown>[]
      : [];
    const sourceUpdatedAt = String(deal.updated_date ?? new Date().toISOString());
    const priorVersion = existing ? nonNegative(existing.projection_version) : 0;
    const projection = {
      source_deal_record_id: String(deal.id ?? ""),
      source_image_record_id: String(image?.id ?? ""),
      published_sort_key: `${publishedAt}|${dealId}`,
      deal_id: dealId,
      title: String(deal.title ?? "").trim().slice(0, 160),
      description_excerpt: excerpt(deal.short_description),
      deal_type: dealType,
      canonical_state: state,
      mall_status: mallStatus,
      price_per_unit: nonNegative(deal.price_per_unit),
      seller_business_name: sellerName.slice(0, 160),
      primary_image_url: String(image?.public_url ?? ""),
      primary_thumbnail_url: String(image?.thumbnail_url ?? image?.public_url ?? ""),
      joined_units: joinedUnits,
      participants_count: participantsCount,
      threshold_units: nonNegative(deal.threshold_units),
      max_units: maxUnits,
      remaining_units: remainingUnits,
      is_joinable: ["PendingTarget", "TargetReached"].includes(state) && remainingUnits > 0,
      has_delivery: deliveryOptions.some((option) => String(option.option_type ?? "") === "delivery"),
      deadline: deal.deadline,
      published_at: publishedAt,
      terminal_at: ["Completed", "Failed", "Cancelled"].includes(state) ? sourceUpdatedAt : "",
      source_updated_at: sourceUpdatedAt,
      projection_version: priorVersion + 1,
      visibility: "public"
    };
    if (existing?.id) {
      await base44.asServiceRole.entities.MallDealProjection.update(existing.id, projection);
    } else {
      const created = await base44.asServiceRole.entities.MallDealProjection.create(projection);
      // Base44 entity schemas do not expose a portable unique-index declaration.
      // Re-read after create and fail closed if concurrent automation produced
      // ambiguity. Destructive cleanup belongs to an explicit audited repair.
      const keeper = await existingProjection(base44, dealId);
      if (keeper?.id && String(keeper.id) !== String(created?.id ?? "")) {
        await base44.asServiceRole.entities.MallDealProjection.update(keeper.id, projection);
      }
    }
    return Response.json({
      ok: true,
      projected: true,
      deal_id: dealId,
      visibility: "public",
      mall_status: mallStatus,
      projection_version: projection.projection_version,
      source: invocation.kind,
      event_type: invocation.event_type
    });
  } catch {
    return Response.json({ ok: false, error: "mall_projection_unavailable" }, { status: 503 });
  }
});
