#!/usr/bin/env node
// Credential preflight for the Siton cloud agent team.
//
// Reports presence and live reachability of the cloud credentials only.
// Secret values are never printed, written to a file, or embedded in an error
// message. Every emitted string passes through scrub() before it leaves here.

const fs = require("node:fs");

const CODEX_MODELS = ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol", "gpt-6-astra"];
const TIER_BY_MODEL = {
  "gpt-5.6-luna": "economy (Luna)",
  "gpt-5.6-terra": "standard (Terra)",
  "gpt-5.6-sol": "senior (Sol)",
  "gpt-6-astra": "apex (Astra)",
};

const SECRET_ENV_KEYS = ["SITON_AGENT_GITHUB_TOKEN", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"];

function present(value) {
  return typeof value === "string" && value.trim().length > 0;
}

// Defence in depth: even a provider error body cannot leak a configured secret.
function scrub(text, secrets = []) {
  let out = String(text == null ? "" : text);
  for (const secret of secrets) {
    if (!present(secret)) continue;
    out = out.split(String(secret).trim()).join("[redacted]");
  }
  return out;
}

function claudeAuthMode(env = process.env) {
  if (present(env.ANTHROPIC_API_KEY)) return "api";
  if (present(env.CLAUDE_CODE_OAUTH_TOKEN)) return "oauth";
  return "none";
}

function describeStatus(status) {
  if (status === 401) return "credential rejected (HTTP 401): the secret exists but is not valid";
  if (status === 403) return "forbidden (HTTP 403): valid credential without the required permission, or billing/quota is blocked";
  if (status === 404) return "not found (HTTP 404): no access to this resource for this credential";
  if (status === 429) return "rate limited (HTTP 429): credential works but is throttled right now";
  return `unexpected HTTP ${status}`;
}

async function checkGithubToken({ token, repository, fetchImpl = fetch } = {}) {
  if (!present(token)) return { present: false, valid: false, detail: "not configured" };
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "siton-credential-preflight" };
  const [owner, repo] = String(repository || "").split("/");
  if (!owner || !repo) return { present: true, valid: false, detail: "repository must be provided as owner/repo" };
  const response = await fetchImpl(`https://api.github.com/repos/${owner}/${repo}`, { headers, signal: AbortSignal.timeout(30000) });
  if (!response.ok) return { present: true, valid: false, detail: describeStatus(response.status) };
  const body = await response.json();
  const permissions = body.permissions || {};
  // Classic tokens expose scopes; fine-grained tokens do not and report capability through permissions.
  const scopes = (response.headers && typeof response.headers.get === "function" && response.headers.get("x-oauth-scopes")) || "";
  const lifecycleReady = permissions.push === true;
  return {
    present: true,
    valid: lifecycleReady,
    detail: lifecycleReady
      ? `repository write access confirmed${scopes ? ` (classic scopes: ${scopes})` : " (fine-grained token)"}`
      : "token reaches the repository but has no write (push) access, so branch, commit and Pull Request lifecycle would fail",
    push: permissions.push === true,
    admin: permissions.admin === true,
  };
}

async function checkGithubActions({ token, repository, fetchImpl = fetch } = {}) {
  if (!present(token)) return { present: false, valid: false, detail: "not configured" };
  const [owner, repo] = String(repository || "").split("/");
  if (!owner || !repo) return { present: true, valid: false, detail: "repository must be provided as owner/repo" };
  const response = await fetchImpl(`https://api.github.com/repos/${owner}/${repo}/actions/workflows`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "siton-credential-preflight" },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) return { present: true, valid: false, detail: `Actions read failed: ${describeStatus(response.status)}; the parallel analysis swarm cannot be dispatched` };
  return { present: true, valid: true, detail: "Actions read confirmed; swarm dispatch requires Actions write, proven only by a real run" };
}

