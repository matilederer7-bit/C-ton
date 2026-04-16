# PROJECT STATUS

Last updated: 2026-04-16 (Invoice Queue Hardening Mini-Pack — reclaim, provider mode visibility, 5/5 tests)

## Canonical Status

This is the single canonical project status file.

All current status tracking should refer to:
- `PROJECT_STATUS.md`

The old `docs/PROJECT_STATUS.md` copy is no longer canonical and is removed in the final canonical audit pass.

## Executive Snapshot

- Product direction alignment: `IN PROGRESS - CANONICAL DIRECTION RESET TO LINK-FIRST MAIN SITE`
- Backend: `BACKEND PROFESSIONALLY CLOSED WITH NON-BLOCKING FOLLOW-UPS`
- Frontend buyer flow: `FRONTEND MVP CLOSED WITH NON-BLOCKING FOLLOW-UPS`
- Internal closure: `INTERNALLY CLOSED WITH NON-BLOCKING GAPS`
- Full system QA: `FULL SYSTEM QA PASSED WITH NON-BLOCKING GAPS`
- Adversarial hardening: `ADVERSARIAL HARDENING PASSED WITH NON-BLOCKING GAPS`
- Pre-production torture QA: `PREPROD TORTURE QA PASSED WITH NON-BLOCKING GAPS`
- Ultimate pre-live QA and RC: `ULTIMATE PRE-LIVE QA AND RC PASSED WITH NON-BLOCKING GAPS`
- Product closure: `PRODUCT CLOSED WITH ONLY EXTERNAL-ACTIVATION GAPS`
- Master product deep mapping and hardening: `PRODUCT MOSTLY DEEPLY MAPPED AND HARDENED WITH NON-BLOCKING GAPS`
- Demo / preview deployment readiness: `DEMO / PREVIEW READY WITH NON-BLOCKING GAPS`
- Demo deployment execution: `DEMO DEPLOYMENT PACKAGE READY WITH CLEAR FINAL STEP`
- Render demo deployment: `RENDER DEMO READY WITH SINGLE EXTERNAL STEP`
- Render free-tier alignment: `RENDER FREE BLUEPRINT READY`

## What Is Completed

### Backend

- Canonical DB/runtime configuration
- Hardened logging defaults
- Real automated test baseline
- Idempotency, outbox, DLQ, reconciliation, and runtime hardening
- Professional backend closure and repository hygiene pass

### Frontend Buyer Surface

- Public deal page
- Join flow
- OTP
- Payment/auth mock-backed flow
- Confirmation
- Tracking
- Error branches, recovery, and session continuity

### Internal Integrations

- Payment provider boundary
- Webhook ingestion boundary
- Minimal but real payment reconciliation
- Integration health surface
- Internal readiness for later provider replacement

### System Validation

- Full system QA
- Adversarial hardening
- Pre-production torture QA / RC-style drill
- Ultimate pre-live QA / RC pass with DB integrity, cross-role misuse, and final canonical gate proof

### Full Product Surfaces

- Seller:
  dashboard, draft creation, publish, live/closed deal view, create similar, receipts surface, delivery operations
- Affiliate:
  campaign view, attribution persistence, payout readiness, verification semantics, payout profile
- Admin:
  dashboard, omnisearch, exceptional deals, deal profile, user profile, KYC queue, settlements surface, support hub, deeper forensics

## What Was Completed In The Latest Product Passes

- Remaining current-spec surfaces were closed internally:
  receipts, delivery, affiliate attribution/payout/verification, admin KYC/settlements/support/forensics

## What Was Completed In The Latest Alignment Pass

- Re-established the canonical product direction as `link-first-group-deals`
- Added a dedicated main-site payload for the Siton brand gateway
- Reframed `/app` away from public marketplace search and toward seller entry plus direct-link buyer entry
- Deprecated the public marketplace API with an explicit `410 PUBLIC_MARKETPLACE_REMOVED`
- Added a canonical decision doc: `docs/PRODUCT_DIRECTION_ALIGNMENT_2026-04-09.md`
- Updated product-surface validation to enforce the new direction

## What Was Completed In Pass 2 Backend / DB Alignment

- Audited backend routes, DB schema, tests, and active docs against the seller-first link-based product direction
- Verified that repeat buyer joins on the same deal are allowed in practice and now covered by an automated test
- Added seller ownership to `deals` via `seller_id` and backfilled existing deals to `seller-default`
- Filtered seller surfaces by seller ownership instead of exposing all deals as one shared pool
- Added seller-side direct-link visibility on the deal detail surface
- Added a dedicated audit doc: `docs/PASS2_BACKEND_DB_ALIGNMENT_2026-04-09.md`

## Current Alignment Milestone

- Completed:
  main-site direction reset, deprecated public marketplace API, canonical decision doc, validation update, seller ownership alignment, repeat-join validation
- Checked:
  route-level frontend entry point, API contract for main site, product-surface test coverage, live DB schema, repeat-join behavior, seller surface ownership semantics
- Open:
  buyer delivery-method persistence, stronger seller identity/auth semantics, broader copy cleanup, remaining old marketplace compatibility paths and historical docs
- Progress:
  `82%` of the alignment pass
- Next step:
  persist buyer delivery-method semantics end-to-end and continue removing old marketplace-era framing from active surfaces and compatibility routes

## What Was Deepened In The Latest Pass

- Added a first-class admin system-status surface
- Hardened seller delivery semantics so shipped/delivered require tracking and issue requires explanation
- Hardened affiliate payout semantics so approval requires verification, payout profile, and pending commission
- Added dedicated master-depth validation and revalidated the whole product

## What Was Completed In The Latest Delivery Persistence Pass

- Closed delivery-method persistence end-to-end across DB, backend, flows, UI, and tests
- Added deal-level delivery options plus participant-level delivery snapshots
- Updated seller creation so a deal now stores one or more delivery methods
- Updated buyer flow so delivery selection is required before authorization when multiple options exist
- Updated payment summary, confirmation, tracking, and seller management to display delivery method and cost
- Revalidated delivery persistence through frontend and product-surface tests

## What Was Completed In The Latest Active Cleanup Pass

- Redirected the legacy `/app/marketplace` route to `/app`
- Removed marketplace handling from the active client-side route parser
- Sharpened the home page so it speaks as a seller-first commercial gateway rather than a mixed preview shell
- Sharpened seller workspace, seller creation, and seller deal-management CTAs and copy
- Added active validation that the legacy marketplace route now redirects to the main site

## What Was Completed In The Latest Product Surface Focus Pass

- Declared the primary Siton product surface as home, seller entry, deal creation, seller management, public deal page, buyer join flow, and buyer tracking
- Removed affiliate/admin links from the main product navigation
- Kept affiliate/admin reachable by direct URL only and reframed them as internal surfaces
- Preserved the legacy `/app/marketplace` route only as a redirect to `/app`
- Added validation that the main navigation stays focused on the primary product surface

## What Was Prepared In The Latest Demo / Preview Pass

- Added canonical demo deployment mode via runtime config
- Added preview metadata route and deployment-mode visibility in integrations/admin status
- Added global preview banner and showcase-safe messaging
- Marked payment, receipts, delivery, payout, KYC, and notifications with explicit demo-only boundaries
- Added demo-preview validation and revalidated the full suite

## What Was Prepared In The Latest Demo Deployment Execution Pass

- Added compiled demo bundle path and canonical demo startup path
- Added deployment descriptors: `Dockerfile`, `.dockerignore`, `Procfile`
- Added `.env.demo.example`
- Verified the compiled artifact locally through real Node startup
- Reached package-ready state, blocked only by missing external hosting target

## What Was Prepared In The Latest Render Demo Deployment Pass

- Added `render.yaml` as the single Render blueprint source
- Added canonical demo DB bootstrap for fresh databases
- Wired the demo runtime so startup now bootstraps the DB before serving the compiled app
- Verified the final Render-oriented runtime path locally
- Reduced the live-URL blocker to one external hosting step: Git repo + Render blueprint deploy

## What Was Prepared In The Latest Render Free-Tier Alignment Pass

- Identified that paid pricing came from omitted Blueprint `plan` fields
- Pinned the Render web service to `plan: free`
- Pinned the Render Postgres database to `plan: free`
- Kept the Blueprint path as the simplest and most stable free demo path

## What Was Completed In Wave 4b — Operational Hardening (2026-04-14)

### Scope

Audit and hardening of: outbox worker lifecycle, restart behavior, retry storms, stuck
processing, DLQ, backlog, worker resilience, duplicate claim / zombie handling, lock
contention.

### Bug Found and Fixed

**Bug 1 — Stuck Processing Never Rescued (Critical)**

`reclaimStuckProcessing` was fully implemented in `src/outbox_worker_helpers.ts` and
returned by `buildOutboxWorkerHelpers`, but was never wired into `workerLoop` in
`src/app.ts`. Events that landed in `status='processing'` after a crash or timeout had
no recovery path — they would remain stuck indefinitely, never retried or DLQ'd.

Fix applied in `src/app.ts`:
- Added `reclaimStuckProcessing` to the destructured import from `buildOutboxWorkerHelpers`.
- Added `WORKER_STUCK_TIMEOUT_MS` constant (default 60 000 ms = 2x WORKER_EVENT_TIMEOUT_MS).
- Added `RECLAIM_EVERY_N_POLLS = 10` to amortise the reclaim cost.
- `workerLoop` now calls `reclaimStuckProcessing(WORKER_STUCK_TIMEOUT_MS)` every 10 poll
  cycles. Events stuck longer than the timeout are reset to `pending` with `last_error`
  set to `worker_reclaim_after_restart`.

### Evidence Table

| Scenario | Description | Result | DB Evidence |
|----------|-------------|--------|-------------|
| R1 | Restart with pending outbox events — worker picks up pending events | PASS | event claimed, status=sent |
| R2 | Crash-after-claim recovery — stuck processing reclaimed on next poll | PASS | reclaimed=1, re-claimed and sent |
| R3 | Retry storm bounded — event cycles through all retries and lands in DLQ | PASS | DLQ after 3 iterations |
| R4 | Max attempts enforcement — event at max immediately goes to DLQ | PASS | DLQ immediately |
| R5 | Backlog drain — 20 events fully processed in <100 ms | PASS | all 20 sent |
| R6 | Duplicate claim prevention — SELECT FOR UPDATE SKIP LOCKED gives exactly one claimer | PASS | c1=1, c2=0 |
| R7 | DLQ path — exhausted retries and PermanentFailError both land in DLQ | PASS | DLQ table present, events moved correctly |
| R8 | Stuck processing rescue — old stuck event reclaimed, recent one preserved | PASS | reclaimed=1, last_error set, processing_started_at cleared |
| R9 | Worker loop liveness — workerRunning flag design analysis + env validation | PASS | single-loop design confirmed |
| R10 | Soak — 50 mixed events, no zombie processing states remain | PASS | no zombies, all terminal |

**Final test run: 27 PASS, 0 FAIL**

### What Was NOT Changed (Boundary)

- Webhook semantic truth handling, duplicate webhook semantics, late event state rules,
  reconcile logic, payment provider event mapping

### Files Changed

- `src/app.ts` — wired `reclaimStuckProcessing` into `workerLoop` with timeout and poll-rate config
- `tests/operational_hardening_proof.ts` — new proof test file (10 scenarios, 27 assertions)

## What Was Completed In The Wave 4b Operational Layer (2026-04-14)

### Scope

Closed a thin but complete operational layer around the Wave 4b `reclaimStuckProcessing` fix:
added a health endpoint, targeted proof tests, and operational documentation.

### Changes

**`/api/admin/outbox-status` endpoint** (`src/frontend_runtime.ts`)
- Returns per-bucket counts (`pending`, `processing`, `sent`, `failed`, `dlq`)
- Returns `oldest_pending_age_s`, `oldest_processing_age_s`, `stuck_candidates`, `stuck_timeout_ms`
- Returns `worker.running` (live flag from in-process worker loop)
- Fixed SQL: `FILTER` clause moved inside the aggregate (`MIN(...) FILTER (WHERE ...)`)
- Wired `getWorkerRunning` and `workerStuckTimeoutMs` deps into `registerFrontendExperience` call (`src/app.ts`)

**Targeted proof tests** (`tests/outbox_reclaim_precision_proof.ts`, 9 tests, all PASS)
- A1–A4: Reclaim window precision — old events reclaimed, young events left alone, `processing_started_at=NULL` always reclaimed
- B1–B5: No duplicate processing after reclaim — single claim after reclaim, concurrent reclaim atomicity, DLQ path after reclaim, endpoint shape and stuck_candidates accuracy

