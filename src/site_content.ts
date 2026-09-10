import { LEGAL_PAGES } from "./legal_pages.js";
import { LANDING_HE } from "../web/src/content/landing.he.js";
import { failure, type Db } from "./receipt_trust.js";

type Field = { label: string; max: number; multiline?: boolean; image?: boolean };
export const CONTENT_SECTIONS: Record<string, { label: string; fields: Record<string, Field>; defaults: Record<string, string> }> = {
  home: { label: "דף הבית", fields: {
    title: { label: "כותרת ראשית", max: 120 }, sub: { label: "כותרת משנה", max: 1000, multiline: true },
    intro: { label: "טקסט פתיחה", max: 1000, multiline: true }, image: { label: "תמונת פתיחה", max: 100, image: true },
    login_cta: { label: "כפתור כניסה", max: 60 }, signup_cta: { label: "כפתור הרשמה", max: 60 }
  }, defaults: { title: LANDING_HE.hero.title, sub: LANDING_HE.hero.sub, intro: LANDING_HE.hero.note, image: "", login_cta: "התחברות מוכר", signup_cta: "פתיחת חשבון מוכר" } },
  about: { label: "אודות", fields: { title: { label: "כותרת", max: 120 }, body: { label: "תוכן", max: 10000, multiline: true } }, defaults: { title: "אודות C-ton", body: LANDING_HE.about.body } },
  footer: { label: "תחתית האתר", fields: { text: { label: "טקסט", max: 500, multiline: true } }, defaults: { text: "C-ton — פלטפורמת קניות קבוצתיות · סביבת הדגמה (ללא חיובים אמיתיים)" } },
  ...Object.fromEntries(Object.entries(LEGAL_PAGES).map(([key, page]) => [`legal_${key}`, {
    label: page.navLabel, fields: { title: { label: "כותרת", max: 160 }, body: { label: "תוכן", max: 60000, multiline: true } }, defaults: { title: page.title, body: page.body }
  }]))
};
export function validateContent(key: string, value: any) {
  const section = Object.hasOwn(CONTENT_SECTIONS, key) ? CONTENT_SECTIONS[key] : undefined;
  if (!section || !value || typeof value !== "object" || Array.isArray(value)) failure("invalid_content");
  if (Object.keys(value).some(k => !Object.hasOwn(section.fields, k))) failure("invalid_content_field");
  const out: Record<string, string> = {};
  for (const [key, field] of Object.entries(section.fields)) {
    const text = value[key];
    if (typeof text !== "string" || text.length > field.max) failure("invalid_content_length");
    // Plain text only; no raw HTML, executable URLs, or HTML editor mode.
    if (/<\s*\/?[a-z!]/i.test(text) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) failure("content_html_not_allowed");
    if (field.image && text && !/^\/api\/content-assets\/[0-9a-f-]{36}$/.test(text)) failure("invalid_content_image");
    out[key] = text;
  }
  return out;
}
export async function readContent(c: Db) {
  const rows = (await c.query(`SELECT content_key, value_jsonb, revision, updated_at, updated_by FROM siton.site_content`)).rows;
  return Object.fromEntries(Object.entries(CONTENT_SECTIONS).map(([key, section]) => {
    const row = rows.find((r: any) => r.content_key === key);
    return [key, { ...section, value: row?.value_jsonb || section.defaults, revision: row?.revision || 0,
      updated_at: row?.updated_at || null, updated_by: row?.updated_by || null }];
  }));
}
