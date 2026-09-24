#!/usr/bin/env node
// Team work-plan check (npm run team:plan-check -- <plan.json>).
//
// The team lead (docs/CLAUDE_TEAM_LEAD.md) writes one JSON plan per task
// before any writer starts, and commits it with the Pull Request as evidence.
// This check enforces the owner's coordination rules mechanically:
//
//   - every assignment names a scope, a role and a Definition of Done
//   - builders declare the exact files/directories they may write, and what
//     they must not touch
//   - no two builders may write overlapping paths (parallel writers only on
//     disjoint scopes; Claude and Codex never write the same files)
//   - no builder may write a path already changed by an open Pull Request or
//     active branch listed in `open_branches` (computed from git, not trusted)
//   - reviewers are read-only
//   - every builder is reviewed by a different agent than itself
//   - builders touching database, migrations, security/auth, payments/money
//     or the state machine require a reviewer marked `senior: true`
//   - dependencies reference existing assignments and contain no cycle
//
// Exit 1 on any violation. Output is one line per finding plus a JSON summary.
// Controls: tests/release_tools/team_plan_check.test.cjs.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROLES = new Set(["builder", "reviewer"]);
const AGENTS = new Set(["claude-lead", "claude-subagent", "codex", "chatgpt", "cloud-manager"]);

// High-risk path families. Touching any of them makes the builder "senior":
// it needs an independent reviewer with `senior: true` before merge.
// src/app.ts is included because it hosts the deal state machine, charging,
// refunds and outbox handling.
const HIGH_RISK = [
  { family: "database", pattern: /^(src\/migrations\/|supabase\/|scripts\/run_migrations|src\/schema_contract\.ts$|src\/db\.ts$|src\/runtime_database_boundary\.ts$|src\/.*\.sql$)/ },
  { family: "money", pattern: /^src\/(.*payment.*|.*payout.*|platform_fee_money|money_input|vat_authority|invoice_.*|grow_.*|synthetic_payment_provider|payment_reconciliation|webhook_ingestion)\.ts$/ },
  { family: "security", pattern: /^src\/(.*auth.*|seller_auth|admin_identity|otp_rail|participant_tracking_security|production_guards|seller_enforcement|buyer_session|error_monitoring|log_redaction)\.ts$|^config\/(runtime-environment-policy|route-classification)\.json$|^scripts\/protected_route_policy\.cjs$|^web\/src\/(auth|authRedirect|authTrace|session|adminGate|adminStepUp|api)\.tsx?$/ },
  { family: "state-machine", pattern: /^src\/(app|inventory_repository|authorization_lifecycle|outbox_worker_helpers|worker|worker_scheduler)\.ts$/ },
  { family: "ci-gates", pattern: /^\.github\/workflows\// }
];

function normalizePath(value) {
  return String(value || "").trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/\*\*$/, "/");
}

// Paths are exact files or directory prefixes ending in "/".
function pathsOverlap(a, b) {
  const left = normalizePath(a);
  const right = normalizePath(b);
  if (!left || !right) return false;
  if (left === right) return true;
  if (left.endsWith("/") && right.startsWith(left)) return true;
  if (right.endsWith("/") && left.startsWith(right)) return true;
  return false;
}

const HIGH_RISK_PREFIXES = {
  "database": ["src/migrations/", "supabase/"],
  "money": ["src/"],
  "security": ["src/", "config/", "web/src/"],
  "state-machine": ["src/"],
  "ci-gates": [".github/workflows/"]
};

// A directory grant is conservatively risky if a high-risk file could live
// under it.
function riskFamilies(paths) {
  const families = new Set();
  for (const raw of paths) {
    const value = normalizePath(raw);
    for (const { family, pattern } of HIGH_RISK) {
      if (pattern.test(value) || (value.endsWith("/") && HIGH_RISK_PREFIXES[family].some((prefix) => prefix.startsWith(value) || value.startsWith(prefix)))) families.add(family);
    }
  }
  return [...families].sort();
}

