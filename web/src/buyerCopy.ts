// ── LAUNCH POLISH 2 — shared buyer-facing copy ─────────────────────────────
// ONE place for the sentences a brand-new buyer needs within ten seconds
// (what Siton is, why the price is lower, what happens when the target is
// missed) and for the two honesty lines the pilot must carry (mock money, no
// e-mail/SMS delivery). Nothing here invents a guarantee: every sentence
// describes canonical behaviour of the deal state machine.
import { getPreviewMeta } from "./previewMeta";

export const PRODUCT_NAME_HE = "סיטון";

// One line at the very top of the deal page: WHAT this is + WHY the price is
// lower + WHAT happens if the group is not reached.
export const DEAL_EXPLAINER = "קנייה קבוצתית: המחיר הקבוצתי תקף רק אם מספיק אנשים מצטרפים עד מועד הסיום. לא הגיעו ליעד — אף אחד לא משלם.";

export const WHY_GROUP_PRICE = "המחיר נמוך כי קונים ביחד — המוכר מוכר בכמות, ואתם משלמים פחות.";

export const HOW_IT_WORKS = [
  { n: "1", title: "מצטרפים", body: "בוחרים כמות ומאשרים. נתפסת מסגרת אשראי בלבד — בלי חיוב." },
  { n: "2", title: "הקבוצה מתמלאת", body: "כשמספיק אנשים מצטרפים עד מועד הסיום, העסקה יוצאת לפועל — ורק אז מתבצע החיוב." },
  { n: "3", title: "לא הגיעו ליעד?", body: "המסגרת של כולם משתחררת אוטומטית. אף אחד לא משלם." }
];

// What happens after the buyer taps the CTA — said BEFORE the tap.
export const AFTER_TAP_LINE = "בלחיצה נפתח טופס קצר (שם וטלפון). נתפסת מסגרת בלבד — לא חיוב. מיד אחר כך מקבלים קישור למסך מעקב אישי.";

// Mock-money disclosure for the closed pilot. The runtime reports
// `payment_is_real: false` (/api/preview/meta guardrails); this sentence is
// shown while that is the case and says nothing about the future.
export const PILOT_MOCK_MONEY_LINE = "פיילוט: בשלב זה לא מתבצע חיוב אמיתי ולא נדרש להזין כרטיס.";

// Truthful notification statement — read from the runtime, never assumed.
// The hosted pilot delivers no external e-mail/SMS (log-only rail), so the
// buyer is told to keep the tracking link. If external delivery is ever
// switched on, the sentence changes by itself.
export const NOTIFICATIONS_OFF_LINE = "בפיילוט לא נשלחים מסרונים או מיילים — שמרו את קישור המעקב, זו הדרך לחזור לעסקה.";
export const NOTIFICATIONS_ON_LINE = "נעדכן אתכם בהודעה כשמצב העסקה משתנה.";
export async function notificationsLine(): Promise<string> {
  try {
    const meta = await getPreviewMeta();
    return meta?.preview?.guardrails?.notifications_are_real ? NOTIFICATIONS_ON_LINE : NOTIFICATIONS_OFF_LINE;
  } catch {
    return NOTIFICATIONS_OFF_LINE;
  }
}

// The inquiry privacy promise (canonical: contact stays in the product).
export const INQUIRY_PRIVACY_LINE = `הפנייה עוברת דרך ${PRODUCT_NAME_HE} — פרטי הקשר של המוכר ושלכם לא נחשפים.`;

// Share loop headline after a join.
export const SHARE_LOOP_TITLE = "עזרו לעסקה להצליח — שתפו עם עוד אנשים";
