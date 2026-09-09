// INDEPENDENT REVIEW of codex/closed-pilot-war-game — the gap the war game
// could not close: its 40-request join burst ran with CANONICAL_POSTGRES_RUNTIME
// unset (legacy inventory path), while hosted staging runs the canonical
// Postgres inventory RPC (`public.siton_inventory_rpc`, render.yaml). No local
// suite drove concurrent joins on that path (the runtime-boundary suite only
// probes /health and /readiness).
//
// This suite applies the hosted-only staging SQL (001, 006-009) to the fresh isolated database,
// boots the REAL app with CANONICAL_POSTGRES_RUNTIME=1 and proves, on the
// canonical path:
//   C1 40 near-simultaneous joins on capacity 30 → exactly 30 succeed, the
//      other 10 are refused, active units never exceed max_units, the
//      inventory ledger agrees with the business rows
//   C2 the threshold is crossed exactly once (one deal.target_reached audit,
//      written inside the Join transaction on this path)
//   C3 a replay of a successful request (same idempotency key) returns the same
//      participant and creates nothing; a fresh request after capacity is refused
//   C4 no orphan participant / reservation is left by refused requests
// Mock money only (authorize-mock), no provider, no network.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";

const { Pool } = pg;
const DB_URL = process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton";
const adminPool = new Pool({ connectionString: DB_URL, max: 3 });

// The staging inventory contract (001) expects the Supabase role trio to exist.
await adminPool.query(`
  DO $roles$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
  END
  $roles$;
`);
// Same hosted-only schema set the runtime-boundary suite applies (001 inventory
// contract, 006 canonical runtime boundary incl. participants.inventory_reservation_id,
// 007-009 role/trigger/function proofs).
for (const file of ["001_siton_inventory_v1.sql", "006_canonical_postgres_runtime_boundary.sql", "007_runtime_role_admin_set_proof.sql", "008_runtime_trigger_helper_execute.sql", "009_runtime_function_public_fail_closed.sql"]) {
  await adminPool.query(await readFile(`supabase/staging/${file}`, "utf8"));
}
const rpc = await adminPool.query(`SELECT to_regprocedure('public.siton_inventory_rpc(text,jsonb)') AS fn`);
assert.ok(rpc.rows[0].fn, "canonical inventory RPC must exist after applying supabase/staging/001");

process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.CANONICAL_POSTGRES_RUNTIME = "1";
process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.RATE_LIMIT_MAX = "1000000";
process.env.RATE_LIMIT_SENSITIVE_MAX = "1000000";
process.env.RATE_LIMIT_READ_MAX = "1000000";
process.env.PORT = process.env.PORT || "3641";

const { app } = await import("../src/app.js");
const { pool } = await import("../src/db.js");
const fixture = await import("./helpers/physical_fulfillment_fixture.js");

const RUN = randomUUID().slice(0, 8);
const seller = `seller-canon-${RUN}`;
let passed = 0;
let failed = 0;
async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`PASS ${name}`); passed++; }
  catch (e: any) { console.error(`FAIL ${name}: ${e?.message || e}`); failed++; }
}

async function authorize(suffix: string) {
  const res = await app.inject({ method: "POST", url: "/api/payments/authorize-mock", payload: { payer_name: `Buyer ${suffix}`, payment_method_id: `pm_canon_${suffix}_ok` } });
  assert.equal(res.statusCode, 200, res.body);
  return res.json() as any;
}
async function prepareJoin(dealId: string, n: number) {
  const phone = `05033${String(n).padStart(5, "0")}`;
  const auth = await authorize(phone);
  return {
    method: "POST" as const,
    url: `/deals/${dealId}/join`,
    headers: { "content-type": "application/json", "idempotency-key": `canon-join-${RUN}-${n}` },
    payload: {
      buyer_id: phone, qty: 1, buyer_name: `Canon buyer ${n}`, buyer_email: `canon${n}@buyer.siton.test`,
      buyer_terms_accepted: true, payment_disclosure_accepted: true,
      authorization_id: auth.authorization_id, authorization_provider: auth.provider || "mockpay"
    }
  };
}

let dealId = "";
const MAX_UNITS = 30;
const MIN_UNITS = 25; // threshold = ceil(0.9 × 25) = 23
let wave: any[] = [];
let requests: any[] = [];

await run("setup: seller + published deal (min 25 / max 30) on the canonical inventory runtime", async () => {
  await adminPool.query(
    `INSERT INTO siton.seller_accounts (seller_id, display_name, business_name, support_email, verification_status, settlement_status)
     VALUES ($1,$1,$1,$2,'approved','active') ON CONFLICT (seller_id) DO NOTHING`,
    [seller, `${seller}@siton.test`]
  );
  await fixture.ensureSellerReady(app, seller, `Canonical seller ${RUN}`);
  dealId = await fixture.createDeal(app, seller, { title: `Canonical burst ${RUN}`, price: 60, minUnits: MIN_UNITS, maxUnits: MAX_UNITS });
  await fixture.publishDeal(app, seller, dealId);
  const inv = await adminPool.query(`SELECT count(*)::int AS n FROM siton_inventory.inventory_deals WHERE deal_id=$1`, [dealId]);
  assert.ok(inv.rows[0].n >= 0, "inventory schema reachable");
});

