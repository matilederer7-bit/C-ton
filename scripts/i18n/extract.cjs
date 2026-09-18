#!/usr/bin/env node
/**
 * SITON i18n EXTRACTOR
 *
 * Walks the real TypeScript/TSX syntax tree (not a regex) and rewrites every
 * Hebrew SYSTEM string into a `t("namespace.key")` call, emitting the Hebrew
 * dictionary as it goes.
 *
 * It is deliberately conservative: anything it cannot rewrite with certainty
 * is reported as a leftover for a human to handle, never guessed at.
 *
 *   node scripts/i18n/extract.cjs --apply      rewrite sources + dictionary
 *   node scripts/i18n/extract.cjs              dry run (report only)
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const ts = require("typescript");

const ROOT = path.resolve(__dirname, "..", "..");
const SRC_ARG = process.argv.find((a) => a.startsWith("--src="));
const WEB_SRC = SRC_ARG ? path.resolve(ROOT, SRC_ARG.slice(6)) : path.join(ROOT, "web", "src");
const HEB = /[֐-׿]/;

// Files that ARE the translation source, or that hold content the product
// must not machine-translate. Never rewritten.
const SKIP = new Set([
  path.join(WEB_SRC, "i18n"),
]);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (SKIP.has(p)) continue;
    if (entry.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(p);
  }
  return out;
}

/** Namespace for a file: web/src/pages/seller.tsx -> "seller" */
function namespaceOf(file) {
  const rel = path.relative(WEB_SRC, file).replace(/\.tsx?$/, "");
  const parts = rel.split(path.sep);
  const base = parts[parts.length - 1];
  if (parts.length === 1) return base.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  return parts.slice(0, -1).concat(base).join(".").replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

function shortHash(text) {
  return crypto.createHash("sha1").update(text, "utf8").digest("hex").slice(0, 8);
}

/** Derive a placeholder name from an interpolated expression. */
function placeholderName(expr, index, used) {
  let name = "";
  const text = expr.getText();
  const ident = /([A-Za-z_$][\w$]*)\s*$/.exec(text.replace(/\)+$/, ""));
  if (/^[A-Za-z_$][\w$]*$/.test(text)) name = text;
  else if (ident) name = ident[1];
  name = String(name || "").replace(/[^A-Za-z0-9_]/g, "");
  if (!name || /^\d/.test(name)) name = "v" + index;
  name = name.charAt(0).toLowerCase() + name.slice(1);
  let candidate = name;
  let n = 2;
  while (used.has(candidate)) candidate = name + n++;
  used.add(candidate);
  return candidate;
}

function collapseJsxText(raw) {
  return raw.replace(/\s+/g, " ").trim();
}

