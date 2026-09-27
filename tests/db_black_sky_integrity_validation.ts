// BLACK-SKY DB INTEGRITY (migration 078) — proof, fix, negative controls.
//
//   D2  a deal delete can no longer cascade money/audit history away: money
//       FKs are ON DELETE RESTRICT and a BEFORE DELETE guard on siton.deals
//       refuses any deal that was ever published or has participant/money
//       rows. Never-published drafts stay deletable (seller draft-delete
//       route). Test fixtures keep a cleanup path through an explicit, audited
//       escape hatch that exists only when siton.allow_test_actions = '1' and
//       never for a runtime role.
//   D3  'test.%' action names are valid only when siton.allow_test_actions =
//       '1'; the outbox requirement is keyed by the TRANSITION (target state
//       that must enqueue work), not only by the action name.
//   D10 price_per_unit > 0, delivery_cost >= 0, seller_id frozen after
//       publish, participant delivery fields frozen once a charge began.
//   D9  issued invoice documents are immutable and unique per participant and
//       receipt type; payment_attempts / webhook_events identity columns are
//       immutable.
//   D12 the long-standing NOT VALID constraints are validated.
//   D8  the readiness contract fails closed on a DISABLED enforcement trigger
//       and on a runtime role holding DELETE/TRUNCATE on a money table.
//
// Every "refused" case below passes on the pre-078 schema only by being
// silently ACCEPTED, so each one fails before the migration.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { forcedDealStep } from "./helpers/forced_state.js";
import { assertDatabaseSchema } from "../src/schema_contract.js";

process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.APP_DEPLOYMENT_MODE = "demo-preview";

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton", max: 4 });

let failed = 0;
async function runTest(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (error: any) { failed += 1; console.error(`FAIL ${name}: ${error?.stack || error?.message || error}`); }
}

/** Run fn in a transaction; return the error (or null) and always roll back unless commit=true. */
async function inTx(fn: (c: pg.PoolClient) => Promise<void>, options: { commit?: boolean; testActions?: "0" | "1" } = {}) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    if (options.testActions) await c.query(`SELECT set_config('siton.allow_test_actions', $1, true)`, [options.testActions]);
    await fn(c);
    await c.query(options.commit ? "COMMIT" : "ROLLBACK");
    return null;
  } catch (error: any) {
    await c.query("ROLLBACK").catch(() => undefined);
    return error as Error;
  } finally {
    c.release();
  }
}

const SELLER = `seller-bs078-${randomUUID().slice(0, 8)}`;

async function seedDraft(overrides: { price?: number } = {}) {
  const dealId = randomUUID();
  await pool.query(
    `INSERT INTO siton.deals (deal_id, seller_id, state, title, price_per_unit, min_units, max_units, threshold_units, deadline)
     VALUES ($1,$2,'Draft','BS078 fixture',$3,2,10,2,now()+interval '2 days')`,
    [dealId, SELLER, overrides.price ?? 25]
  );
  return dealId;
}

async function seedPublished() {
  const dealId = await seedDraft();
  const err = await inTx(async (c) => {
    await c.query(`SELECT set_config('siton.in_atomic','true',true)`);
    await forcedDealStep(c, dealId, "PendingTarget", "deal.publish", { extraSet: "published_at=now()" });
  }, { commit: true });
  if (err) throw err;
  return dealId;
}

async function seedParticipant(dealId: string, buyerState = "JoinedAuthorized", moneyState = "AuthHeld") {
  const participantId = randomUUID();
  await pool.query(
    `INSERT INTO siton.participants (participant_id, deal_id, buyer_id, qty, buyer_state, money_state, delivery_method_type, delivery_cost)
     VALUES ($1,$2,$3,1,$4,$5,'delivery',15)`,
    [participantId, dealId, `buyer-${participantId.slice(0, 8)}`, buyerState, moneyState]
  );
  return participantId;
}

