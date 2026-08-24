import { createClientFromRequest } from "npm:@base44/sdk";

const DEAL_TYPES = ["physical_product", "voucher", "ticket"] as const;
const MALL_STATUSES = ["underway", "reached_target", "succeeded", "failed", "cancelled"] as const;
const PUBLIC_FIELDS = [
  "deal_id", "title", "description_excerpt", "deal_type", "canonical_state", "mall_status",
  "price_per_unit", "seller_business_name", "primary_image_url", "primary_thumbnail_url",
  "joined_units", "participants_count", "threshold_units", "max_units", "remaining_units", "is_joinable", "has_delivery",
  "deadline", "published_at", "terminal_at", "source_updated_at", "projection_version", "visibility"
] as const;

type MallFilters = { type: string | null; status: string; sort: string };

function integer(value: unknown, fallback: number, minimum: number, maximum: number): number | null {
  if (value === undefined || value === null || value === "") return fallback;
  const text = String(value);
  if (!/^\d+$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}

function publicDeal(record: Record<string, unknown>) {
  const nullableFields = new Set(["primary_image_url", "primary_thumbnail_url", "terminal_at"]);
  return Object.fromEntries(PUBLIC_FIELDS.map((field) => [
    field,
    nullableFields.has(field) && record[field] === "" ? null : record[field] ?? null
  ]));
}

function encodeCursor(filters: MallFilters, offset: number): string {
  const json = JSON.stringify({ v: 1, o: offset, t: filters.type, s: filters.status, r: filters.sort });
  return btoa(json).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeCursor(cursor: string, filters: MallFilters): number | null {
  if (!/^[A-Za-z0-9_-]{8,512}$/.test(cursor)) return null;
  try {
    const base64 = cursor.replace(/-/g, "+").replace(/_/g, "/");
    const padding = "=".repeat((4 - base64.length % 4) % 4);
    const payload = JSON.parse(atob(base64 + padding));
    if (!payload || payload.v !== 1 || !Number.isSafeInteger(payload.o) || payload.o < 0 || payload.o > 48_000
      || payload.t !== filters.type || payload.s !== filters.status || payload.r !== filters.sort) return null;
    return payload.o;
  } catch {
    return null;
  }
}

async function requestInput(req: Request): Promise<Record<string, unknown>> {
  if (req.method === "GET") return Object.fromEntries(new URL(req.url).searchParams.entries());
  if (req.method !== "POST") return {};
  try {
    const value = await req.json();
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

Deno.serve(async (req) => {
  if (req.method !== "GET" && req.method !== "POST") {
    return Response.json({ ok: false, error: "method_not_allowed" }, { status: 405 });
  }

  const input = await requestInput(req);
  const type = input.type === undefined || input.type === "" ? null : String(input.type);
  const status = input.status === undefined || input.status === "" ? "all" : String(input.status);
  const sort = input.sort === undefined || input.sort === "" ? "newest" : String(input.sort);
  const limit = integer(input.limit, 24, 1, 48);
  const page = integer(input.page, 1, 1, 1000);
  if ((type !== null && !(DEAL_TYPES as readonly string[]).includes(type))
    || (status !== "all" && !(MALL_STATUSES as readonly string[]).includes(status))
    || !["newest", "oldest"].includes(sort)
    || limit === null || page === null) {
    return Response.json({ ok: false, error: "invalid_mall_query" }, { status: 400 });
  }

  const filters: MallFilters = { type, status, sort };
  const rawCursor = input.cursor === undefined || input.cursor === "" ? null : String(input.cursor);
  const cursorOffset = rawCursor === null ? null : decodeCursor(rawCursor, filters);
  if (rawCursor !== null && cursorOffset === null) {
    return Response.json({ ok: false, error: "invalid_mall_cursor" }, { status: 400 });
  }
  const offset = cursorOffset ?? (page - 1) * limit;

  const filter: Record<string, unknown> = { visibility: "public" };
  if (type !== null) filter.deal_type = type;
  if (status !== "all") filter.mall_status = status;
  const base44 = createClientFromRequest(req);
  try {
    const records = await base44.entities.MallDealProjection.filter(
      filter,
      sort === "oldest" ? "published_at" : "-published_at",
      limit + 1,
      offset,
      [...PUBLIC_FIELDS]
    );
    const rows = Array.isArray(records) ? records : [];
    const hasMore = rows.length > limit;
    const deals = rows.slice(0, limit).map((record: Record<string, unknown>) => publicDeal(record));
    return Response.json({
      ok: true,
      deals,
      filters,
      page: {
        limit,
        has_more: hasMore,
        next_cursor: hasMore ? encodeCursor(filters, offset + limit) : null
      }
    });
  } catch {
    return Response.json({ ok: false, error: "mall_read_unavailable" }, { status: 503 });
  }
});
