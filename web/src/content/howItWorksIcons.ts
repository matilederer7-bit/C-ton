// ── "How it works" infographic — the ICON WHITELIST ─────────────────────────
//
// The admin never types SVG or HTML for an icon: the stored value is one of
// these KEYS, validated on the server (a `select` field of the CMS template)
// and normalized on the client (an unknown key falls back to the default).
// The glyphs themselves live in web/src/howItWorksIcons.tsx and are looked
// up by key, so no persisted value can ever reach the DOM as markup.
//
// This module is PURE (no React, no DOM) because the CMS template library
// and the backend validator import it.

export const HOW_IT_WORKS_ICON_KEYS = [
  "search",
  "cart",
  "card_hold",
  "pulse",
  "plus_circle",
  "calendar",
  "link",
  "dashboard",
  "shield_check",
  "coins_check",
  "users",
  "truck",
  "tag",
  "clock",
  "bell",
  "check_circle"
] as const;

export type HowItWorksIconKey = typeof HOW_IT_WORKS_ICON_KEYS[number];

export const HOW_IT_WORKS_DEFAULT_ICON: HowItWorksIconKey = "check_circle";

export function isHowItWorksIconKey(value: unknown): value is HowItWorksIconKey {
  return typeof value === "string" && (HOW_IT_WORKS_ICON_KEYS as readonly string[]).includes(value);
}

/** The translation key of an icon's label in the admin picker. */
export function howItWorksIconLabelKey(key: HowItWorksIconKey): string {
  return `cms.icons.${key}`;
}
