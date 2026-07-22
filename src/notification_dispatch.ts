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

  if (provider !== "log") {
    logger.info("[notification] external providers are not enabled; using log/dev provider", { requested_provider: provider });
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
        scheduled_for, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',$11,$12,now(),now())
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
      normalized.scheduled_for ? new Date(normalized.scheduled_for).toISOString() : null
    ]
  );
  return (result.rowCount ?? 0) > 0 ? "queued" : "duplicate";
}

const NOTIFICATION_BATCH_SIZE = 20;

export async function flushPendingNotifications(
  pool: pg.Pool,
  provider: NotificationProvider,
  logger: Pick<Console, "error"> = console
): Promise<number> {
  const claimed = await pool.query<NotificationForProvider>(
    `UPDATE siton.notification_events
     SET status='processing', updated_at=now()
     WHERE notification_id IN (
       SELECT notification_id FROM siton.notification_events
       WHERE status='pending' AND (scheduled_for IS NULL OR scheduled_for <= now())
       ORDER BY created_at ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING notification_id, event_type, recipient_type, recipient_ref, channel, template_key, payload_jsonb`,
    [NOTIFICATION_BATCH_SIZE]
  );

  let processed = 0;
  for (const notification of claimed.rows) {
    try {
      const result = provider.send
        ? await provider.send(notification)
        : provider.sendSms
          ? { status: "success" as const, provider_message_id: (await provider.sendSms(notification.recipient_ref || "", "")).messageId }
          : { status: "permanent_fail" as const, error_code: "notification_provider_missing_send", error_message: "Provider cannot send notifications" };
      await pool.query(
        `INSERT INTO siton.notification_attempts
           (notification_id, provider, provider_mode, result_status, provider_message_id,
            error_code, error_message, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,now())`,
        [
          notification.notification_id,
          provider.providerCode,
          provider.mode,
          result.status,
          result.provider_message_id || null,
          result.error_code || null,
          result.error_message || null
        ]
      );

      if (result.status === "success") {
        await pool.query(
          `UPDATE siton.notification_events
           SET status='sent', sent_at=now(), last_error=NULL, updated_at=now()
           WHERE notification_id=$1`,
          [notification.notification_id]
        );
      } else if (result.status === "skipped") {
        await pool.query(
          `UPDATE siton.notification_events
           SET status='skipped', last_error=$2, updated_at=now()
           WHERE notification_id=$1`,
          [notification.notification_id, result.error_message || result.error_code || "skipped"]
        );
      } else if (result.status === "temporary_fail") {
        await pool.query(
          `UPDATE siton.notification_events
           SET status='pending', last_error=$2, scheduled_for=now() + interval '1 minute', updated_at=now()
           WHERE notification_id=$1`,
          [notification.notification_id, result.error_message || result.error_code || "temporary_fail"]
        );
      } else {
        await pool.query(
          `UPDATE siton.notification_events
           SET status='failed', last_error=$2, updated_at=now()
           WHERE notification_id=$1`,
          [notification.notification_id, result.error_message || result.error_code || "permanent_fail"]
        );
      }
      processed++;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await pool.query(
        `INSERT INTO siton.notification_attempts
           (notification_id, provider, provider_mode, result_status, error_code, error_message, created_at)
         VALUES ($1,$2,$3,'temporary_fail','provider_exception',$4,now())`,
        [notification.notification_id, provider.providerCode, provider.mode, message]
      ).catch(() => undefined);
      await pool.query(
        `UPDATE siton.notification_events
         SET status='pending', last_error=$2, scheduled_for=now() + interval '1 minute', updated_at=now()
         WHERE notification_id=$1`,
        [notification.notification_id, message]
      ).catch(() => undefined);
      logger.error("[notification.flush] provider exception", { notification_id: notification.notification_id, error: message });
      processed++;
    }
  }

  return processed;
}

export async function ensureNotificationRailTables(withTx: <T>(fn: (c: pg.PoolClient) => Promise<T>) => Promise<T>) {
  await withTx(async c=>assertRequiredTables(c,["notification_events","notification_attempts"]));
}
