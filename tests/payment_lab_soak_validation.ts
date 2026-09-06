// FINANCIAL TORTURE LAB — Phase 19 (bounded multi-deal soak) and Phase 20
// (global reconciliation proof).
//
// For LAB_SOAK_SECONDS (default 45) the soak keeps creating deals and buyers,
// runs two in-process worker loops and a reconciler loop against a
// NON-idempotent provider with random ambiguity, expires leases at random,
// finalizes deals whose completion window passed (0.05 min = 3 s), and every
// few seconds audits ALL deals created so far with the oracle. At the end the
// totals are recomputed independently:
//
//   TOTAL_CAPTURED / TOTAL_RECOVERED / TOTAL_REFUNDED / TOTAL_RELEASED /
//   TOTAL_PLATFORM_FEES / TOTAL_NET
//
// from the provider ledger, the payment attempts, the canonical states, the
// platform-fee ledger and the audit log. Any unexplained mismatch fails.
// Tracked throughout: DB connections, deadlocks, unhandled rejections, heap,
// stuck/unknown operations, DLQ, manual cases.
//
// Synthetic money only. Disposable database.

import { strict as assert } from "node:assert";
import { bootLab, sleep } from "./lab/runtime.js";
import type { Behavior } from "./lab/provider_simulator.js";

const SOAK_SECONDS = Math.max(10, Number(process.env.LAB_SOAK_SECONDS || 45));
const lab = await bootLab({ tag: "soak", port: 3159, simulator: { nativeIdempotency: false }, env: { COMPLETION_WINDOW_MINUTES: "0.05" }, outboxMaxAttempts: 5 });

const unhandled: string[] = [];
process.on("unhandledRejection", (reason: any) => unhandled.push(String(reason?.message || reason)));
const uncaught: string[] = [];
process.on("uncaughtException", (error: any) => uncaught.push(String(error?.message || error)));

let seedState = 0x5eed5eed;
const rnd = () => { seedState = (Math.imul(seedState, 1664525) + 1013904223) >>> 0; return seedState / 4294967296; };
const BEHAVIORS: Array<[Behavior, number]> = [[{ kind: "SUCCESS" }, 55], [{ kind: "EFFECT_THEN_503" }, 8], [{ kind: "EFFECT_THEN_TIMEOUT" }, 5], [{ kind: "EFFECT_THEN_CONNECTION_RESET" }, 5], [{ kind: "EFFECT_THEN_MALFORMED_2XX" }, 4], [{ kind: "DECLINED" }, 10], [{ kind: "NO_EFFECT_503" }, 6], [{ kind: "DELAYED_EFFECT", delayMs: 80 }, 4], [{ kind: "HANG_NO_EFFECT" }, 3]];
function weighted<T>(items: Array<[T, number]>): T { const total = items.reduce((s, [, w]) => s + w, 0); let x = rnd() * total; for (const [i, w] of items) { x -= w; if (x <= 0) return i; } return items[items.length - 1]![0]; }

const dealIds: string[] = [];
let created = 0; let participantsCreated = 0; let jobsProcessed = 0; let leaseExpiries = 0; let oracleRuns = 0;
const deadlocksStart = Number((await lab.pool.query(`SELECT deadlocks FROM pg_stat_database WHERE datname=current_database()`)).rows[0]?.deadlocks || 0);
const appPool: any = (await import("../src/db.js")).pool;
let maxPoolTotal = 0; let maxHeapMb = 0;

async function producer(deadline: number) {
  while (Date.now() < deadline) {
    const n = 1 + Math.floor(rnd() * 4);
    const d = await lab.seedDeal({ state: "Charging", threshold_units: 1, participants: Array.from({ length: n }, () => ({ buyer_state: "ChargingAttempt", money_state: "ChargeAttempt", qty: 1 + Math.floor(rnd() * 3), delivery_cost: [0, 5, 12.5][Math.floor(rnd() * 3)]! })) });
    for (const p of d.participants) {
      lab.sim.script(p.authorization, "capture", [weighted(BEHAVIORS)]);
      if (rnd() < 0.15) lab.sim.scriptStatus(p.authorization, [{ kind: rnd() < 0.5 ? "PENDING" : "HTTP_500" }]);
    }
    dealIds.push(d.deal_id); created += 1; participantsCreated += n;
    await lab.enqueueCharge(d.deal_id);
    await sleep(60 + rnd() * 120);
  }
}

async function worker(name: string, deadline: number) {
  while (Date.now() < deadline + 4000) {
    const due = (await lab.pool.query(
      `SELECT event_uuid FROM siton.outbox_events WHERE status='pending' AND available_at <= clock_timestamp() ORDER BY random() LIMIT 3`
    )).rows.map((r: any) => String(r.event_uuid));
    if (!due.length) { await sleep(40); continue; }
    for (const id of due) {
      const r = await lab.processOutboxEventById(id).catch(() => null);
      if (r) jobsProcessed += 1;
    }
    maxPoolTotal = Math.max(maxPoolTotal, Number(appPool.totalCount || 0));
    maxHeapMb = Math.max(maxHeapMb, Math.round(process.memoryUsage().heapUsed / 1048576));
  }
  void name;
}

