// ROUTE AUTHORIZATION GATE - the CI entry point.
//
// Two halves, in this order, and the second one is authoritative:
//
//   1. scripts/web_route_inventory.cjs - STATIC evidence. It reads the source and
//      records whether a guard helper is CALLED in each protected handler. It can
//      be fooled (a helper that exists but is not enforced, a no-op with the
//      same name), so it never proves authorization; it only catches the
//      cheapest mistake early and produces the inventory report.
//
//   2. The BEHAVIOURAL suites, run on a fresh migrated database through the
//      same isolated runner CI uses for every test group. They boot the real
//      router and probe it anonymously with every id shape. These decide.
//
// Exit code is non-zero if either half fails. The behavioural suites also run
// inside the security group, so a regression is caught twice - here, early and
// by name, and there, with the rest of the suite.
const { spawnSync } = require("node:child_process");

const BEHAVIOURAL_SUITES = [
  "protected_route_authorization_gate",
  "seller_lifecycle_route_authority",
  "admin_route_auth_coverage",
  "seller_route_auth_coverage"
];

function step(label, args, env) {
  console.log(`\nROUTE_AUTHORIZATION_STEP ${label}`);
  const result = spawnSync(process.execPath, args, { stdio: "inherit", env: { ...process.env, ...env } });
  if (result.status !== 0) {
    console.error(`ROUTE_AUTHORIZATION_GATE_FAIL step=${label} exit=${result.status}`);
    process.exit(result.status || 1);
  }
}

step("static-inventory", ["scripts/web_route_inventory.cjs"], {});
step("behavioural", ["scripts/run_test_group.cjs", "security"], { TEST_FILE_PATTERN: BEHAVIOURAL_SUITES.join("|") });
console.log("\nROUTE_AUTHORIZATION_GATE_PASS static=1 behavioural=" + BEHAVIOURAL_SUITES.length);