function processFile(file, state) {
  const source = fs.readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const ns = namespaceOf(file);
  /** @type {{start:number,end:number,text:string}[]} */
  const edits = [];
  const leftovers = [];

  /**
   * A literal evaluated at MODULE LOAD (a top-level const map, a frozen
   * array) must not become `t(...)`: it would freeze the copy in whatever
   * language happened to be active at import time and survive every later
   * language switch. Those sites are reported, not rewritten, so each one is
   * converted by hand into a function the render path calls.
   */
  const insideFunction = (node) => {
    for (let p = node.parent; p; p = p.parent) {
      if (ts.isFunctionDeclaration(p) || ts.isFunctionExpression(p) ||
          ts.isArrowFunction(p) || ts.isMethodDeclaration(p) ||
          ts.isGetAccessor(p) || ts.isConstructorDeclaration(p)) return true;
      if (ts.isSourceFile(p)) return false;
    }
    return false;
  };

  const deferModuleLevel = (node, text) => {
    if (insideFunction(node)) return false;
    leftovers.push({
      file: path.relative(ROOT, file),
      line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
      kind: "module-level",
      text: String(text).slice(0, 120)
    });
    return true;
  };

  const register = (hebrew, vars) => {
    const key = `${ns}.${shortHash(hebrew)}`;
    if (state.he.has(key) && state.he.get(key) !== hebrew) {
      throw new Error(`key collision ${key}`);
    }
    state.he.set(key, hebrew);
    state.origin.set(key, (state.origin.get(key) || []).concat(path.relative(ROOT, file)));
    const varsPart = vars && vars.length
      ? `, { ${vars.map((v) => `${v.name}: ${v.expr}`).join(", ")} }`
      : "";
    return `t(${JSON.stringify(key)}${varsPart})`;
  };

  const visit = (node) => {
    // ── A whole JSX sentence: text interleaved with expressions ─────────
    // `<p>עוד {n} יחידות</p>` is ONE sentence, not two fragments. It becomes
    // one key with a named placeholder, so a translator can move the number
    // to wherever the target language needs it.
    if ((ts.isJsxElement(node) || ts.isJsxFragment(node))) {
      const kids = node.children.filter((c) => !(ts.isJsxText(c) && !collapseJsxText(c.text)));
      const hasHebrewText = kids.some((c) => ts.isJsxText(c) && HEB.test(c.text));
      const allSimple = kids.length > 0 && kids.every((c) => ts.isJsxText(c) || (ts.isJsxExpression(c) && c.expression && !ts.isJsxElement(c.expression) && !ts.isConditionalExpression(c.expression)));
      const hasExpression = kids.some((c) => ts.isJsxExpression(c));
      if (hasHebrewText && hasExpression && allSimple && !deferModuleLevel(node, node.getText().slice(0, 80))) {
        const used = new Set();
        const vars = [];
        let pattern = "";
        let index = 0;
        let ok = true;
        for (const c of kids) {
          if (ts.isJsxText(c)) {
            const collapsed = collapseJsxText(c.text);
            const needsLead = pattern && !/\s$/.test(pattern) && /^\s/.test(c.text.replace(/\n[ \t]*/g, " "));
            pattern += (needsLead ? " " : "") + collapsed;
            if (/\s$/.test(c.text.replace(/\n[ \t]*/g, " "))) pattern += " ";
          } else {
            const expr = c.expression;
            // A bare string separator like {" "} is whitespace, not data.
            if (ts.isStringLiteral(expr) && !HEB.test(expr.text)) {
              if (!/\s$/.test(pattern)) pattern += expr.text;
              continue;
            }
            if (HEB.test(expr.getText())) { ok = false; break; }
            const name = placeholderName(expr, index++, used);
            vars.push({ name, expr: expr.getText() });
            pattern += `{${name}}`;
          }
        }
        pattern = pattern.replace(/\s+/g, " ").trim();
        if (ok && pattern && HEB.test(pattern)) {
          const first = kids[0];
          const last = kids[kids.length - 1];
          edits.push({ start: first.getStart(sf), end: last.getEnd(), text: `{${register(pattern, vars)}}` });
          return;
        }
      }
    }

    // ── JSX text ────────────────────────────────────────────────────────
    if (ts.isJsxText(node) && HEB.test(node.text)) {
      const collapsed = collapseJsxText(node.text);
      if (!collapsed) return;
      // Only rewrite when the text node is the WHOLE meaningful content
      // between its delimiters; mixed text+expression sentences are reported
      // so a human can decide the placeholder, never guessed at.
      const parent = node.parent;
      const siblings = (parent.children || []).filter((c) =>
        !(ts.isJsxText(c) && !collapseJsxText(c.text)));
      const hasExpressionSibling = siblings.some((c) => ts.isJsxExpression(c) && c.expression);
      if (hasExpressionSibling) {
        leftovers.push({ file, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, kind: "jsx-mixed", text: collapsed });
        return;
      }
      if (deferModuleLevel(node, collapsed)) return;
      const lead = /^\s*/.exec(node.text)[0].includes("\n") ? "" : (/^\s/.test(node.text) ? " " : "");
      const tail = /\s*$/.exec(node.text)[0].includes("\n") ? "" : (/\s$/.test(node.text) ? " " : "");
      edits.push({ start: node.getStart(sf), end: node.getEnd(), text: `${lead}{${register(collapsed)}}${tail}` });
      return;
    }

    // ── String literals ─────────────────────────────────────────────────
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && HEB.test(node.text)) {
      const parent = node.parent;
      // A property NAME written in Hebrew is data, not copy.
      if ((ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent)) && parent.name === node) return;
      if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) return;
      if (ts.isLiteralTypeNode(parent)) return;
      if (deferModuleLevel(node, node.text)) return;
      const call = register(node.text);
      if (ts.isJsxAttribute(parent) && parent.initializer === node) {
        edits.push({ start: node.getStart(sf), end: node.getEnd(), text: `{${call}}` });
      } else {
        edits.push({ start: node.getStart(sf), end: node.getEnd(), text: call });
      }
      return;
    }

    // ── Template literals with interpolation ────────────────────────────
    if (ts.isTemplateExpression(node) && HEB.test(node.getText())) {
      const used = new Set();
      const vars = [];
      let pattern = node.head.text;
      let ok = true;
      node.templateSpans.forEach((span, i) => {
        const name = placeholderName(span.expression, i, used);
        vars.push({ name, expr: span.expression.getText() });
        pattern += `{${name}}` + span.literal.text;
        if (HEB.test(span.expression.getText())) ok = false; // nested copy
      });
      if (!ok) {
        leftovers.push({ file, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, kind: "nested-template", text: node.getText().slice(0, 120) });
        return;
      }
      if (deferModuleLevel(node, pattern)) return;
      const call = register(pattern, vars);
      const parent = node.parent;
      if (ts.isJsxAttribute(parent) && parent.initializer === node) {
        edits.push({ start: node.getStart(sf), end: node.getEnd(), text: `{${call}}` });
      } else {
        edits.push({ start: node.getStart(sf), end: node.getEnd(), text: call });
      }
      return;
    }

    ts.forEachChild(node, visit);
  };

  // forEachChild stops on a truthy return, so the visitor must always
  // answer undefined.
  ts.forEachChild(sf, (node) => { visit(node); });

  if (!edits.length) return { changed: false, leftovers, source };

  edits.sort((a, b) => b.start - a.start);
  let out = source;
  let lastStart = Infinity;
  for (const e of edits) {
    if (e.end > lastStart) continue; // overlapping (nested) edit: skip outer
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
    lastStart = e.start;
  }
  return { changed: true, leftovers, source: out, count: edits.length };
}

