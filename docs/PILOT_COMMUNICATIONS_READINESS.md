# Pilot Communications Readiness — transactional notifications

**Status (2026-09-09):** CODE READY for the closed pilot. REAL DELIVERY **NOT** verified — no e-mail, SMS
or WhatsApp provider exists in this repository, none is configured, and requesting real mode fails closed at
boot. Every number in this document was produced with `NOTIFICATION_PROVIDER_MODE=dry-run` and
`REAL_EMAIL_SENT = REAL_SMS_SENT = REAL_NETWORK_DELIVERY = 0`.

Branch: `claude/pilot-communications-readiness` from master `d4c7877`. No migration. No payment, Grow,
financial-state-machine or fulfillment-architecture change. One staging **grant** file
(`supabase/staging/023_pilot_communications_worker_grants.sql`, not a schema migration).

---

## 1. The contract in one paragraph

A canonical business transition commits → the intended notification row is already part of that commit
(`siton.notification_events`, unique `idempotency_key` derived from business identity) → the Worker claims
it (`FOR UPDATE SKIP LOCKED`), runs the recipient safety gate BEFORE any provider I/O, renders the Hebrew
template server-side, records one `siton.notification_attempts` row per provider call, and moves the row to
`sent` / `pending` (bounded backoff) / `failed` / `blocked` / `skipped`. The provider boundary
(`NotificationProvider` in `src/notification_dispatch.ts`) is the only place a future real adapter plugs in;
business wiring never changes when one is added.

```
business tx ─┬─ canonical state change
             └─ enqueueXxx(c) under SAVEPOINT ─► notification_events (pending)
                                                        │
Worker (runWorkerMaintenance) ── reclaim stranded ── flushPendingNotifications
                                                        │
                        safety gate ─► blocked            │ allowed
                                                        ▼
                                          provider.send()  (log | dry-run | [future real])
                                                        │
                                          notification_attempts + status
```

---

## 2. Event coverage matrix

`CANONICAL SOURCE` is the transaction the row commits with. `KEY` is the deterministic idempotency identity
(`src/notification_events.ts → notificationIdentity`). Channel: buyer = `sms` to the participant's own
phone (`participants.buyer_phone`, the OTP identity captured at Join; `internal` if absent), seller =
`email` from the seller account (support → login → business-profile contact; `internal` if none), admin =
`email` from `ADMIN_ALERT_EMAIL` (`internal` if unset/invalid).

| Event | Canonical source (same transaction) | Recipient | Key (subject part) | Wired before | Wired now | Proof |
|---|---|---|---|---|---|---|
| `buyer_joined_authorized` | Join tx (`POST /deals/:id/join`), after the participant's own tracking token is issued | buyer | `participant:deal` | yes (legacy alias, no link, no money truth) | **yes** — reuses the Join's tracking token, `money_mode` | S2, S3 |
| `buyer_deal_target_reached` | `PendingTarget → TargetReached` (inline in the Join tx, or `tryTargetReached` insideTx) — every participant still holding a stake | buyer | `participant:deal` | **no** | **yes** | S4 |
| `seller_target_reached` | same transition | seller | `seller:deal` | **no** | **yes** | S4 |
| `buyer_deal_completed` | `CompletionWindow → Completed` insideTx (participants that will become `DealCompleted`) | buyer | `participant:deal` | post-commit, legacy alias | **yes**, transactional | S5 |
| `buyer_deal_failed` | `CompletionWindow → Failed` / `PendingTarget → Failed` (deadline) insideTx; also participants that fail inside a Completed deal | buyer | `participant:deal` | post-commit, legacy alias; **duplicated** again on refund | **yes**, transactional, once | S5, S6 |
| `seller_deal_completed` | `CompletionWindow → Completed` insideTx | seller | `seller:deal` | post-commit + a second `seller_excel_ready` at the same moment | **yes**, exactly one | S5 |
| `seller_deal_failed` | Failed transitions insideTx | seller | `seller:deal` | post-commit | **yes**, transactional | S5, S6 |
| `seller_deal_published` | `Draft → PendingTarget` insideTx | seller | `seller:deal` | post-commit, `internal` channel | **yes**, transactional, canonical e-mail + link | S1 |
| `buyer_recovery_required` | `charge_failed` webhook truth: `ChargeAttempt → ChargeFailedRecovery` insideTx | buyer | `participant:deal` | post-commit, legacy alias | **yes**, transactional | S9, S9b |
| `buyer_payment_recovered` | `recovery_captured` webhook truth: `ChargeFailedRecovery → RecoveredCharge` insideTx | buyer | `participant:deal` | **no** (and `charge_captured` wrongly rendered this template) | **yes**; `charge_captured` sends nothing | S9 |
| `buyer_voucher_issued` | per-participant issuance tx after `fulfillment_units` exist (voucher deals) | buyer | `participant:deal` | **no** | **yes** | S7 |
| `buyer_ticket_issued` | same, ticket deals | buyer | `participant:deal` | **no** | **yes** | S8 |
| `seller_customer_inquiry` | inquiry tx (new thread / customer re-open) — P0.7 | seller | `seller:thread:message` | yes | unchanged (verified again) | S10 |
| `seller_kyc_approved` | KYC decision tx, only when `verification_status` actually changes; audited in `seller_security_events` (`seller.kyc.decision`) | seller | `seller:kyc:<decision ordinal>` | **no** | **yes** | S11 |
| `seller_kyc_rejected` | same | seller | `seller:kyc:<decision ordinal>` | **no** | **yes**; optional bounded `seller_reason`, admin note never forwarded | S11 |
| `admin_security_alert` | (a) rejected payment-webhook signature tx (`payment_webhook_security_events`), one per provider+reason+hour; (b) system-opened `PaymentMismatch` operational case | admin | `webhook:…:hour` / `case:PaymentMismatch:<auto_key>` | **no** | **yes** | S12 |
| `seller_excel_ready` | — | — | — | emitted together with completion (duplicate intent) | **not emitted** (template kept for a future async export) | S5 |
| `seller_payout_frozen/unfrozen` | out of pilot scope (payout rail) | — | — | no | no | — |

