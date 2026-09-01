# R9B — Grow Sandbox Activation (official contract implementation)

Stage scope: implement the REAL Grow (formerly Meshulam) sandbox behind the
provider-neutral R9A financial architecture, against the OFFICIAL current Grow
documentation, and prove it end-to-end. Sandbox only — no production Grow
calls, no real money, no real card, no real SMS/email/invoices.

Safety counts for the stage: real money 0 · Grow production calls 0 ·
real SMS 0 · real email 0 · real invoices 0. Grow SANDBOX network calls: 0 so
far (no sandbox credentials exist yet — see the credential blocker below);
every proof runs the full application stack against the documented Grow
protocol at the transport boundary.

## Official Grow contract — verified 2026-09-01

Source: https://developers.grow.business/ (the "Grow Payments" documentation
center; content served from grow-il.readme.io). Verified facts used by the
implementation:

| Fact | Official source finding |
|---|---|
| Sandbox base | `https://sandbox.meshulam.co.il/api/light/server/1.0/` (reference pages; each environment has its own identifiers) |
| Auth params | `userId` + `pageCode` identify the business/payment method. **No `apiKey` parameter is documented** for the endpoints below — the adapter does not transmit `GROW_API_KEY` (env var kept for future Grow-support-instructed use). |
| createPaymentProcess | POST form; `chargeType` 1=Regular, **2=Suspended Charge (J4/J5)**, 3=Create Token; `sum`, `successUrl`/`cancelUrl` (https), `notifyUrl`, `pageField[fullName]`/`[phone]`/`[email]`, `cField1..9`, `paymentNum`. Server-side only; browser calls are blocked by Grow. |
| J5 window | "J5 transactions have a timeframe of up to 7 days" — matches Siton's 7-day max deal deadline. "If no J4 transaction is made, J5 will automatically release after 10 days." Manual cancel = "J4 transaction and an immediate refund" (moves real money — NOT automated by Siton). |
| getPaymentProcessInfo | POST form `{pageCode, processId, processToken}`; response nests `data.transactions[]` (array of transaction objects with `transactionId/transactionToken/statusCode/status/sum/...`). |
| getTransactionInfo | POST form `{pageCode, transactionId, transactionToken}`. |
| settleSuspendedTransaction (J4) | POST form `{userId, transactionId, transactionToken, sum}` — identified by **transaction** credentials, NOT process credentials. |
| refundTransaction | POST form `{userId, transactionId, transactionToken, refundSum[, pageCode, stopDirectDebit]}`. |
| approveTransaction | Official quote: *"Do not send this request in the case of token transactions … or delayed transactions (J4J5)."* → **Siton never calls approveTransaction in the J4/J5 flow.** |
| notifyUrl callback | Plain form POST (same encoding as requests, "NOT as JSON"); retried on failure (10/20/30-minute schedule); example delayed-payment callback carries `statusCode: 11`, `status: "עסקה מושהית"`. **No signature/HMAC/shared-secret is documented** — origin cannot be authenticated. |
| Status codes | `"11"` = suspended (J5 authorized) · `"2"` = שולם (paid/captured) · failure-family codes map to failed. Undocumented codes remain honestly `pending`/`unknown`. |
| Sandbox testing | Test cards `4580458045804580`, `4580000000000000`, `4580111111111121`; bank 41/410/411111111. **Bit / Google Pay / Apple Pay have NO sandbox** (live-only) → their activation stays deferred; PayBox is production-only. The `updateMyUrl` callback-testing facility named in older material is not present in the current documentation sitemap. |

## What R9B changed

### Adapter contract alignment (`src/grow_payment_adapter.ts`)

The R9A adapter skeleton guessed three contract details that the official
documentation contradicts; all fixed:

1. **J4 settle identifiers** — settle now sends
   `{userId, transactionId, transactionToken, sum}` (was: pageCode +
   processId/processToken). When the sealed reference carries only process
   credentials, capture first performs a READ-ONLY `getPaymentProcessInfo`
   lookup to resolve the transaction credentials (never money I/O); an
   unresolvable reference is a safe bounded `temporary_fail`
   (`grow_capture_transaction_reference_missing`) — no settle is attempted.
