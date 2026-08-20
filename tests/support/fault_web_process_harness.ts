import { armTestFault, observeTestFaultHits, type FaultPoint } from "../../src/fault_injection.js";
process.env.NODE_ENV = "test";
process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.DISABLE_OUTBOX_WORKER = "1";
const { app, closeWorkerDatabase, startApplication } = await import("../../src/app.js");
let requestSettledResolve!: () => void;
const requestSettled = new Promise<void>((resolve) => { requestSettledResolve = resolve; });
app.addHook("onResponse", async (request) => {
  if (request.method === "POST" && request.url === "/deals") requestSettledResolve();
});
await startApplication();
const point = String(process.argv[2]) as FaultPoint;
const occurrence = Number(process.argv[3] || 3);
const barrier = armTestFault(point, { kind: "block" }, occurrence);
observeTestFaultHits((hit) => { if (typeof process.send === "function") process.send({ type: "fault", point: hit }); });
if (typeof process.send === "function") process.send({ type: "ready" });
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  barrier?.cancel("sigterm_at_fault_boundary");
  await Promise.race([
    requestSettled,
    new Promise<void>((resolve) => setTimeout(resolve, 10_000))
  ]);
  await app.close().catch(() => undefined);
  await closeWorkerDatabase().catch(() => undefined);
  process.exit(0);
}
process.once("SIGTERM", () => { void stop(); });
process.once("SIGINT", () => { void stop(); });
