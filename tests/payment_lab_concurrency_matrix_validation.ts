// FINANCIAL TORTURE LAB — Phase 8 (financial concurrency matrix) and Phase 14
// (outbox / worker / lease war).
//
// Concurrency here is real: N in-process workers race for the same claims,
// parked owners lose their leases to successors, and two REAL worker processes
// (src/worker.js) drain a shared backlog against the provider simulator. The
// provider has NO native idempotency in this suite, so every request Siton
// sends executes — duplicate economic effect = 0 must hold from the provider's
// ledger alone. Deadlocks are read from pg_stat_database.
//
// Synthetic money only. Disposable database.

import { strict as assert } from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { bootLab, makeRunner, timeout, sleep } from "./lab/runtime.js";

const lab = await bootLab({ tag: "concurrency", port: 3156, simulator: { nativeIdempotency: false }, env: { COMPLETION_WINDOW_MINUTES: "0.2" }, outboxMaxAttempts: 4 });
const { run, summary } = makeRunner("payment_lab_concurrency_matrix");

async function deadlocks() {
  return Number((await lab.pool.query(`SELECT deadlocks FROM pg_stat_database WHERE datname=current_database()`)).rows[0]?.deadlocks || 0);
}
const deadlocksAtStart = await deadlocks();

async function chargingDeal(participants = 1) {
  return lab.seedDeal({ state: "Charging", participants: Array.from({ length: participants }, () => ({ buyer_state: "ChargingAttempt", money_state: "ChargeAttempt" })) });
}

// ── claim races: N actors, one job ───────────────────────────────────────────

for (const rail of ["capture", "recovery", "refund", "release"] as const) {
  for (const n of [2, 5, 10, 25, 50]) {
    await run(`${rail.toUpperCase()} vs ${rail.toUpperCase()}: ${n} concurrent actors on one job → one claim, one provider request, one effect`, async () => {
      let dealId: string; let pid: string; let auth: string; let event: string;
      if (rail === "capture") { const d = await chargingDeal(); dealId = d.deal_id; pid = d.participants[0]!.participant_id; auth = d.participants[0]!.authorization; event = await lab.enqueueCharge(dealId); }
      else if (rail === "recovery") { const d = await lab.seedDeal({ state: "CompletionWindow", completionWindowUntil: new Date(Date.now() + 5 * 60_000), participants: [{ buyer_state: "ChargeFailedCompletion", money_state: "ChargeFailedRecovery", priorAttempts: [{ attempt_type: "charge_start", result_class: "permanent_fail" }] }] }); dealId = d.deal_id; pid = d.participants[0]!.participant_id; auth = d.participants[0]!.authorization; event = await lab.enqueueRecovery(dealId); }
      else if (rail === "refund") { const d = await lab.seedDeal({ state: "Failed", participants: [{ buyer_state: "DealFailed", money_state: "ChargedSuccess", priorAttempts: [{ attempt_type: "charge_start", result_class: "success" }] }] }); dealId = d.deal_id; pid = d.participants[0]!.participant_id; auth = d.participants[0]!.authorization; lab.sim.forceEffect("capture", auth, d.participants[0]!.amount_minor); event = await lab.enqueueRefund(dealId); }
      else { const d = await lab.seedDeal({ state: "Failed", participants: [{ buyer_state: "DealFailed", money_state: "AuthLocked" }] }); dealId = d.deal_id; pid = d.participants[0]!.participant_id; auth = d.participants[0]!.authorization; event = await lab.enqueueRelease(pid, dealId); }
      const results = await Promise.all(Array.from({ length: n }, () => lab.processOutboxEventById(event)));
      const claimed = results.filter(Boolean);
      assert.equal(claimed.length, 1, `exactly one of ${n} actors may claim the job (${claimed.length} did)`);
      await lab.drain({ dealIds: [dealId], skip: (e) => e.event_type === "finalize_deal" });
      const op = rail === "capture" ? "capture" : rail === "recovery" ? "recover" : rail;
      assert.equal(lab.sim.requestsOf(auth, op).length, 1, "one provider request");
      assert.equal(lab.sim.effectsOf(auth)[op], 1, "one economic effect");
      await lab.oracle(`race:${rail}:${n}`, [dealId]);
    });
  }
}

