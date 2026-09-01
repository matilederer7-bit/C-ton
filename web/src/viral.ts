// Browser-side attribution capture for the Siton commerce viral graph.
//
// Captures ?ref= share codes into a BOUNDED local history (first touch, last
// touch, and up to 8 recent touches), mints opaque anonymous visitor/session
// ids, and reports PII-free funnel events. These values are HINTS only — the
// server resolves final attribution authoritatively at Join time and never
// treats client values as database ids.

const STORE_KEY = "siton_viral_v1";
const SESSION_KEY = "siton_session_v1";
const MAX_TOUCHES = 8;
const MAX_AGE_MS = 90 * 24 * 3600_000; // bounded retention: 90 days

interface Touch { code: string; at: string }
interface ViralStore { visitor_id: string; first?: Touch; last?: Touch; touches: Touch[] }

function randomId(prefix: string): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `${prefix}_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function readStore(): ViralStore {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as ViralStore;
      if (parsed && typeof parsed.visitor_id === "string") {
        parsed.touches = Array.isArray(parsed.touches) ? parsed.touches.slice(0, MAX_TOUCHES) : [];
        return parsed;
      }
    }
  } catch { /* storage unavailable or corrupt — fall through */ }
  return { visitor_id: randomId("v"), touches: [] };
}

function writeStore(store: ViralStore): void {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch { /* best effort */ }
}

export function sessionId(): string {
  try {
    let sid = sessionStorage.getItem(SESSION_KEY);
    if (!sid) {
      sid = randomId("s");
      sessionStorage.setItem(SESSION_KEY, sid);
    }
    return sid;
  } catch {
    return randomId("s");
  }
}

export function visitorId(): string {
  const store = readStore();
  writeStore(store);
  return store.visitor_id;
}

function sanitizeCode(raw: unknown): string {
  return String(raw || "").trim().slice(0, 120);
}

function expireOld(store: ViralStore): void {
  const cutoff = Date.now() - MAX_AGE_MS;
  store.touches = store.touches.filter((t) => Date.parse(t.at) > cutoff).slice(-MAX_TOUCHES);
  if (store.first && Date.parse(store.first.at) <= cutoff) delete store.first;
  if (store.last && Date.parse(store.last.at) <= cutoff) delete store.last;
}

// Called once on app boot: captures ?ref= from the URL into the touch history.
export function captureRefFromLocation(): string | null {
  let code: string | null = null;
  try {
    const params = new URLSearchParams(window.location.search);
    code = sanitizeCode(params.get("ref"));
  } catch { /* no-op */ }
  if (!code) return currentRef();
  const store = readStore();
  expireOld(store);
  const touch: Touch = { code, at: new Date().toISOString() };
  if (!store.first) store.first = touch;
  store.last = touch;
  store.touches = [...store.touches.filter((t) => t.code !== code), touch].slice(-MAX_TOUCHES);
  writeStore(store);
  return code;
}

export function currentRef(): string | null {
  const store = readStore();
  return store.last?.code || null;
}

export interface AttributionHints {
  affiliate_ref: string | null;
  viral_first_touch_code: string | null;
  viral_first_touch_at: string | null;
  viral_last_touch_code: string | null;
  viral_last_touch_at: string | null;
  viral_visitor_id: string;
  viral_session_id: string;
}

export function attributionHints(): AttributionHints {
  const store = readStore();
  return {
    affiliate_ref: store.last?.code || null,
    viral_first_touch_code: store.first?.code || null,
    viral_first_touch_at: store.first?.at || null,
    viral_last_touch_code: store.last?.code || null,
    viral_last_touch_at: store.last?.at || null,
    viral_visitor_id: store.visitor_id,
    viral_session_id: sessionId()
  };
}

// Fire-and-forget PII-free funnel event. client_event_id deduplicates browser
// retries server-side.
const sentEvents = new Set<string>();
export function sendFunnelEvent(dealId: string, eventType: "deal_view" | "share_button_click" | "join_started", extra?: { share_channel?: string; once_key?: string }): void {
  const onceKey = extra?.once_key ? `${dealId}:${eventType}:${extra.once_key}` : null;
  if (onceKey) {
    if (sentEvents.has(onceKey)) return;
    sentEvents.add(onceKey);
  }
  const payload = {
    event_type: eventType,
    deal_id: dealId,
    ref_code: currentRef(),
    share_channel: extra?.share_channel || null,
    visitor_id: visitorId(),
    session_id: sessionId(),
    client_event_id: onceKey ? `ev_${hashKey(onceKey)}` : randomId("ev")
  };
  try {
    void fetch("/api/viral/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      keepalive: true
    }).catch(() => undefined);
  } catch { /* best effort */ }
}

function hashKey(key: string): string {
  // djb2 — stable dedupe id per (session, deal, event); not cryptographic.
  let h = 5381;
  for (let i = 0; i < key.length; i++) h = ((h << 5) + h + key.charCodeAt(i)) >>> 0;
  return `${sessionId().slice(-8)}${h.toString(36)}`;
}

// Records the entry visit against a share link (canonical click/entry rail).
const visitedRefs = new Set<string>();
export function recordShareVisit(dealId: string, code: string | null): void {
  if (!code) return;
  const key = `${dealId}:${code}`;
  if (visitedRefs.has(key)) return;
  visitedRefs.add(key);
  let entryId: string;
  try {
    const sessionEntryKey = `siton_entry_${key}`;
    entryId = sessionStorage.getItem(sessionEntryKey) || randomId("en");
    sessionStorage.setItem(sessionEntryKey, entryId);
  } catch {
    entryId = randomId("en");
  }
  try {
    void fetch("/api/affiliate/links/visit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deal_id: dealId, source_code: code, click_id: randomId("ck"), entry_id: entryId }),
      keepalive: true
    }).catch(() => undefined);
  } catch { /* best effort */ }
}

// Share links use the crawler-readable /d/:dealId route: the server returns
// real OG meta (title, description, the ACTUAL primary deal image) for social
// crawlers and instantly forwards humans into the SPA deal page, preserving
// the personal ?ref= code.
export function absoluteShareUrl(dealId: string, code: string | null): string {
  const ref = code ? `?ref=${encodeURIComponent(code)}` : "";
  return `${window.location.origin}/d/${dealId}${ref}`;
}

export interface ShareTarget {
  key: string;
  label: string;
  icon: string;
  href: (url: string, title: string) => string;
}

export const SHARE_TARGETS: ShareTarget[] = [
  { key: "whatsapp", label: "וואטסאפ", icon: "💬", href: (u, t) => `https://wa.me/?text=${encodeURIComponent(`${t}\n${u}`)}` },
  { key: "telegram", label: "טלגרם", icon: "✈️", href: (u, t) => `https://t.me/share/url?url=${encodeURIComponent(u)}&text=${encodeURIComponent(t)}` },
  { key: "facebook", label: "פייסבוק", icon: "👥", href: (u) => `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(u)}` },
  { key: "x", label: "X", icon: "𝕏", href: (u, t) => `https://twitter.com/intent/tweet?url=${encodeURIComponent(u)}&text=${encodeURIComponent(t)}` },
  { key: "email", label: "מייל", icon: "✉️", href: (u, t) => `mailto:?subject=${encodeURIComponent(t)}&body=${encodeURIComponent(u)}` }
];
