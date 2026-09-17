# Long-horizon deals — payment authorization architecture

Status: **canonical** (2026-09-16). Supersedes every earlier statement that a
deal's deadline is capped because a card authorization expires (the former
7-day maximum, `docs/SENIOR_ADVERSARIAL_REVIEW.md` §LONG_HORIZON_DEALS,
`docs/SPEC_DRIFT_MAP_2026-04-19.md` D3, `docs/R9B_GROW_SANDBOX_ACTIVATION.md`
"J5 window", the unmerged `claude/long-horizon-deals-architecture` mandate
design). Real money executed by this work: **0**. Grow untouched, unactivated.

## 1. The rule

**Deal duration must not depend on authorization lifetime.**

Two concepts that the repository used to conflate are now separate:

| | A. Buyer financial commitment | B. Current provider authorization |
|---|---|---|
| What it is | The participant's obligation to the deal | The technical instrument the provider holds for that obligation |
| Where it lives | `participants.buyer_state` / `money_state` (unchanged state machine) | `payment_authorization_bindings` (one consumed binding per participant) |
| Lifetime | The deal's, per Siton's rules (deadline → charging → completion window) | Provider-defined (`expires_at`, e.g. Grow J5 ≈ 7 days); **replaceable** |
| Who ends it | Deal outcome, buyer withdrawal rules, recovery rules | Provider expiry, provider decline of the instrument, renewal |

An expired authorization is a **payment-maintenance event**. It never fails a
deal, never drops a participant, never caps the deadline, and never shows up
as a new visible `DealState`, `BuyerState` or `MoneyState`. `AUTH_EXPIRED`-class
conditions (`payment_authorization_expired`, `authorization_unusable`) are
recoverable technical conditions inside the payment path.

## 2. Deadline policy (`src/deadline_policy.ts`)

| Bound | Value | Nature |
|---|---|---|
| minimum | 2 hours | product rule (unchanged) |
| maximum | 20 years | **technical sanity ceiling** (typo protection), not a business or payment bound; no environment flag can raise it |
| advisory | > 1 year | seller-facing warning that cards may expire/be replaced over a long horizon; never blocks |

`web/src/deadlinePolicy.ts` mirrors the constants for the seller picker;
`tests/long_horizon_deadline_policy_validation.ts` pins server, web, legacy
frontend and Hebrew copy together. 30-, 60-, 90-day (and longer) deals are
created and edited exactly like short ones. There is no DB constraint on the
maximum (there never was); the demo seed and pilot templates are only samples.

## 3. What is stored (migration 071)

`payment_authorization_bindings` keeps ONE row per participant (the current
instrument; the 053 uniqueness on `consumed_by_participant_id` is unchanged)
and gains:

| Column | Meaning |
|---|---|
| `expires_at` (053, now populated) | provider-declared validity of the **current** authorization — a property of the instrument, never of the deal |
| `payment_method_ref` | opaque provider-side stored payment-method reference given at authorize time (Stripe `pm_…`, provider-ready `payment_method.id`); **never raw card data** (`npm run scan:payment`) |
| `authorization_established_at` | when the current `authorization_id` was established (join, or the latest renewal) |
| `renewal_count`, `renewed_at`, `replaced_authorization_id` | renewal audit on the row; the full chain is in `payment_attempts` |

`payment_attempts.attempt_type` gains **`reauthorize`**: one durable identity
per renewal request, with the full 067/068 lifecycle (recorded → dispatching
under the worker lease → responded; success / permanent_fail / unknown; owner
fencing; terminal monotonicity). It is **not** a charge attempt: the 050
rolling three-attempt cap and the 068 settlement fence read
`charge_start`/`recovery` only.

The 067 eligibility guard is extended, not weakened: no second `reauthorize`
while one is `unknown`; no `charge_start`, `recovery` or `release` while a
`reauthorize` is `unknown` (the current instrument is not known until the
renewal resolves). A renewal that **succeeded** never blocks a later renewal —
a very long deal may renew more than once.

## 4. The worker path (`ensureUsableAuthorizationForCapture`, `src/app.ts`)

Before every capture-side dispatch (charge rail **and** recovery rail):

1. load the participant's current binding and its renewal source
   (`payment_method_ref`, else the buyer's newest active
   `buyer_payment_methods` row for the provider — e.g. one supplied through
   the recovery route);
2. `assessAuthorizationUsability` (`src/authorization_lifecycle.ts`):
   * **undeclared** validity → proceed; the provider decides at capture;
   * **usable** → proceed on the current authorization;
   * **expired** (declared validity passed, or the provider reported the
     instrument unusable) → renewal:
3. renewal = `provider.reauthorize({ payment_method_ref, amount, … , correlation_id })`
   through the same identity discipline as every money operation:
   `beginProviderAttempt("reauthorize")` → arm under the lease →
   provider I/O → owner settle. On **success** the renewed authorization is
   written to the binding **in the same transaction as the identity settle**
   (`applyAuthorizationRenewalInTx`), then the capture is dispatched on it.
   `pending` → identity UNKNOWN, `payment_reconcile` with
   `operation="authorization"`, job deferred. Post-dispatch ambiguity →
   UNKNOWN; the next run re-sends the **same** identity when the provider
   deduplicates it (`same_identity_repeat_safe`), otherwise resolves it by
   status or opens a case. A provider **decline** of the renewal settles as
   `permanent_fail`; the capture then proceeds on the original authorization
   and the provider decides — a decline there follows the **existing**
   recovery rules (definitive inability to obtain the payment result).
