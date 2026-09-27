#!/usr/bin/env node
// Black-Sky recovery proof (npm run chaos:recovery-proof).
//
// On a DISPOSABLE local database only, proves end to end with the REAL worker
// binary that a worker crash in the middle of a money operation recovers to
// exactly one money effect per obligation and a consistent ledger:
//
//   1. guard      DATABASE_URL must be a local PostgreSQL server
//                 (scripts/lib/destructive_target_guard.cjs refuses hosted /
//                 staging / production targets); a fresh isolated database is
//                 created on it (scripts/lib/test_db_isolation.cjs) and dropped
//                 at the end (--keep keeps it for inspection)
//   2. migrate    full ledgered manifest + test prerequisites
//   3. seed       a deal in Charging with two participants holding provider
//                 authorizations, audited along legal state paths, and one
//                 pending charge_deal job
//   4. crash      worker #1 (src/worker.ts) claims the job and dispatches the
//                 first capture; the in-script provider stub APPLIES the money
//                 effect and then holds the answer; worker #1 is SIGKILLed while
//                 the answer is outstanding (money moved, Siton never heard)
//   5. recover    worker #2 starts: lease-expiry reclaim, reconcile of the
//                 in-flight identity through the provider status seam, the
//                 second capture, completion window
//   6. verify     exactly ONE capture request and ONE capture effect per
//                 authorization, both participants ChargedSuccess with one fee
//                 row each, the charge job completed exactly once after a
//                 reclaim, and the READ-ONLY money invariants
//                 (scripts/lib/money_invariants.cjs) PASS
//
// Prints RECOVERY_PROOF_PASS or RECOVERY_PROOF_FAIL (exit 0 / 1); 2 = cannot run.
// No real money: the provider is an in-process HTTP stub on 127.0.0.1.
const http = require("node:http");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { Client } = require("pg");
require("dotenv").config({ quiet: true });
const { assertDestructiveTargetAllowed } = require("./lib/destructive_target_guard.cjs");
const isolation = require("./lib/test_db_isolation.cjs");
const { runMigrations } = require("./run_migrations.cjs");
const invariants = require("./lib/money_invariants.cjs");

const ROOT = path.join(__dirname, "..");
const KEEP = process.argv.includes("--keep");
const WEBHOOK_SECRET = "black-sky-recovery-proof-secret";

function log(line) { console.log(line); }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function poll(label, timeoutMs, fn, stepMs = 200) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { if (await fn()) return; await sleep(stepMs); }
  throw new Error("timeout waiting for: " + label);
}

// ── provider stub: effects are applied BEFORE the answer (like a real provider) ──
function startProviderStub() {
  const requests = [];
  const effects = new Map();
  const held = [];
  let holdNextCapture = false;
  const eff = (auth) => { if (!effects.has(auth)) effects.set(auth, { capture: 0, amount: 0 }); return effects.get(auth); };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let body = {};
      try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}; } catch { body = {}; }
      const url = new URL(String(req.url), "http://stub");
      res.setHeader("content-type", "application/json");
      if (url.pathname.startsWith("/status/")) {
        const reference = decodeURIComponent(url.pathname.slice("/status/".length)).replace(/^cap-/, "");
        requests.push({ op: "status", auth: reference });
        const e = eff(reference);
        res.end(JSON.stringify({ provider_reference: reference, currency: "ILS", provider_time: new Date().toISOString(), amount_minor: e.amount || null, state: e.capture > 0 ? "captured" : "authorized", final: true }));
        return;
      }
      if (url.pathname === "/capture") {
        const auth = String(body.authorization_id || "");
        requests.push({ op: "capture", auth, key: String(req.headers["idempotency-key"] || "") });
        const e = eff(auth);
        e.capture += 1;
        e.amount += Number(body.amount_minor) || 0;
        const answer = JSON.stringify({ ok: true, status: "captured", provider_reference: "cap-" + auth, reference: body.reference, authorization_id: auth });
        if (holdNextCapture) { holdNextCapture = false; held.push(() => { try { res.end(answer); } catch { /* socket gone */ } }); return; }
        res.end(answer);
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not_found" }));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({
    base: "http://127.0.0.1:" + server.address().port,
    requests, effects: (auth) => ({ ...eff(auth) }),
    holdNextCapture() { holdNextCapture = true; },
    heldCount: () => held.length,
    close: () => new Promise((r) => { for (const release of held.splice(0)) release(); server.closeAllConnections?.(); server.close(() => r()); })
  })));
}

