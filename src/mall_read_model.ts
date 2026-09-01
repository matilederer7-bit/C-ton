export const CANONICAL_DEAL_STATES = [
  "Draft",
  "PendingTarget",
  "TargetReached",
  "ClosedForJoining",
  "ReadyForCharging",
  "Charging",
  "CompletionWindow",
  "Completed",
  "Failed",
  "Cancelled"
] as const;

export type CanonicalDealState = (typeof CANONICAL_DEAL_STATES)[number];

export const MALL_DEAL_TYPES = ["physical_product", "voucher", "ticket"] as const;
export type MallDealType = (typeof MALL_DEAL_TYPES)[number];

export const MALL_STATUSES = ["underway", "reached_target", "succeeded", "failed", "cancelled"] as const;
export type MallStatus = (typeof MALL_STATUSES)[number];
export type MallStatusFilter = MallStatus | "all";

export const MALL_SORTS = ["newest", "oldest"] as const;
export type MallSort = (typeof MALL_SORTS)[number];

export const MALL_EVENT_TYPES = [
  "mall_session",
  "card_impression",
  "mall_deal_click",
  "organic_deal_entry",
  "mall_join"
] as const;
export type MallEventType = (typeof MALL_EVENT_TYPES)[number];

export const PUBLIC_MALL_EVENT_TYPES = [
  "mall_session",
  "card_impression",
  "mall_deal_click",
  "organic_deal_entry"
] as const;
export type PublicMallEventType = (typeof PUBLIC_MALL_EVENT_TYPES)[number];

export const MALL_STATES_BY_STATUS: Readonly<Record<MallStatus, readonly CanonicalDealState[]>> = {
  underway: ["PendingTarget"],
  reached_target: ["TargetReached", "ClosedForJoining", "ReadyForCharging", "Charging", "CompletionWindow"],
  succeeded: ["Completed"],
  failed: ["Failed"],
  cancelled: ["Cancelled"]
};

export const PUBLIC_MALL_DEAL_FIELDS = [
  "deal_id",
  "title",
  "description_excerpt",
  "deal_type",
  "canonical_state",
  "mall_status",
  "price_per_unit",
  "seller_business_name",
  "primary_image_url",
  "primary_thumbnail_url",
  "joined_units",
  "participants_count",
  "threshold_units",
  "max_units",
  "remaining_units",
  "is_joinable",
  "has_delivery",
  "deadline",
  "published_at",
  "terminal_at",
  "source_updated_at",
  "projection_version",
  "visibility"
] as const;

export type PublicMallDealField = (typeof PUBLIC_MALL_DEAL_FIELDS)[number];
export type PublicMallDeal = Record<PublicMallDealField, string | number | boolean | null>;

export type MallQuery = {
  deal_type: MallDealType | null;
  status: MallStatusFilter;
  sort: MallSort;
  limit: number;
  page: number;
  offset: number;
  cursor: string | null;
  pagination_mode: "cursor" | "page";
};

export type MallFilters = Pick<MallQuery, "deal_type" | "status" | "sort">;

type MallCursorPayload = {
  v: 1;
  o: number;
  t: MallDealType | null;
  s: MallStatusFilter;
  r: MallSort;
};

export class MallQueryError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = "MallQueryError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function scalar(value: unknown): string | undefined {
  if (Array.isArray(value)) return scalar(value[0]);
  if (value === undefined || value === null) return undefined;
  return String(value).trim();
}

