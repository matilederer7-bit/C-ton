#!/usr/bin/env node
// Runtime access preflight: a tiny real inference catches quota/billing failures that model metadata cannot.
const { TIER_ORDER, codexModelForTier } = require("./agent_model_tiers.cjs");

// Only models the tier policy can route to (including per-tier overrides).
function routedModels(env = process.env) {
  return new Set(TIER_ORDER.map((tier) => codexModelForTier(tier, env)));
}

async function verifyModelAccess({ apiKey, model, fetchImpl = fetch, env = process.env }) {
  if (!routedModels(env).has(model)) throw new Error("Unknown routed Codex model");
  if (!apiKey) throw new Error("OPENAI_API_KEY is required to verify model access");
  // Metadata access does not prove that the project can actually spend tokens.
  // Make one tiny Responses API call so quota/billing/rate-limit failures are
  // detected before a builder is scheduled.
  const response = await fetchImpl("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: "Reply exactly OK.",
      reasoning: { effort: "none" },
      max_output_tokens: 4,
      store: false,
    }),
    signal: AbortSignal.timeout(30000),
  });
  // Never read or log provider bodies: status is enough to prove runtime
  // availability and avoids leaking provider diagnostics into CI.
  if (!response.ok) throw new Error(`Codex inference preflight failed for ${model}: HTTP ${response.status}; check API project access, billing/quota or rate limits. No downgrade performed.`);
  return { model, metadataAccess: true, inferenceVerified: true };
}

if (require.main === module) {
  verifyModelAccess({ apiKey: process.env.OPENAI_API_KEY, model: process.env.SITON_CODEX_MODEL })
    .then(result => console.log(JSON.stringify(result)))
    .catch(() => {
      console.error("Codex inference preflight failed; verify OPENAI_API_KEY, project model permissions, billing/quota, rate limits and network. No downgrade performed.");
      process.exitCode = 1;
    });
}
module.exports = { routedModels, verifyModelAccess };