**Audit outcome:** 16 required event types, 8 were emitted before (2 of them through a wrong template / a
duplicate intent), 16 are wired now. Fixed: `buyer_deal_target_reached`, `seller_target_reached`,
`buyer_payment_recovered`, `buyer_voucher_issued`, `buyer_ticket_issued`, `seller_kyc_approved`,
`seller_kyc_rejected`, `admin_security_alert` (new); `buyer_joined_authorized`, `buyer_deal_completed`,
`buyer_deal_failed`, `seller_deal_completed`, `seller_deal_failed`, `seller_deal_published`,
`buyer_recovery_required` (moved into the canonical transaction, canonical recipient + link + money truth);
removed the `charge_captured → "payment recovered"` mis-alias, the refund-time second "deal failed" and the
completion-time `seller_excel_ready` duplicate.

---

## 3. Recipient source of truth (`src/notification_events.ts`)

| Recipient | Canonical row | Never |
|---|---|---|
| buyer | `siton.participants.buyer_phone` of the participant the event is about (falls back to `buyer_id`, which is the same OTP phone) | a phone/e-mail from a later request body |
| seller | `siton.seller_accounts.support_email` → `login_email` → `siton.seller_business_profiles.contact_email` (savepoint-guarded lookup) of the seller that OWNS the deal (`deals.seller_id`); a caller-supplied seller id that differs from the deal's owner is refused (`deal_seller_mismatch`) | the request's `seller_id`, the customer's e-mail |
| admin | `ADMIN_ALERT_EMAIL` if it is a structurally valid address; otherwise `internal` → visible in the admin console only | a guessed or hard-coded address |

Negative controls proven: spoofed `seller_id` on an inquiry (S10), seller B never receives seller A rows
(S1, S10, S13), every buyer row's destination equals that participant's own phone and its tracking link
names the same participant (S4, S13), buyer phone on the e-mail channel is blocked (R3, R8), participant
that does not exist → `skipped` (S15).

---

## 4. Idempotency scheme

`idempotency_key = event_type:recipient_type:<subject…>:channel`, `UNIQUE` on `notification_events`,
`INSERT … ON CONFLICT DO NOTHING`. Subjects are business identities, never random:

* buyer deal events — `participant_id:deal_id`
* seller deal events — `seller_id:deal_id`
* seller inquiry — `seller_id:thread_id:message_id` (P0.7)
* KYC — `seller_id:kyc:<ordinal>` where the ordinal is the count of committed `seller.kyc.decision`
  audit rows + 1, computed in the same transaction; an unchanged decision (double submit, HTTP retry) writes
  no audit row and no notification
* admin alert — the durable fact's identity (`case:PaymentMismatch:<auto_key>`,
  `webhook:<provider>:<reason>:<hour>`)

Proven no-duplicate paths: HTTP replay of Join/publish (S1, S2), inline + `tryTargetReached` + pause/reopen
(S4), finalize and deadline outbox replay (S5, S6), issuance re-run (S7, S8), duplicate webhook id and a second
webhook for the same business fact (S9), double admin submit (S11), burst of security events (S12),
concurrent ×10 enqueue (R7).