function branchPaths(branch, base, cwd) {
  const result = spawnSync("git", ["diff", "--name-only", `${base}...${branch}`], { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`cannot diff ${branch} against ${base}: ${String(result.stderr || "").trim()}`);
  return result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

function checkPlan(plan, options = {}) {
  const findings = [];
  const fail = (code, message) => findings.push({ code, message });
  const assignments = Array.isArray(plan?.assignments) ? plan.assignments : [];

  if (!plan || typeof plan !== "object") fail("plan_invalid", "plan must be a JSON object");
  if (!String(plan?.task || "").trim()) fail("task_missing", "plan.task must describe the owner's outcome");
  if (!assignments.length) fail("assignments_missing", "plan.assignments must list at least one assignment");

  const ids = new Set();
  for (const item of assignments) {
    const id = String(item?.id || "").trim();
    if (!id) { fail("id_missing", "every assignment needs an id"); continue; }
    if (ids.has(id)) fail("id_duplicate", `assignment id ${id} is used twice`);
    ids.add(id);
    if (!ROLES.has(item.role)) fail("role_invalid", `${id}: role must be builder or reviewer`);
    if (!AGENTS.has(item.agent)) fail("agent_invalid", `${id}: agent must be one of ${[...AGENTS].join(", ")}`);
    if (!String(item.scope || "").trim()) fail("scope_missing", `${id}: scope (area of responsibility) is required`);
    if (!Array.isArray(item.dod) || !item.dod.length) fail("dod_missing", `${id}: dod (Definition of Done) must list at least one item`);
    if (!Array.isArray(item.depends_on)) fail("depends_on_missing", `${id}: depends_on must be an array (empty when independent)`);
    if (item.role === "builder") {
      if (!Array.isArray(item.allowed) || !item.allowed.length) fail("allowed_missing", `${id}: builder must declare allowed paths`);
      if (!Array.isArray(item.forbidden)) fail("forbidden_missing", `${id}: builder must declare forbidden paths (may be empty only deliberately)`);
    }
    if (item.role === "reviewer") {
      if (Array.isArray(item.allowed) && item.allowed.length) fail("reviewer_writes", `${id}: reviewers are read-only; allowed must be empty`);
      if (!Array.isArray(item.reviews) || !item.reviews.length) fail("reviews_missing", `${id}: reviewer must list the builder ids it reviews`);
    }
  }

  const byId = new Map(assignments.filter((item) => item?.id).map((item) => [String(item.id), item]));
  for (const item of assignments) {
    for (const dep of item?.depends_on || []) if (!byId.has(String(dep))) fail("depends_on_unknown", `${item.id}: depends_on references unknown assignment ${dep}`);
    for (const target of item?.reviews || []) {
      const reviewed = byId.get(String(target));
      if (!reviewed) fail("reviews_unknown", `${item.id}: reviews unknown assignment ${target}`);
      else if (reviewed.role !== "builder") fail("reviews_non_builder", `${item.id}: reviews ${target}, which is not a builder`);
    }
  }

  // Dependency cycles (depth-first search).
  const state = new Map();
  const visit = (id, trail) => {
    if (state.get(id) === "done") return;
    if (state.get(id) === "active") { fail("depends_on_cycle", `dependency cycle: ${[...trail, id].join(" -> ")}`); return; }
    state.set(id, "active");
    for (const dep of byId.get(id)?.depends_on || []) if (byId.has(String(dep))) visit(String(dep), [...trail, id]);
    state.set(id, "done");
  };
  for (const id of byId.keys()) visit(id, []);

  const builders = assignments.filter((item) => item?.role === "builder" && Array.isArray(item.allowed));
  const reviewers = assignments.filter((item) => item?.role === "reviewer");

  for (const builder of builders) {
    for (const allowed of builder.allowed) {
      for (const forbidden of builder.forbidden || []) {
        if (pathsOverlap(allowed, forbidden)) fail("allowed_forbidden_conflict", `${builder.id}: ${allowed} is both allowed and forbidden (${forbidden})`);
      }
    }
  }

  for (let i = 0; i < builders.length; i += 1) {
    for (let j = i + 1; j < builders.length; j += 1) {
      for (const left of builders[i].allowed) {
        for (const right of builders[j].allowed) {
          if (pathsOverlap(left, right)) fail("writer_overlap", `${builders[i].id} and ${builders[j].id} may both write ${normalizePath(left)} / ${normalizePath(right)}`);
        }
      }
    }
  }

  const openBranchPaths = options.openBranchPaths || {};
  for (const [branch, paths] of Object.entries(openBranchPaths)) {
    for (const builder of builders) {
      for (const allowed of builder.allowed) {
        const hit = paths.find((changed) => pathsOverlap(allowed, changed));
        if (hit) fail("open_work_overlap", `${builder.id}: ${normalizePath(allowed)} overlaps ${hit}, already changed on open branch ${branch}`);
      }
    }
  }

  const summary = [];
  for (const builder of builders) {
    const families = riskFamilies(builder.allowed);
    const covering = reviewers.filter((reviewer) => (reviewer.reviews || []).map(String).includes(String(builder.id)));
    // Separate sub-agent instances are independent of each other; the lead,
    // Codex, ChatGPT and the cloud manager are single identities and cannot
    // review their own work.
    const independent = covering.filter((reviewer) => reviewer.agent !== builder.agent || builder.agent === "claude-subagent");
    if (!independent.length) fail("review_missing", `${builder.id}: no independent reviewer (a different agent than the builder)`);
    if (families.length && !independent.some((reviewer) => reviewer.senior === true)) {
      fail("senior_review_missing", `${builder.id}: touches ${families.join(", ")}; an independent reviewer with senior: true is required before merge`);
    }
    summary.push({ id: builder.id, agent: builder.agent, risk: families.length ? "senior" : "standard", families, reviewers: covering.map((reviewer) => reviewer.id) });
  }

  return { ok: findings.length === 0, findings, builders: summary };
}

function main(argv) {
  const file = argv[0];
  if (!file) {
    console.error("usage: node scripts/team_plan_check.cjs <plan.json> [--base origin/master]");
    return 2;
  }
  const baseIndex = argv.indexOf("--base");
  const base = baseIndex !== -1 ? argv[baseIndex + 1] : "origin/master";
  let plan;
  try {
    plan = JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
  } catch (error) {
    console.error(`TEAM_PLAN_FAIL plan_unreadable ${error.message}`);
    return 1;
  }
  const openBranchPaths = {};
  for (const branch of plan.open_branches || []) {
    try {
      openBranchPaths[branch] = branchPaths(branch, base, process.cwd());
    } catch (error) {
      console.error(`TEAM_PLAN_FAIL open_branch_unreadable ${error.message}`);
      return 1;
    }
  }
  const result = checkPlan(plan, { openBranchPaths });
  for (const finding of result.findings) console.log(`TEAM_PLAN_FINDING ${finding.code} ${finding.message}`);
  for (const builder of result.builders) console.log(`TEAM_PLAN_BUILDER ${builder.id} agent=${builder.agent} risk=${builder.risk}${builder.families.length ? " families=" + builder.families.join(",") : ""} reviewers=${builder.reviewers.join(",") || "none"}`);
  console.log(`TEAM_PLAN_SUMMARY ${JSON.stringify({ ok: result.ok, findings: result.findings.length, builders: result.builders.length, open_branches_checked: Object.keys(openBranchPaths).length })}`);
  console.log(result.ok ? "TEAM_PLAN_PASS" : "TEAM_PLAN_FAIL");
  return result.ok ? 0 : 1;
}

module.exports = { checkPlan, pathsOverlap, riskFamilies };

if (require.main === module) process.exit(main(process.argv.slice(2)));
