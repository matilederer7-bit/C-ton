const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  buildReport,
  checkAnthropic,
  checkGithubActions,
  checkGithubToken,
  checkOpenAi,
  claudeAuthMode,
  claudeOauthStatus,
  renderMarkdown,
  runPreflight,
  scrub,
} = require("../../scripts/agent_credentials_preflight.cjs");

const root = path.resolve(__dirname, "..", "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

const okRepo = { ok: true, status: 200, headers: { get: () => "" }, json: async () => ({ permissions: { push: true, admin: false } }) };

test("preflight never emits a configured secret value", () => {
  const leaked = scrub("failed with key sk-live-SECRET and token ghp_SECRET2", ["sk-live-SECRET", "ghp_SECRET2", "", undefined]);
  assert.equal(leaked, "failed with key [redacted] and token [redacted]");
});

test("github token check separates absent, unusable and lifecycle-ready", async () => {
  assert.deepEqual(await checkGithubToken({ token: "", repository: "o/r" }), { present: false, valid: false, detail: "not configured" });

  const rejected = await checkGithubToken({ token: "t", repository: "o/r", fetchImpl: async () => ({ ok: false, status: 401 }) });
  assert.equal(rejected.valid, false);
  assert.match(rejected.detail, /HTTP 401/);

  const readOnly = await checkGithubToken({
    token: "t",
    repository: "o/r",
    fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => "" }, json: async () => ({ permissions: { push: false } }) }),
  });
  assert.equal(readOnly.valid, false);
  assert.match(readOnly.detail, /no write \(push\) access/);

  const ready = await checkGithubToken({ token: "t", repository: "o/r", fetchImpl: async () => okRepo });
  assert.equal(ready.valid, true);
  assert.equal(ready.push, true);
});

test("codex model availability is reported per routed tier without downgrading", async () => {
  const unavailable = new Set(["gpt-6-astra"]);
  const openai = await checkOpenAi({
    apiKey: "k",
    fetchImpl: async (url) => {
      if (url.endsWith("/v1/models")) return { ok: true, status: 200 };
      const model = decodeURIComponent(url.split("/").pop());
      return unavailable.has(model) ? { ok: false, status: 404 } : { ok: true, status: 200 };
    },
  });
  assert.equal(openai.valid, true);
  assert.equal(openai.models["gpt-5.6-sol"], "available");
  assert.match(openai.models["gpt-6-astra"], /unavailable/);

  const report = buildReport({
    github: { present: true, valid: true, detail: "ok" },
    actions: { present: true, valid: true, detail: "ok" },
    openai,
    anthropic: { present: true, valid: true, detail: "ok" },
    oauth: claudeOauthStatus(""),
    repository: "o/r",
  });
  assert.equal(report.ready, true);
  assert.equal(report.blockers.length, 0);
  assert.ok(report.warnings.some((warning) => /gpt-6-astra/.test(warning) && /apex \(Astra\)/.test(warning)));
});

test("a missing credential produces a named, owner-actionable blocker", () => {
  const report = buildReport({
    github: { present: false, valid: false, detail: "not configured" },
    actions: { present: false, valid: false, detail: "not configured" },
    openai: { present: false, valid: false, detail: "not configured", models: {} },
    anthropic: { present: false, valid: false, detail: "not configured" },
    oauth: claudeOauthStatus(""),
    repository: "o/r",
  });
  assert.equal(report.ready, false);
  assert.equal(report.claude_auth_mode, "none");
  assert.ok(report.blockers.some((blocker) => blocker.startsWith("SITON_AGENT_GITHUB_TOKEN is missing")));
  assert.ok(report.blockers.some((blocker) => blocker.startsWith("OPENAI_API_KEY is missing")));
  assert.ok(report.blockers.some((blocker) => /ANTHROPIC_API_KEY \(recommended\) or CLAUDE_CODE_OAUTH_TOKEN/.test(blocker)));
  const markdown = renderMarkdown(report);
  assert.match(markdown, /Overall: BLOCKED/);
  assert.match(markdown, /BLOCKER REQUIRES OWNER ACTION/);
  assert.match(markdown, /settings\/secrets\/actions/);
});

