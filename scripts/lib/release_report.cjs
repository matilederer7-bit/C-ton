// Shared result model for every release-engineering gate.
//
// Four verdicts, deliberately not collapsed:
//   PASS                 - the gate ran and proved its invariant
//   FAIL                 - the gate ran and the invariant is violated (blocker)
//   WARNING              - the gate ran; something needs a human decision but is
//                          not a code blocker
//   SKIPPED_ENVIRONMENT  - the gate could NOT run here (Docker absent, tool
//                          missing, no local Postgres). Never reported as PASS.
//
// A report exits non-zero only on FAIL. SKIPPED_ENVIRONMENT is visible in the
// summary so an operator can see what was not proven.
const fs = require("node:fs");
const path = require("node:path");

const STATUS = Object.freeze({
  PASS: "PASS",
  FAIL: "FAIL",
  WARNING: "WARNING",
  SKIPPED_ENVIRONMENT: "SKIPPED_ENVIRONMENT"
});

const ORDER = [STATUS.FAIL, STATUS.WARNING, STATUS.SKIPPED_ENVIRONMENT, STATUS.PASS];

class ReleaseReport {
  constructor(name, options = {}) {
    this.name = name;
    this.started_at = new Date().toISOString();
    this.items = [];
    this.meta = options.meta || {};
    this.quiet = Boolean(options.quiet);
  }

  add(item) {
    const status = item.status;
    if (!Object.values(STATUS).includes(status)) throw new Error("invalid status " + status + " for " + item.id);
    const record = {
      id: String(item.id),
      status,
      summary: String(item.summary || ""),
      detail: item.detail === undefined ? undefined : item.detail,
      evidence: item.evidence === undefined ? undefined : item.evidence,
      duration_ms: item.duration_ms === undefined ? undefined : Number(item.duration_ms)
    };
    this.items.push(record);
    if (!this.quiet) console.log(formatLine(record));
    return record;
  }

  pass(id, summary, extra = {}) { return this.add({ id, summary, status: STATUS.PASS, ...extra }); }
  fail(id, summary, extra = {}) { return this.add({ id, summary, status: STATUS.FAIL, ...extra }); }
  warn(id, summary, extra = {}) { return this.add({ id, summary, status: STATUS.WARNING, ...extra }); }
  skip(id, summary, extra = {}) { return this.add({ id, summary, status: STATUS.SKIPPED_ENVIRONMENT, ...extra }); }

  count(status) { return this.items.filter((item) => item.status === status).length; }
  blockers() { return this.items.filter((item) => item.status === STATUS.FAIL); }
  overall() {
    if (this.count(STATUS.FAIL)) return STATUS.FAIL;
    if (this.count(STATUS.WARNING)) return STATUS.WARNING;
    if (this.count(STATUS.SKIPPED_ENVIRONMENT)) return STATUS.SKIPPED_ENVIRONMENT;
    return STATUS.PASS;
  }
  exitCode() { return this.count(STATUS.FAIL) ? 1 : 0; }

  toJSON() {
    return {
      name: this.name,
      started_at: this.started_at,
      finished_at: new Date().toISOString(),
      overall: this.overall(),
      counts: {
        PASS: this.count(STATUS.PASS),
        FAIL: this.count(STATUS.FAIL),
        WARNING: this.count(STATUS.WARNING),
        SKIPPED_ENVIRONMENT: this.count(STATUS.SKIPPED_ENVIRONMENT)
      },
      meta: this.meta,
      items: this.items
    };
  }

