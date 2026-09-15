// Regression: a normal stop signal makes the BUILT web and worker runtimes
// exit 0 through their own handlers (src/app.ts gracefulShutdown,
// src/worker.ts stopWorker) - the property the Docker release lab measures on
// the containers, proven here without Docker.
//
// The first CI run of docker-release-lab reported web=1 / worker=1 on
// `docker stop`. The runtimes themselves were never at fault: with
// `npm run start:*:prod` as PID 1 the signal was consumed by npm, which
// cannot die from the signal it re-sends to itself as PID 1 and exits 1. The
// image and the lab now start `node` directly; this file pins the runtime
// half of that contract on every platform:
//   POSIX   real SIGTERM / SIGINT (child.kill), exactly what the platform sends
//   Windows the same handler raised in-process through an IPC shim (no POSIX
//           signals on Windows; child.kill would be a hard kill)
// Negative controls prove the harness is not vacuous: a child that exits 1
// on the signal, and one that ignores it, are both detected.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
require("dotenv").config({ quiet: true });
const { REPO_ROOT } = require("./support/fixture_repo.cjs");
const isolation = require("../../scripts/lib/test_db_isolation.cjs");
const { runMigrations } = require("../../scripts/run_migrations.cjs");
const { composeEnv } = require("../../scripts/runtime_environment_gate.cjs");

const SHIM = path.join(__dirname, "support", "signal_shim.mjs");
const WIN = process.platform === "win32";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let dbAvailable = false;
try { if (process.env.DATABASE_URL) { isolation.assertLocalBase(process.env.DATABASE_URL); dbAvailable = true; } } catch { dbAvailable = false; }

async function waitFor(fn, timeoutMs, label) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try { const value = await fn(); if (value) return value; } catch (error) { last = error; }
    await delay(250);
  }
  throw new Error("timed out waiting for " + label + (last ? ": " + last.message : ""));
}

