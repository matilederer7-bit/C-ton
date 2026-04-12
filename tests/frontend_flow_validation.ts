import assert from "node:assert/strict";
import { cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app } from "../src/app.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, "..", "..");
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
      deadline: new Date(Date.now() + 30 * 60_000).toISOString(),
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
    payload: {}
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
    assert.match(response.body, /<title>סיטון<\/title>/);
    assert.match(response.body, /סיטון - דף עסקה ציבורי, הצטרפות קונה, אימות OTP, אישור מסגרת ומעקב עסקה/);
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
    assert.match(response.body, /href="\/app\/seller" data-nav="\/app\/seller" class="button secondary">אזור מוכר</);
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
    assert.match(response.body, /ספק אישור מסגרת מדומה/);
    assert.match(response.body, /אישור מסגרת בלבד/);
  });

  await runTest("internal surfaces are framed as internal in the unified copy layer", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/app/assets/app.js"
    });

    assert.equal(response.statusCode, 200);
    assert.match(response.body, /מסך פנימי/);
    assert.match(response.body, /המסך הזה הוא פנימי בלבד/);
    assert.match(response.body, /המסך הזה נשאר פנימי/);
    assert.doesNotMatch(response.body, /Internal surface/);
  });

  await runTest("internal admin and affiliate copy drops the older raw labels", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/app/assets/app.js"
    });

    assert.equal(response.statusCode, 200);
    assert.match(response.body, /סיכום שותפים/);
    assert.match(response.body, /מסך פנימי לפעולות תפעול, בקרה ותמיכה/);
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
    assert.match(response.body, /"x-seller-id": sellerContext\.seller_id/);
    assert.doesNotMatch(response.body, /"x-seller-display-name": sellerContext\.display_name/);
    assert.match(response.body, /function normalizeSellerDisplayName\(sellerId, displayName\)/);
    assert.match(response.body, /זהות המוכר הפעילה/);
    assert.match(response.body, /שמירת זהות מוכר פעילה/);
    assert.match(response.body, /כל עסקה חדשה תיווצר תחת/);
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

  await runTest("legacy marketplace route redirects to the main site", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/app/marketplace"
    });

    assert.equal(response.statusCode, 302);
    assert.equal(response.headers.location, "/app");
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
      url: "/api/payments/authorize-mock",
      payload: {
        holder_name: "Frontend Buyer",
        card_number: "4111111111111111",
        expiry: "12/28",
        cvv: "123"
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
        delivery_option_id: courierOption.option_id
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
      payload: { phone: "0507654321" }
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
      url: "/api/payments/authorize-mock",
      payload: {
        holder_name: "Failure Buyer",
        card_number: "4111111111110000",
        expiry: "12/28",
        cvv: "123"
      }
    });
    assert.equal(paymentFailure.statusCode, 402);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
