import React, { useEffect, useRef, useState } from "react";
import { api, Json } from "../api";
import {
  BrandLoader, EmptyState, GroupMeter, Modal, ProductImg, ShareActions, StatusPill, QtyStepper, Toast, useToast
} from "../components";
import { LiveCountdown } from "../livecountdown";
// P0.7C — bounded read polling: immediate, never overlapping, paused when hidden,
// back-off on 429/errors, stopped on terminal states; dedicated server read budget.
import { PUBLIC_DEAL_POLL, TERMINAL_DEAL_STATES, classifyPollError } from "../polling";
import { usePoller } from "../usePoller";
import { hebrewError } from "../he";
import { buyerStateStory, dealTypeIcon, dealTypeLabel, fmtDate, ils, initialOf, num, timeAgo } from "../util";
import { attributionHints, currentRef, recordShareVisit, sendFunnelEvent, sessionId, visitorId } from "../viral";
// P0.7 — ONE pickup-location rule shared with the server (publish gate, seller
// payload, public payload): the buyer preview IS this page, so what a seller
// previews is exactly what buyers see after publication.
import { hasUsablePickupLocation, isPickupOptionType, pickupDirectionsUrl, pickupLocationText } from "../../../src/pickup_location";

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
  const [name, setName] = useState(identity.name);
  const [email, setEmail] = useState(identity.email);
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
        <div className="field"><label>שם</label><input data-testid="inquiry-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" maxLength={120} /></div>
        <div className="field">
          <label>אימייל <span className="hint">(לזיהוי הפנייה — מוצג למוכר באופן חלקי בלבד)</span></label>
          <input data-testid="inquiry-email" dir="ltr" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" maxLength={200} />
        </div>
        <div className="field">
          <label>ההודעה למוכר</label>
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

  usePoller(async () => {
    const items = readStoredInquiries(dealId).slice(0, 3);
    if (!items.length) { setThreads([]); return { outcome: "stop" }; }
    const rs = await Promise.all(items.map((it) => api.inquiryThread(it.thread_id, it.token).then((r) => ({ ...r, token: it.token })).catch(() => null)));
    setThreads(rs.filter(Boolean) as Json[]);
    return { outcome: "ok" };
  }, { intervalMs: PUBLIC_DEAL_POLL.inquiries_ms }, [dealId, refreshKey]);

  if (!threads.length) return null;
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
// the product.
function SellerContactPanel({ seller, onOpen, dealId, refreshKey, preview }: {
  seller: Json; onOpen: () => void; dealId: string; refreshKey: number; preview: boolean;
}) {
  return (
    <div className="panel" data-testid="seller-contact-panel">
      <div className="panel-title">🏪 המוכר</div>
      <p style={{ marginBottom: 8 }}><b>{seller.business_name || "המוכר"}</b></p>
      {seller.business_description ? <p className="muted small">{seller.business_description}</p> : null}
      <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
        <button className="btn btn-primary" data-testid="inquiry-open" onClick={onOpen} disabled={preview}
          title={preview ? "מושבת בתצוגה מקדימה" : undefined}>✉️ פנייה למוכר</button>
      </div>
      <p className="muted small" style={{ margin: "8px 0 0" }}>
        {preview
          ? `בתצוגה מקדימה לא נשלחות פניות. אחרי הפרסום, פניות של קונים יגיעו אליכם בתוך ${PRODUCT_NAME_HE} תחת ״פניות מלקוחות״.`
          : `הפנייה נשלחת ונענית בתוך ${PRODUCT_NAME_HE} — התשובה תופיע כאן בדף העסקה.`}
      </p>
      {preview ? null : <MyInquiries dealId={dealId} refreshKey={refreshKey} />}
    </div>
  );
}

