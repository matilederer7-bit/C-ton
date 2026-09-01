# R9B — Hosted Grow sandbox E2E proof runbook (EXECUTE ONLY WITH REAL SANDBOX CREDENTIALS)

Status: **BLOCKED — GROW_SANDBOX_CREDENTIAL_BLOCKER.** No Grow sandbox
credentials exist in any environment. Everything below is prepared and waiting;
do not simulate it and call it proof.

## External prerequisites (from Grow support)

1. Sandbox `userId` + `pageCode` for a direct business, with the
   delayed-charge capability (J4/J5, `chargeType=2`) ENABLED on the page.
2. Confirmation whether any additional credential is required for
   `settleSuspendedTransaction` / `refundTransaction` on this account (the
   public endpoint references document none).
3. Confirmation whether the sandbox account permits `refundTransaction`
   against a settled sandbox transaction (for the refund proof).

Official sandbox test card (documented): `4580458045804580` (single payment).
No real payment instrument may be used.

## Environment (staging web + worker services)

Set on BOTH `siton-staging-web` and `siton-staging-worker` (Render env):

```
PAYMENT_PROVIDER=grow
PAYMENT_PROVIDER_MODE=grow
PAYMENT_ENVIRONMENT=sandbox
PAYMENT_PROVIDER_BASE_URL=https://sandbox.meshulam.co.il/api/light/server/1.0
GROW_USER_ID=<from Grow support — sandbox>
GROW_PAGE_CODE=<from Grow support — sandbox>
GROW_REFERENCE_ENCRYPTION_KEY=<fresh random ≥32 chars, staging-only>
GROW_SUCCESS_URL=https://siton-staging-web.onrender.com/pay/return
GROW_CANCEL_URL=https://siton-staging-web.onrender.com/pay/cancel
GROW_NOTIFY_URL=https://siton-staging-web.onrender.com/webhooks/payments/grow
```

Boot guards verify all of this fail-closed (sandbox host required, https
URLs, non-placeholder credentials). Production values must never be entered
here; live credentials on staging are rejected by the guards.

## Proof steps (map 1:1 to the mission list)

1. **Synthetic deal** — create/publish a small staging deal (existing seller
   showcase tooling), price such that qty×price is a clean amount (e.g. 2×10₪).
2. **J5 authorize** — `POST /api/payments/authorize` with deal_id, buyer_id,
   qty, payer_name, payer_phone (05xxxxxxxx synthetic). Verify: response
   `authorization: pending_provider_confirmation`, sealed `grow_ref_v1.`
   authorization_id, hosted `payment_url` under sandbox.meshulam.co.il; DB
   binding row `pending_provider_confirmation` with the server amount.
3. **Hosted completion** — open `payment_url` in a browser; complete with the
   documented sandbox test card only.
4. **Callback** — confirm a `webhook_events` row provider='grow' appeared
   (notifyUrl hit) and that the binding flip happened ONLY via the
   authoritative lookup (status_reason='provider_status_confirmed'); response
   evidence shows `money_from_callback: false`.
5. **Authoritative confirm** — if no callback arrived (sandbox variance):
   `POST /api/payments/status {provider_reference, operation:"authorization"}`
   → state `authorized`, binding `authorized`.
6. **Join** — `POST /deals/:id/join` with the authorization_id → participant
   `AuthHeld`; binding `consumed`, exactly once (a replay must 409/402).
7. **Threshold → charge** — drive the deal through the canonical threshold/
   locking flow (existing staging flow); Worker `charge_deal` performs J4 via
   `settleSuspendedTransaction` with the server amount.
8. **Authoritative confirmation** — `getPaymentProcessInfo`/`getTransactionInfo`
   shows statusCode "2" (שולם); participant `ChargedSuccess`; exactly one
   `platform_fee_money_events` charge row; **8% VAT-exclusive fee invariant;
   seller-net invariant; zero distributor commission**.
9. **UNKNOWN drill (controlled)** — for a second participant, use the
   non-production transport-fault seam (or a controlled egress interruption)
   to lose the settle response after dispatch; verify NO second settle call,
   `payment_reconcile` resolves to exactly one `ChargedSuccess`, one ledger
   row (already proven no-network in
   `grow_payment_sandbox_activation_validation`; repeat hosted only if safe).
10. **Duplicate/late callback** — re-POST the recorded callback body to
    `/webhooks/payments/grow`: must dedupe/evidence-only, no state change.
11. **Refund** — if the account permits sandbox refunds: refund path against
    the settled transaction → `refundTransaction` → `Refunded`, refund ledger
    adjustment, synthetic-internal documents only. If not permitted: record
    exactly that as externally unproven.
12. **Release/expiry** — do NOT invent a void. For an intentionally
    uncaptured hold: verify the release rail reports
    `grow_release_pending_automatic_expiry` + operational case, and record
    **EXTERNAL / TIME-BOUND RELEASE PROOF OPEN**; optionally re-run status
    reconciliation after the documented expiry window to observe and prove
    the release.
13. **Observability** — admin mission-control payments section shows
    environment label GROW SANDBOX, binding counts, callback evidence,
    reconcile/release queues; no secrets/references leaked.
14. **Safety counts** — real money 0 · production Grow calls 0 · real SMS 0 ·
    real email 0 · real invoices 0; every Grow call hit
    sandbox.meshulam.co.il only (assert via provider summary + logs).

Only after ALL of the above with real sandbox credentials:
`R9B_GROW_SANDBOX_CLOSED` → `READY_FOR_R10_CONTROLLED_REAL_MONEY_PROOF`.