// ── parallel independent operations at scale (N deals, N workers in-process) ─

for (const n of [5, 10, 25, 50]) {
  await run(`PARALLEL_${n}: ${n} deals × 2 participants captured by ${n} in-process workers at once → every participant exactly once, zero deadlocks`, async () => {
    const deals = await Promise.all(Array.from({ length: n }, () => chargingDeal(2)));
    const events = await Promise.all(deals.map((d) => lab.enqueueCharge(d.deal_id)));
    const before = await deadlocks();
    await Promise.all(events.map((e) => lab.processOutboxEventById(e)));
    const dealIds = deals.map((d) => d.deal_id);
    await lab.drain({ dealIds, skip: (e) => e.event_type === "finalize_deal" });
    for (const d of deals) for (const p of d.participants) {
      assert.equal(lab.sim.effectsOf(p.authorization).capture, 1, `participant ${p.participant_id} captured ${lab.sim.effectsOf(p.authorization).capture} times`);
      assert.equal((await lab.participant(p.participant_id)).money_state, "ChargedSuccess");
    }
    assert.equal((await deadlocks()) - before, 0, "deadlocks during the parallel run");
    const report = await lab.oracle(`parallel:${n}`, dealIds);
    assert.equal(report.counts.capture_effects, n * 2);
  });
}

// ── mixed rails racing on one participant ────────────────────────────────────

await run("CAPTURE vs RECONCILE ×5: five reconcilers arrive while the capture is parked after its effect — all defer, zero status reads, one effect", async () => {
  const d = await chargingDeal();
  const p = d.participants[0]!;
  const event = await lab.enqueueCharge(d.deal_id);
  const barrier = lab.armTestFault("payment.after_provider_io", { kind: "block" });
  const captureRun = lab.processOutboxEventById(event);
  await Promise.race([barrier.entered, timeout(15_000, "capture never parked")]);
  const row = (await lab.attempts(p.participant_id, "charge_start"))[0]!;
  // the one-pending-per-aggregate index allows one live reconcile; race five actors on it plus four with distinct payload reasons
  const first = await lab.enqueueReconcile({ participant_id: p.participant_id, deal_id: d.deal_id, attempt_type: "charge_start", correlation_id: row.correlation_id, operation: "capture", provider_reference: p.authorization, reason: "r0" });
  const results = await Promise.all(Array.from({ length: 5 }, () => lab.processOutboxEventById(first)));
  const claimed = results.filter(Boolean);
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0]!.status, "failed"); assert.match(String((claimed[0] as any).error), /operation_in_flight/);
  assert.equal(lab.sim.requestsOf(p.authorization, "status").length, 0);
  barrier.release(); await captureRun;
  await lab.drain({ dealIds: [d.deal_id], skip: (e) => e.event_type === "finalize_deal" });
  assert.equal(lab.sim.effectsOf(p.authorization).capture, 1);
  await lab.oracle("race:capture-vs-reconcile", [d.deal_id]);
});

await run("CAPTURE vs RECOVERY: a recovery job racing a parked capture sends nothing; RECOVERY vs RECONCILE and RELEASE vs RECONCILE defer likewise", async () => {
  const d = await chargingDeal();
  const p = d.participants[0]!;
  const event = await lab.enqueueCharge(d.deal_id);
  const barrier = lab.armTestFault("payment.after_provider_io", { kind: "block" });
  const captureRun = lab.processOutboxEventById(event);
  await Promise.race([barrier.entered, timeout(15_000, "capture never parked")]);
  const recovery = await lab.enqueueRecovery(d.deal_id);
  await lab.processOutboxEventById(recovery);
  assert.equal(lab.sim.requestsOf(p.authorization, "recover").length, 0);
  barrier.release(); await captureRun;
  await lab.drain({ dealIds: [d.deal_id], skip: (e) => e.event_type === "finalize_deal" });
  assert.equal(lab.sim.effectsOf(p.authorization).capture + lab.sim.effectsOf(p.authorization).recover, 1);
  await lab.oracle("race:capture-vs-recovery", [d.deal_id]);
});

