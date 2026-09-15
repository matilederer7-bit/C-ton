#!/usr/bin/env node

const fs = require("node:fs");

function fail(message) {
  console.error(`PR_GOVERNANCE_FAIL ${message}`);
  process.exitCode = 1;
}

function main() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath || !fs.existsSync(eventPath)) {
    console.log("PR_GOVERNANCE_SKIPPED no_pull_request_event");
    return;
  }

  const event = JSON.parse(fs.readFileSync(eventPath, "utf8"));
  const pr = event.pull_request;
  if (!pr) {
    console.log("PR_GOVERNANCE_SKIPPED event_has_no_pull_request");
    return;
  }

  const base = String(pr.base?.ref || "");
  const head = String(pr.head?.ref || "");
  const body = String(pr.body || "");

  if (base !== "master") fail(`base_must_be_master actual=${JSON.stringify(base)}`);
  if (!head || head === "master") fail(`head_must_be_task_branch actual=${JSON.stringify(head)}`);

  const requiredSections = [
    "## Result",
    "## Scope",
    "## Tests",
    "## Canonical verification",
    "## External effects",
    "## Agent coordination",
    "## PROJECT_STATUS"
  ];
  for (const section of requiredSections) {
    if (!body.includes(section)) fail(`missing_section=${JSON.stringify(section)}`);
  }

  if (!/Real money touched:\s*(NO|YES)/i.test(body)) fail("missing_real_money_declaration");
  if (!/Production data changed:\s*(NO|YES)/i.test(body)) fail("missing_production_data_declaration");
  if (!/Production messaging sent:\s*(NO|YES)/i.test(body)) fail("missing_production_messaging_declaration");
  if (!/Hosted infrastructure changed:\s*(NO|YES)/i.test(body)) fail("missing_hosted_infrastructure_declaration");
  if (!/`npm run siton:verify`:\s*(PASS|FAIL|BLOCKED|NOT APPLICABLE)/i.test(body)) fail("missing_canonical_verification_verdict");

  const sensitiveYes = [
    /Real money touched:\s*YES/i,
    /Production data changed:\s*YES/i,
    /Production messaging sent:\s*YES/i
  ].some((pattern) => pattern.test(body));
  if (sensitiveYes && !/authorized/i.test(body)) {
    fail("sensitive_external_effect_declared_without_authorization_note");
  }

  if (process.exitCode) return;
  console.log(`PR_GOVERNANCE_PASS base=${base} head=${head} sections=${requiredSections.length} external_effects_declared=true`);
}

main();