async function checkOpenAi({ apiKey, models = CODEX_MODELS, fetchImpl = fetch } = {}) {
  if (!present(apiKey)) return { present: false, valid: false, detail: "not configured", models: {} };
  const headers = { Authorization: `Bearer ${apiKey}` };
  const account = await fetchImpl("https://api.openai.com/v1/models", { headers, signal: AbortSignal.timeout(30000) });
  if (!account.ok) return { present: true, valid: false, detail: describeStatus(account.status), models: {} };
  const availability = {};
  for (const model of models) {
    const response = await fetchImpl(`https://api.openai.com/v1/models/${encodeURIComponent(model)}`, { headers, signal: AbortSignal.timeout(30000) });
    availability[model] = response.ok ? "available" : `unavailable (HTTP ${response.status})`;
  }
  return { present: true, valid: true, detail: "OpenAI credential accepted", models: availability };
}

async function checkAnthropic({ apiKey, fetchImpl = fetch } = {}) {
  if (!present(apiKey)) return { present: false, valid: false, detail: "not configured" };
  const response = await fetchImpl("https://api.anthropic.com/v1/models?limit=1", {
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) return { present: true, valid: false, detail: describeStatus(response.status) };
  return { present: true, valid: true, detail: "Anthropic API credential accepted" };
}

function claudeOauthStatus(token) {
  if (!present(token)) return { present: false, valid: false, detail: "not configured" };
  // A Claude Code OAuth token has no public metadata endpoint; presence is all a
  // preflight can honestly assert, and the action run is the real proof.
  return { present: true, valid: null, detail: "present; validity is proven only by a real claude-code-action run" };
}

function buildReport({ github, actions, openai, anthropic, oauth, repository }) {
  const claudeReady = anthropic.valid === true || oauth.present === true;
  const blockers = [];
  if (!github.present) blockers.push("SITON_AGENT_GITHUB_TOKEN is missing: the manager cannot create a branch, commit, push, open a Pull Request or report back to the issue.");
  else if (!github.valid) blockers.push(`SITON_AGENT_GITHUB_TOKEN is present but unusable: ${github.detail}`);
  if (github.present && !actions.valid) blockers.push(`SITON_AGENT_GITHUB_TOKEN cannot read Actions: ${actions.detail}`);
  if (!openai.present) blockers.push("OPENAI_API_KEY is missing: Codex builder, Codex reviewer and the four analysis lanes cannot run.");
  else if (!openai.valid) blockers.push(`OPENAI_API_KEY is present but unusable: ${openai.detail}`);
  if (!claudeReady) blockers.push("No Claude credential: set ANTHROPIC_API_KEY (recommended) or CLAUDE_CODE_OAUTH_TOKEN so Claude can act as builder or reviewer.");
  else if (anthropic.present && anthropic.valid === false) blockers.push(`ANTHROPIC_API_KEY is present but unusable: ${anthropic.detail}`);

  const unavailableModels = Object.entries(openai.models || {}).filter(([, state]) => state !== "available").map(([model]) => model);
  const warnings = [];
  for (const model of unavailableModels) {
    const tier = TIER_BY_MODEL[model] || model;
    warnings.push(`Codex model ${model} is not available to this account, so the ${tier} tier cannot run as routed.`);
  }
  if (anthropic.valid === true && oauth.present) warnings.push("Both Claude credentials are configured; the manager uses ANTHROPIC_API_KEY and ignores CLAUDE_CODE_OAUTH_TOKEN.");

  return {
    schema: "siton.credential-preflight.v1",
    repository: String(repository || "unknown"),
    checked_at: new Date().toISOString(),
    claude_auth_mode: anthropic.valid === true ? "api" : oauth.present ? "oauth" : "none",
    secrets: {
      SITON_AGENT_GITHUB_TOKEN: { present: github.present, valid: github.valid, detail: github.detail, actions_read: actions.valid === true },
      OPENAI_API_KEY: { present: openai.present, valid: openai.valid, detail: openai.detail },
      ANTHROPIC_API_KEY: { present: anthropic.present, valid: anthropic.valid, detail: anthropic.detail },
      CLAUDE_CODE_OAUTH_TOKEN: { present: oauth.present, valid: oauth.valid, detail: oauth.detail },
    },
    codex_models: openai.models || {},
    ready: blockers.length === 0,
    blockers,
    warnings,
  };
}

function renderMarkdown(report) {
  const mark = (state) => (state === true ? "PASS" : state === false ? "FAIL" : "UNKNOWN");
  const lines = [
    "## Siton cloud credential preflight",
    "",
    `Repository: ${report.repository}`,
    `Checked at: ${report.checked_at}`,
    `Overall: ${report.ready ? "READY" : "BLOCKED"}`,
    `Claude auth mode: ${report.claude_auth_mode}`,
    "",
    "| Secret | Present | Live check | Detail |",
    "| --- | --- | --- | --- |",
  ];
  for (const [name, state] of Object.entries(report.secrets)) {
    lines.push(`| \`${name}\` | ${state.present ? "yes" : "no"} | ${mark(state.valid)} | ${state.detail} |`);
  }
  if (Object.keys(report.codex_models).length) {
    lines.push("", "| Codex model | Tier | Availability |", "| --- | --- | --- |");
    for (const [model, state] of Object.entries(report.codex_models)) lines.push(`| \`${model}\` | ${TIER_BY_MODEL[model] || "unknown"} | ${state} |`);
  }
  if (report.blockers.length) {
    lines.push("", "### BLOCKER REQUIRES OWNER ACTION", "");
    for (const blocker of report.blockers) lines.push(`- ${blocker}`);
    lines.push("", "Add the missing secrets at https://github.com/" + report.repository + "/settings/secrets/actions, then re-run this preflight.");
  }
  if (report.warnings.length) {
    lines.push("", "### Warnings", "");
    for (const warning of report.warnings) lines.push(`- ${warning}`);
  }
  lines.push("", "No secret value is read back, printed or stored by this preflight.");
  return `${lines.join("\n")}\n`;
}

async function runPreflight(env = process.env, fetchImpl = fetch) {
  const repository = env.GITHUB_REPOSITORY;
  const token = env.SITON_AGENT_GITHUB_TOKEN;
  const [github, actions, openai, anthropic] = [
    await checkGithubToken({ token, repository, fetchImpl }),
    await checkGithubActions({ token, repository, fetchImpl }),
    await checkOpenAi({ apiKey: env.OPENAI_API_KEY, fetchImpl }),
    await checkAnthropic({ apiKey: env.ANTHROPIC_API_KEY, fetchImpl }),
  ];
  return buildReport({ github, actions, openai, anthropic, oauth: claudeOauthStatus(env.CLAUDE_CODE_OAUTH_TOKEN), repository });
}

async function main() {
  const [jsonPath = "credential-preflight.json", markdownPath = "credential-preflight.md"] = process.argv.slice(2);
  const secrets = SECRET_ENV_KEYS.map((key) => process.env[key]);
  let report;
  try {
    report = await runPreflight();
  } catch (error) {
    const message = scrub(error instanceof Error ? error.message : String(error), secrets);
    console.error(`CREDENTIAL_PREFLIGHT_ERROR ${message}`);
    process.exitCode = 1;
    return;
  }
  const json = scrub(`${JSON.stringify(report, null, 2)}\n`, secrets);
  const markdown = scrub(renderMarkdown(report), secrets);
  fs.writeFileSync(jsonPath, json, "utf8");
  fs.writeFileSync(markdownPath, markdown, "utf8");
  process.stdout.write(markdown);
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `ready=${report.ready ? "true" : "false"}\nclaude_auth_mode=${report.claude_auth_mode}\n`, "utf8");
  }
  // A blocked preflight is a reported condition, not a crash: the owner still
  // needs the report comment, so exit non-zero only after both files exist.
  if (!report.ready) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = {
  CODEX_MODELS,
  buildReport,
  checkAnthropic,
  checkGithubActions,
  checkGithubToken,
  checkOpenAi,
  claudeAuthMode,
  claudeOauthStatus,
  present,
  renderMarkdown,
  runPreflight,
  scrub,
};
