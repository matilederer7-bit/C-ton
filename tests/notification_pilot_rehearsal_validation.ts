// PILOT COMMUNICATIONS — dry-run delivery + reliability + safety rehearsal.
//
// The REAL rail (enqueue → Worker claim → safety gate → template render →
// attempt row → status) runs with the dry-run provider: ZERO external network
// delivery, every outcome durable and inspectable. Proves:
//   * dry-run provider: valid destinations → 'sent' with a deterministic
//     provider message id; blocked destinations never reach a provider
//   * bounded retries (temporary failure → backoff → terminal failed at max),
//     crash reclaim of a stranded 'processing' row followed by a successful
//     retry, permanent failure with a visible reason, duplicate enqueue → one row
//   * safety negative controls: invalid e-mail / phone, empty recipient, buyer
//     phone on the e-mail channel (swapped recipient), non-allowlisted real-mode
//     simulation, production synthetic domain, secret-like payload, redaction
//   * fail-closed construction: real mode without an adapter cannot boot; the
//     delivery master switch without real mode fails the production guards
//   * operator read model: counts (pending/processing/sent/blocked/failed/
//     retry scheduled) and one-notification inspection with masked destination
//     and redacted body
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.ADMIN_API_KEY = "pilot-rehearsal-admin-key";
process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.NOTIFICATION_PROVIDER = "log-only";
process.env.NOTIFICATION_PROVIDER_MODE = "dry-run";
process.env.NOTIFICATION_MAX_ATTEMPTS = "3";
process.env.PUBLIC_BASE_URL = "https://pilot.c-ton.test";
process.env.PORT = process.env.PORT || "3612";

const { app } = await import("../src/app.js");
const { pool } = await import("../src/db.js");
const dispatch = await import("../src/notification_dispatch.js");
const safety = await import("../src/notification_safety.js");
const { assertProductionRuntimeGuards } = await import("../src/production_guards.js");
const {
  buildNotificationProvider, enqueueNotification, flushPendingNotifications, reclaimStrandedNotifications,
  getNotificationProviderSummary, DryRunNotificationProvider, NotificationValidationError
} = dispatch;

const ADMIN = { "x-admin-key": "pilot-rehearsal-admin-key" };
let passed = 0;
let failed = 0;
async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`PASS ${name}`); passed++; }
  catch (e: any) { console.error(`FAIL ${name}: ${e?.stack || e?.message || e}`); failed++; }
}

const RUN = randomUUID().slice(0, 8);
async function enqueue(args: { channel: "sms" | "email" | "internal"; recipient: string; suffix: string; event?: string }) {
  const dealId = randomUUID();
  const key = `rehearsal-${args.suffix}-${RUN}`;
  const result = await enqueueNotification({
    event_type: (args.event || "buyer_deal_target_reached") as any,
    recipient_type: "buyer",
    recipient_ref: args.recipient,
    deal_id: dealId,
    channel: args.channel,
    payload_jsonb: { deal_id: dealId, deal_title: `חזרה ${args.suffix}`, money_mode: "mock", tracking_url: `https://pilot.c-ton.test/preview/#/track/${dealId}?t=TOKEN${RUN}` },
    idempotency_key: key,
    correlation_id: `corr-${args.suffix}-${RUN}`
  }, pool);
  const row = await pool.query(`SELECT notification_id FROM siton.notification_events WHERE idempotency_key=$1`, [key]);
  return { result, key, id: String(row.rows[0].notification_id) };
}
async function row(id: string) {
  const r = await pool.query(
    `SELECT n.status, n.attempt_count, n.last_error, n.scheduled_for, n.processing_started_at, n.sent_at,
            (SELECT count(*)::int FROM siton.notification_attempts a WHERE a.notification_id=n.notification_id) AS attempts,
            (SELECT json_agg(json_build_object('provider', a.provider, 'mode', a.provider_mode, 'status', a.result_status, 'mid', a.provider_message_id, 'code', a.error_code) ORDER BY a.attempt_id)
               FROM siton.notification_attempts a WHERE a.notification_id=n.notification_id) AS attempt_rows
     FROM siton.notification_events n WHERE n.notification_id=$1`, [id]);
  return r.rows[0];
}
async function flush(provider = buildNotificationProvider(process.env)) {
  // Only OUR rows: make them the oldest so a 20-row batch always includes them.
  await pool.query(`UPDATE siton.notification_events SET created_at = created_at - interval '1 day' WHERE idempotency_key LIKE $1 AND status='pending'`, [`rehearsal-%-${RUN}`]);
  return flushPendingNotifications(pool, provider, { error: () => undefined });
}

