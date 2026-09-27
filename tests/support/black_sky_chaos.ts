// Shared support for the Black-Sky COMBINATION chaos suites
// (tests/black_sky_*_failure_validation.ts).
//
// * runMoneyInvariantsOrThrow — runs the canonical READ-ONLY money invariants
//   query set (scripts/lib/money_invariants.cjs, the same set the operator CLI
//   and the DR rehearsal use) against the disposable test database and throws,
//   naming every FAIL/ERROR invariant, unless the whole report is PASS.
// * audited seeding — rows inserted in a mid-lifecycle state carry the audit
//   rows the runtime would have written (one per entity/state_type into the
//   current state), so the audit invariants judge the scenario, not the seed.
//
// Local/test only. Never points anywhere but the DATABASE_URL the test runner
// created for this file.

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import pg from "pg";

const require = createRequire(import.meta.url);
// Tests run compiled from .tmp_test_dist with the repository root as cwd.
export const REPO_ROOT = process.cwd();
export function requireRepoScript<T = any>(relative: string): T {
  return require(path.join(REPO_ROOT, relative)) as T;
}
const invariantsLib = requireRepoScript("scripts/lib/money_invariants.cjs") as {
  runInvariants: (client: any, options?: { only?: string[] }) => Promise<{ overall: string; counts: Record<string, number>; results: Array<{ name: string; status: string; count: number; samples: string[]; reason?: string }> }>;
  formatResult: (result: unknown) => string;
};

