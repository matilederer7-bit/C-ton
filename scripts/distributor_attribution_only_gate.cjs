#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.sql', '.json', '.yml', '.yaml'
]);

const SCAN_ROOTS = [
  'src',
  path.join('web', 'src'),
  'migrations',
  'supabase',
  'api',
  'workers',
  'infra',
  'scripts'
];

const IGNORED_DIRECTORIES = new Set([
  '.git', 'node_modules', '.demo_dist', '.tmp_test_dist', 'dist', 'build', 'coverage', 'legacy', 'docs'
]);

const SELF_PATH = path.normalize(path.join('scripts', 'distributor_attribution_only_gate.cjs'));
const LEGACY_CLEANUP_MIGRATION = path.normalize(
  path.join('src', 'migrations', '020_drop_affiliate_legacy_columns.sql')
);

// These files may name legacy money fields only because they remove or detect
// them. They are not runtime distributor-product surfaces.
const NEGATIVE_REFERENCE_PATHS = new Set([
  LEGACY_CLEANUP_MIGRATION,
  path.normalize(path.join('scripts', 'legal_compliance_gate.cjs'))
]);

const ROLE = '(?:affiliate|distributor|referrer|promoter)';
const MONEY = '(?:commission|payout|withdraw(?:al)?|balance|earning(?:s)?|entitlement|invoice|fee|reward)';
const FORBIDDEN_PATTERNS = [
  new RegExp(`${ROLE}[A-Za-z0-9_-]*${MONEY}`, 'i'),
  new RegExp(`${MONEY}[A-Za-z0-9_-]*${ROLE}`, 'i')
];

// Line-oriented identifier scanning is useful for runtime code, but it is not
// sufficient for SQL: a future migration can put the table name and the money
// column on different lines. These patterns deliberately span whitespace but
// stop at the SQL statement terminator so they catch schema authority rather
// than unrelated words later in the file.
const SQL_ROLE_TABLE = '(?:affiliate|distributor|referrer|promoter)[A-Za-z0-9_]*';
const SQL_MONEY_COLUMN =
  '(?:commission|payout|withdraw(?:al)?|balance|earning(?:s)?|entitlement|invoice|fee|reward)(?:_[A-Za-z0-9]+)*';
const SQL_DISTRIBUTOR_FINANCIAL_PATTERNS = [
  new RegExp(
    `ALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:[A-Za-z0-9_]+\\.)?${SQL_ROLE_TABLE}[^;]{0,600}?ADD\\s+COLUMN(?:\\s+IF\\s+NOT\\s+EXISTS)?\\s+${SQL_MONEY_COLUMN}\\b`,
    'i'
  ),
  new RegExp(
    `CREATE\\s+TABLE(?:\\s+IF\\s+NOT\\s+EXISTS)?\\s+(?:[A-Za-z0-9_]+\\.)?${SQL_ROLE_TABLE}\\s*\\([^;]{0,3000}?\\b${SQL_MONEY_COLUMN}\\s+(?:NUMERIC|DECIMAL|MONEY|TEXT|VARCHAR|CHAR|INTEGER|INT|BIGINT|BOOLEAN|JSONB?|UUID|TIMESTAMPTZ|TIMESTAMP|DATE)\\b`,
    'i'
  )
];
const SQL_ADD_FINANCIAL_COLUMN = new RegExp(
  `ADD\\s+COLUMN(?:\\s+IF\\s+NOT\\s+EXISTS)?\\s+${SQL_MONEY_COLUMN}\\b`,
  'i'
);

