// Test-fixture state forcing that satisfies the DB's PER-ROW audit/outbox
// enforcement (migration 076, red-team C-1).
//
// Before 076 a fixture could forge the transaction-global flags
// (siton.audit_written / siton.outbox_written = '1') and UPDATE a deal or
// participant state directly with no audit row at all. The DB now requires an
// audit_log row for THIS row and THIS transition (and, for the outbox-required
// deal actions, an outbox row for THIS deal) written in the same transaction —
// exactly what the runtime writes. Fixtures therefore model reality: every
// forced step writes its audit row first, then the state UPDATE.
//
// Usage inside an open transaction (client = pg client with BEGIN already run):
//   await forcedDealStep(client, dealId, "TargetReached", "deal.target_reached");
//   await forcedParticipantStep(client, pid, { buyer_state: "LockedIn" }, "test.fixture");
// Or let the helper own the transaction:
//   await withForcedTx(pool, async (client) => { ... });

type Queryable = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

// Action → the outbox job the DB requires for it (migration 076 checks the
// event type, not just "some row for this deal").
const OUTBOX_REQUIRED_DEAL_ACTIONS = new Map<string, string>([
  ["deal.publish", "deadline_check"],
  ["charging.start", "charge_deal"],
  ["charging.to_completion_window", "finalize_deal"],
  ["charging.finalize_failed", "refund_issue"],
  ["deal.cancel", "cancel_refund"]
]);

let fixtureSeq = 0;
function fixtureRequestId(prefix: string) {
  fixtureSeq += 1;
  return `${prefix}:${Date.now()}:${fixtureSeq}:${Math.random().toString(16).slice(2, 10)}`;
}

export async function armForcedTxFlags(client: Queryable, actionName: string) {
  await client.query(`SELECT set_config('siton.in_atomic', 'true', true)`);
  await client.query(`SELECT set_config('app.in_atomic', 'true', true)`);
  await client.query(`SELECT set_config('siton.action_name', $1, true)`, [actionName]);
  await client.query(`SELECT set_config('siton.audit_written', '1', true)`);
  await client.query(`SELECT set_config('siton.outbox_written', '1', true)`);
}

/**
 * One audited deal state step. Reads the current state under the row lock,
 * writes the matching audit row (+ an already-sent outbox row when the action
 * requires one), then performs the UPDATE. `extraSet` may add non-state
 * columns to the same UPDATE (e.g. completion_window_until); `$1`..`$3` are
 * reserved (deal id, to-state, from-state), so extra params start at `$4`.
 */
export async function forcedDealStep(
  client: Queryable,
  dealId: string,
  toState: string,
  actionName: string,
  options: { extraSet?: string; extraParams?: unknown[]; idempotencyKey?: string } = {}
) {
  await client.query(`SELECT set_config('siton.action_name', $1, true)`, [actionName]);
  const current = await client.query(`SELECT state FROM siton.deals WHERE deal_id=$1 FOR UPDATE`, [dealId]);
  const fromState = String(current.rows[0]?.state || "");
  if (!fromState) throw new Error(`forcedDealStep: deal ${dealId} not found`);
  if (fromState === toState) return;
  const requestId = fixtureRequestId("fixture");
  await client.query(
    `INSERT INTO siton.audit_log
       (entity_type, entity_id, deal_id, state_type, from_state, to_state, action_name, request_id, correlation_id, idempotency_key, payload)
     VALUES ('deal',$1,$1,'deal_state',$2,$3,$4,$5,$5,$6,'{"fixture":true}'::jsonb)`,
    [dealId, fromState, toState, actionName, requestId, options.idempotencyKey || `fixture:${dealId}:${toState}:${requestId}`]
  );
  const requiredEventType = OUTBOX_REQUIRED_DEAL_ACTIONS.get(actionName);
  if (requiredEventType) {
    // The DB requires a RUNNABLE (pending, unsent) job of the required type
    // for THIS deal, inserted in this transaction. Fixtures schedule it far
    // in the future so the outbox worker never picks it up.
    await client.query(
      `INSERT INTO siton.outbox_events
         (event_type, aggregate_type, aggregate_id, payload, status, attempt_count, available_at)
       VALUES ($3,'deal',$1,$2,'pending',0,now() + interval '100 years')`,
      [dealId, JSON.stringify({ deal_id: dealId, fixture: true, action: actionName }), requiredEventType]
    );
  }
  await client.query(`SELECT set_config('siton.audit_written', '1', true)`);
  await client.query(`SELECT set_config('siton.outbox_written', '1', true)`);
  const extra = options.extraSet ? `, ${options.extraSet}` : "";
  await client.query(
    `UPDATE siton.deals SET state=$2${extra} WHERE deal_id=$1 AND state=$3`,
    [dealId, toState, fromState, ...(options.extraParams || [])]
  );
}

