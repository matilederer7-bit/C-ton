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

export type TemplateId = "hero" | "text" | "image_text" | "cta" | "steps" | "faq" | "columns" | "about" | "legal" | "footer";

export interface Block {
  id: string;
  type: TemplateId;
  enabled: boolean;
  fields: Record<string, string>;
  items?: Record<string, string>[];
}
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

const LINK_HINT = "קישור פנימי (#/seller) או כתובת https מלאה";
const link = (label: string, required = false): FieldDef => ({ label, kind: "link", max: 300, required, hint: LINK_HINT });
const text = (label: string, max: number, required = false, hint?: string): FieldDef => ({ label, kind: "text", max, required, ...(hint ? { hint } : {}) });
const multiline = (label: string, max: number, required = false, rows = 4): FieldDef => ({ label, kind: "multiline", max, required, rows });
const image = (label: string): FieldDef => ({ label, kind: "image", max: 100 });

export const TEMPLATES: Record<TemplateId, TemplateDef> = {
  hero: {
    name: "Hero ראשי",
    description: "הכותרת, המדיה והכפתורים בראש דף הבית",
    fields: {
      title: text("כותרת", 120, true),
      subtitle: multiline("כותרת משנה", 1000, false, 3),
      body: multiline("טקסט פתיחה", 1000, false, 2),
      media_kind: { label: "מדיה ראשית", kind: "select", max: 10, default: "image", options: [{ value: "image", label: "תמונה" }, { value: "video", label: "וידאו" }], hint: "רק מדיה אחת מוצגת — תמונה או וידאו" },
      image: { ...image("תמונה"), showWhen: { field: "media_kind", value: "image" } },
      video: { label: "וידאו (MP4 / WebM, ללא קול, עד 10MB)", kind: "video", max: 100, showWhen: { field: "media_kind", value: "video" } },
      video_poster: { ...image("תמונת כיסוי לוידאו (לא חובה)"), showWhen: { field: "media_kind", value: "video" } },
      primary_cta_label: text("כפתור ראשי", 60),
      primary_cta_link: link("קישור הכפתור הראשי"),
      secondary_cta_label: text("כפתור משני", 60),
      secondary_cta_link: link("קישור הכפתור המשני"),
      buyer_entry_title: text("כותרת תיבת הקונים", 120),
      buyer_entry_body: multiline("טקסט תיבת הקונים", 600, false, 2)
    }
  },
  text: {
    name: "מקטע טקסט",
    description: "כותרת ופסקה",
    fields: { title: text("כותרת", 160), body: multiline("תוכן", 5000, false, 5) }
  },
  image_text: {
    name: "תמונה וטקסט",
    description: "כותרת, פסקה ותמונה לצידה",
    fields: {
      title: text("כותרת", 160), body: multiline("תוכן", 5000, false, 5), image: image("תמונה"),
      image_position: { label: "מיקום התמונה", kind: "select", max: 10, default: "start", options: [{ value: "start", label: "בצד ההתחלה" }, { value: "end", label: "בצד הסיום" }] }
    }
  },
  cta: {
    name: "קריאה לפעולה",
    description: "כותרת, טקסט קצר וכפתור",
    fields: { title: text("כותרת", 160, true), body: multiline("טקסט", 1000, false, 2), button_label: text("כפתור", 60), button_link: link("קישור הכפתור") }
  },
  steps: {
    name: "איך זה עובד — שלבים",
    description: "רצף שלבים ממוספר",
    fields: { title: text("כותרת", 160) },
    items: { label: "שלבים", addLabel: "הוספת שלב", min: 1, max: 8, fields: { title: text("כותרת השלב", 120, true), body: multiline("תיאור השלב", 600, false, 2) } }
  },
  faq: {
    name: "שאלות נפוצות",
    description: "רשימת שאלות ותשובות מסודרת",
    fields: { title: text("כותרת", 160) },
    items: { label: "שאלות", addLabel: "הוספת שאלה", min: 1, max: 40, fields: { q: text("שאלה", 300, true), a: multiline("תשובה", 2000, true, 3) } }
  },
  columns: {
    name: "עמודות (למשל: לקונים / למוכרים)",
    description: "עד שלוש עמודות עם כותרת, טקסט וכפתור אופציונלי",
    fields: { title: text("כותרת", 160) },
    items: { label: "עמודות", addLabel: "הוספת עמודה", min: 1, max: 3, fields: { title: text("כותרת", 120, true), body: multiline("טקסט", 1200, false, 4), cta_label: text("כפתור (לא חובה)", 60), cta_link: link("קישור הכפתור") } }
  },
  about: {
    name: "אודות",
    description: "עמוד האודות — כותרת, תוכן ותמונה",
    fields: { title: text("כותרת", 160, true), body: multiline("תוכן", 10000, false, 12), image: image("תמונה (לא חובה)") }
  },
  legal: {
    name: "מסמך משפטי",
    description: "כותרת ותוכן המסמך. שורה שמתחילה ב-## היא כותרת פנימית, שורה שמתחילה ב- - היא סעיף ברשימה",
    fields: { title: text("כותרת", 160, true), body: multiline("תוכן", 60000, true, 18) }
  },
  footer: {
    name: "תחתית האתר",
    description: "השורה התחתונה והקישורים בתחתית כל עמוד",
    fields: { text: multiline("טקסט", 500, false, 2) },
    items: { label: "קישורים", addLabel: "הוספת קישור", min: 0, max: 8, fields: { label: text("טקסט הקישור", 60, true), link: link("יעד הקישור", true) } }
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
const HERO_DEFAULT = (): Block => ({
  id: "hero", type: "hero", enabled: true, fields: {
    title: LANDING_HE.hero.title, subtitle: LANDING_HE.hero.sub, body: LANDING_HE.hero.note,
    media_kind: "image", image: "", video: "", video_poster: "",
    primary_cta_label: "התחברות מוכר", primary_cta_link: "#/seller",
    secondary_cta_label: "פתיחת חשבון מוכר", secondary_cta_link: "#/seller?signup=1",
    buyer_entry_title: LANDING_HE.buyerEntry.title, buyer_entry_body: LANDING_HE.buyerEntry.body
  }
});

export const FOOTER_DEFAULT_TEXT = "C-ton — פלטפורמת קניות קבוצתיות · סביבת הדגמה (ללא חיובים אמיתיים)";
export const FOOTER_DEFAULT_LINKS: { label: string; link: string }[] = [
  { label: "תמיכה ויצירת קשר", link: "#/support" },
  { label: "אודות", link: "#/content/about" },
  { label: "תקנון ותנאי שימוש", link: "#/content/legal_terms" },
  { label: "פרטיות", link: "#/content/legal_privacy" },
  { label: "מדיניות ביטולים והחזרים", link: "#/content/legal_refunds" }
];

export const PAGE_CONTRACTS: Record<string, PageContract> = {
  home: {
    label: "דף הבית",
    description: "ה-Hero קבוע בראש העמוד; את שאר המקטעים אפשר לערוך, להסתיר, לסדר ולהוסיף",
    locked: [{ id: "hero", type: "hero" }],
    addable: ["text", "image_text", "cta", "steps", "faq", "columns"],
    maxBlocks: 20,
    legacy: { title: ["hero", "title"], sub: ["hero", "subtitle"], intro: ["hero", "body"], image: ["hero", "image"], login_cta: ["hero", "primary_cta_label"], signup_cta: ["hero", "secondary_cta_label"] },
    defaults: () => [
      HERO_DEFAULT(),
      { id: "how", type: "steps", enabled: true, fields: { title: LANDING_HE.howItWorks.title }, items: LANDING_HE.howItWorks.steps.map(s => ({ title: s.title, body: s.body })) },
      { id: "why", type: "text", enabled: false, fields: { title: LANDING_HE.whyGroupBuying.title, body: LANDING_HE.whyGroupBuying.body } },
      { id: "audiences", type: "columns", enabled: true, fields: { title: "" }, items: [
        { title: LANDING_HE.forBuyers.title, body: LANDING_HE.forBuyers.body, cta_label: "", cta_link: "" },
        { title: LANDING_HE.forSellers.title, body: LANDING_HE.forSellers.body, cta_label: "פתיחת חשבון מוכר", cta_link: "#/seller?signup=1" }
      ] },
      { id: "trust", type: "text", enabled: true, fields: { title: LANDING_HE.trust.title, body: LANDING_HE.trust.body } },
      { id: "about", type: "text", enabled: false, fields: { title: LANDING_HE.about.title, body: LANDING_HE.about.body } },
      { id: "faq", type: "faq", enabled: true, fields: { title: LANDING_HE.faq.title }, items: LANDING_HE.faq.items.map(i => ({ q: i.q, a: i.a })) },
      { id: "contact", type: "cta", enabled: true, fields: { title: "יש שאלה? אנחנו כאן", body: "צוות C-ton עונה לכל פנייה.", button_label: "תמיכה ויצירת קשר", button_link: "#/support" } }
    ]
  },
  about: {
    label: "אודות",
    description: "עמוד האודות המלא (#/content/about)",
    locked: [{ id: "about", type: "about" }], addable: [], maxBlocks: 1,
    legacy: { title: ["about", "title"], body: ["about", "body"] },
    defaults: () => [{ id: "about", type: "about", enabled: true, fields: { title: "אודות C-ton", body: LANDING_HE.about.body, image: "" } }]
  },
  footer: {
    label: "תחתית האתר",
    description: "מופיע בתחתית כל עמוד ציבורי",
    locked: [{ id: "footer", type: "footer" }], addable: [], maxBlocks: 1,
    legacy: { text: ["footer", "text"] },
    defaults: () => [{ id: "footer", type: "footer", enabled: true, fields: { text: FOOTER_DEFAULT_TEXT }, items: FOOTER_DEFAULT_LINKS.map(l => ({ ...l })) }]
  }
};

/** A legal document page contract — the backend registers one per legal slug. */
export function legalPageContract(label: string, defaults: { title: string; body: string }): PageContract {
  return {
    label, description: "מסמך משפטי בתוך מעטפת האתר. טקסט בלבד, ללא HTML",
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
  if (t.items) {
    const list = Array.isArray(raw.items) ? raw.items : [];
    block.items = list.filter(isRecord).slice(0, t.items.max).map(item => Object.fromEntries(Object.entries(t.items!.fields).map(([k, f]) => [k, cleanString(item[k], f)])))
      .filter(item => Object.entries(t.items!.fields).every(([k, f]) => !f.required || item[k]!.trim()));
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
    } else if (item.items !== undefined) fail("invalid_block_items", path);
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
    for (const [k, def] of Object.entries(t.fields)) if ((def.kind === "image" || def.kind === "video") && block.fields[k]) refs.push({ url: block.fields[k]!, kind: def.kind, path: `${block.id}.${k}` });
  }
  return refs;
}

/** Flat compatibility projection (the pre-block public API shape) derived from the blocks. */
export function projectLegacy(page: PageContent, contract: PageContract): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, [blockId, field]] of Object.entries(contract.legacy)) {
    const block = page.blocks.find(b => b.id === blockId);
    if (block) out[key] = block.fields[field] ?? "";
  }
  return out;
}

