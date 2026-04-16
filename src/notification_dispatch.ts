/**
 * Notification Dispatch
 *
 * Provider abstraction for SMS (and future email) delivery.
 * The system has three modes:
 *
 *   "log-only"  — default; logs the message, records as sent with a fake message ID.
 *                  Used in demo/dev. No actual delivery.
 *
 *   "real"      — activated when TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_FROM
 *                  are set. Delivers via Twilio SMS API.
 *
 *   "disabled"  — provider throws on every send; used to explicitly block delivery.
 *
 * Idempotency: enqueue() inserts into siton.notifications with ON CONFLICT DO NOTHING.
 * The UNIQUE constraint on event_key prevents duplicate rows. The flush loop processes
 * pending rows and updates status/sent_at/provider_message_id/last_error.
 */

import pg from "pg";
import {
  renderNotification,
  templateId,
  type NotificationEventType,
  type NotificationChannel
} from "./notification_templates.js";

const { Pool } = pg;

// ─── Provider interface ──────────────────────────────────────────────────────

export type ProviderMode = "real" | "log-only" | "disabled";

export interface SmsProvider {
  readonly providerCode: string;
  readonly mode: ProviderMode;
  sendSms(to: string, body: string): Promise<{ messageId: string }>;
}

// ─── Log-only provider ───────────────────────────────────────────────────────

class LogOnlySmsProvider implements SmsProvider {
  readonly providerCode = "log-only";
  readonly mode: ProviderMode = "log-only";

  constructor(private logger: Pick<Console, "info"> = console) {}

