# SITON Architecture Rebase — Stage R0

**Audit date:** 2026-08-27

**Audited baseline:** `master == origin/master == d56326fb387bc1c5d83c33e7727483c2081a1d79` at audit start, divergence `0/0`, clean tree, no stash and one worktree

**Current canonical production:** Base44 + Supabase inventory authority

**Candidate:** Render V2 + Supabase

**Status:** audit only; no cutover, deploy, hosted write, provider call or infrastructure creation is authorized

**Decision:** `RECOMMEND_MIGRATE_TO_RENDER_SUPABASE`

## 0. Executive decision and non-negotiable constitution

Siton should leave Base44 through a gated migration, not through restoration of the legacy Render demo. The repository already owns the difficult parts: the state constitution, 45 portable SQL migrations, a Fastify runtime, a continuously running fenced worker, provider abstractions, a mobile shell and 142 executable regression files. The important rewrite is identity; the important adaptations are the React API boundary, storage endpoint and environment/deployment wiring. Base44 remains the only authority until an explicit cutover gate passes.

The target must preserve exactly:

- `DealState`: `Draft`, `PendingTarget`, `TargetReached`, `ClosedForJoining`, `ReadyForCharging`, `Charging`, `CompletionWindow`, `Completed`, `Failed`, `Cancelled`.
- `BuyerState`: `NotJoined`, `JoinedAuthorized`, `LockedIn`, `ChargingAttempt`, `ChargedSuccess`, `ChargeFailedCompletion`, `Recovered`, `Dropped`, `DealCompleted`, `DealFailed`.
- `MoneyState`: `NoFinancial`, `AuthHeld`, `AuthLocked`, `ChargeAttempt`, `ChargedSuccess`, `ChargeFailedRecovery`, `RecoveredCharge`, `AuthReleased`, `Refunded`.
- Financial completion is only `ChargedSuccess` or `RecoveredCharge`.
- Siton fee is exactly 8% of everything collected from the customer, including delivery/shipping and excluding VAT. Distributor commission is exactly 0%.
- No direct state mutation; final money is asynchronous; provider calls are server-side; idempotency is mandatory; `UNKNOWN` enters reconciliation and never manufactures success.
- At most three retries per participant/deal/30 minutes; completion window 24 hours; deadline at most seven days; mandatory `max_units`; threshold by units and exactly 90%.
- State and audit evidence commit atomically; no manual state override; late webhooks cannot mutate terminal truth; repeat purchases by one buyer are allowed while inventory exists; inventory is concurrency-safe.
- Draft is private; `TargetReached != Completed`; Mall owns only derived discovery; Mall and direct links open the same Deal truth; default Mall order is `published_at DESC, deal_id` deterministic tie-break; supported deal types are `physical_product`, `voucher`, `ticket`.

## A. Repository and live inventory

Counts use tracked files unless stated otherwise. `rg --files` returned 660 non-ignored files; Git tracks 669.

| Artifact | Verified count | Disposition | Evidence/meaning |
|---|---:|---|---|
| `src/` files | 96 | `REUSE_WITH_ADAPTATION` | Fastify/domain/runtime plus SQL and two historical TS migration helpers |
| Portable SQL migrations | 45 | `REUSE_WITH_ADAPTATION` | `007`–`049`; isolated Gate 1C proof was 45/45 |
| Executable top-level test files | 142 | mixed; see P | Plus one support helper, hence 143 tracked `tests/*.ts` paths |
| Repository scripts | 42 | `REUSE_WITH_ADAPTATION` | Build, migration, gates, mobile and operations |
| Local Base44 function resources | 6 | `DELETE_AFTER_CUTOVER` or `REFERENCE_ONLY` | Adapter/runtime artifacts; no target business authority |
| Local Base44 entity schemas | 4 | `MIGRATE_DATA` then `DELETE_AFTER_CUTOVER` | V1.1 projection/identity/image/event resources |
| Remote deployed Base44 functions | 69 | mixed; see B/D | Read-only `base44 functions list`; five V1.1 functions called by UI are not deployed |
| Remote Base44 schemas | 61 | mixed; see C/D/Q | Includes 25 documented uppercase/kebab pairs |
| Remote React page files | 31 | mixed; see G | Read-only sandbox inventory |
| Remote route declarations | 37 | `REUSE_WITH_ADAPTATION` | Includes aliases and catch-alls, not 37 distinct screens |
| Remote `functions.invoke` call sites | 47 | `REUSE_WITH_API_ADAPTER` | No direct `base44.entities` call was found in `src/` |
| Local hosted shell patterns | 24 product/legal route patterns | `REFERENCE_ONLY` | Existing vanilla frontend is also a Render-native product proof surface |
| Provider/storage adapter modules | 7 | `REUSE_WITH_ADAPTATION` | payment, Grow, synthetic payment, payout, invoice, notification, storage |
| Worker-related modules | 10 | `REUSE_WITH_ADAPTATION` | worker/scheduler/outbox/reconciliation/notification/invoice/payout modules |
| Mobile artifacts | 112 | `REUSE_WITH_ADAPTATION` | Android, iOS, Capacitor config and secure-storage plugin |
| CI workflows | 3 | `REUSE_WITH_ADAPTATION` | backend gates, Stripe sandbox proof, web-runtime depth |
| `legacy/render/` files | 12 | `KEEP_QUARANTINED` | Historical topology only; never promote as-is |

Other inspected boundaries: root `Dockerfile`, `package.json` (Node `>=22`), `base44/runtime-manifest.json`, canonical registry, `frontend/`, `src/app.ts`, `src/frontend_runtime.ts`, auth/session modules, object storage, Grow/payment/webhooks, invoice, notification, payout, operational repair, Android/iOS and the three workflows.

The Base44 sandbox itself is React 18/Vite 6 and currently imports `@base44/sdk`. Its 31 page files are real reusable product UI, while the local `frontend/` is a second proven vanilla product surface. R1 must select the React application as the target UI and use the local frontend as behavioral/reference evidence; running both as independent products would create drift.

## B. Backend domain map

Target endpoints are the public contract proposed for Render. Existing routes without the `/api` prefix remain implementation evidence and should receive explicit `/api` aliases during R3; compatibility must not create a second business implementation.

### Seller

