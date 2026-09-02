import React, { useEffect, useState } from "react";
import { Mall } from "./pages/mall";
import { Landing } from "./pages/landing";
import { DealPage } from "./pages/deal";
import { TrackPage } from "./pages/track";
import { SellerArea } from "./pages/seller";
import { AdminArea } from "./pages/admin";
import { SupportPage } from "./pages/support";
import { ResetPasswordPage } from "./pages/reset";
import { getPreviewMeta } from "./previewMeta";
import { captureAuthRedirect } from "./authRedirect";

// Supabase auth-email redirects (recovery/confirmation) land in the hash —
// capture them BEFORE any routing or ref-capture touches the URL.
captureAuthRedirect();
import { captureRefFromLocation } from "./viral";
import { BrandMark, BrandWordmark } from "./brand";
import { PUBLIC_MALL_ENABLED } from "./config";
import { OWNER_CAPS_EVENT, enterGuestMode, exitGuestMode, isGuestMode, readOwnerCaps } from "./ownerMode";
import { startSessionHeartbeat } from "./session";
import { isAdminUnlocked } from "./adminGate";
import { AdminStepUp } from "./adminStepUp";

// Capture ?ref= share codes once, at boot, before any routing.
captureRefFromLocation();
// Keep the Supabase session silently fresh (refresh-token grant) so a login
// stays usable across reloads and days on the same device.
startSessionHeartbeat();

// PUBLIC_MALL_ENABLED — the canonical value is a runtime server env exposed at
// /api/preview/meta (repository convention: env switches, no flag service).
// The build-time VITE value acts only as a static default; the server value
// wins as soon as it arrives. Default is OFF: seller-first root, no Mall.
let mallFlagCache: boolean | null = null;
function useMallEnabled(): boolean {
  const [enabled, setEnabled] = useState<boolean>(mallFlagCache ?? PUBLIC_MALL_ENABLED);
  useEffect(() => {
    if (mallFlagCache !== null) return;
    let alive = true;
    getPreviewMeta()
      .then((meta) => {
        mallFlagCache = Boolean(meta?.public_mall_enabled);
        if (alive) setEnabled(mallFlagCache);
      })
      .catch(() => { mallFlagCache = PUBLIC_MALL_ENABLED; });
    return () => { alive = false; };
  }, []);
  return enabled;
}

interface Route { page: string; seg: string[]; query: URLSearchParams }

