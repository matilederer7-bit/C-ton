# Morning Handoff - Real Integrations

> **SUPERSEDED — HISTORICAL (2026-09-30).** This document is tiered ARCHIVE in `docs/DOCUMENTATION_MAP.md`: history, never authority. Its decisions, "canonical" lists and contracts describe an earlier state of the project. Product rules are in `docs/SITON_PRODUCT_CONSTITUTION_2026-09-30.md`, the runtime in `docs/CURRENT_ARCHITECTURE_2026-09-30.md`, current state in `PROJECT_STATUS.md`.

## What Was Mapped

- Payment/auth flow across frontend and backend
- Existing outbox/payment attempt surfaces
- Webhook readiness and duplicate handling gaps
- Notification and observability gaps

## What Was Improved

- Payment moved behind one provider boundary instead of scattered mock logic.
- Webhook ingestion now has a real endpoint, storage readiness, duplicate acceptance policy, and secret gate.
- Notifications now have a defined service boundary.
- Operational visibility now includes `/health/integrations`.

## What Was Wired

- [src/frontend_runtime.ts](C:/Users/Lenovo/Documents/C-ton/src/frontend_runtime.ts) now uses the canonical payment provider contract.
- [src/app.ts](C:/Users/Lenovo/Documents/C-ton/src/app.ts) now uses the same provider for capture/recovery/refund, exposes the webhook endpoint, and dispatches notification hooks.
- [scripts/init_db.sql](C:/Users/Lenovo/Documents/C-ton/scripts/init_db.sql) now aligns with runtime expectations for `webhook_events`.

## What Was Prepared For Real Integrations

- Provider/env boundary for payment
- Webhook ingestion contract and duplicate policy
- Notification service boundary
- Integration-focused health visibility
- Automated validation for real-integration contracts

## What Is Still Mock

- Payment provider implementation
- Notification delivery provider
- Webhook-driven domain reconciliation

## What To Do In The Morning

- Choose the first real external provider to implement behind the payment boundary.
- Define the provider-specific webhook event catalog and map it to domain updates.
- Decide whether MVP notifications should first be SMS, email, or both.

## What Not To Reopen

- Backend closure decisions
- Frontend MVP closure decisions
- Buyer/join/max-units product rules
- Core deal lifecycle QA that was already closed
