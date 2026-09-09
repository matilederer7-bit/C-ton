// PILOT COMMUNICATIONS — canonical business event → transactional notification.
//
// ONE place decides, for every pilot event:
//   * WHO is notified (recipients come from canonical server-side rows: the
//     participant's own contact, the seller account's own contact, the
//     configured admin destination — never from a request body);
//   * WHICH deterministic identity the intended notification has (idempotency
//     keys derived from business identity, so replays / retries / duplicate
//     webhooks / worker restarts collapse to ONE notification_events row);
//   * WHAT truthful payload the Hebrew template renders (money mode, canonical
//     product links);
//   * WHEN it is durable: every helper takes the business transaction's client
//     and writes inside it under a savepoint, so the notification commits with
//     the canonical state and can never survive a rollback — and a notification
//     failure can never abort deal / money truth.
//
// Nothing here sends anything. Rows are drained by the Worker through the
// provider boundary in notification_dispatch.ts (log / dry-run; real mode
// fails closed until a verified adapter exists).

import {
  enqueueNotification,
  notificationExists,
  withNotificationSavepoint
} from "./notification_dispatch.js";
import { issueParticipantTrackingToken } from "./participant_tracking_security.js";
import { isValidNotificationRecipientFormat } from "./notification_safety.js";
import { resolveSellerNotificationRecipient, type SellerNotificationRecipient } from "./seller_inquiries.js";
import type { NotificationChannel, NotificationEventType, NotificationMoneyMode } from "./notification_templates.js";

type Queryable = {
  query: (sql: string, params?: unknown[]) => Promise<any>;
};

export type EnqueueOutcome = {
  result: "queued" | "duplicate" | "skipped" | "error";
  event_type: NotificationEventType;
  idempotency_key: string | null;
  channel: NotificationChannel | null;
  reason?: string;
};

// ── Canonical product links ──────────────────────────────────────────────────

/**
 * The public origin every outbound link is built on. Configuration only —
 * PUBLIC_BASE_URL (custom domain later) falls back to the hosting platform's
 * external URL. Never localhost, never a request header (the Worker has none).
 */
export function canonicalPublicOrigin(env: NodeJS.ProcessEnv = process.env): string {
  return String(env.PUBLIC_BASE_URL || env.RENDER_EXTERNAL_URL || "").trim().replace(/\/+$/, "");
}

/** Canonical React routes (the hosted app is served under /preview/). */
export const notificationLinks = {
  buyerTracking(origin: string, participantId: string, token?: string | null): string {
    if (!origin) return "";
    const base = `${origin}/preview/#/track/${encodeURIComponent(participantId)}`;
    return token ? `${base}?t=${encodeURIComponent(token)}` : base;
  },
  sellerDeal(origin: string, dealId: string): string {
    return origin ? `${origin}/preview/#/seller/deal/${encodeURIComponent(dealId)}` : "";
  },
  sellerWorkspace(origin: string): string {
    return origin ? `${origin}/preview/#/seller` : "";
  },
  sellerInquiry(origin: string, threadId: string): string {
    return origin ? `${origin}/preview/#/seller/inquiries/${encodeURIComponent(threadId)}` : "";
  }
};

/** mock-backed synthetic money → "mock"; every real provider mode → "real". */
export function moneyModeForPaymentProvider(providerMode: string | null | undefined): NotificationMoneyMode {
  return String(providerMode || "mock-backed").toLowerCase() === "mock-backed" ? "mock" : "real";
}

// ── Recipient resolution (canonical rows only) ───────────────────────────────

export type BuyerNotificationRecipient = {
  channel: "sms" | "internal";
  recipient_ref: string;
  source: "buyer_phone" | "buyer_id" | "none";
  buyer_name: string;
  deal_id: string;
  deal_title: string;
  seller_id: string | null;
};

/**
 * The buyer's canonical contact is the participant row's own phone (the OTP
 * identity captured at Join). It is never taken from a later request.
 */
export async function resolveBuyerNotificationRecipient(c: Queryable, participantId: string): Promise<BuyerNotificationRecipient | null> {
  const r = await c.query(
    `SELECT p.participant_id, p.buyer_id, p.buyer_phone, p.buyer_name, p.deal_id, d.title, d.seller_id
     FROM siton.participants p
     JOIN siton.deals d ON d.deal_id = p.deal_id
     WHERE p.participant_id = $1
     LIMIT 1`,
    [participantId]
  );
  const row = r.rows[0];
  if (!row) return null;
  const phone = String(row.buyer_phone || "").trim();
  const buyerId = String(row.buyer_id || "").trim();
  const base = {
    buyer_name: String(row.buyer_name || ""),
    deal_id: String(row.deal_id),
    deal_title: String(row.title || ""),
    seller_id: row.seller_id ? String(row.seller_id) : null
  };
  if (phone) return { channel: "sms", recipient_ref: phone, source: "buyer_phone", ...base };
  if (buyerId) return { channel: "sms", recipient_ref: buyerId, source: "buyer_id", ...base };
  return { channel: "internal", recipient_ref: participantId, source: "none", ...base };
}

