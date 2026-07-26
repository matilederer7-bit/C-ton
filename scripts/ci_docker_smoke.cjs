const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { Client } = require("pg");

const compose = ["compose", "-p", "siton-ci-gate", "-f", "docker-compose.ci.yml"];
const artifacts = path.join(process.cwd(), ".ci-artifacts");
fs.mkdirSync(artifacts, { recursive: true });
function docker(args, options = {}) {
  const result = spawnSync("docker", [...compose, ...args], { encoding: "utf8", ...options });
  if (options.allowFailure !== true && result.status !== 0) throw new Error(result.stderr || result.stdout || `docker ${args.join(" ")} failed`);
  return result;
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, timeoutMs = 120000) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try { const value = await fn(); if (value) return value; } catch (error) { last = error; }
    await delay(1000);
  }
  throw last || new Error("smoke wait timed out");
}

async function requestJson(origin, pathname, options = {}) {
  const response = await fetch(`${origin}${pathname}`, options);
  const text = await response.text();
  let body; try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  return { response, body };
}

async function prepareHttpBuyer(origin, dealId, deliveryOptionId, index) {
  const phone = `0508${String(index).padStart(6, "0")}`;
  const headers = { "content-type": "application/json" };
  const start = await requestJson(origin, "/api/otp/start", { method: "POST", headers, body: JSON.stringify({ phone }) });
  if (!start.response.ok) throw new Error(`HTTP buyer OTP start ${index}: ${start.response.status}`);
  const verify = await requestJson(origin, "/api/otp/verify", { method: "POST", headers, body: JSON.stringify({ otp_session_id: start.body.otp_session_id, code: start.body.development_code }) });
  if (!verify.response.ok) throw new Error(`HTTP buyer OTP verify ${index}: ${verify.response.status}`);
  const auth = await requestJson(origin, "/api/payments/authorize-mock", { method: "POST", headers, body: JSON.stringify({ payer_name: `HTTP Buyer ${index}`, payment_method_id: `pm_http_stage4_${index}`, buyer_id: verify.body.buyer_id, deal_id: dealId, qty: 1, delivery_option_id: deliveryOptionId, otp_token: verify.body.otp_token, otp_challenge_id: verify.body.challenge_id || verify.body.otp_session_id }) });
  if (!auth.response.ok || auth.body.authorization !== "authorized") throw new Error(`HTTP buyer authorization ${index}: ${auth.response.status}`);
  return { buyer_id: verify.body.buyer_id, qty: 1, payment_disclosure_accepted: true, delivery_option_id: deliveryOptionId, delivery_address: "CI test address", delivery_city: "CI", otp_token: verify.body.otp_token, otp_challenge_id: verify.body.challenge_id || verify.body.otp_session_id, authorization_id: auth.body.authorization_id, authorization_provider: auth.body.provider, authorization_correlation_id: auth.body.correlation_id };
}

