#!/usr/bin/env node
// Release checklist generator (npm run release:checklist).
//
// Builds a checklist from REPOSITORY STATE: the latest preflight report, the
// route inventory, the migration analysis, the governance files and the
// documented open items. Every line is one of:
//   [x] PROVEN     an automated gate proved it for this SHA
//   [~] WARNING    proven with documented warnings
//   [ ] SKIPPED    could not be proven on this machine (never marked done)
//   [ ] OPEN       an owner / provider / hosted decision; never pretended PASS
//   [!] FAIL       a gate failed
// Categories: CODE, TESTS, MIGRATIONS, SECURITY, DATA, PAYMENTS, INFRA,
// BROWSER, MOBILE, OPERATIONS. Output: .release-artifacts/release-checklist.md
const fs = require("node:fs");
const path = require("node:path");
const { describeGit } = require("./lib/git_info.cjs");
const policyLib = require("./lib/runtime_environment_policy.cjs");
const tools = require("./lib/migration_tools.cjs");
const { artifactsDir } = require("./lib/release_report.cjs");

const root = process.cwd();

function readJson(rel) { const file = path.join(artifactsDir(root), path.basename(rel)); if (!fs.existsSync(file)) return null; try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }

const OPEN_ITEMS = [
  { category: "PAYMENTS", owner: "owner + reviewer", text: "F-13 provider-contract issue resolved and the financial branch (claude/review-r9c-financial) integrated to master", ref: "config/real-money-release-policy.json F13_PROVIDER_CONTRACT_UNRESOLVED" },
  { category: "PAYMENTS", owner: "provider (Grow) + owner", text: "Grow sandbox userId/pageCode delivered; live verification performed; production activation approved", ref: "GROW_LIVE_VERIFICATION_NOT_PERFORMED, PRODUCTION_PAYMENT_ACTIVATION_NOT_APPROVED" },
  { category: "PAYMENTS", owner: "owner", text: "config/real-money-release-policy.json flipped to ALLOWED with evidence (separate reviewed commit)", ref: "docs/REAL_MONEY_RELEASE_GOVERNANCE.md" },
  { category: "INFRA", owner: "owner (Render console)", text: "OTP_HASH_SALT added to both Render services (generateValue); render.yaml updated in a hosted-change PR", ref: "runtime gap OTP_HASH_SALT_DEFAULT_IN_PRODUCTION" },
  { category: "INFRA", owner: "owner", text: "Render Starter plan for the web service and Supabase Site URL decisions (pilot readiness)", ref: "PROJECT_STATUS.md launch gap" },
  { category: "INFRA", owner: "CI", text: "Docker lab run green in the release-readiness workflow for this SHA", ref: ".github/workflows/release-readiness.yml" },
  { category: "SECURITY", owner: "owner", text: "Production seller publish requires verification_status=approved: confirm the approval step is intended (lean onboarding holds outside production)", ref: "legal_compliance_gate OWNER_DECISION" },
  { category: "SECURITY", owner: "engineering", text: "Runtime gaps: OTP_HASH_SALT default, TRACKING_LEGACY_COMPAT accepted in production-like mode, DEBUG_SURFACES with key in production, notification log provider emits recipient_ref raw, /readiness without no-store", ref: "docs/RUNTIME_ENVIRONMENT_POLICY.md, docs/LOGGING_DATA_CLASSIFICATION.md, docs/HTTP_SECURITY_SURFACE.md" },
  { category: "INFRA", owner: "engineering", text: "npm audit: production high/critical advisories (fastify, find-my-way, fast-uri, tar via capacitor, tmp) - upgrade decision", ref: "docs/SUPPLY_CHAIN_STATUS.md" },
  { category: "BROWSER", owner: "QA", text: "Hosted browser proofs (seller journey, buyer join, admin) re-run against the deployed SHA on staging", ref: "docs/RC_STAGING_SMOKE.md, docs/PILOT_LAUNCH_RUNBOOK.md" },
  { category: "MOBILE", owner: "owner", text: "External mobile placeholders (SITON_APP_ID, app link host, signing credentials) supplied for a store build", ref: "mobile_release_gate external_placeholders=pending" },
  { category: "OPERATIONS", owner: "owner", text: "Runbooks acknowledged: deployment, rollback, payment incident, security incident, database incident", ref: "docs/DEPLOYMENT_RUNBOOK.md and siblings" },
  { category: "OPERATIONS", owner: "engineering", text: "This release-engineering branch rebased onto master after financial + UX integration; release:preflight and Docker CI green on the result", ref: "PROJECT_STATUS.md" }
];

const GATE_TO_CATEGORY = {
  typescript: "CODE", "lint-backend-enforcement": "CODE", "architecture-gate": "CODE", "base44-canonical-integrity": "CODE", "build-demo": "CODE", "repository-hygiene": "CODE", "reproducible-build": "CODE",
  "payment-compliance-scan": "SECURITY", "legal-compliance": "SECURITY", "secret-pii-scan": "SECURITY", "logging-hygiene": "SECURITY", "route-inventory": "SECURITY", "route-authorization-behavioural": "SECURITY", "http-security-smoke": "SECURITY", "security-tests": "SECURITY",
  "runtime-ddl-scan": "MIGRATIONS", "migration-preflight": "MIGRATIONS", "migration-preflight-static": "MIGRATIONS",
  "backup-restore-rehearsal": "DATA",
  "money-tax-canon": "PAYMENTS", "no-real-money-proof": "PAYMENTS", "payment-tests": "PAYMENTS",
  "runtime-environment-policy": "INFRA", "startup-config-matrix": "INFRA", "supply-chain": "INFRA", "docker-readiness-static": "INFRA", "release-local-lab": "INFRA", "health-contract": "INFRA",
  "mobile-pwa-gate": "MOBILE",
  "release-tools-tests": "TESTS"
};

