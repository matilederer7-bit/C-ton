#!/usr/bin/env node
'use strict';

// Seven-day DEAL-DURATION cap sweep.
//
// The owner decision of 2026-09-16 (LONG_HORIZON_DEALS) removed the fixed
// seven-day maximum deal duration. `src/deadline_policy.ts` is the single
// server-side source of truth: a 2-hour minimum, a 20-year technical sanity
// ceiling, and an advisory notice above one year that never blocks.
//
// Regression tests already pin the CODE. What they cannot pin is prose: a
// constitution, spec, UX document, README, runbook or comment that still
// states the cap as if it were active. Historical documents are allowed to
// quote the old rule — the repository deliberately preserves them verbatim —
// but only when the surrounding text marks it superseded.
//
// This gate therefore flags exactly one thing: a line asserting a seven-day
// bound in a DEAL-DEADLINE context with no reconciliation marker nearby.
//
// It deliberately ignores the other, legitimate seven-day values in this
// repository, which are NOT this rule and must never be "fixed":
//   - a product's delivery estimate (e.g. 3-7 business days), which is
//     fulfilment time AFTER a deal completes, not the deal's duration;
//   - Grow's documented J5 authorization-hold validity (about 7 days);
//   - admin alert thresholds on authorization age;
//   - Freeze-Payouts approval validity;
//   - the Low-priority support SLA;
//   - 7d analytics windows and `interval '7 days'` SQL ranges.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { walkRepository } = require('./lib/repo_scan_policy.cjs');

const SELF_PATH = path.normalize(path.join('scripts', 'seven_day_cap_sweep.cjs'));

// A seven-day quantity, in either language.
const SEVEN_DAYS = /(7|שבעה)\s*[-\s]?\s*(day|days|ימים|יום)/i;

// ...spoken about a deal's deadline / duration.
const DEAL_DEADLINE_CONTEXT =
  /deadline|דדליין|מועד סיום|deal (duration|length|lifetime)|משך (ה)?עסק|עסקה[^\n]{0,25}(ימים|יום)|DEADLINE_MAX/i;

// ...that is one of the other seven-day facts, not this rule.
const A_DIFFERENT_SEVEN_DAY_FACT =
  /delivery|אספקה|משלוח|ימי עסקים|business day|shipping|J5|authorization hold|hold is|retention|analytic|תקופה|period|SLA|freeze|payout|support|Low priority|interval '7 day|now\(\)\s*[+-]\s*interval|last7|\b7d\b|soak|outbox|backup|archive|alert threshold/i;

// ...and evidence the text already records the rule as gone.
const RECONCILED =
  /obsolete|historical|deprecated|removed|no longer|cancelled|canceled|בוטל|היסטורי|resolved|DONE|no fixed|no seven-day|no 7-day|not a platform limit|template choice|former|לא קיים|אין מגבל|RESOLUTION|CLOSED|~~/i;

const CONTEXT_LINES = 6;

function scanSource(relative, source) {
  const findings = [];
  const lines = source.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (!SEVEN_DAYS.test(line)) return;
    if (!DEAL_DEADLINE_CONTEXT.test(line)) return;
    if (A_DIFFERENT_SEVEN_DAY_FACT.test(line)) return;
    const from = Math.max(0, index - CONTEXT_LINES);
    const context = lines.slice(from, index + CONTEXT_LINES + 1).join('\n');
    if (RECONCILED.test(context)) return;
    findings.push({ file: relative, line: index + 1, text: line.trim().slice(0, 200) });
  });
  return findings;
}

// ---------------------------------------------------------------------------
// .docx support
//
// The owner's constitution, product spec and UX document are Word files. Their
// text lives in XML inside a zip, so a plain text scan never sees it — which is
// exactly how a seven-day cap survived in them after the Markdown had been
// reconciled. These helpers extract the real paragraph text so the gate reads
// what a person opening the document would read.
//
// Word splits one logical sentence across many <w:t> runs (RTL, spell check,
// revision marks), so runs are joined per <w:p> before matching. Without that
// join, "דדליין מקסימום 7 ימים" is invisible to any regex.
// ---------------------------------------------------------------------------

const DOCX_TEXT_PARTS = /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/;

function xmlDecode(value) {
  return value
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&');
}

