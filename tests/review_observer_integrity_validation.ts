// R9C ROUND 7 — OBSERVER INTEGRITY: the Siton-side observer must not lie.
//
// Codex's round-6 re-review (2026-09-13) confirmed the transport-hold blocker
// closed and found three P1 defects in the PROOF observer itself
// (tests/lab/siton_observer.ts): (A) query ids restarted with the process
// (`WORKER_ID:q1` twice → a held answer borrowed an older receipt), (B) a
// verdict was reported for a statement that matched no row, was rolled back,
// or named a NOTE parameter as an identity, and (C) the receipt of a status
// answer was stamped when the bytes arrived, not when the app had parsed them.
//
// This suite is the observer's independent proof, against the OBSERVER
// CONTRACT written at the top of siton_observer.ts. Every control drives the
// real simulator, real observer incarnations (installed / uninstalled like a
// process restart, or REAL child processes), real localhost transport hops,
// and — for verdicts — the real PostgreSQL schema of a disposable lab database
// with the PRODUCTION statement texts taken verbatim from
// src/payment_attempt_helpers.ts. No production source is exercised for money;
// synthetic money only; no observation is injected by hand (the round-6
// causal suite's recordVerdict helper is deliberately NOT used here).
//
//   O1  restart: two REAL successive processes with the same WORKER_ID mint distinct query ids
//   O2  simultaneous workers (even two with the same label) mint distinct ids
//   O3  concurrent queries of one incarnation: distinct ids, receipts bound 1:1, each after its answer was written
//   O4  an answer to a query of a DEAD incarnation (restart while held) binds nothing
//   O5  0-row UPDATE (tx and autocommit) records no verdict
//   O6  ROLLBACK / ROLLBACK TO SAVEPOINT after the write records no verdict (RELEASE keeps it)
//   O7  COMMIT of an aborted transaction (command ROLLBACK) and a REJECTED COMMIT record no verdict
//   O8  a committed production write records exactly ONE verdict — staged during the tx, published only at COMMIT,
//       class = the durable class (CASE shape read back: an already-success row never becomes a permanent_fail verdict)
//   O9  a note parameter (another live identity) is never an identity — production shape and Codex's shape
//   O10 text() succeeds, JSON.parse fails (MALFORMED) → no receipt; json() rejects → no receipt
//   O11 the answer does not echo THIS query id (rewritten / stripped by the hop) → no receipt
//   O12 a valid parse → exactly one receipt, positioned after the provider wrote the answer
//   O13 the same body parsed twice / an identical replayed answer → no second observation
//   O14 Codex's restart + held-transport chronology through an HONEST hop with REAL committed verdicts → REJECT;
//       the waited twin → ACCEPT; the rejected evidence never names the older query
//   O15 oracle: a query id shared by two provider requests binds no receipt (synthetic, Codex's control)
//   O16 oracle: a receipt positioned before its query reached the provider binds nothing (synthetic)
//   O17 static conformance: every production statement that assigns result_class is either bound by the
//       observer's exact-shape classifier or a non-terminal write; nothing is unrecognised
//
// Mutants OM-A..OM-J in scripts/review_mutation_proof.cjs re-introduce each
// defect (or remove each guard) and must be killed by THIS suite.

import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import http from "node:http";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { httpObserver, installSitonObserver, classifyPaymentAttemptWrite, isUnboundTerminalWrite, QUERY_ID_HEADER, type ObserverHandle } from "./lab/siton_observer.js";
import { auditDispatchLegality } from "./lab/dispatch_legality.js";
import type { ObservationRecord, ProviderRequestRecord } from "./lab/provider_simulator.js";

// ── child mode: a REAL worker process with the observer preloaded (O1 / O2) ──
if (process.argv[2] === "child") {
  const [, , , base, label, auth] = process.argv;
  const handle = installSitonObserver({ providerBaseUrl: base!, process: label!, observe: httpObserver(base!) });
  try {
    const res = await fetch(`${base}/status/${auth}?operation=capture`);
    const text = await res.text();                                          // production reads text() …
    JSON.parse(text);                                                       // … then parses
    await handle.drain();
  } finally {
    handle.uninstall();
  }
  await new Promise((r) => setTimeout(r, 700));                             // Windows/libuv teardown drain (uv_async close race under process.exit)
  process.exit(0);
}

const { bootLab, makeRunner } = await import("./lab/runtime.js");

const HORIZON_MS = 1500;
const lab = await bootLab({ tag: "r7-observer", port: 3252, clientTimeoutMs: 4000, env: { PAYMENT_SETTLEMENT_HORIZON_MS: String(HORIZON_MS) } });
const { run, summary } = makeRunner("review_observer_integrity");
const sim = lab.sim;
const simBase = String(process.env.PAYMENT_PROVIDER_BASE_URL);
const SELF = process.argv[1]!;

// ── observer incarnations: the lab installed one at boot (process "lab", simulator base) ──
const labArgs = { providerBaseUrl: simBase, observe: (e: any) => sim.observe(e), process: "lab" };
let current: ObserverHandle = installSitonObserver(labArgs);                 // the singleton already installed by bootLab
/** restart: the current incarnation dies, a new one is installed (same label, like a restarted worker) */
function restart(base: string, label: string): ObserverHandle {
  current.uninstall();
  current = installSitonObserver({ providerBaseUrl: base, observe: (e: any) => sim.observe(e), process: label });
  return current;
}