function main() {
  const git = describeGit(root);
  const preflight = readJson(".release-artifacts/release-preflight.json");
  const stale = preflight && preflight.meta && preflight.meta.sha !== git.sha;
  const realMoney = policyLib.loadRealMoneyPolicy(root);
  const routes = readJson(".release-artifacts/route-inventory.json");
  const analysis = tools.analyzeManifest(root);
  const categories = ["CODE", "TESTS", "MIGRATIONS", "SECURITY", "DATA", "PAYMENTS", "INFRA", "BROWSER", "MOBILE", "OPERATIONS"];
  const lines = {};
  for (const category of categories) lines[category] = [];
  const mark = (status) => status === "PASS" ? "[x] PROVEN " : status === "WARNING" ? "[~] WARNING" : status === "FAIL" ? "[!] FAIL   " : "[ ] SKIPPED";

  if (preflight && !stale) {
    for (const item of preflight.items) {
      const category = GATE_TO_CATEGORY[item.id] || "TESTS";
      lines[category].push(mark(item.status) + " " + item.id + ": " + item.summary.slice(0, 140));
    }
  } else {
    lines.TESTS.push("[ ] SKIPPED release:preflight has not run for this SHA (" + (preflight ? "last run was for " + String(preflight.meta.sha).slice(0, 12) : "no report") + ") - run npm run release:preflight");
  }
  lines.MIGRATIONS.push((analysis.findings.some((f) => f.severity === "FAIL") ? "[!] FAIL   " : "[x] PROVEN ") + "manifest: " + analysis.files.length + " migrations, high-water " + analysis.high_water + ", static findings " + analysis.findings.filter((f) => f.severity === "FAIL").length);
  lines.MIGRATIONS.push("[ ] OPEN    migrations:doctor against the TARGET database (staging/production) before deploy: verdict must be HEALTHY, HEALTHY_WITH_EOL_VARIANTS or BEHIND (never BLOCKED)");
  if (routes) lines.SECURITY.push("[x] PROVEN  route inventory: " + routes.summary.total_routes + " routes, " + routes.summary.protected_routes + " protected, " + routes.summary.unclassified_routes + " unclassified");
  lines.PAYMENTS.push((realMoney.real_money_allowed ? "[~] WARNING" : "[x] PROVEN ") + " REAL_MONEY " + (realMoney.real_money_allowed ? "ALLOWED" : "BLOCKED") + " by governance (" + (realMoney.blocking_reasons || []).filter((r) => !r.cleared).length + " blocking reasons)");
  lines.CODE.push((git.dirty ? "[~] WARNING" : "[x] PROVEN ") + " working tree " + (git.dirty ? "DIRTY (" + git.dirty_entry_count + " entries) - cut releases from a clean tree" : "clean") + " at " + git.short_sha);
  lines.BROWSER.push("[ ] SKIPPED browser proofs are not part of release:preflight (they need a hosted or Docker runtime and a browser)");
  for (const item of OPEN_ITEMS) lines[item.category].push("[ ] OPEN    (" + item.owner + ") " + item.text + " [" + item.ref + "]");

  const md = ["# Release checklist", "", "Generated " + new Date().toISOString() + " for `" + git.sha + "` (" + git.branch + ")." + (stale ? " Preflight report is STALE for this SHA." : ""), "", "Legend: [x] PROVEN by an automated gate for this SHA; [~] proven with documented warnings; [!] gate failed; [ ] SKIPPED could not be proven here; [ ] OPEN owner/provider/hosted decision (never pretended done).", ""];
  const totals = { proven: 0, warning: 0, fail: 0, skipped: 0, open: 0 };
  for (const category of categories) {
    md.push("## " + category, "");
    for (const line of lines[category]) {
      md.push("- " + line);
      if (line.startsWith("[x]")) totals.proven += 1; else if (line.startsWith("[~]")) totals.warning += 1; else if (line.startsWith("[!]")) totals.fail += 1; else if (line.includes("OPEN")) totals.open += 1; else totals.skipped += 1;
    }
    md.push("");
  }
  md.push("## Totals", "", "proven=" + totals.proven + " warning=" + totals.warning + " fail=" + totals.fail + " skipped=" + totals.skipped + " open=" + totals.open, "");
  fs.writeFileSync(path.join(artifactsDir(root), "release-checklist.md"), md.join("\n"));
  fs.writeFileSync(path.join(artifactsDir(root), "release-checklist.json"), JSON.stringify({ sha: git.sha, generated_at: new Date().toISOString(), stale_preflight: Boolean(stale), totals, lines }, null, 2) + "\n");
  console.log(md.join("\n"));
  console.log("RELEASE_CHECKLIST proven=" + totals.proven + " warning=" + totals.warning + " fail=" + totals.fail + " skipped=" + totals.skipped + " open=" + totals.open + " written=.release-artifacts/release-checklist.md");
  process.exit(totals.fail ? 1 : 0);
}

main();