---

## 5. Post-commit policy

* Every business helper takes the transaction client of the canonical transition and writes under a
  `SAVEPOINT` (`withNotificationSavepoint`): the row commits with the state, can never outlive a rollback
  (S3, S9b, S15 rollback), and a notification fault (validation, permission, constraint) is rolled back to
  the savepoint so it can never abort deal or money truth.
* Deal lifecycle transitions pass the fan-out as `insideTx` of `atomicTransition` /
  `atomicMultiTransition` (publish, target reached, completed, failed, deadline, charge failed, recovery
  captured). The message describes the outcome that SAME transaction commits (`dealOutcomeClassifier`
  mirrors the participant state machine: `ChargedSuccess/Recovered → completed`, anything that can still
  fail → failed, `Dropped` → nothing).
* No enqueue from UI optimism, no enqueue on a provider *attempt*: `charge_captured` sends nothing
  (completion is the buyer-facing moment), recovery/recovered fire only on the reconciliation truth.
* Known pre-existing gap (unchanged, outside scope): if the Worker dies AFTER the Completed transition
  commits but before charge receipts / fulfillment issuance run, the finalize replay returns early
  (`state !== CompletionWindow`); notifications are no longer affected (they commit with the transition),
  but receipts/fulfillment on that crash window remain a finalize-replay concern for the financial
  candidate branch.

---

## 6. Template inventory (`src/notification_templates.ts`, Hebrew, brand `C-ton`)

| Template | Channels | Required payload | Truth rules applied |
|---|---|---|---|
| `buyer_joined_authorized_he` | sms/email/whatsapp_link/internal | `deal_title` | mock: "סביבת פיילוט: לא בוצע חיוב אמיתי."; real: hold only, no charge; tracking link |
| `buyer_deal_target_reached_he` | same | `deal_title` | mock line; link |
| `buyer_deal_completed_he` | same | `deal_title` | mock: no charge claim; real: "החיוב בוצע בהתאם לתנאי העסקה."; unknown mode renders as mock |
| `buyer_deal_failed_he` | same | `deal_title` | mock: "לא בוצע חיוב."; real: hold release wording |
| `buyer_recovery_required_he` | same | `deal_title` | "החיוב … לא עבר", completion-window deadline, link |
| `buyer_payment_recovered_he` | same | `deal_title` | mock vs real wording |
| `buyer_voucher_issued_he` / `buyer_ticket_issued_he` | same | `deal_title` | code/entry details ONLY on the tracking page; no code in the message |
| `seller_deal_published_he`, `seller_target_reached_he`, `seller_deal_completed_he`, `seller_deal_failed_he` | email/internal | `deal_title`, `deal_id` | seller deal link `/preview/#/seller/deal/:id`; completion carries the mock line |
| `seller_customer_inquiry_he` | email/internal | `deal_title`, `deal_id`, `thread_id`, `inquiry_url` | pointer only — never the customer's text or e-mail |
| `seller_kyc_approved_he` | email/internal/sms | `seller_name` | workspace link; "לא בוצעה תנועת כסף" |
| `seller_kyc_rejected_he` | email/internal/sms | `seller_name` (`reason` optional) | reason line only when a sanitized seller-facing reason exists |
| `admin_security_alert_he` | email/internal | `alert_title` | title + reference only |
| `seller_excel_ready_he`, `seller_payout_*_he` | — | — | present, not emitted in the pilot |

Payload hygiene at enqueue (`assertPayloadHygiene`): ≤ 8 KB, strings ≤ 2000 chars, no nested objects, no
key that names a credential/card/code, no secret-looking value (private key, AWS/GitHub/Slack/Stripe key
shapes, JWT, 13–19 digit runs); sanctioned link fields may carry the tokenized product link. Seller-facing
reasons are markup-stripped, control-char-free, single-line, ≤ 300 chars.

Canonical links (`notificationLinks`): `PUBLIC_BASE_URL` → `RENDER_EXTERNAL_URL` → none (never
localhost, never a request header on the Worker). Buyer tracking `/preview/#/track/:participant?t=<token>`
(Join reuses its own token; Worker paths mint a `tracking` token `issued_via=notification:<event>`;
`link_mode` in the payload says `tokenized` / `tokenless` / `no_origin`), seller deal
`/preview/#/seller/deal/:id`, seller workspace `/preview/#/seller`, inquiry `/preview/#/seller/inquiries/:thread`.

---

