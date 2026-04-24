import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import pg from "pg";
import "dotenv/config";

process.env.PORT = "3092";
process.env.OUTBOX_POLL_MS = "60000";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.APP_DEPLOYMENT_MODE = "demo-preview";

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton"
});

const bootstrapSql = (await readFile("src/migrations/014_demo_preview_bootstrap.sql", "utf8")).replace(/^\uFEFF/, "");
const outboxSql = (await readFile("src/migrations/009_db_enforcement_phase2c.sql", "utf8")).replace(/^\uFEFF/, "");
await pool.query(bootstrapSql);
await pool.query(outboxSql);

const { app, processOutboxEventById } = await import(`../src/app.js?state-wave2-${Date.now()}`);

async function runTest(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

async function expectTxFailure(name: string, fn: (client: pg.PoolClient) => Promise<void>, pattern: RegExp) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let threw = false;
    try {
      await fn(client);
    } catch (error: any) {
      threw = true;
      assert.match(String(error?.message || error), pattern, name);
    }
    assert.equal(threw, true, `${name} should fail`);
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }
}

async function fetchOne<T = any>(sql: string, params: unknown[] = []) {
  const result = await pool.query(sql, params);
  return result.rows[0] as T | undefined;
}

async function seedDeal(state: string, overrides: Partial<Record<string, unknown>> = {}) {
  const dealId = randomUUID();
  await pool.query(
    `INSERT INTO siton.deals (
       deal_id, seller_id, state, title, price_per_unit, min_units, max_units, threshold_units, deadline, published_at, completion_window_until
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      dealId,
      "seller-wave2",
      state,
      String(overrides.title || `Wave 2 ${state}`),
      overrides.price_per_unit ?? 42,
      overrides.min_units ?? 5,
      overrides.max_units ?? 10,
      overrides.threshold_units ?? 5,
      overrides.deadline ?? new Date(Date.now() + 30 * 60_000).toISOString(),
      overrides.published_at ?? new Date().toISOString(),
      overrides.completion_window_until ?? null
    ]
  );
  return dealId;
}

async function seedParticipant(
  dealId: string,
  buyerState: string,
  moneyState: string,
  overrides: Partial<Record<string, unknown>> = {}
) {
  const participantId = randomUUID();
  await pool.query(
    `INSERT INTO siton.participants (
       participant_id, deal_id, buyer_id, qty, buyer_state, money_state, delivery_cost, locked_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      participantId,
      dealId,
      String(overrides.buyer_id || `buyer-${participantId.slice(0, 8)}`),
      overrides.qty ?? 2,
      buyerState,
      moneyState,
      overrides.delivery_cost ?? 0,
      overrides.locked_at ?? null
    ]
  );
  return participantId;
}

await runTest("illegal deal transition is blocked even with forged tx flags", async () => {
  const dealId = await seedDeal("PendingTarget");

  await expectTxFailure(
    "illegal deal jump",
    async (client) => {
      await client.query(`SELECT set_config('siton.action_name', 'test.illegal_deal_jump', true)`);
      await client.query(`SELECT set_config('siton.audit_written', '1', true)`);
      await client.query(`SELECT set_config('siton.outbox_written', '1', true)`);
      await client.query(`UPDATE siton.deals SET state='Completed' WHERE deal_id=$1`, [dealId]);
    },
    /illegal deal transition/i
  );
});

await runTest("illegal participant state jumps are blocked even with forged tx flags", async () => {
  const dealId = await seedDeal("PendingTarget");
  const participantId = await seedParticipant(dealId, "NotJoined", "NoFinancial");

  await expectTxFailure(
    "illegal buyer state jump",
    async (client) => {
      await client.query(`SELECT set_config('siton.action_name', 'test.illegal_participant_jump', true)`);
      await client.query(`SELECT set_config('siton.audit_written', '1', true)`);
      await client.query(`SELECT set_config('siton.outbox_written', '1', true)`);
      await client.query(`UPDATE siton.participants SET buyer_state='DealCompleted' WHERE participant_id=$1`, [participantId]);
    },
    /illegal participant buyer_state transition/i
  );

  await expectTxFailure(
    "illegal money state jump",
    async (client) => {
      await client.query(`SELECT set_config('siton.action_name', 'test.illegal_money_jump', true)`);
      await client.query(`SELECT set_config('siton.audit_written', '1', true)`);
      await client.query(`SELECT set_config('siton.outbox_written', '1', true)`);
      await client.query(`UPDATE siton.participants SET money_state='Refunded' WHERE participant_id=$1`, [participantId]);
    },
    /illegal participant money_state transition/i
  );
});

await runTest("audit and outbox enforcement both block direct state mutation", async () => {
  const draftDealId = await seedDeal("Draft", { published_at: null, threshold_units: 5 });
  await expectTxFailure(
    "missing audit flag",
    async (client) => {
      await client.query(`SELECT set_config('siton.action_name', 'deal.publish', true)`);
      await client.query(`SELECT set_config('siton.audit_written', '0', true)`);
      await client.query(`SELECT set_config('siton.outbox_written', '1', true)`);
      await client.query(`UPDATE siton.deals SET state='PendingTarget' WHERE deal_id=$1`, [draftDealId]);
    },
    /audit_log in same transaction/i
  );

  const chargingDealId = await seedDeal("ReadyForCharging");
  await expectTxFailure(
    "missing outbox flag",
    async (client) => {
      await client.query(`SELECT set_config('siton.action_name', 'charging.start', true)`);
      await client.query(`SELECT set_config('siton.audit_written', '1', true)`);
      await client.query(`SELECT set_config('siton.outbox_written', '0', true)`);
      await client.query(`UPDATE siton.deals SET state='Charging' WHERE deal_id=$1`, [chargingDealId]);
    },
    /outbox in same transaction/i
  );
});

