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
  seller_kyc_not_approved: "חשבון המוכר עדיין ממתין לאישור C-ton — הטיוטה נשמרה, ואפשר לפרסם מיד לאחר האישור",
  list_price_invalid: "המחיר הרגיל חייב להיות גבוה מהמחיר הקבוצתי (או להישאר ריק)",
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
  // LAUNCH POLISH — the server's state-machine refusal (the deal is no longer
  // in the state the action requires). Cancel has its own, more specific copy.
  STATE_CONFLICT: "מצב העסקה השתנה בינתיים — רעננו את המסך ונסו שוב",
  // P0.3 — chat
  chat_closed: "הצ׳אט סגור בעסקה זו",
  chat_reply_target_not_found: "ההודעה שאליה ניסיתם להגיב כבר לא זמינה",
  invalid_reaction: "התגובה אינה תקינה",
  reaction_identity_required: "לא ניתן להגיב כרגע — רעננו את הדף ונסו שוב",
  // P0.3 — join payment method
  payment_method_invalid: "יש לבחור אמצעי תשלום: כרטיס אשראי או bit",
  // P0.3 — business profile
  business_profile_email_invalid: "אחת מכתובות האימייל בפרופיל העסקי אינה תקינה",
  bank_account_invalid: "מספר חשבון הבנק אינו תקין",
  // P0.7 — internal inquiries + pickup readiness
  inquiry_name_required: "יש להזין שם",
  inquiry_email_invalid: "יש להזין כתובת אימייל תקינה",
  inquiry_message_too_short: "כתבו למוכר כמה מילים (לפחות 3 תווים)",
  inquiry_message_too_long: "ההודעה ארוכה מדי (עד 2000 תווים)",
  inquiry_rate_limited: "נשלחו יותר מדי פניות בשעה האחרונה — נסו שוב מאוחר יותר",
  inquiry_deal_unavailable: "העסקה אינה זמינה לפניות",
  inquiry_not_found: "הפנייה לא נמצאה",
  pickup_location_required: "לאיסוף עצמי / נקודת חלוקה חסרה כתובת או מיקום — עדכנו באפשרויות האספקה לפני הפרסום",
  // LAUNCH POLISH 2 — buyer join refusals answered in product Hebrew (the
  // canonical codes stay internal; the buyer reads what happened + what to do)
  joining_paused_by_admin: "ההצטרפות מושהית זמנית — נסו שוב מאוחר יותר",
  delivery_address_required: "נא למלא כתובת למשלוח",
  invalid_delivery_option: "אפשרות האספקה שנבחרה כבר אינה זמינה — רעננו את הדף ובחרו שוב",
  payment_disclosure_required: "נדרש אישור הבהרת התשלום",
  payment_authorization_required: "לא ניתן להשלים את ההצטרפות כרגע — נסו שוב בעוד רגע",
  delivery_notes_too_long: "ההערות ארוכות מדי (עד 200 תווים)",
  // LAUNCH POLISH 2 — buyer feedback
  feedback_category_invalid: "יש לבחור אחת מהאפשרויות",
  feedback_text_too_long: "הטקסט ארוך מדי (עד 280 תווים)",
  feedback_rate_limited: "תודה — המשוב לעסקה הזו כבר התקבל",
  feedback_deal_unavailable: "העסקה אינה זמינה"
};

const PATTERN_MESSAGES: [RegExp, string][] = [
  // LAUNCH POLISH 2 — the join route's code-less refusals (409 "deal is not
  // open for joining", inventory exhaustion, missing buyer id)
  [/not open for joining/i, "ההצטרפות לעסקה נסגרה בינתיים — רעננו את הדף לסטטוס העדכני"],
  [/exceeds available inventory|inventory_exhausted/i, "המלאי אזל בזמן ההצטרפות — נסו כמות קטנה יותר"],
  [/buyer_id required/i, "נא למלא טלפון נייד"],
  [/tracking_token_required/i, "הקישור אינו מלא — פתחו את הקישור המלא שקיבלתם"],
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
  423: "הפעולה מושהית זמנית — נסו שוב מאוחר יותר",
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