function docxParagraphs(xml) {
  const out = [];
  for (const chunk of xml.split(/<w:p[ >]/).slice(1)) {
    const body = chunk.split('</w:p>')[0];
    const runs = [...body.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((m) => xmlDecode(m[1]));
    if (runs.length) out.push(runs.join(''));
  }
  return out;
}

// Extract the archive to a temporary directory rather than naming members:
// `unzip -p` treats [ and ] in a member name as glob metacharacters, which
// [Content_Types].xml trips over.
function docxText(file) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'seven-day-docx-'));
  try {
    execFileSync('unzip', ['-qq', '-o', file, '-d', temp], { stdio: 'pipe' });
    const paragraphs = [];
    const walk = (dir, base) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        const rel = base ? `${base}/${entry.name}` : entry.name;
        if (entry.isDirectory()) { walk(abs, rel); continue; }
        if (!DOCX_TEXT_PARTS.test(rel)) continue;
        paragraphs.push(...docxParagraphs(fs.readFileSync(abs, 'utf8')));
      }
    };
    walk(temp, '');
    return paragraphs;
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function listDocx(root) {
  const out = [];
  const skip = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.demo_dist', '.tmp_test_dist', '.mobile_dist']);
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (!skip.has(entry.name)) walk(abs); continue; }
      if (entry.name.toLowerCase().endsWith('.docx')) out.push(abs);
    }
  };
  walk(root);
  return out;
}

function scanDocx(root) {
  const findings = [];
  for (const abs of listDocx(root)) {
    const rel = path.relative(root, abs);
    let paragraphs;
    try {
      paragraphs = docxText(abs);
    } catch (error) {
      // A .docx the gate cannot read is a finding in itself: it would otherwise
      // be a silent hole exactly where the rule already hid once.
      findings.push({ file: rel, line: 0, text: `unreadable .docx (${error.message.slice(0, 80)})` });
      continue;
    }
    // Reuse the line scanner by treating each paragraph as a line, so the
    // classification and the context window behave identically to source text.
    findings.push(...scanSource(rel, paragraphs.join('\n')).map((f) => ({ ...f, paragraph: f.line })));
  }
  return findings;
}