async function seedMoney(dealId: string, participantId: string) {
  await pool.query(
    `INSERT INTO siton.payment_attempts (participant_id, deal_id, attempt_type, result_class, correlation_id, dispatch_state)
     VALUES ($1,$2,'charge_start','success',$3,'responded')`,
    [participantId, dealId, `bs078-${randomUUID()}`]
  );
  await pool.query(
    `INSERT INTO siton.platform_fee_money_events (participant_id, deal_id, seller_id, event_type, logical_entry_type, provider_code, source_money_state, payout_readiness_status, gross_amount, vat_amount, fee_base_amount, platform_fee_rate, platform_fee_vat_rate, platform_fee_base_amount, platform_fee_vat_amount, platform_fee_total_amount, platform_fee_amount, seller_net_amount)
     VALUES ($1,$2,$3,'charge_captured','charge','mockpay','ChargedSuccess','ready_for_settlement',40,0,40,0.08,0.18,3.20,0.58,3.78,3.78,36.22)`,
    [participantId, dealId, SELLER]
  );
}

const count = async (sql: string, params: unknown[]) => Number((await pool.query(sql, params)).rows[0].n);

// ── D2 ────────────────────────────────────────────────────────────────────
await runTest("D2: money/participant FKs no longer cascade (ON DELETE RESTRICT)", async () => {
  const rows = await pool.query(
    `SELECT conname, confdeltype FROM pg_constraint
     WHERE connamespace='siton'::regnamespace AND contype='f' AND conname = ANY($1::text[])`,
    [[
      "participants_deal_id_fkey", "payment_attempts_deal_id_fkey", "payment_attempts_participant_id_fkey",
      "platform_fee_money_events_deal_id_fkey", "platform_fee_money_events_participant_id_fkey",
      "seller_settlements_deal_id_fkey", "seller_payout_batches_trigger_deal_id_fkey",
      "seller_payout_batch_items_deal_id_fkey", "seller_payout_batch_items_participant_id_fkey",
      "seller_payout_reconciliation_cases_deal_id_fkey", "fulfillment_units_deal_id_fkey", "fulfillment_units_participant_id_fkey"
    ]]
  );
  assert.equal(rows.rowCount, 12, "every money FK is present");
  const cascading = rows.rows.filter((r) => r.confdeltype !== "r").map((r) => `${r.conname}=${r.confdeltype}`);
  assert.deepEqual(cascading, [], "money FKs must be ON DELETE RESTRICT");
  const unvalidated = await count(`SELECT count(*)::int AS n FROM pg_constraint WHERE connamespace='siton'::regnamespace AND contype='f' AND NOT convalidated`, []);
  assert.equal(unvalidated, 0, "re-added FKs are validated");
});

await runTest("D2: outside test mode a published deal with money history cannot be deleted, and nothing cascades", async () => {
  const dealId = await seedPublished();
  const participantId = await seedParticipant(dealId, "ChargedSuccess", "ChargedSuccess");
  await seedMoney(dealId, participantId);
  const err = await inTx(async (c) => { await c.query(`DELETE FROM siton.deals WHERE deal_id=$1`, [dealId]); }, { testActions: "0", commit: true });
  assert.match(String(err), /deal_delete_refused/);
  const partErr = await inTx(async (c) => { await c.query(`DELETE FROM siton.participants WHERE deal_id=$1`, [dealId]); }, { testActions: "0", commit: true });
  assert.ok(partErr, "a participant with payment attempts cannot be deleted outside test mode");
  assert.equal(await count(`SELECT count(*)::int AS n FROM siton.payment_attempts WHERE deal_id=$1`, [dealId]), 1);
  assert.equal(await count(`SELECT count(*)::int AS n FROM siton.platform_fee_money_events WHERE deal_id=$1`, [dealId]), 1);
  assert.equal(await count(`SELECT count(*)::int AS n FROM siton.participants WHERE deal_id=$1`, [dealId]), 1);
});

await runTest("D2: outside test mode an untouched but PUBLISHED deal is refused too", async () => {
  const dealId = await seedPublished();
  const err = await inTx(async (c) => { await c.query(`DELETE FROM siton.deals WHERE deal_id=$1`, [dealId]); }, { testActions: "0", commit: true });
  assert.match(String(err), /deal_delete_refused/);
  assert.equal(await count(`SELECT count(*)::int AS n FROM siton.deals WHERE deal_id=$1`, [dealId]), 1);
});

