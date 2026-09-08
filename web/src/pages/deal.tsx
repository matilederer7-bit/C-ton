import React, { useEffect, useRef, useState } from "react";
import { api, Json } from "../api";
import {
  BrandLoader, EmptyState, GroupMeter, Modal, ProductImg, ShareActions, StatusPill, QtyStepper, Toast, copyText, useToast
} from "../components";
import { LiveCountdown } from "../livecountdown";
// P0.7C — bounded read polling: immediate, never overlapping, paused when hidden,
// back-off on 429/errors, stopped on terminal states; dedicated server read budget.
import { PUBLIC_DEAL_POLL, TERMINAL_DEAL_STATES, classifyPollError } from "../polling";
import { usePoller } from "../usePoller";
import { hebrewError } from "../he";
import { buyerStateStory, dealTypeIcon, dealTypeLabel, fmtDate, formatIsraelDateTime, ils, initialOf, num, timeAgo } from "../util";
import { attributionHints, currentRef, recordShareVisit, sendFunnelEvent, sessionId, visitorId } from "../viral";
// P0.7 — ONE pickup-location rule shared with the server (publish gate, seller
// payload, public payload): the buyer preview IS this page, so what a seller
// previews is exactly what buyers see after publication.
import { hasUsablePickupLocation, isPickupOptionType, pickupDirectionsUrl, pickupLocationText } from "../../../src/pickup_location";
// LAUNCH POLISH 2 — shared buyer copy (what/why/what-if, honesty lines) + the
// one-question feedback surface.
import {
  AFTER_TAP_LINE, DEAL_EXPLAINER, HOW_IT_WORKS, INQUIRY_PRIVACY_LINE, NOTIFICATIONS_OFF_LINE, PILOT_MOCK_MONEY_LINE,
  SHARE_LOOP_TITLE, WHY_GROUP_PRICE, notificationsLine
} from "../buyerCopy";
import { FeedbackPrompt } from "../feedback";

const OPEN_STATES = ["PendingTarget", "TargetReached"];

// P0.7 polish — the visible product name inside Hebrew sentences. The brand
// mark/wordmark stay C-ton; only sentence-level copy says סיטון.
const PRODUCT_NAME_HE = "סיטון";

type DeliveryOption = {
  option_id: string; option_type: string; label: string; cost: number;
  latitude?: number | null; longitude?: number | null;
  location_text?: string | null; has_location?: boolean; map_url?: string | null;
};

const DELIVERY_ICONS: Record<string, string> = { delivery: "🚚", pickup: "🏪", distribution_point: "📍" };
const DELIVERY_NAMES: Record<string, string> = { delivery: "משלוח", pickup: "איסוף עצמי", distribution_point: "נקודת חלוקה" };

// The option's display name: pickup-type options show the canonical type name
// ("איסוף עצמי") and their LOCATION underneath; delivery keeps the seller label.
function deliveryOptionTitle(o: DeliveryOption): string {
  if (isPickupOptionType(o.option_type)) return DELIVERY_NAMES[o.option_type] || o.label;
  return o.label || DELIVERY_NAMES[o.option_type] || "אספקה";
}

// P0.7 — the pickup location block. Shows ONLY what was configured for THIS
// option (address text, else "marked on the map" when only coordinates exist);
// a legacy option without any location gets a neutral fallback — never an
// invented address, never a seller-profile address.
function PickupLocationLine({ option, showNav }: { option: DeliveryOption; showNav: boolean }) {
  if (!isPickupOptionType(option.option_type)) return null;
  const text = pickupLocationText(option);
  const nav = pickupDirectionsUrl(option);
  const usable = hasUsablePickupLocation(option);
  return (
    <div className="pickup-location" data-testid="pickup-location" data-option-type={option.option_type} data-has-location={usable ? "1" : "0"}>
      {text ? (
        <span className="pickup-location-text" data-testid="pickup-location-text">📍 {text}</span>
      ) : nav ? (
        <span className="pickup-location-text" data-testid="pickup-location-text">📍 נקודת האיסוף מסומנת במפה</span>
      ) : (
        <span className="pickup-location-text muted" data-testid="pickup-location-fallback">📍 המוכר טרם פרסם כתובת לנקודת האיסוף — אפשר לשאול דרך ״פנייה למוכר״</span>
      )}
      {nav && showNav ? (
        <a className="btn btn-ghost btn-sm" data-testid="pickup-nav" href={nav} target="_blank" rel="noreferrer">🧭 פתח במפה</a>
      ) : null}
    </div>
  );
}

// Closed / non-joinable states still tell a joined buyer HOW they receive the
// goods — same renderer as the open-state option list.
function FulfillmentSummary({ options }: { options: DeliveryOption[] }) {
  if (!options.length) return null;
  return (
    <div className="stack" style={{ gap: 6, marginTop: 10 }} data-testid="fulfillment-summary">
      <span style={{ fontWeight: 700 }}>אופן קבלה</span>
      {options.map((o) => (
        <div key={o.option_id} className="delivery-option static">
          <span>{DELIVERY_ICONS[o.option_type] || "📦"} {deliveryOptionTitle(o)}</span>
          <span className="delivery-cost">{o.cost ? ils(o.cost) : "חינם"}</span>
          <PickupLocationLine option={o} showNav />
        </div>
      ))}
    </div>
  );
}

