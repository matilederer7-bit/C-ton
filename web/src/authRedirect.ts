// ── GoTrue redirect capture (P0.3-11) ───────────────────────────────────────
// Supabase auth emails (password recovery, signup confirmation) redirect the
// browser to the canonical preview with an implicit-flow FRAGMENT:
//   #access_token=...&refresh_token=...&expires_in=...&type=recovery|signup
// Our router also lives in the hash, so this runs FIRST at boot: it lifts the
// GoTrue fragment out of the URL, then routes to the right product screen.
// No password is involved — only the short-lived tokens GoTrue itself minted.
import { beginSession } from "./session";
import { adoptCapabilities } from "./ownerMode";

export const RECOVERY_SESSION_KEY = "siton_recovery_session_v1";
export const AUTH_REDIRECT_ERROR_KEY = "siton_auth_redirect_error_v1";

export function captureAuthRedirect(): void {
  let raw = "";
  try { raw = window.location.hash.replace(/^#\/?/, ""); } catch { return; }
  if (!raw.includes("access_token=") && !raw.includes("error_description=")) return;
  const params = new URLSearchParams(raw);
  const errDesc = params.get("error_description") || "";
  if (errDesc && !params.get("access_token")) {
    try { sessionStorage.setItem(AUTH_REDIRECT_ERROR_KEY, errDesc); } catch { /* noop */ }
    window.location.hash = "#/";
    return;
  }
  const access = params.get("access_token") || "";
  if (!access) return;
  const payload = {
    access_token: access,
    refresh_token: params.get("refresh_token") || "",
    expires_in: Number(params.get("expires_in") || 3600)
  };
  const type = params.get("type") || "";
  if (type === "recovery") {
    // recovery: do NOT silently adopt — route to the password-reset screen
    try { sessionStorage.setItem(RECOVERY_SESSION_KEY, JSON.stringify(payload)); } catch { /* noop */ }
    window.location.hash = "#/reset-password";
    return;
  }
  // signup / magiclink / email-change confirmation: this IS a fresh session —
  // adopt it and land in the seller area.
  beginSession(payload, "seller");
  void adoptCapabilities(access);
  window.location.hash = "#/seller";
}

export function readRecoverySession(): { access_token: string; refresh_token: string; expires_in: number } | null {
  try {
    const raw = sessionStorage.getItem(RECOVERY_SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.access_token) return null;
    return parsed;
  } catch { return null; }
}

export function clearRecoverySession(): void {
  try { sessionStorage.removeItem(RECOVERY_SESSION_KEY); } catch { /* noop */ }
}
