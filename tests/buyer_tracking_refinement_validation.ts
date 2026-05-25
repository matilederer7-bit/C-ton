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

await run("confirmation keeps authorization versus real charge narrative clear", async () => {
  assert.match(appJs, /function renderCtonConfirmationPage/);
  assert.match(appJs, /cton-success-card/);
  assert.match(appJs, /המסגרת נתפסה/);
  assert.match(appJs, /לא בוצע חיוב בפועל/);
  assert.match(appJs, /cton-share-highlight/);
});

await run("buyer tracking exposes next-step, source-of-truth, and timeline blocks", async () => {
  assert.match(appJs, /function renderCtonTrackingPage/);
  assert.match(appJs, /cton-tracking-page/);
  assert.match(appJs, /cton-status-hero/);
  assert.match(appJs, /cton-personal-card/);
  assert.match(appJs, /cton-next-actions/);
  assert.match(appJs, /ההצטרפות שלך/);
});

await run("action required and completion-window semantics are represented", async () => {
  assert.match(appJs, /ChargeFailedCompletion/);
  assert.match(appJs, /completion_window_until/);
  assert.match(appJs, /trackingStatusTone/);
  assert.match(appJs, /tracking\.buyer_state === "ChargeFailedCompletion"/);
  assert.match(appJs, /money_state === "ChargeFailedRecovery"/);
});

await run("terminal buyer states keep distinct product narratives", async () => {
  assert.match(appJs, /deal_state === "Completed"/);
  assert.match(appJs, /deal_state === "Failed" \|\| tracking\.deal_state === "Cancelled"/);
  assert.match(appJs, /העסקה הושלמה בהצלחה\. בוצע חיוב בפועל/);
  assert.match(appJs, /לא בוצע חיוב\. המסגרת שוחררה/);
});

await run("mobile layout preserves the main tracking summary areas", async () => {
  assert.match(stylesCss, /\.cton-tracking-page/);
  assert.match(stylesCss, /\.cton-status-hero/);
  assert.match(stylesCss, /\.cton-data-grid/);
  assert.match(stylesCss, /@media \(max-width: 900px\)/);
});
