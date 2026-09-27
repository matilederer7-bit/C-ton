// Black-Sky F-H4 — the live Fastify surface:
//   * /health is liveness: it never runs the database readiness check
//   * /readiness is served from the cache inside the TTL (x-readiness-cache: hit)
//   * a burst of probes costs one database check
//   * readiness stays no-store (a stale intermediary verdict is never served)
import { strict as assert } from "node:assert";

process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.READINESS_CACHE_TTL_MS = "60000";

const { app, readinessProbe } = await import("../src/app.js");

let failed = 0;
async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (e: any) { console.error(`FAIL ${name}: ${e?.stack || e?.message}`); failed++; }
}

await run("/health is liveness: it does not run the database readiness check", async () => {
  const before = readinessProbe.state().checks;
  for (let i = 0; i < 5; i++) {
    const res = await app.inject({ method: "GET", url: "/health" });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { ok: true });
  }
  assert.equal(readinessProbe.state().checks, before, "liveness never touched the readiness check");
});

await run("/readiness: first probe is a miss, the burst after it is served from cache (one DB check)", async () => {
  readinessProbe.reset();
  const before = readinessProbe.state().checks;
  const first = await app.inject({ method: "GET", url: "/readiness" });
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.headers["x-readiness-cache"], "miss");
  assert.equal(first.json().ok, true);
  assert.equal(first.json().database, "connected");
  assert.equal(first.headers["cache-control"], "no-store");
  const burst = await Promise.all(Array.from({ length: 25 }, () => app.inject({ method: "GET", url: "/readiness" })));
  for (const res of burst) {
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["x-readiness-cache"], "hit");
    assert.equal(res.json().client_ip, "127.0.0.1", "per-caller fields are computed per request, not cached");
  }
  assert.equal(readinessProbe.state().checks - before, 1, "26 probes cost one database check");
});

await app.close();
if (failed) process.exit(1);
console.log("PASS readiness HTTP liveness/readiness distinction and cache");
