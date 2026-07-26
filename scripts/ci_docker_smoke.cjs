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
    await db.query("UPDATE siton.deals SET deadline=now()-interval '1 minute' WHERE deal_id=$1", [deal.deal_id]);
    await db.query("UPDATE siton.outbox_events SET available_at=now() WHERE aggregate_id=$1 AND event_type='deadline_check'", [deal.deal_id]);
    docker(["up", "-d", "--wait", "worker"]);
    const result = await waitFor(async () => {
      const row = await db.query("SELECT status, attempt_count FROM siton.outbox_events WHERE aggregate_id=$1 AND event_type='deadline_check'", [deal.deal_id]);
      return row.rows[0]?.status === "sent" ? row.rows[0] : null;
    });
    const heartbeat = await db.query("SELECT status FROM siton.worker_heartbeats WHERE worker_id='ci-worker' AND heartbeat_at>now()-interval '10 seconds'");
    const audits = await db.query("SELECT COUNT(*)::int AS count FROM siton.audit_log WHERE deal_id=$1 AND action_name='deal.deadline_check'", [deal.deal_id]);
    await db.end();
    if (heartbeat.rowCount !== 1 || heartbeat.rows[0].status !== "ready") throw new Error("worker heartbeat is not ready");
    if (Number(result.attempt_count) !== 1) throw new Error("outbox job executed more than once");
    if (Number(audits.rows[0].count) !== 1) throw new Error("deadline effect was not exactly once");
    const metadata = await db.query("SELECT count(*)::int AS count, count(checksum_sha256)::int AS checksums FROM siton.deal_images WHERE deal_id=$1", [deal.deal_id]);
    if (Number(metadata.rows[0].count) !== 2 || Number(metadata.rows[0].checksums) !== 2) throw new Error("image metadata/checksum persistence failed");
    await db.end();
    const report = { docker_build: "pass", web_health: "pass", upload_http: "pass", upload_restart: "pass", upload_multi_instance: "pass", web_non_root: "pass", worker_heartbeat: "pass", api_outbox_create: "pass", worker_consume: "pass", job_loss: false, double_execution: false };
    fs.writeFileSync(path.join(artifacts, "docker-smoke-report.json"), JSON.stringify(report, null, 2));
    console.log("CI_DOCKER_SMOKE_PASS", JSON.stringify(report));
  } finally {
    const logs = docker(["logs", "--no-color"], { allowFailure: true });
    fs.writeFileSync(path.join(artifacts, "docker-compose.log"), `${logs.stdout || ""}\n${logs.stderr || ""}`);
    docker(["down", "-v", "--remove-orphans"], { allowFailure: true });
  }
}
main().catch((error) => { console.error(error); process.exit(1); });