// Join flow — on phones this renders as a FULL-HEIGHT sheet (via Modal):
// pinned header, scrollable form body, and a sticky footer CTA that stays
// reachable with the keyboard open and above browser chrome.
function JoinModal(props: {
  deal: Json;
  qty: number;
  delivery: DeliveryOption | null;
  onClose: () => void;
  onSuccess: (result: Json) => void;
}) {
  const { deal, qty, delivery } = props;
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [address, setAddress] = useState("");
  const [city, setCity] = useState("");
  const [notes, setNotes] = useState("");
  const [terms, setTerms] = useState(false);
  const [disclosure, setDisclosure] = useState(false);
  const [payMethod, setPayMethod] = useState<"credit_card" | "bit">("credit_card");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const needsAddress = delivery?.option_type === "delivery";
  const total = qty * Number(deal.price_per_unit) + Number(delivery?.cost || 0);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!name.trim() || !phone.trim()) { setError("נא למלא שם וטלפון"); return; }
    if (needsAddress && !address.trim()) { setError("נא למלא כתובת למשלוח"); return; }
    if (!terms || !disclosure) { setError("נדרש אישור התנאים והבהרת התשלום"); return; }
    setBusy(true);
    setError("");
    try {
      const hints = attributionHints();
      const result = await api.join(deal.deal_id, {
        buyer_id: phone.trim(),
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
      setError(
        err?.body?.code === "max_units_exceeded" ? "המלאי אזל בזמן ההצטרפות — נסו כמות קטנה יותר"
        : err?.message || "ההצטרפות נכשלה"
      );
      setBusy(false);
    }
  };

  return (
    <Modal
      title="אישור הצטרפות לעסקה"
      onClose={props.onClose}
      footer={
        <>
          {error ? <div className="notice err" style={{ marginTop: 0 }}>{error}</div> : null}
          <button className="btn btn-join btn-block" form="join-form" data-testid="join-submit" disabled={busy}>
            {busy ? "מצטרפים…" : `אישור הצטרפות · ${ils(total)}`}
          </button>
        </>
      }
    >
      <form id="join-form" onSubmit={submit}>
        <div className="order-summary" style={{ borderTop: "none", marginTop: 0, paddingTop: 0, marginBottom: 14 }}>
          <div className="order-row"><span>{deal.title}</span><span>{num(qty)} × {ils(deal.price_per_unit)}</span></div>
          {delivery ? <div className="order-row"><span>{DELIVERY_NAMES[delivery.option_type] || delivery.label}</span><span>{delivery.cost ? ils(delivery.cost) : "חינם"}</span></div> : null}
          {delivery && isPickupOptionType(delivery.option_type) && pickupLocationText(delivery) ? (
            <div className="order-row"><span className="muted small">📍 {pickupLocationText(delivery)}</span><span /></div>
          ) : null}
          <div className="order-row total"><span>סה״כ לתפיסת מסגרת</span><span>{ils(total)}</span></div>
        </div>
        <div className="field"><label>שם מלא</label><input data-testid="join-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" /></div>
        <div className="field-row">
          <div className="field"><label>טלפון נייד</label><input data-testid="join-phone" dir="ltr" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="tel" /></div>
          <div className="field"><label>אימייל <span className="hint">(לא חובה)</span></label><input dir="ltr" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" /></div>
        </div>
        {needsAddress ? (
          <div className="field-row">
            <div className="field"><label>כתובת למשלוח</label><input value={address} onChange={(e) => setAddress(e.target.value)} autoComplete="street-address" /></div>
            <div className="field"><label>עיר</label><input value={city} onChange={(e) => setCity(e.target.value)} /></div>
          </div>
        ) : null}
        <div className="field"><label>הערות <span className="hint">(לא חובה)</span></label><input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={200} /></div>

        {/* P0.3-5 — payment method. The CHOICE is ours; the sensitive entry
            itself belongs to the secured payment provider (PCI boundary):
            these are presentation slots only — no raw card details are ever
            collected, sent or stored by C-ton. */}
        <div className="field" style={{ marginBottom: 4 }}><label>אמצעי תשלום</label></div>
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

        <label className="check">
          <input data-testid="join-disclosure" type="checkbox" checked={disclosure} onChange={(e) => setDisclosure(e.target.checked)} />
          <span>הבנתי: הסכום תופס מסגרת אשראי בלבד. לא מתבצע חיוב בפועל עד סגירת העסקה בהצלחה, ואם העסקה לא נסגרת — המסגרת משתחררת אוטומטית.</span>
        </label>
        <label className="check">
          <input data-testid="join-terms" type="checkbox" checked={terms} onChange={(e) => setTerms(e.target.checked)} />
          <span>קראתי ואני מסכים/ה <a href="/legal/terms" target="_blank" rel="noreferrer">לתקנון</a> ולמדיניות הביטולים.</span>
        </label>
        <p className="muted small" style={{ textAlign: "center", marginTop: 8, marginBottom: 0 }}>
          סביבת הדגמה — לא מתבצעת סליקת אשראי אמיתית.
        </p>
      </form>
    </Modal>
  );
}