function Gallery({ images, title, type }: { images: { url: string }[]; title: string; type: string }) {
  const [idx, setIdx] = useState(0);
  const current = images[idx];
  return (
    <div className="deal-gallery">
      <div className="deal-gallery-main">
        {current
          ? <ProductImg src={current.url} alt={title} />
          : <div className="placeholder">{dealTypeIcon(type)}</div>}
      </div>
      {images.length > 1 ? (
        <div className="deal-thumbs">
          {images.map((img, i) => (
            <button key={i} className={`deal-thumb${i === idx ? " active" : ""}`} onClick={() => setIdx(i)} aria-label={`תמונה ${i + 1}`}>
              <img src={img.url} alt="" loading="lazy" />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ActivityTicker({ activity }: { activity: Json | null }) {
  if (!activity?.recent_joins?.length) return null;
  return (
    <div className="panel">
      <div className="panel-title"><span className="live-dot" aria-hidden="true" /> קורה עכשיו בעסקה</div>
      <div className="ticker" aria-live="polite">
        {activity.recent_joins.map((j: Json, i: number) => (
          <div className="ticker-item" key={`${j.at}-${i}`}>
            <span className="ticker-avatar">{initialOf(j.display)}</span>
            <span>
              <b>{j.display}</b> הצטרף/ה {j.qty > 1 ? <>עם <b>{num(j.qty)} יחידות</b></> : "לעסקה"}
            </span>
            <span className="ticker-time">{timeAgo(j.at)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// P0.3-4: real chat — threaded replies + like/dislike toggles. The backend is
// the single authority (aggregated counts + viewer_reaction come from the
// server; the client never invents totals).
function ChatPanel({ dealId, canWrite, preview }: { dealId: string; canWrite: boolean; preview?: boolean }) {
  const [messages, setMessages] = useState<Json[]>([]);
  const [name, setName] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [replyTo, setReplyTo] = useState<Json | null>(null);
  const composerRef = useRef<HTMLInputElement>(null);
  const load = () => api.chat(dealId, visitorId()).then((r) => setMessages(r.messages || [])).catch(() => undefined);
  // preview: no polling, no writes — the panel is a static placeholder.
  // A closed chat (403) or a vanished deal (404) stops the loop for good.
  usePoller(async () => {
    try {
      const r = await api.chat(dealId, visitorId());
      setMessages(r.messages || []);
      return { outcome: "ok" };
    } catch (err) { return { outcome: classifyPollError(err) }; }
  }, { intervalMs: PUBLIC_DEAL_POLL.chat_ms, enabled: !preview }, [dealId]);
  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!body.trim() || busy || preview) return;
    setBusy(true);
    try {
      await api.chatPost(dealId, {
        body: body.trim(),
        display_name: name.trim() || "משתתף",
        ...(replyTo ? { reply_to_message_id: replyTo.message_id } : {})
      });
      setBody("");
      setReplyTo(null);
      await load();
    } catch { /* keep text for retry */ }
    setBusy(false);
  };
  const react = async (m: Json, reaction: "like" | "dislike") => {
    if (preview) return;
    try {
      const r = await api.chatReact(dealId, m.message_id, { reaction, visitor_id: visitorId() });
      setMessages((prev) => prev.map((x) => x.message_id === m.message_id
        ? { ...x, likes: r.likes, dislikes: r.dislikes, viewer_reaction: r.viewer_reaction }
        : x));
    } catch { /* server stays authoritative; next poll corrects */ }
  };
  return (
    <div className="panel">
      <div className="panel-title">💬 צ׳אט</div>
      {messages.length === 0 ? (
        <p className="muted small">{preview ? "הצ׳אט ייפתח לקונים אחרי הפרסום." : "עדיין אין הודעות — תהיו הראשונים לכתוב."}</p>
      ) : (
        <div className="chat-list">
          {messages.map((m) => (
            <div className="chat-msg" key={m.message_id} data-testid="chat-msg">
              {m.reply_preview ? (
                <div className="chat-reply-context">
                  בתגובה ל<b>{m.reply_preview.display_name || "משתתף"}</b>: {String(m.reply_preview.body || "").slice(0, 120)}
                </div>
              ) : null}
              <div className="chat-author">{m.display_name}</div>
              <div>{m.body}</div>
              <div className="chat-actions">
                <button type="button" className={`chat-action${m.viewer_reaction === "like" ? " active" : ""}`}
                  aria-pressed={m.viewer_reaction === "like"} aria-label="אהבתי" onClick={() => react(m, "like")}>
                  👍 {Number(m.likes || 0) > 0 ? num(m.likes) : ""}
                </button>
                <button type="button" className={`chat-action dislike${m.viewer_reaction === "dislike" ? " active" : ""}`}
                  aria-pressed={m.viewer_reaction === "dislike"} aria-label="לא אהבתי" onClick={() => react(m, "dislike")}>
                  👎 {Number(m.dislikes || 0) > 0 ? num(m.dislikes) : ""}
                </button>
                {canWrite ? (
                  <button type="button" className="chat-action" onClick={() => { setReplyTo(m); composerRef.current?.focus(); }}>
                    ↩ תגובה
                  </button>
                ) : null}
                <span className="chat-time" style={{ marginInlineStart: "auto" }}>{timeAgo(m.created_at)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
      {canWrite ? (
        <>
          {replyTo ? (
            <div className="chat-composing-reply">
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                עונים ל<b>{replyTo.display_name}</b>: {String(replyTo.body || "").slice(0, 60)}
              </span>
              <button type="button" className="chat-action x" aria-label="ביטול תגובה" onClick={() => setReplyTo(null)}>✕</button>
            </div>
          ) : null}
          <form className="chat-form" onSubmit={send}>
            <input placeholder="שם (לא חובה)" value={name} onChange={(e) => setName(e.target.value)} style={{ maxWidth: 130 }} />
            <input ref={composerRef} placeholder={replyTo ? "כתבו תגובה…" : "כתבו הודעה…"} value={body} onChange={(e) => setBody(e.target.value)} maxLength={500} />
            <button className="btn btn-primary btn-sm" disabled={busy || !body.trim()}>שליחה</button>
          </form>
        </>
      ) : null}
    </div>
  );
}

// ── P0.7 — internal buyer → seller inquiry ("פנייה למוכר") ─────────────────
// The buyer never sees the seller's e-mail or phone. The inquiry is stored
// inside the product (the DEAL determines the seller server-side); the seller
// gets a pointer notification and answers in the product; the buyer reads the
// answer right here under "הפניות שלי" (per-thread access token kept in this
// browser).
const INQUIRY_STORE_KEY = "siton_inquiries_v1";
const INQUIRY_IDENTITY_KEY = "siton_inquiry_identity_v1";
type StoredInquiry = { thread_id: string; token: string; created_at: string };
const INQUIRY_STATUS_LABEL: Record<string, string> = {
  Open: "נשלחה — ממתינה לתשובת המוכר",
  Answered: "המוכר השיב",
  Closed: "נסגרה"
};

function readStoredInquiries(dealId: string): StoredInquiry[] {
  try {
    const all = JSON.parse(localStorage.getItem(INQUIRY_STORE_KEY) || "{}");
    const list = Array.isArray(all?.[dealId]) ? all[dealId] : [];
    return list.filter((x: any) => x && typeof x.thread_id === "string" && typeof x.token === "string");
  } catch { return []; }
}
function storeInquiry(dealId: string, item: StoredInquiry): void {
  try {
    const all = JSON.parse(localStorage.getItem(INQUIRY_STORE_KEY) || "{}");
    const list = Array.isArray(all?.[dealId]) ? all[dealId] : [];
    all[dealId] = [item, ...list.filter((x: any) => x?.thread_id !== item.thread_id)].slice(0, 5);
    localStorage.setItem(INQUIRY_STORE_KEY, JSON.stringify(all));
  } catch { /* storage unavailable — the inquiry still exists server-side */ }
}
// LAUNCH POLISH 2 (P8) — a stored token the server no longer honours (thread
// gone / token revoked) is forgotten instead of failing silently forever.
function forgetInquiry(dealId: string, threadId: string): void {
  try {
    const all = JSON.parse(localStorage.getItem(INQUIRY_STORE_KEY) || "{}");
    const list = Array.isArray(all?.[dealId]) ? all[dealId] : [];
    all[dealId] = list.filter((x: any) => x?.thread_id !== threadId);
    localStorage.setItem(INQUIRY_STORE_KEY, JSON.stringify(all));
  } catch { /* noop */ }
}
function readInquiryIdentity(): { name: string; email: string } {
  try {
    const v = JSON.parse(localStorage.getItem(INQUIRY_IDENTITY_KEY) || "{}");
    return { name: String(v?.name || ""), email: String(v?.email || "") };
  } catch { return { name: "", email: "" }; }
}
function storeInquiryIdentity(name: string, email: string): void {
  try { localStorage.setItem(INQUIRY_IDENTITY_KEY, JSON.stringify({ name, email })); } catch { /* noop */ }
}

function InquiryModal({ deal, onClose, onSent }: { deal: Json; onClose: () => void; onSent: () => void }) {
  const identity = readInquiryIdentity();
  const buyer = readBuyerIdentity();
  const [name, setName] = useState(identity.name || buyer.name);
  const [email, setEmail] = useState(identity.email || buyer.email);
  const [message, setMessage] = useState("");
  const [website, setWebsite] = useState(""); // honeypot — humans never see it
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (name.trim().length < 2) { setError("יש להזין שם"); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim())) { setError("יש להזין כתובת אימייל תקינה"); return; }
    if (message.trim().length < 3) { setError("כתבו למוכר כמה מילים"); return; }
    setBusy(true); setError("");
    try {
      const r = await api.dealInquiry(String(deal.deal_id), { name: name.trim(), email: email.trim(), message: message.trim(), website });
      if (r?.thread_id && r?.access_token) {
        storeInquiry(String(deal.deal_id), { thread_id: String(r.thread_id), token: String(r.access_token), created_at: new Date().toISOString() });
      }
      storeInquiryIdentity(name.trim(), email.trim());
      setSent(true);
      onSent();
    } catch (err: any) {
      setError(hebrewError(err));
    }
    setBusy(false);
  };

  if (sent) {
    return (
      <Modal title="" onClose={onClose}>
        <div className="share-moment" data-testid="inquiry-success">
          <div style={{ fontSize: "2.2rem" }}>✅</div>
          <h3>הפנייה נשלחה למוכר דרך {PRODUCT_NAME_HE}.</h3>
          <p>
            המוכר קיבל התראה ויענה לך כאן, בדף העסקה, תחת ״הפניות שלי״.
            פרטי הקשר של המוכר אינם נחשפים — השיחה מתנהלת בתוך {PRODUCT_NAME_HE}.
          </p>
          <p className="muted small">{NOTIFICATIONS_OFF_LINE.replace("קישור המעקב", "הקישור לדף העסקה")}</p>
          <button className="btn btn-primary btn-block" data-testid="inquiry-done" onClick={onClose}>סגירה</button>
        </div>
      </Modal>
    );
  }
  return (
    <Modal
      title="פנייה למוכר"
      onClose={onClose}
      footer={
        <>
          {error ? <div className="notice err" style={{ marginTop: 0 }} data-testid="inquiry-error">{error}</div> : null}
          <button className="btn btn-primary btn-block" form="inquiry-form" data-testid="inquiry-submit" disabled={busy}>
            {busy ? "שולחים…" : "שליחת הפנייה"}
          </button>
        </>
      }
    >
      <form id="inquiry-form" onSubmit={submit} noValidate>
        <p className="muted small" style={{ marginTop: 0 }}>
          הפנייה נשלחת למוכר בתוך {PRODUCT_NAME_HE}, בלי לחשוף פרטי קשר של אף צד. התשובה תופיע כאן, בדף העסקה.
        </p>
        <div className="field"><label>שם <span className="req" aria-hidden="true">*</span></label><input data-testid="inquiry-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" maxLength={120} /></div>
        <div className="field">
          <label>אימייל <span className="req" aria-hidden="true">*</span> <span className="hint">(לזיהוי הפנייה — מוצג למוכר באופן חלקי בלבד)</span></label>
          <input data-testid="inquiry-email" dir="ltr" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" maxLength={200} />
        </div>
        <div className="field">
          <label>ההודעה למוכר <span className="req" aria-hidden="true">*</span></label>
          <textarea data-testid="inquiry-message" rows={4} maxLength={2000} value={message} onChange={(e) => setMessage(e.target.value)}
            placeholder={`שאלה על "${String(deal.title || "")}"…`} />
          <span className="hint">{message.length}/2000</span>
        </div>
        <input type="text" className="hp-field" tabIndex={-1} autoComplete="off" aria-hidden="true" name="website" value={website} onChange={(e) => setWebsite(e.target.value)} />
      </form>
    </Modal>
  );
}

function MyInquiries({ dealId, refreshKey }: { dealId: string; refreshKey: number }) {
  const [threads, setThreads] = useState<Json[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [stale, setStale] = useState(false);

  usePoller(async () => {
    const items = readStoredInquiries(dealId).slice(0, 3);
    if (!items.length) { setThreads([]); return { outcome: "stop" }; }
    const rs = await Promise.all(items.map((it) =>
      api.inquiryThread(it.thread_id, it.token)
        .then((r) => ({ ...r, token: it.token }))
        .catch((err: any) => {
          // P8 — an invalid/expired stored token is forgotten (never a silent hole)
          if ([401, 403, 404].includes(Number(err?.status))) { forgetInquiry(dealId, it.thread_id); setStale(true); }
          return null;
        })));
    setThreads(rs.filter(Boolean) as Json[]);
    return { outcome: "ok" };
  }, { intervalMs: PUBLIC_DEAL_POLL.inquiries_ms }, [dealId, refreshKey]);

  if (!threads.length) {
    return stale ? <p className="muted small" data-testid="my-inquiries-stale">פנייה שנשמרה בדפדפן הזה כבר אינה זמינה. אפשר לשלוח פנייה חדשה.</p> : null;
  }
  const followUp = async (t: Json) => {
    const threadId = String(t.thread.thread_id);
    const text = String(drafts[threadId] || "").trim();
    if (!text || busy) return;
    setBusy(threadId); setError("");
    try {
      const r = await api.inquiryFollowUp(threadId, { access_token: t.token, message: text });
      setDrafts((d) => ({ ...d, [threadId]: "" }));
      const fresh = await api.inquiryThread(threadId, t.token);
      setThreads((prev) => prev.map((x) => (String(x.thread.thread_id) === threadId ? { ...fresh, token: t.token } : x)));
      if (r?.duplicate) setError("ההודעה הזו כבר נשלחה");
    } catch (err: any) { setError(hebrewError(err)); }
    setBusy("");
  };
  return (
    <div className="my-inquiries" data-testid="my-inquiries">
      <div className="section-title" style={{ margin: "14px 0 8px" }}>הפניות שלי</div>
      {stale ? <p className="muted small" data-testid="my-inquiries-stale">פנייה אחת שנשמרה בדפדפן הזה כבר אינה זמינה.</p> : null}
      {threads.map((t) => {
        const threadId = String(t.thread.thread_id);
        return (
          <div className="inq-card" key={threadId} data-testid="my-inquiry" data-status={t.thread.status}>
            <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
              <span className={`inq-status ${String(t.thread.status)}`}>{INQUIRY_STATUS_LABEL[String(t.thread.status)] || String(t.thread.status)}</span>
              <span className="muted small">{timeAgo(t.thread.last_message_at)}</span>
            </div>
            <div className="inq-thread">
              {(t.messages as Json[]).map((m) => (
                <div className={`inq-msg ${String(m.sender_type).toLowerCase()}`} key={m.message_id} data-testid={`my-inquiry-msg-${String(m.sender_type).toLowerCase()}`}>
                  <div className="inq-msg-meta">{m.sender_type === "Seller" ? String(t.thread.seller_display || "המוכר") : "אני"} · {timeAgo(m.created_at)}</div>
                  <div className="inq-msg-body">{m.body}</div>
                </div>
              ))}
            </div>
            {t.thread.status !== "Closed" ? (
              <form className="inq-followup" onSubmit={(e) => { e.preventDefault(); void followUp(t); }}>
                <input data-testid="inquiry-followup" placeholder="הודעת המשך למוכר…" maxLength={2000}
                  value={drafts[threadId] || ""} onChange={(e) => setDrafts((d) => ({ ...d, [threadId]: e.target.value }))} />
                <button className="btn btn-sm btn-ghost" disabled={busy === threadId || !(drafts[threadId] || "").trim()}>שליחה</button>
              </form>
            ) : null}
          </div>
        );
      })}
      {error ? <div className="notice err">{error}</div> : null}
    </div>
  );
}

// P0.7 polish — the ONLY buyer→seller channel is the internal inquiry. No
// phone, no messaging-app link, no e-mail on the public page: contact stays in
// the product. LAUNCH POLISH 2 — the trust facts the backend can prove
// (business name, operator approval) sit next to the one contact channel.
function SellerContactPanel({ seller, onOpen, dealId, refreshKey, preview }: {
  seller: Json; onOpen: () => void; dealId: string; refreshKey: number; preview: boolean;
}) {
  return (
    <div className="panel" data-testid="seller-contact-panel">
      <div className="panel-title">🏪 המוכר</div>
      <p style={{ marginBottom: 8 }}>
        <b>{seller.business_name || "המוכר"}</b>
        {seller.approved ? <span className="trust-badge" data-testid="seller-approved-panel" style={{ marginInlineStart: 8 }}>✓ מוכר מאושר</span> : null}
      </p>
      {seller.business_description ? <p className="muted small">{seller.business_description}</p> : null}
      <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
        <button className="btn btn-primary" data-testid="inquiry-open" onClick={onOpen} disabled={preview}
          title={preview ? "מושבת בתצוגה מקדימה" : undefined}>✉️ פנייה למוכר</button>
      </div>
      <p className="muted small" style={{ margin: "8px 0 0" }}>
        {preview
          ? `בתצוגה מקדימה לא נשלחות פניות. אחרי הפרסום, פניות של קונים יגיעו אליכם בתוך ${PRODUCT_NAME_HE} תחת ״פניות מלקוחות״.`
          : INQUIRY_PRIVACY_LINE + " התשובה תופיע כאן בדף העסקה."}
      </p>
      {preview ? null : <MyInquiries dealId={dealId} refreshKey={refreshKey} />}
    </div>
  );
}

// ── LAUNCH POLISH 2 (P3) — buyer identity remembered in THIS browser only ───
// A refused join (or a reload) must not cost the buyer a retype. Name/phone/
// e-mail stay in localStorage on the buyer's own device; nothing leaves the
// device except through the join itself.
const BUYER_IDENTITY_KEY = "siton_buyer_identity_v1";
function readBuyerIdentity(): { name: string; phone: string; email: string } {
  try {
    const v = JSON.parse(localStorage.getItem(BUYER_IDENTITY_KEY) || "{}");
    return { name: String(v?.name || ""), phone: String(v?.phone || ""), email: String(v?.email || "") };
  } catch { return { name: "", phone: "", email: "" }; }
}
function storeBuyerIdentity(name: string, phone: string, email: string): void {
  try { localStorage.setItem(BUYER_IDENTITY_KEY, JSON.stringify({ name, phone, email })); } catch { /* noop */ }
}

// Israeli phone, lenient: 9–10 digits starting with 0, or +972…; spaces and
// dashes are ignored. The server keeps buyer_id as an opaque string.
export function normalizePhone(raw: string): string {
  return String(raw || "").replace(/[\s-]/g, "").trim();
}
export function isPlausiblePhone(raw: string): boolean {
  const p = normalizePhone(raw);
  return /^0\d{8,9}$/.test(p) || /^\+?972\d{8,9}$/.test(p);
}

type JoinRefusal = { kind: "stock" | "state" | "network" | "fields" | "other"; message: string };

// Join flow — on phones this renders as a FULL-HEIGHT sheet (via Modal):
// pinned header, scrollable form body, and a sticky footer CTA that stays
// reachable with the keyboard open and above browser chrome.
// LAUNCH POLISH 2 (P3): required fields are marked, every validation error is
// a Hebrew sentence under its field, the buyer is told what the tap does
// BEFORE tapping, a refused join keeps everything typed and says what to do
// next, and the mock-money pilot line is explicit. Legal acceptance, the
// payment-method choice and the payload sent to the server are unchanged.
function JoinModal(props: {
  deal: Json;
  qty: number;
  delivery: DeliveryOption | null;
  onClose: () => void;
  onSuccess: (result: Json) => void;
  onRefused: () => void;
}) {
  const { deal, qty, delivery } = props;
  const remembered = readBuyerIdentity();
  const [name, setName] = useState(remembered.name);
  const [phone, setPhone] = useState(remembered.phone);
  const [email, setEmail] = useState(remembered.email);
  const [address, setAddress] = useState("");
  const [city, setCity] = useState("");
  const [notes, setNotes] = useState("");
  const [terms, setTerms] = useState(false);
  const [disclosure, setDisclosure] = useState(false);
  const [payMethod, setPayMethod] = useState<"credit_card" | "bit">("credit_card");
  const [busy, setBusy] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [refusal, setRefusal] = useState<JoinRefusal | null>(null);
  const needsAddress = delivery?.option_type === "delivery";
  const total = qty * Number(deal.price_per_unit) + Number(delivery?.cost || 0);

  const validate = (): Record<string, string> => {
    const errs: Record<string, string> = {};
    if (name.trim().length < 2) errs.name = "יש להזין שם מלא";
    if (!phone.trim()) errs.phone = "יש להזין טלפון נייד";
    else if (!isPlausiblePhone(phone)) errs.phone = "יש להזין מספר טלפון תקין (9–10 ספרות, למשל 050-1234567)";
    if (email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim())) errs.email = "כתובת האימייל אינה תקינה";
    if (needsAddress && !address.trim()) errs.address = "נא למלא כתובת למשלוח";
    if (!disclosure) errs.disclosure = "יש לאשר את הבהרת התשלום";
    if (!terms) errs.terms = "יש לאשר את התקנון";
    return errs;
  };
  const focusFirst = (errs: Record<string, string>) => {
    const first = Object.keys(errs)[0];
    if (!first) return;
    try { document.getElementById(`join-field-${first}`)?.scrollIntoView({ block: "center", behavior: "smooth" }); } catch { /* noop */ }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const errs = validate();
    setFieldErrors(errs);
    if (Object.keys(errs).length) {
      setRefusal({ kind: "fields", message: Object.keys(errs).length === 1 ? String(Object.values(errs)[0]) : `יש להשלים ${num(Object.keys(errs).length)} שדות מסומנים` });
      focusFirst(errs);
      return;
    }
    setBusy(true);
    setRefusal(null);
    storeBuyerIdentity(name.trim(), normalizePhone(phone), email.trim());
    try {
      const hints = attributionHints();
      const result = await api.join(deal.deal_id, {
        buyer_id: normalizePhone(phone),
        buyer_name: name.trim(),
        buyer_email: email.trim() || undefined,
        qty,
        delivery_option_id: delivery?.option_id || undefined,
        delivery_address: needsAddress ? address.trim() : undefined,
        delivery_city: needsAddress ? city.trim() : undefined,
        delivery_notes: notes.trim() || undefined,
        payment_method: payMethod,
        buyer_terms_accepted: true,
        payment_disclosure_accepted: true,
        source: currentRef() ? "direct" : undefined,
        ...hints
      });
      props.onSuccess(result);
    } catch (err: any) {
      // LAUNCH MODE — a refused join is a pilot signal (PII-free: only the code/status)
      const code = String(err?.body?.code || err?.body?.error || "");
      const status = Number(err?.status || 0);
      sendFunnelEvent(String(deal.deal_id), "join_failed", { detail: String(code || status || "unknown").slice(0, 80) });
      const message = String(err?.message || hebrewError(err));
      if (code === "delivery_address_required") { setFieldErrors({ address: message }); setRefusal({ kind: "fields", message }); }
      else if (code === "payment_disclosure_required") { setFieldErrors({ disclosure: message }); setRefusal({ kind: "fields", message }); }
      else if (code === "max_units_exceeded" || /inventory/i.test(code)) setRefusal({ kind: "stock", message });
      else if (status === 409 || status === 423 || code === "deal_not_open_for_joining" || code === "joining_paused_by_admin") setRefusal({ kind: "state", message });
      else if (!status) setRefusal({ kind: "network", message });
      else setRefusal({ kind: "other", message });
      setBusy(false);
    }
  };

  const field = (key: string, label: string, input: React.ReactNode, opts: { required?: boolean; hint?: string } = {}) => (
    <div className={`field${fieldErrors[key] ? " invalid" : ""}`} id={`join-field-${key}`}>
      <label>
        {label}{opts.required ? <span className="req" aria-hidden="true"> *</span> : null}
        {opts.hint ? <span className="hint"> {opts.hint}</span> : null}
      </label>
      {input}
      {fieldErrors[key] ? <span className="field-error" data-testid={`join-error-${key}`} role="alert">{fieldErrors[key]}</span> : null}
    </div>
  );

  return (
    <Modal
      title="אישור הצטרפות לעסקה"
      onClose={props.onClose}
      footer={
        <>
          {refusal ? (
            <div className={`notice ${refusal.kind === "fields" ? "err" : "err join-refusal"}`} style={{ marginTop: 0 }} data-testid="join-refusal" data-kind={refusal.kind}>
              <div>{refusal.message}</div>
              {refusal.kind === "stock" ? (
                <div className="refusal-next">
                  <span>מה עכשיו? חזרו לדף, הפחיתו את הכמות ונסו שוב — הפרטים שהזנתם נשמרו.</span>
                  <button type="button" className="btn btn-sm btn-ghost" data-testid="join-refusal-back" onClick={() => { props.onRefused(); }}>לשינוי הכמות</button>
                </div>
              ) : null}
              {refusal.kind === "state" ? (
                <div className="refusal-next">
                  <span>מה עכשיו? מצב העסקה השתנה. רעננו כדי לראות את הסטטוס העדכני.</span>
                  <button type="button" className="btn btn-sm btn-ghost" data-testid="join-refusal-refresh" onClick={() => { props.onRefused(); }}>רענון הסטטוס</button>
                </div>
              ) : null}
              {refusal.kind === "network" ? (
                <div className="refusal-next"><span>הפרטים שהזנתם נשמרו — בדקו את החיבור ולחצו שוב על אישור.</span></div>
              ) : null}
              {refusal.kind === "other" ? (
                <div className="refusal-next"><span>הפרטים שהזנתם נשמרו. אם זה חוזר — <a href="#/support">פנו לתמיכה</a>.</span></div>
              ) : null}
            </div>
          ) : null}
          <button className="btn btn-join btn-block" form="join-form" data-testid="join-submit" disabled={busy}>
            {busy ? "מצטרפים…" : `אישור הצטרפות · ${ils(total)}`}
          </button>
          <p className="muted small" style={{ textAlign: "center", margin: "6px 0 0" }} data-testid="join-foot-line">
            לא משלמים עכשיו — נתפסת מסגרת בלבד. {PILOT_MOCK_MONEY_LINE}
          </p>
        </>
      }
    >
      <form id="join-form" onSubmit={submit} noValidate>
        <div className="order-summary" style={{ borderTop: "none", marginTop: 0, paddingTop: 0, marginBottom: 12 }}>
          <div className="order-row"><span>{deal.title}</span><span>{num(qty)} × {ils(deal.price_per_unit)}</span></div>
          {delivery ? <div className="order-row"><span>{DELIVERY_NAMES[delivery.option_type] || delivery.label}</span><span>{delivery.cost ? ils(delivery.cost) : "חינם"}</span></div> : null}
          {delivery && isPickupOptionType(delivery.option_type) && pickupLocationText(delivery) ? (
            <div className="order-row"><span className="muted small">📍 {pickupLocationText(delivery)}</span><span /></div>
          ) : null}
          <div className="order-row total"><span>סה״כ לתפיסת מסגרת</span><span>{ils(total)}</span></div>
        </div>
        <p className="join-what-next" data-testid="join-what-next">
          <b>מה קורה באישור?</b> נתפסת מסגרת אשראי בסכום הזה — <b>לא חיוב</b>. מיד אחר כך מקבלים קישור למסך מעקב אישי. החיוב מתבצע רק אם הקבוצה מגיעה ליעד; אם לא — המסגרת משתחררת.
        </p>
        <p className="muted small" style={{ margin: "0 0 10px" }}><span className="req" aria-hidden="true">*</span> שדה חובה</p>
        {field("name", "שם מלא", <input data-testid="join-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" maxLength={120} aria-invalid={Boolean(fieldErrors.name)} />, { required: true })}
        <div className="field-row">
          {field("phone", "טלפון נייד", <input data-testid="join-phone" dir="ltr" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="tel" maxLength={20} aria-invalid={Boolean(fieldErrors.phone)} />, { required: true, hint: "(לזיהוי ההצטרפות)" })}
          {field("email", "אימייל", <input data-testid="join-email" dir="ltr" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" maxLength={200} aria-invalid={Boolean(fieldErrors.email)} />, { hint: "(לא חובה)" })}
        </div>
        {needsAddress ? (
          <div className="field-row">
            {field("address", "כתובת למשלוח", <input data-testid="join-address" value={address} onChange={(e) => setAddress(e.target.value)} autoComplete="street-address" maxLength={200} aria-invalid={Boolean(fieldErrors.address)} />, { required: true })}
            {field("city", "עיר", <input data-testid="join-city" value={city} onChange={(e) => setCity(e.target.value)} maxLength={80} />)}
          </div>
        ) : null}
        {field("notes", "הערות", <input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={200} />, { hint: "(לא חובה)" })}

        {/* P0.3-5 — payment method. The CHOICE is ours; the sensitive entry
            itself belongs to the secured payment provider (PCI boundary):
            these are presentation slots only — no raw card details are ever
            collected, sent or stored by C-ton. */}
        <div className="field" style={{ marginBottom: 4 }}><label>אמצעי תשלום <span className="hint">(לחיוב עתידי, רק אם העסקה תיסגר)</span></label></div>
        <div className="pay-methods" role="tablist" aria-label="אמצעי תשלום">
          <button type="button" role="tab" aria-selected={payMethod === "credit_card"} data-testid="pay-credit"
            className={`pay-method${payMethod === "credit_card" ? " active" : ""}`} onClick={() => setPayMethod("credit_card")}>
            💳 כרטיס אשראי
          </button>
          <button type="button" role="tab" aria-selected={payMethod === "bit"} data-testid="pay-bit"
            className={`pay-method${payMethod === "bit" ? " active" : ""}`} onClick={() => setPayMethod("bit")}>
            <span className="pay-bit-logo">bit</span> תשלום ב-bit
          </button>
        </div>
        <div className="pay-pilot-note" data-testid="pay-pilot-note">🧪 {PILOT_MOCK_MONEY_LINE} השדות למטה מוצגים להמחשה בלבד.</div>
        {payMethod === "credit_card" ? (
          <div className="pay-secure-slot" data-testid="pay-slot-credit">
            <div className="field" style={{ marginBottom: 0 }}>
              <label>מספר כרטיס</label>
              <input dir="ltr" disabled placeholder="•••• •••• •••• ••••" aria-label="מספר כרטיס — מוזן בסביבת הסליקה המאובטחת" />
            </div>
            <div className="pay-field-row">
              <div className="field" style={{ marginBottom: 0 }}><label>תוקף</label><input dir="ltr" disabled placeholder="MM/YY" /></div>
              <div className="field" style={{ marginBottom: 0 }}><label>קוד אבטחה</label><input dir="ltr" disabled placeholder="•••" /></div>
              <div className="field" style={{ marginBottom: 0 }}><label>ת״ז</label><input dir="ltr" disabled placeholder="•••••••••" /></div>
            </div>
            <div className="pay-secure-note">🔒 פרטי הכרטיס מוזנים ישירות בסביבת הסליקה המאובטחת בעת סגירת העסקה — הם אינם נשמרים ואינם עוברים דרך C-ton.</div>
          </div>
        ) : (
          <div className="pay-secure-slot" data-testid="pay-slot-bit">
            <div className="pay-secure-note">🔒 בקשת תשלום ב-bit תישלח למספר הנייד שהזנתם דרך סביבת הסליקה המאובטחת, רק אם העסקה תיסגר בהצלחה. לא מתבצע חיוב עכשיו.</div>
          </div>
        )}

        <div className={`field${fieldErrors.disclosure ? " invalid" : ""}`} id="join-field-disclosure" style={{ marginBottom: 0 }}>
          <label className="check">
            <input data-testid="join-disclosure" type="checkbox" checked={disclosure} onChange={(e) => setDisclosure(e.target.checked)} aria-invalid={Boolean(fieldErrors.disclosure)} />
            <span><span className="req" aria-hidden="true">* </span>הבנתי: הסכום תופס מסגרת אשראי בלבד. לא מתבצע חיוב בפועל עד סגירת העסקה בהצלחה, ואם העסקה לא נסגרת — המסגרת משתחררת אוטומטית.</span>
          </label>
          {fieldErrors.disclosure ? <span className="field-error" data-testid="join-error-disclosure" role="alert">{fieldErrors.disclosure}</span> : null}
        </div>
        <div className={`field${fieldErrors.terms ? " invalid" : ""}`} id="join-field-terms" style={{ marginBottom: 0 }}>
          <label className="check">
            <input data-testid="join-terms" type="checkbox" checked={terms} onChange={(e) => setTerms(e.target.checked)} aria-invalid={Boolean(fieldErrors.terms)} />
            <span><span className="req" aria-hidden="true">* </span>קראתי ואני מסכים/ה <a href="/legal/terms" target="_blank" rel="noreferrer">לתקנון</a> ולמדיניות הביטולים.</span>
          </label>
          {fieldErrors.terms ? <span className="field-error" data-testid="join-error-terms" role="alert">{fieldErrors.terms}</span> : null}
        </div>
      </form>
    </Modal>
  );
}

// LAUNCH POLISH 2 (P4/P5/P6) — the moment after a join answers, in order:
// I joined (how many, how much, no charge) → where the group stands now →
// how I get back here (tracking link, honest notification line) → help the
// deal succeed (share loop) → one feedback question → ask the seller.
function JoinSuccess(props: {
  deal: Json; result: Json; qty: number; liveJoined: number; onClose: () => void; onAskSeller: () => void;
}) {
  const { deal, result, qty } = props;
  const [toast, showToast] = useToast();
  const [live, setLive] = useState<Json | null>(null);
  const [notifLine, setNotifLine] = useState(NOTIFICATIONS_OFF_LINE);
  const shareCode = result?.viral?.personal_share_code || null;
  const trackHash = result?.participant_id && result?.tracking_access_token
    ? `#/track/${result.participant_id}?t=${encodeURIComponent(result.tracking_access_token)}`
    : null;
  const trackUrl = trackHash ? `${window.location.origin}${window.location.pathname}${trackHash}` : "";
  useEffect(() => {
    // one authoritative read so the progress shown includes THIS join
    api.activity(String(deal.deal_id)).then(setLive).catch(() => undefined);
    notificationsLine().then(setNotifLine).catch(() => undefined);
  }, [deal.deal_id]);
  const joined = Number(live?.joined_units ?? (props.liveJoined + qty));
  const threshold = Number(deal.threshold_units);
  const toTarget = Math.max(0, threshold - joined);
  const total = Number(result?.hold_total ?? qty * Number(deal.price_per_unit));
  const copyTrack = async () => {
    if (!trackUrl) return;
    if (await copyText(trackUrl)) showToast("קישור המעקב הועתק");
    else showToast("ההעתקה נכשלה — סמנו את הקישור והעתיקו ידנית");
  };
  return (
    <Modal title="" onClose={props.onClose}>
      <div className="share-moment success-moment" data-testid="join-success">
        <div style={{ fontSize: "2.4rem" }}>🎉</div>
        <h3>הצטרפת בהצלחה!</h3>
        <div className="success-facts" data-testid="join-success-facts">
          <div><b>{num(qty)}</b> {qty === 1 ? "יחידה" : "יחידות"} · <b>{ils(total)}</b></div>
          <div>נתפסה מסגרת בלבד — <b>לא בוצע חיוב</b>. החיוב יתבצע רק אם העסקה תיסגר בהצלחה.</div>
          <div className="muted small">{PILOT_MOCK_MONEY_LINE}</div>
        </div>
        <div className="success-progress" data-testid="join-success-progress" data-to-target={toTarget}>
          <GroupMeter joined={joined} threshold={threshold} max={Number(deal.max_units)} showFlag={false} />
          <p style={{ margin: "8px 0 0", fontWeight: 700 }}>
            {toTarget > 0
              ? <>חסרות עוד <b>{num(toTarget)}</b> יחידות עד {formatIsraelDateTime(deal.deadline)} כדי שהעסקה תצא לפועל.</>
              : <>היעד הושג — העסקה יוצאת לפועל. ההצטרפות פתוחה עד {formatIsraelDateTime(deal.deadline)}.</>}
          </p>
        </div>
        {trackHash ? (
          <div className="success-track" data-testid="join-success-track">
            <a className="btn btn-primary btn-block" data-testid="join-success-track-link" href={trackHash}>
              למסך המעקב האישי שלי ←
            </a>
            <button type="button" className="btn btn-ghost btn-block btn-sm" data-testid="join-success-copy-track" onClick={copyTrack}>העתקת קישור המעקב</button>
            <p className="muted small" style={{ margin: "6px 0 0" }} data-testid="join-success-notif">{notifLine}</p>
          </div>
        ) : null}
        <div className="success-share" data-testid="join-success-share">
          <p style={{ fontWeight: 800, margin: "0 0 8px" }}>{SHARE_LOOP_TITLE}</p>
          <p className="muted small" style={{ marginTop: 0 }}>זה הקישור האישי שלך — כל מי שיצטרף דרכו נזקף לזכותך.</p>
          <ShareActions layout="loop" dealId={deal.deal_id} title={deal.title} price={Number(deal.price_per_unit)} code={shareCode} onNotify={showToast} />
        </div>
        <FeedbackPrompt dealId={String(deal.deal_id)} surface="join_success" />
        <button type="button" className="linklike" data-testid="join-success-ask-seller" onClick={props.onAskSeller}>יש לי שאלה למוכר</button>
      </div>
      <Toast msg={toast} />
    </Modal>
  );
}

// LAUNCH POLISH 2 (P1) — on phones the main CTA scrolls away under the order
// panel; a slim fixed bar keeps "what do I press" on screen. Shown only while
// the deal is open, only when the real CTA is off-screen, never over a sheet.
function StickyJoinBar({ anchor, enabled, price, label, onJoin }: {
  anchor: HTMLElement | null; enabled: boolean; price: number; label: string; onJoin: () => void;
}) {
  const [offscreen, setOffscreen] = useState(false);
  useEffect(() => {
    if (!anchor || typeof IntersectionObserver === "undefined") { setOffscreen(false); return; }
    const io = new IntersectionObserver(([entry]) => setOffscreen(!entry.isIntersecting), { threshold: 0.15 });
    io.observe(anchor);
    return () => io.disconnect();
  }, [anchor]);
  const show = enabled && offscreen;
  return (
    <>
      <div className={`sticky-cta${show ? " show" : ""}`} data-testid="sticky-cta" data-show={show ? "1" : "0"} aria-hidden={!show}>
        <div className="sticky-cta-price"><b>{ils(price)}</b><span>ליחידה · מסגרת בלבד</span></div>
        <button type="button" className="btn btn-join" data-testid="join-open-sticky" tabIndex={show ? 0 : -1} onClick={onJoin}>{label}</button>
      </div>
      {show ? <div className="sticky-cta-spacer" aria-hidden="true" /> : null}
    </>
  );
}

// LAUNCH POLISH 2 (P8) — every non-joinable state answers WHAT happened, CAN I
// do anything, WHAT next. Derived from canonical state + deadline only.
function closedStory(args: { state: string; soldOut: boolean; timeUp: boolean; deadline: string; joined: number; threshold: number }) {
  const { state, soldOut, timeUp } = args;
  const deadlinePassed = timeUp || (Date.parse(String(args.deadline)) <= Date.now());
  const reached = args.joined >= args.threshold;
  if (soldOut) return {
    key: "sold_out", title: "המלאי אזל — כל היחידות נתפסו",
    body: "אי אפשר להצטרף כרגע. אפשר לשאול את המוכר אם יהיה מלאי נוסף או עסקה חדשה.", ask: true, refresh: false
  };
  if (OPEN_STATES.includes(state) && deadlinePassed) return {
    key: "awaiting_decision", title: "מועד ההצטרפות הסתיים — ממתינים להכרעה",
    body: reached
      ? "הקבוצה הגיעה ליעד. העסקה יוצאת לפועל: המצטרפים יחויבו ויעודכנו במסך המעקב האישי."
      : "אם הקבוצה הגיעה ליעד — העסקה יוצאת לפועל והמצטרפים יחויבו. אם לא — המסגרות משתחררות ואף אחד לא משלם.",
    ask: true, refresh: true
  };
  if (state === "ClosedForJoining" && !deadlinePassed) return {
    key: "paused", title: "ההצטרפות מושהית זמנית",
    body: "המוכר השהה את ההצטרפות. ייתכן שתיפתח מחדש לפני מועד הסיום — אפשר לבדוק שוב מאוחר יותר או לשאול את המוכר.", ask: true, refresh: true
  };
  if (["ClosedForJoining", "ReadyForCharging", "Charging"].includes(state)) return {
    key: "closing", title: "ההצטרפות נסגרה — העסקה בדרך לסגירה",
    body: "המצטרפים מחויבים ומקבלים עדכון במסך המעקב האישי. הצטרפות חדשה אינה אפשרית.", ask: true, refresh: false
  };
  if (state === "CompletionWindow") return {
    key: "completion_window", title: "העסקה בחלון השלמה",
    body: "חלק מהחיובים לא עברו והמצטרפים מעודכנים במסך המעקב. הצטרפות חדשה אינה אפשרית.", ask: true, refresh: false
  };
  if (state === "Completed") return {
    key: "completed", title: "העסקה הושלמה בהצלחה",
    body: "המצטרפים חויבו. אם הצטרפתם — הפרטים במסך המעקב האישי שלכם. אפשר לשאול את המוכר על עסקה הבאה.", ask: true, refresh: false
  };
  if (state === "Failed") return {
    key: "failed", title: "העסקה לא יצאה לפועל",
    body: reached
      ? "החיובים לא הושלמו. לא בוצע חיוב — המסגרות שוחררו."
      : "הקבוצה לא הגיעה ליעד עד מועד הסיום. לא בוצע חיוב — המסגרות של כל המצטרפים שוחררו.",
    ask: true, refresh: false
  };
  if (state === "Cancelled") return {
    key: "cancelled", title: "העסקה בוטלה על ידי המוכר",
    body: "לא בוצע חיוב. אפשר לשאול את המוכר אם תיפתח עסקה חדשה.", ask: true, refresh: false
  };
  return { key: "closed", title: buyerStateStory(state, 0), body: "לא ניתן להצטרף לעסקה במצבה הנוכחי.", ask: true, refresh: false };
}

// P0.7 polish — `preview` = the seller-authorized BUYER PREVIEW of the seller's
// own deal (Draft included). Same renderer, same server projection
// (/api/seller/deals/:id/preview), but read-only by construction: no join, no
// share, no chat, no inquiry, no funnel/share-visit events, no activity
// polling. A Draft is presented exactly as it will look once published.
export function DealPage({ dealId, navigate, preview = false, openInquiry = false }: {
  dealId: string; navigate: (hash: string) => void; preview?: boolean; openInquiry?: boolean;
}) {
  const [payload, setPayload] = useState<Json | null>(null);
  const [activity, setActivity] = useState<Json | null>(null);
  const [error, setError] = useState("");
  const [errorKind, setErrorKind] = useState<"gone" | "network" | "busy" | "other">("other");
  const [qty, setQty] = useState(1);
  const [deliveryId, setDeliveryId] = useState<string>("");
  const [joining, setJoining] = useState(false);
  const [joinResult, setJoinResult] = useState<Json | null>(null);
  const [joinedQty, setJoinedQty] = useState(1);
  const [celebrated, setCelebrated] = useState(false);
  const [timeUp, setTimeUp] = useState(false);
  const [ctaEl, setCtaEl] = useState<HTMLButtonElement | null>(null);
  const prevState = useRef<string>("");
  const [toast, showToast] = useToast();
  // P0.7 — internal inquiry sheet + "my inquiries" refresh
  const [inquiryOpen, setInquiryOpen] = useState(false);
  const [inquiryRefresh, setInquiryRefresh] = useState(0);

  useEffect(() => {
    let alive = true;
    (preview ? api.sellerDealPreview(dealId) : api.deal(dealId))
      .then((res) => {
        if (!alive) return;
        setPayload(res);
        const opts: DeliveryOption[] = res.deal?.delivery_options || [];
        if (opts.length) setDeliveryId(opts[0]!.option_id);
      })
      .catch((e) => {
        if (!alive) return;
        const status = Number(e?.status || 0);
        const kind = status === 404 ? "gone" : !status ? "network" : status === 429 || status >= 500 ? "busy" : "other";
        setErrorKind(kind);
        setError(kind === "gone" ? "העסקה אינה זמינה" : String(e?.message || hebrewError(e)));
      });
    if (!preview) {
      // real public traffic only — a seller previewing never counts as a view or a share visit
      sendFunnelEvent(dealId, "deal_view", { once_key: sessionId() });
      recordShareVisit(dealId, currentRef());
    }
    return () => { alive = false; };
  }, [dealId, preview]);

  // LAUNCH POLISH 2 (P7) — #/deal/:id?inquiry=1 (from the tracking page) opens
  // the inquiry sheet directly once the deal is on screen.
  useEffect(() => {
    if (openInquiry && payload && !preview) {
      sendFunnelEvent(dealId, "inquiry_started", { once_key: sessionId() });
      setInquiryOpen(true);
    }
  }, [openInquiry, payload, preview, dealId]);

  // live layer: poll the real activity feed (never in preview). Open deals
  // every 12s, settled-but-not-final deals every 30s, terminal deals never.
  usePoller(async () => {
    try {
      const a = await api.activity(dealId);
      setActivity(a);
      const s = String(a?.state || "");
      if ((TERMINAL_DEAL_STATES as readonly string[]).includes(s)) return { outcome: "stop" };
      return { outcome: "ok", intervalMs: OPEN_STATES.includes(s) ? PUBLIC_DEAL_POLL.activity_open_ms : PUBLIC_DEAL_POLL.activity_settled_ms };
    } catch (err) { return { outcome: classifyPollError(err) }; }
  }, { intervalMs: PUBLIC_DEAL_POLL.activity_open_ms, enabled: !preview }, [dealId]);

  // celebrate the PendingTarget→TargetReached moment while viewing
  useEffect(() => {
    const s = String(activity?.state || "");
    if (prevState.current === "PendingTarget" && s === "TargetReached") setCelebrated(true);
    if (s) prevState.current = s;
  }, [activity?.state]);

  // a refused join (state changed / stock gone) — read the truth again and close the sheet
  const refreshAfterRefusal = () => {
    setJoining(false);
    api.activity(dealId).then(setActivity).catch(() => undefined);
    if (!preview) api.deal(dealId).then(setPayload).catch(() => undefined);
  };

  if (error) {
    const network = errorKind === "network";
    const busy = errorKind === "busy";
    return (
      <EmptyState icon={network ? "📡" : busy ? "⏳" : "🕐"}
        title={preview ? "לא ניתן להציג תצוגה מקדימה" : network ? "בעיית תקשורת" : busy ? "עומס רגעי — נסו שוב בעוד רגע" : "העסקה אינה זמינה"}
        body={preview
          ? "העסקה לא נמצאה או שאינה שייכת לחשבון המוכר הזה."
          : network
            ? "לא הצלחנו לטעון את העסקה. בדקו את החיבור לאינטרנט ונסו שוב — הקישור עצמו תקין."
            : busy
              ? "השרת לא הספיק לענות. הקישור עצמו תקין — לחצו על ״נסו שוב״ בעוד כמה שניות."
              : "ייתכן שהעסקה הסתיימה, בוטלה, או שהקישור לא הועתק במלואו. בדקו את הקישור שקיבלתם, או פנו לתמיכה."}
        action={
          <div className="row" style={{ justifyContent: "center" }}>
            {network || busy ? <button className="btn btn-primary" data-testid="deal-retry" onClick={() => window.location.reload()}>נסו שוב</button> : null}
            <a className="btn btn-ghost" href={preview ? "#/seller" : "#/"}>{preview ? "לדשבורד המוכר" : "לדף הבית"}</a>
            {!preview && !network && !busy ? <a className="btn btn-ghost" href="#/support">תמיכה</a> : null}
          </div>
        } />
    );
  }
  if (!payload) return <BrandLoader label="טוענים את העסקה…" minHeight={420} />;

  const deal = payload.deal;
  const seller = payload.seller || {};
  const live = activity || {};
  const rawState = String(live.state || deal.state);
  // A Draft previews exactly as it will look once published.
  const state = preview && rawState === "Draft" ? "PendingTarget" : rawState;
  const joined = Number(live.joined_units ?? payload.metrics?.joined_units ?? 0);
  const participants = Number(live.participants ?? payload.metrics?.participants_count ?? 0);
  const remaining = Number(live.remaining_units ?? payload.metrics?.remaining_units ?? 0);
  const isOpen = OPEN_STATES.includes(state) && remaining > 0 && !timeUp;
  const maxQty = Math.max(1, Math.min(remaining || 1, 1000));
  const deliveryOptions: DeliveryOption[] = deal.delivery_options || [];
  const delivery = deliveryOptions.find((o) => o.option_id === deliveryId) || null;
  const unitsToTarget = Math.max(0, Number(deal.threshold_units) - joined);
  const subtotal = qty * Number(deal.price_per_unit);
  const total = subtotal + Number(delivery?.cost || 0);
  const soldOut = remaining <= 0 && OPEN_STATES.includes(state);
  const listPrice = Number(deal.list_price_per_unit);
  const hasSaving = listPrice > Number(deal.price_per_unit);
  const savingPct = hasSaving ? Math.round((1 - Number(deal.price_per_unit) / listPrice) * 100) : 0;
  const deadlineText = formatIsraelDateTime(deal.deadline);

  const ctaText = !isOpen
    ? (soldOut ? "המלאי אזל — המכירה הסתיימה" : buyerStateStory(state, unitsToTarget))
    : state === "TargetReached"
      ? "הצטרפו ליחידות האחרונות"
      : unitsToTarget > 0 ? `הצטרפו עכשיו — עוד ${num(unitsToTarget)} ליעד` : "הצטרפו לעסקה";
  const startJoin = () => { if (preview) return; sendFunnelEvent(dealId, "join_started"); setJoining(true); };
  const startInquiry = () => { if (preview) return; sendFunnelEvent(dealId, "inquiry_started", { once_key: sessionId() }); setInquiryOpen(true); };
  const story = isOpen ? null : closedStory({ state, soldOut, timeUp, deadline: String(deal.deadline), joined, threshold: Number(deal.threshold_units) });
  const pillLabel = story?.key === "awaiting_decision" ? "ההצטרפות הסתיימה — ממתינים להכרעה" : story?.key === "paused" ? "ההצטרפות מושהית זמנית" : buyerStateStory(state, unitsToTarget);

  // Mobile-first: one column in EXACTLY the decision order a phone buyer
  // needs — identity, image, price, progress, deadline, quantity, delivery,
  // CTA — then everything secondary. Desktop rearranges via grid areas.
  return (
    <>
      {preview ? (
        <div className="notice info preview-banner" data-testid="preview-banner" role="status">
          <b>תצוגה מקדימה למוכר</b> — כך הקונים יראו את העסקה{rawState === "Draft" ? " אחרי הפרסום" : ""}.
          הצטרפות, שיתוף, צ׳אט ופנייה מושבתים כאן ואינם נספרים.{" "}
          <a href={`#/seller/deal/${dealId}`} onClick={(e) => { e.preventDefault(); navigate(`#/seller/deal/${dealId}`); }}>חזרה לניהול העסקה</a>
        </div>
      ) : null}
      <div className="deal-page">
        {/* 1 — identity: what this is, what Siton is, who sells */}
        <div className="deal-area-head">
          <div className={`panel${celebrated ? " celebrate" : ""}`}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <StatusPill state={state} label={pillLabel} />
              <span className="staging-flag" title={PILOT_MOCK_MONEY_LINE}>סביבת הדגמה</span>
            </div>
            <h1 className="deal-title" style={{ marginTop: 10, marginBottom: 0 }}>{deal.title}</h1>
            {deal.description_short ? (
              <p className="deal-short-desc">{deal.description_short}</p>
            ) : null}
            <p className="deal-explainer" data-testid="deal-explainer">{DEAL_EXPLAINER}</p>
            {seller.business_name ? (
              <div className="deal-seller-line" data-testid="deal-seller-line">
                <span>🏪 {seller.business_name}</span>
                {seller.approved ? <span className="trust-badge" data-testid="seller-approved" title="המוכר אושר לפרסום על ידי צוות סיטון">✓ מוכר מאושר</span> : null}
                {preview ? null : <button type="button" className="linklike" data-testid="inquiry-open-top" onClick={startInquiry}>שאלה למוכר</button>}
              </div>
            ) : null}
          </div>
        </div>

        {/* 2 — the real product image */}
        <div className="deal-area-media">
          <Gallery images={deal.images || []} title={deal.title} type={deal.deal_type} />
        </div>

        {/* 3-8 — price → saving → why → needed → progress → deadline → qty → delivery → CTA */}
        <div className="deal-area-buy">
          <div className="panel">
            {/* LAUNCH POLISH (P6) — say WHICH price this is: the group price, per unit */}
            <div className="deal-price-hero" style={{ marginTop: 0 }} data-testid="deal-price">
              <span className="price">{ils(deal.price_per_unit)}</span>
              <span className="price-unit">מחיר קבוצתי ליחידה · {dealTypeLabel(deal.deal_type)}</span>
            </div>
            {/* LAUNCH MODE — the saving is the whole point: show it when the seller gave a regular price */}
            {hasSaving ? (
              <div className="deal-saving" data-testid="deal-saving">
                <span className="price-was-wrap"><span className="price-was-label">מחיר רגיל</span> <span className="price-was" dir="ltr">{ils(listPrice)}</span></span>
                <span className="saving-badge">חיסכון {savingPct}% מהמחיר הרגיל</span>
                <span className="saving-amount" data-testid="deal-saving-amount">חוסכים {ils(listPrice - Number(deal.price_per_unit))} ליחידה</span>
              </div>
            ) : null}
            <p className="deal-why" data-testid="deal-why">{WHY_GROUP_PRICE}</p>
            <div className="deal-facts" data-testid="deal-needed" data-units-to-target={unitsToTarget}>
              <div className="fact"><span className="fact-n">{num(deal.threshold_units)}</span><span className="fact-l">יחידות ביעד</span></div>
              <div className="fact"><span className="fact-n">{num(joined)}</span><span className="fact-l">כבר הצטרפו</span></div>
              <div className={`fact${unitsToTarget > 0 ? " hot" : " ok"}`}><span className="fact-n">{unitsToTarget > 0 ? num(unitsToTarget) : "✓"}</span><span className="fact-l">{unitsToTarget > 0 ? "עוד חסרות" : "היעד הושג"}</span></div>
            </div>
            <div style={{ margin: "12px 0 4px" }}>
              <GroupMeter large joined={joined} threshold={Number(deal.threshold_units)} max={Number(deal.max_units)} showFlag />
            </div>
            {OPEN_STATES.includes(state) ? (
              <div className="deal-countdown-block" data-testid="deal-countdown">
                <span className="deal-countdown-label">{timeUp ? "ההצטרפות הסתיימה" : "סיום ההצטרפות בעוד"}</span>
                <LiveCountdown deadline={deal.deadline} onZero={() => setTimeUp(true)} />
                {deadlineText ? <span className="deal-deadline-abs" data-testid="deal-deadline-abs">עד {deadlineText}</span> : null}
              </div>
            ) : null}
            <p className="deal-facts-line muted small" data-testid="deal-facts-line">
              {num(participants)} משתתפים · נותרו במלאי <b style={remaining <= 5 ? { color: "var(--pomegranate)" } : undefined}>{num(remaining)}</b> מתוך {num(deal.max_units)}
            </p>
          </div>

          {isOpen ? (
            <div className="panel">
              <div className="panel-title">ההזמנה שלי</div>
              <div className="row" style={{ justifyContent: "space-between", marginBottom: 12 }}>
                <span style={{ fontWeight: 700 }}>כמות יחידות</span>
                <QtyStepper value={Math.min(qty, maxQty)} max={maxQty} onChange={setQty} />
              </div>
              {deliveryOptions.length > 0 ? (
                <div className="stack" style={{ gap: 8, marginBottom: 4 }} data-testid="delivery-options">
                  <span style={{ fontWeight: 700 }}>אופן קבלה</span>
                  {deliveryOptions.map((o) => (
                    <React.Fragment key={o.option_id}>
                      <label className={`delivery-option${o.option_id === deliveryId ? " selected" : ""}`} data-testid="delivery-option" data-option-type={o.option_type}>
                        <input type="radio" name="delivery" checked={o.option_id === deliveryId} onChange={() => setDeliveryId(o.option_id)} />
                        <span>{DELIVERY_ICONS[o.option_type] || "📦"} {deliveryOptionTitle(o)}</span>
                        <span className="delivery-cost">{o.cost ? ils(o.cost) : "חינם"}</span>
                      </label>
                      {/* P0.7 — where exactly the buyer picks up (same renderer as the closed-state summary) */}
                      <PickupLocationLine option={o} showNav={o.option_id === deliveryId} />
                    </React.Fragment>
                  ))}
                </div>
              ) : null}
              <div className="order-summary">
                <div className="order-row"><span>מחיר ליחידה</span><span>{ils(deal.price_per_unit)}</span></div>
                <div className="order-row"><span>כמות</span><span>× {num(Math.min(qty, maxQty))}</span></div>
                {delivery ? <div className="order-row"><span>{DELIVERY_NAMES[delivery.option_type] || "אספקה"}</span><span>{delivery.cost ? ils(delivery.cost) : "חינם"}</span></div> : null}
                <div className="order-row total"><span>סה״כ לתפיסת מסגרת</span><span>{ils(total)}</span></div>
              </div>
              <div className="order-note" style={{ margin: "12px 0" }}>
                💳 <b>לא משלמים עכשיו.</b> הסכום תופס מסגרת אשראי בלבד; החיוב מתבצע רק אם
                העסקה נסגרת בהצלחה, ואם לא — המסגרת משתחררת אוטומטית.
              </div>
              <button className="btn btn-join btn-block" data-testid="join-open" disabled={preview} ref={setCtaEl}
                title={preview ? "ההצטרפות מושבתת בתצוגה מקדימה" : undefined}
                onClick={startJoin}>
                {preview ? "הצטרפות (מושבת בתצוגה מקדימה)" : ctaText}
              </button>
              <p className="after-tap muted small" data-testid="after-tap">{AFTER_TAP_LINE}</p>
              <p className="pilot-line" data-testid="pilot-line">🧪 {PILOT_MOCK_MONEY_LINE}</p>
              {preview ? null : (
                <button type="button" className="btn btn-ghost btn-sm btn-block" data-testid="inquiry-open-cta" onClick={startInquiry}>יש שאלה לפני שמצטרפים? שאלה למוכר</button>
              )}
            </div>
          ) : (
            <div className="panel closed-story" data-testid="closed-story" data-story={story?.key || "closed"}>
              <p style={{ fontWeight: 800, marginBottom: 4, fontSize: "1.05rem" }}>{story?.title}</p>
              <p className="muted small" style={{ marginBottom: 0 }}>{story?.body}</p>
              <div className="row" style={{ marginTop: 12, gap: 8 }}>
                {story?.refresh ? <button type="button" className="btn btn-primary btn-sm" data-testid="closed-refresh" onClick={() => window.location.reload()}>רענון הסטטוס</button> : null}
                {story?.ask && !preview ? <button type="button" className="btn btn-ghost btn-sm" data-testid="closed-ask-seller" onClick={startInquiry}>שאלה למוכר</button> : null}
              </div>
              <FulfillmentSummary options={deliveryOptions} />
            </div>
          )}

          {/* LAUNCH POLISH 2 (P1/P2) — the whole mechanism in three lines, right under the decision */}
          <div className="panel how-panel" data-testid="how-it-works">
            <div className="panel-title">איך זה עובד?</div>
            <ol className="how-strip">
              {HOW_IT_WORKS.map((s) => (
                <li className="how-step" key={s.n}>
                  <span className="how-n" aria-hidden="true">{s.n}</span>
                  <div><b>{s.title}</b><p>{s.body}</p></div>
                </li>
              ))}
            </ol>
          </div>

          <div className="panel">
            <div className="panel-title">מכירים מישהו שזה יעניין אותו?</div>
            {preview ? (
              <p className="muted small" style={{ margin: 0 }} data-testid="share-preview-note">כפתורי השיתוף יופיעו כאן לקונים אחרי הפרסום (מושבתים בתצוגה מקדימה).</p>
            ) : (
              <ShareActions compact dealId={dealId} title={deal.title} price={Number(deal.price_per_unit)} code={currentRef()} onNotify={showToast} />
            )}
          </div>
        </div>

        {/* secondary content */}
        <div className="deal-area-rest">
          <div className="panel">
            <div className="panel-title">📦 מידע נוסף</div>
            <p style={{ whiteSpace: "pre-wrap", marginBottom: 0 }}>{deal.description || deal.description_short || payload.deal?.fulfillment_copy?.what_you_get || "פרטי המוצר יופיעו כאן."}</p>
            {deal.voucher_terms ? (
              <div className="kv" style={{ marginTop: 12 }}>
                <span className="k">שווי השובר</span><span className="v">{ils(deal.voucher_terms.face_value_amount)}</span>
                <span className="k">בתוקף עד</span><span className="v">{fmtDate(deal.voucher_terms.valid_until)}</span>
                {deal.voucher_terms.redemption_location ? (<><span className="k">מימוש</span><span className="v">{deal.voucher_terms.redemption_location}</span></>) : null}
              </div>
            ) : null}
            {deal.ticket_terms ? (
              <div className="kv" style={{ marginTop: 12 }}>
                <span className="k">אירוע</span><span className="v">{deal.ticket_terms.event_name}</span>
                <span className="k">מתי</span><span className="v">{fmtDate(deal.ticket_terms.event_starts_at)}</span>
                {deal.ticket_terms.venue_name ? (<><span className="k">איפה</span><span className="v">{deal.ticket_terms.venue_name}</span></>) : null}
              </div>
            ) : null}
          </div>
          <ActivityTicker activity={activity} />
          <ChatPanel dealId={dealId} canWrite={!preview && OPEN_STATES.includes(state)} preview={preview} />
          <SellerContactPanel seller={seller} onOpen={() => { if (!preview) { sendFunnelEvent(dealId, "inquiry_started", { once_key: sessionId() }); setInquiryOpen(true); } }} dealId={dealId} refreshKey={inquiryRefresh} preview={preview} />
          {preview ? null : (
            <div className="panel" style={{ textAlign: "center" }}>
              <p style={{ fontWeight: 700, marginBottom: 8 }}>יש לכם מה למכור בקבוצה?</p>
              <a className="btn btn-ghost" href="#/seller/new">פתחו עסקה משלכם ←</a>
            </div>
          )}
        </div>
      </div>

      {isOpen && !preview ? (
        <StickyJoinBar anchor={ctaEl} enabled={!joining && !joinResult && !inquiryOpen} price={Number(deal.price_per_unit)}
          label={unitsToTarget > 0 ? `הצטרפו — עוד ${num(unitsToTarget)} ליעד` : "הצטרפו לעסקה"} onJoin={startJoin} />
      ) : null}

      {inquiryOpen && !preview ? (
        <InquiryModal deal={deal} onClose={() => setInquiryOpen(false)} onSent={() => setInquiryRefresh((n) => n + 1)} />
      ) : null}
      {joining && !joinResult && !preview ? (
        <JoinModal
          deal={deal}
          qty={Math.min(qty, maxQty)}
          delivery={delivery}
          onClose={() => setJoining(false)}
          onSuccess={(r) => { setJoinedQty(Math.min(qty, maxQty)); setJoinResult(r); }}
          onRefused={refreshAfterRefusal}
        />
      ) : null}
      {joinResult ? (
        <JoinSuccess deal={deal} result={joinResult} qty={joinedQty} liveJoined={joined}
          onClose={() => { setJoinResult(null); setJoining(false); api.activity(dealId).then(setActivity).catch(() => undefined); }}
          onAskSeller={() => { setJoinResult(null); setJoining(false); startInquiry(); }} />
      ) : null}
      <Toast msg={toast} />
    </>
  );
}
