#!/usr/bin/env node
// Tier-based model policy for every Siton agent (Claude sub-agents, the cloud
// manager's Claude steps and the Codex role).
//
// Policy is expressed as four compute tiers, never as hard-coded model
// versions:
//
//   economy  - cheap scans, inventories, simple checks
//   standard - ordinary development
//   senior   - database, security, payments, auth, state machine, architecture
//   apex     - explicitly escalated cross-system work only (see agent_router)
//
// Claude tiers resolve to the provider's stable aliases (`haiku`, `sonnet`,
// `opus`, `fable`). Claude Code maps each alias to the newest model of that
// family, so a model release never requires a code change here. A full
// `claude-*` identifier is accepted only as an explicit override
// (`SITON_CLAUDE_MODEL_<TIER>`), and it may never belong to a weaker family than
// the tier's default: sensitive work cannot be downgraded through
// configuration.
//
// Fallback is upward only and never into Apex: economy may fall back to
// standard, standard to senior. Senior and Apex have no fallback and fail
// closed when their model is unavailable. Nothing ever falls back to a cheaper
// model.
//
// Codex tiers keep exact OpenAI identifiers (OpenAI publishes no stable tier
// alias). They are centralized here and may be overridden per tier through
// `SITON_CODEX_MODEL_<TIER>` so a rename is a repository-variable change, not a
// code change.
//
// Controls: tests/release_tools/agent_model_tiers.test.cjs.

const TIER_ORDER = Object.freeze(["economy", "standard", "senior", "apex"]);

// Claude model families from weakest to strongest. The rank of a family is
// the minimum tier it may serve.
const CLAUDE_FAMILY_RANK = Object.freeze({ haiku: 0, sonnet: 1, opus: 2, fable: 3 });

const CLAUDE_TIER_ALIASES = Object.freeze({ economy: "haiku", standard: "sonnet", senior: "opus", apex: "fable" });

const CODEX_TIER_MODELS = Object.freeze({ economy: "gpt-5.6-luna", standard: "gpt-5.6-terra", senior: "gpt-5.6-sol", apex: "gpt-6-astra" });

// Tiers whose model must never be replaced by anything else automatically.
const NO_FALLBACK_TIERS = new Set(["senior", "apex"]);

const CLAUDE_ID = /^claude-(haiku|sonnet|opus|fable)(-[0-9]+)+(-[0-9]{8})?$/;
const CODEX_ID = /^[a-z0-9][a-z0-9.-]{1,63}$/;

function assertTier(tier) {
  if (!TIER_ORDER.includes(tier)) throw new Error(`unknown model tier: ${tier}`);
}

function tierRank(tier) {
  assertTier(tier);
  return TIER_ORDER.indexOf(tier);
}

// Family of a Claude alias or full identifier, or null when unrecognized.
function claudeFamily(model) {
  const value = String(model || "").trim();
  if (Object.hasOwn(CLAUDE_FAMILY_RANK, value)) return value;
  const match = CLAUDE_ID.exec(value);
  return match ? match[1] : null;
}

function envKey(prefix, tier) {
  return `${prefix}_${tier.toUpperCase()}`;
}

// The Claude model a tier requests: the stable alias, or a validated override.
function claudeModelForTier(tier, env = process.env) {
  assertTier(tier);
  const override = String(env[envKey("SITON_CLAUDE_MODEL", tier)] || "").trim();
  if (!override) return CLAUDE_TIER_ALIASES[tier];
  const family = claudeFamily(override);
  if (!family) throw new Error(`${envKey("SITON_CLAUDE_MODEL", tier)} is not a Claude alias or claude-<family>-<version> identifier`);
  if (CLAUDE_FAMILY_RANK[family] < CLAUDE_FAMILY_RANK[CLAUDE_TIER_ALIASES[tier]]) {
    throw new Error(`${envKey("SITON_CLAUDE_MODEL", tier)}=${override} would downgrade the ${tier} tier below ${CLAUDE_TIER_ALIASES[tier]}; refused`);
  }
  return override;
}

function codexModelForTier(tier, env = process.env) {
  assertTier(tier);
  const override = String(env[envKey("SITON_CODEX_MODEL", tier)] || "").trim();
  if (!override) return CODEX_TIER_MODELS[tier];
  if (!CODEX_ID.test(override)) throw new Error(`${envKey("SITON_CODEX_MODEL", tier)} is not a valid model identifier`);
  return override;
}

// Tiers a request may fall back to, in order. Upward only, never into Apex,
// and none at all for Senior and Apex.
function fallbackTiers(tier) {
  assertTier(tier);
  if (NO_FALLBACK_TIERS.has(tier)) return [];
  const next = TIER_ORDER[tierRank(tier) + 1];
  return next && next !== "apex" ? [next] : [];
}