| Base44 function | Existing repository equivalent | Target Render contract | Class |
|---|---|---|---|
| `siton-seller-bootstrap` | `src/frontend_runtime.ts` seller context/session; `src/seller_auth.ts` | `GET /api/seller/context` | `REUSE_WITH_ADAPTATION` |
| `create-deal-draft` | `src/app.ts` `POST /deals` | `POST /api/seller/deals` | `REUSE_WITH_ADAPTATION` |
| `update-deal-draft` | `PATCH /api/seller/deals/:dealId/draft` | same | `REUSE_AS_IS` contract |
| `seller-deals` | `GET /api/seller/deals` | same | `REUSE_AS_IS` contract |
| `seller-deal-detail` | `GET /api/seller/deals/:id` | same | `REUSE_AS_IS` contract |
| `publish-deal` | `POST /deals/:id/publish` | `POST /api/seller/deals/:id/publish` | `REUSE_WITH_ADAPTATION` |
| `close-joining` | `POST /deals/:id/close_joining` | `POST /api/seller/deals/:id/close-joining` | `REUSE_WITH_ADAPTATION` |
| `cancel-deal` | `POST /deals/:id/cancel` | `POST /api/seller/deals/:id/cancel` | `REUSE_WITH_ADAPTATION` |
| `siton-seller-deal-image` | `src/product_image_storage.ts`; image POST/order/DELETE routes | `/api/seller/deals/:id/images[/order|/:imageId]` | `REUSE_WITH_ADAPTATION` |
| `seller-fulfillment` | delivery handoff/export and `POST /api/seller/fulfillment/:unitId/redeem` | same resource routes | `REUSE_WITH_ADAPTATION` |
| `seller-digital-fulfillment` | voucher/ticket exports and fulfillment redemption | `/api/seller/deals/:id/{voucher,ticket}-export` | `REUSE_WITH_ADAPTATION` |
| `seller-receipts` | invoice rows included in seller deal detail | `GET /api/seller/deals/:id/receipts` | `REUSE_WITH_ADAPTATION` |
| `seller-payouts` | `src/payout_rail.ts`; deal detail/admin payout readiness | `GET /api/seller/payouts` | `REUSE_WITH_ADAPTATION` |
| `seller-analytics` | `src/seller_analytics.ts`; existing GET | `GET /api/seller/analytics` | `REUSE_AS_IS` contract |
| `get-seller-profile` | existing GET | `GET /api/seller/profile` | `REUSE_AS_IS` contract |
| `update-seller-profile` | existing PUT | `PUT /api/seller/profile` | `REUSE_AS_IS` contract |

All seller mutation authorization must derive seller identity from a verified session/JWT. A browser `seller_id` is input at most, never authority.

### Buyer/public/Mall

| Base44 function | Existing repository equivalent | Target Render contract | Class |
|---|---|---|---|
| `list-mall-deals` | `src/mall_read_model.ts`; existing GET | `GET /api/mall/deals` | `REUSE_AS_IS` contract |
| `record-mall-event` | `POST /api/mall/events`; `discovery_events` | same | `REUSE_AS_IS` contract |
| `project-mall-deal` | SQL read model already derives projection | no endpoint; internal query | `DELETE_AFTER_CUTOVER` |
| `get-public-deal` | existing public Deal route | `GET /api/deals/:id/public` | `REUSE_AS_IS` contract |
| `deal-comments` | existing chat GET/POST | `/api/deals/:id/chat` | `REUSE_AS_IS` contract |
| `request-otp` | `src/otp_rail.ts`; OTP request/start | `POST /api/otp/request` | `REUSE_WITH_ADAPTATION` |
| `verify-otp` | OTP verify + proof/session | `POST /api/otp/verify` | `REUSE_WITH_ADAPTATION` |
| `join-deal` | `POST /deals/:id/join`; inventory/idempotency transaction | `POST /api/deals/:id/join` | `REUSE_WITH_ADAPTATION` |
| `get-buyer-tracking` | existing tracking handler | `GET /api/participants/:id/tracking` | `REUSE_WITH_ADAPTATION` |
| `track-distribution-event` | affiliate visit route and attribution modules | `POST /api/affiliate/links/visit` | `REUSE_WITH_ADAPTATION` |

### Lifecycle, money and worker

| Base44 function/group | Existing repository equivalent | Target | Class |
|---|---|---|---|
| `prepare-charging` | `src/app.ts` prepare route and state guards | worker command/event `prepare_charging` | `REUSE_AS_IS` domain |
| `start-charging` | start route, payment attempts and outbox | worker-only event, no browser contract | `REUSE_AS_IS` domain |
| `apply-charge-results` | `processOutboxEvent`, payment/webhook classification | worker transaction | `REUSE_AS_IS` domain |
| `apply-recovery-results` | `src/payment_reconciliation.ts` | worker transaction | `REUSE_AS_IS` domain |
| `apply-refund-results` | provider/refund outbox handling | worker transaction | `REUSE_AS_IS` domain |
| `finalize-deal` | completion-window/finalization code in `src/app.ts` | worker transaction | `REUSE_AS_IS` domain |
| `payment-attempt-guard` | `src/payment_attempt_helpers.ts` + DB constraints | internal guard | `REUSE_AS_IS` |
| `reconcile-payment-jobs` | `src/payment_reconciliation.ts` | worker reconcile lane | `REUSE_AS_IS` |
| all three `reconcile-join-intent(s)` generations | join idempotency + inventory transaction | internal recovery command | `REUSE_WITH_ADAPTATION`; old names delete |
| `reconcile-outbox-projections` | outbox processing/read-model convergence | worker default lane | `REUSE_WITH_ADAPTATION` |
| `worker-claim-outbox` | `claimPendingOutboxBatch` | internal DB lease call | `REUSE_AS_IS` |
| `worker-finish-outbox` | fenced completion helpers | internal DB call | `REUSE_AS_IS` |
| `worker-heartbeat-outbox` | `worker_heartbeats`, interval heartbeat | internal DB call | `REUSE_AS_IS` |
| `deliver-notifications`, `communication-delivery` | notification service/dispatch/templates | worker lane + external adapter | `REUSE_WITH_ADAPTATION` |
| `siton-worker-tick` | replaces a continuous process with recurring invocation | `npm run start:worker:prod` | `DELETE_AFTER_CUTOVER` |
| transition-engine generations | `DEAL_TRANSITIONS`, `BUYER_TRANSITIONS`, `MONEY_TRANSITIONS`, `assertValidTransition` | internal domain library | canonical semantics `REUSE_AS_IS`; wrappers delete |

No money lifecycle endpoint is exposed as a direct admin/browser state setter. Web requests enqueue intent; the worker and verified webhooks finalize truth.

### Admin/operations

| Base44 function | Existing repository surface | Target | Class |
|---|---|---|---|
| `admin-overview` | `/api/admin/overview` | same | `REUSE_AS_IS` |
| `admin-sellers`, `admin-review-seller` | sellers risk/status/KYC routes | `/api/admin/sellers*` | `REUSE_WITH_ADAPTATION` |
| `admin-deals` | deal profile/ops/trace routes | `/api/admin/deals*` | `REUSE_WITH_ADAPTATION` |
| `admin-support-cases` | support case CRUD/escalate | `/api/admin/support-cases*` | `REUSE_AS_IS` |
| `admin-distribution` | affiliate overview/links and reports | `/api/admin/distribution*` | `REUSE_WITH_ADAPTATION` |
| `admin-forensics` | mission-control traces/anomalies | `/api/admin/mission-control*` | `REUSE_WITH_ADAPTATION` |
| `admin-notifications` | notification status/read surfaces | `/api/admin/notifications*` | `REUSE_WITH_ADAPTATION` |
| `admin-control-flags` | control flag/action routes | `/api/admin/control-flags*` | `REUSE_AS_IS` |
| `admin-omnisearch` | admin search/profile handlers | `/api/admin/search`, `/api/admin/users*` | `REUSE_WITH_ADAPTATION` |
| `admin-system-status` | health/mission control/system status | `/health`, `/readiness`, `/api/admin/system-status` | `REUSE_WITH_ADAPTATION` |
| `admin-payouts` | payout status/batch/readiness handlers | `/api/admin/payouts*` | `REUSE_WITH_ADAPTATION` |

