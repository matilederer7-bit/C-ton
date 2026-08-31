import React, { useEffect, useMemo, useState } from "react";
import { api, getSellerToken, setSellerToken, supabaseSignIn, supabaseSignUp, Json } from "../api";
import {
  Countdown, EmptyState, GroupMeter, Modal, SharePanel, Spinner, StatusPill, StatTile, Toast, copyText, useToast
} from "../components";
import {
  CLOSED_STATES, OPEN_STATES, URGENT_SELLER_STATES, countdownView, dealTypeIcon, dealTypeLabel,
  failReason, fmtDate, ils, num, stateLabel
} from "../util";
import { absoluteShareUrl } from "../viral";
import { DraftImageManager, LocalImageManager, uploadDealImage, type LocalImage, type ServerImage } from "../images";

// ── login ──────────────────────────────────────────────────────────────────
function SellerLogin({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setError(""); setInfo("");
    try {
      const cfg = await api.authConfig();
      if (!cfg.configured) throw new Error("התחברות אינה זמינה בסביבה זו");
      if (mode === "signup") {
        const r = await supabaseSignUp(cfg, email.trim(), password);
        if (r.needsConfirmation) {
          setInfo("נשלח מייל אימות — לחצו על הקישור במייל ואז התחברו כאן.");
          setMode("login");
          setBusy(false);
          return;
        }
      }
      const token = await supabaseSignIn(cfg, email.trim(), password);
      setSellerToken(token);
      onDone();
    } catch (err: any) {
      setError(err.message || "התחברות נכשלה");
      setBusy(false);
    }
  };

  return (
    <div style={{ maxWidth: 420, margin: "40px auto" }}>
      <div className="panel">
        <h2 style={{ textAlign: "center" }}>אזור המוכרים</h2>
        <p className="muted small" style={{ textAlign: "center" }}>
          חשבון אחד לכל סיטון — נהלו עסקאות קבוצתיות, עקבו אחרי כסף והפצה.
        </p>
        <form onSubmit={submit}>
          <div className="field"><label>אימייל</label><input dir="ltr" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" /></div>
          <div className="field"><label>סיסמה</label><input dir="ltr" type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === "signup" ? "new-password" : "current-password"} /></div>
          {error ? <div className="notice err">{error}</div> : null}
          {info ? <div className="notice ok">{info}</div> : null}
          <button className="btn btn-primary btn-block" disabled={busy}>
            {busy ? "רגע…" : mode === "login" ? "התחברות" : "יצירת חשבון"}
          </button>
        </form>
        <p className="small" style={{ textAlign: "center", marginTop: 12 }}>
          {mode === "login"
            ? <>עדיין אין חשבון? <a href="#/seller" onClick={(e) => { e.preventDefault(); setMode("signup"); setError(""); }}>הרשמה</a></>
            : <>כבר יש חשבון? <a href="#/seller" onClick={(e) => { e.preventDefault(); setMode("login"); setError(""); }}>התחברות</a></>}
        </p>
      </div>
    </div>
  );
}

// ── dashboard card ─────────────────────────────────────────────────────────
function SellerDealCard({ deal, navigate, showToast }: { deal: Json; navigate: (h: string) => void; showToast: (m: string) => void }) {
  const state = String(deal.state);
  const urgent = URGENT_SELLER_STATES.includes(state);
  const money = deal.money || {};
  const closed = CLOSED_STATES.includes(state);
  const potential = Number(money.potential_gross || 0);
  const charged = Number(money.charged_gross || 0);
  const showMoney = closed && state !== "Cancelled" ? charged || potential : potential;
  const pending = Number(money.recovery_pending_units || 0);
  const inWindow = state === "CompletionWindow";
  const countdownUntil = inWindow ? deal.completion_window_until : OPEN_STATES.includes(state) || state === "ClosedForJoining" ? deal.deadline : null;
  const shareable = OPEN_STATES.includes(state);
  const img = deal.images?.[0]?.url || null;
  const cd = countdownView(countdownUntil);

  return (
    <div className={`sd-card${urgent ? " urgent" : ""}`}>
      <div className="sd-main" onClick={() => navigate(`#/seller/deal/${deal.deal_id}`)} role="button" tabIndex={0}
        onKeyDown={(e) => { if (e.key === "Enter") navigate(`#/seller/deal/${deal.deal_id}`); }}>
        <div className="sd-top">
          <div className="sd-thumb">{img ? <img src={img} alt="" /> : dealTypeIcon(String(deal.deal_type || "physical_product"))}</div>
          <div className="grow">
            <div className="sd-title">{deal.title}</div>
            <StatusPill state={state} />
          </div>
        </div>
        <div className={`sd-money${state === "Failed" ? " lost" : potential <= 0 ? " zero" : ""}`}>
          {potential <= 0 && !charged ? "₪0 (עדיין אין הזמנות)" : ils(showMoney)}
          {closed && charged > 0 ? <span className="small muted"> נגבה בפועל</span> : null}
        </div>
        <div className="sd-quants">
          <span className="q-charged">מחויב: {num(money.charged_units || 0)}</span>
          <span className={`q-pending${inWindow ? " risk" : ""}`}>
            {inWindow ? "בסיכון" : "בהמתנה"}: {num(pending)}
          </span>
          <span className="q-none">לא חויב: {num(money.dropped_units || 0)}</span>
        </div>
        {countdownUntil && cd && cd.tone !== "over" ? (
          <div className="row" style={{ justifyContent: "space-between" }}>
            <Countdown until={countdownUntil} label={inWindow ? "חלון השלמה:" : "לסגירה:"} />
            {inWindow && cd.tone === "danger" ? <span style={{ color: "var(--pomegranate)", fontWeight: 800 }}>מסתיים בקרוב • {num(pending)} בהמתנה</span> : null}
          </div>
        ) : null}
        {state === "Failed" ? <div className="sd-fail-reason">{failReason({ state, joined_units: deal.metrics?.joined_units, threshold_units: deal.threshold_units })}</div> : null}
      </div>
      <div className="sd-actions">
        <button className="btn btn-sm btn-primary" onClick={() => navigate(`#/seller/deal/${deal.deal_id}`)}>כניסה לעסקה</button>
        {shareable ? (
          <button className="btn btn-sm btn-ghost" onClick={async () => {
            if (await copyText(absoluteShareUrl(deal.deal_id, null))) showToast("הקישור הועתק");
          }}>העתק לינק</button>
        ) : null}
        {closed ? (
          <button className="btn btn-sm btn-ghost" onClick={async () => {
            try {
              const r = await api.duplicateDeal(deal.deal_id);
              const newId = r?.deal?.deal_id || r?.deal_id;
              showToast("נוצרה טיוטה חדשה — בדקו את כל התנאים לפני פרסום");
              if (newId) navigate(`#/seller/deal/${newId}`);
            } catch (e: any) { showToast(e.message || "שכפול נכשל"); }
          }}>צור עסקה דומה</button>
        ) : null}
        {state === "Draft" ? <button className="btn btn-sm btn-ghost" onClick={() => navigate(`#/seller/deal/${deal.deal_id}`)}>המשך עריכה</button> : null}
      </div>
    </div>
  );
}