// An own-property check that is explicitly negated proves a forbidden money
// field is absent from a runtime payload. The asserted property name is the
// only place the forbidden identifier may appear on such a line.
const ABSENCE_ASSERTION =
  /!\s*(?:Object\.hasOwn|Object\.prototype\.hasOwnProperty\.call)\(\s*[A-Za-z0-9_.$[\]]+\s*,\s*(['"])([A-Za-z0-9_]+)\1\s*\)/g;

function isAbsenceAssertion(line) {
  const assertedNames = new Set();
  ABSENCE_ASSERTION.lastIndex = 0;
  let match;
  while ((match = ABSENCE_ASSERTION.exec(line)) !== null) assertedNames.add(match[2]);
  if (assertedNames.size === 0) return false;

  // Remove the asserted property names. Anything forbidden still left on the
  // line is a real reference riding along with the assertion, not a proof.
  let remainder = line;
  for (const name of assertedNames) remainder = remainder.split(name).join('');
  return !FORBIDDEN_PATTERNS.some((pattern) => pattern.test(remainder));
}

function isAllowedNegativeReference(relative, line) {
  if (NEGATIVE_REFERENCE_PATHS.has(relative)) return true;

  // Mission control may expose a literal safety assertion that the forbidden
  // model is absent. Only the exact false-valued assertion is allowed.
  if (/^\s*distributor_commission_present\s*:\s*false\s*,?\s*$/.test(line)) return true;

  // Scenario and readiness scripts may assert that a legacy money field is not
  // present on a computed payload. Only the negated own-property form counts.
  if (isAbsenceAssertion(line)) return true;

  return false;
}

function migrationNumber(relative) {
  const match = /^(\d+)_/.exec(path.basename(relative));
  return match ? Number(match[1]) : null;
}

function lineNumberAt(source, index) {
  return source.slice(0, Math.max(0, index)).split(/\r?\n/).length;
}

function pushSqlFinding(relative, source, pattern, findings, token) {
  const match = source.match(pattern);
  if (!match || match.index == null) return;
  findings.push({
    file: relative,
    line: lineNumberAt(source, match.index),
    token: token || match[0].replace(/\s+/g, ' ').trim().slice(0, 180)
  });
}

function scanSqlSchema(relative, source, findings) {
  if (path.extname(relative).toLowerCase() !== '.sql') return;

  if (relative === LEGACY_CLEANUP_MIGRATION) {
    // Migration 020 is allowed to name legacy money fields because its purpose
    // is to remove them. It must never be repurposed to add them back.
    pushSqlFinding(
      relative,
      source,
      SQL_ADD_FINANCIAL_COLUMN,
      findings,
      'legacy cleanup migration adds a distributor financial column'
    );

    for (const requiredColumn of ['commission_rate', 'commission_amount', 'payout_status']) {
      const requiredDrop = new RegExp(`DROP\\s+COLUMN(?:\\s+IF\\s+EXISTS)?\\s+${requiredColumn}\\b`, 'i');
      if (!requiredDrop.test(source)) {
        findings.push({
          file: relative,
          line: 1,
          token: `legacy cleanup no longer drops ${requiredColumn}`
        });
      }
    }
    return;
  }

  // Historical migrations at or before the cleanup point may legitimately
  // describe the model that migration 020 removed. Only later migrations are
  // forbidden from reintroducing that authority.
  const number = migrationNumber(relative);
  if (number != null && number <= 20) return;

  for (const pattern of SQL_DISTRIBUTOR_FINANCIAL_PATTERNS) {
    pushSqlFinding(relative, source, pattern, findings);
  }
}

function walk(directory, root, findings) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;

    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walk(absolute, root, findings);
      continue;
    }

    if (!entry.isFile() || !CODE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;

    const relative = path.normalize(path.relative(root, absolute));
    if (relative === SELF_PATH) continue;

    const source = fs.readFileSync(absolute, 'utf8');
    scanSqlSchema(relative, source, findings);

    const lines = source.split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const pattern of FORBIDDEN_PATTERNS) {
        const match = line.match(pattern);
        if (!match) continue;
        if (isAllowedNegativeReference(relative, line)) break;
        findings.push({ file: relative, line: index + 1, token: match[0] });
        break;
      }
    });
  }
}

function scanRepository(root) {
  const findings = [];
  for (const relativeRoot of SCAN_ROOTS) {
    const absoluteRoot = path.join(root, relativeRoot);
    if (!fs.existsSync(absoluteRoot) || !fs.statSync(absoluteRoot).isDirectory()) continue;
    walk(absoluteRoot, root, findings);
  }
  return findings;
}

