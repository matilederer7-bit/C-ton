/**
 * Wave 3 — Spec Drift Regression
 *
 * Source-level guards that pin the five invariants reinforced in Wave 3 so
 * that they cannot silently regress in future edits. These checks are static
 * (grep-style) against the repo — no DB required — and are cheap enough to
 * run on every CI pass.
 *
 * The five invariants:
 *
 *   D1. One bounded public Mall at /app; no duplicate/free-text catalog API.
 *   D2. No 5% / 0.05 platform fee anywhere in live settlement code.
 *   D3. Fee base includes delivery (qty * price + delivery, excl. VAT).
 *   D4. A buyer can repeat-purchase the same deal (no UNIQUE (deal_id, buyer_id)).
 *   D5. No misleading distributor "earnings / balance / withdraw" copy in
 *       the active affiliate attribution surface.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function read(relPath: string): string {
  return readFileSync(resolve(process.cwd(), relPath), "utf8");
}

async function run(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

// ─── D1: canonical bounded Mall, without duplicate search/catalog truth ────

await run("D1 — /app is the canonical Mall and duplicate discovery routes stay absent", () => {
  const app = read("frontend/app.js");
  assert.match(app, /mall/i, "frontend/app.js must render the Siton Mall at /app");
  assert.ok(
    !/case\s+['"]\/app\/marketplace['"]/.test(app),
    "duplicate /app/marketplace route was introduced"
  );
  assert.ok(
    !/case\s+['"]\/app\/catalog['"]/.test(app),
    "duplicate /app/catalog route was introduced"
  );
  assert.ok(
    !/case\s+['"]\/app\/discover['"]/.test(app),
    "duplicate /app/discover route was introduced"
  );
});

await run("D1 — Mall uses bounded filters and has no arbitrary public text search", () => {
  const runtime = read("src/frontend_runtime.ts");
  const mall = read("src/mall_read_model.ts");
  assert.match(runtime, /\/api\/mall\/deals/);
  assert.match(mall, /physical_product/);
  assert.match(mall, /voucher/);
  assert.match(mall, /ticket/);
  assert.ok(!/app\.get\(["']\/api\/(search|deals\/search|catalog\/search)/i.test(runtime));
  assert.ok(!/query\?\.q|query\?\.search/i.test(mall), "Mall read model must not accept free-text SQL input");
});

// ─── D2: no 5% / 0.05 platform fee in live settlement code ─────────────────

await run("D2 — SITON_PLATFORM_FEE_RATE is 0.08 in live code", () => {
  const psup = read("src/product_surface_support.ts");
  const pfm = read("src/platform_fee_money.ts");
  assert.ok(
    /SITON_PLATFORM_FEE_RATE/.test(psup),
    "product_surface_support.ts must use the SITON_PLATFORM_FEE_RATE constant"
  );
  assert.ok(
    /SITON_PLATFORM_FEE_RATE\s*=\s*0\.08/.test(pfm),
    "platform_fee_money.ts must define SITON_PLATFORM_FEE_RATE = 0.08"
  );
});

await run("D2 — no `platform_fee_rate = 0.05` assignment anywhere in src/", () => {
  for (const path of [
    "src/product_surface_support.ts",
    "src/platform_fee_money.ts",
    "src/app.ts",
    "src/invoice_dispatch.ts",
    "src/frontend_runtime.ts"
  ]) {
    const body = read(path);
    assert.ok(
      !/platform_fee_rate\s*[:=]\s*0\.05/i.test(body),
      `${path} assigns platform_fee_rate = 0.05 (must be 0.08)`
    );
    assert.ok(
      !/commission_rate\s*[:=]\s*0\.05/i.test(body),
      `${path} hard-codes commission_rate = 0.05 (distributor commission removed in Wave 2.5)`
    );
  }
});

// ─── D3: fee base includes delivery ─────────────────────────────────────────

await run("D3 — platform_fee_money.ts computes fee base with delivery_cost included", () => {
  const body = read("src/platform_fee_money.ts");
  // Expect either an explicit fee_base_amount computation that includes
  // delivery, or a gross_amount that already has delivery folded in.
  assert.ok(
    /fee_base_amount/.test(body),
    "platform_fee_money.ts must expose fee_base_amount"
  );
});

await run("D3 — no comment/string claims fee excludes delivery in active source", () => {
  const forbidden = [
    /shipping\s+excluded/i,
    /excluding\s+delivery/i,
    /fee\s+on\s+product\s+only/i,
    /delivery\s+not\s+part\s+of\s+fee/i
  ];
  for (const path of [
    "src/app.ts",
    "src/platform_fee_money.ts",
    "src/product_surface_support.ts",
    "src/frontend_runtime.ts",
    "frontend/app.js"
  ]) {
    const body = read(path);
    for (const re of forbidden) {
      assert.ok(
        !re.test(body),
        `${path} contains forbidden "fee-excludes-delivery" phrasing: ${re}`
      );
    }
  }
});

// ─── D4: buyer can repeat-purchase the same deal ────────────────────────────

await run("D4 — init_db.sql has NO UNIQUE (deal_id, buyer_id) on participants", () => {
  const init = read("scripts/init_db.sql");
  assert.ok(
    !/UNIQUE\s*\(\s*deal_id\s*,\s*buyer_id\s*\)/i.test(init),
    "init_db.sql has UNIQUE (deal_id, buyer_id) — this breaks the repeat-purchase rule"
  );
  assert.ok(
    !/UNIQUE\s*\(\s*buyer_id\s*,\s*deal_id\s*\)/i.test(init),
    "init_db.sql has UNIQUE (buyer_id, deal_id) — this breaks the repeat-purchase rule"
  );
});

await run("D4 — migrations do not introduce a UNIQUE (deal_id, buyer_id) constraint", () => {
  for (const path of [
    "src/migrations/018_invoice_documents.sql",
    "src/migrations/019_platform_fee_money_events.sql",
    "src/migrations/020_drop_affiliate_legacy_columns.sql"
  ]) {
    const body = read(path);
    assert.ok(
      !/UNIQUE\s*\(\s*deal_id\s*,\s*buyer_id\s*\)/i.test(body),
      `${path} introduces UNIQUE (deal_id, buyer_id)`
    );
    assert.ok(
      !/UNIQUE\s*\(\s*buyer_id\s*,\s*deal_id\s*\)/i.test(body),
      `${path} introduces UNIQUE (buyer_id, deal_id)`
    );
  }
});

await run("D4 — no 'already joined' / 'single participation' copy in frontend surfaces", () => {
  const forbidden = [
    /already\s+joined/i,
    /join\s+once/i,
    /single\s+participation/i,
    /one\s+purchase\s+per\s+buyer/i,
    /unique\s+buyer\s+per\s+deal/i
  ];
  for (const path of ["frontend/app.js", "src/frontend_runtime.ts"]) {
    const body = read(path);
    for (const re of forbidden) {
      assert.ok(
        !re.test(body),
        `${path} contains forbidden single-purchase phrasing: ${re}`
      );
    }
  }
});

// ─── D5: no misleading distributor money copy on affiliate surface ──────────

await run("D5 — affiliate surface has no earnings/balance/withdraw wording", () => {
  const forbidden = [
    /affiliate_earnings/i,
    /affiliate_balance/i,
    /affiliate_withdraw/i,
    /affiliate_payout/i,
    /amount_owed/i
  ];
  for (const path of [
    "src/frontend_runtime.ts",
    "src/product_surface_support.ts",
    "frontend/app.js"
  ]) {
    const body = read(path);
    for (const re of forbidden) {
      assert.ok(
        !re.test(body),
        `${path} exposes forbidden distributor money copy: ${re}`
      );
    }
  }
});

function extractCreateBlock(body: string, tableName: string): string | null {
  // Extract the content between `CREATE TABLE ... tableName (` and its matching `)`.
  // We scan character-by-character for paren balance, starting at the open-paren
  // that follows the table name.
  const headerPattern = new RegExp(
    `CREATE\\s+TABLE[\\s\\S]*?${tableName}\\s*\\(`,
    "i"
  );
  const m = headerPattern.exec(body);
  if (!m) return null;
  let depth = 1;
  let idx = m.index + m[0].length;
  const start = idx;
  while (idx < body.length && depth > 0) {
    const ch = body[idx];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    idx++;
  }
  return body.slice(start, idx - 1);
}

await run("D5 — affiliate_accounts CREATE TABLE no longer carries payout_* columns", () => {
  const psup = read("src/product_surface_support.ts");
  const init = read("scripts/init_db.sql");
  for (const source of [
    { name: "product_surface_support.ts", body: psup },
    { name: "init_db.sql", body: init }
  ]) {
    const block = extractCreateBlock(source.body, "affiliate_accounts");
    if (block === null) continue; // some sources may only ALTER, not CREATE
    for (const col of ["payout_status", "payout_method", "payout_details_masked"]) {
      assert.ok(
        !new RegExp(`\\b${col}\\b`).test(block),
        `${source.name} CREATE TABLE affiliate_accounts still defines ${col}`
      );
    }
  }
});

await run("D5 — affiliate_attributions CREATE TABLE no longer carries commission_* columns", () => {
  const psup = read("src/product_surface_support.ts");
  const init = read("scripts/init_db.sql");
  for (const source of [
    { name: "product_surface_support.ts", body: psup },
    { name: "init_db.sql", body: init }
  ]) {
    const block = extractCreateBlock(source.body, "affiliate_attributions");
    if (block === null) continue;
    for (const col of ["commission_rate", "commission_amount", "payout_status"]) {
      assert.ok(
        !new RegExp(`\\b${col}\\b`).test(block),
        `${source.name} CREATE TABLE affiliate_attributions still defines ${col}`
      );
    }
  }
});

console.log("\nAll Wave 3 spec-drift regression checks completed.");
