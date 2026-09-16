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

// These files may name legacy money fields only because they remove or detect
// them. They are not runtime distributor-product surfaces.
const NEGATIVE_REFERENCE_PATHS = new Set([
  path.normalize(path.join('src', 'migrations', '020_drop_affiliate_legacy_columns.sql')),
  path.normalize(path.join('scripts', 'legal_compliance_gate.cjs'))
]);

const ROLE = '(?:affiliate|distributor|referrer|promoter)';
const MONEY = '(?:commission|payout|withdraw(?:al)?|balance|earning(?:s)?|entitlement|invoice|fee|reward)';
const FORBIDDEN_PATTERNS = [
  new RegExp(`${ROLE}[A-Za-z0-9_-]*${MONEY}`, 'i'),
  new RegExp(`${MONEY}[A-Za-z0-9_-]*${ROLE}`, 'i')
];

function isAllowedNegativeReference(relative, line) {
  if (NEGATIVE_REFERENCE_PATHS.has(relative)) return true;

  // Mission control may expose a literal safety assertion that the forbidden
  // model is absent. Only the exact false-valued assertion is allowed.
  if (/^\s*distributor_commission_present\s*:\s*false\s*,?\s*$/.test(line)) return true;

  return false;
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

    const lines = fs.readFileSync(absolute, 'utf8').split(/\r?\n/);
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
        'distributor_commission_present: false,'
      ].join('\n')
    );

    const cleanupDir = path.join(src, 'migrations');
    fs.mkdirSync(cleanupDir, { recursive: true });
    fs.writeFileSync(
      path.join(cleanupDir, '020_drop_affiliate_legacy_columns.sql'),
      'ALTER TABLE siton.invoice_documents DROP COLUMN IF EXISTS affiliate_fee_amount;\n'
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
        'distributor_commission_present: true,'
      ].join('\n')
    );

    findings = scanRepository(tempRoot);
    if (findings.length !== 3) {
      throw new Error(`self-test failed to detect financial distributor model: ${JSON.stringify(findings)}`);
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
    console.log('No distributor/affiliate financial-entitlement identifiers found in runtime code.');
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