export { resolveSellerNotificationRecipient };
export type { SellerNotificationRecipient };

export type AdminNotificationRecipient = {
  channel: "email" | "internal";
  recipient_ref: string;
  source: "ADMIN_ALERT_EMAIL" | "none";
};

/**
 * Admin alerts go ONLY to the configured operational destination. An invalid
 * or missing configuration degrades to the internal channel (visible in the
 * admin console), never to a guessed address.
 */
export function resolveAdminNotificationRecipient(env: NodeJS.ProcessEnv = process.env): AdminNotificationRecipient {
  const configured = String(env.ADMIN_ALERT_EMAIL || "").trim();
  if (configured && isValidNotificationRecipientFormat("email", configured)) {
    return { channel: "email", recipient_ref: configured, source: "ADMIN_ALERT_EMAIL" };
  }
  return { channel: "internal", recipient_ref: "admin", source: "none" };
}

// ── Deterministic identity ───────────────────────────────────────────────────

export function notificationIdentity(
  eventType: NotificationEventType,
  recipientType: "buyer" | "seller" | "admin",
  subject: string[],
  channel: NotificationChannel
): string {
  return [eventType, recipientType, ...subject, channel].join(":");
}

// ── Tracking links for buyers (tokenized when the runtime may mint) ──────────

async function buyerTrackingLink(
  c: Queryable,
  args: { participant_id: string; deal_id: string; origin: string; issued_via: string; correlation_id?: string | null; token?: string | null }
): Promise<{ url: string; link_mode: "tokenized" | "tokenless" | "no_origin" }> {
  if (!args.origin) return { url: "", link_mode: "no_origin" };
  if (args.token) return { url: notificationLinks.buyerTracking(args.origin, args.participant_id, args.token), link_mode: "tokenized" };
  const minted = await withNotificationSavepoint(c, async () =>
    issueParticipantTrackingToken(c as any, {
      participant_id: args.participant_id,
      deal_id: args.deal_id,
      purpose: "tracking",
      issued_via: args.issued_via,
      correlation_id: args.correlation_id ?? null
    })
  );
  if (minted.ok) {
    return { url: notificationLinks.buyerTracking(args.origin, args.participant_id, minted.value.token), link_mode: "tokenized" };
  }
  // The runtime could not mint (e.g. a missing grant): point at the canonical
  // route anyway and make the degradation visible in the payload.
  return { url: notificationLinks.buyerTracking(args.origin, args.participant_id, null), link_mode: "tokenless" };
}

// ── Buyer deal events ────────────────────────────────────────────────────────

export type BuyerDealEventType =
  | "buyer_joined_authorized"
  | "buyer_deal_target_reached"
  | "buyer_deal_completed"
  | "buyer_deal_failed"
  | "buyer_recovery_required"
  | "buyer_payment_recovered"
  | "buyer_voucher_issued"
  | "buyer_ticket_issued";

export type BuyerEventContext = {
  origin: string;
  money_mode: NotificationMoneyMode;
  correlation_id?: string | null;
  /** A token already minted in this transaction (Join) — reused, not re-minted. */
  tracking_token?: string | null;
};

/**
 * Exactly one intended notification per (event, participant, channel). Reads
 * the participant's canonical contact inside the caller's transaction and
 * writes the row under a savepoint.
 */
