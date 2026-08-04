import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { runAuthorizationOnlyProof } from "./stripe_sandbox_authorization_only.js";
const proofScope = String(process.env.STRIPE_SANDBOX_PROOF_SCOPE || "");
if (proofScope !== "authorization-only") throw new Error("Unsupported or missing Stripe Sandbox proof scope");
const serverKey = String(process.env.PAYMENT_PROVIDER_API_KEY || "");
const publicKey = String(process.env.PAYMENT_PROVIDER_PUBLIC_KEY || "");
const webhookSecret = String(process.env.PAYMENT_WEBHOOK_SECRET || "");
if (!serverKey.startsWith("sk_test_") || !publicKey.startsWith("pk_test_") || !webhookSecret.startsWith("whsec_")) {
  console.log("Stripe Sandbox external verification not executed");
  process.exit(78);
}
if (serverKey.startsWith("sk_live_") || publicKey.startsWith("pk_live_")) throw new Error("Live Stripe credentials are forbidden");
Object.assign(process.env, {
  APP_DEPLOYMENT_MODE: "sandbox", PAYMENT_ENVIRONMENT: "sandbox", PAYMENT_PROVIDER: "stripe",
  PAYMENT_PROVIDER_MODE: "stripe", PAYMENT_PROVIDER_BASE_URL: "https://api.stripe.com",
  PAYMENT_WEBHOOK_PROVIDER: "stripe", PAYMENT_PROVIDER_TIMEOUT_MS: process.env.PAYMENT_PROVIDER_TIMEOUT_MS || "8000",
  STRIPE_ALLOW_SERVER_SIDE_CARD_TOKENIZATION: "0"
});
const { buildPaymentProvider } = await import("../src/payment_provider.js");
const provider = buildPaymentProvider();
if (provider.providerCode !== "stripe" || provider.mode !== "stripe" || !provider.configured || !provider.status) throw new Error("Stripe Test Mode provider is not configured");
function protectProviderReference(providerReference: string): string {
  const key = createHash("sha256").update(`siton-stripe-sandbox-handoff-v1:${webhookSecret}`).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(providerReference, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}
const report = await runAuthorizationOnlyProof({ provider, protectProviderReference });
const reportPath = String(process.env.STRIPE_SANDBOX_REPORT_PATH || "");
if (reportPath) {
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}
console.log(JSON.stringify(report));