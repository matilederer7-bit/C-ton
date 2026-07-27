import assert from "node:assert/strict";
import {
  armTestFault,
  hasArmedTestFaults,
  hitTestFault,
  observeTestFaultHits,
  resetTestFaults
} from "../src/fault_injection.js";

process.env.NODE_ENV = "test";
process.env.APP_DEPLOYMENT_MODE = "test";

const hits: string[] = [];
observeTestFaultHits((point) => hits.push(point));
armTestFault("db.before_commit", { kind: "throw", code: "db_commit_unavailable" });
await assert.rejects(() => hitTestFault("db.before_commit"), (error: any) => error.code === "db_commit_unavailable");
assert.deepEqual(hits, ["db.before_commit"]);
assert.equal(hasArmedTestFaults(), false);

const barrier = armTestFault("worker.after_claim", { kind: "block" });
assert.ok(barrier);
let passed = false;
const blocked = hitTestFault("worker.after_claim").then(() => { passed = true; });
await barrier!.entered;
assert.equal(passed, false);
barrier!.release();
await blocked;
assert.equal(passed, true);

for (let run = 0; run < 10; run += 1) {
  armTestFault("cleanup.before_ack", { kind: "throw", code: `ack_failure_${run}` });
  await assert.rejects(() => hitTestFault("cleanup.before_ack"), (error: any) => error.code === `ack_failure_${run}`);
}
resetTestFaults();

process.env.APP_DEPLOYMENT_MODE = "production";
assert.throws(() => armTestFault("db.before_begin", { kind: "throw", code: "forbidden" }), /forbidden_in_production/);
process.env.APP_DEPLOYMENT_MODE = "test";
assert.equal(hasArmedTestFaults(), false);
console.log("PASS fault controller is deterministic, barrier-based, process-local, and unavailable in production");