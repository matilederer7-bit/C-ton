import React, { useEffect, useState } from "react";
import { BRAND_MARK_URL, BRAND_NAME } from "./config";
import { t } from "./i18n/index.js";

// ── C-ton brand primitives ──────────────────────────────────────────────────
// The C-ton logo is drawn as vectors in assets/brand/ (2026-09-25 "Graphite
// Mint": a white C on a graphite tile, the short mint dash in its opening —
// never a dot — with a soft mint glow) and rendered to the raster files under
// web/public/brand/ by scripts/render_brand_assets.cjs. BrandMark renders the
// square C+dash emblem; BrandWordmark renders the approved wordmark image.

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

// The topbar shows the approved wordmark image (rendered from
// assets/brand/c-ton-wordmark.svg) — never a text reconstruction of it.
const BRAND_WORDMARK_URL = `${(import.meta as any).env?.BASE_URL || "/"}brand/c-ton-wordmark.png`;

// The wordmark carries its RENDERED size as attributes (the 540x140 source
// at the CSS height of 22px). Without them the image lays out at its
// intrinsic 540px until the stylesheet applies, which overflows a 390px
// phone viewport and makes the browser zoom the whole page out.
export function BrandWordmark() {
  return (
    <img
      className="brand-word-img"
      src={BRAND_WORDMARK_URL}
      alt={BRAND_NAME}
      width={85}
      height={22}
      draggable={false}
    />
  );
}

// ── branded loading state ───────────────────────────────────────────────────
// Reusable C-ton loading surface: the real brand emblem breathing on the
// paper ground. Reduced-motion users get a static mark. minHeight prevents layout
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
      <p className="brand-loader-label">{label || t("brand.loading")}</p>
      {slow ? (
        <p className="brand-loader-slow" data-testid="brand-loader-slow">
          {t("brand.still_loading_server_waking_up")}</p>
      ) : null}
    </div>
  );
}
