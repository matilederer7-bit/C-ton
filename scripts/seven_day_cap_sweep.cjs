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

function scanRepository(root) {
  const findings = [];
  for (const { rel, abs } of walkRepository(root)) {
    if (rel === SELF_PATH) continue;
    let source;
    try { source = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    findings.push(...scanSource(rel, source));
  }
  return findings;
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
