// ── Siton CMS template library — the ONE schema for site content ────────────
//
// THE SITE DESIGN IS FIXED. THE CONTENT IS EDITABLE THROUGH TEMPLATES.
//
// A page is an ordered list of blocks. Every block has a stable id, a template
// type from this library, an enabled flag and typed string fields (plus an
// ordered list of child items for repeatable templates such as FAQ / steps).
// This module is PURE (no DOM, no React, no database) and is imported by:
//   * the backend validator (src/site_content.ts) — strict validation before
//     anything is stored, draft or published;
//   * the admin editor (web/src/pages/contentAdmin.tsx) — builds its forms from
//     these definitions and pre-validates with the same rules;
//   * the public renderers (landing, footer, content pages) — lenient
//     normalization so malformed or partial content can never blank a page.
// Nothing here accepts raw HTML, scripts, executable URLs or arbitrary CSS:
// every value is plain text, an internal route, an https link or a reference
// to an admin-uploaded asset on this origin.

import { LANDING_HE } from "./landing.he.js";
import { LANDING_EN } from "./landing.en.js";
import { AFTER_TAP_LINE_KEY, DEAL_EXPLAINER_KEY, HOW_IT_WORKS_KEYS, SHARE_LOOP_TITLE_KEY, WHY_GROUP_PRICE_KEY } from "../buyerCopy.js";
import { SELLER_AREA_HE } from "./seller.he.js";
import { SELLER_AREA_EN } from "./seller.en.js";
import { translateIn } from "../i18n/translate.js";

export type FieldKind = "text" | "multiline" | "image" | "video" | "link" | "select";
export interface FieldDef {
  label: string;
  kind: FieldKind;
  max: number;
  required?: boolean;
  hint?: string;
  rows?: number;
  options?: { value: string; label: string }[];
  default?: string;
  /** editor-only: show this field when another field of the block has the given value */
  showWhen?: { field: string; value: string };
}
export interface ItemsDef { label: string; addLabel: string; min: number; max: number; fields: Record<string, FieldDef> }
export interface TemplateDef { name: string; description: string; fields: Record<string, FieldDef>; items?: ItemsDef }

export type TemplateId = "hero" | "text" | "image_text" | "cta" | "steps" | "faq" | "columns" | "about" | "legal" | "footer" | "deal_copy" | "track_copy" | "seller_copy" | "support_copy";

export interface Block {
  id: string;
  type: TemplateId;
  enabled: boolean;
  /** Hebrew — the canonical content. Always present. */
  fields: Record<string, string>;
  items?: Record<string, string>[];
  /**
   * English — the SAME block, in the other language. Optional per field: a
   * blank or absent value falls back to the Hebrew one, and the fallback is
   * reported (`missingEnglishContent`) rather than silently passed off as a
   * translation. Siton owns this content, so it is structured for both
   * languages even while only one of them is written.
   */
  fields_en?: Record<string, string>;
  items_en?: Record<string, string>[];
}

/** The languages a CMS block can carry. Hebrew is canonical and mandatory. */
export type ContentLocale = "he" | "en";
export interface PageContent { blocks: Block[] }

export interface LockedBlock { id: string; type: TemplateId }
export interface PageContract {
  label: string;
  description: string;
  /** structural blocks: always present, first, enabled, never removable */
  locked: LockedBlock[];
  /** templates the admin may add to this page (empty = fixed composition) */
  addable: TemplateId[];
  maxBlocks: number;
  /** legacy flat field → (block id, field) mapping, for content stored before the block model */
  legacy: Record<string, [string, string]>;
  defaults: () => Block[];
}

export const CMS_LIMITS = { blockIdPattern: /^[a-z][a-z0-9_]{0,39}$/, maxBlocksAbsolute: 40 } as const;

const LINK_HINT = "cms.link_hint.text";
const link = (label: string, required = false): FieldDef => ({ label, kind: "link", max: 300, required, hint: LINK_HINT });
const text = (label: string, max: number, required = false, hint?: string): FieldDef => ({ label, kind: "text", max, required, ...(hint ? { hint } : {}) });
const multiline = (label: string, max: number, required = false, rows = 4, hint?: string): FieldDef => ({ label, kind: "multiline", max, required, rows, ...(hint ? { hint } : {}) });
const image = (label: string): FieldDef => ({ label, kind: "image", max: 100 });

