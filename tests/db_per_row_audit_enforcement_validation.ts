// Red-team finding C-1 (Medium) regression: the deals/participants BEFORE
// UPDATE triggers only checked a transaction-global "some audit row was
// written" flag. Migration 076 adds the PER-ROW assertion: the audit row must
// be for THIS entity, THIS transition and THIS action, written in the same
// transaction; the outbox-required deal actions need an outbox row for THIS
// deal. Every "rejected" case below passes the old flag check — and the old
// trigger accepted it.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import "dotenv/config";

process.env.DISABLE_OUTBOX_WORKER = "1";

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton" });

async function runTest(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (error) { console.error(`FAIL ${name}`); throw error; }
}

async function inTx(fn: (client: pg.PoolClient) => Promise<void>): Promise<string | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      await fn(client);
      await client.query("COMMIT");
      return null;
    } catch (error: any) {
      await client.query("ROLLBACK");
      return String(error?.message || error);
    }
  } finally {
    client.release();
  }
}

async function seedDeal(state: string, published = true) {
  const dealId = randomUUID();
  await pool.query(
    `INSERT INTO siton.deals (deal_id, seller_id, state, title, price_per_unit, min_units, max_units, threshold_units, deadline, published_at)
     VALUES ($1,'seller-c1',$2,'C-1 per-row fixture',10,2,10,2,now()+interval '1 day',$3)`,
    [dealId, state, published ? new Date().toISOString() : null]
  );
  return dealId;
}

async function seedParticipant(dealId: string, buyerState: string, moneyState: string) {
  const participantId = randomUUID();
  await pool.query(
    `INSERT INTO siton.participants (participant_id, deal_id, buyer_id, qty, buyer_state, money_state)
     VALUES ($1,$2,$3,1,$4,$5)`,
    [participantId, dealId, `buyer-${participantId.slice(0, 8)}`, buyerState, moneyState]
  );
  return participantId;
}

async function arm(client: pg.PoolClient, action: string, audit = "1", outbox = "1") {
  await client.query(`SELECT set_config('siton.in_atomic', 'true', true)`);
  await client.query(`SELECT set_config('siton.action_name', $1, true)`, [action]);
  await client.query(`SELECT set_config('siton.audit_written', $1, true)`, [audit]);
  await client.query(`SELECT set_config('siton.outbox_written', $1, true)`, [outbox]);
}

async function auditRow(client: pg.PoolClient, args: { entityType: "deal" | "participant"; entityId: string; dealId: string; stateType: string; from: string; to: string; action: string; createdAtSql?: string }) {
  await client.query(
    `INSERT INTO siton.audit_log (entity_type, entity_id, deal_id, state_type, from_state, to_state, action_name, request_id, correlation_id, idempotency_key, payload, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,'{}'::jsonb, ${args.createdAtSql || "now()"})`,
    [args.entityType, args.entityId, args.dealId, args.stateType, args.from, args.to, args.action, `c1:${randomUUID()}`, `c1:${randomUUID()}`]
  );
}

async function outboxRow(client: pg.PoolClient, dealId: string, eventType = "charge_deal") {
  await client.query(
    `INSERT INTO siton.outbox_events (event_type, aggregate_type, aggregate_id, payload, status, attempt_count, available_at, sent, sent_at)
     VALUES ($2,'deal',$1,'{"c1":true}','sent',1,now(),true,now())`,
    [dealId, eventType]
  );
}

await runTest("deal: a forged audit flag with NO audit row is rejected per-row", async () => {
  const dealId = await seedDeal("PendingTarget");
  const err = await inTx(async (c) => {
    await arm(c, "deal.target_reached");
    await c.query(`UPDATE siton.deals SET state='TargetReached' WHERE deal_id=$1`, [dealId]);
  });
  assert.match(String(err), /matching audit_log row for this deal/);
});

await runTest("deal: an audit row for ANOTHER deal (same transition, same txn) does not satisfy this row", async () => {
  const dealId = await seedDeal("PendingTarget");
  const otherDeal = await seedDeal("PendingTarget");
  const err = await inTx(async (c) => {
    await arm(c, "deal.target_reached");
    await auditRow(c, { entityType: "deal", entityId: otherDeal, dealId: otherDeal, stateType: "deal_state", from: "PendingTarget", to: "TargetReached", action: "deal.target_reached" });
    await c.query(`UPDATE siton.deals SET state='TargetReached' WHERE deal_id=$1`, [dealId]);
  });
  assert.match(String(err), /matching audit_log row for this deal/);
});

