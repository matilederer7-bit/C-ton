// Boots the real Siton web (and optionally worker) runtime as child processes
// against an isolated, freshly migrated local database on a free port.
// Used by the health-contract check, the HTTP security smoke and the local
// release lab. Everything is disposable: database dropped and children killed
// on stop; the process guard makes sure only OUR children are ever touched.
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const isolation = require("./test_db_isolation.cjs");
const { createProcessGuard } = require("./process_cleanup_guard.cjs");
const { runMigrations } = require("../run_migrations.cjs");

const root = path.resolve(__dirname, "..", "..");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function silently(fn) { const log = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = log; } }

async function waitFor(fn, timeoutMs, label) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try { const value = await fn(); if (value) return value; } catch (error) { last = error; }
    await delay(500);
  }
  throw new Error("timed out waiting for " + label + (last ? ": " + last.message : ""));
}

function baseEnv(overrides) {
  const env = { ...process.env, ...overrides };
  // A local runtime must never look production-like or hosted.
  delete env.RENDER;
  delete env.RENDER_EXTERNAL_URL;
  delete env.APP_ENV;
  return env;
}

/**
 * Start the runtime. Returns { origin, port, db, web, worker, logs, stop() }.
 * options.env        - extra env for the children
 * options.worker     - also start src/worker.ts (default false)
 * options.seed       - run scripts/seed_test_prerequisites.cjs (default true)
 * options.label      - purpose label for the isolated database
 */
async function startLocalRuntime(options = {}) {
  const baseUrl = process.env.DATABASE_URL;
  if (!baseUrl) throw Object.assign(new Error("DATABASE_URL not set"), { skippedEnvironment: true });
  isolation.assertLocalBase(baseUrl);
  const guard = createProcessGuard({ label: options.label || "local-runtime" }).installExitHandlers({ quiet: true });
  const db = await isolation.createIsolatedDatabase({ baseUrl, purpose: options.label || "runtime" });
  await silently(() => runMigrations(db.url));
  if (options.seed !== false) {
    const seed = spawnSync(process.execPath, [path.join(root, "scripts", "seed_test_prerequisites.cjs")], { cwd: root, encoding: "utf8", env: baseEnv({ DATABASE_URL: db.url, NODE_ENV: "test" }) });
    if (seed.status !== 0) { await db.drop(); throw new Error("seed failed: " + (seed.stderr || seed.stdout)); }
  }
  const port = await isolation.allocateFreePort();
  const env = baseEnv({
    NODE_ENV: "test",
    APP_DEPLOYMENT_MODE: "demo-preview",
    DISABLE_OUTBOX_WORKER: "1",
    DATABASE_URL: db.url,
    PORT: String(port),
    HOST: "127.0.0.1",
    PAYMENT_PROVIDER: "mockpay",
    PAYMENT_PROVIDER_MODE: "mock-backed",
    PAYMENT_WEBHOOK_SECRET: "local-runtime-webhook-secret-not-a-real-value-1234",
    ADMIN_API_KEY: "local-runtime-admin-key-not-a-real-value-1234",
    LOG_LEVEL: "info",
    DOTENV_CONFIG_QUIET: "true",
    ...(options.env || {})
  });
  const logs = { web: [], worker: [] };
  const tsx = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
  const web = guard.spawn(process.execPath, [tsx, path.join(root, "src", "app.ts")], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  web.stdout.on("data", (chunk) => logs.web.push(String(chunk)));
  web.stderr.on("data", (chunk) => logs.web.push(String(chunk)));
  const origin = "http://127.0.0.1:" + port;
  let worker = null;
  try {
    await waitFor(async () => { const response = await fetch(origin + "/health", { signal: AbortSignal.timeout(2000) }); return response.ok; }, options.startTimeoutMs || 90000, "web /health");
    if (options.worker) {
      worker = guard.spawn(process.execPath, [tsx, path.join(root, "src", "worker.ts")], { cwd: root, env: { ...env, RUNTIME_ROLE: "worker", DISABLE_OUTBOX_WORKER: "", WORKER_ID: "local-runtime-worker", WORKER_HEARTBEAT_MS: "1000", OUTBOX_POLL_MS: "200" }, stdio: ["ignore", "pipe", "pipe"] });
      delete worker.spawnargs;
      worker.stdout.on("data", (chunk) => logs.worker.push(String(chunk)));
      worker.stderr.on("data", (chunk) => logs.worker.push(String(chunk)));
    }
  } catch (error) {
    guard.killOwned();
    await db.drop().catch(() => undefined);
    error.message += "\n--- web log tail ---\n" + logs.web.join("").slice(-3000);
    throw error;
  }
  let stopped = false;
  return {
    origin,
    port,
    db,
    web,
    worker,
    logs,
    guard,
    async stop() {
      if (stopped) return;
      stopped = true;
      // Graceful first (SIGTERM path in app.ts / worker.ts), then force.
      for (const child of [worker, web].filter(Boolean)) {
        try { child.kill("SIGTERM"); } catch { /* ignore */ }
      }
      await delay(process.platform === "win32" ? 300 : 1500);
      guard.killOwned();
      await delay(300);
      await db.drop().catch(() => undefined);
    }
  };
}

async function request(origin, route, options = {}) {
  const response = await fetch(origin + route, { redirect: "manual", signal: AbortSignal.timeout(options.timeoutMs || 15000), ...options });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: response.status, headers: Object.fromEntries(response.headers), text, json };
}

module.exports = { startLocalRuntime, request, waitFor, delay };
