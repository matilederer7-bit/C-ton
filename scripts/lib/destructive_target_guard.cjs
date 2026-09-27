// Guardrail for scripts that DROP, DELETE or overwrite database content.
//
// Black-Sky (human error / wrong environment): an operator who pastes a
// production DATABASE_URL into a shell, or leaves one in .env, must not be able
// to drop or reseed the hosted database with a local convenience script. These
// scripts are local/lab tools. They refuse:
//   * any deployment marker that says the process is staging or production;
//   * any non-local PostgreSQL host, unless the caller names the exact host in
//     SITON_DESTRUCTIVE_ALLOWED_HOSTS (never set this for a hosted database).
// The refusal never prints the connection string (it may carry a password).
const isolation = require("./test_db_isolation.cjs");

const HOSTED_DEPLOYMENT_MODES = new Set(["staging", "production", "live"]);

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    throw new Error("destructive guard: DATABASE_URL is not a valid URL");
  }
}

function assertDestructiveTargetAllowed(url, { action, env = process.env } = {}) {
  const label = action || "destructive database action";
  if (!url) throw new Error(`${label} refused: DATABASE_URL is not set`);
  const mode = String(env.APP_DEPLOYMENT_MODE || "").trim().toLowerCase();
  const paymentEnv = String(env.PAYMENT_ENVIRONMENT || "").trim().toLowerCase();
  if (HOSTED_DEPLOYMENT_MODES.has(mode) || paymentEnv === "live" || paymentEnv === "production") {
    throw new Error(`${label} refused: APP_DEPLOYMENT_MODE=${mode || "(unset)"} PAYMENT_ENVIRONMENT=${paymentEnv || "(unset)"} marks a hosted environment`);
  }
  const host = hostOf(url);
  const extra = String(env.SITON_DESTRUCTIVE_ALLOWED_HOSTS || "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
  try {
    isolation.assertLocalBase(url);
    return { host };
  } catch {
    if (extra.includes(host)) return { host, explicitlyAllowed: true };
    throw new Error(`${label} refused: host '${host}' is not a local PostgreSQL host (name it in SITON_DESTRUCTIVE_ALLOWED_HOSTS only for a disposable lab database)`);
  }
}

module.exports = { assertDestructiveTargetAllowed, HOSTED_DEPLOYMENT_MODES };
