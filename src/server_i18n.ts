// ── SERVER-SIDE LOCALE ─────────────────────────────────────────────────────
//
// The server-rendered surfaces (the legal documents, the share/OG pages, the
// hosted-payment return pages) are the SAME product as the React app, so they
// answer in the same language the visitor chose — and they read that choice
// from the only place the server can see it: the first-party `siton_lang`
// cookie the app writes alongside localStorage.
//
// `Accept-Language` is deliberately NOT consulted. Hebrew is the product
// default and must not be replaced because a phone or a browser is set to
// English; only an explicit choice by the visitor changes the language.
//
// The dictionaries are the ones the client uses — one source of truth, so a
// server-rendered page and its React counterpart cannot say different things.
import {
  DEFAULT_LOCALE, LOCALE_COOKIE_NAME, directionOf, htmlLangOf, intlTagOf,
  isLocale, localeFromCookieString, type Locale
} from "../web/src/i18n/locale.js";
import { translateIn, type TranslationVars } from "../web/src/i18n/translate.js";

export type { Locale };
export { DEFAULT_LOCALE, LOCALE_COOKIE_NAME, directionOf, htmlLangOf, intlTagOf, isLocale };

type RequestLike = {
  headers?: Record<string, unknown> | undefined;
  query?: Record<string, unknown> | undefined;
};

/**
 * The language for THIS request.
 *
 * Order: an explicit `?lang=` on the URL (so a link can be shared in a chosen
 * language, and so the no-JS shells can be checked in either language), then
 * the stored cookie, then Hebrew.
 */
export function localeFromRequest(req: RequestLike | undefined | null): Locale {
  const query = (req?.query || {}) as Record<string, unknown>;
  const explicit = String(query.lang ?? query.locale ?? "").trim();
  if (isLocale(explicit)) return explicit;
  const cookie = req?.headers?.cookie;
  const fromCookie = localeFromCookieString(typeof cookie === "string" ? cookie : null);
  return fromCookie ?? DEFAULT_LOCALE;
}

/** Translate a key for a server-rendered response. */
export function ts(locale: Locale, key: string, vars?: TranslationVars): string {
  return translateIn(locale, key, vars);
}

/** The `lang`/`dir` attribute pair for an HTML shell. */
export function htmlAttrs(locale: Locale): string {
  return `lang="${htmlLangOf(locale)}" dir="${directionOf(locale)}"`;
}

/** The Open Graph locale tag. */
export function ogLocale(locale: Locale): string {
  return locale === "en" ? "en_IL" : "he_IL";
}
