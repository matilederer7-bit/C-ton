#!/usr/bin/env node
// Run a command and classify a failure (npm run qa:classified -- <cmd> [args]).
//
// The child's exit code is preserved. On failure the captured output is
// classified as REAL_FAILURE or ENVIRONMENT_FAILURE (scripts/lib/flake_classifier.cjs)
// and the verdict is printed and written to .release-artifacts/qa-classified-<n>.json.
//
// --rerun-once-on-environment-failure   an explicit operator opt-in: when the
//   first run is an ENVIRONMENT_FAILURE, run once more and record the second
//   run as CORRECTIVE_RERUN. The final exit code is the SECOND run's code. A
//   REAL_FAILURE is never rerun. Nothing is retried without this flag.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { classifyFailure, formatClassification } = require("./lib/flake_classifier.cjs");
const { createProcessGuard } = require("./lib/process_cleanup_guard.cjs");

const argv = process.argv.slice(2);
const rerunFlag = "--rerun-once-on-environment-failure";
const rerun = argv.includes(rerunFlag);
const command = argv.filter((item) => item !== rerunFlag);
if (!command.length) { console.error("usage: qa_run_classified.cjs [--rerun-once-on-environment-failure] <command> [args...]"); process.exit(2); }

const guard = createProcessGuard({ label: "classified" }).installExitHandlers({ quiet: true });

function runOnce(attempt) {
  const started = Date.now();
  // A shell is used only for Windows wrapper scripts (npm.cmd / npx.cmd);
  // plain executables run directly so quoting is preserved verbatim.
  const needsShell = process.platform === "win32" && /^(npm|npx|yarn|pnpm)(\.cmd)?$/i.test(path.basename(command[0]));
  const result = guard.spawnSync(command[0], command.slice(1), { encoding: "utf8", shell: needsShell, maxBuffer: 256 * 1024 * 1024, env: process.env });
  const output = String(result.stdout || "") + String(result.stderr || "");
  process.stdout.write(result.stdout || "");
  process.stderr.write(result.stderr || "");
  const status = result.status === null ? (result.error ? 1 : 0) : result.status;
  const record = { attempt, command: command.join(" "), status, duration_ms: Date.now() - started, error: result.error ? String(result.error.message) : null };
  if (status !== 0) {
    const classification = classifyFailure(output + (result.error ? "\n" + result.error.message : ""));
    record.classification = classification;
    console.log("\n" + formatClassification(classification) + " attempt=" + attempt + " exit=" + status);
    for (const signal of classification.signals) console.log("  " + signal.id + ": " + signal.hint);
  }
  return record;
}

const first = runOnce(1);
const records = [first];
let final = first;
if (first.status !== 0 && rerun && first.classification && first.classification.kind === "ENVIRONMENT_FAILURE") {
  console.log("\nCORRECTIVE_RERUN requested by operator flag after ENVIRONMENT_FAILURE");
  const second = runOnce(2);
  second.kind = "CORRECTIVE_RERUN";
  records.push(second);
  final = second;
}
const dir = path.join(process.cwd(), ".release-artifacts");
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "qa-classified-" + process.pid + ".json"), JSON.stringify({ command: command.join(" "), records, final_status: final.status }, null, 2));
process.exit(final.status);
