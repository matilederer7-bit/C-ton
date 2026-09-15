// Runtime DDL scan (npm run scan:runtime-ddl).
//
// Invariant: application runtime code under src/ never issues schema DDL.
// Schema changes live exclusively in src/migrations/*.sql through the ledgered
// migration runner. The runtime may only `CREATE SCHEMA IF NOT EXISTS` /
// `CREATE TABLE IF NOT EXISTS` for the migration ledger itself, which lives in
// scripts/run_migrations.cjs, outside src/.
//
// File selection follows scripts/lib/repo_scan_policy.cjs. SQL migration
// files are not script sources and are not matched by the extension filter;
// the two retired .ts stubs under src/migrations stay in scope so a revived
// TypeScript migration path would be caught.
const fs = require("node:fs");
const policy = require("./lib/repo_scan_policy.cjs");

const root = process.cwd();
const files = policy.walkRepository(root, {
  roots: ["src"],
  extensions: /\.(ts|tsx|js|mjs|cjs)$/
});

const ddl = /\b(?:CREATE|ALTER|DROP|TRUNCATE)\s+(?:TABLE|INDEX|TRIGGER|FUNCTION|SCHEMA|TYPE|VIEW|CONSTRAINT)\b/i;
const failures = [];
for (const file of files) {
  const source = fs.readFileSync(file.abs, "utf8");
  if (ddl.test(source)) failures.push(file.rel);
}
if (failures.length) {
  console.error("RUNTIME_DDL_SCAN_FAIL");
  failures.forEach((file) => console.error("- " + file));
  process.exit(1);
}
console.log("RUNTIME_DDL_SCAN_PASS");
console.log("SCANNED_RUNTIME_FILES=" + files.length);
