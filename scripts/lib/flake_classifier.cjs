// Failure classification for local QA and release runs.
//
// Three words, deliberately distinct:
//   REAL_FAILURE          the code under test is wrong (default: every failure
//                         is real until a documented environment signal proves
//                         otherwise)
//   ENVIRONMENT_FAILURE   the run could not be executed as intended here:
//                         Docker missing, spawn refused by a sandbox (EPERM),
//                         a port already bound, the local Postgres down or
//                         out of connections, a Windows file lock, a wrapper
//                         process (npx.cmd) missing
//   CORRECTIVE_RERUN      a second run explicitly requested by an operator
//                         after an ENVIRONMENT_FAILURE; recorded as such in the
//                         report. Never automatic, never silent.
//
// Classification is advisory. It never changes an exit code by itself.
const SIGNALS = Object.freeze([
  { id: "docker-unavailable", pattern: /docker(?:\.exe)?: (?:command )?not found|Docker is required|Cannot connect to the Docker daemon|error during connect: .*docker/i, hint: "Docker Desktop/Engine is not running or not installed" },
  { id: "spawn-eperm", pattern: /spawn(?:Sync)? [^\n]*\bEPERM\b|\bEPERM\b[^\n]*spawn/i, hint: "the process could not be spawned (sandbox or antivirus policy); run outside the sandbox" },
  { id: "port-in-use", pattern: /\bEADDRINUSE\b/, hint: "a test port is already bound (leftover runtime from an earlier run)" },
  { id: "postgres-unreachable", pattern: /\bECONNREFUSED\b[^\n]*:5432|connect ECONNREFUSED 127\.0\.0\.1:5432|pg_isready[^\n]*no response|the database system is starting up/i, hint: "local PostgreSQL is not accepting connections" },
  { id: "postgres-too-many-clients", pattern: /too many clients already|remaining connection slots are reserved/i, hint: "leaked connections exhausted max_connections; run the process cleanup diagnostics" },
  { id: "database-in-use", pattern: /database "[^"]+" is being accessed by other users|is being accessed by other users/i, hint: "a previous run still holds a connection to the test database" },
  { id: "database-exists", pattern: /database "[^"]+" already exists/i, hint: "a database name collided with a leftover from an earlier run" },
  { id: "windows-file-lock", pattern: /\bEBUSY\b: resource busy or locked|\bEPERM\b: operation not permitted, (?:unlink|rmdir|rename)/i, hint: "a Windows process still holds the file (editor, antivirus, previous node)" },
  { id: "npx-wrapper-missing", pattern: /spawn(?:Sync)? npx(?:\.cmd)? ENOENT|'npx' is not recognized|npx\.cmd[^\n]*ENOENT/i, hint: "npx wrapper not resolvable from this shell; use node_modules/.bin or the Node binary directly" },
  { id: "network-denied", pattern: /getaddrinfo ENOTFOUND|EAI_AGAIN|network is unreachable|ENETUNREACH/i, hint: "DNS or outbound network unavailable" },
  { id: "spawn-timeout", pattern: /\bETIMEDOUT\b[^\n]*spawn|spawnSync [^\n]* ETIMEDOUT|timed out after \d+ ?ms/i, hint: "the child did not finish inside the harness timeout (host under load or sleep/suspend)" },
  { id: "clock-jump", pattern: /clock (?:jumped|skew)|system time moved backwards/i, hint: "the machine slept or the clock changed mid-run" },
  { id: "libuv-teardown", pattern: /uv_[a-z_]+ assertion|Assertion failed: .*uv__|UV_HANDLE_CLOSING/i, hint: "Windows libuv teardown race at process exit; the test body may already have passed" },
  { id: "playwright-browser-missing", pattern: /browserType\.launch: Executable doesn't exist|Failed to launch (?:chromium|chrome)|CDP[^\n]*ECONNREFUSED/i, hint: "browser binary or CDP endpoint unavailable" }
]);

function classifyFailure(output) {
  const text = String(output || "");
  const signals = SIGNALS.filter((signal) => signal.pattern.test(text)).map((signal) => ({ id: signal.id, hint: signal.hint }));
  // A genuine assertion failure alongside an environment signal is still real:
  // the environment signal may be noise from cleanup after the real failure.
  const assertion = /AssertionError|ERR_ASSERTION|expected .* to (?:equal|be)|Expected values to be|\bTEST_FAIL\b|FAILED_GROUP|_FAIL\b/.test(text) && !/_FAIL\b[^\n]*(?:EPERM|EADDRINUSE|ECONNREFUSED)/.test(text);
  const kind = signals.length && !assertion ? "ENVIRONMENT_FAILURE" : "REAL_FAILURE";
  return { kind, signals, assertion_seen: assertion };
}

function formatClassification(classification) {
  const parts = ["FAILURE_CLASS=" + classification.kind];
  if (classification.signals.length) parts.push("signals=" + classification.signals.map((s) => s.id).join(","));
  if (classification.assertion_seen) parts.push("assertion_seen=true");
  return parts.join(" ");
}

module.exports = { SIGNALS, classifyFailure, formatClassification };
