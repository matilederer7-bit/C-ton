import React, { useEffect, useMemo, useRef, useState } from "react";
import { api, clearAuthSession, getSellerToken, Json } from "../api";
import { clearOwnerSession } from "../ownerMode";
import { AuthPanel } from "../auth";
import {
  BrandLoader, Countdown, EmptyState, GroupMeter, Modal, StatusPill, StatTile, Toast, copyText, useToast
} from "../components";
import { LiveCountdown } from "../livecountdown";
import {
  CLOSED_STATES, OPEN_STATES, URGENT_SELLER_STATES, countdownView, dealTypeIcon, dealTypeLabel,
  failReason, fmtDate, formatIsraelDateTime, ils, israelPartsToUtcIso, moneyStateLabel, num, utcIsoToIsraelParts
} from "../util";
import { absoluteShareUrl } from "../viral";
import { DraftImageManager, LocalImageManager, uploadDealImage, type LocalImage, type ServerImage } from "../images";
import { ActionCenterPanel, ActivityPanel, ChartsPanel, FunnelPanel, KpiStrip, MoneyPanel, ViralPanel } from "./sellerCommand";
import { VTreeCanvas, type VNode } from "../vtree";

// ── login (the shared truthful auth panel) ─────────────────────────────────
function SellerLogin({ onDone, initialMode }: { onDone: () => void; initialMode?: "login" | "signup" }) {
  return (
    <AuthPanel
      surface="seller"
      title="אזור המוכרים"
      subtitle="חשבון אחד לכל C-ton — נהלו עסקאות קבוצתיות, עקבו אחרי כסף והפצה."
      initialMode={initialMode}
      signupLabel="פתיחת חשבון מוכר"
      onDone={onDone}
    />
  );
}

// ── controlled Hebrew validation helpers (P0.2-D) ──────────────────────────
function focusField(key: string) {
  const el = document.getElementById(`f-${key}`);
  if (el) {
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    (el as HTMLElement).focus?.();
  }
}

function FieldError({ msg }: { msg?: string }) {
  if (!msg) return null;
  return <span className="field-error">{msg}</span>;
}

// ── dashboard card — ONE obvious primary intent per state (P0.2-J) ─────────
function SellerDealCard({ deal, navigate, showToast }: { deal: Json; navigate: (h: string) => void; showToast: (m: string) => void }) {
  const state = String(deal.state);
  const urgent = URGENT_SELLER_STATES.includes(state);
  const money = deal.money || {};
  const closed = CLOSED_STATES.includes(state);
  const isOpen = OPEN_STATES.includes(state);
  const potential = Number(money.potential_gross || 0);
  const charged = Number(money.charged_gross || 0);
  const showMoney = closed && state !== "Cancelled" ? charged || potential : potential;
  const pending = Number(money.recovery_pending_units || 0);
  const inWindow = state === "CompletionWindow";
  const countdownUntil = inWindow ? deal.completion_window_until : isOpen || state === "ClosedForJoining" ? deal.deadline : null;
  const img = deal.images?.[0]?.url || null;
  const cd = countdownView(countdownUntil);
  const open = () => navigate(`#/seller/deal/${deal.deal_id}`);

  const primaryLabel = state === "Draft" ? "המשך עריכה" : closed ? "צפייה בסיכום" : "ניהול העסקה";

  return (
    <div className={`sd-card${urgent ? " urgent" : ""}`}>
      <div className="sd-main" onClick={open} role="button" tabIndex={0}
        onKeyDown={(e) => { if (e.key === "Enter") open(); }}>
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
        {state !== "Draft" ? (
          <div className="sd-quants">
            <span className="q-charged">חויב בהצלחה: {num(money.charged_units || 0)}</span>
            <span className={`q-pending${inWindow ? " risk" : ""}`}>
              {inWindow ? "בסיכון" : "בהמתנה"}: {num(pending)}
            </span>
            <span className="q-none">לא חויב: {num(money.dropped_units || 0)}</span>
          </div>
        ) : null}
        {countdownUntil && cd && cd.tone !== "over" ? (
          <div className="row" style={{ justifyContent: "space-between" }}>
            <Countdown until={countdownUntil} label={inWindow ? "חלון השלמה:" : "לסגירה:"} />
            {inWindow && cd.tone === "danger" ? <span style={{ color: "var(--pomegranate)", fontWeight: 800 }}>מסתיים בקרוב • {num(pending)} בהמתנה</span> : null}
          </div>
        ) : null}
        {state === "Failed" ? <div className="sd-fail-reason">{failReason({ state, joined_units: deal.metrics?.joined_units, threshold_units: deal.threshold_units })}</div> : null}
      </div>
      <div className="sd-actions">
        <button className="btn btn-sm btn-primary" onClick={open}>{primaryLabel}</button>
        {isOpen ? (
          <button className="btn btn-sm btn-ghost" onClick={async () => {
            if (await copyText(absoluteShareUrl(deal.deal_id, null))) showToast("הקישור הועתק");
          }}>העתקת קישור</button>
        ) : null}
        {closed ? (
          <button className="btn btn-sm btn-ghost" onClick={async () => {
            try {
              const r = await api.duplicateDeal(deal.deal_id);
              const newId = r?.deal?.deal_id || r?.deal_id;
              showToast("נוצרה טיוטה חדשה — בדקו את כל הפרטים לפני פרסום");
              if (newId) navigate(`#/seller/deal/${newId}`);
            } catch (e: any) { showToast(e.message || "השכפול נכשל"); }
          }}>יצירת עסקה דומה</button>
        ) : null}
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
  const [bizStatuses, setBizStatuses] = useState<Json | null>(null);
  // P0.4-2 — command-center analytics: ONE bounded aggregate call (no N+1)
  const [analytics, setAnalytics] = useState<Json | null>(null);
  const [analyticsError, setAnalyticsError] = useState("");
  const [aPeriod, setAPeriod] = useState<"7d" | "30d" | "all">("all");
  const [aDeal, setADeal] = useState("");
  const [toast, showToast] = useToast();

  // P0.4-1: a single transient 401 right after login must not nuke a fresh
  // legitimate session (the api layer already refresh-retries once) — retry
  // the LOAD once before concluding the session is genuinely dead.
  const authRetriedRef = useRef(false);
  const load = () =>
    api.sellerDeals()
      .then((r) => { setSurface(r.seller_surface); setUpdatedAt(Date.now()); setError(""); authRetriedRef.current = false; })
      .catch((e) => {
        if (e.status === 401 || e.status === 403) {
          if (!authRetriedRef.current) {
            authRetriedRef.current = true;
            setTimeout(() => { void load(); }, 1200);
            return;
          }
          clearAuthSession(); clearOwnerSession(); window.location.reload();
        } else setError(e.message);
      });

  useEffect(() => {
    load();
    api.sellerBusinessProfile().then((r) => setBizStatuses(r.statuses || null)).catch(() => undefined);
    const id = setInterval(load, 25_000);
    const tick = setInterval(() => setNow(Date.now()), 10_000);
    return () => { clearInterval(id); clearInterval(tick); };
  }, []);

  useEffect(() => {
    let alive = true;
    setAnalyticsError("");
    api.sellerAnalytics(aPeriod, aDeal)
      .then((r) => { if (alive) setAnalytics(r); })
      .catch((e) => { if (alive) setAnalyticsError(e.message); });
    return () => { alive = false; };
  }, [aPeriod, aDeal]);

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

  if (!surface && !error) return <BrandLoader label="טוענים את הדשבורד…" minHeight={420} />;

  const stale = now - updatedAt > 60_000;
  const profile = surface?.seller_profile || {};
  const totalCharged = deals.reduce((s, d) => s + Number(d.money?.charged_gross || 0), 0);
  const totalPotential = deals.filter((d) => !CLOSED_STATES.includes(String(d.state))).reduce((s, d) => s + Number(d.money?.potential_gross || 0), 0);

  return (
    <>
      <div className="dash-head">
        <div>
          <h1>{profile.business_name || profile.display_name || "המוכר שלי"}</h1>
          <span className="dash-updated">מתעדכן אוטומטית · עודכן לפני {Math.max(0, Math.round((now - updatedAt) / 1000))} שניות</span>
          {stale ? <span className="stale-badge" style={{ marginInlineStart: 8 }}>הנתונים עלולים להיות לא עדכניים — רעננו</span> : null}
        </div>
        <div className="row" style={{ marginInlineStart: "auto" }}>
          <button className="btn btn-sm btn-ghost" onClick={load} aria-label="רענון">↻ רענון</button>
          <button className="btn btn-sm btn-ghost" onClick={() => navigate("#/seller/profile")}>🏢 פרופיל עסקי</button>
          <button className="btn btn-primary" onClick={() => navigate("#/seller/new")}>+ יצירת עסקה חדשה</button>
          <button className="btn btn-sm btn-ghost" onClick={() => { clearAuthSession(); clearOwnerSession(); window.location.reload(); }}>יציאה</button>
        </div>
      </div>

      {bizStatuses && (!bizStatuses.profile_complete || !bizStatuses.settlement_ready) ? (
        <div className="notice info" style={{ display: "flex", gap: 12, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }}>
          <span>
            <b>הפרופיל העסקי עדיין לא הושלם</b> — {!bizStatuses.profile_complete ? "חסרים פרטי העסק ואיש הקשר" : "חסרים פרטי חשבון הבנק לקבלת כספים"}.
          </span>
          <button className="btn btn-sm btn-primary" onClick={() => navigate("#/seller/profile")}>השלמת הפרופיל</button>
        </div>
      ) : null}

      {error ? <div className="notice err">{error}</div> : null}

      {/* P0.4-2A — global seller KPI strip (canonical analytics; potential vs charged vs net) */}
      {analytics ? <KpiStrip analytics={analytics} /> : (
        <div className="stat-row">
          <StatTile num={num(surface?.totals?.live_deals || 0)} label="עסקאות חיות" />
          <StatTile num={ils(totalPotential)} label="נפח עסקאות פעיל (מסגרות)" />
          <StatTile num={ils(totalCharged)} label="נגבה בפועל" tone="good" />
          <StatTile num={num(surface?.totals?.completed_deals || 0)} label="הושלמו" />
        </div>
      )}

      {/* P0.4-2H — action center, high on the page */}
      {analytics ? <ActionCenterPanel items={analytics.action_center || []} navigate={navigate} /> : null}

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
          action={<button className="btn btn-primary" onClick={() => navigate("#/seller/new")}>יצירת עסקה ראשונה</button>} />
      ) : (
        <div className="sd-grid">
          {otherDeals.map((d) => <SellerDealCard key={d.deal_id} deal={d} navigate={navigate} showToast={showToast} />)}
        </div>
      )}

      {/* P0.4-2G/C/D/F/I — money, trends, funnel, viral, activity */}
      {analytics ? (
        <>
          <MoneyPanel analytics={analytics} />
          <div className="panel analytics-filters" data-testid="analytics-filters">
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontWeight: 700 }}>תקופה:</span>
              {([["7d", "7 ימים"], ["30d", "30 ימים"], ["all", "כל התקופה"]] as const).map(([value, label]) => (
                <button key={value} className={`btn btn-sm ${aPeriod === value ? "btn-primary" : "btn-ghost"}`} onClick={() => setAPeriod(value)}>{label}</button>
              ))}
              <span style={{ fontWeight: 700, marginInlineStart: 12 }}>עסקה:</span>
              <select value={aDeal} onChange={(e) => setADeal(e.target.value)} style={{ maxWidth: 240 }}>
                <option value="">כל העסקאות</option>
                {deals.map((d) => <option key={d.deal_id} value={d.deal_id}>{d.title}</option>)}
              </select>
            </div>
          </div>
          <ChartsPanel analytics={analytics} />
          <FunnelPanel analytics={analytics} />
          <ViralPanel analytics={analytics} dealScope={aDeal} navigate={navigate} />
          <ActivityPanel items={analytics.recent_activity || []} />
        </>
      ) : analyticsError ? (
        <div className="notice err">טעינת האנליטיקות נכשלה: {analyticsError}</div>
      ) : (
        <div className="panel"><p className="muted small" style={{ margin: 0 }}>טוענים אנליטיקות…</p></div>
      )}
      <Toast msg={toast} />
    </>
  );
}

