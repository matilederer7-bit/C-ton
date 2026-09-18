import { DealReceiptInfo } from "../receiptContent";
import React, { useEffect, useRef, useState } from "react";
import { api, Json } from "../api";
import {
  BrandLoader, EmptyState, GroupMeter, Modal, ProductImg, ShareActions, StatusPill, QtyInput, Toast, copyText, useToast
} from "../components";
import { t } from "../i18n";
import { LiveCountdown } from "../livecountdown";
// P0.7C — bounded read polling: immediate, never overlapping, paused when hidden,
// back-off on 429/errors, stopped on terminal states; dedicated server read budget.
import { PUBLIC_DEAL_POLL, TERMINAL_DEAL_STATES, classifyPollError } from "../polling";
import { usePoller } from "../usePoller";
import { localizedError } from "../he";
import { buyerStateStory, dealTypeLabel, fmtDate, formatIsraelDateTime, ils, initialOf, num, timeAgo } from "../util";
// SHELF REINTEGRATION (PR #7 residual slice) — recognizable navigation-app
// glyphs as monochrome SVG (currentColor), replacing the compass/car emoji the
// mature-UI sweep removed. The text label still carries the app name.
import { GoogleMapsIcon, WazeIcon } from "../navIcons";
import { attributionHints, currentRef, recordShareVisit, sendFunnelEvent, sessionId, visitorId } from "../viral";
// P0.7 — ONE pickup-location rule shared with the server (publish gate, seller
// payload, public payload): the buyer preview IS this page, so what a seller
// previews is exactly what buyers see after publication.
import { hasUsablePickupLocation, isPickupOptionType, pickupLocationText, pickupNavigation, PICKUP_NAV_MODE_COPY, type PickupNavigation, type PickupPrecision } from "../../../src/pickup_location";
// LAUNCH POLISH 2 — shared buyer copy (what/why/what-if, honesty lines) + the
// one-question feedback surface.
import { INQUIRY_PRIVACY_LINE_KEY, NOTIFICATIONS_OFF_LINE_KEY, PILOT_MOCK_MONEY_LINE_KEY, notificationsLine } from "../buyerCopy";
// The fixed explanatory sentences (what/why/what-if, the hold notice, the
// share headline and the how-it-works steps) are CMS content: the `deal_page`
// template. resolveDealCopy always answers complete canonical text, so an
// unavailable or partial payload renders exactly as before.
import { resolveDealCopy } from "../productCopy";
import { useSiteContent } from "../siteContent";
import { FeedbackPrompt } from "../feedback";

const OPEN_STATES = ["PendingTarget", "TargetReached"];

// P0.7 polish — the visible product name inside Hebrew sentences. The brand
// mark/wordmark stay C-ton; only sentence-level copy says סיטון.
const PRODUCT_NAME_HE = "סיטון";

type DeliveryOption = {
  option_id: string; option_type: string; label: string; cost: number;
  latitude?: number | null; longitude?: number | null;
  location_text?: string | null; has_location?: boolean; map_url?: string | null;
  // Sprint 4 A1 — server-projected navigation truth (coordinates or address search)
  precision?: PickupPrecision; navigation?: PickupNavigation | null;
  // 071 — optional fulfillment estimate projected by the server
  estimated_min_business_days?: number | null; estimated_max_business_days?: number | null; estimate_text?: string | null;
};

const DELIVERY_NAMES: Record<string, string> = { delivery: "משלוח", pickup: "איסוף עצמי", distribution_point: "נקודת חלוקה" };

// The option's display name: pickup-type options show the canonical type name
// ("איסוף עצמי") and their LOCATION underneath; delivery keeps the seller label.
function deliveryOptionTitle(o: DeliveryOption): string {
  if (isPickupOptionType(o.option_type)) return DELIVERY_NAMES[o.option_type] || o.label;
  return o.label || DELIVERY_NAMES[o.option_type] || t("pages.deal.65e1ef42");
}

// P0.7 — the pickup location block. Shows ONLY what was configured for THIS
// option (address text, else "marked on the map" when only coordinates exist);
// a legacy option without any location gets a neutral fallback — never an
// invented address, never a seller-profile address.
// ONE navigation renderer (Sprint 4 A1, ported from claude/launch-ux-cleanup):
// Google Maps + Waze to the SAME truth — stored coordinates, or an address
// search of the seller's real text — with the mode said out loud. A generic
// label never becomes a navigation target.
export function PickupNavActions({ navigation, testIdPrefix = "pickup-nav" }: { navigation: PickupNavigation | null | undefined; testIdPrefix?: string }) {
  if (!navigation) return null;
  return (
    <span className="pickup-nav-actions" data-testid={`${testIdPrefix}-actions`} data-mode={navigation.mode}>
      <a className="btn btn-ghost btn-sm" data-testid={testIdPrefix} href={navigation.google_maps_url} target="_blank" rel="noreferrer"><GoogleMapsIcon /> Google Maps</a>
      <a className="btn btn-ghost btn-sm" data-testid={`${testIdPrefix}-waze`} href={navigation.waze_url} target="_blank" rel="noreferrer"><WazeIcon /> Waze</a>
      <span className="muted small pickup-nav-mode" data-testid={`${testIdPrefix}-mode`}>{PICKUP_NAV_MODE_COPY[navigation.mode]}</span>
    </span>
  );
}

function PickupLocationLine({ option, showNav }: { option: DeliveryOption; showNav: boolean }) {
  if (!isPickupOptionType(option.option_type)) return null;
  const text = pickupLocationText(option);
  const navigation = option.navigation ?? pickupNavigation(option);
  const usable = hasUsablePickupLocation(option);
  return (
    <div className="pickup-location" data-testid="pickup-location" data-option-type={option.option_type} data-has-location={usable ? "1" : "0"}>
      {text ? (
        <span className="pickup-location-text" data-testid="pickup-location-text">{text}</span>
      ) : navigation ? (
        <span className="pickup-location-text" data-testid="pickup-location-text">{t("pages.deal.9fc526f4")}</span>
      ) : (
        <span className="pickup-location-text muted" data-testid="pickup-location-fallback">{t("pages.deal.c01d7cbd")}</span>
      )}
      {showNav ? <PickupNavActions navigation={navigation} /> : null}
    </div>
  );
}