// ── a localhost transport hop between Siton and the provider ─────────────────
type Hop = { base: string; hold: (on: boolean) => void; release: () => void; heldCount: () => number; close: () => Promise<void> };
function startHop(opts: { forwardEcho: boolean; rewriteEcho?: (echo: string | null) => string | null } = { forwardEcho: true }): Promise<Hop> {
  let holding = false;
  let held = 0;
  let gate: Promise<void> = Promise.resolve();
  let open: () => void = () => {};
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    try {
      const init: RequestInit = { method: req.method || "GET", headers: req.headers as any };
      if (chunks.length) init.body = Buffer.concat(chunks);
      const upstream = await fetch(`${simBase}${req.url}`, init);
      const body = await upstream.text();                                   // the provider has WRITTEN its answer
      if (holding && String(req.url).startsWith("/status/")) { held += 1; await gate; }   // … the hop holds it
      res.statusCode = upstream.status;
      res.setHeader("content-type", "application/json");
      const echo = upstream.headers.get(QUERY_ID_HEADER);
      const forwarded = opts.rewriteEcho ? opts.rewriteEcho(echo) : opts.forwardEcho ? echo : null;
      if (forwarded) res.setHeader(QUERY_ID_HEADER, forwarded);
      res.end(body);
    } catch (error) {
      res.statusCode = 502; res.end(String(error));
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({
      base: `http://127.0.0.1:${(server.address() as any).port}`,
      hold(on) { holding = on; if (on) gate = new Promise<void>((r) => { open = r; }); },
      release() { open(); holding = false; },
      heldCount: () => held,
      async close() { open(); server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); }
    }));
  });
}

// ── production statement texts, verbatim from the helpers module ─────────────
const helpersSource = readFileSync(path.join(process.cwd(), "src", "payment_attempt_helpers.ts"), "utf8");
const appSource = readFileSync(path.join(process.cwd(), "src", "app.ts"), "utf8");
const statementsIn = (source: string) => [...source.matchAll(/`(\s*UPDATE siton\.payment_attempts[\s\S]*?)`/g)].map((m) => m[1]!);
const productionStatements = [...statementsIn(helpersSource), ...statementsIn(appSource)];
const SETTLE_PARAM_SQL = productionStatements.find((s) => /SET result_class=\$1,/.test(s));            // settleAttemptInTx
const SETTLE_CASE_SQL = productionStatements.find((s) => /SET result_class=CASE/.test(s));              // settleProviderDispatch
assert.ok(SETTLE_PARAM_SQL && SETTLE_CASE_SQL, "production terminal statements located in src/payment_attempt_helpers.ts");

// ── helpers ──────────────────────────────────────────────────────────────────
const money = (base: string, op: string, auth: string, key: string) => fetch(`${base}/${op}`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify({ authorization_id: auth, amount_minor: 4200 }) }).then((r) => r.json());
/** production-style read: text() then JSON.parse (src/payment_provider.ts parseJsonSafely) */
const readStatus = async (base: string, auth: string) => { const res = await fetch(`${base}/status/${auth}?operation=capture`); const text = await res.text(); return JSON.parse(text); };
const observations = () => sim.snapshot().observations;
const receiptsOf = (query_id: string | null | undefined) => observations().filter((o) => o.kind === "status_received" && o.query_id === query_id);
const verdictsOn = (identity: string, afterSeq = 0) => observations().filter((o) => o.kind === "verdict_recorded" && o.seq > afterSeq && (o.identities || []).includes(identity));
const lastSeq = () => Math.max(0, ...observations().map((o) => o.seq), ...sim.snapshot().requests.map((r) => r.delivered_seq || r.seq));
const statusRequestsOf = (auth: string) => sim.requestsOf(auth, "status");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms: number, what: string) => { const end = Date.now() + ms; while (!cond() && Date.now() < end) await sleep(5); assert.ok(cond(), `timed out: ${what}`); };
const runChild = (base: string, label: string, auth: string) => new Promise<string>((resolve, reject) => execFile(process.execPath, [SELF, "child", base, label, auth], { windowsHide: true, env: { ...process.env } }, (e, out, err) => (e ? reject(new Error(err || e.message)) : resolve(out))));

type Seeded = { participant_id: string; deal_id: string; K: string };
async function seedAttempt(result_class: "unknown" | "success" | "permanent_fail" = "unknown", tag = randomUUID().slice(0, 8)): Promise<Seeded> {
  const K = `capture:r7:${tag}:${randomUUID()}`;
  const d = await lab.seedDeal({ state: "CompletionWindow", completionWindowUntil: new Date(Date.now() + 120_000), participants: [{
    buyer_state: "ChargingAttempt", money_state: "ChargeAttempt",
    priorAttempts: [{ attempt_type: "charge_start", result_class, correlation_id: K, dispatch_state: "responded", failure_evidence: result_class === "permanent_fail" ? "status_inference" : null, dispatched_at: new Date(Date.now() - 60_000) }]
  }] });
  return { participant_id: d.participants[0]!.participant_id, deal_id: d.deal_id, K };
}
const rowClass = async (s: Seeded) => String((await lab.pool.query(`SELECT result_class FROM siton.payment_attempts WHERE correlation_id=$1`, [s.K])).rows[0]?.result_class);
/** settleAttemptInTx parameters: [$1 class, $2 participant, $3 deal, $4 type, $5 correlation, $6 reference, $7 note, $8 evidence] */
const settleParams = (s: Seeded, cls: string, note: string | null = null) => [cls, s.participant_id, s.deal_id, "charge_start", s.K, null, note, cls === "permanent_fail" ? "status_inference" : null];
/** settleProviderDispatch parameters: [$1 participant, $2 deal, $3 type, $4 correlation, $5 class, $6 reference, $7 note, $8 owner uuid, $9 lease] */
const dispatchParams = (s: Seeded, cls: string, note: string | null = null) => [s.participant_id, s.deal_id, "charge_start", s.K, cls, null, note, randomUUID(), 1];

