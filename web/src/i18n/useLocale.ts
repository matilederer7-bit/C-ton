import { useEffect, useState } from "react";
import { getLocale, setLocale, subscribeLocale, type Locale } from "./locale";

/**
 * Subscribe a component to the active locale.
 *
 * `t()` reads the live locale at render time, so a component only needs this
 * hook to be RE-RENDERED when the language changes. The app root also remounts
 * the tree on change (see App.tsx), which is what guarantees that a screen
 * built before the switch — a modal, a cached error message, a memoised label —
 * cannot survive it in the previous language.
 */
export function useLocale(): [Locale, (next: Locale) => void] {
  const [locale, setState] = useState<Locale>(getLocale);
  useEffect(() => subscribeLocale(setState), []);
  return [locale, setLocale];
}
