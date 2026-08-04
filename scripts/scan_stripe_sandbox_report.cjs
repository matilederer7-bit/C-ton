const { readFileSync } = require("node:fs");
const reportPath = process.argv[2];
if (!reportPath) throw new Error("Filtered Stripe Sandbox report path is required");
const raw = readFileSync(reportPath, "utf8");
const report = JSON.parse(raw);
const allowed = new Set([
  "external_verification", "proof_scope", "stripe_mode", "authorization", "authorization_state",
  "capture_executed", "refund_executed", "release_executed", "idempotent_replay", "payload_mismatch",
  "decline", "amount_minor", "currency", "created_at", "sandbox_run_id",
  "idempotency_reference_sha256_prefix", "protected_provider_reference"
]);
for (const key of Object.keys(report)) if (!allowed.has(key)) throw new Error(`Unexpected field in filtered report: ${key}`);
if (/sk_(?:test|live)_|pk_(?:test|live)_|whsec_|(?:^|[^A-Za-z0-9_])(?:pi|pm|ch|re|cus)_[A-Za-z0-9]+|\b\d{12,19}\b/i.test(raw)) {
  throw new Error("Filtered report contains forbidden secret, provider identifier, or card-like data");
}
if (report.proof_scope !== "authorization-only" || report.release_executed !== false || report.capture_executed !== false || report.refund_executed !== false) {
  throw new Error("Filtered report is not an authorization-only proof");
}
if (!/^[a-f0-9]{12}$/.test(String(report.sandbox_run_id || "")) || !/^[a-f0-9]{12}$/.test(String(report.idempotency_reference_sha256_prefix || ""))) {
  throw new Error("Filtered internal references must be 12-character SHA-256 prefixes");
}
if (!/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(String(report.protected_provider_reference || ""))) {
  throw new Error("Protected provider-reference handoff is malformed");
}
console.log("PASS Stripe Sandbox authorization-only artifact is allow-listed and secret-safe");