// ── SITON LOCALE STATE ─────────────────────────────────────────────────────
// One system, two languages. Hebrew is the product default and stays the
// default on a first visit: the locale is NEVER inferred from the operating
// system or `navigator.language`, only from an explicit stored choice.
//
// The choice is persisted twice on purpose:
//   • localStorage — the browser's own memory, read by the React app.
//   • a first-party cookie — the ONLY copy the server can see, so the
//     server-rendered surfaces (legal documents, the no-JS shells) come back
//     in the same language the app is showing.
// Both are written together so the two halves of the product can never
// disagree about which language the visitor chose.

export type Locale = "he" | "en";
export type Direction = "rtl" | "ltr";

export const LOCALES: readonly Locale[] = ["he", "en"] as const;

/** Business requirement: Hebrew first. Not negotiable by user agent. */
export const DEFAULT_LOCALE: Locale = "he";

export const LOCALE_STORAGE_KEY = "siton.locale";
export const LOCALE_COOKIE_NAME = "siton_lang";
/** One year; the choice should outlive a shopping session. */
export const LOCALE_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

const DIRECTIONS: Record<Locale, Direction> = { he: "rtl", en: "ltr" };
/** BCP-47 tags for Intl (numbers, currency, dates). */
const INTL_TAGS: Record<Locale, string> = { he: "he-IL", en: "en-IL" };
const HTML_LANG: Record<Locale, string> = { he: "he", en: "en" };

export function isLocale(value: unknown): value is Locale {
  return value === "he" || value === "en";
}

export function directionOf(locale: Locale): Direction {
  return DIRECTIONS[locale];
}

export function intlTagOf(locale: Locale): string {
  return INTL_TAGS[locale];
}

export function htmlLangOf(locale: Locale): string {
  return HTML_LANG[locale];
}

/** Parse the cookie header/`document.cookie` form. Exported for the server. */
export function localeFromCookieString(raw: string | null | undefined): Locale | null {
  if (!raw) return null;
  for (const part of String(raw).split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== LOCALE_COOKIE_NAME) continue;
    const value = decodeURIComponent(part.slice(eq + 1).trim());
    if (isLocale(value)) return value;
  }
  return null;
}

function readStorage(): Locale | null {
  try {
    const raw = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    return isLocale(raw) ? raw : null;
  } catch { return null; }
}

function readCookie(): Locale | null {
  try { return localeFromCookieString(document.cookie); } catch { return null; }
}

/**
 * The stored preference, or null when the visitor has never chosen.
 * Deliberately does NOT consult navigator.language: a Hebrew-first product
 * must not open in English because the phone is set to English.
 */
export function storedLocale(): Locale | null {
  return readStorage() ?? readCookie();
}

let current: Locale = DEFAULT_LOCALE;
let booted = false;

const listeners = new Set<(locale: Locale) => void>();
/** Runs BEFORE the change, while the outgoing screen is still mounted. */
const beforeListeners = new Set<(from: Locale, to: Locale) => void>();

export function getLocale(): Locale {
  if (!booted) bootLocale();
  return current;
}

/** Apply the locale to the document element so CSS and AT see it. */
export function applyDocumentLocale(locale: Locale): void {
  try {
    const el = document.documentElement;
    el.setAttribute("lang", htmlLangOf(locale));
    el.setAttribute("dir", directionOf(locale));
    el.setAttribute("data-locale", locale);
  } catch { /* non-browser (tests, SSR) */ }
}

function persist(locale: Locale): void {
  try { window.localStorage.setItem(LOCALE_STORAGE_KEY, locale); } catch { /* private mode */ }
  try {
    const secure = typeof location !== "undefined" && location.protocol === "https:" ? "; Secure" : "";
    document.cookie =
      `${LOCALE_COOKIE_NAME}=${locale}; Path=/; Max-Age=${LOCALE_COOKIE_MAX_AGE_SECONDS}; SameSite=Lax${secure}`;
  } catch { /* cookies blocked */ }
}

/** Read the stored choice once at boot and reflect it on <html>. */
export function bootLocale(): Locale {
  if (booted) return current;
  booted = true;
  current = storedLocale() ?? DEFAULT_LOCALE;
  applyDocumentLocale(current);
  return current;
}

export function setLocale(locale: Locale): void {
  if (!isLocale(locale)) return;
  booted = true;
  const changed = current !== locale;
  if (changed) {
    // BEFORE anything moves: the old screen is still mounted, so this is the
    // only moment at which what the visitor has typed can still be read off it.
    // Switching language remounts every screen by design (see App.tsx), which
    // used to take a half-written enquiry with it. Listeners registered here
    // run synchronously, on every path into setLocale — not just the language
    // buttons — and a throwing listener must never block the switch.
    const from = current;
    for (const fn of Array.from(beforeListeners)) {
      try { fn(from, locale); } catch { /* a draft capture must never trap the visitor */ }
    }
  }
  current = locale;
  persist(locale);
  applyDocumentLocale(locale);
  if (changed) for (const fn of Array.from(listeners)) fn(locale);
}

/**
 * Run `fn` synchronously just BEFORE the locale changes, with the outgoing and
 * incoming locale. Used to capture on-screen drafts while the old tree lives.
 */
export function subscribeBeforeLocaleChange(fn: (from: Locale, to: Locale) => void): () => void {
  beforeListeners.add(fn);
  return () => { beforeListeners.delete(fn); };
}

export function subscribeLocale(fn: (locale: Locale) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Test seam: restore the module to a pristine, unbooted state. */
export function __resetLocaleForTests(): void {
  current = DEFAULT_LOCALE;
  booted = false;
  listeners.clear();
  beforeListeners.clear();
}
