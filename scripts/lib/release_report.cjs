// Shared result model for every release-engineering gate.
//
// Six verdicts, deliberately not collapsed:
//   PASS                 - the gate ran and proved its invariant
//   FAIL                 - the gate ran and the invariant is violated (code blocker)
//   WARNING              - the gate ran; something needs a human decision but is
//                          not a code blocker
//   BLOCKED              - the gate ran; the item is held by an explicit
//                          governance / owner / provider decision (e.g. real
//                          money activation under config/real-money-release-policy.json).
//                          Not a code defect and not an environment limitation;
//                          it is reported apart from technical readiness.
//   SKIPPED_ENVIRONMENT  - the gate could NOT run here (Docker absent, tool
//                          missing, no local Postgres). Never reported as PASS.
//   NOT_APPLICABLE       - the gate does not apply to this profile / target and
//                          was deliberately not run.
//
// A report exits non-zero only on FAIL. BLOCKED, SKIPPED_ENVIRONMENT and
// NOT_APPLICABLE stay visible in the summary so an operator can see what was
// not proven and why.
const fs = require("node:fs");
const path = require("node:path");

const STATUS = Object.freeze({
  PASS: "PASS",
  FAIL: "FAIL",
  WARNING: "WARNING",
  BLOCKED: "BLOCKED",
  SKIPPED_ENVIRONMENT: "SKIPPED_ENVIRONMENT",
  NOT_APPLICABLE: "NOT_APPLICABLE"
});

const ORDER = [STATUS.FAIL, STATUS.BLOCKED, STATUS.WARNING, STATUS.SKIPPED_ENVIRONMENT, STATUS.NOT_APPLICABLE, STATUS.PASS];

class ReleaseReport {
  constructor(name, options = {}) {
    this.name = name;
    this.started_at = new Date().toISOString();
    this.items = [];
    this.meta = options.meta || {};
    this.quiet = Boolean(options.quiet);
    // Optional predicate: which items count towards overall()/exitCode()/counts()
    // by default. The preflight uses it to keep the governance ACTIVATION item
    // out of technical readiness while still listing it in every summary.
    this.overallFilter = typeof options.overallFilter === "function" ? options.overallFilter : null;
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
  block(id, summary, extra = {}) { return this.add({ id, summary, status: STATUS.BLOCKED, ...extra }); }
  notApplicable(id, summary, extra = {}) { return this.add({ id, summary, status: STATUS.NOT_APPLICABLE, ...extra }); }

  scopedItems() { return this.overallFilter ? this.items.filter(this.overallFilter) : this.items; }
  count(status, items = this.scopedItems()) { return items.filter((item) => item.status === status).length; }
  blockers() { return this.items.filter((item) => item.status === STATUS.FAIL); }
  blocked() { return this.items.filter((item) => item.status === STATUS.BLOCKED); }
  /** Worst status over a set of items (default: every item). */
  overall(items = this.scopedItems()) {
    if (this.count(STATUS.FAIL, items)) return STATUS.FAIL;
    if (this.count(STATUS.BLOCKED, items)) return STATUS.BLOCKED;
    if (this.count(STATUS.WARNING, items)) return STATUS.WARNING;
    if (this.count(STATUS.SKIPPED_ENVIRONMENT, items)) return STATUS.SKIPPED_ENVIRONMENT;
    if (items.length && items.every((item) => item.status === STATUS.NOT_APPLICABLE)) return STATUS.NOT_APPLICABLE;
    return STATUS.PASS;
  }
  exitCode() { return this.count(STATUS.FAIL) ? 1 : 0; }

  counts(items = this.scopedItems()) {
    return {
      PASS: this.count(STATUS.PASS, items),
      FAIL: this.count(STATUS.FAIL, items),
      WARNING: this.count(STATUS.WARNING, items),
      BLOCKED: this.count(STATUS.BLOCKED, items),
      SKIPPED_ENVIRONMENT: this.count(STATUS.SKIPPED_ENVIRONMENT, items),
      NOT_APPLICABLE: this.count(STATUS.NOT_APPLICABLE, items)
    };
  }

  toJSON() {
    return {
      name: this.name,
      started_at: this.started_at,
      finished_at: new Date().toISOString(),
      overall: this.overall(),
      counts: this.counts(),
      // When an overallFilter scopes overall/counts (the preflight keeps the
      // governance ACTIVATION item out of technical readiness), the items
      // outside that scope are counted here so no verdict is ever hidden.
      counts_outside_scope: this.overallFilter ? this.counts(this.items.filter((item) => !this.overallFilter(item))) : undefined,
      meta: this.meta,
      items: this.items
    };
  }

  toMarkdown() {
    const json = this.toJSON();
    const lines = [
      "# " + this.name,
      "",
      "Overall" + (this.overallFilter ? " (technical scope)" : "") + ": **" + json.overall + "**  -  PASS " + json.counts.PASS + " / FAIL " + json.counts.FAIL + " / WARNING " + json.counts.WARNING + " / BLOCKED " + json.counts.BLOCKED + " / SKIPPED_ENVIRONMENT " + json.counts.SKIPPED_ENVIRONMENT + " / NOT_APPLICABLE " + json.counts.NOT_APPLICABLE
        + (json.counts_outside_scope ? "  -  outside technical scope (governance): " + Object.entries(json.counts_outside_scope).filter(([, n]) => n).map(([status, n]) => status + " " + n).join(", ") : ""),
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
    console.log(this.name.toUpperCase().replace(/[^A-Z0-9]+/g, "_") + "_SUMMARY overall=" + json.overall + " pass=" + json.counts.PASS + " fail=" + json.counts.FAIL + " warning=" + json.counts.WARNING + " skipped_environment=" + json.counts.SKIPPED_ENVIRONMENT + (json.counts.BLOCKED ? " blocked=" + json.counts.BLOCKED : "") + (json.counts.NOT_APPLICABLE ? " not_applicable=" + json.counts.NOT_APPLICABLE : ""));
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
