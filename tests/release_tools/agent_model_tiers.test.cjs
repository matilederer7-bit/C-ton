const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  AGENT_TIERS,
  CLAUDE_TIER_ALIASES,
  TIER_ORDER,
  checkAgentDefinitions,
  claudeFamily,
  claudeModelArgs,
  claudeModelForTier,
  codexModelForTier,
  fallbackTiers,
  readAgentDefinitions,
  resolveClaudeModel,
  reviewerTier,
} = require("../../scripts/agent_model_tiers.cjs");
const { routeTask } = require("../../scripts/agent_router.cjs");
const { checkPlan } = require("../../scripts/team_plan_check.cjs");
const { routedModels, verifyModelAccess } = require("../../scripts/agent_model_access.cjs");

const root = path.resolve(__dirname, "../..");
const NO_ENV = {};
const evidence = "See architecture report: DB, charging state and idempotency conflict across three layers.";

// --- Routing ---------------------------------------------------------------

test("tiers resolve to the provider's stable aliases, cheapest to strongest", () => {
  assert.deepEqual(TIER_ORDER, ["economy", "standard", "senior", "apex"]);
  assert.deepEqual(TIER_ORDER.map((tier) => claudeModelForTier(tier, NO_ENV)), ["haiku", "sonnet", "opus", "fable"]);
});

test("telemetry records the Claude model of each role, including the raised reviewer", () => {
  const { buildMetric } = require("../../scripts/agent_router.cjs");
  const route = routeTask({ taskType: "tests", risk: "low", env: NO_ENV });
  assert.equal(route.builder, "codex");
  assert.equal(route.claudeReviewerModel, "sonnet");
  const metric = buildMetric({ claudeModel: "none", claudeReviewerModel: route.claudeReviewerModel });
  assert.equal(metric.claude_model_requested, "none");
  assert.equal(metric.claude_reviewer_model_requested, "sonnet");
  assert.equal(metric.claude_reviewer_model_executed, "unknown");
  const workflow = fs.readFileSync(path.join(root, ".github/workflows/cloud-agent-manager.yml"), "utf8");
  assert.match(workflow, /SITON_CLAUDE_MODEL: \$\{\{ needs\.route\.outputs\.builder == 'claude' && needs\.route\.outputs\.claude_model \|\| 'none' \}\}/);
  assert.match(workflow, /SITON_CLAUDE_REVIEWER_MODEL: \$\{\{ needs\.route\.outputs\.reviewer == 'claude' && needs\.route\.outputs\.claude_reviewer_model \|\| 'none' \}\}/);
  // Those job outputs are the router's own step outputs in the route job.
  assert.match(workflow, /\n      claude_model: \$\{\{ steps\.roles\.outputs\.claude_model \}\}\n/);
  assert.match(workflow, /\n      claude_reviewer_model: \$\{\{ steps\.roles\.outputs\.claude_reviewer_model \}\}\n/);
});

test("router maps work to the right Claude tier model", () => {
  const cases = [
    [{ taskType: "docs", risk: "low" }, "economy", "haiku"],
    [{ taskType: "tests", risk: "low" }, "economy", "haiku"],
    [{ taskType: "frontend" }, "standard", "sonnet"],
    [{ taskType: "backend" }, "standard", "sonnet"],
    [{ taskType: "database" }, "senior", "opus"],
    [{ taskType: "security" }, "senior", "opus"],
    [{ taskType: "payments" }, "senior", "opus"],
    [{ task: "Fix the auth session refresh" }, "senior", "opus"],
    [{ taskType: "frontend", risk: "high" }, "senior", "opus"],
    [{ taskType: "payments", risk: "critical", tier: "apex", apexReason: "critical-cross-layer", apexEvidence: evidence }, "apex", "fable"],
  ];
  for (const [input, tier, model] of cases) {
    const route = routeTask({ ...input, env: NO_ENV });
    assert.equal(route.tier, tier, JSON.stringify(input));
    assert.equal(route.claudeModel, model, JSON.stringify(input));
    assert.match(route.claudeModelArgs, new RegExp(`^--model ${model}( |$)`));
  }
});

test("a Claude reviewer is never cheaper than standard", () => {
  assert.equal(reviewerTier("economy"), "standard");
  for (const tier of ["standard", "senior", "apex"]) assert.equal(reviewerTier(tier), tier);
  const docs = routeTask({ taskType: "docs", risk: "low", env: NO_ENV });
  assert.equal(docs.claudeModel, "haiku");
  assert.match(docs.claudeReviewerModelArgs, /^--model sonnet/);
  assert.equal(routeTask({ taskType: "payments", env: NO_ENV }).claudeReviewerModelArgs, "--model opus");
});