### Inventory/admin/proof and residual functions

- `siton-inventory-bridge`: `REWRITE_BOUNDARY` from HTTPS/SDK bridge to a transaction-scoped Postgres inventory repository. Preserve the RPC contract until parity is proven.
- `inventory-bridge`: `DELETE_AFTER_CUTOVER`; legacy duplicate.
- `postgres-connectivity-probe`: `REFERENCE_ONLY`; replace by private readiness checks, never an operator mutation.
- `supabase-schema-admin`, `supabase-inventory-rpc-admin`: `DELETE_AFTER_CUTOVER`; schema changes must come only from versioned migrations, not UI buttons.
- `supabase-inventory-live-proof`, `base44-inventory-lifecycle-proof`: `REFERENCE_ONLY`; convert into staging tests.
- `siton-core-readiness`: `REUSE_WITH_ADAPTATION` into `/readiness`.
- `stripe-capability-probe`: `REFERENCE_ONLY`; Grow is the target and provider probes remain test/staging only.
- `canonical-integrity-gate`: `REFERENCE_ONLY`; replace Base44 registry assertions with Render/Supabase architecture gates.
- `siton-base44-lifecycle-proof`, `siton-base44-lifecycle-proof-v3`, `siton-lifecycle-proof-v4`: `REFERENCE_ONLY` until equivalent hosted E2E exists, then `DELETE_AFTER_CUTOVER`.

## C. Database map

The 45 portable migrations create/evolve 62 `siton` tables. This is sufficiently complete to become canonical business truth, subject to R2 fresh-project replay, Supabase/Postgres compatibility review, privilege/RLS hardening, Auth foreign-key additions, inventory integration and data import validation. It is not safe to point current production at it before those gates.

| Base44 entity | PostgreSQL target | Shape | Target authority/disposition | Live Base44 data |
|---|---|---|---|---|
| `Deal` | `siton.deals` + type/delivery term tables | exact/core | table; `MIGRATE_DATA`; Postgres authority | `UNKNOWN_REQUIRES_PROOF` |
| `Participant` | `siton.participants` | exact/core | table; `MIGRATE_DATA` | unknown |
| `SellerAccount` | `siton.seller_accounts` | exact/core | table; migrate; bind `auth.users.id` | one row at 2026-08-26 checkpoint; current unknown |
| `SellerIdentity` | `auth.users` + seller identity binding column/table | partial | `REWRITE_BOUNDARY` + migrate mapping | unknown |
| `DealImage` | `siton.deal_images` + Storage object | exact metadata | table + object migration | unknown |
| `DealAudit` | `siton.audit_log` | equivalent | append-only table; migrate | unknown |
| `IdempotencyRecord` | `siton.idempotency_log`, `join_idempotency_results` | equivalent/specialized | tables; migrate unexpired/relevant evidence | unknown |
| `OutboxEvent` | `siton.outbox_events` | exact | table; migrate pending/processing with freeze reconciliation | unknown |
| `OutboxDeadLetter` | `siton.outbox_dlq` | exact | table; migrate all unresolved evidence | unknown |
| `PaymentAttempt` | `siton.payment_attempts` | exact | table; migrate all financial evidence | unknown |
| `PaymentReconcileJob` | outbox + payment attempts + reconciliation case tables | partial/normalized | eliminate entity after transformed import | unknown |
| `MoneyLedgerEvent` | `platform_fee_money_events`, payment attempts, audits | partial/normalized | tables; migration reconciliation required | unknown |
| `NotificationEvent` | `siton.notification_events` | exact | table; migrate | unknown |
| `NotificationAttempt` | `siton.notification_attempts` | exact | table; migrate | unknown |
| `OtpChallenge` | `siton.otp_challenges`, `otp_proofs` | exact-plus | table; normally do not migrate expired challenges | unknown |
| `OtpDeliveryAttempt` | `siton.otp_delivery_attempts` | exact | table; retain audit according to policy | unknown |
| `SellerSettlement` | `siton.seller_settlements` | exact | table; migrate/reconcile | unknown |
| `SellerPayoutBatch` | payout batches/items/attempts/cases | exact-plus | tables; migrate/reconcile | unknown |
| `InvoiceDocument` | invoice documents/attempts/cases | exact-plus | tables; migrate metadata, not secrets | unknown |
| `DeliveryRecord` | participant delivery snapshot + `deal_delivery_options` | partial/normalized | tables; transformation required | unknown |
| `FulfillmentUnit` | `siton.fulfillment_units` | exact | table; migrate encrypted/hashed references safely | unknown |
| `DistributionSource` | affiliate accounts/links | partial/normalized | tables; migrate | unknown |
| `DistributionEvent` | `affiliate_link_events` | equivalent | table; migrate non-PII evidence | unknown |
| `DistributionAttribution` | `affiliate_attributions` | exact | table; migrate | unknown |
| `DistributorDealAccess` | affiliate links/ownership constraints | partial | eliminate after normalized import | unknown |
| `OperationalCase` | `siton.operational_cases` | exact | table; migrate | unknown |
| `OperationalCaseEvent` | `siton.operational_case_events` | exact | table; migrate | unknown |
| `AdminControlFlag` | `siton.admin_control_flags` | exact | table; migrate open flags | unknown |
| `AdminControlAudit` | control flag events + admin actions + audit log | normalized | transform and migrate | unknown |
| `DealComment` | `siton.deal_chat_messages` | equivalent | table; migrate | unknown |
| `DiscoveryEvent` | `siton.discovery_events` | exact | table; aggregate/non-PII migration optional by retention policy | unknown |
| `MallDealProjection` | `src/mall_read_model.ts` over canonical tables | duplicate derived truth | eliminate; normal bounded SQL query, no table/view initially | unknown |
| `User` | `auth.users` plus role-specific `siton` bindings | identity boundary | `REWRITE_BOUNDARY`; migrate account link/contact verification, never credentials | unknown |
| `ConcurrencyLockProbe` | staging concurrency tests only | no production entity needed | `REFERENCE_ONLY`, then `DELETE_AFTER_CUTOVER`; export only if audit retention requires | unknown |
| `Task` | no Siton domain equivalent; Base44 scaffold residue | no target table | `DELETE_AFTER_CUTOVER` after consumer/count proof | unknown |
| `_noop` | platform/system residue | no target table | `REFERENCE_ONLY`, then `DELETE_AFTER_CUTOVER` | unknown |

`MallDealProjection` should not be a table, materialized view or ordinary view at cutover. The repository already has one bounded indexed query, deterministic pagination and a 20,000-deal scale proof. A normal query avoids refresh lag and duplicated state. Reconsider a `security_invoker` view only for API ergonomics, or a materialized view only after production measurements show a problem and refresh/freshness semantics are formally gated.

Supporting tables not represented cleanly in Base44—webhook security/events, legal acceptances, sessions, MFA, storage cleanup/orphan reports, infrastructure-change audit, worker heartbeats and operational recovery audit—are valuable target-native assets and are `REUSE_WITH_ADAPTATION`.

## D. Base44 duplication cleanup map

The canonical side is PascalCase; the lowercase/kebab side is legacy. Counts for each member are `UNKNOWN_REQUIRES_PROOF`; no pair may be deleted until exports are reconciled by stable business key, timestamps and content hash.

