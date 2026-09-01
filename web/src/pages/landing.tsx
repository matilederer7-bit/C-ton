import React, { useEffect, useRef, useState } from "react";
import { getSellerToken } from "../api";
import { BRAND_LOGO_URL } from "../config";
import { LANDING_HE } from "../content/landing.he";
import { getPreviewMeta } from "../previewMeta";

// ── C-ton public landing (seller-first root; Mall stays hidden) ─────────────
// Rich content architecture with presence-gated sections: a section renders
// only when its canonical Hebrew content exists (content/landing.he.ts).
// The final About copy is owner-supplied — its slot hides until filled.

// Hero background-video capability (P0.2-Q). Renders ONLY when the runtime
// flag is on AND an asset URL exists AND the visitor prefers motion AND the
// connection isn't save-data — otherwise the branded graphite fallback.
// muted + autoplay + loop + playsInline + poster + dark overlay; loaded
// lazily after first paint so it never blocks LCP. No audio, ever.
function HeroVideo() {
  const [video, setVideo] = useState<{ url: string; poster: string } | null>(null);
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    let alive = true;
    getPreviewMeta().then((meta) => {
      if (!alive || !meta?.landing_hero_video_enabled || !meta?.landing_hero_video_url) return;
      try {
        if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
        const conn = (navigator as any).connection;
        if (conn && (conn.saveData || /(^|-)2g/.test(String(conn.effectiveType || "")))) return;
      } catch { /* default to showing */ }
      // defer past first paint
      const start = () => setVideo({ url: String(meta.landing_hero_video_url), poster: String(meta.landing_hero_video_poster || "") });
      if ("requestIdleCallback" in window) (window as any).requestIdleCallback(start, { timeout: 2500 });
      else setTimeout(start, 800);
    });
    return () => { alive = false; };
  }, []);
  if (!video) return null;
  return (
    <div className="hero-video" aria-hidden="true">
      <video ref={ref} muted autoPlay loop playsInline preload="metadata" poster={video.poster || undefined}
        onCanPlay={() => { try { void ref.current?.play(); } catch { /* noop */ } }}>
        <source src={video.url} type="video/mp4" />
      </video>
      <div className="hero-video-overlay" />
    </div>
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

export function Landing({ navigate }: { navigate: (h: string) => void }) {
  const authed = Boolean(getSellerToken());
  const c = LANDING_HE;
  return (
    <div className="landing">
      <section className="landing-hero">
        <HeroVideo />
        <div className="landing-hero-inner">
          <img
            className="landing-logo"
            src={BRAND_LOGO_URL}
            alt="C-ton"
            width={340}
            height={227}
            draggable={false}
          />
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
                <button className="btn btn-primary btn-lg" onClick={() => navigate("#/seller")}>התחברות מוכר</button>
                <button className="btn btn-ghost btn-lg" onClick={() => navigate("#/seller?signup=1")}>פתיחת חשבון מוכר</button>
              </>
            )}
          </div>
          <p className="landing-note">{c.hero.note}</p>
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

      {c.faq.items.length ? (
        <section className="landing-section" id="faq">
          <h2>{c.faq.title}</h2>
          <div className="landing-faq">
            {c.faq.items.map((item) => (
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
