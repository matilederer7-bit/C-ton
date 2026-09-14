#!/usr/bin/env node
/**
 * INDEPENDENT REVIEW PROOF — migrations 066 / 067 on the CURRENT master ledger.
 *
 * This is the reviewer's own proof, written without reading
 * scripts/r9c_master_migration_proof.cjs, so that the candidate's migration
 * claims are checked by a second, independent implementation.
 *
 * It proves, on DISPOSABLE LOCAL databases only:
 *   1  fresh install of the whole manifest (60 migrations, contiguous positions)
 *   2  a TRUE current-master upgrade: apply only the 58 landed migrations
 *      (through 065), seed realistic legacy production-shaped data including
 *      payment rows in EVERY result_class, then apply the manifest again and
 *      verify that ONLY 066 and 067 are applied, at positions 59 and 60
 *   3  every pre-existing ledger row is untouched (id, position, filename,
 *      checksum, status, completed_at)
 *   4  every pre-existing business and payment row survives with its canonical
 *      values, and the new columns take their documented legacy defaults
 *   5  the legacy fence semantics actually hold in SQL: a legacy status-inferred
 *      capture failure is PERMANENTLY fenced (recovery and release INSERTs are
 *      refused) while a dispatch-response failure is NOT fenced
 *   6  fresh and upgraded schemas are equivalent (columns, defaults, NOT NULL,
 *      constraints, indexes, triggers, function bodies)
 *   7  re-running the manifest is a no-op, and re-executing 066/067 by hand is
 *      idempotent
 *   8  a deliberately tampered historical checksum is REJECTED and the ledger
 *      is left unchanged (no silent repair)
 *   9  067 does not narrow the money-transition function that master's 053
 *      installed (it must be a strict superset)
 *
 * Safety: refuses any non-local DATABASE_URL, creates and drops only its own
 * `siton_revproof_*` databases, and never touches a hosted database.
 */

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { Client } = require("pg");
require("dotenv").config({ quiet: true });

const { runMigrations, checksum } = require("./run_migrations.cjs");
const { MIGRATIONS, MIGRATIONS_DIR } = require("./migration_manifest.cjs");

const LANDED_MASTER_COUNT = 59; // through 066_receipt_trust_content.sql (landed master)
const NEW_MIGRATIONS = ["067", "068"];

const results = [];
let failures = 0;