// ── R1 provider construction ─────────────────────────────────────────────────
await run("R1 dry-run provider is selected by NOTIFICATION_PROVIDER_MODE=dry-run, reports external_delivery=false; real mode still fails closed", async () => {
  const provider = buildNotificationProvider({ NOTIFICATION_PROVIDER: "log-only", NOTIFICATION_PROVIDER_MODE: "dry-run" } as NodeJS.ProcessEnv);
  assert.ok(provider instanceof DryRunNotificationProvider);
  assert.equal(provider.providerCode, "dry-run");
  assert.equal(provider.mode, "dry-run");
  assert.deepEqual(getNotificationProviderSummary(provider), { provider: "dry-run", mode: "dry-run", external_delivery: false });
  assert.throws(() => buildNotificationProvider({ NOTIFICATION_PROVIDER_MODE: "real", NOTIFICATION_PROVIDER: "resend" } as NodeJS.ProcessEnv), /requires a verified real notification adapter/);
  assert.equal(buildNotificationProvider({ NOTIFICATION_PROVIDER_MODE: "disabled" } as NodeJS.ProcessEnv).mode, "disabled");
  assert.equal(buildNotificationProvider({} as NodeJS.ProcessEnv).providerCode, "log");
  // The delivery master switch without a real adapter fails the boot guards (web and worker).
  for (const role of ["web", "worker"] as const) {
    assert.throws(
      () => assertProductionRuntimeGuards(role, { APP_DEPLOYMENT_MODE: "staging", NOTIFICATION_DELIVERY_ENABLED: "1", NOTIFICATION_PROVIDER_MODE: "dry-run", NOTIFICATION_PROVIDER: "log-only" } as NodeJS.ProcessEnv),
      /NOTIFICATION_DELIVERY_ENABLED=1 requires NOTIFICATION_PROVIDER_MODE=real/
    );
  }
});

// ── R2 dry-run send ──────────────────────────────────────────────────────────
await run("R2 valid sms / e-mail / internal destinations drain to 'sent' through the dry-run provider with deterministic dryrun_ message ids and dry-run attempt rows", async () => {
  const sms = await enqueue({ channel: "sms", recipient: "0501234567", suffix: "sms" });
  const email = await enqueue({ channel: "email", recipient: "buyer@siton.test", suffix: "email" });
  const internal = await enqueue({ channel: "internal", recipient: "seller-x", suffix: "internal", event: "seller_target_reached" });
  await enqueueNotification({ event_type: "seller_target_reached", recipient_type: "seller", recipient_ref: "seller-x", channel: "internal", deal_id: randomUUID(), seller_id: "seller-x", payload_jsonb: { deal_id: "d", deal_title: "t" }, idempotency_key: `rehearsal-internal2-${RUN}` }, pool).catch(() => undefined);
  await flush();
  for (const item of [sms, email, internal]) {
    const r = await row(item.id);
    assert.equal(r.status, "sent", `${item.key}: ${r.last_error}`);
    assert.equal(Number(r.attempt_count), 1);
    assert.equal(r.attempts, 1);
    assert.equal(r.attempt_rows[0].provider, "dry-run");
    assert.equal(r.attempt_rows[0].mode, "dry-run");
    assert.match(String(r.attempt_rows[0].mid), /^dryrun_[0-9a-f]{24}$/);
  }
  const provider = new DryRunNotificationProvider({ info: () => undefined });
  const sample = { notification_id: sms.id, event_type: "buyer_deal_target_reached" as const, recipient_type: "buyer" as const, recipient_ref: "0501234567", channel: "sms" as const, template_key: "buyer_deal_target_reached_he" as const, payload_jsonb: { deal_title: "x" } };
  const a = await provider.send(sample);
  const b = await provider.send(sample);
  assert.equal(a.provider_message_id, b.provider_message_id, "deterministic id per notification");
  const r = await row(sms.id);
  assert.equal(r.attempt_rows[0].mid, a.provider_message_id, "the recorded attempt carries the same deterministic id");
});

