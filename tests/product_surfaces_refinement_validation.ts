import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";

async function run(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

const [appJs, stylesCss] = await Promise.all([
  readFile("frontend/app.js", "utf8"),
  readFile("frontend/styles.css", "utf8")
]);

await run("C-ton home renders a real product hero instead of a link list", async () => {
  assert.match(appJs, /function renderCtonHome\(\)/);
  assert.match(appJs, /cton-home-hero/);
  assert.match(appJs, /קונים יחד\. משלמים רק כשזה קורה\./);
  assert.match(appJs, /מארז קפה שכונתי/);
});

await run("public deal page keeps live deal hierarchy and core join frame", async () => {
  assert.match(appJs, /function renderCtonDealPage\(\)/);
  assert.match(appJs, /cton-deal-page/);
  assert.match(appJs, /cton-product-image/);
  assert.match(appJs, /cton-join-card/);
  assert.match(appJs, /cton-progress-card/);
  assert.match(appJs, /הסכום יתפוס מסגרת אשראי בלבד/);
});

await run("seller workspace is a warm command center rather than a table", async () => {
  assert.match(appJs, /function renderCtonSellerPage\(\)/);
  assert.match(appJs, /cton-seller-dashboard/);
  assert.match(appJs, /cton-kpi-grid/);
  assert.match(appJs, /cton-attention/);
  assert.match(appJs, /cton-all-deals/);
});

await run("seller analytics dashboard surface is present and constitution-safe", async () => {
  assert.match(appJs, /function renderSellerAnalyticsSection\(\)/);
  assert.match(appJs, /ביצועי המוכר/);
  assert.match(appJs, /נטו למוכר/);
  assert.match(appJs, /עמלת C-ton/);
  assert.match(appJs, /נתוני ייחוס בלבד/);
  assert.match(appJs, /טוען את ביצועי המוכר/);
  assert.match(appJs, /לא הצלחנו לטעון את ביצועי המוכר כרגע/);
  assert.match(appJs, /עדיין אין נתוני ביצועים/);
  assert.match(appJs, /הכל/);
  assert.match(appJs, /30 ימים/);
  assert.match(appJs, /90 ימים/);
  assert.match(appJs, /שנה/);
  assert.match(appJs, /\/api\/seller\/analytics\?period=/);
  assert.match(stylesCss, /\.seller-analytics-kpis/);
  assert.match(stylesCss, /\.seller-analytics-grid/);
  const analyticsSection = appJs.slice(
    appJs.indexOf("function renderSellerAnalyticsSection()"),
    appJs.indexOf("function renderSellerAnalyticsPeriodSelector")
  );
  assert.doesNotMatch(analyticsSection, /commission|payout|withdrawal|balance|revenue share/i);
});

await run("seller live deal page exposes operational summary and deterministic outcome", async () => {
  assert.match(appJs, /function renderCtonSellerDealPage\(\)/);
  assert.match(appJs, /summarizeSellerParticipants/);
  assert.match(appJs, /cton-seller-live/);
  assert.match(appJs, /cton-outcome/);
  assert.match(appJs, /אם זה יסתיים עכשיו/);
  assert.match(appJs, /snapshot\.charged/);
  assert.match(appJs, /snapshot\.pending/);
  assert.match(appJs, /snapshot\.unresolved/);
});

await run("seller completed deal surface exposes Excel export only after completion", async () => {
  assert.match(appJs, /deal\.state === "Completed" \? `[\s\S]*data-inline-action="seller-excel-export"/);
  assert.match(appJs, /data-inline-action="seller-excel-export"/);
  assert.match(appJs, /\/api\/seller\/deals\/\$\{encodeURIComponent\(dealId\)\}\/export\.xlsx/);
});

await run("mobile-first responsive support exists for the rebuilt product surfaces", async () => {
  assert.match(stylesCss, /\.cton-home-hero/);
  assert.match(stylesCss, /\.cton-deal-page/);
  assert.match(stylesCss, /\.cton-seller-dashboard/);
  assert.match(stylesCss, /\.cton-seller-live/);
  assert.match(stylesCss, /\.share-panel/);
  assert.match(stylesCss, /\.wizard-steps/);
  assert.match(stylesCss, /\.product-image-uploader/);
  assert.match(stylesCss, /@media \(max-width: 900px\)/);
  assert.match(stylesCss, /@media \(max-width: 768px\)/);
});

await run("deal sharing and seller creation guardrails stay frontend-only and constitution-safe", async () => {
  assert.match(appJs, /function renderShareActions/);
  assert.match(appJs, /navigator\.share/);
  assert.match(appJs, /data-inline-action="copy-link"/);
  assert.match(appJs, /REQUIRED_PAYMENT_NOTICE/);
  assert.match(appJs, /sellerFinalTerms/);
  assert.match(appJs, /sellerFinalConfirm/);
  assert.match(appJs, /handleSellerImageSelection/);
  assert.match(appJs, /בחרו תמונת מוצר שתופיע בתצוגת העסקה לפני הפרסום/);
  assert.doesNotMatch(appJs, /commissionPct/);
});

await run("core product surfaces keep Hebrew-facing copy and avoid obvious internal english leaks", async () => {
  assert.match(appJs, /פתיחת עסקה חדשה/);
  assert.match(appJs, /אזור המוכר/);
  assert.doesNotMatch(appJs, /Open a deal/i);
  assert.doesNotMatch(appJs, /debug page/i);
  assert.doesNotMatch(appJs, /internal tool/i);
});
