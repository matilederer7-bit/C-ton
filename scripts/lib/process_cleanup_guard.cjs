// Process cleanup guard for local QA.
//
// Rules:
//   - it tracks ONLY processes it started (guard.spawn / guard.spawnSync) and
//     kills ONLY those on cleanup; it never enumerates-and-kills node.exe,
//     never touches Claude / Codex / IDE / unrelated runner processes
//   - diagnostics are read-only: stray runner processes are LISTED (command
//     line contains this repository's runner paths) with their pid and age so
//     an operator can decide; leaked test-database connections and occupied
//     test ports are reported, not fixed
//   - on exit it prints what it owned, what it killed and what it saw
const { spawn, spawnSync } = require("node:child_process");
const net = require("node:net");
const path = require("node:path");

const DEFAULT_TEST_PORTS = [3000, 3001, 3100, 4173, 5173, 9222];
const RUNNER_MARKERS = [".tmp_test_dist", "scripts/run_test_group.cjs", "scripts\\run_test_group.cjs", "scripts/ci_web_runtime.cjs", "web_runtime_http_probe", "src/app.ts", "src\\app.ts", ".demo_dist/src/app.js", ".demo_dist\\src\\app.js", "src/worker.ts"];

function createProcessGuard(options = {}) {
  const label = options.label || "qa";
  const owned = new Map();
  const killed = [];
  let installed = false;

  function track(child, command) {
    if (!child || !child.pid) return child;
    owned.set(child.pid, { pid: child.pid, command, started_at: Date.now(), exited: false });
    child.once("exit", () => { const entry = owned.get(child.pid); if (entry) entry.exited = true; });
    return child;
  }

  function killPid(pid, signal = "SIGTERM") {
    if (process.platform === "win32") {
      // Kill the owned child's tree only. /T restricts to descendants of pid.
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
      return;
    }
    try { process.kill(pid, signal); } catch { /* already gone */ }
  }

  const guard = {
    label,
    spawn(command, args = [], spawnOptions = {}) {
      const child = spawn(command, args, spawnOptions);
      return track(child, [command, ...args].join(" "));
    },
    spawnSync(command, args = [], spawnOptions = {}) {
      // Synchronous children finish before returning; still record them.
      const result = spawnSync(command, args, spawnOptions);
      owned.set("sync-" + Date.now() + "-" + Math.random(), { pid: result.pid, command: [command, ...args].join(" "), started_at: Date.now(), exited: true });
      return result;
    },
    adopt(child, command) { return track(child, command || "adopted"); },
    owned() { return [...owned.values()]; },
    alive() { return [...owned.values()].filter((entry) => !entry.exited && entry.pid && pidAlive(entry.pid)); },
    killOwned(signal = "SIGTERM") {
      for (const entry of guard.alive()) {
        killPid(entry.pid, signal);
        killed.push({ pid: entry.pid, command: entry.command, signal });
      }
      return killed;
    },
    async diagnostics(diagOptions = {}) {
      const ports = diagOptions.ports || DEFAULT_TEST_PORTS;
      const occupied = [];
      for (const port of ports) if (await portInUse(port)) occupied.push(port);
      const strays = listRunnerProcesses(diagOptions.repoRoot || process.cwd()).filter((item) => !owned.has(item.pid) && item.pid !== process.pid);
      let leakedConnections = null;
      if (diagOptions.databaseUrl) {
        try { leakedConnections = await leakedTestConnections(diagOptions.databaseUrl); } catch (error) { leakedConnections = { error: error.message }; }
      }
      let staleDatabases = null;
      if (diagOptions.databaseUrl) {
        try {
          const isolation = require("./test_db_isolation.cjs");
          staleDatabases = await isolation.listStaleIsolatedDatabases({ baseUrl: diagOptions.databaseUrl, olderThanMinutes: diagOptions.staleMinutes === undefined ? 60 : diagOptions.staleMinutes });
        } catch (error) { staleDatabases = { error: error.message }; }
      }
      return { owned_alive: guard.alive().map((entry) => ({ pid: entry.pid, command: entry.command, age_ms: Date.now() - entry.started_at })), killed, occupied_ports: occupied, stray_runner_processes: strays, leaked_test_connections: leakedConnections, stale_isolated_databases: staleDatabases };
    },
    installExitHandlers(exitOptions = {}) {
      if (installed) return guard;
      installed = true;
      const finish = (reason) => {
        const alive = guard.alive();
        if (alive.length) guard.killOwned("SIGTERM");
        if (exitOptions.quiet !== true) {
          console.log("PROCESS_GUARD " + label + " reason=" + reason + " owned=" + owned.size + " killed_on_exit=" + alive.length + (alive.length ? " (" + alive.map((entry) => entry.pid).join(",") + ")" : ""));
        }
      };
      process.once("exit", () => finish("exit"));
      process.once("SIGINT", () => { finish("SIGINT"); process.exit(130); });
      process.once("SIGTERM", () => { finish("SIGTERM"); process.exit(143); });
      return guard;
    }
  };
  return guard;
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return Boolean(error && error.code === "EPERM"); }
}