## 7. Dry-run behaviour (`NOTIFICATION_PROVIDER_MODE=dry-run`)

`DryRunNotificationProvider` runs the real rail end to end — claim, safety gate, render, attempt row —
and returns `success` with a deterministic `dryrun_<sha256(notification_id)[:24]>` message id. It opens no
socket. The safety gate in dry-run validates the destination like a real adapter would (empty →
`recipient_missing`, malformed → `recipient_invalid_format` → status `blocked`, attempt row
`blocked_by_recipient_safety`, provider never called) and reports the real-mode shadow verdict
(`explainNotificationRecipientSafety`) so an operator can see what today's env would allow. The mode is
legal in every deployment mode; `production_guards` still refuse `NOTIFICATION_DELIVERY_ENABLED=1` unless
mode is `real`, and `real` refuses to boot without an adapter.

**Operator inspection:** `GET /api/admin/notifications/:notificationId` (admin read guard) → status,
`recipient_masked` (`+97250***567`, `m***@domain`), rendered `subject` + `body_preview` with tokens /
phones / e-mails redacted, `attempt_count`, every attempt (provider, mode, result, message id, error), `why`
(deal, participant, seller, correlation, idempotency key, money mode), `safety.current` and
`safety.real_mode_shadow`. `GET /api/admin/notifications-status` now also reports `blocked`, `cancelled`,
`retry_scheduled`, per-channel `blocked`, and `recipient_masked` on recent events.

**Rehearsal:** `npm run rehearsal:communications` (`scripts/pilot_communications_rehearsal.cjs`) refuses
any non-local database or hosted/production mode, creates a disposable local database, migrates + seeds,
runs `tests/notification_pilot_events_validation.ts` and `tests/notification_pilot_rehearsal_validation.ts`
with the dry-run provider, prints "what would have been sent" (masked) + status totals + attempt providers,
asserts `real_mode_attempts=0`, drops the database (`--keep` to inspect).

---

## 8. Retry / reclaim (unchanged R9A rail, re-proven)

* `temporary_fail` → `pending`, `scheduled_for = now() + 2^(n-1) min` (≤ 30), `attempt_count++`; at
  `NOTIFICATION_MAX_ATTEMPTS` (default 3) → `failed`, `last_error = max_attempts_exhausted (N): …` (R4).
* Worker death mid-flight → row stays `processing`; `reclaimStrandedNotifications` (every maintenance pass,
  `NOTIFICATION_STUCK_TIMEOUT_MS`, default 5 min) counts the stranded attempt and re-queues or terminates
  at the budget; the next flush succeeds exactly once (R5).
* `permanent_fail` → `failed` immediately with the provider reason; a thrown adapter error is a temporary
  failure with a redacted attempt row (R6).
* A `failed` row is never retried by the Worker; the admin `retry_notification` action re-queues it
  explicitly.
* Delivery is at-least-once at the provider boundary; the intended notification is exactly one row.

---

## 9. Safety model (`src/notification_safety.ts`)

Default-deny for any external channel: mode `real` requires `NOTIFICATION_DELIVERY_ENABLED=1` **and**
`SMS_DELIVERY_ENABLED=1` / `EMAIL_DELIVERY_ENABLED=1`; the destination must be structurally valid (E.164 /
e-mail ≤ 200 chars); outside production the destination must be on `NOTIFICATION_RECIPIENT_ALLOWLIST` (or
an allowlisted `NOTIFICATION_ALLOWED_EMAIL_DOMAINS` domain); in production synthetic domains
(`example.com`, `siton.test`, …) and `NOTIFICATION_SYNTHETIC_RECIPIENTS` are blocked. Internal channels
never leave the system. Log/dev modes are internal-only. Dry-run validates format and never sends.
Presentation helpers: `maskNotificationRecipient`, `redactNotificationText` (used by the log line, the
attempt error column and every operator surface). Negative controls: R3, R8, R9, R11, S15.

---

## 10. Real-provider adapter contract (no adapter exists; nothing here is implemented)

A future adapter implements `NotificationProvider.send(notification)` with `mode === "real"` and:

