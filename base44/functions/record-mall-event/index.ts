import { createClientFromRequest } from "npm:@base44/sdk";

const EVENT_TYPES = ["mall_session", "card_impression", "mall_deal_click", "organic_deal_entry"] as const;
const DEAL_TYPES = ["physical_product", "voucher", "ticket"] as const;
const MALL_STATUSES = ["underway", "reached_target", "succeeded", "failed", "cancelled"] as const;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLIENT_ID_PATTERN = /^[A-Za-z0-9:_-]{8,100}$/;
const MAX_EVENTS_PER_SESSION = 120;

function optionalText(value: unknown, maximum: number): string | null {
  const text = String(value ?? "").trim().slice(0, maximum);
  return text || null;
}

async function boundedRetryToken(clientEventId: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(clientEventId));
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `evt_${hex}`;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return Response.json({ ok: false, error: "method_not_allowed" }, { status: 405 });
  }
  let input: Record<string, unknown>;
  try {
    const parsed = await req.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
    input = parsed as Record<string, unknown>;
  } catch {
    return Response.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const eventType = optionalText(input.event_type, 40);
  const clientEventId = optionalText(input.client_event_id ?? input.session_id, 100);
  const dealId = optionalText(input.deal_id, 80);
  const dealType = optionalText(input.deal_type, 40);
  const mallStatus = optionalText(input.mall_status, 40);
  const source = optionalText(input.source, 20);
  if (!eventType || !(EVENT_TYPES as readonly string[]).includes(eventType)
    || !clientEventId || !CLIENT_ID_PATTERN.test(clientEventId)
    || (dealId !== null && !UUID_PATTERN.test(dealId))
    || (eventType !== "mall_session" && dealId === null)
    || (dealType !== null && !(DEAL_TYPES as readonly string[]).includes(dealType))
    || (mallStatus !== null && !(MALL_STATUSES as readonly string[]).includes(mallStatus))
    || (source !== null && source !== "mall")) {
    return Response.json({ ok: false, error: "invalid_mall_event" }, { status: 400 });
  }

  const base44 = createClientFromRequest(req);
  try {
    let canonicalDealType: string | null = null;
    let canonicalMallStatus: string | null = null;
    if (dealId !== null) {
      const publicDeals = await base44.entities.MallDealProjection.filter(
        { deal_id: dealId, visibility: "public" }, "-published_at", 1, 0,
        ["deal_id", "deal_type", "mall_status", "visibility"]
      );
      if (!Array.isArray(publicDeals) || publicDeals.length === 0) {
        return Response.json({ ok: false, error: "mall_deal_not_public" }, { status: 404 });
      }
      canonicalDealType = String(publicDeals[0]?.deal_type ?? "");
      canonicalMallStatus = String(publicDeals[0]?.mall_status ?? "");
      if (!(DEAL_TYPES as readonly string[]).includes(canonicalDealType)
        || !(MALL_STATUSES as readonly string[]).includes(canonicalMallStatus)) {
        return Response.json({ ok: false, error: "mall_projection_invalid" }, { status: 503 });
      }
    }

    const retryToken = await boundedRetryToken(clientEventId);
    const eventKey = `${eventType}:${retryToken}:${dealId ?? "mall"}`;
    const existing = await base44.asServiceRole.entities.DiscoveryEvent.filter(
      { event_key: eventKey }, "-created_date", 1, 0, ["id", "event_key"]
    );
    if (Array.isArray(existing) && existing.length > 0) {
      return Response.json({ ok: true, accepted: true, duplicate: true, event_id: existing[0]?.id ?? null });
    }
    const sessionEvents = await base44.asServiceRole.entities.DiscoveryEvent.filter(
      { client_event_id: retryToken }, "-created_date", MAX_EVENTS_PER_SESSION + 1, 0, ["id"]
    );
    if (Array.isArray(sessionEvents) && sessionEvents.length >= MAX_EVENTS_PER_SESSION) {
      return Response.json({ ok: false, error: "mall_event_session_limit" }, { status: 429 });
    }
    const eventRecord: Record<string, unknown> = {
      event_key: eventKey,
      event_type: eventType,
      client_event_id: retryToken,
      acquisition_source: "mall",
      occurred_at: new Date().toISOString()
    };
    if (dealId !== null) eventRecord.deal_id = dealId;
    if (canonicalDealType !== null) eventRecord.deal_type = canonicalDealType;
    if (canonicalMallStatus !== null) eventRecord.mall_status = canonicalMallStatus;
    const created = await base44.asServiceRole.entities.DiscoveryEvent.create(eventRecord);
    return Response.json({ ok: true, accepted: true, duplicate: false, event_id: created?.id ?? null }, { status: 202 });
  } catch {
    return Response.json({ ok: false, error: "mall_event_unavailable" }, { status: 503 });
  }
});
