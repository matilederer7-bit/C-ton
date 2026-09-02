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
import { traceAuth } from "./authTrace";

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

// P0.4-1 — explicit password login must resolve a stale guest flag WITHOUT a
// reload (we are mid sign-in flow): otherwise the API client keeps stripping
// Authorization after a perfectly successful login, the first privileged call
// 401s, and the "click twice" ritual is born. View-as-guest for an already
// logged-in owner keeps using enterGuestMode/exitGuestMode above.
export function leaveGuestModeInPlace(): void {
  try {
    if (localStorage.getItem(GUEST_KEY) === "1") {
      localStorage.removeItem(GUEST_KEY);
      traceAuth("AUTH_GUEST_MODE_CLEARED", "stale guest flag removed by explicit login");
    }
  } catch { /* noop */ }
}

export type CapabilityAdoption =
  | { status: "ok"; caps: OwnerCaps }
  | { status: "unauthorized" } // the token itself was rejected — nothing to adopt
  | { status: "unavailable" }; // transient: capability service unreachable; session stays valid

// After a successful Supabase sign-in on any surface: ask the server which
// capabilities this identity holds and expose every legitimate experience for
// the ONE credential (same session; the server re-authorizes each route
// independently). Bounded retry with backoff — a flaky response must never
// silently demote the owner, and a VALID session is never discarded because
// discovery was temporarily down (P0.4-1: callers distinguish "unavailable"
// from "unauthorized" and retry DISCOVERY, never the password).
const ADOPT_BACKOFF_MS = [0, 700, 1400, 2500];

export async function adoptCapabilities(token: string): Promise<CapabilityAdoption> {
  for (let attempt = 0; attempt < ADOPT_BACKOFF_MS.length; attempt++) {
    if (ADOPT_BACKOFF_MS[attempt]) await new Promise((r) => setTimeout(r, ADOPT_BACKOFF_MS[attempt]));
    if (attempt > 0) traceAuth("AUTH_CAPABILITIES_RETRY", `attempt ${attempt + 1}`);
    try {
      traceAuth("AUTH_CAPABILITIES_REQUEST");
      const res = await fetch("/api/auth/capabilities", { headers: { authorization: `Bearer ${token}` } });
      if (res.status === 401) {
        traceAuth("AUTH_CAPABILITIES_UNAUTHORIZED");
        return { status: "unauthorized" };
      }
      if (!res.ok) throw new Error(`capabilities ${res.status}`);
      const body = await res.json();
      if (!body?.ok) throw new Error("capabilities not ok");
      const caps: OwnerCaps = { email: String(body.email || ""), seller: Boolean(body.seller), admin: Boolean(body.admin) };
      if (caps.seller) grantSurface("seller");
      if (caps.admin) { grantSurface("admin"); storeOwnerCaps(caps); }
      else { try { localStorage.removeItem(CAPS_KEY); } catch { /* noop */ } notifyCapsChanged(); }
      traceAuth("AUTH_CAPABILITIES_SUCCESS", `seller=${caps.seller} admin=${caps.admin}`);
      return { status: "ok", caps };
    } catch (e: any) {
      if (attempt === ADOPT_BACKOFF_MS.length - 1) {
        traceAuth("AUTH_CAPABILITIES_UNAVAILABLE", String(e?.message || e).slice(0, 80));
        return { status: "unavailable" };
      }
    }
  }
  return { status: "unavailable" };
}
