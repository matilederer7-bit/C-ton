import { PublicSellerPage, ContentPage } from "./receiptContent";
import { captureCmsPreviewFlag, contentPageHasBody, exitCmsPreview, pageOf, useSiteContentState } from "./siteContent";
import { blockOf, FOOTER_DEFAULT_LINKS, FOOTER_DEFAULT_TEXT_KEY } from "./content/cmsTemplates";
import React, { useEffect, useState } from "react";
import { Mall } from "./pages/mall";
import { Landing } from "./pages/landing";
import { DealPage } from "./pages/deal";
import { TrackPage } from "./pages/track";
import { SellerArea } from "./pages/seller";
import { AdminArea } from "./pages/admin";
import { SupportPage } from "./pages/support";
import { ResetPasswordPage } from "./pages/reset";
// External link dashboard: a scoped read-only analytics view for one
// distribution link (no seller navigation, no other surfaces).
import { LinkViewerPage } from "./pages/distribution";
import { getPreviewMeta } from "./previewMeta";
// ROUND 2 (UX-9, ported from Sprint 4) — Back/Forward restore the exact
// position of the history entry they return to; a NEW entry starts at the top.
import { installScrollRestoration } from "./scrollRestoration";
import { captureAuthRedirect } from "./authRedirect";
import { t } from "./i18n/index.js";

// Supabase auth-email redirects (recovery/confirmation) land in the hash —
// capture them BEFORE any routing or ref-capture touches the URL.
captureAuthRedirect();
// SITE CMS — an admin opening "תצוגה מקדימה" lands on #/?cms_preview=1; the
// flag is adopted for THIS tab only (draft content is served only to an
// authenticated admin; everyone else keeps reading the published site).
captureCmsPreviewFlag();
import { captureRefFromLocation } from "./viral";
import { BrandMark, BrandWordmark } from "./brand";
import { PUBLIC_MALL_ENABLED } from "./config";
import { OWNER_CAPS_EVENT, enterGuestMode, exitGuestMode, isGuestMode, readOwnerCaps } from "./ownerMode";
import { startSessionHeartbeat } from "./session";
import { isAdminUnlocked } from "./adminGate";
import { AdminStepUp } from "./adminStepUp";
// ── Language ───────────────────────────────────────────────────────────────
// Hebrew is the default and is NEVER overridden by the operating system: the
// locale comes from the visitor's own stored choice or from nothing at all.
import { bootLocale } from "./i18n/locale.js";
import { useLocale } from "./i18n/useLocale.js";
import { LanguageSwitch } from "./i18n/LanguageSwitch.js";
import type { Locale } from "./i18n/locale.js";

// Read the stored language choice and reflect it on <html lang/dir> BEFORE the
// first paint, so the document never renders one language inside the other's
// direction.
bootLocale();
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
    // ROUND 2 (UX-9) — replaces the old unconditional scroll-to-top: the
    // restoration decides per HISTORY ENTRY whether this is a traversal (put
    // the buyer back where they were) or a brand-new entry (start at the top).
    const restoration = installScrollRestoration();
    const onChange = () => { restoration.onHashChange(); setRoute(parseHash()); };
    window.addEventListener("hashchange", onChange);
    return () => { window.removeEventListener("hashchange", onChange); restoration.dispose(); };
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
        {t("app.back_my_account")}</button>
    );
  }
  const caps = readOwnerCaps();
  if (!caps?.admin) return null;
  const mode = page === "seller" ? "seller" : "";
  // P0.5-1: the Admin surface is NEVER advertised — no "מנהל" button anywhere.
  // Admin is entered only through the hidden two-tap edge gate + password
  // step-up. The visible modes stay אורח / מוכר.
  return (
    <div className="owner-switch" role="group" aria-label={t("app.view_mode")} data-testid="owner-switch">
      <span className="owner-switch-label">{t("app.view")}</span>
      <button data-testid="owner-mode-guest" onClick={enterGuestMode}>{t("app.guest")}</button>
      <button data-testid="owner-mode-seller" className={mode === "seller" ? "active" : ""} onClick={() => navigate("#/seller")}>{t("app.seller")}</button>
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
  const [locale] = useLocale();
  // The whole tree is keyed on the locale: switching language REMOUNTS every
  // screen. That is deliberate. `t()` alone would re-render, but a modal built
  // before the switch, a memoised label, an error string already placed in
  // state or a formatted date held in a ref would all survive it in the
  // previous language. Remounting makes a half-translated screen impossible.
  return <AppTree key={locale} locale={locale} />;
}

