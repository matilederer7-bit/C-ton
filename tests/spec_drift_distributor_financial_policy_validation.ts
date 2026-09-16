/**
 * Distributor financial-policy regression guard.
 *
 * Canonical rule: distributor/affiliate surfaces are attribution and measurement only.
 * They may track links, visits, joins, attributed units and attributed gross value,
 * but they must never create an in-system commission, balance, payout, withdrawal,
 * wallet, invoice, or financial entitlement for a distributor.
 *
 * This deliberately scopes financial bans to distributor/affiliate concepts. Seller
 * payouts and Siton's 8% platform fee are legitimate and must not be blocked here.
 */

import { strict as assert } from "node:assert";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = process.cwd();
const FINANCIAL_TOKEN =
  /\b(?:affiliate|distributor)_(?:commission|commission_rate|commission_amount|payout|payout_status|balance|withdraw|withdrawal|earnings?|wallet|invoice|entitlement)\b|\b(?:commission|commission_rate|commission_amount|payout|payout_status|balance|withdraw|withdrawal|earnings?|wallet|invoice|entitlement)_(?:affiliate|distributor)\b/i;
const FINANCIAL_CAMEL_TOKEN =
  /\b(?:affiliate|distributor)(?:Commission|Payout|Balance|Withdraw|Withdrawal|Earning|Earnings|Wallet|Invoice|Entitlement)\b|\b(?:commission|payout|balance|withdraw|withdrawal|earning|earnings|wallet|invoice|entitlement)(?:Affiliate|Distributor)\b/;
const FINANCIAL_ROUTE =
  /\/(?:api\/)?(?:affiliate|distributor)[^\s"'`]*(?:commission|payout|balance|withdraw|wallet|invoice|entitlement)/i;
const DISTRIBUTOR_TABLE_ADD_FINANCIAL_COLUMN =
  /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:siton\.)?(?:affiliate|distributor)[a-z0-9_]*[\s\S]{0,160}?ADD\s+COLUMN(?:\s+IF\s+NOT\s+EXISTS)?\s+(?:commission_rate|commission_amount|payout_status|payout_method|payout_details_masked|balance|wallet|entitlement)\b/i;
const DISTRIBUTOR_FINANCIAL_TABLE_DEFINITION =
  /CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+(?:siton\.)?(?:affiliate|distributor)[a-z0-9_]*(?:commission|payout|balance|withdraw|wallet|invoice|entitlement)[a-z0-9_]*\s*\(/i;

function read(path: string): string {
  return readFileSync(resolve(ROOT, path), "utf8");
}

function collectFiles(dir: string, allowedExtensions: Set<string>): string[] {
  const abs = resolve(ROOT, dir);
  if (!existsSync(abs)) return [];
  const output: string[] = [];
  for (const entry of readdirSync(abs)) {
    const full = join(abs, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      output.push(...collectFiles(relative(ROOT, full), allowedExtensions));
      continue;
    }
    const dot = entry.lastIndexOf(".");
    const ext = dot >= 0 ? entry.slice(dot) : "";
    if (allowedExtensions.has(ext)) output.push(relative(ROOT, full).replaceAll("\\", "/"));
  }
  return output;
}

function assertNoDistributorFinancialAuthority(path: string, body: string): void {
  assert.ok(!FINANCIAL_TOKEN.test(body), `${path} reintroduces distributor financial authority`);
  assert.ok(!FINANCIAL_CAMEL_TOKEN.test(body), `${path} reintroduces camelCase distributor financial authority`);
  assert.ok(!FINANCIAL_ROUTE.test(body), `${path} exposes a distributor financial route`);
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

await run("distributor runtime contains no financial authority identifiers or routes", () => {
  const runtimeFiles = [
    ...collectFiles("src", new Set([".ts", ".js"])).filter((path) => !path.startsWith("src/migrations/")),
    ...collectFiles("frontend", new Set([".ts", ".js"])),
    "scripts/init_db.sql",
    "src/schema_contract.ts"
  ];

  for (const path of runtimeFiles) {
    if (!existsSync(resolve(ROOT, path))) continue;
    assertNoDistributorFinancialAuthority(path, read(path));
  }
});

await run("post-cleanup migrations do not reintroduce distributor financial schema", () => {
  const migrations = collectFiles("src/migrations", new Set([".sql", ".ts"])).filter((path) => {
    const name = path.split("/").at(-1) ?? "";
    const match = /^(\d+)/.exec(name);
    return match !== null && Number(match[1]) > 20;
  });

  for (const path of migrations) {
    const body = read(path);
    assertNoDistributorFinancialAuthority(path, body);
    assert.ok(
      !DISTRIBUTOR_TABLE_ADD_FINANCIAL_COLUMN.test(body),
      `${path} adds a financial column to a distributor/affiliate table`
    );
    assert.ok(
      !DISTRIBUTOR_FINANCIAL_TABLE_DEFINITION.test(body),
      `${path} creates a distributor/affiliate financial table`
    );
  }
});

await run("legacy cleanup migration remains present and destructive-only", () => {
  const path = "src/migrations/020_drop_affiliate_legacy_columns.sql";
  assert.ok(existsSync(resolve(ROOT, path)), "affiliate legacy cleanup migration 020 must remain present");
  const body = read(path);
  assert.match(body, /DROP\s+COLUMN[\s\S]*commission_rate/i, "migration 020 must keep dropping commission_rate");
  assert.match(body, /DROP\s+COLUMN[\s\S]*commission_amount/i, "migration 020 must keep dropping commission_amount");
  assert.match(body, /DROP\s+COLUMN[\s\S]*payout_status/i, "migration 020 must keep dropping payout_status");
  assert.ok(
    !/ADD\s+COLUMN[\s\S]{0,120}(commission_rate|commission_amount|payout_status)/i.test(body),
    "migration 020 must never recreate removed distributor-money columns"
  );
});

await run("distributor measurement migration stays attribution-only", () => {
  const body = read("src/migrations/046_distributor_measurement_surfaces.sql");
  assert.match(body, /attribution-only measurement resources/i);
  assert.match(body, /CREATE TABLE IF NOT EXISTS siton\.affiliate_links/i);
  assert.match(body, /CREATE TABLE IF NOT EXISTS siton\.affiliate_link_events/i);
  assertNoDistributorFinancialAuthority("src/migrations/046_distributor_measurement_surfaces.sql", body);
  assert.ok(
    !DISTRIBUTOR_TABLE_ADD_FINANCIAL_COLUMN.test(body),
    "measurement migration must not add financial columns to distributor tables"
  );
});

console.log("\nDistributor financial-policy regression guard completed.");
