// ── SITON TRANSLATION LOOKUP ───────────────────────────────────────────────
// Every piece of system copy that Siton owns is addressed by a hierarchical
// key (`seller.dashboard.title`) and resolved against ONE dictionary per
// locale. There is no `if (locale === "en")` anywhere in the product code:
// call sites ask for a key, this module answers in the active language.
//
// Fallback policy (§1.4): a key with no English value falls back to the
// Hebrew value — explicitly, and recorded, so the gap is reportable instead
// of silently pretending to be translated.

import { DEFAULT_LOCALE, getLocale, type Locale } from "./locale.js";
import { HE } from "./dictionaries/he.js";
import { EN } from "./dictionaries/en.js";

export type Dictionary = Record<string, string>;

const DICTIONARIES: Record<Locale, Dictionary> = { he: HE, en: EN };

export function dictionaryFor(locale: Locale): Dictionary {
  return DICTIONARIES[locale] ?? DICTIONARIES[DEFAULT_LOCALE];
}

/** Keys asked for at runtime that no dictionary could answer. */
const missingKeys = new Set<string>();
/** Keys that exist in Hebrew but had to fall back for the active locale. */
const fallbackKeys = new Set<string>();

export function missingTranslationKeys(): string[] { return Array.from(missingKeys).sort(); }
export function fallbackTranslationKeys(): string[] { return Array.from(fallbackKeys).sort(); }
export function __resetTranslationReportForTests(): void { missingKeys.clear(); fallbackKeys.clear(); }

export type TranslationVars = Record<string, string | number>;

const PLACEHOLDER = /\{(\w+)\}/g;

export function interpolate(template: string, vars?: TranslationVars): string {
  if (!vars) return template;
  return template.replace(PLACEHOLDER, (whole, name: string) => {
    const value = vars[name];
    return value === undefined || value === null ? whole : String(value);
  });
}

// ── PLURAL AGREEMENT (red team §2.15) ──────────────────────────────────────
// A key that interpolates a count into a hard-coded plural reads wrong at one:
// `{qty} units` rendered "1 units", and the Hebrew `{qty} יחידות` rendered
// "1 יחידות", on every pickup card where a buyer joined with a single unit.
//
// A key may therefore declare a singular form under `<key>#one`. It is chosen
// when the call passes EXACTLY ONE numeric variable and that variable is 1.
// "Exactly one" is the whole rule: a sentence carrying two independent counts
// has two independent plural decisions and no single variant can express both,
// so such a key must be split into two keys instead. The i18n contract test
// enforces that — adding `#one` to a two-count key fails the build rather than
// silently pluralising the wrong noun.
//
// Hebrew and English both use it. Hebrew is not "the language without plurals":
// it needs the singular here for exactly the same reason English does.
const PLURAL_ONE_SUFFIX = "#one";

// Call sites pass counts through `num()`, which returns a LOCALE-FORMATTED
// STRING ("1", "1,234") — so a count variable is rarely a JavaScript number by
// the time it reaches here, and testing `typeof value === "number"` would have
// made this whole mechanism dead code. Group separators are stripped before
// parsing. Only keys that actually declare a `#one` variant are affected, so a
// numeric-looking string that is not a count (an id, a phone number) can change
// nothing unless someone adds a singular form to that key.
const COUNT_SEPARATORS = /[\s,\u00A0\u202F\u2009]/g;

function asCount(value: string | number): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = String(value).replace(COUNT_SEPARATORS, "");
  if (!/^-?\d+(\.\d+)?$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function pluralKeyFor(locale: Locale, key: string, vars?: TranslationVars): string {
  if (!vars) return key;
  let count: number | null = null;
  for (const value of Object.values(vars)) {
    const parsed = asCount(value);
    if (parsed === null) continue;
    if (count !== null) return key; // two counts: not decidable from one variant
    count = parsed;
  }
  if (count !== 1) return key;
  const singular = `${key}${PLURAL_ONE_SUFFIX}`;
  return typeof dictionaryFor(locale)[singular] === "string"
    || typeof dictionaryFor(DEFAULT_LOCALE)[singular] === "string"
    ? singular
    : key;
}

/**
 * Resolve `key` in `locale`, falling back to Hebrew and finally to the key
 * itself. The key is never rendered silently — an unresolved key is recorded
 * and the i18n gate fails the build on it.
 */
export function translateIn(locale: Locale, key: string, vars?: TranslationVars): string {
  key = pluralKeyFor(locale, key, vars);
  const own = dictionaryFor(locale)[key];
  if (typeof own === "string") return interpolate(own, vars);
  const base = dictionaryFor(DEFAULT_LOCALE)[key];
  if (typeof base === "string") {
    if (locale !== DEFAULT_LOCALE) fallbackKeys.add(key);
    return interpolate(base, vars);
  }
  missingKeys.add(key);
  return key;
}

/**
 * The template for `key`, WITHOUT interpolation — the raw string with its
 * `{placeholders}` intact. `Tx` uses it to substitute React nodes.
 */
export function templateIn(locale: Locale, key: string, vars?: TranslationVars): string {
  key = pluralKeyFor(locale, key, vars);
  const own = dictionaryFor(locale)[key];
  if (typeof own === "string") return own;
  const base = dictionaryFor(DEFAULT_LOCALE)[key];
  if (typeof base === "string") {
    if (locale !== DEFAULT_LOCALE) fallbackKeys.add(key);
    return base;
  }
  missingKeys.add(key);
  return key;
}

/** Split a template into its literal parts and placeholder names, in order. */
export function splitTemplate(template: string): { text: string; name?: string }[] {
  const out: { text: string; name?: string }[] = [];
  let last = 0;
  for (const match of template.matchAll(/\{(\w+)\}/g)) {
    const at = match.index ?? 0;
    const whole = match[0];
    const name = match[1];
    if (at > last) out.push({ text: template.slice(last, at) });
    out.push(name === undefined ? { text: whole } : { text: whole, name });
    last = at + whole.length;
  }
  if (last < template.length) out.push({ text: template.slice(last) });
  return out;
}

/** The product-facing translator: resolves against the ACTIVE locale. */
export function t(key: string, vars?: TranslationVars): string {
  return translateIn(getLocale(), key, vars);
}

/**
 * Resolve a label held in a KEY map — `t(MAP[value])` — falling back to the raw
 * value when the map has no entry for it. The pattern throughout the product is
 * a canonical backend identifier mapped to product copy; an identifier the map
 * does not know is shown as-is rather than hidden.
 */
export function tKey(key: string | undefined | null, raw?: unknown): string {
  if (key) return t(key);
  return raw === undefined || raw === null ? "" : String(raw);
}

/** True when the key has a real value in this locale (no fallback involved). */
export function hasTranslation(locale: Locale, key: string): boolean {
  return typeof dictionaryFor(locale)[key] === "string";
}
