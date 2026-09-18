// ── Canonical Hebrew copy for the seller area (system messages, empty states,
// guidance). Pure module (no DOM, no React) — the backend imports it as the
// defaults of the `seller_area` content template, and the seller pages read the
// same keys back through the CMS resolver with these values as the fallback.
export const SELLER_AREA_HE = {
  empty_title: "עדיין לא יצרת עסקאות",
  empty_body: "עסקה קבוצתית ראשונה לוקחת פחות מ־5 דקות.",
  empty_cta: "יצירת עסקה ראשונה",
  journey_title: "מה קורה מכאן?",
  pending_title: "החשבון ממתין לאישור C-ton — עדיין לא ניתן לפרסם.",
  pending_body: "אפשר כבר להכין עסקה כטיוטה, להעלות תמונות ולראות תצוגה מקדימה; הטיוטה נשמרת, והפרסום ייפתח מיד כשהחשבון יאושר (בדרך כלל תוך שעות ספורות).",
  rejected_title: "החשבון לא אושר לפרסום עסקאות.",
  rejected_body: "טיוטות נשמרות, אך פרסום אינו אפשרי. לשאלות —",
  profile_incomplete_title: "הפרופיל העסקי עדיין לא הושלם"
};