function AppTree({ locale }: { locale: Locale }) {
  const { content, preview, previewDenied } = useSiteContentState();
  const footer = blockOf(pageOf(content, "footer"), "footer");
  // A footer link to an empty document page is a dead end the visitor pays for
  // with a click. Drop it until the page has a body (see contentPageHasBody).
  // `pageOf` already read the page in the active language, so the block here
  // carries resolved values; only the built-in default needs translating.
  const footerLinks = (footer?.items ?? FOOTER_DEFAULT_LINKS.map((l) => ({ label: t(l.labelKey), link: l.link })))
    .filter((l) => {
      const match = /^#\/content\/(.+)$/.exec(String(l.link || ""));
      return match ? contentPageHasBody(content, match[1]!) : true;
    });
  const [route, navigate] = useRoute();
  const mallEnabled = useMallEnabled();
  const page = route.page;
  const isAdmin = page === "admin";
  const isLinkViewer = page === "link-dashboard";
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
      {preview || previewDenied ? (
        <div className="cms-preview-banner" role="status" data-testid="cms-preview-banner" data-preview={preview ? "1" : "0"}>
          <span>{preview ? t("app.draft_preview_only_see_version") : t("app.the_preview_requires_administrator_sign")}</span>
          <button type="button" className="btn btn-sm btn-ghost" data-testid="cms-preview-exit" onClick={exitCmsPreview}>{t("app.exit_preview")}</button>
        </div>
      ) : null}
      <AdminHotspot onActivate={() => { navigate("#/admin"); }} />
      <header className="topbar">
        <div className="topbar-inner">
          <a className="brand" href="#/" onClick={(e) => { e.preventDefault(); navigate("#/"); }}>
            <BrandMark />
            <span>
              <BrandWordmark />
              <div className="brand-sub">{t("app.buying_together_paying_less")}</div>
            </span>
          </a>
          {isLinkViewer ? null : (
          <nav className="nav-links" aria-label={t("app.main_navigation")}>
            {mallEnabled ? (
              <a className={`nav-link${page === "" ? " active" : ""}`} href="#/" onClick={(e) => { e.preventDefault(); navigate("#/"); }}>{t("app.deals")}</a>
            ) : null}
            <a className={`nav-link${page === "seller" ? " active" : ""}`} href="#/seller" onClick={(e) => { e.preventDefault(); navigate("#/seller"); }}>{t("app.sellers_area")}</a>
            <OwnerModeSwitch page={page} navigate={navigate} />
          </nav>
          )}
          <LanguageSwitch />
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
          {/* LAUNCH POLISH 2 — a named buyer entry into the open deals; it only
              exists while the Mall is enabled, otherwise it is the landing */}
          {page === "deals" ? (mallEnabled ? <Mall navigate={navigate} /> : <Landing navigate={navigate} />) : null}
          {page === "deal" && route.seg[1] ? <DealPage dealId={route.seg[1]} navigate={navigate} openInquiry={route.query.get("inquiry") === "1"} /> : null}
          {/* A different tracking link is a different page: key the page on participant + token so an
              in-document link change never keeps the previous buyer's payload or swallows the new link's
              refusal (the load guard is per mounted page). */}
          {page === "track" && route.seg[1] ? <TrackPage key={`${route.seg[1]}:${route.query.get("t") || ""}`} participantId={route.seg[1]} token={route.query.get("t") || ""} /> : null}
          {page === "seller" ? <SellerArea sub={route.seg.slice(1)} query={route.query} navigate={navigate} /> : null}
          {/* Issue #39 item 5 — an in-product entry point may pre-bind the deal:
               #/support?deal=<deal id or link>. The server still resolves it. */}
          {page === "support" ? <SupportPage dealRef={route.query.get("deal") || ""} /> : null}
          {page === "public-seller" && route.seg[1] ? <PublicSellerPage id={route.seg[1]} /> : null}
          {page === "content" && route.seg[1] ? <ContentPage section={route.seg[1]} /> : null}
          {page === "reset-password" ? <ResetPasswordPage navigate={navigate} /> : null}
          {isLinkViewer ? <LinkViewerPage /> : null}
          {!["", "deals", "deal", "track", "seller", "support", "reset-password", "public-seller", "content", "link-dashboard"].includes(page) ? <Home navigate={navigate} /> : null}
        </main>
      )}

      {!isAdmin ? (
        <footer className="footer" data-testid="site-footer">
          <div>
            {footerLinks.map((l, i) => l.link.startsWith("#/") ? (
              <a key={`${i}-${l.link}`} href={l.link} onClick={(e) => { e.preventDefault(); navigate(l.link); }}>{l.label}</a>
            ) : (
              <a key={`${i}-${l.link}`} href={l.link}>{l.label}</a>
            ))}
          </div>
          <div style={{ marginTop: 8, whiteSpace: "pre-wrap" }}>
            {footer?.fields.text ?? t(FOOTER_DEFAULT_TEXT_KEY)}
          </div>
        </footer>
      ) : null}
    </div>
  );
}