// ── R3 blocked destinations ──────────────────────────────────────────────────
await run("R3 dry-run blocks structurally bad destinations BEFORE any provider call: invalid phone, invalid e-mail, empty recipient, buyer phone on the e-mail channel", async () => {
  const cases = [
    { channel: "sms" as const, recipient: "buyer-abc", suffix: "badphone", reason: "recipient_invalid_format" },
    { channel: "sms" as const, recipient: "123", suffix: "shortphone", reason: "recipient_invalid_format" },
    { channel: "email" as const, recipient: "not-an-email", suffix: "bademail", reason: "recipient_invalid_format" },
    { channel: "email" as const, recipient: "0501234567", suffix: "swapped", reason: "recipient_invalid_format" },
    { channel: "sms" as const, recipient: "", suffix: "empty", reason: "recipient_missing" }
  ];
  const items = [];
  for (const c of cases) items.push({ ...c, ...(await enqueue({ channel: c.channel, recipient: c.recipient, suffix: c.suffix })) });
  let providerCalls = 0;
  const spy = { providerCode: "spy", mode: "dry-run" as const, async send() { providerCalls += 1; return { status: "success" as const, provider_message_id: "never" }; } };
  await flush(spy);
  for (const item of items) {
    const r = await row(item.id);
    assert.equal(r.status, "blocked", `${item.suffix}: ${r.status} ${r.last_error}`);
    assert.match(String(r.last_error), new RegExp(`blocked_by_recipient_safety: ${item.reason}`));
    assert.equal(r.attempts, 1);
    assert.equal(r.attempt_rows[0].code, "blocked_by_recipient_safety");
    assert.equal(r.attempt_rows[0].status, "skipped");
  }
  assert.equal(providerCalls, 0, "a blocked destination never reaches a provider");
});

// ── R4 bounded retries ───────────────────────────────────────────────────────
let retryId = "";
await run("R4 provider temporary failure: backoff is scheduled, retries are bounded, the row terminates 'failed' with max_attempts_exhausted and one attempt row per provider call", async () => {
  const item = await enqueue({ channel: "sms", recipient: "0501234568", suffix: "flaky" });
  retryId = item.id;
  const flaky = { providerCode: "flaky", mode: "dry-run" as const, async send() { return { status: "temporary_fail" as const, error_code: "provider_unavailable", error_message: "synthetic 503" }; } };
  await flush(flaky);
  let r = await row(item.id);
  assert.equal(r.status, "pending", "first temporary failure keeps the row pending");
  assert.equal(Number(r.attempt_count), 1);
  assert.ok(new Date(r.scheduled_for).getTime() > Date.now(), "retry is scheduled in the future (backoff)");
  const status = await app.inject({ method: "GET", url: "/api/admin/notifications-status", headers: ADMIN });
  assert.equal(status.statusCode, 200, status.body);
  assert.ok((status.json() as any).notifications.retry_scheduled >= 1, "operator sees the scheduled retry");
  for (let round = 0; round < 2; round += 1) {
    await pool.query(`UPDATE siton.notification_events SET scheduled_for=NULL WHERE notification_id=$1 AND status='pending'`, [item.id]);
    await flush(flaky);
  }
  r = await row(item.id);
  assert.equal(r.status, "failed");
  assert.equal(Number(r.attempt_count), 3);
  assert.equal(r.attempts, 3, "one durable attempt per provider I/O");
  assert.match(String(r.last_error), /max_attempts_exhausted \(3\)/);
  await flush(flaky);
  r = await row(item.id);
  assert.equal(r.attempts, 3, "a failed row is never retried again by the worker");
});

