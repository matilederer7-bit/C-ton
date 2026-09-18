// ── Admin step-up gate (P0.5-1) ─────────────────────────────────────────────
// A PRESENTATION/SESSION security layer on top of (never instead of) the
// canonical server authorization: entering the Admin surface in this browser
// session requires a fresh password re-authentication through Supabase, even
// when a valid session already exists.
//
// The unlock state is a bounded NON-SECRET marker (an expiry timestamp in
// sessionStorage). It contains no password, no token, nothing grantable —
// forging it only changes which UI renders; every admin route still validates
// the real Supabase token + capability bindings server-side.

const UNLOCK_KEY = "siton_admin_unlock_v1";
const UNLOCK_MINUTES = 30;

export function isAdminUnlocked(): boolean {
  try {
    const raw = sessionStorage.getItem(UNLOCK_KEY);
    if (!raw) return false;
    const until = Number(JSON.parse(raw)?.until || 0);
    return Number.isFinite(until) && Date.now() < until;
  } catch { return false; }
}

export function markAdminUnlocked(): void {
  try {
    sessionStorage.setItem(UNLOCK_KEY, JSON.stringify({ until: Date.now() + UNLOCK_MINUTES * 60_000 }));
  } catch { /* noop */ }
}

export function lockAdmin(): void {
  try { sessionStorage.removeItem(UNLOCK_KEY); } catch { /* noop */ }
}