function workerEnv(url, providerBase, id) {
  return {
    ...process.env,
    DATABASE_URL: url,
    NODE_ENV: "test",
    APP_DEPLOYMENT_MODE: "demo-preview",
    RUNTIME_ROLE: "worker",
    DISABLE_OUTBOX_WORKER: "1",
    LOG_LEVEL: "warn",
    WORKER_ID: id,
    OUTBOX_POLL_MS: "150",
    WORKER_CONCURRENCY: "2",
    WORKER_LEASE_MS: "5000",
    WORKER_STUCK_TIMEOUT_MS: "5000",
    WORKER_RECLAIM_EVERY_POLLS: "2",
    WORKER_HEARTBEAT_MS: "1000",
    WORKER_SHUTDOWN_TIMEOUT_MS: "3000",
    COMPLETION_WINDOW_MINUTES: "30",
    PAYMENT_PROVIDER: "payrail-http",
    PAYMENT_PROVIDER_MODE: "provider-ready",
    PAYMENT_ENVIRONMENT: "test",
    PAYMENT_PROVIDER_API_KEY: "black-sky-recovery-proof-key",
    PAYMENT_PROVIDER_BASE_URL: providerBase,
    PAYMENT_PROVIDER_AUTH_PATH: "/authorize",
    PAYMENT_PROVIDER_CAPTURE_PATH: "/capture",
    PAYMENT_PROVIDER_RECOVERY_PATH: "/recover",
    PAYMENT_PROVIDER_REFUND_PATH: "/refund",
    PAYMENT_PROVIDER_RELEASE_PATH: "/release",
    PAYMENT_PROVIDER_STATUS_PATH: "/status",
    PAYMENT_PROVIDER_TIMEOUT_MS: "3000",
    PAYMENT_SETTLEMENT_HORIZON_MS: "1500",
    PAYMENT_WEBHOOK_PROVIDER: "payrail-http",
    PAYMENT_WEBHOOK_SECRET: WEBHOOK_SECRET
  };
}

function spawnWorker(url, providerBase, id) {
  // ONE process (no tsx CLI wrapper): a SIGKILL must land on the worker itself.
  const child = spawn(process.execPath, ["--import", "tsx", path.join("src", "worker.ts")], {
    cwd: ROOT, env: workerEnv(url, providerBase, id), stdio: ["ignore", "pipe", "pipe"]
  });
  const output = [];
  child.stdout.on("data", (c) => output.push(String(c)));
  child.stderr.on("data", (c) => output.push(String(c)));
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  return { child, id, output, exited };
}

const DEAL_PATH = ["Draft", "PendingTarget", "TargetReached", "ClosedForJoining", "ReadyForCharging", "Charging"];
const BUYER_PATH = ["NotJoined", "JoinedAuthorized", "LockedIn", "ChargingAttempt"];
const MONEY_PATH = ["NoFinancial", "AuthHeld", "AuthLocked", "ChargeAttempt"];

async function seed(client) {
  const dealId = randomUUID();
  const audit = async (entity, entityId, stateType, pathStates) => {
    for (let i = 1; i < pathStates.length; i += 1) {
      const id = "black-sky-recovery-proof:" + randomUUID();
      await client.query(
        `INSERT INTO siton.audit_log (entity_type, entity_id, deal_id, state_type, from_state, to_state, action_name, request_id, correlation_id, idempotency_key, payload)
         VALUES ($1,$2,$3,$4,$5,$6,'test.black_sky_recovery_proof',$7,$7,$7,'{"fixture":"black_sky_recovery_proof"}'::jsonb)`,
        [entity, entityId, dealId, stateType, pathStates[i - 1], pathStates[i], id]);
    }
  };
  await client.query(
    `INSERT INTO siton.deals (deal_id, seller_id, state, title, price_per_unit, min_units, max_units, threshold_units, deadline, published_at)
     VALUES ($1,'seller-default','Charging','[black-sky] recovery proof',42,1,10,1,now() + interval '1 day',now())`, [dealId]);
  await audit("deal", dealId, "deal_state", DEAL_PATH);
  const participants = [];
  for (let i = 0; i < 2; i += 1) {
    const pid = randomUUID();
    const buyer = "buyer-recovery-" + pid.slice(0, 8);
    const auth = "auth-" + randomUUID().slice(0, 12);
    await client.query(
      `INSERT INTO siton.participants (participant_id, deal_id, buyer_id, qty, buyer_state, money_state, delivery_cost, created_at)
       VALUES ($1,$2,$3,1,'ChargingAttempt','ChargeAttempt',0,clock_timestamp())`, [pid, dealId, buyer]);
    await client.query(
      `INSERT INTO siton.payment_authorization_bindings
         (provider_code, provider_mode, provider_environment, authorization_id, provider_reference, deal_id, buyer_id, qty, amount_minor, currency, delivery_cost, status, correlation_id, consumed_by_participant_id, consumed_at)
       VALUES ('payrail-http','provider-ready','test',$1,$1,$2,$3,1,4200,'ILS',0,'consumed',$4,$5,now())`, [auth, dealId, buyer, "bs-auth:" + auth, pid]);
    await audit("participant", pid, "buyer_state", BUYER_PATH);
    await audit("participant", pid, "money_state", MONEY_PATH);
    participants.push({ participant_id: pid, authorization: auth });
  }
  const eventId = randomUUID();
  await client.query(
    `INSERT INTO siton.outbox_events (event_uuid, event_type, aggregate_type, aggregate_id, payload, status, attempt_count, available_at)
     VALUES ($1,'charge_deal','deal',$2,$3,'pending',0,now())`, [eventId, dealId, JSON.stringify({ deal_id: dealId })]);
  return { dealId, participants, eventId };
}