// ── R5 crash reclaim ─────────────────────────────────────────────────────────
await run("R5 a Worker that dies mid-flight leaves 'processing'; reclaim counts the attempt, re-queues, and the next flush succeeds — exactly one 'sent'", async () => {
  const item = await enqueue({ channel: "email", recipient: "crash@siton.test", suffix: "crash" });
  await pool.query(`UPDATE siton.notification_events SET status='processing', processing_started_at=now() - interval '20 minutes' WHERE notification_id=$1`, [item.id]);
  const untouched = await reclaimStrandedNotifications(pool, 60 * 60_000);
  assert.equal((await row(item.id)).status, "processing", `a young claim is not reclaimed (${untouched})`);
  const reclaimed = await reclaimStrandedNotifications(pool, 5 * 60_000);
  assert.ok(reclaimed >= 1);
  let r = await row(item.id);
  assert.equal(r.status, "pending");
  assert.equal(Number(r.attempt_count), 1);
  assert.match(String(r.last_error), /reclaimed_after_processing_timeout/);
  await pool.query(`UPDATE siton.notification_events SET scheduled_for=NULL WHERE notification_id=$1`, [item.id]);
  await flush();
  r = await row(item.id);
  assert.equal(r.status, "sent");
  assert.equal(Number(r.attempt_count), 2);
  assert.equal(r.attempts, 1, "the stranded attempt had no durable provider row; the retry has exactly one");
  const sentRows = await pool.query(`SELECT count(*)::int AS n FROM siton.notification_attempts WHERE notification_id=$1 AND result_status='success'`, [item.id]);
  assert.equal(sentRows.rows[0].n, 1);
});

// ── R6 permanent failure ─────────────────────────────────────────────────────
await run("R6 provider permanent failure → 'failed' at once with a visible reason; a thrown adapter error counts as temporary", async () => {
  const item = await enqueue({ channel: "sms", recipient: "0501234569", suffix: "perm" });
  const dead = { providerCode: "dead", mode: "dry-run" as const, async send() { return { status: "permanent_fail" as const, error_code: "invalid_destination", error_message: "provider rejected destination" }; } };
  await flush(dead);
  const r = await row(item.id);
  assert.equal(r.status, "failed");
  assert.equal(Number(r.attempt_count), 1);
  assert.match(String(r.last_error), /provider rejected destination/);
  const thrower = await enqueue({ channel: "sms", recipient: "0501234570", suffix: "throw" });
  const boom = { providerCode: "boom", mode: "dry-run" as const, async send(): Promise<any> { throw new Error("socket hang up to +972501234570"); } };
  await flush(boom);
  const t = await row(thrower.id);
  assert.equal(t.status, "pending", "an adapter exception is a temporary failure");
  assert.equal(t.attempt_rows[0].code, "provider_exception");
  const attemptText = await pool.query(`SELECT error_message FROM siton.notification_attempts WHERE notification_id=$1`, [thrower.id]);
  assert.ok(!String(attemptText.rows[0].error_message).includes("+972501234570"), "attempt errors are redacted");
});

// ── R7 duplicate enqueue ─────────────────────────────────────────────────────
await run("R7 the same idempotency key enqueued twice (and concurrently ×10) is one row", async () => {
  const key = `rehearsal-dup-${RUN}`;
  const input = { event_type: "buyer_deal_completed" as const, recipient_type: "buyer" as const, recipient_ref: "0501234571", channel: "sms" as const, deal_id: randomUUID(), payload_jsonb: { deal_title: "x", money_mode: "mock" }, idempotency_key: key };
  assert.equal(await enqueueNotification(input, pool), "queued");
  assert.equal(await enqueueNotification(input, pool), "duplicate");
  const results = await Promise.all(Array.from({ length: 10 }, () => enqueueNotification({ ...input, idempotency_key: `${key}-race` }, pool)));
  assert.equal(results.filter((r) => r === "queued").length, 1);
  assert.equal(results.filter((r) => r === "duplicate").length, 9);
  const n = await pool.query(`SELECT count(*)::int AS n FROM siton.notification_events WHERE idempotency_key IN ($1,$2)`, [key, `${key}-race`]);
  assert.equal(n.rows[0].n, 2);
});

