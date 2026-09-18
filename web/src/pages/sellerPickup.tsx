import React, { useEffect, useMemo, useRef, useState } from "react";
import { api, Json } from "../api";
import { BrandLoader, EmptyState, Modal, Toast, useToast } from "../components";
import { formatIsraelDateTime, num } from "../util";
import { SCAN_OUTCOME_COPY, SCAN_OUTCOME_TEST_ID, formatPickupDigits, formatPickupTyping, normalizePickupInput, type ScanOutcome } from "../pickupCode";
import { cameraSupported, startPickupScanner, type ScannerHandle } from "../pickupScan";
import { t } from "../i18n/index.js";
import { Tx } from "../i18n/Tx.js";

// ── LAUNCH SPRINT 3 — seller pickup handoff ─────────────────────────────────
// Counter flow (docs/PHYSICAL_FULFILLMENT_PICKUP.md §5/§6/§10):
//   scan QR | type code | search phone/name → server resolves the seller's own
//   order → traffic-light card (never colour alone) → explicit confirmation
//   naming quantity, product and buyer → "נמסר ✓" → a repeat scan says
//   "כבר נמסר". The server is the only authority; a stale card is refused
//   (409 qty mismatch / not ready) and shown verbatim in product Hebrew.

const SELLER_PICKUP_COPY = {
  title: "seller_pickup.seller_pickup_copy.title",
  subtitle: "seller_pickup.seller_pickup_copy.subtitle",
  tabScan: "seller_pickup.seller_pickup_copy.tab_scan",
  tabType: "seller_pickup.seller_pickup_copy.tab_type",
  tabSearch: "seller_pickup.seller_pickup_copy.tab_search",
  startCamera: "seller_pickup.seller_pickup_copy.start_camera",
  stopCamera: "seller_pickup.seller_pickup_copy.stop_camera",
  typeLabel: "seller_pickup.seller_pickup_copy.type_label",
  typeHint: "seller_pickup.seller_pickup_copy.type_hint",
  typeSubmit: "seller_pickup.seller_pickup_copy.type_submit",
  searchLabel: "seller_pickup.seller_pickup_copy.search_label",
  searchSubmit: "seller_pickup.seller_pickup_copy.search_submit",
  searchEmpty: "seller_pickup.seller_pickup_copy.search_empty",
  green: "seller_pickup.seller_pickup_copy.green",
  amber: "seller_pickup.seller_pickup_copy.amber",
  red: "seller_pickup.seller_pickup_copy.red",
  notFound: "seller_pickup.seller_pickup_copy.not_found",
  notFoundBody: "seller_pickup.seller_pickup_copy.not_found_body",
  confirm: "seller_pickup.seller_pickup_copy.confirm",
  back: "seller_pickup.seller_pickup_copy.back",
  done: "seller_pickup.seller_pickup_copy.done",
  scanAgain: "seller_pickup.seller_pickup_copy.scan_again",
  showPhone: "seller_pickup.seller_pickup_copy.show_phone",
  hidePhone: "seller_pickup.seller_pickup_copy.hide_phone",
  mock: "seller_pickup.seller_pickup_copy.mock"
} as const;

function verdictTone(verdict: string): "ready" | "already" | "blocked" {
  if (verdict === "ready") return "ready";
  if (verdict === "already_fulfilled") return "already";
  return "blocked";
}

