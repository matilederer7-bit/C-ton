// P0.7 — deterministic proof of the public deal presentation contracts:
//  • countdown parts: NO zero padding (1 not 01, 0 not 00, 9 not 09), four
//    units, deadline crossing settles at all-zero and never negative
//  • label ABOVE number in the rendered unit cell; compact four-column grid on
//    desktop; readable single-row layout on narrow phones
//  • the public deal page renders NO seller e-mail / mailto and opens the
//    internal "פנייה למוכר" sheet instead; the public route never selects or
//    returns support_email
//  • ONE pickup-location rule shared by server and web (the same module)
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  COUNTDOWN_UNITS, countdownAccessibleLabel, countdownParts, formatCountdownNumber, sameCountdownParts
} from "../web/src/countdown.js";
import {
  describePickupLocation, hasUsablePickupLocation, isPickupOptionType, pickupLocationText, pickupOptionsMissingLocation
} from "../src/pickup_location.js";

let passed = 0;
async function run(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { console.error(`FAIL ${name}`); throw error; }
}

const DAY = 86400_000, HOUR = 3600_000, MIN = 60_000, SEC = 1000;

await run("16: countdown numbers carry NO leading zeroes (1/7/4/9, 0 hours, 9 seconds)", () => {
  const p = countdownParts(1 * DAY + 7 * HOUR + 4 * MIN + 9 * SEC + 500);
  assert.deepEqual([p.days, p.hours, p.minutes, p.seconds], [1, 7, 4, 9]);
  assert.deepEqual(COUNTDOWN_UNITS.map((u) => formatCountdownNumber(p[u.key])), ["1", "7", "4", "9"]);
  assert.equal(formatCountdownNumber(0), "0");
  assert.equal(formatCountdownNumber(9), "9");
  assert.equal(formatCountdownNumber(23), "23");
  for (const n of [0, 1, 7, 9, 10, 59]) assert.doesNotMatch(formatCountdownNumber(n), /^0\d/, `padded: ${n}`);
  assert.doesNotMatch(formatCountdownNumber(5), /[^\d]/, "ASCII digits only");
});

await run("countdown buckets: >1 day, exactly 1 day, <1 day, <1 hour (urgent), <1 minute, 100 days", () => {
  assert.deepEqual(pick(countdownParts(3 * DAY + 2 * HOUR)), [3, 2, 0, 0]);
  assert.deepEqual(pick(countdownParts(1 * DAY)), [1, 0, 0, 0]);
  assert.deepEqual(pick(countdownParts(23 * HOUR + 59 * MIN + 59 * SEC)), [0, 23, 59, 59]);
  const urgent = countdownParts(59 * MIN + 30 * SEC);
  assert.deepEqual(pick(urgent), [0, 0, 59, 30]);
  assert.equal(urgent.urgent, true);
  assert.equal(countdownParts(2 * HOUR).urgent, false);
  assert.deepEqual(pick(countdownParts(45 * SEC + 999)), [0, 0, 0, 45]);
  assert.deepEqual(pick(countdownParts(100 * DAY)), [100, 0, 0, 0]);
  assert.equal(COUNTDOWN_UNITS.map((u) => u.label).join(" "), "ימים שעות דקות שניות");
});

await run("18: a crossed deadline settles at all-zero — never negative, never NaN", () => {
  for (const ms of [0, -1, -999, -5 * DAY, Number.NaN, Number.NEGATIVE_INFINITY]) {
    const p = countdownParts(ms);
    assert.deepEqual(pick(p), [0, 0, 0, 0], `remaining ${ms}`);
    assert.equal(p.reached, true);
    assert.equal(p.urgent, false);
    assert.ok(pick(p).every((n) => n >= 0 && Number.isFinite(n)));
    assert.deepEqual(COUNTDOWN_UNITS.map((u) => formatCountdownNumber(p[u.key])), ["0", "0", "0", "0"]);
  }
  assert.equal(countdownAccessibleLabel(countdownParts(-1)), "ההצטרפות הסתיימה");
  assert.match(countdownAccessibleLabel(countdownParts(DAY + 7 * HOUR + 4 * MIN + 9 * SEC)), /1 ימים, 7 שעות, 4 דקות ו-9 שניות/);
  assert.equal(sameCountdownParts(countdownParts(5 * SEC + 100), countdownParts(5 * SEC + 900)), true, "sub-second jitter does not re-render");
  assert.equal(sameCountdownParts(countdownParts(5 * SEC), countdownParts(4 * SEC)), false);
});