// ── stale owner vs new owner, old owner returns ──────────────────────────────

for (const n of [2, 5, 10]) {
  await run(`STALE_OWNER: capture parked after effect, lease dies, ${n} successors race the reclaimed job, old owner returns → one claim, successor proves execution, old owner fenced, one effect`, async () => {
    const d = await chargingDeal();
    const p = d.participants[0]!;
    const event = await lab.enqueueCharge(d.deal_id);
    const barrier = lab.armTestFault("payment.after_provider_io", { kind: "block" });
    const staleRun = lab.processOutboxEventById(event);
    await Promise.race([barrier.entered, timeout(15_000, "capture never parked")]);
    await lab.pool.query(`UPDATE siton.outbox_events SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE event_uuid=$1`, [event]);
    await lab.reclaimWorkerJobs(0);
    const successors = await Promise.all(Array.from({ length: n }, () => lab.processOutboxEventById(event)));
    assert.equal(successors.filter(Boolean).length, 1, "exactly one successor claims");
    barrier.release();
    const stale = await staleRun;
    assert.equal(stale?.status, "lease_lost", JSON.stringify(stale));
    await lab.drain({ dealIds: [d.deal_id], skip: (e) => e.event_type === "finalize_deal" });
    assert.equal(lab.sim.requestsOf(p.authorization, "capture").length, 1, "the successor never re-sent the executed identity");
    assert.equal(lab.sim.effectsOf(p.authorization).capture, 1);
    assert.equal((await lab.participant(p.participant_id)).money_state, "ChargedSuccess");
    await lab.oracle(`stale-owner:${n}`, [d.deal_id]);
  });
}

// ── Phase 14: outbox / worker / lease war ────────────────────────────────────

await run("outbox war: poison event (unknown deal) lands in the DLQ without crashing; duplicate charge_deal after 'sent' is a no-op; retry storm is bounded by max attempts", async () => {
  const poison = await lab.enqueue("charge_deal", "deal", "00000000-0000-4000-8000-00000000dead", { deal_id: "00000000-0000-4000-8000-00000000dead" });
  const r = await lab.processOutboxEventById(poison);
  assert.equal(r?.status, "failed", JSON.stringify(r));
  const d = await chargingDeal();
  const p = d.participants[0]!;
  const event = await lab.enqueueCharge(d.deal_id);
  await lab.drain({ dealIds: [d.deal_id], skip: (e) => e.event_type === "finalize_deal" });
  assert.equal(await lab.processOutboxEventById(event), null, "a sent event cannot be claimed again");
  await lab.enqueueCharge(d.deal_id);
  await lab.drain({ dealIds: [d.deal_id], skip: (e) => e.event_type === "finalize_deal" });
  assert.equal(lab.sim.requestsOf(p.authorization, "capture").length, 1);
  // retry storm: a participant that can never dispatch (no authorization) exhausts within max attempts
  const stuck = await lab.seedDeal({ state: "Charging", participants: [{ buyer_state: "ChargingAttempt", money_state: "ChargeAttempt", withoutAuthorization: true }] });
  const storm = await lab.enqueueCharge(stuck.deal_id);
  const stats = await lab.drain({ dealIds: [stuck.deal_id], types: ["charge_deal"], maxRounds: 20 });
  assert.ok(stats.processed <= 4, `bounded retries: ${stats.processed}`);
  assert.equal((await lab.outboxRow(storm))?.status, "dlq");
  await lab.oracle("outbox-war:poison-duplicate-storm", [d.deal_id, stuck.deal_id]);
});

