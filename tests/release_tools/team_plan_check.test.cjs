const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { checkPlan, pathsOverlap, riskFamilies, planAreas } = require("../../scripts/team_plan_check.cjs");

function plan(assignments, extra = {}) {
  return { task: "example outcome", assignments, ...extra };
}
// round three: model_fabricated (a non-Claude agent declaring an Anthropic
// tier) means these two defaults can no longer hand a fixed model to every
// agent override. The default model now follows the effective agent: a real
// Claude agent gets a real tier, anyone else gets "n/a", unless a test
// overrides model explicitly. Without this, the plain reviewer() default
// (agent "codex", model "opus") and a builder() call overridden to agent
// "codex" with no model override were themselves the exact fabricated-record
// shape model_fabricated exists to catch, in nearly every test in this file.
const CLAUDE_HELPER_AGENTS = new Set(["claude-lead", "claude-subagent", "cloud-manager"]);
const builder = (id, allowed, extra = {}) => {
  const agent = extra.agent || "claude-subagent";
  const model = extra.model !== undefined ? extra.model : (CLAUDE_HELPER_AGENTS.has(agent) ? "sonnet" : "n/a");
  return { id, agent, role: "builder", scope: `scope ${id}`, allowed, forbidden: [], depends_on: [], dod: ["done"], ...extra, model };
};
const reviewer = (id, reviews, extra = {}) => {
  const agent = extra.agent || "codex";
  const model = extra.model !== undefined ? extra.model : (CLAUDE_HELPER_AGENTS.has(agent) ? "opus" : "n/a");
  return { id, agent, role: "reviewer", scope: `review ${id}`, reviews, depends_on: [], dod: ["verdict"], ...extra, model };
};
const codes = (result) => result.findings.map((finding) => finding.code).sort();

test("a disjoint two-builder plan with independent review passes", () => {
  const result = checkPlan(plan([builder("B1", ["docs/a.md"]), builder("B2", ["docs/b.md"]), reviewer("R", ["B1", "B2"])]));
  assert.equal(result.ok, true, JSON.stringify(result.findings));
  assert.equal(result.builders.every((item) => item.risk === "standard"), true);
});

test("overlapping writers are rejected, including directory grants", () => {
  const result = checkPlan(plan([builder("B1", ["web/public/ui/"]), builder("B2", ["web/public/ui/button.css"]), reviewer("R", ["B1", "B2"])]));
  assert.deepEqual(codes(result), ["writer_overlap"]);
});

test("a builder may not write a path already changed on an open branch", () => {
  const result = checkPlan(plan([builder("B1", ["docs/a.md"]), reviewer("R", ["B1"])]), { openBranchPaths: { "origin/codex/x": ["docs/a.md", "src/app.ts"] } });
  assert.deepEqual(codes(result), ["open_work_overlap"]);
  assert.match(result.findings[0].message, /origin\/codex\/x/);
});

test("reviewers are read-only and every builder needs an independent reviewer", () => {
  const writingReviewer = checkPlan(plan([builder("B1", ["docs/a.md"]), reviewer("R", ["B1"], { allowed: ["docs/a.md"] })]));
  assert.ok(codes(writingReviewer).includes("reviewer_writes"));
  const unreviewed = checkPlan(plan([builder("B1", ["docs/a.md"])]));
  assert.deepEqual(codes(unreviewed), ["review_missing"]);
  const selfReview = checkPlan(plan([builder("B1", ["docs/a.md"], { agent: "codex" }), reviewer("R", ["B1"], { agent: "codex" })]));
  assert.deepEqual(codes(selfReview), ["review_missing"]);
});

test("database, money, security, state-machine and CI paths require an independent senior reviewer", () => {
  for (const path of ["web/src/auth.tsx", "web/src/session.ts", "web/src/authRedirect.ts", "web/src/api.ts", "src/error_monitoring.ts", "src/log_redaction.ts", "src/migrations/075_x.sql", "src/payment_provider.ts", "src/seller_auth.ts", "src/app.ts", ".github/workflows/x.yml", "src/platform_fee_money.ts"]) {
    // model pinned to opus here (not the builder() default of sonnet) so this
    // control isolates senior_review_missing from the new model_underpowered
    // rule: every one of these paths is also a risk path, so a non-opus
    // model would add its own finding and break the exact-codes assertion.
    const missing = checkPlan(plan([builder("B1", [path], { model: "opus" }), reviewer("R", ["B1"])]));
    assert.deepEqual(codes(missing), ["senior_review_missing"], path);
    const present = checkPlan(plan([builder("B1", [path], { model: "opus" }), reviewer("R", ["B1"], { senior: true })]));
    assert.equal(present.ok, true, `${path}: ${JSON.stringify(present.findings)}`);
  }
});

test("a directory grant that could contain high-risk files is treated as senior", () => {
  assert.ok(riskFamilies(["src/"]).includes("money"));
  assert.deepEqual(riskFamilies(["docs/"]), []);
  assert.deepEqual(riskFamilies(["web/src/components.tsx"]), []);
  assert.ok(riskFamilies(["web/src/"]).includes("security"));
});

test("missing scope, Definition of Done, allowed paths or dependencies are rejected", () => {
  const result = checkPlan(plan([{ id: "B1", agent: "claude-subagent", role: "builder" }, reviewer("R", ["B1"])]));
  for (const code of ["scope_missing", "dod_missing", "depends_on_missing", "allowed_missing", "forbidden_missing"]) assert.ok(codes(result).includes(code), code);
});

test("allowed and forbidden may not intersect", () => {
  const result = checkPlan(plan([builder("B1", ["src/log_redaction.ts"], { forbidden: ["src/"] }), reviewer("R", ["B1"], { senior: true })]));
  assert.ok(codes(result).includes("allowed_forbidden_conflict"));
});

test("unknown and cyclic dependencies are rejected", () => {
  const unknown = checkPlan(plan([builder("B1", ["docs/a.md"], { depends_on: ["ZZ"] }), reviewer("R", ["B1"])]));
  assert.ok(codes(unknown).includes("depends_on_unknown"));
  const cyclic = checkPlan(plan([builder("B1", ["docs/a.md"], { depends_on: ["B2"] }), builder("B2", ["docs/b.md"], { depends_on: ["B1"] }), reviewer("R", ["B1", "B2"])]));
  assert.ok(codes(cyclic).includes("depends_on_cycle"));
});

test("pathsOverlap handles files, directories and ./ or ** spellings", () => {
  assert.equal(pathsOverlap("src/", "src/app.ts"), true);
  assert.equal(pathsOverlap("./src/app.ts", "src/app.ts"), true);
  assert.equal(pathsOverlap("src/**", "src/x/y.ts"), true);
  assert.equal(pathsOverlap("src/app.ts", "src/app.tsx"), false);
  assert.equal(pathsOverlap("docs/a/", "docs/ab/c.md"), false);
});

test("the committed smoke plan is valid", () => {
  const smoke = require("../../docs/team-plans/2026-09-24-smoke-worker-log-scrub.json");
  const result = checkPlan(smoke);
  assert.equal(result.ok, true, JSON.stringify(result.findings));
  assert.equal(result.builders.find((item) => item.id === "B1").risk, "senior");
  assert.equal(result.builders.find((item) => item.id === "B3").risk, "senior");
});

test("a builder must declare a model", () => {
  const missingModel = builder("B1", ["docs/a.md"]);
  delete missingModel.model;
  const result = checkPlan(plan([missingModel, reviewer("R", ["B1"])]));
  assert.deepEqual(codes(result), ["model_missing"]);
  const present = checkPlan(plan([builder("B1", ["docs/a.md"]), reviewer("R", ["B1"])]));
  assert.ok(!codes(present).includes("model_missing"));
});

test("a reviewer must also declare a model", () => {
  const missingModel = reviewer("R", ["B1"]);
  delete missingModel.model;
  const result = checkPlan(plan([builder("B1", ["docs/a.md"]), missingModel]));
  assert.ok(codes(result).includes("model_missing"));
});