await runTest("D2 negative control: a never-published draft without money rows stays deletable (content still cascades)", async () => {
  const dealId = await seedDraft();
  await pool.query(`INSERT INTO siton.deal_images (deal_id, storage_key, mime_type, size_bytes) VALUES ($1,$2,'image/png',100)`, [dealId, `bs078-${randomUUID()}`]);
  const err = await inTx(async (c) => { await c.query(`DELETE FROM siton.deals WHERE deal_id=$1`, [dealId]); }, { testActions: "0", commit: true });
  assert.equal(err, null, String(err));
  assert.equal(await count(`SELECT count(*)::int AS n FROM siton.deal_images WHERE deal_id=$1`, [dealId]), 0);
});

await runTest("D2: the fixture escape hatch deletes with test actions enabled and leaves an audit row", async () => {
  const dealId = await seedPublished();
  const participantId = await seedParticipant(dealId, "ChargedSuccess", "ChargedSuccess");
  await seedMoney(dealId, participantId);
  const err = await inTx(async (c) => { await c.query(`DELETE FROM siton.deals WHERE deal_id=$1`, [dealId]); }, { testActions: "1", commit: true });
  assert.equal(err, null, String(err));
  assert.equal(await count(`SELECT count(*)::int AS n FROM siton.deals WHERE deal_id=$1`, [dealId]), 0);
  assert.equal(await count(`SELECT count(*)::int AS n FROM siton.payment_attempts WHERE deal_id=$1`, [dealId]), 0);
  const audit = await pool.query(`SELECT entity_type, purged FROM siton.fixture_purge_audit WHERE deal_id=$1 AND entity_type='deal'`, [dealId]);
  assert.equal(audit.rowCount, 1, "the hatch is audited");
  assert.equal(Number(audit.rows[0].purged.payment_attempts), 1);
  const rewrite = await inTx(async (c) => { await c.query(`UPDATE siton.fixture_purge_audit SET purged='{}'::jsonb WHERE deal_id=$1`, [dealId]); });
  assert.match(String(rewrite), /append-only/);
});

await runTest("D2: the escape hatch is never available to a runtime role, even with the setting forged", async () => {
  const probe = `siton_bs078_probe_${randomUUID().slice(0, 8)}`;
  await pool.query(`DO $r$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='siton_web_runtime') THEN CREATE ROLE siton_web_runtime NOLOGIN NOINHERIT; END IF; END $r$`);
  await pool.query(`CREATE ROLE ${probe} NOLOGIN`);
  try {
    await pool.query(`GRANT siton_web_runtime TO ${probe}`);
    await pool.query(`GRANT USAGE ON SCHEMA siton TO ${probe}`);
    await pool.query(`GRANT SELECT, DELETE ON siton.deals TO ${probe}`);
    await pool.query(`GRANT SELECT ON siton.participants, siton.payment_attempts, siton.platform_fee_money_events, siton.webhook_events, siton.payment_authorization_bindings, siton.invoice_documents TO ${probe}`);
    const dealId = await seedPublished();
    const err = await inTx(async (c) => {
      await c.query(`SET LOCAL ROLE ${probe}`);
      await c.query(`SELECT set_config('siton.allow_test_actions','1',true)`);
      await c.query(`DELETE FROM siton.deals WHERE deal_id=$1`, [dealId]);
    }, { commit: true });
    assert.match(String(err), /deal_delete_refused/);
    assert.equal(await count(`SELECT count(*)::int AS n FROM siton.deals WHERE deal_id=$1`, [dealId]), 1);

    // A superuser that becomes the runtime role (SET ROLE) is the runtime role.
    const guardTables = "siton.participants, siton.payment_attempts, siton.platform_fee_money_events, siton.webhook_events, siton.payment_authorization_bindings, siton.invoice_documents";
    await pool.query(`GRANT USAGE ON SCHEMA siton TO siton_web_runtime`);
    await pool.query(`GRANT SELECT, DELETE ON siton.deals TO siton_web_runtime`);
    await pool.query(`GRANT SELECT ON ${guardTables} TO siton_web_runtime`);
    try {
      const asRuntime = await inTx(async (c) => {
        await c.query(`SET LOCAL ROLE siton_web_runtime`);
        await c.query(`SELECT set_config('siton.allow_test_actions','1',true)`);
        await c.query(`DELETE FROM siton.deals WHERE deal_id=$1`, [dealId]);
      }, { commit: true });
      assert.match(String(asRuntime), /deal_delete_refused/);
      assert.equal(await count(`SELECT count(*)::int AS n FROM siton.deals WHERE deal_id=$1`, [dealId]), 1);
    } finally {
      await pool.query(`REVOKE DELETE ON siton.deals FROM siton_web_runtime`);
    }
  } finally {
    await pool.query(`DROP OWNED BY ${probe}`).catch(() => undefined);
    await pool.query(`DROP ROLE IF EXISTS ${probe}`).catch(() => undefined);
  }
});

