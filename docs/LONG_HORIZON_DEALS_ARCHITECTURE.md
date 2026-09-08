# Long-horizon deals — charging architecture (owner item 8)

Branch `claude/long-horizon-deals-architecture` from exact master `d4c7877`.
Deep architecture + safe, provider-neutral foundations only. **Real money
executed by this work: 0.** Grow, capture, settlement, refund, reconciliation
and the financial migrations 063/064 are untouched (they are not even on
master — see §13).

Owner intent: a seller may open a deal that lasts weeks, months or more than a
year; no arbitrary 7-day calendar cap; a strong (not blocking) warning beyond
one year that cards may expire, be replaced or blocked and that some buyers
may have to update their payment method before the deal completes.

The correct question is NOT "a webhook that contacts the card again" (a
webhook is an inbound notification; it can never create a charge). The
question is: **what legally, contractually and technically valid authority
does Siton retain today so that ONE future charge can be executed months
later, and how does the product behave when that authority decays?**

---

## 1. Current 7-day constraint map (exact inventory)

Every assumption tied to the short deadline, with its reason and whether it may
change without touching financial truth.

| # | File : symbol | Current assumption | Why it exists | Safe to change? | Dependencies |
|---|---|---|---|---|---|
| 1 | `src/app.ts` `DEADLINE_MIN_MS` / `DEADLINE_MAX_MS` / `DEADLINE_DEFAULT_MS` (now derived from `src/deadline_policy.ts`) | create + Draft update: `2 h ≤ deadline − now ≤ 7 d`, codes `deadline_below_minimum` / `deadline_above_maximum`, messages "at least 2 hours" / "within 7 days" | spec D3 (SPEC_DRIFT_MAP D3) **and** the join-time hold lifetime (§2) | server validation — presentation of a FINANCIAL bound. Numbers must not move until §4's model exists | `tests/backend_sanity_suite.ts:108,125` pin the messages; `docs/PILOT_DEAL_TEMPLATES.md`, `PILOT_LAUNCH_RUNBOOK.md`, `MONEY_PILOT_SCOPE.md:47` state the limit |
| 2 | `web/src/pages/seller.tsx` `DeadlinePicker` (`max` date) + `validateDeadline` (now via `classifyDeadline`) + hint "בין שעתיים ל-7 ימים" | picker refuses > 7 d | mirror of #1 | presentation-only — NOW derived from the same policy (no duplicated constant) | `web/src/he.ts:33-35` messages |
| 3 | `src/app.ts` publish: `deadline_check` outbox row with `available_at = deadline` | the deal decision job is scheduled AT the deadline | correct for any horizon | already horizon-agnostic — proven to 20 years (§7) | `ux_outbox_one_pending_per_aggregate_event` |
| 4 | `src/app.ts` `deadline_check` handler | defers (`DeferredEventError`, `available_at = deadline`) while `now < deadline`; fails the deal only after | protects freshly published deals from an early worker | horizon-agnostic — proven (§7) | `outbox_worker_helpers.ts` deferred path requires `retryAt > now` |
| 5 | `src/outbox_worker_helpers.ts` claim query `status='pending' AND available_at <= clock_timestamp()` + `idx_outbox_claimable (available_at, created_at) WHERE status='pending'` | only due rows are claimed | queue semantics | horizon-agnostic — proven; the partial index keeps future rows cheap | — |
| 6 | `src/frontend_runtime.ts` `/api/admin/outbox-status`: `scheduled_future_count` vs `due_now_count`, `next_scheduled_in_s` | future rows are SCHEDULED work, not backlog | R4 worker observability | already sound for long horizons — proven | Mission Control blockers read `due_now`, not `pending` |
| 7 | worker reclaim (`WORKER_STUCK_TIMEOUT_MS` 60 s, lease 60 s) | recycles stuck `processing` rows | crash recovery | irrelevant to scheduled rows (they are `pending`, not `processing`) | — |
| 8 | `deals.deadline TIMESTAMPTZ` + trigger "deals.deadline is immutable after publish" (008) | any instant representable | correctness | representability to 294276 AD; the trigger is a product rule (a long deal would still be immutable) | — |
| 9 | **`money_state` `AuthHeld`** (join → `NoFinancial → AuthHeld`), `AuthLocked` (ClosedForJoining), `ChargeAttempt` (Charging) | one join-time authorization HOLD carries the buyer's obligation until the deal decides | the only money authority the product has | **financial semantics — NOT safe to stretch.** A hold is a provider-side reservation with a provider-defined lifetime | R9A/R9C rails, migrations 053/063/064 |
| 10 | `src/grow_payment_adapter.ts` (comments 28-29, 531-532) + `docs/R9B_GROW_SANDBOX_ACTIVATION.md:25` | J5 "Suspended Charge" is valid **up to 7 days**; without a J4 settle it **auto-releases after ~10 days**; `chargeType=2` | the official Grow contract (verified 2026-09-01) | **provider fact — cannot be changed by Siton** | this is the root of #1 |
| 11 | `src/payment_provider.ts` mock authorize | `hold_message: "Authorization accepted. Final capture happens only if the deal completes successfully."` — no expiry modelled | demo provider | mock only; must not be read as proof that holds survive | — |
| 12 | `src/payment_binding.ts` `expires_at` (053) | a hosted-authorization binding may carry an expiry, enforced at consume (join) time (`payment_authorization_expired`, 402) | R9A binding rail | already models expiry; no writer sets it for Grow today (null) | migration 053 |
| 13 | `COMPLETION_WINDOW_MINUTES` = 1440 (`runtime_config.ts:20`, `app.ts:122`) | 24 h after Charging → CompletionWindow for buyers to fix a failed charge | spec C6 | product rule; independent of the deadline horizon, but the long-horizon recovery flow (§8/§10) needs a longer or two-phase window | recovery rail |
| 14 | `src/payment_reconciliation.ts` / reviewed 064 `settlement_horizon_at` (provider-specific, extended by pending reads, default 24 h) | how long a DISPATCHED capture may still settle | R9C remediation | unrelated to the deadline horizon (it starts at dispatch), must stay | 063/064 (not on master) |
| 15 | `docs/MONEY_PILOT_SCOPE.md:47` "Maximum duration: 7 days from publish to completion/failure", `PILOT_DEAL_TEMPLATES.md:12,77,91,102`, `PILOT_LAUNCH_RUNBOOK.md:138`, `LAUNCH_GAP_REPORT.md A-8` ("some sellers will ask for 10–14"), `SPEC_DRIFT_MAP D3` | documentation of the cap | pilot scope | docs — update with the model | — |
| 16 | `tests/backend_sanity_suite.ts:108,125` | 1 h → 400 "at least 2 hours"; 8 d → 400 "within 7 days" | pins #1 | must be re-pinned when #1 changes | — |
| 17 | notifications (`src/notification_templates.ts`) | no reminder schedule relative to the deadline exists | log-only rail | nothing to change; the long-horizon model ADDS notification requirements (§9) | — |
| 18 | mobile (`android/`, `ios/`, `docs/MOBILE_APP_RELEASE_READINESS.md`) | no deadline limit encoded | Capacitor shell of the web | nothing | — |
| 19 | Supabase (`supabase/staging/001_siton_inventory_v1.sql`) | no deadline constraint | inventory only | nothing | — |
| 20 | `seller_analytics.ts` periods 7d/30d/90d/year/all | analytics windows | unrelated to deal deadline | nothing | — |