// ── R8 safety negative controls (pure) ──────────────────────────────────────
await run("R8 real-mode simulation: master switch off, channel switch off, not allowlisted, invalid format, synthetic production domain are all blocked; allowlisted passes; dry-run shadow verdict explains it", async () => {
  const base = { channel: "sms", recipient: "0501234567" };
  const off = safety.evaluateNotificationRecipientSafety({ ...base, providerMode: "real", env: {} as NodeJS.ProcessEnv });
  assert.deepEqual(off, { allowed: false, reason: "delivery_master_switch_off" });
  const channelOff = safety.evaluateNotificationRecipientSafety({ ...base, providerMode: "real", env: { NOTIFICATION_DELIVERY_ENABLED: "1" } as NodeJS.ProcessEnv });
  assert.equal(channelOff.reason, "channel_switch_off:SMS_DELIVERY_ENABLED");
  const staging = { APP_DEPLOYMENT_MODE: "staging", NOTIFICATION_DELIVERY_ENABLED: "1", SMS_DELIVERY_ENABLED: "1", EMAIL_DELIVERY_ENABLED: "1" } as NodeJS.ProcessEnv;
  assert.equal(safety.evaluateNotificationRecipientSafety({ ...base, providerMode: "real", env: staging }).reason, "staging_recipient_not_allowlisted");
  assert.equal(safety.evaluateNotificationRecipientSafety({ ...base, providerMode: "real", env: { ...staging, NOTIFICATION_RECIPIENT_ALLOWLIST: "+972501234567" } }).reason, "staging_allowlisted_recipient");
  assert.equal(safety.evaluateNotificationRecipientSafety({ channel: "sms", recipient: "buyer-abc", providerMode: "real", env: { ...staging, NOTIFICATION_RECIPIENT_ALLOWLIST: "buyer-abc" } }).reason, "recipient_invalid_format", "an allowlisted garbage value is still not a destination");
  assert.equal(safety.evaluateNotificationRecipientSafety({ channel: "email", recipient: "0501234567", providerMode: "real", env: { ...staging, NOTIFICATION_RECIPIENT_ALLOWLIST: "0501234567" } }).reason, "recipient_invalid_format", "a phone on the e-mail channel is blocked");
  const production = { APP_DEPLOYMENT_MODE: "production", NOTIFICATION_DELIVERY_ENABLED: "1", EMAIL_DELIVERY_ENABLED: "1", SMS_DELIVERY_ENABLED: "1" } as NodeJS.ProcessEnv;
  assert.equal(safety.evaluateNotificationRecipientSafety({ channel: "email", recipient: "someone@siton.test", providerMode: "real", env: production }).reason, "production_synthetic_domain_blocked");
  assert.equal(safety.evaluateNotificationRecipientSafety({ channel: "email", recipient: "someone@example.com", providerMode: "real", env: production }).reason, "production_synthetic_domain_blocked");
  assert.equal(safety.evaluateNotificationRecipientSafety({ channel: "sms", recipient: "0501234567", providerMode: "real", env: { ...production, NOTIFICATION_SYNTHETIC_RECIPIENTS: "+972501234567" } }).reason, "production_synthetic_recipient_blocked");
  assert.equal(safety.evaluateNotificationRecipientSafety({ channel: "sms", recipient: "0501234567", providerMode: "real", env: production }).reason, "production_recipient_allowed");
  assert.equal(safety.evaluateNotificationRecipientSafety({ channel: "internal", recipient: "", providerMode: "real", env: {} as NodeJS.ProcessEnv }).allowed, true);
  const explained = safety.explainNotificationRecipientSafety({ ...base, providerMode: "dry-run", env: staging });
  assert.equal(explained.current.reason, "dry_run_no_external_delivery");
  assert.equal(explained.real_mode_shadow.reason, "staging_recipient_not_allowlisted");
  assert.equal(explained.recipient_format_valid, true);
  assert.equal(safety.isValidNotificationRecipientFormat("sms", "+972-50-123-4567"), true);
  assert.equal(safety.isValidNotificationRecipientFormat("sms", "+0501234567"), false);
  assert.equal(safety.isValidNotificationRecipientFormat("email", `${"a".repeat(200)}@x.co`), false);
});