test("a builder's model must be one of haiku, sonnet or opus", () => {
  const result = checkPlan(plan([builder("B1", ["docs/a.md"], { model: "gpt-4" }), reviewer("R", ["B1"])]));
  assert.deepEqual(codes(result), ["model_invalid"]);
  for (const model of ["haiku", "sonnet", "opus"]) {
    const ok = checkPlan(plan([builder("B1", ["docs/a.md"], { model }), reviewer("R", ["B1"])]));
    assert.ok(!codes(ok).includes("model_invalid"), model);
  }
});

test("a builder touching a risk family must declare opus", () => {
  const underpowered = checkPlan(plan([builder("B1", ["src/payment_provider.ts"], { model: "sonnet" }), reviewer("R", ["B1"], { senior: true })]));
  assert.deepEqual(codes(underpowered), ["model_underpowered"]);
  const fixed = checkPlan(plan([builder("B1", ["src/payment_provider.ts"], { model: "opus" }), reviewer("R", ["B1"], { senior: true })]));
  assert.equal(fixed.ok, true, JSON.stringify(fixed.findings));
});

test("a senior reviewer must declare opus", () => {
  // round two: reviewer_model_underpowered is skipped entirely for non-Claude
  // agents (Siton does not pick their model), and reviewer()'s default agent
  // is "codex". Fixture updated to a Claude reviewer so this control still
  // exercises the tier rule it names; assertions unchanged.
  const underpowered = checkPlan(plan([builder("B1", ["docs/a.md"]), reviewer("R", ["B1"], { agent: "claude-subagent", senior: true, model: "sonnet" })]));
  assert.deepEqual(codes(underpowered), ["reviewer_model_underpowered"]);
  const fixed = checkPlan(plan([builder("B1", ["docs/a.md"]), reviewer("R", ["B1"], { agent: "claude-subagent", senior: true })]));
  assert.equal(fixed.ok, true, JSON.stringify(fixed.findings));
});

test("two or more builders need parallel dispatch unless the plan justifies serializing them", () => {
  // round two: B2 depends on B1 (a builder), which now also requires B2's own
  // depends_on_reason (serial_dependency_unjustified) independent of the
  // plan-level serialization_justification this test is about. Fixture
  // updated with a real reason so this control still isolates
  // parallel_dispatch_missing; assertions unchanged in intent.
  const chainPlan = plan([
    builder("B1", ["docs/a.md"]),
    builder("B2", ["docs/b.md"], { depends_on: ["B1"], depends_on_reason: "B2 edits the file that B1 renames, so it must start only after B1 lands" }),
    reviewer("R", ["B1", "B2"])
  ]);
  const serial = checkPlan(chainPlan);
  assert.deepEqual(codes(serial), ["parallel_dispatch_missing"]);
  assert.equal(serial.parallelBuilders, 1);

  const shortReason = checkPlan({ ...chainPlan, serialization_justification: "not enough words" });
  assert.deepEqual(codes(shortReason), ["parallel_dispatch_missing"]);

  // round two: justified() also requires >= 8 words, so the round-one
  // "x".repeat(40)" filler no longer unlocks the escape hatch; replaced with
  // a genuine sentence (see also the dedicated justified() filler test below).
  const longEnough = checkPlan({ ...chainPlan, serialization_justification: "these two workstreams touch the same generated file, so running them at once would race and corrupt output" });
  assert.equal(longEnough.ok, true, JSON.stringify(longEnough.findings));
});

test("two independent builders need no serialization justification", () => {
  const result = checkPlan(plan([builder("B1", ["docs/a.md"]), builder("B2", ["docs/b.md"]), reviewer("R", ["B1", "B2"])]));
  assert.ok(!codes(result).includes("parallel_dispatch_missing"));
  assert.equal(result.parallelBuilders, 2);
});

test("a lone builder spanning multiple areas needs a solo justification", () => {
  const widePlan = plan([builder("B1", ["docs/a.md", "src/other_module.ts"]), reviewer("R", ["B1"])]);
  const result = checkPlan(widePlan);
  assert.deepEqual(codes(result), ["solo_justification_missing"]);

  const under40 = checkPlan({ ...widePlan, solo_justification: "x".repeat(39) });
  assert.deepEqual(codes(under40), ["solo_justification_missing"]);

  // round two: justified() also requires >= 8 words; "x".repeat(40)" is one
  // word and no longer unlocks the escape hatch, so the fixture is replaced
  // with a genuine sentence (assertion unchanged: ok must become true).
  const justifiedReason = checkPlan({ ...widePlan, solo_justification: "this single builder spans both documentation and backend code because the interface contract lives in one file" });
  assert.equal(justifiedReason.ok, true, JSON.stringify(justifiedReason.findings));
});

test("a lone builder confined to one area needs no solo justification", () => {
  const result = checkPlan(plan([builder("B1", ["docs/a.md", "docs/b.md"]), reviewer("R", ["B1"])]));
  assert.ok(!codes(result).includes("solo_justification_missing"));
});

test("a builder with no risk family declaring opus warns without failing", () => {
  const result = checkPlan(plan([builder("B1", ["docs/a.md"], { model: "opus" }), reviewer("R", ["B1"])]));
  assert.equal(result.ok, true, JSON.stringify(result.findings));
  assert.deepEqual(result.findings, []);
  assert.equal(result.warnings.length, 1);
  assert.deepEqual(result.warnings.map((item) => item.code), ["model_overpowered"]);
});

test("a lead builder or a risk-bearing builder declaring opus is not overpowered", () => {
  const lead = checkPlan(plan([builder("B1", ["docs/a.md"], { model: "opus", agent: "claude-lead" }), reviewer("R", ["B1"])]));
  assert.deepEqual(lead.warnings, []);
  const risky = checkPlan(plan([builder("B1", ["src/payment_provider.ts"], { model: "opus" }), reviewer("R", ["B1"], { senior: true })]));
  assert.deepEqual(risky.warnings, []);
});

test("the plan checker's own tooling is classified ci-gates, and round two widens this to every script", () => {
  assert.ok(riskFamilies(["scripts/team_plan_check.cjs"]).includes("ci-gates"));
  assert.ok(riskFamilies(["scripts/agent_router.cjs"]).includes("ci-gates"));
  assert.ok(riskFamilies(["scripts/"]).includes("ci-gates"));
  // round two: /^\.github\/workflows\/|^scripts\// means every path under
  // scripts/ is gate tooling, not just the three enforcement scripts named
  // above. Round-one fixture updated: this used to assert [] for an
  // arbitrary script under scripts/; it is now ["ci-gates"].
  assert.deepEqual(riskFamilies(["scripts/render_brand_assets.cjs"]), ["ci-gates"]);
  assert.deepEqual(riskFamilies(["scripts/unrelated_tool.cjs"]), ["ci-gates"]);
  // a tooling-looking path outside scripts/ is still standard risk.
  assert.deepEqual(riskFamilies(["tools/unrelated_tool.cjs"]), []);
});