function readQueryValue(input: URLSearchParams | Record<string, unknown>, key: string): string | undefined {
  if (input instanceof URLSearchParams) return scalar(input.get(key));
  return scalar(input[key]);
}

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number, code: string) {
  if (value === undefined || value === "") return fallback;
  if (!/^\d+$/.test(value)) throw new MallQueryError(code, `${code} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new MallQueryError(code, `${code} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function cursorScope(filters: MallFilters): Omit<MallCursorPayload, "v" | "o"> {
  return { t: filters.deal_type, s: filters.status, r: filters.sort };
}

export function encodeMallCursor(filters: MallFilters, offset: number): string {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 48_000) {
    throw new MallQueryError("mall_cursor_invalid", "cursor offset is outside the bounded Mall window");
  }
  const payload: MallCursorPayload = { v: 1, o: offset, ...cursorScope(filters) };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeMallCursor(cursor: string, filters: MallFilters): number {
  if (!/^[A-Za-z0-9_-]{8,512}$/.test(cursor)) {
    throw new MallQueryError("mall_cursor_invalid", "cursor is not a valid opaque Mall cursor");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new MallQueryError("mall_cursor_invalid", "cursor is not a valid opaque Mall cursor");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new MallQueryError("mall_cursor_invalid", "cursor payload is invalid");
  }
  const candidate = payload as Partial<MallCursorPayload>;
  const expected = cursorScope(filters);
  if (candidate.v !== 1
    || !Number.isSafeInteger(candidate.o)
    || Number(candidate.o) < 0
    || Number(candidate.o) > 48_000
    || candidate.t !== expected.t
    || candidate.s !== expected.s
    || candidate.r !== expected.r) {
    throw new MallQueryError("mall_cursor_invalid", "cursor does not match the requested Mall filters");
  }
  return Number(candidate.o);
}

export function parseMallQuery(input: URLSearchParams | Record<string, unknown>): MallQuery {
  const rawType = readQueryValue(input, "type");
  const rawStatus = readQueryValue(input, "status") || "all";
  const rawSort = readQueryValue(input, "sort") || "newest";

  if (rawType && !(MALL_DEAL_TYPES as readonly string[]).includes(rawType)) {
    throw new MallQueryError("mall_type_invalid", "type must be physical_product, voucher, or ticket");
  }
  if (rawStatus !== "all" && !(MALL_STATUSES as readonly string[]).includes(rawStatus)) {
    throw new MallQueryError("mall_status_invalid", "status is not a supported Mall status");
  }
  if (!(MALL_SORTS as readonly string[]).includes(rawSort)) {
    throw new MallQueryError("mall_sort_invalid", "sort must be newest or oldest");
  }

  const limit = boundedInteger(readQueryValue(input, "limit"), 24, 1, 48, "mall_limit_invalid");
  const page = boundedInteger(readQueryValue(input, "page"), 1, 1, 1000, "mall_page_invalid");
  const cursor = readQueryValue(input, "cursor") || null;
  const filters: MallFilters = {
    deal_type: rawType ? rawType as MallDealType : null,
    status: rawStatus as MallStatusFilter,
    sort: rawSort as MallSort
  };
  const offset = cursor ? decodeMallCursor(cursor, filters) : (page - 1) * limit;
  return {
    ...filters,
    limit,
    page,
    offset,
    cursor,
    pagination_mode: cursor ? "cursor" : "page"
  };
}

export function buildMallListEnvelope<T>(query: MallQuery, rows: readonly T[]): {
  deals: T[];
  filters: { type: MallDealType | null; status: MallStatusFilter; sort: MallSort };
  page: { limit: number; has_more: boolean; next_cursor: string | null };
} {
  const hasMore = rows.length > query.limit;
  return {
    deals: rows.slice(0, query.limit),
    filters: { type: query.deal_type, status: query.status, sort: query.sort },
    page: {
      limit: query.limit,
      has_more: hasMore,
      next_cursor: hasMore ? encodeMallCursor(query, query.offset + query.limit) : null
    }
  };
}

export function mallStatusForState(state: string): MallStatus | null {
  for (const status of MALL_STATUSES) {
    if ((MALL_STATES_BY_STATUS[status] as readonly string[]).includes(state)) return status;
  }
  return null;
}

export function mallStatesForStatus(status: MallStatusFilter): readonly CanonicalDealState[] {
  if (status !== "all") return MALL_STATES_BY_STATUS[status];
  return MALL_STATUSES.flatMap((entry) => MALL_STATES_BY_STATUS[entry]);
}

export function isMallEligible(input: { state: string; published_at: unknown }): boolean {
  return Boolean(input.published_at) && mallStatusForState(input.state) !== null && input.state !== "Draft";
}

function finiteNonNegative(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function deriveMallAvailability(input: {
  state: string;
  joined_units: unknown;
  max_units: unknown;
}): { joined_units: number; remaining_units: number; is_joinable: boolean } {
  const maxUnits = finiteNonNegative(input.max_units);
  const joinedUnits = Math.min(maxUnits, finiteNonNegative(input.joined_units));
  const remainingUnits = Math.max(0, maxUnits - joinedUnits);
  return {
    joined_units: joinedUnits,
    remaining_units: remainingUnits,
    is_joinable: ["PendingTarget", "TargetReached"].includes(input.state) && remainingUnits > 0
  };
}

export function buildMallDiscoveryQuery(query: MallQuery): { text: string; values: readonly unknown[] } {
  const direction = query.sort === "oldest" ? "ASC" : "DESC";
  const states = mallStatesForStatus(query.status);
  return {
    text: `
WITH mall_page AS (
  SELECT d.deal_id, d.title, d.description, d.description_short, d.deal_type,
         d.state::text AS canonical_state, d.price_per_unit,
         d.threshold_units, d.max_units, d.deadline, d.published_at,
         d.updated_at AS source_updated_at, d.seller_id
    FROM siton.deals d
   WHERE d.published_at IS NOT NULL
     AND d.state::text = ANY($1::text[])
     AND ($2::text IS NULL OR d.deal_type = $2::text)
   ORDER BY d.published_at ${direction}, d.deal_id ${direction}
   LIMIT $3::int OFFSET $4::int
)
SELECT p.deal_id::text AS deal_id,
       p.title,
       left(COALESCE(NULLIF(btrim(p.description_short), ''), p.description, ''), 180) AS description_excerpt,
       p.deal_type,
       p.canonical_state,
       p.price_per_unit,
       COALESCE(NULLIF(btrim(sa.business_name), ''), NULLIF(btrim(sa.display_name), ''), 'Siton seller') AS seller_business_name,
       img.image_id::text AS primary_image_id,
       img.mime_type AS primary_image_mime_type,
       img.public_url AS primary_image_url,
       img.public_url AS primary_thumbnail_url,
       COALESCE(joined.joined_units, 0)::int AS joined_units,
       COALESCE(joined.participants_count, 0)::int AS participants_count,
       p.threshold_units,
       p.max_units,
       EXISTS (
         SELECT 1 FROM siton.deal_delivery_options delivery
          WHERE delivery.deal_id = p.deal_id AND delivery.option_type = 'delivery'
       ) AS has_delivery,
       p.deadline,
       p.published_at,
       CASE WHEN p.canonical_state IN ('Completed','Failed','Cancelled') THEN p.source_updated_at ELSE NULL END AS terminal_at,
       p.source_updated_at
  FROM mall_page p
  LEFT JOIN siton.seller_accounts sa ON sa.seller_id = p.seller_id
  LEFT JOIN LATERAL (
    SELECT di.image_id, di.mime_type, di.public_url
      FROM siton.deal_images di
     WHERE di.deal_id = p.deal_id
     ORDER BY di.is_primary DESC, di.sort_order ASC, di.created_at ASC
     LIMIT 1
  ) img ON true
  LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(participant.qty), 0) AS joined_units,
           COUNT(*)::int AS participants_count
      FROM siton.participants participant
     WHERE participant.deal_id = p.deal_id
       AND participant.buyer_state::text NOT IN ('NotJoined','DealFailed','Dropped')
  ) joined ON true
 ORDER BY p.published_at ${direction}, p.deal_id ${direction}`.trim(),
    values: [states, query.deal_type, query.limit + 1, query.offset]
  };
}

function publicText(value: unknown, maximum: number): string {
  return String(value ?? "").trim().slice(0, maximum);
}

function nullablePublicText(value: unknown, maximum: number): string | null {
  const text = publicText(value, maximum);
  return text || null;
}

export function projectMallRow(row: Record<string, unknown>): PublicMallDeal {
  const canonicalState = publicText(row.canonical_state ?? row.state, 40);
  const mallStatus = mallStatusForState(canonicalState);
  if (!mallStatus || !row.published_at) {
    throw new MallQueryError("mall_projection_ineligible", "Only published canonical Mall states may be projected", 422);
  }
  const maxUnits = finiteNonNegative(row.max_units);
  const availability = deriveMallAvailability({
    state: canonicalState,
    joined_units: row.joined_units,
    max_units: maxUnits
  });
  const rawDealType = publicText(row.deal_type, 40);
  if (!(MALL_DEAL_TYPES as readonly string[]).includes(rawDealType)) {
    throw new MallQueryError("mall_projection_type_invalid", "Projection has an unsupported deal type", 422);
  }
  const localImageId = publicText(row.primary_image_id, 80);
  const localImageUrl = UUID_PATTERN.test(localImageId) ? `/api/deal-images/${localImageId}` : null;
  const primaryImageUrl = nullablePublicText(row.primary_image_url, 2048) ?? localImageUrl;

  return {
    deal_id: publicText(row.deal_id, 80),
    title: publicText(row.title, 160),
    description_excerpt: publicText(row.description_excerpt ?? row.description, 180),
    deal_type: rawDealType,
    canonical_state: canonicalState,
    mall_status: mallStatus,
    price_per_unit: finiteNonNegative(row.price_per_unit),
    seller_business_name: publicText(row.seller_business_name, 160) || "Siton seller",
    primary_image_url: primaryImageUrl,
    primary_thumbnail_url: nullablePublicText(row.primary_thumbnail_url, 2048) ?? primaryImageUrl,
    joined_units: availability.joined_units,
    participants_count: finiteNonNegative(row.participants_count),
    threshold_units: finiteNonNegative(row.threshold_units),
    max_units: maxUnits,
    remaining_units: availability.remaining_units,
    is_joinable: availability.is_joinable,
    has_delivery: row.has_delivery === true,
    deadline: nullablePublicText(row.deadline, 40),
    published_at: nullablePublicText(row.published_at, 40),
    terminal_at: nullablePublicText(row.terminal_at, 40),
    source_updated_at: nullablePublicText(row.source_updated_at, 40),
    projection_version: Number.isSafeInteger(Number(row.projection_version)) ? Number(row.projection_version) : 1,
    visibility: "public"
  };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLIENT_EVENT_ID_PATTERN = /^[A-Za-z0-9:_-]{8,100}$/;

export function sanitizeMallEvent(input: Record<string, unknown>): {
  event_type: MallEventType;
  client_event_id: string;
  deal_id: string | null;
  deal_type: MallDealType | null;
  mall_status: MallStatus | null;
  acquisition_source: "mall";
} {
  const eventType = publicText(input.event_type, 40);
  const clientEventId = publicText(input.client_event_id ?? input.session_id, 100);
  const dealId = nullablePublicText(input.deal_id, 80);
  const dealType = nullablePublicText(input.deal_type, 40);
  const mallStatus = nullablePublicText(input.mall_status, 40);
  const source = nullablePublicText(input.source, 20);

  if (!(PUBLIC_MALL_EVENT_TYPES as readonly string[]).includes(eventType)) {
    throw new MallQueryError("mall_event_type_invalid", "event_type is not supported");
  }
  if (!CLIENT_EVENT_ID_PATTERN.test(clientEventId)) {
    throw new MallQueryError("mall_client_event_id_invalid", "client_event_id must be an opaque 8-100 character token");
  }
  if (dealId !== null && !UUID_PATTERN.test(dealId)) {
    throw new MallQueryError("mall_event_deal_id_invalid", "deal_id must be a UUID");
  }
  if (eventType !== "mall_session" && dealId === null) {
    throw new MallQueryError("mall_event_deal_id_required", "deal_id is required for deal events");
  }
  if (dealType !== null && !(MALL_DEAL_TYPES as readonly string[]).includes(dealType)) {
    throw new MallQueryError("mall_event_deal_type_invalid", "deal_type is not supported");
  }
  if (mallStatus !== null && !(MALL_STATUSES as readonly string[]).includes(mallStatus)) {
    throw new MallQueryError("mall_event_status_invalid", "mall_status is not supported");
  }
  if (source !== null && source !== "mall") {
    throw new MallQueryError("mall_event_source_invalid", "source must be mall");
  }

  return {
    event_type: eventType as MallEventType,
    client_event_id: clientEventId,
    deal_id: dealId,
    deal_type: dealType as MallDealType | null,
    mall_status: mallStatus as MallStatus | null,
    acquisition_source: "mall"
  };
}