function scanRepository(root) {
  const findings = [];
  for (const { rel, abs } of walkRepository(root)) {
    if (rel === SELF_PATH) continue;
    let source;
    try { source = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    findings.push(...scanSource(rel, source));
  }
  findings.push(...scanDocx(root));
  return findings;
}

// Build a minimal but genuinely valid .docx for the self-test. Each paragraph
// is given as an array of run texts so a fixture can reproduce Word's habit of
// splitting one sentence across several <w:t> elements.
function buildFixtureDocx(dir, name, paragraphs) {
  const escape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const body = paragraphs
    .map((runs) => `<w:p>${runs.map((t) => `<w:r><w:t xml:space="preserve">${escape(t)}</w:t></w:r>`).join('')}</w:p>`)
    .join('');
  const documentXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body>${body}</w:body></w:document>`;
  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '</Types>';
  const rels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '</Relationships>';

  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'seven-day-fixture-'));
  const target = path.join(dir, name);
  try {
    fs.mkdirSync(path.join(stage, '_rels'), { recursive: true });
    fs.mkdirSync(path.join(stage, 'word'), { recursive: true });
    fs.writeFileSync(path.join(stage, '[Content_Types].xml'), contentTypes);
    fs.writeFileSync(path.join(stage, '_rels', '.rels'), rels);
    fs.writeFileSync(path.join(stage, 'word', 'document.xml'), documentXml);
    execFileSync('zip', ['-q', '-r', target, '[Content_Types].xml', '_rels', 'word'], { cwd: stage });
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
  return target;
}

function runSelfTest() {
  const cases = [
    // [name, source, expectedFindings]
    ['bare cap in a spec', 'דדליין לעיסקה לא יעלה על 7 ימים ממועד הפרסום.\n', 1],
    ['bare cap in English', 'The deal deadline may not exceed 7 days.\n', 1],
    [
      'cap under an obsolete marker',
      '## OBSOLETE rule\n\nThis document states a maximum deal deadline of 7 ימים.\n',
      0
    ],
    [
      'cap struck through as resolved',
      '| A-8 | ~~Deadline hard cap 7 days~~ RESOLVED 2026-09-16 |\n',
      0
    ],
    [
      'cap qualified as a template choice',
      '| Deadline | 7 days (template choice, not a platform limit) |\n',
      0
    ],
    ['delivery estimate is not this rule', 'זמן אספקה משוער: 3-7 ימי עסקים מהשלמת העסקה.\n', 0],
    ['provider hold is not this rule', 'Grow J5 authorization hold is valid for up to 7 days.\n', 0],
    ['analytics window is not this rule', "WHERE created_at > now() - interval '7 days'\n", 0],
    ['support SLA is not this rule', '| Low | 7 days |\n', 0],
    ['unrelated seven days', 'The pilot ran for 7 days without incident.\n', 0],
    [
      'a marker further than the context window does not launder a bare cap',
      'OBSOLETE\n' + '\n'.repeat(20) + 'דדליין מקסימום 7 ימים\n',
      1
    ]
  ];

  let failures = 0;
  for (const [name, source, expected] of cases) {
    const actual = scanSource('fixture.md', source).length;
    if (actual !== expected) {
      console.error(`self-test FAIL: ${name} — expected ${expected} finding(s), got ${actual}`);
      failures += 1;
    }
  }

  // The walker must actually reach a planted file on disk.
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'siton-seven-day-sweep-'));
  try {
    const docs = path.join(temp, 'docs');
    fs.mkdirSync(docs, { recursive: true });
    fs.writeFileSync(path.join(docs, 'planted.md'), 'דדליין מקסימום 7 ימים\n');
    fs.writeFileSync(path.join(docs, 'clean.md'), 'זמן אספקה: 3-7 ימי עסקים.\n');
    const found = scanRepository(temp);
    if (found.length !== 1 || !found[0].file.endsWith('planted.md')) {
      console.error(`self-test FAIL: walker did not find exactly the planted file: ${JSON.stringify(found)}`);
      failures += 1;
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }

  // The gate must read the real text INSIDE a .docx, not a marker file beside
  // it. Both fixtures below split the sentence across <w:t> runs the way Word
  // actually stores it, so a scan that does not join runs per paragraph fails
  // this test — which is precisely the hole that let the cap survive before.
  const docxTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'siton-seven-day-docx-'));
  try {
    const planted = buildFixtureDocx(docxTemp, 'planted.docx', [
      ['3.3 כללים עסקיים מחייבים'],
      ['דדליין ', 'מקסימום ', '7 ', 'ימים'],
      ['מינימום יחידות מוגדר מראש']
    ]);
    const clean = buildFixtureDocx(docxTemp, 'clean.docx', [
      ['דדליין ', 'מינימום 2 שעות, ללא מגבלת מקסימום קבועה'],
      ['זמן אספקה משוער: ', '3-7 ', 'ימי עסקים'],
      ['Authorization > ', '7 ', 'ימים']
    ]);

    const inPlanted = scanDocx(docxTemp).filter((f) => f.file.endsWith('planted.docx'));
    if (inPlanted.length !== 1) {
      console.error(`self-test FAIL: a cap planted inside a .docx was not detected (got ${inPlanted.length})`);
      failures += 1;
    }
    const inClean = scanDocx(docxTemp).filter((f) => f.file.endsWith('clean.docx'));
    if (inClean.length !== 0) {
      console.error(`self-test FAIL: legitimate .docx text was flagged: ${JSON.stringify(inClean)}`);
      failures += 1;
    }
    if (!fs.existsSync(planted) || !fs.existsSync(clean)) {
      console.error('self-test FAIL: .docx fixtures were not written');
      failures += 1;
    }
  } catch (error) {
    console.error(`self-test FAIL: .docx fixture check errored: ${error.message}`);
    failures += 1;
  } finally {
    fs.rmSync(docxTemp, { recursive: true, force: true });
  }

  if (failures > 0) {
    console.error(`SEVEN_DAY_CAP_SWEEP_SELF_TEST_FAIL failures=${failures}`);
    process.exitCode = 1;
    return;
  }
  console.log('SEVEN_DAY_CAP_SWEEP_SELF_TEST_PASS');
}

function main() {
  if (process.argv.includes('--self-test')) {
    runSelfTest();
    return;
  }

  const findings = scanRepository(process.cwd());
  if (findings.length === 0) {
    console.log('SEVEN_DAY_CAP_SWEEP_PASS');
    console.log('No unreconciled seven-day deal-duration cap found in repository text.');
    return;
  }

  console.error('SEVEN_DAY_CAP_SWEEP_FAIL');
  console.error('There is no fixed maximum deal duration (LONG_HORIZON_DEALS, 2026-09-16).');
  console.error('Each line below states a seven-day deal deadline with no supersession marker nearby.');
  console.error('Mark it obsolete where it is historical; correct it where it is current.');
  for (const finding of findings) {
    console.error(`${finding.file}:${finding.line} ${finding.text}`);
  }
  process.exitCode = 1;
}

main();