test("planAreas maps paths to their coordination area", () => {
  assert.deepEqual(planAreas(["docs/readme_notes.md"]), ["docs"]);
  assert.deepEqual(planAreas(["PROJECT_STATUS.md"]), ["docs"]);
  assert.deepEqual(planAreas(["CLAUDE.md"]), ["docs"]);
  assert.deepEqual(planAreas(["tests/x.test.js"]), ["tests"]);
  assert.deepEqual(planAreas(["external-tests/y.spec.js"]), ["tests"]);
  assert.deepEqual(planAreas(["web/src/app.tsx"]), ["frontend"]);
  assert.deepEqual(planAreas(["frontend/index.html"]), ["frontend"]);
  assert.deepEqual(planAreas(["assets/logo.svg"]), ["frontend"]);
  assert.deepEqual(planAreas(["android/app/build.gradle"]), ["frontend"]);
  assert.deepEqual(planAreas(["ios/App/Info.plist"]), ["frontend"]);
  assert.deepEqual(planAreas(["src/migrations/070_x.sql"]), ["database"]);
  assert.deepEqual(planAreas(["supabase/functions/x.ts"]), ["database"]);
  assert.deepEqual(planAreas(["src/app.ts"]), ["backend"]);
  assert.deepEqual(planAreas(["scripts/team_plan_check.cjs"]), ["tooling"]);
  assert.deepEqual(planAreas([".github/workflows/ci.yml"]), ["ci"]);
  assert.deepEqual(planAreas(["config/route-classification.json"]), ["config"]);
  assert.deepEqual(planAreas(["vendor/lib.js"]), ["vendor"]);
  // round two: a root-level non-markdown file maps to "root", not to its own name.
  assert.deepEqual(planAreas(["Makefile"]), ["root"]);
});

test("planAreas returns sorted distinct areas across multiple paths", () => {
  assert.deepEqual(planAreas(["docs/a.md", "src/app.ts", "docs/b.md", "tests/x.ts"]), ["backend", "docs", "tests"]);
});

test("workstreams counts weakly-connected components of the builder dependency graph", () => {
  const independent = checkPlan(plan([
    builder("B1", ["docs/a.md"]),
    builder("B2", ["docs/b.md"]),
    builder("B3", ["docs/c.md"]),
    reviewer("R", ["B1", "B2", "B3"])
  ]));
  assert.equal(independent.workstreams, 3);
  assert.equal(independent.parallelBuilders, 3);

  const chain = checkPlan(plan([
    builder("B1", ["docs/a.md"]),
    builder("B2", ["docs/b.md"], { depends_on: ["B1"] }),
    builder("B3", ["docs/c.md"], { depends_on: ["B2"] }),
    reviewer("R", ["B1", "B2", "B3"])
  ]));
  assert.equal(chain.workstreams, 1);
  assert.equal(chain.parallelBuilders, 1);
});

// --- round two: senior-review remediation controls ---------------------
// Each control below pins closed one finding from the independent senior
// review of round one. Every one of these must FAIL against the round-one
// checker (scripts/team_plan_check.cjs as it stood before this round) and
// PASS once scripts/team_plan_check.cjs implements the round-two contract.

test("REGRESSION exploit: a lead on haiku touching gate scripts, reviewed by a non-senior agent on n/a, must now fail (round one let this pass)", () => {
  const result = checkPlan(plan([
    builder("B1", ["scripts/proof_no_real_money.cjs", "scripts/legal_compliance_gate.cjs"], { agent: "claude-lead", model: "haiku" }),
    reviewer("R", ["B1"], { agent: "codex", model: "n/a" })
  ]));
  assert.deepEqual(codes(result), ["model_underpowered", "senior_review_missing"]);
});

test("identity-aware parallelism: shared non-subagent identities collapse, but subagents never do", () => {
  const bothLead = checkPlan(plan([
    builder("B1", ["docs/a.md"], { agent: "claude-lead" }),
    builder("B2", ["docs/b.md"], { agent: "claude-lead" }),
    reviewer("R", ["B1", "B2"])
  ]));
  assert.equal(bothLead.parallelIdentities, 1);
  assert.ok(codes(bothLead).includes("parallel_dispatch_missing"));

  const bothCodex = checkPlan(plan([
    builder("B1", ["docs/a.md"], { agent: "codex" }),
    builder("B2", ["docs/b.md"], { agent: "codex" }),
    reviewer("R", ["B1", "B2"], { agent: "claude-subagent" })
  ]));
  assert.equal(bothCodex.parallelIdentities, 1);
  assert.ok(codes(bothCodex).includes("parallel_dispatch_missing"));

  const bothSubagent = checkPlan(plan([
    builder("B1", ["docs/a.md"]),
    builder("B2", ["docs/b.md"]),
    reviewer("R", ["B1", "B2"])
  ]));
  assert.equal(bothSubagent.parallelIdentities, 2);
  assert.ok(!codes(bothSubagent).includes("parallel_dispatch_missing"));

  const mixed = checkPlan(plan([
    builder("B1", ["docs/a.md"]),
    builder("B2", ["docs/b.md"], { agent: "codex" }),
    reviewer("R", ["B1", "B2"], { agent: "claude-subagent" })
  ]));
  assert.equal(mixed.parallelIdentities, 2);
  assert.ok(!codes(mixed).includes("parallel_dispatch_missing"));
});

test("a builder depending on a reviewer id is not a root, and that alone can starve parallel dispatch", () => {
  const result = checkPlan(plan([
    builder("B1", ["docs/a.md"]),
    builder("B2", ["docs/b.md"], { depends_on: ["R"] }),
    reviewer("R", ["B1", "B2"])
  ]));
  // parallelBuilders IS the root count, and a root is blocked by ANY known id
  // now, not just a builder id: B2 depends on reviewer R, so it genuinely
  // cannot start yet and is excluded from the root count alongside B1. Only
  // 1 of the 2 builders can start right now — that is the truthful number,
  // not 2.
  assert.equal(result.parallelBuilders, 1);
  // workstreams deliberately stays on the builder-only dependency graph: a
  // reviewer dependency blocks a start, it does not chain two builders'
  // authoring into one workstream. So B1 and B2 remain two separate
  // components even though only one of them is currently a root.
  assert.equal(result.workstreams, 2);
  assert.equal(result.parallelIdentities, 1);
  assert.ok(codes(result).includes("parallel_dispatch_missing"));
});

test("serial_dependency_unjustified: a builder depending on another builder must carry its own reason", () => {
  const chain = (extra) => plan([
    builder("B1", ["docs/a.md"]),
    builder("B2", ["docs/b.md"], { depends_on: ["B1"], ...extra }),
    reviewer("R", ["B1", "B2"])
  ]);

  const missing = checkPlan(chain({}));
  assert.ok(codes(missing).includes("serial_dependency_unjustified"));

  const filler = checkPlan(chain({ depends_on_reason: "x".repeat(40) }));
  assert.ok(codes(filler).includes("serial_dependency_unjustified"), "40 chars in one word must still fail justified()");

  const justified = checkPlan(chain({ depends_on_reason: "B2 must wait because B1 first establishes the shared schema contract file" }));
  assert.ok(!codes(justified).includes("serial_dependency_unjustified"));
});

test("justified() rejects filler that only hits the character count, through the solo_justification rule", () => {
  const widePlan = plan([builder("B1", ["docs/a.md", "src/other_module.ts"]), reviewer("R", ["B1"])]);
  for (const filler of [".".repeat(40), "because ".repeat(6), "x" + " ".repeat(38) + "x"]) {
    const result = checkPlan({ ...widePlan, solo_justification: filler });
    assert.ok(codes(result).includes("solo_justification_missing"), JSON.stringify(filler));
  }
  const real = checkPlan({ ...widePlan, solo_justification: "this single builder spans docs and backend because the interface contract lives in one file" });
  assert.ok(!codes(real).includes("solo_justification_missing"));
});

test("a whole-tree grant is solo-risky even though it maps to a single area; narrow grants are not", () => {
  const wholeTree = checkPlan(plan([builder("B1", ["src/"], { model: "opus" }), reviewer("R", ["B1"], { senior: true })]));
  assert.ok(codes(wholeTree).includes("solo_justification_missing"));

  const rootFiles = checkPlan(plan([builder("B1", ["package.json", "package-lock.json"]), reviewer("R", ["B1"])]));
  assert.ok(!codes(rootFiles).includes("solo_justification_missing"));

  const oneGateScript = checkPlan(plan([builder("B1", ["scripts/one_gate_script.cjs"], { model: "opus" }), reviewer("R", ["B1"], { senior: true })]));
  assert.ok(!codes(oneGateScript).includes("solo_justification_missing"));
});

