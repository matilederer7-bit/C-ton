const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { performance } = require("node:perf_hooks");
const { Client } = require("pg");

const baseUrl = process.env.WEB_BASE_URL || "http://127.0.0.1:3001";
const databaseUrl = process.env.WEB_RUNTIME_DATABASE_URL || "postgresql://siton_ci:siton_ci_password@127.0.0.1:55432/siton_ci";
const artifacts = path.join(process.cwd(), ".ci-artifacts");
fs.mkdirSync(artifacts, { recursive: true });

const report = {
  generated_at: new Date().toISOString(),
  base_url: baseUrl,
  scenarios: [],
  product_findings: [],
  metrics: {},
  counts: { passed: 0, failed: 0 }
};

function record(name, passed, details = {}) {
  report.scenarios.push({ name, passed, ...details });
  report.counts[passed ? "passed" : "failed"] += 1;
  if (!passed) report.product_findings.push({ name, ...details });
}

async function request(route, options = {}) {
  const started = performance.now();
  let response;
  let bodyText = "";
  try {
    response = await fetch(`${baseUrl}${route}`, {
      redirect: "manual",
      signal: AbortSignal.timeout(options.timeoutMs || 15000),
      ...options
    });
    bodyText = await response.text();
    let json = null;
    try { json = bodyText ? JSON.parse(bodyText) : null; } catch {}
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers),
      text: bodyText,
      json,
      duration_ms: Number((performance.now() - started).toFixed(2))
    };
  } catch (error) {
    return { status: 0, error: String(error), text: bodyText, duration_ms: Number((performance.now() - started).toFixed(2)) };
  }
}

const jsonHeaders = { "content-type": "application/json" };
const sellerHeaders = { ...jsonHeaders, "x-seller-id": "seller-default" };
const validUuid = "00000000-0000-4000-8000-000000000001";

async function createDeal(overrides = {}) {
  const response = await request("/deals", {
    method: "POST",
    headers: sellerHeaders,
    body: JSON.stringify({
      seller_id: "seller-default",
      title: "Web runtime probe",
      price_per_unit: 10,
      min_units: 1,
      max_units: 4,
      deadline: new Date(Date.now() + 3 * 3600000).toISOString(),
      ...overrides
    })
  });
  if (response.status !== 200 || !response.json?.deal_id) throw new Error(`create deal failed: ${JSON.stringify(response)}`);
  return response.json;
}

async function publishDeal(dealId) {
  return request(`/deals/${dealId}/publish`, {
    method: "POST",
    headers: { ...sellerHeaders, "idempotency-key": `publish-${dealId}` },
    body: JSON.stringify({
      seller_id: "seller-default",
      seller_terms_accepted: true,
      seller_critical_terms_accepted: true,
      seller_threshold_90_accepted: true
    })
  });
}

async function otpFor(dealId, phone) {
  const start = await request("/api/otp/start", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ phone, deal_id: dealId })
  });
  if (start.status !== 200 || !start.json?.development_code) throw new Error(`OTP start failed: ${JSON.stringify(start)}`);
  const verify = await request("/api/otp/verify", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      otp_session_id: start.json.otp_session_id,
      code: start.json.development_code
    })
  });
  if (verify.status !== 200 || !verify.json?.otp_token) throw new Error(`OTP verify failed: ${JSON.stringify(verify)}`);
  return { ...verify.json, code: start.json.development_code };
}