// ═════════════════════════════════════════════════════════════════════════════
await run("O1 restart: two REAL successive processes with the same WORKER_ID mint distinct query ids and each receipt binds to its own query", async () => {
  await runChild(simBase, "worker-restart", "auth-o1-c");
  await runChild(simBase, "worker-restart", "auth-o1-d");
  const reqs = [...statusRequestsOf("auth-o1-c"), ...statusRequestsOf("auth-o1-d")];
  console.log(`  O1 ids: ${JSON.stringify(reqs.map((r) => ({ auth: r.authorization, query_id: r.query_id })))}`);
  assert.equal(reqs.length, 2);
  assert.notEqual(reqs[0]!.query_id, reqs[1]!.query_id, "a restarted worker must never mint an id it minted before");
  for (const r of reqs) {
    assert.match(String(r.query_id), /^worker-restart:[0-9a-f-]{36}:q1$/, "id = label:instance-uuid:counter");
    assert.equal(receiptsOf(r.query_id).length, 1, `exactly one receipt for ${r.query_id}`);
    assert.ok(receiptsOf(r.query_id)[0]!.seq > (r.delivered_seq || 0), "received after the provider wrote it");
  }
  assert.notEqual(String(reqs[0]!.query_id).split(":")[1], String(reqs[1]!.query_id).split(":")[1], "distinct incarnations");
});

await run("O2 simultaneous workers — including two with the SAME label — mint distinct ids", async () => {
  await Promise.all([runChild(simBase, "worker-A", "auth-o2-a"), runChild(simBase, "worker-B", "auth-o2-b"), runChild(simBase, "worker-A", "auth-o2-a2")]);
  const ids = ["auth-o2-a", "auth-o2-b", "auth-o2-a2"].flatMap((a) => statusRequestsOf(a).map((r) => String(r.query_id)));
  console.log(`  O2 ids: ${JSON.stringify(ids)}`);
  assert.equal(ids.length, 3);
  assert.equal(new Set(ids).size, 3, "no two concurrent workers share a query id");
  for (const id of ids) assert.equal(receiptsOf(id).length, 1);
});

await run("O3 concurrent queries of ONE incarnation: distinct ids, receipts bound one-to-one, each positioned after its own answer was written", async () => {
  const auth = "auth-o3";
  const N = 24;
  await Promise.all(Array.from({ length: N }, () => readStatus(simBase, auth)));
  await current.drain();
  const reqs = statusRequestsOf(auth);
  assert.equal(reqs.length, N);
  const ids = reqs.map((r) => String(r.query_id));
  assert.equal(new Set(ids).size, N, "distinct ids within one incarnation");
  for (const r of reqs) {
    const rec = receiptsOf(r.query_id);
    assert.equal(rec.length, 1, `one receipt for ${r.query_id}`);
    assert.ok(rec[0]!.seq > Number(r.delivered_seq), `receipt ${rec[0]!.seq} after write ${r.delivered_seq}`);
    assert.equal(rec[0]!.instance, current.instance);
  }
  const stats = current.stats();
  console.log(`  O3 stats: queries=${stats.queries} receipts=${stats.receipts} dropped=${JSON.stringify(stats.receipts_dropped)}`);
});

await run("O4 an answer to a query of a DEAD incarnation (restart while the hop holds it) binds nothing; the new incarnation's own query binds normally", async () => {
  const hop = await startHop();
  const auth = "auth-o4";
  try {
    const A = restart(hop.base, "stable-worker-id");
    hop.hold(true);
    let parsed = false;
    const pending = readStatus(hop.base, auth).then((b) => { parsed = true; return b; });
    await until(() => hop.heldCount() >= 1 && Boolean(statusRequestsOf(auth)[0]?.delivered_seq), 3000, "provider wrote A's answer and the hop holds it");
    const qA = String(statusRequestsOf(auth)[0]!.query_id);
    const B = restart(hop.base, "stable-worker-id");                        // A died with the answer in flight
    assert.notEqual(A.instance, B.instance);
    hop.hold(false);
    const answerB = await readStatus(hop.base, auth);                       // B's own query, delivered normally
    await B.drain();
    const qB = String(statusRequestsOf(auth)[1]!.query_id);
    assert.equal(receiptsOf(qB).length, 1, "B's receipt");
    hop.release(); await pending; assert.equal(parsed, true);               // A's answer now reaches the (dead) caller
    await sleep(20);
    assert.equal(receiptsOf(qA).length, 0, "no receipt may be recorded for the dead incarnation's query");
    assert.ok(typeof answerB.state === "string");
    assert.equal(A.stats().receipts_dropped.dead_instance, 1, "A counted the dropped receipt");
    console.log(`  O4 qA=${qA} (dead, no receipt) qB=${qB} (receipt seq ${receiptsOf(qB)[0]!.seq})`);
  } finally { restart(simBase, "lab"); await hop.close(); }
});