test("exactly one Claude credential is required and the API key wins", async () => {
  assert.equal(claudeAuthMode({ ANTHROPIC_API_KEY: "a", CLAUDE_CODE_OAUTH_TOKEN: "b" }), "api");
  assert.equal(claudeAuthMode({ CLAUDE_CODE_OAUTH_TOKEN: "b" }), "oauth");
  assert.equal(claudeAuthMode({}), "none");

  const oauthOnly = buildReport({
    github: { present: true, valid: true, detail: "ok" },
    actions: { present: true, valid: true, detail: "ok" },
    openai: { present: true, valid: true, detail: "ok", models: {} },
    anthropic: await checkAnthropic({ apiKey: "" }),
    oauth: claudeOauthStatus("oauth-token"),
    repository: "o/r",
  });
  assert.equal(oauthOnly.ready, true);
  assert.equal(oauthOnly.claude_auth_mode, "oauth");

  const both = buildReport({
    github: { present: true, valid: true, detail: "ok" },
    actions: { present: true, valid: true, detail: "ok" },
    openai: { present: true, valid: true, detail: "ok", models: {} },
    anthropic: { present: true, valid: true, detail: "ok" },
    oauth: claudeOauthStatus("oauth-token"),
    repository: "o/r",
  });
  assert.equal(both.claude_auth_mode, "api");
  assert.ok(both.warnings.some((warning) => /ignores CLAUDE_CODE_OAUTH_TOKEN/.test(warning)));
});

test("anthropic and actions checks classify provider failures honestly", async () => {
  const forbidden = await checkAnthropic({ apiKey: "k", fetchImpl: async () => ({ ok: false, status: 403 }) });
  assert.equal(forbidden.valid, false);
  assert.match(forbidden.detail, /billing\/quota/);

  const accepted = await checkAnthropic({ apiKey: "k", fetchImpl: async (url, options) => {
    assert.equal(options.headers["anthropic-version"], "2023-06-01");
    assert.equal(options.headers["x-api-key"], "k");
    assert.match(url, /api\.anthropic\.com/);
    return { ok: true, status: 200 };
  } });
  assert.equal(accepted.valid, true);

  const actionsBlocked = await checkGithubActions({ token: "t", repository: "o/r", fetchImpl: async () => ({ ok: false, status: 403 }) });
  assert.equal(actionsBlocked.valid, false);
  assert.match(actionsBlocked.detail, /analysis swarm cannot be dispatched/);
});

test("runPreflight wires every credential from the environment", async () => {
  const seen = [];
  const report = await runPreflight(
    { GITHUB_REPOSITORY: "o/r", SITON_AGENT_GITHUB_TOKEN: "t", OPENAI_API_KEY: "k", ANTHROPIC_API_KEY: "a" },
    async (url) => {
      seen.push(url);
      if (url.includes("api.github.com/repos/o/r/actions/workflows")) return { ok: true, status: 200 };
      if (url.includes("api.github.com/repos/o/r")) return okRepo;
      return { ok: true, status: 200 };
    },
  );
  assert.equal(report.ready, true);
  assert.equal(report.repository, "o/r");
  assert.ok(seen.some((url) => url.includes("api.anthropic.com")));
  assert.ok(seen.some((url) => url.includes("api.openai.com/v1/models/gpt-6-astra")));
});

test("preflight workflow is phone-runnable, read-only and never echoes a secret", () => {
  const workflow = read(".github/workflows/cloud-credential-preflight.yml");
  assert.match(workflow, /on:\n  workflow_dispatch:/);
  assert.match(workflow, /permissions:\n  contents: read\n  issues: write/);
  assert.doesNotMatch(workflow, /contents: write/);
  assert.match(workflow, /node scripts\/agent_credentials_preflight\.cjs/);
  assert.match(workflow, /gh issue comment/);
  // Secrets may only be bound to the checking step's env, never echoed or printed.
  assert.doesNotMatch(workflow, /echo .*secrets\./);
  for (const name of ["SITON_AGENT_GITHUB_TOKEN", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]) {
    assert.match(workflow, new RegExp(`${name}: \\$\\{\\{ secrets\\.${name.replace(/\./g, "\\.")} \\}\\}`));
  }
});