await runTest("D2: the seller delete route refuses a published (even untouched) deal and still deletes a draft", async () => {
  const { app } = await import("../src/app.js");
  const headers = { "x-seller-id": SELLER };
  const published = await seedPublished();
  const refused = await app.inject({ method: "DELETE", url: `/api/seller/deals/${published}`, headers });
  assert.equal(refused.statusCode, 409, refused.body);
  assert.equal(refused.json().code, "deal_delete_not_allowed");
  assert.equal(await count(`SELECT count(*)::int AS n FROM siton.deals WHERE deal_id=$1`, [published]), 1);
  const draft = await seedDraft();
  const ok = await app.inject({ method: "DELETE", url: `/api/seller/deals/${draft}`, headers });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(await count(`SELECT count(*)::int AS n FROM siton.deals WHERE deal_id=$1`, [draft]), 0);
  await app.close().catch(() => undefined);
});

// ── D3 ────────────────────────────────────────────────────────────────────
await runTest("D3: 'test.%' action names are valid only when test actions are enabled", async () => {
  const off = await pool.connect();
  try {
    await off.query("BEGIN");
    await off.query(`SELECT set_config('siton.allow_test_actions','0',true)`);
    const r = await off.query(`SELECT siton.is_valid_action_name('test.fixture') AS t, siton.is_valid_action_name('deal.publish') AS p`);
    assert.equal(r.rows[0].t, false, "test.* is rejected in production mode");
    assert.equal(r.rows[0].p, true);
    await off.query(`SELECT set_config('siton.allow_test_actions','1',true)`);
    const on = await off.query(`SELECT siton.is_valid_action_name('test.fixture') AS t`);
    assert.equal(on.rows[0].t, true);
  } finally {
    await off.query("ROLLBACK");
    off.release();
  }
  const dealId = await seedDraft();
  const err = await inTx(async (c) => {
    await c.query(
      `INSERT INTO siton.audit_log (entity_type, entity_id, deal_id, state_type, from_state, to_state, action_name, request_id, correlation_id, idempotency_key)
       VALUES ('deal',$1,$1,'deal_state','Draft','PendingTarget','test.fixture','r','r',$2)`,
      [dealId, `bs078-${randomUUID()}`]
    );
  }, { testActions: "0" });
  assert.match(String(err), /action_name is invalid/);
});

