import React, { useEffect, useMemo, useRef, useState } from "react";
import { getSellerToken } from "../api";
import { BRAND_LOGO_URL } from "../config";
import { LANDING_HE } from "../content/landing.he.js";
import { LANDING_EN } from "../content/landing.en.js";
import { getLocale } from "../i18n/locale.js";
import { getPreviewMeta } from "../previewMeta";
// ROUND 2 (UX-7B / UX-7A) — one hero medium, one FAQ source of truth.
import { readViewerMotionConditions, resolveHeroMedium, resolveIntroVideo, type HeroMedium, type IntroVideo } from "../heroMedium";
import { resolveFaqItems } from "../faqContent";
import { pageOf, useSiteContentState } from "../siteContent";
import { type Block, enabledBlocks } from "../content/cmsTemplates";
import { t } from "../i18n/index.js";

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
function useHeroMedium(hero: Record<string, string>, fallbackImage: string): { logo: Extract<HeroMedium, { kind: "image" }>; intro: IntroVideo | null; metaReady: boolean } {
  const [meta, setMeta] = useState<Record<string, unknown> | null>(null);
  const [deferred, setDeferred] = useState(false);
  useEffect(() => {
    let alive = true;
    getPreviewMeta().then((m) => { if (alive) setMeta((m || {}) as Record<string, unknown>); }).catch(() => { if (alive) setMeta({}); });
    // the video only becomes eligible after first paint
    const start = () => { if (alive) setDeferred(true); };
    if (typeof window !== "undefined" && "requestIdleCallback" in window) (window as any).requestIdleCallback(start, { timeout: 2500 });
    else setTimeout(start, 800);
    return () => { alive = false; };
  }, []);
  const conditions = useMemo(() => readViewerMotionConditions(), []);
  const input = {
    imageUrl: hero.image,
    fallbackImageUrl: fallbackImage,
    mediaKind: (hero.media_kind === "video" ? "video" : hero.media_kind === "image" ? "image" : undefined) as "video" | "image" | undefined,
    cmsVideoUrl: hero.video,
    cmsVideoPoster: hero.video_poster,
    videoEnabled: Boolean(meta?.landing_hero_video_enabled),
    videoUrl: meta?.landing_hero_video_url as string | undefined,
    videoPoster: meta?.landing_hero_video_poster as string | undefined,
    deferred,
    ...conditions
  };
  // The logo is always the hero image now; the video has its own slot under it.
  const logo = resolveHeroMedium({ ...input, mediaKind: "image" });
  return { logo: logo.kind === "image" ? logo : { kind: "image", url: fallbackImage, fromCms: false }, intro: resolveIntroVideo(input), metaReady: meta !== null };
}

