const { spawnSync } = require("node:child_process");
const path = require("node:path");
require("dotenv").config({ quiet: true });

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required; the rehearsal creates and destroys isolated test databases only.");
  process.exit(2);
}
const rehearsalDatabase = new URL(process.env.DATABASE_URL);
if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(rehearsalDatabase.hostname)) {
  console.error("Launch rehearsal refuses non-local PostgreSQL.");
  process.exit(2);
}

const selected = [
  "full_e2e_gate_validation",
  "charging_completion_window_validation",
  "concurrency_proof",
  "platform_fee_payments_8_percent_validation",
  "money_tax_invoice_canon_validation",
  "seller_payout_rail_validation",
  "payment_refund_real_rail_validation",
  "outbox_worker_recovery_validation",
  "webhook_truth_handling_validation",
  "grow_payment_adapter_validation",
  "synthetic_money_provider_validation",
  "mobile_readiness_validation"
];
const denyNetwork = path.resolve("scripts/deny_external_network.cjs");
const env = {
  ...process.env,
  NODE_ENV: "test",
  APP_DEPLOYMENT_MODE: "demo-preview",
  DISABLE_OUTBOX_WORKER: "1",
  NO_NETWORK_REHEARSAL: "1",
  TEST_FILE_PATTERN: `^(${selected.join("|")})\\.ts$`,
  NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --require=${denyNetwork}`.trim()
};
delete env.HTTP_PROXY;
delete env.HTTPS_PROXY;
delete env.ALL_PROXY;

const mobileBuild = spawnSync(process.execPath, ["scripts/build_mobile_bundle.cjs"], { stdio: "inherit", env, timeout: 60_000 });
if (mobileBuild.status !== 0) process.exit(mobileBuild.status || 1);

console.log(`LAUNCH_REHEARSAL_START scenarios=A-K selected_tests=${selected.length} external_network=denied`);
const result = spawnSync(process.execPath, ["scripts/run_test_group.cjs", "all"], { stdio: "inherit", env, timeout: 45 * 60_000 });
if (result.status !== 0) process.exit(result.status || 1);
console.log("LAUNCH_REHEARSAL_PASS lifecycle=success+failed threshold=90 money=balanced fee=8% delivery=included vat=excluded distributor=0 seller_settlement=proved replay=idempotent unknown=reconciled external_network=0");
