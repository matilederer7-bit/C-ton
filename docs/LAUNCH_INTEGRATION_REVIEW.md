# Launch integration candidate — independent review, 2026-09-09

The candidate combines the approved UX work, dry-run transactional communications, and the seller-facing KYC rejection field. It is a code candidate only: no merge, deployment, hosted database change, payment activation or real notification provider activation.

## Verified sources and integration

| Field | Verified value |
|---|---|
| BASE_MASTER_SHA | `d4c7877f9b704734036d69f57f7d98f794f4d034` |
| UX_SOURCE_SHA_VERIFIED | `682b93cab99d53954faafbb169ca50c637e9db6a` |
| COMMUNICATIONS_SOURCE_SHA_VERIFIED | `996ba6615159e87085ac6e9e12afc7b81d1be294` |
| FINAL_BRANCH | `codex/launch-integration-candidate` |
| Source discrepancies | None; both merge bases equal the verified master |
| UX commits | `682b93c` |
| Communications commits | `b0ab138`, `cc84f1d`, `996ba66` |

A fresh worktree was created under `.worktrees/launch-integration-candidate`. The original checkout and its two unrelated untracked files were left alone. Neither Claude source branch, the war-game review branch nor master was modified. The source commits were cherry-picked, not copied over newer files.

The overlapping files are `PROJECT_STATUS.md`, `src/app.ts`, and `src/frontend_runtime.ts`. Only the status document conflicted textually; both historical entries were retained. Semantic review covered the shared Join response/transaction, legal and admin routes, seller inquiry transaction, and operator notification read models. Source-reported test results were treated as historical claims, not candidate evidence.

## Review corrections

