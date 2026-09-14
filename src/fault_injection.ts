export type FaultPoint =
  | "db.before_begin"
  | "db.after_begin"
  | "db.before_commit"
  | "db.after_commit"
  // Inside an atomic lifecycle transition, after every durable write (audit,
  // outbox, entity state, idempotency) and before COMMIT. A "block" here holds
  // the transaction open with its locks and uncommitted unique-index entries,
  // which is exactly the window a concurrent lifecycle call contends on.
  | "atomic.after_durable_writes_before_commit"
  | "web.request.before_commit"
  | "web.request.after_commit"
  | "storage.before_put"
  | "storage.after_bytes_before_publish"
  | "storage.after_put_before_verify"
  | "storage.before_head"
  | "storage.before_delete"
  | "storage.after_delete"
  | "cleanup.after_claim"
  | "cleanup.before_ack"
  | "worker.after_claim"
  | "worker.before_ack"
  | "http.upload.after_commit_before_response"
  | "http.delete.after_commit_before_response"
  | "http.join.after_commit_before_response"
  | "http.otp.after_commit_before_response"
  // R9C — money rails: the three windows around an external provider call.
  | "payment.before_provider_io"
  | "payment.after_provider_io"
  | "payment.after_state_before_ledger"
  // F-12 — inside the transaction that writes the late-effect money evidence
  // AND the durable operator escalation, between the two. Injecting here proves
  // the two halves are atomic: neither may survive alone.
  | "payment.before_escalation_case"
  // F-12 — the durable capture-side identity read that decides whether two
  // distinct money effects exist. Injecting here proves the path fails CLOSED:
  // an unreadable evidence set must never be answered as "not a dual capture".
  | "payment.before_dual_capture_identity_read";

export type FaultAction =
  | { kind: "throw"; code: string }
  | { kind: "block" }
  | { kind: "crash"; exitCode?: number };

export type FaultBarrier = { entered: Promise<void>; release: () => void; cancel: (code?: string) => void };
type ArmedFault = FaultAction & { remaining: number; barrier?: FaultBarrier };

const faults = new Map<FaultPoint, ArmedFault>();
let hitObserver: ((point: FaultPoint) => void) | null = null;

function assertTestOnly() {
  if (process.env.NODE_ENV !== "test") throw new Error("fault_injection_unavailable_outside_test");
  if (["production", "prod", "commercial-live"].includes(String(process.env.APP_DEPLOYMENT_MODE || process.env.APP_ENV || "").toLowerCase())) {
    throw new Error("fault_injection_forbidden_in_production");
  }
}

export function armTestFault(point: FaultPoint, action: FaultAction, count = 1): FaultBarrier | null {
  assertTestOnly();
  let barrier: FaultBarrier | undefined;
  if (action.kind === "block") {
    let enteredResolve!: () => void;
    let releaseResolve!: () => void;
    let releaseReject!: (error: Error) => void;
    const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
    const released = new Promise<void>((resolve, reject) => { releaseResolve = resolve; releaseReject = reject; });
    barrier = { entered, release: releaseResolve, cancel: (code = "fault_barrier_cancelled") => releaseReject(Object.assign(new Error(code), { code })) };
    (barrier as any).enteredResolve = enteredResolve;
    (barrier as any).released = released;
  }
  faults.set(point, { ...action, remaining: Math.max(1, count), ...(barrier ? { barrier } : {}) });
  return barrier || null;
}

export function observeTestFaultHits(observer: ((point: FaultPoint) => void) | null) {
  assertTestOnly();
  hitObserver = observer;
}

export function resetTestFaults() {
  assertTestOnly();
  faults.clear();
  hitObserver = null;
}

export async function hitTestFault(point: FaultPoint): Promise<void> {
  const armed = faults.get(point);
  if (!armed) return;
  if (process.env.NODE_ENV !== "test") throw new Error("fault_injection_state_present_outside_test");
  armed.remaining -= 1;
  if (armed.remaining > 0) return;
  faults.delete(point);
  hitObserver?.(point);
  if (armed.kind === "throw") throw Object.assign(new Error(armed.code), { code: armed.code });
  if (armed.kind === "crash") process.exit(armed.exitCode || 86);
  const barrier = armed.barrier as any;
  barrier.enteredResolve();
  await barrier.released;
}

export function hasArmedTestFaults() {
  return faults.size > 0;
}
