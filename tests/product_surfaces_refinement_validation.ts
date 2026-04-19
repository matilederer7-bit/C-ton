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

await run("public deal page keeps product hierarchy and core purchase frame", async () => {
  assert.match(appJs, /function renderDealPage\(\)/);
  assert.match(appJs, /deal-hero-layout/);
  assert.match(appJs, /renderDealVisual/);
  assert.match(appJs, /deal-story-grid/);
  assert.match(appJs, /availabilityBanner/);
});

await run("seller workspace is grouped around urgency, drafts, and closed deals", async () => {
  assert.match(appJs, /function renderSellerPage\(\)/);
  assert.match(appJs, /workspace-focus-grid/);
  assert.match(appJs, /classifySellerDeals/);
  assert.match(appJs, /renderSellerBoardSection/);
  assert.match(appJs, /seller-board-section/);
});

await run("seller deal page exposes a clearer operational control summary", async () => {
  assert.match(appJs, /function renderSellerDealPage\(\)/);
  assert.match(appJs, /summarizeSellerParticipants/);
  assert.match(appJs, /seller-deal-control-grid/);
  assert.match(appJs, /participantSnapshot\.charged/);
  assert.match(appJs, /participantSnapshot\.pending/);
  assert.match(appJs, /participantSnapshot\.unresolved/);
});

await run("mobile-first responsive support exists for the refined product surfaces", async () => {
  assert.match(stylesCss, /\.deal-hero-layout/);
  assert.match(stylesCss, /\.workspace-focus-grid/);
  assert.match(stylesCss, /\.seller-deal-control-grid/);
  assert.match(stylesCss, /@media \(max-width: 900px\)/);
});

await run("core product surfaces keep Hebrew-facing copy and avoid obvious internal english leaks", async () => {
  assert.match(appJs, /׳¢׳¡׳§׳” ׳¦׳™׳‘׳•׳¨׳™׳×/);
  assert.match(appJs, /׳׳–׳•׳¨ ׳”׳׳•׳›׳¨/);
  assert.doesNotMatch(appJs, /Open a deal/i);
  assert.doesNotMatch(appJs, /debug page/i);
  assert.doesNotMatch(appJs, /internal tool/i);
});
