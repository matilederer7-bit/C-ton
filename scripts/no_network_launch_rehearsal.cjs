const { spawnSync } = require("node:child_process");

const commands = [
  [require.resolve("typescript/bin/tsc"), "-p", "tsconfig.test.json"],
  ["scripts/architecture_truth_gate.cjs"],
  ["scripts/build_mobile_bundle.cjs"],
  ["scripts/mobile_release_gate.cjs"],
  ["scripts/backend_enforcement_scan.cjs"],
  ["scripts/compliance_payment_scan.cjs"],
  ["scripts/runtime_ddl_scan.cjs"],
  ["scripts/build_demo_bundle.cjs"],
  ["scripts/run_launch_rehearsal.cjs"]
];

const env = {
  ...process.env,
  NO_NETWORK_REHEARSAL: "1",
  NODE_ENV: "test",
  APP_DEPLOYMENT_MODE: "demo-preview",
  PAYMENT_PROVIDER: "synthetic",
  PAYMENT_PROVIDER_MODE: "mock-backed",
  NOTIFICATION_PROVIDER: "log-only",
  DISABLE_OUTBOX_WORKER: "1",
  npm_config_offline: "true"
};
delete env.HTTP_PROXY;
delete env.HTTPS_PROXY;
delete env.ALL_PROXY;

for (const args of commands) {
  console.log(`REHEARSAL_STEP node ${args.join(" ")}`);
  const result = spawnSync(process.execPath, args, { stdio: "inherit", env });
  if (result.status !== 0) process.exit(result.status || 1);
}

console.log("NO_NETWORK_LAUNCH_REHEARSAL_PASS external_calls=0 live_money=0 notifications_sent=0 publish=0");
