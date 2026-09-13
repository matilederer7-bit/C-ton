// Semantic raw-card-data term scanner.
//
// The invariant: Siton code never HANDLES raw cardholder data. Handling means a
// field, column, identifier, form input or JSON key named after cardholder
// data (card number, CVV/CVC, PAN, expiry). Prose that says "we do not store
// CVV" is not handling - the previous scanners flagged exactly that sentence in
// src/legal_pages.ts and had to hard-code a per-file exemption, which is a
// false positive dressed up as policy.
//
// This scanner therefore looks at IDENTIFIERS, not words:
//   - TypeScript / JavaScript: AST identifiers, property names, string-literal
//     object keys and element-access keys, plus SQL identifiers inside
//     SQL-shaped string/template literals.
//   - SQL files: identifiers after comments and quoted literals are stripped.
//   - HTML: name/id/for/data-* attribute values and inline scripts.
//   - CSS: id/class selectors and attribute selectors.
// Prose inside string literals (spaces, Hebrew, punctuation) is never a hit.
//
// An identifier matches when a forbidden term equals the identifier or one of
// its snake/camel segments. Deliberate evidence fields (e.g. a compliance
// report key `raw_pan_in_json` whose value is "no") are allowed ONLY through an
// explicit allow-list entry naming the file, the identifier and a reason.
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const FORBIDDEN_TERMS = Object.freeze([
  "card_number",
  "credit_card_number",
  "cvv",
  "cvc",
  "cvv2",
  "cvc2",
  "raw_card",
  "pan",
  "expiry_month",
  "expiry_year",
  "full_card",
  "cardholder_data",
  "track_data",
  "magstripe"
]);

const SQL_SHAPE = /\b(select|insert|update|delete|create|alter|drop)\b[\s\S]*\b(from|into|table|set|where|values|index)\b/i;
const IDENTIFIER_LIKE = /^[A-Za-z_$][A-Za-z0-9_$.-]*$/;

function normalizeSegments(identifier) {
  // camelCase -> snake segments, keep digits attached: cvv2 stays cvv2.
  const snake = String(identifier)
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
  return snake.split(/[^a-z0-9]+/).filter(Boolean);
}

/** Return the forbidden term an identifier matches, or null. */
function matchIdentifier(identifier, terms = FORBIDDEN_TERMS) {
  const segments = normalizeSegments(identifier);
  if (!segments.length) return null;
  const joined = segments.join("_");
  for (const term of terms) {
    if (joined === term) return term;
    const termSegments = term.split("_");
    // Term appears as a contiguous run of segments (raw_pan_in_json -> pan).
    for (let start = 0; start + termSegments.length <= segments.length; start += 1) {
      let ok = true;
      for (let offset = 0; offset < termSegments.length; offset += 1) {
        if (segments[start + offset] !== termSegments[offset]) { ok = false; break; }
      }
      if (ok) return term;
    }
  }
  return null;
}

function lineOf(text, index) {
  let line = 1;
  for (let cursor = 0; cursor < index && cursor < text.length; cursor += 1) if (text.charCodeAt(cursor) === 10) line += 1;
  return line;
}

function stripSql(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .replace(/'(?:[^']|'')*'/g, " ")
    .replace(/\$\$[\s\S]*?\$\$/g, (block) => block.replace(/'(?:[^']|'')*'/g, " "));
}

function scanSqlText(sqlText, baseLine, terms, out, rel) {
  const stripped = stripSql(sqlText);
  const tokens = stripped.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g);
  for (const token of tokens) {
    const term = matchIdentifier(token[0], terms);
    if (term) out.push({ rel, line: baseLine + lineOf(sqlText, token.index) - 1, term, kind: "sql-identifier", identifier: token[0] });
  }
}