| Canonical | Legacy | After validated cutover |
|---|---|---|
| `InvoiceDocument` | `invoice-document` | canonical data migrates; legacy `DELETE_AFTER_CUTOVER` |
| `DeliveryRecord` | `delivery-record` | same |
| `DistributionSource` | `distribution-source` | same |
| `Participant` | `participant` | same |
| `FulfillmentUnit` | `fulfillment-unit` | same |
| `SellerSettlement` | `seller-settlement` | same |
| `DistributorDealAccess` | `distributor-deal-access` | same |
| `Deal` | `deal` | same |
| `OtpChallenge` | `otp-challenge` | same |
| `NotificationEvent` | `notification-event` | same |
| `PaymentReconcileJob` | `payment-reconcile-job` | same |
| `OperationalCase` | `operational-case` | same |
| `MoneyLedgerEvent` | `money-ledger-event` | same |
| `AdminControlAudit` | `admin-control-audit` | same |
| `NotificationAttempt` | `notification-attempt` | same |
| `OperationalCaseEvent` | `operational-case-event` | same |
| `SellerAccount` | `seller-account` | same |
| `DealAudit` | `deal-audit` | same |
| `DistributionAttribution` | `distribution-attribution` | same |
| `IdempotencyRecord` | `idempotency-record` | same |
| `AdminControlFlag` | `admin-control-flag` | same |
| `SellerPayoutBatch` | `seller-payout-batch` | same |
| `DealComment` | `deal-comment` | same |
| `OtpDeliveryAttempt` | `otp-delivery-attempt` | same |
| `DistributionEvent` | `distribution-event` | same |

Function generations:

- Transition: canonical `siton-transition-engine-v3`; legacy `transition-engine`, `siton-transition-engine`, `siton-transition-engine-v2`.
- Inventory: canonical `siton-inventory-bridge`; legacy `inventory-bridge`.
- Join reconciliation: canonical `siton-reconcile-join-intents-v2`; legacy `reconcile-join-intent`, `reconcile-join-intents`.
- Images: target source calls canonical `siton-seller-deal-image`; deployed legacy `seller-deal-images` remains a cutover-delete candidate. The canonical V1.1 function is currently missing from deployed inventory.
- Lifecycle/proof generations are evidence only: `base44-inventory-lifecycle-proof`, `siton-base44-lifecycle-proof`, `siton-base44-lifecycle-proof-v3`, `siton-lifecycle-proof-v4`.

Every legacy resource stays untouched now. Safe deletion requires: complete dual-name count/hash export, consumer grep and access-log evidence, imported-row reconciliation, cutover stabilization, financial retention decision and a backup that can be independently restored.

## E. Inventory

Current proof infrastructure is project `nqgbqbqextiryqqpggju` (`siton-stage31`). Its five protected tables are:

- `siton_inventory.inventory_deals`
- `siton_inventory.inventory_reservations`
- `siton_inventory.inventory_action_idempotency`
- `siton_inventory.deal_state_audit`
- `siton_inventory.participant_state_audit`

Gate 1C proved RLS enabled, browser roles denied, both audit-mutation rejection triggers, stable RPC definition, idempotency, reserve/commit/release/status, a 20-way last-unit race with one winner, and close guards. The repository only contains the search-path hardening delta, not the complete provisioning SQL; therefore the full schema/RPC/trigger source must be extracted without data and committed as reviewed R1 migration input. That absence is `UNKNOWN_REQUIRES_PROOF`, not permission to recreate semantics from memory.

Target design:

- Keep `siton_inventory` as a dedicated schema and module boundary.
- Put it in the same Supabase Postgres project as `siton`. This allows Deal/Participant, reservation/idempotency and audit changes to share one serializable/locked database transaction where the lifecycle requires atomicity.
- Replace Base44 HTTPS bridge calls with a transaction-scoped internal repository/RPC call. Preserve the current request/result/idempotency contract during R2/R3 so tests can compare both paths.
- Do not grant `anon`/`authenticated` direct schema access. Render uses a least-privileged runtime DB role; only narrowly reviewed functions receive execute privileges.
- Preserve RPCs, constraints, locks, append-only triggers, fixed `search_path`, state audit and race proofs. IDs may remain UUIDs; every Base44 ID mapping must be explicit in an import crosswalk.

Disposition: schema/RPC/trigger logic `REUSE_WITH_ADAPTATION`; current project/data `KEEP_QUARANTINED` as proof evidence. `siton-stage31` must remain proof-only until fresh staging reproduces all seven proofs and export validation; retire it later, never promote it by name alone.

## F. Worker on Render

`src/worker.ts` is already a persistent process. It polls Postgres, writes a heartbeat, claims fenced leases, schedules `money`, `reconcile`, `invoice` and `default` lanes, periodically reclaims stale work, records lease loss, retries startup with bounds, drains on `SIGTERM`/`SIGINT` and closes the DB after a shutdown timeout. `outbox_dlq`, lease generation and operational recovery are persisted.

Answers:

1. The worker can run essentially unchanged: `REUSE_WITH_ADAPTATION` for connection/auth/observability configuration, not business semantics.
2. Keep `DATABASE_URL`, `DB_SCHEMA=siton`, polling/concurrency/lease/heartbeat/shutdown/outbox/provider settings. Remove Base44 SDK/app/service-role settings. Add deployment SHA, environment, Supabase project/JWKS/storage configuration and a worker-disable kill switch backed by an audited control flag.
3. Base44 recurring automation, service-role invocation wrappers and claim/finish/heartbeat HTTP functions disappear.
4. `siton-worker-tick` becomes `DELETE_AFTER_CUTOVER`.
5. A continuously running Render Background Worker is preferable: the queue is continuously available and money/reconciliation latency is not coupled to cron cadence.
6. Cron is optional only for bounded housekeeping such as daily retention/orphan reports or reconciliation sweeps. Core outbox/money/recovery must remain continuous. Every cron command must be idempotent and exit.
7. On deploy/restart the old worker receives termination, stops claiming, drains bounded in-flight work, and uncompleted leases expire/reclaim. A new generation must never finish work under an old fence.
8. Zero-duplicate-money proof requires concurrent two-worker claims, kill-after-provider-call/before-DB-commit, restart/reclaim, late webhook, provider `UNKNOWN`, idempotency replay, lease-loss before finish, DLQ and three-retry-window tests using a provider idempotency key that survives process death.

Exact commands, already verified in `package.json`:

```text
Web:    npm run start:web:prod
Worker: npm run start:worker:prod
Build:  npm ci && npm run build:demo
Migrate (pre-deploy, once): npm run db:migrate
```

Render documents Background Workers as continuously running non-network services and documents zero-downtime replacement plus the need to finish or make in-progress work retryable. Those semantics fit the existing Postgres outbox and lease model: <https://render.com/docs/background-workers>, <https://render.com/docs/deploys>.

## G. Frontend and compatibility adapter

### Page classification