export const TEMPLATES: Record<TemplateId, TemplateDef> = {
  hero: {
    name: "cms.templates.hero.name",
    description: "cms.templates.hero.description",
    fields: {
      title: text("cms.templates.hero.fields.title.label", 120, true),
      subtitle: multiline("cms.templates.hero.fields.subtitle.label", 1000, false, 3),
      body: multiline("cms.templates.hero.fields.body.label", 1000, false, 2),
      media_kind: { label: "cms.templates.hero.fields.media_kind.label", kind: "select", max: 10, default: "image", options: [{ value: "image", label: "cms.templates.hero.fields.media_kind.options.label" }, { value: "video", label: "cms.templates.hero.fields.media_kind.options.label_2" }], hint: "cms.templates.hero.fields.media_kind.hint" },
      image: { ...image("cms.templates.hero.fields.image.label"), showWhen: { field: "media_kind", value: "image" } },
      video: { label: "cms.templates.hero.fields.video.label", kind: "video", max: 100, showWhen: { field: "media_kind", value: "video" } },
      video_poster: { ...image("cms.templates.hero.fields.video_poster.label"), showWhen: { field: "media_kind", value: "video" } },
      primary_cta_label: text("cms.templates.hero.fields.primary_cta_label.label", 60),
      primary_cta_link: link("cms.templates.hero.fields.primary_cta_link.label"),
      secondary_cta_label: text("cms.templates.hero.fields.secondary_cta_label.label", 60),
      secondary_cta_link: link("cms.templates.hero.fields.secondary_cta_link.label"),
      buyer_entry_title: text("cms.templates.hero.fields.buyer_entry_title.label", 120),
      buyer_entry_body: multiline("cms.templates.hero.fields.buyer_entry_body.label", 600, false, 2)
    }
  },
  text: {
    name: "cms.templates.text.name",
    description: "cms.templates.text.description",
    fields: { title: text("cms.templates.text.fields.title.label", 160), body: multiline("cms.templates.text.fields.body.label", 5000, false, 5) }
  },
  image_text: {
    name: "cms.templates.image_text.name",
    description: "cms.templates.image_text.description",
    fields: {
      title: text("cms.templates.image_text.fields.title.label", 160), body: multiline("cms.templates.image_text.fields.body.label", 5000, false, 5), image: image("cms.templates.image_text.fields.image.label"),
      image_position: { label: "cms.templates.image_text.fields.image_position.label", kind: "select", max: 10, default: "start", options: [{ value: "start", label: "cms.templates.image_text.fields.image_position.options.label" }, { value: "end", label: "cms.templates.image_text.fields.image_position.options.label_2" }] }
    }
  },
  cta: {
    name: "cms.templates.cta.name",
    description: "cms.templates.cta.description",
    fields: { title: text("cms.templates.cta.fields.title.label", 160, true), body: multiline("cms.templates.cta.fields.body.label", 1000, false, 2), button_label: text("cms.templates.cta.fields.button_label.label", 60), button_link: link("cms.templates.cta.fields.button_link.label") }
  },
  steps: {
    name: "cms.templates.steps.name",
    description: "cms.templates.steps.description",
    fields: { title: text("cms.templates.steps.fields.title.label", 160) },
    items: { label: "cms.templates.steps.items.label", addLabel: "cms.templates.steps.items.add_label", min: 1, max: 8, fields: { title: text("cms.templates.steps.items.fields.title.label", 120, true), body: multiline("cms.templates.steps.items.fields.body.label", 600, false, 2) } }
  },
  faq: {
    name: "cms.templates.faq.name",
    description: "cms.templates.faq.description",
    fields: { title: text("cms.templates.faq.fields.title.label", 160) },
    items: { label: "cms.templates.faq.items.label", addLabel: "cms.templates.faq.items.add_label", min: 1, max: 40, fields: { q: text("cms.templates.faq.items.fields.q.label", 300, true), a: multiline("cms.templates.faq.items.fields.a.label", 2000, true, 3) } }
  },
  columns: {
    name: "cms.templates.columns.name",
    description: "cms.templates.columns.description",
    fields: { title: text("cms.templates.columns.fields.title.label", 160) },
    items: { label: "cms.templates.columns.items.label", addLabel: "cms.templates.columns.items.add_label", min: 1, max: 3, fields: { title: text("cms.templates.columns.items.fields.title.label", 120, true), body: multiline("cms.templates.columns.items.fields.body.label", 1200, false, 4), cta_label: text("cms.templates.columns.items.fields.cta_label.label", 60), cta_link: link("cms.templates.columns.items.fields.cta_link.label") } }
  },
  about: {
    name: "cms.templates.about.name",
    description: "cms.templates.about.description",
    fields: { title: text("cms.templates.about.fields.title.label", 160, true), body: multiline("cms.templates.about.fields.body.label", 10000, false, 12), image: image("cms.templates.about.fields.image.label") }
  },
  legal: {
    name: "cms.templates.legal.name",
    description: "cms.templates.legal.description",
    fields: { title: text("cms.templates.legal.fields.title.label", 160, true), body: multiline("cms.templates.legal.fields.body.label", 60000, true, 18) }
  },
  footer: {
    name: "cms.templates.footer.name",
    description: "cms.templates.footer.description",
    fields: { text: multiline("cms.templates.footer.fields.text.label", 500, false, 2) },
    items: { label: "cms.templates.footer.items.label", addLabel: "cms.templates.footer.items.add_label", min: 0, max: 8, fields: { label: text("cms.templates.footer.items.fields.label", 60, true), link: link("cms.templates.footer.items.fields.link.label", true) } }
  },
  // ── Fixed product copy ────────────────────────────────────────────────────
  // These templates hold the recurring sentences the product itself speaks on
  // every deal, tracking and seller screen. They are named slots (not a free
  // composition) because the code reads each one by name; the admin edits the
  // wording, never the structure. Every sentence must stay TRUE of canonical
  // behaviour — the hints say so where money wording is involved.
  deal_copy: {
    name: "cms.templates.deal_copy.name",
    description: "cms.templates.deal_copy.description",
    fields: {
      explainer: multiline("cms.templates.deal_copy.fields.explainer.label", 400, true, 2, "cms.templates.deal_copy.fields.explainer.hint"),
      why_group_price: multiline("cms.templates.deal_copy.fields.why_group_price.label", 300, true, 2),
      after_tap: multiline("cms.templates.deal_copy.fields.after_tap.label", 300, true, 2, "cms.templates.deal_copy.fields.after_tap.hint"),
      hold_notice: multiline("cms.templates.deal_copy.fields.hold_notice.label", 300, true, 2, "cms.templates.deal_copy.fields.hold_notice.hint"),
      share_title: text("cms.templates.deal_copy.fields.share_title.label", 120, true, "cms.templates.deal_copy.fields.share_title.hint")
    }
  },
  track_copy: {
    name: "cms.templates.track_copy.name",
    description: "cms.templates.track_copy.description",
    fields: {
      hold_note: multiline("cms.templates.track_copy.fields.hold_note.label", 400, true, 3, "cms.templates.track_copy.fields.hold_note.hint"),
      return_title: text("cms.templates.track_copy.fields.return_title.label", 120, true),
      no_access_title: text("cms.templates.track_copy.fields.no_access_title.label", 120, true, "cms.templates.track_copy.fields.no_access_title.hint"),
      network_title: text("cms.templates.track_copy.fields.network_title.label", 120, true),
      busy_title: text("cms.templates.track_copy.fields.busy_title.label", 120, true)
    }
  },
  seller_copy: {
    name: "cms.templates.seller_copy.name",
    description: "cms.templates.seller_copy.description",
    fields: {
      empty_title: text("cms.templates.seller_copy.fields.empty_title.label", 120, true),
      empty_body: multiline("cms.templates.seller_copy.fields.empty_body.label", 300, false, 2),
      empty_cta: text("cms.templates.seller_copy.fields.empty_cta.label", 60, true),
      journey_title: text("cms.templates.seller_copy.fields.journey_title.label", 120, true),
      pending_title: text("cms.templates.seller_copy.fields.pending_title.label", 160, true),
      pending_body: multiline("cms.templates.seller_copy.fields.pending_body.label", 600, false, 3),
      rejected_title: text("cms.templates.seller_copy.fields.rejected_title.label", 160, true),
      rejected_body: multiline("cms.templates.seller_copy.fields.rejected_body.label", 400, false, 2, "cms.templates.seller_copy.fields.rejected_body.hint"),
      profile_incomplete_title: text("cms.templates.seller_copy.fields.profile_incomplete_title.label", 160, true)
    }
  },
  support_copy: {
    name: "cms.templates.support_copy.name",
    description: "cms.templates.support_copy.description",
    fields: {
      title: text("cms.templates.support_copy.fields.title.label", 120, true),
      intro: multiline("cms.templates.support_copy.fields.intro.label", 500, false, 3, "cms.templates.support_copy.fields.intro.hint"),
      sent_title: text("cms.templates.support_copy.fields.sent_title.label", 120, true),
      sent_body: multiline("cms.templates.support_copy.fields.sent_body.label", 400, false, 2)
    }
  }
};

