// ── Centralized presentation for every user-visible message ────────────────
// No raw provider/backend/browser message may reach a normal user. Errors are
// translated by code / status / pattern here, in ONE place, with a safe
// generic fallback. Technical identifiers stay English only inside genuinely
// internal admin/debug contexts.
//
// Every map below holds a TRANSLATION KEY, not copy: these are module-level
// constants, so storing resolved text would freeze the language chosen at
// import time and survive every later language switch.
import { getLocale, t } from "./i18n";

export interface ApiErrorLike {
  status?: number;
  message?: string;
  body?: { code?: string; error?: string; message?: string };
}

export const CODE_MESSAGE_KEYS: Record<string, string> = {
  // product / canonical API codes
  max_units_exceeded: "errors.code.max_units_exceeded",
  seller_auth_invalid_credentials: "errors.code.seller_auth_invalid_credentials",
  SELLER_AUTH_INVALID_CREDENTIALS: "errors.code.seller_auth_invalid_credentials",
  seller_auth_blocked: "errors.code.seller_auth_blocked",
  seller_context_switch_disabled: "errors.code.seller_context_switch_disabled",
  authentication_required: "errors.code.authentication_required",
  invalid_token: "errors.code.invalid_token",
  deal_not_found: "errors.code.deal_not_found",
  support_rate_limited: "errors.code.support_rate_limited",
  deal_delete_not_allowed: "errors.code.deal_delete_not_allowed",
  seller_terms_required: "errors.code.seller_terms_required",
  seller_profile_incomplete: "errors.code.seller_profile_incomplete",
  seller_kyc_not_approved: "errors.code.seller_kyc_not_approved",
  list_price_invalid: "errors.code.list_price_invalid",
  DEAL_NOT_EDITABLE: "errors.code.deal_not_editable",
  DRAFT_EDITOR_STALE: "errors.code.draft_editor_stale",
  deadline_below_minimum: "errors.code.deadline_below_minimum",
  deadline_above_maximum: "errors.code.deadline_above_maximum",
  deadline_invalid: "errors.code.deadline_invalid",
  description_too_long: "errors.code.description_too_long",
  description_short_too_long: "errors.code.description_short_too_long",
  title_required: "errors.code.title_required",
  title_too_long: "errors.code.title_too_long",
  price_invalid: "errors.code.price_invalid",
  min_units_invalid: "errors.code.min_units_invalid",
  max_units_invalid: "errors.code.max_units_invalid",
  delivery_options_invalid: "errors.code.delivery_options_invalid",
  deal_image_limit: "errors.code.deal_image_limit",
  deal_already_published: "errors.code.deal_already_published",
  SELLER_RESTRICTED: "errors.code.seller_restricted",
  SELLER_SUSPENDED: "errors.code.seller_suspended",
  SELLER_BANNED: "errors.code.seller_banned",
  contact_name_required: "errors.code.contact_name_required",
  contact_email_invalid: "errors.code.contact_email_invalid",
  contact_message_too_short: "errors.code.contact_message_too_short",
  contact_message_too_long: "errors.code.contact_message_too_long",
  contact_category_invalid: "errors.code.contact_category_invalid",
  rate_limit_exceeded: "errors.code.rate_limit_exceeded",
  // P0.3 — pause/reopen joining
  deal_not_open_for_joining: "errors.code.deal_not_open_for_joining",
  deal_not_paused: "errors.code.deal_not_paused",
  deal_reopen_not_allowed: "errors.code.deal_reopen_not_allowed",
  deal_reopen_deadline_passed: "errors.code.deal_reopen_deadline_passed",
  deal_reopen_capacity_full: "errors.code.deal_reopen_capacity_full",
  // LAUNCH POLISH — the server's state-machine refusal (the deal is no longer
  // in the state the action requires). Cancel has its own, more specific copy.
  STATE_CONFLICT: "errors.code.state_conflict",
  // P0.3 — chat
  chat_closed: "errors.code.chat_closed",
  chat_reply_target_not_found: "errors.code.chat_reply_target_not_found",
  invalid_reaction: "errors.code.invalid_reaction",
  reaction_identity_required: "errors.code.reaction_identity_required",
  // P0.3 — join payment method
  payment_method_invalid: "errors.code.payment_method_invalid",
  // P0.3 — business profile
  business_profile_email_invalid: "errors.code.business_profile_email_invalid",
  bank_account_invalid: "errors.code.bank_account_invalid",
  // P0.7 — internal inquiries + pickup readiness
  inquiry_name_required: "errors.code.inquiry_name_required",
  inquiry_email_invalid: "errors.code.inquiry_email_invalid",
  inquiry_message_too_short: "errors.code.inquiry_message_too_short",
  inquiry_message_too_long: "errors.code.inquiry_message_too_long",
  inquiry_rate_limited: "errors.code.inquiry_rate_limited",
  inquiry_deal_unavailable: "errors.code.inquiry_deal_unavailable",
  inquiry_not_found: "errors.code.inquiry_not_found",
  pickup_location_required: "errors.code.pickup_location_required",
  // LAUNCH POLISH 2 — buyer join refusals answered in product Hebrew (the
  // canonical codes stay internal; the buyer reads what happened + what to do)
  joining_paused_by_admin: "errors.code.joining_paused_by_admin",
  delivery_address_required: "errors.code.delivery_address_required",
  invalid_delivery_option: "errors.code.invalid_delivery_option",
  payment_disclosure_required: "errors.code.payment_disclosure_required",
  payment_authorization_required: "errors.code.payment_authorization_required",
  payment_authorization_expired: "errors.code.payment_authorization_expired",
  payment_authorization_not_consumable: "errors.code.payment_authorization_not_consumable",
  delivery_notes_too_long: "errors.code.delivery_notes_too_long",
  // LAUNCH POLISH 2 — buyer feedback
  feedback_category_invalid: "errors.code.feedback_category_invalid",
  feedback_text_too_long: "errors.code.feedback_text_too_long",
  feedback_rate_limited: "errors.code.feedback_rate_limited",
  feedback_deal_unavailable: "errors.code.feedback_deal_unavailable",
  // LAUNCH SPRINT 3 — physical pickup handoff (seller side)
  pickup_code_not_found: "errors.code.pickup_code_not_found",
  pickup_code_ambiguous: "errors.code.pickup_code_ambiguous",
  fulfillment_not_ready: "errors.code.fulfillment_not_ready",
  fulfillment_qty_mismatch: "errors.code.fulfillment_qty_mismatch",
  fulfillment_expected_qty_invalid: "errors.code.fulfillment_expected_qty_invalid",
  fulfillment_not_physical: "errors.code.fulfillment_not_physical",
  deal_not_completed: "errors.code.deal_not_completed",
  // SITE CMS
  content_changed_reload: "errors.code.content_changed_reload",
  no_draft_to_publish: "errors.code.no_draft_to_publish",
  draft_invalid: "errors.code.draft_invalid",
  content_html_not_allowed: "errors.code.content_html_not_allowed",
  invalid_content_length: "errors.code.invalid_content_length",
  invalid_content_link: "errors.code.invalid_content_link",
  invalid_content_image: "errors.code.invalid_content_image",
  invalid_content_video: "errors.code.invalid_content_video",
  required_field_missing: "errors.code.required_field_missing",
  invalid_video_mime: "errors.code.invalid_video_mime",
  invalid_video_content: "errors.code.invalid_video_content",
  video_too_large: "errors.code.video_too_large"
};

