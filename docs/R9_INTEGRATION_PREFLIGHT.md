# SITON R9/R10 external-integration preflight

Status: readiness audit only; no provider activation and no external calls were performed.

## Audit identity and parallel-safety record

- Audit branch: `codex/r9-integration-preflight`.
- Owner-supplied starting checkpoint: `b1e2c0d49595513ef57526ae9447e5d2afa7ba9c`.
- Branch inspection began after master had advanced to `bb966b117e52e97b002cfb66955169ab66045f80`.
- Latest master observed before the final required fetch: `408ff8bc1f4c5ea9c33aacaeb6e5d1578cbfa215`.
- Final audited `origin/master` after the pre-commit fetch: `408ff8bc1f4c5ea9c33aacaeb6e5d1578cbfa215`.
- The branch was not merged or rebased onto concurrent work. The only intended tracked change is this report.
- Current staging truth was preserved: real money 0; Grow calls 0; external payment-provider calls 0; real SMS 0; real email 0; real invoices 0.

## Executive summary

Verdict: **NO-GO for Grow sandbox activation today; architecture preparation is viable.** The repository has a useful provider abstraction, an encrypted Grow reference, server-calculated charge amounts, an atomic state/audit/outbox core, webhook deduplication, an authoritative three-attempt database cap, fee/settlement ledgers, and invoice/notification rails. Those are reusable foundations.

The current Grow path nevertheless has four activation blockers:

1. A hosted authorization returned as `pending_provider_confirmation` can be supplied by the browser to Join and recorded as `AuthHeld` without a server-authoritative provider lookup proving authorization, ownership, amount, currency, deal, and buyer binding.
2. Grow implements neither `verifyWebhook` nor `parseWebhookEvent`. The shared route consequently falls back to a generic HMAC/body contract that is not proven to be Grow's contract. In staging, an absent safe webhook secret causes verification to be skipped.
3. Successful synchronous Grow capture/recovery/refund results have no canonical reconciliation event type. Current Worker code therefore records UNKNOWN and throws after a provider success, creating retry/duplicate-money risk.
4. UNKNOWN is modeled but no automatic provider-status reconciliation Worker path resolves it. The admin `trigger_reconcile` action only opens an internal support case and explicitly makes no provider call.

Additional HIGH risks are the absence of a Grow release/void implementation, TypeScript/DB drift for `AuthReleased`, VAT fixed to zero in charge and invoice calculations, and no Grow-specific live/sandbox credential guard. Real communications are also NO-GO: only a log provider exists, email has no explicit adapter contract, retries are unbounded, a Worker crash can strand `processing` notifications, and there is no recipient-safety gate or delivery callback reconciliation. Morning/Green Invoice is the repository's named first real invoice adapter, but its external contract, legal party data, VAT source, and hosted proof remain incomplete.

Risk by component:

| Component | Risk | Reason |
|---|---:|---|
| Canonical state/audit/outbox foundation | MEDIUM | Strong atomic/fenced foundation, but release and reconciliation paths are incomplete. |
| Grow authorization/Join boundary | HIGH | Browser-provided pending/arbitrary authorization can become canonical `AuthHeld`. |
| Grow capture/recovery/refund | HIGH | Provider success currently becomes local UNKNOWN/error without a canonical event. |
| Payment webhook security | HIGH | No Grow-native verification/parser; unsafe staging secret behavior. |
| UNKNOWN reconciliation | HIGH | Status exists, but no automatic job consumes it. |
| Three-attempt invariant | MEDIUM | DB trigger is strong; adapter/internal retries and SN429 scheduling must be constrained. |
| Fee/VAT/seller net | HIGH | 8% logic exists, delivery is included, but VAT is always supplied as zero. |
| SMS | HIGH | No real adapter, callback, bounded retry, or staging recipient controls. |
| Email | HIGH | No explicit email interface or real dispatch path. |
| Invoice/document | HIGH | Named adapter exists, but provider contract, taxpayer/recipient data, VAT and legal semantics need proof. |

## Non-negotiable money truth

- Siton platform fee is exactly 8% of the authoritative customer charge base, including delivery/shipping and every applicable charged component, excluding VAT.
- Distributor commission is zero. No distributor payout/commission mechanism may be introduced.
- Only `ChargedSuccess` and `RecoveredCharge` are final successful money states.
- A provider's “success”, browser redirect, request response, webhook label, invoice result, or notification result is not independently canonical financial truth.
- Synthetic MockPay is not real money.
- Seller settlement/payout readiness is distinct from distributor commission. The existing seller settlement rail may continue; no distributor rail is required.

## Payment architecture map

### End-to-end path

