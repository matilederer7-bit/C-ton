import React, { useEffect, useMemo, useRef, useState } from "react";
import { getSellerToken } from "../api";
import { BRAND_LOGO_URL } from "../config";
import { LANDING_HE } from "../content/landing.he";
import { getPreviewMeta } from "../previewMeta";
// ROUND 2 (UX-7B / UX-7A) — one hero medium, one FAQ source of truth.
import { readViewerMotionConditions, resolveHeroMedium, type HeroMedium } from "../heroMedium";
import { resolveFaqItems } from "../faqContent";
import { pageOf, useSiteContent } from "../siteContent";
import { type Block, enabledBlocks } from "../content/cmsTemplates";

// ── C-ton public landing (seller-first root; Mall stays hidden) ─────────────
// SITE CMS — the page is the ordered block list of the PUBLISHED `home` page
// (web/src/content/cmsTemplates.ts). Every block renders inside the fixed
// Siton design for its template; the canonical Hebrew copy in
// content/landing.he.ts is the deterministic fallback (missing CMS data, a
// failed request, a malformed row — the normalizer always yields a full page).
// A section renders only when its content exists (presence gating kept), and
// a block the owner disabled never reaches the DOM. System truth stays
// hardcoded on purpose: the pilot disclosure, the auth-dependent seller
// buttons and the Mall-gated buyer entry link.

