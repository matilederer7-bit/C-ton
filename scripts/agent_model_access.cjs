#!/usr/bin/env node
// Metadata access is a credential preflight, not proof of successful inference.
const MODELS = new Set(["gpt-6-luna", "gpt-6-sol", "gpt-6-astra"]);

async function verifyModelAccess({ apiKey, model, fetchImpl = fetch }) {
  if (!MODELS.has(model)) throw new Error("Unknown routed Codex model");
  if (!apiKey) throw new Error("OPENAI_API_KEY is required to verify model access");
  const response = await fetchImpl(`https://api.openai.com/v1/models/${encodeURIComponent(model)}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(30000),
  });
  // Do not log provider bodies, credentials or request headers.
  if (!response.ok) throw new Error(`Model access preflight failed for ${model}: HTTP ${response.status}; check API project access/billing. No downgrade performed.`);
  const result = await response.json();
  if (result.id !== model) throw new Error(`Model access response did not confirm ${model}`);
  return { model, metadataAccess: true, inferenceVerified: false };
}

if (require.main === module) {
  verifyModelAccess({ apiKey: process.env.OPENAI_API_KEY, model: process.env.SITON_CODEX_MODEL })
    .then(result => console.log(JSON.stringify(result)))
    .catch(() => {
      console.error("Codex model access preflight failed; verify OPENAI_API_KEY, project model permissions, billing and network. No downgrade performed.");
      process.exitCode = 1;
    });
}
module.exports = { verifyModelAccess };