// ── R9 redaction and masking (pure) ─────────────────────────────────────────
await run("R9 masking and redaction never expose a destination or a link credential", async () => {
  assert.equal(safety.maskNotificationRecipient("sms", "0501234567"), "+97250***567");
  assert.equal(safety.maskNotificationRecipient("sms", "+14155550123"), "+1415***123");
  assert.equal(safety.maskNotificationRecipient("email", "mati@example.com"), "m***@example.com");
  assert.equal(safety.maskNotificationRecipient("internal", "seller-default"), "seller-default");
  assert.equal(safety.maskNotificationRecipient("sms", ""), "");
  const text = "למעקב: https://pilot.c-ton.test/preview/#/track/p1?t=AbCdEfGhIjKlMnOpQrStUvWxYz0123 טלפון +972501234567 מייל mati@example.com code=SECRET99";
  const redacted = safety.redactNotificationText(text);
  assert.ok(!redacted.includes("AbCdEfGh"), "token redacted");
  assert.ok(!redacted.includes("501234567"), "phone redacted");
  assert.ok(!redacted.includes("mati@example.com"), "e-mail redacted");
  assert.ok(!redacted.includes("SECRET99"), "code redacted");
  assert.ok(redacted.includes("?t=***"));
  assert.ok(redacted.includes("m***@example.com"));
});

// ── R10 operator read model ─────────────────────────────────────────────────
await run("R10 GET /api/admin/notifications/:id shows status, masked destination, redacted preview, attempts, correlation and safety verdicts; unknown id → 404; no admin → 401", async () => {
  const blocked = await pool.query(`SELECT notification_id, recipient_ref FROM siton.notification_events WHERE idempotency_key=$1`, [`rehearsal-badphone-${RUN}`]);
  const id = String(blocked.rows[0].notification_id);
  const view = await app.inject({ method: "GET", url: `/api/admin/notifications/${id}`, headers: ADMIN });
  assert.equal(view.statusCode, 200, view.body);
  const v = view.json() as any;
  assert.equal(v.notification.status, "blocked");
  assert.match(v.notification.last_error, /recipient_invalid_format/);
  assert.equal(v.notification.safety.current.allowed, false);
  assert.equal(v.notification.safety.recipient_format_valid, false);
  assert.equal(v.attempts.length, 1);
  assert.equal(v.attempts[0].error_code, "blocked_by_recipient_safety");
  assert.equal(v.notification.why.correlation_id, `corr-badphone-${RUN}`);
  assert.ok(!view.body.includes(`TOKEN${RUN}`), "the tokenized link never leaves the read model");
  assert.equal(v.provider.mode, "dry-run");
  assert.equal(v.provider.external_delivery, false);
  const sent = await pool.query(`SELECT notification_id FROM siton.notification_events WHERE idempotency_key=$1`, [`rehearsal-sms-${RUN}`]);
  const sentView = (await app.inject({ method: "GET", url: `/api/admin/notifications/${sent.rows[0].notification_id}`, headers: ADMIN })).json() as any;
  assert.equal(sentView.notification.status, "sent");
  assert.equal(sentView.notification.recipient_masked, "+97250***567");
  assert.match(sentView.notification.subject, /המינימום הושג/);
  assert.match(sentView.notification.body_preview, /\?t=\*\*\*/);
  assert.equal(sentView.attempts[0].provider, "dry-run");
  assert.equal((await app.inject({ method: "GET", url: `/api/admin/notifications/${randomUUID()}`, headers: ADMIN })).statusCode, 404);
  assert.equal((await app.inject({ method: "GET", url: `/api/admin/notifications/${id}` })).statusCode, 401);
  assert.equal((await app.inject({ method: "GET", url: `/api/admin/notifications/not-a-uuid`, headers: ADMIN })).statusCode, 400);
  const status = (await app.inject({ method: "GET", url: "/api/admin/notifications-status", headers: ADMIN })).json() as any;
  for (const field of ["pending", "processing", "sent", "failed", "skipped", "blocked", "cancelled", "retry_scheduled"]) assert.equal(typeof status.notifications[field], "number", field);
  assert.ok(status.notifications.blocked >= 5);
  assert.ok(status.notifications.failed >= 2);
  assert.ok(status.by_channel.every((c: any) => typeof c.blocked === "number"));
  assert.ok(status.recent_events.every((e: any) => typeof e.recipient_masked === "string" && !/^\+?9725\d{8}$/.test(e.recipient_masked)));
});