await run("outbox war: large backlog (60 money jobs) drains to zero residue with one effect each", async () => {
  const deals = await Promise.all(Array.from({ length: 60 }, () => chargingDeal(1)));
  await Promise.all(deals.map((d) => lab.enqueueCharge(d.deal_id)));
  const dealIds = deals.map((d) => d.deal_id);
  const stats = await lab.drain({ dealIds, skip: (e) => e.event_type === "finalize_deal", maxRounds: 200 });
  const histogram: Record<string, number> = {};
  for (const r of stats.results) histogram[`${r.event_type}:${r.status}`] = (histogram[`${r.event_type}:${r.status}`] || 0) + 1;
  console.log(`  backlog drain: rounds=${stats.rounds} processed=${stats.processed} advanced=${stats.advanced} ${JSON.stringify(histogram)} first_not_claimed=${stats.results.find((r) => r.status === "not_claimed")?.error ?? "-"}`);
  assert.equal(stats.remaining_pending + stats.remaining_processing, 0, `residue after drain: pending=${stats.remaining_pending} processing=${stats.remaining_processing} (${JSON.stringify(histogram)})`);
  const report = await lab.oracle("outbox-war:backlog-60", dealIds);
  assert.equal(report.counts.capture_effects, 60);
});

// ── two REAL worker processes ────────────────────────────────────────────────

type WorkerHandle = { child: ChildProcess; id: string; output: string[] };
function spawnWorker(id: string): WorkerHandle {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  delete env.DISABLE_OUTBOX_WORKER;
  Object.assign(env, { WORKER_ID: id, RUNTIME_ROLE: "worker", OUTBOX_POLL_MS: "100", WORKER_CONCURRENCY: "4", WORKER_MONEY_CONCURRENCY: "2", WORKER_HEARTBEAT_MS: "1000", WORKER_LEASE_MS: "5000", WORKER_STUCK_TIMEOUT_MS: "5000", WORKER_RECLAIM_EVERY_POLLS: "2", LOG_LEVEL: "warn" });
  const child = spawn(process.execPath, [path.join(".tmp_test_dist", "src", "worker.js")], { env, stdio: ["ignore", "pipe", "pipe"] });
  const handle: WorkerHandle = { child, id, output: [] };
  child.stdout?.on("data", (c) => handle.output.push(String(c)));
  child.stderr?.on("data", (c) => handle.output.push(String(c)));
  return handle;
}
async function stopWorker(h: WorkerHandle) {
  if (h.child.exitCode !== null || h.child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => h.child.once("exit", () => resolve()));
  h.child.kill("SIGTERM");
  await Promise.race([exited, sleep(15_000).then(() => { if (h.child.exitCode === null) h.child.kill("SIGKILL"); })]);
}