| Stage | Exact repository seam | Durable authority / observation | Finding |
|---|---|---|---|
| Join input | `src/app.ts`, `POST /deals/:id/join` | `participants`, `idempotency_log`, `audit_log`, `outbox_events` | Deal capacity and amount components are server-side, but `authorization_id` and provider metadata are accepted from the request. |
| Authorization HTTP | `src/frontend_runtime.ts`, `/api/payments/authorize` | provider response; optional `buyer_payment_methods` | When a deal is supplied, amount is recalculated from locked DB deal data plus delivery. Hosted Grow returns a pending reference and URL. |
| Provider abstraction | `src/payment_provider.ts`, `PaymentProvider`, `buildPaymentProvider` | provider adapter result | Canonical seam supports authorize/capture/recover/refund and optional release/status/webhook methods. |
| Grow transport | `src/grow_payment_adapter.ts`, `buildGrowPaymentAdapter` | encrypted `grow_ref_v1` reference | Implements create suspended authorization, status, settle-as-capture, refund, callback normalization; no provider call was made in this audit. |
| Auth hold | `src/app.ts`, Join transaction | `participants.money_state=AuthHeld`; `buyer_state=JoinedAuthorized`; audit JSON contains auth reference | Not currently proven against Grow before state change. |
| Auth lock | state-transition/charging preparation in `src/app.ts` | `AuthHeld -> AuthLocked`; buyer `JoinedAuthorized -> LockedIn` | Provider-neutral canonical transition. No provider-side lock is required if Grow's held authorization is already authoritative. |
| Charge attempt | `src/app.ts`, `handleChargeDealEvent`; `src/payment_attempt_helpers.ts`, `recordAttemptBeforeIo` | `payment_attempts`; `ChargeAttempt`; audit/outbox | Attempt is durably inserted before provider I/O. |
| Capture | `paymentProvider.capture` | attempt result plus normalized event processing | Grow synchronous success lacks a success reconciliation event and currently falls into the missing-event error path. |
| Failure/recovery | `src/app.ts`, recovery scheduling/handler; `paymentProvider.recover` | `ChargeFailedRecovery`, then `RecoveredCharge` or `AuthReleased` | Recovery is a second settle call today; exact provider semantics require external verification. |
| Refund | `src/app.ts`, refund outbox handler; `paymentProvider.refund` | `Refunded`, negative fee event, invoice event | Grow success has the same missing reconciliation-event defect and may be retried. |
| Release/void | optional `PaymentProvider.release`; Stripe/generic/mock implementations | canonical `AuthReleased` intended | No Grow implementation and no Worker call site. Failed/cancelled deals can leave holds represented as held. |
| Webhook | `src/frontend_runtime.ts`, `/webhooks/payments`; `src/webhook_ingestion.ts` | `webhook_events`, `payment_webhook_security_events` | Dedupes `(provider,event_id)`, but Grow authenticity and canonical parsing are absent. |
| Reconciliation | `src/payment_reconciliation.ts`; public `/api/payments/status` | attempts/webhook status/canonical transitions | Event classification exists. Status lookup is not wired to an automatic Worker job. |
| Late event | `src/payment_reconciliation.ts` | webhook status `ignored` where canonical state is terminal/incompatible | Terminal protection exists; scenario proof is still required for Grow. |
| Rate limit | migration `050_charge_attempt_rate_limit.sql`; single attempt-insert seam | DB trigger + partial index | Enforces max 3 charge/recovery attempts per participant/deal in rolling 30 minutes. |
| Fee/ledger | `src/platform_fee_money.ts`; migration `019_platform_fee_money_events.sql` | `platform_fee_money_events` | 8% and signed refund reversal are durable and idempotent. VAT input is currently zero. |
| Settlement/payout | `src/seller_payout.ts`; migrations `021`/`022` | seller settlement/batch/item/attempt/case tables | Seller-only settlement rail; distributor fee columns were removed. |
| Worker/DLQ | `src/app.ts`, `src/worker.ts`, `src/outbox_worker_helpers.ts` | `outbox_events`, `outbox_dlq`, `worker_heartbeats`, `operational_recovery_audit` | Dedicated money lane, fenced leases, retry/backoff and DLQ exist. |
| Audit/admin | state transition helpers; `src/admin_control_plane.ts` | append-only audit and operational cases | Admin reconciliation is currently a dry-run/support-case action only. |

### PaymentProvider contract Grow must implement

The existing `PaymentProvider` interface in `src/payment_provider.ts` is the canonical integration seam:

- Required: `providerCode`, `mode`, `webhookProvider`, `configured`.
- Required operations: `authorize`, `capture`, `recover`, `refund`.
- Required for safe Grow activation even though currently optional in TypeScript: `release`, `status`, `verifyWebhook`, `parseWebhookEvent`.
- Optional legacy/tokenization surface: `tokenize`. For a hosted Grow flow, card data must remain on Grow-hosted UI; Siton should receive an opaque reference, not PAN/CVV.
- Results must classify `success`, `permanent_fail`, `temporary_fail`, or the repository's conservative UNKNOWN representation, carry a stable correlation/reference, and emit or cause a canonical reconciliation event without directly inventing Siton state.

### What already uses MockPay

- `buildMockPaymentProvider` supplies synthetic authorize, capture, recover, refund, release and status behavior.
- Mock IDs, deterministic/random outcome selection, decline suffixes, and `mock: true` are adapter-local assumptions.
- Legacy route alias `/api/payments/authorize-mock`, mock webhook comments/alias, `MOCK_SEED`, `PAYMENT_AUTH_DECLINE_SUFFIX`, and fallback Join payload `authorization: "mock_success"` are MockPay-era assumptions that must not leak into Grow authority.
- `render.yaml` intentionally configures both staging processes as `mockpay` / `mock-backed` / `demo`; this must remain unchanged until an explicitly authorized activation step.

### Genuinely provider-neutral code

- Server calculation of quantity, price and delivery charge.
- Canonical deal/buyer/money transition engine and append-only audit.
- Transactional outbox, leases, retries, DLQ and Worker lane separation.
- `payment_attempts` before-I/O recording and migration 050 rate limit.
- Webhook storage/deduplication and reconciliation classification once given a trusted normalized event.
- Platform fee money-event ledger, signed refund reversal, seller settlement readiness, and idempotency boundaries.

### Mock/provider assumptions that require removal or containment

- Join treats the client's authorization reference as sufficient and permits a mock-success fallback.
- Worker success assumes the adapter returns a `reconciliation_event_type`; Grow returns none for success.
- Generic webhook field names and HMAC are used when a provider lacks its own methods.
- Recovery is modeled as another capture call; Grow-specific legality/idempotency/window semantics are unverified.
- Provider reference recovery relies substantially on audit JSON rather than a normalized participant/payment-intent binding table.
- Runtime summaries overstate Grow readiness (`authorization/capture/recovery/refund_transport_live` and `payment_reconcile_live`) merely from configured/mode checks.

### Exact Grow adapter work required

1. Define a server-owned payment authorization/intention record binding provider reference, participant/join intent, deal, buyer identity hash, amount, currency, status, correlation and timestamps.
2. Make hosted authorization completion asynchronous: callback/status lookup updates that record only after authenticated or authoritative verification; Join may consume only a matching authorized record once.
3. Implement Grow-native webhook authentication and parsing, including stable event identity and a mandatory authoritative status query when callbacks are only hints.
4. Return normalized successful capture/recovery/refund outcomes that the Worker can atomically apply exactly once, without converting provider success into a retry.
5. Add release/void behavior if supported; otherwise define the provider-approved expiry/cancel process and status reconciliation.
6. Add automatic UNKNOWN reconciliation using `status`, with bounded scheduling, terminal/manual exit and operational visibility.
7. Preserve/refine encrypted opaque provider reference storage and create indexed binding lookup rather than depending on audit JSON.
8. Add Grow-specific sandbox/live fail-closed configuration guards and truthful readiness summaries.
9. Ensure all money I/O occurs only after `recordAttemptBeforeIo`; prohibit hidden adapter retries for settle/recovery/refund.
10. Supply an authoritative VAT allocation/input before ledger and invoices are activated.

### What must not change for Grow

- Canonical Siton state names and legal transitions.
- Only `ChargedSuccess`/`RecoveredCharge` count as successful money.
- Server authority over amount, delivery, deal, buyer/participant binding and timing.
- 8% fee base rule and zero distributor commission.
- Three applicable charge/recovery attempts per participant/deal per rolling 30 minutes.
- Transactional outbox, durable before-I/O attempt, append-only audit, idempotency, terminal-state protection and DLQ.
- Browser isolation from secrets, raw card data and final money authority.

