import React, { useEffect, useRef, useState } from "react";
// Sprint 4 A1 — the ONE pickup navigation renderer (Google Maps + Waze)
import { PickupNavActions } from "./pages/deal";
import { containDialogFocus } from "./dialogFocus";
import { Json } from "./api";
import { QrCode } from "./qrcode";
import { formatIsraelDateTime, num } from "./util";
import { PICKUP_SHOW_TO_SELLER_LINE_KEY, PICKUP_SCREENSHOT_LINE_KEY, PICKUP_DELIVERY_LINE_KEY } from "./buyerCopy";
import { t } from "./i18n";

// ── LAUNCH SPRINT 3 — buyer pickup credential card (tracking page) ──────────
// Everything shown derives from tracking.pickup (server-authoritative):
//   not ready → the honest state line, no code, no QR
//   ready + pickup → product, quantity, location, code, QR, full-screen mode
//   ready + delivery → order code as reference + address (no counter QR)
//   fulfilled → "ההזמנה נמסרה" + the recorded time
// The QR carries the locator only; the seller's server resolves the truth.

export function PickupCard({ pickup }: { pickup: Json | null | undefined }) {
  const [fullscreen, setFullscreen] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setFullscreen(false); };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const releaseFocus = dialog.current ? containDialogFocus(dialog.current) : undefined;
    return () => { releaseFocus?.(); document.removeEventListener("keydown", onKey); document.body.style.overflow = prev; };
  }, [fullscreen]);

  if (!pickup || !pickup.applicable) return null;
  const state = String(pickup.state || "");
  const method = String(pickup.method || "unknown");
  const qty = Number(pickup.qty || 0);
  const code = pickup.order_code ? String(pickup.order_code) : "";
  const fulfilledAt = pickup.fulfilled_at ? formatIsraelDateTime(String(pickup.fulfilled_at)) : "";

  if (state === "fulfilled") {
    return (
      <div className="panel pickup-card" data-testid="track-pickup" data-state="fulfilled">
        <div className="panel-title">{t("pickup_card.my_product")}</div>
        <div className="notice ok pickup-headline" style={{ marginTop: 0 }}>
          <b>✓ {pickup.headline || t("pickup_card.the_order_handed_over")}</b>
          {fulfilledAt ? <div className="small" style={{ marginTop: 4 }}>{t("pickup_card.handed_over_fulfilledat", { fulfilledAt: fulfilledAt })}</div> : null}
        </div>
        <div className="kv">
          <span className="k">{t("pickup_card.product")}</span><span className="v">{pickup.product_title}</span>
          <span className="k">{t("pickup_card.quantity")}</span><span className="v">{t("pickup_card.qty_units", { qty: num(qty) })}</span>
          {code ? <><span className="k">{t("pickup_card.order_code")}</span><span className="v pickup-code-inline" dir="ltr">{code}</span></> : null}
        </div>
        {pickup.disclosure ? <p className="muted small" style={{ margin: "10px 0 0" }}>{pickup.disclosure}</p> : null}
      </div>
    );
  }

  if (state !== "ready") {
    const tone = state === "deal_failed" || state === "deal_cancelled" || state === "unavailable" ? "err" : "info";
    return (
      <div className="panel pickup-card" data-testid="track-pickup" data-state={state}>
        <div className="panel-title">{t("pickup_card.receiving_product")}</div>
        <div className={`notice ${tone}`} style={{ marginTop: 0 }}>
          <b>{pickup.headline}</b>
          {pickup.subline ? <div className="small" style={{ marginTop: 4 }}>{pickup.subline}</div> : null}
        </div>
      </div>
    );
  }

  if (method === "delivery") {
    return (
      <div className="panel pickup-card" data-testid="track-pickup" data-state="ready-delivery">
        <div className="panel-title">{t("pickup_card.my_delivery")}</div>
        <div className="notice ok" style={{ marginTop: 0 }}>
          <b>✓ {pickup.headline || t("pickup_card.the_order_confirmed")}</b>
          <div className="small" style={{ marginTop: 4 }}>{t(PICKUP_DELIVERY_LINE_KEY)}</div>
        </div>
        <div className="kv">
          <span className="k">{t("pickup_card.product")}</span><span className="v">{pickup.product_title}</span>
          <span className="k">{t("pickup_card.quantity")}</span><span className="v">{t("pickup_card.qty_units", { qty: num(qty) })}</span>
          {pickup.delivery_address ? <><span className="k">{t("pickup_card.delivery_address")}</span><span className="v">{pickup.delivery_address}{pickup.delivery_city ? `, ${pickup.delivery_city}` : ""}</span></> : null}
          {code ? <><span className="k">{t("pickup_card.order_code")}</span><span className="v pickup-code-inline" dir="ltr">{code}</span></> : null}
        </div>
        {pickup.disclosure ? <p className="muted small" style={{ margin: "10px 0 0" }}>{pickup.disclosure}</p> : null}
      </div>
    );
  }

  const location = pickup.pickup_location ? String(pickup.pickup_location) : "";
  return (
    <>
      <div className="panel pickup-card" data-testid="track-pickup" data-state="ready">
        <div className="panel-title">{t("pickup_card.collecting_product")}</div>
        <div className="notice ok pickup-headline" style={{ marginTop: 0 }}>
          <b>✓ {pickup.headline || t("pickup_card.ready_pickup")}</b>
        </div>
        <div className="pickup-facts">
          <div className="pickup-product">{pickup.product_title}</div>
          <div className="pickup-qty" data-testid="pickup-qty">{t("pickup_card.qty_units", { qty: num(qty) })}</div>
          {location ? (
            <div className="pickup-location">
              <span className="k">{t("pickup_card.pickup_point")}</span> {location}
            </div>
          ) : null}
          {location && pickup.pickup_navigation ? (
            <PickupNavActions navigation={pickup.pickup_navigation} testIdPrefix="track-pickup-nav" />
          ) : location && pickup.pickup_map_url ? (
            <a className="pickup-map-link" href={pickup.pickup_map_url} target="_blank" rel="noreferrer">{t("pickup_card.open_map")}</a>
          ) : null}
        </div>
        <div className="pickup-cred">
          <div className="pickup-code-label">{t("pickup_card.pickup_code")}</div>
          <div className="pickup-code" data-testid="pickup-code" dir="ltr">{code}</div>
          {pickup.qr_payload ? <QrCode value={String(pickup.qr_payload)} size={200} label={t("pickup_card.pickup_qr_code_code_code", { code: code })} /> : null}
          <p className="pickup-instruction">{t(PICKUP_SHOW_TO_SELLER_LINE_KEY)}</p>
          <button type="button" className="btn btn-primary btn-lg btn-block" data-testid="pickup-fullscreen-open" onClick={() => setFullscreen(true)}>
            {t("pickup_card.show_pickup_code")}</button>
        </div>
        <div className="kv" style={{ marginTop: 12 }}>
          {pickup.buyer_name ? <><span className="k">{t("pickup_card.in_name")}</span><span className="v">{pickup.buyer_name}</span></> : null}
          {pickup.phone_last4 ? <><span className="k">{t("pickup_card.phone")}</span><span className="v" dir="ltr">•••{pickup.phone_last4}</span></> : null}
        </div>
        <p className="muted small" style={{ margin: "8px 0 0" }}>{t(PICKUP_SCREENSHOT_LINE_KEY)}</p>
        {pickup.disclosure ? <p className="muted small" style={{ margin: "6px 0 0" }}>{pickup.disclosure}</p> : null}
      </div>

      {fullscreen ? (
        <div className="pickup-fullscreen" ref={dialog} role="dialog" aria-modal="true" aria-label={t("pickup_card.pickup_code_full_screen")} data-testid="pickup-fullscreen">
          <div className="pickup-fullscreen-head">
            <span className="pickup-fullscreen-title">{pickup.product_title}</span>
            <button type="button" className="pickup-fullscreen-close" data-testid="pickup-fullscreen-close" aria-label={t("pickup_card.close")} onClick={() => setFullscreen(false)}>✕</button>
          </div>
          <div className="pickup-fullscreen-body">
            {pickup.qr_payload ? <QrCode value={String(pickup.qr_payload)} size={280} label={t("pickup_card.pickup_qr_code_code_code", { code: code })} /> : null}
            <div className="pickup-code pickup-code-xl" dir="ltr" data-testid="pickup-fullscreen-code">{code}</div>
            <div className="pickup-fullscreen-qty">{t("pickup_card.qty_units", { qty: num(qty) })}</div>
            {location ? <div className="pickup-fullscreen-location">{location}</div> : null}
            {pickup.buyer_name ? <div className="pickup-fullscreen-name">{pickup.buyer_name}</div> : null}
            <p className="pickup-fullscreen-instruction">{t(PICKUP_SHOW_TO_SELLER_LINE_KEY)}</p>
          </div>
          <button type="button" className="btn btn-ghost btn-block pickup-fullscreen-back" onClick={() => setFullscreen(false)}>{t("pickup_card.back_tracking_screen")}</button>
        </div>
      ) : null}
    </>
  );
}
