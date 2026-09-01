/**
 * R9A — shared communications safety layer.
 *
 * Every future real SMS/email adapter MUST pass through this gate before any
 * external I/O. No real adapter exists yet (real delivery count stays 0); the
 * gate is built and enforced now so a later adapter cannot accidentally send
 * to a real customer from a synthetic staging event.
 *
 * Safety model (default-deny):
 * - provider mode 'real' requires BOTH NOTIFICATION_DELIVERY_ENABLED=1 (master
 *   switch) and the per-channel switch (SMS_DELIVERY_ENABLED /
 *   EMAIL_DELIVERY_ENABLED).
 * - outside production deployment mode, a real delivery additionally requires
 *   the recipient to match the explicit staging allowlist
 *   (NOTIFICATION_RECIPIENT_ALLOWLIST, comma-separated E.164 numbers and/or
 *   exact email addresses) or, for email, an allowlisted controlled domain
 *   (NOTIFICATION_ALLOWED_EMAIL_DOMAINS).
 * - in production, synthetic/test recipients (blocked domains, or anything on
 *   NOTIFICATION_SYNTHETIC_RECIPIENTS) are blocked.
 * - non-real provider modes (log/dev/disabled) never perform external
 *   delivery, so they are always allowed through to the internal provider.
 */

export type NotificationSafetyDecision = {
  allowed: boolean;
  reason: string;
};

const DEFAULT_SYNTHETIC_EMAIL_DOMAINS = ["example.com", "example.org", "test.invalid", "invalid", "siton.test"];

function splitList(value: string | undefined): string[] {
  return String(value || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function normalizePhone(value: string): string {
  const digits = String(value || "").replace(/[^0-9+]/g, "");
  // Normalize local Israeli format to E.164 for comparison.
  if (/^05\d{8}$/.test(digits)) return `+972${digits.slice(1)}`;
  return digits;
}

function normalizeRecipient(channel: string, recipient: string): string {
  if (channel === "sms") return normalizePhone(recipient);
  return String(recipient || "").trim().toLowerCase();
}

function isProductionDeployment(env: NodeJS.ProcessEnv): boolean {
  return ["production", "prod", "commercial-live"].includes(
    String(env.APP_DEPLOYMENT_MODE || "").trim().toLowerCase()
  );
}

export function evaluateNotificationRecipientSafety(args: {
  channel: string;
  recipient: string | null | undefined;
  providerMode: string;
  env?: NodeJS.ProcessEnv;
}): NotificationSafetyDecision {
  const env = args.env || process.env;
  const providerMode = String(args.providerMode || "").toLowerCase();

  // Internal-only modes (log/dev/disabled/log-only) never leave the system.
  if (providerMode !== "real") {
    return { allowed: true, reason: "internal_only_provider_mode" };
  }

  // External channels only; internal/whatsapp_link render in-product.
  if (!["sms", "email"].includes(args.channel)) {
    return { allowed: true, reason: "non_external_channel" };
  }

  if (String(env.NOTIFICATION_DELIVERY_ENABLED || "").trim() !== "1") {
    return { allowed: false, reason: "delivery_master_switch_off" };
  }
  const channelSwitch = args.channel === "sms" ? "SMS_DELIVERY_ENABLED" : "EMAIL_DELIVERY_ENABLED";
  if (String(env[channelSwitch] || "").trim() !== "1") {
    return { allowed: false, reason: `channel_switch_off:${channelSwitch}` };
  }

  const recipient = normalizeRecipient(args.channel, String(args.recipient || ""));
  if (!recipient) {
    return { allowed: false, reason: "recipient_missing" };
  }

  const allowlist = splitList(env.NOTIFICATION_RECIPIENT_ALLOWLIST).map((item) =>
    normalizeRecipient(args.channel, item)
  );
  const allowedDomains = splitList(env.NOTIFICATION_ALLOWED_EMAIL_DOMAINS);

  if (!isProductionDeployment(env)) {
    // Staging/dev with a real adapter: explicit allowlist only. Never infer
    // safety from a "test" substring.
    if (allowlist.includes(recipient)) {
      return { allowed: true, reason: "staging_allowlisted_recipient" };
    }
    if (args.channel === "email") {
      const domain = recipient.split("@")[1] || "";
      if (domain && allowedDomains.includes(domain)) {
        return { allowed: true, reason: "staging_allowlisted_domain" };
      }
    }
    return { allowed: false, reason: "staging_recipient_not_allowlisted" };
  }

  // Production: block explicitly synthetic recipients.
  const synthetic = splitList(env.NOTIFICATION_SYNTHETIC_RECIPIENTS).map((item) =>
    normalizeRecipient(args.channel, item)
  );
  if (synthetic.includes(recipient)) {
    return { allowed: false, reason: "production_synthetic_recipient_blocked" };
  }
  if (args.channel === "email") {
    const domain = recipient.split("@")[1] || "";
    const blockedDomains = new Set([...DEFAULT_SYNTHETIC_EMAIL_DOMAINS, ...splitList(env.NOTIFICATION_SYNTHETIC_EMAIL_DOMAINS)]);
    if (domain && blockedDomains.has(domain)) {
      return { allowed: false, reason: "production_synthetic_domain_blocked" };
    }
  }
  return { allowed: true, reason: "production_recipient_allowed" };
}