await runTest("D3: a must-enqueue transition needs its outbox job whatever the action name", async () => {
  const cases: Array<[string, string, string]> = [
    ["Draft", "PendingTarget", "deadline_check"],
    ["ReadyForCharging", "Charging", "charge_deal"],
    ["Charging", "CompletionWindow", "finalize_deal"],
    ["CompletionWindow", "Failed", "refund_issue"],
    ["Draft", "Cancelled", "cancel_refund"]
  ];
  for (const [from, to, eventType] of cases) {
    const dealId = await seedDraft();
    if (from !== "Draft") await pool.query(`UPDATE siton.deals SET published_at=now() WHERE deal_id=$1`, [dealId]);
    if (from !== "Draft") {
      // move the fixture to `from` without the state trigger in the way
      await pool.query(`ALTER TABLE siton.deals DISABLE TRIGGER USER`);
      try { await pool.query(`UPDATE siton.deals SET state=$2 WHERE deal_id=$1`, [dealId, from]); }
      finally { await pool.query(`ALTER TABLE siton.deals ENABLE TRIGGER USER`); }
    }
    const step = async (c: pg.PoolClient, withJob: boolean) => {
      await c.query(`SELECT set_config('siton.in_atomic','true',true)`);
      await c.query(`SELECT set_config('siton.action_name','test.fixture',true)`);
      await c.query(`SELECT set_config('siton.audit_written','1',true)`);
      await c.query(`SELECT set_config('siton.outbox_written','1',true)`);
      await c.query(
        `INSERT INTO siton.audit_log (entity_type, entity_id, deal_id, state_type, from_state, to_state, action_name, request_id, correlation_id, idempotency_key)
         VALUES ('deal',$1,$1,'deal_state',$2,$3,'test.fixture','r','r',$4)`,
        [dealId, from, to, `bs078-${randomUUID()}`]
      );
      if (withJob) {
        await c.query(
          `INSERT INTO siton.outbox_events (event_type, aggregate_type, aggregate_id, payload, status, attempt_count, available_at)
           VALUES ($2,'deal',$1,'{"bs078":true}','pending',0,now() + interval '100 years')`,
          [dealId, eventType]
        );
      }
      await c.query(`UPDATE siton.deals SET state=$2 WHERE deal_id=$1`, [dealId, to]);
    };
    const missing = await inTx((c) => step(c, false), { testActions: "1" });
    assert.match(String(missing), new RegExp(`requires a ${eventType} outbox_events row for this deal`), `${from}->${to}: ${missing}`);
    const ok = await inTx((c) => step(c, true), { testActions: "1" });
    assert.equal(ok, null, `${from}->${to}: ${ok}`);
  }
});

// ── D10 ───────────────────────────────────────────────────────────────────
await runTest("D10: price_per_unit must be positive and delivery_cost non-negative", async () => {
  const zero = await inTx(async (c) => {
    await c.query(`INSERT INTO siton.deals (seller_id, state, title, price_per_unit, min_units, max_units, threshold_units, deadline)
                   VALUES ($1,'Draft','zero',0,2,10,2,now()+interval '1 day')`, [SELLER]);
  });
  assert.match(String(zero), /deals_price_per_unit_positive/);
  const dealId = await seedDraft();
  const negative = await inTx(async (c) => {
    await c.query(`INSERT INTO siton.participants (deal_id, buyer_id, qty, delivery_cost) VALUES ($1,'neg',1,-1)`, [dealId]);
  });
  assert.match(String(negative), /participants_delivery_cost_non_negative/);
  const ok = await inTx(async (c) => {
    await c.query(`INSERT INTO siton.participants (deal_id, buyer_id, qty, delivery_cost) VALUES ($1,'zero-cost',1,0)`, [dealId]);
  });
  assert.equal(ok, null, String(ok));
});

await runTest("D10: seller_id is frozen after publish (a draft may still be reassigned)", async () => {
  const draft = await seedDraft();
  const draftOk = await inTx(async (c) => { await c.query(`UPDATE siton.deals SET seller_id='seller-other' WHERE deal_id=$1`, [draft]); });
  assert.equal(draftOk, null, String(draftOk));
  const published = await seedPublished();
  const err = await inTx(async (c) => { await c.query(`UPDATE siton.deals SET seller_id='seller-other' WHERE deal_id=$1`, [published]); });
  assert.match(String(err), /seller_id is immutable after publish/);
});

