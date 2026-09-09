#!/usr/bin/env node
// PILOT COMMUNICATIONS REHEARSAL — deterministic, disposable, ZERO external delivery.
//
// What it does
//   1. refuses anything that looks like a production / hosted database
//   2. creates a disposable local database, runs every migration + the test
//      prerequisite seed against it
//   3. runs the two real-runtime suites with the DRY-RUN notification provider:
//        tests/notification_pilot_events_validation.ts    (business events → queue)
//        tests/notification_pilot_rehearsal_validation.ts (worker, retry, reclaim,
//                                                          safety, operator view)
//   4. prints an operator report straight from the disposable database: what
//      WOULD have been sent (masked destination, subject, status, attempts,
//      reason, correlation), the status totals, and the hard invariants
//        REAL_EMAIL_SENT=0 REAL_SMS_SENT=0 REAL_NETWORK_DELIVERY=0
//   5. drops the disposable database (keep it with --keep)
//
// Usage
//   node scripts/pilot_communications_rehearsal.cjs [--keep] [--skip-compile]
//   DATABASE_URL must point at a LOCAL PostgreSQL (localhost / 127.0.0.1 / ::1).
//
// Nothing here can send anything: NOTIFICATION_PROVIDER_MODE=dry-run is forced,
// NOTIFICATION_DELIVERY_ENABLED is deleted from the environment, and the run
// fails if any attempt row was recorded in provider mode 'real'.

const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { Client } = require("pg");
require("dotenv").config({ quiet: true });

const args = new Set(process.argv.slice(2));
const KEEP = args.has("--keep");
const SKIP_COMPILE = args.has("--skip-compile");

function databaseUrl(base, databaseName) {
  const url = new URL(base);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function refuseNonDisposableTarget(base) {
  const parsed = new URL(base);
  const host = parsed.hostname.toLowerCase();
  const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(host);
  const hostedHint = /supabase|pooler|render|amazonaws|neon|heroku|azure|gcp|cloud/i.test(host);
  if (!local || hostedHint) {
    throw new Error(`REHEARSAL_REFUSED: DATABASE_URL host "${host}" is not a local disposable PostgreSQL. This rehearsal never runs against a hosted or production database.`);
  }
  const mode = String(process.env.APP_DEPLOYMENT_MODE || "").toLowerCase();
  if (["production", "prod", "commercial-live", "staging"].includes(mode)) {
    throw new Error(`REHEARSAL_REFUSED: APP_DEPLOYMENT_MODE=${mode} — the rehearsal only runs in a local demo/test runtime.`);
  }
  if (process.env.RENDER || process.env.RENDER_EXTERNAL_URL) {
    throw new Error("REHEARSAL_REFUSED: hosted platform environment detected (RENDER*).");
  }
}

function rehearsalEnv(overrides) {
  const env = {
    ...process.env,
    ...overrides,
    NODE_ENV: "test",
    APP_DEPLOYMENT_MODE: "demo-preview",
    DISABLE_OUTBOX_WORKER: "1",
    PAYMENT_PROVIDER: "mockpay",
    PAYMENT_PROVIDER_MODE: "mock-backed",
    PAYMENT_ENVIRONMENT: "demo",
    NOTIFICATION_PROVIDER: "log-only",
    NOTIFICATION_PROVIDER_MODE: "dry-run",
    PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL || "https://pilot.c-ton.test",
    ADMIN_ALERT_EMAIL: process.env.ADMIN_ALERT_EMAIL || "ops-alerts@siton.test"
  };
  // No switch that could ever authorize external delivery survives into the rehearsal.
  for (const key of ["NOTIFICATION_DELIVERY_ENABLED", "SMS_DELIVERY_ENABLED", "EMAIL_DELIVERY_ENABLED", "RENDER", "RENDER_EXTERNAL_URL", "APP_ENV"]) delete env[key];
  return env;
}

function step(label, command, commandArgs, env, timeout = 10 * 60_000) {
  console.log(`\nREHEARSAL_STEP ${label}`);
  const result = spawnSync(command, commandArgs, { stdio: "inherit", env, timeout });
  if (result.status !== 0) throw result.error || new Error(`${label} failed (exit ${result.status})`);
}

function mask(channel, value) {
  const raw = String(value || "");
  if (!raw) return "";
  if (channel === "sms") {
    const digits = raw.replace(/[^0-9+]/g, "");
    const normalized = /^05\d{8}$/.test(digits) ? `+972${digits.slice(1)}` : digits;
    return normalized.length <= 4 ? "***" : `${normalized.slice(0, Math.max(0, normalized.length - 7))}***${normalized.slice(-3)}`;
  }
  if (channel === "email") {
    const at = raw.indexOf("@");
    return at <= 0 ? "***" : `${raw.slice(0, 1)}***@${raw.slice(at + 1)}`;
  }
  return raw.slice(0, 40);
}

async function operatorReport(connectionString) {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const totals = await client.query(`SELECT status, count(*)::int AS n FROM siton.notification_events GROUP BY status ORDER BY status`);
    const byEvent = await client.query(
      `SELECT event_type, recipient_type, channel, status, count(*)::int AS n
       FROM siton.notification_events GROUP BY event_type, recipient_type, channel, status ORDER BY event_type, recipient_type, channel, status`
    );
    const sample = await client.query(
      `SELECT ne.event_type, ne.recipient_type, ne.channel, ne.recipient_ref, ne.status, ne.attempt_count, ne.last_error,
              ne.correlation_id, ne.payload_jsonb->>'deal_title' AS deal_title, ne.payload_jsonb->>'money_mode' AS money_mode,
              ne.payload_jsonb->>'link_mode' AS link_mode,
              (SELECT a.provider_message_id FROM siton.notification_attempts a WHERE a.notification_id = ne.notification_id ORDER BY a.attempt_id DESC LIMIT 1) AS last_message_id
       FROM siton.notification_events ne
       ORDER BY ne.created_at ASC`
    );
    const real = await client.query(`SELECT count(*)::int AS n FROM siton.notification_attempts WHERE provider_mode='real'`);
    const providers = await client.query(`SELECT provider, provider_mode, result_status, count(*)::int AS n FROM siton.notification_attempts GROUP BY provider, provider_mode, result_status ORDER BY provider, provider_mode, result_status`);

    console.log("\n================ PILOT COMMUNICATIONS — WHAT WOULD HAVE BEEN SENT ================");
    console.log("event_type                 | to     | channel  | destination         | status  | att | why / reason");
    console.log("---------------------------+--------+----------+---------------------+---------+-----+-------------------------------");
    for (const r of sample.rows) {
      const why = r.last_error ? String(r.last_error).slice(0, 60) : `${r.deal_title || ""}${r.money_mode ? ` [${r.money_mode}]` : ""}${r.link_mode && r.link_mode !== "tokenized" ? ` link=${r.link_mode}` : ""}`.slice(0, 60);
      console.log(
        `${String(r.event_type).padEnd(27)}| ${String(r.recipient_type).padEnd(7)}| ${String(r.channel).padEnd(9)}| ${mask(r.channel, r.recipient_ref).padEnd(20)}| ${String(r.status).padEnd(8)}| ${String(r.attempt_count).padEnd(4)}| ${why}`
      );
    }
    console.log("\nSTATUS_TOTALS " + totals.rows.map((r) => `${r.status}=${r.n}`).join(" "));
    console.log("BY_EVENT");
    for (const r of byEvent.rows) console.log(`  ${r.event_type} ${r.recipient_type}/${r.channel} ${r.status}=${r.n}`);
    console.log("ATTEMPTS_BY_PROVIDER");
    for (const r of providers.rows) console.log(`  ${r.provider} mode=${r.provider_mode} ${r.result_status}=${r.n}`);
    const realAttempts = Number(real.rows[0].n);
    console.log(`\nREAL_EMAIL_SENT=0 REAL_SMS_SENT=0 REAL_NETWORK_DELIVERY=0 real_mode_attempts=${realAttempts}`);
    if (realAttempts !== 0) throw new Error("REHEARSAL_INVARIANT_VIOLATED: an attempt ran in provider mode 'real'");
    return { totals: totals.rows, realAttempts };
  } finally {
    await client.end();
  }
}

