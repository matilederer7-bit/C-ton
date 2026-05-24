import assert from "node:assert/strict";
import { cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Keep this frontend-flow validation isolated from background deadline/outbox work.
process.env.DISABLE_OUTBOX_WORKER = "1";

const { app } = await import("../src/app.js");

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Resolve repo root regardless of whether the test runs from /tests (tsx) or /.tmp_test_dist/tests (compiled)
const repoRoot = __dirname.includes(".tmp_test_dist") ? join(__dirname, "..", "..") : join(__dirname, "..");
const frontendSource = join(repoRoot, "frontend");
const frontendTarget = join(repoRoot, ".tmp_test_dist", "frontend");

async function runTest(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

async function ensureFrontendAssets() {
  await mkdir(frontendTarget, { recursive: true });
  await cp(frontendSource, frontendTarget, { recursive: true, force: true });
}

async function createDeal(title: string, suffix: string) {
  const unique = `${suffix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const response = await app.inject({
    method: "POST",
    url: "/deals",
    headers: {
      "x-request-id": `frontend-test-create-${unique}`,
      "idempotency-key": `frontend-test-create-${unique}`
    },
    payload: {
      title,
      price_per_unit: 42,
      min_units: 10,
      max_units: 20,
      deadline: new Date(Date.now() + 3 * 60 * 60_000).toISOString(),
      delivery_options: [
        { option_type: "pickup", label: "Self pickup", cost: 0, sort_order: 0 },
        { option_type: "delivery", label: "Courier", cost: 15, sort_order: 1 }
      ]
    }
  });

  assert.equal(response.statusCode, 200);
  return response.json() as { deal_id: string };
}

async function publishDeal(dealId: string, suffix: string) {
  const unique = `${suffix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const response = await app.inject({
    method: "POST",
    url: `/deals/${dealId}/publish`,
    headers: {
      "x-request-id": `frontend-test-publish-${unique}`,
      "idempotency-key": `frontend-test-publish-${unique}`
    },
    payload: { seller_terms_accepted: true, seller_critical_terms_accepted: true, seller_threshold_90_accepted: true }
  });

  assert.equal(response.statusCode, 200);
}

async function main() {
  await ensureFrontendAssets();

  await runTest("frontend asset is served with payment adapter and polling hooks", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/app/assets/app.js"
    });

    assert.equal(response.statusCode, 200);
    assert.match(response.body, /paymentService/);
    assert.match(response.body, /setInterval/);
  });

  await runTest("frontend shell is declared as Hebrew RTL", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/app"
    });

    assert.equal(response.statusCode, 200);
    assert.match(response.body, /<html lang="he" dir="rtl">/);
    assert.match(response.body, /<title>C-ton<\/title>/);
    assert.match(response.body, /C-ton - /);
  });

  await runTest("styles support RTL layout and LTR fields inside Hebrew surfaces", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/app/assets/styles.css"
    });

    assert.equal(response.statusCode, 200);
    assert.match(response.body, /direction:\s*rtl/);
    assert.match(response.body, /data-dir="ltr"/);
    assert.match(response.body, /unicode-bidi:\s*plaintext/);
  });

  await runTest("primary navigation stays focused on the main product surface", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/app/assets/app.js"
    });

    assert.equal(response.statusCode, 200);
    assert.match(response.body, /href="\/app\/seller" data-nav="\/app\/seller" class="button secondary">אזור מוכר/);
    assert.doesNotMatch(response.body, /href="\/app\/affiliate" data-nav="\/app\/affiliate" class="button secondary">Affiliate</);
    assert.doesNotMatch(response.body, /href="\/app\/admin" data-nav="\/app\/admin" class="button secondary">Admin</);
    assert.doesNotMatch(response.body, /Operations view/);
  });

  await runTest("main product copy stays seller-first and drops old preview wording", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/app/assets/app.js"
    });

    assert.equal(response.statusCode, 200);
    assert.match(response.body, /פותחים עסקה, מעלים דף אישי, ומפיצים לינק ישיר לקונים/);
    assert.match(response.body, /פתיחת עסקה חדשה/);
    assert.match(response.body, /ניהול העסקאות שלי/);
    assert.match(response.body, /עריכה מלאה רק בטיוטה/);
    assert.doesNotMatch(response.body, /Demo \/ preview guardrail/);
    assert.doesNotMatch(response.body, /Demo \/ Preview -/);
    assert.doesNotMatch(response.body, /Siton Main Site/);
    assert.doesNotMatch(response.body, /Open a deal/);
    assert.doesNotMatch(response.body, /Draft only/);
    assert.doesNotMatch(response.body, /mock authorization provider/);
    assert.doesNotMatch(response.body, /buyer id/);
    assert.match(response.body, /אישור תפיסת מסגרת/);
    assert.match(response.body, /אישור מסגרת בלבד/);
  });

  await runTest("operational surfaces are framed as controlled operational views in the unified copy layer", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/app/assets/app.js"
    });

    assert.equal(response.statusCode, 200);
    assert.match(response.body, /גישה תפעולית/);
    assert.match(response.body, /מרכז התפעול של סיטון/);
    assert.match(response.body, /מרכז הפצה למדידה, ייחוס ושיתוף לינקים/);
    assert.doesNotMatch(response.body, /Internal surface/);
  });

  await runTest("admin and affiliate copy keeps the newer operational framing", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/app/assets/app.js"
    });

    assert.equal(response.statusCode, 200);
    assert.match(response.body, /מרכז הפצה/);
    assert.match(response.body, /מרכז התפעול של סיטון/);
    assert.doesNotMatch(response.body, /Affiliate totals/);
    assert.doesNotMatch(response.body, /Campaigns surfaced/);
    assert.doesNotMatch(response.body, /App health/);
  });

  await runTest("internal table header polish keeps human-facing labels available", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/app/assets/app.js"
    });

    assert.equal(response.statusCode, 200);
    assert.match(response.body, /מזהה ישות/);
    assert.match(response.body, /מזהה משתתף/);
    assert.match(response.body, /סוג אירוע/);
    assert.match(response.body, /מזהה קורלציה/);
  });

  await runTest("seller identity context is explicit in the frontend shell", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/app/assets/app.js"
    });

    assert.equal(response.statusCode, 200);
    assert.match(response.body, /siton_seller_context_v1/);
    assert.match(response.body, /usesDemoSellerContext\(\) \? \{ "x-seller-id": sellerContext\.seller_id \} : \{\}/);
    assert.doesNotMatch(response.body, /"x-seller-display-name": sellerContext\.display_name/);
    assert.match(response.body, /function normalizeSellerDisplayName\(sellerId, displayName\)/);
    assert.match(response.body, /זהות המוכר הפעילה/);
    assert.match(response.body, /שמירת זהות מוכר פעילה/);
    assert.match(response.body, /כל עסקה חדשה תיווצר תחת/);
  });

  await runTest("seller analytics command center frontend is compact and seller-safe", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/app/assets/app.js"
    });

    assert.equal(response.statusCode, 200);
    assert.match(response.body, /מרכז ניתוח מוכר/);
    assert.match(response.body, /עסקאות בסיכון/);
    assert.match(response.body, /יחידות שהצטרפו/);
    assert.match(response.body, /יחידות שחויבו/);
    assert.match(response.body, /רענון ידני/);
    assert.match(response.body, /עודכן לאחרונה/);
    assert.match(response.body, /לא נאסף עדיין/);
    assert.match(response.body, /אין עדיין עסקאות להצגה/);
    assert.match(response.body, /seller-analytics-refresh/);
    assert.match(response.body, /risk_reasons/);
  });

  await runTest("core buyer surfaces keep the strengthened trust and status copy", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/app/assets/app.js"
    });

    assert.equal(response.statusCode, 200);
    assert.match(response.body, /כניסה לעסקה/);
    assert.match(response.body, /רק דרך לינק ישיר/);
    assert.match(response.body, /סכום אישור המסגרת/);
    assert.match(response.body, /זה הסכום שיישמר כתפיסת מסגרת בשלב הזה/);
    assert.match(response.body, /הצטרפות/);
    assert.match(response.body, /נשמרה בהצלחה/);
    assert.match(response.body, /מסך המעקב הוא מקור האמת שלך/);
    assert.match(response.body, /תמונת מצב עדכנית/);
    assert.doesNotMatch(response.body, /החוזה מופרד מה-UI/);
  });

  await runTest("Buyer Experience V1 audit gates cover public join, OTP, authorization, confirmation, and tracking", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/app/assets/app.js"
    });

    assert.equal(response.statusCode, 200);
    const source = response.body;
    const confirmationStart = source.indexOf("function renderConfirmationPage");
    const trackingStart = source.indexOf("function renderTrackingPage");
    const trackingEnd = source.indexOf("function renderHome", trackingStart);
    const confirmationSnippet = source.slice(confirmationStart, trackingStart);
    const trackingSnippet = source.slice(trackingStart, trackingEnd > trackingStart ? trackingEnd : undefined);
    const buyerFlowSnippet = source.slice(source.indexOf("async function payAndJoin"), source.indexOf("async function createDeal"));

    assert.match(source, /app\\\/deal/);
    assert.match(source, /app\\\/join\\\/\(\[\^\/\]\+\)\\\/otp/);
    assert.match(source, /app\\\/join\\\/\(\[\^\/\]\+\)\\\/payment/);
    assert.match(source, /app\\\/join\\\/\(\[\^\/\]\+\)\\\/confirmation/);
    assert.match(source, /app\\\/track/);
    assert.match(source, /stateName === "TargetReached" \? "הצטרפו ליחידות האחרונות" : "הצטרפו לעסקה"/);
    assert.match(source, /ClosedForJoining/);
    assert.match(source, /Completed/);
    assert.match(source, /Failed/);
    assert.match(source, /metrics\.remaining_units/);
    assert.match(source, /calcHoldTotal/);
    assert.match(source, /deliveryCost/);
    assert.match(source, /if \(!flow\?\.otpVerified \|\| !flow\?\.buyerId\)/);
    assert.match(source, /תפיסת מסגרת בלבד/);
    assert.match(source, /הצטרפת בהצלחה/);
    assert.match(source, /REQUIRED_CHARGE_CONDITION/);
    assert.match(source, /REQUIRED_RELEASE_NOTICE/);
    assert.match(trackingSnippet, /dealState\.label/);
    assert.match(trackingSnippet, /buyerState\[0\]/);
    assert.match(trackingSnippet, /moneyState\[0\]/);
    assert.match(trackingSnippet, /renderShareActions/);
    assert.doesNotMatch(confirmationSnippet, /esc\(flow\.participantId\)/);
    assert.doesNotMatch(confirmationSnippet, /esc\(flow\.authorizationId/);
    assert.doesNotMatch(trackingSnippet, /esc\(tracking\.participant_id\)/);
    assert.doesNotMatch(trackingSnippet, /esc\(tracking\.buyer_id\)/);
    assert.doesNotMatch(buyerFlowSnippet, /capture|refund|void/i);
    assert.doesNotMatch(`${confirmationSnippet}\n${trackingSnippet}\n${buyerFlowSnippet}`, /marketplace|catalog|search/i);
    assert.doesNotMatch(`${confirmationSnippet}\n${trackingSnippet}\n${buyerFlowSnippet}`, /affiliate commission|affiliate payout|commission_amount|payout_status/i);
    assert.doesNotMatch(source, /raw_card|card_raw/i);
  });

  await runTest("seller surfaces keep the strengthened operational visual copy", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/app/assets/app.js"
    });

    assert.equal(response.statusCode, 200);
    assert.match(response.body, /תמונת שליטה/);
    assert.match(response.body, /העסקאות של המוכר הפעיל/);
    assert.match(response.body, /שומרים טיוטה ברורה/);
    assert.match(response.body, /מה יקרה אחרי שמירת הטיוטה/);
    assert.match(response.body, /תמונת מצב עדכנית/);
    assert.match(response.body, /מתקרת העסקה כבר נסגרה/);
    assert.match(response.body, /כאן רואים מי כבר נרשם/);
    assert.match(response.body, /אלה האפשרויות שיראו לקונה בדף הציבורי/);
  });

  await runTest("public deal shell renders for a published deal", async () => {
    const created = await createDeal("Frontend Shell Deal", "shell");
    await publishDeal(created.deal_id, "shell");

    const response = await app.inject({
      method: "GET",
      url: `/app/deal/${created.deal_id}`
    });

    assert.equal(response.statusCode, 200);
    assert.match(response.body, /\/app\/assets\/app\.js/);
  });

  await runTest("site shell keeps buyer entry link-based", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/site/home"
    });

    assert.equal(response.statusCode, 200);
    const payload = response.json() as any;
    assert.equal(payload.site.buyer_entry_note, "Buyers should enter through a direct deal link that the seller shares directly with them.");
  });

  await runTest("draft deals stay non-joinable through the public API", async () => {
    const created = await createDeal("Frontend Draft Deal", "draft");

    const response = await app.inject({
      method: "GET",
      url: `/api/deals/${created.deal_id}/public`
    });

    assert.equal(response.statusCode, 200);
    const payload = response.json() as any;
    assert.equal(payload.deal.state, "Draft");
    assert.equal(payload.availability.canJoin, false);
    assert.equal(payload.deal.delivery_options.length, 2);
  });

  await runTest("frontend happy path works through OTP, payment, join, and tracking", async () => {
    const created = await createDeal("Frontend Flow Deal", "flow");
    await publishDeal(created.deal_id, "flow");
    const publicDeal = await app.inject({
      method: "GET",
      url: `/api/deals/${created.deal_id}/public`
    });
    assert.equal(publicDeal.statusCode, 200);
    const publicDealPayload = publicDeal.json() as any;
    const courierOption = publicDealPayload.deal.delivery_options.find((row: any) => row.label === "Courier");
    assert.ok(courierOption);

    const otpStart = await app.inject({
      method: "POST",
      url: "/api/otp/start",
      payload: { phone: "0501234567" }
    });
    assert.equal(otpStart.statusCode, 200);
    const otpStartJson = otpStart.json() as any;

    const otpVerify = await app.inject({
      method: "POST",
      url: "/api/otp/verify",
      payload: {
        otp_session_id: otpStartJson.otp_session_id,
        code: otpStartJson.development_code
      }
    });
    assert.equal(otpVerify.statusCode, 200);
    const otpVerifyJson = otpVerify.json() as any;

    const payment = await app.inject({
      method: "POST",
      url: "/api/payments/authorize",
      payload: {
        payer_name: "Frontend Buyer",
        payment_method_id: `pm_test_${created.deal_id.replace(/-/g, "").slice(0, 18)}`,
        currency: "ILS",
        buyer_id: otpVerifyJson.buyer_id,
        deal_id: created.deal_id,
        qty: 3,
        delivery_option_id: courierOption.option_id,
        otp_token: otpVerifyJson.otp_token,
        otp_challenge_id: otpVerifyJson.challenge_id || otpVerifyJson.otp_session_id
      }
    });
    assert.equal(payment.statusCode, 200);

    const join = await app.inject({
      method: "POST",
      url: `/deals/${created.deal_id}/join`,
      headers: {
        "x-request-id": "frontend-test-join-flow",
        "idempotency-key": `frontend-test-join-${created.deal_id}`
      },
      payload: {
        buyer_id: otpVerifyJson.buyer_id,
        qty: 3,
        delivery_option_id: courierOption.option_id,
        payment_disclosure_accepted: true,
        otp_token: otpVerifyJson.otp_token,
        otp_challenge_id: otpVerifyJson.challenge_id || otpVerifyJson.otp_session_id,
        authorization_id: payment.json().authorization_id,
        authorization_provider: payment.json().provider,
        authorization_correlation_id: payment.json().correlation_id,
        delivery_address: "רחוב הבדיקה 10",
        delivery_city: "תל אביב",
        delivery_notes: "קומה 2"
      }
    });
    assert.equal(join.statusCode, 200);
    const joinJson = join.json() as any;
    assert.ok(joinJson.participant_id);
    assert.equal(joinJson.delivery_method_label, "Courier");
    assert.equal(Number(joinJson.delivery_cost), 15);
    assert.equal(Number(joinJson.hold_total), 141);

    const tracking = await app.inject({
      method: "GET",
      url: `/api/participants/${joinJson.participant_id}/tracking`
    });
    assert.equal(tracking.statusCode, 200);
    const trackingJson = tracking.json() as any;
    assert.equal(trackingJson.tracking.buyer_state, "JoinedAuthorized");
    assert.equal(trackingJson.tracking.money_state, "AuthHeld");
    assert.equal(trackingJson.tracking.delivery_method_label, "Courier");
    assert.equal(Number(trackingJson.tracking.delivery_cost), 15);
    assert.equal(Number(trackingJson.tracking.estimated_total), 141);

    const trackingShell = await app.inject({
      method: "GET",
      url: `/app/track/${joinJson.participant_id}`
    });
    assert.equal(trackingShell.statusCode, 200);
  });

  await runTest("frontend error branches stay available", async () => {
    const dealNotFound = await app.inject({
      method: "GET",
      url: "/api/deals/00000000-0000-0000-0000-000000000000/public"
    });
    assert.equal(dealNotFound.statusCode, 404);

    const otpStart = await app.inject({
      method: "POST",
      url: "/api/otp/start",
      payload: { phone: `050${String(Date.now()).slice(-7)}` }
    });
    const otpStartJson = otpStart.json() as any;

    const invalidOtp = await app.inject({
      method: "POST",
      url: "/api/otp/verify",
      payload: {
        otp_session_id: otpStartJson.otp_session_id,
        code: "000000"
      }
    });
    assert.equal(invalidOtp.statusCode, 400);

    const paymentFailure = await app.inject({
      method: "POST",
      url: "/api/payments/authorize",
      payload: {
        payer_name: "Failure Buyer",
        payment_method_id: "pm_test_decline_0000",
        amount_minor: 1000,
        currency: "ILS"
      }
    });
    assert.equal(paymentFailure.statusCode, 402);
  });
}

main()
  .then(async () => {
    await app.close();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error(error);
    await app.close().catch(() => undefined);
    process.exit(1);
  });