test("builder and reviewer are different providers whenever both exist", () => {
  for (const taskType of ["docs", "tests", "frontend", "ux", "backend", "operations", "database", "security", "payments"]) {
    const route = routeTask({ taskType, env: NO_ENV });
    assert.notEqual(route.builder, route.reviewer, taskType);
  }
});

test("team plans cannot use one agent identity as its own reviewer", () => {
  const plan = {
    task: "x",
    assignments: [
      { id: "B1", agent: "codex", role: "builder", scope: "s", allowed: ["docs/a.md"], forbidden: [], depends_on: [], dod: ["d"] },
      { id: "R1", agent: "codex", role: "reviewer", scope: "s", reviews: ["B1"], depends_on: ["B1"], dod: ["d"] },
    ],
  };
  assert.ok(checkPlan(plan).findings.some((finding) => finding.code === "review_missing"));
});

// --- Safe fallback -----------------------------------------------------------

test("fallback is upward only, never into apex, and absent for senior and apex", () => {
  assert.deepEqual(fallbackTiers("economy"), ["standard"]);
  assert.deepEqual(fallbackTiers("standard"), ["senior"]);
  assert.deepEqual(fallbackTiers("senior"), []);
  assert.deepEqual(fallbackTiers("apex"), []);
  for (const tier of TIER_ORDER) {
    for (const next of fallbackTiers(tier)) {
      assert.ok(TIER_ORDER.indexOf(next) > TIER_ORDER.indexOf(tier), `${tier} -> ${next} is not upward`);
      assert.notEqual(next, "apex");
    }
  }
  assert.equal(claudeModelArgs("economy", NO_ENV), "--model haiku --fallback-model sonnet");
  assert.equal(claudeModelArgs("standard", NO_ENV), "--model sonnet --fallback-model opus");
  assert.equal(claudeModelArgs("senior", NO_ENV), "--model opus");
  assert.equal(claudeModelArgs("apex", NO_ENV), "--model fable");
});

test("an unavailable model falls back upward when allowed", () => {
  const resolved = resolveClaudeModel("economy", { env: NO_ENV, available: new Set(["sonnet", "opus"]) });
  assert.equal(resolved.model, "sonnet");
  assert.equal(resolved.fellBack, true);
  assert.equal(resolveClaudeModel("standard", { env: NO_ENV, available: new Set(["opus"]) }).model, "opus");
  assert.equal(resolveClaudeModel("standard", { env: NO_ENV, available: new Set(["sonnet"]) }).fellBack, false);
});

// --- No silent downgrade -----------------------------------------------------

test("sensitive tiers fail closed instead of downgrading when their model is unavailable", () => {
  const cheaper = new Set(["haiku", "sonnet"]);
  assert.throws(() => resolveClaudeModel("senior", { env: NO_ENV, available: cheaper }), /refusing to downgrade/);
  assert.throws(() => resolveClaudeModel("apex", { env: NO_ENV, available: new Set(["haiku", "sonnet", "opus"]) }), /refusing to downgrade/);
  // Standard never drops to economy either.
  assert.throws(() => resolveClaudeModel("standard", { env: NO_ENV, available: new Set(["haiku"]) }), /refusing to downgrade/);
});

test("configuration cannot pin a sensitive tier to a weaker model family", () => {
  for (const [tier, pin] of [["senior", "sonnet"], ["senior", "claude-haiku-4-5-20251001"], ["apex", "opus"], ["standard", "haiku"], ["senior", "claude-sonnet-5-5"]]) {
    const key = `SITON_CLAUDE_MODEL_${tier.toUpperCase()}`;
    assert.throws(() => claudeModelForTier(tier, { [key]: pin }), /downgrade/, `${tier}=${pin}`);
    assert.throws(() => routeTask({ taskType: tier === "senior" ? "payments" : "backend", tier: tier === "apex" ? "apex" : "auto", apexReason: tier === "apex" ? "critical-cross-layer" : "none", risk: tier === "apex" ? "critical" : "normal", apexEvidence: evidence, env: { [key]: pin } }), /downgrade/);
  }
  assert.throws(() => claudeModelForTier("senior", { SITON_CLAUDE_MODEL_SENIOR: "opus --dangerously-skip-permissions" }), /not a Claude alias/);
  assert.throws(() => claudeModelForTier("senior", { SITON_CLAUDE_MODEL_SENIOR: "gpt-6-sol" }), /not a Claude alias/);
  assert.throws(() => codexModelForTier("senior", { SITON_CODEX_MODEL_SENIOR: "gpt-6-luna" }), /downgrade/);
  assert.throws(() => codexModelForTier("apex", { SITON_CODEX_MODEL_APEX: "gpt-6-sol" }), /downgrade/);
  assert.throws(() => routeTask({ taskType: "payments", env: { SITON_CODEX_MODEL_SENIOR: "gpt-6-sol" } }), /downgrade/);
  assert.equal(codexModelForTier("economy", { SITON_CODEX_MODEL_ECONOMY: "gpt-6-sol" }), "gpt-6-sol");
});

