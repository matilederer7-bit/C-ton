const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const root = process.cwd();
const ignored = new Set([".git", "node_modules", ".tmp_test_dist", ".demo_dist", ".tmp_gate_logs"]);
const files = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ignored.has(entry.name) || entry.name.startsWith(".tmp")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(ts|tsx|js|cjs|mjs)$/.test(entry.name)) files.push(full);
  }
}

for (const scope of ["src", "frontend", "scripts"]) {
  const dir = path.join(root, scope);
  if (fs.existsSync(dir)) walk(dir);
}

const failures = [];
for (const file of files) {
  const rel = path.relative(root, file);
  const source = fs.readFileSync(file, "utf8");
  const sourceFile = ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, true,
    /\.tsx?$/.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JS);

  function visit(node) {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      ["state", "buyer_state", "money_state"].includes(node.left.name.text)
    ) {
      const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart());
      failures.push(`${rel}:${pos.line + 1}: direct .${node.left.name.text} assignment`);
    }
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      /(^|\/)(stripe|@stripe)(\/|$)/i.test(node.moduleSpecifier.text) &&
      path.normalize(rel) !== path.normalize("src/payment_provider.ts")
    ) {
      const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart());
      failures.push(`${rel}:${pos.line + 1}: Payment SDK import outside src/payment_provider.ts`);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
}

const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9_]{30,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
  /\bsk_live_[A-Za-z0-9]{16,}\b/
];
for (const file of files) {
  const rel = path.relative(root, file);
  if (rel === path.join("scripts", "backend_enforcement_scan.cjs")) continue;
  const source = fs.readFileSync(file, "utf8");
  for (const pattern of secretPatterns) {
    if (pattern.test(source)) failures.push(`${rel}: possible committed secret matching ${pattern}`);
  }
}

if (failures.length) {
  console.error("BACKEND_ENFORCEMENT_SCAN_FAIL");
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log("BACKEND_ENFORCEMENT_SCAN_PASS");
console.log(`SCANNED_FILES=${files.length}`);
console.log("DIRECT_STATE_MUTATION_PASS");
console.log("PAYMENT_SDK_BOUNDARY_PASS");
console.log("SECRET_SCAN_PASS");