await run("O5 a 0-row UPDATE (production shape, inside a transaction and autocommit) records no verdict", async () => {
  const ghost: Seeded = { participant_id: randomUUID(), deal_id: randomUUID(), K: `capture:r7:ghost:${randomUUID()}` };
  const before = lastSeq();
  const c = await lab.pool.connect();
  try {
    await c.query("BEGIN");
    const r = await c.query(SETTLE_PARAM_SQL!, settleParams(ghost, "permanent_fail"));
    assert.equal(r.rowCount, 0);
    const commit = await c.query("COMMIT");
    assert.equal(commit.command, "COMMIT");
    const auto = await c.query(SETTLE_PARAM_SQL!, settleParams(ghost, "permanent_fail"));
    assert.equal(auto.rowCount, 0);
  } finally { c.release(); }
  await current.drain();
  assert.equal(verdictsOn(ghost.K, before).length, 0, "no verdict for an attempt that does not exist");
  assert.equal(current.stats().verdicts_discarded.zero_row, 2);
});

await run("O6 ROLLBACK and ROLLBACK TO SAVEPOINT after the write record no verdict; RELEASE SAVEPOINT keeps it for the COMMIT", async () => {
  const s = await seedAttempt("unknown");
  const before = lastSeq();
  const c = await lab.pool.connect();
  try {
    await c.query("BEGIN");
    const r = await c.query(SETTLE_PARAM_SQL!, settleParams(s, "permanent_fail"));
    assert.equal(r.rowCount, 1, "the write matched the row");
    await c.query("ROLLBACK");
    await current.drain();
    assert.equal(verdictsOn(s.K, before).length, 0, "rolled back: nothing became durable");
    assert.equal(await rowClass(s), "unknown");
    // savepoint: the write is undone by ROLLBACK TO, the transaction commits without it
    await c.query("BEGIN"); await c.query("SAVEPOINT sp_o6");
    assert.equal((await c.query(SETTLE_PARAM_SQL!, settleParams(s, "permanent_fail"))).rowCount, 1);
    await c.query("ROLLBACK TO SAVEPOINT sp_o6"); await c.query("RELEASE SAVEPOINT sp_o6");
    assert.equal((await c.query("COMMIT")).command, "COMMIT");
    await current.drain();
    assert.equal(verdictsOn(s.K, before).length, 0, "undone by ROLLBACK TO: no verdict although the transaction committed");
    assert.equal(await rowClass(s), "unknown");
    // savepoint released: the write survives and is published at COMMIT, exactly once
    await c.query("BEGIN"); await c.query("SAVEPOINT sp_o6b");
    assert.equal((await c.query(SETTLE_PARAM_SQL!, settleParams(s, "permanent_fail"))).rowCount, 1);
    await c.query("RELEASE SAVEPOINT sp_o6b");
    assert.equal((await c.query("COMMIT")).command, "COMMIT");
    await current.drain();
    assert.equal(verdictsOn(s.K, before).length, 1, "released savepoint + COMMIT: one verdict");
    assert.equal(await rowClass(s), "permanent_fail");
  } finally { c.release(); }
  const st = current.stats();
  console.log(`  O6 discarded: rollback=${st.verdicts_discarded.rollback} savepoint_rollback=${st.verdicts_discarded.savepoint_rollback}`);
  assert.ok(st.verdicts_discarded.rollback >= 1 && st.verdicts_discarded.savepoint_rollback >= 1);
});

