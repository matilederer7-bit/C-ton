#!/usr/bin/env node

const fs = require("node:fs");

const TASK_TYPES = new Set(["auto", "frontend", "backend", "database", "security", "payments", "tests", "docs", "ux", "operations"]);
const RISKS = new Set(["low", "normal", "high", "critical"]);
const TIERS = new Set(["auto", "economy", "standard", "senior"]);

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

function inferType(task) {
  const value = normalize(task);
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

function routeTask({ task = "", taskType = "auto", risk = "normal", tier = "auto", hasClaude = true, hasCodex = true } = {}) {
  let type = normalize(taskType) || "auto";
  const normalizedRisk = normalize(risk) || "normal";
  let selectedTier = normalize(tier) || "auto";
  if (!TASK_TYPES.has(type)) throw new Error(`invalid task type: ${type}`);
  if (!RISKS.has(normalizedRisk)) throw new Error(`invalid risk: ${normalizedRisk}`);
  if (!TIERS.has(selectedTier)) throw new Error(`invalid tier: ${selectedTier}`);
  if (!hasClaude && !hasCodex) throw new Error("no agent provider is available");
  if (type === "auto") type = inferType(task);

  const sensitive = ["database", "security", "payments"].includes(type) || ["high", "critical"].includes(normalizedRisk);
  if (selectedTier === "auto") {
    if (sensitive) selectedTier = "senior";
    else if (["docs", "tests"].includes(type) && normalizedRisk === "low") selectedTier = "economy";
    else selectedTier = "standard";
  }
  if (sensitive && selectedTier !== "senior") selectedTier = "senior";

  let builder = ["frontend", "ux", "docs"].includes(type) ? "claude" : "codex";
  if (builder === "claude" && !hasClaude) builder = "codex";
  if (builder === "codex" && !hasCodex) builder = "claude";
  let reviewer = builder === "claude" ? "codex" : "claude";
  if (reviewer === "claude" && !hasClaude) reviewer = builder;
  if (reviewer === "codex" && !hasCodex) reviewer = builder;

  const builderEffort = selectedTier === "senior" ? "high" : selectedTier === "standard" ? "medium" : "low";
  const reviewerEffort = sensitive ? "high" : "medium";
  const codexModel = selectedTier === "senior" ? "gpt-5.6-sol" : selectedTier === "standard" ? "gpt-5.6-terra" : "gpt-5.6-luna";
  const lanes = sensitive
    ? ["architecture", "security", "tests", "source-of-truth"]
    : selectedTier === "economy" ? ["tests"] : ["tests", "source-of-truth"];

  return { type, risk: normalizedRisk, tier: selectedTier, builder, reviewer, codexModel, builderEffort, reviewerEffort, lanes, sensitive };
}

function buildMetric(meta = {}) {
  return {
    schema: "siton.agent-run.v1",
    run_id: String(meta.runId || "unknown"),
    task_type: String(meta.taskType || "unknown"),
    risk: String(meta.risk || "unknown"),
    tier: String(meta.tier || "unknown"),
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

function output(key, value) {
  const serialized = Array.isArray(value) ? JSON.stringify(value) : String(value);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${serialized}\n`);
  else process.stdout.write(`${key}=${serialized}\n`);
}

function main() {
  const [command = "help"] = process.argv.slice(2);
  if (command === "route") {
    const route = routeTask({
      task: process.env.SITON_TASK,
      taskType: process.env.SITON_TASK_TYPE,
      risk: process.env.SITON_RISK,
      tier: process.env.SITON_MODEL_TIER,
      hasClaude: process.env.HAS_CLAUDE === "true",
      hasCodex: process.env.HAS_CODEX === "true",
    });
    for (const [key, value] of Object.entries(route)) output(key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`), value);
    return;
  }
  if (command === "metric") {
    fs.writeFileSync(process.argv[3] || "agent-run-metric.json", `${JSON.stringify(buildMetric({
      runId: process.env.GITHUB_RUN_ID,
      taskType: process.env.SITON_TASK_TYPE,
      risk: process.env.SITON_RISK,
      tier: process.env.SITON_MODEL_TIER,
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
module.exports = { buildMetric, inferType, routeTask };