function JoinSuccess(props: { deal: Json; result: Json; onClose: () => void }) {
  const { deal, result } = props;
  const [toast, showToast] = useToast();
  const shareCode = result?.viral?.personal_share_code || null;
  const trackHash = result?.participant_id && result?.tracking_access_token
    ? `#/track/${result.participant_id}?t=${encodeURIComponent(result.tracking_access_token)}`
    : null;
  return (
    <Modal title="" onClose={props.onClose}>
      <div className="share-moment" data-testid="join-success">
        <div style={{ fontSize: "2.4rem" }}>🎉</div>
        <h3>הצטרפת בהצלחה!</h3>
        <p>
          המסגרת נתפסה — <b>לא בוצע חיוב</b>. החיוב יתבצע רק אם העסקה תיסגר בהצלחה.
        </p>
        <p style={{ fontWeight: 700 }}>
          עזרת לעסקה להתקדם. עכשיו זה הרגע: שתפו עם חברים כדי שנגיע ליעד ביחד —
          זה הקישור האישי שלך, וכל מי שיצטרף דרכו נזקף לזכותך.
        </p>
        <ShareActions dealId={deal.deal_id} title={deal.title} code={shareCode} onNotify={showToast} />
        {trackHash ? (
          <a className="btn btn-primary btn-block" style={{ marginTop: 14 }} href={trackHash}>
            למסך המעקב האישי שלי ←
          </a>
        ) : null}
      </div>
      <Toast msg={toast} />
    </Modal>
  );
}

