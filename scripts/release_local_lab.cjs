#!/usr/bin/env node
// Local release lab (npm run release:local-lab).
//
// ONE command: build the production image, start Postgres + migrate + web +
// worker from docker-compose.release-lab.yml, wait healthy, run an HTTP smoke
// (liveness, readiness, integrations, seller deal create + public read, admin
// refusal, worker heartbeat), stop gracefully (exit codes must be 0), and
// clean up (down -v). Mock money only; no hosted dependency.
//
// Without Docker the lab reports SKIPPED_ENVIRONMENT (exit 0, never PASS).
// Artifacts: .release-artifacts/release-local-lab.{json,md} and the compose
// logs in .release-artifacts/release-local-lab-compose.log.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { ReleaseReport, runStep, artifactsDir } = require("./lib/release_report.cjs");

const root = process.cwd();
const project = "siton-release-lab-" + process.pid;
const compose = ["compose", "-p", project, "-f", "docker-compose.release-lab.yml"];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function docker(args, options = {}) {
  const result = spawnSync("docker", [...compose, ...args], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: options.timeout || 900000 });
  if (!options.allowFailure && result.status !== 0) throw new Error("docker " + args.join(" ") + " failed: " + String(result.stderr || result.stdout).slice(-1200));
  return result;
}
function publishedPort(service, targetPort) {
  const result = docker(["port", service, String(targetPort)]);
  const match = String(result.stdout || "").match(/:(\d+)\s*$/m);
  if (!match) throw new Error("published port not found for " + service);
  return Number(match[1]);
}
async function waitFor(fn, timeoutMs, label) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) { try { const value = await fn(); if (value) return value; } catch (error) { last = error; } await delay(1000); }
  throw new Error("timed out waiting for " + label + (last ? ": " + last.message : ""));
}
async function request(origin, route, options = {}) {
  const response = await fetch(origin + route, { redirect: "manual", signal: AbortSignal.timeout(15000), ...options });
  const text = await response.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: response.status, headers: Object.fromEntries(response.headers), text, json };
}

