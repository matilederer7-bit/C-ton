// Isolated disposable databases for local QA and release tooling.
//
// Guarantees:
//   - one uniquely named database per run: siton_<purpose>_<agent>_<pid>_<time>_<rand>
//     (agent = SITON_AGENT / CODEX_AGENT / CLAUDE_AGENT env, or the checkout
//     directory name, so two agents working in parallel never collide)
//   - never the shared `postgres` database and never a hosted server: the base
//     URL must point at a local or CI-service Postgres unless
//     SITON_TEST_DB_ALLOWED_HOSTS lists the host explicitly
//   - automatic DROP on exit (normal, error, SIGINT/SIGTERM) unless the run
//     asked to preserve on failure (SITON_PRESERVE_TEST_DB=1 or keep())
//   - a read-only lister of stale isolated databases and an explicit,
//     argument-gated dropper for cleanup
const { Client } = require("pg");
const path = require("node:path");
const crypto = require("node:crypto");

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "postgres", "db"]);
const NAME_PATTERN = /^siton_([a-z0-9]+)_([a-z0-9]+)_(\d+)_(\d+)_([a-f0-9]{4})$/;

function agentName() {
  const explicit = process.env.SITON_AGENT || process.env.CLAUDE_AGENT || process.env.CODEX_AGENT || process.env.AGENT_NAME;
  const raw = explicit || path.basename(process.cwd());
  return String(raw).toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 16) || "local";
}

function sanitizePurpose(purpose) {
  return String(purpose || "test").toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 16) || "test";
}

function quoteIdentifier(value) {
  return "\"" + String(value).replace(/"/g, "\"\"") + "\"";
}

function withDatabase(baseUrl, databaseName) {
  const url = new URL(baseUrl);
  url.pathname = "/" + databaseName;
  return url.toString();
}