await runTest("audit_log validates transitions and stays append-only", async () => {
  const dealId = await seedDeal("Draft", { published_at: null, threshold_units: 5 });
  const auditId = randomUUID();

  await pool.query(
    `INSERT INTO siton.audit_log (
       audit_id, entity_type, entity_id, deal_id, state_type, from_state, to_state, action_name, request_id, idempotency_key, payload
     ) VALUES ($1,'deal',$2,$2,'deal_state','Draft','PendingTarget','deal.publish',$3,$4,$5)`,
    [auditId, dealId, `wave2-audit-${Date.now()}`, `wave2-audit-idem-${Date.now()}`, JSON.stringify({ source: "wave2" })]
  );

  await expectTxFailure(
    "invalid audit transition",
    async (client) => {
      await client.query(
        `INSERT INTO siton.audit_log (
           entity_type, entity_id, deal_id, state_type, from_state, to_state, action_name, request_id, idempotency_key, payload
         ) VALUES ('deal',$1,$1,'deal_state','Draft','Completed','deal.publish',$2,$3,$4)`,
        [dealId, `wave2-invalid-${Date.now()}`, `wave2-invalid-idem-${Date.now()}`, JSON.stringify({ source: "wave2" })]
      );
    },
    /audit_log illegal transition/i
  );

  await expectTxFailure(
    "audit update blocked",
    async (client) => {
      await client.query(`UPDATE siton.audit_log SET payload = payload || '{"tampered":true}'::jsonb WHERE audit_id=$1`, [auditId]);
    },
    /append-only/i
  );

  await expectTxFailure(
    "audit delete blocked",
    async (client) => {
      await client.query(`DELETE FROM siton.audit_log WHERE audit_id=$1`, [auditId]);
    },
    /append-only/i
  );
});

await runTest("legal charging.start path succeeds and writes matching audit and outbox", async () => {
  const dealId = await seedDeal("ReadyForCharging");
  const participantId = await seedParticipant(dealId, "LockedIn", "AuthLocked", {
    locked_at: new Date().toISOString()
  });

  const response = await app.inject({
    method: "POST",
    url: `/deals/${dealId}/charging/start`,
    headers: {
      "x-request-id": `wave2-start-${Date.now()}`,
      "idempotency-key": `wave2-start-${Date.now()}`
    }
  });
  assert.equal(response.statusCode, 200);

  const deal = await fetchOne<{ state: string }>(`SELECT state FROM siton.deals WHERE deal_id=$1`, [dealId]);
  const participant = await fetchOne<{ buyer_state: string; money_state: string }>(
    `SELECT buyer_state, money_state FROM siton.participants WHERE participant_id=$1`,
    [participantId]
  );
  const auditRows = await pool.query(
    `SELECT state_type, from_state, to_state
     FROM siton.audit_log
     WHERE deal_id=$1
       AND action_name='charging.start'
     ORDER BY created_at ASC`,
    [dealId]
  );
  const outbox = await fetchOne<{ event_type: string; status: string }>(
    `SELECT event_type, status
     FROM siton.outbox_events
     WHERE aggregate_id=$1
       AND event_type='charge_deal'
     ORDER BY created_at DESC
     LIMIT 1`,
    [dealId]
  );

  assert.equal(deal?.state, "Charging");
  assert.equal(participant?.buyer_state, "ChargingAttempt");
  assert.equal(participant?.money_state, "ChargeAttempt");
  assert.equal(auditRows.rowCount, 3);
  assert.deepEqual(
    auditRows.rows.map((row) => `${row.state_type}:${row.from_state}->${row.to_state}`).sort(),
    [
      "deal_state:ReadyForCharging->Charging",
      "buyer_state:LockedIn->ChargingAttempt",
      "money_state:AuthLocked->ChargeAttempt"
    ].sort()
  );
  assert.equal(outbox?.event_type, "charge_deal");
  assert.ok(["pending", "processing", "sent"].includes(String(outbox?.status || "")), String(outbox?.status));
});

await runTest("charge_deal completion transition enqueues recovery and finalize outbox atomically", async () => {
  const dealId = await seedDeal("Charging", { completion_window_until: null });
  await seedParticipant(dealId, "ChargeFailedCompletion", "ChargeFailedRecovery");
  const chargeOutboxId = randomUUID();

  await pool.query(
    `INSERT INTO siton.outbox_events (
       event_uuid, event_type, aggregate_type, aggregate_id, payload, status, attempt_count, available_at, created_at, updated_at
     ) VALUES ($1,'charge_deal','deal',$2,$3,'pending',0, now(), now(), now())`,
    [chargeOutboxId, dealId, JSON.stringify({ deal_id: dealId })]
  );

  const processed = await processOutboxEventById(chargeOutboxId);
  assert.equal(processed?.status, "sent");

  const deal = await fetchOne<{ state: string; completion_window_until: string | null }>(
    `SELECT state, completion_window_until FROM siton.deals WHERE deal_id=$1`,
    [dealId]
  );
  const outboxRows = await pool.query(
    `SELECT event_type, status
     FROM siton.outbox_events
     WHERE aggregate_id=$1
       AND event_type IN ('finalize_deal','recovery_deal')
     ORDER BY event_type ASC`,
    [dealId]
  );

  assert.equal(deal?.state, "CompletionWindow");
  assert.ok(deal?.completion_window_until);
  assert.deepEqual(
    outboxRows.rows.map((row) => `${row.event_type}:${row.status}`),
    ["finalize_deal:pending", "recovery_deal:pending"]
  );
});

await pool.end();
process.exit(0);