// ── ROUND 2 (UX-7B) — the hero carries EXACTLY ONE primary medium ─────────
// The decision lives in ../heroMedium (one pure rule, one object out), so an
// image and a video can no longer both end up on screen. The CMS hero block
// now stores the choice (media_kind + uploaded image/video); the runtime
// LANDING_HERO_VIDEO_* env remains a fallback video source when the owner
// chose "video" without uploading one. A video is never forced on a viewer
// who asked for reduced motion or is on save-data/2G; it is muted, looping,
// playsInline, poster-backed and loaded after first paint. No audio, ever.
function useHeroMedium(hero: Record<string, string>, fallbackImage: string): HeroMedium {
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
    imageUrl: hero.image,
    fallbackImageUrl: fallbackImage,
    mediaKind: hero.media_kind === "video" ? "video" : "image",
    cmsVideoUrl: hero.video,
    cmsVideoPoster: hero.video_poster,
    videoEnabled: deferred && Boolean(meta?.landing_hero_video_enabled),
    videoUrl: meta?.landing_hero_video_url as string | undefined,
    videoPoster: meta?.landing_hero_video_poster as string | undefined,
    deferred,
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
          <source src={medium.url} type={medium.url.endsWith(".webm") ? "video/webm" : "video/mp4"} />
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
    <section className="landing-section" id={id} data-testid={`landing-block-${id}`} data-block-type="text">
      <h2>{title}</h2>
      <p style={{ whiteSpace: "pre-wrap" }}>{body}</p>
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

/** CMS links are validated (internal hash route, same-origin path or https); hash routes stay in-app. */
function follow(navigate: (h: string) => void, link: string) {
  if (!link) return;
  if (link.startsWith("#/")) navigate(link);
  else window.location.assign(link);
}

function LandingBlock({ block, navigate, authed }: { block: Block; navigate: (h: string) => void; authed: boolean }) {
  const f = block.fields;
  const items = block.items || [];
  const testId = `landing-block-${block.id}`;
  if (block.type === "text") return <ContentSection id={block.id} title={f.title || ""} body={f.body || ""} />;
  if (block.type === "steps") {
    if (!items.length) return null;
    return (
      <section className="landing-section" id={block.id} data-testid={testId} data-block-type="steps">
        {f.title ? <h2>{f.title}</h2> : null}
        <div className="landing-steps">
          {items.map((s, i) => (
            <div className="landing-step" key={`${i}-${s.title}`}>
              <div className="landing-step-bar" aria-hidden="true" />
              <h3>{s.title}</h3>
              <p>{s.body}</p>
            </div>
          ))}
        </div>
      </section>
    );
  }
  if (block.type === "columns") {
    const cols = items.filter((c) => String(c.body || "").trim() || String(c.cta_label || "").trim());
    if (!cols.length) return null;
    return (
      <section className="landing-section" id={block.id} data-testid={testId} data-block-type="columns">
        {f.title ? <h2>{f.title}</h2> : null}
        <div className={`landing-cols${cols.length === 3 ? " landing-cols-3" : ""}`}>
          {cols.map((c, i) => (
            <div className="landing-col" key={`${i}-${c.title}`}>
              <div className="landing-step-bar" aria-hidden="true" />
              <h3>{c.title}</h3>
              {c.body ? <p>{c.body}</p> : null}
              {c.cta_label ? <button className="btn btn-primary" onClick={() => follow(navigate, c.cta_link || "")}>{c.cta_label}</button> : null}
            </div>
          ))}
        </div>
      </section>
    );
  }
  if (block.type === "image_text") {
    if (!String(f.body || "").trim() && !f.image) return null;
    return (
      <section className={`landing-section landing-image-text${f.image_position === "end" ? " image-end" : ""}`} id={block.id} data-testid={testId} data-block-type="image_text">
        {f.image ? <img className="landing-image-text-img" src={f.image} alt="" loading="lazy" /> : null}
        <div className="landing-image-text-body">
          {f.title ? <h2>{f.title}</h2> : null}
          {f.body ? <p style={{ whiteSpace: "pre-wrap" }}>{f.body}</p> : null}
        </div>
      </section>
    );
  }
  if (block.type === "faq") {
    // ROUND 2 (UX-7A) — the resolver keeps the canonical FAQ as the fallback,
    // so a corrupt or empty persisted collection can never blank the section.
    const faqItems = resolveFaqItems({ items }, LANDING_HE.faq.items);
    if (!faqItems.length) return null;
    return (
      <section className="landing-section" id={block.id} data-testid={testId} data-block-type="faq">
        <h2>{f.title || LANDING_HE.faq.title}</h2>
        <div className="landing-faq" data-testid="landing-faq" data-faq-count={faqItems.length}>
          {faqItems.map((item, i) => (
            <details className="landing-faq-item" key={`${i}-${item.q}`}>
              <summary>{item.q}</summary>
              <p>{item.a}</p>
            </details>
          ))}
        </div>
      </section>
    );
  }
  if (block.type === "cta") {
    if (!String(f.title || "").trim()) return null;
    return (
      <section className="landing-section landing-cta-final" id={block.id} data-testid={testId} data-block-type="cta">
        <h2>{f.title}</h2>
        {f.body ? <p className="muted">{f.body}</p> : null}
        <div className="landing-actions">
          {f.button_label ? <button className="btn btn-primary" onClick={() => follow(navigate, f.button_link || "")}>{f.button_label}</button> : null}
          {block.id === "contact" ? (
            <button className="btn btn-ghost" onClick={() => navigate(authed ? "#/seller/new" : "#/seller?signup=1")}>
              {authed ? "+ יצירת עסקה חדשה" : "פתיחת חשבון מוכר"}
            </button>
          ) : null}
        </div>
      </section>
    );
  }
  return null;
}

export function Landing({ navigate }: { navigate: (h: string) => void }) {
  const authed = Boolean(getSellerToken());
  const mallEnabled = useMallEnabled();
  const content = useSiteContent();
  const page = pageOf(content, "home");
  const blocks = enabledBlocks(page);
  const hero = (blocks.find((b) => b.id === "hero") || page.blocks[0])!.fields;
  const c = LANDING_HE;
  // ROUND 2 (UX-7B) — ONE medium for the hero, never both.
  const heroMedium = useHeroMedium(hero, BRAND_LOGO_URL);
  return (
    <div className="landing" data-testid="landing" data-block-count={blocks.length}>
      <section className="landing-hero" data-testid="landing-block-hero" data-block-type="hero">
        {heroMedium.kind === "video" ? <HeroMediumView medium={heroMedium} /> : null}
        <div className="landing-hero-inner">
          {heroMedium.kind === "image" ? <HeroMediumView medium={heroMedium} /> : null}
          <h1 className="landing-title">{hero.title || c.hero.title}</h1>
          {hero.subtitle ? <p className="landing-sub">{hero.subtitle}</p> : null}
          <div className="landing-actions">
            {authed ? (
              <>
                <button className="btn btn-primary btn-lg" onClick={() => navigate("#/seller")}>לדשבורד שלי ←</button>
                <button className="btn btn-ghost btn-lg" onClick={() => navigate("#/seller/new")}>+ יצירת עסקה חדשה</button>
              </>
            ) : (
              <>
                <button className="btn btn-primary btn-lg" onClick={() => follow(navigate, hero.primary_cta_link || "#/seller")}>{hero.primary_cta_label || "התחברות מוכר"}</button>
                <button className="btn btn-ghost btn-lg" onClick={() => follow(navigate, hero.secondary_cta_link || "#/seller?signup=1")}>{hero.secondary_cta_label || "פתיחת חשבון מוכר"}</button>
              </>
            )}
          </div>
          <div className="landing-buyer-entry" data-testid="landing-buyer-entry">
            <b>{hero.buyer_entry_title || c.buyerEntry.title}</b>
            <p>{hero.buyer_entry_body || c.buyerEntry.body}</p>
            {mallEnabled ? (
              <button className="btn btn-ghost btn-sm" data-testid="landing-open-deals" onClick={() => navigate("#/deals")}>{c.buyerEntry.cta} ←</button>
            ) : (
              hero.body ? <p className="landing-note" style={{ margin: 0 }}>{hero.body}</p> : null
            )}
          </div>
          {/* ROUND 2 (UX-1) — the closed-pilot disclosure is TEXT and stays
              SYSTEM TRUTH: it is not a CMS field on purpose. */}
          <p className="landing-note landing-pilot" data-testid="landing-pilot-note">{c.pilot.note}</p>
        </div>
      </section>

      {blocks.filter((b) => b.id !== "hero").map((block) => <LandingBlock key={block.id} block={block} navigate={navigate} authed={authed} />)}
    </div>
  );
}
