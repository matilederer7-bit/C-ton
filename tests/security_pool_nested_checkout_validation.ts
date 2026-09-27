// Black-Sky C2 regression (CRITICAL, availability): several public routes
// called ensure*Tables() — a catalog check on its OWN pool connection — from
// inside a transaction that already held one. With N concurrent requests and a
// pool of N connections every request held one connection and waited forever
// for another: ~10 concurrent GET /api/site/home deadlocked the whole web pool
// (join, payments and webhooks included) until connection timeouts fired.
// This test pins the pool to 2 connections and fires a COLD burst (the first
// requests after boot, before any schema check is cached) at the routes that
// nested the check. Pre-fix, the burst times out; post-fix all complete.
import { strict as assert } from "node:assert";

process.env.PG_POOL_MAX = "2";
process.env.PORT = String(process.env.PORT || "3359");
process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.RATE_LIMIT_MAX = "0";
process.env.RATE_LIMIT_SENSITIVE_MAX = "0";
process.env.RATE_LIMIT_READ_MAX = "0";

const { app } = await import("../src/app.js");
const { pool, resolvePoolMax } = await import("../src/db.js");

async function run(name: string, fn: () => Promise<void> | void) {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (error) { console.error(`FAIL ${name}`); throw error; }
}

await run("PG_POOL_MAX is bounded and applied", () => {
  assert.equal(resolvePoolMax("2"), 2);
  assert.equal(resolvePoolMax("1"), 2);
  assert.equal(resolvePoolMax("999"), 50);
  assert.equal(resolvePoolMax("nope"), 10);
  assert.equal((pool as any).options.max, 2);
});

await run("a cold concurrent burst on routes that used to nest a pool checkout completes with a 2-connection pool", async () => {
  const started = Date.now();
  const urls = [
    "/api/site/home", "/api/site/home", "/api/site/home",
    "/api/deals/00000000-0000-0000-0000-000000000000/chat",
    "/api/deals/00000000-0000-0000-0000-000000000000/chat",
    "/api/site/home"
  ];
  const results = await Promise.all(urls.map((url) => app.inject({ method: "GET", url })));
  const elapsed = Date.now() - started;
  for (const [i, res] of results.entries()) {
    assert.ok(res.statusCode < 500, `${urls[i]} -> ${res.statusCode} ${res.body.slice(0, 200)}`);
  }
  assert.ok(elapsed < 8000, `burst took ${elapsed} ms (pool starvation)`);
});

await app.close();