// Resolve a tier to a concrete Claude model.
// `available` (optional) is the set of aliases/identifiers known to work in
// the current environment. Without it, the alias is returned as is and the
// fallback list is handed to Claude Code (`--fallback-model`).
function resolveClaudeModel(tier, { env = process.env, available } = {}) {
  assertTier(tier);
  const requested = claudeModelForTier(tier, env);
  const fallbacks = fallbackTiers(tier).map((next) => claudeModelForTier(next, env));
  if (!available) return { tier, model: requested, requested, fallbacks, fellBack: false };
  const has = (model) => available.has(model);
  if (has(requested)) return { tier, model: requested, requested, fallbacks, fellBack: false };
  const upward = fallbacks.find(has);
  if (upward) return { tier, model: upward, requested, fallbacks, fellBack: true };
  throw new Error(`no available Claude model for the ${tier} tier (requested ${requested}${fallbacks.length ? `, fallbacks ${fallbacks.join(", ")}` : ", no fallback allowed"}); refusing to downgrade`);
}

// A reviewer is never cheaper than Standard: review is a correctness gate,
// not a scan.
function reviewerTier(tier) {
  assertTier(tier);
  return tierRank(tier) < tierRank("standard") ? "standard" : tier;
}

// Command-line arguments for Claude Code / claude-code-action.
function claudeModelArgs(tier, env = process.env) {
  const { model, fallbacks } = resolveClaudeModel(tier, { env });
  return fallbacks.length ? `--model ${model} --fallback-model ${fallbacks.join(",")}` : `--model ${model}`;
}

// Claude sub-agent definitions in .claude/agents/ and the tier each one
// serves. The frontmatter `model:` must equal the tier alias; the test suite
// enforces it so the definitions never drift back to pinned versions.
const AGENT_TIERS = Object.freeze({
  "repo-scout": "economy",
  "status-keeper": "economy",
  "frontend-ux": "standard",
  "test-engineer": "standard",
  "devops-release": "standard",
  "codex-liaison": "standard",
  "backend-core": "senior",
  "db-migrations": "senior",
  "payments-money": "senior",
  "security-auditor": "senior",
});

function agentFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(String(text));
  if (!match) throw new Error("agent definition has no frontmatter");
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (field) fields[field[1]] = field[2].trim();
  }
  return fields;
}

// Validate agent definitions: { name: text } -> list of findings.
function checkAgentDefinitions(definitions) {
  const findings = [];
  const names = Object.keys(definitions).sort();
  for (const name of names) {
    let fields;
    try {
      fields = agentFrontmatter(definitions[name]);
    } catch (error) {
      findings.push(`${name}: ${error.message}`);
      continue;
    }
    if (fields.name !== name) findings.push(`${name}: frontmatter name is ${fields.name || "missing"}`);
    const tier = AGENT_TIERS[name];
    if (!tier) {
      findings.push(`${name}: not assigned a tier in scripts/agent_model_tiers.cjs AGENT_TIERS`);
      continue;
    }
    const expected = CLAUDE_TIER_ALIASES[tier];
    if (fields.model !== expected) findings.push(`${name}: model must be the ${tier} alias "${expected}", found "${fields.model || "missing"}" (no pinned versions, no inherit)`);
  }
  for (const name of Object.keys(AGENT_TIERS)) if (!names.includes(name)) findings.push(`${name}: listed in AGENT_TIERS but has no .claude/agents/${name}.md`);
  return findings;
}

function readAgentDefinitions(dir) {
  const fs = require("node:fs");
  const path = require("node:path");
  const definitions = {};
  for (const file of fs.readdirSync(dir).filter((entry) => entry.endsWith(".md")).sort()) {
    definitions[file.slice(0, -3)] = fs.readFileSync(path.join(dir, file), "utf8");
  }
  return definitions;
}

function main(argv) {
  const [command] = argv;
  if (command === "table") {
    for (const tier of TIER_ORDER) {
      const { model, fallbacks } = resolveClaudeModel(tier);
      console.log(`${tier}\tclaude=${model}\tfallback=${fallbacks.join(",") || "none"}\tcodex=${codexModelForTier(tier)}`);
    }
    return 0;
  }
  if (command === "check-agents") {
    const path = require("node:path");
    const findings = checkAgentDefinitions(readAgentDefinitions(path.resolve(argv[1] || ".claude/agents")));
    for (const finding of findings) console.log(`AGENT_MODEL_FINDING ${finding}`);
    console.log(findings.length ? "AGENT_MODEL_FAIL" : "AGENT_MODEL_PASS");
    return findings.length ? 1 : 0;
  }
  console.log("agent_model_tiers.cjs table | check-agents [dir]");
  return command ? 2 : 0;
}

module.exports = {
  AGENT_TIERS,
  CLAUDE_FAMILY_RANK,
  CLAUDE_TIER_ALIASES,
  CODEX_TIER_MODELS,
  TIER_ORDER,
  agentFrontmatter,
  checkAgentDefinitions,
  claudeFamily,
  claudeModelArgs,
  claudeModelForTier,
  codexModelForTier,
  fallbackTiers,
  readAgentDefinitions,
  resolveClaudeModel,
  reviewerTier,
  tierRank,
};

if (require.main === module) process.exit(main(process.argv.slice(2)));