// ── dashboard ──────────────────────────────────────────────────────────────
function SellerDashboard({ navigate }: { navigate: (h: string) => void }) {
  const [surface, setSurface] = useState<Json | null>(null);
  const [error, setError] = useState("");
  const [updatedAt, setUpdatedAt] = useState<number>(Date.now());
  const [now, setNow] = useState(Date.now());
  const [toast, showToast] = useToast();

  const load = () =>
    api.sellerDeals()
      .then((r) => { setSurface(r.seller_surface); setUpdatedAt(Date.now()); setError(""); })
      .catch((e) => {
        if (e.status === 401 || e.status === 403) { setSellerToken(""); window.location.reload(); }
        else setError(e.message);
      });

  useEffect(() => {
    load();
    const id = setInterval(load, 25_000);
    const tick = setInterval(() => setNow(Date.now()), 10_000);
    return () => { clearInterval(id); clearInterval(tick); };
  }, []);

  const deals: Json[] = surface?.deals || [];
  const { urgentDeals, otherDeals } = useMemo(() => {
    const urgent = deals
      .filter((d) => URGENT_SELLER_STATES.includes(String(d.state)))
      .sort((a, b) => Date.parse(a.completion_window_until || a.deadline || 0) - Date.parse(b.completion_window_until || b.deadline || 0));
    const rest = deals
      .filter((d) => !URGENT_SELLER_STATES.includes(String(d.state)))
      .sort((a, b) => Date.parse(b.last_update_at || b.created_at) - Date.parse(a.last_update_at || a.created_at));
    return { urgentDeals: urgent, otherDeals: rest };
  }, [deals]);

  if (!surface && !error) return <Spinner label="טוענים את הדשבורד…" />;

  const stale = now - updatedAt > 60_000;
  const profile = surface?.seller_profile || {};
  const totalCharged = deals.reduce((s, d) => s + Number(d.money?.charged_gross || 0), 0);
  const totalPotential = deals.filter((d) => !CLOSED_STATES.includes(String(d.state))).reduce((s, d) => s + Number(d.money?.potential_gross || 0), 0);

  return (
    <>
      <div className="dash-head">
        <div>
          <h1>{profile.business_name || profile.display_name || "המוכר שלי"}</h1>
          <span className="dash-updated">מתעדכן אוטומטית · עודכן {Math.max(0, Math.round((now - updatedAt) / 1000))} שנ׳</span>
          {stale ? <span className="stale-badge" style={{ marginInlineStart: 8 }}>נתונים עלולים להיות לא עדכניים — רענן</span> : null}
        </div>
        <div className="row" style={{ marginInlineStart: "auto" }}>
          <button className="btn btn-sm btn-ghost" onClick={load} aria-label="רענון">↻ רענון</button>
          <button className="btn btn-primary" onClick={() => navigate("#/seller/new")}>+ צור עסקה חדשה</button>
          <button className="btn btn-sm btn-ghost" onClick={() => { setSellerToken(""); window.location.reload(); }}>יציאה</button>
        </div>
      </div>

      <div className="stat-row">
        <StatTile num={num(surface?.totals?.live_deals || 0)} label="עסקאות חיות" />
        <StatTile num={ils(totalPotential)} label="נפח עסקאות פעיל (מסגרות)" />
        <StatTile num={ils(totalCharged)} label="נגבה בפועל" tone="good" />
        <StatTile num={num(surface?.totals?.completed_deals || 0)} label="הושלמו" />
      </div>

      {error ? <div className="notice err">{error}</div> : null}

      {urgentDeals.length ? (
        <>
          <div className="section-title">🚨 דורש תשומת לב עכשיו <span className="count">({urgentDeals.length})</span></div>
          <div className="sd-grid">
            {urgentDeals.map((d) => <SellerDealCard key={d.deal_id} deal={d} navigate={navigate} showToast={showToast} />)}
          </div>
        </>
      ) : null}

      <div className="section-title">העסקאות שלי <span className="count">({otherDeals.length})</span></div>
      {otherDeals.length === 0 && urgentDeals.length === 0 ? (
        <EmptyState icon="🏷️" title="עדיין לא יצרת עסקאות"
          body="עסקה קבוצתית ראשונה לוקחת פחות מ־5 דקות."
          action={<button className="btn btn-primary" onClick={() => navigate("#/seller/new")}>צור עסקה ראשונה</button>} />
      ) : (
        <div className="sd-grid">
          {otherDeals.map((d) => <SellerDealCard key={d.deal_id} deal={d} navigate={navigate} showToast={showToast} />)}
        </div>
      )}
      <Toast msg={toast} />
    </>
  );
}

