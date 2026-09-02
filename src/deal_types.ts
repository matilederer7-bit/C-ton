import { assertRequiredTables } from "./schema_contract.js";
// Deal Type Expansion — physical_product / voucher / ticket.
//
// One deal engine, three fulfillment profiles. Money, state machine, the 90%
// rule, eligibility, refund policy, and JSON boundary are not changed by this
// module. Only fulfillment shape (delivery vs. voucher code vs. event ticket)
// differs per type.
//
// Issuance rule (enforced in src/app.ts):
//   • fulfillment_units are NEVER created before deal.state = 'Completed'
//     and participant.money_state IN ('ChargedSuccess','RecoveredCharge').
//   • Issuance is idempotent on (deal_id, participant_id, unit_index).

import { randomBytes, createHash } from "node:crypto";

export const DEAL_TYPES = ["physical_product", "voucher", "ticket", "service"] as const;
export type DealType = (typeof DEAL_TYPES)[number];

export const VOUCHER_CODE_MODES = [
  "system_generated",
  "seller_uploaded",
  "seller_external"
] as const;
export type VoucherCodeMode = (typeof VOUCHER_CODE_MODES)[number];

export const TICKET_SEAT_MODES = [
  "general_admission",
  "assigned_seating_not_supported_yet",
  "external_seating"
] as const;
export type TicketSeatMode = (typeof TICKET_SEAT_MODES)[number];

export const TICKET_TYPES = [
  "general_admission",
  "reserved_external",
  "vip",
  "other"
] as const;
export type TicketType = (typeof TICKET_TYPES)[number];

export const FULFILLMENT_KINDS = [
  "physical_delivery",
  "voucher_code",
  "event_ticket",
  "service_confirmation"
] as const;
export type FulfillmentKind = (typeof FULFILLMENT_KINDS)[number];

export const FULFILLMENT_STATUSES = [
  "Pending",
  "Issued",
  "Sent",
  "Redeemed",
  "Expired",
  "VoidedDueToDealFailure"
] as const;
export type FulfillmentStatus = (typeof FULFILLMENT_STATUSES)[number];

export function isDealType(value: unknown): value is DealType {
  return typeof value === "string" && (DEAL_TYPES as readonly string[]).includes(value);
}

export function normalizeDealType(value: unknown, fallback: DealType = "physical_product"): DealType {
  if (isDealType(value)) return value;
  return fallback;
}

export function fulfillmentKindForDealType(dealType: DealType): FulfillmentKind {
  if (dealType === "voucher") return "voucher_code";
  if (dealType === "ticket") return "event_ticket";
  if (dealType === "service") return "service_confirmation";
  return "physical_delivery";
}

// 24-character base32-ish alphanumeric, high entropy for system-generated codes.
// We never persist plaintext; only a SHA-256 hash and the last 4 chars are stored.
// Issuance code is shown ONCE in the issuance result and on the buyer tracking
// view (only when participant is eligible). Re-derivation is impossible by
// design — this matches the spec's "no plaintext code at rest" requirement.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generateFulfillmentCode(length = 16): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i += 1) {
    const byte = bytes[i] ?? 0;
    out += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  }
  return out;
}

export function hashFulfillmentCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

export function lastFour(code: string): string {
  if (!code) return "";
  return code.slice(-4);
}

export type IssuanceDecision = {
  shouldIssue: boolean;
  reason: string;
};

export function decideFulfillmentIssuance(args: {
  dealState: string;
  buyerState: string;
  moneyState: string;
}): IssuanceDecision {
  if (args.dealState !== "Completed") {
    return { shouldIssue: false, reason: "deal_not_completed" };
  }
  if (args.buyerState !== "DealCompleted") {
    return { shouldIssue: false, reason: "buyer_not_completed" };
  }
  if (args.moneyState !== "ChargedSuccess" && args.moneyState !== "RecoveredCharge") {
    return { shouldIssue: false, reason: "money_not_settled" };
  }
  return { shouldIssue: true, reason: "eligible" };
}

type Queryable = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number }>;
};

// Read voucher terms (fail closed — return null if missing instead of throwing).
export async function readVoucherTerms(c: Queryable, dealId: string) {
  const r = await c.query(
    `SELECT deal_id, face_value_amount, currency, valid_from, valid_until,
            redemption_location, redemption_instructions, terms,
            is_single_use, allow_partial_redemption, voucher_code_mode
       FROM siton.deal_voucher_terms
      WHERE deal_id = $1`,
    [dealId]
  );
  return r.rowCount ? (r.rows[0] as Record<string, any>) : null;
}