**Count: 20 assumption sites; 2 are financial truth (#9, #10), 1 is a provider fact, 6 are already horizon-agnostic and proven, the rest are presentation/docs/tests.**

## 2. Why a temporary authorization cannot simply be stretched

* A J5 hold is a **reservation against the card's credit line** that the
  issuer keeps for a bounded time. Grow documents 7 days of validity and an
  automatic release after ~10 days. No API call extends it; the only way to
  "keep" it is to capture (J4), which is a real charge — the exact thing the
  product must NOT do before the deal decides.
* Renaming `AuthHeld` or lengthening the deadline changes nothing at the
  issuer: on day 11 the hold is gone, `money_state` would still say
  `AuthHeld`, and at the deadline every capture would fail (or worse, the
  reconcile rail would read "no active hold" → `AuthReleased`). The deal would
  "succeed" on paper with zero charged units — violating the invariant that a
  successful deal is one with actual successful charges.
* Re-authorizing periodically (a new J5 every 7 days) is not viable either:
  each re-authorization needs the cardholder present on a hosted page (Grow's
  J5 is a hosted flow), it would burn credit line repeatedly, and every gap
  between holds is an uncovered obligation.
* Therefore the long-horizon model needs a DIFFERENT kind of authority: not a
  reservation of funds, but a durable **permission to charge later**.

## 3. Grow capabilities — proven vs unproven (repository evidence only)

| Capability | Status | Evidence |
|---|---|---|
| J5 authorization (chargeType=2) at join, hosted page | **PROVEN at the transport boundary** (sandbox creds still missing) | `grow_payment_adapter.ts`, `docs/R9B_GROW_SANDBOX_ACTIVATION.md` §"Official Grow contract" |
| J5 validity ≤ 7 days, auto-release ~10 days | **PROVEN (documented contract fact)** | R9B doc row "J5 window" |
| J4 settle by transaction credentials (`settleSuspendedTransaction`) | PROVEN contract, external execution pending | R9B doc |
| Authoritative status lookup (`getPaymentProcessInfo` / `getTransactionInfo`) | PROVEN contract | R9B doc |
| Refund (`refundTransaction`) | contract implemented; **sandbox proof open** | R9B blocker 3 |
| Callback (`notifyUrl`) | PROVEN: unsigned, informational, **never money** | R9B doc |
| **Tokenization / saved payment method** (`chargeType=3` "Create Token") | **UNPROVEN** — the option is named in the createPaymentProcess table but nothing in the repository proves what the token is, how long it lives, how it is charged, or whether it needs cardholder presence | R9B doc row createPaymentProcess (name only) |
| **Merchant-initiated future charge on a token** ("token transactions" are mentioned only as an exclusion for `approveTransaction`) | **UNPROVEN** — no endpoint, no field, no test | `grow_payment_adapter.ts:36-40` |
| Recurring billing / הוראת קבע (`stopDirectDebit` appears as a refund parameter only) | **UNPROVEN** | R9B doc row refundTransaction |
| Long-lived authorization (> 7 days) | **DISPROVEN** by the documented window | R9B doc |
| Account updater / replaced-card continuity | **UNPROVEN / no evidence** | grep `account updater`, `card update` → none |
| Failed-card recovery on a token | **UNPROVEN** | — |
| Provider-side card-expiry notification | **UNPROVEN** | — |

Nothing here is invented: every "UNPROVEN" row stays UNPROVEN until a Grow
sandbox account (blocker `GROW_SANDBOX_CREDENTIAL_BLOCKER`) lets the exact
request/response be recorded in `docs/` the way R9B recorded J4/J5.

## 4. Recommended target financial model

**Separate the buyer's COMMITMENT from the money AUTHORITY, and make the
authority a stored-instrument mandate rather than a funds reservation.**

```
join (any horizon)
  └─ Commitment           buyer_state: Joined…  (unchanged rail)
  └─ Payment authority    NEW rail: payment_mandates (per buyer × deal)
        mandate_state:
          PaymentMethodStored      a provider token / stored instrument exists,
                                   verified by a ZERO-or-minimal-amount
                                   verification (or a 1-day J5 that is released)
          FutureChargeAuthorized   the buyer explicitly accepted a merchant-
                                   initiated future charge for THIS deal
                                   (amount ceiling, purpose, latest date) — the
                                   legal mandate
          MandateValid             periodic/pre-charge validation says the
                                   instrument is still usable (expiry month in
                                   the future, provider says active)
          ReauthorizationRequired  detection says it will not work (expired,
                                   replaced, declined verification, token
                                   invalidated) — buyer must update
          MandateRetired           replaced by a newer mandate, or deal ended

deal decides (deadline) → Charging
  └─ short-horizon deals (≤ proven hold): capture the J5 hold (today's rail)
  └─ long-horizon deals: ONE merchant-initiated charge per participant on the
     mandate → the SAME money_state machine from ChargeAttempt onwards
     (ChargedSuccess / ChargeFailedRecovery / RecoveredCharge / Dropped),
     the same 063/064 lifecycle + settlement horizon, the same recovery rail.
```

Why this shape:

* `AuthHeld` keeps its exact meaning (a live funds reservation) for the
  short-horizon path — **no canonical enum is mutated** on master. The
  long-horizon path enters the money machine at `ChargeAttempt` from a
  distinct mandate rail, so both paths share every post-dispatch invariant
  (durable operation lifecycle, settlement horizon, recovery, refund).
* The semantic need for NEW names is proven by §2: a reservation and a mandate
  have different lifetimes, different failure modes (a mandate fails at charge
  time, a hold fails silently by expiring) and different legal texts. Reusing
  `AuthHeld` for a mandate would make "the framework is held" a false
  statement for a year.
* The mandate rail is provider-neutral: for Grow it maps to
  `chargeType=3` + a token charge **only once proven**; for a provider with
  MIT/stored-credential support (card-on-file with CIT/MIT flags) it maps to a
  saved payment method. Until a mapping is proven, `stored_payment_authority_proven`
  stays `false` in `src/deadline_policy.ts` and the deadline ceiling stays at
  the proven hold.

## 5. Buyer state implications

* Joining a long-horizon deal is a **commitment + mandate**, not a payment
  and not a reservation. Buyer copy must say exactly that (§14).
* Buyer states are unchanged in vocabulary; a new sub-status on the tracking
  page reflects the mandate: "אמצעי התשלום שמור ותקף" / "נדרש לעדכן אמצעי
  תשלום" (from `ReauthorizationRequired`).
* A buyer who cannot be reached and never updates a dead mandate is treated
  exactly like a failed charge in the completion window today: `Dropped`
  after the window, units released back to the pool (§10).
* Withdrawal: because no funds are reserved, a long-horizon deal must let a
  buyer withdraw before the deal closes joining (today withdrawal semantics
  are deal-state driven; the mandate simply retires). Product decision to
  record, not a rail change.

## 6. Money state implications

* `NoFinancial → AuthHeld` (join) is replaced, for long-horizon deals, by
  `NoFinancial` money state + `payment_mandates` row; the money machine is
  entered at Charging: `NoFinancial → ChargeAttempt` via the mandate charge
  (new transition, new `action_name` in the trigger allow-list — a migration).
* `AuthLocked` (ClosedForJoining) has no equivalent for mandates: nothing to
  lock; the mandate's `latest_charge_at` (= deadline + completion window) is
  the lock.
* The 8% Siton commission, delivery inclusion and VAT exclusion are computed at
  charge time from the authoritative charge base exactly as today — **fee
  invariant untouched**. No distributor commission exists or returns.
* `AuthReleased` is never produced for a mandate; `MandateRetired` is the
  analogue and moves no money.
* Every charge, recovery, refund keeps the 063 durable lifecycle
  (`dispatch_state`, owner lease) and the 064 settlement horizon + negative
  finality authority. A mandate charge is just another `capture`-class
  operation with `payment_attempts` rows.

## 7. Worker / deadline scheduling implications (PROVEN on this branch)

`tests/worker_long_horizon_scheduling_validation.ts` (workers group):

* pending `deadline_check` rows at +30 d, +180 d, +366 d, +5 y, +20 y are
  **never claimed** by the real claim helper while a due row is; they stay
  `pending`;
* `/api/admin/outbox-status` counts them as `scheduled_future`, not
  `due_now`; `next_scheduled_in_s` reports the nearest (30 d), never a backlog
  age — Mission Control's queue blockers read `due_now`;
* `timestamptz` keeps millisecond precision across the round trip at 20 years
  (no overflow, no rounding);
* the `deadline_check` handler on a deal whose deadline is 366 days ahead
  **defers** the row back to `pending` with `available_at = deadline` (the
  deferred path, not the exponential backoff), leaves the attempt budget
  alone and the deal `PendingTarget`; the row is not claimable until then.
  Finding: the handler parses the deadline via `new Date(String(deal.deadline))`,
  which drops the sub-second part of a pg `Date`, so the deferral lands on
  the deadline's second (≤ 999 ms early). Irrelevant at a one-year horizon;
  fix in S3 with `new Date(deal.deadline).getTime()` (not changed here — the
  worker handler is left byte-identical on this branch).

Consequences: no cron spam (one row per deal, dormant), the partial index
`idx_outbox_claimable` keeps future rows out of the hot set, cleanup jobs
touch `sent/failed` rows only. Two additions the long model needs:
`mandate_validate` jobs (§8, scheduled at expiry-month − 30 d and at
deadline − 14 d) and a reminder job — both are ordinary outbox rows with a
future `available_at`, which this proof already covers.

## 8. Card expiry / replacement / failure — designed behaviour

| Event | Detection | Effect |
|---|---|---|
| card expiry month before the deadline | known at mandate creation (expiry from the provider token metadata — needs proof) → `mandate_validate` job at expiry − 30 d | `ReauthorizationRequired` + buyer notification (§9) |
| card replaced (same account) | provider account-updater — **UNPROVEN**; otherwise surfaces as a declined validation or a declined charge | `ReauthorizationRequired` |
| card cancelled / token invalidated | validation or charge decline with a permanent code | `ReauthorizationRequired`, then the completion window (§10) |
| provider declines the future charge at the deadline | `ChargeAttempt → ChargeFailedRecovery` (existing rail) | recovery window; buyer updates method → `RecoveredCharge` |
| buyer changes payment method proactively | buyer opens the tracking link → "עדכון אמצעי תשלום" → new mandate → old `MandateRetired` | no money moves |
| buyer cannot be reached | reminders unanswered | after the completion window: `Dropped`, units return to the pool; the deal decision recomputes threshold (§10) |
| some buyers succeed, some fail; threshold reached at deadline but charges drop below the required units | existing CompletionWindow semantics: the deal completes only if charged units ≥ threshold at the end of the window; otherwise Failed and successful charges are refunded (existing `refund_issue` rail) | **atomicity preserved**: success = actual successful charges |

Nothing here weakens the invariant "no successful deal without successful
charges": a mandate never counts as money.

## 9. Payment update / re-authorization flow (buyer recovery UX)

1. **Detection** — `mandate_validate` job (scheduled; zero-amount or
   provider status check, exact call UNPROVEN for Grow) or a charge decline.
2. **Reaching the buyer** — the tracking link is the identity the product
   already has (hashed, purpose-scoped token, `participant_tracking_security.ts`
   purposes `tracking|recovery|support`); the notification rail is log-only
   today (`notifications_are_real=false`), so the design REQUIRES real
   e-mail/SMS before long-horizon deals can go live (blocker, §17). The
   tracking page itself shows the state on every visit.
3. **Identity verification** — the recovery-purpose tracking token + the
   existing OTP rail (phone) before a new mandate is created; the seller is
   never involved.
4. **Replacing the token** — a NEW provider tokenization (hosted page), a new
   `payment_mandates` row (`FutureChargeAuthorized` after explicit consent
   with the same ceiling), the old row `MandateRetired` in the same
   transaction; the old token is never charged again (retired rows are
   excluded by the charge query and by a partial unique index "one active
   mandate per participant").
5. **Timing** — the deal deadline does NOT pause (it is the seller's
   commercial promise). The recovery lives in the completion window: today
   24 h; for long-horizon deals the recommendation is a two-phase window —
   pre-deadline validation (14 days before) + a post-deadline window of 72 h
   — `COMPLETION_WINDOW_MINUTES` is already an env-driven parameter.

## 10. Recovery / completion-window interaction

Charging at the deadline for a long-horizon deal = one mandate charge per
participant → the existing outcomes: `ChargedSuccess`, `ChargeFailedRecovery`
(→ buyer update → `RecoveredCharge`), or `Dropped` when the window ends. The
deal finalizes exactly as today (`finalize_not_ready_yet` deferral until
`completion_window_until`, then `Completed` if charged units ≥ threshold else
`Failed` + refunds). The only change is WHEN buyers are warned: before the
deadline (validation) instead of only after a failed capture.

## 11. Security / PCI / privacy

* Never raw card data. Only provider tokens/references, sealed exactly like
  today's Grow references (AES-256-GCM `sealGrowReference`, redaction
  `redactGrowLog`), stored in a new table, never in `participants`.
* Logs: reference redaction already covers `token|cardsuffix|cardexp|…`; the
  mandate table stores expiry month/year and last-4 for UX only if the
  provider returns them (PCI allows) — never PAN, never CVV.
* Admin/support: show mandate STATE and last-4 at most; no token display; no
  "charge now" button outside the worker rail (`requireAdminMutation` +
  audit as for `charging.start`).
* Webhooks: Grow's callback is unsigned and never money — mandate state
  changes only from authoritative lookups or the buyer's own action.
* Idempotency/replay: mandate charges use the 063 durable lifecycle
  (one identity per logical operation, owner lease, SN409 guards).
* Seller visibility: sellers see participant counts and money states — never
  instrument details (today's `contact_privacy: admin_only` posture).

## 12. Migrations potentially required (NOT written)

1. `payment_mandates` table (participant_id, buyer_id, deal_id,
   provider_code/mode/environment, sealed instrument reference, instrument
   expiry month, last4, `mandate_state`, `ceiling_amount_minor`, currency,
   `latest_charge_at`, consent version + timestamp, `created_at`,
   `retired_at`) + partial unique "one active mandate per participant".
2. Money-state transition allow-list: `NoFinancial → ChargeAttempt` via
   `mandate.charge` action (trigger 008/010 canonical lists).
3. New outbox event types `mandate_validate`, `mandate_reminder` in the
   event-type CHECKs (014/045/051/053 lists).
4. `deals.horizon_mode` (`short|long`) or derive from deadline − published_at
   (derivation preferred: no column).
5. Legal acceptance type `future_charge_mandate` in `legal_policy_versions`
   (`siton.legal_acceptances`).

## 13. Migration-number collision considerations (exact)

* master `d4c7877`: migrations up to **061**, then **065** (position 58,
  APPLIED on staging). 062–064 do not exist on master.
* reviewed financial branch `codex/r9c-final-financial-review` @ `3809b32`
  (base `8ead7c8`, 8 commits behind master, 41 ahead): adds **063** and **064**
  and DELETES 065 (the branch predates it) — the review itself flags
  "current-master 065 position collision is REAL_RISK".
* Therefore: the long-horizon migrations must be numbered **066+** and must
  not assume 063/064 exist; the mandate charge MUST reuse the 063 lifecycle
  columns once 063/064 are integrated — so the long-horizon runtime work
  depends on the financial integration landing first (`payment_attempts`
  `dispatch_state`, `settlement_horizon_at`, `negative_finality_authoritative`).
* This branch adds NO migration. Its safe foundations (policy module, tests,
  picker) are numberless by design.

## 14. UX warning > 1 year

Copy (Hebrew, meaning preserved from the owner):

> **שימו לב:** העסקה מוגדרת לטווח ארוך. לאורך זמן כרטיסי אשראי עלולים לפוג,
> להתחלף או להיחסם, ולכן חלק מהמשתתפים עשויים להידרש לעדכן אמצעי תשלום לפני
> השלמת העסקה.

Implemented as `LongHorizonWarning` in `web/src/pages/seller.tsx`, driven by
`classifyDeadline(...).long_horizon_warning` (strictly > 365 days). Dormant
today because the runtime ceiling is 7 days; it renders the moment the policy
admits such a date. No hidden 365-day hard cap: the only ceiling beyond the
proven hold is the technical 20-year sanity bound (`LONG_HORIZON_TECHNICAL_MAX_MS`).
Buyer-facing truth for long deals (§11 of the mission): distinguish "התחייבות
להצטרפות" / "אמצעי תשלום שמור" / "חיוב בפועל בסיום" / "ייתכן שתידרשו לעדכן
אמצעי תשלום" — never "המסגרת נשמרת שנה", never "מחויב עכשיו", never
"התשלום מובטח".

## 15. Staged implementation plan

See `docs/LONG_HORIZON_DEALS_IMPLEMENTATION_PLAN.md` (checklist). Stages:
S0 foundations (this branch) → S1 financial integration lands (063/064 on
master) → S2 provider proof (Grow token/MIT or another provider) → S3 mandate
rail + migrations 066+ → S4 buyer re-auth UX + real notifications → S5 policy
switch (`stored_payment_authority_proven=true` per provider) → S6 pilot with a
capped horizon (e.g. 60 days) → S7 lift to years.

## 16. Test plan

* Unit/integration: `tests/long_horizon_deadline_policy_validation.ts`
  (classification at 30/180/366 days and years under both policies; exact
  365-day threshold; runtime API unchanged; no ceiling flag; source pins) —
  **on this branch**.
* Workers: `tests/worker_long_horizon_scheduling_validation.ts` — **on this
  branch** (§7).
* S3+: mandate state machine transitions (DB triggers), one-active-mandate
  uniqueness, retired tokens never charged (mutation test), charge at deadline
  enters `ChargeAttempt` with the 063 lifecycle, settlement horizon applies,
  recovery/drop within the window, atomicity (deal success ⇔ charged units ≥
  threshold), refund of partial successes on failure, fee 8% on the charge
  base incl. delivery excl. VAT, PII/token redaction in logs, admin never sees
  tokens, seller never sees instrument data, idempotent re-auth, replay of
  provider callbacks moves no money, fuzz/soak of the mandate charge under the
  existing financial harness.

## 17. Exact blockers before real-money activation of long-horizon deals

1. `GROW_SANDBOX_CREDENTIAL_BLOCKER` — no sandbox `userId`/`pageCode`
   (R9B) → nothing about tokens/MIT can be proven.
2. Grow tokenization + merchant-initiated charge **UNPROVEN** (or choose a
   provider with a documented card-on-file MIT contract).
3. Financial integration of 063/064 onto master (`claude/r9c-final-financial-integration`
   → Codex Astra review) — the mandate charge must ride the durable lifecycle.
4. Real notifications (e-mail/SMS) — today 0; re-auth cannot reach buyers.
5. Legal: a future-charge mandate consent text + version
   (`legal_policy_versions`) reviewed by counsel; buyer copy §14.
6. Owner decisions: withdrawal before close, completion window length for
   long deals, whether to cap the first pilot at 60/90 days.
7. `REAL_MONEY_EXECUTED = 0` stays until every item above is closed.