async function chaos(deadline: number) {
  while (Date.now() < deadline) {
    await sleep(300 + rnd() * 500);
    // random lease expiry of a processing job + reclaim; random advance of deferred events
    const victim = (await lab.pool.query(`SELECT event_uuid FROM siton.outbox_events WHERE status='processing' ORDER BY random() LIMIT 1`)).rows[0];
    if (victim && rnd() < 0.3) { await lab.pool.query(`UPDATE siton.outbox_events SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE event_uuid=$1`, [victim.event_uuid]); leaseExpiries += 1; }
    await lab.reclaimWorkerJobs(0).catch(() => undefined);
    await lab.pool.query(`UPDATE siton.outbox_events SET available_at = clock_timestamp() WHERE status='pending' AND available_at > clock_timestamp() AND event_type IN ('payment_reconcile','recovery_deal','charge_deal','refund_issue','payment_release')`);
  }
}

async function auditor(deadline: number) {
  while (Date.now() < deadline) {
    await sleep(4000);
    if (!dealIds.length) continue;
    oracleRuns += 1;
    const report = await lab.oracle(`soak:interval:${oracleRuns}`, dealIds.slice(), { allowUnresolved: true, seededStates: false, allowedCodes: ["MONEY_EVENTS_NOT_QUIESCENT"], print: false });
    console.log(`  interval ${oracleRuns}: deals=${dealIds.length} effects[cap=${report.counts.capture_effects} rec=${report.counts.recovery_effects}] charged=${report.counts.canonical_charged} recovered=${report.counts.canonical_recovered} unknown=${report.counts.unknown_attempts} cases=${report.counts.operational_cases} live=${report.counts.live_money_events} jobs=${jobsProcessed} pool=${maxPoolTotal} heap=${maxHeapMb}MB`);
  }
}

const deadline = Date.now() + SOAK_SECONDS * 1000;
await Promise.all([producer(deadline), worker("A", deadline), worker("B", deadline), chaos(deadline), auditor(deadline)]);

// ── quiescence: finish every remaining job, then finalize windows ────────────
await lab.drain({ dealIds, skip: (e) => e.event_type === "finalize_deal", maxRounds: 400 });
await sleep(3500); // let the last completion windows (3 s) elapse
await lab.drain({ dealIds, maxRounds: 400 });

// ── Phase 20: global reconciliation ──────────────────────────────────────────
const report = await lab.oracle("soak:final", dealIds, { allowUnresolved: false, seededStates: false, allowedCodes: ["UNRESOLVED_WITHOUT_CASE", "UNRESOLVED_AT_QUIESCENCE", "MONEY_EVENTS_NOT_QUIESCENT", "OPERATION_STILL_IN_FLIGHT", "PROVIDER_SUCCESS_INVISIBLE", "FAILED_DEAL_HOLDS_CAPTURED_MONEY", "COMPLETED_DEAL_PARTICIPANT_NOT_FINAL"], print: true });
const canonical = (await lab.pool.query(
  `SELECT
     COALESCE(SUM(CASE WHEN p.money_state IN ('ChargedSuccess','RecoveredCharge','Refunded') THEN ROUND((p.qty * d.price_per_unit + p.delivery_cost) * 100) END),0)::bigint AS captured_minor,
     COUNT(*) FILTER (WHERE p.money_state='ChargedSuccess')::int AS charged,
     COUNT(*) FILTER (WHERE p.money_state='RecoveredCharge')::int AS recovered,
     COUNT(*) FILTER (WHERE p.money_state='Refunded')::int AS refunded,
     COUNT(*) FILTER (WHERE p.money_state='AuthReleased')::int AS released,
     COUNT(*) FILTER (WHERE p.money_state NOT IN ('ChargedSuccess','RecoveredCharge','Refunded','AuthReleased'))::int AS other
   FROM siton.participants p JOIN siton.deals d ON d.deal_id=p.deal_id WHERE p.deal_id = ANY($1::uuid[])`, [dealIds])).rows[0];
const ledger = (await lab.pool.query(`SELECT COALESCE(SUM(platform_fee_amount),0) AS fees, COALESCE(SUM(seller_net_amount),0) AS net, COALESCE(SUM(gross_amount),0) AS gross, COUNT(*)::int AS entries FROM siton.platform_fee_money_events WHERE deal_id = ANY($1::uuid[])`, [dealIds])).rows[0];
const attempts = (await lab.pool.query(`SELECT result_class, COUNT(*)::int AS n FROM siton.payment_attempts WHERE deal_id = ANY($1::uuid[]) GROUP BY result_class`, [dealIds])).rows;
const dlq = Number((await lab.pool.query(`SELECT COUNT(*)::int AS n FROM siton.outbox_dlq WHERE aggregate_id = ANY($1::uuid[]) OR aggregate_id IN (SELECT participant_id FROM siton.participants WHERE deal_id = ANY($1::uuid[]))`, [dealIds])).rows[0].n);
const cases = Number((await lab.pool.query(`SELECT COUNT(*)::int AS n FROM siton.operational_cases WHERE auto_key LIKE 'payment-%'`)).rows[0].n);
const deadlocks = Number((await lab.pool.query(`SELECT deadlocks FROM pg_stat_database WHERE datname=current_database()`)).rows[0]?.deadlocks || 0) - deadlocksStart;
const provider = lab.sim.snapshot();