| Class | Pages |
|---|---|
| `REUSE_WITH_API_ADAPTER` | `Home`, `PublicDeal`, `BuyerTracking`, `DistributorPortal`, `SellerDashboard`, `SellerNew`, `SellerDealDetail`, `SellerDealEdit`, `SellerFulfillment`, `SellerReceipts`, `SellerDigitalFulfillment`, `SellerAnalytics`, `SellerPayouts`, `SellerDealImages`, `SellerProfile`, `AdminOverview`, `AdminSellers`, `AdminSupport`, `AdminDistribution`, `AdminForensics`, `AdminNotifications`, `AdminControls`, `AdminDeals`, `AdminSearch`, `AdminSystemStatus`, `AdminPayouts` (26) |
| `REQUIRES_AUTH_REWRITE` / `REWRITE_BOUNDARY` | `Login`, `Register`, `ForgotPassword`, `ResetPassword` (4), plus `AuthContext`, `ProtectedRoute`, `SellerBootstrapGate` |
| `BASE44_ONLY_DELETE` / `DELETE_AFTER_CUTOVER` | `OAuthConsent` and Base44 MCP consent wiring (1) |

The 37 route declarations include `/` and `/app`, seller alias pairs and catch-alls. Preserve public/deep-link compatibility with redirects; choose `/app/...` as the canonical web family.

Dependency inventory:

- 47 `base44.functions.invoke` call sites across 25 page/component files.
- Central `src/api/base44Client.js`, `src/lib/app-params.js`, `AuthContext`, `SellerBootstrapGate`.
- Base44 auth calls: `me`, email/password login, Google login, register, verify/resend OTP, token set, password reset/request, logout and login redirect.
- Base44 public app-settings URL and `X-App-Id`; functions version/app token/app base URL params.
- Base44-only MCP consent routes in `OAuthConsent`.
- Zero direct entity SDK calls were found. This sharply limits the adapter boundary.

Create a temporary `api.functions.invoke(name, payload)` compatibility adapter. It translates names to REST, normalizes `{data}` and throws a stable product error envelope. It must contain no business logic and must be removed after pages use typed REST clients.

| Invoke name | REST translation |
|---|---|
| `list-mall-deals` | `GET /api/mall/deals` with query |
| `record-mall-event` | `POST /api/mall/events` |
| `get-public-deal` | `GET /api/deals/:deal_id/public` |
| `deal-comments` | GET/POST `/api/deals/:deal_id/chat` by operation |
| `request-otp`, `verify-otp` | POST `/api/otp/request`, `/api/otp/verify` |
| `get-buyer-tracking` | `GET /api/participants/:participant_id/tracking` |
| `siton-seller-bootstrap` | `GET /api/seller/context` |
| `create-deal-draft` | `POST /api/seller/deals` |
| `update-deal-draft` | `PATCH /api/seller/deals/:deal_id/draft` |
| `seller-deals`, `seller-deal-detail` | GET `/api/seller/deals[/:deal_id]` |
| `publish-deal`, `close-joining`, `cancel-deal` | POST `/api/seller/deals/:deal_id/{publish,close-joining,cancel}` |
| `siton-seller-deal-image` | method chosen by operation under `/api/seller/deals/:deal_id/images` |
| seller profile/analytics/payouts | GET/PUT matching `/api/seller/*` resources |
| seller fulfillment/digital/receipts | matching resource GET/export/redeem endpoints |
| `distributor-portal` | `/api/distributor/*` resource endpoints |
| admin functions | matching `/api/admin/*` resource endpoints from B |
| proof/schema/probe functions | no production adapter; staging/operator test replacement only |

## H. Supabase Auth boundary

Supabase Auth becomes authentication authority; `siton` remains authorization/business authority. Render validates issuer, audience, expiry and signature using the project's JWKS (or the official Auth verification path while a legacy symmetric key remains), then loads fresh server-side role/tenant/account bindings for mutations. Supabase documents the JWKS endpoint and warns about cache/rotation behavior: <https://supabase.com/docs/guides/auth/jwts>.

- **Seller:** Supabase Auth user -> immutable `auth_user_id` binding -> `siton.seller_accounts`. Seller status/enforcement comes from DB on every sensitive request. Bootstrap may create a pending account only through an idempotent server transaction; browser seller IDs never authorize.
- **Admin:** Supabase Auth user -> `admin_users`/role/MFA. Require server-side RBAC, AAL2 for privileged actions, recent DB state and existing dual-approval/audit controls. Do not authorize from user-editable metadata.
- **Buyer:** keep guest purchase/tracking. OTP proves a contact/action and yields hashed, scoped HttpOnly buyer/tracking sessions with expiry; optional Supabase Auth may later link purchases but is not required. Recovery uses OTP plus participant/deal-bound resume/tracking tokens, never URL secrets.
- **Distributor:** Supabase Auth user -> `affiliate_accounts`/distributor binding and server-resolved tenant. Existing distributor sessions become a transition compatibility mechanism, then retire.
- **Frontend:** uses Supabase Auth only for login/session refresh. It sends Bearer access token or secure cookie to Render; it never receives a service key.
- **Render:** verifies JWT/session, resolves account and authorization, owns CSRF/cookie policy, revocation checks for sensitive actions, rate limits and audit actor. A valid JWT alone is not seller/admin/distributor authorization.
- **Database:** runtime roles are least privilege. If any schema is exposed through the Data API, enable RLS and revoke unnecessary grants; `service_role` stays server-side. Supabase explicitly warns that `user_metadata` is user-modifiable and unsuitable for authorization: <https://supabase.com/docs/guides/database/postgres/row-level-security>.

Auth migration requires account linking, verified-email/phone conflict handling, password-reset onboarding instead of password export, social redirect/deep-link registration, admin MFA enrollment, session revocation and a freeze-time identity crosswalk. Passwords/tokens are never exported from Base44.

## I. Storage/images

Recommendation: **Supabase Storage through the existing S3-compatible server adapter**. This is one canonical provider path while preserving portability. Supabase supports S3-compatible operations and SigV4 presigning, but not every S3 feature and specifically not object versioning: <https://supabase.com/docs/guides/storage/s3/compatibility>.

- Keep one private `deal-images` bucket. Draft objects are never public. Render validates JPEG/PNG/WebP signatures, 5 MiB repository limit, ownership, max image count, checksum and metadata before upload/commit.
- Serve published Mall/Deal images through the existing `/api/deal-images/:imageId` authorization/projection route with immutable cache keys. Draft previews use short-lived server-issued signed URLs.
- Store `image_id`, `deal_id`, owner seller, storage provider/bucket/key, MIME, size, SHA-256, order, primary flag, lifecycle status and created/deleted timestamps in `siton.deal_images`.
- Use content-addressed/non-guessable keys; never expose raw bucket credentials. Mobile camera/library uploads use the same API.
- Deletion is metadata tombstone + leased cleanup task; orphan reports and retry/DLQ already exist. Because database backups do not restore deleted Storage objects, schedule independent object inventory/backup/retention evidence. Supabase backup documentation makes that separation explicit: <https://supabase.com/docs/guides/platform/backups>.

Generic external S3 remains a portable future option, not a second active provider. Local filesystem storage is staging/dev only and blocks multi-instance production.

## J. Payments/Grow

Reuse `grow_payment_adapter.ts`, `payment_provider.ts`, webhook ingestion, payment attempts, reconciliation, platform fee ledger, outbox and refund/recovery logic. Runtime-only changes are Base URL, secret source, webhook URL, network policy and deployment observability. Grow was not called in R0.

