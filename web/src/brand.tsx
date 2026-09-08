import React, { useEffect, useState } from "react";
import { BRAND_MARK_URL, BRAND_NAME } from "./config";

// ── C-ton brand primitives ──────────────────────────────────────────────────
// The owner-supplied logo asset is the single source of visual identity.
// BrandMark renders the square C+bar emblem; BrandWordmark renders the name in
// live text (styled to match the logo: gray "ton", orange "C-"), so the topbar
// stays crisp at any size while the emblem stays the real asset.

export function BrandMark({ size = 38 }: { size?: number }) {
  return (
    <img
      className="brand-mark-img"
      src={BRAND_MARK_URL}
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      draggable={false}
    />
  );
}

// The topbar shows the ACTUAL approved wordmark pixels (cropped + keyed from
// web/public/brand/c-ton-logo.png) — never a text reconstruction of it.
const BRAND_WORDMARK_URL = `${(import.meta as any).env?.BASE_URL || "/"}brand/c-ton-wordmark.png`;

export function BrandWordmark() {
  return (
    <img
      className="brand-word-img"
      src={BRAND_WORDMARK_URL}
      alt={BRAND_NAME}
      draggable={false}
    />
  );
}

// ── branded loading state ───────────────────────────────────────────────────
// Reusable C-ton loading surface: the real brand emblem breathing on the dark
// ground. Reduced-motion users get a static mark. minHeight prevents layout
// jump when the loaded content replaces the loader.
// LAUNCH POLISH (P8) — a wait that outlives SLOW_HINT_MS gets ONE honest extra
// line (the hosted runtime can take up to ~30 s to wake after idle). It never
// claims progress it cannot see and never fakes success.
const SLOW_HINT_MS = 6000;
export function BrandLoader({ label, minHeight = 320 }: { label?: string; minHeight?: number }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setSlow(true), SLOW_HINT_MS);
    return () => clearTimeout(id);
  }, []);
  return (
    <div className="brand-loader" role="status" aria-live="polite" style={{ minHeight }} data-testid="brand-loader" data-slow={slow ? "1" : "0"}>
      <img className="brand-loader-mark" src={BRAND_MARK_URL} alt="" aria-hidden="true" width={72} height={72} draggable={false} />
      <div className="brand-loader-bar" aria-hidden="true" />
      <p className="brand-loader-label">{label || "טוענים…"}</p>
      {slow ? (
        <p className="brand-loader-slow" data-testid="brand-loader-slow">
          עדיין טוענים — השרת מתעורר. בפעם הראשונה זה יכול לקחת עד חצי דקה; אין צורך לרענן.
        </p>
      ) : null}
    </div>
  );
}