// ── deadline picker (P0.2-F): calendar date + exact time, Israel wall clock ─
function DeadlinePicker(props: {
  date: string; time: string;
  onDate: (v: string) => void; onTime: (v: string) => void;
  error?: string;
  idPrefix?: string;
}) {
  const prefix = props.idPrefix || "deadline";
  const iso = israelPartsToUtcIso(props.date, props.time);
  const todayIsrael = utcIsoToIsraelParts(new Date().toISOString()).date;
  const maxIsrael = utcIsoToIsraelParts(new Date(Date.now() + 7 * 864e5).toISOString()).date;
  return (
    <div className="field">
      <label>מועד סיום ההצטרפות <span className="req">*</span> <span className="hint">(שעון ישראל)</span></label>
      <div className="deadline-row">
        <input id={`f-${prefix}-date`} dir="ltr" type="date" value={props.date} min={todayIsrael} max={maxIsrael}
          className={props.error ? "invalid" : ""} onChange={(e) => props.onDate(e.target.value)} />
        <input id={`f-${prefix}-time`} dir="ltr" type="time" value={props.time}
          className={props.error ? "invalid" : ""} onChange={(e) => props.onTime(e.target.value)} />
      </div>
      <FieldError msg={props.error} />
      {iso && !props.error ? (
        <span className="deadline-confirm">✓ {formatIsraelDateTime(iso)}</span>
      ) : null}
      <span className="hint">בין שעתיים ל-7 ימים מרגע הפרסום.</span>
    </div>
  );
}

function validateDeadline(date: string, time: string): { iso: string | null; error: string } {
  if (!date || !time) return { iso: null, error: "יש לבחור תאריך ושעה למועד הסיום" };
  const iso = israelPartsToUtcIso(date, time);
  if (!iso) return { iso: null, error: "יש לבחור תאריך ושעה תקינים" };
  const ms = Date.parse(iso) - Date.now();
  if (ms < 2 * 3600_000) return { iso, error: "מועד הסיום חייב להיות לפחות שעתיים מעכשיו" };
  if (ms > 7 * 24 * 3600_000) return { iso, error: "מועד הסיום יכול להיות עד 7 ימים קדימה" };
  return { iso, error: "" };
}

// ── create wizard — saves a Draft and lands INSIDE the deal (P0.2-G) ───────
const WIZARD_STEPS = ["פרטי העסקה", "כמויות", "אספקה / מימוש", "מועד סיום", "סיכום ושמירה"];
type WizardDealType = "physical_product" | "voucher" | "ticket";
type DeliveryDraft = { option_type: string; label: string; cost: string; latitude: number | null; longitude: number | null };

// P0.3-18 — pickup GPS. Location is captured ONLY on the seller's explicit
// click (no ambient geolocation), stored as plain lat/lng, no map provider.
function LocationCapture({ row, onSet }: { row: DeliveryDraft; onSet: (lat: number | null, lng: number | null) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  if (row.option_type === "delivery") return null;
  if (row.latitude != null && row.longitude != null) {
    return (
      <div className="row" style={{ gap: 8, marginTop: -4, marginBottom: 10 }}>
        <span className="small" style={{ fontWeight: 700 }}>📍 מיקום נשמר ({row.latitude.toFixed(4)}, {row.longitude.toFixed(4)}) — הקונים יקבלו כפתור ניווט</span>
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => onSet(null, null)}>הסרת המיקום</button>
      </div>
    );
  }
  return (
    <div className="stack" style={{ gap: 4, marginTop: -4, marginBottom: 10 }}>
      <button type="button" className="btn btn-sm btn-ghost" disabled={busy} data-testid="use-my-location" onClick={() => {
        setErr("");
        if (!navigator.geolocation) { setErr("הדפדפן לא תומך באיתור מיקום — אפשר להמשיך בלי"); return; }
        setBusy(true);
        navigator.geolocation.getCurrentPosition(
          (pos) => { setBusy(false); onSet(pos.coords.latitude, pos.coords.longitude); },
          (geErr) => {
            setBusy(false);
            setErr(geErr.code === 1 ? "לא ניתנה הרשאת מיקום — אפשר להמשיך בלי, או לאשר בהגדרות הדפדפן" : "איתור המיקום נכשל — נסו שוב");
          },
          { enableHighAccuracy: true, timeout: 15_000 }
        );
      }}>{busy ? "מאתרים מיקום…" : "📍 השתמש במיקום שלי"}</button>
      <span className="hint">לא חובה — מוסיף לקונים כפתור ניווט לנקודת האיסוף.</span>
      {err ? <span className="field-error">{err}</span> : null}
    </div>
  );
}

