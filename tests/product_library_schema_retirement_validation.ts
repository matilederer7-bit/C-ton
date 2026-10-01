// Product Library C2 — migration 082 retires the Product Library schema.
//
// Proves, on the migrated test database and on isolated databases built from
// the manifest up to 081 (the pre-C2 high-water):
//   * 082 removes exactly the Product Library objects and keeps the delivery
//     estimates (columns + CHECKs),
//   * upgrading a database that holds a Product, a Product-backed Deal with a
//     snapshot, an AuthHeld participant, delivery options with estimates and
//     a legacy create idempotency row changes no Deal / participant / delivery
//     / idempotency / outbox / audit / seller row (only the two Product
//     columns disappear),
//   * a rerun of the runner and a second execution of the file are no-ops,
//   * Product data is refused without the per-database disposition flag and
//     Product image rows are refused always (nothing dropped, ledger failed),
//   * migration 072 is byte-identical to the file staging applied.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const require = createRequire(import.meta.url);
const { runMigrations } = require(path.join(process.cwd(), "scripts", "run_migrations.cjs"));
const { MIGRATIONS } = require(path.join(process.cwd(), "scripts", "migration_manifest.cjs"));
const isolation = require(path.join(process.cwd(), "scripts", "lib", "test_db_isolation.cjs"));

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) throw new Error("DATABASE_URL is required");
const migrationSql = fs.readFileSync("src/migrations/082_retire_product_library_schema.sql", "utf8");
const preC2 = MIGRATIONS.slice(0, MIGRATIONS.findIndex((m: any) => m.id === "082"));
assert.equal(preC2[preC2.length - 1].id, "081", "the pre-C2 high-water is 081");

async function run(name: string, fn: () => Promise<void>) {
  await fn();
  console.log(`PASS ${name}`);
}
async function quietly(fn: () => Promise<any>): Promise<any> {
  const log = console.log;
  console.log = () => undefined;
  try { return await fn(); } finally { console.log = log; }
}

type Probe = { products: boolean; productImages: boolean; productColumns: string[]; snapshotFunction: boolean; snapshotTrigger: boolean; estimateColumns: number; estimateChecks: number };
async function probe(client: pg.Pool | pg.Client): Promise<Probe> {
  const r = await client.query(`SELECT
      to_regclass('siton.products') IS NOT NULL AS products,
      to_regclass('siton.product_images') IS NOT NULL AS product_images,
      ARRAY(SELECT column_name::text FROM information_schema.columns WHERE table_schema='siton' AND table_name='deals'
            AND column_name IN ('product_id','product_snapshot_jsonb') ORDER BY 1) AS product_columns,
      to_regprocedure('siton.prevent_published_deal_product_snapshot_change()') IS NOT NULL AS snapshot_function,
      EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_deals_product_snapshot_immutable') AS snapshot_trigger,
      (SELECT count(*)::int FROM information_schema.columns WHERE table_schema='siton' AND table_name='deal_delivery_options'
        AND column_name IN ('estimated_min_business_days','estimated_max_business_days')) AS estimate_columns,
      (SELECT count(*)::int FROM pg_constraint WHERE conrelid='siton.deal_delivery_options'::regclass
        AND conname IN ('deal_delivery_options_estimated_min_check','deal_delivery_options_estimated_max_check','deal_delivery_options_estimated_range_check')) AS estimate_checks`);
  const row = r.rows[0];
  return { products: row.products, productImages: row.product_images, productColumns: row.product_columns, snapshotFunction: row.snapshot_function, snapshotTrigger: row.snapshot_trigger, estimateColumns: row.estimate_columns, estimateChecks: row.estimate_checks };
}

