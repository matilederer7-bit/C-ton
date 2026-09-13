#!/usr/bin/env node
// Local QA process/DB hygiene (npm run qa:diagnose / npm run qa:cleanup-stale-dbs).
//
//   --diagnose            (default) READ-ONLY report: occupied test ports,
//                         stray runner processes (listed, never killed), leaked
//                         test-database connections, stale isolated databases
//   --cleanup-stale-dbs   DROP isolated/test databases whose owning pid is
//                         dead and that are older than --older-than-minutes
//                         (default 60). Requires --yes. Prints every name first.
//   --older-than-minutes N
//
// Nothing here kills a process. Owned-child cleanup is what
// scripts/lib/process_cleanup_guard.cjs does for the runs that use it.
require("dotenv").config({ quiet: true });
const guardLib = require("./lib/process_cleanup_guard.cjs");
const isolation = require("./lib/test_db_isolation.cjs");

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : fallback; };

async function main() {
  const databaseUrl = process.env.DATABASE_URL || null;
  const olderThan = Number(option("--older-than-minutes", 60));
  if (flag("--cleanup-stale-dbs")) {
    if (!databaseUrl) { console.error("DATABASE_URL required"); process.exit(2); }
    const stale = await isolation.listStaleIsolatedDatabases({ baseUrl: databaseUrl, olderThanMinutes: olderThan });
    const targets = stale.filter((item) => !item.owning_pid_alive);
    console.log("QA_CLEANUP_STALE_DBS candidates=" + targets.length + " (of " + stale.length + " stale; only dead-owner databases are eligible) mode=" + (flag("--yes") ? "APPLY" : "DRY_RUN"));
    for (const item of targets) console.log("  " + item.name + " purpose=" + item.purpose + " age_min=" + item.age_minutes + (item.legacy ? " legacy" : ""));
    if (!flag("--yes")) { console.log("dry run; add --yes to drop"); process.exit(0); }
    const result = await isolation.dropStaleIsolatedDatabases({ baseUrl: databaseUrl, olderThanMinutes: olderThan, confirm: true });
    console.log("QA_CLEANUP_STALE_DBS_APPLIED dropped=" + result.dropped.length);
    process.exit(0);
  }
  const guard = guardLib.createProcessGuard({ label: "diagnose" });
  const diagnostics = await guard.diagnostics({ databaseUrl, staleMinutes: olderThan, repoRoot: process.cwd() });
  console.log("QA_DIAGNOSE");
  console.log("  occupied test ports: " + (diagnostics.occupied_ports.length ? diagnostics.occupied_ports.join(", ") : "none"));
  console.log("  stray runner processes (not killed): " + diagnostics.stray_runner_processes.length);
  for (const item of diagnostics.stray_runner_processes) console.log("    pid " + item.pid + " " + item.command);
  if (diagnostics.leaked_test_connections && !diagnostics.leaked_test_connections.error) {
    console.log("  test-database connections: " + diagnostics.leaked_test_connections.total + " (leaked: " + diagnostics.leaked_test_connections.leaked.length + ")");
    for (const item of diagnostics.leaked_test_connections.leaked) console.log("    backend " + item.backend_pid + " db=" + item.database + " owner_pid=" + item.owner_pid + " dead app=" + item.application);
  } else if (diagnostics.leaked_test_connections) console.log("  test-database connections: unavailable (" + diagnostics.leaked_test_connections.error + ")");
  else console.log("  test-database connections: no DATABASE_URL");
  if (Array.isArray(diagnostics.stale_isolated_databases)) {
    console.log("  stale isolated databases (older than " + olderThan + " min): " + diagnostics.stale_isolated_databases.length + (diagnostics.stale_isolated_databases.length ? " (drop with: npm run qa:cleanup-stale-dbs -- --yes)" : ""));
    for (const item of diagnostics.stale_isolated_databases) console.log("    " + item.name + " age_min=" + item.age_minutes + " owner_alive=" + item.owning_pid_alive);
  }
  const problems = diagnostics.occupied_ports.length + diagnostics.stray_runner_processes.length + ((diagnostics.leaked_test_connections && diagnostics.leaked_test_connections.leaked) ? diagnostics.leaked_test_connections.leaked.length : 0);
  console.log(problems ? "QA_DIAGNOSE_ATTENTION problems=" + problems : "QA_DIAGNOSE_CLEAN");
  process.exit(0);
}

main().catch((error) => { console.error("QA_DIAGNOSE_ERROR", error.message); process.exit(2); });