test("sensitive work never routes to a cheaper Claude model, whatever tier is requested", () => {
  for (const taskType of ["database", "security", "payments"]) {
    for (const tier of ["auto", "economy", "standard", "senior"]) {
      const route = routeTask({ taskType, tier, env: NO_ENV });
      assert.ok(["opus", "fable"].includes(route.claudeModel), `${taskType}/${tier} -> ${route.claudeModel}`);
      assert.doesNotMatch(route.claudeModelArgs, /haiku|sonnet/);
      assert.doesNotMatch(route.claudeReviewerModelArgs, /haiku|sonnet/);
    }
  }
});

test("team plans refuse a sensitive builder or senior reviewer below the senior tier", () => {
  const base = (builderTier, reviewerTier) => ({
    task: "x",
    assignments: [
      { id: "B1", agent: "claude-subagent", role: "builder", tier: builderTier, scope: "s", allowed: ["src/migrations/099_x.sql"], forbidden: [], depends_on: [], dod: ["d"] },
      { id: "R1", agent: "claude-subagent", role: "reviewer", senior: true, tier: reviewerTier, scope: "s", reviews: ["B1"], depends_on: ["B1"], dod: ["d"] },
    ],
  });
  const codes = (plan) => checkPlan(plan).findings.map((finding) => finding.code);
  assert.deepEqual(codes(base("senior", "senior")), []);
  assert.ok(codes(base("standard", "senior")).includes("tier_below_floor"));
  assert.ok(codes(base("senior", "standard")).includes("tier_below_floor"));
  assert.ok(codes(base("senior", "bogus")).includes("tier_invalid"));
  const pinned = base("senior", "senior");
  pinned.assignments[0].model = "claude-opus-4-1";
  assert.ok(codes(pinned).includes("model_pinned"));
  const cheapReviewer = base("senior", "senior");
  cheapReviewer.assignments[0].allowed = ["docs/a.md"];
  cheapReviewer.assignments[1] = { ...cheapReviewer.assignments[1], senior: false, tier: "economy" };
  assert.ok(codes(cheapReviewer).includes("tier_below_floor"));
});

test("independent workstreams are reported as one parallel wave", () => {
  const item = (id, allowed, depends = []) => ({ id, agent: "claude-subagent", role: "builder", scope: "s", allowed, forbidden: [], depends_on: depends, dod: ["d"] });
  const result = checkPlan({
    task: "x",
    assignments: [
      item("B1", ["docs/a.md"]),
      item("B2", ["docs/b.md"]),
      item("B3", ["docs/c.md"], ["B1"]),
      { id: "R1", agent: "claude-subagent", role: "reviewer", scope: "s", reviews: ["B1", "B2", "B3"], depends_on: ["B3", "B2"], dod: ["d"] },
    ],
  });
  assert.deepEqual(result.waves, [["B1", "B2"], ["B3"], ["R1"]]);
});

// --- Model renames do not break configuration --------------------------------

test("claude families are recognized for aliases and for current and future identifiers", () => {
  for (const [model, family] of [["opus", "opus"], ["claude-opus-5-5", "opus"], ["claude-haiku-4-5-20251001", "haiku"], ["claude-fable-5-1", "fable"], ["claude-opus-9-2", "opus"], ["claude-sonnet-7", "sonnet"]]) {
    assert.equal(claudeFamily(model), family, model);
  }
  for (const model of ["inherit", "gpt-5", "claude-opus", "claude-opus-5-5; rm", "Opus"]) assert.equal(claudeFamily(model), null, model);
});