async function main() {
  const db = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 10000, query_timeout: 15000 });
  await db.connect();
  const initialConnections = await db.query("select count(*)::int count from pg_stat_activity where datname=current_database()");
  const initialDeals = await db.query("select count(*)::int count from siton.deals");

  const health = await request("/health", { headers: { "x-request-id": "probe-health", "x-correlation-id": "probe-correlation" } });
  record("health and correlation headers", health.status === 200 && health.headers["x-request-id"] === "probe-health" && health.headers["x-correlation-id"] === "probe-correlation", health);

  const malformed = await request("/deals", { method: "POST", headers: jsonHeaders, body: "{\"seller_id\":" });
  const afterMalformed = await db.query("select count(*)::int count from siton.deals");
  record("malformed JSON rejected without mutation", malformed.status === 400 && afterMalformed.rows[0].count === initialDeals.rows[0].count && !/stack|at\s+\w+/i.test(malformed.text), malformed);

  const missingBody = await request("/deals", { method: "POST", headers: jsonHeaders, body: "{}" });
  record("missing required body rejected", missingBody.status >= 400 && missingBody.status < 500 && !/stack|at\s+\w+/i.test(missingBody.text), missingBody);

  const wrongType = await request("/deals", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" });
  record("wrong content type rejected", wrongType.status === 400 || wrongType.status === 415, wrongType);

  const oversized = await request("/deals", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ padding: "x".repeat(1_100_000) })
  });
  record("oversized payload rejected", oversized.status === 413, { status: oversized.status, duration_ms: oversized.duration_ms });

  const invalidId = await request("/deals/not-a-uuid/publish", { method: "POST", headers: sellerHeaders, body: "{}" });
  record("invalid identifier rejected", invalidId.status === 400 && !/stack|at\s+\w+/i.test(invalidId.text), invalidId);

  const missingRoute = await request("/api/definitely-not-a-route");
  record("unknown route returns 404", missingRoute.status === 404 && !/stack|at\s+\w+/i.test(missingRoute.text), missingRoute);
  const wrongMethod = await request("/health", { method: "POST", headers: jsonHeaders, body: "{}" });
  record("unsupported method rejected", wrongMethod.status === 404 || wrongMethod.status === 405, wrongMethod);

  for (const adminPath of ["/api/admin/overview", "/api/admin/system-status", "/api/admin/actions", "/api/admin/storage/orphan-report"]) {
    const response = await request(adminPath);
    record(`admin unauthorized ${adminPath}`, response.status === 401 || response.status === 403, response);
  }

  const draft = await createDeal();
  const otherSeller = await request(`/api/seller/deals/${draft.deal_id}`, { headers: { "x-seller-id": "seller-other" } });
  record("seller cannot read another seller deal", otherSeller.status === 403 || otherSeller.status === 404, otherSeller);

  const tinyPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const upload = await request(`/api/seller/deals/${draft.deal_id}/images`, {
    method: "POST", headers: sellerHeaders,
    body: JSON.stringify({ filename: "בדיקה.png", mime_type: "image/png", image_base64: tinyPng })
  });
  record("valid unicode image upload commits before 201", upload.status === 201 && Boolean(upload.json?.image?.image_id) && !String(upload.json?.image?.public_url || "").includes(process.cwd()), upload);
  const fakeMime = await request(`/api/seller/deals/${draft.deal_id}/images`, {
    method: "POST", headers: sellerHeaders,
    body: JSON.stringify({ filename: "evil.exe", mime_type: "application/x-msdownload", image_base64: tinyPng })
  });
  record("dangerous extension and MIME rejected", fakeMime.status === 400 || fakeMime.status === 415, fakeMime);
  const emptyUpload = await request(`/api/seller/deals/${draft.deal_id}/images`, {
    method: "POST", headers: sellerHeaders, body: JSON.stringify({ filename: "empty.png", mime_type: "image/png", image_base64: "" })
  });
  record("empty upload rejected", emptyUpload.status === 400, emptyUpload);

  const published = await publishDeal(draft.deal_id);
  record("seller publish over real HTTP", published.status === 200, published);
  const publicDeal = await request(`/api/deals/${draft.deal_id}/public`);
  record("public deal read over real HTTP", publicDeal.status === 200 && publicDeal.json?.deal?.deal_id === draft.deal_id, publicDeal);

  const otp = await otpFor(draft.deal_id, "0507000001");
  const replayOtp = await request("/api/otp/verify", {
    method: "POST", headers: jsonHeaders,
    body: JSON.stringify({ otp_session_id: otp.otp_session_id, code: otp.code })
  });
  record("OTP replay rejected", replayOtp.status === 409 || replayOtp.status === 400, replayOtp);

  const idemKey = `probe-join-${draft.deal_id}`;
  const joinBody = {
    buyer_id: otp.buyer_id,
    qty: 1,
    otp_token: otp.otp_token,
    otp_challenge_id: otp.otp_session_id,
    payment_disclosure_accepted: true
  };
  const joins = await Promise.all(Array.from({ length: 100 }, (_, index) =>
    request(`/deals/${draft.deal_id}/join`, {
      method: "POST",
      headers: { ...jsonHeaders, "idempotency-key": idemKey, "x-forwarded-for": `10.20.${Math.floor(index / 250)}.${index + 1}` },
      body: JSON.stringify(joinBody),
      timeoutMs: 30000
    })
  ));
  const joinIds = new Set(joins.filter((item) => item.status === 200).map((item) => item.json?.participant_id));
  record("100 requests with one idempotency key", joins.every((item) => item.status === 200) && joinIds.size === 1, {
    statuses: joins.reduce((map, item) => { map[item.status] = (map[item.status] || 0) + 1; return map; }, {}),
    participant_ids: [...joinIds]
  });

  const publicLatencies = [];
  const publicReads = await Promise.all(Array.from({ length: 100 }, async () => {
    const response = await request(`/api/deals/${draft.deal_id}/public`, { timeoutMs: 30000 });
    publicLatencies.push(response.duration_ms);
    return response;
  }));
  publicLatencies.sort((a, b) => a - b);
  const percentile = (p) => publicLatencies[Math.min(publicLatencies.length - 1, Math.ceil(publicLatencies.length * p) - 1)];
  report.metrics.public_read_100 = {
    median_ms: percentile(0.5),
    p95_ms: percentile(0.95),
    p99_ms: percentile(0.99),
    error_rate: publicReads.filter((item) => item.status !== 200).length / publicReads.length
  };
  record("100 concurrent public deal readers", publicReads.every((item) => item.status === 200), report.metrics.public_read_100);

  const affiliate = await request("/api/affiliate/overview");
  const affiliateText = JSON.stringify(affiliate.json || {});
  record("distributor aggregate surface excludes PII and balances", affiliate.status === 200 && !/(buyer_phone|buyer_email|commission|balance|payout)/i.test(affiliateText), { status: affiliate.status });

  const mockAuthorize = await request("/api/payments/authorize-mock", { method: "POST", headers: jsonHeaders, body: "{}" });
  record("mock payment route remains registered in non-production runtime", mockAuthorize.status !== 404, { status: mockAuthorize.status, informational: true });

  await new Promise((resolve) => {
    const target = new URL(`${baseUrl}/deals`);
    const req = http.request({
      hostname: target.hostname, port: target.port, path: target.pathname, method: "POST",
      headers: { "content-type": "application/json", "content-length": "100000" }
    });
    req.on("error", () => resolve());
    req.write("{\"seller_id\":\"seller-default\",\"padding\":\"");
    req.destroy();
    setTimeout(resolve, 100);
  });
  await new Promise((resolve) => setTimeout(resolve, 250));
  const afterDisconnect = await request("/health");
  record("client disconnect does not crash web", afterDisconnect.status === 200, afterDisconnect);

  const connections = await db.query("select count(*)::int count from pg_stat_activity where datname=current_database()");
  const openTransactions = await db.query("select count(*)::int count from pg_stat_activity where datname=current_database() and state='idle in transaction'");
  report.metrics.database = {
    connections_before: initialConnections.rows[0].count,
    connections_after: connections.rows[0].count,
    idle_in_transaction: openTransactions.rows[0].count
  };
  record("no idle transactions or material connection leak", openTransactions.rows[0].count === 0 && connections.rows[0].count <= initialConnections.rows[0].count + 12, report.metrics.database);

  await db.end();
  fs.writeFileSync(path.join(artifacts, "web-runtime-http-report.json"), JSON.stringify(report, null, 2));
  console.log("WEB_RUNTIME_HTTP_FINDINGS", JSON.stringify(report.product_findings));
  console.log("WEB_RUNTIME_HTTP_PROBE_COMPLETE", JSON.stringify({
    passed: report.counts.passed,
    findings: report.counts.failed,
    metrics: report.metrics
  }));
}

main().catch((error) => {
  report.infrastructure_error = String(error?.stack || error);
  fs.writeFileSync(path.join(artifacts, "web-runtime-http-report.json"), JSON.stringify(report, null, 2));
  console.error(error);
  process.exit(1);
});
