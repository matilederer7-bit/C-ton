import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
process.env.NODE_ENV = "test";
const { pool, dbClientErrorObservations } = await import("../src/db.js");
const client = Object.assign(new EventEmitter(), { processID: 1234 });
pool.emit("connect", client as any);
pool.emit("connect", client as any);
assert.equal(client.listenerCount("error"), 1, "guard attaches exactly once per physical client");
const logs: string[] = [];
const originalLog = console.error;
let passed = 1;
try {
  console.error = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  for (const [error, expected] of [
    [new Error("password=SYNTHETIC_SENTINEL"), "unknown"],
    [{ code: "postgresql://u:SYNTHETIC_SENTINEL@host/db", message: "SYNTHETIC_SENTINEL" }, "unknown"],
    [{ code: "TOKEN", message: "SYNTHETIC_SENTINEL" }, "unknown"],
    [{ code: "57P01", message: "SYNTHETIC_SENTINEL" }, "57P01"],
    [{ code: "ECONNRESET", message: "SYNTHETIC_SENTINEL" }, "ECONNRESET"]
  ] as const) {
    client.emit("error", error);
    assert.equal(dbClientErrorObservations().at(-1)?.code, expected);
    assert.ok(!logs.join("").includes("SYNTHETIC_SENTINEL"), "error text or credential-bearing code reached logs");
    passed++;
  }
  for (let i = 0; i < 205; i++) client.emit("error", {code:"EPIPE"});
  assert.equal(dbClientErrorObservations().length, 200, "diagnostic observations must remain bounded");
  passed++;
} finally { console.error = originalLog; }
await pool.end();
console.log('SUMMARY db_client_error_log_safety passed=' + passed + ' failed=0');
