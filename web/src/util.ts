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

// Warm→green progress color story (spec: hotter far from minimum, gradually
// green as the group approaches the target).
export function progressColor(ratioToTarget: number): string {
  const r = clamp(ratioToTarget, 0, 1);
  if (r >= 1) return "linear-gradient(90deg, #178f46, #2fbf6b)";
  // hue 24 (hot orange) → 152 (green)
  const hue = Math.round(24 + r * 118);
  const hue2 = Math.round(hue + 12);
  return `linear-gradient(90deg, hsl(${hue} 78% 48%), hsl(${hue2} 70% 52%))`;
}
