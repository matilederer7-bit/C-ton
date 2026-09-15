#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

function main() {
  const root = process.cwd();
  const configPath = path.join(root, "config", "required-merge-checks.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const failures = [];

  if (config.branch !== "master") failures.push(`protected branch must be master, got ${config.branch}`);
  const contexts = new Set();
  for (const check of config.checks || []) {
    if (!check.context || !check.workflow || !check.job) {
      failures.push(`invalid check entry ${JSON.stringify(check)}`);
      continue;
    }
    if (contexts.has(check.context)) failures.push(`duplicate context ${check.context}`);
    contexts.add(check.context);
    const workflowPath = path.join(root, check.workflow);
    if (!fs.existsSync(workflowPath)) {
      failures.push(`missing workflow ${check.workflow}`);
      continue;
    }
    const workflow = fs.readFileSync(workflowPath, "utf8");
    const escaped = String(check.job).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const jobPattern = new RegExp(`^\\s{2}${escaped}:\\s*$`, "m");
    if (!jobPattern.test(workflow)) failures.push(`workflow ${check.workflow} no longer defines job ${check.job}`);
  }

  const ruleset = config.ruleset || {};
  for (const required of ["require_pull_request", "require_status_checks", "require_branch_up_to_date", "block_force_push", "block_deletion"]) {
    if (ruleset[required] !== true) failures.push(`ruleset.${required} must remain true`);
  }
  if (ruleset.allow_direct_push_to_master !== false) failures.push("ruleset.allow_direct_push_to_master must remain false");
  if (Number(ruleset.required_approvals) !== 0) failures.push("solo-owner workflow expects required_approvals=0 unless owner explicitly changes it");

  if (failures.length) {
    for (const failure of failures) console.error(`REQUIRED_MERGE_CHECKS_FAIL ${failure}`);
    process.exit(1);
  }
  console.log(`REQUIRED_MERGE_CHECKS_CONTRACT_PASS branch=${config.branch} checks=${contexts.size} approvals=${ruleset.required_approvals}`);
}

main();