Target flow:

```text
Client -> Render Web (intent/authentication) -> provider authorization/tokenization
Provider -> Render /webhooks/payments -> verified dedupe record + DB/outbox
Render Worker -> capture/release/refund/reconcile -> DB state+audit atomically
Client -> read canonical tracking state
```

Base44 function wrappers disappear; financial semantics do not. Provider idempotency keys are persisted before calls. Timeouts/ambiguous responses become `UNKNOWN` and reconciliation. Only verified provider evidence may yield `ChargedSuccess`/`RecoveredCharge`. Late events are recorded but terminal-safe. The 8% basis remains all collected customer value including shipping and excluding VAT; distributor calculations remain zero. No raw card data enters logs/DB; production provider callbacks terminate only at Render HTTPS.

## K. Notifications, invoices and payouts

| Domain | Existing assets | Class | Execution |
|---|---|---|---|
| Notifications/SMS | service, templates, provider interface, attempt/event tables | domain `REUSE_AS_IS`; provider/env `ADAPT` | Web enqueues; worker sends; external provider delivers |
| Invoices/Morning | invoice dispatcher, internal/adapter-ready/Morning provider, attempts/cases/webhooks | domain `REUSE_AS_IS`; callback URL/env `ADAPT` | worker issues/reconciles; Web verifies webhook |
| Payouts | payout rail/provider, batches/items/attempts/cases | `REUSE_WITH_ADAPTATION` | worker prepares/dispatches/reconciles; admin/seller read only |
| Refund/recovery | payment provider/reconciliation/outbox | `REUSE_AS_IS` domain | worker plus verified webhook/reconcile |
| Fulfillment | fulfillment units and delivery exports | `REUSE_WITH_ADAPTATION` | worker issues after canonical completion; seller redeems via Web |

No real send/issue/payout occurred. Provider modes must default fail-closed outside explicit staging/production configuration.

## L. Admin and operations

The repository already owns admin control plane, identity/RBAC/MFA, intervention, mission control, health/metrics, support, forensics, repair and operational cases. Keep:

- `GET /health` as cheap process liveness; no secrets and no dependency mutation.
- Add/normalize `GET /readiness` for DB schema, migration ledger, worker heartbeat age and configured critical providers. Return only safe status publicly; detailed reasons require operator auth.
- Keep `/api/admin/*` behind verified Supabase identity, DB-backed RBAC, MFA/step-up where required, rate limits, CSRF protection for cookies and atomic audit.
- Preserve no manual state override/no direct money actions. Admin interventions remain typed, preconditioned, idempotent and often dual-approved.
- Send structured logs to Render log streams and external retention; include request/correlation/deal/participant/outbox IDs but no secrets/PII. Alert on worker heartbeat, DLQ, stale leases, payment UNKNOWN age, webhook rejects and migration mismatch.
- `operational_repair` remains inspect/dry-run by default. Production apply needs explicit audited authorization and rollback evidence.

## M. Mobile

The 112 tracked Capacitor/Android/iOS/plugin artifacts are about 80% reusable by capability; platform projects, camera, browser, network, preferences, share, push and secure storage remain.

Required adaptation:

- Point `SITON_API_BASE_URL`/Capacitor config to the Render API; enforce HTTPS and production host allowlists.
- Replace Base44 token/redirect logic with Supabase PKCE/deep-link Auth for seller/admin/distributor. Store refresh/session material only in the native secure-storage plugin; keep buyer guest cookies/tokens scoped.
- Configure iOS universal links and Android app links for Auth callback, Deal/tracking deep links and browser-payment return.
- Keep camera/library -> Render image API -> Supabase Storage; never embed storage service credentials.
- Open hosted payment UI in the system browser/approved provider flow; validate return state but rely on webhook/reconciliation for money truth.
- Register push tokens server-side per verified identity/device with revoke/logout flows. Push remains optional until a provider is chosen and tested.
- Update CORS/cookie SameSite strategy for WebView/native origins; prefer Bearer JWT for authenticated native calls and one-time buyer tokens for guest recovery.

New device proofs are required for install/upgrade, offline/retry, token expiry/refresh, app-link hijack resistance, camera permissions, background/foreground payment return and push opt-in/out.

## N. Render Architecture V2

Minimum topology:

```text
Users / PWA / Capacitor
          |
          v
Render Web Service (Fastify + React assets)
          | HTTPS/JWT and PostgreSQL
          +----------------------+
          v                      v
Supabase Postgres/Auth      Supabase Storage
          ^
          |
Render Background Worker (continuous Postgres outbox)
```

- Two Docker-based services from today's root `Dockerfile`: Web and Background Worker. Docker minimizes local/host drift and preserves portability. Do not reuse `legacy/render/render.legacy.yaml`; write a new V2 blueprint only in a future authorized stage.
- Build image with locked install and `npm run build:demo`; commands are `npm run start:web:prod` and `npm run start:worker:prod`.
- Run `npm run db:migrate` once as a pre-deploy/release command, never concurrently in both services. Migrations are forward-compatible/expand-contract; destructive contracts wait until old code is gone.
- Web liveness `/health`; readiness `/readiness`. Bind `0.0.0.0:$PORT`.
- Git deploy only after CI and staging gates; pin exact commit/image digest. Web replacement can be zero-downtime only if health passes; worker safety relies on drain + lease fencing, not on a marketing guarantee.
- Co-locate Render and Supabase geographically where available. Prove network path/latency and connection budget.
- Persistent Web/Worker processes use direct Postgres when network support permits; otherwise Supavisor **session** pooling. Reserve direct connection for migrations/`pg_dump`. Transaction pooling is allowed only after a dedicated test proves no session/prepared-statement assumptions. Supabase connection guidance: <https://supabase.com/docs/guides/database/connecting-to-postgres>.
- Environment groups separate non-secret config from secrets. Web never receives payout/invoice credentials it does not need; frontend receives only public Supabase URL/publishable key. Worker and migration roles are distinct and least privilege.
- No Cron initially. Add one only after a bounded periodic task cannot be safely handled by the continuous scheduler; Render guarantees at most one active run of a cron job, but application idempotency is still mandatory: <https://render.com/docs/cronjobs>.

## O. Supabase target environments

Create nothing in R0. The future model is two physically isolated projects:

| Environment | Purpose | Schemas/buckets |
|---|---|---|
| `siton-staging` | migration rehearsal, Auth, worker, provider sandbox and destructive test data | `auth`, `siton`, `siton_inventory`, private Storage bucket |
| `siton-production` | live authority only after cutover gate | same layout with independent keys/users/backups |

Rules:

- Versioned migrations in this repository own `siton` and `siton_inventory`; Supabase owns `auth` internals. No dashboard-only schema mutation.
- Custom runtime, worker and migration DB roles; browser roles have no direct business/inventory privileges unless a later API use case has explicit grants+RLS tests. Never ship `service_role` or DB credentials.
- Separate Auth redirect allowlists, OAuth providers, SMTP/SMS, Storage buckets, secrets and provider webhooks per environment.
- Staging uses synthetic/provider sandbox only. Production data never seeds staging without approved minimization/anonymization.
- Production requires daily backup plus independently tested logical export; enable PITR based on RPO/RTO/business approval. Supabase states database backups exclude Storage objects, so object backup is separate.
- `siton-stage31`: option A now—remain proof-only. It may be retired after fresh staging reproduces inventory schema hashes, grants, triggers and the 7/7 proof. Do not rename/promote it.

