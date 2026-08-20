import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import pg from "pg";
import dotenv from "dotenv";
dotenv.config({ quiet: true });

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const harness = new URL("./support/fault_web_process_harness.js", import.meta.url);
function waitMessage(child: ReturnType<typeof fork>, type: string) {
  return new Promise<any>((resolve, reject) => {
    const timeoutMs = type === "ready" ? 60_000 : 30_000;
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), timeoutMs);
    const listener = (message: any) => { if (message?.type === type) { clearTimeout(timer); child.off("message", listener); resolve(message); } };
    child.on("message", listener);
  });
}
function waitExit(child: ReturnType<typeof fork>) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    child.once("exit", () => resolve());
    child.once("error", reject);
  });
}
async function run(point: "web.request.before_commit" | "web.request.after_commit", run: number) {
  const port = 37000 + run + (point === "web.request.after_commit" ? 20 : 0);
  const title = `fault-process-${point}-${randomUUID()}`;
  const child = fork(harness, [point, "1"], { stdio: ["ignore", "ignore", "pipe", "ipc"], env: { ...process.env, NODE_ENV: "test", APP_DEPLOYMENT_MODE: "demo-preview", DISABLE_OUTBOX_WORKER: "1", PORT: String(port), HOST: "127.0.0.1" } });
  let stderr = ""; child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  await waitMessage(child, "ready");
  const fault = waitMessage(child, "fault");
  const request = fetch(`http://127.0.0.1:${port}/deals`, { method: "POST", headers: { "content-type": "application/json", "x-seller-id": "seller-default" }, body: JSON.stringify({ seller_id: "seller-default", title, price_per_unit: 10, min_units: 2, max_units: 3, deadline: new Date(Date.now() + 3 * 60 * 60_000).toISOString() }) }).catch(() => null);
  const first = await Promise.race([fault.then(() => "fault"), request.then(async (response) => `response:${response?.status}:${response ? await response.text() : "connection-error"}`)]);
  if (first !== "fault") {
    const exited = waitExit(child);
    child.kill("SIGTERM");
    await exited;
    throw new Error(`request completed before fault boundary: ${first}; ${stderr}`);
  }
  const exited = waitExit(child);
  child.kill("SIGTERM");
  await Promise.all([request, exited]);
  assert.ok(child.exitCode === 0 || child.signalCode === "SIGTERM", `unexpected child exit: code=${child.exitCode} signal=${child.signalCode} ${stderr}`);
  const count = Number((await pool.query(`SELECT count(*) FROM siton.deals WHERE title=$1`, [title])).rows[0].count);
  assert.equal(count, point === "web.request.before_commit" ? 0 : 1);
  await pool.query(`DELETE FROM siton.deals WHERE title=$1`, [title]);
}
try {
  for (let runIndex = 0; runIndex < 10; runIndex += 1) {
    await Promise.all([
      run("web.request.before_commit", runIndex),
      run("web.request.after_commit", runIndex)
    ]);
  }
} finally { await pool.end(); }
console.log("PASS real Web processes handle SIGTERM before/after commit deterministically across 10 runs");
