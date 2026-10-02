import assert from "node:assert/strict";
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

const app = await readFile("src/app.ts", "utf8");
const runtime = await readFile("src/frontend_runtime.ts", "utf8");
const legalDoc = await readFile("docs/LEGAL_TRUST_SURFACES.md", "utf8");
const indexHtml = await readFile("frontend/index.html", "utf8");
const templates = await readFile("src/notification_templates.ts", "utf8");

await run("legal_buyer_copy_no_premature_charge_validation", async () => {
  // join confirmation: "no charge yet" framing
  assert.match(templates, /לא בוצע חיוב בפועל/);
  // failed: explains release rather than claiming refund
  assert.match(templates, /תשוחרר בהתאם למדיניות ספק האשראי/);
  // recovery: payment did not pass
  assert.match(templates, /החיוב.*לא עבר/);
});

await run("legal_seller_publish_terms_ack_validation", async () => {
  assert.match(app, /seller_terms_required/);
  assert.match(app, /seller_publish_terms/);
});

await run("legal_distribution_link_no_commission_copy_validation", async () => {
  // No commission, balance, or payout for an external distribution source anywhere in the runtime
  assert.doesNotMatch(runtime, /distributor.*commission/i);
  assert.doesNotMatch(runtime, /affiliate.*commission/i);
  // Ordinary sharing survives the distributor-role removal: the legacy-named visit
  // route is measurement only (no money, no identity).
  assert.match(runtime, /\/api\/affiliate\/links\/visit/);
  assert.doesNotMatch(runtime, /\/api\/affiliate\/overview/);
});

await run("legal_footer_links_validation", async () => {
  // P0.3-12: the visible legal footer/nav is trimmed to the core buyer
  // documents + support; seller terms and the legacy /legal/affiliates compatibility path stay ROUTED (LEGAL_PAGES)
  // and linked from their own flows, not from the buyer footer.
  // The footer is rendered by the legal HTML shell (src/legal_html.ts, moved out
  // of frontend_runtime.ts by the Lean Refactor); /app/contact stays a runtime route.
  const legalShell = await readFile("src/legal_html.ts", "utf8");
  assert.match(legalShell, /\/legal\/terms/);
  assert.match(legalShell, /\/legal\/privacy/);
  assert.match(legalShell, /\/legal\/refunds/);
  assert.match(legalShell, /\/preview\/#\/support/);
  assert.match(runtime, /\/app\/contact/);
  const legalPages = await readFile("src/legal_pages.ts", "utf8");
  assert.match(legalPages, /sellers/);
  assert.match(legalPages, /affiliates/);
  assert.match(legalPages, /title:\s*"תנאי לינקי הפצה"/);
  assert.doesNotMatch(legalPages, /title:\s*"תנאי מפיצים"/);
  assert.match(legalPages, /אין בסיטון משתמש או תפקיד עסקי בשם "מפיץ"/);
});

await run("legal_recovery_copy_validation", async () => {
  assert.match(templates, /נדרש עדכון תשלום/);
});

await run("legal_accessibility_baseline_validation", async () => {
  assert.match(indexHtml, /lang="he"/);
  assert.match(indexHtml, /dir="rtl"/);
  // Either an explicit main landmark or main-content anchor
  assert.match(indexHtml, /main-content|<main/);
});

await run("legal_doc_present_validation", async () => {
  assert.match(legalDoc, /Source Of Truth/);
  assert.match(legalDoc, /Buyer Surface/);
  assert.match(legalDoc, /Seller Surface/);
  assert.match(legalDoc, /Footer Links/);
});
