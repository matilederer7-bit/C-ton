// ── HTTP response security headers and cache policy ──────────────────────────
// Moved verbatim out of src/app.ts (Lean Refactor, 2026-10-02): the headers set
// on every response, the immutable deal-image carve-out and the no-store route
// classifier. The onRequest hook that applies them stays in src/app.ts.
import { isProductionLikeEnv } from "./runtime_config.js";

export function applySecurityHeaders(reply: any) {
  reply.header("x-content-type-options", "nosniff");
  reply.header("referrer-policy", "no-referrer");
  reply.header("x-frame-options", "DENY");
  // P0.6-2 ROOT CAUSE: geolocation=() DISABLED the API for the page itself,
  // so "השתמש במיקום שלי" always failed instantly with PERMISSION_DENIED and
  // no browser prompt. geolocation=(self) lets OUR page ask the user (the
  // browser prompt/deny still fully applies); every other capability stays off.
  // LAUNCH SPRINT 3: camera=(self) for the seller pickup scanner — requested
  // only on an explicit tap inside our own page, manual code entry always
  // available (docs/PHYSICAL_FULFILLMENT_PICKUP.md §6). Microphone/payment/
  // usb/serial stay off.
  reply.header("permissions-policy", "camera=(self), microphone=(), geolocation=(self), payment=(), usb=(), serial=()");
  // Red-team hardening (A6): enforce HTTPS on production hostnames so a
  // downgrade/SSL-strip cannot expose session cookies or payment traffic. Only
  // emitted in production-like runtimes (never on plain-HTTP local dev).
  if (isProductionLikeEnv()) {
    reply.header("strict-transport-security", "max-age=31536000; includeSubDomains");
  }
}

export function isImmutableDealImageRoute(req: any) {
  return req.method === "GET" && /^\/api\/deal-images\/[^/?#]+(?:[?#].*)?$/.test(String(req.url || ""));
}

export function isDynamicNoStoreRoute(url: string) {
  const path = url.split("?")[0] || "/";
  return (
    path.startsWith("/api/") ||
    path.startsWith("/webhooks/") ||
    path === "/health" ||
    path === "/health/integrations" ||
    // GAP-HTTP-1 - /readiness is the Render health-check path and a live
    // verdict about THIS instance. Cached by any intermediary it becomes a
    // stale verdict, which is exactly the answer a readiness probe must never
    // give: a failing instance keeps receiving traffic, or a recovered one
    // keeps being drained.
    path === "/readiness" ||
    path.startsWith("/deals") ||
    path.startsWith("/participants") ||
    path.startsWith("/admin") ||
    path.startsWith("/seller") ||
    path.startsWith("/buyer") ||
    path.startsWith("/tracking") ||
    path.startsWith("/payments") ||
    path.startsWith("/invoices") ||
    path.startsWith("/payouts") ||
    path.startsWith("/notifications")
  );
}