export async function runMoneyInvariants(connectionString = process.env.DATABASE_URL) {
  const client = new pg.Client({ connectionString, application_name: "black-sky-invariants" });
  await client.connect();
  try {
    return await invariantsLib.runInvariants(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** Every invariant must be PASS/SKIPPED/INFO. Prints the summary line. */
export async function runMoneyInvariantsOrThrow(label: string, connectionString = process.env.DATABASE_URL) {
  const report = await runMoneyInvariants(connectionString);
  const bad = report.results.filter((r) => r.status === "FAIL" || r.status === "ERROR");
  const c = report.counts;
  console.log(`  ${label} MONEY_INVARIANTS overall=${report.overall} pass=${c.PASS} fail=${c.FAIL} error=${c.ERROR} skipped=${c.SKIPPED} info=${c.INFO}`);
  assert.equal(report.overall, "PASS", `${label}: money invariants failed: ${bad.map((r) => invariantsLib.formatResult(r)).join(" | ")}`);
  return report;
}

type Queryable = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

let seq = 0;
function tag(prefix: string) {
  seq += 1;
  return `${prefix}:${process.pid}:${Date.now()}:${seq}`;
}

// Mirrors DEAL/BUYER/MONEY_TRANSITIONS in src/app.ts (and the DB transition
// functions the audit trigger enforces). Fixtures record the SHORTEST legal
// path into the seeded state, one audited step per transition.
const DEAL_PATHS: Record<string, string[]> = {
  Draft: ["PendingTarget", "Cancelled"],
  PendingTarget: ["TargetReached", "Failed", "ClosedForJoining"],
  TargetReached: ["ClosedForJoining"],
  ClosedForJoining: ["ReadyForCharging", "PendingTarget", "TargetReached", "Failed"],
  ReadyForCharging: ["Charging"],
  Charging: ["CompletionWindow"],
  CompletionWindow: ["Completed", "Failed"]
};
const BUYER_PATHS: Record<string, string[]> = {
  NotJoined: ["JoinedAuthorized", "DealFailed"],
  JoinedAuthorized: ["LockedIn", "DealFailed"],
  LockedIn: ["ChargingAttempt", "DealFailed"],
  ChargingAttempt: ["ChargedSuccess", "ChargeFailedCompletion", "DealFailed"],
  ChargeFailedCompletion: ["Recovered", "Dropped", "DealFailed"],
  ChargedSuccess: ["DealCompleted", "DealFailed"],
  Recovered: ["DealCompleted", "DealFailed"],
  Dropped: ["DealFailed"]
};
const MONEY_PATHS: Record<string, string[]> = {
  NoFinancial: ["AuthHeld"],
  AuthHeld: ["AuthLocked", "AuthReleased"],
  AuthLocked: ["ChargeAttempt", "AuthReleased"],
  ChargeAttempt: ["ChargedSuccess", "ChargeFailedRecovery", "AuthReleased"],
  ChargeFailedRecovery: ["RecoveredCharge", "AuthReleased"],
  ChargedSuccess: ["Refunded"],
  RecoveredCharge: ["Refunded"]
};

function shortestPath(graph: Record<string, string[]>, from: string, to: string): string[] {
  if (from === to) return [from];
  const previous = new Map<string, string>();
  const queue = [from];
  while (queue.length) {
    const node = queue.shift()!;
    for (const next of graph[node] || []) {
      if (previous.has(next) || next === from) continue;
      previous.set(next, node);
      if (next === to) {
        const path = [to];
        while (path[0] !== from) path.unshift(previous.get(path[0]!)!);
        return path;
      }
      queue.push(next);
    }
  }
  throw new Error(`fixture: no legal path ${from} -> ${to}`);
}

async function auditPath(db: Queryable, entity: "deal" | "participant", entityId: string, dealId: string, stateType: string, path: string[]) {
  for (let i = 1; i < path.length; i += 1) {
    const id = tag("black-sky-seed");
    await db.query(
      `INSERT INTO siton.audit_log (entity_type, entity_id, deal_id, state_type, from_state, to_state, action_name, request_id, correlation_id, idempotency_key, payload)
       VALUES ($1,$2,$3,$4,$5,$6,'test.black_sky_fixture',$7,$7,$8,'{"fixture":"black_sky"}'::jsonb)`,
      [entity, entityId, dealId, stateType, path[i - 1], path[i], id, `${id}:${entityId}:${stateType}:${path[i]}`]
    );
  }
}

/** Audit every seeded deal/participant of a deal into its current state along a legal path. */
export async function auditSeededDeal(db: Queryable, dealId: string) {
  const deal = (await db.query(`SELECT state FROM siton.deals WHERE deal_id=$1`, [dealId])).rows[0];
  if (deal) await auditPath(db, "deal", dealId, dealId, "deal_state", shortestPath(DEAL_PATHS, "Draft", String(deal.state)));
  const parts = (await db.query(`SELECT participant_id, buyer_state, money_state FROM siton.participants WHERE deal_id=$1`, [dealId])).rows;
  for (const p of parts) {
    const pid = String(p.participant_id);
    await auditPath(db, "participant", pid, dealId, "buyer_state", shortestPath(BUYER_PATHS, "NotJoined", String(p.buyer_state)));
    await auditPath(db, "participant", pid, dealId, "money_state", shortestPath(MONEY_PATHS, "NoFinancial", String(p.money_state)));
  }
}

export type WorkerChild = { child: ChildProcess; id: string; output: string[]; exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }> };
const liveChildren = new Set<ChildProcess>();
process.on("exit", () => { for (const child of liveChildren) { try { child.kill("SIGKILL"); } catch { /* gone */ } } });

/** The REAL worker binary (compiled .tmp_test_dist/src/worker.js) as a child process. */
export function spawnWorkerProcess(id: string, env: Record<string, string>): WorkerChild {
  const child = spawn(process.execPath, [path.join(REPO_ROOT, ".tmp_test_dist", "src", "worker.js")], {
    cwd: REPO_ROOT,
    env: { ...process.env, NODE_ENV: "test", DISABLE_OUTBOX_WORKER: "1", LOG_LEVEL: "warn", WORKER_ID: id, ...env },
    stdio: ["ignore", "pipe", "pipe"]
  });
  liveChildren.add(child);
  const output: string[] = [];
  child.stdout?.on("data", (chunk) => output.push(String(chunk)));
  child.stderr?.on("data", (chunk) => output.push(String(chunk)));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => { liveChildren.delete(child); resolve({ code, signal }); });
  });
  return { child, id, output, exited };
}

export function alive(worker: WorkerChild) {
  return worker.child.exitCode === null && worker.child.signalCode === null;
}

/** Parsed pino JSON lines a worker child printed. */
export function workerLogLines(worker: WorkerChild): Array<Record<string, any>> {
  return worker.output.join("").split("\n").filter((line) => line.startsWith("{")).map((line) => { try { return JSON.parse(line); } catch { return {}; } });
}

export function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export async function poll(label: string, timeoutMs: number, fn: () => Promise<boolean>, stepMs = 100) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(stepMs);
  }
  throw new Error(`timeout waiting for: ${label}`);
}
