import React, { useEffect, useMemo, useRef, useState } from "react";
import { api, Json } from "../api";
import { BrandLoader, EmptyState, Modal, Toast, useToast } from "../components";
import { formatIsraelDateTime, num } from "../util";
import { SCAN_OUTCOME_COPY, SCAN_OUTCOME_TEST_ID, formatPickupDigits, formatPickupTyping, normalizePickupInput, type ScanOutcome } from "../pickupCode";
import { cameraSupported, startPickupScanner, type ScannerHandle } from "../pickupScan";
import { t } from "../i18n";

// ── LAUNCH SPRINT 3 — seller pickup handoff ─────────────────────────────────
// Counter flow (docs/PHYSICAL_FULFILLMENT_PICKUP.md §5/§6/§10):
//   scan QR | type code | search phone/name → server resolves the seller's own
//   order → traffic-light card (never colour alone) → explicit confirmation
//   naming quantity, product and buyer → "נמסר ✓" → a repeat scan says
//   "כבר נמסר". The server is the only authority; a stale card is refused
//   (409 qty mismatch / not ready) and shown verbatim in product Hebrew.

const SELLER_PICKUP_COPY = {
  title: "סריקת איסוף",
  subtitle: "סרקו את קוד ה-QR של הקונה, הקלידו את הקוד או חפשו לפי טלפון/שם. המערכת מאמתת מול השרת שההזמנה שולמה ושייכת לכם.",
  tabScan: "סריקה",
  tabType: "הקלדת קוד",
  tabSearch: "חיפוש",
  startCamera: "הפעלת מצלמה",
  stopCamera: "כיבוי מצלמה",
  typeLabel: "קוד האיסוף (8 ספרות)",
  typeHint: "הקונה רואה את הקוד במסך המעקב, לדוגמה CT-4839-2175",
  typeSubmit: "אימות הקוד",
  searchLabel: "טלפון או שם הקונה",
  searchSubmit: "חיפוש",
  searchEmpty: "לא נמצאו הזמנות ששולמו עבור החיפוש הזה בעסקאות שהושלמו שלכם.",
  green: "מוכן למסירה",
  amber: "כבר נמסר",
  red: "אין למסור את ההזמנה",
  notFound: "הקוד אינו תקין",
  notFoundBody: "לא נמצאה הזמנה עם הקוד הזה בעסקאות שלכם. בדקו את הספרות מול הקונה, או חפשו לפי שם/טלפון.",
  confirm: "אישור מסירה",
  back: "חזרה",
  done: "נמסר",
  scanAgain: "סריקה נוספת",
  showPhone: "הצגת טלפון",
  hidePhone: "הסתרת טלפון",
  mock: "סביבת הדגמה — אין חיוב אמיתי"
} as const;

function verdictTone(verdict: string): "ready" | "already" | "blocked" {
  if (verdict === "ready") return "ready";
  if (verdict === "already_fulfilled") return "already";
  return "blocked";
}