async function main() {
  const baseUrl = process.env.DATABASE_URL;
  try {
    assertDestructiveTargetAllowed(baseUrl, { action: "black_sky_recovery_proof" });
    isolation.assertLocalBase(baseUrl);
  } catch (error) {
    console.error("RECOVERY_PROOF_REFUSED " + invariants.redact(error.message));
    return 2;
  }
  const db = await isolation.createIsolatedDatabase({ baseUrl, purpose: "bsrecovery" });
  if (KEEP) db.keep();
  log("recovery proof target " + invariants.describeTarget(db.url) + " (disposable)");
  const provider = await startProviderStub();
  const workers = [];
  const failures = [];
  const check = (ok, label) => { log((ok ? "  CHECK_PASS " : "  CHECK_FAIL ") + label); if (!ok) failures.push(label); };
  let report = null;
  try {
    const log0 = console.log; console.log = () => {};
    try { await runMigrations(db.url); } finally { console.log = log0; }
    const prereq = spawnSync(process.execPath, [path.join(__dirname, "seed_test_prerequisites.cjs")], { env: { ...process.env, DATABASE_URL: db.url }, encoding: "utf8" });
    if (prereq.status !== 0) throw new Error("seed_test_prerequisites failed: " + prereq.stderr);
    const client = new Client({ connectionString: db.url, application_name: "black-sky-recovery-proof" });
    await client.connect();
    try {
      const s = await seed(client);
      log("SEEDED deal=" + s.dealId + " participants=" + s.participants.length + " charge_job=" + s.eventId);

      // ── crash: worker #1 dies with the first capture executed but unanswered ──
      provider.holdNextCapture();
      const w1 = spawnWorker(db.url, provider.base, "black-sky-recovery-w1-" + process.pid);
      workers.push(w1);
      await poll("worker #1 dispatched the first capture", 60_000, async () => provider.heldCount() === 1);
      w1.child.kill("SIGKILL");
      const w1Exit = await w1.exited;
      const mid = (await client.query(`SELECT status, lease_generation FROM siton.outbox_events WHERE event_uuid=$1`, [s.eventId])).rows[0];
      log("CRASH worker#1 " + JSON.stringify(w1Exit) + " job=" + JSON.stringify(mid) + " captures_executed=" + provider.requests.filter((r) => r.op === "capture").length);
      check(w1Exit.signal === "SIGKILL", "worker #1 was killed mid-flight");
      check(mid && mid.status === "processing", "the dead worker left the charge job claimed (nothing acked)");

      // ── recovery: worker #2 reclaims, reconciles, finishes ──
      const w2 = spawnWorker(db.url, provider.base, "black-sky-recovery-w2-" + process.pid);
      workers.push(w2);
      await poll("recovery converged", 90_000, async () => {
        const job = (await client.query(`SELECT status FROM siton.outbox_events WHERE event_uuid=$1`, [s.eventId])).rows[0];
        const charged = (await client.query(`SELECT count(*)::int AS n FROM siton.participants WHERE deal_id=$1 AND money_state='ChargedSuccess'`, [s.dealId])).rows[0].n;
        return job && job.status === "sent" && charged === 2;
      }, 300);
      w2.child.kill("SIGTERM");
      await Promise.race([w2.exited, sleep(10_000)]);

      for (const p of s.participants) {
        const captures = provider.requests.filter((r) => r.op === "capture" && r.auth === p.authorization).length;
        const e = provider.effects(p.authorization);
        const fee = (await client.query(`SELECT count(*)::int AS n FROM siton.platform_fee_money_events WHERE participant_id=$1 AND logical_entry_type='charge'`, [p.participant_id])).rows[0].n;
        const row = (await client.query(`SELECT money_state FROM siton.participants WHERE participant_id=$1`, [p.participant_id])).rows[0];
        check(captures === 1, "participant " + p.participant_id.slice(0, 8) + ": exactly one capture request (got " + captures + ")");
        check(e.capture === 1, "participant " + p.participant_id.slice(0, 8) + ": exactly one capture effect (got " + e.capture + ")");
        check(row.money_state === "ChargedSuccess", "participant " + p.participant_id.slice(0, 8) + ": ChargedSuccess (got " + row.money_state + ")");
        check(fee === 1, "participant " + p.participant_id.slice(0, 8) + ": one fee-ledger charge row (got " + fee + ")");
      }
      const lifecycle = (await client.query(
        `SELECT action, count(*)::int AS n FROM siton.operational_recovery_audit WHERE subject_type='outbox_event' AND subject_id=$1 GROUP BY action`, [s.eventId])).rows;
      const count = (action) => Number((lifecycle.find((r) => r.action === action) || { n: 0 }).n);
      const trail = (await client.query(
        `SELECT action || '@' || lease_generation || ':' || COALESCE(worker_id,'-') || ':' || reason_code AS t FROM siton.operational_recovery_audit
         WHERE subject_type='outbox_event' AND subject_id=$1 AND action <> 'heartbeat' ORDER BY audit_sequence`, [s.eventId])).rows.map((r) => r.t);
      log("CHARGE_JOB_LIFECYCLE " + trail.join(" -> "));
      check(count("reclaim") >= 1, "the dead worker's lease was reclaimed (" + count("reclaim") + ")");
      check(count("completion") === 1, "the charge job completed exactly once (" + count("completion") + ")");
      const deal = (await client.query(`SELECT state FROM siton.deals WHERE deal_id=$1`, [s.dealId])).rows[0];
      check(deal.state === "CompletionWindow", "the deal moved on to its completion window (" + deal.state + ")");
      const dlq = (await client.query(`SELECT count(*)::int AS n FROM siton.outbox_dlq`)).rows[0].n;
      check(dlq === 0, "nothing dead-lettered (" + dlq + ")");
    } finally {
      await client.end().catch(() => undefined);
    }

    const ro = new Client({ connectionString: db.url, application_name: "black-sky-recovery-proof-invariants" });
    await ro.connect();
    try { report = await invariants.runInvariants(ro); } finally { await ro.end().catch(() => undefined); }
    for (const result of report.results) if (result.status !== "PASS") log(invariants.formatResult(result));
    const c = report.counts;
    log("MONEY_INVARIANTS_SUMMARY overall=" + report.overall + " pass=" + c.PASS + " fail=" + c.FAIL + " error=" + c.ERROR + " skipped=" + c.SKIPPED + " info=" + c.INFO + " total=" + report.results.length);
    check(report.overall === "PASS", "money invariants PASS");
  } catch (error) {
    failures.push("aborted: " + invariants.redact(error && error.message ? error.message : error));
    for (const w of workers) log("--- " + w.id + " output (tail) ---\n" + w.output.join("").slice(-3000));
  } finally {
    for (const w of workers) if (w.child.exitCode === null && w.child.signalCode === null) w.child.kill("SIGKILL");
    await provider.close();
    if (!KEEP) await db.drop().catch(() => undefined);
    else log("kept disposable database " + db.name);
  }
  const summary = report ? " invariants=" + report.overall + " pass=" + report.counts.PASS + " fail=" + report.counts.FAIL + " error=" + report.counts.ERROR : " invariants=NOT_RUN";
  if (failures.length) {
    log("RECOVERY_PROOF_FAIL" + summary + " failures=" + JSON.stringify(failures));
    return 1;
  }
  log("RECOVERY_PROOF_PASS" + summary);
  return 0;
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }, (error) => {
    console.error("RECOVERY_PROOF_FAIL aborted: " + invariants.redact(error && error.message ? error.message : error));
    process.exitCode = 1;
  });
}

module.exports = { main };
