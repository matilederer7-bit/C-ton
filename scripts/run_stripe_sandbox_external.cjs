const { spawnSync } = require("node:child_process");

const serverKey = String(process.env.PAYMENT_PROVIDER_API_KEY || "");
const publicKey = String(process.env.PAYMENT_PROVIDER_PUBLIC_KEY || "");
const webhookSecret = String(process.env.PAYMENT_WEBHOOK_SECRET || "");
if (!serverKey.startsWith("sk_test_") || !publicKey.startsWith("pk_test_") || !webhookSecret.startsWith("whsec_")) {
  console.log("Stripe Sandbox external verification not executed");
  process.exit(78);
}
if (serverKey.startsWith("sk_live_") || publicKey.startsWith("pk_live_")) {
  console.error("Live Stripe credentials are forbidden");
  process.exit(1);
}
const result = spawnSync(process.platform === "win32" ? "npx.cmd" : "npx", ["tsx", "external-tests/stripe_sandbox_authorization_release.ts"], {
  stdio: "inherit",
  env: process.env,
  shell: false
});
if (result.error) {
  console.error("Stripe Sandbox external harness could not start");
  process.exit(1);
}
process.exit(result.status ?? 1);