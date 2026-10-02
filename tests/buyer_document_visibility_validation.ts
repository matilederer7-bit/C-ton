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

const [appJs, runtimeTs, trackTsx] = await Promise.all([
  readFile("frontend/app.js", "utf8"),
  readFile("src/frontend_runtime.ts", "utf8"),
  readFile("web/src/pages/track.tsx", "utf8")
]);

// Slice ONE named top-level function out of frontend/app.js. Fails loudly when
// the function is missing, duplicated, or suspiciously empty, so deleting or
// renaming a renderer can never turn a slice assertion into a vacuous pass.
function extractFunction(source: string, name: string): string {
  const header = new RegExp(`(?:^|\\n)(?:async )?function ${name}\\(`, "g");
  const matches = [...source.matchAll(header)];
  assert.equal(matches.length, 1, `expected exactly one top-level function ${name} in frontend/app.js, found ${matches.length}`);
  const first = matches[0]!;
  const start = first.index as number;
  const nextHeader = /\n(?:async )?function \w+\(/g;
  nextHeader.lastIndex = start + first[0].length;
  const next = nextHeader.exec(source);
  const slice = source.slice(start, next ? next.index : source.length);
  assert.ok(slice.length > 400, `${name} slice is suspiciously small (${slice.length} chars); the assertion would be vacuous`);
  return slice;
}

// RETARGET (lr2): trackingPageSlice used to be renderTrackingPage..renderHome
// (a legacy renderer with zero call sites, plus the live renderRecoveryPage that
// happened to sit in between). It now reads the buyer surfaces that are actually
// served: /app renderCtonTrackingPage + renderRecoveryPage, and the React
// product page web/src/pages/track.tsx (docs/CURRENT_ARCHITECTURE_2026-09-30.md).
assert.match(appJs, /route\.name === "tracking"\) return renderCtonTrackingPage\(/);
assert.match(appJs, /route\.name === "recovery"\) return renderRecoveryPage\(/);
assert.ok(trackTsx.length > 2000, "web/src/pages/track.tsx must be readable and non-empty");
const liveTrackingSurfaces = [
  ["renderCtonTrackingPage", extractFunction(appJs, "renderCtonTrackingPage")],
  ["renderRecoveryPage", extractFunction(appJs, "renderRecoveryPage")],
  ["web/src/pages/track.tsx", trackTsx]
] as const;
const documentSliceStart = appJs.indexOf("function buildTrackingDocumentVisibility");
const documentSliceEnd = appJs.indexOf("function renderErrorCard");
assert.ok(documentSliceStart >= 0 && documentSliceEnd > documentSliceStart, "buildTrackingDocumentVisibility..renderErrorCard slice boundaries must exist");
const trackingDocumentSlice = appJs.slice(documentSliceStart, documentSliceEnd);
assert.ok(trackingDocumentSlice.length > 400, "buildTrackingDocumentVisibility slice must be non-empty");

await run("buyer tracking endpoint exposes canonical document visibility from invoice_documents", async () => {
  assert.match(runtimeTs, /SELECT document_id, status, provider_document_id, issued_at, created_at\s+FROM siton\.invoice_documents\s+WHERE participant_id = \$1/);
  assert.match(runtimeTs, /document_visibility: documentVisibility/);
  assert.match(runtimeTs, /function deriveBuyerDocumentVisibility/);
});

await run("buyer surface does not invent pseudo receipt identifiers", async () => {
  for (const [label, slice] of liveTrackingSurfaces) {
    assert.doesNotMatch(slice, /RCT-/, label);
    assert.doesNotMatch(slice, /receipt_id/, label);
  }
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

// GAP (lr2, owner decision): the buyer-facing document-visibility UI (issued /
// pending_issue / issue_failed / not_expected states, issued-at stamp) exists
// only in the legacy renderTrackingPage and its helpers (buildTrackingDocumentVisibility,
// buildTrackingFocusCards), which have zero call sites. Neither the live /app
// renderCtonTrackingPage nor the React web/src/pages/track.tsx renders
// document_visibility. The server contract is still asserted above. The
// helper-level assertions above that pin buildTrackingDocumentVisibility
// describe legacy code only; they are deliberately left unchanged here.
await run("GAP record: buyer-facing document visibility is legacy-only (not in live /app or React tracking)", async () => {
  const live = liveTrackingSurfaces.map(([, slice]) => slice).join("\n");
  const delivered = /document_visibility|documentVisibility/.test(live);
  console.log(`GAP legacy-only requirement not in live product: buyer-facing document visibility states (owner decision) — delivered by live surfaces: ${delivered}`);
  // If the live product starts rendering it, this fails so the gap is retired
  // deliberately (move the state assertions onto the live surface) instead of silently.
  assert.equal(delivered, false, "live surface now renders document visibility: retarget the document-state assertions to it and delete this GAP record");
});