test("a new model version is adopted by override without code changes, end to end", () => {
  const env = { SITON_CLAUDE_MODEL_SENIOR: "claude-opus-9-1", SITON_CODEX_MODEL_SENIOR: "gpt-7-sol" };
  const route = routeTask({ taskType: "payments", env });
  assert.equal(route.claudeModel, "claude-opus-9-1");
  assert.equal(route.claudeModelArgs, "--model claude-opus-9-1");
  assert.equal(route.codexModel, "gpt-7-sol");
  assert.ok(routedModels(env).has("gpt-7-sol"));
  // A pinned Standard model also propagates into Economy's upward fallback.
  assert.equal(claudeModelArgs("economy", { SITON_CLAUDE_MODEL_STANDARD: "claude-sonnet-9" }), "--model haiku --fallback-model claude-sonnet-9");
  assert.throws(() => codexModelForTier("senior", { SITON_CODEX_MODEL_SENIOR: "gpt 7" }), /not a valid model identifier/);
});

test("Codex model access follows the tier policy instead of a frozen list", async () => {
  const env = { SITON_CODEX_MODEL_STANDARD: "gpt-7-terra" };
  const fetchImpl = async () => ({ ok: true, json: async () => ({ id: "gpt-7-terra" }) });
  assert.deepEqual(await verifyModelAccess({ apiKey: "test-only", model: "gpt-7-terra", fetchImpl, env }), { model: "gpt-7-terra", metadataAccess: true, inferenceVerified: false });
  await assert.rejects(verifyModelAccess({ apiKey: "test-only", model: "gpt-7-terra", fetchImpl, env: NO_ENV }), /Unknown routed Codex model/);
});

test("the default tier table is the only place model names live in routing code", () => {
  const router = fs.readFileSync(path.join(root, "scripts/agent_router.cjs"), "utf8");
  const access = fs.readFileSync(path.join(root, "scripts/agent_model_access.cjs"), "utf8");
  for (const [name, text] of [["agent_router.cjs", router], ["agent_model_access.cjs", access]]) {
    assert.doesNotMatch(text, /gpt-\d|claude-(haiku|sonnet|opus|fable)|"(haiku|sonnet|opus|fable)"/, `${name} hard-codes a model name`);
  }
});

// --- Claude sub-agent definitions ---------------------------------------------

test("every sub-agent definition uses its tier alias, never a pinned version", () => {
  const definitions = readAgentDefinitions(path.join(root, ".claude/agents"));
  assert.deepEqual(Object.keys(definitions).sort(), Object.keys(AGENT_TIERS).sort());
  assert.deepEqual(checkAgentDefinitions(definitions), []);
  for (const name of ["db-migrations", "payments-money", "security-auditor", "backend-core"]) {
    assert.equal(AGENT_TIERS[name], "senior", name);
  }
  assert.equal(AGENT_TIERS["repo-scout"], "economy");
});

test("the agent check catches pinned, inherited, downgraded and untiered agents", () => {
  const definitions = readAgentDefinitions(path.join(root, ".claude/agents"));
  const mutate = (name, from, to) => ({ ...definitions, [name]: definitions[name].replace(from, to) });
  assert.equal(checkAgentDefinitions(mutate("payments-money", "model: opus", "model: claude-opus-4-1")).length, 1);
  assert.equal(checkAgentDefinitions(mutate("payments-money", "model: opus", "model: sonnet")).length, 1);
  assert.equal(checkAgentDefinitions(mutate("security-auditor", "model: opus", "model: inherit")).length, 1);
  assert.equal(checkAgentDefinitions({ ...definitions, "new-agent": "---\nname: new-agent\nmodel: haiku\n---\nx\n" }).length, 1);
  const { "repo-scout": removed, ...missing } = definitions;
  assert.ok(removed);
  assert.equal(checkAgentDefinitions(missing).length, 1);
  assert.equal(CLAUDE_TIER_ALIASES[AGENT_TIERS["repo-scout"]], "haiku");
});

