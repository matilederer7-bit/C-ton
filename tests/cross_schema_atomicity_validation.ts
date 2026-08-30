import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import {
  buildInventoryRepository,
  canonicalInventoryKey,
  inventorySha256,
  InventoryRepositoryError
} from "../src/inventory_repository.js";

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton",
  max: 6
});

await pool.query(`
  DO $roles$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
  END
  $roles$;
`);
await pool.query(await readFile("supabase/staging/001_siton_inventory_v1.sql", "utf8"));
await pool.query(await readFile("supabase/staging/006_canonical_postgres_runtime_boundary.sql", "utf8"));
await pool.query(await readFile("supabase/staging/007_runtime_role_admin_set_proof.sql", "utf8"));
await pool.query(await readFile("supabase/staging/008_runtime_trigger_helper_execute.sql", "utf8"));
await pool.query(await readFile("supabase/staging/009_runtime_function_public_fail_closed.sql", "utf8"));

const deals = [
  randomUUID(),
  randomUUID(),
  randomUUID(),
  randomUUID(),
  randomUUID()
] as const;
for (const dealId of deals) {
  await pool.query(
    `INSERT INTO siton.deals
       (deal_id,seller_id,title,state,price_per_unit,min_units,max_units,threshold_units,deadline,published_at,created_at,updated_at)
     VALUES ($1,'r2-synthetic','R2 atomicity','PendingTarget',10,1,5,5,now()+interval '1 day',now(),now(),now())`,
    [dealId]
  );
}