await runTest("D10: participant delivery fields are frozen once a charge began", async () => {
  const dealId = await seedPublished();
  const held = await seedParticipant(dealId, "JoinedAuthorized", "AuthHeld");
  const before = await inTx(async (c) => { await c.query(`UPDATE siton.participants SET delivery_cost=20 WHERE participant_id=$1`, [held]); });
  assert.equal(before, null, String(before));
  const charged = await seedParticipant(dealId, "ChargedSuccess", "ChargedSuccess");
  for (const set of ["delivery_cost=0", "delivery_method_type='pickup'", "delivery_option_id=gen_random_uuid()", "delivery_method_label='x'"]) {
    const err = await inTx(async (c) => { await c.query(`UPDATE siton.participants SET ${set} WHERE participant_id=$1`, [charged]); });
    assert.match(String(err), /delivery fields are immutable once a charge began/, set);
  }
  const unrelated = await inTx(async (c) => { await c.query(`UPDATE siton.participants SET public_name_opt_in=true WHERE participant_id=$1`, [charged]); });
  assert.equal(unrelated, null, String(unrelated));
});

// ── D9 ────────────────────────────────────────────────────────────────────
async function seedInvoice(participantId: string, dealId: string, status: string, key = `charge_receipt:${participantId}`) {
  const r = await pool.query(
    `INSERT INTO siton.invoice_documents (document_key, document_type, deal_id, participant_id, gross_amount, document_amount, status, document_status, provider_document_id, issued_at)
     VALUES ($1,'charge_receipt',$2,$3,40,40,$4,$4,$5,$6) RETURNING document_id`,
    [key, dealId, participantId, status, status === "issued" ? `prov-${randomUUID()}` : null, status === "issued" ? new Date().toISOString() : null]
  );
  return String(r.rows[0].document_id);
}

await runTest("D9: an issued invoice document is immutable in amounts and identity; status may still progress", async () => {
  const dealId = await seedPublished();
  const participantId = await seedParticipant(dealId, "ChargedSuccess", "ChargedSuccess");
  const docId = await seedInvoice(participantId, dealId, "issued");
  for (const set of ["gross_amount=1", "document_amount=1", "provider_document_id='forged'", "document_key='x'", "participant_id=gen_random_uuid()", "issued_at=now()-interval '1 day'", "status='pending', document_status='pending'"]) {
    const err = await inTx(async (c) => { await c.query(`UPDATE siton.invoice_documents SET ${set} WHERE document_id=$1`, [docId]); });
    assert.match(String(err), /invoice_document_issued_immutable/, set);
  }
  const progress = await inTx(async (c) => {
    await c.query(`UPDATE siton.invoice_documents SET status='reconciled', document_status='reconciled', reconciled_at=now(), updated_at=now() WHERE document_id=$1`, [docId]);
  });
  assert.equal(progress, null, String(progress));
  const del = await inTx(async (c) => { await c.query(`DELETE FROM siton.invoice_documents WHERE document_id=$1`, [docId]); }, { testActions: "0" });
  assert.match(String(del), /invoice_document_issued_immutable/);
  // negative control: a pending document is still freely updatable
  const other = await seedParticipant(dealId, "ChargedSuccess", "ChargedSuccess");
  const pending = await seedInvoice(other, dealId, "pending");
  const upd = await inTx(async (c) => { await c.query(`UPDATE siton.invoice_documents SET gross_amount=41, attempt_count=attempt_count+1 WHERE document_id=$1`, [pending]); });
  assert.equal(upd, null, String(upd));
});

await runTest("D9: at most one issued receipt per participant and type", async () => {
  const dealId = await seedPublished();
  const participantId = await seedParticipant(dealId, "ChargedSuccess", "ChargedSuccess");
  await seedInvoice(participantId, dealId, "issued");
  const err = await inTx(async (c) => {
    await c.query(
      `INSERT INTO siton.invoice_documents (document_key, document_type, deal_id, participant_id, status, document_status, issued_at)
       VALUES ($1,'charge_receipt',$2,$3,'issued','issued',now())`,
      [`charge_receipt:${participantId}:dup`, dealId, participantId]
    );
  });
  assert.match(String(err), /uq_invoice_documents_issued_receipt_per_participant/);
});