test("planAreas collapses non-markdown root-level files into one root area", () => {
  assert.deepEqual(planAreas(["package.json", "package-lock.json", "Makefile"]), ["root"]);
  assert.deepEqual(planAreas(["README.md"]), ["docs"]);
});

test("model n/a is valid only for agents Siton does not choose a model for", () => {
  // round three: cloud-manager really runs anthropics/claude-code-action with
  // this repo's own key, so Siton DOES choose its model. It moved out of this
  // loop (where round two placed it, alongside codex and chatgpt) and into
  // the Claude-agent loop below, where "n/a" is misused rather than valid.
  for (const agent of ["codex", "chatgpt"]) {
    const result = checkPlan(plan([builder("B1", ["docs/a.md"], { agent, model: "n/a" }), reviewer("R", ["B1"], { agent: "claude-subagent" })]));
    assert.ok(!codes(result).includes("model_not_applicable_misused"), agent);
    assert.ok(!codes(result).includes("model_invalid"), agent);
  }
  for (const agent of ["claude-lead", "claude-subagent", "cloud-manager"]) {
    const result = checkPlan(plan([builder("B1", ["docs/a.md"], { agent, model: "n/a" }), reviewer("R", ["B1"])]));
    assert.ok(codes(result).includes("model_not_applicable_misused"), agent);
    assert.ok(!codes(result).includes("model_invalid"), agent);
  }
});

test("a senior non-Claude reviewer declaring model n/a is not underpowered", () => {
  const result = checkPlan(plan([builder("B1", ["docs/a.md"]), reviewer("R", ["B1"], { agent: "codex", senior: true, model: "n/a" })]));
  assert.equal(result.ok, true, JSON.stringify(result.findings));
  assert.ok(!codes(result).includes("reviewer_model_underpowered"));
});

test("accepted_overlaps downgrades a listed open_work_overlap only when overlap_decision is justified", () => {
  const options = { openBranchPaths: { "origin/codex/x": ["docs/a.md"] } };
  const goodReason = "this overlap is accepted because the other open branch only appends a section far below our insertion point";

  const accepted = checkPlan(plan([builder("B1", ["docs/a.md"]), reviewer("R", ["B1"])], { accepted_overlaps: ["docs/a.md"], overlap_decision: goodReason }), options);
  assert.equal(accepted.ok, true, JSON.stringify(accepted.findings));
  assert.ok(!codes(accepted).includes("open_work_overlap"));
  assert.ok(accepted.warnings.some((item) => item.code === "open_work_overlap_accepted"));

  const shortDecision = checkPlan(plan([builder("B1", ["docs/a.md"]), reviewer("R", ["B1"])], { accepted_overlaps: ["docs/a.md"], overlap_decision: "too short" }), options);
  assert.ok(codes(shortDecision).includes("open_work_overlap"));
  assert.ok(codes(shortDecision).includes("overlap_decision_missing"));

  const unlisted = checkPlan(plan([builder("B1", ["docs/a.md"]), reviewer("R", ["B1"])], { accepted_overlaps: ["docs/other.md"], overlap_decision: goodReason }), options);
  assert.ok(codes(unlisted).includes("open_work_overlap"));
});

test("the committed round-one orchestration plan carries only an honest model_underpowered on B2, not a fabricated pass", () => {
  // checkPlan(planData) with no second argument never diffs any branch (that
  // only happens in main(), or in a test that passes options.openBranchPaths
  // explicitly, as the accepted_overlaps tests above do), so open_work_overlap
  // cannot appear from this call regardless of plan.open_branches -- it never
  // did, on any round. The one real finding left is B2's model.
  //
  // round three's Fix 5 reclassifies tests/release_tools/team_plan_check.test.cjs
  // as ci-gates, because CI now runs it to enforce this very gate. B2 (granted
  // that file) was assigned, and genuinely ran, on sonnet -- that is what
  // happened, not a clerical gap. Bumping B2.model to "opus" after the fact
  // to make this control read green would itself be the model_fabricated
  // shape this round added a detector for: the field must record what
  // actually ran, not whatever value satisfies today's rule. So this control
  // pins the honest, currently-open finding instead of papering over it: it
  // fails on any OTHER or additional finding, and it is expected to keep
  // failing (never silently start passing) until B2's assignment is
  // genuinely re-planned on a real model.
  const planData = require("../../docs/team-plans/2026-09-28-team-orchestration-enforcement.json");
  const result = checkPlan(planData);
  assert.deepEqual(codes(result), ["model_underpowered"], JSON.stringify(result.findings));
  assert.equal(result.ok, false);
});

test("the committed round-two orchestration plan carries only an honest model_underpowered on C2, not a fabricated pass", () => {
  // same root cause as the round-one control above: C2 (granted
  // tests/release_tools/team_plan_check.test.cjs) was assigned, and genuinely
  // ran, on sonnet, and round three's Fix 5 now scores that exact file
  // ci-gates. Recording "opus" instead, to make this plan read as fully
  // valid, would be rewriting history to satisfy a rule -- exactly what
  // model_fabricated exists to catch. This control therefore pins the true,
  // currently-open finding: it fails on any OTHER finding, and result.ok is
  // expected to stay false until C2 is genuinely re-planned on a real model.
  const planData = require("../../docs/team-plans/2026-09-28-orchestration-enforcement-round2.json");
  const result = checkPlan(planData);
  assert.deepEqual(codes(result), ["model_underpowered"], JSON.stringify(result.findings));
  assert.equal(result.ok, false);
});

// --- round three: closing the second reviewer's A/B-harness findings -------
// An independent A/B harness ran 1,516 plans through round one and round two
// and found 387 cases where round two is LOOSER than round one, two of which
// are regressions round two itself introduced. Each control below pins one
// of those cases closed. Every one of these must FAIL against the round-two
// checker (scripts/team_plan_check.cjs as it stood at 05b6cf8) and PASS once
// scripts/team_plan_check.cjs implements the round-three contract.

test("FABRICATED_RECORD: a non-Claude agent may not declare it runs on an Anthropic model tier (model_fabricated)", () => {
  // this is the exact regression: round two's tier checks were gated on
  // agent identity, so a non-Claude agent declaring "sonnet" or "opus" was
  // never looked at again once the "n/a" escape hatch existed for it. That
  // silently deleted the detector the "n/a" field was added to support.
  const fabricated = checkPlan(plan([builder("B1", ["docs/a.md"], { agent: "codex", model: "sonnet" }), reviewer("R", ["B1"], { agent: "claude-subagent" })]));
  assert.deepEqual(codes(fabricated), ["model_fabricated"], JSON.stringify(fabricated.findings));

  const clean = checkPlan(plan([builder("B1", ["docs/a.md"], { agent: "codex", model: "n/a" }), reviewer("R", ["B1"], { agent: "claude-subagent" })]));
  assert.equal(clean.ok, true, JSON.stringify(clean.findings));
});

test("cloud-manager really runs Claude, so the model-tier rules apply to it exactly like claude-lead or claude-subagent", () => {
  const underpowered = checkPlan(plan([
    builder("B1", ["src/payment_reconciliation.ts"], { agent: "cloud-manager", model: "haiku" }),
    reviewer("R", ["B1"], { senior: true, model: "n/a" })
  ]));
  assert.deepEqual(codes(underpowered), ["model_underpowered"], JSON.stringify(underpowered.findings));

  const fixed = checkPlan(plan([
    builder("B1", ["src/payment_reconciliation.ts"], { agent: "cloud-manager", model: "opus" }),
    reviewer("R", ["B1"], { senior: true, model: "n/a" })
  ]));
  assert.equal(fixed.ok, true, JSON.stringify(fixed.findings));

  const misused = checkPlan(plan([builder("B1", ["docs/a.md"], { agent: "cloud-manager", model: "n/a" }), reviewer("R", ["B1"])]));
  assert.deepEqual(codes(misused), ["model_not_applicable_misused"], JSON.stringify(misused.findings));
});