/** Walk a deal through an ordered list of (state, action) steps. */
export async function forcedDealPath(
  client: Queryable,
  dealId: string,
  path: Array<{ to: string; action: string }>,
  options: { skipUntilCurrent?: boolean } = {}
) {
  let steps = path;
  if (options.skipUntilCurrent) {
    const current = await client.query(`SELECT state FROM siton.deals WHERE deal_id=$1`, [dealId]);
    const idx = path.findIndex((s) => s.to === String(current.rows[0]?.state || ""));
    if (idx >= 0) steps = path.slice(idx + 1);
  }
  for (const step of steps) await forcedDealStep(client, dealId, step.to, step.action);
}

/**
 * One audited participant step. Either or both of buyer_state / money_state
 * may change; each changed column gets its own audit row (the per-row trigger
 * checks each column separately).
 */
export async function forcedParticipantStep(
  client: Queryable,
  participantId: string,
  target: { buyer_state?: string; money_state?: string },
  actionName: string
) {
  await client.query(`SELECT set_config('siton.action_name', $1, true)`, [actionName]);
  const current = await client.query(
    `SELECT deal_id, buyer_state, money_state FROM siton.participants WHERE participant_id=$1 FOR UPDATE`,
    [participantId]
  );
  const row = current.rows[0];
  if (!row) throw new Error(`forcedParticipantStep: participant ${participantId} not found`);
  const requestId = fixtureRequestId("fixture");
  const sets: string[] = [];
  const params: unknown[] = [participantId];
  const audit = async (stateType: "buyer_state" | "money_state", from: string, to: string) => {
    await client.query(
      `INSERT INTO siton.audit_log
         (entity_type, entity_id, deal_id, state_type, from_state, to_state, action_name, request_id, correlation_id, idempotency_key, payload)
       VALUES ('participant',$1,$2,$3,$4,$5,$6,$7,$7,$8,'{"fixture":true}'::jsonb)`,
      [participantId, row.deal_id, stateType, from, to, actionName, requestId, `fixture:${participantId}:${stateType}:${to}:${requestId}`]
    );
  };
  if (target.buyer_state && target.buyer_state !== String(row.buyer_state)) {
    await audit("buyer_state", String(row.buyer_state), target.buyer_state);
    params.push(target.buyer_state);
    sets.push(`buyer_state=$${params.length}`);
  }
  if (target.money_state && target.money_state !== String(row.money_state)) {
    await audit("money_state", String(row.money_state), target.money_state);
    params.push(target.money_state);
    sets.push(`money_state=$${params.length}`);
  }
  if (!sets.length) return;
  await client.query(`SELECT set_config('siton.audit_written', '1', true)`);
  await client.query(`UPDATE siton.participants SET ${sets.join(", ")} WHERE participant_id=$1`, params);
}

/** Run `fn` inside BEGIN/COMMIT with the forced-transaction flags armed. */
export async function withForcedTx<T>(pool: { connect: () => Promise<any> }, actionName: string, fn: (client: any) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await armForcedTxFlags(client, actionName);
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
