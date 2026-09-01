import { assertRequiredTables } from "./schema_contract.js";
import { randomUUID } from "crypto";
import pg from "pg";
import {
  getTemplateDefinition,
  isNotificationChannel,
  isNotificationEventType,
  isNotificationTemplateKey,
  renderNotification,
  templateKeyForEvent,
  type NotificationChannel,
  type NotificationEventType,
  type NotificationTemplateKey
} from "./notification_templates.js";

const { Pool } = pg;

import { evaluateNotificationRecipientSafety } from "./notification_safety.js";
import { NOTIFICATION_MAX_ATTEMPTS } from "./runtime_config.js";

export type NotificationProviderMode = "dev" | "real" | "disabled" | "log-only";
export type NotificationResultStatus = "success" | "temporary_fail" | "permanent_fail" | "skipped";

export type NotificationForProvider = {
  notification_id: string;
  event_type: NotificationEventType;
  recipient_type: "buyer" | "seller" | "admin";
  recipient_ref: string | null;
  channel: NotificationChannel;
  template_key: NotificationTemplateKey;
  payload_jsonb: Record<string, unknown>;
};

export type NotificationProviderResult = {
  status: NotificationResultStatus;
  provider_message_id?: string | null;
  error_code?: string | null;
  error_message?: string | null;
};

export interface NotificationProvider {
  readonly providerCode: string;
  readonly mode: NotificationProviderMode;
  send?(notification: NotificationForProvider): Promise<NotificationProviderResult>;
  sendSms?(to: string, body: string): Promise<{ messageId: string }>;
}

export interface SmsProvider extends NotificationProvider {
  sendSms(to: string, body: string): Promise<{ messageId: string }>;
}

export class NotificationValidationError extends Error {
  constructor(readonly code: string, message = code) {
    super(message);
    this.name = "NotificationValidationError";
  }
}

class LogNotificationProvider implements NotificationProvider {
  readonly providerCode = "log";
  readonly mode: NotificationProviderMode;

  constructor(mode: NotificationProviderMode = "dev", private logger: Pick<Console, "info"> = console) {
    this.mode = mode;
  }

  async send(notification: NotificationForProvider): Promise<NotificationProviderResult> {
    if (this.mode === "disabled") {
      return {
        status: "skipped",
        error_code: "notification_provider_disabled",
        error_message: "Notification provider is disabled"
      };
    }

    const rendered = renderNotification(
      notification.event_type,
      notification.channel,
      notification.payload_jsonb,
      notification.template_key
    );

    if (!rendered) {
      return {
        status: "skipped",
        error_code: "notification_template_not_supported",
        error_message: "Template is not compatible with channel"
      };
    }

    const providerMessageId = `log_${randomUUID()}`;
    this.logger.info("[notification.log]", {
      notification_id: notification.notification_id,
      event_type: notification.event_type,
      channel: notification.channel,
      recipient_type: notification.recipient_type,
      recipient_ref: notification.recipient_ref,
      provider_message_id: providerMessageId
    });

    return { status: "success", provider_message_id: providerMessageId };
  }

  async sendSms(_to: string, _body: string): Promise<{ messageId: string }> {
    return { messageId: `log_${randomUUID()}` };
  }
}

export function buildNotificationProvider(
  env: NodeJS.ProcessEnv = process.env,
  logger: Pick<Console, "info"> = console
): NotificationProvider {
  const provider = (env.NOTIFICATION_PROVIDER || "log").trim().toLowerCase();
  const mode = (env.NOTIFICATION_PROVIDER_MODE || "dev").trim().toLowerCase();

  // Fail closed: requesting REAL delivery must never silently degrade to the
  // log provider. No real adapter exists in R9A, so real mode cannot boot.
  if (mode === "real") {
    throw new Error(
      `NOTIFICATION_PROVIDER_MODE=real requires a verified real notification adapter; provider "${provider}" has none. Real delivery stays disabled until a provider adapter passes the communications safety gate.`
    );
  }

  // 'log' and the deployment alias 'log-only' are the same internal provider.
  if (provider !== "log" && provider !== "log-only") {
    logger.info("[notification] unsupported NOTIFICATION_PROVIDER in non-real mode; using log/dev provider", { requested_provider: provider });
  }

  if (mode === "disabled") return new LogNotificationProvider("disabled", logger);
  return new LogNotificationProvider("dev", logger);
}

