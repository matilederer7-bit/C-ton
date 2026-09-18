# Payment Activation Source of Truth

Updated: 2026-09-18  
Status: **PRE-ACTIVATION / REAL MONEY BLOCKED**  
Canonical provider candidate: **Grow / Meshulam**  
Repository baseline reviewed: `34b5dc39e9cbceb413984b6639a32cffe3e5febe`

This document is the current activation source of truth for Siton's buyer-payment rail. Older Stripe readiness documents remain useful historical/adapter evidence, but they no longer decide which provider Siton intends to activate first.

## Canonical decision

Siton's first intended real buyer-payment provider is **Grow / Meshulam**, behind the existing canonical payment-provider abstraction.

Stripe remains an isolated adapter and historical proof surface. It is not the provider selected for the next activation milestone.

Real money is still blocked. This document does not authorize a charge, change runtime environment variables, add provider credentials, alter the release-governance flag, or weaken any fail-closed guard.

## What is already implemented

The repository already contains the internal payment rail needed to validate Grow externally:

- hosted suspended/delayed authorization initiation;
- sealed provider references;
- authoritative provider status lookup;
- worker/outbox-driven settlement/capture;
- failed-deal refund path;
- webhook/callback ingestion with dedupe;
- callback data treated as untrusted until authoritative lookup;
- UNKNOWN outcome handling that does not blindly retry money movement;
- durable payment-attempt / operation lifecycle and reconciliation;
- platform-fee ledger and the fixed Siton commercial invariant;
- regression coverage for duplicate/late callbacks, malformed responses, timeouts, transport loss, concurrency, recovery, refund and terminal-state events.

The commercial invariant remains:

- Siton fee: **8% of the full collected purchase amount including delivery and other applicable purchase charges, excluding VAT**;
- distributor commission: **0**;
- no per-deal commission override.

## External facts still required from Grow

Before any hosted Sandbox proof can be called complete, obtain or confirm:

1. Sandbox `userId` and `pageCode` for a direct business account.
2. Delayed/suspended charge capability enabled for the account/page (J4/J5 / `chargeType=2`).
3. Exact provisioned Sandbox endpoint and field contract.
4. Whether settlement requires any credential beyond the documented transaction identifiers.
5. Whether Sandbox permits refund against a settled Sandbox transaction.
6. Provider-side repeat/idempotency semantics for settlement and refund.
7. Authoritative status semantics after transport loss or an ambiguous provider response.
8. Callback/notify behavior and any account-level allowlisting required.
9. The documented hold-expiry/release behavior for an uncaptured suspended authorization.

If Grow's provisioned contract differs from the reviewed adapter assumptions, treat that as a provider-discrepancy task. Do not silently bend the domain model or pretend the discrepancy is already supported.

## Sandbox activation sequence

Use `docs/R9B_GROW_SANDBOX_PROOF_RUNBOOK.md` as the executable runbook once real Sandbox credentials exist.

The minimum proof is:

1. Create a small synthetic staging deal.
2. Start a Grow Sandbox suspended authorization.
3. Complete the provider-hosted flow with Grow's documented Sandbox instrument only.
4. Prove callback ingestion and authoritative status lookup.
5. Bind the authorization to exactly one buyer join.
6. Reach the deal threshold and let the worker perform settlement.
7. Prove exactly one successful money outcome and exactly one platform-fee event.
8. Verify the 8% Siton fee invariant and zero distributor commission.
9. Exercise a controlled UNKNOWN/transport-loss case and prove no duplicate settlement.
10. Replay duplicate/late callback evidence and prove no second state transition.
11. Exercise the system-mandated failed-deal refund if the Sandbox account permits it.
12. Verify operational visibility and secret/reference redaction.

No production credentials and no real payment instrument belong in this phase.

## Controlled real-money sequence

Production activation is a separate decision after Sandbox closes.

Required order:

1. Sandbox proof complete with redacted evidence.
2. Adversarial financial review of the exact integrated release SHA.
3. All real-money governance blockers cleared with evidence.
4. Explicit owner approval for production payment activation.
5. Production credentials configured only after the governance file permits it.
6. Exact release SHA passes preflight and no-real-money / release-policy gates in their allowed state.
7. Controlled low-value real transaction proof.
8. Reconciliation, accounting and rollback evidence reviewed before widening the pilot.

## Files that remain authoritative

- `config/real-money-release-policy.json` — release governance and blockers.
- `docs/REAL_MONEY_RELEASE_GOVERNANCE.md` — governance explanation.
- `docs/GROW_PAYMENTS_INTEGRATION_READINESS.md` — Grow adapter boundary and remaining external work.
- `docs/R9B_GROW_SANDBOX_PROOF_RUNBOOK.md` — executable hosted Sandbox proof.
- `src/grow_payment_adapter.ts` — Grow transport/normalization boundary.
- `src/payment_provider.ts` — canonical provider abstraction and domain-facing integration.

## Historical documents

The following documents describe earlier Stripe-first readiness work and remain useful as adapter/history references, but they do **not** override this source of truth:

- `docs/PAYMENT_PROVIDER_SANDBOX_READINESS.md`
- `docs/BUYER_PAYMENT_PROVIDER_PRODUCTION_READINESS.md`
- `docs/STRIPE_SANDBOX_EXTERNAL_VERIFICATION.md`

Their Stripe-specific statements should be read as historical scope for the Stripe adapter, not as the current provider-selection decision.

## Current blockers

As of this document:

- Grow Sandbox credentials / provisioned account contract are externally unresolved.
- Hosted Grow Sandbox proof is not complete.
- Adversarial financial review for activation is still required.
- Production payment activation is not owner-approved.
- `REAL_MONEY_ALLOWED` remains false.

Until those are cleared, Siton must remain fail-closed for real money.