await runTest("D9: payment_attempts and webhook_events identity columns are immutable", async () => {
  const dealId = await seedPublished();
  const participantId = await seedParticipant(dealId, "ChargedSuccess", "ChargedSuccess");
  await seedMoney(dealId, participantId);
  for (const set of ["correlation_id='forged'", "attempt_type='refund'", "participant_id=gen_random_uuid()", "deal_id=gen_random_uuid()", "created_at=now()-interval '31 minutes'"]) {
    const err = await inTx(async (c) => { await c.query(`UPDATE siton.payment_attempts SET ${set} WHERE deal_id=$1`, [dealId]); });
    assert.match(String(err), /payment_attempt_identity_immutable/, set);
  }
  const note = await inTx(async (c) => { await c.query(`UPDATE siton.payment_attempts SET outcome_note='ok' WHERE deal_id=$1`, [dealId]); });
  assert.equal(note, null, String(note));

  const eventId = `bs078-${randomUUID()}`;
  await pool.query(`INSERT INTO siton.webhook_events (provider, event_id, payload_jsonb, status) VALUES ('mockpay',$1,'{}','pending')`, [eventId]);
  const setOnce = await inTx(async (c) => {
    await c.query(`UPDATE siton.webhook_events SET deal_id=$2, participant_id=$3, status='processing' WHERE event_id=$1`, [eventId, dealId, participantId]);
  }, { commit: true });
  assert.equal(setOnce, null, String(setOnce));
  for (const set of ["event_id='forged'", "provider='other'", "received_at=now()-interval '1 day'", "deal_id=gen_random_uuid()", "participant_id=gen_random_uuid()"]) {
    const err = await inTx(async (c) => { await c.query(`UPDATE siton.webhook_events SET ${set} WHERE event_id=$1`, [eventId]); });
    assert.match(String(err), /webhook_event_identity_immutable/, set);
  }
  await pool.query(`DELETE FROM siton.webhook_events WHERE event_id=$1`, [eventId]);
});

// ── D12 ───────────────────────────────────────────────────────────────────
await runTest("D12: the long-standing NOT VALID constraints are validated", async () => {
  const r = await pool.query(`SELECT conrelid::regclass::text AS t, conname FROM pg_constraint WHERE connamespace='siton'::regnamespace AND NOT convalidated ORDER BY 1,2`);
  assert.deepEqual(r.rows, [], "no siton constraint is left NOT VALID on a clean install");
});

// ── D8 ────────────────────────────────────────────────────────────────────
await runTest("D8: readiness fails closed on a disabled enforcement trigger", async () => {
  await assertDatabaseSchema(pool);
  for (const [table, trigger] of [["payment_attempts", "trg_payment_attempts_lifecycle_guard"], ["deals", "trg_deals_before_update_enforce"], ["deals", "trg_deals_before_delete_guard"]]) {
    await pool.query(`ALTER TABLE siton.${table} DISABLE TRIGGER ${trigger}`);
    try {
      await assert.rejects(assertDatabaseSchema(pool), new RegExp(`disabled.*${trigger}`));
    } finally {
      await pool.query(`ALTER TABLE siton.${table} ENABLE TRIGGER ${trigger}`);
    }
  }
  await assertDatabaseSchema(pool);
});

await runTest("D8: readiness fails closed when a runtime role may DELETE/TRUNCATE a money table", async () => {
  await pool.query(`DO $r$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='siton_worker_runtime') THEN CREATE ROLE siton_worker_runtime NOLOGIN NOINHERIT; END IF; END $r$`);
  await assertDatabaseSchema(pool);
  for (const [privilege, table] of [["DELETE", "payment_attempts"], ["TRUNCATE", "audit_log"], ["DELETE", "platform_fee_money_events"]]) {
    await pool.query(`GRANT ${privilege} ON siton.${table} TO siton_worker_runtime`);
    try {
      await assert.rejects(assertDatabaseSchema(pool), new RegExp(`${privilege}.*${table}`));
    } finally {
      await pool.query(`REVOKE ${privilege} ON siton.${table} FROM siton_worker_runtime`);
    }
  }
  await assertDatabaseSchema(pool);
});

await pool.end();
if (failed) {
  console.error(`FAILED ${failed} Black-Sky DB integrity checks`);
  process.exit(1);
}
console.log("PASS Black-Sky DB integrity (migration 078)");