test("accepted_overlaps must bind to the exact conflicting path, not the builder's own directory grant", () => {
  // round two matched plan.accepted_overlaps against the builder's OWN grant
  // (normalizePath(allowed)), so an entry as coarse as the grant itself waved
  // through any real conflict underneath it. It must instead match the file
  // actually changed on the open branch.
  const options = { openBranchPaths: { "origin/codex/x": ["src/payment_reconciliation.ts"] } };
  const soloReason = "this builder holds the whole backend tree because the payment reconciliation module cannot be split from its callers";
  const overlapReason = "this overlap is accepted because the other open branch only appends a section far below our insertion point";
  const build = (accepted) => plan([
    builder("B1", ["src/"], { model: "opus" }),
    reviewer("R", ["B1"], { senior: true })
  ], { accepted_overlaps: accepted, overlap_decision: overlapReason, solo_justification: soloReason });

  const grantOnly = checkPlan(build(["src/"]), options);
  assert.ok(codes(grantOnly).includes("open_work_overlap"), JSON.stringify(grantOnly.findings));

  const exactConflict = checkPlan(build(["src/payment_reconciliation.ts"]), options);
  assert.ok(!codes(exactConflict).includes("open_work_overlap"), JSON.stringify(exactConflict.findings));
  assert.ok(exactConflict.warnings.some((item) => item.code === "open_work_overlap_accepted"));
});

test("serial_dependency_unjustified also fires when a builder's blocking dependency is a reviewer, not only a builder", () => {
  const chain = (extra) => plan([builder("B3", ["docs/c.md"], { depends_on: ["R"], ...extra }), reviewer("R", ["B3"])]);

  const missing = checkPlan(chain({}));
  assert.deepEqual(codes(missing), ["serial_dependency_unjustified"], JSON.stringify(missing.findings));

  const justified = checkPlan(chain({ depends_on_reason: "B3 must wait because R first confirms the scope before any file may change" }));
  assert.equal(justified.ok, true, JSON.stringify(justified.findings));
});

test("a bare single-segment directory grant to a lone builder now needs its own solo justification", () => {
  for (const allowed of [["scripts/"], ["web/"], [".github/"]]) {
    const result = checkPlan(plan([builder("B1", allowed, { model: "opus" }), reviewer("R", ["B1"], { senior: true, model: "n/a" })]));
    assert.ok(codes(result).includes("solo_justification_missing"), JSON.stringify({ allowed, findings: result.findings }));
  }
  for (const allowed of [["scripts/one_gate.cjs"], ["web/src/styles.css"], ["package.json", "package-lock.json"]]) {
    const result = checkPlan(plan([builder("B1", allowed, { model: "opus" }), reviewer("R", ["B1"], { senior: true, model: "n/a" })]));
    assert.ok(!codes(result).includes("solo_justification_missing"), JSON.stringify({ allowed, findings: result.findings }));
  }
});

test("riskFamilies gains the plan-check test file itself and the deployment definition files as ci-gates", () => {
  for (const path of ["tests/release_tools/team_plan_check.test.cjs", "Dockerfile", "render.yaml", "docker-compose.yml"]) {
    assert.deepEqual(riskFamilies([path]), ["ci-gates"], path);
  }
  assert.deepEqual(riskFamilies(["tests/some_product_validation.ts"]), []);
});

test("justified() requires distinct words, not just a word count, through the solo_justification rule", () => {
  // round two counted total whitespace-separated words, so "because " x 8,
  // "we " x 20 and "TODO " x 9 each cleared >= 40 chars and >= 8 words while
  // repeating a single word. That is the same shape of filler round one's
  // "x".repeat(40) was rejected for; round two only closed the character-only
  // case (see the "justified() rejects filler..." test above), not this one.
  const widePlan = plan([builder("B1", ["docs/a.md", "src/other_module.ts"]), reviewer("R", ["B1"])]);
  for (const filler of ["because ".repeat(8), "we ".repeat(20), "TODO ".repeat(9), "word ".repeat(16)]) {
    const result = checkPlan({ ...widePlan, solo_justification: filler });
    assert.ok(codes(result).includes("solo_justification_missing"), JSON.stringify(filler));
  }
  const real = checkPlan({ ...widePlan, solo_justification: "this single builder spans both documentation and backend code because the interface contract lives in one file" });
  assert.ok(!codes(real).includes("solo_justification_missing"), JSON.stringify(real.findings));
});

test("closes the round-two review gap: a codex senior reviewer fabricating an Anthropic tier fails, declaring n/a stays clean", () => {
  // round two's fixture for "a senior reviewer must declare opus" swapped its
  // non-Claude reviewer (agent "codex") for a Claude one specifically to keep
  // exercising reviewer_model_underpowered, which is skipped for non-Claude
  // agents. That silently dropped the only coverage of a non-Claude senior
  // reviewer entirely. Pinned here from both sides: a real tier is fabricated,
  // n/a is the only clean declaration.
  const fabricated = checkPlan(plan([builder("B1", ["docs/a.md"]), reviewer("R", ["B1"], { agent: "codex", senior: true, model: "sonnet" })]));
  assert.ok(codes(fabricated).includes("model_fabricated"), JSON.stringify(fabricated.findings));
  assert.equal(fabricated.ok, false);

  const clean = checkPlan(plan([builder("B1", ["docs/a.md"]), reviewer("R", ["B1"], { agent: "codex", senior: true, model: "n/a" })]));
  assert.equal(clean.ok, true, JSON.stringify(clean.findings));
});

// --- round four: pin the P0 a third reviewer found, this time via a spelling
// riskFamilies, planAreas and pathsOverlap all decide file-vs-directory by
// whether a path ends in "/". Dropping that one character defeated every risk
// rule at once: riskFamilies(["scripts"]) returned [] instead of ["ci-gates"],
// planAreas(["scripts"]) returned ["root"] instead of ["tooling"], and
// pathsOverlap("scripts", "scripts/x.cjs") returned false. This is the same
// P0 class as round one's named-gate-script grant and round three's
// whole-tree-grant fix -- reappearing a third time through a spelling rather
// than a listing. scripts/team_plan_check.cjs now rejects any allowed or
// forbidden entry that is not written in exactly the one normal form that
// means what it says: an unambiguous file (its last segment carries an
// extension, or is one of the three tracked extensionless files) or an
// unambiguous directory (it ends in "/"), with no leading "/" or "./", no
// stray whitespace and no "." or ".." segment. New failing code:
// path_spelling_ambiguous.

test("REGRESSION (P0, third reappearance, via spelling): a claude-lead builder on haiku granted the bare word \"scripts\" with an ordinary reviewer must now fail; round one, two and three's checker all printed TEAM_PLAN_PASS for exactly this plan", () => {
  const exploit = plan([
    builder("B1", ["scripts"], { agent: "claude-lead", model: "haiku" }),
    reviewer("R", ["B1"])
  ]);
  const result = checkPlan(exploit);
  assert.equal(result.ok, false, JSON.stringify(result.findings));
  assert.deepEqual(codes(result), ["path_spelling_ambiguous"], JSON.stringify(result.findings));
});

test("an allowed entry that is neither an unambiguous file nor an unambiguous directory is rejected", () => {
  // "/scripts/" belongs here too: it normalizes to the clean "scripts/" (the
  // leading "/" is stripped for comparison purposes), but the plan itself did
  // not WRITE that normal form, so it fails on the same "not written in
  // normal form" branch as "./scripts" and " scripts" (leading space) --
  // spelling it exactly right is the point, not merely being interpretable.
  for (const allowed of [["scripts"], ["./scripts"], ["/scripts/"], [" scripts"], ["src"], ["web/src"], ["tests/release_tools"]]) {
    const result = checkPlan(plan([builder("B1", allowed), reviewer("R", ["B1"])]));
    assert.ok(codes(result).includes("path_spelling_ambiguous"), JSON.stringify({ allowed, findings: result.findings }));
  }
});

