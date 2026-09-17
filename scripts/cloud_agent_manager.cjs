#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const AGENTS = new Set(["claude", "codex"]);
const REVIEWERS = new Set(["auto", "claude", "codex", "none"]);

function truthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function clean(value, max = 12000) {
  return String(value || "")
    .replace(/\u0000/g, "")
    .replace(/\r\n/g, "\n")
    .trim()
    .slice(0, max);
}

function slug(value) {
  const out = clean(value, 120)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 54)
    .replace(/[.-]+$/g, "");
  return out || "task";
}

function chooseRoles({ requestedBuilder = "auto", requestedReviewer = "auto", hasClaude = false, hasCodex = false } = {}) {
  const builder = String(requestedBuilder || "auto").toLowerCase();
  const reviewer = String(requestedReviewer || "auto").toLowerCase();
  if (!["auto", ...AGENTS].includes(builder)) throw new Error(`invalid builder: ${builder}`);
  if (!REVIEWERS.has(reviewer)) throw new Error(`invalid reviewer: ${reviewer}`);
  if (!hasClaude && !hasCodex) throw new Error("no cloud coding credential is configured");

  let selectedBuilder = builder;
  if (selectedBuilder === "auto") selectedBuilder = hasClaude ? "claude" : "codex";
  if (selectedBuilder === "claude" && !hasClaude) throw new Error("Claude requested but no Claude cloud credential is configured");
  if (selectedBuilder === "codex" && !hasCodex) throw new Error("Codex requested but OPENAI_API_KEY is not configured");

  let selectedReviewer = reviewer;
  if (selectedReviewer === "auto") {
    if (selectedBuilder === "claude" && hasCodex) selectedReviewer = "codex";
    else if (selectedBuilder === "codex" && hasClaude) selectedReviewer = "claude";
    else selectedReviewer = selectedBuilder;
  }
  if (selectedReviewer === "claude" && !hasClaude) throw new Error("Claude reviewer requested but no Claude cloud credential is configured");
  if (selectedReviewer === "codex" && !hasCodex) throw new Error("Codex reviewer requested but OPENAI_API_KEY is not configured");

  return {
    builder: selectedBuilder,
    reviewer: selectedReviewer,
    independentReview: selectedReviewer !== "none" && selectedReviewer !== selectedBuilder,
  };
}

function buildTaskPacket({ task, scope, doNotTouch, source, builder, reviewer }) {
  const normalizedTask = clean(task);
  if (!normalizedTask) throw new Error("task is required");
  return `# SITON CLOUD TASK PACKET\n\nSOURCE\n${clean(source, 500) || "cloud-manager"}\n\nTASK\n${normalizedTask}\n\nSCOPE\n${clean(scope, 4000) || "Use the smallest coherent repository scope required to solve the task."}\n\nDO NOT TOUCH\n${clean(doNotTouch, 4000) || "Grow, real money, production side effects, unrelated product areas."}\n\nBUILDER\n${builder}\n\nREVIEWER\n${reviewer}\n\nSTANDING RULES\n- Read AGENTS.md, AI_WORKFLOW.md and only task-relevant current source-of-truth files.\n- Inspect before editing. Do not scan historical archives without evidence.\n- Work autonomously. Do not pause for routine approval.\n- Never weaken tests, security, money invariants, audit, idempotency or state-machine enforcement to make a change pass.\n- Siton fee remains 8% of the full collected customer amount including delivery and other applicable charges, excluding VAT.\n- There is no distributor commission or distributor payout rail.\n- REAL MONEY remains 0. Grow remains untouched.\n- Do not execute production charging, payouts, refunds, customer messaging, destructive production data changes, credential rotation or live migrations.\n- Do not commit, push, merge or open a PR. The cloud manager owns Git lifecycle.\n- Do not edit PROJECT_STATUS.md. The cloud manager owns the shared status write.\n- Run focused tests while working when useful. The manager will run canonical verification before commit.\n- After two materially similar failed attempts, stop repeating the same tactic and diagnose from first principles.\n\nDEFINITION OF DONE\nImplement the requested behavior, add or strengthen regression coverage where practical, inspect the diff, and leave the working tree with only intentional task changes.\n`;
}

