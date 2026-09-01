// ── Owner three-mode experience (guest / seller / admin) ────────────────────
// ONE canonical Supabase identity may hold several capabilities; the SERVER is
// the only authority on every privileged route. These helpers merely choose
// which legitimate experience the UI exposes:
//  * the mode switcher renders only for accounts whose ADMIN capability the
//    server confirmed (/api/auth/capabilities)
//  * guest mode strictly REMOVES privileges: both surface tokens are stashed
//    out of the active keys, so no request can attach them, and the API client
//    additionally refuses to attach auth while the guest flag is set
// Mode selection can never upgrade authority — a forged localStorage flag only
// changes what the UI shows; every privileged request is still authorized
// server-side against the canonical capability bindings.
import { getAdminToken, getSellerToken, setAdminToken, setSellerToken } from "./api";

const CAPS_KEY = "siton_owner_caps_v1";
const GUEST_KEY = "siton_guest_mode_v1";
const STASH_KEY = "siton_guest_stash_v1";

export interface OwnerCaps { email: string; seller: boolean; admin: boolean }

export function storeOwnerCaps(caps: OwnerCaps): void {
  try { localStorage.setItem(CAPS_KEY, JSON.stringify(caps)); } catch { /* noop */ }
}

export function readOwnerCaps(): OwnerCaps | null {
  try {
    const raw = localStorage.getItem(CAPS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.email !== "string") return null;
    return { email: parsed.email, seller: Boolean(parsed.seller), admin: Boolean(parsed.admin) };
  } catch { return null; }
}

export function clearOwnerSession(): void {
  try {
    localStorage.removeItem(CAPS_KEY);
    localStorage.removeItem(GUEST_KEY);
    localStorage.removeItem(STASH_KEY);
  } catch { /* noop */ }
}

export function isGuestMode(): boolean {
  try { return localStorage.getItem(GUEST_KEY) === "1"; } catch { return false; }
}

// View-as-guest: stash the privileged tokens OUT of the active keys and mark
// guest mode, then reload into the public root so no privileged state stays
// mounted. Only removes privileges — grants nothing.
export function enterGuestMode(): void {
  try {
    localStorage.setItem(STASH_KEY, JSON.stringify({ seller: getSellerToken(), admin: getAdminToken() }));
    localStorage.setItem(GUEST_KEY, "1");
  } catch { /* noop */ }
  setSellerToken("");
  setAdminToken("");
  window.location.hash = "#/";
  window.location.reload();
}

// "חזרה לחשבון שלי" — restore the stashed tokens and leave guest mode.
export function exitGuestMode(): void {
  try {
    const raw = localStorage.getItem(STASH_KEY);
    const stash = raw ? JSON.parse(raw) : {};
    if (stash?.seller) setSellerToken(String(stash.seller));
    if (stash?.admin) setAdminToken(String(stash.admin));
    localStorage.removeItem(STASH_KEY);
    localStorage.removeItem(GUEST_KEY);
  } catch { /* noop */ }
  window.location.hash = "#/";
  window.location.reload();
}

// After a successful Supabase sign-in on any surface: ask the server which
// capabilities this identity holds and expose every legitimate experience for
// the ONE credential (same token, per-surface keys; the server re-authorizes
// each route independently).
export async function adoptCapabilities(token: string): Promise<OwnerCaps | null> {
  try {
    const res = await fetch("/api/auth/capabilities", { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) return null;
    const body = await res.json();
    if (!body?.ok) return null;
    const caps: OwnerCaps = { email: String(body.email || ""), seller: Boolean(body.seller), admin: Boolean(body.admin) };
    if (caps.seller) setSellerToken(token);
    if (caps.admin) setAdminToken(token);
    if (caps.admin) storeOwnerCaps(caps); else clearOwnerSession();
    return caps;
  } catch { return null; }
}
