// Bounded load test against the REAL Fastify runtime + REAL PostgreSQL schema
// contracts, on a disposable local database. Measures p50/p95/p99 latency,
// throughput and error rate for Mall read, Deal read, and Join under
// concurrency. Not a hosted claim — states exactly what was exercised locally.
//
// Usage: node scripts/bounded_load_test.cjs
const { spawn, spawnSync, execSync } = require("node:child_process");
const { Client } = require("pg");
const http = require("node:http");

const BASE = (process.env.DR_BASE_URL || "postgresql://postgres:postgres@localhost:5432");
const DB = `siton_load_${process.pid}_${Date.now()}`;
const PORT = Number(process.env.LOAD_PORT || 3199);
const HOST = "127.0.0.1";
const SELLER = "load-seller";

function req(method, path, body, headers = {}) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const start = process.hrtime.bigint();
    const r = http.request({ host: HOST, port: PORT, method, path, headers: { "content-type": "application/json", ...headers, ...(data ? { "content-length": Buffer.byteLength(data) } : {}) } }, (res) => {
      let buf = ""; res.on("data", (d) => (buf += d)); res.on("end", () => {
        const ms = Number(process.hrtime.bigint() - start) / 1e6;
        resolve({ status: res.statusCode, ms, body: buf });
      });
    });
    r.on("error", () => resolve({ status: 0, ms: Number(process.hrtime.bigint() - start) / 1e6, body: "" }));
    if (data) r.write(data); r.end();
  });
}

function pct(sorted, p) { if (!sorted.length) return 0; const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length)); return Number(sorted[i].toFixed(1)); }

async function loadPhase(name, make, total, concurrency) {
  const lat = []; let ok = 0, err = 0; let idx = 0;
  const started = Date.now();
  async function worker() { while (idx < total) { const i = idx++; const r = await make(i); lat.push(r.ms); if (r.status >= 200 && r.status < 400) ok++; else err++; } }
  await Promise.all(Array.from({ length: concurrency }, worker));
  const elapsed = (Date.now() - started) / 1000;
  lat.sort((a, b) => a - b);
  return { name, total, concurrency, ok, err, elapsed: Number(elapsed.toFixed(2)), rps: Number((total / elapsed).toFixed(1)), p50: pct(lat, 50), p95: pct(lat, 95), p99: pct(lat, 99), max: Number((lat[lat.length - 1] || 0).toFixed(1)) };
}

let child;
async function withAdmin(fn) { const c = new Client({ connectionString: `${BASE}/postgres` }); await c.connect(); try { return await fn(c); } finally { await c.end(); } }

