import React from "react";
import { LOCALES, type Locale } from "./locale.js";
import { useLocale } from "./useLocale.js";
import { t } from "./translate.js";

/**
 * The language switch: עברית | English.
 *
 * It lives in the site header, on every public and authenticated surface, and
 * is a real pair of buttons (not a select) so it is one tap on a phone and one
 * Tab-stop each for a keyboard. The active language is marked with
 * `aria-current`, so a screen reader announces which one is on.
 *
 * Each button is labelled in ITS OWN language — "English" stays "English" while
 * the Hebrew UI is showing, because that is what a visitor looking for it
 * scans for.
 */
const NATIVE_NAME: Record<Locale, string> = { he: "עברית", en: "English" };

export function LanguageSwitch({ compact = false }: { compact?: boolean }) {
  const [locale, setLocale] = useLocale();
  return (
    <div
      className={`lang-switch${compact ? " lang-switch-compact" : ""}`}
      role="group"
      aria-label={t("i18n.switch_label")}
      data-testid="language-switch"
    >
      {LOCALES.map((code) => (
        <button
          key={code}
          type="button"
          lang={code}
          className={`lang-btn${locale === code ? " active" : ""}`}
          aria-current={locale === code ? "true" : undefined}
          aria-label={t("i18n.switch_to", { language: NATIVE_NAME[code] })}
          data-testid={`language-switch-${code}`}
          data-locale={code}
          onClick={() => setLocale(code)}
        >
          {NATIVE_NAME[code]}
        </button>
      ))}
    </div>
  );
}
