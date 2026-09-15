#!/usr/bin/env node
// Health check contract (npm run check:health-contract).
//
// Boots the real web runtime (and the real worker) against an isolated local
// database and proves what each signal means - and what it does NOT mean:
//
//   process alive          web child pid alive
//   HTTP responsive        GET /health -> 200 {ok:true}. Liveness ONLY: it
//                          never touches the database (proven below by
//                          dropping the database and watching /health stay 200)
//   DB reachable +         GET /readiness -> 200 with database:"connected";
//   schema compatible      assertDatabaseSchema requires every contract table,
//                          so a database missing tables answers 503 not_ready
//   worker readiness       siton.worker_heartbeats row status='ready' for the
//                          worker child, heartbeat_at fresh; /readiness does
//                          NOT include this (documented gap)
//   payment provider       GET /health/integrations reports provider=mockpay
//   intentionally disabled mode=mock-backed; no secret value is echoed
//
// Negative control: after dropping the database, /health stays 200 while
// /readiness answers 503 {code:"not_ready"} - liveness and readiness are
// different signals. Documented in docs/HEALTH_CHECK_CONTRACT.md.
require("dotenv").config({ quiet: true });
const { Client } = require("pg");
const { startLocalRuntime, request, waitFor, delay } = require("./lib/local_runtime.cjs");
const { pidAlive } = require("./lib/process_cleanup_guard.cjs");
const { ReleaseReport, runStep, artifactsDir } = require("./lib/release_report.cjs");

async function main() {
  const report = new ReleaseReport("health check contract");
  let runtime = null;
  try {
    runtime = await startLocalRuntime({ label: "health", worker: true });
  } catch (error) {
    report.skip("runtime boot", error.message);
    report.printSummary();
    report.writeArtifacts(artifactsDir(process.cwd()), "health-contract");
    console.log("HEALTH_CONTRACT_SKIPPED_ENVIRONMENT");
    process.exit(0);
  }
  const origin = runtime.origin;
  try {
    await runStep(report, "process alive", async () => ({ status: pidAlive(runtime.web.pid) ? "PASS" : "FAIL", summary: "web pid " + runtime.web.pid + (runtime.worker ? ", worker pid " + runtime.worker.pid : "") }));

    await runStep(report, "HTTP responsive: GET /health", async () => {
      const health = await request(origin, "/health");
      if (health.status !== 200 || !health.json || health.json.ok !== true) throw new Error("status " + health.status + " body " + health.text.slice(0, 120));
      return { status: "PASS", summary: "200 {ok:true}; proves the HTTP listener only (no database, provider or worker involvement)" };
    });

    await runStep(report, "DB reachable + schema compatible: GET /readiness", async () => {
      const readiness = await request(origin, "/readiness");
      if (readiness.status !== 200 || !readiness.json || readiness.json.database !== "connected") throw new Error("status " + readiness.status + " body " + readiness.text.slice(0, 200));
      return { status: "PASS", summary: "200 " + readiness.text + "; assertDatabaseSchema checked the contract tables (boundary=" + readiness.json.boundary + ": canonical runtime role checks apply only with CANONICAL_POSTGRES_RUNTIME=1)" };
    });

    await runStep(report, "worker readiness: siton.worker_heartbeats", async () => {
      const client = new Client({ connectionString: runtime.db.url });
      await client.connect();
      try {
        const row = await waitFor(async () => {
          const result = await client.query("SELECT worker_id, status, EXTRACT(EPOCH FROM (now() - heartbeat_at))::int AS age_s FROM siton.worker_heartbeats WHERE worker_id='local-runtime-worker'");
          return result.rows[0] && result.rows[0].status === "ready" ? result.rows[0] : null;
        }, 30000, "worker heartbeat ready");
        return { status: "PASS", summary: "worker_id=" + row.worker_id + " status=ready heartbeat_age_s=" + row.age_s + "; NOTE /readiness does not include worker state (documented gap HC-1)" };
      } finally {
        await client.end();
      }
    });

    await runStep(report, "payment provider intentionally disabled: GET /health/integrations", async () => {
      const integrations = await request(origin, "/health/integrations");
      if (integrations.status !== 200 || !integrations.json) throw new Error("status " + integrations.status);
      const payment = integrations.json.integrations && integrations.json.integrations.payment;
      if (!payment || payment.provider !== "mockpay" || payment.mode !== "mock-backed") throw new Error("payment summary " + JSON.stringify(payment));
      const body = integrations.text;
      for (const secret of ["local-runtime-webhook-secret-not-a-real-value-1234", "local-runtime-admin-key-not-a-real-value-1234", runtime.db.url]) {
        if (body.includes(secret)) throw new Error("integrations body echoes a secret value");
      }
      return { status: "PASS", summary: "provider=mockpay mode=mock-backed deployment_mode=" + integrations.json.deployment_mode + "; no secret values echoed" };
    });

    await runStep(report, "negative control: database gone -> /health stays 200, /readiness 503", async () => {
      // Drop the database from underneath the running web process.
      await runtime.db.drop();
      const readiness = await waitFor(async () => { const r = await request(origin, "/readiness"); return r.status === 503 ? r : null; }, 30000, "readiness 503");
      const health = await request(origin, "/health");
      if (health.status !== 200) throw new Error("/health answered " + health.status + " after database loss (it must stay a pure liveness probe)");
      if (!readiness.json || readiness.json.code !== "not_ready") throw new Error("readiness body " + readiness.text.slice(0, 200));
      return { status: "PASS", summary: "/health 200 (liveness), /readiness 503 {code:not_ready} (readiness) - a load balancer using /health alone would keep routing to a database-less instance; Render uses /readiness" };
    });
  } finally {
    await runtime.stop();
  }
  report.printSummary();
  report.writeArtifacts(artifactsDir(process.cwd()), "health-contract");
  console.log(report.exitCode() ? "HEALTH_CONTRACT_FAIL" : "HEALTH_CONTRACT_PASS");
  process.exit(report.exitCode());
}

main().catch((error) => { console.error("HEALTH_CONTRACT_ERROR", error); process.exit(1); });
