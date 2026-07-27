const { readFileSync } = require("node:fs");

const reportPath = process.argv[2];
if (!reportPath) throw new Error("Filtered Stripe Sandbox report path is required");
const raw = readFileSync(reportPath, "utf8");
const report = JSON.parse(raw);
const allowed = new Set([
  "external_verification", "stripe_mode", "authorization", "capture_executed",
  "refund_executed", "idempotent_replay", "payload_mismatch", "decline",
  "status_after_release", "provider_reference_sha256_prefix"
]);
for (const key of Object.keys(report)) {
  if (!allowed.has(key)) throw new Error(`Unexpected field in filtered report: ${key}`);
}
if (/sk_(?:test|live)_|pk_(?:test|live)_|whsec_|(?:^|[^A-Za-z0-9_])(?:pi|pm|ch|re|cus)_[A-Za-z0-9]+|\b\d{12,19}\b/i.test(raw)) {
  throw new Error("Filtered report contains forbidden secret, provider identifier, or card-like data");
}
if (!/^[a-f0-9]{12}$/.test(String(report.provider_reference_sha256_prefix || ""))) {
  throw new Error("Filtered provider reference must be a 12-character SHA-256 prefix");
}
console.log("PASS Stripe Sandbox artifact is allow-listed and secret-safe");