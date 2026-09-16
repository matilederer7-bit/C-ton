const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  buildReviewerPrompt,
  buildTaskPacket,
  chooseRoles,
  parseVerdict,
  slug,
  updateCloudStatus,
} = require("../../scripts/cloud_agent_manager.cjs");

const root = path.resolve(__dirname, "../..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

test("cloud role selection prefers Claude builder and independent Codex review when both are available", () => {
  assert.deepEqual(
    chooseRoles({ requestedBuilder: "auto", requestedReviewer: "auto", hasClaude: true, hasCodex: true }),
    { builder: "claude", reviewer: "codex", independentReview: true },
  );
});

test("cloud role selection degrades to bounded same-provider review instead of inventing unavailable credentials", () => {
  assert.deepEqual(
    chooseRoles({ requestedBuilder: "auto", requestedReviewer: "auto", hasClaude: true, hasCodex: false }),
    { builder: "claude", reviewer: "claude", independentReview: false },
  );
  assert.throws(
    () => chooseRoles({ requestedBuilder: "codex", requestedReviewer: "auto", hasClaude: true, hasCodex: false }),
    /OPENAI_API_KEY/,
  );
});

test("cloud task packet keeps standing commercial and production safety invariants", () => {
  const packet = buildTaskPacket({
    task: "Improve seller dashboard",
    scope: "web seller dashboard only",
    doNotTouch: "payments",
    source: "test",
    builder: "claude",
    reviewer: "codex",
  });
  assert.match(packet, /Siton fee remains 8%/);
  assert.match(packet, /There is no distributor commission/);
  assert.match(packet, /REAL MONEY remains 0/);
  assert.match(packet, /Grow remains untouched/);
  assert.match(packet, /Do not commit, push, merge or open a PR/);
  assert.match(packet, /Do not edit PROJECT_STATUS\.md/);
});

test("review contract is read-only and requires machine-parseable verdict", () => {
  const prompt = buildReviewerPrompt({ builder: "claude", reviewer: "codex" });
  assert.match(prompt, /READ-ONLY CONTRACT/);
  assert.match(prompt, /VERDICT=PASS/);
  assert.match(prompt, /VERDICT=CHANGES_REQUIRED/);
  assert.deepEqual(parseVerdict("VERDICT=PASS\nLooks correct."), { verdict: "PASS", needsFix: false });
  assert.deepEqual(parseVerdict("VERDICT=CHANGES_REQUIRED\nBug in x."), { verdict: "CHANGES_REQUIRED", needsFix: true });
  assert.deepEqual(parseVerdict("Looks fine"), { verdict: "INVALID", needsFix: true });
});

test("cloud status owns an isolated status slot", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "siton-cloud-status-"));
  const file = path.join(dir, "PROJECT_STATUS.md");
  fs.writeFileSync(file, "# Status\n\n## STANDING SAFETY AND COMMERCIAL INVARIANTS\n\n- keep\n");
  updateCloudStatus(file, {
    completed: "done",
    tested: "tests pass",
    open: "none",
    percentage: "95%",
    next: "merge",
    branch: "agent/cloud/test",
    builder: "claude",
    reviewer: "codex",
  });
  const first = fs.readFileSync(file, "utf8");
  assert.match(first, /AGENT_STATUS:cloud-manager:START/);
  assert.match(first, /BUILDER: claude/);
  assert.match(first, /REVIEWER: codex/);
  assert.equal((first.match(/AGENT_STATUS:cloud-manager:START/g) || []).length, 1);
  updateCloudStatus(file, {
    completed: "done again",
    tested: "tests pass",
    open: "none",
    percentage: "96%",
    next: "merge",
    branch: "agent/cloud/test2",
    builder: "codex",
    reviewer: "claude",
  });
  const second = fs.readFileSync(file, "utf8");
  assert.equal((second.match(/AGENT_STATUS:cloud-manager:START/g) || []).length, 1);
  assert.match(second, /BRANCH: agent\/cloud\/test2/);
});

test("binding agent rules make cloud manager the sole Git and status lifecycle owner", () => {
  const rules = read("AGENTS.md");
  assert.match(rules, /Cloud-managed exception/);
  assert.match(rules, /the coding agent is the writer only/);
  assert.match(rules, /must not commit, push, merge, open a Pull Request, or edit `PROJECT_STATUS\.md`/);
  assert.match(rules, /at most one automatic bounded fix pass is allowed/);
  assert.match(rules, /auto-merge is forbidden/);
});

test("cloud workflow is owner-gated, serialized, lifecycle-guarded and never auto-merges", () => {
  const workflow = read(".github/workflows/cloud-agent-manager.yml");
  assert.match(workflow, /runs-on: ubuntu-24\.04/);
  assert.match(workflow, /github\.event\.issue\.user\.login == github\.repository_owner/);
  assert.match(workflow, /startsWith\(github\.event\.issue\.title, '\[agent-manager\]'\)/);
  assert.match(workflow, /group: siton-cloud-agent-manager-v1/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1"/);
  assert.match(workflow, /anthropics\/claude-code-action@v1/);
  assert.match(workflow, /openai\/codex-action@v1/);
  assert.match(workflow, /permission-profile: ":read-only"/);
  assert.match(workflow, /Enforce builder lifecycle and control-plane boundary/);
  assert.match(workflow, /Builder committed or changed HEAD/);
  assert.match(workflow, /Enforce fix-pass lifecycle and control-plane boundary/);
  assert.match(workflow, /cloud-agent-manager\\\.yml/);
  assert.match(workflow, /PROJECT_STATUS\\\.md/);
  assert.match(workflow, /Canonical verification after build/);
  assert.match(workflow, /Re-verify after bounded fix/);
  assert.match(workflow, /This is the only automatic fix pass/);
  assert.doesNotMatch(workflow, /gh pr merge|enable_auto_merge|auto-merge: true/);
  assert.match(workflow, /real money: 0/);
  assert.match(workflow, /Grow: untouched/);
});

test("cloud task branch slug helper is deterministic and bounded", () => {
  assert.equal(slug("  Seller UX / cleanup  "), "seller-ux-cleanup");
  assert.ok(slug("x".repeat(200)).length <= 54);
});