await runTest("deal: an audit row for this deal but a different transition/action is rejected", async () => {
  const dealId = await seedDeal("PendingTarget");
  const wrongTo = await inTx(async (c) => {
    await arm(c, "deal.target_reached");
    // A LEGAL but different transition for this deal (PendingTarget → Failed).
    await auditRow(c, { entityType: "deal", entityId: dealId, dealId, stateType: "deal_state", from: "PendingTarget", to: "Failed", action: "deal.target_reached" });
    await c.query(`UPDATE siton.deals SET state='TargetReached' WHERE deal_id=$1`, [dealId]);
  });
  assert.match(String(wrongTo), /matching audit_log row for this deal/);
  const wrongAction = await inTx(async (c) => {
    await arm(c, "deal.target_reached");
    await auditRow(c, { entityType: "deal", entityId: dealId, dealId, stateType: "deal_state", from: "PendingTarget", to: "TargetReached", action: "test.other_action" });
    await c.query(`UPDATE siton.deals SET state='TargetReached' WHERE deal_id=$1`, [dealId]);
  });
  assert.match(String(wrongAction), /matching audit_log row for this deal/);
});

await runTest("deal: an audit row from an EARLIER committed transaction does not count", async () => {
  const dealId = await seedDeal("PendingTarget");
  // Commit a matching audit row on its own (as if a previous attempt wrote it).
  assert.equal(await inTx(async (c) => {
    await auditRow(c, { entityType: "deal", entityId: dealId, dealId, stateType: "deal_state", from: "PendingTarget", to: "TargetReached", action: "deal.target_reached" });
  }), null);
  await new Promise((r) => setTimeout(r, 5));
  const err = await inTx(async (c) => {
    await arm(c, "deal.target_reached");
    await c.query(`UPDATE siton.deals SET state='TargetReached' WHERE deal_id=$1`, [dealId]);
  });
  assert.match(String(err), /matching audit_log row for this deal/);
});

await runTest("deal: a FUTURE-DATED audit row from an earlier transaction does not count (row identity, not timestamps)", async () => {
  const dealId = await seedDeal("PendingTarget");
  // An attacker/bug that could write audit rows commits one dated an hour
  // ahead: a timestamp-based "written in this transaction" test would accept
  // it in every later transaction. Transaction identity does not.
  assert.equal(await inTx(async (c) => {
    await auditRow(c, { entityType: "deal", entityId: dealId, dealId, stateType: "deal_state", from: "PendingTarget", to: "TargetReached", action: "deal.target_reached", createdAtSql: "now() + interval '1 hour'" });
  }), null);
  const err = await inTx(async (c) => {
    await arm(c, "deal.target_reached");
    await c.query(`UPDATE siton.deals SET state='TargetReached' WHERE deal_id=$1`, [dealId]);
  });
  assert.match(String(err), /matching audit_log row for this deal/);
});

await runTest("deal: a matching audit row ANOTHER transaction commits while this one is open does not count", async () => {
  const dealId = await seedDeal("PendingTarget");
  const long = await pool.connect();
  try {
    await long.query("BEGIN");
    await arm(long, "deal.target_reached");
    // Take a snapshot / xid first, then let a concurrent transaction commit
    // the matching row: under READ COMMITTED the trigger's probe would SEE it.
    await long.query(`SELECT pg_current_xact_id()`);
    assert.equal(await inTx(async (c) => {
      await auditRow(c, { entityType: "deal", entityId: dealId, dealId, stateType: "deal_state", from: "PendingTarget", to: "TargetReached", action: "deal.target_reached" });
    }), null);
    const visible = await long.query(`SELECT count(*)::int AS n FROM siton.audit_log WHERE entity_id=$1`, [dealId]);
    assert.equal(visible.rows[0].n, 1, "the concurrent row is visible to the open transaction");
    let err: string | null = null;
    try {
      await long.query(`UPDATE siton.deals SET state='TargetReached' WHERE deal_id=$1`, [dealId]);
    } catch (error: any) {
      err = String(error?.message || error);
    }
    await long.query("ROLLBACK");
    assert.match(String(err), /matching audit_log row for this deal/);
  } finally {
    long.release();
  }
});