// Row fingerprints of every table C2 must not touch (the Deal fingerprint
// excludes only the two Product columns that 082 drops).
async function fingerprints(client: pg.Client) {
  const table = async (sql: string) => String((await client.query(sql)).rows[0].fp);
  return {
    deals: await table(`SELECT md5(coalesce(string_agg((to_jsonb(d) - 'product_id' - 'product_snapshot_jsonb')::text, '|' ORDER BY d.deal_id), '')) AS fp FROM siton.deals d`),
    participants: await table(`SELECT md5(coalesce(string_agg(to_jsonb(p)::text, '|' ORDER BY p.participant_id), '')) AS fp FROM siton.participants p`),
    delivery: await table(`SELECT md5(coalesce(string_agg(to_jsonb(o)::text, '|' ORDER BY o.option_id), '')) AS fp FROM siton.deal_delivery_options o`),
    idempotency: await table(`SELECT md5(coalesce(string_agg(to_jsonb(i)::text, '|' ORDER BY i.idempotency_id), '')) AS fp FROM siton.idempotency_log i`),
    outbox: await table(`SELECT md5(coalesce(string_agg(to_jsonb(o)::text, '|' ORDER BY to_jsonb(o)::text), '')) AS fp FROM siton.outbox_events o`),
    audit: await table(`SELECT md5(coalesce(string_agg(to_jsonb(a)::text, '|' ORDER BY to_jsonb(a)::text), '')) AS fp FROM siton.audit_log a`),
    sellers: await table(`SELECT md5(coalesce(string_agg(to_jsonb(s)::text, '|' ORDER BY s.seller_id), '')) AS fp FROM siton.seller_accounts s`),
    payments: await table(`SELECT md5(coalesce(string_agg(to_jsonb(x)::text, '|' ORDER BY to_jsonb(x)::text), '')) AS fp FROM siton.payment_attempts x`),
    bindings: await table(`SELECT md5(coalesce(string_agg(to_jsonb(x)::text, '|' ORDER BY to_jsonb(x)::text), '')) AS fp FROM siton.payment_authorization_bindings x`),
    fees: await table(`SELECT md5(coalesce(string_agg(to_jsonb(x)::text, '|' ORDER BY to_jsonb(x)::text), '')) AS fp FROM siton.platform_fee_money_events x`),
    fulfillment: await table(`SELECT md5(coalesce(string_agg(to_jsonb(x)::text, '|' ORDER BY to_jsonb(x)::text), '')) AS fp FROM siton.fulfillment_units x`),
    dealImages: await table(`SELECT md5(coalesce(string_agg(to_jsonb(x)::text, '|' ORDER BY to_jsonb(x)::text), '')) AS fp FROM siton.deal_images x`),
    counts: (await client.query(`SELECT (SELECT count(*) FROM siton.deals)::int AS deals, (SELECT count(*) FROM siton.participants)::int AS participants,
      (SELECT count(*) FROM siton.participants WHERE money_state='AuthHeld')::int AS auth_held, (SELECT count(*) FROM siton.deal_delivery_options)::int AS delivery,
      (SELECT count(*) FROM siton.idempotency_log)::int AS idempotency, (SELECT count(*) FROM siton.outbox_events)::int AS outbox,
      (SELECT count(*) FROM siton.audit_log)::int AS audit`)).rows[0]
  };
}