export async function readTicketTerms(c: Queryable, dealId: string) {
  const r = await c.query(
    `SELECT deal_id, event_name, event_starts_at, event_ends_at,
            venue_name, venue_address, venue_city, entry_instructions,
            ticket_type, seat_mode, transfer_allowed
       FROM siton.deal_ticket_terms
      WHERE deal_id = $1`,
    [dealId]
  );
  return r.rowCount ? (r.rows[0] as Record<string, any>) : null;
}

export async function readServiceTerms(c: Queryable, dealId: string) {
  const r = await c.query(
    `SELECT deal_id, service_location_mode, service_location, valid_from, valid_until,
            redemption_instructions, usage_restrictions, appointment_required
       FROM siton.deal_service_terms
      WHERE deal_id = $1`,
    [dealId]
  );
  return r.rowCount ? (r.rows[0] as Record<string, any>) : null;
}

export type IssuedFulfillmentUnit = {
  fulfillment_unit_id: string;
  unit_index: number;
  status: FulfillmentStatus;
  issued_at: string | null;
  code_display_last4: string | null;
  // plaintext_code is returned ONLY at issuance time (and to the eligible buyer
  // when reading their own tracking view, where we re-issue display only via
  // last4). Never logged, never persisted as plaintext.
  plaintext_code?: string | undefined;
};

// Issue all qty units for a single eligible participant. Idempotent: if rows
// already exist for (deal_id, participant_id), the existing ones are returned
// unchanged (no new codes minted, no plaintext re-disclosed).
export async function issueFulfillmentUnitsForParticipant(
  c: Queryable,
  args: { dealId: string; participantId: string; qty: number; dealType: DealType }
): Promise<IssuedFulfillmentUnit[]> {
  const existing = await c.query(
    `SELECT fulfillment_unit_id, unit_index, status, issued_at, code_display_last4
       FROM siton.fulfillment_units
      WHERE deal_id = $1 AND participant_id = $2
      ORDER BY unit_index ASC`,
    [args.dealId, args.participantId]
  );
  if (existing.rowCount && existing.rowCount >= args.qty) {
    return existing.rows.map((row: any) => ({
      fulfillment_unit_id: String(row.fulfillment_unit_id),
      unit_index: Number(row.unit_index),
      status: row.status as FulfillmentStatus,
      issued_at: row.issued_at ? new Date(row.issued_at).toISOString() : null,
      code_display_last4: row.code_display_last4 ?? null
    }));
  }
  const fulfillmentKind = fulfillmentKindForDealType(args.dealType);
  const out: IssuedFulfillmentUnit[] = [];
  const startIndex = (existing.rowCount || 0) + 1;
  for (let unitIndex = startIndex; unitIndex <= args.qty; unitIndex += 1) {
    let codeHash: string | null = null;
    let codeLast4: string | null = null;
    let plaintextCode: string | undefined;
    if (args.dealType !== "physical_product") {
      plaintextCode = generateFulfillmentCode(16);
      codeHash = hashFulfillmentCode(plaintextCode);
      codeLast4 = lastFour(plaintextCode);
    }
    const inserted = await c.query(
      `INSERT INTO siton.fulfillment_units
         (deal_id, participant_id, deal_type, fulfillment_kind, unit_index,
          code_hash, code_display_last4, status, issued_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'Issued', now())
       ON CONFLICT (deal_id, participant_id, unit_index) DO NOTHING
       RETURNING fulfillment_unit_id, unit_index, status, issued_at, code_display_last4`,
      [args.dealId, args.participantId, args.dealType, fulfillmentKind, unitIndex, codeHash, codeLast4]
    );
    if (inserted.rowCount) {
      const row = inserted.rows[0] as any;
      out.push({
        fulfillment_unit_id: String(row.fulfillment_unit_id),
        unit_index: Number(row.unit_index),
        status: row.status as FulfillmentStatus,
        issued_at: row.issued_at ? new Date(row.issued_at).toISOString() : null,
        code_display_last4: row.code_display_last4 ?? null,
        plaintext_code: plaintextCode
      });
    }
  }
  // Merge any pre-existing rows we skipped at the top:
  if (existing.rowCount) {
    for (const row of existing.rows as any[]) {
      out.unshift({
        fulfillment_unit_id: String(row.fulfillment_unit_id),
        unit_index: Number(row.unit_index),
        status: row.status as FulfillmentStatus,
        issued_at: row.issued_at ? new Date(row.issued_at).toISOString() : null,
        code_display_last4: row.code_display_last4 ?? null
      });
    }
  }
  return out;
}