2. **Status response shape** — `getPaymentProcessInfo` responses are parsed as
   `data.transactions[]`; `getTransactionInfo` stays flat. The authoritative
   transaction is selected with capture-proof dominance
   (captured > refunded > authorized > failed), never optimistically. The
   refreshed sealed reference gains the transaction credentials.
3. **apiKey** — no longer transmitted (undocumented for these endpoints).

Plus: refund uses `{userId, transactionId, transactionToken, refundSum,
pageCode}` per the official reference; `assertGrowConfig` enforces
bidirectional sandbox/live host separation (sandbox env ⇔
`sandbox.meshulam.co.il` only; live env may never use the sandbox host) —
mirrored in `production_guards.ts` at boot; callback normalization extracts
`cField1` (Siton correlation) and `sum` and always reports
`requires_authoritative_lookup: true` / `trusted_money_state: null`.

The application transport boundary is injectable ONLY outside production-like
deployments (`globalThis.__SITON_GROW_TEST_TRANSPORT__`), which is how the
UNKNOWN/transport-loss proofs run the real app code with zero network.

### Grow-native provider capabilities (`src/payment_provider.ts`)

`buildGrowCanonicalPaymentProvider` now implements the full mandatory native
contract, so Grow can boot in a real provider environment (the R9A fail-closed
startup gate now passes on capabilities and continues to fail closed on
configuration):

- **`release`** — HONEST: Grow documents **no native J5 void**. The documented
  manual cancel (J4 + immediate refund) moves real money and is NOT used as an
  automatic strategy. `release` only OBSERVES authoritative provider truth via
  status lookup: provider-declared failed/refunded (no active hold) → release
  proof; still-suspended hold → durable `permanent_fail`
  (`grow_release_pending_automatic_expiry`) so the R9A release rail keeps the
  hold represented as held and opens a visible operational case. `AuthReleased`
  is unreachable without authoritative proof. Automatic expiry (~10 days,
  documented) is observed via later reconciliation — see "externally open".
- **`verifyWebhook`** — structural only, BY CONTRACT: the official callback has
  no signature, so origin authentication is impossible; verification checks a
  parseable form/JSON body carrying the server-owned process credentials. This
  is safe because a Grow callback can never move money (below). If Grow ever
  documents a native authentication mechanism it must be implemented here.
- **`parseWebhookEvent`** — maps callbacks ONLY to non-money event types
  (`payment_authorized` / `payment_failed` / `grow_callback_hint`); a Grow
  callback can NEVER produce `charge_captured`/`recovery_captured`/
  `refund_issued`/`charge_failed`/`recovery_failed`. Money truth flows solely
  through the authoritative status lookup on the reconcile rail.
- **`configurationDetail`** — secret-free capability/honesty summary surfaced
  in `getPaymentProviderSummary().provider_detail` (sandbox flag, release
  strategy, callback trust posture, approve policy, settle identifier).

### Callback route (`/webhooks/payments/grow`, `src/frontend_runtime.ts`)

Dedicated notifyUrl target (form-encoded and multipart field parsing added;
raw body preserved). Behavior: structural validation → correlation to an
existing server-owned binding via `cField1` (uncorrelated callbacks are
recorded as security events and create no work) → deduplicated evidence via
the webhook ingestion rail → for a pending binding, an IMMEDIATE authoritative
server→Grow status lookup which alone may flip the binding to `authorized`
(amount contradiction fails the binding closed) → post-authorization callbacks
are evidence-only (the Worker reconcile rail owns money). Duplicates return
`duplicate: true`; every response carries `money_from_callback: false`.

The shared `/webhooks/payments` route now gives provider-native verification
precedence over the generic HMAC contract (Stripe manages its own signed
header; Grow is structural; a provider requiring native verification with none
implemented still fails closed).

### Fixed R9A defect surfaced by the new proofs

