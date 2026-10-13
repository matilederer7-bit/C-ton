import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { readFrontendRuntimeFamily } from "./helpers/route_sources.js";

async function run(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

// Every module extracted from frontend_runtime.ts stays in this scan (scripts/lib/route_modules.cjs).
const [appJs, runtimeTs] = await Promise.all([
  readFile("frontend/app.js", "utf8"),
  readFrontendRuntimeFamily()
]);

await run("seller receipt surface no longer invents pseudo receipt ids", async () => {
  assert.doesNotMatch(runtimeTs, /receipt_id:\s*`RCT-/);
  assert.match(runtimeTs, /document_id:\s*invoiceDocument\?\.document_id \?\? null/);
  assert.match(runtimeTs, /document_status:\s*invoiceDocument\?\.status \?\? "not_issued"/);
});

await run("seller receipt summary counts only issued invoice document rows", async () => {
  assert.match(runtimeTs, /receipt_document_count:\s*invoiceDocuments\.rows\.filter\(\(row: any\) => String\(row\.status\) === "issued"\)\.length/);
  assert.match(runtimeTs, /Receipt visibility relies on actual invoice_documents rows/);
});

await run("admin read surface loads notification and invoice truth endpoints", async () => {
  assert.match(appJs, /api\("\/api\/admin\/notifications-status"\)/);
  assert.match(appJs, /api\("\/api\/admin\/invoice-status"\)/);
  assert.match(appJs, /adminNotificationsStatusPayload/);
  assert.match(appJs, /adminInvoiceStatusPayload/);
});

await run("support and document statuses are rendered through explicit truth-friendly labels", async () => {
  assert.match(appJs, /function formatDocumentStatus/);
  assert.match(appJs, /function formatSupportScopeType/);
  assert.match(appJs, /function formatSupportTicketStatus/);
  assert.match(appJs, /document_status/);
});
