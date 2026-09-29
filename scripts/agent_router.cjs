#!/usr/bin/env node

const fs = require("node:fs");
const { claudeModelArgs, codexModelForTier, resolveClaudeModel, reviewerTier } = require("./agent_model_tiers.cjs");

const TASK_TYPES = new Set(["auto", "frontend", "backend", "database", "security", "payments", "tests", "docs", "ux", "operations"]);
const RISKS = new Set(["low", "normal", "high", "critical"]);
const TIERS = new Set(["auto", "economy", "standard", "senior", "apex"]);

const APEX_REASONS = new Set(["cross-system-architecture", "critical-cross-layer", "conflicting-reviews", "senior-investigation-exhausted"]);

function issueFields(body = "") {
  const fields = {};
  for (const section of String(body).replace(/\r\n/g, "\n").split(/^### /m).slice(1)) {
    const [label, ...lines] = section.split("\n");
    const value = lines.join("\n").trim();
    if (Object.hasOwn(fields, label.trim())) throw new Error("duplicate issue field: " + label.trim());
    fields[label.trim()] = value === "_No response_" ? "" : value;
  }
  return fields;
}

function routingInput(env = process.env) {
  const fields = env.GITHUB_EVENT_NAME === "issues" ? issueFields(env.SITON_ISSUE_BODY) : {};
  return {
    task: fields.Task || env.SITON_TASK,
    taskType: fields["Task type"] || env.SITON_TASK_TYPE,
    risk: fields.Risk || env.SITON_RISK,
    tier: fields["Compute tier"] || env.SITON_MODEL_TIER,
    apexReason: fields["Apex reason"] || env.SITON_APEX_REASON,
    apexEvidence: fields["Apex evidence"] || env.SITON_APEX_EVIDENCE,
    hasClaude: env.HAS_CLAUDE === "true",
    hasCodex: env.HAS_CODEX === "true",
  };
}

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

// Routing must classify the work being requested, not protected scope. A task
// packet often says "do not change database/payments/auth"; those words are
// safety constraints and must not buy a Senior model by themselves.
const PROTECTED_SCOPE_CLAUSES = [
  /\b(?:do not|don't|must not|never)\s+(?:change|touch|modify|edit|alter|update|migrate|deploy|affect)\b[^.;\n]*/gi,
  /\bwithout\s+(?:changing|touching|modifying|editing|altering|updating|migrating|deploying|affecting)\b[^.;\n]*/gi,
  /\bno\s+(?:changes?|edits?|modifications?|migrations?|deployments?)\s+(?:to|in)\b[^.;\n]*/gi,
  /(?:^|[.;\n])\s*no\s+[^.;\n]{0,120}\b(?:changes?|edits?|modifications?|migrations?|deployments?)\b/gi,
  /\bleave\b[^.;\n]{0,120}\b(?:untouched|unchanged)\b/gi,
];

function actionableTaskText(task) {
  let value = normalize(task)
    .replace(/,\s*(but|however|instead)\b/gi, ". $1 ");
  for (const pattern of PROTECTED_SCOPE_CLAUSES) value = value.replace(pattern, " ");
  return value.replace(/\s+/g, " ").trim();
}

function inferType(task) {
  const value = actionableTaskText(task);
  if (/payment|grow|money|charge|refund|payout|vat|invoice/.test(value)) return "payments";
  if (/migration|postgres|database|schema|sql|supabase/.test(value)) return "database";
  if (/security|auth|permission|secret|rbac|attack/.test(value)) return "security";
  if (/frontend|react|css|mobile|browser|ui/.test(value)) return "frontend";
  if (/ux|copy|accessibility|rtl/.test(value)) return "ux";
  if (/test|ci|flake|coverage|regression/.test(value)) return "tests";
  if (/docs|documentation|runbook|status/.test(value)) return "docs";
  if (/deploy|render|observability|logs|operations/.test(value)) return "operations";
  return "backend";
}

// Work that needs the Senior floor whatever task type was declared: the
// declared type chooses the builder, but a mislabelled or keyword-only task
// never lowers the compute tier of sensitive work.
const SENSITIVE_TEXT = /architect|state[ -]?machine|transition|concurren|idempoten|race condition|deadlock|outbox|webhook|\bauth|login|session|token|otp|permission|rbac|secret|password|migration|schema|postgres|supabase|\bsql\b|payment|payout|refund|charge|invoice|\bvat\b|\bfee\b|money|grow\b/;
// Specific mechanics are safety-significant even when they appear inside a
// negative sentence ("must not update the payment ledger twice"). Broad scope
// nouns such as "database/payments/auth" are intentionally absent here.
const INTRINSIC_SENSITIVE_TEXT = /architect|state[ -]?machine|transition|concurren|idempoten|race condition|deadlock|outbox|webhook|login|session|token|otp|permission|rbac|secret|password|migration|schema|postgres|supabase|\bsql\b|ledger|payout|refund|charge|invoice|\bvat\b|\bfee\b/;

function sensitiveText(task) {
  const original = normalize(task);
  const value = actionableTaskText(task);
  return INTRINSIC_SENSITIVE_TEXT.test(original) || SENSITIVE_TEXT.test(value) || ["database", "security", "payments"].includes(inferType(value));
}

function routeTask({ task = "", taskType = "auto", risk = "normal", tier = "auto", apexReason = "none", apexEvidence = "", hasClaude = true, hasCodex = true, env = process.env } = {}) {
  let type = normalize(taskType) || "auto";
  const normalizedRisk = normalize(risk) || "normal";
  let selectedTier = normalize(tier) || "auto";
  if (!TASK_TYPES.has(type)) throw new Error(`invalid task type: ${type}`);
  if (!RISKS.has(normalizedRisk)) throw new Error(`invalid risk: ${normalizedRisk}`);
  if (!TIERS.has(selectedTier)) throw new Error(`invalid tier: ${selectedTier}`);
  if (!hasClaude && !hasCodex) throw new Error("no agent provider is available");
  if (type === "auto") type = inferType(task);

  const reason = normalize(apexReason) || "none";
  const wantsApex = selectedTier === "apex" || reason !== "none";
  if (wantsApex) {
    if (!APEX_REASONS.has(reason)) throw new Error("Apex requires an approved escalation reason");
    if (String(apexEvidence).trim().length < 40) throw new Error("Apex requires evidence (at least 40 characters): affected layers, competing findings or failed Senior attempts");
    if (reason === "critical-cross-layer" && normalizedRisk !== "critical") throw new Error("critical-cross-layer requires critical risk");
    if (!["auto", "apex"].includes(selectedTier)) throw new Error("Apex reason conflicts with explicitly requested non-Apex tier");
    if (!hasCodex) throw new Error("Apex requires Codex OPENAI_API_KEY; no silent provider downgrade");
    selectedTier = "apex";
  }

  const sensitive = ["database", "security", "payments"].includes(type) || ["high", "critical"].includes(normalizedRisk) || sensitiveText(task);
  if (selectedTier === "auto") {
    if (sensitive) selectedTier = "senior";
    else if (["docs", "tests"].includes(type) && normalizedRisk === "low") selectedTier = "economy";
    else selectedTier = "standard";
  }
  if (sensitive && !["senior", "apex"].includes(selectedTier)) selectedTier = "senior";

  let builder = ["frontend", "ux", "docs"].includes(type) ? "claude" : "codex";
  if (builder === "claude" && !hasClaude) builder = "codex";
  if (builder === "codex" && !hasCodex) builder = "claude";
  let reviewer = builder === "claude" ? "codex" : "claude";
  if (reviewer === "claude" && !hasClaude) reviewer = builder;
  if (reviewer === "codex" && !hasCodex) reviewer = builder;

  const builderEffort = ["senior", "apex"].includes(selectedTier) ? "high" : selectedTier === "standard" ? "medium" : "low";
  const reviewerEffort = sensitive || selectedTier === "apex" ? "high" : "medium";
  // Models come from the tier policy (scripts/agent_model_tiers.cjs): Claude
  // uses the provider's stable alias, fallback is upward only and Senior/Apex
  // never fall back.
  const codexModel = codexModelForTier(selectedTier, env);
  const claude = resolveClaudeModel(selectedTier, { env });
  const lanes = sensitive || selectedTier === "apex"
    ? ["architecture", "security", "tests", "source-of-truth"]
    : selectedTier === "economy" ? ["tests"] : ["tests", "source-of-truth"];

  return { type, risk: normalizedRisk, tier: selectedTier, builder, reviewer, codexModel, claudeModel: claude.model, claudeFallback: claude.fallbacks.join(","), claudeModelArgs: claudeModelArgs(selectedTier, env), claudeReviewerModel: resolveClaudeModel(reviewerTier(selectedTier), { env }).model, claudeReviewerModelArgs: claudeModelArgs(reviewerTier(selectedTier), env), builderEffort, reviewerEffort, lanes, sensitive, apexReason: wantsApex ? reason : "none" };
}

function buildMetric(meta = {}) {
  return {
    schema: "siton.agent-run.v1",
    run_id: String(meta.runId || "unknown"),
    task_type: String(meta.taskType || "unknown"),
    risk: String(meta.risk || "unknown"),
    tier: String(meta.tier || "unknown"),
    codex_model: String(meta.codexModel || "unknown"),
    // Requested = what the router asked for; executed = what Claude Code
    // reports it ran (differs after a --fallback-model switch).
    claude_model_requested: String(meta.claudeModel || "unknown"),
    claude_model_executed: executedList(meta.claudeExecuted),
    claude_reviewer_model_requested: String(meta.claudeReviewerModel || "unknown"),
    claude_reviewer_model_executed: executedList(meta.claudeReviewerExecuted),
    apex_reason: String(meta.apexReason || "none"),
    builder: String(meta.builder || "unknown"),
    reviewer: String(meta.reviewer || "unknown"),
    fix_passes: Number(meta.fixPasses || 0),
    verification: String(meta.verification || "unknown"),
    review_verdict: String(meta.reviewVerdict || "unknown"),
    pr_url: String(meta.prUrl || ""),
    duration_seconds: Math.max(0, Number(meta.durationSeconds || 0)),
    recorded_at: new Date().toISOString(),
  };
}

function executedList(models) {
  return Array.isArray(models) && models.length ? models.join(",") : "unknown";
}

// Models Claude Code actually ran, from claude-code-action execution files
// (stream-json rows). Missing or unreadable files yield no models.
function executedModels(...files) {
  const models = new Set();
  for (const file of files) {
    if (!file) continue;
    let rows;
    try {
      const payload = JSON.parse(fs.readFileSync(file, "utf8"));
      rows = Array.isArray(payload) ? payload : [payload];
    } catch {
      continue;
    }
    for (const row of rows) {
      if (row?.type === "result" && row.modelUsage && typeof row.modelUsage === "object") for (const model of Object.keys(row.modelUsage)) models.add(model);
      if (row?.type === "assistant" && typeof row?.message?.model === "string") models.add(row.message.model);
    }
  }
  return [...models].filter((model) => /^[\w.:@/-]{1,80}$/.test(model)).sort();
}

function output(key, value) {
  const serialized = Array.isArray(value) ? JSON.stringify(value) : String(value);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${serialized}\n`);
  else process.stdout.write(`${key}=${serialized}\n`);
}

function main() {
  const [command = "help"] = process.argv.slice(2);
  if (command === "route") {
    const route = routeTask(routingInput());
    for (const [key, value] of Object.entries(route)) output(key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`), value);
    return;
  }
  if (command === "metric") {
    fs.writeFileSync(process.argv[3] || "agent-run-metric.json", `${JSON.stringify(buildMetric({
      runId: process.env.GITHUB_RUN_ID,
      taskType: process.env.SITON_TASK_TYPE,
      risk: process.env.SITON_RISK,
      tier: process.env.SITON_MODEL_TIER,
      codexModel: process.env.SITON_CODEX_MODEL,
      claudeModel: process.env.SITON_CLAUDE_MODEL,
      claudeReviewerModel: process.env.SITON_CLAUDE_REVIEWER_MODEL,
      claudeExecuted: executedModels(process.env.SITON_CLAUDE_BUILD_EXECUTION, process.env.SITON_CLAUDE_FIX_EXECUTION),
      claudeReviewerExecuted: executedModels(process.env.SITON_CLAUDE_REVIEW1_EXECUTION, process.env.SITON_CLAUDE_REVIEW2_EXECUTION),
      apexReason: process.env.SITON_APEX_REASON,
      builder: process.env.SITON_BUILDER,
      reviewer: process.env.SITON_REVIEWER,
      fixPasses: process.env.SITON_FIX_PASSES,
      verification: process.env.SITON_VERIFICATION,
      reviewVerdict: process.env.SITON_REVIEW_VERDICT,
      prUrl: process.env.SITON_PR_URL,
      durationSeconds: process.env.SITON_DURATION_SECONDS,
    }), null, 2)}\n`);
    return;
  }
  console.log("agent_router.cjs route | metric [output-file]");
}

if (require.main === module) main();
module.exports = { APEX_REASONS, actionableTaskText, buildMetric, executedModels, inferType, sensitiveText, issueFields, routingInput, routeTask };