/** Spawn a Node program with the signal shim preloaded; returns { child, logs, exited }. */
function spawnRuntime(script, env, cwd = REPO_ROOT) {
  const nodeOptions = [process.env.NODE_OPTIONS, "--import " + pathToFileURL(SHIM).href].filter(Boolean).join(" ");
  const child = spawn(process.execPath, [script], { cwd, env: { ...env, NODE_OPTIONS: nodeOptions }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  const logs = [];
  child.stdout.on("data", (chunk) => logs.push(String(chunk)));
  child.stderr.on("data", (chunk) => logs.push(String(chunk)));
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  return { child, logs, exited, text: () => logs.join("") };
}

/** Deliver the platform's stop signal and wait for the exit; TIMEOUT when the child ignores it. */
async function stopWith(runtime, signal, timeoutMs) {
  const started = Date.now();
  if (WIN) runtime.child.send({ emit: signal });
  else runtime.child.kill(signal);
  const result = await Promise.race([runtime.exited, delay(timeoutMs).then(() => ({ code: "TIMEOUT", signal: null }))]);
  if (result.code === "TIMEOUT") { try { runtime.child.kill("SIGKILL"); } catch { /* gone */ } }
  return { ...result, elapsed_ms: Date.now() - started };
}

// ---------------------------------------------------------------------------
// Negative controls: the harness must be able to fail.
// ---------------------------------------------------------------------------
test("shutdown harness detects a clean exit, a non-zero exit and an ignored signal", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "siton-shutdown-ctl-"));
  try {
    // Each control prints READY once its handler is installed and the test
    // waits for that line before signalling: node:test runs files concurrently
    // (alongside tsx app boots), so a fixed delay could deliver the raw signal
    // before the handler exists and kill the child by default action.
    const write = (name, body) => { const file = path.join(dir, name); fs.writeFileSync(file, body); return file; };
    const clean = write("clean.mjs", "process.once('SIGTERM', () => { process.stdout.write('clean handler ran\\n', () => process.exit(0)); }); setInterval(() => {}, 1000); process.stdout.write('READY\\n');");
    const dirty = write("dirty.mjs", "process.once('SIGTERM', () => { process.stdout.write('dirty handler ran\\n', () => process.exit(1)); }); setInterval(() => {}, 1000); process.stdout.write('READY\\n');");
    const deaf = write("deaf.mjs", "process.on('SIGTERM', () => { process.stdout.write('ignoring\\n'); }); setInterval(() => {}, 1000); process.stdout.write('READY\\n');");
    for (const [file, expectCode, expectLog] of [[clean, 0, /clean handler ran/], [dirty, 1, /dirty handler ran/], [deaf, "TIMEOUT", /ignoring/]]) {
      const runtime = spawnRuntime(file, { ...process.env });
      await waitFor(async () => /READY/.test(runtime.text()), 30000, path.basename(file) + " READY");
      const result = await stopWith(runtime, "SIGTERM", 5000);
      assert.equal(result.code, expectCode, path.basename(file) + " -> " + JSON.stringify(result) + "\n" + runtime.text());
      if (expectCode !== "TIMEOUT") assert.match(runtime.text(), expectLog);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The real runtimes, built exactly as the image runs them.
// ---------------------------------------------------------------------------
function ensureBuilt() {
  const app = path.join(REPO_ROOT, ".demo_dist", "src", "app.js");
  const worker = path.join(REPO_ROOT, ".demo_dist", "src", "worker.js");
  if (fs.existsSync(app) && fs.existsSync(worker)) return;
  const build = spawnSync(process.execPath, [path.join(REPO_ROOT, "scripts", "build_demo_bundle.cjs")], { cwd: REPO_ROOT, encoding: "utf8", timeout: 600000 });
  if (build.status !== 0) throw new Error("build:demo failed: " + String(build.stderr || build.stdout).slice(-800));
}

function labEnv(service, dbUrl, extra) {
  // The exact environment the release lab gives the container (compose anchor
  // + service overrides), pointed at the isolated local database.
  const env = composeEnv("docker-compose.release-lab.yml", service);
  assert.ok(env && env.PAYMENT_PROVIDER === "mockpay", "release-lab compose env must resolve (mock money)");
  const base = { ...process.env };
  delete base.RENDER; delete base.RENDER_EXTERNAL_URL; delete base.APP_ENV;
  return { ...base, ...env, DATABASE_URL: dbUrl, DOTENV_CONFIG_QUIET: "true", ...extra };
}

async function withRuntimeDatabase(fn) {
  const db = await isolation.createIsolatedDatabase({ baseUrl: process.env.DATABASE_URL, purpose: "shutdown" });
  try {
    const log = console.log; console.log = () => {};
    try { await runMigrations(db.url); } finally { console.log = log; }
    const seed = spawnSync(process.execPath, [path.join(REPO_ROOT, "scripts", "seed_test_prerequisites.cjs")], { cwd: REPO_ROOT, encoding: "utf8", env: { ...process.env, DATABASE_URL: db.url, NODE_ENV: "test" } });
    if (seed.status !== 0) throw new Error("seed failed: " + (seed.stderr || seed.stdout));
    await fn(db);
  } finally {
    await db.drop().catch(() => undefined);
  }
}

for (const signal of ["SIGTERM", "SIGINT"]) {
  test("built web runtime exits 0 on " + signal + " through gracefulShutdown (release-lab env)", { skip: !dbAvailable && "no local DATABASE_URL (SKIPPED_ENVIRONMENT)" }, async () => {
    ensureBuilt();
    await withRuntimeDatabase(async (db) => {
      const port = await isolation.allocateFreePort();
      const runtime = spawnRuntime(path.join(REPO_ROOT, ".demo_dist", "src", "app.js"), labEnv("web", db.url, { HOST: "127.0.0.1", PORT: String(port) }));
      try {
        await waitFor(async () => (await fetch("http://127.0.0.1:" + port + "/readiness", { signal: AbortSignal.timeout(2000) })).status === 200, 60000, "web /readiness");
        // A live keep-alive connection, as the lab's own smoke leaves behind.
        await fetch("http://127.0.0.1:" + port + "/health");
        const result = await stopWith(runtime, signal, 20000);
        const text = runtime.text();
        assert.equal(result.code, 0, "web exit on " + signal + ": " + JSON.stringify(result) + "\n" + text.slice(-2000));
        assert.equal(result.signal, null);
        assert.match(text, /graceful shutdown initiated/, "handler must have run");
        assert.doesNotMatch(text, /graceful shutdown timed out/, "must exit through the handler, not the 30 s force-exit timer");
        assert.ok(result.elapsed_ms < 15000, "shutdown took " + result.elapsed_ms + " ms");
      } finally {
        try { runtime.child.kill("SIGKILL"); } catch { /* already exited */ }
      }
    });
  });
}

test("built worker runtime exits 0 on SIGTERM through stopWorker (release-lab env)", { skip: !dbAvailable && "no local DATABASE_URL (SKIPPED_ENVIRONMENT)" }, async () => {
  ensureBuilt();
  await withRuntimeDatabase(async (db) => {
    const runtime = spawnRuntime(path.join(REPO_ROOT, ".demo_dist", "src", "worker.js"), labEnv("worker", db.url, {}));
    const { Client } = require("pg");
    const client = new Client({ connectionString: db.url });
    await client.connect();
    try {
      await waitFor(async () => (await client.query("SELECT 1 FROM siton.worker_heartbeats WHERE worker_id='release-lab-worker' AND status='ready'")).rowCount === 1, 60000, "worker heartbeat ready");
      const result = await stopWith(runtime, "SIGTERM", 20000);
      const text = runtime.text();
      assert.equal(result.code, 0, "worker exit: " + JSON.stringify(result) + "\n" + text.slice(-2000));
      assert.equal(result.signal, null);
      assert.match(text, /worker_draining/);
      assert.match(text, /worker_stopped/);
      assert.ok(result.elapsed_ms < 15000, "shutdown took " + result.elapsed_ms + " ms");
      const heartbeat = await client.query("SELECT status FROM siton.worker_heartbeats WHERE worker_id='release-lab-worker'");
      assert.equal(heartbeat.rows[0].status, "stopped", "the worker must record status=stopped before exiting");
    } finally {
      await client.end();
      try { runtime.child.kill("SIGKILL"); } catch { /* already exited */ }
    }
  });
});

test("image and lab start the Node runtime itself as PID 1, never a wrapper", () => {
  const dockerfile = fs.readFileSync(path.join(REPO_ROOT, "Dockerfile"), "utf8");
  assert.match(dockerfile, /^CMD \["node", "\.demo_dist\/src\/app\.js"\]\s*$/m);
  const compose = fs.readFileSync(path.join(REPO_ROOT, "docker-compose.release-lab.yml"), "utf8");
  assert.match(compose, /command: \["node", "\.demo_dist\/src\/worker\.js"\]/);
  assert.doesNotMatch(compose, /command: \["npm", "run", "start:(web|worker):prod"\]/, "npm must not be PID 1 in the lab containers");
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  assert.equal(pkg.scripts["start:web:prod"], "node .demo_dist/src/app.js");
  assert.equal(pkg.scripts["start:worker:prod"], "node .demo_dist/src/worker.js");
});