## Grow sandbox preflight

### Repository facts

- `src/grow_payment_adapter.ts` posts form-encoded requests and currently assumes create/process-info/settle/refund/transaction-info/approve paths and response/status fields.
- Hosted authorization sends server-derived amount and callbacks, returns a payment URL, and stores process/transaction credentials inside an AES-256-GCM sealed opaque reference.
- `redactGrowLog` masks names containing token, API key, user/page identifiers, authorization or secret.
- Transport loss returns UNKNOWN at the transport adapter. The canonical wrapper collapses UNKNOWN into retryable `temporary_fail`, and broad catches in capture/recover/refund currently become permanent failure.
- `normalizeCallback` intentionally marks callback money state untrusted and requires authoritative lookup, but it is not connected to `PaymentProvider.parseWebhookEvent` or the webhook route.
- `status` maps hard-coded provider codes/labels to authorized/captured/failed/pending/unknown; these mappings have not been externally validated in this audit.
- The adapter has no release implementation. `GROW_APPROVE_PATH` is configured but unused.
- `GROW_API_KEY` is not required by `assertGrowConfig`; whether it is optional is not proven here.
- The existing Grow test is an offline injected-transport validation, not sandbox evidence.

### GROW EXTERNAL QUESTIONS TO VERIFY

No answer below should be inferred from current code. Verify against current Grow documentation and sandbox support before implementation:

1. What exact product/API operation creates a true authorization hold, and do `chargeType=2`, “suspended”, J4/J5 or the current create fields mean the same thing for this account?
2. What credentials are required per endpoint, how are they scoped, and is `apiKey` mandatory for create, query, settle, refund, approve and void?
3. What are the official sandbox and production base URLs, credential formats, IP/TLS requirements, and how can code prevent cross-environment credentials?
4. What is the exact hosted-flow redirect/callback sequence, and may success redirect precede final authorization?
5. How is callback authenticity verified: signature/MAC, header/form field, certificate, source constraint, shared secret, or mandatory status lookup? What bytes and encoding are signed?
6. Is there a stable unique callback/event ID? If not, which immutable provider fields form a safe dedupe identity across retries and status changes?
7. What are the complete process and transaction status codes, terminality rules, timestamps, amounts and currency fields?
8. What idempotency facility exists for create, settle/capture, refund and void? Are repeated requests with the same process/token guaranteed not to double-charge/refund?
9. Does settle support partial amounts, multiple settlements or capture expiry, and what happens when the HTTP response is lost after success?
10. Is “recovery” a retry of the same authorized transaction, a new settle, a new payment request, or unsupported after a failed settle?
11. What is the supported release/void/cancel operation for an unused hold, and what is the automatic expiry behavior/SLA?
12. Which reference(s) must be retained for status, settle, refund and release; may process/transaction tokens rotate or appear only after a query?
13. What are refund constraints: full/partial, multiple refunds, original-transaction requirements, asynchronous statuses and callbacks?
14. What rate limits, retry-after semantics, maintenance responses and timeout guidance apply to every endpoint?
15. What fields may be logged or stored, what PCI scope applies to the hosted page, and are process/transaction tokens considered secrets?
16. Can Siton embed correlation/idempotency metadata and receive it unchanged in callbacks/status responses?
17. Which webhook source/replay protections does Grow require, and how long can late/duplicate/out-of-order callbacks occur?
18. Does Grow provide an authoritative transaction time and minor-unit/currency representation suitable for reconciliation?

## Payment security boundary

Must remain server-side:

- Provider/API credentials, reference-encryption key, webhook secrets and status/capture/refund/release calls.
- Amount, currency, quantity, delivery, fee/VAT, participant/deal/buyer binding and idempotency/correlation generation.
- Provider status mapping, canonical state transitions, ledger writes and final success decisions.
- Webhook raw-body verification before semantic parsing or durable canonical action.

Browser-allowed data is limited to a hosted payment URL, a public provider key if the chosen hosted SDK needs one, a short-lived opaque Join/payment-intent handle and non-authoritative display state. The browser must never submit PAN/CVV to Siton and must not choose the amount, claim `AuthHeld`, or declare capture/refund success.

Current HIGH issue: Join consumes `authorization_id` from the request without authoritative binding/approval verification. A pending Grow process or arbitrary value can be represented as `AuthHeld`. The fix belongs at a server-owned authorization record/consume boundary, not in frontend trust.

Webhook secrets and Grow reference encryption keys must be secret-only Web/Worker configuration. Logs, readiness and API responses must expose only booleans/redacted identifiers. Raw webhook preservation should be access-controlled and retention-limited because provider payloads can contain PII/tokens.

## State-machine mapping

Provider vocabulary must map into existing states; it must not create new canonical states.

| Provider observation | Siton deal state | Siton buyer transition | Siton money transition/action |
|---|---|---|---|
| Hosted process created/pending | unchanged | `NotJoined` | No canonical hold yet; retain provider-intent status only. |
| Authoritative authorization/hold confirmed and Join committed | deal lifecycle unchanged | `NotJoined -> JoinedAuthorized` | `NoFinancial -> AuthHeld`. |
| Deal locks accepted buyers for charge | `ClosedForJoining -> ReadyForCharging` | `JoinedAuthorized -> LockedIn` | `AuthHeld -> AuthLocked`. |
| Before settle/capture I/O | `ReadyForCharging -> Charging` | `LockedIn -> ChargingAttempt` | `AuthLocked -> ChargeAttempt`; insert attempt first. |
| Authoritative capture success | `Charging` until batch processing completes | `ChargingAttempt -> ChargedSuccess` | `ChargeAttempt -> ChargedSuccess`. |
| Authoritative capture failure eligible for recovery | `Charging` | `ChargingAttempt -> ChargeFailedCompletion` | `ChargeAttempt -> ChargeFailedRecovery`. |
| Authoritative recovery success | `Charging` | `ChargeFailedCompletion -> Recovered` | `ChargeFailedRecovery -> RecoveredCharge`. |
| Recovery exhausted/failed | eventual `Failed` | `ChargeFailedCompletion -> Dropped/DealFailed` | `ChargeFailedRecovery -> AuthReleased` after authoritative release/expiry. |
| Unused hold released/expired | failed/cancelled lifecycle as applicable | existing failure path | `AuthHeld` or `AuthLocked -> AuthReleased` is intended in TypeScript. |
| Refund confirmed | failed/cancelled after prior charge as applicable | existing buyer state | `ChargedSuccess` or `RecoveredCharge -> Refunded`. |
| Timeout/ambiguous response | unchanged until resolution | unchanged | Keep current waiting state plus UNKNOWN attempt; status/webhook reconciliation decides. |