export async function enqueueBuyerDealNotification(
  c: Queryable,
  args: { event_type: BuyerDealEventType; participant_id: string; deal_id: string; deal_title?: string | null; ctx: BuyerEventContext }
): Promise<EnqueueOutcome> {
  const guarded = await withNotificationSavepoint(c, async (): Promise<EnqueueOutcome> => {
    const recipient = await resolveBuyerNotificationRecipient(c, args.participant_id);
    if (!recipient) {
      return { result: "skipped", event_type: args.event_type, idempotency_key: null, channel: null, reason: "participant_not_found" };
    }
    if (recipient.deal_id !== args.deal_id) {
      return { result: "skipped", event_type: args.event_type, idempotency_key: null, channel: null, reason: "participant_deal_mismatch" };
    }
    const key = notificationIdentity(args.event_type, "buyer", [args.participant_id, args.deal_id], recipient.channel);
    if (await notificationExists(c as any, key)) {
      return { result: "duplicate", event_type: args.event_type, idempotency_key: key, channel: recipient.channel };
    }
    const link = await buyerTrackingLink(c, {
      participant_id: args.participant_id,
      deal_id: args.deal_id,
      origin: args.ctx.origin,
      issued_via: `notification:${args.event_type}`,
      correlation_id: args.ctx.correlation_id ?? null,
      token: args.ctx.tracking_token ?? null
    });
    const result = await enqueueNotification(
      {
        event_type: args.event_type,
        recipient_type: "buyer",
        recipient_ref: recipient.recipient_ref,
        deal_id: args.deal_id,
        participant_id: args.participant_id,
        seller_id: recipient.seller_id,
        channel: recipient.channel,
        payload_jsonb: {
          deal_id: args.deal_id,
          deal_title: String(args.deal_title || recipient.deal_title || ""),
          participant_id: args.participant_id,
          money_mode: args.ctx.money_mode,
          tracking_url: link.url,
          link_mode: link.link_mode,
          recipient_source: recipient.source
        },
        idempotency_key: key,
        correlation_id: args.ctx.correlation_id ?? null
      },
      c as any
    );
    return { result, event_type: args.event_type, idempotency_key: key, channel: recipient.channel };
  });
  if (guarded.ok) return guarded.value;
  return { result: "error", event_type: args.event_type, idempotency_key: null, channel: null, reason: guarded.error };
}

// ── Seller deal events ───────────────────────────────────────────────────────

export type SellerDealEventType =
  | "seller_deal_published"
  | "seller_target_reached"
  | "seller_deal_completed"
  | "seller_deal_failed";

export async function enqueueSellerDealNotification(
  c: Queryable,
  args: {
    event_type: SellerDealEventType;
    deal_id: string;
    seller_id: string;
    deal_title?: string | null;
    origin: string;
    money_mode: NotificationMoneyMode;
    correlation_id?: string | null;
  }
): Promise<EnqueueOutcome> {
  const guarded = await withNotificationSavepoint(c, async (): Promise<EnqueueOutcome> => {
    const dealRow = await c.query(`SELECT title, seller_id FROM siton.deals WHERE deal_id=$1 LIMIT 1`, [args.deal_id]);
    const deal = dealRow.rows[0];
    if (!deal) {
      return { result: "skipped", event_type: args.event_type, idempotency_key: null, channel: null, reason: "deal_not_found" };
    }
    // The DEAL owns the seller: a caller can never point a deal event at another seller.
    const dealSellerId = String(deal.seller_id || "").trim();
    if (dealSellerId && dealSellerId !== args.seller_id) {
      return { result: "skipped", event_type: args.event_type, idempotency_key: null, channel: null, reason: "deal_seller_mismatch" };
    }
    const recipient = await resolveSellerNotificationRecipient(c, args.seller_id);
    const key = notificationIdentity(args.event_type, "seller", [args.seller_id, args.deal_id], recipient.channel);
    const result = await enqueueNotification(
      {
        event_type: args.event_type,
        recipient_type: "seller",
        recipient_ref: recipient.recipient_ref,
        deal_id: args.deal_id,
        seller_id: args.seller_id,
        channel: recipient.channel,
        payload_jsonb: {
          deal_id: args.deal_id,
          deal_title: String(args.deal_title || deal.title || ""),
          money_mode: args.money_mode,
          deal_url: notificationLinks.sellerDeal(args.origin, args.deal_id),
          recipient_source: recipient.source
        },
        idempotency_key: key,
        correlation_id: args.correlation_id ?? null
      },
      c as any
    );
    return { result, event_type: args.event_type, idempotency_key: key, channel: recipient.channel };
  });
  if (guarded.ok) return guarded.value;
  return { result: "error", event_type: args.event_type, idempotency_key: null, channel: null, reason: guarded.error };
}

// ── Deal lifecycle fan-out (inside the deal transition's transaction) ────────

type ParticipantRow = { participant_id: string; buyer_state: string; money_state: string };

async function dealParticipants(c: Queryable, dealId: string): Promise<ParticipantRow[]> {
  const r = await c.query(
    `SELECT participant_id, buyer_state, money_state FROM siton.participants WHERE deal_id=$1 ORDER BY created_at ASC`,
    [dealId]
  );
  return r.rows as ParticipantRow[];
}