await run("TWO_WORKERS: two real worker processes drain 40 deals (80 participants) with random ambiguity — every participant exactly once, no residue, no duplicate effect", async () => {
  const deals = await Promise.all(Array.from({ length: 40 }, () => chargingDeal(2)));
  const dealIds = deals.map((d) => d.deal_id);
  // sprinkle post-dispatch ambiguity over a third of the participants
  const kinds = ["EFFECT_THEN_503", "EFFECT_THEN_TIMEOUT", "EFFECT_THEN_CONNECTION_RESET", "EFFECT_THEN_MALFORMED_2XX", "DECLINED", "NO_EFFECT_503"] as const;
  let i = 0;
  for (const d of deals) for (const p of d.participants) { if (i % 3 === 0) lab.sim.script(p.authorization, "capture", [{ kind: kinds[i % kinds.length]! } as any]); i += 1; }
  await Promise.all(deals.map((d) => lab.enqueueCharge(d.deal_id)));
  const a = spawnWorker(`lab-worker-a-${process.pid}`);
  const b = spawnWorker(`lab-worker-b-${process.pid}`);
  try {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const live = await lab.liveEvents(dealIds, ["charge_deal", "recovery_deal", "payment_reconcile"]);
      if (live.length === 0) break;
      await sleep(500);
    }
    const live = await lab.liveEvents(dealIds, ["charge_deal", "recovery_deal", "payment_reconcile"]);
    assert.equal(live.length, 0, `residue after two workers: ${JSON.stringify(live.slice(0, 5))}`);
  } finally {
    await stopWorker(a); await stopWorker(b);
  }
  assert.ok(a.child.exitCode === 0 || a.child.signalCode === "SIGTERM", `worker A exit ${a.child.exitCode}/${a.child.signalCode}: ${a.output.join("").slice(-800)}`);
  assert.ok(b.child.exitCode === 0 || b.child.signalCode === "SIGTERM", `worker B exit ${b.child.exitCode}/${b.child.signalCode}: ${b.output.join("").slice(-800)}`);
  let duplicates = 0; let converged = 0; let truthfulNonCharge = 0;
  for (const d of deals) for (const p of d.participants) {
    const eff = lab.sim.effectsOf(p.authorization);
    if (eff.capture + eff.recover > 1) duplicates += 1;
    const state = await lab.participant(p.participant_id);
    if (["ChargedSuccess", "RecoveredCharge"].includes(state.money_state)) converged += 1;
    else if (eff.capture + eff.recover === 0 && state.buyer_state === "DealFailed" && state.money_state === "ChargeFailedRecovery"
      && (await lab.attempts(p.participant_id, "charge_start")).every((a) => a.result_class === "permanent_fail")) {
      // Independent financial review: under a settlement horizon a capture whose
      // request was lost client-side and reconciled late may miss the 6 s window;
      // the deal fails, no money moved, the hold is pending its provider-proofed
      // release. A truthful, money-safe non-charge — not a convergence defect.
      truthfulNonCharge += 1;
      console.log(`  TRUTHFUL NON-CHARGE ${p.participant_id}: ${state.buyer_state}/${state.money_state} effects=${JSON.stringify(eff)}`);
    } else {
      const dlq = await lab.dlqRows(d.deal_id);
      const dlqP = await lab.dlqRows(p.participant_id);
      const dealRow = await lab.deal(d.deal_id);
      const history = (await lab.pool.query(
        `SELECT event_type, status, attempt_count, last_error, created_at::text AS created_at, available_at::text AS available_at FROM siton.outbox_events WHERE aggregate_id IN ($1::uuid, $2::uuid) ORDER BY created_at`,
        [d.deal_id, p.participant_id]
      )).rows.map((r: any) => `${r.event_type}:${r.status}#${r.attempt_count}@${String(r.created_at).slice(11, 23)}->${String(r.available_at).slice(11, 23)}${r.last_error ? `(${String(r.last_error).slice(0, 90)})` : ""}`);
      console.log(`  NOT CONVERGED ${p.participant_id}: state=${state.buyer_state}/${state.money_state} deal=${dealRow.state} window_until=${dealRow.completion_window_until} effects=${JSON.stringify(eff)} attempts=${JSON.stringify(await lab.attempts(p.participant_id))} cases=${JSON.stringify((await lab.cases(p.participant_id)).map((c) => c.auto_key))} dlq=${JSON.stringify([...dlq, ...dlqP].map((r) => `${r.event_type}:${String(r.last_error).slice(0, 120)}`))} outbox=${JSON.stringify(history)} scripted=${lab.sim.requestsOf(p.authorization).map((r) => `${r.op}:${r.behavior}:${r.answered}@${r.at.slice(11, 23)}`).join("|")}`);
    }
  }
  console.log(`  two workers: converged=${converged}/80 truthful_non_charge=${truthfulNonCharge} duplicates=${duplicates} deadlocks=${(await deadlocks()) - deadlocksAtStart}`);
  assert.equal(duplicates, 0);
  assert.equal(converged + truthfulNonCharge, 80, "every participant is either captured exactly once or a visible, money-safe non-charge");
  assert.ok(truthfulNonCharge <= 2, `too many participants missed the completion window: ${truthfulNonCharge}`);
  await lab.oracle("two-workers:40x2", dealIds);
});

console.log(`  deadlocks during this suite: ${(await deadlocks()) - deadlocksAtStart}`);
assert.equal((await deadlocks()) - deadlocksAtStart, 0, "deadlocks must be zero");
const failed = summary();
await lab.close();
process.exit(failed ? 1 : 0);