function CreateWizard({ navigate }: { navigate: (h: string) => void }) {
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  // step 1
  const [dealType, setDealType] = useState<WizardDealType>("physical_product");
  const [title, setTitle] = useState("");
  const [shortDesc, setShortDesc] = useState("");
  const [longDesc, setLongDesc] = useState("");
  const [price, setPrice] = useState("");
  const [images, setImages] = useState<LocalImage[]>([]);
  const [uploadStatus, setUploadStatus] = useState("");
  // step 2
  const [minUnits, setMinUnits] = useState("10");
  const [maxUnits, setMaxUnits] = useState("50");
  // step 3
  const [delivery, setDelivery] = useState<DeliveryDraft[]>([
    { option_type: "pickup", label: "איסוף עצמי", cost: "0", latitude: null, longitude: null }
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
  // step 4 — exact Israel-time deadline
  const [deadlineDate, setDeadlineDate] = useState("");
  const [deadlineTime, setDeadlineTime] = useState("18:00");

  const priceNum = Number(price);
  const minNum = Math.max(1, Number(minUnits) || 0);
  const maxNum = Number(maxUnits) || 0;
  const threshold = Math.ceil(0.9 * minNum);
  const deadlineCheck = validateDeadline(deadlineDate, deadlineTime);

  // Explicit, explained validation (P0.2-D): the button never silently does
  // nothing — a failed step marks each field, shows a Hebrew message under it,
  // and scrolls to the first problem.
  const validateStep = (s: number): Record<string, string> => {
    const errs: Record<string, string> = {};
    if (s === 0) {
      if (!title.trim()) errs.title = "יש להזין שם לעסקה";
      if (!shortDesc.trim()) errs.short = "יש להזין תיאור קצר — המשפט שמוכר את העסקה";
      if (!(priceNum > 0)) errs.price = "יש להזין מחיר ליחידה";
      if (images.length === 0) errs.images = "יש להעלות לפחות תמונה אחת";
    }
    if (s === 1) {
      if (!(minNum >= 1)) errs.min = "יש להזין כמות מינימום";
      if (!(maxNum >= minNum)) errs.max = "כמות המקסימום חייבת להיות לפחות כמו המינימום";
    }
    if (s === 2) {
      if (dealType === "physical_product" && !delivery.some((d) => d.label.trim())) errs.delivery = "יש להוסיף לפחות אפשרות אספקה אחת";
      if (dealType === "voucher") {
        if (!(Number(voucherFaceValue) > 0)) errs.voucherFace = "יש להזין את שווי השובר";
        if (!voucherValidUntil || new Date(`${voucherValidUntil}T23:59:59`).getTime() <= Date.now()) errs.voucherValid = "יש לבחור תוקף עתידי לשובר";
        if (!redemptionLocation.trim()) errs.voucherLocation = "יש להזין מקום מימוש";
        if (!redemptionInstructions.trim()) errs.voucherInstructions = "יש להזין הוראות מימוש";
        if (!voucherTerms.trim()) errs.voucherTerms = "יש להזין את תנאי השובר";
      }
      if (dealType === "ticket") {
        if (!eventName.trim()) errs.eventName = "יש להזין שם אירוע";
        if (!eventStartsAt || new Date(eventStartsAt).getTime() <= Date.now()) errs.eventStart = "יש לבחור מועד עתידי לאירוע";
        if (!venueName.trim()) errs.venueName = "יש להזין את מקום האירוע";
        if (!venueCity.trim()) errs.venueCity = "יש להזין עיר";
        if (!entryInstructions.trim()) errs.entry = "יש להזין הוראות כניסה";
        if (eventEndsAt && new Date(eventEndsAt).getTime() <= new Date(eventStartsAt).getTime()) errs.eventEnd = "מועד הסיום חייב להיות אחרי ההתחלה";
      }
    }
    if (s === 3 && deadlineCheck.error) errs.deadline = deadlineCheck.error;
    return errs;
  };

  const continueStep = () => {
    const errs = validateStep(step);
    setErrors(errs);
    const first = Object.keys(errs)[0];
    if (first) { focusField(first); return; }
    setStep(step + 1);
  };

  const save = async () => {
    if (busy) return;
    for (let s = 0; s <= 3; s++) {
      const errs = validateStep(s);
      if (Object.keys(errs).length) { setStep(s); setErrors(errs); focusField(Object.keys(errs)[0]!); return; }
    }
    setBusy(true); setError("");
    try {
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
          .map((d, i) => ({
            option_type: d.option_type, label: d.label.trim(), cost: Math.max(0, Number(d.cost) || 0), sort_order: i,
            ...(d.latitude != null && d.longitude != null ? { latitude: d.latitude, longitude: d.longitude } : {})
          }))
      };
      const created = await api.createDeal({
        title: title.trim(),
        description: longDesc.trim(),
        description_short: shortDesc.trim(),
        price_per_unit: priceNum,
        min_units: minNum,
        max_units: maxNum,
        deadline: deadlineCheck.iso,
        deal_type: dealType,
        ...typeSpecific
      });
      const dealId = created?.deal?.deal_id || created?.deal_id;
      if (!dealId) throw new Error("יצירת העסקה נכשלה — נסו שוב");
      // Upload images while still a Draft; a failed upload keeps the Draft
      // and the deal screen's image manager offers a retry.
      for (let i = 0; i < images.length; i += 1) {
        const img = images[i]!;
        setUploadStatus(`מעלים תמונה ${i + 1} מתוך ${images.length}…`);
        try {
          await uploadDealImage(dealId, img, {
            isPrimary: i === 0,
            sortOrder: i,
            onProgress: (pct) => setUploadStatus(`מעלים תמונה ${i + 1} מתוך ${images.length} · ${pct}%`)
          });
        } catch (imgErr: any) {
          setUploadStatus("");
          setError(`הטיוטה נשמרה, אך העלאת "${img.name}" נכשלה. אפשר להשלים את התמונות במסך העסקה.`);
          setTimeout(() => navigate(`#/seller/deal/${dealId}`), 2200);
          return;
        }
      }
      setUploadStatus("");
      // Land INSIDE the deal — its screen shows the Draft banner + publish CTA.
      navigate(`#/seller/deal/${dealId}`);
    } catch (err: any) {
      setUploadStatus("");
      setError(err.message || "השמירה נכשלה — נסו שוב");
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
            <div className="field">
              <label>שם העסקה <span className="req">*</span></label>
              <input id="f-title" data-testid="deal-title" className={errors.title ? "invalid" : ""} value={title}
                onChange={(e) => setTitle(e.target.value)} maxLength={200} placeholder="למשל: מארז זיתי סורי 5 ק״ג" />
              <FieldError msg={errors.title} />
            </div>
            <div className="field">
              <label>תיאור קצר <span className="req">*</span> <span className="hint">(המשפט שמוכר — מופיע בראש העסקה ובשיתופים, עד 200 תווים)</span></label>
              <input id="f-short" data-testid="deal-short" className={errors.short ? "invalid" : ""} value={shortDesc}
                onChange={(e) => setShortDesc(e.target.value)} maxLength={200} placeholder="למשל: זיתים חצי במחיר — רק כשנסגרים 20 מארזים" />
              <FieldError msg={errors.short} />
            </div>
            <div className="field">
              <label>תיאור מלא <span className="hint">(לא חובה — כל מה שחשוב לקונים, מופיע בהמשך דף העסקה)</span></label>
              <textarea id="f-long" data-testid="deal-long" rows={6} value={longDesc} onChange={(e) => setLongDesc(e.target.value)} maxLength={4000}
                placeholder="מה בדיוק מקבלים, איך זה מגיע, למה זה משתלם…" />
            </div>
            <div className="field">
              <label>מחיר ליחידה (₪) <span className="req">*</span></label>
              <input id="f-price" data-testid="deal-price" dir="ltr" type="number" min={1} step="0.5" className={errors.price ? "invalid" : ""}
                value={price} onChange={(e) => setPrice(e.target.value)} />
              <FieldError msg={errors.price} />
              <span className="hint">המחיר ננעל לאחר הפרסום</span>
            </div>
            <div className="field" id="f-images" tabIndex={-1}>
              <label>תמונות (עד 12) <span className="req">*</span></label>
              <LocalImageManager images={images} onChange={setImages} />
              <FieldError msg={errors.images} />
            </div>
          </>
        ) : null}

        {step === 1 ? (
          <>
            <div className="field-row">
              <div className="field">
                <label>כמות מינימום <span className="req">*</span></label>
                <input id="f-min" data-testid="deal-min" dir="ltr" type="number" min={1} className={errors.min ? "invalid" : ""}
                  value={minUnits} onChange={(e) => setMinUnits(e.target.value)} />
                <FieldError msg={errors.min} />
                <span className="hint">היעד שהקבוצה צריכה להגיע אליו</span>
              </div>
              <div className="field">
                <label>כמות מקסימלית (מלאי) <span className="req">*</span></label>
                <input id="f-max" data-testid="deal-max" dir="ltr" type="number" min={minNum} className={errors.max ? "invalid" : ""}
                  value={maxUnits} onChange={(e) => setMaxUnits(e.target.value)} />
                <FieldError msg={errors.max} />
                <span className="hint">כשמגיעים — המכירה נסגרת</span>
              </div>
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
            <div className="notice info" id="f-delivery" tabIndex={-1}>בחרו לפחות אפשרות אספקה אחת למוצר.</div>
            <FieldError msg={errors.delivery} />
            {delivery.map((d, i) => (
              <React.Fragment key={i}>
                <div className="row" style={{ marginBottom: 10, alignItems: "flex-end" }}>
                  <div className="field" style={{ marginBottom: 0, flex: "1 1 130px" }}>
                    <label>סוג</label>
                    <select value={d.option_type} onChange={(e) => {
                      const t = e.target.value;
                      setDelivery(delivery.map((x, j) => j === i ? { ...x, option_type: t, ...(t === "delivery" ? { latitude: null, longitude: null } : {}) } : x));
                    }}>
                      <option value="pickup">איסוף עצמי</option>
                      <option value="delivery">משלוח</option>
                      <option value="distribution_point">נקודת חלוקה</option>
                    </select>
                  </div>
                  <div className="field grow" style={{ marginBottom: 0, flex: "2 1 180px" }}>
                    <label>תיאור</label>
                    <input value={d.label} onChange={(e) => setDelivery(delivery.map((x, j) => j === i ? { ...x, label: e.target.value } : x))} placeholder="למשל: איסוף מרח׳ הרצל 12" />
                  </div>
                  <div className="field" style={{ marginBottom: 0, flex: "1 1 100px" }}>
                    <label>עלות (₪)</label>
                    <input dir="ltr" type="number" min={0} value={d.cost} onChange={(e) => setDelivery(delivery.map((x, j) => j === i ? { ...x, cost: e.target.value } : x))} />
                  </div>
                  {delivery.length > 1 ? <button className="x" onClick={() => setDelivery(delivery.filter((_, j) => j !== i))} aria-label="הסרה">✕</button> : null}
                </div>
                <LocationCapture row={d} onSet={(lat, lng) => setDelivery(delivery.map((x, j) => j === i ? { ...x, latitude: lat, longitude: lng } : x))} />
              </React.Fragment>
            ))}
            {delivery.length < 5 ? <button className="btn btn-sm btn-ghost" onClick={() => setDelivery([...delivery, { option_type: "delivery", label: "", cost: "0", latitude: null, longitude: null }])}>+ הוספת אפשרות</button> : null}
            </> : null}

            {dealType === "voucher" ? <>
              <div className="field-row">
                <div className="field">
                  <label>שווי נקוב של השובר (₪) <span className="req">*</span></label>
                  <input id="f-voucherFace" data-testid="voucher-face-value" dir="ltr" type="number" min={1} step="0.5" className={errors.voucherFace ? "invalid" : ""} value={voucherFaceValue} onChange={(e) => setVoucherFaceValue(e.target.value)} />
                  <FieldError msg={errors.voucherFace} />
                </div>
                <div className="field">
                  <label>בתוקף עד <span className="req">*</span></label>
                  <input id="f-voucherValid" data-testid="voucher-valid-until" dir="ltr" type="date" className={errors.voucherValid ? "invalid" : ""} value={voucherValidUntil} onChange={(e) => setVoucherValidUntil(e.target.value)} />
                  <FieldError msg={errors.voucherValid} />
                </div>
              </div>
              <div className="field">
                <label>מקום מימוש <span className="req">*</span></label>
                <input id="f-voucherLocation" data-testid="voucher-location" className={errors.voucherLocation ? "invalid" : ""} value={redemptionLocation} onChange={(e) => setRedemptionLocation(e.target.value)} maxLength={500} placeholder="בסניפי העסק או באתר" />
                <FieldError msg={errors.voucherLocation} />
              </div>
              <div className="field">
                <label>הוראות מימוש <span className="req">*</span></label>
                <textarea id="f-voucherInstructions" data-testid="voucher-instructions" rows={3} className={errors.voucherInstructions ? "invalid" : ""} value={redemptionInstructions} onChange={(e) => setRedemptionInstructions(e.target.value)} maxLength={1000} placeholder="איך מציגים את הקוד וממשים" />
                <FieldError msg={errors.voucherInstructions} />
              </div>
              <div className="field">
                <label>תנאי השובר <span className="req">*</span></label>
                <textarea id="f-voucherTerms" data-testid="voucher-terms" rows={3} className={errors.voucherTerms ? "invalid" : ""} value={voucherTerms} onChange={(e) => setVoucherTerms(e.target.value)} maxLength={2000} placeholder="הגבלות, כפל מבצעים ומדיניות מימוש" />
                <FieldError msg={errors.voucherTerms} />
              </div>
              <div className="notice info">קוד השובר יופק אוטומטית רק לאחר השלמה וגבייה מוצלחת.</div>
            </> : null}

            {dealType === "ticket" ? <>
              <div className="field">
                <label>שם האירוע <span className="req">*</span></label>
                <input id="f-eventName" data-testid="ticket-event-name" className={errors.eventName ? "invalid" : ""} value={eventName} onChange={(e) => setEventName(e.target.value)} maxLength={200} />
                <FieldError msg={errors.eventName} />
              </div>
              <div className="field-row">
                <div className="field">
                  <label>מתי מתחיל <span className="req">*</span></label>
                  <input id="f-eventStart" data-testid="ticket-start" dir="ltr" type="datetime-local" className={errors.eventStart ? "invalid" : ""} value={eventStartsAt} onChange={(e) => setEventStartsAt(e.target.value)} />
                  <FieldError msg={errors.eventStart} />
                </div>
                <div className="field">
                  <label>מתי מסתיים <span className="hint">(לא חובה)</span></label>
                  <input id="f-eventEnd" dir="ltr" type="datetime-local" className={errors.eventEnd ? "invalid" : ""} value={eventEndsAt} onChange={(e) => setEventEndsAt(e.target.value)} />
                  <FieldError msg={errors.eventEnd} />
                </div>
              </div>
              <div className="field-row">
                <div className="field">
                  <label>מקום האירוע <span className="req">*</span></label>
                  <input id="f-venueName" data-testid="ticket-venue" className={errors.venueName ? "invalid" : ""} value={venueName} onChange={(e) => setVenueName(e.target.value)} maxLength={200} />
                  <FieldError msg={errors.venueName} />
                </div>
                <div className="field">
                  <label>עיר <span className="req">*</span></label>
                  <input id="f-venueCity" data-testid="ticket-city" className={errors.venueCity ? "invalid" : ""} value={venueCity} onChange={(e) => setVenueCity(e.target.value)} maxLength={100} />
                  <FieldError msg={errors.venueCity} />
                </div>
              </div>
              <div className="field"><label>כתובת</label><input value={venueAddress} onChange={(e) => setVenueAddress(e.target.value)} maxLength={300} /></div>
              <div className="field">
                <label>הוראות כניסה <span className="req">*</span></label>
                <textarea id="f-entry" data-testid="ticket-entry" rows={3} className={errors.entry ? "invalid" : ""} value={entryInstructions} onChange={(e) => setEntryInstructions(e.target.value)} maxLength={1000} />
                <FieldError msg={errors.entry} />
              </div>
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
            <DeadlinePicker
              date={deadlineDate} time={deadlineTime}
              onDate={(v) => setDeadlineDate(v)} onTime={(v) => setDeadlineTime(v)}
              error={errors.deadline || (deadlineDate && deadlineTime ? deadlineCheck.error : "")}
            />
            <div className="notice info">
              חלון השלמה לכשלי חיוב: <b>24 שעות</b> (ברירת מחדל של המערכת).
              עמלת C-ton: <b>8% + מע״מ</b> מהסכום שנגבה בפועל בלבד.
            </div>
          </>
        ) : null}

        {step === 4 ? (
          <>
            <h3>סיכום העסקה</h3>
            {images.length ? (
              <div className="img-strip">
                {images.map((img, i) => (
                  <span key={img.id} className={`img-strip-thumb${i === 0 ? " primary" : ""}`}>
                    <img src={img.previewUrl} alt={img.name} />
                    {i === 0 ? <em>ראשית</em> : null}
                  </span>
                ))}
              </div>
            ) : null}
            <div className="kv" style={{ marginBottom: 14 }}>
              <span className="k">סוג</span><span className="v">{dealTypeLabel(dealType)}</span>
              <span className="k">שם</span><span className="v">{title}</span>
              <span className="k">תיאור קצר</span><span className="v" style={{ fontWeight: 500 }}>{shortDesc}</span>
              <span className="k">מחיר ליחידה</span><span className="v">{ils(priceNum)}</span>
              <span className="k">מינימום</span><span className="v">{num(minNum)} יחידות</span>
              <span className="k">מקסימום (מלאי)</span><span className="v">{num(maxNum)} יחידות</span>
              <span className="k">סף הצלחה (90%)</span><span className="v">{num(threshold)} יחידות מחויבות</span>
              <span className="k">מועד סיום</span><span className="v">{deadlineCheck.iso ? formatIsraelDateTime(deadlineCheck.iso) : "—"}</span>
              {dealType === "physical_product" ? <><span className="k">אספקה</span><span className="v">{delivery.filter((d) => d.label.trim()).map((d) => d.label).join(" · ")}</span></> : null}
              {dealType === "voucher" ? <>
                <span className="k">שווי שובר</span><span className="v">{ils(Number(voucherFaceValue))}</span>
                <span className="k">מימוש</span><span className="v">{redemptionLocation}</span>
              </> : null}
              {dealType === "ticket" ? <>
                <span className="k">אירוע</span><span className="v">{eventName}</span>
                <span className="k">מקום</span><span className="v">{venueName} · {venueCity}</span>
              </> : null}
              <span className="k">עמלת C-ton</span><span className="v">8% + מע״מ מהנגבה בפועל</span>
            </div>
            <div className="notice info">
              העסקה נשמרת כטיוטה — שום דבר לא מתפרסם עדיין. את הפרסום עושים
              מתוך מסך העסקה, אחרי שרואים שהכול מוכן.
            </div>
          </>
        ) : null}

        {error ? <div className="notice err">{error}</div> : null}
        {uploadStatus ? <div className="notice info">{uploadStatus}</div> : null}
        <div className="wizard-nav">
          {step > 0 ? <button className="btn btn-ghost" onClick={() => { setErrors({}); setStep(step - 1); }}>→ חזרה</button> : <span />}
          {step < 4
            ? <button data-testid="wizard-next" className="btn btn-primary" onClick={continueStep}>המשך ←</button>
            : <button data-testid="wizard-save" className="btn btn-primary btn-lg" disabled={busy} onClick={save}>{busy ? (uploadStatus || "שומרים…") : "שמירה ומעבר לעסקה ←"}</button>}
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
        : `אם מועד הסיום יגיע עכשיו — העסקה לא תצא לפועל (חסרות ${num(Math.max(0, threshold - joined))} יחידות ליעד).`;
    case "TargetReached": return "המינימום הושג. במועד הסיום (או בסגירה יזומה) העסקה תעבור לחיוב.";
    case "ClosedForJoining":
      return String(deal.close_reason || "") === "manual"
        ? "ההצטרפות מושהית ביוזמתכם — אף קונה לא מחויב. אפשר לפתוח מחדש כל עוד מועד הסיום לא עבר."
        : "הרשימה נסגרה. המערכת מתכוננת לנעילה ולחיובים — אין צורך לעשות דבר.";
    case "ReadyForCharging": return "העסקה נעולה. החיובים יחלו אוטומטית.";
    case "Charging": return "החיובים מתבצעים כעת. כשלים יקבלו חלון השלמה של 24 שעות.";
    case "CompletionWindow":
      return chargedUnits >= threshold
        ? "כבר עברנו את סף ה-90% — אם זה יסתיים עכשיו העסקה תיסגר בהצלחה."
        : `אם חלון ההשלמה יסתיים עכשיו — העסקה לא תושלם (נדרשות ${num(threshold)} יחידות מחויבות, יש ${num(chargedUnits)}).`;
    case "Completed": return "העסקה הושלמה. אפשר להתחיל אספקה ולהפיק קבלות.";
    case "Failed": return "העסקה לא הושלמה. כל המסגרות שוחררו וכל חיוב הוחזר.";
    case "Cancelled": return "העסקה בוטלה. המסגרות שוחררו.";
    default: return "";
  }
}

