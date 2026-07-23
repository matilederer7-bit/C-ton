const fs = require("node:fs");
const path = require("node:path");

const roots = ["src"];
const files = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)) files.push(full);
  }
}
for (const root of roots) walk(root);

const ddl = /\b(?:CREATE|ALTER|DROP|TRUNCATE)\s+(?:TABLE|INDEX|TRIGGER|FUNCTION|SCHEMA|TYPE|VIEW|CONSTRAINT)\b/i;
const failures = [];
for (const file of files) {
  const source = fs.readFileSync(file, "utf8");
  if (ddl.test(source)) failures.push(path.relative(process.cwd(), file));
}
if (failures.length) {
  console.error("RUNTIME_DDL_SCAN_FAIL");
  failures.forEach((file) => console.error(`- ${file}`));
  process.exit(1);
}
console.log("RUNTIME_DDL_SCAN_PASS");
console.log(`SCANNED_RUNTIME_FILES=${files.length}`);
