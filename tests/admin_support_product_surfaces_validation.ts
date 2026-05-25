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

await run("admin dashboard renders explicit urgency and system hierarchy", async () => {
  assert.match(appJs, /function renderAdminPage\(\)/);
  assert.match(appJs, /buildAdminUrgencySummary/);
  assert.match(appJs, /renderAdminUrgencyCards/);
  assert.match(appJs, /admin-urgency-grid/);
  assert.match(appJs, /מה בוער עכשיו/);
});

await run("participant ops surface is exposed as a product read surface", async () => {
  assert.match(appJs, /"admin-participant"/);
  assert.match(appJs, /function loadAdminParticipant/);
  assert.match(appJs, /function renderAdminParticipantPage/);
  assert.match(appJs, /\/api\/admin\/participants\/\$\{encodeURIComponent\(participantId\)\}\/ops/);
});

await run("deal ops summary is rendered through canonical buckets rather than raw dump only", async () => {
  assert.match(appJs, /function renderAdminDealPage\(\)/);
  assert.match(appJs, /renderAdminDealOpsHero/);
  assert.match(appJs, /renderAdminDealOpsBuckets/);
  assert.match(appJs, /\/api\/admin\/deals\/\$\{encodeURIComponent\(dealId\)\}\/ops-summary/);
});

await run("operator wording is Hebrew and avoids obvious support english leaks", async () => {
  assert.doesNotMatch(appJs, /Support ticket created/i);
  assert.doesNotMatch(appJs, /Support ticket updated/i);
  assert.doesNotMatch(appJs, /Creating support ticket/i);
  assert.doesNotMatch(appJs, /Updating support ticket/i);
  assert.match(appJs, /פניית התמיכה נפתחה/);
  assert.match(appJs, /C-ton Admin/);
});

await run("operator surfaces keep truth aligned document and notification buckets", async () => {
  assert.match(appJs, /formatNotificationStatus/);
  assert.match(appJs, /formatDocumentStatus/);
  assert.match(appJs, /invoice_documents/);
  assert.match(appJs, /notifications/);
  assert.match(appJs, /רק מסמכים שנשענים על invoice_documents אמיתיים מוצגים כאן/);
});

await run("responsive sanity exists for refined admin and support surfaces", async () => {
  assert.match(stylesCss, /\.admin-urgency-grid/);
  assert.match(stylesCss, /\.admin-search-grid/);
  assert.match(stylesCss, /\.admin-ops-grid/);
  assert.match(stylesCss, /\.admin-ops-hero-grid/);
  assert.match(stylesCss, /@media \(max-width: 900px\)/);
});
