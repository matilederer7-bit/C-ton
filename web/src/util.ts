// Hebrew formatting + canonical state views for the Siton product surfaces.

export function ils(value: unknown): string {
  const n = Number(value || 0);
  return new Intl.NumberFormat("he-IL", { style: "currency", currency: "ILS", maximumFractionDigits: n % 1 === 0 ? 0 : 2 }).format(n);
}

export function num(value: unknown): string {
  return new Intl.NumberFormat("he-IL").format(Number(value || 0));
}

export function pct(ratio: unknown): string {
  return `${Math.round(Number(ratio || 0) * 100)}%`;
}

export function dealTypeLabel(type: string): string {
  switch (type) {
    case "voucher": return "שובר";
    case "ticket": return "כרטיס";
    default: return "מוצר";
  }
}

export function dealTypeIcon(type: string): string {
  switch (type) {
    case "voucher": return "🎁";
    case "ticket": return "🎟️";
    default: return "📦";
  }
}

// Canonical deal-state Hebrew labels (all nine states).
export const DEAL_STATE_LABELS: Record<string, string> = {
  Draft: "טיוטה",
  PendingTarget: "ממתינים למינימום",
  TargetReached: "המינימום הושג",
  ClosedForJoining: "סגורה להצטרפות",
  ReadyForCharging: "נעולה לחיוב",
  Charging: "מתבצעים חיובים",
  CompletionWindow: "חלון השלמה",
  Completed: "הושלמה בהצלחה",
  Failed: "לא הושלמה",
  Cancelled: "בוטלה"
};

export function stateLabel(state: string): string {
  return DEAL_STATE_LABELS[state] || state;
}

// Buyer money-state → product Hebrew (presentation only; canonical backend
// state names stay untouched underneath).
export const MONEY_STATE_LABELS: Record<string, string> = {
  AuthCaptured: "מסגרת נתפסה",
  ChargedSuccess: "חויב בהצלחה",
  RecoveredCharge: "חויב בהצלחה (אחרי השלמה)",
  ChargeFailedRecovery: "ממתין לעדכון אשראי",
  ChargeFailedFinal: "חיוב נכשל סופית",
  AuthReleased: "המסגרת שוחררה",
  Refunded: "הוחזר"
};

export function moneyStateLabel(state: string): string {
  return MONEY_STATE_LABELS[state] || state;
}

// Buyer participation state → product Hebrew (presentation only).
export const BUYER_STATE_LABELS: Record<string, string> = {
  Joined: "הצטרף/ה",
  Active: "פעיל/ה",
  Locked: "נעול לחיוב",
  Charged: "חויב/ה",
  ChargeFailedCompletion: "בהשלמת תשלום",
  Completed: "הושלם",
  Dropped: "נשר/ה",
  DealFailed: "העסקה לא הושלמה"
};

export function buyerStateLabel(state: string): string {
  return BUYER_STATE_LABELS[state] || state;
}

// Notification delivery status → Hebrew (admin surface).
export const NOTIFICATION_STATUS_LABELS: Record<string, string> = {
  sent: "נשלחה",
  pending: "ממתינה",
  processing: "בשליחה",
  failed: "נכשלה",
  skipped: "דולגה",
  cancelled: "בוטלה",
  blocked: "נחסמה (בטיחות)"
};

// Buyer-facing status story for the public deal page.
export function buyerStateStory(state: string, unitsToTarget: number): string {
  switch (state) {
    case "PendingTarget":
      return unitsToTarget > 0
        ? `עוד ${num(unitsToTarget)} יחידות כדי שהעסקה תצא לפועל`
        : "רגע לפני היעד…";
    case "TargetReached": return "המינימום הושג — העסקה יוצאת לפועל!";
    case "ClosedForJoining": return "הרשימה נסגרה — מתכוננים לסגירה";
    case "ReadyForCharging": return "העסקה ננעלה — מתחילים חיובים";
    case "Charging": return "החיובים מתבצעים כעת";
    case "CompletionWindow": return "חלון השלמה פתוח";
    case "Completed": return "העסקה הושלמה בהצלחה";
    case "Failed": return "העסקה לא הושלמה — המסגרות שוחררו";
    case "Cancelled": return "העסקה בוטלה על ידי המוכר";
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
  if (ms <= 0) return { text: "הסתיים", tone: "over", ms };
  const totalMinutes = Math.floor(ms / 60000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  let text: string;
  if (days >= 1) text = `${days} ימים ${hours} שע׳`;
  else if (hours >= 1) text = `${hours}:${String(minutes).padStart(2, "0")} שעות`;
  else text = `${minutes} דק׳`;
  const tone: CountdownView["tone"] = ms < 3600_000 ? "danger" : ms < 12 * 3600_000 ? "warn" : "ok";
  return { text, tone, ms };
}

export function timeAgo(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return "עכשיו";
  const m = Math.floor(s / 60);
  if (m < 60) return `לפני ${m} דק׳`;
  const h = Math.floor(m / 60);
  if (h < 24) return `לפני ${h} שע׳`;
  const d = Math.floor(h / 24);
  return `לפני ${d} ימים`;
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = Date.parse(String(iso));
  if (!Number.isFinite(t)) return "—";
  return new Intl.DateTimeFormat("he-IL", { dateStyle: "short", timeStyle: "short" }).format(t);
}

export function failReason(deal: { state: string; joined_units?: number; threshold_units?: number }): string {
  if (deal.state !== "Failed") return "";
  const joined = Number(deal.joined_units || 0);
  const threshold = Number(deal.threshold_units || 0);
  if (joined < threshold) return "לא הגיעה למינימום";
  return "חיובים לא הושלמו";
}

export function initialOf(name: string): string {
  const s = String(name || "").trim();
  return s ? s[0]! : "מ";
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
  const t = Date.parse(String(iso));
  if (!Number.isFinite(t)) return "";
  const text = new Intl.DateTimeFormat("he-IL", {
    timeZone: ISRAEL_TZ, weekday: "long", day: "numeric", month: "long",
    hour: "2-digit", minute: "2-digit"
  }).format(t);
  return `${text} (שעון ישראל)`;
}

// Split a UTC ISO back into Israel-local date/time input values.
export function utcIsoToIsraelParts(iso: string | null | undefined): { date: string; time: string } {
  const t = Date.parse(String(iso || ""));
  if (!Number.isFinite(t)) return { date: "", time: "" };
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone: ISRAEL_TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(new Date(t))) parts[p.type] = p.value;
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${String(Number(parts.hour) % 24).padStart(2, "0")}:${parts.minute}` };
}

// Warm→cyan progress story (P0.3 palette): hot commercial orange far from the
// minimum, easing into the single premium cyan accent as the group closes in.
export function progressColor(ratioToTarget: number): string {
  const r = clamp(ratioToTarget, 0, 1);
  if (r >= 1) return "linear-gradient(90deg, #45b9c9, #6fd3e0)";
  // Warm commercial orange deepening to amber; the hue never wanders into
  // green — near the target only the LEADING EDGE cools into the single cyan
  // accent (sRGB gradient blend, which passes through neutral, not green).
  const hue = Math.round(18 + r * 20); // 18 (hot orange) → 38 (amber)
  const sat = Math.round(82 - r * 10);
  const base = `hsl(${hue} ${sat}% 50%)`;
  if (r < 0.75) return `linear-gradient(90deg, ${base}, hsl(${hue + 6} ${Math.max(60, sat - 4)}% 55%))`;
  return `linear-gradient(90deg, ${base}, #6fd3e0)`;
}
