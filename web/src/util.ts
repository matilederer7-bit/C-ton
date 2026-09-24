// Locale-aware formatting + canonical state views for the Siton product
// surfaces. Money, counts and dates follow the ACTIVE locale; the currency
// itself is always ILS, in both languages, because the money is the same money.
import { getLocale, intlTagOf, t } from "./i18n/index.js";

export function ils(value: unknown): string {
  const n = Number(value || 0);
  return new Intl.NumberFormat(intlTagOf(getLocale()), { style: "currency", currency: "ILS", maximumFractionDigits: n % 1 === 0 ? 0 : 2 }).format(n);
}

export function num(value: unknown): string {
  return new Intl.NumberFormat(intlTagOf(getLocale())).format(Number(value || 0));
}

export function pct(ratio: unknown): string {
  return `${Math.round(Number(ratio || 0) * 100)}%`;
}

export function dealTypeLabel(type: string): string {
  switch (type) {
    case "voucher": return t("util.voucher");
    case "ticket": return t("util.ticket");
    default: return t("util.product");
  }
}

// MATURE UI (Issue #39, item 2): the image placeholder is the deal type spelled
// out, styled by `.sd-thumb`/`.placeholder`, not a gift/ticket/parcel emoji.
// `dealTypeIcon` is gone; call sites use `dealTypeLabel` directly.

// Canonical deal-state labels (all nine states). The map holds translation
// KEYS, never resolved copy: a module-level constant is evaluated once at
// import and would otherwise freeze the language chosen at boot.
export const DEAL_STATE_LABEL_KEYS: Record<string, string> = {
  Draft: "util.state.draft",
  PendingTarget: "util.state.pending_target",
  TargetReached: "util.state.target_reached",
  ClosedForJoining: "util.state.closed_for_joining",
  ReadyForCharging: "util.state.ready_for_charging",
  Charging: "util.state.charging",
  CompletionWindow: "util.state.completion_window",
  Completed: "util.state.completed",
  Failed: "util.state.failed",
  Cancelled: "util.state.cancelled"
};

export function stateLabel(state: string): string {
  const key = DEAL_STATE_LABEL_KEYS[state];
  return key ? t(key) : state;
}

// Buyer money-state → product Hebrew (presentation only; canonical backend
// state names stay untouched underneath).
export const MONEY_STATE_LABEL_KEYS: Record<string, string> = {
  AuthCaptured: "util.money.auth_captured",
  ChargedSuccess: "util.money.charged_success",
  RecoveredCharge: "util.money.recovered_charge",
  ChargeFailedRecovery: "util.money.charge_failed_recovery",
  ChargeFailedFinal: "util.money.charge_failed_final",
  AuthReleased: "util.money.auth_released",
  Refunded: "util.money.refunded"
};

export function moneyStateLabel(state: string): string {
  const key = MONEY_STATE_LABEL_KEYS[state];
  return key ? t(key) : state;
}

// Buyer participation state → product Hebrew (presentation only).
export const BUYER_STATE_LABEL_KEYS: Record<string, string> = {
  Joined: "util.buyer.joined",
  Active: "util.buyer.active",
  Locked: "util.buyer.locked",
  Charged: "util.buyer.charged",
  ChargeFailedCompletion: "util.buyer.charge_failed_completion",
  Completed: "util.buyer.completed",
  Dropped: "util.buyer.dropped",
  DealFailed: "util.buyer.deal_failed"
};

export function buyerStateLabel(state: string): string {
  const key = BUYER_STATE_LABEL_KEYS[state];
  return key ? t(key) : state;
}

// Notification delivery status (admin surface).
export const NOTIFICATION_STATUS_LABEL_KEYS: Record<string, string> = {
  sent: "util.notify.sent",
  pending: "util.notify.pending",
  processing: "util.notify.processing",
  failed: "util.notify.failed",
  skipped: "util.notify.skipped",
  cancelled: "util.notify.cancelled",
  blocked: "util.notify.blocked"
};

export function notificationStatusLabel(status: string): string {
  const key = NOTIFICATION_STATUS_LABEL_KEYS[status];
  return key ? t(key) : status;
}

// Buyer-facing status story for the public deal page.
export function buyerStateStory(state: string, unitsToTarget: number): string {
  switch (state) {
    case "PendingTarget":
      return unitsToTarget > 0
        ? t("util.unitstotarget_more_units_deal_go", { unitsToTarget: num(unitsToTarget) })
        : t("util.just_short_target");
    case "TargetReached": return t("util.the_minimum_reached_deal_going");
    case "ClosedForJoining": return t("util.the_list_closed_preparing_close");
    case "ReadyForCharging": return t("util.the_deal_locked_charges_starting");
    case "Charging": return t("util.the_charges_being_made_now");
    case "CompletionWindow": return t("util.the_completion_window_open");
    case "Completed": return t("util.the_deal_completed_successfully");
    case "Failed": return t("util.the_deal_did_complete_authorizations");
    case "Cancelled": return t("util.the_deal_cancelled_seller");
    default: return stateLabel(state);
  }
}

export const OPEN_STATES = ["PendingTarget", "TargetReached"];
export const URGENT_SELLER_STATES = ["CompletionWindow", "Charging", "ReadyForCharging"];
export const CLOSED_STATES = ["Completed", "Failed", "Cancelled"];

export interface CountdownView {
  text: string;
  tone: "ok" | "warn" | "danger" | "over";
  ms: number;
}