function parseHash(): Route {
  const raw = window.location.hash.replace(/^#\/?/, "");
  const [path, queryStr] = raw.split("?");
  const seg = (path || "").split("/").filter(Boolean);
  return { page: seg[0] || "", seg, query: new URLSearchParams(queryStr || "") };
}

function useRoute(): [Route, (hash: string) => void] {
  const [route, setRoute] = useState<Route>(parseHash);
  useEffect(() => {
    const onChange = () => { setRoute(parseHash()); window.scrollTo(0, 0); };
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  const navigate = (hash: string) => { window.location.hash = hash; };
  return [route, navigate];
}

// Owner mode switcher — rendered ONLY when the server confirmed this session's
// ADMIN capability (stored after login). Choosing a mode never grants
// authority: seller/admin routes re-authorize server-side, and guest mode
// strictly strips the privileged tokens from every request.
function OwnerModeSwitch({ page, navigate }: { page: string; navigate: (h: string) => void }) {
  // re-render when capabilities are adopted/cleared (login happens deeper in
  // the tree; the topbar must reflect it immediately)
  const [, bump] = useState(0);
  useEffect(() => {
    const onChange = () => bump((n) => n + 1);
    window.addEventListener(OWNER_CAPS_EVENT, onChange);
    return () => window.removeEventListener(OWNER_CAPS_EVENT, onChange);
  }, []);
  if (isGuestMode()) {
    return (
      <button className="owner-exit" data-testid="owner-exit-guest" onClick={exitGuestMode}>
        חזרה לחשבון שלי
      </button>
    );
  }
  const caps = readOwnerCaps();
  if (!caps?.admin) return null;
  const mode = page === "seller" ? "seller" : "";
  // P0.5-1: the Admin surface is NEVER advertised — no "מנהל" button anywhere.
  // Admin is entered only through the hidden two-tap edge gate + password
  // step-up. The visible modes stay אורח / מוכר.
  return (
    <div className="owner-switch" role="group" aria-label="מצב תצוגה" data-testid="owner-switch">
      <span className="owner-switch-label">הצג כ:</span>
      <button data-testid="owner-mode-guest" onClick={enterGuestMode}>אורח</button>
      <button data-testid="owner-mode-seller" className={mode === "seller" ? "active" : ""} onClick={() => navigate("#/seller")}>מוכר</button>
    </div>
  );
}

// P0.5-1 — the deliberate hidden Admin gate. ONE unmarked edge hotspot;
// a single tap does NOTHING; a second deliberate tap within the arm window
// opens the Admin password step-up. Explicit tap state (never native
// dblclick — mobile is inconsistent). Visual obscurity is presentation only:
// entry still requires the password step-up + server-confirmed capability.
const ADMIN_ARM_WINDOW_MS = 2500;
function AdminHotspot({ onActivate }: { onActivate: () => void }) {
  const armedAt = React.useRef(0);
  const handleTap = () => {
    const now = Date.now();
    if (now - armedAt.current <= ADMIN_ARM_WINDOW_MS && armedAt.current > 0) {
      armedAt.current = 0;
      onActivate();
      return;
    }
    armedAt.current = now; // first tap only ARMS; it must never open anything
  };
  return (
    <div
      className="admin-dot top"
      data-testid="admin-hotspot"
      aria-hidden="true"
      onClick={handleTap}
    />
  );
}

export default function App() {
  const [route, navigate] = useRoute();
  const mallEnabled = useMallEnabled();
  const page = route.page;
  const isAdmin = page === "admin";
  // P0.5-1 — presentation gate for the Admin surface: a direct #/admin URL
  // never bypasses the password step-up. (Every admin API route still
  // authorizes server-side regardless of this flag.)
  const [adminUnlocked, setAdminUnlocked] = useState(() => isAdminUnlocked());
  useEffect(() => { if (isAdmin) setAdminUnlocked(isAdminUnlocked()); }, [isAdmin, route]);

  // When the Mall is hidden, the root and every unknown route land on the
  // seller-first C-ton landing. Direct deal/track links always work.
  const Home = mallEnabled ? Mall : Landing;

  return (
    <div className="app">
      <AdminHotspot onActivate={() => { navigate("#/admin"); }} />
      <header className="topbar">
        <div className="topbar-inner">
          <a className="brand" href="#/" onClick={(e) => { e.preventDefault(); navigate("#/"); }}>
            <BrandMark />
            <span>
              <BrandWordmark />
              <div className="brand-sub">קונים ביחד · משלמים פחות</div>
            </span>
          </a>
          <nav className="nav-links" aria-label="ניווט ראשי">
            {mallEnabled ? (
              <a className={`nav-link${page === "" ? " active" : ""}`} href="#/" onClick={(e) => { e.preventDefault(); navigate("#/"); }}>העסקאות</a>
            ) : null}
            <a className={`nav-link${page === "seller" ? " active" : ""}`} href="#/seller" onClick={(e) => { e.preventDefault(); navigate("#/seller"); }}>אזור המוכרים</a>
            <OwnerModeSwitch page={page} navigate={navigate} />
          </nav>
        </div>
      </header>

      {isAdmin ? (
        adminUnlocked ? (
          <AdminArea sub={route.seg.slice(1)} navigate={navigate} />
        ) : (
          <AdminStepUp
            onUnlocked={() => setAdminUnlocked(true)}
            onCancel={() => navigate("#/")}
          />
        )
      ) : (
        <main className="container">
          {page === "" ? <Home navigate={navigate} /> : null}
          {page === "deal" && route.seg[1] ? <DealPage dealId={route.seg[1]} navigate={navigate} /> : null}
          {page === "track" && route.seg[1] ? <TrackPage participantId={route.seg[1]} token={route.query.get("t") || ""} /> : null}
          {page === "seller" ? <SellerArea sub={route.seg.slice(1)} query={route.query} navigate={navigate} /> : null}
          {page === "support" ? <SupportPage /> : null}
          {page === "reset-password" ? <ResetPasswordPage navigate={navigate} /> : null}
          {!["", "deal", "track", "seller", "support", "reset-password"].includes(page) ? <Home navigate={navigate} /> : null}
        </main>
      )}

      {!isAdmin ? (
        <footer className="footer">
          <div>
            <a href="#/support" onClick={(e) => { e.preventDefault(); navigate("#/support"); }}>תמיכה ויצירת קשר</a>
            <a href="/legal/terms">תקנון ותנאי שימוש</a>
            <a href="/legal/privacy">פרטיות</a>
            <a href="/legal/refunds">מדיניות ביטולים והחזרים</a>
          </div>
          <div style={{ marginTop: 8 }}>
            C-ton — פלטפורמת קניות קבוצתיות · סביבת הדגמה (ללא חיובים אמיתיים)
          </div>
        </footer>
      ) : null}
    </div>
  );
}