function scanTypeScript(rel, source, terms, out) {
  const kind = /\.tsx$/.test(rel) ? ts.ScriptKind.TSX : /\.tsx?$/.test(rel) ? ts.ScriptKind.TS : /\.jsx$/.test(rel) ? ts.ScriptKind.JSX : ts.ScriptKind.JS;
  const sourceFile = ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, true, kind);
  const report = (node, identifier, hitKind) => {
    const term = matchIdentifier(identifier, terms);
    if (!term) return;
    const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    out.push({ rel, line: pos.line + 1, term, kind: hitKind, identifier });
  };
  const visit = (node) => {
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
      report(node, node.text, "identifier");
    } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const text = node.text;
      if (IDENTIFIER_LIKE.test(text)) {
        report(node, text, "string-key");
      } else if (SQL_SHAPE.test(text)) {
        const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        scanSqlText(text, pos.line + 1, terms, out, rel);
      }
    } else if (ts.isTemplateExpression(node)) {
      const full = node.getText(sourceFile);
      if (SQL_SHAPE.test(full)) {
        const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        const literalOnly = [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(" __expr__ ");
        scanSqlText(literalOnly, pos.line + 1, terms, out, rel);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

function scanSqlFile(rel, source, terms, out) {
  scanSqlText(source, 1, terms, out, rel);
}

function scanHtml(rel, source, terms, out) {
  for (const match of source.matchAll(/\b(name|id|for|data-[\w-]+)\s*=\s*["']([^"']+)["']/gi)) {
    const term = matchIdentifier(match[2], terms);
    if (term) out.push({ rel, line: lineOf(source, match.index), term, kind: "html-attribute", identifier: match[2] });
  }
  for (const script of source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    const inner = [];
    scanTypeScript(rel + "#inline-script", script[1], terms, inner);
    const base = lineOf(source, script.index);
    for (const hit of inner) out.push({ ...hit, rel, line: base + hit.line - 1 });
  }
}

function scanCss(rel, source, terms, out) {
  for (const match of source.matchAll(/[#.]([A-Za-z_][\w-]*)|\[\s*(?:name|id|data-[\w-]+)\s*[*^$|~]?=\s*["']?([^"'\]]+)["']?\s*\]/g)) {
    const identifier = match[1] || match[2];
    const term = matchIdentifier(identifier, terms);
    if (term) out.push({ rel, line: lineOf(source, match.index), term, kind: "css-selector", identifier });
  }
}

/**
 * Scan one file. Returns findings [{ rel, line, term, kind, identifier }].
 */
function scanFile(rel, source, terms = FORBIDDEN_TERMS) {
  const out = [];
  if (/\.(ts|tsx|js|jsx|cjs|mjs)$/i.test(rel)) scanTypeScript(rel, source, terms, out);
  else if (/\.sql$/i.test(rel)) scanSqlFile(rel, source, terms, out);
  else if (/\.html?$/i.test(rel)) scanHtml(rel, source, terms, out);
  else if (/\.css$/i.test(rel)) scanCss(rel, source, terms, out);
  return out;
}

/**
 * Apply an allow-list of `{ file, identifier, reason }` entries. Wildcards are
 * refused: every entry must name one file and one identifier and carry a reason.
 */
function applyAllowList(findings, allowList = []) {
  for (const entry of allowList) {
    if (!entry || typeof entry !== "object") throw new Error("raw-card allow-list entry must be an object");
    for (const field of ["file", "identifier", "reason"]) {
      if (typeof entry[field] !== "string" || !entry[field].trim()) throw new Error("raw-card allow-list entry requires a non-empty " + field);
      if (/[*?]/.test(entry[field]) && field !== "reason") throw new Error("raw-card allow-list entries cannot use wildcards: " + entry[field]);
    }
  }
  const kept = [];
  const used = new Set();
  for (const finding of findings) {
    const match = allowList.find((entry) => entry.file === finding.rel && entry.identifier === finding.identifier);
    if (match) { used.add(match); continue; }
    kept.push(finding);
  }
  return { findings: kept, unusedAllowListEntries: allowList.filter((entry) => !used.has(entry)) };
}

function loadAllowList(root = process.cwd()) {
  const file = path.join(root, "config", "raw-card-term-allowlist.json");
  if (!fs.existsSync(file)) return [];
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  return Array.isArray(parsed.allow) ? parsed.allow : [];
}

module.exports = { FORBIDDEN_TERMS, matchIdentifier, normalizeSegments, scanFile, applyAllowList, loadAllowList, stripSql };
