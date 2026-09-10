// ── ROUND 2 (UX-7B) — EXACTLY ONE active hero medium ────────────────────────
//
// Owner intent: the landing hero carries one primary medium — an IMAGE **or** a
// VIDEO — and the two must never be on screen together by accident.
//
// Today the two candidates arrive from two unrelated places:
//   * the image: site_content.home.image (the admin CMS "תמונת פתיחה" field),
//     validated as /api/content-assets/<uuid>;
//   * the video: the LANDING_HERO_VIDEO_* runtime env, surfaced on
//     /api/preview/meta.
// Nothing in the current contract says which of the two is "the" medium, so a
// configured video used to render *behind* a configured image. This module is
// the single decision point: one input set in, one medium out.
//
// BACKEND GAP (documented, deliberately NOT implemented in this task):
// a real image-or-video CMS choice needs (a) a stored `kind` on the hero
// content field and (b) a video MIME in siton.content_assets — whose CHECK
// constraint today allows only image/png|jpeg|webp, so uploading a video is
// rejected at the database. Both require a migration + a persistence-contract
// change. See docs/UX_PRODUCT_POLISH_ROUND_2.md.
//
// Pure module (no DOM, no React) so the precedence rule is unit-testable.

export interface HeroMediumInput {
  /** site_content.home.image — an /api/content-assets/<uuid> URL, or empty */
  imageUrl?: string | null;
  /** brand asset used when the CMS image slot is empty (never a "second medium") */
  fallbackImageUrl: string;
  /** runtime flag + asset for the background-video capability */
  videoEnabled?: boolean | null;
  videoUrl?: string | null;
  videoPoster?: string | null;
  /** viewer conditions — a video is never forced on someone who opted out of motion */
  prefersReducedMotion?: boolean;
  saveData?: boolean;
}

export type HeroMedium =
  | { kind: "video"; url: string; poster: string }
  | { kind: "image"; url: string; fromCms: boolean };

/**
 * The ONE precedence rule.
 *
 * A video wins only when it is fully available AND the viewer's own conditions
 * allow it; in every other case the medium is an image. The result is a single
 * object, so a caller that renders `medium.kind` can never show both.
 */
export function resolveHeroMedium(input: HeroMediumInput): HeroMedium {
  const videoUrl = String(input.videoUrl || "").trim();
  const videoUsable = Boolean(input.videoEnabled) && videoUrl.length > 0
    && !input.prefersReducedMotion && !input.saveData;
  if (videoUsable) {
    return { kind: "video", url: videoUrl, poster: String(input.videoPoster || "").trim() };
  }
  const cms = String(input.imageUrl || "").trim();
  return cms
    ? { kind: "image", url: cms, fromCms: true }
    : { kind: "image", url: input.fallbackImageUrl, fromCms: false };
}

/** Viewer conditions, read from the browser once (kept here so callers stay declarative). */
export function readViewerMotionConditions(): { prefersReducedMotion: boolean; saveData: boolean } {
  let prefersReducedMotion = false, saveData = false;
  try { prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { /* default to allowing motion */ }
  try {
    const conn = (navigator as any).connection;
    saveData = Boolean(conn && (conn.saveData || /(^|-)2g/.test(String(conn.effectiveType || ""))));
  } catch { /* default to allowing motion */ }
  return { prefersReducedMotion, saveData };
}
