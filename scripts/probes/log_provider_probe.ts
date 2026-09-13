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
  const notifications = buildNotificationProvider({ NOTIFICATION_PROVIDER: "log-only", NOTIFICATION_PROVIDER_MODE: "dev" } as NodeJS.ProcessEnv, logger);
  await notifications.send({
    notification_id: "probe-notification",
    event_type: "buyer_joined_authorized",
    recipient_type: "buyer",
    recipient_ref: "+972501112233",
    channel: "internal",
    template_key: "buyer_joined_authorized",
    payload_jsonb: {}
  } as any).catch((error: Error) => lines.push("notification provider rejected the probe payload: " + error.message));
  for (const line of lines) process.stdout.write(line + "\n");
}

main().catch((error) => { process.stderr.write(String(error && error.stack || error) + "\n"); process.exit(1); });
