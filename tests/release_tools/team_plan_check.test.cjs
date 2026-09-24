const test = require("node:test");
const assert = require("node:assert/strict");
const { checkPlan, pathsOverlap, riskFamilies } = require("../../scripts/team_plan_check.cjs");

function plan(assignments, extra = {}) {
  return { task: "example outcome", assignments, ...extra };
}
const builder = (id, allowed, extra = {}) => ({ id, agent: "claude-subagent", role: "builder", scope: `scope ${id}`, allowed, forbidden: [], depends_on: [], dod: ["done"], ...extra });
const reviewer = (id, reviews, extra = {}) => ({ id, agent: "codex", role: "reviewer", scope: `review ${id}`, reviews, depends_on: [], dod: ["verdict"], ...extra });
const codes = (result) => result.findings.map((finding) => finding.code).sort();

test("a disjoint two-builder plan with independent review passes", () => {
  const result = checkPlan(plan([builder("B1", ["docs/a.md"]), builder("B2", ["docs/b.md"]), reviewer("R", ["B1", "B2"])]));
  assert.equal(result.ok, true, JSON.stringify(result.findings));
  assert.equal(result.builders.every((item) => item.risk === "standard"), true);
});

test("overlapping writers are rejected, including directory grants", () => {
  const result = checkPlan(plan([builder("B1", ["web/src/ui/"]), builder("B2", ["web/src/ui/button.ts"]), reviewer("R", ["B1", "B2"])]));
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
  for (const path of ["src/migrations/075_x.sql", "src/payment_provider.ts", "src/seller_auth.ts", "src/app.ts", ".github/workflows/x.yml", "src/platform_fee_money.ts"]) {
    const missing = checkPlan(plan([builder("B1", [path]), reviewer("R", ["B1"])]));
    assert.deepEqual(codes(missing), ["senior_review_missing"], path);
    const present = checkPlan(plan([builder("B1", [path]), reviewer("R", ["B1"], { senior: true })]));
    assert.equal(present.ok, true, `${path}: ${JSON.stringify(present.findings)}`);
  }
});

test("a directory grant that could contain high-risk files is treated as senior", () => {
  assert.ok(riskFamilies(["src/"]).includes("money"));
  assert.deepEqual(riskFamilies(["docs/"]), []);
  assert.deepEqual(riskFamilies(["web/src/components.tsx"]), []);
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
});
