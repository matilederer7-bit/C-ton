# Payment Rail Red-Team — 2026-09-18

Baseline reviewed: `34b5dc39e9cbceb413984b6639a32cffe3e5febe`  
Scope: Grow / Meshulam activation path, authorization creation, capture/refund ambiguity, long-horizon authorization renewal, runtime endpoint safety, Siton fee invariants.  
Real money executed: **0**. Provider credentials used: **0**.

## Verdict

The internal money rail is materially hardened, but Grow must remain blocked for real money until the external provider contract is proven in Sandbox.

This review found two repository-side fail-closed defects that can be fixed without provider credentials, and two provider-contract blockers that must not be guessed in code.

## Finding P0-A — ambiguous J5 creation was advertised as retryable

### Evidence

`src/grow_payment_adapter.ts` previously returned `result_class=unknown, retryable=true` when `createPaymentProcess` lost its transport response, and treated retryable HTTP statuses such as 503 as `temporary_fail`.

For delayed J4/J5 authorization, the reviewed Grow contract exposes no provider-side idempotency key on `createPaymentProcess`. A transport loss or gateway error does not prove the request was not executed. If Grow created the process but Siton did not receive `processId/processToken`, repeating the create request can establish a second authorization.

The canonical HTTP route only creates `payment_authorization_bindings` after a successful provider response. Therefore an ambiguous create has no durable provider reference to query later; the previous user-facing statement that Siton “will reconcile” was not true for this specific phase.

### Fix in this branch

- transport loss after create dispatch => `UNKNOWN`, non-retryable;
- 408/409/425/429/5xx after create dispatch => `UNKNOWN`, non-retryable;
- incomplete nominal-success response => `UNKNOWN`, non-retryable;
- explicit provider rejection remains a declared permanent failure;
- user-facing/provider-layer text no longer promises reconciliation and says automatic retry is blocked pending provider/operator review.

This is intentionally fail-closed. A future durable authorization-intent/recovery design may improve recovery, but it must be based on Grow’s actual correlation/idempotency contract rather than fabricated identifiers.

## Finding P0-B — Grow LIVE transport was not pinned to the official host

### Evidence

Sandbox already required exactly `sandbox.meshulam.co.il`. LIVE only rejected the Sandbox host, so any other HTTPS hostname could pass the Grow-specific guard.

Grow’s current production-transition documentation names the production base as:

`https://secure.meshulam.co.il/api/light/server/1.0`

A payment runtime must not be able to send provider credentials and financial operations to an arbitrary HTTPS endpoint because of a console typo or compromised configuration.

### Fix in this branch

Both the adapter configuration guard and the production runtime guard now require LIVE Grow host exactly `secure.meshulam.co.il`. Regression tests prove the official host passes and arbitrary/Sandbox hosts fail.

## Finding P0-C — long-horizon Grow re-authorization remains externally unproven

### Status: OPEN / provider dependency

Siton correctly separates deal duration from authorization lifetime. The repository has provider-neutral renewal identities, binding rotation, reconciliation, concurrency fencing and tests.

However `docs/LONG_HORIZON_AUTHORIZATION_ARCHITECTURE.md` correctly records that Grow itself still has **no implemented reauthorize adapter**. The current Grow binding declares the J5 validity window, but after expiry the worker has no proven stored-instrument Grow renewal operation.

Grow documents token creation / token transactions, including transaction identifiers on token APIs, but the exact tokenization + merchant-initiated renewal contract needed by Siton has not been proven with Siton’s Sandbox account.

### Required closure

Before real-money activation for long-horizon deals:

1. confirm with Grow which token flow is enabled for the Siton account;
2. prove creation/storage of an opaque provider token without exposing card data to Siton;
3. prove merchant-initiated re-authorization/charge semantics in Sandbox;
4. prove provider-side idempotency/replay semantics for the durable Siton renewal identity;
5. wire the proven operation behind `PaymentProvider.reauthorize`;
6. run the existing long-horizon renewal lifecycle suite against the real Sandbox boundary.

Do **not** reintroduce a seven-day product cap as a workaround. Deal duration remains independent of provider authorization lifetime.

## Finding P0-D — ambiguous refund confirmation remains provider-contract dependent

### Status: OPEN / provider dependency

The refund rail already fails closed after an ambiguous dispatched refund: it does not blindly send a second refund. That is the correct safety posture.

What remains unproven is how Siton can authoritatively identify the outcome of one ambiguous `refundTransaction` call after response loss. Grow’s refund endpoint creates a refund transaction, while the existing stored reference identifies the original transaction. The provider contract must establish a reliable lookup/correlation path before automatic refund reconciliation can be considered complete.

### Required closure

Prove in Sandbox whether a lost refund response can be resolved by:
- original transaction status/history;
- a returned refund transaction identifier available through another lookup;
- or another Grow-supported correlation mechanism.

Until then, ambiguous refund stays an operational/manual-review case and must never be automatically repeated.

## Fee invariant review

No defect found in the reviewed platform-fee path:

- gross charge context includes product amount **plus delivery**;
- customer VAT is calculated by the canonical VAT authority;
- the 8% Siton fee base is gross charge minus customer VAT;
- distributor commission is not part of the money ledger;
- refund adjustment reverses the corresponding platform-fee consequence.

This review does not substitute for accountant/legal confirmation of production VAT rates. Production already fails closed unless explicit VAT authority is configured.

## Activation consequence

`REAL_MONEY_ALLOWED` must remain `false`.

The next external milestone is not “turn payments on”. It is:

**Grow Sandbox contract proof**, including J5 creation/status/settlement, long-horizon renewal/token semantics, ambiguous-refund resolution, callback behavior and exact account credentials/permissions.

Only after those provider facts are proven should the corresponding governance blockers be cleared.
