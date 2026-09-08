# Long-horizon deals — implementation checklist

Companion to `docs/LONG_HORIZON_DEALS_ARCHITECTURE.md`. Status legend:
✅ done on `claude/long-horizon-deals-architecture` · ⬜ not started ·
⛔ blocked (see the blocker list).

## S0 — safe, provider-neutral foundations (this branch)

- ✅ `src/deadline_policy.ts`: ONE policy (2 h min; max = proven authorization
  hold = 7 d; 365-day warning; 20-year technical ceiling; provider capability
  input; no environment flag can raise the ceiling)
- ✅ `src/app.ts` create/update validation derives its bounds from the policy —
  behaviour, codes and messages unchanged
- ✅ `web/src/pages/seller.tsx` picker + `validateDeadline` derive from the
  same policy; `LongHorizonWarning` (> 365 d) wired, dormant
- ✅ `tests/long_horizon_deadline_policy_validation.ts`
- ✅ `tests/worker_long_horizon_scheduling_validation.ts` (30 d / 180 d /
  366 d / 5 y / 20 y never due, precision, deferral to the exact deadline)
- ✅ architecture + this checklist; PROJECT_STATUS section

## S1 — financial integration lands on master

- ⬜ `claude/r9c-final-financial-integration` (063 + 064 appended after the
  applied 065) reviewed and merged; long-horizon migrations start at **066**
- ⬜ re-run the worker long-horizon proof on the merged tree

## S2 — provider proof (choose one path)

- ⛔ Grow sandbox credentials (`userId`, `pageCode`) → record
  `createPaymentProcess chargeType=3` (token) request/response, token
  lifetime, the exact charge-on-token call, decline codes, expiry metadata —
  in `docs/` with the same rigor as R9B J4/J5
- ⬜ or: a provider with a documented card-on-file / MIT contract; adapter
  behind the existing `PaymentProvider` interface (`tokenize` slot exists)
- ⬜ flip `CURRENT_PROVIDER_DEADLINE_CAPABILITIES.stored_payment_authority_proven`
  ONLY with that evidence linked

## S3 — mandate rail

- ⬜ migration 066 `payment_mandates` (+ partial unique active mandate,
  sealed reference, expiry month, last4, ceiling, consent version)
- ⬜ migration 067 transition allow-lists (`NoFinancial → ChargeAttempt` via
  `mandate.charge`), outbox event types `mandate_validate`, `mandate_reminder`
- ⬜ join path for long-horizon deals: commitment + mandate (no hold)
- ⬜ charging at the deadline: one mandate charge per participant through the
  063 lifecycle; settlement horizon per provider; recovery/drop unchanged
- ⬜ retired mandates never charged (query + index + mutation test)
- ⬜ fee 8% on the charge base incl. delivery excl. VAT — same helper

## S4 — buyer re-authorization UX + notifications

- ⬜ tracking page mandate state ("אמצעי התשלום שמור ותקף" / "נדרש לעדכן
  אמצעי תשלום") + "עדכון אמצעי תשלום" flow (recovery-purpose token + OTP →
  new mandate → old retired)
- ⬜ `mandate_validate` jobs at expiry − 30 d and deadline − 14 d
- ⬜ real e-mail/SMS (today 0) — re-auth reminders; `notifications_are_real`
- ⬜ buyer copy: commitment vs stored authority vs actual charge vs possible
  update (§14 of the architecture); never "המסגרת נשמרת"

## S5 — policy switch

- ⬜ `resolveDeadlinePolicy` returns `stored_payment_authority` for the proven
  provider; server + picker follow automatically; re-pin
  `tests/backend_sanity_suite.ts:108,125`; update `MONEY_PILOT_SCOPE.md`,
  `PILOT_DEAL_TEMPLATES.md`, `PILOT_LAUNCH_RUNBOOK.md`, `he.ts` messages
- ⬜ completion window for long deals (two-phase) via `COMPLETION_WINDOW_MINUTES`
  or a per-deal value

## S6 / S7 — pilot then lift

- ⬜ first long-horizon pilot capped at 60–90 days by the policy input
- ⬜ lift to years after one full cycle with real charges and re-auths

## Blockers (exact)

1. Grow sandbox credentials (R9B `GROW_SANDBOX_CREDENTIAL_BLOCKER`)
2. Token / merchant-initiated charge UNPROVEN
3. 063/064 not on master
4. Notifications are log-only
5. Legal mandate consent text/version
6. Owner decisions: withdrawal before close; window length; pilot cap

`REAL_MONEY_EXECUTED = 0`.
