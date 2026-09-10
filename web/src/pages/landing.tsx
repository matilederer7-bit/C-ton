import { useSiteContent } from "../receiptContent";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { getSellerToken } from "../api";
import { BRAND_LOGO_URL } from "../config";
import { LANDING_HE } from "../content/landing.he";
import { getPreviewMeta } from "../previewMeta";
// ROUND 2 (UX-7B / UX-7A) — one hero medium, one FAQ source of truth.
import { readViewerMotionConditions, resolveHeroMedium, type HeroMedium } from "../heroMedium";
import { resolveFaqItems } from "../faqContent";

// ── C-ton public landing (seller-first root; Mall stays hidden) ─────────────
// Rich content architecture with presence-gated sections: a section renders
// only when its canonical Hebrew content exists (content/landing.he.ts).
// The final About copy is owner-supplied — its slot hides until filled.

// ── ROUND 2 (UX-7B) — the hero carries EXACTLY ONE primary medium ─────────
// The decision lives in ../heroMedium (one pure rule, one object out), so an
// image and a video can no longer both end up on screen: previously a
// configured background video rendered BEHIND the configured hero image.
// A video still requires the runtime flag + asset, and is never forced on a
// viewer who asked for reduced motion or is on save-data/2G; it is muted,
// looping, playsInline, poster-backed and loaded after first paint so it
// never blocks LCP. No audio, ever.
// The CMS cannot yet STORE a video choice (content_assets allows only image
// MIME types) — that gap is documented, not faked. See
// docs/UX_PRODUCT_POLISH_ROUND_2.md.
function useHeroMedium(cmsImage: string, fallbackImage: string): HeroMedium {
  const [meta, setMeta] = useState<Record<string, unknown> | null>(null);
  const [deferred, setDeferred] = useState(false);
  useEffect(() => {
    let alive = true;
    getPreviewMeta().then((m) => { if (alive) setMeta((m || {}) as Record<string, unknown>); }).catch(() => undefined);
    // the video only becomes eligible after first paint
    const start = () => { if (alive) setDeferred(true); };
    if (typeof window !== "undefined" && "requestIdleCallback" in window) (window as any).requestIdleCallback(start, { timeout: 2500 });
    else setTimeout(start, 800);
    return () => { alive = false; };
  }, []);
  const conditions = useMemo(() => readViewerMotionConditions(), []);
  return resolveHeroMedium({
    imageUrl: cmsImage,
    fallbackImageUrl: fallbackImage,
    videoEnabled: deferred && Boolean(meta?.landing_hero_video_enabled),
    videoUrl: meta?.landing_hero_video_url as string | undefined,
    videoPoster: meta?.landing_hero_video_poster as string | undefined,
    ...conditions
  });
}

function HeroMediumView({ medium }: { medium: HeroMedium }) {
  const ref = useRef<HTMLVideoElement>(null);
  if (medium.kind === "video") {
    return (
      <div className="hero-video" data-testid="hero-medium" data-hero-medium="video" aria-hidden="true">
        <video ref={ref} muted autoPlay loop playsInline preload="metadata" poster={medium.poster || undefined}
          onCanPlay={() => { try { void ref.current?.play(); } catch { /* noop */ } }}>
          <source src={medium.url} type="video/mp4" />
        </video>
        <div className="hero-video-overlay" />
      </div>
    );
  }
  return (
    <img
      className="landing-logo"
      data-testid="hero-medium"
      data-hero-medium="image"
      data-hero-from-cms={medium.fromCms ? "1" : "0"}
      src={medium.url}
      alt="C-ton"
      width={340}
      height={227}
      draggable={false}
    />
  );
}

function ContentSection({ id, title, body }: { id: string; title: string; body: string }) {
  if (!String(body || "").trim()) return null;
  return (
    <section className="landing-section" id={id}>
      <h2>{title}</h2>
      <p>{body}</p>
    </section>
  );
}

// LAUNCH POLISH 2 (P9) — the buyer entry links to the open-deals list ONLY
// while the runtime says the Mall is enabled; otherwise deals are reached by
// link (closed pilot) and the box says exactly that.
function useMallEnabled(): boolean {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let alive = true;
    getPreviewMeta().then((meta) => { if (alive) setEnabled(Boolean(meta?.public_mall_enabled)); }).catch(() => undefined);
    return () => { alive = false; };
  }, []);
  return enabled;
}

