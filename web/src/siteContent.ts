// ── Site content on the client: ONE loader, published or draft preview ─────
//
// The public site reads /api/site-content (PUBLISHED pages only). When the
// admin opens a preview (#/?cms_preview=1 from the content editor) this tab
// switches to /api/admin/site-content/preview, which the server answers only
// for an authenticated admin and which projects draft ?? published. Preview is
// a per-tab flag: it never changes what any other visitor sees, and if the
// admin request is refused the tab silently shows the published content.
import { useEffect, useState } from "react";
import { productRequest as request, type Json } from "./api";
import { contractFor, normalizePage, type PageContent } from "./content/cmsTemplates";

const PREVIEW_KEY = "siton_cms_preview_v1";
export const CMS_PREVIEW_EVENT = "siton-cms-preview";
export const SITE_CONTENT_UPDATED_EVENT = "site-content-updated";

/** Adopt ?cms_preview=1 from the hash query into this tab's session, once, at boot. */
export function captureCmsPreviewFlag(): void {
  try {
    const query = new URLSearchParams((window.location.hash.split("?")[1] || ""));
    if (query.get("cms_preview") === "1") sessionStorage.setItem(PREVIEW_KEY, "1");
    else if (query.get("cms_preview") === "0") sessionStorage.removeItem(PREVIEW_KEY);
  } catch { /* storage unavailable: no preview */ }
}
export function isCmsPreview(): boolean {
  try { return sessionStorage.getItem(PREVIEW_KEY) === "1"; } catch { return false; }
}
export function exitCmsPreview(): void {
  try { sessionStorage.removeItem(PREVIEW_KEY); } catch { /* noop */ }
  try { window.dispatchEvent(new Event(CMS_PREVIEW_EVENT)); } catch { /* noop */ }
}

export interface SiteContentState { content: Json; loading: boolean; error: boolean; preview: boolean; previewDenied: boolean }

export function useSiteContentState(): SiteContentState {
  const [state, setState] = useState<SiteContentState>({ content: {}, loading: true, error: false, preview: isCmsPreview(), previewDenied: false });
  useEffect(() => {
    let alive = true;
    const load = async () => {
      const preview = isCmsPreview();
      let content: Json | null = null, error = false, previewDenied = false;
      if (preview) {
        try { content = (await request("/api/admin/site-content/preview", {}, "admin")).content || {}; }
        catch { previewDenied = true; }
      }
      if (!content) {
        try { content = (await request("/api/site-content")).content || {}; } catch { error = true; content = null; }
      }
      if (!alive) return;
      setState(prev => ({ content: content || prev.content, loading: false, error, preview: preview && !previewDenied, previewDenied }));
    };
    // a #/?cms_preview=1 link pasted into an already-open tab adopts the flag too
    const onHash = () => { const before = isCmsPreview(); captureCmsPreviewFlag(); if (isCmsPreview() !== before) void load(); };
    void load();
    window.addEventListener(SITE_CONTENT_UPDATED_EVENT, load);
    window.addEventListener(CMS_PREVIEW_EVENT, load);
    window.addEventListener("hashchange", onHash);
    return () => { alive = false; window.removeEventListener(SITE_CONTENT_UPDATED_EVENT, load); window.removeEventListener(CMS_PREVIEW_EVENT, load); window.removeEventListener("hashchange", onHash); };
  }, []);
  return state;
}
export function useSiteContent(): Json { return useSiteContentState().content; }

/** The renderable page for a key — always safe, always complete (defaults fill the gaps). */
export function pageOf(content: Json | null | undefined, key: string): PageContent {
  return normalizePage(content?.[key], contractFor(key));
}
