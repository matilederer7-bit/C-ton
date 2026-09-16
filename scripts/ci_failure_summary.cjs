#!/usr/bin/env node

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");

function run(command, args, allowFailure = false) {
  const result = spawnSync(command, args, { encoding: "utf8", env: process.env });
  if (result.error) throw new Error(`${command} unavailable: ${result.error.message}`);
  if (result.signal) throw new Error(`${command} terminated by signal ${result.signal}`);
  if (typeof result.status !== "number") throw new Error(`${command} did not return an exit status`);
  if (result.status !== 0 && !allowFailure) throw new Error(String(result.stderr || result.stdout || `${command} exit ${result.status}`).trim());
  return result;
}
function runGh(args, allowFailure = false) { return run("gh", args, allowFailure); }

function meaningful(line) {
  const value = String(line || "").trim();
  if (!value) return false;
  if (/^(Run |##\[group\]|##\[endgroup\]|Post job cleanup|Cleaning up orphan processes)/i.test(value)) return false;
  return /(error|failed|failure|assert|expected|received|exception|fatal|not ok|exit code|timed out|timeout|econn|refused|cannot|unable)/i.test(value);
}
function normalizeLogLine(line) {
  return String(line || "")
    .replace(/^\S+\s+\S+\s+\d{4}-\d{2}-\d{2}T[^\s]+\s+/u, "")
    .replace(/^\S+\s+\S+\s+/u, "")
    .trim();
}
function extractFileHints(text) {
  const found = new Set();
  const regex = /(?:^|[\s("'])((?:src|tests|scripts|frontend|web|supabase|docs)\/[\w./-]+\.(?:ts|tsx|js|cjs|mjs|sql|json|md))(?:[:\d]*)/gmu;
  for (const match of text.matchAll(regex)) found.add(match[1]);
  return [...found].slice(0, 8);
}
function reproductionHint(text) {
  const npm = text.match(/npm (?:run )?[\w:-]+(?:\s+[^\r\n]*)?/i);
  if (npm) return npm[0].trim();
  const node = text.match(/node\s+(?:\.tmp_test_dist\/)?[\w./-]+(?:\.js|\.cjs)(?:\s+[^\r\n]*)?/i);
  if (node) return node[0].trim();
  const testFile = text.match(/tests\/([\w.-]+)_validation\.(?:ts|js)/i);
  if (testFile) return `npx tsc -p tsconfig.test.json && node .tmp_test_dist/tests/${testFile[1]}_validation.js`;
  return "Re-run the failed repository test group shown by the failed CI step.";
}
function summarizeLog(log) {
  const lines = String(log || "").split(/\r?\n/).map(normalizeLogLine).filter(Boolean);
  const first = lines.find(meaningful) || lines.find((line) => /##\[error\]/i.test(line)) || lines[0] || "No failed log line found";
  return { firstError: first.replace(/^##\[error\]/i, "").trim(), files: extractFileHints(lines.join("\n")), reproduce: reproductionHint(lines.join("\n")) };
}

function currentBranch() {
  const result = run("git", ["branch", "--show-current"], true);
  const branch = String(result.stdout || "").trim();
  return result.status === 0 && branch ? branch : null;
}
function latestFailedRunId() {
  const branch = currentBranch();
  if (!branch) throw new Error("cannot determine current branch; pass an explicit GitHub Actions run id");
  const result = runGh(["run", "list", "--branch", branch, "--status", "failure", "--limit", "1", "--json", "databaseId", "--jq", ".[0].databaseId"]);
  const id = String(result.stdout || "").trim();
  if (!/^\d+$/.test(id)) throw new Error(`no failed GitHub Actions run found for branch ${branch}`);
  return { id, branch };
}
function runMetadata(runId) {
  const result = runGh(["run", "view", runId, "--json", "name,displayTitle,url,jobs"]);
  const data = JSON.parse(result.stdout);
  const failedJob = (data.jobs || []).find((job) => job.conclusion === "failure") || (data.jobs || []).find((job) => job.status === "completed");
  const failedStep = failedJob?.steps?.find((step) => step.conclusion === "failure") || null;
  return { workflow: data.name || data.displayTitle || "unknown", url: data.url || "", job: failedJob?.name || "unknown", step: failedStep?.name || "unknown" };
}
function fetchFailedLog(runId) {
  const result = runGh(["run", "view", runId, "--log-failed"], true);
  const text = String(result.stdout || result.stderr || "").trim();
  if (!text) throw new Error(`failed log unavailable for run ${runId}`);
  return text;
}

function main() {
  const arg = process.argv[2] || "latest";
  const logFileIndex = process.argv.indexOf("--log-file");
  if (logFileIndex >= 0) {
    const file = process.argv[logFileIndex + 1];
    if (!file) throw new Error("--log-file requires a path");
    const summary = summarizeLog(fs.readFileSync(file, "utf8"));
    console.log("CI_FAILURE_SUMMARY mode=local-log");
    console.log(`FIRST_ERROR=${summary.firstError}`);
    console.log(`SUSPECT_FILES=${summary.files.length ? summary.files.join(",") : "none_identified"}`);
    console.log(`REPRODUCE=${summary.reproduce}`);
    return;
  }

  const latest = arg === "latest" ? latestFailedRunId() : null;
  const runId = latest ? latest.id : arg;
  if (!/^\d+$/.test(runId)) throw new Error("run id must be numeric or latest");
  const meta = runMetadata(runId);
  const summary = summarizeLog(fetchFailedLog(runId));
  console.log(`CI_FAILURE_SUMMARY run=${runId}${latest ? ` branch=${latest.branch}` : ""}`);
  console.log(`WORKFLOW=${meta.workflow}`);
  console.log(`JOB=${meta.job}`);
  console.log(`STEP=${meta.step}`);
  console.log(`FIRST_ERROR=${summary.firstError}`);
  console.log(`SUSPECT_FILES=${summary.files.length ? summary.files.join(",") : "none_identified"}`);
  console.log(`REPRODUCE=${summary.reproduce}`);
  if (meta.url) console.log(`RUN_URL=${meta.url}`);
}

if (require.main === module) {
  try { main(); } catch (error) {
    console.error(`CI_FAILURE_SUMMARY_FAIL ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

module.exports = { summarizeLog, extractFileHints, reproductionHint };
