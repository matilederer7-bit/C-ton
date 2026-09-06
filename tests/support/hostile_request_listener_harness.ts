// Child-process harness for the real-listener hostile request suite.
//
// Boots the real application on a real TCP listener (startApplication, not
// app.inject) so the parent can send raw bytes over a socket and observe what a
// production process would do: survive, answer, and keep answering.
//
// stdout carries the real pino log lines; the parent captures them.
process.env.NODE_ENV = "test";
process.env.DISABLE_OUTBOX_WORKER = "1";
const { app, closeWorkerDatabase, startApplication } = await import("../../src/app.js");
await startApplication();
const address = app.server.address();
const port = typeof address === "object" && address ? address.port : Number(process.env.PORT);
if (typeof process.send === "function") process.send({ type: "ready", port });
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await app.close().catch(() => undefined);
  await closeWorkerDatabase().catch(() => undefined);
  process.exit(0);
}
process.once("SIGTERM", () => { void stop(); });
process.once("SIGINT", () => { void stop(); });
process.on("message", (message: any) => { if (message?.type === "stop") void stop(); });