// ── create wizard (5 mandatory steps, one canonical model) ────────────────────
const WIZARD_STEPS = ["סוג ופרטים", "כמויות", "אספקה / מימוש", "תנאים", "סיכום ואישור"];
type WizardDealType = "physical_product" | "voucher" | "ticket";

function CreateWizard({ navigate }: { navigate: (h: string) => void }) {
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // step 1
  const [dealType, setDealType] = useState<WizardDealType>("physical_product");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [price, setPrice] = useState("");
  const [images, setImages] = useState<LocalImage[]>([]);
  const [uploadStatus, setUploadStatus] = useState("");
  // step 2
  const [minUnits, setMinUnits] = useState("10");
  const [maxUnits, setMaxUnits] = useState("50");
  // step 3
  const [delivery, setDelivery] = useState<{ option_type: string; label: string; cost: string }[]>([
    { option_type: "pickup", label: "איסוף עצמי", cost: "0" }
  ]);
  const [voucherFaceValue, setVoucherFaceValue] = useState("");
  const [voucherValidUntil, setVoucherValidUntil] = useState("");
  const [redemptionLocation, setRedemptionLocation] = useState("");
  const [redemptionInstructions, setRedemptionInstructions] = useState("");
  const [voucherTerms, setVoucherTerms] = useState("");
  const [eventName, setEventName] = useState("");
  const [eventStartsAt, setEventStartsAt] = useState("");
  const [eventEndsAt, setEventEndsAt] = useState("");
  const [venueName, setVenueName] = useState("");
  const [venueAddress, setVenueAddress] = useState("");
  const [venueCity, setVenueCity] = useState("");
  const [entryInstructions, setEntryInstructions] = useState("");
  const [ticketType, setTicketType] = useState("general_admission");
  const [seatMode, setSeatMode] = useState("general_admission");
  const [transferAllowed, setTransferAllowed] = useState(false);
  // step 4
  const [deadlineHours, setDeadlineHours] = useState("72");
  // step 5
  const [ack1, setAck1] = useState(false);
  const [ack2, setAck2] = useState(false);

  const priceNum = Number(price);
  const minNum = Math.max(1, Number(minUnits) || 0);
  const maxNum = Number(maxUnits) || 0;
  const threshold = Math.ceil(0.9 * minNum);

  const stepValid = () => {
    switch (step) {
      case 0: return title.trim().length > 0 && priceNum > 0;
      case 1: return minNum >= 1 && maxNum >= minNum;
      case 2:
        if (dealType === "physical_product") return delivery.some((d) => d.label.trim());
        if (dealType === "voucher") {
          return Number(voucherFaceValue) > 0 && new Date(`${voucherValidUntil}T23:59:59`).getTime() > Date.now() && Boolean(redemptionLocation.trim())
            && Boolean(redemptionInstructions.trim()) && Boolean(voucherTerms.trim());
        }
        return Boolean(eventName.trim()) && new Date(eventStartsAt).getTime() > Date.now()
          && Boolean(venueName.trim()) && Boolean(venueCity.trim()) && Boolean(entryInstructions.trim())
          && (!eventEndsAt || new Date(eventEndsAt).getTime() > new Date(eventStartsAt).getTime());
      case 3: { const h = Number(deadlineHours); return h >= 2 && h <= 24 * 7; }
      case 4: return ack1 && ack2;
      default: return false;
    }
  };

  const publish = async () => {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const deadline = new Date(Date.now() + Number(deadlineHours) * 3600_000).toISOString();
      const typeSpecific = dealType === "voucher" ? {
        delivery_options: [],
        voucher_terms: {
          face_value_amount: Number(voucherFaceValue),
          currency: "ILS",
          valid_until: new Date(`${voucherValidUntil}T23:59:59`).toISOString(),
          redemption_location: redemptionLocation.trim(),
          redemption_instructions: redemptionInstructions.trim(),
          terms: voucherTerms.trim(),
          is_single_use: true,
          allow_partial_redemption: false,
          voucher_code_mode: "system_generated"
        }
      } : dealType === "ticket" ? {
        delivery_options: [],
        ticket_terms: {
          event_name: eventName.trim(),
          event_starts_at: new Date(eventStartsAt).toISOString(),
          event_ends_at: eventEndsAt ? new Date(eventEndsAt).toISOString() : null,
          venue_name: venueName.trim(),
          venue_address: venueAddress.trim(),
          venue_city: venueCity.trim(),
          entry_instructions: entryInstructions.trim(),
          ticket_type: ticketType,
          seat_mode: seatMode,
          transfer_allowed: transferAllowed
        }
      } : {
        delivery_options: delivery
          .filter((d) => d.label.trim())
          .map((d, i) => ({ option_type: d.option_type, label: d.label.trim(), cost: Math.max(0, Number(d.cost) || 0), sort_order: i }))
      };
      const created = await api.createDeal({
        title: title.trim(),
        description: description.trim(),
        price_per_unit: priceNum,
        min_units: minNum,
        max_units: maxNum,
        deadline,
        deal_type: dealType,
        ...typeSpecific
      });
      const dealId = created?.deal?.deal_id || created?.deal_id;
      if (!dealId) throw new Error("יצירת העסקה נכשלה");
      // Upload BEFORE publish (images are editable only while the deal is a
      // Draft). A failed upload keeps the Draft and sends the seller to the
      // Draft screen, where the full image manager offers retry.
      for (let i = 0; i < images.length; i += 1) {
        const img = images[i];
        setUploadStatus(`מעלים תמונה ${i + 1} מתוך ${images.length}…`);
        try {
          await uploadDealImage(dealId, img, {
            isPrimary: i === 0,
            sortOrder: i,
            onProgress: (pct) => setUploadStatus(`מעלים תמונה ${i + 1} מתוך ${images.length} · ${pct}%`)
          });
        } catch (imgErr: any) {
          setUploadStatus("");
          setBusy(false);
          setError(`העסקה נשמרה כטיוטה, אך העלאת "${img.name}" נכשלה: ${imgErr.message}. אפשר להשלים את התמונות במסך הטיוטה ולפרסם משם.`);
          setTimeout(() => navigate(`#/seller/deal/${dealId}`), 3500);
          return;
        }
      }
      setUploadStatus("");
      await api.publishDeal(dealId);
      navigate(`#/seller/deal/${dealId}`);
    } catch (err: any) {
      setUploadStatus("");
      setError(err.message || "פרסום נכשל");
      setBusy(false);
    }
  };

  return (
    <div style={{ maxWidth: 640, margin: "0 auto" }}>
      <a className="back" href="#/seller" onClick={(e) => { e.preventDefault(); navigate("#/seller"); }}>→ לדשבורד</a>
      <div className="panel">
        <h2>יצירת עסקה קבוצתית</h2>
        <div className="wizard-steps">
          {WIZARD_STEPS.map((s, i) => (
            <div key={s} className={`wizard-step${i === step ? " active" : i < step ? " done" : ""}`}>{i + 1}. {s}</div>
          ))}
        </div>

        {step === 0 ? (
          <>
            <div className="field">
              <label>סוג העסקה</label>
              <select data-testid="deal-type" value={dealType} onChange={(e) => setDealType(e.target.value as WizardDealType)}>
                <option value="physical_product">מוצר פיזי</option>
                <option value="voucher">שובר</option>
                <option value="ticket">כרטיס לאירוע</option>
              </select>
              <span className="hint">השלב הבא יבקש רק את פרטי האספקה או המימוש שמתאימים לסוג שנבחר.</span>
            </div>
            <div className="field"><label>שם העסקה</label><input data-testid="deal-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} placeholder="למשל: מארז זיתי סורי 5 ק״ג" /></div>
            <div className="field"><label>תיאור קצר</label><textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={420} placeholder="מה מקבלים, למה זה משתלם" /></div>
            <div className="field"><label>מחיר ליחידה (₪)</label><input data-testid="deal-price" dir="ltr" type="number" min={1} step="0.5" value={price} onChange={(e) => setPrice(e.target.value)} /><span className="hint">המחיר יהיה נעול לאחר הפרסום</span></div>
            <div className="field">
              <label>תמונות (עד 5)</label>
              <LocalImageManager images={images} onChange={setImages} />
            </div>
          </>
        ) : null}

        {step === 1 ? (
          <>
            <div className="field-row">
              <div className="field"><label>כמות מינימום</label><input data-testid="deal-min" dir="ltr" type="number" min={1} value={minUnits} onChange={(e) => setMinUnits(e.target.value)} /><span className="hint">היעד שהקבוצה צריכה להגיע אליו</span></div>
              <div className="field"><label>כמות מקסימלית (מלאי)</label><input data-testid="deal-max" dir="ltr" type="number" min={minNum} value={maxUnits} onChange={(e) => setMaxUnits(e.target.value)} /><span className="hint">כשמגיעים — המכירה נסגרת</span></div>
            </div>
            <div className="notice info">
              סף ההצלחה הסופי הוא <b>90% מהמינימום</b> ({num(threshold)} יחידות מחויבות בפועל) —
              נקבע אוטומטית ואינו ניתן לשינוי.
            </div>
          </>
        ) : null}

        {step === 2 ? (
          <>
            {dealType === "physical_product" ? <>
            <div className="notice info">בחרו לפחות אפשרות אספקה אחת למוצר.</div>
            {delivery.map((d, i) => (
              <div className="row" key={i} style={{ marginBottom: 10, alignItems: "flex-end" }}>
                <div className="field" style={{ marginBottom: 0, width: 140 }}>
                  <label>סוג</label>
                  <select value={d.option_type} onChange={(e) => setDelivery(delivery.map((x, j) => j === i ? { ...x, option_type: e.target.value } : x))}>
                    <option value="pickup">איסוף עצמי</option>
                    <option value="delivery">משלוח</option>
                    <option value="distribution_point">נקודת חלוקה</option>
                  </select>
                </div>
                <div className="field grow" style={{ marginBottom: 0 }}>
                  <label>תיאור</label>
                  <input value={d.label} onChange={(e) => setDelivery(delivery.map((x, j) => j === i ? { ...x, label: e.target.value } : x))} placeholder="למשל: איסוף מרח׳ הרצל 12" />
                </div>
                <div className="field" style={{ marginBottom: 0, width: 110 }}>
                  <label>עלות (₪)</label>
                  <input dir="ltr" type="number" min={0} value={d.cost} onChange={(e) => setDelivery(delivery.map((x, j) => j === i ? { ...x, cost: e.target.value } : x))} />
                </div>
                {delivery.length > 1 ? <button className="x" onClick={() => setDelivery(delivery.filter((_, j) => j !== i))} aria-label="הסרה">✕</button> : null}
              </div>
            ))}
            {delivery.length < 5 ? <button className="btn btn-sm btn-ghost" onClick={() => setDelivery([...delivery, { option_type: "delivery", label: "", cost: "0" }])}>+ הוספת אפשרות</button> : null}
            </> : null}

            {dealType === "voucher" ? <>
              <div className="field-row">
                <div className="field"><label>שווי נקוב של השובר (₪)</label><input data-testid="voucher-face-value" dir="ltr" type="number" min={1} step="0.5" value={voucherFaceValue} onChange={(e) => setVoucherFaceValue(e.target.value)} /></div>
                <div className="field"><label>בתוקף עד</label><input data-testid="voucher-valid-until" dir="ltr" type="date" value={voucherValidUntil} onChange={(e) => setVoucherValidUntil(e.target.value)} /></div>
              </div>
              <div className="field"><label>מקום מימוש</label><input data-testid="voucher-location" value={redemptionLocation} onChange={(e) => setRedemptionLocation(e.target.value)} maxLength={500} placeholder="בסניפי העסק או באתר" /></div>
              <div className="field"><label>הוראות מימוש</label><textarea data-testid="voucher-instructions" rows={3} value={redemptionInstructions} onChange={(e) => setRedemptionInstructions(e.target.value)} maxLength={1000} placeholder="איך מציגים את הקוד וממשים" /></div>
              <div className="field"><label>תנאי השובר</label><textarea data-testid="voucher-terms" rows={3} value={voucherTerms} onChange={(e) => setVoucherTerms(e.target.value)} maxLength={2000} placeholder="הגבלות, כפל מבצעים ומדיניות מימוש" /></div>
              <div className="notice info">קוד השובר יופק אוטומטית רק לאחר השלמה וגבייה מוצלחת.</div>
            </> : null}

            {dealType === "ticket" ? <>
              <div className="field"><label>שם האירוע</label><input data-testid="ticket-event-name" value={eventName} onChange={(e) => setEventName(e.target.value)} maxLength={200} /></div>
              <div className="field-row">
                <div className="field"><label>מתי מתחיל</label><input data-testid="ticket-start" dir="ltr" type="datetime-local" value={eventStartsAt} onChange={(e) => setEventStartsAt(e.target.value)} /></div>
                <div className="field"><label>מתי מסתיים (רשות)</label><input dir="ltr" type="datetime-local" value={eventEndsAt} onChange={(e) => setEventEndsAt(e.target.value)} /></div>
              </div>
              <div className="field-row">
                <div className="field"><label>מקום האירוע</label><input data-testid="ticket-venue" value={venueName} onChange={(e) => setVenueName(e.target.value)} maxLength={200} /></div>
                <div className="field"><label>עיר</label><input data-testid="ticket-city" value={venueCity} onChange={(e) => setVenueCity(e.target.value)} maxLength={100} /></div>
              </div>
              <div className="field"><label>כתובת</label><input value={venueAddress} onChange={(e) => setVenueAddress(e.target.value)} maxLength={300} /></div>
              <div className="field"><label>הוראות כניסה</label><textarea data-testid="ticket-entry" rows={3} value={entryInstructions} onChange={(e) => setEntryInstructions(e.target.value)} maxLength={1000} /></div>
              <div className="field-row">
                <div className="field"><label>סוג כרטיס</label><select value={ticketType} onChange={(e) => setTicketType(e.target.value)}><option value="general_admission">כניסה כללית</option><option value="vip">VIP</option><option value="reserved_external">מקום שמור במערכת חיצונית</option><option value="other">אחר</option></select></div>
                <div className="field"><label>אופן הושבה</label><select value={seatMode} onChange={(e) => setSeatMode(e.target.value)}><option value="general_admission">ללא מקום שמור</option><option value="external_seating">שיבוץ במערכת חיצונית</option></select></div>
              </div>
              <label className="check"><input type="checkbox" checked={transferAllowed} onChange={(e) => setTransferAllowed(e.target.checked)} /><span>ניתן להעביר את הכרטיס לאדם אחר</span></label>
            </> : null}
          </>
        ) : null}

        {step === 3 ? (
          <>
            <div className="field">
              <label>דדליין להצטרפות</label>
              <select value={deadlineHours} onChange={(e) => setDeadlineHours(e.target.value)}>
                <option value="24">24 שעות</option>
                <option value="48">יומיים</option>
                <option value="72">3 ימים</option>
                <option value="120">5 ימים</option>
                <option value="168">7 ימים (מקסימום)</option>
              </select>
              <span className="hint">עד 7 ימים ממועד הפרסום, מינימום שעתיים</span>
            </div>
            <div className="notice info">
              חלון השלמה לכשלי חיוב: <b>24 שעות</b> (ברירת מחדל של המערכת).
              עמלת סיטון: <b>8% + מע״מ</b> מהסכום שנגבה בפועל בלבד.
            </div>
          </>
        ) : null}

        {step === 4 ? (
          <>
            <h3>כל התנאים הקריטיים</h3>
            {images.length ? (
              <div className="img-strip">
                {images.map((img, i) => (
                  <span key={img.id} className={`img-strip-thumb${i === 0 ? " primary" : ""}`}>
                    <img src={img.previewUrl} alt={img.name} />
                    {i === 0 ? <em>ראשית</em> : null}
                  </span>
                ))}
              </div>
            ) : <div className="notice info">לעסקה אין תמונות — מומלץ להוסיף לפחות אחת בשלב הראשון.</div>}
            <div className="kv" style={{ marginBottom: 14 }}>
              <span className="k">סוג</span><span className="v">{dealTypeLabel(dealType)}</span>
              <span className="k">שם</span><span className="v">{title}</span>
              <span className="k">מחיר ליחידה</span><span className="v">{ils(priceNum)}</span>
              <span className="k">מינימום</span><span className="v">{num(minNum)} יחידות</span>
              <span className="k">מקסימום (מלאי)</span><span className="v">{num(maxNum)} יחידות</span>
              <span className="k">סף הצלחה (90%)</span><span className="v">{num(threshold)} יחידות מחויבות</span>
              <span className="k">דדליין</span><span className="v">בעוד {deadlineHours} שעות מהפרסום</span>
              {dealType === "physical_product" ? <><span className="k">אספקה</span><span className="v">{delivery.filter((d) => d.label.trim()).map((d) => d.label).join(" · ")}</span></> : null}
              {dealType === "voucher" ? <>
                <span className="k">שווי שובר</span><span className="v">{ils(Number(voucherFaceValue))}</span>
                <span className="k">מימוש</span><span className="v">{redemptionLocation}</span>
                <span className="k">בתוקף עד</span><span className="v">{voucherValidUntil}</span>
              </> : null}
              {dealType === "ticket" ? <>
                <span className="k">אירוע</span><span className="v">{eventName}</span>
                <span className="k">מתי</span><span className="v">{eventStartsAt}</span>
                <span className="k">מקום</span><span className="v">{venueName} · {venueCity}</span>
              </> : null}
              <span className="k">עמלת סיטון</span><span className="v">8% + מע״מ מהנגבה בפועל</span>
            </div>
            <div className="publish-warning">
              <label className="check"><input data-testid="publish-lock-terms" type="checkbox" checked={ack1} onChange={(e) => setAck1(e.target.checked)} />
                <span>קראתי והבנתי כי לאחר פרסום <b>לא ניתן לשנות</b> מחיר, כמות מינימום או מקסימום, דדליין או עמלות.</span></label>
              <label className="check" style={{ marginBottom: 0 }}><input data-testid="publish-lock-threshold" type="checkbox" checked={ack2} onChange={(e) => setAck2(e.target.checked)} />
                <span>אני מאשר/ת שהתנאים סופיים, כולל כלל ה־90%: העסקה תושלם רק אם יחויבו בפועל לפחות {num(threshold)} יחידות.</span></label>
            </div>
          </>
        ) : null}

        {error ? <div className="notice err">{error}</div> : null}
        {uploadStatus ? <div className="notice info">{uploadStatus}</div> : null}
        <div className="wizard-nav">
          {step > 0 ? <button className="btn btn-ghost" onClick={() => setStep(step - 1)}>→ חזרה</button> : <span />}
          {step < 4
            ? <button data-testid="wizard-next" className="btn btn-primary" disabled={!stepValid()} onClick={() => setStep(step + 1)}>המשך ←</button>
            : <button data-testid="wizard-publish" className="btn btn-danger btn-lg" disabled={!stepValid() || busy} onClick={publish}>{busy ? (uploadStatus || "מפרסמים…") : "פרסם עסקה"}</button>}
        </div>
      </div>
    </div>
  );
}

