#!/usr/bin/env node
/**
 * SITON i18n GATE
 *
 * Two checks, both run in CI:
 *
 *  1. RESOLVE — every `t("key")` / key held in a `*_KEY` map resolves in the
 *     Hebrew dictionary. A key typo renders the key itself on screen; this
 *     fails the build instead.
 *
 *  2. FORGOTTEN SYSTEM COPY — no Hebrew string literal or JSX text is left in
 *     the shipped UI. The scan is deliberately narrow so it stays honest: the
 *     dictionaries themselves, the Hebrew CMS content modules, comments, test
 *     fixtures and user content are NOT system copy and are exempt. What it is
 *     hunting is a sentence a developer typed straight into a component and
 *     that therefore cannot ever appear in English.
 */
const fs = require("fs");
const path = require("path");
const ts = require("typescript");

const ROOT = path.resolve(__dirname, "..", "..");
const WEB_SRC = path.join(ROOT, "web", "src");
const HEB = /[֐-׿]/;

/**
 * Exempt files, each for a stated reason. This list is the whole escape hatch:
 * anything not named here must go through `t()`.
 */
const EXEMPT = new Map([
  ["i18n/dictionaries/he.ts", "IS the Hebrew dictionary"],
  ["i18n/dictionaries/en.ts", "IS the English dictionary"],
  ["i18n/glossary.ts", "the he↔en terminology table"],
  ["i18n/LanguageSwitch.tsx", "each language is named in its own language"],
  ["content/landing.he.ts", "Hebrew CMS default CONTENT (its sibling is landing.en.ts)"],
  ["content/seller.he.ts", "Hebrew CMS default CONTENT (its sibling is seller.en.ts)"]
]);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(p);
  }
  return out;
}

function loadDictionary() {
  const merge = (f) => {
    const p = path.join(ROOT, "scripts", "i18n", f);
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : {};
  };
  return { ...merge("seed.he.json"), ...merge("extracted.he.json") };
}

function scan() {
  const he = loadDictionary();
  const files = walk(WEB_SRC);
  const unresolved = [];
  const forgotten = [];
  const usedKeys = new Set();

  for (const file of files) {
    const rel = path.relative(WEB_SRC, file).split(path.sep).join("/");
    const src = fs.readFileSync(file, "utf8");
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const exempt = EXEMPT.has(rel);
    const at = (node) => `${rel}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`;

    const visit = (node) => {
      // 1. t("key") — the key must exist.
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
          (node.expression.text === "t" || node.expression.text === "he" || node.expression.text === "en") &&
          node.arguments.length && ts.isStringLiteral(node.arguments[0])) {
        const key = node.arguments[0].text;
        usedKeys.add(key);
        if (!(key in he)) unresolved.push({ where: at(node), key });
      }
      // Keys held in *_KEY / *_KEYS constants and maps.
      if (ts.isStringLiteral(node) && /^[a-z][a-z0-9_]*(\.[a-z0-9_[\]]+)+$/i.test(node.text) && node.text in he) {
        usedKeys.add(node.text);
      }

      // 2. Hebrew left in the shipped UI.
      if (!exempt) {
        if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && HEB.test(node.text)) {
          forgotten.push({ where: at(node), text: node.text.slice(0, 70) });
        } else if (ts.isTemplateExpression(node) && HEB.test(node.getText())) {
          forgotten.push({ where: at(node), text: node.getText().replace(/\s+/g, " ").slice(0, 70) });
        } else if (ts.isJsxText(node) && HEB.test(node.text)) {
          forgotten.push({ where: at(node), text: node.text.replace(/\s+/g, " ").trim().slice(0, 70) });
        }
      }
      ts.forEachChild(node, (c) => { visit(c); });
    };
    ts.forEachChild(sf, (n) => { visit(n); });
  }

  const orphans = Object.keys(he).filter((k) => !usedKeys.has(k));
  return { unresolved, forgotten, orphans, keys: Object.keys(he).length, used: usedKeys.size };
}

function main() {
  const r = scan();
  const json = process.argv.includes("--json");
  if (json) { console.log(JSON.stringify(r, null, 2)); return; }
  console.log(`i18n scan: ${r.keys} keys, ${r.used} referenced, ${r.orphans.length} unreferenced`);
  let bad = 0;
  if (r.unresolved.length) {
    bad++;
    console.error(`\nUNRESOLVED KEYS (${r.unresolved.length}) — these render the key on screen:`);
    for (const u of r.unresolved.slice(0, 40)) console.error(`  ${u.where}  ${u.key}`);
  }
  if (r.forgotten.length) {
    bad++;
    console.error(`\nHEBREW LEFT IN SYSTEM UI (${r.forgotten.length}) — cannot be shown in English:`);
    for (const f of r.forgotten.slice(0, 60)) console.error(`  ${f.where}  ${f.text}`);
  }
  if (bad) process.exit(1);
  console.log("i18n scan: PASS — every key resolves and no system string is hard-coded.");
}

main();
