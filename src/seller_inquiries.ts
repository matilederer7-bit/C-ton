// P0.7 — internal buyer → seller inquiries: shared helpers for the Web runtime.
//
// The authoritative conversation lives in siton.seller_inquiry_threads /
// siton.seller_inquiry_messages (migration 061). Sellers are only NOTIFIED by
// the canonical notification rail that a new inquiry exists — the e-mail is a
// pointer back into the product, never the conversation itself. Nothing here
// sends anything: enqueueNotification writes a notification_events row that
// the Worker hands to the configured provider (log-only in staging; a real
// e-mail adapter does not exist in this repository).

import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { assertRequiredTables } from "./schema_contract.js";
import { enqueueNotification } from "./notification_dispatch.js";

type WithTx = <T>(fn: (c: any) => Promise<T>) => Promise<T>;

export const INQUIRY_BRAND = "C-ton";
export const INQUIRY_NAME_MAX = 120;
export const INQUIRY_EMAIL_MAX = 200;
export const INQUIRY_MESSAGE_MIN = 3;
export const INQUIRY_MESSAGE_MAX = 2000;
export const INQUIRY_PREVIEW_MAX = 140;
export const INQUIRY_LIMITS = Object.freeze({
  per_customer_per_hour: 5,
  per_deal_per_hour: 40,
  global_per_hour: 200,
  duplicate_window_minutes: 10
});

export const INQUIRY_TABLES = ["seller_inquiry_threads", "seller_inquiry_messages"] as const;

export async function ensureSellerInquiryTables(withTx: WithTx) {
  await withTx(async (c) => assertRequiredTables(c, [...INQUIRY_TABLES]));
}

/**
 * Server-side normalization for buyer/seller text: control characters go
 * (newlines survive for multi-line messages), angle brackets are dropped so a
 * stored body can never carry markup, whitespace is collapsed per line, runs
 * of blank lines are bounded, and the result is length-capped.
 */
export function normalizeInquiryText(value: unknown, maxLength: number): string {
  const raw = String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ")
    .replace(/[<>]/g, "");
  const lines = raw.split("\n").map((line) => line.replace(/[ \t\u00a0]+/g, " ").trim());
  const collapsed = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return collapsed.slice(0, maxLength).trim();
}

export function normalizeInquiryEmail(value: unknown): string | null {
  const email = String(value ?? "").trim().toLowerCase().slice(0, INQUIRY_EMAIL_MAX);
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}$/.test(email)) return null;
  return email;
}

/** m***@domain — the seller sees who is asking without a copy-pasteable address. */
export function maskEmail(email: unknown): string {
  const value = String(email ?? "").trim();
  const at = value.indexOf("@");
  if (at <= 0) return value ? "***" : "";
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  return `${local.slice(0, 1)}***@${domain}`;
}

export function inquiryBodyHash(body: string): string {
  return createHash("sha256").update(`seller-inquiry:${body}`).digest("hex");
}

export function inquiryPreview(body: string): string {
  return body.replace(/\s+/g, " ").trim().slice(0, INQUIRY_PREVIEW_MAX);
}

export function hashCustomerAccessToken(token: string): string {
  return createHash("sha256").update(`inquiry-access:${token}`).digest("hex");
}

export function mintCustomerAccessToken(): { token: string; hash: string } {
  const token = randomBytes(24).toString("base64url");
  return { token, hash: hashCustomerAccessToken(token) };
}

export function verifyCustomerAccessToken(token: unknown, storedHash: unknown): boolean {
  const raw = String(token ?? "").trim();
  const expected = String(storedHash ?? "").trim();
  if (!raw || !expected || raw.length > 200) return false;
  const provided = Buffer.from(hashCustomerAccessToken(raw), "hex");
  const stored = Buffer.from(expected, "hex");
  return provided.length === stored.length && provided.length > 0 && timingSafeEqual(provided, stored);
}

/** The public origin of this deployment, for deep links back into the product. */
export function publicOrigin(req: any): string {
  const proto = String(req?.headers?.["x-forwarded-proto"] || "").split(",")[0]!.trim();
  const host = String(req?.headers?.["x-forwarded-host"] || req?.headers?.host || "").split(",")[0]!.trim();
  const configured = String(process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || "").trim().replace(/\/+$/, "");
  if (configured) return configured;
  if (host) return `${proto || "https"}://${host}`;
  return "";
}

export function sellerInquiryDeepLink(origin: string, threadId: string): string {
  return `${origin}/preview/#/seller/inquiries/${threadId}`;
}

export type SellerNotificationRecipient = {
  channel: "email" | "internal";
  recipient_ref: string;
  source: "support_email" | "login_email" | "business_profile_contact_email" | "none";
};

/**
 * Where the seller's "you have a new inquiry" pointer goes. Resolved from the
 * seller's OWN account data server-side — never from the request.
 */
export async function resolveSellerNotificationRecipient(c: any, sellerId: string): Promise<SellerNotificationRecipient> {
  const row = await c.query(
    `SELECT NULLIF(btrim(COALESCE(sa.support_email, '')), '') AS support_email,
            NULLIF(btrim(COALESCE(sa.login_email, '')), '') AS login_email,
            NULLIF(btrim(COALESCE(bp.contact_email, '')), '') AS contact_email
     FROM siton.seller_accounts sa
     LEFT JOIN siton.seller_business_profiles bp ON bp.seller_id = sa.seller_id
     WHERE sa.seller_id = $1
     LIMIT 1`,
    [sellerId]
  );
  const profile = row.rows[0] || {};
  if (profile.support_email) return { channel: "email", recipient_ref: String(profile.support_email), source: "support_email" };
  if (profile.login_email) return { channel: "email", recipient_ref: String(profile.login_email), source: "login_email" };
  if (profile.contact_email) return { channel: "email", recipient_ref: String(profile.contact_email), source: "business_profile_contact_email" };
  return { channel: "internal", recipient_ref: sellerId, source: "none" };
}

/**
 * Enqueue exactly ONE seller pointer notification per triggering customer
 * message (idempotency key carries the message id, and retried submissions
 * dedupe to the same message before ever reaching here).
 */
export async function enqueueSellerInquiryNotification(c: any, args: {
  sellerId: string;
  dealId: string;
  dealTitle: string;
  threadId: string;
  messageId: string;
  origin: string;
}): Promise<{ result: "queued" | "duplicate"; recipient: SellerNotificationRecipient; inquiry_url: string }> {
  const recipient = await resolveSellerNotificationRecipient(c, args.sellerId);
  const inquiryUrl = sellerInquiryDeepLink(args.origin, args.threadId);
  const result = await enqueueNotification({
    event_type: "seller_customer_inquiry",
    recipient_type: "seller",
    recipient_ref: recipient.recipient_ref,
    deal_id: args.dealId,
    seller_id: args.sellerId,
    channel: recipient.channel,
    payload_jsonb: {
      deal_id: args.dealId,
      deal_title: args.dealTitle,
      thread_id: args.threadId,
      inquiry_url: inquiryUrl
    },
    idempotency_key: `seller_customer_inquiry:seller:${args.sellerId}:${args.threadId}:${args.messageId}:${recipient.channel}`,
    correlation_id: `inquiry:${args.threadId}`
  }, c);
  return { result, recipient, inquiry_url: inquiryUrl };
}
