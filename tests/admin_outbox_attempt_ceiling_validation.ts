// Black-Sky follow-ups — admin tooling judges "exhausted" exactly as the worker:
//   * requeue: a money event at attempt 5 of its 8-attempt lane budget CAN be
//     requeued (it was refused by LEAST(max_attempts, OUTBOX_MAX_ATTEMPTS||4));
//     an event at its lane ceiling still cannot; under the legacy policy the
//     historical LEAST(row, 4) ceiling is unchanged
//   * mission control: over_max_attempts uses each row's own max_attempts and
//     ignores rows that already succeeded
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";

process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.PORT = "3153";
process.env.ADMIN_API_KEY = `ceiling-${randomUUID().slice(0, 8)}`;
process.env.OUTBOX_RETRY_POLICY = "lane";
delete process.env.OUTBOX_MAX_ATTEMPTS;

const { app } = await import("../src/app.js");
const { pool } = await import("../src/db.js");
const { hashAdminPassword } = await import("../src/admin_identity.js");
const { outboxEffectiveMaxAttempts } = await import("../src/outbox_worker_helpers.js");
const { resolveOutboxRetryPolicyConfig } = await import("../src/runtime_config.js");

let failed = 0;
async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (e: any) { console.error(`FAIL ${name}: ${e?.stack || e?.message}`); failed++; }
}

await app.inject({ method: "GET", url: "/api/admin/auth/me" });
const email = `ceiling-${randomUUID().slice(0, 6)}@siton.local`;
await pool.query(
  `INSERT INTO siton.admin_users (email, display_name, role, status, password_hash, mfa_required, mfa_enabled)
   VALUES ($1,$1,'SuperAdmin','Active',$2,true,true)`,
  [email, await hashAdminPassword("CeilingPass123!")]
);
const login = await app.inject({ method: "POST", url: "/api/admin/auth/login", payload: { email, password: "CeilingPass123!" } });
const challenge = login.json() as any;
const verify = await app.inject({ method: "POST", url: "/api/admin/auth/mfa/verify", payload: { mfa_challenge_id: challenge.mfa_challenge_id, code: challenge.dev_code } });
assert.equal(verify.statusCode, 200, verify.body);
const ADMIN = { cookie: String(verify.headers["set-cookie"] || "").split(";")[0] || "", "x-admin-key": String(process.env.ADMIN_API_KEY) };

async function seedEvent(eventType: string, status: "failed" | "sent" | "pending", attempts: number, maxAttempts: number) {
  const r = await pool.query(
    `INSERT INTO siton.outbox_events (event_type, aggregate_type, aggregate_id, payload, status, attempt_count, max_attempts, available_at, sent, sent_at)
     VALUES ($1,'deal',$2,'{}'::jsonb,$3,$4,$5, now(), $6, CASE WHEN $6 THEN now() ELSE NULL END)
     RETURNING event_uuid::text AS id`,
    [eventType, randomUUID(), status, attempts, maxAttempts, status === "sent"]
  );
  return String(r.rows[0].id);
}

async function requeue(eventId: string) {
  const created = await app.inject({
    method: "POST", url: "/api/admin/actions", headers: ADMIN,
    payload: { action_type: "requeue_outbox_event", target_type: "outbox", target_id: eventId, reason: "operator retry", idempotency_key: `ceiling-${randomUUID()}` }
  });
  assert.equal(created.statusCode, 200, created.body);
  const actionId = (created.json() as any).action.admin_action_id;
  const executed = await app.inject({ method: "POST", url: `/api/admin/actions/${actionId}/execute`, headers: ADMIN, payload: {} });
  return { status: executed.statusCode, code: (executed.json() as any).action?.result_code as string };
}

await run("ceiling: lane mode uses the class budget; legacy keeps LEAST(row, OUTBOX_MAX_ATTEMPTS)", async () => {
  const lane = resolveOutboxRetryPolicyConfig({ OUTBOX_RETRY_POLICY: "lane" } as any);
  assert.equal(outboxEffectiveMaxAttempts("charge_deal", 4, lane), 8);
  assert.equal(outboxEffectiveMaxAttempts("notification_send", 4, lane), 6);
  const legacy = resolveOutboxRetryPolicyConfig({ OUTBOX_RETRY_POLICY: "legacy" } as any);
  assert.equal(outboxEffectiveMaxAttempts("charge_deal", 8, legacy), 4);
  assert.equal(outboxEffectiveMaxAttempts("charge_deal", 3, legacy), 3);
});

await run("requeue: a failed money event at attempt 5 of its 8-attempt lane budget is requeued (was refused at 4)", async () => {
  const id = await seedEvent("charge_deal", "failed", 5, 8);
  const out = await requeue(id);
  assert.equal(out.status, 200);
  assert.equal(out.code, "Requeued");
  const row = await pool.query(`SELECT status, attempt_count FROM siton.outbox_events WHERE event_uuid=$1`, [id]);
  assert.equal(row.rows[0].status, "pending");
  assert.equal(row.rows[0].attempt_count, 5, "history is not reset");
  const audit = await pool.query(`SELECT count(*)::int AS n FROM siton.operational_recovery_audit WHERE subject_id=$1 AND reason_code='admin_requeue'`, [id]);
  assert.equal(audit.rows[0].n, 1);
});

await run("requeue: an event AT its lane ceiling is still refused (no bypass)", async () => {
  const id = await seedEvent("charge_deal", "failed", 8, 8);
  const out = await requeue(id);
  assert.equal(out.status, 501);
  assert.equal(out.code, "NoEligibleOutboxEvent");
  const row = await pool.query(`SELECT status FROM siton.outbox_events WHERE event_uuid=$1`, [id]);
  assert.equal(row.rows[0].status, "failed");
});

await run("mission control: over_max_attempts uses the row's max_attempts and ignores succeeded rows", async () => {
  // measured as a delta: 5/8 failed (not over), 8/8 failed (over), 8/8 sent (not over)
  const before = await app.inject({ method: "GET", url: "/api/admin/mission-control", headers: ADMIN });
  assert.equal(before.statusCode, 200, before.body);
  const baseline = Number(JSON.stringify(before.json()).match(/"over_max_attempts":(\d+)/)?.[1] ?? 0);
  await seedEvent("refund_issue", "failed", 5, 8);
  await seedEvent("refund_issue", "failed", 8, 8);
  await seedEvent("refund_issue", "sent", 8, 8);
  const res = await app.inject({ method: "GET", url: "/api/admin/mission-control", headers: ADMIN });
  assert.equal(res.statusCode, 200, res.body);
  const found = JSON.stringify(res.json()).match(/"over_max_attempts":(\d+)/);
  assert.ok(found, "the outbox anomaly carries over_max_attempts evidence");
  assert.equal(Number(found![1]) - baseline, 1, "only the 8/8 failed row is over its ceiling (a hardcoded 4 counted all three)");
});

await app.close();
if (failed) process.exit(1);
console.log("PASS admin outbox attempt ceiling follows the worker's retry policy");