// ── Draft edit panel (P0.2: the seller can actually edit the Draft) ────────
function DraftEditPanel({ deal, onSaved, showToast }: { deal: Json; onSaved: () => void; showToast: (m: string) => void }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(String(deal.title || ""));
  const [shortDesc, setShortDesc] = useState(String(deal.description_short || ""));
  const [longDesc, setLongDesc] = useState(String(deal.description || ""));
  const [price, setPrice] = useState(String(deal.price_per_unit ?? ""));
  const [minUnits, setMinUnits] = useState(String(deal.min_units ?? ""));
  const [maxUnits, setMaxUnits] = useState(String(deal.max_units ?? ""));
  const initialParts = utcIsoToIsraelParts(deal.deadline);
  const [deadlineDate, setDeadlineDate] = useState(initialParts.date);
  const [deadlineTime, setDeadlineTime] = useState(initialParts.time || "18:00");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  // P0.4-4 parity — type-specific terms are editable in Draft too
  const dealType = String(deal.deal_type || "physical_product");
  const vt = deal.voucher_terms || {};
  const tt = deal.ticket_terms || {};
  const [vFace, setVFace] = useState(String(vt.face_value_amount ?? ""));
  const [vValid, setVValid] = useState(vt.valid_until ? String(vt.valid_until).slice(0, 10) : "");
  const [vLocation, setVLocation] = useState(String(vt.redemption_location || ""));
  const [vInstructions, setVInstructions] = useState(String(vt.redemption_instructions || ""));
  const [vTerms, setVTerms] = useState(String(vt.terms || ""));
  const [tEventName, setTEventName] = useState(String(tt.event_name || ""));
  const [tStart, setTStart] = useState(tt.event_starts_at ? String(tt.event_starts_at).slice(0, 16) : "");
  const [tVenue, setTVenue] = useState(String(tt.venue_name || ""));
  const [tCity, setTCity] = useState(String(tt.venue_city || ""));
  const [tEntry, setTEntry] = useState(String(tt.entry_instructions || ""));

  const save = async () => {
    if (busy) return;
    const errs: Record<string, string> = {};
    if (!title.trim()) errs.title = "יש להזין שם לעסקה";
    if (!(Number(price) > 0)) errs.price = "יש להזין מחיר ליחידה";
    const minN = Number(minUnits), maxN = Number(maxUnits);
    if (!(minN >= 1)) errs.min = "יש להזין כמות מינימום";
    if (!(maxN >= minN)) errs.max = "כמות המקסימום חייבת להיות לפחות כמו המינימום";
    const dl = validateDeadline(deadlineDate, deadlineTime);
    if (dl.error) errs.editDeadline = dl.error;
    if (dealType === "voucher") {
      if (!(Number(vFace) > 0)) errs.vFace = "יש להזין את שווי השובר";
      if (!vValid) errs.vValid = "יש לבחור תוקף לשובר";
    }
    if (dealType === "ticket") {
      if (!tEventName.trim()) errs.tEventName = "יש להזין שם אירוע";
      if (!tStart) errs.tStart = "יש לבחור מועד לאירוע";
    }
    setErrors(errs);
    const first = Object.keys(errs)[0];
    if (first) { focusField(first === "editDeadline" ? "edit-deadline-date" : first); return; }
    setBusy(true);
    try {
      await api.updateDraft(String(deal.deal_id), {
        title: title.trim(),
        description: longDesc.trim(),
        description_short: shortDesc.trim(),
        price_per_unit: Number(price),
        min_units: minN,
        max_units: maxN,
        deadline: dl.iso,
        ...(dealType === "voucher" ? {
          voucher_terms: {
            ...vt,
            face_value_amount: Number(vFace),
            currency: vt.currency || "ILS",
            valid_until: new Date(`${vValid}T23:59:59`).toISOString(),
            redemption_location: vLocation.trim(),
            redemption_instructions: vInstructions.trim(),
            terms: vTerms.trim(),
            is_single_use: vt.is_single_use ?? true,
            allow_partial_redemption: vt.allow_partial_redemption ?? false,
            voucher_code_mode: vt.voucher_code_mode || "system_generated"
          }
        } : {}),
        ...(dealType === "ticket" ? {
          ticket_terms: {
            ...tt,
            event_name: tEventName.trim(),
            event_starts_at: new Date(tStart).toISOString(),
            venue_name: tVenue.trim(),
            venue_city: tCity.trim(),
            entry_instructions: tEntry.trim()
          }
        } : {})
      });
      showToast("הטיוטה נשמרה");
      setOpen(false);
      onSaved();
    } catch (e: any) {
      showToast(e.message || "השמירה נכשלה");
    }
    setBusy(false);
  };

  if (!open) {
    return (
      <div className="panel">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div className="panel-title" style={{ marginBottom: 0 }}>✏️ פרטי העסקה</div>
          <button className="btn btn-sm btn-ghost" data-testid="draft-edit-open" onClick={() => setOpen(true)}>עריכת הפרטים</button>
        </div>
      </div>
    );
  }
  return (
    <div className="panel">
      <div className="panel-title">✏️ עריכת פרטי העסקה</div>
      <div className="field">
        <label>שם העסקה <span className="req">*</span></label>
        <input id="f-title" className={errors.title ? "invalid" : ""} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
        <FieldError msg={errors.title} />
      </div>
      <div className="field">
        <label>תיאור קצר <span className="hint">(עד 200 תווים)</span></label>
        <input value={shortDesc} onChange={(e) => setShortDesc(e.target.value)} maxLength={200} />
      </div>
      <div className="field">
        <label>תיאור מלא</label>
        <textarea rows={6} value={longDesc} onChange={(e) => setLongDesc(e.target.value)} maxLength={4000} />
      </div>
      <div className="field-row">
        <div className="field">
          <label>מחיר ליחידה (₪) <span className="req">*</span></label>
          <input id="f-price" dir="ltr" type="number" min={1} step="0.5" className={errors.price ? "invalid" : ""} value={price} onChange={(e) => setPrice(e.target.value)} />
          <FieldError msg={errors.price} />
        </div>
        <div className="field">
          <label>כמות מינימום <span className="req">*</span></label>
          <input id="f-min" dir="ltr" type="number" min={1} className={errors.min ? "invalid" : ""} value={minUnits} onChange={(e) => setMinUnits(e.target.value)} />
          <FieldError msg={errors.min} />
        </div>
        <div className="field">
          <label>מקסימום (מלאי) <span className="req">*</span></label>
          <input id="f-max" dir="ltr" type="number" min={1} className={errors.max ? "invalid" : ""} value={maxUnits} onChange={(e) => setMaxUnits(e.target.value)} />
          <FieldError msg={errors.max} />
        </div>
      </div>
      <DeadlinePicker idPrefix="edit-deadline" date={deadlineDate} time={deadlineTime} onDate={setDeadlineDate} onTime={setDeadlineTime} error={errors.editDeadline} />
      {dealType === "voucher" ? (
        <>
          <div className="section-title" style={{ margin: "12px 0 8px" }}>פרטי השובר</div>
          <div className="field-row">
            <div className="field">
              <label>שווי נקוב (₪) <span className="req">*</span></label>
              <input id="f-vFace" dir="ltr" type="number" min={1} className={errors.vFace ? "invalid" : ""} value={vFace} onChange={(e) => setVFace(e.target.value)} />
              <FieldError msg={errors.vFace} />
            </div>
            <div className="field">
              <label>בתוקף עד <span className="req">*</span></label>
              <input id="f-vValid" dir="ltr" type="date" className={errors.vValid ? "invalid" : ""} value={vValid} onChange={(e) => setVValid(e.target.value)} />
              <FieldError msg={errors.vValid} />
            </div>
          </div>
          <div className="field"><label>מקום מימוש</label><input value={vLocation} onChange={(e) => setVLocation(e.target.value)} maxLength={500} /></div>
          <div className="field"><label>הוראות מימוש</label><textarea rows={2} value={vInstructions} onChange={(e) => setVInstructions(e.target.value)} maxLength={1000} /></div>
          <div className="field"><label>תנאי השובר</label><textarea rows={2} value={vTerms} onChange={(e) => setVTerms(e.target.value)} maxLength={2000} /></div>
        </>
      ) : null}
      {dealType === "ticket" ? (
        <>
          <div className="section-title" style={{ margin: "12px 0 8px" }}>פרטי האירוע</div>
          <div className="field-row">
            <div className="field">
              <label>שם האירוע <span className="req">*</span></label>
              <input id="f-tEventName" className={errors.tEventName ? "invalid" : ""} value={tEventName} onChange={(e) => setTEventName(e.target.value)} maxLength={200} />
              <FieldError msg={errors.tEventName} />
            </div>
            <div className="field">
              <label>מתי מתחיל <span className="req">*</span></label>
              <input id="f-tStart" dir="ltr" type="datetime-local" className={errors.tStart ? "invalid" : ""} value={tStart} onChange={(e) => setTStart(e.target.value)} />
              <FieldError msg={errors.tStart} />
            </div>
          </div>
          <div className="field-row">
            <div className="field"><label>מקום האירוע</label><input value={tVenue} onChange={(e) => setTVenue(e.target.value)} maxLength={200} /></div>
            <div className="field"><label>עיר</label><input value={tCity} onChange={(e) => setTCity(e.target.value)} maxLength={100} /></div>
          </div>
          <div className="field"><label>הוראות כניסה</label><textarea rows={2} value={tEntry} onChange={(e) => setTEntry(e.target.value)} maxLength={1000} /></div>
        </>
      ) : null}
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button className="btn btn-ghost" onClick={() => setOpen(false)}>ביטול</button>
        <button className="btn btn-primary" data-testid="draft-edit-save" disabled={busy} onClick={save}>{busy ? "שומרים…" : "שמירת השינויים"}</button>
      </div>
    </div>
  );
}