  toMarkdown() {
    const json = this.toJSON();
    const lines = [
      "# " + this.name,
      "",
      "Overall: **" + json.overall + "**  -  PASS " + json.counts.PASS + " / FAIL " + json.counts.FAIL + " / WARNING " + json.counts.WARNING + " / SKIPPED_ENVIRONMENT " + json.counts.SKIPPED_ENVIRONMENT,
      "",
      "Started " + json.started_at + ", finished " + json.finished_at + ".",
      ""
    ];
    for (const [key, value] of Object.entries(this.meta)) lines.push("- " + key + ": " + (typeof value === "object" ? JSON.stringify(value) : value));
    if (Object.keys(this.meta).length) lines.push("");
    lines.push("| Gate | Status | Summary |", "|---|---|---|");
    const sorted = [...this.items].sort((left, right) => ORDER.indexOf(left.status) - ORDER.indexOf(right.status));
    for (const item of sorted) lines.push("| " + item.id + " | " + item.status + " | " + escapeCell(item.summary) + " |");
    const withDetail = this.items.filter((item) => item.detail !== undefined && item.detail !== null && String(item.detail).trim());
    if (withDetail.length) {
      lines.push("", "## Details", "");
      for (const item of withDetail) {
        const body = typeof item.detail === "string" ? item.detail : JSON.stringify(item.detail, null, 2);
        lines.push("### " + item.id + " - " + item.status, "", "```", String(body).slice(0, 6000), "```", "");
      }
    }
    return lines.join("\n") + "\n";
  }

  printSummary(options = {}) {
    const detailLines = Number(options.detailLines || 12);
    const json = this.toJSON();
    console.log("");
    console.log(this.name.toUpperCase().replace(/[^A-Z0-9]+/g, "_") + "_SUMMARY overall=" + json.overall + " pass=" + json.counts.PASS + " fail=" + json.counts.FAIL + " warning=" + json.counts.WARNING + " skipped_environment=" + json.counts.SKIPPED_ENVIRONMENT);
    for (const status of ORDER) {
      if (status === STATUS.PASS) continue;
      for (const item of this.items.filter((entry) => entry.status === status)) {
        console.log("  " + status.padEnd(20) + " " + item.id + ": " + item.summary);
        if (item.detail && typeof item.detail === "string") {
          for (const line of item.detail.split(/\r?\n/).slice(0, detailLines)) console.log("      " + line);
        }
      }
    }
  }

  writeArtifacts(dir, basename) {
    fs.mkdirSync(dir, { recursive: true });
    const jsonPath = path.join(dir, basename + ".json");
    const mdPath = path.join(dir, basename + ".md");
    fs.writeFileSync(jsonPath, JSON.stringify(this.toJSON(), null, 2) + "\n");
    fs.writeFileSync(mdPath, this.toMarkdown());
    return { jsonPath, mdPath };
  }
}

function escapeCell(text) {
  return String(text).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function formatLine(record) {
  const duration = record.duration_ms === undefined ? "" : " (" + record.duration_ms + " ms)";
  return "[" + record.status + "] " + record.id + ": " + record.summary + duration;
}

/**
 * Run a synchronous or asynchronous step and convert a thrown error into FAIL.
 * The step returns `{ status, summary, detail?, evidence? }` or a boolean.
 */
async function runStep(report, id, fn) {
  const startedAt = Date.now();
  try {
    const result = await fn();
    const duration_ms = Date.now() - startedAt;
    if (result === true) return report.pass(id, "ok", { duration_ms });
    if (result === false) return report.fail(id, "failed", { duration_ms });
    if (!result || typeof result !== "object") return report.pass(id, String(result === undefined || result === null ? "ok" : result), { duration_ms });
    return report.add({ id, duration_ms, ...result });
  } catch (error) {
    const duration_ms = Date.now() - startedAt;
    const message = String((error && error.message) || error);
    if (error && error.skippedEnvironment) return report.skip(id, message, { duration_ms, detail: error.detail });
    const stack = error && error.stack ? String(error.stack).split("\n").slice(0, 8).join("\n") : undefined;
    return report.fail(id, message, { duration_ms, detail: stack });
  }
}

/** Throw this from a step when the local environment cannot run it. */
class SkippedEnvironmentError extends Error {
  constructor(message, detail) {
    super(message);
    this.skippedEnvironment = true;
    this.detail = detail;
  }
}

// SITON_RELEASE_ARTIFACTS_DIR redirects every report (tests run nested
// preflights without clobbering the real .release-artifacts).
function artifactsDir(root = process.cwd()) {
  const dir = process.env.SITON_RELEASE_ARTIFACTS_DIR ? path.resolve(process.env.SITON_RELEASE_ARTIFACTS_DIR) : path.join(root, ".release-artifacts");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

module.exports = { STATUS, ReleaseReport, runStep, SkippedEnvironmentError, artifactsDir, formatLine };