test("a directory correctly spelled with its trailing slash, a dotted file, or a tracked extensionless file is accepted", () => {
  for (const allowed of [["scripts/"], ["scripts/one_gate.cjs"], ["web/src/styles.css"], ["package.json", "package-lock.json"], ["Dockerfile"], ["src/migrations/070_x.sql"], ["CLAUDE.md"]]) {
    const result = checkPlan(plan([builder("B1", allowed), reviewer("R", ["B1"])]));
    assert.ok(!codes(result).includes("path_spelling_ambiguous"), JSON.stringify({ allowed, findings: result.findings }));
  }
});

test("the other two tracked extensionless files are recognized too, not only Dockerfile", () => {
  for (const allowed of [["mobile/association-templates/apple-app-site-association"], ["android/gradlew"]]) {
    const result = checkPlan(plan([builder("B1", allowed), reviewer("R", ["B1"])]));
    assert.ok(!codes(result).includes("path_spelling_ambiguous"), JSON.stringify({ allowed, findings: result.findings }));
  }
});

test("a forbidden entry with the same ambiguity also fires", () => {
  const result = checkPlan(plan([builder("B1", ["docs/a.md"], { forbidden: ["scripts"] }), reviewer("R", ["B1"])]));
  assert.ok(codes(result).includes("path_spelling_ambiguous"), JSON.stringify(result.findings));
});

// --- round five: the P0's fourth reappearance, via a dotted real directory -
// riskFamilies(), planAreas() and pathsOverlap() all decide file-vs-directory
// by asking whether a path ends in "/"; path_spelling_ambiguous is the one
// rule standing between a plan and that ambiguity ever reaching them. Round
// one closed it as a listing problem (a named gate script had to be granted
// by name). Round two closed it for a bare whole-tree grant such as
// "scripts" or "web" (the missing-slash class). Round three closed a
// decorated spelling such as "/scripts/" or "./scripts" (the leading-slash /
// stray-decoration class). This is the fourth reappearance of the same hole,
// this time through the OPPOSITE mistake the "is it a file" check was
// making: it asked whether the entry's last segment contains a ".", and
// ".github" contains one -- the leading dot of the directory's own name, not
// an extension. A senior reviewer swept every tracked directory (148 of
// them) through 12 decorated spellings each; ".github" was the only real,
// tracked, extension-free directory name the dot check waved through as if
// it were a file. At head, with this hole open: riskFamilies([".github"]) is
// [] where riskFamilies([".github/"]) is ["ci-gates"], and
// pathsOverlap(".github", ".github/workflows/backend-quality-gates.yml") is
// false -- so a plan granting the bare word ".github" to a claude-lead
// builder on haiku, with an ordinary (non-senior) reviewer, printed
// TEAM_PLAN_PASS and exited 0, handing that builder unreviewed write access
// to every CI workflow, including the step that runs this very gate.
//
// scripts/team_plan_check.cjs closes it by making the working tree the
// primary test, not the dot: an entry that names a directory the checkout
// actually has, written without its trailing "/", now fails
// path_spelling_ambiguous outright -- which subsumes the old
// EXTENSIONLESS_FILES allowlist (Dockerfile, gradlew and
// apple-app-site-association are directories nowhere in this tree, so the
// existence check never fires for them; they still clear the rule the same
// way they always did). The dot heuristic survives only as a fallback for a
// path the tree cannot yet confirm one way or the other -- ordinary for a
// file about to be created -- and a tree read stays fail-open if the
// checkout cannot be read, matching every other spelling check in this file.
// Neither riskFamilies() nor pathsOverlap() themselves change here: they stay
// exactly as quoted above, and it is path_spelling_ambiguous rejecting the
// plan outright, before either of them ever sees the bare entry, that closes
// the hole -- the same shape of fix as round two's bare "scripts".

test("REGRESSION (P0, fourth reappearance, via a dotted real directory): a claude-lead builder on haiku granted the bare word \".github\" with an ordinary reviewer must now fail; rounds one through four's checker all printed TEAM_PLAN_PASS for exactly this plan", () => {
  const exploit = plan([
    builder("B1", [".github"], { agent: "claude-lead", model: "haiku" }),
    reviewer("R", ["B1"])
  ]);
  const result = checkPlan(exploit);
  assert.equal(result.ok, false, JSON.stringify(result.findings));
  assert.deepEqual(codes(result), ["path_spelling_ambiguous"], JSON.stringify(result.findings));
});

test("only the bare, slash-less spelling of .github is ambiguous; the directory itself and a file beneath it stay clean", () => {
  const bare = checkPlan(plan([builder("B1", [".github"]), reviewer("R", ["B1"])]));
  assert.ok(codes(bare).includes("path_spelling_ambiguous"), JSON.stringify(bare.findings));
  for (const allowed of [[".github/"], [".github/workflows/ci.yml"]]) {
    const result = checkPlan(plan([builder("B1", allowed), reviewer("R", ["B1"])]));
    assert.ok(!codes(result).includes("path_spelling_ambiguous"), JSON.stringify({ allowed, findings: result.findings }));
  }
});

// Data-driven, not another hard-coded fixture: read the directories this
// repository's OWN tracked files actually live under, and assert that every
// one of them, spelled bare, is ambiguous. This is the control that would
// have caught ".github" without anyone having to think of it by name, and it
// keeps sweeping for the next one automatically as the tree grows. Every
// PREFIX of every tracked path, not only its first segment: a top-level-only
// sweep proves ".github" but stays blind to a directory nested deeper, such
// as this repository's own ios/App/App.xcodeproj or
// ios/App/App/Assets.xcassets, which carry no dot at all and are ambiguous
// for the plain reason the rule exists -- a real directory named without its
// trailing slash. Derived with `git ls-files -z` (NUL-separated, so a
// committed path containing an escaped/quoted byte -- this repository has
// several non-ASCII filenames under docs/ -- can never smuggle a bogus
// segment into the list the way naive newline/slash splitting of quoted
// `git ls-files` text would).
function trackedDirectories() {
  let result;
  try {
    result = spawnSync("git", ["ls-files", "-z"], { cwd: path.resolve(__dirname, "../.."), encoding: "utf8" });
  } catch (error) {
    return null;
  }
  if (!result || result.status !== 0) return null;
  const dirs = new Set();
  for (const entry of result.stdout.split("\0")) {
    if (!entry) continue;
    const segments = entry.split("/");
    let prefix = "";
    for (let i = 0; i < segments.length - 1; i += 1) {
      prefix = prefix ? `${prefix}/${segments[i]}` : segments[i];
      dirs.add(prefix);
    }
  }
  return [...dirs].sort();
}

test("every real tracked directory, at every depth and spelled bare, is ambiguous -- the sweep that would have caught .github", (t) => {
  const dirs = trackedDirectories();
  if (!dirs) return t.skip("git is not available in this environment");
  assert.ok(dirs.length > 0, "expected at least one tracked directory");
  // Sanity checks that this really walks every depth, not only the top
  // level. ".i18n-regen" is a second real top-level directory this
  // repository already carries whose name also starts with a dot, so this
  // sweep is not only re-proving ".github". ios/App/App.xcodeproj (two
  // levels deep) and ios/App/App/Assets.xcassets (three levels deep) carry
  // no dot at all -- they are caught purely because they are real
  // directories, which a top-level-only version of this sweep would have
  // missed entirely. None of the four names appears in
  // scripts/team_plan_check.cjs or is special-cased here.
  assert.ok(dirs.includes(".github"), JSON.stringify(dirs));
  assert.ok(dirs.includes(".i18n-regen"), JSON.stringify(dirs));
  assert.ok(dirs.includes("ios/App/App.xcodeproj"), JSON.stringify(dirs));
  assert.ok(dirs.includes("ios/App/App/Assets.xcassets"), JSON.stringify(dirs));
  for (const dir of dirs) {
    const result = checkPlan(plan([builder("B1", [dir]), reviewer("R", ["B1"])]));
    assert.ok(codes(result).includes("path_spelling_ambiguous"), JSON.stringify({ dir, findings: result.findings }));
  }
});