async function dealHeader(c: Queryable, dealId: string): Promise<{ title: string; seller_id: string | null } | null> {
  const r = await c.query(`SELECT title, seller_id FROM siton.deals WHERE deal_id=$1 LIMIT 1`, [dealId]);
  const row = r.rows[0];
  return row ? { title: String(row.title || ""), seller_id: row.seller_id ? String(row.seller_id) : null } : null;
}

/**
 * PendingTarget → TargetReached: every participant still holding a stake gets
 * ONE buyer_deal_target_reached; the seller gets ONE seller_target_reached.
 * A reopen that lands on TargetReached again replays to duplicates (no-op).
 */
export async function enqueueTargetReachedNotifications(
  c: Queryable,
  args: { deal_id: string; origin: string; money_mode: NotificationMoneyMode; correlation_id?: string | null; default_seller_id: string }
): Promise<{ buyers: EnqueueOutcome[]; seller: EnqueueOutcome | null }> {
  const header = await dealHeader(c, args.deal_id);
  if (!header) return { buyers: [], seller: null };
  const buyers: EnqueueOutcome[] = [];
  for (const p of await dealParticipants(c, args.deal_id)) {
    if (["Dropped", "DealFailed", "DealCompleted", "NotJoined"].includes(p.buyer_state)) continue;
    buyers.push(
      await enqueueBuyerDealNotification(c, {
        event_type: "buyer_deal_target_reached",
        participant_id: p.participant_id,
        deal_id: args.deal_id,
        deal_title: header.title,
        ctx: { origin: args.origin, money_mode: args.money_mode, correlation_id: args.correlation_id ?? null }
      })
    );
  }
  const seller = await enqueueSellerDealNotification(c, {
    event_type: "seller_target_reached",
    deal_id: args.deal_id,
    seller_id: header.seller_id || args.default_seller_id,
    deal_title: header.title,
    origin: args.origin,
    money_mode: args.money_mode,
    correlation_id: args.correlation_id ?? null
  });
  return { buyers, seller };
}

/**
 * CompletionWindow → Completed / → Failed, PendingTarget → Failed (deadline):
 * the caller classifies each participant from the canonical buyer/money state
 * (the same rule the state machine applies right after), so the buyer's
 * message matches the outcome the SAME transaction commits.
 */
export async function enqueueDealOutcomeNotifications(
  c: Queryable,
  args: {
    deal_id: string;
    outcome: "completed" | "failed";
    classify: (participant: ParticipantRow) => "completed" | "failed" | "none";
    origin: string;
    money_mode: NotificationMoneyMode;
    correlation_id?: string | null;
    default_seller_id: string;
  }
): Promise<{ buyers: EnqueueOutcome[]; seller: EnqueueOutcome | null }> {
  const header = await dealHeader(c, args.deal_id);
  if (!header) return { buyers: [], seller: null };
  const buyers: EnqueueOutcome[] = [];
  for (const p of await dealParticipants(c, args.deal_id)) {
    const verdict = args.classify(p);
    if (verdict === "none") continue;
    buyers.push(
      await enqueueBuyerDealNotification(c, {
        event_type: verdict === "completed" ? "buyer_deal_completed" : "buyer_deal_failed",
        participant_id: p.participant_id,
        deal_id: args.deal_id,
        deal_title: header.title,
        ctx: { origin: args.origin, money_mode: args.money_mode, correlation_id: args.correlation_id ?? null }
      })
    );
  }
  const seller = await enqueueSellerDealNotification(c, {
    event_type: args.outcome === "completed" ? "seller_deal_completed" : "seller_deal_failed",
    deal_id: args.deal_id,
    seller_id: header.seller_id || args.default_seller_id,
    deal_title: header.title,
    origin: args.origin,
    money_mode: args.money_mode,
    correlation_id: args.correlation_id ?? null
  });
  return { buyers, seller };
}

// ── Voucher / ticket issuance ────────────────────────────────────────────────

/**
 * Called inside the issuance transaction AFTER fulfillment_units exist for the
 * participant. Physical deals are fulfilled through the pickup rail and get no
 * message here. The e-mail/SMS never carries the code — only the tracking link.
 */