export function buildSmsProvider(
  env: NodeJS.ProcessEnv = process.env,
  logger: Pick<Console, "info"> = console
): SmsProvider {
  return buildNotificationProvider(env, logger) as SmsProvider;
}

export function getNotificationProviderSummary(provider: NotificationProvider) {
  return {
    provider: provider.providerCode,
    mode: provider.mode,
    external_delivery: false
  };
}

export const getSmsProviderSummary = getNotificationProviderSummary;

export type EnqueueNotificationInput = {
  event_type: NotificationEventType;
  recipient_type: "buyer" | "seller" | "admin";
  recipient_ref?: string | null;
  deal_id?: string | null;
  participant_id?: string | null;
  seller_id?: string | null;
  channel: NotificationChannel;
  template_key?: NotificationTemplateKey;
  locale?: string;
  payload_jsonb?: Record<string, unknown>;
  scheduled_for?: Date | string | null;
  idempotency_key?: string;
  correlation_id?: string | null;
};

type LegacyEventType =
  | "join_authorized"
  | "charge_succeeded"
  | "charge_failed_recovery"
  | "deal_completed"
  | "deal_failed"
  | "refund_issued"
  | "deal_cancelled";

export type LegacyEnqueueParams = {
  eventKey: string;
  notificationEventType: LegacyEventType | NotificationEventType;
  channel: "sms" | "email" | "log" | NotificationChannel;
  recipient: string;
  templateParams: Record<string, string>;
  providerCode?: string;
};

function normalizeLegacyInput(params: LegacyEnqueueParams): EnqueueNotificationInput {
  const eventMap: Record<LegacyEventType, NotificationEventType> = {
    join_authorized: "buyer_joined_authorized",
    charge_succeeded: "buyer_payment_recovered",
    charge_failed_recovery: "buyer_recovery_required",
    deal_completed: "buyer_deal_completed",
    deal_failed: "buyer_deal_failed",
    refund_issued: "buyer_deal_failed",
    deal_cancelled: "buyer_deal_failed"
  };
  const channel = params.channel === "log" ? "internal" : params.channel;
  const eventType = isNotificationEventType(params.notificationEventType)
    ? params.notificationEventType
    : eventMap[params.notificationEventType as LegacyEventType];
  return {
    event_type: eventType,
    recipient_type: "buyer",
    recipient_ref: params.recipient,
    deal_id: params.templateParams.deal_id || null,
    participant_id: params.templateParams.participant_id || null,
    channel: channel as NotificationChannel,
    template_key: templateKeyForEvent(eventType),
    payload_jsonb: { ...params.templateParams },
    idempotency_key: params.eventKey
  };
}

function buildIdempotencyKey(input: EnqueueNotificationInput): string {
  return [
    input.event_type,
    input.recipient_type,
    input.recipient_ref || "",
    input.deal_id || "",
    input.participant_id || "",
    input.seller_id || "",
    input.channel
  ].join(":");
}

function validateEnqueueInput(input: EnqueueNotificationInput): Required<Pick<EnqueueNotificationInput, "template_key" | "locale" | "payload_jsonb">> {
  if (!isNotificationEventType(input.event_type)) {
    throw new NotificationValidationError("invalid_notification_event_type");
  }
  if (!["buyer", "seller", "admin"].includes(input.recipient_type)) {
    throw new NotificationValidationError("invalid_notification_recipient_type");
  }
  if (!isNotificationChannel(input.channel)) {
    throw new NotificationValidationError("invalid_notification_channel");
  }
  const templateKey = input.template_key || templateKeyForEvent(input.event_type);
  if (!isNotificationTemplateKey(templateKey)) {
    throw new NotificationValidationError("invalid_notification_template");
  }
  const template = getTemplateDefinition(templateKey);
  if (template.eventType !== input.event_type) {
    throw new NotificationValidationError("notification_template_event_mismatch");
  }
  if (!template.compatibleChannels.includes(input.channel)) {
    throw new NotificationValidationError("notification_template_channel_mismatch");
  }
  const payload = input.payload_jsonb || {};
  for (const field of template.requiredPayloadFields) {
    if (payload[field] == null || String(payload[field]).trim() === "") {
      throw new NotificationValidationError("notification_payload_missing_required_field", field);
    }
  }
  return { template_key: templateKey, locale: input.locale || "he-IL", payload_jsonb: payload };
}

