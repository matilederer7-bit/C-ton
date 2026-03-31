import { NOTIFICATION_PROVIDER } from "./runtime_config.js";

export type NotificationEvent =
  | "payment_authorized"
  | "payment_capture_succeeded"
  | "payment_capture_failed"
  | "payment_recovery_succeeded"
  | "payment_recovery_failed"
  | "deal_completed"
  | "deal_failed";

export type NotificationPayload = {
  participant_id?: string;
  deal_id: string;
  buyer_id?: string;
  detail?: Record<string, unknown>;
};

export interface NotificationService {
  readonly providerCode: string;
  readonly mode: "log-only";
  notify(event: NotificationEvent, payload: NotificationPayload): Promise<void>;
}

export function buildNotificationService(logger: Pick<Console, "info" | "error"> = console): NotificationService {
  return {
    providerCode: NOTIFICATION_PROVIDER,
    mode: "log-only",
    async notify(event: NotificationEvent, payload: NotificationPayload) {
      logger.info("[notification.dispatch]", {
        provider: NOTIFICATION_PROVIDER,
        mode: "log-only",
        event,
        payload
      });
    }
  };
}

export function getNotificationServiceSummary(service: NotificationService) {
  return {
    provider: service.providerCode,
    mode: service.mode,
    external_delivery: false
  };
}