function buildReviewerPrompt({ baseRef = "origin/master", reviewer, builder }) {
  return `# SITON CLOUD REVIEW\n\nYou are the reviewer. Builder: ${builder}. Reviewer: ${reviewer}.\n\nReview the actual diff against ${baseRef}. Read AGENTS.md, AI_WORKFLOW.md, PROJECT_STATUS.md and task-relevant current source-of-truth files.\n\nREAD-ONLY CONTRACT\n- Do not edit files.\n- Do not commit, push, merge, reset, clean or stash.\n- Do not perform production side effects.\n- Judge correctness, regressions, tests, security, state, money, concurrency and source-of-truth drift where relevant.\n- Do not request style-only rewrites of correct code.\n\nReturn exactly one verdict marker on its own first line:\nVERDICT=PASS\nor\nVERDICT=CHANGES_REQUIRED\n\nThen give concise evidence. For required changes, include file/path and concrete failure or risk.\n`;
}

function parseVerdict(text) {
  const value = clean(text, 50000);
  const match = value.match(/^VERDICT=(PASS|CHANGES_REQUIRED)\s*$/m);
  if (!match) return { verdict: "INVALID", needsFix: true };
  return { verdict: match[1], needsFix: match[1] === "CHANGES_REQUIRED" };
}

function markerBlock({ completed, tested, open, percentage, next, branch, builder, reviewer }) {
  const start = "<!-- AGENT_STATUS:cloud-manager:START -->";
  const end = "<!-- AGENT_STATUS:cloud-manager:END -->";
  return `${start}\n### Cloud Agent Manager latest milestone\n\n- UPDATED: ${new Date().toISOString()}\n- BRANCH: ${clean(branch, 300) || "unknown"}\n- BUILDER: ${clean(builder, 30) || "unknown"}\n- REVIEWER: ${clean(reviewer, 30) || "unknown"}\n- COMPLETED: ${clean(completed, 2500) || "not supplied"}\n- TESTED: ${clean(tested, 2500) || "not supplied"}\n- OPEN: ${clean(open, 2500) || "none stated"}\n- PERCENTAGE: ${clean(percentage, 100) || "not set"}\n- NEXT STEP: ${clean(next, 2500) || "not supplied"}\n${end}`;
}

function updateCloudStatus(file, meta) {
  const absolute = path.resolve(file);
  const current = fs.readFileSync(absolute, "utf8");
  const start = "<!-- AGENT_STATUS:cloud-manager:START -->";
  const end = "<!-- AGENT_STATUS:cloud-manager:END -->";
  const block = markerBlock(meta);
  const startIndex = current.indexOf(start);
  const endIndex = current.indexOf(end);
  let next;
  if (startIndex >= 0 && endIndex > startIndex) {
    next = current.slice(0, startIndex) + block + current.slice(endIndex + end.length);
  } else {
    const anchor = "## STANDING SAFETY AND COMMERCIAL INVARIANTS";
    const anchorIndex = current.indexOf(anchor);
    if (anchorIndex < 0) throw new Error("PROJECT_STATUS.md missing standing-invariants anchor");
    next = `${current.slice(0, anchorIndex)}${block}\n\n${current.slice(anchorIndex)}`;
  }
  fs.writeFileSync(absolute, next, "utf8");
}

function writeOutput(key, value) {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) {
    process.stdout.write(`${key}=${value}\n`);
    return;
  }
  fs.appendFileSync(output, `${key}=${String(value).replace(/\n/g, " ")}\n`, "utf8");
}

function commandRoles(args) {
  const [requestedBuilder = "auto", requestedReviewer = "auto"] = args;
  const roles = chooseRoles({
    requestedBuilder,
    requestedReviewer,
    hasClaude: truthy(process.env.HAS_CLAUDE),
    hasCodex: truthy(process.env.HAS_CODEX),
  });
  writeOutput("builder", roles.builder);
  writeOutput("reviewer", roles.reviewer);
  writeOutput("independent_review", roles.independentReview ? "true" : "false");
  process.stdout.write(`CLOUD_AGENT_ROLES builder=${roles.builder} reviewer=${roles.reviewer} independent_review=${roles.independentReview}\n`);
}