// Exact-time countdown per the seller UX spec: no rounded days under 24h,
// tone by remaining time (>12h ok, 1-12h warn, <1h danger).
export function countdownView(deadline: string | null | undefined, now = Date.now()): CountdownView | null {
  if (!deadline) return null;
  const target = Date.parse(String(deadline));
  if (!Number.isFinite(target)) return null;
  const ms = target - now;
  if (ms <= 0) return { text: t("util.ended"), tone: "over", ms };
  const totalMinutes = Math.floor(ms / 60000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  let text: string;
  if (days >= 1) text = t("util.days_d_hours_h", { days: days, hours: hours });
  else if (hours >= 1) text = t("util.hours_v1_hours", { hours: hours, v1: String(minutes).padStart(2, "0") });
  else text = t("util.minutes_min", { minutes: minutes });
  const tone: CountdownView["tone"] = ms < 3600_000 ? "danger" : ms < 12 * 3600_000 ? "warn" : "ok";
  return { text, tone, ms };
}

export function timeAgo(iso: string, now = Date.now()): string {
  const dt = Date.parse(iso);
  if (!Number.isFinite(dt)) return "";
  const s = Math.max(0, Math.floor((now - dt) / 1000));
  if (s < 60) return t("util.just_now");
  const m = Math.floor(s / 60);
  if (m < 60) return t("util.m_min_ago", { m: m });
  const h = Math.floor(m / 60);
  if (h < 24) return t("util.h_h_ago", { h: h });
  const d = Math.floor(h / 24);
  return t("util.d_days_ago", { d: d });
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const dt = Date.parse(String(iso));
  if (!Number.isFinite(dt)) return "—";
  return new Intl.DateTimeFormat(intlTagOf(getLocale()), { dateStyle: "short", timeStyle: "short" }).format(dt);
}

export function failReason(deal: { state: string; joined_units?: number; threshold_units?: number }): string {
  if (deal.state !== "Failed") return "";
  const joined = Number(deal.joined_units || 0);
  const threshold = Number(deal.threshold_units || 0);
  if (joined < threshold) return t("util.the_minimum_reached");
  return t("util.the_charges_did_complete");
}

export function initialOf(name: string): string {
  const s = String(name || "").trim();
  return s ? s[0]! : t("util.seller_initial_fallback");
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

// ── Israel-time deadline helpers (P0.2-F) ──────────────────────────────────
// The seller picks a calendar date + exact hour:minute in ISRAEL time; the
// canonical stored value is UTC ISO. DST-aware via a two-pass offset
// resolution against the IANA zone (no hardcoded offsets).
const ISRAEL_TZ = "Asia/Jerusalem";

function israelOffsetMs(utcMs: number): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: ISRAEL_TZ, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit"
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(new Date(utcMs))) parts[p.type] = p.value;
  const asUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour) % 24, Number(parts.minute), Number(parts.second)
  );
  return asUtc - utcMs;
}

// "2026-09-03" + "20:30" (wall-clock Israel) → UTC ISO string, or null.
export function israelPartsToUtcIso(dateStr: string, timeStr: string): string | null {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || "").trim());
  const tm = /^(\d{1,2}):(\d{2})$/.exec(String(timeStr || "").trim());
  if (!dm || !tm) return null;
  const wallUtc = Date.UTC(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3]), Number(tm[1]), Number(tm[2]));
  // two passes converge across DST boundaries
  let utc = wallUtc - israelOffsetMs(wallUtc);
  utc = wallUtc - israelOffsetMs(utc);
  return new Date(utc).toISOString();
}

// Human confirmation: "יום חמישי, 3 בספטמבר, 20:30 (שעון ישראל)"
export function formatIsraelDateTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const dt = Date.parse(String(iso));
  if (!Number.isFinite(dt)) return "";
  const text = new Intl.DateTimeFormat(intlTagOf(getLocale()), {
    timeZone: ISRAEL_TZ, weekday: "long", day: "numeric", month: "long",
    hour: "2-digit", minute: "2-digit"
  }).format(dt);
  return t("util.israel_time_suffix", { text });
}

// Split a UTC ISO back into Israel-local date/time input values.
export function utcIsoToIsraelParts(iso: string | null | undefined): { date: string; time: string } {
  const dt = Date.parse(String(iso || ""));
  if (!Number.isFinite(dt)) return { date: "", time: "" };
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone: ISRAEL_TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(new Date(dt))) parts[p.type] = p.value;
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${String(Number(parts.hour) % 24).padStart(2, "0")}:${parts.minute}` };
}

// Daylight progress story (2026-09-24 visual refresh): the group meter fills in
// Siton Indigo while the group is forming, its LEADING EDGE warms into Siton
// Coral as the group closes in on the target (the deal "heating up"), and it
// turns success green once the target is reached. Presentation only — the
// ratio it receives and the width it sits in are unchanged.
export function progressColor(ratioToTarget: number): string {
  const r = clamp(ratioToTarget, 0, 1);
  if (r >= 1) return "linear-gradient(90deg, #0e9467, #19b27c)";
  if (r < 0.6) return "linear-gradient(90deg, #4a3aff, #6d5dff)";
  // 0.6 → 1: the coral share of the leading edge GROWS with the ratio — the
  // violet stop recedes from 95% to 55%, so coral spans 5% → 45% of the fill
  const warm = Math.round(95 - (r - 0.6) * 100); // 95% → 55%
  return `linear-gradient(90deg, #4a3aff, #7b5cff ${warm}%, #ff5a36)`;
}
