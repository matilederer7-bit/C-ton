const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  CONTROL_SCRIPTS,
  PROTECTED_PATH_PATTERN,
  buildReviewerPrompt,
  buildTaskPacket,
  chooseRoles,
  parseVerdict,
  protectedPaths,
  slug,
  statusPaths,
  updateCloudStatus,
} = require("../../scripts/cloud_agent_manager.cjs");

const root = path.resolve(__dirname, "../..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const MANAGER = ".github/workflows/cloud-agent-manager.yml";
const REVIEW = ".github/workflows/cloud-agent-review.yml";

// Top-level jobs of a workflow, keyed by id, each with the text of its block.
function jobsOf(workflow) {
  const body = workflow.slice(workflow.indexOf("\njobs:\n") + "\njobs:\n".length);
  const jobs = {};
  const header = /^  ([A-Za-z0-9_-]+):\n/gm;
  const marks = [...body.matchAll(header)];
  marks.forEach((match, index) => {
    const end = index + 1 < marks.length ? marks[index + 1].index : body.length;
    jobs[match[1]] = body.slice(match.index, end);
  });
  return jobs;
}

// Steps of a job block, each starting at its `- name:` line.
function stepsOf(job) {
  return job.split(/\n      - name: /).slice(1).map((step) => `- name: ${step}`);
}

const stepNamed = (job, name) => {
  const found = stepsOf(job).find((step) => step.startsWith(`- name: ${name}\n`));
  assert.ok(found, `step missing: ${name}`);
  return found;
};

const AGENT_ACTION = /uses: (anthropics\/claude-code-action|openai\/codex-action)@/;

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

test("all cloud Codex actions trust only github-actions[bot]", () => {
  const newline = String.fromCharCode(10);
  const yamlScalar = (raw) => {
    let value = String(raw || "").trim();
    let quote = null;
    let commentIndex = -1;
    for (let index = 0; index < value.length; index += 1) {
      const char = value[index];
      if (quote) {
        if (char === quote && value.charCodeAt(index - 1) !== 92) quote = null;
        continue;
      }
      if (char === '"' || char === "'") {
        quote = char;
        continue;
      }
      if (char === "#") {
        commentIndex = index;
        break;
      }
    }
    if (commentIndex >= 0) value = value.slice(0, commentIndex).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    return value.trim();
  };

  const actionInputs = (step) => {
    const lines = step.split(newline);
    const withIndex = lines.findIndex((line) => line.trim().split("#", 1)[0].trim() === "with:");
    assert.notEqual(withIndex, -1, "Codex action step must have a with: mapping");
    const withIndent = lines[withIndex].length - lines[withIndex].trimStart().length;
    const inputs = new Map();
    for (let index = withIndex + 1; index < lines.length; index += 1) {
      const line = lines[index];
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const indent = line.length - line.trimStart().length;
      if (indent <= withIndent) break;
      if (indent !== withIndent + 2) continue;
      const colon = trimmed.indexOf(":");
      if (colon <= 0) continue;
      const key = trimmed.slice(0, colon).trim();
      // A duplicate key is invalid for GitHub Actions and hides which value wins.
      assert.ok(!inputs.has(key), `duplicate action input ${key}`);
      inputs.set(key, yamlScalar(trimmed.slice(colon + 1)));
    }
    return inputs;
  };

  const assertNarrowBotTrust = (workflow) => {
    const steps = workflow.split(newline + "      - name: ").slice(1);
    const codexSteps = steps.filter((step) => step.includes("uses: openai/codex-action@v1"));
    assert.ok(codexSteps.length > 0, "expected at least one Codex action step");
    for (const step of codexSteps) {
      const name = step.split(newline, 1)[0];
      const inputs = actionInputs(step);
      assert.equal(
        inputs.get("allow-bot-users"),
        "github-actions[bot]",
        "Codex step is missing the narrow github-actions[bot] input: " + name,
      );
      assert.notEqual(
        String(inputs.get("allow-bots") || "").toLowerCase(),
        "true",
        "Codex step broadly trusts bot actors: " + name,
      );
    }
    return codexSteps.length;
  };

  const managerCount = assertNarrowBotTrust(read(MANAGER));
  const reviewCount = assertNarrowBotTrust(read(REVIEW));
  assert.equal(managerCount + reviewCount, 3, "every current Cloud Manager Codex action must be guarded");

  const envOnly = [
    "header",
    "      - name: Sample",
    "        uses: openai/codex-action@v1",
    "        with:",
    "          openai-api-key: secret",
    "        env:",
    '          allow-bot-users: "github-actions[bot]"',
  ].join(newline);
  assert.throws(() => assertNarrowBotTrust(envOnly), /missing the narrow github-actions\[bot\] input/);

  // Every YAML spelling of a broad bypass is refused (#135).
  for (const broadValue of ["true # broad bypass", '"true" # broad bypass', "'true' # broad bypass"]) {
    const broad = [
      "header",
      "      - name: Sample",
      "        uses: openai/codex-action@v1",
      "        with:",
      '          allow-bot-users: "github-actions[bot]"',
      `          allow-bots: ${broadValue}`,
    ].join(newline);
    assert.throws(() => assertNarrowBotTrust(broad), /broadly trusts bot actors/, broadValue);
  }
});

test("cloud workflow is owner-gated at intake, serialized, lifecycle-guarded and never auto-merges", () => {
  const workflow = read(".github/workflows/cloud-agent-manager.yml");
  const intake = read(".github/workflows/agent-manager-intake.yml");
  assert.match(workflow, /runs-on: ubuntu-24\.04/);
  assert.match(intake, /github\.event\.issue\.user\.login == github\.repository_owner/);
  assert.match(intake, /startsWith\(github\.event\.issue\.title, '\[agent-manager\]'\)/);
  assert.match(intake, /actions: write/);
  assert.match(intake, /cloud-agent-manager\.yml\/dispatches/);
  assert.match(workflow, /group: siton-cloud-agent-manager-v1/);
  assert.match(workflow, /cancel-in-progress: false/);
  // Least privilege per job. The default token is read-only everywhere;
  // issues: write, the minimum that lets a blocked run still report to the
  // phone, exists only in finalize, where no agent runs. contents stays read
  // so the default token can never push.
  assert.match(workflow, /\npermissions:\n  contents: read\n\n/);
  const jobs = jobsOf(workflow);
  assert.deepEqual(Object.keys(jobs), ["route", "build", "review-1", "fix", "review-2", "finalize"]);
  for (const [id, job] of Object.entries(jobs)) {
    const permissions = /\n    permissions:\n((?:      [a-z-]+: (?:read|write|none)\n)+)/.exec(job);
    assert.ok(permissions, `job ${id} must declare its own permissions`);
    const expected = id === "finalize"
      ? "      contents: read\n      pull-requests: read\n      issues: write\n"
      : id === "route" ? "      contents: read\n" : "      contents: read\n      pull-requests: read\n";
    assert.equal(permissions[1], expected, `permissions of job ${id}`);
  }
  for (const text of [workflow, read(REVIEW)]) {
    assert.doesNotMatch(text, /^\s+(contents|pull-requests|actions|id-token|packages|deployments|statuses|checks): write/m);
    assert.doesNotMatch(text, /secrets: inherit/);
    const checkouts = (text.match(/uses: actions\/checkout@v\d+/g) || []).length;
    assert.ok(checkouts > 0);
    assert.equal((text.match(/persist-credentials: false/g) || []).length, checkouts, "every checkout drops its credentials");
  }
  assert.match(workflow, /SITON_AGENT_GITHUB_TOKEN/);
  assert.match(workflow, /SITON_AGENT_GITHUB_TOKEN is required/);
  assert.match(workflow, /gh auth setup-git/);
  assert.match(workflow, /CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1"/);
  assert.match(workflow, /anthropics\/claude-code-action@v1/);
  assert.match(workflow, /openai\/codex-action@v1/);
  assert.match(read(REVIEW), /permission-profile: ":read-only"/);
  assert.doesNotMatch(read(REVIEW), /permission-profile: ":workspace"/);
  assert.match(workflow, /Enforce builder lifecycle and control-plane boundary/);
  assert.match(workflow, /Builder committed or changed HEAD/);
  assert.match(workflow, /Enforce fix-pass lifecycle and control-plane boundary/);
  // The in-job checks use exactly the pattern the control-copy `boundary`
  // command enforces, and it still covers workflows and the status file.
  const inline = [...workflow.matchAll(/\n\s+protected='([^'\n]+)'\n/g)].map((match) => match[1]);
  assert.equal(inline.length, 2);
  for (const pattern of inline) assert.equal(pattern, PROTECTED_PATH_PATTERN);
  assert.match(PROTECTED_PATH_PATTERN, /\^\(\\\.github\//);
  assert.match(PROTECTED_PATH_PATTERN, /PROJECT_STATUS\\\.md\$/);
  assert.match(workflow, /Canonical verification after build/);
  assert.match(workflow, /Re-verify after bounded fix/);
  assert.match(workflow, /This is the only automatic fix pass/);
  assert.doesNotMatch(workflow, /gh pr merge|enable_auto_merge|auto-merge: true/);
  assert.match(workflow, /real money: 0/);
  assert.match(workflow, /Grow: untouched/);
});

test("phone intake is a fresh owner-only issue trigger that dispatches the manager", () => {
  const intake = read(".github/workflows/agent-manager-intake.yml");
  assert.match(intake, /issues:\n    types: \[opened, reopened, labeled\]/);
  assert.match(intake, /github\.event\.label\.name == 'agent-manager-run'/);
  assert.match(intake, /workflow-dispatch payload/);
  assert.match(intake, /actions\/workflows\/cloud-agent-manager\.yml\/dispatches/);
  assert.match(intake, /ref: 'master'/);
  assert.match(intake, /builder: 'auto'/);
  assert.match(intake, /reviewer: 'auto'/);
});

test("manager records telemetry even when a managed run fails before PR creation", () => {
  const workflow = read(".github/workflows/cloud-agent-manager.yml");
  assert.match(workflow, /name: Record agent-run telemetry\n        if: always\(\)/);
  assert.match(workflow, /SITON_VERIFICATION: \$\{\{ job\.status \}\}/);
  assert.match(workflow, /name: Upload agent-run telemetry\n        if: always\(\)/);
  assert.match(workflow, /if-no-files-found: warn/);
  // Telemetry and the issue report live in finalize, which runs after any
  // outcome of any earlier job, and fails itself (so job.status is failure)
  // before any lifecycle step when an upstream job did not succeed.
  const finalize = jobsOf(workflow).finalize;
  assert.match(finalize, /\n    needs: \[route, build, review-1, fix, review-2\]\n/);
  assert.match(finalize, /\n    if: always\(\) && github\.event_name == 'workflow_dispatch'\n/);
  const steps = stepsOf(finalize);
  const names = steps.map((step) => step.split("\n")[0].slice("- name: ".length));
  const gate = names.indexOf("Require every upstream job");
  assert.ok(gate > 0 && names.indexOf("Collect upstream job results") === gate - 1);
  for (const name of ["Record agent-run telemetry", "Upload agent-run telemetry", "Report result to source issue", "Download agent execution records"]) {
    assert.ok(names.indexOf(name) > gate, name);
    assert.match(steps[names.indexOf(name)], /\n        if: always\(\)\n/, `${name} must run after an upstream failure`);
  }
  // The gate is the only thing between a failed or skipped review and a
  // push: it may not be softened, and no lifecycle step may opt out of it.
  assert.doesNotMatch(steps[gate], /continue-on-error|\n        if:/, "the upstream gate must always run and always fail the job");
  assert.doesNotMatch(finalize, /\n    continue-on-error/, "finalize itself must not swallow the gate");
  for (const name of ["Download final task patch", "Apply final reviewed patch and enforce control-plane boundary", "Update project status and final diff checks", "Commit and push managed branch", "Open Pull Request"]) {
    const index = names.indexOf(name);
    assert.ok(index > gate, `${name} must come after the upstream gate`);
    assert.doesNotMatch(steps[index], /continue-on-error/, `${name} must not continue on error`);
    const condition = /\n        if: (.*)\n/.exec(steps[index]);
    if (condition) assert.doesNotMatch(condition[1], /always\(\)|failure\(\)|cancelled\(\)/, `${name} must not run after an upstream failure`);
  }
  // Every step after the gate that is not explicitly always() is a lifecycle
  // step; count them so a reformat that hides steps fails instead of passing.
  assert.ok(steps.length - gate > 8, `expected the lifecycle steps after the gate, found ${steps.length - gate}`);
  const collect = stepNamed(finalize, "Collect upstream job results");
  for (const job of ["route", "build", "review-1", "fix", "review-2"]) assert.match(collect, new RegExp(`\\$\\{\\{ needs\\.${job}\\.result \\}\\}`));
  assert.match(collect, /\[ "\$REVIEW1" = success \] \|\| status=failure/);
  assert.match(collect, /\{ \[ "\$FIX" = success \] && \[ "\$REVIEW2" = success \]; \} \|\| status=failure/);
  assert.doesNotMatch(collect, /set -e/, "the collector must always publish its result");
});

test("cloud task branch slug helper is deterministic and bounded", () => {
  assert.equal(slug("  Seller UX / cleanup  "), "seller-ux-cleanup");
  assert.ok(slug("x".repeat(200)).length <= 54);
});

test("engineering operating system has routing, parallel analysis and telemetry contracts", () => {
  const workflow = read(".github/workflows/cloud-agent-manager.yml");
  const swarm = read(".github/workflows/cloud-analysis-swarm.yml");
  const operatingSystem = read("docs/ENGINEERING_OPERATING_SYSTEM.md");
  assert.match(workflow, /scripts\/agent_router\.cjs route/);
  assert.match(workflow, /effort: \$\{\{ needs\.route\.outputs\.builder_effort \}\}/);
  assert.match(workflow, /model: \$\{\{ needs\.route\.outputs\.codex_model \}\}/);
  assert.match(workflow, /builder_effort: \$\{\{ steps\.roles\.outputs\.builder_effort \}\}/);
  assert.match(workflow, /codex_model: \$\{\{ steps\.roles\.outputs\.codex_model \}\}/);
  assert.match(workflow, /agent-run-metric\.json/);
  assert.match(workflow, /actions\/upload-artifact@v\d+/);
  assert.match(workflow, /Run required parallel analysis swarm/);
  assert.match(workflow, /gh workflow run cloud-analysis-swarm\.yml/);
  assert.match(workflow, /gh run watch/);
  assert.match(workflow, /swarm-synthesis/);
  assert.match(swarm, /max-parallel: 4/);
  assert.match(swarm, /gpt-6\\.luna/);
  assert.match(swarm, /gpt-5\.6-terra/);
  assert.match(swarm, /gpt-5\.6-sol/);
  assert.match(swarm, /architecture/);
  assert.match(swarm, /security/);
  assert.match(swarm, /source-of-truth/);
  assert.match(swarm, /Head reviewer synthesis/);
  assert.doesNotMatch(swarm, /git push|gh pr merge|gh pr create/);
  assert.match(operatingSystem, /GitHub is the shared control plane/);
  assert.match(operatingSystem, /siton\.agent-run\.v1/);
});

const { verifyModelAccess } = require('../../scripts/agent_model_access.cjs');

test('Apex cannot be silently skipped by explicit provider role overrides', () => {
  assert.throws(() => chooseRoles({ requestedBuilder: 'claude', requestedReviewer: 'none', hasClaude: true, hasCodex: true, tier: 'apex' }), /skip Astra/);
  assert.throws(() => chooseRoles({ requestedBuilder: 'claude', requestedReviewer: 'claude', hasClaude: true, hasCodex: true, tier: 'apex' }), /skip Astra/);
  assert.equal(chooseRoles({ requestedBuilder: 'claude', requestedReviewer: 'codex', hasClaude: true, hasCodex: true, tier: 'apex' }).reviewer, 'codex');
});

test('model access preflight confirms metadata without claiming inference and never downgrades', async () => {
  const model = 'gpt-6-astra';
  const result = await verifyModelAccess({ apiKey: 'test-only', model, fetchImpl: async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/models/gpt-6-astra');
    assert.equal(options.headers.Authorization, 'Bearer test-only');
    return { ok: true, json: async () => ({ id: model }) };
  } });
  assert.equal(result.inferenceVerified, false);
  for (const status of [401, 403, 404, 429]) {
    await assert.rejects(verifyModelAccess({ apiKey: 'test-only', model, fetchImpl: async () => ({ ok: false, status }) }), /No downgrade/);
  }
  await assert.rejects(verifyModelAccess({ model }), /OPENAI_API_KEY/);
  await assert.rejects(verifyModelAccess({ apiKey: 'test-only', model: 'invented' }), /Unknown/);
  await assert.rejects(verifyModelAccess({ apiKey: 'test-only', model, fetchImpl: async () => ({ ok: true, json: async () => ({ id: 'gpt-5.6-sol' }) }) }), /did not confirm/);
});

// Workflow wiring guards cover the inputs that previously never reached the router.
test('manager and swarm wire Apex end to end without raising all analyst tiers', () => {
  const workflow = read('.github/workflows/cloud-agent-manager.yml');
  const swarm = read('.github/workflows/cloud-analysis-swarm.yml');
  const form = read('.github/ISSUE_TEMPLATE/agent-manager.yml');
  const intake = read('.github/workflows/agent-manager-intake.yml');
  assert.match(intake, /pick\('Risk', 'normal'\)/);
  assert.match(intake, /pick\('Compute tier', 'auto'\)/);
  assert.match(intake, /pick\('Task type', 'auto'\)/);
  assert.match(intake, /\[source-issue:/);
  assert.match(workflow, /SITON_ISSUE_BODY: \$\{\{ inputs\.task \}\}/);
  assert.match(workflow, /export SITON_MODEL_TIER="\$tier"/);
  assert.match(workflow, /SITON_CODEX_MODEL: \$\{\{ steps\.roles\.outputs\.codex_model \}\}/);
  assert.match(workflow, /SITON_CODEX_MODEL: \$\{\{ needs\.route\.outputs\.codex_model \}\}/);
  assert.match(workflow, /apex_reason: \$\{\{ steps\.roles\.outputs\.apex_reason \}\}/);
  assert.match(workflow, /SITON_APEX_REASON: \$\{\{ needs\.route\.outputs\.apex_reason \}\}/);
  assert.match(workflow, /node scripts\/agent_model_access\.cjs/);
  assert.match(form, /label: Apex reason/);
  assert.match(form, /label: Apex evidence/);
  assert.match(swarm, /model: \$\{\{ steps\.head_route\.outputs\.codex_model \}\}/);
  assert.match(swarm, /'apex' \|\| 'senior'/);
  assert.match(swarm, /lane: tests\s+model: gpt-6\\.luna/);
  assert.match(swarm, /lane: security\s+model: gpt-5\.6-sol/);
});

test("a credential-blocked run still reaches the owner on the source issue", () => {
  const workflow = read(".github/workflows/cloud-agent-manager.yml");
  const intake = read(".github/workflows/agent-manager-intake.yml");
  // The reporting path must not depend on the one secret most likely missing.
  assert.match(workflow, /GH_TOKEN: \$\{\{ secrets\.SITON_AGENT_GITHUB_TOKEN \|\| github\.token \}\}/);
  assert.match(workflow, /siton-credential-blocker\.md/);
  assert.match(workflow, /BLOCKER REQUIRES OWNER ACTION/);
  assert.match(workflow, /settings\/secrets\/actions/);
  // The blocker text is recorded by a step that never fails, before the step
  // that exits on the blocker, and reaches the finalize report as a route
  // job output.
  const route = jobsOf(workflow).route;
  const names = stepsOf(route).map((step) => step.split("\n")[0]);
  assert.ok(names.indexOf("- name: Record cloud credential state") < names.indexOf("- name: Resolve cloud credentials and roles"));
  assert.doesNotMatch(stepNamed(route, "Record cloud credential state"), /exit 1/);
  assert.match(route, /credential_state: \$\{\{ steps\.credentials\.outputs\.state_b64 \}\}/);
  assert.match(stepNamed(jobsOf(workflow).finalize, "Report result to source issue"), /CREDENTIAL_STATE: \$\{\{ needs\.route\.outputs\.credential_state \}\}/);
  assert.match(intake, /permissions:\n  contents: read\n  issues: write\n  actions: write/);
  assert.match(intake, /Acknowledge on the source issue/);
  assert.match(intake, /gh issue comment/);
});

test("exactly one Claude credential is handed to claude-code-action", () => {
  const workflow = read(".github/workflows/cloud-agent-manager.yml");
  const apiKeyBindings = workflow.match(/anthropic_api_key: [^\n]*/g) || [];
  const oauthBindings = workflow.match(/claude_code_oauth_token: [^\n]*/g) || [];
  assert.equal(apiKeyBindings.length, 4);
  assert.equal(oauthBindings.length, 4);
  for (const binding of apiKeyBindings) assert.match(binding, /claude_auth == 'api' && secrets\.ANTHROPIC_API_KEY \|\| ''/);
  for (const binding of oauthBindings) assert.match(binding, /claude_auth == 'oauth' && secrets\.CLAUDE_CODE_OAUTH_TOKEN \|\| ''/);
  assert.match(workflow, /claude_auth=api/);
  assert.match(workflow, /claude_auth=oauth/);
  // The 4 manager bindings are the builder, the fix pass and the two review
  // calls; the review job itself binds its passed-in credential the same way.
  const review = read(REVIEW);
  assert.deepEqual(review.match(/anthropic_api_key: [^\n]*/g), ["anthropic_api_key: ${{ inputs.claude_auth == 'api' && secrets.anthropic_api_key || '' }}"]);
  assert.deepEqual(review.match(/claude_code_oauth_token: [^\n]*/g), ["claude_code_oauth_token: ${{ inputs.claude_auth == 'oauth' && secrets.claude_code_oauth_token || '' }}"]);
});

test("Claude builder can test and inspect but can never take the Git lifecycle", () => {
  const workflow = read(".github/workflows/cloud-agent-manager.yml");
  const builderArgs = workflow.match(/--max-turns 24[\s\S]*?--disallowedTools[^\n]*/);
  assert.ok(builderArgs, "Claude builder must declare its tool boundary explicitly");
  assert.match(builderArgs[0], /"Bash\(npm test:\*\)"/);
  assert.match(builderArgs[0], /"Bash\(git diff:\*\)"/);
  assert.match(builderArgs[0], /Edit MultiEdit Write/);
  // Git write verbs and the GitHub CLI stay with the manager.
  for (const forbidden of ["Bash(git commit", "Bash(git push", "Bash(gh:", "Bash(git checkout", "Bash(*)"]) {
    assert.ok(!builderArgs[0].includes(forbidden), `builder must not be granted ${forbidden}`);
  }
  // Both Claude review passes stay read-only at the tool layer, not only by
  // diff comparison: they run the single Claude review step of the review
  // workflow, called once per pass; no Claude reviewer lives in the manager.
  const reviewerGuards = read(REVIEW).match(/--disallowedTools Write Edit MultiEdit NotebookEdit WebSearch WebFetch/g) || [];
  assert.equal(reviewerGuards.length, 1);
  assert.equal((workflow.match(/uses: \.\/\.github\/workflows\/cloud-agent-review\.yml/g) || []).length, 2);
  assert.doesNotMatch(workflow, /--disallowedTools Write Edit/);
});


const firstLine = (step) => step.split("\n")[0];

// Black-Sky E3: a builder can write its tree's .git/hooks, .git/config and
// .gitattributes filters, and on its own runner much more (sudo, GITHUB_PATH,
// tool cache). The lifecycle token therefore never exists on a runner where an
// agent ran. The trusted route job checks presence only; lifecycle use happens
// in finalize on a fresh runner after the patch was applied there as data.
test("the lifecycle token never reaches an agent runner; route only checks presence and finalize owns lifecycle use", () => {
  const workflow = read(MANAGER);
  const jobs = jobsOf(workflow);
  for (const [id, job] of Object.entries(jobs)) {
    const runsAgent = AGENT_ACTION.test(job) || /uses: \.\/\.github\/workflows\/cloud-agent-review\.yml/.test(job);
    if (runsAgent) assert.doesNotMatch(job, /SITON_AGENT_GITHUB_TOKEN/, `job ${id} runs an agent and must never receive the lifecycle token`);
  }
  assert.doesNotMatch(read(REVIEW), /SITON_AGENT_GITHUB_TOKEN/);
  assert.deepEqual(Object.keys(jobs).filter((id) => /SITON_AGENT_GITHUB_TOKEN/.test(jobs[id])), ["route", "finalize"]);
  // route only checks presence, in a step that runs no agent and no git.
  const routeTokenSteps = stepsOf(jobs.route).filter((step) => /secrets\.SITON_AGENT_GITHUB_TOKEN/.test(step));
  assert.deepEqual(routeTokenSteps.map(firstLine), ["- name: Record cloud credential state"]);
  assert.doesNotMatch(jobs.route, AGENT_ACTION);

  const finalize = jobs.finalize;
  assert.doesNotMatch(finalize, AGENT_ACTION);
  assert.doesNotMatch(finalize, /\bnpm\b|\bnpx\b/, "finalize installs and runs nothing from the task tree");
  const checkout = stepNamed(finalize, "Checkout canonical master at the task base");
  assert.match(checkout, /ref: \$\{\{ needs\.route\.outputs\.base_sha \|\| github\.sha \}\}/);
  assert.match(checkout, /persist-credentials: false/);
  const apply = stepNamed(finalize, "Apply final reviewed patch and enforce control-plane boundary");
  assert.doesNotMatch(apply, /GH_TOKEN|SITON_AGENT_GITHUB_TOKEN|secrets\./, "the patch is applied without any credential");
  assert.match(apply, /safe_git\(\) \{ git -c core\.hooksPath=\/dev\/null -c core\.fsmonitor=false -c diff\.external= "\$@"; \}/);
  assert.match(apply, /safe_git apply --index --binary "\$patch"/);
  assert.doesNotMatch(finalize + jobs.fix, /safe_git apply --binary/, "every patch apply must use --index, as the review job does");
  const commit = stepNamed(finalize, "Commit and push managed branch");
  assert.match(commit, /test "\$\(git rev-parse HEAD\)" = "\$BASE_SHA"/);
  assert.match(commit, /git -c core\.hooksPath=\/dev\/null -c core\.fsmonitor=false add -A/);
  assert.match(commit, /git -c core\.hooksPath=\/dev\/null commit --no-verify/);
  assert.match(commit, /git -c core\.hooksPath=\/dev\/null push --no-verify/);
  const names = stepsOf(finalize).map(firstLine);
  const firstTokenStep = stepsOf(finalize).findIndex((step) => /SITON_AGENT_GITHUB_TOKEN/.test(step) && !/if: always\(\)/.test(step));
  assert.equal(names[firstTokenStep], "- name: Commit and push managed branch");
  assert.ok(names.indexOf("- name: Apply final reviewed patch and enforce control-plane boundary") < firstTokenStep);
  // No token-bearing step runs a git write verb without the hook-free prefix.
  for (const step of stepsOf(finalize)) {
    if (!/SITON_AGENT_GITHUB_TOKEN/.test(step)) continue;
    assert.doesNotMatch(step, /^\s*git (add|commit|push|apply)\b/m, `token-bearing step runs hooked git: ${firstLine(step)}`);
  }
  // Builder runners export the patch as data, credential-free and hook-free.
  for (const [id, name] of [["build", "Export task patch without credentials"], ["fix", "Export fixed patch without credentials"]]) {
    const step = stepNamed(jobs[id], name);
    assert.doesNotMatch(step, /GH_TOKEN|SITON_AGENT_GITHUB_TOKEN|secrets\./, `${name} must run without any credential`);
    assert.match(step, /core\.hooksPath=\/dev\/null/);
    assert.match(step, /core\.fsmonitor=false/);
    assert.match(step, /--no-ext-diff --no-textconv/);
  }
  assert.match(workflow, /gh pr create --repo "\$GITHUB_REPOSITORY"/);
});

test("each Claude/Codex review runs in its own job on a fresh runner, separate from every builder job", () => {
  const manager = read(MANAGER);
  const jobs = jobsOf(manager);
  const review = read(REVIEW);
  assert.match(review, /\non:\n  workflow_call:\n/);
  assert.doesNotMatch(review, /\n  (workflow_dispatch|push|pull_request|pull_request_target|issues|schedule):/);
  const reviewJobs = jobsOf(review);
  assert.deepEqual(Object.keys(reviewJobs), ["review"]);
  assert.match(reviewJobs.review, /\n    runs-on: ubuntu-24\.04\n/);
  const reviewAgents = stepsOf(reviewJobs.review).filter((step) => AGENT_ACTION.test(step));
  assert.deepEqual(reviewAgents.map(firstLine), ["- name: Codex review", "- name: Claude review"]);
  assert.match(reviewAgents[0], /\n        if: inputs\.reviewer == 'codex'\n/);
  assert.match(reviewAgents[0], /permission-profile: ":read-only"/);
  assert.match(reviewAgents[1], /\n        if: inputs\.reviewer == 'claude'\n/);
  assert.match(reviewAgents[1], /--allowedTools Read Grep Glob "Bash\(git diff:\*\)" "Bash\(git status:\*\)" "Bash\(git log:\*\)" "Bash\(git show:\*\)"\n/);
  assert.doesNotMatch(reviewJobs.review, /Bash\((node|npm|npx)|\bnpm (ci|install|run|test)\b|permission-profile: ":workspace"/);

  // The only agents in the manager are the builder and the one fix pass.
  const agentSteps = Object.fromEntries(Object.entries(jobs).map(([id, job]) => [id, stepsOf(job).filter((step) => AGENT_ACTION.test(step)).map(firstLine)]));
  assert.deepEqual(agentSteps, {
    route: [],
    build: ["- name: Claude builder", "- name: Codex builder"],
    "review-1": [],
    fix: ["- name: Claude bounded fix pass", "- name: Codex bounded fix pass"],
    "review-2": [],
    finalize: [],
  });
  for (const id of ["build", "fix"]) {
    assert.doesNotMatch(jobs[id], /permission-profile: ":read-only"|--setting-sources=|cloud_agent_manager\.cjs"? review-prompt|claude_reviewer_model/, `${id} must not host a review`);
    assert.match(jobs[id], /\n    services:\n      postgres:\n/, `${id} runs canonical verification on Postgres`);
    assert.match(jobs[id], /node scripts\/siton_verify\.cjs/);
  }
  for (const id of ["route", "build", "fix", "finalize"]) assert.match(jobs[id], /\n    runs-on: ubuntu-24\.04\n/, id);
  for (const id of ["review-1", "review-2"]) {
    assert.match(jobs[id], /\n    uses: \.\/\.github\/workflows\/cloud-agent-review\.yml\n/);
    assert.doesNotMatch(jobs[id], /\n    (runs-on|steps):/);
  }
  assert.match(jobs["review-1"], /\n    needs: \[route, build\]\n    if: needs\.route\.outputs\.reviewer != 'none'\n/);
  assert.match(jobs["review-1"], /\n      pass: "1"\n      patch_artifact: siton-patch-1\n/);
  // At most one bounded fix pass, gated on the first verdict, then re-reviewed.
  assert.match(jobs.fix, /\n    needs: \[route, build, review-1\]\n    if: needs\.review-1\.outputs\.needs_fix == 'true'\n/);
  assert.match(jobs["review-2"], /\n    needs: \[route, review-1, fix\]\n    if: needs\.review-1\.outputs\.needs_fix == 'true'\n/);
  assert.match(jobs["review-2"], /\n      pass: "2"\n      patch_artifact: siton-patch-2\n/);
  assert.equal((manager.match(/This is the only automatic fix pass/g) || []).length, 1);
  assert.doesNotMatch(manager, /needs\.review-2\.outputs\.needs_fix == 'true'/, "no second fix pass");
  // Routing values come from the route job, never from a job an agent ran in.
  for (const id of ["build", "fix", "finalize"]) assert.doesNotMatch(jobs[id], /steps\.roles\.outputs/, id);
  assert.doesNotMatch(manager, /needs\.(build|fix)\.outputs\.(?!patch_sha256)/);
});

function assertControlCopy(step) {
  const copy = /\n\s+cp ((?:scripts\/[a-z_]+\.cjs )+)"\$CONTROL\/"\n/.exec(step);
  assert.ok(copy, "control copy command missing");
  assert.deepEqual(copy[1].trim().split(" "), CONTROL_SCRIPTS);
  for (const script of CONTROL_SCRIPTS) {
    for (const [, dependency] of read(script).matchAll(/require\(["']\.\/([^"']+)["']\)/g)) {
      assert.ok(CONTROL_SCRIPTS.includes(`scripts/${dependency}`), `${script} requires ${dependency}, which is not copied`);
    }
  }
  assert.match(step, /chmod -R a-w "\$CONTROL"/);
}

function assertOnlyControlCopiesAfter(steps, from, label) {
  for (const step of steps.slice(from)) {
    assert.doesNotMatch(step, /uses: actions\/setup-node/, `${label}: ${firstLine(step)} reinstalls node after the patch`);
    // Only the shell program is checked; env values are data.
    const at = step.indexOf("\n        run:");
    const program = at === -1 ? "" : step.slice(at);
    assert.doesNotMatch(program, /node (\.\/)?scripts\/|require\(['"]\.\/scripts|\bnpm\b|\bnpx\b/, `${label}: ${firstLine(step)} runs code from the patched tree`);
    for (const [, target] of program.matchAll(/\bnode (?!-)("?[^\s"]+"?)/g)) {
      assert.match(target, /^"\$(CONTROL|RUNNER_TEMP\/control)\//, `${label}: ${firstLine(step)} runs node ${target}`);
    }
  }
}

test("review jobs copy the control scripts before the patch, check its boundary there, and run only those copies after it", () => {
  const steps = stepsOf(jobsOf(read(REVIEW)).review);
  const index = (name) => {
    const found = steps.findIndex((step) => step.startsWith(`- name: ${name}\n`));
    assert.ok(found >= 0, `step missing: ${name}`);
    return found;
  };
  const copy = index("Copy control scripts before the patch");
  const download = index("Download task patch");
  const apply = index("Apply task patch and enforce control-plane boundary");
  assert.ok(index("Checkout canonical master at the task base") < copy && index("Node 22") < copy);
  assert.ok(copy < download && download < apply, "control copies must exist before the patch reaches the runner");
  assertControlCopy(steps[copy]);
  assert.match(steps[index("Checkout canonical master at the task base")], /ref: \$\{\{ inputs\.base_sha \}\}/);
  // The boundary check runs in the review job, from the control copy, on the
  // applied patch, before any reviewer starts.
  const applyStep = steps[apply];
  const applyAt = applyStep.indexOf('safe_git apply --index --binary "$patch"');
  const boundaryAt = applyStep.indexOf('safe_git status --porcelain=v1 -z --untracked-files=all --no-renames | node "$CONTROL/cloud_agent_manager.cjs" boundary');
  assert.ok(applyAt > 0 && boundaryAt > applyAt);
  assert.match(applyStep, /test "\$\(git rev-parse HEAD\)" = "\$BASE_SHA"/);
  assert.ok(apply < index("Codex review") && apply < index("Claude review"));
  assertOnlyControlCopiesAfter(steps, apply, "review");
  // Reviewer prompt and packet come from the control copy and trusted inputs,
  // not from anything the builder exported.
  const prepare = steps[index("Prepare read-only review")];
  assert.match(prepare, /node "\$CONTROL\/cloud_agent_manager\.cjs" packet \.siton-cloud-task\.md/);
  assert.match(prepare, /node "\$CONTROL\/cloud_agent_manager\.cjs" review-prompt \.siton-review-prompt\.md/);
  // The control copies are re-verified after the agents, before any of them
  // extracts or parses a verdict.
  const verify = index("Verify control copies are unchanged");
  assert.ok(verify > index("Claude review") && verify > index("Codex review"));
  assert.ok(verify < index("Extract Claude review") && verify < index("Parse review verdict"));
  assert.match(steps[verify], /MANIFEST_SHA256: \$\{\{ steps\.control\.outputs\.manifest_sha256 \}\}/);
  assert.match(steps[verify], /sha256sum -c --quiet SHA256SUMS/);
  assert.match(steps[index("Extract Claude review")], /node "\$RUNNER_TEMP\/control\/cloud_agent_manager\.cjs" extract-claude/);
  assert.match(steps[index("Parse review verdict")], /node "\$RUNNER_TEMP\/control\/cloud_agent_manager\.cjs" review "\$review_file"/);
  // Reviewer read-only contract: snapshot before the agents, compare after,
  // before the verdict is accepted.
  const readOnly = index("Enforce reviewer read-only contract");
  assert.ok(index("Prepare read-only review") < index("Codex review"));
  assert.match(prepare, /siton-review-before\.diff/);
  assert.ok(readOnly > index("Extract Claude review") && readOnly < index("Parse review verdict"));
  assert.match(steps[readOnly], /cmp "\$RUNNER_TEMP\/siton-review-before\.diff" "\$RUNNER_TEMP\/siton-review-after\.diff"/);
  assert.match(steps[readOnly], /cmp "\$RUNNER_TEMP\/siton-review-before\.status" "\$RUNNER_TEMP\/siton-review-after\.status"/);

  // Finalize follows the same rule before it touches the final patch.
  const finalSteps = stepsOf(jobsOf(read(MANAGER)).finalize);
  const finalIndex = (name) => finalSteps.findIndex((step) => step.startsWith(`- name: ${name}\n`));
  const finalCopy = finalIndex("Copy control scripts before the patch");
  assertControlCopy(finalSteps[finalCopy]);
  const finalDownload = finalIndex("Download final task patch");
  assert.ok(finalCopy >= 0 && finalCopy < finalDownload && finalDownload < finalIndex("Apply final reviewed patch and enforce control-plane boundary"));
  assertOnlyControlCopiesAfter(finalSteps, finalDownload, "finalize");
  assert.match(finalSteps[finalIndex("Update project status and final diff checks")], /node "\$RUNNER_TEMP\/control\/cloud_agent_manager\.cjs" status PROJECT_STATUS\.md/);
  assert.match(finalSteps[finalIndex("Record agent-run telemetry")], /node "\$RUNNER_TEMP\/control\/agent_router\.cjs" metric agent-run-metric\.json/);
});

test("a review job receives only its reviewer provider's credential and a read-only token", () => {
  const jobs = jobsOf(read(MANAGER));
  const review = read(REVIEW);
  // A called workflow sees only the secrets its caller maps explicitly.
  assert.deepEqual([...new Set(review.match(/secrets\.[A-Za-z_]+/g))].sort(), ["secrets.anthropic_api_key", "secrets.claude_code_oauth_token", "secrets.openai_api_key"]);
  assert.match(review, /\n    secrets:\n      openai_api_key:\n        required: false\n      anthropic_api_key:\n        required: false\n      claude_code_oauth_token:\n        required: false\n/);
  const reviewSteps = stepsOf(jobsOf(review).review);
  for (const step of reviewSteps) {
    const used = [...new Set(step.match(/secrets\.[a-z_]+/g) || [])].sort();
    if (firstLine(step) === "- name: Codex review") assert.deepEqual(used, ["secrets.openai_api_key"]);
    else if (firstLine(step) === "- name: Claude review") assert.deepEqual(used, ["secrets.anthropic_api_key", "secrets.claude_code_oauth_token"]);
    else assert.deepEqual(used, [], `${firstLine(step)} must not touch a credential`);
  }
  for (const id of ["review-1", "review-2"]) {
    const job = jobs[id];
    const mapping = /\n    secrets:\n((?: {6}[^\n]+\n?)+)/.exec(job);
    assert.ok(mapping, `${id} must map secrets explicitly`);
    assert.deepEqual(mapping[1].trim().split("\n").map((line) => line.trim()), [
      "openai_api_key: ${{ needs.route.outputs.reviewer == 'codex' && secrets.OPENAI_API_KEY || '' }}",
      "anthropic_api_key: ${{ needs.route.outputs.reviewer == 'claude' && needs.route.outputs.claude_auth == 'api' && secrets.ANTHROPIC_API_KEY || '' }}",
      "claude_code_oauth_token: ${{ needs.route.outputs.reviewer == 'claude' && needs.route.outputs.claude_auth == 'oauth' && secrets.CLAUDE_CODE_OAUTH_TOKEN || '' }}",
    ]);
    assert.doesNotMatch(job, /SITON_AGENT_GITHUB_TOKEN|secrets: inherit|: write\b/);
    assert.match(job, /\n    permissions:\n      contents: read\n      pull-requests: read\n    uses: /);
  }
  assert.match(jobsOf(review).review, /\n    permissions:\n      contents: read\n      pull-requests: read\n    outputs:/);
  assert.doesNotMatch(review, /: write\b/);
});

test("finalize commits exactly the bytes the last review job judged, and takes the verdict from that job", () => {
  const manager = read(MANAGER);
  const jobs = jobsOf(manager);
  const review = read(REVIEW);
  // The review job publishes, from its own runner, what it applied and said.
  assert.match(review, /patch_sha256: \$\{\{ steps\.apply\.outputs\.patch_sha256 \}\}/);
  assert.match(review, /review_sha256: \$\{\{ steps\.verdict\.outputs\.review_sha256 \}\}/);
  assert.match(review, /verdict: \$\{\{ steps\.verdict\.outputs\.verdict \}\}/);
  const select = stepNamed(jobs.finalize, "Select final review verdict");
  for (const pass of [1, 2]) {
    assert.match(select, new RegExp(`VERDICT_${pass}: \\$\\{\\{ needs\\.review-${pass}\\.outputs\\.verdict \\}\\}`));
    assert.match(select, new RegExp(`REVIEW_SHA256_${pass}: \\$\\{\\{ needs\\.review-${pass}\\.outputs\\.review_sha256 \\}\\}`));
  }
  assert.match(select, /echo "\$review_sha  \$review" \| sha256sum -c --quiet -/);
  assert.match(select, /node "\$RUNNER_TEMP\/control\/cloud_agent_manager\.cjs" review "\$review"/);
  assert.match(select, /test "\$parsed" = "\$expected"/);
  assert.match(select, /echo "verdict=NOT_RUN"/);
  const apply = stepNamed(jobs.finalize, "Apply final reviewed patch and enforce control-plane boundary");
  assert.match(apply, /REVIEWED_PATCH_SHA256_1: \$\{\{ needs\.review-1\.outputs\.patch_sha256 \}\}/);
  assert.match(apply, /REVIEWED_PATCH_SHA256_2: \$\{\{ needs\.review-2\.outputs\.patch_sha256 \}\}/);
  assert.match(apply, /echo "\$expected  \$patch" \| sha256sum -c --quiet -/);
  // The build job's self-reported digest counts only when no review ran.
  assert.match(apply, /\n\s+if \[ "\$REVIEWER" = none \]; then expected="\$BUILD_PATCH_SHA256"\n\s+elif \[ "\$NEEDED_FIX" = true \]; then expected="\$REVIEWED_PATCH_SHA256_2"\n\s+else expected="\$REVIEWED_PATCH_SHA256_1"; fi\n/);
  assert.equal((apply.match(/BUILD_PATCH_SHA256/g) || []).length, 2);
  assert.match(apply, /safe_git status --porcelain=v1 -z --untracked-files=all --no-renames \| node "\$RUNNER_TEMP\/control\/cloud_agent_manager\.cjs" boundary/);
  // The fix pass starts from exactly the bytes review pass 1 judged.
  const rebuild = stepNamed(jobs.fix, "Rebuild the reviewed task state");
  assert.match(rebuild, /REVIEWED_PATCH_SHA256: \$\{\{ needs\.review-1\.outputs\.patch_sha256 \}\}/);
  assert.match(rebuild, /echo "\$REVIEWED_PATCH_SHA256  \$patch" \| sha256sum -c --quiet -/);
  assert.match(rebuild, /echo "\$REVIEW_SHA256  \$review" \| sha256sum -c --quiet -/);
  // Every job starts from the one base commit the route job recorded.
  for (const id of ["build", "fix"]) assert.match(stepNamed(jobs[id], "Checkout canonical master at the task base"), /ref: \$\{\{ needs\.route\.outputs\.base_sha \}\}/);
  for (const id of ["review-1", "review-2"]) assert.match(jobs[id], /base_sha: \$\{\{ needs\.route\.outputs\.base_sha \}\}/);
});

test("control-plane boundary refuses protected paths and fails closed on rename or unparseable entries", () => {
  const { spawnSync } = require("node:child_process");
  assert.deepEqual(statusPaths(" M src/a.ts\0?? docs/new file.md\0D  old.txt\0A  web/é.ts\0"), ["src/a.ts", "docs/new file.md", "old.txt", "web/é.ts"]);
  const blocked = [
    ".github/workflows/ci.yml", ".github/workflows/é.yml", ".github/CODEOWNERS",
    "scripts/cloud_agent_manager.cjs", "scripts/agent_readonly_bash_guard.cjs", "scripts/agent_router.cjs", "scripts/agent_model_tiers.cjs",
    "AGENTS.md", "AI_WORKFLOW.md", "CLAUDE.md", "PROJECT_STATUS.md", ".siton-review-prompt.md", ".siton-control/x",
    // Anything an agent loads as instructions or configuration.
    "docs/AGENTS.md", "AGENTS.override.md", "src/AGENTS.override.md", "CLAUDE.local.md", "web/CLAUDE.md",
    ".claude/settings.json", ".claude/agents/x.md", "web/.claude/settings.local.json", ".codex/config.toml", "src/.codex/x", ".mcp.json",
  ];
  assert.deepEqual(protectedPaths(blocked), blocked);
  for (const script of CONTROL_SCRIPTS) assert.deepEqual(protectedPaths([script]), [script], script);
  const allowed = ["src/app.ts", "docs/AGENTS_GUIDE.txt", "docs/agents.md", "src/.mcp.json.example", "tests/PROJECT_STATUS.md", "scripts/siton_verify.cjs", "scripts/agent_router.cjs.md", "web/.github/x", "a.siton-x"];
  assert.deepEqual(protectedPaths(allowed), []);
  assert.throws(() => statusPaths("R  new.ts\0old.ts\0"), /rename\/copy/);
  assert.throws(() => statusPaths("garbage\0"), /unparseable/);
  const cli = (input) => spawnSync(process.execPath, [path.join(root, "scripts/cloud_agent_manager.cjs"), "boundary"], { input, encoding: "utf8" });
  const ok = cli(" M src/a.ts\0?? src/b.ts\0");
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /CLOUD_BOUNDARY_PASS paths=2/);
  for (const input of ["?? .github/workflows/evil.yml\0", " M src/a.ts\0 D PROJECT_STATUS.md\0", "R  x\0scripts/agent_router.cjs\0"]) {
    const refused = cli(input);
    assert.equal(refused.status, 1, JSON.stringify(input));
    assert.match(refused.stderr, /FAILED/);
  }
});
