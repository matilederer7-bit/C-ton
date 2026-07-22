import type { OutboxEventRow } from "./outbox_worker_helpers.js";

export type WorkerLane = "money" | "reconcile" | "invoice" | "default";

export function workerLane(eventType: string): WorkerLane {
  if (["charge_deal", "recovery_deal", "refund_issue", "cancel_refund"].includes(eventType)) return "money";
  if (["seller_payout_reconcile", "invoice_document_reconcile"].includes(eventType)) return "reconcile";
  if (["invoice_document_issue"].includes(eventType)) return "invoice";
  return "default";
}

export async function runScheduledWorkerBatch<T>(args: {
  jobs: OutboxEventRow[];
  limits: Record<WorkerLane, number>;
  process: (job: OutboxEventRow) => Promise<T>;
}) {
  const runLane = async (lane: WorkerLane) => {
    const results: T[] = [];
    const queue = args.jobs.filter((job) => workerLane(job.event_type) === lane);
    let next = 0;
    const runner = async () => {
      while (next < queue.length) {
        const job = queue[next++];
        if (job) results.push(await args.process(job));
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, args.limits[lane]) }, runner));
    return results;
  };
  const lanes = await Promise.all((["money", "reconcile", "invoice", "default"] as const).map(runLane));
  return lanes.flat();
}