test("a real but untracked working-tree directory is ambiguous too, when present -- the tree check reads the checkout, not git's index", (t) => {
  // .release-artifacts is gitignored build output that release tooling
  // (release:preflight and friends) writes into, so `git ls-files` never
  // lists it and the sweep above cannot reach it by construction. It is no
  // less a real directory to the working tree once that tooling has run, and
  // scripts/team_plan_check.cjs reads the actual checkout rather than git's
  // index, so it is exactly as ambiguous bare as any tracked directory.
  // Skipped, not failed, in a checkout that has never produced it -- a fresh
  // clone has no reason to.
  const repoRootDir = path.resolve(__dirname, "../..");
  let isDirectory = false;
  try { isDirectory = fs.statSync(path.join(repoRootDir, ".release-artifacts")).isDirectory(); } catch (error) { isDirectory = false; }
  if (!isDirectory) return t.skip(".release-artifacts is not present in this checkout");
  const result = checkPlan(plan([builder("B1", [".release-artifacts"]), reviewer("R", ["B1"])]));
  assert.ok(codes(result).includes("path_spelling_ambiguous"), JSON.stringify(result.findings));
});

test("two builders holding .github and .github/workflows/ collide, but only through path_spelling_ambiguous -- writer_overlap does not catch this pair", () => {
  // Verified by reading pathsOverlap() as it stands (unchanged by this
  // round's fix): it treats an operand as a directory prefix only when THAT
  // operand ends in "/". Here the right side (".github/workflows/") does, so
  // the check taken is left.startsWith(right) -- ".github".startsWith(
  // ".github/workflows/") -- which is false. writer_overlap is silent on this
  // pair; path_spelling_ambiguous, rejecting B1's bare entry outright, is the
  // only thing that catches it. Senior review + opus is given to B2 up front
  // so the only finding left standing is the one this test is pinning.
  const result = checkPlan(plan([
    builder("B1", [".github"]),
    builder("B2", [".github/workflows/"], { model: "opus" }),
    reviewer("R", ["B1", "B2"], { senior: true })
  ]));
  assert.deepEqual(codes(result), ["path_spelling_ambiguous"], JSON.stringify(result.findings));
});

// The mirror image of the fourth reappearance, reachable from the same one
// character: the rule above makes an existing DIRECTORY ambiguous without
// its trailing slash; this closes an existing FILE being just as ambiguous
// WITH one. pathsOverlap("scripts/team_plan_check.cjs/",
// "scripts/team_plan_check.cjs") is false -- the left operand ends in "/", so
// the check taken is the plain right side starting with the slashed left,
// which it does not -- so before this fix two builders could hold this exact
// control-running file with no writer_overlap between them, one spelled
// plainly and one decorated with a trailing "/". F1 ruled to close this too,
// beyond the original brief; scripts/team_plan_check.cjs is used as one of
// the two fixtures below because it is the file where this matters most: the
// gate's own checker, already classified ci-gates.
test("REGRESSION (P0, mirror of the fourth reappearance): an existing file must not carry a trailing slash either", () => {
  for (const allowed of [["package.json/"], ["scripts/team_plan_check.cjs/"]]) {
    const result = checkPlan(plan([builder("B1", allowed), reviewer("R", ["B1"])]));
    assert.ok(codes(result).includes("path_spelling_ambiguous"), JSON.stringify({ allowed, findings: result.findings }));
  }
  // Plainly spelled, both stay clean of path_spelling_ambiguous specifically.
  // scripts/team_plan_check.cjs is ci-gates risk, so this plan still carries
  // its own senior-review/model findings on the side; irrelevant here, since
  // only the spelling code is asserted.
  for (const allowed of [["package.json"], ["scripts/team_plan_check.cjs"]]) {
    const result = checkPlan(plan([builder("B1", allowed), reviewer("R", ["B1"])]));
    assert.ok(!codes(result).includes("path_spelling_ambiguous"), JSON.stringify({ allowed, findings: result.findings }));
  }
  // Not yet in the tree: a trailing slash on a directory that does not exist
  // yet stays clean too -- the same fail-open fallback as a not-yet-existing
  // file, just approached from the directory side.
  const notYetExisting = checkPlan(plan([builder("B1", ["src/brand_new_dir/"]), reviewer("R", ["B1"])]));
  assert.ok(!codes(notYetExisting).includes("path_spelling_ambiguous"), JSON.stringify(notYetExisting.findings));
});

test("the fix does not over-fire: directories, extensionless tracked files, dotted migration/config files, and a not-yet-existing file all stay clean", () => {
  const clean = [
    ["scripts/"],
    ["scripts/one_gate.cjs"],
    ["web/src/styles.css"],
    ["package.json", "package-lock.json"],
    ["Dockerfile"],
    ["android/gradlew"],
    ["mobile/association-templates/apple-app-site-association"],
    ["src/migrations/070_x.sql"],
    ["CLAUDE.md"],
    // Not yet written to the tree: the directory-existence check finds
    // nothing there and falls back to the dot heuristic, which accepts it as
    // an ordinary future file -- exactly the case the fallback exists for.
    ["src/new_module_that_does_not_exist.ts"]
  ];
  for (const allowed of clean) {
    const result = checkPlan(plan([builder("B1", allowed), reviewer("R", ["B1"])]));
    assert.ok(!codes(result).includes("path_spelling_ambiguous"), JSON.stringify({ allowed, findings: result.findings }));
  }
});

// --- round four: hold every committed plan's exact finding set in place ---
// Three committed plans already pin their expected result: the smoke plan
// above ("the committed smoke plan is valid") and each of the two
// 2026-09-28 orchestration plans below (round one and round two), which
// each pin a lone honest model_underpowered. The other three committed plans
// -- both 2026-09-24/25 brand plans, and the round-three orchestration plan
// -- carry no control at all, so a quiet edit (D2.model: "opus" in the
// round-three plan, or senior: true on the daylight/graphite reviewers)
// would slide past every test in this file without tripping anything. This
// control globs every committed plan and pins its EXACT finding-code set,
// so a change in either direction -- a new finding, a finding that
// disappears, or a plan file added or removed without updating the table --
// fails loudly. checkPlan() is called with no options (no openBranchPaths),
// so it never shells out to git and the result never depends on which
// branches happen to be open on this machine right now.
//
// This does not replace "the committed smoke plan is valid" above (which
// also asserts B1/B3's risk tier, not just the finding set) or the two
// round-one/round-two model_underpowered controls below (which also assert
// result.ok and exist to carry the long honest-record rationale inline); it
// subsumes their finding-set coverage for those three files and extends it
// to the three that had none. Proposing consolidation in a future round
// rather than deleting any of them unilaterally here.
const TEAM_PLAN_DIR = path.resolve(__dirname, "../../docs/team-plans");
const EXPECTED_PLAN_FINDINGS = {
  // No findings when it ran and none today: it grants no scripts/ path, and
  // every builder is either standard-risk or opus where required.
  "2026-09-24-smoke-worker-log-scrub.json": [],
  // B1 (claude-lead) grants scripts/render_brand_assets.cjs plus two
  // browser-proof scripts. Standard risk when this shipped (ci-gates then
  // matched only .github/workflows/); round three widened ci-gates to every
  // file under scripts/, making B1 senior-risk retroactively, and R1 was
  // never senior. Explained in the file's own retroactive_finding_note; the
  // record is deliberately not edited to fabricate a senior review that
  // never happened.
  "2026-09-24-daylight-visual-refresh.json": ["senior_review_missing"],
  // Same root cause as the Daylight plan, same file's own
  // retroactive_finding_note: B1 grants scripts/render_brand_assets.cjs plus
  // three browser-proof scripts, retroactively senior-risk; R1 was ordinary.
  "2026-09-25-graphite-mint-brand.json": ["senior_review_missing"],
  // C2 (sonnet) is granted tests/release_tools/team_plan_check.test.cjs.
  // Round three's own Fix 5 reclassified that exact file as ci-gates,
  // because a CI step now runs it to enforce this gate, so C2 is
  // underpowered. The plan's own retroactive_finding_note explains why the
  // recorded model is not edited to opus after the fact.
  "2026-09-28-orchestration-enforcement-round2.json": ["model_underpowered"],
  // Same file, same cause: D2 (sonnet) is granted
  // tests/release_tools/team_plan_check.test.cjs, which D1 reclassifies as
  // ci-gates within this very round. Documented in the plan's own
  // known_self_violation field ("the rule is right and the assignment was
  // wrong").
  "2026-09-28-orchestration-enforcement-round3.json": ["model_underpowered"],
  // Same file, same cause, from the round that introduced the
  // reclassification itself: B2 (sonnet) is granted
  // tests/release_tools/team_plan_check.test.cjs. Documented in the plan's
  // own retroactive_finding_note.
  "2026-09-28-team-orchestration-enforcement.json": ["model_underpowered"]
};

