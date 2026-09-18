// ── SITON BILINGUAL CONTRACT ───────────────────────────────────────────────
//
// One system, two languages. This suite proves the parts of that claim that do
// not need a browser: the dictionaries themselves, the locale rules, the
// fallback policy, the glossary and the direction mapping. The browser half
// (a real switch, a real reload, real layout at 390px and 1440px) is
// tests/i18n_browser_validation.ts.
//
// What it is really guarding against: a translation that quietly drops a
// number, a language that silently reverts to Hebrew, an English screen that
// still speaks Hebrew, and — the one that would cost money — English payment
// copy that says "paid" where the Hebrew says "authorization".
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { HE } from "../web/src/i18n/dictionaries/he.js";
import { EN } from "../web/src/i18n/dictionaries/en.js";
import {
  DEFAULT_LOCALE, LOCALES, LOCALE_COOKIE_NAME, directionOf, htmlLangOf, intlTagOf,
  isLocale, localeFromCookieString
} from "../web/src/i18n/locale.js";
import {
  __resetTranslationReportForTests, fallbackTranslationKeys, hasTranslation,
  interpolate, missingTranslationKeys, splitTemplate, templateIn, translateIn
} from "../web/src/i18n/translate.js";
import { GLOSSARY } from "../web/src/i18n/glossary.js";
import { LEGAL_NAV_LABEL_KEYS, LEGAL_PAGE_ORDER, legalTranslationsRequired, resolveLegalPage } from "../src/legal_pages.js";
import { localeFromRequest, htmlAttrs, ogLocale } from "../src/server_i18n.js";
import {
  localizedBlock, localizedValue, missingEnglishContent, normalizePage, contractFor, validatePage, type Block
} from "../web/src/content/cmsTemplates.js";

