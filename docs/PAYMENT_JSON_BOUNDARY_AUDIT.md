# Payment JSON Boundary Audit

Status: `PAYMENT_JSON_BOUNDARY_PASS` for the demo / pre-provider-sandbox build.
No live money was performed. No state machine was changed. No money logic was changed.
No raw card data is stored. No secret was added or exposed.

## Foundational Rule

JSONB / JSON in Siton is allowed as:

- evidence — raw provider webhook payloads, audit log payloads, attempt evidence,
- job envelopes — outbox events that carry only IDs (workers re-load from the DB by `aggregate_id`),
- supplemental metadata — masked, advisory, and non-authoritative.

JSONB / JSON is **never** allowed as the source of truth for:

- money (amounts, fees, net),
- state (`deal_state`, `buyer_state`, `money_state`),
- eligibility (invoice issuance, payout eligibility, product/buyer eligibility),
- completion / failure decisions,
- charge / refund decisions,
- refund eligibility,
- payouts,
- platform fees,
- legal compliance,
- admin permissions.

Money truth, state truth, and eligibility truth live in rigid, CHECK-constrained columns,
in PostgreSQL enums, and in the state-machine triggers (`siton.is_valid_*_transition`,
`deals_before_update_enforce`, `participants_before_update_enforce`,
`audit_log_before_insert_enforce`, `deals_outbox_enforce`).

## JSONB Inventory and Classification

| Table | Column | Classification | Truth source |
|---|---|---|---|
| `audit_log` | `payload` | Allowed Evidence Payload | rigid `from_state` / `to_state` / `state_type` + state-machine triggers |
| `webhook_events` | `payload_jsonb` | Allowed Evidence Payload | `(provider, event_id)` PK + `payment_reconciliation.classifyEvent` against current DB state |
| `invoice_webhook_events` | `payload` | Allowed Evidence Payload | `(provider, event_id)` UNIQUE + `invoice_documents` rigid `status` / `document_status` |
| `outbox_events` | `payload` | Allowed Job Payload | `event_type` / `aggregate_type` / `aggregate_id` rigid columns + DB aggregate row |
| `outbox_dlq` | `payload` | Allowed Job Payload | same as outbox_events |
| `idempotency_log` | `response_jsonb` | Allowed Metadata | `response_code` CHECK (`OK`/`ERROR`) + audited entity state |
| `invoice_documents` | `metadata` | Allowed Metadata | rigid: `status`, `document_status`, `gross_amount`, `platform_fee_total_amount`, `seller_net_amount`, `money_state_at_issue` |
| `invoice_document_attempts` | `payload` | Allowed Evidence Payload | `result_class` CHECK + `document_status` CHECK + `provider_document_id` |
| `invoice_reconciliation_cases` | `details` | Allowed Metadata | `case_status` CHECK + rigid `expected_amount` / `observed_amount` |
| `seller_payout_attempts` | `payload` | Allowed Evidence Payload | `result_class` CHECK + `payout_status` CHECK + `provider_reference` |
| `seller_payout_reconciliation_cases` | `details` | Allowed Metadata | `case_status` CHECK + rigid amounts + `blocking_payout` boolean |
| `notification_events` | `payload_jsonb` | Allowed Metadata | `event_type` / `recipient_type` / `channel` / `template_key` / `status` CHECK |
| `notifications` | `template_params` | Allowed Metadata | rigid `template_key` / `status` columns |
| `legal_acceptances` | `metadata_jsonb` | Allowed Metadata | rigid `actor_type` / `acceptance_type` / `policy_version` + `accepted_at` |
| `seller_security_events` | `payload` | Allowed Evidence Payload | rigid `event_type` / `from_status` / `to_status` + `seller_accounts.seller_status` CHECK |
| `operational_case_events` | `payload` | Allowed Evidence Payload | rigid `event_type` CHECK + `from_status` / `to_status` |
| `admin_actions` | `metadata_jsonb` | Allowed Metadata | `action_type` CHECK + `status` CHECK + `target_type` CHECK + `requires_second_approval` boolean |
| `admin_actions` | `result_jsonb` | Allowed Metadata | rigid `status` + `result_code` text + `result_message` text |
| `admin_control_flags` | `metadata_jsonb` | Allowed Metadata | `flag_type` CHECK + `scope_type` CHECK + `status` CHECK + `expires_at` |
| `admin_control_flag_events` | `payload` | Allowed Evidence Payload | rigid `event_type` CHECK + `admin_control_flags` rigid columns |
| `storage_orphan_reports` | `metadata_jsonb` | Allowed Metadata | rigid `scanned_keys_count` / `orphan_keys_count` / `missing_files_count` |

