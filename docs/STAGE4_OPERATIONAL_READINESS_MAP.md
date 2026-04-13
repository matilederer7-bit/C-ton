# Stage 4 Operational Readiness Map

## Runtime Env

- Current runtime mode: `demo-preview` by default unless `APP_DEPLOYMENT_MODE` overrides it.
- Real now:
  runtime config loading, database connection, Fastify server startup, worker loop, outbox polling, webhook storage.
- Env-driven:
  `APP_DEPLOYMENT_MODE`, `DATABASE_URL`, `HOST`, `PORT`, `LOG_LEVEL`, `OUTBOX_POLL_MS`, `OUTBOX_MAX_ATTEMPTS`, `DEBUG_SQL_LOGGING`, `DEBUG_JOIN_LOGGING`, `DEBUG_SURFACES_ENABLED`.
- Hardcoded / fallback:
  default deployment mode falls back to `demo-preview`.
- Readiness:
  operational runtime is real; commercial-live assumptions are not fully met.

## Payment Provider

- Current provider code is env-driven via `PAYMENT_PROVIDER`; demo defaults still use `mockpay`.
- Current mode options:
  `mock-backed`, `provider-ready`.
- Real now:
  provider selection, live authorization / capture / recovery transport in `provider-ready`, authorization contract boundary, payment attempt persistence, outbox scheduling, reconciliation flow.
- Mock now:
  in `mock-backed`, authorization / capture / recovery / refund outcomes are simulated in-app.
- Partial only:
  in `provider-ready`, authorization / capture / recovery now run through real outbound HTTP transport when env exists, but refund is still placeholder and not truly live.
- Env dependencies:
  `PAYMENT_PROVIDER`, `PAYMENT_PROVIDER_MODE`, `PAYMENT_PROVIDER_BASE_URL`, `PAYMENT_PROVIDER_AUTH_PATH`, `PAYMENT_PROVIDER_API_KEY`, `PAYMENT_PROVIDER_PUBLIC_KEY`, `PAYMENT_PROVIDER_TIMEOUT_MS`, `PAYMENT_WEBHOOK_PROVIDER`, `PAYMENT_WEBHOOK_SECRET`, `PAYMENT_AUTH_DECLINE_SUFFIX`.
- Webhook secret policy:
  `demo-preview` may explicitly use the demo secret, but any non-demo runtime is now unsafe if `PAYMENT_WEBHOOK_SECRET` is missing or still equals `mock-webhook-secret`.
- Readiness:
  not truly activatable end to end yet.

## Authorization / Charge / Recovery

- Real now:
  state-machine transitions, idempotency, deal charging orchestration, webhook ingestion persistence, duplicate handling, late-webhook safety, payment attempt audit trail, real authorization transport, real capture transport, real recovery transport, and real refund transport.
- Mock now:
  nothing — all four payment execution paths (authorize, capture, recover, refund) now have live HTTP transport in `provider-ready` mode.
- Partial only:
  the full external money lifecycle (settlement, payout, accounting) is still not live, but the core payment execution rail is complete.
- Readiness:
  partially testable, not production-live.

## SMS

- Real now:
  OTP sessions and OTP verification flow exist inside the app.
- Mock / missing:
  no external SMS provider, no sender config, no delivery callbacks, no real SMS transport.
- Readiness:
  cannot activate truly yet.

## Email

- Real now:
  internal notification events are emitted.
- Mock / placeholder:
  notification dispatch is `log-only`.
- Missing:
  provider transport, templates, sender/domain setup, delivery status.
- Readiness:
  cannot activate truly yet.

## Receipts / Invoices

- Real now:
  seller-side receipt summary surface, internal computed receipt rows, eligibility logic for completed/charged participants.
- Placeholder / internal-only:
  receipt ids and receipt documents are internal computed artifacts, not external accounting or legal invoice issuance.
- Missing:
  real invoice transport, legal/tax compliance path, external delivery to buyer/seller.
- Readiness:
  partially activatable only as an internal operational surface.

## Feature Flags

- Real now:
  no formal feature-flag service; behavior is controlled by env switches.
- Missing:
  remote rollout, segmentation, audit trail, runtime targeting.
- Readiness:
  partial only.

## Preview / Demo Mode

- Real now:
  preview metadata route, deployment-mode visibility, public preview strip, demo-specific notes in admin/health.
- Closed in Stage 4:
  payment-screen demo wording is now shown only in demo-preview instead of leaking unconditionally.
- Remaining truth:
  current `.env` still runs in `demo-preview`, so preview boundary remains intentionally visible in the live QA environment.
- Readiness:
  valid for controlled demo, not a live commercial claim.

## Seed Data

- Real now:
  demo bootstrap SQL, default seller auto-backfill, default affiliate bootstrap, auto-created seller accounts when needed.
- Hardcoded:
  `seller-default`, `affiliate-demo`, payout mask `***1234`, default payout method `bank_transfer`.
- Risk:
  acceptable for demo/bootstrap, not a durable multi-tenant provisioning model.
- Readiness:
  partial only.

## Debug Surfaces

- Real now:
  `/debug/deals/:id` exposes deep operational data for a deal.
- Closed in Stage 4:
  debug surface is now gated explicitly and should stay blocked by default in every runtime unless both `DEBUG_SURFACES_ENABLED=1` and `DEBUG_SURFACES_ACCESS_KEY` are set.
- Current live state:
  blocked by default; opened only for explicit controlled debug sessions.
- Risk:
  never suitable as a public live surface.

## Seller Identity Handling

- Frontend state:
  seller context is stored in `localStorage` under `siton_seller_context_v1`.
- Backend selectors:
  `x-seller-id` header, `seller_id` query param, default fallback.
- Hardening boundary:
  seller-scoped publish and seller-management routes reject mismatched seller context, and new deals persist seller ownership.
- Still missing:
  real auth, proof of identity, session binding, permission model.
- Honest risk:
  context leakage risk is high for an open multi-tenant launch because callers can choose seller context without proving identity.
- Launch call:
  acceptable only for controlled demo, single-tenant operation, or tightly supervised first launch. Not sufficient for open multi-tenant production.

## Production Assumptions

- Can operate now:
  core app runtime, DB-backed deal flow, public and seller surfaces, legal/trust shell, webhook persistence, operational health views, real authorization transport, real capture transport, real recovery transport, and real refund transport.
- Can operate partially:
  payment orchestration semantics, full payment execution truth via webhook processing, receipt surface, seller scoping, demo-preview deployment.
- Cannot operate truly yet:
  real SMS, real email, real invoice/accounting transport, true open-production seller auth.

## Stage 4 Closures

- Added canonical payment route alias: `/api/payments/authorize`.
- Added canonical webhook route alias: `/webhooks/payments`.
- Added real provider-backed capture execution and webhook-truth state application for `provider-ready` non-demo runtime.
- Added real provider-backed recovery execution and webhook-truth state application for `provider-ready` non-demo runtime.
- Added structured `operational_readiness` summary to:
  `/health/integrations`
  `/api/preview/meta`
  `/api/admin/system-status`
- Gated debug surface outside demo-preview / explicit debug env.
- Removed unconditional demo wording leakage from the payment page.
- Reduced non-demo environment leakage on the public home and seller surfaces.