await run("082 is a forward-only drop of the Product Library schema: no CASCADE, no row DML, delivery estimates untouched, 072 unchanged", async () => {
  const body = migrationSql.replace(/--[^\n]*/g, "");
  assert.doesNotMatch(body, /\bCASCADE\b/i, "no CASCADE: an unexpected dependent object must fail the migration");
  assert.doesNotMatch(body, /\b(?:DELETE\s+FROM|UPDATE\s+siton\.|TRUNCATE|INSERT\s+INTO)\b/i, "082 changes no row data");
  assert.doesNotMatch(body, /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?siton\.deal_delivery_options/i, "the delivery-estimate table is not altered");
  assert.doesNotMatch(body, /DROP\s+(?:COLUMN|CONSTRAINT)[^;]*estimated/i, "the delivery-estimate columns and CHECKs are not dropped");
  const drops = [...body.matchAll(/\bDROP\s+(TRIGGER|FUNCTION|CONSTRAINT|INDEX|COLUMN|TABLE)\s+IF\s+EXISTS\s+([^\s;(]+)/gi)].map((m) => `${String(m[1]).toUpperCase()} ${m[2]}`);
  assert.deepEqual(drops, [
    "TRIGGER trg_deals_product_snapshot_immutable",
    "FUNCTION siton.prevent_published_deal_product_snapshot_change",
    "CONSTRAINT deals_product_id_fkey",
    "CONSTRAINT deals_product_snapshot_presence_check",
    "CONSTRAINT deals_product_snapshot_shape_check",
    "INDEX siton.idx_deals_product_id",
    "COLUMN product_snapshot_jsonb",
    "COLUMN product_id",
    "TABLE siton.product_images",
    "TABLE siton.products"
  ], "082 drops exactly the Product Library objects, each IF EXISTS");
  assert.equal((body.match(/\bDROP\b/gi) || []).length, drops.length, "every DROP is IF EXISTS and listed");
  assert.match(body, /SET LOCAL lock_timeout = '5s';\s*LOCK TABLE siton\.deals IN ACCESS EXCLUSIVE MODE;/, "bounded lock on deals, taken before the guard");
  assert.ok(body.indexOf("LOCK TABLE siton.deals") < body.indexOf("$c2_guard$") && body.indexOf("$c2_guard$") < body.indexOf("DROP TRIGGER"), "lock, then guard, then drops");
  assert.match(body, /current_setting\('siton\.product_library_c2_disposition', true\)/, "Product data needs the per-database disposition flag");
  const m072 = fs.readFileSync("src/migrations/072_product_catalog_and_fulfillment_estimates.sql");
  assert.equal(createHash("sha256").update(m072).digest("hex"), "00a78699eec995c623fb40d5215bec8d5314fd865a857b9d9b77dc6cfe6f0cdc", "migration 072 is never edited");
});

await run("the migrated database has no Product Library schema and keeps the delivery estimates", async () => {
  const pool = new pg.Pool({ connectionString: baseUrl, max: 1 });
  try {
    assert.deepEqual(await probe(pool), { products: false, productImages: false, productColumns: [], snapshotFunction: false, snapshotTrigger: false, estimateColumns: 2, estimateChecks: 3 });
  } finally {
    await pool.end();
  }
});

await run("upgrade 081 -> 082 with a Product-backed Deal, an AuthHeld participant and a legacy idempotency row loses nothing but the Product schema; rerun is a no-op", async () => {
  const db = await isolation.createIsolatedDatabase({ baseUrl, purpose: "c2upgrade" });
  const client = new pg.Client({ connectionString: db.url });
  try {
    const base = await quietly(() => runMigrations(db.url, { migrations: preC2 }));
    assert.equal(base.newly_applied, preC2.length);
    await client.connect();
    const before = await probe(client);
    assert.equal(before.products && before.productImages && before.snapshotFunction && before.snapshotTrigger, true, "081 database carries the Product Library schema");
    assert.deepEqual(before.productColumns, ["product_id", "product_snapshot_jsonb"]);

    await client.query(`INSERT INTO siton.seller_accounts (seller_id, display_name, business_name, support_email) VALUES ('seller-c2', 'Seller C2', 'C2 Ltd', 'c2@example.invalid')`);
    const product = await client.query(`INSERT INTO siton.products (seller_id, name, product_type) VALUES ('seller-c2', 'Smoke product', 'physical_product') RETURNING product_id`);
    const productId = product.rows[0].product_id;
    const productDeal = "c2000000-0000-4000-8000-000000000001";
    const plainDeal = "c2000000-0000-4000-8000-000000000002";
    await client.query(
      `INSERT INTO siton.deals (deal_id, seller_id, title, state, price_per_unit, min_units, max_units, threshold_units, deadline, published_at, product_id, product_snapshot_jsonb, created_at, updated_at)
       VALUES ($1,'seller-c2','Smoke deal — Product-backed','PendingTarget',35,2,12,2,now()+interval '3 days',now(),$2,'{"name":"Smoke product","revision":1}'::jsonb,now(),now())`,
      [productDeal, productId]
    );
    await client.query(
      `INSERT INTO siton.deals (deal_id, seller_id, title, state, price_per_unit, min_units, max_units, threshold_units, deadline, published_at, created_at, updated_at)
       VALUES ($1,'seller-c2','Plain deal','PendingTarget',20,1,5,1,now()+interval '3 days',now(),now(),now())`,
      [plainDeal]
    );
    await client.query(
      `INSERT INTO siton.participants (participant_id, deal_id, buyer_id, qty, buyer_state, money_state, created_at, updated_at)
       VALUES ('c2000000-0000-4000-8000-0000000000a1', $1, '+972500000001', 2, 'JoinedAuthorized', 'AuthHeld', now(), now())`,
      [productDeal]
    );
    await client.query(
      `INSERT INTO siton.deal_delivery_options (deal_id, option_type, label, cost, estimated_min_business_days, estimated_max_business_days)
       VALUES ($1,'delivery','Courier',25,2,5), ($1,'pickup','Shop',0,NULL,NULL)`,
      [productDeal]
    );
    await client.query(
      `INSERT INTO siton.idempotency_log (entity_type, entity_id, action_name, idempotency_key, request_hash, response_code, response_jsonb)
       VALUES ('deal', $1, 'seller_deal_create', 'seller-create:c2-legacy', 'legacy-product-backed-hash', 'OK', '{"deal_id":"c2000000-0000-4000-8000-000000000001"}'::jsonb)`,
      [productDeal]
    );
    const fingerprintBefore = await fingerprints(client);
    assert.equal(fingerprintBefore.counts.auth_held, 1);

    // Without the disposition flag the database with Product data is refused.
    await assert.rejects(() => quietly(() => runMigrations(db.url)), /holds Product rows or Product-backed Deals/);
    assert.equal((await probe(client)).products, true, "a refused run drops nothing");
    await client.query(`DELETE FROM siton.migration_ledger WHERE migration_id='082' AND status='failed'`);
    // The owner-approved disposition for THIS database (new sessions inherit it).
    await client.query(`ALTER DATABASE ${isolation.quoteIdentifier(db.name)} SET siton.product_library_c2_disposition = 'accepted'`);

    const upgrade = await quietly(() => runMigrations(db.url));
    assert.equal(upgrade.newly_applied, 1, "the upgrade applies exactly 082");
    assert.deepEqual(await probe(client), { products: false, productImages: false, productColumns: [], snapshotFunction: false, snapshotTrigger: false, estimateColumns: 2, estimateChecks: 3 });
    assert.deepEqual(await fingerprints(client), fingerprintBefore, "no Deal / participant / delivery / idempotency / outbox / audit / seller row changed");
    const deal = await client.query(`SELECT title, state, price_per_unit::text AS price FROM siton.deals WHERE deal_id=$1`, [productDeal]);
    assert.deepEqual(deal.rows[0], { title: "Smoke deal — Product-backed", state: "PendingTarget", price: "35.00" });
    const participant = await client.query(`SELECT buyer_state, money_state FROM siton.participants WHERE deal_id=$1`, [productDeal]);
    assert.deepEqual(participant.rows, [{ buyer_state: "JoinedAuthorized", money_state: "AuthHeld" }]);
    const estimate = await client.query(`SELECT estimated_min_business_days AS min, estimated_max_business_days AS max FROM siton.deal_delivery_options WHERE deal_id=$1 AND option_type='delivery'`, [productDeal]);
    assert.deepEqual(estimate.rows[0], { min: 2, max: 5 });
    await assert.rejects(
      () => client.query(`UPDATE siton.deal_delivery_options SET estimated_min_business_days=6 WHERE deal_id=$1 AND option_type='delivery'`, [productDeal]),
      (error: any) => error?.code === "23514",
      "the estimate range CHECK still holds after 082"
    );

    const rerun = await quietly(() => runMigrations(db.url));
    assert.equal(rerun.newly_applied, 0, "a rerun of the runner is a no-op");
    await client.query(`BEGIN;\n${migrationSql}\nCOMMIT;`);
    assert.deepEqual(await fingerprints(client), fingerprintBefore, "a second execution of 082 is a no-op");
    const ledger = await client.query(`SELECT status FROM siton.migration_ledger WHERE migration_id='082'`);
    assert.deepEqual(ledger.rows, [{ status: "succeeded" }]);
  } finally {
    await client.end().catch(() => undefined);
    await db.drop();
  }
});

async function guardCase(purpose: string, seed: (client: pg.Client) => Promise<void>, flag: boolean, expected: RegExp | null) {
  const db = await isolation.createIsolatedDatabase({ baseUrl, purpose });
  const client = new pg.Client({ connectionString: db.url });
  try {
    await quietly(() => runMigrations(db.url, { migrations: preC2 }));
    await client.connect();
    await client.query(`INSERT INTO siton.seller_accounts (seller_id, display_name, business_name, support_email) VALUES ('seller-c2g', 'Seller', 'G Ltd', 'g@example.invalid')`);
    await seed(client);
    if (flag) await client.query(`ALTER DATABASE ${isolation.quoteIdentifier(db.name)} SET siton.product_library_c2_disposition = 'accepted'`);
    if (expected) {
      await assert.rejects(() => quietly(() => runMigrations(db.url)), expected);
      const state = await probe(client);
      assert.equal(state.products && state.productImages && state.snapshotFunction && state.snapshotTrigger, true, "a refused run drops nothing");
      assert.deepEqual(state.productColumns, ["product_id", "product_snapshot_jsonb"]);
      assert.deepEqual((await client.query(`SELECT status FROM siton.migration_ledger WHERE migration_id='082'`)).rows, [{ status: "failed" }]);
    } else {
      const result = await quietly(() => runMigrations(db.url));
      assert.equal(result.newly_applied, 1);
      assert.equal((await probe(client)).products, false);
    }
  } finally {
    await client.end().catch(() => undefined);
    await db.drop();
  }
}
const seedProduct = async (client: pg.Client) => {
  const product = await client.query(`INSERT INTO siton.products (seller_id, name, product_type) VALUES ('seller-c2g', 'P', 'physical_product') RETURNING product_id`);
  return product.rows[0].product_id;
};

await run("the guard refuses a database with a Product row and no disposition flag", async () => {
  await guardCase("c2guardprod", async (client) => { await seedProduct(client); }, false, /holds Product rows or Product-backed Deals/);
});

await run("the guard refuses a database with a snapshot-only Product-backed Deal and no disposition flag", async () => {
  await guardCase("c2guardsnap", async (client) => {
    await client.query(
      `INSERT INTO siton.deals (deal_id, seller_id, title, state, price_per_unit, min_units, max_units, threshold_units, deadline, created_at, updated_at, product_snapshot_jsonb)
       VALUES ('c2000000-0000-4000-8000-0000000000b1','seller-c2g','Snapshot deal','Draft',10,1,5,1,now()+interval '3 days',now(),now(),'{"name":"P"}'::jsonb)`
    );
  }, false, /holds Product rows or Product-backed Deals/);
});

await run("the guard always refuses Product image rows, even with the disposition flag (blob disposition first)", async () => {
  await guardCase("c2guardimg", async (client) => {
    const productId = await seedProduct(client);
    await client.query(`INSERT INTO siton.product_images (product_id, storage_provider, storage_key, mime_type, size_bytes) VALUES ($1,'local','product/blob.png','image/png',10)`, [productId]);
  }, true, /dispose of the Product image blobs/);
});

await run("with the disposition flag a database holding a Product row is retired", async () => {
  await guardCase("c2guardok", async (client) => { await seedProduct(client); }, true, null);
});

console.log("PASS Product Library C2: migration 082 retires the Product Library schema without touching Deals, money, outbox, audit or delivery estimates");