Risky business sources: 0. Forbidden money sources: 0.

## What Is Allowed

- Webhook raw payload retained for audit, dedupe, and reconcile trace.
- Outbox job envelope that carries IDs; workers always reload the entity from DB.
- Admin action input metadata (e.g. `expires_at` for emergency pauses) — `action_type`,
  `target_type`, `requires_second_approval`, and `status` remain rigid.
- Notification template parameters — never the eligibility decision.
- Support / operational case context details.
- Provider payload retained masked for forensics.

## What Is Forbidden

- Reading deal/buyer/money state from JSON to drive a transition.
- Reading amount / platform fee / seller net from JSON to drive money.
- Granting invoice / payout eligibility from a JSON `eligible` flag.
- Granting admin permissions / role / approval from `metadata_jsonb`.
- Storing raw card data (`card_number`, `cvv`, `pan`, `raw_card`, `security_code`)
  in any JSONB column.
- Frontend `localStorage` / `sessionStorage` driving server-side money or eligibility.

## Findings

### P0

- `JSON-BOUND-MONEY-TRUTH` — money truth lives in rigid columns
  (`gross_amount`, `platform_fee_total_amount`, `seller_net_amount`, `siton_fee_amount`,
  `amount_minor`) and is calculated through `calculatePlatformFeeMoney()` from rigid
  `participants.qty`, `deals.price_per_unit`, `participants.delivery_cost`. Status: fixed.

- `JSON-BOUND-STATE-TRUTH` — `siton.deal_state`, `siton.buyer_state`,
  `siton.money_state` are PostgreSQL enums; `siton.is_valid_*_transition`
  enforces every change at the DB level, and `audit_log_before_insert_enforce`
  rejects mismatched audit rows. Status: fixed.

- `JSON-BOUND-INVOICE-ELIG` — `enqueueChargeReceiptForParticipant` /
  `enqueueRefundReceiptForParticipant` derive amounts from rigid columns and rely
  on the calling context to gate by `money_state ∈ {ChargedSuccess,
  RecoveredCharge}` (charge receipt) or `money_state = Refunded` (refund
  receipt). Status: fixed.

- `JSON-BOUND-PAYOUT-ELIG` — `calculateSellerSettlementForDealInTx` derives
  `seller_net_payable` from `siton.platform_fee_money_events` rigid sums;
  `payout_freeze` blocks via `siton.admin_control_flags(flag_type='payout_freeze',
  status='active')` rigid CHECK columns. Status: fixed.

- `JSON-BOUND-NO-RAW-CARD` — Stripe adapter forwards card data to the provider
  over TLS in the request body and never persists `card_number` / `cvv` / `pan`
  in any JSONB column. Mock adapter persists only a hashed authorization id.
  Status: fixed.

### P1

- `JSON-BOUND-WEBHOOK-DEDUPE` — `siton.webhook_events` PK `(provider, event_id)`
  plus `payment_reconciliation.classifyEvent` ignored-when-already-in-target-state
  guarantee that late or duplicate webhook payloads cannot mutate terminal state
  twice. Status: fixed.

- `JSON-BOUND-OUTBOX-PAYLOAD` — Outbox workers (`handleChargeDealEvent`,
  `handleRefundEvent`, `handleFinalizeDealEvent`) re-read the participant and
  deal from DB by `aggregate_id`. The only thing read from JSON evidence is the
  provider authorization / capture reference identifier (from `audit_log.payload`)
  used to call the provider's refund / capture API — the amount is recomputed
  from rigid columns. Status: fixed.

- `JSON-BOUND-ADMIN-METADATA` — `admin_actions.metadata_jsonb` is read at
  `executeAdminAction` only as input parameters (e.g. `expires_at` for
  `pause_charging_emergency`). `action_type`, `status`, `target_type`,
  `requires_second_approval` remain rigid CHECK-constrained. The handler
  branches by `action_type` — metadata cannot promote a forbidden action to
  allowed, and cannot self-approve. Status: fixed.