1. **Notification failures outside savepoints:** target/outcome fan-out read the deal header and participant list before entering a savepoint; fulfillment notification eligibility did likewise. These reads now run inside an outer notification savepoint. The inquiry notification call is also savepoint-protected inside the message transaction. Real PostgreSQL division-by-zero injections and an inquiry notification INSERT trigger prove recovery, not merely JavaScript catch behavior.
2. **Grant 023:** reduced seller profile SELECT to `seller_id, contact_email`. Added SELECT on the six columns returned by tracking-token INSERT, with a SELECT policy. Token hashes remain unreadable; token UPDATE/DELETE and bank-account access remain forbidden. PostgreSQL requires SELECT privileges for columns used in RETURNING ([INSERT documentation](https://www.postgresql.org/docs/18/sql-insert.html)). A disposable local role tested the SQL inside a rolled-back transaction.
3. **KYC UI:** both pending-seller queue and seller profile now offer separate optional seller-facing reason and internal admin note fields. Only `seller_reason` reaches the existing `seller_kyc_rejected` payload. The existing decision audit records the reason and actor; the account retains the internal note. No new event type.
4. **Quantity submission:** an invalid/empty quantity previously left the parent's last accepted value available for checkout. Checkout now checks field validity, including the shared sticky-button action. Existing preview protection assertions were updated to require the stronger guard.
5. **History restoration:** desktop browser proof found a late 62px layout shift after restoration. Nonzero restores now hold the saved position through the bounded render budget; wheel/touch/pointer/scroll-key input explicitly returns control to the user. A regression test distinguishes layout anchoring from user input.
6. **Communications rehearsal:** rejects non-PostgreSQL schemes, hosted hosts and connection query overrides before connecting. Child processes inherit a local-socket-only preload; negative controls cover remote URLs, URL query authority overrides and external sockets. Both direct and normalized socket argument forms are handled. Kept database output omits connection credentials. Notification failure reasons are redacted before persistence.

## UX disposition

| Requested item | Result |
|---|---|
| Google Maps + Waze | Integrated; same stored coordinates, or explicitly labelled address search |
| Horizontal overflow | No page overflow on the 73 measured page/form checks |
| Buyer viral-tree privacy | Buyer share identity and share loop retained; generations/descendants/tree removed from buyer surface; backstage retained |
| Legal pages | Native `#/legal/terms`, `#/legal/privacy`, `#/legal/refunds`; one server content source |
| Back/Forward | Per-history-entry restoration; late layout-shift fix independently proved |
| Admin buyer search | Displayed name/phone/email intent and match reason; no hidden-email name hits |
| Virality copy | `ויראליות` |
| Analytics periods | Default 7, 30, 90, custom Israel-local calendar dates, all; lifetime separate |
| Quantity inputs | Typed digits, mobile numeric keyboard, no spinner; invalid value blocks checkout |

No approved UX item was rejected. Quantity validation and scroll restoration were strengthened. Windowed charged metrics are current charge outcomes for the join/attribution cohort selected by creation time, not a ledger of charges executed during that window. Seller virality remains explicitly labelled lifetime. The 7-day deal runtime cap is unchanged.

## Required event coverage

| Event | Canonical trigger / recipient |
|---|---|
| buyer_joined_authorized | Join transaction; participant's own contact; existing Join token reused |
| buyer_deal_target_reached | Threshold transition; eligible participants of that deal |
| buyer_deal_completed | Completed deal transition; charged/recovered participant classification |
| buyer_deal_failed | Failed/deadline transition, or unsuccessful participant on completed deal |
| buyer_recovery_required | ChargeFailedRecovery money transition |
| buyer_payment_recovered | RecoveredCharge money transition; ordinary capture alias removed |
| buyer_voucher_issued | Voucher issuance transaction; tracking link, no voucher code |
| buyer_ticket_issued | Ticket issuance transaction; tracking link, no ticket code |
| seller_deal_published | Publish transaction; deal owner's canonical contact |
| seller_target_reached | Threshold transition; deal owner |
| seller_deal_completed | Completed transition; deal owner; no seller_excel_ready enqueue |
| seller_deal_failed | Failed/deadline transition; deal owner |
| seller_customer_inquiry | Canonical customer inquiry transaction; deal owner, ignoring spoofed seller |
| seller_kyc_approved | Changed approved status, decision ordinal and audit |
| seller_kyc_rejected | Changed rejected status, decision ordinal and audit; explicit public reason only |
| admin_security_alert | Durable webhook-security fact / PaymentMismatch case; configured admin email only, otherwise internal |

COMMUNICATION_EVENTS_REQUIRED=16; COMMUNICATION_EVENTS_CORRECTLY_WIRED=16.

Buyer resolution uses `participants.buyer_phone`, then the legacy buyer identity (invalid SMS destinations are blocked); seller resolution uses that seller's support/login/business contact; missing contacts use internal recording. Keys derive from event, business identity, recipient class and channel; a unique database key collapses duplicate intended rows. KYC ordinals are serialized by the seller lock. Refund no longer emits a second deal-failed notification. Admin destinations are never supplied by a request.

## Transaction and worker limits

Notifications commit or roll back with their owning business transaction. Recoverable notification SQL/validation/recipient/token failures roll back to savepoints and cannot poison that transaction. Token mint failure degrades to an explicitly recorded tokenless tracking link. Loss of the database connection itself cannot be made commit-safe by a savepoint and is not claimed to be handled as a notification-only error.

Claiming uses SKIP LOCKED. Retry, temporary/permanent failures, crash reclaim and attempt exhaustion were exercised. There is one intended notification row, not a promise of exactly-once external delivery: a future real provider needs idempotent delivery and stronger stale-worker fencing before activation. No real adapter exists; real mode fails closed.

**Pre-existing finalization limit:** the deal Completed/Failed transaction precedes separate participant-finalization, receipt and fulfillment work. A crash after the deal commit can leave that later work incomplete, and the existing terminal-state early return does not replay it. The candidate does not claim that all these steps share one transaction. It keeps financial architecture unchanged and records this as an operational/real-money blocker. Deal-outcome notifications share the deal transaction; they classify participants from then-current committed charge/buyer state. Fulfillment notifications share the actual issuance transaction.

**Best-effort enqueue limit:** savepoint-isolated notification failure can leave committed business truth without an intended notification row. It is logged, not automatically repaired by a separate durable enqueue-repair queue. This preserves business atomicity as requested; it is not a guaranteed eventual-delivery claim.

## Candidate validation

Local Node 24.13.1 / PostgreSQL 18 / headless Edge. CI uses Node 22 / PostgreSQL 16, so remote CI remains an additional environment check.

| Group | Final file results |
|---|---:|
| unit | 16/16 |
| integration | 30/30 |
| db | 8/8 |
| api | 46/46 |
| workers | 16/16 |
| payments | 29/29 |
| security | 39/39 |
| concurrency | 7/7 |
| failure | 9/9 |
| e2e | 13/13 |
| Total | 213/213 |

The full run completed all ten groups. Its initial inventory printed 212; the added grant test was discovered by the workers child, bringing executed files to 213. Four initial failures were resolved and rerun: two source assertions expected the prior quantity guard; admin-launch and demo-preview tests expected their normal log/dev defaults, not the forced dry-run test environment. Those defaults perform no external delivery. Three affected frontend suites and the admin test passed in the targeted four-file rerun; demo-preview passed separately. This is final coverage after reruns, not a claim that the first full run was green.

Branch suites ran within the combined suite. Communications rehearsal: **19/19 event/transaction checks + 12/12 worker/safety checks**; 65 dry-run successes, five deliberately blocked rows, two deliberately failed rows; zero real-mode attempts. Local network guards recorded zero external connections and zero blocked attempts during the successful rehearsal. Unsafe-target and socket negative controls passed separately.

Browser: **82/82 checks, 73 page/form measurements at 390/430/1280**, zero horizontal overflow, zero console errors, zero failed essential requests. Legal, buyer privacy/share, quantities, maps, search, period filters, Back/Forward and both KYC rejection entry points covered. Exact scroll examples: 1200→1200 and 900→900; legal Forward 700→700. Native Google Maps/Waze app hand-off is not proved by browser automation.

TypeScript test/demo/web builds and server `--noEmit`, lint/backend enforcement, payment scan, runtime-DDL scan, architecture gate, canonical integrity gate, mobile bundle/readiness gate and whitespace checks passed. Route inventory: 198 routes, 118 protected, zero unguarded; behavioral authorization gate: four suites passed. All 58 existing migrations ran on disposable databases; no migration added. Web build retains a bundle-size warning.

Local detailed evidence: `.tmp_full_suite.log`, `.tmp_corrected_regressions.log`, `.tmp_demo_regression.log`, `.tmp_communications_final.log`, `.tmp_rehearsal_negative.log`, `.tmp_route_auth.log`, `.tmp_static_final.log`, and `.ci-artifacts/launch-integration-browser/results.json` plus screenshots. These generated artifacts are ignored, not shipped.

## Safety, readiness and next step

| Field | Result |
|---|---|
| KYC_REJECTION_REASON_UI | CLOSED; queue + profile, six browser flows |
| CROSS_SELLER_LEAK | 0 observed; canonical ownership checks retained |
| DUPLICATE_INTENDED_NOTIFICATION | 0 observed in replay/retry/reclaim proofs |
| TRANSACTIONAL_NOTIFICATION_ATOMICITY | PASS for owning transactions, subject to explicit finalization/repair limits above |
| NOTIFICATION_FAILURE_CAN_ABORT_BUSINESS_TRUTH | NO for recoverable notification failures covered by savepoints |
| GRANT_023_REVIEWED | YES; corrected |
| GRANT_023_SAFE_TO_APPLY | YES, through the existing privileged staging procedure after prerequisite grants/migrations |
| GRANT_023_APPLIED | NO on staging/hosted; disposable local test transaction rolled back |
| REAL_EMAIL_SENT / REAL_SMS_SENT | 0 / 0 |
| REAL_EXTERNAL_NETWORK_DELIVERY | 0 |
| SITON_FEE | Exactly 8% of authoritative gross charge base, including delivery, excluding authoritative buyer VAT |
| DISTRIBUTOR_COMMISSION / DISTRIBUTOR_PAYOUT | 0 / 0; attribution only |
| MIGRATIONS_ADDED | 0; 066/067 excluded |
| HOSTED_DB_CHANGED / GROW_CHANGED | NO / NO |
| PAYMENT_CODE_CHANGED | Notification hooks in existing payment handlers changed; provider adapters, financial state engine, fee/VAT rules and money migrations unchanged |
| PROJECT_STATUS_UPDATED | YES |
| SAFE_TO_MERGE_CODE | YES for this dry-run code scope; not activation/deployment approval |
| CLOSED_WEB_PILOT_READINESS | Local code/browser evidence complete; hosted grant, deploy, hosted dry-run acceptance and finalization contingency remain open |
| REAL_MONEY_READINESS | 0%; no activation, no new financial proof claim |

Scoped completion: UX 9/9 (100%), required event wiring 16/16 (100%), KYC UI 1/1 (100%). Real email/SMS **activation is 0%**: no verified adapter, configured provider, sender/domain proof or provider sandbox proof. Do not reinterpret complete local code tests as real-provider readiness or raise a whole-project readiness percentage.

Next step: review this candidate and remote CI; separately authorize merge/deployment and the reviewed grant through the established staging procedure, then conduct hosted dry-run owner acceptance. Resolve the finalization/replay limitation before unattended or real-money operation. Keep all payment and notification provider activation off.
