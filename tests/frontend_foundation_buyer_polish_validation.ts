// LAUNCH POLISH 2 — buyer conversion / trust / feedback / share loop: source
// pins for the rules that keep the buyer surfaces truthful and safe.
//  * the deal page answers the ten-second questions from canonical fields only
//  * trust facts are the ones the backend proves (approved boolean), no invented
//    ratings / guarantees / refund promises
//  * the join sheet marks required fields, explains the tap before the tap,
//    keeps typed data on refusal, and never sends PII to the funnel rail
//  * success + tracking say honestly that no e-mail/SMS is sent in the pilot
//  * the share loop uses the canonical /d/:id route and exactly one copy control
//  * feedback has no structured PII fields (optional free text is user-provided content) and is asked once per deal
//  * every closed state has a what-happened / what-next story
//  * landing carries the buyer entry + pilot disclosure and no legacy reference
import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";

let passed = 0;
let failed = 0;
function run(name: string, fn: () => void) {
  try { fn(); console.log(`PASS ${name}`); passed++; }
  catch (e: any) { console.error(`FAIL ${name}: ${e.message}`); failed++; }
}

const [dealPage, trackPage, landingPage, landingHe, appTsx, components, feedback, buyerCopy, he, styles, runtime, adminPage, viral] = await Promise.all([
  readFile("web/src/pages/deal.tsx", "utf8"),
  readFile("web/src/pages/track.tsx", "utf8"),
  readFile("web/src/pages/landing.tsx", "utf8"),
  readFile("web/src/content/landing.he.ts", "utf8"),
  readFile("web/src/App.tsx", "utf8"),
  readFile("web/src/components.tsx", "utf8"),
  readFile("web/src/feedback.tsx", "utf8"),
  readFile("web/src/buyerCopy.ts", "utf8"),
  readFile("web/src/he.ts", "utf8"),
  readFile("web/src/styles.css", "utf8"),
  readFile("src/frontend_runtime.ts", "utf8"),
  readFile("web/src/pages/admin.tsx", "utf8"),
  readFile("web/src/viral.ts", "utf8")
]);

