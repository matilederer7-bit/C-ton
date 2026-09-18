// Product-level feature flags for the C-ton web surface.
//
// PUBLIC_MALL_ENABLED — the public catalog ("המול") is fully implemented but
// HIDDEN from the current launch experience. While OFF:
//   * the root route renders the seller-first C-ton landing, never the Mall
//   * no Mall nav item is rendered and unknown routes fall back to the landing
//   * direct public deal links (#/deal/:id) keep working for buyers
// Turning it back ON (VITE_PUBLIC_MALL_ENABLED=true at build time) restores the
// original Mall root + nav without any architectural change.
export const PUBLIC_MALL_ENABLED =
  String((import.meta as any).env?.VITE_PUBLIC_MALL_ENABLED ?? "").trim().toLowerCase() === "true";

// Canonical brand assets (the owner-supplied C-ton logo and derived marks).
export const BRAND_NAME = "C-ton";
export const BRAND_LOGO_URL = `${(import.meta as any).env?.BASE_URL || "/"}brand/c-ton-logo-1024.jpg`;
export const BRAND_LOGO_FULL_URL = `${(import.meta as any).env?.BASE_URL || "/"}brand/c-ton-logo.png`;
// UI surfaces use the lightweight 180px rendition; the full 512px crop stays
// canonical for icons/large uses.
export const BRAND_MARK_URL = `${(import.meta as any).env?.BASE_URL || "/"}brand/c-ton-mark-180.png`;
