// LAUNCH SPRINT 3 — physical-product pickup credential + seller handoff.
//
// Extends the canonical fulfillment rail (siton.fulfillment_units, migration
// 038) instead of adding a parallel one. See docs/PHYSICAL_FULFILLMENT_PICKUP.md.
//
//   • Eligibility is the existing predicate (decideFulfillmentIssuance) read
//     LIVE from participants/deals on every call. Unit rows never create
//     eligibility; the money state machine is never touched here.
//   • Order code "CT-NNNN-NNNN": a LOCATOR minted lazily per order, stored in
//     metadata_jsonb.order_code of every unit of the order. Not a secret —
//     authority = authenticated seller + deal ownership + live DB state.
//   • Handoff = whole order: every Issued unit → Redeemed (redeemed_at = now())
//     in one transaction under FOR UPDATE; for physical_product "Redeemed"
//     means handed over. Replay via idempotency_log, audit via
//     seller_security_events. Never charges, captures or refunds.
import { randomBytes } from "node:crypto";
import {
  decideFulfillmentIssuance,
  issueFulfillmentUnitsForParticipant,
  type DealType
} from "./deal_types.js";
import { describePickupLocation, isPickupOptionType, type PickupNavigation } from "./pickup_location.js";

type Queryable = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number }>;
};

export const ORDER_CODE_PREFIX = "CT";
export const ORDER_CODE_DIGITS = 8;
export const HANDOFF_ACTION_NAME = "fulfillment.handoff";
export const HANDOFF_EVENT_TYPE = "fulfillment.handoff";

// ── Order code ───────────────────────────────────────────────────────────────

export function generateOrderCodeDigits(): string {
  // 8 decimal digits from crypto randomness, rejection-sampled so every digit
  // is uniform (no modulo bias). 10^8 space; global uniqueness is checked at
  // mint time and resolution is seller-scoped, so the code is collision-safe
  // as a locator without being a secret.
  let out = "";
  while (out.length < ORDER_CODE_DIGITS) {
    const byte = randomBytes(1)[0] ?? 0;
    if (byte < 250) out += String(byte % 10);
  }
  return out;
}

export function formatOrderCode(digits: string): string {
  const d = String(digits || "").replace(/\D/g, "");
  if (d.length !== ORDER_CODE_DIGITS) return "";
  return `${ORDER_CODE_PREFIX}-${d.slice(0, 4)}-${d.slice(4)}`;
}