The current Supabase changelog was reviewed on 2026-08-27; R1 must repeat review before provisioning, particularly current backup/credential behavior: <https://supabase.com/changelog>.

## P. Test migration map

Gate 1C passed 142/142 executable test files across 10/10 groups. Classification is by test intent; `UNCHANGED` permits environment fixture/URL changes but not weakened assertions.

- `OBSOLETE_AFTER_CUTOVER` (2): `base44_canonical_integrity_validation.ts`, `hosted_v11_activation_gate_validation.ts`.
- `ADAPT_BASE44_DEPENDENCY` (4): `base44_mall_contract_validation.ts`, `frontend_browser_v11_validation.ts`, `production_launch_readiness_validation.ts`, `supabase_inventory_activation_hardening_validation.ts`.
- `UNCHANGED` (136): every other executable top-level test in the Gate 1C inventory. This includes every state, DB, API, worker, payment, security, concurrency, failure, E2E, Mall, image, deal-type and mobile regression not named in the two lines above.
- `NEW_RENDER_TEST_REQUIRED` (new gate, not an existing-file reclassification): deploy health/readiness, commit parity, Web/Worker split, SIGTERM overlap, two-worker fencing, direct/session-pool connection exhaustion, zero-downtime schema compatibility, webhook URL/TLS, rollback image and 20,000-active-deal hosted load.
- `NEW_SUPABASE_AUTH_TEST_REQUIRED`: seller/admin/distributor linking and isolation, JWT issuer/audience/expiry/JWKS rotation, revoked user, AAL2 admin, user-metadata privilege forgery, guest buyer recovery, CSRF/cookie/native Bearer behavior and service-key absence.

Future release gate:

1. Fresh migrations + repeat/checksum/drift and DB privilege/RLS tests.
2. All 136 unchanged-intent tests and four adapted tests green; obsolete tests replaced, not simply deleted.
3. State/inventory/payment invariants: races, idempotency, `UNKNOWN`, retry storm, 8% including shipping/excluding VAT, distributor 0%, refunds, reconciliation, outbox/leases/audit, seller isolation, Draft privacy, Mall, three deal types and images.
4. Render hosted Web+Worker E2E and failure injection on exact commit.
5. Supabase Auth/storage and mobile device gates.
6. No raw 401/404/Axios/stack trace in UI; stable safe error envelopes.
7. Provider sandbox only in R9; controlled real-money proof only in R10 under separate authorization.

## Q. Data migration

Do not assume production is empty. A read-only count attempt could not run because the Base44 CLI `exec` path requires Deno; R0 did not install a runtime or bypass the boundary. Current counts are therefore `UNKNOWN_REQUIRES_PROOF`, except the dated observation `SellerAccount=1` on 2026-08-26 and the fact Gate 1C created no seller/deal/image. Neither proves current emptiness.

For every canonical entity in C:

1. Inventory both canonical and legacy names with count, min/max timestamps, non-PII stable-key cardinality and content hash. Categorize real/test/system without exposing values.
2. Freeze a schema/version manifest and export encrypted, access-controlled data. Never export passwords, access/refresh tokens, provider secrets, raw card data or OTP plaintext. PII documentation contains only category/count.
3. Build immutable ID crosswalks Base44 -> UUID/Auth identity. Transform normalized targets from C; preserve original IDs in restricted migration metadata for traceability.
4. Import parent-before-child into fresh staging, then production during a write freeze. For outbox/money/provider tables, reconcile every non-terminal row with provider evidence before worker enablement.
5. Validate row counts, stable-key uniqueness, state enum distribution, relationship/orphan checks, amount/fee totals, audit chains, pending work and per-entity hashes. Sample UI only after aggregate proof.
6. Export Storage objects separately and verify byte count, size, MIME and SHA-256 against `deal_images`.
7. Do not import expired OTP/session/idempotency records unless retention/audit requires them; preserve relevant security/audit evidence under policy.

No deletion is safe merely because a duplicate has zero apparent rows once; rerun counts immediately before cutover.

## R. No-split-brain cutover

| Phase | Sole authority | Activity | Go/No-Go |
|---|---|---|---|
| `BASE44_ACTIVE` | Base44 Deal/money; current Supabase inventory | R0/R1 preparation only | no target writes from users/providers |
| `NEW_STACK_SHADOW` | Base44 | sanitized/exported replay and read-only comparison; target outbound providers off | schema/hash/state/read parity |
| `NEW_STACK_STAGING` | fresh staging only for synthetic data | complete hosted E2E/mobile/provider sandbox | all gates P green |
| `NEW_STACK_PRODUCTION_FROZEN` | Base44, then explicit global write freeze | final export/backup/import; Render/worker still blocked; webhook queue controlled | zero unresolved deltas, provider plan acknowledged |
| `CUTOVER` | Render + new Supabase from one recorded instant | switch frontend/DNS/webhooks; enable one worker only after DB/health proof | smoke + money safety + monitoring |
| `BASE44_READ_ONLY_REFERENCE` | Render + Supabase | Base44 no writes; retained evidence/access only | stabilization window and reconciliation green |
| `BASE44_ARCHIVED` | Render + Supabase | revoke old callbacks/credentials; archive/delete only under retention approval | restore evidence and no consumers |

There is never a stage where Base44 owns Deal while Render owns money. Shadow receives no provider callback and performs no authoritative mutation. During production freeze, new joins/mutations are rejected with a friendly maintenance response, not buffered in two systems. Cutover gate requires exact commit/image, migration ledger, Auth crosswalk, complete data reconciliation, inventory 7/7 plus race tests, worker fencing, provider webhook acknowledgement, DNS/TLS, backup restore rehearsal, operator coverage and rollback decision timestamp.

## S. Financial-safe rollback

- Define a short owner-approved technical rollback window before cutover; keep Base44 read-only and preserve old DNS configuration. Take Base44 export, Supabase logical backup/PITR checkpoint and Storage inventory before the switch.
- App rollback uses the prior tested Render image/config and only backward-compatible migrations. DNS rollback is secondary because TTL/caches are not atomic.
- A kill switch stops new Web mutations and new worker claims; in-flight leased work drains or expires. Never kill blindly after an ambiguous provider call.
- Keep provider webhooks pointed at one authoritative endpoint. If Render is impaired, an authenticated capture service records raw verified events durably for later replay; do not send the same webhook to both stacks.
- After any new-production financial write, rollback is forward recovery: freeze, reconcile every attempt/webhook/provider reference, preserve new DB as authority for those transactions and either repair Render or perform an explicit reconciled reverse migration. Never pretend writes did not occur and never overwrite them with the pre-cutover backup.
- Rollback validation covers data written during the cutover interval, identity/account links, image objects, idempotency keys, pending outbox leases, DNS propagation and mobile clients pinned to an old base URL.

## T. Cost, scale and lock-in

No price is invented here; obtain current quotes/plan limits at R1/R8.

