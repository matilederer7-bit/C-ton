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
//   - builders touching database, migrations, security/auth, payments/money,
//     the state machine or the gate tooling itself require a reviewer marked
//     `senior: true`
//   - dependencies reference existing assignments and contain no cycle
//   - every assignment declares the model it runs on (haiku, sonnet or opus,
//     or `n/a` for an agent whose model this project does not choose)
//   - the model matches the risk tier: senior-risk builders and senior
//     reviewers run on opus, and standard-risk work on opus is flagged as a
//     (non-failing) warning so the lead can downshift it; no tier is asserted
//     for a non-Claude agent, because Siton does not pick its model
//   - independent workstreams are dispatched in parallel: with two or more
//     builders at least two real agent identities must be able to start at
//     once, unless the plan carries a `serialization_justification`
//   - a builder that waits on another builder argues it in `depends_on_reason`:
//     a dependent builder is normally handed a fixed interface contract and
//     authors in parallel anyway, so a true serial chain has to be defended
//   - a lone builder spanning two or more areas, or one whole-tree grant that
//     carries two or more risk families, needs a `solo_justification`;
//     otherwise the work is split across parallel builders
//   - every justification carries an argument: >= 40 characters and >= 8 words
//   - an overlap with open work is tolerated only when the plan lists the exact
//     path in `accepted_overlaps` and argues it in `overlap_decision`; the
//     finding is then downgraded to a warning, never silently dropped
//
// Exit 1 on any violation; warnings never fail the gate.
// Output is one line per finding, one per warning, plus a JSON summary.
// Controls: tests/release_tools/team_plan_check.test.cjs.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROLES = new Set(["builder", "reviewer"]);
const AGENTS = new Set(["claude-lead", "claude-subagent", "codex", "chatgpt", "cloud-manager"]);
// Declared model per assignment. Cheap work must not silently run on opus and
// risky work must not silently run on haiku, so the plan states it explicitly.
// "n/a" exists for agents whose model this project does not choose (Codex,
// ChatGPT, the cloud manager): making them record an Anthropic tier would
// write a fabricated claim about another vendor into the historic record.
const MODELS = new Set(["haiku", "sonnet", "opus", "n/a"]);
// The only agents running on a model Siton picks; the model-tier rules apply
// to these and to nobody else.
const CLAUDE_AGENTS = new Set(["claude-lead", "claude-subagent"]);

