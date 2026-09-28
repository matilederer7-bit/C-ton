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
  const underpowered = checkPlan(plan([builder("B1", ["docs/a.md"]), reviewer("R", ["B1"], { senior: true, model: "sonnet" })]));
  assert.deepEqual(codes(underpowered), ["reviewer_model_underpowered"]);
  const fixed = checkPlan(plan([builder("B1", ["docs/a.md"]), reviewer("R", ["B1"], { senior: true })]));
  assert.equal(fixed.ok, true, JSON.stringify(fixed.findings));
});

test("two or more builders need parallel dispatch unless the plan justifies serializing them", () => {
  const chainPlan = plan([builder("B1", ["docs/a.md"]), builder("B2", ["docs/b.md"], { depends_on: ["B1"] }), reviewer("R", ["B1", "B2"])]);
  const serial = checkPlan(chainPlan);
  assert.deepEqual(codes(serial), ["parallel_dispatch_missing"]);
  assert.equal(serial.parallelBuilders, 1);

  const under40 = checkPlan({ ...chainPlan, serialization_justification: "x".repeat(39) });
  assert.deepEqual(codes(under40), ["parallel_dispatch_missing"]);

  const at40 = checkPlan({ ...chainPlan, serialization_justification: "x".repeat(40) });
  assert.equal(at40.ok, true, JSON.stringify(at40.findings));
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

  const at40 = checkPlan({ ...widePlan, solo_justification: "x".repeat(40) });
  assert.equal(at40.ok, true, JSON.stringify(at40.findings));
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

test("the plan checker's own tooling is classified ci-gates", () => {
  assert.ok(riskFamilies(["scripts/team_plan_check.cjs"]).includes("ci-gates"));
  assert.ok(riskFamilies(["scripts/agent_router.cjs"]).includes("ci-gates"));
  assert.ok(riskFamilies(["scripts/agent_readonly_bash_guard.cjs"]).includes("ci-gates"));
  assert.ok(riskFamilies(["scripts/"]).includes("ci-gates"));
  assert.deepEqual(riskFamilies(["scripts/unrelated_tool.cjs"]), []);
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
  assert.deepEqual(planAreas(["Makefile"]), ["Makefile"]);
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
