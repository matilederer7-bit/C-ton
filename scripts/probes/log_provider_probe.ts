// Exercises the real log-only OTP and notification providers in-process and
// prints what they log, so scripts/logging_hygiene_gate.cjs can scan the
// emitted lines for raw secrets / destinations. No database, no network.
import { buildOtpProvider, maskDestination } from "../../src/otp_rail.ts";
import { buildNotificationProvider } from "../../src/notification_dispatch.ts";

const lines: string[] = [];
const logger = { info: (...args: unknown[]) => { lines.push(args.map((item) => (typeof item === "string" ? item : JSON.stringify(item))).join(" ")); } };

async function main() {
  const otp = buildOtpProvider({ OTP_PROVIDER: "log", OTP_PROVIDER_MODE: "dev" } as NodeJS.ProcessEnv, logger);
  await otp.send({
    challenge_id: "probe-challenge",
    channel: "sms",
    destination_display: maskDestination("sms", "+972501112233"),
    purpose: "buyer_join",
    code: "SECRET-OTP-654321"
  } as any);
  // The template key is `buyer_joined_authorized_he`, not the bare event type:
  // with the wrong key renderNotification() returns null, the provider answers
  // "skipped" WITHOUT logging, and this arm of the probe emits nothing at all -
  // which is how the gate's "notification log provider" check passed for a
  // recipient_ref that was in fact logged raw in production (LOG-1). Each send
  // below must actually produce a line, and each carries its OWN sentinel so a
  // leak is attributed to the right provider.
  const notifications = buildNotificationProvider({ NOTIFICATION_PROVIDER: "log-only", NOTIFICATION_PROVIDER_MODE: "dev" } as NodeJS.ProcessEnv, logger);
  const notificationCases = [
    { id: "probe-notification-sms", channel: "sms", recipient_type: "buyer", recipient_ref: "+972509998877" },
    { id: "probe-notification-email", channel: "email", recipient_type: "seller", recipient_ref: "seller-support@probe.invalid" }
  ];
  for (const item of notificationCases) {
    const before = lines.length;
    await notifications.send({
      notification_id: item.id,
      event_type: "buyer_joined_authorized",
      recipient_type: item.recipient_type,
      recipient_ref: item.recipient_ref,
      channel: item.channel,
      template_key: "buyer_joined_authorized_he",
      payload_jsonb: { deal_title: "probe deal" }
    } as any).catch((error: Error) => lines.push("notification provider rejected the probe payload: " + error.message));
    if (lines.length === before) {
      lines.push(`PROBE_INERT notification provider logged nothing for ${item.id} (channel=${item.channel}); this arm of the gate would be vacuous`);
    }
  }
  for (const line of lines) process.stdout.write(line + "\n");
}

main().catch((error) => { process.stderr.write(String(error && error.stack || error) + "\n"); process.exit(1); });
