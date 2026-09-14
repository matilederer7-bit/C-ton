#!/usr/bin/env node
// Secret / PII repository scan (npm run scan:secrets).
//
// Detectors (each with an id, a severity and a reason):
//   private-key, aws-access-key, github-token, slack-token, google-api-key,
//   stripe-secret-key (live or test, 24+ chars), stripe-webhook-secret,
//   supabase-service-role-jwt (JWT whose payload says role=service_role),
//   supabase-secret-key (sb_secret_...), render-api-key (rnd_...),
//   twilio-account-sid + auth-token pair, grow-credential assignment,
//   database-url-credential (non-local host, non-placeholder password),
//   real-card-pan (Luhn-valid 13-19 digits outside the known test PANs),
//   committed-env-file (.env / .env.* tracked by git, except examples),
//   pii-in-runtime (real-looking email / Israeli phone inside src/ or config/
//                   that is not a documented synthetic domain/number)
//
// Scope follows scripts/lib/repo_scan_policy.cjs; docs and tests are scanned
// too (a secret in a doc is still a leak) except for the pii-in-runtime
// detector, which is restricted to runtime source and config where fixture
// leakage is prohibited. Deliberate dummy values are allow-listed in
// config/secret-scan-allowlist.json with a reason; stale entries fail.
// Controls: tests/release_tools/secret_pii_scan.test.cjs.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const policy = require("./lib/repo_scan_policy.cjs");

const PLACEHOLDER_PASSWORDS = /^(postgres|password|secret|changeme|change-me|example|dummy|placeholder|xxx+|\*+|<[^>]*>|\$\{[^}]*\}|redacted|\[redacted\]|pass|siton_demo_password|siton_ci_password|siton_ci_root-secret|siton-ci-root-secret|siton-ci-reader-secret|siton-ci-writer-secret|redacted-real-secret-value|SYNTHETIC_SENTINEL|synthetic[a-z0-9_-]*)$/i;
const LOCAL_DB_HOSTS = /^(localhost|127\.0\.0\.1|\[::1\]|::1|postgres|db|host\.docker\.internal)$/i;
const SYNTHETIC_EMAIL_DOMAINS = /@(siton\.test|example\.(com|org|net|invalid)|test\.invalid|[a-z0-9.-]*\.invalid|localhost|siton\.local)$/i;
const KNOWN_TEST_PANS = new Set(["4242424242424242", "4111111111111111", "4000000000000002", "5555555555554444", "5105105105105100", "378282246310005", "371449635398431", "6011111111111117", "3566002020360505", "4012888888881881", "4000000000009995", "4000000000000069", "2223003122003222", "4000056655665556",
  // Grow (Meshulam) documented sandbox test cards (docs/R9B_GROW_SANDBOX_ACTIVATION.md)
  "4580458045804580", "4580000000000000", "4580111111111121"]);