function OrderFacts({ order, revealPhone, onTogglePhone }: { order: Json; revealPhone: boolean; onTogglePhone: () => void }) {
  return (
    <div className="kv handoff-facts">
      <span className="k">{t("seller_pickup.buyer")}</span><span className="v" data-testid="handoff-buyer">{order.buyer_name || "—"}</span>
      <span className="k">{t("seller_pickup.phone")}</span>
      <span className="v" dir="ltr">
        {revealPhone && order.buyer_phone ? order.buyer_phone : (order.buyer_phone_masked || "—")}
        {order.buyer_phone ? <button type="button" className="chip-btn" style={{ marginInlineStart: 8 }} onClick={onTogglePhone}>{revealPhone ? t(SELLER_PICKUP_COPY.hidePhone) : t(SELLER_PICKUP_COPY.showPhone)}</button> : null}
      </span>
      <span className="k">{t("seller_pickup.product")}</span><span className="v" data-testid="handoff-product">{order.product_title}</span>
      <span className="k">{t("seller_pickup.quantity")}</span><span className="v handoff-qty" data-testid="handoff-qty">{t("seller_pickup.qty_units", { qty: num(order.qty) })}</span>
      <span className="k">{t("seller_pickup.payment")}</span>
      <span className="v" data-testid="handoff-payment">{order.paid ? <span className="status Completed">{order.payment_label} ✓</span> : <span className="status Failed">{order.payment_label}</span>}</span>
      <span className="k">{t("seller_pickup.how_receive")}</span><span className="v">{order.method_label}</span>
      {order.method === "pickup" && order.pickup_location ? <><span className="k">{t("seller_pickup.pickup_point")}</span><span className="v">{order.pickup_location}</span></> : null}
      {order.method === "delivery" && order.delivery_address ? <><span className="k">{t("seller_pickup.address")}</span><span className="v">{order.delivery_address}{order.delivery_city ? `, ${order.delivery_city}` : ""}</span></> : null}
      {order.delivery_notes ? <><span className="k">{t("seller_pickup.note")}</span><span className="v">{order.delivery_notes}</span></> : null}
      <span className="k">{t("seller_pickup.order_code")}</span><span className="v pickup-code-inline" dir="ltr" data-testid="handoff-code">{order.order_code || "—"}</span>
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
      setRefusal(String(e?.message || t("seller_pickup.the_handover_recorded_try_again")));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={`panel handoff-card handoff-${tone}`} data-testid="handoff-result" data-state={tone} data-verdict={String(order.verdict)}>
      <div className="handoff-verdict">
        <span className="handoff-verdict-icon" aria-hidden="true">{tone === "ready" ? "✓" : tone === "already" ? "◑" : "✕"}</span>
        <span className="handoff-verdict-text" data-testid="handoff-verdict">{tone === "ready" ? t(SELLER_PICKUP_COPY.green) : tone === "already" ? t(SELLER_PICKUP_COPY.amber) : t(SELLER_PICKUP_COPY.red)}</span>
      </div>
      {tone === "blocked" ? <div className="handoff-reason" data-testid="handoff-reason">{order.not_ready_label || t("seller_pickup.the_order_eligible_handover")}</div> : null}
      {tone === "already" && order.fulfilled_at ? <div className="handoff-reason" data-testid="handoff-fulfilled-at">{t("seller_pickup.handed_over_fulfilled", { fulfilled_at: formatIsraelDateTime(String(order.fulfilled_at)) })}</div> : null}
      <OrderFacts order={order} revealPhone={revealPhone} onTogglePhone={() => setRevealPhone((v) => !v)} />
      {mockMoney ? <p className="muted small" style={{ margin: "8px 0 0" }}>{t(SELLER_PICKUP_COPY.mock)}</p> : null}
      <div className="row" style={{ marginTop: 14, gap: 8 }}>
        {tone === "ready" ? (
          <button type="button" className="btn btn-primary btn-lg btn-block" data-testid="handoff-confirm-open" onClick={openConfirm}>
            {t("seller_pickup.confirm_handover_qty_units", { qty: num(qty) })}</button>
        ) : null}
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <button type="button" className="btn btn-ghost btn-sm" data-testid="handoff-reset" onClick={onReset}>{t(SELLER_PICKUP_COPY.scanAgain)}</button>
      </div>
      {confirming ? (
        <Modal title={t("seller_pickup.confirm_handover")} onClose={() => { if (!busy) setConfirming(false); }}
          footer={
            <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
              <button type="button" className="btn btn-ghost" data-testid="handoff-confirm-back" disabled={busy} onClick={() => setConfirming(false)}>{t(SELLER_PICKUP_COPY.back)}</button>
              <button type="button" className="btn btn-primary btn-lg" data-testid="handoff-confirm" disabled={busy} onClick={confirm}>{busy ? t("seller_pickup.recording") : t(SELLER_PICKUP_COPY.confirm)}</button>
            </div>
          }>
          <p className="handoff-confirm-line" data-testid="handoff-confirm-line">
            {/* ONE sentence, one key: the quantity, the product and the buyer
                move to wherever the target language needs them. Splitting it
                into four fragments would freeze Hebrew word order. */}
            <Tx k="seller_pickup.handing_over_now" vars={{
              qty: <b>{t("seller_pickup.qty_units", { qty: num(qty) })}</b>,
              product: <b>{order.product_title}</b>,
              buyer: <b>{order.buyer_name || t("seller_pickup.the_buyer")}</b>
            }} />
          </p>
          {qty > 1 ? <p className="muted small">{t("seller_pickup.confirming_handover_marks_all_qty", { qty: num(qty) })}</p> : null}
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
        <span className="handoff-verdict-text" data-testid="handoff-done-text">{refused ? t(SELLER_PICKUP_COPY.red) : already ? t(SELLER_PICKUP_COPY.amber) : t(SELLER_PICKUP_COPY.done)}</span>
      </div>
      <div className="handoff-reason">
        {refused ? (result.message || order.not_ready_label || "") : t("seller_pickup.order_summary", { qty: num(order.qty), product: order.product_title, buyer: order.buyer_name || t("seller_pickup.buyer_fallback") })}
        {result.fulfilled_at ? <div className="small">{t("seller_pickup.handed_over_fulfilled", { fulfilled_at: formatIsraelDateTime(String(result.fulfilled_at)) })}</div> : null}
      </div>
      {order.order_code ? <div className="pickup-code-inline" dir="ltr" style={{ marginTop: 6 }}>{order.order_code}</div> : null}
      <div className="row" style={{ marginTop: 14 }}>
        <button type="button" className="btn btn-primary" data-testid="handoff-next" onClick={onReset}>{t(SELLER_PICKUP_COPY.scanAgain)}</button>
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
      if (Number(e?.status) === 404 || codeName === "pickup_code_not_found") setNotFound(t(SELLER_PICKUP_COPY.notFoundBody));
      else setNotFound(String(e?.message || t("seller_pickup.verification_failed_try_again")));
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
    if (!digits) { setNotFound(t("seller_pickup.type_8_digits_example_4839")); return; }
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
    } catch (e: any) { showToast(String(e?.message || t("seller_pickup.the_search_failed"))); }
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
      <a className="back" href="#/seller" onClick={(e) => { e.preventDefault(); stopCamera(); navigate("#/seller"); }}>{t("seller_pickup.to_seller_area")}</a>
      <h1 style={{ marginBottom: 4 }}>{t(SELLER_PICKUP_COPY.title)}</h1>
      <p className="muted" style={{ marginTop: 0 }}>{t(SELLER_PICKUP_COPY.subtitle)}</p>

      {done ? <HandoffDone result={done} onReset={resetAll} /> : null}
      {!done && order ? <HandoffResultCard order={order} mockMoney={mockMoney} onConfirmed={(r) => { setDone(r); setOrder(null); }} onReset={resetAll} /> : null}
      {!done && !order && notFound ? (
        <div className="panel handoff-card handoff-blocked" data-testid="handoff-result" data-state="blocked" data-verdict="not_found">
          <div className="handoff-verdict"><span className="handoff-verdict-icon" aria-hidden="true">✕</span><span className="handoff-verdict-text" data-testid="handoff-verdict">{t(SELLER_PICKUP_COPY.notFound)}</span></div>
          <div className="handoff-reason" data-testid="handoff-reason">{notFound}</div>
        </div>
      ) : null}

      <div className="pickup-tabs" role="tablist" aria-label={t("seller_pickup.identification_method")}>
        {([["scan", t(SELLER_PICKUP_COPY.tabScan)], ["type", t(SELLER_PICKUP_COPY.tabType)], ["search", t(SELLER_PICKUP_COPY.tabSearch)]] as const).map(([k, l]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={`pickup-tab${tab === k ? " active" : ""}`} data-testid={`pickup-tab-${k}`} onClick={() => { if (k !== "scan") stopCamera(); setTab(k); }}>{l}</button>
        ))}
      </div>

      {tab === "scan" ? (
        <div className="panel" data-testid="pickup-scan-panel">
          <div className="handoff-scan">
            <video ref={videoRef} className="handoff-video" playsInline muted aria-label={t("seller_pickup.camera_view")} />
            <canvas ref={canvasRef} hidden aria-hidden="true" />
            {outcome === "idle" || outcome === "stopped" ? <div className="handoff-scan-overlay">{t("seller_pickup.the_camera_off")}</div> : null}
          </div>
          <p className="small" data-testid={SCAN_OUTCOME_TEST_ID[outcome]} data-outcome={outcome} style={{ margin: "10px 0 6px" }}>
            {t(SCAN_OUTCOME_COPY[outcome])}
            {outcome === "not_our_code" && outcomeDetail ? <span className="muted"> {t("seller_pickup.read_v0", { v0: outcomeDetail.slice(0, 40) })}</span> : null}
          </p>
          <div className="row" style={{ gap: 8 }}>
            {outcome === "scanning" || outcome === "starting" ? (
              <button type="button" className="btn btn-ghost" data-testid="pickup-camera-stop" onClick={stopCamera}>{t(SELLER_PICKUP_COPY.stopCamera)}</button>
            ) : (
              <button type="button" className="btn btn-primary" data-testid="pickup-camera-start" disabled={resolving || !support.ok} onClick={startCamera}>{t(SELLER_PICKUP_COPY.startCamera)}</button>
            )}
            <button type="button" className="btn btn-ghost" data-testid="pickup-switch-type" onClick={() => { stopCamera(); setTab("type"); }}>{t(SELLER_PICKUP_COPY.tabType)}</button>
          </div>
          {!support.ok ? <p className="muted small" style={{ marginTop: 8 }}>{t(SCAN_OUTCOME_COPY[support.outcome || "unsupported"])}</p> : null}
        </div>
      ) : null}

      {tab === "type" ? (
        <form className="panel" data-testid="pickup-type-panel" onSubmit={submitTyped}>
          <label className="field">
            <span>{t(SELLER_PICKUP_COPY.typeLabel)}</span>
            <div className="pickup-input-wrap" dir="ltr">
              <span className="pickup-input-prefix">CT-</span>
              <input
                className="pickup-input"
                data-testid="pickup-code-input"
                inputMode="numeric"
                autoComplete="off"
                pattern="[0-9\-]*"
                placeholder="4839-2175"
                aria-label={t(SELLER_PICKUP_COPY.typeLabel)}
                value={typed}
                onChange={(e) => setTyped(formatPickupTyping(e.target.value).display)}
                autoFocus
              />
            </div>
          </label>
          <p className="muted small" style={{ marginTop: 4 }}>{t(SELLER_PICKUP_COPY.typeHint)}</p>
          <button type="submit" className="btn btn-primary btn-lg btn-block" data-testid="pickup-code-submit" disabled={resolving || !formatPickupTyping(typed).complete}>
            {resolving ? t("seller_pickup.verifying") : t(SELLER_PICKUP_COPY.typeSubmit)}
          </button>
        </form>
      ) : null}

      {tab === "search" ? (
        <div className="panel" data-testid="pickup-search-panel">
          <form onSubmit={submitSearch}>
            <label className="field">
              <span>{t(SELLER_PICKUP_COPY.searchLabel)}</span>
              <input data-testid="pickup-search-input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("seller_pickup.x_050_1234567_israel_israeli")} autoComplete="off" />
            </label>
            <button type="submit" className="btn btn-primary" data-testid="pickup-search-submit" disabled={searching || query.trim().length < 2}>{searching ? t("seller_pickup.searching") : t(SELLER_PICKUP_COPY.searchSubmit)}</button>
          </form>
          {results ? (
            results.length ? (
              <div className="stack" style={{ marginTop: 12 }} data-testid="pickup-search-results">
                {results.map((o) => (
                  <button key={o.participant_id} type="button" className={`order-row order-${verdictTone(String(o.verdict))}`} data-testid="pickup-search-hit" onClick={() => { setResults(null); setOrder({ ...o, __source: "search" }); }}>
                    <span className="order-row-main"><b>{o.buyer_name || "—"}</b> · {o.product_title}</span>
                    <span className="order-row-sub" dir="ltr">{o.buyer_phone_masked || ""} · {o.order_code || "—"}</span>
                    <span className="order-row-state">{verdictTone(String(o.verdict)) === "ready" ? t("seller_pickup.green_qty_units", { green: t(SELLER_PICKUP_COPY.green), qty: num(o.qty) }) : verdictTone(String(o.verdict)) === "already" ? t(SELLER_PICKUP_COPY.amber) : (o.not_ready_label || t(SELLER_PICKUP_COPY.red))}</span>
                  </button>
                ))}
              </div>
            ) : <p className="muted small" style={{ marginTop: 10 }} data-testid="pickup-search-empty">{t(SELLER_PICKUP_COPY.searchEmpty)}</p>
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
    catch (e: any) { setError(String(e?.message || t("seller_pickup.loading_failed"))); }
  };
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [dealId, status]);
  if (error) return <EmptyState title={t("seller_pickup.the_handover_list_cannot_shown")} body={error} action={<a className="btn btn-ghost" href={`#/seller/deal/${dealId}`}>{t("seller_pickup.to_deal")}</a>} />;
  if (!payload) return <BrandLoader label={t("seller_pickup.loading_orders_hand_over")} minHeight={360} />;
  const counts = payload.counts || {};
  const orders: Json[] = Array.isArray(payload.orders) ? payload.orders : [];
  return (
    <div className="pickup-page" data-testid="seller-fulfillment-page">
      <a className="back" href={`#/seller/deal/${dealId}`} onClick={(e) => { e.preventDefault(); navigate(`#/seller/deal/${dealId}`); }}>{t("seller_pickup.to_deal_2")}</a>
      <div className="row" style={{ alignItems: "baseline", gap: 10 }}>
        <h1 style={{ margin: 0 }}>{t("seller_pickup.orders_hand_over")}</h1>
        <span className="muted">{payload.deal?.title}</span>
      </div>
      <div className="stat-row fulfillment-stats">
        <div className="stat-tile"><div className="num" data-testid="fulfillment-awaiting">{num(counts.awaiting)}</div><div className="lbl">{t("seller_pickup.awaiting_handover_2")}</div></div>
        <div className="stat-tile good"><div className="num" data-testid="fulfillment-fulfilled">{num(counts.fulfilled)}</div><div className="lbl">{t("seller_pickup.handed_over_2")}</div></div>
        {Number(counts.blocked) > 0 ? <div className="stat-tile bad"><div className="num">{num(counts.blocked)}</div><div className="lbl">{t("seller_pickup.do_hand_over")}</div></div> : null}
      </div>
      <div className="row" style={{ gap: 8, marginTop: 12 }}>
        <button type="button" className="btn btn-primary" data-testid="fulfillment-scan" onClick={() => navigate("#/seller/pickup")}>{t("seller_pickup.pickup_scan")}</button>
        <a className="btn btn-ghost btn-sm" href={`/api/seller/deals/${dealId}/delivery-handoff/export.xlsx`} target="_blank" rel="noreferrer">{t("seller_pickup.download_logistics_excel")}</a>
      </div>
      <div className="pickup-tabs" role="tablist" aria-label={t("seller_pickup.filter")} style={{ marginTop: 12 }}>
        {([["pending", t("seller_pickup.awaiting_handover_2")], ["fulfilled", t("seller_pickup.handed_over_2")], ["all", t("seller_pickup.all")]] as const).map(([k, l]) => (
          <button key={k} type="button" role="tab" aria-selected={status === k} className={`pickup-tab${status === k ? " active" : ""}`} data-testid={`fulfillment-filter-${k}`} onClick={() => setStatus(k)}>{l}</button>
        ))}
      </div>
      <form className="row" style={{ gap: 8, marginTop: 8 }} onSubmit={(e) => { e.preventDefault(); void load(); }}>
        <input data-testid="fulfillment-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("seller_pickup.an_order_code_phone_number")} aria-label={t("seller_pickup.find_order")} style={{ flex: 1, minWidth: 0 }} />
        <button type="submit" className="btn btn-ghost btn-sm">{t("seller_pickup.search")}</button>
      </form>
      {done ? <HandoffDone result={done} onReset={() => { setDone(null); void load(); }} /> : null}
      {active ? <HandoffResultCard order={active} mockMoney={Boolean(payload.mock_money)} onConfirmed={(r) => { setActive(null); setDone(r); void load(); }} onReset={() => setActive(null)} /> : null}
      {!orders.length ? (
        <p className="muted" style={{ marginTop: 14 }} data-testid="fulfillment-empty">{status === "pending" ? t("seller_pickup.there_orders_awaiting_handover") : status === "fulfilled" ? t("seller_pickup.no_orders_been_handed_over") : t("seller_pickup.no_orders")}</p>
      ) : (
        <div className="stack" style={{ marginTop: 12 }} data-testid="fulfillment-list">
          {orders.map((o) => {
            const tone = verdictTone(String(o.verdict));
            return (
              <div key={o.participant_id} className={`order-card order-${tone}`} data-testid="fulfillment-row" data-state={tone}>
                <div className="order-card-head">
                  <span className="pickup-code-inline" dir="ltr">{o.order_code || "—"}</span>
                  <span className={`status ${tone === "ready" ? "PendingTarget" : tone === "already" ? "Completed" : "Failed"}`}>{tone === "ready" ? t("seller_pickup.awaiting_handover") : tone === "already" ? t("seller_pickup.handed_over") : (o.not_ready_label || t("seller_pickup.do_hand_over"))}</span>
                </div>
                <div className="order-card-main"><b>{o.buyer_name || "—"}</b> <span dir="ltr" className="muted">{o.buyer_phone || ""}</span></div>
                <div className="order-card-sub">
                  <span className="handoff-qty">{t("seller_pickup.qty_units_2", { qty: num(o.qty) })}</span> · {o.method_label}{o.method === "delivery" && o.delivery_city ? ` · ${o.delivery_city}` : ""} · {o.paid ? t("seller_pickup.paid") : o.payment_label}
                  {tone === "already" && o.fulfilled_at ? t("seller_pickup.handed_over_fulfilled_2", { fulfilled_at: formatIsraelDateTime(String(o.fulfilled_at)) }) : ""}
                </div>
                {tone === "ready" ? (
                  <button type="button" className="btn btn-primary btn-sm" data-testid="fulfillment-row-confirm" onClick={() => { setDone(null); setActive({ ...o, __source: "list" }); window.scrollTo({ top: 0 }); }}>
                    {t("seller_pickup.confirm_handover_qty_units", { qty: num(o.qty) })}</button>
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