async function proveTwoWebLastUnitHttp(db) {
  const inserted = await db.query(`INSERT INTO siton.deals(title,price_per_unit,min_units,max_units,threshold_units,deadline,seller_id,state,published_at) VALUES ('CI HTTP last unit',100,1,1,1,now()+interval '3 hours','seller-default','PendingTarget',now()) RETURNING deal_id`);
  const dealId = inserted.rows[0].deal_id;
  const option = await db.query(`INSERT INTO siton.deal_delivery_options(deal_id,option_type,label,cost,sort_order) VALUES ($1,'delivery','CI delivery',20,0) RETURNING option_id`, [dealId]);
  const deliveryOptionId = option.rows[0].option_id;
  const origins = ["http://127.0.0.1:3001", "http://127.0.0.1:3002"];
  const publicRead = await requestJson(origins[0], `/api/deals/${dealId}/public`);
  if (!publicRead.response.ok || !publicRead.body.availability?.canJoin) throw new Error("HTTP race deal is not publicly readable");
  const buyers = await Promise.all(Array.from({ length: 100 }, (_, index) => prepareHttpBuyer(origins[index % 2], dealId, deliveryOptionId, index)));
  const startedAt = Date.now();
  const results = await Promise.all(buyers.map((buyer, index) => requestJson(origins[index % 2], `/deals/${dealId}/join`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": `http-stage4-${index}`, "x-request-id": `http-stage4-${index}` }, body: JSON.stringify(buyer) })));
  const success = results.filter((item) => item.response.status === 200);
  const inventory = results.filter((item) => item.response.status === 409 && item.body.code === "max_units_exceeded");
  const evidence = await db.query(`SELECT count(*)::int participants,coalesce(sum(qty),0)::int sold,(SELECT count(*)::int FROM siton.participant_tracking_tokens t WHERE t.deal_id=$1) tracking,(SELECT count(*)::int FROM siton.audit_log WHERE deal_id=$1 AND action_name='participant.join_authorize') audits,(SELECT count(*)::int FROM siton.notification_events WHERE deal_id=$1 AND event_type='buyer_joined_authorized') events FROM siton.participants WHERE deal_id=$1`, [dealId]);
  const row = evidence.rows[0];
  if (success.length !== 1 || inventory.length !== 99 || Number(row.participants) !== 1 || Number(row.sold) !== 1 || Number(row.tracking) !== 1 || Number(row.audits) !== 2 || Number(row.events) !== 1) throw new Error(`HTTP last-unit invariant failed: success=${success.length} inventory=${inventory.length} db=${JSON.stringify(row)}`);
  const winner = success[0].body;
  if (Number(winner.hold_total) !== 120 || !winner.tracking_access_token) throw new Error("HTTP buyer response does not match frontend money/tracking contract");
  const trackingPath = `/api/participants/${winner.participant_id}/tracking?t=${encodeURIComponent(winner.tracking_access_token)}`;
  const trackingBefore = await requestJson(origins[1], trackingPath);
  if (!trackingBefore.response.ok || trackingBefore.body.tracking?.money_state !== "AuthHeld") throw new Error("HTTP buyer tracking failed before restart");
  docker(["restart", "web"]);
  await waitFor(async () => (await fetch(`${origins[0]}/health`)).ok);
  const trackingAfter = await requestJson(origins[0], trackingPath);
  const refreshedDeal = await requestJson(origins[0], `/api/deals/${dealId}/public`);
  if (!trackingAfter.response.ok || trackingAfter.body.tracking?.money_state !== "AuthHeld" || Number(refreshedDeal.body.metrics?.remaining_units) !== 0) throw new Error("HTTP buyer persistence failed after Web restart");
  const report = { transport: "real HTTP", web_instances: 2, buyers: 100, success: 1, inventory_failures: 99, other_failures: 0, participants: 1, sold: 1, remaining: 0, audits: 2, outbox_events: 1, authorization_records: 1, hold_total: 120, tracking_restart: "pass", duration_ms: Date.now() - startedAt };
  console.log("HTTP_BUYER_LAST_UNIT_PASS", JSON.stringify(report));
  return report;
}
async function main() {
  if (spawnSync("docker", ["version"], { stdio: "ignore" }).status !== 0) throw new Error("Docker is required for ci:docker-smoke");
  docker(["down", "-v", "--remove-orphans"], { allowFailure: true });
  try {
    docker(["up", "--build", "-d", "--wait", "postgres", "migrate", "web", "web-secondary"]);
    await waitFor(async () => (await fetch("http://127.0.0.1:3001/health")).ok);
    const created = await fetch("http://127.0.0.1:3001/deals", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ seller_id: "seller-default", title: "CI outbox smoke", price_per_unit: 10, min_units: 2, max_units: 3, deadline: new Date(Date.now() + 3 * 3600000).toISOString() })
    });
    if (!created.ok) throw new Error(`deal create failed ${created.status}: ${await created.text()}`);
    const deal = await created.json();
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const upload = async (origin, filename, primary) => {
      const response = await fetch(`${origin}/api/seller/deals/${deal.deal_id}/images`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-seller-id": "seller-default" },
        body: JSON.stringify({ filename, mime_type: "image/png", image_base64: png, is_primary: primary })
      });
      if (response.status !== 201) throw new Error(`image upload failed ${response.status}: ${await response.text()}`);
      return response.json();
    };
    const [firstImage, secondImage] = await Promise.all([
      upload("http://127.0.0.1:3001", "same-name.png", true),
      upload("http://127.0.0.1:3002", "same-name.png", false)
    ]);
    if (firstImage.image.image_id === secondImage.image.image_id) throw new Error("multi-instance uploads collided");
    const firstRead = await fetch(`http://127.0.0.1:3002${firstImage.image.public_url}`);
    const secondRead = await fetch(`http://127.0.0.1:3001${secondImage.image.public_url}`);
    if (!firstRead.ok || !secondRead.ok) throw new Error("shared volume image read failed across web instances");
    const uid = docker(["exec", "-T", "web", "id", "-u"]);
    if (String(uid.stdout || "").trim() === "0") throw new Error("web container must run as non-root");
    docker(["restart", "web"]);
    await waitFor(async () => (await fetch("http://127.0.0.1:3001/health")).ok);
    if (!(await fetch(`http://127.0.0.1:3001${firstImage.image.public_url}`)).ok) throw new Error("uploaded image was lost after web restart");
    const published = await fetch(`http://127.0.0.1:3001/deals/${deal.deal_id}/publish`, {
      method: "POST", headers: { "content-type": "application/json", "idempotency-key": `ci-publish-${deal.deal_id}` },
      body: JSON.stringify({ seller_id: "seller-default", seller_terms_accepted: true, seller_critical_terms_accepted: true, seller_threshold_90_accepted: true })
    });
    if (!published.ok) throw new Error(`deal publish failed ${published.status}: ${await published.text()}`);

    const db = new Client({ connectionString: "postgresql://siton_ci:siton_ci_password@127.0.0.1:55432/siton_ci" });
    await db.connect();
    const buyerRaceReport = await proveTwoWebLastUnitHttp(db);
    await db.query("UPDATE siton.deals SET deadline=now()-interval '1 minute' WHERE deal_id=$1", [deal.deal_id]);
    await db.query("UPDATE siton.outbox_events SET available_at=now() WHERE aggregate_id=$1 AND event_type='deadline_check'", [deal.deal_id]);
    docker(["up", "-d", "--wait", "worker"]);
    const result = await waitFor(async () => {
      const row = await db.query("SELECT status, attempt_count FROM siton.outbox_events WHERE aggregate_id=$1 AND event_type='deadline_check'", [deal.deal_id]);
      return row.rows[0]?.status === "sent" ? row.rows[0] : null;
    });
    const heartbeat = await db.query("SELECT status FROM siton.worker_heartbeats WHERE worker_id='ci-worker' AND heartbeat_at>now()-interval '10 seconds'");
    const audits = await db.query("SELECT COUNT(*)::int AS count FROM siton.audit_log WHERE deal_id=$1 AND action_name='deal.deadline_check'", [deal.deal_id]);
    if (heartbeat.rowCount !== 1 || heartbeat.rows[0].status !== "ready") throw new Error("worker heartbeat is not ready");
    if (Number(result.attempt_count) !== 1) throw new Error("outbox job executed more than once");
    if (Number(audits.rows[0].count) !== 1) throw new Error("deadline effect was not exactly once");
    const metadata = await db.query("SELECT count(*)::int AS count, count(checksum_sha256)::int AS checksums FROM siton.deal_images WHERE deal_id=$1", [deal.deal_id]);
    if (Number(metadata.rows[0].count) !== 2 || Number(metadata.rows[0].checksums) !== 2) throw new Error("image metadata/checksum persistence failed");
    await db.end();
    const report = { buyer_flow_http: "pass", buyer_last_unit: buyerRaceReport, docker_build: "pass", web_health: "pass", upload_http: "pass", upload_restart: "pass", upload_multi_instance: "pass", web_non_root: "pass", worker_heartbeat: "pass", api_outbox_create: "pass", worker_consume: "pass", job_loss: false, double_execution: false };
    fs.writeFileSync(path.join(artifacts, "docker-smoke-report.json"), JSON.stringify(report, null, 2));
    console.log("CI_DOCKER_SMOKE_PASS", JSON.stringify(report));
  } finally {
    const logs = docker(["logs", "--no-color"], { allowFailure: true });
    fs.writeFileSync(path.join(artifacts, "docker-compose.log"), `${logs.stdout || ""}\n${logs.stderr || ""}`);
    docker(["down", "-v", "--remove-orphans"], { allowFailure: true });
  }
}
main().catch((error) => { console.error(error); process.exit(1); });