function HeroMediumView({ medium }: { medium: Extract<HeroMedium, { kind: "image" }> }) {
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

// The intro video slot: a fixed 16:9 box reserved as soon as a source is
// configured (poster first, so nothing jumps), the <video> attached only when
// `play` allows it. muted + autoPlay + loop + playsInline, no controls, no
// audio track is ever unmuted. A failed load keeps the poster.
function introVideoMime(url: string): string {
  const data = /^data:(video\/[a-z0-9.+-]+)[;,]/i.exec(url);
  if (data) return data[1]!.toLowerCase();
  return /\.webm(?:$|[?#])/i.test(url) ? "video/webm" : "video/mp4";
}

function IntroVideoView({ video }: { video: IntroVideo }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [failed, setFailed] = useState(false);
  return (
    <div className="landing-intro-video" data-testid="landing-intro-video" data-playing={video.play && !failed ? "1" : "0"}
      style={video.poster ? { backgroundImage: `url("${video.poster.replace(/"/g, "%22")}")` } : undefined}>
      {video.play && !failed ? (
        <video ref={ref} muted autoPlay loop playsInline preload="metadata" disablePictureInPicture
          poster={video.poster || undefined} aria-hidden="true" tabIndex={-1}
          onCanPlay={() => { try { void ref.current?.play()?.catch?.(() => undefined); } catch { /* autoplay refused: the poster stays */ } }}
          onError={() => setFailed(true)}>
          <source src={video.url} type={introVideoMime(video.url)} />
        </video>
      ) : null}
    </div>
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

/**
 * The canonical landing CONTENT for the active language.
 *
 * These are the fallbacks used when a CMS block is absent — and they have to
 * follow the language like everything else, otherwise the English landing
 * quietly renders Hebrew copy wherever the CMS has not been filled in.
 */
function landingDefaults(): typeof LANDING_HE {
  return getLocale() === "en" ? (LANDING_EN as typeof LANDING_HE) : LANDING_HE;
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
    const faqItems = resolveFaqItems({ items }, landingDefaults().faq.items);
    if (!faqItems.length) return null;
    return (
      <FaqBlock id={block.id} testId={testId} title={f.title || landingDefaults().faq.title} items={faqItems} />
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
              {authed ? t("landing.create_new_deal") : t("landing.open_seller_account")}
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
  const { content, loading: contentLoading } = useSiteContentState();
  const page = pageOf(content, "home");
  const blocks = enabledBlocks(page);
  const hero = (blocks.find((b) => b.id === "hero") || page.blocks[0])!.fields;
  // The built-in default follows the ACTIVE language too: a CMS block that is
  // missing must not drag the whole hero back into Hebrew.
  const c = landingDefaults();
  // ROUND 2 (UX-7B) — ONE medium for the hero, never both.
  const { logo, intro, metaReady } = useHeroMedium(hero, BRAND_LOGO_URL);
  // No layout jump: whether a video slot exists is only known once the runtime
  // config and the CMS content have arrived, so the hero is laid out ONCE, when
  // both are in (capped at 1.5 s — a slow network never blanks the page).
  const [waitedEnough, setWaitedEnough] = useState(false);
  useEffect(() => { const id = setTimeout(() => setWaitedEnough(true), 1500); return () => clearTimeout(id); }, []);
  const settled = !contentLoading && metaReady;
  // The video decision is taken ONCE, at the first layout (Codex P2 on #120):
  // if the hero had to be shown on the timeout, a late CMS/meta answer must not
  // insert the 16:9 slot above the title and shift the page — the video then
  // waits for the next page view.
  const videoAllowed = useRef<boolean | null>(null);
  if (videoAllowed.current === null && (settled || waitedEnough)) videoAllowed.current = settled;
  if (!waitedEnough && !settled) {
    return <div className="landing landing-pending" data-testid="landing-pending" aria-busy="true" />;
  }
  return (
    <div className="landing" data-testid="landing" data-block-count={blocks.length}>
      <section className="landing-hero" data-testid="landing-block-hero" data-block-type="hero">
        <div className="landing-hero-inner">
          <HeroMediumView medium={logo} />
          {/* owner decision 2026-09-28: the video sits under the logo, before the title */}
          {intro && videoAllowed.current ? <IntroVideoView video={intro} /> : null}
          <h1 className="landing-title">{hero.title || c.hero.title}</h1>
          {hero.subtitle ? <p className="landing-sub">{hero.subtitle}</p> : null}
          <div className="landing-actions">
            {authed ? (
              <>
                <button className="btn btn-primary btn-lg" onClick={() => navigate("#/seller")}>{t("landing.to_my_dashboard")}</button>
                <button className="btn btn-ghost btn-lg" onClick={() => navigate("#/seller/new")}>{t("landing.create_new_deal")}</button>
              </>
            ) : (
              <>
                <button className="btn btn-primary btn-lg" onClick={() => follow(navigate, hero.primary_cta_link || "#/seller")}>{hero.primary_cta_label || t("landing.seller_sign")}</button>
                <button className="btn btn-ghost btn-lg" onClick={() => follow(navigate, hero.secondary_cta_link || "#/seller?signup=1")}>{hero.secondary_cta_label || t("landing.open_seller_account")}</button>
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


// The whole FAQ is ONE collapsed block (owner decision 2026-09-28): the visitor
// sees only "שאלות נפוצות"; a click (or Enter / Space on the focused button)
// opens the questions, a second one closes them. A real <button> carries
// aria-expanded / aria-controls, so keyboards and screen readers get the same
// control a mouse does; each question inside still opens its own answer.
function FaqBlock({ id, testId, title, items }: { id: string; testId: string; title: string; items: { q: string; a: string }[] }) {
  const [open, setOpen] = React.useState(false);
  const panelId = `${id || "faq"}-panel`;
  return (
    <section className="landing-section landing-faq-block" id={id} data-testid={testId} data-block-type="faq">
      <h2 className="landing-faq-heading">
        <button type="button" className="landing-faq-toggle" data-testid="landing-faq-toggle"
          aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((v) => !v)}>
          <span>{title}</span>
          <span className="landing-faq-chevron" aria-hidden="true">{open ? "−" : "+"}</span>
        </button>
      </h2>
      <div className="landing-faq" id={panelId} data-testid="landing-faq" data-faq-count={items.length} hidden={!open}>
        {items.map((item, i) => (
          <details className="landing-faq-item" key={`${i}-${item.q}`}>
            <summary>{item.q}</summary>
            <p>{item.a}</p>
          </details>
        ))}
      </div>
    </section>
  );
}