(async () => {
  const quote = (n) => `"${n.replace(/"/g, "")}"`;
  try {
    await withAdmin((c) => c.query(`DROP DATABASE IF EXISTS ${quote(DB)} WITH (FORCE)`));
    await withAdmin((c) => c.query(`CREATE DATABASE ${quote(DB)}`));
    const dbUrl = `${BASE}/${DB}`;
    execSync("node scripts/run_migrations.cjs", { env: { ...process.env, DATABASE_URL: dbUrl }, stdio: "ignore" });

    // boot the real app (demo-preview: header seller identity, no Supabase needed)
    child = spawn(process.execPath, ["--import", "tsx", "src/app.ts"], {
      // Rate limiter OFF: this measures runtime + DB CAPACITY, not the per-IP
      // limiter (which correctly caps a single IP at 200/window, 20 sensitive).
      env: { ...process.env, DATABASE_URL: dbUrl, APP_DEPLOYMENT_MODE: "demo-preview", PORT: String(PORT), DISABLE_OUTBOX_WORKER: "1", CANONICAL_POSTGRES_RUNTIME: "", RATE_LIMIT_MAX: "0", RATE_LIMIT_SENSITIVE_MAX: "0" },
      stdio: "ignore"
    });
    // wait for readiness
    let up = false;
    for (let i = 0; i < 60; i++) { const r = await req("GET", "/readiness"); if (r.status === 200) { up = true; break; } await new Promise((s) => setTimeout(s, 500)); }
    if (!up) throw new Error("app did not become ready");

    // seed 5 PUBLISHED deals + delivery options directly (bypasses the
    // seller-profile publish gate; we are load-testing read/join capacity, not
    // the publish flow). Large max_units so concurrent joins never exhaust it.
    const seed = new Client({ connectionString: dbUrl }); await seed.connect();
    const dealIds = [];
    try {
      await seed.query(`INSERT INTO siton.seller_accounts (seller_id, display_name, seller_status) VALUES ($1,'[LOAD] מוכר','Active') ON CONFLICT (seller_id) DO NOTHING`, [SELLER]);
      for (let i = 0; i < 5; i++) {
        const r = await seed.query(
          `INSERT INTO siton.deals (title, price_per_unit, min_units, max_units, threshold_units, deadline, seller_id, state, published_at)
           VALUES ($1, 20, 10, 100000, 9, now()+interval '3 days', $2, 'PendingTarget', now()) RETURNING deal_id`,
          [`[LOAD] עסקה ${i}`, SELLER]
        );
        const id = r.rows[0].deal_id;
        await seed.query(`INSERT INTO siton.deal_delivery_options (deal_id, option_type, label, cost, sort_order) VALUES ($1,'pickup','איסוף',0,0)`, [id]);
        dealIds.push(id);
      }
    } finally { await seed.end(); }
    if (!dealIds.length) throw new Error("no deals seeded");

    const results = [];
    results.push(await loadPhase("Mall read", () => req("GET", "/api/mall/deals?sort=newest"), 2000, 40));
    results.push(await loadPhase("Deal read", (i) => req("GET", `/api/deals/${dealIds[i % dealIds.length]}/public`), 2000, 40));
    results.push(await loadPhase("Join (multi-qty)", (i) => req("POST", `/api/deals/${dealIds[i % dealIds.length]}/join`,
      { qty: 1 + (i % 3), buyer_id: `load-buyer-${i}`, buyer_name: `טוען${i}`, buyer_phone: `+97250${String(1000000 + i).slice(-7)}`, payment_disclosure_accepted: true },
      { "idempotency-key": `load-join-${i}-${Date.now()}` }), 1000, 25));
    // concurrent Join on the SAME deal — inventory/idempotency contention
    results.push(await loadPhase("Join concurrent (1 deal)", (i) => req("POST", `/api/deals/${dealIds[0]}/join`,
      { qty: 1, buyer_id: `conc-buyer-${i}`, buyer_name: `ריצה${i}`, buyer_phone: `+97251${String(1000000 + i).slice(-7)}`, payment_disclosure_accepted: true },
      { "idempotency-key": `load-conc-${i}-${Date.now()}` }), 500, 50));

    console.log("\n=== BOUNDED LOAD TEST (local runtime + real PostgreSQL contracts) ===");
    console.log("phase                     total  conc   ok   err   rps    p50    p95    p99    max(ms)");
    for (const r of results) {
      console.log(`${r.name.padEnd(24)} ${String(r.total).padStart(5)} ${String(r.concurrency).padStart(5)} ${String(r.ok).padStart(4)} ${String(r.err).padStart(5)} ${String(r.rps).padStart(6)} ${String(r.p50).padStart(6)} ${String(r.p95).padStart(6)} ${String(r.p99).padStart(6)} ${String(r.max).padStart(8)}`);
    }
    const totalErr = results.reduce((s, r) => s + r.err, 0);
    console.log(`\nLOAD_TEST_${totalErr === 0 ? "PASS" : "COMPLETE"} total_errors=${totalErr}`);
    process.exitCode = 0;
  } catch (e) {
    console.error("LOAD_TEST_ERROR", String(e && e.message || e));
    process.exitCode = 1;
  } finally {
    if (child) { try { child.kill("SIGKILL"); } catch {} }
    await new Promise((s) => setTimeout(s, 500));
    await withAdmin((c) => c.query(`DROP DATABASE IF EXISTS ${quote(DB)} WITH (FORCE)`)).catch(() => {});
  }
})();