await runTest("deal: an audit row written inside a SAVEPOINT of this transaction is accepted", async () => {
  const dealId = await seedDeal("PendingTarget");
  const err = await inTx(async (c) => {
    await arm(c, "deal.target_reached");
    await c.query("SAVEPOINT audit_step");
    await auditRow(c, { entityType: "deal", entityId: dealId, dealId, stateType: "deal_state", from: "PendingTarget", to: "TargetReached", action: "deal.target_reached" });
    await c.query("RELEASE SAVEPOINT audit_step");
    await c.query(`UPDATE siton.deals SET state='TargetReached' WHERE deal_id=$1`, [dealId]);
  });
  assert.equal(err, null, String(err));
  // ...but a row whose savepoint was ROLLED BACK is gone and does not count.
  const dealId2 = await seedDeal("PendingTarget");
  const rolled = await inTx(async (c) => {
    await arm(c, "deal.target_reached");
    await c.query("SAVEPOINT audit_step");
    await auditRow(c, { entityType: "deal", entityId: dealId2, dealId: dealId2, stateType: "deal_state", from: "PendingTarget", to: "TargetReached", action: "deal.target_reached" });
    await c.query("ROLLBACK TO SAVEPOINT audit_step");
    await c.query(`UPDATE siton.deals SET state='TargetReached' WHERE deal_id=$1`, [dealId2]);
  });
  assert.match(String(rolled), /matching audit_log row for this deal/);
});

await runTest("deal: the matching audit row in the same transaction is accepted", async () => {
  const dealId = await seedDeal("PendingTarget");
  const err = await inTx(async (c) => {
    await arm(c, "deal.target_reached");
    await auditRow(c, { entityType: "deal", entityId: dealId, dealId, stateType: "deal_state", from: "PendingTarget", to: "TargetReached", action: "deal.target_reached" });
    await c.query(`UPDATE siton.deals SET state='TargetReached' WHERE deal_id=$1`, [dealId]);
  });
  assert.equal(err, null, String(err));
  const row = await pool.query(`SELECT state FROM siton.deals WHERE deal_id=$1`, [dealId]);
  assert.equal(row.rows[0].state, "TargetReached");
});

await runTest("participant: each changed column needs its own matching audit row", async () => {
  const dealId = await seedDeal("PendingTarget");
  const pid = await seedParticipant(dealId, "NotJoined", "NoFinancial");
  // Only the money_state audit row is present; the buyer_state change is rejected.
  const err = await inTx(async (c) => {
    await arm(c, "participant.join_authorize");
    await auditRow(c, { entityType: "participant", entityId: pid, dealId, stateType: "money_state", from: "NoFinancial", to: "AuthHeld", action: "participant.join_authorize" });
    await c.query(`UPDATE siton.participants SET buyer_state='JoinedAuthorized', money_state='AuthHeld' WHERE participant_id=$1`, [pid]);
  });
  assert.match(String(err), /participant buyer_state change requires a matching audit_log row/);
  // An audit row for a DIFFERENT participant does not count either.
  const otherPid = await seedParticipant(dealId, "NotJoined", "NoFinancial");
  const other = await inTx(async (c) => {
    await arm(c, "participant.join_authorize");
    await auditRow(c, { entityType: "participant", entityId: otherPid, dealId, stateType: "buyer_state", from: "NotJoined", to: "JoinedAuthorized", action: "participant.join_authorize" });
    await c.query(`UPDATE siton.participants SET buyer_state='JoinedAuthorized' WHERE participant_id=$1`, [pid]);
  });
  assert.match(String(other), /matching audit_log row for this participant/);
  // Both rows present: accepted.
  const ok = await inTx(async (c) => {
    await arm(c, "participant.join_authorize");
    await auditRow(c, { entityType: "participant", entityId: pid, dealId, stateType: "buyer_state", from: "NotJoined", to: "JoinedAuthorized", action: "participant.join_authorize" });
    await auditRow(c, { entityType: "participant", entityId: pid, dealId, stateType: "money_state", from: "NoFinancial", to: "AuthHeld", action: "participant.join_authorize" });
    await c.query(`UPDATE siton.participants SET buyer_state='JoinedAuthorized', money_state='AuthHeld' WHERE participant_id=$1`, [pid]);
  });
  assert.equal(ok, null, String(ok));
});