function OrderFacts({ order, revealPhone, onTogglePhone }: { order: Json; revealPhone: boolean; onTogglePhone: () => void }) {
  return (
    <div className="kv handoff-facts">
      <span className="k">{t("pages.seller_pickup.628febf8")}</span><span className="v" data-testid="handoff-buyer">{order.buyer_name || "—"}</span>
      <span className="k">{t("pages.seller_pickup.737232c2")}</span>
      <span className="v" dir="ltr">
        {revealPhone && order.buyer_phone ? order.buyer_phone : (order.buyer_phone_masked || "—")}
        {order.buyer_phone ? <button type="button" className="chip-btn" style={{ marginInlineStart: 8 }} onClick={onTogglePhone}>{revealPhone ? SELLER_PICKUP_COPY.hidePhone : SELLER_PICKUP_COPY.showPhone}</button> : null}
      </span>
      <span className="k">{t("pages.seller_pickup.80a08f9c")}</span><span className="v" data-testid="handoff-product">{order.product_title}</span>
      <span className="k">{t("pages.seller_pickup.d4e2d05b")}</span><span className="v handoff-qty" data-testid="handoff-qty">{t("pages.seller_pickup.53ab3dca", { qty: num(order.qty) })}</span>
      <span className="k">{t("pages.seller_pickup.849f23b3")}</span>
      <span className="v" data-testid="handoff-payment">{order.paid ? <span className="status Completed">{order.payment_label} ✓</span> : <span className="status Failed">{order.payment_label}</span>}</span>
      <span className="k">{t("pages.seller_pickup.bd008360")}</span><span className="v">{order.method_label}</span>
      {order.method === "pickup" && order.pickup_location ? <><span className="k">{t("pages.seller_pickup.08cb93c0")}</span><span className="v">{order.pickup_location}</span></> : null}
      {order.method === "delivery" && order.delivery_address ? <><span className="k">{t("pages.seller_pickup.daab1ad0")}</span><span className="v">{order.delivery_address}{order.delivery_city ? `, ${order.delivery_city}` : ""}</span></> : null}
      {order.delivery_notes ? <><span className="k">{t("pages.seller_pickup.adc51e32")}</span><span className="v">{order.delivery_notes}</span></> : null}
      <span className="k">{t("pages.seller_pickup.3f8e78d1")}</span><span className="v pickup-code-inline" dir="ltr" data-testid="handoff-code">{order.order_code || "—"}</span>
    </div>
  );
}

// The traffic-light result. `data-state` + icon + text carry the meaning; colour is secondary.
export function HandoffResultCard({ order, mockMoney, onConfirmed, onReset }: { order: Json; mockMoney: boolean; onConfirmed: (updated: Json) => void; onReset: () => void }) {
  const tone = verdictTone(String(order.verdict));
  const [revealPhone, setRevealPhone] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState("");
  const intentKey = useRef("");
  const qty = Number(order.qty || 0);
  const openConfirm = () => { intentKey.current = crypto.randomUUID(); setRefusal(""); setConfirming(true); };
  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await api.sellerPickupHandoff({ participant_id: order.participant_id, order_code: order.order_code || undefined, expected_qty: qty, source: order.__source || "scan" }, intentKey.current);
      setConfirming(false);
      onConfirmed(r);
    } catch (e: any) {
      const body = e?.body || {};
      if (body.order) { setConfirming(false); onConfirmed({ ...body, refused: true }); return; }
      setRefusal(String(e?.message || t("pages.seller_pickup.776da385")));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={`panel handoff-card handoff-${tone}`} data-testid="handoff-result" data-state={tone} data-verdict={String(order.verdict)}>
      <div className="handoff-verdict">
        <span className="handoff-verdict-icon" aria-hidden="true">{tone === "ready" ? "✓" : tone === "already" ? "◑" : "✕"}</span>
        <span className="handoff-verdict-text" data-testid="handoff-verdict">{tone === "ready" ? SELLER_PICKUP_COPY.green : tone === "already" ? SELLER_PICKUP_COPY.amber : SELLER_PICKUP_COPY.red}</span>
      </div>
      {tone === "blocked" ? <div className="handoff-reason" data-testid="handoff-reason">{order.not_ready_label || t("pages.seller_pickup.db416784")}</div> : null}
      {tone === "already" && order.fulfilled_at ? <div className="handoff-reason" data-testid="handoff-fulfilled-at">{t("pages.seller_pickup.60c4d50c", { fulfilled_at: formatIsraelDateTime(String(order.fulfilled_at)) })}</div> : null}
      <OrderFacts order={order} revealPhone={revealPhone} onTogglePhone={() => setRevealPhone((v) => !v)} />
      {mockMoney ? <p className="muted small" style={{ margin: "8px 0 0" }}>{SELLER_PICKUP_COPY.mock}</p> : null}
      <div className="row" style={{ marginTop: 14, gap: 8 }}>
        {tone === "ready" ? (
          <button type="button" className="btn btn-primary btn-lg btn-block" data-testid="handoff-confirm-open" onClick={openConfirm}>
            {t("pages.seller_pickup.6719a2e4", { qty: num(qty) })}</button>
        ) : null}
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <button type="button" className="btn btn-ghost btn-sm" data-testid="handoff-reset" onClick={onReset}>{SELLER_PICKUP_COPY.scanAgain}</button>
      </div>
      {confirming ? (
        <Modal title={t("pages.seller_pickup.44291ad2")} onClose={() => { if (!busy) setConfirming(false); }}
          footer={
            <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
              <button type="button" className="btn btn-ghost" data-testid="handoff-confirm-back" disabled={busy} onClick={() => setConfirming(false)}>{SELLER_PICKUP_COPY.back}</button>
              <button type="button" className="btn btn-primary btn-lg" data-testid="handoff-confirm" disabled={busy} onClick={confirm}>{busy ? t("pages.seller_pickup.dcde6a09") : SELLER_PICKUP_COPY.confirm}</button>
            </div>
          }>
          <p className="handoff-confirm-line" data-testid="handoff-confirm-line">
            {t("pages.seller_pickup.952d9ba3")} <b>{t("pages.seller_pickup.53ab3dca", { qty: num(qty) })}</b>  {t("pages.seller_pickup.2b6526db")} <b>{order.product_title}</b>  {t("pages.seller_pickup.d67cdc0f")}<b>{order.buyer_name || t("pages.seller_pickup.8f69a20a")}</b>.
          </p>
          {qty > 1 ? <p className="muted small">{t("pages.seller_pickup.e77893e3", { qty: num(qty) })}</p> : null}
          {refusal ? <div className="notice err" data-testid="handoff-refused">{refusal}</div> : null}
        </Modal>
      ) : null}
    </div>
  );
}

