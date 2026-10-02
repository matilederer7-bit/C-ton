// ── Server-rendered legal documents (/legal/:slug) ───────────────────────────
// Moved verbatim out of src/frontend_runtime.ts (Lean Refactor, 2026-10-02):
// the HTML shell around the CMS legal projection (src/legal_pages.ts) and the
// small escaping / emptiness helpers it uses. The route itself stays in
// frontend_runtime.ts; the only change is that the React build directory
// (`previewDir`, resolved once there at startup) is passed in explicitly.
import { readFile } from "fs/promises";
import { join } from "path";
import { LEGAL_NAV_LABEL_KEYS, resolveLegalPage, type LegalPageSlug } from "./legal_pages.js";
import { htmlAttrs, ts, type Locale } from "./server_i18n.js";

export function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderLegalMarkdown(markdown: string) {
  return markdown
    .split(/\n{2,}/)
    .map((block) => {
      const trimmed = block.trim();
      if (!trimmed) return "";
      // Same block grammar as the in-app ContentPage renderer, which maps EVERY
      // heading level in the body to <h2>: the document title above is the page's
      // only <h1>, so a "# " inside the CMS body must not mint a second one.
      // /legal/refunds and /legal/payments were rendering two and three h1s.
      if (/^#{1,3} /.test(trimmed)) return `<h2>${escapeHtml(trimmed.replace(/^#{1,3} /, ""))}</h2>`;
      // A block made only of "- " lines is a list, never a paragraph of
      // <br>-joined dashes.
      const lines = trimmed.split("\n");
      if (lines.every((line) => line.startsWith("- "))) {
        return `<ul>${lines.map((line) => `<li>${escapeHtml(line.slice(2))}</li>`).join("")}</ul>`;
      }
      return `<p>${escapeHtml(trimmed).replace(/\n/g, "<br>")}</p>`;
    })
    .join("\n");
}

// The server-rendered legal document (linked from the join consent line and
// shared externally) is the SAME site as the React product: identical topbar
// (brand emblem + wordmark + tagline + primary nav), the same legal chip strip,
// the same `.panel.content-doc` document typography, the same footer, the same
// stylesheet. Legal CONTENT is untouched — it stays the CMS projection of
// src/legal_pages.ts; only the chrome around it is aligned.
const LEGAL_HTML_NAV: LegalPageSlug[] = ["terms", "privacy", "refunds", "payments"];

// The server-rendered footer reads the SAME emptiness test as the React footer:
// a CMS document page with a heading and nothing under it must not be linked.
// Both the block shape ({ blocks: [{ fields: { body } }] }) and the legacy flat
// shape ({ body }) are accepted, because the CMS serves both.
export function contentPageHasBody(section: any): boolean {
  const value = section?.value ?? section;
  const block = Array.isArray(value?.blocks) ? value.blocks[0] : null;
  const body = block ? block?.fields?.body : value?.body;
  return String(body || "").replace(/^# [^\n]+\r?\n/, "").trim().length > 0;
}

export async function renderLegalHtmlPage(
  slug: LegalPageSlug,
  override?: { title: string; body: string; bodyLocale?: "he" | "en" },
  aboutHasBody = false,
  locale: Locale = "he",
  previewDir = ""
) {
  // The document BODY is a contract. When no owner-approved English version
  // exists — whether that is the built-in document or the CMS override the
  // owner published — the Hebrew one is served WITH a notice saying so. The
  // shell is translated; the contract is never invented (see legal_pages.ts).
  const resolved = resolveLegalPage(slug, locale);
  const page = { ...resolved.page, ...override };
  const bodyLocale = override ? (override.bodyLocale ?? "he") : resolved.bodyLocale;
  // Same emptiness rule as the React footer (web/src/siteContent.ts#contentPageHasBody):
  // a #/content link whose page has no body is not a link, it is a dead end.
  const aboutLink = aboutHasBody
    ? `<a href="/preview/#/content/about">${escapeHtml(ts(locale, "cms.defaults.footer.link_about"))}</a>`
    : "";
  let stylesheet = "";
  if (previewDir) {
    const index = await readFile(join(previewDir, "index.html"), "utf8");
    stylesheet = index.match(/href="(\/preview\/assets\/[^"<>]+\.css)"/)?.[1] || "";
  }
  const chips = LEGAL_HTML_NAV.map((key) =>
    `<a class="chip${key === slug ? " active" : ""}" href="/legal/${key}"${key === slug ? ' aria-current="page"' : ""}>${escapeHtml(ts(locale, LEGAL_NAV_LABEL_KEYS[key]))}</a>`).join("");
  const fallbackCss = "<style>img{max-width:100%}body{background:#f8fafc;color:#0f172a;font-family:Arial,sans-serif;line-height:1.7;margin:0}a{color:#115e59}.container{max-width:1000px;margin:auto;padding:20px 16px}.panel{padding:24px}.nav-links,.legal-nav,.topbar-inner{display:flex;gap:12px;flex-wrap:wrap;align-items:center}.topbar-inner{padding:12px 16px}.brand{color:inherit;text-decoration:none}.footer{padding:24px 16px;text-align:center}.footer a{margin:0 8px}.lang-switch a{margin:0 6px;font-size:.85rem}</style>";
  // The no-JS shell needs its own language switch: it is a server-rendered
  // page, so the choice travels as ?lang= and is persisted by the app when the
  // visitor returns to it.
  const langSwitch = (["he", "en"] as const).map((code) =>
    `<a class="lang-btn${code === locale ? " active" : ""}" lang="${code}" hreflang="${code}" href="/legal/${slug}?lang=${code}"${code === locale ? ' aria-current="true"' : ""} data-testid="language-switch-${code}">${code === "he" ? "עברית" : "English"}</a>`).join("");
  // The notice is driven by what is ACTUALLY on the page: an English request
  // whose body came back in Hebrew is a declared fallback, whatever produced it.
  const pendingNotice = locale === "en" && bodyLocale === "he"
    ? `<div class="notice info" data-testid="legal-translation-pending" data-translation="OWNER_TRANSLATION_REQUIRED">${escapeHtml(ts(locale, "legal.shell.translation_pending"))}</div>`
    : "";
  return `<!doctype html><html ${htmlAttrs(locale)}><head>
    <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
    <meta name="theme-color" content="#f8fafc">
    <title>C-ton | ${escapeHtml(page.title)}</title>
    <link rel="icon" href="/preview/brand/c-ton-mark-180.png">
    <link rel="alternate" hreflang="he" href="/legal/${slug}?lang=he">
    <link rel="alternate" hreflang="en" href="/legal/${slug}?lang=en">
    ${stylesheet ? '<link rel="stylesheet" href="' + escapeHtml(stylesheet) + '">' : fallbackCss}
  </head><body><div class="app">
    <header class="topbar"><div class="topbar-inner">
      <a class="brand" href="/preview/"><img class="brand-mark-img" src="/preview/brand/c-ton-mark-180.png" alt="" aria-hidden="true" width="38" height="38"><span><img class="brand-word-img" src="/preview/brand/c-ton-wordmark.png" alt="C-ton" width="85" height="22"><div class="brand-sub">${escapeHtml(ts(locale, "app.buying_together_paying_less"))}</div></span></a>
      <nav class="nav-links" aria-label="${escapeHtml(ts(locale, "app.main_navigation"))}"><a class="nav-link" href="/preview/#/seller">${escapeHtml(ts(locale, "app.sellers_area"))}</a></nav>
      <div class="lang-switch" role="group" aria-label="${escapeHtml(ts(locale, "i18n.switch_label"))}" data-testid="language-switch">${langSwitch}</div>
    </div></header>
    <main class="container">
      <nav class="legal-nav" aria-label="${escapeHtml(ts(locale, "legal.shell.nav_label"))}">${chips}</nav>
      <!-- The notices are the SHELL speaking, in the page's language; the
           article below is the document, in the language it was written in.
           They must not share a direction, or English notices come out
           right-aligned with their full stops on the wrong side. -->
      <div class="legal-notices"><div class="notice info">${escapeHtml(ts(locale, "legal.shell.version_notice"))}</div>${pendingNotice}</div>
      <article class="panel content-doc" data-section="legal_${slug}" lang="${bodyLocale}" dir="${bodyLocale === "he" ? "rtl" : "ltr"}"><h1>${escapeHtml(page.title)}</h1>${renderLegalMarkdown(page.body.replace(/^# [^\n]+\r?\n/, ""))}</article>
    </main>
    <footer class="footer"><div><a href="/preview/#/support">${escapeHtml(ts(locale, "cms.defaults.footer.link_support"))}</a>${aboutLink}<a href="/legal/terms">${escapeHtml(ts(locale, "cms.defaults.footer.link_terms"))}</a><a href="/legal/privacy">${escapeHtml(ts(locale, "cms.defaults.footer.link_privacy"))}</a><a href="/legal/refunds">${escapeHtml(ts(locale, "cms.defaults.footer.link_refunds"))}</a></div><div style="margin-top:8px">${escapeHtml(ts(locale, "cms.defaults.footer.text"))}</div></footer>
  </div></body></html>`;
}