function runSelfTest() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siton-distributor-gate-'));
  try {
    const src = path.join(tempRoot, 'src');
    fs.mkdirSync(src, { recursive: true });

    fs.writeFileSync(
      path.join(src, 'allowed.ts'),
      [
        'const distributorAttributionGross = 1250;',
        'const affiliateClicks = 42;',
        'const sitonCommissionRate = 0.08;',
        'distributor_commission_present: false,',
        "assert.ok(!Object.hasOwn(money, 'affiliate_fee_amount'));",
        'assert.ok(!Object.prototype.hasOwnProperty.call(summary, "distributor_payout_amount"));'
      ].join('\n')
    );

    const cleanupDir = path.join(src, 'migrations');
    fs.mkdirSync(cleanupDir, { recursive: true });
    const cleanupPath = path.join(cleanupDir, '020_drop_affiliate_legacy_columns.sql');
    fs.writeFileSync(
      cleanupPath,
      [
        'ALTER TABLE siton.affiliate_accounts DROP COLUMN IF EXISTS commission_rate;',
        'ALTER TABLE siton.affiliate_attributions DROP COLUMN IF EXISTS commission_amount;',
        'ALTER TABLE siton.affiliate_attributions DROP COLUMN IF EXISTS payout_status;'
      ].join('\n')
    );

    const scriptsDir = path.join(tempRoot, 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.writeFileSync(
      path.join(scriptsDir, 'legal_compliance_gate.cjs'),
      'const forbiddenLegacyField = "affiliate_fee";\n'
    );

    let findings = scanRepository(tempRoot);
    if (findings.length !== 0) {
      throw new Error(`self-test rejected allowed attribution-only or negative-enforcement code: ${JSON.stringify(findings)}`);
    }

    fs.writeFileSync(
      path.join(src, 'forbidden.ts'),
      [
        'const distributorCommissionRate = 0.05;',
        'const affiliatePayoutBalance = 100;',
        'distributor_commission_present: true,',
        // An absence assertion must not launder a real reference on the same line.
        "const affiliateFeeRate = 0.05; assert.ok(!Object.hasOwn(money, 'affiliate_fee_amount'));"
      ].join('\n')
    );

    const multilineMigration = path.join(cleanupDir, '999_reintroduce_distributor_money.sql');
    fs.writeFileSync(
      multilineMigration,
      [
        'ALTER TABLE siton.affiliate_attributions',
        '  ADD COLUMN commission_amount NUMERIC(12,2);'
      ].join('\n')
    );

    findings = scanRepository(tempRoot);
    const runtimeFindings = findings.filter((finding) => finding.file.endsWith('forbidden.ts'));
    const multilineSqlFinding = findings.some((finding) =>
      finding.file.endsWith('999_reintroduce_distributor_money.sql')
    );
    if (runtimeFindings.length !== 4 || !multilineSqlFinding) {
      throw new Error(`self-test failed to detect runtime or multiline SQL financial distributor model: ${JSON.stringify(findings)}`);
    }

    fs.rmSync(multilineMigration, { force: true });
    fs.appendFileSync(
      cleanupPath,
      '\nALTER TABLE siton.affiliate_attributions\n  ADD COLUMN payout_status TEXT;\n'
    );
    findings = scanRepository(tempRoot);
    if (!findings.some((finding) => finding.file === LEGACY_CLEANUP_MIGRATION)) {
      throw new Error(`self-test failed to protect destructive-only migration 020: ${JSON.stringify(findings)}`);
    }

    console.log('Distributor attribution-only gate self-test: PASS');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function main() {
  if (process.argv.includes('--self-test')) {
    runSelfTest();
    return;
  }

  const findings = scanRepository(process.cwd());
  if (findings.length === 0) {
    console.log('Distributor attribution-only gate: PASS');
    console.log('No distributor/affiliate financial-entitlement identifiers found in runtime code or post-cleanup SQL schema.');
    return;
  }

  console.error('Distributor attribution-only gate: FAIL');
  console.error('Siton distributors are attribution/measurement only. Financial entitlement must stay outside the platform.');
  for (const finding of findings) {
    console.error(`${finding.file}:${finding.line} forbidden token: ${finding.token}`);
  }
  process.exitCode = 1;
}

main();