function luhn(digits) {
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (double) { digit *= 2; if (digit > 9) digit -= 9; }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

function decodeJwtPayload(token) {
  try {
    const payload = token.split(".")[1];
    return JSON.parse(Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  } catch { return null; }
}

// Each detector returns [{ match, note }] for a file's text.
const DETECTORS = [
  { id: "private-key", severity: "FAIL", scope: "all", run: (text) => matches(text, /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g) },
  { id: "aws-access-key", severity: "FAIL", scope: "all", run: (text) => matches(text, /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g) },
  { id: "github-token", severity: "FAIL", scope: "all", run: (text) => matches(text, /\bgh[pousr]_[A-Za-z0-9_]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b/g) },
  { id: "slack-token", severity: "FAIL", scope: "all", run: (text) => matches(text, /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g) },
  { id: "google-api-key", severity: "FAIL", scope: "all", run: (text) => matches(text, /\bAIza[0-9A-Za-z_-]{35}\b/g) },
  { id: "stripe-secret-key", severity: "FAIL", scope: "all", run: (text) => matches(text, /\b[sr]k_(?:live|test)_[A-Za-z0-9]{24,}\b/g) },
  { id: "stripe-webhook-secret", severity: "FAIL", scope: "all", run: (text) => matches(text, /\bwhsec_[A-Za-z0-9]{24,}\b/g) },
  { id: "supabase-secret-key", severity: "FAIL", scope: "all", run: (text) => matches(text, /\bsb_secret_[A-Za-z0-9_-]{20,}\b/g) },
  { id: "render-api-key", severity: "FAIL", scope: "all", run: (text) => matches(text, /\brnd_[A-Za-z0-9]{20,}\b/g) },
  { id: "twilio-auth-token", severity: "FAIL", scope: "all", run: (text) => (/\bAC[0-9a-f]{32}\b/.test(text) ? matches(text, /\b(?:TWILIO_AUTH_TOKEN|auth_token|authToken)\s*[:=]\s*["']?[0-9a-f]{32}\b/gi) : []) },
  {
    id: "supabase-service-role-jwt", severity: "FAIL", scope: "all",
    run: (text) => matches(text, /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g).filter((hit) => { const payload = decodeJwtPayload(hit.match); return payload && (payload.role === "service_role" || payload.role === "supabase_admin"); }).map((hit) => ({ ...hit, match: hit.match.slice(0, 24) + "...", note: "JWT payload role=service_role" }))
  },
  {
    id: "jwt-token", severity: "WARNING", scope: "all",
    run: (text) => matches(text, /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g).filter((hit) => { const payload = decodeJwtPayload(hit.match); return payload && payload.role !== "service_role" && payload.role !== "supabase_admin" && payload.role !== "anon"; }).map((hit) => ({ ...hit, match: hit.match.slice(0, 24) + "..." }))
  },
  {
    id: "grow-credential", severity: "FAIL", scope: "non-test",
    run: (text) => matches(text, /\b(GROW_API_KEY|GROW_REFERENCE_ENCRYPTION_KEY|GROW_USER_ID|GROW_PAGE_CODE)\s*[:=]\s*["']?([A-Za-z0-9_\-]{12,})["']?/g).filter((hit) => !/^(placeholder|synthetic|example|dummy|changeme|0123456789abcdef0123456789abcdef|u|p)/i.test(hit.groups[1]) && !/synthetic|placeholder|example|dummy|test|sandbox|guard|value|fake|fixture|probe/i.test(hit.groups[1]))
  },
  {
    id: "database-url-credential", severity: "FAIL", scope: "all",
    run: (text) => matches(text, /\bpostgres(?:ql)?:\/\/([^\s:\/"'`]+):([^\s@"'`]+)@([^\s:\/"'`?]+)/g).filter((hit) => !LOCAL_DB_HOSTS.test(hit.groups[2]) && !PLACEHOLDER_PASSWORDS.test(hit.groups[1]) && !/\$\{|\$[A-Z_]|%s|<|\*\*\*|REDACTED/i.test(hit.groups[1])).map((hit) => ({ ...hit, match: hit.match.replace(/:([^@]+)@/, ":***@") }))
  },
  {
    id: "real-card-pan", severity: "FAIL", scope: "all",
    // 15-16 digit runs (optionally space/dash separated) that start like a
    // Visa/Mastercard/Amex/Discover PAN, pass Luhn, and are not a documented
    // test PAN or a repeated digit. Timestamps (13 digits, leading 1) and
    // hex ids never qualify.
    run: (text) => matches(text, /(?<!\d)(?:\d[ -]?){15,16}(?!\d)/g).map((hit) => ({ ...hit, digits: hit.match.replace(/\D/g, "") })).filter((hit) => (hit.digits.length === 15 || hit.digits.length === 16) && /^[3456]/.test(hit.digits) && luhn(hit.digits) && !KNOWN_TEST_PANS.has(hit.digits) && !/^(\d)\1+$/.test(hit.digits)).map((hit) => ({ ...hit, match: hit.digits.slice(0, 6) + "******" + hit.digits.slice(-4) }))
  },
  {
    id: "pii-in-runtime", severity: "WARNING", scope: "runtime",
    run: (text) => [
      // The character before an email-shaped match must not be ':' or '/'
      // (a user:password@host credential is not an email).
      ...matches(text, /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g).filter((hit) => !/[:\/]/.test(text[hit.index - 1] || "") && !SYNTHETIC_EMAIL_DOMAINS.test(hit.match) && !/noreply|no-reply|support@|admin@|info@|hello@|contact@|owner@|test@|demo@|user@|seller@|buyer@|\.png$|\.svg$|\.js$|\.ts$/i.test(hit.match) && !/@(siton|c-ton)\.(co\.il|com|io)$/i.test(hit.match)).map((hit) => ({ ...hit, note: "email" })),
      ...matches(text, /(?<![\d\w])(?:\+972-?5\d(?:-?\d){7}|05\d(?:-?\d){7})(?![\d\w])/g).filter((hit) => { const digits = hit.match.replace(/\D/g, "").replace(/^972/, "0"); return !/^05[0-9](?:0000000|1234567|0000001|0000002|1111111|2222222|5555555|8000000|9999999|1112233)$/.test(digits) && !/^0508\d{6}$/.test(digits) && !/(\d)\1{5,}/.test(digits) && !/^050(0|1)\d{6}$/.test(digits); }).map((hit) => ({ ...hit, note: "israeli phone" }))
    ]
  }
];

function matches(text, regex) {
  const out = [];
  for (const match of text.matchAll(regex)) out.push({ match: match[0], groups: match.slice(1), index: match.index });
  return out;
}

function lineOf(text, index) {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) if (text.charCodeAt(cursor) === 10) line += 1;
  return line;
}

function loadAllowList(root) {
  const file = path.join(root, "config", "secret-scan-allowlist.json");
  if (!fs.existsSync(file)) return [];
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const entry of parsed.allow || []) {
    for (const field of ["file", "detector", "reason"]) if (typeof entry[field] !== "string" || !entry[field].trim()) throw new Error("secret allow-list entry requires " + field);
    if (!entry.match && !entry.match_prefix) throw new Error("secret allow-list entry requires match or match_prefix: " + entry.file);
    if (/[*?]/.test(entry.file)) throw new Error("secret allow-list entries cannot use wildcards: " + entry.file);
  }
  return parsed.allow || [];
}

function trackedEnvFiles(root) {
  const result = spawnSync("git", ["ls-files", "--", ".env", ".env.*", "**/.env", "**/.env.*"], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) return [];
  return result.stdout.split(/\r?\n/).filter(Boolean).filter((file) => !/\.example$/i.test(file) && !/\.sample$/i.test(file) && !/\.template$/i.test(file));
}

function run(options = {}) {
  const root = options.root || process.cwd();
  const allowList = options.allowList || loadAllowList(root);
  const files = policy.walkRepository(root, { extensions: /\.(ts|tsx|js|jsx|cjs|mjs|sql|json|jsonc|yml|yaml|md|txt|ps1|sh|toml|env|example|html|css|xml|plist|gradle|properties|swift|java|kt)$/i, includeFile: (rel) => rel !== "scripts/secret_pii_scan.cjs" && rel !== "config/secret-scan-allowlist.json" && !/^tests\/release_tools\//.test(rel) });
  const findings = [];
  const used = new Set();
  for (const file of files) {
    let text;
    try { text = fs.readFileSync(file.abs, "utf8"); } catch { continue; }
    if (text.length > 4 * 1024 * 1024) continue;
    const runtimeScope = /^(src|config|supabase|web\/src|frontend)\//.test(file.rel) && !/\.(md|txt)$/i.test(file.rel);
    for (const detector of DETECTORS) {
      if (detector.scope === "runtime" && !runtimeScope) continue;
      if (detector.scope === "non-test" && file.rel.startsWith("tests/")) continue;
      let hits;
      try { hits = detector.run(text); } catch (error) { hits = []; }
      for (const hit of hits) {
        const allowed = allowList.find((entry) => entry.file === file.rel && entry.detector === detector.id && (entry.match ? entry.match === hit.match : hit.match.startsWith(entry.match_prefix)));
        if (allowed) { used.add(allowed); continue; }
        findings.push({ rel: file.rel, line: lineOf(text, hit.index), detector: detector.id, severity: detector.severity, match: hit.match.slice(0, 80), note: hit.note || null });
      }
    }
  }
  for (const envFile of options.skipGit ? [] : trackedEnvFiles(root)) findings.push({ rel: envFile, line: 0, detector: "committed-env-file", severity: "FAIL", match: envFile, note: "tracked by git" });
  const stale = allowList.filter((entry) => !used.has(entry));
  return { scanned: files.length, findings, staleAllowListEntries: stale };
}

if (require.main === module) {
  const result = run();
  const fails = result.findings.filter((f) => f.severity === "FAIL");
  const warns = result.findings.filter((f) => f.severity === "WARNING");
  for (const finding of result.findings) console.log("[" + finding.severity + "] " + finding.rel + ":" + finding.line + " " + finding.detector + " " + finding.match + (finding.note ? " (" + finding.note + ")" : ""));
  for (const entry of result.staleAllowListEntries) { console.log("[FAIL] stale allow-list entry " + entry.file + " " + entry.detector); fails.push(entry); }
  console.log("SECRET_PII_SCAN_SUMMARY scanned=" + result.scanned + " fail=" + fails.length + " warning=" + warns.length);
  fs.writeFileSync(path.join(require("./lib/release_report.cjs").artifactsDir(process.cwd()), "secret-pii-scan.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(fails.length ? "SECRET_PII_SCAN_FAIL" : "SECRET_PII_SCAN_PASS");
  process.exit(fails.length ? 1 : 0);
}

module.exports = { run, DETECTORS, luhn, KNOWN_TEST_PANS };
