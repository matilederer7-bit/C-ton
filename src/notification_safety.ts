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
 * - a structurally invalid destination (not E.164 / not an e-mail address) is
 *   blocked in every external-capable mode before any adapter sees it.
 * - outside production deployment mode, a real delivery additionally requires
 *   the recipient to match the explicit staging allowlist
 *   (NOTIFICATION_RECIPIENT_ALLOWLIST, comma-separated E.164 numbers and/or
 *   exact email addresses) or, for email, an allowlisted controlled domain
 *   (NOTIFICATION_ALLOWED_EMAIL_DOMAINS).
 * - in production, synthetic/test recipients (blocked domains, or anything on
 *   NOTIFICATION_SYNTHETIC_RECIPIENTS) are blocked.
 * - provider mode 'dry-run' (pilot communications rehearsal) evaluates the
 *   destination exactly like a real adapter would (empty / malformed
 *   destinations are blocked) but never performs external delivery; the
 *   real-mode decision is additionally exposed as a shadow verdict so an
 *   operator can see what a future real adapter WOULD do with today's env.
 * - non-real provider modes (log/dev/disabled) never perform external
 *   delivery, so they are always allowed through to the internal provider.
 */

export type NotificationSafetyDecision = {
  allowed: boolean;
  reason: string;
};

const DEFAULT_SYNTHETIC_EMAIL_DOMAINS = ["example.com", "example.org", "test.invalid", "invalid", "siton.test"];

// E.164: leading +, 8..15 digits, no leading zero after the plus.
const E164_PATTERN = /^\+[1-9]\d{7,14}$/;
const EMAIL_PATTERN = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}$/;
const EMAIL_MAX_LENGTH = 200;

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

export function normalizeNotificationRecipient(channel: string, recipient: string): string {
  if (channel === "sms") return normalizePhone(recipient);
  return String(recipient || "").trim().toLowerCase();
}

/**
 * Structural validity of a destination for an external channel. Internal
 * channels carry an internal reference (seller id, "admin") and are always
 * structurally valid when non-empty.
 */
export function isValidNotificationRecipientFormat(channel: string, recipient: string | null | undefined): boolean {
  const normalized = normalizeNotificationRecipient(channel, String(recipient || ""));
  if (channel === "sms") return E164_PATTERN.test(normalized);
  if (channel === "email") return normalized.length <= EMAIL_MAX_LENGTH && EMAIL_PATTERN.test(normalized);
  return normalized.length > 0;
}

/**
 * Presentation-safe destination: never the full phone number or e-mail.
 *   +972501234567 → +97250***567
 *   mati@example.com → m***@example.com
 *   seller-default (internal) → seller-default
 */
export function maskNotificationRecipient(channel: string, recipient: string | null | undefined): string {
  const raw = String(recipient || "").trim();
  if (!raw) return "";
  if (channel === "sms") {
    const normalized = normalizePhone(raw);
    if (normalized.length <= 4) return "***";
    return `${normalized.slice(0, Math.max(0, normalized.length - 7))}***${normalized.slice(-3)}`;
  }
  if (channel === "email") {
    const at = raw.indexOf("@");
    if (at <= 0) return "***";
    return `${raw.slice(0, 1)}***@${raw.slice(at + 1)}`;
  }
  return raw.slice(0, 64);
}

/**
 * Redact secret-bearing material from a rendered notification body before it
 * reaches an operator surface or a log line: tokenized link credentials,
 * phone numbers and e-mail addresses. The stored payload is untouched — this
 * is a presentation filter.
 */
