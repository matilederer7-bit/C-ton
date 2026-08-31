import React, { useEffect, useMemo, useRef, useState } from "react";
import { api, Json } from "../api";
import {
  Countdown, EmptyState, GroupMeter, Modal, SharePanel, Spinner, StatusPill, QtyStepper, Toast, useToast
} from "../components";
import { buyerStateStory, dealTypeIcon, dealTypeLabel, fmtDate, ils, initialOf, num, timeAgo } from "../util";
import { attributionHints, currentRef, recordShareVisit, sendFunnelEvent, sessionId } from "../viral";

const OPEN_STATES = ["PendingTarget", "TargetReached"];

type DeliveryOption = { option_id: string; option_type: string; label: string; cost: number };

const DELIVERY_ICONS: Record<string, string> = { delivery: "🚚", pickup: "🏪", distribution_point: "📍" };
const DELIVERY_NAMES: Record<string, string> = { delivery: "משלוח", pickup: "איסוף עצמי", distribution_point: "נקודת חלוקה" };

function Gallery({ images, title, type }: { images: { url: string }[]; title: string; type: string }) {
  const [idx, setIdx] = useState(0);
  const current = images[idx];
  return (
    <div className="deal-gallery">
      <div className="deal-gallery-main">
        {current ? <img src={current.url} alt={title} /> : <div className="placeholder">{dealTypeIcon(type)}</div>}
      </div>
      {images.length > 1 ? (
        <div className="deal-thumbs">
          {images.map((img, i) => (
            <button key={i} className={`deal-thumb${i === idx ? " active" : ""}`} onClick={() => setIdx(i)} aria-label={`תמונה ${i + 1}`}>
              <img src={img.url} alt="" />
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
              <b>{j.display}</b> הצטרף{j.qty > 1 ? <>ה עם <b>{num(j.qty)} יחידות</b></> : " לעסקה"}
            </span>
            <span className="ticker-time">{timeAgo(j.at)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ChatPanel({ dealId, canWrite }: { dealId: string; canWrite: boolean }) {
  const [messages, setMessages] = useState<Json[]>([]);
  const [name, setName] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const load = () => api.chat(dealId).then((r) => setMessages(r.messages || [])).catch(() => undefined);
  useEffect(() => {
    load();
    const id = setInterval(load, 20_000);
    return () => clearInterval(id);
  }, [dealId]);
  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!body.trim() || busy) return;
    setBusy(true);
    try {
      await api.chatPost(dealId, { body: body.trim(), display_name: name.trim() || "משתתף" });
      setBody("");
      await load();
    } catch { /* keep text for retry */ }
    setBusy(false);
  };
  return (
    <div className="panel">
      <div className="panel-title">💬 תגובות ושאלות</div>
      {messages.length === 0 ? <p className="muted small">עדיין אין תגובות — תהיו הראשונים לשאול.</p> : (
        <div className="chat-list">
          {messages.map((m) => (
            <div className="chat-msg" key={m.message_id}>
              <div className="chat-author">{m.display_name}</div>
              <div>{m.body}</div>
              <div className="chat-time">{timeAgo(m.created_at)}</div>
            </div>
          ))}
        </div>
      )}
      {canWrite ? (
        <form className="chat-form" onSubmit={send}>
          <input placeholder="שם (לא חובה)" value={name} onChange={(e) => setName(e.target.value)} style={{ maxWidth: 130 }} />
          <input placeholder="כתבו תגובה…" value={body} onChange={(e) => setBody(e.target.value)} maxLength={500} />
          <button className="btn btn-primary btn-sm" disabled={busy || !body.trim()}>שליחה</button>
        </form>
      ) : null}
    </div>
  );
}

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
    <Modal title="אישור הצטרפות לעסקה" onClose={props.onClose}>
      <form onSubmit={submit}>
        <div className="order-summary" style={{ borderTop: "none", marginTop: 0, paddingTop: 0, marginBottom: 14 }}>
          <div className="order-row"><span>{deal.title}</span><span>{num(qty)} × {ils(deal.price_per_unit)}</span></div>
          {delivery ? <div className="order-row"><span>{DELIVERY_NAMES[delivery.option_type] || delivery.label}</span><span>{delivery.cost ? ils(delivery.cost) : "חינם"}</span></div> : null}
          <div className="order-row total"><span>סה״כ לתפיסת מסגרת</span><span>{ils(total)}</span></div>
        </div>
        <div className="field"><label>שם מלא</label><input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" /></div>
        <div className="field-row">
          <div className="field"><label>טלפון נייד</label><input dir="ltr" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="tel" /></div>
          <div className="field"><label>אימייל <span className="hint">(לא חובה)</span></label><input dir="ltr" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" /></div>
        </div>
        {needsAddress ? (
          <div className="field-row">
            <div className="field"><label>כתובת למשלוח</label><input value={address} onChange={(e) => setAddress(e.target.value)} autoComplete="street-address" /></div>
            <div className="field"><label>עיר</label><input value={city} onChange={(e) => setCity(e.target.value)} /></div>
          </div>
        ) : null}
        <div className="field"><label>הערות <span className="hint">(לא חובה)</span></label><input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={200} /></div>
        <label className="check">
          <input type="checkbox" checked={disclosure} onChange={(e) => setDisclosure(e.target.checked)} />
          <span>הבנתי: הסכום תופס מסגרת אשראי בלבד. לא מתבצע חיוב בפועל עד סגירת העסקה בהצלחה, ואם העסקה לא נסגרת — המסגרת משתחררת אוטומטית.</span>
        </label>
        <label className="check">
          <input type="checkbox" checked={terms} onChange={(e) => setTerms(e.target.checked)} />
          <span>קראתי ואני מסכים/ה <a href="/legal/terms" target="_blank" rel="noreferrer">לתקנון</a> ולמדיניות הביטולים.</span>
        </label>
        {error ? <div className="notice err">{error}</div> : null}
        <button className="btn btn-join btn-block" disabled={busy}>
          {busy ? "מצטרפים…" : `הצטרפות · ${ils(total)}`}
        </button>
        <p className="muted small" style={{ textAlign: "center", marginTop: 8 }}>
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
      <div className="share-moment">
        <div style={{ fontSize: "2.4rem" }}>🎉</div>
        <h3>הצטרפת בהצלחה!</h3>
        <p>
          המסגרת נתפסה — <b>לא בוצע חיוב</b>. החיוב יתבצע רק אם העסקה תיסגר בהצלחה.
        </p>
        <p style={{ fontWeight: 700 }}>
          עזרת לעסקה להתקדם. עכשיו זה הרגע: שתפו עם חברים כדי שנגיע ליעד ביחד —
          זה הלינק האישי שלך, וכל מי שיצטרף דרכו נזקף לזכותך.
        </p>
        <SharePanel dealId={deal.deal_id} title={deal.title} code={shareCode} onCopied={() => showToast("הלינק האישי הועתק")} />
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

export function DealPage({ dealId, navigate }: { dealId: string; navigate: (hash: string) => void }) {
  const [payload, setPayload] = useState<Json | null>(null);
  const [activity, setActivity] = useState<Json | null>(null);
  const [error, setError] = useState("");
  const [qty, setQty] = useState(1);
  const [deliveryId, setDeliveryId] = useState<string>("");
  const [joining, setJoining] = useState(false);
  const [joinResult, setJoinResult] = useState<Json | null>(null);
  const [celebrated, setCelebrated] = useState(false);
  const prevState = useRef<string>("");
  const [toast, showToast] = useToast();

  useEffect(() => {
    let alive = true;
    api.deal(dealId)
      .then((res) => {
        if (!alive) return;
        setPayload(res);
        const opts: DeliveryOption[] = res.deal?.delivery_options || [];
        if (opts.length) setDeliveryId(opts[0]!.option_id);
      })
      .catch((e) => { if (alive) setError(e.status === 404 ? "העסקה אינה זמינה" : e.message); });
    sendFunnelEvent(dealId, "deal_view", { once_key: sessionId() });
    recordShareVisit(dealId, currentRef());
    return () => { alive = false; };
  }, [dealId]);

  // live layer: poll the real activity feed
  useEffect(() => {
    let alive = true;
    const load = () => api.activity(dealId).then((a) => { if (alive) setActivity(a); }).catch(() => undefined);
    load();
    const id = setInterval(load, 6_000);
    return () => { alive = false; clearInterval(id); };
  }, [dealId]);

  // celebrate the PendingTarget→TargetReached moment while viewing
  useEffect(() => {
    const s = String(activity?.state || "");
    if (prevState.current === "PendingTarget" && s === "TargetReached") setCelebrated(true);
    if (s) prevState.current = s;
  }, [activity?.state]);

  if (error) {
    return (
      <EmptyState icon="🕐" title="העסקה אינה זמינה" body="ייתכן שהעסקה הסתיימה, בוטלה או שהקישור שגוי."
        action={<a className="btn btn-primary" href="#/">לכל העסקאות במול</a>} />
    );
  }
  if (!payload) return <Spinner label="טוענים את העסקה…" />;

  const deal = payload.deal;
  const seller = payload.seller || {};
  const live = activity || {};
  const state = String(live.state || deal.state);
  const joined = Number(live.joined_units ?? payload.metrics?.joined_units ?? 0);
  const participants = Number(live.participants ?? payload.metrics?.participants_count ?? 0);
  const remaining = Number(live.remaining_units ?? payload.metrics?.remaining_units ?? 0);
  const isOpen = OPEN_STATES.includes(state) && remaining > 0;
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

  const whatsappSeller = seller.support_phone
    ? `https://wa.me/${String(seller.support_phone).replace(/[^\d]/g, "").replace(/^0/, "972")}?text=${encodeURIComponent(`היי, אני מעוניין בפרטים נוספים לגבי העסקה "${deal.title}" בסיטון`)}`
    : seller.support_email
      ? `mailto:${seller.support_email}?subject=${encodeURIComponent(`שאלה על העסקה ${deal.title}`)}`
      : null;

  return (
    <>
      <a className="back" href="#/" onClick={(e) => { e.preventDefault(); navigate("#/"); }}>→ לכל העסקאות</a>
      <div className="deal-layout">
        <div className="stack">
          <Gallery images={deal.images || []} title={deal.title} type={deal.deal_type} />
          <div className="panel">
            <div className="panel-title">📦 מה מקבלים</div>
            <p style={{ whiteSpace: "pre-wrap", marginBottom: 0 }}>{deal.description || payload.deal?.fulfillment_copy?.what_you_get || "פרטי המוצר יופיעו כאן."}</p>
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
          <ChatPanel dealId={dealId} canWrite={OPEN_STATES.includes(state)} />
        </div>

        <div className="stack">
          <div className={`panel${celebrated ? " celebrate" : ""}`}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <StatusPill state={state} label={buyerStateStory(state, unitsToTarget)} />
              <span className="staging-flag">סביבת הדגמה</span>
            </div>
            <h1 className="deal-title" style={{ marginTop: 10 }}>{deal.title}</h1>
            {seller.business_name ? (
              <div className="deal-seller-line">🏪 {seller.business_name}</div>
            ) : null}
            <div className="deal-price-hero">
              <span className="price">{ils(deal.price_per_unit)}</span>
              <span className="price-unit">ליחידה · {dealTypeLabel(deal.deal_type)}</span>
            </div>
            <div style={{ margin: "16px 0 4px" }}>
              <GroupMeter large joined={joined} threshold={Number(deal.threshold_units)} max={Number(deal.max_units)} showFlag />
            </div>
            <div className="kv" style={{ marginTop: 14 }}>
              <span className="k">משתתפים</span><span className="v">{num(participants)}</span>
              <span className="k">מלאי נותר</span>
              <span className="v" style={remaining <= 5 ? { color: "var(--pomegranate)" } : undefined}>{num(remaining)} מתוך {num(deal.max_units)}</span>
              <span className="k">מינימום לעסקה</span><span className="v">{num(deal.min_units)} יחידות</span>
              <span className="k">דדליין</span>
              <span className="v"><Countdown until={deal.deadline} overText="הסתיים" /></span>
            </div>
          </div>

          {isOpen ? (
            <div className="panel">
              <div className="panel-title">🛒 ההזמנה שלי</div>
              <div className="row" style={{ justifyContent: "space-between", marginBottom: 12 }}>
                <span style={{ fontWeight: 700 }}>כמות יחידות</span>
                <QtyStepper value={Math.min(qty, maxQty)} max={maxQty} onChange={setQty} />
              </div>
              {deliveryOptions.length > 0 ? (
                <div className="stack" style={{ gap: 8, marginBottom: 4 }}>
                  <span style={{ fontWeight: 700 }}>אופן קבלה</span>
                  {deliveryOptions.map((o) => (
                    <label key={o.option_id} className={`delivery-option${o.option_id === deliveryId ? " selected" : ""}`}>
                      <input type="radio" name="delivery" checked={o.option_id === deliveryId} onChange={() => setDeliveryId(o.option_id)} />
                      <span>{DELIVERY_ICONS[o.option_type] || "📦"} {o.label || DELIVERY_NAMES[o.option_type]}</span>
                      <span className="delivery-cost">{o.cost ? ils(o.cost) : "חינם"}</span>
                    </label>
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
              <button className="btn btn-join btn-block" onClick={() => { sendFunnelEvent(dealId, "join_started"); setJoining(true); }}>
                {ctaText}
              </button>
            </div>
          ) : (
            <div className="panel">
              <p style={{ fontWeight: 700, marginBottom: 4 }}>{soldOut ? "המלאי אזל — המכירה הסתיימה" : buyerStateStory(state, unitsToTarget)}</p>
              <p className="muted small" style={{ marginBottom: 0 }}>
                {state === "Completed" ? "העסקה הושלמה — המצטרפים חויבו וקיבלו עדכון." : "לא ניתן להצטרף לעסקה במצבה הנוכחי."}
              </p>
            </div>
          )}

          <div className="panel">
            <div className="panel-title">📣 מכירים מישהו שזה יעניין אותו?</div>
            <SharePanel compact dealId={dealId} title={deal.title} code={currentRef()} onCopied={() => showToast("הלינק הועתק")} />
          </div>

          {whatsappSeller ? (
            <div className="panel">
              <div className="panel-title">🏪 המוכר</div>
              <p style={{ marginBottom: 8 }}><b>{seller.business_name || "המוכר"}</b></p>
              {seller.business_description ? <p className="muted small">{seller.business_description}</p> : null}
              <a className="btn btn-ghost" href={whatsappSeller} target="_blank" rel="noreferrer">שאלות? צרו קשר עם המוכר</a>
            </div>
          ) : null}
        </div>
      </div>

      {joining && !joinResult ? (
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