function commandPacket(args) {
  const file = args[0] || ".siton-cloud-task.md";
  const packet = buildTaskPacket({
    task: process.env.SITON_TASK,
    scope: process.env.SITON_SCOPE,
    doNotTouch: process.env.SITON_DO_NOT_TOUCH,
    source: process.env.SITON_TASK_SOURCE,
    builder: process.env.SITON_BUILDER || "unknown",
    reviewer: process.env.SITON_REVIEWER || "unknown",
  });
  fs.writeFileSync(file, packet, "utf8");
  writeOutput("task_slug", slug(process.env.SITON_TASK));
  writeOutput("packet", file);
}

function commandReview(args) {
  const file = args[0];
  if (!file || !fs.existsSync(file)) throw new Error(`review file missing: ${file || "<none>"}`);
  const result = parseVerdict(fs.readFileSync(file, "utf8"));
  writeOutput("verdict", result.verdict);
  writeOutput("needs_fix", result.needsFix ? "true" : "false");
  process.stdout.write(`CLOUD_REVIEW verdict=${result.verdict} needs_fix=${result.needsFix}\n`);
}

function commandExtractClaude(args) {
  const [input, output] = args;
  if (!input || !output) throw new Error("extract-claude requires input and output paths");
  const payload = JSON.parse(fs.readFileSync(input, "utf8"));
  const rows = Array.isArray(payload) ? payload : [payload];
  let result = "";
  for (const row of rows) {
    if (row && row.type === "result" && typeof row.result === "string") result = row.result;
  }
  if (!result) {
    for (let i = rows.length - 1; i >= 0 && !result; i--) {
      const row = rows[i];
      const blocks = row?.type === "assistant" && Array.isArray(row?.message?.content) ? row.message.content : [];
      result = blocks.filter((block) => block?.type === "text" && typeof block.text === "string").map((block) => block.text).join("\n");
    }
  }
  if (!result) throw new Error("Claude execution file contained no final text result");
  fs.writeFileSync(output, result, "utf8");
}

function commandStatus(args) {
  const file = args[0] || "PROJECT_STATUS.md";
  updateCloudStatus(file, {
    completed: process.env.STATUS_COMPLETED,
    tested: process.env.STATUS_TESTED,
    open: process.env.STATUS_OPEN,
    percentage: process.env.STATUS_PERCENTAGE,
    next: process.env.STATUS_NEXT,
    branch: process.env.STATUS_BRANCH,
    builder: process.env.STATUS_BUILDER,
    reviewer: process.env.STATUS_REVIEWER,
  });
}

function printHelp() {
  console.log("cloud_agent_manager.cjs roles [auto|claude|codex] [auto|claude|codex|none]");
  console.log("cloud_agent_manager.cjs packet [path]");
  console.log("cloud_agent_manager.cjs review <review-file>");
  console.log("cloud_agent_manager.cjs extract-claude <execution-json> <output-text>");
  console.log("cloud_agent_manager.cjs status [PROJECT_STATUS.md]");
}

function main() {
  const [command = "help", ...args] = process.argv.slice(2);
  if (["help", "--help", "-h"].includes(command)) return printHelp();
  if (command === "roles") return commandRoles(args);
  if (command === "packet") return commandPacket(args);
  if (command === "review") return commandReview(args);
  if (command === "extract-claude") return commandExtractClaude(args);
  if (command === "status") return commandStatus(args);
  throw new Error(`unknown command: ${command}`);
}

if (require.main === module) {
  try { main(); }
  catch (error) {
    console.error(`FAILED ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

module.exports = {
  buildReviewerPrompt,
  buildTaskPacket,
  chooseRoles,
  parseVerdict,
  slug,
  updateCloudStatus,
};
