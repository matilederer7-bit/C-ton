// SELLER DISTRIBUTION HUB — frontend wiring contract (source-level proof).
//
// The server owns attribution and every number; this file pins the browser
// side that keeps that truthful:
//   * the ?ref= share code is captured ONCE at boot into persistent storage and
//     travels with the Join payload (so OTP / login / checkout / refresh never
//     lose it — never a query parameter that disappears after the first page)
//   * the entry visit carries the opaque visitor id (unique visitors)
//   * the seller deal screen embeds the distribution panel + per-link dashboard
//   * the external dashboard is a separate minimal route with no seller nav
//   * copy: empty state, CTA, the permanent measurement-only disclaimer, and the
//     explicit Join ≠ Final Charge distinction
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();
const read = (relative: string) => readFile(join(root, relative), "utf8");

let passed = 0;
async function run(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { console.error(`FAIL ${name}`); throw error; }
}

const viral = await read("web/src/viral.ts");
const app = await read("web/src/App.tsx");
const deal = await read("web/src/pages/deal.tsx");
const seller = await read("web/src/pages/seller.tsx");
const distribution = await read("web/src/pages/distribution.tsx");
const api = await read("web/src/api.ts");

await run("the share code is captured once at boot into persistent storage (not a one-page query parameter)", () => {
  assert.match(app, /captureRefFromLocation\(\);/);
  assert.match(viral, /localStorage\.setItem\(STORE_KEY/);
  assert.match(viral, /affiliate_ref: store\.last\?\.code \|\| null/, "Join sends the LAST touched code");
});

await run("the Join payload carries the attribution hints (survives OTP / checkout / refresh)", () => {
  assert.match(deal, /const hints = attributionHints\(\);/);
  assert.match(deal, /api\.join\(deal\.deal_id, \{[\s\S]*?\.\.\.hints[\s\S]*?\}\)/);
});

await run("an entry through a link is recorded with the opaque visitor id and a per-session entry id (refresh-safe)", () => {
  assert.match(deal, /recordShareVisit\(dealId, currentRef\(\)\)/);
  assert.match(viral, /entry_id: entryId, visitor_id: visitorId\(\)/);
  assert.match(viral, /sessionStorage\.setItem\(sessionEntryKey, entryId\)/);
});

await run("the seller deal screen embeds the distribution panel and routes to the per-link dashboard", () => {
  assert.match(seller, /import \{ DistributionPanel, SellerLinkDashboardPage \} from "\.\/distribution";/);
  assert.match(seller, /<DistributionPanel dealId=\{dealId\}/);
  assert.match(seller, /sub\[2\] === "distribution" && sub\[3\]\) return <SellerLinkDashboardPage/);
  assert.match(distribution, /navigate\(`#\/seller\/deal\/\$\{dealId\}\/distribution\/\$\{link\.link_id\}`\)/);
});

await run("seller copy: empty state, first-link CTA, actions, sortable comparison table", () => {
  assert.match(distribution, /עדיין לא יצרת לינקי הפצה/);
  assert.match(distribution, /צור לינק ראשון/);
  for (const action of ["העתק", "שתף", "שנה שם", "ביצועים", "השבת"]) assert.ok(distribution.includes(`>${action}<`) || distribution.includes(`"${action}"`) || distribution.includes(`${action}</button>`), `action ${action}`);
  for (const key of ["entries", "joins", "joined_units", "charged_units", "attributed_gross", "conversion_entry_to_join"]) {
    assert.ok(distribution.includes(`toggleSort("${key}")`), `sortable by ${key}`);
  }
});

await run("Join and Final Charge are never presented as the same thing", () => {
  assert.match(distribution, /label="הצטרפויות" sub="התחייבות של קונה — עדיין לא מכירה"/);
  assert.match(distribution, /יחידות שחויבו סופית/);
  assert.match(distribution, /ברוטו מיוחס \(נגבה בפועל\)/);
});

await run("the time chart offers 24h / 7d / 30d / all and a metric switcher", () => {
  for (const r of ["24h", "7d", "30d", "all"]) assert.ok(distribution.includes(`key: "${r}"`), r);
  for (const m of ["entries", "unique_visitors", "joins", "joined_units", "charged_units", "attributed_gross"]) assert.ok(distribution.includes(`data-testid={\`metric-\${m.key}\`}`) && distribution.includes(`key: "${m}"`), m);
});

await run("the permanent measurement-only disclaimer is rendered on every distribution surface", () => {
  const disclaimer = "סיטון אינה מחשבת או מנהלת עמלה או התחשבנות בין המוכר לבעל הלינק";
  assert.ok(distribution.includes(disclaimer));
  assert.equal((distribution.match(/<DistributionDisclaimer/g) || []).length >= 4, true, "panel, seller dashboard, external login, external dashboard");
});

await run("the external link dashboard is its own minimal route: session-gated, no seller navigation", () => {
  assert.match(app, /const isLinkViewer = page === "link-dashboard";/);
  assert.match(app, /\{isLinkViewer \? null : \(\s*<nav className="nav-links"/);
  assert.match(app, /\{isLinkViewer \? <LinkViewerPage \/> : null\}/);
  const viewer = distribution.slice(distribution.indexOf("export function LinkViewerPage"));
  assert.ok(!viewer.includes("#/seller"), "no seller links inside the external dashboard");
  assert.ok(!viewer.includes("sellerDistribution"), "the external page never calls seller APIs");
  assert.match(viewer, /api\.linkViewerLogin\(/);
  assert.match(viewer, /api\.linkViewerDashboard\(range, selected\)/);
  assert.match(api, /linkViewerDashboard: \(range = "7d", link = ""\) =>\s*req\(`\/api\/link-viewer\/dashboard/);
});

await run("the buyer deal page shows no distributor/affiliate/commission wording and no different UI per entry path", () => {
  assert.ok(!/מפיץ|עמלה|affiliate|referral/i.test(deal.replace(/affiliate_ref/g, "")), "buyer page never mentions distributors, commissions or referrals");
  assert.ok(!deal.includes('from "./distribution"'), "the buyer page does not import the distribution module");
});

console.log(`\nfrontend distribution hub wiring: ${passed} checks passed`);