/** Source with comments removed — a rule named in a comment is not a rule broken. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}
const localeSource = code(await readFile("web/src/i18n/locale.ts", "utf8"));
const serverI18nSource = code(await readFile("src/server_i18n.ts", "utf8"));

let passed = 0;
let failed = 0;
function run(name: string, fn: () => void) {
  try { fn(); console.log(`PASS ${name}`); passed++; }
  catch (e: any) { console.error(`FAIL ${name}: ${e.message}`); failed++; }
}

const HEBREW = /[֐-׿]/;
const placeholders = (text: string) => [...String(text).matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();

// ── 1. Hebrew is the default, and nothing but an explicit choice changes it ──

run("1: Hebrew is the default locale and the only two locales are he/en", () => {
  assert.equal(DEFAULT_LOCALE, "he");
  assert.deepEqual([...LOCALES], ["he", "en"]);
  assert.equal(isLocale("he"), true);
  assert.equal(isLocale("en"), true);
  assert.equal(isLocale("fr"), false);
  assert.equal(isLocale(""), false);
});

run("1: the locale is never inferred from the operating system or the browser", () => {
  // navigator.language / Accept-Language auto-detection would override the
  // business rule "Hebrew first" for anyone whose phone is set to English.
  // Both are checked against the CODE, so the rule may be explained in a
  // comment without the comment itself tripping the assertion.
  assert.doesNotMatch(localeSource, /navigator\s*\.\s*languages?/, "no navigator.language detection");
  assert.doesNotMatch(localeSource, /accept-language/i, "no Accept-Language detection");
  assert.doesNotMatch(serverI18nSource, /accept-language/i, "the server does not read Accept-Language either");
});

run("6: each locale maps to the right html lang, dir and Intl tag", () => {
  assert.equal(htmlLangOf("he"), "he");
  assert.equal(htmlLangOf("en"), "en");
  assert.equal(directionOf("he"), "rtl");
  assert.equal(directionOf("en"), "ltr");
  assert.equal(intlTagOf("he"), "he-IL");
  // The English surface is still an Israeli product: ILS, Israeli dates.
  assert.equal(intlTagOf("en"), "en-IL");
  assert.equal(htmlAttrs("he"), 'lang="he" dir="rtl"');
  assert.equal(htmlAttrs("en"), 'lang="en" dir="ltr"');
  assert.equal(ogLocale("he"), "he_IL");
  assert.equal(ogLocale("en"), "en_IL");
});

run("4: the stored choice travels in a first-party cookie the server can read", () => {
  assert.equal(LOCALE_COOKIE_NAME, "siton_lang");
  assert.equal(localeFromCookieString("siton_lang=en"), "en");
  assert.equal(localeFromCookieString("a=1; siton_lang=he; b=2"), "he");
  assert.equal(localeFromCookieString("siton_lang=fr"), null, "an unknown value is not a locale");
  assert.equal(localeFromCookieString("xsiton_lang=en"), null, "a look-alike cookie name is not the cookie");
  assert.equal(localeFromCookieString(""), null);
  assert.equal(localeFromCookieString(null), null);
});

run("4: the server resolves the request language from the cookie, or an explicit ?lang, never from a header", () => {
  assert.equal(localeFromRequest(undefined), "he");
  assert.equal(localeFromRequest({ headers: {} }), "he");
  assert.equal(localeFromRequest({ headers: { cookie: "siton_lang=en" } }), "en");
  assert.equal(localeFromRequest({ query: { lang: "en" } }), "en");
  // an explicit link beats the stored cookie
  assert.equal(localeFromRequest({ headers: { cookie: "siton_lang=he" }, query: { lang: "en" } }), "en");
  // a hostile value falls back to the product default rather than throwing
  assert.equal(localeFromRequest({ query: { lang: "../../etc/passwd" } }), "he");
  assert.equal(localeFromRequest({ headers: { "accept-language": "en-US,en;q=0.9" } }), "he",
    "an English browser still gets the Hebrew default");
});

// ── 2. The dictionaries ─────────────────────────────────────────────────────

run("2: every Hebrew key has English, and the two dictionaries have the same keys", () => {
  const heKeys = Object.keys(HE).sort();
  const enKeys = Object.keys(EN).sort();
  const missingEn = heKeys.filter((k) => !(k in EN));
  const orphanEn = enKeys.filter((k) => !(k in HE));
  assert.deepEqual(missingEn, [], `keys with no English: ${missingEn.slice(0, 10).join(", ")}`);
  assert.deepEqual(orphanEn, [], `English keys with no Hebrew: ${orphanEn.slice(0, 10).join(", ")}`);
  assert.ok(heKeys.length > 2000, `expected a full dictionary, got ${heKeys.length} keys`);
});

run("2: no value is empty, and no key is rendered as its own name", () => {
  for (const [key, value] of Object.entries(HE)) {
    assert.ok(value.trim().length > 0, `empty Hebrew for ${key}`);
    assert.notEqual(value, key, `${key} renders its own key`);
  }
  for (const [key, value] of Object.entries(EN)) {
    assert.ok(value.trim().length > 0, `empty English for ${key}`);
    assert.notEqual(value, key, `${key} renders its own key`);
  }
});

run("2: every placeholder survives translation — a number cannot be dropped by the English", () => {
  for (const key of Object.keys(HE)) {
    assert.deepEqual(placeholders(EN[key]!), placeholders(HE[key]!),
      `placeholder mismatch on ${key}: he=${placeholders(HE[key]!)} en=${placeholders(EN[key]!)}`);
  }
});

run("13: no English value still speaks Hebrew", () => {
  const leaking = Object.keys(EN).filter((key) => HEBREW.test(EN[key]!));
  // The language switch names each language in its own language — that is the
  // one place a Hebrew word belongs inside the English dictionary.
  const allowed = new Set(["i18n.switch_to", "content_admin.content_language_he"]);
  const unexpected = leaking.filter((key) => !allowed.has(key));
  assert.deepEqual(unexpected, [], `English values containing Hebrew: ${unexpected.slice(0, 10).join(", ")}`);
});

run("2: keys are hierarchical, lower-case and stable", () => {
  for (const key of Object.keys(HE)) {
    assert.match(key, /^[a-z][a-z0-9_]*(\.[a-z0-9_]+(\[\d+\])?)+$/,
      `${key} is not a lower-case dotted key`);
    assert.ok(key.includes("."), `${key} has no namespace`);
  }
});

// ── 3. Lookup, fallback and interpolation ──────────────────────────────────

run("3: t() resolves in the asked-for language and interpolates", () => {
  const key = "app.sellers_area";
  assert.equal(translateIn("he", key), HE[key]);
  assert.equal(translateIn("en", key), EN[key]);
  assert.equal(interpolate("{a} and {b}", { a: "1", b: "2" }), "1 and 2");
  assert.equal(interpolate("{a} and {a}", { a: "x" }), "x and x", "a placeholder may repeat");
  assert.equal(interpolate("{missing}", {}), "{missing}", "an unfilled placeholder stays visible");
  assert.equal(interpolate("plain"), "plain");
});

run("3: a missing English value falls back to Hebrew and is REPORTED, not hidden", () => {
  __resetTranslationReportForTests();
  const key = "app.sellers_area";
  const saved = EN[key];
  try {
    delete (EN as Record<string, string>)[key];
    assert.equal(translateIn("en", key), HE[key], "falls back to the Hebrew value");
    assert.ok(fallbackTranslationKeys().includes(key), "the fallback is recorded");
    assert.equal(hasTranslation("en", key), false, "and it does not claim to be translated");
  } finally {
    (EN as Record<string, string>)[key] = saved!;
  }
});

run("3: a key with no value anywhere is reported rather than swallowed", () => {
  __resetTranslationReportForTests();
  assert.equal(translateIn("en", "no.such.key.exists"), "no.such.key.exists");
  assert.ok(missingTranslationKeys().includes("no.such.key.exists"));
  __resetTranslationReportForTests();
  assert.deepEqual(missingTranslationKeys(), []);
});

run("3: templateIn/splitTemplate keep a sentence whole for markup substitution", () => {
  const key = "deal.units_to_target";
  assert.match(templateIn("he", key), /\{units\}/, "the template keeps its placeholders");
  const parts = splitTemplate("a {x} b {y}");
  assert.deepEqual(parts.map((p) => p.name ?? null), [null, "x", null, "y"]);
  assert.equal(parts.map((p) => p.text).join(""), "a {x} b {y}", "no text is lost");
});

// ── 9. Terminology: the money words are the ones that can cost money ────────

run("9: the glossary covers the Siton terms and fixes the financial ones", () => {
  const en = new Map(GLOSSARY.map((entry) => [entry.he, entry.en]));
  assert.equal(en.get("עסקה"), "Deal");
  assert.equal(en.get("מוכר"), "Seller");
  assert.equal(en.get("קונה"), "Buyer");
  assert.equal(en.get("יעד"), "Target");
  assert.equal(en.get("הצטרפות"), "Join");
  assert.equal(en.get("מסגרת / הרשאת תשלום"), "Authorization");
  assert.equal(en.get("החזקה"), "Hold");
  assert.equal(en.get("חיוב"), "Charge");
  for (const entry of GLOSSARY) assert.ok(entry.note.trim().length > 10, `${entry.he} needs a usage note`);
});

run("9: English never turns an authorization into a payment", () => {
  // Hebrew that says an authorization is placed and NO charge is made must not
  // come back in English saying the buyer paid or was charged.
  const authorizationOnly = Object.keys(HE).filter((key) =>
    /נתפסת מסגרת|מסגרת בלבד|לא מתבצע חיוב|לא בוצע חיוב|ללא חיוב|לא משלמים/.test(HE[key]!));
  assert.ok(authorizationOnly.length >= 8, `expected the authorization-only copy, found ${authorizationOnly.length}`);
  for (const key of authorizationOnly) {
    const english = EN[key]!;
    assert.doesNotMatch(english, /\byou (?:have )?paid\b/i, `${key} must not say the buyer paid`);
    assert.doesNotMatch(english, /\byou (?:were|are|have been) charged\b/i, `${key} must not say the buyer was charged`);
    assert.doesNotMatch(english, /\bpayment (?:was|is) (?:taken|made|completed)\b/i, `${key} must not say a payment happened`);
  }
});

run("9: the closed-pilot disclosure stays true in English", () => {
  const pilot = EN["buyer_copy.pilot_mock_money_line"]!;
  assert.match(pilot, /no real charge/i);
  assert.doesNotMatch(pilot, /\bwill be\b|\bsoon\b/i, "no claim about the future");
});

// ── 15/17. The legal documents and the empty/unknown screens ───────────────

run("15: an English legal document falls back to Hebrew, declares it, and is reported", () => {
  const pending = legalTranslationsRequired();
  assert.deepEqual(pending, [...LEGAL_PAGE_ORDER],
    "no English legal text has been owner-approved yet, and the code says so");
  for (const slug of LEGAL_PAGE_ORDER) {
    const he = resolveLegalPage(slug, "he");
    assert.equal(he.bodyLocale, "he");
    assert.equal(he.translation, "approved");
    const en = resolveLegalPage(slug, "en");
    assert.equal(en.bodyLocale, "he", `${slug} English body falls back to Hebrew`);
    assert.equal(en.translation, "OWNER_TRANSLATION_REQUIRED", `${slug} declares the gap`);
    assert.equal(en.page.body, he.page.body, "the fallback is the real Hebrew document, not an invention");
    // The nav chrome IS translated — only the contract is not.
    assert.ok(hasTranslation("en", LEGAL_NAV_LABEL_KEYS[slug]), `${slug} nav label in English`);
  }
});

// ── CMS content: structured for both languages, honest about the gaps ──────

run("CMS: a block reads in English where English exists and falls back where it does not", () => {
  const block: Block = {
    id: "text", type: "text", enabled: true,
    fields: { title: "כותרת", body: "גוף" },
    fields_en: { title: "Title", body: "" }
  };
  assert.equal(localizedValue(block, "title", "en"), "Title");
  assert.equal(localizedValue(block, "body", "en"), "גוף", "a blank English value falls back");
  assert.equal(localizedValue(block, "title", "he"), "כותרת");
  assert.equal(localizedBlock(block, "he"), block, "Hebrew is the stored page, untouched");
  assert.deepEqual(missingEnglishContent({ blocks: [block] }), ["text.body"]);
});

run("CMS: the English side is validated but never REQUIRED", () => {
  const contract = contractFor("about");
  const page = validatePage({
    blocks: [{
      id: "about", type: "about", enabled: true,
      fields: { title: "אודות", body: "גוף", image: "" },
      fields_en: { title: "", body: "", image: "" }
    }]
  }, contract);
  assert.equal(page.blocks[0]!.fields_en!.title, "", "an empty English title is accepted");
  // …but the same safety rules still apply to it.
  assert.throws(() => validatePage({
    blocks: [{
      id: "about", type: "about", enabled: true,
      fields: { title: "אודות", body: "גוף", image: "" },
      fields_en: { title: "<script>alert(1)</script>", body: "", image: "" }
    }]
  }, contract), /content_html_not_allowed/, "English content cannot smuggle HTML past the validator");
});

run("CMS: a stored page with no English at all still renders, in Hebrew", () => {
  const page = normalizePage({ blocks: [{ id: "about", type: "about", enabled: true, fields: { title: "אודות", body: "גוף" } }] }, contractFor("about"));
  const english = localizedBlock(page.blocks[0]!, "en");
  assert.equal(english.fields.title, "אודות");
});

console.log(`I18N_CONTRACT passed=${passed} failed=${failed}`);
if (failed) process.exit(1);
