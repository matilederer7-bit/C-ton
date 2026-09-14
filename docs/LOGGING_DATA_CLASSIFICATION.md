# Logging data classification

Gate: `npm run gate:logging-hygiene` (`scripts/logging_hygiene_gate.cjs`). Classification source: `config/logging-data-classification.json`. Static AST scan of every log call in `src/` (pino `app.log` / `request.log` / `logger.*`, `console.*`), structural checks on the known seams, and a runtime probe of the log-only providers. 2026-09-14: 40 log calls in 66 files; NEVER_LOG emissions: 0; SENSITIVE unmasked emissions: 1 (below). Logging runtime was not redesigned.

## Classes

### NEVER LOG (gate: FAIL)

Cardholder data (`cvv`, `cvc`, `card_number`, `pan`, `expiry_*`), one-time secrets (`otp_code`, `development_code`), bearer tokens (`otp_token`, `tracking_access_token`, `session_token`, cookies, `authorization`, `x-admin-key`), credentials and keys (`password`, `password_hash`, `ADMIN_API_KEY`, `SELLER/BUYER/DISTRIBUTOR_SESSION_SECRET`, `PAYMENT_WEBHOOK_SECRET`, `PAYMENT_PROVIDER_API_KEY`, `GROW_API_KEY`, `GROW_REFERENCE_ENCRYPTION_KEY`, `SITON_STORAGE_BROKER_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL`), seller banking data (`iban`, `bank_account`, `account_number`, `payout_account`), raw provider/webhook bodies.

A field may be SHOWN to exist with the literal value `"[redacted]"` (the OTP log provider does this for `code`).

### SENSITIVE (gate: WARNING unless the value is visibly masked/redacted/hashed)

Buyer PII (`buyer_phone`, `buyer_email`, `buyer_name`, `buyer_id` - derived from the phone in this system, `delivery_address`, `delivery_city`), notification recipients (`recipient_ref`), OTP `destination` (use `destination_display`), seller contact PII (`support_phone`, `support_email`, `login_email`), cardholder name (`payer_name`), correlatable provider tokens (`payment_method_id`, `provider_reference`), network identifiers (`ip`, `remote_address`, `user_agent`).

### SAFE

Identifiers and states: `deal_id`, `participant_id`, `seller_id`, `affiliate_id`, `event_id`, `event_uuid`, `correlation_id`, `request_id`, `idempotency_key`, `challenge_id`, `notification_id`, `document_id`, `case_id`, `worker_id`; counters and timings (`attempt`, `duration_ms`); machine codes (`code`, `error_code`, `status`, `state`, `money_state`, `buyer_state`, `event_type`, `channel`, `purpose`, `provider`); `destination_display` (masked); error objects (`err`) - Fastify's serializer prints message and stack only; the sanitized `url` (`redactUrlForLogs`).

## What the runtime already does right (verified)

- Fastify request serializer prints only method, sanitized URL (`redactUrlForLogs` masks sensitive query keys), host, remote address/port (`src/app.ts`).
- One request id, normalised once (`safeHeaderId`), identical in the log line and the audit row.
- SQL logging is opt-in (`DEBUG_SQL_LOGGING=1`) and prints only `duration_ms` and the error `code`, never text or parameters (`src/db.ts`).
- The OTP log provider writes `destination_display` (masked) and `code: "[redacted]"` (`src/otp_rail.ts`); proven at runtime by the probe (`scripts/probes/log_provider_probe.ts`: raw code and raw phone absent from the output).
- Grow adapter logs pass through `redactGrowLog` (`src/grow_payment_adapter.ts`).
- Payment / OTP / tracking tokens are never logged (0 NEVER_LOG emissions).

## Findings

| Id | Where | Class | Status |
|---|---|---|---|
| LOG-1 | `src/notification_dispatch.ts:92` `LogNotificationProvider.send` logs `recipient_ref` raw (seller support email or buyer phone) | SENSITIVE unmasked | OPEN - documented; staging runs `NOTIFICATION_PROVIDER=log-only`, so recipient identifiers reach hosted logs. Suggested runtime change (not on this branch): log `maskDestination(channel, recipient_ref)` or a hash |
| LOG-2 | `DEBUG_SQL_LOGGING`, `DEBUG_JOIN_LOGGING`, `LOG_LEVEL=debug/trace` | verbosity seams | refused for staging/production by `config/runtime-environment-policy.json` |
| LOG-3 | hosted log retention and access (Render/Supabase dashboards) | platform | hosted - document only; see `docs/PRODUCTION_DATA_ACCESS_BOUNDARIES.md` |

## Rules for new code

1. Log identifiers and states, never contents. If you need to prove a value existed, log its masked display form or `"[redacted]"`.
2. Never put a request/response body, header map or provider payload into a log call.
3. Add new sensitive fields to `config/logging-data-classification.json`; the gate matches by identifier segment (camelCase and snake_case).
4. The gate runs in `npm run release:preflight`; a NEVER_LOG emission blocks the release.