test("the cloud manager passes the routed tier model to every Claude step", () => {
  const workflow = fs.readFileSync(path.join(root, ".github/workflows/cloud-agent-manager.yml"), "utf8");
  const review = fs.readFileSync(path.join(root, ".github/workflows/cloud-agent-review.yml"), "utf8");
  // Builder and fix pass run in the manager; both review passes run the one
  // Claude step of the review workflow, which the manager calls twice.
  const steps = workflow.split(/\n      - name: /).filter((step) => step.includes("anthropics/claude-code-action@v1"));
  assert.deepEqual(steps.map((step) => step.split("\n")[0]), ["Claude builder", "Claude bounded fix pass"]);
  for (const step of steps) {
    assert.match(step, /claude_args: >-\n\s+\$\{\{ needs\.route\.outputs\.claude_model_args \}\}\n/, step.split("\n")[0]);
  }
  const reviewSteps = review.split(/\n      - name: /).filter((step) => step.includes("anthropics/claude-code-action@v1"));
  assert.deepEqual(reviewSteps.map((step) => step.split("\n")[0]), ["Claude review"]);
  assert.match(reviewSteps[0], /claude_args: >-\n\s+\$\{\{ inputs\.claude_reviewer_model_args \}\}\n/);
  const calls = workflow.match(/\n      claude_reviewer_model_args: [^\n]*/g) || [];
  // One route job output (the router's value) and the two review calls.
  assert.deepEqual(calls.map((line) => line.trim()), [
    "claude_reviewer_model_args: ${{ steps.roles.outputs.claude_reviewer_model_args }}",
    "claude_reviewer_model_args: ${{ needs.route.outputs.claude_reviewer_model_args }}",
    "claude_reviewer_model_args: ${{ needs.route.outputs.claude_reviewer_model_args }}",
  ]);
  assert.match(workflow, /\n      claude_model_args: \$\{\{ steps\.roles\.outputs\.claude_model_args \}\}\n/);
  for (const text of [workflow, review]) {
    assert.doesNotMatch(text, /--model (claude-|haiku|sonnet|opus|fable)/, "workflow must not pin a Claude model");
  }
  for (const tier of TIER_ORDER) {
    assert.match(workflow, new RegExp(`SITON_CLAUDE_MODEL_${tier.toUpperCase()}: \\$\\{\\{ vars\\.SITON_CLAUDE_MODEL_${tier.toUpperCase()} \\}\\}`));
  }
});

