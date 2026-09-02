// ── Centralized Hebrew presentation for every user-visible message ──────────
// The product language is Hebrew: no raw provider/backend/browser message may
// reach a normal user. Errors are translated by code/status/pattern here, in
// ONE place, with a safe generic fallback. Technical identifiers stay English
// only inside genuinely internal admin/debug contexts.
//
// Structured for future locale selection (this module is the `he` locale).

export interface ApiErrorLike {
  status?: number;
  message?: string;
  body?: { code?: string; error?: string; message?: string };
}

const CODE_MESSAGES: Record<string, string> = {
  // product / canonical API codes
  max_units_exceeded: "המלאי אזל בזמן ההצטרפות — נסו כמות קטנה יותר",
  seller_auth_invalid_credentials: "אימייל או סיסמה שגויים",
  SELLER_AUTH_INVALID_CREDENTIALS: "אימייל או סיסמה שגויים",
  seller_auth_blocked: "החשבון חסום להתחברות — פנו לתמיכה",
  seller_context_switch_disabled: "הפעולה אינה זמינה בסביבה זו",
  authentication_required: "נדרשת התחברות",
  invalid_token: "ההתחברות פגה — התחברו מחדש",
  deal_not_found: "העסקה לא נמצאה",
  support_rate_limited: "נשלחו יותר מדי פניות — נסו שוב מאוחר יותר",
  deal_delete_not_allowed: "לא ניתן למחוק עסקה שכבר יש בה פעילות",
  seller_terms_required: "יש לאשר את תנאי הפרסום",
  seller_profile_incomplete: "חסרים פרטי עסק בפרופיל המוכר (שם עסק ופרטי יצירת קשר) — פנו לתמיכה להשלמה",
  seller_kyc_not_approved: "חשבון המוכר ממתין לאישור — פנו לתמיכה",
  DEAL_NOT_EDITABLE: "אפשר לערוך רק טיוטה — עסקה שפורסמה נעולה לשינויים",
  DRAFT_EDITOR_STALE: "הטיוטה השתנתה בינתיים — רעננו את המסך ונסו שוב",
  deadline_below_minimum: "מועד הסיום חייב להיות לפחות שעתיים מעכשיו",
  deadline_above_maximum: "מועד הסיום יכול להיות עד 7 ימים קדימה",
  deadline_invalid: "יש לבחור תאריך ושעה תקינים",
  description_too_long: "התיאור המלא ארוך מדי (עד 4000 תווים)",
  description_short_too_long: "התיאור הקצר ארוך מדי (עד 200 תווים)",
  title_required: "יש להזין שם לעסקה",
  title_too_long: "שם העסקה ארוך מדי (עד 200 תווים)",
  price_invalid: "יש להזין מחיר תקין",
  min_units_invalid: "יש להזין כמות מינימום תקינה",
  max_units_invalid: "כמות המקסימום חייבת להיות לפחות כמו המינימום",
  delivery_options_invalid: "יש להשלים את פרטי אפשרויות האספקה",
  deal_image_limit: "אפשר עד 12 תמונות לעסקה",
  deal_already_published: "העסקה כבר פורסמה — פעולה זו אפשרית רק בטיוטה",
  SELLER_RESTRICTED: "חשבון המוכר מוגבל — פנו לתמיכה",
  SELLER_SUSPENDED: "חשבון המוכר מושהה — פנו לתמיכה",
  SELLER_BANNED: "חשבון המוכר חסום — פנו לתמיכה",
  contact_name_required: "יש להזין שם",
  contact_email_invalid: "יש להזין כתובת אימייל תקינה",
  contact_message_too_short: "כתבו לנו כמה מילים על הפנייה (לפחות 10 תווים)",
  contact_message_too_long: "תוכן הפנייה ארוך מדי (עד 2000 תווים)",
  contact_category_invalid: "יש לבחור נושא לפנייה",
  rate_limit_exceeded: "יותר מדי בקשות — נסו שוב בעוד רגע",
  // P0.3 — pause/reopen joining
  deal_not_open_for_joining: "העסקה אינה פתוחה להצטרפות במצבה הנוכחי",
  deal_not_paused: "ההצטרפות אינה מושהית — אין מה לפתוח מחדש",
  deal_reopen_not_allowed: "ההצטרפות נסגרה אוטומטית (מועד סיום או מלאי) — לא ניתן לפתוח מחדש",
  deal_reopen_deadline_passed: "מועד הסיום עבר — לא ניתן לפתוח את ההצטרפות מחדש",
  deal_reopen_capacity_full: "המלאי הסתיים — לא ניתן לפתוח את ההצטרפות מחדש",
  // P0.3 — chat
  chat_closed: "הצ׳אט סגור בעסקה זו",
  chat_reply_target_not_found: "ההודעה שאליה ניסיתם להגיב כבר לא זמינה",
  invalid_reaction: "התגובה אינה תקינה",
  reaction_identity_required: "לא ניתן להגיב כרגע — רעננו את הדף ונסו שוב",
  // P0.3 — join payment method
  payment_method_invalid: "יש לבחור אמצעי תשלום: כרטיס אשראי או bit",
  // P0.3 — business profile
  business_profile_email_invalid: "אחת מכתובות האימייל בפרופיל העסקי אינה תקינה",
  bank_account_invalid: "מספר חשבון הבנק אינו תקין"
};