export async function enqueueFulfillmentIssuedNotification(
  c: Queryable,
  args: { deal_id: string; participant_id: string; deal_type: string; origin: string; money_mode: NotificationMoneyMode; correlation_id?: string | null }
): Promise<EnqueueOutcome | null> {
  const eventType: BuyerDealEventType | null =
    args.deal_type === "voucher" ? "buyer_voucher_issued" : args.deal_type === "ticket" ? "buyer_ticket_issued" : null;
  if (!eventType) return null;
  const issued = await c.query(
    `SELECT COUNT(*)::int AS n FROM siton.fulfillment_units WHERE deal_id=$1 AND participant_id=$2 AND status <> 'Pending'`,
    [args.deal_id, args.participant_id]
  );
  if (!Number(issued.rows[0]?.n || 0)) {
    return { result: "skipped", event_type: eventType, idempotency_key: null, channel: null, reason: "no_issued_units" };
  }
  return enqueueBuyerDealNotification(c, {
    event_type: eventType,
    participant_id: args.participant_id,
    deal_id: args.deal_id,
    ctx: { origin: args.origin, money_mode: args.money_mode, correlation_id: args.correlation_id ?? null }
  });
}

// ── Seller KYC decision ──────────────────────────────────────────────────────

const KYC_REASON_MAX = 300;

/** Bounded, markup-free, single-line text that may reach the seller. */
export function sanitizeSellerFacingReason(value: unknown): string {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, KYC_REASON_MAX)
    .trim();
}

/**
 * ONE notification per committed decision. `ordinal` is the decision's index
 * for this seller (recorded by the caller in the same transaction), so a
 * repeated approve of an already-approved seller — no state change — never
 * reaches here, while a later rejection after an approval is a new decision.
 * The internal admin note is NEVER forwarded; only an explicit seller-facing
 * reason, bounded and sanitized, may appear.
 */
export async function enqueueSellerKycDecisionNotification(
  c: Queryable,
  args: {
    seller_id: string;
    decision: "approved" | "rejected";
    ordinal: number;
    seller_name: string;
    seller_reason?: string | null;
    origin: string;
    correlation_id?: string | null;
  }
): Promise<EnqueueOutcome> {
  const eventType: NotificationEventType = args.decision === "approved" ? "seller_kyc_approved" : "seller_kyc_rejected";
  const guarded = await withNotificationSavepoint(c, async (): Promise<EnqueueOutcome> => {
    const recipient = await resolveSellerNotificationRecipient(c, args.seller_id);
    const key = notificationIdentity(eventType, "seller", [args.seller_id, "kyc", String(args.ordinal)], recipient.channel);
    const reason = args.decision === "rejected" ? sanitizeSellerFacingReason(args.seller_reason) : "";
    const result = await enqueueNotification(
      {
        event_type: eventType,
        recipient_type: "seller",
        recipient_ref: recipient.recipient_ref,
        seller_id: args.seller_id,
        channel: recipient.channel,
        payload_jsonb: {
          seller_name: String(args.seller_name || "").trim() || "מוכר/ת",
          ...(reason ? { reason } : {}),
          workspace_url: notificationLinks.sellerWorkspace(args.origin),
          recipient_source: recipient.source
        },
        idempotency_key: key,
        correlation_id: args.correlation_id ?? null
      },
      c as any
    );
    return { result, event_type: eventType, idempotency_key: key, channel: recipient.channel };
  });
  if (guarded.ok) return guarded.value;
  return { result: "error", event_type: eventType, idempotency_key: null, channel: null, reason: guarded.error };
}

// ── Admin security alert ─────────────────────────────────────────────────────

/**
 * `alert_key` is the durable identity of the underlying security fact
 * (e.g. an operational case auto_key, a webhook-signature failure bucket).
 * The alert carries a title and a reference — never the raw payload.
 */
export async function enqueueAdminSecurityAlert(
  c: Queryable,
  args: { alert_key: string; alert_title: string; alert_ref?: string | null; correlation_id?: string | null; env?: NodeJS.ProcessEnv }
): Promise<EnqueueOutcome> {
  const guarded = await withNotificationSavepoint(c, async (): Promise<EnqueueOutcome> => {
    const recipient = resolveAdminNotificationRecipient(args.env || process.env);
    const key = notificationIdentity("admin_security_alert", "admin", [args.alert_key.slice(0, 160)], recipient.channel);
    const result = await enqueueNotification(
      {
        event_type: "admin_security_alert",
        recipient_type: "admin",
        recipient_ref: recipient.recipient_ref,
        channel: recipient.channel,
        payload_jsonb: {
          alert_title: sanitizeSellerFacingReason(args.alert_title) || "התראה תפעולית",
          alert_ref: sanitizeSellerFacingReason(args.alert_ref || ""),
          recipient_source: recipient.source
        },
        idempotency_key: key,
        correlation_id: args.correlation_id ?? null
      },
      c as any
    );
    return { result, event_type: "admin_security_alert", idempotency_key: key, channel: recipient.channel };
  });
  if (guarded.ok) return guarded.value;
  return { result: "error", event_type: "admin_security_alert", idempotency_key: null, channel: null, reason: guarded.error };
}