function HandoffDone({ result, onReset }: { result: Json; onReset: () => void }) {
  const order = result.order || {};
  const already = Boolean(result.already_fulfilled || result.idempotent);
  const refused = Boolean(result.refused);
  return (
    <div className={`panel handoff-card ${refused ? "handoff-blocked" : "handoff-done"}`} data-testid="handoff-done" data-state={refused ? "blocked" : already ? "already" : "done"}>
      <div className="handoff-verdict">
        <span className="handoff-verdict-icon" aria-hidden="true">{refused ? "✕" : "✓"}</span>
        <span className="handoff-verdict-text" data-testid="handoff-done-text">{refused ? SELLER_PICKUP_COPY.red : already ? SELLER_PICKUP_COPY.amber : SELLER_PICKUP_COPY.done}</span>
      </div>
      <div className="handoff-reason">
        {refused ? (result.message || order.not_ready_label || "") : `${num(order.qty)} יחידות של ${order.product_title} — ${order.buyer_name || "הקונה"}`}
        {result.fulfilled_at ? <div className="small">{t("pages.seller_pickup.60c4d50c", { fulfilled_at: formatIsraelDateTime(String(result.fulfilled_at)) })}</div> : null}
      </div>
      {order.order_code ? <div className="pickup-code-inline" dir="ltr" style={{ marginTop: 6 }}>{order.order_code}</div> : null}
      <div className="row" style={{ marginTop: 14 }}>
        <button type="button" className="btn btn-primary" data-testid="handoff-next" onClick={onReset}>{SELLER_PICKUP_COPY.scanAgain}</button>
      </div>
    </div>
  );
}

