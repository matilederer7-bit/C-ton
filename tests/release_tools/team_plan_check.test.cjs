const test = require("node:test");
const assert = require("node:assert/strict");
const { checkPlan, pathsOverlap, riskFamilies, planAreas } = require("../../scripts/team_plan_check.cjs");

function plan(assignments, extra = {}) {
  return { task: "example outcome", assignments, ...extra };
}
const builder = (id, allowed, extra = {}) => ({ id, agent: "claude-subagent", role: "builder", scope: `scope ${id}`, allowed, forbidden: [], depends_on: [], dod: ["done"], model: "sonnet", ...extra });
const reviewer = (id, reviews, extra = {}) => ({ id, agent: "codex", role: "reviewer", scope: `review ${id}`, reviews, depends_on: [], dod: ["verdict"], model: "opus", ...extra });
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
  assert.ok(riskFamilies(["scripts/agent_readonly_bash_guard.cjs"]).includes("ci-gates"));
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
  for (const agent of ["codex", "chatgpt", "cloud-manager"]) {
    const result = checkPlan(plan([builder("B1", ["docs/a.md"], { agent, model: "n/a" }), reviewer("R", ["B1"], { agent: "claude-subagent" })]));
    assert.ok(!codes(result).includes("model_not_applicable_misused"), agent);
    assert.ok(!codes(result).includes("model_invalid"), agent);
  }
  for (const agent of ["claude-lead", "claude-subagent"]) {
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

test("the committed round-one orchestration plan produces no finding besides the pre-existing open_work_overlap", () => {
  // this plan predates plan.accepted_overlaps; the lead may update it later.
  // do not hard-code how many open_work_overlap findings it produces here.
  const planData = require("../../docs/team-plans/2026-09-28-team-orchestration-enforcement.json");
  const result = checkPlan(planData);
  const other = codes(result).filter((code) => code !== "open_work_overlap");
  assert.deepEqual(other, [], JSON.stringify(result.findings));
});

test("the committed round-two orchestration plan is fully valid", () => {
  const planData = require("../../docs/team-plans/2026-09-28-orchestration-enforcement-round2.json");
  const result = checkPlan(planData);
  assert.equal(result.ok, true, JSON.stringify(result.findings));
});