| Concern | Requirement |
|---|---|
| send | one call per claimed row; render with `renderNotification` (subject for e-mail, body for both) |
| provider message id | return it in `provider_message_id` on `success`; it is stored on the attempt row and is the reconciliation handle |
| temporary failure | throttling, 5xx, network timeout → `temporary_fail` (bounded backoff applies) |
| permanent failure | invalid destination, rejected content, 4xx → `permanent_fail` (row → `failed`) |
| timeout | enforce a client timeout (e.g. 8 s); on timeout return `temporary_fail`, never hang the Worker |
| rate limit | provider 429 → `temporary_fail`; the rail's backoff is the only retry loop |
| idempotency / retry | expect at-least-once invocation; pass `notification_id` as the provider idempotency key where supported |
| recipient safety | never bypass `evaluateNotificationRecipientSafety`; the gate runs before the adapter |
| redacted logging | log `maskNotificationRecipient` / `redactNotificationText` output only; never the body |
| environment separation | staging credentials ≠ production credentials; staging runs allowlist-only; `NOTIFICATION_PROVIDER` names the adapter, `NOTIFICATION_PROVIDER_MODE=real` enables it, `production_guards` must recognise the adapter |
| construction | `buildNotificationProvider` must return the adapter only when its credentials are present, otherwise throw (fail closed) |

---

## 11. Exact steps before enabling real e-mail

1. Choose a provider and obtain sandbox + production credentials (owner decision; none chosen).
2. Sending domain: SPF, DKIM, DMARC for the custom domain; a `no-reply@` sender; set `PUBLIC_BASE_URL`
   to the custom domain so every link in every message is canonical.
3. Implement the adapter per §10, register it in `buildNotificationProvider` and `production_guards`,
   add a sandbox proof test that runs ONLY with explicit credentials (like the Stripe sandbox workflow).
4. Staging: `NOTIFICATION_PROVIDER=<adapter>`, `NOTIFICATION_PROVIDER_MODE=real`,
   `NOTIFICATION_DELIVERY_ENABLED=1`, `EMAIL_DELIVERY_ENABLED=1`,
   `NOTIFICATION_RECIPIENT_ALLOWLIST=<owner addresses>`; apply staging grant file 023; run the pilot events
   suite against the hosted runtime with owner-only recipients; verify the inspection endpoint shows real
   provider message ids.
5. Production: set `ADMIN_ALERT_EMAIL`, populate `NOTIFICATION_SYNTHETIC_RECIPIENTS`, enable the master
   switch last, watch `notifications-status` (`failed`, `blocked`, `oldest_pending_age_s`).

## 12. Exact steps before enabling real SMS

1. Choose an SMS provider with an Israeli sender id; obtain sandbox + production credentials.
2. Sender registration / regulatory approval for transactional SMS to Israeli numbers.
3. Adapter per §10 (`sendSms` or `send`), fail-closed construction, sandbox proof test.
4. Staging with `SMS_DELIVERY_ENABLED=1` and an E.164 allowlist of owner phones only; verify segment count
   for the longest Hebrew template (tracking links push several templates past one segment — consider a
   short-link route before production).
5. Production activation as for e-mail.

---

## 13. Pilot operational procedure (dry-run pilot, no real delivery)

* Staging env (no change required): `NOTIFICATION_PROVIDER=log-only`. To rehearse what the pilot WOULD
  send, set `NOTIFICATION_PROVIDER_MODE=dry-run` on the Worker; nothing leaves the system in either mode.
* Apply `supabase/staging/023_pilot_communications_worker_grants.sql` through the privileged procedure so
  Worker-side buyer links are tokenized (until then they are queued with `link_mode=tokenless`).
* Daily: `GET /api/admin/notifications-status` — `failed` and `blocked` should be 0; inspect any row with
  `GET /api/admin/notifications/:id`; a `blocked` row names the bad destination class, a `failed` row the
  provider reason; re-queue with the admin `retry_notification` action.
* When a buyer or seller asks "did you tell me?": the admin participant/deal ops surfaces list the rows;
  the inspection endpoint shows the exact rendered text (redacted).
* Local proof at any time: `npm run rehearsal:communications`.

---

## 14. Verification record (2026-09-09, local fresh databases)

* `tests/notification_pilot_events_validation.ts` — 17/17 (S0–S15), real runtime, dry-run provider,
  Worker maintenance pass drains 57 rows, `real_mode_attempts=0`.
* `tests/notification_pilot_rehearsal_validation.ts` — 12/12 (R1–R12).
* `scripts/pilot_communications_rehearsal.cjs` — PASS on a disposable database (see PROJECT_STATUS for the
  exact totals).
* Existing rail suites (`notification_dispatch_proof`, `notification_ops_proof`,
  `notification_rail_validation`, `notification_reliability_safety_validation`,
  `notifications_readiness_validation`, `p07_seller_inquiries_pickup_validation`) — see PROJECT_STATUS.

**CODE READY ≠ REAL DELIVERY VERIFIED.** Real e-mail / SMS readiness stays at the provider-choice step.
