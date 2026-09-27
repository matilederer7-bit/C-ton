// Red-team finding A2 (Medium) regression: `trustProxy: true` resolved req.ip
// to the LEFT-most X-Forwarded-For value — the one the caller writes — so a
// header-rotating attacker chose its own rate-limit bucket. The app now trusts
// exactly TRUST_PROXY_HOPS hops (default 1, Render's single proxy layer): the
// client address is the one the outermost trusted proxy appended, and a
// caller-supplied prefix is ignored.
import { strict as assert } from "node:assert";

process.env.PORT = String(process.env.PORT || "3352");
process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.DISABLE_OUTBOX_WORKER = "1";
// Tight budgets so the bucket proof is short.
process.env.RATE_LIMIT_MAX = "4";
process.env.RATE_LIMIT_WINDOW_MS = "60000";
process.env.RATE_LIMIT_SENSITIVE_MAX = "50";
delete process.env.TRUST_PROXY_HOPS;

const { resolveTrustProxyHops, parseTrustProxyHops, DEFAULT_TRUST_PROXY_HOPS } = await import("../src/runtime_config.js");
const { assertProductionRuntimeGuards } = await import("../src/production_guards.js");
const { app } = await import("../src/app.js");

async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (error) { console.error(`FAIL ${name}`); throw error; }
}

await run("the hop resolver defaults to 1 and only accepts a small integer hop count", async () => {
  assert.equal(DEFAULT_TRUST_PROXY_HOPS, 1);
  assert.equal(resolveTrustProxyHops({}), 1);
  assert.equal(resolveTrustProxyHops({ TRUST_PROXY_HOPS: "" }), 1);
  assert.equal(resolveTrustProxyHops({ TRUST_PROXY_HOPS: "2" }), 2);
  assert.equal(resolveTrustProxyHops({ TRUST_PROXY_HOPS: "0" }), 0);
  // Boolean-style / unbounded values never widen trust: they fall back to 1.
  for (const bad of ["true", "all", "-1", "99", "1.5", "loopback"]) {
    assert.equal(parseTrustProxyHops(bad), null, bad);
    assert.equal(resolveTrustProxyHops({ TRUST_PROXY_HOPS: bad }), 1, bad);
  }
});

await run("a caller-supplied X-Forwarded-For prefix is ignored: the trusted hop's address wins", async () => {
  // Socket peer (hop 0) is the in-process injector; the ONE trusted proxy
  // appended "198.51.100.7"; "203.0.113.9" is the attacker's prefix.
  const res = await app.inject({ method: "GET", url: "/readiness", headers: { "x-forwarded-for": "203.0.113.9, 198.51.100.7" } });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as any;
  assert.equal(body.client_ip, "198.51.100.7", "client_ip must be the address the trusted proxy appended");
  assert.equal(body.trust_proxy_hops, 1);
  const single = await app.inject({ method: "GET", url: "/readiness", headers: { "x-forwarded-for": "198.51.100.8" } });
  assert.equal((single.json() as any).client_ip, "198.51.100.8");
});

await run("rotating a spoofed X-Forwarded-For prefix does NOT reset the per-IP budget", async () => {
  // Every request carries a different attacker prefix but the same trusted
  // hop address: they must all land in ONE bucket and trip the global limit.
  const realHop = "198.51.100.20";
  let limited = 0;
  for (let i = 0; i < 6; i++) {
    const res = await app.inject({ method: "GET", url: "/api/site/home", headers: { "x-forwarded-for": `10.99.${i}.${i + 1}, ${realHop}` } });
    if (res.statusCode === 429) limited += 1;
  }
  assert.ok(limited >= 2, `spoofed prefixes must share the bucket (limited=${limited})`);
  // Against the pre-fix `trustProxy: true` every prefix was a fresh bucket and
  // nothing above would ever be limited.
});

await run("the production guard rejects a boolean/unbounded TRUST_PROXY_HOPS", async () => {
  const base = { APP_DEPLOYMENT_MODE: "demo-preview" };
  assert.doesNotThrow(() => assertProductionRuntimeGuards("web", { ...base, TRUST_PROXY_HOPS: "1" }));
  assert.doesNotThrow(() => assertProductionRuntimeGuards("web", { ...base, TRUST_PROXY_HOPS: "0" }));
  assert.throws(() => assertProductionRuntimeGuards("web", { ...base, TRUST_PROXY_HOPS: "true" }), /TRUST_PROXY_HOPS must be an integer hop count/);
  assert.throws(() => assertProductionRuntimeGuards("web", { ...base, TRUST_PROXY_HOPS: "99" }), /TRUST_PROXY_HOPS must be an integer hop count/);
});

await app.close();