async function main() {
  const report = new ReleaseReport("release local lab", { meta: { compose_project: project } });
  const dockerVersion = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { encoding: "utf8" });
  if (dockerVersion.status !== 0 || !String(dockerVersion.stdout || "").trim()) {
    report.skip("docker", "Docker engine unavailable (" + String(dockerVersion.stderr || dockerVersion.error || "not installed").trim().slice(0, 120) + ")");
    report.printSummary();
    report.writeArtifacts(artifactsDir(root), "release-local-lab");
    console.log("RELEASE_LOCAL_LAB_SKIPPED_ENVIRONMENT");
    process.exit(0);
  }
  report.pass("docker", "engine " + String(dockerVersion.stdout).trim());
  let started = false;
  try {
    await runStep(report, "build + start (postgres, migrate, web, worker)", async () => {
      const startedAt = Date.now();
      docker(["up", "--build", "-d", "--wait", "postgres", "migrate", "web", "worker"], { timeout: 900000 });
      started = true;
      const migrateLogs = docker(["logs", "migrate"], { allowFailure: true });
      const applied = (String(migrateLogs.stdout || "").match(/MIGRATION_OK/g) || []).length;
      return { status: "PASS", summary: "compose --wait healthy in " + Math.round((Date.now() - startedAt) / 1000) + "s; migrate applied " + applied + " migrations and seeded prerequisites" };
    });
    if (!started) throw new Error("stack did not start");
    const origin = "http://127.0.0.1:" + publishedPort("web", 3000);

    await runStep(report, "liveness + readiness + integrations", async () => {
      const health = await waitFor(async () => { const r = await request(origin, "/health"); return r.status === 200 ? r : null; }, 60000, "/health");
      const readiness = await request(origin, "/readiness");
      const integrations = await request(origin, "/health/integrations");
      if (readiness.status !== 200 || !readiness.json || readiness.json.database !== "connected") throw new Error("/readiness " + readiness.status + " " + readiness.text.slice(0, 160));
      const payment = integrations.json && integrations.json.integrations && integrations.json.integrations.payment;
      if (!payment || payment.provider !== "mockpay") throw new Error("integrations payment " + JSON.stringify(payment));
      return { status: "PASS", summary: "/health " + health.status + ", /readiness " + readiness.json.database + ", payment provider " + payment.provider + "/" + payment.mode };
    });

    await runStep(report, "seller deal create + public read (mock money)", async () => {
      const created = await request(origin, "/deals", { method: "POST", headers: { "content-type": "application/json", "x-seller-id": "seller-default" }, body: JSON.stringify({ seller_id: "seller-default", title: "Release lab smoke", price_per_unit: 10, min_units: 2, max_units: 5, deadline: new Date(Date.now() + 3 * 3600000).toISOString() }) });
      if (created.status !== 200 || !created.json || !created.json.deal_id) throw new Error("create " + created.status + " " + created.text.slice(0, 200));
      const publicRead = await request(origin, "/api/deals/" + created.json.deal_id + "/public");
      if (![200, 404].includes(publicRead.status)) throw new Error("public read " + publicRead.status);
      return { status: "PASS", summary: "deal " + created.json.deal_id + " created (state " + (created.json.state || "?") + "); public read " + publicRead.status + " (Draft deals are not public by design)" };
    });

    await runStep(report, "admin surface refuses anonymous", async () => {
      const response = await request(origin, "/api/admin/mission-control");
      if (![401, 403].includes(response.status)) throw new Error("status " + response.status);
      const withKey = await request(origin, "/api/admin/mission-control", { headers: { "x-admin-key": "release-lab-admin-key-not-a-real-value-1234" } });
      return { status: "PASS", summary: "anonymous " + response.status + "; with the lab admin key " + withKey.status };
    });

    await runStep(report, "worker heartbeat ready", async () => {
      const probe = docker(["exec", "-T", "postgres", "psql", "-U", "siton_lab", "-d", "siton_lab", "-tAc", "select worker_id||':'||status from siton.worker_heartbeats where worker_id='release-lab-worker'"]);
      const value = String(probe.stdout || "").trim();
      if (!/release-lab-worker:ready/.test(value)) throw new Error("heartbeat row: " + value);
      return { status: "PASS", summary: value };
    });

    await runStep(report, "graceful shutdown (exit code 0)", async () => {
      docker(["stop", "-t", "35", "web", "worker"], { timeout: 120000 });
      const inspect = spawnSync("docker", ["inspect", "--format", "{{.Name}} {{.State.ExitCode}}", project + "-web-1", project + "-worker-1"], { encoding: "utf8" });
      const codes = String(inspect.stdout || "").trim().split(/\r?\n/);
      const bad = codes.filter((line) => !/ 0$/.test(line));
      if (inspect.status !== 0) throw new Error("inspect failed: " + inspect.stderr);
      if (bad.length) throw new Error("non-zero exit on stop: " + bad.join(", "));
      return { status: "PASS", summary: codes.join("; ") };
    });
  } catch (error) {
    report.fail("lab", String(error.message || error).slice(0, 800));
  } finally {
    const logs = docker(["logs", "--no-color"], { allowFailure: true });
    fs.writeFileSync(path.join(artifactsDir(root), "release-local-lab-compose.log"), String(logs.stdout || "") + String(logs.stderr || ""));
    docker(["down", "-v", "--remove-orphans"], { allowFailure: true });
  }
  report.printSummary();
  report.writeArtifacts(artifactsDir(root), "release-local-lab");
  console.log(report.exitCode() ? "RELEASE_LOCAL_LAB_FAIL" : "RELEASE_LOCAL_LAB_PASS");
  process.exit(report.exitCode());
}

main().catch((error) => { console.error("RELEASE_LOCAL_LAB_ERROR", error); process.exit(1); });