  async sendSms(to: string, body: string): Promise<{ messageId: string }> {
    const fakeId = `log-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.logger.info("[notification.sms.log-only]", { to: maskPhone(to), body, messageId: fakeId });
    return { messageId: fakeId };
  }
}

// ─── Twilio provider ─────────────────────────────────────────────────────────

class TwilioSmsProvider implements SmsProvider {
  readonly providerCode = "twilio";
  readonly mode: ProviderMode = "real";

  constructor(
    private accountSid: string,
    private authToken: string,
    private fromNumber: string,
    private logger: Pick<Console, "info" | "error"> = console
  ) {}

  async sendSms(to: string, body: string): Promise<{ messageId: string }> {
    // Twilio Messages API: POST https://api.twilio.com/2010-04-01/Accounts/{SID}/Messages.json
    const url = `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Messages.json`;
    const auth = Buffer.from(`${this.accountSid}:${this.authToken}`).toString("base64");

    const formBody = new URLSearchParams({
      To: to,
      From: this.fromNumber,
      Body: body
    });

    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: formBody.toString()
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      this.logger.error("[notification.sms.twilio] send failed", { status: res.status, body: text });
      throw new Error(`twilio_sms_failed: HTTP ${res.status} — ${text.slice(0, 200)}`);
    }

    const json = (await res.json()) as { sid?: string };
    const messageId = json.sid || `twilio-${Date.now()}`;
    this.logger.info("[notification.sms.twilio] sent", { to: maskPhone(to), messageId });
    return { messageId };
  }
}

// ─── Disabled provider ───────────────────────────────────────────────────────

class DisabledSmsProvider implements SmsProvider {
  readonly providerCode = "disabled";
  readonly mode: ProviderMode = "disabled";

  async sendSms(_to: string, _body: string): Promise<{ messageId: string }> {
    throw new Error("sms_provider_disabled");
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Build the SMS provider from environment variables.
 *
 * Activates Twilio when TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_FROM are all set.
 * Falls back to log-only otherwise.
 */
export function buildSmsProvider(
  env: NodeJS.ProcessEnv = process.env,
  logger: Pick<Console, "info" | "error"> = console
): SmsProvider {
  const sid = (env.TWILIO_ACCOUNT_SID || "").trim();
  const token = (env.TWILIO_AUTH_TOKEN || "").trim();
  const from = (env.TWILIO_FROM || "").trim();

  if (sid && token && from) {
    logger.info("[notification] Twilio SMS provider active", { from: maskPhone(from) });
    return new TwilioSmsProvider(sid, token, from, logger);
  }

  return new LogOnlySmsProvider(logger);
}

// ─── Enqueue ─────────────────────────────────────────────────────────────────

export type EnqueueParams = {
  eventKey: string;
  notificationEventType: NotificationEventType;
  channel: NotificationChannel;
  recipient: string;
  templateParams: Record<string, string>;
  providerCode?: string;
};

/**
 * Enqueue a notification for delivery.
 * Uses ON CONFLICT DO NOTHING — safe to call multiple times for the same event_key.
 * Can be called with a pg client (inside a transaction) or a pool.
 */
export async function enqueueNotification(
  params: EnqueueParams,
  db: pg.Pool | pg.PoolClient
): Promise<"queued" | "duplicate"> {
  const tmplId = templateId(params.notificationEventType, params.channel);
  const rendered = renderNotification(params.notificationEventType, params.channel, params.templateParams);
  if (!rendered) return "duplicate"; // no template → skip silently

  const result = await db.query(
    `INSERT INTO siton.notifications
       (event_key, notification_event_type, channel, recipient, template_id,
        template_params, status, attempt_count, max_attempts, provider_code,
        available_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending', 0, 3, $7, now(), now(), now())
     ON CONFLICT (event_key) DO NOTHING`,
    [
      params.eventKey,
      params.notificationEventType,
      params.channel,
      params.recipient,
      tmplId,
      JSON.stringify(params.templateParams),
      params.providerCode || "log-only"
    ]
  );

  return (result.rowCount ?? 0) > 0 ? "queued" : "duplicate";
}

// ─── Flush ───────────────────────────────────────────────────────────────────

const NOTIFICATION_BATCH_SIZE = 20;
const NOTIFICATION_MAX_ATTEMPTS = 3;
// Exponential backoff base: 30s, 90s, 270s
const RETRY_DELAY_MS = [30_000, 90_000, 270_000];

/**
 * Claim and send a batch of pending notifications.
 * Returns the number of notifications processed (sent + failed).
 *
 * This is safe to call concurrently — the UPDATE ... RETURNING uses
 * implicit row-level locking to prevent double-processing.
 */
export async function flushPendingNotifications(
  pool: pg.Pool,
  smsProvider: SmsProvider,
  logger: Pick<Console, "info" | "error"> = console
): Promise<number> {
  // Claim a batch atomically
  const claimed = await pool.query<{
    notification_id: string;
    notification_event_type: string;
    channel: string;
    recipient: string;
    template_params: Record<string, string>;
    attempt_count: number;
    max_attempts: number;
    provider_code: string;
  }>(
    `UPDATE siton.notifications
     SET status='processing', attempt_count=attempt_count+1, updated_at=now()
     WHERE notification_id IN (
       SELECT notification_id FROM siton.notifications
       WHERE status='pending' AND available_at <= now()
       ORDER BY created_at ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING notification_id, notification_event_type, channel, recipient,
               template_params, attempt_count, max_attempts, provider_code`,
    [NOTIFICATION_BATCH_SIZE]
  );

  if (claimed.rowCount === 0) return 0;

  let processed = 0;
  for (const row of claimed.rows) {
    try {
      const eventType = row.notification_event_type as NotificationEventType;
      const channel = row.channel as NotificationChannel;
      const params = row.template_params as Record<string, string>;
      const rendered = renderNotification(eventType, channel, params);

      if (!rendered) {
        // No template — skip (mark skipped so it doesn't retry)
        await pool.query(
          `UPDATE siton.notifications
           SET status='skipped', last_error='no_template', updated_at=now()
           WHERE notification_id=$1`,
          [row.notification_id]
        );
        processed++;
        continue;
      }

      let messageId: string;
      if (channel === "sms" || channel === "log") {
        const result = await smsProvider.sendSms(row.recipient, rendered.body);
        messageId = result.messageId;
      } else {
        // email channel — not yet implemented; mark skipped
        await pool.query(
          `UPDATE siton.notifications
           SET status='skipped', last_error='email_provider_not_configured', updated_at=now()
           WHERE notification_id=$1`,
          [row.notification_id]
        );
        processed++;
        continue;
      }

      await pool.query(
        `UPDATE siton.notifications
         SET status='sent', provider_message_id=$2, sent_at=now(),
             last_error=NULL, updated_at=now()
         WHERE notification_id=$1`,
        [row.notification_id, messageId]
      );
      processed++;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const attemptCount = row.attempt_count;

      if (attemptCount >= row.max_attempts) {
        // Exhausted retries — mark permanently failed
        await pool.query(
          `UPDATE siton.notifications
           SET status='failed', last_error=$2, updated_at=now()
           WHERE notification_id=$1`,
          [row.notification_id, `max_attempts_exceeded: ${msg}`]
        ).catch(() => undefined);
        logger.error("[notification.flush] permanent failure", {
          notification_id: row.notification_id,
          error: msg
        });
      } else {
        // Transient failure — reschedule with backoff
        const delayIdx = Math.min(attemptCount, RETRY_DELAY_MS.length - 1);
        const nextAt = new Date(Date.now() + RETRY_DELAY_MS[delayIdx]!);
        await pool.query(
          `UPDATE siton.notifications
           SET status='pending', last_error=$2, available_at=$3, updated_at=now()
           WHERE notification_id=$1`,
          [row.notification_id, msg, nextAt.toISOString()]
        ).catch(() => undefined);
        logger.error("[notification.flush] transient failure, scheduled retry", {
          notification_id: row.notification_id,
          next_attempt_at: nextAt.toISOString(),
          error: msg
        });
      }
      processed++;
    }
  }

  return processed;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function maskPhone(phone: string): string {
  if (!phone || phone.length < 4) return "***";
  return phone.slice(0, 3) + "****" + phone.slice(-2);
}

// ─── Summary ─────────────────────────────────────────────────────────────────

export function getSmsProviderSummary(provider: SmsProvider) {
  return {
    provider: provider.providerCode,
    mode: provider.mode,
    external_delivery: provider.mode === "real"
  };
}
