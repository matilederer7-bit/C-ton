#!/usr/bin/env node
/**
 * INDEPENDENT REVIEW — DB-level dispatch/lease fencing proof.
 *
 * The review must not accept process-local locking as sufficient. This script
 * therefore ignores the application entirely and drives raw SQL against a
 * disposable database that has migrations 066 and 067 applied, asserting that
 * the DATABASE itself refuses every unsafe write:
 *
 *   F-1  a foreign writer may not declare a NEGATIVE outcome on an operation
 *        that is dispatching under a live lease
 *   F-2  a foreign writer may not RE-ARM such an operation (steal the dispatch)
 *   F-3  a foreign writer may not DISARM it back to 'recorded'
 *   F-4  SR-1: no other foreign write at all is admitted while in flight
 *   F-5  provider SUCCESS from any writer IS admitted (money truth is monotonic
 *        and must never be lost) — recorded as the deliberate exception
 *   F-6  the DISPATCHING OWNER may settle a negative outcome
 *   F-7  terminal truth never downgrades (success -> anything else,
 *        permanent_fail -> unknown)
 *   F-8  permanent_fail MAY still become success (late provider truth wins)
 *   F-9  once the lease is DEAD the operation is no longer in flight, and a
 *        successor may settle it
 *   F-10 the settlement horizon is monotonic (a shortening write is clamped)
 *   F-11 exact-request failure evidence is never downgraded to an inference
 *   F-12 a recorded negative-finality authority is never raised to true
 *
 * Safety: local disposable database only; created and dropped by this script.
 */

const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");
require("dotenv").config({ quiet: true });
const { runMigrations } = require("./run_migrations.cjs");

const results = [];
let failures = 0;

