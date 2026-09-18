export type RuntimeRole = "web" | "worker";

function productionMode(env: NodeJS.ProcessEnv) {
  return ["production", "prod", "commercial-live"].includes(
    String(env.APP_DEPLOYMENT_MODE || env.APP_ENV || "").trim().toLowerCase()
  );
}

// A hosted platform deployment, as opposed to a local container/lab stack.
// Render sets all three of these on every service it runs; nothing in
// docker-compose.yml / .ci.yml / .release-lab.yml does.
function hostedPlatformDeployment(env: NodeJS.ProcessEnv) {
  return (
    String(env.RENDER || "").trim().length > 0 ||
    String(env.RENDER_EXTERNAL_URL || "").trim().length > 0 ||
    String(env.RENDER_SERVICE_ID || "").trim().length > 0
  );
}

// Deployment modes that switch on demo/preview behaviour: demo seller context,
// mock payment routes, the demo webhook secret. Legal locally, never on a
// hosted host.
const DEMO_DEPLOYMENT_MODES = ["demo-preview", "demo", "preview", "local", "development", "dev", "test"];

// The literal fallbacks the runtime uses when a secret is absent. They are in
// the public repository, so a production runtime must never end up on one.
const PUBLIC_DEFAULT_SECRETS = new Set(["siton-otp-salt-default", "siton-otp-token-secret-default", "siton-buyer-session-local-only"]);

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
  if (storageMode === "supabase") {
    const placeholder = /^(placeholder|changeme|example|dummy|xxx|ci-placeholder)/i;
    for (const name of ["SUPABASE_URL", "SITON_STORAGE_BROKER_KEY"]) {
      const value = String(env[name] || "").trim();
      if (!value) failures.push(`${name} is required for supabase storage`);
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

  // Provider environment separation (provider-neutral):
  // - live provider environment is only legal on a production deployment;
  // - a real provider name outside its matching environment fails closed.
  if (!productionMode(env) && paymentEnvironment === "live") {
    failures.push("PAYMENT_ENVIRONMENT=live is only legal in production deployment mode");
  }
  if (paymentProvider === "grow") {
    if (!["sandbox", "live"].includes(paymentEnvironment)) {
      failures.push("PAYMENT_PROVIDER=grow requires PAYMENT_ENVIRONMENT=sandbox or PAYMENT_ENVIRONMENT=live");
    }
    const growRequired: Array<[string, string]> = [
      ["GROW_USER_ID", String(env.GROW_USER_ID || "").trim()],
      ["GROW_PAGE_CODE", String(env.GROW_PAGE_CODE || "").trim()],
      ["GROW_REFERENCE_ENCRYPTION_KEY", String(env.GROW_REFERENCE_ENCRYPTION_KEY || "").trim()]
    ];
    for (const [name, value] of growRequired) {
      if (!value) failures.push(`${name} is required when PAYMENT_PROVIDER=grow`);
      else if (placeholder.test(value)) failures.push(`${name} cannot use a placeholder value`);
    }
    if (String(env.GROW_REFERENCE_ENCRYPTION_KEY || "").trim().length > 0 && String(env.GROW_REFERENCE_ENCRYPTION_KEY || "").trim().length < 32) {
      failures.push("GROW_REFERENCE_ENCRYPTION_KEY must be at least 32 characters");
    }
    const baseUrl = String(env.PAYMENT_PROVIDER_BASE_URL || "").trim();
    if (!baseUrl.startsWith("https://")) failures.push("PAYMENT_PROVIDER=grow requires an https PAYMENT_PROVIDER_BASE_URL");
    // Sandbox/live separation is bidirectional and fail-closed: sandbox may
    // only target the official Grow sandbox host, and live may never target
    // it. Credentials for one environment cannot operate against the other.
    let growHost = "";
    try { growHost = new URL(baseUrl).hostname.toLowerCase(); } catch { growHost = ""; }
    if (paymentEnvironment === "sandbox" && growHost !== "sandbox.meshulam.co.il") {
      failures.push("PAYMENT_ENVIRONMENT=sandbox with PAYMENT_PROVIDER=grow requires the official sandbox.meshulam.co.il base URL");
    }
    if (paymentEnvironment === "live" && growHost !== "secure.meshulam.co.il") {
      failures.push(
        growHost === "sandbox.meshulam.co.il"
          ? "PAYMENT_ENVIRONMENT=live with PAYMENT_PROVIDER=grow cannot use the sandbox.meshulam.co.il base URL; live requires the official secure.meshulam.co.il base URL"
          : "PAYMENT_ENVIRONMENT=live with PAYMENT_PROVIDER=grow requires the official secure.meshulam.co.il base URL"
      );
    }
    for (const name of ["GROW_SUCCESS_URL", "GROW_CANCEL_URL", "GROW_NOTIFY_URL"]) {
      const value = String(env[name] || "").trim();
      if (!value.startsWith("https://")) failures.push(`${name} must be an https URL when PAYMENT_PROVIDER=grow`);
    }
  }

  // Real communications delivery is not implemented in R9A; requesting it must
  // fail closed instead of silently degrading to the log provider.
  const notificationMode = String(env.NOTIFICATION_PROVIDER_MODE || "").trim().toLowerCase();
  const notificationProvider = String(env.NOTIFICATION_PROVIDER || "").trim().toLowerCase();
  const deliveryEnabled = String(env.NOTIFICATION_DELIVERY_ENABLED || "").trim() === "1";
  if (notificationMode === "real" && !["log", "log-only", ""].includes(notificationProvider)) {
    failures.push("NOTIFICATION_PROVIDER_MODE=real requires a verified real notification adapter; none is implemented");
  }
  if (deliveryEnabled && notificationMode !== "real") {
    failures.push("NOTIFICATION_DELIVERY_ENABLED=1 requires NOTIFICATION_PROVIDER_MODE=real");
  }

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

  // RUNTIME GAP CLOSED - production_demo_deployment_mode_bypass.
  // Every production control below hangs off productionMode(), which reads one
  // variable. The Docker image defaults APP_DEPLOYMENT_MODE to demo-preview, so
  // a hosted service whose console never declared it boots as a demo - demo
  // seller context and mock payment routes on the real hostname - with every
  // guard below silently switched off and nothing at runtime to say so. On a
  // hosted platform the mode must therefore be declared explicitly and must not
  // be a demo/preview mode. Local compose stacks carry no hosted marker.
  const deploymentMode = String(env.APP_DEPLOYMENT_MODE || env.APP_ENV || "").trim().toLowerCase();
  if (hostedPlatformDeployment(env)) {
    if (!deploymentMode) {
      failures.push("APP_DEPLOYMENT_MODE must be declared explicitly on a hosted deployment (the image default is demo-preview)");
    } else if (DEMO_DEPLOYMENT_MODES.includes(deploymentMode)) {
      failures.push(`APP_DEPLOYMENT_MODE=${deploymentMode} is a demo/preview mode and cannot run on a hosted deployment`);
    }
  }

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
  if (paymentProvider === "grow" && paymentEnvironment !== "live") {
    failures.push("production PAYMENT_PROVIDER=grow requires PAYMENT_ENVIRONMENT=live");
  }
  // VAT authority fails closed for real money: production charging may not run
  // on synthetic_zero VAT. Rates are business/legal input, never code-invented.
  if (String(env.SITON_VAT_MODE || "").trim().toLowerCase() !== "explicit") {
    failures.push("production requires SITON_VAT_MODE=explicit with authoritative SITON_VAT_RATE_PRODUCT/SITON_VAT_RATE_DELIVERY");
  }
  if (!["object", "supabase"].includes(storage)) failures.push("production requires STORAGE_ADAPTER=object or STORAGE_ADAPTER=supabase");
  if (!env.DATABASE_URL) failures.push("DATABASE_URL is required in production");
  if (!env.ADMIN_API_KEY) failures.push("ADMIN_API_KEY is required in production");
  if (!env.SELLER_SESSION_SECRET) failures.push("SELLER_SESSION_SECRET is required in production");
  if (role === "web" && (!webhookSecret || placeholder.test(webhookSecret))) failures.push("a non-placeholder PAYMENT_WEBHOOK_SECRET is required for the production web role");
  if (role === "web" && env.DISABLE_OUTBOX_WORKER !== "1") failures.push("production web requires DISABLE_OUTBOX_WORKER=1");

  // RUNTIME GAPS CLOSED - the five remaining startup-config gaps that until now
  // only the PRE-DEPLOY release gate refused. A hosting console can change any
  // of these long after that gate last ran, so the boot guard has to be the one
  // that fails closed.
  const adminApiKey = String(env.ADMIN_API_KEY || "").trim();
  // production_unsafe_admin_key: presence alone let the published demo key
  // through and it is the admin bootstrap credential.
  if (adminApiKey && (placeholder.test(adminApiKey) || /^demo-admin-key/i.test(adminApiKey) || adminApiKey.length < 24)) {
    failures.push("ADMIN_API_KEY must be a non-placeholder secret of at least 24 characters in production");
  }
  // Same defect class, same consequence: SELLER_SESSION_SECRET signs seller
  // sessions, so a placeholder value means forgeable seller authority. The
  // guard previously checked only that it was present.
  const sellerSessionSecret = String(env.SELLER_SESSION_SECRET || "").trim();
  if (sellerSessionSecret && (placeholder.test(sellerSessionSecret) || PUBLIC_DEFAULT_SECRETS.has(sellerSessionSecret) || sellerSessionSecret.length < 32)) {
    failures.push("SELLER_SESSION_SECRET must be a non-placeholder secret of at least 32 characters in production");
  }
  // production_legacy_tracking_links: re-enables anonymous participant tracking
  // links (buyer PII behind a guessable-by-leak participant id) in production.
  if (String(env.TRACKING_LEGACY_COMPAT || "").trim() === "1") {
    failures.push("TRACKING_LEGACY_COMPAT=1 cannot run in production: it re-enables anonymous participant tracking links");
  }
  // production_debug_surfaces: exposes /debug/* on the production hostname.
  if (String(env.DEBUG_SURFACES_ENABLED || "").trim() === "1") {
    failures.push("DEBUG_SURFACES_ENABLED=1 cannot run in production");
  }
  // production_otp_bypass: src/otp_rail.ts already ignores the bypass when
  // production-like, but "production mode" and "production-like" are two
  // different predicates - a configuration can satisfy one and not the other -
  // and the variable must not linger in a production console regardless.
  if (String(env.OTP_TEST_BYPASS_CODE || "").trim()) {
    failures.push("OTP_TEST_BYPASS_CODE cannot be present in production");
  }
  // production_service_role_key_present: the full-RLS-bypass Supabase key. No
  // application code reads it, so its presence is pure custody risk.
  if (String(env.SUPABASE_SERVICE_ROLE_KEY || "").trim()) {
    failures.push("SUPABASE_SERVICE_ROLE_KEY must not be present in the production runtime environment");
  }
  // OTP_HASH_SALT_DEFAULT_IN_PRODUCTION: src/otp_rail.ts falls back to a literal
  // that is published in this repository. A six-digit OTP hashed with a public
  // salt is recoverable from any read of the challenge table in ~10^6 HMACs.
  const otpHashSalt = String(env.OTP_HASH_SALT || "").trim();
  if (!otpHashSalt) failures.push("OTP_HASH_SALT is required in production (the runtime otherwise hashes OTP codes with a public default salt)");
  else if (PUBLIC_DEFAULT_SECRETS.has(otpHashSalt) || placeholder.test(otpHashSalt)) failures.push("OTP_HASH_SALT must not be a placeholder or the public default salt");

  if (failures.length) throw new Error(`production runtime guard failed: ${failures.join("; ")}`);
}
