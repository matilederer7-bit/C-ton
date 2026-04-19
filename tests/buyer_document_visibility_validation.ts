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

const [appJs, runtimeTs] = await Promise.all([
  readFile("frontend/app.js", "utf8"),
  readFile("src/frontend_runtime.ts", "utf8")
]);

const trackingPageSlice = appJs.slice(
  appJs.indexOf("function renderTrackingPage"),
  appJs.indexOf("function renderHome")
);
const trackingDocumentSlice = appJs.slice(
  appJs.indexOf("function buildTrackingDocumentVisibility"),
  appJs.indexOf("function renderErrorCard")
);

await run("buyer tracking endpoint exposes canonical document visibility from invoice_documents", async () => {
  assert.match(runtimeTs, /SELECT document_id, status, provider_document_id, issued_at, created_at\s+FROM siton\.invoice_documents\s+WHERE participant_id = \$1/);
  assert.match(runtimeTs, /document_visibility: documentVisibility/);
  assert.match(runtimeTs, /function deriveBuyerDocumentVisibility/);
});

await run("buyer surface does not invent pseudo receipt identifiers", async () => {
  assert.doesNotMatch(trackingPageSlice, /RCT-/);
  assert.doesNotMatch(trackingPageSlice, /receipt_id/);
  assert.doesNotMatch(trackingDocumentSlice, /receipt_id/);
  assert.match(appJs, /buildTrackingDocumentVisibility/);
});

await run("issued document is shown only when a real issued row exists", async () => {
  assert.match(appJs, /state === "issued" && visibility\.document_id/);
  assert.match(appJs, /documentVisibility\.documentId/);
  assert.match(appJs, /issuedAt/);
});

await run("missing or unavailable document states stay explicit instead of pretending issuance", async () => {
  assert.match(appJs, /state === "pending_issue"/);
  assert.match(appJs, /state === "issue_failed"/);
  assert.match(appJs, /state === "not_expected"/);
  assert.match(appJs, /shortLabel: "\\u05de\\u05de\\u05ea\\u05d9\\u05df \\u05dc\\u05d4\\u05e0\\u05e4\\u05e7\\u05d4"/);
  assert.match(appJs, /shortLabel: "\\u05dc\\u05d0 \\u05e6\\u05e4\\u05d5\\u05d9"/);
});

await run("completed failed and cancelled narratives preserve truth-aligned document messaging", async () => {
  assert.match(runtimeTs, /dealState === "Failed"/);
  assert.match(runtimeTs, /dealState === "Cancelled"/);
  assert.match(runtimeTs, /receiptEligible\(dealState, moneyState\)/);
  assert.match(appJs, /buildTrackingTimeline/);
  assert.match(appJs, /shortLabel/);
});