const PATTERN_MESSAGE_KEYS: [RegExp, string][] = [
  // LAUNCH POLISH 2 — the join route's code-less refusals (409 "deal is not
  // open for joining", inventory exhaustion, missing buyer id)
  [/not open for joining/i, "errors.pattern.not_open_for_joining"],
  [/exceeds available inventory|inventory_exhausted/i, "errors.pattern.inventory_exhausted"],
  [/buyer_id required/i, "errors.pattern.buyer_id_required"],
  [/tracking_token_required/i, "errors.pattern.tracking_token_required"],
  [/invalid login credentials|invalid credentials|invalid grant/i, "errors.pattern.invalid_credentials"],
  [/not confirmed/i, "errors.pattern.email_not_confirmed"],
  [/already registered|already exists/i, "errors.pattern.already_registered"],
  [/rate limit|too many requests/i, "errors.pattern.rate_limited"],
  [/password should be at least|weak password/i, "errors.pattern.weak_password"],
  [/unable to validate email|invalid email/i, "errors.pattern.invalid_email"],
  [/failed to fetch|networkerror|network error|load failed/i, "errors.pattern.network"],
  [/unauthorized|forbidden/i, "errors.pattern.forbidden"],
  [/timeout|timed out/i, "errors.pattern.timeout"],
];

const STATUS_MESSAGE_KEYS: Record<number, string> = {
  400: "errors.status.400",
  401: "errors.status.401",
  403: "errors.status.403",
  404: "errors.status.404",
  409: "errors.status.409",
  413: "errors.status.413",
  423: "errors.status.423",
  429: "errors.status.429",
  500: "errors.status.500",
  502: "errors.status.502",
  503: "errors.status.503",
};

export const GENERIC_ERROR_KEY = "errors.generic";

/** The fallback copy, resolved in the active language. */
export function genericError(): string { return t(GENERIC_ERROR_KEY); }

// A message already written in the ACTIVE language is product copy, not a raw
// provider string, and is shown as-is. In Hebrew that means Hebrew letters; in
// English it means a message the server already localised for this locale, and
// an English-locale user must NOT be shown a Hebrew provider string, so the
// Hebrew shape is only trusted while Hebrew is the active language.
function looksLocalized(text: string): boolean {
  const hebrew = /[\u0590-\u05FF]/.test(text);
  return getLocale() === "he" ? hebrew : false;
}

/**
 * Turn any thrown/returned API error into one sentence in the active
 * language. `fallback` is already-resolved copy (call sites pass `t(...)`);
 * it defaults to the generic message resolved at CALL time, never at import.
 */
export function localizedError(err: unknown, fallback?: string): string {
  const e = (err || {}) as ApiErrorLike & { message?: string };
  const code = String(e.body?.code || e.body?.error || "").trim();
  const codeKey = code ? CODE_MESSAGE_KEYS[code] : undefined;
  if (codeKey) return t(codeKey);
  const candidates = [e.body?.message, e.message].map((m) => String(m || "").trim()).filter(Boolean);
  for (const msg of candidates) {
    if (looksLocalized(msg)) return msg;
    for (const [re, key] of PATTERN_MESSAGE_KEYS) if (re.test(msg)) return t(key);
  }
  if (typeof e.status === "number" && STATUS_MESSAGE_KEYS[e.status]) return t(STATUS_MESSAGE_KEYS[e.status]!);
  return fallback ?? genericError();
}