await run("O7 a COMMIT of an aborted transaction (command ROLLBACK) and a REJECTED COMMIT record no verdict", async () => {
  const s = await seedAttempt("unknown");
  const before = lastSeq();
  const c = await lab.pool.connect();
  try {
    await c.query("BEGIN");
    assert.equal((await c.query(SETTLE_PARAM_SQL!, settleParams(s, "permanent_fail"))).rowCount, 1);
    await c.query("SELECT 1/0").catch(() => undefined);                      // the transaction is now aborted
    const commit = await c.query("COMMIT");
    console.log(`  O7a COMMIT answered ${commit.command}`);
    assert.equal(commit.command, "ROLLBACK");
    await current.drain();
    assert.equal(verdictsOn(s.K, before).length, 0, "an aborted transaction's COMMIT publishes nothing");
    assert.equal(await rowClass(s), "unknown");
  } finally { c.release(); }
  // rejected COMMIT: the backend is terminated between the write and the COMMIT
  const s2 = await seedAttempt("unknown");
  const before2 = lastSeq();
  const c2 = await lab.pool.connect();
  c2.on("error", () => undefined);
  let commitError: unknown = null;
  try {
    const pid = Number((await c2.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
    await c2.query("BEGIN");
    assert.equal((await c2.query(SETTLE_PARAM_SQL!, settleParams(s2, "permanent_fail"))).rowCount, 1);
    await lab.pool.query("SELECT pg_terminate_backend($1)", [pid]);
    await sleep(50);
    try { await c2.query("COMMIT"); } catch (e) { commitError = e; }
  } finally { c2.release(true); }
  console.log(`  O7b COMMIT rejected: ${String((commitError as Error)?.message || commitError).slice(0, 80)}`);
  assert.ok(commitError, "the COMMIT must have failed");
  await current.drain();
  assert.equal(verdictsOn(s2.K, before2).length, 0, "a rejected COMMIT publishes nothing");
  assert.equal(await rowClass(s2), "unknown");
  const st = current.stats();
  assert.ok(st.verdicts_discarded.aborted_commit >= 1 && st.verdicts_discarded.commit_failed >= 1, JSON.stringify(st.verdicts_discarded));
});

await run("O8 a committed production write records exactly ONE verdict — staged during the transaction, published only at COMMIT; the CASE shape publishes the class the row durably holds", async () => {
  // (a) settleAttemptInTx: class is the $1 parameter
  const s = await seedAttempt("unknown");
  const before = lastSeq();
  const c = await lab.pool.connect();
  try {
    await c.query("BEGIN");
    assert.equal((await c.query(SETTLE_PARAM_SQL!, settleParams(s, "permanent_fail"))).rowCount, 1);
    await current.drain();
    assert.equal(verdictsOn(s.K, before).length, 0, "nothing published before the COMMIT");
    const commit = await c.query("COMMIT");
    assert.equal(commit.command, "COMMIT");
  } finally { c.release(); }
  await current.drain();
  const v = verdictsOn(s.K, before);
  console.log(`  O8a ${JSON.stringify(v.map((o) => ({ seq: o.seq, identities: o.identities, result_class: o.result_class, row_count: o.row_count, class_source: o.class_source })))}`);
  assert.equal(v.length, 1, "exactly one verdict");
  assert.deepEqual(v[0]!.identities, [s.K]);
  assert.equal(v[0]!.result_class, "permanent_fail");
  assert.equal(v[0]!.row_count, 1);
  assert.equal(v[0]!.class_source, "statement");
  // (b) settleProviderDispatch (CASE): on an unknown row the parameter lands → permanent_fail, read back from the locked row
  const s2 = await seedAttempt("unknown");
  const before2 = lastSeq();
  const c2 = await lab.pool.connect();
  try {
    await c2.query("BEGIN");
    assert.equal((await c2.query(SETTLE_CASE_SQL!, dispatchParams(s2, "permanent_fail"))).rowCount, 1);
    assert.equal((await c2.query("COMMIT")).command, "COMMIT");
  } finally { c2.release(); }
  await current.drain();
  const v2 = verdictsOn(s2.K, before2);
  assert.equal(v2.length, 1);
  assert.equal(v2[0]!.result_class, "permanent_fail");
  assert.equal(v2[0]!.class_source, "row_readback");
  assert.equal(await rowClass(s2), "permanent_fail");
  // (c) the same statement on a row that is already SUCCESS keeps success: the verdict says success, never the parameter
  const s3 = await seedAttempt("success");
  const before3 = lastSeq();
  const c3 = await lab.pool.connect();
  try {
    await c3.query("BEGIN");
    assert.equal((await c3.query(SETTLE_CASE_SQL!, dispatchParams(s3, "permanent_fail"))).rowCount, 1);
    assert.equal((await c3.query("COMMIT")).command, "COMMIT");
  } finally { c3.release(); }
  await current.drain();
  const v3 = verdictsOn(s3.K, before3);
  console.log(`  O8c ${JSON.stringify(v3.map((o) => ({ result_class: o.result_class, class_source: o.class_source })))} row=${await rowClass(s3)}`);
  assert.equal(await rowClass(s3), "success");
  assert.equal(v3.length, 1);
  assert.equal(v3[0]!.result_class, "success", "the published class is what the row holds, not what the parameter asked for");
  assert.equal(v3[0]!.class_source, "row_readback");
});

await run("O9 a note parameter that equals ANOTHER live identity is never an identity — production shape and Codex's shape", async () => {
  const victim = await seedAttempt("unknown");
  const other = await seedAttempt("unknown");
  const before = lastSeq();
  const c = await lab.pool.connect();
  try {
    await c.query("BEGIN");
    assert.equal((await c.query(SETTLE_PARAM_SQL!, settleParams(other, "permanent_fail", victim.K))).rowCount, 1);   // outcome_note = VICTIM's correlation id
    assert.equal((await c.query("COMMIT")).command, "COMMIT");
    // Codex's minimal shape, autocommit
    assert.equal((await c.query(`UPDATE siton.payment_attempts SET result_class=$1, outcome_note=$2 WHERE correlation_id=$3`, ["permanent_fail", victim.K, other.K])).rowCount, 1);
  } finally { c.release(); }
  await current.drain();
  const named = observations().filter((o) => o.kind === "verdict_recorded" && o.seq > before);
  console.log(`  O9 ${JSON.stringify(named.map((o) => ({ identities: o.identities, class_source: o.class_source })))}`);
  assert.equal(named.length, 2);
  for (const o of named) assert.deepEqual(o.identities, [other.K], "only the WHERE-bound identity");
  assert.equal(verdictsOn(victim.K, before).length, 0, "the note parameter was never attributed");
  assert.equal(await rowClass(victim), "unknown");
});

await run("O10 text() succeeds but JSON.parse fails (MALFORMED answer) → no receipt; json() rejecting → no receipt", async () => {
  const auth = "auth-o10";
  sim.scriptStatus(auth, [{ kind: "MALFORMED" }, { kind: "MALFORMED" }]);
  const res = await fetch(`${simBase}/status/${auth}?operation=capture`);
  const text = await res.text();                                            // the bytes arrived …
  await current.drain();
  const q1 = String(statusRequestsOf(auth)[0]!.query_id);
  assert.equal(receiptsOf(q1).length, 0, "no receipt before the parse");
  assert.throws(() => JSON.parse(text), "… but they are not an answer the app can act on");
  await current.drain();
  assert.equal(receiptsOf(q1).length, 0, "a failed parse records nothing");
  await assert.rejects((await fetch(`${simBase}/status/${auth}?operation=capture`)).json());
  await current.drain();
  const q2 = String(statusRequestsOf(auth)[1]!.query_id);
  assert.equal(receiptsOf(q2).length, 0);
  const st = current.stats();
  console.log(`  O10 parse_failed=${st.receipts_dropped.parse_failed}`);
  assert.ok(st.receipts_dropped.parse_failed >= 2);
});

await run("O11 an answer that does not echo THIS query id (rewritten or stripped by the hop) records no receipt", async () => {
  const auth = "auth-o11";
  const rewriting = await startHop({ forwardEcho: true, rewriteEcho: (echo) => (echo ? `${echo}-other` : null) });
  const stripping = await startHop({ forwardEcho: false });
  try {
    const A = restart(rewriting.base, "hop-rewrite");
    const body = await readStatus(rewriting.base, auth);
    assert.ok(typeof body.state === "string", "the app still got a well-formed answer");
    await A.drain();
    assert.equal(receiptsOf(statusRequestsOf(auth)[0]!.query_id).length, 0, "an answer naming another query is not a receipt of this one");
    assert.equal(A.stats().receipts_dropped.echo_mismatch, 1);
    const B = restart(stripping.base, "hop-strip");
    await readStatus(stripping.base, auth);
    await B.drain();
    assert.equal(receiptsOf(statusRequestsOf(auth)[1]!.query_id).length, 0, "an answer naming no query is not a receipt");
    assert.equal(B.stats().receipts_dropped.echo_mismatch, 1);
  } finally { restart(simBase, "lab"); await rewriting.close(); await stripping.close(); }
});

await run("O12 a valid parse records exactly one receipt, positioned after the provider wrote the answer and bound to this query", async () => {
  const auth = "auth-o12";
  const body = await readStatus(simBase, auth);
  await current.drain();
  const r = statusRequestsOf(auth)[0]!;
  const rec = receiptsOf(r.query_id);
  console.log(`  O12 query=${r.query_id} arrived=${r.seq} written=${r.delivered_seq} received=${rec[0]?.seq}`);
  assert.equal(rec.length, 1);
  assert.ok(rec[0]!.seq > Number(r.delivered_seq));
  assert.equal(rec[0]!.process, "lab");
  assert.equal(rec[0]!.instance, current.instance);
  assert.equal(typeof body.state, "string");
});

await run("O13 the same body parsed twice, and an identical replayed answer, never produce a second observation for the same query", async () => {
  const auth = "auth-o13";
  const res = await fetch(`${simBase}/status/${auth}?operation=capture`);
  const text = await res.text();
  JSON.parse(text); JSON.parse(text); JSON.parse(text);
  await current.drain();
  const q = String(statusRequestsOf(auth)[0]!.query_id);
  assert.equal(receiptsOf(q).length, 1, "one body → one receipt, however often it is parsed");
  await assert.rejects(res.text(), "a body can be read once");
  // a second, byte-identical answer (same state, same provider time bucket) is its own query with its own receipt
  const again = await fetch(`${simBase}/status/${auth}?operation=capture`);
  const text2 = await again.text();
  JSON.parse(text2);
  await current.drain();
  const q2 = String(statusRequestsOf(auth)[1]!.query_id);
  assert.notEqual(q, q2);
  assert.equal(receiptsOf(q).length, 1);
  assert.equal(receiptsOf(q2).length, 1);
});

await run("O14 Codex's restart + held-transport chronology through an HONEST hop with REAL committed verdicts → REJECT; the waited twin → ACCEPT; the rejected evidence never names the older query", async () => {
  const hop = await startHop();
  const policy = { settlementHorizonMs: HORIZON_MS, negativeStatusAuthoritative: true };
  try {
    // ── unsafe: K pending, pre-horizon Q1 received + REAL verdict, restart, post-horizon Q2 held, D sent ──
    const unsafe = await seedAttempt("unknown", "o14-unsafe");
    const auth = "auth-o14-unsafe";
    sim.script(auth, "capture", [{ kind: "PENDING_NO_EFFECT" }]); sim.script(auth, "recover", [{ kind: "SUCCESS" }]);
    const A = restart(hop.base, "stable-worker-id");
    await money(hop.base, "capture", auth, unsafe.K);
    await readStatus(hop.base, auth);                                        // Q1: pre-horizon, authorized final → Siton records permanent_fail
    const c = await lab.pool.connect();
    try { await c.query("BEGIN"); assert.equal((await c.query(SETTLE_PARAM_SQL!, settleParams(unsafe, "permanent_fail"))).rowCount, 1); assert.equal((await c.query("COMMIT")).command, "COMMIT"); } finally { c.release(); }
    await A.drain();
    const q1 = String(statusRequestsOf(auth)[0]!.query_id);
    assert.equal(receiptsOf(q1).length, 1); assert.equal(verdictsOn(unsafe.K).length, 1);
    const B = restart(hop.base, "stable-worker-id");                        // the worker restarts with the same stable id
    await sleep(HORIZON_MS + 60);
    hop.hold(true);
    let received = false;
    const pending = readStatus(hop.base, auth).then((b) => { received = true; return b; });
    await until(() => hop.heldCount() >= 1 && Boolean(statusRequestsOf(auth)[1]?.delivered_seq), 3000, "Q2 written by the provider and held by the hop");
    assert.equal(received, false);
    const D = `recovery:r7:o14-unsafe:${randomUUID()}`;
    await money(hop.base, "recover", auth, D);                               // sent while Q2 is still held
    assert.equal(received, false, "the recovery completed before Q2 reached Siton");
    await B.drain();
    const atDispatch = sim.snapshot();
    const report = auditDispatchLegality({ authorization: auth, requests: atDispatch.requests, observations: atDispatch.observations, rows: [], callbacks: [], policy });
    const judgement = report.judgements.find((j: any) => j.identity === D);
    console.log(`  O14 unsafe: violations=${JSON.stringify(report.violations.map((v) => v.code))} evidence=${JSON.stringify(judgement?.evidence || null)}`);
    assert.ok(report.violations.some((v) => v.code === "AUTOMATIC_REPEAT_WHILE_UNKNOWN"), "the recovery was sent on an answer Siton had not received");
    assert.equal(judgement?.evidence ?? null, null, "no evidence — in particular not Q1's receipt");
    assert.ok(!JSON.stringify(report.judgements).includes(q1), "the older query never appears as evidence");
    hop.release(); await pending; await B.drain();
    const late = auditDispatchLegality({ authorization: auth, requests: sim.snapshot().requests, observations: sim.snapshot().observations, rows: [], callbacks: [], policy });
    assert.ok(late.violations.some((v) => v.code === "AUTOMATIC_REPEAT_WHILE_UNKNOWN"), "still illegal once Q2 arrives late");

    // ── control: the same steps, but Siton WAITS for Q2, records the verdict, then sends ──
    const safe = await seedAttempt("unknown", "o14-safe");
    const auth2 = "auth-o14-safe";
    sim.script(auth2, "capture", [{ kind: "PENDING_NO_EFFECT" }]); sim.script(auth2, "recover", [{ kind: "SUCCESS" }]);
    const A2 = restart(hop.base, "stable-worker-id");
    await money(hop.base, "capture", auth2, safe.K);
    await readStatus(hop.base, auth2);
    const c2 = await lab.pool.connect();
    try { await c2.query("BEGIN"); assert.equal((await c2.query(SETTLE_PARAM_SQL!, settleParams(safe, "permanent_fail"))).rowCount, 1); await c2.query("COMMIT"); } finally { c2.release(); }
    await A2.drain();
    const B2 = restart(hop.base, "stable-worker-id");
    await sleep(HORIZON_MS + 60);
    await readStatus(hop.base, auth2);                                       // Q2 received by B2
    const c3 = await lab.pool.connect();
    try { await c3.query("BEGIN"); assert.equal((await c3.query(SETTLE_PARAM_SQL!, settleParams(safe, "permanent_fail"))).rowCount, 1); assert.equal((await c3.query("COMMIT")).command, "COMMIT"); } finally { c3.release(); }
    await B2.drain();
    const D2 = `recovery:r7:o14-safe:${randomUUID()}`;
    await money(hop.base, "recover", auth2, D2);
    await B2.drain();
    const control = auditDispatchLegality({ authorization: auth2, requests: sim.snapshot().requests, observations: sim.snapshot().observations, rows: [], callbacks: [], policy });
    const cj = control.judgements.find((j: any) => j.identity === D2);
    console.log(`  O14 control: violations=${JSON.stringify(control.violations.map((v) => v.code))} evidence=${JSON.stringify(cj?.evidence || null)}`);
    assert.ok(!control.violations.some((v) => v.code === "AUTOMATIC_REPEAT_WHILE_UNKNOWN"), "waited, received, recorded → legal");
    const evidence: any = cj?.evidence || null;
    assert.equal(evidence?.query_id, String(statusRequestsOf(auth2)[1]!.query_id), "the evidence names Q2 — the answer B2 actually received");
    assert.equal(evidence?.verdict_source, String(statusRequestsOf(auth2)[1]!.query_id));
  } finally { restart(simBase, "lab"); await hop.close(); }
});

// ── synthetic oracle controls (positions are explicit integers) ──────────────
const AUTH_S = "auth-synthetic";
const at = (ms: number) => new Date(Date.UTC(2026, 8, 13) + ms).toISOString();
function syntheticHistory() {
  const money = (seq: number, op: "capture" | "recover", key: string, atMs: number): ProviderRequestRecord => ({ seq, at: at(atMs), op, authorization: AUTH_S, idempotency_key: key, amount_minor: 4200, behavior: "PENDING_NO_EFFECT", effect_applied: false, replayed: false, answered: "200-pending", delivered_seq: seq + 1, delivered_at: at(atMs), query_id: null });
  const status = (seq: number, qid: string, atMs: number): ProviderRequestRecord => ({ seq, at: at(atMs), op: "status", authorization: AUTH_S, idempotency_key: qid, amount_minor: null, behavior: "capture:control", effect_applied: false, replayed: false, answered: "200", delivered_seq: seq + 1, delivered_at: at(atMs), query_id: qid, declared: { operation: "capture", state: "authorized", final: true, delivered: true, reference_ok: true, amount_ok: true } });
  const requests = [money(2, "capture", "K", 0), status(4, "Q1", 100), status(8, "Q2", 2000), money(12, "recover", "D", 2100)];
  const observations: ObservationRecord[] = ([
    { seq: 1, kind: "dispatch_sent", key: "K" }, { seq: 3, kind: "dispatch_received", key: "K" },
    { seq: 6, kind: "status_received", query_id: "Q1" }, { seq: 7, kind: "verdict_recorded", identities: ["K"], result_class: "permanent_fail" },
    { seq: 10, kind: "status_received", query_id: "Q2" }, { seq: 11, kind: "dispatch_sent", key: "D" }
  ] as any[]).map((o) => ({ ...o, at: at(o.seq), process: "worker", job: "job" }));
  return { authorization: AUTH_S, requests, observations, rows: [] as any[], callbacks: [] as any[], policy: { settlementHorizonMs: HORIZON_MS, negativeStatusAuthoritative: true } };
}
const legal = (h: ReturnType<typeof syntheticHistory>) => !auditDispatchLegality(h).violations.length;

await run("O15 oracle: the consistent synthetic chronology is legal, and a query id shared by TWO provider requests binds no receipt (Codex's reused-id control)", async () => {
  assert.equal(legal(syntheticHistory()), true, "baseline: Q2 received and recorded before D");
  const h = syntheticHistory();
  h.requests[2]!.query_id = "Q1";                                            // the restarted worker minted Q1 again
  h.observations = h.observations.filter((o) => o.query_id !== "Q2");       // Q2's receipt never happened (held)
  assert.equal(legal(h), false, "Q1's receipt must not be lent to the second request carrying the same id");
});

await run("O16 oracle: a receipt positioned before its query reached the provider, or for an answer the provider never wrote, binds nothing", async () => {
  const early = syntheticHistory();
  early.observations.find((o) => o.query_id === "Q2")!.seq = 5;             // 'received' before the query arrived at seq 8
  assert.equal(legal(early), false);
  const unwritten = syntheticHistory();
  unwritten.requests[2]!.delivered_seq = null;                               // the provider never wrote Q2's answer
  assert.equal(legal(unwritten), false);
});

await run("O17 static conformance: every production statement that assigns result_class is bound by the exact-shape classifier or is a non-terminal write; none is unrecognised", async () => {
  assert.ok(productionStatements.length >= 6, `found ${productionStatements.length} UPDATE siton.payment_attempts statements`);
  const bound = productionStatements.map((sql) => ({ sql: sql.replace(/\s+/g, " ").slice(0, 60), shape: classifyPaymentAttemptWrite(sql), unbound: isUnboundTerminalWrite(sql, ["permanent_fail", "permanent_fail", "permanent_fail", "permanent_fail", "permanent_fail", "permanent_fail", "permanent_fail", "permanent_fail", 1]) }));
  for (const b of bound) console.log(`  O17 ${b.sql}… → ${b.shape ? `${b.shape.kind} class=${JSON.stringify(b.shape.class)}${b.shape.kind === "keyed" ? ` identity=$${b.shape.identity_param} keys=${JSON.stringify(b.shape.key_params)}` : ""}` : "no terminal assignment"}${b.unbound ? " UNBOUND" : ""}`);
  assert.ok(bound.every((b) => !b.unbound), "no production terminal write escapes the observer");
  const keyed = bound.filter((b) => b.shape?.kind === "keyed");
  assert.equal(keyed.length, 2, "settleAttemptInTx and settleProviderDispatch");
  const param = keyed.find((b) => b.shape!.class.kind === "param")!.shape as any;
  assert.equal(param.class.index, 1); assert.equal(param.identity_param, 5); assert.deepEqual(param.key_params, { correlation_id: 5, participant_id: 2, deal_id: 3, attempt_type: 4 });
  const computed = keyed.find((b) => b.shape!.class.kind === "case_floor")!.shape as any;
  assert.equal(computed.class.index, 5); assert.equal(computed.identity_param, 4); assert.deepEqual(computed.key_params, { correlation_id: 4, participant_id: 1, deal_id: 2, attempt_type: 3 });
  const returning = bound.filter((b) => b.shape?.kind === "returning");
  assert.equal(returning.length, 1, "retireNeverDispatchedInTx");
  assert.deepEqual(returning[0]!.shape!.class, { kind: "literal", value: "temporary_fail" }, "the retirement write is non-terminal: never a verdict");
});

const failed = summary();
await lab.close();
process.exit(failed ? 1 : 0);
