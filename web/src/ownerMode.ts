// ── Owner three-mode experience (guest / seller / admin) ────────────────────
// ONE canonical Supabase identity may hold several capabilities; the SERVER is
// the only authority on every privileged route. These helpers merely choose
// which legitimate experience the UI exposes:
//  * the mode switcher renders only for accounts whose ADMIN capability the
//    server confirmed (/api/auth/capabilities)
//  * guest mode strictly REMOVES privileges: while the flag is set every token
//    getter returns "" and the API client refuses to attach auth, so no
//    privileged request can be sent; the underlying session stays stored and
//    returns intact when guest mode ends
// Mode selection can never upgrade authority — a forged localStorage flag only
// changes what the UI shows; every privileged request is still authorized
// server-side against the canonical capability bindings.
import { grantSurface } from "./session";

const CAPS_KEY = "siton_owner_caps_v1";
const GUEST_KEY = "siton_guest_mode_v1";

export interface OwnerCaps { email: string; seller: boolean; admin: boolean }

// UI refresh signal: the topbar switcher listens for this so it appears the
// moment capabilities are adopted (login happens deeper in the tree).
export const OWNER_CAPS_EVENT = "siton-owner-caps";
function notifyCapsChanged(): void {
  try { window.dispatchEvent(new Event(OWNER_CAPS_EVENT)); } catch { /* noop */ }
}

export function storeOwnerCaps(caps: OwnerCaps): void {
  try { localStorage.setItem(CAPS_KEY, JSON.stringify(caps)); } catch { /* noop */ }
  notifyCapsChanged();
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
    localStorage.removeItem("siton_guest_stash_v1"); // legacy stash key
  } catch { /* noop */ }
  notifyCapsChanged();
}

export function isGuestMode(): boolean {
  try { return localStorage.getItem(GUEST_KEY) === "1"; } catch { return false; }
}

// View-as-guest: mark guest mode and reload into the public root so no
// privileged state stays mounted. Only removes privileges — grants nothing.
export function enterGuestMode(): void {
  try { localStorage.setItem(GUEST_KEY, "1"); } catch { /* noop */ }
  window.location.hash = "#/";
  window.location.reload();
}

// "חזרה לחשבון שלי" — leave guest mode; the stored session simply becomes
// readable again (it was never attachable while the flag was set).
export function exitGuestMode(): void {
  try { localStorage.removeItem(GUEST_KEY); } catch { /* noop */ }
  window.location.hash = "#/";
  window.location.reload();
}

// After a successful Supabase sign-in on any surface: ask the server which
// capabilities this identity holds and expose every legitimate experience for
// the ONE credential (same session; the server re-authorizes each route
// independently). One transient retry — a flaky network response must never
// silently demote the owner.
export async function adoptCapabilities(token: string): Promise<OwnerCaps | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch("/api/auth/capabilities", { headers: { authorization: `Bearer ${token}` } });
      if (res.status === 401) return null; // token invalid — nothing to adopt
      if (!res.ok) throw new Error(`capabilities ${res.status}`);
      const body = await res.json();
      if (!body?.ok) throw new Error("capabilities not ok");
      const caps: OwnerCaps = { email: String(body.email || ""), seller: Boolean(body.seller), admin: Boolean(body.admin) };
      if (caps.seller) grantSurface("seller");
      if (caps.admin) { grantSurface("admin"); storeOwnerCaps(caps); }
      else { try { localStorage.removeItem(CAPS_KEY); } catch { /* noop */ } notifyCapsChanged(); }
      return caps;
    } catch {
      if (attempt === 0) { await new Promise((r) => setTimeout(r, 800)); continue; }
      return null;
    }
  }
  return null;
}
