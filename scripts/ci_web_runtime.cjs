const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const mode = process.argv.includes("--extended") ? "extended" : "core";
const project = `siton-web-runtime-${mode}`;
const compose = ["compose", "-p", project, "-f", "docker-compose.ci.yml"];
const artifacts = path.join(process.cwd(), ".ci-artifacts");
fs.mkdirSync(artifacts, { recursive: true });
const report = { mode, started_at: new Date().toISOString(), scenarios: [], product_findings: [] };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: options.timeout || 300000, ...options });
  if (!options.allowFailure && result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed\n${result.stdout || ""}\n${result.stderr || ""}`);
  }
  return result;
}
function docker(args, options = {}) {
  return run("docker", [...compose, ...args], options);
}
function record(name, passed, details = {}) {
  report.scenarios.push({ name, passed, ...details });
  if (!passed) report.product_findings.push({ name, ...details });
}
async function request(url, options = {}) {
  try {
    const started = Date.now();
    const response = await fetch(url, { signal: AbortSignal.timeout(options.timeout || 10000), ...options });
    const text = await response.text();
    return { status: response.status, text, duration_ms: Date.now() - started };
  } catch (error) {
    return { status: 0, error: String(error) };
  }
}
async function waitFor(fn, timeout = 120000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) { last = error; }
    await delay(1000);
  }
  throw last || new Error("wait timed out");
}

async function main() {
  if (run("docker", ["version"], { allowFailure: true }).status !== 0) throw new Error("Docker is required for web runtime tests");
  docker(["down", "-v", "--remove-orphans"], { allowFailure: true });
  try {
    docker(["up", "--build", "-d", "--wait", "postgres", "migrate", "web", "worker"], { timeout: 900000 });
    await waitFor(async () => (await request("http://127.0.0.1:3001/health")).status === 200);

    const probe = run(process.execPath, ["scripts/web_runtime_http_probe.cjs"], { allowFailure: true, timeout: 600000 });
    fs.writeFileSync(path.join(artifacts, `web-runtime-probe-${mode}.log`), `${probe.stdout || ""}\n${probe.stderr || ""}`);
    if (probe.status !== 0) throw new Error(`HTTP probe infrastructure failed\n${probe.stdout}\n${probe.stderr}`);
    const probeReport = JSON.parse(fs.readFileSync(path.join(artifacts, "web-runtime-http-report.json"), "utf8"));
    record("real HTTP core probe completed", true, { passed: probeReport.counts.passed, findings: probeReport.counts.failed });
    report.product_findings.push(...probeReport.product_findings);

    const logs = docker(["logs", "--no-color", "web"], { allowFailure: true });
    const logText = `${logs.stdout || ""}\n${logs.stderr || ""}`;
    const sensitiveLogMatches = logText.match(/(?:authorization:\s*bearer|otp[_ -]?code["':=\s]+\d{4,8}|card[_ -]?number|c[v]v|ci-placeholder-only)/gi) || [];
    record("web logs exclude secrets, OTPs, cards, and configured placeholders", sensitiveLogMatches.length === 0, { matches: [...new Set(sensitiveLogMatches)] });
    record("5xx responses do not expose stack traces", !probeReport.product_findings.some((item) => /stack/i.test(JSON.stringify(item))), {});

    if (mode === "extended") {
      const publicScenario = probeReport.scenarios.find((item) => item.name === "public deal read over real HTTP");
      const dealId = publicScenario?.json?.deal?.deal_id;
      if (!dealId) throw new Error("extended probe could not locate deal id");

      docker(["stop", "worker"]);
      const webWithoutWorker = await request("http://127.0.0.1:3001/health");
      record("web remains available while worker is down", webWithoutWorker.status === 200, webWithoutWorker);
      docker(["start", "worker"]);
      docker(["up", "-d", "--wait", "worker"]);
      record("worker recovers after restart", true);

      docker(["stop", "postgres"]);
      const duringOutage = await request(`http://127.0.0.1:3001/api/deals/${dealId}/public`, { timeout: 15000 });
      record("DB outage returns failure without false success or stack", duringOutage.status >= 500 && duringOutage.status < 600 && !/stack|at\s+\w+/i.test(duringOutage.text || ""), duringOutage);
      docker(["start", "postgres"]);
      await waitFor(async () => (await request(`http://127.0.0.1:3001/api/deals/${dealId}/public`)).status === 200, 120000);
      record("web recovers after DB returns", true);

      const traffic = Promise.all(Array.from({ length: 120 }, async (_, index) => {
        await delay(index * 15);
        return request(`http://127.0.0.1:3001/api/deals/${dealId}/public`, { timeout: 10000 });
      }));
      await delay(300);
      docker(["restart", "web"]);
      await waitFor(async () => (await request("http://127.0.0.1:3001/health")).status === 200);
      const restartResults = await traffic;
      record("container restart during traffic recovers", restartResults.some((item) => item.status === 200) && (await request(`http://127.0.0.1:3001/api/deals/${dealId}/public`)).status === 200, {
        statuses: restartResults.reduce((map, item) => { map[item.status] = (map[item.status] || 0) + 1; return map; }, {})
      });

      const second = docker([
        "run", "-d", "--name", `${project}-web-2`, "--no-deps", "-p", "3002:3000",
        "-e", "HOST=0.0.0.0", "-e", "PORT=3000", "-e", "RUNTIME_ROLE=web",
        "-e", "DATABASE_URL=postgresql://siton_ci:siton_ci_password@postgres:5432/siton_ci",
        "-e", "APP_DEPLOYMENT_MODE=demo-preview", "-e", "NODE_ENV=test",
        "-e", "PAYMENT_PROVIDER=mockpay", "-e", "PAYMENT_PROVIDER_MODE=mock-backed",
        "-e", "PAYMENT_WEBHOOK_SECRET=ci-placeholder-only", "-e", "ADMIN_API_KEY=ci-placeholder-only",
        "-e", "DISABLE_OUTBOX_WORKER=1", "web"
      ], { allowFailure: true });
      if (second.status === 0) {
        await waitFor(async () => (await request("http://127.0.0.1:3002/health")).status === 200);
        const both = await Promise.all(Array.from({ length: 100 }, (_, index) =>
          request(`http://127.0.0.1:${index % 2 ? 3001 : 3002}/api/deals/${dealId}/public`)
        ));
        record("two web instances serve shared state", both.every((item) => item.status === 200), {
          statuses: both.reduce((map, item) => { map[item.status] = (map[item.status] || 0) + 1; return map; }, {})
        });
      } else {
        record("two web instances serve shared state", false, { error: second.stderr || second.stdout });
      }

      const stats = run("docker", ["stats", "--no-stream", "--format", "{{json .}}"], { allowFailure: true });
      fs.writeFileSync(path.join(artifacts, "web-runtime-docker-stats.jsonl"), stats.stdout || "");
    }

    report.completed_at = new Date().toISOString();
    report.verdict = report.product_findings.length ? "PRODUCT_FINDINGS_RECORDED" : "PASS";
    fs.writeFileSync(path.join(artifacts, `web-runtime-${mode}-report.json`), JSON.stringify(report, null, 2));
    console.log("CI_WEB_RUNTIME_FINDINGS", JSON.stringify(report.product_findings));
    console.log("CI_WEB_RUNTIME_COMPLETE", JSON.stringify({
      mode,
      scenarios: report.scenarios.length,
      findings: report.product_findings.length,
      verdict: report.verdict
    }));
  } finally {
    const logs = docker(["logs", "--no-color"], { allowFailure: true });
    fs.writeFileSync(path.join(artifacts, `web-runtime-${mode}-compose.log`), `${logs.stdout || ""}\n${logs.stderr || ""}`);
    docker(["down", "-v", "--remove-orphans"], { allowFailure: true });
  }
}

main().catch((error) => {
  report.infrastructure_error = String(error?.stack || error);
  fs.writeFileSync(path.join(artifacts, `web-runtime-${mode}-report.json`), JSON.stringify(report, null, 2));
  console.error(error);
  process.exit(1);
});