// ── Safety rules (identical on server and client) ───────────────────────────
// Plain text only: no tags, no control characters. Links are internal hash
// routes, same-origin paths or https. Assets are this origin's content-asset URLs.
export const HTML_LIKE = /<\s*\/?[a-z!]/i;
export const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;
export const ASSET_URL = /^\/api\/content-assets\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// same-origin paths must not be protocol-relative (`//host`) — that would leave the site
export const SAFE_LINK = /^(?:#\/[A-Za-z0-9_\-/?=&.%]*|\/(?!\/)[A-Za-z0-9_\-/?=&.%]*|https:\/\/[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+)$/;

export function safeText(value: string): boolean { return !HTML_LIKE.test(value) && !CONTROL_CHARS.test(value); }
export function safeLink(value: string): boolean { return value === "" || (value.length <= 300 && SAFE_LINK.test(value) && !/[\s<>"']/.test(value)); }

export class CmsValidationError extends Error {
  code: string; path: string;
  constructor(code: string, path = "") { super(path ? `${code} at ${path}` : code); this.code = code; this.path = path; }
}
function fail(code: string, path = ""): never { throw new CmsValidationError(code, path); }

// ── Default page compositions (the canonical fallback content) ──────────────
// Every default is built in BOTH languages: `fields` is the canonical Hebrew,
// `fields_en` is the English sibling. The two come from the same translation
// key, so a default can never drift between the languages, and a key with no
// English value falls back to Hebrew through `localizedValue` and is reported
// by `missingEnglishContent`.
const he = (key: string): string => translateIn("he", key);
const en = (key: string): string => translateIn("en", key);

const HERO_DEFAULT = (): Block => ({
  id: "hero", type: "hero", enabled: true,
  fields: {
    title: LANDING_HE.hero.title, subtitle: LANDING_HE.hero.sub, body: LANDING_HE.hero.note,
    media_kind: "image", image: "", video: "", video_poster: "",
    primary_cta_label: he("cms.defaults.home.seller_login"), primary_cta_link: "#/seller",
    secondary_cta_label: he("cms.defaults.home.seller_signup"), secondary_cta_link: "#/seller?signup=1",
    buyer_entry_title: LANDING_HE.buyerEntry.title, buyer_entry_body: LANDING_HE.buyerEntry.body
  },
  fields_en: {
    title: LANDING_EN.hero.title, subtitle: LANDING_EN.hero.sub, body: LANDING_EN.hero.note,
    media_kind: "", image: "", video: "", video_poster: "",
    primary_cta_label: en("cms.defaults.home.seller_login"), primary_cta_link: "",
    secondary_cta_label: en("cms.defaults.home.seller_signup"), secondary_cta_link: "",
    buyer_entry_title: LANDING_EN.buyerEntry.title, buyer_entry_body: LANDING_EN.buyerEntry.body
  }
});

export const FOOTER_DEFAULT_TEXT_KEY = "cms.defaults.footer.text";
export const FOOTER_DEFAULT_LINKS: { labelKey: string; link: string }[] = [
  { labelKey: "cms.defaults.footer.link_support", link: "#/support" },
  { labelKey: "cms.defaults.footer.link_about", link: "#/content/about" },
  { labelKey: "cms.defaults.footer.link_terms", link: "#/content/legal_terms" },
  { labelKey: "cms.defaults.footer.link_privacy", link: "#/content/legal_privacy" },
  { labelKey: "cms.defaults.footer.link_refunds", link: "#/content/legal_refunds" }
];

export const PAGE_CONTRACTS: Record<string, PageContract> = {
  home: {
    label: "cms.page_contracts.home.label",
    description: "cms.page_contracts.home.description",
    locked: [{ id: "hero", type: "hero" }],
    addable: ["text", "image_text", "cta", "steps", "faq", "columns"],
    maxBlocks: 20,
    legacy: { title: ["hero", "title"], sub: ["hero", "subtitle"], intro: ["hero", "body"], image: ["hero", "image"], login_cta: ["hero", "primary_cta_label"], signup_cta: ["hero", "secondary_cta_label"] },
    defaults: () => [
      HERO_DEFAULT(),
      { id: "how", type: "steps", enabled: true,
        fields: { title: LANDING_HE.howItWorks.title }, items: LANDING_HE.howItWorks.steps.map(s => ({ title: s.title, body: s.body })),
        fields_en: { title: LANDING_EN.howItWorks.title }, items_en: LANDING_EN.howItWorks.steps.map(s => ({ title: s.title, body: s.body })) },
      { id: "why", type: "text", enabled: false,
        fields: { title: LANDING_HE.whyGroupBuying.title, body: LANDING_HE.whyGroupBuying.body },
        fields_en: { title: LANDING_EN.whyGroupBuying.title, body: LANDING_EN.whyGroupBuying.body } },
      { id: "audiences", type: "columns", enabled: true, fields: { title: "" }, fields_en: { title: "" }, items: [
        { title: LANDING_HE.forBuyers.title, body: LANDING_HE.forBuyers.body, cta_label: "", cta_link: "" },
        { title: LANDING_HE.forSellers.title, body: LANDING_HE.forSellers.body, cta_label: he("cms.defaults.home.seller_signup"), cta_link: "#/seller?signup=1" }
      ], items_en: [
        { title: LANDING_EN.forBuyers.title, body: LANDING_EN.forBuyers.body, cta_label: "", cta_link: "" },
        { title: LANDING_EN.forSellers.title, body: LANDING_EN.forSellers.body, cta_label: en("cms.defaults.home.seller_signup"), cta_link: "" }
      ] },
      { id: "trust", type: "text", enabled: true,
        fields: { title: LANDING_HE.trust.title, body: LANDING_HE.trust.body },
        fields_en: { title: LANDING_EN.trust.title, body: LANDING_EN.trust.body } },
      { id: "about", type: "text", enabled: false,
        fields: { title: LANDING_HE.about.title, body: LANDING_HE.about.body },
        fields_en: { title: LANDING_EN.about.title, body: LANDING_EN.about.body } },
      { id: "faq", type: "faq", enabled: true,
        fields: { title: LANDING_HE.faq.title }, items: LANDING_HE.faq.items.map(i => ({ q: i.q, a: i.a })),
        fields_en: { title: LANDING_EN.faq.title }, items_en: LANDING_EN.faq.items.map(i => ({ q: i.q, a: i.a })) },
      { id: "contact", type: "cta", enabled: true,
        fields: { title: he("cms.defaults.home.contact_title"), body: he("cms.defaults.home.contact_body"), button_label: he("cms.defaults.footer.link_support"), button_link: "#/support" },
        fields_en: { title: en("cms.defaults.home.contact_title"), body: en("cms.defaults.home.contact_body"), button_label: en("cms.defaults.footer.link_support"), button_link: "" } }
    ]
  },
  about: {
    label: "cms.page_contracts.about.label",
    description: "cms.page_contracts.about.description",
    locked: [{ id: "about", type: "about" }], addable: [], maxBlocks: 1,
    legacy: { title: ["about", "title"], body: ["about", "body"] },
    defaults: () => [{ id: "about", type: "about", enabled: true,
      fields: { title: he("cms.defaults.about.title"), body: LANDING_HE.about.body, image: "" },
      fields_en: { title: en("cms.defaults.about.title"), body: LANDING_EN.about.body, image: "" } }]
  },
  footer: {
    label: "cms.page_contracts.footer.label",
    description: "cms.page_contracts.footer.description",
    locked: [{ id: "footer", type: "footer" }], addable: [], maxBlocks: 1,
    legacy: { text: ["footer", "text"] },
    defaults: () => [{ id: "footer", type: "footer", enabled: true,
      fields: { text: he(FOOTER_DEFAULT_TEXT_KEY) }, items: FOOTER_DEFAULT_LINKS.map(l => ({ label: he(l.labelKey), link: l.link })),
      fields_en: { text: en(FOOTER_DEFAULT_TEXT_KEY) }, items_en: FOOTER_DEFAULT_LINKS.map(l => ({ label: en(l.labelKey), link: "" })) }]
  },
  // ── Product pages: fixed composition, editable wording ────────────────────
  // The deal, tracking, seller and support screens are product surfaces, not
  // free-form pages: their blocks are locked so no admin edit can remove a
  // sentence the flow depends on, and nothing can be added. The admin edits the
  // wording and the how-it-works steps; the layout and the data stay canonical.
  deal_page: {
    label: "cms.page_contracts.deal_page.label",
    description: "cms.page_contracts.deal_page.description",
    locked: [{ id: "deal", type: "deal_copy" }, { id: "how", type: "steps" }, { id: "track", type: "track_copy" }],
    addable: [], maxBlocks: 3,
    legacy: {},
    defaults: (): Block[] => [
      { id: "deal", type: "deal_copy", enabled: true,
        fields: {
          explainer: he(DEAL_EXPLAINER_KEY), why_group_price: he(WHY_GROUP_PRICE_KEY), after_tap: he(AFTER_TAP_LINE_KEY),
          hold_notice: he("cms.defaults.deal.hold_notice"), share_title: he(SHARE_LOOP_TITLE_KEY) },
        fields_en: {
          explainer: en(DEAL_EXPLAINER_KEY), why_group_price: en(WHY_GROUP_PRICE_KEY), after_tap: en(AFTER_TAP_LINE_KEY),
          hold_notice: en("cms.defaults.deal.hold_notice"), share_title: en(SHARE_LOOP_TITLE_KEY) } },
      { id: "how", type: "steps", enabled: true,
        fields: { title: he("cms.defaults.deal.how_title") }, items: HOW_IT_WORKS_KEYS.map(s => ({ title: he(s.title), body: he(s.body) })),
        fields_en: { title: en("cms.defaults.deal.how_title") }, items_en: HOW_IT_WORKS_KEYS.map(s => ({ title: en(s.title), body: en(s.body) })) },
      { id: "track", type: "track_copy", enabled: true,
        fields: {
          hold_note: he("cms.defaults.track.hold_note"), return_title: he("cms.defaults.track.return_title"),
          no_access_title: he("cms.defaults.track.no_access_title"), network_title: he("cms.defaults.track.network_title"), busy_title: he("cms.defaults.track.busy_title") },
        fields_en: {
          hold_note: en("cms.defaults.track.hold_note"), return_title: en("cms.defaults.track.return_title"),
          no_access_title: en("cms.defaults.track.no_access_title"), network_title: en("cms.defaults.track.network_title"), busy_title: en("cms.defaults.track.busy_title") } }
    ]
  },
  seller_area: {
    label: "cms.page_contracts.seller_area.label",
    description: "cms.page_contracts.seller_area.description",
    locked: [{ id: "seller", type: "seller_copy" }], addable: [], maxBlocks: 1,
    legacy: {},
    defaults: (): Block[] => [{ id: "seller", type: "seller_copy", enabled: true, fields: { ...SELLER_AREA_HE }, fields_en: { ...SELLER_AREA_EN } }]
  },
  support_page: {
    label: "cms.page_contracts.support_page.label",
    description: "cms.page_contracts.support_page.description",
    locked: [{ id: "support", type: "support_copy" }], addable: [], maxBlocks: 1,
    legacy: {},
    defaults: (): Block[] => [{ id: "support", type: "support_copy", enabled: true,
      fields: {
        title: he("cms.defaults.support.title"), intro: he("cms.defaults.support.intro"),
        sent_title: he("cms.defaults.support.sent_title"), sent_body: he("cms.defaults.support.sent_body") },
      fields_en: {
        title: en("cms.defaults.support.title"), intro: en("cms.defaults.support.intro"),
        sent_title: en("cms.defaults.support.sent_title"), sent_body: en("cms.defaults.support.sent_body") } }]
  }
};

/** A legal document page contract — the backend registers one per legal slug. */
export function legalPageContract(label: string, defaults: { title: string; body: string }): PageContract {
  return {
    label, description: "cms.legal_document_description",
    locked: [{ id: "document", type: "legal" }], addable: [], maxBlocks: 1,
    legacy: { title: ["document", "title"], body: ["document", "body"] },
    defaults: () => [{ id: "document", type: "legal", enabled: true, fields: { title: defaults.title, body: defaults.body } }]
  };
}

/** Best-effort contract for a key the client does not know (e.g. legal pages, whose defaults live server-side). */
export function genericContract(key: string): PageContract {
  const type: TemplateId = key.startsWith("legal_") ? "legal" : "about";
  return { label: key, description: "", locked: [{ id: type === "legal" ? "document" : "about", type }], addable: [], maxBlocks: 1,
    legacy: { title: [type === "legal" ? "document" : "about", "title"], body: [type === "legal" ? "document" : "about", "body"] }, defaults: () => [] };
}

export function contractFor(key: string): PageContract { return has(PAGE_CONTRACTS, key) ? PAGE_CONTRACTS[key]! : genericContract(key); }

// ── Helpers ─────────────────────────────────────────────────────────────────
export function emptyBlock(type: TemplateId, id: string): Block {
  const t = TEMPLATES[type];
  const fields = Object.fromEntries(Object.entries(t.fields).map(([k, f]) => [k, f.default ?? ""]));
  const block: Block = { id, type, enabled: true, fields };
  if (t.items) block.items = Array.from({ length: t.items.min }, () => emptyItem(type));
  return block;
}
export function emptyItem(type: TemplateId): Record<string, string> {
  const items = TEMPLATES[type].items;
  return items ? Object.fromEntries(Object.keys(items.fields).map(k => [k, ""])) : {};
}
export function newBlockId(type: TemplateId, existing: Block[]): string {
  const taken = new Set(existing.map(b => b.id));
  for (let n = 1; n < 1000; n++) { const id = `${type}_${n}`; if (!taken.has(id)) return id; }
  return `${type}_${Date.now().toString(36)}`;
}
export function blockOf(page: PageContent | null | undefined, id: string): Block | undefined { return page?.blocks.find(b => b.id === id); }
export function enabledBlocks(page: PageContent | null | undefined): Block[] { return (page?.blocks || []).filter(b => b.enabled); }

function isRecord(v: unknown): v is Record<string, unknown> { return !!v && typeof v === "object" && !Array.isArray(v); }
const has = (obj: object, key: string): boolean => Object.prototype.hasOwnProperty.call(obj, key);

/** Convert content stored before the block model ({title, sub, ...}) into blocks. */
export function legacyToBlocks(flat: Record<string, unknown>, contract: PageContract): Block[] {
  const blocks = contract.defaults();
  const byId = new Map(blocks.map(b => [b.id, b]));
  for (const [key, [blockId, field]] of Object.entries(contract.legacy)) {
    if (typeof flat[key] !== "string") continue;
    let block = byId.get(blockId);
    if (!block) { const locked = contract.locked.find(l => l.id === blockId); if (!locked) continue; block = emptyBlock(locked.type, blockId); blocks.unshift(block); byId.set(blockId, block); }
    block.fields[field] = flat[key] as string;
  }
  return blocks;
}

function cleanString(value: unknown, def: FieldDef): string {
  if (typeof value !== "string") return def.default ?? "";
  if (!safeText(value)) return def.default ?? "";
  const text = value.length > def.max ? value.slice(0, def.max) : value;
  if (def.kind === "link") return safeLink(text) ? text : "";
  if (def.kind === "image" || def.kind === "video") return ASSET_URL.test(text) ? text : "";
  if (def.kind === "select") return def.options?.some(o => o.value === text) ? text : (def.default ?? "");
  return text;
}
function normalizeBlock(raw: unknown, contract: PageContract, expectedType?: TemplateId): Block | null {
  if (!isRecord(raw)) return null;
  const type = String(raw.type || expectedType || "") as TemplateId;
  if (!has(TEMPLATES, type) || (expectedType && type !== expectedType)) return null;
  const id = String(raw.id || "");
  if (!CMS_LIMITS.blockIdPattern.test(id)) return null;
  const t = TEMPLATES[type];
  const rawFields = isRecord(raw.fields) ? raw.fields : {};
  const fields = Object.fromEntries(Object.entries(t.fields).map(([k, f]) => [k, cleanString(rawFields[k], f)]));
  const block: Block = { id, type, enabled: raw.enabled !== false, fields };
  if (isRecord(raw.fields_en)) {
    const rawEn = raw.fields_en;
    // English is optional per field: an empty value means "not translated yet"
    // and must stay empty so the renderer can fall back and report it.
    block.fields_en = Object.fromEntries(Object.entries(t.fields).map(([k, f]) => [k, typeof rawEn[k] === "string" ? cleanString(rawEn[k], { ...f, default: "" }) : ""]));
  }
  if (t.items) {
    const list = Array.isArray(raw.items) ? raw.items : [];
    block.items = list.filter(isRecord).slice(0, t.items.max).map(item => Object.fromEntries(Object.entries(t.items!.fields).map(([k, f]) => [k, cleanString(item[k], f)])))
      .filter(item => Object.entries(t.items!.fields).every(([k, f]) => !f.required || item[k]!.trim()));
    if (Array.isArray(raw.items_en)) {
      block.items_en = raw.items_en.filter(isRecord).slice(0, block.items.length)
        .map(item => Object.fromEntries(Object.entries(t.items!.fields).map(([k, f]) => [k, typeof item[k] === "string" ? cleanString(item[k], { ...f, default: "" }) : ""])));
    }
  }
  return block;
}

/**
 * Lenient normalization for RENDERING. Always returns a renderable page:
 * unknown blocks/fields are dropped, unsafe values are blanked, locked blocks
 * are restored from the defaults and pinned first, legacy flat content is
 * converted. Never throws.
 */
export function normalizePage(raw: unknown, contract: PageContract): PageContent {
  let source: unknown[] | null = null;
  if (isRecord(raw) && Array.isArray(raw.blocks)) source = raw.blocks;
  else if (isRecord(raw) && Object.keys(contract.legacy).some(k => typeof raw[k] === "string")) source = legacyToBlocks(raw, contract);
  if (!source) return { blocks: contract.defaults() };
  const seen = new Set<string>();
  const blocks: Block[] = [];
  for (const item of source) {
    const block = normalizeBlock(item, contract);
    if (!block || seen.has(block.id)) continue;
    const locked = contract.locked.find(l => l.id === block.id);
    if (locked && locked.type !== block.type) continue;
    if (!locked && !contract.addable.includes(block.type)) continue;
    seen.add(block.id); blocks.push(block);
    if (blocks.length >= Math.min(contract.maxBlocks, CMS_LIMITS.maxBlocksAbsolute)) break;
  }
  const defaults = contract.defaults();
  const lockedBlocks = contract.locked.map(l => {
    const found = blocks.find(b => b.id === l.id) || defaults.find(b => b.id === l.id) || emptyBlock(l.type, l.id);
    return { ...found, enabled: true };
  });
  const rest = blocks.filter(b => !contract.locked.some(l => l.id === b.id));
  return { blocks: [...lockedBlocks, ...rest] };
}

/**
 * STRICT validation before STORING (draft or publish). Throws CmsValidationError
 * with a stable code and a field path. Accepts the legacy flat shape for
 * backward compatibility and returns the canonical block page.
 */
export function validatePage(raw: unknown, contract: PageContract): PageContent {
  if (!isRecord(raw)) fail("invalid_content");
  let source: unknown;
  if (Array.isArray(raw.blocks)) {
    if (Object.keys(raw).some(k => k !== "blocks")) fail("invalid_content_field");
    source = raw.blocks;
  } else {
    if (Object.keys(raw).some(k => !has(contract.legacy, k))) fail("invalid_content_field");
    source = legacyToBlocks(raw, contract);
  }
  const list = source as unknown[];
  if (list.length > Math.min(contract.maxBlocks, CMS_LIMITS.maxBlocksAbsolute)) fail("too_many_blocks");
  const ids = new Set<string>();
  const blocks: Block[] = [];
  list.forEach((item, index) => {
    const path = `blocks[${index}]`;
    if (!isRecord(item)) fail("invalid_block", path);
    const id = item.id;
    if (typeof id !== "string" || !CMS_LIMITS.blockIdPattern.test(id)) fail("invalid_block_id", path);
    if (ids.has(id)) fail("duplicate_block_id", path);
    ids.add(id);
    const type = item.type;
    if (typeof type !== "string" || !has(TEMPLATES, type)) fail("unknown_template", path);
    const locked = contract.locked.find(l => l.id === id);
    if (locked ? locked.type !== type : !contract.addable.includes(type as TemplateId)) fail("template_not_allowed", path);
    if (typeof item.enabled !== "boolean") fail("invalid_block_enabled", path);
    if (locked && !item.enabled) fail("locked_block_disabled", path);
    const t = TEMPLATES[type as TemplateId];
    const rawFields = item.fields;
    if (!isRecord(rawFields)) fail("invalid_block_fields", path);
    if (Object.keys(rawFields).some(k => !has(t.fields, k))) fail("invalid_content_field", path);
    const fields: Record<string, string> = {};
    for (const [k, def] of Object.entries(t.fields)) fields[k] = validateField(rawFields[k], def, `${path}.${k}`, item.enabled);
    const block: Block = { id, type: type as TemplateId, enabled: item.enabled, fields };
    // English carries the same safety rules (no HTML, same length ceiling,
    // same asset/link shapes) but is never REQUIRED: a blank English value is
    // a declared, reported fallback to Hebrew, not a validation failure.
    if (item.fields_en !== undefined) {
      const rawEn = item.fields_en;
      if (!isRecord(rawEn)) fail("invalid_block_fields", `${path}.fields_en`);
      if (Object.keys(rawEn).some(k => !has(t.fields, k))) fail("invalid_content_field", `${path}.fields_en`);
      const fieldsEn: Record<string, string> = {};
      for (const [k, def] of Object.entries(t.fields)) fieldsEn[k] = validateField(rawEn[k], { ...def, required: false, default: "" }, `${path}.fields_en.${k}`, false);
      block.fields_en = fieldsEn;
    }
    if (t.items) {
      const rawItems = item.items;
      if (!Array.isArray(rawItems)) fail("invalid_block_items", path);
      if (rawItems.length > t.items.max) fail("too_many_items", path);
      if (item.enabled && rawItems.length < t.items.min) fail("too_few_items", path);
      block.items = rawItems.map((raw, i) => {
        const ipath = `${path}.items[${i}]`;
        if (!isRecord(raw)) fail("invalid_item", ipath);
        if (Object.keys(raw).some(k => !has(t.items!.fields, k))) fail("invalid_content_field", ipath);
        return Object.fromEntries(Object.entries(t.items!.fields).map(([k, def]) => [k, validateField(raw[k], def, `${ipath}.${k}`, item.enabled as boolean)]));
      });
      if (item.items_en !== undefined) {
        const rawItemsEn = item.items_en;
        if (!Array.isArray(rawItemsEn)) fail("invalid_block_items", `${path}.items_en`);
        if (rawItemsEn.length > block.items.length) fail("too_many_items", `${path}.items_en`);
        block.items_en = rawItemsEn.map((raw, i) => {
          const ipath = `${path}.items_en[${i}]`;
          if (!isRecord(raw)) fail("invalid_item", ipath);
          if (Object.keys(raw).some(k => !has(t.items!.fields, k))) fail("invalid_content_field", ipath);
          return Object.fromEntries(Object.entries(t.items!.fields).map(([k, def]) => [k, validateField(raw[k], { ...def, required: false, default: "" }, `${ipath}.${k}`, false)]));
        });
      }
    } else if (item.items !== undefined || item.items_en !== undefined) fail("invalid_block_items", path);
    blocks.push(block);
  });
  contract.locked.forEach((l, index) => {
    const block = blocks[index];
    if (!block || block.id !== l.id) fail("locked_block_missing", `blocks[${index}]`);
  });
  return { blocks };
}
function validateField(value: unknown, def: FieldDef, path: string, enabled: boolean): string {
  if (value === undefined) value = def.default ?? "";
  if (typeof value !== "string") fail("invalid_content_type", path);
  const s = value as string;
  if (s.length > def.max) fail("invalid_content_length", path);
  if (!safeText(s)) fail("content_html_not_allowed", path);
  if (def.required && enabled && !s.trim()) fail("required_field_missing", path);
  if (def.kind === "link" && !safeLink(s)) fail("invalid_content_link", path);
  if ((def.kind === "image" || def.kind === "video") && s && !ASSET_URL.test(s)) fail(def.kind === "image" ? "invalid_content_image" : "invalid_content_video", path);
  if (def.kind === "select" && !def.options?.some(o => o.value === s)) fail("invalid_content_option", path);
  return s;
}

/** Every asset reference in a page, with the kind the field expects (server verifies ownership + MIME). */
export function assetRefs(page: PageContent): { url: string; kind: "image" | "video"; path: string }[] {
  const refs: { url: string; kind: "image" | "video"; path: string }[] = [];
  for (const block of page.blocks) {
    const t = TEMPLATES[block.type];
    for (const [k, def] of Object.entries(t.fields)) {
      if (def.kind !== "image" && def.kind !== "video") continue;
      if (block.fields[k]) refs.push({ url: block.fields[k]!, kind: def.kind, path: `${block.id}.${k}` });
      // An English-only asset is uploaded content too: it must be verified for
      // ownership and MIME exactly like the Hebrew one, never trusted.
      if (block.fields_en?.[k]) refs.push({ url: block.fields_en[k]!, kind: def.kind, path: `${block.id}.fields_en.${k}` });
    }
  }
  return refs;
}

// ── Reading a block in a language ───────────────────────────────────────────
// Hebrew is canonical: every field has a Hebrew value. English is per-field
// optional, so reading in English means "the English value when one was
// written, otherwise the Hebrew one" — a declared fallback, never an invented
// translation.

/** The value of one field in `locale`, falling back to Hebrew. */
export function localizedValue(block: Block, field: string, locale: ContentLocale): string {
  if (locale === "en") {
    const en = block.fields_en?.[field];
    if (typeof en === "string" && en.trim()) return en;
  }
  return block.fields[field] ?? "";
}

/** Every field of a block resolved in `locale`. */
export function localizedFields(block: Block, locale: ContentLocale): Record<string, string> {
  if (locale === "he" || !block.fields_en) return block.fields;
  return Object.fromEntries(Object.keys(block.fields).map(k => [k, localizedValue(block, k, locale)]));
}

/** Every repeatable item of a block resolved in `locale`. */
export function localizedItems(block: Block, locale: ContentLocale): Record<string, string>[] {
  const items = block.items ?? [];
  if (locale === "he" || !block.items_en) return items;
  return items.map((item, i) => {
    const en = block.items_en?.[i];
    if (!en) return item;
    return Object.fromEntries(Object.keys(item).map(k => {
      const value = en[k];
      return [k, typeof value === "string" && value.trim() ? value : item[k]!];
    }));
  });
}

/** A whole block, read in `locale`. The block's own shape is unchanged. */
export function localizedBlock(block: Block, locale: ContentLocale): Block {
  if (locale === "he") return block;
  const out: Block = { ...block, fields: localizedFields(block, locale) };
  if (block.items) out.items = localizedItems(block, locale);
  return out;
}

/** A whole page, read in `locale`. */
export function localizedPage(page: PageContent, locale: ContentLocale): PageContent {
  if (locale === "he") return page;
  return { blocks: page.blocks.map(b => localizedBlock(b, locale)) };
}

/**
 * Every Siton-owned content value that has NO English version and would
 * therefore be served as Hebrew. This is the OWNER_TRANSLATION_REQUIRED
 * report: the product never claims these are translated.
 */
export function missingEnglishContent(page: PageContent): string[] {
  const out: string[] = [];
  for (const block of page.blocks) {
    if (!block.enabled) continue;
    const t = TEMPLATES[block.type];
    if (!t) continue;
    for (const [k, def] of Object.entries(t.fields)) {
      if (def.kind === "image" || def.kind === "video" || def.kind === "select" || def.kind === "link") continue;
      if (!String(block.fields[k] ?? "").trim()) continue; // nothing to translate
      if (!String(block.fields_en?.[k] ?? "").trim()) out.push(`${block.id}.${k}`);
    }
    (block.items ?? []).forEach((item, i) => {
      for (const [k, def] of Object.entries(t.items?.fields ?? {})) {
        if (def.kind === "image" || def.kind === "video" || def.kind === "select" || def.kind === "link") continue;
        if (!String(item[k] ?? "").trim()) continue;
        if (!String(block.items_en?.[i]?.[k] ?? "").trim()) out.push(`${block.id}.items[${i}].${k}`);
      }
    });
  }
  return out;
}

/** Flat compatibility projection (the pre-block public API shape) derived from the blocks. */
export function projectLegacy(page: PageContent, contract: PageContract, locale: ContentLocale = "he"): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, [blockId, field]] of Object.entries(contract.legacy)) {
    const block = page.blocks.find(b => b.id === blockId);
    if (block) out[key] = localizedValue(block, field, locale);
  }
  return out;
}

/**
 * The TRANSLATION KEY explaining a validation code, plus the offending path.
 * This module is shared with the backend and stays free of any locale state:
 * the editor resolves the key in the language it is displaying.
 */
export function validationErrorKey(err: unknown): { key: string; path: string } {
  const e = err as Partial<CmsValidationError>;
  const code = String(e?.code || "");
  const messages: Record<string, string> = {
    required_field_missing: "cms.messages.required_field_missing",
    invalid_content_length: "cms.messages.invalid_content_length",
    content_html_not_allowed: "cms.messages.content_html_not_allowed",
    invalid_content_link: "cms.messages.invalid_content_link",
    invalid_content_image: "cms.messages.invalid_content_image",
    invalid_content_video: "cms.messages.invalid_content_video",
    too_few_items: "cms.messages.too_few_items",
    too_many_items: "cms.messages.too_many_items",
    too_many_blocks: "cms.messages.too_many_blocks",
    locked_block_missing: "cms.messages.locked_block_missing",
    locked_block_disabled: "cms.messages.locked_block_disabled",
    template_not_allowed: "cms.messages.template_not_allowed",
    content_changed_reload: "cms.messages.content_changed_reload"
  };
  return { key: messages[code] || "cms.invalid_content", path: String(e?.path || "") };
}