// Closed / non-joinable states still tell a joined buyer HOW they receive the
// goods — same renderer as the open-state option list.
function FulfillmentSummary({ options }: { options: DeliveryOption[] }) {
  if (!options.length) return null;
  return (
    <div className="stack" style={{ gap: 6, marginTop: 10 }} data-testid="fulfillment-summary">
      <span style={{ fontWeight: 700 }}>{t("pages.deal.bd008360")}</span>
      {/* ROUND 2 (UX-3) — the option name carries itself; the decorative type
          glyph that used to sit before it is gone. */}
      {options.map((o) => (
        <div key={o.option_id} className="delivery-option static">
          <span>{deliveryOptionTitle(o)}</span>
          <span className="delivery-cost">{o.cost ? ils(o.cost) : t("pages.deal.323814d1")}</span>
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
          : <div className="placeholder">{dealTypeLabel(type)}</div>}
      </div>
      {images.length > 1 ? (
        <div className="deal-thumbs">
          {images.map((img, i) => (
            <button key={i} className={`deal-thumb${i === idx ? " active" : ""}`} onClick={() => setIdx(i)} aria-label={t("pages.deal.3b7e60ca", { v0: i + 1 })}>
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
      <div className="panel-title"><span className="live-dot" aria-hidden="true" />  {t("pages.deal.b8fd28b9")}</div>
      <div className="ticker" aria-live="polite">
        {activity.recent_joins.map((j: Json, i: number) => (
          <div className="ticker-item" key={`${j.at}-${i}`}>
            <span className="ticker-avatar">{initialOf(j.display)}</span>
            <span>
              <b>{j.display}</b> הצטרף/ה {j.qty > 1 ? <>{t("pages.deal.43fa3ff5")} <b>{t("pages.deal.53ab3dca", { qty: num(j.qty) })}</b></> : t("pages.deal.8d4d7e16")}
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
export function ChatPanel({ dealId, canWrite, preview }: { dealId: string; canWrite: boolean; preview?: boolean }) {
  const [messages, setMessages] = useState<Json[]>([]);
  const [name, setName] = useState("");
  const [chatTitle, setChatTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [replyTo, setReplyTo] = useState<Json | null>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
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
        display_name: name.trim() || t("pages.deal.3cffea29"),
        title: chatTitle.trim(),
        ...(replyTo ? { reply_to_message_id: replyTo.message_id } : {})
      });
      setBody("");
      setChatTitle("");
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
      <div className="panel-title">{t("pages.deal.1c9debf2")}</div>
      {messages.length === 0 ? (
        <p className="muted small">{preview ? t("pages.deal.3b4d95a4") : t("pages.deal.05c1e7c3")}</p>
      ) : (
        <div className="chat-list">
          {messages.map((m) => (
            <div className="chat-msg" key={m.message_id} data-testid="chat-msg">
              {m.reply_preview ? (
                <div className="chat-reply-context">
                  בתגובה ל<b>{m.reply_preview.display_name || t("pages.deal.3cffea29")}</b>: {String(m.reply_preview.body || "").slice(0, 120)}
                </div>
              ) : null}
              <div className="chat-author">{m.display_name}</div>
              {m.title ? <b>{m.title}</b> : null}
              <div style={{ whiteSpace: "pre-wrap" }}>{m.body}</div>
              <div className="chat-actions">
                <button type="button" className={`chat-action${m.viewer_reaction === "like" ? " active" : ""}`}
                  aria-pressed={m.viewer_reaction === "like"} aria-label={t("pages.deal.38bf5edd")} onClick={() => react(m, "like")}>
                  אהבתי {Number(m.likes || 0) > 0 ? num(m.likes) : ""}
                </button>
                <button type="button" className={`chat-action dislike${m.viewer_reaction === "dislike" ? " active" : ""}`}
                  aria-pressed={m.viewer_reaction === "dislike"} aria-label={t("pages.deal.88cd823a")} onClick={() => react(m, "dislike")}>
                  לא אהבתי {Number(m.dislikes || 0) > 0 ? num(m.dislikes) : ""}
                </button>
                {canWrite ? (
                  <button type="button" className="chat-action" onClick={() => { setReplyTo(m); composerRef.current?.focus(); }}>
                    {t("pages.deal.f47c46a0")}</button>
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
              <button type="button" className="chat-action x" aria-label={t("pages.deal.6900b198")} onClick={() => setReplyTo(null)}>✕</button>
            </div>
          ) : null}
          <form className="chat-form" onSubmit={send}>
            <label>{t("pages.deal.5ab0cbb2")}<input aria-label={t("pages.deal.f2efe40b")} value={chatTitle} onChange={e => setChatTitle(e.target.value)} maxLength={80} /></label>
            <span className="muted small">{chatTitle.length}/80</span>
            <label>{t("pages.deal.b135a00a")}<textarea ref={composerRef} rows={5} placeholder={replyTo ? t("pages.deal.b269960a") : t("pages.deal.b47bfe98")} value={body} onChange={e => setBody(e.target.value)} maxLength={500} /></label>
            <label>{t("pages.deal.6d1cbcb7")}<input value={name} onChange={e => setName(e.target.value)} maxLength={80} /></label>
            <button className="btn btn-primary btn-sm" disabled={busy || !body.trim()}>{t("pages.deal.5239bffa")}</button>
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
    if (name.trim().length < 2) { setError(t("pages.deal.11374f97")); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim())) { setError(t("pages.deal.574b1fc6")); return; }
    if (message.trim().length < 3) { setError(t("pages.deal.4462f25e")); return; }
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
      setError(localizedError(err));
    }
    setBusy(false);
  };

  if (sent) {
    return (
      <Modal title="" onClose={onClose}>
        <div className="share-moment" data-testid="inquiry-success">
          <h3>{t("pages.deal.03ddf051", { pRODUCT_NAME_HE: PRODUCT_NAME_HE })}</h3>
          <p>
            {t("pages.deal.791563ba", { pRODUCT_NAME_HE: PRODUCT_NAME_HE })}</p>
          <p className="muted small">{t(NOTIFICATIONS_OFF_LINE_KEY).replace(t("pages.deal.42e156ea"), t("pages.deal.a1d7b561"))}</p>
          <button className="btn btn-primary btn-block" data-testid="inquiry-done" onClick={onClose}>{t("pages.deal.b728721f")}</button>
        </div>
      </Modal>
    );
  }
  return (
    <Modal
      title={t("pages.deal.99c4ed72")}
      onClose={onClose}
      footer={
        <>
          {error ? <div className="notice err" style={{ marginTop: 0 }} data-testid="inquiry-error">{error}</div> : null}
          <button className="btn btn-primary btn-block" form="inquiry-form" data-testid="inquiry-submit" disabled={busy}>
            {busy ? t("pages.deal.ea12faeb") : t("pages.deal.18a3d8cf")}
          </button>
        </>
      }
    >
      <form id="inquiry-form" onSubmit={submit} noValidate>
        <p className="muted small" style={{ marginTop: 0 }}>
          {t("pages.deal.c8b17b9b", { pRODUCT_NAME_HE: PRODUCT_NAME_HE })}</p>
        <div className="field"><label>{t("pages.deal.8b1aa6b1")} <span className="req" aria-hidden="true">*</span></label><input data-testid="inquiry-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" maxLength={120} /></div>
        <div className="field">
          <label>{t("pages.deal.15dbea0f")} <span className="req" aria-hidden="true">*</span> <span className="hint">{t("pages.deal.9fad6166")}</span></label>
          <input data-testid="inquiry-email" dir="ltr" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" maxLength={200} />
        </div>
        <div className="field">
          <label>{t("pages.deal.5613de8b")} <span className="req" aria-hidden="true">*</span></label>
          <textarea data-testid="inquiry-message" rows={4} maxLength={2000} value={message} onChange={(e) => setMessage(e.target.value)}
            placeholder={t("pages.deal.cb4bf129", { v0: String(deal.title || "") })} />
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
    return stale ? <p className="muted small" data-testid="my-inquiries-stale">{t("pages.deal.48ddf887")}</p> : null;
  }
  const followUp = async (thread: Json) => {
    const threadId = String(thread.thread.thread_id);
    const text = String(drafts[threadId] || "").trim();
    if (!text || busy) return;
    setBusy(threadId); setError("");
    try {
      const r = await api.inquiryFollowUp(threadId, { access_token: thread.token, message: text });
      setDrafts((d) => ({ ...d, [threadId]: "" }));
      const fresh = await api.inquiryThread(threadId, thread.token);
      setThreads((prev) => prev.map((x) => (String(x.thread.thread_id) === threadId ? { ...fresh, token: thread.token } : x)));
      if (r?.duplicate) setError(t("pages.deal.5bc44700"));
    } catch (err: any) { setError(localizedError(err)); }
    setBusy("");
  };
  return (
    <div className="my-inquiries" data-testid="my-inquiries">
      <div className="section-title" style={{ margin: "14px 0 8px" }}>{t("pages.deal.91d16106")}</div>
      {stale ? <p className="muted small" data-testid="my-inquiries-stale">{t("pages.deal.3d9ee6e5")}</p> : null}
      {threads.map((thread) => {
        const threadId = String(thread.thread.thread_id);
        return (
          <div className="inq-card" key={threadId} data-testid="my-inquiry" data-status={thread.thread.status}>
            <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
              <span className={`inq-status ${String(thread.thread.status)}`}>{INQUIRY_STATUS_LABEL[String(thread.thread.status)] || String(thread.thread.status)}</span>
              <span className="muted small">{timeAgo(thread.thread.last_message_at)}</span>
            </div>
            <div className="inq-thread">
              {(thread.messages as Json[]).map((m) => (
                <div className={`inq-msg ${String(m.sender_type).toLowerCase()}`} key={m.message_id} data-testid={`my-inquiry-msg-${String(m.sender_type).toLowerCase()}`}>
                  <div className="inq-msg-meta">{m.sender_type === "Seller" ? String(thread.thread.seller_display || t("pages.deal.e98d9358")) : t("pages.deal.7efa9cf0")} · {timeAgo(m.created_at)}</div>
                  <div className="inq-msg-body">{m.body}</div>
                </div>
              ))}
            </div>
            {thread.thread.status !== "Closed" ? (
              <form className="inq-followup" onSubmit={(e) => { e.preventDefault(); void followUp(thread); }}>
                <input data-testid="inquiry-followup" placeholder={t("pages.deal.a5324ba1")} maxLength={2000}
                  value={drafts[threadId] || ""} onChange={(e) => setDrafts((d) => ({ ...d, [threadId]: e.target.value }))} />
                <button className="btn btn-sm btn-ghost" disabled={busy === threadId || !(drafts[threadId] || "").trim()}>{t("pages.deal.5239bffa")}</button>
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
  // ROUND 2 (UX-5) — the seller's public identity, rendered from the payload's
  // OWN seller block: the logo/profile photo they uploaded, the display name,
  // the About text, the operator-proved approval badge, and a link to the full
  // public profile (deals + success history). Nothing here is a second model —
  // it is the canonical seller_accounts public projection. Still no e-mail, no
  // phone, no address: the inquiry rail remains the only contact channel.
  const about = seller.business_description ? String(seller.business_description) : "";
  return (
    <div className="panel" data-testid="seller-contact-panel">
      <div className="panel-title">{t("pages.deal.e98d9358")}</div>
      <div className="seller-identity" style={{ marginBottom: 8 }}>
        {seller.image ? <img className="seller-avatar sm" src={String(seller.image)} alt="" data-testid="seller-profile-image" /> : null}
        <div style={{ minWidth: 0 }}>
          <div className="seller-identity-name" data-testid="seller-display-name">{seller.business_name || t("pages.deal.e98d9358")}</div>
          {seller.approved ? <span className="trust-badge" data-testid="seller-approved-panel">{t("pages.deal.ab6c964e")}</span> : null}
        </div>
      </div>
      {about ? <p className="seller-about small" data-testid="seller-about">{about}</p> : null}
      {seller.profile_id && !preview ? (
        <p style={{ margin: "10px 0 0" }}>
          <a href={`#/public-seller/${seller.profile_id}`} data-testid="seller-profile-link">{t("pages.deal.837ecaa0")}</a>
        </p>
      ) : null}
      <div className="row" style={{ flexWrap: "wrap", gap: 8, marginTop: 12 }}>
        <button className="btn btn-primary" data-testid="inquiry-open" onClick={onOpen} disabled={preview}
          title={preview ? t("pages.deal.8a8b3eb1") : undefined}>{t("pages.deal.99c4ed72")}</button>
      </div>
      <p className="muted small" style={{ margin: "8px 0 0" }}>
        {preview
          ? t("pages.deal.7479d230", { pRODUCT_NAME_HE: PRODUCT_NAME_HE })
          : t(INQUIRY_PRIVACY_LINE_KEY, { product: t("buyer_copy.product_name") }) + t("pages.deal.c6fde5b2")}
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
  const dealCopy = resolveDealCopy(useSiteContent());
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
    if (name.trim().length < 2) errs.name = t("pages.deal.7fcb9eb9");
    if (!phone.trim()) errs.phone = t("pages.deal.1e004126");
    else if (!isPlausiblePhone(phone)) errs.phone = t("pages.deal.2f95e65c");
    if (email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim())) errs.email = t("pages.deal.2d361111");
    if (needsAddress && !address.trim()) errs.address = t("pages.deal.a2f6a617");
    if (!disclosure) errs.disclosure = t("pages.deal.9ba5a923");
    if (!terms) errs.terms = t("pages.deal.299a6393");
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
      setRefusal({ kind: "fields", message: Object.keys(errs).length === 1 ? String(Object.values(errs)[0]) : t("pages.deal.8d13eae7", { length: num(Object.keys(errs).length) }) });
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
      const message = String(err?.message || localizedError(err));
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
      <label htmlFor={`join-control-${key}`}>
        {label}{opts.required ? <span className="req" aria-hidden="true"> *</span> : null}
        {opts.hint ? <span className="hint"> {opts.hint}</span> : null}
      </label>
      {React.isValidElement(input) ? React.cloneElement(input as React.ReactElement<{ id?: string }>, { id: `join-control-${key}` }) : input}
      {fieldErrors[key] ? <span className="field-error" data-testid={`join-error-${key}`} role="alert">{fieldErrors[key]}</span> : null}
    </div>
  );

  return (
    <Modal
      title={t("pages.deal.10fe8521")}
      onClose={props.onClose}
      footer={
        <>
          {refusal ? (
            <div className={`notice ${refusal.kind === "fields" ? "err" : "err join-refusal"}`} style={{ marginTop: 0 }} data-testid="join-refusal" data-kind={refusal.kind}>
              <div>{refusal.message}</div>
              {refusal.kind === "stock" ? (
                <div className="refusal-next">
                  <span>{t("pages.deal.fd5ffd08")}</span>
                  <button type="button" className="btn btn-sm btn-ghost" data-testid="join-refusal-back" onClick={() => { props.onRefused(); }}>{t("pages.deal.1e0db7ed")}</button>
                </div>
              ) : null}
              {refusal.kind === "state" ? (
                <div className="refusal-next">
                  <span>{t("pages.deal.2d0aa0fe")}</span>
                  <button type="button" className="btn btn-sm btn-ghost" data-testid="join-refusal-refresh" onClick={() => { props.onRefused(); }}>{t("pages.deal.f6e9ac12")}</button>
                </div>
              ) : null}
              {refusal.kind === "network" ? (
                <div className="refusal-next"><span>{t("pages.deal.b25b277e")}</span></div>
              ) : null}
              {refusal.kind === "other" ? (
                <div className="refusal-next"><span>{t("pages.deal.cd11bb9b")} <a href="#/support">{t("pages.deal.fe733394")}</a>.</span></div>
              ) : null}
            </div>
          ) : null}
          <button className="btn btn-join btn-block" form="join-form" data-testid="join-submit" disabled={busy}>
            {busy ? t("pages.deal.853ef03b") : t("pages.deal.bb59c1cd", { total: ils(total) })}
          </button>
          <p className="muted small" style={{ textAlign: "center", margin: "6px 0 0" }} data-testid="join-foot-line">
            {dealCopy.holdNotice} {t(PILOT_MOCK_MONEY_LINE_KEY)}
          </p>
        </>
      }
    >
      <form id="join-form" onSubmit={submit} noValidate>
        <div className="order-summary" style={{ borderTop: "none", marginTop: 0, paddingTop: 0, marginBottom: 12 }}>
          <div className="order-row"><span>{deal.title}</span><span>{num(qty)} × {ils(deal.price_per_unit)}</span></div>
          {delivery ? <div className="order-row"><span>{DELIVERY_NAMES[delivery.option_type] || delivery.label}</span><span>{delivery.cost ? ils(delivery.cost) : t("pages.deal.323814d1")}</span></div> : null}
          {delivery && isPickupOptionType(delivery.option_type) && pickupLocationText(delivery) ? (
            <div className="order-row"><span className="muted small">{pickupLocationText(delivery)}</span><span /></div>
          ) : null}
          <div className="order-row total"><span>{t("pages.deal.ce13b5b8")}</span><span>{ils(total)}</span></div>
        </div>
        <p className="join-what-next" data-testid="join-what-next">
          <b>{t("pages.deal.86dd01b8")}</b>  {t("pages.deal.f7cfd426")} <b>{t("pages.deal.e405663c")}</b>{t("pages.deal.84eb3e55")}</p>
        <p className="muted small" style={{ margin: "0 0 10px" }}><span className="req" aria-hidden="true">*</span>  {t("pages.deal.3b4e4759")}</p>
        {field("name", t("pages.deal.cbdaff61"), <input data-testid="join-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" maxLength={120} aria-invalid={Boolean(fieldErrors.name)} />, { required: true })}
        <div className="field-row">
          {field("phone", t("pages.deal.8d517465"), <input data-testid="join-phone" dir="ltr" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="tel" maxLength={20} aria-invalid={Boolean(fieldErrors.phone)} />, { required: true, hint: t("pages.deal.dd9a94bc") })}
          {field("email", t("pages.deal.15dbea0f"), <input data-testid="join-email" dir="ltr" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" maxLength={200} aria-invalid={Boolean(fieldErrors.email)} />, { hint: t("pages.deal.9fbd1f49") })}
        </div>
        {needsAddress ? (
          <div className="field-row">
            {field("address", t("pages.deal.25bdea44"), <input data-testid="join-address" value={address} onChange={(e) => setAddress(e.target.value)} autoComplete="street-address" maxLength={200} aria-invalid={Boolean(fieldErrors.address)} />, { required: true })}
            {field("city", t("pages.deal.b2136c90"), <input data-testid="join-city" value={city} onChange={(e) => setCity(e.target.value)} maxLength={80} />)}
          </div>
        ) : null}
        {field("notes", t("pages.deal.92b0d682"), <input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={200} />, { hint: t("pages.deal.9fbd1f49") })}

        {/* P0.3-5 — payment method. The CHOICE is ours; the sensitive entry
            itself belongs to the secured payment provider (PCI boundary):
            these are presentation slots only — no raw card details are ever
            collected, sent or stored by C-ton. */}
        <div className="field" style={{ marginBottom: 4 }}><label>{t("pages.deal.9c709c1b")} <span className="hint">{t("pages.deal.8ddfdf15")}</span></label></div>
        <div className="pay-methods" role="tablist" aria-label={t("pages.deal.9c709c1b")}>
          <button type="button" role="tab" aria-selected={payMethod === "credit_card"} data-testid="pay-credit"
            className={`pay-method${payMethod === "credit_card" ? " active" : ""}`} onClick={() => setPayMethod("credit_card")}>
            {t("pages.deal.c5a87fbf")}</button>
          <button type="button" role="tab" aria-selected={payMethod === "bit"} data-testid="pay-bit"
            className={`pay-method${payMethod === "bit" ? " active" : ""}`} onClick={() => setPayMethod("bit")}>
            <span className="pay-bit-logo">bit</span>  {t("pages.deal.f5e42079")}</button>
        </div>
        <div className="pay-pilot-note" data-testid="pay-pilot-note">{t("pages.deal.1e2b6b26", { pILOT_MOCK_MONEY_LINE: t(PILOT_MOCK_MONEY_LINE_KEY) })}</div>
        {payMethod === "credit_card" ? (
          <div className="pay-secure-slot" data-testid="pay-slot-credit">
            <div className="field" style={{ marginBottom: 0 }}>
              <label>{t("pages.deal.f66b523e")}</label>
              <input dir="ltr" disabled placeholder="•••• •••• •••• ••••" aria-label={t("pages.deal.1524d20b")} />
            </div>
            <div className="pay-field-row">
              <div className="field" style={{ marginBottom: 0 }}><label>{t("pages.deal.48f45a5d")}</label><input dir="ltr" disabled placeholder="MM/YY" /></div>
              <div className="field" style={{ marginBottom: 0 }}><label>{t("pages.deal.e6496d6c")}</label><input dir="ltr" disabled placeholder="•••" /></div>
              <div className="field" style={{ marginBottom: 0 }}><label>{t("pages.deal.267fd66f")}</label><input dir="ltr" disabled placeholder="•••••••••" /></div>
            </div>
            <div className="pay-secure-note">{t("pages.deal.5208764f")}</div>
          </div>
        ) : (
          <div className="pay-secure-slot" data-testid="pay-slot-bit">
            <div className="pay-secure-note">{t("pages.deal.20b2af3c")}</div>
          </div>
        )}

        <div className={`field${fieldErrors.disclosure ? " invalid" : ""}`} id="join-field-disclosure" style={{ marginBottom: 0 }}>
          <label className="check">
            <input data-testid="join-disclosure" type="checkbox" checked={disclosure} onChange={(e) => setDisclosure(e.target.checked)} aria-invalid={Boolean(fieldErrors.disclosure)} />
            <span><span className="req" aria-hidden="true">* </span>{t("pages.deal.494c01fa")}</span>
          </label>
          {fieldErrors.disclosure ? <span className="field-error" data-testid="join-error-disclosure" role="alert">{fieldErrors.disclosure}</span> : null}
        </div>
        <div className={`field${fieldErrors.terms ? " invalid" : ""}`} id="join-field-terms" style={{ marginBottom: 0 }}>
          <label className="check">
            <input data-testid="join-terms" type="checkbox" checked={terms} onChange={(e) => setTerms(e.target.checked)} aria-invalid={Boolean(fieldErrors.terms)} />
            <span><span className="req" aria-hidden="true">* </span>{t("pages.deal.34303cdc")} <a href="/legal/terms" target="_blank" rel="noreferrer">{t("pages.deal.cf369f4f")}</a>  {t("pages.deal.f26be597")}</span>
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
  const dealCopy = resolveDealCopy(useSiteContent());
  const [toast, showToast] = useToast();
  const [live, setLive] = useState<Json | null>(null);
  const [notifLine, setNotifLine] = useState(t(NOTIFICATIONS_OFF_LINE_KEY));
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
    if (await copyText(trackUrl)) showToast(t("pages.deal.1c955db8"));
    else showToast(t("pages.deal.29807e19"));
  };
  return (
    <Modal title="" onClose={props.onClose}>
      <div className="share-moment success-moment" data-testid="join-success">
        <h3>{t("pages.deal.dac610e0")}</h3>
        <div className="success-facts" data-testid="join-success-facts">
          <div><b>{num(qty)}</b> {qty === 1 ? t("pages.deal.30cd9c3c") : t("pages.deal.5170f234")} · <b>{ils(total)}</b></div>
          <div>{t("pages.deal.15e14a28")} <b>{t("pages.deal.9155a6d7")}</b>{t("pages.deal.3886e231")}</div>
          <div className="muted small">{t(PILOT_MOCK_MONEY_LINE_KEY)}</div>
        </div>
        <div className="success-progress" data-testid="join-success-progress" data-to-target={toTarget}>
          <GroupMeter joined={joined} threshold={threshold} max={Number(deal.max_units)} showFlag={false} />
          <p style={{ margin: "8px 0 0", fontWeight: 700 }}>
            {toTarget > 0
              ? <>חסרות עוד <b>{num(toTarget)}</b> יחידות עד {formatIsraelDateTime(deal.deadline)} כדי שהעסקה תצא לפועל.</>
              : <>{t("pages.deal.bea161e5", { deadline: formatIsraelDateTime(deal.deadline) })}</>}
          </p>
        </div>
        {trackHash ? (
          <div className="success-track" data-testid="join-success-track">
            <a className="btn btn-primary btn-block" data-testid="join-success-track-link" href={trackHash}>
              {t("pages.deal.e564bd0f")}</a>
            <button type="button" className="btn btn-ghost btn-block btn-sm" data-testid="join-success-copy-track" onClick={copyTrack}>{t("pages.deal.e96fdefa")}</button>
            <p className="muted small" style={{ margin: "6px 0 0" }} data-testid="join-success-notif">{notifLine}</p>
          </div>
        ) : null}
        <div className="success-share" data-testid="join-success-share">
          <p style={{ fontWeight: 800, margin: "0 0 8px" }}>{dealCopy.shareTitle}</p>
          <p className="muted small" style={{ marginTop: 0 }}>{t("pages.deal.0eda93e8")}</p>
          <ShareActions layout="loop" dealId={deal.deal_id} title={deal.title} price={Number(deal.price_per_unit)} code={shareCode} onNotify={showToast} />
        </div>
        <FeedbackPrompt dealId={String(deal.deal_id)} surface="join_success" />
        <button type="button" className="linklike" data-testid="join-success-ask-seller" onClick={props.onAskSeller}>{t("pages.deal.35505d54")}</button>
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
  const [summaryPassed, setSummaryPassed] = useState(false);
  useEffect(() => {
    if (!anchor || typeof IntersectionObserver === "undefined") { setOffscreen(false); return; }
    const io = new IntersectionObserver(([entry]) => setOffscreen(!entry.isIntersecting), { threshold: 0.15 });
    io.observe(anchor);
    return () => io.disconnect();
  }, [anchor]);
  useEffect(() => {
    const summary = document.querySelector('[data-testid="deal-early-action"]');
    if (!summary || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => setSummaryPassed(entry.boundingClientRect.bottom <= 0));
    observer.observe(summary);
    return () => observer.disconnect();
  }, [anchor]);
  const show = enabled && offscreen && summaryPassed;
  return (
    <>
      <div className={`sticky-cta${show ? " show" : ""}`} data-testid="sticky-cta" data-show={show ? "1" : "0"} aria-hidden={!show}>
        <div className="sticky-cta-price"><b>{ils(price)}</b><span>{t("pages.deal.34008a98")}</span></div>
        <button type="button" className="btn btn-join" data-testid="join-open-sticky" tabIndex={show ? 0 : -1} onClick={onJoin}>{label}</button>
      </div>
      <div className="sticky-cta-spacer" aria-hidden="true" />
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
    key: "sold_out", title: t("pages.deal.ef49c6ad"),
    body: t("pages.deal.c43cb022"), ask: true, refresh: false
  };
  if (OPEN_STATES.includes(state) && deadlinePassed) return {
    key: "awaiting_decision", title: t("pages.deal.3d7283b6"),
    body: reached
      ? t("pages.deal.ca960a08")
      : t("pages.deal.29d212d0"),
    ask: true, refresh: true
  };
  if (state === "ClosedForJoining" && !deadlinePassed) return {
    key: "paused", title: t("pages.deal.b8f2d588"),
    body: t("pages.deal.531af336"), ask: true, refresh: true
  };
  if (["ClosedForJoining", "ReadyForCharging", "Charging"].includes(state)) return {
    key: "closing", title: t("pages.deal.dad557c1"),
    body: t("pages.deal.c287d890"), ask: true, refresh: false
  };
  if (state === "CompletionWindow") return {
    key: "completion_window", title: t("pages.deal.86eb860a"),
    body: t("pages.deal.00b78503"), ask: true, refresh: false
  };
  if (state === "Completed") return {
    key: "completed", title: t("pages.deal.392370e2"),
    body: t("pages.deal.4cd931cd"), ask: true, refresh: false
  };
  if (state === "Failed") return {
    key: "failed", title: t("pages.deal.9c1399a1"),
    body: reached
      ? t("pages.deal.4bf531d6")
      : t("pages.deal.71c8a904"),
    ask: true, refresh: false
  };
  if (state === "Cancelled") return {
    key: "cancelled", title: t("pages.deal.8eca7966"),
    body: t("pages.deal.452b2c33"), ask: true, refresh: false
  };
  return { key: "closed", title: buyerStateStory(state, 0), body: t("pages.deal.f27f8885"), ask: true, refresh: false };
}

// P0.7 polish — `preview` = the seller-authorized BUYER PREVIEW of the seller's
// own deal (Draft included). Same renderer, same server projection
// (/api/seller/deals/:id/preview), but read-only by construction: no join, no
// share, no chat, no inquiry, no funnel/share-visit events, no activity
// polling. A Draft is presented exactly as it will look once published.
export function DealPage({ dealId, navigate, preview = false, openInquiry = false }: {
  dealId: string; navigate: (hash: string) => void; preview?: boolean; openInquiry?: boolean;
}) {
  const dealCopy = resolveDealCopy(useSiteContent());
  const [payload, setPayload] = useState<Json | null>(null);
  const [activity, setActivity] = useState<Json | null>(null);
  const [error, setError] = useState("");
  const [receiptReady, setReceiptReady] = useState(false);
  const [errorKind, setErrorKind] = useState<"gone" | "network" | "busy" | "other">("other");
  const [qty, setQty] = useState(1);
  const [quantityValid, setQuantityValid] = useState(true);
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
        // 404 = unpublished / missing; 400 = a malformed deal id (a broken or truncated
        // link). Both mean "this link does not lead to a deal", never a server fault.
        const kind = status === 404 || status === 400 ? "gone" : !status ? "network" : status === 429 || status >= 500 ? "busy" : "other";
        setErrorKind(kind);
        setError(kind === "gone" ? t("pages.deal.7c02e6d9") : String(e?.message || localizedError(e)));
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
      <EmptyState
        level={1}
        title={preview ? t("pages.deal.b5dd662e") : network ? t("pages.deal.a13bd624") : busy ? t("pages.deal.7d12208b") : t("pages.deal.7c02e6d9")}
        body={preview
          ? t("pages.deal.f4255096")
          : network
            ? t("pages.deal.47c26a3d")
            : busy
              ? t("pages.deal.74492ea9")
              : t("pages.deal.4196dc09")}
        action={
          <div className="row" style={{ justifyContent: "center" }}>
            {network || busy ? <button className="btn btn-primary" data-testid="deal-retry" onClick={() => window.location.reload()}>{t("pages.deal.8c634e7d")}</button> : null}
            <a className="btn btn-ghost" href={preview ? "#/seller" : "#/"}>{preview ? t("pages.deal.3c54e652") : t("pages.deal.6e616914")}</a>
            {!preview && !network && !busy ? <a className="btn btn-ghost" href="#/support">{t("pages.deal.3bc1abed")}</a> : null}
          </div>
        } />
    );
  }
  if (!payload) return <BrandLoader label={t("pages.deal.7441b7d8")} minHeight={420} />;

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
    ? (soldOut ? t("pages.deal.8d502c50") : buyerStateStory(state, unitsToTarget))
    : state === "TargetReached"
      ? t("pages.deal.58e07d5d")
      : unitsToTarget > 0 ? t("pages.deal.0ad923bd", { unitsToTarget: num(unitsToTarget) }) : t("pages.deal.f3c36936");
  const startJoin = () => { if (preview) return; if (!quantityValid) { const input = document.querySelector<HTMLInputElement>('[data-testid="join-qty"]'); input?.scrollIntoView({ block: "center" }); input?.focus({ preventScroll: true }); showToast(t("pages.deal.d765cff4")); return; } if (!receiptReady) { showToast(t("pages.deal.e4ff018d")); return; } sendFunnelEvent(dealId, "join_started"); setJoining(true); };
  const startInquiry = () => { if (preview) return; sendFunnelEvent(dealId, "inquiry_started", { once_key: sessionId() }); setInquiryOpen(true); };
  const story = isOpen ? null : closedStory({ state, soldOut, timeUp, deadline: String(deal.deadline), joined, threshold: Number(deal.threshold_units) });
  const pillLabel = story?.key === "awaiting_decision" ? t("pages.deal.ff57711d") : story?.key === "paused" ? t("pages.deal.b8f2d588") : buyerStateStory(state, unitsToTarget);

  // Mobile-first: one column in EXACTLY the decision order a phone buyer
  // needs — identity, image, price, progress, deadline, quantity, delivery,
  // CTA — then everything secondary. Desktop rearranges via grid areas.
  return (
    <>
      {preview ? (
        <div className="notice info preview-banner" data-testid="preview-banner" role="status">
          <b>{t("pages.deal.abf9d0c8")}</b> — כך הקונים יראו את העסקה{rawState === "Draft" ? t("pages.deal.292e049c") : ""}.
          הצטרפות, שיתוף, צ׳אט ופנייה מושבתים כאן ואינם נספרים.{" "}
          <a href={`#/seller/deal/${dealId}`} onClick={(e) => { e.preventDefault(); navigate(`#/seller/deal/${dealId}`); }}>{t("pages.deal.e0f743d7")}</a>
        </div>
      ) : null}
      <div className="deal-page">
        {/* 1 — identity: what this is, what Siton is, who sells */}
        <div className="deal-area-head">
          <div className={`panel${celebrated ? " celebrate" : ""}`}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <StatusPill state={state} label={pillLabel} />
              <span className="staging-flag" title={t(PILOT_MOCK_MONEY_LINE_KEY)}>{t("pages.deal.bbf6c512")}</span>
            </div>
            <h1 className="deal-title" style={{ marginTop: 10, marginBottom: 0 }}>{deal.title}</h1>
            {deal.description_short ? (
              <p className="deal-short-desc">{deal.description_short}</p>
            ) : null}
            <p className="deal-explainer" data-testid="deal-explainer">{dealCopy.explainer}</p>
            {seller.business_name ? (
              <div className="deal-seller-line" data-testid="deal-seller-line">
                <span>{seller.business_name}</span>
                {seller.approved ? <span className="trust-badge" data-testid="seller-approved" title={t("pages.deal.76c0c3c6")}>{t("pages.deal.ab6c964e")}</span> : null}
                {preview ? null : <button type="button" className="linklike" data-testid="inquiry-open-top" onClick={startInquiry}>{t("pages.deal.5783968f")}</button>}
              </div>
            ) : null}
            {isOpen && !preview ? <div className="deal-early-action" data-testid="deal-early-action">
              <p><b>{t("pages.deal.d215517a", { price_per_unit: ils(deal.price_per_unit) })}</b> · יעד הקבוצה: {num(deal.threshold_units)} יחידות</p>
              <button type="button" className="btn btn-join btn-block" data-testid="join-open-summary" onClick={startJoin}>{ctaText}</button>
              <p className="muted small">{dealCopy.afterTap}</p>
            </div> : null}
          </div>
        </div>

        {/* 2 — the real product image */}
        <div className="deal-area-media">
          <Gallery images={deal.images || []} title={deal.title} type={deal.deal_type} />
        </div>

        {/* 3-8 — price → saving → why → needed → progress → deadline → qty → delivery → CTA */}
        <div className="deal-area-buy">
          {!preview ? <DealReceiptInfo dealId={dealId} onReady={setReceiptReady} /> : null}
          <div className="panel">
            {/* LAUNCH POLISH (P6) — say WHICH price this is: the group price, per unit */}
            <div className="deal-price-hero" style={{ marginTop: 0 }} data-testid="deal-price">
              <span className="price">{ils(deal.price_per_unit)}</span>
              <span className="price-unit">{t("pages.deal.e6a512a2", { deal_type: dealTypeLabel(deal.deal_type) })}</span>
            </div>
            {/* LAUNCH MODE — the saving is the whole point: show it when the seller gave a regular price */}
            {hasSaving ? (
              <div className="deal-saving" data-testid="deal-saving">
                <span className="price-was-wrap"><span className="price-was-label">{t("pages.deal.36bb7801")}</span> <span className="price-was" dir="ltr">{ils(listPrice)}</span></span>
                <span className="saving-badge">{t("pages.deal.db9d65f1", { savingPct: savingPct })}</span>
                <span className="saving-amount" data-testid="deal-saving-amount">{t("pages.deal.1fe373e6", { price_per_unit: ils(listPrice - Number(deal.price_per_unit)) })}</span>
              </div>
            ) : null}
            <p className="deal-why" data-testid="deal-why">{dealCopy.whyGroupPrice}</p>
            <div className="deal-facts" data-testid="deal-needed" data-units-to-target={unitsToTarget}>
              <div className="fact"><span className="fact-n">{num(deal.threshold_units)}</span><span className="fact-l">{t("pages.deal.24cf6de0")}</span></div>
              <div className="fact"><span className="fact-n">{num(joined)}</span><span className="fact-l">{t("pages.deal.bc120267")}</span></div>
              <div className={`fact${unitsToTarget > 0 ? " hot" : " ok"}`}><span className="fact-n">{unitsToTarget > 0 ? num(unitsToTarget) : "✓"}</span><span className="fact-l">{unitsToTarget > 0 ? t("pages.deal.1a3fe2e1") : t("pages.deal.a8a90c96")}</span></div>
            </div>
            <div style={{ margin: "12px 0 4px" }}>
              <GroupMeter large joined={joined} threshold={Number(deal.threshold_units)} max={Number(deal.max_units)} showFlag />
            </div>
            {OPEN_STATES.includes(state) ? (
              <div className="deal-countdown-block" data-testid="deal-countdown">
                <span className="deal-countdown-label">{timeUp ? t("pages.deal.7270e065") : t("pages.deal.4b6c2e39")}</span>
                <LiveCountdown deadline={deal.deadline} onZero={() => setTimeUp(true)} />
                {deadlineText ? <span className="deal-deadline-abs" data-testid="deal-deadline-abs">{t("pages.deal.b29e99f4", { deadlineText: deadlineText })}</span> : null}
              </div>
            ) : null}
            <p className="deal-facts-line muted small" data-testid="deal-facts-line">
              {num(participants)} משתתפים · נותרו במלאי <b style={remaining <= 5 ? { color: "var(--pomegranate)" } : undefined}>{num(remaining)}</b> מתוך {num(deal.max_units)}
            </p>
          </div>

          {isOpen ? (
            <div className="panel">
              <div className="panel-title">{t("pages.deal.51870bc7")}</div>
              <div className="row" style={{ justifyContent: "space-between", marginBottom: 12 }}>
                <span style={{ fontWeight: 700 }}>{t("pages.deal.24b6980b")}</span>
                <QtyInput value={Math.min(qty, maxQty)} max={maxQty} onChange={setQty} onValidityChange={setQuantityValid} testId="join-qty" ariaLabel={t("pages.deal.a36bebfc")} />
              </div>
              {deliveryOptions.length > 0 ? (
                <div className="stack" style={{ gap: 8, marginBottom: 4 }} data-testid="delivery-options">
                  <span style={{ fontWeight: 700 }}>{t("pages.deal.bd008360")}</span>
                  {deliveryOptions.map((o) => (
                    <React.Fragment key={o.option_id}>
                      {/* ROUND 2 (UX-4) — ONE canonical Siton selection card.
                          The buyer receives the goods exactly one way, so the
                          indicator is the round single-select dot; its inside
                          fills with the canonical orange when chosen, and the
                          card itself turns orange-bordered + tinted. */}
                      <label className={`choice-card delivery-option${o.option_id === deliveryId ? " selected" : ""}`} data-testid="delivery-option" data-option-type={o.option_type} data-selected={o.option_id === deliveryId ? "1" : "0"}>
                        <input type="radio" name="delivery" checked={o.option_id === deliveryId} onChange={() => setDeliveryId(o.option_id)} />
                        <span className="choice-ind choice-dot" aria-hidden="true" />
                        <span className="choice-body"><span className="choice-title">{deliveryOptionTitle(o)}</span>{o.estimate_text ? <span className="choice-sub muted small" data-testid="delivery-estimate">{o.estimate_text}</span> : null}</span>
                        <span className="delivery-cost choice-meta">{o.cost ? ils(o.cost) : t("pages.deal.323814d1")}</span>
                      </label>
                      {/* P0.7 — where exactly the buyer picks up (same renderer as the closed-state summary) */}
                      <PickupLocationLine option={o} showNav={o.option_id === deliveryId} />
                    </React.Fragment>
                  ))}
                </div>
              ) : null}
              <div className="order-summary">
                <div className="order-row"><span>{t("pages.deal.86b1b870")}</span><span>{ils(deal.price_per_unit)}</span></div>
                <div className="order-row"><span>{t("pages.deal.d4e2d05b")}</span><span>× {num(Math.min(qty, maxQty))}</span></div>
                {delivery ? <div className="order-row"><span>{DELIVERY_NAMES[delivery.option_type] || t("pages.deal.65e1ef42")}</span><span>{delivery.cost ? ils(delivery.cost) : t("pages.deal.323814d1")}</span></div> : null}
                <div className="order-row total"><span>{t("pages.deal.ce13b5b8")}</span><span>{ils(total)}</span></div>
              </div>
              <div className="order-note" style={{ margin: "12px 0" }}>
                <b>{t("pages.deal.7747ccda")}</b>  {t("pages.deal.7bab532a")}</div>
              <button className="btn btn-join btn-block" data-testid="join-open" disabled={preview} ref={setCtaEl}
                title={preview ? t("pages.deal.ffc97542") : undefined}
                onClick={startJoin}>
                {preview ? t("pages.deal.b5b52fb7") : ctaText}
              </button>
              <p className="after-tap muted small" data-testid="after-tap">{dealCopy.afterTap}</p>
              <p className="pilot-line" data-testid="pilot-line">{t(PILOT_MOCK_MONEY_LINE_KEY)}</p>
              {preview ? null : (
                <button type="button" className="btn btn-ghost btn-sm btn-block" data-testid="inquiry-open-cta" onClick={startInquiry}>{t("pages.deal.e55b737c")}</button>
              )}
            </div>
          ) : (
            <div className="panel closed-story" data-testid="closed-story" data-story={story?.key || "closed"}>
              <p style={{ fontWeight: 800, marginBottom: 4, fontSize: "1.05rem" }}>{story?.title}</p>
              <p className="muted small" style={{ marginBottom: 0 }}>{story?.body}</p>
              <div className="row" style={{ marginTop: 12, gap: 8 }}>
                {story?.refresh ? <button type="button" className="btn btn-primary btn-sm" data-testid="closed-refresh" onClick={() => window.location.reload()}>{t("pages.deal.f6e9ac12")}</button> : null}
                {story?.ask && !preview ? <button type="button" className="btn btn-ghost btn-sm" data-testid="closed-ask-seller" onClick={startInquiry}>{t("pages.deal.5783968f")}</button> : null}
              </div>
              <FulfillmentSummary options={deliveryOptions} />
            </div>
          )}

          {/* ROUND 2 (UX-6) — sharing is a HIGH-PRIORITY action, not a footnote:
              the share card now sits directly under the decision block and
              ABOVE "איך זה עובד", where a buyer who just understood the group
              rule is most likely to pass the deal on. */}
          <div className="panel share-panel" data-testid="share-invite">
            <div className="panel-title">{t("pages.deal.9a684982")}</div>
            {preview ? (
              <p className="muted small" style={{ margin: 0 }} data-testid="share-preview-note">{t("pages.deal.c2ce3295")}</p>
            ) : (
              <ShareActions compact dealId={dealId} title={deal.title} price={Number(deal.price_per_unit)} code={currentRef()} onNotify={showToast} />
            )}
          </div>

          {/* LAUNCH POLISH 2 (P1/P2) — the whole mechanism in three lines, right under the decision */}
          <div className="panel how-panel" data-testid="how-it-works">
            <div className="panel-title">{dealCopy.howTitle}</div>
            <ol className="how-strip">
              {dealCopy.howSteps.map((s) => (
                <li className="how-step" key={s.n}>
                  <span className="how-n" aria-hidden="true">{s.n}</span>
                  <div><b>{s.title}</b><p>{s.body}</p></div>
                </li>
              ))}
            </ol>
          </div>
        </div>

        {/* secondary content */}
        <div className="deal-area-rest">
          <div className="panel">
            <div className="panel-title">{t("pages.deal.a1b194f2")}</div>
            <p style={{ whiteSpace: "pre-wrap", marginBottom: 0 }}>{deal.description || deal.description_short || payload.deal?.fulfillment_copy?.what_you_get || t("pages.deal.dfe8aa50")}</p>
            {deal.voucher_terms ? (
              <div className="kv" style={{ marginTop: 12 }}>
                <span className="k">{t("pages.deal.e459323d")}</span><span className="v">{ils(deal.voucher_terms.face_value_amount)}</span>
                <span className="k">{t("pages.deal.03baa387")}</span><span className="v">{fmtDate(deal.voucher_terms.valid_until)}</span>
                {deal.voucher_terms.redemption_location ? (<><span className="k">{t("pages.deal.a458744a")}</span><span className="v">{deal.voucher_terms.redemption_location}</span></>) : null}
              </div>
            ) : null}
            {deal.ticket_terms ? (
              <div className="kv" style={{ marginTop: 12 }}>
                <span className="k">{t("pages.deal.2266a5aa")}</span><span className="v">{deal.ticket_terms.event_name}</span>
                <span className="k">{t("pages.deal.b7364c5d")}</span><span className="v">{fmtDate(deal.ticket_terms.event_starts_at)}</span>
                {deal.ticket_terms.venue_name ? (<><span className="k">{t("pages.deal.d11aea1f")}</span><span className="v">{deal.ticket_terms.venue_name}</span></>) : null}
              </div>
            ) : null}
          </div>
          <ActivityTicker activity={activity} />
          <ChatPanel dealId={dealId} canWrite={!preview && OPEN_STATES.includes(state)} preview={preview} />
          <SellerContactPanel seller={seller} onOpen={() => { if (!preview) { sendFunnelEvent(dealId, "inquiry_started", { once_key: sessionId() }); setInquiryOpen(true); } }} dealId={dealId} refreshKey={inquiryRefresh} preview={preview} />
          {preview ? null : (
            <div className="panel" style={{ textAlign: "center" }}>
              <p style={{ fontWeight: 700, marginBottom: 8 }}>{t("pages.deal.418a40a0")}</p>
              <a className="btn btn-ghost" href="#/seller/new">{t("pages.deal.24f65b11")}</a>
            </div>
          )}
        </div>
      </div>

      {isOpen && !preview ? (
        <StickyJoinBar anchor={ctaEl} enabled={!joining && !joinResult && !inquiryOpen} price={Number(deal.price_per_unit)}
          label={unitsToTarget > 0 ? t("pages.deal.3ee3db10", { unitsToTarget: num(unitsToTarget) }) : t("pages.deal.f3c36936")} onJoin={startJoin} />
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