run("P1: the deal page answers WHAT/WHY/WHAT-IF at the top and the needed/deadline facts from canonical fields", () => {
  assert.match(dealPage, /data-testid="deal-explainer">\{DEAL_EXPLAINER\}/);
  assert.match(buyerCopy, /DEAL_EXPLAINER = "קנייה קבוצתית: המחיר הקבוצתי תקף רק אם מספיק אנשים מצטרפים עד מועד הסיום\. לא הגיעו ליעד — אף אחד לא משלם\."/);
  assert.match(dealPage, /data-testid="deal-why">\{WHY_GROUP_PRICE\}/);
  assert.match(dealPage, /price-was-label">מחיר רגיל</, "the strike-through price is labelled");
  assert.match(dealPage, /data-testid="deal-saving-amount">חוסכים \{ils\(listPrice - Number\(deal\.price_per_unit\)\)\} ליחידה/);
  assert.match(dealPage, /const hasSaving = listPrice > Number\(deal\.price_per_unit\);/, "saving shown only when the seller gave a higher regular price");
  assert.match(dealPage, /data-testid="deal-needed" data-units-to-target=\{unitsToTarget\}/);
  assert.match(dealPage, /const unitsToTarget = Math\.max\(0, Number\(deal\.threshold_units\) - joined\);/);
  assert.match(dealPage, /data-testid="deal-deadline-abs">עד \{deadlineText\}/);
  assert.match(dealPage, /const deadlineText = formatIsraelDateTime\(deal\.deadline\);/, "absolute deadline in Israel time next to the countdown");
  assert.match(dealPage, /data-testid="how-it-works"/);
  assert.equal((buyerCopy.match(/\{ n: "\d", title:/g) || []).length, 3, "three how-it-works steps");
  assert.match(buyerCopy, /לא הגיעו ליעד\?.*המסגרת של כולם משתחררת אוטומטית\. אף אחד לא משלם\./);
});

run("P1: the phone CTA bar exists only for an open deal outside preview, mirrors the real CTA, and is hidden on desktop by CSS", () => {
  assert.match(dealPage, /\{isOpen && !preview \? \(\s*<StickyJoinBar anchor=\{ctaEl\} enabled=\{!joining && !joinResult && !inquiryOpen\}/);
  assert.match(dealPage, /data-testid="join-open-sticky"[^>]*onClick=\{onJoin\}/);
  assert.match(dealPage, /onJoin=\{startJoin\}/, "the sticky bar fires the SAME join start (funnel event + sheet)");
  assert.match(dealPage, /const startJoin = \(\) => \{ if \(preview\) return; if \(!receiptReady\) \{ showToast\("[^"]+"\); return; \} sendFunnelEvent\(dealId, "join_started"\); setJoining\(true\); \};/, "both join entry points require receipt information before opening the sheet");
  assert.match(dealPage, /<DealReceiptInfo dealId=\{dealId\} onReady=\{setReceiptReady\} \/>/);
  assert.match(styles, /\.sticky-cta \{ display: none; \}/);
  assert.match(styles, /@media \(max-width: 860px\) \{\s*\n\s*\.sticky-cta \{\s*\n\s*position: fixed; bottom: 0;/);
  assert.match(dealPage, /setOffscreen\(!entry\.isIntersecting\)/, "shown only while the real CTA is off-screen");
});

run("P2: trust = facts the backend proves — approved boolean on the projection, badge gated on it; no ratings/reviews/guarantees invented", () => {
  const projStart = runtime.indexOf("async function buildPublicDealPayload");
  const projEnd = runtime.indexOf('app.get("/api/deals/:id/public"', projStart);
  const projection = runtime.slice(projStart, projEnd);
  assert.match(projection, /approved: String\(\(deal as any\)\.verification_status \|\| ""\) === "approved",/);
  assert.doesNotMatch(projection.replace(/\/\/[^\n]*/g, ""), /verification_status:|approved_at|reviewer/, "only the boolean is projected");
  assert.match(dealPage, /\{seller\.approved \? <span className="trust-badge" data-testid="seller-approved"/);
  assert.match(dealPage, /data-testid="seller-approved-panel"/);
  for (const forbidden of [/דירוג/, /ביקורות/, /ערבות/, /ביטוח/, /החזר מובטח/, /תשלום מובטח/, /⭐/]) {
    assert.doesNotMatch(dealPage, forbidden, `invented trust claim on the deal page: ${forbidden}`);
    assert.doesNotMatch(trackPage, forbidden, `invented trust claim on the tracking page: ${forbidden}`);
  }
  assert.match(dealPage, /INQUIRY_PRIVACY_LINE/);
  assert.match(buyerCopy, /INQUIRY_PRIVACY_LINE = `הפנייה עוברת דרך \$\{PRODUCT_NAME_HE\} — פרטי הקשר של המוכר ושלכם לא נחשפים\.`/);
});

run("P2/P3: the pilot mock-money disclosure is explicit on the deal, the sheet, the success moment and the tracking page — and describes the present only", () => {
  assert.match(buyerCopy, /PILOT_MOCK_MONEY_LINE = "פיילוט: בשלב זה לא מתבצע חיוב אמיתי ולא נדרש להזין כרטיס\."/);
  assert.doesNotMatch(buyerCopy, /בקרוב|לעולם|תמיד/, "no promise about the future");
  assert.match(dealPage, /data-testid="pilot-line">🧪 \{PILOT_MOCK_MONEY_LINE\}/);
  assert.match(dealPage, /data-testid="pay-pilot-note">🧪 \{PILOT_MOCK_MONEY_LINE\}/);
  assert.match(dealPage, /data-testid="join-foot-line">[\s\S]{0,80}\{PILOT_MOCK_MONEY_LINE\}/);
  assert.match(dealPage, /data-testid="join-success-facts"[\s\S]{0,400}\{PILOT_MOCK_MONEY_LINE\}/);
  assert.match(trackPage, /\{PILOT_MOCK_MONEY_LINE\}/);
});

run("P3: join sheet — required markers, per-field Hebrew errors, plausible-phone rule, tap explained before the tap, typed data kept on refusal, legal acceptance unchanged", () => {
  assert.match(dealPage, /<span className="req" aria-hidden="true">\*<\/span> שדה חובה/);
  for (const key of ["name", "phone", "email", "address", "disclosure", "terms"]) {
    assert.match(dealPage, new RegExp(`errs\\.${key} = "`), `field-level error for ${key}`);
  }
  assert.match(dealPage, /data-testid=\{`join-error-\$\{key\}`\} role="alert"/);
  assert.match(dealPage, /export function isPlausiblePhone\(raw: string\): boolean \{\s*\n\s*const p = normalizePhone\(raw\);\s*\n\s*return \/\^0\\d\{8,9\}\$\/\.test\(p\) \|\| \/\^\\\+\?972\\d\{8,9\}\$\/\.test\(p\);/);
  assert.match(dealPage, /data-testid="join-what-next"/);
  assert.match(buyerCopy, /AFTER_TAP_LINE = "בלחיצה נפתח טופס קצר \(שם וטלפון\)\. נתפסת מסגרת בלבד — לא חיוב\. מיד אחר כך מקבלים קישור למסך מעקב אישי\."/);
  assert.match(dealPage, /data-testid="after-tap">\{AFTER_TAP_LINE\}/);
  // refusal kinds each carry a what-next, and the form is NOT reset on failure
  for (const kind of ["stock", "state", "network", "other", "fields"]) assert.match(dealPage, new RegExp(`kind: "${kind}"`), `refusal kind ${kind}`);
  assert.match(dealPage, /data-testid="join-refusal-refresh"/);
  assert.match(dealPage, /data-testid="join-refusal-back"/);
  const catchBlock = dealPage.slice(dealPage.indexOf("} catch (err: any) {\n      // LAUNCH MODE — a refused join"), dealPage.indexOf("const field = (key: string"));
  assert.doesNotMatch(catchBlock, /setName\(""\)|setPhone\(""\)|setEmail\(""\)|setAddress\(""\)/, "a refused join keeps what was typed");
  // buyer identity remembered on the buyer's own device only
  assert.match(dealPage, /const BUYER_IDENTITY_KEY = "siton_buyer_identity_v1";/);
  assert.match(dealPage, /storeBuyerIdentity\(name\.trim\(\), normalizePhone\(phone\), email\.trim\(\)\);/);
  // legal + disclosure acceptance still required and still sent as before
  assert.match(dealPage, /if \(!disclosure\) errs\.disclosure = "יש לאשר את הבהרת התשלום";/);
  assert.match(dealPage, /if \(!terms\) errs\.terms = "יש לאשר את התקנון";/);
  assert.match(dealPage, /buyer_terms_accepted: true,\s*\n\s*payment_disclosure_accepted: true,/);
  assert.match(dealPage, /payment_method: payMethod,/, "payment-method preference unchanged");
  assert.match(dealPage, /href="\/legal\/terms"/);
  // the refusal funnel event carries the code/status only — never a field value
  assert.match(dealPage, /sendFunnelEvent\(String\(deal\.deal_id\), "join_failed", \{ detail: String\(code \|\| status \|\| "unknown"\)\.slice\(0, 80\) \}\);/);
});

run("P3: every join refusal the server can emit has product Hebrew (codes + the code-less 409 + 423)", () => {
  for (const code of ["joining_paused_by_admin", "delivery_address_required", "invalid_delivery_option", "payment_disclosure_required", "payment_authorization_required", "delivery_notes_too_long", "max_units_exceeded"]) {
    assert.match(he, new RegExp(`^  ${code}: "[^"]+",?$`, "m"), `Hebrew for ${code}`);
  }
  assert.match(he, /\[\/not open for joining\/i, "ההצטרפות לעסקה נסגרה בינתיים — רעננו את הדף לסטטוס העדכני"\]/);
  assert.match(he, /\[\/exceeds available inventory\|inventory_exhausted\/i, /);
  assert.match(he, /423: "הפעולה מושהית זמנית — נסו שוב מאוחר יותר"/);
  assert.doesNotMatch(he, /"[A-Z_]{6,}"\s*$/m, "no raw code strings shown as messages");
});

run("P4: success moment — joined facts, live progress after THIS join, tracking link first with copy, honest notification line, then share, then feedback, then ask-seller", () => {
  const success = dealPage.slice(dealPage.indexOf("function JoinSuccess"), dealPage.indexOf("function StickyJoinBar"));
  const order = ["join-success-facts", "join-success-progress", "join-success-track-link", "join-success-copy-track", "join-success-notif", "join-success-share", "<FeedbackPrompt", "join-success-ask-seller"];
  let last = -1;
  for (const marker of order) { const at = success.indexOf(marker); assert.ok(at > last, `success order: ${marker}`); last = at; }
  assert.match(success, /api\.activity\(String\(deal\.deal_id\)\)\.then\(setLive\)/, "one authoritative read so the meter includes the new join");
  assert.match(success, /notificationsLine\(\)\.then\(setNotifLine\)/);
  assert.match(success, /surface="join_success"/);
  assert.match(success, /<ShareActions layout="loop" dealId=\{deal\.deal_id\} title=\{deal\.title\} price=\{Number\(deal\.price_per_unit\)\} code=\{shareCode\}/);
});

run("P4: the notification statement is read from the runtime, never assumed; the OFF line tells the buyer to keep the tracking link", () => {
  assert.match(buyerCopy, /meta\?\.preview\?\.guardrails\?\.notifications_are_real \? NOTIFICATIONS_ON_LINE : NOTIFICATIONS_OFF_LINE/);
  assert.match(buyerCopy, /NOTIFICATIONS_OFF_LINE = "בפיילוט לא נשלחים מסרונים או מיילים — שמרו את קישור המעקב, זו הדרך לחזור לעסקה\."/);
  assert.match(runtime, /notifications_are_real: deps\.notificationSummary\.external_delivery/, "the server flag is the real delivery switch");
  assert.match(trackPage, /data-testid="track-notif-line">\{notifLine\}/);
  assert.match(trackPage, /notificationsLine\(\)\.then\(setNotifLine\)/);
  for (const src of [dealPage, trackPage]) assert.doesNotMatch(src, /נשלח לך מייל|נשלחה הודעת SMS|שלחנו לך/, "no invented notification");
});

run("P4/P7: tracking page — what still has to happen, deadline in Israel time, copy-link, back to the deal, ask the seller through Siton with the privacy line", () => {
  assert.match(trackPage, /function nextSteps\(t: Json\): string\[\]/);
  assert.match(trackPage, /data-testid="track-next"/);
  assert.match(trackPage, /const deadlineText = formatIsraelDateTime\(t\.deadline\);/);
  assert.match(trackPage, /data-testid="track-copy-link" onClick=\{copyHere\}/);
  assert.match(trackPage, /data-testid="track-deal-link" href=\{dealHash\}/);
  assert.match(trackPage, /const askHash = `#\/deal\/\$\{t\.deal_id\}\?inquiry=1`;/);
  assert.match(trackPage, /data-testid="track-ask-seller" href=\{askHash\}/);
  assert.match(trackPage, /\{INQUIRY_PRIVACY_LINE\} התשובה מופיעה בדף העסקה תחת ״הפניות שלי״\./);
  assert.match(appTsx, /openInquiry=\{route\.query\.get\("inquiry"\) === "1"\}/);
  assert.match(dealPage, /if \(openInquiry && payload && !preview\) \{\s*\n\s*sendFunnelEvent\(dealId, "inquiry_started", \{ once_key: sessionId\(\) \}\);\s*\n\s*setInquiryOpen\(true\);/);
  assert.match(dealPage, /data-testid="inquiry-open-top" onClick=\{startInquiry\}/, "ask-the-seller entry at the top of the deal page");
  assert.match(dealPage, /data-testid="inquiry-open-cta" onClick=\{startInquiry\}/, "ask-the-seller entry next to the CTA");
  assert.match(dealPage, /data-testid="closed-ask-seller" onClick=\{startInquiry\}/, "ask-the-seller entry on every closed state");
  assert.doesNotMatch(trackPage, /mailto:|support_email|support_phone|wa\.me/, "no seller contact detail on the tracking page");
});

run("P5: share loop — canonical /d/:id URL with the personal code, messaging channel leads in loop layout, exactly ONE copy control, every share tracked", () => {
  assert.match(viral, /return `\$\{window\.location\.origin\}\/d\/\$\{dealId\}\$\{ref\}`;/);
  assert.match(components, /const loop = props\.layout === "loop";/);
  assert.match(components, /data-testid="share-whatsapp" href=\{whatsappHref\}[^>]*\n?\s*onClick=\{\(\) => track\("whatsapp"\)\}/);
  assert.match(components, /\.\.\.\(loop \? \[\] : \[\{ key: "whatsapp"/, "the lead channel is not duplicated in the icon row");
  assert.equal((components.match(/data-testid="share-copy"/g) || []).length, 1, "exactly one copy control per share context");
  assert.match(components, /const track = \(channel: string\) => sendFunnelEvent\(props\.dealId, "share_button_click", \{ share_channel: channel \}\);/);
  assert.match(components, /מחיר קבוצתי \$\{ils\(props\.price\)\} ליחידה\. העסקה יוצאת לפועל רק אם מספיק אנשים מצטרפים\./, "the message states the rule, not a guarantee");
  assert.match(buyerCopy, /SHARE_LOOP_TITLE = "עזרו לעסקה להצליח — שתפו עם עוד אנשים"/);
  assert.match(trackPage, /layout="loop"/);
  const shareBlock = components.slice(components.indexOf("export function ShareActions"), components.indexOf("export function SkeletonCards"));
  assert.doesNotMatch(shareBlock, /setInterval|setTimeout|prompt\(|confirm\(/, "no nagging, no forced share");
});

run("P6: feedback — one question, fixed categories, bounded text, PII-free payload, once per deal, stored on the existing rail (no migration), aggregated for the owner", () => {
  assert.match(feedback, /היה משהו שלא היה ברור\?/);
  assert.equal((feedback.match(/\{ key: "[a-z_]+", label: "/g) || []).length, 6, "six visible categories");
  assert.match(feedback, /export const FEEDBACK_TEXT_MAX = 280;/);
  assert.match(feedback, /await api\.dealFeedback\(dealId, \{\s*\n\s*category: cat,\s*\n\s*text: [^\n]+\n\s*surface,\s*\n\s*website\s*\n\s*\}\);/, "payload = category + text + surface + honeypot, nothing else");
  assert.doesNotMatch(feedback.replace(/\/\/[^\n]*/g, ""), /participant|phone|buyer_id|email:/i, "no identity on the feedback payload");
  assert.match(feedback, /const STORE_KEY = "siton_feedback_v1";/);
  assert.match(feedback, /if \(done\) \{/, "asked once per deal per browser");
  assert.match(feedback, /בלי פרטים אישיים/);
  assert.match(runtime, /app\.post\("\/api\/deals\/:dealId\/feedback"/);
  const route = runtime.slice(runtime.indexOf('app.post("/api/deals/:dealId/feedback"'), runtime.indexOf('app.post("/api/viral/events"'));
  assert.match(route, /VALUES \('Other', 'Closed', 'Low', 'Buyer', \$1, \$2, 'buyer_feedback'/);
  assert.doesNotMatch(route, /buyer_ref|participant_id|buyer_id|body\.name|body\.phone|body\.email/, "the route neither reads nor stores identity");
  assert.match(runtime, /const BUYER_FEEDBACK_TEXT_MAX = 280;/);
  assert.match(route, /text\.length > BUYER_FEEDBACK_TEXT_MAX/);
  assert.match(route, /Number\(limits\.per_deal \|\| 0\) >= 60 \|\| Number\(limits\.total \|\| 0\) >= 200/);
  assert.match(route, /String\(body\.website \|\| ""\)\.trim\(\)/, "honeypot");
  assert.match(runtime, /feedback: \{\s*\n\s*total: feedbackByCategory\.rows\.reduce/);
  assert.match(adminPage, /data-testid="pilot-feedback"/);
  assert.match(trackPage, /surface="tracking"/);
});

run("P8: every non-joinable state has a what-happened / what-next story; expiry while open is 'awaiting decision', a seller pause is 'temporarily paused'", () => {
  for (const key of ["sold_out", "awaiting_decision", "paused", "closing", "completion_window", "completed", "failed", "cancelled"]) {
    assert.match(dealPage, new RegExp(`key: "${key}", title: "`), `closed story ${key}`);
  }
  assert.match(dealPage, /if \(OPEN_STATES\.includes\(state\) && deadlinePassed\) return \{\s*\n\s*key: "awaiting_decision"/);
  assert.match(dealPage, /if \(state === "ClosedForJoining" && !deadlinePassed\) return \{\s*\n\s*key: "paused"/);
  assert.match(dealPage, /data-testid="closed-story" data-story=\{story\?\.key \|\| "closed"\}/);
  assert.match(dealPage, /data-testid="closed-refresh"/);
  // load failures: network vs gone, with a retry / support way out
  assert.match(dealPage, /const kind = status === 404 \? "gone" : !status \? "network" : status === 429 \|\| status >= 500 \? "busy" : "other";/);
  assert.match(dealPage, /data-testid="deal-retry"/);
  assert.match(trackPage, /else if \(status === 429 \|\| status >= 500\) setError\(\{ kind: "busy"/);
  assert.match(trackPage, /if \(status === 401 \|\| status === 403\) setError\(\{ kind: "link"/);
  assert.match(trackPage, /else if \(status === 404\) setError\(\{ kind: "gone"/);
  assert.match(trackPage, /data-testid="track-retry"/);
  // an invalid stored inquiry token is forgotten, never a silent hole
  assert.match(dealPage, /if \(\[401, 403, 404\]\.includes\(Number\(err\?\.status\)\)\) \{ forgetInquiry\(dealId, it\.thread_id\); setStale\(true\); \}/);
  assert.match(dealPage, /data-testid="my-inquiries-stale"/);
  // no technical codes in primary UI copy
  for (const src of [dealPage, trackPage]) assert.doesNotMatch(src, />[^<{]*\b(STATE_CONFLICT|max_units_exceeded|deal_not_open_for_joining|tracking_token_required)\b[^<{]*</, "no raw code rendered as copy");
});

run("P9: landing — one-sentence explanation, buyer entry (deals list only while the Mall is enabled), seller CTA, pilot disclosure, no legacy reference, no production-payment claim", () => {
  assert.match(landingHe, /sub: "C-ton \(סיטון\) היא פלטפורמה לקנייה קבוצתית: /);
  assert.match(landingHe, /buyerEntry: \{/);
  assert.match(landingHe, /pilot: \{\s*\n\s*note: "פיילוט סגור — בשלב זה לא מתבצעים חיובים אמיתיים\."/);
  assert.match(landingPage, /data-testid="landing-buyer-entry"/);
  assert.match(landingPage, /\{mallEnabled \? \(\s*\n\s*<button className="btn btn-ghost btn-sm" data-testid="landing-open-deals" onClick=\{\(\) => navigate\("#\/deals"\)\}/);
  assert.match(landingPage, /data-testid="landing-pilot-note"/);
  assert.match(landingPage, /פתיחת חשבון מוכר/);
  assert.match(appTsx, /\{page === "deals" \? \(mallEnabled \? <Mall navigate=\{navigate\} \/> : <Landing navigate=\{navigate\} \/>\) : null\}/);
  assert.doesNotMatch(landingHe, /\/app\b|Base44|בייס44/, "no legacy product reference");
  assert.doesNotMatch(landingHe, /סליקה אמיתית|חיוב אמיתי מתבצע|PCI/, "no production-payment claim");
});

run("analytics: the pilot funnel stays on the existing rail — deal_view, join_started, join_failed, share_button_click, inquiry_started are emitted; no new event backend", () => {
  assert.match(dealPage, /sendFunnelEvent\(dealId, "deal_view", \{ once_key: sessionId\(\) \}\);/);
  assert.match(dealPage, /sendFunnelEvent\(dealId, "join_started"\)/);
  assert.match(dealPage, /"join_failed"/);
  assert.match(dealPage, /sendFunnelEvent\(dealId, "inquiry_started", \{ once_key: sessionId\(\) \}\)/);
  assert.match(components, /"share_button_click"/);
  assert.match(viral, /export type FunnelEventType = "deal_view" \| "share_button_click" \| "join_started" \| "join_failed" \| "inquiry_started";/, "no new funnel event type");
  assert.doesNotMatch(runtime.slice(runtime.indexOf('app.post("/api/deals/:dealId/feedback"')), /CREATE TABLE|ALTER TABLE/, "feedback route creates no schema");
});

console.log(`BUYER_POLISH_FOUNDATION passed=${passed} failed=${failed}`);
process.exit(failed ? 1 : 0);