export function redactNotificationText(value: unknown): string {
  return String(value ?? "")
    .replace(/((?:^|[?&\s])(?:t|token|access_token|tracking_token|code)=)[^&\s"'<>]+/gi, "$1***")
    .replace(/\+?\d[\d\s().-]{7,}\d/g, (match) => {
      const digits = match.replace(/\D/g, "");
      if (digits.length < 8) return match;
      return `${match.trim().startsWith("+") ? "+" : ""}${digits.slice(0, 3)}***${digits.slice(-2)}`;
    })
    .replace(/([^\s@<>"']{1})[^\s@<>"']*@([^\s@<>"']+)/g, "$1***@$2");
}

function isProductionDeployment(env: NodeJS.ProcessEnv): boolean {
  return ["production", "prod", "commercial-live"].includes(
    String(env.APP_DEPLOYMENT_MODE || "").trim().toLowerCase()
  );
}

export function isExternalNotificationChannel(channel: string): boolean {
  return channel === "sms" || channel === "email";
}

function evaluateRealModeRecipient(args: {
  channel: string;
  recipient: string | null | undefined;
  env: NodeJS.ProcessEnv;
}): NotificationSafetyDecision {
  const env = args.env;
  if (String(env.NOTIFICATION_DELIVERY_ENABLED || "").trim() !== "1") {
    return { allowed: false, reason: "delivery_master_switch_off" };
  }
  const channelSwitch = args.channel === "sms" ? "SMS_DELIVERY_ENABLED" : "EMAIL_DELIVERY_ENABLED";
  if (String(env[channelSwitch] || "").trim() !== "1") {
    return { allowed: false, reason: `channel_switch_off:${channelSwitch}` };
  }

  const raw = String(args.recipient || "").trim();
  if (!raw) {
    return { allowed: false, reason: "recipient_missing" };
  }
  if (!isValidNotificationRecipientFormat(args.channel, raw)) {
    return { allowed: false, reason: "recipient_invalid_format" };
  }
  const recipient = normalizeNotificationRecipient(args.channel, raw);

  const allowlist = splitList(env.NOTIFICATION_RECIPIENT_ALLOWLIST).map((item) =>
    normalizeNotificationRecipient(args.channel, item)
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
    normalizeNotificationRecipient(args.channel, item)
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

export function evaluateNotificationRecipientSafety(args: {
  channel: string;
  recipient: string | null | undefined;
  providerMode: string;
  env?: NodeJS.ProcessEnv;
}): NotificationSafetyDecision {
  const env = args.env || process.env;
  const providerMode = String(args.providerMode || "").toLowerCase();

  // External channels only; internal/whatsapp_link render in-product.
  if (!isExternalNotificationChannel(args.channel)) {
    return { allowed: true, reason: "non_external_channel" };
  }

  // Dry-run: the destination is validated like a real adapter would, but
  // nothing ever leaves the system.
  if (providerMode === "dry-run") {
    const raw = String(args.recipient || "").trim();
    if (!raw) return { allowed: false, reason: "recipient_missing" };
    if (!isValidNotificationRecipientFormat(args.channel, raw)) {
      return { allowed: false, reason: "recipient_invalid_format" };
    }
    return { allowed: true, reason: "dry_run_no_external_delivery" };
  }

  // Internal-only modes (log/dev/disabled/log-only) never leave the system.
  if (providerMode !== "real") {
    return { allowed: true, reason: "internal_only_provider_mode" };
  }

  return evaluateRealModeRecipient({ channel: args.channel, recipient: args.recipient, env });
}

/**
 * Operator explanation: what the CURRENT provider mode decides for this
 * destination and what a REAL adapter would decide with today's environment.
 * Pure — never touches the network.
 */
export function explainNotificationRecipientSafety(args: {
  channel: string;
  recipient: string | null | undefined;
  providerMode: string;
  env?: NodeJS.ProcessEnv;
}): { current: NotificationSafetyDecision; real_mode_shadow: NotificationSafetyDecision; recipient_format_valid: boolean } {
  const env = args.env || process.env;
  return {
    current: evaluateNotificationRecipientSafety({ ...args, env }),
    real_mode_shadow: evaluateNotificationRecipientSafety({ ...args, providerMode: "real", env }),
    recipient_format_valid: isExternalNotificationChannel(args.channel)
      ? isValidNotificationRecipientFormat(args.channel, args.recipient)
      : true
  };
}