// ── live/closed deal screen ────────────────────────────────────────────────
function whatHappensNow(deal: Json, chargedUnits: number): string {
  const state = String(deal.state);
  const joined = Number(deal.metrics?.joined_units ?? 0);
  const threshold = Number(deal.threshold_units || 0);
  switch (state) {
    case "PendingTarget":
      return joined >= threshold
        ? "אם זה יסתיים עכשיו — העסקה תעבור לסגירה."
        : `אם הדדליין יפוג עכשיו — העסקה תיכשל (חסרות ${num(Math.max(0, threshold - joined))} יחידות ליעד).`;
    case "TargetReached": return "המינימום הושג. בדדליין (או בסגירה יזומה) העסקה תעבור לחיוב.";
    case "ClosedForJoining": return "הרשימה נסגרה. המערכת מתכוננת לנעילה ולחיובים — אין צורך לעשות דבר.";
    case "ReadyForCharging": return "העסקה נעולה. החיובים יחלו אוטומטית.";
    case "Charging": return "החיובים מתבצעים כעת. כשלים יקבלו חלון השלמה של 24 שעות.";
    case "CompletionWindow":
      return chargedUnits >= threshold
        ? "כבר עברנו את סף ה־90% — אם זה יסתיים עכשיו העסקה תיסגר בהצלחה."
        : `אם חלון ההשלמה יסתיים עכשיו — העסקה תיכשל (נדרשות ${num(threshold)} יחידות מחויבות, יש ${num(chargedUnits)}).`;
    case "Completed": return "העסקה הושלמה. אפשר להתחיל אספקה ולהפיק קבלות.";
    case "Failed": return "העסקה נכשלה. כל המסגרות שוחררו וכל חיוב הוחזר.";
    case "Cancelled": return "העסקה בוטלה. המסגרות שוחררו.";
    default: return "";
  }
}