function portInUse(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (value) => { socket.destroy(); resolve(value); };
    socket.setTimeout(400);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

/** READ-ONLY: node processes whose command line mentions this repository's runners. */
function listRunnerProcesses(repoRoot) {
  const markers = RUNNER_MARKERS.concat([path.basename(repoRoot)]);
  const out = [];
  if (process.platform === "win32") {
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Select-Object ProcessId,CreationDate,CommandLine | ConvertTo-Json -Compress"], { encoding: "utf8", timeout: 15000 });
    if (result.status !== 0 || !result.stdout.trim()) return out;
    let rows;
    try { rows = JSON.parse(result.stdout); } catch { return out; }
    for (const row of Array.isArray(rows) ? rows : [rows]) {
      const commandLine = String(row.CommandLine || "");
      if (!markers.some((marker) => commandLine.includes(marker))) continue;
      out.push({ pid: Number(row.ProcessId), command: commandLine.slice(0, 200), created: row.CreationDate || null });
    }
    return out;
  }
  const result = spawnSync("ps", ["-eo", "pid=,etimes=,args="], { encoding: "utf8" });
  if (result.status !== 0) return out;
  for (const line of result.stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match || !/node/.test(match[3])) continue;
    if (!markers.some((marker) => match[3].includes(marker))) continue;
    out.push({ pid: Number(match[1]), command: match[3].slice(0, 200), age_seconds: Number(match[2]) });
  }
  return out;
}

/** READ-ONLY: connections to isolated/test databases whose owning runner pid is dead. */
async function leakedTestConnections(databaseUrl) {
  const { Client } = require("pg");
  const isolation = require("./test_db_isolation.cjs");
  const url = new URL(databaseUrl);
  url.pathname = "/postgres";
  const client = new Client({ connectionString: url.toString(), connectionTimeoutMillis: 5000, application_name: "siton-process-guard" });
  await client.connect();
  try {
    const rows = (await client.query("SELECT pid, datname, application_name, state, backend_start, client_addr::text AS client FROM pg_stat_activity WHERE datname LIKE 'siton%' AND pid <> pg_backend_pid() ORDER BY backend_start")).rows;
    const items = rows.map((row) => {
      const parsed = isolation.parseIsolatedName(row.datname);
      return { backend_pid: row.pid, database: row.datname, application: row.application_name, state: row.state, since: row.backend_start, owner_pid: parsed ? parsed.pid : null, owner_alive: parsed ? pidAlive(parsed.pid) : null };
    });
    return { total: items.length, leaked: items.filter((item) => item.owner_alive === false), connections: items };
  } finally {
    await client.end();
  }
}

module.exports = { createProcessGuard, listRunnerProcesses, leakedTestConnections, portInUse, pidAlive, DEFAULT_TEST_PORTS };