function ensureImport(file, code) {
  if (/from\s+"[^"]*\/i18n"/.test(code) || /from\s+"\.\/i18n"/.test(code)) return code;
  const rel = path.relative(path.dirname(file), path.join(WEB_SRC, "i18n")).split(path.sep).join("/");
  const spec = rel.startsWith(".") ? rel : "./" + rel;
  const stmt = `import { t } from "${spec}";\n`;
  // after the last import at the top of the file
  const lines = code.split("\n");
  let insertAt = 0;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*import\s/.test(lines[i])) insertAt = i + 1;
    else if (/^\s*(\/\/|\/\*|\*|$)/.test(lines[i])) continue;
    else if (insertAt > 0) break;
  }
  lines.splice(insertAt, 0, stmt.trimEnd());
  return lines.join("\n");
}

function main() {
  const apply = process.argv.includes("--apply");
  const files = walk(WEB_SRC);
  const state = { he: new Map(), origin: new Map() };
  const allLeftovers = [];
  let changedFiles = 0;
  let replaced = 0;
  for (const file of files) {
    const res = processFile(file, state);
    allLeftovers.push(...res.leftovers);
    if (!res.changed) continue;
    changedFiles++;
    replaced += res.count;
    if (apply) fs.writeFileSync(file, ensureImport(file, res.source));
  }
  const report = {
    files: files.length,
    changedFiles,
    replaced,
    keys: state.he.size,
    leftovers: allLeftovers.length
  };
  console.log(JSON.stringify(report, null, 2));
  const outDir = path.join(ROOT, ".i18n-work");
  fs.mkdirSync(outDir, { recursive: true });

  fs.writeFileSync(path.join(outDir, "he.json"), JSON.stringify(Object.fromEntries([...state.he.entries()].sort()), null, 2));
  if (process.argv.includes("--write-extracted")) {
    fs.writeFileSync(path.join(ROOT, "scripts", "i18n", "extracted.he.json"),
      JSON.stringify(Object.fromEntries([...state.he.entries()].sort()), null, 2) + "\n");
  }
  fs.writeFileSync(path.join(outDir, "origin.json"), JSON.stringify(Object.fromEntries([...state.origin.entries()].sort()), null, 2));
  fs.writeFileSync(path.join(outDir, "leftovers.json"), JSON.stringify(allLeftovers, null, 2));
}

main();