const [liveCountdown, stylesCss, dealPage, sellerPage, frontendRuntime, sellerAnalytics, appTs] = await Promise.all([
  readFile("web/src/livecountdown.tsx", "utf8"),
  readFile("web/src/styles.css", "utf8"),
  readFile("web/src/pages/deal.tsx", "utf8"),
  readFile("web/src/pages/seller.tsx", "utf8"),
  readFile("src/frontend_runtime.ts", "utf8"),
  readFile("src/seller_analytics.ts", "utf8"),
  readFile("src/app.ts", "utf8")
]);

await run("17: the rendered unit cell puts the LABEL above the NUMBER and uses the un-padded formatter", () => {
  const cell = liveCountdown.match(/<div className="cd-unit"[\s\S]*?<\/div>/);
  assert.ok(cell, "unit cell markup");
  const labelAt = cell![0].indexOf('className="cd-label"');
  const numAt = cell![0].indexOf('className="cd-num"');
  assert.ok(labelAt >= 0 && numAt > labelAt, "label must precede the number inside the cell");
  assert.match(cell![0], /formatCountdownNumber\(parts\[unit\.key\]\)/);
  assert.doesNotMatch(liveCountdown, /padStart/);
  assert.doesNotMatch(liveCountdown, /00:00:00/);
  assert.match(liveCountdown, /COUNTDOWN_UNITS\.map/);
  assert.match(liveCountdown, /role="timer"/);
  assert.match(liveCountdown, /aria-label=\{countdownAccessibleLabel\(parts\)\}/);
  assert.match(liveCountdown, /data-reached=/);
});