let ensurePromise: Promise<void> | null = null;

// Read-only contract check. Migration 038 remains the sole schema source.
export async function ensureDealTypeTables(
  withTx: <T>(fn: (c: Queryable) => Promise<T>) => Promise<T>
): Promise<void> {
  if (!ensurePromise) {
    ensurePromise = withTx(async (c) => assertRequiredTables(c, ["deal_voucher_terms", "deal_ticket_terms", "deal_service_terms", "fulfillment_units"]));
  }
  await ensurePromise;
}

// Voucher terms write (idempotent upsert).
export type VoucherTermsInput = {
  face_value_amount: number;
  currency?: string;
  valid_from?: string | null;
  valid_until?: string | null;
  redemption_location?: string;
  redemption_instructions?: string;
  terms?: string;
  is_single_use?: boolean;
  allow_partial_redemption?: boolean;
  voucher_code_mode?: VoucherCodeMode;
};

export async function upsertVoucherTerms(
  c: Queryable,
  dealId: string,
  input: VoucherTermsInput
): Promise<void> {
  const faceValue = Number(input.face_value_amount);
  if (!Number.isFinite(faceValue) || faceValue <= 0) {
    const err: any = new Error("face_value_amount must be a positive number");
    err.statusCode = 400;
    err.code = "voucher_face_value_invalid";
    throw err;
  }
  // Spec: seller_uploaded codes are not implemented. Refuse the value rather
  // than silently downgrading so demos can't pretend support exists.
  const mode: VoucherCodeMode = input.voucher_code_mode || "system_generated";
  if (mode === "seller_uploaded") {
    const err: any = new Error("seller_uploaded voucher codes are not supported yet");
    err.statusCode = 400;
    err.code = "voucher_code_mode_unsupported";
    throw err;
  }
  await c.query(
    `INSERT INTO siton.deal_voucher_terms
       (deal_id, face_value_amount, currency, valid_from, valid_until,
        redemption_location, redemption_instructions, terms,
        is_single_use, allow_partial_redemption, voucher_code_mode)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (deal_id) DO UPDATE
       SET face_value_amount = EXCLUDED.face_value_amount,
           currency = EXCLUDED.currency,
           valid_from = EXCLUDED.valid_from,
           valid_until = EXCLUDED.valid_until,
           redemption_location = EXCLUDED.redemption_location,
           redemption_instructions = EXCLUDED.redemption_instructions,
           terms = EXCLUDED.terms,
           is_single_use = EXCLUDED.is_single_use,
           allow_partial_redemption = EXCLUDED.allow_partial_redemption,
           voucher_code_mode = EXCLUDED.voucher_code_mode,
           updated_at = now()`,
    [
      dealId,
      faceValue,
      String(input.currency || "ILS").trim().slice(0, 8) || "ILS",
      input.valid_from || null,
      input.valid_until || null,
      String(input.redemption_location || "").trim().slice(0, 500),
      String(input.redemption_instructions || "").trim().slice(0, 1000),
      String(input.terms || "").trim().slice(0, 2000),
      input.is_single_use !== false,
      input.allow_partial_redemption === true,
      mode
    ]
  );
}

export type TicketTermsInput = {
  event_name: string;
  event_starts_at: string;
  event_ends_at?: string | null;
  venue_name?: string;
  venue_address?: string;
  venue_city?: string;
  entry_instructions?: string;
  ticket_type?: TicketType;
  seat_mode?: TicketSeatMode;
  transfer_allowed?: boolean;
};