// P0.7 polish — `preview` = the seller-authorized BUYER PREVIEW of the seller's
// own deal (Draft included). Same renderer, same server projection
// (/api/seller/deals/:id/preview), but read-only by construction: no join, no
// share, no chat, no inquiry, no funnel/share-visit events, no activity
// polling. A Draft is presented exactly as it will look once published.
export function DealPage({ dealId, navigate, preview = false }: { dealId: string; navigate: (hash: string) => void; preview?: boolean }) {
  const [payload, setPayload] = useState<Json | null>(null);
  const [activity, setActivity] = useState<Json | null>(null);
  const [error, setError] = useState("");
  const [qty, setQty] = useState(1);
  const [deliveryId, setDeliveryId] = useState<string>("");
  const [joining, setJoining] = useState(false);
  const [joinResult, setJoinResult] = useState<Json | null>(null);
  const [celebrated, setCelebrated] = useState(false);
  const [timeUp, setTimeUp] = useState(false);
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
      .catch((e) => { if (alive) setError(e.status === 404 ? "העסקה אינה זמינה" : e.message); });
    if (!preview) {
      // real public traffic only — a seller previewing never counts as a view or a share visit
      sendFunnelEvent(dealId, "deal_view", { once_key: sessionId() });
      recordShareVisit(dealId, currentRef());
    }
    return () => { alive = false; };
  }, [dealId, preview]);

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

  if (error) {
    return (
      <EmptyState icon="🕐" title={preview ? "לא ניתן להציג תצוגה מקדימה" : "העסקה אינה זמינה"}
        body={preview ? "העסקה לא נמצאה או שאינה שייכת לחשבון המוכר הזה." : "ייתכן שהעסקה הסתיימה, בוטלה או שהקישור שגוי."}
        action={<a className="btn btn-primary" href={preview ? "#/seller" : "#/"}>{preview ? "לדשבורד המוכר" : "לדף הבית"}</a>} />
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

  const ctaText = !isOpen
    ? (soldOut ? "המלאי אזל — המכירה הסתיימה" : buyerStateStory(state, unitsToTarget))
    : state === "TargetReached"
      ? "הצטרפו ליחידות האחרונות"
      : unitsToTarget > 0 ? `הצטרפו עכשיו — עוד ${num(unitsToTarget)} ליעד` : "הצטרפו לעסקה";

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
        {/* 1 — identity */}
        <div className="deal-area-head">
          <div className={`panel${celebrated ? " celebrate" : ""}`}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <StatusPill state={state} label={buyerStateStory(state, unitsToTarget)} />
              <span className="staging-flag">סביבת הדגמה</span>
            </div>
            <h1 className="deal-title" style={{ marginTop: 10, marginBottom: 0 }}>{deal.title}</h1>
            {deal.description_short ? (
              <p className="deal-short-desc">{deal.description_short}</p>
            ) : null}
            {seller.business_name ? (
              <div className="deal-seller-line">🏪 {seller.business_name}</div>
            ) : null}
          </div>
        </div>

        {/* 2 — the real product image */}
        <div className="deal-area-media">
          <Gallery images={deal.images || []} title={deal.title} type={deal.deal_type} />
        </div>

        {/* 3-8 — price → progress → deadline → qty → delivery → CTA */}
        <div className="deal-area-buy">
          <div className="panel">
            <div className="deal-price-hero" style={{ marginTop: 0 }}>
              <span className="price">{ils(deal.price_per_unit)}</span>
              <span className="price-unit">ליחידה · {dealTypeLabel(deal.deal_type)}</span>
            </div>
            <div style={{ margin: "18px 0 4px" }}>
              <GroupMeter large joined={joined} threshold={Number(deal.threshold_units)} max={Number(deal.max_units)} showFlag />
            </div>
            {OPEN_STATES.includes(state) ? (
              <div className="deal-countdown-block" data-testid="deal-countdown">
                <span className="deal-countdown-label">{timeUp ? "ההצטרפות הסתיימה" : "סיום ההצטרפות בעוד"}</span>
                <LiveCountdown deadline={deal.deadline} onZero={() => setTimeUp(true)} />
              </div>
            ) : null}
            <div className="kv" style={{ marginTop: 14 }}>
              <span className="k">משתתפים</span><span className="v">{num(participants)}</span>
              <span className="k">מלאי נותר</span>
              <span className="v" style={remaining <= 5 ? { color: "var(--pomegranate)" } : undefined}>{num(remaining)} מתוך {num(deal.max_units)}</span>
            </div>
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
                💳 הסכום תופס <b>מסגרת אשראי בלבד</b> — לא מתבצע חיוב בפועל עד
                שהעסקה נסגרת בהצלחה. אם העסקה לא נסגרת, המסגרת משתחררת אוטומטית.
              </div>
              <button className="btn btn-join btn-block" data-testid="join-open" disabled={preview}
                title={preview ? "ההצטרפות מושבתת בתצוגה מקדימה" : undefined}
                onClick={() => { if (preview) return; sendFunnelEvent(dealId, "join_started"); setJoining(true); }}>
                {preview ? "הצטרפות (מושבת בתצוגה מקדימה)" : ctaText}
              </button>
            </div>
          ) : (
            <div className="panel">
              <p style={{ fontWeight: 700, marginBottom: 4 }}>{soldOut ? "המלאי אזל — המכירה הסתיימה" : buyerStateStory(state, unitsToTarget)}</p>
              <p className="muted small" style={{ marginBottom: 0 }}>
                {state === "Completed" ? "העסקה הושלמה — המצטרפים חויבו וקיבלו עדכון." : "לא ניתן להצטרף לעסקה במצבה הנוכחי."}
              </p>
              <FulfillmentSummary options={deliveryOptions} />
            </div>
          )}

          <div className="panel">
            <div className="panel-title">מכירים מישהו שזה יעניין אותו?</div>
            {preview ? (
              <p className="muted small" style={{ margin: 0 }} data-testid="share-preview-note">כפתורי השיתוף יופיעו כאן לקונים אחרי הפרסום (מושבתים בתצוגה מקדימה).</p>
            ) : (
              <ShareActions compact dealId={dealId} title={deal.title} code={currentRef()} onNotify={showToast} />
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
          <SellerContactPanel seller={seller} onOpen={() => { if (!preview) setInquiryOpen(true); }} dealId={dealId} refreshKey={inquiryRefresh} preview={preview} />
          {preview ? null : (
            <div className="panel" style={{ textAlign: "center" }}>
              <p style={{ fontWeight: 700, marginBottom: 8 }}>יש לכם מה למכור בקבוצה?</p>
              <a className="btn btn-ghost" href="#/seller/new">פתחו עסקה משלכם ←</a>
            </div>
          )}
        </div>
      </div>

      {inquiryOpen && !preview ? (
        <InquiryModal deal={deal} onClose={() => setInquiryOpen(false)} onSent={() => setInquiryRefresh((n) => n + 1)} />
      ) : null}
      {joining && !joinResult && !preview ? (
        <JoinModal
          deal={deal}
          qty={Math.min(qty, maxQty)}
          delivery={delivery}
          onClose={() => setJoining(false)}
          onSuccess={(r) => setJoinResult(r)}
        />
      ) : null}
      {joinResult ? (
        <JoinSuccess deal={deal} result={joinResult} onClose={() => { setJoinResult(null); setJoining(false); }} />
      ) : null}
      <Toast msg={toast} />
    </>
  );
}