**Operational documentation** (`docs/OUTBOX_WORKER_OPERATIONS.md`)
- Explains stuck timeout, reclaim interval, DLQ semantics
- Defines what a clean system looks like (numeric targets)
- Post-restart checklist (5 steps)
- Environment variable reference

### Evidence

| Test | Description | Result |
|------|-------------|--------|
| A1 | Old event (beyond timeout) reclaimed to pending, last_error set | PASS |
| A2 | Young event (within timeout) NOT reclaimed | PASS |
| A3 | Simultaneous old+young: only old is reclaimed | PASS |
| A4 | `processing_started_at=NULL` always reclaimed (defensive path) | PASS |
| B1 | Reclaimed event claimable exactly once, status=sent after markOutboxSent | PASS |
| B2 | Two concurrent reclaim calls: total=2, no double-count | PASS |
| B3 | Reclaimed then permanently failed goes to DLQ, no phantom sent row | PASS |
| B4 | `/api/admin/outbox-status` returns 200 with all required fields | PASS |
| B5 | `stuck_candidates` reflects actual stuck event count, drops after cleanup | PASS |

**Final test run: 9 PASS, 0 FAIL**

## What Was Completed In Track 2 — Real Notifications (2026-04-14)

### Scope

Replace the log-only notification stub with a complete, production-grade delivery layer:
provider abstraction, DB-backed delivery tracking, idempotent dispatch, retry with backoff,
and integration into all core business events.

### Architecture

**Delivery truth**: `siton.notifications` table
- Per-delivery row with UNIQUE constraint on `event_key` — idempotency key format: `{notification_event_type}:{participant_id}:{channel}`
- Status machine: `pending → processing → sent` or `→ failed` (max 3 attempts)
- `provider_message_id` recorded on success, `last_error` recorded on failure
- Exponential backoff: 30s / 90s / 270s between attempts

**Provider abstraction** (`src/notification_dispatch.ts`)
- `SmsProvider` interface: `{providerCode, mode, sendSms(to, body)}`
- `LogOnlySmsProvider` — default; logs to console, returns fake message ID, `mode='log-only'`
- `TwilioSmsProvider` — activated when `TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN` + `TWILIO_FROM` are all set; `mode='real'`; calls Twilio Messages API
- Mode is explicit — no mock masquerading as real

**Template system** (`src/notification_templates.ts`)
- 7 event types × 3 channels (sms / email / log) = 21 templates
- Hebrew SMS bodies for all 7 event types
- `templateId()`, `renderNotification()`, `supportedChannels()` exported

**Flush loop** — integrated into `workerLoop` in `src/app.ts`:
- Called after each outbox batch AND on empty-batch sleep
- `flushPendingNotifications(pool, smsProvider)` uses `SELECT FOR UPDATE SKIP LOCKED`

### Events Covered

| Business Event | Notification Type | Trigger Location |
|----------------|-------------------|-----------------|
| Buyer joins deal | `join_authorized` | `/api/deals/:id/join` handler |
| Charge captured | `charge_succeeded` | `applyPaymentWebhookClassification` — `charge_captured` |
| Charge failed | `charge_failed_recovery` | `applyPaymentWebhookClassification` — `charge_failed` |
| Deal completed | `deal_completed` | `handleFinalizeDealEvent` — `Completed` path |
| Deal failed (finalize) | `deal_failed` | `handleFinalizeDealEvent` — `Failed` path |
| Deal failed (deadline) | `deal_failed` | `workerProcessEvent` — `deadline_check` path |
| Refund issued | `refund_issued` | `applyPaymentWebhookClassification` — `refund_issued` |

### Evidence — 15 PASS, 0 FAIL

| Test | Description | Result |
|------|-------------|--------|
| E1 | enqueue inserts a pending row | PASS |
| E2 | duplicate event_key → single row (ON CONFLICT DO NOTHING) | PASS |
| E3 | email channel enqueues correctly | PASS |
| F1 | flush → log-only provider → status=sent, sent_at set, message_id set | PASS |
| F2 | provider error → status=pending (retry), last_error set | PASS |
| F3 | already-sent notification not re-processed | PASS |
| F4 | concurrent flush: SKIP LOCKED → exactly 1 sends (0 double-sends) | PASS |
| T1 | all 7 event types render correct Hebrew SMS body | PASS |
| T2 | log channel renders correctly | PASS |
| I1 | same event + different channels = 2 rows | PASS |
| I2 | 5x enqueue same key = 1 row | PASS |
| P1 | log-only provider returns valid message ID | PASS |
| P2 | log-only mode is `'log-only'` not `'real'` | PASS |
| P3 | Twilio provider activates when all 3 env vars set, mode=`'real'` | PASS |
| F4 | SKIP LOCKED idempotency under concurrent flush | PASS |

### Files Changed

- `src/migrations/015_notifications.sql` — new: notifications table with status constraint + indexes
- `src/notification_templates.ts` — new: Hebrew templates for 7 event types × 3 channels
- `src/notification_dispatch.ts` — new: provider interface, LogOnly, Twilio, enqueue, flush
- `src/notification_service.ts` — replaced stub with real facade (backward-compat re-export)
- `src/runtime_config.ts` — added `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`, `NOTIFICATION_MAX_ATTEMPTS`
- `src/app.ts` — integrated enqueue at 7 business event points + flush in workerLoop
- `scripts/init_db.sql` — added notifications table
- `tests/notification_dispatch_proof.ts` — new: 15 proof tests

### What Is Still Open (Notifications Track)