| Axis | Base44 current | Render + Supabase candidate |
|---|---|---|
| Function/background capacity | Current app is blocked at 69 functions vs documented 50 and worker approval | Dedicated continuous worker; capacity sized independently |
| DB/transactions | Entity runtime plus remote inventory bridge; split atomicity | Full Postgres, same-project `siton` + inventory transaction |
| Observability | Platform function/UI constraints | Process logs, DB metrics, heartbeats, explicit deploy SHA and custom alerts |
| Deployment | Convenient hosted app, but V1.1 frontend/backend can diverge | More explicit Web/Worker/migration coordination and on-call burden |
| Lock-in | High in functions, entities and Auth/runtime | Moderate managed-hosting lock-in; Postgres, Docker, S3 protocol and Fastify improve portability |
| Operations | Lower nominal burden, current support dependency high | Higher owned security, backup, Auth, scaling and incident responsibility |
| 20,000 active deals | Repo query proof exists but hosted Base44 behavior is blocked/unproven | Indexed query and Postgres locks are plausible; hosted connection/load/failure proof still mandatory |

At 20,000 simultaneously active deals, scale Web horizontally only after rate-limit/shared-state proof; pool connections centrally and cap per instance; scale worker lanes independently while money concurrency remains deliberately low; monitor lock wait, outbox age, database CPU/IO, connection saturation and Storage egress. A raw file-count or function-count claim is not a capacity proof.

## U. Weighted reuse score

Method: weights reflect business/risk value, not files. Each category allocates its full weight among dispositions.

| Category | Weight | Reuse | Adapt | Rewrite | Delete |
|---|---:|---:|---:|---:|---:|
| Constitution/business rules | 12 | 12 | 0 | 0 | 0 |
| State machines | 12 | 11 | 1 | 0 | 0 |
| Database | 14 | 10 | 4 | 0 | 0 |
| Backend | 13 | 8 | 4 | 0 | 1 |
| Worker | 10 | 8 | 1 | 0 | 1 |
| Payments | 9 | 8 | 1 | 0 | 0 |
| Frontend | 10 | 3 | 6 | 1 | 0 |
| Auth | 6 | 0 | 1 | 5 | 0 |
| Storage | 4 | 0 | 3 | 1 | 0 |
| Admin | 4 | 2 | 2 | 0 | 0 |
| Mobile | 3 | 1 | 2 | 0 | 0 |
| Tests | 2 | 1 | 1 | 0 | 0 |
| Deployment | 1 | 0 | 0 | 1 | 0 |
| **Total** | **100** | **64%** | **26%** | **8%** | **2%** |

Thus 90% of weighted product value survives as-is or by adaptation. This is a substantial infrastructure/identity migration, not a product rewrite and not a toggle.

## V. Decision

**`RECOMMEND_MIGRATE_TO_RENDER_SUPABASE`**.

Repository reality supports the decision: the target-native backend, DB, worker, payment, operations and tests already exist; Base44 is currently blocking the exact worker and five hosted V1.1 endpoints; the function/entity duplication complicates further growth; and the current inventory boundary prevents single-transaction lifecycle atomicity. The migration is justified only as R1–R10 with Base44 remaining sole authority until cutover. Unknown live row counts and Auth migration are explicit gates, not reasons to keep a structurally blocked runtime indefinitely.

## W. Implementation roadmap — do not start in R0

Percentages are migration implementation progress, not product completeness.

| Stage | Goal / files | Authorized writes | Tests / external actions | Stop condition / rollback | Status after stage |
|---|---|---|---|---|---:|
| R1 Fresh Supabase staging | add reviewed environment/bootstrap docs and inventory provisioning source; no product behavior | create `siton-staging`; schemas/roles only | migration dry run, changelog/region/backup/auth/storage decisions | stop if complete inventory SQL or live export evidence missing; delete only empty new staging if approved | 10% |
| R2 Canonical Postgres | adapt migrations/Auth bindings; internal inventory repository parity | staging schema/test data | 45+ migrations, repeat/checksum, privileges/RLS, 7/7 inventory, races, cross-schema atomicity | revert fresh staging or forward-fix migration; no production | 22% |
| R3 Fastify Web runtime | normalize `/api`, typed compatibility adapter, readiness | staging deploy/config only | all backend/API/security tests; hosted safe errors | roll back image; Base44 remains active | 34% |
| R4 Render Worker | deploy fenced continuous worker with providers disabled/synthetic | staging outbox only | two-worker, SIGTERM, lease loss, reclaim, DLQ, UNKNOWN/idempotency | kill claims, drain/reclaim, roll back worker image | 44% |
| R5 Supabase Auth | Auth client/server verification and identity mappings | staging Auth users/test mappings | seller/admin/distributor isolation, MFA, guest buyer, JWKS rotation/revocation | revert clients/image; discard test users | 56% |
| R6 React API migration | copy/version actual React source into repo; replace adapter call sites gradually | code + staging | every route/page, RTL/mobile widths, no raw errors; 142-map gate | adapter allows page-by-page rollback; no dual business code | 68% |
| R7 Storage/images | Supabase S3 config, metadata/import tools, cleanup | staging objects/test metadata | signature/size/IDOR/signed URL/cache/delete/orphan/mobile camera | restore metadata/object snapshot; keep Base44 images untouched | 76% |
| R8 Full hosted E2E/mobile | exact staging stack, load/backup/restore/observability | synthetic staging only | full gate, 20k/load/pool, Android/iOS device, failure/rollback rehearsal | no-go until zero P0/P1 and restore passes | 86% |
| R9 Grow Sandbox | configure provider sandbox only | sandbox auth/capture/refund/invoice/message test records | webhook/UNKNOWN/reconcile/retry/refund/8% proofs | disable provider and reconcile all attempts | 93% |
| R10 Controlled real-money proof | fresh production, final export rehearsal and separately authorized minimal proof | production infrastructure/data and tightly scoped money only under new owner authorization | end-to-end financial reconciliation, receipts/refund if planned, monitoring/on-call | financial-safe forward recovery; no cutover on discrepancy | 98% |
| CUTOVER | no-split-brain freeze/import/switch/stabilize/archive | final production writes only under explicit cutover authorization | R/S gates and complete reconciliation | freeze/forward-recover; never restore over financial truth | 100% |

R1 exact first task is evidence and fresh staging foundation: capture the complete `siton_inventory` provisioning definition from the verified proof project without secrets/data; create an owner-approved fresh `siton-staging` in the chosen region; commit versioned schema/role/grant migrations; replay all 45 `siton` migrations plus inventory; and prove checksums, permissions, append-only audits, RPC contract and 7/7 concurrency behavior. It does **not** deploy Render, migrate production data, enable Auth users/providers or call Grow.

## R0 safety/evidence ledger

- Read-only: Git fetch/status/refs, repository scans, Base44 identity/link/function inventory, remote sandbox source reads, official documentation review.
- Base44 writes/deploys/publish: 0. Supabase writes: 0. Render actions: 0. Grow/payment/refund: 0. Messages/invoices/payouts: 0. Production data exports: 0.
- Remote Base44 count proof is incomplete because CLI record enumeration required Deno. No runtime was installed and no alternate privileged path was invented.
- Only this document and `PROJECT_STATUS.md` are allowed R0 changes.