function assertLocalBase(baseUrl) {
  let parsed;
  try { parsed = new URL(baseUrl); } catch { throw new Error("DATABASE_URL is not a valid URL"); }
  const host = parsed.hostname.toLowerCase();
  const allowed = new Set([...LOCAL_HOSTS, ...String(process.env.SITON_TEST_DB_ALLOWED_HOSTS || "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean)]);
  if (!allowed.has(host)) {
    throw new Error("isolated test databases refuse non-local PostgreSQL host '" + host + "' (set SITON_TEST_DB_ALLOWED_HOSTS to allow a CI service host explicitly)");
  }
  return parsed;
}

function buildName(purpose) {
  return "siton_" + sanitizePurpose(purpose) + "_" + agentName() + "_" + process.pid + "_" + Date.now() + "_" + crypto.randomBytes(2).toString("hex");
}

const registry = new Set();
let hooksInstalled = false;
function installExitHooks() {
  if (hooksInstalled) return;
  hooksInstalled = true;
  const cleanup = (signal) => {
    for (const entry of [...registry]) {
      if (entry.preserved) continue;
      try { entry.dropSync(); } catch { /* best effort on exit */ }
    }
    if (signal) process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.once("exit", () => cleanup());
  process.once("SIGINT", () => cleanup("SIGINT"));
  process.once("SIGTERM", () => cleanup("SIGTERM"));
}

/**
 * Create an isolated database. Returns { name, url, drop(), keep(), preserved }.
 * options.template   - clone from an existing database (CREATE DATABASE ... TEMPLATE)
 * options.purpose    - short label embedded in the name (default "test")
 * options.preserveOnFailure - keep the database when the process exits non-zero
 */
async function createIsolatedDatabase(options = {}) {
  const baseUrl = options.baseUrl || process.env.DATABASE_URL;
  if (!baseUrl) throw new Error("DATABASE_URL is required to create an isolated database");
  assertLocalBase(baseUrl);
  const name = buildName(options.purpose);
  const admin = new Client({ connectionString: withDatabase(baseUrl, "postgres"), connectionTimeoutMillis: 10000 });
  await admin.connect();
  try {
    if (options.template) await admin.query("CREATE DATABASE " + quoteIdentifier(name) + " TEMPLATE " + quoteIdentifier(options.template));
    else await admin.query("CREATE DATABASE " + quoteIdentifier(name));
  } finally {
    await admin.end();
  }
  const preserveOnFailure = options.preserveOnFailure || process.env.SITON_PRESERVE_TEST_DB === "1";
  const entry = {
    name,
    url: withDatabase(baseUrl, name),
    preserved: false,
    keep() { this.preserved = true; return this; },
    async drop() {
      registry.delete(entry);
      const client = new Client({ connectionString: withDatabase(baseUrl, "postgres"), connectionTimeoutMillis: 10000 });
      await client.connect();
      try { await client.query("DROP DATABASE IF EXISTS " + quoteIdentifier(name) + " WITH (FORCE)"); } finally { await client.end(); }
    },
    dropSync() {
      // Used only from exit hooks where async work cannot complete. Spawn a
      // detached child that performs the drop.
      registry.delete(entry);
      const { spawn } = require("node:child_process");
      const script = "const{Client}=require('pg');const c=new Client({connectionString:process.argv[1]});c.connect().then(()=>c.query('DROP DATABASE IF EXISTS ' + process.argv[2] + ' WITH (FORCE)')).catch(()=>{}).finally(()=>c.end());";
      const child = spawn(process.execPath, ["-e", script, withDatabase(baseUrl, "postgres"), quoteIdentifier(name)], { detached: true, stdio: "ignore", cwd: process.cwd() });
      child.unref();
    }
  };
  if (preserveOnFailure) {
    process.once("exit", (code) => { if (code !== 0) entry.preserved = true; });
  }
  registry.add(entry);
  installExitHooks();
  return entry;
}

// Names produced by the older runners (scripts/run_test_group.cjs templates
// and per-test databases, the isolated migration proof, the DR drill, the A/B
// review harness). Recognised for DIAGNOSTICS so leaked databases from any
// runner show up; they carry a pid and a timestamp but no agent tag.
const LEGACY_PATTERNS = [
  [/^siton_test_template_(\d+)_(\d+)$/, "test_template"],
  [/^siton_test_(\d+)_(\d+)_\d+$/, "test"],
  [/^siton_test_ab_(\d+)_(\d+)$/, "test_ab"],
  [/^siton_migration_proof_(\d+)_(\d+)$/, "migration_proof"],
  [/^siton_dr_(?:source|restore)_(\d+)_(\d+)$/, "dr_drill"]
];

/** Parse an isolated database name into its parts, or null. */
function parseIsolatedName(name) {
  const match = NAME_PATTERN.exec(name);
  if (match) return { name, purpose: match[1], agent: match[2], pid: Number(match[3]), created_at: new Date(Number(match[4])), rand: match[5], legacy: false };
  for (const [pattern, purpose] of LEGACY_PATTERNS) {
    const legacy = pattern.exec(name);
    if (legacy) return { name, purpose, agent: null, pid: Number(legacy[1]), created_at: new Date(Number(legacy[2])), rand: null, legacy: true };
  }
  return null;
}

/** Read-only: list isolated databases older than `olderThanMinutes`. */
async function listStaleIsolatedDatabases(options = {}) {
  const baseUrl = options.baseUrl || process.env.DATABASE_URL;
  assertLocalBase(baseUrl);
  const olderThanMs = Number(options.olderThanMinutes === undefined ? 60 : options.olderThanMinutes) * 60000;
  const client = new Client({ connectionString: withDatabase(baseUrl, "postgres"), connectionTimeoutMillis: 10000 });
  await client.connect();
  try {
    const rows = (await client.query("SELECT datname FROM pg_database WHERE datname LIKE 'siton\\_%' ESCAPE '\\' ORDER BY datname")).rows;
    const out = [];
    for (const row of rows) {
      const parsed = parseIsolatedName(row.datname);
      if (!parsed) continue;
      const age = Date.now() - parsed.created_at.getTime();
      if (age >= olderThanMs) out.push({ ...parsed, age_minutes: Math.round(age / 60000), owning_pid_alive: pidAlive(parsed.pid) });
    }
    return out;
  } finally {
    await client.end();
  }
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error && error.code === "EPERM"; }
}

/** Explicit dropper: only names that parse as isolated databases, only when confirmed. */
async function dropStaleIsolatedDatabases(options = {}) {
  if (options.confirm !== true) throw new Error("dropStaleIsolatedDatabases requires confirm: true");
  const stale = await listStaleIsolatedDatabases(options);
  const targets = stale.filter((item) => options.includeLive === true || !item.owning_pid_alive);
  const client = new Client({ connectionString: withDatabase(options.baseUrl || process.env.DATABASE_URL, "postgres"), connectionTimeoutMillis: 10000 });
  await client.connect();
  const dropped = [];
  try {
    for (const item of targets) {
      await client.query("DROP DATABASE IF EXISTS " + quoteIdentifier(item.name) + " WITH (FORCE)");
      dropped.push(item.name);
    }
  } finally {
    await client.end();
  }
  return { considered: stale.length, dropped };
}

/** Allocate a free TCP port on 127.0.0.1 (closed immediately; caller binds soon after). */
function allocateFreePort() {
  return new Promise((resolve, reject) => {
    const server = require("node:net").createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

module.exports = { createIsolatedDatabase, listStaleIsolatedDatabases, dropStaleIsolatedDatabases, parseIsolatedName, buildName, agentName, assertLocalBase, withDatabase, quoteIdentifier, allocateFreePort, LOCAL_HOSTS };