await run("C1 40 concurrent joins on capacity 30 → exactly 30 succeed, 10 refused, never oversold, ledger agrees", async () => {
  requests = [];
  for (let n = 0; n < 40; n += 1) requests.push(await prepareJoin(dealId, n));
  const started = performance.now();
  wave = await Promise.all(requests.map((r) => app.inject(r)));
  const elapsed = performance.now() - started;
  const ok = wave.filter((r) => r.statusCode === 200);
  const refused = wave.filter((r) => r.statusCode !== 200);
  assert.equal(ok.length, MAX_UNITS, `exactly ${MAX_UNITS} joins must succeed: ${wave.map((r) => r.statusCode).join(",")} first_non_200=${String(refused[0]?.body || "").slice(0, 400)}`);
  assert.equal(refused.length, 10);
  for (const r of refused) assert.ok([409, 422, 400].includes(r.statusCode), r.body);
  const active = await adminPool.query(
    `SELECT COALESCE(SUM(qty),0)::int AS units, count(*)::int AS rows FROM siton.participants WHERE deal_id=$1 AND buyer_state NOT IN ('Dropped','DealFailed','NotJoined')`,
    [dealId]
  );
  assert.equal(active.rows[0].units, MAX_UNITS, "active units == capacity");
  assert.equal(active.rows[0].rows, MAX_UNITS, "one participant row per successful join");
  const ledger = await adminPool.query(
    `SELECT COALESCE(SUM(qty),0)::int AS committed FROM siton_inventory.inventory_reservations WHERE deal_id=$1 AND status='committed'`,
    [dealId]
  );
  assert.equal(ledger.rows[0].committed, MAX_UNITS, "inventory ledger committed units == business rows");
  const invDeal = await adminPool.query(`SELECT reserved_units, committed_units, deal_state FROM siton_inventory.inventory_deals WHERE deal_id=$1`, [dealId]);
  assert.equal(Number(invDeal.rows[0].committed_units), MAX_UNITS, "inventory_deals.committed_units == capacity");
  assert.equal(invDeal.rows[0].deal_state, "TargetReached", "inventory ledger mirrors the canonical deal state");
  for (const r of ok) assert.ok((r.json() as any).inventory_reservation_id, "canonical path returns an inventory reservation id");
  console.log(`CANONICAL_BURST n=40 ok=${ok.length} refused=${refused.length} elapsed_ms=${elapsed.toFixed(0)}`);
});

await run("C2 the threshold is crossed exactly once on the canonical path (one deal.target_reached audit, deal TargetReached)", async () => {
  const audits = await adminPool.query(`SELECT count(*)::int AS n FROM siton.audit_log WHERE entity_id=$1 AND action_name='deal.target_reached'`, [dealId]);
  assert.equal(audits.rows[0].n, 1);
  const state = await adminPool.query(`SELECT state, threshold_units FROM siton.deals WHERE deal_id=$1`, [dealId]);
  assert.equal(state.rows[0].state, "TargetReached");
  assert.equal(Number(state.rows[0].threshold_units), 23);
});

await run("C3 replaying a successful request returns the same participant; a fresh request after capacity is refused", async () => {
  const winnerIndex = wave.findIndex((r) => r.statusCode === 200);
  assert.ok(winnerIndex >= 0, "C1 must have produced successful joins");
  const replay = await app.inject(requests[winnerIndex]);
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal((replay.json() as any).participant_id, (wave[winnerIndex].json() as any).participant_id);
  const late = await app.inject(await prepareJoin(dealId, 99));
  assert.notEqual(late.statusCode, 200, "capacity is full");
  const rows = await adminPool.query(`SELECT count(*)::int AS n FROM siton.participants WHERE deal_id=$1`, [dealId]);
  assert.equal(rows.rows[0].n, MAX_UNITS, "replay and refusal create no rows");
});

await run("C4 refused requests leave no orphan participant or reservation", async () => {
  const orphans = await adminPool.query(
    `SELECT count(*)::int AS n FROM siton.participants WHERE deal_id=$1 AND buyer_state='NotJoined'`,
    [dealId]
  );
  assert.equal(orphans.rows[0].n, 0);
  const pendingReservations = await adminPool.query(
    `SELECT count(*)::int AS n FROM siton_inventory.inventory_reservations WHERE deal_id=$1 AND status='held'`,
    [dealId]
  );
  assert.equal(pendingReservations.rows[0].n, 0, "no reservation left held");
});

console.log(`SUMMARY passed=${passed} failed=${failed} canonical_inventory_runtime=1 real_money=0`);
await pool.end();
await adminPool.end();
await new Promise((r) => setTimeout(r, 300));
process.exit(failed ? 1 : 0);