// ── delivery & pickup (P0.4-4): ALWAYS visible, safely editable ────────────
// The server decides editability (seller_actions.delivery_editable): Draft
// always; published only while ZERO buyers ever relied on the options. Locked
// deals still SHOW everything with an explicit explanation — never hidden.
const DELIVERY_TYPE_NAMES: Record<string, string> = { delivery: "משלוח", pickup: "איסוף עצמי", distribution_point: "נקודת חלוקה" };
const DELIVERY_TYPE_ICONS: Record<string, string> = { delivery: "🚚", pickup: "🏪", distribution_point: "📍" };

function mapsPlaceUrl(lat: number | null, lng: number | null): string | null {
  if (lat == null || lng == null || !Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) return null;
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
}

function DeliverySection({ deal, options, editable, lockReason, onSaved, showToast }: {
  deal: Json;
  options: Json[];
  editable: boolean;
  lockReason: string | null;
  onSaved: () => void;
  showToast: (m: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [rows, setRows] = useState<DeliveryDraft[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const dealType = String(deal.deal_type || "physical_product");

  if (dealType !== "physical_product") {
    return (
      <div className="panel" data-testid="delivery-section">
        <div className="panel-title">📦 אספקה ומשלוח</div>
        <p className="muted small" style={{ marginBottom: 0 }}>
          {dealType === "voucher" ? "עסקת שובר — המימוש דיגיטלי, ללא משלוח פיזי." : "עסקת כרטיסים — הכניסה עם הכרטיס, ללא משלוח פיזי."}
        </p>
      </div>
    );
  }

  const beginEdit = () => {
    setRows((options || []).map((o) => ({
      option_type: String(o.option_type || "pickup"),
      label: String(o.label || ""),
      cost: String(Number(o.cost || 0)),
      latitude: o.latitude == null ? null : Number(o.latitude),
      longitude: o.longitude == null ? null : Number(o.longitude)
    })));
    setError("");
    setEditing(true);
  };

  const save = async () => {
    if (busy) return;
    const clean = rows.filter((r) => r.label.trim());
    if (!clean.length) { setError("יש להשאיר לפחות אפשרות אספקה אחת"); return; }
    setBusy(true); setError("");
    try {
      await api.updateDealDelivery(String(deal.deal_id), {
        delivery_options: clean.map((r, i) => ({
          option_type: r.option_type, label: r.label.trim(), cost: Math.max(0, Number(r.cost) || 0), sort_order: i,
          ...(r.latitude != null && r.longitude != null ? { latitude: r.latitude, longitude: r.longitude } : {})
        }))
      });
      showToast("אפשרויות האספקה נשמרו");
      setEditing(false);
      onSaved();
    } catch (e: any) { setError(e.message || "השמירה נכשלה"); }
    setBusy(false);
  };

  return (
    <div className="panel" data-testid="delivery-section">
      <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
        <div className="panel-title" style={{ marginBottom: 0 }}>📦 אספקה ומשלוח</div>
        {editable && !editing ? (
          <button className="btn btn-sm btn-ghost" data-testid="delivery-edit-open" onClick={beginEdit}>עריכה</button>
        ) : null}
      </div>

      {!editable ? (
        <p className="muted small" style={{ margin: "8px 0 0" }} data-testid="delivery-locked-note">
          {lockReason === "buyer_reliance"
            ? "לא ניתן לשנות פרט זה לאחר שהעסקה פורסמה והצטרפו אליה קונים."
            : lockReason === "deal_state"
              ? "לא ניתן לשנות פרט זה במצב הנוכחי של העסקה."
              : "לא ניתן לשנות פרט זה לאחר שהעסקה פורסמה."}
        </p>
      ) : null}

      {!editing ? (
        (options || []).length ? (
          <div className="stack" style={{ gap: 8, marginTop: 10 }}>
            {(options || []).map((o) => {
              const nav = mapsPlaceUrl(o.latitude == null ? null : Number(o.latitude), o.longitude == null ? null : Number(o.longitude));
              return (
                <div className="delivery-view-row" key={String(o.option_id)}>
                  <span className="ico" aria-hidden="true">{DELIVERY_TYPE_ICONS[String(o.option_type)] || "📦"}</span>
                  <span className="grow">
                    <b>{DELIVERY_TYPE_NAMES[String(o.option_type)] || o.option_type}</b> — {o.label}
                    {o.latitude != null && o.longitude != null ? (
                      <span className="muted small"> · 📍 ({Number(o.latitude).toFixed(4)}, {Number(o.longitude).toFixed(4)})</span>
                    ) : null}
                  </span>
                  <span className="delivery-cost">{Number(o.cost) ? ils(o.cost) : "חינם"}</span>
                  {nav ? <a className="btn btn-sm btn-ghost" href={nav} target="_blank" rel="noreferrer">הצגה במפה</a> : null}
                </div>
              );
            })}
          </div>
        ) : (
          <p className="muted small" style={{ margin: "8px 0 0" }}>לא הוגדרו אפשרויות אספקה.</p>
        )
      ) : (
        <div className="stack" style={{ gap: 4, marginTop: 10 }}>
          {rows.map((d, i) => (
            <React.Fragment key={i}>
              <div className="row" style={{ marginBottom: 6, alignItems: "flex-end" }}>
                <div className="field" style={{ marginBottom: 0, flex: "1 1 120px" }}>
                  <label>סוג</label>
                  <select value={d.option_type} onChange={(e) => {
                    const t = e.target.value;
                    setRows(rows.map((x, j) => j === i ? { ...x, option_type: t, ...(t === "delivery" ? { latitude: null, longitude: null } : {}) } : x));
                  }}>
                    <option value="pickup">איסוף עצמי</option>
                    <option value="delivery">משלוח</option>
                    <option value="distribution_point">נקודת חלוקה</option>
                  </select>
                </div>
                <div className="field grow" style={{ marginBottom: 0, flex: "2 1 160px" }}>
                  <label>תיאור / כתובת</label>
                  <input value={d.label} onChange={(e) => setRows(rows.map((x, j) => j === i ? { ...x, label: e.target.value } : x))} placeholder="למשל: איסוף מרח׳ הרצל 12" />
                </div>
                <div className="field" style={{ marginBottom: 0, flex: "1 1 90px" }}>
                  <label>עלות (₪)</label>
                  <input dir="ltr" type="number" min={0} value={d.cost} onChange={(e) => setRows(rows.map((x, j) => j === i ? { ...x, cost: e.target.value } : x))} />
                </div>
                {rows.length > 1 ? <button className="x" onClick={() => setRows(rows.filter((_, j) => j !== i))} aria-label="הסרה">✕</button> : null}
              </div>
              <LocationCapture row={d} onSet={(lat, lng) => setRows(rows.map((x, j) => j === i ? { ...x, latitude: lat, longitude: lng } : x))} />
            </React.Fragment>
          ))}
          {rows.length < 5 ? (
            <button className="btn btn-sm btn-ghost" style={{ alignSelf: "flex-start" }}
              onClick={() => setRows([...rows, { option_type: "delivery", label: "", cost: "0", latitude: null, longitude: null }])}>
              + הוספת אפשרות
            </button>
          ) : null}
          {error ? <div className="notice err">{error}</div> : null}
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <button className="btn btn-ghost" disabled={busy} onClick={() => setEditing(false)}>ביטול</button>
            <button className="btn btn-primary" data-testid="delivery-save" disabled={busy} onClick={save}>{busy ? "שומרים…" : "שמירת האספקה"}</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── type-specific terms (P0.4-4 parity): always VIEWABLE on management ─────
function TypeTermsPanel({ deal }: { deal: Json }) {
  const dealType = String(deal.deal_type || "physical_product");
  if (dealType === "voucher" && deal.voucher_terms) {
    const v = deal.voucher_terms;
    return (
      <div className="panel" data-testid="type-terms">
        <div className="panel-title">🎁 פרטי השובר</div>
        <div className="kv">
          <span className="k">שווי נקוב</span><span className="v">{ils(v.face_value_amount)}</span>
          <span className="k">בתוקף עד</span><span className="v">{fmtDate(v.valid_until)}</span>
          <span className="k">מקום מימוש</span><span className="v">{v.redemption_location || "—"}</span>
          <span className="k">הוראות מימוש</span><span className="v" style={{ fontWeight: 500 }}>{v.redemption_instructions || "—"}</span>
          <span className="k">תנאים</span><span className="v" style={{ fontWeight: 500 }}>{v.terms || "—"}</span>
        </div>
        {String(deal.state) === "Draft" ? (
          <p className="muted small" style={{ margin: "10px 0 0" }}>עריכת פרטי השובר זמינה בטיוטה דרך ״עריכת הפרטים״.</p>
        ) : (
          <p className="muted small" style={{ margin: "10px 0 0" }}>לא ניתן לשנות את תנאי השובר לאחר הפרסום.</p>
        )}
      </div>
    );
  }
  if (dealType === "ticket" && deal.ticket_terms) {
    const t = deal.ticket_terms;
    return (
      <div className="panel" data-testid="type-terms">
        <div className="panel-title">🎟️ פרטי האירוע</div>
        <div className="kv">
          <span className="k">אירוע</span><span className="v">{t.event_name || "—"}</span>
          <span className="k">מתחיל</span><span className="v">{fmtDate(t.event_starts_at)}</span>
          {t.event_ends_at ? (<><span className="k">מסתיים</span><span className="v">{fmtDate(t.event_ends_at)}</span></>) : null}
          <span className="k">מקום</span><span className="v">{[t.venue_name, t.venue_city].filter(Boolean).join(" · ") || "—"}</span>
          {t.venue_address ? (<><span className="k">כתובת</span><span className="v">{t.venue_address}</span></>) : null}
          <span className="k">הוראות כניסה</span><span className="v" style={{ fontWeight: 500 }}>{t.entry_instructions || "—"}</span>
          <span className="k">העברת כרטיס</span><span className="v">{t.transfer_allowed ? "מותרת" : "לא מותרת"}</span>
        </div>
        {String(deal.state) === "Draft" ? (
          <p className="muted small" style={{ margin: "10px 0 0" }}>עריכת פרטי האירוע זמינה בטיוטה דרך ״עריכת הפרטים״.</p>
        ) : (
          <p className="muted small" style={{ margin: "10px 0 0" }}>לא ניתן לשנות את פרטי האירוע לאחר הפרסום.</p>
        )}
      </div>
    );
  }
  return null;
}

// ── seller viral tree (P0.4-2E): SAME canonical engine, own deal only ──────
function SellerViralTreePage({ dealId, navigate }: { dealId: string; navigate: (h: string) => void }) {
  const [payload, setPayload] = useState<Json | null>(null);
  const [title, setTitle] = useState("");
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<VNode | null>(null);

  useEffect(() => {
    api.sellerDealViralTree(dealId, { limit: 60 }).then(setPayload).catch((e) => setError(e.message));
    api.sellerDeal(dealId).then((r) => setTitle(String(r.deal?.title || ""))).catch(() => undefined);
  }, [dealId]);

  if (error) return <EmptyState icon="⚠️" title="לא ניתן לטעון את העץ" body={error} action={<a className="btn btn-primary" href={`#/seller/deal/${dealId}`}>לעסקה</a>} />;
  if (!payload) return <BrandLoader label="טוענים את עץ ההפצה…" minHeight={420} />;

  const roots: VNode[] = payload.nodes || [];
  return (
    <>
      <a className="back" href={`#/seller/deal/${dealId}`} onClick={(e) => { e.preventDefault(); navigate(`#/seller/deal/${dealId}`); }}>→ לעסקה</a>
      <div className="panel">
        <div className="panel-title">🌳 עץ ההפצה — {title || "העסקה שלי"}</div>
        {roots.length === 0 ? (
          <p className="muted small" style={{ marginBottom: 0 }}>עדיין אין הצטרפויות בעץ — כל מצטרף מקבל קישור אישי אוטומטית.</p>
        ) : (
          <VTreeCanvas
            dealId={dealId}
            roots={roots}
            rootTruncated={Boolean(payload.truncated)}
            dealTitle={title}
            selectedId={selected ? String(selected.participant_id) : null}
            onSelect={setSelected}
            fetchLevel={api.sellerDealViralTree}
          />
        )}
      </div>
      {selected ? (
        <div className="panel" data-testid="tree-node-detail">
          <div className="panel-title">פרטי ענף — {selected.display}</div>
          <div className="kv">
            <span className="k">דור</span><span className="v">{num(selected.generation)}</span>
            <span className="k">יחידות ישירות</span><span className="v">{num(selected.direct_units)}</span>
            <span className="k">הביא/ה ישירות</span><span className="v">{num(selected.direct_children)}</span>
            <span className="k">מצטרפים בכל הענף</span><span className="v">{num(selected.subtree_joins)}</span>
            <span className="k">יחידות בענף</span><span className="v">{num(selected.subtree_units)}</span>
            <span className="k">חויב בענף</span><span className="v">{ils(selected.subtree_charged_gmv)}</span>
            <span className="k">עומק הענף</span><span className="v">{num(selected.subtree_max_depth)} דורות</span>
          </div>
        </div>
      ) : null}
    </>
  );
}

// ── publish flow (P0.2-H): readiness checklist + exact blockers, no silence ─
function PublishModal(props: { deal: Json; onClose: () => void; onPublished: () => void }) {
  const { deal } = props;
  const [ack1, setAck1] = useState(false);
  const [ack2, setAck2] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const images: Json[] = deal.images || [];
  const deliveryOptions: Json[] = deal.delivery_options || [];
  const threshold = Math.ceil(0.9 * Number(deal.min_units || 0));
  const deadlineMs = Date.parse(String(deal.deadline || ""));
  const isPhysical = String(deal.deal_type || "physical_product") === "physical_product";

  const checks: { label: string; ok: boolean; blocker: string | null }[] = [
    { label: "שם ומחיר", ok: Boolean(String(deal.title || "").trim()) && Number(deal.price_per_unit) > 0, blocker: "חסרים שם או מחיר לעסקה" },
    { label: "יעד וכמויות", ok: Number(deal.min_units) >= 1 && Number(deal.max_units) >= Number(deal.min_units), blocker: "יש להשלים כמות מינימום ומקסימום" },
    {
      label: "מועד סיום עתידי",
      ok: Number.isFinite(deadlineMs) && deadlineMs - Date.now() > 30 * 60_000,
      blocker: "מועד הסיום עבר או קרוב מדי — יש לעדכן אותו בעריכת הפרטים"
    },
    { label: "תמונה ראשית", ok: images.length > 0, blocker: "יש להעלות לפחות תמונה אחת" },
    ...(isPhysical ? [{ label: "אפשרות אספקה", ok: deliveryOptions.length > 0, blocker: "יש להוסיף לפחות אפשרות אספקה אחת" }] : [])
  ];
  const blockers = checks.filter((c) => !c.ok).map((c) => c.blocker!).filter(Boolean);
  const ready = blockers.length === 0;

  const publish = async () => {
    if (busy) return;
    if (!ack1 || !ack2) { setError("יש לאשר את שני התנאים לפני הפרסום"); return; }
    setBusy(true); setError("");
    try {
      await api.publishDeal(String(deal.deal_id));
      props.onPublished();
    } catch (e: any) {
      setError(e.message || "הפרסום נכשל — נסו שוב");
      setBusy(false);
    }
  };

  return (
    <Modal
      title="פרסום העסקה"
      onClose={props.onClose}
      footer={
        <>
          {error ? <div className="notice err" style={{ marginTop: 0 }}>{error}</div> : null}
          {!ready ? (
            <div className="notice err" style={{ marginTop: 0 }}>
              <b>לא ניתן לפרסם עדיין:</b>
              <ul style={{ margin: "6px 0 0", paddingInlineStart: 18 }}>
                {blockers.map((b) => <li key={b}>{b}</li>)}
              </ul>
            </div>
          ) : null}
          <button className="btn btn-join btn-block" data-testid="publish-confirm" disabled={busy || !ready} onClick={publish}>
            {busy ? "מפרסמים…" : "פרסום העסקה"}
          </button>
        </>
      }
    >
      <p className="muted small" style={{ marginTop: 0 }}>
        רגע לפני שהעסקה עולה לאוויר — בדיקת מוכנות קצרה:
      </p>
      <div className="publish-checklist">
        {checks.map((c) => (
          <div key={c.label} className={`publish-check${c.ok ? " ok" : " missing"}`}>
            <span>{c.ok ? "✓" : "•"}</span> {c.label}
          </div>
        ))}
      </div>
      <div className="kv" style={{ margin: "14px 0" }}>
        <span className="k">מחיר ליחידה</span><span className="v">{ils(deal.price_per_unit)}</span>
        <span className="k">יעד (מינימום)</span><span className="v">{num(deal.min_units)} יחידות</span>
        <span className="k">סף הצלחה (90%)</span><span className="v">{num(threshold)} יחידות מחויבות</span>
        <span className="k">מועד סיום</span><span className="v">{formatIsraelDateTime(deal.deadline) || "—"}</span>
      </div>
      <div className="publish-warning">
        <label className="check">
          <input data-testid="publish-lock-terms" type="checkbox" checked={ack1} onChange={(e) => setAck1(e.target.checked)} />
          <span>קראתי והבנתי כי לאחר הפרסום <b>לא ניתן לשנות</b> מחיר, כמויות, מועד סיום או עמלות.</span>
        </label>
        <label className="check" style={{ marginBottom: 0 }}>
          <input data-testid="publish-lock-threshold" type="checkbox" checked={ack2} onChange={(e) => setAck2(e.target.checked)} />
          <span>אני מאשר/ת שהתנאים סופיים, כולל כלל ה-90%: העסקה תושלם רק אם יחויבו בפועל לפחות {num(threshold)} יחידות.</span>
        </label>
      </div>
    </Modal>
  );
}

function SellerDealScreen({ dealId, navigate }: { dealId: string; navigate: (h: string) => void }) {
  const [payload, setPayload] = useState<Json | null>(null);
  const [viral, setViral] = useState<Json | null>(null);
  const [error, setError] = useState("");
  const [confirmClose, setConfirmClose] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [reopening, setReopening] = useState(false);
  const [toast, showToast] = useToast();

  const load = () => api.sellerDeal(dealId).then(setPayload).catch((e) => setError(e.message));
  useEffect(() => {
    load();
    const id = setInterval(load, 20_000);
    api.sellerDealViral(dealId).then(setViral).catch(() => undefined);
    return () => clearInterval(id);
  }, [dealId]);

  if (error) return <EmptyState icon="⚠️" title="לא ניתן לטעון את העסקה" body={error} />;
  if (!payload?.deal) return <BrandLoader label="טוענים את העסקה…" minHeight={420} />;

  const deal = payload.deal;
  // delivery options come as a sibling collection on this endpoint
  if (!deal.delivery_options) deal.delivery_options = payload.delivery_options || [];
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
  const isDraft = state === "Draft";
  const closed = CLOSED_STATES.includes(state);
  const inWindow = state === "CompletionWindow";
  const gross = chargedRows.reduce((s, p) => s + Number(p.qty) * Number(deal.price_per_unit) + Number(p.delivery_cost || 0), 0);
  const fee = Math.round(gross * 0.08 * 100) / 100;
  const vm = viral?.metrics as Json | null;
  const deletable = isDraft || (isOpen && participants.length === 0);
  // P0.3-14 — a MANUAL close is a reversible pause (deadline still ahead,
  // capacity not full, nothing charged); deadline/capacity/system closes are not.
  const paused = state === "ClosedForJoining" && String(deal.close_reason || "") === "manual";
  const canReopen = paused
    && Date.parse(String(deal.deadline || "")) > Date.now()
    && joined < Number(deal.max_units || 0);

  const reopen = async () => {
    if (reopening) return;
    setReopening(true);
    try {
      await api.reopenJoining(dealId);
      showToast("ההצטרפות נפתחה מחדש");
      await load();
    } catch (e: any) { showToast(e.message || "הפתיחה מחדש נכשלה"); }
    setReopening(false);
  };

  return (
    <>
      <a className="back" href="#/seller" onClick={(e) => { e.preventDefault(); navigate("#/seller"); }}>→ לדשבורד</a>

      {paused ? (
        <div className="paused-banner" data-testid="paused-banner">
          <div>
            <b>ההצטרפות מושהית.</b>
            <div className="small">
              קונים רואים את העסקה אך לא יכולים להצטרף.{" "}
              {canReopen ? "אפשר לפתוח מחדש כל עוד מועד הסיום לא עבר והמלאי לא הסתיים." : "מועד הסיום עבר או שהמלאי הסתיים — לא ניתן לפתוח מחדש."}
            </div>
          </div>
          {canReopen ? (
            <button className="btn btn-primary" data-testid="reopen-joining" disabled={reopening} onClick={reopen}>
              {reopening ? "פותחים…" : "פתיחת ההצטרפות מחדש"}
            </button>
          ) : null}
        </div>
      ) : null}

      {/* Draft: impossible-to-miss banner + dominant publish CTA (P0.2-G/H) */}
      {isDraft ? (
        <div className="draft-banner" data-testid="draft-banner">
          <div>
            <b>טיוטה — העסקה עדיין לא פורסמה.</b>
            <div className="small">קונים לא רואים אותה. כשהכול מוכן — מפרסמים, ומקבלים קישור לשיתוף.</div>
          </div>
          <button className="btn btn-join" data-testid="publish-open" onClick={() => setPublishing(true)}>פרסום העסקה</button>
        </div>
      ) : null}

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
        </div>

        {/* P0.3-13 — the status stands alone above; the countdown lives in its
            own labeled block, never fused into the status sentence. */}
        {inWindow || state === "Charging" ? (
          <div className="seller-countdown-block">
            <span className="lbl">חלון ההשלמה מסתיים בעוד</span>
            <LiveCountdown deadline={deal.completion_window_until} />
          </div>
        ) : isOpen ? (
          <div className="seller-countdown-block" data-testid="seller-countdown">
            <span className="lbl">סיום ההצטרפות בעוד</span>
            <LiveCountdown deadline={deal.deadline} />
          </div>
        ) : null}

        {!isDraft ? (
          <div style={{ margin: "18px 0 8px" }}>
            <GroupMeter large joined={joined} threshold={Number(deal.threshold_units)} max={Number(deal.max_units)} showFlag />
          </div>
        ) : null}

        {!isDraft ? (
          <div className="sd-quants" style={{ fontSize: "1rem", marginTop: 12 }}>
            <span className="q-charged">חויב בהצלחה: {num(chargedUnits)}</span>
            <span className={`q-pending${inWindow ? " risk" : ""}`}>{inWindow ? "ממתין לאישור סופי" : "בהמתנה"}: {num(pendingUnits)}</span>
            <span className="q-none">לא חויב: {num(droppedUnits)}</span>
          </div>
        ) : null}
        {inWindow && pendingRows.length ? (
          <p className="small" style={{ color: "var(--saffron)", marginTop: 6 }}>
            נשלחה הודעה ל-{num(pendingRows.length)} קונים — עדכון אשראי תוך 24 שעות.
          </p>
        ) : null}

        {!isDraft ? (
          <div className="notice info" style={{ marginTop: 14 }}>
            <b>מה יקרה עכשיו:</b> {whatHappensNow(deal, chargedUnits)}
          </div>
        ) : (
          <div className="kv" style={{ marginTop: 14 }}>
            <span className="k">מחיר ליחידה</span><span className="v">{ils(deal.price_per_unit)}</span>
            <span className="k">יעד (מינימום)</span><span className="v">{num(deal.min_units)} יחידות</span>
            <span className="k">מועד סיום</span><span className="v">{formatIsraelDateTime(deal.deadline) || "—"}</span>
          </div>
        )}

        <div className="row" style={{ marginTop: 12 }}>
          {isOpen ? (
            <>
              <button className="btn btn-primary" onClick={async () => {
                if (await copyText(absoluteShareUrl(dealId, null))) showToast("הקישור הועתק");
              }}>שיתוף הקישור</button>
              <a className="btn btn-ghost" href={`#/deal/${dealId}`} target="_blank">צפייה בדף הציבורי</a>
              <button className="btn btn-ghost" data-testid="pause-joining-open" onClick={() => setConfirmClose(true)}>השהיית הצטרפות</button>
            </>
          ) : isDraft ? (
            <a className="btn btn-ghost" href={`#/deal/${dealId}`} target="_blank">תצוגה מקדימה</a>
          ) : closed ? (
            <button className="btn btn-ghost" onClick={async () => {
              try {
                const r = await api.duplicateDeal(dealId);
                const newId = r?.deal?.deal_id || r?.deal_id;
                if (newId) { showToast("נוצרה טיוטה — חובה לעדכן תאריכים"); navigate(`#/seller/deal/${newId}`); }
              } catch (e: any) { showToast(e.message || "השכפול נכשל"); }
            }}>יצירת עסקה דומה</button>
          ) : (
            <span className="muted small">העסקה נעולה לצפייה בלבד. כל הפעולות מתבצעות אוטומטית.</span>
          )}
          {deletable ? (
            <button className="btn btn-ghost btn-danger-ghost" data-testid="deal-delete-open" onClick={() => setConfirmDelete(true)}>מחיקת העסקה</button>
          ) : null}
        </div>
      </div>

      {isDraft ? <DraftEditPanel deal={deal} onSaved={load} showToast={showToast} /> : null}

      {/* P0.4-4 — delivery/pickup: ALWAYS visible; editability decided server-side */}
      <DeliverySection
        deal={deal}
        options={payload.delivery_options || deal.delivery_options || []}
        editable={Boolean(payload.seller_actions?.delivery_editable)}
        lockReason={payload.seller_actions?.delivery_lock_reason || null}
        onSaved={load}
        showToast={showToast}
      />
      <TypeTermsPanel deal={deal} />

      {isDraft ? (
        <div className="panel">
          <div className="panel-title">🖼️ תמונות העסקה</div>
          <p className="muted small" style={{ marginTop: 0 }}>
            הוספה ומחיקה אפשריות רק בטיוטה. גם אחרי הפרסום אפשר לשנות סדר ולבחור תמונה ראשית.
          </p>
          <DraftImageManager
            dealId={dealId}
            images={(deal.images || []) as ServerImage[]}
            onChanged={load}
          />
        </div>
      ) : isOpen ? (
        <div className="panel">
          <div className="panel-title">🖼️ סדר התמונות והתמונה הראשית</div>
          <DraftImageManager
            dealId={dealId}
            images={(deal.images || []) as ServerImage[]}
            onChanged={load}
            arrangeOnly
          />
        </div>
      ) : null}

      {closed && state === "Completed" ? (
        <div className="panel">
          <div className="panel-title">💰 כספים (על בסיס חיובים שבוצעו בפועל)</div>
          <div className="stat-row" style={{ marginBottom: 0 }}>
            <StatTile num={ils(gross)} label="ברוטו שנגבה" tone="good" />
            <StatTile num={ils(fee)} label="עמלת C-ton (8%)" />
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
              <thead><tr><th>קונה</th><th>טלפון</th><th className="num">כמות</th><th>אופן קבלה</th><th>מצב תשלום</th></tr></thead>
              <tbody>
                {(state === "Completed" ? chargedRows : participants).slice(0, 100).map((p) => (
                  <tr key={p.participant_id}>
                    <td>{p.buyer_name || "—"}</td>
                    <td dir="ltr">{p.buyer_phone || p.buyer_id}</td>
                    <td className="num">{num(p.qty)}</td>
                    <td>{p.delivery_method_label || "—"}</td>
                    <td><span className={`status ${["ChargedSuccess", "RecoveredCharge"].includes(String(p.money_state)) ? "Completed" : String(p.money_state) === "ChargeFailedRecovery" ? "CompletionWindow" : "ClosedForJoining"}`}>{moneyStateLabel(String(p.money_state))}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {state === "Completed" ? (
            <div className="row" style={{ marginTop: 10 }}>
              <a className="btn btn-sm btn-ghost" href={`/api/seller/deals/${dealId}/export.xlsx`} target="_blank">הורדת רשימת משלוחים (Excel)</a>
            </div>
          ) : null}
        </div>
      ) : null}

      {!isDraft ? (
        <div className="panel">
          <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
            <div className="panel-title" style={{ marginBottom: 0 }}>🌱 הפצה ויראלית של העסקה</div>
            <button className="btn btn-sm btn-primary" data-testid="open-viral-tree" onClick={() => navigate(`#/seller/deal/${dealId}/viral`)}>
              פתיחת העץ הוויראלי
            </button>
          </div>
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
              ) : <p className="muted small">עדיין אין שיתופים שהביאו הצטרפויות — כל מצטרף מקבל קישור אישי אוטומטית.</p>}
              {viral?.stale ? <p className="muted small" style={{ marginTop: 8 }}>הנתונים מחושבים ברקע · עודכנו {fmtDate(viral.computed_at)}</p> : null}
            </>
          ) : <p className="muted small">נתוני ההפצה יחושבו אחרי ההצטרפות הראשונה.</p>}
        </div>
      ) : null}

      {publishing ? (
        <PublishModal
          deal={deal}
          onClose={() => setPublishing(false)}
          onPublished={() => { setPublishing(false); showToast("העסקה פורסמה! 🎉 עכשיו אפשר לשתף"); load(); }}
        />
      ) : null}

      {confirmClose ? (
        <Modal title="השהיית ההצטרפות לעסקה?" onClose={() => setConfirmClose(false)}>
          <p>קונים חדשים לא יוכלו להצטרף. משתתפים קיימים נשארים בעסקה — אף אחד לא מחויב.</p>
          <p className="muted small">אפשר לפתוח את ההצטרפות מחדש כל עוד מועד הסיום לא עבר והמלאי לא הסתיים.</p>
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <button className="btn btn-ghost" onClick={() => setConfirmClose(false)}>ביטול</button>
            <button className="btn btn-danger" data-testid="pause-joining-confirm" onClick={async () => {
              try { await api.closeJoining(dealId); setConfirmClose(false); showToast("ההצטרפות הושהתה"); load(); }
              catch (e: any) { showToast(e.message || "ההשהיה נכשלה"); setConfirmClose(false); }
            }}>השהיה עכשיו</button>
          </div>
        </Modal>
      ) : null}

      {confirmDelete ? (
        <Modal title="מחיקת העסקה" onClose={() => setConfirmDelete(false)}>
          <p><b>למחוק את העסקה?</b> לא ניתן לבטל פעולה זו.</p>
          <p className="muted small">המחיקה אפשרית רק כל עוד אין בעסקה אף הצטרפות או פעילות כספית.</p>
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <button className="btn btn-ghost" onClick={() => setConfirmDelete(false)}>ביטול</button>
            <button className="btn btn-danger" data-testid="deal-delete-confirm" onClick={async () => {
              try {
                await api.deleteDeal(dealId);
                showToast("העסקה נמחקה");
                navigate("#/seller");
              } catch (e: any) { showToast(e.message || "המחיקה נכשלה"); setConfirmDelete(false); }
            }}>מחיקה סופית</button>
          </div>
        </Modal>
      ) : null}
      <Toast msg={toast} />
    </>
  );
}

// ── business onboarding (P0.3-8) ───────────────────────────────────────────
// Statuses are SEPARATE truths: form completeness is derived, verification
// and provider onboarding are real external processes — nothing here
// auto-approves anything. The full bank account number is WRITE-ONLY: the
// server returns only last4, and an empty input keeps the stored number.
const ENTITY_TYPES: { value: string; label: string }[] = [
  { value: "osek_patur", label: "עוסק פטור" },
  { value: "osek_murshe", label: "עוסק מורשה" },
  { value: "company", label: "חברה בע״מ" },
  { value: "amuta", label: "עמותה" },
  { value: "partnership", label: "שותפות" },
  { value: "other", label: "אחר" }
];

const VERIFICATION_LABELS: Record<string, string> = {
  pending: "בבדיקה", approved: "מאומת", verified: "מאומת", rejected: "נדחה"
};
const GROW_LABELS: Record<string, string> = {
  not_started: "טרם החל", in_progress: "בתהליך", completed: "הושלם"
};

function StatusBadge({ ok, okText, missingText }: { ok: boolean; okText: string; missingText: string }) {
  return <span className={`status ${ok ? "Completed" : "ClosedForJoining"}`}>{ok ? okText : missingText}</span>;
}

function BusinessProfilePage({ navigate }: { navigate: (h: string) => void }) {
  const [payload, setPayload] = useState<Json | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<Record<string, string>>({});
  const [bankNumber, setBankNumber] = useState("");
  const [toast, showToast] = useToast();

  const adopt = (r: Json) => {
    setPayload(r);
    const p = r.business_profile || {};
    setForm({
      business_name: p.business_name || "", legal_name: p.legal_name || "",
      business_id_number: p.business_id_number || "", entity_type: p.entity_type || "",
      contact_name: p.contact_name || "", contact_phone: p.contact_phone || "",
      contact_email: p.contact_email || "", finance_email: p.finance_email || "",
      business_address: p.business_address || "", bank_account_holder: p.bank_account_holder || "",
      bank_name: p.bank_name || "", bank_branch: p.bank_branch || ""
    });
    setBankNumber("");
  };

  useEffect(() => {
    api.sellerBusinessProfile().then(adopt).catch((e) => setError(e.message));
  }, []);

  if (error && !payload) return <EmptyState icon="⚠️" title="לא ניתן לטעון את הפרופיל העסקי" body={error} />;
  if (!payload) return <BrandLoader label="טוענים את הפרופיל העסקי…" minHeight={420} />;

  const statuses = payload.statuses || {};
  const last4 = payload.business_profile?.bank_account_last4 || "";
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const save = async () => {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const r = await api.saveSellerBusinessProfile({ ...form, bank_account_number: bankNumber });
      adopt(r);
      showToast("הפרופיל העסקי נשמר");
    } catch (e: any) { setError(e.message || "השמירה נכשלה"); }
    setBusy(false);
  };

  return (
    <div style={{ maxWidth: 680, margin: "0 auto" }}>
      <a className="back" href="#/seller" onClick={(e) => { e.preventDefault(); navigate("#/seller"); }}>→ לדשבורד</a>

      <div className="panel">
        <div className="panel-title">🏢 מצב החשבון העסקי</div>
        <div className="kv">
          <span className="k">פרטי העסק</span>
          <span className="v"><StatusBadge ok={Boolean(statuses.profile_complete)} okText="הושלמו" missingText="חסרים פרטים" /></span>
          <span className="k">אימות העסק</span>
          <span className="v"><span className="status ClosedForJoining">{VERIFICATION_LABELS[String(statuses.verification_status)] || String(statuses.verification_status || "בבדיקה")}</span></span>
          <span className="k">פרטי התחשבנות</span>
          <span className="v"><StatusBadge ok={Boolean(statuses.settlement_ready)} okText="מוכנים" missingText="חסרים פרטי בנק" /></span>
          <span className="k">חיבור לספק הסליקה</span>
          <span className="v"><span className="status ClosedForJoining">{GROW_LABELS[String(statuses.grow_onboarding)] || "טרם החל"}</span></span>
        </div>
        <p className="muted small" style={{ marginBottom: 0, marginTop: 10 }}>
          אימות העסק והחיבור לספק הסליקה הם תהליכים נפרדים שמאושרים על ידי הצוות והספק — מילוי הטופס אינו מאשר אותם אוטומטית.
        </p>
      </div>

      <div className="panel">
        <div className="panel-title">פרטי העסק</div>
        <div className="field-row">
          <div className="field"><label>שם העסק <span className="req">*</span></label><input value={form.business_name || ""} onChange={set("business_name")} maxLength={200} /></div>
          <div className="field"><label>שם משפטי רשום</label><input value={form.legal_name || ""} onChange={set("legal_name")} maxLength={200} /></div>
        </div>
        <div className="field-row">
          <div className="field"><label>ח.פ / עוסק <span className="req">*</span></label><input dir="ltr" inputMode="numeric" value={form.business_id_number || ""} onChange={set("business_id_number")} maxLength={20} /></div>
          <div className="field">
            <label>סוג התאגדות</label>
            <select value={form.entity_type || ""} onChange={set("entity_type")}>
              <option value="">בחירה…</option>
              {ENTITY_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>
        </div>
        <div className="field"><label>כתובת העסק</label><input value={form.business_address || ""} onChange={set("business_address")} maxLength={200} /></div>
      </div>

      <div className="panel">
        <div className="panel-title">איש קשר והתחשבנות</div>
        <div className="field-row">
          <div className="field"><label>שם איש קשר <span className="req">*</span></label><input value={form.contact_name || ""} onChange={set("contact_name")} maxLength={120} /></div>
          <div className="field"><label>טלפון</label><input dir="ltr" inputMode="tel" value={form.contact_phone || ""} onChange={set("contact_phone")} maxLength={30} /></div>
        </div>
        <div className="field-row">
          <div className="field"><label>אימייל ליצירת קשר</label><input dir="ltr" inputMode="email" value={form.contact_email || ""} onChange={set("contact_email")} maxLength={200} /></div>
          <div className="field"><label>אימייל לחשבוניות וכספים</label><input dir="ltr" inputMode="email" value={form.finance_email || ""} onChange={set("finance_email")} maxLength={200} /></div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-title">🏦 חשבון בנק לקבלת כספים</div>
        <div className="field-row">
          <div className="field"><label>שם בעל החשבון</label><input value={form.bank_account_holder || ""} onChange={set("bank_account_holder")} maxLength={120} /></div>
          <div className="field"><label>בנק</label><input value={form.bank_name || ""} onChange={set("bank_name")} maxLength={100} /></div>
        </div>
        <div className="field-row">
          <div className="field"><label>סניף</label><input dir="ltr" inputMode="numeric" value={form.bank_branch || ""} onChange={set("bank_branch")} maxLength={10} /></div>
          <div className="field">
            <label>מספר חשבון</label>
            <input dir="ltr" inputMode="numeric" autoComplete="off" value={bankNumber} onChange={(e) => setBankNumber(e.target.value)}
              placeholder={last4 ? `נשמר · מסתיים ב-${last4}` : ""} maxLength={30} />
            <span className="hint">{last4 ? "המספר המלא שמור ומוצפן — הזינו מספר חדש רק כדי להחליף אותו." : "המספר המלא נשמר בצד השרת בלבד ולעולם לא מוצג חזרה."}</span>
          </div>
        </div>
      </div>

      {error ? <div className="notice err">{error}</div> : null}
      <div className="row" style={{ justifyContent: "flex-end", marginBottom: 24 }}>
        <button className="btn btn-primary btn-lg" data-testid="business-profile-save" disabled={busy} onClick={save}>
          {busy ? "שומרים…" : "שמירת הפרופיל העסקי"}
        </button>
      </div>
      <Toast msg={toast} />
    </div>
  );
}

// ── entry ──────────────────────────────────────────────────────────────────
export function SellerArea({ sub, query, navigate }: { sub: string[]; query?: URLSearchParams; navigate: (h: string) => void }) {
  const [authed, setAuthed] = useState(Boolean(getSellerToken()));
  if (!authed) return <SellerLogin initialMode={query?.get("signup") ? "signup" : "login"} onDone={() => setAuthed(true)} />;
  if (sub[0] === "new") return <CreateWizard navigate={navigate} />;
  if (sub[0] === "profile") return <BusinessProfilePage navigate={navigate} />;
  if (sub[0] === "deal" && sub[1] && sub[2] === "viral") return <SellerViralTreePage dealId={sub[1]} navigate={navigate} />;
  if (sub[0] === "deal" && sub[1]) return <SellerDealScreen dealId={sub[1]} navigate={navigate} />;
  return <SellerDashboard navigate={navigate} />;
}