await runTest("outbox: an outbox-required deal action needs an outbox row for THIS deal, not merely the flag", async () => {
  const dealId = await seedDeal("ReadyForCharging");
  const otherDeal = await seedDeal("ReadyForCharging");
  const forged = await inTx(async (c) => {
    await arm(c, "charging.start");
    await auditRow(c, { entityType: "deal", entityId: dealId, dealId, stateType: "deal_state", from: "ReadyForCharging", to: "Charging", action: "charging.start" });
    await outboxRow(c, otherDeal); // a row for the WRONG deal
    await c.query(`UPDATE siton.deals SET state='Charging' WHERE deal_id=$1`, [dealId]);
  });
  assert.match(String(forged), /outbox_events row for this deal/);
  // A same-deal row of the WRONG type (a sent deadline_check) must not let the
  // deal enter Charging without its charge_deal job.
  const wrongType = await inTx(async (c) => {
    await arm(c, "charging.start");
    await auditRow(c, { entityType: "deal", entityId: dealId, dealId, stateType: "deal_state", from: "ReadyForCharging", to: "Charging", action: "charging.start" });
    await outboxRow(c, dealId, "deadline_check");
    await c.query(`UPDATE siton.deals SET state='Charging' WHERE deal_id=$1`, [dealId]);
  });
  assert.match(String(wrongType), /requires a charge_deal outbox_events row for this deal/);
  const ok = await inTx(async (c) => {
    await arm(c, "charging.start");
    await auditRow(c, { entityType: "deal", entityId: dealId, dealId, stateType: "deal_state", from: "ReadyForCharging", to: "Charging", action: "charging.start" });
    await outboxRow(c, dealId);
    await c.query(`UPDATE siton.deals SET state='Charging' WHERE deal_id=$1`, [dealId]);
  });
  assert.equal(ok, null, String(ok));
});

await runTest("outbox: UPDATING an old, already-sent job of the required type is not insertion evidence", async () => {
  const dealId = await seedDeal("ReadyForCharging");
  // A sent charge_deal job from an earlier transaction exists for this deal.
  const old = await pool.query(
    `INSERT INTO siton.outbox_events (event_type, aggregate_type, aggregate_id, payload, status, attempt_count, available_at, sent, sent_at)
     VALUES ('charge_deal','deal',$1,'{"old":true}','sent',1,now() - interval '1 day',true,now() - interval '1 day') RETURNING event_uuid`,
    [dealId]
  );
  const touched = await inTx(async (c) => {
    await arm(c, "charging.start");
    await auditRow(c, { entityType: "deal", entityId: dealId, dealId, stateType: "deal_state", from: "ReadyForCharging", to: "Charging", action: "charging.start" });
    // Touch the old row: its new version now carries THIS transaction's xmin.
    await c.query(`UPDATE siton.outbox_events SET updated_at=now() WHERE event_uuid=$1`, [old.rows[0].event_uuid]);
    await c.query(`UPDATE siton.deals SET state='Charging' WHERE deal_id=$1`, [dealId]);
  });
  assert.match(String(touched), /requires a charge_deal outbox_events row for this deal/);
  // Even re-arming it as pending is not an insert.
  const rearmed = await inTx(async (c) => {
    await arm(c, "charging.start");
    await auditRow(c, { entityType: "deal", entityId: dealId, dealId, stateType: "deal_state", from: "ReadyForCharging", to: "Charging", action: "charging.start" });
    await c.query(`UPDATE siton.outbox_events SET status='pending', sent=false, sent_at=NULL, attempt_count=0, available_at=now() WHERE event_uuid=$1`, [old.rows[0].event_uuid]);
    await c.query(`UPDATE siton.deals SET state='Charging' WHERE deal_id=$1`, [dealId]);
  });
  assert.match(String(rearmed), /requires a charge_deal outbox_events row for this deal/);
  // The evidence table refuses UPDATE for everyone, and the runtime roles
  // (when they exist on this cluster) hold no privilege on it at all.
  const evidenceUpdate = await inTx(async (c) => {
    await c.query(`UPDATE siton.outbox_enqueue_evidence SET event_type='deadline_check' WHERE aggregate_id=$1`, [dealId]);
  });
  assert.match(String(evidenceUpdate), /insert-only/);
  const privileges = await pool.query(
    `SELECT r.rolname,
            has_table_privilege(r.rolname, 'siton.outbox_enqueue_evidence', 'INSERT') AS can_insert,
            has_table_privilege(r.rolname, 'siton.outbox_enqueue_evidence', 'UPDATE') AS can_update,
            has_table_privilege(r.rolname, 'siton.outbox_enqueue_evidence', 'DELETE') AS can_delete
     FROM pg_roles r WHERE r.rolname IN ('siton_web_runtime','siton_worker_runtime','anon','authenticated')`
  );
  for (const row of privileges.rows) {
    assert.equal(row.can_insert, false, `${row.rolname} must not insert evidence`);
    assert.equal(row.can_update, false, `${row.rolname} must not update evidence`);
    assert.equal(row.can_delete, false, `${row.rolname} must not delete evidence`);
  }
  // Insert-then-delete in the same transaction leaves evidence but no job:
  // the probe joins the evidence to the LIVE outbox row, so it is rejected.
  const deletedAgain = await inTx(async (c) => {
    await arm(c, "charging.start");
    await auditRow(c, { entityType: "deal", entityId: dealId, dealId, stateType: "deal_state", from: "ReadyForCharging", to: "Charging", action: "charging.start" });
    const inserted = await c.query(
      `INSERT INTO siton.outbox_events (event_type, aggregate_type, aggregate_id, payload, status, attempt_count, available_at)
       VALUES ('charge_deal','deal',$1,'{"c1":true}','pending',0,now()) RETURNING event_uuid`,
      [dealId]
    );
    await c.query(`DELETE FROM siton.outbox_events WHERE event_uuid=$1`, [inserted.rows[0].event_uuid]);
    await c.query(`UPDATE siton.deals SET state='Charging' WHERE deal_id=$1`, [dealId]);
  });
  assert.match(String(deletedAgain), /requires a charge_deal outbox_events row for this deal/);
  const me = await pool.query(`SELECT rolsuper FROM pg_roles WHERE rolname = current_user`);
  if (!me.rows[0]?.rolsuper) {
    const forgedEvidence = await inTx(async (c) => {
      await c.query(`INSERT INTO siton.outbox_enqueue_evidence (event_uuid, aggregate_type, aggregate_id, event_type) VALUES (gen_random_uuid(),'deal',$1,'charge_deal')`, [dealId]);
    });
    assert.match(String(forgedEvidence), /permission denied/);
  }
  const ok = await inTx(async (c) => {
    await arm(c, "charging.start");
    await auditRow(c, { entityType: "deal", entityId: dealId, dealId, stateType: "deal_state", from: "ReadyForCharging", to: "Charging", action: "charging.start" });
    await outboxRow(c, dealId, "charge_deal");
    await c.query(`UPDATE siton.deals SET state='Charging' WHERE deal_id=$1`, [dealId]);
  });
  assert.equal(ok, null, String(ok));
});

