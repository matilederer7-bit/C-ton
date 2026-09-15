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

// Markers that prove the code under test FAILED A CHECK. Any of these makes
// the failure REAL no matter which environment signals appear in the same
// output: a test runner (node:test, TAP, the group runner) that reports a
// failed test may legitimately have printed "spawn EPERM" as part of a
// fixture it was testing - nested output is data, not a diagnosis.
const TEST_FAILURE_PATTERN = /AssertionError|ERR_ASSERTION|expected .* to (?:equal|be)|Expected values to be|\bTEST_FAIL\b|FAILED_GROUP|_FAIL\b|^\s*not ok\b|^\s*(?:ℹ|#) fail [1-9]\d*/m;

function classifyFailure(output) {
  const text = String(output || "");
  const signals = SIGNALS.filter((signal) => signal.pattern.test(text)).map((signal) => ({ id: signal.id, hint: signal.hint }));
  // A genuine assertion / test failure alongside an environment signal is
  // still real: the signal may be noise from cleanup after the real failure,
  // or fixture output of a nested test run.
  const assertion = TEST_FAILURE_PATTERN.test(text) && !/_FAIL\b[^\n]*(?:EPERM|EADDRINUSE|ECONNREFUSED)/.test(text);
  const kind = signals.length && !assertion ? "ENVIRONMENT_FAILURE" : "REAL_FAILURE";
  return { kind, signals, assertion_seen: assertion };
}

// Error codes for which the OS refused to START an existing program. That is
// an environmental inability to spawn (sandbox, antivirus, permission
// policy), never a verdict on the code under test.
const SPAWN_REFUSED_CODES = new Set(["EPERM", "EACCES"]);
// Error codes meaning the program named by the gate does not exist or is not
// a program at all. Every catalogue command names a checked-in tool
// dependency (node, npm, git); a missing one is a repository/catalogue
// defect, so it FAILS - it is never skipped.
const SPAWN_MISSING_CODES = new Set(["ENOENT", "EFTYPE", "ENOEXEC"]);

/**
 * Classify a spawnSync result STRUCTURALLY first, text second.
 *
 *   { kind: "TIMEOUT" }              the child did not finish inside the harness timeout
 *   { kind: "SPAWN_REFUSED" }        the OS refused to spawn the gate's own program (EPERM/EACCES)
 *                                    -> environmental (SKIPPED_ENVIRONMENT)
 *   { kind: "EXECUTABLE_MISSING" }   the gate's own program does not exist (ENOENT/EFTYPE)
 *                                    -> REAL (a catalogue/repository defect)
 *   { kind: "ENVIRONMENT_FAILURE" }  the child ran and failed with a documented environment
 *                                    signal in its output and NO test-failure marker
 *   { kind: "REAL_FAILURE" }         everything else (an exit code with no signal, or any
 *                                    test/assertion failure marker - even next to signals)
 *
 * Textual environment signals are only ever consulted when the child actually
 * ran: a nested test run that PRINTS "spawn EPERM" while reporting a failed
 * test is REAL, and the signals it printed are reported as ignored.
 */
function classifySpawnResult(result) {
  const output = String(result.output || "");
  const error = result.error || null;
  const code = error && error.code ? String(error.code) : null;
  const timedOut = Boolean(result.timedOut) || code === "ETIMEDOUT";
  if (timedOut) return { kind: "TIMEOUT", signals: [{ id: "spawn-timeout", hint: "the child did not finish inside the harness timeout (hang, or host under load)" }], assertion_seen: TEST_FAILURE_PATTERN.test(output), error_code: code };
  const spawnFailed = error && (result.status === null || result.status === undefined) && !result.signal;
  if (spawnFailed && code && SPAWN_REFUSED_CODES.has(code)) {
    return { kind: "SPAWN_REFUSED", signals: [{ id: "spawn-eperm", hint: "the OS refused to start the program (sandbox, antivirus or permission policy); run outside the sandbox" }], assertion_seen: false, error_code: code };
  }
  if (spawnFailed && code && SPAWN_MISSING_CODES.has(code)) {
    return { kind: "EXECUTABLE_MISSING", signals: [{ id: "executable-not-found", hint: "the program named by the gate does not exist or is not executable: fix the catalogue command or install the tool" }], assertion_seen: false, error_code: code };
  }
  if (spawnFailed) {
    // Unknown spawn error: real until a documented signal says otherwise.
    return { kind: "REAL_FAILURE", signals: [], assertion_seen: false, error_code: code };
  }
  if ((result.status === null || result.status === undefined) && result.signal) {
    // Terminated by a signal (SIGKILL from an OOM killer, an operator kill,
    // a crash): the child never reported a verdict. Real, never a pass.
    return { kind: "REAL_FAILURE", signals: [], assertion_seen: TEST_FAILURE_PATTERN.test(output), error_code: code, exit_status: null, exit_signal: result.signal };
  }
  const textual = classifyFailure(output + (error ? "\n" + String(error.message || error) : ""));
  return { ...textual, error_code: code, exit_status: result.status === undefined ? null : result.status, exit_signal: result.signal || null };
}

const ENVIRONMENTAL_KINDS = new Set(["ENVIRONMENT_FAILURE", "SPAWN_REFUSED"]);
function isEnvironmental(classification) { return ENVIRONMENTAL_KINDS.has(classification.kind); }

function formatClassification(classification) {
  const parts = ["FAILURE_CLASS=" + classification.kind];
  const ids = (classification.signals || []).map((s) => s.id);
  if (ids.length) {
    // Signals found in the output of a REAL failure are noise (a nested test
    // fixture, cleanup after the real failure); say so instead of printing a
    // "signals=" list that reads like an environment verdict.
    parts.push((classification.kind === "REAL_FAILURE" ? "ignored_signals=" : "signals=") + ids.join(","));
  }
  if (classification.assertion_seen) parts.push("assertion_seen=true");
  if (classification.error_code) parts.push("error_code=" + classification.error_code);
  if (classification.exit_signal && classification.kind !== "TIMEOUT") parts.push("exit_signal=" + classification.exit_signal);
  return parts.join(" ");
}

module.exports = { SIGNALS, TEST_FAILURE_PATTERN, SPAWN_REFUSED_CODES, SPAWN_MISSING_CODES, classifyFailure, classifySpawnResult, isEnvironmental, formatClassification };
