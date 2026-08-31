export type RuntimeRole = "web" | "worker";

function productionMode(env: NodeJS.ProcessEnv) {
  return ["production", "prod", "commercial-live"].includes(
    String(env.APP_DEPLOYMENT_MODE || env.APP_ENV || "").trim().toLowerCase()
  );
}

export function assertProductionRuntimeGuards(role: RuntimeRole, env: NodeJS.ProcessEnv = process.env) {
  const failures: string[] = [];
  const storageMode = String(env.STORAGE_ADAPTER || "local").trim().toLowerCase();
  if (["object", "s3"].includes(storageMode)) {
    const required = ["OBJECT_STORAGE_REGION", "OBJECT_STORAGE_BUCKET", "OBJECT_STORAGE_ACCESS_KEY_ID", "OBJECT_STORAGE_SECRET_ACCESS_KEY"];
    const placeholder = /^(placeholder|changeme|test|example|dummy|xxx|ci-placeholder)/i;
    for (const name of required) {
      const value = String(env[name] || "").trim();
      if (!value) failures.push(`${name} is required for external storage`);
      else if (placeholder.test(value)) failures.push(`${name} cannot use a placeholder value`);
    }
  }
  const paymentProvider = String(env.PAYMENT_PROVIDER || "").trim().toLowerCase();
  const paymentMode = String(env.PAYMENT_PROVIDER_MODE || "").trim().toLowerCase();
  const paymentEnvironment = String(env.PAYMENT_ENVIRONMENT || "").trim().toLowerCase();
  const apiKey = String(env.PAYMENT_PROVIDER_API_KEY || "").trim();
  const publicKey = String(env.PAYMENT_PROVIDER_PUBLIC_KEY || "").trim();
  const webhookSecret = String(env.PAYMENT_WEBHOOK_SECRET || "").trim();
  const placeholder = /^(placeholder|changeme|example|dummy|xxx|ci-placeholder|sk_test_or_live|pk_test_or_live)/i;
  const sandboxRuntime = ["sandbox", "test"].includes(paymentEnvironment) || ["sandbox", "payment-sandbox"].includes(String(env.APP_DEPLOYMENT_MODE || "").trim().toLowerCase());

  if (sandboxRuntime && paymentProvider === "stripe") {
    if (paymentMode !== "stripe") failures.push("Stripe Sandbox requires PAYMENT_PROVIDER_MODE=stripe");
    if (!apiKey || !apiKey.startsWith("sk_test_")) failures.push("Stripe Sandbox requires a sk_test_ PAYMENT_PROVIDER_API_KEY");
    if (role === "web" && (!publicKey || !publicKey.startsWith("pk_test_"))) failures.push("Stripe Sandbox web requires a pk_test_ PAYMENT_PROVIDER_PUBLIC_KEY");
    if (role === "web" && (!webhookSecret || !webhookSecret.startsWith("whsec_") || placeholder.test(webhookSecret))) failures.push("Stripe Sandbox web requires a non-placeholder PAYMENT_WEBHOOK_SECRET");
    if (apiKey.startsWith("sk_live_") || (role === "web" && publicKey.startsWith("pk_live_"))) failures.push("Sandbox cannot use live Stripe credentials");
  }

  // A declared runtime role must match the starting process in every mode:
  // a staging Worker configured as web (or vice versa) must fail closed at
  // boot, not only in production.
  const configuredRole = String(env.RUNTIME_ROLE || "").toLowerCase();
  if (configuredRole && configuredRole !== role) failures.push(`RUNTIME_ROLE=${configuredRole} cannot start the ${role} process`);

  if (!productionMode(env)) {
    if (failures.length) throw new Error(`external storage runtime guard failed: ${failures.join("; ")}`);
    return;
  }
  const storage = storageMode;

  if (!configuredRole) failures.push("RUNTIME_ROLE is required in production");
  if (!paymentProvider) failures.push("PAYMENT_PROVIDER is required in production");
  if (paymentProvider === "mock" || paymentProvider === "mockpay") failures.push("production cannot use a mock PAYMENT_PROVIDER");
  if (["sandbox", "test", "demo"].includes(paymentEnvironment)) failures.push("production cannot use PAYMENT_ENVIRONMENT=sandbox/test/demo");
  if (apiKey.startsWith("sk_test_") || publicKey.startsWith("pk_test_")) failures.push("production cannot use Stripe test credentials");
  if (paymentProvider === "stripe") {
    if (paymentMode !== "stripe") failures.push("PAYMENT_PROVIDER=stripe requires PAYMENT_PROVIDER_MODE=stripe");
    if (!apiKey.startsWith("sk_live_") || placeholder.test(apiKey)) failures.push("production Stripe requires a non-placeholder sk_live_ PAYMENT_PROVIDER_API_KEY");
    if (role === "web" && (!publicKey.startsWith("pk_live_") || placeholder.test(publicKey))) failures.push("production Stripe web requires a non-placeholder pk_live_ PAYMENT_PROVIDER_PUBLIC_KEY");
    const baseUrl = String(env.PAYMENT_PROVIDER_BASE_URL || "https://api.stripe.com").trim().replace(/\/+$/, "");
    if (baseUrl !== "https://api.stripe.com") failures.push("production Stripe requires the canonical https://api.stripe.com endpoint");
  }
  if (paymentMode === "mock" || paymentMode === "mock-backed") failures.push("production cannot use PAYMENT_PROVIDER_MODE=mock-backed");
  if (storage !== "object") failures.push("production requires STORAGE_ADAPTER=object");
  if (!env.DATABASE_URL) failures.push("DATABASE_URL is required in production");
  if (!env.ADMIN_API_KEY) failures.push("ADMIN_API_KEY is required in production");
  if (!env.SELLER_SESSION_SECRET) failures.push("SELLER_SESSION_SECRET is required in production");
  if (role === "web" && (!webhookSecret || placeholder.test(webhookSecret))) failures.push("a non-placeholder PAYMENT_WEBHOOK_SECRET is required for the production web role");
  if (role === "web" && env.DISABLE_OUTBOX_WORKER !== "1") failures.push("production web requires DISABLE_OUTBOX_WORKER=1");

  if (failures.length) throw new Error(`production runtime guard failed: ${failures.join("; ")}`);
}
