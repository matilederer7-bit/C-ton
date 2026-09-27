#!/usr/bin/env node
// Money reconciliation checker (npm run db:money-invariants).
//
// READ-ONLY: every query runs inside `BEGIN TRANSACTION READ ONLY` (REPEATABLE
// READ, one snapshot) and the transaction is rolled back at the end, so it is
// safe against a hosted staging/production database. It never prints the
// connection string or password — only host:port and database name.
//
// Target: MONEY_INVARIANTS_DATABASE_URL, else DATABASE_URL. (No URL flag on
// purpose: a URL on the command line leaks into shell history and `ps`.)
//
// Output: one line per invariant
//   MONEY_INVARIANT <PASS|FAIL|SKIPPED|INFO|ERROR> <name> count=N [exact_mismatch=N] samples=[<=5 ids]
// then MONEY_INVARIANTS_SUMMARY and MONEY_INVARIANTS_PASS / MONEY_INVARIANTS_FAIL.
// --json additionally prints the full report as one JSON line.
//
// Exit: 0 all PASS (SKIPPED/INFO allowed), 1 any FAIL/ERROR, 2 cannot run.
const { Client } = require("pg");
require("dotenv").config({ quiet: true });
const lib = require("./lib/money_invariants.cjs");

async function main(argv = process.argv.slice(2), env = process.env) {
  const url = env.MONEY_INVARIANTS_DATABASE_URL || env.DATABASE_URL;
  if (!url) {
    console.error("MONEY_INVARIANTS_ERROR DATABASE_URL (or MONEY_INVARIANTS_DATABASE_URL) is not set");
    return 2;
  }
  console.log("money invariants target " + lib.describeTarget(url) + " (read-only transaction)");
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 15000, application_name: "siton-money-invariants" });
  let report;
  try {
    await client.connect();
    report = await lib.runInvariants(client);
  } catch (error) {
    console.error("MONEY_INVARIANTS_ERROR " + lib.redact(error && error.message ? error.message : error));
    return 2;
  } finally {
    await client.end().catch(() => undefined);
  }
  for (const result of report.results) console.log(lib.formatResult(result));
  const c = report.counts;
  console.log("MONEY_INVARIANTS_SUMMARY overall=" + report.overall + " pass=" + c.PASS + " fail=" + c.FAIL + " error=" + c.ERROR + " skipped=" + c.SKIPPED + " info=" + c.INFO + " total=" + report.results.length);
  if (argv.includes("--json")) console.log(JSON.stringify(report));
  console.log(report.overall === "PASS" ? "MONEY_INVARIANTS_PASS" : "MONEY_INVARIANTS_FAIL");
  return report.overall === "PASS" ? 0 : 1;
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; });
}

module.exports = { main };
