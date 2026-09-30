// ── Canonical Hebrew content of the "איך זה עובד?" infographic ──────────────
// The DEFAULT content of the home-page infographic (owner copy, 2026-09-28).
// It is what the site shows when nothing was ever saved through the content
// editor, and what a missing / malformed stored value falls back to. Every
// icon is a KEY from content/howItWorksIcons.ts — never markup.
//
// The seller summary icon is deliberately different from the buyer one: the
// buyer line is about protection (no charge until success), the seller line
// is about money arriving only when the deal closes successfully.
import type { HowItWorksContent } from "./howItWorks.js";

export const HOW_IT_WORKS_HE: HowItWorksContent = {
  title: "איך זה עובד?",
  buyers: {
    title: "לקונים",
    steps: [
      { text: "מוצאים עסקה", icon: "search" },
      { text: "בוחרים כמות ומשלוח", icon: "cart" },
      { text: "נתפסת מסגרת בלבד", icon: "card_hold" },
      { text: "עוקבים בזמן אמת", icon: "pulse" }
    ],
    summary: { text: "בלי חיוב עד שהעסקה נסגרת בהצלחה", icon: "shield_check" }
  },
  sellers: {
    title: "למוכרים",
    steps: [
      { text: "פותחים עסקה", icon: "plus_circle" },
      { text: "מגדירים כמות ותאריך", icon: "calendar" },
      { text: "משתפים לינק", icon: "link" },
      { text: "עוקבים ומנהלים", icon: "dashboard" }
    ],
    summary: { text: "החיוב מתבצע רק כשהעסקה נסגרת בהצלחה", icon: "coins_check" }
  }
};