export function Landing({ navigate }: { navigate: (h: string) => void }) {
  const authed = Boolean(getSellerToken());
  const mallEnabled = useMallEnabled();
  const content = useSiteContent();
  const c = { ...LANDING_HE, hero: { ...LANDING_HE.hero, title: content.home?.title ?? LANDING_HE.hero.title, sub: content.home?.sub ?? LANDING_HE.hero.sub, note: content.home?.intro ?? LANDING_HE.hero.note }, about: content.about || LANDING_HE.about };
  // ROUND 2 (UX-7B) — ONE medium for the hero, never both.
  const heroMedium = useHeroMedium(String(content.home?.image || ""), BRAND_LOGO_URL);
  // ROUND 2 (UX-7A) — the FAQ already reads through the resolver, so the day
  // the CMS can store an ordered collection this line is the only wiring.
  const faqItems = resolveFaqItems(content.faq, LANDING_HE.faq.items);
  return (
    <div className="landing">
      <section className="landing-hero">
        {heroMedium.kind === "video" ? <HeroMediumView medium={heroMedium} /> : null}
        <div className="landing-hero-inner">
          {heroMedium.kind === "image" ? <HeroMediumView medium={heroMedium} /> : null}
          <h1 className="landing-title">{c.hero.title}</h1>
          <p className="landing-sub">{c.hero.sub}</p>
          <div className="landing-actions">
            {authed ? (
              <>
                <button className="btn btn-primary btn-lg" onClick={() => navigate("#/seller")}>לדשבורד שלי ←</button>
                <button className="btn btn-ghost btn-lg" onClick={() => navigate("#/seller/new")}>+ יצירת עסקה חדשה</button>
              </>
            ) : (
              <>
                <button className="btn btn-primary btn-lg" onClick={() => navigate("#/seller")}>{content.home?.login_cta || "התחברות מוכר"}</button>
                <button className="btn btn-ghost btn-lg" onClick={() => navigate("#/seller?signup=1")}>{content.home?.signup_cta || "פתיחת חשבון מוכר"}</button>
              </>
            )}
          </div>
          <div className="landing-buyer-entry" data-testid="landing-buyer-entry">
            <b>{c.buyerEntry.title}</b>
            <p>{c.buyerEntry.body}</p>
            {mallEnabled ? (
              <button className="btn btn-ghost btn-sm" data-testid="landing-open-deals" onClick={() => navigate("#/deals")}>{c.buyerEntry.cta} ←</button>
            ) : (
              <p className="landing-note" style={{ margin: 0 }}>{c.hero.note}</p>
            )}
          </div>
          {/* ROUND 2 (UX-1) — the closed-pilot disclosure is TEXT. The decorative
              glyph that sat beside it is gone and nothing replaces it: the line
              keeps its own spacing and saffron weight to stay findable. */}
          <p className="landing-note landing-pilot" data-testid="landing-pilot-note">{c.pilot.note}</p>
        </div>
      </section>

      <section className="landing-section" id="how">
        <h2>{c.howItWorks.title}</h2>
        <div className="landing-steps">
          {c.howItWorks.steps.map((s) => (
            <div className="landing-step" key={s.title}>
              <div className="landing-step-bar" aria-hidden="true" />
              <h3>{s.title}</h3>
              <p>{s.body}</p>
            </div>
          ))}
        </div>
      </section>

      <ContentSection id="why" title={c.whyGroupBuying.title} body={c.whyGroupBuying.body} />

      {(c.forBuyers.body || c.forSellers.body) ? (
        <section className="landing-section" id="audiences">
          <div className="landing-cols">
            {c.forBuyers.body ? (
              <div className="landing-col">
                <div className="landing-step-bar" aria-hidden="true" />
                <h3>{c.forBuyers.title}</h3>
                <p>{c.forBuyers.body}</p>
              </div>
            ) : null}
            {c.forSellers.body ? (
              <div className="landing-col">
                <div className="landing-step-bar" aria-hidden="true" />
                <h3>{c.forSellers.title}</h3>
                <p>{c.forSellers.body}</p>
                <button className="btn btn-primary" onClick={() => navigate("#/seller?signup=1")}>פתיחת חשבון מוכר</button>
              </div>
            ) : null}
          </div>
        </section>
      ) : null}

      <ContentSection id="trust" title={c.trust.title} body={c.trust.body} />
      <ContentSection id="about" title={c.about.title} body={c.about.body} />

      {faqItems.length ? (
        <section className="landing-section" id="faq">
          <h2>{c.faq.title}</h2>
          <div className="landing-faq" data-testid="landing-faq" data-faq-count={faqItems.length}>
            {faqItems.map((item) => (
              <details className="landing-faq-item" key={item.q}>
                <summary>{item.q}</summary>
                <p>{item.a}</p>
              </details>
            ))}
          </div>
        </section>
      ) : null}

      <section className="landing-section landing-cta-final" id="contact">
        <h2>יש שאלה? אנחנו כאן</h2>
        <p className="muted">צוות C-ton עונה לכל פנייה.</p>
        <div className="landing-actions">
          <button className="btn btn-ghost" onClick={() => navigate("#/support")}>תמיכה ויצירת קשר</button>
          <button className="btn btn-primary" onClick={() => navigate(authed ? "#/seller/new" : "#/seller?signup=1")}>
            {authed ? "+ יצירת עסקה חדשה" : "פתיחת חשבון מוכר"}
          </button>
        </div>
      </section>
    </div>
  );
}