await runTest("outbox: every outbox-required action is bound to its own job type", async () => {
  const cases: Array<[string, string, string, string]> = [
    ["deal.publish", "Draft", "PendingTarget", "deadline_check"],
    ["charging.to_completion_window", "Charging", "CompletionWindow", "finalize_deal"],
    ["charging.finalize_failed", "CompletionWindow", "Failed", "refund_issue"],
    ["deal.cancel", "Draft", "Cancelled", "cancel_refund"]
  ];
  for (const [action, from, to, eventType] of cases) {
    const dealId = await seedDeal(from, from !== "Draft");
    const wrong = await inTx(async (c) => {
      await arm(c, action);
      await auditRow(c, { entityType: "deal", entityId: dealId, dealId, stateType: "deal_state", from, to, action });
      await outboxRow(c, dealId, eventType === "charge_deal" ? "deadline_check" : "charge_deal");
      await c.query(`UPDATE siton.deals SET state=$2 WHERE deal_id=$1`, [dealId, to]);
    });
    assert.match(String(wrong), new RegExp(`requires a ${eventType} outbox_events row for this deal`), `${action}: ${wrong}`);
    const ok = await inTx(async (c) => {
      await arm(c, action);
      await auditRow(c, { entityType: "deal", entityId: dealId, dealId, stateType: "deal_state", from, to, action });
      await outboxRow(c, dealId, eventType);
      await c.query(`UPDATE siton.deals SET state=$2 WHERE deal_id=$1`, [dealId, to]);
    });
    assert.equal(ok, null, `${action}: ${ok}`);
  }
});

await runTest("the coarse flag checks are still enforced first (defence in depth)", async () => {
  const dealId = await seedDeal("PendingTarget");
  const err = await inTx(async (c) => {
    await arm(c, "deal.target_reached", "0", "1");
    await auditRow(c, { entityType: "deal", entityId: dealId, dealId, stateType: "deal_state", from: "PendingTarget", to: "TargetReached", action: "deal.target_reached" });
    await c.query(`UPDATE siton.deals SET state='TargetReached' WHERE deal_id=$1`, [dealId]);
  });
  assert.match(String(err), /audit_log in same transaction/);
});

await pool.end();
console.log("PASS db per-row audit/outbox enforcement (migration 076)");
