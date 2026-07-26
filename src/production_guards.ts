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
  if (!productionMode(env)) {
    if (failures.length) throw new Error(`external storage runtime guard failed: ${failures.join("; ")}`);
    return;
  }
  const paymentProvider = String(env.PAYMENT_PROVIDER || "").toLowerCase();
  const paymentMode = String(env.PAYMENT_PROVIDER_MODE || "").toLowerCase();
  const storage = storageMode;
  const configuredRole = String(env.RUNTIME_ROLE || "").toLowerCase();

  if (!configuredRole) failures.push("RUNTIME_ROLE is required in production");
  if (configuredRole && configuredRole !== role) failures.push(`RUNTIME_ROLE=${configuredRole} cannot start the ${role} process`);
  if (paymentProvider === "mock" || paymentProvider === "mockpay") failures.push("production cannot use a mock PAYMENT_PROVIDER");
  if (paymentMode === "mock" || paymentMode === "mock-backed") failures.push("production cannot use PAYMENT_PROVIDER_MODE=mock-backed");
  if (storage !== "object") failures.push("production requires STORAGE_ADAPTER=object");
  if (!env.DATABASE_URL) failures.push("DATABASE_URL is required in production");
  if (!env.ADMIN_API_KEY) failures.push("ADMIN_API_KEY is required in production");
  if (!env.SELLER_SESSION_SECRET) failures.push("SELLER_SESSION_SECRET is required in production");
  if (!env.PAYMENT_WEBHOOK_SECRET) failures.push("PAYMENT_WEBHOOK_SECRET is required in production");
  if (role === "web" && env.DISABLE_OUTBOX_WORKER !== "1") failures.push("production web requires DISABLE_OUTBOX_WORKER=1");
  if (role === "worker" && configuredRole === "web") failures.push("worker cannot start with the web runtime role");

  if (failures.length) throw new Error(`production runtime guard failed: ${failures.join("; ")}`);
}