async function runtimeTx<T>(fn: (client: pg.PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE siton_web_runtime");
    const result = await fn(client);
    await client.query("ROLLBACK");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function joinMutations(
  client: pg.PoolClient,
  dealId: string,
  key: string,
  stop: "participant" | "complete"
) {
  const inventory = buildInventoryRepository(client);
  await inventory.sync({
    dealId,
    maxUnits: 5,
    minUnits: 5,
    idempotencyKey: `runtime-sync:${dealId}`
  });
  const hold = await inventory.hold({
    dealId,
    qty: 2,
    idempotencyKey: canonicalInventoryKey("join", { dealId, key }),
    requestHash: inventorySha256({ dealId, key, qty: 2 })
  });
  const inserted = await client.query(
    `INSERT INTO siton.participants
       (deal_id,buyer_id,qty,buyer_state,money_state,inventory_reservation_id)
     VALUES ($1,$2,2,'NotJoined','NoFinancial',$3)
     RETURNING participant_id`,
    [dealId, `050${key.padEnd(7, "0").slice(0, 7)}`, hold.reservation_id]
  );
  const participantId = String(inserted.rows[0].participant_id);
  if (stop === "participant") return { hold, participantId };

  const commit = await inventory.commit({
    reservationId: String(hold.reservation_id),
    authorizationEvidenceHash: inventorySha256({ authorization: "synthetic-no-provider", dealId, key })
  });
  await client.query(`SELECT set_config('siton.in_atomic','true',true)`);
  await client.query(`SELECT set_config('siton.action_name','participant.join_authorize',true)`);
  await client.query(`SELECT set_config('siton.audit_written','0',true)`);
  await client.query(`SELECT set_config('siton.outbox_written','0',true)`);
  await client.query(
    `INSERT INTO siton.audit_log
       (entity_type,entity_id,deal_id,state_type,from_state,to_state,action_name,request_id,correlation_id,idempotency_key,payload)
     VALUES
       ('participant',$1,$2,'buyer_state','NotJoined','JoinedAuthorized','participant.join_authorize',$3,$3,$4,'{}'::jsonb),
       ('participant',$1,$2,'money_state','NoFinancial','AuthHeld','participant.join_authorize',$3,$3,$4,'{}'::jsonb)`,
    [participantId, dealId, `r2:${randomUUID()}`, key]
  );
  await client.query(`SELECT set_config('siton.audit_written','1',true)`);
  await client.query(
    `UPDATE siton.participants SET buyer_state='JoinedAuthorized'
     WHERE participant_id=$1 AND buyer_state='NotJoined'`,
    [participantId]
  );
  await client.query(
    `UPDATE siton.participants SET money_state='AuthHeld'
     WHERE participant_id=$1 AND money_state='NoFinancial'`,
    [participantId]
  );
  return { hold, commit, participantId };
}

async function residue(dealId: string) {
  const row = await pool.query(
    `SELECT
       (SELECT count(*)::int FROM siton.participants WHERE deal_id=$1) AS business_rows,
       (SELECT count(*)::int FROM siton.audit_log WHERE deal_id=$1) AS business_audits,
       (SELECT count(*)::int FROM siton_inventory.inventory_deals WHERE deal_id=$1) AS inventory_deals,
       (SELECT count(*)::int FROM siton_inventory.inventory_reservations WHERE deal_id=$1) AS reservations,
       (SELECT count(*)::int FROM siton_inventory.participant_state_audit WHERE deal_id=$1) AS inventory_audits`,
    [dealId]
  );
  return row.rows[0];
}

const zero = {
  business_rows: 0,
  business_audits: 0,
  inventory_deals: 0,
  reservations: 0,
  inventory_audits: 0
};

try {
  await runtimeTx(async (client) => {
    const done = await joinMutations(client, deals[0], "success", "complete");
    assert.equal(done.commit?.status, "committed");
    assert.equal(done.commit?.join_authorize_audit_count, 2);
    const business = await client.query(
      `SELECT buyer_state,money_state,inventory_reservation_id
       FROM siton.participants WHERE participant_id=$1`,
      [done.participantId]
    );
    assert.equal(business.rows[0].buyer_state, "JoinedAuthorized");
    assert.equal(business.rows[0].money_state, "AuthHeld");
    assert.equal(String(business.rows[0].inventory_reservation_id), String(done.hold.reservation_id));
  });
  assert.deepEqual(await residue(deals[0]), zero);

  await assert.rejects(
    () => runtimeTx(async (client) => {
      await joinMutations(client, deals[1], "after-business", "participant");
      throw new Error("synthetic_failure_after_business_mutation");
    }),
    /synthetic_failure_after_business_mutation/
  );
  assert.deepEqual(await residue(deals[1]), zero);

  await assert.rejects(
    () => runtimeTx(async (client) => {
      await joinMutations(client, deals[2], "after-inventory", "complete");
      throw new Error("synthetic_failure_after_inventory_and_audit");
    }),
    /synthetic_failure_after_inventory_and_audit/
  );
  assert.deepEqual(await residue(deals[2]), zero);

  await runtimeTx(async (client) => {
    const inventory = buildInventoryRepository(client);
    await inventory.sync({ dealId: deals[3], maxUnits: 5, minUnits: 5, idempotencyKey: `runtime-sync:${deals[3]}` });
    const request = {
      dealId: deals[3],
      qty: 2,
      idempotencyKey: "r2-duplicate",
      requestHash: inventorySha256("r2-duplicate")
    };
    const first = await inventory.hold(request);
    const replay = await inventory.hold(request);
    assert.equal(first.reservation_id, replay.reservation_id);
    assert.equal(replay.replay, true);
    assert.equal((await inventory.status({ dealId: deals[3] })).reserved_units, 2);
  });

  await runtimeTx(async (client) => {
    const inventory = buildInventoryRepository(client);
    await inventory.sync({ dealId: deals[4], maxUnits: 5, minUnits: 5, idempotencyKey: `runtime-sync:${deals[4]}` });
    await inventory.hold({
      dealId: deals[4],
      qty: 4,
      idempotencyKey: "r2-capacity-a",
      requestHash: inventorySha256("r2-capacity-a")
    });
    await assert.rejects(
      () => inventory.hold({
        dealId: deals[4],
        qty: 2,
        idempotencyKey: "r2-capacity-b",
        requestHash: inventorySha256("r2-capacity-b")
      }),
      (error: any) => error instanceof InventoryRepositoryError && error.code === "inventory_exhausted"
    );
    const status = await inventory.status({ dealId: deals[4] });
    assert.equal(status.max_units, 5);
    assert.equal(status.reserved_units, 4);
    assert.equal(status.available_units, 1);
  });
} finally {
  await pool.query(`DELETE FROM siton.deals WHERE deal_id=ANY($1::uuid[])`, [deals]);
  await pool.end();
}

console.log("PASS cross-schema atomicity, audits, idempotency, and capacity");