export function SellerPickupPage({ navigate, initialCode }: { navigate: (h: string) => void; initialCode?: string | null }) {
  const [tab, setTab] = useState<"scan" | "type" | "search">(initialCode ? "type" : "scan");
  const [outcome, setOutcome] = useState<ScanOutcome>("idle");
  const [outcomeDetail, setOutcomeDetail] = useState("");
  const [typed, setTyped] = useState(() => (initialCode ? formatPickupTyping(normalizePickupInput(initialCode) || "").display : ""));
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<Json[] | null>(null);
  const [resolving, setResolving] = useState(false);
  const [order, setOrder] = useState<Json | null>(null);
  const [notFound, setNotFound] = useState("");
  const [done, setDone] = useState<Json | null>(null);
  const [mockMoney, setMockMoney] = useState(false);
  const [toast, showToast] = useToast();
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scanner = useRef<ScannerHandle | null>(null);
  const support = useMemo(() => cameraSupported(), []);

  const stopCamera = () => { scanner.current?.stop(); scanner.current = null; };
  useEffect(() => () => stopCamera(), []);

  const resetAll = () => { setOrder(null); setDone(null); setNotFound(""); setResults(null); setOutcome("idle"); setOutcomeDetail(""); };

  const resolveCode = async (code: string, source: "scan" | "manual") => {
    setResolving(true); setNotFound(""); setOrder(null); setDone(null);
    try {
      const r = await api.sellerPickupResolve(code);
      setMockMoney(Boolean(r.mock_money));
      setOrder({ ...r.order, __source: source });
    } catch (e: any) {
      const codeName = String(e?.body?.code || "");
      if (Number(e?.status) === 404 || codeName === "pickup_code_not_found") setNotFound(SELLER_PICKUP_COPY.notFoundBody);
      else setNotFound(String(e?.message || t("pages.seller_pickup.8d30c587")));
    } finally { setResolving(false); }
  };

  const startCamera = async () => {
    if (!videoRef.current || !canvasRef.current) return;
    stopCamera();
    resetAll();
    scanner.current = await startPickupScanner({
      video: videoRef.current,
      canvas: canvasRef.current,
      onOutcome: (o, detail) => { setOutcome(o); setOutcomeDetail(detail || ""); },
      onCode: (code) => { void resolveCode(code, "scan"); }
    });
  };

  const submitTyped = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const digits = normalizePickupInput(typed);
    if (!digits) { setNotFound(t("pages.seller_pickup.0ef6598c")); return; }
    stopCamera();
    await resolveCode(formatPickupDigits(digits), "manual");
  };

  const submitSearch = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const q = query.trim();
    if (q.length < 2) return;
    stopCamera();
    setSearching(true); setNotFound(""); setOrder(null); setDone(null);
    try {
      const r = await api.sellerPickupSearch(q);
      setMockMoney(Boolean(r.mock_money));
      setResults(Array.isArray(r.orders) ? r.orders : []);
    } catch (e: any) { showToast(String(e?.message || t("pages.seller_pickup.78129d3a"))); }
    finally { setSearching(false); }
  };

  useEffect(() => {
    if (initialCode) {
      const digits = normalizePickupInput(initialCode);
      if (digits) void resolveCode(formatPickupDigits(digits), "scan");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialCode]);

  return (
    <div className="pickup-page" data-testid="seller-pickup-page">
      <a className="back" href="#/seller" onClick={(e) => { e.preventDefault(); stopCamera(); navigate("#/seller"); }}>{t("pages.seller_pickup.123e15aa")}</a>
      <h1 style={{ marginBottom: 4 }}>{SELLER_PICKUP_COPY.title}</h1>
      <p className="muted" style={{ marginTop: 0 }}>{SELLER_PICKUP_COPY.subtitle}</p>

      {done ? <HandoffDone result={done} onReset={resetAll} /> : null}
      {!done && order ? <HandoffResultCard order={order} mockMoney={mockMoney} onConfirmed={(r) => { setDone(r); setOrder(null); }} onReset={resetAll} /> : null}
      {!done && !order && notFound ? (
        <div className="panel handoff-card handoff-blocked" data-testid="handoff-result" data-state="blocked" data-verdict="not_found">
          <div className="handoff-verdict"><span className="handoff-verdict-icon" aria-hidden="true">✕</span><span className="handoff-verdict-text" data-testid="handoff-verdict">{SELLER_PICKUP_COPY.notFound}</span></div>
          <div className="handoff-reason" data-testid="handoff-reason">{notFound}</div>
        </div>
      ) : null}

      <div className="pickup-tabs" role="tablist" aria-label={t("pages.seller_pickup.3a8ce242")}>
        {([["scan", SELLER_PICKUP_COPY.tabScan], ["type", SELLER_PICKUP_COPY.tabType], ["search", SELLER_PICKUP_COPY.tabSearch]] as const).map(([k, l]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={`pickup-tab${tab === k ? " active" : ""}`} data-testid={`pickup-tab-${k}`} onClick={() => { if (k !== "scan") stopCamera(); setTab(k); }}>{l}</button>
        ))}
      </div>

      {tab === "scan" ? (
        <div className="panel" data-testid="pickup-scan-panel">
          <div className="handoff-scan">
            <video ref={videoRef} className="handoff-video" playsInline muted aria-label={t("pages.seller_pickup.8733d9b4")} />
            <canvas ref={canvasRef} hidden aria-hidden="true" />
            {outcome === "idle" || outcome === "stopped" ? <div className="handoff-scan-overlay">{t("pages.seller_pickup.84fb0aed")}</div> : null}
          </div>
          <p className="small" data-testid={SCAN_OUTCOME_TEST_ID[outcome]} data-outcome={outcome} style={{ margin: "10px 0 6px" }}>
            {SCAN_OUTCOME_COPY[outcome]}
            {outcome === "not_our_code" && outcomeDetail ? <span className="muted"> {t("pages.seller_pickup.e0c3cdd8", { v0: outcomeDetail.slice(0, 40) })}</span> : null}
          </p>
          <div className="row" style={{ gap: 8 }}>
            {outcome === "scanning" || outcome === "starting" ? (
              <button type="button" className="btn btn-ghost" data-testid="pickup-camera-stop" onClick={stopCamera}>{SELLER_PICKUP_COPY.stopCamera}</button>
            ) : (
              <button type="button" className="btn btn-primary" data-testid="pickup-camera-start" disabled={resolving || !support.ok} onClick={startCamera}>{SELLER_PICKUP_COPY.startCamera}</button>
            )}
            <button type="button" className="btn btn-ghost" data-testid="pickup-switch-type" onClick={() => { stopCamera(); setTab("type"); }}>{SELLER_PICKUP_COPY.tabType}</button>
          </div>
          {!support.ok ? <p className="muted small" style={{ marginTop: 8 }}>{SCAN_OUTCOME_COPY[support.outcome || "unsupported"]}</p> : null}
        </div>
      ) : null}

      {tab === "type" ? (
        <form className="panel" data-testid="pickup-type-panel" onSubmit={submitTyped}>
          <label className="field">
            <span>{SELLER_PICKUP_COPY.typeLabel}</span>
            <div className="pickup-input-wrap" dir="ltr">
              <span className="pickup-input-prefix">CT-</span>
              <input
                className="pickup-input"
                data-testid="pickup-code-input"
                inputMode="numeric"
                autoComplete="off"
                pattern="[0-9\-]*"
                placeholder="4839-2175"
                aria-label={SELLER_PICKUP_COPY.typeLabel}
                value={typed}
                onChange={(e) => setTyped(formatPickupTyping(e.target.value).display)}
                autoFocus
              />
            </div>
          </label>
          <p className="muted small" style={{ marginTop: 4 }}>{SELLER_PICKUP_COPY.typeHint}</p>
          <button type="submit" className="btn btn-primary btn-lg btn-block" data-testid="pickup-code-submit" disabled={resolving || !formatPickupTyping(typed).complete}>
            {resolving ? t("pages.seller_pickup.b14aaf63") : SELLER_PICKUP_COPY.typeSubmit}
          </button>
        </form>
      ) : null}

      {tab === "search" ? (
        <div className="panel" data-testid="pickup-search-panel">
          <form onSubmit={submitSearch}>
            <label className="field">
              <span>{SELLER_PICKUP_COPY.searchLabel}</span>
              <input data-testid="pickup-search-input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("pages.seller_pickup.39f3aeed")} autoComplete="off" />
            </label>
            <button type="submit" className="btn btn-primary" data-testid="pickup-search-submit" disabled={searching || query.trim().length < 2}>{searching ? t("pages.seller_pickup.b89c236a") : SELLER_PICKUP_COPY.searchSubmit}</button>
          </form>
          {results ? (
            results.length ? (
              <div className="stack" style={{ marginTop: 12 }} data-testid="pickup-search-results">
                {results.map((o) => (
                  <button key={o.participant_id} type="button" className={`order-row order-${verdictTone(String(o.verdict))}`} data-testid="pickup-search-hit" onClick={() => { setResults(null); setOrder({ ...o, __source: "search" }); }}>
                    <span className="order-row-main"><b>{o.buyer_name || "—"}</b> · {o.product_title}</span>
                    <span className="order-row-sub" dir="ltr">{o.buyer_phone_masked || ""} · {o.order_code || "—"}</span>
                    <span className="order-row-state">{verdictTone(String(o.verdict)) === "ready" ? t("pages.seller_pickup.6ee010b2", { green: SELLER_PICKUP_COPY.green, qty: num(o.qty) }) : verdictTone(String(o.verdict)) === "already" ? SELLER_PICKUP_COPY.amber : (o.not_ready_label || SELLER_PICKUP_COPY.red)}</span>
                  </button>
                ))}
              </div>
            ) : <p className="muted small" style={{ marginTop: 10 }} data-testid="pickup-search-empty">{SELLER_PICKUP_COPY.searchEmpty}</p>
          ) : null}
        </div>
      ) : null}
      <Toast msg={toast} />
    </div>
  );
}

