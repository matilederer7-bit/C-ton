#!/usr/bin/env node
// Release manifest (npm run release:manifest).
//
// Generates a machine-readable and a human-readable description of THIS
// checkout as a release candidate:
//   git SHA / branch / dirty state, Node + npm versions, migration high-water
//   mark and canonical (LF) checksums, build identity (demo bundle, mobile
//   bundle, web/dist tree hashes when present), the latest preflight result
//   (marked STALE when it was produced for another SHA), real-money status,
//   Grow status, environment target, Docker image/tag when supplied,
//   route inventory counts when present, timestamp.
// Output: .release-artifacts/release-manifest.{json,md} (gitignored; never
// committed by default). --target <name>, --image <ref> are optional.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { runSync } = require("./lib/run_command.cjs");
const { describeGit } = require("./lib/git_info.cjs");
const tools = require("./lib/migration_tools.cjs");
const policyLib = require("./lib/runtime_environment_policy.cjs");
const { artifactsDir } = require("./lib/release_report.cjs");

const root = process.cwd();
const args = process.argv.slice(2);
const option = (name, fallback) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : fallback; };

function treeHash(dir) {
  if (!fs.existsSync(dir)) return null;
  const entries = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) walk(abs);
      else entries.push(path.relative(dir, abs).split(path.sep).join("/") + ":" + crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex"));
    }
  };
  walk(dir);
  entries.sort();
  return { files: entries.length, sha256: crypto.createHash("sha256").update(entries.join("\n")).digest("hex") };
}