// Accepts "CT-1234-5678", "ct 1234 5678", "12345678", "1234-5678" or the full
// QR URL (…#/seller/pickup?code=CT-1234-5678). Returns the 8 digits or null.
export function normalizeOrderCodeInput(input: unknown): string | null {
  let text = String(input ?? "").trim();
  if (!text || text.length > 512) return null;
  const urlMatch = text.match(/[?&]code=([^&#\s]+)/i);
  if (urlMatch && urlMatch[1]) text = decodeURIComponent(urlMatch[1]);
  const stripped = text.replace(/^\s*ct[\s-]*/i, "").replace(/[\s-]/g, "");
  if (!/^\d{8}$/.test(stripped)) return null;
  return stripped;
}

export function orderCodeLast4(digits: string): string {
  return String(digits || "").slice(-4);
}

export function pickupQrPayload(publicOrigin: string, code: string): string {
  const origin = String(publicOrigin || "").replace(/\/+$/, "");
  return `${origin}/preview/#/seller/pickup?code=${encodeURIComponent(code)}`;
}

// ── Verdicts ─────────────────────────────────────────────────────────────────

export type PhysicalMethod = "pickup" | "delivery" | "unknown";

export type BuyerPickupState =
  | "not_applicable"
  | "deal_open"
  | "payment_pending"
  | "deal_failed"
  | "deal_cancelled"
  | "unavailable"
  | "ready"
  | "fulfilled";

export type SellerVerdict = "ready" | "already_fulfilled" | "not_ready";

export type NotReadyReason =
  | "payment_incomplete"
  | "deal_not_completed"
  | "deal_failed"
  | "deal_cancelled"
  | "refunded"
  | "not_eligible"
  | "units_unavailable"
  | "not_physical";

export type UnitSummary = {
  total: number;
  issued: number;
  redeemed: number;
  voided: number;
  redeemed_at: string | null;
};

export function summarizeUnits(rows: Array<{ status: string; redeemed_at?: string | Date | null }>): UnitSummary {
  let issued = 0;
  let redeemed = 0;
  let voided = 0;
  let redeemedAt: string | null = null;
  for (const row of rows) {
    const status = String(row.status || "");
    if (status === "Issued" || status === "Sent" || status === "Pending") issued += 1;
    else if (status === "Redeemed") {
      redeemed += 1;
      const at = row.redeemed_at ? new Date(row.redeemed_at).toISOString() : null;
      if (at && (!redeemedAt || at > redeemedAt)) redeemedAt = at;
    } else voided += 1;
  }
  return { total: rows.length, issued, redeemed, voided, redeemed_at: redeemedAt };
}

export function methodForDeliveryType(deliveryMethodType: unknown): PhysicalMethod {
  const type = String(deliveryMethodType || "").trim().toLowerCase();
  if (!type) return "unknown";
  if (isPickupOptionType(type)) return "pickup";
  if (type === "delivery") return "delivery";
  return "unknown";
}

export function methodLabel(method: PhysicalMethod, fallbackLabel?: string | null): string {
  if (method === "pickup") return "איסוף עצמי";
  if (method === "delivery") return "משלוח";
  return String(fallbackLabel || "").trim() || "לא צוין";
}

// The pure decision. Money truth is the participant row; units only decide
// between "ready" and "fulfilled" once the participant is eligible.
export function decidePhysicalFulfillment(args: {
  dealType: string;
  dealState: string;
  buyerState: string;
  moneyState: string;
  units: UnitSummary;
}): {
  buyer_state: BuyerPickupState;
  seller_verdict: SellerVerdict;
  not_ready_reason: NotReadyReason | null;
  eligible: boolean;
  paid: boolean;
} {
  const paid = args.moneyState === "ChargedSuccess" || args.moneyState === "RecoveredCharge";
  if (args.dealType !== "physical_product") {
    return { buyer_state: "not_applicable", seller_verdict: "not_ready", not_ready_reason: "not_physical", eligible: false, paid };
  }
  if (args.dealState === "Cancelled") {
    return { buyer_state: "deal_cancelled", seller_verdict: "not_ready", not_ready_reason: "deal_cancelled", eligible: false, paid };
  }
  if (args.dealState === "Failed") {
    return { buyer_state: "deal_failed", seller_verdict: "not_ready", not_ready_reason: "deal_failed", eligible: false, paid };
  }
  if (args.moneyState === "Refunded") {
    return { buyer_state: "unavailable", seller_verdict: "not_ready", not_ready_reason: "refunded", eligible: false, paid: false };
  }
  const decision = decideFulfillmentIssuance({
    dealState: args.dealState,
    buyerState: args.buyerState,
    moneyState: args.moneyState
  });
  if (!decision.shouldIssue) {
    if (decision.reason === "deal_not_completed") {
      return { buyer_state: "deal_open", seller_verdict: "not_ready", not_ready_reason: "deal_not_completed", eligible: false, paid };
    }
    const dropped = ["AuthReleased"].includes(args.moneyState) || ["Dropped", "DealFailed"].includes(args.buyerState);
    if (dropped) {
      return { buyer_state: "unavailable", seller_verdict: "not_ready", not_ready_reason: "not_eligible", eligible: false, paid };
    }
    return { buyer_state: "payment_pending", seller_verdict: "not_ready", not_ready_reason: "payment_incomplete", eligible: false, paid };
  }
  if (args.units.total > 0 && args.units.issued === 0 && args.units.redeemed === 0) {
    return { buyer_state: "unavailable", seller_verdict: "not_ready", not_ready_reason: "units_unavailable", eligible: true, paid };
  }
  if (args.units.total > 0 && args.units.issued === 0 && args.units.redeemed > 0) {
    return { buyer_state: "fulfilled", seller_verdict: "already_fulfilled", not_ready_reason: null, eligible: true, paid };
  }
  return { buyer_state: "ready", seller_verdict: "ready", not_ready_reason: null, eligible: true, paid };
}

// ── Copy (Hebrew) ────────────────────────────────────────────────────────────

export const BUYER_PICKUP_COPY: Record<Exclude<BuyerPickupState, "not_applicable">, { headline: string; subline: string }> = {
  deal_open: { headline: "העסקה עדיין לא הושלמה", subline: "קוד האיסוף יופיע כאן ברגע שהעסקה תושלם והחיוב יעבור בפועל." },
  payment_pending: { headline: "ההזמנה עדיין לא מוכנה למסירה", subline: "התשלום עדיין לא הושלם. כשהחיוב יעבור בפועל, קוד האיסוף יופיע כאן." },
  deal_failed: { headline: "העסקה לא הושלמה — אין הזמנה למסירה", subline: "הקבוצה לא הגיעה ליעד, ולכן לא נוצרה הזמנה למסירה ולא בוצע חיוב." },
  deal_cancelled: { headline: "העסקה בוטלה — אין הזמנה למסירה", subline: "המוכר ביטל את העסקה. לא נוצרה הזמנה למסירה." },
  unavailable: { headline: "ההזמנה אינה זמינה למסירה", subline: "ההזמנה הזו לא זכאית למסירה. אם לדעתכם זו טעות, פנו לתמיכה דרך המסך הזה." },
  ready: { headline: "מוכן לאיסוף", subline: "הציגו את הקוד למוכר בעת האיסוף." },
  fulfilled: { headline: "ההזמנה נמסרה", subline: "המוכר אישר שהמוצר נמסר לכם." }
};

export const SELLER_NOT_READY_COPY: Record<NotReadyReason, string> = {
  payment_incomplete: "התשלום לא הושלם",
  deal_not_completed: "העסקה טרם הושלמה",
  deal_failed: "העסקה נכשלה",
  deal_cancelled: "העסקה בוטלה",
  refunded: "התשלום הוחזר",
  not_eligible: "ההזמנה אינה זכאית למסירה",
  units_unavailable: "ההזמנה אינה זמינה למסירה",
  not_physical: "זו לא הזמנה של מוצר פיזי"
};

export const PAYMENT_LABEL_PAID = "שולם";
export const PAYMENT_LABEL_UNPAID = "לא שולם";

// ── Data access ──────────────────────────────────────────────────────────────

export type PhysicalOrderRecord = {
  participant_id: string;
  deal_id: string;
  seller_id: string;
  deal_title: string;
  deal_state: string;
  deal_type: string;
  buyer_state: string;
  money_state: string;
  qty: number;
  buyer_id: string;
  buyer_name: string | null;
  buyer_phone: string | null;
  buyer_email: string | null;
  delivery_method_type: string | null;
  delivery_method_label: string | null;
  delivery_address: string | null;
  delivery_city: string | null;
  delivery_notes: string | null;
  joined_at: string;
  pickup_option: { option_type: string | null; label: string | null; latitude: number | null; longitude: number | null } | null;
  units: Array<{ fulfillment_unit_id: string; unit_index: number; status: string; redeemed_at: string | null; metadata: any }>;
};

const ORDER_SELECT = `
  SELECT p.participant_id, p.deal_id, COALESCE(d.seller_id, '') AS seller_id,
         d.title AS deal_title, d.state AS deal_state, d.deal_type,
         p.buyer_state, p.money_state, p.qty, p.buyer_id, p.buyer_name, p.buyer_phone, p.buyer_email,
         p.delivery_method_type, p.delivery_method_label, p.delivery_address, p.delivery_city, p.delivery_notes,
         p.created_at AS joined_at,
         o.option_type AS opt_type, o.label AS opt_label, o.latitude AS opt_latitude, o.longitude AS opt_longitude
    FROM siton.participants p
    JOIN siton.deals d ON d.deal_id = p.deal_id
    LEFT JOIN siton.deal_delivery_options o ON o.option_id = p.delivery_option_id`;

function mapOrderRow(row: any, units: any[]): PhysicalOrderRecord {
  return {
    participant_id: String(row.participant_id),
    deal_id: String(row.deal_id),
    seller_id: String(row.seller_id || ""),
    deal_title: String(row.deal_title || ""),
    deal_state: String(row.deal_state || ""),
    deal_type: String(row.deal_type || "physical_product"),
    buyer_state: String(row.buyer_state || ""),
    money_state: String(row.money_state || ""),
    qty: Math.max(1, Number(row.qty || 1)),
    buyer_id: String(row.buyer_id || ""),
    buyer_name: row.buyer_name ? String(row.buyer_name) : null,
    buyer_phone: row.buyer_phone ? String(row.buyer_phone) : null,
    buyer_email: row.buyer_email ? String(row.buyer_email) : null,
    delivery_method_type: row.delivery_method_type ? String(row.delivery_method_type) : null,
    delivery_method_label: row.delivery_method_label ? String(row.delivery_method_label) : null,
    delivery_address: row.delivery_address ? String(row.delivery_address) : null,
    delivery_city: row.delivery_city ? String(row.delivery_city) : null,
    delivery_notes: row.delivery_notes ? String(row.delivery_notes) : null,
    joined_at: row.joined_at ? new Date(row.joined_at).toISOString() : new Date(0).toISOString(),
    pickup_option: row.opt_type
      ? {
          option_type: String(row.opt_type),
          label: row.opt_label ? String(row.opt_label) : null,
          latitude: row.opt_latitude === null || row.opt_latitude === undefined ? null : Number(row.opt_latitude),
          longitude: row.opt_longitude === null || row.opt_longitude === undefined ? null : Number(row.opt_longitude)
        }
      : null,
    units: units.map((u: any) => ({
      fulfillment_unit_id: String(u.fulfillment_unit_id),
      unit_index: Number(u.unit_index),
      status: String(u.status),
      redeemed_at: u.redeemed_at ? new Date(u.redeemed_at).toISOString() : null,
      metadata: u.metadata_jsonb && typeof u.metadata_jsonb === "object" ? u.metadata_jsonb : {}
    }))
  };
}

async function loadUnits(c: Queryable, participantId: string, lock: boolean) {
  const r = await c.query(
    `SELECT fulfillment_unit_id, unit_index, status, redeemed_at, metadata_jsonb
       FROM siton.fulfillment_units
      WHERE participant_id = $1
      ORDER BY unit_index ASC${lock ? " FOR UPDATE" : ""}`,
    [participantId]
  );
  return r.rows;
}

export async function loadPhysicalOrderByParticipant(
  c: Queryable,
  participantId: string,
  options?: { lock?: boolean }
): Promise<PhysicalOrderRecord | null> {
  const lock = Boolean(options?.lock);
  if (lock) {
    // Serialise concurrent handoffs (and concurrent minting) on the order.
    await c.query(`SELECT participant_id FROM siton.participants WHERE participant_id = $1 FOR UPDATE`, [participantId]);
  }
  const r = await c.query(`${ORDER_SELECT} WHERE p.participant_id = $1`, [participantId]);
  if (!r.rowCount) return null;
  const units = await loadUnits(c, participantId, lock);
  return mapOrderRow(r.rows[0], units);
}

// Resolve an order code inside ONE seller's deals. Unknown code, another
// seller's code and a non-physical deal all answer null (no enumeration).
export async function findSellerOrderByCode(
  c: Queryable,
  args: { sellerId: string; digits: string }
): Promise<{ order: PhysicalOrderRecord | null; ambiguous: boolean }> {
  const code = formatOrderCode(args.digits);
  if (!code) return { order: null, ambiguous: false };
  const r = await c.query(
    `SELECT DISTINCT f.participant_id
       FROM siton.fulfillment_units f
       JOIN siton.deals d ON d.deal_id = f.deal_id
      WHERE d.seller_id = $1
        AND f.deal_type = 'physical_product'
        AND f.metadata_jsonb->>'order_code' = $2
      LIMIT 3`,
    [args.sellerId, code]
  );
  if (!r.rowCount) return { order: null, ambiguous: false };
  if ((r.rowCount || 0) > 1) return { order: null, ambiguous: true };
  const order = await loadPhysicalOrderByParticipant(c, String(r.rows[0].participant_id));
  if (!order || order.seller_id !== args.sellerId) return { order: null, ambiguous: false };
  return { order, ambiguous: false };
}

export function orderCodeOf(order: PhysicalOrderRecord): string | null {
  for (const unit of order.units) {
    const code = unit.metadata?.order_code;
    if (typeof code === "string" && /^CT-\d{4}-\d{4}$/.test(code)) return code;
  }
  return null;
}

// Lazily issue the physical units (canonical helper, idempotent) and mint the
// order code for an ELIGIBLE order. Caller must hold the participant lock
// (loadPhysicalOrderByParticipant with lock:true) when concurrent minting is
// possible. Returns the refreshed order.
export async function ensurePhysicalOrderCredential(
  c: Queryable,
  order: PhysicalOrderRecord
): Promise<PhysicalOrderRecord> {
  if (order.deal_type !== "physical_product") return order;
  const verdict = decidePhysicalFulfillment({
    dealType: order.deal_type,
    dealState: order.deal_state,
    buyerState: order.buyer_state,
    moneyState: order.money_state,
    units: summarizeUnits(order.units)
  });
  if (!verdict.eligible) return order;
  if (order.units.length < order.qty) {
    await issueFulfillmentUnitsForParticipant(c, {
      dealId: order.deal_id,
      participantId: order.participant_id,
      qty: order.qty,
      dealType: order.deal_type as DealType
    });
  }
  let refreshed = order.units.length < order.qty ? await loadPhysicalOrderByParticipant(c, order.participant_id) : order;
  if (!refreshed) return order;
  if (orderCodeOf(refreshed)) return refreshed;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const digits = generateOrderCodeDigits();
    const code = formatOrderCode(digits);
    const taken = await c.query(
      `SELECT 1 FROM siton.fulfillment_units WHERE metadata_jsonb->>'order_code' = $1 LIMIT 1`,
      [code]
    );
    if (taken.rowCount) continue;
    await c.query(
      `UPDATE siton.fulfillment_units
          SET metadata_jsonb = metadata_jsonb || $2::jsonb,
              code_display_last4 = $3,
              updated_at = now()
        WHERE participant_id = $1
          AND (metadata_jsonb->>'order_code') IS NULL`,
      [refreshed.participant_id, JSON.stringify({ order_code: code, order_code_minted_at: new Date().toISOString() }), orderCodeLast4(digits)]
    );
    refreshed = (await loadPhysicalOrderByParticipant(c, refreshed.participant_id)) || refreshed;
    if (orderCodeOf(refreshed)) return refreshed;
  }
  return refreshed;
}

// ── Projections ──────────────────────────────────────────────────────────────

export function maskPhone(phone: string | null | undefined): string | null {
  const digits = String(phone || "").replace(/\D/g, "");
  if (digits.length < 4) return null;
  return `•••${digits.slice(-4)}`;
}

export function pickupLocationOf(order: PhysicalOrderRecord): { text: string | null; map_url: string | null; navigation: PickupNavigation | null } {
  if (order.pickup_option && isPickupOptionType(order.pickup_option.option_type)) {
    const described = describePickupLocation(order.pickup_option);
    // SPRINT 4 (A1): navigation is the canonical projection — exact coordinates
    // or an address search of the REAL location text; a generic label never
    // becomes a navigation target even though it is still shown as the label.
    return { text: described.location_text || order.pickup_option.label || order.delivery_method_label, map_url: described.map_url, navigation: described.navigation };
  }
  const method = methodForDeliveryType(order.delivery_method_type);
  if (method === "pickup") return { text: order.delivery_method_label, map_url: null, navigation: null };
  return { text: null, map_url: null, navigation: null };
}

// What the SELLER sees after a scan / code entry / search hit. Never a raw
// money state as the primary line; the money state is included for the UI's
// staging disclosure logic only.
export function sellerOrderProjection(order: PhysicalOrderRecord, options?: { revealPhone?: boolean }) {
  const units = summarizeUnits(order.units);
  const verdict = decidePhysicalFulfillment({
    dealType: order.deal_type,
    dealState: order.deal_state,
    buyerState: order.buyer_state,
    moneyState: order.money_state,
    units
  });
  const method = methodForDeliveryType(order.delivery_method_type);
  const location = pickupLocationOf(order);
  const phone = order.buyer_phone || (/^\d{9,15}$/.test(order.buyer_id) ? order.buyer_id : null);
  return {
    participant_id: order.participant_id,
    deal_id: order.deal_id,
    order_code: orderCodeOf(order),
    verdict: verdict.seller_verdict,
    verdict_label:
      verdict.seller_verdict === "ready" ? "מוכן למסירה"
        : verdict.seller_verdict === "already_fulfilled" ? "כבר נמסר"
          : "אין למסור את ההזמנה",
    not_ready_reason: verdict.not_ready_reason,
    not_ready_label: verdict.not_ready_reason ? SELLER_NOT_READY_COPY[verdict.not_ready_reason] : null,
    buyer_name: order.buyer_name,
    buyer_phone: options?.revealPhone ? phone : null,
    buyer_phone_masked: maskPhone(phone),
    buyer_email: options?.revealPhone ? order.buyer_email : null,
    product_title: order.deal_title,
    qty: order.qty,
    paid: verdict.paid,
    payment_label: verdict.paid ? PAYMENT_LABEL_PAID : PAYMENT_LABEL_UNPAID,
    method,
    method_label: methodLabel(method, order.delivery_method_label),
    pickup_location: location.text,
    delivery_address: method === "delivery" ? order.delivery_address : null,
    delivery_city: method === "delivery" ? order.delivery_city : null,
    delivery_notes: order.delivery_notes,
    fulfillment_status: verdict.seller_verdict === "already_fulfilled" ? "fulfilled" : verdict.seller_verdict === "ready" ? "awaiting" : "blocked",
    fulfilled_at: units.redeemed_at,
    units_total: units.total,
    units_redeemed: units.redeemed,
    joined_at: order.joined_at,
    deal_state: order.deal_state,
    money_state: order.money_state
  };
}

// What the BUYER sees on the tracking page (token-authenticated). The QR
// payload carries the locator only.
export function buyerPickupProjection(order: PhysicalOrderRecord, args: { publicOrigin: string; mockMoney: boolean }) {
  const units = summarizeUnits(order.units);
  const verdict = decidePhysicalFulfillment({
    dealType: order.deal_type,
    dealState: order.deal_state,
    buyerState: order.buyer_state,
    moneyState: order.money_state,
    units
  });
  const method = methodForDeliveryType(order.delivery_method_type);
  const state = verdict.buyer_state;
  const copy = state === "not_applicable" ? null : BUYER_PICKUP_COPY[state];
  const code = state === "ready" || state === "fulfilled" ? orderCodeOf(order) : null;
  const location = pickupLocationOf(order);
  const phone = order.buyer_phone || (/^\d{9,15}$/.test(order.buyer_id) ? order.buyer_id : null);
  return {
    applicable: state !== "not_applicable",
    state,
    method,
    method_label: methodLabel(method, order.delivery_method_label),
    headline: state === "ready" && method === "delivery" ? "ההזמנה אושרה למשלוח" : copy?.headline || null,
    subline: state === "ready" && method === "delivery"
      ? "המוכר ישלח את ההזמנה לכתובת שמסרתם. קוד ההזמנה משמש לזיהוי מול המוכר."
      : copy?.subline || null,
    order_code: code,
    qr_payload: code && method === "pickup" ? pickupQrPayload(args.publicOrigin, code) : null,
    qty: order.qty,
    product_title: order.deal_title,
    pickup_location: method === "pickup" ? location.text : null,
    pickup_map_url: method === "pickup" ? location.map_url : null,
    pickup_navigation: method === "pickup" ? location.navigation : null,
    delivery_address: method === "delivery" ? order.delivery_address : null,
    delivery_city: method === "delivery" ? order.delivery_city : null,
    buyer_name: order.buyer_name,
    phone_last4: phone ? String(phone).replace(/\D/g, "").slice(-4) || null : null,
    fulfilled_at: state === "fulfilled" ? units.redeemed_at : null,
    disclosure: args.mockMoney ? "סביבת הדגמה — אין חיוב אמיתי" : null
  };
}

// ── Handoff (exactly once) ───────────────────────────────────────────────────

export type HandoffFailure =
  | { kind: "not_found" }
  | { kind: "ambiguous" }
  | { kind: "not_ready"; reason: NotReadyReason; order: PhysicalOrderRecord }
  | { kind: "qty_mismatch"; expected: number; actual: number; order: PhysicalOrderRecord };

export type HandoffOutcome =
  | { ok: true; idempotent: boolean; replay: boolean; order: PhysicalOrderRecord; fulfilled_at: string | null; units_marked: number }
  | { ok: false; failure: HandoffFailure };

export async function handoffPhysicalOrder(
  c: Queryable,
  args: {
    sellerId: string;
    participantId: string;
    orderCodeDigits?: string | null;
    expectedQty?: number | null;
    source: string;
    actorRef: string;
    requestId: string;
    idempotencyKey: string;
  }
): Promise<HandoffOutcome> {
  const replay = await c.query(
    `SELECT response_jsonb
       FROM siton.idempotency_log
      WHERE entity_type='participant' AND entity_id=$1 AND action_name=$2 AND idempotency_key=$3`,
    [args.participantId, HANDOFF_ACTION_NAME, args.idempotencyKey]
  );
  if (replay.rowCount && replay.rows[0]?.response_jsonb) {
    const stored = replay.rows[0].response_jsonb as any;
    const order = await loadPhysicalOrderByParticipant(c, args.participantId);
    if (order && order.seller_id === args.sellerId) {
      return { ok: true, idempotent: true, replay: true, order, fulfilled_at: stored.fulfilled_at ?? summarizeUnits(order.units).redeemed_at, units_marked: 0 };
    }
  }
  const locked = await loadPhysicalOrderByParticipant(c, args.participantId, { lock: true });
  if (!locked || locked.seller_id !== args.sellerId) return { ok: false, failure: { kind: "not_found" } };
  if (args.orderCodeDigits) {
    const expectedCode = formatOrderCode(args.orderCodeDigits);
    const actualCode = orderCodeOf(locked);
    if (!expectedCode || !actualCode || expectedCode !== actualCode) return { ok: false, failure: { kind: "not_found" } };
  }
  const order = await ensurePhysicalOrderCredential(c, locked);
  const units = summarizeUnits(order.units);
  const verdict = decidePhysicalFulfillment({
    dealType: order.deal_type,
    dealState: order.deal_state,
    buyerState: order.buyer_state,
    moneyState: order.money_state,
    units
  });
  if (verdict.seller_verdict === "already_fulfilled") {
    return { ok: true, idempotent: true, replay: false, order, fulfilled_at: units.redeemed_at, units_marked: 0 };
  }
  if (verdict.seller_verdict !== "ready" || !verdict.eligible) {
    return { ok: false, failure: { kind: "not_ready", reason: verdict.not_ready_reason || "not_eligible", order } };
  }
  if (args.expectedQty !== null && args.expectedQty !== undefined && Number(args.expectedQty) !== order.qty) {
    return { ok: false, failure: { kind: "qty_mismatch", expected: Number(args.expectedQty), actual: order.qty, order } };
  }
  const handoffRecord = {
    handoff: {
      seller_id: args.sellerId,
      actor_ref: args.actorRef,
      request_id: args.requestId,
      idempotency_key: args.idempotencyKey,
      source: args.source,
      qty: order.qty,
      at: new Date().toISOString()
    }
  };
  const updated = await c.query(
    `UPDATE siton.fulfillment_units
        SET status = 'Redeemed',
            redeemed_at = now(),
            metadata_jsonb = metadata_jsonb || $2::jsonb,
            updated_at = now()
      WHERE participant_id = $1
        AND deal_type = 'physical_product'
        AND status IN ('Issued','Sent','Pending')
      RETURNING fulfillment_unit_id, redeemed_at`,
    [order.participant_id, JSON.stringify(handoffRecord)]
  );
  const after = (await loadPhysicalOrderByParticipant(c, order.participant_id)) || order;
  const afterUnits = summarizeUnits(after.units);
  if (!updated.rowCount) {
    // Lost a race we should have won under the lock: answer canonical truth.
    return { ok: true, idempotent: true, replay: false, order: after, fulfilled_at: afterUnits.redeemed_at, units_marked: 0 };
  }
  const code = orderCodeOf(after);
  await c.query(
    `INSERT INTO siton.seller_security_events
       (seller_id, event_type, from_status, to_status, actor_ref, reason, request_id, idempotency_key, payload)
     VALUES ($1, $2, 'Issued', 'Redeemed', $3, $4, $5, $6, $7)`,
    [
      args.sellerId,
      HANDOFF_EVENT_TYPE,
      args.actorRef,
      args.source,
      args.requestId,
      args.idempotencyKey,
      JSON.stringify({
        deal_id: after.deal_id,
        participant_id: after.participant_id,
        qty: after.qty,
        units_marked: updated.rowCount,
        fulfillment_unit_ids: updated.rows.map((row: any) => String(row.fulfillment_unit_id)),
        order_code_last4: code ? code.slice(-4) : null,
        method: methodForDeliveryType(after.delivery_method_type)
      })
    ]
  );
  const response = {
    ok: true,
    idempotent: false,
    participant_id: after.participant_id,
    deal_id: after.deal_id,
    qty: after.qty,
    units_marked: updated.rowCount,
    fulfilled_at: afterUnits.redeemed_at
  };
  await c.query(
    `INSERT INTO siton.idempotency_log
       (entity_type, entity_id, action_name, idempotency_key, response_code, response_jsonb)
     VALUES ('participant', $1, $2, $3, 'OK', $4)
     ON CONFLICT (entity_type, entity_id, action_name, idempotency_key) DO NOTHING`,
    [after.participant_id, HANDOFF_ACTION_NAME, args.idempotencyKey, JSON.stringify(response)]
  );
  return { ok: true, idempotent: false, replay: false, order: after, fulfilled_at: afterUnits.redeemed_at, units_marked: updated.rowCount || 0 };
}

// ── Lists / search ───────────────────────────────────────────────────────────

const ELIGIBLE_MONEY = `p.money_state IN ('ChargedSuccess','RecoveredCharge')`;

// Every settled order of ONE completed physical deal (delivery + pickup),
// with the live verdict per row. Codes are minted for eligible rows on read.
export async function listDealPhysicalOrders(
  c: Queryable,
  args: { sellerId: string; dealId: string }
): Promise<PhysicalOrderRecord[]> {
  const r = await c.query(
    `${ORDER_SELECT}
      WHERE p.deal_id = $1 AND d.seller_id = $2 AND d.deal_type = 'physical_product'
        AND (${ELIGIBLE_MONEY} OR p.buyer_state = 'DealCompleted')
      ORDER BY p.created_at ASC`,
    [args.dealId, args.sellerId]
  );
  const out: PhysicalOrderRecord[] = [];
  for (const row of r.rows) {
    const units = await loadUnits(c, String(row.participant_id), false);
    const order = mapOrderRow(row, units);
    out.push(await ensurePhysicalOrderCredential(c, order));
  }
  return out;
}

export function normalizeSearchQuery(input: unknown): { digits: string; text: string } | null {
  const raw = String(input ?? "").trim().slice(0, 80);
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  const text = raw.replace(/\s+/g, " ").trim();
  if (digits.length >= 4) return { digits, text };
  if (text.length >= 2) return { digits: "", text };
  return null;
}

// Phone / name search across ALL completed physical deals of one seller
// (bounded). A code typed here is routed to the code resolver by the route.
export async function searchSellerPhysicalOrders(
  c: Queryable,
  args: { sellerId: string; query: { digits: string; text: string }; limit?: number }
): Promise<PhysicalOrderRecord[]> {
  const limit = Math.min(Math.max(1, Number(args.limit || 20)), 50);
  const params: unknown[] = [args.sellerId];
  const clauses: string[] = [];
  if (args.query.digits) {
    params.push(`%${args.query.digits}%`);
    clauses.push(`regexp_replace(COALESCE(p.buyer_phone, p.buyer_id, ''), '\\D', '', 'g') LIKE $${params.length}`);
  }
  if (args.query.text) {
    params.push(`%${args.query.text}%`);
    clauses.push(`COALESCE(p.buyer_name, '') ILIKE $${params.length}`);
  }
  if (!clauses.length) return [];
  params.push(limit);
  const r = await c.query(
    `${ORDER_SELECT}
      WHERE d.seller_id = $1 AND d.deal_type = 'physical_product' AND d.state = 'Completed'
        AND (${clauses.join(" OR ")})
      ORDER BY p.created_at DESC
      LIMIT $${params.length}`,
    params
  );
  const out: PhysicalOrderRecord[] = [];
  for (const row of r.rows) {
    const units = await loadUnits(c, String(row.participant_id), false);
    const order = mapOrderRow(row, units);
    out.push(await ensurePhysicalOrderCredential(c, order));
  }
  return out;
}

// Admin / support view: counts + per-participant fulfillment status for one
// deal. Read-only (never mints codes); the code is exposed as last4 only.
export async function dealFulfillmentSnapshot(c: Queryable, dealId: string): Promise<{
  applicable: boolean;
  awaiting: number;
  fulfilled: number;
  blocked: number;
  by_participant: Record<string, { fulfillment_status: "awaiting" | "fulfilled" | "blocked" | "none"; fulfilled_at: string | null; order_code_last4: string | null; units_total: number; units_redeemed: number }>;
}> {
  const r = await c.query(`${ORDER_SELECT} WHERE p.deal_id = $1`, [dealId]);
  const byParticipant: Record<string, any> = {};
  let awaiting = 0;
  let fulfilled = 0;
  let blocked = 0;
  let applicable = false;
  for (const row of r.rows) {
    if (String(row.deal_type) !== "physical_product") continue;
    applicable = true;
    const units = await loadUnits(c, String(row.participant_id), false);
    const order = mapOrderRow(row, units);
    const summary = summarizeUnits(order.units);
    const verdict = decidePhysicalFulfillment({
      dealType: order.deal_type,
      dealState: order.deal_state,
      buyerState: order.buyer_state,
      moneyState: order.money_state,
      units: summary
    });
    let status: "awaiting" | "fulfilled" | "blocked" | "none" = "none";
    if (verdict.seller_verdict === "ready") { awaiting += 1; status = "awaiting"; }
    else if (verdict.seller_verdict === "already_fulfilled") { fulfilled += 1; status = "fulfilled"; }
    else if (verdict.paid) { blocked += 1; status = "blocked"; }
    const code = orderCodeOf(order);
    byParticipant[order.participant_id] = {
      fulfillment_status: status,
      fulfilled_at: status === "fulfilled" ? summary.redeemed_at : null,
      order_code_last4: code ? code.slice(-4) : null,
      units_total: summary.total,
      units_redeemed: summary.redeemed
    };
  }
  return { applicable, awaiting, fulfilled, blocked, by_participant: byParticipant };
}

// The absolute origin the buyer's page was served from (proxy-aware), used
// for the QR payload so a phone camera opens the seller scanner directly.
export function publicOriginFromHeaders(headers: Record<string, unknown> | undefined | null): string {
  const h = headers || {};
  const proto = String(h["x-forwarded-proto"] || "").split(",")[0]!.trim() || "https";
  const host = String(h["x-forwarded-host"] || h["host"] || "").split(",")[0]!.trim();
  if (!host) return "";
  return `${proto}://${host}`;
}