Schema blocker: TypeScript permits `AuthHeld -> AuthReleased` and `AuthLocked -> AuthReleased`, but migration `008_db_enforcement_phase2a.sql` permits release only from `ChargeFailedRecovery`. A new forward migration and action-name/audit path are required; never edit an applied migration.

## Rate-limit invariant

Migration `050_charge_attempt_rate_limit.sql` is the authoritative boundary. A partial index and BEFORE INSERT trigger count `charge_start` plus `recovery` attempts for the same participant/deal over the previous 30 minutes. A transaction advisory lock prevents concurrent fourth attempts. An exact `(participant, deal, attempt_type, correlation_id)` replay is admitted and the application's conflict handling makes it a no-op.

Grow rules:

- Exactly one new `payment_attempts` row/correlation must precede each applicable external settle/recovery attempt.
- The adapter must not silently retry a money action internally. Transport retries must return UNKNOWN to reconciliation or be explicitly represented by a new allowed attempt.
- A same-attempt replay may reuse the exact correlation only when Grow's idempotency contract makes it safe.
- Status queries/webhook verification do not themselves consume the three charge/recovery attempts.
- Refund/release attempts remain outside this particular invariant but still need their own idempotency and bounded retries.
- `SN429` must be handled distinctly: do not hammer the event into generic retries/DLQ; schedule no earlier than window eligibility or open a visible operational case when business timing no longer permits recovery.
- Future tests must prove combined capture+recovery count, concurrency, rolling expiry, exact replay and absence of hidden provider retries.

## Webhook and reconciliation architecture

### Existing flow

1. Web route captures the raw body and reads signature/timestamp headers.
2. `verifyWebhookSignature` delegates to provider verification when implemented; otherwise it applies a generic HMAC-SHA256 scheme. When the configured secret is unsafe/missing, verification is skipped.
3. Provider parser, when implemented, normalizes event identity/type/correlation/participant/deal/reference. Otherwise request-body fields are accepted.
4. `webhookIngestion.claimEvent` persists a normalized payload and dedupes on `(provider,event_id)` in `webhook_events`.
5. `payment_reconciliation.ts` resolves by attempt correlation, with participant/state fallback, classifies the canonical event and atomically applies/ignores it.
6. Terminal/incompatible late events are ignored instead of reopening money truth.

### Required R9 changes

- Grow-native authenticity verification must fail closed in any real-provider mode. If callbacks cannot be cryptographically verified, treat them only as wake-up hints and require a server-to-server authoritative status query.
- Preserve raw bytes or a cryptographic digest plus redacted/raw restricted payload sufficient for provider dispute; define retention and access controls.
- Require stable provider event identity. Never use arrival time as an event ID.
- Persist first-class provider reference/correlation/payment-intent bindings so reconciliation does not depend on unindexed audit JSON or client identifiers.
- Add a dedicated payment-reconciliation outbox event/job for UNKNOWN and callback hints. It must call `status`, compare amount/currency/reference, apply one canonical event, back off, terminate, and expose unresolved cases.
- Keep webhook acknowledgement fast; canonical side effects should be durable and asynchronous.
- Add metrics/alerts for invalid signature, duplicates, UNKNOWN age, mismatch, DLQ and unreleased holds.

### Current DLQ/manual behavior

Outbox jobs have bounded attempts (default 4), fenced leases, exponential backoff, DLQ copy/delete and admin requeue visibility. This is reusable. A payment event can still be DLQ'd without provider reconciliation, and the current admin `trigger_reconcile` only opens an `operational_cases` record for UNKNOWN attempts. R9 needs a real status-query job plus a deliberate manual resolution/runbook; admin must never force a success state without provider evidence.

## R9 Grow sandbox proof matrix

No row below was executed during this audit.

| Scenario | Setup/action | Required durable evidence | Pass condition |
|---|---|---|---|
| Successful charge | Authorized hosted flow, close/charge | payment intent, one before-I/O attempt, trusted webhook/status, audit, fee ledger, outbox | Exactly one `ChargedSuccess`; amount/currency match; 8% base correct; no retry. |
| Declined charge | Provider-declined capture | attempt/result/event/audit | No success ledger; `ChargeFailedRecovery`; deterministic error class. |
| Timeout before response | Drop response before provider result | UNKNOWN attempt + reconciliation job | No guessed success/failure and no immediate unsafe repeat. |
| Provider success after timeout | Provider captured but response lost | status/webhook evidence | One eventual `ChargedSuccess`; no second capture. |
| Duplicate webhook | Replay identical provider event | one webhook identity | Second request is acknowledged duplicate; no second transition/ledger. |
| Webhook before API response | Deliver callback while settle request is in flight | durable correlation/reference | Event waits/resolves safely; API response cannot apply twice. |
| Late webhook | Deliver after terminal state | webhook `ignored` + reason | Canonical terminal truth unchanged; visible audit. |
| Retry | Temporary failure eligible for retry | distinct allowed attempt/correlation | Bounded retry; each I/O has one row; cap honored. |
| Recovery | Initial failure then provider-supported recovery | capture+recovery attempts/events | Only `RecoveredCharge` counts success; no fourth attempt in 30m. |
| Refund | Captured participant refunded | refund attempt/event, negative fee reversal, invoice enqueue | Exactly one `Refunded`; money and ledger balance. |
| Duplicate refund event | Repeat callback/status result | dedupe/idempotency evidence | No second refund state or reversal/document. |
| Worker restart | Kill after claim and at every before/after-I/O boundary | fenced lease/reclaim/attempt evidence | No abandoned job and no unrecorded/double money action. |
| Web restart | Restart during hosted callback/authorization consumption | payment intent + webhook durability | Callback/Join can resume idempotently; secrets remain server-side. |
| Hold release | Fail/cancel before capture | release/status/audit | Provider hold is voided/expired and canonical `AuthReleased` is legal. |
| Mismatch | Wrong amount/currency/reference in callback/status | operational case, no state mutation | Fail closed and alert. |
| Rate-limit concurrency | Four concurrent applicable attempts | DB records/error | At most three provider I/O attempts in rolling 30m. |

## Notification architecture

### Current shared rail

