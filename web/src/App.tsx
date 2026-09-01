import React, { useEffect, useState } from "react";
import { Mall } from "./pages/mall";
import { Landing } from "./pages/landing";
import { DealPage } from "./pages/deal";
import { TrackPage } from "./pages/track";
import { SellerArea } from "./pages/seller";
import { AdminArea } from "./pages/admin";
import { captureRefFromLocation } from "./viral";
import { BrandMark, BrandWordmark } from "./brand";
import { PUBLIC_MALL_ENABLED } from "./config";
import { OWNER_CAPS_EVENT, enterGuestMode, exitGuestMode, isGuestMode, readOwnerCaps } from "./ownerMode";
import { startSessionHeartbeat } from "./session";

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
    fetch("/api/preview/meta")
      .then((r) => (r.ok ? r.json() : null))
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
  const mode = page === "admin" ? "admin" : page === "seller" ? "seller" : "";
  return (
    <div className="owner-switch" role="group" aria-label="מצב תצוגה" data-testid="owner-switch">
      <span className="owner-switch-label">הצג כ:</span>
      <button data-testid="owner-mode-guest" onClick={enterGuestMode}>אורח</button>
      <button data-testid="owner-mode-seller" className={mode === "seller" ? "active" : ""} onClick={() => navigate("#/seller")}>מוכר</button>
      <button data-testid="owner-mode-admin" className={mode === "admin" ? "active" : ""} onClick={() => navigate("#/admin")}>מנהל</button>
    </div>
  );
}

// Deliberately subtle admin entry — visual obscurity ONLY, never security:
// the control center still requires canonical Supabase auth + server-side
// admin permission on every request.
function AdminDots({ navigate }: { navigate: (h: string) => void }) {
  return (
    <>
      <button className="admin-dot top" aria-label="כניסת מנהל" title="" onClick={() => navigate("#/admin")} />
      <button className="admin-dot bottom" aria-label="כניסת מנהל" title="" onClick={() => navigate("#/admin")} />
    </>
  );
}

export default function App() {
  const [route, navigate] = useRoute();
  const mallEnabled = useMallEnabled();
  const page = route.page;
  const isAdmin = page === "admin";

  // When the Mall is hidden, the root and every unknown route land on the
  // seller-first C-ton landing. Direct deal/track links always work.
  const Home = mallEnabled ? Mall : Landing;

  return (
    <div className="app">
      <AdminDots navigate={navigate} />
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
        <AdminArea sub={route.seg.slice(1)} navigate={navigate} />
      ) : (
        <main className="container">
          {page === "" ? <Home navigate={navigate} /> : null}
          {page === "deal" && route.seg[1] ? <DealPage dealId={route.seg[1]} navigate={navigate} /> : null}
          {page === "track" && route.seg[1] ? <TrackPage participantId={route.seg[1]} token={route.query.get("t") || ""} /> : null}
          {page === "seller" ? <SellerArea sub={route.seg.slice(1)} query={route.query} navigate={navigate} /> : null}
          {!["", "deal", "track", "seller"].includes(page) ? <Home navigate={navigate} /> : null}
        </main>
      )}

      {!isAdmin ? (
        <footer className="footer">
          <div>
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