function check(name, condition, detail) {
  const ok = Boolean(condition);
  if (!ok) failures += 1;
  results.push({ name, ok, detail: detail === undefined ? null : detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

function assertLocal(connectionString) {
  const url = new URL(connectionString);
  const host = url.hostname.toLowerCase();
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error(`refusing to run against non-local host ${host}`);
  }
  return url;
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

async function createDb(adminUrl, name) {
  await withClient(adminUrl, async (c) => {
    await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await c.query(`CREATE DATABASE ${name}`);
  });
}

async function dropDb(adminUrl, name) {
  await withClient(adminUrl, async (c) => {
    await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  }).catch(() => undefined);
}

async function ledgerRows(connectionString) {
  return withClient(connectionString, async (c) => {
    const r = await c.query(
      `SELECT migration_id, position, filename, checksum_sha256, status, completed_at
       FROM siton.migration_ledger ORDER BY position`
    );
    return r.rows;
  });
}

/** Structural fingerprint of the siton schema, independent of row data. */
async function schemaFingerprint(connectionString) {
  return withClient(connectionString, async (c) => {
    const columns = await c.query(
      `SELECT table_name, column_name, data_type, is_nullable, column_default
       FROM information_schema.columns WHERE table_schema='siton'
       ORDER BY table_name, column_name`
    );
    const constraints = await c.query(
      `SELECT conrelid::regclass::text AS rel, conname, contype, pg_get_constraintdef(oid) AS def
       FROM pg_constraint WHERE connamespace='siton'::regnamespace ORDER BY rel, conname`
    );
    const indexes = await c.query(
      `SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname='siton'
       ORDER BY tablename, indexname`
    );
    const triggers = await c.query(
      `SELECT c.relname AS rel, t.tgname, pg_get_triggerdef(t.oid) AS def
       FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='siton' AND NOT t.tgisinternal ORDER BY rel, tgname`
    );
    const functions = await c.query(
      `SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args, md5(p.prosrc) AS body_md5,
              p.prosecdef, p.provolatile
       FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='siton' ORDER BY p.proname, args`
    );
    return {
      columns: columns.rows,
      constraints: constraints.rows,
      indexes: indexes.rows,
      triggers: triggers.rows,
      functions: functions.rows
    };
  });
}

/**
 * Legacy, production-shaped data seeded BEFORE 066/067 exist. Deliberately uses
 * only columns that the landed master schema has, so it is a true "existing
 * rows" fixture rather than a fixture that already knows the new columns.
 */
async function seedLegacyData(connectionString) {
  return withClient(connectionString, async (c) => {
    const dealId = randomUUID();
    await c.query(
      `INSERT INTO siton.deals (deal_id, seller_id, state, title, price_per_unit, min_units, max_units, threshold_units, deadline, published_at, completion_window_until, list_price_per_unit)
       VALUES ($1,'seller-revproof','CompletionWindow','Legacy upgrade fixture',100,1,500,1, now() + interval '1 hour', now() - interval '2 hours', now() + interval '1 hour', 130)`,
      [dealId]
    );

    // One participant per interesting money state, each with the payment rows a
    // real deployment would already have.
    const spec = [
      { key: "charged", buyer_state: "ChargedSuccess", money_state: "ChargedSuccess", attempts: [["charge_start", "success"]] },
      { key: "legacy_inferred_fail", buyer_state: "ChargeFailedCompletion", money_state: "ChargeFailedRecovery", attempts: [["charge_start", "permanent_fail"]] },
      { key: "legacy_unknown", buyer_state: "ChargingAttempt", money_state: "ChargeAttempt", attempts: [["charge_start", "unknown"]] },
      { key: "legacy_temporary", buyer_state: "ChargingAttempt", money_state: "ChargeAttempt", attempts: [["charge_start", "temporary_fail"]] },
      { key: "recovered", buyer_state: "Recovered", money_state: "RecoveredCharge", attempts: [["charge_start", "permanent_fail"], ["recovery", "success"]] },
      { key: "refunded", buyer_state: "DealCompleted", money_state: "Refunded", attempts: [["charge_start", "success"], ["refund", "success"]] },
      { key: "released", buyer_state: "Dropped", money_state: "AuthReleased", attempts: [["release", "success"]] },
      { key: "held", buyer_state: "JoinedAuthorized", money_state: "AuthHeld", attempts: [] }
    ];

    const participants = {};
    for (const p of spec) {
      const participantId = randomUUID();
      participants[p.key] = participantId;
      await c.query(
        `INSERT INTO siton.participants (participant_id, deal_id, buyer_id, qty, buyer_state, money_state, delivery_cost, created_at)
         VALUES ($1,$2,$3,2,$4,$5,15, now() - interval '3 hours')`,
        [participantId, dealId, `buyer-revproof-${p.key}`, p.buyer_state, p.money_state]
      );
      for (const [attemptType, resultClass] of p.attempts) {
        await c.query(
          `INSERT INTO siton.payment_attempts (participant_id, deal_id, attempt_type, result_class, correlation_id, created_at)
           VALUES ($1,$2,$3,$4,$5, now() - interval '2 hours')`,
          [participantId, dealId, attemptType, resultClass, `revproof:${p.key}:${attemptType}`]
        );
      }
    }
    return { dealId, participants };
  });
}

async function dataFingerprint(connectionString) {
  return withClient(connectionString, async (c) => {
    const deals = await c.query(
      `SELECT deal_id, seller_id, state, title, price_per_unit, threshold_units, list_price_per_unit
       FROM siton.deals ORDER BY deal_id`
    );
    const participants = await c.query(
      `SELECT participant_id, deal_id, buyer_id, qty, buyer_state, money_state, delivery_cost
       FROM siton.participants ORDER BY participant_id`
    );
    const attempts = await c.query(
      `SELECT participant_id, attempt_type, result_class, correlation_id, created_at
       FROM siton.payment_attempts ORDER BY correlation_id, attempt_type`
    );
    return { deals: deals.rows, participants: participants.rows, attempts: attempts.rows };
  });
}

function stable(value) {
  return JSON.stringify(value, (_k, v) => (v instanceof Date ? v.toISOString() : v));
}

async function main() {
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error("DATABASE_URL is required");
  assertLocal(base);
  const adminUrl = dbUrl(base, "postgres");

  const stamp = Date.now();
  const freshDb = `siton_revproof_fresh_${stamp}`;
  const upgradeDb = `siton_revproof_upgrade_${stamp}`;
  const tamperDb = `siton_revproof_tamper_${stamp}`;

  console.log(`INDEPENDENT_MIGRATION_PROOF start manifest=${MIGRATIONS.length}`);

  // ── manifest shape ────────────────────────────────────────────────────────
  const positions = MIGRATIONS.map((m) => m.position);
  check("manifest positions are contiguous 1..N", positions.every((p, i) => p === i + 1), `N=${MIGRATIONS.length}`);
  check("manifest has 61 entries (59 landed + 067 + 068)", MIGRATIONS.length === 61, `got ${MIGRATIONS.length}`);
  const m67 = MIGRATIONS.find((m) => m.id === "067");
  const m68 = MIGRATIONS.find((m) => m.id === "068");
  check("067 is at position 60", m67 && m67.position === 60, m67 ? `position ${m67.position}` : "missing");
  check("068 is at position 61", m68 && m68.position === 61, m68 ? `position ${m68.position}` : "missing");
  check(
    "the 59 landed migrations keep their original ids and positions",
    MIGRATIONS.slice(0, LANDED_MASTER_COUNT).every((m, i) => m.position === i + 1) &&
      MIGRATIONS[LANDED_MASTER_COUNT - 1].id === "066",
    `entry 59 = ${MIGRATIONS[LANDED_MASTER_COUNT - 1].id}`
  );
  for (const id of NEW_MIGRATIONS) {
    const entry = MIGRATIONS.find((m) => m.id === id);
    const body = fs.readFileSync(path.join(MIGRATIONS_DIR, entry.filename), "utf8");
    check(`${id} is wrapped in an explicit transaction`, /^BEGIN;/m.test(body) && /^COMMIT;/m.test(body));
    check(`${id} declares no DROP TABLE / DROP COLUMN of existing data`, !/DROP\s+TABLE(?!\s+IF\s+EXISTS\s+siton\.__)/i.test(body) && !/DROP\s+COLUMN/i.test(body));
  }

  try {
    // ── 1. fresh install ────────────────────────────────────────────────────
    await createDb(adminUrl, freshDb);
    const freshUrl = dbUrl(base, freshDb);
    await runMigrations(freshUrl);
    const freshLedger = await ledgerRows(freshUrl);
    check("fresh install applied every manifest migration", freshLedger.length === MIGRATIONS.length, `${freshLedger.length}/${MIGRATIONS.length}`);
    check("fresh install has no failed migration", freshLedger.every((r) => r.status === "succeeded"));
    const freshSchema = await schemaFingerprint(freshUrl);

    // ── 2. true current-master upgrade ──────────────────────────────────────
    await createDb(adminUrl, upgradeDb);
    const upgradeUrl = dbUrl(base, upgradeDb);
    await runMigrations(upgradeUrl, { migrations: MIGRATIONS.slice(0, LANDED_MASTER_COUNT) });
    const landedLedger = await ledgerRows(upgradeUrl);
    check("landed master ledger is the 59 migrations through 066", landedLedger.length === LANDED_MASTER_COUNT && landedLedger[LANDED_MASTER_COUNT - 1].migration_id === "066", `${landedLedger.length} rows, last=${landedLedger[LANDED_MASTER_COUNT - 1]?.migration_id}`);

    const seeded = await seedLegacyData(upgradeUrl);
    const beforeData = await dataFingerprint(upgradeUrl);
    check("legacy fixture seeded", beforeData.participants.length === 8 && beforeData.attempts.length === 9, `${beforeData.participants.length} participants, ${beforeData.attempts.length} attempts`);

    // sanity: the new columns really do not exist yet
    const preCols = await withClient(upgradeUrl, async (c) =>
      (await c.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='siton' AND table_name='payment_attempts'`)).rows.map((r) => r.column_name)
    );
    check("dispatch_state / settlement_horizon_at absent before the upgrade", !preCols.includes("dispatch_state") && !preCols.includes("settlement_horizon_at"), `${preCols.length} columns`);

    await runMigrations(upgradeUrl);
    const upgradedLedger = await ledgerRows(upgradeUrl);
    check("upgrade applied exactly two more migrations", upgradedLedger.length === LANDED_MASTER_COUNT + 2, `${upgradedLedger.length} rows`);
    check("067 landed at position 60 and 068 at position 61", upgradedLedger[59]?.migration_id === "067" && Number(upgradedLedger[59]?.position) === 60 && upgradedLedger[60]?.migration_id === "068" && Number(upgradedLedger[60]?.position) === 61, `${upgradedLedger[59]?.migration_id}@${upgradedLedger[59]?.position}, ${upgradedLedger[60]?.migration_id}@${upgradedLedger[60]?.position}`);

    // ── 3. historical ledger rows are untouched ─────────────────────────────
    const historicalUnchanged = landedLedger.every((before, i) => {
      const after = upgradedLedger[i];
      return after && before.migration_id === after.migration_id && String(before.position) === String(after.position) &&
        before.filename === after.filename && before.checksum_sha256 === after.checksum_sha256 &&
        before.status === after.status && stable(before.completed_at) === stable(after.completed_at);
    });
    check("all 59 historical ledger rows are byte-identical after the upgrade", historicalUnchanged);

    // ── 4. existing rows survive with documented legacy defaults ────────────
    const afterData = await dataFingerprint(upgradeUrl);
    check("deals / participants / payment_attempts rows unchanged by the upgrade", stable(beforeData) === stable(afterData));

    const legacyDefaults = await withClient(upgradeUrl, async (c) =>
      (await c.query(
        `SELECT correlation_id, attempt_type, result_class, dispatch_state, resolved_at IS NOT NULL AS resolved,
                settlement_horizon_at, failure_evidence, negative_finality_authoritative, dispatched_at
         FROM siton.payment_attempts ORDER BY correlation_id`
      )).rows
    );
    check("every legacy row defaults to dispatch_state='responded'", legacyDefaults.every((r) => r.dispatch_state === "responded"), `${legacyDefaults.length} rows`);
    check("terminal legacy rows got resolved_at backfilled", legacyDefaults.filter((r) => ["success", "permanent_fail", "temporary_fail"].includes(r.result_class)).every((r) => r.resolved === true));
    check("unresolved legacy rows keep resolved_at NULL", legacyDefaults.filter((r) => r.result_class === "unknown").every((r) => r.resolved === false));
    check("legacy rows have NULL failure_evidence and NULL authority (unproven)", legacyDefaults.every((r) => r.failure_evidence === null && r.negative_finality_authoritative === null));
    check("legacy rows have no dispatched_at, so 067's 24h backfill affects none of them", legacyDefaults.every((r) => r.dispatched_at === null && r.settlement_horizon_at === null));

    // ── 5. the fence semantics actually hold in SQL ─────────────────────────
    const fence = await withClient(upgradeUrl, async (c) => {
      const inferred = await c.query(
        `SELECT siton.payment_capture_settlement_fence($1,$2) AS fence`,
        [seeded.participants.legacy_inferred_fail, seeded.dealId]
      );
      const charged = await c.query(
        `SELECT siton.payment_capture_settlement_fence($1,$2) AS fence`,
        [seeded.participants.charged, seeded.dealId]
      );
      return { inferred: inferred.rows[0].fence, charged: charged.rows[0].fence };
    });
    check("a legacy status-inferred capture failure is fenced at 'infinity'", fence.inferred instanceof Date ? fence.inferred.getTime() === Infinity || String(fence.inferred) === "Infinity" : String(fence.inferred) === "Infinity", `fence=${String(fence.inferred)}`);
    check("a participant with a successful capture has no capture-failure fence", fence.charged === null, `fence=${String(fence.charged)}`);

    const refusal = await withClient(upgradeUrl, async (c) => {
      const out = {};
      for (const [label, attemptType, participantKey] of [
        ["recovery_on_fenced", "recovery", "legacy_inferred_fail"],
        ["release_on_fenced", "release", "legacy_inferred_fail"],
        ["recovery_on_unknown_capture", "recovery", "legacy_unknown"],
        ["release_on_captured", "release", "charged"],
        ["second_charge_identity_on_unknown", "charge_start", "legacy_unknown"],
        ["second_charge_identity_on_success", "charge_start", "charged"],
        ["charge_after_successful_release", "charge_start", "released"]
      ]) {
        try {
          await c.query("BEGIN");
          await c.query(
            `INSERT INTO siton.payment_attempts (participant_id, deal_id, attempt_type, result_class, correlation_id)
             VALUES ($1,$2,$3,'unknown',$4)`,
            [seeded.participants[participantKey], seeded.dealId, attemptType, `revproof-probe:${label}:${randomUUID().slice(0, 8)}`]
          );
          await c.query("ROLLBACK");
          out[label] = null; // admitted — no refusal
        } catch (error) {
          await c.query("ROLLBACK").catch(() => undefined);
          out[label] = String(error?.message || error).split(":")[0];
        }
      }
      // a dispatch-response failure must NOT be fenced
      await c.query(
        `UPDATE siton.payment_attempts SET failure_evidence='dispatch_response'
         WHERE participant_id=$1 AND attempt_type='charge_start'`,
        [seeded.participants.legacy_inferred_fail]
      );
      try {
        await c.query("BEGIN");
        await c.query(
          `INSERT INTO siton.payment_attempts (participant_id, deal_id, attempt_type, result_class, correlation_id)
           VALUES ($1,$2,'recovery','unknown',$3)`,
          [seeded.participants.legacy_inferred_fail, seeded.dealId, `revproof-probe:recovery_after_evidence:${randomUUID().slice(0, 8)}`]
        );
        await c.query("ROLLBACK");
        out.recovery_after_dispatch_response_evidence = null;
      } catch (error) {
        await c.query("ROLLBACK").catch(() => undefined);
        out.recovery_after_dispatch_response_evidence = String(error?.message || error).split(":")[0];
      }
      return out;
    });

    check("recovery on a legacy fenced failure is refused", refusal.recovery_on_fenced === "money_operation_fenced_negative_finality_unproven", `got ${refusal.recovery_on_fenced}`);
    check("release on a legacy fenced failure is refused", refusal.release_on_fenced === "money_operation_fenced_negative_finality_unproven", `got ${refusal.release_on_fenced}`);
    check("recovery while the original capture is unresolved is refused", refusal.recovery_on_unknown_capture === "recovery_blocked_by_unresolved_capture", `got ${refusal.recovery_on_unknown_capture}`);
    check("release after an executed capture is refused", refusal.release_on_captured === "release_blocked_by_captured_money", `got ${refusal.release_on_captured}`);
    check("a second charge identity while one is unresolved is refused", refusal.second_charge_identity_on_unknown === "payment_attempt_identity_rotation_blocked", `got ${refusal.second_charge_identity_on_unknown}`);
    check("a second charge identity after a successful capture is refused", refusal.second_charge_identity_on_success === "payment_attempt_identity_rotation_blocked", `got ${refusal.second_charge_identity_on_success}`);
    check("a capture after a successful release is refused", String(refusal.charge_after_successful_release || "").startsWith("capture_blocked_by_released_release"), `got ${refusal.charge_after_successful_release}`);
    check("recovery IS admitted once exact dispatch-response evidence exists", refusal.recovery_after_dispatch_response_evidence === null, `got ${refusal.recovery_after_dispatch_response_evidence}`);

    // ── 6. fresh vs upgraded schema equivalence ─────────────────────────────
    const upgradedSchema = await schemaFingerprint(upgradeUrl);
    for (const key of ["columns", "constraints", "indexes", "triggers", "functions"]) {
      const a = stable(freshSchema[key]);
      const b = stable(upgradedSchema[key]);
      let detail = `${freshSchema[key].length} objects`;
      if (a !== b) {
        const fa = new Set(freshSchema[key].map(stable));
        const fb = new Set(upgradedSchema[key].map(stable));
        const onlyFresh = [...fa].filter((x) => !fb.has(x)).slice(0, 3);
        const onlyUpgraded = [...fb].filter((x) => !fa.has(x)).slice(0, 3);
        detail = `only-fresh=${JSON.stringify(onlyFresh)} only-upgraded=${JSON.stringify(onlyUpgraded)}`;
      }
      check(`fresh and upgraded ${key} are equivalent`, a === b, detail);
    }

    // ── 9. 067 must not narrow master's money transitions ───────────────────
    const transitions = [
      ["NoFinancial", "AuthHeld", true], ["AuthHeld", "AuthLocked", true], ["AuthHeld", "AuthReleased", true],
      ["AuthLocked", "ChargeAttempt", true], ["AuthLocked", "AuthReleased", true],
      ["ChargeAttempt", "ChargedSuccess", true], ["ChargeAttempt", "ChargeFailedRecovery", true],
      ["ChargeAttempt", "AuthReleased", true],
      ["ChargeFailedRecovery", "RecoveredCharge", true], ["ChargeFailedRecovery", "AuthReleased", true],
      ["ChargedSuccess", "Refunded", true], ["RecoveredCharge", "Refunded", true],
      ["ChargedSuccess", "AuthReleased", false], ["Refunded", "ChargedSuccess", false],
      ["AuthReleased", "ChargedSuccess", false], ["ChargedSuccess", "ChargeAttempt", false]
    ];
    const transitionResults = await withClient(upgradeUrl, async (c) => {
      const out = [];
      for (const [from, to, expected] of transitions) {
        const r = await c.query(`SELECT siton.is_valid_money_transition($1,$2) AS ok`, [from, to]);
        out.push({ from, to, expected, actual: r.rows[0].ok });
      }
      return out;
    });
    const wrong = transitionResults.filter((r) => r.actual !== r.expected);
    check("067's money-transition table is master's 053 table plus ChargeAttempt->AuthReleased", wrong.length === 0, wrong.length ? JSON.stringify(wrong) : `${transitionResults.length} transitions checked`);

    // ── 7. idempotency ──────────────────────────────────────────────────────
    await runMigrations(upgradeUrl);
    const rerunLedger = await ledgerRows(upgradeUrl);
    check("re-running the manifest is a no-op", stable(rerunLedger) === stable(upgradedLedger));
    const afterRerunData = await dataFingerprint(upgradeUrl);
    check("re-running the manifest changes no business data", stable(afterRerunData) === stable(afterData));

    for (const id of NEW_MIGRATIONS) {
      const entry = MIGRATIONS.find((m) => m.id === id);
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, entry.filename), "utf8").replace(/^﻿/, "");
      let ok = true;
      let message = "";
      try {
        await withClient(upgradeUrl, async (c) => { await c.query(sql); });
      } catch (error) {
        ok = false;
        message = String(error?.message || error);
      }
      check(`${id} can be re-executed directly against an already-migrated database`, ok, message);
    }
    const afterDirectReexec = await dataFingerprint(upgradeUrl);
    check("direct re-execution of 066/067 changes no business data", stable(afterDirectReexec) === stable(afterData));

    // ── 8. tampered historical checksum is rejected ─────────────────────────
    await createDb(adminUrl, tamperDb);
    const tamperUrl = dbUrl(base, tamperDb);
    await runMigrations(tamperUrl, { migrations: MIGRATIONS.slice(0, LANDED_MASTER_COUNT) });
    await withClient(tamperUrl, async (c) => {
      await c.query(`UPDATE siton.migration_ledger SET checksum_sha256=repeat('0',64) WHERE migration_id='053'`);
    });
    const tamperBefore = await ledgerRows(tamperUrl);
    let rejected = false;
    let rejectionMessage = "";
    try {
      await runMigrations(tamperUrl);
    } catch (error) {
      rejected = true;
      rejectionMessage = String(error?.message || error);
    }
    check("a tampered historical checksum is rejected", rejected && /checksum mismatch/i.test(rejectionMessage), rejectionMessage.slice(0, 120));
    const tamperAfter = await ledgerRows(tamperUrl);
    check("the rejected run leaves the ledger unchanged (no silent repair)", stable(tamperBefore) === stable(tamperAfter));
    check("the rejected run did not apply 066/067", !tamperAfter.some((r) => NEW_MIGRATIONS.includes(r.migration_id)));

    // committed SQL bytes must equal what the manifest checksums
    for (const id of NEW_MIGRATIONS) {
      const entry = MIGRATIONS.find((m) => m.id === id);
      const body = fs.readFileSync(path.join(MIGRATIONS_DIR, entry.filename), "utf8").replace(/^﻿/, "");
      const ledgerRow = upgradedLedger.find((r) => r.migration_id === id);
      check(`${id} ledger checksum equals the on-disk SQL bytes`, ledgerRow && ledgerRow.checksum_sha256 === checksum(body));
    }
  } finally {
    await dropDb(adminUrl, freshDb);
    await dropDb(adminUrl, upgradeDb);
    await dropDb(adminUrl, tamperDb);
  }

  const outDir = path.join(process.cwd(), ".review-artifacts");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, "migration-independent-proof.json"),
    JSON.stringify({ generated_at: new Date().toISOString(), manifest: MIGRATIONS.length, failures, results }, null, 2)
  );

  console.log(`\nINDEPENDENT_MIGRATION_PROOF ${failures === 0 ? "PASS" : "FAIL"} checks=${results.length} failures=${failures}`);
  if (failures) process.exit(1);
}

main().catch((error) => {
  console.error(`INDEPENDENT_MIGRATION_PROOF_ERROR ${error?.message || error}`);
  process.exit(1);
});