export async function upsertTicketTerms(
  c: Queryable,
  dealId: string,
  input: TicketTermsInput
): Promise<void> {
  const eventName = String(input.event_name || "").trim().slice(0, 200);
  if (!eventName) {
    const err: any = new Error("event_name is required for ticket deals");
    err.statusCode = 400;
    err.code = "ticket_event_name_required";
    throw err;
  }
  const startsAtMs = new Date(String(input.event_starts_at || "")).getTime();
  if (!Number.isFinite(startsAtMs)) {
    const err: any = new Error("event_starts_at must be a valid ISO date");
    err.statusCode = 400;
    err.code = "ticket_event_starts_at_invalid";
    throw err;
  }
  const seatMode: TicketSeatMode = input.seat_mode || "general_admission";
  if (seatMode === "assigned_seating_not_supported_yet") {
    const err: any = new Error("assigned seating is not supported yet — use general_admission or external_seating");
    err.statusCode = 400;
    err.code = "ticket_seat_mode_unsupported";
    throw err;
  }
  const ticketType: TicketType = input.ticket_type || "general_admission";
  await c.query(
    `INSERT INTO siton.deal_ticket_terms
       (deal_id, event_name, event_starts_at, event_ends_at,
        venue_name, venue_address, venue_city, entry_instructions,
        ticket_type, seat_mode, transfer_allowed)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (deal_id) DO UPDATE
       SET event_name = EXCLUDED.event_name,
           event_starts_at = EXCLUDED.event_starts_at,
           event_ends_at = EXCLUDED.event_ends_at,
           venue_name = EXCLUDED.venue_name,
           venue_address = EXCLUDED.venue_address,
           venue_city = EXCLUDED.venue_city,
           entry_instructions = EXCLUDED.entry_instructions,
           ticket_type = EXCLUDED.ticket_type,
           seat_mode = EXCLUDED.seat_mode,
           transfer_allowed = EXCLUDED.transfer_allowed,
           updated_at = now()`,
    [
      dealId,
      eventName,
      new Date(startsAtMs).toISOString(),
      input.event_ends_at ? new Date(String(input.event_ends_at)).toISOString() : null,
      String(input.venue_name || "").trim().slice(0, 200),
      String(input.venue_address || "").trim().slice(0, 300),
      String(input.venue_city || "").trim().slice(0, 100),
      String(input.entry_instructions || "").trim().slice(0, 1000),
      ticketType,
      seatMode,
      input.transfer_allowed === true
    ]
  );
}

// CSV cell sanitizer for voucher/ticket exports — same neutralization as the
// existing shipping export (= + - @ prefixes neutralized, doubled quotes for
// commas/newlines). Re-exported here so the deal-types tests can assert it.
export type ServiceTermsInput = {
  service_location_mode: "online" | "onsite" | "customer_location" | "hybrid";
  service_location?: string;
  valid_from?: string | null;
  valid_until?: string | null;
  redemption_instructions: string;
  usage_restrictions?: string;
  appointment_required?: boolean;
};

export async function upsertServiceTerms(
  c: Queryable,
  dealId: string,
  input: ServiceTermsInput
): Promise<void> {
  const locationMode = String(input.service_location_mode || "").trim();
  if (!["online", "onsite", "customer_location", "hybrid"].includes(locationMode)) {
    throw Object.assign(new Error("service_location_mode is invalid"), { statusCode: 400, code: "service_location_mode_invalid" });
  }
  const location = String(input.service_location || "").trim().slice(0, 500);
  if (["onsite", "hybrid"].includes(locationMode) && !location) {
    throw Object.assign(new Error("service_location is required"), { statusCode: 400, code: "service_location_required" });
  }
  const instructions = String(input.redemption_instructions || "").trim().slice(0, 1000);
  if (!instructions) {
    throw Object.assign(new Error("redemption_instructions is required"), { statusCode: 400, code: "service_instructions_required" });
  }
  const validFrom = input.valid_from ? new Date(String(input.valid_from)) : null;
  const validUntil = input.valid_until ? new Date(String(input.valid_until)) : null;
  if ((validFrom && !Number.isFinite(validFrom.getTime())) || (validUntil && !Number.isFinite(validUntil.getTime()))) {
    throw Object.assign(new Error("service redemption period is invalid"), { statusCode: 400, code: "service_period_invalid" });
  }
  if (validFrom && validUntil && validUntil.getTime() <= validFrom.getTime()) {
    throw Object.assign(new Error("service valid_until must be after valid_from"), { statusCode: 400, code: "service_period_invalid" });
  }
  await c.query(
    `INSERT INTO siton.deal_service_terms
       (deal_id, service_location_mode, service_location, valid_from, valid_until,
        redemption_instructions, usage_restrictions, appointment_required)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (deal_id) DO UPDATE
       SET service_location_mode=EXCLUDED.service_location_mode,
           service_location=EXCLUDED.service_location,
           valid_from=EXCLUDED.valid_from,
           valid_until=EXCLUDED.valid_until,
           redemption_instructions=EXCLUDED.redemption_instructions,
           usage_restrictions=EXCLUDED.usage_restrictions,
           appointment_required=EXCLUDED.appointment_required,
           updated_at=now()`,
    [dealId, locationMode, location, validFrom ? validFrom.toISOString() : null,
      validUntil ? validUntil.toISOString() : null, instructions,
      String(input.usage_restrictions || "").trim().slice(0, 2000), input.appointment_required === true]
  );
}