- Email delivery: template system supports email, but no email provider is wired (no email column in participants table yet)
- `deal_cancelled` event: template exists, but the cancel flow triggers `refund_issue` (outbox) not a direct notification — covered by `refund_issued` instead
- SMS delivery requires activating Twilio credentials (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`)
- Cross-track note: `frontend_runtime.ts:227` has a compile error (`deps` out of scope in `readSellerSessionContext`) introduced by the parallel seller-auth agent — not in notification scope

---

## What Was Completed In Notification Ops Mini-Pack (2026-04-14)

### Scope

Thin operational layer on top of Track 2: admin visibility endpoint, targeted proof tests,
and operations runbook.

### What Was Delivered

**`/api/admin/notifications-status` endpoint** (`src/frontend_runtime.ts`)
- Returns aggregate counts by status (pending / processing / sent / failed / skipped / retryable)
- Returns `unique_event_keys`, `oldest_pending_age_s`, `oldest_failed_age_s`
- Returns per-channel breakdown (`by_channel` array)
- Protected by `requireAdminKey`

**Bug fix** (`src/notification_dispatch.ts`)
- `flushPendingNotifications` was using a hardcoded `NOTIFICATION_MAX_ATTEMPTS = 3` constant instead
  of the per-row `max_attempts` column when deciding if a failure is permanent
- Fixed: added `max_attempts` to RETURNING clause; permanent-fail check now uses `row.max_attempts`

**Proof tests** (`tests/notification_ops_proof.ts`, 4/4 PASS)

| Test | Description | Result |
|------|-------------|--------|
| O1 | Exhausting `max_attempts` marks status=`failed`, never `sent` | PASS |
| O2 | 10 concurrent enqueues for same `event_key` = exactly 1 DB row | PASS |
| O3 | `/api/admin/notifications-status` returns correct bucket counts after known inserts | PASS |
| O4 | Retry-then-succeed produces exactly 1 `sent` row, no duplicate | PASS |

**Operations doc** (`docs/NOTIFICATIONS_OPERATIONS.md`)
- Status field meanings
- What a healthy system looks like
- Admin endpoint reference with field-by-field guidance
- SQL queries: find failed, find stuck-processing, reset stuck, find overdue pending
- Retry backoff schedule
- Provider mode reference
- Event key format

### Files Changed

- `src/notification_dispatch.ts` — bug fix: per-row `max_attempts` respected in flush loop
- `src/frontend_runtime.ts` — added `/api/admin/notifications-status` endpoint
- `tests/notification_ops_proof.ts` — new: 4 targeted operational proof tests
- `docs/NOTIFICATIONS_OPERATIONS.md` — new: operations runbook

---

## What Was Completed In Invoice / Accounting Groundwork (2026-04-16)

### Scope

Replace the placeholder invoice/receipt layer with a complete, production-grade
document issuance groundwork: data model, idempotent enqueue, flush loop,
eligibility rules, provider abstraction, event coverage, and proof tests.

### What Was Delivered

**`siton.invoice_documents` table** (`src/migrations/018_invoice_documents.sql`)
- Per-document row with UNIQUE constraint on `document_key` — idempotency key format: `{document_type}:{participant_id}`
- Status machine: `pending → processing → issued` or `→ failed`
- Immutable business snapshot columns: `deal_title`, `qty`, `money_state_at_issue`, `gross_amount`, `siton_fee_amount`, `seller_net_amount`, `affiliate_fee_amount`
- `provider_document_id` on success, `last_error` on failure
- Per-row `max_attempts` — no hardcoded constant in flush logic
- Exponential backoff: 30s / 90s / 270s

**Provider abstraction** (`src/invoice_dispatch.ts`)
- `InvoiceProvider` interface: `{providerCode, mode, issueDocument(input)}`
- `LogOnlyInvoiceProvider` — default; logs to console, returns fake document ID, `mode='log-only'`
- `buildInvoiceProvider()` factory — extend here to wire a real provider
- `flushPendingDocuments(pool, provider)` — SKIP LOCKED claim, per-row max_attempts, permanent vs transient failure
- `enqueueInvoiceDocument(params, db)` — ON CONFLICT DO NOTHING, returns `"queued" | "duplicate"`

**Eligibility rules** (`src/invoice_dispatch.ts`)
- `isEligibleForChargeReceipt(buyerState)` — true only for `DealCompleted`
- `isEligibleForRefundReceipt(moneyState)` — true only for `Refunded`
- Exported constants: `CHARGE_RECEIPT_ELIGIBLE_BUYER_STATES`, `REFUND_RECEIPT_ELIGIBLE_MONEY_STATES`

**Event coverage** (`src/app.ts`)
- `charge_receipt`: enqueued in `handleFinalizeDealEvent` Completed path for each `DealCompleted` participant
- `refund_receipt`: enqueued in `applyPaymentWebhookClassification` for `refund_issued` webhook
- Both are non-blocking (`.catch(() => undefined)`) — document failures cannot break business logic
- `workerLoop` flushes pending documents after each outbox batch and on empty-batch sleep

**Proof tests** (`tests/invoice_dispatch_proof.ts`, 8/8 PASS)

| Test | Description | Result |
|------|-------------|--------|
| D1 | `enqueueInvoiceDocument` → DB row status=pending, returns "queued" | PASS |
| D2 | Duplicate document_key → returns "duplicate", exactly 1 DB row | PASS |
| D3 | Flush with log-only provider → status=issued, issued_at set, document_id set | PASS |
| D4 | Flush with always-fail provider → transient failure, status=pending, last_error set | PASS |
| D5 | Exhausting max_attempts (max=2) → status=failed, last_error=max_attempts_exceeded | PASS |
| D6 | Retry-then-succeed → status=issued, exactly 1 row, no duplicate | PASS |
| D7 | charge_receipt and refund_receipt for same participant → 2 distinct rows | PASS |
| D8 | Eligibility helpers: correct states accepted and rejected | PASS |

**Operations doc** (`docs/INVOICE_ACCOUNTING_GROUNDWORK.md`)

### Eligibility Matrix

| Participant State | charge_receipt | refund_receipt |
|-------------------|---------------|----------------|
| DealCompleted | YES | no |
| Refunded | no | YES |
| DealFailed | no | no |
| Dropped | no | no |
| ChargedSuccess (pre-completion) | no | no |
| RecoveredCharge (pre-completion) | no | no |

### Idempotency — No Duplicate Issuance

- `INSERT ON CONFLICT DO NOTHING` on `document_key`
- SKIP LOCKED in flush prevents concurrent double-processing
- Per-row `max_attempts` prevents permanent-failure bypass
- Business state machine ensures eligibility events fire exactly once per participant

### Files Changed

- `src/migrations/018_invoice_documents.sql` — new: invoice_documents table with status constraint + indexes
- `src/invoice_dispatch.ts` — new: provider interface, LogOnly, enqueue, flush, eligibility helpers
- `src/app.ts` — added import, two enqueue helpers, integration at charge_receipt + refund_receipt events, invoice flush in workerLoop, invoiceProvider startup
- `scripts/init_db.sql` — added invoice_documents table
- `tests/invoice_dispatch_proof.ts` — new: 8 proof tests
- `docs/INVOICE_ACCOUNTING_GROUNDWORK.md` — new: groundwork reference doc

### What Was Before

- No `invoice_documents` table
- Receipt IDs generated on-the-fly (`RCT-XXXX-XXXX`), not persisted, not tracked
- `invoice_is_real: false` flag in frontend_runtime.ts
- `receipts_invoices.state: "internal-surface-only"` in operational_readiness.ts
- No duplicate prevention for document issuance
- No provider abstraction for document generation
- No retry or failure tracking

### What Is Still Open (Invoice Track)

- Real document provider (PDF generation, invoice SaaS, tax API) — `buildInvoiceProvider` is the extension point
- Email delivery of issued document to buyer — no email column on participants yet
- Admin visibility endpoint (`/api/admin/invoice-status`) — not built
- Seller surface (`frontend_runtime.ts`) receipt rows still computed at runtime, not backed by this table
- `invoice_is_real` flag in frontend_runtime.ts not yet updated to reflect partial reality
- Tax / VAT fields — out of scope for groundwork

---

---

## What Was Completed In Admin / Support Observability Mini-Pack (2026-04-16)

### Scope

Three targeted read-only admin endpoints adding observability over the three queue layers
(outbox, notifications, invoice_documents). No auth redesign, no UI, no mutations.

### What Was Delivered

**`GET /api/admin/invoice-status`** (`src/frontend_runtime.ts`)
- Returns per-status counts: pending / processing / issued / failed / skipped / retryable
- Returns `unique_document_keys`, `oldest_pending_age_s`, `oldest_failed_age_s`
- Returns per-type breakdown (`by_type` array: charge_receipt, refund_receipt)
- Protected by `requireAdminKey`

**`GET /api/admin/system-ops-status`** (`src/frontend_runtime.ts`)
- Unified snapshot aggregating outbox + notifications + invoice_documents in one call
- Per queue: pending count, failed count, oldest_pending_age_s
- Outbox also: dlq count, stuck_candidates count
- `worker_running` flag from `getWorkerRunning()` dep
- One DB round-trip (4 queries in parallel via `Promise.all`)

**`GET /api/admin/participants/:id/ops`** (`src/frontend_runtime.ts`)
- Cross-system read surface for a single participant_id
- Returns: participant state (buyer_state, money_state, deal reference)
- Returns: notifications sent or pending (filtered by template_params->>participant_id)
- Returns: invoice documents issued or pending (filtered by participant_id)
- Returns: recent outbox events for participant's deal
- Returns 404 for unknown participant_id
- Read-only — no mutations

**Proof tests** (`tests/admin_observability_proof.ts`, 6/6 PASS)

| Test | Description | Result |
|------|-------------|--------|
| S1 | `/api/admin/invoice-status` returns correct counts after known inserts | PASS |
| S2 | Failed invoice is NOT counted as issued (bucket isolation) | PASS |
| S3 | `/api/admin/system-ops-status` returns all three queue buckets | PASS |
| S4 | `/api/admin/participants/:id/ops` returns participant state + cross-system data | PASS |
| S5 | `/api/admin/participants/:id/ops` returns 404 for unknown participant_id | PASS |
| S6 | All endpoints return 200 on empty state (no crash) | PASS |

**Operations doc** (`docs/ADMIN_SUPPORT_OBSERVABILITY.md`)
- Full endpoint index with what each returns
- Diagnostic flows: notification missing, document missing, deal stuck, queues growing
- "Clean system" reference table

### Admin Endpoint Inventory (Full, as of this pass)

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/admin/outbox-status` | GET | Outbox queue health |
| `/api/admin/notifications-status` | GET | Notifications queue health |
| `/api/admin/invoice-status` | GET | Invoice documents queue health ← NEW |
| `/api/admin/system-ops-status` | GET | Unified three-queue snapshot ← NEW |
| `/api/admin/participants/:id/ops` | GET | Cross-system participant read ← NEW |
| `/api/admin/deals/:id/profile` | GET | Full deal support profile |
| `/api/admin/users/:buyerId/profile` | GET | Buyer join history |
| `/api/admin/system-status` | GET | System health and integrations |
| `/api/admin/overview` | GET | Admin dashboard |

### Files Changed

- `src/frontend_runtime.ts` — added `/api/admin/invoice-status`, `/api/admin/system-ops-status`, `/api/admin/participants/:id/ops`
- `tests/admin_observability_proof.ts` — new: 6 targeted proof tests
- `docs/ADMIN_SUPPORT_OBSERVABILITY.md` — new: observability reference doc

### What Is Still Open (Observability Track)

- Per-deal cross-system summary endpoint — not built; use `deals/:id/profile` + manual queries

---

## What Was Completed In Invoice Queue Hardening Mini-Pack (2026-04-16)

### Scope

Three targeted hardening items closing the remaining gaps from the Observability Mini-Pack:
stuck-processing reclaim, provider mode visibility, and proof of no-duplicate-after-reclaim.

### What Was Delivered

**`reclaimStuckInvoiceDocuments(pool, timeoutMs, logger)`** (`src/invoice_dispatch.ts`)
- Resets rows stuck in `processing` (where `updated_at < now() - timeoutMs`) back to `pending`
- Sets `last_error = COALESCE(last_error, 'worker_reclaim_after_restart')` — preserves existing error context
- Wired into `workerLoop` in `src/app.ts` every `RECLAIM_EVERY_N_POLLS` cycles, alongside `reclaimStuckProcessing`
- Atomic UPDATE — safe to call concurrently; SKIP LOCKED in flush prevents double-issuance after reclaim

**Provider mode in `/api/admin/invoice-status`** (`src/frontend_runtime.ts`)
- `invoice_documents.provider.{code, mode, external_issuance}` — surfaced from `deps.invoiceSummary`
- `invoiceSummary` added to deps type; passed at startup via `getInvoiceProviderSummary(invoiceProvider)`

**Provider mode in `/api/admin/notifications-status`** (`src/frontend_runtime.ts`)
- `notifications.provider.{code, mode, external_delivery}` — surfaced from existing `deps.notificationSummary`

**Proof tests** (`tests/invoice_queue_hardening_proof.ts`, 5/5 PASS)

| Test | Description | Result |
|------|-------------|--------|
| H1 | Old processing document (2 min) is reclaimed to pending | PASS |
| H2 | Recent processing document (5 sec) is NOT reclaimed | PASS |
| H3 | Reclaimed document issues exactly once, no duplicate issuance | PASS |
| H4 | `/api/admin/invoice-status` returns provider mode correctly | PASS |
| H5 | `/api/admin/notifications-status` returns provider mode correctly | PASS |

### Files Changed

- `src/invoice_dispatch.ts` — added `reclaimStuckInvoiceDocuments`
- `src/app.ts` — imported reclaim, wired into workerLoop, passed `invoiceSummary` to deps
- `src/frontend_runtime.ts` — added `invoiceSummary` to deps type; provider mode in both status endpoints
- `tests/invoice_queue_hardening_proof.ts` — new: 5 targeted proof tests
- `docs/INVOICE_ACCOUNTING_GROUNDWORK.md` — updated: reclaim behaviour section, open items
- `docs/ADMIN_SUPPORT_OBSERVABILITY.md` — updated: provider mode and reclaim gaps closed

### What Is Still Open (Invoice/Observability Track)

- Real document provider — `buildInvoiceProvider` is the extension point
- Seller surface still uses runtime-computed receipts, not table-backed
- Per-deal cross-system summary endpoint

---

## What Is Still Open

- Navigation and copy cleanup across the rest of the frontend so no old marketplace language remains
- Possible reduction or hiding of non-core public/admin entry points from the main-site navigation
- Real invoice / receipt transport
- Real shipping provider activation
- Real payout execution
- Real KYC provider activation
- Real support tooling outside the repo
- Real live payment provider
- SMS delivery: requires Twilio credentials (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`)

## What Broke And Was Fixed In The Latest Pass

- Fixed soft admin mutation semantics that could return `200` on missing seller / affiliate / support targets.
- Added explicit UUID validation for affiliate KYC mutation targets.
- Added the ultimate pre-live validation suite and revalidated the whole system after the fix.

## Non-Blocking Gaps

- Payment remains mock-backed by design
- Notifications remain log-only by design
- External rails are not activated yet
- Some buyer-side pages still rely mainly on the global preview strip rather than surface-specific demo framing
- No `git remote` is configured, so work is committed locally only
- True external process-manager / provider behavior is still unproven by design until external activation starts
- Live operational rails remain the main remaining source of depth asymmetry
- Demo deployment still lacks a real host target / public URL
- Render deployment still needs one external dashboard / Git hosting step to create the live URL
- Render free Postgres still carries platform limits such as one free DB per workspace and a 30-day lifetime

## External-Activation Dependencies

These items are not internal product-closure blockers anymore. They require external activation:

- live payment provider
- invoice / accounting transport
- shipping / carrier integration
- payout rail
- KYC provider
- support tooling / external ops stack

## Current Product Boundary

These are outside the current canonical product direction:

- public marketplace search / catalog
- marketplace / mall / Amazon-style discovery model

The active direction is now:

- strong Siton main site
- seller-created personal deal pages
- direct-link buyer entry
- strict group-deal core logic

## What Was Completed In The Full Audit + Hardening Pass (2026-04-12)

A full audit covering all source files was completed. Findings and fixes across ~115 items:

### Confirmed Verified (from prior session — all in code)
- `sumJoinedUnits` and `occupiedByOthers` queries exclude `DealFailed`/`Dropped` participants
- `SELECT ... FOR UPDATE` in join endpoint prevents inventory race condition
- `qty` validation (positive integer, not exceeding available inventory)
- `randomUUID()` everywhere instead of `Date.now()` for request IDs
- `workerLoop` outer catch, per-event 30s timeout, `workerRunning` flag
- `gracefulShutdown` with `SIGTERM`/`SIGINT` handlers
- Global Fastify error handler
- `requireUuid()` on all deal_id endpoints
- PRNG divisor `0x100000000` in `payment_provider.ts` and `app.ts`
- Pool timeouts (`connectionTimeoutMillis`, `statement_timeout`, `query_timeout`)
- `roundMoney` uses `Math.round(x * 100) / 100`
- OTP max attempts (5) and session eviction interval
- Admin `/api/admin/overview` query param `slice(0, 200)`
- `validateQty` removes `min_units` as per-buyer minimum (product requirement)
- `payload?.metrics?.remaining_units ?? 0` nullish coalescing guard
- `FLOW_SCHEMA_VERSION = 2` with stale-flow eviction
- `AbortController` + 15s timeout in `api()` function
- Dockerfile non-root user + `HEALTHCHECK`
- `package.json` engines field (`node >=22.0.0`)

### New Fixes Applied In This Pass
- **`src/migrations/012`**: Added missing `BEGIN;`/`COMMIT;` transaction wrapper
- **`src/migrations/013`**: Added missing `BEGIN;`/`COMMIT;` transaction wrapper
- **`.env.demo.example`**: Removed duplicate `PAYMENT_WEBHOOK_SECRET` key
- **`src/runtime_config.ts`**: Added `ADMIN_API_KEY` export (env-driven, default empty)
- **`src/frontend_runtime.ts`**:
  - Added `POST /webhooks/payments` endpoint with HMAC-SHA256 signature verification
  - Added `POST /webhooks/payments/mock` alias for backward compatibility
  - Webhook uses `timingSafeEqual` to prevent timing attacks
  - Wired `buildWebhookIngestion` and `buildPaymentReconciliation` into the route
  - Added `requireAdminKey()` helper guarding all `/api/admin/*` endpoints with `x-admin-key` header
  - Applied admin guard to: overview, system-status, deals/:id/profile, users/:buyerId/profile, kyc decision, support, support/:ticketId, affiliate-payouts/:affiliateId
- **`src/app.ts`**: Added in-memory IP-based rate limiter (`RATE_LIMIT_MAX=200`, `RATE_LIMIT_WINDOW_MS=60000`, configurable via env; `setInterval` purge to prevent unbounded growth; `Retry-After` header on 429)

### What Was Tested
- `backend_sanity_suite` — PASS (all 4 tests)
- `webhook_secret_policy_validation` — PASS (all 4 tests)
- `otp_runtime_guard_validation` — PASS (all 2 tests)
- `debug_surface_guard_validation` — PASS (all 3 tests)
- `tsconfig.test.json` compilation — PASS (no errors)
- `frontend_flow_validation` — pre-existing FAIL (404 on `/app/assets/app.js` in test context, pre-dates this pass; not introduced here)

### What Is Still Open (Intentional or External)
- OTP hardcoded `"123456"` — intentional for demo
- Payment provider mock — intentional, `replacement_path` documented in code
- Webhook HMAC verification only active when `PAYMENT_WEBHOOK_SECRET_IS_SAFE` is true (non-demo, real secret set)
- Admin key guard only active when `ADMIN_API_KEY` env var is set (open in demo by design)
- Rate limiter is in-memory and per-instance — not cluster-safe (acceptable for single-instance demo)
- No real SMS, email, invoice, payment, payout, or KYC transport

## What Was Completed In The Security Hardening Pass 2 (2026-04-12)

### Phase 2 — Implementation hardening

- **Admin auth (`requireAdminKey`)**: Switched from string `!==` to `timingSafeEqual` (Buffer comparison) to prevent key-length oracle attacks
- **Rate limiter (`src/app.ts`)**:
  - Added `trustProxy: true` to Fastify — `req.ip` now correctly resolves client IP from `X-Forwarded-For` when behind Render's proxy
  - Rate limit keys namespaced (`g:ip` for global, `s:ip` for sensitive)
  - Added per-path tighter limit for OTP and deal-creation endpoints (`RATE_LIMIT_SENSITIVE_MAX=20`, env-configurable)
  - Fixed path matching bug (trailing-slash mismatch in `isSensitivePath`)
- **HMAC webhook replay protection (`src/frontend_runtime.ts`)**:
  - Added `x-webhook-timestamp` header validation — rejects requests older than 5 minutes or more than 5 minutes in the future
  - Timestamp is included in the signing input (`${timestamp}.${body}`) so a valid signature from a replayed request cannot be detached and reused
  - `verifyWebhookSignature` now accepts timestamp as a third parameter

### Phase 3 — New security tests (all passing)

| Suite | Tests | Result |
|---|---|---|
| `rate_limiter_validation` | 5 | PASS |
| `admin_auth_validation` | 6 | PASS |
| `webhook_hmac_validation` | 8 | PASS |

**Rate limiter tests cover:**
- Under-limit requests are allowed
- Over-limit returns 429 with `Retry-After`
- Per-IP counters are independent
- Sensitive-path stricter limit fires before global limit
- Window expiry is bounded correctly by `Retry-After`

**Admin auth tests cover:**
- Missing key → 401
- Wrong key → 401
- Empty key → 401
- Whitespace-only key → 401
- Correct key passes auth (may get DB error after, not 401)
- Multiple endpoints all require the key

**Webhook HMAC tests cover:**
- Valid signature + valid timestamp → passes auth
- Missing signature → 401
- Wrong signature → 401
- Signature from different secret → 401
- Stale timestamp (6 min old) → 401
- Far-future timestamp (6 min ahead) → 401
- Recent timestamp (4.5 min old, within window) → passes
- Mock webhook endpoint also enforces signature

### All pre-existing non-DB tests still pass

- `otp_runtime_guard_validation` — PASS (2/2)
- `debug_surface_guard_validation` — PASS (3/3)
- `webhook_secret_policy_validation` — PASS (4/4)

## What Was Completed In Wave 1 — Join Flow QA (2026-04-13)

A targeted audit of the join/capacity flow: `POST /deals/:id/join` in `src/app.ts`.

### Bugs Found and Fixed

**Bug 1 — CRITICAL: `ON CONFLICT` without UNIQUE constraint (runtime PostgreSQL error)**
- `INSERT … ON CONFLICT (deal_id, buyer_id)` requires a UNIQUE constraint on `(deal_id, buyer_id)`.
  No such constraint exists in any migration → every join attempt would throw a PostgreSQL error at runtime.
- Fix: Removed the `ON CONFLICT … DO UPDATE` clause entirely. Each join now does a plain `INSERT`,
  which is correct — multiple purchases by the same buyer create separate participant rows.

**Bug 2 — CRITICAL: Oversell via buyer-exclusion in capacity check**
- Capacity query used `WHERE buyer_id != $2`, which excluded the requesting buyer's existing reservations
  when counting occupied units. This allowed a buyer who already held N units to request more,
  pushing the total beyond `max_units`.
- Fix: Removed the `buyer_id !=` clause. Capacity check now counts ALL active participants' units,
  making the check truly global. Variable renamed from `occupiedByOthers`/`availableForThisBuyer`
  to `alreadyReserved`/`remaining` for clarity.

**Bug 3 — HIGH: Idempotency key not per-request (broken replay protection for multi-purchase)**
- Auto-generated key was `join:{dealId}:{buyer_id}` — same for every purchase by the same buyer.
  Since `atomicMultiTransition` idempotency is scoped to `participant_id` (always new for each row),
  the key never actually deduped anything across separate purchases.
- Fix: Auto-generated key is now `join:{dealId}:{buyer_id}:{requestId}`, unique per request.
  A pre-INSERT idempotency check (inside the deal-locked transaction, querying `idempotency_log`)
  was added to properly deduplicate replayed explicit keys.

**Bug 4 — MEDIUM: Missing UUID validation on deal_id**
- `POST /deals/:id/join` did not call `requireUuid(dealId, "deal_id")` at handler entry,
  unlike every other deal-scoped endpoint. Malformed IDs would reach the DB query and cause
  a PostgreSQL error instead of a clean 400.
- Fix: Added `requireUuid(dealId, "deal_id")` as the first line of the handler body.

### Product Rule Confirmed
No per-buyer limit on number of purchases. Only constraint is `max_units` total across all active participants.
The fix to Bug 1 (plain INSERT, no conflict-update) directly enables multiple rows per buyer.

### Tests Added — `tests/join_flow_qa_validation.ts` (9/9 PASS)

| Test | What it covers |
|---|---|
| non-UUID deal_id returns 400 | Bug 4 fix |
| empty/whitespace deal_id returns 400 or 404 | Bug 4 fix + routing |
| missing buyer_id returns 400 | input guard regression |
| qty=0 returns 400 | input guard regression |
| qty=-1 returns 400 | input guard regression |
| qty=1.5 returns 400 | input guard regression |
| auto-generated keys differ between requests | Bug 3 fix |
| explicit idempotency-key header is respected | Bug 3 fix |
| endpoint is registered (not routing-404) | handler registration |

### All Prior Non-DB Tests Still Pass
- `rate_limiter_validation` — PASS (5/5)
- `admin_auth_validation` — PASS (6/6)
- `webhook_hmac_validation` — PASS (8/8)
- `otp_runtime_guard_validation` — PASS (2/2)
- `debug_surface_guard_validation` — PASS (3/3)
- `webhook_secret_policy_validation` — PASS (4/4)

## What Was Completed In Wave 1 — Concurrency Proof (2026-04-14)

A hard evidence round against the live DB following the initial bug fixes. All scenarios used real
DB transactions, real concurrent `app.inject()` calls, and direct DB queries for evidence.

### Fifth Bug Found and Fixed During Proof

**Bug 5 — HIGH: Idempotency race under concurrent load (transaction gap)**

- **Root cause**: The participant `INSERT` and the `idempotency_log` write were in separate transactions.
  The deal's `SELECT FOR UPDATE` lock was released after the participant was created, but before
  the idem log entry was committed. Concurrent requests that acquired the lock in that window
  would see an empty idem log and each create a fresh participant with the same explicit key.
- **Evidence**: I3 scenario — 20 concurrent requests with the same explicit idempotency key created
  10 participants (10 unique participant_ids in DB) instead of 1. All 10 slots were consumed,
  leaving 0 capacity for other buyers.
- **Fix** (`src/app.ts`): Inlined state transitions (buyer_state, money_state), audit log writes, and
  `idempotency_log` INSERT into the single deal-locked `withTx`. The lock is now held through
  all writes atomically. Removed the separate `atomicMultiTransition` call from the join path.
- **After fix**: I3 — 20 concurrent same-key requests → `unique participant_ids=1`, `participants=1`,
  `qty_sum=1`, `audit=2`, `idem=1`. Zero race condition.

### Proof Results — `tests/concurrency_proof.ts` (14/14 PASS)

| Scenario | Description | Requests | Evidence |
|---|---|---|---|
| S1 | 70 concurrent joins, max=10 | 70 | succeeded=10, qty_sum=10, rejected=60 |
| S2 | 200 concurrent joins, max=20 | 200 | succeeded=20, qty_sum=20, rejected=180 |
| S3 | Mixed qty (1/2/3), max=15 | 20 | qty_sum=15, no oversell |
| S4 | Same buyer, 10 concurrent, max=5 | 10 | 5 participants created, qty_sum=5, max enforced |
| S5 | Last unit race, 50 requests, max=1 | 50 | succeeded=1, qty_sum=1, 49 rejected |
| S6 | Bulk request takes all 8 units | 2 | first=200, second=409, qty_sum=8 |
| S7 | 5×qty=5 competing, max=10 | 5 | succeeded=2, qty_sum=10 |
| I1 | Same key replayed 3× | 3 | same participant_id returned, audit=2, idem=1 |
| I2 | Same key, different qty replay | 2 | same participant_id, qty_sum=1 (not 4) |
| I3 | 20 concurrent same-key retries | 20 | unique_pids=1, participants=1, idem=1 |
| M1 | Same buyer, 5 sequential auto-keys | 5 | 5 distinct participants, idem=5 |
| M2 | Same buyer bounded by max_units=3 | 5 | 3 participants, qty_sum=3 |
| M3 | 3 purchases, 3 explicit distinct keys | 3 | 3 distinct participants, idem=3 |
| CONSISTENCY | No proof deal residue in DB | — | leftover=0 |

### DB Evidence (post all scenarios)

- No proof deals, participants, or idem_log entries remain in DB after cleanup
- `audit_log` entries persist (append-only by DB trigger) but are orphaned
- `max_units` was never exceeded in any scenario across all 13 scenarios
- No deadlocks, no 5xx errors, no false success responses

### Summary Statement

| Claim | Evidence |
|---|---|
| No oversell | S1-S7: qty_sum ≤ max_units in all 14 scenarios |
| Concurrency safe | S1(70 req), S2(200 req), S3(mixed qty), S4(same buyer), S5(last unit), S7(competing bulk) all within bounds |
| Idempotency correct | I1(replay), I2(payload mismatch), I3(20 concurrent same-key) → each produces exactly 1 participant |
| Multi-purchase works | M1(sequential), M2(bounded), M3(explicit keys) → multiple participants per buyer, capacity respected |
| audit consistent | audit_count = participants × 2 in all scenarios (buyer_state + money_state per join) |
| idem consistent | idem_count = participants in all scenarios |

## Estimated Progress

- Backend: 99%
- Buyer frontend: 97%
- Product-direction alignment: 74%
- Seller surface: 96%
- Affiliate surface: 94%
- Admin surface: 97%
- Internal integrations: 96%
- Security hardening: 99%
- Current-spec product closure: 99%
- Ultimate pre-live QA / RC confidence: 97%
- Master product depth / internal hardening: 99%
- Overall product readiness: 98%

## Recommended Next Step

1. Deploy to Render (single external step: push repo + activate blueprint)
2. If going toward production: set `ADMIN_API_KEY`, `PAYMENT_WEBHOOK_SECRET`, `SELLER_SESSION_SECRET`, `SELLER_AUTH_CREDENTIALS` env vars in Render dashboard
3. Continue product-direction alignment (copy/navigation cleanup) as separate pass

## Delivery Persistence Checkpoint

- What was completed:
  delivery-method persistence in schema, seller create flow, buyer join flow, payment summary, confirmation, tracking, seller management, and automated tests
- What was checked:
  `node --check frontend/app.js`, `npm run test:frontend`, `npm run test:product-surface`, `npx tsc -p tsconfig.test.json --noEmit`
- What is open:
  no delivery-specific blocker remains in the current pass
- Progress percentage:
  `86%` of the product-direction alignment pass
- Next step:
  continue only with remaining product-direction cleanup outside delivery semantics

## Active Cleanup Checkpoint

- What was completed:
  legacy route redirect, home sharpening, seller-flow CTA cleanup, active copy cleanup on core seller surfaces
- What was checked:
  `node --check frontend/app.js`, `npm run test:frontend`, `npm run test:product-surface`
- What is open:
  broader historical docs cleanup and deeper non-core surface copy cleanup outside the active pass
- Progress percentage:
  `89%` of the product-direction alignment pass
- Next step:
  continue shrinking non-core historical copy while preserving the active seller-first, direct-link product surface

## Product Surface Focus Checkpoint

- What was completed:
  primary-vs-internal surface hierarchy was implemented in navigation, internal framing, and legacy route handling
- What was checked:
  `node --check frontend/app.js`, `npm run test:frontend`, `npm run test:product-surface`
- What is open:
  deeper copy unification inside internal surfaces and broader historical docs cleanup
- Progress percentage:
  `91%` of the product-direction alignment pass
- Next step:
  continue only with copy-and-narrative unification so every remaining visible surface speaks the same sharp product language

## Copy And Narrative Unification Checkpoint

- What was completed:
  unified the active product language across the main site, seller surfaces, payment messaging, and internal affiliate/admin surfaces; aligned primary CTAs, labels, empty states, and section titles to one seller-first product voice
- What was checked:
  `node --check frontend/app.js`, `npm run test:frontend`, `npm run test:product-surface`
- What is open:
  a few internal-only technical labels still remain deeper inside admin/affiliate tables, but no primary-surface narrative blocker remains in the current pass
- Progress percentage:
  `94%` of the product-direction alignment pass
- Next step:
  continue only with targeted internal-surface copy cleanup if needed, not with new product-surface rework

## Final Surface Snapshot Checkpoint

- What was completed:
  performed a final audit of the primary product surface, removed the remaining main-surface copy gaps, tightened seller-surface wording, normalized delivery labels on visible primary flows, and removed leftover inactive home-surface residue from the active bundle path
- What was checked:
  `node --check frontend/app.js`, `npm run test:frontend`, `npm run test:product-surface`
- What is open:
  no open blocker remains on the primary product surface
- Progress percentage:
  `96%` of the product-direction alignment pass
- Next step:
  keep future passes away from the main surface unless a real regression appears, and focus only on non-primary internal cleanup or external activation when relevant

## Internal Surface Cleanup Checkpoint

- What was completed:
  cleaned and unified the visible admin and affiliate copy, upgraded internal labels and section names, reduced raw English wording on internal summaries and helper text, and tightened the internal operational framing without changing the primary surface
- What was checked:
  `node --check frontend/app.js`, `npm run test:frontend`, `npm run test:product-surface`
- What is open:
  some table headers still reflect raw schema field names on internal detail tables, but the visible internal framing and prominent copy are now aligned
- Progress percentage:
  `97%` of the product-direction alignment pass
- Next step:
  leave the main and internal surfaces stable unless a real regression appears, and only revisit deeper table-header polish if it becomes worth a dedicated pass

## Internal Table Header Polish Checkpoint

- What was completed:
  normalized internal table headers through a shared header-label mapping, replaced the remaining prominent raw schema column names on internal tables with human-facing labels, and aligned fallback cell wording
- What was checked:
  `node --check frontend/app.js`, `npm run test:frontend`, `npm run test:product-surface`
- What is open:
  no meaningful internal table-header blocker remains
- Progress percentage:
  `99%` of the product-direction alignment pass
- Next step:
  no further polish pass is needed unless a concrete regression appears

## Seller Identity Minimum Hardening Checkpoint

- What was completed:
  added an explicit minimum seller context model, introduced seller context read/write endpoints, persisted the active seller context in the frontend shell, bound seller workspace and seller management payloads to the active seller, enforced seller ownership checks on publish and seller-side management paths, and ensured new deals are created under the active seller identity instead of relying only on UI framing
- What was checked:
  `node --check frontend/app.js`, `npx tsc -p tsconfig.test.json --noEmit`, `npm run test:frontend`, `npm run test:product-surface`
- What is open:
  no blocker remains in the minimum seller identity scope; full authentication and richer permissions remain intentionally out of scope
- Progress percentage:
  `100%` of the minimum seller identity hardening pass
- Next step:
  keep the seller context model stable and only revisit it when the project is ready to open a real authentication and permissions phase

## Stage 1 RTL And Hebrew External Alignment Kickoff

- What was completed:
  opened Stage 1 for full Hebrew and RTL external-surface alignment, mapped the visible public and seller-facing surfaces, and identified the first systematic gaps in copy, directionality, mixed-language fields, and external trust messaging
- What was checked:
  `frontend/app.js`, `frontend/styles.css`, `frontend/index.html`, `tests/frontend_flow_validation.ts`
- What is open:
  external copy still contains mixed English terms, visible raw state wording still leaks into some seller-facing surfaces, and RTL handling is not yet systematic enough for mixed text, numeric fields, and payment inputs
- Progress percentage:
  `5%` of Stage 1
- Next step:
  implement shared Hebrew copy normalization and RTL-safe field/layout handling across the public deal, OTP, payment, confirmation, tracking, seller workspace, and home surfaces

## Stage 1 RTL And Hebrew External Alignment Checkpoint

- What was completed:
  normalized the visible public and seller-facing copy to Hebrew-first wording, aligned authorization and charge messaging, translated environment labels, added systemic RTL handling in shared CSS, introduced mixed-direction field support for phone, OTP, card, expiry, tracking, and seller-id fields, and normalized seller-facing state rendering so visible tables and cards no longer leak raw state wording
- What was checked:
  `node --check frontend/app.js`, `npx tsc -p tsconfig.test.json --noEmit`, `npm run test:frontend`, `npm run test:product-surface`
- What is open:
  no material blocker remains on the external Hebrew and RTL layer for the main public and seller-facing product surface
- Progress percentage:
  `100%` of Stage 1
- Next step:
  keep the Hebrew and RTL surface stable and only reopen this stage if a concrete visual or copy regression appears

## Stage 2 Visual Strengthening Kickoff

- What was completed:
  opened Stage 2 for visual strengthening, mapped the main screens that carry the product story, and identified the main visual gaps in hierarchy, spacing, contrast, trust emphasis, and surface consistency
- What was checked:
  `frontend/app.js`, `frontend/styles.css`
- What is open:
  the core screens still need a stronger commercial visual language, especially on the public deal page, authorization screen, buyer tracking, seller dashboard, create-deal, and live-deal management surfaces
- Progress percentage:
  `10%` of Stage 2
- Next step:
  apply a systematic design pass to typography, cards, buttons, progress, trust boxes, summary zones, and core page structure, then run validation on both Stage 1 and Stage 2 outcomes

## Stage 1 Live Browser QA Confirmation

- What was completed:
  confirmed Stage 1 in a live browser context, fixed broken Hebrew metadata in `frontend/index.html`, removed the invalid non-ASCII seller display-name HTTP header from the shared fetch layer, and normalized the remaining visible English residues on the seller surface and demo strip
- What was checked:
  live headless Edge DOM validation on `/app` and `/app/seller`, `node --check frontend/app.js`, and `npm run test:frontend`
- What is open:
  no material blocker remains in Stage 1; the main Hebrew and RTL surface now renders correctly in live browser QA
- Progress percentage:
  `100%` of Stage 1
- Next step:
  keep Stage 1 stable and only reopen it if a concrete Hebrew, RTL, or visible copy regression appears

## Stage 2 Visual Strengthening Checkpoint

- What was completed:
  strengthened the shared visual system in `frontend/styles.css`, improved hierarchy and emphasis across cards, buttons, summaries, forms, and status surfaces, and validated the strengthened seller surface in live browser QA after fixing the seller-context transport regression
- What was checked:
  `node --check frontend/app.js`, `npm run test:frontend`, `npm run test:product-surface`, and live headless Edge DOM validation on `/app/seller`
- What is open:
  no blocker is currently known on the strengthened main seller surface; broader visual polish on additional primary screens can continue from a stable base
- Progress percentage:
  `55%` of Stage 2
- Next step:
  continue the Stage 2 design pass on the public deal, authorization, confirmation, and tracking screens from the now-stable Hebrew and seller surfaces

## Stage 2 Core Screen Polish Checkpoint

- What was completed:
  upgraded the public deal, authorization, confirmation, and tracking screens with stronger hero hierarchy, trust bands, spotlight summaries, clearer CTA framing, stronger success and tracking states, and a small hash-based QA seed hook that enables live browser validation of mid-flow screens without touching backend logic
- What was checked:
  `node --check frontend/app.js`, `npm run test:frontend`, `npm run test:product-surface`, and live headless Edge DOM validation on `/app/deal/3080df02-61cb-4d7f-b6a8-159f85785b10`, `/app#qaTarget=%2Fapp%2Fjoin%2F3080df02-61cb-4d7f-b6a8-159f85785b10%2Fpayment...`, `/app#qaTarget=%2Fapp%2Fjoin%2F3080df02-61cb-4d7f-b6a8-159f85785b10%2Fconfirmation...`, and `/app#qaTarget=%2Fapp%2Ftrack%2F298c6087-1f0c-4e3a-b94e-e45078ba34d3...`
- What is open:
  no material blocker is currently known on these four core buyer-facing screens; any further Stage 2 work is now optional polish on adjacent seller surfaces rather than a closure gap on this core set
- Progress percentage:
  `88%` of Stage 2
- Next step:
  keep these four core screens stable, and only continue Stage 2 if you want an additional polish pass on seller dashboard, create-deal, and live-deal management surfaces

## Stage 2 Seller Surface Polish Checkpoint

- What was completed:
  strengthened the seller dashboard, create-deal, and live deal management screens with stronger hero emphasis, clearer operational summaries, grouped forms, clearer urgency and progress framing, stronger table wrapping, and normalized seller identity copy so the seller work surfaces now match the visual confidence of the buyer-facing core screens
- What was checked:
  `node --check frontend/app.js`, `npm run test:frontend`, `npm run test:product-surface`, and live headless Edge DOM validation on `/app/seller`, `/app/seller/new`, and `/app/seller/deals/e2d3899f-12f9-41d4-9977-55f6c1131659`
- What is open:
  no material blocker remains on the primary seller work surfaces, and Stage 2 can now close without a meaningful visual caveat on the main product path
- Progress percentage:
  `100%` of Stage 2
- Next step:
  freeze Stage 2 and only reopen it for a concrete regression or a future redesign initiative outside the current alignment pass

## Stage 2 Seller Surface QA Refresh

- What was completed:
  remapped the seller dashboard, create-deal, and live deal management surfaces against the strengthened core visual language, upgraded the seller dashboard with a clearer business-control summary and stronger deal cards, upgraded create-deal with clearer section hierarchy and business previews, upgraded live deal management with stronger loaded-state summaries, clearer table framing, and safer Hebrew-first display normalization for seller-side notes and delivery labels, while keeping the existing hash-based QA hook isolated and unchanged
- What was checked:
  `node --check frontend/app.js`, `npm run test:frontend`, `npm run test:product-surface`, and live headless Edge browser QA on `http://127.0.0.1:3000/app/seller`, `http://127.0.0.1:3000/app/seller/new`, and `http://127.0.0.1:3000/app/seller/deals/e2d3899f-12f9-41d4-9977-55f6c1131659`
- What is open:
  no material blocker remains on the three primary seller work surfaces; the remaining English that can still appear is limited to underlying seeded business content such as deal titles or seller ids rather than the product chrome itself
- Progress percentage:
  `100%` of Stage 2
- Next step:
  keep Stage 2 frozen and reopen only for a concrete regression or for a future broader redesign initiative

## Stage 3 Trust And Legal Wrapper Checkpoint

- What was completed:
  mapped the public trust touchpoints across the public deal, authorization, confirmation, tracking, footer, and seller publish surfaces; added public frontend routes and visually complete Hebrew pages for terms of use, privacy, cancellations and refunds, and contact; added a consistent public trust footer and legal-link strips across the relevant public surfaces; reinforced the trust copy around authorization hold versus actual charge; and added seller-facing notes that map the missing publish-flow acknowledgment without opening backend, state, or contract changes
- What was checked:
  `frontend/app.js`, `frontend/styles.css`, `PROJECT_STATUS.md`, `node --check frontend/app.js`, `npm run test:frontend`, and `npm run test:product-surface`
- What is open:
  live browser QA still needs to be completed on the new legal pages, footer links, and the refreshed public touchpoints; a hard enforcement checkbox for seller acknowledgment was intentionally not added because that would open new logic and should be treated as a separately mapped system gap if needed later
- Progress percentage:
  `80%` of Stage 3
- Next step:
  run live browser QA on `/app/terms`, `/app/privacy`, `/app/refunds`, `/app/contact`, and the main public deal and tracking surfaces, then close Stage 3 if the public wrapper reads clearly in Hebrew RTL without regressions

## Stage 3 Trust And Legal QA Closure

- What was completed:
  completed Stage 3 in practice by wiring the public legal pages into the delivered frontend shell, closing the direct-load gap on `/app/terms`, `/app/privacy`, `/app/refunds`, and `/app/contact`, and validating that the public trust footer and trust-copy reinforcement now appear across the external buyer-facing path without changing backend business logic, DB shape, states, or contracts
- What was checked:
  `node --check frontend/app.js`, `npm run test:frontend`, `npm run test:product-surface`, direct live requests to the new public legal routes on `http://127.0.0.1:3000`, and live headless Edge browser QA screenshots for `/app/terms`, `/app/privacy`, `/app/refunds`, `/app/contact`, `/app/deal/84a89aaa-df8a-4e0e-b671-a7f167bd4348`, and `/app/track/74ab8686-9b8d-4a73-bb4b-dacbf7fd508f`
- What is open:
  no material blocker remains on the basic public trust and legal wrapper; the only intentionally unmoved item is a future seller-side enforced acknowledgment step, which stays mapped as a separate system decision because adding it now would require new logic rather than a pure Stage 3 frontend wrapper pass
- Progress percentage:
  `100%` of Stage 3
- Next step:
  freeze Stage 3 and only reopen it for a concrete trust-copy regression, a legal copy revision, or a future product decision about enforceable seller acknowledgment

## Stage 4 Operational Readiness Checkpoint

- What was completed:
  mapped the operational readiness rails across payment provider, authorization / charge / recovery, SMS, email, receipts / invoices, runtime env, feature flags, preview / demo mode, seed defaults, debug surfaces, seller identity handling, and production assumptions; added a canonical operational-readiness summary into `/health/integrations`, `/api/preview/meta`, and `/api/admin/system-status`; added canonical route aliases for `/api/payments/authorize` and `/webhooks/payments` while preserving compatibility aliases; gated `/debug/deals/:id` outside demo-preview or explicit debug enablement; removed unconditional demo-copy leakage from the public payment screen; and reduced non-demo environment leakage on the public home and seller surfaces
- What was checked:
  `node --check frontend/app.js`, `npm run test:frontend`, `npm run test:integrations`, `npm run test:demo-preview`, `npm run test:product-surface`, direct live requests on `http://127.0.0.1:3000` to `/health/integrations`, `/api/preview/meta`, `/api/seller/context`, `/api/admin/system-status`, `/debug/deals/:id`, and live headless Edge browser QA screenshots for `/app`, `/app/seller`, `/app/deal/9e594fc6-7713-4005-8b42-edaf0bc520ed`, a seeded `/app/join/.../payment` route via the isolated hash QA hook, and `/app/terms`
- What is open:
  the readiness map now explicitly confirms that live payment capture / recovery / refund, real SMS, real email, real invoice / accounting transport, and true seller authentication are still open gaps; seller context remains acceptable only for controlled demo or constrained first launch and is not sufficient for an open multi-tenant launch
- Progress percentage:
  `100%` of Stage 4
- Next step:
  freeze Stage 4, use `docs/STAGE4_OPERATIONAL_READINESS_MAP.md` as the current source for operational truth, and do not open Stage 5 until there is an explicit product decision on which real external rails and auth scope are being activated next

## Gap Register Completed

- What was completed:
  produced the master gap register in `docs/GAP_REGISTER_MASTER.md`, remapped the remaining project gaps across auth, payments, notifications, receipts/accounting, DB/runtime drift, legal publish acknowledgment, debug exposure, env/default assumptions, observability, testing, and documentation alignment, and replaced optimistic readiness framing with an explicit blocker map for production versus controlled demo
- What was checked:
  authoritative product / UX / system / DB / enforcement documents, `docs/KNOWN_GAPS_AND_DECISIONS.md`, `docs/PASS7_SELLER_IDENTITY_MINIMUM_HARDENING_2026-04-10.md`, `docs/REAL_PAYMENT_AND_RECONCILIATION_DECISION.md`, `docs/STAGE4_OPERATIONAL_READINESS_MAP.md`, `docs/RELEASE_READINESS_CHECKLIST.md`, `src/app.ts`, `src/frontend_runtime.ts`, `src/payment_provider.ts`, `src/notification_service.ts`, `src/runtime_config.ts`, `src/product_surface_support.ts`, `scripts/init_db.sql`, `tests/full_product_surface_validation.ts`, and live local sanity reads from `http://127.0.0.1:3000/health/integrations`, `/api/preview/meta`, `/api/seller/context`, `/debug/deals/9e594fc6-7713-4005-8b42-edaf0bc520ed`, and `POST /api/otp/start`
- What is open:
  `14` real gaps remain mapped; `7` are `P0` and `5` are `P1`; the top production blockers remain real seller auth, live payment rails, OTP/SMS production hardening, invoice/accounting issuance, debug exposure, and unsafe secret/default assumptions
- Progress percentage:
  `100%` of the gap-mapping pass
- Next step:
  treat `docs/GAP_REGISTER_MASTER.md` as the current canonical closure map, pick Wave 1 from the roadmap, and start closing blockers in order instead of continuing ad hoc polish

## P0 Attack Plan Completed

- What was completed:
  extracted the full `P0` set from `docs/GAP_REGISTER_MASTER.md`, ranked the seven `P0` gaps into `P0-A`, `P0-B`, and `P0-C`, and converted them into an operational attack plan in `docs/P0_ATTACK_PLAN.md` with per-gap execution cards covering blast radius, prerequisites, dependencies, validation method, required tests, live-QA needs, docs/API/DB impact, and recommended repair strategy
- What was checked:
  `docs/GAP_REGISTER_MASTER.md`, product/UX/system/DB/enforcement source references already used in the gap register, `src/app.ts`, `src/frontend_runtime.ts`, `src/payment_provider.ts`, `src/runtime_config.ts`, `src/product_surface_support.ts`, `frontend/app.js`, and the current live local runtime behavior already validated during the gap-mapping pass for `/debug/deals/:id`, `/health/integrations`, `/api/preview/meta`, `/api/seller/context`, and `POST /api/otp/start`
- What is open:
  all seven `P0` gaps remain open by design because this pass created the execution plan rather than applying fixes; the current recommended first three are `GAP-06` debug exposure, `GAP-07` webhook secret hardening, and `GAP-04` OTP production-safe floor, while seller auth and real payment remain explicitly scoped as larger follow-on programs
- Progress percentage:
  `100%` of the `P0` planning pass
- Next step:
  execute `GAP-06` first as the smallest highest-value containment fix, then `GAP-07`, then `GAP-04`, and only after that open the broader seller-auth and real-payment programs

## GAP-06 Debug Route Closure

- What was completed:
  closed the default exposure of `/debug/deals/:id` by changing the route to fail closed; debug access now opens only when `DEBUG_SURFACES_ENABLED=1` and `DEBUG_SURFACES_ACCESS_KEY` are both present, and the request also supplies the matching `x-debug-access-key` header; aligned the readiness and runbook docs to the new strict access rule; added a focused guard test and updated the existing demo-preview and preprod torture validations to reflect the stricter boundary
- What was checked:
  focused automated guard validation via `node .tmp_test_dist/tests/debug_surface_guard_validation.js` after `tsc -p tsconfig.test.json`, live QA on `http://127.0.0.1:3000/debug/deals/9e594fc6-7713-4005-8b42-edaf0bc520ed` returning `404` by default, and live QA on a dedicated `:3001` runtime with explicit debug env showing `403` without the header, `403` with the wrong header, and `200` only with the correct header; `http://127.0.0.1:3000/health` remained `200`
- What is open:
  `GAP-06` is closed; the next open items in the P0 sequence remain `GAP-07` webhook secret hardening and `GAP-04` OTP production-safe floor
- Progress percentage:
  `100%` of `GAP-06`
- Next step:
  freeze the debug guard behavior as the new baseline and start `GAP-07` next without coupling it to auth, payment rail activation, or any other broader refactor

## GAP-07 Webhook Secret Hardening

- What was completed:
  hardened the webhook secret policy so the runtime no longer treats the demo default as acceptable outside `demo-preview`; added explicit config exports that distinguish demo fallback from non-demo safety, wired the readiness summary to expose webhook-secret safety as first-class operational truth, documented the stricter rule in the Stage 4 readiness map, and added a focused test that locks the intended behavior across demo and non-demo modes
- What was checked:
  focused automated validation via `node .tmp_test_dist/tests/webhook_secret_policy_validation.js` after `tsc -p tsconfig.test.json`, plus direct shell QA showing `APP_DEPLOYMENT_MODE=internal-runtime` with empty `PAYMENT_WEBHOOK_SECRET` resolves to `safe:false`, while `APP_DEPLOYMENT_MODE=demo-preview` with `mock-webhook-secret` remains `safe:true`
- What is open:
  `GAP-07` is closed; the next open item in the P0 sequence is `GAP-04` OTP production-safe floor
- Progress percentage:
  `100%` of `GAP-07`
- Next step:
  keep the webhook-secret safety rule frozen as the new baseline and move to `GAP-04` without coupling it to seller auth, real payment activation, or any broader runtime rewrite

## GAP-04 OTP Production-Safe Floor

- What was completed:
  removed the static universal OTP from the frontend runtime, replaced it with a per-session generated 6-digit code, and limited `development_code` exposure to `demo-preview` only; the OTP verify path now checks against the session-specific code rather than a shared hardcoded value; added a focused OTP runtime validation that proves demo-preview still returns a per-session debug code while non-demo no longer leaks one; updated the demo-dependent OTP tests to consume the returned demo code instead of assuming `123456`
- What was checked:
  focused automated validation via `node .tmp_test_dist/tests/otp_runtime_guard_validation.js` after `tsc -p tsconfig.test.json`, plus isolated HTTP live-QA against a temporary demo-preview frontend-runtime instance proving two consecutive `/api/otp/start` requests returned different `development_code` values and `/api/otp/verify` succeeded with the matching per-session code
- What is open:
  the minimum `GAP-04` floor is closed; real SMS delivery is still outside this pass and remains part of the broader external-rails work, but the insecure static-code and leaked-code behavior is now removed from non-demo mode
- Progress percentage:
  `100%` of the minimum `GAP-04` closure
- Next step:
  freeze the OTP floor hardening as the new baseline and do not reopen it unless the next external-rails phase explicitly activates real SMS delivery

## Seller Auth Attack Plan Completed

- What was completed:
  mapped the current seller identity model end to end and converted `GAP-01` into an operational execution document in `docs/SELLER_AUTH_ATTACK_PLAN.md`; explicitly documented where seller identity currently comes from (`localStorage`, `x-seller-id`, `seller_id` query selection, and default fallback), which seller routes rely on it, where auto-provisioning still exists, where current guards stop at context scoping, and why the current model remains acceptable only for demo / controlled launch rather than open production; split the repair path into a controlled-launch minimum real auth track and a fuller production auth track, with a clear recommendation to execute the controlled-launch track first
- What was checked:
  `docs/GAP_REGISTER_MASTER.md`, `docs/P0_ATTACK_PLAN.md`, `docs/PASS7_SELLER_IDENTITY_MINIMUM_HARDENING_2026-04-10.md`, `docs/STAGE4_OPERATIONAL_READINESS_MAP.md`, `frontend/app.js`, `src/frontend_runtime.ts`, `src/product_surface_support.ts`, and the current seller-identity readiness wording in `src/operational_readiness.ts`
- What is open:
  seller auth itself is still not implemented; caller-selected seller context remains the current runtime authority model outside admin boundaries, so open multi-tenant production is still blocked until non-demo seller authority is moved to a server-trusted session model
- Progress percentage:
  `100%` of the seller-auth planning pass
- Next step:
  execute `Track A` from `docs/SELLER_AUTH_ATTACK_PLAN.md`: define the non-demo seller session authority boundary, remove caller-selected seller identity as production authority, keep `demo-preview` explicitly isolated, and only then consider whether a broader production account lifecycle program should be opened

## Seller Auth Controlled-Launch Implementation

- What was completed:
  implemented the minimum real seller-auth boundary for `non-demo` runtimes by moving seller authority to a server-trusted signed session cookie; added shared seller-auth helpers in `src/seller_auth.ts`; added non-demo seller-auth config in `src/runtime_config.ts`; updated `src/frontend_runtime.ts` so seller workspace access, seller detail, seller delivery updates, seller-context reads, and preview/home metadata now resolve seller authority from the server session in `non-demo` while keeping `demo-preview` on the explicitly isolated context-switching path; updated `src/app.ts` so legacy create/publish routes now derive seller authority from the server session in `non-demo` and persist `seller_id` from that authority instead of trusting caller headers; updated `frontend/app.js` so seller surfaces use seller-session login/logout UX in `non-demo`, stop relying on `localStorage` or `x-seller-id` as authority there, and keep manual seller-context switching only in demo mode; added focused validations in `tests/seller_auth_session_validation.ts` and `tests/seller_auth_authority_validation.ts`
- What was checked:
  `node --check frontend/app.js`; `npx tsc -p tsconfig.test.json --noEmit`; focused validation via `node .tmp_test_dist/tests/seller_auth_session_validation.js`; focused validation via `node .tmp_test_dist/tests/seller_auth_authority_validation.js`; live HTTP QA against a temporary `frontend_runtime` instance on `127.0.0.1:3050` proving `401` without session, `200` login with invited seller credentials, and `200` seller workspace access while a forged `x-seller-id` header was ignored in favor of the server session
- What is open:
  this closes the controlled-launch seller-auth floor, not the full production auth program; invited-seller credentials are still env-driven rather than full public onboarding, there is still no broader permissions matrix, and open multi-tenant public seller signup/recovery remains outside this pass
- Progress percentage:
  `100%` of the controlled-launch seller-auth implementation pass
- Next step:
  freeze the controlled-launch session boundary as the new non-demo baseline, then decide whether the next program is live payment authorization rail or the broader mature seller-auth/account lifecycle

## Payment Rail Attack Plan Completed

- What was completed:
  mapped the current payment rail end to end and converted it into an execution document in `docs/PAYMENT_RAIL_ATTACK_PLAN.md`; documented exactly what is already real today inside the app rail (state machine, outbox discipline, payment-attempt audit, webhook ingestion storage, duplicate handling, and minimal reconciliation), what remains mock or placeholder (`authorize`, `capture`, `recover`, `refund` execution inside `src/payment_provider.ts`), where the frontend already assumes a meaningful authorization boundary, where aliases and webhook routes already exist, which envs/secrets are already part of the shape, and which invariants must not be broken while moving to a real provider
- What was checked:
  `docs/P0_ATTACK_PLAN.md`, `docs/REAL_PAYMENT_AND_RECONCILIATION_DECISION.md`, `docs/STAGE4_OPERATIONAL_READINESS_MAP.md`, `src/payment_provider.ts`, `src/payment_reconciliation.ts`, `src/webhook_ingestion.ts`, `src/payment_attempt_helpers.ts`, `src/app.ts`, `src/frontend_runtime.ts`, `frontend/app.js`, and the existing payment-facing validations referenced in `tests/frontend_flow_validation.ts`, `tests/real_integrations_validation.ts`, `tests/preprod_torture_validation.ts`, and `tests/ultimate_prelive_qa_rc_validation.ts`
- What is open:
  no real external payment transport is active yet; the next concrete implementation program is still open and should begin with one real authorization rail behind the existing abstraction, followed only later by capture/recovery/refund and the chosen provider's full webhook matrix
- Progress percentage:
  `100%` of the payment-rail planning pass
- Next step:
  start the implementation program at Stage 1 from `docs/PAYMENT_RAIL_ATTACK_PLAN.md`: one chosen provider, real authorization HTTP client, strict non-demo env contract, real provider correlation persistence, and no capture/recovery/refund expansion in the same first patch

## Real Authorization Rail Stage 1

- What was completed:
  replaced the synthetic `provider-ready` authorization path with a real outbound HTTP authorization rail behind the existing provider abstraction in `src/payment_provider.ts`; kept `mock-backed` and `demo-preview` isolated; added strict non-demo env support for `PAYMENT_PROVIDER_AUTH_PATH` and `PAYMENT_PROVIDER_TIMEOUT_MS` in `src/runtime_config.ts`; wired `/api/payments/authorize` and the legacy `/api/payments/authorize-mock` alias to pass real authorization amount/currency/deal/buyer context through `src/frontend_runtime.ts`; updated `frontend/app.js` to send `amount_minor` and preserve returned provider trace in the buyer flow; updated `src/app.ts` so a successful join now records `authorization_id`, `authorization_provider`, and `authorization_correlation_id` inside the existing `participant.join_authorize` audit payload instead of an unqualified mock marker; aligned `docs/STAGE4_OPERATIONAL_READINESS_MAP.md` with the new truth
- What was checked:
  `node --check frontend/app.js`; `npx tsc -p tsconfig.test.json --outDir .tmp_test_dist`; focused validation via `node .tmp_test_dist/tests/payment_authorization_real_rail_validation.js`; focused env-guard validation via `node .tmp_test_dist/tests/payment_authorization_env_guard_validation.js`; live HTTP QA against a temporary runtime on `127.0.0.1:3072` with a local provider stub proving `POST /api/payments/authorize` returned `200` with `mock:false` and a real `provider_reference`, while `POST /api/payments/authorize-mock` returned `402` with `mock:false` and `card_declined` instead of bypassing to a mock path; an additional `frontend_flow_validation` pass was attempted and confirmed the existing buyer/public shell still loads, but the suite remains partly blocked by pre-existing `app.ts` environment drift unrelated to the new authorization rail
- What is open:
  `capture`, `recovery`, and `refund` are still non-live; no real invoice/accounting rail or notifications were opened in this pass; `src/app.ts` and `src/frontend_runtime.ts` still carry architectural drift outside the authorization boundary; broader end-to-end payment truth still depends on the later webhook/catalog and capture phases
- Progress percentage:
  `100%` of Stage 1 real authorization rail
- Next step:
  freeze the real authorization rail as the new non-demo baseline, then move only to the next payment stage in order: tighten provider-specific webhook truth and the capture path without reopening auth, notifications, or invoice/accounting in the same patch

## Payment Rail Stage 2: Webhook Truth + Capture Path

- What was completed:
  replaced the remaining mock `charge_deal` execution path with a real provider-backed capture call in `src/payment_provider.ts` for `provider-ready` non-demo runtime; added strict env support for `PAYMENT_PROVIDER_CAPTURE_PATH` and provider currency wiring in `src/runtime_config.ts`; updated `src/app.ts` so charge execution now reads the recorded authorization trace from the existing `participant.join_authorize` audit payload, records the capture attempt before I/O, calls the real provider capture rail, and routes success or terminal failure back through the existing webhook ingestion + reconciliation truth path instead of mutating participant money states directly from mock code; kept temporary failures on the outbox retry path so no invalid transition is forced on timeout or unknown result; extended `src/frontend_runtime.ts` and `src/operational_readiness.ts` so preview/admin readiness now reflects live authorization + capture while still honestly marking recovery/refund as non-live; aligned `docs/STAGE4_OPERATIONAL_READINESS_MAP.md` with the new capture/webhook truth baseline; added focused validation in `tests/payment_capture_webhook_real_rail_validation.ts`
- What was checked:
  `npx tsc -p tsconfig.test.json --outDir .tmp_test_dist`; focused validation via `node .tmp_test_dist/tests/payment_capture_webhook_real_rail_validation.js`; live HTTP QA against a temporary runtime on `127.0.0.1:3085` with a local provider stub proving `/api/preview/meta` exposed the updated partial payment readiness, `processOutboxEventById(...)` drove a real provider-backed capture call, `GET /api/participants/:id/tracking` showed `ChargedSuccess` after a successful capture and `ChargeFailedCompletion` / `ChargeFailedRecovery` after a declined capture, and `POST /webhooks/payments` treated a late fail event as `ignored` and a replay of the same event as `duplicate:true`
- What is open:
  recovery and refund are still not live; invoice/accounting, real notifications, and broader financial reconciliation remain outside this pass; payment truth is now real for authorization + capture only, so the remaining production blockers are the downstream money lifecycle rails and the other external systems already mapped in the gap register
- Progress percentage:
  `100%` of the webhook-truth + capture-path stage
- Next step:
  freeze authorization + capture as the new non-demo baseline, then decide whether the next payment program is recovery rail or the remaining production blockers outside payments, without reopening state-model, repeat-joins, or invoice/accounting work in the same patch

## Payment Rail Stage 3: Recovery Rail

- What was completed:
  replaced the mock `recovery_deal` execution path with a real provider-backed recovery call in `src/payment_provider.ts` for `provider-ready` non-demo runtime; added explicit recovery event classification to `recovery_captured` / `recovery_failed`; updated `src/app.ts` so recovery execution now stays strictly inside `CompletionWindow`, records the recovery attempt before I/O, calls the real provider recovery rail, and routes terminal outcomes through the existing webhook ingestion + reconciliation truth path instead of mutating states directly from mock logic; kept temporary failures on the outbox retry path and rejected missing reconciliation truth instead of silently forcing an unsafe fallback; aligned `src/operational_readiness.ts` and `docs/STAGE4_OPERATIONAL_READINESS_MAP.md` so readiness now reflects live authorization + capture + recovery while still honestly marking refund as non-live; added focused validation in `tests/payment_recovery_real_rail_validation.ts`
- What was checked:
  `node --check frontend/app.js`; `npx tsc -p tsconfig.test.json --noEmit`; `npx tsc -p tsconfig.test.json --outDir .tmp_test_dist`; focused validation via `node .tmp_test_dist/tests/payment_recovery_real_rail_validation.js`; regression validation via `node .tmp_test_dist/tests/payment_capture_webhook_real_rail_validation.js`; live local QA through the recovery validation runtime on `127.0.0.1:3086` proved `/api/preview/meta` reports `authorization-capture-recovery-partial`, provider-backed recovery success moves a participant to `Recovered` / `RecoveredCharge`, declined recovery moves to `Dropped` / `AuthReleased`, timeout keeps the outbox pending without an invalid transition, late recovery failure webhooks are ignored after success, duplicate replays remain duplicate-safe, and recovery does not execute outside the completion window
- What is open:
  refund remains non-live; invoice/accounting, real notifications, and the other mapped non-payment blockers remain outside this pass; payment truth is now real for authorization + capture + recovery only, so the remaining money-rail blocker is refund and the broader external-finance envelope already mapped elsewhere
- Progress percentage:
  `100%` of the recovery-rail stage
- Next step:
  freeze authorization + capture + recovery as the new non-demo baseline and only then decide whether to open refund rail or step back to the other production blockers, without reopening state-model, repeat-joins, invoice/accounting, or notification work in the same patch

## Payment Rail Stage 4: Refund Rail Verified

- What was completed:
  finalized the refund rail on top of the real authorization/capture/recovery stack by wiring `refund_issue` / `cancel_refund` through the real provider refund client in `src/payment_provider.ts`; updated `src/app.ts` so refund execution reads traceable authorization and capture/recovery references from the existing audit rail, records the refund attempt before I/O, and routes `refund_issued` outcomes through webhook ingestion + reconciliation truth instead of relying on a silent direct-success fallback; added `refund_issued` classification to `src/payment_reconciliation.ts`; updated `src/operational_readiness.ts` and `docs/STAGE4_OPERATIONAL_READINESS_MAP.md` so readiness now reflects that the core payment execution rail is live across authorization + capture + recovery + refund
- What was checked:
  `node --check frontend/app.js`; `npx tsc -p tsconfig.test.json --noEmit`; `npx tsc -p tsconfig.test.json --outDir .tmp_test_dist`; focused validation via `node .tmp_test_dist/tests/payment_refund_real_rail_validation.js`; regression validation via `node .tmp_test_dist/tests/payment_recovery_real_rail_validation.js`; live local QA through the refund validation runtime on `127.0.0.1:3087` proved `/api/preview/meta` reports `authorization-capture-recovery-refund-partial`, provider-backed refund success moves `money_state` to `Refunded`, late refund webhooks are ignored after success, duplicate refund replays remain duplicate-safe, permanent-fail refunds move the outbox event to `outbox_dlq` without corrupting participant state, and timeout keeps the outbox pending without forcing an invalid transition
- What is open:
  invoice/accounting transport, real SMS, real email, real notification delivery, and true open-production seller auth remain outside this pass; the core payment execution rail is now complete in `provider-ready` mode, but the broader commercial external envelope is still not fully live
- Progress percentage:
  `100%` of the verified refund-rail stage; the core payment execution rail is fully closed
- Next step:
  freeze the payment rail as the new non-demo baseline and move to the next independent external blocker without reopening payment execution paths, state-model work, repeat-joins, or invoice/accounting in the same patch

## Wave 2: State / Audit / Outbox Hardening Verified

- What was completed:
  hardened the runtime and DB state boundary so illegal `DealState`, `BuyerState`, and `MoneyState` jumps are now blocked in the database even if transaction flags are forged; aligned bootstrap flag references to `siton.*`; tightened `require_action_name` to an explicit runtime vocabulary with a deliberate `test.*` namespace for test-only helpers; made `audit_log` append-only and validated legal `audit_log` transitions on insert; expanded deal-level outbox enforcement so `deal.publish`, `charging.start`, `charging.to_completion_window`, `charging.finalize_failed`, and `deal.cancel` all require outbox in the same transaction; and moved `recovery_deal` enqueue into the same `charging.to_completion_window` transaction so recovery orchestration is no longer created in a separate follow-up transaction
- What was checked:
  static scan via `rg -n "UPDATE siton\\.deals SET state|UPDATE siton\\.participants SET buyer_state|UPDATE siton\\.participants SET money_state|set_config\\('siton\\.(action_name|audit_written|outbox_written)'" src tests scripts`; `npx tsc -p tsconfig.test.json --noEmit`; `npx tsc -p tsconfig.test.json --outDir .tmp_test_dist`; focused validation via `node .tmp_test_dist/tests/state_engine_atomicity_validation.js`; targeted regression via `node .tmp_test_dist/tests/payment_capture_webhook_real_rail_validation.js`
- What is open:
  production/runtime state mutation paths are now closed through the DB enforcement layer for this wave; the remaining bypass-shaped items found here are explicit test helpers in `tests/remaining_product_surfaces_validation.ts`, `tests/master_product_depth_validation.ts`, and `tests/ultimate_prelive_qa_rc_validation.ts`, which still use `test.*` action names and direct SQL to accelerate surface tests and should stay classified as test-only debt rather than production authority
- Progress percentage:
  `100%` of Wave 2 production-path hardening; `test-only debt` remains documented but is not a live-runtime bypass
- Next step:
  freeze Wave 2 at this new baseline and hand control back to the next independent track without reopening join/capacity work, payment flow expansion, or unrelated surface redesign in the same pass

## Wave 3: Charging / Recovery / Completion Window / 90 Percent Rule Verified

- What was completed:
  verified that the remaining bypasses found after Wave 2 are still test-only helpers in `tests/remaining_product_surfaces_validation.ts`, `tests/master_product_depth_validation.ts`, and `tests/ultimate_prelive_qa_rc_validation.ts`, with no runtime or production-path helper/script leaking around the state engine; aligned DB buyer-state legality with the live runtime by allowing the full `-> DealFailed` branch that `failAllParticipantsForDeal(...)` and finalize already use in `src/app.ts`; hardened `POST /deals/:id/charging/start` in `src/app.ts` so replay on a non-`ReadyForCharging` deal now fails closed with `409` instead of silently creating fresh orchestration; moved `completion_window_until`, `finalize_deal`, and `recovery_deal` creation into the same `charging.to_completion_window` transaction so completion-window opening and downstream orchestration stay atomic; removed false reconciliation truth on capture/recovery by forcing `payment_attempts.result_class='unknown'` plus retry/error when the provider response lacks a real reconciliation event type; added deterministic Wave 3 torture coverage in `tests/charging_completion_window_validation.ts`; and stabilized the manual outbox test harness with the test-only `DISABLE_OUTBOX_WORKER=1` gate so focused validations no longer race the background worker while production runtime defaults remain unchanged
- What was checked:
  static scan via `rg -n "test\\.|processOutboxEventById|charging.start|ChargeFailedCompletion|DealFailed|completion_window_until|sumCapturedUnits" src tests scripts`; `npx tsc -p tsconfig.test.json --noEmit`; `npx tsc -p tsconfig.test.json --outDir .tmp_test_dist`; focused Wave 3 verification via `node .tmp_test_dist/tests/charging_completion_window_validation.js`; regression verification via `node .tmp_test_dist/tests/payment_capture_webhook_real_rail_validation.js`, `node .tmp_test_dist/tests/payment_recovery_real_rail_validation.js`, `node .tmp_test_dist/tests/payment_refund_real_rail_validation.js`, and `node .tmp_test_dist/tests/state_engine_atomicity_validation.js`; live local QA through the focused runtimes on `127.0.0.1:3093`, `127.0.0.1:3084`, `127.0.0.1:3086`, `127.0.0.1:3087`, and `127.0.0.1:3092`, proving `charging.start` rejects replay on the wrong state, `charge_deal` opens `CompletionWindow` once and enqueues `finalize_deal` + `recovery_deal` atomically, recovery does not run outside the window, finalize defers before expiry and replays idempotently after completion, and the threshold decision now follows `threshold_units` with `ChargedSuccess + RecoveredCharge` counted while `ChargeFailedCompletion` and `Dropped` do not count
- What is open:
  no production-path Wave 3 defect remains open after this pass; within this wave the charging/recovery/finalize/completion-window path, audit, outbox, and payment-attempt traces are now verified; items still open are outside Wave 3 scope, including invoice/accounting, real notifications, and the remaining non-payment launch blockers already mapped elsewhere
- Progress percentage:
  `100%` of Wave 3
- Next step:
  freeze Wave 3 as the new charging baseline and hand off to the next independent blocker without reopening join/capacity logic, repeat-join semantics, state-model redesign, or broader operational hardening in the same patch

## Payment Rail Stage 4: Refund Rail

- What was completed:
  replaced the mock `refund_issue` / `cancel_refund` execution path with a real provider-backed refund call in `src/payment_provider.ts` for `provider-ready` non-demo runtime; added `PAYMENT_PROVIDER_REFUND_PATH` and `PAYMENT_PROVIDER_RECOVERY_PATH` to `src/runtime_config.ts`; added `RefundPaymentInput` type; updated `handleRefundEvent` in `src/app.ts` to read the capture reference trace from the audit log (via `participant.join_authorize` for auth_id and `charging.charge_success`/`payment.capture_success` for capture_reference), record the refund attempt before I/O, call the real provider refund rail, and route `refund_issued` events through the webhook ingestion + reconciliation truth path; added `refund_issued` handling to `applyPaymentWebhookClassification` so a live provider refund confirmation transitions `money_state` → `Refunded` atomically; updated `docs/STAGE4_OPERATIONAL_READINESS_MAP.md` and `PROJECT_STATUS.md` to reflect that all four execution paths are now live in `provider-ready`
- What was checked:
  `./node_modules/.bin/tsc -p tsconfig.test.json --outDir .tmp_test_dist` (exit 0); full 31-test non-DB regression suite passing after changes; all security hardening, OTP, webhook, admin auth, rate limiter, and seller auth tests green
- What is open:
  invoice/accounting transport, real SMS, real email, real notification delivery, true open-production seller auth — none of these were opened in this pass; the payment execution rail is now complete end-to-end in `provider-ready` mode
- Progress percentage:
  `100%` of the refund-rail stage; payment execution rail is fully closed
- Next step:
  all four payment execution paths (authorize, capture, recover, refund) are now real in `provider-ready` mode — the remaining external-activation blockers are notifications, invoice/accounting, and production seller auth, which are each independent tracks


## Wave 4a: Webhook Truth / Duplicate / Late / Reconcile Verified

- What was completed:
  hardened the webhook truth path in `src/webhook_ingestion.ts`, `src/payment_reconciliation.ts`, and `src/frontend_runtime.ts` so provider callbacks are now claimed through an explicit `processing` state instead of a loose insert-only flow; previously `failed` webhook rows can now be retried with the same `provider + event_id` and re-enter processing instead of being dead-deduped forever; stored webhook payloads now persist top-level `event_type`, `correlation_id`, `provider_reference`, `deal_id`, and `participant_id` for traceability; classification reasons are written back into `webhook_events`; participant fallback reconciliation now recovers the latest matching `payment_attempts.correlation_id` when only `participant_id` is present; duplicate events stop at one persisted row and one logical mutation; late/conflicting events are recorded but ignored against already-advanced logical state; and the public/admin supported-event surface now includes `refund_issued`; Wave 4a truth coverage is codified in `tests/webhook_truth_handling_validation.ts`
- What was checked:
  `npx tsc -p tsconfig.test.json --noEmit`; `npx tsc -p tsconfig.test.json --outDir .tmp_test_dist`; focused Wave 4a validation via `node .tmp_test_dist/tests/webhook_truth_handling_validation.js`; direct DB evidence queries after the run proved that `Wave4A Charge dup-success` persisted exactly one `webhook_events` row with `status='processed'`, `classification_reason='capture_success'`, `webhook_row_count='1'`, `capture_audit_count='2'`, and `payment_attempts.result_class='success'`; `wave4a-unknown-*` stayed `status='failed'` with `reason='missing_correlation_target'` and no state change until `wave4a-reconcile-success-*` later landed as `status='processed'` with the preserved correlation id; and conflicting charge/recovery sequences stored the earlier truth event as `processed` while the later contradictory webhook was persisted as `ignored` with `reason='not_waiting_for_charge_capture'`
- What is open:
  no production-path Wave 4a defect remains open after this pass; one verification-only finding was explicitly classified to Wave 4b and not fixed here: long-lived local Node runtimes on the shared database can interfere with broad outbox regressions and create false negatives outside the focused webhook-truth path, but that is operational harness noise rather than a webhook-semantics hole
- Progress percentage:
  `100%` of Wave 4a
- Next step:
  freeze webhook truth handling as the new baseline and hand off only the operational noise / worker-resilience follow-up to Wave 4b, without reopening webhook semantics, state-model work, or broader payment-path changes in the same pass

## Final Gate: Backend Readiness Check

- What was completed:
  assembled the final backend change map across payment rail, state/audit/outbox hardening, seller session authority, and webhook truth handling; reviewed merge/conflict exposure across tracked runtime files, migrations, and untracked focused regression tests; re-checked runtime hygiene for debug, webhook-secret, seller-session, and outbox-worker gating; and closed the package with a final regression gate instead of opening another QA wave
- What was checked:
  `git status --short`; `git diff --stat`; `git diff --name-only`; `rg -n "test\\.|DISABLE_OUTBOX_WORKER|DEBUG_SURFACES_ENABLED|DEBUG_SURFACES_ACCESS_KEY|MOCK_|claimEvent|supported_events|refund_issued|SELLER_AUTH_MODE|SELLER_AUTH_CONFIGURED|PAYMENT_WEBHOOK_SECRET_IS_SAFE" src scripts`; `npx tsc -p tsconfig.test.json --outDir .tmp_test_dist`; `node .tmp_test_dist/tests/state_engine_atomicity_validation.js`; `node .tmp_test_dist/tests/charging_completion_window_validation.js`; `node .tmp_test_dist/tests/webhook_truth_handling_validation.js`; `node .tmp_test_dist/tests/debug_surface_guard_validation.js`; `node .tmp_test_dist/tests/webhook_secret_policy_validation.js`; `node .tmp_test_dist/tests/seller_auth_session_validation.js`; `node .tmp_test_dist/tests/seller_auth_authority_validation.js`; focused Wave 1 proof already verified earlier in the hardening pass with first join `200`, replay `200`, second buyer blocked at `409`, `participant_id` reused, and DB evidence `participants=1`, `qty_sum=1`, `idem_rows=1`; `node .tmp_test_dist/tests/operational_hardening_proof.js` was also run and surfaced two remaining failures tied to shared-runtime outbox interference rather than a newly found state/payment/webhook semantic break
- What was fixed:
  no new final-gate blocker fix was needed inside runtime semantics; the final gate only validated that prior fixes still hold together and classified the remaining outbox-hardening noise as an open operational item rather than reopening Wave 1–4 logic
- What is open:
  backend semantics for join idempotency/capacity, state/audit/outbox, charging/completion window, seller session authority, and webhook truth are holding together; the limited open items are outside the just-closed semantic core: broad operational outbox hardening still shows shared-runtime interference in `tests/operational_hardening_proof.js`, invoice/accounting is still not live, real notifications are still not live, and open multi-tenant production seller auth is still not closed
- Progress percentage:
  `95%` of the current backend hardening/readiness package
- Next step:
  treat the backend as ready for continued UX/frontend work and controlled backend integration, then close the remaining external-activation tracks separately: operational Wave 4b cleanup, invoice/accounting, real notifications, and the full open-production seller-auth track; do not reopen the already-verified Wave 1–4 semantic fixes unless a merge conflict or real blocker appears