await run("19: countdown layout — four columns on desktop, column cells, narrow-phone rule, LTR digits", () => {
  assert.match(stylesCss, /\.live-countdown\s*\{[^}]*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(stylesCss, /\.cd-unit\s*\{[^}]*flex-direction:\s*column/);
  assert.match(stylesCss, /\.cd-label\s*\{[^}]*white-space:\s*nowrap/);
  assert.match(stylesCss, /\.cd-num\s*\{[^}]*direction:\s*ltr/);
  assert.match(stylesCss, /@media \(max-width: 420px\)\s*\{[^}]*\.live-countdown\s*\{[^}]*max-width:\s*100%/);
  assert.match(stylesCss, /\.cd-unit\s*\{[^}]*min-width:\s*0/);
});

await run("2: the public deal page renders NO seller e-mail and offers the internal inquiry instead", () => {
  assert.doesNotMatch(dealPage, /mailto:/);
  assert.doesNotMatch(dealPage, /support_email/);
  assert.match(dealPage, /data-testid="inquiry-open"/);
  assert.match(dealPage, /פנייה למוכר/);
  assert.match(dealPage, /הפנייה נשלחה למוכר דרך \{PRODUCT_NAME_HE\}\./);
  assert.match(dealPage, /const PRODUCT_NAME_HE = "סיטון";/);
  assert.doesNotMatch(dealPage, /הפנייה נשלחה למוכר דרך C-ton/, "the inquiry success sentence says סיטון");
  assert.match(dealPage, /api\.dealInquiry\(/);
  assert.match(dealPage, /className="hp-field"/, "honeypot field present");
  assert.match(dealPage, /data-testid="my-inquiries"/);
});

await run("PUBLIC_SELLER_PHONE: no phone / WhatsApp on the public page or in the public projection", () => {
  assert.doesNotMatch(dealPage, /support_phone/);
  assert.doesNotMatch(dealPage, /wa\.me|whatsapp|וואטסאפ/i);
  const projStart = frontendRuntime.indexOf("async function buildPublicDealPayload");
  const projEnd = frontendRuntime.indexOf('app.get("/api/deals/:id/public"', projStart);
  assert.ok(projStart > 0 && projEnd > projStart, "shared projection located");
  const projection = frontendRuntime.slice(projStart, projEnd);
  assert.doesNotMatch(projection, /support_phone|support_email|login_email|contact_phone/);
  assert.match(projection, /contact_channel: "siton_inquiry"/);
  // ONE projection serves both routes
  assert.match(frontendRuntime, /return deps\.withTx\(\(c\) => buildPublicDealPayload\(c, dealId, \{ requirePublished: true \}\)\);/);
  assert.match(frontendRuntime, /buildPublicDealPayload\(c, dealId, \{ requirePublished: false, sellerId: sellerContext\.seller_id \}\)/);
});

await run("DRAFT PREVIEW: same renderer in read-only mode — no join/share/chat/inquiry, no funnel or share-visit events", () => {
  assert.match(dealPage, /preview \? api\.sellerDealPreview\(dealId\) : api\.deal\(dealId\)/);
  assert.match(dealPage, /if \(!preview\) \{\s*\n\s*\/\/ real public traffic only[^\n]*\n\s*sendFunnelEvent\(dealId, "deal_view"/);
  assert.match(dealPage, /data-testid="preview-banner"/);
  assert.match(dealPage, /data-testid="join-open" disabled=\{preview\}/);
  assert.match(dealPage, /data-testid="share-preview-note"/);
  assert.match(dealPage, /canWrite=\{!preview && OPEN_STATES\.includes\(state\)\}/);
  assert.match(dealPage, /data-testid="inquiry-open" onClick=\{onOpen\} disabled=\{preview\}/);
  assert.match(dealPage, /const state = preview && rawState === "Draft" \? "PendingTarget" : rawState;/);
  assert.equal((dealPage.match(/<LiveCountdown deadline=\{deal\.deadline\}/g) || []).length, 1, "one countdown component for public and preview");
  assert.match(sellerPage, /sub\[2\] === "preview"\) return <DealPage dealId=\{sub\[1\]\} navigate=\{navigate\} preview \/>/);
  assert.match(sellerPage, /href=\{`#\/seller\/deal\/\$\{dealId\}\/preview`\}/);
});

await run("1: the public deal route neither selects nor returns support_email", () => {
  const start = frontendRuntime.indexOf("async function buildPublicDealPayload");
  const end = frontendRuntime.indexOf("// ── P0.7 — internal buyer → seller inquiries", start);
  assert.ok(start > 0 && end > start, "public route block located");
  const block = frontendRuntime.slice(start, end);
  assert.doesNotMatch(block, /support_email/);
  assert.match(block, /contact_channel: "siton_inquiry"/);
  assert.match(block, /\.\.\.describePickupLocation\(row\)/);
  // the inquiry never trusts a browser-supplied seller id
  const inquiryStart = frontendRuntime.indexOf('app.post("/api/deals/:dealId/inquiries"');
  const inquiryBlock = frontendRuntime.slice(inquiryStart, frontendRuntime.indexOf('app.get("/api/inquiries/:threadId"', inquiryStart));
  assert.doesNotMatch(inquiryBlock, /body\.seller_id/);
  assert.match(inquiryBlock, /COALESCE\(d\.seller_id, \$2\) AS seller_id/);
});

await run("11+12: pickup renderer — location line under pickup options only, both open and closed states, neutral legacy fallback", () => {
  assert.match(dealPage, /function PickupLocationLine/);
  assert.match(dealPage, /if \(!isPickupOptionType\(option\.option_type\)\) return null;/);
  assert.match(dealPage, /data-testid="pickup-location-fallback"/);
  assert.doesNotMatch(dealPage, /business_address/, "never falls back to a seller profile address");
  const openUses = (dealPage.match(/<PickupLocationLine option=\{o\} showNav=\{o\.option_id === deliveryId\} \/>/g) || []).length;
  const closedUses = (dealPage.match(/<PickupLocationLine option=\{o\} showNav \/>/g) || []).length;
  assert.equal(openUses, 1, "open-state option list renders the location line");
  assert.equal(closedUses, 1, "closed-state summary renders the same line");
  assert.match(dealPage, /<FulfillmentSummary options=\{deliveryOptions\} \/>/);
  assert.doesNotMatch(dealPage, /toFixed\(4\)/, "raw lat/lng are never dumped on the public page");
});

await run("13: publish readiness — server gate + checklist + wizard all use the ONE shared rule", () => {
  assert.match(appTs, /pickup_location_required/);
  assert.match(appTs, /import \{ pickupOptionsMissingLocation \} from "\.\/pickup_location\.js";/);
  assert.match(sellerPage, /from "\.\.\/\.\.\/\.\.\/src\/pickup_location"/);
  assert.match(sellerPage, /label: "מיקום לאיסוף עצמי"/);
  assert.match(sellerPage, /deliveryOptions\.every\(\(o\) => hasUsablePickupLocation\(o\)\)/);
  assert.match(sellerPage, /configured\.some\(\(d\) => !hasUsablePickupLocation\(d\)\)/);
  assert.match(sellerPage, /data-testid="pickup-location-missing"/);
  assert.match(sellerAnalytics, /pickup_location_missing/);
  assert.match(sellerAnalytics, /customer_inquiries_unread/);
  assert.match(dealPage, /from "\.\.\/\.\.\/\.\.\/src\/pickup_location"/, "public renderer imports the same module");
});

await run("pickup rule: generic labels are not locations; address text or coordinates are; delivery needs nothing", () => {
  for (const label of ["איסוף עצמי", "  איסוף  עצמי ", "נקודת חלוקה", "pickup", "Self-Pickup", "", "   "]) {
    assert.equal(pickupLocationText({ option_type: "pickup", label }), null, `generic: ${JSON.stringify(label)}`);
    assert.equal(hasUsablePickupLocation({ option_type: "pickup", label }), false);
  }
  assert.equal(pickupLocationText({ option_type: "pickup", label: "רח׳ הרצל 12, תל אביב" }), "רח׳ הרצל 12, תל אביב");
  assert.equal(pickupLocationText({ option_type: "distribution_point", label: "  נקודת חלוקה — כפר יהושע " }), "נקודת חלוקה — כפר יהושע");
  assert.equal(hasUsablePickupLocation({ option_type: "pickup", label: "איסוף עצמי", latitude: 32.1, longitude: 34.8 }), true);
  assert.equal(hasUsablePickupLocation({ option_type: "pickup", label: "איסוף עצמי", latitude: "32.1", longitude: "34.8" }), true);
  assert.equal(hasUsablePickupLocation({ option_type: "pickup", label: "איסוף עצמי", latitude: 999, longitude: 34.8 }), false);
  assert.equal(hasUsablePickupLocation({ option_type: "delivery", label: "" }), true);
  assert.equal(isPickupOptionType("distribution_point"), true);
  assert.equal(isPickupOptionType("delivery"), false);
  assert.deepEqual(
    describePickupLocation({ option_type: "pickup", label: "איסוף עצמי", latitude: 31.7683, longitude: 35.2137 }),
    { location_text: null, has_location: true, map_url: "https://www.google.com/maps/search/?api=1&query=31.7683,35.2137" }
  );
  assert.deepEqual(describePickupLocation({ option_type: "delivery", label: "משלוח" }), { location_text: null, has_location: false, map_url: null });
  const missing = pickupOptionsMissingLocation([
    { option_type: "pickup", label: "איסוף עצמי" },
    { option_type: "pickup", label: "הרצל 1" },
    { option_type: "delivery", label: "" }
  ]);
  assert.equal(missing.length, 1);
});

function pick(p: { days: number; hours: number; minutes: number; seconds: number }) {
  return [p.days, p.hours, p.minutes, p.seconds];
}

console.log(`\nP07_FRONTEND_RESULT passed=${passed}`);
