import React, { useEffect, useState } from "react";
import { Json } from "./api";
import { QrCode } from "./qrcode";
import { formatIsraelDateTime, num } from "./util";
import { PICKUP_SHOW_TO_SELLER_LINE, PICKUP_SCREENSHOT_LINE, PICKUP_DELIVERY_LINE } from "./buyerCopy";

// ── LAUNCH SPRINT 3 — buyer pickup credential card (tracking page) ──────────
// Everything shown derives from tracking.pickup (server-authoritative):
//   not ready → the honest state line, no code, no QR
//   ready + pickup → product, quantity, location, code, QR, full-screen mode
//   ready + delivery → order code as reference + address (no counter QR)
//   fulfilled → "ההזמנה נמסרה" + the recorded time
// The QR carries the locator only; the seller's server resolves the truth.

export function PickupCard({ pickup }: { pickup: Json | null | undefined }) {
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setFullscreen(false); };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", onKey); document.body.style.overflow = prev; };
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
        <div className="panel-title">📦 המוצר שלי</div>
        <div className="notice ok pickup-headline" style={{ marginTop: 0 }}>
          <b>✓ {pickup.headline || "ההזמנה נמסרה"}</b>
          {fulfilledAt ? <div className="small" style={{ marginTop: 4 }}>נמסר: {fulfilledAt}</div> : null}
        </div>
        <div className="kv">
          <span className="k">מוצר</span><span className="v">{pickup.product_title}</span>
          <span className="k">כמות</span><span className="v">{num(qty)} יחידות</span>
          {code ? <><span className="k">קוד הזמנה</span><span className="v pickup-code-inline" dir="ltr">{code}</span></> : null}
        </div>
        {pickup.disclosure ? <p className="muted small" style={{ margin: "10px 0 0" }}>{pickup.disclosure}</p> : null}
      </div>
    );
  }

  if (state !== "ready") {
    const tone = state === "deal_failed" || state === "deal_cancelled" || state === "unavailable" ? "err" : "info";
    return (
      <div className="panel pickup-card" data-testid="track-pickup" data-state={state}>
        <div className="panel-title">📦 קבלת המוצר</div>
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
        <div className="panel-title">📦 המשלוח שלי</div>
        <div className="notice ok" style={{ marginTop: 0 }}>
          <b>✓ {pickup.headline || "ההזמנה אושרה"}</b>
          <div className="small" style={{ marginTop: 4 }}>{PICKUP_DELIVERY_LINE}</div>
        </div>
        <div className="kv">
          <span className="k">מוצר</span><span className="v">{pickup.product_title}</span>
          <span className="k">כמות</span><span className="v">{num(qty)} יחידות</span>
          {pickup.delivery_address ? <><span className="k">כתובת למשלוח</span><span className="v">{pickup.delivery_address}{pickup.delivery_city ? `, ${pickup.delivery_city}` : ""}</span></> : null}
          {code ? <><span className="k">קוד הזמנה</span><span className="v pickup-code-inline" dir="ltr">{code}</span></> : null}
        </div>
        {pickup.disclosure ? <p className="muted small" style={{ margin: "10px 0 0" }}>{pickup.disclosure}</p> : null}
      </div>
    );
  }

  const location = pickup.pickup_location ? String(pickup.pickup_location) : "";
  return (
    <>
      <div className="panel pickup-card" data-testid="track-pickup" data-state="ready">
        <div className="panel-title">📦 איסוף המוצר</div>
        <div className="notice ok pickup-headline" style={{ marginTop: 0 }}>
          <b>✓ {pickup.headline || "מוכן לאיסוף"}</b>
        </div>
        <div className="pickup-facts">
          <div className="pickup-product">{pickup.product_title}</div>
          <div className="pickup-qty" data-testid="pickup-qty">{num(qty)} יחידות</div>
          {location ? (
            <div className="pickup-location">
              <span className="k">נקודת איסוף:</span> {location}
            </div>
          ) : null}
          {location && pickup.pickup_map_url ? (
            <a className="pickup-map-link" href={pickup.pickup_map_url} target="_blank" rel="noreferrer">📍 פתיחה במפה</a>
          ) : null}
        </div>
        <div className="pickup-cred">
          <div className="pickup-code-label">קוד איסוף</div>
          <div className="pickup-code" data-testid="pickup-code" dir="ltr">{code}</div>
          {pickup.qr_payload ? <QrCode value={String(pickup.qr_payload)} size={200} label={`קוד QR לאיסוף, קוד ${code}`} /> : null}
          <p className="pickup-instruction">{PICKUP_SHOW_TO_SELLER_LINE}</p>
          <button type="button" className="btn btn-primary btn-lg btn-block" data-testid="pickup-fullscreen-open" onClick={() => setFullscreen(true)}>
            הצגת קוד לאיסוף
          </button>
        </div>
        <div className="kv" style={{ marginTop: 12 }}>
          {pickup.buyer_name ? <><span className="k">על שם</span><span className="v">{pickup.buyer_name}</span></> : null}
          {pickup.phone_last4 ? <><span className="k">טלפון</span><span className="v" dir="ltr">•••{pickup.phone_last4}</span></> : null}
        </div>
        <p className="muted small" style={{ margin: "8px 0 0" }}>{PICKUP_SCREENSHOT_LINE}</p>
        {pickup.disclosure ? <p className="muted small" style={{ margin: "6px 0 0" }}>{pickup.disclosure}</p> : null}
      </div>

      {fullscreen ? (
        <div className="pickup-fullscreen" role="dialog" aria-modal="true" aria-label="קוד איסוף במסך מלא" data-testid="pickup-fullscreen">
          <div className="pickup-fullscreen-head">
            <span className="pickup-fullscreen-title">{pickup.product_title}</span>
            <button type="button" className="pickup-fullscreen-close" data-testid="pickup-fullscreen-close" aria-label="סגירה" onClick={() => setFullscreen(false)}>✕</button>
          </div>
          <div className="pickup-fullscreen-body">
            {pickup.qr_payload ? <QrCode value={String(pickup.qr_payload)} size={280} label={`קוד QR לאיסוף, קוד ${code}`} /> : null}
            <div className="pickup-code pickup-code-xl" dir="ltr" data-testid="pickup-fullscreen-code">{code}</div>
            <div className="pickup-fullscreen-qty">{num(qty)} יחידות</div>
            {location ? <div className="pickup-fullscreen-location">{location}</div> : null}
            {pickup.buyer_name ? <div className="pickup-fullscreen-name">{pickup.buyer_name}</div> : null}
            <p className="pickup-fullscreen-instruction">{PICKUP_SHOW_TO_SELLER_LINE}</p>
          </div>
          <button type="button" className="btn btn-ghost btn-block pickup-fullscreen-back" onClick={() => setFullscreen(false)}>חזרה למסך המעקב</button>
        </div>
      ) : null}
    </>
  );
}