- `src/notification_templates.ts` defines events, template keys, compatible channels, required payloads and rendering.
- `src/notification_dispatch.ts` defines `NotificationProvider`, validates/enqueues to `notification_events`, claims batches and writes `notification_attempts`.
- `src/app.ts` enqueues buyer SMS and seller `internal` notifications. Buyer `buyer_id` is used as SMS destination; seller email is currently only used as an internal recipient reference.
- `flushPendingNotifications` runs in Worker maintenance, not as an outbox event. `notification_events` itself is the queue.
- Migration `029_notification_rail.sql` is the active provider-ready schema. Migration `015_notifications.sql` is a legacy table and must not become a second rail.
- Idempotency is a unique `notification_events.idempotency_key`.
- Temporary failure returns to pending after one minute; permanent failure is terminal. `NOTIFICATION_MAX_ATTEMPTS` exists in config but is not used, and the table has no attempt/max counter or DLQ.
- A crash after claiming can strand status `processing`; notification claims have no lease, heartbeat or reclaim path.
- No provider delivery callback, delivery-status reconciliation, suppression/bounce model or notification webhook security table exists.
- `correlation_id` was later added to `notification_events`, but enqueue does not write it.

### SMS adapter seam

The current minimal interface is `SmsProvider extends NotificationProvider` with `sendSms(to, body) -> {messageId}`. The actual dispatch prefers generic `send(notification)`; its fallback invokes `sendSms` with an empty body. Therefore a production SMS adapter should not be attached until the contract is made explicit. Recommended existing-system evolution:

- Keep one `NotificationProvider` rail, but require a channel-aware `send` input containing a server-rendered message, normalized destination, idempotency/correlation and metadata.
- Return accepted/temporary/permanent/unknown separately; persist provider message ID and redacted response.
- Add optional provider callback verification/parser/status lookup methods, analogous in principle to payments but never authoritative for money.

### Email adapter seam

There is no explicit `EmailProvider` interface today. `NotificationProvider.send(notification)` is the only usable generic seam, and no real implementation exists. R9 communications should add an explicit channel capability or `EmailProvider.sendEmail(to, subject, text/html, metadata)` while retaining the same notification tables/dispatcher. Email needs message ID, accepted/rejected/unknown classification, bounce/complaint/suppression callback normalization and provider-specific recipient/domain validation.

### Can one provider serve SMS and email?

Yes only if the selected service officially supports both and the adapter declares/configures channel capabilities independently. Credentials, sender identities, templates, rate limits, callbacks, enable switches and health/readiness must remain channel-specific. A generic provider name must not silently route one channel through another. The current implementation cannot safely serve either channel externally.

### Missing delivery reconciliation

`sent` currently means the adapter returned success (the log adapter), not delivered. There is no callback endpoint, provider event dedupe, status state, unknown resolution, bounce/suppression or reconciliation job. Future status should distinguish at least queued/accepted/delivered/temporary failure/permanent failure/suppressed without changing money/deal truth.

## Staging communication safety model

Use the existing notification rail; do not build a second system.

Required before any real adapter can initialize:

1. `NOTIFICATION_PROVIDER_MODE=real` plus a separate explicit `NOTIFICATION_DELIVERY_ENABLED=1`; both must be true.
2. Channel switches such as `SMS_DELIVERY_ENABLED` and `EMAIL_DELIVERY_ENABLED`, default false.
3. In staging, a mandatory normalized recipient allowlist. SMS must use E.164 and allowed full numbers/hashes; email must match exact addresses or a dedicated controlled domain.
4. Synthetic/test recipient blocking in production and real-recipient blocking in staging unless allowlisted. Never infer safety from a `test` substring alone.
5. Fail closed on unsupported provider names, missing credentials/sender/webhook secret, invalid provider mode or environment mismatch. Current silent fallback to log/dev must become a boot/readiness failure when real delivery was requested.
6. Server-side rendering and PII-safe logging. Do not log message bodies, auth values or full destinations; log notification/correlation/provider IDs and a masked recipient fingerprint.
7. Per-channel/provider/global rate limits and bounded attempts; cap retries, create a communication DLQ/terminal status and expose manual retry.
8. Lease/fencing or an outbox event for dispatch, plus stuck-processing reclaim and crash-boundary tests.
9. Counters by environment/channel/result: attempted external sends, accepted, delivered, failed, suppressed, blocked-by-safety, duplicate callback and unknown-age. Alert on any external staging send outside the allowlist.
10. Signed callback verification, provider event dedupe, suppression/bounce persistence and a visible operational case for unresolved outcomes.

Current `render.yaml` requests `NOTIFICATION_PROVIDER=log-only`; `buildNotificationProvider` treats every value other than literal `log` as unsupported and falls back to provider `log`, mode `dev`. This preserves zero external sends but makes the configured label misleading. Future activation must be an explicit separately reviewed Render change.

## Invoice/document architecture

### What exists

- `src/invoice_dispatch.ts` defines `InvoiceProvider` with create/status/cancel/reconcile/webhook hooks, immutable document input, attempts and Worker processing.
- `invoice_documents`, `invoice_document_attempts`, `invoice_reconciliation_cases`, `invoice_webhook_events` and webhook-security records form the rail (migrations `018`, `023`, `025`).
- Default provider is `internal-invoice-ledger` / `internal-truth-only`; it creates synthetic internal IDs and explicitly reports `external_document_issued=false`.
- The repository canonically names Morning/Green Invoice as the first real adapter (`MorningInvoiceProvider` and `docs/INVOICE_PROVIDER_MORNING_ADAPTER.md`). The provider is therefore not “undecided”, but activation remains unproven.
- Charge receipt enqueue occurs after buyer `DealCompleted`; refund receipt enqueue occurs after canonical `Refunded`. Document key uniqueness and attempt correlation provide idempotency.
- Issue/reconcile uses outbox events, bounded document attempts, Worker reclaim and mismatch cases. Invoice webhooks are deduped and cause reconciliation rather than directly setting money truth.

### Blocking findings

- The Morning URLs, auth, request/response fields, status aliases, document-type mapping and signature scheme in code are generalized assumptions and need verification against current provider documentation/account configuration.
- Fallback webhook event ID uses current time when provider ID is absent, defeating deduplication; real mode must require stable provider identity.
- Webhook HMAC has no timestamp/replay-window handling.
- External “success” is treated as issued with broad fallback status behavior; accepted/processing/issued must be distinguished per provider truth.
- Invoice input lacks complete customer/seller legal/tax identity, address and contact fields. Charge/refund enqueues select only quantity, delivery, title and unit price.
- The same VAT defect applies: application callers pass `vatAmount: 0`, and taxable/document amounts mirror gross.
- The legal/tax canon says the seller sells the product and owes the buyer document unless the provider issues it on the seller's behalf; Siton issues the seller a platform-fee invoice. Current `charge_receipt`/`refund_receipt` timing and provider document taxonomy require accountant/legal approval and seller authorization model proof.
- There must be no distributor invoice/commission document.

