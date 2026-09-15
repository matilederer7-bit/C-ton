#!/usr/bin/env node

const baseUrl = String(process.env.SITON_STAGING_URL || "https://siton-staging-web.onrender.com").replace(/\/+$/, "");
const timeoutMs = Math.max(1_000, Number(process.env.SITON_STAGING_REQUEST_TIMEOUT_MS || 15_000));
const attempts = Math.max(1, Number(process.env.SITON_STAGING_SMOKE_ATTEMPTS || 48));
const intervalMs = Math.max(1_000, Number(process.env.SITON_STAGING_SMOKE_INTERVAL_MS || 10_000));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function request(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "GET",
      redirect: "manual",
      headers: { "user-agent": "siton-hosted-staging-smoke/1" },
      signal: controller.signal,
      ...options
    });
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}
    return { status: response.status, text, json, headers: response.headers };
  } finally {
    clearTimeout(timer);
  }
}

async function waitForReadiness() {
  let last = "not attempted";
  for (let index = 1; index <= attempts; index += 1) {
    try {
      const response = await request("/readiness");
      const connected = response.status === 200 && response.json && response.json.database === "connected";
      if (connected) {
        console.log(`HOSTED_STAGING_READY attempt=${index} status=${response.status} database=connected`);
        return response;
      }
      last = `status=${response.status} body=${response.text.slice(0, 160)}`;
    } catch (error) {
      last = String(error instanceof Error ? error.message : error);
    }
    console.log(`HOSTED_STAGING_WAIT attempt=${index}/${attempts} reason=${JSON.stringify(last)}`);
    if (index < attempts) await sleep(intervalMs);
  }
  throw new Error(`staging readiness did not become healthy: ${last}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  console.log(`HOSTED_STAGING_SMOKE_START base=${baseUrl}`);
  console.log("HOSTED_STAGING_SMOKE_BOUNDARY method=GET money=false mutation=false credentials=false");

  await waitForReadiness();

  const health = await request("/health");
  assert(health.status === 200 && health.json?.ok === true, `/health expected 200 {ok:true}, got ${health.status} ${health.text.slice(0, 160)}`);
  console.log("HOSTED_STAGING_CHECK_PASS route=/health");

  const readiness = await request("/readiness");
  assert(readiness.status === 200 && readiness.json?.database === "connected", `/readiness expected connected database, got ${readiness.status} ${readiness.text.slice(0, 200)}`);
  console.log("HOSTED_STAGING_CHECK_PASS route=/readiness");

  const mall = await request("/api/mall/deals");
  assert(mall.status === 200 && mall.json !== null, `/api/mall/deals expected JSON 200, got ${mall.status} ${mall.text.slice(0, 200)}`);
  console.log("HOSTED_STAGING_CHECK_PASS route=/api/mall/deals");

  const home = await request("/api/site/home");
  assert(home.status === 200 && home.json !== null, `/api/site/home expected JSON 200, got ${home.status} ${home.text.slice(0, 200)}`);
  console.log("HOSTED_STAGING_CHECK_PASS route=/api/site/home");

  const integrations = await request("/health/integrations");
  assert(integrations.status === 200 && integrations.json !== null, `/health/integrations expected JSON 200, got ${integrations.status} ${integrations.text.slice(0, 200)}`);
  const payment = integrations.json?.integrations?.payment || integrations.json?.payment || null;
  const paymentMode = String(payment?.mode || payment?.environment || "unknown").toLowerCase();
  assert(!/(^|[-_])(live|production|real)([-_]|$)/.test(paymentMode), `staging payment integration unexpectedly reports live/production mode: ${paymentMode}`);
  console.log(`HOSTED_STAGING_CHECK_PASS route=/health/integrations payment_mode=${paymentMode}`);

  const root = await request("/");
  assert(root.status === 200, `/ expected 200, got ${root.status}`);
  assert(/text\/html/i.test(String(root.headers.get("content-type") || "")), `/ expected HTML content-type, got ${root.headers.get("content-type") || "missing"}`);
  console.log("HOSTED_STAGING_CHECK_PASS route=/ content_type=html");

  console.log("HOSTED_STAGING_SMOKE_PASS checks=6 database=connected real_money_probe=negative");
}

main().catch((error) => {
  console.error(`HOSTED_STAGING_SMOKE_FAIL ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
