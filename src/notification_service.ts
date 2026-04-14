/**
 * Notification Service
 *
 * Facade re-exported for backward compatibility with operational_readiness.ts
 * and other callers that imported the old NotificationService interface.
 *
 * The real implementation is in notification_dispatch.ts.
 * This file provides the summary helper used by the admin/readiness surfaces.
 */

import {
  buildSmsProvider,
  getSmsProviderSummary,
  type SmsProvider
} from "./notification_dispatch.js";

// Re-export for consumers that import from here
export { buildSmsProvider, getSmsProviderSummary };
export type { SmsProvider };

/**
 * Build the SMS provider and return a summary-capable wrapper.
 * Called once at startup; the provider instance is passed into the worker loop
 * and into registerFrontendExperience for the admin status surface.
 */
export function buildNotificationService(
  env: NodeJS.ProcessEnv = process.env,
  logger: Pick<Console, "info" | "error"> = console
): SmsProvider {
  return buildSmsProvider(env, logger);
}

export function getNotificationServiceSummary(service: SmsProvider) {
  return getSmsProviderSummary(service);
}
