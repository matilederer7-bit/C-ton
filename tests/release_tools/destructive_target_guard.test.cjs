const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { assertDestructiveTargetAllowed } = require("../../scripts/lib/destructive_target_guard.cjs");

const root = path.resolve(__dirname, "..", "..");
const HOSTED = "postgresql://prod_user:S3cretProdPassw0rd@db.abcdefghijkl.supabase.co:5432/postgres";

test("hosted PostgreSQL hosts are refused", () => {
  assert.throws(() => assertDestructiveTargetAllowed(HOSTED, { action: "x", env: {} }), /not a local PostgreSQL host/);
});

test("staging / production / live-payment deployment markers are refused even on a local host", () => {
  const local = "postgresql://postgres@127.0.0.1:5432/siton";
  for (const env of [{ APP_DEPLOYMENT_MODE: "staging" }, { APP_DEPLOYMENT_MODE: "production" }, { PAYMENT_ENVIRONMENT: "live" }]) {
    assert.throws(() => assertDestructiveTargetAllowed(local, { action: "x", env }), /marks a hosted environment/, JSON.stringify(env));
  }
});

test("local and compose hosts are allowed; an explicitly named lab host is allowed", () => {
  for (const url of ["postgresql://postgres@127.0.0.1:5433/postgres", "postgresql://u:p@localhost/x", "postgresql://u:p@postgres:5432/siton_demo"]) {
    assert.doesNotThrow(() => assertDestructiveTargetAllowed(url, { action: "x", env: { APP_DEPLOYMENT_MODE: "demo-preview" } }), url);
  }
  assert.doesNotThrow(() => assertDestructiveTargetAllowed("postgresql://u:p@lab-db.internal/x", { action: "x", env: { SITON_DESTRUCTIVE_ALLOWED_HOSTS: "lab-db.internal" } }));
});

test("the error never carries the connection string", () => {
  try { assertDestructiveTargetAllowed(HOSTED, { action: "x", env: {} }); assert.fail("expected refusal"); }
  catch (error) { assert.doesNotMatch(String(error.message), /S3cretProdPassw0rd|prod_user/); }
});

for (const script of ["scripts/drop_create_db.cjs", "scripts/bootstrap_demo_db.cjs"]) {
  test(`${script} refuses a hosted DATABASE_URL, exits non-zero and never prints the password`, () => {
    const result = spawnSync(process.execPath, [script], {
      cwd: root,
      encoding: "utf8",
      env: { PATH: process.env.PATH, DATABASE_URL: HOSTED, DOTENV_CONFIG_PATH: "/nonexistent" },
      timeout: 20000
    });
    assert.notEqual(result.status, 0, `${script} must refuse: ${result.stdout}${result.stderr}`);
    assert.match(result.stdout + result.stderr, /refused/);
    assert.doesNotMatch(result.stdout + result.stderr, /S3cretProdPassw0rd/);
  });
}

test("drop_create_db refuses to drop the maintenance database even locally", () => {
  const result = spawnSync(process.execPath, ["scripts/drop_create_db.cjs"], {
    cwd: root, encoding: "utf8", timeout: 20000,
    env: { PATH: process.env.PATH, DATABASE_URL: "postgresql://postgres@127.0.0.1:1/postgres", DOTENV_CONFIG_PATH: "/nonexistent" }
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /maintenance database/);
});