Verdict: keep internal-only invoices until provider sandbox, legal party mapping, VAT authority, webhook verification, issuance semantics and reconciliation proof are complete.

## Environment and secret inventory

Values are deliberately omitted.

| Variables | Consumed by | Required/optional | Runtime | Secret? | Current behavior / danger |
|---|---|---|---|---|---|
| `PAYMENT_PROVIDER`, `PAYMENT_PROVIDER_MODE`, `PAYMENT_ENVIRONMENT` | `runtime_config.ts`, `payment_provider.ts`, guards | Required for real mode | Web + Worker | No | Defaults are mock/demo-safe; production guard blocks mock. Grow sandbox/live cross-environment guard is missing. |
| `PAYMENT_PROVIDER_BASE_URL` | Grow/generic/Stripe provider | Required for Grow; optional canonical Stripe default | Web + Worker | No | Grow config fails if absent; no allowlist/canonical sandbox URL proof. |
| `PAYMENT_PROVIDER_API_KEY`, `PAYMENT_PROVIDER_PUBLIC_KEY` | payment providers/guards | Provider-specific | API key both; public key Web | API key yes; public key no | Grow uses `GROW_API_KEY` instead; generic guard names can be misleading. |
| `PAYMENT_WEBHOOK_PROVIDER`, `PAYMENT_WEBHOOK_SECRET` | webhook route/provider | Required in real Web mode | Web | Secret | Staging with no safe secret skips verification. Grow-native algorithm is absent. |
| `PAYMENT_PROVIDER_*_PATH`, `PAYMENT_PROVIDER_TIMEOUT_MS`, `PAYMENT_PROVIDER_CURRENCY` | generic provider/runtime summary | Optional defaults | Web + Worker | No | Generic defaults must not be assumed valid for Grow. |
| `GROW_USER_ID`, `GROW_PAGE_CODE`, `GROW_API_KEY` | Grow adapter | Provider-doc dependent | Web + Worker | Yes | User/page required; API key currently not required by config validation. |
| `GROW_REFERENCE_ENCRYPTION_KEY` | Grow adapter | Required, minimum 32 chars | Web + Worker | Yes | Protects opaque references; rotation/version strategy missing. |
| `GROW_SUCCESS_URL`, `GROW_CANCEL_URL`, `GROW_NOTIFY_URL` | Grow adapter | Required HTTPS | Web | No | Return URLs must be environment-bound and must not confer authority. |
| `GROW_CREATE_PATH`, `GROW_PROCESS_INFO_PATH`, `GROW_SETTLE_PATH`, `GROW_REFUND_PATH`, `GROW_TRANSACTION_INFO_PATH`, `GROW_APPROVE_PATH` | Grow adapter | Optional code defaults | Web + Worker | No | Defaults are unverified provider assumptions; approve is unused; no release path. |
| `NOTIFICATION_PROVIDER`, `NOTIFICATION_PROVIDER_MODE` | notification dispatch | Required for real delivery | Worker (summary also Web) | No | Unsupported names silently fall back to log/dev. `NOTIFICATION_PROVIDER_MODE` is not exported in runtime config. |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` | only exported in `runtime_config.ts` | Unused today | Future Worker/Web callback | SID/token secret; sender usually non-secret | Comments claim activation, but no adapter consumes them. Dangerous documentation/config drift. |
| `NOTIFICATION_MAX_ATTEMPTS` | exported only | Unused today | Worker | No | Retry is currently unbounded. |
| Future `NOTIFICATION_DELIVERY_ENABLED`, channel enables, recipient allowlist/domain, callback secret | not implemented | Must be required/fail-closed for real mode | Worker + callback Web | callback secret/allowlist may be sensitive | Required design; defaults false/deny. |
| `INVOICE_PROVIDER`, `INVOICE_PROVIDER_MODE`/`INVOICE_PROVIDER_TRANSPORT_MODE` | invoice dispatch | Required for external | Worker + callback Web | No | Default internal-only is safe. Morning defaults mode to real when selected. |
| `INVOICE_PROVIDER_BASE_URL`, `INVOICE_PROVIDER_API_KEY`, `INVOICE_PROVIDER_BEARER_TOKEN`/`ACCESS_TOKEN` | Morning adapter | Required according to selected auth contract | Worker | Credentials yes | Fail-fast exists in real adapter; URL/credential contract needs external proof. |
| `INVOICE_WEBHOOK_SECRET` | invoice callback | Required in real mode | Web | Yes | Generic HMAC assumptions/replay protection need provider proof. |
| `INVOICE_PROVIDER_TIMEOUT_MS`, create/status/cancel paths, `INVOICE_PROVIDER_CURRENCY` | invoice adapter | Optional code defaults | Worker | No | Default paths/status semantics unverified. |
| `DATABASE_URL`, `APP_DEPLOYMENT_MODE`, `RUNTIME_ROLE`, `DISABLE_OUTBOX_WORKER` | runtime/guards | Required in deployed roles | Web + Worker | DB URL yes | Role separation is guarded; Web must not run money Worker. |
| `OUTBOX_POLL_MS`, `OUTBOX_MAX_ATTEMPTS`, `WORKER_*` lease/concurrency settings | Worker scheduler/helpers | Optional bounded defaults | Worker | No | Reusable for payment/invoice; notification rail does not use the same safeguards. |

Production/staging real-provider mode must fail boot/readiness when required configuration is missing, placeholder, cross-environment or contradictory. It must not silently downgrade to synthetic success.

## R9_GROW_SANDBOX_CLOSED evidence gate

### Unit

- Grow request encoder, response decoder, status taxonomy, reference sealing/opening/redaction and key rotation/version behavior tested from approved provider fixtures.
- Every operation maps timeout/HTTP/provider/malformed responses to correct result class, especially UNKNOWN.
- Native webhook verification/parser tests cover byte-exact signature, timestamp/replay, malformed input and stable event ID.
- No hidden money-action retries; amount conversion and ILS rules are exact.

Evidence: deterministic tests tied to documented fixtures and reviewed mapping table; no secret/card data snapshots.

### Integration

- Hosted auth intent binds deal/buyer/amount/currency/correlation and can be consumed once only after authoritative confirmation.
- Capture/recovery/refund/release/status run through the canonical `PaymentProvider` seam.
- Provider success, failure and UNKNOWN each reach the correct durable path without request-thread finality.

Evidence: DB rows, redacted provider request IDs, canonical events and no duplicate provider action.

### DB

- New forward migration for payment intent/reference binding and legal `AuthReleased` paths.
- Existing migrations apply from empty DB and upgrade snapshot; no edit to migration 008/050.
- Three-attempt rolling/concurrent/exact-replay tests and unique provider-event/reference constraints pass.
- Fee base includes delivery/applicable items, excludes authoritative VAT; distributor commission remains zero.

Evidence: isolated migration report, constraint/trigger introspection and transaction/concurrency proof.

### Worker

- Fenced/reclaimable jobs cover capture, recovery, refund, release and UNKNOWN status reconciliation.
- Kill tests at claim, before I/O, after provider accepted, after attempt result, after canonical state and before acknowledgement.
- Bounded backoff/DLQ and SN429-specific scheduling/manual visibility proven.

Evidence: worker heartbeat/lease generations, attempt/event/audit/DLQ rows and provider-side transaction counts.

### Payments

- Entire Grow sandbox matrix above passes for exact amount, currency, provider reference and terminality.
- Only `ChargedSuccess`/`RecoveredCharge` contribute to collected totals, settlement and payout readiness.
- Refund/release and late/out-of-order behavior reconcile exactly once.

Evidence: exported redacted sandbox transaction records matched to Siton ledger/audit records.

### Security

- Hosted flow keeps PAN/CVV outside Siton; browser cannot alter amount or assert authorization.
- Secrets are absent from repo, logs, responses, DB payloads and frontend bundle.
- Invalid/replayed/unsigned webhook fails closed; callback body cannot select provider/canonical event without trusted parsing.
- Sandbox/live configuration mismatch fails boot.

Evidence: negative/adversarial suite, bundle/log scan, config-guard tests and security-event rows.

### Failure

- Network loss, timeout, 429/5xx, malformed response, callback loss/duplication/reordering, status outage and reference-decryption failure all have bounded safe outcomes.
- UNKNOWN never becomes failure or success by guessing; aged UNKNOWN opens an operational case.

Evidence: injected fault traces and final invariant queries.

### E2E

- Browser hosted flow through Join, deal threshold, charging, recovery/failure, completion, refund and tracking surfaces.
- Web/Worker restarts and concurrent events preserve one canonical result.

Evidence: video/screenshots only as supplementary proof; primary proof is redacted provider IDs plus DB/audit/ledger assertions.

### Hosted sandbox

- Explicitly authorized Grow sandbox account/endpoints and test identities only.
- Verified callbacks/status queries and provider dashboard records for auth, capture, failure, refund and void/release.
- External-call counter records sandbox calls while real/live call count remains zero.

Closure rule: every category passes, all HIGH blockers are closed, mappings are linked to current approved provider documentation, no unresolved money mismatch exists, and the owner explicitly signs `R9_GROW_SANDBOX_CLOSED`.

## R10_CONTROLLED_REAL_MONEY_PROOF additional gate

Do not execute R10 as part of R9. R10 additionally requires:

- R9 closure and a clean, pinned release artifact/commit deployed with production-only fail-closed guards.
- Production merchant/account approval, legal/tax/privacy review, refund/release runbook and named on-call owner.
- Small explicit amount, named authorized test buyer/seller, transaction count and time window, stop/rollback criteria and owner approval.
- Preflight proof that no test/sandbox credentials/endpoints remain and real notification/invoice delivery is separately controlled.
- Live webhook/status, one charge, settlement math, 8%-excluding-VAT ledger, seller net, required documents and (if authorized) refund/release reconciled end-to-end.
- Independent provider dashboard/bank evidence matched to immutable Siton audit, with secrets/PII redacted.
- Zero unexplained UNKNOWN, duplicate, DLQ, unreleased hold, mismatch or distributor commission; explicit post-proof disable/continue decision.

Only after this evidence may the owner declare `R10_CONTROLLED_REAL_MONEY_PROOF`.

## Communication-provider future test matrix

No real delivery was performed.

| Scenario | Required evidence |
|---|---|
| SMS queued | One validated `notification_events` row, stable idempotency/correlation, allowlisted E.164 recipient fingerprint. |
| SMS accepted/success | One provider message ID and attempt; `sent/accepted` semantics documented; no duplicate send. |
| SMS provider failure | Correct permanent/temporary classification, redacted error, no false sent state. |
| SMS retry | Bounded backoff, one attempt row per I/O, max cap/DLQ, provider idempotency proof. |
| SMS duplicate callback | Provider event dedupe and one delivery-state update. |
| Email queued | Valid template/channel, normalized allowlisted address/domain, one event. |
| Email accepted/success | Provider ID, accepted then delivered status if supported, signed callback/status proof. |
| Email failure | Rejection/bounce/complaint classified and visible; no false delivered status. |
| Email retry | Only retryable outcomes; bounded attempts; no retry of suppressed/permanent destination. |
| Suppression/bounce | Suppression persisted, future sends blocked, manual audited override only if policy permits. |
| Worker restart | Claim lease/reclaim proof at before/after provider-send boundaries; no stranded `processing` event. |
| Outcome UNKNOWN | Status lookup/callback wait, bounded terminal/manual path, no immediate duplicate. |
| Recipient safety | Non-allowlisted staging destination blocked before I/O; counter/audit increments; zero external call. |
| Misconfiguration | Real mode with missing/placeholder/cross-environment values fails boot/readiness. |
| Rate limit | Per-recipient/channel/provider/global caps work concurrently and emit visible throttling. |

## File-level implementation map

These are future changes only; none were made by this audit.

| FILE | CURRENT RESPONSIBILITY | EXPECTED R9 CHANGE | EXPECTED COMMUNICATION CHANGE | CONFLICT RISK | TESTS |
|---|---|---|---|---:|---|
| `src/payment_provider.ts` | Provider contract and mock/generic/Stripe/Grow wrappers | Preserve interface; require safe Grow webhook/release/status capability in Grow mode; correct success/UNKNOWN mapping and readiness summary | None | HIGH | Grow unit/provider contract; production guard/readiness |
| `src/grow_payment_adapter.ts` | Grow form transport, sealed refs, create/status/settle/refund | Implement verified documented contract, native webhook methods/release, exact status/idempotency semantics, safe errors | None | MEDIUM | Provider fixtures, crypto/redaction, fault mapping |
| `src/frontend_runtime.ts` | Auth/status endpoints and payment webhook | Server-owned auth-intent flow; fail-closed Grow raw-body verification; enqueue reconciliation | Add provider callback endpoints only through shared verified rail if selected | HIGH | API/security/webhook/order/replay tests |
| `src/app.ts` | Join, canonical Worker money flow, notification/invoice enqueue | Consume verified auth intent; normalize synchronous results; release + UNKNOWN jobs; preserve state authority | Pass correlation/recipient resolution; do not send in request thread | HIGH | Join authority, Worker, E2E, crash faults |
| `src/payment_reconciliation.ts` | Resolve/classify/apply provider events | Resolve first-class bindings; amount/currency/ref checks; status outcome normalization | None | HIGH | late/duplicate/mismatch/terminal tests |
| `src/payment_attempt_helpers.ts` | Durable before-I/O attempts | Preserve sole applicable attempt seam; expose rate-limit eligibility/error classification | None | MEDIUM | migration 050 concurrency and SN429 behavior |
| `src/platform_fee_money.ts` | 8% fee/VAT/seller-net math and ledger | Accept authoritative VAT allocation; assert fee base and zero distributor commission | Feed invoice snapshot | HIGH | 8% delivery/VAT/refund/property tests |
| `src/production_guards.ts` | Runtime fail-closed deployment rules | Grow sandbox/live URL/credential/webhook/reference-key/role guards | Real notification/invoice enable/credential/allowlist guards | HIGH | matrix of invalid/valid env combinations |
| `src/runtime_config.ts` | Shared env parsing/defaults | Add explicit Grow/reconcile settings without values; truthful validation | Add channel enables/allowlists/callback/retry settings; remove unused-claim drift | MEDIUM | config parsing/default-deny tests |
| `src/outbox_worker_helpers.ts` / `src/worker_scheduler.ts` | Fenced Worker leases/lanes/DLQ | Add bounded reconciliation/release workload if event types require it | Reuse patterns for notification leases/DLQ | MEDIUM | restart, fencing, concurrency, DLQ |
| `src/notification_dispatch.ts` | Notification interface, queue claim/send/attempt status | None | Explicit SMS/email channel adapter contract, rendered content, bounded retries, lease/reclaim, UNKNOWN/DLQ, correlation | HIGH | unit/Worker/failure/safety matrix |
| `src/notification_templates.ts` | Typed templates/channel compatibility | None | Provider-neutral subject/text/html/SMS outputs and length/encoding validation | MEDIUM | rendering, locale, escaping, channel compatibility |
| `src/invoice_dispatch.ts` | Internal and Morning invoice providers, issue/reconcile/webhook | Use authoritative VAT/party snapshot where money activation requires documents | Optional document-delivery notification remains separate | HIGH | Morning contract, webhook replay/dedupe, legal party/mismatch |
| New forward migration under `src/migrations/` | Schema evolution | Auth-intent/reference binding, release transitions/actions, reconciliation job metadata/indexes | Notification attempt caps/leases/callback events/suppressions/correlation constraints | HIGH | isolated fresh/upgrade migration + DB concurrency |
| `render.yaml` | Staging Web/Worker configuration | Future explicit, separately reviewed sandbox activation only after code proof | Future default-deny communication flags/secrets only after safety proof | HIGH | blueprint/config gate; verify zero live calls before switch |
| Future `tests/grow_*` and existing payment tests | Automated proof | Add unit/integration/DB/Worker/security/E2E and authorized hosted sandbox runner | None | LOW | All R9 gates above |
| Future `tests/notification_*` | Automated notification proof | None | Add real-adapter contract, callback, safety, retry/restart tests with fake transport | LOW | Communication matrix above |
| Future staging Supabase grant migration | Least-privilege DB runtime roles | Grant only new tables/functions to exact Web/Worker role that needs them | Same for callback/Worker notification tables | HIGH | privilege introspection/negative role tests |

Coordination note: `src/app.ts`, `frontend_runtime.ts`, runtime/Worker code, migrations and `render.yaml` are conflict hotspots and were deliberately not edited. Assign ownership per file and land schema/contracts before dependent adapters.

## Known blockers

1. Join lacks DB-authoritative proof that a Grow authorization is confirmed and correctly bound.
2. Grow webhook authentication/parsing is not implemented or documented against the real provider contract.
3. Grow successful capture/recovery/refund cannot currently complete the canonical Worker path without a missing-event error.
4. No automatic UNKNOWN/provider-status reconciliation job exists.
5. Grow release/void is absent; cancelled/failed holds can remain unreleased.
6. DB and TypeScript disagree on valid `AuthReleased` transitions.
7. VAT is hard-coded to zero for fee ledger and charge/refund document snapshots.
8. Provider-reference/correlation ownership is not normalized; fallback resolution relies on audit JSON/client fields.
9. Grow sandbox/live fail-closed guards and truthful readiness signals are incomplete.
10. Real notification adapters and delivery safety/reconciliation do not exist; retry/restart behavior is unsafe.
11. Invoice adapter contract, stable event identity, legal party fields and tax/document semantics are unproven.
12. Current staging payment webhooks can skip verification when no safe secret exists.

## Recommended implementation order

1. Freeze and approve external contracts: current Grow docs/account capabilities, legal VAT/document responsibility, and SMS/email provider choices.
2. Add forward DB contracts: payment authorization/reference binding, legal release transitions, reconciliation metadata, notification lease/retry/callback/suppression fields and least-privilege grants.
3. Fix server authority at hosted authorization and Join; keep browser and redirects non-authoritative.
4. Implement/document Grow adapter semantics, native webhook verification/parser, stable IDs, release and precise UNKNOWN mapping with injected transports.
5. Implement automatic status reconciliation and correct synchronous capture/recovery/refund success handling; add mismatch/manual/DLQ visibility.
6. Close VAT source and 8%-excluding-VAT ledger/invoice snapshot proof; reaffirm zero distributor commission in regression tests.
7. Complete offline unit/DB/Worker/security/failure suites, including rate-limit and crash boundaries.
8. Add explicit communication contracts and staging safety substrate before selecting/enabling real adapters; then implement SMS and email independently on the shared rail.
9. Verify and harden the Morning invoice adapter/legal party mapping; keep it internal-only until its sandbox gate passes.
10. Make separately reviewed environment/Render changes for Grow sandbox only, run the hosted matrix, reconcile every transaction, and obtain owner sign-off for `R9_GROW_SANDBOX_CLOSED`.
11. Keep R10 disabled until its additional controlled-real-money authorization and evidence gate is explicitly approved.

## Final preflight decision

The repository is ready for a disciplined R9 implementation project, not for immediate provider activation. The fastest safe path is to close authorization authority, Grow event/status contracts, UNKNOWN/release mechanics and VAT truth first; only then run the sandbox proof matrix. Communications and invoice providers should proceed as independent, default-deny workstreams sharing the existing durable rails. No R9 or R10 implementation was performed here.