test("telemetry records the model Claude Code actually executed, separately from the requested alias", () => {
  const os = require("node:os");
  const { buildMetric, executedModels } = require("../../scripts/agent_router.cjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "siton-exec-"));
  try {
    // Requested sonnet, Claude Code switched to the --fallback-model.
    const review = path.join(dir, "review.json");
    fs.writeFileSync(review, JSON.stringify([
      { type: "system", subtype: "init", model: "claude-sonnet-5-5" },
      { type: "assistant", message: { model: "claude-opus-5-5", content: [] } },
      { type: "result", result: "ok", modelUsage: { "claude-opus-5-5": {}, "claude-haiku-4-5-20251001": {} } },
    ]));
    const broken = path.join(dir, "broken.json");
    fs.writeFileSync(broken, "{not json");
    assert.deepEqual(executedModels(review, broken, path.join(dir, "missing.json"), ""), ["claude-haiku-4-5-20251001", "claude-opus-5-5"]);
    const metric = buildMetric({ claudeReviewerModel: "sonnet", claudeReviewerExecuted: executedModels(review) });
    assert.equal(metric.claude_reviewer_model_requested, "sonnet");
    assert.equal(metric.claude_reviewer_model_executed, "claude-haiku-4-5-20251001,claude-opus-5-5");
    assert.equal(metric.claude_model_executed, "unknown");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // Each Claude step runs in its own job now: its execution file travels as an
  // artifact to finalize, whose telemetry step parses it.
  const workflow = fs.readFileSync(path.join(root, ".github/workflows/cloud-agent-manager.yml"), "utf8");
  const review = fs.readFileSync(path.join(root, ".github/workflows/cloud-agent-review.yml"), "utf8");
  for (const [key, artifact] of [["BUILD", "siton-exec-build"], ["FIX", "siton-exec-fix"], ["REVIEW1", "siton-review-1"], ["REVIEW2", "siton-review-2"]]) {
    assert.match(workflow, new RegExp(`SITON_CLAUDE_${key}_EXECUTION: \\$\\{\\{ runner\\.temp \\}\\}/siton-telemetry/${artifact}/claude-execution\\.json\\n`));
  }
  assert.match(workflow, /name: Download agent execution records\n        if: always\(\)\n[\s\S]*?pattern: siton-\*\n\s+path: \$\{\{ runner\.temp \}\}\/siton-telemetry\n/);
  for (const [text, step, artifact] of [[workflow, "claude_build", "siton-exec-build"], [workflow, "claude_fix", "siton-exec-fix"], [review, "claude_review", "siton-review-\\$\\{\\{ inputs\\.pass \\}\\}"]]) {
    assert.match(text, new RegExp(`\\n        id: ${step}\\n`));
    assert.match(text, new RegExp(`CLAUDE_EXECUTION_FILE: \\$\\{\\{ steps\\.${step}\\.outputs\\.execution_file \\}\\}\\n[\\s\\S]*?cp "\\$CLAUDE_EXECUTION_FILE" "[^"]+/claude-execution\\.json"`));
    assert.match(text, new RegExp(`\\n          name: ${artifact}\\n`));
  }
});

test("a fallback is never a weaker family than a stronger administrator pin", () => {
  assert.deepEqual(resolveClaudeModel("economy", { env: { SITON_CLAUDE_MODEL_ECONOMY: "opus" } }).fallbacks, []);
  assert.equal(claudeModelArgs("economy", { SITON_CLAUDE_MODEL_ECONOMY: "opus" }), "--model opus");
  assert.equal(claudeModelArgs("economy", { SITON_CLAUDE_MODEL_ECONOMY: "sonnet" }), "--model sonnet");
  assert.equal(claudeModelArgs("economy", { SITON_CLAUDE_MODEL_ECONOMY: "sonnet", SITON_CLAUDE_MODEL_STANDARD: "opus" }), "--model sonnet --fallback-model opus");
  assert.throws(() => resolveClaudeModel("economy", { env: { SITON_CLAUDE_MODEL_ECONOMY: "opus" }, available: new Set(["sonnet", "haiku"]) }), /refusing to downgrade/);
});

test("a Codex pin may not equal the effective model of a lower tier, including a pinned one", () => {
  const env = { SITON_CODEX_MODEL_STANDARD: "gpt-new-cheap", SITON_CODEX_MODEL_SENIOR: "gpt-new-cheap" };
  assert.throws(() => codexModelForTier("senior", env), /standard tier model/);
  assert.throws(() => routeTask({ taskType: "payments", env }), /downgrade/);
  assert.equal(codexModelForTier("senior", { SITON_CODEX_MODEL_STANDARD: "gpt-new-cheap", SITON_CODEX_MODEL_SENIOR: "gpt-new-strong" }), "gpt-new-strong");
});

test("sensitive task text keeps the senior floor even when the declared task type is ordinary or wrong", () => {
  const { sensitiveText } = require("../../scripts/agent_router.cjs");
  for (const [task, taskType] of [
    ["Refactor the deal state machine transitions", "auto"],
    ["Fix outbox idempotency race", "auto"],
    ["Redesign the cross-service architecture", "backend"],
    ["Add a Postgres migration for orders", "frontend"],
    ["Rework the login session refresh", "frontend"],
    ["Adjust payout rounding", "docs"],
    ["Verify webhook signatures", "tests"],
  ]) {
    assert.equal(sensitiveText(task), true, task);
    const route = routeTask({ task, taskType, risk: "low", tier: "economy", env: NO_ENV });
    assert.equal(route.tier, "senior", `${task} (${taskType})`);
    assert.equal(route.claudeModel, "opus", task);
    assert.equal(route.sensitive, true, task);
  }
  for (const task of ["Update copy on the landing page", "Fix React mobile screen spacing", "Add a docs index"]) {
    assert.equal(sensitiveText(task), false, task);
  }
  assert.equal(routeTask({ task: "Add a docs index", taskType: "docs", risk: "low", env: NO_ENV }).tier, "economy");
});

test("the plan check reports the model of the builder's own provider, with pins applied", () => {
  const plan = (agent) => ({
    task: "x",
    assignments: [
      { id: "B1", agent, role: "builder", tier: "senior", scope: "s", allowed: ["docs/a.md"], forbidden: [], depends_on: [], dod: ["d"] },
      { id: "R1", agent: "claude-subagent", role: "reviewer", scope: "s", reviews: ["B1"], depends_on: ["B1"], dod: ["d"] },
    ],
  });
  assert.equal(checkPlan(plan("codex"), { env: NO_ENV }).builders[0].model, "gpt-6-sol");
  assert.equal(checkPlan(plan("claude-subagent"), { env: NO_ENV }).builders[0].model, "opus");
  assert.equal(checkPlan(plan("chatgpt"), { env: NO_ENV }).builders[0].model, "provider-managed");
  assert.equal(checkPlan(plan("codex"), { env: { SITON_CODEX_MODEL_SENIOR: "gpt-7-sol" } }).builders[0].model, "gpt-7-sol");
});
