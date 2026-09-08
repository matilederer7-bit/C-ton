import React, { useMemo } from "react";
import qrcode from "qrcode-generator";

// ── LAUNCH SPRINT 3 — QR renderer (inline SVG, scalable, screenshot-friendly)
// The value is the pickup locator URL only (no PII; see docs §4). Rendered on
// a white plate because a dark-ground QR scans unreliably. The value is also
// exposed as data-qr-value + a textual fallback for screen readers / proofs.
export function QrCode({ value, size = 220, label }: { value: string; size?: number; label: string }) {
  const svg = useMemo(() => {
    try {
      const qr = qrcode(0, "M");
      qr.addData(value);
      qr.make();
      return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
    } catch {
      return "";
    }
  }, [value]);
  if (!svg) return <div className="qr-plate qr-plate-empty" style={{ width: size, height: size }} aria-hidden="true" />;
  return (
    <div
      className="qr-plate"
      role="img"
      aria-label={label}
      data-testid="pickup-qr"
      data-qr-value={value}
      style={{ width: size, height: size }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
