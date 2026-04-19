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
  assert.match(appJs, /function renderConfirmationPage/);
  assert.match(appJs, /tracking-next-panel/);
  assert.match(appJs, /flow\.authorizationMessage/);
  assert.match(appJs, /flow\.authorizationId/);
  assert.match(appJs, /flow\.estimatedTotal \|\| 0/);
  assert.match(appJs, /summary-grid/);
});

await run("buyer tracking exposes next-step, source-of-truth, and timeline blocks", async () => {
  assert.match(appJs, /function renderTrackingPage/);
  assert.match(appJs, /buildTrackingFocusCards/);
  assert.match(appJs, /buildTrackingTimeline/);
  assert.match(appJs, /buildTrackingSupportNote/);
  assert.match(appJs, /tracking-focus-grid/);
  assert.match(appJs, /table-panel/);
  assert.match(appJs, /supportNote/);
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
  assert.match(appJs, /buildTrackingSupportNote/);
  assert.match(appJs, /buildTrackingTimeline/);
});

await run("mobile layout preserves the main tracking summary areas", async () => {
  assert.match(stylesCss, /\.tracking-focus-grid/);
  assert.match(stylesCss, /\.tracking-next-panel\.tone-success/);
  assert.match(stylesCss, /\.tracking-next-panel\.tone-warning/);
  assert.match(stylesCss, /@media \(max-width: 900px\)/);
});