### P2

- `JSON-BOUND-CLIENT-SESSION` — `frontend/app.js` uses `localStorage` only for
  demo seller-context switching (`usesDemoSellerContext()`), and `sessionStorage`
  only for in-progress join form state. Real authorization always comes from the
  server-side seller cookie session and DB rigid `seller_id` ownership checks.
  Status: fixed.

### P3

None opened in this pass.

## Special Cases And Why They Are Allowed

1. **`audit_log.payload->>'authorization_id'`** in `handleRefundEvent` and
   `handleChargeDealEvent`. The provider's authorization / capture reference is
   stored in `audit_log.payload` because the provider is the source of that
   identifier — it is a *reference*, not a money or state value. The amount is
   recomputed from rigid columns; the eligibility is gated by `money_state ∈
   {ChargedSuccess, RecoveredCharge}`. This is allowed evidence.

2. **`admin_actions.metadata_jsonb?.expires_at`** in `executeAdminAction` for
   `pause_charging_emergency` / `pause_joining_emergency`. `expires_at` is an
   input parameter that controls how long the pause flag remains active. The
   `flag_type`, `scope_type`, `scope_id`, `status` of the resulting flag are
   rigid CHECK-constrained. Without `expires_at`, the action returns
   `PauseExpiresAtRequired`. This is allowed metadata as input parameter.

3. **`frontend_runtime.ts` `template_params->>'participant_id'`** in a notification
   join helper. The template params are pre-recorded at notification enqueue from
   rigid columns; reading the participant_id back is a join hint, not a state
   source. This is allowed metadata.

## What Was Fixed

Nothing required code change in this pass. The boundary was already correct; this
audit recorded the boundary explicitly, classified every JSONB column, added the
`json_boundary_readiness` Mission Control surface, the `npm run test:json-boundary`
static guard, and this document.

## What Remains Open

- Live provider sandbox validation remains a separate gate
  (`docs/PROVIDER_LIVE_MONEY_READINESS.md`). When a real provider is connected,
  the existing webhook signature + dedupe + classify pipeline must be exercised
  end-to-end against the provider's sandbox to confirm the boundary holds with
  real provider payloads.
- Object storage adapter is still required before multi-instance pilot. Storage
  metadata JSONB does not affect the JSON boundary, but local-only storage is
  documented elsewhere.

## How `test:json-boundary` Defends Forward

`tests/json_boundary_validation.ts` enforces, at every CI run:

1. Every JSONB column in `src/migrations/*.sql` is classified in
   `admin_mission_control.buildJsonBoundaryReadiness`.
2. No source file under `src/` reads forbidden truth keys
   (`money_state`, `deal_state`, `buyer_state`, `platform_fee`, `seller_net`,
   `is_eligible`, `is_paid`, `is_completed`, `is_refunded`, `permission`,
   `approval`) out of `payload` / `payload_jsonb` / `metadata_jsonb` /
   `result_jsonb` / `details` / `response_jsonb` / `template_params`.
3. No `card_number`, `cvv`, `pan_full`, `raw_card`, `security_code` appears as a
   stored column or a JSON key (outside of the provider request body that
   forwards card data over TLS without persistence).
4. Invoice and payout eligibility paths read from the rigid columns named above.
5. `payment_reconciliation.classifyEvent` reads `target.buyer_state` /
   `target.money_state` from the DB and ignores duplicate / late webhook events.
6. Outbox workers `SELECT FROM siton.participants p JOIN siton.deals d` for
   every charge / refund / finalize and never read `event.payload.amount` or
   `event.payload.money_state`.
7. `admin_actions.metadata_jsonb` is not used as a permission / approval / role
   grant.
8. Mission Control exposes the readiness section.
9. Frontend `localStorage` / `sessionStorage` does not write money / state /
   permission keys.
10. This document is present.

False positives may be added to a narrow allowlist inside the test (file +
literal pattern + reason + risk + owner_comment). Wide allowlists are rejected
on review.

## Verdict

`PAYMENT_JSON_BOUNDARY_PASS`

JSON / JSONB does not act as a source of truth for money, state, or eligibility
in any path audited. The static guard `npm run test:json-boundary` is wired in
`package.json` and prevents regression. Mission Control surfaces the readiness
section as `json_boundary_readiness`.
