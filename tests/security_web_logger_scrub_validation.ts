// Black-Sky F-H3 regression: the Fastify WEB logger (and every request-scoped
// child logger, and every worker path that logs through app.log) must use the
// scrubbing `err` serializer. Before the fix only the worker's own pino logger
// did, so an error carrying provider payloads, pg `detail` or buyer data was
// written verbatim by the web 500 handler.
import { strict as assert } from "node:assert";

process.env.PORT = String(process.env.PORT || "3357");
process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.DISABLE_OUTBOX_WORKER = "1";
delete process.env.SENTRY_DSN;

const pino: any = await import("pino");
const { errorLogSerializer } = await import("../src/log_redaction.js");
const { app } = await import("../src/app.js");
const serializersSym = (pino.default ?? pino).symbols.serializersSym;

async function run(name: string, fn: () => Promise<void> | void) {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (error) { console.error(`FAIL ${name}`); throw error; }
}

await run("the web root logger uses errorLogSerializer for `err`", () => {
  assert.equal((app.log as any)[serializersSym]?.err, errorLogSerializer);
});

await run("a request-scoped child logger keeps the scrubbing serializer", () => {
  const child: any = app.log.child({ reqId: "req:test" });
  assert.equal(child[serializersSym]?.err, errorLogSerializer);
});

await run("an error carrying a secret, a card number and pg detail is scrubbed by the serializer the web logger uses", () => {
  const err: any = new Error("provider rejected request");
  err.detail = "Key (buyer_email)=(victim@example.com) already exists";
  err.providerPayload = { apiKey: "grow_live_SECRETVALUE1234567890", card: "4580458045804580" };
  err.authorization = "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJlLXNpZ25hdHVyZQ";
  const serialized = JSON.stringify((app.log as any)[serializersSym].err(err));
  for (const leak of ["victim@example.com", "SECRETVALUE1234567890", "eyJhbGciOiJIUzI1NiJ9", "Bearer "]) {
    assert.ok(!serialized.includes(leak), `web logger serializer leaked ${leak}: ${serialized}`);
  }
});

await app.close();