async function main() {
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error("DATABASE_URL is required (local PostgreSQL)");
  refuseNonDisposableTarget(base);

  const admin = new Client({ connectionString: databaseUrl(base, "postgres"), connectionTimeoutMillis: 10_000 });
  await admin.connect();
  const name = `siton_comms_rehearsal_${process.pid}_${Date.now()}`;
  const target = databaseUrl(base, name);
  const quoted = `"${name.replace(/"/g, "\"\"")}"`;
  console.log(`REHEARSAL_DATABASE ${name} (disposable, local)`);
  try {
    await admin.query(`CREATE DATABASE ${quoted}`);
    const env = rehearsalEnv({ DATABASE_URL: target });
    if (!SKIP_COMPILE) step("compile", process.execPath, [require.resolve("typescript/bin/tsc"), "-p", "tsconfig.test.json"], env);
    step("migrate", process.execPath, ["scripts/run_migrations.cjs"], env);
    step("seed prerequisites", process.execPath, ["scripts/seed_test_prerequisites.cjs"], env);
    step("business events → queue", process.execPath, [path.join(".tmp_test_dist", "tests", "notification_pilot_events_validation.js")], { ...env, PORT: "3621" }, 5 * 60_000);
    step("worker / retry / reclaim / safety / operator view", process.execPath, [path.join(".tmp_test_dist", "tests", "notification_pilot_rehearsal_validation.js")], { ...env, PORT: "3622" }, 5 * 60_000);
    const report = await operatorReport(target);
    const failed = report.totals.find((r) => r.status === "failed");
    console.log(`\nPILOT_COMMUNICATIONS_REHEARSAL_PASS database=${name} kept=${KEEP} failed_rows=${failed ? failed.n : 0} (the rehearsal suite deliberately produces bounded 'failed'/'blocked' rows to prove terminal reasons)`);
  } finally {
    if (KEEP) console.log(`REHEARSAL_DATABASE_KEPT ${target}`);
    else await admin.query(`DROP DATABASE IF EXISTS ${quoted} WITH (FORCE)`).catch(() => undefined);
    await admin.end();
  }
}

main().catch((error) => {
  console.error(String(error && error.stack ? error.stack : error));
  process.exit(1);
});