function check(name, ok, detail) {
  if (!ok) failures += 1;
  results.push({ name, ok: Boolean(ok), detail: detail ?? null });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

function dbUrl(base, name) {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
}

async function withClient(connectionString, fn) {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Run one statement in its own transaction and report the SQLSTATE/message. */
async function probe(c, sql, params, opts = {}) {
  try {
    await c.query("BEGIN");
    if (opts.owner) await c.query(`SELECT set_config('siton.payment_dispatch_owner', $1, true)`, [opts.owner]);
    const r = await c.query(sql, params);
    if (opts.commit) await c.query("COMMIT");
    else await c.query("ROLLBACK");
    return { ok: true, rowCount: r.rowCount, rows: r.rows };
  } catch (error) {
    await c.query("ROLLBACK").catch(() => undefined);
    return { ok: false, code: String(error?.code || ""), message: String(error?.message || error).split(":")[0] };
  }
}

async function main() {
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error("DATABASE_URL is required");
  const host = new URL(base).hostname.toLowerCase();
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) throw new Error(`refusing non-local host ${host}`);

  const dbName = `siton_revfence_${Date.now()}`;
  const adminUrl = dbUrl(base, "postgres");
  await withClient(adminUrl, async (c) => {
    await c.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await c.query(`CREATE DATABASE ${dbName}`);
  });
  const url = dbUrl(base, dbName);

  try {
    await runMigrations(url);

    await withClient(url, async (c) => {
      // ── fixture: a deal, a participant, an outbox job holding a LIVE lease,
      // and one capture identity armed as dispatching under that job.
      const dealId = randomUUID();
      const participantId = randomUUID();
      const ownerEvent = randomUUID();
      const ownerGeneration = 3;
      const correlation = "charge_start:revfence:n1";

      await c.query(
        `INSERT INTO siton.deals (deal_id, seller_id, state, title, price_per_unit, min_units, max_units, threshold_units, deadline, published_at, completion_window_until)
         VALUES ($1,'seller-revfence','Charging','DB fencing proof',100,1,500,1, now() + interval '1 hour', now() - interval '1 hour', now() + interval '1 hour')`,
        [dealId]
      );
      await c.query(
        `INSERT INTO siton.participants (participant_id, deal_id, buyer_id, qty, buyer_state, money_state, delivery_cost)
         VALUES ($1,$2,'buyer-revfence',2,'ChargingAttempt','ChargeAttempt',0)`,
        [participantId, dealId]
      );
      // A SECOND participant carries the negative-direction fixtures: once the
      // first participant's capture is settled success, migration 066 rightly
      // refuses to mint a release for it at all (release_blocked_by_captured_money).
      const otherParticipantId = randomUUID();
      await c.query(
        `INSERT INTO siton.participants (participant_id, deal_id, buyer_id, qty, buyer_state, money_state, delivery_cost)
         VALUES ($1,$2,'buyer-revfence-2',1,'ChargeFailedCompletion','ChargeFailedRecovery',0)`,
        [otherParticipantId, dealId]
      );
      await c.query(
        `INSERT INTO siton.outbox_events (event_uuid, event_type, aggregate_type, aggregate_id, payload, status, attempt_count, lease_generation, worker_id, lease_expires_at, available_at, claimed_at, processing_started_at, last_heartbeat_at)
         VALUES ($1,'charge_deal','deal',$2,'{}','processing',1,$3,'worker-revfence', clock_timestamp() + interval '5 minutes', now(), clock_timestamp(), clock_timestamp(), clock_timestamp())`,
        [ownerEvent, dealId, ownerGeneration]
      );
      await c.query(
        `INSERT INTO siton.payment_attempts (participant_id, deal_id, attempt_type, result_class, correlation_id, dispatch_state, owner_event_uuid, owner_lease_generation, dispatched_at, settlement_horizon_at, negative_finality_authoritative, failure_evidence)
         VALUES ($1,$2,'charge_start','unknown',$3,'dispatching',$4,$5, clock_timestamp(), clock_timestamp() + interval '10 minutes', true, NULL)`,
        [participantId, dealId, correlation, ownerEvent, ownerGeneration]
      );

      const inFlight = await c.query(
        `SELECT siton.payment_operation_in_flight($1,$2) AS live`,
        [ownerEvent, ownerGeneration]
      );
      check("fixture: the operation is IN FLIGHT under a live lease", inFlight.rows[0].live === true);

      const owner = `${ownerEvent}:${ownerGeneration}`;
      const foreign = `${randomUUID()}:1`;
      const where = `WHERE participant_id=$1 AND deal_id=$2 AND attempt_type='charge_start' AND correlation_id=$3`;
      const args = [participantId, dealId, correlation];

      // ── F-1 foreign negative settle ────────────────────────────────────────
      const f1 = await probe(c, `UPDATE siton.payment_attempts SET result_class='permanent_fail' ${where}`, args, { owner: foreign });
      check("F-1 a foreign writer may not declare a negative outcome in flight", !f1.ok && f1.code === "SN409" && f1.message.includes("payment_attempt_in_flight_negative_settle"), f1.ok ? "ADMITTED" : `${f1.code} ${f1.message}`);
      const f1b = await probe(c, `UPDATE siton.payment_attempts SET result_class='temporary_fail' ${where}`, args, {});
      check("F-1b the same refusal applies with no owner declared at all", !f1b.ok && f1b.code === "SN409", f1b.ok ? "ADMITTED" : `${f1b.code} ${f1b.message}`);

      // ── F-2 foreign re-arm (dispatch theft) ────────────────────────────────
      const f2 = await probe(c, `UPDATE siton.payment_attempts SET owner_event_uuid=$4, owner_lease_generation=9 ${where}`, [...args, randomUUID()], { owner: foreign });
      check("F-2 a foreign writer may not steal the dispatch of an in-flight operation", !f2.ok && f2.code === "SN409" && f2.message.includes("payment_attempt_dispatch_in_flight"), f2.ok ? "ADMITTED" : `${f2.code} ${f2.message}`);

      // ── F-3 foreign disarm ─────────────────────────────────────────────────
      const f3 = await probe(c, `UPDATE siton.payment_attempts SET dispatch_state='recorded' ${where}`, args, { owner: foreign });
      check("F-3 a foreign writer may not disarm an in-flight operation", !f3.ok && f3.code === "SN409" && f3.message.includes("payment_attempt_in_flight_disarm"), f3.ok ? "ADMITTED" : `${f3.code} ${f3.message}`);

      // ── F-4 SR-1: any other foreign write ──────────────────────────────────
      const f4 = await probe(c, `UPDATE siton.payment_attempts SET dispatch_state='responded', outcome_note='stale worker' ${where}`, args, { owner: foreign });
      check("F-4 SR-1: no other foreign write is admitted while in flight", !f4.ok && f4.code === "SN409" && f4.message.includes("payment_attempt_in_flight_foreign_write"), f4.ok ? "ADMITTED" : `${f4.code} ${f4.message}`);
      const f4b = await probe(c, `UPDATE siton.payment_attempts SET provider_reference='stolen-reference' ${where}`, args, { owner: foreign });
      check("F-4b a foreign writer may not even rewrite the provider reference in flight", !f4b.ok && f4b.code === "SN409", f4b.ok ? "ADMITTED" : `${f4b.code} ${f4b.message}`);

      // ── F-5 provider SUCCESS from any writer is admitted (deliberate) ──────
      const f5 = await probe(c, `UPDATE siton.payment_attempts SET result_class='success' ${where}`, args, { owner: foreign });
      check("F-5 provider SUCCESS is admitted from any writer (money truth is never lost)", f5.ok && f5.rowCount === 1, f5.ok ? "admitted as designed" : `${f5.code} ${f5.message}`);

      // ── F-6 the dispatching owner may settle a negative outcome ────────────
      const f6 = await probe(c, `UPDATE siton.payment_attempts SET result_class='permanent_fail', failure_evidence='dispatch_response' ${where}`, args, { owner });
      check("F-6 the dispatching owner may settle a negative outcome", f6.ok && f6.rowCount === 1, f6.ok ? "settled" : `${f6.code} ${f6.message}`);

      // ── F-7 / F-8 monotonic terminal truth ─────────────────────────────────
      await c.query(`UPDATE siton.payment_attempts SET result_class='success' ${where}`, args);
      const f7 = await probe(c, `UPDATE siton.payment_attempts SET result_class='unknown' ${where}`, args, { owner });
      check("F-7 a success identity may never leave success", !f7.ok && f7.code === "SN409" && f7.message.includes("payment_attempt_terminal_downgrade"), f7.ok ? "ADMITTED" : `${f7.code} ${f7.message}`);
      const f7b = await probe(c, `UPDATE siton.payment_attempts SET result_class='permanent_fail' ${where}`, args, { owner });
      check("F-7b a success identity may never become permanent_fail", !f7b.ok && f7b.code === "SN409", f7b.ok ? "ADMITTED" : `${f7b.code} ${f7b.message}`);

      // a second identity, resolved permanent_fail, for the negative-direction rules
      const secondCorrelation = "release:revfence:n1";
      await c.query(
        `INSERT INTO siton.payment_attempts (participant_id, deal_id, attempt_type, result_class, correlation_id, dispatch_state, dispatched_at, settlement_horizon_at, negative_finality_authoritative, failure_evidence)
         VALUES ($1,$2,'release','permanent_fail',$3,'responded', clock_timestamp() - interval '1 minute', clock_timestamp() + interval '10 minutes', false, 'dispatch_response')`,
        [otherParticipantId, dealId, secondCorrelation]
      );
      const where2 = `WHERE participant_id=$1 AND deal_id=$2 AND attempt_type='release' AND correlation_id=$3`;
      const args2 = [otherParticipantId, dealId, secondCorrelation];
      const f7c = await probe(c, `UPDATE siton.payment_attempts SET result_class='unknown' ${where2}`, args2, {});
      check("F-7c a permanent_fail identity may never become unknown again", !f7c.ok && f7c.code === "SN409", f7c.ok ? "ADMITTED" : `${f7c.code} ${f7c.message}`);
      const f8 = await probe(c, `UPDATE siton.payment_attempts SET result_class='success' ${where2}`, args2, {});
      check("F-8 a permanent_fail identity MAY still become success (late provider truth)", f8.ok && f8.rowCount === 1, f8.ok ? "admitted" : `${f8.code} ${f8.message}`);

      // ── F-10 monotonic settlement horizon ──────────────────────────────────
      const before = await c.query(`SELECT settlement_horizon_at FROM siton.payment_attempts ${where2}`, args2);
      const shortened = await probe(c, `UPDATE siton.payment_attempts SET settlement_horizon_at = clock_timestamp() - interval '1 hour' ${where2} RETURNING settlement_horizon_at`, args2, { commit: true });
      const after = await c.query(`SELECT settlement_horizon_at FROM siton.payment_attempts ${where2}`, args2);
      check(
        "F-10 the settlement horizon can never be shortened or cleared",
        shortened.ok && new Date(after.rows[0].settlement_horizon_at).getTime() === new Date(before.rows[0].settlement_horizon_at).getTime(),
        `before=${before.rows[0].settlement_horizon_at} after=${after.rows[0].settlement_horizon_at}`
      );
      const clearedProbe = await probe(c, `UPDATE siton.payment_attempts SET settlement_horizon_at = NULL ${where2}`, args2, { commit: true });
      const afterClear = await c.query(`SELECT settlement_horizon_at FROM siton.payment_attempts ${where2}`, args2);
      check("F-10b clearing the horizon to NULL is clamped back", clearedProbe.ok && afterClear.rows[0].settlement_horizon_at !== null);

      // ── F-11 failure evidence never downgraded ─────────────────────────────
      await probe(c, `UPDATE siton.payment_attempts SET failure_evidence='status_inference' ${where2}`, args2, { commit: true });
      const evidenceAfter = await c.query(`SELECT failure_evidence FROM siton.payment_attempts ${where2}`, args2);
      check("F-11 exact-request failure evidence is never downgraded to an inference", evidenceAfter.rows[0].failure_evidence === "dispatch_response", `evidence=${evidenceAfter.rows[0].failure_evidence}`);

      // ── F-12 recorded authority never raised ───────────────────────────────
      await probe(c, `UPDATE siton.payment_attempts SET negative_finality_authoritative=true ${where2}`, args2, { commit: true });
      const authorityAfter = await c.query(`SELECT negative_finality_authoritative FROM siton.payment_attempts ${where2}`, args2);
      check("F-12 a recorded negative-finality authority is never raised to true", authorityAfter.rows[0].negative_finality_authoritative === false, `authority=${authorityAfter.rows[0].negative_finality_authoritative}`);

      // ── F-9 a DEAD lease ends the in-flight fence ──────────────────────────
      const deadEvent = randomUUID();
      const deadGeneration = 2;
      const deadCorrelation = "refund:revfence:n1";
      await c.query(
        `INSERT INTO siton.outbox_events (event_uuid, event_type, aggregate_type, aggregate_id, payload, status, attempt_count, lease_generation, worker_id, lease_expires_at, available_at, claimed_at, processing_started_at, last_heartbeat_at)
         VALUES ($1,'refund_issue','deal',$2,'{}','processing',1,$3,'worker-revfence-dead', clock_timestamp() - interval '1 minute', now(), clock_timestamp() - interval '2 minutes', clock_timestamp() - interval '2 minutes', clock_timestamp() - interval '2 minutes')`,
        [deadEvent, dealId, deadGeneration]
      );
      await c.query(
        `INSERT INTO siton.payment_attempts (participant_id, deal_id, attempt_type, result_class, correlation_id, dispatch_state, owner_event_uuid, owner_lease_generation, dispatched_at)
         VALUES ($1,$2,'refund','unknown',$3,'dispatching',$4,$5, clock_timestamp() - interval '1 minute')`,
        [otherParticipantId, dealId, deadCorrelation, deadEvent, deadGeneration]
      );
      const deadLive = await c.query(`SELECT siton.payment_operation_in_flight($1,$2) AS live`, [deadEvent, deadGeneration]);
      check("F-9 an expired lease means the operation is NOT in flight", deadLive.rows[0].live === false);
      const where3 = `WHERE participant_id=$1 AND deal_id=$2 AND attempt_type='refund' AND correlation_id=$3`;
      const f9 = await probe(c, `UPDATE siton.payment_attempts SET result_class='permanent_fail', failure_evidence='status_inference' ${where3}`, [otherParticipantId, dealId, deadCorrelation], { owner: foreign });
      check("F-9b a successor may settle an operation whose owner lease died", f9.ok && f9.rowCount === 1, f9.ok ? "settled" : `${f9.code} ${f9.message}`);

      // ── the in-flight predicate is generation-sensitive ────────────────────
      const wrongGeneration = await c.query(`SELECT siton.payment_operation_in_flight($1,$2) AS live`, [ownerEvent, ownerGeneration + 1]);
      check("the in-flight predicate is lease-generation sensitive", wrongGeneration.rows[0].live === false);
      const nullOwner = await c.query(`SELECT siton.payment_operation_in_flight(NULL,NULL) AS live`);
      check("a row with no owner is never in flight", nullOwner.rows[0].live === false);
    });
  } finally {
    await withClient(adminUrl, async (c) => {
      await c.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    }).catch(() => undefined);
  }

  const outDir = path.join(process.cwd(), ".review-artifacts");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "db-fencing-proof.json"), JSON.stringify({ generated_at: new Date().toISOString(), failures, results }, null, 2));
  console.log(`\nREVIEW_DB_FENCING_PROOF ${failures === 0 ? "PASS" : "FAIL"} checks=${results.length} failures=${failures}`);
  if (failures) process.exit(1);
}

main().catch((error) => {
  console.error(`REVIEW_DB_FENCING_PROOF_ERROR ${error?.message || error}`);
  process.exit(1);
});