const PATTERN_MESSAGES: [RegExp, string][] = [
  [/invalid login credentials|invalid credentials|invalid grant/i, "אימייל או סיסמה שגויים"],
  [/not confirmed/i, "המייל טרם אומת — בדקו את תיבת הדואר ולחצו על קישור האימות"],
  [/already registered|already exists/i, "החשבון כבר קיים — נסו להתחבר"],
  [/rate limit|too many requests/i, "יותר מדי ניסיונות — המתינו מספר דקות ונסו שוב"],
  [/password should be at least|weak password/i, "הסיסמה קצרה מדי — נדרשות לפחות 8 תווים"],
  [/unable to validate email|invalid email/i, "כתובת האימייל אינה תקינה"],
  [/failed to fetch|networkerror|network error|load failed/i, "בעיית תקשורת — בדקו את החיבור ונסו שוב"],
  [/unauthorized|forbidden/i, "אין הרשאה לפעולה זו"],
  [/timeout|timed out/i, "הפעולה נמשכה יותר מדי — נסו שוב"]
];

const STATUS_MESSAGES: Record<number, string> = {
  400: "הבקשה אינה תקינה — בדקו את הפרטים ונסו שוב",
  401: "נדרשת התחברות מחדש",
  403: "אין הרשאה לפעולה זו",
  404: "לא נמצא",
  409: "הפעולה מתנגשת עם מצב קיים — רעננו ונסו שוב",
  413: "הקובץ גדול מדי",
  429: "יותר מדי בקשות — נסו שוב בעוד רגע",
  500: "שגיאה זמנית במערכת — נסו שוב",
  502: "שגיאה זמנית במערכת — נסו שוב",
  503: "השירות אינו זמין כרגע — נסו שוב בעוד רגע"
};

export const GENERIC_ERROR = "משהו השתבש — נסו שוב";

// Hebrew already? Keep it (it is product copy, not a raw provider string).
function looksHebrew(text: string): boolean {
  return /[֐-׿]/.test(text);
}

export function hebrewError(err: unknown, fallback = GENERIC_ERROR): string {
  const e = (err || {}) as ApiErrorLike & { message?: string };
  const code = String(e.body?.code || e.body?.error || "").trim();
  if (code && CODE_MESSAGES[code]) return CODE_MESSAGES[code];
  const candidates = [e.body?.message, e.message].map((m) => String(m || "").trim()).filter(Boolean);
  for (const msg of candidates) {
    if (looksHebrew(msg)) return msg;
    for (const [re, he] of PATTERN_MESSAGES) if (re.test(msg)) return he;
  }
  if (typeof e.status === "number" && STATUS_MESSAGES[e.status]) return STATUS_MESSAGES[e.status]!;
  return fallback;
}
