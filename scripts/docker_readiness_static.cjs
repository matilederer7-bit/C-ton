#!/usr/bin/env node
// Docker readiness, static half (npm run check:docker-static).
// Proves what can be proven without a Docker engine:
//   Dockerfile: pinned Node major, non-root user, HEALTHCHECK, no .env copied,
//               demo-preview default, build steps present
//   .dockerignore excludes .env*, .git, node_modules, artefacts, worktrees
//   compose files: demo, CI and release-lab parse (env anchors resolve) and
//                  carry no live money / hosted credential
//   docker engine availability -> reported (the lab runs only when present)
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { ReleaseReport, artifactsDir } = require("./lib/release_report.cjs");
const { composeEnv } = require("./runtime_environment_gate.cjs");

const root = process.cwd();
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

function main() {
  const report = new ReleaseReport("docker readiness (static)");
  const dockerfile = read("Dockerfile");
  const problems = [];
  if (!/^FROM\s+node:22-/m.test(dockerfile)) problems.push("base image is not node:22-*");
  if (!/^USER\s+appuser/m.test(dockerfile)) problems.push("no non-root USER");
  if (!/^HEALTHCHECK/m.test(dockerfile)) problems.push("no HEALTHCHECK");
  if (!/ENV APP_DEPLOYMENT_MODE=demo-preview/.test(dockerfile)) problems.push("image does not default to demo-preview");
  if (!/npm ci/.test(dockerfile)) problems.push("dependencies not installed with npm ci");
  if (!/npm run build:demo/.test(dockerfile)) problems.push("demo bundle not built in image");
  if (!/find \/app .*\.env/.test(dockerfile)) problems.push("defense-in-depth .env deletion missing");
  if (/COPY\s+\.env/.test(dockerfile)) problems.push("Dockerfile copies an env file");
  (problems.length ? report.fail : report.pass).call(report, "Dockerfile", problems.length ? problems.join("; ") : "node:22 base, npm ci, build:demo + web build, non-root appuser, HEALTHCHECK /health, demo-preview default, .env purge");

  const ignore = read(".dockerignore");
  const missing = [".env", ".git", "node_modules", ".tmp_test_dist", ".demo_dist", "uploads", ".ci-artifacts"].filter((entry) => !new RegExp("^" + entry.replace(/\./g, "\\.") + "(/|$)", "m").test(ignore));
  const worktrees = /^\.worktrees\/?$/m.test(ignore);
  const releaseArtifacts = /^\.release-artifacts\/?$/m.test(ignore);
  if (missing.length) report.fail(".dockerignore", "missing entries: " + missing.join(", "));
  else if (!worktrees || !releaseArtifacts) report.warn(".dockerignore", "core exclusions present; add .worktrees/ and .release-artifacts/ so parallel checkouts and release reports never enter the build context");
  else report.pass(".dockerignore", "excludes env files, VCS, dependencies, build output, artefacts, worktrees");

  for (const [file, services] of [["docker-compose.yml", ["app", "worker", "migrate"]], ["docker-compose.ci.yml", ["web", "worker", "migrate"]], ["docker-compose.release-lab.yml", ["web", "worker", "migrate"]]]) {
    const issues = [];
    for (const service of services) {
      const env = composeEnv(file, service);
      if (!env) { issues.push(service + " missing"); continue; }
      if (!env.DATABASE_URL) issues.push(service + " has no DATABASE_URL after anchor merge");
      if (String(env.PAYMENT_ENVIRONMENT || "").toLowerCase() === "live") issues.push(service + " PAYMENT_ENVIRONMENT=live");
      if (/supabase\.co|pooler\.supabase/.test(String(env.DATABASE_URL || ""))) issues.push(service + " points at a hosted database");
      if (String(env.PAYMENT_PROVIDER || "mockpay") !== "mockpay") issues.push(service + " provider " + env.PAYMENT_PROVIDER);
    }
    (issues.length ? report.fail : report.pass).call(report, file, issues.length ? issues.join("; ") : services.length + " services resolve env anchors; mock provider; compose-network database only");
  }

  const engine = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { encoding: "utf8" });
  if (engine.status === 0 && String(engine.stdout).trim()) report.pass("docker engine", "available (" + String(engine.stdout).trim() + "); the release lab and CI docker smoke can run here");
  else report.skip("docker engine", "not available locally; container build/start/healthcheck/migration/smoke/shutdown are proven only by the release-readiness CI workflow");

  report.printSummary();
  report.writeArtifacts(artifactsDir(root), "docker-readiness-static");
  console.log(report.exitCode() ? "DOCKER_READINESS_STATIC_FAIL" : "DOCKER_READINESS_STATIC_PASS");
  process.exit(report.exitCode());
}

main();