`confirmBindingAuthorized` wrote `status='failed' /
provider_amount_mismatch` and then threw INSIDE the same transaction — the
fail-closed write rolled itself back, leaving the binding pending.
Restructured (`src/payment_binding.ts`) so fail-closed writes commit and the
typed error is thrown after the transaction. Added
`getBindingByCorrelation` (lookup-only) for callback correlation.

### Admin observability (`src/admin_mission_control.ts`)

The payments section now reports: provider environment +
`environment_label` ("GROW SANDBOX" vs "REAL MONEY / PRODUCTION"),
`provider_detail` (release strategy, callback trust, approve policy — no
secrets), `capability_gaps` / `real_activation_ready`, authorization-binding
status counts (sealed references never exposed), pending
`payment_reconcile`/`payment_release` jobs, and provider callback evidence
counts with last-received time. `/health/integrations` inherits
`provider_detail` through the shared summary.

## Proof — tests (all green)

- `grow_payment_adapter_validation.ts` — official-contract unit proof:
  J5 create mapping (chargeType=2, no apiKey), `transactions[]` parsing +
  reference refresh, J4 settle identifiers + read-only credential resolution +
  no-settle-without-credentials, refund mapping, approve NEVER called, release
  honesty states (incl. no fabricated void endpoint), sandbox/live separation
  (both directions), sealed-reference AES-GCM opacity, PII/token redaction,
  UNKNOWN transport, malformed/4xx/5xx classification.
- `grow_payment_sandbox_activation_validation.ts` — full-stack proof
  (app + fresh DB + real Worker handlers + documented Grow protocol at the
  transport boundary), 13/13:
  server-only amount (browser-spoofed amount ignored) · opaque sealed
  reference to the browser (no process credentials) · pending never
  consumable · forged/pending callback cannot authorize · structurally
  invalid callback 400 · uncorrelated callback ignored · authoritative status
  lookup confirms · amount contradiction fails the binding closed (durable) ·
  wrong deal denied · exactly-once consumption → AuthHeld · J4 settle with
  authoritative sum → ChargedSuccess + single ledger row + 8% VAT-exclusive
  fee + seller-net invariant + deal → CompletionWindow · **UNKNOWN: Grow
  settles but the response is lost → no blind retry, `payment_reconcile`
  resolves via status to exactly ONE success, ONE ledger consequence, ZERO
  extra settle calls; repeated reconciliation is a no-op** · duplicate/late
  callbacks after the terminal state stay evidence-only · release honesty at
  the rail (active hold stays AuthHeld + operational case; provider-declared
  no-hold → AuthReleased) · refund maps through the provider-neutral path ·
  capability/guard honesty · approveTransaction count across the whole run: 0.
- `provider_environment_capability_validation.ts` — updated to the R9B truth:
  Grow reports ZERO mandatory capability gaps (each capability is a real
  method), startup gate passes on capabilities, configuration still fails
  closed (missing credentials, sandbox/live host mix-ups).
- Full `payments` group green (29 suites) — all R9A contracts kept.

## Externally open (honest)

1. **GROW_SANDBOX_CREDENTIAL_BLOCKER** — no Grow sandbox credentials exist in
   any environment (repo, .env, Render). Required from Grow support to run the
   hosted sandbox E2E: sandbox `userId` + `pageCode` for a direct business
   with the delayed-charge (J4/J5, chargeType=2) capability enabled on the
   page, plus confirmation of whether any additional credential (e.g. apiKey)
   is required for `settleSuspendedTransaction`/`refundTransaction` on this
   account. Until then `R9_GROW_SANDBOX_CLOSED` is NOT claimed.
2. **EXTERNAL / TIME-BOUND RELEASE PROOF OPEN** — J5 auto-release (~10 days
   documented) cannot be proven inside a test run; the release rail reports
   holds honestly and reconciliation will observe expiry. No native void is
   advertised or fabricated.
3. **Refund sandbox proof** — refundTransaction is implemented per the
   official reference; whether the sandbox account permits refunds against a
   settled sandbox transaction is proven only in the hosted run.
4. Wallet methods (Bit / Apple Pay / Google Pay) have no Grow sandbox —
   activation deferred, unchanged.