// ── Deal-level operational list: "הזמנות למסירה" ────────────────────────────
export function SellerFulfillmentPage({ dealId, navigate }: { dealId: string; navigate: (h: string) => void }) {
  const [payload, setPayload] = useState<Json | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState<"pending" | "fulfilled" | "all">("pending");
  const [q, setQ] = useState("");
  const [active, setActive] = useState<Json | null>(null);
  const [done, setDone] = useState<Json | null>(null);
  const [toast, showToast] = useToast();
  const load = async () => {
    try { setPayload(await api.sellerDealFulfillment(dealId, { status, q })); setError(""); }
    catch (e: any) { setError(String(e?.message || t("pages.seller_pickup.8574a044"))); }
  };
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [dealId, status]);
  if (error) return <EmptyState title={t("pages.seller_pickup.353a8367")} body={error} action={<a className="btn btn-ghost" href={`#/seller/deal/${dealId}`}>{t("pages.seller_pickup.8d4d7e16")}</a>} />;
  if (!payload) return <BrandLoader label={t("pages.seller_pickup.8e46b6c8")} minHeight={360} />;
  const counts = payload.counts || {};
  const orders: Json[] = Array.isArray(payload.orders) ? payload.orders : [];
  return (
    <div className="pickup-page" data-testid="seller-fulfillment-page">
      <a className="back" href={`#/seller/deal/${dealId}`} onClick={(e) => { e.preventDefault(); navigate(`#/seller/deal/${dealId}`); }}>{t("pages.seller_pickup.fbd4509a")}</a>
      <div className="row" style={{ alignItems: "baseline", gap: 10 }}>
        <h1 style={{ margin: 0 }}>{t("pages.seller_pickup.1ac278ad")}</h1>
        <span className="muted">{payload.deal?.title}</span>
      </div>
      <div className="stat-row fulfillment-stats">
        <div className="stat-tile"><div className="num" data-testid="fulfillment-awaiting">{num(counts.awaiting)}</div><div className="lbl">{t("pages.seller_pickup.f1a84bdc")}</div></div>
        <div className="stat-tile good"><div className="num" data-testid="fulfillment-fulfilled">{num(counts.fulfilled)}</div><div className="lbl">{t("pages.seller_pickup.96ac9ea8")}</div></div>
        {Number(counts.blocked) > 0 ? <div className="stat-tile bad"><div className="num">{num(counts.blocked)}</div><div className="lbl">{t("pages.seller_pickup.c94e0409")}</div></div> : null}
      </div>
      <div className="row" style={{ gap: 8, marginTop: 12 }}>
        <button type="button" className="btn btn-primary" data-testid="fulfillment-scan" onClick={() => navigate("#/seller/pickup")}>{t("pages.seller_pickup.2d843402")}</button>
        <a className="btn btn-ghost btn-sm" href={`/api/seller/deals/${dealId}/delivery-handoff/export.xlsx`} target="_blank" rel="noreferrer">{t("pages.seller_pickup.cea01d82")}</a>
      </div>
      <div className="pickup-tabs" role="tablist" aria-label={t("pages.seller_pickup.371bb0b5")} style={{ marginTop: 12 }}>
        {([["pending", t("pages.seller_pickup.f1a84bdc")], ["fulfilled", t("pages.seller_pickup.96ac9ea8")], ["all", t("pages.seller_pickup.d0940366")]] as const).map(([k, l]) => (
          <button key={k} type="button" role="tab" aria-selected={status === k} className={`pickup-tab${status === k ? " active" : ""}`} data-testid={`fulfillment-filter-${k}`} onClick={() => setStatus(k)}>{l}</button>
        ))}
      </div>
      <form className="row" style={{ gap: 8, marginTop: 8 }} onSubmit={(e) => { e.preventDefault(); void load(); }}>
        <input data-testid="fulfillment-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("pages.seller_pickup.e555b927")} aria-label={t("pages.seller_pickup.124fb3bd")} style={{ flex: 1, minWidth: 0 }} />
        <button type="submit" className="btn btn-ghost btn-sm">{t("pages.seller_pickup.6d6d7964")}</button>
      </form>
      {done ? <HandoffDone result={done} onReset={() => { setDone(null); void load(); }} /> : null}
      {active ? <HandoffResultCard order={active} mockMoney={Boolean(payload.mock_money)} onConfirmed={(r) => { setActive(null); setDone(r); void load(); }} onReset={() => setActive(null)} /> : null}
      {!orders.length ? (
        <p className="muted" style={{ marginTop: 14 }} data-testid="fulfillment-empty">{status === "pending" ? t("pages.seller_pickup.370f6f1d") : status === "fulfilled" ? t("pages.seller_pickup.460e4463") : t("pages.seller_pickup.c4f1adf3")}</p>
      ) : (
        <div className="stack" style={{ marginTop: 12 }} data-testid="fulfillment-list">
          {orders.map((o) => {
            const tone = verdictTone(String(o.verdict));
            return (
              <div key={o.participant_id} className={`order-card order-${tone}`} data-testid="fulfillment-row" data-state={tone}>
                <div className="order-card-head">
                  <span className="pickup-code-inline" dir="ltr">{o.order_code || "—"}</span>
                  <span className={`status ${tone === "ready" ? "PendingTarget" : tone === "already" ? "Completed" : "Failed"}`}>{tone === "ready" ? t("pages.seller_pickup.a21eb3c2") : tone === "already" ? t("pages.seller_pickup.8b72a1ae") : (o.not_ready_label || t("pages.seller_pickup.c94e0409"))}</span>
                </div>
                <div className="order-card-main"><b>{o.buyer_name || "—"}</b> <span dir="ltr" className="muted">{o.buyer_phone || ""}</span></div>
                <div className="order-card-sub">
                  <span className="handoff-qty">{t("pages.seller_pickup.ef4c4faf", { qty: num(o.qty) })}</span> · {o.method_label}{o.method === "delivery" && o.delivery_city ? ` · ${o.delivery_city}` : ""} · {o.paid ? t("pages.seller_pickup.c529badd") : o.payment_label}
                  {tone === "already" && o.fulfilled_at ? t("pages.seller_pickup.b882a3d0", { fulfilled_at: formatIsraelDateTime(String(o.fulfilled_at)) }) : ""}
                </div>
                {tone === "ready" ? (
                  <button type="button" className="btn btn-primary btn-sm" data-testid="fulfillment-row-confirm" onClick={() => { setDone(null); setActive({ ...o, __source: "list" }); window.scrollTo({ top: 0 }); }}>
                    {t("pages.seller_pickup.6719a2e4", { qty: num(o.qty) })}</button>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
      <p className="muted small" style={{ marginTop: 14 }}>{payload.disclaimer}</p>
      <Toast msg={toast} />
    </div>
  );
}
