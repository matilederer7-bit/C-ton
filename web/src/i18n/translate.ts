// ── SITON TRANSLATION LOOKUP ───────────────────────────────────────────────
// Every piece of system copy that Siton owns is addressed by a hierarchical
// key (`seller.dashboard.title`) and resolved against ONE dictionary per
// locale. There is no `if (locale === "en")` anywhere in the product code:
// call sites ask for a key, this module answers in the active language.
//
// Fallback policy (§1.4): a key with no English value falls back to the
// Hebrew value — explicitly, and recorded, so the gap is reportable instead
// of silently pretending to be translated.

import { DEFAULT_LOCALE, getLocale, type Locale } from "./locale";
import { HE } from "./dictionaries/he";
import { EN } from "./dictionaries/en";

export type Dictionary = Record<string, string>;

const DICTIONARIES: Record<Locale, Dictionary> = { he: HE, en: EN };

export function dictionaryFor(locale: Locale): Dictionary {
  return DICTIONARIES[locale] || DICTIONARIES[DEFAULT_LOCALE];
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

/**
 * Resolve `key` in `locale`, falling back to Hebrew and finally to the key
 * itself. The key is never rendered silently — an unresolved key is recorded
 * and the i18n gate fails the build on it.
 */
export function translateIn(locale: Locale, key: string, vars?: TranslationVars): string {
  const own = dictionaryFor(locale)[key];
  if (typeof own === "string") return interpolate(own, vars);
  const base = DICTIONARIES[DEFAULT_LOCALE][key];
  if (typeof base === "string") {
    if (locale !== DEFAULT_LOCALE) fallbackKeys.add(key);
    return interpolate(base, vars);
  }
  missingKeys.add(key);
  return key;
}

/** The product-facing translator: resolves against the ACTIVE locale. */
export function t(key: string, vars?: TranslationVars): string {
  return translateIn(getLocale(), key, vars);
}

/** True when the key has a real value in this locale (no fallback involved). */
export function hasTranslation(locale: Locale, key: string): boolean {
  return typeof dictionaryFor(locale)[key] === "string";
}