function SellerDealScreen({ dealId, navigate }: { dealId: string; navigate: (h: string) => void }) {
  const [payload, setPayload] = useState<Json | null>(null);
  const [viral, setViral] = useState<Json | null>(null);
  const [error, setError] = useState("");
  const [confirmClose, setConfirmClose] = useState(false);
  const [toast, showToast] = useToast();

  const load = () => api.sellerDeal(dealId).then(setPayload).catch((e) => setError(e.message));
  useEffect(() => {
    load();
    const id = setInterval(load, 20_000);
    api.sellerDealViral(dealId).then(setViral).catch(() => undefined);
    return () => clearInterval(id);
  }, [dealId]);

  if (error) return <EmptyState icon="⚠️" title="לא ניתן לטעון את העסקה" body={error} />;
  if (!payload?.deal) return <Spinner label="טוענים…" />;

  const deal = payload.deal;
  const state = String(deal.state);
  const participants: Json[] = payload.participants || [];
  const chargedRows = participants.filter((p) => ["ChargedSuccess", "RecoveredCharge"].includes(String(p.money_state)));
  const pendingRows = participants.filter((p) => String(p.money_state) === "ChargeFailedRecovery");
  const droppedRows = participants.filter((p) => ["Dropped", "DealFailed"].includes(String(p.buyer_state)) || String(p.money_state) === "AuthReleased");
  const chargedUnits = chargedRows.reduce((s, p) => s + Number(p.qty || 0), 0);
  const pendingUnits = pendingRows.reduce((s, p) => s + Number(p.qty || 0), 0);
  const droppedUnits = droppedRows.reduce((s, p) => s + Number(p.qty || 0), 0);
  const joined = Number(deal.metrics?.joined_units ?? participants.reduce((s, p) => s + Number(p.qty || 0), 0));
  const isOpen = OPEN_STATES.includes(state);
  const closed = CLOSED_STATES.includes(state);
  const inWindow = state === "CompletionWindow";
  const gross = chargedRows.reduce((s, p) => s + Number(p.qty) * Number(deal.price_per_unit) + Number(p.delivery_cost || 0), 0);
  const fee = Math.round(gross * 0.08 * 100) / 100;
  const vm = viral?.metrics as Json | null;

  return (
    <>
      <a className="back" href="#/seller" onClick={(e) => { e.preventDefault(); navigate("#/seller"); }}>→ לדשבורד</a>

      {/* constant header: name, image, big colored status */}
      <div className="panel">
        <div className="sd-top">
          <div className="sd-thumb">{deal.images?.[0]?.url ? <img src={deal.images[0].url} alt="" /> : dealTypeIcon(String(deal.deal_type || ""))}</div>
          <div className="grow">
            <h1 style={{ margin: 0, fontSize: "1.3rem" }}>{deal.title}</h1>
            <div className="row">
              <StatusPill state={state} />
              <span className="muted small">{dealTypeLabel(String(deal.deal_type || "physical_product"))}</span>
            </div>
          </div>
          {inWindow || state === "Charging"
            ? <Countdown until={deal.completion_window_until} label="חלון השלמה:" overText="הסתיים" />
            : !closed && state !== "Draft" ? <Countdown until={deal.deadline} label="לסגירה:" overText="עבר" /> : null}
        </div>

        <div style={{ margin: "18px 0 8px" }}>
          <GroupMeter large joined={joined} threshold={Number(deal.threshold_units)} max={Number(deal.max_units)} showFlag />
        </div>

        <div className="sd-quants" style={{ fontSize: "1rem", marginTop: 12 }}>
          <span className="q-charged">מחויב סופית: {num(chargedUnits)}</span>
          <span className={`q-pending${inWindow ? " risk" : ""}`}>{inWindow ? "ממתין לאישור סופי" : "בהמתנה"}: {num(pendingUnits)}</span>
          <span className="q-none">לא חויב: {num(droppedUnits)}</span>
        </div>
        {inWindow && pendingRows.length ? (
          <p className="small" style={{ color: "var(--saffron)", marginTop: 6 }}>
            נשלח SMS ל־{num(pendingRows.length)} קונים — עדכון אשראי תוך 24 שעות.
          </p>
        ) : null}

        <div className="notice info" style={{ marginTop: 14 }}>
          <b>מה יקרה עכשיו:</b> {whatHappensNow(deal, chargedUnits)}
        </div>

        <div className="row" style={{ marginTop: 12 }}>
          {isOpen ? (
            <>
              <button className="btn btn-ghost" onClick={() => setConfirmClose(true)}>סגור להצטרפות</button>
              <button className="btn btn-primary" onClick={async () => {
                if (await copyText(absoluteShareUrl(dealId, null))) showToast("הקישור הועתק");
              }}>שתף לינק</button>
              <a className="btn btn-ghost" href={`#/deal/${dealId}`} target="_blank">צפייה בדף הציבורי</a>
            </>
          ) : state === "Draft" ? (
            <button className="btn btn-danger" onClick={async () => {
              try { await api.publishDeal(dealId); showToast("העסקה פורסמה"); load(); }
              catch (e: any) { showToast(e.message || "פרסום נכשל"); }
            }}>פרסם עסקה</button>
          ) : closed ? (
            <button className="btn btn-ghost" onClick={async () => {
              try {
                const r = await api.duplicateDeal(dealId);
                const newId = r?.deal?.deal_id || r?.deal_id;
                if (newId) { showToast("נוצרה טיוטה — חובה לעדכן תאריכים"); navigate(`#/seller/deal/${newId}`); }
              } catch (e: any) { showToast(e.message || "שכפול נכשל"); }
            }}>צור עסקה דומה</button>
          ) : (
            <span className="muted small">העסקה נעולה לצפייה בלבד. כל הפעולות מתבצעות אוטומטית.</span>
          )}
        </div>
      </div>

      {state === "Draft" ? (
        <div className="panel">
          <div className="panel-title">🖼️ תמונות העסקה</div>
          <p className="muted small" style={{ marginTop: 0 }}>
            תמונות ניתנות לעריכה רק כל עוד העסקה בטיוטה — לאחר הפרסום הגלריה ננעלת (הקונים מצטרפים על בסיס מה שראו).
          </p>
          <DraftImageManager
            dealId={dealId}
            images={(deal.images || []) as ServerImage[]}
            onChanged={load}
          />
        </div>
      ) : null}

      {closed && state === "Completed" ? (
        <div className="panel">
          <div className="panel-title">💰 כספים (על בסיס חיובים שבוצעו בפועל)</div>
          <div className="stat-row" style={{ marginBottom: 0 }}>
            <StatTile num={ils(gross)} label="ברוטו שנגבה" tone="good" />
            <StatTile num={ils(fee)} label="עמלת סיטון (8%)" />
            <StatTile num={ils(Math.round((gross - fee * 1.18) * 100) / 100)} label="נטו משוער למוכר" sub="צפוי להעברה תוך 3–7 ימי עסקים" />
            <StatTile num={num(chargedUnits)} label="יחידות מחויבות" />
          </div>
        </div>
      ) : null}

      {closed || inWindow || state === "Charging" ? (
        <div className="panel">
          <div className="panel-title">👥 קונים {state === "Completed" ? "(מחויבים סופית)" : ""}</div>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>קונה</th><th>טלפון</th><th className="num">כמות</th><th>אופן קבלה</th><th>סטטוס כסף</th></tr></thead>
              <tbody>
                {(state === "Completed" ? chargedRows : participants).slice(0, 100).map((p) => (
                  <tr key={p.participant_id}>
                    <td>{p.buyer_name || "—"}</td>
                    <td dir="ltr">{p.buyer_phone || p.buyer_id}</td>
                    <td className="num">{num(p.qty)}</td>
                    <td>{p.delivery_method_label || "—"}</td>
                    <td><span className={`status ${["ChargedSuccess", "RecoveredCharge"].includes(String(p.money_state)) ? "Completed" : String(p.money_state) === "ChargeFailedRecovery" ? "CompletionWindow" : "ClosedForJoining"}`}>{String(p.money_state)}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {state === "Completed" ? (
            <div className="row" style={{ marginTop: 10 }}>
              <a className="btn btn-sm btn-ghost" href={`/api/seller/deals/${dealId}/export.xlsx`} target="_blank">הורד רשימת משלוחים (Excel)</a>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="panel">
        <div className="panel-title">🌱 הפצה ויראלית של העסקה</div>
        {vm ? (
          <>
            <div className="stat-row" style={{ marginBottom: 10 }}>
              <StatTile num={num((vm.viral as Json)?.attributed_participants || 0)} label="הצטרפויות דרך שיתוף" />
              <StatTile num={num((vm.viral as Json)?.attributed_charged_units || 0)} label="יחידות מחויבות מהפצה" tone="good" />
              <StatTile num={ils((vm.viral as Json)?.attributed_charged_gmv || 0)} label="ברוטו מחויב מהפצה" />
              <StatTile num={num((vm.viral as Json)?.max_generation || 0)} label="עומק שרשרת (דורות)" />
              <StatTile num={num((vm.viral as Json)?.sharing_participants || 0)} label="משתתפים שהביאו חברים" />
            </div>
            {(vm.top_sharers as Json[])?.length ? (
              <>
                <div className="section-title" style={{ margin: "10px 0 8px" }}>מפיצים אישיים מובילים</div>
                <div className="table-wrap">
                  <table className="data">
                    <thead><tr><th>משתתף</th><th className="num">הביא ישירות</th><th className="num">בכל הענף</th><th className="num">יחידות מחויבות</th><th className="num">עומק</th></tr></thead>
                    <tbody>
                      {(vm.top_sharers as Json[]).slice(0, 8).map((s) => (
                        <tr key={s.participant_id}>
                          <td>{s.display}</td>
                          <td className="num">{num(s.direct_children)}</td>
                          <td className="num">{num(s.subtree_joins)}</td>
                          <td className="num">{num(s.subtree_charged_units)}</td>
                          <td className="num">{num(s.max_depth)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            ) : <p className="muted small">עדיין אין שיתופים שהביאו הצטרפויות — כל מצטרף מקבל לינק אישי אוטומטית.</p>}
            {viral?.stale ? <p className="muted small" style={{ marginTop: 8 }}>הנתונים מחושבים ברקע · עודכנו {fmtDate(viral.computed_at)}</p> : null}
          </>
        ) : <p className="muted small">נתוני ההפצה יחושבו אחרי ההצטרפות הראשונה.</p>}
      </div>

      {confirmClose ? (
        <Modal title="סגירת העסקה להצטרפות חדשה?" onClose={() => setConfirmClose(false)}>
          <p>לאחר הסגירה לא ניתן לפתוח מחדש. משתתפים קיימים נשארים בעסקה.</p>
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <button className="btn btn-ghost" onClick={() => setConfirmClose(false)}>ביטול</button>
            <button className="btn btn-danger" onClick={async () => {
              try { await api.closeJoining(dealId); setConfirmClose(false); showToast("העסקה נסגרה להצטרפות"); load(); }
              catch (e: any) { showToast(e.message || "הסגירה נכשלה"); setConfirmClose(false); }
            }}>סגור עכשיו</button>
          </div>
        </Modal>
      ) : null}
      <Toast msg={toast} />
    </>
  );
}

// ── entry ──────────────────────────────────────────────────────────────────
export function SellerArea({ sub, navigate }: { sub: string[]; navigate: (h: string) => void }) {
  const [authed, setAuthed] = useState(Boolean(getSellerToken()));
  if (!authed) return <SellerLogin onDone={() => setAuthed(true)} />;
  if (sub[0] === "new") return <CreateWizard navigate={navigate} />;
  if (sub[0] === "deal" && sub[1]) return <SellerDealScreen dealId={sub[1]} navigate={navigate} />;
  return <SellerDashboard navigate={navigate} />;
}