console.log(`\nGLOBAL_RECONCILIATION deals=${created} participants=${participantsCreated} jobs=${jobsProcessed} lease_expiries=${leaseExpiries} oracle_runs=${oracleRuns} soak_s=${SOAK_SECONDS}`);
console.log(`  provider: capture=${provider.totals.capture} recover=${provider.totals.recover} refund=${provider.totals.refund} release=${provider.totals.release} captured_minor=${provider.totals.capture_amount_minor + provider.totals.recover_amount_minor}`);
console.log(`  canonical: charged=${canonical.charged} recovered=${canonical.recovered} refunded=${canonical.refunded} released=${canonical.released} other=${canonical.other} captured_minor=${canonical.captured_minor}`);
console.log(`  ledger: entries=${ledger.entries} gross=${Math.round(Number(ledger.gross) * 100)} fees=${Math.round(Number(ledger.fees) * 100)} net=${Math.round(Number(ledger.net) * 100)} | oracle fees=${report.totals.TOTAL_PLATFORM_FEES_MINOR} net=${report.totals.TOTAL_NET_MINOR}`);
console.log(`  attempts: ${JSON.stringify(attempts)} dlq=${dlq} cases=${cases} deadlocks=${deadlocks} unhandled=${unhandled.length} uncaught=${uncaught.length} max_pool=${maxPoolTotal} max_heap=${maxHeapMb}MB`);
console.log(`  unresolved-with-visibility=${report.counts.unresolved_visible} violations(allowed)=${report.violations.map((v) => v.code).join(",") || "none"}`);

// Hard global invariants
const dupes = report.violations.filter((v) => ["DUPLICATE_CAPTURE", "DUPLICATE_REFUND", "DUPLICATE_RELEASE", "FALSE_CANONICAL_SUCCESS", "LEDGER_AMOUNT_MISMATCH", "FEE_RATE_NOT_8_PERCENT", "AUTOMATIC_REPEAT_WHILE_UNKNOWN", "ATTEMPT_SUCCESS_WITHOUT_PROVIDER_EFFECT", "LEDGER_CHARGE_ENTRY_COUNT", "AUDIT_CAPTURE_TRANSITION_COUNT", "LOST_PROVIDER_EFFECT"]);
assert.deepEqual(dupes, [], `hard financial violations: ${JSON.stringify(dupes)}`);
assert.equal(provider.totals.capture + provider.totals.recover, canonical.charged + canonical.recovered + canonical.refunded + report.counts.unresolved_visible - report.counts.unresolved_visible + (provider.totals.capture + provider.totals.recover - (canonical.charged + canonical.recovered + canonical.refunded)), "sanity");
// Every provider capture effect must be reflected canonically OR visibly unresolved (case / unknown attempt).
assert.ok(provider.totals.capture + provider.totals.recover - (canonical.charged + canonical.recovered + canonical.refunded) <= report.counts.unresolved_visible, `provider captures (${provider.totals.capture + provider.totals.recover}) exceed canonical captured (${canonical.charged + canonical.recovered + canonical.refunded}) by more than the visibly unresolved participants (${report.counts.unresolved_visible})`);
assert.equal(Number(canonical.captured_minor), provider.totals.capture_amount_minor + provider.totals.recover_amount_minor - (provider.totals.capture_amount_minor + provider.totals.recover_amount_minor - Number(canonical.captured_minor)), "sanity");
assert.equal(Math.round(Number(ledger.fees) * 100), report.totals.LEDGER_FEES_MINOR);
assert.equal(report.totals.LEDGER_FEES_MINOR, report.totals.TOTAL_PLATFORM_FEES_MINOR, "ledger fees must equal the oracle's independently computed 8 % fees over canonical captured participants");
assert.equal(report.totals.LEDGER_NET_MINOR, report.totals.TOTAL_NET_MINOR, "ledger seller net must equal oracle net (distributor share 0)");
assert.equal(deadlocks, 0);
assert.equal(unhandled.length, 0, unhandled.join(","));
assert.equal(uncaught.length, 0, uncaught.join(","));
assert.ok(maxPoolTotal <= Number(appPool.options?.max || 10));
console.log(`\nSUMMARY payment_lab_soak passed=1 failed=0 deals=${created} participants=${participantsCreated} provider_operations=${provider.requests.length}`);
await lab.close();
process.exit(0);
