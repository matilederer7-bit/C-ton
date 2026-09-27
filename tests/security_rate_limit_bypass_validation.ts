// Black-Sky C4/B3 end-to-end: through the REAL onRequest limiter, a percent-
// encoded OTP path and the /api join alias are budgeted. Pre-fix both passed
// every per-IP budget except the global 200/min one.
import { strict as assert } from "node:assert";

process.env.PORT = String(process.env.PORT || "3361");
process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.RATE_LIMIT_MAX = "1000";
process.env.RATE_LIMIT_SENSITIVE_MAX = "3";
process.env.RATE_LIMIT_JOIN_MAX = "4";
process.env.RATE_LIMIT_ANALYTICS_MAX = "2";

const { app } = await import("../src/app.js");

async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (error) { console.error(`FAIL ${name}`); throw error; }
}

async function statuses(n: number, req: { method: "POST"; url: string; ip: string; payload?: unknown }) {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const res = await app.inject({ method: req.method, url: req.url, remoteAddress: req.ip, payload: (req.payload ?? {}) as any, headers: { "content-type": "application/json" } });
    out.push(res.statusCode);
  }
  return out;
}

await run("percent-encoded OTP path hits the sensitive budget", async () => {
  const codes = await statuses(5, { method: "POST", url: "/api/%6Ftp/request", ip: "198.51.100.21" });
  assert.equal(codes.filter((c) => c === 429).length, 2, JSON.stringify(codes));
});

await run("the /api join alias hits the join budget", async () => {
  const codes = await statuses(6, { method: "POST", url: "/api/deals/00000000-0000-0000-0000-000000000000/join", ip: "198.51.100.22" });
  assert.equal(codes.filter((c) => c === 429).length, 2, JSON.stringify(codes));
});

await run("unauthenticated analytics writers hit the analytics budget", async () => {
  const codes = await statuses(4, { method: "POST", url: "/api/mall/events", ip: "198.51.100.23", payload: { event_type: "view" } });
  assert.equal(codes.filter((c) => c === 429).length, 2, JSON.stringify(codes));
});

await run("addresses in one IPv6 /64 share a budget", async () => {
  const a = await statuses(3, { method: "POST", url: "/api/otp/request", ip: "2001:db8:7:7::1" });
  const b = await statuses(2, { method: "POST", url: "/api/otp/request", ip: "2001:db8:7:7::beef" });
  assert.deepEqual([...a, ...b].filter((c) => c === 429).length, 2, JSON.stringify([a, b]));
});

await app.close();