/** Hebrew explanation of a validation code for the editor. */
export function describeValidationError(err: unknown): string {
  const e = err as Partial<CmsValidationError>;
  const code = String(e?.code || "");
  const messages: Record<string, string> = {
    required_field_missing: "חסר שדה חובה",
    invalid_content_length: "הטקסט ארוך מדי",
    content_html_not_allowed: "אסור להזין HTML או תגיות — טקסט בלבד",
    invalid_content_link: "הקישור אינו תקין — מותר קישור פנימי (#/...) או כתובת https",
    invalid_content_image: "התמונה חייבת להיות תמונה שהועלתה דרך המערכת",
    invalid_content_video: "הוידאו חייב להיות קובץ שהועלה דרך המערכת",
    too_few_items: "חסרים פריטים במקטע",
    too_many_items: "יותר מדי פריטים במקטע",
    too_many_blocks: "יותר מדי מקטעים בעמוד",
    locked_block_missing: "מקטע חובה חסר או לא במקומו",
    locked_block_disabled: "לא ניתן להסתיר מקטע חובה",
    template_not_allowed: "תבנית זו אינה מותרת בעמוד זה",
    content_changed_reload: "התוכן עודכן בידי מנהל אחר. רעננו את העמוד לפני השמירה."
  };
  return (messages[code] || "התוכן אינו תקין") + (e?.path ? ` (${e.path})` : "");
}