export function csvSafeCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  let str = String(value);
  if (/^[=+\-@]/.test(str)) {
    str = "'" + str;
  }
  if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

// Tracking copy hints per deal_type — used to drive consistent UX text on the
// public deal page and the buyer tracking view. Backend ships these as data;
// frontend renders them.
export function publicDealCopy(dealType: DealType): { headline: string; disclaimer: string } {
  if (dealType === "voucher") {
    return {
      headline: "שובר",
      disclaimer:
        "השובר יונפק רק לאחר שהעסקה תושלם והחיוב יעבור בפועל. אם העסקה לא תושלם, לא יונפק שובר ולא יבוצע חיוב."
    };
  }
  if (dealType === "ticket") {
    return {
      headline: "כרטיס לאירוע",
      disclaimer:
        "הכרטיס יונפק רק לאחר שהעסקה תושלם והחיוב יעבור בפועל. אם העסקה לא תושלם, לא יונפק כרטיס ולא יבוצע חיוב."
    };
  }
  if (dealType === "service") {
    return {
      headline: "שירות",
      disclaimer: "אישור המימוש יונפק רק לאחר שהעסקה תושלם והחיוב יעבור בפועל. תיאום ומימוש השירות באחריות המוכר לפי התנאים שהוצגו."
    };
  }
  return {
    headline: "מוצר פיזי",
    disclaimer:
      "מוצר פיזי יסופק לפי תנאי האספקה שקבע המוכר לאחר שהעסקה תושלם ותיגבה בפועל."
  };
}

export function trackingCopyForFulfillment(args: {
  dealType: DealType;
  dealState: string;
  buyerState: string;
  moneyState: string;
}): { headline: string; subline: string } {
  const issuance = decideFulfillmentIssuance({
    dealState: args.dealState,
    buyerState: args.buyerState,
    moneyState: args.moneyState
  });
  if (args.dealType === "voucher") {
    if (!issuance.shouldIssue) {
      return {
        headline: "השובר עדיין לא הונפק",
        subline: "השובר יוצג כאן ברגע שהעסקה תושלם והחיוב יעבור בפועל."
      };
    }
    return {
      headline: "השובר הונפק",
      subline: "מימוש השובר באחריות המוכר לפי תנאי המימוש שצוינו."
    };
  }
  if (args.dealType === "ticket") {
    if (!issuance.shouldIssue) {
      return {
        headline: "הכרטיס עדיין לא הונפק",
        subline: "הכרטיס יוצג כאן ברגע שהעסקה תושלם והחיוב יעבור בפועל."
      };
    }
    return {
      headline: "הכרטיס הונפק",
      subline: "הכניסה לאירוע באחריות המוכר לפי תנאי הכניסה שצוינו."
    };
  }
  if (args.dealType === "service") {
    if (!issuance.shouldIssue) {
      return {
        headline: "השירות עדיין לא זמין למימוש",
        subline: "אישור המימוש יוצג כאן לאחר שהעסקה תושלם והחיוב יעבור בפועל."
      };
    }
    return {
      headline: "השירות זמין למימוש",
      subline: "יש לפעול לפי הוראות המימוש והתיאום של המוכר."
    };
  }
  if (!issuance.shouldIssue) {
    return {
      headline: "ממתין להשלמת העסקה",
      subline: "פרטי האספקה יופיעו לאחר שהעסקה תושלם והחיוב יעבור בפועל."
    };
  }
  return {
    headline: "מוכן לאספקה",
    subline: "האספקה תתבצע על ידי המוכר לפי תנאי המשלוח/האיסוף שצוינו."
  };
}