4. **reactive path**: if the capture itself comes back as a provider-declared
   `authorization_unusable` decline (expired/voided hold), the capture identity
   settles as the exact decline (`dispatch_response`, never fenced), the
   binding records the instrument as unusable (so a crash-retry renews first),
   and the rail renews + captures **once** more with a fresh identity. Without
   a renewal path the decline is ingested as `charge_failed` exactly as before.

Renewal happens **only at the payment boundary**. There is no refresh loop, no
cron that re-authorizes to "keep a deal alive", and no sweeper that fails
participants by authorization age.

## 5. Duplication and safety guarantees (proven in `tests/payment_authorization_renewal_lifecycle_validation.ts`)

| Threat | Protection | Proof |
|---|---|---|
| two workers renew concurrently | one `reauthorize` identity per participant (071 guard + `beginProviderAttempt`), owner lease fencing, same-identity re-send only | R5 |
| duplicate provider authorizations | provider-side idempotency-key replay of the durable identity; a `pending`/unknown renewal blocks every rotation | R5, R6, R9 |
| duplicate charges | renewal never touches capture identities; capture rotation still requires a provider-declared failure; 050 cap unchanged | R1, R2 |
| retry after provider success before DB commit | binding + identity commit atomically; a stalled owner's later write is refused (`foreign_owner`) | R5 |
| crash after renewal, before capture | the binding is already current; the retry captures without a second renewal | R5 |
| webhook / synchronous races, late & duplicate events | unchanged ingestion dedupe; events naming the old authorization are ignored | R7 |
| reconcile vs. rail race | in-flight guard is participant-wide; `authorization` reconcile applies the renewal under the participant lock | R6 |
| UNKNOWN | never mutates visible state; deal stays `Charging`, participant stays `ChargeAttempt` | R6 |
| capture / release while the current instrument is unknown | DB guard SN409 | R9 |

Reconcile distinguishes: old authorization expired with no money movement
(binding past validity, no capture identity) · fresh renewal pending
(`reauthorize` unknown) · provider result UNKNOWN (capture identity unknown) ·
charge definitely succeeded · charge definitely failed · recovery required —
all through the existing `payment_reconcile` rail (`operation` now includes
`authorization`).

## 6. What did not change

`DealState`, `BuyerState`, `MoneyState` and their transitions; the 90 %
threshold; the 24 h completion window (C6); the recovery rail; refunds;
release-with-proof; 050 rolling cap; 067/068 lifecycle and settlement fence;
the 8 % fee; no distributor commission; the join-time rule that an
**unconsumed** authorization past its validity cannot back a *new* commitment
(`payment_authorization_expired`, 402 — pre-commitment only; the buyer
re-authorizes and joins again).

## 7. Provider capability boundary

`PaymentProvider.reauthorize?` (optional). `paymentProviderCapabilities().stored_instrument_reauthorization`
reports it; it is **not** a mandatory real-provider capability — without it
the worker dispatches the capture on the original authorization and the
provider decides.

| Provider | `expires_at` declared | `reauthorize` | Note |
|---|---|---|---|
| in-process mock (`mockpay`) | none | yes (deterministic, idempotent) | demo/tests |
| synthetic lab | configurable TTL | yes (scripted) | lifecycle tests |
| provider-ready HTTP | from the payload when present | yes when `PAYMENT_PROVIDER_REAUTHORIZE_PATH` is set (default `/reauthorize`; empty disables) | contract: `POST {payment_method:{type:"stored",id}, amount_minor, currency, reference, replaced_authorization_id}` with `idempotency-key`; answers `authorized`/`pending`/decline |
| Grow | 7 days (documented J5 window, recorded on the binding) | **no — open adapter gap** | `chargeType=3` token + merchant-initiated charge on a token are UNPROVEN; until a sandbox proof exists the capture is dispatched on the original J5 hold and Grow decides (a lapsed hold declines → recovery) |
| Stripe | none declared | **no — open adapter gap** | an off-session PaymentIntent on a saved PaymentMethod needs the method attached to a Customer at authorize time and a sandbox proof; not guessed in repository code |

The **only remaining provider-specific item** for long-horizon deals is the
stored-instrument re-authorization adapter for the real provider that will be
activated (Grow token charge, or Stripe off-session). Everything on the
repository side — schema, identities, rails, reconcile, UI, docs — is
provider-independent and complete.

## 8. Buyer / seller / admin surfaces

* Buyers: their commitment stays with the deal; copy speaks of a held
  authorization without a duration claim; `payment_authorization_expired` and
  `payment_authorization_not_consumable` now have Hebrew copy for the
  pre-commitment case.
* Sellers: the picker accepts long deadlines; hint text no longer names 7 days;
  an advisory notice appears above one year.
* Admins: `/api/admin/outbox-status.payment_maintenance` reports
  `authorizations_past_declared_validity` and `authorizations_renewed` — a
  maintenance signal, explicitly not an alert that a deal is invalid. Long
  deals' `deadline_check` rows are `scheduled_future`, not backlog.
* Runbook: a hold older than the provider's validity on a committed
  participant is **expected** on long deals and is renewed at charging; the
  stop condition is a `payment-reauthorization-*` case or a `reauthorize`
  identity stuck UNKNOWN (`docs/PAYMENT_INCIDENT_RUNBOOK.md` §5).