test("every committed team plan's exact finding set is pinned, in both directions", () => {
  const files = fs.readdirSync(TEAM_PLAN_DIR).filter((name) => name.endsWith(".json")).sort();
  assert.deepEqual(files, Object.keys(EXPECTED_PLAN_FINDINGS).sort(), "docs/team-plans/*.json changed without updating EXPECTED_PLAN_FINDINGS above");
  for (const file of files) {
    const planData = JSON.parse(fs.readFileSync(path.join(TEAM_PLAN_DIR, file), "utf8"));
    const result = checkPlan(planData);
    assert.deepEqual(codes(result), EXPECTED_PLAN_FINDINGS[file], `${file}: ${JSON.stringify(result.findings)}`);
  }
});

// --- CLI coverage: main(), branchPaths() and the printed contract ----------
// Every control above calls checkPlan() in process. Nothing exercised main(),
// branchPaths(), --base, the exit codes, or the literal strings TEAM_PLAN_PASS
// / TEAM_PLAN_FAIL -- and CLAUDE.md's dispatch rule is phrased directly in
// terms of that printed line ("a plan that does not print TEAM_PLAN_PASS is
// not dispatched"). A CI step driving the real binary over a committed plan
// was tried and rejected: the open branches a plan names get deleted once
// they merge, so a step that resolves them from open_branches would go
// permanently red even at fetch-depth: 0 -- and because it would depend on a
// third party's branch tip at CI time rather than a fixture this repository
// controls, an unrelated push to that branch could turn this repository's
// PRs red on its own. So this lives here instead, in the file the "Team
// work-plan coordination gate" CI
// step already runs, driving scripts/team_plan_check.cjs as a real child
// process against a throwaway repo each test creates and destroys itself:
// no write inside this repository, no network, no origin, no dependency on
// this machine's branches. Skipped entirely if git is not on PATH.
const PLAN_CHECK_CLI = path.resolve(__dirname, "../../scripts/team_plan_check.cjs");
const GIT_AVAILABLE = (() => {
  try { return spawnSync("git", ["--version"]).status === 0; } catch { return false; }
})();

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "team-plan-cli-"));
}

// One commit on a "trunk" branch (named explicitly via symbolic-ref before the
// first commit, so this never depends on the local git config's default
// branch name), then one more commit on a second branch "feature-x" that adds
// a file trunk never had. Real local refs, no origin, no remote.
function makeBranchFixtureRepo() {
  const dir = makeTempDir();
  const git = (...args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-q");
  git("symbolic-ref", "HEAD", "refs/heads/trunk");
  git("config", "user.email", "team-plan-cli-test@example.com");
  git("config", "user.name", "Team Plan CLI Test");
  fs.mkdirSync(path.join(dir, "docs"), { recursive: true });
  fs.writeFileSync(path.join(dir, "docs", "a.md"), "base\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  git("checkout", "-q", "-b", "feature-x");
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "other_module.ts"), "export const x = 1;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "feature");
  return dir;
}

function runCli(dir, args) {
  return spawnSync(process.execPath, [PLAN_CHECK_CLI, ...args], { cwd: dir, encoding: "utf8" });
}

function lines(text) {
  return String(text || "").split(/\r?\n/);
}

test("the CLI binary prints exactly TEAM_PLAN_PASS and exits 0 for a clean plan", (t) => {
  if (!GIT_AVAILABLE) return t.skip("git is not available in this environment");
  const dir = makeTempDir();
  try {
    const clean = plan([builder("B1", ["docs/a.md"]), reviewer("R1", ["B1"])]);
    fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify(clean));
    const result = runCli(dir, ["plan.json"]);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(lines(result.stdout).includes("TEAM_PLAN_PASS"), result.stdout);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the CLI binary prints TEAM_PLAN_FAIL, exits 1, and names the finding for a dirty plan", (t) => {
  if (!GIT_AVAILABLE) return t.skip("git is not available in this environment");
  const dir = makeTempDir();
  try {
    const dirty = plan([builder("B1", ["docs/a.md"]), builder("B2", ["docs/a.md"]), reviewer("R1", ["B1", "B2"])]);
    fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify(dirty));
    const result = runCli(dir, ["plan.json"]);
    assert.equal(result.status, 1, result.stderr);
    assert.ok(lines(result.stdout).includes("TEAM_PLAN_FAIL"), result.stdout);
    assert.ok(lines(result.stdout).some((line) => line.startsWith("TEAM_PLAN_FINDING writer_overlap ")), result.stdout);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the CLI binary exits 2 with a usage line when no plan argument is given", (t) => {
  if (!GIT_AVAILABLE) return t.skip("git is not available in this environment");
  const dir = makeTempDir();
  try {
    const result = runCli(dir, []);
    assert.equal(result.status, 2, result.stderr);
    assert.ok(result.stderr.includes("usage: node scripts/team_plan_check.cjs"), result.stderr);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the CLI binary's --base and open_branches resolve two real local branches through branchPaths()", (t) => {
  if (!GIT_AVAILABLE) return t.skip("git is not available in this environment");
  const dir = makeBranchFixtureRepo();
  try {
    // feature-x really added src/other_module.ts over trunk; granting that
    // exact path proves branchPaths() shelled out to git and parsed a real
    // diff, not merely that the branch name resolved.
    const overlapping = plan([builder("B1", ["src/other_module.ts"]), reviewer("R1", ["B1"])], { open_branches: ["feature-x"] });
    fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify(overlapping));
    const result = runCli(dir, ["plan.json", "--base", "trunk"]);
    assert.equal(result.status, 1, result.stderr);
    assert.ok(lines(result.stdout).includes("TEAM_PLAN_FAIL"), result.stdout);
    assert.ok(lines(result.stdout).some((line) => line.startsWith("TEAM_PLAN_FINDING open_work_overlap ") && line.includes("feature-x")), result.stdout);
    assert.ok(result.stdout.includes('"open_branches_checked":1'), result.stdout);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the CLI binary reports open_branch_unreadable and exits 1 for a branch that does not exist", (t) => {
  if (!GIT_AVAILABLE) return t.skip("git is not available in this environment");
  const dir = makeBranchFixtureRepo();
  try {
    const bogus = plan([builder("B1", ["docs/a.md"]), reviewer("R1", ["B1"])], { open_branches: ["totally-bogus-branch-name-xyz"] });
    fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify(bogus));
    const result = runCli(dir, ["plan.json", "--base", "trunk"]);
    assert.equal(result.status, 1, result.stdout);
    assert.ok(result.stderr.includes("open_branch_unreadable"), result.stderr);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
