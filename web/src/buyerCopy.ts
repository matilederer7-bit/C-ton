// ── LAUNCH POLISH 2 — shared buyer-facing copy ─────────────────────────────
// Every export here is a TRANSLATION KEY, not a sentence: this module is
// evaluated once at import, so holding resolved copy would freeze whichever
// language happened to be active at boot. Render paths call `t(...)`; the CMS
// default builders resolve each key in BOTH languages.
// ONE place for the sentences a brand-new buyer needs within ten seconds
// (what Siton is, why the price is lower, what happens when the target is
// missed) and for the two honesty lines the pilot must carry (mock money, no
// e-mail/SMS delivery). Nothing here invents a guarantee: every sentence
// describes canonical behaviour of the deal state machine.
// Explicit .js specifier: this module is also loaded by the backend content
// templates (src/content/cmsTemplates → src/site_content.ts) under Node ESM
// resolution, which requires the extension. Vite resolves it to the .ts source.
import { getPreviewMeta } from "./previewMeta.js";
import { t } from "./i18n/index.js";

export const PRODUCT_NAME_KEY = "buyer_copy.product_name";

// One line at the very top of the deal page: WHAT this is + WHY the price is
// lower + WHAT happens if the group is not reached.
export const DEAL_EXPLAINER_KEY = "buyer_copy.deal_explainer";

export const WHY_GROUP_PRICE_KEY = "buyer_copy.why_group_price";

export const HOW_IT_WORKS_KEYS = [
  { n: "1", title: "buyer_copy.how_it_works.title", body: "buyer_copy.how_it_works.body" },
  { n: "2", title: "buyer_copy.how_it_works.title_2", body: "buyer_copy.how_it_works.body_2" },
  { n: "3", title: "buyer_copy.how_it_works.title_3", body: "buyer_copy.how_it_works.body_3" }
];

// What happens after the buyer taps the CTA — said BEFORE the tap.
export const AFTER_TAP_LINE_KEY = "buyer_copy.after_tap_line";

// Mock-money disclosure for the closed pilot. The runtime reports
// `payment_is_real: false` (/api/preview/meta guardrails); this sentence is
// shown while that is the case and says nothing about the future.
export const PILOT_MOCK_MONEY_LINE_KEY = "buyer_copy.pilot_mock_money_line";

// Truthful notification statement — read from the runtime, never assumed.
// The hosted pilot delivers no external e-mail/SMS (log-only rail), so the
// buyer is told to keep the tracking link. If external delivery is ever
// switched on, the sentence changes by itself.
export const NOTIFICATIONS_OFF_LINE_KEY = "buyer_copy.notifications_off_line";
export const NOTIFICATIONS_ON_LINE_KEY = "buyer_copy.notifications_on_line";
/** The truthful notification sentence, resolved in the active language. */
export async function notificationsLine(): Promise<string> {
  try {
    const meta = await getPreviewMeta();
    return t(meta?.preview?.guardrails?.notifications_are_real ? NOTIFICATIONS_ON_LINE_KEY : NOTIFICATIONS_OFF_LINE_KEY);
  } catch {
    return t(NOTIFICATIONS_OFF_LINE_KEY);
  }
}

// The inquiry privacy promise (canonical: contact stays in the product).
export const INQUIRY_PRIVACY_LINE_KEY = "buyer_copy.inquiry_privacy_line";

// Share loop headline after a join.
export const SHARE_LOOP_TITLE_KEY = "buyer_copy.share_loop_title";

// ── LAUNCH SPRINT 3 — physical pickup credential ───────────────────────────
// Shown only when the server says the order is canonically eligible (deal
// completed, buyer completed, money settled). The QR carries a locator only.
export const PICKUP_SHOW_TO_SELLER_LINE_KEY = "buyer_copy.pickup_show_to_seller_line";
export const PICKUP_SCREENSHOT_LINE_KEY = "buyer_copy.pickup_screenshot_line";
export const PICKUP_DELIVERY_LINE_KEY = "buyer_copy.pickup_delivery_line";