// ── R11 payload hygiene at the boundary ─────────────────────────────────────
await run("R11 secret-like or oversized payloads are refused before a row exists", async () => {
  const base = { event_type: "buyer_deal_completed" as const, recipient_type: "buyer" as const, recipient_ref: "0501234567", channel: "sms" as const };
  for (const [payload, code] of [
    [{ deal_title: "x", api_key: "abc" }, "notification_payload_forbidden_field"],
    // Secret-shaped fixtures are assembled at runtime so no literal in this
    // file ever matches a secret scanner (GitHub push protection included).
    [{ deal_title: "x", note: ["-----BEGIN", "PRIVATE", "KEY-----"].join(" ") }, "notification_payload_secret_like_value"],
    [{ deal_title: "x", note: ["xoxb", "1234567890", "abcdefghijklmnop"].join("-") }, "notification_payload_secret_like_value"],
    [{ deal_title: "x", nested: { a: 1 } }, "notification_payload_nested_value"],
    [{ deal_title: "x", blob: "y".repeat(2500) }, "notification_payload_field_too_long"],
    [{ deal_title: "x", a: "y".repeat(1900), b: "y".repeat(1900), c: "y".repeat(1900), d: "y".repeat(1900), e: "y".repeat(1900) }, "notification_payload_too_large"]
  ] as const) {
    await assert.rejects(enqueueNotification({ ...base, payload_jsonb: payload as any, idempotency_key: `rehearsal-hyg-${randomUUID()}` }, pool), (e: any) => e instanceof NotificationValidationError && e.code === code);
  }
  const n = await pool.query(`SELECT count(*)::int AS n FROM siton.notification_events WHERE idempotency_key LIKE 'rehearsal-hyg-%'`);
  assert.equal(n.rows[0].n, 0);
});

// ── R12 whole-run invariants ─────────────────────────────────────────────────
await run("R12 REAL_EMAIL_SENT=0 REAL_SMS_SENT=0: no attempt ever ran in a real provider mode, every terminal row carries a reason", async () => {
  const real = await pool.query(`SELECT count(*)::int AS n FROM siton.notification_attempts WHERE provider_mode='real'`);
  assert.equal(real.rows[0].n, 0);
  const terminal = await pool.query(`SELECT count(*)::int AS n FROM siton.notification_events WHERE status IN ('failed','blocked') AND (last_error IS NULL OR last_error='')`);
  assert.equal(terminal.rows[0].n, 0, "an operator can always see why");
  const stuck = await pool.query(`SELECT count(*)::int AS n FROM siton.notification_events WHERE status='processing'`);
  assert.equal(stuck.rows[0].n, 0);
  const summary = await pool.query(`SELECT status, count(*)::int AS n FROM siton.notification_events WHERE idempotency_key LIKE $1 GROUP BY status ORDER BY status`, [`rehearsal-%-${RUN}`]);
  console.log("REHEARSAL_STATUS " + summary.rows.map((r: any) => `${r.status}=${r.n}`).join(" "));
});

console.log(`SUMMARY passed=${passed} failed=${failed} real_email_sent=0 real_sms_sent=0 external_delivery=0`);
await pool.end();
await new Promise((r) => setTimeout(r, 300));
process.exit(failed ? 1 : 0);
