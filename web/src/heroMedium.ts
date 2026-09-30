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
// SITE CMS (closes the documented backend gap): the hero block now stores the
// choice — `media_kind` (image | video) plus an admin-uploaded image or a
// bounded MP4/WebM video (migration 069 widened the content_assets MIME
// check). The runtime LANDING_HERO_VIDEO_* env stays a fallback video source
// when the owner chose "video" without uploading one. See docs/SITE_CMS.md.
//
// Pure module (no DOM, no React) so the precedence rule is unit-testable.

export interface HeroMediumInput {
  /** site_content.home.image — an /api/content-assets/<uuid> URL, or empty */
  imageUrl?: string | null;
  /** brand asset used when the CMS image slot is empty (never a "second medium") */
  fallbackImageUrl: string;
  /** the CMS hero choice; undefined = pre-CMS behaviour (env video wins when enabled) */
  mediaKind?: "image" | "video";
  /** admin-uploaded video (+ optional poster) from the CMS hero block */
  cmsVideoUrl?: string | null;
  cmsVideoPoster?: string | null;
  /** the video only becomes eligible after first paint */
  deferred?: boolean;
  /** runtime flag + asset for the background-video capability (env fallback) */
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
  const envUrl = String(input.videoUrl || "").trim();
  const cmsUrl = String(input.cmsVideoUrl || "").trim();
  let videoUrl = "", poster = "";
  if (input.mediaKind === "video") {
    // the owner chose video: the uploaded asset, else the env asset when enabled
    if (cmsUrl && input.deferred !== false) { videoUrl = cmsUrl; poster = String(input.cmsVideoPoster || "").trim(); }
    else if (Boolean(input.videoEnabled) && envUrl) { videoUrl = envUrl; poster = String(input.videoPoster || "").trim(); }
  } else if (input.mediaKind === undefined && Boolean(input.videoEnabled) && envUrl) {
    videoUrl = envUrl; poster = String(input.videoPoster || "").trim();
  }
  const videoUsable = videoUrl.length > 0 && !input.prefersReducedMotion && !input.saveData;
  if (videoUsable) return { kind: "video", url: videoUrl, poster };
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

// ── The landing intro video (owner decision 2026-09-28) ──────────────────────
// The logo stays; a video area sits UNDER it, before the title. The sources are
// the same ones the hero already supported — an admin-uploaded CMS video (hero
// block, media_kind "video") or the LANDING_HERO_VIDEO_* runtime fallback — so
// dropping a video in later needs no code change. Two decisions are separated
// so the layout never jumps:
//   * `configured`: a source exists → the 16:9 slot (with its poster) is
//     reserved at once;
//   * `play`: the <video> element is attached only after first paint and only
//     when the viewer has not asked for reduced motion / save-data.
// No source → no slot at all (nothing invented, no empty box on the page).
export interface IntroVideo { url: string; poster: string; play: boolean }

export function resolveIntroVideo(input: HeroMediumInput): IntroVideo | null {
  const cmsUrl = String(input.cmsVideoUrl || "").trim();
  const envUrl = String(input.videoUrl || "").trim();
  let url = "", poster = "";
  if (input.mediaKind === "video" && cmsUrl) { url = cmsUrl; poster = String(input.cmsVideoPoster || "").trim(); }
  else if (input.mediaKind !== "image" && Boolean(input.videoEnabled) && envUrl) { url = envUrl; poster = String(input.videoPoster || "").trim(); }
  if (!url) return null;
  const play = Boolean(input.deferred) && !input.prefersReducedMotion && !input.saveData;
  return { url, poster, play };
}
