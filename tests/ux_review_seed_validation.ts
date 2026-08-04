import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { Pool } from "pg";

const databaseUrl = String(process.env.DATABASE_URL || "");
assert.ok(databaseUrl, "DATABASE_URL required");
const env = {
  ...process.env,
  DATABASE_URL: databaseUrl,
  APP_DEPLOYMENT_MODE: "demo-preview",
  PAYMENT_PROVIDER: "mockpay",
  PAYMENT_PROVIDER_MODE: "mock-backed"
};
const run = () => spawnSync(process.execPath, ["scripts/seed_ux_review.cjs"], { cwd: process.cwd(), env, encoding: "utf8" });
const pool = new Pool({ connectionString: databaseUrl });
try {
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /UX_REVIEW_SEED_COMPLETE deals=10/);
  const second = run();
  assert.equal(second.status, 0, second.stderr);
  const matrix = await pool.query(
    `SELECT state::text, count(*)::int AS count FROM siton.deals WHERE seller_id='ux-review-seller' GROUP BY state ORDER BY state`
  );
  assert.equal(matrix.rows.reduce((sum, row) => sum + row.count, 0), 10);
  for (const state of ["Draft", "PendingTarget", "TargetReached", "ClosedForJoining", "Cancelled"]) {
    assert.ok(matrix.rows.some((row) => row.state === state), `missing UX state ${state}`);
  }
  const options = await pool.query(
    `SELECT count(*)::int AS count FROM siton.deal_delivery_options WHERE deal_id='d1000000-0000-0000-0000-000000000008'`
  );
  assert.equal(options.rows[0].count, 3);
  const images = await pool.query(
    `SELECT count(*)::int AS count FROM siton.deal_images WHERE deal_id='d1000000-0000-0000-0000-000000000009' AND is_primary=true`
  );
  assert.equal(images.rows[0].count, 1);
  const nonDemo = spawnSync(process.execPath, ["scripts/seed_ux_review.cjs"], {
    cwd: process.cwd(), env: { ...env, APP_DEPLOYMENT_MODE: "production" }, encoding: "utf8"
  });
  assert.notEqual(nonDemo.status, 0);
  assert.match(nonDemo.stderr, /require APP_DEPLOYMENT_MODE=demo-preview/);
  console.log("PASS UX review seed is idempotent, synthetic, state-complete and demo-only");
} finally {
  await pool.query(`DELETE FROM siton.deals WHERE seller_id='ux-review-seller'`).catch(() => undefined);
  await pool.query(`DELETE FROM siton.seller_accounts WHERE seller_id='ux-review-seller'`).catch(() => undefined);
  await pool.end();
}