// High-risk path families. Touching any of them makes the builder "senior":
// it needs an independent reviewer with `senior: true` before merge.
// src/app.ts is included because it hosts the deal state machine, charging,
// refunds and outbox handling.
const HIGH_RISK = [
  { family: "database", pattern: /^(src\/migrations\/|supabase\/|scripts\/run_migrations|src\/schema_contract\.ts$|src\/db\.ts$|src\/runtime_database_boundary\.ts$|src\/.*\.sql$)/ },
  { family: "money", pattern: /^src\/(.*payment.*|.*payout.*|platform_fee_money|money_input|vat_authority|invoice_.*|grow_.*|synthetic_payment_provider|payment_reconciliation|webhook_ingestion)\.ts$/ },
  { family: "security", pattern: /^src\/(.*auth.*|seller_auth|admin_identity|otp_rail|participant_tracking_security|production_guards|seller_enforcement|buyer_session|error_monitoring|log_redaction)\.ts$|^config\/(runtime-environment-policy|route-classification)\.json$|^scripts\/protected_route_policy\.cjs$|^web\/src\/(auth|authRedirect|authTrace|session|adminGate|adminStepUp|api)\.tsx?$/ },
  { family: "state-machine", pattern: /^src\/(app|inventory_repository|authorization_lifecycle|outbox_worker_helpers|worker|worker_scheduler)\.ts$/ },
  // The gate tooling itself is as load-bearing as the workflows that run it,
  // and that is the whole of scripts/: every file under it is a gate, a proof,
  // a policy or migration tooling, and whoever edits one of them can switch
  // another off. Naming three files here let a plan grant the real-money proof
  // and the legal gate by name and still be scored standard risk.
  { family: "ci-gates", pattern: /^\.github\/workflows\/|^scripts\// }
];

function declaredModel(item) {
  return String(item?.model || "").trim();
}

function isClaudeAgent(item) {
  return CLAUDE_AGENTS.has(item?.agent);
}

// A justification has to carry an argument, not filler: under a length-only
// bar both "." x 40 and "because " x 6 counted as a reasoned decision.
function justified(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length >= 40 && text.split(" ").filter(Boolean).length >= 8;
}

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
  // A broad `scripts/` grant is treated as gate-risk the same way a broad
  // `src/` grant is treated as money/security risk.
  "ci-gates": [".github/workflows/", "scripts/"]
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

// Coarse areas of the codebase, used to judge how wide one builder's grant is.
// First match wins, so src/migrations/ is database rather than backend.
const AREAS = [
  ["docs", ["docs/"]],
  ["tests", ["tests/", "external-tests/"]],
  ["frontend", ["web/", "frontend/", "assets/", "android/", "ios/"]],
  ["database", ["src/migrations/", "supabase/"]],
  ["backend", ["src/"]],
  ["tooling", ["scripts/"]],
  ["ci", [".github/"]],
  ["config", ["config/"]]
];

function planAreas(paths) {
  const areas = new Set();
  for (const raw of paths || []) {
    const value = normalizePath(raw);
    if (!value) continue;
    // Root-level markdown (CLAUDE.md, PROJECT_STATUS.md) is documentation;
    // every other root-level file shares one "root" area, so a manifest pair
    // such as package.json + package-lock.json is not a two-area sprawl.
    if (!value.includes("/")) { areas.add(value.endsWith(".md") ? "docs" : "root"); continue; }
    const hit = AREAS.find(([, prefixes]) => prefixes.some((prefix) => value.startsWith(prefix)));
    areas.add(hit ? hit[0] : value.split("/")[0]);
  }
  return [...areas].sort();
}

function branchPaths(branch, base, cwd) {
  const result = spawnSync("git", ["diff", "--name-only", `${base}...${branch}`], { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`cannot diff ${branch} against ${base}: ${String(result.stderr || "").trim()}`);
  return result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

function checkPlan(plan, options = {}) {
  const findings = [];
  const warnings = [];
  const fail = (code, message) => findings.push({ code, message });
  // Warnings are advice for the lead; they never fail the gate.
  const warn = (code, message) => warnings.push({ code, message });
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
    const model = declaredModel(item);
    if (!model) fail("model_missing", `${id}: model must be declared (haiku, sonnet, opus, or n/a for an agent whose model this project does not choose)`);
    else if (!MODELS.has(model)) fail("model_invalid", `${id}: model must be one of ${[...MODELS].join(", ")}`);
    else if (model === "n/a" && isClaudeAgent(item)) fail("model_not_applicable_misused", `${id}: model n/a is only for agents whose model this project does not choose; a Claude agent must declare haiku, sonnet or opus`);
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

  // An overlap with open work is normally fatal. The lead may accept a named
  // one, but only in machine-checkable form: the exact granted path listed in
  // plan.accepted_overlaps, plus a justified plan.overlap_decision arguing it.
  // Prose alone left "print TEAM_PLAN_PASS before dispatch" unsatisfiable for
  // any task touching a file an open Pull Request also touches.
  const acceptedOverlaps = [...new Set((Array.isArray(plan?.accepted_overlaps) ? plan.accepted_overlaps : []).map(normalizePath).filter(Boolean))];
  const overlapDecisionOk = justified(plan?.overlap_decision);
  const usedOverlapEntries = new Set();
  let unjustifiedAcceptance = false;
  const openBranchPaths = options.openBranchPaths || {};
  for (const [branch, paths] of Object.entries(openBranchPaths)) {
    for (const builder of builders) {
      for (const allowed of builder.allowed) {
        const hit = paths.find((changed) => pathsOverlap(allowed, changed));
        if (!hit) continue;
        const message = `${builder.id}: ${normalizePath(allowed)} overlaps ${hit}, already changed on open branch ${branch}`;
        // Exact granted path, not a prefix: an entry of "src/" must not wave
        // through every overlap under it.
        const entry = acceptedOverlaps.find((accepted) => accepted === normalizePath(allowed));
        if (entry && overlapDecisionOk) { usedOverlapEntries.add(entry); warn("open_work_overlap_accepted", `${message}; accepted by plan.accepted_overlaps entry ${entry}`); continue; }
        if (entry) unjustifiedAcceptance = true;
        fail("open_work_overlap", message);
      }
    }
  }
  if (unjustifiedAcceptance) fail("overlap_decision_missing", "plan.accepted_overlaps claims an overlap with open work, but plan.overlap_decision does not argue it (>= 40 characters and >= 8 words); the overlaps above stand");
  // An entry that matched nothing is stale rather than wrong: it is reported
  // so the reader can see the plan carries an acceptance it never used.
  const acceptedOverlapsUnused = acceptedOverlaps.length - usedOverlapEntries.size;

  // Builder-only dependency graph: used for the workstream count below.
  const builderIds = new Set(builders.map((builder) => String(builder.id)));
  const builderDeps = (item) => (item?.depends_on || []).map(String).filter((dep) => builderIds.has(dep));
  // A builder is a root only when nothing known blocks it. A reviewer id
  // blocks just as hard as a builder id: build -> review -> rework is a serial
  // plan, and filtering reviewers out of the dependency list made it look like
  // two independent roots.
  const blockingDeps = (item) => (item?.depends_on || []).map(String).filter((dep) => byId.has(dep));
  const roots = builders.filter((builder) => !blockingDeps(builder).length);
  const parallelBuilders = roots.length;
  // Real concurrency is bounded by agent identities, not by plan rows. Each
  // claude-subagent root is its own instance; every other agent value is a
  // single identity, so two rows both assigned to claude-lead (or both to
  // codex) run one after the other however the plan is drawn.
  const parallelIdentities = new Set(roots.map((builder, index) => (builder.agent === "claude-subagent" ? `claude-subagent#${index}` : `agent:${builder.agent}`))).size;

  // Weakly-connected components (union-find, direction ignored): one component
  // is one workstream that must run end to end before the next one can.
  const parent = new Map([...builderIds].map((id) => [id, id]));
  const find = (id) => { let root = id; while (parent.get(root) !== root) root = parent.get(root); return root; };
  for (const builder of builders) {
    for (const dep of builderDeps(builder)) {
      const left = find(String(builder.id));
      const right = find(dep);
      if (left !== right) parent.set(left, right);
    }
  }
  const workstreams = new Set([...builderIds].map(find)).size;

  if (builders.length >= 2 && parallelIdentities < 2 && !justified(plan?.serialization_justification)) {
    fail("parallel_dispatch_missing", `${builders.length} builders but only ${parallelIdentities} can start in parallel; split the independent workstreams or set plan.serialization_justification (>= 40 characters and >= 8 words)`);
  }
  // Chaining one builder behind another is the thing parallel dispatch exists
  // to avoid. The lead's own procedure hands a dependent builder a fixed
  // interface contract so its authoring still runs at the same time, so a real
  // serial dependency is an argument to make, not an assertion to record.
  for (const builder of builders) {
    for (const dep of builderDeps(builder)) {
      if (!justified(builder.depends_on_reason)) fail("serial_dependency_unjustified", `${builder.id}: waits on builder ${dep}; author against a fixed interface contract in parallel, or set ${builder.id}.depends_on_reason (>= 40 characters and >= 8 words) explaining why it cannot`);
    }
  }
  if (builders.length === 1) {
    const areas = planAreas(builders[0].allowed);
    // One area can still be the whole of it: src/ is a single area and every
    // risk family at once. Two or more families count as an extra span, so a
    // whole-tree grant fires here while one gate script does not.
    const span = areas.length + (riskFamilies(builders[0].allowed).length >= 2 ? 1 : 0);
    if (span >= 2 && !justified(plan?.solo_justification)) {
      fail("solo_justification_missing", `${builders[0].id}: one builder spans ${areas.join(", ")}; split the areas across parallel builders or set plan.solo_justification (>= 40 characters and >= 8 words)`);
    }
  }

  for (const reviewer of reviewers) {
    // Skipped for a non-Claude reviewer: Siton does not select its model, so
    // demanding a tier from it would only produce a made-up declaration.
    if (reviewer.senior === true && isClaudeAgent(reviewer) && declaredModel(reviewer) !== "opus") fail("reviewer_model_underpowered", `${reviewer.id}: senior reviewer requires model: opus`);
  }

  const summary = [];
  for (const builder of builders) {
    const families = riskFamilies(builder.allowed);
    const model = declaredModel(builder);
    const covering = reviewers.filter((reviewer) => (reviewer.reviews || []).map(String).includes(String(builder.id)));
    // Separate sub-agent instances are independent of each other; the lead,
    // Codex, ChatGPT and the cloud manager are single identities and cannot
    // review their own work.
    const independent = covering.filter((reviewer) => reviewer.agent !== builder.agent || builder.agent === "claude-subagent");
    if (!independent.length) fail("review_missing", `${builder.id}: no independent reviewer (a different agent than the builder)`);
    if (families.length && !independent.some((reviewer) => reviewer.senior === true)) {
      fail("senior_review_missing", `${builder.id}: touches ${families.join(", ")}; an independent reviewer with senior: true is required before merge`);
    }
    // Both tier rules apply to Claude agents only, for the same reason the
    // "n/a" model exists: this project does not choose another vendor's model.
    if (families.length && isClaudeAgent(builder) && model !== "opus") {
      fail("model_underpowered", `${builder.id}: touches ${families.join(", ")}; senior-risk builders require model: opus`);
    }
    // The lead itself is always opus, so it never counts as over-provisioned.
    if (!families.length && model === "opus" && isClaudeAgent(builder) && builder.agent !== "claude-lead") {
      warn("model_overpowered", `${builder.id}: standard-risk work (${planAreas(builder.allowed).join(", ")}) on opus; a cheaper model is likely sufficient`);
    }
    summary.push({ id: builder.id, agent: builder.agent, model, risk: families.length ? "senior" : "standard", families, reviewers: covering.map((reviewer) => reviewer.id) });
  }

  return { ok: findings.length === 0, findings, warnings, builders: summary, workstreams, parallelBuilders, parallelIdentities, acceptedOverlapsUnused };
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
  for (const warning of result.warnings) console.log(`TEAM_PLAN_WARN ${warning.code} ${warning.message}`);
  for (const builder of result.builders) console.log(`TEAM_PLAN_BUILDER ${builder.id} agent=${builder.agent} risk=${builder.risk}${builder.families.length ? " families=" + builder.families.join(",") : ""} reviewers=${builder.reviewers.join(",") || "none"} model=${builder.model || "none"}`);
  console.log(`TEAM_PLAN_SUMMARY ${JSON.stringify({ ok: result.ok, findings: result.findings.length, warnings: result.warnings.length, builders: result.builders.length, workstreams: result.workstreams, parallel_builders: result.parallelBuilders, parallel_identities: result.parallelIdentities, accepted_overlaps_unused: result.acceptedOverlapsUnused, open_branches_checked: Object.keys(openBranchPaths).length })}`);
  console.log(result.ok ? "TEAM_PLAN_PASS" : "TEAM_PLAN_FAIL");
  return result.ok ? 0 : 1;
}

module.exports = { checkPlan, pathsOverlap, riskFamilies, planAreas };

if (require.main === module) process.exit(main(process.argv.slice(2)));