export async function enqueueNotification(
  input: EnqueueNotificationInput | LegacyEnqueueParams,
  db: pg.Pool | pg.PoolClient
): Promise<"queued" | "duplicate"> {
  const normalized = "eventKey" in input ? normalizeLegacyInput(input) : input;
  const validated = validateEnqueueInput(normalized);
  const idempotencyKey = normalized.idempotency_key || buildIdempotencyKey(normalized);
  const result = await db.query(
    `INSERT INTO siton.notification_events
       (event_type, recipient_type, recipient_ref, deal_id, participant_id, seller_id,
        channel, template_key, locale, payload_jsonb, status, idempotency_key,
        scheduled_for, correlation_id, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',$11,$12,$13,now(),now())
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [
      normalized.event_type,
      normalized.recipient_type,
      normalized.recipient_ref || null,
      normalized.deal_id || null,
      normalized.participant_id || null,
      normalized.seller_id || null,
      normalized.channel,
      validated.template_key,
      validated.locale,
      JSON.stringify(validated.payload_jsonb),
      idempotencyKey,
      normalized.scheduled_for ? new Date(normalized.scheduled_for).toISOString() : null,
      normalized.correlation_id || null
    ]
  );
  return (result.rowCount ?? 0) > 0 ? "queued" : "duplicate";
}

const NOTIFICATION_BATCH_SIZE = 20;

function maxNotificationAttempts(): number {
  const configured = Number(process.env.NOTIFICATION_MAX_ATTEMPTS ?? NOTIFICATION_MAX_ATTEMPTS);
  return Number.isFinite(configured) && configured >= 1 ? Math.floor(configured) : 3;
}

function retryBackoffMinutes(attemptCount: number): number {
  // 1, 2, 4, 8, ... minutes — bounded at 30.
  return Math.min(30, Math.pow(2, Math.max(0, attemptCount - 1)));
}

type ClaimedNotification = NotificationForProvider & { attempt_count: number };

async function recordAttempt(
  pool: pg.Pool,
  notificationId: string,
  provider: NotificationProvider,
  result: { status: string; provider_message_id?: string | null; error_code?: string | null; error_message?: string | null }
) {
  await pool.query(
    `INSERT INTO siton.notification_attempts
       (notification_id, provider, provider_mode, result_status, provider_message_id,
        error_code, error_message, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,now())`,
    [
      notificationId,
      provider.providerCode,
      provider.mode,
      result.status,
      result.provider_message_id || null,
      result.error_code || null,
      result.error_message || null
    ]
  );
}

export async function flushPendingNotifications(
  pool: pg.Pool,
  provider: NotificationProvider,
  logger: Pick<Console, "error"> = console
): Promise<number> {
  const claimed = await pool.query<ClaimedNotification>(
    `UPDATE siton.notification_events
     SET status='processing', processing_started_at=now(), updated_at=now()
     WHERE notification_id IN (
       SELECT notification_id FROM siton.notification_events
       WHERE status='pending' AND (scheduled_for IS NULL OR scheduled_for <= now())
       ORDER BY created_at ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING notification_id, event_type, recipient_type, recipient_ref, channel, template_key, payload_jsonb, attempt_count`,
    [NOTIFICATION_BATCH_SIZE]
  );

  let processed = 0;
  const maxAttempts = maxNotificationAttempts();

  const applyTemporaryFailure = async (notification: ClaimedNotification, message: string) => {
    const attemptNumber = Number(notification.attempt_count || 0) + 1;
    if (attemptNumber >= maxAttempts) {
      // Bounded retries: terminal failure with visible reason instead of an
      // unbounded pending/backoff loop.
      await pool.query(
        `UPDATE siton.notification_events
         SET status='failed', attempt_count=$2, processing_started_at=NULL,
             last_error=$3, updated_at=now()
         WHERE notification_id=$1`,
        [notification.notification_id, attemptNumber, `max_attempts_exhausted (${maxAttempts}): ${message}`.slice(0, 500)]
      );
      return;
    }
    await pool.query(
      `UPDATE siton.notification_events
       SET status='pending', attempt_count=$2, processing_started_at=NULL,
           last_error=$3, scheduled_for=now() + ($4 * interval '1 minute'), updated_at=now()
       WHERE notification_id=$1`,
      [notification.notification_id, attemptNumber, String(message).slice(0, 500), retryBackoffMinutes(attemptNumber)]
    );
  };

  for (const notification of claimed.rows) {
    try {
      // Shared communications safety gate: evaluated BEFORE any provider I/O.
      // A real-mode provider may only reach an allowlisted/approved recipient;
      // internal-only modes always pass (they never leave the system).
      const safety = evaluateNotificationRecipientSafety({
        channel: notification.channel,
        recipient: notification.recipient_ref,
        providerMode: provider.mode
      });
      if (!safety.allowed) {
        await recordAttempt(pool, notification.notification_id, provider, {
          status: "skipped",
          error_code: "blocked_by_recipient_safety",
          error_message: safety.reason
        });
        await pool.query(
          `UPDATE siton.notification_events
           SET status='blocked', processing_started_at=NULL, last_error=$2, updated_at=now()
           WHERE notification_id=$1`,
          [notification.notification_id, `blocked_by_recipient_safety: ${safety.reason}`]
        );
        processed++;
        continue;
      }

      let result: NotificationProviderResult;
      if (provider.send) {
        result = await provider.send(notification);
      } else if (provider.sendSms) {
        // Channel-aware fallback: render the actual message body server-side.
        // An adapter must never be handed an empty body.
        const rendered = renderNotification(
          notification.event_type,
          notification.channel,
          notification.payload_jsonb,
          notification.template_key
        );
        if (!rendered || !rendered.body) {
          result = {
            status: "skipped",
            error_code: "notification_template_not_supported",
            error_message: "Template is not compatible with channel"
          };
        } else {
          const sms = await provider.sendSms(notification.recipient_ref || "", rendered.body);
          result = { status: "success", provider_message_id: sms.messageId };
        }
      } else {
        result = { status: "permanent_fail", error_code: "notification_provider_missing_send", error_message: "Provider cannot send notifications" };
      }

      await recordAttempt(pool, notification.notification_id, provider, result);

      if (result.status === "success") {
        await pool.query(
          `UPDATE siton.notification_events
           SET status='sent', sent_at=now(), attempt_count=attempt_count+1,
               processing_started_at=NULL, last_error=NULL, updated_at=now()
           WHERE notification_id=$1`,
          [notification.notification_id]
        );
      } else if (result.status === "skipped") {
        await pool.query(
          `UPDATE siton.notification_events
           SET status='skipped', processing_started_at=NULL, last_error=$2, updated_at=now()
           WHERE notification_id=$1`,
          [notification.notification_id, result.error_message || result.error_code || "skipped"]
        );
      } else if (result.status === "temporary_fail") {
        await applyTemporaryFailure(notification, result.error_message || result.error_code || "temporary_fail");
      } else {
        await pool.query(
          `UPDATE siton.notification_events
           SET status='failed', attempt_count=attempt_count+1, processing_started_at=NULL,
               last_error=$2, updated_at=now()
           WHERE notification_id=$1`,
          [notification.notification_id, result.error_message || result.error_code || "permanent_fail"]
        );
      }
      processed++;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await recordAttempt(pool, notification.notification_id, provider, {
        status: "temporary_fail",
        error_code: "provider_exception",
        error_message: message
      }).catch(() => undefined);
      await applyTemporaryFailure(notification, message).catch(() => undefined);
      logger.error("[notification.flush] provider exception", { notification_id: notification.notification_id, error: message });
      processed++;
    }
  }

  return processed;
}

/**
 * Crash recovery: reclaim notifications stranded in 'processing' by a Worker
 * that died between claim and finalize. The stranded attempt counts toward the
 * bounded budget (delivery may or may not have happened; a bounded number of
 * at-least-once retries is the explicit policy for notifications — they never
 * carry money truth).
 */
export async function reclaimStrandedNotifications(
  pool: pg.Pool,
  stuckTimeoutMs = 5 * 60_000
): Promise<number> {
  const maxAttempts = maxNotificationAttempts();
  const reclaimed = await pool.query(
    `UPDATE siton.notification_events
     SET status=CASE WHEN attempt_count + 1 >= $2 THEN 'failed' ELSE 'pending' END,
         attempt_count=attempt_count + 1,
         processing_started_at=NULL,
         last_error='reclaimed_after_processing_timeout',
         scheduled_for=now() + interval '1 minute',
         updated_at=now()
     WHERE status='processing'
       AND processing_started_at IS NOT NULL
       AND processing_started_at < now() - ($1 * interval '1 millisecond')
     RETURNING notification_id`,
    [stuckTimeoutMs, maxAttempts]
  );
  return reclaimed.rowCount || 0;
}

export async function ensureNotificationRailTables(withTx: <T>(fn: (c: pg.PoolClient) => Promise<T>) => Promise<T>) {
  await withTx(async c=>assertRequiredTables(c,["notification_events","notification_attempts"]));
}
