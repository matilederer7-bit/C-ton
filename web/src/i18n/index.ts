// ── SITON i18n PUBLIC API ──────────────────────────────────────────────────
// One import for the whole product: `import { t } from "../i18n";`
export {
  type Locale, type Direction, LOCALES, DEFAULT_LOCALE,
  LOCALE_STORAGE_KEY, LOCALE_COOKIE_NAME, LOCALE_COOKIE_MAX_AGE_SECONDS,
  isLocale, directionOf, intlTagOf, htmlLangOf, localeFromCookieString,
  storedLocale, getLocale, setLocale, bootLocale, subscribeLocale,
  applyDocumentLocale, __resetLocaleForTests
} from "./locale";
export {
  type Dictionary, type TranslationVars, dictionaryFor, interpolate,
  translateIn, t, hasTranslation, missingTranslationKeys,
  fallbackTranslationKeys, __resetTranslationReportForTests
} from "./translate";
export { HE } from "./dictionaries/he";
export { EN } from "./dictionaries/en";
export { GLOSSARY, type GlossaryEntry } from "./glossary";