function readJsonIfExists(rel) {
  const file = path.join(artifactsDir(root), path.basename(rel));
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function main() {
  const git = describeGit(root);
  const npmVersion = (() => { const result = runSync("npm", ["--version"], { encoding: "utf8" }); return result.status === 0 ? String(result.stdout).trim() : null; })();
  const analysis = tools.analyzeManifest(root);
  const realMoney = policyLib.loadRealMoneyPolicy(root);
  const preflight = readJsonIfExists(".release-artifacts/release-preflight.json");
  const preflightStale = preflight && preflight.meta && preflight.meta.sha && preflight.meta.sha !== git.sha;
  const routes = readJsonIfExists(".release-artifacts/route-inventory.json");
  const mobileBuild = readJsonIfExists(".mobile_dist/mobile-build.json");
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const manifest = {
    generated_at: new Date().toISOString(),
    environment_target: option("--target", process.env.RELEASE_TARGET || "unspecified"),
    git: { sha: git.sha, short_sha: git.short_sha, branch: git.branch, subject: git.subject, committed_at: git.committed_at, remote: git.remote, dirty: git.dirty, dirty_entry_count: git.dirty_entry_count, dirty_entries: git.dirty_entries },
    toolchain: { node: process.versions.node, npm: npmVersion, engines: pkg.engines || null, platform: process.platform + " " + process.arch },
    package: { name: pkg.name, version: pkg.version },
    migrations: {
      count: analysis.files.length,
      high_water: analysis.high_water,
      static_findings: analysis.findings.filter((f) => f.severity === "FAIL").length,
      checksums: analysis.files.map((file) => ({ id: file.id, position: file.position, filename: file.filename, sha256_lf: file.checksum_lf })),
      manifest_sha256: crypto.createHash("sha256").update(analysis.files.map((file) => file.id + ":" + file.checksum_lf).join("\n")).digest("hex")
    },
    build: {
      demo_bundle: treeHash(path.join(root, ".demo_dist")),
      mobile_bundle: treeHash(path.join(root, ".mobile_dist")),
      mobile_build_identity: mobileBuild ? { revision: mobileBuild.revision || mobileBuild.git_revision || null, generated: mobileBuild.generated_at || null } : null,
      web_dist: treeHash(path.join(root, "web", "dist")),
      docker_image: option("--image", process.env.RELEASE_IMAGE || null)
    },
    // preflight.overall is TECHNICAL readiness; real-money activation is the
    // governance verdict recorded next to it, never folded into it.
    preflight: preflight ? { overall: preflight.overall, technical: preflight.meta && preflight.meta.readiness ? preflight.meta.readiness.technical : preflight.overall, real_money_activation: preflight.meta && preflight.meta.readiness ? preflight.meta.readiness.real_money_activation : null, counts: preflight.counts, not_applicable: preflight.meta && preflight.meta.not_applicable ? preflight.meta.not_applicable.map((item) => item.id) : [], profile: preflight.meta && preflight.meta.profile, for_sha: preflight.meta && preflight.meta.sha, finished_at: preflight.finished_at, stale: Boolean(preflightStale) } : { overall: "NOT_RUN" },
    real_money: { allowed: realMoney.real_money_allowed === true, status: realMoney.status, blocking_reasons: (realMoney.blocking_reasons || []).filter((r) => !r.cleared).map((r) => r.id), cleared_reasons: (realMoney.blocking_reasons || []).filter((r) => r.cleared === true).map((r) => r.id) },
    grow: { status: "SANDBOX_TRANSPORT_PROVEN_NOT_AUTHORISED", live_verification: "not performed", detail: "docs/R9B_GROW_SANDBOX_PROOF_RUNBOOK.md; sandbox userId/pageCode blocker with Grow support; staging pinned to mockpay by config/runtime-environment-policy.json; R9C rails on master (migrations 067/068) but the provider contract for real money (F-13) is unresolved" },
    routes: routes ? routes.summary : null
  };
  const dir = artifactsDir(root);
  fs.writeFileSync(path.join(dir, "release-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  const md = [
    "# Release manifest",
    "",
    "Generated " + manifest.generated_at + " for target `" + manifest.environment_target + "`.",
    "",
    "| Field | Value |", "|---|---|",
    "| Git SHA | `" + git.sha + "` (" + git.branch + ") |",
    "| Commit | " + (git.subject || "") + " at " + (git.committed_at || "") + " |",
    "| Working tree | " + (git.dirty ? "DIRTY (" + git.dirty_entry_count + " entries)" : "clean") + " |",
    "| Node / npm | " + manifest.toolchain.node + " / " + (manifest.toolchain.npm || "?") + " (engines " + JSON.stringify(manifest.toolchain.engines) + ") |",
    "| Migrations | " + manifest.migrations.count + ", high-water " + manifest.migrations.high_water + ", manifest sha256 " + manifest.migrations.manifest_sha256.slice(0, 16) + " |",
    "| Demo bundle | " + (manifest.build.demo_bundle ? manifest.build.demo_bundle.files + " files, " + manifest.build.demo_bundle.sha256.slice(0, 16) : "not built") + " |",
    "| Mobile bundle | " + (manifest.build.mobile_bundle ? manifest.build.mobile_bundle.files + " files, " + manifest.build.mobile_bundle.sha256.slice(0, 16) + (manifest.build.mobile_build_identity ? ", revision " + manifest.build.mobile_build_identity.revision : "") : "not built") + " |",
    "| Web dist | " + (manifest.build.web_dist ? manifest.build.web_dist.files + " files, " + manifest.build.web_dist.sha256.slice(0, 16) : "not built") + " |",
    "| Docker image | " + (manifest.build.docker_image || "not built here") + " |",
    "| Preflight (technical) | " + manifest.preflight.overall + (manifest.preflight.stale ? " (STALE: produced for " + String(manifest.preflight.for_sha).slice(0, 12) + ")" : "") + (manifest.preflight.counts ? " pass=" + manifest.preflight.counts.PASS + " fail=" + manifest.preflight.counts.FAIL + " warning=" + manifest.preflight.counts.WARNING + " skipped=" + manifest.preflight.counts.SKIPPED_ENVIRONMENT + (manifest.preflight.not_applicable && manifest.preflight.not_applicable.length ? " not_applicable=" + manifest.preflight.not_applicable.length : "") : "") + " |",
    "| Real-money activation | " + (manifest.preflight.real_money_activation || (manifest.real_money.allowed ? "ALLOWED" : "BLOCKED")) + " |",
    "| Real money | " + (manifest.real_money.allowed ? "ALLOWED" : "BLOCKED") + " (" + manifest.real_money.blocking_reasons.join(", ") + ") |",
    "| Grow | " + manifest.grow.status + " |",
    "| Routes | " + (manifest.routes ? "total " + manifest.routes.total_routes + ", protected " + manifest.routes.protected_routes + ", public " + manifest.routes.public_routes : "inventory not generated") + " |",
    "",
    "## Migration checksums (canonical LF)",
    "",
    "| Pos | Id | File | sha256 |", "|---|---|---|---|",
    ...manifest.migrations.checksums.map((row) => "| " + row.position + " | " + row.id + " | " + row.filename + " | `" + row.sha256_lf.slice(0, 16) + "` |")
  ].join("\n") + "\n";
  fs.writeFileSync(path.join(dir, "release-manifest.md"), md);
  console.log("RELEASE_MANIFEST sha=" + git.short_sha + " branch=" + git.branch + " dirty=" + git.dirty + " migrations=" + manifest.migrations.count + "@" + manifest.migrations.high_water + " preflight=" + manifest.preflight.overall + (manifest.preflight.stale ? "(STALE)" : "") + " real_money=" + (manifest.real_money.allowed ? "ALLOWED" : "BLOCKED"));
  console.log("written .release-artifacts/release-manifest.json and .md");
}

main();
